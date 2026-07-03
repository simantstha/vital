import Foundation
import HealthKit

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
        ]

        for id in quantityIdentifiers {
            if let t = HKObjectType.quantityType(forIdentifier: id) {
                types.insert(t)
            }
        }

        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.insert(sleepType)
        }

        types.insert(HKObjectType.workoutType())
        return types
    }

    // MARK: - Authorization

    func requestAuthorization() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        do {
            try await store.requestAuthorization(toShare: [], read: readTypes)
        } catch {
            // Authorization denied or unavailable — callers handle via nil returns.
            print("[HealthKit] Authorization failed: \(error.localizedDescription)")
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
}
