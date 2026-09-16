import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/**
 * profileDetails.ts now imports ./coreProfileStore (for updateIdentityLines),
 * which imports `@/db` at module scope — so even this file's DB-free
 * `parseProfileDetails` tests need `@/db` mocked before the module's first
 * import, same constraint as lib/brain/context.test.ts's buildPromptText
 * suite. None of these tests exercise updateIdentityLines, so the fake just
 * throws if anything ever touches it.
 */
mock.module('@/db', {
  namedExports: {
    db: new Proxy({}, { get() { throw new Error('parseProfileDetails tests must not touch the DB'); } }),
    schema: {},
  },
});

const profileDetailsPromise = import('./profileDetails');

test('parses populated Identity fields from core-profile.md', async () => {
  const { parseProfileDetails } = await profileDetailsPromise;
  const markdown = `## Identity
- Age: 34
- Sex: Female
- Height: 168 cm
- Current weight: 62.5 kg — last updated 2026-07-10

## Active Goals
- Primary: Improve fitness`;

  assert.deepEqual(parseProfileDetails(markdown), {
    age: 34,
    biologicalSex: 'Female',
    heightCm: 168,
    weightKg: 62.5,
  });
});

test('returns null for placeholders, malformed values, and missing fields', async () => {
  const { parseProfileDetails } = await profileDetailsPromise;
  const markdown = `## Identity
- Age: [to be filled]
- Sex: Not yet established
- Height: 170 inches
- Current weight: unknown

## Active Goals
- Primary: Build consistency`;

  assert.deepEqual(parseProfileDetails(markdown), {
    age: null,
    biologicalSex: null,
    heightCm: null,
    weightKg: null,
  });
});

test('does not parse similarly named fields outside the Identity section', async () => {
  const { parseProfileDetails } = await profileDetailsPromise;
  const markdown = `## Active Goals
- Age: 99
- Sex: Male
- Height: 190 cm
- Current weight: 90 kg

## Notes
- Current weight: 80 kg`;

  assert.deepEqual(parseProfileDetails(markdown), {
    age: null,
    biologicalSex: null,
    heightCm: null,
    weightKg: null,
  });
});
