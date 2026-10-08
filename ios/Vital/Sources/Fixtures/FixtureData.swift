#if DEBUG
import Foundation

/// Builds the canned JSON responses `FixtureURLProtocol` serves for each
/// `FixtureMode.Scenario`. Every dictionary below mirrors one of
/// `APIClient.swift`'s `Decodable` response shapes exactly (field names,
/// optionality) — see the comment on each builder for which type it matches.
/// Kept as plain `[String: Any]` + `JSONSerialization` rather than adding
/// `Encodable` conformance to APIClient's response DTOs, so this file never
/// touches APIClient.swift.
enum FixtureData {

    // MARK: - Per-scenario profile

    /// One meal, shared between the Today plan copy, `/api/meals/log`, and
    /// `/api/nutrition/recents`.
    private struct FixtureMeal {
        let name: String
        let kcal: Int
        let c: Int
        let p: Int
        let f: Int
        let slot: String

        /// Realistic local log time per slot (hour, minute) — meals aren't
        /// all logged "now".
        var logTime: (hour: Int, minute: Int) {
            switch slot {
            case "breakfast": return (8, 5)
            case "lunch": return (12, 40)
            case "dinner": return (19, 0)
            default: return (15, 30) // snacks
            }
        }
    }

    /// One Today/`/api/plan` timeline row.
    private struct FixturePlanItem {
        let title: String
        let timeMinutes: Int
        let kind: String
        let subtitle: String
        let kcal: Int?
        let why: String
    }

    /// GET /api/training/summary's `lastLift` (#202) for a fixture scenario.
    /// `date` is a resolved `dayString(_:)` value, not a raw offset.
    private struct FixtureLastLift {
        let exercise: String
        let date: String
        let sets: Int
        let reps: Int
        let weightKg: Double?
    }

    private struct Profile {
        let goal: String
        let name: String
        let insight: String
        /// Mirrors a real account's calibration: `false` only for `newUser`,
        /// where Today/Trends/Profile all show "still calibrating" and every
        /// metric value is nil rather than a fabricated reading.
        let established: Bool
        let targetKcal: Int
        let consumedKcal: Int
        let protein: Int
        let proteinTarget: Int
        let carbs: Int
        let carbsTarget: Int
        let fat: Int
        let fatTarget: Int
        let plan: [FixturePlanItem]
        let meals: [FixtureMeal]
        let weightKg: Double
        let weightTrendPerWeekKg: Double // negative = losing, positive = gaining
        // "Today" readings — the SINGLE source for last night's sleep, this
        // morning's HRV and resting HR, and today's weight. Every screen
        // (Today tiles, Logs subtitle, Trends latest point + normal band,
        // sleep/workout analyses, coach receipts) derives from these; see
        // `todayValue` / `normalBase` / `seriesPoint`.
        let hrv: Double
        let restingHR: Double
        let sleepMinutes: Double
        let steps: Double
        let distanceKm: Double
        let workoutTitle: String?
        let workoutKm: Double?

        // GET /api/training/summary (#202) — `var`, not `let`: a stored
        // `let` with a default value is EXCLUDED from Swift's synthesized
        // memberwise initializer (a constant can't be assigned twice), so a
        // `let` here would drop these from `Profile.init` entirely and
        // break every scenario literal that passes them. `var` with a
        // default IS included as a defaulted parameter — every existing
        // scenario literal above still needs no change; only `.muscle`/
        // `.endurance` set these, and `trainingSummary(_:)` returns nil
        // (404) when all three are absent, matching a real backend's
        // response for a weight_loss/general account with no training data.
        var lastLift: FixtureLastLift? = nil
        var weeklyVolumeKm: Double? = nil
        var plannedSessionsThisWeek: Int? = nil
        var completedSessionsThisWeek: Int? = nil
    }

    /// Returning-user opener, shown once a scenario has an established
    /// baseline (`Profile.established == true`). It leads with the goal
    /// status in one line — the same wording `lib/brain/openerText.ts` composes
    /// for the live opener (amount done of total in the user's unit, pace vs
    /// the target date; the card headline for non-weight goals) — and keeps
    /// the "what would you like to dig into" tail the screenshot harness
    /// waits on. Numbers derive from the same constants as `goalProgress(_:scenario:)`.
    private static func coachOpener(for scenario: FixtureMode.Scenario, profile: Profile) -> String {
        let invite = "What would you like to dig into?"
        switch scenario {
        case .endurance:
            return "Goal check-in: Building — distance up \(enduranceVolumeChangePct)% (last 2 weeks vs the 2 before). \(invite)"
        case .weightLoss:
            // Mirrors goalProgress(): start 83.7 kg, target 76 kg, target
            // date 84 days out, ETA 70 days out => 14 days (2 weeks) ahead.
            let start = 83.7
            let target = 76.0
            let done = ((start - profile.weightKg) * 10).rounded() / 10
            let total = ((start - target) * 10).rounded() / 10
            return "You're \(trimmedKm(done)) of \(trimmedKm(total)) kg down and about 2 weeks ahead of your \(shortDate(daysAhead: 84)) target. \(invite)"
        case .muscle:
            return "Goal check-in: \(muscleGoalHeadline). \(invite)"
        default:
            return "Nice work staying consistent this week — what would you like to dig into?"
        }
    }

    /// New/calibrating-user opener (`Profile.established == false`, i.e. the
    /// `new_user` scenario) — no history to praise yet, so it states the goal
    /// onboarding already collected (this scenario's goal-progress fixture is
    /// `weight_loss` with no target) and sets the expectation, instead of
    /// asking for it. Same copy as `CoachViewModel.newUserGoalOpener`.
    private static let newUserCoachOpener =
        CoachViewModel.newUserGoalOpener(goal: "weight_loss") ?? CoachViewModel.newUserFallbackOpener

    private static let profiles: [FixtureMode.Scenario: Profile] = [
        .newUser: Profile(
            goal: "general",
            name: "Jordan Lee",
            insight: "Keep logging — a few more days and I'll start spotting real patterns.",
            established: false,
            targetKcal: 2200, consumedKcal: 0,
            protein: 0, proteinTarget: 140, carbs: 0, carbsTarget: 220, fat: 0, fatTarget: 70,
            plan: [],
            meals: [],
            weightKg: 78, weightTrendPerWeekKg: 0,
            hrv: 55, restingHR: 60, sleepMinutes: 420, steps: 6000, distanceKm: 4.2,
            workoutTitle: nil, workoutKm: nil
        ),
        .weightLoss: Profile(
            goal: "weight_loss",
            name: "Sam Rivera",
            insight: "You're down 0.6\u{00A0}kg this week, but last night's sleep ran short (6h 50m) — keep the deficit gentle and aim for an earlier night.",
            established: true,
            targetKcal: 1850, consumedKcal: 1020,
            protein: 96, proteinTarget: 150, carbs: 79, carbsTarget: 165, fat: 35, fatTarget: 62,
            plan: [
                FixturePlanItem(title: "Overnight oats with berries", timeMinutes: 420, kind: "meal", subtitle: "Breakfast · 7:00 AM", kcal: 380, why: "High protein start keeps you full past lunch."),
                FixturePlanItem(title: "30-min incline walk", timeMinutes: 660, kind: "move", subtitle: "Move · 11:00 AM", kcal: nil, why: "Low-impact cardio that fits a deficit."),
                FixturePlanItem(title: "Grilled chicken salad", timeMinutes: 750, kind: "meal", subtitle: "Lunch · 12:30 PM", kcal: 420, why: "Lean protein, high volume, low calorie density."),
                FixturePlanItem(title: "Greek yogurt + almonds", timeMinutes: 960, kind: "meal", subtitle: "Snack · 4:00 PM", kcal: 220, why: "Bridges the afternoon without derailing today's budget."),
                FixturePlanItem(title: "Salmon, rice, broccoli", timeMinutes: 1140, kind: "meal", subtitle: "Dinner · 7:00 PM", kcal: 520, why: "Balanced macros to close out the day on target."),
            ],
            // Macros sum to the Profile-level protein/carbs/fat above (96/79/35),
            // and 4P+4C+9F ≈ kcal per meal (FixtureMealMacroTests)
            // — kcal per meal stays as-is (PR #208 aligned consumedKcal to
            // these sums already); only the macro grams were adjusted here.
            meals: [
                FixtureMeal(name: "Overnight oats with berries", kcal: 380, c: 48, p: 24, f: 10, slot: "breakfast"),
                FixtureMeal(name: "Grilled chicken salad", kcal: 420, c: 19, p: 52, f: 15, slot: "lunch"),
                FixtureMeal(name: "Greek yogurt + almonds", kcal: 220, c: 12, p: 20, f: 10, slot: "snacks"),
            ],
            weightKg: 82, weightTrendPerWeekKg: -0.6,
            hrv: 58, restingHR: 57, sleepMinutes: 410, steps: 8600, distanceKm: 6.1,
            workoutTitle: nil, workoutKm: nil
        ),
        .muscle: Profile(
            goal: "muscle",
            name: "Priya Okafor",
            // The weekday is derived from the SAME relative date as `lastLift`
            // below (2 days ago), so "Tuesday's squat" can never contradict
            // "Last (Tue): Squat 3×5 @ 140 kg" whatever day the fixture runs.
            // "2 remaining" = the 4-session weekly target minus the 2 done this
            // week (`plannedSessionsThisWeek` / `completedSessionsThisWeek`
            // below), so it agrees with the goal line's "2 more by Sun" (the
            // goal verdict is "Sessions behind") — pinned in FixtureCrossScreenConsistencyTests.
            insight: "Protein's on target four days running and \(weekdayName(daysAgo: 2))'s squat was your best in 4 weeks — get the 2 remaining sessions in by Sunday.",
            established: true,
            targetKcal: 2900, consumedKcal: 1560,
            protein: 158, proteinTarget: 190, carbs: 138, carbsTarget: 300, fat: 42, fatTarget: 85,
            plan: [
                FixturePlanItem(title: "Egg + oat protein bowl", timeMinutes: 420, kind: "meal", subtitle: "Breakfast · 7:00 AM", kcal: 560, why: "Sets up protein synthesis early."),
                FixturePlanItem(title: "Lower-body strength", timeMinutes: 630, kind: "move", subtitle: "Train · 10:30 AM", kcal: nil, why: "Progressive overload on squat + deadlift."),
                FixturePlanItem(title: "Chicken, rice, avocado", timeMinutes: 780, kind: "meal", subtitle: "Lunch · 1:00 PM", kcal: 680, why: "Refeeds glycogen after this morning's session."),
                FixturePlanItem(title: "Protein shake + banana", timeMinutes: 990, kind: "meal", subtitle: "Snack · 4:30 PM", kcal: 320, why: "Keeps protein intake spread across the day."),
                FixturePlanItem(title: "Steak, sweet potato, greens", timeMinutes: 1170, kind: "meal", subtitle: "Dinner · 7:30 PM", kcal: 720, why: "Closes the surplus needed for this week's gain rate."),
            ],
            // Macros sum to the Profile-level protein/carbs/fat above
            // (158/138/42) — ScreenshotTests asserts "Protein 158 / 190 g",
            // so the top-level total is load-bearing; only the per-meal
            // grams were adjusted to actually add up to it. kcal per meal
            // unchanged (PR #208 aligned consumedKcal to these sums already).
            meals: [
                FixtureMeal(name: "Egg + oat protein bowl", kcal: 560, c: 50, p: 50, f: 18, slot: "breakfast"),
                FixtureMeal(name: "Chicken, rice, avocado", kcal: 680, c: 62, p: 63, f: 20, slot: "lunch"),
                FixtureMeal(name: "Protein shake + banana", kcal: 320, c: 26, p: 45, f: 4, slot: "snacks"),
            ],
            weightKg: 79, weightTrendPerWeekKg: 0.35,
            hrv: 62, restingHR: 52, sleepMinutes: 460, steps: 7200, distanceKm: 4.8,
            workoutTitle: nil, workoutKm: nil,
            // GET /api/training/summary (#202): last lift squat 3×5 @ 140kg,
            // 2 of 4 planned sessions done this week.
            lastLift: FixtureLastLift(exercise: "Squat", date: dayString(2), sets: 3, reps: 5, weightKg: 140),
            weeklyVolumeKm: nil,
            plannedSessionsThisWeek: 4,
            completedSessionsThisWeek: 2
        ),
        .endurance: Profile(
            goal: "endurance",
            name: "Marcus Nandy",
            insight: "This week's long run held goal pace with a lower average HR than last week — aerobic base is building nicely.",
            established: true,
            targetKcal: 2650, consumedKcal: 1140,
            protein: 92, proteinTarget: 130, carbs: 136, carbsTarget: 340, fat: 25, fatTarget: 75,
            plan: [
                FixturePlanItem(title: "Banana + peanut butter toast", timeMinutes: 390, kind: "meal", subtitle: "Breakfast · 6:30 AM", kcal: 340, why: "Fast-digesting carbs ahead of the morning run."),
                FixturePlanItem(title: "Intervals 6×800 m", timeMinutes: 420, kind: "move", subtitle: "Run · 7:00 AM", kcal: nil, why: "Race-pace reps to sharpen top-end speed."),
                FixturePlanItem(title: "Rice bowl with chicken", timeMinutes: 780, kind: "meal", subtitle: "Lunch · 1:00 PM", kcal: 560, why: "Replenishes glycogen spent on the morning intervals."),
                FixturePlanItem(title: "Electrolyte smoothie", timeMinutes: 990, kind: "meal", subtitle: "Snack · 4:30 PM", kcal: 240, why: "Rehydration ahead of tomorrow's easy run."),
                FixturePlanItem(title: "Pasta with turkey ragu", timeMinutes: 1140, kind: "meal", subtitle: "Dinner · 7:00 PM", kcal: 620, why: "Carb-forward dinner to top off glycogen stores."),
            ],
            // Macros sum to the Profile-level protein/carbs/fat above
            // (92/136/25) — kcal per meal unchanged (PR #208 aligned
            // consumedKcal to these sums already); only the macro grams
            // were adjusted here.
            meals: [
                FixtureMeal(name: "Banana + peanut butter toast", kcal: 340, c: 38, p: 20, f: 12, slot: "breakfast"),
                FixtureMeal(name: "Rice bowl with chicken", kcal: 560, c: 62, p: 55, f: 10, slot: "lunch"),
                FixtureMeal(name: "Electrolyte smoothie", kcal: 240, c: 36, p: 17, f: 3, slot: "snacks"),
            ],
            weightKg: 61, weightTrendPerWeekKg: -0.1,
            hrv: 51, restingHR: 54, sleepMinutes: 348, steps: 11200, distanceKm: 12.4,
            workoutTitle: "10km tempo run", workoutKm: 10.2,
            // GET /api/training/summary (#202) for endurance is computed from
            // the real Monday-start local week by `enduranceWeek()` (no plan
            // data => `plannedSessions: null`, the "N sessions this week"
            // no-dots path) — deliberately NOT last week's review totals
            // (3 sessions, 24.5 km), so "this week" and the weekly review
            // never show the same numbers.
            lastLift: nil
        ),
    ]

    // MARK: - Entry point

