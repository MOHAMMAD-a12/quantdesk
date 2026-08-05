/**
 * Risk management endpoints.
 *
 * Everything here is scoped to the calling user and derived from their stored
 * preferences. There is no route that sizes a position for someone else, and no
 * route that reports another account's exposure.
 *
 * One design decision runs through the whole module: **nothing here blocks
 * anything.** `POST /check` returns `allowed: false` with reasons; it does not
 * prevent the trade from being journalled, and the journal endpoints do not
 * consult it. That is deliberate. A platform that refuses to record an
 * over-sized trade produces a track record missing exactly the trades the user
 * most needs to review, and a risk tool people route around stops being a risk
 * tool. The control is informational and it is honest about being informational.
 */

import { Router } from 'express';
import { z } from 'zod';
import { positionSizeSchema } from '@quantdesk/shared';
import { ok } from '../../core/http.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { body as bodyOf, queryOf, validate } from '../../middleware/validate.js';
import { authenticate } from '../auth/middleware.js';
import * as service from './service.js';

export const riskRouter = Router();

riskRouter.use(authenticate, rateLimit({ bucket: 'risk' }));

/* -------------------------------------------------------------------------- */
/* Sizing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Position size calculator.
 *
 * `accountBalance` and `riskPercent` are required by the shared schema so the
 * request is self-describing — the same body produces the same answer whoever
 * sends it, which is what makes a sizing result something a user can screenshot
 * and check against their broker.
 *
 * `contractSize` and `tickSize` may be overridden for instruments the symbol
 * table does not carry. When they are not supplied and the symbol is unknown,
 * the result comes back with a warning saying so rather than silently sizing
 * against a generic contract.
 */
const sizeBodySchema = positionSizeSchema.and(
  z.object({
    contractSize: z.number().positive().max(1e9).optional(),
    tickSize: z.number().positive().optional(),
  }),
);

riskRouter.post(
  '/size',
  validate({ body: sizeBodySchema }),
  asyncHandler(async (req, res) => {
    const b = bodyOf(req, sizeBodySchema);

    const result = await service.size(req.user!.id, {
      symbol: b.symbol,
      entryPrice: b.entryPrice,
      stopLoss: b.stopLoss,
      accountBalance: b.accountBalance,
      riskPercent: b.riskPercent,
      ...(b.contractSize !== undefined ? { contractSize: b.contractSize } : {}),
      ...(b.tickSize !== undefined ? { tickSize: b.tickSize } : {}),
    });

    ok(res, result, { warnings: result.warnings.length });
  }),
);

/* -------------------------------------------------------------------------- */
/* Exposure                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where the account stands against its own limits.
 *
 * Daily and weekly windows are bounded in the user's own timezone; see
 * `service.periodBounds` for why that is not a rounding detail.
 */
riskRouter.get(
  '/exposure',
  asyncHandler(async (req, res) => {
    const exposure = await service.current(req.user!.id);
    ok(res, exposure, { breached: exposure.breached });
  }),
);

/**
 * Would this position breach a limit?
 *
 * Evaluated against exposure *including* the proposed trade, which is the only
 * form of the question worth asking: a check that describes the account without
 * the position is a report, not a control.
 */
const checkBodySchema = z
  .object({
    symbol: z.string().trim().toUpperCase().min(1).max(32),
    entryPrice: z.number().positive(),
    stopLoss: z.number().positive().nullable().default(null),
    quantity: z.number().positive(),
  })
  .refine((v) => v.stopLoss === null || v.stopLoss !== v.entryPrice, {
    message: 'Stop loss must differ from entry price',
    path: ['stopLoss'],
  });

riskRouter.post(
  '/check',
  validate({ body: checkBodySchema }),
  asyncHandler(async (req, res) => {
    const b = bodyOf(req, checkBodySchema);

    const result = await service.preTrade(req.user!.id, {
      symbol: b.symbol,
      entryPrice: b.entryPrice,
      stopLoss: b.stopLoss,
      quantity: b.quantity,
    });

    // 200 even when the answer is "not allowed". The check succeeded; the trade
    // is what failed, and returning 4xx for a correctly-computed "no" would make
    // a client's error handler indistinguishable from a real fault.
    ok(res, result, { allowed: result.allowed });
  }),
);

/** Risk still on the table, position by position. */
riskRouter.get(
  '/positions',
  asyncHandler(async (req, res) => {
    const rows = await service.openRisk(req.user!.id);
    const total = rows.reduce((sum, r) => sum + r.riskAmount, 0);
    ok(res, rows, { count: rows.length, totalRisk: Math.round(total * 100) / 100 });
  }),
);

/* -------------------------------------------------------------------------- */
/* Drawdown                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Drawdown monitor.
 *
 * Reads from stored daily equity snapshots, so `durationMs` counts calendar time
 * underwater rather than the gap between trades.
 */
const drawdownQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(3650).default(365),
});

riskRouter.get(
  '/drawdown',
  validate({ query: drawdownQuerySchema }),
  asyncHandler(async (req, res) => {
    const { days } = queryOf(req, drawdownQuerySchema);
    const state = await service.drawdownState(req.user!.id, days);
    ok(res, state, { alerting: state.alerting, windowDays: days });
  }),
);
