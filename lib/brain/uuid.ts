/**
 * Shared guard for model-supplied ids that flow into Postgres `uuid`
 * columns. Coach tools receive ids from the model (an LLM), not from a
 * typed client — a hallucinated or truncated value ("last", a fact's own
 * text, a shortened id) passed straight into `eq(schema.foo.id, value)`
 * makes Postgres throw `invalid input syntax for type uuid` out of the
 * query itself, which nothing upstream was catching (see lib/brain/coach.ts
 * — `executeToolCall`/`handleMemoryToolCall` had no try/catch), aborting the
 * whole coach turn instead of returning a text error the model can recover
 * from.
 *
 * Every coach tool that takes an id destined for a `uuid` column MUST
 * validate it with this helper BEFORE running any query, and must not
 * silently fall back to a different record on a bad id.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
