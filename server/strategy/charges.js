import CONFIG from "./config.js";

const C = CONFIG.CHARGES;

function roundTripCharges(buyPrice, sellPrice, qty, delivery) {
    if (qty <= 0) {
        return 0;
    }

    const buyVal = buyPrice * qty;
    const sellVal = sellPrice * qty;
    const turnover = buyVal + sellVal;

    const maxFee = delivery ? C.DELIVERY_BROKERAGE_MAX : C.INTRADAY_BROKERAGE_MAX;
    const rate = delivery ? C.DELIVERY_BROKERAGE_RATE : C.INTRADAY_BROKERAGE_RATE;
    const brokerage = Math.min(maxFee, buyVal * rate) + Math.min(maxFee, sellVal * rate);

    const stt = delivery ? turnover * C.DELIVERY_STT_RATE : sellVal * C.INTRADAY_STT_RATE;
    const txn = turnover * C.NSE_TXN_RATE;
    const sebi = turnover * C.SEBI_TURNOVER_RATE;
    const stamp = buyVal * (delivery ? C.DELIVERY_STAMP_RATE : C.INTRADAY_STAMP_RATE);
    const gst = (brokerage + txn + sebi) * C.GST_RATE;
    const dp = delivery ? C.DP_CHARGE_WITH_GST : 0;

    return brokerage + stt + txn + sebi + stamp + gst + dp;
}

// Pass the real buy and sell prices. For an intraday short, the buy price is the (lower) exit.
export const calcDeliveryRoundTripCharges = (buyPrice, sellPrice, qty) =>
    roundTripCharges(buyPrice, sellPrice, qty, true);

export const calcIntradayRoundTripCharges = (buyPrice, sellPrice, qty) =>
    roundTripCharges(buyPrice, sellPrice, qty, false);