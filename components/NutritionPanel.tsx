'use client';

import { useState } from 'react';
import type { NutritionData, Meal } from '@/lib/types';

interface NutritionPanelProps {
  nutrition: NutritionData;
  meals: Meal[];
  relevantIdx: number;
  generatedAt?: string | null;
}

export default function NutritionPanel({
  nutrition,
  meals,
  relevantIdx,
  generatedAt,
}: NutritionPanelProps) {
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const shown = focusedIdx != null ? meals[focusedIdx] : meals[relevantIdx];

  const consumedKcal = meals
    .filter((x) => x.status === 'logged')
    .reduce((a, b) => a + b.kcal, 0);
  const totalKcal = meals.reduce((a, b) => a + b.kcal, 0);

  return (
    <div className="glass panel">
      <div className="panel-head">
        <div className="panel-title">
          Nutrition &amp; Training <span className="src claude">CLAUDE</span>
        </div>
        <div className="panel-meta">
          Updated {generatedAt
            ? new Date(generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            : '6:42 AM'}
        </div>
      </div>

      <div className="quote-card">
        <div className="quote-mark">&ldquo;</div>
        <div>
          <div className="quote-body">{nutrition.quote}</div>
          <div className="quote-attr">Post-workout macro plan</div>
        </div>
      </div>

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
        <div className="feat-macros">
          <div className="feat-macro c">
            <span className="l">Carbs</span>
            <span className="v">
              {shown.c}
              <span className="u">g</span>
            </span>
          </div>
          <div className="feat-macro p">
            <span className="l">Protein</span>
            <span className="v">
              {shown.p}
              <span className="u">g</span>
            </span>
          </div>
          <div className="feat-macro f">
            <span className="l">Fat</span>
            <span className="v">
              {shown.f}
              <span className="u">g</span>
            </span>
          </div>
        </div>
      </div>

      <div className="meal-strip">
        {meals.map((meal, i) => (
          <div
            key={meal.k}
            className={`strip-cell ${meal.status}${focusedIdx === i ? ' focused' : ''}`}
            onClick={() => setFocusedIdx(focusedIdx === i ? null : i)}
          >
            <div className="strip-head">
              <span className="strip-dot" />
              <span className="strip-name">{meal.k}</span>
              <span className="strip-time">{meal.t}</span>
            </div>
            <div className="strip-kcal">
              {meal.kcal}
              <span className="u">kcal</span>
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">Today&apos;s Macros</div>
      <div className="macros">
        {(
          [
            ['carbs', 'Carbs', nutrition.macros.c],
            ['protein', 'Protein', nutrition.macros.p],
            ['fat', 'Fat', nutrition.macros.f],
          ] as [string, string, { v: number; t: number }][]
        ).map(([cls, label, mac]) => (
          <div key={cls} className={`macro ${cls}`}>
            <div className="ring" />
            <div className="k">{label}</div>
            <div className="v">
              {mac.v}
              <span className="u">g</span>
            </div>
            <div className="target">of {mac.t}g target</div>
            <div className="pbar">
              <span style={{ width: (mac.v / mac.t) * 100 + '%' }} />
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
