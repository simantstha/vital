import Foundation

/// Drives the one-time 365-day HealthKit backfill: builds daily DTOs via
/// `HealthKitBackfill`, then uploads them to `/api/ingest/daily` in
/// resumable, retryable chunks.
///
/// Resume design: after each chunk succeeds, the max date in that chunk is
/// persisted as `backfill.lastCompletedDate`. If the app is killed mid-run,
/// the next `startIfNeeded()` call re-fetches the full HealthKit history but
/// drops everything up to and including that date before uploading — so a
/// killed app picks up where it left off instead of re-posting everything
/// (the server-side upsert would make re-posting harmless, but skipping is
/// cheaper and gives an honest progress readout). Once a run that actually
/// uploaded data finishes, `backfill.completed` is set and `startIfNeeded()`
/// becomes a no-op after (until UserDefaults is cleared on sign-out, or the
/// user triggers `resync()`). An *empty* run never marks complete, so it isn't
/// permanently disabled by a first attempt made before HealthKit access is
/// granted (see problem-04).
@MainActor
final class BackfillCoordinator: ObservableObject {

    @Published var progress: Double = 0
    @Published var daysUploaded: Int = 0
    @Published var isComplete: Bool = false
    @Published var lastError: String?

    /// Guards against overlapping runs: the Calibrating onboarding step and
    /// RootTabView's own `.task` can both call `startIfNeeded()` for the same
    /// still-in-progress backfill (onboarding kicks it off, then the user
    /// lands on the tab UI before it finishes). The server-side upsert makes
    /// re-posting harmless, but there's no reason to double the network
    /// traffic client-side.
    private var isRunning = false

    private enum Keys {
        static let completed = "backfill.completed"
        static let lastCompletedDate = "backfill.lastCompletedDate"
        /// Tracks which set of HealthKit read types this install has been
        /// prompted for. `requestAuthorization()` is only ever reached from
        /// onboarding and `startIfNeeded()` — and `startIfNeeded()` is a
        /// permanent no-op once `completed` is set — so an existing install
        /// would otherwise never see the system prompt for a type added
        /// after its first launch. Bump `Config.currentAuthGeneration` (and
        /// this comment) whenever `HealthKitManager.readTypes` grows.
        static let authGeneration = "backfill.authGeneration"
    }

    private enum Config {
        static let totalDays = 365
        static let chunkSize = 30
        /// Delay before each retry, in seconds — 3 retries beyond the initial
        /// attempt (4 tries total per chunk).
        static let retryDelaysSeconds: [UInt64] = [1, 4, 16]
        /// Generation 2 added dietary intake (energy/protein/carbs/fat) —
        /// see `refreshAuthorizationIfNeeded()`.
        static let currentAuthGeneration = 2
        /// How far back to re-post when a generation bump grants a new type,
        /// so it shows up promptly without waiting on the (permanently
        /// disabled) 365-day backfill.
        static let authRefreshDays = 90
    }

    private let healthKitManager: HealthKitManager
    private let backfill: HealthKitBackfill
    private let apiClient: APIClient
    private let defaults: UserDefaults

    init(
        healthKitManager: HealthKitManager? = nil,
        backfill: HealthKitBackfill = HealthKitBackfill(),
        apiClient: APIClient = .shared,
        defaults: UserDefaults = .standard
    ) {
        // `HealthKitManager` is @MainActor-isolated, so it can't be
        // constructed as a default *parameter* value (those are evaluated in
        // a nonisolated context); build it in the init body instead, which
        // does inherit this class's @MainActor isolation.
        self.healthKitManager = healthKitManager ?? HealthKitManager()
        self.backfill = backfill
        self.apiClient = apiClient
        self.defaults = defaults
    }

