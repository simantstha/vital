import { localDayKey } from './localDay';

type ActivityInput = {
  timeZone?: string;
  events: Array<{ type: string; timestamp: Date }>;
  dailyMetrics: Array<{ date: string; metric: string; value: number }>;
  messages: Array<{ role: string; timestamp: Date }>;
  planItems: Array<{ localDay: string; status: string }>;
};

const QUALIFYING_EVENT_TYPES = new Set(['meal_logged', 'workout_completed']);

export function collectQualifyingDays(input: ActivityInput): Set<string> {
  const days = new Set<string>();

  for (const event of input.events) {
    if (QUALIFYING_EVENT_TYPES.has(event.type)) {
      days.add(localDayKey(event.timestamp, input.timeZone));
    }
  }
  for (const metric of input.dailyMetrics) {
    if (metric.metric === 'workouts' && metric.value > 0) days.add(metric.date);
  }
  for (const message of input.messages) {
    if (message.role === 'user') days.add(localDayKey(message.timestamp, input.timeZone));
  }
  for (const item of input.planItems) {
    if (item.status === 'done') days.add(item.localDay);
  }

  return days;
}

function previousDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function calculateStreakDays(
  qualifyingDays: ReadonlySet<string>,
  now: Date,
  timeZone?: string,
): number {
  const today = localDayKey(now, timeZone);
  const yesterday = previousDayKey(today);
  let cursor = qualifyingDays.has(today) ? today : yesterday;

  if (!qualifyingDays.has(cursor)) return 0;

  let streakDays = 0;
  while (qualifyingDays.has(cursor)) {
    streakDays += 1;
    cursor = previousDayKey(cursor);
  }
  return streakDays;
}
