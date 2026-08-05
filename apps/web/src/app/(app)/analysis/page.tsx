'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TechnicalAnalysis } from '@quantdesk/shared';
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from '@quantdesk/shared';
import { apiResult } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';

export default function AnalysisPage(): JSX.Element {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['analysis', submitted, timeframe],
    queryFn: async () => {
      const { data } = await apiResult<TechnicalAnalysis>(`/analysis/${submitted}?timeframe=${timeframe}&mtf=true&correlations=true`);
      return data;
    },
    enabled: submitted !== null,
  });

  return (
    <>
      <div className="mb-6">
        <p className="eyebrow">Analysis engine</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">Technical analysis</h1>
        <p className="mt-1 text-sm text-muted">Deterministic multi-timeframe analysis with SMC/ICT, indicators and confluence scoring.</p>
      </div>

      <div className="panel p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="text-xs font-medium text-muted">Symbol</label>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="mt-1 h-9 w-full rounded-lg border border-border bg-panel px-3 text-sm text-text placeholder:text-muted focus:border-brand" placeholder="e.g. BTCUSDT" />
          </div>
          <div className="flex gap-1">
            {TIMEFRAMES.map((tf) => (
              <Button key={tf} variant={tf === timeframe ? 'primary' : 'ghost'} size="sm" onClick={() => setTimeframe(tf)}>{TIMEFRAME_LABELS[tf]}</Button>
            ))}
          </div>
          <Button size="md" onClick={() => setSubmitted(symbol)}>Analyse</Button>
        </div>
      </div>

      {!submitted ? (
        <div className="mt-8"><EmptyState title="Select a symbol to begin" detail="Enter a symbol and timeframe, then click Analyse." /></div>
      ) : query.isLoading ? (
        <LoadingState label={`Running ${submitted} analysis…`} className="mt-8" />
      ) : query.error ? (
        <ErrorState detail="Analysis failed. Check the symbol and try again." className="mt-8" />
      ) : !query.data ? (
        <EmptyState title="No analysis returned" detail="The engine could not produce an analysis for this symbol." className="mt-8" />
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <div className="panel p-5">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold text-text">{query.data.symbol}</h2>
                <Badge tone={query.data.confluenceScore > 20 ? 'positive' : query.data.confluenceScore < -20 ? 'negative' : 'default'}>
                  {query.data.confluenceScore > 20 ? 'Bullish' : query.data.confluenceScore < -20 ? 'Bearish' : 'Neutral'}
                </Badge>
                <Badge tone="info">{TIMEFRAME_LABELS[timeframe]}</Badge>
                {query.data.synthetic && <Badge tone="warning">Synthetic</Badge>}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-4 text-center">
                <div><p className="eyebrow">Trend strength</p><p className="data-number mt-1 text-xl font-bold text-text">{query.data.trendStrength.toFixed(0)}%</p></div>
                <div><p className="eyebrow">Momentum</p><p className={cn('data-number mt-1 text-xl font-bold', query.data.momentum > 0 ? 'text-positive' : query.data.momentum < 0 ? 'text-negative' : 'text-text')}>{query.data.momentum.toFixed(0)}</p></div>
                <div><p className="eyebrow">Confluence</p><p className={cn('data-number mt-1 text-xl font-bold', query.data.confluenceScore > 0 ? 'text-positive' : query.data.confluenceScore < 0 ? 'text-negative' : 'text-text')}>{query.data.confluenceScore.toFixed(0)}</p></div>
              </div>
            </div>

            {/* Confluence factors */}
            <div className="panel p-5">
              <p className="eyebrow">Confluence factors</p>
              <div className="mt-4 space-y-2">
                {query.data.confluence.slice(0, 10).map((factor) => (
                  <div key={factor.key} className="flex items-center justify-between rounded-lg border border-border bg-panel-raised/45 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">{factor.label}</p>
                      <p className="text-[11px] text-muted">{factor.category} · weight {(factor.weight * 100).toFixed(0)}%</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="data-number text-xs text-muted">{factor.score.toFixed(0)}</span>
                      <Badge tone={factor.direction === 'bullish' ? 'positive' : factor.direction === 'bearish' ? 'negative' : 'default'}>{factor.direction}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {/* Indicators */}
            <div className="panel p-5">
              <p className="eyebrow">Indicators</p>
              <div className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-muted">RSI</span><span className="data-number font-medium text-text">{query.data.indicators.rsi.toFixed(1)}</span></div>
                <div className="flex justify-between"><span className="text-muted">RSI divergence</span><span className="font-medium text-text">{query.data.indicators.rsiDivergence ?? 'None'}</span></div>
                <div className="flex justify-between"><span className="text-muted">MACD</span><span className="data-number font-medium text-text">{query.data.indicators.macd.histogram.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-muted">ATR</span><span className="data-number font-medium text-text">{query.data.indicators.atr.toFixed(2)} ({query.data.indicators.atrPercent.toFixed(2)}%)</span></div>
                <div className="flex justify-between"><span className="text-muted">ADX</span><span className="data-number font-medium text-text">{query.data.indicators.adx.adx.toFixed(1)}</span></div>
                <div className="flex justify-between"><span className="text-muted">VWAP</span><span className="data-number font-medium text-text">{query.data.indicators.vwap.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Bollinger %B</span><span className="data-number font-medium text-text">{query.data.indicators.bollinger.percentB.toFixed(3)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Rel. volume</span><span className="data-number font-medium text-text">{query.data.indicators.relativeVolume.toFixed(2)}x</span></div>
              </div>
            </div>

            {/* SMC */}
            <div className="panel p-5">
              <p className="eyebrow">SMC / ICT</p>
              <div className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-muted">Trend</span><span className="font-medium text-text capitalize">{query.data.smc.structure.trend}</span></div>
                <div className="flex justify-between"><span className="text-muted">Clarity</span><span className="data-number font-medium text-text">{query.data.smc.structure.clarity.toFixed(0)}%</span></div>
                <div className="flex justify-between"><span className="text-muted">Premium/discount</span><span className="font-medium text-text capitalize">{query.data.smc.structure.premiumDiscount}</span></div>
                <div className="flex justify-between"><span className="text-muted">Order blocks</span><span className="data-number font-medium text-text">{query.data.smc.orderBlocks.length}</span></div>
                <div className="flex justify-between"><span className="text-muted">FVGs</span><span className="data-number font-medium text-text">{query.data.smc.fairValueGaps.length}</span></div>
                <div className="flex justify-between"><span className="text-muted">Liquidity pools</span><span className="data-number font-medium text-text">{query.data.smc.liquidityPools.length}</span></div>
                <div className="flex justify-between"><span className="text-muted">Supply/demand</span><span className="data-number font-medium text-text">{query.data.smc.supplyDemandZones.length}</span></div>
                <div className="flex justify-between"><span className="text-muted">Institutional footprint</span><span className="data-number font-medium text-text">{query.data.smc.institutionalFootprint}%</span></div>
              </div>
            </div>

            {/* Volatility */}
            <div className="panel p-5">
              <p className="eyebrow">Volatility</p>
              <div className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-muted">Regime</span><Badge tone={query.data.volatility.regime === 'compressed' ? 'info' : query.data.volatility.regime === 'elevated' || query.data.volatility.regime === 'extreme' ? 'warning' : 'default'}>{query.data.volatility.regime}</Badge></div>
                <div className="flex justify-between"><span className="text-muted">Percentile</span><span className="data-number font-medium text-text">{query.data.volatility.percentile.toFixed(0)}%</span></div>
                <div className="flex justify-between"><span className="text-muted">Squeeze</span><span className="font-medium text-text">{query.data.volatility.squeeze ? 'Yes' : 'No'}</span></div>
                <div className="flex justify-between"><span className="text-muted">Expanding</span><span className="font-medium text-text">{query.data.volatility.expanding ? 'Yes' : 'No'}</span></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
