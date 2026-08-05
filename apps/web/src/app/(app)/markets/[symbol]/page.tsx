'use client';

import { use } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MarketSymbol, Quote, Candle, DerivativesContext, TechnicalAnalysis } from '@quantdesk/shared';
import { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { apiResult } from '@/lib/api';
import { formatPercent, formatPrice, formatCompact } from '@/lib/utils';
import { liveSocket } from '@/lib/websocket';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';
import { cn } from '@/lib/utils';
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from '@quantdesk/shared';

export default function MarketDetailPage({ params }: { params: Promise<{ symbol: string }> }): JSX.Element {
  const { symbol } = use(params);
  const sym = symbol.toUpperCase();
  const client = useQueryClient();
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');

  const symbolQuery = useQuery({ queryKey: ['symbol', sym], queryFn: async () => { const { data } = await apiResult<MarketSymbol>(`/markets/symbols/${sym}`); return data; }, staleTime: 300_000 });
  const quoteQuery = useQuery({ queryKey: ['quote', sym], queryFn: async () => { const { data } = await apiResult<Quote>(`/markets/quote/${sym}`); return data; }, refetchInterval: 8_000 });
  const candleQuery = useQuery({ queryKey: ['candles', sym, timeframe], queryFn: async () => { const { data } = await apiResult<Candle[]>(`/markets/candles/${sym}?timeframe=${timeframe}&limit=200`); return data; } });
  const derivativesQuery = useQuery({ queryKey: ['derivatives', sym], queryFn: async () => { const { data } = await apiResult<DerivativesContext>(`/markets/derivatives/${sym}`); return data; }, retry: false, staleTime: 60_000 });
  const analysisQuery = useQuery({ queryKey: ['analysis', sym, timeframe], queryFn: async () => { const { data } = await apiResult<TechnicalAnalysis>(`/analysis/${sym}?timeframe=${timeframe}&mtf=false`); return data; } });

  useEffect(() => {
    liveSocket.subscribe([`quote:${sym}`]);
    return liveSocket.onMessage((message) => {
      if (message.type === 'quote' && message.data.symbol === sym) {
        client.setQueryData(['quote', sym], message.data);
      }
    });
  }, [client, sym]);

  if (symbolQuery.isLoading) return <LoadingState label={`Loading ${sym}…`} />;
  if (symbolQuery.error) return <ErrorState detail={sym} title="Symbol not found" />;
  const meta = symbolQuery.data;
  const quote = quoteQuery.data;
  const analysis = analysisQuery.data;
  const derivatives = derivativesQuery.data;
  const candles = candleQuery.data ?? [];
  const lastCandle = candles[candles.length - 1];
  const up = (quote?.changePercent ?? 0) >= 0;

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">{meta?.assetClass ?? 'Market'}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">{sym}</h1>
          {meta && <p className="mt-0.5 text-sm text-muted">{meta.name} · {meta.base}/{meta.quote}</p>}
        </div>
        <div className="flex items-center gap-2">
          {TIMEFRAMES.map((tf) => (
            <Button key={tf} variant={tf === timeframe ? 'primary' : 'ghost'} size="sm" onClick={() => setTimeframe(tf)}>
              {TIMEFRAME_LABELS[tf]}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {/* Price strip */}
          <div className="panel p-5">
            <div className="flex items-center gap-6">
              <div>
                <p className="data-number text-3xl font-bold tracking-tight text-text">{quote ? formatPrice(quote.price, meta?.pricePrecision ?? 2) : '—'}</p>
                {quote && (
                  <span className={cn('data-number inline-flex items-center text-sm font-semibold', up ? 'text-positive' : 'text-negative')}>
                    {up ? <ArrowUpRight className="mr-0.5 size-4" /> : <ArrowDownRight className="mr-0.5 size-4" />}
                    {formatPercent(quote.changePercent)}
                  </span>
                )}
              </div>
              {quote && (
                <div className="grid grid-cols-3 gap-6 text-xs text-muted">
                  <div><span className="block">24h High</span><span className="data-number mt-0.5 block font-medium text-text">{formatPrice(quote.high24h, meta?.pricePrecision ?? 2)}</span></div>
                  <div><span className="block">24h Low</span><span className="data-number mt-0.5 block font-medium text-text">{formatPrice(quote.low24h, meta?.pricePrecision ?? 2)}</span></div>
                  <div><span className="block">Volume</span><span className="data-number mt-0.5 block font-medium text-text">{formatCompact(quote.volume24h)}</span></div>
                </div>
              )}
            </div>
            <div className="mt-3 flex items-center gap-3">
              {/* Only live market data carries a synthetic flag; an instrument row
                  itself does not. A synthetic quote is the honest signal here. */}
              {quote?.synthetic && <Badge tone="warning">Synthetic quote</Badge>}
              {!symbolQuery.isLoading && !meta && <Badge tone="negative">Unavailable</Badge>}
            </div>
          </div>

          {/* OHLC chart placeholder */}
          <div className="panel overflow-hidden">
            <div className="panel-header">
              <p className="text-sm font-semibold">Price chart</p>
              <span className="text-xs text-muted">{candles.length} bars · {TIMEFRAME_LABELS[timeframe]}</span>
            </div>
            <div className="flex min-h-[400px] items-center justify-center bg-panel-raised/30 p-6">
              {candleQuery.isLoading ? (
                <LoadingState label="Loading candles…" />
              ) : candles.length === 0 ? (
                <EmptyState title="No candle data" detail="No provider can serve candles for this symbol and timeframe." />
              ) : (
                <div className="w-full">
                  {/* Simple sparkline visualization */}
                  <svg viewBox={`0 0 ${candles.length} 100`} className="w-full h-64" preserveAspectRatio="none">
                    {candles.map((c, i) => {
                      const min = Math.min(...candles.map((x) => x.low));
                      const max = Math.max(...candles.map((x) => x.high));
                      const range = max - min || 1;
                      const x = i;
                      const isUp = c.close >= c.open;
                      const bodyTop = Math.max(c.open, c.close);
                      const bodyBot = Math.min(c.open, c.close);
                      const yHigh = 100 - ((c.high - min) / range) * 96;
                      const yLow = 100 - ((c.low - min) / range) * 96;
                      const yBodyTop = 100 - ((bodyTop - min) / range) * 96;
                      const yBodyBot = 100 - ((bodyBot - min) / range) * 96;
                      return (
                        <g key={i}>
                          <line x1={x + 0.5} y1={yHigh} x2={x + 0.5} y2={yLow} stroke={isUp ? 'hsl(122, 86%, 34%)' : 'hsl(0, 60%, 53%)'} strokeWidth={0.4} />
                          <rect x={x} y={yBodyTop} width={0.8} height={Math.max(0.4, yBodyBot - yBodyTop)} fill={isUp ? 'hsl(122, 86%, 34%)' : 'hsl(0, 60%, 53%)'} />
                        </g>
                      );
                    })}
                  </svg>
                  <p className="mt-3 text-center text-xs text-muted">Candlestick data from provider · Hover and zoom coming soon</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Analysis */}
          <div className="panel p-5">
            <p className="eyebrow">Technical analysis</p>
            {analysisQuery.isLoading ? (
              <LoadingState label="Running analysis…" />
            ) : analysis ? (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Badge tone={analysis.trendStrength > 60 ? 'positive' : analysis.trendStrength > 30 ? 'warning' : 'default'}>Trend {analysis.trendStrength.toFixed(0)}%</Badge>
                  <Badge tone={analysis.confluenceScore > 20 ? 'positive' : analysis.confluenceScore < -20 ? 'negative' : 'default'}>
                    {analysis.confluenceScore > 20 ? 'Bullish' : analysis.confluenceScore < -20 ? 'Bearish' : 'Neutral'} bias
                  </Badge>
                </div>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between"><span className="text-muted">RSI</span><span className="data-number font-medium text-text">{analysis.indicators.rsi.toFixed(1)}</span></div>
                  <div className="flex justify-between"><span className="text-muted">ATR %</span><span className="data-number font-medium text-text">{analysis.indicators.atrPercent.toFixed(2)}%</span></div>
                  <div className="flex justify-between"><span className="text-muted">ADX</span><span className="data-number font-medium text-text">{analysis.indicators.adx.adx.toFixed(1)}</span></div>
                  <div className="flex justify-between"><span className="text-muted">Structure</span><span className="font-medium text-text capitalize">{analysis.smc.structure.trend}</span></div>
                  <div className="flex justify-between"><span className="text-muted">Order blocks</span><span className="data-number font-medium text-text">{analysis.smc.orderBlocks.length}</span></div>
                  <div className="flex justify-between"><span className="text-muted">FVGs</span><span className="data-number font-medium text-text">{analysis.smc.fairValueGaps.length}</span></div>
                </div>
                <div className="border-t border-border pt-3">
                  <p className="text-xs font-semibold text-text">Top confluence factors</p>
                  {analysis.confluence.slice(0, 5).map((factor) => (
                    <div key={factor.key} className="mt-2 flex items-center justify-between text-xs">
                      <span className="text-muted">{factor.label}</span>
                      <span className={cn('font-medium', factor.direction === 'bullish' ? 'text-positive' : factor.direction === 'bearish' ? 'text-negative' : 'text-muted')}>
                        {factor.direction}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-4 text-xs text-muted">Sign in to run a full technical analysis.</p>
            )}
          </div>

          {/* Derivatives */}
          {derivatives && (
            <div className="panel p-5">
              <p className="eyebrow">Derivatives</p>
              <div className="mt-4 space-y-2 text-xs">
                {derivatives.fundingRate !== undefined && (
                  <div className="flex justify-between"><span className="text-muted">Funding rate</span><span className={cn('data-number font-medium', derivatives.fundingRate > 0 ? 'text-positive' : derivatives.fundingRate < 0 ? 'text-negative' : 'text-text')}>{(derivatives.fundingRate * 100).toFixed(4)}%</span></div>
                )}
                {derivatives.openInterest !== undefined && (
                  <div className="flex justify-between"><span className="text-muted">Open interest</span><span className="data-number font-medium text-text">{formatCompact(derivatives.openInterest)}</span></div>
                )}
                {derivatives.openInterestChangePercent !== undefined && (
                  <div className="flex justify-between"><span className="text-muted">OI change</span><span className={cn('data-number font-medium', derivatives.openInterestChangePercent > 0 ? 'text-positive' : 'text-negative')}>{formatPercent(derivatives.openInterestChangePercent)}</span></div>
                )}
                {derivatives.longShortRatio !== undefined && (
                  <div className="flex justify-between"><span className="text-muted">Long/short</span><span className="data-number font-medium text-text">{derivatives.longShortRatio.toFixed(2)}</span></div>
                )}
              </div>
            </div>
          )}

          {/* Symbol info */}
          {meta && (
            <div className="panel p-5">
              <p className="eyebrow">Instrument</p>
              <div className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-muted">Precision</span><span className="font-medium text-text">{meta.pricePrecision} decimals</span></div>
                <div className="flex justify-between"><span className="text-muted">Tick size</span><span className="data-number font-medium text-text">{meta.tickSize}</span></div>
                <div className="flex justify-between"><span className="text-muted">Contract size</span><span className="data-number font-medium text-text">{meta.contractSize}</span></div>
                <div className="flex justify-between"><span className="text-muted">TradingView</span><span className="font-medium text-text">{meta.tradingViewSymbol}</span></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
