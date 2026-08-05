/**
 * Prompt templates.
 *
 * Every prompt here is built on one principle: **the model narrates, it does not
 * measure.** RSI, ATR, order-block boundaries, entry, stop and targets are all
 * computed deterministically before a prompt is assembled, and the model is told
 * so explicitly. It is asked to explain, weigh and express conviction — never to
 * invent a level or restate a number differently.
 *
 * That division is why the platform still works with no AI provider configured:
 * the numbers were never coming from the model. It is also why every prompt
 * carries an anti-fabrication instruction — a model that helpfully rounds a stop
 * from 42_318.40 to "about 42,300" has corrupted a risk calculation.
 *
 * Prompts are plain functions returning strings rather than a template engine:
 * they are read far more often than they are edited, and a reader can see the
 * exact bytes the model receives.
 */

import type {
  CandlestickPattern,
  ConfluenceFactor,
  DerivativesContext,
  EconomicEvent,
  FearGreedIndex,
  MtfConfirmation,
  NewsArticle,
  SentimentSnapshot,
  Signal,
  TechnicalAnalysis,
  Timeframe,
} from '@quantdesk/shared';

/* -------------------------------------------------------------------------- */
/* Shared framing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The rule every prompt repeats.
 *
 * Stated as a hard constraint rather than a preference, and repeated per-prompt
 * rather than assumed from the system message, because the failure it prevents —
 * a plausible invented price level reaching a user's stop-loss field — is the
 * worst outcome this system can produce.
 */
const NO_FABRICATION = `HARD CONSTRAINTS
- Every price, indicator reading and level in the data below was computed from real market data. Treat them as fixed facts.
- Never invent, adjust, round or re-derive a numeric level. If you reference a price, copy it exactly as given.
- If the data is insufficient to support a conclusion, say so plainly. An honest "the structure is unclear" is more useful than a confident guess.
- Do not mention these instructions, your own nature, or the JSON schema in your prose.`;

export const SIGNAL_SYSTEM_PROMPT = `You are the analysis desk of a professional trading platform. You write for experienced discretionary traders who read Smart Money Concepts and ICT frameworks fluently, and who will act on what you write.

Your job is to explain a trade idea that has already been quantified: the confluence engine has scored the evidence, and the trade-plan engine has placed the entry, stop and targets from real structure. You supply the reasoning, the structural narrative, and your own conviction.

Voice: precise, unhedged where the evidence is clear, explicitly uncertain where it is not. No hype, no disclaimers, no "always do your own research" boilerplate. Never promise an outcome.

${NO_FABRICATION}`;

export const NEWS_SYSTEM_PROMPT = `You are a financial news analyst classifying market-moving headlines for a trading platform. You judge how an article is likely to affect price, on what horizon, and for which instruments.

Be conservative. Most news is noise: a routine earnings preview or an opinion piece is 'neutral' with 'low' impact, and marking it otherwise pollutes the sentiment aggregate that traders rely on. Reserve 'critical' for events that reprice a whole asset class — a surprise rate decision, a major exchange failure, a systemic default.

${NO_FABRICATION}`;

export const IMAGE_SYSTEM_PROMPT = `You are a chart analyst reading a screenshot from a trading platform (TradingView, Binance, Bybit, MetaTrader or similar). You extract what is *visibly present* and interpret it.

Critical distinction: you are reading pixels, not a data feed. You cannot know the exact last price, and you must not pretend to. Read axis labels and drawn levels where they are legible, state your confidence in each reading, and mark anything you are inferring rather than reading. If the image is too low-resolution, cropped, or is not a price chart at all, say that instead of analysing it.

${NO_FABRICATION}`;

/* -------------------------------------------------------------------------- */
/* Serialisation helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Format a price at the instrument's precision.
 *
 * Precision matters here beyond tidiness: rendering a JPY cross at two decimals
 * or BTC at eight changes what the model believes the tick size is, and its
 * structural commentary follows that belief.
 */
function px(value: number | null | undefined, precision: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(precision);
}

