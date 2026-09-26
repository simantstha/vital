/**
 * Shared ElevenLabs endpoint/model constants.
 *
 * Kept here (rather than inlined in app/api/stt/route.ts and
 * app/api/tts/route.ts) so GET /api/health/vendors (lib/health/vendors.ts)
 * can probe the SAME endpoint + model id production actually calls, instead
 * of a hand-copied string that can silently drift (this is exactly how the
 * scribe_v1 removal on 2026-07-09 went unnoticed for ~2.5 months).
 */

export const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

// scribe_v1 was deprecated and removed by ElevenLabs on 2026-07-09 — scribe_v2
// is the current non-realtime transcription model.
// https://elevenlabs.io/docs/changelog/2026/6/8
// https://elevenlabs.io/docs/api-reference/speech-to-text/convert
export const ELEVENLABS_STT_MODEL_ID = 'scribe_v2';

export const ELEVENLABS_TTS_MODEL_ID = 'eleven_flash_v2_5';

export const ELEVENLABS_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel (ElevenLabs stock voice)

export function elevenLabsTtsUrl(voiceId: string): string {
  return `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_64`;
}

/** ELEVENLABS_VOICE_ID env override, or the default stock voice. */
export function resolveElevenLabsVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID || ELEVENLABS_DEFAULT_VOICE_ID;
}
