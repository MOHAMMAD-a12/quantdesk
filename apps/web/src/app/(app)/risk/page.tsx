'use client';

import { useQuery } from '@tanstack/react-query';
import type { RiskExposure, DrawdownState, PositionSizeResult } from '@quantdesk/shared';
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { apiResult } from '@/lib/api';
import { formatPrice } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { StatCard } from '@/components/ui/stat-card';
import { ErrorState, LoadingState } from '@/components/ui/state';

export default function RiskPage(): JSX.Element {
  const [tab, setTab] = useState<'exposure' | 'calculator'>('exposure');
  const [calcInput, setCalcInput] = useState({ accountBalance: 10000, riskPercent: 1, symbol: 'BTCUSDT', entryPrice: 60000, stopLoss: 59000 });

  const exposureQuery = useQuery({ queryKey: ['risk-exposure'], queryFn: async () => { const { data } = await apiResult<RiskExposure>('/risk/exposure'); return data; } });
  const drawdownQuery = useQuery({ queryKey: ['risk-drawdown'], queryFn: async () => { const { data } = await apiResult<DrawdownState>('/risk/drawdown'); return data; } });
  const calcQuery = useQuery({
    queryKey: ['risk-size', calcInput],
    queryFn: async () => { const { data } = await apiResult<PositionSizeResult>('/risk/size', { method: 'POST', body: calcInput }); return data; },
    enabled: false,
  });

  const exposure = exposureQuery.data;
  const drawdown = drawdownQuery.data;

  return (
    <>
      <div className="mb-6">
        <p className="eyebrow">Risk management</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">Risk lab</h1>
        <p className="mt-1 text-sm text-muted">Exposure limits, drawdown monitoring and position sizing.</p>
      </div>

      {/* Exposure cards */}
      {exposure && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Open risk" value={`${exposure.openRiskPercent.toFixed(1)}%`} detail={`${exposure.openPositions} positions`} change={exposure.breached ? -1 : null} />
          <StatCard label="Daily risk used" value={`${exposure.dailyRiskUsedPercent.toFixed(1)}%`} detail={`Limit: ${exposure.dailyLimitPercent}%`} change={exposure.dailyRiskUsedPercent > exposure.dailyLimitPercent * 0.8 ? -0.5 : null} />
          <StatCard label="Weekly risk used" value={`${exposure.weeklyRiskUsedPercent.toFixed(1)}%`} detail={`Limit: ${exposure.weeklyLimitPercent}%`} />
          {drawdown && <StatCard label="Drawdown" value={`${drawdown.drawdownPercent.toFixed(1)}%`} detail={drawdown.alerting ? 'Past alert threshold' : 'Within limits'} change={drawdown.alerting ? -1 : null} />}
        </div>
      )}

      {exposureQuery.isLoading ? <LoadingState label="Loading risk data…" /> : exposureQuery.error ? <ErrorState detail="Could not load risk exposure." /> : null}

      {/* Breach banner */}
      {exposure?.breached && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-negative/30 bg-negative/5 p-4">
          <AlertTriangle className="size-5 shrink-0 text-negative" />
          <div>
            <p className="text-sm font-semibold text-negative">Risk limit breached</p>
            {exposure.breaches.map((b, i) => <p key={i} className="mt-0.5 text-xs text-muted">{b}</p>)}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-border">
        {(['exposure', 'calculator'] as const).map((t) => (
          <button key={t} className={cn('border-b-2 px-4 py-2.5 text-sm font-medium capitalize transition-colors', tab === t ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-text')} onClick={() => setTab(t)}>
            {t === 'calculator' ? 'Position size' : 'Exposure'}
          </button>
        ))}
      </div>

      {tab === 'exposure' && exposure && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="panel p-5">
            <p className="eyebrow">Account limits</p>
            <div className="mt-4 space-y-3">
              {[
                ['Account balance', `$${formatPrice(exposure.accountBalance, 0)}`],
                ['Max concurrent trades', String(exposure.maxConcurrentTrades)],
                ['Daily risk limit', `${exposure.dailyLimitPercent}%`],
                ['Weekly risk limit', `${exposure.weeklyLimitPercent}%`],
                ['Daily used', `${exposure.dailyRiskUsedPercent.toFixed(1)}%`],
                ['Weekly used', `${exposure.weeklyRiskUsedPercent.toFixed(1)}%`],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between text-sm">
                  <span className="text-muted">{label}</span>
                  <span className="data-number font-medium text-text">{value}</span>
                </div>
              ))}
            </div>
          </div>
          {drawdown && (
            <div className="panel p-5">
              <p className="eyebrow">Drawdown monitor</p>
              <div className="mt-4 space-y-3">
                {[
                  ['Peak equity', `$${formatPrice(drawdown.peakEquity, 0)}`],
                  ['Current equity', `$${formatPrice(drawdown.currentEquity, 0)}`],
                  ['Drawdown', `${drawdown.drawdownPercent.toFixed(2)}%`],
                  ['Drawdown amount', `$${formatPrice(drawdown.drawdownAmount, 0)}`],
                  ['Duration', `${Math.floor(drawdown.durationMs / 3_600_000)}h ${Math.floor((drawdown.durationMs % 3_600_000) / 60_000)}m`],
                  ['Alert threshold', `${drawdown.alertThresholdPercent}%`],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between text-sm">
                    <span className="text-muted">{label}</span>
                    <span className={cn('data-number font-medium', label === 'Drawdown' ? (drawdown.drawdownPercent > drawdown.alertThresholdPercent ? 'text-negative' : 'text-text') : 'text-text')}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'calculator' && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="panel p-5">
            <p className="eyebrow">Position size calculator</p>
            <div className="mt-4 grid grid-cols-2 gap-4">
              {([
                ['accountBalance', 'Account balance ($)', calcInput.accountBalance],
                ['riskPercent', 'Risk per trade (%)', calcInput.riskPercent],
                ['symbol', 'Symbol', calcInput.symbol],
                ['entryPrice', 'Entry price', calcInput.entryPrice],
                ['stopLoss', 'Stop loss', calcInput.stopLoss],
              ] as const).map(([key, label, value]) => (
                <div key={key}>
                  <label className="text-xs font-medium text-muted">{label}</label>
                  <input
                    type={key === 'symbol' ? 'text' : 'number'}
                    value={value}
                    onChange={(e) => setCalcInput((prev) => ({ ...prev, [key]: key === 'symbol' ? e.target.value.toUpperCase() : Number(e.target.value) }))}
                    className="mt-1 h-9 w-full rounded-lg border border-border bg-panel px-3 text-sm text-text focus:border-brand"
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <Button onClick={() => calcQuery.refetch()}>Calculate</Button>
            </div>
          </div>

          {calcQuery.data && (
            <div className="panel p-5">
              <p className="eyebrow">Result</p>
              <div className="mt-4 space-y-3">
                {[
                  ['Risk amount', `$${formatPrice(calcQuery.data.riskAmount, 2)}`],
                  ['Position size', `${calcQuery.data.quantity} units`],
                  ['Lots', calcQuery.data.lots.toFixed(2)],
                  ['Notional', `$${formatPrice(calcQuery.data.notional, 0)}`],
                  ['Leverage', `${calcQuery.data.leverage.toFixed(2)}x`],
                  ['Stop distance', `$${formatPrice(calcQuery.data.stopDistance, 2)}`],
                  ['Stop (ticks)', String(calcQuery.data.stopDistanceTicks)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between text-sm">
                    <span className="text-muted">{label}</span>
                    <span className="data-number font-medium text-text">{value}</span>
                  </div>
                ))}
                {calcQuery.data.warnings.length > 0 && (
                  <div className="mt-3 border-t border-border pt-3">
                    {calcQuery.data.warnings.map((w, i) => <p key={i} className="text-xs text-warning">{w}</p>)}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
