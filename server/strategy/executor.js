import CONFIG from "./config.js";
import { cancelOrder, getHoldings, getOrders, getPositions, placeMultipleOrder } from "../service/upstox.js";
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
        if (live &&
            ord.product === "I" &&
            orderType === "LIMIT" &&
            tag === "pigtrader_entry" &&
            ageMinutes > CONFIG.INTRADAY.STALE_ORDER_MINUTES
        ) {
            const orderId = ord.order_id;

            try {
                await cancelOrder(accessToken, orderId)
                cancelledOrderIds.push(orderId);
                continue;
            } catch {
                // Keep tracked as active if cancellation fails
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
    const executionReport = { exits: [], entries: [], stopLosses: [], errors: [] };
    let corrId = 900;

    try {
        let executableExits = exitOrders;

        if (live && exitOrders.length > 0) {
            const activeStatuses = CONFIG.ACTIVE_ORDER_STATUSES;
            const orders = await getOrders(accessToken);
            const stopsByKey = new Map();

            for (const order of orders) {
                const key = `${order.product}:${order.instrument_token}`;
                const orderType = String(order.order_type || "").toUpperCase();
                const status = String(order.status || "").toLowerCase();
                if (
                    (orderType === "SL" || orderType === "SL-M") &&
                    activeStatuses.has(status) &&
                    exitOrders.some((exit) => `${exit.product}:${exit.instrument_token}` === key)
                ) {
                    if (!stopsByKey.has(key)) stopsByKey.set(key, []);
                    stopsByKey.get(key).push(order);
                }
            }

            const blockedExitKeys = new Set();
            for (const [key, stops] of stopsByKey) {
                if (stops.some((stop) => stop.tag !== "pigtrader_sl")) {
                    blockedExitKeys.add(key);
                    executionReport.errors.push(
                        `Exit skipped for ${key}: a non-strategy protective stop is active and was not cancelled.`
                    );
                    continue;
                }
                for (const stop of stops) {
                    if (!stop.order_id) {
                        blockedExitKeys.add(key);
                        executionReport.errors.push(`Cannot safely replace protective stop for ${key}: broker order has no ID.`);
                        continue;
                    }
                    try {
                        await cancelOrder(accessToken, stop.order_id);
                    } catch (err) {
                        blockedExitKeys.add(key);
                        executionReport.errors.push(
                            `Cannot safely replace protective stop for ${key}: ${err instanceof Error ? err.message : String(err)}`
                        );
                    }
                }
            }

            if (stopsByKey.size > 0) {
                const refreshedOrders = await getOrders(accessToken);
                for (const order of refreshedOrders) {
                    const key = `${order.product}:${order.instrument_token}`;
                    const orderType = String(order.order_type || "").toUpperCase();
                    const status = String(order.status || "").toLowerCase();
                    if (
                        (orderType === "SL" || orderType === "SL-M") &&
                        activeStatuses.has(status) &&
                        stopsByKey.has(key)
                    ) {
                        blockedExitKeys.add(key);
                        executionReport.errors.push(`Exit skipped for ${key}: protective stop cancellation is not confirmed.`);
                    }
                }
            }

            const exitsAfterStopCancellation = exitOrders.filter((exit) => {
                const key = `${exit.product}:${exit.instrument_token}`;
                return stopsByKey.has(key) && !blockedExitKeys.has(key);
            });
            const quantityByKey = new Map();
            if (exitsAfterStopCancellation.length > 0) {
                try {
                    const [positions, holdings] = await Promise.all([
                        getPositions(accessToken),
                        getHoldings(accessToken)
                    ]);
                    for (const position of positions) {
                        const quantity = Number(position.quantity ?? position.net_quantity ?? 0);
                        if (position.instrument_token && Number.isFinite(quantity)) {
                            quantityByKey.set(
                                `${position.product || "I"}:${position.instrument_token}`,
                                quantity
                            );
                        }
                    }
                    for (const holding of holdings) {
                        const quantity = Number(holding.quantity ?? holding.net_quantity ?? 0);
                        if (holding.instrument_token && Number.isFinite(quantity)) {
                            quantityByKey.set(
                                `${holding.product || "D"}:${holding.instrument_token}`,
                                quantity
                            );
                        }
                    }
                } catch (err) {
                    for (const exit of exitsAfterStopCancellation) {
                        const key = `${exit.product}:${exit.instrument_token}`;
                        blockedExitKeys.add(key);
                        executionReport.errors.push(
                            `Exit skipped for ${key}: position quantity could not be refreshed after stop cancellation (${err instanceof Error ? err.message : String(err)}).`
                        );
                    }
                }
            }

            executableExits = exitOrders.flatMap((exit) => {
                const key = `${exit.product}:${exit.instrument_token}`;
                if (blockedExitKeys.has(key)) return [];
                if (!stopsByKey.has(key)) return [exit];

                const signedQuantity = quantityByKey.get(key) || 0;
                const positionQuantity = exit.transaction_type === "SELL"
                    ? Math.max(0, signedQuantity)
                    : Math.max(0, -signedQuantity);
                const quantity = Math.min(exit.quantity, positionQuantity);
                if (quantity < 1) {
                    executionReport.errors.push(`Exit skipped for ${key}: no matching open quantity remains after stop cancellation.`);
                    return [];
                }
                return [{ ...exit, quantity }];
            });
        }

        // 1. Submit exits only after any matching broker-side stop is confirmed cancelled.
        if (executableExits.length > 0) {
            executionReport.exits = await placeMultipleOrder(accessToken, stripMeta(executableExits), live);
        }

        // 2. Submit buffered LIMIT Entries second
        if (entryOrders.length > 0) {
            executionReport.entries = await placeMultipleOrder(accessToken, stripMeta(entryOrders), live);

            let validEntryOrders = entryOrders;

            if (live) {
                // Attach stops only for quantities the portfolio has confirmed as filled.
                await sleep(3000);
                const filledQuantityByKey = new Map();
                let portfolioReadFailed = false;
                try {
                    const [positions, holdings] = await Promise.all([
                        getPositions(accessToken),
                        getHoldings(accessToken)
                    ]);
                    const addFilledQuantities = (records, product) => {
                        for (const record of records) {
                            const quantity = Number(record.quantity ?? record.net_quantity ?? 0);
                            if (!record.instrument_token || !Number.isFinite(quantity) || quantity === 0) continue;
                            filledQuantityByKey.set(
                                `${record.product || product}:${record.instrument_token}`,
                                quantity
                            );
                        }
                    };
                    addFilledQuantities(positions, "I");
                    addFilledQuantities(holdings, "D");
                } catch (err) {
                    portfolioReadFailed = true;
                    executionReport.errors.push(
                        `Unable to confirm entry fills; new protective stops were withheld: ${err instanceof Error ? err.message : String(err)}`
                    );
                }
                validEntryOrders = [];
                for (const ent of entryOrders) {
                    const signedQuantity = filledQuantityByKey.get(`${ent.product}:${ent.instrument_token}`) || 0;
                    const filledQuantity = ent.transaction_type === "BUY"
                        ? Math.max(0, signedQuantity)
                        : Math.max(0, -signedQuantity);
                    const stopQuantity = Math.min(ent.quantity, filledQuantity);
                    if (stopQuantity < 1) {
                        if (!portfolioReadFailed) {
                            executionReport.errors.push(
                                `Protective stop skipped for ${ent._meta.symbol}: broker has not confirmed a filled position.`
                            );
                        }
                        continue;
                    }
                    validEntryOrders.push({ ...ent, quantity: stopQuantity });
                }
            }

            for (const ent of validEntryOrders) {
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
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        executionReport.errors.push(message);
    }

    return executionReport;
}