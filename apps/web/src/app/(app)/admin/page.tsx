'use client';

import { useQuery } from '@tanstack/react-query';
import { apiResult } from '@/lib/api';
import { StatCard } from '@/components/ui/stat-card';
import { ErrorState, LoadingState } from '@/components/ui/state';

interface PlatformStats {
  users: { total: number; active: number; premium: number; admin: number; newLast7Days: number };
  signals: { total: number; last24h: number; active: number };
  trades: { open: number; closedLast30Days: number };
  images: { last24h: number };
  ai: { callsLast24h: number; failuresLast24h: number; tokensLast24h: number };
  notifications: { sentLast24h: number; failedLast24h: number; suppressedLast24h: number };
}

export default function AdminPage(): JSX.Element {
  const statsQuery = useQuery({ queryKey: ['admin-stats'], queryFn: async () => { const { data } = await apiResult<PlatformStats>('/admin/stats'); return data; } });

  if (statsQuery.isLoading) return <LoadingState label="Loading platform stats…" />;
  if (statsQuery.error) return <ErrorState detail="Admin access required." />;

  const stats = statsQuery.data;
  if (!stats) return <ErrorState detail="No stats returned." />;

  return (
    <>
      <div className="mb-6">
        <p className="eyebrow">Admin</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">Platform dashboard</h1>
        <p className="mt-1 text-sm text-muted">System health, user activity and operational metrics.</p>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active users" value={String(stats.users.active)} detail={`${stats.users.total} total · ${stats.users.premium} premium`} />
        <StatCard label="Active signals" value={String(stats.signals.active)} detail={`${stats.signals.last24h} in 24h`} />
        <StatCard label="Open trades" value={String(stats.trades.open)} detail={`${stats.trades.closedLast30Days} closed (30d)`} />
        <StatCard label="AI calls (24h)" value={String(stats.ai.callsLast24h)} detail={`${stats.ai.failuresLast24h} failures`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-5">
          <p className="eyebrow">Users</p>
          <div className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between"><span className="text-muted">Total</span><span className="data-number font-medium text-text">{stats.users.total}</span></div>
            <div className="flex justify-between"><span className="text-muted">Active</span><span className="data-number font-medium text-text">{stats.users.active}</span></div>
            <div className="flex justify-between"><span className="text-muted">Premium</span><span className="data-number font-medium text-text">{stats.users.premium}</span></div>
            <div className="flex justify-between"><span className="text-muted">Admin</span><span className="data-number font-medium text-text">{stats.users.admin}</span></div>
            <div className="flex justify-between"><span className="text-muted">New (7d)</span><span className="data-number font-medium text-text">{stats.users.newLast7Days}</span></div>
          </div>
        </div>
        <div className="panel p-5">
          <p className="eyebrow">Notifications (24h)</p>
          <div className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between"><span className="text-muted">Sent</span><span className="data-number font-medium text-text">{stats.notifications.sentLast24h}</span></div>
            <div className="flex justify-between"><span className="text-muted">Failed</span><span className="data-number font-medium text-text">{stats.notifications.failedLast24h}</span></div>
            <div className="flex justify-between"><span className="text-muted">Suppressed</span><span className="data-number font-medium text-text">{stats.notifications.suppressedLast24h}</span></div>
          </div>
        </div>
      </div>
    </>
  );
}
