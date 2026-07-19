/**
 * WHOOP API client (stage 1 — see
 * docs/superpowers/plans/2026-07-19-whoop-integration.md).
 *
 * Pure fetch wrapper: no module-level side effects, no `@/db` import, so this
 * file is safe to import from tests without a live Postgres connection or
 * WHOOP credentials. `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` /
 * `WHOOP_REDIRECT_URI` are read lazily (at call time, inside exchangeCode /
 * refreshTokens) rather than at module load, same reasoning.
 *
 * Token endpoint: POST {BASE_URL}/oauth/oauth2/token (authorization_code and
 * refresh_token grants). Data endpoints: GET {BASE_URL}/developer/v2/...,
 * paginated with `limit` (<=25), `start`/`end` (RFC3339), and `nextToken`.
 *
 * `withValidToken()` is the single-use-refresh-token guard: WHOOP invalidates
 * the old refresh token and issues a new one on every refresh, so concurrent
 * refreshes for the same connection would brick it. `WhoopConnectionHandle`
 * bundles the connection id with a `WhoopTokenStore` (see
 * `createWhoopTokenStore` below) so the refresh check + token rotation runs
 * inside one `SELECT ... FOR UPDATE` transaction on the `whoop_connections`
 * row, serializing refreshes per connection. A refresh that fails with
 * `invalid_grant` marks the connection `status='error'` inside that same
 * transaction (surfaced in iOS as "reconnect WHOOP").
 */

import { eq } from 'drizzle-orm';
import type * as WhoopSchema from '../../db/schema';

const BASE_URL = 'https://api.prod.whoop.com';
const TOKEN_URL = `${BASE_URL}/oauth/oauth2/token`;
const API_BASE = `${BASE_URL}/developer/v2`;

const TIMEOUT_MS = 5000;
const PAGE_LIMIT = 25;
const MAX_PAGES = 10;               // defensive cap — 10 * 25 = 250 records per window
const REFRESH_MARGIN_MS = 2 * 60_000; // refresh when <2min of validity remains

// ─── Token + resource shapes ─────────────────────────────────────────────────
// Only the fields the mapping layer (lib/whoop/mapping.ts) actually reads are
// modeled; everything else in the WHOOP response is ignored.

export interface WhoopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  scope: string;
  token_type: string;
}

export interface WhoopProfile {
  user_id: number;
  email: string;
  first_name: string;
  last_name: string;
}

export interface WhoopBodyMeasurement {
  height_meter: number;
  weight_kilogram: number;
  max_heart_rate: number;
}

export interface WhoopCycleScore {
  strain: number;
  kilojoule: number;
  average_heart_rate: number;
  max_heart_rate: number;
}

export interface WhoopCycle {
  id: number;
  user_id: number;
  start: string;
  end: string | null;
  score_state: string;
  score?: WhoopCycleScore | null;
}

export interface WhoopRecoveryScore {
  recovery_score: number;
  resting_heart_rate: number;
  hrv_rmssd_milli: number;
  spo2_percentage?: number | null;
  skin_temp_celsius?: number | null;
}

export interface WhoopRecovery {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  score_state: string;
  score?: WhoopRecoveryScore | null;
}

export interface WhoopSleepScore {
  stage_summary?: Record<string, unknown>;
  respiratory_rate?: number | null;
  sleep_performance_percentage?: number | null;
}

export interface WhoopSleep {
  id: string;
  user_id: number;
  start: string;
  end: string;
  nap: boolean;
  score_state: string;
  score?: WhoopSleepScore | null;
}

export interface WhoopWorkoutScore {
  strain: number;
  average_heart_rate: number;
  max_heart_rate: number;
  kilojoule: number;
  distance_meter?: number | null;
}

export interface WhoopWorkout {
  id: string;
  user_id: number;
  start: string;
  end: string;
  sport_name: string;
  score_state: string;
  score?: WhoopWorkoutScore | null;
}

interface WhoopPagedResponse<T> {
  records: T[];
  next_token: string | null;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class WhoopTokenError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'WhoopTokenError';
  }
}

export class WhoopApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'WhoopApiError';
  }
}

