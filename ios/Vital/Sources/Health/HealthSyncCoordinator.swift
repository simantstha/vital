import Foundation
import HealthKit

/// Drives ongoing background HealthKit sync, as a companion to the one-time
/// `BackfillCoordinator`: registers `enableBackgroundDelivery` + an
/// `HKObserverQuery` for each backfilled sample type, and on every
/// fire re-aggregates only the days those samples touched (reusing
/// `HealthKitBackfill`'s bucket logic) before posting through
/// `/api/ingest/daily` — the same idempotent upsert the backfill uses, so
/// overlap between the two is harmless.
///
/// Anchor persistence: each type's `HKQueryAnchor` is archived with
/// `NSKeyedArchiver` (`requiringSecureCoding: true`) into `UserDefaults` under
/// a per-type key, so an anchored query only ever asks HealthKit for samples
/// added/deleted since the last successful sync — not a full re-scan.
@MainActor
final class HealthSyncCoordinator: ObservableObject {
    static let sleepBackgroundFrequency: HKUpdateFrequency = .immediate

    static let shared = HealthSyncCoordinator()

    /// True while a sync sweep (debounced observer fire or `syncNow()`) is
    /// in flight. Exposed for a future "syncing…" indicator; not required
    /// for correctness.
    @Published var isSyncing = false
    @Published var lastSyncError: String?
    @Published var lastSyncDate: Date?

    private let store = HKHealthStore()
    private let backfill: HealthKitBackfill
    private let apiClient: APIClient
    private let calendar = Calendar.current

    private var didRegister = false
    private var observerQueries: [HKObserverQuery] = []

    /// Observer fires within `debounceNanoseconds` of each other collapse
    /// into a single aggregation pass. Each fire's completion handler is
    /// queued here and called once that pass finishes — HealthKit just needs
    /// the handler called eventually, not synchronously per fire.
    private var pendingCompletionHandlers: [HKObserverQueryCompletionHandler] = []
    private var debounceTask: Task<Void, Never>?
    private static let debounceNanoseconds: UInt64 = 3_000_000_000 // 3s

    init(
        backfill: HealthKitBackfill = HealthKitBackfill(),
        apiClient: APIClient = .shared
    ) {
        self.backfill = backfill
        self.apiClient = apiClient
    }

    // MARK: - Registration (called once, before app launch finishes)

    /// Enables background delivery and starts an `HKObserverQuery` for each
    /// backfilled sample type. Idempotent — safe to call more than once (e.g.
    /// if both the AppDelegate path and a later foreground path both try).
    /// Callers are expected to guard this on "a session token exists" so it
    /// never registers signed-out (registering without read authorization is
    /// harmless but pointless — there's nothing to observe yet).
    func registerBackgroundDelivery() async {
        guard !didRegister else { return }
        didRegister = true
        guard HKHealthStore.isHealthDataAvailable() else { return }

        for syncType in Self.syncTypes {
            do {
                try await store.enableBackgroundDelivery(
                    for: syncType.sampleType, frequency: syncType.frequency
                )
            } catch {
                print("[HealthSync] enableBackgroundDelivery failed for \(syncType.anchorKey): \(error.localizedDescription)")
            }

            let query = makeObserverQuery(for: syncType)
            observerQueries.append(query)
            store.execute(query)
        }
    }

    // MARK: - Foreground refresh

    /// Runs the same anchored-query sweep an observer fire would, immediately
    /// (no debounce). Called from `TodayViewModel.loadFromHealthKit` so a
    /// fresh app launch doesn't wait on the next background observer fire.
    func syncNow() async {
        await performSync()
    }

    // MARK: - Observer plumbing

    private func makeObserverQuery(for syncType: SyncType) -> HKObserverQuery {
        HKObserverQuery(sampleType: syncType.sampleType, predicate: nil) { [weak self] _, completionHandler, error in
            if let error {
                print("[HealthSync] observer fired with error for \(syncType.anchorKey): \(error.localizedDescription)")
                completionHandler()
                return
            }
            Task { @MainActor in
                self?.scheduleDebouncedSync(completion: completionHandler)
            }
        }
    }

