import type { MileageDay, Route } from './types';

const STRAVA_BASE = 'https://www.strava.com/api/v3';
const TOKEN_URL = 'https://www.strava.com/oauth/token';

async function getAccessToken(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.STRAVA_CLIENT_ID!,
      client_secret: process.env.STRAVA_CLIENT_SECRET!,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN!,
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Strava token refresh failed: ${res.status} — ${detail}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function stravaGet(path: string, token: string) {
  const res = await fetch(`${STRAVA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Strava API error: ${path} → ${res.status}`);
  return res.json();
}

function metersToMiles(m: number) { return m / 1609.34; }
function metersToFeet(m: number)  { return Math.round(m * 3.28084); }

function speedToPace(mps: number): string {
  if (!mps) return '–';
  const secsPerMile = 1609.34 / mps;
  const mins = Math.floor(secsPerMile / 60);
  const secs = Math.round(secsPerMile % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function hrZone(hr: number): string {
  if (hr < 120) return 'Zone 1';
  if (hr < 140) return 'Zone 2';
  if (hr < 160) return 'Zone 3';
  if (hr < 180) return 'Zone 4';
  return 'Zone 5';
}

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const hour = d.getHours();
  const part = hour < 12 ? 'AM' : hour < 17 ? 'PM' : 'Eve';
  return `${day} ${part}`;
}

export interface LastRun {
  distanceMi: string;
  name: string;
  dayTime: string;
  pace: string;
  hr: number;
  zone: string;
}

export interface StravaData {
  lastRun: LastRun | null;
  routes: Route[];
  mileage: MileageDay[];
  totalMi: number;
}

export async function fetchStravaData(): Promise<StravaData> {
  const token = await getAccessToken();

  const fortyWeeksAgo = Math.floor(Date.now() / 1000) - 280 * 24 * 60 * 60;
  const activities: any[] = [];
  let page = 1;
  while (true) {
    const batch: any[] = await stravaGet(
      `/athlete/activities?after=${fortyWeeksAgo}&per_page=200&page=${page}`,
      token
    );
    activities.push(...batch);
    if (batch.length < 200) break;
    page++;
  }

  const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
  const runs = activities
    .filter((a) => RUN_TYPES.has(a.type) || RUN_TYPES.has(a.sport_type))
    .sort((a, b) => new Date(b.start_date_local).getTime() - new Date(a.start_date_local).getTime());

  // Last run stats
  const last = runs[0] ?? null;
  const lastRun: LastRun | null = last
    ? {
        distanceMi: metersToMiles(last.distance).toFixed(1),
        name: last.name,
        dayTime: dayLabel(last.start_date_local),
        pace: speedToPace(last.average_speed),
        hr: Math.round(last.average_heartrate ?? 0),
        zone: hrZone(Math.round(last.average_heartrate ?? 0)),
      }
    : null;

  // Favorite routes — group by name, sort by frequency
  const routeMap = new Map<string, { activity: any; count: number }>();
  for (const run of runs) {
    const existing = routeMap.get(run.name);
    if (existing) {
      existing.count++;
    } else {
      routeMap.set(run.name, { activity: run, count: 1 });
    }
  }
  const routes: Route[] = [...routeMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 4)
    .map(([name, { activity, count }]) => ({
      name,
      d: `${metersToMiles(activity.distance).toFixed(1)} mi`,
      e: `${metersToFeet(activity.total_elevation_gain)}ft`,
      p: `${speedToPace(activity.average_speed)} / mi`,
      count,
    }));

  // Weekly mileage — Mon through today in current week
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const weekDays = ['M', 'T', 'W', 'Th', 'F', 'S', 'S'];
  const mileage: MileageDay[] = weekDays.map((d, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    const isToday = day.toDateString() === now.toDateString();
    const isFuture = day > now;

    const dayMi = isFuture ? 0 : runs
      .filter((r) => new Date(r.start_date_local).toDateString() === day.toDateString())
      .reduce((sum, r) => sum + metersToMiles(r.distance), 0);

    return { d, mi: parseFloat(dayMi.toFixed(1)), today: isToday };
  });

  const totalMi = mileage.reduce((sum, d) => sum + d.mi, 0);

  return { lastRun, routes, mileage, totalMi };
}