/** Thrown by withValidToken when the connection isn't usable (revoked/error). */
export class WhoopConnectionInactiveError extends Error {
  constructor(public readonly connectionId: string, public readonly status: string) {
    super(`WHOOP connection ${connectionId} is not active (status=${status})`);
    this.name = 'WhoopConnectionInactiveError';
  }
}

// ─── Env (read lazily — never at module load) ────────────────────────────────

function requireEnv(name: 'WHOOP_CLIENT_ID' | 'WHOOP_CLIENT_SECRET' | 'WHOOP_REDIRECT_URI'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// ─── Token exchange / refresh ─────────────────────────────────────────────────

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function postToken(body: URLSearchParams): Promise<WhoopTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const errBody = await safeJson(res);
    const code = typeof errBody?.error === 'string' ? errBody.error : undefined;
    throw new WhoopTokenError(`WHOOP token request failed (${res.status})`, res.status, code);
  }
  return res.json() as Promise<WhoopTokenResponse>;
}

/** Authorization-code exchange — the callback route's only WHOOP-facing call. */
export async function exchangeCode(code: string): Promise<WhoopTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: requireEnv('WHOOP_CLIENT_ID'),
    client_secret: requireEnv('WHOOP_CLIENT_SECRET'),
    redirect_uri: requireEnv('WHOOP_REDIRECT_URI'),
  });
  return postToken(body);
}

/**
 * Refresh-token exchange. WHOOP's refresh tokens are single-use — a
 * successful call here returns a NEW refresh token and invalidates the old
 * one. Callers MUST persist the returned tokens before this connection is
 * refreshed again (see withValidToken, which does this under a row lock).
 * `invalid_grant` means the refresh token was already used/expired/revoked.
 */
export async function refreshTokens(refreshToken: string): Promise<WhoopTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: requireEnv('WHOOP_CLIENT_ID'),
    client_secret: requireEnv('WHOOP_CLIENT_SECRET'),
    scope: 'offline', // must be re-requested to keep receiving a refresh token
  });
  return postToken(body);
}

// ─── Authenticated data calls ─────────────────────────────────────────────────

