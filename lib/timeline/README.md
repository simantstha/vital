# Timeline regression suite

Steps a fake "today" day by day through synthetic 14-21 week histories (lifter, weight loss, runners on and off plan) and
records what the REAL pure server functions return: goal card, coach goal lines, coach opener and the Monday weekly review.
`timelineInvariants.test.ts` locks in behaviours that persona reviews fixed. It runs with `npm test` (about 3 s, no DB, no network).

- `scenarios.ts` seeded, deterministic raw rows (weigh-ins, HealthKit workouts, logged sets, food). `SCENARIO_NAMES` lists them.
- `engine.ts` turns rows into inputs and calls the real functions. `runTimeline(name)` returns one `DaySnapshot` per day, cached per process.
- `types.ts` shared types and calendar helpers.

**Scenarios:** `lifter` (+ `lifter_imperial`: lb copy and the 5 lb step; `lifter_short_week`: one bad week where the week alone, not a
lapse, must hold "Progressing" back), `weight_loss` (+ `_logged`: plateau, a 12-day gap, trims), `runner_on_plan` (+ `_half`, `_imperial`),
`runner_messy` (spike, illness = light week, ignored taper) and `runner_no_race`.

**Add a scenario:** write a builder returning a `Scenario` (rows only, never inputs) in `scenarios.ts`, add its name to `SCENARIO_NAMES`
and a case to `buildScenario`, then add it to the scenario groups in the test file (`ALL` picks it up automatically).

**Add an invariant:** in `timelineInvariants.test.ts` write a `find(snaps)` that returns `{ snap, detail }` violations (quote the offending
string) and register it with `invariant([scenarios], 'title', find)`: one `test` per scenario. Run it against the current code first.

**Keep `engine.ts` in step with the loaders.** `computeProgressFor` and `computeReviewFor` mirror `lib/goalProgressLoader.ts`,
`lib/weeklyReviewLoader.ts`, `lib/racePeakLoader.ts` and `lib/runHistoryLoader.ts` line by line. When a loader's row -> input mapping
changes, change the matching block here, or the suite tests inputs production no longer builds. Wave 21 added three such blocks:
`intakeHistoryDays` (weight loss reads 70 days of intake), the review's SECOND goal-progress read for weight loss (the coming week's
plan becomes `weightPlan`, the review's "Next week" and verdict) and `liftReturns` (every lift's return) in the review input.
Not simulated: single UTC timezone, no sleep/HRV/resting HR, static diet budget, no model sentence after the opener, no 2-minute
goal-progress cache, and the coach's weight-trend section (`formatWeightSignalsSection`, covered by its own unit tests).

**Dump a timeline for a persona review:** `npx tsx scripts/timeline-dump.ts <out-dir> [scenario ...]` writes `<out-dir>/<scenario>.md`
(one block per day, identical days collapsed, the Monday review under it; non-breaking spaces shown as plain spaces).
