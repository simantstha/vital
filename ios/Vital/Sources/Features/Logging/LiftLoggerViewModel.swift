import Foundation
import SwiftUI

/// The three strength endpoints the lift logger needs — a seam so
/// `LiftLoggerViewModelTests` can inject a fake. `APIClient` conforms below
/// (same idiom as `TrendsAPIProviding`).
@MainActor
protocol LiftLoggerAPIProviding {
    func fetchWorkoutSummary(days: Int) async throws -> WorkoutSummaryResponse
    func fetchLastWorkoutSession(exercise: String) async throws -> WorkoutLastSessionResponse
    func logWorkoutSets(
        sessionId: String,
        source: String,
        sets: [WorkoutSetInputDTO],
        performedAt: Date,
        tz: String?
    ) async throws -> LogWorkoutSetsResponse
}

extension APIClient: LiftLoggerAPIProviding {}

/// Drives the "Log lift" sheet: seeds the form from the user's last session
/// ("Repeat last session" — `GET /api/workouts/last`), lets them tweak reps/load
/// per set, add sets/exercises, and saves with `POST /api/workouts/sets`.
@MainActor
final class LiftLoggerViewModel: ObservableObject {

    @Published var exercises: [LiftDraftExercise] = []
    /// Canonical keys of exercises the user has logged before — one-tap
    /// "add exercise" chips.
    @Published private(set) var suggestions: [String] = []
    @Published private(set) var isLoading = true
    @Published private(set) var isSaving = false
    /// Flips to `true` once after a successful save; the view fires the
    /// success haptic and dismisses off it.
    @Published private(set) var didSave = false
    @Published var errorMessage: String? = nil
    /// Backing text of the "add exercise" field.
    @Published var newExerciseName = ""

    let system: UnitSystem
    /// Client-generated UUID for the whole session: groups the sets and makes
    /// a retried POST idempotent (the server upserts on session + set index).
    /// Regenerated when payload changes after a failed save.
    private(set) var sessionId: String

    private let api: LiftLoggerAPIProviding
    private let preferredExercise: String?
    /// The drafts exactly as seeded from the last session — an unedited save
    /// of these is a "template" (repeat) log; anything else is "manual".
    private var seeded: [LiftDraftExercise] = []
    private var hasLoaded = false
    private var lastSavePayloadSignature: String? = nil

    /// `preferredExercise` is the exercise to repeat first (Today's "last
    /// lift") — tried before falling back to whichever exercise the summary
    /// says was trained most recently. Both may be absent (never logged →
    /// empty form).
    init(
        preferredExercise: String? = nil,
        system: UnitSystem? = nil,
        sessionId: String = UUID().uuidString,
        api: LiftLoggerAPIProviding = APIClient.shared
    ) {
        self.preferredExercise = preferredExercise
        self.system = system ?? UnitPreference.shared.current
        self.sessionId = sessionId
        self.api = api
    }

    // MARK: - Load ("Repeat last session")

    /// Fail-soft: any failure just leaves the form empty (the user can still
    /// log from scratch) — never an error card for a prefill.
    func load() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        isLoading = true

        var candidates: [String] = []
        if let preferredExercise {
            let key = LiftLoggerLogic.canonicalKey(from: preferredExercise)
            if !key.isEmpty { candidates.append(key) }
        }

        do {
            let summary = try await api.fetchWorkoutSummary(days: 84)
            suggestions = summary.exercises.keys.sorted()
            if let seed = LiftLoggerLogic.seedExercise(from: summary), !candidates.contains(seed) {
                candidates.append(seed)
            }
        } catch {
            if !error.isCancellation {
                print("[Vital] LiftLoggerViewModel.load summary failed: \(error.localizedDescription)")
            }
        }

        for key in candidates {
            do {
                let last = try await api.fetchLastWorkoutSession(exercise: key)
                let drafts = LiftLoggerLogic.drafts(from: last.sets, system: system)
                if !drafts.isEmpty {
                    exercises = drafts
                    seeded = drafts
                    break
                }
            } catch {
                if !error.isCancellation {
                    print("[Vital] LiftLoggerViewModel.load last session failed: \(error.localizedDescription)")
                }
            }
        }

