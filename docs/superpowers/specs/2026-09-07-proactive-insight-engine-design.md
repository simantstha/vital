# Proactive Insight Engine — Design

**Date:** 2026-09-07
**Status:** Approved for planning
**Scope:** Subsystem A of the proactive-coach arc (absence & pattern triggers)

## Problem

Every notification Vital sends today fires for one of two reasons:

1. **An event landed.** A workout or sleep record arrives at `/api/ingest/daily`,
   a row is written to `workout_analyses` / `sleep_analyses`, the worker
   generates an analysis, APNs delivers it.
2. **A clock hit a time.** The morning brief at a configured local minute; four
   fixed meal-reminder slots.

There is no trigger for **absence** and no trigger for **change**. Nothing in the
system can speak because the user *didn't* train, or because their sessions have
been quietly getting shorter for three weeks. The coach only ever reacts to
things that happened, on a schedule someone else set.

That is the whole distance between what Vital is and a coach who checks in.

Two artifacts in the repo mark previous attempts at this ground:

- **`pending_nudges`** — table, index, and Drizzle types all exist. Its own
  comment reads "nudges scheduled by the proactive heuristics cron (steps drop,
  HRV trend, etc.)". **Zero lines of code reference it.** The socket was left and
  never wired.
- **`daily_coach_recommendations`** — explicitly marked `ORPHANED`; the "Coach
  Workspace" feature was built and removed. We are re-entering territory the
  project retreated from once, which is a reason for care, not avoidance.

## Goals

- Detect and speak about **absence** (an established cadence broke) and **change**
  (a metric shifted, trended, or moved with another metric).
- Discovery must be **open-ended** — findings neither the author nor the user
  thought to enumerate in advance.
- A nudge must open a **conversation**, not a dead end.
- The engine must be **structurally incapable of fabricating a pattern**.

## Non-goals

Deliberately out of scope for this cycle:

- **Load-aware daily fueling** (subsystem C) — making today's macro targets
  respond to yesterday's training. `computeAutoBudget` currently derives a single
  activity multiplier from a trailing 7-day window, so every day of the week gets
  identical targets. Real gap; separate cycle.
- **Preference-grounded food suggestions** (subsystem D).
- **Parsing the user's reply into the ontology** (subsystem B). The tap opens a
  real conversation; persisting what the user says back as a fact is next cycle.
- **Model-authored analysis code.** A sandboxed tool the coach can call to run an
  ad-hoc computation is a plausible later escape hatch. The generic battery below
  covers nearly the whole time-series space deterministically and cacheably;
  revisit only once the battery demonstrates a question it cannot answer.

## The central risk

The naive reading of "let Vital look at all the data and find meaning" is to hand
a model the time series and ask it to find patterns. This fails predictably.

The catalog holds 23 metrics, which is 253 unordered pairs. At a conventional
significance threshold roughly **13 of them will appear significant by chance
alone**, before any real effect exists. A language model shown that data reports
them fluently and with total confidence, and neither the user nor the developer
can separate them from real findings.

This is not hypothetical here. `lib/proactiveAnalysisGrounding.ts` exists as an
entire subsystem, and the Week-1 integrity sweep happened, because Vital
confidently stated things that were not true. A pattern engine is the
highest-leverage place to reintroduce that failure and the worst place to host
it: a coach that invents patterns about someone's body is worse than no coach.

The design therefore separates **detection** from **interpretation**.

## Architecture

### Layer 1 — detection (deterministic, no LLM)

New modules under `lib/insights/`. None of them import the Anthropic client.

The substrate already exists: `daily_metrics` is `(user_id, date, metric, value,
payload, source)` — generic long format, one row per metric per day — and
`METRIC_CATALOG` is a registry of metric specs. The battery runs over *every*
catalog metric rather than a hand-written list of detectors, so a newly ingested
metric is analyzed for free with no new code.

#### `lib/insights/series.ts`

Loads each metric's series for a user over a rolling window.

**Gaps stay gaps.** A missing day is never zero-filled. Absence is not a measured
zero — this is the direct lesson from the HealthKit denial work, where an
unreadable permission was indistinguishable from a real zero and the app rendered
fabricated data as a result. Every downstream detector receives explicit
`present` / `absent` days and must handle them.

#### `lib/insights/detectors.ts`

Pure functions, no I/O. Each takes series and returns `Finding[]`, where a
`Finding` carries its kind, the metrics involved, the effect size, the sample
size, and (for hypothesis-shaped detectors) an uncorrected p-value.

| Detector | Question | Proposed defaults |
|---|---|---|
| `cadenceBreak` | Did an established rhythm break? | Cadence established from a trailing 28 days at ≥3 occurrences/week. Fires when days-since-last ≥ `max(3, 2 × ceil(7 / weekly_rate))`. |
| `levelShift` | Has the recent level moved off baseline? | Last 7 days' mean vs. preceding 28-day baseline, in that user's own SD units. Requires ≥7 recent and ≥21 prior observed days, and \|d\| ≥ 0.8. |
| `trend` | Is it sliding in one direction? | OLS slope over 28 days with a t-test on the slope; requires ≥20 observed days. |
| `crossLag` | Does something the user *did* affect how their body *responded*? | Spearman ρ between an **input** metric on day *d* and an **outcome** metric on day *d+k*, k ∈ {0,1}. Requires ≥30 paired observations and \|ρ\| ≥ 0.35. |
| `dayOfWeek` | Is there a recurring weekday effect? | Kruskal–Wallis across weekdays; requires ≥8 weeks of coverage. |

