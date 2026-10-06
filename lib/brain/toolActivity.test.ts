import assert from 'node:assert/strict';
import test from 'node:test';

// toolActivity.ts is a pure leaf (lib/brain/toolLabels.ts, lib/metricFormat.ts,
// lib/metricCatalog.ts only) — no DATABASE_URL/`@/db` dependency at all.
const activityPromise = import('./toolActivity');

// ── toolKind — every tool named in the contract's kind lists ────────────────

test('toolKind maps every tool named in the chat-activity contract', async () => {
  const { toolKind } = await activityPromise;

  const memory = [
    'read_memory', 'write_memory', 'append_observation',
    'query_ontology', 'read_entity',
    'remember_fact', 'propose_fact', 'confirm_fact', 'resolve_fact',
  ];
  const action = ['log_meal', 'delete_meal', 'log_weight', 'set_goal_target', 'log_workout', 'update_diet_budget'];
  const calendar = ['get_schedule'];
  const data = [
    'get_metric_trend', 'get_weight_trend', 'get_sleep_summary', 'get_workouts',
    'get_baseline', 'compare_periods', 'query_events', 'get_training_history',
    'calculate_macros',
  ];

  for (const name of memory) assert.equal(toolKind(name), 'memory', name);
  for (const name of action) assert.equal(toolKind(name), 'action', name);
  for (const name of calendar) assert.equal(toolKind(name), 'calendar', name);
  for (const name of data) assert.equal(toolKind(name), 'data', name);

  // Anything else — e.g. specialist handoff pseudo-tools — falls to 'other'.
  assert.equal(toolKind('propose_specialist_handoff'), 'other');
  assert.equal(toolKind('propose_return_to_vital'), 'other');
  assert.equal(toolKind('something_unknown'), 'other');
});

// ── isToolResultOk ───────────────────────────────────────────────────────────

test('isToolResultOk is false for the "Error" prefix, and for a JSON object reporting ok:false', async () => {
  const { isToolResultOk } = await activityPromise;
  assert.equal(isToolResultOk('Error: the tool failed'), false);
  assert.equal(isToolResultOk('{"ok":true}'), true);
  assert.equal(isToolResultOk('{"ok":false,"reason":"no match"}'), false);
  // Not a false positive on unrelated text containing "error".
  assert.equal(isToolResultOk('No errors found today.'), true);
  // A JSON array (not an object) is never treated as a failure marker.
  assert.equal(isToolResultOk('[]'), true);
  assert.equal(isToolResultOk('[{"ok":false}]'), true);
});

test('isToolResultOk: resolve_fact\'s own not-found reply ({ok:false}, no "Error" prefix) is not ok', async () => {
  const { isToolResultOk } = await activityPromise;
  const result = JSON.stringify({ ok: false, resolved: false, reason: 'No matching active fact found for label "x".' });
  assert.equal(isToolResultOk(result), false);
});

test('isToolResultOk: log_workout needing clarification ({ok:false}, no "Error" prefix) is not ok', async () => {
  const { isToolResultOk } = await activityPromise;
  const needsClarification = JSON.stringify({
    ok: false, needsClarification: true, reason: 'ambiguous',
    message: 'Did you mean bench press or incline bench press?',
    candidates: ['bench press', 'incline bench press'],
  });
  assert.equal(isToolResultOk(needsClarification), false);

  const noHistory = JSON.stringify({ ok: false, reason: 'no_history', message: 'No previous session found for "squat".' });
  assert.equal(isToolResultOk(noHistory), false);

  const noReps = JSON.stringify({ ok: false, reason: 'no_reps', message: 'Could not find a valid set (exercise + reps) to log.' });
  assert.equal(isToolResultOk(noReps), false);
});

