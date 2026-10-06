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

    init(id: UUID = UUID(), reps: Int, load: Double, isWarmup: Bool = false) {
        self.id = id
        self.reps = reps
        self.load = load
        self.isWarmup = isWarmup
    }
}

/// One exercise block (a Form section) in the lift logger. `key` is the
/// canonical lowercase name the server groups by; `name` is what's shown and
/// sent as `exerciseDisplay`.
struct LiftDraftExercise: Identifiable, Equatable {
    let id: UUID
    var key: String
    var name: String
    var sets: [LiftDraftSet]

    init(id: UUID = UUID(), key: String, name: String, sets: [LiftDraftSet]) {
        self.id = id
        self.key = key
        self.name = name
        self.sets = sets
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
        let number = load.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(load))
            : String(format: "%.1f", load)
        return "\(number) \(system.weightUnit)"
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
                        rpe: nil,
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
