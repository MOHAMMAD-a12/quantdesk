/**
 * The default market universe.
 *
 * Seeded into the `markets` table on first migration and editable from the
 * admin panel thereafter. The DB is authoritative at runtime; this file is the
 * bootstrap definition and the fallback when the DB is unreachable.
 *
 * `tradingViewSymbol` must be a valid TradingView ticker or the Advanced Chart
 * widget renders empty.
 */

import type { MarketSymbol } from '../types/market.js';

export const DEFAULT_MARKETS: MarketSymbol[] = [
  // -------------------------------------------------------------------------
  // Crypto — priced from Binance/Bybit (no API key required)
  // -------------------------------------------------------------------------
  {
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    assetClass: 'crypto',
    base: 'BTC',
    quote: 'USDT',
    pricePrecision: 2,
    tickSize: 0.01,
    contractSize: 1,
    tradingViewSymbol: 'BINANCE:BTCUSDT',
    scanEnabled: true,
    displayOrder: 10,
  },
  {
    symbol: 'ETHUSDT',
    name: 'Ethereum',
    assetClass: 'crypto',
    base: 'ETH',
    quote: 'USDT',
    pricePrecision: 2,
    tickSize: 0.01,
    contractSize: 1,
    tradingViewSymbol: 'BINANCE:ETHUSDT',
    scanEnabled: true,
    displayOrder: 20,
  },
  {
    symbol: 'SOLUSDT',
    name: 'Solana',
    assetClass: 'crypto',
    base: 'SOL',
    quote: 'USDT',
    pricePrecision: 3,
    tickSize: 0.001,
    contractSize: 1,
    tradingViewSymbol: 'BINANCE:SOLUSDT',
    scanEnabled: true,
    displayOrder: 30,
  },
  {
    symbol: 'BNBUSDT',
    name: 'BNB',
    assetClass: 'crypto',
    base: 'BNB',
    quote: 'USDT',
    pricePrecision: 2,
    tickSize: 0.01,
    contractSize: 1,
    tradingViewSymbol: 'BINANCE:BNBUSDT',
    scanEnabled: true,
    displayOrder: 40,
  },
  {
    symbol: 'XRPUSDT',
    name: 'XRP',
    assetClass: 'crypto',
    base: 'XRP',
    quote: 'USDT',
    pricePrecision: 4,
    tickSize: 0.0001,
    contractSize: 1,
    tradingViewSymbol: 'BINANCE:XRPUSDT',
    scanEnabled: true,
    displayOrder: 50,
  },

  // -------------------------------------------------------------------------
  // Commodities — require Twelve Data / Polygon / Alpha Vantage
  // -------------------------------------------------------------------------
  {
    symbol: 'XAUUSD',
    name: 'Gold / US Dollar',
    assetClass: 'commodity',
    base: 'XAU',
    quote: 'USD',
    pricePrecision: 2,
    tickSize: 0.01,
    contractSize: 100,
    tradingViewSymbol: 'OANDA:XAUUSD',
    scanEnabled: true,
    displayOrder: 60,
  },
  {
    symbol: 'XAGUSD',
    name: 'Silver / US Dollar',
    assetClass: 'commodity',
    base: 'XAG',
    quote: 'USD',
    pricePrecision: 3,
    tickSize: 0.001,
    contractSize: 5000,
    tradingViewSymbol: 'OANDA:XAGUSD',
    scanEnabled: true,
    displayOrder: 70,
  },

  // -------------------------------------------------------------------------
  // Forex majors — standard 100k contract, 0.0001 pip (0.01 for JPY pairs)
  // -------------------------------------------------------------------------
  {
    symbol: 'EURUSD',
    name: 'Euro / US Dollar',
    assetClass: 'forex',
    base: 'EUR',
    quote: 'USD',
    pricePrecision: 5,
    tickSize: 0.0001,
    contractSize: 100_000,
    tradingViewSymbol: 'OANDA:EURUSD',
    scanEnabled: true,
    displayOrder: 80,
  },
  {
    symbol: 'GBPUSD',
    name: 'British Pound / US Dollar',
    assetClass: 'forex',
    base: 'GBP',
    quote: 'USD',
    pricePrecision: 5,
    tickSize: 0.0001,
    contractSize: 100_000,
    tradingViewSymbol: 'OANDA:GBPUSD',
    scanEnabled: true,
    displayOrder: 90,
  },
  {
    symbol: 'USDJPY',
    name: 'US Dollar / Japanese Yen',
    assetClass: 'forex',
    base: 'USD',
    quote: 'JPY',
    pricePrecision: 3,
    tickSize: 0.01,
    contractSize: 100_000,
    tradingViewSymbol: 'OANDA:USDJPY',
    scanEnabled: true,
    displayOrder: 100,
  },

  // -------------------------------------------------------------------------
  // US equities — require Finnhub / Polygon / Twelve Data
  // -------------------------------------------------------------------------
  {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    assetClass: 'stock',
    base: 'AAPL',
    quote: 'USD',
    pricePrecision: 2,
    tickSize: 0.01,
    contractSize: 1,
    tradingViewSymbol: 'NASDAQ:AAPL',
    scanEnabled: true,
    displayOrder: 110,
  },
  {
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    assetClass: 'stock',
    base: 'NVDA',
    quote: 'USD',
    pricePrecision: 2,
    tickSize: 0.01,
    contractSize: 1,
    tradingViewSymbol: 'NASDAQ:NVDA',
    scanEnabled: true,
    displayOrder: 120,
  },
  {
    symbol: 'TSLA',
    name: 'Tesla, Inc.',
    assetClass: 'stock',
    base: 'TSLA',
    quote: 'USD',
    pricePrecision: 2,
    tickSize: 0.01,
    contractSize: 1,
    tradingViewSymbol: 'NASDAQ:TSLA',
    scanEnabled: true,
    displayOrder: 130,
  },
  {
    symbol: 'MSFT',
    name: 'Microsoft Corporation',
    assetClass: 'stock',
    base: 'MSFT',
    quote: 'USD',
    pricePrecision: 2,
    tickSize: 0.01,
    contractSize: 1,
    tradingViewSymbol: 'NASDAQ:MSFT',
    scanEnabled: false,
    displayOrder: 140,
  },

  // -------------------------------------------------------------------------
  // Indices
  // -------------------------------------------------------------------------
  {
    symbol: 'SPX',
    name: 'S&P 500 Index',
    assetClass: 'index',
    base: 'SPX',
    quote: 'USD',
    pricePrecision: 2,
    tickSize: 0.25,
    contractSize: 1,
    tradingViewSymbol: 'SP:SPX',
    scanEnabled: true,
    displayOrder: 150,
  },
  {
    symbol: 'NDX',
    name: 'Nasdaq 100 Index',
    assetClass: 'index',
    base: 'NDX',
    quote: 'USD',
    pricePrecision: 2,
    tickSize: 0.25,
    contractSize: 1,
    tradingViewSymbol: 'NASDAQ:NDX',
    scanEnabled: true,
    displayOrder: 160,
  },
  {
    symbol: 'DJI',
    name: 'Dow Jones Industrial Average',
    assetClass: 'index',
    base: 'DJI',
    quote: 'USD',
    pricePrecision: 2,
    tickSize: 1,
    contractSize: 1,
    tradingViewSymbol: 'DJ:DJI',
    scanEnabled: false,
    displayOrder: 170,
  },
];

/** Symbols used as correlation references per asset class. */
export const CORRELATION_REFERENCES: Record<string, string[]> = {
  crypto: ['BTCUSDT', 'ETHUSDT'],
  forex: ['EURUSD', 'USDJPY'],
  stock: ['SPX', 'NDX'],
  index: ['SPX'],
  commodity: ['XAUUSD'],
};

/** Fibonacci ratios used by the retracement engine. */
export const FIB_RETRACEMENTS = [0.236, 0.382, 0.5, 0.618, 0.65, 0.786] as const;
export const FIB_EXTENSIONS = [1.272, 1.414, 1.618, 2.0, 2.618] as const;

/** Default EMA/SMA periods computed for every analysis. */
export const EMA_PERIODS = [9, 21, 50, 100, 200] as const;
export const SMA_PERIODS = [20, 50, 100, 200] as const;