test('isToolResultOk: confirm_fact\'s own not-found reply is now "Error"-prefixed and not ok', async () => {
  const { isToolResultOk, toolResultSummary, extractMemoryOp } = await activityPromise;
  // Mirrors executeToolCall's exact confirm_fact not-found branch.
  const result = 'Error: No pending_fact found with id 11111111-1111-4111-8111-111111111111.';
  assert.equal(isToolResultOk(result), false);
  assert.equal(toolResultSummary('confirm_fact', { factId: 'x', action: 'confirm' }, result, 'metric'), undefined);
  assert.equal(extractMemoryOp('confirm_fact', { factId: 'x', action: 'confirm' }, result), undefined);
});

// ── toolResultSummary — one honest case per family, the error case, and a
//    unit-conversion case ───────────────────────────────────────────────────

test('toolResultSummary is undefined for an Error-prefixed result, for any tool', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = toolResultSummary(
    'get_sleep_summary', {}, 'Error: the get_sleep_summary tool failed; tell the user it didn\'t work and don\'t retry.', 'metric',
  );
  assert.equal(result, undefined);
});

test('toolResultSummary: get_sleep_summary reads nights + mean minutes', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({
    days: 7,
    nights: [{ date: '2026-01-01', minutes: 300 }, { date: '2026-01-02', minutes: 420 }],
    meanMinutes: 357, sd: 60, consistency: 'variable',
  });
  const summary = toolResultSummary('get_sleep_summary', { days: 7 }, result, 'metric');
  assert.equal(summary, 'Last 2 nights · avg 5h 57m');
  assert.ok(summary!.length <= 60);
});

test('toolResultSummary: get_sleep_summary with no nights is undefined', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({ days: 7, nights: [], meanMinutes: null, sd: null, consistency: 'unknown' });
  assert.equal(toolResultSummary('get_sleep_summary', { days: 7 }, result, 'metric'), undefined);
});

test('toolResultSummary: get_metric_trend — unit-conversion case (body_mass_kg, imperial)', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({
    metric: 'body_mass_kg', days: 7,
    points: [{ date: '2026-01-01', value: 70 }, { date: '2026-01-02', value: 70.5 }],
    stats: { mean: 70.25, min: 70, max: 70.5 },
    baseline: { mean30: 68, established: true },
    direction: 'above',
  });
  const metric = toolResultSummary('get_metric_trend', { metric: 'body_mass_kg' }, result, 'metric');
  const imperial = toolResultSummary('get_metric_trend', { metric: 'body_mass_kg' }, result, 'imperial');
  assert.match(metric!, /kg/);
  assert.match(imperial!, /lb/);
  assert.notEqual(metric, imperial, 'imperial must actually convert, not just relabel');
  // 70.5 kg -> ~155 lb
  assert.match(imperial!, /155/);
});

test('toolResultSummary: get_workouts counts entries', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify([{ date: '2026-01-01', type: 'run' }, { date: '2026-01-02', type: 'lift' }]);
  assert.equal(toolResultSummary('get_workouts', { days: 7 }, result, 'metric'), '2 workouts · last 7 days');
});

test('toolResultSummary: get_baseline reports the normal range', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({
    metric: 'hrv_sdnn',
    stats: { mean7: 60, mean30: 59, mean60: 58, sd30: 5, p25: 55, p50: 59, p75: 64 },
    established: true, dataDays: 45,
  });
  assert.equal(toolResultSummary('get_baseline', { metric: 'hrv_sdnn' }, result, 'metric'), 'HRV normal 55–64 ms');
});

test('toolResultSummary: get_baseline not yet established is undefined', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({ metric: 'hrv_sdnn', stats: null, established: false, dataDays: 3 });
  assert.equal(toolResultSummary('get_baseline', { metric: 'hrv_sdnn' }, result, 'metric'), undefined);
});

test('toolResultSummary: compare_periods reports percent change', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({
    metric: 'steps', periodDays: 7, offsetDays: 7,
    current: { mean: 9000, days: 7 }, previous: { mean: 8000, days: 7 },
    delta: 1000, deltaPct: 12.5,
  });
  assert.equal(toolResultSummary('compare_periods', { periodDays: 7 }, result, 'metric'), 'Steps +13% vs prior 7d');
});

