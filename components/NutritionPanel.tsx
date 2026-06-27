'use client';

import { useState } from 'react';
import type { NutritionData, Meal } from '@/lib/types';
import type { MealOverride } from '@/lib/coachState';

type DataStatus = 'loading' | 'live' | 'error';

/** Macro data logged today (previously from MFP, now sourced from Postgres). */
interface LoggedMacros {
  hasData: boolean;
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
}

interface NutritionPanelProps {
  nutrition: NutritionData;
  meals: Meal[];
  relevantIdx: number;
  generatedAt?: string | null;
  mfpMacros?: LoggedMacros | null;
  briefStatus: DataStatus;
  mfpStatus: DataStatus;
  mealOverrides?: MealOverride[];
  weightKg?: number | null;
}

export default function NutritionPanel({
  nutrition,
  meals,
  relevantIdx,
  generatedAt,
  mfpMacros,
  briefStatus,
  mfpStatus,
  mealOverrides = [],
  weightKg,
}: NutritionPanelProps) {
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);

  const hasMeals = meals.length > 0;
  const baseShown = hasMeals
    ? (focusedIdx != null ? meals[focusedIdx] : meals[relevantIdx] ?? meals[0])
    : null;

  // Apply coach override to the displayed meal if one exists
  const shownOverride = baseShown
    ? mealOverrides.find(o => o.meal === baseShown.k.toLowerCase())
    : undefined;
  const shown = baseShown && shownOverride
    ? { ...baseShown, kcal: shownOverride.kcal, c: shownOverride.c, p: shownOverride.p, f: shownOverride.f, items: shownOverride.items }
    : baseShown;

  const consumedKcal = meals
    .filter((x) => x.status === 'logged')
    .reduce((a, b) => a + b.kcal, 0);
  const totalKcal = meals.reduce((a, b) => a + b.kcal, 0);

  return (
    <div className="glass panel nutrition-panel">
      <div className="panel-head">
        <div className="panel-title">
          Nutrition &amp; Training{' '}
          {briefStatus === 'error' ? (
            <span style={{ fontSize: '0.7rem', color: 'rgba(255,180,100,0.85)', marginLeft: 4 }}>⚠ Brief unavailable</span>
          ) : (
            <span className="src claude" style={{ opacity: briefStatus === 'loading' ? 0.4 : 1 }}>CLAUDE</span>
          )}
          {mfpMacros?.hasData && mfpStatus === 'live' && (
            <span className="src" style={{ background: 'rgba(99,179,237,0.15)', color: '#63b3ed', marginLeft: 4 }}>MFP</span>
          )}
        </div>
        <div className="panel-meta">
          {briefStatus === 'loading'
            ? 'Generating…'
            : briefStatus === 'error'
            ? '—'
            : `Updated ${generatedAt
                ? new Date(generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                : '6:42 AM'}`}
        </div>
      </div>

      <div className="nutrition-note">
        <div className="quote-mark">&ldquo;</div>
        <div>
          <div className="quote-body">{nutrition.quote}</div>
          <div className="quote-attr">Training fuel note</div>
        </div>
      </div>

      <div className="section-title">Today&apos;s Macros</div>
      <div className="macros">
        {(
          [
            ['carbs',   'Carbs',   nutrition.macros.c, mfpMacros?.hasData && mfpStatus === 'live' ? mfpMacros.carbs   : undefined],
            ['protein', 'Protein', nutrition.macros.p, mfpMacros?.hasData && mfpStatus === 'live' ? mfpMacros.protein : undefined],
            ['fat',     'Fat',     nutrition.macros.f, mfpMacros?.hasData && mfpStatus === 'live' ? mfpMacros.fat     : undefined],
          ] as [string, string, { v: number; t: number }, number | undefined][]
        ).map(([cls, label, mac, real]) => {
          const consumed = real ?? mac.v;
          return (
            <div key={cls} className={`macro ${cls}`}>
              <div className="ring" />
              <div className="k">{label}</div>
              <div className="v">
                {consumed}
                <span className="u">g</span>
              </div>
              <div className="target">of {mac.t}g target</div>
              <div className="pbar">
                <span style={{ width: Math.min((consumed / mac.t) * 100, 100) + '%' }} />
              </div>
            </div>
          );
        })}
      </div>

      {weightKg && (
        <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)', marginTop: 8, marginBottom: 2, letterSpacing: '0.04em' }}>
          {(weightKg * 2.205).toFixed(1)} lbs · {weightKg.toFixed(1)} kg · Whoop
        </div>
      )}

      {/* Meal section — hidden when brief failed or no meals yet */}
      {briefStatus === 'error' ? (
        <div className="section-title" style={{ opacity: 0.45, marginTop: 12 }}>
          Meal recommendations unavailable
        </div>
      ) : hasMeals && shown ? (
        <>
          <div className="section-title section-title-row">
            <span>
              {focusedIdx != null && focusedIdx !== relevantIdx
                ? 'Coming up'
                : shown.status === 'logged'
                ? 'Logged'
                : 'Up next'}
            </span>
            <span className="kcal-summary">
              <span className="kcal-consumed">{consumedKcal.toLocaleString()}</span>
              <span className="kcal-total"> / {totalKcal.toLocaleString()} kcal today</span>
            </span>
          </div>

          <div className="meal-feature">
            <div className="meal-feature-main">
              <div className="feat-head">
                <span className="feat-pulse" />
                <span className="feat-label">
                  {shown.status === 'logged' ? 'Logged' : shown.status === 'active' ? 'Now' : 'Up next'}
                </span>
                <span className="feat-sep">·</span>
                <span className="feat-meal-name">{shown.k}</span>
                <span className="feat-claude">Claude suggests</span>
              </div>
              <div className="feat-row">
                <div className="feat-kcal">
                  {shown.kcal}
                  <span className="u">kcal</span>
                </div>
                <div className="feat-time">{shown.t}</div>
              </div>
              <div className="feat-items">{shown.items}</div>
              <div className="feat-why">{shown.why}</div>
            </div>

            <div className="feat-macros">
              <div className="feat-macro c">
                <span className="l">Carbs</span>
                <span className="v">{shown.c}<span className="u">g</span></span>
              </div>
              <div className="feat-macro p">
                <span className="l">Protein</span>
                <span className="v">{shown.p}<span className="u">g</span></span>
              </div>
              <div className="feat-macro f">
                <span className="l">Fat</span>
                <span className="v">{shown.f}<span className="u">g</span></span>
              </div>
            </div>
          </div>

          <div className="meal-strip">
            {meals.map((meal, i) => {
              const override = mealOverrides.find(o => o.meal === meal.k.toLowerCase());
              return (
                <div
                  key={meal.k}
                  className={`strip-cell ${meal.status}${focusedIdx === i ? ' focused' : ''}${override ? ' overridden' : ''}`}
                  onClick={() => setFocusedIdx(focusedIdx === i ? null : i)}
                >
                  <div className="strip-head">
                    <span className="strip-dot" />
                    <span className="strip-name">{meal.k}</span>
                    <span className="strip-time">{meal.t}</span>
                  </div>
                  <div className="strip-kcal">
                    {override ? override.kcal : meal.kcal}
                    <span className="u">kcal</span>
                  </div>
                  {override && <span className="override-badge">ADJUSTED</span>}
                </div>
              );
            })}
          </div>
        </>
      ) : briefStatus === 'loading' ? (
        <div className="section-title" style={{ opacity: 0.3, marginTop: 12 }}>
          Loading meal plan…
        </div>
      ) : null}
    </div>
  );
}
