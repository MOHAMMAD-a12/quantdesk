/**
 * Risk service — the calculator wired to a real account.
 *
 * `calculator.ts` is pure arithmetic and knows nothing about users. This file is
 * the only place that decides *which* numbers to feed it: whose balance, whose
 * limits, which trades count as "today".
 *
 * That last question is the one worth being careful about. A daily risk limit is
 * only meaningful relative to a trading day, and a trading day is not a calendar
 * day in UTC for anyone who does not live in London. Boundaries here are computed
 * in the user's own timezone, taken from their profile — a Sydney trader whose
 * limit resets at 11am local because the server thinks in UTC has a limit that
 * resets in the middle of their session, which is precisely when it should be
 * holding.
 */

import type {
  DrawdownState,
  PositionSizeRequest,
  PositionSizeResult,
  RiskExposure,
  Trade,
} from '@quantdesk/shared';
import { moduleLogger } from '../../core/logger.js';
import { findSymbol, toPublicSymbol } from '../markets/index.js';
import * as portfolio from '../portfolio/repository.js';
import * as preferences from '../preferences/repository.js';
import { findUserById } from '../auth/repository.js';
import {
  checkPreTrade,
  drawdown,
  exposure,
  positionSize,
  tradeRisk,
  type ExposureInput,
  type PreTradeCheck,
} from './calculator.js';

const log = moduleLogger('risk');

/** Fallback when a user's stored timezone is not one Node recognises. */
const FALLBACK_TZ = 'UTC';

/* -------------------------------------------------------------------------- */
/* Trading-day boundaries                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Midnight, and the start of the trading week, in a user's own timezone.
 *
 * Implemented with `Intl.DateTimeFormat` rather than by adding offsets. A fixed
 * offset is wrong twice a year in every DST zone, and being wrong about "today"
 * on the two most volatile mornings of the year is not an acceptable trade for
 * simpler code.
 *
 * The week starts Monday, which is the convention every FX and futures desk
 * uses — a Sunday-start week would put the Sunday-evening crypto session in the
 * previous week's budget.
 */
export function periodBounds(timezone: string, now: number = Date.now()): {
  dayStart: number;
  weekStart: number;
} {
  const tz = safeZone(timezone);
  const parts = zonedParts(now, tz);

  // Local midnight expressed as an instant: take the local wall-clock time, then
  // subtract however far into the day it is.
  const msIntoDay =
    parts.hour * 3_600_000 + parts.minute * 60_000 + parts.second * 1000 + (now % 1000);
  const dayStart = now - msIntoDay;

  // `weekday` is 0 for Sunday; shift so Monday is 0.
  const sinceMonday = (parts.weekday + 6) % 7;
  const weekStart = dayStart - sinceMonday * 86_400_000;

  return { dayStart, weekStart };
}

function safeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    // A bad timezone must not stop the risk check from running — falling back to
    // UTC gives a boundary that is wrong by hours, whereas throwing gives no
    // limit enforcement at all.
    log.warn({ timezone }, 'Unknown timezone; falling back to UTC');
    return FALLBACK_TZ;
  }
}

function zonedParts(
  at: number,
  timeZone: string,
): { hour: number; minute: number; second: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = new Map(formatter.formatToParts(new Date(at)).map((p) => [p.type, p.value]));

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = Math.max(0, days.indexOf(parts.get('weekday') ?? 'Sun'));

  // `hour12: false` yields 24 rather than 0 for midnight in some ICU versions.
  const hour = Number(parts.get('hour') ?? '0') % 24;

  return {
    hour,
    minute: Number(parts.get('minute') ?? '0'),
    second: Number(parts.get('second') ?? '0'),
    weekday,
  };
}

/* -------------------------------------------------------------------------- */
/* Exposure                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Gather everything the exposure calculation needs for one user.
 *
 * Kept separate from {@link current} so the pre-trade check can reuse the exact
 * same inputs: a "would this be allowed" answer computed from a different
 * snapshot than the "where do I stand" figure beside it on screen is a bug the
 * user will read as the platform contradicting itself.
 */
async function gather(userId: string, now: number = Date.now()): Promise<ExposureInput> {
  const [prefs, user] = await Promise.all([preferences.get(userId), findUserById(userId)]);
  const { dayStart, weekStart } = periodBounds(user?.timezone ?? FALLBACK_TZ, now);

  const [openTrades, closedThisWeek] = await Promise.all([
    portfolio.openPositions(userId),
    portfolio.closedTrades(userId, weekStart, now),
  ]);

  // Today's trades are filtered out of the week's rather than fetched again —
  // one query, and the two windows cannot drift apart between round-trips.
  const closedToday = closedThisWeek.filter((t) => (t.closedAt ?? t.openedAt) >= dayStart);

  return { preferences: prefs, openTrades, closedToday, closedThisWeek };
}

