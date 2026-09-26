/**
 * Vendor health probes for GET /api/health/vendors.
 *
 * Every probe hits the SAME endpoint + model id production actually calls
 * (imported, never re-typed) — see the postmortem this exists for: ElevenLabs
 * removed the `scribe_v1` STT model on 2026-07-09 and every transcription
 * call failed silently for ~2.5 months because nothing exercised that exact
 * model id in isolation.
 *
 * Each probe is deliberately tiny and cheap (max_tokens: 5, a ~0.5s audio
 * fixture, a two-word nutrition query) and runs with an 8s timeout so one
 * slow upstream can't hang the whole check.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { client as anthropicClient } from '@/lib/brain/anthropicClient';
import { CLAUDE_SONNET_MODEL, CLAUDE_HAIKU_MODEL } from '@/lib/aiModels';
import {
  ELEVENLABS_STT_URL,
  ELEVENLABS_STT_MODEL_ID,
  ELEVENLABS_TTS_MODEL_ID,
  resolveElevenLabsVoiceId,
  elevenLabsTtsUrl,
} from '@/lib/elevenlabs';
import { CALORIENINJAS_URL } from '@/lib/nutritionix';
import { USDA_SEARCH_URL } from '@/lib/nutrition/usda';

const PROBE_TIMEOUT_MS = 8000;

export interface VendorCheckResult {
  name: string;
  ok: boolean;
  status: number | null;
  ms: number;
  /** Short upstream reason, never a secret. Present only when ok is false (or noteworthy). */
  detail?: string;
}

/** Truncates an upstream error body/message to a short, log-safe reason. */
function shortDetail(value: unknown, max = 160): string {
  const s = typeof value === 'string' ? value : String(value);
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Runs one probe with timing + a hard timeout, normalizing any thrown error
 * (including an AbortError from the timeout) into a failing VendorCheckResult
 * rather than letting it propagate — one vendor's outage must never break the
 * others, since every probe runs in parallel via Promise.all.
 */
async function runProbe(
  name: string,
  fn: (signal: AbortSignal) => Promise<{ status: number | null; ok: boolean; detail?: string }>,
): Promise<VendorCheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const result = await fn(controller.signal);
    return { name, ok: result.ok, status: result.status, ms: Date.now() - start, detail: result.detail };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      name,
      ok: false,
      status: null,
      ms: Date.now() - start,
      detail: isAbort ? 'timeout' : shortDetail(err instanceof Error ? err.message : err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function probeAnthropicModel(model: string): () => Promise<VendorCheckResult> {
  return () =>
    runProbe(`anthropic:${model}`, async () => {
      try {
        await anthropicClient.messages.create(
          {
            model,
            max_tokens: 5,
            messages: [{ role: 'user', content: 'hi' }],
          },
          { timeout: PROBE_TIMEOUT_MS },
        );
        return { ok: true, status: 200 };
      } catch (err) {
        const status = (err as { status?: number }).status ?? null;
        const message = (err as { message?: string }).message ?? String(err);
        return { ok: false, status, detail: shortDetail(message) };
      }
    });
}

async function probeElevenLabsStt(): Promise<VendorCheckResult> {
  return runProbe('elevenlabs:stt', async (signal) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return { ok: false, status: null, detail: 'not_configured' };

    // Read synchronously (a few KB, once per invocation): keeps this probe's
    // control flow entirely inside runProbe's fetch-and-timeout race, with no
    // extra async gap where the fixture read could straggle behind a fast
    // fake-timer advance in tests.
    const fixturePath = path.join(process.cwd(), 'lib/health/fixtures/silence.wav');
    const audio = readFileSync(fixturePath);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'silence.wav');
    form.append('model_id', ELEVENLABS_STT_MODEL_ID);
    form.append('language_code', 'en');
    form.append('tag_audio_events', 'false');

    const res = await fetch(ELEVENLABS_STT_URL, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, detail: shortDetail(text || res.statusText) };
    }
    // A 200 is success even with empty transcript text — this fixture is silent.
    return { ok: true, status: res.status };
  });
}

async function probeElevenLabsTts(): Promise<VendorCheckResult> {
  return runProbe('elevenlabs:tts', async (signal) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return { ok: false, status: null, detail: 'not_configured' };

    const voiceId = resolveElevenLabsVoiceId();
    const res = await fetch(elevenLabsTtsUrl(voiceId), {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ok', model_id: ELEVENLABS_TTS_MODEL_ID }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, detail: shortDetail(text || res.statusText) };
    }
    // Read the bytes (don't just check headers) but don't stream/buffer the
    // whole thing beyond confirming it's non-empty.
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) {
      return { ok: false, status: res.status, detail: 'empty_response' };
    }
    return { ok: true, status: res.status };
  });
}

async function probeCalorieNinjas(): Promise<VendorCheckResult> {
  return runProbe('nutrition:calorieninjas', async (signal) => {
    const apiKey = process.env.CALORIENINJAS_API_KEY;
    if (!apiKey) return { ok: false, status: null, detail: 'not_configured' };

    const res = await fetch(`${CALORIENINJAS_URL}?query=${encodeURIComponent('apple')}`, {
      headers: { 'X-Api-Key': apiKey },
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, detail: shortDetail(text || res.statusText) };
    }
    return { ok: true, status: res.status };
  });
}

async function probeUsda(): Promise<VendorCheckResult> {
  return runProbe('nutrition:usda', async (signal) => {
    const apiKey = process.env.USDA_FDC_API_KEY;
    if (!apiKey) return { ok: false, status: null, detail: 'not_configured' };

    const res = await fetch(`${USDA_SEARCH_URL}?api_key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'apple', dataType: ['Foundation'], pageSize: 1 }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, detail: shortDetail(text || res.statusText) };
    }
    return { ok: true, status: res.status };
  });
}

export interface VendorHealthReport {
  ok: boolean;
  checks: VendorCheckResult[];
}

export async function runVendorHealthChecks(): Promise<VendorHealthReport> {
  const checks = await Promise.all([
    probeAnthropicModel(CLAUDE_SONNET_MODEL)(),
    probeAnthropicModel(CLAUDE_HAIKU_MODEL)(),
    probeElevenLabsStt(),
    probeElevenLabsTts(),
    probeCalorieNinjas(),
    probeUsda(),
  ]);

  return { ok: checks.every((c) => c.ok), checks };
}
