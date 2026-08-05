import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: { default: 'QuantDesk — Market Intelligence', template: '%s · QuantDesk' },
  description: 'Real-time market intelligence, deterministic technical analysis and risk-aware trading workflows.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>): JSX.Element {
  return <html lang="en" suppressHydrationWarning><body><Providers>{children}</Providers></body></html>;
}
