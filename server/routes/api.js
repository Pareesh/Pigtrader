import { Router } from 'express';
import { verifyOrigin } from '../middleware/cors.js';
import { verifyUpstoxSession } from '../middleware/upstox.js';
import { getFunds, getPositions, getOrders, getHoldings } from '../service/upstox.js';
import { fetchHistoricalCandles } from '../service/candles.js';
import getNifty200 from '../service/nifty200.js';

export const router = Router();

router.use(verifyOrigin);
router.use(verifyUpstoxSession);

// GET route that returns JSON and maps any failure to a 500 with a friendly message.
const get = (path, errorMessage, fn) =>
    router.get(path, async (req, res) => {
        try {
            res.json(await fn(req));
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: errorMessage });
        }
    });

get("/funds", "Unable to retrieve funds", (req) => getFunds(req.upstoxAccessToken));
get("/positions", "Unable to retrieve positions", (req) => getPositions(req.upstoxAccessToken));
get("/orders", "Unable to retrieve orders", (req) => getOrders(req.upstoxAccessToken));
get("/holdings", "Unable to retrieve holdings", (req) => getHoldings(req.upstoxAccessToken));
get("/candles/:instrumentKey", "Unable to retrieve candles", (req) => fetchHistoricalCandles(req.params.instrumentKey));
get("/nifty200", "Unable to retrieve instruments", () => getNifty200());