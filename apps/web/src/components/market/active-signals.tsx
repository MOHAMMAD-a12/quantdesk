'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { Signal } from '@quantdesk/shared';
import { ArrowUpRight, ArrowDownRight, Clock, ChevronRight, Minus } from 'lucide-react';
import { apiResult } from '@/lib/api';
import { formatPercent, formatPrice, formatRelativeTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';
import { cn } from '@/lib/utils';

async function loadActiveSignals(): Promise<Signal[]> {
  const { data } = await apiResult<Signal[]>('/signals/active');
  return data;
}

function actionBadge(action: Signal['action']): JSX.Element {
  if (action === 'BUY') return <Badge tone="positive">Long</Badge>;
  if (action === 'SELL') return <Badge tone="negative">Short</Badge>;
  return <Badge tone="default">Wait</Badge>;
}

function qualityBadge(quality: Signal['quality']): JSX.Element {
  const tone = quality === 'premium' || quality === 'high' ? 'info' : quality === 'good' ? 'positive' : quality === 'fair' ? 'warning' : 'default';
  return <Badge tone={tone}>{quality}</Badge>;
}

export function ActiveSignals(): JSX.Element {
  const query = useQuery({ queryKey: ['signals-active'], queryFn: loadActiveSignals, refetchInterval: 30_000 });

  if (query.isLoading) return <LoadingState label="Loading active signals…" />;
  if (query.error) return <ErrorState detail="Could not load active signals." />;
  const signals = query.data ?? [];
  if (signals.length === 0) return <EmptyState title="No active signals" detail="The engine has not flagged any setups above the confidence threshold yet." />;

  return (
    <section className="panel overflow-hidden">
      <div className="panel-header">
        <div>
          <p className="text-sm font-semibold">Active AI signals</p>
          <p className="mt-0.5 text-xs text-muted">Setups above the confidence threshold</p>
        </div>
        <Link href="/signals" className="inline-flex items-center text-xs font-semibold text-brand hover:underline">
          View all <ChevronRight className="size-3.5" />
        </Link>
      </div>
      <div className="divide-y divide-border">
        {signals.slice(0, 6).map((signal) => (
          <Link key={signal.id} href={`/signals/${signal.id}`} className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-panel-raised/45">
            <span className="grid size-8 place-items-center rounded-lg bg-panel-raised text-xs font-bold text-brand">{signal.symbol.slice(0, 2)}</span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2">
                <span className="font-semibold text-text">{signal.symbol}</span>
                {actionBadge(signal.action)}
                {qualityBadge(signal.quality)}
              </span>
              <span className="mt-0.5 block text-xs text-muted">{signal.timeframe} · {signal.reasoning.slice(0, 72)}…</span>
            </span>
            <span className="hidden text-right sm:block">
              {signal.entry !== null && <span className="data-number block text-xs text-muted">Entry {formatPrice(signal.entry, 2)}</span>}
              <span className="data-number block text-xs font-semibold text-brand">{signal.confidence.toFixed(0)}% confidence</span>
            </span>
            <ChevronRight className="size-4 text-muted" />
          </Link>
        ))}
      </div>
    </section>
  );
}
