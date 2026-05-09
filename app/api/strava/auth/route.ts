import { NextResponse } from 'next/server';

export async function GET() {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    redirect_uri: process.env.STRAVA_REDIRECT_URI!,
    response_type: 'code',
    scope: 'activity:read_all',
    approval_prompt: 'force',
  });
  return NextResponse.redirect(`https://www.strava.com/oauth/authorize?${params}`);
}
