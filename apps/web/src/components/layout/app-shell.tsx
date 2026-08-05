'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, Bot, CandlestickChart, ChartNoAxesCombined, ChevronDown, CircleUserRound, LayoutDashboard, Menu, Newspaper, PanelLeftClose, Search, Settings, ShieldCheck, Sparkles, WalletCards } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { liveSocket, type SocketState } from '@/lib/websocket';
import { Button } from '@/components/ui/button';

const navigation = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/markets', label: 'Markets', icon: CandlestickChart },
  { href: '/signals', label: 'AI Signals', icon: Sparkles },
  { href: '/analysis', label: 'Analysis', icon: ChartNoAxesCombined },
  { href: '/news', label: 'News & Calendar', icon: Newspaper },
  { href: '/portfolio', label: 'Portfolio', icon: WalletCards },
  { href: '/risk', label: 'Risk Lab', icon: ShieldCheck },
];

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [socketState, setSocketState] = useState<SocketState>('closed');
  const [light, setLight] = useState(false);

  useEffect(() => {
    liveSocket.connect();
    return liveSocket.onState(setSocketState);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('light', light);
  }, [light]);

  return <div className="min-h-screen bg-canvas">
    <aside className={cn('fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-panel transition-transform lg:translate-x-0', mobileOpen ? 'translate-x-0' : '-translate-x-full')}>
      <div className="flex h-16 items-center justify-between border-b border-border px-5">
        <Link href="/dashboard" className="flex items-center gap-2 font-bold tracking-tight text-text"><span className="grid size-8 place-items-center rounded-lg bg-brand text-white"><Bot className="size-4" /></span><span>QuantDesk</span></Link>
        <button aria-label="Close navigation" className="text-muted lg:hidden" onClick={() => setMobileOpen(false)}><PanelLeftClose className="size-5" /></button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[.2em] text-muted">Workspace</p>
        {navigation.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={cn('flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors', pathname === href || pathname.startsWith(`${href}/`) ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-panel-raised hover:text-text')}><Icon className="size-4" />{label}</Link>)}
      </nav>
      <div className="border-t border-border p-3">
        <Link href="/settings" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted hover:bg-panel-raised hover:text-text"><Settings className="size-4" />Settings</Link>
        <p className="mt-3 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[11px] leading-4 text-muted"><strong className="text-warning">Analysis only.</strong> Market intelligence is not financial advice.</p>
      </div>
    </aside>
    {mobileOpen ? <button aria-label="Close navigation overlay" className="fixed inset-0 z-30 bg-black/55 lg:hidden" onClick={() => setMobileOpen(false)} /> : null}

    <main className="min-h-screen lg:pl-64">
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-canvas/90 px-4 backdrop-blur lg:px-7">
        <button aria-label="Open navigation" className="text-muted lg:hidden" onClick={() => setMobileOpen(true)}><Menu className="size-5" /></button>
        <div className="relative hidden max-w-md flex-1 sm:block"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><input aria-label="Search symbols" placeholder="Search symbols, signals, news…" className="h-9 w-full rounded-lg border border-border bg-panel pl-9 pr-3 text-sm placeholder:text-muted focus:border-brand" /></div>
        <div className="ml-auto flex items-center gap-2">
          <span title={socketState === 'open' ? 'Live stream connected' : socketState === 'connecting' ? 'Connecting live stream' : 'Live stream reconnecting'} className="hidden items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-[11px] font-medium text-muted sm:flex"><span className={cn('size-1.5 rounded-full', socketState === 'open' ? 'bg-positive' : socketState === 'connecting' ? 'animate-pulse bg-warning' : 'bg-negative')} />{socketState === 'open' ? 'Live' : socketState === 'connecting' ? 'Connecting' : 'Offline'}</span>
          <Button variant="ghost" size="sm" aria-label="Toggle theme" onClick={() => setLight((value) => !value)}>{light ? 'Dark' : 'Light'}</Button>
          <Button variant="ghost" size="sm" aria-label="Notifications" className="relative"><Bell className="size-4" /><span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-brand" /></Button>
          <button className="hidden items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text hover:bg-panel-raised sm:flex"><span className="grid size-7 place-items-center rounded-full bg-panel-raised"><CircleUserRound className="size-4 text-muted" /></span><span className="text-left"><span className="block text-xs font-semibold">Guest session</span><span className="block text-[10px] text-muted">Sign in to trade</span></span><ChevronDown className="size-3 text-muted" /></button>
        </div>
      </header>
      <div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-7">{children}</div>
    </main>
  </div>;
}