    /// `scenario` is `nil` only if this were somehow reached without
    /// `FixtureMode.isActive` (impossible in practice — `FixtureURLProtocol
    /// .canInit` already gates on it), handled defensively rather than force-
    /// unwrapped.
    static func response(scenario: FixtureMode.Scenario?, method: String, path: String, query: String, body: Data = Data()) -> (Int, Data) {
        guard let scenario else { return (404, jsonData(["error": "no active fixture scenario"])) }

        if scenario == .serverError {
            return (500, jsonData(["error": "Internal Server Error (fixture)"]))
        }

        // `.onboarding` never reaches a data screen, but falls back to the
        // `newUser` profile harmlessly if it somehow does.
        let profile = profiles[scenario] ?? profiles[.newUser]!

        switch (method, path) {
        case ("DELETE", "/api/account"):
            return (204, Data())
        case ("GET", "/api/today"):
            return (200, jsonData(today(profile, scenario: scenario)))
        case ("GET", "/api/plan"):
            return (200, jsonData(plan(profile)))
        case ("GET", "/api/streak"):
            return (200, jsonData(["streakDays": profile.established ? 6 : 0]))
        case ("GET", "/api/pending-facts"):
            return (200, jsonData(["items": pendingFacts(profile)]))
        case ("GET", "/api/memory"):
            return (200, jsonData(memory(profile)))
        // Dynamic-id routes (memory-contract.md §2/§3) — matched by prefix
        // since `FixtureData.response` only sees the request's path, not a
        // router's path params.
        case ("PATCH", let p) where p.hasPrefix("/api/memory/facts/"):
            return (200, jsonData(editedMemoryFact(id: String(p.dropFirst("/api/memory/facts/".count)), body: body)))
        case ("POST", let p) where p.hasPrefix("/api/memory/facts/") && p.hasSuffix("/undo"):
            return (200, jsonData(["ok": true]))
        case ("GET", let p) where p.hasPrefix("/api/memory/entities/"):
            return (200, jsonData(entityDocument(id: String(p.dropFirst("/api/memory/entities/".count)))))
        case ("GET", "/api/coach"):
            return (200, jsonData(coachRestoration(profile, scenario: scenario)))
        case ("GET", "/api/coach/opener"):
            return (200, jsonData(["text": profile.established ? coachOpener(for: scenario, profile: profile) : newUserCoachOpener]))
        case ("POST", "/api/coach"):
            // Never exercised by the screenshot harness (see
            // `FixtureURLProtocol.startLoading`) — a well-formed empty SSE
            // stream in case something unexpected reaches it.
            return (200, Data("data: {\"type\":\"done\"}\n\n".utf8))
        case ("GET", "/api/trends"):
            return query.contains("metrics=")
                ? (200, jsonData(trendsBatch(profile, scenario: scenario, query: query)))
                : (200, jsonData(trendsSingle(profile, scenario: scenario, query: query)))
        case ("GET", "/api/trends/drivers"):
            return (200, jsonData(trendsDrivers(profile, scenario: scenario, query: query)))
        case ("GET", "/api/trends/markers"):
            return (200, jsonData(trendsMarkers(scenario: scenario, query: query)))
        case ("GET", "/api/logs"):
            return (200, jsonData(logs(profile, scenario: scenario)))
        case ("GET", let p) where p.hasPrefix("/api/workout-analyses/"):
            guard let data = workoutAnalysisFixture(id: String(p.dropFirst("/api/workout-analyses/".count)), profile: profile, scenario: scenario) else {
                return (404, jsonData(["error": "no fixture workout analysis for this id"]))
            }
            return (200, jsonData(data))
        case ("GET", let p) where p.hasPrefix("/api/sleep-analyses/"):
            guard let data = sleepAnalysisFixture(id: String(p.dropFirst("/api/sleep-analyses/".count)), profile: profile, scenario: scenario) else {
                return (404, jsonData(["error": "no fixture sleep analysis for this id"]))
            }
            return (200, jsonData(data))
        case ("GET", "/api/diet-goal"):
            return (200, jsonData(dietGoal(profile)))
        case ("GET", "/api/meals/log"):
            return (200, jsonData(mealLogs(profile)))
        case ("GET", "/api/profile"):
            return (200, jsonData(profileResponse(profile)))
        case ("PATCH", "/api/profile"):
            return (200, Data("{}".utf8))
        case ("GET", "/api/nutrition/recents"):
            return (200, jsonData(["items": recents(profile)]))
        case ("GET", "/api/notifications"):
            let notifications: [String: Any] = ["items": [String](), "unreadCount": 0]
            return (200, jsonData(notifications))
        case ("GET", "/api/notification-preferences"):
            return (200, jsonData(notificationPreferences()))
        case ("GET", "/api/weight-log"):
            return (200, jsonData(weightLog(profile)))
        case ("POST", "/api/weight-log"):
            return (200, jsonData(["ok": true]))
        case ("GET", "/api/training/summary"):
            // Only `.muscle`/`.endurance` carry training-summary data — every
            // other scenario 404s here, same as a real backend account with
            // no training history, so the muscle/endurance heroes' new lines
            // stay fail-soft-hidden everywhere else.
            guard let data = trainingSummary(profile) else {
                return (404, jsonData(["error": "no training summary for this fixture scenario"]))
            }
            return (200, jsonData(data))
        case ("GET", "/api/workouts/summary"):
            return (200, jsonData(workoutSummary(scenario: scenario)))
        case ("GET", "/api/workouts/last"):
            return (200, jsonData(workoutLastSession(scenario: scenario)))
        case ("GET", "/api/workouts/sessions"):
            return (200, jsonData(workoutRecentSessions(scenario: scenario)))
        case ("POST", "/api/workouts/sets"):
            let saved: [String: Any] = ["ok": true, "sets": [[String: Any]]()]
            return (200, jsonData(saved))
        case ("GET", "/api/goal/progress"):
            return (200, jsonData(goalProgress(profile, scenario: scenario)))
        case ("GET", "/api/review/weekly"):
            return (200, jsonData(weeklyReview(scenario: scenario)))
        case ("POST", "/api/review/weekly/seen"):
            return (200, jsonData(["ok": true]))
        case ("GET", "/api/devices"):
            return (200, jsonData(devices(scenario: scenario)))
        default:
            return (404, jsonData(["error": "unhandled fixture endpoint: \(method) \(path)"]))
        }
    }

    // MARK: - JSON / date helpers

    private static func jsonData(_ object: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    }

    /// `Any?` → `Any`, encoding a Swift `nil` as JSON `null` for
    /// `JSONSerialization` (which otherwise can't represent an Optional).
    private static func nullable(_ value: Any?) -> Any { value ?? NSNull() }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static var isoNow: String { isoFormatter.string(from: Date()) }

    private static func isoDaysAgo(_ days: Int) -> String {
        let date = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        return isoFormatter.string(from: date)
    }

    /// `daysAgo` days before today, at a specific local hour/minute — for
    /// analysis-fixture timestamps (workout start times, sleep bed/wake
    /// times) that need to read as a believable time of day rather than
    /// "now".
    private static func isoAt(daysAgo: Int, hour: Int, minute: Int) -> String {
        isoFormatter.string(from: dateAt(daysAgo: daysAgo, hour: hour, minute: minute))
    }

