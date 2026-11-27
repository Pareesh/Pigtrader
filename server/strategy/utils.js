export const sum = (arr) => arr.reduce((a, b) => a + b, 0);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export function roundToTick(price, tick = 0.05) {
    return Number((Math.round(price / tick) * tick).toFixed(2));
}

// IST wall clock, independent of the server's timezone.
export function getISTTime(date = new Date()) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Kolkata",
            weekday: "short",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        })
            .formatToParts(date)
            .map((p) => [p.type, p.value])
    );

    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`,
        weekday: parts.weekday
    };
}

// Upstox order timestamps look like "2026-11-27 09:20:11" (IST, no zone). Parse them as IST
// so order age is correct whatever timezone the server runs in.
export function parseBrokerTime(ts) {
    if (!ts) {
        return NaN;
    }
    const iso = String(ts).trim().replace(" ", "T");
    return new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}+05:30`).getTime();
}
