import assert from 'node:assert/strict';
import test from 'node:test';
import { SpecialistRegistry } from './registry';
import {
  InMemorySpecialistSessionRepository,
  SpecialistSessionService,
} from './sessions';
import {
  accumulateModelUsage,
  isModelStreamInterruption,
  SpecialistCoachRuntime,
  PROPOSE_SPECIALIST_HANDOFF_TOOL,
  PROPOSE_RETURN_TO_VITAL_TOOL,
} from './coachRuntime';
import Anthropic from '@anthropic-ai/sdk';

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-07-11T12:00:00Z');

function setup() {
  const manifests = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-opus-test' });
  const sessions = new SpecialistSessionService(
    new InMemorySpecialistSessionRepository(),
    () => NOW,
    manifests,
  );
  const logs: Array<Record<string, unknown>> = [];
  const runtime = new SpecialistCoachRuntime({
    sessions,
    manifests,
    now: () => NOW,
    log: (entry) => logs.push(entry),
  });
  return { manifests, sessions, runtime, logs };
}

test('proposal tool creates only a pending proposal and logs no private handoff content', async () => {
  const { runtime, logs } = setup();
  const session = await runtime.proposeHandoff(USER, {
    objective: 'Create a safe 10K training week',
    summary: 'Private health summary that must not be logged',
    relevantFacts: ['Runs twice weekly'],
  });
  assert.equal(session.status, 'proposed');
  assert.equal(session.activatedAt, null);
  assert.equal(session.expiresAt?.toISOString(), '2026-07-11T12:15:00.000Z');
  assert.equal(JSON.stringify(logs).includes('Private health summary'), false);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['event', 'manifestId', 'sessionId', 'status', 'userId']);
});

test('return tool validates the complete summary and leaves specialist active pending confirmation', async () => {
  const { runtime, sessions } = setup();
  const proposed = await runtime.proposeHandoff(USER, {
    objective: 'Plan a week', summary: 'Runner', relevantFacts: [],
  });
  await sessions.transition(USER, proposed.id, 'active');
  const returned = await runtime.proposeReturn(USER, proposed.id, {
    outcomes: ['Week planned'], decisions: ['Three runs'],
    recommendations: ['Easy effort'], unresolvedRisks: ['Soreness response'],
    nextSteps: ['Check in next week'],
  });
  assert.equal(returned.status, 'return_proposed');
  assert.notEqual(returned.expiresAt, null);
  assert.deepEqual(returned.returnHandoff, {
    outcomes: ['Week planned'], decisions: ['Three runs'],
    recommendations: ['Easy effort'], unresolvedRisks: ['Soreness response'],
    nextSteps: ['Check in next week'],
  });
});

test('explicit active-session return completes immediately with a compact return record', async () => {
  const { runtime, sessions } = setup();
  const proposed = await runtime.proposeHandoff(USER, {
    objective: 'Plan a week', summary: 'Runner', relevantFacts: [],
  });
  await sessions.transition(USER, proposed.id, 'active');
  const completed = await runtime.completeExplicitReturn(USER, proposed.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.returnHandoff, {
    reason: 'user_requested_return',
    summary: 'The user explicitly ended the specialist consultation.',
  });
});

test('premium model failure restores Vital while aborted stream preserves active session', async () => {
  const failedSetup = setup();
  const failedProposal = await failedSetup.runtime.proposeHandoff(USER, {
    objective: 'Plan a week', summary: 'Runner', relevantFacts: [],
  });
  await failedSetup.sessions.transition(USER, failedProposal.id, 'active');
  const failed = await failedSetup.runtime.handleModelFailure(
    USER, failedProposal.id, new Error('provider unavailable'),
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureReason, 'premium_model_unavailable');

  const abortedSetup = setup();
  const abortedProposal = await abortedSetup.runtime.proposeHandoff(USER, {
    objective: 'Plan a week', summary: 'Runner', relevantFacts: [],
  });
  await abortedSetup.sessions.transition(USER, abortedProposal.id, 'active');
  const abort = new Error('client disconnected');
  abort.name = 'AbortError';
  const preserved = await abortedSetup.runtime.handleModelFailure(USER, abortedProposal.id, abort);
  assert.equal(preserved.status, 'active');

  const sdkAbort = new Anthropic.APIUserAbortError();
  assert.equal(isModelStreamInterruption(sdkAbort), true);
  const sdkPreserved = await abortedSetup.runtime.handleModelFailure(
    USER, abortedProposal.id, sdkAbort,
  );
  assert.equal(sdkPreserved.status, 'active');
});

test('model usage aggregates billed input and output tokens across premium rounds', () => {
  let usage = accumulateModelUsage(undefined, {
    input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
    output_tokens: 40,
  });
  usage = accumulateModelUsage(usage, {
    input_tokens: 50,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: 10,
    output_tokens: 15,
  });
  assert.deepEqual(usage, { inputTokens: 210, outputTokens: 55 });
});

test('coach tools expose the exact proposal and structured-return contracts', () => {
  assert.equal(PROPOSE_SPECIALIST_HANDOFF_TOOL.name, 'propose_specialist_handoff');
  assert.deepEqual(PROPOSE_SPECIALIST_HANDOFF_TOOL.input_schema.required, ['objective', 'summary', 'relevantFacts']);
  assert.equal(PROPOSE_RETURN_TO_VITAL_TOOL.name, 'propose_return_to_vital');
  assert.deepEqual(PROPOSE_RETURN_TO_VITAL_TOOL.input_schema.required, [
    'outcomes', 'decisions', 'recommendations', 'unresolvedRisks', 'nextSteps',
  ]);
});
