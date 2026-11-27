import crypto from "crypto";
import config from "../config.js";

const API_V2 = "https://api.upstox.com/v2";
const API_V3 = "https://api.upstox.com/v3";

function getHeaders(accessToken) {
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json"
    };

    if (config.upstox.algoName) {
        headers["X-Algo-Name"] = config.upstox.algoName;
    }
    return headers;
}

// Single place for fetch + JSON parsing + error extraction. Omit accessToken for public endpoints.
async function call(url, label, { accessToken, ...init } = {}) {
    const res = await fetch(url, accessToken ? { ...init, headers: getHeaders(accessToken) } : init);
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(json.message || json.errors?.[0]?.message || `${label} failed: ${res.status}`);
    }
    return json;
}

// ----------------------------------------------------------------------------
// OAuth & profile
// ----------------------------------------------------------------------------
export function getAuthURL(state) {
    const params = new URLSearchParams({
        response_type: "code",
        client_id: config.upstox.apiKey,
        redirect_uri: config.upstox.redirectUri,
        state: state || crypto.randomBytes(16).toString("hex")
    });
    return `${API_V2}/login/authorization/dialog?${params}`;
}

export async function getAccessTokenFromCode(code) {
    const json = await call(`${API_V2}/login/authorization/token`, "Token exchange", {
        method: "POST",
        headers: { accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: config.upstox.apiKey,
            client_secret: config.upstox.apiSecret,
            redirect_uri: config.upstox.redirectUri,
            grant_type: "authorization_code"
        })
    });
    return json.access_token;
}

export const getUserProfile = async (accessToken) => {
    try {
        return await call(`${API_V2}/user/profile`, "Profile", { accessToken });
    } catch(err) {
        return null;
    }

}

// ----------------------------------------------------------------------------
// Portfolio
// ----------------------------------------------------------------------------
export async function getFunds(accessToken) {
    return (await call(`${API_V3}/user/get-funds-and-margin`, "Funds", { accessToken })).data ?? null;
}

export async function getPositions(accessToken) {
    return (await call(`${API_V2}/portfolio/short-term-positions`, "Positions", { accessToken })).data || [];
}

export async function getHoldings(accessToken) {
    return (await call(`${API_V2}/portfolio/long-term-holdings`, "Holdings", { accessToken })).data || [];
}

export async function getOrders(accessToken) {
    return (await call(`${API_V2}/order/retrieve-all`, "Orders", { accessToken })).data || [];
}

// ----------------------------------------------------------------------------
// Market data (public endpoints). Rows are [ts, open, high, low, close, volume, oi], newest first.
// ----------------------------------------------------------------------------
// from and to must be YYYY-MM-DD
export async function getHistoricalCandles(instrumentKey, to, from, unit = "days", interval = 1) {
    const url = `${API_V3}/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${to}/${from}`;
    return (await call(url, "Historical candles")).data?.candles || [];
}

export async function getIntradayCandles(instrumentKey, unit = "minutes", interval = 1) {
    const url = `${API_V3}/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${interval}`;
    return (await call(url, "Intraday candles")).data?.candles || [];
}

// ----------------------------------------------------------------------------
// Orders
// ----------------------------------------------------------------------------
const ORDER_CHUNK_SIZE = 5;

// Returns { placed, errors }. With live = false nothing is sent and `placed` echoes the payloads.
export async function placeMultipleOrder(accessToken, orders = [], live = false) {
    if (!accessToken) {
        throw new Error("Upstox access token is required.");
    }
    if (!Array.isArray(orders) || orders.length === 0) {
        throw new Error("At least one order is required.");
    }

    const payloads = structuredClone(orders).map((o, i) => ({
        ...o,
        correlation_id: o.correlation_id || `pigtrader-${i}`
    }));

    if (!live) {
        return { placed: payloads, errors: [] };
    }

    const placed = [];
    const errors = [];
    for (let i = 0; i < payloads.length; i += ORDER_CHUNK_SIZE) {
        const json = await call(`${API_V2}/order/multi/place`, "Order batch", {
            accessToken,
            method: "POST",
            body: JSON.stringify(payloads.slice(i, i + ORDER_CHUNK_SIZE))
        });

        placed.push(...(json.data || []));
        // A batch can be partially accepted; surface per-order rejections instead of hiding them.
        for (const e of json.errors || []) {
            errors.push(`${e.correlation_id ?? "order"}: ${e.message ?? JSON.stringify(e)}`);
        }
    }
    return { placed, errors };
}

export async function cancelOrder(accessToken, orderId) {
    const url = `${API_V2}/order/cancel?order_id=${encodeURIComponent(orderId)}`;
    return (await call(url, "Order cancellation", { accessToken, method: "DELETE" })).data || "";
}