    private static func dateAt(daysAgo: Int, hour: Int, minute: Int) -> Date {
        var calendar = Calendar.current
        calendar.timeZone = .current
        let day = calendar.date(byAdding: .day, value: -daysAgo, to: Date()) ?? Date()
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// "Dec 30" for the day `daysAgo` days back (negative = future).
    private static func raceMonthDay(_ daysAgo: Int) -> String {
        let date = Calendar.current.date(byAdding: .day, value: -daysAgo, to: Date()) ?? Date()
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }

    /// "mid-Dec" for the day `daysAhead` days from today — mirrors
    /// lib/goalProgress.ts `looseMonthPosition` (days 1–7 early, 8–22 mid, 23+ late).
    private static func looseMonthPosition(daysAhead: Int) -> String {
        let date = Calendar.current.date(byAdding: .day, value: daysAhead, to: Date()) ?? Date()
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM"
        let month = f.string(from: date)
        let day = Calendar.current.component(.day, from: date)
        return day <= 7 ? "early \(month)" : day <= 22 ? "mid-\(month)" : "late \(month)"
    }

    private static func dayString(_ daysAgo: Int) -> String {
        let date = Calendar.current.date(byAdding: .day, value: -daysAgo, to: Date()) ?? Date()
        return dayFormatter.string(from: date)
    }

    /// Full English weekday name ("Tuesday") for the day `daysAgo` days back
    /// (negative = future), in the same local calendar day `dayString(_:)`
    /// resolves. Any fixture copy that names a weekday for a relative date
    /// MUST come from here — a hard-coded "Monday" drifts out of sync with
    /// `dayString(2)` as soon as the fixture runs on a different weekday.
    static func weekdayName(daysAgo: Int, now: Date = Date()) -> String {
        let date = Calendar.current.date(byAdding: .day, value: -daysAgo, to: now) ?? now
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "EEEE"
        return f.string(from: date)
    }

    // MARK: - Deterministic noise (Trends phase-1 realistic fixture series)

    /// A stable per-string seed — deliberately NOT `String.hashValue`, whose
    /// hash seed is randomized per process launch (`SipHash` with a random
    /// key), which would make every "noisy" series a different shape on
    /// every app launch and break the screenshot harness's reproducibility.
    private static func stableSeed(_ key: String) -> Int {
        key.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
    }

    /// Deterministic pseudo-random value in [0, 1) — a classic sine-hash,
    /// not cryptographic, just reproducible across runs for the same `seed`.
    private static func pseudoRandom01(_ seed: Int) -> Double {
        let x = sin(Double(seed) * 12.9898) * 43758.5453
        return x - x.rounded(.down)
    }

    /// One noisy day's value: `base` plus a small pseudo-random wiggle and a
    /// slow sine drift, both scaled to `amplitude` (typically a fraction of
    /// `sd`, so the visual noise never itself masquerades as an out-of-band
    /// reading — `trendsBatch` overrides this entirely for the single
    /// "today" point a persona's `movedMetrics` entry deliberately pushes
    /// out of range).
    /// Coefficients sum to 0.7 (well under the ±1σ verdict boundary), so a
    /// metric with no `movedMetrics` override for this scenario can never
    /// accidentally read as `.above`/`.below` purely from noise, even in the
    /// unlikely case both terms land at their theoretical extremes at once.
    private static func noisyValue(seed: Int, offset: Int, base: Double, amplitude: Double) -> Double {
        let n = pseudoRandom01(seed &+ offset &* 97)
        let noise = (n - 0.5) * 2 * amplitude * 0.5
        let drift = sin((Double(offset) + Double(seed % 17)) / 9.0) * amplitude * 0.2
        return base + noise + drift
    }

    /// Shared per-day value generator behind BOTH `trendsSingle` and
    /// `trendsBatch`, so the single-metric 7-day responses the weekly summary
    /// strip (sleep avg/hrv/resting hr, `WeeklyHeadlineStrip`) fetches always
    /// agree with the batch series tiles/"What moved" use for the SAME
    /// metric — same `key`, same `base`/`sd`/`seed` in, same value out.
    ///
    /// `offset` is days-ago (0 = today). For a designated "moved" metric
    /// (`pushesAbove` non-nil), the ±1.8σ override ramps linearly from 0 at
    /// `offset == 6` up to full strength at `offset == 1`, then holds at
    /// `offset == 0` — a believable multi-day drift into the reading rather
    /// than a single-day spike — while every other metric (and offsets
    /// beyond 6, for longer windows) keeps the flat baseline plus noise.
    /// `mean30`/`sd30` are served as constants independent of this — see
    /// `trendsBatch`'s `baseline` — so the ramp doesn't skew the verdict math
    /// non-designated metrics are checked against.
    private static func seriesValue(offset: Int, base: Double, sd: Double, dailyTrend: Double, seed: Int, pushesAbove: Bool?) -> Double {
        let trend = dailyTrend * Double(offset)
        if let pushesAbove, offset <= 6 {
            let rampFraction: Double = offset == 0 ? 1.0 : Double(6 - offset) / 5.0
            let overrideDelta = (pushesAbove ? 1.8 : -1.8) * sd * rampFraction
            return base + trend + overrideDelta
        }
        return trend + noisyValue(seed: seed, offset: offset, base: base, amplitude: sd)
    }

    /// Per-scenario metrics whose LATEST ("today") reading is deliberately
    /// pushed out of its normal band, so `TrendsWhatMoved`/the headline have
    /// something to show — the persona spec's 2-3 "moved" metrics per
    /// scenario. `true` pushes the latest reading above the mean, `false`
    /// below; every other metric's latest reading stays within the noise
    /// band above and lands `.normal`.
    private static let movedMetrics: [FixtureMode.Scenario: [String: Bool]] = [
        // weight_loss: resting HR below normal (good — lowerIsBetter), HRV
        // above (good — higherIsBetter), sleep minutes below (watch —
        // higherIsBetter).
        .weightLoss: ["resting_hr": false, "hrv_sdnn": true, "sleep_minutes": false],
        // endurance: HRV below (watch), resting HR above (watch).
        // sleep too: last night's short sleep after the late hard run.
        .endurance: ["hrv_sdnn": false, "resting_hr": true, "sleep_minutes": false],
    ]

    // MARK: - Single-source "today" values + normal bands

    /// Relative sd of every fixture series (`mean30`/`sd30` are served as
    /// `base` / `base * sdFraction`).
    private static let sdFraction = 0.06
    /// How far (in sd) a "moved" metric's latest reading sits from normal.
    private static let movedZ = 1.8

    /// The one "today" value for metrics several screens show — `nil` for
    /// every other metric. Sleep is in HOURS (the wire unit of both
    /// `/api/today` and the `sleep_minutes` series).
    private static func todayValue(_ key: String, _ profile: Profile) -> Double? {
        switch key {
        case "hrv_sdnn":      return profile.hrv
        case "resting_hr":    return profile.restingHR
        case "sleep_minutes": return profile.sleepMinutes / 60
        case "body_mass_kg":  return profile.weightKg
        default:              return nil
        }
    }

    /// The series' "normal" (`mean30`). For a metric a scenario deliberately
    /// pushes out of range, it is back-solved so the latest reading
    /// (`todayValue`) sits exactly `movedZ` sd from it — which keeps the
    /// profile's "today" number the one every screen shows while "What
    /// moved" still has something to say.
    private static func normalBase(_ key: String, _ profile: Profile, _ scenario: FixtureMode.Scenario?) -> Double {
        if let scenario, let pinned = pinnedNormals[scenario]?[key] { return pinned }
        let value = baseValue(key, profile)
        guard todayValue(key, profile) != nil,
              let pushesAbove = (movedMetrics[scenario ?? .newUser] ?? [:])[key] else { return value }
        return value / (1 + (pushesAbove ? 1 : -1) * movedZ * sdFraction)
    }

    /// Metrics whose "normal" (`mean30`) is a round, human-checkable number
    /// instead of back-solved from today's reading. Endurance HRV: today 51 ms
    /// against a normal of 57 ms (band 57 ± 3.4 → "54–60") reads "6 ms below
    /// your normal (57 ms)" on the detail, "−11% vs normal" on Today
    /// ((51−57)/57 = −10.5%) and the same in What moved. `seriesPoint` also
    /// pins the 30-day series MEAN to this value, so the detail's "Avg · 30d"
    /// stat (computed from the points) agrees with the normal.
    private static let pinnedNormals: [FixtureMode.Scenario: [String: Double]] = [
        .endurance: ["hrv_sdnn": 57],
    ]

    /// "above" | "normal" | "below" — where `todayValue` sits against normal.
    private static func vsNormal(_ key: String, _ scenario: FixtureMode.Scenario?) -> String {
        guard let pushesAbove = (movedMetrics[scenario ?? .newUser] ?? [:])[key] else { return "normal" }
        return pushesAbove ? "above" : "below"
    }

    /// One series point (`offset` = days ago, 0 = today) — shared by
    /// `trendsSingle`, `trendsBatch`, the sleep analysis' week strip and the
    /// coach receipts, so they can never disagree. Today's point of any
    /// metric with a `todayValue` is exactly that value.
    private static func seriesPoint(key: String, offset: Int, profile: Profile, scenario: FixtureMode.Scenario?) -> Double {
        let raw = rawSeriesPoint(key: key, offset: offset, profile: profile, scenario: scenario)
        // Pinned-normal metrics: shift only the settled days (offset >= 7, i.e.
        // outside the 7-day "moved" ramp and today's exact reading) by one
        // constant so the full 30-point series averages exactly the normal.
        guard offset >= 7, let scenario, pinnedNormals[scenario]?[key] != nil else { return raw }
        let count = dataDays(profile)
        guard count > 7 else { return raw }
        let total = (0..<count).reduce(0.0) {
            $0 + rawSeriesPoint(key: key, offset: $1, profile: profile, scenario: scenario)
        }
        return raw + (normalBase(key, profile, scenario) * Double(count) - total) / Double(count - 7)
    }

    private static func rawSeriesPoint(key: String, offset: Int, profile: Profile, scenario: FixtureMode.Scenario?) -> Double {
        if offset == 0, let today = todayValue(key, profile) { return today }
        let base = normalBase(key, profile, scenario)
        // `seriesValue` adds `dailyTrend * offset` (days ago), so a LOSING
        // rate (negative) needs a positive per-day-ago slope: past weights
        // were higher.
        let dailyTrend = key == "body_mass_kg" ? -profile.weightTrendPerWeekKg / 7 : 0
        let pushesAbove = (movedMetrics[scenario ?? .newUser] ?? [:])[key]
        return seriesValue(
            offset: offset, base: base, sd: base * sdFraction, dailyTrend: dailyTrend,
            seed: stableSeed(key), pushesAbove: pushesAbove
        )
    }

    /// "49–55" — the HRV detail's "Normal (range)" text (`mean30 ± sd30`, 0
    /// decimals — see `MetricDetailView.normalRangeText`), reused verbatim by
    /// the coach's receipt.
    private static func hrvNormalRange(_ profile: Profile, _ scenario: FixtureMode.Scenario?) -> String {
        let base = normalBase("hrv_sdnn", profile, scenario)
        let sd = base * sdFraction
        return "\(String(format: "%.0f", base - sd))–\(String(format: "%.0f", base + sd))"
    }

    /// Last-7-nights sleep stats from the SAME series Trends' "Sleep this
    /// week" strip renders, so the weekly review and the coach quote exactly
    /// what Trends shows.
    private static func weekSleepStats(_ profile: Profile, _ scenario: FixtureMode.Scenario?) -> (avgMinutes: Double, nightsUnder6h: Int) {
        let nights = (0...6).map {
            seriesPoint(key: "sleep_minutes", offset: $0, profile: profile, scenario: scenario) * 60
        }
        return (nights.reduce(0, +) / Double(nights.count), nights.filter { $0 < 360 }.count)
    }

    /// Signed whole-unit gap between today's reading and its normal ("+5").
    private static func gapToNormal(_ key: String, _ profile: Profile, _ scenario: FixtureMode.Scenario?) -> Int {
        guard let today = todayValue(key, profile) else { return 0 }
        return Int((today - normalBase(key, profile, scenario)).rounded())
    }

    /// 410 -> "6h 50m" (same format as Today's sleep tile / Logs subtitle).
    private static func hoursMinutes(_ minutes: Double) -> String {
        let total = Int(minutes.rounded())
        return "\(total / 60)h \(total % 60)m"
    }

    /// "50 minutes" / "an hour" — a difference, rounded to 5.
    private static func humanDuration(_ minutes: Double) -> String {
        let rounded = Int((minutes / 5).rounded()) * 5
        return rounded == 60 ? "an hour" : "\(rounded) minutes"
    }

    /// Last night's sleep story for a scenario — all derived from
    /// `profile.sleepMinutes`.
    private struct SleepStory {
        let minutes: Double
        let awake: Double
        let core: Double
        let deep: Double
        let rem: Double
        let wake: Date
        let bed: Date
    }

    private static func sleepStory(_ profile: Profile, scenario: FixtureMode.Scenario) -> SleepStory {
        let minutes = profile.sleepMinutes
        let awake: Double = scenario == .endurance ? 38 : (minutes * 0.07).rounded()
        let deep = (minutes * 0.12).rounded()
        let rem = (minutes * 0.18).rounded()
        let wakeHour = 6
        let wakeMinute = scenario == .endurance ? 10 : (scenario == .muscle ? 20 : 15)
        let wake = dateAt(daysAgo: 0, hour: wakeHour, minute: wakeMinute)
        return SleepStory(
            minutes: minutes, awake: awake, core: minutes - deep - rem, deep: deep, rem: rem,
            wake: wake, bed: wake.addingTimeInterval(-(minutes + awake) * 60)
        )
    }

    // MARK: - Shared calibration block

    /// `CalibrationStatus`.
    private static func calibration(_ profile: Profile) -> [String: Any] {
        // Same day count as `trendsBatch`' per-series `dataDays`, so Today's
        // "N of 14 days" and Trends' "N/14" read ONE source.
        let days = dataDays(profile)
        var metrics: [String: Any] = [:]
        for key in ["hrv_sdnn", "resting_hr", "sleep_minutes"] {
            metrics[key] = ["dataDays": days, "established": profile.established]
        }
        return ["status": profile.established ? "ready" : "calibrating", "metrics": metrics]
    }

    /// Days of data collected — the single source for the calibration
    /// counters (Today card, Trends ring), the streak, and how many series
    /// points a scenario carries. `new_user` has exactly one day (signup),
    /// so it has one streak day and one sleep bar, not a full week.
    private static func dataDays(_ profile: Profile) -> Int { profile.established ? 30 : 1 }

    /// Points a given series carries. `new_user` has not connected Apple
    /// Health, so its HealthKit-sourced sleep series is empty (Trends shows
    /// the sleep empty state rather than a made-up "7h 00m").
    private static func seriesDays(_ key: String, _ profile: Profile) -> Int {
        if !profile.established && key == "sleep_minutes" { return 0 }
        return dataDays(profile)
    }

    // MARK: - GET /api/today → TodayResponse

    private static func today(_ profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any] {
        // `deltaPct` = today vs the series' normal (`normalBase`), so the tile's
        // delta agrees with Trends' "What moved".
        func metric(_ key: String, unit: String) -> [String: Any] {
            let value = todayValue(key, profile) ?? 0
            let normal = normalBase(key, profile, scenario)
            let delta = normal == 0 ? 0 : Int(((value - normal) / normal * 100).rounded())
            return profile.established
                ? ["value": value, "unit": unit, "deltaPct": delta]
                : ["value": NSNull(), "unit": unit, "deltaPct": NSNull()]
        }
        let dietBudget: [String: Any] = [
            "targetKcal": profile.targetKcal,
            "consumedKcal": profile.consumedKcal,
            "remaining": max(0, profile.targetKcal - profile.consumedKcal),
            "protein": profile.protein, "carbs": profile.carbs, "fat": profile.fat,
            "proteinTarget": profile.proteinTarget, "carbsTarget": profile.carbsTarget, "fatTarget": profile.fatTarget,
            "mode": "auto", "goal": profile.goal,
            "consumedSource": profile.consumedKcal > 0 ? "logged" : "none",
            "consumedSourceName": NSNull(),
        ]
        return [
            "metrics": [
                "hrv": metric("hrv_sdnn", unit: "ms"),
                // /api/today sends sleep in HOURS (unit "h"), e.g. 7.25 — see
                // app/api/today/route.ts's documented response shape.
                // `profile.sleepMinutes` is authored in minutes for
                // readability, so convert here.
                "sleep": metric("sleep_minutes", unit: "h"),
                "restingHr": metric("resting_hr", unit: "bpm"),
            ],
            "dietBudget": dietBudget,
            "insight": profile.insight,
            "plan": profile.plan.map { item -> [String: Any] in
                ["name": item.title, "kcal": item.kcal ?? 0, "why": item.why]
            },
            "calibration": calibration(profile),
        ]
    }

    // MARK: - GET /api/plan → PlanResponse

    private static func plan(_ profile: Profile) -> [String: Any] {
        // A plan item whose meal is already in the fixture's logged meals is
        // "done", so Today's Next-up agrees with the Logs / diet sheet.
        let loggedMealNames = Set(profile.meals.map { $0.name })
        let items = profile.plan.enumerated().map { index, item -> [String: Any] in
            let isLogged = item.kind == "meal" && loggedMealNames.contains(item.title)
            return [
                "id": "fixture-plan-\(index)",
                "timeMinutes": item.timeMinutes,
                "title": item.title,
                "subtitle": item.subtitle,
                "kind": item.kind,
                "source": "coach",
                "status": isLogged ? "done" : "pending",
                "kcal": nullable(item.kcal),
            ]
        }
        return ["items": items]
    }

    // MARK: - GET /api/coach → CoachRestorationResponse

    /// `established` scenarios seed a restored transcript (the returning-user
    /// opener, already sent) so the Coach tab shows real history. `new_user`
    /// (`established == false`) seeds none — an empty history is what makes
    /// `CoachViewModel.loadOpener()` fall through to fetching
    /// `/api/coach/opener`, whose fixture response is the new-user copy.
    ///
    /// Every established scenario (weight_loss/muscle/endurance) also gets
    /// one past exchange exercising chat-activity-contract.md §3's `activity`
    /// array (a memory read with 2 sources, a sleep read, and an HRV
    /// baseline read — the exact §4/K2 pill example, "Sleep, HRV and 2 of
    /// your notes") and a second exchange with a `memory.saved` op, so the
    /// screenshot harness always has a receipt pill to capture
    /// (`captureCoach`/`captureCoachReceipt`).
    private static func coachRestoration(_ profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any] {
        let activePersona: [String: Any] = [
            "id": "vital", "title": "Vital Coach", "subtitle": "Your personal coach",
            "accent": "#7C6CF2", "icon": "sparkles", "sessionId": NSNull(),
        ]
        guard profile.established else {
            return [
                "messages": [Any](),
                "activePersona": activePersona,
                "pendingCard": NSNull(),
            ]
        }
        let opener: [String: Any] = [
            "id": "00000000-0000-4000-8000-000000000001",
            "role": "assistant",
            "speaker": "vital",
            "content": coachOpener(for: scenario, profile: profile),
            "timestamp": isoNow,
            "specialistSessionId": NSNull(),
            "specialistMetadata": NSNull(),
        ]
        return [
            "messages": [opener] + tirednessExchange(profile, scenario: scenario) + memorySavedExchange(),
            "activePersona": activePersona,
            "pendingCard": NSNull(),
        ]
    }

    /// "Why am I so tired this week?" — a memory read (2 sources), a sleep
    /// read, and an HRV baseline read, each with a `summary` — see
    /// `coachRestoration(_:)`'s doc comment. Every number is derived from the
    /// same series/profile the Today tiles and Trends read, so the receipt
    /// ("58 ms today · normal 49–55 ms"), the tile and the HRV detail's
    /// "Normal (range)" always agree.
    private static func tirednessExchange(_ profile: Profile, scenario: FixtureMode.Scenario) -> [[String: Any]] {
        let question: [String: Any] = [
            "id": "00000000-0000-4000-8000-000000000002",
            "role": "user",
            "speaker": "user",
            "content": "Why am I so tired this week?",
            "timestamp": isoDaysAgo(1),
            "specialistSessionId": NSNull(),
            "specialistMetadata": NSNull(),
        ]

        let weekSleep = weekSleepStats(profile, scenario)
        let avgMinutes = weekSleep.avgMinutes
        let shortNights = weekSleep.nightsUnder6h
        let lastNight = hoursMinutes(profile.sleepMinutes)
        let usualMinutes = normalBase("sleep_minutes", profile, scenario) * 60
        let hrvToday = Int(profile.hrv.rounded())
        let hrvRange = hrvNormalRange(profile, scenario)
        // Signed gap to normal in whole ms (positive = above normal).
        let hrvGap = Int((profile.hrv - normalBase("hrv_sdnn", profile, scenario)).rounded())

        let activity: [[String: Any]] = [
            [
                "name": "read_memory",
                "label": "Checked your notes",
                "kind": "memory",
                "ok": true,
                "summary": "2 notes",
                "sources": [
                    ["text": "New baby born 2 Sep — night feeds, usually 2 a night.", "date": "2026-09-04"],
                    ["text": "Prefers running in the morning.", "date": "2026-08-18"],
                ],
            ],
            [
                "name": "get_sleep_summary",
                "label": "Checked your sleep",
                "kind": "data",
                "ok": true,
                "summary": "Last 7 nights · avg \(hoursMinutes(avgMinutes))",
            ],
            [
                "name": "get_baseline",
                "label": "Compared HRV with your normal",
                "kind": "data",
                "ok": true,
                "summary": "\(hrvToday) ms today · normal \(hrvRange) ms",
            ],
        ]

        let content: String
        switch scenario {
        case .endurance:
            content = "Mostly sleep. Last night was \(lastNight) and you've averaged \(hoursMinutes(avgMinutes)) this week, with \(shortNights) of the last 7 nights under 6 hours. Your HRV is \(abs(hrvGap)) ms under your normal — the pattern you usually get after short nights."
        case .weightLoss:
            content = "Mostly short sleep. Last night was \(lastNight), about \(humanDuration(usualMinutes - profile.sleepMinutes)) under your usual — but your HRV is \(abs(hrvGap)) ms above your normal, so you're recovering fine. With two night feeds, the short sleep is expected — protect a nap or an earlier wind-down on non-feed nights; it's not your training."
        default:
            content = "Not much points to sleep — last night was \(lastNight) and your HRV (\(hrvToday) ms) is inside your normal \(hrvRange) ms. A heavy training week can feel draining even when recovery looks fine; keep protein up and ease the next session if it lingers."
        }

        let answer: [String: Any] = [
            "id": "00000000-0000-4000-8000-000000000003",
            "role": "assistant",
            "speaker": "vital",
            "content": content,
            "timestamp": isoDaysAgo(1),
            "specialistSessionId": NSNull(),
            "specialistMetadata": NSNull(),
            "activity": activity,
        ]
        return [question, answer]
    }

    /// A short follow-up that saves a memory fact — `memory.saved` op, so
    /// the fixture also exercises `MemorySavedChip`/Undo.
    private static func memorySavedExchange() -> [[String: Any]] {
        let statement: [String: Any] = [
            "id": "00000000-0000-4000-8000-000000000004",
            "role": "user",
            "speaker": "user",
            "content": "I found out I'm lactose intolerant btw",
            "timestamp": isoNow,
            "specialistSessionId": NSNull(),
            "specialistMetadata": NSNull(),
        ]
        let activity: [[String: Any]] = [
            [
                "name": "remember_fact",
                "label": "Noted",
                "kind": "memory",
                "ok": true,
                "memory": [
                    "op": "saved",
                    "text": "Lactose intolerant",
                    "factId": "fixture-fact-lactose",
                ],
            ],
        ]
        let answer: [String: Any] = [
            "id": "00000000-0000-4000-8000-000000000005",
            "role": "assistant",
            "speaker": "vital",
            "content": "Good to know — that changes a few of your usual meals. I'll keep it in mind.",
            "timestamp": isoNow,
            "specialistSessionId": NSNull(),
            "specialistMetadata": NSNull(),
            "activity": activity,
        ]
        return [statement, answer]
    }

    // MARK: - GET /api/trends?metric= → TrendsResponse

    /// Metric aliases `/api/trends?metric=` accepts, mapped to the
    /// `trendsBatch` key with the same underlying series — kept in sync so
    /// the weekly summary strip's sleep avg/hrv/resting hr always agree with
    /// the batch series tiles/"What moved" read for the same metric.
    /// `"sleep"` maps to `sleep_minutes`, whose wire value (despite the key
    /// name) is HOURS, not minutes — see `baseValue`'s comment; `trendsBatch`
    /// already serves it that way, so this alias keeps the two in the same
    /// unit as well as the same values.
    private static let singleMetricAliases: [String: String] = [
        "sleep": "sleep_minutes",
        "hrv": "hrv_sdnn",
        "rhr": "resting_hr",
    ]

    private static func trendsSingle(_ profile: Profile, scenario: FixtureMode.Scenario?, query: String) -> [String: Any] {
        let metricName = query
            .split(separator: "&")
            .first { $0.hasPrefix("metric=") }
            .map { String($0.dropFirst("metric=".count)) } ?? "sleep"
        let key = singleMetricAliases[metricName] ?? "sleep_minutes"
        let points = (0..<min(7, seriesDays(key, profile))).reversed().map { offset -> [String: Any] in
            ["date": dayString(offset), "value": seriesPoint(key: key, offset: offset, profile: profile, scenario: scenario)]
        }
        return ["metric": metricName, "points": points, "calibration": calibration(profile)]
    }

    // MARK: - GET /api/trends?metrics= → TrendsBatchResponse

    /// The 12 non-WHOOP `MetricCatalog` keys — WHOOP keys are deliberately
    /// left out of `series` entirely (a real backend does the same for an
    /// account with no WHOOP connection), which is what makes
    /// `TrendsIndexSections` hide the WHOOP section for every fixture
    /// scenario.
    private static let batchMetricKeys = [
        "hrv_sdnn", "resting_hr", "hr_avg", "sleep_minutes",
        "steps", "distance_m", "exercise_min", "flights",
        "active_energy_kcal", "basal_energy_kcal", "vo2_max", "body_mass_kg",
    ]

    private static func baseValue(_ key: String, _ profile: Profile) -> Double {
        switch key {
        case "hrv_sdnn":            return profile.hrv
        case "resting_hr":          return profile.restingHR
        case "hr_avg":              return profile.restingHR + 18
        // `sleep_minutes` is stored in minutes but the server applies
        // lib/metricCatalog.ts's `scale: 1/60` before sending — the wire
        // value (and this tile's display unit) is hours, same as
        // /api/today's `sleep` (see `today(_:)` above).
        case "sleep_minutes":       return profile.sleepMinutes / 60
        case "steps":                return profile.steps
        // `distance_m` is stored in meters but the server applies
        // lib/metricCatalog.ts's `scale: 1/1000` before sending — the wire
        // value (and this tile's display unit) is km.
        case "distance_m":          return profile.distanceKm
        case "exercise_min":        return 35
        case "flights":              return 8
        case "active_energy_kcal":  return 420
        case "basal_energy_kcal":   return 1650
        case "vo2_max":              return 42
        case "body_mass_kg":        return profile.weightKg
        default:                     return 0
        }
    }

    /// `scenario` picks this scenario's `movedMetrics` overrides; `query`
    /// supplies the requested `days=` (the Trends phase-1 period switch),
    /// clamped the same way the real backend clamps it, and used only to
    /// size the generated point count — a real 7D/30D/90D fixture load all
    /// shares the same per-metric baseline stats below.
    private static func trendsBatch(_ profile: Profile, scenario: FixtureMode.Scenario?, query: String) -> [String: Any] {
        let requestedDays = query
            .split(separator: "&")
            .first { $0.hasPrefix("days=") }
            .flatMap { Int($0.dropFirst("days=".count)) } ?? 30
        let days = min(max(requestedDays, 1), 365)
        // Bounded well under `days` for very long windows — the fixture
        // only needs enough points for a realistic sparkline, not a literal
        // one-row-per-day payload out to 365.
        let pointCount = min(max(days, 3), 90)

        var series: [String: Any] = [:]
        for key in batchMetricKeys {
            // The series' normal (`mean30`) — see `normalBase`. Only body
            // weight actually trends day over day in this fixture; every
            // other metric is a flat baseline plus noise. A realistic-looking
            // sd that comfortably clears every `MetricSpec.minMeaningfulSD`.
            let base = normalBase(key, profile, scenario)
            let sd = base * sdFraction

            let points = (0..<min(pointCount, seriesDays(key, profile))).reversed().map { offset -> [String: Any] in
                ["date": dayString(offset), "value": seriesPoint(key: key, offset: offset, profile: profile, scenario: scenario)]
            }
            let baseline: [String: Any] = [
                "mean7": base, "mean30": base, "mean60": base,
                "sd30": sd, "p25": base - 0.67 * sd, "p50": base, "p75": base + 0.67 * sd,
            ]
            let entry: [String: Any] = [
                // `label`/`unit` are decoded but never rendered — TrendsViewModel
                // looks the display name/unit up in its own local MetricCatalog
                // instead (see MetricCatalog.swift), so these are placeholders.
                "metric": key, "label": key, "unit": "",
                "points": points,
                "baseline": baseline,
                "dataDays": dataDays(profile),
                "established": profile.established,
                "lastDate": dayString(0),
            ]
            series[key] = entry
        }
        return [
            "days": days,
            "series": series,
            "unknownMetrics": [String](),
            "calibration": calibration(profile),
        ]
    }

    // MARK: - GET /api/trends/drivers?metric= → TrendsDriversResponse

    /// weight_loss/muscle/endurance get 2 certified `hrv_sdnn` drivers
    /// (`steps` lag 1 down, `dietary_carbs_g` lag 0 up) whose tercile means
    /// sit a fixed offset either side of that persona's own `profile.hrv` —
    /// so the "— N vs M ms" comparison always reads as a believable spread
    /// around the same HRV the rest of the screen shows. Mirrors the
    /// server's display rules (lib/insights/drivers.ts): every row has
    /// >= 28 pairs, |rho| >= 0.3 and a tercile gap wider than HRV's typical
    /// daily wobble; and because steps -> lower HRV reads like "walk less",
    /// weight_loss (a non-performance goal) gets it as the trailing
    /// `framing: "adaptation"` row ("Big activity days are followed by
    /// slightly lower HRV — normal adaptation; keep moving."), never as the
    /// headline. muscle/endurance keep it as a plain association (leading,
    /// by |rho|). Every other
    /// scenario/metric combination (including every metric for `new_user`,
    /// which never has an established baseline for the engine to certify
    /// anything against) returns an empty `drivers` array, matching the real
    /// route's own "never a 400/404" contract.
    private static let driverScenarios: Set<FixtureMode.Scenario> = [.weightLoss, .muscle, .endurance]

    /// Believable tercile means (+/-0.6 sd around the series mean, 1 decimal)
    /// clamped to the series' own [min, max], so they are always achievable
    /// averages of readings the records card also shows.
    static func driverTercileMeans(_ values: [Double]) -> (above: Double, below: Double) {
        guard let lo = values.min(), let hi = values.max(), !values.isEmpty else { return (0, 0) }
        let mean = values.reduce(0, +) / Double(values.count)
        let variance = values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(values.count)
        let step = variance.squareRoot() * 0.6
        func r1(_ v: Double) -> Double { (v * 10).rounded() / 10 }
        return (r1(min(mean + step, hi)), r1(max(mean - step, lo)))
    }

    private static func trendsDrivers(_ profile: Profile, scenario: FixtureMode.Scenario?, query: String) -> [String: Any] {
        let metric = query
            .split(separator: "&")
            .first { $0.hasPrefix("metric=") }
            .map { String($0.dropFirst("metric=".count)) } ?? ""

        guard let scenario, driverScenarios.contains(scenario), metric == "hrv_sdnn" else {
            return ["metric": metric, "computedFor": NSNull(), "drivers": [Any]()]
        }

        // Tercile means come from the SAME HRV series (the points `trendsBatch` returns) the detail's
        // chart/records render, so a driver can never quote a value outside
        // the records' own min/max ("61 vs 55 ms" against a 58 ms high).
        let hrvSeries = (0..<dataDays(profile)).map { seriesPoint(key: "hrv_sdnn", offset: $0, profile: profile, scenario: scenario) }
        let (hrvAbove, hrvBelow) = driverTercileMeans(hrvSeries)
        let stepsFraming = scenario == .weightLoss ? "adaptation" : "association"
        let stepsDriver: [String: Any] = [
            "input": "steps",
            "lag": 1,
            "direction": "down",
            "rho": -0.42,
            "pairs": 64,
            "high": ["mean": hrvBelow, "n": 21],
            "low": ["mean": hrvAbove, "n": 21],
            "highInputMean": profile.steps + 2200,
            "lowInputMean": max(profile.steps - 2200, 0),
            "framing": stepsFraming,
        ]
        let carbsDriver: [String: Any] = [
            "input": "dietary_carbs_g",
            "lag": 0,
            "direction": "up",
            "rho": 0.38,
            "pairs": 58,
            "high": ["mean": hrvAbove, "n": 19],
            "low": ["mean": hrvBelow, "n": 19],
            "highInputMean": 240.0,
            "lowInputMean": 140.0,
            "framing": "association",
        ]
        return [
            "metric": metric,
            "computedFor": dayString(0),
            // Same order the server returns: associations by |rho|, an
            // adaptation row always last.
            "drivers": scenario == .weightLoss ? [carbsDriver, stepsDriver] : [stepsDriver, carbsDriver],
        ]
    }

    // MARK: - GET /api/trends/markers?days= → TrendsMarkersResponse

    /// `?days=`, clamped exactly like the real route
    /// (`app/api/trends/markers/route.ts`'s `parseDaysParam`) — an
    /// unparseable value falls back to the same 90-day default.
    private static func requestedMarkerDays(_ query: String) -> Int {
        let raw = query
            .split(separator: "&")
            .first { $0.hasPrefix("days=") }
            .flatMap { Int($0.dropFirst("days=".count)) } ?? 90
        return min(max(raw, 1), 365)
    }

    /// 3 workouts most weeks, a 4th every other week — deterministic (no
    /// `Date()`-seeded randomness), so the screenshot harness always renders
    /// the same floor markers for the same `offset` (days ago, 0 = today).
    private static func isWorkoutDay(offset: Int) -> Bool {
        let dayOfWeek = offset % 7
        if dayOfWeek == 1 || dayOfWeek == 3 || dayOfWeek == 5 { return true }
        let weekIndex = offset / 7
        return dayOfWeek == 6 && weekIndex % 2 == 0
    }

    private static func trendsMarkers(scenario: FixtureMode.Scenario?, query: String) -> [String: Any] {
        let days = requestedMarkerDays(query)
        guard scenario != .newUser else {
            return ["days": days, "markers": [Any]()]
        }
        var markers: [[String: Any]] = []
        for offset in stride(from: days - 1, through: 0, by: -1) {
            guard isWorkoutDay(offset: offset) else { continue }
            let label = offset % 4 == 0 ? "Strength Training" : "Run"
            markers.append(["date": dayString(offset), "kind": "workout", "label": label, "count": 1])
        }
        return ["days": days, "markers": markers]
    }

    // MARK: - GET /api/logs → LogsResponse

    private static func logs(_ profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any] {
        var items: [[String: Any]] = []

        // Add all logged meals for the day
        for (index, meal) in profile.meals.enumerated() {
            items.append([
                "id": "fixture-log-meal-\(index)",
                "type": "meal_logged",
                "timestamp": isoAt(daysAgo: 0, hour: meal.logTime.hour, minute: meal.logTime.minute),
                "hasExactTime": true,
                "dayKey": NSNull(),
                "title": meal.name,
                "subtitle": "Logged · \(meal.slot.capitalized)",
                "imageThumb": NSNull(),
                "kcal": Double(meal.kcal),
                "km": NSNull(),
                "sleepMs": NSNull(),
                "analysisId": NSNull(),
            ])
        }

        // Every established scenario carries a workout row and a sleep row
        // whose `analysisId` resolves to a fixture `/api/workout-analyses/{id}`
        // and `/api/sleep-analyses/{id}` response with a full `context`
        // (analysis-v2-contract.md §2) — tapping either opens the redesigned
        // `AnalysisView`. `.muscle` points its workout row at the routine
        // (no observations/nextSteps) variant instead of the notable-run one,
        // so both fixture shapes stay reachable through the app, not just
        // through unit tests.
        if profile.established {
            // Endurance: the late hard run (analysis "fixture-workout-analysis",
            // 8:48-9:40 PM yesterday — the run the sleep analysis blames).
            // Everyone else: an easy morning run (routine analysis).
            let isLateRun = scenario == .endurance
            let workoutAnalysisId = isLateRun ? "fixture-workout-analysis" : "fixture-workout-analysis-routine"
            // `.muscle` is a lifter: easy cardio is an incline walk, not the
            // same "Easy 6k" run `.weightLoss` logs.
            let isWalk = scenario == .muscle
            let workoutTitle = isLateRun ? "10km tempo run" : (isWalk ? "Incline walk 20 min" : "Easy 6k")
            let workoutKm = isLateRun ? 10.2 : (isWalk ? 1.6 : 6.1)
            // Matches the corresponding analysis fixture's own `startTime`
            // (routineRunAnalysis / notableRunAnalysis below).
            let workoutTimestamp = isLateRun
                ? isoAt(daysAgo: 1, hour: 20, minute: 48)
                : isoAt(daysAgo: 0, hour: 6, minute: 52)
            items.append([
                "id": "fixture-log-workout",
                "type": "workout_completed",
                "timestamp": workoutTimestamp,
                "hasExactTime": true,
                "dayKey": NSNull(),
                "title": workoutTitle,
                "subtitle": isLateRun ? "Completed last night" : "Completed this morning",
                "imageThumb": NSNull(),
                "kcal": NSNull(),
                "km": isWalk ? NSNull() : workoutKm as Any,
                "sleepMs": NSNull(),
                "analysisId": workoutAnalysisId,
            ])
            let story = sleepStory(profile, scenario: scenario)
            items.append([
                "id": "fixture-log-sleep",
                "type": "sleep_session",
                // Matches the sleep analysis' own `timing.wakeTime`.
                "timestamp": isoFormatter.string(from: story.wake),
                "hasExactTime": true,
                "dayKey": NSNull(),
                "title": "Sleep",
                "subtitle": "\(hoursMinutes(story.minutes)) last night",
                "imageThumb": NSNull(),
                "kcal": NSNull(),
                "km": NSNull(),
                "sleepMs": story.minutes * 60 * 1000,
                "analysisId": "fixture-sleep-analysis",
            ])
        }

        let dayIntake: [String: Any] = [
            "kcal": profile.consumedKcal, "protein": profile.protein,
            "carbs": profile.carbs, "fat": profile.fat,
            "source": profile.consumedKcal > 0 ? "logged" : "none",
            "sourceName": NSNull(),
        ]
        return [
            "items": items,
            "dietByDay": [dayString(0): dayIntake],
        ]
    }

    // MARK: - GET /api/workout-analyses/{id} & /api/sleep-analyses/{id} → AnalysisResponse
    //
    // Mirrors `AnalysisResponse`/`AnalysisContext` in
    // Sources/Core/ProactiveNotifications.swift exactly (analysis-v2-contract.md
    // §1/§2) — every `context` sub-object here is realistic, mutually
    // consistent data matching the X1 (notable run)/X3 (routine run)/Y1
    // (rough night) mockups, not placeholder numbers.

    private static func workoutAnalysisFixture(id: String, profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any]? {
        switch id {
        case "fixture-workout-analysis": return notableRunAnalysis(profile: profile, scenario: scenario)
        case "fixture-workout-analysis-routine": return routineRunAnalysis(profile: profile, scenario: scenario)
        default: return nil
        }
    }

    private static func sleepAnalysisFixture(id: String, profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any]? {
        switch id {
        case "fixture-sleep-analysis": return sleepAnalysis(profile: profile, scenario: scenario)
        default: return nil
        }
    }

    /// X1 mockup: "Your fastest 10k since June" — a full `context`, every
    /// section populated. `.endurance` additionally gets a two-session
    /// `context.devices` (phase 2 "both devices" contract, PR C item 5,
    /// mockups Z4/Z5) — every other scenario stays single-device so their
    /// existing `workoutAnalysis` screenshots are unaffected.
    private static func notableRunAnalysis(profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any] {
        let metrics: [String: Any] = [
            "type": "Running", "durationMin": 52.23, "kcal": 612.0,
            "distanceM": 10_200.0, "avgHr": 158.0, "maxHr": 176.0,
            "paceMinPerKm": 5.1167, "elevationGainM": 42.0,
            // 52 min long, so it ends at the sleep analysis'
            // `beforeBed.lastWorkoutEndedAt` (9:40 PM yesterday); the Logs run
            // row uses the same start.
            "startTime": isoAt(daysAgo: 1, hour: 20, minute: 48),
        ]
        var context: [String: Any] = [
            "usual": ["sessions": 8, "distanceM": 8_800.0, "durationMin": 44.0, "paceMinPerKm": 5.3167, "avgHr": 148.0],
            "paceHistory": ["previous": [5.35, 5.45, 5.40, 5.50, 5.30, 5.55, 5.42], "rank": 1],
            "effort": ["restingHr": normalBase("resting_hr", profile, scenario).rounded(), "maxHr": 188.0, "avgPct": 0.78, "zone": "hard"],
            // The run was LAST NIGHT, so "going in" is the night before it —
            // well rested, which is the point of the story (the short night
            // is the one AFTER the run: see `sleepAnalysis`).
            "goingIn": [
                "sleepMinutes": 490.0,
                "hrv": ["value": 64.0, "unit": "ms", "vsNormal": "above", "source": "apple"],
                "daysSinceLastSameType": 3,
                // The previous hard session (any type) was the same tempo run.
                "daysSinceLastHard": 3,
            ],
            // The morning after the run is THIS morning: the same HRV / resting
            // HR the Today tiles show.
            "nextMorning": [
                "hrv": ["value": profile.hrv, "unit": "ms", "vsNormal": vsNormal("hrv_sdnn", scenario), "source": "apple"],
                "restingHr": ["value": profile.restingHR, "unit": "bpm", "vsNormal": vsNormal("resting_hr", scenario), "source": "apple"],
            ],
        ]
        if scenario == .endurance {
            context["devices"] = workoutDevicesContextFixture()
        }
        let result: [String: Any] = [
            "headline": "Your fastest 10k since June",
            "shortInsight": "You held a hard effort the whole way and didn't fade at the end.",
            "narrative": "This is the run your training has been building toward. The long, easy weeks are paying off — you went faster without your heart rate climbing at the end.",
            "observations": ["You were well rested going in, and it showed: no fade in the last third."],
            // The run was last night, so the easy day is tomorrow — named from
            // the real calendar, never a hard-coded weekday.
            "nextSteps": ["Easy 30 minutes on \(weekdayName(daysAgo: -1)). Keep it conversational — this was a big one."],
        ]
        return [
            "id": "fixture-workout-analysis", "date": dayString(0),
            "result": result, "metrics": metrics, "createdAt": isoNow, "context": context,
        ]
    }

    /// `context.devices` for `.endurance`'s workout analysis
    /// (`WorkoutDevicesContext` — `lib/analysisContext.ts`): Apple Watch
    /// primary (matches `notableRunAnalysis`'s own top-level `metrics`, so
    /// the Apple Watch tab and the un-switched stats row agree), WHOOP
    /// secondary with its own strain/zones and no `kcal` ("not counted").
    private static func workoutDevicesContextFixture() -> [String: Any] {
        let appleSession: [String: Any] = [
            "source": "apple",
            "durationMin": 52.23, "distanceM": 10_200.0, "avgHr": 158.0, "maxHr": 176.0, "kcal": 612.0,
            "zonesSec": [149.0, 209.0, 2448.0, 298.0, 30.0], "zoneBasis": "reserve",
            "hrSeries": enduranceHrSeries(),
            "running": ["cadenceSpm": 172.0, "groundContactMs": 238.0, "powerW": 268.0, "strideM": 1.14],
        ]
        let whoopSession: [String: Any] = [
            "source": "whoop",
            "durationMin": 52.0, "avgHr": 156.0, "strain": 14.8,
            "zonesSec": [242.0, 490.0, 1060.0, 1152.0, 190.0], "zoneBasis": "maxHr",
        ]
        return ["primary": "apple", "sessions": [appleSession, whoopSession]]
    }

    /// ~100-point resampled heart-rate series for the endurance both-devices
    /// fixture — mirrors the shape of the design mockup's `hr_series()`
    /// generator (a warm-up ramp, a steady middle with small drift, a
    /// finishing kick), but with a deterministic xorshift RNG rather than
    /// Swift's seedable-but-not-cross-platform-stable `Random(seed:)`, so
    /// this fixture — and its screenshot — never varies run to run.
    private static func enduranceHrSeries() -> [Double] {
        var series: [Double] = []
        var drift = 0.0
        var seed: UInt64 = 7
        func nextUnit() -> Double {
            seed ^= seed << 13
            seed ^= seed >> 7
            seed ^= seed << 17
            return Double(seed % 2000) / 1000.0 - 1 // -1...1
        }
        let count = 104
        for i in 0..<count {
            let t = Double(i) / Double(count - 1) * 52.0
            drift = 0.7 * drift + nextUnit() * 1.6
            let warmup: Double = 112 + 44 * (1 - exp(-t / 3.5))
            let steady: Double = 157 + drift + (t - 10) * 0.05
            var v: Double = t < 10 ? warmup : steady
            if t > 47.5 {
                let kick: Double = 163 + (t - 47.5) * 2.9 + drift * 0.3
                v = kick
            }
            series.append(min(v, 176))
        }
        return series
    }

    /// X3 mockup: "An easy run, right on your normal" — a routine session
    /// with no observations/nextSteps and an empty narrative, so
    /// `AnalysisView` hides the Coach's-take and Next-step cards entirely,
    /// matching the mockup's absence of both.
    private static func routineRunAnalysis(profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any] {
        if scenario == .muscle { return routineWalkAnalysis(profile: profile, scenario: scenario) }
        // `avgHr` feeds BOTH `metrics` (the "avg 131 · max 142 bpm" label) and
        // `effort.avgPct` (derived exactly as AnalysisView places the bar's
        // tick), so the two can never disagree.
        let avgHr = 131.0
        let restingHr = normalBase("resting_hr", profile, scenario).rounded()
        let effort: [String: Any] = [
            "restingHr": restingHr, "maxHr": 188.0, "zone": "easy",
            "avgPct": AnalysisLogic.heartRateRangeFraction(avgHr, restingHr: restingHr, maxHr: 188.0),
        ]
        let metrics: [String: Any] = [
            "type": "Running", "durationMin": 35.67, "kcal": 340.0,
            "distanceM": 6_100.0, "avgHr": avgHr, "maxHr": 142.0,
            "paceMinPerKm": 5.85, "elevationGainM": 12.0,
            "startTime": isoAt(daysAgo: 0, hour: 6, minute: 52),
        ]
        let context: [String: Any] = [
            "usual": ["sessions": 8, "distanceM": 6_050.0, "durationMin": 35.0, "paceMinPerKm": 5.83, "avgHr": 129.0],
            "paceHistory": ["previous": [5.60, 5.95, 5.70, 6.05, 5.80, 5.90, 5.65], "rank": 5],
            "effort": effort,
            // This morning's run: "going in" = last night's sleep + today's HRV.
            "goingIn": [
                "sleepMinutes": profile.sleepMinutes,
                "hrv": ["value": profile.hrv, "unit": "ms", "vsNormal": vsNormal("hrv_sdnn", scenario), "source": "apple"],
                "daysSinceLastSameType": 2,
                // The last HARD session (any type) came before that easy run.
                "daysSinceLastHard": 4,
            ],
        ]
        let result: [String: Any] = [
            "headline": "An easy run, right on your normal",
            "shortInsight": "Nothing to change — this is what easy days should look like.",
            "narrative": "",
            "observations": [String](),
            "nextSteps": [String](),
        ]
        return [
            "id": "fixture-workout-analysis-routine", "date": dayString(0),
            "result": result, "metrics": metrics, "createdAt": isoNow, "context": context,
        ]
    }

    /// `.muscle`'s routine cardio: the same routine-session shape as
    /// `routineRunAnalysis` (no observations / nextSteps, empty narrative) but
    /// a 20-minute incline walk, so the lifter persona doesn't share
    /// `.weightLoss`'s "Easy 6k". Deliberately no distance / pace /
    /// `paceHistory`: those drive run-only copy ("last N runs", min/km).
    private static func routineWalkAnalysis(profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any] {
        // `avgHr` feeds BOTH `metrics` (the "avg 108 · max 121 bpm" label and the
        // max-HR ring) and `effort.avgPct`, derived exactly as AnalysisView places
        // the bar's "your average" tick: (108 − rest 52) / (188 − 52) ≈ 0.41,
        // left of the max ring at (121 − 52) / 136 ≈ 0.51 — never a hand-typed
        // fraction that drifts past the max marker.
        let avgHr = 108.0
        let restingHr = normalBase("resting_hr", profile, scenario).rounded()
        let effort: [String: Any] = [
            "restingHr": restingHr, "maxHr": 188.0, "zone": "easy",
            "avgPct": AnalysisLogic.heartRateRangeFraction(avgHr, restingHr: restingHr, maxHr: 188.0),
        ]
        let metrics: [String: Any] = [
            "type": "Walking", "durationMin": 20.0, "kcal": 110.0,
            "avgHr": avgHr, "maxHr": 121.0, "elevationGainM": 35.0,
            "startTime": isoAt(daysAgo: 0, hour: 6, minute: 52),
        ]
        let context: [String: Any] = [
            "usual": ["sessions": 8, "durationMin": 20.0, "avgHr": 107.0],
            "effort": effort,
            "goingIn": [
                "sleepMinutes": profile.sleepMinutes,
                "hrv": ["value": profile.hrv, "unit": "ms", "vsNormal": vsNormal("hrv_sdnn", scenario), "source": "apple"],
                "daysSinceLastSameType": 2,
                // The last hard session was the lift (the `lastLift` squat, 2 days ago) — not a walk.
                "daysSinceLastHard": 2,
            ],
        ]
        let result: [String: Any] = [
            "headline": "An easy walk, right on your normal",
            "shortInsight": "Nothing to change — easy cardio like this helps recovery between lifts.",
            "narrative": "",
            "observations": [String](),
            "nextSteps": [String](),
        ]
        return [
            "id": "fixture-workout-analysis-routine", "date": dayString(0),
            "result": result, "metrics": metrics, "createdAt": isoNow, "context": context,
        ]
    }

    /// Y1 mockup family — last night's sleep, entirely derived from
    /// `profile.sleepMinutes` (see `sleepStory`): `.endurance` is the rough
    /// night after the late hard run (two-session `context.devices`, phase 2
    /// "both devices" contract, mockup S4, whose asleep minutes differ by 22
    /// — enough to trigger the "devices disagree" card, ≥10 min,
    /// `AnalysisLogic.sleepDevicesDisagree`); `.weightLoss` is a slightly
    /// short night; everything else is a solid night on the user's normal.
    private static func sleepAnalysis(profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any] {
        let story = sleepStory(profile, scenario: scenario)
        let usualMinutes = (normalBase("sleep_minutes", profile, scenario) * 60).rounded()
        let usualDeep = (usualMinutes * 0.15).rounded()
        let usualRem = (usualMinutes * 0.21).rounded()
        let shortfall = usualMinutes - story.minutes

        let metrics: [String: Any] = [
            "minutes": story.minutes,
            "stages": ["core": story.core, "deep": story.deep, "rem": story.rem, "awake": story.awake],
        ]
        let week: [[String: Any]] = (0...6).reversed().map { offset -> [String: Any] in
            [
                "date": dayString(offset),
                "minutes": (seriesPoint(key: "sleep_minutes", offset: offset, profile: profile, scenario: scenario) * 60).rounded(),
            ]
        }
        var beforeBed: [String: Any] = ["lastMealAt": isoAt(daysAgo: 1, hour: 19, minute: 15)]
        if scenario == .endurance {
            beforeBed["lastWorkoutEndedAt"] = isoAt(daysAgo: 1, hour: 21, minute: 40)
            beforeBed["lastMealAt"] = isoAt(daysAgo: 1, hour: 22, minute: 15)
        }
        var context: [String: Any] = [
            "goalMinutes": 480,
            "usual": [
                "nights": 14, "minutes": usualMinutes,
                "stages": ["core": usualMinutes - usualDeep - usualRem - 14, "deep": usualDeep, "rem": usualRem, "awake": 14.0],
            ],
            "week": week,
            "timing": ["bedTime": isoFormatter.string(from: story.bed), "wakeTime": isoFormatter.string(from: story.wake)],
            "beforeBed": beforeBed,
            "thisMorning": [
                "hrv": ["value": profile.hrv, "unit": "ms", "vsNormal": vsNormal("hrv_sdnn", scenario), "source": "apple"],
                "restingHr": ["value": profile.restingHR, "unit": "bpm", "vsNormal": vsNormal("resting_hr", scenario), "source": "apple"],
            ],
        ]
        if scenario == .endurance {
            context["devices"] = sleepDevicesContextFixture(profile: profile, story: story)
        }

        let result: [String: Any]
        switch scenario {
        case .endurance:
            result = [
                "headline": "Short night, light on deep sleep",
                "shortInsight": "You got about \(humanDuration(shortfall)) less than usual, and woke up more.",
                "narrative": "One short night won't undo anything. The late hard run is the part worth moving — it's the second time this month a late session came before a night like this.",
                "observations": [String](),
                "nextSteps": ["Swap today's intervals for an easy 30 min. Go hard again tomorrow if your HRV is back in range."],
            ]
        case .weightLoss:
            result = [
                "headline": "A little short of your normal",
                "shortInsight": "About \(humanDuration(shortfall)) less than usual — not a big dent.",
                "narrative": "One slightly short night is fine, and your HRV is still above your normal, so you're recovering well. Lights-out a bit earlier tonight puts you back on pattern.",
                "observations": [String](),
                "nextSteps": ["Aim for lights-out around 10:30 tonight."],
            ]
        default:
            result = [
                "headline": "A solid night, right on your normal",
                "shortInsight": "About what you usually get — a good base for today.",
                "narrative": "",
                "observations": [String](),
                "nextSteps": [String](),
            ]
        }
        return [
            "id": "fixture-sleep-analysis", "date": dayString(0),
            "result": result, "metrics": metrics, "createdAt": isoNow, "context": context,
        ]
    }

    /// `context.devices` for `.endurance`'s sleep analysis
    /// (`SleepDevicesContext` — `lib/analysisContext.ts`): WHOOP primary
    /// (matches `FixtureData.devices`'s "sleep": "whoop" for `.endurance`,
    /// and `sleepAnalysis`'s own top-level `metrics.minutes`), Apple Watch
    /// secondary counting 22 more minutes asleep.
    private static func sleepDevicesContextFixture(profile: Profile, story: SleepStory) -> [String: Any] {
        let whoopSession: [String: Any] = [
            "source": "whoop", "minutes": story.minutes,
            "stages": ["core": story.core, "deep": story.deep, "rem": story.rem, "awake": story.awake],
        ]
        let appleSession: [String: Any] = [
            "source": "apple", "minutes": story.minutes + 22,
            "stages": ["core": story.core + 8, "deep": story.deep + 6, "rem": story.rem + 8, "awake": 14.0],
        ]
        return ["primary": "whoop", "sessions": [whoopSession, appleSession]]
    }

    // MARK: - GET /api/diet-goal → DietGoalResponse

    private static func dietGoal(_ profile: Profile) -> [String: Any] {
        let current: [String: Any] = [
            "mode": "auto", "goal": profile.goal,
            "targetKcal": profile.targetKcal, "protein": profile.proteinTarget,
            "carbs": profile.carbsTarget, "fat": profile.fatTarget,
            "tdee": profile.targetKcal + 300,
            "consumedSource": profile.consumedKcal > 0 ? "logged" : "none",
            "consumedSourceName": NSNull(),
        ]
        return ["current": current, "auto": current, "goals": ["weight_loss", "muscle", "endurance", "general"]]
    }

    // MARK: - GET /api/meals/log → MealLogsResponse

    private static func mealLogs(_ profile: Profile) -> [String: Any] {
        let items = profile.meals.enumerated().map { index, meal -> [String: Any] in
            [
                "id": "fixture-meal-\(index)",
                "name": meal.name,
                "kcal": meal.kcal, "protein": meal.p, "carbs": meal.c, "fat": meal.f,
                "slot": meal.slot,
                "loggedAt": isoNow,
            ]
        }
        return ["items": items]
    }

    // MARK: - GET /api/profile → ProfileResponse

    private static func profileResponse(_ profile: Profile) -> [String: Any] {
        let stats: [String: Any] = [
            "loggedDays": profile.established ? 24 : dataDays(profile),
            "mealsLogged": profile.meals.count * 6,
            "avgHrv": profile.established ? profile.hrv : NSNull(),
            "workouts": profile.established ? 5 : 0,
        ]
        let details: [String: Any] = [
            "age": 29, "biologicalSex": "female",
            "heightCm": 170.0, "weightKg": profile.weightKg,
        ]
        return [
            "name": profile.name,
            "integrations": [
                ["name": "Apple Health", "status": "connected"],
                ["name": "WHOOP", "status": "not_connected"],
            ],
            "stats": stats,
            "profile": details,
            "createdAt": isoDaysAgo(120),
            "sleepGoalMinutes": 480,
            "lightsOutMinutes": 1350,
            "calibration": calibration(profile),
            "unitSystem": "metric",
            // Goal targets (null for newUser / general; endurance carries a
            // weekly distance target only).
            "targetWeightKg": profile.goal == "weight_loss" ? 76.0 : NSNull(),
            "targetDate": profile.goal == "weight_loss" ? dayString(-70) : NSNull(),
            "weeklySessionsTarget": profile.goal == "muscle" ? 4 : NSNull(),
            "weeklyDistanceKmTarget": profile.goal == "endurance" ? enduranceWeeklyDistanceTargetKm : NSNull(),
            "raceDate": profile.goal == "endurance" ? dayString(-enduranceRaceDaysOut) : NSNull(),
            "raceDistanceKm": profile.goal == "endurance" ? enduranceRaceDistanceKm : NSNull(),
            "goalStartWeightKg": profile.goal == "weight_loss" ? 82.0 : NSNull(),
            "goalStartedAt": profile.goal == "weight_loss" ? isoDaysAgo(21) : NSNull(),
        ]
    }

    // MARK: - GET /api/nutrition/recents → [RecentFood]

    private static func recents(_ profile: Profile) -> [[String: Any]] {
        profile.meals.map { meal -> [String: Any] in
            [
                "name": meal.name, "kcal": meal.kcal, "c": meal.c, "p": meal.p, "f": meal.f,
                "slot": meal.slot, "lastLoggedAt": isoNow, "imageThumb": NSNull(),
            ]
        }
    }

    // MARK: - GET /api/weight-log → WeightLogResponse (Today weight_loss hero, §5.3)

    /// `established` scenarios get >= 10 weigh-ins spread over the last ~21
    /// days (well past the server's >= 3 entries / >= 5 days gate — see
    /// `lib/weightTrend.ts`), trending from `profile.weightKg` at the given
    /// weekly rate; `newUser` gets none at all (`established: false`, no
    /// fabricated trend — the hero must show the honest placeholder).
    private static func weightLog(_ profile: Profile) -> [String: Any] {
        guard profile.established else {
            return ["entries": [[String: Any]](), "trend": ["days": [[String: Any]](), "delta7dKgPerWeek": NSNull(), "delta30dKgPerWeek": NSNull(), "established": false]]
        }

        let offsets = stride(from: 20, through: 0, by: -2).map { $0 } // 11 points, ~3 weeks
        let dailyRateKg = profile.weightTrendPerWeekKg / 7

        func weightAt(daysAgo: Int) -> Double {
            // `daysAgo` days in the past sat `dailyRateKg * daysAgo` above
            // today's weight for a losing (negative) rate — below instead
            // for a gaining (positive) rate, e.g. the muscle scenario.
            profile.weightKg - dailyRateKg * Double(daysAgo)
        }

        let entries = offsets.map { daysAgo -> [String: Any] in
            [
                "date": dayString(daysAgo),
                "weight": round(weightAt(daysAgo: daysAgo) * 100) / 100,
                "unit": "kg",
                "source": "manual",
            ]
        }

        // Daily trend series for the sparkline — same linear model as the
        // entries above (a fixture-only simplification of the real EWMA;
        // still monotonic and smooth, which is all the sparkline needs).
        let trendDays = (0...20).reversed().map { daysAgo -> [String: Any] in
            let value = round(weightAt(daysAgo: daysAgo) * 100) / 100
            return ["day": dayString(daysAgo), "rawKg": value, "trendKg": value]
        }

        let trend: [String: Any] = [
            "days": trendDays,
            "delta7dKgPerWeek": profile.weightTrendPerWeekKg,
            "delta30dKgPerWeek": profile.weightTrendPerWeekKg,
            "established": true,
        ]
        return ["entries": entries, "trend": trend]
    }

    // MARK: - Endurance "this week" (Monday-start local week, like the server)

    /// Endurance weekly distance target (users.weekly_distance_km_target).
    private static let enduranceWeeklyDistanceTargetKm = 30.0
    /// Endurance fixture race: a half marathon 12 weeks out (relative to now).
    private static let enduranceRaceDaysOut = 84
    private static let enduranceRaceDistanceKm = 21.1

    /// Weekly running km, oldest -> newest (the newest is the last completed
    /// week — the weekly review's "24.5 km", +12% on the 21.9 before it).
    static let enduranceWeeklyKm: [Double] = [20.1, 23.7, 21.9, 24.5]
    /// Mean of the last 2 / the 2 before / all 4 of `enduranceWeeklyKm`
    /// (23.2, 21.9, 22.55 → 22.6) and the resulting volume change (+6%) —
    /// the single set of numbers behind the goal card, Today line and coach opener.
    static let enduranceLast2WeeksAvgKm = 23.2
    static let endurancePrior2WeeksAvgKm = 21.9
    static let enduranceFourWeekAvgKm = 22.6
    static let enduranceVolumeChangePct = 6
    /// Long runs (running only): the latest one, the 28-day peak, and the
    /// half-marathon peak target (lib/goalProgress.ts `longRunTargetKm`).
    static let enduranceLastLongRunKm = 14.0
    static let endurancePeakLongRunKm = 16.0
    static let enduranceLongRunTargetKm = 18.0

    /// This week's safe step toward the weekly goal (km): ~10% over LAST week's
    /// 24.5 km, never past the goal — the single rule in
    /// lib/enduranceProgression.ts `weekStepTarget` (27 km), the same "Build to
    /// ~27 km" the weekly review's Next week says for this very week.
    static let enduranceStepTargetKm: Double = {
        let last = enduranceWeeklyKm.last ?? 0
        return min(enduranceWeeklyDistanceTargetKm, max((last * 1.1).rounded(), last.rounded(.down) + 1))
    }()

    /// Earlier-in-the-week sessions (index 0 = Monday) the endurance persona has
    /// logged by today (km; 0 = a non-running session, e.g. strength); today's
    /// tempo run (`workoutKm`, 10.2 km) is added on top. Deliberately light: the
    /// review plans a 16 km long run later this week, and the week is only
    /// meant to reach the ~27 km step (10.2 done + 16 long run ≈ 27), never the
    /// 39 km a second and third run would add. Totals never equal LAST week's
    /// review (3 sessions, 24.5 km): any weekday is 10.2 km, 2 sessions (Monday: 1).
    private static let enduranceEarlierRunKm: [Int: Double] = [0: 0.0]

    struct EnduranceWeek {
        /// "YYYY-MM-DD" local Monday.
        let start: String
        /// Mon..Sun.
        let days: [(date: String, completed: Bool)]
        let sessions: Int
        let km: Double
    }

    /// The current local week (Monday-start, device time zone — the fixture's
    /// "user tz") of endurance training up to and including today: the logged
    /// earlier runs plus today's tempo run. Future days are never completed.
    static func enduranceWeek(now: Date = Date()) -> EnduranceWeek {
        var cal = Calendar(identifier: .gregorian)
        cal.firstWeekday = 2
        cal.timeZone = .current
        let today = cal.startOfDay(for: now)
        let monday = cal.dateInterval(of: .weekOfYear, for: today)?.start ?? today
        let todayIndex = max(0, min(6, cal.dateComponents([.day], from: monday, to: today).day ?? 0))
        let todayKm = profiles[.endurance]?.workoutKm ?? 0

        var days: [(date: String, completed: Bool)] = []
        var km = 0.0
        var sessions = 0
        for i in 0..<7 {
            let date = cal.date(byAdding: .day, value: i, to: monday) ?? monday
            var runKm: Double?
            if i == todayIndex { runKm = todayKm }
            else if i < todayIndex { runKm = enduranceEarlierRunKm[i] }
            if let runKm { km += runKm; sessions += 1 }
            days.append((dayFormatter.string(from: date), runKm != nil))
        }
        return EnduranceWeek(
            start: dayFormatter.string(from: monday), days: days, sessions: sessions,
            km: (km * 10).rounded() / 10
        )
    }

    /// "10.2", "30" — one decimal, trailing ".0" dropped (the server's
    /// "10.2 of ~27 km running this week · goal 30 km" wording).
    private static func trimmedKm(_ km: Double) -> String {
        let rounded = (km * 10).rounded() / 10
        return rounded.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(rounded)) : String(format: "%.1f", rounded)
    }

