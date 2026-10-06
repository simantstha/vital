import Foundation

/// Pure, stateless formatting + decision logic for the redesigned
/// `AnalysisView` (analysis-v2-contract.md §2). Every function here takes its
/// inputs explicitly (never reads a singleton) so it's trivially unit
/// tested — see `AnalysisLogicTests.swift`. No SwiftUI here; the view layer
/// only turns these strings/enums into styled rows.
enum AnalysisLogic {

    // MARK: - Tone

    /// Visual weight for a comparison chip/row. `good`/`watch` map to
    /// `Theme.Colors.positive`/`Theme.Colors.caution` in the view;
    /// `neutral` to a plain gray chip.
    enum Tone: Equatable {
        case good, watch, neutral
    }

    struct Chip: Equatable {
        let text: String
        let tone: Tone
    }

    /// A value within this fraction of `usual` reads as "usual" rather than
    /// a directional delta (analysis-v2-contract.md §2: "within ±3%").
    static let usualTolerancePct = 0.03

    private static func isWithinUsualTolerance(_ value: Double, _ usual: Double) -> Bool {
        guard usual != 0 else { return value == 0 }
        return abs(value - usual) / abs(usual) <= usualTolerancePct
    }

    // MARK: - Workout stat chips

    /// Distance has no inherent "good" direction — the chip is always
    /// neutral, just stating the delta (or "usual"). Short form ("+1.4 km"),
    /// no "vs usual" suffix — the stats row already sits under a section
    /// whose whole point is comparison, and the full-width suffix was
    /// clipping in the narrow stat column at 390pt.
    static func distanceChip(distanceM: Double, usualDistanceM: Double, unit: UnitSystem) -> Chip {
        if isWithinUsualTolerance(distanceM, usualDistanceM) {
            return Chip(text: "usual", tone: .neutral)
        }
        let deltaKm = (distanceM - usualDistanceM) / 1000
        let sign = deltaKm >= 0 ? "+" : "\u{2212}"
        let magnitude = UnitFormat.distance(km: abs(deltaKm), unit, placeholder: "0")
        return Chip(text: "\(sign)\(magnitude)", tone: .neutral)
    }

    /// Pace is inverted — a LOWER minutes-per-km is faster. The chip reads
    /// "N s faster/slower" (seconds, since a full pace-unit delta is
    /// usually sub-minute) and is toned `good` when faster, `watch` when
    /// slower.
    static func paceChip(paceMinPerKm: Double, usualPaceMinPerKm: Double) -> Chip {
        if isWithinUsualTolerance(paceMinPerKm, usualPaceMinPerKm) {
            return Chip(text: "usual", tone: .neutral)
        }
        let deltaSeconds = Int(((usualPaceMinPerKm - paceMinPerKm) * 60).rounded())
        let faster = deltaSeconds > 0
        return Chip(text: "\(abs(deltaSeconds)) s \(faster ? "faster" : "slower")", tone: faster ? .good : .watch)
    }

    /// Average heart rate has no inherent "good" direction for a single
    /// workout (a harder session naturally runs higher) — neutral, like
    /// distance. Short form ("+18 bpm"), same reasoning as `distanceChip`.
    static func avgHrChip(avgHr: Double, usualAvgHr: Double) -> Chip {
        if isWithinUsualTolerance(avgHr, usualAvgHr) {
            return Chip(text: "usual", tone: .neutral)
        }
        let delta = Int((avgHr - usualAvgHr).rounded())
        let sign = delta >= 0 ? "+" : "\u{2212}"
        return Chip(text: "\(sign)\(abs(delta)) bpm", tone: .neutral)
    }

    // MARK: - Pace history strip

    /// 1 = fastest (lowest min/km) among `previous + [current]`; ties share the
    /// better rank. Same rule as lib/analysisContext.ts `computePaceHistory`.
    static func paceRank(previous: [Double], current: Double) -> Int {
        previous.filter { $0 < current }.count + 1
    }

    /// Horizontal position (0 = left/slowest, 1 = right/fastest) of `pace` on
    /// the "Compared to your last N runs" strip. Faster (lower min/km) is on
    /// the right — the SAME direction `paceRank` counts, so rank 1 is always
    /// the right-most dot. Returns 0.5 when every pace is identical.
    static func paceStripFraction(pace: Double, minPace: Double, maxPace: Double) -> Double {
        guard maxPace > minPace else { return 0.5 }
        return (maxPace - pace) / (maxPace - minPace)
    }

