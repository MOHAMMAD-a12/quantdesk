'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { NewsArticleWithAnalysis } from '@quantdesk/shared';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { apiPage } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';

async function loadHeadlines(): Promise<{ items: NewsArticleWithAnalysis[]; total: number }> {
  const { items, total } = await apiPage<NewsArticleWithAnalysis>('/news?page=1&pageSize=6&hours=72');
  return { items, total };
}

export function HeadlineNews(): JSX.Element {
  const query = useQuery({ queryKey: ['news-headlines'], queryFn: loadHeadlines, refetchInterval: 300_000 });

  if (query.isLoading) return <LoadingState label="Loading market news…" />;
  if (query.error) return <ErrorState detail="Could not load headlines." />;
  const { items, total } = query.data ?? { items: [], total: 0 };
  if (items.length === 0) return <EmptyState title="No headlines available" detail="News providers have not returned any recent articles." />;

  return (
    <section className="panel overflow-hidden">
      <div className="panel-header">
        <div>
          <p className="text-sm font-semibold">Market news</p>
          <p className="mt-0.5 text-xs text-muted">{total} articles in the last 72 hours</p>
        </div>
        <Link href="/news" className="inline-flex items-center text-xs font-semibold text-brand hover:underline">
          All news <ChevronRight className="size-3.5" />
        </Link>
      </div>
      <div className="divide-y divide-border">
        {items.map((article) => (
          <a key={article.id} href={article.url} target="_blank" rel="noopener noreferrer" className="flex gap-4 px-5 py-3.5 transition-colors hover:bg-panel-raised/45">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-sm font-medium text-text">{article.title}</p>
              {article.summary && <p className="mt-1 line-clamp-1 text-xs text-muted">{article.summary}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-muted">{article.source} · {formatRelativeTime(article.publishedAt)}</span>
                {article.analysis && (
                  <Badge tone={article.analysis.sentiment === 'bullish' ? 'positive' : article.analysis.sentiment === 'bearish' ? 'negative' : 'default'}>
                    {article.analysis.sentiment} {article.analysis.impact !== 'low' ? `· ${article.analysis.impact}` : ''}
                  </Badge>
                )}
              </div>
            </div>
            <ExternalLink className="size-4 shrink-0 text-muted" />
          </a>
        ))}
      </div>
    </section>
  );
}
