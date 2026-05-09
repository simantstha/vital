'use client';

import { useState, useEffect, useMemo } from 'react';
import type { RecoveryState, MetricsData, DailyBrief } from '@/lib/types';
import type { StravaData } from '@/lib/strava';
import { parseMarkup } from '@/lib/markup';
import { STATES, BRIEFS, NUTRITION, METRICS, MEALS, MEAL_WINDOWS, MILEAGE, ROUTES } from '@/lib/data';
import AmbientOrbs from '@/components/AmbientOrbs';
import StateToggle from '@/components/StateToggle';
import TopBar from '@/components/TopBar';
import MorningBrief from '@/components/MorningBrief';
import MetricsRow from '@/components/MetricsRow';
import StravaPanel from '@/components/StravaPanel';
import NutritionPanel from '@/components/NutritionPanel';
import { useClock } from '@/lib/hooks';

function getRelevantMealIndex(hours: number): number {
  for (let i = 0; i < MEAL_WINDOWS.length; i++) {
    if (hours >= MEAL_WINDOWS[i].start && hours < MEAL_WINDOWS[i].end) return i;
  }
  return 3;
}

export default function DashboardPage() {
  const [state, setState] = useState<RecoveryState>('green');
  const [whoopMetrics, setWhoopMetrics] = useState<MetricsData | null>(null);
  const [stravaData, setStravaData] = useState<StravaData | null>(null);
  const [dailyBrief, setDailyBrief] = useState<DailyBrief | null>(null);

  useEffect(() => {
    fetch('/api/whoop')
      .then(r => r.json())
      .then(({ metrics, recoveryScore }: { metrics: MetricsData; recoveryScore: number }) => {
        setWhoopMetrics(metrics);
        if (recoveryScore >= 67) setState('green');
        else if (recoveryScore >= 34) setState('amber');
        else setState('red');
      })
      .catch(() => {}); // keep mock data on error / missing env vars

    fetch('/api/strava')
      .then(r => r.json())
      .then((data: StravaData & { error?: string }) => { if (!data.error) setStravaData(data); })
      .catch(() => {});

    fetch('/api/brief')
      .then(r => r.json())
      .then((data: DailyBrief) => { if (!('error' in data)) setDailyBrief(data); })
      .catch(() => {});
  }, []);

  const cfg = STATES[state];
  const brief = BRIEFS[state];
  const metrics = whoopMetrics ?? METRICS[state];
  const nutrition = NUTRITION[state];

  const now = useClock();
  const hours = now.getHours() + now.getMinutes() / 60;
  const relevantIdx = getRelevantMealIndex(hours);

  const meals = useMemo(() => {
    const source = dailyBrief
      ? dailyBrief.meals.map(m => ({ ...m, why: parseMarkup(m.why) }))
      : MEALS[state];
    return source.map((meal, i) => ({
      ...meal,
      status: (i < relevantIdx ? 'logged' : i === relevantIdx ? 'active' : 'upcoming') as
        | 'logged'
        | 'active'
        | 'upcoming',
    }));
  }, [state, relevantIdx, dailyBrief]);

  const mileage = stravaData?.mileage ?? MILEAGE;
  const routes  = stravaData?.routes  ?? ROUTES;
  const totalMi = stravaData?.totalMi ?? MILEAGE.reduce((a, b) => a + b.mi, 0);

  // Apply CSS variables on state change
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--c1', cfg.palette.c1);
    root.style.setProperty('--c2', cfg.palette.c2);
    root.style.setProperty('--c3', cfg.palette.c3);
    root.style.setProperty('--glow', cfg.palette.glow);
    root.style.setProperty('--bg-tint', cfg.palette.tint);
  }, [state, cfg]);

  return (
    <>
      <AmbientOrbs />
      <StateToggle state={state} onStateChange={setState} />
      <div className="stage">
        <TopBar stateLabel={cfg.label} now={now} />
        <MorningBrief brief={brief} claudeBrief={dailyBrief} />
        <MetricsRow metrics={metrics} />
        <div className="lower">
          <StravaPanel mileage={mileage} routes={routes} totalMi={totalMi} lastRun={stravaData?.lastRun ?? null} />
          <NutritionPanel
            nutrition={nutrition}
            meals={meals}
            relevantIdx={relevantIdx}
            generatedAt={dailyBrief?.generatedAt ?? null}
          />
        </div>
      </div>
    </>
  );
}
