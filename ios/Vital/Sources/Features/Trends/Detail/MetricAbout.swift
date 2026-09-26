import Foundation

/// Static, factual "About <metric>" copy for the detail view's bottom
/// section, keyed by `MetricCatalog` key. Plain-language, conservative, never
/// a medical claim — and every entry names its measurement source so "How
/// it's measured" is never vague. A metric with no entry here hides the
/// section entirely (the view gates on `MetricAbout.copy(for:)` returning
/// non-nil), rather than showing a generic placeholder.
enum MetricAbout {
    struct Copy {
        /// 2–3 plain-language sentences about what the metric reflects.
        let body: String
        /// "How it's measured" disclosure — names the concrete source.
        let measurement: String
    }

    static func copy(for metricKey: String) -> Copy? {
        table[metricKey]
    }

    private static let table: [String: Copy] = [
        "hrv_sdnn": Copy(
            body: "Heart rate variability (HRV) is the natural variation in time between heartbeats. It shifts with sleep, stress, training load, and recovery, and it varies a lot from person to person — the number to watch is how yours moves against your own normal, not anyone else's.",
            measurement: "Apple Watch overnight SDNN, read from Apple Health."
        ),
        "whoop_hrv_rmssd": Copy(
            body: "Heart rate variability (HRV) is the natural variation in time between heartbeats. It shifts with sleep, stress, training load, and recovery, and it varies a lot from person to person — compare it to your own normal, not to anyone else's.",
            measurement: "WHOOP overnight RMSSD, synced from your WHOOP account."
        ),
        "resting_hr": Copy(
            body: "Resting heart rate is how many times your heart beats per minute at rest, usually measured overnight. It tends to fall with better cardiovascular fitness and rise with poor sleep, illness, or heavy training load.",
            measurement: "Apple Watch overnight resting heart rate, read from Apple Health."
        ),
        "whoop_resting_hr": Copy(
            body: "Resting heart rate is how many times your heart beats per minute at rest, usually measured overnight. It tends to fall with better cardiovascular fitness and rise with poor sleep, illness, or heavy training load.",
            measurement: "WHOOP overnight resting heart rate, synced from your WHOOP account."
        ),
        "sleep_minutes": Copy(
            body: "Total time asleep, not just time in bed. Consistency night to night matters as much as the total — compare your recent nights to your own normal rather than a fixed target.",
            measurement: "Apple Watch/Health sleep sessions, read from Apple Health."
        ),
        "whoop_sleep_min": Copy(
            body: "Total time asleep, not just time in bed. Consistency night to night matters as much as the total — compare your recent nights to your own normal rather than a fixed target.",
            measurement: "WHOOP sleep tracking, synced from your WHOOP account."
        ),
        "steps": Copy(
            body: "Steps are a simple proxy for how much you moved today. They don't capture intensity, so a low step count on a heavy training day isn't necessarily a low-activity day.",
            measurement: "Apple Health step count, aggregated from your iPhone and Apple Watch."
        ),
        "whoop_recovery": Copy(
            body: "WHOOP's Recovery score blends HRV, resting heart rate, sleep, and other overnight signals into a single 0–100 score meant to reflect how ready your body is for strain today. Compare it to your own recent range, not a universal scale.",
            measurement: "WHOOP Recovery score, synced from your WHOOP account."
        ),
        "vo2_max": Copy(
            body: "VO₂ max estimates the maximum amount of oxygen your body can use during exercise — a common marker of cardiovascular fitness. It changes slowly, over weeks and months of consistent training, not day to day.",
            measurement: "Apple Watch cardio fitness (VO₂ max) estimate, read from Apple Health."
        ),
        "body_mass_kg": Copy(
            body: "Body weight fluctuates day to day with hydration, food intake, and sodium — a single reading rarely means much on its own. The trend over weeks is far more informative than any one day.",
            measurement: "Your logged weigh-ins, or a connected smart scale synced through Apple Health."
        ),
    ]
}
