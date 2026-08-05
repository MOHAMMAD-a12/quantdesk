/**
 * Chart-image analysis persistence.
 *
 * An upload is recorded before the model is called, not after. That ordering is
 * what makes the feature debuggable: a vision call that times out, blows the
 * quota or returns garbage leaves a `failed` row with the error attached, rather
 * than leaving the user staring at a spinner with nothing on the server to
 * explain it.
 *
 * The stored file path never leaves this module. `ImageAnalysis.imageUrl` is a
 * route on this API, so the image is served through the same authentication as
 * everything else — handing the client a disk path would either leak the
 * deployment layout or require a public static mount over user uploads.
 */

import type {
  ImageAnalysis,
  ImageAnalysisReport,
  ImageAnalysisStatus,
  SupportedImageMime,
} from '@quantdesk/shared';
import { query, queryOne } from '../../db/pool.js';
import { toEpoch, toEpochRequired } from '../../db/rows.js';

type ImageRow = {
  id: string;
  user_id: string;
  file_name: string;
  stored_path: string;
  mime_type: SupportedImageMime;
  size_bytes: number;
  width: number | null;
  height: number | null;
  symbol_hint: string | null;
  timeframe_hint: string | null;
  notes: string | null;
  status: ImageAnalysisStatus;
  report: unknown;
  error: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  created_at: Date;
  completed_at: Date | null;
};

const COLUMNS = `
  id, user_id, file_name, stored_path, mime_type, size_bytes, width, height,
  symbol_hint, timeframe_hint, notes, status, report, error,
  ai_provider, ai_model, created_at, completed_at
`;

function mapImage(row: ImageRow): ImageAnalysis {
  const completedAt = toEpoch(row.completed_at);

  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.size_bytes,
    // The authenticated media route, not `stored_path`.
    imageUrl: `/api/images/${row.id}/file`,
    userNote: row.notes,
    // Cast rather than narrowed field-by-field: unlike the confidence breakdown,
    // a partially-written report has no sensible neutral substitute, and the
    // service only ever writes a Zod-validated object into this column.
    report: isReport(row.report) ? (row.report as ImageAnalysisReport) : null,
    error: row.error,
    aiProvider: row.ai_provider,
    aiModel: row.ai_model,
    createdAt: toEpochRequired(row.created_at),
    completedAt,
  };
}

