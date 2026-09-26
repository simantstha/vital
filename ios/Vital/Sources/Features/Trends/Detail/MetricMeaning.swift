import Foundation

/// A small, pure rules engine for `MetricDetailView`'s "What it means today"
/// card — keyed by metric + this metric's own verdict + (optionally) a
/// related metric's verdict. Copy is deliberately cautious and non-medical:
/// it never diagnoses, never claims illness, and always reads as a
/// suggestion about today rather than a judgment about the user. `nil` hides
/// the card entirely — for any metric this table doesn't cover, and for
/// `.calibrating`/`.noData` verdicts (nothing meaningful to say yet).
enum MetricMeaning {
    /// - Parameters:
    ///   - metricKey: the raw `daily_metrics` key of the screen being viewed.
    ///   - verdict: this metric's own gated verdict (`TrendsVerdict.evaluate`).
    ///   - relatedVerdict: the paired metric's verdict, when its series has
    ///     loaded. `nil` omits the "agrees"/"disagrees" clause rather than
    ///     guessing — see each branch's doc comment.
    static func message(metricKey: String, verdict: Verdict, relatedVerdict: Verdict?) -> String? {
        switch metricKey {
        case "hrv_sdnn", "whoop_hrv_rmssd":
            return hrvMessage(verdict: verdict, restingHRVerdict: relatedVerdict)
        case "resting_hr", "whoop_resting_hr":
            return restingHRMessage(verdict: verdict, hrvVerdict: relatedVerdict)
        case "sleep_minutes", "whoop_sleep_min":
            return sleepMessage(verdict: verdict)
        case "steps":
            return stepsMessage(verdict: verdict)
        default:
            return nil
        }
    }

    // MARK: - HRV

    private static func hrvMessage(verdict: Verdict, restingHRVerdict: Verdict?) -> String? {
        switch verdict {
        case .above:
            // Resting HR *below* its own normal (i.e. lower, which is the
            // "good" direction for RHR) corroborates HRV being up — a fuller
            // recovery picture. Any other resting HR reading, or one that
            // hasn't loaded, omits the corroboration clause rather than
            // guessing at agreement.
            if case .below? = restingHRVerdict {
                return "You're well recovered. A good day for your hardest session."
            }
            return "Your HRV is above your normal today — a sign of good recovery."
        case .below:
            return "Your body may still be recovering. Keep today easy and prioritise sleep."
        case .normal:
            return "Your HRV is right in your normal range today."
        case .calibrating, .noData:
            return nil
        }
    }

    // MARK: - Resting heart rate

    private static func restingHRMessage(verdict: Verdict, hrvVerdict: Verdict?) -> String? {
        switch verdict {
        case .below:
            if case .above? = hrvVerdict {
                return "A lower resting heart rate alongside higher HRV both point to good recovery today."
            }
            return "Your resting heart rate is lower than your normal today — often a sign of good recovery."
        case .above:
            return "Your resting heart rate is higher than your normal today. Consider an easier day and extra rest."
        case .normal:
            return "Your resting heart rate is right in your normal range today."
        case .calibrating, .noData:
            return nil
        }
    }

    // MARK: - Sleep

    private static func sleepMessage(verdict: Verdict) -> String? {
        switch verdict {
        case .above:
            return "You slept more than your normal last night — a good foundation for today."
        case .below:
            return "You slept less than your normal last night. An easier day, or an earlier night tonight, may help."
        case .normal:
            return "Last night's sleep was right in your normal range."
        case .calibrating, .noData:
            return nil
        }
    }

    // MARK: - Steps

    private static func stepsMessage(verdict: Verdict) -> String? {
        switch verdict {
        case .above:
            return "You're more active than your normal today — nice work."
        case .below:
            return "You're below your normal activity so far today. A short walk can help close the gap."
        case .normal:
            return "Today's activity is right in your normal range."
        case .calibrating, .noData:
            return nil
        }
    }
}
