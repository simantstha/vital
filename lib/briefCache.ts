import fs from 'fs';
import path from 'path';
import type { DailyBrief } from './types';

const CACHE_DIR = path.join(process.cwd(), '.brief-cache');

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

export function getCachedBrief(): DailyBrief | null {
  const file = path.join(CACHE_DIR, `${todayKey()}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as DailyBrief;
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
