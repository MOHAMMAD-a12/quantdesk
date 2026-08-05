'use client';

import type { Metadata } from 'next';
import { MarketBoard } from '@/components/market/market-board';

export default function MarketsPage(): JSX.Element {
  return (
    <>
      <div className="mb-6">
        <p className="eyebrow">Markets</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">All instruments</h1>
        <p className="mt-1 text-sm text-muted">Quotes, 24h performance and volume across the tracked universe.</p>
      </div>
      <MarketBoard />
    </>
  );
}
