import Foundation

/// One editable set in the lift logger. `load` is in the USER's display unit
/// (kg or lb, per `UnitSystem`) so the stepper reads and increments naturally;
/// it is converted to kg only when building the request body. `load == 0`
/// means bodyweight (sent as an omitted `loadKg`, never as 0).
struct LiftDraftSet: Identifiable, Equatable {
    let id: UUID
    var reps: Int
    var load: Double
    var isWarmup: Bool
    /// Optional rate of perceived exertion, 6...10 in 0.5 steps; `nil` = unset.
    var rpe: Double?
    /// What this set did last time (display unit) — drives the "last: 185×8"
    /// caption; `nil` when there is no history for this set position.
    var last: LiftLastRef?
    /// Ticked off while training (the ✓ on the set row). When at least one set
    /// is ticked, Save logs only the ticked sets. Client-only — never sent to
    /// the server and ignored by the template-vs-manual comparison.
    var isDone: Bool

    init(
        id: UUID = UUID(), reps: Int, load: Double, isWarmup: Bool = false,
        rpe: Double? = nil, last: LiftLastRef? = nil, isDone: Bool = false
    ) {
        self.id = id
        self.reps = reps
        self.load = load
        self.isWarmup = isWarmup
        self.rpe = rpe
        self.last = last
        self.isDone = isDone
    }
}

/// A past working set in the user's display unit (see `LiftDraftSet.last`).
struct LiftLastRef: Equatable {
    var reps: Int
    var load: Double
}

/// One autocomplete / chip candidate: canonical key + the display the user
/// last typed for it.
struct LiftExerciseOption: Equatable {
    let key: String
    let display: String
}

/// One exercise block (a Form section) in the lift logger. `key` is the
/// canonical lowercase name the server groups by; `name` is what's shown and
/// sent as `exerciseDisplay`.
struct LiftDraftExercise: Identifiable, Equatable {
    let id: UUID
    var key: String
    var name: String
    var sets: [LiftDraftSet]
    /// Working sets from the last session of THIS exercise, in set order —
    /// "Add set" uses the next one as its hint. Empty when unknown.
    var history: [LiftLastRef]

    init(id: UUID = UUID(), key: String, name: String, sets: [LiftDraftSet], history: [LiftLastRef] = []) {
        self.id = id
        self.key = key
        self.name = name
        self.sets = sets
        self.history = history
    }
}

/// "Last 3×5 @ 140 kg · try 142.5 kg" — what the last session's working sets
/// at the top load say about next time. Loads are in the display unit.
struct LiftProgressionHint: Equatable {
    /// Heaviest working load last session.
    let lastLoad: Double
    /// Reps of each working set performed at `lastLoad`, in set order.
    let lastReps: [Int]
    /// Load to try next; equal to `lastLoad` for a "repeat" hint.
    let suggestedLoad: Double

    /// `true` for a "try …" hint (every set at the top load hit its reps).
    var isIncrease: Bool { suggestedLoad > lastLoad }
}

/// What the rest-timer bar shows at a given moment.
enum LiftRestPhase: Equatable {
    /// Counting down; `seconds` is the (rounded-up) time left, always >= 1.
    case running(seconds: Int)
    /// Just reached 0 — "Rest done" is shown for a few seconds.
    case done
    /// Nothing to show (the done message has timed out).
    case hidden
}

/// A rest countdown. Date-based on purpose: the view re-derives the label
/// from `end` on every `TimelineView` tick, so nothing is lost when the view
/// is re-rendered, and the countdown can't drift.
struct LiftRestState: Equatable {
    /// When the rest started — anchors the 1 s `TimelineView` schedule.
    let start: Date
    /// When the rest ends ("+30s" pushes this out).
    var end: Date
    /// The "rest done" haptic has fired for this timer.
    var announced = false
}

/// Pure, network-free logic behind the lift logger sheet — draft building from
/// `GET /api/workouts/last`, stepper increments, and the
/// `POST /api/workouts/sets` payload. No SwiftUI import, so every branch is
/// pinned in `LiftLoggerLogicTests`.
enum LiftLoggerLogic {

    static let minReps = 1
    static let maxReps = 100
    static let maxLoad = 1000.0
    static let defaultReps = 5

    /// Upper clamp for typed/stepped loads, in the display unit (1000 kg ≈ 2200 lb).
    static func maxLoad(for system: UnitSystem) -> Double {
        system == .metric ? maxLoad : 2200
    }

    // MARK: - Typed entry

