import zlib from "zlib";
import { promisify } from "util";

const gunzip = promisify(zlib.gunzip);
const instrumentsMap = new Map();
const NSE_INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

function isIntrumentsStale(key) {
    if (!key) {
        return true;
    }
    
    const value = instrumentsMap.get(key);

    if (!value || !value.time || !value.data) {
        return true;
    }

    if((new Date()).getTime() - value.time >= 43200000) {
        return true;
    }

    return false;
}

export async function getAllNseEqInstruments() {
    const cacheKey = "NSE_EQ";

    if (!isIntrumentsStale(cacheKey)) {
        return instrumentsMap.get(cacheKey).data;
    }

    const res = await fetch(NSE_INSTRUMENTS_URL);
    
    if (!res.ok) {
        throw new Error(`Failed to fetch NSE instruments: ${res.status} ${res.statusText}`);
    }

    const compressedBuffer = Buffer.from(await res.arrayBuffer());
    const decompressedBuffer = await gunzip(compressedBuffer);
    const instruments = JSON.parse(decompressedBuffer.toString("utf-8"));

    // Filter strictly for NSE Equity (segment: "NSE_EQ", instrument_type: "EQ")
    const nseEqList = instruments
        .filter((item) => item.segment === "NSE_EQ" && item.instrument_type === "EQ")
        .map((item) => ({
            symbol: item.trading_symbol,
            name: item.name,
            isin: item.isin,
            instrument_key: item.instrument_key, // e.g., "NSE_EQ|INE002A01018"
            lot_size: item.lot_size,
            tick_size: item.tick_size,
            freeze_quantity: item.freeze_quantity
        }));

    

    const list = nseEqList.map((nseEq) => {
        return {
            "symbol": nseEq.symbol,
            "name": nseEq.name,
            "instrument_key": nseEq.instrument_key
        }
    });

    instrumentsMap.set(cacheKey, {
        data: list,
        time: (new Date()).getTime()
    });

    return list;
}