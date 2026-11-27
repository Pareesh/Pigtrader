import CONFIG from "./config.js";
import { getFunds, getHoldings, getOrders, getPositions } from "../service/upstox.js";
import { fetchHistoricalCandles, fetchHistoricalIntradayCandles, fetchIntradayCandles } from "../service/candles.js";
import { calcDeliveryRoundTripCharges, calcIntradayRoundTripCharges } from "./charges.js";
import {
    calculateADX,
    calculateATR,
    calculateDatedCorrelation,
    calculateEMA,
    calculateRSI,
    calculateSMA,
    calculateSessionVWAP,
    resampleCandles
} from "./indicators.js";
import { executeOrders, reviewOrderBook } from "./executor.js";
import { clamp, getISTTime, roundToTick, sum } from "./utils.js";
import getNifty200 from "../service/nifty200.js";

/*
 * STRATEGY OVERVIEW
 *
 * DELIVERY (D): trend-following swing positions in Nifty 200 leaders.
 *   Universe : stocks in an uptrend (price > 50-EMA > 200-EMA, above weekly 10-EMA) ranked by 3M/6M
 *              momentum relative to Nifty, within 15% of the 52-week high.
 *   Entry    : pullback to the 20-EMA or a volume breakout, RSI 42-68, not extended, and confirmed
 *              live (above session VWAP and today's open, no big gap-up).
 *   Exit     : ATR stop -> breakeven lock -> chandelier trail; trend break; one climax trim;
 *              concentration trim. No small daily profit harvests (fixed fees make them expensive).
 *
 * INTRADAY (I): opening-range breakouts and VWAP pullbacks on completed 5-minute bars.
 *   Direction: Nifty intraday bias plus the stock's relative strength vs Nifty.
 *   Filters  : cumulative relative volume, EMA9/21 trend, overhead PDH/PDL guard, and a volatility
 *              floor so the 5-minute ATR stop is wide enough to pay for ~0.27% round-trip fees.
 *   Exits    : broker SL placed once the position exists, breakeven at 1R, trail at 1.5R,
 *              target at 2.2R, time stop, 15:05 square-off.
 */

const D = CONFIG.DELIVERY;
const I = CONFIG.INTRADAY;
const NIFTY = "NSE_INDEX|Nifty 50";
const VIX = "NSE_INDEX|India VIX";

// In-memory state: lost on restart, and every consumer has a safe fallback.
const state = {
    day: null,
    running: false,          // Guards against the scheduler and a manual /execute overlapping
    plans: new Map(),        // instrument -> intraday { entry, risk, stop, target, best, openedAt } (reset daily)
    peaks: new Map(),        // instrument -> highest price seen while held (drives trailing stops)
    trimmed: new Set()       // instruments that already had their one climax trim
};

// ============================================================================
// 1. HELPERS
// ============================================================================
const dayOf = (c) => String(c.ts).slice(0, 10);
const timeOf = (c) => String(c.ts).slice(11, 16);
const round2 = (n) => Number(n.toFixed(2));
const newPlan = () => ({ cancelOrderIds: [], exitOrders: [], entryOrders: [], protectiveStopOrders: [] });

let orderSeq = 0;
const nextId = (prefix) => `${prefix}${++orderSeq}`;

