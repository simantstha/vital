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

    init(
        id: UUID = UUID(), reps: Int, load: Double, isWarmup: Bool = false,
        rpe: Double? = nil, last: LiftLastRef? = nil
    ) {
        self.id = id
        self.reps = reps
        self.load = load
        self.isWarmup = isWarmup
        self.rpe = rpe
        self.last = last
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
            return LiftDraftExercise(key: exercise.exercise, name: exercise.display, sets: sets)
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

    /// "142.5" / "140" — whole numbers unadorned, otherwise one decimal.
    static func loadText(_ load: Double, system: UnitSystem) -> String {
        guard load > 0 else { return "Bodyweight" }
        return "\(numberText(load)) \(system.weightUnit)"
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
            return LiftDraftExercise(key: key, name: name, sets: draftSets)
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
    static func source(drafts: [LiftDraftExercise], seeded: [LiftDraftExercise]) -> String {
        !seeded.isEmpty && drafts == seeded ? "template" : "manual"
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