    /// "Compared to your last N runs" caption, from `paceHistory.rank`
    /// (1 = fastest) among `previous.count + 1` total runs (the previous
    /// runs plus this one).
    static func paceRankPhrase(rank: Int, previousCount: Int) -> String {
        let total = previousCount + 1
        guard total > 0 else { return "" }
        if rank <= 1 {
            return "Quickest of your last \(total) runs."
        }
        if rank >= total {
            return "Slowest of your last \(total) runs."
        }
        return "\(ordinal(rank)) fastest of your last \(total) runs."
    }

    private static func ordinal(_ n: Int) -> String {
        let suffix: String
        switch (n % 100, n % 10) {
        case (11, _), (12, _), (13, _): suffix = "th"
        case (_, 1): suffix = "st"
        case (_, 2): suffix = "nd"
        case (_, 3): suffix = "rd"
        default: suffix = "th"
        }
        return "\(n)\(suffix)"
    }

    // MARK: - Effort zone

    /// Title-case label for `AnalysisContext.Effort.zone`'s raw string.
    static func effortZoneLabel(_ zone: String) -> String {
        switch zone {
        case "easy": return "Easy"
        case "steady": return "Steady"
        case "hard": return "Hard"
        case "max": return "Max"
        default: return zone.capitalized
        }
    }

    /// Fraction (0...1) of the resting→max heart-rate range a given value
    /// sits at, clamped so a value at or below resting reads 0 and at or
    /// above max reads 1. Used to place BOTH the avg-effort marker and this
    /// workout's own recorded max-HR marker on the same zone bar.
    static func heartRateRangeFraction(_ value: Double, restingHr: Double, maxHr: Double) -> Double {
        guard maxHr > restingHr else { return 0 }
        return min(max((value - restingHr) / (maxHr - restingHr), 0), 1)
    }

    /// The four zone-band boundaries as fractions of the full resting→max
    /// range: easy [0, 0.60), steady [0.60, 0.75), hard [0.75, 0.90), max
    /// [0.90, 1.0] — mirrors the effort classification the server already
    /// applied to produce `effort.zone`.
    static let effortZoneBoundaries: [Double] = [0.60, 0.75, 0.90]

    // MARK: - Recovery readings (HRV / resting HR)

    enum RecoveryMetric { case hrv, restingHr }

    /// "62 ms · above normal" / "58 bpm · below normal" / "64 ms · normal" /
    /// bare "62 ms" when the baseline isn't established (`vsNormal == nil`).
    /// Tone follows the metric's own better-direction: higher HRV is good,
    /// higher resting HR is a caution.
    static func recoveryChip(value: Double, unit: String, vsNormal: String?, metric: RecoveryMetric) -> Chip {
        let formattedValue = "\(Int(value.rounded())) \(unit)"
        guard let vsNormal else { return Chip(text: formattedValue, tone: .neutral) }
        switch vsNormal {
        case "above":
            return Chip(text: "\(formattedValue) · above normal", tone: metric == .hrv ? .good : .watch)
        case "below":
            return Chip(text: "\(formattedValue) · below normal", tone: metric == .hrv ? .watch : .good)
        default:
            return Chip(text: "\(formattedValue) · normal", tone: .neutral)
        }
    }

    // MARK: - Sleep hero

    /// Sleep total vs the 14-night usual — analogous to `distanceChip`, but
    /// worded "under"/"over" (contract example: "1h 32m under your usual").
    /// Toned `watch` when under (short sleep is the thing worth flagging),
    /// neutral otherwise.
    static func sleepUsualChip(minutes: Double, usualMinutes: Double) -> Chip {
        if isWithinUsualTolerance(minutes, usualMinutes) {
            return Chip(text: "usual", tone: .neutral)
        }
        let delta = minutes - usualMinutes
        let phrase = formatDuration(abs(delta))
        return delta < 0
            ? Chip(text: "\(phrase) under your usual", tone: .watch)
            : Chip(text: "\(phrase) over your usual", tone: .neutral)
    }

    // MARK: - Sleep stages

    /// "watch" when deep or REM fell under 75% of usual, or awake ran over
    /// 150% of usual (analysis-v2-contract.md §2). `stage` identifies which
    /// rule applies; core has no rule of its own and always reads neutral.
    enum SleepStageKind { case core, deep, rem, awake }

    static func sleepStageTone(_ stage: SleepStageKind, minutes: Double, usualMinutes: Double) -> Tone {
        guard usualMinutes > 0 else { return .neutral }
        let ratio = minutes / usualMinutes
        switch stage {
        case .deep, .rem:
            return ratio < 0.75 ? .watch : .neutral
        case .awake:
            return ratio > 1.5 ? .watch : .neutral
        case .core:
            return .neutral
        }
    }