export async function current(userId: string, now: number = Date.now()): Promise<RiskExposure> {
  return exposure(await gather(userId, now));
}

export interface PreTradeRequest {
  symbol: string;
  entryPrice: number;
  stopLoss: number | null;
  quantity: number;
}

/**
 * Whether a proposed position may be opened.
 *
 * The order matters: the projected exposure is computed *including* the proposed
 * trade, so the answer accounts for the position being added rather than
 * describing the account as it stands without it.
 */
export async function preTrade(
  userId: string,
  proposed: PreTradeRequest,
  now: number = Date.now(),
): Promise<PreTradeCheck & { riskAmount: number }> {
  const input = await gather(userId, now);
  const check = checkPreTrade(input, proposed);

  const riskAmount =
    proposed.stopLoss === null
      ? 0
      : Math.abs(proposed.entryPrice - proposed.stopLoss) * proposed.quantity;

  return { ...check, riskAmount: round(riskAmount, 2) };
}

/* -------------------------------------------------------------------------- */
/* Sizing                                                                     */
/* -------------------------------------------------------------------------- */

export interface SizeRequest extends Omit<PositionSizeRequest, 'accountBalance' | 'riskPercent'> {
  /** Override the stored balance — for "what if I had £X" experiments. */
  accountBalance?: number;
  /** Override the stored per-trade risk percentage. */
  riskPercent?: number;
}

/**
 * Size a position against the user's stored balance and risk appetite.
 *
 * Both are overridable, because the calculator is also a scratchpad: a trader
 * sizing a position for a second account, or asking what a 0.5% risk would look
 * like, should not have to edit their saved preferences to get an answer.
 *
 * The *stored* values are the defaults, though. A calculator that requires the
 * balance to be typed every time gets a typo eventually, and a typo here is a
 * position size off by an order of magnitude.
 */
export async function size(userId: string, req: SizeRequest): Promise<PositionSizeResult> {
  const prefs = await preferences.get(userId);
  const record = await findSymbol(req.symbol);

  const balance = req.accountBalance ?? prefs.accountBalance;
  const riskPercent = req.riskPercent ?? prefs.riskPerTradePercent;

  const result = positionSize(
    {
      ...req,
      accountBalance: balance,
      riskPercent,
    },
    record ? toPublicSymbol(record) : null,
  );

  if (balance <= 0) {
    result.warnings.push(
      'Your account balance is not set, so this size is meaningless. Set it in preferences before sizing a position.',
    );
  }

  if (riskPercent > prefs.riskPerTradePercent) {
    result.warnings.push(
      `This uses ${riskPercent}% risk, above the ${prefs.riskPerTradePercent}% you have configured.`,
    );
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Drawdown                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Drawdown against the alert threshold.
 *
 * Sourced from stored daily snapshots, not from the trade history. A curve
 * derived from trades has a point only where a trade closed, and `durationMs` —
 * how long the user has been underwater, which is the number that decides
 * whether a strategy is psychologically survivable — would then measure the gap
 * between trades rather than the length of the drawdown.
 */
export async function drawdownState(
  userId: string,
  days = 365,
  now: number = Date.now(),
): Promise<DrawdownState> {
  const [prefs, snapshots] = await Promise.all([
    preferences.get(userId),
    portfolio.equityCurve(userId, days),
  ]);

  // The alert level is derived from the weekly limit rather than configured
  // separately: a user who accepts losing 6% in a week has already told us what
  // "concerning" means to them, and a second number to keep in sync is a second
  // number to get wrong.
  const threshold = prefs.maxWeeklyRiskPercent * 2;

  return drawdown({
    curve: snapshots.map((s) => ({ time: s.time, equity: s.equity })),
    alertThresholdPercent: threshold,
    now,
  });
}

/* -------------------------------------------------------------------------- */
/* Per-position risk                                                          */
/* -------------------------------------------------------------------------- */

/** Risk still on the table, position by position. */
export async function openRisk(
  userId: string,
): Promise<Array<{ trade: Trade; riskAmount: number; riskPercent: number }>> {
  const [prefs, open] = await Promise.all([
    preferences.get(userId),
    portfolio.openPositions(userId),
  ]);

  const balance = prefs.accountBalance;

  return open.map((trade) => {
    const riskAmount = tradeRisk(trade);
    return {
      trade,
      riskAmount: round(riskAmount, 2),
      riskPercent: balance > 0 ? round((riskAmount / balance) * 100, 2) : 0,
    };
  });
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
