# Trends/Logs Data-Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Trends and Logs screens read the `daily_metrics` store (where HealthKit sync writes) instead of the stale `events` table, so a year of synced data and completed workouts actually appear.

**Architecture:** Two backend route changes only, no iOS changes. `/api/trends` is rewritten to pull day-keyed points via the existing `queryMetricPoints()` helper (deleting the old event-bucketing) and to merge manual weight entries. `/api/logs` additively surfaces `daily_metrics.workouts` via the existing `queryWorkouts()` helper. Both keep their response shapes byte-for-byte, so the installed iOS app works unchanged.

**Tech Stack:** Next.js 16 (App Router route handlers), Drizzle ORM, Postgres/Supabase, TypeScript. No test framework in this repo — verification is `tsc --noEmit`, `eslint`, exercising `next dev`, and a post-deploy canary.

## Global Constraints

- **No iOS changes.** Response shapes must stay identical: Trends returns `{ metric, points: [{ date: "YYYY-MM-DD", value: number }] }` oldest→newest; Logs returns `{ items: [{ id, type, timestamp (ISO 8601), title, subtitle, imageThumb? }] }` newest-first.
- **Read `daily_metrics` only** (plus the manual weight file for weight). Do NOT union legacy `events` health rows.
- **Weight stays in kg** this release (canonical). Unit preference is deferred (feature #4).
- **Reuse existing helpers** in `lib/brain/tools.ts` (`queryMetricPoints`, `queryWorkouts`) — do not write new DB queries.
- **Minimal diff.** No new dependencies, no test harness, no refactoring beyond the two routes.
- Preserve existing auth (`getUserIdFromRequest`), `dynamic = 'force-dynamic'`, and metric validation.

---

### Task 1: Trends route reads `daily_metrics`

**Files:**
- Modify (full rewrite): `app/api/trends/route.ts`

**Interfaces:**
- Consumes: `queryMetricPoints(userId: string, metric: string, days: number): Promise<{ date: string; value: number }[]>` and `readWeightLog(userId: string): { date: string; weight: number; unit: 'lbs' | 'kg' }[]`.
- Produces: unchanged HTTP contract `GET /api/trends?metric=hrv|sleep|weight|steps&days=30` → `{ metric, points: [{ date, value }] }`.

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `app/api/trends/route.ts` with:

```ts
/**
 * GET /api/trends?metric=hrv|sleep|weight|steps&days=30
 *
 * Day-keyed time series for one metric, sourced from the `daily_metrics` store
 * — the same store the 1-year backfill + background sync write to, and that the
 * Today screen reads. `daily_metrics` is already unique per (user, date, metric),
 * so no bucketing is needed. Weight additionally merges manual weight-log.json
 * entries (manual wins per day).
 *
 * Response: { metric, points: [{ date: "YYYY-MM-DD", value }] }  // oldest → newest
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { queryMetricPoints } from '@/lib/brain/tools';
import { readWeightLog } from '@/lib/weightLog';

export const dynamic = 'force-dynamic';

const VALID_METRICS = new Set(['hrv', 'sleep', 'weight', 'steps']);

// Trends metric name → daily_metrics metric name
const DAILY_METRIC: Record<string, string> = {
  hrv:    'hrv_sdnn',
  sleep:  'sleep_minutes',
  weight: 'body_mass_kg',
  steps:  'steps',
};

function transform(metric: string, value: number): number {
  switch (metric) {
    case 'sleep':  return Math.round((value / 60) * 10) / 10; // minutes → hours (1dp)
    case 'weight': return Math.round(value * 10) / 10;        // kg (1dp)
    case 'hrv':    return Math.round(value);                  // ms
    case 'steps':  return Math.round(value);
    default:       return value;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const metric = searchParams.get('metric') ?? '';
  const days   = Math.max(1, Math.min(365, Number(searchParams.get('days') ?? '30')));

  if (!VALID_METRICS.has(metric)) {
    return NextResponse.json(
      { error: `Invalid metric. Must be one of: ${[...VALID_METRICS].join(', ')}` },
      { status: 400 },
    );
  }

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const raw = await queryMetricPoints(userId, DAILY_METRIC[metric], days);
  const byDate = new Map<string, number>();
  for (const p of raw) byDate.set(p.date, transform(metric, p.value));

  // Weight: overlay manual entries (manual wins per day), normalized to kg.
  if (metric === 'weight') {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    const sinceStr = since.toISOString().split('T')[0];
    for (const e of readWeightLog(userId)) {
      if (e.date < sinceStr) continue;
      const kg = e.unit === 'lbs' ? e.weight * 0.453592 : e.weight;
      byDate.set(e.date, Math.round(kg * 10) / 10);
    }
  }

  const points = [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({ metric, points });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (in particular, `queryMetricPoints` and `readWeightLog` resolve).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors for `app/api/trends/route.ts`.

- [ ] **Step 4: Exercise against the running app (behavioral check)**

Start the dev server (`npm run dev`) with the local Postgres pointed at data that has `daily_metrics` rows. Using a valid session token (dev sign-in), hit each metric:

```bash
# Replace $TOKEN with a dev session JWT; adjust host/port if needed.
for m in hrv sleep weight steps; do
  echo "== $m =="
  curl -s "http://localhost:3000/api/trends?metric=$m&days=30" \
    -H "Authorization: Bearer $TOKEN" | head -c 400; echo
done
```

Expected: each returns `{"metric":"<m>","points":[{"date":"YYYY-MM-DD","value":<n>}, ...]}` with a non-empty `points` array when the DB has that metric. Sanity-check units: `sleep` values are hours (~6–9), `weight` ~kg, `hrv`/`steps` are integers.

If no local DB is available, rely on Steps 2–3 plus the post-deploy canary in Task 3.

- [ ] **Step 5: Commit**

```bash
git add app/api/trends/route.ts
git commit -m "fix(trends): source time series from daily_metrics, not events

Trends read the stale events table (hrv_reading/sleep_session/etc) which
the HealthKit sync no longer writes; the backfilled year lives in
daily_metrics. Reuse queryMetricPoints(), map metric names, and merge
manual weight entries. Response shape unchanged — no iOS change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LjRjXaUkL5WU1tvpLR9qSN"
```

---

### Task 2: Logs route surfaces synced workouts

**Files:**
- Modify: `app/api/logs/route.ts` (add import; rename local `items` → `eventItems`; append workout items; merge + sort)

**Interfaces:**
- Consumes: `queryWorkouts(userId: string, days: number): Promise<Array<{ date: string; [key: string]: unknown }>>` from `lib/brain/tools.ts`. Each entry carries the ingested workout fields `{ hkUuid, type, durationMin, kcal }` alongside `date`. (Note: `queryWorkouts` internally clamps `days` to a max of 30 — acceptable for a recent-activity feed whose default window is 3 days.)
- Produces: unchanged HTTP contract `GET /api/logs?days=3` → `{ items: [...] }` newest-first, now including `type: 'workout_completed'` items sourced from `daily_metrics`.

- [ ] **Step 1: Add the import**

In `app/api/logs/route.ts`, extend the auth import line by adding a new import directly below it:

```ts
import { getUserIdFromRequest } from '@/lib/auth';
import { queryWorkouts } from '@/lib/brain/tools';
```

- [ ] **Step 2: Rename the event items and append synced workouts**

Find this block at the end of the `GET` handler:

```ts
  const items = events.map(e => {
    const thumb = str(pl(e.payload).imageThumb);
    return {
      id:        e.id,
      type:      e.type,
      timestamp: e.timestamp.toISOString(),
      title:     formatTitle(e.type, e.payload),
      subtitle:  formatSubtitle(e.type, e.payload),
      ...(thumb ? { imageThumb: thumb } : {}),
    };
  });

  return NextResponse.json({ items });
```

Replace it with:

```ts
  const eventItems = events.map(e => {
    const thumb = str(pl(e.payload).imageThumb);
    return {
      id:        e.id,
      type:      e.type,
      timestamp: e.timestamp.toISOString(),
      title:     formatTitle(e.type, e.payload),
      subtitle:  formatSubtitle(e.type, e.payload),
      ...(thumb ? { imageThumb: thumb } : {}),
    };
  });

  // Workouts synced from HealthKit live in daily_metrics (not events), so the
  // events query above never sees them. Surface them here. No exact start time
  // is stored, so anchor to noon UTC on the workout's day for stable ordering.
  const workouts = await queryWorkouts(userId, days);
  const workoutItems = workouts.map((w, i) => {
    const wtype = str(w.type) ?? 'Workout';
    const label = wtype.charAt(0).toUpperCase() + wtype.slice(1);
    const durationMin = num(w.durationMin);
    const kcal = num(w.kcal);
    return {
      id:        str(w.hkUuid) ?? `${w.date}-workout-${i}`,
      type:      'workout_completed',
      timestamp: `${w.date}T12:00:00.000Z`,
      title:     durationMin != null ? `${label} — ${Math.round(durationMin)} min` : label,
      subtitle:  kcal != null ? `~${Math.round(kcal)} kcal` : 'Workout logged',
    };
  });

  const items = [...eventItems, ...workoutItems].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );

  return NextResponse.json({ items });
