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
        let hrv: Double
        let restingHR: Double
        let sleepMinutes: Double
        let steps: Double
        let distanceKm: Double
        let workoutTitle: String?
        let workoutKm: Double?
    }

    /// Returning-user opener, shown once a scenario has an established
    /// baseline (`Profile.established == true`) — praise tied to real
    /// history is appropriate there.
    private static let coachOpener =
        "Nice work staying consistent this week — what would you like to dig into?"

    /// New/calibrating-user opener (`Profile.established == false`, i.e. the
    /// `new_user` scenario) — no history to praise yet, so this just invites
    /// the user to say something instead. Mirrors
    /// `CoachViewModel.newUserFallbackOpener`.
    private static let newUserCoachOpener =
        "Hi, I'm Vital, your coach. Tell me your goal, or just say what you ate or how you slept, and I'll take it from there."

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
            name: "Alex Rivera",
            insight: "You're down 1.2kg this week and sleep is holding steady — keep the deficit gentle through the weekend.",
            established: true,
            targetKcal: 1850, consumedKcal: 1240,
            protein: 96, proteinTarget: 150, carbs: 110, carbsTarget: 165, fat: 38, fatTarget: 62,
            plan: [
                FixturePlanItem(title: "Overnight oats with berries", timeMinutes: 420, kind: "meal", subtitle: "Breakfast · 7:00 AM", kcal: 380, why: "High protein start keeps you full past lunch."),
                FixturePlanItem(title: "30-min incline walk", timeMinutes: 660, kind: "move", subtitle: "Move · 11:00 AM", kcal: nil, why: "Low-impact cardio that fits a deficit."),
                FixturePlanItem(title: "Grilled chicken salad", timeMinutes: 750, kind: "meal", subtitle: "Lunch · 12:30 PM", kcal: 420, why: "Lean protein, high volume, low calorie density."),
                FixturePlanItem(title: "Greek yogurt + almonds", timeMinutes: 960, kind: "meal", subtitle: "Snack · 4:00 PM", kcal: 220, why: "Bridges the afternoon without derailing today's budget."),
                FixturePlanItem(title: "Salmon, rice, broccoli", timeMinutes: 1140, kind: "meal", subtitle: "Dinner · 7:00 PM", kcal: 520, why: "Balanced macros to close out the day on target."),
            ],
            meals: [
                FixtureMeal(name: "Overnight oats with berries", kcal: 380, c: 52, p: 18, f: 9, slot: "breakfast"),
                FixtureMeal(name: "Grilled chicken salad", kcal: 420, c: 24, p: 46, f: 14, slot: "lunch"),
                FixtureMeal(name: "Greek yogurt + almonds", kcal: 220, c: 16, p: 14, f: 11, slot: "snacks"),
            ],
            weightKg: 82, weightTrendPerWeekKg: -0.6,
            hrv: 58, restingHR: 57, sleepMinutes: 435, steps: 8600, distanceKm: 6.1,
            workoutTitle: nil, workoutKm: nil
        ),
        .muscle: Profile(
            goal: "muscle",
            name: "Sam Okafor",
            insight: "Protein's on target four days running and yesterday's lift was a PR on squat volume — stay the course.",
            established: true,
            targetKcal: 2900, consumedKcal: 1980,
            protein: 158, proteinTarget: 190, carbs: 210, carbsTarget: 300, fat: 58, fatTarget: 85,
            plan: [
                FixturePlanItem(title: "Egg + oat protein bowl", timeMinutes: 420, kind: "meal", subtitle: "Breakfast · 7:00 AM", kcal: 560, why: "Sets up protein synthesis early."),
                FixturePlanItem(title: "Lower-body strength", timeMinutes: 630, kind: "move", subtitle: "Train · 10:30 AM", kcal: nil, why: "Progressive overload on squat + deadlift."),
                FixturePlanItem(title: "Chicken, rice, avocado", timeMinutes: 780, kind: "meal", subtitle: "Lunch · 1:00 PM", kcal: 680, why: "Refeeds glycogen after this morning's session."),
                FixturePlanItem(title: "Protein shake + banana", timeMinutes: 990, kind: "meal", subtitle: "Snack · 4:30 PM", kcal: 320, why: "Keeps protein intake spread across the day."),
                FixturePlanItem(title: "Steak, sweet potato, greens", timeMinutes: 1170, kind: "meal", subtitle: "Dinner · 7:30 PM", kcal: 720, why: "Closes the surplus needed for this week's gain rate."),
            ],
            meals: [
                FixtureMeal(name: "Egg + oat protein bowl", kcal: 560, c: 58, p: 42, f: 16, slot: "breakfast"),
                FixtureMeal(name: "Chicken, rice, avocado", kcal: 680, c: 74, p: 48, f: 20, slot: "lunch"),
                FixtureMeal(name: "Protein shake + banana", kcal: 320, c: 36, p: 24, f: 4, slot: "snacks"),
            ],
            weightKg: 79, weightTrendPerWeekKg: 0.35,
            hrv: 62, restingHR: 52, sleepMinutes: 450, steps: 7200, distanceKm: 4.8,
            workoutTitle: nil, workoutKm: nil
        ),
        .endurance: Profile(
            goal: "endurance",
            name: "Priya Nandy",
            insight: "This week's long run held goal pace with a lower average HR than last week — aerobic base is building nicely.",
            established: true,
            targetKcal: 2650, consumedKcal: 1510,
            protein: 92, proteinTarget: 130, carbs: 260, carbsTarget: 340, fat: 46, fatTarget: 75,
            plan: [
                FixturePlanItem(title: "Banana + peanut butter toast", timeMinutes: 390, kind: "meal", subtitle: "Breakfast · 6:30 AM", kcal: 340, why: "Fast-digesting carbs ahead of the morning run."),
                FixturePlanItem(title: "10km tempo run", timeMinutes: 420, kind: "move", subtitle: "Run · 7:00 AM", kcal: nil, why: "Race-pace intervals to build lactate threshold."),
                FixturePlanItem(title: "Rice bowl with chicken", timeMinutes: 780, kind: "meal", subtitle: "Lunch · 1:00 PM", kcal: 560, why: "Replenishes glycogen spent on the tempo run."),
                FixturePlanItem(title: "Electrolyte smoothie", timeMinutes: 990, kind: "meal", subtitle: "Snack · 4:30 PM", kcal: 240, why: "Rehydration ahead of tomorrow's easy run."),
                FixturePlanItem(title: "Pasta with turkey ragu", timeMinutes: 1140, kind: "meal", subtitle: "Dinner · 7:00 PM", kcal: 620, why: "Carb-forward dinner to top off glycogen stores."),
            ],
            meals: [
                FixtureMeal(name: "Banana + peanut butter toast", kcal: 340, c: 46, p: 10, f: 12, slot: "breakfast"),
                FixtureMeal(name: "Rice bowl with chicken", kcal: 560, c: 68, p: 38, f: 12, slot: "lunch"),
                FixtureMeal(name: "Electrolyte smoothie", kcal: 240, c: 42, p: 6, f: 3, slot: "snacks"),
            ],
            weightKg: 61, weightTrendPerWeekKg: -0.1,
            hrv: 68, restingHR: 46, sleepMinutes: 445, steps: 11200, distanceKm: 12.4,
            workoutTitle: "10km tempo run", workoutKm: 10.2
        ),
    ]

    // MARK: - Entry point

    /// `scenario` is `nil` only if this were somehow reached without
    /// `FixtureMode.isActive` (impossible in practice — `FixtureURLProtocol
    /// .canInit` already gates on it), handled defensively rather than force-
    /// unwrapped.
    static func response(scenario: FixtureMode.Scenario?, method: String, path: String, query: String) -> (Int, Data) {
        guard let scenario else { return (404, jsonData(["error": "no active fixture scenario"])) }

        if scenario == .serverError {
            return (500, jsonData(["error": "Internal Server Error (fixture)"]))
        }

        // `.onboarding` never reaches a data screen, but falls back to the
        // `newUser` profile harmlessly if it somehow does.
        let profile = profiles[scenario] ?? profiles[.newUser]!

        switch (method, path) {
        case ("GET", "/api/today"):
            return (200, jsonData(today(profile)))
        case ("GET", "/api/plan"):
            return (200, jsonData(plan(profile)))
        case ("GET", "/api/streak"):
            return (200, jsonData(["streakDays": profile.established ? 6 : 1]))
        case ("GET", "/api/pending-facts"):
            return (200, jsonData(["items": [String]()]))
        case ("GET", "/api/coach"):
            return (200, jsonData(coachRestoration(profile)))
        case ("GET", "/api/coach/opener"):
            return (200, jsonData(["text": profile.established ? coachOpener : newUserCoachOpener]))
        case ("POST", "/api/coach"):
            // Never exercised by the screenshot harness (see
            // `FixtureURLProtocol.startLoading`) — a well-formed empty SSE
            // stream in case something unexpected reaches it.
            return (200, Data("data: {\"type\":\"done\"}\n\n".utf8))
        case ("GET", "/api/trends"):
            return query.contains("metrics=")
                ? (200, jsonData(trendsBatch(profile)))
                : (200, jsonData(trendsSingle(profile, query: query)))
        case ("GET", "/api/logs"):
            return (200, jsonData(logs(profile)))
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

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func dayString(_ daysAgo: Int) -> String {
        let date = Calendar.current.date(byAdding: .day, value: -daysAgo, to: Date()) ?? Date()
        return dayFormatter.string(from: date)
    }

    /// Small deterministic (no randomness — reproducible screenshots)
    /// day-to-day variation so a sparkline isn't a flat line.
    private static func wiggle(_ base: Double, _ offset: Int) -> Double {
        base + Double(offset % 3 - 1) * (base * 0.03)
    }

    // MARK: - Shared calibration block

    /// `CalibrationStatus`.
    private static func calibration(_ profile: Profile) -> [String: Any] {
        ["status": profile.established ? "ready" : "calibrating", "metrics": [String: Any]()]
    }

    // MARK: - GET /api/today → TodayResponse

    private static func today(_ profile: Profile) -> [String: Any] {
        func metric(_ value: Double, unit: String, delta: Int) -> [String: Any] {
            profile.established
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
                "hrv": metric(profile.hrv, unit: "ms", delta: 4),
                // /api/today sends sleep in HOURS (unit "h"), e.g. 7.25 — see
                // app/api/today/route.ts's documented response shape.
                // `profile.sleepMinutes` is authored in minutes for
                // readability, so convert here.
                "sleep": metric(profile.sleepMinutes / 60, unit: "h", delta: 2),
                "restingHr": metric(profile.restingHR, unit: "bpm", delta: -3),
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
        let items = profile.plan.enumerated().map { index, item -> [String: Any] in
            [
                "id": "fixture-plan-\(index)",
                "timeMinutes": item.timeMinutes,
                "title": item.title,
                "subtitle": item.subtitle,
                "kind": item.kind,
                "source": "coach",
                "status": "pending",
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
    private static func coachRestoration(_ profile: Profile) -> [String: Any] {
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
        let message: [String: Any] = [
            "id": "00000000-0000-4000-8000-000000000001",
            "role": "assistant",
            "speaker": "vital",
            "content": coachOpener,
            "timestamp": isoNow,
            "specialistSessionId": NSNull(),
            "specialistMetadata": NSNull(),
        ]
        return [
            "messages": [message],
            "activePersona": activePersona,
            "pendingCard": NSNull(),
        ]
    }

    // MARK: - GET /api/trends?metric= → TrendsResponse

    private static func trendsSingle(_ profile: Profile, query: String) -> [String: Any] {
        let metricName = query
            .split(separator: "&")
            .first { $0.hasPrefix("metric=") }
            .map { String($0.dropFirst("metric=".count)) } ?? "sleep"
        let base: Double
        switch metricName {
        case "hrv": base = profile.hrv
        case "rhr": base = profile.restingHR
        // "sleep" — same `sleep_minutes` metric as trendsBatch below, scaled
        // to hours server-side (lib/metricCatalog.ts's `scale: 1/60`).
        default:    base = profile.sleepMinutes / 60
        }
        let points = (0..<7).reversed().map { offset -> [String: Any] in
            ["date": dayString(offset), "value": wiggle(base, offset)]
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
        case "distance_m":          return profile.distanceKm * 1000
        case "exercise_min":        return 35
        case "flights":              return 8
        case "active_energy_kcal":  return 420
        case "basal_energy_kcal":   return 1650
        case "vo2_max":              return 42
        case "body_mass_kg":        return profile.weightKg
        default:                     return 0
        }
    }

    private static func trendsBatch(_ profile: Profile) -> [String: Any] {
        let pointCount = 14
        var series: [String: Any] = [:]
        for key in batchMetricKeys {
            let base = baseValue(key, profile)
            // Only body weight actually trends day over day in this fixture;
            // every other metric is a flat baseline plus `wiggle`'s noise.
            let dailyTrend = key == "body_mass_kg" ? profile.weightTrendPerWeekKg / 7 : 0
            let points = (0..<pointCount).reversed().map { offset -> [String: Any] in
                let value = base + dailyTrend * Double(offset) + (wiggle(base, offset) - base)
                return ["date": dayString(offset), "value": value]
            }
            let baseline: [String: Any] = [
                "mean7": base, "mean30": base, "mean60": base,
                "sd30": base * 0.05, "p25": base * 0.95, "p50": base, "p75": base * 1.05,
            ]
            let entry: [String: Any] = [
                // `label`/`unit` are decoded but never rendered — TrendsViewModel
                // looks the display name/unit up in its own local MetricCatalog
                // instead (see MetricCatalog.swift), so these are placeholders.
                "metric": key, "label": key, "unit": "",
                "points": points,
                "baseline": baseline,
                "dataDays": profile.established ? 30 : 2,
                "established": profile.established,
                "lastDate": dayString(0),
            ]
            series[key] = entry
        }
        return [
            "days": 30,
            "series": series,
            "unknownMetrics": [String](),
            "calibration": calibration(profile),
        ]
    }

    // MARK: - GET /api/logs → LogsResponse

    private static func logs(_ profile: Profile) -> [String: Any] {
        var items: [[String: Any]] = []

        if let firstMeal = profile.meals.first {
            items.append([
                "id": "fixture-log-meal",
                "type": "meal_logged",
                "timestamp": isoNow,
                "hasExactTime": true,
                "dayKey": NSNull(),
                "title": firstMeal.name,
                "subtitle": "Logged · \(firstMeal.slot.capitalized)",
                "imageThumb": NSNull(),
                "kcal": Double(firstMeal.kcal),
                "km": NSNull(),
                "sleepMs": NSNull(),
                "analysisId": NSNull(),
            ])
        }

        if let workoutTitle = profile.workoutTitle, let workoutKm = profile.workoutKm {
            items.append([
                "id": "fixture-log-workout",
                "type": "workout_completed",
                "timestamp": isoNow,
                "hasExactTime": true,
                "dayKey": NSNull(),
                "title": workoutTitle,
                "subtitle": "Completed this morning",
                "imageThumb": NSNull(),
                "kcal": NSNull(),
                "km": workoutKm,
                "sleepMs": NSNull(),
                "analysisId": NSNull(),
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
            "loggedDays": profile.established ? 24 : 1,
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

    // MARK: - GET /api/notification-preferences → NotificationPreferences

    private static func notificationPreferences() -> [String: Any] {
        [
            "morningBriefEnabled": true, "morningBriefTimeMinutes": 450,
            "workoutNotificationsEnabled": true, "sleepNotificationsEnabled": true,
            "mealsEnabled": true,
            "mealBreakfastTimeMinutes": 480, "mealLunchTimeMinutes": 765,
            "mealSnackTimeMinutes": 960, "mealDinnerTimeMinutes": 1170,
            "timezone": TimeZone.current.identifier,
        ]
    }
}
#endif
