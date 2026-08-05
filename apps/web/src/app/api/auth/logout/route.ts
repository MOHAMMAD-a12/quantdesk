import { NextResponse } from 'next/server';

/**
 * Clear the refresh token cookie on logout.
 */
export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set('qd_refresh', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
