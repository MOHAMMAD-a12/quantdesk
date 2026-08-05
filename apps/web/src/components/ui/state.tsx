import { AlertCircle, Inbox, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LoadingState({ label = 'Loading data…', className }: { label?: string; className?: string }): JSX.Element {
  return <div className={cn('flex min-h-32 items-center justify-center gap-2 text-sm text-muted', className)}><LoaderCircle className="size-4 animate-spin" />{label}</div>;
}

export function EmptyState({ title, detail, className }: { title: string; detail: string; className?: string }): JSX.Element {
  return <div className={cn('flex min-h-40 flex-col items-center justify-center px-6 text-center', className)}><Inbox className="mb-3 size-5 text-muted" /><p className="font-medium text-text">{title}</p><p className="mt-1 max-w-sm text-sm text-muted">{detail}</p></div>;
}

export function ErrorState({ title = 'Unable to load data', detail, className }: { title?: string; detail: string; className?: string }): JSX.Element {
  return <div role="alert" className={cn('flex min-h-32 items-center justify-center gap-2 rounded-lg border border-negative/30 bg-negative/5 px-4 text-center text-sm text-negative', className)}><AlertCircle className="size-4 shrink-0" /><span><strong>{title}.</strong> {detail}</span></div>;
}
