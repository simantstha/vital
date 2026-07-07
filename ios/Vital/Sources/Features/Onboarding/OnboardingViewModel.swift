import Foundation

/// Draft state and navigation for the onboarding questionnaire (Phase 5 of
/// the ios-pivot plan). Collects Basics → Goal → Training → HealthSafety →
/// Lifestyle, submits the whole thing to `/api/onboarding` once, then hands
/// off to a CoachIntro chat step and a Calibrating (backfill progress) step.
@MainActor
final class OnboardingViewModel: ObservableObject {

    enum Step: Int, CaseIterable {
        case basics, goal, training, healthSafety, lifestyle, coachIntro, calibrating
    }

    @Published var step: Step = .basics

    // MARK: - Basics

    @Published var name: String = ""
    @Published var dob: Date = Calendar.current.date(byAdding: .year, value: -25, to: Date()) ?? Date()
    @Published var sex: String = ""
    @Published var heightCm: Double?
    @Published var weightKg: Double?
    @Published var units: String = "metric"

    // MARK: - Goal

    @Published var goal: String = ""
    @Published var hasTargetDate: Bool = false
    @Published var targetDate: Date = Calendar.current.date(byAdding: .month, value: 3, to: Date()) ?? Date()

    // MARK: - Training

    @Published var frequency: Int = 3
    @Published var trainingTypes: Set<String> = []
    @Published var experience: String = ""
    @Published var volumeNotes: String = ""

    // MARK: - Health & safety (all optional)

    @Published var injuries: String = ""
    @Published var conditions: String = ""
    @Published var medications: String = ""

    // MARK: - Lifestyle (all optional)

    @Published var sleepSchedule: String = ""
    @Published var stress: String = ""
    @Published var diet: String = ""

    // MARK: - Submission state

    @Published var isPrefilling = false
    @Published var isSubmitting = false
    @Published var errorMessage: String?

    private let healthKitManager: HealthKitManager
    private let apiClient: APIClient
    private weak var authViewModel: AuthViewModel?

    // `HealthKitManager` is @MainActor-isolated, so it can't be constructed
    // as a default *parameter* value (those are evaluated in a nonisolated
    // context); build it in the init body instead, which does inherit this
    // class's @MainActor isolation (same pattern as BackfillCoordinator).
    init(healthKitManager: HealthKitManager? = nil, apiClient: APIClient = .shared) {
        self.healthKitManager = healthKitManager ?? HealthKitManager()
        self.apiClient = apiClient
    }

    // MARK: - Flow start

    /// Called once when OnboardingFlowView first appears: requests HealthKit
    /// read authorization (the one and only place it's asked for now — the
    /// Today tab's lazy request moved here) and prefills whatever HealthKit
    /// and the Apple ID credential already know.
    func begin(authViewModel: AuthViewModel) async {
        self.authViewModel = authViewModel
        await healthKitManager.requestAuthorization()
        await prefill()
    }

    func prefill() async {
        isPrefilling = true
        defer { isPrefilling = false }

        if name.trimmingCharacters(in: .whitespaces).isEmpty,
           let appleName = authViewModel?.appleDisplayName {
            name = appleName
        }

        let characteristics = await healthKitManager.fetchCharacteristics()
        if let value = characteristics.dateOfBirth { dob = value }
        if let value = characteristics.biologicalSex { sex = value }
        if let value = characteristics.latestHeightCm { heightCm = value }
        if let value = characteristics.latestBodyMassKg { weightKg = value }
    }

    // MARK: - Step navigation

    var canContinueFromBasics: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !sex.isEmpty
            && (heightCm ?? 0) > 0
            && (weightKg ?? 0) > 0
    }

    func advance() {
        guard let next = Step(rawValue: step.rawValue + 1) else { return }
        step = next
    }

    func back() {
        guard let previous = Step(rawValue: step.rawValue - 1) else { return }
        step = previous
    }

    /// Submits the full questionnaire, then advances to CoachIntro only on
    /// success — a failed submit leaves the user on Lifestyle with an error
    /// message rather than moving forward with unsaved answers.
    func submitAndAdvance() async {
        guard await submit() else { return }
        advance()
    }

    // MARK: - Submit

    private func submit() async -> Bool {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        let basics = OnboardingBasics(
            name: name.trimmingCharacters(in: .whitespaces),
            dob: Self.dateFormatter.string(from: dob),
            sex: sex,
            heightCm: heightCm ?? 0,
            weightKg: weightKg ?? 0,
            units: units,
            goal: goal,
            targetDate: hasTargetDate ? Self.dateFormatter.string(from: targetDate) : nil
        )
        let training = OnboardingTraining(
            frequency: frequency,
            types: Array(trainingTypes),
            experience: experience,
            volumeNotes: volumeNotes.trimmingCharacters(in: .whitespaces).isEmpty ? nil : volumeNotes
        )
        let health = OnboardingHealth(
            injuries: injuries.trimmingCharacters(in: .whitespaces).isEmpty ? nil : injuries,
            conditions: conditions.trimmingCharacters(in: .whitespaces).isEmpty ? nil : conditions,
            medications: medications.trimmingCharacters(in: .whitespaces).isEmpty ? nil : medications
        )
        let lifestyle = OnboardingLifestyle(
            sleepSchedule: sleepSchedule.isEmpty ? nil : sleepSchedule,
            stress: stress.isEmpty ? nil : stress,
            diet: diet.trimmingCharacters(in: .whitespaces).isEmpty ? nil : diet
        )

        do {
            let response = try await apiClient.postOnboarding(
                basics: basics, training: training, health: health, lifestyle: lifestyle
            )
            return response.ok
        } catch {
            errorMessage = "Couldn't save your answers: \(error.localizedDescription)"
            return false
        }
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}
