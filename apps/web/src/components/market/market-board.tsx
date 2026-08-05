'use client';

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MarketSymbol, Quote } from '@quantdesk/shared';
import { useEffect } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronRight, WifiOff } from 'lucide-react';
import { apiResult } from '@/lib/api';
import { formatCompact, formatPercent, formatPrice } from '@/lib/utils';
import { symbolDisplay } from '@/lib/market';
import { liveSocket } from '@/lib/websocket';
import { Badge } from '@/components/ui/badge';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';

interface SymbolsResult { symbols: MarketSymbol[]; liveData: boolean; providers: string[]; }

async function loadSymbols(): Promise<SymbolsResult> {
  const { data, meta } = await apiResult<MarketSymbol[]>('/markets/symbols');
  return { symbols: data, liveData: (meta as Record<string, unknown>)?.liveData as boolean ?? false, providers: ((meta as Record<string, unknown>)?.providers as string[]) ?? [] };
}

async function loadQuotes(symbols: string[]): Promise<Quote[]> {
  return apiResult<Quote[]>(`/markets/quotes?symbols=${encodeURIComponent(symbols.join(','))}`).then((r) => r.data);
}

export function MarketBoard(): JSX.Element {
  const client = useQueryClient();
  const symbolQuery = useQuery({ queryKey: ['market-symbols'], queryFn: loadSymbols, staleTime: 300_000 });
  const symbols = symbolQuery.data?.symbols ?? [];
  const quoteQuery = useQuery({ queryKey: ['quotes', symbols.map((item) => item.symbol).join(',')], queryFn: () => loadQuotes(symbols.map((item) => item.symbol)), enabled: symbols.length > 0, refetchInterval: 15_000 });
  const quoteBySymbol = new Map((quoteQuery.data ?? []).map((quote) => [quote.symbol, quote]));

  useEffect(() => {
    if (symbols.length === 0) return;
    const channels = ['quotes'];
    liveSocket.subscribe(channels);
    return liveSocket.onMessage((message) => {
      const updates = message.type === 'quote' ? [message.data] : message.type === 'quotes' ? message.data : [];
      if (updates.length === 0) return;
      client.setQueryData<Quote[]>(['quotes', symbols.map((item) => item.symbol).join(',')], (previous = []) => {
        const next = new Map(previous.map((quote) => [quote.symbol, quote]));
        updates.forEach((quote) => next.set(quote.symbol, quote));
        return [...next.values()];
      });
    });
  }, [client, symbols]);

  if (symbolQuery.isLoading) return <LoadingState label="Loading tracked markets…" />;
  if (symbolQuery.error) return <ErrorState detail={symbolQuery.error instanceof Error ? symbolQuery.error.message : 'Try reloading the page.'} />;
  if (symbols.length === 0) return <EmptyState title="No markets are configured" detail="An administrator needs to add instruments before the dashboard can show prices." />;

  return <section className="panel overflow-hidden"><div className="panel-header"><div><p className="text-sm font-semibold">Market board</p><p className="mt-0.5 text-xs text-muted">Live quotes across your tracked universe</p></div>{symbolQuery.data?.liveData ? <Badge tone="positive">● Live providers</Badge> : <Badge tone="warning"><WifiOff className="size-3" />Synthetic / unavailable</Badge>}</div><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="border-b border-border bg-panel-raised/45 text-[11px] uppercase tracking-[.12em] text-muted"><tr><th className="px-5 py-3 font-semibold">Market</th><th className="px-4 py-3 text-right font-semibold">Last price</th><th className="px-4 py-3 text-right font-semibold">24h change</th><th className="px-4 py-3 text-right font-semibold">24h range</th><th className="px-5 py-3 text-right font-semibold">Volume</th></tr></thead><tbody>{symbols.map((symbol) => { const quote = quoteBySymbol.get(symbol.symbol); const up = (quote?.changePercent ?? 0) >= 0; return <tr key={symbol.symbol} className="border-b border-border/70 transition-colors hover:bg-panel-raised/45"><td className="px-5 py-3.5"><Link href={`/markets/${symbol.symbol}`} className="group flex items-center gap-3"><span className="grid size-8 place-items-center rounded-lg bg-panel-raised text-xs font-bold text-brand">{symbol.base.slice(0, 2)}</span><span><span className="block font-semibold text-text group-hover:text-brand">{symbol.symbol}</span><span className="block text-xs text-muted">{symbolDisplay(symbol.symbol)} · {symbol.assetClass}</span></span></Link></td><td className="data-number px-4 py-3.5 text-right font-semibold text-text">{quote ? formatPrice(quote.price, symbol.pricePrecision) : '—'}</td><td className="px-4 py-3.5 text-right">{quote ? <span className={`data-number inline-flex items-center font-semibold ${up ? 'text-positive' : 'text-negative'}`}>{up ? <ArrowUpRight className="mr-0.5 size-3.5" /> : <ArrowDownRight className="mr-0.5 size-3.5" />}{formatPercent(quote.changePercent)}</span> : <span className="text-muted">—</span>}</td><td className="data-number px-4 py-3.5 text-right text-xs text-muted">{quote ? `${formatPrice(quote.low24h, symbol.pricePrecision)} — ${formatPrice(quote.high24h, symbol.pricePrecision)}` : '—'}</td><td className="data-number px-5 py-3.5 text-right text-muted">{quote ? formatCompact(quote.quoteVolume24h ?? quote.volume24h) : '—'}</td></tr>; })}</tbody></table></div><div className="flex items-center justify-between px-5 py-3"><p className="text-xs text-muted">{quoteQuery.isFetching ? 'Refreshing quotes…' : `${quoteBySymbol.size} of ${symbols.length} prices returned`}</p><Link href="/markets" className="inline-flex items-center text-xs font-semibold text-brand hover:underline">All markets <ChevronRight className="size-3.5" /></Link></div></section>;
}
