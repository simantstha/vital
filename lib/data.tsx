import type {
  StateConfig,
  BriefData,
  NutritionData,
  MetricsData,
  Meal,
  MileageDay,
  Route,
} from './types';

export const STATES: Record<string, StateConfig> = {
  green: {
    label: 'Recovered',
    score: 87,
    palette: { c1: '#34d399', c2: '#10b981', c3: '#6ee7b7', glow: '52, 211, 153', tint: '16, 185, 129' },
  },
  amber: {
    label: 'Adequate',
    score: 64,
    palette: { c1: '#facc15', c2: '#eab308', c3: '#fde68a', glow: '250, 204, 21', tint: '234, 179, 8' },
  },
  red: {
    label: 'Compromised',
    score: 31,
    palette: { c1: '#f87171', c2: '#dc2626', c3: '#fca5a5', glow: '248, 113, 113', tint: '220, 38, 38' },
  },
};

export const BRIEFS: Record<string, BriefData> = {
  green: {
    body: (
      <>
        Your body is <em>primed for hard work</em> today. HRV held high through the night, sleep latency was just{' '}
        <b>11 minutes</b>, and resting heart rate trended down to <b>49 bpm</b>. Conditions favor a{' '}
        <b>quality interval session</b> — push the upper end without guilt.
      </>
    ),
    chips: [
      { k: 'Workout', v: '6×800m @ 5K pace', icon: 'bolt' },
      { k: 'Sleep', v: '94% · 7h 48m', icon: 'moon' },
      { k: 'Strain', v: 'Capacity 18.2', icon: 'flame' },
    ],
  },
  amber: {
    body: (
      <>
        Recovery is <em>middling</em>. HRV slipped 18% below your 14-day baseline and sleep efficiency was choppy
        after midnight. Today calls for a <b>controlled aerobic effort</b> — Zone 2 only. Hydrate aggressively and
        protect the evening for a real wind-down.
      </>
    ),
    chips: [
      { k: 'Workout', v: '60min Zone 2 easy', icon: 'bolt' },
      { k: 'Sleep', v: '71% · 6h 42m', icon: 'moon' },
      { k: 'Strain', v: 'Cap 12.4', icon: 'flame' },
    ],
  },
  red: {
    body: (
      <>
        Your body is <em>under-recovered</em>. HRV crashed to <b>34ms</b>, RHR climbed 7 bpm overnight, and
        respiratory rate was elevated through deep sleep. Today is a <b>true rest day</b> — no intervals, no tempo.
        A 20-minute walk and a long sleep tonight is the workout.
      </>
    ),
    chips: [
      { k: 'Workout', v: 'Walk 20min · mobility', icon: 'bolt' },
      { k: 'Sleep', v: '52% · 5h 18m', icon: 'moon' },
      { k: 'Strain', v: 'Cap 7.0', icon: 'flame' },
    ],
  },
};

export const NUTRITION: Record<string, NutritionData> = {
  green: {
    quote: (
      <>
        Big session ahead. Front-load <b>carbs early</b>, hit a real meal within <b>45 min</b> of finishing, and
        target <b>1.6g/kg protein</b> across the day.
      </>
    ),
    macros: { c: { v: 412, t: 480 }, p: { v: 138, t: 165 }, f: { v: 62, t: 75 } },
  },
  amber: {
    quote: (
      <>
        Z2 day means fewer simple carbs. Lean into <b>protein and fats</b> through the morning, and save the carb
        load for after this evening&apos;s session.
      </>
    ),
    macros: { c: { v: 268, t: 340 }, p: { v: 142, t: 165 }, f: { v: 78, t: 85 } },
  },
  red: {
    quote: (
      <>
        Recovery starts at the table. Push <b>protein to 2g/kg</b>, add <b>tart cherry &amp; magnesium</b> tonight,
        and skip alcohol — sleep is the workout.
      </>
    ),
    macros: { c: { v: 226, t: 280 }, p: { v: 168, t: 180 }, f: { v: 84, t: 90 } },
  },
};

export const METRICS: Record<string, MetricsData> = {
  green: {
    recovery: { v: 87, sub: '↑ 9 vs 14d avg' },
    hrv: { v: 78, unit: 'ms', sub: 'High band · ↑ 12%' },
    rhr: { v: 49, unit: 'bpm', sub: '↓ 2 vs baseline' },
    sleep: { v: 94, unit: '%', sub: '7h 48m · 99% consist.' },
    strain: { v: '14.2', sub: 'Yesterday · moderate' },
  },
  amber: {
    recovery: { v: 64, sub: '↓ 8 vs 14d avg' },
    hrv: { v: 52, unit: 'ms', sub: 'Mid band · ↓ 18%' },
    rhr: { v: 54, unit: 'bpm', sub: '↑ 3 vs baseline' },
    sleep: { v: 71, unit: '%', sub: '6h 42m · 84% consist.' },
    strain: { v: '17.8', sub: 'Yesterday · high' },
  },
  red: {
    recovery: { v: 31, sub: '↓ 26 vs 14d avg' },
    hrv: { v: 34, unit: 'ms', sub: 'Low band · ↓ 41%' },
    rhr: { v: 58, unit: 'bpm', sub: '↑ 7 vs baseline' },
    sleep: { v: 52, unit: '%', sub: '5h 18m · 61% consist.' },
    strain: { v: '19.4', sub: 'Yesterday · very high' },
  },
};