test('toolResultSummary: query_events counts rows for the requested type', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify([{ timestamp: '2026-01-01', payload: {} }]);
  const summary = toolResultSummary('query_events', { type: 'hrv_reading', rangeDays: 7 }, result, 'metric');
  assert.equal(summary, '1 HRV readings · last 7d');
});

test('toolResultSummary: get_training_history — by exercise vs summary', async () => {
  const { toolResultSummary } = await activityPromise;
  const byExercise = JSON.stringify({ exercise: 'squat', sets: [{}, {}, {}] });
  assert.equal(
    toolResultSummary('get_training_history', { exercise: 'squat' }, byExercise, 'metric'),
    '3 sets · squat',
  );
  const overall = JSON.stringify({ days: 84, exercises: [{ exercise: 'squat' }, { exercise: 'bench' }] });
  assert.equal(
    toolResultSummary('get_training_history', {}, overall, 'metric'),
    '2 exercises tracked',
  );
});

test('toolResultSummary: calculate_macros', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({
    tdee: 2200, targetCal: 1800, macros: { c: 180, p: 150, f: 60 },
    lowEnergyWarning: null, note: 'ignored, rebuilt from fields',
  });
  assert.equal(
    toolResultSummary('calculate_macros', { goal: 'weight_loss' }, result, 'metric'),
    '1800 kcal · 180C/150P/60F',
  );
});

test('toolResultSummary: log_meal', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({ ok: true, id: 'e1', matched: 'Chicken and rice', kcal: 512, c: 40, p: 45, f: 12 });
  assert.equal(toolResultSummary('log_meal', { text: '200g chicken' }, result, 'metric'), 'Logged · 512 kcal');
});

test('toolResultSummary: delete_meal', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({ ok: true, id: 'e1', name: 'Chicken and rice' });
  assert.equal(toolResultSummary('delete_meal', {}, result, 'metric'), 'Removed · Chicken and rice');
});

test('toolResultSummary: log_weight — unit-conversion case', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({ ok: true, valueKg: 70, localDay: '2026-01-01', deduped: false });
  assert.equal(toolResultSummary('log_weight', { value: 70, unit: 'kg' }, result, 'metric'), 'Logged · 70.0 kg');
  assert.equal(toolResultSummary('log_weight', { value: 70, unit: 'kg' }, result, 'imperial'), 'Logged · 154 lb');
});

test('toolResultSummary: log_workout', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({ ok: true, exercise: 'squat', sets: [{ reps: 5 }, { reps: 5 }] });
  assert.equal(toolResultSummary('log_workout', {}, result, 'metric'), 'Logged · 2 sets squat');
});

test('toolResultSummary: log_workout with ok:false (no raw Error prefix) is still undefined', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({ ok: false, reason: 'no_reps', message: 'Could not find a valid set.' });
  assert.equal(toolResultSummary('log_workout', {}, result, 'metric'), undefined);
});

test('toolResultSummary: update_diet_budget', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({ ok: true, budget: { mode: 'custom', goal: 'muscle', targetKcal: 2400, protein: 180, carbs: 240, fat: 70 } });
  assert.equal(toolResultSummary('update_diet_budget', { mode: 'custom', targetKcal: 2400 }, result, 'metric'), 'Budget updated · 2400 kcal');
});

test('toolResultSummary: get_schedule', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify({ timezone: 'America/New_York', busy: [{}, {}, {}] });
  assert.equal(toolResultSummary('get_schedule', { days: 1 }, result, 'metric'), '3 events over next 1d');
});

test('toolResultSummary: query_ontology counts notes', async () => {
  const { toolResultSummary } = await activityPromise;
  const result = JSON.stringify([{ id: '1', label: 'Peanut allergy' }, { id: '2', label: 'Marathon runner' }]);
  assert.equal(toolResultSummary('query_ontology', {}, result, 'metric'), '2 notes');
});

