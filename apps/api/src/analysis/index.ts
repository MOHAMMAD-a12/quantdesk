/**
 * The analysis package.
 *
 * Layering, bottom to top:
 *
 *   series      numeric primitives (SMA/EMA/RMA/ATR/percentile/…)
 *   indicators  classic technicals built on series
 *   levels      horizontal structure — S/R, volume profile, Fibonacci, volatility
 *   smc         Smart Money Concepts / ICT structural reading
 *   patterns    candlestick recognition
 *   confluence  turns all of the above into weighted directional evidence
 *   mtf         cross-timeframe agreement
 *   engine      orchestrates one `TechnicalAnalysis`
 *   signal      turns an analysis into an actionable `Signal`
 *
 * Nothing in this package performs I/O, reads configuration, or calls a model.
 * It is a pure function of candles plus optional context, which is what makes
 * every number the platform reports reproducible.
 */

export * from './series.js';
export * from './indicators.js';
export * from './levels.js';
export * from './smc.js';
export * from './patterns.js';
export * from './confluence.js';
export * from './mtf.js';
export * from './engine.js';
export * from './signal.js';
