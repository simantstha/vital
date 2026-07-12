import Foundation
import Combine

// MARK: - Diet slot

/// Meal-slot tag for the diet sheet's quick-log grid, sent to the backend as
/// `slot` on `POST /api/meals/log`. `CaseIterable`'s declaration order is
/// also the fixed display/grouping order used throughout this feature.
enum DietSlot: String, CaseIterable, Identifiable {
    case breakfast, lunch, snacks, dinner

    var id: String { rawValue }

    var label: String {
        switch self {
        case .breakfast: return "Breakfast"
        case .lunch:     return "Lunch"
        case .snacks:    return "Snacks"
        case .dinner:    return "Dinner"
        }
    }

    var sfSymbol: String {
        switch self {
        case .breakfast: return "cup.and.saucer"
        case .lunch:     return "takeoutbag.and.cup.and.straw"
        case .snacks:    return "carrot"
        case .dinner:    return "fork.knife"
        }
    }
}

// MARK: - Quick food

/// A static, client-side quick-log option (mirrors the design mock's `MEALS`).
struct QuickFood: Identifiable {
    var id: String { name }
    let name: String
    let kcal: Int
    let protein: Int
    let carbs: Int
    let fat: Int
}

// MARK: - Logged group (for "Logged today")

struct DietLoggedGroup: Identifiable {
    var id: String { label }
    let label: String
    let sfSymbol: String
    let entries: [MealLogEntryDTO]
    var totalKcal: Int { entries.reduce(0) { $0 + $1.kcal } }
}

// MARK: - ViewModel

@MainActor
final class DietSheetViewModel: ObservableObject {

    @Published var target: Int
    var remaining: Int {
        max(0, target - loggedEntries.reduce(0) { $0 + $1.kcal })
    }

    @Published var loggedEntries: [MealLogEntryDTO] = []
    @Published var selectedSlot: DietSlot = .breakfast

    @Published var isEditingTarget = false
    @Published var targetInput = ""

    @Published var customName = ""
    @Published var customKcal = ""

    @Published var toastMessage: String?

    /// Fired (fire-and-forget) after every successful log/delete/target change
    /// so `TodayViewModel`'s diet numbers + fuel strip stay in sync — mirrors
    /// `MealDetailView`'s completion calling `vm.loadHealthData()` in `TodayView`.
    var onRefreshToday: () -> Void

    private let apiClient = APIClient.shared

    /// Matches JS `Date.toISOString()` exactly, so locally-synthesized entries
    /// sort correctly alongside server-returned `loggedAt` strings.
    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    // Static quick-log data — matches the design mock's `MEALS` exactly.
    // Order per food: kcal / protein / carbs / fat.
    static let quickFoods: [DietSlot: [QuickFood]] = [
        .breakfast: [
            QuickFood(name: "Greek yogurt & berries", kcal: 220, protein: 18, carbs: 24, fat: 6),
            QuickFood(name: "Oats, banana & honey",   kcal: 310, protein: 9,  carbs: 62, fat: 5),
            QuickFood(name: "Eggs & toast",            kcal: 350, protein: 21, carbs: 28, fat: 16),
        ],
        .lunch: [
            QuickFood(name: "Salmon bowl",             kcal: 580, protein: 38, carbs: 52, fat: 22),
            QuickFood(name: "Chicken & rice bowl",     kcal: 640, protein: 52, carbs: 74, fat: 14),
            QuickFood(name: "Falafel wrap",             kcal: 520, protein: 18, carbs: 64, fat: 20),
        ],
        .snacks: [
            QuickFood(name: "Protein shake",           kcal: 180, protein: 30, carbs: 6,  fat: 3),
            QuickFood(name: "Apple & peanut butter",   kcal: 250, protein: 7,  carbs: 28, fat: 13),
            QuickFood(name: "Trail mix",               kcal: 210, protein: 6,  carbs: 18, fat: 13),
        ],
        .dinner: [
            QuickFood(name: "Salmon & greens",         kcal: 480, protein: 38, carbs: 18, fat: 26),
            QuickFood(name: "Chicken stir-fry",        kcal: 640, protein: 46, carbs: 58, fat: 20),
            QuickFood(name: "Pasta & veg",              kcal: 560, protein: 20, carbs: 88, fat: 14),
        ],
    ]