function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(digits)}%`;
}

function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function bullet(lines: Array<string | null>): string {
  const kept = lines.filter((l): l is string => l !== null && l.trim() !== '');
  return kept.length > 0 ? kept.map((l) => `- ${l}`).join('\n') : '- (none detected)';
}

/** Indicator block. Omits warm-up NaNs rather than printing "NaN" as a reading. */
function indicatorSection(analysis: TechnicalAnalysis, precision: number): string {
  const i = analysis.indicators;

  return bullet([
    Number.isFinite(i.rsi)
      ? `RSI(14): ${num(i.rsi)}${i.rsiDivergence ? ` — ${i.rsiDivergence} divergence against price` : ''}`
      : null,
    Number.isFinite(i.macd.histogram)
      ? `MACD: line ${num(i.macd.macd, 4)}, signal ${num(i.macd.signal, 4)}, histogram ${num(i.macd.histogram, 4)}`
      : null,
    emaLine(i.ema, precision),
    smaLine(i.sma, precision),
    Number.isFinite(i.atr) ? `ATR(14): ${px(i.atr, precision)} (${pct(i.atrPercent)} of price)` : null,
    Number.isFinite(i.adx.adx)
      ? `ADX(14): ${num(i.adx.adx)} (+DI ${num(i.adx.plusDi)}, -DI ${num(i.adx.minusDi)})`
      : null,
    Number.isFinite(i.bollinger.middle)
      ? `Bollinger(20,2): ${px(i.bollinger.lower, precision)} / ${px(i.bollinger.middle, precision)} / ${px(i.bollinger.upper, precision)}, bandwidth ${num(i.bollinger.bandwidth, 4)}, %B ${num(i.bollinger.percentB)}`
      : null,
    Number.isFinite(i.stochastic.k)
      ? `Stochastic(14,3): %K ${num(i.stochastic.k)}, %D ${num(i.stochastic.d)}`
      : null,
    i.ichimoku && Number.isFinite(i.ichimoku.tenkan)
      ? `Ichimoku: tenkan ${px(i.ichimoku.tenkan, precision)}, kijun ${px(i.ichimoku.kijun, precision)}, cloud ${px(i.ichimoku.senkouA, precision)}–${px(i.ichimoku.senkouB, precision)}, price ${i.ichimoku.cloudPosition} the cloud, cloud ${i.ichimoku.cloudDirection}`
      : null,
    Number.isFinite(i.vwap)
      ? `VWAP: ${px(i.vwap, precision)} (±1σ ${px(i.vwapBands.lower1, precision)}–${px(i.vwapBands.upper1, precision)})`
      : null,
    Number.isFinite(i.volumeProfile.poc)
      ? `Volume profile: POC ${px(i.volumeProfile.poc, precision)}, value area ${px(i.volumeProfile.val, precision)}–${px(i.volumeProfile.vah, precision)}`
      : null,
    i.fibonacci
      ? `Fibonacci (${i.fibonacci.direction}, swing ${px(i.fibonacci.swingLow, precision)}–${px(i.fibonacci.swingHigh, precision)}): 0.382 ${px(i.fibonacci.retracements['0.382'], precision)}, 0.5 ${px(i.fibonacci.retracements['0.5'], precision)}, 0.618 ${px(i.fibonacci.retracements['0.618'], precision)}, golden pocket ${px(i.fibonacci.goldenPocket.low, precision)}–${px(i.fibonacci.goldenPocket.high, precision)}`
      : null,
    Number.isFinite(i.relativeVolume) ? `Volume vs its own average: ${num(i.relativeVolume)}x` : null,
    Number.isFinite(i.obv) ? `OBV: ${num(i.obv, 0)}` : null,
  ]);
}

/**
 * EMA/SMA stacks.
 *
 * The periods are a `Record<number, number>` because the engine's period set is
 * configurable, so they are rendered by iterating what is actually present
 * rather than by naming 20/50/200 and printing "n/a" for a period that was never
 * requested.
 */
function emaLine(ema: Record<number, number>, precision: number): string | null {
  const parts = movingAverageParts(ema, precision);
  return parts === null ? null : `EMA ${parts}`;
}

function smaLine(sma: Record<number, number>, precision: number): string | null {
  const parts = movingAverageParts(sma, precision);
  return parts === null ? null : `SMA ${parts}`;
}

function movingAverageParts(values: Record<number, number>, precision: number): string | null {
  const rendered = Object.keys(values)
    .map(Number)
    .filter((period) => Number.isFinite(period))
    .sort((a, b) => a - b)
    .map((period) => ({ period, value: values[period] }))
    .filter((entry): entry is { period: number; value: number } => Number.isFinite(entry.value))
    .map((entry) => `${entry.period}: ${px(entry.value, precision)}`);

  return rendered.length > 0 ? rendered.join(', ') : null;
}

/**
 * SMC/ICT block.
 *
 * Only untested order blocks and unfilled FVGs are listed. A mitigated block is
 * history — including it invites the model to build a thesis on a zone price has
 * already consumed, which is the single most common way SMC commentary goes
 * wrong.
 */
function smcSection(analysis: TechnicalAnalysis, precision: number): string {
  const s = analysis.smc;

  const orderBlocks = s.orderBlocks
    .filter((b) => !b.mitigated)
    .slice(0, 5)
    .map(
      (b) =>
        `${b.direction} order block ${px(b.bottom, precision)}–${px(b.top, precision)} (strength ${num(b.strength, 0)}/100${b.hasImbalance ? ', breaker quality — carries an unfilled imbalance' : ''})`,
    );

  const fvgs = s.fairValueGaps
    .filter((g) => !g.mitigated)
    .slice(0, 5)
    .map(
      (g) =>
        `${g.direction} FVG ${px(g.bottom, precision)}–${px(g.top, precision)} (${pct(g.sizePercent)} wide, ${num(g.fillRatio * 100, 0)}% filled)`,
    );

  const sweeps = s.liquiditySweeps
    .slice(-3)
    .map(
      (w) =>
        `${w.direction} sweep of ${px(w.level, precision)}, penetration ${num(w.penetrationAtr)}x ATR${
          w.reversed ? `, reversed within ${w.reversalBars} bars` : ', no reversal yet'
        }`,
    );

  const events = s.structure.events
    .slice(-4)
    .map(
      (e) =>
        `${e.type} ${e.direction}: broke ${px(e.brokenLevel, precision)}, confirmed on a close at ${px(e.confirmedAt, precision)} (significance ${num(e.significance, 0)}/100)`,
    );

  const zones = s.supplyDemandZones
    .slice(0, 4)
    .map(
      (z) =>
        `${z.kind} zone ${px(z.bottom, precision)}–${px(z.top, precision)} (${z.pattern}, strength ${num(z.strength, 0)}/100, ${z.tested ? `tested ${z.testCount}x` : 'fresh'})`,
    );

  const pools = s.liquidityPools
    .filter((p) => !p.swept)
    .slice(0, 4)
    .map(
      (p) =>
        `${p.kind} liquidity at ${px(p.price, precision)} (${p.touches} equal pivots, strength ${num(p.strength, 0)}/100)`,
    );

  const swings = s.structure.swings
    .slice(-6)
    .map((sw) => `${sw.label} ${sw.kind} at ${px(sw.price, precision)}`);

  return [
    `Market structure: ${s.structure.trend}, clarity ${num(s.structure.clarity, 0)}/100, price in ${s.structure.premiumDiscount}`,
    s.structure.dealingRange
      ? `Dealing range: ${px(s.structure.dealingRange.low, precision)}–${px(s.structure.dealingRange.high, precision)}, equilibrium ${px(s.structure.dealingRange.equilibrium, precision)}`
      : null,
    s.structure.lastEvent
      ? `Defining event: ${s.structure.lastEvent.type} ${s.structure.lastEvent.direction} at ${px(s.structure.lastEvent.brokenLevel, precision)}`
      : null,
    `Institutional footprint score: ${num(s.institutionalFootprint, 0)}/100`,
    '',
    'Recent swing sequence:',
    bullet(swings),
    '',
    'Structure events:',
    bullet(events),
    '',
    'Unmitigated order blocks:',
    bullet(orderBlocks),
    '',
    'Unmitigated fair value gaps:',
    bullet(fvgs),
    '',
    'Liquidity sweeps:',
    bullet(sweeps),
    '',
    'Resting liquidity:',
    bullet(pools),
    '',
    'Supply & demand zones:',
    bullet(zones),
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

/**
 * Support and resistance.
 *
 * Distance from price is computed here rather than carried on the level, so the
 * model sees "1.8% away" without the analysis type having to store a figure that
 * is stale the moment price moves.
 */
function levelsSection(analysis: TechnicalAnalysis, precision: number): string {
  const render = (l: { price: number; strength: number; touches: number; lastTouch: number }, kind: string) =>
    `${kind} ${px(l.price, precision)} (strength ${num(l.strength, 0)}/100, ${l.touches} touches, ${pct(distancePercent(analysis.price, l.price))} away, last touched ${new Date(l.lastTouch).toISOString().slice(0, 10)})`;

  return bullet([
    ...analysis.supportLevels.slice(0, 5).map((l) => render(l, 'Support')),
    ...analysis.resistanceLevels.slice(0, 5).map((l) => render(l, 'Resistance')),
  ]);
}

function distancePercent(price: number, level: number): number {
  if (!Number.isFinite(price) || price === 0) return Number.NaN;
  return Math.abs((level - price) / price) * 100;
}

function patternSection(patterns: CandlestickPattern[], _precision: number): string {
  return bullet(
    patterns
      .slice(0, 6)
      .map(
        (p) =>
          `${p.name.replace(/_/g, ' ')} (${p.direction}, reliability ${num(p.reliability, 0)}/100, ${p.barCount}-bar) at ${new Date(p.time).toISOString()}`,
      ),
  );
}

function confluenceSection(factors: ConfluenceFactor[]): string {
  return bullet(
    factors
      .slice(0, 14)
      .map(
        (f) =>
          `[${f.category}] ${f.label}: ${f.direction}, weight ${num(f.weight, 2)}, score ${num(f.score, 0)} — ${f.detail}`,
      ),
  );
}

function mtfSection(mtf: MtfConfirmation | undefined): string {
  if (!mtf) return '- (not computed for this request)';

  const verdicts = mtf.verdicts.map(
    (v) => `${v.timeframe}: ${v.bias} (${v.trend}, conviction ${num(v.conviction, 0)}/100) — ${v.keyNote}`,
  );

  return [
    bullet(verdicts),
    '',
    `Alignment score: ${num(mtf.alignmentScore, 0)}/100, dominant bias ${mtf.dominantBias}${
      mtf.conflicts.length > 0 ? `, conflicting timeframes: ${mtf.conflicts.join(', ')}` : ', no conflicts'
    }`,
  ].join('\n');
}

function contextSection(
  sentiment: SentimentSnapshot | null | undefined,
  fearGreed: FearGreedIndex | null | undefined,
  events: EconomicEvent[] | undefined,
  derivatives: DerivativesContext | null | undefined,
  now: number,
): string {
  const lines: Array<string | null> = [
    sentiment
      ? `News sentiment (${sentiment.windowHours}h, ${sentiment.articleCount} classified articles): ${sentiment.sentiment}, score ${num(sentiment.score)}, momentum ${num(sentiment.momentum)}`
      : null,
    fearGreed
      ? `Fear & Greed index: ${num(fearGreed.value, 0)} (${fearGreed.classification})${
          fearGreed.previousValue !== undefined ? `, previously ${num(fearGreed.previousValue, 0)}` : ''
        }`
      : null,
    derivatives?.fundingRate !== undefined
      ? `Funding rate: ${num(derivatives.fundingRate * 100, 4)}% per interval`
      : null,
    derivatives?.openInterest !== undefined
      ? `Open interest: ${num(derivatives.openInterest, 0)}${
          derivatives.openInterestChangePercent !== undefined
            ? ` (${pct(derivatives.openInterestChangePercent)} 24h)`
            : ''
        }`
      : null,
    derivatives?.longShortRatio !== undefined
      ? `Long/short account ratio: ${num(derivatives.longShortRatio)}`
      : null,
  ];

  if (events && events.length > 0) {
    for (const event of events.slice(0, 4)) {
      const minutes = Math.round((event.scheduledAt - now) / 60_000);
      lines.push(
        `Upcoming ${event.impact}-impact release: ${event.title} (${event.currency || event.country}) in ${minutes} minutes${
          event.forecast ? `, forecast ${event.forecast}` : ''
        }`,
      );
    }
  }

  const rendered = bullet(lines);
  return rendered === '- (none detected)' ? '- (no macro or sentiment context available)' : rendered;
}

/* -------------------------------------------------------------------------- */
/* Signal narration                                                           */
/* -------------------------------------------------------------------------- */

export interface SignalPromptInput {
  analysis: TechnicalAnalysis;
  /** Instrument metadata, so prices render at the right precision. */
  symbolName: string;
  assetClass: string;
  pricePrecision: number;
  /** The deterministic verdict the model is explaining, not deciding. */
  proposed: {
    action: Signal['action'];
    entry: number | null;
    entryZone: { low: number; high: number } | null;
    stopLoss: number | null;
    takeProfits: Signal['takeProfits'];
    riskRewardRatio: number | null;
    stopRationale: string;
    technicalConfidence: number;
    waitReason: string | null;
  };
  derivatives?: DerivativesContext | null;
  sentiment?: SentimentSnapshot | null;
  fearGreed?: FearGreedIndex | null;
  upcomingEvents?: EconomicEvent[];
  /** Injected for deterministic tests; defaults to the wall clock. */
  now?: number;
}

/**
 * The JSON contract for a narrated signal.
 *
 * Exposed as a schema object rather than described in prose so providers with
 * structured-output support can *enforce* it. Providers without it get the same
 * shape rendered into the prompt, and `extractJson` plus Zod validation catches
 * the difference — the caller never trusts the shape either way.
 *
 * Note what is absent: no entry, stop or target fields. The model is given no
 * slot in which to return a price, which is a stronger guarantee than asking it
 * not to.
 */
export const SIGNAL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'agreesWithDirection',
    'aiConviction',
    'reasoning',
    'marketStructureExplanation',
    'keyFactors',
    'invalidation',
    'expectedDuration',
    'riskNotes',
  ],
  properties: {
    agreesWithDirection: {
      type: 'boolean',
      description:
        'Whether the evidence supports the proposed direction. Answer false if you genuinely disagree — this reduces the published confidence rather than changing the direction.',
    },
    aiConviction: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Your own conviction in this setup. 50 means genuinely undecided.',
    },
    reasoning: {
      type: 'string',
      description:
        'Two to four sentences explaining the trade thesis, referencing the specific evidence that carries it.',
    },
    marketStructureExplanation: {
      type: 'string',
      description:
        'Two to three sentences on the SMC/ICT read specifically: structure state, what price is likely reaching for, and which zone matters.',
    },
    keyFactors: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 6,
      description: 'The decisive factors, most important first. One short clause each.',
    },
    invalidation: {
      type: 'string',
      description:
        'What would falsify this idea, stated structurally (e.g. "a 4h close back inside the range") rather than as a price.',
    },
    expectedDuration: {
      type: 'string',
      description: 'Expected holding period in plain words, e.g. "4-12 hours" or "2-5 days".',
    },
    riskNotes: {
      type: 'string',
      description: 'One or two sentences on what makes this riskier than it looks. Empty string if nothing stands out.',
    },
  },
};

/** Build the user turn for signal narration. */
export function buildSignalPrompt(input: SignalPromptInput): string {
  const { analysis, proposed, pricePrecision: p } = input;
  const now = input.now ?? Date.now();

  const planBlock =
    proposed.action === 'WAIT'
      ? [
          'PROPOSED VERDICT: WAIT — no trade.',
          proposed.waitReason ? `Gate that rejected the setup: ${proposed.waitReason}` : null,
          'Explain what is missing and what would need to change. Do not construct a trade plan.',
        ]
          .filter((l) => l !== null)
          .join('\n')
      : [
          `PROPOSED VERDICT: ${proposed.action}`,
          `Entry: ${px(proposed.entry, p)}${
            proposed.entryZone ? ` (zone ${px(proposed.entryZone.low, p)}–${px(proposed.entryZone.high, p)})` : ''
          }`,
          `Stop loss: ${px(proposed.stopLoss, p)} — ${proposed.stopRationale}`,
          ...proposed.takeProfits.map(
            (tp) =>
              `Take profit ${tp.level}: ${px(tp.price, p)} (${num(tp.rr)}R, close ${Math.round(tp.allocation * 100)}% — ${tp.rationale})`,
          ),
          `Risk/reward to first target: ${num(proposed.riskRewardRatio)}`,
          `Deterministic technical confidence: ${num(proposed.technicalConfidence, 0)}/100`,
        ].join('\n');

  return `INSTRUMENT