test('toolResultSummary: read_entity reads the label + fact count', async () => {
  const { toolResultSummary } = await activityPromise;
  const doc = [
    '# Father',
    'Person · 2 facts',
    '',
    'These facts are recorded about Father, not about the user.',
    '',
    '## Condition',
    '- Hypertension',
    '  evidence: "he has high blood pressure"',
    '  source: confirmed · recorded 2026-01-01',
  ].join('\n');
  assert.equal(toolResultSummary('read_entity', { name: 'Father' }, doc, 'metric'), 'Father · 2 facts');
});

test('toolResultSummary: read_entity miss is undefined', async () => {
  const { toolResultSummary } = await activityPromise;
  const miss = 'No entity named "Zeus" found. Known entities: Father (Person).';
  assert.equal(toolResultSummary('read_entity', { name: 'Zeus' }, miss, 'metric'), undefined);
});

test('toolResultSummary: read_memory / write_memory / append_observation', async () => {
  const { toolResultSummary } = await activityPromise;
  assert.equal(
    toolResultSummary('read_memory', { filename: 'nutrition-habits.json' }, '{"likes":[]}', 'metric'),
    'Reviewed nutrition habits',
  );
  assert.equal(
    toolResultSummary('read_memory', { filename: 'lab-results.json' }, 'File "lab-results.json" not found.', 'metric'),
    undefined,
  );
  assert.equal(
    toolResultSummary('write_memory', { filename: 'life-context.json', content: '{}' }, 'Memory updated.', 'metric'),
    'Updated life context',
  );
  assert.equal(
    toolResultSummary('append_observation', { note: 'Sleeps better after rest days' }, 'Observation appended.', 'metric'),
    'Noted: Sleeps better after rest days',
  );
});

test('toolResultSummary: remember_fact / propose_fact / confirm_fact / resolve_fact', async () => {
  const { toolResultSummary } = await activityPromise;
  assert.equal(
    toolResultSummary(
      'remember_fact', { nodeType: 'Allergy', label: 'Peanut allergy', evidence: 'x' },
      JSON.stringify({ ok: true, nodeId: 'n1', label: 'Peanut allergy', nodeType: 'Allergy', subjectNodeId: null }),
      'metric',
    ),
    'Noted: Peanut allergy',
  );
  assert.equal(
    toolResultSummary(
      'propose_fact', { nodeType: 'Goal', label: 'Sub-4 marathon', evidence: 'x' },
      JSON.stringify({ ok: true, factId: 'p1', status: 'pending' }),
      'metric',
    ),
    'Proposed: Sub-4 marathon',
  );
  assert.equal(
    toolResultSummary('confirm_fact', { factId: 'p1', action: 'confirm' }, JSON.stringify({ ok: true, factId: 'p1', status: 'confirmed' }), 'metric'),
    'Confirmed',
  );
  assert.equal(
    toolResultSummary('confirm_fact', { factId: 'p1', action: 'reject' }, JSON.stringify({ ok: true, factId: 'p1', status: 'rejected' }), 'metric'),
    'Rejected',
  );
  assert.equal(
    toolResultSummary(
      'resolve_fact', { evidence: 'healed' },
      JSON.stringify({ ok: true, resolved: true, nodeId: 'n1', label: 'Adductor injury', nodeType: 'Injury', evidence: 'healed' }),
      'metric',
    ),
    'Removed: Adductor injury',
  );
  // resolve_fact's own "not found" result has ok:false with no raw "Error"
  // prefix — summary must still be undefined, not a fabricated line.
  assert.equal(
    toolResultSummary('resolve_fact', { evidence: 'x' }, JSON.stringify({ ok: false, resolved: false, reason: 'No matching active fact found for label "x".' }), 'metric'),
    undefined,
  );
});

