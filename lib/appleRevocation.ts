/**
 * Sign in with Apple token revocation (App Store guideline 5.1.1(v)).
 *
 * Apps that offer Sign in with Apple must revoke the user's Apple tokens when
 * the account is deleted. We store no Apple tokens, so the iOS client re-runs
 * an (scope-less) Apple authorization at deletion time and sends the fresh
 * one-time `authorizationCode` to DELETE /api/account. This module then:
 *
 *   1. builds the ES256 "client secret" JWT Apple requires,
 *   2. exchanges the code at https://appleid.apple.com/auth/token for a
 *      refresh token (falling back to the access token), and
 *   3. revokes that token at https://appleid.apple.com/auth/revoke.
 *
 * Revocation is strictly best-effort: `revokeAppleTokens` NEVER throws, and
 * callers must never let its outcome block or undo data deletion. It resolves
 * to `{ status: 'revoked' | 'skipped' | 'failed' }`.
 *
 * Config (all four required, otherwise revocation is skipped with a warning):
 *   APPLE_TEAM_ID     Apple Developer Team ID                      (JWT `iss`)
 *   APPLE_KEY_ID      Key ID of a "Sign in with Apple" key         (JWT `kid`)
 *   APPLE_CLIENT_ID   the app's bundle id; falls back to           (JWT `sub`)
 *                     APPLE_BUNDLE_ID, the audience lib/auth.ts already
 *                     verifies identity tokens against
 *   APPLE_PRIVATE_KEY PEM contents of the .p8 key ("\n"-escaped is accepted)
 *
 * No secret, authorization code, or token is ever logged.
 */
import { SignJWT, importPKCS8 } from 'jose';

export const APPLE_AUDIENCE = 'https://appleid.apple.com';
export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

/** Apple rejects client secrets that live longer than 6 months. */
export const MAX_CLIENT_SECRET_TTL_SECONDS = 15_777_000;
/** We mint a secret per request, so keep it short-lived. */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;
/** Overall budget for the whole token exchange + revoke round trip. */
export const DEFAULT_REVOCATION_TIMEOUT_MS = 5_000;
/** Authorization codes are ~50-100 chars; anything huge is not one. */
const MAX_AUTHORIZATION_CODE_LENGTH = 4096;

export interface AppleRevocationConfig {
  teamId: string;
  keyId: string;
  /** App bundle id (the Sign in with Apple "client_id" for native apps). */
  clientId: string;
  /** PEM (PKCS#8) contents of the Sign in with Apple .p8 key. */
  privateKeyPem: string;
}

export type AppleRevocationStatus = 'revoked' | 'skipped' | 'failed';

export interface AppleRevocationResult {
  status: AppleRevocationStatus;
  /** Short machine-readable cause for `skipped` / `failed`; never contains secrets. */
  reason?: string;
}

export type AppleFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Accepts a PEM pasted with literal "\n" sequences or wrapped in quotes. */
function normalizePem(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').trim();
}

/**
 * Reads the revocation config from the environment. Returns null when any
 * required value is missing so the caller can skip revocation.
 */
export function loadAppleRevocationConfig(
  env: Record<string, string | undefined> = process.env
): AppleRevocationConfig | null {
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_KEY_ID?.trim();
  const clientId = (env.APPLE_CLIENT_ID || env.APPLE_BUNDLE_ID)?.trim();
  const privateKey = env.APPLE_PRIVATE_KEY;
  if (!teamId || !keyId || !clientId || !privateKey || !privateKey.trim()) return null;
  return { teamId, keyId, clientId, privateKeyPem: normalizePem(privateKey) };
}

/**
 * Builds the ES256 client-secret JWT Apple's /auth/token and /auth/revoke
 * endpoints require: header `{alg: ES256, kid}`, claims `iss` = team id,
 * `iat`, `exp` (<= 6 months), `aud` = https://appleid.apple.com, `sub` =
 * client id.
 */
