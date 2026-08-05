/**
 * Chart-image analysis endpoints.
 *
 * The only multipart surface in the API. Two decisions shape this file:
 *
 * **Memory storage, not disk.** Multer's disk engine would write the raw upload
 * before anything has verified it is an image, leaving attacker-supplied bytes on
 * the filesystem under a name the request influenced. The service re-encodes
 * through `sharp` and writes the *result*, so the only thing that ever reaches
 * disk is a file this server produced. The buffer is bounded by
 * `config.uploads.maxBytes`, so "in memory" has a hard ceiling.
 *
 * **Images are served through this router, never a static mount.** A screenshot
 * of someone's live account is private. `GET /:id/file` applies the same
 * authentication as every other route and then an ownership check, which a
 * `express.static` over the upload directory could not do.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { imageAnalysisSchema, paginationSchema } from '@quantdesk/shared';
import { config } from '../../core/config.js';
import { NotFoundError, PayloadTooLargeError, ValidationError } from '../../core/errors.js';
import { created, ok, okPage } from '../../core/http.js';
import { moduleLogger } from '../../core/logger.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { body as bodyOf, paramsOf, queryOf, validate } from '../../middleware/validate.js';
import { assertOwnership, authenticate } from '../auth/middleware.js';
import * as service from './service.js';

export const imagesRouter = Router();

const log = moduleLogger('images');

imagesRouter.use(authenticate, rateLimit({ bucket: 'images' }));

const idParamSchema = z.object({ id: z.string().uuid('Not a valid analysis id') });

/**
 * Multer, configured to accept exactly one file called `image`.
 *
 * `files: 1` matters as much as the byte limit: without it a client can send a
 * hundred files inside the size budget and multer will buffer every one before
 * the handler sees any of them.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploads.maxBytes,
    files: 1,
    // Room for the three text hints and nothing more.
    fields: 8,
  },
});

/**
 * Translate multer's own failures into API errors.
 *
 * Multer rejects an oversized or malformed upload with a `MulterError`, which
 * means nothing to the central handler and would surface as a generic 500 — the
 * one status that tells a user "this is our fault, try again" when in fact the
 * file is simply too large. Kept local to this module so `middleware/error.ts`
 * has no reason to know multer exists.
 */
function acceptImage(req: Request, res: Response, next: NextFunction): void {
  upload.single('image')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }

    if (err instanceof multer.MulterError) {
      switch (err.code) {
        case 'LIMIT_FILE_SIZE':
          next(new PayloadTooLargeError(config.uploads.maxBytes));
          return;
        case 'LIMIT_FILE_COUNT':
        case 'LIMIT_UNEXPECTED_FILE':
          next(new ValidationError('Attach exactly one file, in the field named "image"'));
          return;
        default:
          next(new ValidationError(`The upload could not be read: ${err.message}`));
          return;
      }
    }

    next(err);
  });
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Upload a chart screenshot and analyse it.
 *
 * Its own tight bucket: this is a vision call, the most expensive thing the
 * platform does per request, and the per-day cap in the service is a budget
 * control rather than an abuse control. Both are needed — the cap stops a slow
 * drain over a day, the limiter stops a burst in a minute.
 *
 * Available to every authenticated role. Free accounts are constrained by the
 * daily cap, not by the route, so the feature is discoverable on the plan most
 * likely to be evaluating it.
 *
 * Returns 201 with the analysis in whatever state it reached. A `failed` status
 * with a populated `error` is a successful request that produced a negative
 * result, and reporting it as a 5xx would tell the client the upload was lost
 * when it was not.
 */
imagesRouter.post(
  '/',
  rateLimit({ bucket: 'images:upload', max: 20 }),
  acceptImage,
  validate({ body: imageAnalysisSchema }),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new ValidationError('An image file is required', [
        { path: 'image', message: 'Attach a chart screenshot as multipart field "image"' },
      ]);
    }
    if (!req.user) {
      // Unreachable behind `authenticate`; narrows the type without a non-null
      // assertion, which would hide the day someone reorders the middleware.
      throw new ValidationError('Authentication required');
    }

    const hints = bodyOf(req, imageAnalysisSchema);

    const result = await service.upload({
      userId: req.user.id,
      role: req.user.role,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
      symbolHint: hints.symbolHint,
      timeframeHint: hints.timeframeHint,
      userNote: hints.userNote,
    });

    // Set before the body: once `created` writes the response, headers are gone.
    res.setHeader('X-Analyses-Remaining', String(result.remainingToday ?? 'unlimited'));
    created(res, result.analysis);
  }),
);

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The caller's own upload history.
 *
 * Scoped to `req.user.id` in the query itself rather than filtered afterwards.
 * An admin listing another user's screenshots would be a surveillance feature,
 * and there is no legitimate operator need it serves.
 */
imagesRouter.get(
  '/',
  validate({ query: paginationSchema }),
  asyncHandler(async (req, res) => {
    if (!req.user) throw new ValidationError('Authentication required');
    const { page, pageSize } = queryOf(req, paginationSchema);

    const { items, total } = await service.list(req.user.id, page, pageSize);
    okPage(res, items, total, page, pageSize);
  }),
);

/** One analysis, including its report. */
imagesRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);

    const analysis = await service.find(id);
    if (!analysis) throw new NotFoundError('Image analysis');
    assertOwnership(req, analysis.userId);

    ok(res, analysis);
  }),
);

/**
 * The image bytes.
 *
 * Streamed rather than buffered — a 1920px PNG is a few megabytes, and holding
 * one per concurrent viewer in the heap is avoidable. `Cache-Control: private`
 * keeps it out of any shared proxy: the URL is authenticated, so a cached copy
 * served to the next caller would defeat the ownership check entirely.
 */
imagesRouter.get(
  '/:id/file',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);

    const file = await service.fileFor(id);
    if (!file) throw new NotFoundError('Image');
    assertOwnership(req, file.userId);

    // The row can outlive its file — a retention sweep that unlinked before the
    // delete, or a restored database on a fresh volume.
    const stats = await stat(file.path).catch(() => null);
    if (!stats?.isFile()) throw new NotFoundError('Image file');

    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(stats.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    // Belt and braces: these bytes are user-supplied, and a browser that decides
    // to sniff its way to text/html on one of them would have a stored XSS.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
    res.setHeader('Content-Disposition', 'inline');

    const stream = createReadStream(file.path);

    // An unhandled 'error' on a read stream is an uncaught exception, which in
    // Node takes down the process — a disk hiccup on one screenshot must not
    // stop the server. Headers are already out by then, so destroying the
    // socket is the only honest signal available.
    stream.on('error', (error) => {
      log.error({ err: error, path: file.path, requestId: req.id }, 'Failed while streaming an uploaded image');
      res.destroy();
    });

    stream.pipe(res);
  }),
);

/* -------------------------------------------------------------------------- */
/* Delete                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Delete an analysis and its image.
 *
 * Ownership is enforced inside the DELETE statement rather than by a prior read,
 * so there is no window between the check and the write. A miss is reported as
 * 404, not 403 — telling a caller that an id exists but belongs to someone else
 * is more than they need to know.
 */
imagesRouter.delete(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    if (!req.user) throw new ValidationError('Authentication required');
    const { id } = paramsOf(req, idParamSchema);

    const removed = await service.remove(id, req.user.id);
    if (!removed) throw new NotFoundError('Image analysis');

    ok(res, { id, deleted: true });
  }),
);
