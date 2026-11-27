import CONFIG from "./config.js";
import { cancelOrder, placeMultipleOrder } from "../service/upstox.js";
import { parseBrokerTime, sleep } from "./utils.js";

// ============================================================================
// ORDER BOOK REVIEW: cancel stale orders, index what is still live
// ============================================================================
export async function reviewOrderBook(accessToken, orders, live = false) {
    const book = {
        activeEntryKeys: new Set(),   // "product:instrument" with a live entry order
        activeExitKeys: new Set(),    // "product:instrument" with a live exit order
        stops: new Map(),             // "product:instrument" -> [{ orderId, trigger, quantity }]
        cancelledOrderIds: []
    };
    const nowMs = Date.now();

    for (const ord of orders) {
        if (CONFIG.TERMINAL_ORDER_STATUSES.has(String(ord.status || "").toLowerCase())) {
            continue;
        }

        const key = `${ord.product}:${ord.instrument_token}`;
        const type = String(ord.order_type || "").toUpperCase();
        const tag = String(ord.tag || "");

        // Unfilled entry/exit LIMIT orders go stale quickly: cancel so they are re-planned at a fresh price.
        const ageMinutes = (nowMs - parseBrokerTime(ord.order_timestamp)) / 60000;
        if (live && (tag === "pigtrader_entry" || tag === "pigtrader_exit") && ageMinutes > CONFIG.STALE_ORDER_MINUTES) {
            try {
                await cancelOrder(accessToken, ord.order_id);
                book.cancelledOrderIds.push(ord.order_id);
                continue;
            } catch {
                // Cancellation failed: the order is still live, so keep tracking it.
            }
        }

        if (type === "SL" || type === "SL-M") {
            const list = book.stops.get(key) || [];
            list.push({ orderId: ord.order_id, trigger: Number(ord.trigger_price), quantity: Number(ord.quantity) });
            book.stops.set(key, list);
        } else if (tag === "pigtrader_exit") {
            book.activeExitKeys.add(key);
        } else {
            book.activeEntryKeys.add(key);
        }
    }

    return book;
}

// ============================================================================
// EXECUTION: cancel -> exits -> entries -> stops
// Stops are only attached to positions that already exist (never to unfilled entries),
// so a cancelled entry can never leave an orphan stop that opens a naked position.
// ============================================================================
export async function executeOrders(accessToken, plan, live = false) {
    const { cancelOrderIds = [], exitOrders, entryOrders, protectiveStopOrders } = plan;
    const report = { cancelled: [], exits: [], entries: [], stopLosses: [], errors: [] };
    const failedCancels = new Set();

    if (live) {
        for (const id of cancelOrderIds) {
            try {
                await cancelOrder(accessToken, id);
                report.cancelled.push(id);
            } catch (err) {
                failedCancels.add(id);
                report.errors.push(`cancel ${id}: ${err.message}`);
            }
        }
        if (cancelOrderIds.length > 0) {
            await sleep(500);
        }
    }

    // An order that replaces a stop must not go out if that stop could not be cancelled.
    const submit = async (bucket, orders) => {
        const sendable = orders.filter((o) => !(o._meta?.afterCancel || []).some((id) => failedCancels.has(id)));
        if (sendable.length === 0) {
            return;
        }
        try {
            const { placed, errors } = await placeMultipleOrder(accessToken, sendable.map(({ _meta, ...payload }) => payload), live);
            report[bucket] = placed;
            report.errors.push(...errors);
        } catch (err) {
            report.errors.push(`${bucket}: ${err.message}`);
        }
    };

    await submit("exits", exitOrders);
    await submit("entries", entryOrders);
    await submit("stopLosses", protectiveStopOrders);

    return report;
}
