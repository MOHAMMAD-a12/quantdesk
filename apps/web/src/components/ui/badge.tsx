import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'positive' | 'negative' | 'warning' | 'info';

const tones: Record<Tone, string> = {
  default: 'border-border bg-panel-raised text-muted',
  positive: 'border-positive/30 bg-positive/10 text-positive',
  negative: 'border-negative/30 bg-negative/10 text-negative',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  info: 'border-brand/30 bg-brand/10 text-brand',
};

export function Badge({ className, tone = 'default', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }): JSX.Element {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold', tones[tone], className)} {...props} />;
}
