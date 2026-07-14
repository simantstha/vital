export interface LogItem {
  id: string;
  type: string;
  timestamp: string;
  title: string;
  subtitle: string;
  imageThumb?: string;
  kcal?: number;
  km?: number;
  sleepMs?: number;
  hasExactTime?: boolean;
}

export interface DailySleepRow {
  date: string;
  value: number;
}

export interface HealthKitWorkout {
  date: string;
  [key: string]: unknown;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function formatHoursMinutes(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes < 10 ? '0' : ''}${minutes}m`;
}

function normalizedStartTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year === 0
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
  ) return undefined;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function mapDailySleepRow(row: DailySleepRow): LogItem {
  const sleepMs = row.value * 60_000;
  return {
    id: `sleep-${row.date}`,
    type: 'sleep_session',
    timestamp: `${row.date}T12:00:00.000Z`,
    title: `Sleep: ${formatHoursMinutes(sleepMs)}`,
    subtitle: 'Sleep tracked',
    sleepMs,
    hasExactTime: false,
  };
}

export function mapHealthKitWorkout(workout: HealthKitWorkout, index: number): LogItem {
  const workoutType = str(workout.type) ?? 'Workout';
  const label = workoutType.charAt(0).toUpperCase() + workoutType.slice(1);
  const durationMin = num(workout.durationMin);
  const kcal = num(workout.kcal);
  const distanceM = num(workout.distance_m);
  const km = distanceM != null ? distanceM / 1000 : num(workout.distanceKm);
  const exactTimestamp = normalizedStartTime(workout.startTime);

  return {
    id: str(workout.hkUuid) ?? `${workout.date}-workout-${index}`,
    type: 'workout_completed',
    timestamp: exactTimestamp ?? `${workout.date}T12:00:00.000Z`,
    title: durationMin != null ? `${label} — ${Math.round(durationMin)} min` : label,
    subtitle: kcal != null ? `~${Math.round(kcal)} kcal` : 'Workout logged',
    ...(km != null ? { km: Math.round(km * 100) / 100 } : {}),
    hasExactTime: exactTimestamp != null,
  };
}

export function sortLogItemsNewestFirst<T extends { timestamp: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
