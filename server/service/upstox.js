import crypto from "crypto";
import config from "../config.js";

const API_V2 = "https://api.upstox.com/v2";
const API_V3 = "https://api.upstox.com/v3";
const APIHFT_V3 = "https://api-hft.upstox.com/v3";

function cryptoRandomState() {
  return crypto.randomBytes(16).toString("hex");
}

function getHeaders(accessToken, extra = {}) {
    const h = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...extra,
    };
    
    if (config.upstox.algoName) {
        h["X-Algo-Name"] = config.upstox.algoName;
    }
    return h;
}

export function getAuthURL(state) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.upstox.apiKey,
    redirect_uri: config.upstox.redirectUri,
    state: state || cryptoRandomState(),
  });

  return `${API_V2}/login/authorization/dialog?${params.toString()}`;
}

export async function getAccessTokenFromCode(code) {
    const body = new URLSearchParams({
        code,
        client_id: config.upstox.apiKey,
        client_secret: config.upstox.apiSecret,
        redirect_uri: config.upstox.redirectUri,
        grant_type: "authorization_code",
    });
    
    const res = await fetch(`${API_V2}/login/authorization/token`, {
        method: "POST",
        headers: {
            accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });
  
    const json = await res.json().catch(() => ({}));
    
    if (!res.ok) {
        throw new Error(json.message || json.error || `Token exchange failed: ${res.status}`);
    }
  
    return json.access_token;
}

export async function getUserProfile(accessToken) {
    const res = await fetch(`${API_V2}/user/profile`, {
        headers: getHeaders(accessToken),
    });
    
    const json = await res.json().catch(() => ({}));
    
    if (!res.ok) {
        throw new Error(json.message || json.errors?.[0]?.message || `Profile failed: ${res.status}`);
    }

    return json;
}

export async function getFunds(accessToken) {
    const res = await fetch(`${API_V3}/user/get-funds-and-margin`, {
        headers: getHeaders(accessToken),
    });

    const json = await res.json().catch(() => ({}));
    
    if (!res.ok) {
        throw new Error(json.message || json.errors?.[0]?.message || `Positions failed: ${res.status}`);
    }

    return json.data || [];
}

export async function getPositions(accessToken) {
    const res = await fetch(`${API_V2}/portfolio/short-term-positions`, {
        headers: getHeaders(accessToken),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(json.message || json.errors?.[0]?.message || `Positions failed: ${res.status}`);
    }

    return json.data || [];
}

export async function getHoldings(accessToken) {
    const res = await fetch(`${API_V2}/portfolio/long-term-holdings`, {
        headers: getHeaders(accessToken),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(json.message || json.errors?.[0]?.message || `Positions failed: ${res.status}`);
    }

    return json.data || [];
}

export async function convertPositions(accessToken, order) {
    // @todo complete this method
    const body = {

    };

    const res = await fetch(`${API_V2}portfolio/convert-position`, {
        headers: getHeaders(accessToken),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(json.message || json.errors?.[0]?.message || `Positions failed: ${res.status}`);
    }

    return json.data || [];
}

export async function getOrders(accessToken) {
    const res = await fetch(`${API_V2}/order/retrieve-all`, {
        headers: getHeaders(accessToken),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(json.message || json.errors?.[0]?.message || `Orders failed: ${res.status}`);
    }
    
    return json.data || [];
}

export async function placeMultipleOrder(accessToken, orders = []) {
    if (!accessToken) {
        throw new Error("Upstox access token is required.");
    }

    if (!Array.isArray(orders) || orders.length === 0) {
        throw new Error("At least one order is required.");
    }

    const CHUNK_SIZE = 5;
    const responses = [];

    orders.forEach((o ,i) => {
        o.correlation_id = o.correlation_id || `pigkeeper-correlation-${i}`
    });

    for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
        const chunk = orders.slice(i, i + CHUNK_SIZE);

        const res = await fetch(`${API_V2}/order/multi/place`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(chunk)
        });

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
            throw new Error(json.message || json.errors?.[0]?.message || `Order batch failed: ${res.status}`);
        }

        responses.push(...(json.data || []));
    }
    return responses;
}

export async function cancelOrder(accessToken, orderId) {
    const res = await fetch(`${API_V2}/order/cancel?order_id=${encodeURIComponent(orderId)}`, {
        headers: getHeaders(accessToken),
        method: "DELETE",
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(json.message || json.errors?.[0]?.message || `Orders Cancellation failed: ${res.status}`);
    }
    
    console.log(json.data);

    return json.data || "";
}