    /// GET /api/training/summary for `.endurance`: the real Monday-start week,
    /// with no plan data (`plannedSessions: null`) and no server-side target.
    private static func enduranceTrainingSummary(_ profile: Profile) -> [String: Any] {
        let week = enduranceWeek()
        return [
            "week": [
                "start": week.start,
                "plannedSessions": NSNull(),
                "completedSessions": week.sessions,
                "days": week.days.map { ["date": $0.date, "planned": false, "completed": $0.completed] as [String: Any] },
            ] as [String: Any],
            "volume": ["unit": "km", "done": week.km, "target": NSNull()] as [String: Any],
            "lastLift": NSNull(),
        ]
    }

    // MARK: - GET /api/training/summary → TrainingSummaryResponse (#202)

    /// `nil` (→ 404) when the scenario has no training data at all — mirrors
    /// a real backend account with no logged sets, HealthKit workouts, or
    /// plan 'move' items this week; every field the muscle/endurance heroes
    /// read must then stay hidden rather than fabricated (P4).
    private static func trainingSummary(_ profile: Profile) -> [String: Any]? {
        if profile.goal == "endurance" { return enduranceTrainingSummary(profile) }
        guard profile.lastLift != nil
                || profile.weeklyVolumeKm != nil
                || profile.completedSessionsThisWeek != nil else {
            return nil
        }

        let planned = profile.plannedSessionsThisWeek ?? 0
        let completed = profile.completedSessionsThisWeek ?? 0
        // 7 days, oldest first (Mon..Sun-shaped) — the first `planned` days
        // are marked planned, the first `completed` of those (or, when
        // there's no plan data at all, just the first `completed` days
        // overall) are marked completed. A fixture-only simplification —
        // real data need not be this front-loaded — but it exercises both
        // the dots (muscle) and no-dots fallback (endurance) paths.
        let days = (0..<7).map { i -> [String: Any] in
            let daysAgo = 6 - i
            return [
                "date": dayString(daysAgo),
                "planned": i < planned,
                "completed": i < completed,
            ]
        }

        let week: [String: Any] = [
            "start": dayString(6),
            "plannedSessions": nullable(profile.plannedSessionsThisWeek),
            "completedSessions": completed,
            "days": days,
        ]

        let volume: [String: Any] = [
            "unit": "km",
            "done": nullable(profile.weeklyVolumeKm),
            "target": NSNull(), // always null today — see lib/trainingSummary.ts
        ]

        let lastLift: Any
        if let lift = profile.lastLift {
            lastLift = [
                "exercise": lift.exercise,
                "date": lift.date,
                "sets": lift.sets,
                "reps": lift.reps,
                "weightKg": nullable(lift.weightKg),
            ]
        } else {
            lastLift = NSNull()
        }

        return ["week": week, "volume": volume, "lastLift": lastLift]
    }

