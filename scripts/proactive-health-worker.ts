import Anthropic from '@anthropic-ai/sdk';
import { ApnsClient } from '../lib/apnsClient';
import { generateGroundedAnalysis, proactiveAnalysisModel, type AnalysisFailureEvent } from '../lib/proactiveAnalysisGeneration';
import { type GroundedAnalysisProof } from '../lib/proactiveAnalysisGrounding';
import { consumeMorningAnalysisProof, deliverNotification, runClaimedAnalysis, type AnalysisContext, type AnalysisJob } from '../lib/proactiveHealthWorker';
import { claimAnalysisJobs, claimDueMorningBriefs, completeMorningBrief, ensureDefaultPreferencesForRegisteredUsers, failMorningBrief, listReadyNotificationCandidates, workerRepository } from '../lib/proactiveHealthWorkerRepository';
import { analysisAlert, workerErrorEvent, type WorkerStage } from '../lib/proactiveHealthWorkerSupport';

const intervalMs = Number(process.env.PROACTIVE_WORKER_INTERVAL_MS ?? 15_000);
const anthropic = new Anthropic({ apiKey: required('ANTHROPIC_API_KEY') });
const apns = new ApnsClient({ keyId: required('APNS_KEY_ID'), teamId: required('APNS_TEAM_ID'), topic: required('APNS_TOPIC'), privateKey: required('APNS_PRIVATE_KEY').replace(/\\n/g, '\n') });

const reportAnalysisFailure = (event: AnalysisFailureEvent): void => {
  console.error(JSON.stringify(event));
};

async function analyze(job: AnalysisJob, context: AnalysisContext): Promise<GroundedAnalysisProof> {
  return generateGroundedAnalysis({
    source: { kind: job.kind, date: job.localDate, input: job.input, availableContext: context },
    generate: async (request) => {
      const response = await anthropic.messages.create({
        model: proactiveAnalysisModel(process.env),
        max_tokens: 1500,
        system: request.system,
        messages: [{ role: 'user', content: request.content }],
      });
      const textBlocks = response.content.filter((item) => item.type === 'text');
      if (textBlocks.length !== 1) throw new Error('analysis model returned no text');
      return textBlocks[0].text;
    },
    report: reportAnalysisFailure,
  });
}

async function tick(reportStage: (stage: WorkerStage) => void): Promise<void> {
  const now = new Date();
  reportStage('ensure-default-preferences');
  await ensureDefaultPreferencesForRegisteredUsers();

  reportStage('claim-analysis-jobs');
  const jobs = await claimAnalysisJobs(now);
  for (const job of jobs) {
    reportStage('process-analysis-job');
    await runClaimedAnalysis(job, workerRepository, analyze, (device) => apns.send(device, analysisAlert(job.kind, job.input), { type: `${job.kind}_analysis`, id: job.id, deepLink: `vital://${job.kind}-analysis/${job.id}` }), now);
  }

  reportStage('list-notification-candidates');
  const candidates = await listReadyNotificationCandidates(now);
  for (const candidate of candidates) {
    reportStage('deliver-notification');
    const token = await workerRepository.claimNotification(candidate.job, now);
    if (token) await deliverNotification(candidate.job, candidate.result, token, workerRepository, (device) => apns.send(device, analysisAlert(candidate.job.kind, candidate.job.input), { type: `${candidate.job.kind}_analysis`, id: candidate.job.id, deepLink: `vital://${candidate.job.kind}-analysis/${candidate.job.id}` }), now);
  }

  reportStage('claim-morning-briefs');
  const claims = await claimDueMorningBriefs(now);
  for (const claim of claims) {
    reportStage('process-morning-brief');
    const job: AnalysisJob = { id: claim.idempotencyKey, kind: 'sleep', userId: claim.userId, localDate: claim.localDate, input: { purpose: 'morning brief' }, retryCount: 0, notificationRetryCount: claim.retryCount, leaseToken: claim.leaseToken };
    try {
      const context = await workerRepository.getContext(job);
      const proof = await analyze(job, context);
      const result = consumeMorningAnalysisProof(proof, {
        kind: job.kind,
        date: job.localDate,
        input: job.input,
        availableContext: context,
      });
      await completeMorningBrief(claim, result, (device, value) => apns.send(device, { title: value.headline, body: value.shortInsight }, { type: 'morning_brief', deepLink: 'vital://today' }), now);
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
