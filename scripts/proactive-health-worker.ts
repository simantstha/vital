import Anthropic from '@anthropic-ai/sdk';
import { ApnsClient } from '../lib/apnsClient';
import { parseCoachAnalysis, runClaimedAnalysis, type AnalysisContext, type AnalysisJob } from '../lib/proactiveHealthWorker';
import { claimAnalysisJobs, claimDueMorningBriefs, completeMorningBrief, workerRepository } from '../lib/proactiveHealthWorkerRepository';

const intervalMs = Number(process.env.PROACTIVE_WORKER_INTERVAL_MS ?? 15_000);
const anthropic = new Anthropic({ apiKey: required('ANTHROPIC_API_KEY') });
const apns = new ApnsClient({ keyId: required('APNS_KEY_ID'), teamId: required('APNS_TEAM_ID'), topic: required('APNS_TOPIC'), privateKey: required('APNS_PRIVATE_KEY').replace(/\\n/g, '\n') });

async function analyze(job: AnalysisJob, context: AnalysisContext): Promise<unknown> {
  const response = await anthropic.messages.create({
    model: process.env.PROACTIVE_ANALYSIS_MODEL ?? 'claude-sonnet-4-20250514', max_tokens: 700,
    system: 'You are Vital coach. Use only supplied values; never infer or invent a metric. Return JSON only with exactly headline, shortInsight, narrative, observations, nextSteps. Missing data must be described as unavailable. Keep medical claims observational, not diagnostic.',
    messages: [{ role: 'user', content: JSON.stringify({ kind: job.kind, date: job.localDate, input: job.input, availableContext: context }) }],
  });
  const text = response.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') throw new Error('analysis model returned no text');
  return parseCoachAnalysis(JSON.parse(text.text.replace(/^```json\s*|\s*```$/g, '')));
}

async function tick(): Promise<void> {
  const now = new Date();
  for (const job of await claimAnalysisJobs(now)) await runClaimedAnalysis(job, workerRepository, analyze, (device, result) => apns.send(device, result), now);
  for (const claim of await claimDueMorningBriefs(now)) {
    const job: AnalysisJob = { id: claim.idempotencyKey, kind: 'sleep', userId: claim.userId, localDate: claim.localDate, input: { purpose: 'morning brief' }, retryCount: 0 };
    try { const result = parseCoachAnalysis(await analyze(job, await workerRepository.getContext(job))); await completeMorningBrief(claim, result, (device, value) => apns.send(device, value), now); }
    catch { /* Slot remains claimed; a later operational repair can safely inspect it. */ }
  }
}

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
async function main(): Promise<void> { for (;;) { try { await tick(); } catch { /* Never emit health content or device tokens. */ } await new Promise((resolve) => setTimeout(resolve, intervalMs)); } }
void main();
