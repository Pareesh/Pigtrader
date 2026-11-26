import { Router } from 'express';
import { verifyOrigin } from '../middleware/cors.js';
import { verifyUpstoxSession } from '../middleware/upstox.js';
import { execute } from '../strategy/strategy.js';

export const router = Router();

router.use(verifyOrigin);
router.use(verifyUpstoxSession);

router.get("/fetch", async (req, res) => {
    try {
        const strategies = await execute(req.upstoxAccessToken);
        res.json(strategies);
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to retrieve strategies" });
    }
});

router.get("/execute", async (req, res) => {
    try {
        const strategies = await execute(req.upstoxAccessToken, true);
        res.json(strategies);
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to execute strategies" });
    }
});