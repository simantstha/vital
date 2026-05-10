import fs from 'fs';
import path from 'path';

const WHOOP_BASE_V1 = 'https://api.prod.whoop.com/developer/v1';
const WHOOP_BASE_V2 = 'https://api.prod.whoop.com/developer/v2';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const TOKEN_FILE = path.resolve(process.cwd(), '.whoop-refresh-token');

function getStoredRefreshToken(): string {
  try {
    const fromFile = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* fall through */ }
  return process.env.WHOOP_REFRESH_TOKEN!;
}

function persistNewRefreshToken(newToken: string) {
  // Write to a dedicated file — never touches .env.local so other vars stay safe.
  // Silently skips on read-only filesystems (Vercel).
  try {
    fs.writeFileSync(TOKEN_FILE, newToken, 'utf8');
  } catch { /* read-only fs */ }
  process.env.WHOOP_REFRESH_TOKEN = newToken;
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.WHOOP_CLIENT_ID!,
      client_secret: process.env.WHOOP_CLIENT_SECRET!,
      refresh_token: getStoredRefreshToken(),
    }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Whoop token refresh failed: ${res.status} — ${detail}`);
  }

  const data = await res.json();
  if (data.refresh_token) persistNewRefreshToken(data.refresh_token);
  return data.access_token;
}

async function whoopGet(base: string, path: string, token: string) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 900 },
  });
  if (!res.ok) throw new Error(`Whoop API error: ${path} → ${res.status}`);
  return res.json();
}

export async function fetchWhoopMetrics() {
  const token = await getAccessToken();

  const [recoveryData, sleepData, cycleData] = await Promise.all([
    whoopGet(WHOOP_BASE_V2, '/recovery?limit=1', token),
    whoopGet(WHOOP_BASE_V2, '/activity/sleep?limit=1', token),
    whoopGet(WHOOP_BASE_V1, '/cycle?limit=2', token),
  ]);

  const recovery = recoveryData.records?.[0];
  const sleep = sleepData.records?.[0];
  // cycles newest-first: [0] = today (in progress), [1] = yesterday (scored)
  const yesterdayCycle = cycleData.records?.[1] ?? cycleData.records?.[0];

  return { recovery, sleep, cycleData, yesterdayCycle };
}