        isLoading = false
    }

    // MARK: - Editing

    private func index(ofExercise id: UUID) -> Int? {
        exercises.firstIndex { $0.id == id }
    }

    /// Appends a set to the exercise, copying the previous set's reps/load
    /// (the common "same again" case); a fresh exercise starts at 5 reps.
    func addSet(to exerciseID: UUID) {
        guard let i = index(ofExercise: exerciseID) else { return }
        let previous = exercises[i].sets.last
        exercises[i].sets.append(
            LiftDraftSet(reps: previous?.reps ?? 5, load: previous?.load ?? 0, isWarmup: false)
        )
    }

    /// Removes sets by offset; an exercise left with no sets is dropped.
    func removeSets(in exerciseID: UUID, at offsets: IndexSet) {
        guard let i = index(ofExercise: exerciseID) else { return }
        exercises[i].sets.remove(atOffsets: offsets)
        if exercises[i].sets.isEmpty { exercises.remove(at: i) }
    }

    func removeExercise(_ exerciseID: UUID) {
        exercises.removeAll { $0.id == exerciseID }
    }

    /// Adds the exercise typed into the "add exercise" field.
    func addTypedExercise() {
        addExercise(named: newExerciseName)
        newExerciseName = ""
    }

    /// Adds an exercise by name (typed, or a suggestion chip's canonical key).
    /// Naming one already in the form just adds a set to it.
    func addExercise(named rawName: String) {
        let trimmed = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = LiftLoggerLogic.canonicalKey(from: trimmed)
        guard !key.isEmpty else { return }
        if let existing = exercises.first(where: { $0.key == key }) {
            addSet(to: existing.id)
            return
        }
        // A canonical key shown as-is ("bench press") reads better title-cased;
        // a name the user typed keeps their capitalization.
        let name = trimmed == key ? LiftLoggerLogic.displayName(forKey: key) : trimmed
        exercises.append(
            LiftDraftExercise(key: key, name: name, sets: [LiftDraftSet(reps: 5, load: 0)])
        )
    }

    /// True when the form was pre-filled from the user's last session.
    var isRepeatingLast: Bool { !seeded.isEmpty }

    /// Suggestions not already in the form.
    var availableSuggestions: [String] {
        let used = Set(exercises.map { $0.key })
        return suggestions.filter { !used.contains($0) }
    }

    // MARK: - Save

    var canSave: Bool {
        !isSaving && !LiftLoggerLogic.inputs(from: exercises, system: system).isEmpty
    }

    private func payloadSignature() -> String {
        LiftLoggerLogic.inputs(from: exercises, system: system)
            .map { "\($0.exercise):\($0.setIndex):\($0.reps):\($0.loadKg ?? 0)" }
            .joined(separator: "|")
    }

    /// `POST /api/workouts/sets`. On success posts `.vitalWorkoutLogged`
    /// (Trends refreshes its Strength card) and flips `didSave`. On failure
    /// keeps the form so the user can retry. Reuses `sessionId` only if payload
    /// is identical; generates fresh `sessionId` if form changed.
    func save() async {
        guard !isSaving else { return }
        let inputs = LiftLoggerLogic.inputs(from: exercises, system: system)
        guard !inputs.isEmpty else {
            errorMessage = "Add at least one set with reps."
            return
        }
        let currentSignature = payloadSignature()
        if let lastSig = lastSavePayloadSignature, lastSig != currentSignature {
            sessionId = UUID().uuidString
        }
        lastSavePayloadSignature = currentSignature
        isSaving = true
        errorMessage = nil
        do {
            _ = try await api.logWorkoutSets(
                sessionId: sessionId,
                source: LiftLoggerLogic.source(drafts: exercises, seeded: seeded),
                sets: inputs,
                performedAt: Date(),
                tz: TimeZone.current.identifier
            )
            NotificationCenter.default.post(name: .vitalWorkoutLogged, object: nil)
            didSave = true
        } catch {
            if !error.isCancellation {
                errorMessage = UserFacingError.message(
                    for: error, context: .write, tag: "LiftLoggerViewModel.save", includesAction: true
                )
            }
        }
        isSaving = false
    }
}
