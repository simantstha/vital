import type { CoachEvent } from '@/lib/brain/coach';
import { parseSpecialistActionRequest, type SpecialistActionRequest } from './api';
import type { CoachRestoration } from './restoration';

interface CoachHttpDependencies {
  enabled(): boolean;
  authenticate(request: Request): string;
  runCoach(
    userId: string,
    message: string,
    imageBase64?: string,
    mode?: 'onboarding',
  ): AsyncGenerator<CoachEvent>;
  runAction(userId: string, action: SpecialistActionRequest): AsyncGenerator<CoachEvent>;
  restore(userId: string): Promise<CoachRestoration>;
}

function authentication(request: Request, dependencies: CoachHttpDependencies): string | Response {
  try {
    return dependencies.authenticate(request);
  } catch (error) {
    return new Response(String(error), { status: 401 });
  }
}

function streamEvents(generator: AsyncGenerator<CoachEvent>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        for await (const chunk of generator) {
          switch (chunk.type) {
            case 'text':
              send({ type: 'text', delta: chunk.text });
              break;
            case 'tool_call':
              send({
                type: chunk.type,
                id: chunk.id,
                name: chunk.name,
                label: chunk.label,
                status: chunk.status,
              });
              break;
            case 'tool_data':
              send({ type: chunk.type, id: chunk.id, viz: chunk.viz });
              break;
            case 'done':
              send({ type: chunk.type, messageId: chunk.messageId });
              break;
            case 'handoff_card':
            case 'persona_changed':
              send({ ...chunk });
              break;
          }
        }
      } catch (error) {
        send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export function createCoachHttpHandlers(dependencies: CoachHttpDependencies) {
  return {
    async GET(request: Request): Promise<Response> {
      const userId = authentication(request, dependencies);
      if (userId instanceof Response) return userId;
      if (!dependencies.enabled()) {
        return new Response('Specialists are not enabled.', { status: 404 });
      }
      try {
        return Response.json(await dependencies.restore(userId));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    },

    async POST(request: Request): Promise<Response> {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return new Response('Invalid JSON body.', { status: 400 });
      }

      const userId = authentication(request, dependencies);
      if (userId instanceof Response) return userId;

      // A valid legacy message always wins, even if newer clients attach
      // unrelated fields named action/sessionId as metadata.
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (message) {
        const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : undefined;
        const mode = body.mode === 'onboarding' ? 'onboarding' as const : undefined;
        return streamEvents(dependencies.runCoach(userId, message, imageBase64, mode));
      }

      let action: SpecialistActionRequest | null;
      if (dependencies.enabled()) {
        try {
          action = parseSpecialistActionRequest(body);
        } catch (error) {
          return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
        }
      } else {
        action = null;
      }
      if (action) {
        return streamEvents(dependencies.runAction(userId, action));
      }

      return new Response('"message" is required and must be a non-empty string.', { status: 400 });
    },
  };
}
