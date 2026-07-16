import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';
import { classifyApnsResponse, type PushDevice, type PushOutcome } from './proactiveHealthWorker';

export interface ApnsConfig { keyId: string; teamId: string; topic: string; privateKey: string }
export interface ApnsAlert { title: string; body: string }
export interface ApnsTransport { request(origin: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string; latencyMs: number }> }
export type ApnsRoute = { type: 'workout_analysis' | 'sleep_analysis'; id: string; deepLink: string } | { type: 'morning_brief'; deepLink: string };

function base64url(value: string | Buffer): string { return Buffer.from(value).toString('base64url'); }

export class ApnsClient {
  private jwt?: { token: string; issuedAt: number };
  constructor(private readonly config: ApnsConfig, private readonly transport: ApnsTransport = http2Transport) {}
  private authorization(now: Date): string {
    const seconds = Math.floor(now.getTime() / 1000);
    if (this.jwt && seconds - this.jwt.issuedAt < 50 * 60) return this.jwt.token;
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.config.keyId }));
    const payload = base64url(JSON.stringify({ iss: this.config.teamId, iat: seconds }));
    const unsigned = `${header}.${payload}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(this.config.privateKey), dsaEncoding: 'ieee-p1363' });
    this.jwt = { token: `${unsigned}.${base64url(signature)}`, issuedAt: seconds };
    return this.jwt.token;
  }
  async send(device: PushDevice, alert: ApnsAlert, route?: ApnsRoute, now = new Date()): Promise<PushOutcome> {
    const origin = device.environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const payload = JSON.stringify({ aps: { alert: { title: alert.title, body: alert.body }, sound: 'default' }, ...route });
    let response: { status: number; body: string; latencyMs: number };
    try {
      response = await this.transport.request(origin, {
        ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${this.authorization(now)}`,
        'apns-topic': this.config.topic, 'apns-push-type': 'alert', 'apns-priority': '10',
      }, payload);
    } catch {
      return { outcome: 'transient', retireToken: false, category: 'network_error' };
    }
    let reason: string | undefined;
    try { reason = (JSON.parse(response.body) as { reason?: string }).reason; } catch { /* APNs 200 has no body. */ }
    return { ...classifyApnsResponse(response.status, reason), status: response.status, category: reason, latencyMs: response.latencyMs };
  }
}

const http2Transport: ApnsTransport = {
  request(origin, headers, body) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const session = http2.connect(origin);
      const request = session.request(headers);
      const timeout = setTimeout(() => {
        request.destroy(); session.destroy(); reject(new Error('apns_timeout'));
      }, 10_000);
      const fail = (error: Error) => { clearTimeout(timeout); session.destroy(); reject(error); };
      session.once('error', fail);
      let status = 0; let responseBody = '';
      request.setEncoding('utf8');
      request.on('response', (responseHeaders) => { status = Number(responseHeaders[':status'] ?? 0); });
      request.on('data', (chunk) => { responseBody += chunk; });
      request.on('end', () => { clearTimeout(timeout); session.close(); resolve({ status, body: responseBody, latencyMs: Date.now() - started }); });
      request.once('error', fail);
      request.end(body);
    });
  },
};