// ── extractMemorySources — reads only ───────────────────────────────────────

test('extractMemorySources: query_ontology returns up to 3, using evidence over label', async () => {
  const { extractMemorySources } = await activityPromise;
  const result = JSON.stringify([
    { id: '1', label: 'Peanut allergy', properties: { evidence: 'allergic to peanuts' }, created_at: '2026-01-01T00:00:00.000Z' },
    { id: '2', label: 'Marathon runner', properties: null, created_at: '2026-02-01T00:00:00.000Z' },
    { id: '3', label: 'Vegetarian', properties: { evidence: 'no meat' }, created_at: '2026-03-01T00:00:00.000Z' },
    { id: '4', label: 'Fourth (dropped, only 3 max)', properties: null, created_at: '2026-04-01T00:00:00.000Z' },
  ]);
  const sources = extractMemorySources('query_ontology', result);
  assert.equal(sources?.length, 3);
  assert.deepEqual(sources![0], { text: 'allergic to peanuts', date: '2026-01-01' });
  assert.deepEqual(sources![1], { text: 'Marathon runner', date: '2026-02-01' });
});

test('extractMemorySources: query_ontology with no rows is undefined', async () => {
  const { extractMemorySources } = await activityPromise;
  assert.equal(extractMemorySources('query_ontology', '[]'), undefined);
});

test('extractMemorySources: read_entity parses evidence + recorded date from the rendered doc', async () => {
  const { extractMemorySources } = await activityPromise;
  const doc = [
    '# Father',
    'Person · 2 facts',
    '',
    '## Condition',
    '- Hypertension',
    '  evidence: "he has high blood pressure"',
    '  source: confirmed · recorded 2026-01-01',
    '## Medication',
    '- Lisinopril',
    '  evidence: "takes it daily"',
    '  source: from chat · recorded 2026-02-01',
  ].join('\n');
  const sources = extractMemorySources('read_entity', doc);
  assert.deepEqual(sources, [
    { text: 'he has high blood pressure', date: '2026-01-01' },
    { text: 'takes it daily', date: '2026-02-01' },
  ]);
});

test('extractMemorySources: read_entity miss is undefined', async () => {
  const { extractMemorySources } = await activityPromise;
  assert.equal(extractMemorySources('read_entity', 'No entity named "Zeus" found. Known entities: Father (Person).'), undefined);
});

test('extractMemorySources: read_memory takes the first non-heading lines, no date', async () => {
  const { extractMemorySources } = await activityPromise;
  const file = '# Nutrition habits\n\nPrefers high-protein breakfasts.\nDislikes cilantro.\n\nEats out on Fridays.';
  const sources = extractMemorySources('read_memory', file);
  assert.deepEqual(sources, [
    { text: 'Prefers high-protein breakfasts.' },
    { text: 'Dislikes cilantro.' },
    { text: 'Eats out on Fridays.' },
  ]);
});

test('extractMemorySources: not a memory-read tool is always undefined', async () => {
  const { extractMemorySources } = await activityPromise;
  assert.equal(extractMemorySources('get_sleep_summary', '{}'), undefined);
  assert.equal(extractMemorySources('remember_fact', '{"ok":true}'), undefined);
});

test('extractMemorySources: Error-prefixed result is always undefined', async () => {
  const { extractMemorySources } = await activityPromise;
  assert.equal(extractMemorySources('query_ontology', 'Error: the query_ontology tool failed'), undefined);
});

// ── extractMemoryOp — writes only ────────────────────────────────────────────

test('extractMemoryOp: remember_fact -> saved, with the nodeId as the undo factId', async () => {
  const { extractMemoryOp } = await activityPromise;
  const result = JSON.stringify({ ok: true, nodeId: 'n1', label: 'Peanut allergy', nodeType: 'Allergy', subjectNodeId: null });
  const op = extractMemoryOp('remember_fact', { nodeType: 'Allergy', label: 'Peanut allergy', evidence: 'x' }, result);
  assert.deepEqual(op, { op: 'saved', text: 'Peanut allergy', factId: 'n1' });
});

