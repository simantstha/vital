export type RecoveryState = 'green' | 'amber' | 'red';

export interface Palette {
  c1: string;
  c2: string;
  c3: string;
  glow: string;
  tint: string;
}

export interface StateConfig {
  label: string;
  score: number;
  palette: Palette;
}

export interface BriefChip {
  k: string;
  v: string;
  icon: 'bolt' | 'moon' | 'flame';
}

export interface BriefData {
  body: React.ReactNode;
  chips: BriefChip[];
}

export interface MacroTarget {
  v: number;
  t: number;
}

export interface NutritionData {
  quote: React.ReactNode;
  macros: {
    c: MacroTarget;
    p: MacroTarget;
    f: MacroTarget;
  };
}

export interface MetricCard {
  v: number | string;
  unit?: string;
  sub: string;
}

export interface MetricsData {
  recovery: MetricCard;
  hrv: MetricCard;
  rhr: MetricCard;
  sleep: MetricCard;
  strain: MetricCard;
}

export type MealStatus = 'logged' | 'active' | 'upcoming';

export interface Meal {
  k: string;
  t: string;
  h: number;
  kcal: number;
  c: number;
  p: number;
  f: number;
  items: string;
  why: React.ReactNode;
  status?: MealStatus;
}

export interface MileageDay {
  d: string;
  km: number;
  today?: boolean;
}

export interface Route {
  name: string;
  d: string;
  e: string;
  p: string;
  count: number;
}
