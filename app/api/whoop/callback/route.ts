import { type NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');
  const errorDescription = req.nextUrl.searchParams.get('error_description');

  if (!code) {
    return NextResponse.json(
      { error: error ?? 'No code in callback', description: errorDescription, params: Object.fromEntries(req.nextUrl.searchParams) },
      { status: 400 }
    );
  }

  const res = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.WHOOP_CLIENT_ID!,
      client_secret: process.env.WHOOP_CLIENT_SECRET!,
      redirect_uri: process.env.WHOOP_REDIRECT_URI!,
    }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: 'Token exchange failed', detail: text }, { status: 502 });
  }

  const { access_token, refresh_token } = await res.json();

  return NextResponse.json({
    message: 'Copy WHOOP_REFRESH_TOKEN into your .env.local then restart the server.',
    WHOOP_REFRESH_TOKEN: refresh_token,
    access_token,
  });
}
