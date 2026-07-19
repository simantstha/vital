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
  dayKey?: string;
  /** Ready proactive-analysis id for workout_completed / sleep_session items. */
  analysisId?: string;
  /** Originating events.source column (e.g. 'whoop', 'healthkit') — used for read-time dedup. */
  source?: string;
}

export interface DailySleepRow {
  date: string;
  value: number;
}

export interface HealthKitWorkout {
  date: string;
  [key: string]: unknown;
}

export interface EventLogSource {
  id: string;
  type: string;
  timestamp: Date;
  payload: unknown;
  source?: string;
}

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
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

function formatEventTitle(type: string, payload: unknown): string {
  const p = pl(payload);
  switch (type) {
    case 'meal_logged': {
      const description = str(p.description) ?? str(p.name) ?? str(p.items) ?? 'Meal';
      const kcal = num(p.kcal) ?? num(p.calories);
      return kcal != null ? `${description} · ${Math.round(kcal)} kcal` : description;
    }
    case 'workout_completed': {
      const workoutType = str(p.type) ?? str(p.workout_type) ?? 'Workout';
      const label = workoutType.charAt(0).toUpperCase() + workoutType.slice(1);
      const distanceM = num(p.distance_m);
      const durationS = num(p.duration_s);
      if (distanceM != null) return `${label} — ${(distanceM / 1000).toFixed(1)} km`;
      if (durationS != null) return `${label} — ${Math.round(durationS / 60)} min`;
      return label;
    }
    case 'weight_logged': {
      let weight = num(p.value) ?? num(p.weight);
      if (weight == null) return 'Weight logged';
      const unit = str(p.unit);
      if (unit === 'lbs' || unit === 'lb') weight *= 0.453592;
      return `Weight: ${(Math.round(weight * 10) / 10).toFixed(1)} kg`;
    }
    case 'hrv_reading': {
      const value = num(p.value) ?? num(p.hrv) ?? num(p.valueMs) ?? num(p.sdnn);
      return value != null ? `HRV: ${Math.round(value)} ms` : 'HRV reading';
    }
    case 'sleep_session': {
      const durationMs = num(p.duration_ms)
        ?? (num(p.duration_s) != null ? num(p.duration_s)! * 1_000 : null);
      return durationMs != null ? `Sleep: ${formatHoursMinutes(durationMs)}` : 'Sleep logged';
    }
    default:
      return type;
  }
}

function formatEventSubtitle(type: string, payload: unknown): string {
  const p = pl(payload);
  switch (type) {
    case 'meal_logged': {
      const parts: string[] = [];
      const carbs = num(p.c) ?? num(p.carbs);
      const protein = num(p.p) ?? num(p.protein);
      const fat = num(p.f) ?? num(p.fat);
      if (carbs != null) parts.push(`${Math.round(carbs)}g carbs`);
      if (protein != null) parts.push(`${Math.round(protein)}g protein`);
      if (fat != null) parts.push(`${Math.round(fat)}g fat`);
      return parts.join(' · ') || 'Nutrition logged';
    }
    case 'workout_completed': {
      const parts: string[] = [];
      const calories = num(p.calories);
      const averageHr = num(p.avg_hr) ?? num(p.average_heart_rate);
      if (calories != null) parts.push(`~${Math.round(calories)} kcal`);
      if (averageHr != null) parts.push(`avg ${Math.round(averageHr)} bpm`);
      return parts.join(' · ') || 'Workout logged';
    }
    case 'weight_logged':
      return 'Body weight';
    case 'hrv_reading':
      return 'Heart rate variability';
    case 'sleep_session': {
      const efficiency = num(p.efficiency) ?? num(p.sleep_efficiency);
      const restingHr = num(p.rhr) ?? num(p.resting_heart_rate);
      const parts: string[] = [];
      if (efficiency != null) parts.push(`${Math.round(efficiency)}% efficiency`);
      if (restingHr != null) parts.push(`RHR ${Math.round(restingHr)} bpm`);
      return parts.join(' · ') || 'Sleep tracked';
    }
    default:
      return '';
  }
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
    dayKey: row.date,
  };
}

export function mapEventToLogItem(event: EventLogSource): LogItem {
  const payload = pl(event.payload);
  const imageThumb = str(payload.imageThumb);
  const mealKcal = event.type === 'meal_logged'
    ? (num(payload.kcal) ?? num(payload.calories))
    : undefined;
  const distanceM = event.type === 'workout_completed' ? num(payload.distance_m) : undefined;
  const workoutKm = distanceM != null ? Math.round((distanceM / 1000) * 100) / 100 : undefined;
  const sleepMs = event.type === 'sleep_session'
    ? (num(payload.duration_ms)
      ?? (num(payload.duration_s) != null ? num(payload.duration_s)! * 1_000 : undefined))
    : undefined;

  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp.toISOString(),
    title: formatEventTitle(event.type, event.payload),
    subtitle: formatEventSubtitle(event.type, event.payload),
    ...(imageThumb ? { imageThumb } : {}),
    ...(mealKcal != null ? { kcal: Math.round(mealKcal) } : {}),
    ...(workoutKm != null ? { km: workoutKm } : {}),
    ...(sleepMs != null ? { sleepMs } : {}),
    ...(event.source != null ? { source: event.source } : {}),
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
    ...(exactTimestamp == null ? { dayKey: workout.date } : {}),
  };
}

export function sortLogItemsNewestFirst<T extends { timestamp: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

const WORKOUT_DEDUPE_WINDOW_MS = 5 * 60_000;

// hasExactTime is only ever set to false by mapHealthKitWorkout, for the
// day-level noon-fallback placeholder used when no real start time exists.
// Event-sourced workouts (WHOOP included) always carry a real instant, so an
// absent hasExactTime is treated as exact.
function hasExactWorkoutTime(item: LogItem): boolean {
  return item.hasExactTime !== false;
}

/**
 * Drops WHOOP-sourced workout_completed items that duplicate a non-WHOOP
 * (e.g. Apple Watch/HealthKit) workout starting within 5 minutes — Apple
 * Watch wins when both devices logged the same physical workout. Only
 * compares items whose start timestamps are exact instants; everything
 * else (including non-workout items) passes through untouched, in order.
 */
export function dedupeWorkoutLogItems(items: LogItem[]): LogItem[] {
  const nonWhoopWorkoutTimes = items
    .filter((item) => item.type === 'workout_completed' && item.source !== 'whoop' && hasExactWorkoutTime(item))
    .map((item) => Date.parse(item.timestamp))
    .filter((ms) => Number.isFinite(ms));

  return items.filter((item) => {
    if (item.type !== 'workout_completed' || item.source !== 'whoop' || !hasExactWorkoutTime(item)) return true;
    const whoopMs = Date.parse(item.timestamp);
    if (!Number.isFinite(whoopMs)) return true;
    return !nonWhoopWorkoutTimes.some((ms) => Math.abs(ms - whoopMs) <= WORKOUT_DEDUPE_WINDOW_MS);
  });
}
