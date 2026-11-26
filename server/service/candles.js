import TimeCache from '../components/TimeCache.js';
import { getHistoricalCandles, getIntradayCandles } from './upstox.js';

const candles1d = new TimeCache(12*60);
const candles1m = new TimeCache(12*60);
const intradayCandles1m = new TimeCache(2);

function dateString(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}

function normalizeCandles(rows = []) {
    return rows.map(c => ({
        ts: c[0],
        date: c[0],
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5] ?? 0)
    })).filter(c =>
        Number.isFinite(c.open) && Number.isFinite(c.high) &&
        Number.isFinite(c.low) && Number.isFinite(c.close) &&
        Number.isFinite(c.volume) && c.close > 0
    ).sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

export async function fetchHistoricalCandles(instrumentKey, daysBack = 400) {
    const to = new Date();
    const from = new Date(to.getTime() - daysBack * 86400000);

    const cacheKey = `${instrumentKey}-${dateString(from)}-${dateString(to)}`;
    const storedValue = candles1d.getValue(cacheKey);

    if (storedValue) {
        return storedValue;
    }

    if(!instrumentKey) {
        throw new Error("Instrument Key is empty")
    }
    
    try {
        const data = await getHistoricalCandles(instrumentKey, dateString(to), dateString(from));
        const candles = normalizeCandles(data);

        candles1d.storeValue(cacheKey, candles);
        
        return candles;
    } catch (err) {
        console.error("fetchHistoricalCandles -> " + err + " : " + instrumentKey);
        return [];
    }
}

/**
 * Fetches last 30 days (1 month) of 1-minute historical candles via Upstox V3.
 */
export async function fetchHistoricalIntradayCandles(instrumentKey, daysBack = 30) {
    const to = new Date();
    const from = new Date(to.getTime() - Math.min(daysBack, 30) * 86400000);
    const cacheKey = `${instrumentKey}-${dateString(from)}-${dateString(to)}`;

    const storedValue = candles1m.getValue(cacheKey);

    if (storedValue) {
        return storedValue;
    }

    try {
        const data = await getHistoricalCandles(instrumentKey, dateString(to), dateString(from), "minutes");
        const candles = normalizeCandles(data);

        candles1m.storeValue(cacheKey, candles);
        
        return candles;
    } catch (err) {
        console.error("fetchHistoricalIntradayCandles -> " + err + " : " + instrumentKey);
        return [];
    }
}

export async function fetchIntradayCandles(instrumentKey, interval = 1) {
    const cacheKey = `${instrumentKey}-${interval}`;

    const storedValue = intradayCandles1m.getValue(cacheKey);

    if (storedValue) {
        return storedValue;
    }

    try {
        const data = await getIntradayCandles(instrumentKey, "minutes", interval);
        const candles = normalizeCandles(data);

        intradayCandles1m.storeValue(cacheKey, candles);
        
        return candles;
    } catch (err) {
        console.error("fetchIntradayCandles -> " + err + " : " + instrumentKey);
        return [];
    }
}