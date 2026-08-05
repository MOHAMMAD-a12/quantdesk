/**
 * News, sentiment, economic calendar and AI provider types.
 */

export type NewsSentiment = 'bullish' | 'bearish' | 'neutral';
export type NewsImpact = 'low' | 'medium' | 'high' | 'critical';

export interface NewsArticle {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  imageUrl: string | null;
  publishedAt: number;
  /** Symbols/tickers the article is about. */
  symbols: string[];
  categories: string[];
}

/** AI-scored interpretation of an article. */
export interface NewsAnalysis {
  articleId: string;
  sentiment: NewsSentiment;
  /** -100 (max bearish) .. 100 (max bullish). */
  sentimentScore: number;
  impact: NewsImpact;
  /** 0–100 model confidence in the classification. */
  confidence: number;
  /** One-line explanation of the market read. */
  reasoning: string;
  /** Instruments most likely to move. */
  affectedSymbols: string[];
  /** How long the effect is expected to persist. */
  expectedDuration: 'intraday' | 'days' | 'weeks' | 'structural';
  analysedAt: number;
  aiProvider: string;
}

export interface NewsArticleWithAnalysis extends NewsArticle {
  analysis: NewsAnalysis | null;
}

/** Aggregate sentiment over a window, per symbol or market-wide. */
export interface SentimentSnapshot {
  scope: string;
  /** -100..100. */
  score: number;
  sentiment: NewsSentiment;
  articleCount: number;
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  /** Change vs. the previous window. */
  momentum: number;
  windowHours: number;
  computedAt: number;
}

// ---------------------------------------------------------------------------
// Economic calendar
// ---------------------------------------------------------------------------

export type EconomicEventCategory =
  | 'interest_rate'
  | 'cpi'
  | 'nfp'
  | 'fomc'
  | 'gdp'
  | 'pmi'
  | 'employment'
  | 'retail_sales'
  | 'crypto'
  | 'other';

export interface EconomicEvent {
  id: string;
  title: string;
  country: string;
  currency: string;
  category: EconomicEventCategory;
  impact: NewsImpact;
  scheduledAt: number;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  /** Derived once `actual` lands: beat / miss / inline. */
  surprise: 'beat' | 'miss' | 'inline' | null;
  /** Directional read for the affected currency. */
  sentiment: NewsSentiment | null;
}

// ---------------------------------------------------------------------------
// AI provider abstraction
// ---------------------------------------------------------------------------

export const AI_PROVIDERS = ['anthropic', 'openai', 'gemini', 'local'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/** Admin-configurable AI settings, persisted in the DB and hot-swappable. */
export interface AiSettings {
  activeProvider: AiProviderName;
  /** Per-provider model override; falls back to env defaults when null. */
  models: Partial<Record<AiProviderName, string>>;
  visionModels: Partial<Record<AiProviderName, string>>;
  temperature: number;
  maxTokens: number;
  /** Providers tried in order if the active one errors. Empty = no fallback. */
  fallbackChain: AiProviderName[];
  /** Hard ceiling on AI calls per user per day, by role. */
  dailyQuota: Record<string, number>;
  /** When false, the platform runs deterministic-only (no LLM calls). */
  aiEnabled: boolean;
  updatedAt: number;
  updatedBy: string | null;
}

/** Health/status of a configured provider, surfaced in the admin panel. */
export interface AiProviderStatus {
  name: AiProviderName;
  configured: boolean;
  reachable: boolean;
  model: string | null;
  visionCapable: boolean;
  lastCheckedAt: number;
  lastError: string | null;
  /** Rolling average latency in ms. */
  avgLatencyMs: number | null;
}

/** Normalised usage accounting across providers. */
export interface AiUsageRecord {
  id: string;
  userId: string | null;
  provider: AiProviderName;
  model: string;
  /** e.g. `signal`, `image_analysis`, `news`. */
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  error: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Image (chart screenshot) analysis
// ---------------------------------------------------------------------------

export const SUPPORTED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME)[number];

export type ImageAnalysisStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** A level the vision model read off the chart. */
export interface DetectedLevel {
  price: number | null;
  /** Vertical position 0–1 when the model can't read an axis value. */
  relativePosition?: number;
  label: string;
  kind: 'support' | 'resistance' | 'entry' | 'stop_loss' | 'take_profit' | 'other';
  confidence: number;
}

export interface DetectedZone {
  kind: 'order_block' | 'supply' | 'demand' | 'fvg' | 'liquidity';
  direction: 'bullish' | 'bearish' | 'neutral';
  top: number | null;
  bottom: number | null;
  note: string;
  confidence: number;
}

/** The structured report produced from an uploaded chart screenshot. */
export interface ImageAnalysisReport {
  /** What the model believes it is looking at. */
  detectedPlatform: string | null;
  detectedSymbol: string | null;
  detectedTimeframe: string | null;
  /** Whether an axis was legible enough to trust absolute prices. */
  priceScaleReadable: boolean;

  trend: 'uptrend' | 'downtrend' | 'ranging' | 'unclear';
  trendNote: string;

  supports: DetectedLevel[];
  resistances: DetectedLevel[];
  zones: DetectedZone[];
  patterns: string[];
  indicatorsVisible: string[];
  breakouts: string[];

  /** Proposed trade, when the model finds a valid setup. */
  bias: 'long' | 'short' | 'neutral';
  entry: number | null;
  stopLoss: number | null;
  takeProfits: number[];
  riskRewardRatio: number | null;

  /** Long-form narrative report. */
  report: string;
  /** 0–100 — how confident the model is in the overall read. */
  confidence: number;
  warnings: string[];
}

export interface ImageAnalysis {
  id: string;
  userId: string;
  status: ImageAnalysisStatus;
  fileName: string;
  mimeType: SupportedImageMime;
  fileSize: number;
  /** Served via the authenticated media route, never a raw disk path. */
  imageUrl: string;
  /** Optional user-supplied context, e.g. "BTC 4H, looking for longs". */
  userNote: string | null;
  report: ImageAnalysisReport | null;
  error: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  createdAt: number;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Delivery channels.
 *
 * `in_app` is always available and cannot be disabled: it is the record of what
 * the platform decided to tell you, and it is written even when every external
 * channel is off or suppressed. The others are opt-in and each needs a
 * destination configured before it can be enabled.
 */
export const NOTIFICATION_CHANNELS = [
  'in_app',
  'email',
  'telegram',
  'discord',
  'web_push',
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type NotificationKind =
  | 'signal'
  | 'price_alert'
  | 'news'
  | 'risk_breach'
  | 'drawdown'
  | 'system';

export type NotificationStatus = 'queued' | 'sent' | 'failed' | 'suppressed';

export interface NotificationRecord {
  id: string;
  userId: string;
  channel: NotificationChannel;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Deep link into the app. */
  link: string | null;
  /** The signal that triggered this, when there was one. */
  signalId: string | null;
  status: NotificationStatus;
  /** Why it was suppressed (quiet hours, below threshold, channel off). */
  suppressionReason: string | null;
  error: string | null;
  /** Null while unread. Only meaningful for the `in_app` channel. */
  readAt: number | null;
  createdAt: number;
  sentAt: number | null;
}
