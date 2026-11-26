import { Router } from 'express';
import { verifyOrigin } from '../middleware/cors.js';
import { verifyUpstoxSession } from '../middleware/upstox.js';
import { getUserProfile } from '../service/upstox.js';
import { clearAccessToken } from '../service/tokenStore.js';

export const router = Router();

router.use(verifyOrigin);
router.use(verifyUpstoxSession);

router.get("/profile", async (req, res) => {
    try {
        const profile = await getUserProfile(req.upstoxAccessToken);
        return res.json({ profile: profile.data ?? profile });
    } catch {
        return res.json({ profile: null });
    }
});

router.post("/logout", async (req, res) => {
    console.log("logout");
    await clearAccessToken();
    res.json({ ok: true });
});