    // MARK: - Strength tracking (GET /api/workouts/summary + /last, POST /sets)

    /// GET /api/workouts/summary → `WorkoutSummaryResponse`. Only `.muscle`
    /// carries data — 8 weeks of squat/bench/deadlift (+ a recent overhead
    /// press) with steady progression everywhere except the deadlift, which
    /// is stalled at 175 kg for the last 4 weeks (and skipped one week, so its
    /// sparkline shows a gap). Every other scenario returns the real
    /// backend's empty shape (`exercises: {}`) so the Strength card stays
    /// hidden. Week keys come from `TrendsStrengthLogic.weekKeys` so the
    /// fixture always lines up with the card's own current-week math.
    private static func workoutSummary(scenario: FixtureMode.Scenario) -> [String: Any] {
        guard scenario == .muscle else {
            return ["days": 84, "exercises": [String: Any]()]
        }

        let weeks = TrendsStrengthLogic.weekKeys(endingAt: Date(), count: 8)

        /// One lift's weekly stats from per-week top-set loads (kg, `nil` =
        /// not trained that week) and working-set counts, all at 5 reps.
        func series(loads: [Double?], sets: [Int]) -> [[String: Any]] {
            let reps = 5
            var out: [[String: Any]] = []
            for (index, load) in loads.enumerated() {
                guard let load else { continue }
                let e1rm = (load * (1 + Double(reps) / 30) * 100).rounded() / 100
                out.append([
                    "weekStart": weeks[index],
                    "bestEstimatedOneRepMaxKg": e1rm,
                    "volumeKg": Double(sets[index] * reps) * load,
                    "totalSets": sets[index],
                    "totalReps": sets[index] * reps,
                ])
            }
            return out
        }

        let exercises: [String: Any] = [
            // Squat climbs ~2.5 kg a week (what the logger suggests per
            // session). The shared 4-week rule reads baseline = best of the
            // weeks 4 and 5 back (131.25 kg x 5 -> e1RM 153.1) against now
            // (140 kg x 5 -> 163.3), i.e. 153 -> 163 kg = +10 kg — the numbers
            // the goal card, headline, coach opener and Today line all quote
            // (`squatE1RMFourWeeksAgoKg` / `squatE1RMNowKg`).
            "squat": series(
                loads: [123.75, 126.25, 128.75, 131.25, 133.75, 136.25, 138.75, 140],
                sets: [3, 3, 3, 3, 3, 3, 3, 3]
            ),
            "bench press": series(
                loads: [80, 82.5, 82.5, 85, 87.5, 87.5, 90, 92.5],
                sets: [3, 3, 3, 3, 3, 3, 3, 4]
            ),
            "deadlift": series(
                loads: [160, 165, nil, 175, 175, 175, 175, 175],
                sets: [3, 3, 0, 3, 3, 3, 3, 3]
            ),
            "overhead press": series(
                loads: [nil, nil, nil, nil, nil, nil, 55, 57.5],
                sets: [0, 0, 0, 0, 0, 0, 3, 3]
            ),
        ]
        return ["days": 84, "exercises": exercises]
    }

