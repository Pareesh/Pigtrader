import TimeCache from '../components/TimeCache.js';
import { getHistoricalCandles, getIntradayCandles } from './upstox.js';

const dailyCache = new TimeCache(12 * 60);
const historicalMinuteCache = new TimeCache(12 * 60);
const intradayCache = new TimeCache(2);

const dateString = (d) =>
    new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d);

// Upstox rows are [ts, o, h, l, c, v, oi], newest first. Returns clean candles, oldest first.
function normalizeCandles(rows = []) {
    return rows
        .map((c) => ({
            ts: c[0],
            date: c[0],
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5] ?? 0)
        }))
        .filter((c) =>
            Number.isFinite(c.open) && Number.isFinite(c.high) &&
            Number.isFinite(c.low) && Number.isFinite(c.close) &&
            Number.isFinite(c.volume) && c.close > 0
        )
        .sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

// Cache successful loads only. Failures return [] without caching so the next cycle retries.
async function cachedCandles(cache, cacheKey, label, instrumentKey, load) {
    if (!instrumentKey) {
        throw new Error("Instrument Key is empty");
    }

    const hit = cache.getValue(cacheKey);
    if (hit) {
        console.log(`${cacheKey} was a hit`);
        return hit;
    }

    try {
        const candles = normalizeCandles(await load());
        cache.storeValue(cacheKey, candles);
        return candles;
    } catch (err) {
        console.error(`${label} -> ${err.message} : ${instrumentKey}`);
        return [];
    }
}

export function fetchHistoricalCandles(instrumentKey, daysBack = 400) {
    const to = new Date();
    const from = new Date(to.getTime() - daysBack * 86400000);

    return cachedCandles(
        dailyCache,
        `${instrumentKey}-${dateString(from)}-${dateString(to)}`,
        "fetchHistoricalCandles",
        instrumentKey,
        () => getHistoricalCandles(instrumentKey, dateString(to), dateString(from))
    );
}

// Up to 30 days of 1-minute candles (Upstox V3 limit).
export function fetchHistoricalIntradayCandles(instrumentKey, daysBack = 30) {
    const to = new Date();
    const from = new Date(to.getTime() - Math.min(daysBack, 30) * 86400000);

    return cachedCandles(
        historicalMinuteCache,
        `${instrumentKey}-${dateString(from)}-${dateString(to)}`,
        "fetchHistoricalIntradayCandles",
        instrumentKey,
        () => getHistoricalCandles(instrumentKey, dateString(to), dateString(from), "minutes")
    );
}

// Today's candles so far.
export function fetchIntradayCandles(instrumentKey, interval = 1) {
    return cachedCandles(
        intradayCache,
        `${instrumentKey}-${interval}`,
        "fetchIntradayCandles",
        instrumentKey,
        () => getIntradayCandles(instrumentKey, "minutes", interval)
    );
}
