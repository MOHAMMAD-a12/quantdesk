/**
 * Position sizing and risk exposure — pure arithmetic, no I/O.
 *
 * Every function here is deterministic and side-effect free, which is deliberate:
 * these are the numbers that decide how much of someone's account is exposed on
 * a trade, and a sizing routine that reads a cache or calls a provider cannot be
 * exhaustively tested. Callers fetch the inputs; this module only computes.
 *
 * The sizing formula itself is the standard one —
 *
 *   quantity = (balance × risk%) ÷ (|entry − stop| × contractSize)
 *
 * — but the details around it are what make it correct per asset class. A
 * "position size" means a different unit for each: coins for crypto, lots for FX,
 * shares for equities, contracts for a commodity future. Returning one number
 * labelled "size" and letting the caller guess is how a trader ends up with a
 * hundred-thousand-unit FX position they meant to be one lot.
 */

import type {
  AssetClass,
  MarketSymbol,
  PositionSizeRequest,
  PositionSizeResult,
  RiskExposure,
  Trade,
  UserPreferences,
} from '@quantdesk/shared';

/**
 * Leverage above which a position is flagged.
 *
 * Not a hard block — an operator cannot know that a 30× position is wrong for a
 * given account, and a calculator that refuses to answer is a calculator people
 * stop using. But a stop this tight relative to balance is far more often a
 * mis-entered decimal place than an intention, and saying so costs nothing.
 */
const LEVERAGE_WARNING = 20;

/** Stop distances below this fraction of price are almost certainly a typo. */
const MIN_STOP_FRACTION = 0.0002; // 2 basis points.

/**
 * Compute a position size.
 *
 * The instrument's own `contractSize` and `tickSize` are used unless the caller
 * overrides them, because sizing against a wrong contract size is silently wrong
 * by exactly that factor — and a factor-of-100,000 error on an FX position is not
 * a rounding difference, it is a margin call.
 */
export function positionSize(
  req: PositionSizeRequest,
  instrument: MarketSymbol | null,
): PositionSizeResult {
  const warnings: string[] = [];

  const contractSize = req.contractSize ?? instrument?.contractSize ?? 1;
  const tickSize = req.tickSize ?? instrument?.tickSize ?? 0.01;

  if (!instrument) {
    warnings.push(
      'This instrument is not in our symbol table, so contract and tick size fall back to generic values. Verify the result against your broker.',
    );
  }

  const riskAmount = req.accountBalance * (req.riskPercent / 100);
  const stopDistance = Math.abs(req.entryPrice - req.stopLoss);

  // Guarded rather than allowed to produce Infinity: a zero stop distance means
  // the caller's stop is at entry, and the honest answer is a warning and a zero
  // size, not a position of unbounded magnitude.
  if (stopDistance === 0) {
    return {
      riskAmount,
      stopDistance: 0,
      stopDistanceTicks: 0,
      quantity: 0,
      lots: 0,
      notional: 0,
      leverage: 0,
      warnings: [...warnings, 'Stop loss is at the entry price — there is no risk distance to size against.'],
    };
  }

  if (stopDistance / req.entryPrice < MIN_STOP_FRACTION) {
    warnings.push(
      'The stop is within two basis points of entry. Check for a mistyped decimal — this size will be very large.',
    );
  }

  const quantity = riskAmount / (stopDistance * contractSize);
  const notional = quantity * contractSize * req.entryPrice;
  const leverage = req.accountBalance > 0 ? notional / req.accountBalance : 0;

  if (leverage > LEVERAGE_WARNING) {
    warnings.push(
      `This position is ${leverage.toFixed(1)}× your account balance. Confirm your broker permits it and that the stop is correct.`,
    );
  }

  if (req.riskPercent > 5) {
    warnings.push(
      `Risking ${req.riskPercent}% on one trade is well above the 1–2% a professional risk framework allows.`,
    );
  }

  // `lots` is the FX-native unit; for crypto and equities contractSize is 1 and
  // the two numbers coincide, which is correct rather than redundant.
  const lots = quantity;

  return {
    riskAmount: round(riskAmount, 2),
    stopDistance: round(stopDistance, 10),
    stopDistanceTicks: tickSize > 0 ? Math.round(stopDistance / tickSize) : 0,
    quantity: roundQuantity(quantity, instrument?.assetClass ?? 'crypto'),
    lots: round(lots, 2),
    notional: round(notional, 2),
    leverage: round(leverage, 2),
    warnings,
  };
}