    /// GET /api/workouts/last → `WorkoutLastSessionResponse`. For `.muscle`:
    /// the most recent session (the Mon Legs session in `workoutRecentSessions`:
    /// squat 60 kg warm-up + 3×5 @ 140 kg, Romanian deadlift, leg press) —
    /// same id and working sets — regardless of which `exercise` is asked
    /// about, matching the real route returning the WHOLE session. Other scenarios: `sets: []`
    /// (never logged), so the logger opens as an empty form.
    private static func workoutLastSession(scenario: FixtureMode.Scenario) -> [String: Any] {
        guard scenario == .muscle else { return ["sets": [[String: Any]]()] }

        let sessionId = "5b1f0c1e-7a54-4c6e-9d57-2f3a6e0c9b11"
        let performedAt = isoDaysAgo(2)
        let localDay = dayString(2)

        func makeSet(_ n: Int, exercise: String, display: String, index: Int, reps: Int, loadKg: Double, warmup: Bool) -> [String: Any] {
            [
                "id": "fixture-set-\(n)",
                "sessionId": sessionId,
                "workoutId": NSNull(),
                "performedAt": performedAt,
                "localDay": localDay,
                "exercise": exercise,
                "exerciseDisplay": display,
                "setIndex": index,
                "reps": reps,
                "loadKg": loadKg,
                "rpe": NSNull(),
                "isWarmup": warmup,
                "source": "manual",
            ]
        }

        // Server order: by exercise name, then set index.
        var sets: [[String: Any]] = []
        var n = 0
        func add(_ exercise: String, _ display: String, index: Int, reps: Int, loadKg: Double, warmup: Bool = false) {
            n += 1
            sets.append(makeSet(n, exercise: exercise, display: display, index: index, reps: reps, loadKg: loadKg, warmup: warmup))
        }
        add("leg press", "Leg press", index: 8, reps: 10, loadKg: 180)
        add("leg press", "Leg press", index: 9, reps: 10, loadKg: 180)
        add("leg press", "Leg press", index: 10, reps: 10, loadKg: 180)
        add("romanian deadlift", "Romanian deadlift", index: 5, reps: 8, loadKg: 100)
        add("romanian deadlift", "Romanian deadlift", index: 6, reps: 8, loadKg: 100)
        add("romanian deadlift", "Romanian deadlift", index: 7, reps: 8, loadKg: 100)
        add("squat", "Squat", index: 1, reps: 5, loadKg: 60, warmup: true)
        add("squat", "Squat", index: 2, reps: 5, loadKg: 140)
        add("squat", "Squat", index: 3, reps: 5, loadKg: 140)
        add("squat", "Squat", index: 4, reps: 5, loadKg: 140)
        return ["sets": sets]
    }