    init(initialTarget: Int, onRefreshToday: @escaping () -> Void) {
        self.target = initialTarget
        self.onRefreshToday = onRefreshToday
    }

    // MARK: - Load

    func load() async {
        async let goalTask = apiClient.fetchDietGoal()
        async let logsTask = apiClient.fetchTodayMealLogs()
        do {
            let (goal, logs) = try await (goalTask, logsTask)
            target = goal.current.targetKcal
            loggedEntries = logs.items
        } catch {
            // Keep whatever we already had (initialTarget / previous list) —
            // the sheet stays usable; the next open retries.
        }
    }

    // MARK: - Quick log

    func logQuickFood(_ food: QuickFood, slot: DietSlot) async {
        do {
            let response = try await apiClient.logMeal(
                name: food.name,
                kcal: Double(food.kcal),
                c: Double(food.carbs),
                p: Double(food.protein),
                f: Double(food.fat),
                source: "quick",
                slot: slot.rawValue
            )
            let entry = MealLogEntryDTO(
                id: response.eventId,
                name: food.name,
                kcal: food.kcal,
                protein: food.protein,
                carbs: food.carbs,
                fat: food.fat,
                slot: slot.rawValue,
                loggedAt: Self.isoFormatter.string(from: Date())
            )
            loggedEntries.append(entry)
            toastMessage = "Logged — nice work"
            onRefreshToday()
        } catch {
            // Nothing was mutated locally yet — nothing to revert.
            toastMessage = "Couldn't save — try again"
        }
    }

    // MARK: - Custom log

    func logCustom() async {
        let name = customName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let kcal = Int(customKcal.trimmingCharacters(in: .whitespacesAndNewlines)), kcal > 0 else {
            return
        }
        do {
            let response = try await apiClient.logMeal(
                name: name,
                kcal: Double(kcal),
                c: 0,
                p: 0,
                f: 0,
                source: "manual",
                slot: selectedSlot.rawValue
            )
            let entry = MealLogEntryDTO(
                id: response.eventId,
                name: name,
                kcal: kcal,
                protein: 0,
                carbs: 0,
                fat: 0,
                slot: selectedSlot.rawValue,
                loggedAt: Self.isoFormatter.string(from: Date())
            )
            loggedEntries.append(entry)
            customName = ""
            customKcal = ""
            toastMessage = "Logged — nice work"
            onRefreshToday()
        } catch {
            toastMessage = "Couldn't save — try again"
        }
    }

    // MARK: - Remove

    func removeEntry(_ entry: MealLogEntryDTO) async {
        let previous = loggedEntries
        loggedEntries.removeAll { $0.id == entry.id }
        do {
            try await apiClient.deleteMealLog(id: entry.id)
            onRefreshToday()
        } catch {
            loggedEntries = previous
            toastMessage = "Couldn't save — try again"
        }
    }

    // MARK: - Target

    func updateTarget(_ newValue: Int) async {
        let previous = target
        target = newValue
        do {
            try await apiClient.updateDietGoal(mode: "custom", targetKcal: newValue)
            onRefreshToday()
        } catch {
            target = previous
            toastMessage = "Couldn't save — try again"
        }
    }

    // MARK: - Derived display helpers

    /// Per-slot kcal subtotal for the slot grid — "—" when nothing's logged.
    func subtotalLabel(for slot: DietSlot) -> String {
        let total = loggedEntries.filter { $0.slot == slot.rawValue }.reduce(0) { $0 + $1.kcal }
        return total > 0 ? "\(total) kcal" : "—"
    }

    /// Groups `loggedEntries` for the "Logged today" list: fixed
    /// breakfast → lunch → snacks → dinner order (only non-empty groups
    /// shown), plus a trailing "Other" group for entries with no slot
    /// (photo/barcode/search-logged meals still need to show up).
    var loggedGroups: [DietLoggedGroup] {
        var groups: [DietLoggedGroup] = []
        for slot in DietSlot.allCases {
            let entries = loggedEntries.filter { $0.slot == slot.rawValue }
            if !entries.isEmpty {
                groups.append(DietLoggedGroup(label: slot.label, sfSymbol: slot.sfSymbol, entries: entries))
            }
        }
        let other = loggedEntries.filter { $0.slot == nil }
        if !other.isEmpty {
            groups.append(DietLoggedGroup(label: "Other", sfSymbol: "fork.knife", entries: other))
        }
        return groups
    }
}