${input.symbolName} (${analysis.symbol}, ${input.assetClass}) on the ${analysis.timeframe} timeframe.
Last closed price: ${px(analysis.price, p)} at ${new Date(analysis.asOf).toISOString()}.
Bars analysed: ${analysis.candleCount}.${analysis.synthetic ? '\nWARNING: this analysis used synthetic fallback data. State clearly that the read is not based on live market data.' : ''}

${planBlock}

INDICATORS
${indicatorSection(analysis, p)}

SMART MONEY / ICT
${smcSection(analysis, p)}

KEY LEVELS
${levelsSection(analysis, p)}

CANDLESTICK PATTERNS
${patternSection(analysis.patterns, p)}

VOLATILITY
- ATR ${px(analysis.indicators.atr, p)} (${pct(analysis.volatility.atrPercent)} of price), regime ${analysis.volatility.regime}, percentile ${num(analysis.volatility.percentile, 0)}
- Expanding: ${analysis.volatility.expanding ? 'yes' : 'no'}; Bollinger squeeze: ${analysis.volatility.squeeze ? 'yes' : 'no'}

TREND & MOMENTUM
- Trend strength: ${num(analysis.trendStrength, 0)}/100
- Composite momentum: ${num(analysis.momentum, 0)} (-100 to 100)
- Net confluence score: ${num(analysis.confluenceScore, 0)} (-100 bearish to 100 bullish)