async function authedGet(path: string, accessToken: string, query?: Record<string, string | number | undefined>): Promise<Response> {
  const url = new URL(`${API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new WhoopApiError(`WHOOP API request failed: GET ${path} (${res.status})`, res.status);
  }
  return res;
}

export async function getProfile(accessToken: string): Promise<WhoopProfile> {
  const res = await authedGet('/user/profile/basic', accessToken);
  return res.json() as Promise<WhoopProfile>;
}

export async function getBodyMeasurement(accessToken: string): Promise<WhoopBodyMeasurement> {
  const res = await authedGet('/user/measurement/body', accessToken);
  return res.json() as Promise<WhoopBodyMeasurement>;
}

/** Follows `next_token` up to MAX_PAGES (defensive cap — see plan §WHOOP API facts). */
async function getPaged<T>(path: string, accessToken: string, start: Date, end: Date): Promise<T[]> {
  const records: T[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await authedGet(path, accessToken, {
      limit: PAGE_LIMIT,
      start: start.toISOString(),
      end: end.toISOString(),
      nextToken,
    });
    const body = await res.json() as WhoopPagedResponse<T>;
    records.push(...(body.records ?? []));
    if (!body.next_token) break;
    nextToken = body.next_token;
  }
  return records;
}

export function getCycles(accessToken: string, start: Date, end: Date): Promise<WhoopCycle[]> {
  return getPaged<WhoopCycle>('/cycle', accessToken, start, end);
}

export function getRecoveries(accessToken: string, start: Date, end: Date): Promise<WhoopRecovery[]> {
  return getPaged<WhoopRecovery>('/recovery', accessToken, start, end);
}

export function getSleeps(accessToken: string, start: Date, end: Date): Promise<WhoopSleep[]> {
  return getPaged<WhoopSleep>('/activity/sleep', accessToken, start, end);
}

export function getWorkouts(accessToken: string, start: Date, end: Date): Promise<WhoopWorkout[]> {
  return getPaged<WhoopWorkout>('/activity/workout', accessToken, start, end);
}

// ─── Serialized token refresh (SELECT ... FOR UPDATE) ────────────────────────

export interface WhoopConnectionSnapshot {
  id: string;
  access_token: string;
  refresh_token: string;
  expires_at: Date;
  status: string;
}

export interface WhoopTokenStoreTx {
  /** Locks the connection row for the lifetime of the enclosing transaction. */
  lockConnection(connectionId: string): Promise<WhoopConnectionSnapshot | null>;
  saveTokens(connectionId: string, tokens: { access_token: string; refresh_token: string; expires_at: Date }): Promise<void>;
  markError(connectionId: string): Promise<void>;
}

export interface WhoopTokenStore {
  transaction<T>(fn: (tx: WhoopTokenStoreTx) => Promise<T>): Promise<T>;
}

/** Bundles a connection id with the store that can lock/update its row — the
 * single argument withValidToken() needs to serialize a refresh. */
export interface WhoopConnectionHandle {
  id: string;
  store: WhoopTokenStore;
}

// Minimal shape of the Drizzle chain this module uses, matching the style of
// lib/calendarIngestStore.ts (typed narrowly so a fake transaction object in
// tests doesn't need to satisfy the full drizzle-orm generic surface).
interface DrizzleWhoopTx {
  select(fields: Record<string, unknown>): {
    from(table: unknown): {
      where(predicate: unknown): {
        for(mode: 'update'): Promise<WhoopConnectionSnapshot[]>;
      };
    };
  };
  update(table: unknown): {
    set(values: Record<string, unknown>): {
      where(predicate: unknown): Promise<unknown>;
    };
  };
}

interface DrizzleWhoopDatabase {
  transaction<T>(fn: (tx: DrizzleWhoopTx) => Promise<T>): Promise<T>;
}

/**
 * Drizzle-backed WhoopTokenStore. Takes `database`/`schema` as plain
 * parameters (not imported here) so tests can pass a fake transaction and
 * assert on the exact lock/update calls without touching Postgres — same
 * pattern as lib/calendarIngestStore.ts's createCalendarIngestStore.
 */
export function createWhoopTokenStore(database: unknown, schema: typeof WhoopSchema): WhoopTokenStore {
  const db = database as DrizzleWhoopDatabase;
  return {
    transaction: (fn) => db.transaction(async (tx) => fn({
      async lockConnection(connectionId) {
        const rows = await tx.select({
          id: schema.whoop_connections.id,
          access_token: schema.whoop_connections.access_token,
          refresh_token: schema.whoop_connections.refresh_token,
          expires_at: schema.whoop_connections.expires_at,
          status: schema.whoop_connections.status,
        }).from(schema.whoop_connections).where(eq(schema.whoop_connections.id, connectionId)).for('update');
        return rows[0] ?? null;
      },
      async saveTokens(connectionId, tokens) {
        await tx.update(schema.whoop_connections).set({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
          status: 'active',
          updated_at: new Date(),
        }).where(eq(schema.whoop_connections.id, connectionId));
      },
      async markError(connectionId) {
        await tx.update(schema.whoop_connections).set({
          status: 'error',
          updated_at: new Date(),
        }).where(eq(schema.whoop_connections.id, connectionId));
      },
    })),
  };
}

/**
 * Runs `fn` with a valid (non-expired) WHOOP access token for `connection`.
 * Refreshing (when `expires_at` is within REFRESH_MARGIN_MS) happens inside a
 * `SELECT ... FOR UPDATE` transaction on the connection row: the row is
 * locked, re-checked, refreshed, and the new tokens are saved, all before the
 * lock releases — so two concurrent callers can never both present the same
 * (single-use) refresh token to WHOOP. `fn` itself runs after the transaction
 * commits, so the row isn't held locked for the duration of the data fetch.
 */
export async function withValidToken<T>(
  connection: WhoopConnectionHandle,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const accessToken = await connection.store.transaction(async (tx) => {
    const row = await tx.lockConnection(connection.id);
    if (!row) throw new Error(`WHOOP connection ${connection.id} not found`);
    if (row.status !== 'active') throw new WhoopConnectionInactiveError(connection.id, row.status);

    if (row.expires_at.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return row.access_token;
    }

    try {
      const tokens = await refreshTokens(row.refresh_token);
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
      await tx.saveTokens(connection.id, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
      });
      return tokens.access_token;
    } catch (err) {
      if (err instanceof WhoopTokenError && err.code === 'invalid_grant') {
        await tx.markError(connection.id);
      }
      throw err;
    }
  });

  return fn(accessToken);
}
