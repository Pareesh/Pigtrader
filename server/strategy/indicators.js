import { sum } from "./utils.js";
import CONFIG from "./config.js";
// ============================================================================
// 5. TECHNICAL & QUANTITATIVE INDICATORS
// ============================================================================
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
    if (prices.length < period) return null;
    return sum(prices.slice(-period)) / period;
}

export function calculateRSI(prices, period = 14) {
    if (prices.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        avgGain = (avgGain * (period - 1) + (diff >= 0 ? diff : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    }
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

export function calculateATR(candles, period = 14) {
    if (candles.length <= period) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const { high, low } = candles[i];
        const prevClose = candles[i - 1].close;
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    let atr = sum(trs.slice(0, period)) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

export function calculateADX(candles, period = 14) {
    if (candles.length < period * 2 + 1) return 20;
    const plusDM = [], minusDM = [], tr = [];
    for (let i = 1; i < candles.length; i++) {
        const up = candles[i].high - candles[i - 1].high;
        const down = candles[i - 1].low - candles[i].low;
        plusDM.push(up > down && up > 0 ? up : 0);
        minusDM.push(down > up && down > 0 ? down : 0);
        tr.push(Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
        ));
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
    if (dx.length < period) return 20;
    let adx = sum(dx.slice(0, period)) / period;
    for (let i = period; i < dx.length; i++) {
        adx = (adx * (period - 1) + dx[i]) / period;
    }
    return adx;
}

export function calculateSessionVWAP(candles) {
    let pv = 0, vol = 0;
    for (const c of candles) {
        pv += ((c.high + c.low + c.close) / 3) * c.volume;
        vol += c.volume;
    }
    return vol > 0 ? pv / vol : candles[candles.length - 1]?.close || 0;
}

export function calculateRiskMetrics(prices) {
    if (prices.length < 40) return { sharpe: 0, sortino: 0, dailyReturns: [] };
    const allReturns = [];
    for (let i = 1; i < prices.length; i++) {
        allReturns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    const window = allReturns.slice(-126);
    const n = window.length;
    const mar = CONFIG.RISK_FREE_RATE / 252;
    const mean = sum(window) / n;
    const variance = sum(window.map((r) => (r - mean) ** 2)) / n;
    const downVar = sum(window.map((r) => Math.min(0, r - mar) ** 2)) / n;

    const annExcess = (mean - mar) * 252;
    const annVol = Math.sqrt(variance) * Math.sqrt(252);
    const annDownVol = Math.sqrt(downVar) * Math.sqrt(252);

    return {
        sharpe: annVol > 0 ? annExcess / annVol : 0,
        sortino: annDownVol > 0 ? annExcess / annDownVol : 0,
        dailyReturns: allReturns
    };
}

export function calculateCorrelation(returnsA, returnsB, lookback = 60) {
    const a = returnsA.slice(-lookback), b = returnsB.slice(-lookback);
    const n = Math.min(a.length, b.length);
    if (n < 20) return 0;
    const sa = a.slice(-n), sb = b.slice(-n);
    const ma = sum(sa) / n, mb = sum(sb) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
        const x = sa[i] - ma, y = sb[i] - mb;
        num += x * y; da += x * x; db += y * y;
    }
    return da * db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function calculateDatedCorrelation(seriesA, seriesB, lookback = 60, minObservations = 20) {
    if (!Array.isArray(seriesA) || !Array.isArray(seriesB)) {
        return null;
    }

    const valuesA = new Map(seriesA.map(({ date, value }) => [date, value]));
    const paired = seriesB
        .filter(({ date, value }) => valuesA.has(date) && Number.isFinite(value))
        .map(({ date, value }) => [valuesA.get(date), value])
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
        .slice(-lookback);

    if (paired.length < minObservations) {
        return null;
    }

    const meanA = sum(paired.map(([a]) => a)) / paired.length;
    const meanB = sum(paired.map(([, b]) => b)) / paired.length;
    let covariance = 0;
    let varianceA = 0;
    let varianceB = 0;

    for (const [a, b] of paired) {
        const deltaA = a - meanA;
        const deltaB = b - meanB;
        covariance += deltaA * deltaB;
        varianceA += deltaA ** 2;
        varianceB += deltaB ** 2;
    }

    if (varianceA === 0 || varianceB === 0) {
        return null;
    }

    return covariance / Math.sqrt(varianceA * varianceB);
}