    /// Re-requests HealthKit authorization when this install hasn't seen the
    /// current set of read types yet (tracked via `Keys.authGeneration`), then
    /// re-posts the trailing `Config.authRefreshDays` days so a newly-granted
    /// type (e.g. dietary intake) shows up right away instead of waiting on
    /// `startIfNeeded()` — which is a permanent no-op for any install whose
    /// 365-day backfill already completed. Safe to call every launch: it's a
    /// no-op once the stored generation catches up, and re-posting existing
    /// days is harmless (the server upsert is idempotent on
    /// (user_id, date, metric)). The generation is persisted only after a
    /// successful upload, so a network failure retries on the next launch
    /// instead of silently giving up.
    func refreshAuthorizationIfNeeded() async {
        guard defaults.integer(forKey: Keys.authGeneration) < Config.currentAuthGeneration else { return }

        // A fresh install (generation 0) hasn't completed the 365-day
        // backfill yet, so `startIfNeeded()` is about to run and will
        // request authorization for the full current `readTypes` set anyway
        // (including the dietary types this generation bump exists for) —
        // running the 90-day re-post here too would prompt for auth and
        // upload the same range twice. Just stamp the generation and let
        // `startIfNeeded()` do the one real backfill.
        guard defaults.bool(forKey: Keys.completed) else {
            defaults.set(Config.currentAuthGeneration, forKey: Keys.authGeneration)
            return
        }

        await healthKitManager.requestAuthorization()

        do {
            let end = Date()
            let start = Calendar.current.date(byAdding: .day, value: -Config.authRefreshDays, to: end) ?? end
            let days = try await backfill.buildIngestDays(from: start, to: end)

            for chunkStart in stride(from: 0, to: days.count, by: Config.chunkSize) {
                let chunkEnd = min(chunkStart + Config.chunkSize, days.count)
                try await uploadWithRetry(Array(days[chunkStart..<chunkEnd]))
            }

            defaults.set(Config.currentAuthGeneration, forKey: Keys.authGeneration)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// No-op if the backfill already completed. Otherwise requests HealthKit
    /// read authorization (reusing the existing central auth path — no
    /// duplicated permission logic), builds the day list, and uploads
    /// whatever hasn't already been uploaded.
    func startIfNeeded() async {
        guard !defaults.bool(forKey: Keys.completed) else {
            isComplete = true
            progress = 1
            return
        }
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        lastError = nil

        await healthKitManager.requestAuthorization()

        do {
            var days = try await backfill.buildIngestDays(days: Config.totalDays)
            days.sort { $0.date < $1.date }

            if let lastCompletedDate = defaults.string(forKey: Keys.lastCompletedDate) {
                days = days.filter { $0.date > lastCompletedDate }
            }

            guard !days.isEmpty else {
                // Nothing to upload — HealthKit read access isn't granted yet,
                // or no history has synced to this device. Do NOT mark complete:
                // marking here would permanently disable the backfill after an
                // empty first run (e.g. the query racing ahead of authorization),
                // leaving the account with only whatever the daily sync trickles
                // in. Leaving `completed` unset lets a later launch retry once
                // access is granted / data appears. (See problem-04.)
                return
            }

            let total = days.count
            var uploaded = 0

            for chunkStart in stride(from: 0, to: days.count, by: Config.chunkSize) {
                let chunkEnd = min(chunkStart + Config.chunkSize, days.count)
                let chunk = Array(days[chunkStart..<chunkEnd])

                try await uploadWithRetry(chunk)

                uploaded += chunk.count
                daysUploaded += chunk.count
                progress = Double(uploaded) / Double(total)

                if let maxDate = chunk.map(\.date).max() {
                    defaults.set(maxDate, forKey: Keys.lastCompletedDate)
                }
            }

            markComplete()
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Clears the completion flags and re-runs the backfill from scratch.
    /// Recovery path for an account whose backfill self-completed early (before
    /// this fix) and is now stuck as a permanent no-op — surfaced as a manual
    /// "Re-sync health history" action in Profile. Server ingest is an idempotent
    /// upsert, so re-uploading existing days is harmless.
    func resync() async {
        defaults.removeObject(forKey: Keys.completed)
        defaults.removeObject(forKey: Keys.lastCompletedDate)
        isComplete = false
        progress = 0
        daysUploaded = 0
        await startIfNeeded()
    }

    // MARK: - Private

    private func uploadWithRetry(_ chunk: [DailyIngestDay]) async throws {
        var attemptError: Error?

        for attempt in 0...Config.retryDelaysSeconds.count {
            do {
                _ = try await apiClient.postDailyIngest(days: chunk)
                return
            } catch {
                attemptError = error
                guard attempt < Config.retryDelaysSeconds.count else { break }
                try? await Task.sleep(nanoseconds: Config.retryDelaysSeconds[attempt] * 1_000_000_000)
            }
        }

        throw attemptError ?? APIError.serverError(-1)
    }

    private func markComplete() {
        defaults.set(true, forKey: Keys.completed)
        isComplete = true
        progress = 1
    }
}
