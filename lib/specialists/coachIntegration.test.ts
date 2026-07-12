import assert from 'node:assert/strict';
import test from 'node:test';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { SpecialistRegistry } from './registry';
import type { SpecialistSession } from './sessions';
import {
  selectCoachConfiguration,
  handoffCardForSession,
  killSwitchEventsForSession,
  toolCallForPersistence,
} from './coachIntegration';

const USER = '00000000-0000-4000-8000-000000000001';
const SESSION = '10000000-0000-4000-8000-000000000001';
const baseTools = [
  { name: 'get_metric_trend', input_schema: { type: 'object', properties: {} } },
  { name: 'get_sleep_summary', input_schema: { type: 'object', properties: {} } },
  { name: 'log_meal', input_schema: { type: 'object', properties: {} } },
] as Tool[];

function session(status: SpecialistSession['status']): SpecialistSession {
  return {
    id: SESSION, userId: USER, objective: 'Plan a safe week', manifestId: 'running-coach',
    manifestVersion: '1.0.0', status, inboundHandoff: { summary: 'Runner' },
    cardOccurrenceId: '30000000-0000-4000-8000-000000000001',
    returnHandoff: status === 'return_proposed' ? { outcomes: ['Week planned'] } : null,
    failureReason: null, proposedAt: new Date(), activatedAt: status === 'proposed' ? null : new Date(),
    returnProposedAt: status === 'return_proposed' ? new Date() : null,
    completedAt: null, declinedAt: null, failedAt: null,
    expiresAt: status === 'proposed' || status === 'return_proposed' ? new Date() : null,
    updatedAt: new Date(),
  };
}

test('flag off returns the exact legacy model prompt and tools', () => {
  const selected = selectCoachConfiguration({
    enabled: false, session: null, manifest: null,
    baseModel: 'claude-sonnet-4-6', basePrompt: 'legacy prompt', baseTools,
    specialistPrompt: null,
  });
  assert.equal(selected.model, 'claude-sonnet-4-6');
  assert.equal(selected.system, 'legacy prompt');
  assert.equal(selected.tools, baseTools);
  assert.equal(selected.speaker, 'coach');
});

test('enabled Vital adds proposal tool while active and return-pending sessions stay premium', () => {
  const manifest = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-opus-test' }).get('running-coach');
  const vital = selectCoachConfiguration({
    enabled: true, session: null, manifest: null,
    baseModel: 'claude-sonnet-4-6', basePrompt: 'legacy prompt', baseTools,
    specialistPrompt: null,
  });
  assert.deepEqual(vital.tools.map((tool) => tool.name), [
    'get_metric_trend', 'get_sleep_summary', 'log_meal', 'propose_specialist_handoff',
  ]);

  for (const status of ['active', 'return_proposed'] as const) {
    const selected = selectCoachConfiguration({
      enabled: true, session: session(status), manifest,
      baseModel: 'claude-sonnet-4-6', basePrompt: 'legacy prompt', baseTools,
      specialistPrompt: {
        system: 'trusted specialist prompt', context: 'untrusted consultation context',
        model: manifest.model, allowedTools: manifest.allowedTools,
      },
    });
    assert.equal(selected.model, 'claude-opus-test');
    assert.equal(selected.system, 'trusted specialist prompt');
    assert.deepEqual(selected.tools.map((tool) => tool.name), [
      'get_metric_trend', 'get_sleep_summary', 'propose_return_to_vital',
    ]);
    assert.equal(selected.speaker, 'specialist');
  }
});

test('pending proposal produces a proposal card but does not activate specialist', () => {
  const manifest = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-opus-test' }).get('running-coach');
  const card = handoffCardForSession(session('proposed'), manifest);
  assert.equal(card.phase, 'proposed');
  assert.equal(card.cardOccurrenceId, session('proposed').cardOccurrenceId);
  assert.equal(card.specialist.title, 'Running Coach');
  assert.equal(card.returnSummary, undefined);
});

test('persisted specialist lifecycle tool calls omit private proposal and return inputs', () => {
  const privateInput = { objective: 'Private objective', summary: 'Private handoff' };
  assert.deepEqual(toolCallForPersistence('propose_specialist_handoff', privateInput), {
    name: 'propose_specialist_handoff',
  });
  assert.deepEqual(toolCallForPersistence('propose_return_to_vital', privateInput), {
    name: 'propose_return_to_vital',
  });
  assert.deepEqual(toolCallForPersistence('get_sleep_summary', { days: 7 }), {
    name: 'get_sleep_summary', input: { days: 7 },
  });
});

test('kill switch dismisses a pending card before restoring Vital', () => {
  const manifest = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-opus-test' }).get('running-coach');
  for (const status of ['proposed', 'return_proposed'] as const) {
    const events = killSwitchEventsForSession(session(status), manifest);
    assert.deepEqual(events.map((event) => event.type), ['handoff_card', 'persona_changed']);
    assert.equal(events[0].type, 'handoff_card');
    if (events[0].type === 'handoff_card') {
      assert.equal(events[0].phase, 'dismissed');
      assert.equal(events[0].cardOccurrenceId, session(status).cardOccurrenceId);
    }
  }
  assert.deepEqual(
    killSwitchEventsForSession(session('active'), manifest).map((event) => event.type),
    ['persona_changed'],
  );
});

test('kill switch degrades to persona_changed only for a pending session with no manifest available', () => {
  // e.g. SPECIALIST_MODEL was unset as part of flipping the kill switch, so
  // the manifest lookup upstream failed. Must not throw — a throw here would
  // skip disableOpen() and brick the user with a permanently pending session.
  for (const status of ['proposed', 'return_proposed'] as const) {
    const events = killSwitchEventsForSession(session(status), undefined);
    assert.deepEqual(events.map((event) => event.type), ['persona_changed']);
  }
});