function isReport(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The upload metadata captured before analysis begins. */
export interface ImageIngest {
  userId: string;
  fileName: string;
  storedPath: string;
  mimeType: SupportedImageMime;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  symbolHint: string | null;
  timeframeHint: string | null;
  notes: string | null;
}

/** Record an upload in `pending` state. */
export async function insertUpload(input: ImageIngest): Promise<ImageAnalysis> {
  const row = await queryOne<ImageRow>(
    `INSERT INTO image_analyses (
       user_id, file_name, stored_path, mime_type, size_bytes, width, height,
       symbol_hint, timeframe_hint, notes, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
     RETURNING ${COLUMNS}`,
    [
      input.userId,
      input.fileName,
      input.storedPath,
      input.mimeType,
      input.sizeBytes,
      input.width,
      input.height,
      input.symbolHint,
      input.timeframeHint,
      input.notes,
    ],
  );

  if (!row) throw new Error('Failed to record image upload');
  return mapImage(row);
}

/**
 * Claim an upload for processing.
 *
 * Conditional on the row still being `pending`, and reporting whether it won.
 * Two workers picking up the same upload would spend two vision calls — the
 * single most expensive operation the platform performs — on one image.
 */
export async function claimForProcessing(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE image_analyses SET status = 'processing'
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/** Attach a completed report. */
export async function completeAnalysis(
  id: string,
  report: ImageAnalysisReport,
  provenance: { provider: string; model: string },
): Promise<ImageAnalysis | null> {
  const row = await queryOne<ImageRow>(
    `UPDATE image_analyses SET
       status = 'completed', report = $2::jsonb, error = NULL,
       ai_provider = $3, ai_model = $4, completed_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, JSON.stringify(report), provenance.provider, provenance.model],
  );
  return row ? mapImage(row) : null;
}

/**
 * Mark an analysis failed.
 *
 * `completed_at` is set even on failure: it is when the attempt finished, and
 * leaving it null would make a permanently-failed row indistinguishable from one
 * still being worked on.
 */
export async function failAnalysis(id: string, error: string): Promise<ImageAnalysis | null> {
  const row = await queryOne<ImageRow>(
    `UPDATE image_analyses SET status = 'failed', error = $2, completed_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, error.slice(0, 2000)],
  );
  return row ? mapImage(row) : null;
}

export async function findImage(id: string): Promise<ImageAnalysis | null> {
  const row = await queryOne<ImageRow>(`SELECT ${COLUMNS} FROM image_analyses WHERE id = $1`, [id]);
  return row ? mapImage(row) : null;
}

/**
 * The stored path, for the file-serving route only.
 *
 * Returned separately from {@link findImage} so a path cannot be leaked by
 * accident: the domain object has no field to carry it, and any handler that
 * wants one has to ask for it explicitly.
 */
export async function storedPathOf(id: string): Promise<{ path: string; mime: string; userId: string } | null> {
  const row = await queryOne<{ stored_path: string; mime_type: string; user_id: string }>(
    `SELECT stored_path, mime_type, user_id FROM image_analyses WHERE id = $1`,
    [id],
  );
  return row ? { path: row.stored_path, mime: row.mime_type, userId: row.user_id } : null;
}

export async function listForUser(
  userId: string,
  page: number,
  pageSize: number,
): Promise<{ items: ImageAnalysis[]; total: number }> {
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM image_analyses WHERE user_id = $1`,
    [userId],
  );

  const rows = await query<ImageRow>(
    `SELECT ${COLUMNS} FROM image_analyses
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, pageSize, (page - 1) * pageSize],
  );

  return { items: rows.map(mapImage), total: Number(countRow?.count ?? 0) };
}

/**
 * Count a user's uploads today, for the per-day quota.
 *
 * Vision calls are the most expensive thing a free-tier user can trigger, and
 * without a cap one user can spend an operator's entire model budget in an
 * afternoon.
 */
export async function countTodayForUser(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM image_analyses
     WHERE user_id = $1 AND created_at > date_trunc('day', now())`,
    [userId],
  );
  return Number(row?.count ?? 0);
}

/**
 * Delete an analysis, returning its stored path so the caller can unlink the
 * file. The row goes first: an orphaned file wastes disk, whereas a row pointing
 * at a file that no longer exists produces a broken image on every future load.
 */
export async function deleteImage(id: string, userId: string): Promise<string | null> {
  const row = await queryOne<{ stored_path: string }>(
    `DELETE FROM image_analyses WHERE id = $1 AND user_id = $2 RETURNING stored_path`,
    [id, userId],
  );
  return row?.stored_path ?? null;
}

/**
 * Reclaim uploads stuck in `processing`.
 *
 * A process killed mid-analysis leaves rows that no worker will ever finish and
 * that the UI shows as perpetually in-flight. The scheduler calls this on
 * startup and periodically.
 */
export async function releaseStuck(olderThanMs: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE image_analyses SET
       status = 'failed',
       error = 'Analysis did not complete — the server restarted or the request timed out',
       completed_at = now()
     WHERE status = 'processing'
       AND created_at < now() - make_interval(secs => $1::double precision)
     RETURNING id`,
    [olderThanMs / 1000],
  );
  return rows.length;
}

/** Old uploads and their files, for the retention job. */
export async function listExpired(olderThanDays: number): Promise<Array<{ id: string; path: string }>> {
  const rows = await query<{ id: string; stored_path: string }>(
    `SELECT id, stored_path FROM image_analyses
     WHERE created_at < now() - make_interval(days => $1::int)`,
    [olderThanDays],
  );
  return rows.map((r) => ({ id: r.id, path: r.stored_path }));
}

export async function deleteByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await query<{ id: string }>(
    `DELETE FROM image_analyses WHERE id = ANY($1::uuid[]) RETURNING id`,
    [ids],
  );
  return rows.length;
}
