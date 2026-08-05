/**
 * Pure formatting and numeric helpers shared by API and web.
 * No side effects, no I/O — safe to import anywhere including RSC.
 */

import { TIMEFRAME_MS, type Timeframe } from '../types/market.js';

/** Clamp `n` into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** Round to `dp` decimal places without float drift artefacts. */
export function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** True when the value is a usable finite number. */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Safe division — returns `fallback` instead of Infinity/NaN.
 * Used pervasively in the indicator maths where denominators can be zero.
 */
export function safeDiv(a: number, b: number, fallback = 0): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return fallback;
  const r = a / b;
  return Number.isFinite(r) ? r : fallback;
}

/** Percentage change from `from` to `to`. */
export function pctChange(from: number, to: number): number {
  return safeDiv(to - from, Math.abs(from)) * 100;
}

/** Linear interpolation of a percentile from a sorted numeric array. */
export function percentileOf(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return 50;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sorted.length) * 100;
}

/** Arithmetic mean; 0 for an empty array. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). */
export function stdDev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

/** Pearson correlation coefficient. Returns 0 when undefined. */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const sa = a.slice(a.length - n);
  const sb = b.slice(b.length - n);
  const ma = mean(sa);
  const mb = mean(sb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (sa[i] as number) - ma;
    const y = (sb[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : clamp(num / den, -1, 1);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a price with sensible precision for its magnitude. */
export function formatPrice(price: number, precision?: number): string {
  if (!isFiniteNumber(price)) return '—';
  const dp = precision ?? autoPrecision(price);
  return price.toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Choose a decimal count based on price magnitude. */
export function autoPrecision(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 5;
  return 8;
}

/** Signed percentage, e.g. "+1.42%". */
export function formatPercent(pct: number, dp = 2): string {
  if (!isFiniteNumber(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(dp)}%`;
}

/** Compact large numbers: 1.2K, 3.4M, 5.6B, 7.8T. */
export function formatCompact(n: number, dp = 2): string {
  if (!isFiniteNumber(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(dp)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(dp)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(dp)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(dp)}K`;
  return `${sign}${abs.toFixed(dp)}`;
}

/** Account-currency amount, e.g. "$1,234.56". */
export function formatCurrency(n: number, currency = 'USD'): string {
  if (!isFiniteNumber(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Human duration: "2h 15m", "3d 4h". */
export function formatDuration(ms: number): string {
  if (!isFiniteNumber(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Relative time: "just now", "5m ago", "3h ago", "2d ago". */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 0) return 'in the future';
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Timeframe helpers
// ---------------------------------------------------------------------------

/** Align a timestamp down to the start of its timeframe bucket. */
export function alignToTimeframe(ts: number, tf: Timeframe): number {
  const size = TIMEFRAME_MS[tf];
  // Weekly bars conventionally open Monday 00:00 UTC. Epoch was a Thursday,
  // so shift by 4 days before flooring, then shift back.
  if (tf === '1w') {
    const shift = 4 * 86_400_000;
    return Math.floor((ts + shift) / size) * size - shift;
  }
  return Math.floor(ts / size) * size;
}

/** How many bars of `tf` fit in `ms`. */
export function barsIn(ms: number, tf: Timeframe): number {
  return Math.floor(ms / TIMEFRAME_MS[tf]);
}

/** Estimated wall-clock duration of `bars` bars on `tf`. */
export function barsToMs(bars: number, tf: Timeframe): number {
  return bars * TIMEFRAME_MS[tf];
}

/** Sleep helper for backoff loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split an array into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Deduplicate by a key selector, keeping first occurrence. */
export function uniqueBy<T, K>(items: readonly T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