    // MARK: - GET /api/workouts/sessions → WorkoutRecentSessionsResponse

    /// PPL-style history for `.muscle` (newest first: Thu Legs, Tue Pull,
    /// Mon Push, then last week's Legs); empty for every other scenario.
    /// Sessions are anchored to days-ago offsets so the menu stays plausible.
    private static func workoutRecentSessions(scenario: FixtureMode.Scenario) -> [String: Any] {
        guard scenario == .muscle else { return ["sessions": [[String: Any]]()] }

        func ex(_ key: String, _ display: String, reps: Int, loadKg: Double, sets: Int) -> [String: Any] {
            [
                "exercise": key,
                "display": display,
                "sets": sets,
                "topSet": ["reps": reps, "loadKg": loadKg],
                "setDetails": (0..<sets).map { _ in ["reps": reps, "loadKg": loadKg] as [String: Any] },
            ]
        }
        func session(_ id: String, daysAgo: Int, _ exercises: [[String: Any]]) -> [String: Any] {
            [
                "sessionId": id,
                "performedAt": isoDaysAgo(daysAgo),
                "localDay": dayString(daysAgo),
                "exercises": exercises,
            ]
        }
        let sessions: [[String: Any]] = [
            session("5b1f0c1e-7a54-4c6e-9d57-2f3a6e0c9b11", daysAgo: 2, [
                ex("squat", "Squat", reps: 5, loadKg: 140, sets: 3),
                ex("romanian deadlift", "Romanian deadlift", reps: 8, loadKg: 100, sets: 3),
                ex("leg press", "Leg press", reps: 10, loadKg: 180, sets: 3),
            ]),
            session("6c2a1d2f-8b65-4d7f-8e68-3a4b7f1d0c22", daysAgo: 3, [
                ex("barbell row", "Barbell row", reps: 8, loadKg: 80, sets: 4),
                ex("pull-up", "Pull-up", reps: 8, loadKg: 0, sets: 3),
                ex("curl", "Curl", reps: 12, loadKg: 20, sets: 3),
            ]),
            session("7d3b2e3a-9c76-4e8a-9f79-4b5c8a2e1d33", daysAgo: 4, [
                ex("bench press", "Bench press", reps: 5, loadKg: 92.5, sets: 3),
                ex("overhead press", "Overhead press", reps: 8, loadKg: 57.5, sets: 3),
                ex("triceps pushdown", "Triceps pushdown", reps: 12, loadKg: 35, sets: 3),
            ]),
        ]
        return ["sessions": sessions]
    }

    // MARK: - Muscle squat story (one set of numbers)

    /// Squat est. 1RM, whole kg, 4 weeks ago -> now — the rounded endpoints of
    /// `workoutSummary`'s squat series under the shared 4-week rule
    /// (`TrendsStrengthLogic.change`). Every muscle surface that quotes the
    /// squat change (goal-progress reason + headline, coach opener, the Today
    /// line's "Squat +10 kg / 4 wk", the weekly review) derives from these.
    static let squatE1RMFourWeeksAgoKg = 153
    static let squatE1RMNowKg = 163
    static var squatE1RMChangeKg: Int { squatE1RMNowKg - squatE1RMFourWeeksAgoKg }

    /// The server's goal-progress headline for the muscle persona. Value+unit
    /// tokens are non-breaking (`GoalProgressLogic.nonBreaking`), like the
    /// server's copy, so a narrow line never wraps mid-value.
    static let muscleGoalHeadline = GoalProgressLogic.nonBreaking(
        "Lifts up, sessions behind — Squat +\(squatE1RMChangeKg) kg"
    )

    /// The headline lift's goal-progress reason ("Squat est. 1RM +10 kg vs 4
    /// weeks ago (153 → 163 kg)"), non-breaking like `muscleGoalHeadline`.
    static let squatGoalReason = GoalProgressLogic.nonBreaking(
        "Squat est. 1RM +\(squatE1RMChangeKg) kg vs 4 weeks ago (\(squatE1RMFourWeeksAgoKg) → \(squatE1RMNowKg) kg)"
    )

    // MARK: - GET /api/goal/progress → GoalProgressDTO

    /// "Dec 10" — `daysAhead` days from today, as the server's kg-based
    /// headline would phrase it.
    private static func shortDate(daysAhead: Int) -> String {
        let date = Calendar.current.date(byAdding: .day, value: daysAhead, to: Date()) ?? Date()
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }

    /// Per scenario, consistent with that scenario's weight / lift / training
    /// fixtures: `weight_loss` on track (82.0 kg now, 83.7 start, 76 target,
    /// −0.6 kg/wk, ETA 10 weeks out); `muscle` progressing (squat/bench up,
    /// deadlift stalled — same lifts as `workoutSummary`); `endurance`
    /// building; `new_user` needs a target with zero weigh-ins. (`new_user`
    /// reports `goal: "weight_loss"` here so the card's "set a target weight"
    /// prompt state is exercised — the real server returns that state for a
    /// weight-loss user who hasn't picked a target.) `server_error` never
    /// reaches this (the whole API 500s).
    private static func goalProgress(_ profile: Profile, scenario: FixtureMode.Scenario) -> [String: Any] {
        func reason(_ kind: String, _ text: String, _ tone: String) -> [String: Any] {
            ["kind": kind, "text": text, "tone": tone]
        }
        let none: Any = NSNull()

        switch scenario {
        case .weightLoss:
            let etaDays = 70
            let start = 83.7
            let target = 76.0
            let current = profile.weightKg
            let pct = ((start - current) / (start - target) * 100).rounded()
            return [
                "goal": "weight_loss",
                "target": ["weightKg": target, "date": dayString(-(etaDays + 14)), "weeklySessions": none],
                "current": [
                    "weightKg": current, "startWeightKg": start,
                    "changeKg": ((current - start) * 10).rounded() / 10, "progressPct": pct,
                ],
                "ratePerWeek": ["kg": profile.weightTrendPerWeekKg, "pctBodyweight": -0.73],
                "safeBand": ["minPct": 0.25, "maxPct": 1.0],
                "eta": dayString(-etaDays),
                "onPaceForTargetDate": true,
                "verdict": "on_track",
                "headline": "On track — about 6 kg to go, around \(shortDate(daysAhead: etaDays))",
                "reasons": [
                    reason("rate", "Losing 0.6 kg a week — inside the healthy range", "good"),
                    reason("adherence", "5 of 7 days within your calorie budget", "good"),
                    reason("weekend", "Weekends average +450 kcal over weekdays", "watch"),
                ],
                "dataSufficiency": ["weighIns": 11, "needed": 3, "sessionsLast28d": 0],
            ]
        case .muscle:
            let start = 78.0
            let target = 82.0
            let current = profile.weightKg
            let pct = ((current - start) / (target - start) * 100).rounded()
            return [
                "goal": "muscle",
                "target": ["weightKg": target, "date": none, "weeklySessions": 4],
                "current": [
                    "weightKg": current, "startWeightKg": start,
                    "changeKg": ((current - start) * 10).rounded() / 10, "progressPct": pct,
                ],
                "ratePerWeek": ["kg": profile.weightTrendPerWeekKg, "pctBodyweight": 0.44],
                "safeBand": ["minPct": 0.1, "maxPct": 0.5],
                // (82 - 79) kg at +0.35 kg/wk ≈ 8.6 weeks.
                "eta": dayString(-60),
                "onPaceForTargetDate": none,
                // Mirrors lib/goalProgress.ts: lifts are up (Squat is the shared
                // headline lift, the largest 4-week e1RM gain) but session
                // adherence 9/16 = 56% is under ADHERENCE_BEHIND_PCT (70), so the
                // verdict is `behind`, not `progressing`.
                "verdict": "behind",
                "headline": muscleGoalHeadline,
                "reasons": [
                    // 9 of 16 planned sessions (4/wk x 4) = 56% → amber, leads.
                    reason("adherence", "9 of 16 planned sessions in 4 weeks (56%)", "watch"),
                    // Whole kg, change from the rounded endpoints (liftDisplayChange):
                    // the workoutSummary fixture's e1RMs are 153.1 → 163.3 and 99.2 → 107.9.
                    reason("lift", squatGoalReason, "good"),
                    reason("lift", GoalProgressLogic.nonBreaking("Bench Press est. 1RM +9 kg vs 4 weeks ago (99 → 108 kg)"), "good"),
                ],
                // lib/goalProgress.ts `adherence`: the structured numbers behind the
                // reason above (9 of 4/wk x 4 = 16 planned, 56%). Drives Today's
                // "9 of 16 sessions in 4 wk · 2 more by Sun" (4 a week, 2 done so far).
                "adherence": ["done": 9, "planned": 16, "weeklyTarget": 4, "pct": 56],
                "dataSufficiency": ["weighIns": 11, "needed": 3, "sessionsLast28d": 9],
            ]
        case .endurance:
            // This week (Mon–today) comes from the SAME `enduranceWeek()` as
            // Today's training summary. The 4-week average / volume change
            // derive from `enduranceWeeklyKm` (weeks 20.1, 23.7, 21.9, 24.5 km;
            // the newest two are the weekly review's "24.5 km, +12% vs last
            // week"): last 2 weeks 23.2 km/wk vs the 2 before 21.9 => +6%.
            let week = enduranceWeek()
            let target = enduranceWeeklyDistanceTargetKm
            // ONE target for the week (lib/goalProgress.ts `distanceProgress`): the
            // safe step from last week's 24.5 km — the same "~27 km" the weekly
            // review's Next week names — with the goal beside it. Same copy as the
            // server (U+00A0 between each value and unit).
            let step = enduranceStepTargetKm
            let thisWeekText = step < target
                ? "\(trimmedKm(week.km)) of ~\(trimmedKm(step))\u{00A0}km running this week · goal \(trimmedKm(target))\u{00A0}km"
                : "\(trimmedKm(week.km)) of \(trimmedKm(target))\u{00A0}km running this week"
            // Peak long run is planned 3 weeks before the race (lib/goalProgress.ts).
            let longRunBy = looseMonthPosition(daysAhead: enduranceRaceDaysOut - 21)
            return [
                "goal": "endurance",
                "target": ["weightKg": none, "date": none, "weeklySessions": none, "weeklyDistanceKm": target],
                "distance": [
                    "targetKm": target, "thisWeekKm": week.km, "avg4wKm": enduranceFourWeekAvgKm,
                    "weekStart": week.start, "stepTargetKm": step, "text": thisWeekText,
                ],
                "race": [
                    "date": dayString(-enduranceRaceDaysOut), "distanceKm": enduranceRaceDistanceKm,
                    "label": "Half marathon", "weeksToGo": enduranceRaceDaysOut / 7, "daysToGo": enduranceRaceDaysOut,
                ],
                "longRun": [
                    "lastKm": enduranceLastLongRunKm, "peakKm": endurancePeakLongRunKm,
                    "targetPeakKm": enduranceLongRunTargetKm,
                ],
                "current": ["weightKg": profile.weightKg, "startWeightKg": none, "changeKg": none, "progressPct": none],
                "ratePerWeek": ["kg": none, "pctBodyweight": none],
                "safeBand": none,
                "eta": none,
                "onPaceForTargetDate": none,
                "verdict": "building",
                // ONE volume definition everywhere (goal card, Today line):
                // last 2 weeks vs the 2 before — always labelled.
                "headline": "Building — distance up \(enduranceVolumeChangePct)% (last 2 weeks vs the 2 before)",
                // Server caps reasons at 3 (lib/goalProgress.ts `enduranceReasons`):
                // the race countdown leads, then the volume trend the "Building"
                // verdict rests on (always kept), then the long-run build. This
                // week's distance is the card's stat (`distance.text`), not a
                // reason, so it is not repeated here.
                "reasons": [
                    reason("race", "Half marathon in \(enduranceRaceDaysOut / 7) weeks (\(raceMonthDay(-enduranceRaceDaysOut)))", "neutral"),
                    // The server's own copy, U+00A0 between each value and unit and
                    // around the arrow (lib/goalProgress.ts `volumeReason`).
                    reason(
                        "volume",
                        "Weekly training distance up \(enduranceVolumeChangePct)% (\(trimmedKm(endurancePrior2WeeksAvgKm))\u{00A0}km\u{00A0}\u{2192}\u{00A0}\(trimmedKm(enduranceLast2WeeksAvgKm))\u{00A0}km a week, last 2 weeks vs the 2 before)",
                        "good"
                    ),
                    reason(
                        "long_run",
                        "Long run \(trimmedKm(enduranceLastLongRunKm)) km · build to \(trimmedKm(enduranceLongRunTargetKm)) km by \(longRunBy)",
                        "neutral"
                    ),
                ],
                "dataSufficiency": ["weighIns": 4, "needed": 3, "sessionsLast28d": 12],
            ]
        default:
            return [
                "goal": "weight_loss",
                "target": ["weightKg": none, "date": none, "weeklySessions": none],
                "current": ["weightKg": none, "startWeightKg": none, "changeKg": none, "progressPct": none],
                "ratePerWeek": ["kg": none, "pctBodyweight": none],
                "safeBand": none,
                "eta": none,
                "onPaceForTargetDate": none,
                "verdict": "needs_target",
                "headline": "Set a target weight to track your fat-loss progress",
                "reasons": [Any](),
                "dataSufficiency": ["weighIns": 0, "needed": 3, "sessionsLast28d": 0],
            ]
        }
    }

    // MARK: - GET /api/review/weekly → WeeklyReviewResponse

    /// "YYYY-MM-DD" Monday / Sunday of the last completed local week.
    private static func lastCompletedWeek() -> (start: String, end: String) {
        var cal = Calendar(identifier: .gregorian)
        cal.firstWeekday = 2
        cal.timeZone = .current
        let today = cal.startOfDay(for: Date())
        let thisMonday = cal.dateInterval(of: .weekOfYear, for: today)?.start ?? today
        let start = cal.date(byAdding: .day, value: -7, to: thisMonday) ?? thisMonday
        let end = cal.date(byAdding: .day, value: 6, to: start) ?? start
        return (dayFormatter.string(from: start), dayFormatter.string(from: end))
    }

