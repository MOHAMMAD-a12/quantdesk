/**
 * The Express application.
 *
 * Assembly only — no route logic and no listening socket. Keeping `createApp`
 * free of `listen()` is what lets a test build the whole app in-process, and what
 * lets `server.ts` own the HTTP server that the WebSocket hub needs to attach to.
 *
 * **Middleware order is load-bearing.** Each layer here depends on the one above
 * it having already run, and the failure mode of getting it wrong is usually
 * silent rather than loud:
 *
 *   1. `trust proxy`   — every subsequent IP read is wrong without it.
 *   2. `requestId`     — the logger and every error envelope reference it.
 *   3. `httpLogger`    — must see the request before a handler can end it.
 *   4. security/CORS   — a rejected preflight must never reach a route.
 *   5. body parsers    — a route cannot read a body nobody parsed.
 *   6. `csrfProtection`— needs the parsed method and headers, nothing more.
 *   7. routers
 *   8. `notFoundHandler`, then `errorHandler` — last, and in that order.
 */

import express, { type Express, type Request, type Response } from 'express';
import compression from 'compression';
import { config } from './core/config.js';
import { ok } from './core/http.js';
import { moduleLogger } from './core/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { httpLogger, requestId } from './middleware/requestContext.js';
import { corsMiddleware, csrfProtection, securityHeaders } from './middleware/security.js';
import { adminRouter } from './modules/admin/index.js';
import { analysisRouter } from './modules/analysis/index.js';
import { authRouter } from './modules/auth/index.js';
import { imagesRouter } from './modules/images/index.js';
import { marketsRouter } from './modules/markets/index.js';
import { newsRouter } from './modules/news/index.js';
import { notificationsRouter } from './modules/notifications/index.js';
import { portfolioRouter } from './modules/portfolio/index.js';
import { preferencesRouter } from './modules/preferences/index.js';
import { riskRouter } from './modules/risk/index.js';
import { signalsRouter } from './modules/signals/index.js';

const log = moduleLogger('app');

/** JSON body ceiling. Image uploads go through multer, not through here. */
const JSON_BODY_LIMIT = '256kb';

export function createApp(): Express {
  const app = express();

  // Behind a load balancer, `req.ip` is the balancer without this and every
  // rate-limit bucket collapses into one. Configurable because trusting the
  // header when *not* behind a proxy lets any client spoof its own address.
  app.set('trust proxy', config.server.trustProxy);

  // Express advertises itself by default; there is no reason to tell an attacker
  // which framework and version to look up.
  app.disable('x-powered-by');

  // ETags on JSON invite conditional requests for data that is already cached
  // deliberately (and briefly) in Redis. The 304 bookkeeping buys nothing here.
  app.set('etag', false);

  app.use(requestId);
  app.use(httpLogger);
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(compression());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }));
  app.use(csrfProtection);

  registerHealth(app);
  registerRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Liveness and readiness.
 *
 * Deliberately shallow: it checks that this process can answer, and nothing
 * else. An orchestrator restarts a container whose liveness probe fails, so
 * wiring a database or vendor check in here would mean a market data outage
 * triggers a restart loop — turning a degraded platform into a down one.
 *
 * The deep dependency view is `GET /api/admin/health`, which is authenticated,
 * reports every check independently, and is read by a human deciding what to do.
 */
function registerHealth(app: Express): void {
  const handler = (_req: Request, res: Response): void => {
    ok(res, {
      status: 'ok',
      service: 'quantdesk-api',
      env: config.env,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: Date.now(),
    });
  };

  app.get('/health', handler);
  app.get('/api/health', handler);
}

/* -------------------------------------------------------------------------- */
/* Routers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Mount every feature module under `/api`.
 *
 * Each router owns its own authentication and rate limiting rather than
 * inheriting it from a mount-level guard. Mounting is then a pure routing
 * decision, and a module's access rules are readable in the module — not
 * assembled from two files a reader has to hold in their head at once.
 *
 * The settings module has no router by design: platform settings are edited
 * through `/api/admin/settings/*` and read internally by the engine, so a
 * separate public surface would be a second door to the same room.
 */
function registerRoutes(app: Express): void {
  app.use('/api/auth', authRouter);
  app.use('/api/markets', marketsRouter);
  app.use('/api/analysis', analysisRouter);
  app.use('/api/signals', signalsRouter);
  app.use('/api/images', imagesRouter);
  app.use('/api/news', newsRouter);
  app.use('/api/portfolio', portfolioRouter);
  app.use('/api/risk', riskRouter);
  app.use('/api/preferences', preferencesRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/admin', adminRouter);

  log.debug('Routers mounted');
}
