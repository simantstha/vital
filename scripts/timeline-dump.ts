/**
 * Dumps the day-by-day timelines (lib/timeline/) as Markdown, for persona reviews.
 *
 *   npx tsx scripts/timeline-dump.ts <out-dir> [scenario ...]    # all scenarios when none is named
 *
 * Writes <out-dir>/<scenario>.md. One block per day (goal-progress card, reasons, structured fields, coach goal
 * lines, opener) plus the Monday weekly review; consecutive days with identical output collapse into a
 * "same as above" note. Non-breaking spaces show as plain spaces. Read-only: no database, network or LLM.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoalProgress } from '../lib/goalProgress';
import { runTimeline } from '../lib/timeline/engine';
import { SCENARIO_NAMES, buildScenario, type ScenarioName } from '../lib/timeline/scenarios';
import { addDays, weekdayOf, type DaySnapshot, type Scenario } from '../lib/timeline/types';

const nb = (s: string | null | undefined): string => (s ?? '').replace(/ /g, ' ');

function fields(gp: GoalProgress): string[] {
  const out: string[] = [];
  if (gp.distance) {
    const d = gp.distance;
    out.push(`distance: targetKm ${d.targetKm} · thisWeekKm ${d.thisWeekKm} · avg4wKm ${d.avg4wKm} · stepTargetKm ${d.stepTargetKm} · weekStart ${d.weekStart}`);
    out.push(`distance.text: "${nb(d.text)}"`);
  }
  if (gp.race) {
    const r = gp.race;
    out.push(`race: label "${r.label}" · date ${r.date} · distanceKm ${r.distanceKm} · weeksToGo ${r.weeksToGo} · daysToGo ${r.daysToGo} · phase ${r.phase}${r.daysSince != null ? ` · daysSince ${r.daysSince}` : ''}`);
  } else if (gp.goal === 'endurance') {
    out.push('race: null');
  }
  if (gp.longRun) out.push(`longRun: lastKm ${gp.longRun.lastKm} · peakKm ${gp.longRun.peakKm} · targetPeakKm ${gp.longRun.targetPeakKm}`);
  else if (gp.goal === 'endurance') out.push('longRun: null');
  if (gp.goal === 'weight_loss' || gp.goal === 'muscle') {
    const c = gp.current;
    out.push(`weight: trendKg ${c.weightKg} · startKg ${c.startWeightKg} · changeKg ${c.changeKg} · progressPct ${c.progressPct} · rate ${gp.ratePerWeek.kg} kg/wk (${gp.ratePerWeek.pctBodyweight}%/wk) · eta ${gp.eta} · onPaceForTargetDate ${gp.onPaceForTargetDate} · reachedAt ${gp.reachedAt ?? null}`);
  }
  if (gp.adherence) {
    const a = gp.adherence;
    out.push(`adherence: ${a.done}/${a.planned} (${a.pct}%) over ${a.windowDays} d, weeklyTarget ${a.weeklyTarget}`);
  }
  out.push(`misc: lastWeighInDaysAgo ${gp.lastWeighInDaysAgo ?? null} · lastSessionDaysAgo ${gp.lastSessionDaysAgo ?? null} · dataSufficiency ${JSON.stringify(gp.dataSufficiency)} · target ${JSON.stringify(gp.target)}`);
  return out;
}

/** Everything user-visible (and the structured fields that drive it) except counters that tick daily. */
function signature(rec: DaySnapshot): string {
  if (rec.errors.length) return `ERR:${rec.errors.join('|')}`;
  const gp = rec.card as GoalProgress;
  const race = gp.race ? { ...gp.race, daysToGo: undefined, daysSince: undefined } : null;
  return JSON.stringify({
    v: gp.verdict, h: gp.headline, r: gp.reasons, d: gp.distance, race, lr: gp.longRun, cur: gp.current, rate: gp.ratePerWeek,
    eta: gp.eta, pace: gp.onPaceForTargetDate, reached: gp.reachedAt, adh: gp.adherence,
    coach: rec.coach, op: rec.opener,
  });
}

