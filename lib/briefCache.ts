import fs from 'fs';
import path from 'path';
import type { DailyBrief } from './types';
import { DATA_DIR } from './dataDir';

const CACHE_DIR = path.join(DATA_DIR, '.brief-cache');

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

export function getCachedBrief(): DailyBrief | null {
  const file = path.join(CACHE_DIR, `${todayKey()}.json`);
  try {
    const brief = JSON.parse(fs.readFileSync(file, 'utf-8')) as DailyBrief;
    // Discard cache if it was generated before 5 AM — sleep data was incomplete
    const generatedHour = new Date(brief.generatedAt).getHours();
    if (generatedHour < 5) return null;
    return brief;
  } catch {
    return null;
  }
}

export function cacheBrief(brief: DailyBrief): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${brief.date}.json`), JSON.stringify(brief, null, 2));
  } catch {
    // Read-only filesystem (Vercel) — skip silently
  }
}

export function bustCache(): void {
  const file = path.join(CACHE_DIR, `${todayKey()}.json`);
  try {
    fs.unlinkSync(file);
  } catch {
    // No cache to bust
  }
}
