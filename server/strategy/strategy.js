import CONFIG from "./config.js";
import { getFunds, getHoldings, getOrders, getPositions } from "../service/upstox.js";
import { fetchIntradayCandles, fetchHistoricalIntradayCandles, fetchHistoricalCandles } from "../service/candles.js";
import { calcDeliveryRoundTripCharges, calcIntradayRoundTripCharges } from "./charges.js";
import {
    calculateADX,
    calculateATR,
    calculateCorrelation,
    calculateEMA,
    calculateRSI,
    calculateRiskMetrics,
    calculateSMA,
    calculateSessionVWAP
} from "./indicators.js";
import { cancelStaleOrders, executeOrders } from "./executor.js";
import { getISTTime, roundToTick, sleep, sum } from "./utils.js";
import getNifty200 from "../service/nifty200.js";

let warnings = [];

// ============================================================================
// 1. UNCONSTRAINED POSITION SIZING (RISK-PARITY & BUDGET BOUNDED)
// ============================================================================
function calculatePositionQty(rawQty, unitPrice, availableBudget, isIntraday = false) {

    const minOrderValue = CONFIG.MIN_ORDER_VALUE;
    const maxOrderValue = isIntraday ? CONFIG.MAX_INTRADAY_ORDER_VALUE : CONFIG.MAX_DELIVERY_ORDER_VALUE;
    const minShares = isIntraday ? CONFIG.MIN_INTRADAY_SHARES : CONFIG.MIN_DELIVERY_SHARES

    if (!unitPrice || unitPrice <= 0 || availableBudget <= 0 || rawQty <= 0) {
        return 0;
    }

    // 1. Cap effective budget by both available cash and hard MAX_ORDER_VALUE ceiling
    const effectiveMaxBudget = Math.min(availableBudget, maxOrderValue);
    const maxQtyAllowed = Math.floor(effectiveMaxBudget / unitPrice);

    // 2. Clamp strategy's risk-parity quantity to the maximum allowed quantity
    const qty = Math.min(rawQty, maxQtyAllowed);
    const orderValue = qty * unitPrice;

    // 3. Reject if below minimum share count or minimum rupee floor
    if (qty < minShares || orderValue < minOrderValue) {
        return 0;
    }

    return qty;
}

function buildWeeklyCandles(dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 10) {
        return [];
    }

    const weeks = [];
    let currentKey = null;
    let bucket = null;

    for (const c of dailyCandles) {
        const d = new Date(c.ts || c.date);
        const day = d.getUTCDay() || 7;
        const monday = new Date(d);
        monday.setUTCDate(d.getUTCDate() - day + 1);
        const key = monday.toISOString().split("T")[0];

        if (key !== currentKey) {
            if (bucket) {
                weeks.push(bucket);
            }
            currentKey = key;
            bucket = {
                date: key,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume
            };
        } else {
            bucket.high = Math.max(bucket.high, c.high);
            bucket.low = Math.min(bucket.low, c.low);
            bucket.close = c.close;
            bucket.volume += c.volume;
        }
    }

    if (bucket) {
        weeks.push(bucket);
    }

    return weeks;
}

// ============================================================================
// 2. MACRO & VOLATILITY REGIME (NIFTY 50 DAILY/WEEKLY + INDIA VIX)
// ============================================================================
async function getMacroRegime(accessToken) {
    const [niftyDaily, niftyIntraday1m, vixCandles] = await Promise.all([
        fetchHistoricalCandles("NSE_INDEX|Nifty 50", CONFIG.CANDLE_LOOKBACK_DAYS),
        fetchIntradayCandles("NSE_INDEX|Nifty 50"),
        fetchHistoricalCandles("NSE_INDEX|India VIX", 60)
    ]);

    const { mergedDaily: niftyCandles } = buildLiveDailySeries(niftyDaily, niftyIntraday1m);

    const closes = niftyCandles.map((c) => c.close);
    const price = closes[closes.length - 1] || 0;
    const ema20 = calculateEMA(closes, 20) || price;
    const ema50 = calculateEMA(closes, 50) || price;
    const ema200 = calculateEMA(closes, 200) || price;
    const rsi = calculateRSI(closes, 14);

    const weeklyCloses = buildWeeklyCandles(niftyCandles).map((w) => w.close);
    const weeklyEma10 = calculateEMA(weeklyCloses, 10) || price;
    const isNiftyWeeklyUp = price > weeklyEma10;

    const ret = (d) =>
        closes.length > d ? (price - closes[closes.length - 1 - d]) / closes[closes.length - 1 - d] : 0;

    const vixCloses = vixCandles.map((c) => c.close);
    const vix = vixCloses[vixCloses.length - 1] || 15;
    const vixSma10 = calculateSMA(vixCloses, 10) || vix;
    const isVixSpiking = vix > vixSma10 * 1.15;

    let vixRegime = "NORMAL";
    let sizeScale = 1.0;
    let hardStop = CONFIG.DELIVERY.HARD_STOP_PCT;
    let atrMult = CONFIG.DELIVERY.ATR_STOP_MULT;

    if (vix >= 24) {
        vixRegime = "EXTREME_PANIC";
        sizeScale = 0;
        hardStop = -0.04;
        atrMult = 1.6;
    } else if (vix >= 18 || isVixSpiking) {
        vixRegime = "ELEVATED_FEAR";
        sizeScale = 0.65;
        hardStop = -0.05;
        atrMult = 1.9;
    } else if (vix < 13) {
        vixRegime = "LOW_VOLATILITY";
    }

    const isNiftyBullish = price > ema20 && price > ema50 && rsi > 46;
    const isLongTermUp = price > ema200;

    return {
        isNiftyBullish,
        isNiftyWeeklyUp,
        isLongTermUp,
        niftyPrice: Number(price.toFixed(2)),
        niftyRSI: Number(rsi.toFixed(1)),
        niftyReturn1W: ret(5),
        niftyReturn1M: ret(21),
        niftyReturn3M: ret(63),
        currentVix: Number(vix.toFixed(2)),
        vixSma10: Number(vixSma10.toFixed(2)),
        vixRegime,
        allowDeliveryBuys: vix < 24 && isLongTermUp && isNiftyWeeklyUp,
        allowIntradayTrades: vix < 24,
        sizeScale,
        hardStop,
        atrMult,
        regimeMultiplier: (isNiftyBullish ? 1.0 : 0.85) * (vix >= 18 ? 0.85 : 1.0)
    };
}