test('extractMemoryOp: write_memory / append_observation -> saved, no factId (no stable undo target)', async () => {
  const { extractMemoryOp } = await activityPromise;
  const writeOp = extractMemoryOp('write_memory', { filename: 'life-context.json', content: '{}' }, 'Memory updated.');
  assert.equal(writeOp?.op, 'saved');
  assert.equal(writeOp?.factId, undefined);

  const observeOp = extractMemoryOp('append_observation', { note: 'Trains six days a week' }, 'Observation appended.');
  assert.deepEqual(observeOp, { op: 'saved', text: 'Trains six days a week' });
});

test('extractMemoryOp: propose_fact -> proposed, with the pending fact id', async () => {
  const { extractMemoryOp } = await activityPromise;
  const result = JSON.stringify({ ok: true, factId: 'p1', status: 'pending' });
  const op = extractMemoryOp('propose_fact', { nodeType: 'Goal', label: 'Sub-4 marathon', evidence: 'x' }, result);
  assert.deepEqual(op, { op: 'proposed', text: 'Sub-4 marathon', factId: 'p1' });
});

test('extractMemoryOp: confirm_fact -> updated (both confirm and reject actions)', async () => {
  const { extractMemoryOp } = await activityPromise;
  const confirmed = extractMemoryOp('confirm_fact', { factId: 'p1', action: 'confirm' }, JSON.stringify({ ok: true, factId: 'p1', status: 'confirmed' }));
  assert.equal(confirmed?.op, 'updated');
  assert.equal(confirmed?.factId, undefined);
  const rejected = extractMemoryOp('confirm_fact', { factId: 'p1', action: 'reject' }, JSON.stringify({ ok: true, factId: 'p1', status: 'rejected' }));
  assert.equal(rejected?.op, 'updated');
});

test('extractMemoryOp: resolve_fact -> removed, using the returned label', async () => {
  const { extractMemoryOp } = await activityPromise;
  const result = JSON.stringify({ ok: true, resolved: true, nodeId: 'n1', label: 'Adductor injury', nodeType: 'Injury', evidence: 'healed' });
  const op = extractMemoryOp('resolve_fact', { evidence: 'healed' }, result);
  assert.deepEqual(op, { op: 'removed', text: 'Adductor injury' });
});

test('extractMemoryOp: a failed write (ok:false, no raw Error prefix) yields no memory op', async () => {
  const { extractMemoryOp } = await activityPromise;
  assert.equal(extractMemoryOp('resolve_fact', { evidence: 'x' }, JSON.stringify({ ok: false, resolved: false, reason: 'no match' })), undefined);
  assert.equal(extractMemoryOp('remember_fact', { label: '' }, JSON.stringify({ ok: false, reason: 'label is required.' })), undefined);
});

test('extractMemoryOp: not a memory-write tool is always undefined', async () => {
  const { extractMemoryOp } = await activityPromise;
  assert.equal(extractMemoryOp('read_memory', {}, 'some content'), undefined);
  assert.equal(extractMemoryOp('log_meal', {}, '{"ok":true}'), undefined);
});

// ── doneLabel ────────────────────────────────────────────────────────────────

test('doneLabel is past-tense and non-empty for every known tool, and falls back for unknown ones', async () => {
  const { doneLabel } = await activityPromise;
  assert.equal(doneLabel('get_sleep_summary', {}), 'Checked your sleep');
  assert.equal(doneLabel('remember_fact', {}), 'Remembered that');
  assert.equal(doneLabel('get_metric_trend', { metric: 'hrv_sdnn' }), 'Checked your HRV trend');
  assert.equal(doneLabel('something_unknown', {}), 'Done');
});

