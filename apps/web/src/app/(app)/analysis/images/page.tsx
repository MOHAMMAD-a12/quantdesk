'use client';

import { useQuery } from '@tanstack/react-query';
import type { ImageAnalysis } from '@quantdesk/shared';
import { Upload, Eye } from 'lucide-react';
import { apiPage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';
import { formatRelativeTime } from '@/lib/utils';

export default function ImageAnalysisPage(): JSX.Element {
  const query = useQuery({ queryKey: ['image-analyses'], queryFn: async () => { return apiPage<ImageAnalysis>('/images?page=1&pageSize=20'); } });

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">Chart analysis</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">Image upload</h1>
          <p className="mt-1 text-sm text-muted">Upload TradingView, Binance, Bybit or MetaTrader screenshots for AI-powered analysis.</p>
        </div>
        <Button>
          <Upload className="size-4" /> Upload screenshot
        </Button>
      </div>

      {query.isLoading ? <LoadingState label="Loading analyses…" /> : query.error ? (
        <ErrorState detail="Could not load image analyses." />
      ) : (query.data?.items ?? []).length === 0 ? (
        <EmptyState title="No uploads yet" detail="Upload a chart screenshot and the AI will detect trend, support, resistance, patterns, order blocks, and more." />
      ) : (
        <div className="space-y-3">
          {query.data!.items.map((item) => (
            <div key={item.id} className="panel flex items-center gap-5 p-5">
              <span className="grid size-10 place-items-center rounded-xl bg-panel-raised">
                <Eye className="size-5 text-brand" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-text">{item.fileName}</span>
                  <Badge tone={item.status === 'completed' ? 'positive' : item.status === 'failed' ? 'negative' : item.status === 'processing' ? 'warning' : 'default'}>{item.status}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {item.mimeType} · {(item.fileSize / 1024).toFixed(0)}KB · {formatRelativeTime(item.createdAt)}
                </p>
                {item.report && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge tone="info">{item.report.trend}</Badge>
                    {item.report.detectedSymbol && <Badge tone="default">{item.report.detectedSymbol}</Badge>}
                    {item.report.detectedTimeframe && <Badge tone="default">{item.report.detectedTimeframe}</Badge>}
                    <Badge tone={item.report.confidence > 60 ? 'positive' : 'warning'}>{item.report.confidence}% confidence</Badge>
                  </div>
                )}
                {item.error && <p className="mt-1 text-xs text-negative">{item.error}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
