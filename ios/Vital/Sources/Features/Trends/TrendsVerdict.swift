import Foundation

/// The gated, no-fabrication verdict for a single metric reading. `z` rides
/// inside `.above`/`.below` only for band sizing and tests — **σ is never
/// surfaced to UI copy** (the plan's explicit rule). Rendered copy is
/// "above your normal" / "in your normal range" / "N more days" / "not
/// enough variation yet", never a raw number derived from `z` or σ.
enum Verdict: Equatable {
    case noData
    case calibrating(daysRemaining: Int)
    case normal
    case above(z: Double)
    case below(z: Double)
}

/// Pure gating logic — no I/O, no `Date()`, every input injected so tests
/// can pin exact boundary values. Mirrors the `TrendsSummary` pattern: a
/// static namespace over a single pure function.
///
/// This is the fix for fabricated verdicts: a metric never gets an
/// "above"/"below" judgment unless there's enough calendar history AND
/// enough real variation (σ) to make that judgment meaningful. Six gates,
/// evaluated in this exact order, each a hard early return.
enum TrendsVerdict {
    static func evaluate(
        latest: Double?,
        established: Bool,
        dataDays: Int,
        mean30: Double?,
        sd30: Double?,
        minMeaningfulSD: Double
    ) -> Verdict {
        // 1. No usable reading — nothing to judge. Covers both a missing
        //    reading and a non-finite one (`.nan` / `±.infinity`): garbage
        //    in the latest sample is an ABSENT reading, not a calibration
        //    problem, so it reports `.noData` rather than `.calibrating`.
        //    Without the `isFinite` check a NaN sails through gates 2–5
        //    (none of which touch `latest`) and lands in gate 6, where
        //    `abs(.nan) < 1` is false and `.nan > 0` is false — telling the
        //    user "below your normal" on the strength of garbage.
        guard let latest, latest.isFinite else { return .noData }

        // 2. Not enough calendar history yet, regardless of what the
        //    (possibly stale) `established` snapshot claims.
        guard established, dataDays >= 14 else {
            return .calibrating(daysRemaining: max(0, 14 - dataDays))
        }

        // 3. No baseline stats to compare against.
        guard let mean30, let sd30 else { return .calibrating(daysRemaining: 0) }

        // 4. The baseline stats themselves must be usable numbers: a
        //    degenerate spread (zero, negative, NaN, or infinite) isn't a
        //    usable σ — `stddev_samp` of a single row, or a data glitch —
        //    and a non-finite `mean30` leaves no reference to compare
        //    against. Unlike gate 1, a broken baseline IS a calibration
        //    problem: the reading is fine, the reference isn't.
        //
        //    `mean30.isFinite` is checked EXPLICITLY here and must stay
        //    that way. It is tempting to assume gate 5's arithmetic already
        //    swallows a bad mean, but that only holds for infinity: Swift's
        //    free `max(_:_:)` is `y >= x ? y : x`, and `.nan >= minMeaningfulSD`
        //    is false, so `max(1.0, 0.02 * abs(.nan))` returns 1.0 — NOT
        //    NaN — letting a NaN `mean30` clear gate 5 and fabricate a
        //    `.below(z: .nan)` verdict in gate 6.
        guard mean30.isFinite, sd30.isFinite, sd30 > 0 else {
            return .calibrating(daysRemaining: 0)
        }

        // 5. σ too small to mean anything, relative to the metric's own
        //    noise floor or to the mean itself. A smart scale reading
        //    70.0kg every morning has σ ≈ 0.05 — without this gate, a
        //    0.3kg day-to-day wobble would read as "+6σ, far above normal".
        guard sd30 >= max(minMeaningfulSD, 0.02 * abs(mean30)) else {
            return .calibrating(daysRemaining: 0)
        }

        // 6. z-score against the 30-day mean — never `mean7`, which
        //    overlaps the visible window and would compare the last week
        //    against itself.
        let z = (latest - mean30) / sd30
        if abs(z) < 1 { return .normal }
        return z > 0 ? .above(z: z) : .below(z: z)
    }
}