    /// Parses typed reps ("8", " 12 ") → clamped to `minReps...maxReps`.
    /// `nil` for empty/non-numeric input (caller keeps the old value).
    /// Decimals ("8.5") are rejected rather than silently truncated.
    static func parseReps(_ text: String) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Int(trimmed) else { return nil }
        return min(max(value, minReps), maxReps)
    }

    /// Parses a typed load in the display unit ("142.5", "142,5", "0") →
    /// clamped to `0...maxLoad(for:)` and rounded to 2 decimals. `nil` for
    /// empty/non-numeric/non-finite input.
    static func parseLoad(_ text: String, system: UnitSystem) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ",", with: ".")
        guard !trimmed.isEmpty, let value = Double(trimmed), value.isFinite else { return nil }
        let clamped = min(max(value, 0), maxLoad(for: system))
        return (clamped * 100).rounded() / 100
    }

    /// "142.5" / "140" — whole numbers unadorned, otherwise up to two decimals
    /// (trailing zeros dropped), no unit. Used for editing and hints.
    static func numberText(_ value: Double) -> String {
        if value.truncatingRemainder(dividingBy: 1) == 0 { return String(Int(value)) }
        var text = String(format: "%.2f", value)
        while text.hasSuffix("0") { text.removeLast() }
        return text
    }

    /// Text pre-filled into the weight field when editing starts: empty for
    /// bodyweight (0) so the user can just type.
    static func editText(forLoad load: Double) -> String {
        load > 0 ? numberText(load) : ""
    }

    // MARK: - RPE

    /// 6, 6.5, … 10.
    static let rpeOptions: [Double] = stride(from: 6.0, through: 10.0, by: 0.5).map { $0 }

    /// "8" / "8.5"; `nil` → "—".
    static func rpeText(_ rpe: Double?) -> String {
        guard let rpe else { return "—" }
        return numberText(rpe)
    }

    /// Snaps to the nearest 0.5 and clamps to 6...10; `nil` stays `nil`.
    static func clampRPE(_ rpe: Double?) -> Double? {
        guard let rpe, rpe.isFinite else { return nil }
        return min(max((rpe * 2).rounded() / 2, 6), 10)
    }

    // MARK: - Last-time hints

    /// "last: 185×8" (number in the display unit, no unit suffix so the row
    /// stays compact); bodyweight reads "last: BW×8".
    static func hintText(_ ref: LiftLastRef) -> String {
        let load = ref.load > 0 ? numberText(ref.load) : "BW"
        return "last: \(load)×\(ref.reps)"
    }

    /// Working (non-warm-up) sets of `key` from a fetched session, as display-
    /// unit refs in set order. `/api/workouts/last` returns the WHOLE session,
    /// so other exercises' sets are filtered out here. Empty → no history.
    static func history(forKey key: String, from sets: [WorkoutSetDTO], system: UnitSystem) -> [LiftLastRef] {
        sets
            .filter { $0.exercise == key && !$0.isWarmup }
            .sorted { $0.setIndex < $1.setIndex }
            .map {
                LiftLastRef(
                    reps: min(max($0.reps, minReps), maxReps),
                    load: displayLoad(fromKg: $0.loadKg, system: system)
                )
            }
    }

    /// Pre-filled sets for a newly added exercise from its history (each with
    /// its own hint); a single blank 5-rep set when there is none.
    static func seededSets(from history: [LiftLastRef]) -> [LiftDraftSet] {
        guard !history.isEmpty else { return [LiftDraftSet(reps: defaultReps, load: 0)] }
        return history.map { LiftDraftSet(reps: $0.reps, load: $0.load, last: $0) }
    }

    // MARK: - Progression hint

    /// Substrings of a canonical exercise key that mark a lower-body compound
    /// lift ("back squat", "romanian deadlift", "leg press", "hip thrust"…).
    private static let lowerBodyCompoundStems = ["squat", "deadlift", "leg press", "hip thrust"]

    /// `true` for squat / deadlift / romanian deadlift / leg press / hip thrust
    /// (and variants such as "front squat" or "sumo deadlift"). Drives both the
    /// bigger progression step and the longer default rest.
    static func isLowerBodyCompound(key: String) -> Bool {
        let normalized = canonicalKey(from: key.replacingOccurrences(of: "-", with: " "))
        guard !normalized.isEmpty else { return false }
        if normalized.split(separator: " ").contains("rdl") { return true }
        return lowerBodyCompoundStems.contains { normalized.contains($0) }
    }

    /// Suggested load jump after a clean session: +2.5 kg / +5 lb for
    /// lower-body compounds, +1.25 kg / +2.5 lb for everything else.
    static func progressionStep(forKey key: String, system: UnitSystem) -> Double {
        let lower = isLowerBodyCompound(key: key)
        switch system {
        case .metric: return lower ? 2.5 : 1.25
        case .imperial: return lower ? 5 : 2.5
        }
    }

    /// Display rounding for suggested loads: nearest 0.5 kg / 1 lb.
    static func roundToPlate(_ load: Double, system: UnitSystem) -> Double {
        let unit = system == .metric ? 0.5 : 1.0
        return (load / unit).rounded() * unit
    }

    /// Whether two display-unit loads are the same weight (guards float noise).
    static func sameLoad(_ a: Double, _ b: Double) -> Bool {
        abs(a - b) < 0.01
    }

    /// Progression hint from an exercise's last-session working sets, or `nil`
    /// without history (or for a bodyweight-only exercise — there is no load
    /// to progress). Only the sets at the TOP load are judged: the first one
    /// sets the rep target, and if every one of them reached it the hint is
    /// "try" (top load + step, rounded to the plate step), otherwise "repeat"
    /// the top load.
    static func progressionHint(history: [LiftLastRef], key: String, system: UnitSystem) -> LiftProgressionHint? {
        let working = history.filter { $0.reps >= minReps }
        guard let topLoad = working.map({ $0.load }).max(), topLoad > 0 else { return nil }
        let reps = working.filter { sameLoad($0.load, topLoad) }.map { $0.reps }
        guard let target = reps.first else { return nil }
        let hitAll = reps.allSatisfy { $0 >= target }
        var suggested = topLoad
        if hitAll {
            let stepped = roundToPlate(topLoad + progressionStep(forKey: key, system: system), system: system)
            suggested = min(stepped, maxLoad(for: system))
        }
        return LiftProgressionHint(lastLoad: topLoad, lastReps: reps, suggestedLoad: max(suggested, topLoad))
    }

    /// "Last 3×5 @ 140 kg · try 142.5 kg" / "Last 5/5/4 @ 140 kg · repeat 140 kg".
    static func progressionText(_ hint: LiftProgressionHint, system: UnitSystem) -> String {
        let uniform = Set(hint.lastReps).count <= 1
        let repsText = uniform
            ? "\(hint.lastReps.count)×\(hint.lastReps.first ?? 0)"
            : hint.lastReps.map(String.init).joined(separator: "/")
        let last = "Last \(repsText) @ \(loadText(hint.lastLoad, system: system))"
        let next = hint.isIncrease
            ? "try \(loadText(hint.suggestedLoad, system: system))"
            : "repeat \(loadText(hint.lastLoad, system: system))"
        return "\(last) · \(next)"
    }

    /// A set the hint may rewrite: a working set that isn't ticked and whose
    /// load is still last session's top load (i.e. not edited by the user).
    static func isEligibleForProgression(_ set: LiftDraftSet, hint: LiftProgressionHint) -> Bool {
        !set.isWarmup && !set.isDone && sameLoad(set.load, hint.lastLoad)
    }

    /// `true` when tapping the hint would change something: it's a "try" hint
    /// and at least one set is still eligible.
    static func canApplyProgression(_ hint: LiftProgressionHint, to sets: [LiftDraftSet]) -> Bool {
        hint.isIncrease && sets.contains { isEligibleForProgression($0, hint: hint) }
    }

    /// Sets with the suggested load applied to every eligible set; edited,
    /// ticked, warm-up and lighter (ramp / back-off) sets are left alone.
    static func applyingProgression(_ hint: LiftProgressionHint, to sets: [LiftDraftSet]) -> [LiftDraftSet] {
        guard hint.isIncrease else { return sets }
        return sets.map { set in
            guard isEligibleForProgression(set, hint: hint) else { return set }
            var updated = set
            updated.load = hint.suggestedLoad
            return updated
        }
    }

    // MARK: - Rest timer

    /// Default rest after a lower-body compound set (2:30).
    static let lowerBodyRestSeconds: TimeInterval = 150
    /// Default rest after any other set (2:00).
    static let defaultRestSeconds: TimeInterval = 120
    /// What the "+30s" button adds.
    static let restExtension: TimeInterval = 30
    /// How long "Rest done" stays on screen after the countdown hits 0.
    static let restDoneDisplaySeconds: TimeInterval = 4
    /// What VoiceOver is told when the countdown reaches 0 (the visible "Rest
    /// done" and the haptic are invisible to a screen-reader user otherwise).
    static let restDoneAnnouncement = "Rest done"
    /// Minimum side (pt) of the rest bar's "+30s" / "Skip" tap targets (HIG: 44).
    static let restButtonMinTapSize: CGFloat = 44

    /// Rest length for an exercise key: 2:30 for lower-body compounds, else 2:00.
    static func restDuration(forKey key: String) -> TimeInterval {
        isLowerBodyCompound(key: key) ? lowerBodyRestSeconds : defaultRestSeconds
    }

    /// Whole seconds left until `end` (rounded UP so a fresh 2:30 timer reads
    /// 2:30, not 2:29); 0 once `end` has passed.
    static func restRemainingSeconds(until end: Date, now: Date) -> Int {
        let remaining = end.timeIntervalSince(now)
        guard remaining > 0 else { return 0 }
        return Int(remaining.rounded(.up))
    }

    /// "1:58" / "0:07" / "10:00".
    static func restLabel(seconds: Int) -> String {
        let total = max(0, seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// Running while `now < end`; "Rest done" for `doneDisplay` seconds after
    /// `end`; hidden after that.
    static func restPhase(
        end: Date, now: Date, doneDisplay: TimeInterval = LiftLoggerLogic.restDoneDisplaySeconds
    ) -> LiftRestPhase {
        let remaining = restRemainingSeconds(until: end, now: now)
        if remaining > 0 { return .running(seconds: remaining) }
        return now.timeIntervalSince(end) < doneDisplay ? .done : .hidden
    }

    // MARK: - Done ticks / save scope

    /// `true` once any set in the form is ticked.
    static func hasDoneSets(in drafts: [LiftDraftExercise]) -> Bool {
        drafts.contains { $0.sets.contains { $0.isDone } }
    }

    /// What Save should log: only the ticked sets when at least one is ticked
    /// (exercises left with no ticked sets are dropped), otherwise everything.
    static func draftsToSave(from drafts: [LiftDraftExercise]) -> [LiftDraftExercise] {
        guard hasDoneSets(in: drafts) else { return drafts }
        return drafts.compactMap { exercise in
            var kept = exercise
            kept.sets = exercise.sets.filter { $0.isDone }
            return kept.sets.isEmpty ? nil : kept
        }
    }

    /// "Save 7 done sets" / "Save 1 done set" when something is ticked,
    /// "Save 9 sets" / "Save 1 set" otherwise, "Save lift" with nothing to save.
    static func saveLabel(setCount: Int, doneOnly: Bool) -> String {
        guard setCount > 0 else { return "Save lift" }
        let noun = setCount == 1 ? "set" : "sets"
        return doneOnly ? "Save \(setCount) done \(noun)" : "Save \(setCount) \(noun)"
    }

    // MARK: - Recent sessions ("Repeat: …")

    /// "Today" / "Yesterday" / "Mon" for a `yyyy-MM-dd` day key relative to
    /// `today`; the raw key when it can't be parsed.
    static func dayLabel(localDay: String, today: Date = Date(), calendar: Calendar = .current) -> String {
        let parser = DateFormatter()
        parser.calendar = calendar
        parser.timeZone = calendar.timeZone
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let day = parser.date(from: localDay) else { return localDay }
        if calendar.isDate(day, inSameDayAs: today) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: today),
           calendar.isDate(day, inSameDayAs: yesterday) { return "Yesterday" }
        let weekday = DateFormatter()
        weekday.calendar = calendar
        weekday.timeZone = calendar.timeZone
        weekday.locale = Locale(identifier: "en_US_POSIX")
        weekday.dateFormat = "EEE"
        return weekday.string(from: day)
    }

    /// "Mon · Bench press, Overhead press, Triceps pushdown" — at most three
    /// names, then "…".
    static func sessionTitle(_ session: RecentSessionDTO, today: Date = Date(), calendar: Calendar = .current) -> String {
        let day = dayLabel(localDay: session.localDay, today: today, calendar: calendar)
        let names = session.exercises.prefix(3).map { $0.display }
        let more = session.exercises.count > 3 ? ", …" : ""
        return names.isEmpty ? day : "\(day) · \(names.joined(separator: ", "))\(more)"
    }

    /// Drafts for a picked recent session — one block per exercise, using the
    /// per-set details when the server sent them, else `sets` copies of the
    /// top set.
    static func drafts(from session: RecentSessionDTO, system: UnitSystem) -> [LiftDraftExercise] {
        session.exercises.compactMap { exercise -> LiftDraftExercise? in
            let details: [RecentSessionSetDTO]
            if let setDetails = exercise.setDetails, !setDetails.isEmpty {
                details = setDetails
            } else {
                details = Array(
                    repeating: RecentSessionSetDTO(reps: exercise.topSet.reps, loadKg: exercise.topSet.loadKg, rpe: nil),
                    count: max(exercise.sets, 1)
                )
            }
            let sets = details.map {
                LiftDraftSet(
                    reps: min(max($0.reps, minReps), maxReps),
                    load: displayLoad(fromKg: $0.loadKg, system: system)
                )
            }
            // The session endpoint only lists working sets, so the seeded
            // sets ARE the exercise's last-session history (drives the
            // progression hint).
            let history = sets.map { LiftLastRef(reps: $0.reps, load: $0.load) }
            return LiftDraftExercise(key: exercise.exercise, name: exercise.display, sets: sets, history: history)
        }
    }

    // MARK: - Autocomplete

    /// The user's own past exercises matching what they've typed — prefix
    /// matches first, then substring matches, never ones already in the form;
    /// at most `limit`. Empty query → none.
    static func completions(
        for query: String,
        in options: [LiftExerciseOption],
        excluding usedKeys: Set<String>,
        limit: Int = 5
    ) -> [LiftExerciseOption] {
        let q = canonicalKey(from: query)
        guard !q.isEmpty else { return [] }
        let pool = options.filter { !usedKeys.contains($0.key) }
        let prefix = pool.filter { $0.key.hasPrefix(q) || $0.display.lowercased().hasPrefix(q) }
        let contains = pool.filter { option in
            !prefix.contains(option) && (option.key.contains(q) || option.display.lowercased().contains(q))
        }
        return Array((prefix + contains).prefix(limit))
    }

    /// "Today" / "Yesterday" / "Mon, Oct 5" for the date control.
    static func dateLabel(_ date: Date, today: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: today) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: today),
           calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE, MMM d"
        return f.string(from: date)
    }

    /// Stepper increment for the load field, in the display unit: 2.5 kg or
    /// 5 lb (the smallest plates most gyms stock).
    static func loadStep(for system: UnitSystem) -> Double {
        system == .metric ? 2.5 : 5
    }

    /// Display-unit load for a stored kg value, rounded to the nearest 0.5 so
    /// a pound conversion never shows "220.462". `nil` (bodyweight) → 0.
    static func displayLoad(fromKg kg: Double?, system: UnitSystem) -> Double {
        guard let kg, kg > 0 else { return 0 }
        let value = system == .metric ? kg : UnitConvert.kgToLb(kg)
        return (value * 2).rounded() / 2
    }

    /// Display-unit load back to kg for the wire (rounded to 2 decimals);
    /// `nil` for bodyweight (`load <= 0`).
    static func kg(fromDisplayLoad load: Double, system: UnitSystem) -> Double? {
        guard load > 0 else { return nil }
        let kg = system == .metric ? load : UnitConvert.lbToKg(load)
        return (kg * 100).rounded() / 100
    }

    /// "142.5 kg" / "140 kg" — whole numbers unadorned, otherwise up to two
    /// decimals, joined to the unit with a non-breaking space (`UnitFormat.nbsp`)
    /// so a narrow row can never strand the unit ("140" / "kg") on its own line.
    static func loadText(_ load: Double, system: UnitSystem) -> String {
        guard load > 0 else { return "Bodyweight" }
        return "\(numberText(load))\(UnitFormat.nbsp)\(system.weightUnit)"
    }

    /// "bench press" -> "Bench Press"; "  Back  Squat " -> "Back Squat".
    static func displayName(forKey key: String) -> String {
        key.capitalized
    }

    /// Canonical key for a typed exercise name — trimmed, lowercased,
    /// whitespace collapsed (the server lowercases/trims too; this keeps the
    /// duplicate check in `addExercise` consistent with it).
    static func canonicalKey(from name: String) -> String {
        name.split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
            .lowercased()
    }

    // MARK: - Seeding from the last session

    /// Groups the sets of `GET /api/workouts/last` into per-exercise drafts,
    /// keeping first-appearance order of exercises and `setIndex` order of
    /// sets. Empty input → no drafts.
    static func drafts(from sets: [WorkoutSetDTO], system: UnitSystem) -> [LiftDraftExercise] {
        var order: [String] = []
        var grouped: [String: [WorkoutSetDTO]] = [:]
        for set in sets {
            if grouped[set.exercise] == nil { order.append(set.exercise) }
            grouped[set.exercise, default: []].append(set)
        }
        return order.map { key -> LiftDraftExercise in
            let ordered = (grouped[key] ?? []).sorted { $0.setIndex < $1.setIndex }
            let name = ordered.first.map { $0.exerciseDisplay } ?? displayName(forKey: key)
            let draftSets = ordered.map { set in
                LiftDraftSet(
                    reps: min(max(set.reps, minReps), maxReps),
                    load: displayLoad(fromKg: set.loadKg, system: system),
                    isWarmup: set.isWarmup
                )
            }
            return LiftDraftExercise(
                key: key, name: name, sets: draftSets,
                history: history(forKey: key, from: sets, system: system)
            )
        }
    }

    /// Which exercise to ask `/api/workouts/last` about when the caller
    /// has no preference: the one trained in the most recent week of the
    /// summary (ties → more sets that week → alphabetical). `nil` when the
    /// summary has no weeks at all (never logged → empty form).
    static func seedExercise(from summary: WorkoutSummaryResponse) -> String? {
        var best: (key: String, week: String, sets: Int)?
        for (key, stats) in summary.exercises {
            guard let latest = stats.max(by: { $0.weekStart < $1.weekStart }) else { continue }
            let candidate = (key: key, week: latest.weekStart, sets: latest.totalSets)
            if let current = best {
                let isBetter: Bool
                if candidate.week != current.week {
                    isBetter = candidate.week > current.week
                } else if candidate.sets != current.sets {
                    isBetter = candidate.sets > current.sets
                } else {
                    isBetter = candidate.key < current.key
                }
                if isBetter { best = candidate }
            } else {
                best = candidate
            }
        }
        return best?.key
    }

    // MARK: - Request body

    /// Flattens the drafts into the POST body. `setIndex` is a 1-based
    /// position across the WHOLE session (the table is unique on
    /// `(session_id, set_index)`, so per-exercise numbering would collide).
    /// Sets with fewer than 1 rep and exercises with no name are dropped.
    static func inputs(from drafts: [LiftDraftExercise], system: UnitSystem) -> [WorkoutSetInputDTO] {
        var result: [WorkoutSetInputDTO] = []
        for exercise in drafts {
            let display = exercise.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = canonicalKey(from: exercise.key.isEmpty ? display : exercise.key)
            guard !display.isEmpty, !key.isEmpty else { continue }
            for set in exercise.sets where set.reps >= minReps {
                result.append(
                    WorkoutSetInputDTO(
                        exercise: key,
                        exerciseDisplay: display,
                        setIndex: result.count + 1,
                        reps: set.reps,
                        loadKg: kg(fromDisplayLoad: set.load, system: system),
                        rpe: clampRPE(set.rpe),
                        isWarmup: set.isWarmup
                    )
                )
            }
        }
        return result
    }

    /// "template" when the user saved the pre-filled "repeat last session"
    /// untouched; "manual" as soon as anything was edited, added or typed.
    /// Done ticks are ignored: ticking every set of an unedited repeat is still
    /// a template log (ticking only some saves a subset, which is "manual").
    static func source(drafts: [LiftDraftExercise], seeded: [LiftDraftExercise]) -> String {
        !seeded.isEmpty && clearingDone(drafts) == clearingDone(seeded) ? "template" : "manual"
    }

    private static func clearingDone(_ drafts: [LiftDraftExercise]) -> [LiftDraftExercise] {
        drafts.map { exercise in
            var cleared = exercise
            cleared.sets = exercise.sets.map { set in
                var copy = set
                copy.isDone = false
                return copy
            }
            return cleared
        }
    }

    /// Plain summary of a draft exercise, e.g. "3 sets · 5 reps · 100 kg" —
    /// used as the section footer.
    static func summaryLine(for exercise: LiftDraftExercise, system: UnitSystem) -> String {
        let working = exercise.sets.filter { !$0.isWarmup }
        guard let top = working.max(by: { $0.load < $1.load }) else {
            return "\(exercise.sets.count) \(exercise.sets.count == 1 ? "set" : "sets")"
        }
        let setsText = "\(working.count) \(working.count == 1 ? "set" : "sets")"
        return "\(setsText) · top \(top.reps) × \(loadText(top.load, system: system))"
    }
}
