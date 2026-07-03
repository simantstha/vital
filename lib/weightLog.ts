import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './dataDir';

const FILE = path.join(DATA_DIR, '.vital-memory', 'weight-log.json');

export interface WeightEntry {
  date: string;    // "YYYY-MM-DD"
  weight: number;
  unit: 'lbs' | 'kg';
}

export function readWeightLog(): WeightEntry[] {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')) as WeightEntry[]; }
  catch { return []; }
}

export function logWeight(date: string, weight: number, unit: 'lbs' | 'kg') {
  const entries = readWeightLog();
  const idx = entries.findIndex(e => e.date === date);
  const entry: WeightEntry = { date, weight, unit };
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  // Keep last 90 days
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = entries.slice(-90);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
  } catch { /* read-only fs */ }
}
