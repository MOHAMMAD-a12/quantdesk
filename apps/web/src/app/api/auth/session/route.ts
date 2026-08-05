import { NextResponse, type NextRequest } from 'next/server';

/**
 * Browser-to-server session bridge.
 *
 * The refresh token is stored in an httpOnly cookie set by this route, never
 * exposed to client JavaScript. The access token stays in memory only.
 * This same-origin Next route handler is the only code that reads the cookie.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null) as { refreshToken?: string } | null;
  if (!body?.refreshToken) {
    return NextResponse.json({ error: 'Refresh token required' }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set('qd_refresh', body.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return response;
}