/**
 * Round a size to something the venue will accept.
 *
 * Rounded **down**, always. Rounding a size up increases risk beyond what the
 * user asked for, which is the one direction a risk tool must never err in.
 */
function roundQuantity(quantity: number, assetClass: AssetClass): number {
  switch (assetClass) {
    case 'stock':
    case 'index':
      // Fractional shares exist but are not universal; whole shares are the safe
      // assumption, and a size that rounds to zero is information.
      return Math.floor(quantity);
    case 'forex':
      // Micro-lot precision.
      return floorTo(quantity, 2);
    case 'commodity':
      return floorTo(quantity, 2);
    case 'crypto':
    default:
      return floorTo(quantity, 8);
  }
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/* -------------------------------------------------------------------------- */
/* Exposure                                                                   */
/* -------------------------------------------------------------------------- */

/** Risk still on the table for one open trade, in account currency. */
export function tradeRisk(trade: Trade): number {
  if (trade.stopLoss === null) return 0;
  return Math.abs(trade.entryPrice - trade.stopLoss) * trade.quantity;
}

export interface ExposureInput {
  preferences: UserPreferences;
  openTrades: Trade[];
  /** Trades closed since the start of the user's trading day. */
  closedToday: Trade[];
  /** Trades closed since the start of the trading week. */
  closedThisWeek: Trade[];
}

/**
 * Evaluate a user's rolling risk against their own limits.
 *
 * Daily and weekly usage counts **realised losses plus open risk**, not gross
 * turnover. The question a daily risk limit answers is "how much of my account
 * can today take from me", and a day of three winning trades has consumed none
 * of that budget — while a day of two losers and one open position at full stop
 * has consumed all three.
 *
 * Wins are deliberately not netted against losses. A limit that resets itself
 * every time a trade goes right is a limit that stops working precisely during
 * the volatile session where it matters, and "I'm up on the day so I can risk
 * more" is the reasoning it exists to interrupt.
 */
export function exposure(input: ExposureInput): RiskExposure {
  const { preferences: prefs, openTrades, closedToday, closedThisWeek } = input;
  const balance = prefs.accountBalance;

  const openRisk = openTrades.reduce((sum, t) => sum + tradeRisk(t), 0);
  const lostToday = realisedLoss(closedToday);
  const lostThisWeek = realisedLoss(closedThisWeek);

  const pct = (amount: number): number => (balance > 0 ? (amount / balance) * 100 : 0);

  const openRiskPercent = pct(openRisk);
  const dailyUsed = pct(lostToday + openRisk);
  const weeklyUsed = pct(lostThisWeek + openRisk);

  const breaches: string[] = [];

  if (dailyUsed > prefs.maxDailyRiskPercent) {
    breaches.push(
      `Daily risk of ${dailyUsed.toFixed(2)}% exceeds your ${prefs.maxDailyRiskPercent}% limit.`,
    );
  }
  if (weeklyUsed > prefs.maxWeeklyRiskPercent) {
    breaches.push(
      `Weekly risk of ${weeklyUsed.toFixed(2)}% exceeds your ${prefs.maxWeeklyRiskPercent}% limit.`,
    );
  }
  if (openTrades.length > prefs.maxConcurrentTrades) {
    breaches.push(
      `${openTrades.length} positions are open against a limit of ${prefs.maxConcurrentTrades}.`,
    );
  }

  // Reported separately from the limits above: a position with no stop has
  // unbounded risk, so it makes every percentage on this object an understatement
  // and the user needs to know the number is incomplete.
  const unstopped = openTrades.filter((t) => t.stopLoss === null).length;
  if (unstopped > 0) {
    breaches.push(
      `${unstopped} open position${unstopped === 1 ? ' has' : 's have'} no stop loss, so the risk figures below are understated.`,
    );
  }

  return {
    userId: prefs.userId,
    accountBalance: balance,
    openRiskPercent: round(openRiskPercent, 2),
    dailyRiskUsedPercent: round(dailyUsed, 2),
    weeklyRiskUsedPercent: round(weeklyUsed, 2),
    dailyLimitPercent: prefs.maxDailyRiskPercent,
    weeklyLimitPercent: prefs.maxWeeklyRiskPercent,
    openPositions: openTrades.length,
    maxConcurrentTrades: prefs.maxConcurrentTrades,
    breached: breaches.length > 0,
    breaches,
  };
}

/** Sum of realised losses, as a positive number. Wins contribute nothing. */
function realisedLoss(trades: Trade[]): number {
  return trades.reduce((sum, t) => {
    const pnl = t.pnl ?? 0;
    return pnl < 0 ? sum + Math.abs(pnl) : sum;
  }, 0);
}

/**
 * Whether a proposed trade would breach a limit, evaluated *before* it is opened.
 *
 * Separate from {@link exposure} because the two answer different questions.
 * `exposure` describes where the account stands; this decides whether one more
 * position is allowed — and a check performed after the position is already open
 * is a report, not a control.
 */
export interface PreTradeCheck {
  allowed: boolean;
  reasons: string[];
  /** Exposure as it would stand if the trade were opened. */
  projected: RiskExposure;
}

export function checkPreTrade(
  input: ExposureInput,
  proposed: { entryPrice: number; stopLoss: number | null; quantity: number },
): PreTradeCheck {
  const synthetic: Trade = {
    id: 'proposed',
    userId: input.preferences.userId,
    symbol: 'PROPOSED',
    side: 'long',
    status: 'open',
    entryPrice: proposed.entryPrice,
    quantity: proposed.quantity,
    stopLoss: proposed.stopLoss,
    takeProfit: null,
    exitPrice: null,
    pnl: null,
    pnlPercent: null,
    rMultiple: null,
    fees: 0,
    openedAt: 0,
    closedAt: null,
    signalId: null,
    notes: null,
    tags: [],
    executionRating: null,
    screenshotUrl: null,
  };

  const projected = exposure({ ...input, openTrades: [...input.openTrades, synthetic] });

  return {
    allowed: !projected.breached,
    reasons: projected.breaches,
    projected,
  };
}

/* -------------------------------------------------------------------------- */
/* Drawdown                                                                   */
/* -------------------------------------------------------------------------- */

export interface DrawdownInput {
  /** Equity samples, oldest first. */
  curve: Array<{ time: number; equity: number }>;
  alertThresholdPercent: number;
  now?: number;
}

/**
 * Current drawdown against the running equity peak.
 *
 * The peak is the highest equity ever reached, not the highest in a window. A
 * drawdown measured against a rolling high resets itself after a long enough
 * flat period and reports a recovery that never happened.
 */
export function drawdown(input: DrawdownInput): {
  peakEquity: number;
  currentEquity: number;
  drawdownPercent: number;
  drawdownAmount: number;
  durationMs: number;
  alertThresholdPercent: number;
  alerting: boolean;
} {
  const now = input.now ?? Date.now();
  const { curve } = input;

  if (curve.length === 0) {
    return {
      peakEquity: 0,
      currentEquity: 0,
      drawdownPercent: 0,
      drawdownAmount: 0,
      durationMs: 0,
      alertThresholdPercent: input.alertThresholdPercent,
      alerting: false,
    };
  }

  let peak = curve[0]?.equity ?? 0;
  let peakTime = curve[0]?.time ?? now;

  for (const point of curve) {
    if (point.equity > peak) {
      peak = point.equity;
      peakTime = point.time;
    }
  }

  const current = curve[curve.length - 1]?.equity ?? peak;
  const amount = Math.max(0, peak - current);
  const percent = peak > 0 ? (amount / peak) * 100 : 0;

  return {
    peakEquity: round(peak, 2),
    currentEquity: round(current, 2),
    drawdownPercent: round(percent, 2),
    drawdownAmount: round(amount, 2),
    // Zero while at a new high: a drawdown that has not started has no duration.
    durationMs: amount > 0 ? Math.max(0, now - peakTime) : 0,
    alertThresholdPercent: input.alertThresholdPercent,
    alerting: percent >= input.alertThresholdPercent,
  };
}