function renderReview(rec: DaySnapshot): string[] {
  const rv = rec.review;
  if (!rv) return [];
  const r = rv.review;
  const L: string[] = ['', `**Weekly review — week ${r.weekStart} → ${r.weekEnd}** (job runs Mon ${rv.runDay}; verdict evaluated as of ${rv.verdictAsOf}${rv.racePeakWeekKm != null ? `; racePeakWeekKm passed = ${rv.racePeakWeekKm}` : ''})`, ''];
  L.push(`- rating: \`${r.weekRating}\` · verdict (from goal progress): \`${r.verdict}\` · sufficient: ${r.dataSufficiency.sufficient} (daysWithData ${r.dataSufficiency.daysWithData}, statCount ${r.dataSufficiency.statCount})`);
  L.push(`- weekGap: \`${JSON.stringify(r.weekGap)}\``);
  L.push(`- headline: "${nb(r.headline)}"`);
  if (r.stats.length === 0) L.push('- stats: (none)');
  else {
    L.push('- stats:');
    for (const s of r.stats) L.push(`  - ${nb(s.label)}: **${nb(s.value)}** — ${nb(s.comparison)} [${s.tone}]`);
  }
  L.push(`- win: ${r.win == null ? '(none)' : `"${nb(r.win)}"`}`);
  L.push(`- slip: ${r.slip == null ? '(none)' : `"${nb(r.slip)}"`}`);
  L.push(`- next week: "${nb(r.nextWeek)}"`);
  L.push(r.dataSufficiency.sufficient
    ? `- push notification: title "${nb(rv.alert.title)}" / body "${nb(rv.alert.body)}"`
    : '- push notification: none (insufficient data → claimed but not sent)');
  return L;
}

function renderBlock(rec: DaySnapshot): string[] {
  const race = rec.race ? ` · ${rec.race.daysToRace >= 0 ? `${rec.race.daysToRace} days to race` : `${-rec.race.daysToRace} days after race`} · phase ${rec.race.phase}` : '';
  const L: string[] = [`### Day ${rec.idx} · ${rec.weekday} ${rec.date}${race}`, '', `Logged today: ${rec.activity}`];
  if (rec.errors.length) {
    L.push('');
    for (const e of rec.errors) L.push(`> **EXCEPTION** ${e}`);
  }
  const gp = rec.card;
  if (gp) {
    L.push('', `**Goal progress** — verdict \`${gp.verdict}\` — "${nb(gp.headline)}"`, '');
    if (gp.reasons.length === 0) L.push('- (no reasons)');
    for (const r of gp.reasons) L.push(`- [${r.kind} / ${r.tone}] ${nb(r.text)}`);
    for (const f of fields(gp)) L.push(`- ${f}`);
    if (rec.coach) L.push('', '**Coach goal lines** (formatGoalProgressLines)', '', '```text', ...rec.coach, '```');
    if (rec.opener) {
      const { required, fallback } = rec.opener;
      L.push('', required === fallback
        ? `**Opener** (required first sentence = fallback): ${required == null ? '(none)' : `"${nb(required)}"`}`
        : `**Opener** required first sentence: ${required == null ? '(none)' : `"${nb(required)}"`} · fallback if the model fails: ${fallback == null ? '(none)' : `"${nb(fallback)}"`}`);
    }
  }
  L.push(...renderReview(rec));
  return L;
}

function collapsedNote(run: DaySnapshot[]): string {
  const a = run[0], b = run[run.length - 1];
  const range = run.length === 1 ? `Day ${a.idx} (${a.weekday} ${a.date})` : `Days ${a.idx}–${b.idx} (${a.weekday} ${a.date} – ${b.weekday} ${b.date})`;
  const race = a.race && b.race
    ? (run.length === 1 ? ` race daysToGo ${a.race.daysToRace}.` : ` race daysToGo ${a.race.daysToRace}→${b.race.daysToRace}.`)
    : '';
  return `> ${range}: same as above.${race} Logged: ${run.map(r => `d${r.idx} ${r.activity}`).join('; ')}`;
}

