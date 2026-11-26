import { Router } from 'express';
import { verifyOrigin } from '../middleware/cors.js';
import { verifyUpstoxSession } from '../middleware/upstox.js';
import { getFunds, getPositions, getOrders, getHoldings } from '../service/upstox.js';
import { execute } from '../strategy/strategy.js';
import { getHistoricalCandles } from '../service/candles.js';
import { getAllNseEqInstruments } from '../service/instruments.js';

export const router = Router();

router.use(verifyOrigin);
router.use(verifyUpstoxSession);

router.get("/funds", async (req, res) => {
    try {
        const funds = await getFunds(req.upstoxAccessToken);
        res.json(funds);
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to retrieve funds" });
    }
});

router.get("/positions", async (req, res) => {
    try {
        const positions = await getPositions(req.upstoxAccessToken);  
        res.json(positions);
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to retrieve positions" });
    }
});

router.get("/orders", async (req, res) => {
    try {
        const orders = await getOrders(req.upstoxAccessToken);
        res.json(orders);
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to retrieve orders" });
    }
});

router.get("/strategy", async (req, res) => {
    try {
        const strategies = await execute(req.upstoxAccessToken, true);
        res.json(strategies);
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to retrieve strategies" });
    }
});

router.get("/holdings", async (req, res) => {
    try {
        const holdings = await getHoldings(req.upstoxAccessToken);  
        res.json(holdings);
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to retrieve holdings" });
    }
});

router.get("/candles/:instrumentKey", async (req, res) => {
    try {
        const { instrumentKey } = req.params;

        const candles = await getHistoricalCandles(instrumentKey);  
        res.json(candles);
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to retrieve candles" });
    }
});

router.get("/allnseeqinstruments", async (req, res) => {
    try {
        const allnseeqinstruments = await getAllNseEqInstruments(); 
        console.log(allnseeqinstruments.length); 
        res.json(allnseeqinstruments);
    } catch (e) {
        console.log(e);
        res.status(500).json({ error: "Unable to retrieve intruments" });
    }
});