export const MEALS: Record<string, Meal[]> = {
  green: [
    {
      k: 'Breakfast', t: '7:30 AM', h: 7.5, kcal: 540, c: 78, p: 30, f: 14,
      items: 'Steel-cut oats, blueberries, Greek yogurt, honey',
      why: <>Front-load <em>slow carbs ~90 min</em> before your <b>6×800m</b>. Oats + berries hit ~1.5g/kg without sitting heavy, yogurt covers the protein floor.</>,
    },
    {
      k: 'Lunch', t: '12:45 PM', h: 12.75, kcal: 740, c: 88, p: 48, f: 22,
      items: 'Chicken & quinoa bowl, avocado, greens',
      why: <>Refuel within <em>60 min of intervals</em>. Quinoa + chicken hits the <b>4:1 carb-to-protein</b> ratio your glycogen wants right now.</>,
    },
    {
      k: 'Snack', t: '3:30 PM', h: 15.5, kcal: 320, c: 48, p: 8, f: 14,
      items: 'Banana, almond butter, medjool dates',
      why: <>Mid-afternoon dip after a hard session. <b>Fast carbs + a little fat</b> — keeps glycogen topping up without spiking insulin.</>,
    },
    {
      k: 'Dinner', t: '7:30 PM', h: 19.5, kcal: 680, c: 78, p: 42, f: 20,
      items: 'Salmon, sweet potato, roasted greens',
      why: <>Final <em>protein hit</em> + Omega-3 from salmon for inflammation. Sweet potato nudges serotonin to help you fall asleep faster.</>,
    },
  ],
  amber: [
    {
      k: 'Breakfast', t: '7:30 AM', h: 7.5, kcal: 460, c: 42, p: 36, f: 18,
      items: 'Eggs, sourdough, avocado, spinach',
      why: <>Z2 day means <b>cap simple carbs</b>. Eggs + sourdough give stable energy through the morning without spiking insulin.</>,
    },
    {
      k: 'Lunch', t: '12:45 PM', h: 12.75, kcal: 620, c: 58, p: 50, f: 24,
      items: 'Chicken Caesar, lentils, mixed greens',
      why: <>Lean &amp; protein-led to support tomorrow&apos;s session if HRV rebounds. <em>Lentils</em> for slow-release carbs through the afternoon.</>,
    },
    {
      k: 'Snack', t: '3:30 PM', h: 15.5, kcal: 240, c: 22, p: 18, f: 12,
      items: 'Cottage cheese, berries, walnuts',
      why: <>HRV is dipping. <b>Casein protein</b> from cottage cheese pulses amino acids through the afternoon — protects lean mass.</>,
    },
    {
      k: 'Dinner', t: '7:30 PM', h: 19.5, kcal: 660, c: 76, p: 52, f: 20,
      items: 'Lean beef, basmati rice, broccoli',
      why: <>Bigger <em>carb load</em> tonight to bank glycogen — IF tomorrow&apos;s recovery score comes back green. Otherwise dial back the rice.</>,
    },
  ],
  red: [
    {
      k: 'Breakfast', t: '7:30 AM', h: 7.5, kcal: 420, c: 38, p: 38, f: 16,
      items: 'Eggs, sweet potato hash, spinach',
      why: <>Rest mode. <b>Protein to repair</b>, carbs minimal. Iron + folate from spinach support red-blood-cell rebuild after the strain spike.</>,
    },
    {
      k: 'Lunch', t: '12:45 PM', h: 12.75, kcal: 580, c: 52, p: 54, f: 22,
      items: 'Bone broth, chicken & rice, kefir',
      why: <>Body&apos;s fighting something. <em>Bone broth</em> for connective tissue, kefir for gut barrier, simple rice for easy fuel. <b>Hydrate aggressively.</b></>,
    },
    {
      k: 'Snack', t: '3:30 PM', h: 15.5, kcal: 220, c: 16, p: 22, f: 10,
      items: 'Greek yogurt, walnuts, tart cherry juice',
      why: <><em>Tart cherry juice</em> is the move — natural melatonin precursor. Walnuts add Omega-3. Stack the deck for tonight&apos;s sleep.</>,
    },
    {
      k: 'Dinner', t: '7:30 PM', h: 19.5, kcal: 640, c: 60, p: 54, f: 24,
      items: 'Salmon, quinoa, magnesium-rich greens',
      why: <><b>Magnesium</b> from greens, Omega-3 from salmon, no late carbs. <em>Sleep is the workout</em> — protect it. Skip the wine tonight.</>,
    },
  ],
};

export const TARGET_KM = 64;

export const MEAL_WINDOWS = [
  { start: 0, end: 11 },
  { start: 11, end: 14 },
  { start: 14, end: 17 },
  { start: 17, end: 24 },
];

export const MILEAGE: MileageDay[] = [
  { d: 'M', km: 12.4 },
  { d: 'T', km: 8.0 },
  { d: 'W', km: 16.2 },
  { d: 'Th', km: 6.4, today: true },
  { d: 'F', km: 0 },
  { d: 'S', km: 0 },
  { d: 'S', km: 0 },
];

export const ROUTES: Route[] = [
  { name: 'Kelvingrove Loop', d: '8.4 km', e: '54m', p: '5:02 / km', count: 47 },
  { name: 'Pollok Park · Long', d: '14.2 km', e: '128m', p: '5:18 / km', count: 22 },
  { name: 'Clyde Tow Path', d: '10.0 km', e: '12m', p: '4:48 / km', count: 31 },
  { name: 'Cathkin Braes', d: '11.6 km', e: '212m', p: '5:34 / km', count: 9 },
];
