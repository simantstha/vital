/**
 * POST /api/stt
 *
 * Proxies a recorded audio clip to ElevenLabs' Scribe speech-to-text
 * endpoint and returns the transcript, so the ElevenLabs API key never
 * reaches the iOS app. Used as the accurate cloud transcript that replaces
 * Apple's on-device live-preview transcript once voice input stops; the app
 * falls back to the Apple transcript on any non-200 response here.
 *
 * Request body:
 *   raw audio bytes (Content-Type: audio/mp4), capped at 10 MB
 *
 * Response:
 *   200 { text: string }
 *   400                — missing/empty body
 *   401                — no authenticated session (see lib/auth)
 *   413                — body exceeds 10 MB
 *   503                — ELEVENLABS_API_KEY is not configured
 *   502                — ElevenLabs returned a non-OK response
 *
 * Env vars:
 *   ELEVENLABS_API_KEY   — required; unset means the route always 503s so the
 *                          client falls back to the Apple transcript. Shared
 *                          with /api/tts.
 */

import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(request: Request): Promise<Response> {
  try {
    getUserIdFromRequest(request);
  } catch (err) {
    return new Response(String(err), { status: 401 });
  }

  let audio: ArrayBuffer;
  try {
    audio = await request.arrayBuffer();
  } catch {
    return new Response('Could not read audio body.', { status: 400 });
  }

  if (audio.byteLength === 0) {
    return new Response('Audio body is required and must be non-empty.', { status: 400 });
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return new Response('Audio body must be at most 10 MB.', { status: 413 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return new Response('ElevenLabs STT is not configured.', { status: 503 });
  }

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mp4' }), 'audio.m4a');
  form.append('model_id', 'scribe_v1');
  form.append('language_code', 'en');
  form.append('tag_audio_events', 'false');

  let upstream: Response;
  try {
    upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        // Don't set Content-Type manually — fetch derives the multipart
        // boundary from the FormData body.
      },
      body: form,
    });
  } catch (err) {
    console.error('ElevenLabs STT request failed:', err);
    return new Response('Failed to reach ElevenLabs.', { status: 502 });
  }

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => '');
    console.error(`ElevenLabs STT returned ${upstream.status}: ${errorText}`);
    return new Response('ElevenLabs STT request failed.', { status: 502 });
  }

  let result: { text?: unknown };
  try {
    result = await upstream.json() as { text?: unknown };
  } catch (err) {
    console.error('ElevenLabs STT returned invalid JSON:', err);
    return new Response('ElevenLabs STT request failed.', { status: 502 });
  }

  const text = typeof result.text === 'string' ? result.text : '';
  return Response.json({ text });
}
