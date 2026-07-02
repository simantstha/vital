import Foundation
import HealthKit

// MARK: - Intermediate per-day models

/// One day's worth of scalar HealthKit statistics, keyed to a local-midnight day.
/// Produced by `HealthKitBackfill.fetchDailyStatistics(days:)`.
struct DailyHealthData {
    let day: Date
    var hrvSdnn: Double?          // ms, discreteAverage
    var restingHr: Double?        // bpm, discreteAverage
    var hrAvg: Double?            // bpm, discreteAverage
    var steps: Double?            // count, cumulativeSum
    var activeEnergyKcal: Double? // kcal, cumulativeSum
    var bodyMassKg: Double?       // kg, discreteAverage
}

/// One night's sleep, attributed to the *wake* date (the day the sleep session ended).
/// Produced by `HealthKitBackfill.fetchDailySleep(days:)`.
struct DailySleepData {
    let day: Date
    let minutes: Int
    let coreMinutes: Int?
    let deepMinutes: Int?
    let remMinutes: Int?
    let awakeMinutes: Int?

    /// Whether the source data distinguished sleep stages at all (vs. a single
    /// "asleepUnspecified" block from older watches / manual entries).
    var hasStageBreakdown: Bool {
        (coreMinutes ?? 0) + (deepMinutes ?? 0) + (remMinutes ?? 0) + (awakeMinutes ?? 0) > 0
    }
}

/// A single workout, attributed to the day it started.
/// Produced by `HealthKitBackfill.fetchWorkouts(days:)`.
struct DailyWorkoutData {
    let day: Date
    let hkUuid: String
    let type: String
    let durationMin: Double
    let kcal: Double
}

// MARK: - HealthKitBackfill

/// Builds a 1-year (or arbitrary N-day) history of daily HealthKit summaries for
/// the initial backfill. Runs one `HKStatisticsCollectionQuery` per scalar
/// quantity type (daily buckets, anchored at local midnight), a single sleep
/// query attributing asleep-stage minutes to the wake date, and a workout query —
/// then composes all three into the per-day DTO the `/api/ingest/daily` route
/// expects. Read authorization is NOT requested here; callers must have already
/// run `HealthKitManager.requestAuthorization()` (the existing central auth path)
/// before invoking any fetch on this type.
final class HealthKitBackfill {

    private let store = HKHealthStore()
    private let calendar = Calendar.current

    // MARK: - Public API

    /// Fetches daily-bucketed scalar statistics (HRV SDNN, resting HR, average
    /// HR, steps, active energy, body mass) for the trailing `days` days.
    func fetchDailyStatistics(days: Int) async throws -> [DailyHealthData] {
        guard HKHealthStore.isHealthDataAvailable() else { return [] }

        let (start, end, anchor) = range(days: days)

        async let hrv = dailyQuantity(.heartRateVariabilitySDNN, options: .discreteAverage, unit: HKUnit.secondUnit(with: .milli), start: start, end: end, anchor: anchor)
        async let restingHr = dailyQuantity(.restingHeartRate, options: .discreteAverage, unit: HKUnit(from: "count/min"), start: start, end: end, anchor: anchor)
        async let hrAvg = dailyQuantity(.heartRate, options: .discreteAverage, unit: HKUnit(from: "count/min"), start: start, end: end, anchor: anchor)
        async let steps = dailyQuantity(.stepCount, options: .cumulativeSum, unit: HKUnit.count(), start: start, end: end, anchor: anchor)
        async let activeEnergy = dailyQuantity(.activeEnergyBurned, options: .cumulativeSum, unit: HKUnit.kilocalorie(), start: start, end: end, anchor: anchor)
        async let bodyMass = dailyQuantity(.bodyMass, options: .discreteAverage, unit: HKUnit.gramUnit(with: .kilo), start: start, end: end, anchor: anchor)

        let (hrvByDay, restingHrByDay, hrAvgByDay, stepsByDay, activeEnergyByDay, bodyMassByDay) =
            try await (hrv, restingHr, hrAvg, steps, activeEnergy, bodyMass)

        var days = Set(hrvByDay.keys)
        days.formUnion(restingHrByDay.keys)
        days.formUnion(hrAvgByDay.keys)
        days.formUnion(stepsByDay.keys)
        days.formUnion(activeEnergyByDay.keys)
        days.formUnion(bodyMassByDay.keys)

        return days.map { day in
            DailyHealthData(
                day: day,
                hrvSdnn: hrvByDay[day],
                restingHr: restingHrByDay[day],
                hrAvg: hrAvgByDay[day],
                steps: stepsByDay[day],
                activeEnergyKcal: activeEnergyByDay[day],
                bodyMassKg: bodyMassByDay[day]
            )
        }
    }