Spearman rather than Pearson for `crossLag`: health series are non-normal and
outlier-prone, and rank correlation degrades gracefully where Pearson does not.

#### Why `crossLag` is directional, not a blind sweep

`crossLag` is the source of genuinely emergent findings — it surfaces
relationships nobody enumerated in advance. It is also, by a wide margin, the
largest contributor to the multiple-comparisons problem.

An unrestricted sweep over all 23 catalog metrics is **not viable**, and the
reason is power rather than correctness. Counting ordered pairs across lags
{0,1,2} gives ≈1,265 hypotheses per run. Benjamini–Hochberg would control the
false-discovery rate over that family perfectly well — but against ~90 days of
data the corrected threshold becomes so strict that essentially no real effect
ever clears it. The engine would be statistically impeccable and permanently
silent: all of the safety, none of the discovery.

The sweep is therefore **directional**, over the pairs a coach would actually
ask about:

- **Inputs** (what the user did): `whoop_day_strain`, `steps`, `exercise_min`,
  `distance_m`, `active_energy_kcal`, `dietary_energy_kcal`,
  `dietary_protein_g`, `dietary_carbs_g`, `dietary_fat_g`
- **Outcomes** (how the body responded): `hrv_sdnn`, `whoop_hrv_rmssd`,
  `resting_hr`, `whoop_resting_hr`, `whoop_recovery`, `sleep_minutes`,
  `whoop_sleep_min`, `whoop_spo2`, `whoop_skin_temp`

Inputs → outcomes at lags {0,1} is **≈150 hypotheses instead of ≈1,265** — on
the order of 8× more power to detect a real effect — while remaining open-ended
within the space where a causal story is even plausible. It also stops the
correction being spent on pairs with no coaching meaning, such as `flights`
against `body_mass_kg`.

This is a deliberate trade of unbounded openness for the statistical power to
ever say anything. Both metric lists live in one exported constant so the
boundary is reviewable and extendable in one place.

#### `lib/insights/evidence.ts`

The gate. **It is deliberately not one-size-fits-all**, because the detectors are
not all the same kind of claim.

- **Hypothesis-shaped detectors** (`levelShift`, `trend`, `crossLag`,
  `dayOfWeek`) are corrected as a **single family per run** via
  Benjamini–Hochberg at q = 0.10. This is what prevents the directional sweep
  from leaking its expected crop of noise findings.
- **A minimum effect size is required independently of significance.** With
  enough observations a trivially small correlation becomes "significant"; a
  finding must be both unlikely-by-chance *and* large enough to matter. Both
  gates, not either.
- **`cadenceBreak` is not a hypothesis test.** It is a deterministic rule about a
  known rhythm and takes a threshold, not a p-value. Forcing it through FDR would
  be statistical theater.
- **Unestablished baselines are skipped, not defaulted.** Any metric whose
  `baselines` row is not `established` is excluded entirely. Reuses the existing
  `getCalibration` gate rather than inventing a second notion of readiness.
- **Cross-run confirmation.** The pass runs daily, which is itself repeated
  testing: a borderline finding will eventually surface by chance given enough
  days. A finding must therefore **persist across two consecutive daily runs**
  before it becomes eligible to speak.

  ⚠️ **Measured, and weaker than this design originally claimed.** The original
  justification — "noise rarely repeats, real effects persist" — assumed the two
  runs are near-independent tests. They are not: consecutive runs over a 90-day
  rolling window share **89 of 90 days** of data. Measured over 200 synthetic
  pure-noise users through the real gate:

  | null | certified on day N | still confirmed across two runs |
  |---|---|---|
  | i.i.d. | 22/200 | 16/200 |
  | AR(1) φ=0.3 | 18/200 | 11/200 |
  | AR(1) φ=0.5 | 9/200 | 8/200 |

  Confirmation removes roughly 25–40% of false positives, not the order of
  magnitude assumed. At φ≈0.3 — where real daily HRV, resting heart rate, and
  sleep sit — about **5.5% of pure-noise users get a confirmed finding every
  day**. The delivery caps then throttle the *rate*, not the *falsity*: a user
  whose data is pure noise would receive roughly one unfounded nudge a
  fortnight, indefinitely.

  This does not invalidate the layered design, but it does mean confirmation is
  a modest filter rather than a second independent gate. Closing the gap needs
  either a genuinely independent second test (a held-out window rather than a
  shifted one) or an acceptance that the residual rate is what the dry-run must
  measure on real data. **Resolve before going live.**

Findings that fail any gate are **dropped, not downgraded**. There is no
"low-confidence finding" tier — a tier like that inevitably gets spoken aloud.

#### `lib/insights/arbiter.ts`