async function mapWithConcurrency(items, concurrency, mapper) {
    let index = 0;
    const worker = async () => {
        while (index < items.length) {
            const i = index++;
            await mapper(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

// Weekly candles (Monday-based) from daily candles.
function buildWeeklyCandles(daily) {
    const weeks = new Map();
    for (const c of daily) {
        const d = new Date(`${dayOf(c)}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
        const key = d.toISOString().slice(0, 10);
        const w = weeks.get(key);
        if (!w) {
            weeks.set(key, { date: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
        } else {
            w.high = Math.max(w.high, c.high);
            w.low = Math.min(w.low, c.low);
            w.close = c.close;
            w.volume += c.volume;
        }
    }
    return [...weeks.values()];
}

// 3M and 6M return, skipping the most recent week (avoids short-term reversal noise).
const momentum = (closes) =>
    closes.length < 127 ? 0 : 0.5 * (closes.at(-6) / closes.at(-69) - 1) + 0.5 * (closes.at(-6) / closes.at(-127) - 1);

function positionQty(rawQty, price, budget, limits) {
    if (!(price > 0) || !(budget > 0) || !(rawQty > 0)) {
        return 0;
    }
    const qty = Math.min(Math.floor(rawQty), Math.floor(Math.min(budget, limits.MAX_ORDER_VALUE) / price));
    return qty >= limits.MIN_SHARES && qty * price >= limits.MIN_ORDER_VALUE ? qty : 0;
}

function buildOrder({ id, key, product, side, qty, type = "LIMIT", price = 0, trigger = 0, tag, meta }) {
    return {
        correlation_id: id,
        quantity: qty,
        product,
        validity: "DAY",
        price: roundToTick(price),
        trigger_price: roundToTick(trigger),
        order_type: type,
        transaction_type: side,
        instrument_token: key,
        disclosed_quantity: 0,
        tag,
        _meta: meta
    };
}

// Marketable LIMIT exit: priced through the market by `buffer` so it fills, without being a MARKET order.
function exitOrder(plan, { key, product, isLong, qty, ltp, buffer, tag = "pigtrader_exit", prefix, meta }) {
    plan.exitOrders.push(buildOrder({
        id: nextId(prefix),
        key,
        product,
        side: isLong ? "SELL" : "BUY",
        qty,
        price: ltp * (isLong ? 1 - buffer : 1 + buffer),
        tag,
        meta
    }));
}

// Queue cancellation of every broker stop on an instrument and forget it locally. Returns the cancelled ids.
function cancelStops(plan, book, product, key) {
    const k = `${product}:${key}`;
    const ids = (book.stops.get(k) || []).map((s) => s.orderId);
    plan.cancelOrderIds.push(...ids);
    book.stops.delete(k);
    return ids;
}

// Make sure exactly one broker SL covers the position at `trigger`; replace it only if clearly tighter or resized.
function syncStop(plan, book, { key, product, isLong, qty, trigger, ltp, symbol }) {
    const stop = roundToTick(trigger);
    if (qty <= 0 || (isLong ? stop >= ltp : stop <= ltp)) {
        return; // Already breached: the software exit handles it.
    }

    const existing = book.stops.get(`${product}:${key}`) || [];
    if (existing.length === 1 && existing[0].quantity === qty) {
        const tighter = isLong ? stop - existing[0].trigger : existing[0].trigger - stop;
        if (tighter < ltp * CONFIG.STOP_REPLACE_PCT) {
            return;
        }
    }

    const afterCancel = cancelStops(plan, book, product, key);
    plan.protectiveStopOrders.push(buildOrder({
        id: nextId("sl"),
        key,
        product,
        side: isLong ? "SELL" : "BUY",
        qty,
        type: "SL",
        price: stop * (isLong ? 1 - CONFIG.SL_LIMIT_BUFFER : 1 + CONFIG.SL_LIMIT_BUFFER),
        trigger: stop,
        tag: "pigtrader_sl",
        meta: { symbol, stopLoss: stop, afterCancel }
    }));
}

// ============================================================================
// 2. MARKET REGIME (NIFTY 50 + INDIA VIX)
// ============================================================================
async function getMacro(today, nowMs) {
    const [daily, niftyToday, vixDaily, vixToday] = await Promise.all([
        fetchHistoricalCandles(NIFTY, CONFIG.CANDLE_LOOKBACK_DAYS),
        fetchIntradayCandles(NIFTY),
        fetchHistoricalCandles(VIX, 60),
        fetchIntradayCandles(VIX)
    ]);

    const done = daily.filter((c) => dayOf(c) < today);
    const closes = done.map((c) => c.close);
    const prevClose = closes.at(-1) ?? 0;
    const bars = niftyToday.filter((c) => dayOf(c) === today);
    const lastBar = bars.at(-1);
    const price = lastBar?.close ?? prevClose;

    const vixCloses = vixDaily.filter((c) => dayOf(c) < today).map((c) => c.close);
    const vix = vixToday.filter((c) => dayOf(c) === today).at(-1)?.close ?? vixCloses.at(-1) ?? 0;
    const vixAvg = calculateSMA(vixCloses, 10) || vix;
    const vixSpiking = vix > vixAvg * 1.15;

    const ema20 = calculateEMA(closes, 20) ?? price;
    const ema50 = calculateEMA(closes, 50) ?? price;
    const ema200 = calculateEMA(closes, 200) ?? price;
    const weeklyUp = price > (calculateEMA(buildWeeklyCandles(done).map((w) => w.close), 10) ?? price);

    const dailyOk = closes.length >= 200 && prevClose > 0 && vix > 0 &&
        nowMs - new Date(done.at(-1).ts).getTime() <= 7 * 86400000;
    const liveOk = !!lastBar && nowMs - new Date(lastBar.ts).getTime() <= 15 * 60000;

    let vixRegime = "NORMAL";
    let sizeScale = 1;
    if (vix >= 24) {
        vixRegime = "EXTREME_PANIC";
        sizeScale = 0;
    } else if (vix >= 18 || vixSpiking) {
        vixRegime = "ELEVATED_FEAR";
        sizeScale = 0.65;
    } else if (vix < 13) {
        vixRegime = "LOW_VOLATILITY";
    }
    if (!dailyOk) {
        sizeScale = 0;
    }

    // Intraday direction from Nifty's own day: return vs yesterday and position vs today's open.
    const dayRet = prevClose > 0 ? price / prevClose - 1 : 0;
    const aboveOpen = bars.length ? price >= bars[0].open : true;
    const bias = dayRet >= 0.001 && aboveOpen ? "LONG" : dayRet <= -0.001 && !aboveOpen ? "SHORT" : "NEUTRAL";

    return {
        price: round2(price),
        isBullish: price > ema20 && price > ema50,
        weeklyUp,
        dayRet,
        bias,
        momentum: momentum(closes),
        vix: round2(vix),
        vixRegime,
        sizeScale,
        dailyOk,
        liveOk,
        allowDelivery: dailyOk && liveOk && sizeScale > 0 && price > ema200 && weeklyUp,
        allowIntraday: dailyOk && liveOk && sizeScale > 0
    };
}

// ============================================================================
// 3. DELIVERY: STOCK ANALYSIS (COMPLETED DAILY CANDLES ONLY)
// ============================================================================
function analyzeStock(candles, today, macro) {
    const done = candles.filter((c) => dayOf(c) < today);
    if (done.length < 160) {
        return null;
    }

    const closes = done.map((c) => c.close);
    const highs = done.map((c) => c.high);
    const last = closes.at(-1);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const ema200 = calculateEMA(closes, 200) ?? ema50;
    const weeklyEma10 = calculateEMA(buildWeeklyCandles(done).map((w) => w.close), 10) ?? ema50;
    const atr = calculateATR(done, 14);
    if (!(atr > 0)) {
        return null;
    }
    const rsi = calculateRSI(closes, 14);
    const adx = calculateADX(done, 14);

    const avgVol = sum(done.slice(-21, -1).map((c) => c.volume)) / 20;
    const volRatio = avgVol > 0 ? done.at(-1).volume / avgVol : 1;
    const extension = (last - ema20) / atr;

    const trendOk = last > ema50 && ema50 > ema200 && last > weeklyEma10 && adx >= D.MIN_ADX;
    const pullback = Math.min(...done.slice(-3).map((c) => c.low)) <= ema20 + 0.5 * atr && last > ema20;
    const breakout = last > Math.max(...highs.slice(-21, -1)) && volRatio >= 1.2;
    const setup = pullback ? "PULLBACK" : breakout ? "BREAKOUT" : null;

    const entryOk = trendOk && setup !== null &&
        rsi >= D.MIN_RSI && rsi <= D.MAX_RSI &&
        extension <= D.MAX_EXTENSION_ATR &&
        last >= Math.max(...highs.slice(-252)) * D.NEAR_52W_HIGH;

    const tail = done.slice(-81);
    const turnover = sum(done.slice(-20).map((c) => c.close * c.volume)) / 20;

    return {
        last,
        ema20,
        ema50,
        weeklyEma10,
        atr,
        rsi: round2(rsi),
        adx: round2(adx),
        volRatio: round2(volRatio),
        setup,
        entryOk,
        turnover,
        alpha: momentum(closes) - macro.momentum,
        returns: tail.slice(1).map((c, i) => ({ date: dayOf(c), value: c.close / tail[i].close - 1 }))
    };
}

async function buildMetrics(universe, macro, today) {
    const metrics = new Map();

    await mapWithConcurrency([...universe.keys()], CONFIG.API_CONCURRENT_LIMIT, async (key) => {
        const m = analyzeStock(await fetchHistoricalCandles(key, CONFIG.CANDLE_LOOKBACK_DAYS), today, macro);
        if (m) {
            metrics.set(key, m);
        }
    });

    // Cross-sectional relative-strength percentile: robust to the market's overall level.
    const alphas = [...metrics.values()].map((m) => m.alpha).sort((a, b) => a - b);
    for (const m of metrics.values()) {
        m.rsPct = round2((100 * alphas.filter((a) => a < m.alpha).length) / Math.max(1, alphas.length - 1));
        m.score = Math.round(0.6 * m.rsPct + 0.25 * (Math.min(m.adx, 40) / 40) * 100 + 0.15 * (Math.min(m.volRatio, 2) / 2) * 100);
        m.entryOk = m.entryOk && m.rsPct >= D.MIN_RS_PERCENTILE;
    }

    return metrics;
}

// ============================================================================
// 4. PORTFOLIO LOADERS
// ============================================================================
async function fetchPortfolio(accessToken, warnings) {
    const labels = ["Holdings", "Positions", "Funds", "Orders"];
    const results = await Promise.allSettled([
        getHoldings(accessToken),
        getPositions(accessToken),
        getFunds(accessToken),
        getOrders(accessToken)
    ]);
    results.forEach((r, i) => {
        if (r.status === "rejected") warnings.push(`${labels[i]} unavailable: ${r.reason?.message ?? r.reason}`);
    });

    const [holdings, positions, funds, orders] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    const complete = Array.isArray(holdings) && Array.isArray(positions) && Array.isArray(orders) &&
        funds !== null && typeof funds === "object" && !Array.isArray(funds);

    const cash = [
        funds?.equity?.available_margin,
        funds?.equity?.available_cash,
        funds?.equity?.available_balance,
        funds?.available_to_trade?.total,
        funds?.available_margin
    ].map(Number).find((n) => Number.isFinite(n) && n > 0) ?? 0;

    return { complete, holdings: holdings ?? [], positions: positions ?? [], orders: orders ?? [], cash };
}

// Merge long-term holdings with today's delivery positions (new buys / sells not yet in holdings).
function consolidateDelivery(holdings, positions) {
    const map = new Map();

    for (const h of holdings) {
        if (h.quantity > 0) {
            map.set(h.instrument_token, {
                symbol: h.trading_symbol,
                instrumentKey: h.instrument_token,
                quantity: h.quantity,
                avgPrice: h.average_price,
                lastPrice: h.last_price || h.average_price
            });
        }
    }

    for (const p of positions) {
        if (p.product !== "D" || !p.quantity) {
            continue;
        }

        const held = map.get(p.instrument_token);
        if (p.quantity < 0) {
            if (held) {
                held.quantity += p.quantity;
                if (held.quantity <= 0) map.delete(p.instrument_token);
            }
        } else if (held) {
            held.avgPrice = (held.avgPrice * held.quantity + p.average_price * p.quantity) / (held.quantity + p.quantity);
            held.quantity += p.quantity;
            held.lastPrice = p.last_price || held.lastPrice;
        } else {
            map.set(p.instrument_token, {
                symbol: p.trading_symbol,
                instrumentKey: p.instrument_token,
                quantity: p.quantity,
                avgPrice: p.average_price,
                lastPrice: p.last_price || p.average_price
            });
        }
    }

    return map;
}

// ============================================================================
// 5. DELIVERY PLANNING
// ============================================================================
function deliveryStop(held, m, peak, feePerShare) {
    const avg = held.avgPrice;
    const stopPct = clamp((D.ATR_STOP_MULT * m.atr) / avg, D.MIN_STOP_PCT, D.MAX_STOP_PCT);

    let stop = avg * (1 - stopPct);
    if (peak >= avg * (1 + D.BREAKEVEN_ARM_PCT)) {
        stop = Math.max(stop, avg + feePerShare * 1.15);
    }
    if (peak >= avg * (1 + D.TRAIL_ARM_PCT)) {
        stop = Math.max(stop, peak - D.ATR_STOP_MULT * m.atr);
    }
    return stop;
}

const isSplitSuspect = (m, price) => price / m.last - 1 <= D.SPLIT_GAP_GUARD_PCT;

function liveSession(candles1m, today, nowMs) {
    const bars = candles1m.filter((c) => dayOf(c) === today);
    const last = bars.at(-1);
    if (!last || nowMs - new Date(last.ts).getTime() > 10 * 60000) {
        return null;
    }
    return { price: last.close, open: bars[0].open, vwap: calculateSessionVWAP(bars) };
}

async function planDelivery(ctx, plan) {
    const { deliveryMap, universe, metrics, macro, book, clock, totalValue, positions, nifty200, today, nowMs, warnings, live } = ctx;
    const sectorValue = {};
    const keptReturns = [];
    let kept = 0;
    let coverageGap = false;
    const addSector = (sector, value) => { sectorValue[sector] = (sectorValue[sector] || 0) + value; };

    for (const key of state.peaks.keys()) if (!deliveryMap.has(key)) state.peaks.delete(key);
    for (const key of state.trimmed) if (!deliveryMap.has(key)) state.trimmed.delete(key);

    // --- A. Manage existing holdings ---------------------------------------
    for (const [key, held] of deliveryMap) {
        const m = metrics.get(key);
        const sector = universe.get(key)?.sector || "Other";
        const price = held.lastPrice;

        if (!m || isSplitSuspect(m, price)) {
            warnings.push(m
                ? `MANUAL_REVIEW: ${held.symbol} dropped >35% overnight (verify split/bonus); left untouched.`
                : `No usable history for ${held.symbol}; left untouched.`);
            coverageGap = true;
            kept++;
            addSector(sector, held.quantity * price);
            continue;
        }

        if (book.activeExitKeys.has(`D:${key}`)) {
            kept++;
            addSector(sector, held.quantity * price);
            keptReturns.push(m.returns);
            continue;
        }

        const peak = Math.max(state.peaks.get(key) ?? held.avgPrice, price);
        state.peaks.set(key, peak);

        const charges = calcDeliveryRoundTripCharges(held.avgPrice, price, held.quantity);
        const stop = deliveryStop(held, m, peak, charges / held.quantity);
        const gain = price / held.avgPrice - 1;
        const reason = price <= stop ? "STOP" : price < m.ema50 && price < m.weeklyEma10 ? "TREND_BREAK" : null;

        // 1. Full exit
        if (reason) {
            const afterCancel = cancelStops(plan, book, "D", key);
            exitOrder(plan, {
                key, product: "D", isLong: true, qty: held.quantity, ltp: price, prefix: "dx",
                buffer: reason === "STOP" ? 0.005 : 0.002,
                meta: { symbol: held.symbol, reason, netPnL: round2((price - held.avgPrice) * held.quantity - charges), afterCancel }
            });
            continue;
        }

        // 2. Partial reductions: one-time climax trim, or concentration cap (whichever is larger)
        let qty = held.quantity;
        let reduce = 0;
        let why = "";
        if (!state.trimmed.has(key) && gain >= D.CLIMAX_GAIN_PCT && (m.rsi >= 78 || price >= m.ema20 + 4 * m.atr)) {
            reduce = Math.floor(qty * D.CLIMAX_FRACTION);
            why = "CLIMAX_TRIM";
        }
        const overweight = qty * price - totalValue * D.MAX_STOCK_WEIGHT;
        if (overweight > 0 && Math.ceil(overweight / price) > reduce) {
            reduce = Math.ceil(overweight / price);
            why = "REBALANCE_TRIM";
        }
        if (reduce >= 1 && reduce < qty && reduce * price >= D.MIN_TRIM_VALUE) {
            const trimCharges = calcDeliveryRoundTripCharges(held.avgPrice, price, reduce);
            const afterCancel = cancelStops(plan, book, "D", key);
            exitOrder(plan, {
                key, product: "D", isLong: true, qty: reduce, ltp: price, prefix: "dt", buffer: 0.002,
                meta: { symbol: held.symbol, reason: why, netPnL: round2((price - held.avgPrice) * reduce - trimCharges), afterCancel }
            });
            qty -= reduce;
            if (why === "CLIMAX_TRIM" && live) state.trimmed.add(key);
        }

        // 3. Broker-side stop for what remains (protects against gaps and downtime between ticks)
        if (clock.time < D.LAST_STOP_SYNC_IST) {
            syncStop(plan, book, { key, product: "D", isLong: true, qty, trigger: stop, ltp: price, symbol: held.symbol });
        }

        kept++;
        addSector(sector, qty * price);
        keptReturns.push(m.returns);
    }

    // --- B. New entries ----------------------------------------------------
    const inWindow = clock.time >= D.ENTRY_START_IST && clock.time <= D.ENTRY_END_IST;
    if (!inWindow || !macro.allowDelivery || coverageGap) {
        return;
    }

    const tradedToday = new Set(positions.filter((p) => p.product === "D").map((p) => p.instrument_token));
    const boughtToday = positions.filter((p) => p.product === "D" && p.quantity > 0).length;
    const pending = [...book.activeEntryKeys].filter((k) => k.startsWith("D:")).length;
    const slots = Math.min(D.MAX_HOLDINGS - kept - pending, D.MAX_NEW_BUYS_PER_DAY - boughtToday - pending);
    if (slots <= 0) {
        return;
    }

    const shortlist = nifty200
        .map((stock) => ({ stock, m: metrics.get(stock.instrumentKey) }))
        .filter(({ stock, m }) =>
            m?.entryOk &&
            !deliveryMap.has(stock.instrumentKey) &&
            !tradedToday.has(stock.instrumentKey) &&
            !book.activeEntryKeys.has(`D:${stock.instrumentKey}`)
        )
        .sort((a, b) => b.m.score - a.m.score)
        .slice(0, 12);
    if (shortlist.length === 0) {
        return;
    }

    // Live timing check only for the shortlist (a handful of calls instead of the whole universe).
    const sessions = new Map();
    await mapWithConcurrency(shortlist, CONFIG.API_CONCURRENT_LIMIT, async ({ stock }) => {
        sessions.set(stock.instrumentKey, liveSession(await fetchIntradayCandles(stock.instrumentKey), today, nowMs));
    });

    const intradayReserve = I.ENABLED ? Math.min(ctx.cash, totalValue * CONFIG.INTRADAY_CAPITAL_SHARE) : 0;
    let deployable = Math.max(0, ctx.cash - totalValue * CONFIG.CASH_RESERVE_PCT - intradayReserve);

    for (const { stock, m } of shortlist) {
        if (plan.entryOrders.length >= slots) {
            break;
        }

        // Live confirmation: hold above VWAP and the open, no big gap either way, not overextended vs VWAP.
        const live1 = sessions.get(stock.instrumentKey);
        if (!live1 || live1.price < live1.vwap || live1.price < live1.open || live1.price > live1.vwap * 1.025) {
            continue;
        }
        const gap = live1.price / m.last - 1;
        if (gap > D.MAX_GAP_UP_PCT || gap < -0.02) {
            continue;
        }

        let maxCorr = 0;
        let corrMissing = false;
        for (const returns of keptReturns) {
            const corr = calculateDatedCorrelation(m.returns, returns, 60);
            if (corr === null) { corrMissing = true; break; }
            maxCorr = Math.max(maxCorr, corr);
        }
        if (corrMissing) {
            warnings.push(`Skipped ${stock.symbol}: not enough aligned return history for correlation check.`);
            continue;
        }
        if (maxCorr > D.MAX_CORRELATION) {
            continue;
        }

        const entry = roundToTick(live1.price * 1.0015);
        const stopDist = clamp(D.ATR_STOP_MULT * m.atr, entry * D.MIN_STOP_PCT, entry * D.MAX_STOP_PCT);
        const riskQty = Math.floor((totalValue * D.RISK_PER_TRADE_PCT * macro.sizeScale) / stopDist);
        const capQty = Math.floor((totalValue * D.NEW_ENTRY_MAX_WEIGHT * macro.sizeScale) / entry);
        const sectorQty = Math.floor((totalValue * D.MAX_SECTOR_WEIGHT - (sectorValue[stock.sector] || 0)) / entry);
        const qty = positionQty(Math.min(riskQty, capQty, sectorQty), entry, deployable, D);
        if (qty === 0) {
            continue;
        }

        const target = entry + D.REWARD_RISK * stopDist;
        if ((target - entry) * qty < calcDeliveryRoundTripCharges(entry, target, qty) * D.MIN_REWARD_TO_CHARGES) {
            continue;
        }

        deployable -= qty * entry;
        addSector(stock.sector, qty * entry);
        keptReturns.push(m.returns);

        plan.entryOrders.push(buildOrder({
            id: nextId("db"),
            key: stock.instrumentKey,
            product: "D",
            side: "BUY",
            qty,
            price: entry,
            tag: "pigtrader_entry",
            meta: { symbol: stock.symbol, setup: m.setup, score: m.score, rsPct: m.rsPct, stopLoss: round2(entry - stopDist), targetPrice: round2(target) }
        }));
    }
}

// ============================================================================
// 6. INTRADAY: SIGNALS ON COMPLETED 5-MINUTE BARS
// ============================================================================
function evaluateIntradaySignal(candles1m, hist1m, meta, macro, today, nowMs) {
    const session1m = candles1m.filter((c) => dayOf(c) === today && new Date(c.ts).getTime() + 60000 <= nowMs);
    const history1m = hist1m.filter((c) => dayOf(c) < today);
    if (session1m.length < 30 || history1m.length < 750) {
        return null;
    }

    const bars = resampleCandles(session1m, 5, nowMs);
    const orb = bars.filter((b) => timeOf(b) >= "09:15" && timeOf(b) < "09:45");
    if (orb.length < 6 || bars.length < 7) {
        return null;
    }

    const last = bars.at(-1);
    const prev = bars.at(-2);
    if (nowMs - last.end > 7 * 60000) {
        return null; // Stale feed
    }
    const price = last.close;

    // Indicators on 5-minute bars, warmed up with prior sessions so they are valid from the first signal.
    const histBars = resampleCandles(history1m, 5);
    const stitched = [...histBars.slice(-300), ...bars];
    const closes = stitched.map((b) => b.close);
    const recent = stitched.slice(-120);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi = calculateRSI(closes, 14);
    const atr = calculateATR(recent, 14);
    const adx = calculateADX(recent, 14);
    const vwap = calculateSessionVWAP(session1m);

    // The stop must be wide enough to pay for fees, but not so wide that sizing breaks down.
    const stopDist = I.STOP_ATR_MULT * atr;
    if (!(atr > 0) || stopDist / price < I.MIN_STOP_PCT || stopDist / price > I.MAX_STOP_PCT) {
        return null;
    }

    // Cumulative relative volume: today's volume so far vs the median of the same clock time on past sessions.
    const slot = timeOf(last);
    const cumByDay = new Map();
    for (const b of histBars) {
        if (timeOf(b) <= slot) cumByDay.set(dayOf(b), (cumByDay.get(dayOf(b)) || 0) + b.volume);
    }
    const past = [...cumByDay.values()].slice(-20).sort((a, b) => a - b);
    const medianCum = past.length >= 5 ? past[Math.floor(past.length / 2)] : 0;
    const rvol = medianCum > 0 ? sum(bars.map((b) => b.volume)) / medianCum : 0;
    if (rvol < I.MIN_RVOL) {
        return null;
    }

    // Previous-day range from history (overhead resistance / support guard) and previous close.
    const lastHist = history1m.at(-1);
    const prevDay = dayOf(lastHist);
    let pdh = -Infinity;
    let pdl = Infinity;
    for (let i = history1m.length - 1; i >= 0 && dayOf(history1m[i]) === prevDay; i--) {
        pdh = Math.max(pdh, history1m[i].high);
        pdl = Math.min(pdl, history1m[i].low);
    }
    const rs = price / lastHist.close - 1 - macro.dayRet; // Relative strength vs Nifty today

    const orbHigh = Math.max(...orb.map((b) => b.high));
    const orbLow = Math.min(...orb.map((b) => b.low));
    let direction = null;
    let setup = null;

    if (macro.bias !== "SHORT" && rs >= I.MIN_REL_STRENGTH && price > vwap && ema9 > ema21 && !(price < pdh && pdh - price < atr)) {
        if (price > orbHigh && price - orbHigh <= 1.2 * atr && rsi >= 55 && rsi <= 72) {
            setup = "ORB_BREAKOUT";
        } else if (adx >= 22 && price - vwap <= 0.8 * atr && Math.min(prev.low, last.low) <= vwap + 0.15 * atr &&
            last.close > last.open && rsi >= 45 && rsi <= 65) {
            setup = "VWAP_PULLBACK";
        }
        if (setup) direction = "BUY";
    }
    if (!setup && macro.bias !== "LONG" && rs <= -I.MIN_REL_STRENGTH && price < vwap && ema9 < ema21 && !(price > pdl && price - pdl < atr)) {
        if (price < orbLow && orbLow - price <= 1.2 * atr && rsi >= 28 && rsi <= 45) {
            setup = "ORB_BREAKDOWN";
        } else if (adx >= 22 && vwap - price <= 0.8 * atr && Math.max(prev.high, last.high) >= vwap - 0.15 * atr &&
            last.close < last.open && rsi >= 35 && rsi <= 55) {
            setup = "VWAP_REJECTION";
        }
        if (setup) direction = "SELL";
    }
    if (!setup) {
        return null;
    }

    return {
        symbol: meta.symbol,
        sector: meta.sector,
        instrumentKey: meta.instrumentKey,
        direction,
        setup,
        score: round2(Math.min(rvol, 3) * 10 + Math.min(Math.abs(rs) * 1000, 20) + (adx >= 25 ? 5 : 0)),
        price,
        stopDist,
        targetDist: I.REWARD_RISK * stopDist,
        rvol: round2(rvol),
        rsVsNiftyPct: round2(rs * 100),
        vwap: round2(vwap),
        atr5m: round2(atr)
    };
}

// ============================================================================
// 7. INTRADAY PLANNING
// ============================================================================
async function planIntraday(ctx, plan) {
    const { positions, macro, book, clock, totalValue, nifty200, metrics, today, nowMs, warnings, live } = ctx;
    const dayPositions = positions.filter((p) => p.product === "I");
    const open = dayPositions.filter((p) => p.quantity !== 0);
    const pnl = sum(dayPositions.map((p) => p.pnl || 0));
    const result = {
        intradayTotalPnL: pnl,
        dailyLossBreached: pnl <= -totalValue * I.MAX_DAILY_LOSS_PCT,
        dailyProfitGoalHit: pnl >= totalValue * I.DAILY_PROFIT_LOCK_PCT
    };

    // --- A. Manage open positions (stops/targets come from the plan made at entry) ---
    for (const pos of open) {
        const key = pos.instrument_token;
        const isLong = pos.quantity > 0;
        const qty = Math.abs(pos.quantity);
        const avg = pos.average_price;
        const ltp = pos.last_price || avg;

        let p = state.plans.get(key);
        if (!p) {
            const risk = avg * I.FALLBACK_STOP_PCT;
            const sign = isLong ? 1 : -1;
            p = { entry: avg, risk, stop: avg - sign * risk, target: avg + sign * risk * I.REWARD_RISK, best: avg, openedAt: nowMs };
            state.plans.set(key, p);
        }

        const sign = isLong ? 1 : -1;
        p.best = isLong ? Math.max(p.best, ltp) : Math.min(p.best, ltp);
        const move = sign * (ltp - avg);
        const bestMove = sign * (p.best - avg);
        const [buyPx, sellPx] = isLong ? [avg, ltp] : [ltp, avg];
        const charges = calcIntradayRoundTripCharges(buyPx, sellPx, qty);

        // Ratchet: breakeven (after fees) at +1R, then trail 0.8R behind the best price from +1.5R.
        if (bestMove >= p.risk) {
            p.stop = isLong ? Math.max(p.stop, avg + (1.2 * charges) / qty) : Math.min(p.stop, avg - (1.2 * charges) / qty);
        }
        if (bestMove >= 1.5 * p.risk) {
            p.stop = isLong ? Math.max(p.stop, p.best - 0.8 * p.risk) : Math.min(p.stop, p.best + 0.8 * p.risk);
        }

        const reason =
            clock.time >= I.SQUARE_OFF_IST ? "SQUARE_OFF" :
            (isLong ? ltp <= p.stop : ltp >= p.stop) ? "STOP" :
            (isLong ? ltp >= p.target : ltp <= p.target) ? "TARGET" :
            nowMs - p.openedAt >= I.MAX_HOLD_MINUTES * 60000 && move < 0.5 * p.risk ? "TIME_STOP" : null;

        if (book.activeExitKeys.has(`I:${key}`)) {
            continue;
        }
        if (reason) {
            const afterCancel = cancelStops(plan, book, "I", key);
            exitOrder(plan, {
                key, product: "I", isLong, qty, ltp, prefix: "ix",
                buffer: reason === "TARGET" ? 0.002 : 0.005,
                meta: { symbol: pos.trading_symbol, reason, netPnL: round2(sign * (ltp - avg) * qty - charges), afterCancel }
            });
        } else {
            syncStop(plan, book, { key, product: "I", isLong, qty, trigger: p.stop, ltp, symbol: pos.trading_symbol });
        }
    }

    // --- B. New entries ---
    const traded = new Set(dayPositions.map((p) => p.instrument_token)); // includes positions already closed today
    const pending = [...book.activeEntryKeys].filter((k) => k.startsWith("I:")).length;
    const slots = I.MAX_OPEN_TRADES - open.length - pending;
    const inWindow = clock.time >= I.ENTRY_START_IST && clock.time <= I.ENTRY_END_IST;

    if (!I.ENABLED || !inWindow || !macro.allowIntraday || slots <= 0 || traded.size >= I.MAX_TRADES_PER_DAY) {
        return result;
    }
    if (result.dailyLossBreached) {
        warnings.push(`Intraday daily loss limit breached (₹${pnl.toFixed(2)}). New intraday entries paused.`);
        return result;
    }
    if (result.dailyProfitGoalHit) {
        warnings.push(`Intraday daily profit target reached (₹${pnl.toFixed(2)}). New intraday entries paused to lock gains.`);
        return result;
    }

    const candidates = nifty200
        .filter((s) => metrics.has(s.instrumentKey) && !traded.has(s.instrumentKey) && !book.activeEntryKeys.has(`I:${s.instrumentKey}`))
        .sort((a, b) => metrics.get(b.instrumentKey).turnover - metrics.get(a.instrumentKey).turnover)
        .slice(0, I.UNIVERSE_LIMIT);

    const signals = [];
    await mapWithConcurrency(candidates, CONFIG.API_CONCURRENT_LIMIT, async (stock) => {
        const [candles1m, hist1m] = await Promise.all([
            fetchIntradayCandles(stock.instrumentKey),
            fetchHistoricalIntradayCandles(stock.instrumentKey, 30)
        ]);
        const sig = evaluateIntradaySignal(candles1m, hist1m, stock, macro, today, nowMs);
        if (sig) signals.push(sig);
    });
    signals.sort((a, b) => b.score - a.score);

    let buyingPower = Math.min(ctx.cash, totalValue * CONFIG.INTRADAY_CAPITAL_SHARE) * I.MAX_LEVERAGE;
    for (const sig of signals) {
        if (plan.entryOrders.length >= slots) {
            break;
        }

        const isLong = sig.direction === "BUY";
        const entry = roundToTick(sig.price * (isLong ? 1.0015 : 0.9985));
        const stop = isLong ? entry - sig.stopDist : entry + sig.stopDist;
        const target = isLong ? entry + sig.targetDist : entry - sig.targetDist;

        const riskQty = Math.floor((totalValue * I.RISK_PER_TRADE_PCT * macro.sizeScale) / sig.stopDist);
        const qty = positionQty(riskQty, entry, buyingPower / (slots - plan.entryOrders.length), I);
        if (qty === 0) {
            continue;
        }

        const [buyPx, sellPx] = isLong ? [entry, target] : [target, entry];
        if (sig.targetDist * qty < calcIntradayRoundTripCharges(buyPx, sellPx, qty) * I.MIN_REWARD_TO_CHARGES) {
            continue;
        }

        buyingPower -= qty * entry;
        if (live) {
            state.plans.set(sig.instrumentKey, { entry, risk: sig.stopDist, stop, target, best: entry, openedAt: nowMs });
        }

        plan.entryOrders.push(buildOrder({
            id: nextId("ie"),
            key: sig.instrumentKey,
            product: "I",
            side: sig.direction,
            qty,
            price: entry,
            tag: "pigtrader_entry",
            meta: {
                symbol: sig.symbol, setup: sig.setup, score: sig.score, rvol: sig.rvol, rsVsNiftyPct: sig.rsVsNiftyPct,
                stopLoss: round2(stop), targetPrice: round2(target)
            }
        }));
    }

    return result;
}

// ============================================================================
// 8. ENTRY POINT: execute(accessToken, live)
// ============================================================================
export async function execute(accessToken, live = false) {
    if (!accessToken) {
        throw new Error("Upstox accessToken is required.");
    }
    if (state.running) {
        throw new Error("A strategy cycle is already running.");
    }

    state.running = true;
    try {
        return await runCycle(accessToken, live);
    } finally {
        state.running = false;
    }
}

async function runCycle(accessToken, live) {
    const warnings = [];
    const clock = getISTTime();
    const nowMs = Date.now();
    const today = clock.date;

    if (state.day !== today) {
        state.day = today;
        state.plans.clear();
    }

    const nifty200 = (await getNifty200()) ?? [];
    if (nifty200.length === 0) {
        throw new Error("NIFTY 200 universe is empty");
    }

    const [portfolio, macro] = await Promise.all([fetchPortfolio(accessToken, warnings), getMacro(today, nowMs)]);

    const emptyOrders = () => ({ cancelOrderIds: [], exitOrders: [], entryOrders: [], protectiveStopOrders: [] });
    const baseReport = { timestampIST: `${today} ${clock.time}`, mode: live ? "LIVE" : "DRY_RUN" };

    // Without a complete portfolio and order book we cannot avoid duplicate or conflicting orders: do nothing.
    if (!portfolio.complete) {
        warnings.push("Portfolio data is incomplete; cycle skipped and no orders were planned.");
        return {
            ...baseReport,
            summary: { intradayPnL: 0, marketDataReady: macro.dailyOk, intradayDataReady: macro.liveOk },
            plannedOrders: emptyOrders(),
            warnings
        };
    }
    if (!macro.dailyOk) warnings.push("Index/VIX history is incomplete or stale; new entries are disabled.");
    if (!macro.liveOk) warnings.push("Current-session Nifty data is unavailable or stale; new entries are disabled.");

    const book = await reviewOrderBook(accessToken, portfolio.orders, live);
    if (book.cancelledOrderIds.length > 0) {
        warnings.push(`Cancelled ${book.cancelledOrderIds.length} stale unfilled order(s); they will be re-planned.`);
    }

    const deliveryMap = consolidateDelivery(portfolio.holdings, portfolio.positions);
    let deliveryValue = 0;
    for (const h of deliveryMap.values()) deliveryValue += h.quantity * h.lastPrice;
    const totalValue = deliveryValue + portfolio.cash;

    const universe = new Map(nifty200.map((s) => [s.instrumentKey, s]));
    for (const [key, h] of deliveryMap) {
        if (!universe.has(key)) universe.set(key, { symbol: h.symbol, instrumentKey: key, sector: "External" });
    }
    const metrics = await buildMetrics(universe, macro, today);

    const ctx = {
        live, warnings, clock, today, nowMs, macro, book, deliveryMap, universe, metrics, nifty200, totalValue,
        positions: portfolio.positions,
        cash: portfolio.cash
    };

    const deliveryPlan = emptyOrders();
    const intradayPlan = emptyOrders();
    await planDelivery(ctx, deliveryPlan);
    Object.assign(intradayPlan, await planIntraday(ctx, intradayPlan));

    const plannedOrders = {
        cancelOrderIds: [...deliveryPlan.cancelOrderIds, ...intradayPlan.cancelOrderIds],
        exitOrders: [...deliveryPlan.exitOrders, ...intradayPlan.exitOrders],
        entryOrders: [...deliveryPlan.entryOrders, ...intradayPlan.entryOrders],
        protectiveStopOrders: [...deliveryPlan.protectiveStopOrders, ...intradayPlan.protectiveStopOrders]
    };
    const responses = await executeOrders(accessToken, plannedOrders, live);

    return {
        ...baseReport,
        summary: {
            availableCash: round2(portfolio.cash),
            holdingsValue: round2(deliveryValue),
            totalValue: round2(totalValue),
            intradayPnL: round2(intradayPlan.intradayTotalPnL),
            indiaVix: macro.vix,
            vixRegime: macro.vixRegime,
            nifty50Price: macro.price,
            nifty50Trend: macro.isBullish ? "BULLISH" : "WEAK",
            nifty50WeeklyTrend: macro.weeklyUp ? "UPTREND" : "DOWNTREND",
            nifty50IntradayBias: macro.bias,
            marketDataReady: macro.dailyOk,
            intradayDataReady: macro.liveOk
        },
        deliveryPlan,
        intradayPlan,
        plannedOrders,
        responses,
        warnings
    };
}
