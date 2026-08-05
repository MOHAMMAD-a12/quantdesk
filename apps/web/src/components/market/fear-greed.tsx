'use client';

import { useQuery } from '@tanstack/react-query';
import type { FearGreedIndex } from '@quantdesk/shared';
import { Gauge } from 'lucide-react';
import { apiResult } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';

async function loadFearGreed(): Promise<FearGreedIndex | null> {
  try {
    const { data } = await apiResult<FearGreedIndex>('/news/fear-greed');
    return data;
  } catch {
    return null;
  }
}

function colorForValue(value: number): string {
  if (value <= 25) return 'text-negative';
  if (value <= 45) return 'text-warning';
  if (value <= 55) return 'text-muted';
  if (value <= 75) return 'text-positive';
  return 'text-brand';
}

export function FearGreedGauge(): JSX.Element {
  const query = useQuery({ queryKey: ['fear-greed'], queryFn: loadFearGreed, refetchInterval: 300_000 });

  if (query.isLoading) return <LoadingState label="Loading sentiment gauge…" />;
  if (query.error) return <ErrorState detail="Could not load Fear & Greed index." />;

  const index = query.data;
  if (!index) return <EmptyState title="Fear & Greed unavailable" detail="The sentiment provider is not configured or unreachable." />;

  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Fear & Greed</p>
        <Badge tone="info">Crypto</Badge>
      </div>
      <div className="mt-4 flex items-center gap-4">
        <div className="grid size-14 place-items-center rounded-full bg-panel-raised">
          <Gauge className={`size-6 ${colorForValue(index.value)}`} />
        </div>
        <div>
          <p className={`data-number text-2xl font-bold ${colorForValue(index.value)}`}>{index.value}</p>
          <p className="text-xs text-muted">{index.classification} · {formatRelativeTime(index.timestamp)}</p>
          {index.previousValue !== undefined && (
            <p className="mt-0.5 text-[11px] text-muted">Previous: {index.previousValue}</p>
          )}
        </div>
      </div>
    </section>
  );
}
