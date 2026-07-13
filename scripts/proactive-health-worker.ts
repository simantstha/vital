import Anthropic from '@anthropic-ai/sdk';
import { ApnsClient } from '../lib/apnsClient';
import { deliverNotification, parseCoachAnalysis, runClaimedAnalysis, validateGroundedAnalysis, type AnalysisContext, type AnalysisJob } from '../lib/proactiveHealthWorker';
import { claimAnalysisJobs, claimDueMorningBriefs, completeMorningBrief, ensureDefaultPreferencesForRegisteredUsers, failMorningBrief, listReadyNotificationCandidates, workerRepository } from '../lib/proactiveHealthWorkerRepository';
import { workerErrorEvent, type WorkerStage } from '../lib/proactiveHealthWorkerSupport';

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

async function tick(reportStage: (stage: WorkerStage) => void): Promise<void> {
  const now = new Date();
  reportStage('ensure-default-preferences');
  await ensureDefaultPreferencesForRegisteredUsers();

  reportStage('claim-analysis-jobs');
  const jobs = await claimAnalysisJobs(now);
  for (const job of jobs) {
    reportStage('process-analysis-job');
    await runClaimedAnalysis(job, workerRepository, analyze, (device, result) => apns.send(device, result, { type: `${job.kind}_analysis`, id: job.id, deepLink: `vital://${job.kind}-analysis/${job.id}` }), now);
  }

  reportStage('list-notification-candidates');
  const candidates = await listReadyNotificationCandidates(now);
  for (const candidate of candidates) {
    reportStage('deliver-notification');
    const token = await workerRepository.claimNotification(candidate.job, now);
    if (token) await deliverNotification(candidate.job, candidate.result, token, workerRepository, (device, result) => apns.send(device, result, { type: `${candidate.job.kind}_analysis`, id: candidate.job.id, deepLink: `vital://${candidate.job.kind}-analysis/${candidate.job.id}` }), now);
  }

  reportStage('claim-morning-briefs');
  const claims = await claimDueMorningBriefs(now);
  for (const claim of claims) {
    reportStage('process-morning-brief');
    const job: AnalysisJob = { id: claim.idempotencyKey, kind: 'sleep', userId: claim.userId, localDate: claim.localDate, input: { purpose: 'morning brief' }, retryCount: 0, notificationRetryCount: claim.retryCount, leaseToken: claim.leaseToken };
    try {
      const context = await workerRepository.getContext(job);
      const result = validateGroundedAnalysis(parseCoachAnalysis(await analyze(job, context)), { input: job.input, context });
      await completeMorningBrief(claim, result, (device, value) => apns.send(device, value, { type: 'morning_brief', deepLink: 'vital://today' }), now);
    } catch (error) {
      console.error(JSON.stringify(workerErrorEvent('process-morning-brief', error)));
      await failMorningBrief(claim, new Date());
    }
  }
}

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
async function main(): Promise<void> {
  for (;;) {
    let stage: WorkerStage = 'ensure-default-preferences';
    try {
      await tick((nextStage) => { stage = nextStage; });
    } catch (error) {
      console.error(JSON.stringify(workerErrorEvent(stage, error)));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
void main();
