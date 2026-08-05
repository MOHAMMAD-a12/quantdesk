'use client';

import { useQuery } from '@tanstack/react-query';
import type { PortfolioSummary, OpenPositionView, Trade, PerformanceStats, MonthlyReturn } from '@quantdesk/shared';

interface PerformanceReport {
  stats: PerformanceStats;
  monthly: MonthlyReturn[];
  equityCurve: Array<{ time: number; equity: number; drawdownPercent: number }>;
  bySymbol: Array<{ key: string; totalTrades: number; wins: number; losses: number; pnl: number }>;
  byTag: Array<{ key: string; totalTrades: number; wins: number; losses: number; pnl: number }>;
  bySide: Array<{ key: string; totalTrades: number; wins: number; losses: number; pnl: number }>;
  from: number | null;
  to: number | null;
}
import { useState } from 'react';
import { apiResult, apiPage } from '@/lib/api';
import { formatPercent, formatPrice, formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatCard } from '@/components/ui/stat-card';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';

export default function PortfolioPage(): JSX.Element {
  const [tab, setTab] = useState<'summary' | 'positions' | 'journal'>('summary');

  const summaryQuery = useQuery({ queryKey: ['portfolio-summary'], queryFn: async () => { const { data } = await apiResult<PortfolioSummary>('/portfolio/summary'); return data; } });
  const performanceQuery = useQuery({ queryKey: ['portfolio-performance'], queryFn: async () => { const { data } = await apiResult<PerformanceReport>('/portfolio/performance'); return data; }, retry: false });
  const positionsQuery = useQuery({ queryKey: ['portfolio-positions'], queryFn: async () => { const { data } = await apiResult<OpenPositionView[]>('/portfolio/positions'); return data; } });
  const journalQuery = useQuery({ queryKey: ['portfolio-trades'], queryFn: async () => { return apiPage<Trade>('/portfolio/trades?page=1&pageSize=10'); } });

  const summary = summaryQuery.data;
  const performance = performanceQuery.data;

  return (
    <>
      <div className="mb-6">
        <p className="eyebrow">Portfolio</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">Trading journal & performance</h1>
      </div>

      {/* Summary cards */}
      {summaryQuery.isLoading ? <LoadingState label="Loading portfolio…" /> : summaryQuery.error ? (
        <ErrorState detail="Could not load portfolio summary." />
      ) : summary ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Equity" value={`$${formatPrice(summary.equity, 0)}`} change={summary.totalPnlPercent} detail={`Balance: $${formatPrice(summary.balance, 0)}`} />
          <StatCard label="Realised PnL" value={`$${formatPrice(summary.realisedPnl, 0)}`} detail={`${summary.closedTrades} closed trades`} />
          <StatCard label="Open positions" value={String(summary.openTrades)} detail={`Risk: ${summary.openRiskPercent.toFixed(1)}%`} />
          <StatCard label="Unrealised PnL" value={`$${formatPrice(summary.unrealisedPnl, 0)}`} change={summary.unrealisedPnl > 0 ? 0.5 : summary.unrealisedPnl < 0 ? -0.5 : null} />
        </div>
      ) : null}

      {/* Performance stats */}
      {performance && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Win rate" value={`${(performance.stats.winRate * 100).toFixed(1)}%`} detail={`${performance.stats.wins}W / ${performance.stats.losses}L`} />
          <StatCard label="Profit factor" value={performance.stats.profitFactor.toFixed(2)} />
          <StatCard label="Expectancy" value={`${performance.stats.expectancy.toFixed(2)}R`} />
          <StatCard label="Sharpe ratio" value={performance.stats.sharpeRatio.toFixed(2)} />
          <StatCard label="Max drawdown" value={`${performance.stats.maxDrawdownPercent.toFixed(1)}%`} />
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-border">
        {(['summary', 'positions', 'journal'] as const).map((t) => (
          <button key={t} className={cn('border-b-2 px-4 py-2.5 text-sm font-medium capitalize transition-colors', tab === t ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-text')} onClick={() => setTab(t)}>
            {t === 'journal' ? 'Trade journal' : t}
          </button>
        ))}
      </div>

      {tab === 'positions' && (
        positionsQuery.isLoading ? <LoadingState label="Loading positions…" /> : positionsQuery.error ? <ErrorState detail="Could not load open positions." /> :
        (positionsQuery.data ?? []).length === 0 ? <EmptyState title="No open positions" detail="All trades are currently closed." /> : (
          <div className="space-y-3">
            {positionsQuery.data!.map((pos) => (
              <div key={pos.id} className="panel flex items-center gap-5 p-5">
                <Badge tone={pos.side === 'long' ? 'positive' : 'negative'}>{pos.side}</Badge>
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-text">{pos.symbol}</span>
                  <span className="ml-2 text-xs text-muted">{pos.quantity} @ {formatPrice(pos.entryPrice)}</span>
                </div>
                <div className="data-number text-sm font-semibold text-text">{formatPrice(pos.currentPrice)}</div>
                <div className={cn('data-number text-sm font-semibold', pos.unrealisedPnl >= 0 ? 'text-positive' : 'text-negative')}>
                  {formatPercent(pos.unrealisedPnlPercent)}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'journal' && (
        journalQuery.isLoading ? <LoadingState label="Loading trades…" /> : journalQuery.error ? <ErrorState detail="Could not load trade journal." /> :
        (journalQuery.data?.items ?? []).length === 0 ? <EmptyState title="No trades recorded" detail="Open positions will appear here once logged." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-[11px] uppercase tracking-[.12em] text-muted">
                <tr><th className="px-4 py-3 font-semibold">Symbol</th><th className="px-4 py-3 font-semibold">Side</th><th className="px-4 py-3 text-right font-semibold">Entry</th><th className="px-4 py-3 text-right font-semibold">Exit</th><th className="px-4 py-3 text-right font-semibold">PnL</th><th className="px-4 py-3 text-right font-semibold">R</th><th className="px-4 py-3 font-semibold">Status</th></tr>
              </thead>
              <tbody>
                {journalQuery.data!.items.map((trade) => (
                  <tr key={trade.id} className="border-b border-border/70">
                    <td className="px-4 py-3 font-medium text-text">{trade.symbol}</td>
                    <td className="px-4 py-3"><Badge tone={trade.side === 'long' ? 'positive' : 'negative'}>{trade.side}</Badge></td>
                    <td className="data-number px-4 py-3 text-right">{formatPrice(trade.entryPrice)}</td>
                    <td className="data-number px-4 py-3 text-right">{trade.exitPrice ? formatPrice(trade.exitPrice) : '—'}</td>
                    <td className={cn('data-number px-4 py-3 text-right font-medium', (trade.pnl ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>{trade.pnl !== null ? `$${formatPrice(trade.pnl, 2)}` : '—'}</td>
                    <td className={cn('data-number px-4 py-3 text-right font-medium', (trade.rMultiple ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>{trade.rMultiple !== null ? `${trade.rMultiple.toFixed(2)}R` : '—'}</td>
                    <td className="px-4 py-3"><Badge tone={trade.status === 'closed' ? 'default' : trade.status === 'open' ? 'positive' : 'warning'}>{trade.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === 'summary' && performance && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="panel p-5">
            <p className="eyebrow">Performance summary</p>
            <div className="mt-4 space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-muted">Total trades</span><span className="data-number font-medium text-text">{performance.stats.totalTrades}</span></div>
              <div className="flex justify-between"><span className="text-muted">Wins / Losses</span><span className="data-number font-medium text-text">{performance.stats.wins} / {performance.stats.losses}</span></div>
              <div className="flex justify-between"><span className="text-muted">Avg win</span><span className="data-number font-medium text-positive">{formatPrice(performance.stats.avgWin)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Avg loss</span><span className="data-number font-medium text-negative">{formatPrice(performance.stats.avgLoss)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Avg R:R</span><span className="data-number font-medium text-text">{performance.stats.avgRiskReward.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Sortino ratio</span><span className="data-number font-medium text-text">{performance.stats.sortinoRatio.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Max win streak</span><span className="data-number font-medium text-text">{performance.stats.maxWinStreak}</span></div>
              <div className="flex justify-between"><span className="text-muted">Max loss streak</span><span className="data-number font-medium text-text">{performance.stats.maxLossStreak}</span></div>
            </div>
          </div>
          <div className="panel p-5">
            <p className="eyebrow">Monthly returns</p>
            <div className="mt-4 space-y-2">
              {performance.monthly.slice(0, 12).map((month) => (
                <div key={month.month} className="flex items-center justify-between text-xs">
                  <span className="text-muted">{month.month}</span>
                  <span className={cn('data-number font-medium', month.pnl >= 0 ? 'text-positive' : 'text-negative')}>{formatPercent(month.pnlPercent)} · {month.trades} trades</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