    /// A stage bar's fill fraction (0...1) relative to the row's own scale —
    /// each row is scaled independently to `max(minutes, usualMinutes) * headroom`
    /// so a stage far below its usual doesn't render as a sliver next to an
    /// oversized usual tick, and vice versa.
    static func sleepStageBarFraction(minutes: Double, usualMinutes: Double, headroom: Double = 1.15) -> Double {
        let scale = max(minutes, usualMinutes, 1) * headroom
        return min(max(minutes / scale, 0), 1)
    }

    /// The usual-value tick's position (0...1) on that same per-row scale.
    static func sleepStageUsualTickFraction(minutes: Double, usualMinutes: Double, headroom: Double = 1.15) -> Double {
        let scale = max(minutes, usualMinutes, 1) * headroom
        return min(max(usualMinutes / scale, 0), 1)
    }

    // MARK: - Week strip

    struct WeekBar: Equatable {
        let dayLabel: String   // "M", "T", "W", …
        let heightFraction: Double // 0...1, relative to the strip's own scale
        let isToday: Bool
    }

    struct WeekStripLayout: Equatable {
        let bars: [WeekBar]
        /// The dashed goal line's position (0...1) on the same scale as `bars`.
        let goalLineFraction: Double
    }

    /// Scales the last-7-nights minutes (oldest → newest) and the goal line
    /// onto a shared 0...1 axis, with 10% headroom above the tallest of
    /// (max night, goal) so the goal line is never flush with the top edge.
    /// `nights` may be shorter than 7 — a night with no data is simply
    /// omitted by the caller before this is reached (contract: "missing
    /// nights omitted").
    static func weekStripLayout(nights: [(date: String, minutes: Double)], goalMinutes: Double, today: String) -> WeekStripLayout {
        let scale = max((nights.map(\.minutes).max() ?? 0), goalMinutes, 1) * 1.1
        let bars = nights.map { night -> WeekBar in
            WeekBar(
                dayLabel: weekdayLetter(night.date),
                heightFraction: min(max(night.minutes / scale, 0), 1),
                isToday: night.date == today
            )
        }
        return WeekStripLayout(bars: bars, goalLineFraction: min(max(goalMinutes / scale, 0), 1))
    }

    /// Single-letter weekday ("M", "T", "W", …) for a 'YYYY-MM-DD' day key,
    /// parsed as a calendar date at noon UTC (avoids any DST-boundary
    /// off-by-one from parsing at local midnight) so the same day key always
    /// yields the same letter regardless of device time zone.
    static func weekdayLetter(_ dayKey: String) -> String {
        guard let date = dayKeyFormatter.date(from: dayKey) else { return "" }
        return weekdayLetterFormatter.string(from: date).uppercased()
    }