```

(ISO 8601 timestamps sort lexically in chronological order, so `localeCompare` on the strings yields correct newest-first ordering.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. `num`/`str` are already defined in this file; `queryWorkouts` resolves.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no errors for `app/api/logs/route.ts`.

- [ ] **Step 5: Exercise against the running app (behavioral check)**

With `npm run dev` running against a DB that has a `daily_metrics` row where `metric = 'workouts'` (payload = array of `{hkUuid,type,durationMin,kcal}`):

```bash
curl -s "http://localhost:3000/api/logs?days=30" \
  -H "Authorization: Bearer $TOKEN" | head -c 800; echo
```

Expected: `items` includes at least one object with `"type":"workout_completed"`, a `title` like `"Running — 32 min"`, and a `subtitle` like `"~410 kcal"`, interleaved by timestamp with any meal/weight events. If no local workout data, rely on typecheck/lint plus the post-deploy canary.

- [ ] **Step 6: Commit**

```bash
git add app/api/logs/route.ts
git commit -m "fix(logs): surface HealthKit workouts from daily_metrics

Completed workouts sync into daily_metrics.workouts, but Logs only read
workout_completed events (which sync never writes), so they were invisible.
Reuse queryWorkouts() and merge the entries into the feed. iOS already
renders workout_completed — no app change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LjRjXaUkL5WU1tvpLR9qSN"
```

---

### Task 3: Open PR, then release v0.2.2

**Files:** none (git/release operations)

**Interfaces:** Consumes the two committed fixes on branch `feat/data-unification-trends-logs`.

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin feat/data-unification-trends-logs
gh pr create --base main --title "fix: Trends + Logs read daily_metrics (v0.2.2)" \
  --body "$(cat <<'EOF'
Trends and Logs read the stale `events` table while the HealthKit sync writes to `daily_metrics`, so Trends charts were empty and synced workouts never appeared.

- **Trends** (`/api/trends`): rewritten to read `daily_metrics` via `queryMetricPoints()`; maps `hrv→hrv_sdnn`, `sleep→sleep_minutes` (→hours), `weight→body_mass_kg` (+ manual `weight-log.json`, manual wins), `steps→steps`. Old event-bucketing deleted.
- **Logs** (`/api/logs`): additively surfaces `daily_metrics.workouts` via `queryWorkouts()`.
- **No iOS changes** — response shapes unchanged; fix lands on backend deploy.

Spec: `docs/superpowers/specs/2026-07-07-data-unification-trends-logs-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Stop here for the user to review and merge the PR. Do NOT merge or push to `main`.

