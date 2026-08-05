/**
 * Row-mapping primitives.
 *
 * Two `node-postgres` behaviours make raw rows unsafe to spread into domain
 * objects, and both are handled here rather than at each call site:
 *
 * 1. **`TIMESTAMPTZ` arrives as a `Date`.** The domain types use epoch
 *    milliseconds throughout so they serialise to JSON as numbers and need no
 *    revival on the client.
 *
 * 2. **`NUMERIC` arrives as a `string`.** The driver refuses to parse it as a
 *    float because a `NUMERIC(30,10)` does not fit in a double, and it is right
 *    to refuse. Money and prices are converted explicitly here, so a `+` on a
 *    price never silently concatenates two strings — which is exactly the bug
 *    that produces "121.5" + "0.5" = "121.50.5" in a PnL total.
 */

/** `TIMESTAMPTZ` → epoch ms. */
export function toEpoch(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `TIMESTAMPTZ NOT NULL` → epoch ms, with a fallback for the impossible case. */
export function toEpochRequired(value: Date | string | number, fallback = 0): number {
  return toEpoch(value) ?? fallback;
}

/** `NUMERIC` → number. Returns null for SQL NULL. */
export function toNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `NUMERIC NOT NULL` → number, defaulting when the value is unparseable. */
export function toNumRequired(value: string | number | null | undefined, fallback = 0): number {
  return toNum(value) ?? fallback;
}

/** `TEXT[]` → string[]. Guards against a NULL array column. */
export function toStrArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

/**
 * `JSONB` → object.
 *
 * The driver already parses `jsonb`, but a column defaulted to `'{}'` on a row
 * written before a schema change can still be a primitive or an array, and
 * spreading either produces nonsense.
 */
export function toJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Epoch ms → `Date` for binding into a `TIMESTAMPTZ` parameter. */
export function fromEpoch(ms: number | null | undefined): Date | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms);
}
