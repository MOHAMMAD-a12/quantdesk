'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Signal } from '@quantdesk/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { apiPage } from '@/lib/api';
import { formatPrice } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';
import { liveSocket } from '@/lib/websocket';

export default function SignalsPage(): JSX.Element {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<'BUY' | 'SELL' | undefined>(undefined);
  const client = useQueryClient();

  const query = useQuery({
    queryKey: ['signals', page, action],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '15' });
      if (action) params.set('action', action);
      return apiPage<Signal>(`/signals?${params}`);
    },
  });

  useEffect(() => {
    liveSocket.subscribe(['signals']);
    return liveSocket.onMessage((message) => {
      if (message.type === 'signal') {
        client.invalidateQueries({ queryKey: ['signals'] });
      }
    });
  }, [client]);

  const { items, total, pageSize } = query.data ?? { items: [], total: 0, pageSize: 15 };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">AI signals</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">Signal history</h1>
          <p className="mt-1 text-sm text-muted">{total} signals generated · New setups appear automatically</p>
        </div>
        <div className="flex items-center gap-2">
          {([undefined, 'BUY' as const, 'SELL' as const] as const).map((opt) => (
            <Button key={opt ?? 'all'} variant={!opt && !action || opt === action ? 'primary' : 'ghost'} size="sm" onClick={() => { setAction(opt); setPage(1); }}>
              {opt === 'BUY' ? 'Long' : opt === 'SELL' ? 'Short' : 'All'}
            </Button>
          ))}
        </div>
      </div>

      {query.isLoading ? <LoadingState label="Loading signals…" /> : query.error ? <ErrorState detail="Could not load signals." /> : items.length === 0 ? (
        <EmptyState title="No signals found" detail={action ? `No ${action} signals in the current view.` : 'The engine has not produced any signals yet.'} />
      ) : (
        <div className="space-y-3">
          {items.map((signal) => (
            <Link key={signal.id} href={`/signals/${signal.id}`} className="panel flex items-center gap-5 p-5 transition-colors hover:bg-panel-raised/45">
              <span className="grid size-10 place-items-center rounded-xl bg-panel-raised text-sm font-bold text-brand">{signal.symbol.slice(0, 2)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-text">{signal.symbol}</span>
                  <Badge tone={signal.action === 'BUY' ? 'positive' : signal.action === 'SELL' ? 'negative' : 'default'}>
                    {signal.action}
                  </Badge>
                  <Badge tone={signal.quality === 'premium' || signal.quality === 'high' ? 'info' : signal.quality === 'good' ? 'positive' : 'warning'}>
                    {signal.quality}
                  </Badge>
                  <span className="text-xs text-muted">{signal.timeframe}</span>
                </div>
                <p className="mt-1 line-clamp-1 text-xs text-muted">{signal.reasoning.slice(0, 100)}…</p>
              </div>
              <div className="hidden flex-col items-end gap-1 text-right text-xs sm:flex">
                {signal.entry !== null && <span className="data-number text-muted">Entry {formatPrice(signal.entry, 2)}</span>}
                <span className="data-number font-semibold text-brand">{signal.confidence.toFixed(0)}% confidence</span>
                {signal.riskRewardRatio !== null && <span className="data-number text-muted">R:R {signal.riskRewardRatio.toFixed(2)}</span>}
              </div>
              <ChevronRight className="size-4 text-muted" />
            </Link>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="size-3.5" /> Previous</Button>
          <span className="text-xs text-muted">Page {page} of {totalPages}</span>
          <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight className="size-3.5" /></Button>
        </div>
      )}
    </>
  );
}