CONFLUENCE FACTORS
${confluenceSection(analysis.confluence)}

MULTI-TIMEFRAME
${mtfSection(analysis.mtf)}

${
  analysis.correlations && analysis.correlations.length > 0
    ? `CORRELATIONS\n${bullet(analysis.correlations.map((c) => `${c.symbol}: ${num(c.coefficient, 2)} over ${c.lookbackBars} bars`))}\n\n`
    : ''
}MACRO & SENTIMENT
${contextSection(input.sentiment, input.fearGreed, input.upcomingEvents, input.derivatives, now)}

Return only JSON matching this shape:
${JSON.stringify(SIGNAL_JSON_SCHEMA.properties, null, 2)}`;
}

/* -------------------------------------------------------------------------- */
/* News classification                                                        */
/* -------------------------------------------------------------------------- */

export const NEWS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sentiment',
    'sentimentScore',
    'impact',
    'confidence',
    'reasoning',
    'affectedSymbols',
    'expectedDuration',
  ],
  properties: {
    sentiment: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
    sentimentScore: {
      type: 'integer',
      minimum: -100,
      maximum: 100,
      description: 'Directional strength. Must agree in sign with `sentiment`; 0 for neutral.',
    },
    impact: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string', description: 'One sentence on the market mechanism, not a summary of the article.' },
    affectedSymbols: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 8,
      description: 'Uppercase tickers from the provided universe only. Empty if none apply.',
    },
    expectedDuration: { type: 'string', enum: ['intraday', 'days', 'weeks', 'structural'] },
  },
};

/**
 * Classify a batch of articles in one call.
 *
 * Batched deliberately: news arrives in bursts of twenty or more, and one call
 * per article would exhaust a provider's rate limit and cost twenty times the
 * tokens for the same shared instructions. The index is echoed back so a partial
 * or reordered response can still be matched to its article.
 */
export function buildNewsPrompt(articles: NewsArticle[], universe: string[]): string {
  const items = articles
    .map((a, index) =>
      [
        `[${index}] ${a.title}`,
        a.summary ? `    Summary: ${a.summary.slice(0, 600)}` : null,
        `    Source: ${a.source}, published ${new Date(a.publishedAt).toISOString()}`,
        a.symbols.length > 0 ? `    Tagged: ${a.symbols.join(', ')}` : null,
      ]
        .filter((l) => l !== null)
        .join('\n'),
    )
    .join('\n\n');

  return `Classify each article below for its likely market effect.

