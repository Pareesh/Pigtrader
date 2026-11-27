import { sum } from "./utils.js";

export function calculateEMA(prices, period) {
    if (prices.length < period) {
        return null;
    }

    const k = 2 / (period + 1);
    let ema = sum(prices.slice(0, period)) / period;
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

export function calculateSMA(prices, period) {
    return prices.length < period ? null : sum(prices.slice(-period)) / period;
}

export function calculateRSI(prices, period = 14) {
    if (prices.length <= period) {
        return 50;
    }

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    }
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function trueRange(candle, prevClose) {
    return Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - prevClose),
        Math.abs(candle.low - prevClose)
    );
}

export function calculateATR(candles, period = 14) {
    if (candles.length <= period) {
        return 0;
    }

    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        trs.push(trueRange(candles[i], candles[i - 1].close));
    }

    let atr = sum(trs.slice(0, period)) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

export function calculateADX(candles, period = 14) {
    if (candles.length < period * 2 + 1) {
        return 20;
    }

    const plusDM = [];
    const minusDM = [];
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
        const up = candles[i].high - candles[i - 1].high;
        const down = candles[i - 1].low - candles[i].low;
        plusDM.push(up > down && up > 0 ? up : 0);
        minusDM.push(down > up && down > 0 ? down : 0);
        tr.push(trueRange(candles[i], candles[i - 1].close));
    }

    let sTR = sum(tr.slice(0, period));
    let sPlus = sum(plusDM.slice(0, period));
    let sMinus = sum(minusDM.slice(0, period));
    const dx = [];
    for (let i = period; i < tr.length; i++) {
        sTR = sTR - sTR / period + tr[i];
        sPlus = sPlus - sPlus / period + plusDM[i];
        sMinus = sMinus - sMinus / period + minusDM[i];
        const pDI = sTR > 0 ? (sPlus / sTR) * 100 : 0;
        const mDI = sTR > 0 ? (sMinus / sTR) * 100 : 0;
        dx.push(pDI + mDI > 0 ? (Math.abs(pDI - mDI) / (pDI + mDI)) * 100 : 0);
    }

    if (dx.length < period) {
        return 20;
    }
    let adx = sum(dx.slice(0, period)) / period;
    for (let i = period; i < dx.length; i++) {
        adx = (adx * (period - 1) + dx[i]) / period;
    }
    return adx;
}

export function calculateSessionVWAP(candles) {
    let pv = 0;
    let vol = 0;
    for (const c of candles) {
        pv += ((c.high + c.low + c.close) / 3) * c.volume;
        vol += c.volume;
    }
    return vol > 0 ? pv / vol : candles.at(-1)?.close || 0;
}

/**
 * Aggregates 1-minute candles into N-minute bars aligned to the clock (09:15, 09:20, ...).
 * Bars that have not finished by `nowMs` are dropped, so signals only use completed bars.
 */
export function resampleCandles(candles, minutes, nowMs = Infinity) {
    const size = minutes * 60000;
    const bars = [];
    let bucket = null;
    let bar = null;

    for (const c of candles) {
        const id = Math.floor(new Date(c.ts).getTime() / size);
        if (id !== bucket) {
            if (bar) bars.push(bar);
            bucket = id;
            bar = { ts: c.ts, date: c.ts, end: (id + 1) * size, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
        } else {
            bar.high = Math.max(bar.high, c.high);
            bar.low = Math.min(bar.low, c.low);
            bar.close = c.close;
            bar.volume += c.volume;
        }
    }
    if (bar) bars.push(bar);

    return bars.filter((b) => b.end <= nowMs);
}

// Pearson correlation of two [{ date, value }] series, aligned by date.
export function calculateDatedCorrelation(seriesA, seriesB, lookback = 60, minObservations = 20) {
    if (!Array.isArray(seriesA) || !Array.isArray(seriesB)) {
        return null;
    }

    const valuesA = new Map(seriesA.map(({ date, value }) => [date, value]));
    const paired = seriesB
        .filter(({ date, value }) => valuesA.has(date) && Number.isFinite(value) && Number.isFinite(valuesA.get(date)))
        .map(({ date, value }) => [valuesA.get(date), value])
        .slice(-lookback);

    if (paired.length < minObservations) {
        return null;
    }

    const meanA = sum(paired.map(([a]) => a)) / paired.length;
    const meanB = sum(paired.map(([, b]) => b)) / paired.length;
    let cov = 0;
    let varA = 0;
    let varB = 0;
    for (const [a, b] of paired) {
        cov += (a - meanA) * (b - meanB);
        varA += (a - meanA) ** 2;
        varB += (b - meanB) ** 2;
    }

    return varA === 0 || varB === 0 ? null : cov / Math.sqrt(varA * varB);
}