    /// Fetches nightly sleep, attributing asleep-stage minutes to the wake date
    /// (the day `sample.endDate` falls on), with a stage breakdown when the
    /// source data provides one (Apple Watch sleep staging vs. plain "asleep").
    func fetchDailySleep(days: Int) async throws -> [DailySleepData] {
        guard HKHealthStore.isHealthDataAvailable(),
              let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
        else { return [] }

        let (start, end, _) = range(days: days)
        // Buffer the query start by a day so sessions that began the evening
        // before `start` (and end, i.e. wake, inside the window) aren't missed.
        let queryStart = calendar.date(byAdding: .day, value: -1, to: start) ?? start
        let predicate = HKQuery.predicateForSamples(withStart: queryStart, end: end, options: [])

        let samples: [HKCategorySample] = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: sleepType,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (samples as? [HKCategorySample]) ?? [])
            }
            store.execute(query)
        }

        struct Accumulator {
            var total = 0.0
            var core = 0.0
            var deep = 0.0
            var rem = 0.0
            var awake = 0.0
        }

        var byDay: [Date: Accumulator] = [:]

        for sample in samples {
            let wakeDay = calendar.startOfDay(for: sample.endDate)
            guard wakeDay >= start, wakeDay <= end else { continue }

            let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60
            var acc = byDay[wakeDay] ?? Accumulator()

            switch sample.value {
            case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue:
                acc.total += minutes
            case HKCategoryValueSleepAnalysis.asleepCore.rawValue:
                acc.total += minutes
                acc.core += minutes
            case HKCategoryValueSleepAnalysis.asleepDeep.rawValue:
                acc.total += minutes
                acc.deep += minutes
            case HKCategoryValueSleepAnalysis.asleepREM.rawValue:
                acc.total += minutes
                acc.rem += minutes
            case HKCategoryValueSleepAnalysis.awake.rawValue:
                acc.awake += minutes
            default:
                break // inBed and anything unrecognized doesn't count as asleep time.
            }

            byDay[wakeDay] = acc
        }

        return byDay.map { day, acc in
            DailySleepData(
                day: day,
                minutes: Int(acc.total.rounded()),
                coreMinutes: acc.core > 0 ? Int(acc.core.rounded()) : nil,
                deepMinutes: acc.deep > 0 ? Int(acc.deep.rounded()) : nil,
                remMinutes: acc.rem > 0 ? Int(acc.rem.rounded()) : nil,
                awakeMinutes: acc.awake > 0 ? Int(acc.awake.rounded()) : nil
            )
        }
    }

    /// Fetches workouts started within the trailing `days` days, attributed to
    /// the day each workout started.
    func fetchWorkouts(days: Int) async throws -> [DailyWorkoutData] {
        guard HKHealthStore.isHealthDataAvailable() else { return [] }

        let (start, end, _) = range(days: days)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let energyType = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)

        let workouts: [HKWorkout] = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (samples as? [HKWorkout]) ?? [])
            }
            store.execute(query)
        }

        return workouts.map { workout in
            var kcal = 0.0
            if let energyType, let stats = workout.statistics(for: energyType), let sum = stats.sumQuantity() {
                kcal = sum.doubleValue(for: .kilocalorie())
            }
            return DailyWorkoutData(
                day: calendar.startOfDay(for: workout.startDate),
                hkUuid: workout.uuid.uuidString,
                type: Self.workoutTypeName(workout.workoutActivityType),
                durationMin: workout.duration / 60,
                kcal: kcal
            )
        }
    }

    /// Runs all three fetches and composes the per-day ingest DTO the backend
    /// expects, unioning whichever days appear in *any* of the three sources.
    /// A day with no statistics, no sleep, and no workouts simply never
    /// appears in the result — callers don't need a separate "skip empty
    /// days" pass.
    func buildIngestDays(days: Int) async throws -> [DailyIngestDay] {
        async let stats = fetchDailyStatistics(days: days)
        async let sleep = fetchDailySleep(days: days)
        async let workouts = fetchWorkouts(days: days)
        let (statsResult, sleepResult, workoutsResult) = try await (stats, sleep, workouts)

        let statsByDay = Dictionary(uniqueKeysWithValues: statsResult.map { ($0.day, $0) })
        let sleepByDay = Dictionary(uniqueKeysWithValues: sleepResult.map { ($0.day, $0) })
        let workoutsByDay = Dictionary(grouping: workoutsResult, by: \.day)

        var allDays = Set(statsByDay.keys)
        allDays.formUnion(sleepByDay.keys)
        allDays.formUnion(workoutsByDay.keys)

        let formatter = Self.dayFormatter

        return allDays.map { day in
            let stat = statsByDay[day]
            let sleep = sleepByDay[day]
            let dayWorkouts = workoutsByDay[day]

            let metrics: DailyIngestMetrics?
            if let stat, stat.hrvSdnn != nil || stat.restingHr != nil || stat.hrAvg != nil
                || stat.steps != nil || stat.activeEnergyKcal != nil || stat.bodyMassKg != nil {
                metrics = DailyIngestMetrics(
                    hrv_sdnn: stat.hrvSdnn,
                    resting_hr: stat.restingHr,
                    hr_avg: stat.hrAvg,
                    steps: stat.steps,
                    active_energy_kcal: stat.activeEnergyKcal,
                    body_mass_kg: stat.bodyMassKg
                )
            } else {
                metrics = nil
            }

            let sleepDTO: DailyIngestSleep? = sleep.map { s in
                DailyIngestSleep(
                    minutes: s.minutes,
                    stages: s.hasStageBreakdown
                        ? DailyIngestSleepStages(core: s.coreMinutes, deep: s.deepMinutes, rem: s.remMinutes, awake: s.awakeMinutes)
                        : nil
                )
            }

            let workoutsDTO: [DailyIngestWorkout]? = dayWorkouts?.map { w in
                DailyIngestWorkout(hkUuid: w.hkUuid, type: w.type, durationMin: w.durationMin, kcal: w.kcal)
            }

            return DailyIngestDay(
                date: formatter.string(from: day),
                metrics: metrics,
                sleep: sleepDTO,
                workouts: workoutsDTO
            )
        }
    }

    // MARK: - Private helpers

    /// Computes the (start, end, anchor) triple shared by every statistics
    /// query: `end` is now, `start` is `days` days before local midnight
    /// today, and `anchor` is local midnight today so daily buckets align to
    /// the device's calendar day.
    private func range(days: Int) -> (start: Date, end: Date, anchor: Date) {
        let end = Date()
        let todayMidnight = calendar.startOfDay(for: end)
        let start = calendar.date(byAdding: .day, value: -days, to: todayMidnight) ?? todayMidnight
        return (start, end, todayMidnight)
    }

    private func dailyQuantity(
        _ identifier: HKQuantityTypeIdentifier,
        options: HKStatisticsOptions,
        unit: HKUnit,
        start: Date,
        end: Date,
        anchor: Date
    ) async throws -> [Date: Double] {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return [:] }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: options,
                anchorDate: anchor,
                intervalComponents: DateComponents(day: 1)
            )
            query.initialResultsHandler = { [calendar] _, results, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let results else {
                    continuation.resume(returning: [:])
                    return
                }
                var out: [Date: Double] = [:]
                results.enumerateStatistics(from: start, to: end) { stats, _ in
                    let quantity = options.contains(.cumulativeSum) ? stats.sumQuantity() : stats.averageQuantity()
                    guard let quantity else { return }
                    out[calendar.startOfDay(for: stats.startDate)] = quantity.doubleValue(for: unit)
                }
                continuation.resume(returning: out)
            }
            self.store.execute(query)
        }
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func workoutTypeName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: return "Running"
        case .walking: return "Walking"
        case .cycling: return "Cycling"
        case .swimming: return "Swimming"
        case .traditionalStrengthTraining, .functionalStrengthTraining: return "Strength Training"
        case .hiking: return "Hiking"
        case .yoga: return "Yoga"
        case .coreTraining: return "Core Training"
        case .elliptical: return "Elliptical"
        case .rowing: return "Rowing"
        case .stairClimbing: return "Stair Climbing"
        case .highIntensityIntervalTraining: return "HIIT"
        case .dance: return "Dance"
        case .pilates: return "Pilates"
        case .crossTraining: return "Cross Training"
        case .mixedCardio: return "Cardio"
        case .other: return "Other"
        default: return "Workout"
        }
    }
}
