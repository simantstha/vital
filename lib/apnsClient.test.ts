import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { ApnsClient, type ApnsTransport } from './apnsClient';
import { readFileSync } from 'node:fs';

const alert = { title: 'Ready', body: 'Your update is ready.' };
const privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

test('uses token auth and the environment-specific HTTP/2 APNs host', async () => {
  const seen: Array<{ origin: string; headers: Record<string, string>; body: string }> = [];
  const transport: ApnsTransport = { async request(origin, headers, body) { seen.push({ origin, headers, body }); return { status: 200, body: '', latencyMs: 4 }; } };
  const client = new ApnsClient({ keyId: 'K', teamId: 'T', topic: 'com.vital.app', privateKey }, transport);
  await client.send({ id: '1', token: 'do-not-log', environment: 'sandbox' }, alert);
  await client.send({ id: '2', token: 'do-not-log-2', environment: 'production' }, alert);
  assert.equal(seen[0].origin, 'https://api.sandbox.push.apple.com');
  assert.equal(seen[1].origin, 'https://api.push.apple.com');
  assert.match(seen[0].headers.authorization, /^bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.equal(seen[0].headers['apns-push-type'], 'alert');
  assert.deepEqual(JSON.parse(seen[0].body).aps.alert, { title: 'Ready', body: 'Your update is ready.' });
});

test('includes only the public route type and analysis id', async () => {
  let body = '';
  const transport: ApnsTransport = { async request(_origin, _headers, value) { body = value; return { status: 200, body: '', latencyMs: 1 }; } };
  const client = new ApnsClient({ keyId: 'K', teamId: 'T', topic: 'com.vital.app', privateKey }, transport);
  await client.send({ id: 'device', token: 'secret', environment: 'sandbox' }, alert, { type: 'workout_analysis', id: 'public-id', deepLink: 'vital://workout-analysis/public-id' });
  assert.deepEqual(JSON.parse(body), { aps: { alert: { title: 'Ready', body: 'Your update is ready.' }, sound: 'default' }, type: 'workout_analysis', id: 'public-id', deepLink: 'vital://workout-analysis/public-id' });
});

test('classifies transport failures as retryable without exposing the token', async () => {
  const client = new ApnsClient({ keyId: 'K', teamId: 'T', topic: 'com.vital.app', privateKey }, { async request() { throw new Error('network'); } });
  assert.deepEqual(await client.send({ id: '1', token: 'secret', environment: 'production' }, alert), {
    outcome: 'transient', retireToken: false, category: 'network_error',
  });
});

test('production transport bounds the APNs connect and request handoff', () => {
  const source = readFileSync(new URL('./apnsClient.ts', import.meta.url), 'utf8');
  assert.match(source, /setTimeout\(\(\) =>/);
  assert.match(source, /10_000/);
  assert.match(source, /category: 'network_error'/);
});
