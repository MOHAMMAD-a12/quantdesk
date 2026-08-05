import type { NextConfig } from 'next';

/**
 * The browser is intentionally not told about API internals. Public URLs are
 * compiled into the client bundle; `INTERNAL_API_URL` stays server-only for
 * server components and Next route handlers running in Docker Compose.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },
};

export default nextConfig;
