import Foundation
import SwiftUI

/// The strength endpoints the lift logger needs — a seam so
/// `LiftLoggerViewModelTests` can inject a fake. `APIClient` conforms below
/// (same idiom as `TrendsAPIProviding`).
@MainActor
protocol LiftLoggerAPIProviding {
    func fetchWorkoutSummary(days: Int) async throws -> WorkoutSummaryResponse
    func fetchLastWorkoutSession(exercise: String) async throws -> WorkoutLastSessionResponse
    func fetchRecentWorkoutSessions(limit: Int) async throws -> WorkoutRecentSessionsResponse
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
    /// Recent distinct sessions (newest first) for the "Repeat: …" menu.
    @Published private(set) var recentSessions: [RecentSessionDTO] = []
    /// Session id currently pre-filled into the form (`nil` = none/manual).
    @Published private(set) var repeatedSessionId: String? = nil
    /// The day being logged (sent as `performedAt`); defaults to now, capped
    /// at today by the view's DatePicker.
    @Published var performedDate = Date()
    /// Canonical key → display for every exercise the user has logged (summary
    /// keys + recent sessions) — feeds autocomplete.
    @Published private(set) var knownExercises: [LiftExerciseOption] = []

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
            rebuildKnownExercises()
            if let seed = LiftLoggerLogic.seedExercise(from: summary), !candidates.contains(seed) {
                candidates.append(seed)
            }
        } catch {
            if !error.isCancellation {
                print("[Vital] LiftLoggerViewModel.load summary failed: \(error.localizedDescription)")
            }
        }

        do {
            recentSessions = try await api.fetchRecentWorkoutSessions(limit: 8).sessions
            rebuildKnownExercises()
        } catch {
            if !error.isCancellation {
                print("[Vital] LiftLoggerViewModel.load sessions failed: \(error.localizedDescription)")
            }
        }

        for key in candidates {
            do {
                let last = try await api.fetchLastWorkoutSession(exercise: key)
                let drafts = LiftLoggerLogic.drafts(from: last.sets, system: system)
                if !drafts.isEmpty {
                    exercises = drafts
                    seeded = drafts
                    repeatedSessionId = last.sets.first?.sessionId
                    break
                }
            } catch {
                if !error.isCancellation {
                    print("[Vital] LiftLoggerViewModel.load last session failed: \(error.localizedDescription)")
                }
            }
        }

        // Nothing seeded via /last (older backend, fail-soft) but the sessions
        // list has history: repeat the newest one.
        if exercises.isEmpty, let latest = recentSessions.first {
            applySession(latest)
        }

        isLoading = false
    }

    private func rebuildKnownExercises() {
        var byKey: [String: String] = [:]
        for key in suggestions { byKey[key] = LiftLoggerLogic.displayName(forKey: key) }
        for session in recentSessions {
            for exercise in session.exercises { byKey[exercise.exercise] = exercise.display }
        }
        knownExercises = byKey.map { LiftExerciseOption(key: $0.key, display: $0.value) }
            .sorted { $0.key < $1.key }
    }

    // MARK: - Pick a session to repeat

    /// Replaces the form with a recent session (the "Repeat: …" menu).
    func repeatSession(id: String) {
        guard let session = recentSessions.first(where: { $0.sessionId == id }) else { return }
        applySession(session)
    }

    private func applySession(_ session: RecentSessionDTO) {
        let drafts = LiftLoggerLogic.drafts(from: session, system: system)
        guard !drafts.isEmpty else { return }
        exercises = drafts
        seeded = drafts
        repeatedSessionId = session.sessionId
    }

    /// The recent session currently repeated, for the menu's label.
    var repeatedSession: RecentSessionDTO? {
        recentSessions.first { $0.sessionId == repeatedSessionId }
    }

    // MARK: - Autocomplete

    /// The user's own past exercises matching the "add exercise" field.
    var completions: [LiftExerciseOption] {
        LiftLoggerLogic.completions(
            for: newExerciseName, in: knownExercises, excluding: Set(exercises.map { $0.key })
        )
    }

    // MARK: - Editing

    private func index(ofExercise id: UUID) -> Int? {
        exercises.firstIndex { $0.id == id }
    }

    /// Appends a set to the exercise, copying the previous set's reps/load
    /// (the common "same again" case); a fresh exercise starts at 5 reps.
    func addSet(to exerciseID: UUID) {
        guard let i = index(ofExercise: exerciseID) else { return }
        // Copy the last WORKING set (a warm-up's light load isn't "same again").
        let previous = exercises[i].sets.last(where: { !$0.isWarmup }) ?? exercises[i].sets.last
        let history = exercises[i].history
        let next = exercises[i].sets.filter { !$0.isWarmup }.count
        exercises[i].sets.append(
            LiftDraftSet(
                reps: previous?.reps ?? LiftLoggerLogic.defaultReps,
                load: previous?.load ?? 0,
                isWarmup: false,
                last: next < history.count ? history[next] : nil
            )
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
        let draft = LiftDraftExercise(
            key: key, name: name, sets: [LiftDraftSet(reps: LiftLoggerLogic.defaultReps, load: 0)]
        )
        exercises.append(draft)
        // Smart seeding: fill from this exercise's own last session when the
        // fetch lands (fail-soft; the blank set stays usable meanwhile).
        Task { [weak self] in await self?.seedFromHistory(exerciseID: draft.id) }
    }

    /// Fetches `/api/workouts/last` for the exercise and pre-fills its sets
    /// (working sets of THAT exercise only) with per-set "last: …" hints. Only
    /// replaces the sets while the user hasn't touched the placeholder set,
    /// so a fast typist is never overwritten.
    func seedFromHistory(exerciseID: UUID) async {
        guard let i = index(ofExercise: exerciseID) else { return }
        let key = exercises[i].key
        let placeholderID = exercises[i].sets.first?.id
        let response: WorkoutLastSessionResponse
        do {
            response = try await api.fetchLastWorkoutSession(exercise: key)
        } catch {
            if !error.isCancellation {
                print("[Vital] LiftLoggerViewModel.seedFromHistory failed: \(error.localizedDescription)")
            }
            return
        }
        let history = LiftLoggerLogic.history(forKey: key, from: response.sets, system: system)
        guard !history.isEmpty, let j = index(ofExercise: exerciseID) else { return }
        exercises[j].history = history
        let untouched = exercises[j].sets.count == 1
            && exercises[j].sets[0].id == placeholderID
            && exercises[j].sets[0].reps == LiftLoggerLogic.defaultReps
            && exercises[j].sets[0].load == 0
            && !exercises[j].sets[0].isWarmup
            && exercises[j].sets[0].rpe == nil
        if untouched { exercises[j].sets = LiftLoggerLogic.seededSets(from: history) }
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
            .map { "\($0.exercise):\($0.setIndex):\($0.reps):\($0.loadKg ?? 0):\($0.isWarmup):\($0.rpe ?? 0)" }
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
                performedAt: performedDate,
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
