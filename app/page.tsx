'use client';

import { useState, useEffect, useMemo } from 'react';
import type { RecoveryState, MetricsData, DailyBrief } from '@/lib/types';
import type { StravaData } from '@/lib/strava';
import type { MFPMacros } from '@/lib/mfp';
import { parseMarkup } from '@/lib/markup';
import { STATES, BRIEFS, NUTRITION, METRICS, MEALS, MEAL_WINDOWS, MILEAGE } from '@/lib/data';
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

// Zero-filled mileage bars (day labels only, no data) used when Strava is offline
const EMPTY_MILEAGE = MILEAGE.map(d => ({ ...d, mi: 0 }));
const EMPTY_GYM = MILEAGE.map(d => ({ d: d.d, min: 0, today: d.today }));

export default function DashboardPage() {
  const [state, setState] = useState<RecoveryState>('green');
  const [scale, setScale] = useState(1);
  const [whoopMetrics, setWhoopMetrics] = useState<MetricsData | null>(null);
  const [stravaData, setStravaData] = useState<StravaData | null>(null);
  const [dailyBrief, setDailyBrief] = useState<DailyBrief | null>(null);
  const [mfpMacros, setMfpMacros] = useState<MFPMacros | null>(null);

  const [whoopStatus, setWhoopStatus] = useState<DataStatus>('loading');
  const [stravaStatus, setStravaStatus] = useState<DataStatus>('loading');
  const [briefStatus, setBriefStatus] = useState<DataStatus>('loading');
  const [mfpStatus, setMfpStatus] = useState<DataStatus>('loading');

  useEffect(() => {
    fetch('/api/whoop')
      .then(r => r.json())
      .then(({ metrics, recoveryScore }: { metrics: MetricsData; recoveryScore: number }) => {
        setWhoopMetrics(metrics);
        setWhoopStatus('live');
        if (recoveryScore >= 67) setState('green');
        else if (recoveryScore >= 34) setState('amber');
        else setState('red');
      })
      .catch(() => setWhoopStatus('error'));

    fetch('/api/strava')
      .then(r => r.json())
      .then((data: StravaData & { error?: string }) => {
        if (data.error) { setStravaStatus('error'); return; }
        setStravaData(data);
        setStravaStatus('live');
      })
      .catch(() => setStravaStatus('error'));

    fetch('/api/brief')
      .then(r => r.json())
      .then((data: DailyBrief & { error?: string }) => {
        if ('error' in data) { setBriefStatus('error'); return; }
        setDailyBrief(data);
        setBriefStatus('live');
      })
      .catch(() => setBriefStatus('error'));

    fetch('/api/mfp')
      .then(r => r.json())
      .then((data: MFPMacros & { error?: string }) => {
        if (data.error) { setMfpStatus('error'); return; }
        setMfpMacros(data);
        setMfpStatus('live');
      })
      .catch(() => setMfpStatus('error'));
  }, []);

  useEffect(() => {
    function updateScale() {
      setScale(Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H));
    }
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  const cfg = STATES[state];
  // mock brief/nutrition used only for palette-driven static content (chip icons, quote)
  const brief = BRIEFS[state];
  const nutrition = NUTRITION[state];

  const now = useClock();
  const hours = now.getHours() + now.getMinutes() / 60;
  const relevantIdx = getRelevantMealIndex(hours);

  // Meals come from real brief only — empty when loading/error so NutritionPanel shows correct state
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

  const mileage         = stravaData?.mileage         ?? EMPTY_MILEAGE;
  const walkMileage     = stravaData?.walkMileage     ?? EMPTY_MILEAGE;
  const gymMinutes      = stravaData?.gymMinutes      ?? EMPTY_GYM;
  const totalMi         = stravaData?.totalMi         ?? 0;
  const totalWalkMi     = stravaData?.totalWalkMi     ?? 0;
  const totalGymMin     = stravaData?.totalGymMin     ?? 0;
  const gymSessionCount = stravaData?.gymSessionCount ?? 0;

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
            mileage={mileage}
            walkMileage={walkMileage}
            gymMinutes={gymMinutes}
            totalMi={totalMi}
            totalWalkMi={totalWalkMi}
            totalGymMin={totalGymMin}
            gymSessionCount={gymSessionCount}
            lastRun={stravaData?.lastRun ?? null}
            lastWorkout={stravaData?.lastWorkout ?? null}
            status={stravaStatus}
          />
          <NutritionPanel
            nutrition={nutrition}
            meals={meals}
            relevantIdx={relevantIdx}
            generatedAt={dailyBrief?.generatedAt ?? null}
            mfpMacros={mfpMacros}
            briefStatus={briefStatus}
            mfpStatus={mfpStatus}
          />
        </div>
      </div>
    </>
  );
}
