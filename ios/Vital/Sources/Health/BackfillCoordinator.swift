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
    }

    private enum Config {
        static let totalDays = 365
        static let chunkSize = 30
        /// Delay before each retry, in seconds — 3 retries beyond the initial
        /// attempt (4 tries total per chunk).
        static let retryDelaysSeconds: [UInt64] = [1, 4, 16]
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
