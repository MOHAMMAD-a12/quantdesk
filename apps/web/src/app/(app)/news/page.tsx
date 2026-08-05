'use client';

import { useQuery } from '@tanstack/react-query';
import type { NewsArticleWithAnalysis, EconomicEvent, SentimentSnapshot } from '@quantdesk/shared';
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { apiPage, apiResult } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';

export default function NewsPage(): JSX.Element {
  const [sentiment, setSentiment] = useState<'bullish' | 'bearish' | 'neutral' | undefined>(undefined);
  const [page, setPage] = useState(1);

  const newsQuery = useQuery({
    queryKey: ['news', page, sentiment],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20', hours: '168' });
      if (sentiment) params.set('sentiment', sentiment);
      return apiPage<NewsArticleWithAnalysis>(`/news?${params}`);
    },
  });

  const calendarQuery = useQuery({
    queryKey: ['calendar'],
    queryFn: async () => { const { data } = await apiResult<EconomicEvent[]>('/news/calendar'); return data; },
    staleTime: 600_000,
  });

  const sentimentQuery = useQuery({
    queryKey: ['sentiment-global'],
    queryFn: async () => {
      try { const { data } = await apiResult<SentimentSnapshot>('/news/sentiment'); return data; }
      catch { return null; }
    },
    staleTime: 300_000,
  });

  const { items, total, pageSize } = newsQuery.data ?? { items: [], total: 0, pageSize: 20 };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className="mb-6">
        <p className="eyebrow">News & sentiment</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">Market intelligence feed</h1>
        <p className="mt-1 text-sm text-muted">Headlines, sentiment analysis and the economic calendar.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          {/* Sentiment banner */}
          {sentimentQuery.data && (
            <div className="panel p-5">
              <div className="flex items-center justify-between">
                <p className="eyebrow">Aggregate sentiment</p>
                <span className="text-xs text-muted">{sentimentQuery.data.articleCount} articles · {sentimentQuery.data.windowHours}h window</span>
              </div>
              <div className="mt-3 flex items-center gap-4">
                <p className={cn('data-number text-2xl font-bold', sentimentQuery.data.score > 15 ? 'text-positive' : sentimentQuery.data.score < -15 ? 'text-negative' : 'text-text')}>
                  {sentimentQuery.data.score > 0 ? '+' : ''}{sentimentQuery.data.score}
                </p>
                <Badge tone={sentimentQuery.data.sentiment === 'bullish' ? 'positive' : sentimentQuery.data.sentiment === 'bearish' ? 'negative' : 'default'}>
                  {sentimentQuery.data.sentiment}
                </Badge>
              </div>
              <div className="mt-2 flex gap-4 text-xs text-muted">
                <span className="text-positive">{sentimentQuery.data.bullishCount} bullish</span>
                <span className="text-negative">{sentimentQuery.data.bearishCount} bearish</span>
                <span>{sentimentQuery.data.neutralCount} neutral</span>
              </div>
            </div>
          )}

          {/* Filter bar */}
          <div className="panel flex items-center gap-2 p-3">
            {([undefined, 'bullish' as const, 'bearish' as const, 'neutral' as const] as const).map((opt) => (
              <Button key={opt ?? 'all'} variant={!opt && !sentiment || opt === sentiment ? 'primary' : 'ghost'} size="sm" onClick={() => { setSentiment(opt); setPage(1); }}>
                {opt === 'bullish' ? 'Bullish' : opt === 'bearish' ? 'Bearish' : opt === 'neutral' ? 'Neutral' : 'All'}
              </Button>
            ))}
          </div>

          {/* Articles */}
          {newsQuery.isLoading ? <LoadingState label="Loading news…" /> : newsQuery.error ? (
            <ErrorState detail="Could not load news articles." />
          ) : items.length === 0 ? (
            <EmptyState title="No articles found" detail="No news articles match the current filter." />
          ) : (
            <div className="space-y-3">
              {items.map((article) => (
                <a key={article.id} href={article.url} target="_blank" rel="noopener noreferrer" className="panel block p-5 transition-colors hover:bg-panel-raised/45">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-text">{article.title}</p>
                      {article.summary && <p className="mt-1 line-clamp-2 text-xs text-muted">{article.summary}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-muted">{article.source} · {formatRelativeTime(article.publishedAt)}</span>
                        {article.analysis && (
                          <>
                            <Badge tone={article.analysis.sentiment === 'bullish' ? 'positive' : article.analysis.sentiment === 'bearish' ? 'negative' : 'default'}>{article.analysis.sentiment}</Badge>
                            <Badge tone={article.analysis.impact === 'high' || article.analysis.impact === 'critical' ? 'warning' : 'default'}>{article.analysis.impact}</Badge>
                          </>
                        )}
                        {article.symbols.slice(0, 3).map((sym) => <Badge key={sym} tone="info">{sym}</Badge>)}
                      </div>
                    </div>
                    <ExternalLink className="size-4 shrink-0 text-muted" />
                  </div>
                </a>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</Button>
              <span className="text-xs text-muted">Page {page} of {totalPages}</span>
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</Button>
            </div>
          )}
        </div>

        {/* Calendar sidebar */}
        <div className="space-y-4">
          <div className="panel p-5">
            <p className="eyebrow">Economic calendar</p>
            {calendarQuery.isLoading ? <LoadingState label="Loading calendar…" className="min-h-20" /> : calendarQuery.error ? (
              <p className="mt-4 text-xs text-muted">Calendar unavailable.</p>
            ) : (
              <div className="mt-4 max-h-[600px] space-y-3 overflow-y-auto">
                {(calendarQuery.data ?? []).slice(0, 20).map((event) => (
                  <div key={event.id} className="rounded-lg border border-border bg-panel-raised/30 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-text">{event.title}</p>
                        <p className="mt-0.5 text-[11px] text-muted">{event.currency} · {event.country}</p>
                      </div>
                      <Badge tone={event.impact === 'critical' ? 'negative' : event.impact === 'high' ? 'warning' : 'default'}>{event.impact}</Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      {new Date(event.scheduledAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} {new Date(event.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    {event.actual && (
                      <p className="mt-1 text-[11px]">
                        Actual: <strong className={event.surprise === 'beat' ? 'text-positive' : event.surprise === 'miss' ? 'text-negative' : 'text-text'}>{event.actual}</strong>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
