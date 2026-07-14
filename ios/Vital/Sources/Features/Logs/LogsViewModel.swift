import Foundation
import SwiftUI

// MARK: - Display model

struct LogDisplayItem: Identifiable {
    let id: String
    let type: String
    let title: String
    let subtitle: String
    let date: Date
    /// Source calendar date for day-level data, preferred over re-bucketing
    /// the sortable timestamp in the device's current timezone.
    let dayKey: String?
    let sfSymbol: String
    let thumbnail: UIImage?
    /// Trailing meta label — absolute local time ("7:41 PM") for most types,
    /// or "auto" for auto-synced types (sleep/HRV). Computed once at
    /// bucket-build time via `LogsPagerSummary.metaLabel`.
    let meta: String
    /// meal_logged only — kcal eaten. Passed straight through from `LogItem`.
    let kcal: Double?
    /// workout_completed only — distance in km.
    let km: Double?
    /// sleep_session only — duration in ms.
    let sleepMs: Double?
}

// MARK: - Day model (fixed 7-slot pager)

/// One page of the Logs day-pager. `dayKey` is the local `yyyy-MM-dd` day —
/// stable across reloads and used to key `dietDataByDay` / the meal-log cache.
struct LogDay: Identifiable {
    let dayKey: String
    let label: String     // "Today" / "Yesterday" / "Wednesday"
    let dateLabel: String // "Fri, Jul 10"
    var items: [LogDisplayItem]

    var id: String { dayKey }
}

// MARK: - Per-day diet data

/// A day's diet-budget rollup — either today's live totals or a past day's
/// read-only totals, both shaped identically for `DietBudgetCardView`.
struct DietDayData {
    let targetKcal: Int
    let eatenKcal: Int
    let remaining: Int
    let protein: MacroProgress
    let carbs: MacroProgress
    let fat: MacroProgress
}

// MARK: - Pure helpers (network-free)

/// Pure, network-free logic behind the Logs day-pager: bucketing raw log
/// items into a fixed 7-day window, per-item meta labels, per-day summary
/// lines, and the diet-budget rollup. Kept static/pure (with injected `today`
/// where relevant) so `LogsPagerTests` can exercise it without any network or
/// view-model plumbing — mirrors the `TrendsSummary` convention in
/// `TrendsViewModel.swift`.
enum LogsPagerSummary {

    private static let weekdayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEEE"
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    private static let dateLabelFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d"
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    private static func dayKey(for date: Date, calendar: Calendar) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        guard let year = components.year, let month = components.month, let day = components.day else {
            return ""
        }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    private static func format(_ date: Date, using formatter: DateFormatter, timeZone: TimeZone) -> String {
        let localized = formatter.copy() as! DateFormatter
        localized.timeZone = timeZone
        return localized.string(from: date)
    }

    // MARK: Day label

    /// "Today" for offset 0, "Yesterday" for offset 1, else the full local
    /// weekday name (e.g. "Wednesday") for the day `offset` days before
    /// `today`.
    static func dayLabel(offset: Int, today: Date, calendar: Calendar) -> String {
        switch offset {
        case 0:  return "Today"
        case 1:  return "Yesterday"
        default:
            let startOfToday = calendar.startOfDay(for: today)
            guard let day = calendar.date(byAdding: .day, value: -offset, to: startOfToday) else { return "" }
            return format(day, using: weekdayFormatter, timeZone: calendar.timeZone)
        }
    }

    // MARK: Bucketing