// ── deriveActivityFromToolCalls — history mapping, old vs new rows ──────────

test('deriveActivityFromToolCalls: undefined for no tool calls', async () => {
  const { deriveActivityFromToolCalls } = await activityPromise;
  assert.equal(deriveActivityFromToolCalls(null), undefined);
  assert.equal(deriveActivityFromToolCalls([]), undefined);
});

test('deriveActivityFromToolCalls: an old row (name + input only) derives label/kind from name', async () => {
  const { deriveActivityFromToolCalls } = await activityPromise;
  const activity = deriveActivityFromToolCalls([
    { name: 'get_sleep_summary', input: { days: 7 } },
    { name: 'remember_fact', input: { nodeType: 'Allergy', label: 'Peanut allergy', evidence: 'x' } },
  ]);
  assert.deepEqual(activity, [
    { name: 'get_sleep_summary', label: 'Checked your sleep', kind: 'data' },
    { name: 'remember_fact', label: 'Remembered that', kind: 'memory' },
  ]);
});

test('deriveActivityFromToolCalls: a new row keeps its own persisted fields as-is', async () => {
  const { deriveActivityFromToolCalls } = await activityPromise;
  const activity = deriveActivityFromToolCalls([
    {
      name: 'get_sleep_summary', input: { days: 7 },
      label: 'Checked your sleep', kind: 'data', ok: true, summary: 'Last 7 nights · avg 5h 57m',
    },
    {
      name: 'query_ontology', input: {},
      label: 'Checked what I know about you', kind: 'memory', ok: true, summary: '2 notes',
      sources: [{ text: 'allergic to peanuts', date: '2026-01-01' }],
    },
    {
      name: 'remember_fact', input: { nodeType: 'Allergy', label: 'Peanut allergy', evidence: 'x' },
      label: 'Remembered that', kind: 'memory', ok: true, summary: 'Noted: Peanut allergy',
      memory: { op: 'saved', text: 'Peanut allergy', factId: 'n1' },
    },
  ]);
  assert.equal(activity?.length, 3);
  assert.equal(activity![0].summary, 'Last 7 nights · avg 5h 57m');
  assert.deepEqual(activity![1].sources, [{ text: 'allergic to peanuts', date: '2026-01-01' }]);
  assert.deepEqual(activity![2].memory, { op: 'saved', text: 'Peanut allergy', factId: 'n1' });
});

test('deriveActivityFromToolCalls: a private specialist-handoff entry ({name} only) still derives cleanly', async () => {
  const { deriveActivityFromToolCalls } = await activityPromise;
  const activity = deriveActivityFromToolCalls([{ name: 'propose_specialist_handoff' }]);
  assert.deepEqual(activity, [{ name: 'propose_specialist_handoff', label: 'Done', kind: 'other' }]);
});

test('deriveActivityFromToolCalls: skips malformed entries but keeps the rest', async () => {
  const { deriveActivityFromToolCalls } = await activityPromise;
  const activity = deriveActivityFromToolCalls([
    { notAName: true },
    { name: 'get_workouts', input: { days: 7 } },
  ]);
  assert.deepEqual(activity, [{ name: 'get_workouts', label: 'Checked your workouts', kind: 'data' }]);
});

test('toolResultSummary: set_goal_target renders weight in the user\'s unit', async () => {
  const { toolResultSummary, doneLabel } = await activityPromise;
  const result = JSON.stringify({ ok: true, targetWeightKg: 76, targetDate: '2026-12-25', weeklySessionsTarget: 4, reanchored: true });
  assert.equal(toolResultSummary('set_goal_target', {}, result, 'metric'), 'Goal set · 76.0 kg by 2026-12-25 4x/week');
  assert.equal(toolResultSummary('set_goal_target', {}, result, 'imperial'), 'Goal set · 168 lb by 2026-12-25 4x/week');
  assert.equal(doneLabel('set_goal_target', {}), 'Set your goal');
});
