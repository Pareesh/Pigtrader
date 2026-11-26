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