    /// Buckets already-mapped display items into the fixed 7-slot window
    /// ending `today` — index 0 = today, index 6 = six days ago. Items
    /// outside the window are dropped; empty slots are kept as empty
    /// `LogDay`s so the pager always has exactly 7 pages. Within a day, items
    /// are sorted newest-first.
    static func bucketDays(
        items: [LogDisplayItem],
        today: Date,
        calendar: Calendar = .current
    ) -> [LogDay] {
        let cal = calendar
        let startOfToday = cal.startOfDay(for: today)

        var byDayKey: [String: [LogDisplayItem]] = [:]
        for item in items {
            let key = item.dayKey ?? dayKey(for: item.date, calendar: cal)
            byDayKey[key, default: []].append(item)
        }

        var days: [LogDay] = []
        for offset in 0...6 {
            guard let day = cal.date(byAdding: .day, value: -offset, to: startOfToday) else { continue }
            let key = dayKey(for: day, calendar: cal)
            let dayItems = (byDayKey[key] ?? []).sorted { $0.date > $1.date }
            days.append(LogDay(
                dayKey: key,
                label: dayLabel(offset: offset, today: today, calendar: cal),
                dateLabel: format(day, using: dateLabelFormatter, timeZone: cal.timeZone),
                items: dayItems
            ))
        }
        return days
    }

    // MARK: Meta label

    /// `sleep_session` / `hrv_reading` are always labeled "auto". Items with
    /// an explicitly inexact timestamp are labeled "Synced"; older responses
    /// without the precision field retain the absolute local time behavior.
    static func metaLabel(type: String, date: Date, hasExactTime: Bool? = nil) -> String {
        if type == "sleep_session" || type == "hrv_reading" {
            return "auto"
        }
        if hasExactTime == false {
            return "Synced"
        }
        return timeFormatter.string(from: date)
    }

    // MARK: Summary line

    /// Per-day summary line: "N entries[ · N kcal][ · N.N km][ · Hh Mm sleep]".
    /// The sleep part only appears when neither kcal nor km fired (a pure
    /// rest day) and at least one item carries `sleepMs`.
    static func summaryLine(items: [LogDisplayItem]) -> String {
        var parts: [String] = []

        if items.isEmpty {
            parts.append("No entries")
        } else if items.count == 1 {
            parts.append("1 entry")
        } else {
            parts.append("\(items.count) entries")
        }

        let kcalSum = items.compactMap(\.kcal).reduce(0, +)
        let kmSum = items.compactMap(\.km).reduce(0, +)

        var addedKcalOrKm = false
        if kcalSum > 0 {
            parts.append("\(Int(kcalSum)) kcal")
            addedKcalOrKm = true
        }
        if kmSum > 0 {
            parts.append(String(format: "%.1f km", kmSum))
            addedKcalOrKm = true
        }

        if !addedKcalOrKm {
            let sleepValues = items.compactMap(\.sleepMs)
            if !sleepValues.isEmpty {
                let totalMinutes = Int(sleepValues.reduce(0, +) / 60_000)
                let h = totalMinutes / 60
                let m = totalMinutes % 60
                parts.append("\(h)h \(m)m sleep")
            }
        }

        return parts.joined(separator: " · ")
    }

    // MARK: Diet rollup

    /// Rolls up a day's `MealLogEntryDTO`s against the goal targets into a
    /// `DietDayData`. Pure — testable without the network.
    static func dietDayData(entries: [MealLogEntryDTO], goal: DietBudgetDTO) -> DietDayData {
        let eatenKcal = entries.reduce(0) { $0 + $1.kcal }
        let protein   = entries.reduce(0) { $0 + $1.protein }
        let carbs     = entries.reduce(0) { $0 + $1.carbs }
        let fat       = entries.reduce(0) { $0 + $1.fat }
        return DietDayData(
            targetKcal: goal.targetKcal,
            eatenKcal:  eatenKcal,
            remaining:  max(goal.targetKcal - eatenKcal, 0),
            protein:    MacroProgress(current: protein, target: goal.protein),
            carbs:      MacroProgress(current: carbs, target: goal.carbs),
            fat:        MacroProgress(current: fat, target: goal.fat)
        )
    }
}

// MARK: - ViewModel

@MainActor
final class LogsViewModel: ObservableObject {

    @Published var days: [LogDay] = []
    @Published var selectedIndex = 0
    @Published var isLoading = false
    @Published var errorMessage: String? = nil

    /// Per-day diet-budget rollup, keyed by `LogDay.dayKey`. Populated
    /// lazily as `selectDay` fetches each day's meal logs.
    @Published var dietDataByDay: [String: DietDayData] = [:]

