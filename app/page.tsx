'use client';

import { useState, useEffect, useMemo } from 'react';
import type { RecoveryState } from '@/lib/types';
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
  const cfg = STATES[state];
  const brief = BRIEFS[state];
  const metrics = METRICS[state];
  const nutrition = NUTRITION[state];

  const now = useClock();
  const hours = now.getHours() + now.getMinutes() / 60;
  const relevantIdx = getRelevantMealIndex(hours);

  const meals = useMemo(
    () =>
      MEALS[state].map((meal, i) => ({
        ...meal,
        status: (i < relevantIdx ? 'logged' : i === relevantIdx ? 'active' : 'upcoming') as
          | 'logged'
          | 'active'
          | 'upcoming',
      })),
    [state, relevantIdx]
  );

  const totalKm = MILEAGE.reduce((a, b) => a + b.km, 0);

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
        <TopBar stateLabel={cfg.label} />
        <MorningBrief brief={brief} />
        <MetricsRow metrics={metrics} />
        <div className="lower">
          <StravaPanel mileage={MILEAGE} routes={ROUTES} />
          <NutritionPanel
            nutrition={nutrition}
            meals={meals}
            relevantIdx={relevantIdx}
            totalKm={totalKm}
          />
        </div>
      </div>
    </>
  );
}