- [ ] **Step 2: After the user merges, sync main and confirm the version is free**

```bash
git checkout main && git pull --ff-only origin main && git log --oneline -5
git rev-parse v0.2.2   # MUST fail (version is free) before proceeding
```

- [ ] **Step 3: Tag and push to trigger the release workflow**

```bash
git tag -a v0.2.2 -m "v0.2.2 — Trends/Logs read daily_metrics" && git push origin v0.2.2
```

- [ ] **Step 4: Watch the release run to green**

```bash
gh run list --workflow=release.yml --limit 1
gh run watch <run-id> --exit-status --interval 30
gh run view <run-id> --json status,conclusion,jobs
```

Expected: both the backend (Fly deploy) and iOS (TestFlight) jobs are `success`.

- [ ] **Step 5: Post-deploy canary**

On the deployed backend, confirm the real user's Trends populate and a workout shows in Logs:

```bash
# Against the prod host with a valid prod session token:
for m in hrv sleep weight steps; do
  curl -s "https://vital-coach.fly.dev/api/trends?metric=$m&days=30" \
    -H "Authorization: Bearer $PROD_TOKEN" | head -c 200; echo
done
curl -s "https://vital-coach.fly.dev/api/logs?days=30" \
  -H "Authorization: Bearer $PROD_TOKEN" | head -c 400; echo
```

Expected: non-empty `points` per metric; `items` contains `workout_completed`. Then confirm visually on-device (Trends tab shows charts; Logs shows the workout). Apple takes a few minutes to process the TestFlight build.

---

## Self-Review

**Spec coverage:**
- Trends reads `daily_metrics` for all four metrics → Task 1. ✅
- Metric-name mapping + unit transforms (hrv/sleep/weight/steps) → Task 1 `DAILY_METRIC` + `transform`. ✅
- Weight merge with manual `weight-log.json`, manual wins, lbs→kg, windowed → Task 1 Step 1 weight block. ✅
- Logs surfaces `daily_metrics.workouts` → Task 2. ✅
- Response shapes unchanged / no iOS change → Global Constraints + both tasks keep shapes. ✅
- Read `daily_metrics` only, no `events` union → Task 1 rewrite drops the `events` query entirely. ✅
- Release as `v0.2.2` via tag-driven flow → Task 3. ✅
- Verification (tsc, lint, exercise, canary) → Steps in each task. ✅
- Dedup left out intentionally → matches spec non-goal. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✅

**Type consistency:** `queryMetricPoints`/`queryWorkouts`/`readWeightLog` signatures match `lib/brain/tools.ts` and `lib/weightLog.ts` as read from source. `num`/`str` reused from the existing logs route. `DAILY_METRIC` keys match `VALID_METRICS`. ✅
