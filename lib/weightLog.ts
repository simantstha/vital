import fs from 'fs';
import path from 'path';
import { getUserMemoryDir } from './memory';

function fileFor(userId: string): string {
  return path.join(getUserMemoryDir(userId), 'weight-log.json');
}

export interface WeightEntry {
  date: string;    // "YYYY-MM-DD"
  weight: number;
  unit: 'lbs' | 'kg';
}

export function readWeightLog(userId: string): WeightEntry[] {
  try { return JSON.parse(fs.readFileSync(fileFor(userId), 'utf-8')) as WeightEntry[]; }
  catch { return []; }
}

export function logWeight(userId: string, date: string, weight: number, unit: 'lbs' | 'kg') {
  const entries = readWeightLog(userId);
  const idx = entries.findIndex(e => e.date === date);
  const entry: WeightEntry = { date, weight, unit };
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  // Keep last 90 days
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = entries.slice(-90);
  try {
    fs.mkdirSync(getUserMemoryDir(userId), { recursive: true });
    fs.writeFileSync(fileFor(userId), JSON.stringify(trimmed, null, 2), 'utf-8');
  } catch { /* read-only fs */ }
}
