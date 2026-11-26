const MINUTE_IN_MS = 60000;

export default class TimeCache {
    #invalidationTime
    #map

    // invalidation time in minutes
    constructor(invalidationTime) {
        if (!invalidationTime) {
            throw new Error("Invalidation Time required");
        }

        this.#invalidationTime = invalidationTime;
        this.#map = new Map();
    }

    // return false when differnce between two time is less than invalidate time
    #compareTime(t1, t2) {
        const d1 = new Date(t1);
        const d2 = new Date(t2);

        return d1.getFullYear() !== d2.getFullYear() ||
            d1.getMonth() !== d2.getMonth() ||
            d1.getDate() !== d2.getDate() ||
            (t1 - t2 >= (MINUTE_IN_MS * this.#invalidationTime));
    }

    hasValue(key) {
        if (!key) {
            return false;
        }
        
        const result = this.#map.get(key);

        if (!result || !result.time || !result.value) {
            return false;
        }

        if(this.#compareTime(Date.now(), result.time)) {
            return false;
        }

        return true;
    }

    getValue(key) {
        if (this.hasValue(key)) {
            return this.#map.get(key).value;
        }
        return undefined;
    }

    storeValue(key, value) {
        if (!key || !value) {
            return false;
        }

        this.#map.set(key, {
            value: value,
            time: Date.now()
        });

        return true;
    }
}