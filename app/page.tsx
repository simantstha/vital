'use client';

import { useState, useEffect, useMemo } from 'react';
import type { RecoveryState, MetricsData, DailyBrief } from '@/lib/types';
import { parseMarkup } from '@/lib/markup';
import { STATES, BRIEFS, NUTRITION, MEAL_WINDOWS, MILEAGE } from '@/lib/data';
import type { MealOverride } from '@/lib/coachState';
import AmbientOrbs from '@/components/AmbientOrbs';
import TopBar from '@/components/TopBar';
import MorningBrief from '@/components/MorningBrief';
import MetricsRow from '@/components/MetricsRow';
import StravaPanel from '@/components/StravaPanel';
import NutritionPanel from '@/components/NutritionPanel';
import { useClock } from '@/lib/hooks';

type DataStatus = 'loading' | 'live' | 'error';

function getRelevantMealIndex(hours: number): number {
  for (let i = 0; i < MEAL_WINDOWS.length; i++) {
    if (hours >= MEAL_WINDOWS[i].start && hours < MEAL_WINDOWS[i].end) return i;
  }
  return 3;
}

const DESIGN_W = 1920;
const DESIGN_H = 1080;

// Zero-filled mileage bars (day labels only, no data) — shown when activity data is absent
const EMPTY_MILEAGE = MILEAGE.map(d => ({ ...d, mi: 0 }));
const EMPTY_GYM = MILEAGE.map(d => ({ d: d.d, min: 0, today: d.today }));

export default function DashboardPage() {
  const [state, setState]           = useState<RecoveryState>('green');
  const [scale, setScale]           = useState(1);
  const [whoopMetrics]              = useState<MetricsData | null>(null);   // populated by HealthKit in v2
  const [weightKg]                  = useState<number | null>(null);
  const [dailyBrief, setDailyBrief] = useState<DailyBrief | null>(null);

  const [whoopStatus]               = useState<DataStatus>('error');        // Whoop removed
  const [stravaStatus]              = useState<DataStatus>('error');        // Strava removed
  const [briefStatus, setBriefStatus] = useState<DataStatus>('loading');
  const [mfpStatus]                 = useState<DataStatus>('error');        // MFP removed
  const [mealOverrides, setMealOverrides] = useState<MealOverride[]>([]);

  // Fetch daily brief from Postgres-backed endpoint
  useEffect(() => {
    fetch('/api/brief')
      .then(r => r.json())
      .then((data: DailyBrief & { error?: string }) => {
        if ('error' in data) { setBriefStatus('error'); return; }
        setDailyBrief(data);
        setBriefStatus('live');
        // Derive recovery state from brief chip if present
        const recovChip = data.chips?.find(
          c => c.k.toLowerCase().includes('recover') || c.k.toLowerCase().includes('hrv'),
        );
        if (recovChip) {
          const v = parseInt(recovChip.v, 10);
          if (!isNaN(v)) {
            if (v >= 67) setState('green');
            else if (v >= 34) setState('amber');
            else setState('red');
          }
        }
      })
      .catch(() => setBriefStatus('error'));
  }, []);

  // Poll coach state (Telegram bot meal overrides) every 30 s
  useEffect(() => {
    const poll = () =>
      fetch('/api/coach-state')
        .then(r => r.json())
        .then((s: { mealOverrides?: MealOverride[] }) => setMealOverrides(s.mealOverrides ?? []))
        .catch(() => {/* silent */});
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function updateScale() {
      setScale(Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H));
    }
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  const cfg       = STATES[state];
  const brief     = BRIEFS[state];
  const nutrition = NUTRITION[state];

  const now        = useClock();
  const hours      = now.getHours() + now.getMinutes() / 60;
  const relevantIdx = getRelevantMealIndex(hours);

  const meals = useMemo(() => {
    if (!dailyBrief) return [];
    return dailyBrief.meals.map((m, i) => ({
      ...m,
      why: parseMarkup(m.why),
      status: (i < relevantIdx ? 'logged' : i === relevantIdx ? 'active' : 'upcoming') as
        | 'logged'
        | 'active'
        | 'upcoming',
    }));
  }, [relevantIdx, dailyBrief]);

  // Apply CSS variables on state change
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--c1',     cfg.palette.c1);
    root.style.setProperty('--c2',     cfg.palette.c2);
    root.style.setProperty('--c3',     cfg.palette.c3);
    root.style.setProperty('--glow',   cfg.palette.glow);
    root.style.setProperty('--bg-tint', cfg.palette.tint);
  }, [state, cfg]);

  return (
    <>
      <AmbientOrbs />
      <div
        className="stage"
        style={{
          width: DESIGN_W,
          height: DESIGN_H,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        <TopBar stateLabel={cfg.label} now={now} />
        <MorningBrief brief={brief} claudeBrief={dailyBrief} status={briefStatus} />
        <MetricsRow metrics={whoopMetrics} status={whoopStatus} />
        <div className="lower">
          <StravaPanel
            mileage={EMPTY_MILEAGE}
            walkMileage={EMPTY_MILEAGE}
            gymMinutes={EMPTY_GYM}
            totalMi={0}
            totalWalkMi={0}
            totalGymMin={0}
            gymSessionCount={0}
            lastRun={null}
            lastWorkout={null}
            status={stravaStatus}
          />
          <NutritionPanel
            nutrition={nutrition}
            meals={meals}
            relevantIdx={relevantIdx}
            generatedAt={dailyBrief?.generatedAt ?? null}
            mfpMacros={null}
            briefStatus={briefStatus}
            mfpStatus={mfpStatus}
            mealOverrides={mealOverrides}
            weightKg={weightKg}
          />
        </div>
      </div>
    </>
  );
}
