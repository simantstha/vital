/**
 * Vital Brain — coach loop
 *
 * runCoach(userId, userMessage, imageBase64?, mode?) is an async generator that:
 *   1. Persists the user message to Postgres
 *   2. Assembles context deterministically from Postgres
 *   3. Runs the Claude streaming tool-use loop (multi-turn, server-side)
 *   4. Yields text deltas as { type: 'text', text: string }
 *   5. Yields { type: 'tool_call', id, name, label, status } around every tool
 *      execution (memory tools + the daily_metrics/baselines data tools in
 *      tools.ts) so the client can render a live "checking your..." indicator
 *   6. Persists the completed assistant message
 *   7. Yields { type: 'done', messageId: string } as the final event
 *
 * The caller (app/api/coach/route.ts) turns these events into SSE lines.
 */

import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { db, schema } from '@/db';
import { assembleContext } from './context';
import { assemblePersona } from './persona';
import { BRAIN_TOOLS, executeToolCall, toolCallLabel } from './tools';
import { buildCoachViz, type CoachViz } from './coachViz';
import { MEMORY_TOOLS, handleToolCall as handleMemoryToolCall } from '@/lib/memory';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL        = 'claude-sonnet-4-6';
const MAX_TOKENS   = 2500;
const MAX_ROUNDS   = 10;   // max tool-use iterations before hard stop

// Tool names dispatched to lib/memory.ts's handleToolCall instead of
// tools.ts's executeToolCall. Only registered/routed in onboarding mode
// (see runCoach's `mode` param) — regular coaching keeps the existing
// BRAIN_TOOLS-only surface unchanged.
const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map(t => t.name));

// ── Yield types ───────────────────────────────────────────────────────────────

export type CoachEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; label: string; status: 'started' | 'done' }
  | { type: 'tool_data'; id: string; viz: CoachViz }
  | { type: 'done'; messageId: string };

// ── Main export ───────────────────────────────────────────────────────────────

export async function* runCoach(
  userId: string,
  userMessage: string,
  imageBase64?: string,
  mode?: 'onboarding',
): AsyncGenerator<CoachEvent> {
  const isOnboarding = mode === 'onboarding';
  // 1. Persist the user message ──────────────────────────────────────────────
  await db.insert(schema.messages).values({
    user_id:   userId,
    timestamp: new Date(),
    role:      'user',
    speaker:   'user',
    content:   userMessage,
    images:    imageBase64 ? [imageBase64] : null,
    sources:   [],
  });

  // 2. Assemble context from Postgres (deterministic) ────────────────────────
  const ctx = await assembleContext(userId);

  // 3. Build persona and tool list ───────────────────────────────────────────
  const systemPrompt = assemblePersona(
    ctx.hardConstraints,
    undefined,
    isOnboarding,
    ctx.calibration,
  );
  const tools = isOnboarding ? [...BRAIN_TOOLS, ...MEMORY_TOOLS] : BRAIN_TOOLS;

  // 4. Build the initial user message content ───────────────────────────────
  type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } };

  const initialContent: ContentBlock[] = [
    { type: 'text', text: ctx.promptText },
  ];

  if (imageBase64) {
    initialContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
    });
  }

  initialContent.push({
    type: 'text',
    text: `\n\n---\n\nUser: ${userMessage}`,
  });

  const messages: MessageParam[] = [
    { role: 'user', content: initialContent },
  ];

  // 5. Multi-turn streaming tool loop ───────────────────────────────────────
  let assistantText     = '';
  const toolCallLog: unknown[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Stream this turn — yields text deltas immediately
    const stream = client.messages.stream({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      tools,
      messages,
    });

    // Yield text deltas as they arrive
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        const chunk = event.delta.text;
        assistantText += chunk;
        yield { type: 'text', text: chunk };
      }
    }

    // Inspect the completed message
    const finalMsg = await stream.finalMessage();

    if (finalMsg.stop_reason !== 'tool_use') {
      // Reconstruct complete text from all content blocks (streaming may have
      // missed the last chunk if finalMessage was buffered differently)
      const textFromBlocks = finalMsg.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('');
      if (textFromBlocks.length > assistantText.length) {
        // Emit any remainder that didn't arrive via streaming deltas
        const remainder = textFromBlocks.slice(assistantText.length);
        if (remainder) {
          assistantText = textFromBlocks;
          yield { type: 'text', text: remainder };
        }
      }
      break; // No tool calls — we're done.
    }

    // Tool use: push assistant turn and execute all tool calls ────────────────
    messages.push({ role: 'assistant', content: finalMsg.content });

    const toolBlocks = finalMsg.content.filter(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );

    // Sequential (not Promise.all) so each tool's started/done SSE pair
    // brackets its own execution — the iOS chat UI renders these live.
    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const block of toolBlocks) {
      const input = block.input as Record<string, unknown>;
      const callId = randomUUID();
      const label  = toolCallLabel(block.name, input);

      toolCallLog.push({ name: block.name, input });
      yield { type: 'tool_call', id: callId, name: block.name, label, status: 'started' };

      const result = MEMORY_TOOL_NAMES.has(block.name)
        ? handleMemoryToolCall(userId, block.name, input)
        : await executeToolCall(block.name, input, userId);

      yield { type: 'tool_call', id: callId, name: block.name, label, status: 'done' };

      // For the chartable data tools, also surface the structured result so the
      // client can render an inline mini-chart / stat card (falls back to the
      // text chip above when there's no data). Same callId ties it to the row.
      try {
        const viz = buildCoachViz(block.name, JSON.parse(result));
        if (viz) yield { type: 'tool_data', id: callId, viz };
      } catch {
        // result wasn't JSON (or not chartable) — no viz, just the chip.
      }

      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
    // Reset accumulated text — the next turn is the new response
    assistantText = '';
  }

  // 6. Persist completed assistant message ───────────────────────────────────
  const [saved] = await db
    .insert(schema.messages)
    .values({
      user_id:    userId,
      timestamp:  new Date(),
      role:       'assistant',
      speaker:    'coach',
      content:    assistantText,
      tool_calls: toolCallLog.length > 0 ? toolCallLog : null,
      sources:    [],    // citation seam — populated in v2
      metadata:   null,  // structured insights seam — populated in v2
    })
    .returning({ id: schema.messages.id });

  yield { type: 'done', messageId: saved.id };
}