/** Weekly table of the SYNTHETIC INPUT (not app output). */
function weeklyInputTable(scn: Scenario): string[] {
  const L = ['| Week | Dates | What the synthetic user logged |', '|---|---|---|'];
  const nWeeks = Math.ceil(scn.lastDay / 7);
  for (let w = 0; w < nWeeks; w++) {
    const from = addDays(scn.day0, w * 7), to = addDays(from, 6);
    const inW = (d: string): boolean => d >= from && d <= to;
    const bits: string[] = [];
    const runs = scn.workouts.filter(x => inW(x.day) && x.type === 'Running' && x.distanceM != null);
    if (scn.workouts.some(x => x.type === 'Running')) {
      const km = runs.reduce((s, x) => s + (x.distanceM as number) / 1000, 0);
      const longest = runs.reduce((m, x) => Math.max(m, (x.distanceM as number) / 1000), 0);
      bits.push(runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'}, ${(Math.round(km * 10) / 10).toFixed(1)} km, longest ${longest.toFixed(1)} km (${runs.map(x => ((x.distanceM as number) / 1000).toFixed(1)).join('/')})` : 'no runs');
    }
    const other = scn.workouts.filter(x => inW(x.day) && x.type !== 'Running');
    if (other.length) bits.push(`${other.length} workout${other.length === 1 ? '' : 's'} (${other[0].type})`);
    const wi = scn.weighIns.filter(x => inW(x.day));
    if (scn.weighIns.length) bits.push(wi.length ? `${wi.length} weigh-ins, mean ${(wi.reduce((s, x) => s + x.kg, 0) / wi.length).toFixed(1)} kg [${wi.map(x => x.kg.toFixed(1)).join(', ')}]` : 'no weigh-ins');
    const sets = scn.sets.filter(x => inW(x.day) && !x.isWarmup);
    if (scn.sets.length) {
      const sessionDays = new Set(sets.map(x => x.day)).size;
      const tops = ['squat', 'bench press', 'deadlift'].map(ex => {
        const l = sets.filter(x => x.exercise === ex).map(x => x.loadKg ?? 0);
        return l.length ? `${ex} ${Math.max(...l)}` : null;
      }).filter(Boolean);
      bits.push(sessionDays ? `${sessionDays} session days; top loads: ${tops.join(', ')}` : 'no sessions');
    }
    const fi = scn.intake.filter(x => inW(x.day));
    if (scn.intake.length) bits.push(fi.length ? `food on ${fi.length} days, avg ${Math.round(fi.reduce((s, x) => s + x.kcal, 0) / fi.length)} kcal` : 'no food logged');
    L.push(`| ${w + 1} | ${from} → ${to} | ${bits.join(' · ') || '—'} |`);
  }
  return L;
}

function renderScenario(name: ScenarioName): string {
  const scn = buildScenario(name);
  const records = runTimeline(name);
  const L: string[] = [
    `# ${scn.name} — ${scn.title}`,
    '',
    'Generated by scripts/timeline-dump.ts (see lib/timeline/README.md). Output below is the REAL server logic run on synthetic in-memory rows; "Logged today" lines are the synthetic input, not app output.',
    '',
    `- Profile: ${scn.profile.sex}, ${scn.profile.age} y, ${scn.profile.heightCm} cm, ${scn.profile.startWeightKg} kg at start, units ${scn.profile.units}, timezone UTC.`,
    `- Calendar: day 0 = ${weekdayOf(scn.day0)} ${scn.day0}; stepped through day ${scn.lastDay} (${weekdayOf(addDays(scn.day0, scn.lastDay))} ${addDays(scn.day0, scn.lastDay)}).${scn.user.raceDate ? ` Race day = ${weekdayOf(scn.user.raceDate)} ${scn.user.raceDate}.` : ''}`,
    `- User row: ${JSON.stringify(scn.user)}`,
    `- Budget approximation: ${JSON.stringify(scn.budget)}; sex-aware floor ${scn.profile.sex === 'male' ? 1500 : 1200} kcal.`,
    '- State shown for each day = END of that day (everything logged that day is visible). Weekly reviews are computed on Mondays for the week just ended, with data through that Sunday.',
    '- Consecutive days whose output is identical are collapsed into a "same as above" note. Non-breaking spaces (U+00A0) in app text are shown as plain spaces here.',
    '',
    '## Input history',
    ...scn.inputNotes.map(n => `- ${n}`),
    '',
    ...weeklyInputTable(scn),
    '',
    '## Day by day',
    '',
  ];
  let current: DaySnapshot | null = null;
  let sameRun: DaySnapshot[] = [];
  const flush = (): void => {
    if (sameRun.length) { L.push(collapsedNote(sameRun), ''); sameRun = []; }
  };
  for (const rec of records) {
    const canCollapse = current != null && rec.review == null && signature(rec) === signature(current)
      && rec.idx === (sameRun.length ? sameRun[sameRun.length - 1].idx : current.idx) + 1;
    if (canCollapse) { sameRun.push(rec); continue; }
    flush();
    L.push(...renderBlock(rec), '');
    current = rec;
  }
  flush();
  return L.join('\n') + '\n';
}

const [outDir, ...wanted] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: npx tsx scripts/timeline-dump.ts <out-dir> [scenario ...]');
  process.exit(1);
}
const names = wanted.length ? wanted : [...SCENARIO_NAMES];
const unknown = names.filter(n => !(SCENARIO_NAMES as readonly string[]).includes(n));
if (unknown.length) {
  console.error(`unknown scenario(s): ${unknown.join(', ')}. Known: ${SCENARIO_NAMES.join(', ')}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const name of names as ScenarioName[]) {
  const file = join(outDir, `${name}.md`);
  writeFileSync(file, renderScenario(name));
  console.log(`${name}: ${runTimeline(name).length} days -> ${file}`);
}
