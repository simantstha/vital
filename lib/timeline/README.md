# Timeline regression suite

Steps a fake "today" day by day through synthetic 14-21 week histories (lifter, weight loss, runners on and off plan) and
records what the REAL pure server functions return: goal card, coach goal lines, coach opener and the Monday weekly review.
`timelineInvariants.test.ts` locks in behaviours that persona reviews fixed. It runs with `npm test` (about 3 s, no DB, no network).

- `scenarios.ts` seeded, deterministic raw rows (weigh-ins, HealthKit workouts, logged sets, food). `SCENARIO_NAMES` lists them.
- `engine.ts` turns rows into inputs and calls the real functions. `runTimeline(name)` returns one `DaySnapshot` per day, cached per process.
- `types.ts` shared types and calendar helpers.
- `obedient.ts` (wave 23e) the DAY-BY-DAY obedient runner: every run day it steps the real morning card over the rows so far, reads the week plan and every
  daily cap and runs what that implies (`obedientDayByDay`). Circular import with `engine.ts` by design (nothing runs at module load).
- `instructions.ts` (wave 23e) ONE reading of "what should I run for the rest of this week?" over everything the app says on a day (card headline / plan line /
  reasons, coach target and long-run lines, opener): `extractInstructions`. The obedient runner and the G3 invariant share it, so they cannot drift apart.

**Scenarios:** `lifter` (+ `lifter_imperial`: lb copy and the 5 lb step; `lifter_short_week`: one bad week where the week alone, not a
lapse, must hold "Progressing" back; `lifter_obedient`: lifts exactly the loads the reviews prescribe, one ill week), `weight_loss` (+ `_logged`: plateau, a 12-day gap, trims; `_obedient`: reads the real card every day and does exactly what it says - eats the stated kcal, adds the walks when they are due (the plateau's conditional walks only if it persists 2 weeks), logs when asked, takes the maintenance step and holds it; built once per process, it runs the card ~110 times), `runner_on_plan` (+ `_half`, `_imperial`),
`runner_messy` (spike, illness = light week, ignored taper), `runner_no_race`, `runner_on_plan_obedient` (does exactly what the app says, DAY BY DAY since wave 23e: the cutback weeks, every daily cap, the race-eve shakeout, the taper), `runner_comeback_spike` (an illness, then a comeback week that overshoots its ceiling: 15 km, then 29 km) and `runner_comeback_obedient` (wave 23e: day-by-day obedient, 8 ill days, then every comeback ceiling followed exactly) and `runner_skip_then_obedient` (wave 24e: on_plan, but the week-6 cutback is run as a normal 25 km week; from week 7 it obeys the app day by day, the hold that follows included).

**The endurance guards (wave 23e G1-G3, wave 24e G4; the blocks at the END of `timelineInvariants.test.ts`):** endurance sat at 3/5 for two rounds because every wave's new rule collided
with an older one on the same card. Four generic guards stop that.
- **G1** the obedient runners really follow the app: each finished week is within 6% of the Monday plan and nothing is run on a "rest" day.
- **G2** a runner who does exactly what the app says is never criticised, flagged, rated below good or told two things that cannot both be followed - checked on
  the end-of-day snapshots AND on the MORNING state of every run day (the card as it reads before the run: `stepDay` over the rows of the days before).
- **G3** on any day of ANY runner scenario the instructions about the rest of the week (plan line, reasons, headline, coach target / long-run line, opener) agree:
  the remaining km they imply agree within 10% (+0.5 km) and done + the unrun long run never exceeds the week target x 1.10.
- **G4** (wave 24e, every runner scenario) a runner whose ACTUAL rows after a day comply with the rest-of-week instruction that day gave ("keep Sunday's long run to ~6 km", "N km left", "this week's km are done", "long run N") is never criticised for that week: neither the Sunday card nor the Monday review says "above / over / short / close to ... aim for", carries a slip, an amber Volume or a rating below good. (Exempt: a week already over its number before the instruction, a week with an illness in it, a week whose number moved after the instruction.)
When a new endurance rule fails G2/G3/G4, fix the rule (or reconcile it with the one it collides with) - do not weaken the guard.

**Add a scenario:** write a builder returning a `Scenario` (rows only, never inputs) in `scenarios.ts`, add its name to `SCENARIO_NAMES`
and a case to `buildScenario`, then add it to the scenario groups in the test file (`ALL` picks it up automatically).

**Add an invariant:** in `timelineInvariants.test.ts` write a `find(snaps)` that returns `{ snap, detail }` violations (quote the offending
string) and register it with `invariant([scenarios], 'title', find)`: one `test` per scenario. Run it against the current code first.

**Keep `engine.ts` in step with the loaders.** `computeProgressFor` and `computeReviewFor` mirror `lib/goalProgressLoader.ts`,
`lib/weeklyReviewLoader.ts`, `lib/racePeakLoader.ts` and `lib/runHistoryLoader.ts` line by line. When a loader's row -> input mapping
changes, change the matching block here, or the suite tests inputs production no longer builds. Wave 21 added three such blocks:
`intakeHistoryDays` (weight loss reads 70 days of intake), the review's SECOND goal-progress read for weight loss (the coming week's
plan becomes `weightPlan`, the review's "Next week" and verdict) and `liftReturns` (every lift's return) in the review input. Wave 23s added a fourth: the review's `progression` and `strengthDays` are read to the review's own Monday (the loader reads sets relative to the real clock), so a session logged that Monday is visible; the review cuts its lift data at the reviewed week.
Not simulated: single UTC timezone, no sleep/HRV/resting HR, static diet budget, no model sentence after the opener, no 2-minute
goal-progress cache, and the coach's weight-trend section (`formatWeightSignalsSection`, covered by its own unit tests).

**Dump a timeline for a persona review:** `npx tsx scripts/timeline-dump.ts <out-dir> [scenario ...]` writes `<out-dir>/<scenario>.md`
(one block per day, identical days collapsed, the Monday review under it; non-breaking spaces shown as plain spaces).
