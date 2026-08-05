/**
 * The image-analysis module — a second opinion, not a tracked prediction.
 *
 * This is the one place where the platform's usual rule is inverted. Everywhere
 * else the deterministic engine produces every number and the model only writes
 * prose; on a screenshot there is no candle series, so the model *is* the
 * instrument. Two consequences follow, and both are load-bearing:
 *
 *   - Nothing produced here is written to `signals`. An image read cannot be
 *     reproduced from stored inputs, so it must not enter a track record whose
 *     whole value is that it can be audited.
 *   - `priceScaleReadable` and `warnings` travel with every report. A level the
 *     model inferred from pixel position rather than read off an axis is a
 *     guess, and the UI needs to be able to say so.
 *
 * Uploaded screenshots are the most sensitive data the platform holds — they can
 * show a real account's positions and size. They are served only through this
 * module's authenticated route, stripped of EXIF before storage, and deleted by
 * `pruneOlderThan` rather than kept indefinitely.
 */

export { imagesRouter } from './routes.js';

export {
  find,
  fileFor,
  list,
  pruneOlderThan,
  releaseStuck,
  remove,
  upload,
} from './service.js';

export type { UploadRequest, UploadResult } from './service.js';
