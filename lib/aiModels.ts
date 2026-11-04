import type { ThinkingConfigParam } from '@anthropic-ai/sdk/resources/messages';

/**
 * Single source of truth for the Anthropic model ids this app calls in
 * production. Every route/lib that makes a `messages.create` call imports
 * from here instead of hard-coding the model string, so:
 *   1. a model swap (e.g. the Sonnet 5 -> Sonnet 5.5 migration) is one edit, and
 *   2. `GET /api/health/vendors` (lib/health/vendors.ts) probes the SAME ids
 *      production actually calls, rather than a hand-copied duplicate that can
 *      silently drift out of sync with what's really in use.
 */

/** Used for context-heavy calls: daily brief, coach chat, meal estimation. */
export const CLAUDE_SONNET_MODEL = 'claude-sonnet-5-5';

/** Used for small, latency-sensitive calls: opener, meal log/recipe/modify. */
export const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5';

/**
 * The "no visible thinking" config for `model`. Sonnet 5.5 rejects
 * `{type:'disabled'}` with a 400 and accepts `between_tools` only; every other
 * model (Sonnet 5, 4.6, ...) only accepts `disabled`. Models can come from env
 * overrides, so this is per-model rather than a constant.
 */
export function thinkingOffFor(model: string): ThinkingConfigParam {
  // Cast: SDK 0.95.1's ThinkingConfigParam predates `between_tools`.
  return (model === 'claude-sonnet-5-5' ? { type: 'between_tools' } : { type: 'disabled' }) as ThinkingConfigParam;
}
