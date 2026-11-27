import { execute } from "../strategy/strategy.js";
import config from "../config.js";
import { loadAccessToken } from "./tokenStore.js";
import { getISTTime } from "../strategy/utils.js";

// Official NSE trading holidays (YYYY-MM-DD). Verify against the NSE circular and extend yearly.
const NSE_HOLIDAYS = new Set([
    "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03",
    "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14",
    "2026-10-02", "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25"
]);

const INTERVAL_MS = 5 * 60 * 1000;   // Signals use completed 5-minute bars, so run once per bar
const BAR_SETTLE_MS = 10 * 1000;      // Let the exchange feed publish the just-closed bar
const MARKET_FIRST_TICK = "09:16";
const MARKET_LAST_TICK = "15:22";

let timer = null;

function isTradingWindow({ date, time, weekday }) {
    if (weekday === "Sat" || weekday === "Sun" || NSE_HOLIDAYS.has(date)) {
        return false;
    }
    return time >= MARKET_FIRST_TICK && time <= MARKET_LAST_TICK;
}

async function tick() {
    const clock = getISTTime();
    if (!isTradingWindow(clock)) {
        return;
    }

    const stamp = `[${clock.date} ${clock.time} IST]`;
    try {
        const accessToken = await loadAccessToken();
        if (!accessToken) {
            console.warn(`${stamp} Not connected to Upstox. Complete OAuth first.`);
            return;
        }

        const report = await execute(accessToken, config.tradingEnabled);
        const { exitOrders, entryOrders, protectiveStopOrders } = report.plannedOrders;
        console.log(
            `${stamp} ${report.mode} | Exits: ${exitOrders.length} | Entries: ${entryOrders.length} | ` +
            `SLs: ${protectiveStopOrders.length} | Intraday PnL: ₹${report.summary.intradayPnL}` +
            (report.warnings.length ? ` | Warnings: ${report.warnings.join(" ; ")}` : "")
        );
    } catch (err) {
        console.error(`${stamp} Cycle failed:`, err.message);
    }
}

// Fire just after each 5-minute boundary (09:20:10, 09:25:10, ...). IST is a whole multiple of 5 minutes from UTC.
function scheduleNext() {
    const delay = INTERVAL_MS - (Date.now() % INTERVAL_MS) + BAR_SETTLE_MS;
    timer = setTimeout(async () => {
        await tick();
        if (timer) {
            scheduleNext();
        }
    }, delay);
}

export function startTrading() {
    if (timer) {
        return;
    }

    console.log(`PigTrader mounted (market window: ${MARKET_FIRST_TICK} - ${MARKET_LAST_TICK} IST, every 5 min).`);
    scheduleNext();
    tick();
}

export function stopTrading() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
        console.log("PigTrader stopped.");
    }
}