import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './dataDir';

const MEMORY_DIR = path.join(DATA_DIR, '.vital-memory');
const OVERRIDES_FILE = path.join(MEMORY_DIR, 'overrides.json');
const PENDING_FILE   = path.join(MEMORY_DIR, 'pending-barcode.json');

export interface MealOverride {
  meal: string;        // "breakfast" | "lunch" | "snack" | "dinner"
  kcal: number;
  c: number;
  p: number;
  f: number;
  items: string;
  reason: string;
  updatedAt: string;   // ISO
}

export interface CoachState {
  date: string;        // "YYYY-MM-DD" — overrides reset on new day
  mealOverrides: MealOverride[];
}

export interface PendingBarcode {
  chatId: number;
  productName: string;
  brand?: string;
  per100g: { kcal: number; c: number; p: number; f: number };
  expiresAt: number;   // epoch ms — 5-minute TTL
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function ensureDir() {
  try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch { /* ok */ }
}

export function readCoachState(): CoachState {
  try {
    const state = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8')) as CoachState;
    if (state.date !== today()) return { date: today(), mealOverrides: [] };
    return state;
  } catch { return { date: today(), mealOverrides: [] }; }
}

export function writeMealOverride(override: MealOverride) {
  ensureDir();
  const state = readCoachState();
  const idx = state.mealOverrides.findIndex(o => o.meal === override.meal);
  if (idx >= 0) state.mealOverrides[idx] = override;
  else state.mealOverrides.push(override);
  try { fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(state), 'utf-8'); } catch { /* ok */ }
}

export function readPendingBarcode(chatId: number): PendingBarcode | null {
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')) as PendingBarcode;
    if (p.chatId !== chatId || Date.now() > p.expiresAt) return null;
    return p;
  } catch { return null; }
}

export function writePendingBarcode(pending: PendingBarcode) {
  ensureDir();
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(pending), 'utf-8'); } catch { /* ok */ }
}

export function clearPendingBarcode() {
  try { fs.unlinkSync(PENDING_FILE); } catch { /* ok */ }
}

import type { NutritionixResult } from './nutritionix';

export interface PendingMeal {
  chatId: number;
  query: string;
  result: NutritionixResult;
  meal: string;
  expiresAt: number;
}

const PENDING_MEAL_FILE = path.join(MEMORY_DIR, 'pending-meal.json');

export function readPendingMeal(chatId: number): PendingMeal | null {
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_MEAL_FILE, 'utf-8')) as PendingMeal;
    if (p.chatId !== chatId || Date.now() > p.expiresAt) return null;
    return p;
  } catch { return null; }
}

export function writePendingMeal(pending: PendingMeal) {
  ensureDir();
  try { fs.writeFileSync(PENDING_MEAL_FILE, JSON.stringify(pending), 'utf-8'); } catch { /* ok */ }
}

export function clearPendingMeal() {
  try { fs.unlinkSync(PENDING_MEAL_FILE); } catch { /* ok */ }
}
