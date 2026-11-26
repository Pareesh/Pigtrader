import { Router } from 'express';
import { verifyOrigin } from '../middleware/cors.js';
import { verifyUpstoxSession } from '../middleware/upstox.js';
import { startTrading, stopTrading } from '../service/schedule.js';

export const router = Router();

router.use(verifyOrigin);
router.use(verifyUpstoxSession);

router.get("/start", async (req, res) => {
    try {
        startTrading();
        res.json({ ok: true });
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to start Trading" });
    }
});

router.get("/stop", async (req, res) => {
    try {
        stopTrading();
        res.json({ ok: true });
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to stop trading" });
    }
});