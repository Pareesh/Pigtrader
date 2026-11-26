const histCandlesMap = new Map();
const intradayCandlesMap = new Map();

const API_V3 = "https://api.upstox.com/v3";

function dateString(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}

function isHistoricalCandlesStale(key) {
    if (!key) {
        return true;
    }
    
    const value = histCandlesMap.get(key);

    if (!value || !value.time || !value.data) {
        return true;
    }

    if((new Date()).getTime() - value.time >= 43200000) {
        return true;
    }

    return false;
}

function isIntradayCandlesStale(key) {
    if (!key) {
        return true;
    }
    
    const value = intradayCandlesMap.get(key);

    if (!value || !value.time || !value.data) {
        return true;
    }

    if((new Date()).getTime() - value.time >= 120000) {
        return true;
    }

    return false;
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

export async function getHistoricalCandles(instrumentKey, daysBack = 400) {
    const to = new Date();
    const from = new Date(to.getTime() - daysBack * 86400000);

    const cacheKey = `${instrumentKey}-${from}-${to}-days-1`;

    if (!isHistoricalCandlesStale(cacheKey)) {
        return histCandlesMap.get(cacheKey).data;
    }

    const key = encodeURIComponent(instrumentKey);
    const url = `${API_V3}/historical-candle/${key}/days/1/${dateString(to)}/${dateString(from)}`;
    
    try {
        const res = await fetch(url);

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
            throw new Error(json.message || json.errors?.[0]?.message || `Historical candles failed: ${res.status}`);
        }

        // Upstox returns newest candle first -> reverse so oldest is index 0
        const data = json.data?.candles || [];
        const candles = normalizeCandles(data);

        histCandlesMap.set(cacheKey, {
            data: candles,
            time: (new Date()).getTime()
        })
        
        return candles;
    } catch (err) {
        console.error("getHistoricalCandles -> " + err + " : " + instrumentKey);
        return [];
    }
}

/**
 * Fetches last 30 days (1 month) of 1-minute historical candles via Upstox V3.
 */
export async function getHistoricalIntradayCandles(instrumentKey, daysBack = 30) {
    const to = new Date();
    const from = new Date(to.getTime() - Math.min(daysBack, 30) * 86400000);
    const cacheKey = `${instrumentKey}-${from}-${to}-minutes-1`;

    if (!isHistoricalCandlesStale(cacheKey)) {
        return histCandlesMap.get(cacheKey).data;
    }

    const key = encodeURIComponent(instrumentKey);
    const url = `${API_V3}/historical-candle/${key}/minutes/1/${dateString(to)}/${dateString(from)}`;

    try {
        const res = await fetch(url);

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
            throw new Error(json.message || json.errors?.[0]?.message || `1-min historical candles failed (${res.status})`);
        }

        const candles = normalizeCandles(json.data?.candles || []);

        histCandlesMap.set(cacheKey, {
            data: candles,
            time: (new Date()).getTime()
        })
        return candles;
    } catch (err) {
        console.error("getHistoricalIntradayCandles -> " + err + " : " + instrumentKey);
        return [];
    }
}

export async function getIntradayCandles(instrumentKey, interval = 1) {
    const cacheKey = `${instrumentKey}-minutes-1`;

    if (!isIntradayCandlesStale(cacheKey)) {
        return intradayCandlesMap.get(cacheKey).data;
    }

    const key = encodeURIComponent(instrumentKey);
    const url = `${API_V3}/historical-candle/intraday/${key}/minutes/${interval}`;

    try {
        const res = await fetch(url);
    
        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
            throw new Error(json.message || json.errors?.[0]?.message || `Intraday Historical candles failed: ${res.status}`);
        }

        const data = json.data?.candles || [];
        const candles = normalizeCandles(data);
        
        intradayCandlesMap.set(cacheKey, {
            data: candles,
            time: (new Date()).getTime()
        })

        return candles;
    } catch (err) {
        console.error("getIntradayCandles -> " + err + " : " + instrumentKey);
        return [];
    }
}