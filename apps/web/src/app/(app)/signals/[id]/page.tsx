'use client';

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Signal } from '@quantdesk/shared';
import Link from 'next/link';
import { ArrowLeft, Zap } from 'lucide-react';
import { apiResult } from '@/lib/api';
import { formatPrice } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ErrorState, LoadingState } from '@/components/ui/state';

export default function SignalDetailPage({ params }: { params: Promise<{ id: string }> }): JSX.Element {
  const { id } = use(params);
  const query = useQuery({ queryKey: ['signal', id], queryFn: async () => { const { data } = await apiResult<Signal>(`/signals/${id}`); return data; } });

  if (query.isLoading) return <LoadingState label="Loading signal…" />;
  if (query.error || !query.data) return <ErrorState detail="Signal not found or inaccessible." />;

  const s = query.data;
  const up = s.action === 'BUY';

  return (
    <>
      <Link href="/signals" className="mb-4 inline-flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-text"><ArrowLeft className="size-3.5" /> Back to signals</Link>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          {/* Signal header */}
          <div className="panel p-6">
            <div className="flex flex-wrap items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-panel-raised text-sm font-bold text-brand">{s.symbol.slice(0, 2)}</span>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold text-text">{s.symbol}</h1>
                  <Badge tone={up ? 'positive' : s.action === 'SELL' ? 'negative' : 'default'}>{s.action}</Badge>
                  <Badge tone={s.quality === 'premium' || s.quality === 'high' ? 'info' : 'warning'}>{s.quality}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted">{s.timeframe} · {s.aiProvider}/{s.aiModel} · {new Date(s.createdAt).toLocaleString()}</p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div><p className="eyebrow">Confidence</p><p className="data-number mt-1 text-2xl font-bold text-brand">{s.confidence.toFixed(0)}%</p></div>
              <div><p className="eyebrow">Probability</p><p className="data-number mt-1 text-2xl font-bold text-text">{s.probabilityScore.toFixed(0)}%</p></div>
              <div><p className="eyebrow">R:R</p><p className="data-number mt-1 text-2xl font-bold text-text">{s.riskRewardRatio?.toFixed(2) ?? '—'}</p></div>
              <div><p className="eyebrow">Risk score</p><p className={cn('data-number mt-1 text-2xl font-bold', s.riskScore > 60 ? 'text-negative' : s.riskScore > 35 ? 'text-warning' : 'text-positive')}>{s.riskScore.toFixed(0)}</p></div>
            </div>
          </div>

          {/* Trade levels */}
          <div className="panel p-5">
            <p className="eyebrow">Trade levels</p>
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between text-sm"><span className="text-muted">Entry</span><span className="data-number font-semibold text-text">{s.entry !== null ? formatPrice(s.entry, 2) : '—'}</span></div>
              <div className="flex items-center justify-between text-sm"><span className="text-muted">Stop loss</span><span className="data-number font-semibold text-negative">{s.stopLoss !== null ? formatPrice(s.stopLoss, 2) : '—'}</span></div>
              {s.takeProfits.map((tp) => (
                <div key={tp.level} className="flex items-center justify-between text-sm"><span className="text-muted">TP{tp.level} ({(tp.allocation * 100).toFixed(0)}%)</span><span className="data-number font-semibold text-positive">{formatPrice(tp.price, 2)}</span></div>
              ))}
              {s.entryZone && (
                <div className="flex items-center justify-between text-sm"><span className="text-muted">Entry zone</span><span className="data-number text-xs text-muted">{formatPrice(s.entryZone.low, 2)} — {formatPrice(s.entryZone.high, 2)}</span></div>
              )}
            </div>
          </div>

          {/* Narrative */}
          <div className="panel p-5">
            <p className="eyebrow">AI reasoning</p>
            <div className="mt-4 space-y-4 text-sm leading-relaxed text-text">
              <p>{s.reasoning}</p>
              {s.marketStructureExplanation && (
                <div className="border-t border-border pt-4">
                  <p className="eyebrow mb-2">Market structure</p>
                  <p>{s.marketStructureExplanation}</p>
                </div>
              )}
            </div>
          </div>

          {/* Key factors */}
          {s.keyFactors.length > 0 && (
            <div className="panel p-5">
              <p className="eyebrow">Key factors</p>
              <ul className="mt-3 space-y-2 text-sm text-text">
                {s.keyFactors.map((factor, i) => <li key={i} className="flex items-start gap-2"><Zap className="mt-0.5 size-3.5 shrink-0 text-brand" />{factor}</li>)}
              </ul>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Confidence breakdown */}
          <div className="panel p-5">
            <p className="eyebrow">Confidence breakdown</p>
            <div className="mt-4 space-y-3">
              {([
                ['Technical', s.confidenceBreakdown.technical],
                ['MTF alignment', s.confidenceBreakdown.mtfAlignment],
                ['Structure', s.confidenceBreakdown.structure],
                ['Volume', s.confidenceBreakdown.volume],
                ['Sentiment', s.confidenceBreakdown.sentiment],
                ['AI conviction', s.confidenceBreakdown.aiConviction],
              ] as const).map(([label, value]) => (
                <div key={label}>
                  <div className="flex items-center justify-between text-xs"><span className="text-muted">{label}</span><span className="data-number font-medium text-text">{value}%</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-raised"><div className="h-full rounded-full bg-brand" style={{ width: `${value}%` }} /></div>
                </div>
              ))}
            </div>
          </div>

          {/* Status */}
          <div className="panel p-5">
            <p className="eyebrow">Status</p>
            <div className="mt-4 space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-muted">Status</span><Badge tone={s.status === 'active' ? 'positive' : s.status === 'stopped_out' ? 'negative' : 'default'}>{s.status}</Badge></div>
              <div className="flex justify-between"><span className="text-muted">Trend</span><span className="font-medium text-text capitalize">{s.trendDirection}</span></div>
              <div className="flex justify-between"><span className="text-muted">Bias</span><span className="font-medium text-text capitalize">{s.bias}</span></div>
              <div className="flex justify-between"><span className="text-muted">Expected duration</span><span className="font-medium text-text">{s.expectedDuration}</span></div>
              <div className="flex justify-between"><span className="text-muted">Expected move</span><span className="data-number font-medium text-text">{s.expectedMovePercent.toFixed(2)}%</span></div>
              {s.realisedR !== undefined && <div className="flex justify-between"><span className="text-muted">Realised R</span><span className={cn('data-number font-medium', (s.realisedR ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>{s.realisedR?.toFixed(2)}</span></div>}
            </div>
          </div>

          {/* Invalidation */}
          {s.invalidation && (
            <div className="panel border-negative/30 p-5">
              <p className="eyebrow text-negative">Invalidation</p>
              <p className="mt-3 text-xs text-muted">{s.invalidation}</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
