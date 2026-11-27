import config from "../config.js";
import { loadAccessToken } from "../service/tokenStore.js";
import { getUserProfile } from '../service/upstox.js';

function required(name, fallback = undefined) {
    const v = process.env[name] ?? fallback;
    if (v === undefined || v === "") {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return v;
}


export function verifyConfiguration(req, res, next) {
    try {
        required("UPSTOX_API_KEY", config.upstox.apiKey);
        required("UPSTOX_API_SECRET", config.upstox.apiSecret);
    } catch(err) {
        res.status(401).json({ error: "Missing Upstox Credentials." });
    }
    next();
}

export async function verifyUpstoxSession(req, res, next) {
    try {
        const token = await loadAccessToken();

        if (!token) {
            return res.status(401).json({ error: "Not connected to Upstox. Complete OAuth first." });
        }

        const profile = await getUserProfile(token);

        if (!profile) {
            return res.status(401).json({ error: "Re-connect to Upstox." });
        }

        req.upstoxAccessToken = token;

        next();
    } catch (e) {
        next(e);
    }
}