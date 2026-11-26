export function verifyOrigin(req, res, next) {
    const origin = req.get("Origin");
    const referer = req.get("Referer");
    const allowed = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
        return next();
    }

    const ok =
        (origin && origin === allowed) ||
        (referer && referer.startsWith(allowed)) ||
        config.environment !== "production";

    if (!ok) {
        return res.status(403).json({ error: "Origin not allowed." });
    }
    
    next();
}