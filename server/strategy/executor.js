import CONFIG from "./config.js";
import { cancelOrder, getOrders, placeMultipleOrder } from "../service/upstox.js";
import { roundToTick, sleep } from "./utils.js";

// ============================================================================
// BROKER ORDER HYGIENE (CANCEL STALE ORDERS & PREVENT DUPLICATES)
// ============================================================================
export async function cancelStaleOrders(accessToken, orders, live = false) {
    const activeEntryKeys = new Set();
    const activeExitKeys = new Set();
    const activeStopLossKeys = new Set();
    const cancelledOrderIds = [];
    const nowMs = Date.now();

    for (const ord of orders) {
        const status = String(ord.status || "").toLowerCase();
        if (!CONFIG.ACTIVE_ORDER_STATUSES.has(status)) {
            continue;
        }

        const key = ord.instrument_token;
        const tag = String(ord.tag || "");
        const orderType = String(ord.order_type || "").toUpperCase();
        const orderTimeMs = ord.order_timestamp ? new Date(ord.order_timestamp).getTime() : nowMs;
        const ageMinutes = (nowMs - orderTimeMs) / 60000;

        // Auto-cancel stale unfilled Intraday ('I') entry LIMIT orders older than 15 minutes
        if (ord.product === "I" &&
            orderType === "LIMIT" &&
            tag === "pigtrader_entry" &&
            ageMinutes > CONFIG.INTRADAY.STALE_ORDER_MINUTES
        ) {
            const orderId = ord.order_id;

            if (!live) {
                cancelledOrderIds.push(orderId);
                continue;
            }

            try {                
                await cancelOrder(accessToken, orderId)
                cancelledOrderIds.push(orderId);
                continue;
            } catch {
                // Keep tracked if cancellation fails
            }
        }

        if (orderType === "SL" || orderType === "SL-M") {
            activeStopLossKeys.add(`${ord.product}:${key}`);
        } else if (tag === "pigtrader_exit") {
            activeExitKeys.add(`${ord.product}:${key}`);
        } else {
            activeEntryKeys.add(`${ord.product}:${key}`);
        }
    }

    return { activeEntryKeys, activeExitKeys, activeStopLossKeys, cancelledOrderIds };
}

export async function executeOrders(accessToken, { exitOrders, entryOrders, protectiveStopOrders }, live = false) {
    const stripMeta = (list) => list.map(({ _meta, ...payload }) => payload);
    const executionReport = { exits: [], entries: [], stopLosses: [] };
    let corrId = 900;

    try {
        // 1. Submit Exits first to free up capital & margin
        if (exitOrders.length > 0) {
            executionReport.exits = await placeMultipleOrder(accessToken, stripMeta(exitOrders), live);
        }

        // 2. Submit buffered LIMIT Entries second
        if (entryOrders.length > 0) {
            executionReport.entries = await placeMultipleOrder(accessToken, stripMeta(entryOrders), live);

            // 3. Verify order book after 3 seconds so protective SL attaches only to valid entries
            await sleep(3000);

            const refreshedOrders = await getOrders(accessToken);

            const validEntryTokens = new Set((Array.isArray(refreshedOrders) ? refreshedOrders : [])
                .filter(
                    (o) =>
                        o.tag === "pigtrader_entry" &&
                        !["rejected", "cancelled"].includes(String(o.status).toLowerCase())
                )
                .map((o) => `${o.product}:${o.instrument_token}`)
            );

            for (const ent of entryOrders) {
                if (!validEntryTokens.has(`${ent.product}:${ent.instrument_token}`)) {
                    continue;
                }
                const isLong = ent.transaction_type === "BUY";
                const trigger = roundToTick(ent._meta.stopLoss);

                protectiveStopOrders.push({
                    correlation_id: `sl_${corrId++}`,
                    quantity: ent.quantity,
                    product: ent.product,
                    validity: "DAY",
                    price: roundToTick(isLong ? trigger * 0.997 : trigger * 1.003),
                    trigger_price: trigger,
                    order_type: "SL",
                    transaction_type: isLong ? "SELL" : "BUY",
                    instrument_token: ent.instrument_token,
                    disclosed_quantity: 0,
                    tag: "pigtrader_sl",
                    _meta: { symbol: ent._meta.symbol, stopLoss: trigger }
                });
            }
        }

        // 4. Submit all Protective Stop-Loss ('SL') orders
        if (protectiveStopOrders.length > 0) {
            executionReport.stopLosses = await placeMultipleOrder(accessToken, stripMeta(protectiveStopOrders), live);
        }
    } catch (err) {
        console.error(err);
    }

    return executionReport;
}