/**
 * Extracts multi-day levels, time-of-day volume profile, and 1-min baseline ATR
 * from the past 30 days of 1-minute candles.
 */
export function buildHistorical1mProfile(histCandles1m) {
    if (!histCandles1m || histCandles1m.length < 375) {
        return null;
    }

    // Group 1-min bars by IST session date (YYYY-MM-DD) & build time-of-day volume map
    const sessionsMap = new Map();
    const slotVolumes = new Map(); // "HH:MM" -> [vol1, vol2, ...]

    for (const c of histCandles1m) {
        const tsStr = String(c.ts);
        const sessionDate = tsStr.slice(0, 10);
        const hhmm = tsStr.slice(11, 16); // e.g., "09:45"

        if (!sessionsMap.has(sessionDate)) {
            sessionsMap.set(sessionDate, []);
        }
        sessionsMap.get(sessionDate).push(c);

        if (hhmm) {
            if (!slotVolumes.has(hhmm)) {
                slotVolumes.set(hhmm, []);
            }
            slotVolumes.get(hhmm).push(c.volume);
        }
    }

    const sortedDates = Array.from(sessionsMap.keys()).sort();
    if (sortedDates.length < 2) {
        return null;
    }

    // Exclude today's date if present in historical payload so PDH/PDL strictly reflects prior day
    const todayIST = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());

    const completedDates = sortedDates.filter((d) => d < todayIST);
    const prevDate = completedDates[completedDates.length - 1];
    const prevDayBars = sessionsMap.get(prevDate) || [];

    if (prevDayBars.length === 0) {
        return null;
    }

    // Previous Day High (PDH), Low (PDL), Close (PDC), and Previous Day VWAP
    let pdh = -Infinity;
    let pdl = Infinity;
    let pv = 0;
    let pVol = 0;

    for (const b of prevDayBars) {
        if (b.high > pdh) pdh = b.high;
        if (b.low < pdl) pdl = b.low;
        pv += ((b.high + b.low + b.close) / 3) * b.volume;
        pVol += b.volume;
    }

    const pdc = prevDayBars[prevDayBars.length - 1].close;
    const prevDayVwap = pVol > 0 ? pv / pVol : pdc;

    // 5-Day & 20-Day High/Low swing bounds from 1-min bars
    const last5Dates = completedDates.slice(-5);
    const last5Bars = last5Dates.flatMap((d) => sessionsMap.get(d) || []);
    const high5D = Math.max(...last5Bars.map((b) => b.high));
    const low5D = Math.min(...last5Bars.map((b) => b.low));

    // Average volume per exact clock minute across last month
    const avgSlotVolumeMap = new Map();
    for (const [hhmm, vols] of slotVolumes.entries()) {
        avgSlotVolumeMap.set(hhmm, sum(vols) / vols.length);
    }

    // Baseline 1-min ATR & 200-bar 1-min EMA from recent 1,500 historical 1-min candles
    const recentHistSlice = histCandles1m.slice(-1500);
    const baselineAtr1m = calculateATR(recentHistSlice, 20);
    const histEma200 = calculateEMA(recentHistSlice.map((c) => c.close), 200);

    return {
        prevDate,
        pdh,
        pdl,
        pdc,
        prevDayVwap,
        high5D,
        low5D,
        baselineAtr1m,
        histEma200,
        avgSlotVolumeMap
    };
}

/**
 * Merges today's 1-minute intraday candles into the daily candle series
 * and computes live intraday execution metrics (VWAP, intraday high/low, projected volume).
 */
export function buildLiveDailySeries(dailyCandles, intradayCandles1m) {
    if (!dailyCandles || dailyCandles.length === 0) {
        return { mergedDaily: [], intradayContext: null };
    }

    if (!intradayCandles1m || intradayCandles1m.length === 0) {
        return { mergedDaily: dailyCandles, intradayContext: null };
    }

    const firstBar = intradayCandles1m[0];
    const lastBar = intradayCandles1m[intradayCandles1m.length - 1];
    const todayDate = String(firstBar.ts || firstBar.date).slice(0, 10);

    let todayHigh = -Infinity;
    let todayLow = Infinity;
    let todayVolume = 0;

    for (const bar of intradayCandles1m) {
        if (bar.high > todayHigh) todayHigh = bar.high;
        if (bar.low < todayLow) todayLow = bar.low;
        todayVolume += bar.volume || 0;
    }

    const liveBar = {
        ts: lastBar.ts || todayDate,
        date: todayDate,
        open: firstBar.open,
        high: todayHigh,
        low: todayLow,
        close: lastBar.close,
        volume: todayVolume
    };

    // Replace today's bar if already present in historical payload, otherwise append
    const lastHistDate = String(dailyCandles[dailyCandles.length - 1].date).slice(0, 10);
    const mergedDaily =
        lastHistDate === todayDate
            ? [...dailyCandles.slice(0, -1), liveBar]
            : [...dailyCandles, liveBar];

    const vwap = calculateSessionVWAP(intradayCandles1m);
    const minutesElapsed = Math.max(1, intradayCandles1m.length);
    // NSE cash market session is 375 minutes (09:15 to 15:30 IST)
    const projectedFullDayVolume = (todayVolume / minutesElapsed) * 375;

    return {
        mergedDaily,
        intradayContext: {
            todayOpen: firstBar.open,
            todayHigh,
            todayLow,
            livePrice: lastBar.close,
            todayVolume,
            projectedFullDayVolume,
            vwap,
            vwapSpreadPct: vwap > 0 ? (lastBar.close - vwap) / vwap : 0,
            isAboveVwap: lastBar.close >= vwap,
            isGreenDay: lastBar.close >= firstBar.open
        }
    };
}

// ============================================================================
// 5. PORTFOLIO & DATA LOADERS
// ============================================================================
async function fetchPortfolio(accessToken) {
    const [holdingsRaw, positionsRaw, fundsRaw, ordersRaw] = await Promise.all([
        getHoldings(accessToken),
        getPositions(accessToken),
        // getFunds(accessToken),
        getOrders(accessToken)
    ]);

    const holdings = Array.isArray(holdingsRaw) ? holdingsRaw : [];
    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    const orders = Array.isArray(ordersRaw) ? ordersRaw : [];
    const availableCash = 30000
        // fundsRaw?.equity?.available_margin ??
        // fundsRaw?.available_to_trade?.total ??
        // 0;

    return { holdings, positions, orders, availableCash };
}

