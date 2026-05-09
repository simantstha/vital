import { type NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (!code) {
    return NextResponse.json({ error: error ?? 'No code in callback' }, { status: 400 });
  }

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID!,
      client_secret: process.env.STRAVA_CLIENT_SECRET!,
      code,
      grant_type: 'authorization_code',
    }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: 'Token exchange failed', detail: text }, { status: 502 });
  }

  const { access_token, refresh_token } = await res.json();
  return NextResponse.json({
    message: 'Copy STRAVA_REFRESH_TOKEN into your .env.local then restart the server.',
    STRAVA_REFRESH_TOKEN: refresh_token,
    access_token,
  });
}
