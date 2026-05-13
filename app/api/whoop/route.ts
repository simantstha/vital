import { NextResponse } from 'next/server';
import { fetchWhoopMetrics, fetchBodyMeasurement } from '@/lib/whoop';
import type { MetricsData } from '@/lib/types';

export const dynamic = 'force-dynamic';

function msToHm(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

export async function GET() {
  try {
    const { recovery, sleep, cycleData, yesterdayCycle } = await fetchWhoopMetrics();

    const recoveryScore = Math.round(recovery?.score?.recovery_score ?? 0);
    const hrv = Math.round(recovery?.score?.hrv_rmssd_milli ?? 0);
    const rhr = Math.round(recovery?.score?.resting_heart_rate ?? 0);

    const sleepPerf = Math.round(sleep?.score?.sleep_performance_percentage ?? 0);
    const sleepConsistency = Math.round(sleep?.score?.sleep_consistency_percentage ?? 0);
    const s = sleep?.score?.stage_summary ?? {};
    const sleepMs =
      (s.total_slow_wave_sleep_time_milli ?? 0) +
      (s.total_rem_sleep_time_milli ?? 0) +
      (s.total_light_sleep_time_milli ?? 0) ||
      (s.total_in_bed_time_milli ?? 0) - (s.total_awake_time_milli ?? 0);

    const hour = new Date().getHours();
    const showToday = hour >= 10;
    const strainCycle = showToday ? cycleData.records?.[0] : yesterdayCycle;
    const strain = strainCycle?.score?.strain?.toFixed(1) ?? '–';
    const strainLabel = showToday ? 'Today · live' : 'Yesterday · morning';

    const metrics: MetricsData = {
      recovery: {
        v: recoveryScore,
        sub: `${recoveryScore >= 67 ? '↑' : '↓'} Whoop score`,
      },
      hrv: {
        v: hrv,
        unit: 'ms',
        sub: `${hrv >= 70 ? 'High' : hrv >= 50 ? 'Mid' : 'Low'} band`,
      },
      rhr: {
        v: rhr,
        unit: 'bpm',
        sub: 'Resting · overnight',
      },
      sleep: {
        v: sleepPerf,
        unit: '%',
        sub: `${msToHm(sleepMs)} · ${sleepConsistency}% consist.`,
      },
      strain: {
        v: strain,
        sub: strainLabel,
      },
    };

    const bodyMeasurement = await fetchBodyMeasurement();

    return NextResponse.json({ metrics, recoveryScore, bodyMeasurement });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