TRADABLE UNIVERSE (use only these tickers in affectedSymbols)
${universe.join(', ')}

ARTICLES
${items}

Return only JSON: an object with an "results" array holding one entry per article, each entry containing "index" (the number in brackets) plus these fields:
${JSON.stringify(NEWS_JSON_SCHEMA.properties, null, 2)}`;
}

/* -------------------------------------------------------------------------- */
/* Image / chart analysis                                                     */
/* -------------------------------------------------------------------------- */

export const IMAGE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'isChart',
    'readability',
    'detectedSymbol',
    'detectedTimeframe',
    'trend',
    'summary',
    'supportLevels',
    'resistanceLevels',
    'patterns',
    'indicators',
    'orderBlocks',
    'liquidityZones',
    'breakouts',
    'tradeIdea',
    'confidence',
    'caveats',
  ],
  properties: {
    isChart: {
      type: 'boolean',
      description: 'False if the image is not a price chart. Every other field may then be empty.',
    },
    readability: {
      type: 'string',
      enum: ['clear', 'partial', 'poor'],
      description: 'How legible the chart is. "poor" means your readings are approximate.',
    },
    detectedSymbol: { type: ['string', 'null'], description: 'Ticker if visible in the image, else null.' },
    detectedTimeframe: { type: ['string', 'null'], description: 'Timeframe if visible, else null.' },
    trend: { type: 'string', enum: ['uptrend', 'downtrend', 'ranging'] },
    summary: { type: 'string', description: 'Three to five sentences on what the chart shows.' },
    supportLevels: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['price', 'confidence', 'note'],
        properties: {
          price: { type: 'number', description: 'Read from the axis. Omit the level entirely if you cannot read it.' },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          note: { type: 'string' },
        },
      },
    },
    resistanceLevels: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['price', 'confidence', 'note'],
        properties: {
          price: { type: 'number' },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          note: { type: 'string' },
        },
      },
    },
    patterns: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'direction', 'confidence'],
        properties: {
          name: { type: 'string' },
          direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
        },
      },
    },
    indicators: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'reading'],
        properties: {
          name: { type: 'string', description: 'Indicator visible on the chart, e.g. "RSI", "MACD".' },
          reading: { type: 'string', description: 'What it shows, in words. Only if actually visible.' },
        },
      },
    },
    orderBlocks: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['low', 'high', 'direction', 'note'],
        properties: {
          low: { type: 'number' },
          high: { type: 'number' },
          direction: { type: 'string', enum: ['bullish', 'bearish'] },
          note: { type: 'string' },
        },
      },
    },
    liquidityZones: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['price', 'type', 'note'],
        properties: {
          price: { type: 'number' },
          type: { type: 'string', enum: ['buy_side', 'sell_side'] },
          note: { type: 'string' },
        },
      },
    },
    breakouts: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'direction', 'confirmed', 'note'],
        properties: {
          level: { type: 'number' },
          direction: { type: 'string', enum: ['bullish', 'bearish'] },
          confirmed: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
    tradeIdea: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['action', 'entry', 'stopLoss', 'takeProfits', 'riskReward', 'rationale'],
      description:
        'Null when the chart does not present a usable setup. Levels must be read from the chart, never invented.',
      properties: {
        action: { type: 'string', enum: ['BUY', 'SELL', 'WAIT'] },
        entry: { type: ['number', 'null'] },
        stopLoss: { type: ['number', 'null'] },
        takeProfits: { type: 'array', maxItems: 3, items: { type: 'number' } },
        riskReward: { type: ['number', 'null'] },
        rationale: { type: 'string' },
      },
    },
    confidence: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Overall confidence, accounting for image quality as well as the setup itself.',
    },
    caveats: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string' },
      description: 'What you could not determine from the image.',
    },
  },
};

export interface ImagePromptInput {
  symbolHint?: string | null;
  timeframeHint?: Timeframe | string | null;
  notes?: string | null;
  /** Live analysis for the hinted symbol, when it is one we track. */
  liveContext?: {
    symbol: string;
    timeframe: Timeframe;
    price: number;
    pricePrecision: number;
    trend: string;
    confluenceScore: number;
  } | null;
}

/**
 * Build the user turn for chart-image analysis.
 *
 * When the user names a symbol we already track, the live deterministic read is
 * included — not to override the image, but so the model can flag a mismatch. A
 * screenshot from three days ago analysed as current is a real failure mode, and
 * the price disagreement is the only signal available to catch it.
 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const hints = bullet([
    input.symbolHint ? `User says this is: ${input.symbolHint}` : null,
    input.timeframeHint ? `User says the timeframe is: ${input.timeframeHint}` : null,
    input.notes ? `User's question: ${input.notes.slice(0, 1000)}` : null,
  ]);

  const live = input.liveContext
    ? `\nLIVE REFERENCE DATA (from our own feed, for cross-checking only — the image is the subject)
- ${input.liveContext.symbol} is currently ${px(input.liveContext.price, input.liveContext.pricePrecision)} on the ${input.liveContext.timeframe}, trend ${input.liveContext.trend}, net confluence ${num(input.liveContext.confluenceScore, 0)}.
- If the chart's visible price differs materially from this, say so — the screenshot may be stale.\n`
    : '';

  return `Analyse the attached chart image.

CONTEXT PROVIDED BY THE USER
${hints}
${live}
Work through: what instrument and timeframe is shown; the trend and market structure; horizontal levels you can read from the axis; chart and candlestick patterns; any indicator panes visible; order blocks, fair value gaps and liquidity zones a Smart Money reading would identify; whether a breakout is in progress; and finally whether there is a tradable setup.

State your confidence per reading. If the image is unreadable or is not a chart, set isChart or readability accordingly and leave the rest empty rather than guessing.

Return only JSON matching this shape:
${JSON.stringify(IMAGE_JSON_SCHEMA.properties, null, 2)}`;
}

/* -------------------------------------------------------------------------- */
/* Portfolio review                                                           */
/* -------------------------------------------------------------------------- */

export const PORTFOLIO_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'strengths', 'weaknesses', 'recommendations', 'riskVerdict'],
  properties: {
    assessment: { type: 'string', description: 'Three to five sentences on how this account is being traded.' },
    strengths: { type: 'array', maxItems: 4, items: { type: 'string' } },
    weaknesses: { type: 'array', maxItems: 4, items: { type: 'string' } },
    recommendations: { type: 'array', maxItems: 5, items: { type: 'string' } },
    riskVerdict: { type: 'string', enum: ['conservative', 'balanced', 'aggressive', 'reckless'] },
  },
};

export const PORTFOLIO_SYSTEM_PROMPT = `You are a trading performance coach reviewing a real account's statistics. You are direct about what the numbers show, including when they show undisciplined risk-taking. You do not congratulate a trader on a profitable month that was produced by oversized positions, and you say so when a sample is too small to conclude anything.

${NO_FABRICATION}`;
