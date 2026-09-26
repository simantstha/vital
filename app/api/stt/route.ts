/**
 * POST /api/stt
 *
 * Proxies a recorded audio clip to ElevenLabs' Scribe speech-to-text
 * endpoint and returns the transcript, so the ElevenLabs API key never
 * reaches the iOS app. This is now the ONLY source of the sent transcript —
 * the iOS app no longer falls back to Apple's on-device transcript (see
 * `CoachVoiceController.beginTranscription()`), so every non-2xx/failure
 * response here must carry enough detail for the client to show a useful
 * diagnostic instead of silently degrading.
 *
 * Request body:
 *   raw audio bytes (Content-Type: audio/mp4), capped at 10 MB
 *
 * Response:
 *   200 { text: string }
 *   400                — missing/empty body
 *   401                — no authenticated session (see lib/auth)
 *   413                — body exceeds 10 MB
 *   503 { error: 'not_configured' }               — ELEVENLABS_API_KEY unset
 *   502 { error: 'fetch_failed' }                  — request to ElevenLabs threw
 *   502 { error: 'upstream', upstreamStatus, detail } — ElevenLabs returned non-OK
 *   502 { error: 'bad_json' }                      — ElevenLabs returned invalid JSON
 *
 * `detail` on the `upstream` error is ElevenLabs' own short reason
 * (`detail.status` or `detail.message` from its JSON error body, or a plain
 * string `detail`), truncated to 120 chars. The ElevenLabs API key itself is
 * never included in any response.
 *
 * Env vars:
 *   ELEVENLABS_API_KEY   — required; unset means the route always 503s.
 *                          Shared with /api/tts.
 */

import { getUserIdFromRequest } from '@/lib/auth';
import { ELEVENLABS_STT_URL, ELEVENLABS_STT_MODEL_ID } from '@/lib/elevenlabs';

export const dynamic = 'force-dynamic';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Pulls a short, human-readable reason out of ElevenLabs' error body, e.g.
 * `{"detail":{"status":"missing_permissions","message":"..."}}` or
 * `{"detail":"some string"}`. Falls back to `'unknown'` for a non-JSON or
 * unrecognized body — never throws, since this only ever runs against text
 * we've already decided to log and cannot control the shape of.
 */
function extractUpstreamDetail(rawText: string): string {
  if (!rawText) return 'unknown';
  try {
    const parsed = JSON.parse(rawText) as { detail?: unknown };
    const detail = parsed?.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (detail && typeof detail === 'object') {
      const d = detail as { status?: unknown; message?: unknown };
      if (typeof d.status === 'string' && d.status) return d.status;
      if (typeof d.message === 'string' && d.message) return d.message;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

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
    console.error(`/api/stt: audio body too large (bytes=${audio.byteLength})`);
    return new Response('Audio body must be at most 10 MB.', { status: 413 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error(`/api/stt: ELEVENLABS_API_KEY not configured (bytes=${audio.byteLength})`);
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mp4' }), 'audio.m4a');
  // scribe_v1 was deprecated and removed by ElevenLabs on 2026-07-09 — every
  // request against it now fails upstream, which is what silently degraded
  // every voice turn to the poor on-device Apple fallback. See lib/elevenlabs.ts.
  form.append('model_id', ELEVENLABS_STT_MODEL_ID);
  form.append('language_code', 'en');
  form.append('tag_audio_events', 'false');

  let upstream: Response;
  try {
    upstream = await fetch(ELEVENLABS_STT_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        // Don't set Content-Type manually — fetch derives the multipart
        // boundary from the FormData body.
      },
      body: form,
    });
  } catch (err) {
    console.error(`/api/stt: request to ElevenLabs failed (bytes=${audio.byteLength}):`, err);
    return Response.json({ error: 'fetch_failed' }, { status: 502 });
  }

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => '');
    console.error(`/api/stt: ElevenLabs returned ${upstream.status} (bytes=${audio.byteLength}): ${errorText}`);
    const detail = extractUpstreamDetail(errorText).slice(0, 120);
    return Response.json(
      { error: 'upstream', upstreamStatus: upstream.status, detail },
      { status: 502 }
    );
  }

  let result: { text?: unknown };
  try {
    result = await upstream.json() as { text?: unknown };
  } catch (err) {
    console.error(`/api/stt: ElevenLabs returned invalid JSON (bytes=${audio.byteLength}):`, err);
    return Response.json({ error: 'bad_json' }, { status: 502 });
  }

  const text = typeof result.text === 'string' ? result.text : '';
  // One line per successful request: byte length in, upstream status, and
  // transcript CHARACTER COUNT only — never the transcript text itself.
  console.log(`/api/stt: ok (bytes=${audio.byteLength}, upstreamStatus=${upstream.status}, transcriptChars=${text.length})`);
  return Response.json({ text });
}
