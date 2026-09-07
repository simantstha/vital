import type { CertifiedFinding, Finding } from './types';

function previousDay(localDay: string): string {
  const [y, m, d] = localDay.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Keeps only findings that also survived yesterday's run.
 *
 * Running the battery daily is repeated testing: the within-run FDR correction
 * says nothing about a borderline finding eventually surfacing across many
 * days. Requiring two consecutive runs collapses that — noise rarely repeats,
 * real effects persist. The cost is one day of latency on every nudge.
 */
export function confirmAgainstPreviousRun(
  findings: Finding[],
  previousSignatures: Set<string>,
): CertifiedFinding[] {
  return findings
    .filter((finding) => previousSignatures.has(finding.signature))
    .map((finding) => ({ ...finding, confirmedOnRuns: 2 }));
}

/** Signatures this user's battery produced on the previous local day. */
export async function previousRunSignatures(userId: string, localDay: string): Promise<Set<string>> {
  const { db, schema } = await import('@/db');
  const { and, eq } = await import('drizzle-orm');

  const rows = await db
    .select({ signature: schema.insight_findings.signature })
    .from(schema.insight_findings)
    .where(and(
      eq(schema.insight_findings.user_id, userId),
      eq(schema.insight_findings.computed_for, previousDay(localDay)),
    ));
  return new Set(rows.map((row) => row.signature));
}

/**
 * Records every gate-surviving finding for this run, whether or not it is ever
 * spoken aloud — tomorrow's confirmation depends on the ones we stayed quiet
 * about. Idempotent per (user, signature, day) so a worker retry is safe.
 */
export async function recordFindings(
  userId: string,
  localDay: string,
  findings: Finding[],
): Promise<void> {
  if (findings.length === 0) return;
  const { db, schema } = await import('@/db');

  await db
    .insert(schema.insight_findings)
    .values(findings.map((finding) => ({
      user_id: userId,
      signature: finding.signature,
      kind: finding.kind,
      computed_for: localDay,
      payload: {
        effect: finding.effect,
        effectLabel: finding.effectLabel,
        n: finding.n,
        pValue: finding.pValue,
        metrics: finding.metrics,
        detail: finding.detail,
      },
    })))
    .onConflictDoNothing();
}
