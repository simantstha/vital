import fs from 'fs';
import path from 'path';
import { getUserMemoryDir } from './memory';

function overridesFile(userId: string): string {
  return path.join(getUserMemoryDir(userId), 'overrides.json');
}

function pendingBarcodeFile(userId: string): string {
  return path.join(getUserMemoryDir(userId), 'pending-barcode.json');
}

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

function ensureDir(userId: string) {
  try { fs.mkdirSync(getUserMemoryDir(userId), { recursive: true }); } catch { /* ok */ }
}

export function readCoachState(userId: string): CoachState {
  try {
    const state = JSON.parse(fs.readFileSync(overridesFile(userId), 'utf-8')) as CoachState;
    if (state.date !== today()) return { date: today(), mealOverrides: [] };
    return state;
  } catch { return { date: today(), mealOverrides: [] }; }
}

export function writeMealOverride(userId: string, override: MealOverride) {
  ensureDir(userId);
  const state = readCoachState(userId);
  const idx = state.mealOverrides.findIndex(o => o.meal === override.meal);
  if (idx >= 0) state.mealOverrides[idx] = override;
  else state.mealOverrides.push(override);
  try { fs.writeFileSync(overridesFile(userId), JSON.stringify(state), 'utf-8'); } catch { /* ok */ }
}

export function readPendingBarcode(userId: string, chatId: number): PendingBarcode | null {
  try {
    const p = JSON.parse(fs.readFileSync(pendingBarcodeFile(userId), 'utf-8')) as PendingBarcode;
    if (p.chatId !== chatId || Date.now() > p.expiresAt) return null;
    return p;
  } catch { return null; }
}

export function writePendingBarcode(userId: string, pending: PendingBarcode) {
  ensureDir(userId);
  try { fs.writeFileSync(pendingBarcodeFile(userId), JSON.stringify(pending), 'utf-8'); } catch { /* ok */ }
}

export function clearPendingBarcode(userId: string) {
  try { fs.unlinkSync(pendingBarcodeFile(userId)); } catch { /* ok */ }
}

import type { NutritionixResult } from './nutritionix';

export interface PendingMeal {
  chatId: number;
  query: string;
  result: NutritionixResult;
  meal: string;
  expiresAt: number;
}

function pendingMealFile(userId: string): string {
  return path.join(getUserMemoryDir(userId), 'pending-meal.json');
}

export function readPendingMeal(userId: string, chatId: number): PendingMeal | null {
  try {
    const p = JSON.parse(fs.readFileSync(pendingMealFile(userId), 'utf-8')) as PendingMeal;
    if (p.chatId !== chatId || Date.now() > p.expiresAt) return null;
    return p;
  } catch { return null; }
}

export function writePendingMeal(userId: string, pending: PendingMeal) {
  ensureDir(userId);
  try { fs.writeFileSync(pendingMealFile(userId), JSON.stringify(pending), 'utf-8'); } catch { /* ok */ }
}

export function clearPendingMeal(userId: string) {
  try { fs.unlinkSync(pendingMealFile(userId)); } catch { /* ok */ }
}
