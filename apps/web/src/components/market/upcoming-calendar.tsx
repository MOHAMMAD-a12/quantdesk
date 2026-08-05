'use client';

import { useQuery } from '@tanstack/react-query';
import type { EconomicEvent } from '@quantdesk/shared';
import { CalendarClock, AlertTriangle } from 'lucide-react';
import { apiResult } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state';

async function loadUpcoming(): Promise<EconomicEvent[]> {
  const { data } = await apiResult<EconomicEvent[]>('/news/calendar/upcoming');
  return data;
}

function impactBadge(impact: EconomicEvent['impact']): JSX.Element {
  const tone = impact === 'critical' ? 'negative' : impact === 'high' ? 'warning' : impact === 'medium' ? 'info' : 'default';
  return <Badge tone={tone}>{impact}</Badge>;
}

export function UpcomingCalendar(): JSX.Element {
  const query = useQuery({ queryKey: ['calendar-upcoming'], queryFn: loadUpcoming, refetchInterval: 600_000 });

  if (query.isLoading) return <LoadingState label="Loading economic calendar…" />;
  if (query.error) return <ErrorState detail="Could not load economic calendar." />;

  const events = query.data ?? [];
  if (events.length === 0) return <EmptyState title="No high-impact events" detail="No major macro releases in the next 24 hours." />;

  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Economic calendar</p>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted"><CalendarClock className="size-3.5" /> Next 24h</span>
      </div>
      <div className="mt-4 space-y-3">
        {events.slice(0, 5).map((event) => (
          <div key={event.id} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">{event.title}</p>
              <p className="text-xs text-muted">{event.currency} · {event.country} · {new Date(event.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
              {event.actual && (
                <p className="mt-1 text-xs text-muted">
                  Actual: <strong className={event.surprise === 'beat' ? 'text-positive' : event.surprise === 'miss' ? 'text-negative' : 'text-text'}>{event.actual}</strong>
                  {event.forecast && <span> · Forecast: {event.forecast}</span>}
                </p>
              )}
            </div>
            {impactBadge(event.impact)}
          </div>
        ))}
      </div>
    </section>
  );
}
