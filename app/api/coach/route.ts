/**
 * POST /api/coach
 *
 * Streams a coached reply as Server-Sent Events (SSE).
 *
 * Request body (JSON):
 *   { message: string, imageBase64?: string, mode?: "onboarding" }
 *
 * `mode: "onboarding"` switches the persona into onboarding mode (greet the
 * new user, ask at most 3 short questions, persist answers via the memory
 * tools, no training/nutrition advice yet) — see lib/brain/persona.ts and
 * lib/brain/coach.ts. The SSE contract below is identical in both modes.
 *
 * SSE event contract:
 *   data: {"type":"text","delta":"..."}       — one or more text chunks
 *   data: {"type":"tool_call","id":"...","name":"...","label":"...",
 *          "status":"started"}                — a tool started executing;
 *                                                `id` is unique per call
 *   data: {"type":"tool_call","id":"...","name":"...","label":"...",
 *          "status":"done"}                    — same `id` as its "started"
 *                                                event, once the tool finishes
 *   data: {"type":"done","messageId":"..."}   — final event; messageId is the
 *                                               UUID of the persisted assistant
 *                                               message row in `messages`.
 *   data: {"type":"error","error":"..."}      — only on unhandled exceptions
 *
 * Each line is followed by a blank line (\n\n) per SSE spec.
 * The connection closes after "done" or "error".
 */

import { getUserIdFromRequest } from '@/lib/auth';
import { runCoach } from '@/lib/brain/coach';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // Parse body
  let body: { message?: unknown; imageBase64?: unknown; mode?: unknown };
  try {
    body = await request.json() as { message?: unknown; imageBase64?: unknown; mode?: unknown };
  } catch {
    return new Response('Invalid JSON body.', { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return new Response('"message" is required and must be a non-empty string.', { status: 400 });
  }

  const imageBase64 =
    typeof body.imageBase64 === 'string' ? body.imageBase64 : undefined;

  const mode = body.mode === 'onboarding' ? 'onboarding' as const : undefined;

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return new Response(String(err), { status: 401 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const chunk of runCoach(userId, message, imageBase64, mode)) {
          if (chunk.type === 'text') {
            send({ type: 'text', delta: chunk.text });
          } else if (chunk.type === 'tool_call') {
            send({
              type:   'tool_call',
              id:     chunk.id,
              name:   chunk.name,
              label:  chunk.label,
              status: chunk.status,
            });
          } else if (chunk.type === 'done') {
            send({ type: 'done', messageId: chunk.messageId });
          }
        }
      } catch (err) {
        send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',  // disable Nginx proxy buffering
    },
  });
}
