/**
 * POST /api/tts
 *
 * Proxies a single sentence of text to ElevenLabs' text-to-speech streaming
 * endpoint and streams the resulting MP3 straight back to the client, so the
 * ElevenLabs API key never reaches the iOS app. Used by CoachSpeaker as the
 * primary voice for spoken coach replies, sentence by sentence; the app falls
 * back to the on-device AVSpeechSynthesizer on any non-200 response here.
 *
 * Request body (JSON):
 *   { text: string }   — a single sentence, capped at 2000 characters
 *
 * Response:
 *   200 audio/mpeg     — the MP3 bytes, streamed through unbuffered
 *   400                — missing/empty/too-long `text`
 *   401                — no authenticated session (see lib/auth)
 *   503                — ELEVENLABS_API_KEY is not configured
 *   502                — ElevenLabs returned a non-OK response
 *
 * Env vars:
 *   ELEVENLABS_API_KEY   — required; unset means the route always 503s so the
 *                          client falls back to the Apple voice.
 *   ELEVENLABS_VOICE_ID  — optional; defaults to "Rachel" (21m00Tcm4TlvDq8ikWAM).
 */

import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MAX_TEXT_LENGTH = 2000;
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel (ElevenLabs stock voice)

export async function POST(request: Request): Promise<Response> {
  try {
    getUserIdFromRequest(request);
  } catch (err) {
    return new Response(String(err), { status: 401 });
  }

  let body: { text?: unknown };
  try {
    body = await request.json() as { text?: unknown };
  } catch {
    return new Response('Invalid JSON body.', { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return new Response('"text" is required and must be a non-empty string.', { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return new Response(`"text" must be at most ${MAX_TEXT_LENGTH} characters.`, { status: 400 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return new Response('ElevenLabs TTS is not configured.', { status: 503 });
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_64`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
      }
    );
  } catch (err) {
    console.error('ElevenLabs TTS request failed:', err);
    return new Response('Failed to reach ElevenLabs.', { status: 502 });
  }

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => '');
    console.error(`ElevenLabs TTS returned ${upstream.status}: ${errorText}`);
    return new Response('ElevenLabs TTS request failed.', { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  });
}
