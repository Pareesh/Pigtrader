export const sum = (arr) => arr.reduce((a, b) => a + b, 0);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function roundToTick(price, tick = 0.05) {
    return Number((Math.round(price / tick) * tick).toFixed(2));
}

export function getISTTime() {
    const now = new Date();
    const ist = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 5.5 * 3600000);
    const hh = String(ist.getHours()).padStart(2, "0");
    const mm = String(ist.getMinutes()).padStart(2, "0");
    return {
        time: `${hh}:${mm}`,
        date: ist.toISOString().split("T")[0]
    };
}

export function buildWeeklyCandles(dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 10) {
        return [];
    }

    const weeks = [];
    let currentKey = null;
    let bucket = null;

    for (const c of dailyCandles) {
        const d = new Date(c.ts || c.date);
        const day = d.getUTCDay() || 7;
        const monday = new Date(d);
        monday.setUTCDate(d.getUTCDate() - day + 1);
        const key = monday.toISOString().split("T")[0];

        if (key !== currentKey) {
            if (bucket) {
                weeks.push(bucket);
            }
            currentKey = key;
            bucket = {
                date: key,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume
            };
        } else {
            bucket.high = Math.max(bucket.high, c.high);
            bucket.low = Math.min(bucket.low, c.low);
            bucket.close = c.close;
            bucket.volume += c.volume;
        }
    }

    if (bucket) {
        weeks.push(bucket);
    }

    return weeks;
}