Reduces surviving findings to a **deterministic shortlist of at most three**,
ranked by effect size, novelty (not raised recently), and relevance to the user's
stated goal.

Selection stays in code and stays auditable. The model's judgment is applied
downstream, to a set that has already been certified.

### Layer 2 — voice (LLM)

Receives the shortlist of certified findings, the user's goal, their active
ontology facts (`nodes.status = 'active'`), and a summary of what the coach said
recently. It picks one and writes it.

**It never sees a raw series, and it is never asked to find anything.** Its input
is a small set of established facts about the user; its job is choosing which one
matters today and saying it like someone who knows them.

This is the inversion that makes the feature safe: the model's fluency is spent
on *expression*, where it excels, and withheld from *inference*, where it
confabulates.

## Data flow

```
daily per-user pass (local time, from notification_preferences)
  └→ series.ts        load metric series (gaps preserved)
  └→ detectors.ts     generic battery over METRIC_CATALOG → candidate findings
  └→ evidence.ts      per-detector gates + BH-FDR + cross-run confirmation
  └→ arbiter.ts       deterministic shortlist (≤3)
  └→ LLM              select one, write it
  └→ pending_nudges   insert (type, payload, scheduled_for)
  └→ delivery pass    caps + quiet hours + existing freshness gate → APNs
  └→ tap              coach chat, pre-seeded
```

Scheduling is per-user local time driven by existing `notification_preferences`,
not a global UTC cron, reusing the local-time helpers already proven by the
morning brief (`localParts` / `shouldRunMorningBrief` in
`lib/proactiveHealthWorker.ts`, `localDayKey` in `lib/localDay.ts`).

Delivery reuses the APNs path, freshness gate, and device-retirement logic in
`proactiveHealthWorker.ts`. It does not grow a second push stack.

## Delivery caps

- **One nudge per day maximum.**
- **Three per week maximum.**
- **14-day cooldown per finding kind.**
- Existing `notification_preferences` and quiet hours are respected.

A coach who notices everything out loud is a nag. These caps are also the second
line of defence against residual false positives: even a finding that slips every
statistical gate can only be said once a fortnight.

## Tap destination

Push → **coach chat**, opened with the coach's question already present as the
opening assistant message, and the finding ID passed to `/api/coach` so context
assembly can load it and discuss it.

This is a deliberate correction of a known failure: PR #120 shipped a proactive
morning-brief notification whose tap opened a no-op sheet. A nudge that asks
"you haven't trained in three days — what happened?" and then refuses to listen
is worse than sending nothing.

Requires modest iOS work; reuses the existing chat wholesale.

## Error handling

**The governing rule: silence is a valid output.** Most failure modes here should
produce no notification at all.

| Condition | Behavior |
|---|---|
| Insufficient data / no established baselines | No nudge. Specifically **no** "we don't have enough data yet" push. |
| A metric's baseline is not established | That metric is skipped; other metrics still run. |
| No finding survives the gates | No nudge. The expected outcome on most days. |
| LLM call fails, or output is ungrounded | **No nudge at all.** |
| Delivery fails transiently | Existing retry/backoff path in the proactive worker. |

The ungrounded-output case diverges deliberately from the workout-analysis path,
which falls back to static copy (`fallbackAnalysis`). That fallback is correct
*there*: a workout genuinely happened and deserves a record even if the prose
failed. Here, nothing happened. There is no event owed a receipt, so the correct
output is nothing.

## Testing

**The null-data canary is the most important test in this feature.** Run the full
battery against pure random walks for a batch of synthetic users and assert the
false-positive rate holds under the FDR target. It is the test that keeps "smart"
from decaying into "confidently wrong," and it should fail loudly if anyone later
loosens a threshold.

Alongside it:

- **Detectors** (pure, so directly property-testable):
  - A flat noisy series yields **zero** findings.
  - A planted step change is found, at roughly the planted magnitude.
  - A planted linear trend is found.
  - A planted cross-metric relationship is found at the planted lag.
  - Series with gaps are never zero-filled; gap handling is asserted explicitly.
- **Evidence gate:** BH-FDR correctness against known p-value vectors; effect-size
  floor rejects large-n/small-effect findings; cross-run confirmation suppresses a
  finding seen only once.
- **Arbiter:** deterministic ranking; cooldown and novelty suppression.
- **Worker:** idempotency, lease handling, and cap enforcement, mirroring the
  existing proactive worker suite.

## Schema

`pending_nudges` fits nearly as-is (`type`, `payload`, `scheduled_for`,
`sent_at`). Per-finding-kind cooldown queries want an indexed column rather than a
JSONB probe, so the table gains a `finding_kind` column plus an index.

This is an **additive** change, shipped as a generated migration file
(`npx drizzle-kit generate`, committed under `db/migrations/`). Never
`drizzle-kit push`. Old code must tolerate the new column during the deploy
window — it will, since nothing reads the table today.

## Rollout

The engine is off by default behind an env flag, enabling a dry-run period where
findings are computed and logged but nothing is delivered. That log is the real
acceptance test: read a week of what it *would* have said before letting it say
anything.
