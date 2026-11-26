// ============================================================================
// 1. STRATEGY CONFIGURATION (AUTONOMOUS DAILY + WEEKLY ENGINE)
// ============================================================================
const CONFIG = {
    // Capital Allocation
    INTRADAY_CAPITAL_SHARE: 0.25,     // Reserve 25% of free cash for Daily Intraday (MIS)
    CASH_RESERVE_PCT: 0.08,           // Keep 8% liquidity buffer for drawdowns/opportunities

    // Order Value Corridor (Prevents fee-drag on small orders & overexposure on large orders)
    MIN_ORDER_VALUE: 4000,            // Keeps ₹21.83 DP charge <= 0.55% of trade value
    MAX_DELIVERY_ORDER_VALUE: 12000,  // Hard rupee ceiling per new Delivery entry
    MAX_INTRADAY_ORDER_VALUE: 8000,  // Hard rupee ceiling per Intraday trade
    MIN_DELIVERY_SHARES: 4,           // Ensures 50% daily profit harvest can always sell >= 1 share
    MIN_INTRADAY_SHARES: 2,

    RISK_FREE_RATE: 0.065,
    CANDLE_LOOKBACK_DAYS: 400,
    CANDLE_INTRADAY_INTERVALS: 1,
    API_DELAY_MS: 95,
    API_CONCURRENT_LIMIT: 8,

    DEFENSIVE_SECTORS: new Set(["FMCG", "Pharma", "Healthcare", "Utilities", "Power"]),

    ACTIVE_ORDER_STATUSES: new Set([
        "open",
        "pending",
        "trigger pending",
        "validation pending",
        "put order req received",
        "modify pending",
        "after market order req received"
    ]),

    // Weekly / Multi-Week Delivery (CNC / Product 'D') Rules
    DELIVERY: {
        RISK_PER_TRADE_PCT: 0.008,      // Risk 0.8% of total portfolio per new swing entry
        MAX_STOCK_WEIGHT: 0.14,         // Hard cap: 14% of total portfolio in one stock
        NEW_ENTRY_MAX_WEIGHT: 0.10,     // Max 10% initial allocation per new entry
        MAX_SECTOR_WEIGHT: 0.28,        // Max 28% exposure in a single sector
        MAX_CORRELATION: 0.70,          // Reject buys correlated > 0.70 with existing holdings
        MAX_HOLDINGS: 12,
        MAX_NEW_BUYS_PER_RUN: 3,
        MIN_REWARD_TO_CHARGES: 4.0,     // Expected target gain must exceed 4x round-trip fees
        MIN_SCORE_BUY: 70,
        MIN_SCORE_HOLD: 44,
        ATR_STOP_MULT: 2.2,
        HARD_STOP_PCT: -0.06,           // Hard stop-loss floor at -6.0%
        BREAKEVEN_ARM_PCT: 0.03,        // Move stop to cost + fees once up +3.0%
        DAILY_HARVEST_PCT: 0.045,       // Book 50% profit daily when net gain >= +4.5% & momentum peaks
        HARVEST_FRACTION: 0.50,
        TRAIL_ARM_PCT: 0.065,           // Chandelier trailing stop once up +6.5%
        TAKE_PROFIT_TRIM_PCT: 0.25,     // Trim 30% if unrealized gain > 25% & RSI > 75
        TRIM_FRACTION: 0.30,
        SPLIT_GAP_GUARD_PCT: -0.35,      // Flag >35% overnight drop for manual split/bonus check
        ENTRY_START_IST: "09:45",       // Skip opening 30-min noise
        ENTRY_END_IST: "15:10",         // Stop new entries 75 mins before close
    },

    // Daily Intraday (MIS / Product 'I') Rules
    INTRADAY: {
        UNIVERSE_LIMIT: 50,             // Scan 50 highest-turnover names from the Nifty 200 universe
        INTERVAL_MINUTES: 1,
        RISK_PER_TRADE_PCT: 0.0035,     // Risk max 0.35% of total capital per intraday trade
        MAX_DAILY_LOSS_PCT: 0.01,       // Hard daily drawdown circuit breaker at -1.0% MTM loss
        DAILY_PROFIT_LOCK_PCT: 0.018,   // Stop opening new intraday risk once daily profit hits +1.8%
        MAX_OPEN_TRADES: 3,
        MAX_LEVERAGE: 2.0,
        ATR_STOP_MULT: 2.4,             // 2.4x 1-min ATR stop
        ATR_TARGET_MULT: 5.2,           // 5.2x 1-min ATR target (~1 : 2.17 Risk-to-Reward)
        MIN_VOL_SURGE: 1.5,             // Volume must be >= 1.5x rolling 20-min average
        MIN_REWARD_TO_CHARGES: 4.0,     // Target profit must be >= 4x statutory charges
        STALE_ORDER_MINUTES: 15,        // Auto-cancel unfilled intraday entries older than 15 mins
        ENTRY_START_IST: "09:45",       // Skip opening 30-min noise
        ENTRY_END_IST: "14:15",         // Stop new entries 75 mins before close
        SQUARE_OFF_IST: "15:05"         // Exit before 3:15 PM Upstox auto-square-off penalty
    },

    // Indian Statutory & Broker Charges (Upstox)
    CHARGES: {
        DELIVERY_BROKERAGE_MAX: 20,     // min(₹20, 2.5%) per leg
        INTRADAY_BROKERAGE_MAX: 20,     // min(₹20, 0.05%) per leg
        DELIVERY_STT_RATE: 0.001,       // 0.1% on BOTH buy & sell
        INTRADAY_STT_RATE: 0.00025,     // 0.025% on SELL leg only
        NSE_TXN_RATE: 0.0000297,
        SEBI_TURNOVER_RATE: 0.000001,
        DELIVERY_STAMP_RATE: 0.00015,   // 0.015% on buy
        INTRADAY_STAMP_RATE: 0.00003,   // 0.003% on buy
        GST_RATE: 0.18,
        DP_CHARGE_WITH_GST: 21.83       // ₹18.50 + 18% GST on delivery sell
    }
};

export default CONFIG;