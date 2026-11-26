import TimeCache from "../components/TimeCache.js";

const cache = new TimeCache(12*60);

export default async function getNifty200() {
    const cacheKey = "NIFTY_200";
    const nifty200 = cache.getValue(cacheKey);

    if (nifty200) {
        return nifty200;
    }

    const url = 'https://www.niftyindices.com/IndexConstituent/ind_nifty200list.csv';

    const response = await fetch(url, {
        headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/csv,text/plain,*/*'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Nifty 200 CSV: ${response.status} ${response.statusText}`);
    }

    const csvText = await response.text();
    const lines = csvText.trim().split('\n');

    // Skip header row: Company Name,Industry,Symbol,Series,ISIN Code
    const stocks = lines.slice(1).map((line) => {
        // Handle company names that may contain commas inside quotes
        const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((col) =>
            col.replace(/^"|"$/g, '').trim()
        );

        const [companyName, industry, symbol, series, isin] = cols;

        return {
            symbol,
            companyName,
            sector: industry,
            isin,
            instrumentKey: `NSE_EQ|${isin}`
        };
    }).filter((stock) => stock.symbol && stock.isin);

    cache.storeValue(cacheKey, stocks);

    return stocks;
}