    /// Unseen review per scenario, consistent with that scenario's
    /// goal-progress / weight / training fixtures: `weight_loss` -0.6 kg,
    /// 5 of 7 days in the 1,850 kcal budget, weekends +450 kcal (same as the
    /// goal-progress reasons); `muscle` 3 of 4 sessions, squat +10 kg vs 4 weeks ago, 5 of 7
    /// protein days (190 g target); `endurance` 24.5 of the 30 km target, +12% (21.9 -> 24.5).
    /// `new_user` (and the unreachable `onboarding`) get the gentle
    /// "not enough data" review. `server_error` never reaches this.
    ///
    /// Each review is coherent the way lib/weeklyReview.ts makes it: ONE gap
    /// (`weekGap`) drives the pill, the Slip and "Next week". A mixed week's
    /// Slip names the gap and "Next week" closes it (never "Repeat this
    /// week"); a good week keeps its usual slip logic. Strings are the server's
    /// own copy, including U+00A0 between a number and its unit.
    private static func weeklyReview(scenario: FixtureMode.Scenario) -> [String: Any] {
        func stat(_ label: String, _ value: String, _ comparison: String?, _ tone: String) -> [String: Any] {
            ["label": label, "value": value, "comparison": nullable(comparison), "tone": tone]
        }
        let week = lastCompletedWeek()
        // U+00A0 NO-BREAK SPACE, as lib/displayText.ts glues "24.5 km" / "+10 kg" / "a → b".
        let nb = "\u{00A0}"
        // `weekRating` rates THIS week from its own stats (lib/weeklyReview.ts
        // assessWeek) — never the 4-week goal `verdict` beside it. `nil`
        // encodes JSON null ("can't rate this week"). `weekGap` is what kept a
        // mixed / tough week from being good (`nil` -> JSON null).
        func review(
            goal: String, verdict: String, weekRating: String?, weekGap: [String: Any]? = nil,
            headline: String, stats: [[String: Any]],
            win: String?, slip: String?, nextWeek: String, sufficient: Bool
        ) -> [String: Any] {
            [
                "id": "00000000-0000-4000-8000-0000000000a1",
                "seenAt": NSNull(),
                "createdAt": isoAt(daysAgo: 0, hour: 0, minute: 0),
                "review": [
                    "weekStart": week.start, "weekEnd": week.end, "goal": goal, "verdict": verdict,
                    "weekRating": nullable(weekRating),
                    "weekGap": nullable(weekGap),
                    "headline": headline, "stats": stats,
                    "win": nullable(win), "slip": nullable(slip), "nextWeek": nextWeek,
                    "dataSufficiency": ["daysWithData": sufficient ? 7 : 1, "statCount": stats.count, "sufficient": sufficient],
                ] as [String: Any],
            ]
        }

        switch scenario {
        case .weightLoss:
            return review(
                // 5 of 7 days in budget (>= 5/7) and weight down at a sane pace: good.
                goal: "weight_loss", verdict: "on_track", weekRating: "good",
                headline: "Down 0.6\(nb)kg, in budget 5 of 7 days",
                stats: [
                    stat("Weekly avg weight", "−0.6\(nb)kg", "vs the week before", "good"),
                    stat("Days in budget", "5/7", nil, "good"),
                    stat("Avg calories", "1,830\(nb)kcal", "−120 vs last week", "neutral"),
                    stat("Workouts", "3", "2 last week", "good"),
                ],
                win: "Your weight trend is down 0.6\(nb)kg.",
                slip: "Weekends ran +450\(nb)kcal over your weekdays.",
                nextWeek: "Plan Saturday's dinner ahead so the weekend lands closer to your weekday average.",
                sufficient: true
            )
        case .muscle:
            return review(
                // 3 of 4 sessions = target - 1 -> mixed (protein 5/7 is not low).
                // Sessions are strength-only for muscle (logged lifts + strength
                // workouts, like the goal card's adherence); a run isn't counted.
                // `verdict` is the same `behind` the goal card beside it says
                // ("Sessions behind", 4-week adherence 9/16); the pill rates
                // this week only. The one gap (3 of 4 sessions) drives the Slip
                // and "Next week" — which closes it instead of repeating the week.
                goal: "muscle", verdict: "behind", weekRating: "mixed",
                weekGap: ["kind": "sessions", "done": 3, "target": 4],
                headline: "3 of 4 sessions, Squat est. 1RM +10\(nb)kg over 4\(nb)wks",
                stats: [
                    stat("Sessions", "3", "target 4 for the week", "neutral"),
                    stat("Squat est. 1RM", "+10\(nb)kg", "vs 4 weeks ago", "good"),
                    stat("Protein days hit", "5/7", nil, "good"),
                    stat("Weekly avg weight", "+0.2\(nb)kg", "vs the week before", "good"),
                ],
                win: "Squat estimated 1RM is up 10\(nb)kg vs 4 weeks ago.",
                slip: "3 of 4 sessions — one short",
                nextWeek: "Book 4 sessions — put the missed one on Saturday.",
                sufficient: true
            )
        case .endurance:
            // Resting HR / sleep come from the endurance profile and the same
            // 7-night series Trends and the coach use — never hand-typed.
            let profile = profiles[.endurance]!
            let rhrGap = gapToNormal("resting_hr", profile, scenario)
            let rhrComparison = "\(rhrGap >= 0 ? "+" : "\u{2212}")\(abs(rhrGap))\(nb)bpm vs your normal"
            let weekSleep = weekSleepStats(profile, scenario)
            return review(
                // 24.5 km of the 30 km weekly target = 82% (>= 60%, < 90%): mixed.
                // The distance shortfall is the gap: the headline carries the
                // target, the Slip names it and "Next week" adds the km.
                goal: "endurance", verdict: "building", weekRating: "mixed",
                weekGap: ["kind": "distance", "doneKm": 24.5, "targetKm": 30],
                headline: "3 sessions, 24.5 of 30\(nb)km, +12% vs last week",
                stats: [
                    // Last week (Mon–Sun), NOT this week — Today's this-week
                    // totals come from `enduranceWeek()` and differ.
                    stat("Sessions", "3", "same as last week", "neutral"),
                    stat("Volume", "24.5\(nb)km", "+12% vs last week", "good"),
                    stat("Resting HR", "\(Int(profile.restingHR.rounded()))\(nb)bpm", rhrComparison, rhrGap > 0 ? "watch" : "good"),
                    stat("Avg sleep", hoursMinutes(weekSleep.avgMinutes), "week avg · goal 8h 0m", weekSleep.avgMinutes < 420 ? "watch" : "good"),
                ],
                win: "Training volume is up 12% on last week (21.9\(nb)km\(nb)→\(nb)24.5\(nb)km).",
                slip: "24.5 of 30\(nb)km target — 5.5\(nb)km short",
                // lib/weeklyReview.ts `distanceNextWeek`: 24.5 km -> ~10% growth
                // (27 km), long run 14 -> 16 km (+2 km, under the 18 km peak
                // target), the rest as easy runs, then the 30 km target.
                nextWeek: "Build to ~27\(nb)km: long run 16\(nb)km, the rest as easy runs; 30\(nb)km the week after.",
                sufficient: true
            )
        default:
            return review(
                goal: "weight_loss", verdict: "insufficient_data", weekRating: nil,
                headline: "Not enough data for a weekly review yet",
                stats: [],
                win: nil, slip: nil,
                nextWeek: "Log meals, weigh-ins or workouts on a few days and your review will fill in next Monday.",
                sufficient: false
            )
        }
    }

    // MARK: - GET /api/devices → DevicesResponse (phase 2 "both devices" contract)

    /// Apple Watch is "connected" (synced recently) for every non-onboarding
    /// scenario. WHOOP is connected only for `endurance` — the one scenario
    /// with a both-devices story — so the Devices settings screen exercises
    /// its "Automatic · <resolved>" picker rows and lets the WHOOP option
    /// appear; every other scenario shows Apple Watch alone, WHOOP reading
    /// "Not connected".
    private static func devices(scenario: FixtureMode.Scenario) -> [String: Any] {
        let whoopConnected = scenario == .endurance
        let deviceRows: [[String: Any]] = [
            ["id": "apple", "connected": true, "lastSyncAt": isoAt(daysAgo: 0, hour: 0, minute: 0)],
            ["id": "whoop", "connected": whoopConnected, "lastSyncAt": whoopConnected ? isoAt(daysAgo: 0, hour: 0, minute: 0) : NSNull()],
        ]
        let primary: [String: Any] = [
            "workouts": "apple",
            "sleep": whoopConnected ? "whoop" : "apple",
            "recovery": whoopConnected ? "whoop" : "apple",
        ]
        let explicit: [String: Any] = ["workouts": NSNull(), "sleep": NSNull(), "recovery": NSNull()]
        return [
            "devices": deviceRows,
            "primary": primary,
            "explicit": explicit,
            "mergedThisMonth": whoopConnected ? 3 : 0,
        ]
    }

    // MARK: - GET /api/memory → MemoryResponse (memory-contract.md §1/§4)

    /// One `self.facts[]` item, with the new §1 fields (`recordedAt`,
    /// `origin`, `group`) — matches `W3-Memory`/`W4-Memory-Actions`'s facts
    /// exactly, minus the old free-text Goal facts (the profile owns the goal now),
    /// so `MemoryLogic.groupedSections` renders Health 3 and Routines &
    /// preferences 3 (plus a persona-specific extra).
    private struct FixtureFact {
        let id: String
        let type: String
        let label: String
        let isConstraint: Bool
        let daysAgo: Int
        let origin: String
        let group: String
    }

    private static let memoryFacts: [FixtureFact] = [
        FixtureFact(id: "fixture-fact-peanut", type: "Allergy", label: "Peanut allergy", isConstraint: true, daysAgo: 400, origin: "told", group: "health"),
        FixtureFact(id: "fixture-fact-knee", type: "Injury", label: "Knee pain since \(shortDate(daysAhead: -10))", isConstraint: false, daysAgo: 6, origin: "told", group: "health"),
        // Same id `coachRestoration`'s `memorySavedExchange` uses for its
        // "Noted: Lactose intolerant" chip — same fact, same fixture id.
        FixtureFact(id: "fixture-fact-lactose", type: "Intolerance", label: "Lactose intolerant", isConstraint: true, daysAgo: 1, origin: "told", group: "health"),
        FixtureFact(id: "fixture-fact-morning-run", type: "Habit", label: "Prefers running in the morning", isConstraint: false, daysAgo: 40, origin: "told", group: "routines"),
        FixtureFact(id: "fixture-fact-night-feeds", type: "Habit", label: "New baby — night feeds about 2 a night", isConstraint: false, daysAgo: 23, origin: "told", group: "routines"),
        FixtureFact(id: "fixture-fact-coffee", type: "Habit", label: "Coffee before 10 am only", isConstraint: false, daysAgo: 15, origin: "confirmed", group: "routines"),
    ]

    private static func memoryFactJSON(_ fact: FixtureFact) -> [String: Any] {
        [
            "id": fact.id, "type": fact.type, "label": fact.label, "isConstraint": fact.isConstraint,
            "recordedAt": dayString(fact.daysAgo), "origin": fact.origin, "group": fact.group,
        ]
    }

    /// Dad (3 facts) and Maya (2 facts) — `W3-Memory`'s People card.
    private static let memoryEntities: [[String: Any]] = [
        ["id": "fixture-entity-dad", "label": "Dad", "kind": "Father", "factCount": 3],
        ["id": "fixture-entity-maya", "label": "Maya", "kind": "Partner", "factCount": 2],
    ]

    /// Persona-specific facts. The goal itself is NOT a memory fact (it lives
    /// on the profile and Memory shows it read-only), so these are only
    /// context that fits each persona without restating or contradicting it.
    private static func personaMemoryFacts(_ goal: String) -> [FixtureFact] {
        switch goal {
        case "endurance":
            return [FixtureFact(id: "fixture-fact-race", type: "Note", label: "Racing a half marathon in the spring", isConstraint: false, daysAgo: 60, origin: "told", group: "other")]
        case "muscle":
            return [FixtureFact(id: "fixture-fact-gym-days", type: "Habit", label: "Lifts Monday, Wednesday, Friday", isConstraint: false, daysAgo: 30, origin: "told", group: "routines")]
        default:
            return []
        }
    }

    private static func memory(_ profile: Profile) -> [String: Any] {
        guard profile.established else {
            return ["self": ["factCount": 0, "facts": [Any]()], "entities": [Any]()]
        }
        let facts = memoryFacts + personaMemoryFacts(profile.goal)
        return [
            "self": ["factCount": facts.count, "facts": facts.map(memoryFactJSON)],
            "entities": memoryEntities,
        ]
    }

    // MARK: - GET /api/pending-facts → PendingFactsResponse

    /// One "Did I get this right?" card (memory-contract.md §1/§4), with a
    /// `reason` — matches `W3-Memory`'s pending card verbatim. Empty for
    /// `new_user`, same as every other established-only fixture list here.
    private static func pendingFacts(_ profile: Profile) -> [[String: Any]] {
        guard profile.established else { return [] }
        return [
            [
                "id": "fixture-pending-6am",
                "proposedNode": ["type": "Habit", "label": "You usually train at 6 am on weekdays"],
                "evidence": "Workouts logged at 6:0x am on 12 of the last 15 weekdays.",
                "salience": 0.82,
                "createdAt": isoDaysAgo(1),
                "reason": "Noticed from your workouts over the last 3 weeks",
            ],
        ]
    }

    // MARK: - PATCH /api/memory/facts/{id} → { ok, fact } (memory-contract.md §2)

    /// The fixture never actually persists a supersede — it just echoes the
    /// requested label back as a "new" node with a fresh id, close enough for
    /// exercising `MemoryViewModel.saveEdit`'s replace-the-row-in-place path
    /// without a real backend.
    private static func editedMemoryFact(id: String, body: Data) -> [String: Any] {
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let label = object?["label"] as? String ?? "Updated fact"
        let fact: [String: Any] = [
            "id": "\(id)-edited", "type": "Habit", "label": label, "isConstraint": false,
            "recordedAt": dayString(0), "origin": "told", "group": "routines",
        ]
        return ["ok": true, "fact": fact]
    }

    // MARK: - GET /api/memory/entities/{id} → EntityDocumentResponse

    private static func entityDocument(id: String) -> [String: Any] {
        let isMaya = id == "fixture-entity-maya"
        let label = isMaya ? "Maya" : "Dad"
        let kind = isMaya ? "Partner" : "Father"
        let facts: [[String: Any]] = isMaya
            ? [
                ["type": "Relationship", "label": "Partner", "evidence": "my partner Maya", "source": "coach", "createdAt": isoDaysAgo(60)],
                ["type": "Allergy", "label": "Shellfish allergy", "evidence": "Maya can't have shellfish", "source": "coach", "createdAt": isoDaysAgo(45)],
              ]
            : [
                ["type": "Condition", "label": "Type 2 diabetes", "evidence": "my dad has type 2 diabetes", "source": "coach", "createdAt": isoDaysAgo(200)],
                ["type": "Medication", "label": "Metformin", "evidence": "he's on metformin", "source": "coach", "createdAt": isoDaysAgo(200)],
                ["type": "FamilyHistory", "label": "Family history of diabetes", "evidence": "runs in the family", "source": "coach", "createdAt": isoDaysAgo(200)],
              ]
        return ["id": id, "label": label, "kind": kind, "isSelf": false, "facts": facts]
    }

    // MARK: - GET /api/notification-preferences → NotificationPreferences

    private static func notificationPreferences() -> [String: Any] {
        [
            "morningBriefEnabled": true, "morningBriefTimeMinutes": 450,
            "workoutNotificationsEnabled": true, "sleepNotificationsEnabled": true,
            "mealsEnabled": true,
            "coachNudgesEnabled": true, "weeklyReviewEnabled": true,
            "mealBreakfastTimeMinutes": 480, "mealLunchTimeMinutes": 765,
            "mealSnackTimeMinutes": 960, "mealDinnerTimeMinutes": 1170,
            "timezone": TimeZone.current.identifier,
        ]
    }
}
#endif
