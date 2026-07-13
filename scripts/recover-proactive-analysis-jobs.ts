import {
  formatRecoveryCounts,
  parseRecoveryIds,
  recoverProactiveAnalysisJobs,
  type RecoveryCounts,
} from '../lib/proactiveAnalysisRecovery';
import { createProactiveAnalysisRecoveryStore } from '../lib/proactiveAnalysisRecoveryDrizzle';

const emptyCounts = (): RecoveryCounts => ({
  requestedCount: 0,
  matchedCount: 0,
  eligibleCount: 0,
  workoutUpdatedCount: 0,
  sleepUpdatedCount: 0,
  totalUpdatedCount: 0,
});

async function main(argv: string[]): Promise<void> {
  const ids = parseRecoveryIds(argv);
  const { db, schema } = await import('@/db');
  const store = createProactiveAnalysisRecoveryStore(db, schema);

  const counts = await recoverProactiveAnalysisJobs(store, ids, new Date());
  console.log(formatRecoveryCounts(counts, true));
}

void main(process.argv.slice(2)).then(
  () => { process.exitCode = 0; },
  () => {
    console.log(formatRecoveryCounts(emptyCounts(), false));
    process.exitCode = 1;
  },
);
