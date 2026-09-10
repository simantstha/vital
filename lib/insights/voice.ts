import { stripCompleteJsonFence } from '@/lib/proactiveAnalysisGrounding';
import type { CertifiedFinding } from './types';

export interface Nudge {
  signature: string;
  title: string;
  body: string;
  openingMessage: string;
}

export interface VoiceContext {
  goal: string | null;
  facts: string[];          // active ontology facts, already filtered to status = 'active'
  recentlySaid: string[];   // openings from recent nudges, so the coach doesn't repeat itself
}

const SYSTEM = `You are the user's coach, writing a short check-in notification.

You will be given a small list of findings that have ALREADY been established as
statistically real. Your job is to SELECT the single most useful one and say it
like a coach who knows this person.

Rules:
- Select one finding from the list. Do not invent a finding, and do not combine
  two findings into a claim neither supports.
- Never state a number that is not present in the finding you selected.
- The notification body is one or two sentences. Speak to the person, not about
  the data.
- If a finding is a broken training cadence, ask a real question rather than
  asserting why it happened. You do not know why.
- The openingMessage is what you will say first when they open the chat. It may
  be slightly longer, and it should invite an answer.

Respond with JSON only:
{"signature": "...", "title": "...", "body": "...", "openingMessage": "..."}`;

/**
 * Builds the request from certified findings only.
 *
 * The safety property is structural, not a matter of wording: the model never
 * receives a raw series, so it has nothing to pattern-match on. It is choosing
 * among established facts, which is a task it is good at.
 */
export function buildVoiceRequest(
  findings: CertifiedFinding[],
  context: VoiceContext,
): { system: string; content: string } {
  const lines: string[] = ['Established findings (select exactly one):', ''];

  for (const finding of findings) {
    const detail = Object.entries(finding.detail)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    lines.push(
      `- signature: ${finding.signature}`,
      `  what: ${finding.kind} on ${finding.metrics.join(' + ')}`,
      `  magnitude: ${finding.effectLabel}`,
      `  supporting: ${detail} (n=${finding.n})`,
      '',
    );
  }

  if (context.goal) lines.push(`The user's stated goal: ${context.goal}`, '');
  if (context.facts.length > 0) {
    lines.push('What you know about them:', ...context.facts.map((fact) => `- ${fact}`), '');
  }
  if (context.recentlySaid.length > 0) {
    lines.push('You recently said (do not repeat yourself):',
      ...context.recentlySaid.map((said) => `- ${said}`), '');
  }

  return { system: SYSTEM, content: lines.join('\n') };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parses the model's response and enforces that its chosen signature is one we
 * actually offered. A model that invents a finding gets discarded entirely —
 * the run then sends nothing, which is the correct outcome.
 */
export function parseNudge(raw: string, allowedSignatures: string[]): Nudge | null {
  // Strip a markdown fence before parsing. A model told "respond with JSON
  // only" still sometimes wraps its output in ```json ... ```, and this repo
  // already paid for that once — see stripCompleteJsonFence's use in
  // parseAnalysisText. Without it a fenced reply is indistinguishable from
  // malformed JSON, so the run silently sends nothing: safe, but it degrades
  // the whole feature to zero nudges while looking perfectly healthy.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCompleteJsonFence(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (!nonEmpty(record.signature) || !allowedSignatures.includes(record.signature)) return null;
  if (!nonEmpty(record.title) || !nonEmpty(record.body) || !nonEmpty(record.openingMessage)) return null;

  return {
    signature: record.signature,
    title: record.title.trim(),
    body: record.body.trim(),
    openingMessage: record.openingMessage.trim(),
  };
}
