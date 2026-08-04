import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../db/schema';

/**
 * Drives the real POST handler against a fake `@/db` (no Postgres) and fakes
 * for the file-backed `@/lib/memory` module (no filesystem writes) — same
 * pattern as app/api/profile/route.test.ts. mock.module() must run before
 * the route's first import; node:test isolates each test file in its own
 * subprocess, so this lives on its own.
 *
 * Focus: basics.units was validated as required but never persisted anywhere
 * (see lib/units.ts / this route's changes) — prove it now lands in
 * users.unit_system via the lenient resolveUnitSystem normalize-on-write
 * (never a 400, even for a value no client should send), and that
 * core-profile.md's Identity section is untouched by units — still cm/kg.
 */

const CORE_PROFILE_TEMPLATE = [
  '# Vital — Core Profile',
  '',
  '## Identity',
  '- Age: [to be filled]',
  '- Sex: [to be filled]',
  '- Height: [to be filled]',
  '- Current weight: [to be filled] — last updated',
  '',
].join('\n');

const updateCalls: Array<Record<string, unknown>> = [];
const writtenFiles: Array<{ userId: string; filename: string; content: string }> = [];

const fakeDb = {
  update: (table: unknown) => ({
    set: (assigned: Record<string, unknown>) => {
      if (table === realSchema.users) updateCalls.push(assigned);
      return { where: async () => {} };
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/memory', {
  namedExports: {
    seedUserMemory: () => {},
    readMemoryFile: (_userId: string, filename: string) =>
      filename === 'core-profile.md' ? CORE_PROFILE_TEMPLATE : null,
    writeMemoryFile: (userId: string, filename: string, content: string) => {
      writtenFiles.push({ userId, filename, content });
    },
  },
});

const routePromise = import('./route');

function basicsBody(units: string) {
  return {
    basics: {
      name: 'Test User',
      dob: '1990-01-01',
      sex: 'male',
      heightCm: 180,
      weightKg: 80,
      units,
      goal: 'general',
    },
  };
}

function postRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/onboarding', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('basics.units: "imperial" lands in users.unit_system', async () => {
  updateCalls.length = 0;
  writtenFiles.length = 0;

  const { POST } = await routePromise;
  const res = await POST(postRequest(basicsBody('imperial'), { 'x-user-id': 'user-1' }));

  assert.equal(res.status, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].unit_system, 'imperial');
});

test('an unrecognised units value normalises to "metric" rather than 400ing', async () => {
  updateCalls.length = 0;
  writtenFiles.length = 0;

  const { POST } = await routePromise;
  const res = await POST(postRequest(basicsBody('furlongs'), { 'x-user-id': 'user-1' }));

  assert.equal(res.status, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].unit_system, 'metric');
});

test('core-profile.md still gets cm/kg regardless of units', async () => {
  updateCalls.length = 0;
  writtenFiles.length = 0;

  const { POST } = await routePromise;
  const res = await POST(postRequest(basicsBody('imperial'), { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);

  const coreProfileWrite = writtenFiles.find((f) => f.filename === 'core-profile.md');
  assert.ok(coreProfileWrite, 'expected a core-profile.md write');
  assert.match(coreProfileWrite!.content, /180 cm/);
  assert.match(coreProfileWrite!.content, /80 kg/);
});
