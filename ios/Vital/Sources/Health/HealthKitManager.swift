import Foundation
import HealthKit
import UIKit

// MARK: - Reading structs

struct HRVReading {
    let valueMs: Double
    let timestamp: Date
}

struct SleepReading {
    let totalMinutes: Int
    let bedTime: Date
    let wakeTime: Date
}

struct RestingHRReading {
    let bpm: Double
    let timestamp: Date
}

struct StepsReading {
    let count: Int
    let date: Date
}

// MARK: - HealthKitManager

/// Reads health data from the local HealthKit store.
/// All methods return nil gracefully when authorization is denied or no data exists —
/// callers should fall back to mock/cached values rather than crashing.
@MainActor
final class HealthKitManager: ObservableObject {

    private let store = HKHealthStore()

    // MARK: - Types to read

    private var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = []

        let quantityIdentifiers: [HKQuantityTypeIdentifier] = [
            .heartRateVariabilitySDNN,
            .restingHeartRate,
            .heartRate,
            .stepCount,
            .activeEnergyBurned,
            .bodyMass,
            .height,
            // Expanded coverage: cardio fitness + activity + workout detail.
            .vo2Max,
            .distanceWalkingRunning,
            .appleExerciseTime,
            .flightsClimbed,
            .basalEnergyBurned,
            // Dietary intake — lets a MyFitnessPal (or similar) user's diet
            // budget reflect what they actually ate instead of always
            // showing 0 consumed. Never written (toShare stays empty).
            .dietaryEnergyConsumed,
            .dietaryProtein,
            .dietaryCarbohydrates,
            .dietaryFatTotal,
        ]

