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

function msToHm(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

let _tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

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
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

async function whoopGet(base: string, p: string, token: string) {
  const res = await fetch(`${base}${p}`, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 900 },
  });
  if (!res.ok) throw new Error(`Whoop API error: ${p} → ${res.status}`);
  return res.json();
}

export interface WhoopHistoryDay {
  date: string;
  recovery: number;
  hrv: number;
  rhr: number;
  sleepPerf: number;
  sleepDuration: string;
}

export interface WhoopHistory {
  days: WhoopHistoryDay[];
  avgRecovery7d: number;
  avgHrv7d: number;
  trend: 'improving' | 'declining' | 'stable';
}

export async function fetchWhoopMetrics() {
  const token = await getAccessToken();

  const [recoveryData, sleepData, cycleData] = await Promise.all([
    whoopGet(WHOOP_BASE_V2, '/recovery?limit=7', token),
    whoopGet(WHOOP_BASE_V2, '/activity/sleep?limit=7', token),
    whoopGet(WHOOP_BASE_V1, '/cycle?limit=2', token),
  ]);

  const recovery = recoveryData.records?.[0];
  const sleep = sleepData.records?.[0];
  // cycles newest-first: [0] = today (in progress), [1] = yesterday (scored)
  const yesterdayCycle = cycleData.records?.[1] ?? cycleData.records?.[0];

  // Build 7-day history — both APIs return newest-first, match by index
  type RawRecord = Record<string, unknown>;
  const recoveryRecords: RawRecord[] = recoveryData.records ?? [];
  const sleepRecords: RawRecord[] = sleepData.records ?? [];

  const days: WhoopHistoryDay[] = recoveryRecords.slice(0, 7).map((rec, i) => {
    const sl = sleepRecords[i] as RawRecord | undefined;
    const date = ((rec.created_at as string) ?? '').split('T')[0];
    const score = rec.score as Record<string, number> | undefined;
    const slScore = (sl?.score as Record<string, unknown>) ?? {};
    const stageSummary = (slScore.stage_summary as Record<string, number>) ?? {};
    const sleepMs =
      (stageSummary.total_slow_wave_sleep_time_milli ?? 0) +
      (stageSummary.total_rem_sleep_time_milli ?? 0) +
      (stageSummary.total_light_sleep_time_milli ?? 0) ||
      (stageSummary.total_in_bed_time_milli ?? 0) - (stageSummary.total_awake_time_milli ?? 0);

    return {
      date,
      recovery: Math.round(score?.recovery_score ?? 0),
      hrv: Math.round(score?.hrv_rmssd_milli ?? 0),
      rhr: Math.round(score?.resting_heart_rate ?? 0),
      sleepPerf: Math.round((slScore.sleep_performance_percentage as number) ?? 0),
      sleepDuration: sleepMs > 0 ? msToHm(sleepMs) : '–',
    };
  });

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const validRecovery = days.map(d => d.recovery).filter(v => v > 0);
  const validHrv = days.map(d => d.hrv).filter(v => v > 0);

  // Compare most recent 3 days vs oldest 3 days (index 0 = most recent)
  const recent3 = days.slice(0, 3).map(d => d.recovery).filter(v => v > 0);
  const older3 = days.slice(4).map(d => d.recovery).filter(v => v > 0);
  let trend: 'improving' | 'declining' | 'stable' = 'stable';
  if (recent3.length >= 2 && older3.length >= 2) {
    const diff = avg(recent3) - avg(older3);
    if (diff > 5) trend = 'improving';
    else if (diff < -5) trend = 'declining';
  }

  const history: WhoopHistory = {
    days,
    avgRecovery7d: Math.round(avg(validRecovery)),
    avgHrv7d: Math.round(avg(validHrv)),
    trend,
  };

  return { recovery, sleep, cycleData, yesterdayCycle, history };
}
