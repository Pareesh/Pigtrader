// ============================================================================
// STRATEGY CONFIGURATION
// ============================================================================
const CONFIG = {
    // Capital allocation
    INTRADAY_CAPITAL_SHARE: 0.25,     // Share of total value reserved for intraday (MIS)
    CASH_RESERVE_PCT: 0.08,           // Liquidity buffer never deployed into new delivery buys

    // Data & order hygiene
    CANDLE_LOOKBACK_DAYS: 400,
    API_CONCURRENT_LIMIT: 5,
    STALE_ORDER_MINUTES: 4,           // Our unfilled entry/exit LIMIT orders older than this are cancelled & re-planned
    SL_LIMIT_BUFFER: 0.006,           // SL limit price sits 0.6% beyond the trigger so a fast move still fills
    STOP_REPLACE_PCT: 0.004,          // Re-place a broker SL only when the new stop is >= 0.4% tighter
    TERMINAL_ORDER_STATUSES: new Set(["complete", "rejected", "cancelled"]),

    // Delivery (CNC / product 'D'): trend-following swing positions in Nifty 200 leaders
    DELIVERY: {
        // Sizing & limits
        RISK_PER_TRADE_PCT: 0.008,    // Risk 0.8% of total value per new entry
        MAX_STOCK_WEIGHT: 0.14,
        NEW_ENTRY_MAX_WEIGHT: 0.10,
        MAX_SECTOR_WEIGHT: 0.28,
        MAX_CORRELATION: 0.70,
        MAX_HOLDINGS: 12,
        MAX_NEW_BUYS_PER_DAY: 2,      // Fewer, better entries: each round trip costs ~1% in fees at this size
        MIN_ORDER_VALUE: 7000,        // Below this, brokerage + DP charge exceed ~1.2% round trip
        MAX_ORDER_VALUE: 12000,
        MIN_SHARES: 2,
        MIN_TRIM_VALUE: 4000,         // Never place a partial sell smaller than this (fixed fees dominate)

        // Entry filters (evaluated on completed daily candles)
        MIN_RS_PERCENTILE: 70,        // Top 30% of the universe by 3M/6M momentum relative to Nifty
        MIN_ADX: 18,
        MIN_RSI: 42,
        MAX_RSI: 68,
        MAX_EXTENSION_ATR: 2.0,       // Do not chase: price must be within 2 ATR of the 20-EMA
        NEAR_52W_HIGH: 0.85,          // Leaders only: within 15% of the 52-week high
        MAX_GAP_UP_PCT: 0.03,         // Skip if today's price is >3% above yesterday's close

        // Risk & exits
        ATR_STOP_MULT: 2.2,
        MIN_STOP_PCT: 0.035,
        MAX_STOP_PCT: 0.08,
        REWARD_RISK: 2.5,             // Only used for the fee-feasibility check at entry
        MIN_REWARD_TO_CHARGES: 4.0,
        BREAKEVEN_ARM_PCT: 0.03,      // Peak >= +3%: stop moves to cost + fees
        TRAIL_ARM_PCT: 0.065,         // Peak >= +6.5%: chandelier trail (peak - 2.2 ATR)
        CLIMAX_GAIN_PCT: 0.15,        // One-time 50% trim when up >= 15% AND price is parabolic
        CLIMAX_FRACTION: 0.50,
        SPLIT_GAP_GUARD_PCT: -0.35,   // >35% overnight drop: flag for manual split/bonus review

        ENTRY_START_IST: "09:45",
        ENTRY_END_IST: "15:10",
        LAST_STOP_SYNC_IST: "15:15"
    },

    // Intraday (MIS / product 'I'): 5-minute opening-range breakouts & VWAP pullbacks
    INTRADAY: {
        ENABLED: true,
        UNIVERSE_LIMIT: 50,           // Most liquid Nifty 200 names
        RISK_PER_TRADE_PCT: 0.0035,
        MAX_DAILY_LOSS_PCT: 0.01,
        DAILY_PROFIT_LOCK_PCT: 0.018,
        MAX_OPEN_TRADES: 3,
        MAX_TRADES_PER_DAY: 6,        // Distinct instruments traded today (stops fee-churn)
        MAX_LEVERAGE: 2.0,
        MIN_ORDER_VALUE: 4000,
        MAX_ORDER_VALUE: 8000,
        MIN_SHARES: 2,

        STOP_ATR_MULT: 1.8,           // Stop = 1.8 x 5-minute ATR
        MIN_STOP_PCT: 0.006,          // Reject stocks too quiet to pay for fees (~0.27% round trip)
        MAX_STOP_PCT: 0.012,          // Reject stocks too wild to size sensibly
        REWARD_RISK: 2.2,
        MIN_RVOL: 1.3,                // Cumulative volume vs median of the same clock time over past sessions
        MIN_REL_STRENGTH: 0.002,      // Stock must beat (long) / lag (short) Nifty by 0.2% on the day
        MIN_REWARD_TO_CHARGES: 4.0,
        MAX_HOLD_MINUTES: 120,        // Exit dead trades (< 0.5R) after 2 hours
        FALLBACK_STOP_PCT: 0.008,     // Stop for positions opened before a restart (plan lost from memory)

        ENTRY_START_IST: "09:45",
        ENTRY_END_IST: "14:15",
        SQUARE_OFF_IST: "15:05"
    },

    // Indian statutory & broker charges (Upstox rate card)
    CHARGES: {
        DELIVERY_BROKERAGE_MAX: 20,
        DELIVERY_BROKERAGE_RATE: 0.025,
        INTRADAY_BROKERAGE_MAX: 20,
        INTRADAY_BROKERAGE_RATE: 0.001, // min(Rs 20, 0.1%) per executed order
        DELIVERY_STT_RATE: 0.001,       // Both legs
        INTRADAY_STT_RATE: 0.00025,     // Sell leg only
        NSE_TXN_RATE: 0.0000297,
        SEBI_TURNOVER_RATE: 0.000001,
        DELIVERY_STAMP_RATE: 0.00015,   // Buy leg
        INTRADAY_STAMP_RATE: 0.00003,   // Buy leg
        GST_RATE: 0.18,
        DP_CHARGE_WITH_GST: 23.6        // Rs 20 + 18% GST per scrip on delivery sells. Adjust to your contract note.
    }
};

export default CONFIG;