        for id in quantityIdentifiers {
            if let t = HKObjectType.quantityType(forIdentifier: id) {
                types.insert(t)
            }
        }

        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.insert(sleepType)
        }

        // Characteristics — read once at onboarding to prefill date of birth /
        // biological sex; these are one-time facts, not time-series samples.
        if let dobType = HKObjectType.characteristicType(forIdentifier: .dateOfBirth) {
            types.insert(dobType)
        }
        if let sexType = HKObjectType.characteristicType(forIdentifier: .biologicalSex) {
            types.insert(sexType)
        }

        types.insert(HKObjectType.workoutType())
        return types
    }

    // MARK: - Authorization

    /// UserDefaults key set the moment `requestAuthorization()` runs with
    /// HealthKit available — i.e. the system prompt has been shown, or was
    /// already answered on a prior launch (iOS resolves the call silently
    /// in that case; the caller can't tell which happened). Combined with
    /// `hasAnyData()` to *infer* a probable denial — see
    /// docs/superpowers/plans/2026-09-05-healthkit-denial-recovery.md.
    private static let didRequestAuthorizationKey = "healthKitDidRequestAuthorization"

    static var didRequestAuthorization: Bool {
        UserDefaults.standard.bool(forKey: didRequestAuthorizationKey)
    }

    func requestAuthorization() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        UserDefaults.standard.set(true, forKey: Self.didRequestAuthorizationKey)
        do {
            try await store.requestAuthorization(toShare: [], read: readTypes)
        } catch {
            // This is NOT a denial path. `requestAuthorization` does not
            // throw when the user taps "Don't Allow" — Apple deliberately
            // withholds that signal for *read* types so apps can't infer
            // health conditions from a refusal (see `authorizationStatus
            // (for:)`'s docs). A caught error here is a genuine failure —
            // HealthKit becoming unavailable mid-call, an invalid type —
            // never evidence the user denied anything.
            print("[HealthKit] Authorization request failed: \(error.localizedDescription)")
        }
    }

    /// Returns whether the Health app can be opened on this device.
    /// Used by the UI to decide whether to show the "Open Health" button.
    static func canOpenHealthApp() -> Bool {
        guard let url = URL(string: "x-apple-health://") else { return false }
        return UIApplication.shared.canOpenURL(url)
    }

    /// The best available recovery affordance for a probable denial: there
    /// is no public API to deep-link straight into this app's row of
    /// Health's Sharing screen (verified against the UIKit SDK headers —
    /// only `UIApplicationOpenSettingsURLString` and
    /// `...OpenNotificationSettingsURLString` exist, and this app's own
    /// Settings page never lists HealthKit permissions at all). `x-apple-
    /// health://` is Health's own registered URL scheme and reliably
    /// launches the app (verified on-simulator), landing on its Summary
    /// tab — callers must pair this with written steps for the remaining
    /// taps (Profile icon → Apps → Vital).
    /// Returns whether the URL was successfully opened. If the Health app
    /// is not available, returns false and the button should be hidden so
    /// users see only the written recovery steps.
    static func openHealthApp() -> Bool {
        guard canOpenHealthApp() else { return false }
        guard let url = URL(string: "x-apple-health://") else { return false }
        UIApplication.shared.open(url)
        return true
    }

    // MARK: - Denial inference

    /// Returns true as soon as any HealthKit-requested type — a
    /// characteristic (date of birth, biological sex) or any sample type —
    /// has at least one value on this device. HealthKit never reports that
    /// *read* access was denied (see `requestAuthorization` above), so this
    /// exists purely to let callers infer a probable denial together with
    /// `didRequestAuthorization`: asked at least once, plus zero data
    /// anywhere. A single granted-but-populated type must still return
    /// true — a user who granted sleep but not HRV, or simply hasn't
    /// logged anything under a granted type yet, must never be told they
    /// refused something they didn't.
    func hasAnyData() async -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { return false }

        let characteristics = await fetchCharacteristics()
        if characteristics.dateOfBirth != nil
            || characteristics.biologicalSex != nil
            || characteristics.latestHeightCm != nil
            || characteristics.latestBodyMassKg != nil {
            return true
        }

        for type in readTypes.compactMap({ $0 as? HKSampleType }) {
            if await sampleExists(for: type) { return true }
        }
        return false
    }

    private func sampleExists(for type: HKSampleType) async -> Bool {
        await withCheckedContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: type,
                predicate: nil,
                limit: 1,
                sortDescriptors: nil
            ) { _, samples, _ in
                continuation.resume(returning: !(samples ?? []).isEmpty)
            }
            store.execute(query)
        }
    }

    // MARK: - HRV SDNN (most recent sample)

    func fetchLatestHRV() async -> HRVReading? {
        guard HKHealthStore.isHealthDataAvailable(),
              let type = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)
        else { return nil }

        return await withCheckedContinuation { continuation in
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
            let query = HKSampleQuery(
                sampleType: type,
                predicate: nil,
                limit: 1,
                sortDescriptors: [sort]
            ) { _, samples, _ in
                guard let sample = samples?.first as? HKQuantitySample else {
                    continuation.resume(returning: nil)
                    return
                }
                let ms = sample.quantity.doubleValue(for: HKUnit.secondUnit(with: .milli))
                continuation.resume(returning: HRVReading(valueMs: ms, timestamp: sample.endDate))
            }
            store.execute(query)
        }
    }

    // MARK: - Sleep (last 24 hours)

    func fetchLastNightSleep() async -> SleepReading? {
        guard HKHealthStore.isHealthDataAvailable(),
              let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
        else { return nil }

        let end = Date()
        let start = Calendar.current.date(byAdding: .hour, value: -24, to: end)!
        let predicate = HKQuery.predicateForSamples(
            withStart: start, end: end, options: .strictStartDate
        )
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

        return await withCheckedContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: sleepType,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [sort]
            ) { _, samples, _ in
                guard let categorySamples = samples as? [HKCategorySample],
                      !categorySamples.isEmpty
                else {
                    continuation.resume(returning: nil)
                    return
                }

                // Only count asleep stages, not InBed
                let asleepValues: Set<Int> = [
                    HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
                    HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                    HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                    HKCategoryValueSleepAnalysis.asleepREM.rawValue,
                ]
                let asleep = categorySamples.filter { asleepValues.contains($0.value) }
                guard !asleep.isEmpty else {
                    continuation.resume(returning: nil)
                    return
                }

                let totalSeconds = asleep.reduce(0.0) {
                    $0 + $1.endDate.timeIntervalSince($1.startDate)
                }
                let totalMinutes = Int(totalSeconds / 60)
                continuation.resume(returning: SleepReading(
                    totalMinutes: totalMinutes,
                    bedTime: asleep.first!.startDate,
                    wakeTime: asleep.last!.endDate
                ))
            }
            store.execute(query)
        }
    }

    // MARK: - Resting heart rate (most recent sample)

    func fetchLatestRestingHR() async -> RestingHRReading? {
        guard HKHealthStore.isHealthDataAvailable(),
              let type = HKObjectType.quantityType(forIdentifier: .restingHeartRate)
        else { return nil }

        return await withCheckedContinuation { continuation in
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
            let query = HKSampleQuery(
                sampleType: type,
                predicate: nil,
                limit: 1,
                sortDescriptors: [sort]
            ) { _, samples, _ in
                guard let sample = samples?.first as? HKQuantitySample else {
                    continuation.resume(returning: nil)
                    return
                }
                let bpm = sample.quantity.doubleValue(for: HKUnit(from: "count/min"))
                continuation.resume(returning: RestingHRReading(bpm: bpm, timestamp: sample.endDate))
            }
            store.execute(query)
        }
    }

    // MARK: - Steps (today's cumulative total)

    func fetchTodaySteps() async -> StepsReading? {
        guard HKHealthStore.isHealthDataAvailable(),
              let type = HKObjectType.quantityType(forIdentifier: .stepCount)
        else { return nil }

        let startOfDay = Calendar.current.startOfDay(for: Date())
        let predicate = HKQuery.predicateForSamples(
            withStart: startOfDay, end: Date(), options: .strictStartDate
        )

        return await withCheckedContinuation { continuation in
            let query = HKStatisticsQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum
            ) { _, result, _ in
                guard let sum = result?.sumQuantity() else {
                    continuation.resume(returning: nil)
                    return
                }
                let count = Int(sum.doubleValue(for: HKUnit.count()))
                continuation.resume(returning: StepsReading(count: count, date: Date()))
            }
            store.execute(query)
        }
    }

    // MARK: - Characteristics (onboarding prefill)

    /// One-shot read of static profile facts for onboarding prefill: date of
    /// birth and biological sex come from HealthKit's characteristic store
    /// (synchronous, throwing); height/weight come from the latest quantity
    /// sample of each type. Every field degrades to `nil` independently —
    /// callers should treat this purely as a convenience prefill, never a
    /// required source of truth.
    func fetchCharacteristics() async -> (
        dateOfBirth: Date?,
        biologicalSex: String?,
        latestHeightCm: Double?,
        latestBodyMassKg: Double?
    ) {
        guard HKHealthStore.isHealthDataAvailable() else {
            return (nil, nil, nil, nil)
        }

        let dateOfBirth: Date? = {
            guard let components = try? store.dateOfBirthComponents() else { return nil }
            return Calendar.current.date(from: components)
        }()

        let biologicalSex: String? = {
            guard let bio = try? store.biologicalSex() else { return nil }
            switch bio.biologicalSex {
            case .male:    return "male"
            case .female:  return "female"
            case .other:   return "other"
            case .notSet:  return nil
            @unknown default: return nil
            }
        }()

        async let heightTask = fetchLatestQuantitySample(
            identifier: .height, unit: HKUnit.meterUnit(with: .centi)
        )
        async let massTask = fetchLatestQuantitySample(
            identifier: .bodyMass, unit: HKUnit.gramUnit(with: .kilo)
        )
        let (latestHeightCm, latestBodyMassKg) = await (heightTask, massTask)

        return (dateOfBirth, biologicalSex, latestHeightCm, latestBodyMassKg)
    }

    // MARK: - Nutrition source attribution

    /// Names of the HealthKit sources (apps) that wrote dietary energy
    /// samples in `[from, to)`, excluding this app's own source — i.e. the
    /// third-party food-logging apps (MyFitnessPal, Cronometer, …) a user has
    /// writing to Health. Uses `HKSourceQuery` (not a sample query) because
    /// callers only need distinct source names, not the samples themselves —
    /// one query returns the full source set for the range regardless of how
    /// many samples it contains.
    func nutritionSourceNames(from start: Date, to end: Date) async -> [String] {
        guard HKHealthStore.isHealthDataAvailable(),
              let type = HKObjectType.quantityType(forIdentifier: .dietaryEnergyConsumed)
        else { return [] }

        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)

        return await withCheckedContinuation { continuation in
            let query = HKSourceQuery(sampleType: type, samplePredicate: predicate) { _, sourcesOrNil, _ in
                let names = (sourcesOrNil ?? [])
                    .filter { $0 != HKSource.default() }
                    .map(\.name)
                continuation.resume(returning: names)
            }
            store.execute(query)
        }
    }

    private func fetchLatestQuantitySample(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit
    ) async -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return nil }

        return await withCheckedContinuation { continuation in
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
            let query = HKSampleQuery(
                sampleType: type,
                predicate: nil,
                limit: 1,
                sortDescriptors: [sort]
            ) { _, samples, _ in
                guard let sample = samples?.first as? HKQuantitySample else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: sample.quantity.doubleValue(for: unit))
            }
            store.execute(query)
        }
    }
}