    private let apiClient = APIClient.shared

    /// Fetched once and reused across all 7 days — targets don't vary by day.
    private var dietGoalCache: DietGoalResponse?
    /// Per-day meal-log cache, keyed by `dayKey`. Today's entry is invalidated
    /// after the diet sheet logs/edits/removes something.
    private var mealLogCache: [String: [MealLogEntryDTO]] = [:]

    private static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoParserNF: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Entry point for `.task` / `.refreshable`: fetches the 7-day log window
    /// once, buckets it into fixed day slots, then loads today's diet data.
    func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let response = try await apiClient.fetchLogs(days: 7)
            let displayItems: [LogDisplayItem] = response.items.compactMap { item in
                let date = Self.isoParser.date(from: item.timestamp)
                    ?? Self.isoParserNF.date(from: item.timestamp)
                guard let date else { return nil }
                let thumbnail = item.imageThumb
                    .flatMap { Data(base64Encoded: $0) }
                    .flatMap { UIImage(data: $0) }
                return LogDisplayItem(
                    id:        item.id,
                    type:      item.type,
                    title:     item.title,
                    subtitle:  item.subtitle,
                    date:      date,
                    dayKey:    item.dayKey,
                    sfSymbol:  symbol(for: item.type),
                    thumbnail: thumbnail,
                    meta:      LogsPagerSummary.metaLabel(
                        type: item.type,
                        date: date,
                        hasExactTime: item.hasExactTime
                    ),
                    kcal:      item.kcal,
                    km:        item.km,
                    sleepMs:   item.sleepMs
                )
            }
            days = LogsPagerSummary.bucketDays(items: displayItems, today: Date())
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
        selectedIndex = 0
        await refreshDietData(for: 0)
    }

    /// Selects a day-pager page and (if not already cached) kicks off that
    /// day's diet-goal + meal-log fetch. Non-async so view button actions can
    /// call it directly; the fetch itself runs in a spawned `Task`.
    func selectDay(_ index: Int) {
        guard days.indices.contains(index) else { return }
        selectedIndex = index
        Task { await refreshDietData(for: index) }
    }

    /// Called after the diet sheet closes (today only — the sheet is only
    /// reachable while `selectedIndex == 0`) so the next fetch reflects the
    /// just-logged/edited/deleted meal.
    func invalidateTodayMealCache() async {
        guard let todayKey = days.first?.dayKey else { return }
        mealLogCache.removeValue(forKey: todayKey)
        await refreshDietData(for: 0)
    }

    /// Today's current target kcal, for `DietSheetView`'s `initialTarget` —
    /// 0 as a safe fallback before the first fetch completes.
    var todayTargetKcal: Int {
        guard let todayKey = days.first?.dayKey else { return 0 }
        return dietDataByDay[todayKey]?.targetKcal ?? 0
    }

    // MARK: - Private

    private func refreshDietData(for index: Int) async {
        guard days.indices.contains(index) else { return }
        let dayKey = days[index].dayKey

        do {
            let goal: DietGoalResponse
            if let cached = dietGoalCache {
                goal = cached
            } else {
                goal = try await apiClient.fetchDietGoal()
                dietGoalCache = goal
            }

            let entries: [MealLogEntryDTO]
            if let cached = mealLogCache[dayKey] {
                entries = cached
            } else {
                let response = try await apiClient.fetchMealLogs(date: dayKey)
                entries = response.items
                mealLogCache[dayKey] = entries
            }

            dietDataByDay[dayKey] = LogsPagerSummary.dietDayData(entries: entries, goal: goal.current)
        } catch {
            // Keep whatever's already cached — the view falls back to the
            // absent-data state; the next select/refresh retries.
        }
    }

    private func symbol(for type: String) -> String {
        switch type {
        case "meal_logged":       return "fork.knife"
        case "workout_completed": return "figure.run"
        case "weight_logged":     return "scalemass"
        case "hrv_reading":       return "waveform.path.ecg"
        case "sleep_session":     return "bed.double.fill"
        default:                  return "circle.fill"
        }
    }
}