    private static let dayKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'12:00:00"
        return f
    }()

    private static let weekdayLetterFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEEEE" // single-letter weekday, locale-independent for en_US_POSIX
        return f
    }()

    // MARK: - Kickers

    /// Short, all-caps activity word for a workout kicker ("RUN", "RIDE", …)
    /// from the app's existing title-case workout type name
    /// (`HealthKitBackfill.workoutTypeName`, e.g. "Running").
    static func workoutKickerActivity(type: String) -> String {
        switch type {
        case "Running": return "RUN"
        case "Walking": return "WALK"
        case "Cycling": return "RIDE"
        case "Swimming": return "SWIM"
        case "Hiking": return "HIKE"
        case "Rowing": return "ROW"
        case "Strength Training": return "STRENGTH"
        default: return type.uppercased()
        }
    }

    /// "RUN · MON 7:41 AM" (US) / "RUN · LUN 19:41" (a 24-hour locale) —
    /// activity plus local weekday + time, fully uppercased
    /// (analysis-v2-contract.md #249 review polish — every kicker across the
    /// screen reads in caps, never mixed-case). `timeZone`/`locale` default
    /// to the device's own so the view always renders in wall-clock local
    /// time in the user's own locale; tests pass explicit values for
    /// determinism. This is user-visible text, so — unlike the internal
    /// date-key formatters elsewhere in this file — it must NOT pin
    /// `en_US_POSIX`: a user whose phone is set to 24-hour time should see
    /// "19:41", not "7:41 PM".
    static func workoutKicker(type: String, startTime: Date, timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        let weekday = dateFormatter(pattern: "EEE", timeZone: timeZone, locale: locale).string(from: startTime)
        return "\(workoutKickerActivity(type: type)) · \(weekday) \(clockTime(startTime, timeZone: timeZone, locale: locale))".uppercased()
    }

    /// "LAST NIGHT · SUN → MON" — bed night's weekday through wake night's,
    /// fully uppercased (see `workoutKicker`'s doc comment, including why
    /// `locale` is user-visible and must not be pinned).
    static func sleepKicker(bedTime: Date, wakeTime: Date, timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        let f = dateFormatter(pattern: "EEE", timeZone: timeZone, locale: locale)
        return "LAST NIGHT · \(f.string(from: bedTime)) \u{2192} \(f.string(from: wakeTime))".uppercased()
    }

    /// "7:41 AM" (US) / "19:41" (a 24-hour locale) — the system's own short
    /// time style (`Date.FormatStyle(date: .omitted, time: .shortened)`),
    /// the one time format used everywhere on this screen (#249 review
    /// polish — the kicker's time and every standalone clock-time value,
    /// e.g. the sleep hero's bed/wake times and the "before bed" chips,
    /// used to disagree: a hand-rolled "h:mm a" pattern here vs. lowercase
    /// am/pm). `locale` defaults to the device's own — this is user-visible
    /// text, so it must render in the user's own 12-/24-hour convention, not
    /// a hardcoded `en_US_POSIX`; tests pass an explicit `locale` for
    /// determinism instead.
    static func clockTime(_ date: Date, timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        date.formatted(
            Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: .current, timeZone: timeZone)
        )
    }

    /// Builds a fresh `DateFormatter` for the given pattern/zone/locale. A
    /// new instance per call (rather than a cached shared one) keeps every
    /// formatting function here free of mutable static state, so tests can
    /// pass explicit `timeZone`/`locale` values without racing other callers
    /// of the same formatter. `locale` defaults to the device's own for the
    /// user-visible callers above (`workoutKicker`/`sleepKicker`); internal,
    /// non-user-visible callers elsewhere in this file (day-key parsing)
    /// use their own dedicated `en_US_POSIX`-pinned formatters instead of
    /// this one, and stay that way.
    private static func dateFormatter(pattern: String, timeZone: TimeZone, locale: Locale = .current) -> DateFormatter {
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = timeZone
        f.dateFormat = pattern
        return f
    }

    // MARK: - Duration formatting

    /// 312 → "5h 12m"; 42 → "42m". Rounds to the nearest whole minute.
    static func formatDuration(_ minutes: Double) -> String {
        let total = Int(minutes.rounded())
        let hours = total / 60
        let mins = total % 60
        return hours > 0 ? "\(hours)h \(mins)m" : "\(mins)m"
    }

    /// Stopwatch-style label for a workout's `durationMin` (a `Double` whose
    /// fractional part is seconds, e.g. `52.23` min = 52 min 13.8 sec — NOT
    /// 52 whole minutes rounded, which is what a naive `Int(minutes.rounded())`
    /// would give, and which previously rendered a 52-minute run as "0:52").
    /// "m:ss" under an hour ("52:14"), "h:mm:ss" at an hour or more
    /// ("1:21:30").
    static func workoutDurationLabel(_ minutes: Double) -> String {
        let totalSeconds = Int((minutes * 60).rounded())
        let hours = totalSeconds / 3600
        let mins = (totalSeconds % 3600) / 60
        let secs = totalSeconds % 60
        if hours > 0 {
            return "\(hours):\(String(format: "%02d", mins)):\(String(format: "%02d", secs))"
        }
        return "\(mins):\(String(format: "%02d", secs))"
    }

    // MARK: - Before-bed proximity

    /// Whether `eventTime` falls within `windowHours` before `bedTime` —
    /// used to decide whether a "before bed" row is worth flagging (tone
    /// `.watch`) vs. shown neutrally. The contract's `beforeBed` fields are
    /// only ever populated by the server when they DO fall in that window
    /// (a workout within 4h, a meal within 3h), so in practice this is
    /// always true for data the view receives — exposed as a pure function
    /// here so that invariant itself is testable.
    static func isWithinWindow(eventTime: Date, bedTime: Date, windowHours: Double) -> Bool {
        let hours = bedTime.timeIntervalSince(eventTime) / 3600
        return hours >= 0 && hours <= windowHours
    }

    // MARK: - Devices (phase 2 "both devices" contract, PR C item 4)

    /// Display name for a device — thin passthrough to
    /// `DevicesLogic.deviceName` so the Analysis screen and the Devices
    /// settings screen never disagree on how a device is named.
    static func deviceDisplayName(_ device: DevicesLogic.DeviceKind) -> String {
        DevicesLogic.deviceName(device)
    }

    /// The device switch's default selection — always the primary device's
    /// own tab (contract: "It defaults to the primary device").
    static func defaultDeviceSelection(primary: DevicesLogic.DeviceKind) -> DevicesLogic.DeviceKind {
        primary
    }

    // MARK: - Heart-rate curve

    /// A single point on the normalized heart-rate curve — `x`/`y` both
    /// 0...1, `x` left→right across the workout, `y` bottom→top of its own
    /// min/max range (NOT an absolute bpm scale — the view maps this onto
    /// whatever frame it's drawn in).
    struct HRPoint: Equatable {
        let x: Double
        let y: Double
    }

    /// Normalizes a raw `hrSeries` (bpm, evenly spaced in time) into 0...1
    /// plot points. Handles the edge cases a naive `(v - lo) / (hi - lo)`
    /// wouldn't: an empty series returns no points, a single-sample series
    /// returns one centered point (nothing to draw a line through), and a
    /// perfectly flat series (`hi == lo`) reads every point at the vertical
    /// center rather than dividing by zero.
    static func hrCurvePoints(series: [Double]) -> [HRPoint] {
        guard !series.isEmpty else { return [] }
        guard series.count > 1 else { return [HRPoint(x: 0, y: 0.5)] }
        let lo = series.min() ?? 0
        let hi = series.max() ?? 0
        let range = hi - lo
        return series.enumerated().map { index, value in
            let x = Double(index) / Double(series.count - 1)
            let y = range > 0 ? (value - lo) / range : 0.5
            return HRPoint(x: x, y: y)
        }
    }

    /// (avg, max) of a raw `hrSeries`, for the curve card's "avg N · max N"
    /// caption when the session itself doesn't already carry `avgHr`/`maxHr`.
    /// `nil` for an empty series — never a fabricated 0.
    static func hrSeriesAvgMax(_ series: [Double]) -> (avg: Double, max: Double)? {
        guard !series.isEmpty else { return nil }
        let maxValue = series.max() ?? 0
        let avg = series.reduce(0, +) / Double(series.count)
        return (avg, maxValue)
    }

    // MARK: - Time-in-zones bars

    struct ZoneBar: Equatable {
        let label: String
        /// 0...1, relative to the LARGEST zone — the longest zone always
        /// fills the bar, matching the mockup's `zone_bars` helper.
        let fraction: Double
        let timeLabel: String    // "3:29" (mm:ss)
        let percentLabel: String // "78%" of the total time across all zones
    }

    /// Apple's heart-rate-reserve zone labels vs WHOOP's max-HR-share labels
    /// (contract: zones "from your heart-rate reserve" for Apple, "as a
    /// share of your max heart rate" for WHOOP) — picked by `zoneBasis`.
    static func zoneLabels(basis: String?) -> [String] {
        basis == "maxHr"
            ? ["50–60%", "60–70%", "70–80%", "80–90%", "90%+"]
            : ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"]
    }

    /// "N:SS" for a whole-seconds duration — the zone bars' own duration
    /// label, distinct from `formatDuration`'s "Nh Nm" (which reads wrong at
    /// zone-bar scale: "0m" for anything under a minute).
    static func mmss(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let minutes = total / 60
        let secs = total % 60
        return "\(minutes):\(String(format: "%02d", secs))"
    }

    /// Builds the 5 zone bars from `zonesSec` — empty input yields no bars
    /// (a hidden section) rather than 5 empty ones.
    static func zoneBars(secondsByZone: [Double], basis: String? = nil) -> [ZoneBar] {
        guard !secondsByZone.isEmpty else { return [] }
        let labels = zoneLabels(basis: basis)
        let total = secondsByZone.reduce(0, +)
        let maxValue = secondsByZone.max() ?? 0
        return secondsByZone.enumerated().map { index, seconds in
            let fraction = maxValue > 0 ? seconds / maxValue : 0
            let percent = total > 0 ? Int((seconds / total * 100).rounded()) : 0
            return ZoneBar(
                label: index < labels.count ? labels[index] : "Zone \(index + 1)",
                fraction: min(max(fraction, 0), 1),
                timeLabel: mmss(seconds),
                percentLabel: "\(percent)%"
            )
        }
    }

    // MARK: - Sleep devices disagreement

    /// The "devices disagree" card only appears when the two devices' asleep
    /// minutes differ by at least this much (contract §3).
    static let sleepDisagreeThresholdMinutes: Double = 10

    static func sleepDevicesDisagree(minutesA: Double, minutesB: Double) -> Bool {
        abs(minutesA - minutesB) >= sleepDisagreeThresholdMinutes
    }
}
