/**
 * The signals module — where analysis becomes a proposition.
 *
 * The rule this module exists to enforce, restated because it is the one thing a
 * future change here could quietly break:
 *
 *   Every number in a `Signal` comes from the deterministic engine. The model
 *   contributes prose and a single conviction score, nothing else.
 *
 * A signal is immutable once written. Status advances, `realisedR` is filled in
 * on resolution, and the levels and reasoning stay exactly as published — because
 * a track record you can silently recompute is not a track record.
 *
 * Consumers should reach for `generate` and the read helpers. The repository is
 * internal: persistence rules like the WAIT-has-no-levels constraint and the
 * per-symbol daily cap are enforced in the service, and a caller that writes
 * rows directly would bypass both.
 */

export { signalsRouter } from './routes.js';

export {
  accuracy,
  active,
  expire,
  find,
  generate,
  latest,
  list,
  performance,
  resolve,
  scan,
} from './service.js';

export type { GenerateRequest, GenerateResult, ScanResult } from './service.js';

export { isTerminal, pruneSignals } from './repository.js';
export type { SignalFilter } from './repository.js';