function consolidateDelivery(holdings, positions) {
    const deliveryMap = new Map();

    for (const h of holdings) {
        if ((h.quantity || 0) <= 0) {
            continue;
        }

        deliveryMap.set(h.instrument_token, {
            symbol: h.trading_symbol,
            instrumentKey: h.instrument_token,
            quantity: h.quantity,
            avgPrice: h.average_price,
            lastPrice: h.last_price || h.average_price,
            pnl: h.pnl || 0
        });
    }

    for (const p of positions) {
        if (p.product !== "D" || !p.quantity) {
            continue;
        }

        const existing = deliveryMap.get(p.instrument_token);

        if (p.quantity < 0 && existing) {
            existing.quantity = Math.max(0, existing.quantity + p.quantity);
            if (existing.quantity === 0) {
                deliveryMap.delete(p.instrument_token);
            }
        } else if (p.quantity > 0) {
            if (existing) {
                const totalQty = existing.quantity + p.quantity;
                existing.avgPrice =
                    (existing.avgPrice * existing.quantity + p.average_price * p.quantity) / totalQty;
                existing.quantity = totalQty;
                existing.lastPrice = p.last_price || p.average_price;
                existing.pnl = (existing.pnl || 0) + (p.pnl || 0);
            } else {
                deliveryMap.set(p.instrument_token, {
                    symbol: p.trading_symbol,
                    instrumentKey: p.instrument_token,
                    quantity: p.quantity,
                    avgPrice: p.average_price,
                    lastPrice: p.last_price || p.average_price,
                    pnl: p.pnl || 0
                });
            }
        }
    }

    return deliveryMap;
}

function getDeliveryPortfolioValue(deliveryMap) {
    let deliveryValue = 0;
    deliveryMap.forEach((v) => {
        v.currentValue = v.quantity * v.lastPrice;
        deliveryValue += v.currentValue;
    });

    return deliveryValue;
}

function getUniverseMap(nifty200, deliveryMap) {
    const universeMap = new Map();
    nifty200.forEach((s) => universeMap.set(s.instrumentKey, s));

    deliveryMap.forEach((v, k) => {
        if (!universeMap.has(k)) {
            universeMap.set(k, { symbol: v.symbol, instrumentKey: k, sector: "External" });
        }
    });

    return universeMap;
}

async function getMetricsMap(universeMap, macro) {
    const metricsMap = new Map();

    for (const [key, meta] of universeMap.entries()) {
        await sleep(CONFIG.API_DELAY_MS);

        const [dailyCandles, intradayCandles1m] = await Promise.all([
            fetchHistoricalCandles(key, CONFIG.CANDLE_LOOKBACK_DAYS),
            fetchIntradayCandles(key, CONFIG.CANDLE_INTRADAY_INTERVALS)
        ]);

        const { mergedDaily, intradayContext } = buildLiveDailySeries(dailyCandles, intradayCandles1m);

        if (!mergedDaily || mergedDaily.length < 160) {
            continue;
        }

        const scored = scoreDeliveryStock(mergedDaily, intradayContext, meta, macro);
        if (scored) {
            metricsMap.set(key, { meta, intradayContext, ...scored });
        }
    }

    return metricsMap;
}

