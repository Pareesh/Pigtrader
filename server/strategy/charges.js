import CONFIG from "./config.js";
// ============================================================================
// 3. HIDDEN CHARGES & STATUTORY FEE CALCULATORS
// ============================================================================
export function calcDeliveryRoundTripCharges(buyPrice, sellPrice, qty) {
    if (qty <= 0) {
        return 0;
    }

    const buyVal = buyPrice * qty;
    const sellVal = sellPrice * qty;
    const turnover = buyVal + sellVal;

    const brokerage =
        Math.min(CONFIG.CHARGES.DELIVERY_BROKERAGE_MAX, buyVal * 0.025) +
        Math.min(CONFIG.CHARGES.DELIVERY_BROKERAGE_MAX, sellVal * 0.025);

    const stt = turnover * CONFIG.CHARGES.DELIVERY_STT_RATE;
    const txn = turnover * CONFIG.CHARGES.NSE_TXN_RATE;
    const sebi = turnover * CONFIG.CHARGES.SEBI_TURNOVER_RATE;
    const stamp = buyVal * CONFIG.CHARGES.DELIVERY_STAMP_RATE;
    const gst = (brokerage + txn + sebi) * CONFIG.CHARGES.GST_RATE;
    const dp = CONFIG.CHARGES.DP_CHARGE_WITH_GST;

    return brokerage + stt + txn + sebi + stamp + gst + dp;
}

export function calcIntradayRoundTripCharges(entryPrice, exitPrice, qty) {
    if (qty <= 0) {
        return 0;
    }

    const buyVal = Math.min(entryPrice, exitPrice) * qty;
    const sellVal = Math.max(entryPrice, exitPrice) * qty;
    const turnover = buyVal + sellVal;

    const brokerage =
        Math.min(CONFIG.CHARGES.INTRADAY_BROKERAGE_MAX, buyVal * 0.0005) +
        Math.min(CONFIG.CHARGES.INTRADAY_BROKERAGE_MAX, sellVal * 0.0005);

    const stt = sellVal * CONFIG.CHARGES.INTRADAY_STT_RATE;
    const txn = turnover * CONFIG.CHARGES.NSE_TXN_RATE;
    const sebi = turnover * CONFIG.CHARGES.SEBI_TURNOVER_RATE;
    const stamp = buyVal * CONFIG.CHARGES.INTRADAY_STAMP_RATE;
    const gst = (brokerage + txn + sebi) * CONFIG.CHARGES.GST_RATE;

    return brokerage + stt + txn + sebi + stamp + gst;
}