export async function buildAppleClientSecret(params: {
  teamId: string;
  keyId: string;
  clientId: string;
  privateKeyPem: string;
  now?: Date;
  /** Lifetime in seconds; clamped to Apple's 6-month maximum. */
  ttlSeconds?: number;
}): Promise<string> {
  const { teamId, keyId, clientId, privateKeyPem } = params;
  const now = params.now ?? new Date();
  const ttl = Math.min(params.ttlSeconds ?? CLIENT_SECRET_TTL_SECONDS, MAX_CLIENT_SECRET_TTL_SECONDS);
  const iat = Math.floor(now.getTime() / 1000);
  const key = await importPKCS8(normalizePem(privateKeyPem), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .setAudience(APPLE_AUDIENCE)
    .setSubject(clientId)
    .sign(key);
}

class RevocationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function postForm(
  doFetch: AppleFetch,
  url: string,
  form: Record<string, string>,
  signal: AbortSignal,
  step: 'token' | 'revoke'
): Promise<Response> {
  // A fetch that ignored the abort signal must not go on to start the next step.
  if (signal.aborted) throw new RevocationError('timeout');
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new RevocationError('timeout');
    throw new RevocationError(`${step}-network-error:${err instanceof Error ? err.name : 'unknown'}`);
  }
  if (!res.ok) {
    // Apple's error bodies are `{"error":"invalid_grant"}` — safe to log the
    // code, never the request.
    let appleError = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') appleError = `:${body.error.slice(0, 64)}`;
    } catch {
      // non-JSON error body
    }
    throw new RevocationError(`${step}-http-${res.status}${appleError}`);
  }
  return res;
}

async function exchangeAndRevoke(
  authorizationCode: string,
  config: AppleRevocationConfig,
  doFetch: AppleFetch,
  signal: AbortSignal
): Promise<void> {
  let clientSecret: string;
  try {
    clientSecret = await buildAppleClientSecret(config);
  } catch {
    throw new RevocationError('client-secret-error');
  }

  const tokenRes = await postForm(
    doFetch,
    APPLE_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: authorizationCode,
      client_id: config.clientId,
      client_secret: clientSecret,
    },
    signal,
    'token'
  );

  let tokens: { refresh_token?: unknown; access_token?: unknown };
  try {
    tokens = (await tokenRes.json()) as typeof tokens;
  } catch {
    throw new RevocationError('token-bad-response');
  }

  let token: string;
  let tokenTypeHint: 'refresh_token' | 'access_token';
  if (typeof tokens.refresh_token === 'string' && tokens.refresh_token) {
    token = tokens.refresh_token;
    tokenTypeHint = 'refresh_token';
  } else if (typeof tokens.access_token === 'string' && tokens.access_token) {
    token = tokens.access_token;
    tokenTypeHint = 'access_token';
  } else {
    throw new RevocationError('token-missing');
  }

  await postForm(
    doFetch,
    APPLE_REVOKE_URL,
    {
      token,
      token_type_hint: tokenTypeHint,
      client_id: config.clientId,
      client_secret: clientSecret,
    },
    signal,
    'revoke'
  );
}

/**
 * Exchanges `authorizationCode` for Apple tokens and revokes them. Never
 * throws; the whole round trip is bounded by `timeoutMs`.
 *
 *  - no code            -> `skipped` (older app build, dev sign-in, or Apple
 *                          sheet failed on device)
 *  - config === null    -> `skipped` + a logged warning
 *  - Apple 2xx on both  -> `revoked`
 *  - anything else      -> `failed` (logged without secrets)
 */
export async function revokeAppleTokens(params: {
  authorizationCode: string | null | undefined;
  config: AppleRevocationConfig | null;
  fetchImpl?: AppleFetch;
  timeoutMs?: number;
}): Promise<AppleRevocationResult> {
  const { authorizationCode, config } = params;

  const code = typeof authorizationCode === 'string' ? authorizationCode.trim() : '';
  if (!code || code.length > MAX_AUTHORIZATION_CODE_LENGTH) {
    return { status: 'skipped', reason: 'no-authorization-code' };
  }
  if (!config) {
    console.warn('[account/delete] SIWA revocation skipped: APPLE_* secrets not configured');
    return { status: 'skipped', reason: 'not-configured' };
  }

  const doFetch: AppleFetch = params.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = params.timeoutMs ?? DEFAULT_REVOCATION_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Race against a hard deadline so a fetch that ignores `signal` (or a fake
  // that never settles) still cannot hold the response open.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RevocationError('timeout'));
    }, timeoutMs);
  });

  try {
    await Promise.race([exchangeAndRevoke(code, config, doFetch, controller.signal), deadline]);
    return { status: 'revoked' };
  } catch (err) {
    const reason = err instanceof RevocationError ? err.reason : 'unexpected-error';
    console.error(`[account/delete] SIWA revocation failed: ${reason}`);
    return { status: 'failed', reason };
  } finally {
    clearTimeout(timer);
  }
}
