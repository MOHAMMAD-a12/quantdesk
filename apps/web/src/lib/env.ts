import { z } from 'zod';

/**
 * Browser-safe configuration. These values are public by definition: Next.js
 * inlines `NEXT_PUBLIC_*` into the bundle, so secrets never belong here.
 */
const browserEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  NEXT_PUBLIC_WS_URL: z.string().url().default('ws://localhost:4000/ws'),
  NEXT_PUBLIC_SITE_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
});

export const browserEnv = browserEnvSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
});

export const serverApiUrl = process.env.INTERNAL_API_URL ?? browserEnv.NEXT_PUBLIC_API_URL;
