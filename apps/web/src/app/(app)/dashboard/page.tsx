import type { Metadata } from 'next';
import { MarketBoard } from '@/components/market/market-board';
import { ActiveSignals } from '@/components/market/active-signals';
import { FearGreedGauge } from '@/components/market/fear-greed';
import { HeadlineNews } from '@/components/market/headline-news';
import { UpcomingCalendar } from '@/components/market/upcoming-calendar';
import { AppShell } from '@/components/layout/app-shell';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage(): JSX.Element {
  return (
    <>
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">Overview</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">Market intelligence</h1>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <MarketBoard />
          <ActiveSignals />
        </div>
        <div className="space-y-4">
          <FearGreedGauge />
          <UpcomingCalendar />
        </div>
      </div>

      <div className="mt-4">
        <HeadlineNews />
      </div>
    </>
  );
}
