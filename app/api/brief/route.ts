import { NextResponse } from 'next/server';
import { getCachedBrief, cacheBrief } from '@/lib/briefCache';
import { generateDailyBrief } from '@/lib/claude';
import { fetchWhoopMetrics } from '@/lib/whoop';
import { fetchStravaData } from '@/lib/strava';

export const dynamic = 'force-dynamic';

function msToHm(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

export async function GET() {
  const cached = getCachedBrief();
  if (cached) return NextResponse.json(cached);

  return generate();
}

export async function POST() {
  return generate();
}

async function generate() {
  try {
    const [whoopResult, stravaResult] = await Promise.allSettled([
      fetchWhoopMetrics(),
      fetchStravaData(),
    ]);

    const whoop = whoopResult.status === 'fulfilled' ? whoopResult.value : null;
    const strava = stravaResult.status === 'fulfilled' ? stravaResult.value : null;

    const recovery = whoop?.recovery;
    const sleep = whoop?.sleep;
    const cycleData = whoop?.cycleData;

    const recoveryScore = Math.round(recovery?.score?.recovery_score ?? 50);
    const hrv = Math.round(recovery?.score?.hrv_rmssd_milli ?? 50);
    const rhr = Math.round(recovery?.score?.resting_heart_rate ?? 60);
    const sleepPerf = Math.round(sleep?.score?.sleep_performance_percentage ?? 70);

    const s = sleep?.score?.stage_summary ?? {};
    const sleepMs =
      (s.total_slow_wave_sleep_time_milli ?? 0) +
      (s.total_rem_sleep_time_milli ?? 0) +
      (s.total_light_sleep_time_milli ?? 0) ||
      (s.total_in_bed_time_milli ?? 0) - (s.total_awake_time_milli ?? 0);
    const sleepDuration = sleepMs > 0 ? msToHm(sleepMs) : '7h 0m';

    const strain = cycleData?.records?.[0]?.score?.strain?.toFixed(1) ?? '–';

    const brief = await generateDailyBrief({
      recovery: recoveryScore,
      hrv,
      rhr,
      sleepPerf,
      sleepDuration,
      strain,
      weeklyMi: strava?.totalMi ?? 0,
      lastRun: strava?.lastRun ?? null,
    });

    cacheBrief(brief);
    return NextResponse.json(brief);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
