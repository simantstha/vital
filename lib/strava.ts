import type { MileageDay, MinutesDay } from './types';

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

function hasActivityType(activity: StravaActivity, types: Set<string>): boolean {
  return (
    (activity.type ? types.has(activity.type) : false) ||
    (activity.sport_type ? types.has(activity.sport_type) : false)
  );
}

export interface LastRun {
  distanceMi: string;
  name: string;
  dayTime: string;
  pace: string;
  hr: number;
  zone: string;
}

export interface LastWorkout {
  name: string;
  dayTime: string;
  durationMin: number;
  type: 'gym' | 'walk';
}

export interface RecentActivity {
  date: string;
  type: 'run' | 'gym' | 'walk';
  name: string;
  distanceMi?: number;
  durationMin: number;
  hr?: number;
  pace?: string;
  zone?: string;
}

export interface WeeklyLoad {
  weekStart: string; // YYYY-MM-DD (Monday)
  runMi: number;
  walkMi: number;
  gymMin: number;
  gymSessions: number;
}

export interface StravaData {
  lastRun: LastRun | null;
  lastWorkout: LastWorkout | null;
  mileage: MileageDay[];
  walkMileage: MileageDay[];
  gymMinutes: MinutesDay[];
  totalMi: number;
  totalWalkMi: number;
  totalGymMin: number;
  gymSessionCount: number;
  recentActivities: RecentActivity[];
  weeklyMileage: WeeklyLoad[];
}

interface StravaActivity {
  average_heartrate?: number;
  average_speed: number;
  distance: number;
  moving_time?: number;
  name: string;
  sport_type?: string;
  start_date_local: string;
  type?: string;
}

export async function fetchStravaData(): Promise<StravaData> {
  const token = await getAccessToken();

  const fortyWeeksAgo = Math.floor(Date.now() / 1000) - 280 * 24 * 60 * 60;
  const activities: StravaActivity[] = [];
  let page = 1;
  while (true) {
    const batch = await stravaGet(
      `/athlete/activities?after=${fortyWeeksAgo}&per_page=200&page=${page}`,
      token
    ) as StravaActivity[];
    activities.push(...batch);
    if (batch.length < 200) break;
    page++;
  }

  const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
  const GYM_TYPES = new Set(['WeightTraining', 'Workout', 'Crossfit', 'Elliptical', 'StairStepper', 'Yoga', 'Pilates', 'Swim', 'VirtualRide', 'Ride']);
  const WALK_TYPES = new Set(['Walk', 'Hike']);

  const sorted = [...activities].sort(
    (a, b) => new Date(b.start_date_local).getTime() - new Date(a.start_date_local).getTime()
  );

  const runs = sorted.filter((a) => hasActivityType(a, RUN_TYPES));
  const gyms = sorted.filter((a) => hasActivityType(a, GYM_TYPES));
  const walks = sorted.filter((a) => hasActivityType(a, WALK_TYPES));

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

  // Last gym or walk
  const lastGym = gyms[0] ?? null;
  const lastWalk = walks[0] ?? null;
  const recentWorkout = (() => {
    if (!lastGym && !lastWalk) return null;
    const useGym =
      lastGym &&
      (!lastWalk ||
        new Date(lastGym.start_date_local) > new Date(lastWalk.start_date_local));
    const a = useGym ? lastGym : lastWalk!;
    return {
      name: a.name,
      dayTime: dayLabel(a.start_date_local),
      durationMin: Math.round((a.moving_time ?? 0) / 60),
      type: useGym ? ('gym' as const) : ('walk' as const),
    };
  })();
  const lastWorkout: LastWorkout | null = recentWorkout;

  // Current week: Mon through today
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

  const walkMileage: MileageDay[] = weekDays.map((d, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    const isToday = day.toDateString() === now.toDateString();
    const isFuture = day > now;

    const dayMi = isFuture ? 0 : walks
      .filter((r) => new Date(r.start_date_local).toDateString() === day.toDateString())
      .reduce((sum, r) => sum + metersToMiles(r.distance), 0);

    return { d, mi: parseFloat(dayMi.toFixed(1)), today: isToday };
  });

  const gymMinutes: MinutesDay[] = weekDays.map((d, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    const isToday = day.toDateString() === now.toDateString();
    const isFuture = day > now;

    const dayMin = isFuture ? 0 : gyms
      .filter((g) => new Date(g.start_date_local).toDateString() === day.toDateString())
      .reduce((sum, g) => sum + (g.moving_time ?? 0) / 60, 0);

    return { d, min: Math.round(dayMin), today: isToday };
  });

  const totalMi = mileage.reduce((sum, d) => sum + d.mi, 0);
  const totalWalkMi = walkMileage.reduce((sum, d) => sum + d.mi, 0);
  const totalGymMin = gymMinutes.reduce((sum, d) => sum + d.min, 0);
  const gymSessionCount = gymMinutes.filter((d) => d.min > 0).length;

  // Last 7 days individual activities for AI context
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const recentActivities: RecentActivity[] = sorted
    .filter(a => new Date(a.start_date_local) >= sevenDaysAgo)
    .map(a => {
      const isRun = hasActivityType(a, RUN_TYPES);
      const isWalk = hasActivityType(a, WALK_TYPES);
      const type: 'run' | 'gym' | 'walk' = isRun ? 'run' : isWalk ? 'walk' : 'gym';
      return {
        date: a.start_date_local.split('T')[0],
        type,
        name: a.name,
        distanceMi: a.distance > 0 ? parseFloat(metersToMiles(a.distance).toFixed(1)) : undefined,
        durationMin: Math.round((a.moving_time ?? 0) / 60),
        hr: a.average_heartrate ? Math.round(a.average_heartrate) : undefined,
        pace: isRun && a.average_speed ? speedToPace(a.average_speed) : undefined,
        zone: isRun && a.average_heartrate ? hrZone(Math.round(a.average_heartrate)) : undefined,
      };
    });

  // Last 8 weeks of training load (newest first)
  const weeklyMileage: WeeklyLoad[] = [];
  for (let w = 0; w < 8; w++) {
    const weekMonday = new Date(monday);
    weekMonday.setDate(monday.getDate() - w * 7);
    const weekSunday = new Date(weekMonday);
    weekSunday.setDate(weekMonday.getDate() + 6);
    weekSunday.setHours(23, 59, 59, 999);

    const weekActs = sorted.filter(a => {
      const d = new Date(a.start_date_local);
      return d >= weekMonday && d <= weekSunday;
    });

    const weekRuns = weekActs.filter(a => hasActivityType(a, RUN_TYPES));
    const weekWalks = weekActs.filter(a => hasActivityType(a, WALK_TYPES));
    const weekGyms = weekActs.filter(a => hasActivityType(a, GYM_TYPES));

    weeklyMileage.push({
      weekStart: weekMonday.toISOString().split('T')[0],
      runMi: parseFloat(weekRuns.reduce((sum, a) => sum + metersToMiles(a.distance), 0).toFixed(1)),
      walkMi: parseFloat(weekWalks.reduce((sum, a) => sum + metersToMiles(a.distance), 0).toFixed(1)),
      gymMin: Math.round(weekGyms.reduce((sum, a) => sum + (a.moving_time ?? 0) / 60, 0)),
      gymSessions: weekGyms.length,
    });
  }

  return {
    lastRun, lastWorkout,
    mileage, walkMileage, gymMinutes,
    totalMi, totalWalkMi, totalGymMin, gymSessionCount,
    recentActivities, weeklyMileage,
  };
}
