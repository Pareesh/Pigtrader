import { execute } from "../strategy/strategy.js";
import config from "../config.js";
import { loadAccessToken } from "./tokenStore.js";
import { getUserProfile } from "./upstox.js";

// ============================================================================
// 1. CONFIGURATION & NSE HOLIDAYS
// ============================================================================
const INTERVAL_MS = 5 * 60 * 1000; // Run every 5 minutes during market hours

// Add official NSE trading holidays (YYYY-MM-DD) for the year
const NSE_HOLIDAYS = new Set([
    "2026-01-26",
    "2026-03-03",
    "2026-03-26",
    "2026-03-31",
    "2026-04-03",
    "2026-04-14",
    "2026-05-01",
    "2026-05-28",
    "2026-06-26",
    "2026-09-14",
    "2026-10-02",
    "2026-10-20",
    "2026-11-10",
    "2026-11-24",
    "2026-12-25"
]);

let isCycleRunning = false;
let lastCompletedDate = null;

// ============================================================================
// 2. IST CLOCK & MARKET SESSION HELPERS
// ============================================================================
function getISTClock() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).formatToParts(now);

    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const date = `${map.year}-${map.month}-${map.day}`;
    const time = `${map.hour}:${map.minute}`;
    const isWeekend = map.weekday === "Sat" || map.weekday === "Sun";
    const isHoliday = NSE_HOLIDAYS.has(date);

    return { date, time, weekday: map.weekday, isWeekend, isHoliday };
}

async function getValidAccessToken() {
    try {
        const token = await loadAccessToken();

        if (!token) {
            throw new Error("Not connected to Upstox. Complete OAuth first.");
        }

        const profile = await getUserProfile(token);

        if (!profile) {
            throw new Error("Re-connect to Upstox.");
        }

        return token
    } catch (e) {
        console.error(e);
    }
}

// ============================================================================
// 3. CONTINUOUS TRADING LOOP
// ============================================================================
async function executeMarketTick() {
    const clock = getISTClock();

    // 1. Skip Weekends and NSE Holidays
    if (clock.isWeekend || clock.isHoliday) {
        return;
    }

    // 2. Pre-Market Reset (09:00 - 09:14 IST)
    if (clock.time >= "09:00" && clock.time < "09:15") {
        if (lastCompletedDate === clock.date) {
            lastCompletedDate = null;
        }
        return;
    }

    // 3. Active Trading Window: 09:16 IST (1 min after open) to 15:22 IST (8 mins before close)
    const isMarketOpen = clock.time >= "09:16" && clock.time <= "15:22";

    if (!isMarketOpen) {
        // Log once after market close each day
        if (clock.time > "15:22" && lastCompletedDate !== clock.date) {
            lastCompletedDate = clock.date;
            console.log(`[${clock.date} ${clock.time} IST] Market closed. Standing by for next trading day.`);
        }
        return;
    }

    // 4. Prevent overlapping executions if API calls take longer than expected
    if (isCycleRunning) {
        console.warn(`[${clock.date} ${clock.time} IST] Previous cycle still running; skipping tick.`);
        return;
    }

    isCycleRunning = true;
    try {
        const accessToken = await getValidAccessToken();

        console.log(`[${clock.date} ${clock.time} IST] Starting Trading Cycle...`);
        
        const report = await execute(accessToken, config.tradingEnabled);

        if (config.tradingEnabled) {
            console.log(
                `[${report.timestampIST} IST] Done | ` +
                `Exits: ${report.plannedOrders.exitOrders.length} | ` +
                `Entries: ${report.plannedOrders.entryOrders.length} | ` +
                `SLs: ${report.plannedOrders.protectiveStopOrders.length} | ` +
                `Intraday PnL: ₹${report.summary.intradayPnL} | ` +
                `Warnings: ${report.warnings}`
            );
        } else {
            console.log(report);
        }
    } catch (err) {
        console.error(`[${clock.date} ${clock.time} IST] Cycle failed:`, err.message);
    } finally {
        isCycleRunning = false;
    }
}

export function startTrading() {
    if (intervalId) {
        return;
    }

    console.log("PigTrader mounted (Market window: 09:16 - 15:22 IST).");
    executeMarketTick();
    intervalId = setInterval(executeMarketTick, TICK_INTERVAL_MS);
}

export function stopTrading() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        console.log("PigTrader stopped.");
    }
}