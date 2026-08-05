'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/** One cache per browser session; SSR never shares data across users. */
export function Providers({ children }: { children: ReactNode }): JSX.Element {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
      mutations: { retry: 0 },
    },
  }));

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