    private func scheduleDebouncedSync(completion: @escaping HKObserverQueryCompletionHandler) {
        pendingCompletionHandlers.append(completion)
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            guard !Task.isCancelled else { return }
            await self?.flushPendingSync()
        }
    }

    private func flushPendingSync() async {
        let handlers = pendingCompletionHandlers
        pendingCompletionHandlers = []
        await performSync()
        handlers.forEach { $0() }
    }

    // MARK: - Sync sweep

    /// Runs an anchored-object query per type (cheap — only returns
    /// added/deleted samples since the last stored anchor), unions the local
    /// days those samples touched, re-aggregates just those days via
    /// `HealthKitBackfill`, and posts them through the same
    /// `/api/ingest/daily` upsert the backfill uses.
    private func performSync() async {
        guard !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        lastSyncError = nil

        var touchedDays = Set<Date>()

        for syncType in Self.syncTypes {
            let (days, hadDeletions) = await runAnchoredQuery(for: syncType)
            touchedDays.formUnion(days)

            if hadDeletions {
                // HKDeletedObject carries a UUID only, never a date, so a
                // deletion can't be attributed to the day it affected.
                // Conservatively widen the window to catch same-day
                // corrections (e.g. a duplicate workout removed right after
                // logging) rather than silently missing them.
                let today = calendar.startOfDay(for: Date())
                touchedDays.insert(today)
                if let yesterday = calendar.date(byAdding: .day, value: -1, to: today) {
                    touchedDays.insert(yesterday)
                }
            }
        }

        guard !touchedDays.isEmpty else { return }

        do {
            let minDay = touchedDays.min()!
            let maxDay = touchedDays.max()!
            let rangeEnd = calendar.date(byAdding: .day, value: 1, to: maxDay) ?? maxDay

            var days = try await backfill.buildIngestDays(from: minDay, to: rangeEnd)

            // buildIngestDays(from:to:) can return incidental days inside the
            // range that weren't actually touched (e.g. old data that just
            // happens to fall between minDay and maxDay); restrict the post
            // to the exact touched days.
            let touchedDayStrings = Set(touchedDays.map { HealthKitBackfill.dayFormatter.string(from: $0) })
            days = days.filter { touchedDayStrings.contains($0.date) }

            guard !days.isEmpty else { return }

            _ = try await apiClient.postDailyIngest(days: days)
            lastSyncDate = Date()
        } catch {
            lastSyncError = error.localizedDescription
            print("[HealthSync] sync failed: \(error.localizedDescription)")
        }
    }

    /// Runs one `HKAnchoredObjectQuery`, persists the returned anchor, and
    /// reports the local days its added samples fall on plus whether any
    /// deletions were reported.
    private func runAnchoredQuery(for syncType: SyncType) async -> (touchedDays: Set<Date>, hadDeletions: Bool) {
        guard HKHealthStore.isHealthDataAvailable() else { return ([], false) }
        let anchor = Self.loadAnchor(key: syncType.anchorKey)

        return await withCheckedContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: syncType.sampleType,
                predicate: nil,
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { [calendar] _, samplesOrNil, deletedOrNil, newAnchor, error in
                if let error {
                    print("[HealthSync] anchored query failed for \(syncType.anchorKey): \(error.localizedDescription)")
                    continuation.resume(returning: ([], false))
                    return
                }

                if let newAnchor {
                    Self.saveAnchor(newAnchor, key: syncType.anchorKey)
                }

                var days = Set<Date>()
                for sample in samplesOrNil ?? [] {
                    days.insert(calendar.startOfDay(for: sample.startDate))
                }

                let hadDeletions = !(deletedOrNil ?? []).isEmpty
                continuation.resume(returning: (days, hadDeletions))
            }
            store.execute(query)
        }
    }

    // MARK: - Anchor persistence

    private static func loadAnchor(key: String) -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private static func saveAnchor(_ anchor: HKQueryAnchor, key: String) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
        else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    // MARK: - Sample type table

    private struct SyncType {
        let sampleType: HKSampleType
        let anchorKey: String
        let frequency: HKUpdateFrequency
    }

    /// The same types `HealthKitManager`/`HealthKitBackfill` authorize and
    /// backfill. Frequencies per the hand-off plan: hourly for the
    /// high-volume/streaming types (steps, heart rate, active energy), daily
    /// for the rest.
    private static let syncTypes: [SyncType] = {
        var types: [SyncType] = []

        func addQuantity(_ id: HKQuantityTypeIdentifier, key: String, frequency: HKUpdateFrequency) {
            guard let type = HKObjectType.quantityType(forIdentifier: id) else { return }
            types.append(SyncType(sampleType: type, anchorKey: key, frequency: frequency))
        }

        addQuantity(.heartRateVariabilitySDNN, key: "sync.anchor.hrvSdnn", frequency: .daily)
        addQuantity(.restingHeartRate, key: "sync.anchor.restingHr", frequency: .daily)
        addQuantity(.heartRate, key: "sync.anchor.heartRate", frequency: .hourly)
        addQuantity(.stepCount, key: "sync.anchor.steps", frequency: .hourly)
        addQuantity(.activeEnergyBurned, key: "sync.anchor.activeEnergy", frequency: .hourly)
        addQuantity(.bodyMass, key: "sync.anchor.bodyMass", frequency: .daily)
        // Expanded coverage (aggregated via the same buildIngestDays path).
        addQuantity(.vo2Max, key: "sync.anchor.vo2Max", frequency: .daily)
        addQuantity(.distanceWalkingRunning, key: "sync.anchor.distance", frequency: .hourly)
        addQuantity(.appleExerciseTime, key: "sync.anchor.exercise", frequency: .hourly)
        addQuantity(.flightsClimbed, key: "sync.anchor.flights", frequency: .hourly)
        addQuantity(.basalEnergyBurned, key: "sync.anchor.basalEnergy", frequency: .hourly)

        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.append(SyncType(sampleType: sleepType, anchorKey: "sync.anchor.sleep", frequency: sleepBackgroundFrequency))
        }

        types.append(SyncType(sampleType: HKObjectType.workoutType(), anchorKey: "sync.anchor.workouts", frequency: .immediate))

        return types
    }()
}