// ============================================================================
// 3. WEEKLY + DAILY SWING DELIVERY ('D') SCORING ENGINE
// ============================================================================
function scoreDeliveryStock(candles, intradayContext, meta, macro) {
    if (!candles || candles.length < 160) {
        return null;
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const volumes = candles.map((c) => c.volume);
    const price = intradayContext?.livePrice || closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const at = (d) => closes[closes.length - 1 - d];

    const hasSplitAnomaly =
        prevClose > 0 && (price - prevClose) / prevClose <= CONFIG.DELIVERY.SPLIT_GAP_GUARD_PCT;

    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const ema200 = calculateEMA(closes, Math.min(200, closes.length));
    const adx = calculateADX(candles, 14);
    const high52 = Math.max(...highs.slice(-252));

    const weeklyCandles = buildWeeklyCandles(candles);
    const weeklyCloses = weeklyCandles.map((w) => w.close);
    const weeklyEma10 = calculateEMA(weeklyCloses, 10) || ema50;
    const weeklyEma30 = calculateEMA(weeklyCloses, 30) || ema200;
    const weeklyRsi = calculateRSI(weeklyCloses, 14);
    const prevWeekHigh = weeklyCandles.length >= 2 ? weeklyCandles[weeklyCandles.length - 2].high : price;

    // 1. Multi-Timeframe Trend Alignment (25 pts)
    let trendScore = 0;
    if (price > ema20 && ema20 > ema50) trendScore += 7;
    if (price > weeklyEma10 && weeklyEma10 > weeklyEma30) trendScore += 8;
    if (price > ema200 && adx >= 20) trendScore += 5;
    if (price >= prevWeekHigh || price >= high52 * 0.92) trendScore += 5;

    // 2. Weekly + Monthly + Quarterly Relative Alpha vs Nifty 50 (25 pts)
    const alpha1W = (price - at(5)) / at(5) - macro.niftyReturn1W;
    const alpha1M = (price - at(21)) / at(21) - macro.niftyReturn1M;
    const alpha3M = (price - at(63)) / at(63) - macro.niftyReturn3M;
    const alphaScore =
        (alpha1W > 0.01 ? 7 : alpha1W > 0 ? 3 : 0) +
        (alpha1M > 0.03 ? 9 : alpha1M > 0 ? 5 : 0) +
        (alpha3M > 0.05 ? 9 : alpha3M > 0 ? 5 : 0);

    // 3. Downside Sortino + High-VIX Defensive Tilt (20 pts)
    const { sortino, dailyReturns } = calculateRiskMetrics(closes);
    let riskScore = sortino > 2.0 ? 20 : sortino > 1.2 ? 15 : sortino > 0.5 ? 8 : 0;
    if (macro.currentVix >= 18 && CONFIG.DEFENSIVE_SECTORS.has(meta.sector)) {
        riskScore = Math.min(20, riskScore + 5);
    }

    // 4. Dual-Timeframe RSI Pullback Timing (15 pts)
    const rsi = calculateRSI(closes, 14);
    let timingScore = 0;
    if (rsi >= 46 && rsi <= 65 && weeklyRsi >= 50 && weeklyRsi <= 72) timingScore = 15;
    else if (rsi > 65 && rsi <= 74) timingScore = 8;
    else if (rsi > 74) timingScore = 2;
    else if (rsi >= 35 && price > weeklyEma10) timingScore = 11;

    // 5. Institutional Volume Accumulation (uses projected full-day volume during live session)
    const completedVols = volumes.slice(-21, -1);
    const avgVol20 = sum(completedVols) / Math.max(1, completedVols.length);
    const liveDayVol = intradayContext?.projectedFullDayVolume || volumes[volumes.length - 1];
    const recent5Vol = (sum(volumes.slice(-5, -1)) + liveDayVol) / 5;
    const volRatio = avgVol20 > 0 ? recent5Vol / avgVol20 : 1;
    const chg5D = (price - at(5)) / at(5);
    const flowScore = volRatio > 1.2 && chg5D > 0 ? 15 : volRatio > 1.2 && chg5D < 0 ? 0 : 7;

    // Intraday Entry Timing Check for New Delivery Swing Buys:
    // Must hold above Session VWAP & today's Open, and not be overextended (> +2.5% above VWAP)
    const passesIntradayTiming =
        !intradayContext ||
        (intradayContext.isAboveVwap &&
            intradayContext.isGreenDay &&
            intradayContext.vwapSpreadPct <= 0.025);

    const atr14 = calculateATR(candles, 14);
    const recentPeak = Math.max(...highs.slice(-20));
    const chandelierStop = recentPeak - macro.atrMult * atr14;
    const emaTrailFloor = ema20 - 0.5 * atr14;

    return {
        currentPrice: price,
        dayMoveATR: atr14 > 0 ? (price - prevClose) / atr14 : 0,
        hasSplitAnomaly,
        passesIntradayTiming,
        finalScore: Math.round((trendScore + alphaScore + riskScore + timingScore + flowScore) * macro.regimeMultiplier),
        alpha1WPct: Number((alpha1W * 100).toFixed(2)),
        alpha3MPct: Number((alpha3M * 100).toFixed(2)),
        sortino: Number(sortino.toFixed(2)),
        adx: Number(adx.toFixed(1)),
        rsi: Number(rsi.toFixed(1)),
        ema50,
        weeklyEma10,
        atr14,
        recentPeak,
        atrTrailingStop: Number(Math.max(chandelierStop, emaTrailFloor).toFixed(2)),
        entryStop: Number((price - macro.atrMult * atr14).toFixed(2)),
        targetPrice: Number((price + macro.atrMult * atr14 * 2.2).toFixed(2)),
        dailyReturns
    };
}

// ============================================================================
// 4. DAILY INTRADAY (MIS / 'I') SIGNAL ENGINE (1-MIN CANDLES)
// ============================================================================
function evaluateIntradaySignal(candles1m, histCandles1m, meta, macro) {
    if (!candles1m || candles1m.length < 35) {
        return null;
    }

    const histProfile = buildHistorical1mProfile(histCandles1m);

    // Stitch last 200 historical 1-min candles before today's candles so EMA50/EMA200
    // and RSI are fully warmed up right from 09:45 AM without cold-start distortion
    const stitchedCandles =
        histCandles1m && histCandles1m.length > 0
            ? [...histCandles1m.slice(-200), ...candles1m]
            : candles1m;

    const stitchedCloses = stitchedCandles.map((c) => c.close);
    const volumes = candles1m.map((c) => c.volume);
    const last = candles1m[candles1m.length - 1];
    const prev = candles1m[candles1m.length - 2];
    const price = last.close;

    const vwap = calculateSessionVWAP(candles1m);
    const ema20 = calculateEMA(stitchedCloses, 20);
    const ema50 = calculateEMA(stitchedCloses, 50);
    const ema200 = calculateEMA(stitchedCloses, 200) || ema50;
    const rsi = calculateRSI(stitchedCloses, 14);
    const todayAtr = calculateATR(candles1m, 20);
    const adx = calculateADX(stitchedCandles, 14);

    // Blend today's 1-min ATR with last month's 1-min ATR baseline for stable stop sizing
    const atr =
        histProfile?.baselineAtr1m > 0
            ? todayAtr * 0.65 + histProfile.baselineAtr1m * 0.35
            : todayAtr;

    if (!atr || atr / price < 0.0004 || atr / price > 0.008) {
        return null;
    }

    // Opening Range = First 30 minutes of today's session (09:15 to 09:45 IST)
    const orbSlice = candles1m.slice(0, 30);
    const orbHigh = Math.max(...orbSlice.map((c) => c.high));
    const orbLow = Math.min(...orbSlice.map((c) => c.low));

    // Volume Surge: Combine rolling 20-min volume AND 30-day exact clock-minute average
    const recentVolWindow = volumes.slice(-21, -1);
    const avgVol20m = sum(recentVolWindow) / Math.max(1, recentVolWindow.length);
    const rollingSurge = avgVol20m > 0 ? last.volume / avgVol20m : 1;

    const currentHHMM = String(last.ts).slice(11, 16);
    const histSlotAvgVol = histProfile?.avgSlotVolumeMap?.get(currentHHMM) || avgVol20m;
    const slotSurge = histSlotAvgVol > 0 ? last.volume / histSlotAvgVol : rollingSurge;
    const volSurge = rollingSurge * 0.5 + slotSurge * 0.5;

    let setup = null;
    let direction = null;
    let confidence = 0;

    // Resistance / Support Overhead Guard using Last Month's 1-Min Levels (PDH / PDL / 5D)
    const nearPdhResistance =
        histProfile && price < histProfile.pdh && histProfile.pdh - price < 1.8 * atr;
    const nearPdlSupport =
        histProfile && price > histProfile.pdl && price - histProfile.pdl < 1.8 * atr;

    // Setup A: 30-Min ORB + VWAP + 200-bar 1-min Trend Alignment (with PDH/PDL overhead guard)
    if (
        price > orbHigh &&
        prev.close > orbHigh &&
        price > vwap &&
        ema20 > ema50 &&
        price > ema200 &&
        !nearPdhResistance &&
        rsi >= 55 &&
        rsi <= 73 &&
        volSurge >= CONFIG.INTRADAY.MIN_VOL_SURGE &&
        macro.isNiftyBullish
    ) {
        setup = "ORB_1M_VWAP_BREAKOUT";
        direction = "BUY";
        confidence = Math.min(95, Math.round(70 + (volSurge - 1) * 8 + (adx > 22 ? 8 : 0)));
    } else if (
        price < orbLow &&
        prev.close < orbLow &&
        price < vwap &&
        ema20 < ema50 &&
        price < ema200 &&
        !nearPdlSupport &&
        rsi <= 45 &&
        rsi >= 27 &&
        volSurge >= CONFIG.INTRADAY.MIN_VOL_SURGE &&
        !macro.isNiftyBullish
    ) {
        setup = "ORB_1M_VWAP_BREAKDOWN";
        direction = "SELL";
        confidence = Math.min(95, Math.round(70 + (volSurge - 1) * 8 + (adx > 22 ? 8 : 0)));
    }

    // Setup B: Previous Day High / Low (PDH/PDL) Multi-Day Breakout from Last Month's 1m Data
    if (!setup && histProfile && volSurge >= 1.6 && adx >= 22) {
        if (
            macro.isNiftyBullish &&
            price > histProfile.pdh &&
            prev.close > histProfile.pdh &&
            price > vwap &&
            ema20 > ema50 &&
            rsi >= 56 &&
            rsi <= 74
        ) {
            setup = "PDH_1M_MULTI_DAY_BREAKOUT";
            direction = "BUY";
            confidence = Math.min(94, Math.round(74 + (volSurge - 1) * 7));
        } else if (
            !macro.isNiftyBullish &&
            price < histProfile.pdl &&
            prev.close < histProfile.pdl &&
            price < vwap &&
            ema20 < ema50 &&
            rsi >= 26 &&
            rsi <= 44
        ) {
            setup = "PDL_1M_MULTI_DAY_BREAKDOWN";
            direction = "SELL";
            confidence = Math.min(94, Math.round(74 + (volSurge - 1) * 7));
        }
    }

    // Setup C: Trend Pullback to VWAP or Previous Day VWAP
    const distFromVwapATR = Math.abs(price - vwap) / atr;
    if (!setup && adx >= 24 && distFromVwapATR <= 0.6 && volSurge >= 1.3) {
        if (
            macro.isNiftyBullish &&
            ema20 > ema50 &&
            price > ema200 &&
            !nearPdhResistance &&
            prev.low <= vwap &&
            last.close > vwap &&
            last.close > last.open &&
            rsi >= 50 &&
            rsi <= 65
        ) {
            setup = "VWAP_TREND_PULLBACK_LONG";
            direction = "BUY";
            confidence = 78;
        } else if (
            !macro.isNiftyBullish &&
            ema20 < ema50 &&
            price < ema200 &&
            !nearPdlSupport &&
            prev.high >= vwap &&
            last.close < vwap &&
            last.close < last.open &&
            rsi >= 35 &&
            rsi <= 50
        ) {
            setup = "VWAP_TREND_PULLBACK_SHORT";
            direction = "SELL";
            confidence = 78;
        }
    }

    // Setup D: Sideways Extreme Mean Reversion
    const signedVwapATR = (price - vwap) / atr;
    if (!setup && adx < 19) {
        if (signedVwapATR <= -3.5 && rsi < 22 && last.close > last.open) {
            setup = "VWAP_1M_OVERSOLD_BOUNCE";
            direction = "BUY";
            confidence = 72;
        } else if (signedVwapATR >= 3.5 && rsi > 78 && last.close < last.open) {
            setup = "VWAP_1M_OVERBOUGHT_FADE";
            direction = "SELL";
            confidence = 72;
        }
    }

    if (!setup) {
        return null;
    }

    const stopDist = CONFIG.INTRADAY.ATR_STOP_MULT * atr;
    const targetDist = CONFIG.INTRADAY.ATR_TARGET_MULT * atr;

    return {
        symbol: meta.symbol,
        sector: meta.sector,
        instrumentKey: meta.instrumentKey,
        product: "I",
        direction,
        setup,
        confidence,
        entryPrice: price,
        stopLoss: Number((direction === "BUY" ? price - stopDist : price + stopDist).toFixed(2)),
        targetPrice: Number((direction === "BUY" ? price + targetDist : price - targetDist).toFixed(2)),
        stopDist,
        vwap: Number(vwap.toFixed(2)),
        pdh: histProfile?.pdh ?? null,
        pdl: histProfile?.pdl ?? null,
        volSurge: Number(volSurge.toFixed(2)),
        rsi: Number(rsi.toFixed(1))
    };
}

// ============================================================================
// 6. DELIVERY ('D') EVALUATION & ORDER GENERATION
// ============================================================================
function evaluateDeliverys(
    deliveryMap,
    universeMap,
    metricsMap,
    macro,
    orderState,
    clock,
    availableCash,
    totalValue,
    nifty200
) {
    const exitOrders = [];
    const entryOrders = [];
    const protectiveStopOrders = [];
    const keptReturns = [];
    const sectorValues = {};
    let keptCount = 0;
    let corrId = 1;

    // A1. Evaluate Existing Delivery Holdings for Exit, Daily Harvest & Stop-Loss Sync
    for (const [key, held] of deliveryMap.entries()) {
        const m = metricsMap.get(key);
        const sec = universeMap.get(key)?.sector || "Other";

        if (!m) {
            warnings.push(`Missing historical data for ${held.symbol}; left untouched.`);
            keptCount++;
            sectorValues[sec] = (sectorValues[sec] || 0) + held.currentValue;
            continue;
        }

        if (m.hasSplitAnomaly) {
            warnings.push(`MANUAL_REVIEW: ${held.symbol} dropped >35% overnight (verify stock split/bonus).`);
            keptCount++;
            sectorValues[sec] = (sectorValues[sec] || 0) + held.currentValue;
            continue;
        }

        const price = held.lastPrice;
        const netGainPct = (price - held.avgPrice) / held.avgPrice;
        const roundTripCharges = calcDeliveryRoundTripCharges(held.avgPrice, price, held.quantity);
        const netPnL = (price - held.avgPrice) * held.quantity - roundTripCharges;
        const feePerShare = roundTripCharges / Math.max(1, held.quantity);

        // Progressive Risk Ratchet: Hard Stop -> Breakeven Lock (+3%) -> Chandelier Trail (+6.5%)
        let activeStop = Number((held.avgPrice * (1 + macro.hardStop)).toFixed(2));
        if (m.recentPeak >= held.avgPrice * (1 + CONFIG.DELIVERY.BREAKEVEN_ARM_PCT)) {
            activeStop = Math.max(activeStop, Number((held.avgPrice + feePerShare * 1.15).toFixed(2)));
        }
        if (m.recentPeak >= held.avgPrice * (1 + CONFIG.DELIVERY.TRAIL_ARM_PCT)) {
            activeStop = Math.max(activeStop, m.atrTrailingStop);
        }

        const hasPendingExit = orderState.activeExitKeys.has(`D:${key}`);

        // 1. Stop-Loss or Weekly Trend Breakdown -> Full Exit
        if (
            !hasPendingExit &&
            (price <= activeStop ||
                (m.finalScore < CONFIG.DELIVERY.MIN_SCORE_HOLD && price < m.weeklyEma10 && price < m.ema50))
        ) {
            exitOrders.push({
                correlation_id: `d_exit_${corrId++}`,
                quantity: held.quantity,
                product: "D",
                validity: "DAY",
                price: roundToTick(price * 0.998),
                trigger_price: 0,
                order_type: "LIMIT",
                transaction_type: "SELL",
                instrument_token: key,
                disclosed_quantity: 0,
                tag: "pigtrader_exit",
                _meta: {
                    symbol: held.symbol,
                    netPnL: Number(netPnL.toFixed(2)),
                    reason: "STOP_OR_BREAKDOWN"
                }
            });
            continue;
        }

        let remQty = held.quantity;
        let remVal = remQty * price;

        // 2. Daily Swing Profit Harvesting (Book 50% gain when net profit >= +4.5% & momentum peaks)
        if (
            !hasPendingExit &&
            netGainPct >= CONFIG.DELIVERY.DAILY_HARVEST_PCT &&
            (m.rsi > 68 || m.dayMoveATR >= 2.2)
        ) {
            const harvestQty = Math.floor(remQty * CONFIG.DELIVERY.HARVEST_FRACTION);
            const harvestCharges = calcDeliveryRoundTripCharges(held.avgPrice, price, harvestQty);
            const harvestNetProfit = (price - held.avgPrice) * harvestQty - harvestCharges;

            if (harvestQty >= 1 && harvestNetProfit > harvestCharges * 3) {
                exitOrders.push({
                    correlation_id: `d_harv_${corrId++}`,
                    quantity: harvestQty,
                    product: "D",
                    validity: "DAY",
                    price: roundToTick(price * 0.9985),
                    trigger_price: 0,
                    order_type: "LIMIT",
                    transaction_type: "SELL",
                    instrument_token: key,
                    disclosed_quantity: 0,
                    tag: "pigtrader_exit",
                    _meta: {
                        symbol: held.symbol,
                        netPnL: Number(harvestNetProfit.toFixed(2)),
                        reason: `DAILY_PROFIT_HARVEST (+${(netGainPct * 100).toFixed(1)}%)`
                    }
                });
                remQty -= harvestQty;
                remVal = remQty * price;
            }
        }

        // 3. Single-Stock Concentration Rebalance (> 14% cap)
        if (totalValue > 0 && remVal / totalValue > CONFIG.DELIVERY.MAX_STOCK_WEIGHT) {
            const excess = remVal - totalValue * CONFIG.DELIVERY.MAX_STOCK_WEIGHT;
            const trimQty = Math.floor(excess / price);
            if (!hasPendingExit && trimQty >= 1 && trimQty < remQty && trimQty * price >= CONFIG.MIN_ORDER_VALUE) {
                const trimCharges = calcDeliveryRoundTripCharges(held.avgPrice, price, trimQty);
                exitOrders.push({
                    correlation_id: `d_reb_${corrId++}`,
                    quantity: trimQty,
                    product: "D",
                    validity: "DAY",
                    price: roundToTick(price * 0.9985),
                    trigger_price: 0,
                    order_type: "LIMIT",
                    transaction_type: "SELL",
                    instrument_token: key,
                    disclosed_quantity: 0,
                    tag: "pigtrader_exit",
                    _meta: {
                        symbol: held.symbol,
                        netPnL: Number(((price - held.avgPrice) * trimQty - trimCharges).toFixed(2)),
                        reason: "REBALANCE_TRIM"
                    }
                });
                remQty -= trimQty;
                remVal = remQty * price;
            }
        }

        // 4. Attach Broker-Side Protective SL for Remaining Delivery Shares
        if (remQty > 0 && !orderState.activeStopLossKeys.has(`D:${key}`) && clock.time < "15:15") {
            const slTrigger = roundToTick(activeStop);
            protectiveStopOrders.push({
                correlation_id: `d_sl_${corrId++}`,
                quantity: remQty,
                product: "D",
                validity: "DAY",
                price: roundToTick(slTrigger * 0.997),
                trigger_price: slTrigger,
                order_type: "SL",
                transaction_type: "SELL",
                instrument_token: key,
                disclosed_quantity: 0,
                tag: "pigtrader_sl",
                _meta: { symbol: held.symbol, stopLoss: slTrigger }
            });
        }

        keptCount++;
        sectorValues[sec] = (sectorValues[sec] || 0) + remVal;
        keptReturns.push({ symbol: held.symbol, returns: m.dailyReturns });
    }

    // A2. Screen Full Nifty 100 for New Weekly Swing Delivery Buys
    const inMarketHours = clock.time >= CONFIG.DELIVERY.ENTRY_START_IST && clock.time <= CONFIG.DELIVERY.ENTRY_END_IST;
    if (inMarketHours && macro.allowDeliveryBuys && keptCount < CONFIG.DELIVERY.MAX_HOLDINGS) {
        const candidates = [];
        for (const stock of nifty200) {
            const m = metricsMap.get(stock.instrumentKey);
            if (!m || m.hasSplitAnomaly || m.finalScore < CONFIG.DELIVERY.MIN_SCORE_BUY) {
                continue;
            }
            // Intraday 1-min timing filter: require price >= Session VWAP & green day without chasing >2.5% spikes
            if (!m.passesIntradayTiming) {
                continue;
            }

            if (deliveryMap.has(stock.instrumentKey) || orderState.activeEntryKeys.has(`D:${stock.instrumentKey}`)) {
                continue;
            }
            candidates.push({ stock, m });
        }

        candidates.sort((a, b) => b.m.finalScore - a.m.finalScore || b.m.sortino - a.m.sortino);

        const reserveCash = totalValue * CONFIG.CASH_RESERVE_PCT;
        const intradayReserve = Math.min(availableCash, totalValue * CONFIG.INTRADAY_CAPITAL_SHARE);
        let deployableCash = Math.max(0, availableCash - reserveCash - intradayReserve);
        const buySlots = Math.min(
            CONFIG.DELIVERY.MAX_HOLDINGS - keptCount,
            CONFIG.DELIVERY.MAX_NEW_BUYS_PER_RUN
        );

        for (const { stock, m } of candidates) {
            if (entryOrders.length >= buySlots) {
                break;
            }

            let maxCorr = 0;
            for (const ex of keptReturns) {
                maxCorr = Math.max(maxCorr, calculateCorrelation(m.dailyReturns, ex.returns, 60));
            }
            if (maxCorr > CONFIG.DELIVERY.MAX_CORRELATION) {
                continue;
            }

            const riskBudget = totalValue * CONFIG.DELIVERY.RISK_PER_TRADE_PCT * macro.sizeScale;
            const stopDist = m.currentPrice - m.entryStop;
            const riskQty = stopDist > 0 ? Math.floor(riskBudget / stopDist) : 0;
            const capQty = Math.floor(
                (totalValue * CONFIG.DELIVERY.NEW_ENTRY_MAX_WEIGHT * macro.sizeScale) / m.currentPrice
            );
            const sectorRoom =
                totalValue * CONFIG.DELIVERY.MAX_SECTOR_WEIGHT - (sectorValues[stock.sector] || 0);
            const sectorQty = Math.floor(sectorRoom / m.currentPrice);

            const qty = calculatePositionQty(
                Math.min(riskQty, capQty, sectorQty),
                m.currentPrice,
                deployableCash
            );
            if (qty === 0) {
                continue;
            }

            const orderValue = qty * m.currentPrice;
            const expectedGrossGain = (m.targetPrice - m.currentPrice) * qty;
            const estCharges = calcDeliveryRoundTripCharges(m.currentPrice, m.targetPrice, qty);
            if (expectedGrossGain < estCharges * CONFIG.DELIVERY.MIN_REWARD_TO_CHARGES) {
                continue;
            }

            deployableCash -= orderValue;
            sectorValues[stock.sector] = (sectorValues[stock.sector] || 0) + orderValue;
            keptReturns.push({ symbol: stock.symbol, returns: m.dailyReturns });

            entryOrders.push({
                correlation_id: `d_buy_${corrId++}`,
                quantity: qty,
                product: "D",
                validity: "DAY",
                price: roundToTick(m.currentPrice * 1.0015),
                trigger_price: 0,
                order_type: "LIMIT",
                transaction_type: "BUY",
                instrument_token: stock.instrumentKey,
                disclosed_quantity: 0,
                tag: "pigtrader_entry",
                _meta: {
                    symbol: stock.symbol,
                    stopLoss: m.entryStop,
                    score: m.finalScore
                }
            });
        }
    }

    return { exitOrders, entryOrders, protectiveStopOrders };
}

// ============================================================================
// 7. INTRADAY ('I') EVALUATION (FETCHES BOTH LIVE & 30D 1-MIN CANDLES)
// ============================================================================
async function evaluateIntraday(accessToken, positions, macro, orderState, clock, availableCash, totalValue, nifty200) {
    const intradayPositions = positions.filter((p) => p.product === "I" && p.quantity !== 0);
    const intradayTotalPnL = positions
        .filter((p) => p.product === "I")
        .reduce((acc, p) => acc + (p.pnl || 0), 0);

    const dailyLossBreached = intradayTotalPnL <= -totalValue * CONFIG.INTRADAY.MAX_DAILY_LOSS_PCT;
    const dailyProfitGoalHit = intradayTotalPnL >= totalValue * CONFIG.INTRADAY.DAILY_PROFIT_LOCK_PCT;

    const exitOrders = [];
    const entryOrders = [];
    let corrId = 500;

    // 1. Manage Open Intraday Positions
    for (const pos of intradayPositions) {
        const qty = Math.abs(pos.quantity);
        const isLong = pos.quantity > 0;
        const ltp = pos.last_price || pos.average_price;
        const movePct = isLong
            ? (ltp - pos.average_price) / pos.average_price
            : (pos.average_price - ltp) / pos.average_price;

        const estCharges = calcIntradayRoundTripCharges(pos.average_price, ltp, qty);
        const netPosPnL = (isLong ? ltp - pos.average_price : pos.average_price - ltp) * qty - estCharges;
        const hasPendingExit = orderState.activeExitKeys.has(`I:${pos.instrument_token}`);

        if (
            !hasPendingExit &&
            (clock.time >= CONFIG.INTRADAY.SQUARE_OFF_IST || movePct <= -0.01 || movePct >= 0.014)
        ) {
            exitOrders.push({
                correlation_id: `i_exit_${corrId++}`,
                quantity: qty,
                product: "I",
                validity: "DAY",
                price: roundToTick(isLong ? ltp * 0.998 : ltp * 1.002),
                trigger_price: 0,
                order_type: "LIMIT",
                transaction_type: isLong ? "SELL" : "BUY",
                instrument_token: pos.instrument_token,
                disclosed_quantity: 0,
                tag: "pigtrader_exit",
                _meta: {
                    symbol: pos.trading_symbol,
                    netPnL: Number(netPosPnL.toFixed(2)),
                    reason:
                        clock.time >= CONFIG.INTRADAY.SQUARE_OFF_IST
                            ? "15:05_SQUAREOFF"
                            : "PROFIT_OR_STOP"
                }
            });
        }
    }

    // 2. Scan for New Intraday Entries using Today's 1-Min + Last Month's 1-Min Candles
    const openIntradaySlots = Math.max(0, CONFIG.INTRADAY.MAX_OPEN_TRADES - intradayPositions.length);
    const inIntradayWindow =
        clock.time >= CONFIG.INTRADAY.ENTRY_START_IST && clock.time <= CONFIG.INTRADAY.ENTRY_END_IST;

    if (!inIntradayWindow) {
        warnings.push(
            `Intraday entries inactive at ${clock.time} IST (active window: ${CONFIG.INTRADAY.ENTRY_START_IST}–${CONFIG.INTRADAY.ENTRY_END_IST} IST).`
        );
    } else if (dailyProfitGoalHit) {
        warnings.push(
            `Daily intraday profit target (+1.8%) achieved (₹${intradayTotalPnL.toFixed(2)}). Trading paused to lock gains.`
        );
    } else if (!dailyLossBreached && macro.allowIntradayTrades && openIntradaySlots > 0) {
        const activeIntradayKeys = new Set(intradayPositions.map((p) => p.instrument_token));
        const signals = [];

        // for (const stock of NIFTY_100.slice(0, CONFIG.INTRADAY.UNIVERSE_LIMIT)) {
        for (const stock of nifty200) {
            if (
                activeIntradayKeys.has(stock.instrumentKey) ||
                orderState.activeEntryKeys.has(`I:${stock.instrumentKey}`)
            ) {
                continue;
            }

            await sleep(75);
            const [candles1m, histCandles1m] = await Promise.all([
                fetchIntradayCandles(stock.instrumentKey, CONFIG.CANDLE_INTRADAY_INTERVALS),
                fetchHistoricalIntradayCandles(stock.instrumentKey, 30)
            ]);

            const sig = evaluateIntradaySignal(candles1m, histCandles1m, stock, macro);
            if (sig) {
                signals.push(sig);
            }
        }

        signals.sort((a, b) => b.confidence - a.confidence);

        const intradayPool = Math.min(availableCash, totalValue * CONFIG.INTRADAY_CAPITAL_SHARE);
        let buyingPower = intradayPool * CONFIG.INTRADAY.MAX_LEVERAGE;

        for (const sig of signals) {
            if (entryOrders.length >= openIntradaySlots) {
                break;
            }

            const riskBudget = totalValue * CONFIG.INTRADAY.RISK_PER_TRADE_PCT * macro.sizeScale;
            const riskQty = Math.floor(riskBudget / sig.stopDist);
            const qty = calculatePositionQty(riskQty, sig.entryPrice, buyingPower / openIntradaySlots, true);

            if (qty === 0) {
                continue;
            }

            const orderValue = qty * sig.entryPrice;
            const grossTarget = Math.abs(sig.targetPrice - sig.entryPrice) * qty;
            const estCharges = calcIntradayRoundTripCharges(sig.entryPrice, sig.targetPrice, qty);

            if (grossTarget < estCharges * CONFIG.INTRADAY.MIN_REWARD_TO_CHARGES) {
                continue;
            }

            buyingPower -= orderValue;

            entryOrders.push({
                correlation_id: `i_ent_${corrId++}`,
                quantity: qty,
                product: "I",
                validity: "DAY",
                price: roundToTick(sig.direction === "BUY" ? sig.entryPrice * 1.0015 : sig.entryPrice * 0.9985),
                trigger_price: 0,
                order_type: "LIMIT",
                transaction_type: sig.direction,
                instrument_token: sig.instrumentKey,
                disclosed_quantity: 0,
                tag: "pigtrader_entry",
                _meta: {
                    symbol: sig.symbol,
                    stopLoss: sig.stopLoss,
                    targetPrice: sig.targetPrice,
                    setup: sig.setup
                }
            });
        }
    }

    return { intradayTotalPnL, dailyLossBreached, dailyProfitGoalHit, exitOrders, entryOrders };
}

function getSummary(availableCash, deliveryValue, totalValue, intradayPnL, macro) {
    return {
        availableCash: Number(availableCash.toFixed(2)),
        holdingsValue: Number(deliveryValue.toFixed(2)),
        totalValue: Number(totalValue.toFixed(2)),
        intradayPnL: Number(intradayPnL.toFixed(2)),
        indiaVix: macro.currentVix,
        vixRegime: macro.vixRegime,
        nifty50Price: macro.niftyPrice,
        nifty50Trend: macro.isNiftyBullish ? "BULLISH" : "WEAK",
        nifty50WeeklyTrend: macro.isNiftyWeeklyUp ? "UPTREND" : "DOWNTREND"
    };
}

// ============================================================================
// 8. SINGLE ENTRY POINT: execute strategy(accessToken, live)
// ============================================================================
export async function execute(accessToken, live = false) {
    if (!accessToken) {
        throw new Error("Upstox accessToken is required.");
    }

    const clock = getISTTime();
    const nifty200 = await getNifty200() ?? [];

    if (!nifty200.length) {
        throw new Error("NIFTY 200 universe is empty");
    }

    const [{ holdings, positions, orders, availableCash }, macro] = await Promise.all([
        fetchPortfolio(accessToken),
        getMacroRegime(accessToken)
    ]);

    const orderState = await cancelStaleOrders(accessToken, orders);
    if (orderState.cancelledOrderIds.length > 0) {
        warnings.push(`Cancelled ${orderState.cancelledOrderIds.length} stale intraday entry orders.`);
    }

    const deliveryMap = consolidateDelivery(holdings, positions);
    const deliveryValue = getDeliveryPortfolioValue(deliveryMap);
    const totalValue = deliveryValue + availableCash;

    const universeMap = getUniverseMap(nifty200, deliveryMap);
    const metricsMap = await getMetricsMap(universeMap, macro);

    const deliveryPlan = evaluateDeliverys(
        deliveryMap,
        universeMap,
        metricsMap,
        macro,
        orderState,
        clock,
        availableCash,
        totalValue,
        nifty200
    );

    const intradayPlan = await evaluateIntraday(
        accessToken,
        positions,
        macro,
        orderState,
        clock,
        availableCash,
        totalValue,
        nifty200
    );

    const plannedOrders = {
        exitOrders: [...deliveryPlan.exitOrders, ...intradayPlan.exitOrders],
        entryOrders: [...deliveryPlan.entryOrders, ...intradayPlan.entryOrders],
        protectiveStopOrders: [...deliveryPlan.protectiveStopOrders]
    };

    const responses = await executeOrders(accessToken, plannedOrders, live);

    console.log(`${clock.date} ${clock.time} : Startegy Completed`);

    return {
        timestampIST: `${clock.date} ${clock.time}`,
        mode: live ? "LIVE" : "DRY_RUN",
        summary: getSummary(availableCash, deliveryValue, totalValue, intradayPlan.intradayTotalPnL, macro),
        deliveryPlan,
        intradayPlan,
        plannedOrders,
        responses,
        warnings
    }
}