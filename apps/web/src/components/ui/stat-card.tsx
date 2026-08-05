import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export function StatCard({ label, value, change, detail, className }: { label: string; value: string; change?: number | null; detail?: string; className?: string }): JSX.Element {
  const direction = change === undefined || change === null || change === 0 ? 'neutral' : change > 0 ? 'up' : 'down';
  const Icon = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : Minus;
  const tone = direction === 'up' ? 'text-positive' : direction === 'down' ? 'text-negative' : 'text-muted';
  return <section className={cn('panel p-5', className)}><p className="eyebrow">{label}</p><div className="mt-3 flex items-end justify-between gap-3"><p className="data-number text-2xl font-bold tracking-tight text-text">{value}</p>{change !== undefined && change !== null ? <span className={cn('data-number inline-flex items-center text-xs font-semibold', tone)}><Icon className="mr-0.5 size-3.5" />{Math.abs(change).toFixed(2)}%</span> : null}</div>{detail ? <p className="mt-2 text-xs text-muted">{detail}</p> : null}</section>;
}
