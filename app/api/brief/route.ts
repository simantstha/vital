import { NextResponse } from 'next/server';
import { getCachedBrief, cacheBrief } from '@/lib/briefCache';
import { generateDailyBrief } from '@/lib/claude';
import { fetchWhoopMetrics } from '@/lib/whoop';
import { fetchStravaData } from '@/lib/strava';
import { getDiaryMacros, type MFPMacros } from '@/lib/mfp';

export const dynamic = 'force-dynamic';

function msToHm(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function daysAgoDate(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
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
    const [whoopResult, stravaResult, mfpYesterdayResult, mfpDayBeforeResult] = await Promise.allSettled([
      fetchWhoopMetrics(),
      fetchStravaData(),
      getDiaryMacros(daysAgoDate(1)),
      getDiaryMacros(daysAgoDate(2)),
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

    // Last 3 days nutrition for AI context (today excluded — not yet logged)
    const recentNutrition = [mfpYesterdayResult, mfpDayBeforeResult]
      .filter((r): r is PromiseFulfilledResult<MFPMacros> => r.status === 'fulfilled' && r.value.hasData)
      .map(r => ({ date: r.value.date, calories: r.value.calories, carbs: r.value.carbs, protein: r.value.protein, fat: r.value.fat }));

    const brief = await generateDailyBrief({
      recovery: recoveryScore,
      hrv,
      rhr,
      sleepPerf,
      sleepDuration,
      strain,
      weeklyMi: strava?.totalMi ?? 0,
      lastRun: strava?.lastRun ?? null,
      history: whoop?.history ?? null,
      recentActivities: strava?.recentActivities ?? [],
      weeklyMileage: strava?.weeklyMileage ?? [],
      recentNutrition,
    });

    cacheBrief(brief);
    return NextResponse.json(brief);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
