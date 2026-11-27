import config from '../config/config.js';

export async function fetchJson(endpoint, options = {}) {
    try {
        console.log(endpoint);
        const response = await fetch(`${endpoint}`, options)
        const payload = await response.json()

        if (!response.ok) {
            throw new Error(payload?.error || response.statusText || 'Request failed')
        }

        return payload;
    } catch(err) {
        console.error(err);
    }
}

export function loadWrapper(callback = () => {}) {
    let errorCount = 0;
    let skip = false;

    const onError = (err) => {
        errorCount++;
        skip = errorCount >= 5;
        console.error(err);
    }

    const onSkip = () => {
        errorCount--;
        skip = errorCount > 0;
    }

    return async (...args) => {
        try {
            return skip ? onSkip() : callback(...args);
        } catch(err) {
            onError(err);
        }
    }
}