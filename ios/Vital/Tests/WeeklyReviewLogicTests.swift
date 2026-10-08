import XCTest
@testable import Vital

/// Pure-logic coverage for the Weekly Review card / detail / Trends row
/// (`WeeklyReviewLogic`), the tolerant DTO decoding, the push route and the
/// store's optimistic "Got it".
final class WeeklyReviewLogicTests: XCTestCase {

    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func date(_ y: Int, _ m: Int, _ d: Int, hour: Int = 9) -> Date {
        utc.date(from: DateComponents(year: y, month: m, day: d, hour: hour))!
    }

    private func review(
        stats: [WeeklyReviewStatDTO] = [WeeklyReviewStatDTO(label: "Days in budget", value: "5/7", comparison: "6 days logged", tone: .good),
                                        WeeklyReviewStatDTO(label: "Workouts", value: "3", tone: .good)],
        win: String? = "You stayed within your 1,850 kcal target on 5 of 7 logged days.",
        slip: String? = "Weekends ran +450 kcal over your weekdays.",
        nextWeek: String = "Plan Saturday's dinner — weekends ran +450 kcal over weekdays.",
        sufficient: Bool = true
    ) -> WeeklyReviewDTO {
        WeeklyReviewDTO(
            weekStart: "2026-09-28", weekEnd: "2026-10-04", goal: "weight_loss", verdict: .onTrack,
            headline: "Down 0.6 kg, in budget 5 of 7 days", stats: stats, win: win, slip: slip,
            nextWeek: nextWeek, sufficient: sufficient
        )
    }

    // MARK: - Card window (Mon-Wed, unseen only)

    func testCardShowsMondayThroughWednesdayOnly() {
        let response = WeeklyReviewResponse(id: "r1", review: review())
        // weekEnd = Sun 2026-10-04.
        XCTAssertFalse(WeeklyReviewLogic.shouldShowCard(response, now: date(2026, 10, 4), calendar: utc), "Sunday: week not over")
        XCTAssertTrue(WeeklyReviewLogic.shouldShowCard(response, now: date(2026, 10, 5), calendar: utc), "Monday")
        XCTAssertTrue(WeeklyReviewLogic.shouldShowCard(response, now: date(2026, 10, 6), calendar: utc), "Tuesday")
        XCTAssertTrue(WeeklyReviewLogic.shouldShowCard(response, now: date(2026, 10, 7, hour: 23), calendar: utc), "Wednesday late")
        XCTAssertFalse(WeeklyReviewLogic.shouldShowCard(response, now: date(2026, 10, 8), calendar: utc), "Thursday: Trends only")
    }

    func testCardHiddenOnceSeenOrMissing() {
        let seen = WeeklyReviewResponse(id: "r1", seenAt: "2026-10-05T09:00:00Z", review: review())
        XCTAssertFalse(WeeklyReviewLogic.shouldShowCard(seen, now: date(2026, 10, 5), calendar: utc))
        XCTAssertFalse(WeeklyReviewLogic.shouldShowCard(nil, now: date(2026, 10, 5), calendar: utc))
    }

    func testIgnoreWindowStillRespectsSeen() {
        let unseen = WeeklyReviewResponse(id: "r1", review: review())
        let seen = unseen.markingSeen(at: "2026-10-05T09:00:00Z")
        XCTAssertTrue(WeeklyReviewLogic.shouldShowCard(unseen, now: date(2026, 10, 20), calendar: utc, ignoreWindow: true))
        XCTAssertFalse(WeeklyReviewLogic.shouldShowCard(seen, now: date(2026, 10, 20), calendar: utc, ignoreWindow: true))
    }

    func testMalformedWeekEndNeverShowsCard() {
        var bad = review()
        bad = WeeklyReviewDTO(weekStart: "x", weekEnd: "not-a-date", headline: "h", stats: bad.stats)
        XCTAssertNil(WeeklyReviewLogic.daysSinceWeekEnd(bad, now: date(2026, 10, 5), calendar: utc))
        XCTAssertFalse(WeeklyReviewLogic.shouldShowCard(WeeklyReviewResponse(id: "r", review: bad), now: date(2026, 10, 5), calendar: utc))
    }

    // MARK: - Content decisions

    func testNotEnoughDataHidesChipStatsWinAndSlip() {
        let empty = review(stats: [], win: "ignored", slip: "ignored", nextWeek: "Log a few more days.", sufficient: false)
        XCTAssertTrue(WeeklyReviewLogic.isNotEnoughData(empty))
        XCTAssertNil(WeeklyReviewLogic.verdictLabel(empty))
        let rows = WeeklyReviewLogic.rows(empty)
        XCTAssertEqual(rows.map(\.kind), [.next])
        XCTAssertEqual(rows.first?.title, "To get started")
    }

    /// A review stored before `weekRating` existed (the helper sets none) keeps the old verdict mapping.
    func testSufficientLegacyReviewUsesVerdictMappingAndAllRows() {
        let full = review()
        XCTAssertFalse(WeeklyReviewLogic.isNotEnoughData(full))
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(full), "Good week")
        XCTAssertNotEqual(WeeklyReviewLogic.verdictLabel(full), GoalProgressLogic.label(for: .onTrack))
        XCTAssertEqual(WeeklyReviewLogic.weekLabel(for: .behind), "Mixed week")
        XCTAssertEqual(WeeklyReviewLogic.weekLabel(for: .stalled), "Tough week")
        XCTAssertEqual(WeeklyReviewLogic.weekLabel(for: .building), "Good week")
        XCTAssertEqual(WeeklyReviewLogic.weekLabel(for: .insufficientData), "Early days")
        XCTAssertEqual(WeeklyReviewLogic.weekLabel(for: .needsTarget), "Set a target")
        XCTAssertEqual(WeeklyReviewLogic.rows(full).map(\.kind), [.win, .slip, .next])
        XCTAssertEqual(WeeklyReviewLogic.rows(full).last?.title, "Next week")
    }

    func testBlankWinAndSlipRowsAreOmitted() {
        let r = review(win: "  ", slip: nil)
        XCTAssertEqual(WeeklyReviewLogic.rows(r).map(\.kind), [.next])
    }

    func testRangeText() {
        XCTAssertEqual(WeeklyReviewLogic.rangeText(review(), calendar: utc), "Sep 28 – Oct 4")
    }

    func testStatAccessibilityLabel() {
        let withComparison = WeeklyReviewStatDTO(label: "Days in budget", value: "5/7", comparison: "6 days logged", tone: .good)
        XCTAssertEqual(WeeklyReviewLogic.accessibilityLabel(for: withComparison), "Days in budget, 5 of 7, 6 days logged")
        let plain = WeeklyReviewStatDTO(label: "Workouts", value: "3")
        XCTAssertEqual(WeeklyReviewLogic.accessibilityLabel(for: plain), "Workouts, 3")
    }

    // MARK: - Week pill rates THE WEEK (weekRating), not the 4-week goal verdict

    private func rated(
        verdict: GoalVerdict, weekRating: WeekRating?, hasWeekRating: Bool? = nil, sufficient: Bool = true
    ) -> WeeklyReviewDTO {
        WeeklyReviewDTO(
            weekStart: "2026-09-28", weekEnd: "2026-10-04", goal: "muscle", verdict: verdict,
            weekRating: weekRating, hasWeekRating: hasWeekRating,
            headline: "3 of 4 sessions, Squat est. 1RM +20 kg over 4 wks",
            stats: [WeeklyReviewStatDTO(label: "Sessions", value: "3"), WeeklyReviewStatDTO(label: "Protein days hit", value: "5/7")],
            nextWeek: "Repeat this week.", sufficient: sufficient
        )
    }

    func testPillWordFollowsWeekRatingForEveryRating() {
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: .progressing, weekRating: .good)), "Good week")
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: .progressing, weekRating: .mixed)), "Mixed week")
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: .progressing, weekRating: .tough)), "Tough week")
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: .progressing, weekRating: .light)), "Lighter week")
        XCTAssertEqual(WeeklyReviewLogic.weekLabel(for: WeekRating.good), "Good week")
        XCTAssertEqual(WeeklyReviewLogic.weekLabel(for: WeekRating.light), "Lighter week")
    }

    /// The persona bug: the goal chip said "Sessions behind" (4-week verdict
    /// `behind`) while the weekly pill said "Good week" — now the pill ignores
    /// the goal verdict entirely whenever the server rated the week.
    func testPillIgnoresTheGoalVerdictWhenTheWeekIsRated() {
        for verdict in [GoalVerdict.behind, .stalled, .tooFast, .holding, .onTrack, .progressing, .insufficientData, .needsTarget] {
            XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: verdict, weekRating: .mixed)), "Mixed week", "\(verdict)")
        }
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: .behind, weekRating: .good)), "Good week")
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: .onTrack, weekRating: .tough)), "Tough week")
        // The old mapping would have said "Mixed week" for `.behind`.
        XCTAssertEqual(WeeklyReviewLogic.weekLabel(for: GoalVerdict.behind), "Mixed week")
    }

    func testPillFallsBackToTheVerdictMappingOnlyWhenWeekRatingIsAbsent() {
        // An old stored row: no `weekRating` key at all.
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: .behind, weekRating: nil)), "Mixed week")
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: .stalled, weekRating: nil)), "Tough week")
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(rated(verdict: .onTrack, weekRating: nil)), "Good week")
        // The key is present but null ("can't rate this week"): no pill, and
        // certainly not the goal verdict's wording.
        XCTAssertNil(WeeklyReviewLogic.verdictLabel(rated(verdict: .onTrack, weekRating: nil, hasWeekRating: true)))
        XCTAssertNil(WeeklyReviewLogic.verdictLabel(rated(verdict: .behind, weekRating: nil, hasWeekRating: true)))
    }

    func testNotEnoughDataNeverShowsAWeekPill() {
        XCTAssertNil(WeeklyReviewLogic.verdictLabel(rated(verdict: .onTrack, weekRating: .good, sufficient: false)))
    }

    func testPillToneFollowsTheSameSourceAsTheLabel() {
        XCTAssertEqual(WeeklyReviewLogic.tone(for: rated(verdict: .behind, weekRating: .good)), .good)
        XCTAssertEqual(WeeklyReviewLogic.tone(for: rated(verdict: .onTrack, weekRating: .tough)), .watch)
        XCTAssertEqual(WeeklyReviewLogic.tone(for: rated(verdict: .onTrack, weekRating: .mixed)), .neutral)
        XCTAssertEqual(WeeklyReviewLogic.tone(for: rated(verdict: .onTrack, weekRating: .light)), .neutral)
        XCTAssertEqual(WeeklyReviewLogic.tone(for: rated(verdict: .onTrack, weekRating: nil, hasWeekRating: true)), .neutral)
        // Legacy rows keep the goal verdict's tone.
        XCTAssertEqual(WeeklyReviewLogic.tone(for: rated(verdict: .behind, weekRating: nil)), .watch)
        XCTAssertEqual(WeeklyReviewLogic.tone(for: rated(verdict: .onTrack, weekRating: nil)), .good)
    }

    func testDecodesWeekRatingNullAbsentAndUnknown() throws {
        func decode(_ extra: String) throws -> WeeklyReviewDTO {
            let json = """
            {"id":"r","review":{"weekStart":"2026-09-28","weekEnd":"2026-10-04","goal":"muscle","verdict":"behind",
             "headline":"h","stats":[{"label":"Sessions","value":"3","comparison":null,"tone":"neutral"},
                                      {"label":"Weight trend","value":"+0.2 kg","comparison":null,"tone":"good"}],
             "nextWeek":"n","dataSufficiency":{"daysWithData":6,"statCount":2,"sufficient":true}\(extra)}}
            """
            return try JSONDecoder().decode(WeeklyReviewResponse.self, from: Data(json.utf8)).review
        }
        // Rated: the pill is the week's, even though the goal verdict is `behind`.
        let mixed = try decode(",\"weekRating\":\"mixed\"")
        XCTAssertEqual(mixed.weekRating, .mixed)
        XCTAssertTrue(mixed.hasWeekRating)
        XCTAssertEqual(mixed.verdict, .behind)
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(mixed), "Mixed week")
        XCTAssertEqual(try decode(",\"weekRating\":\"light\"").weekRating, .light)
        // Explicit null: server spoke, nothing to say.
        let null = try decode(",\"weekRating\":null")
        XCTAssertNil(null.weekRating)
        XCTAssertTrue(null.hasWeekRating)
        XCTAssertNil(WeeklyReviewLogic.verdictLabel(null))
        // Old stored row: key missing -> legacy verdict mapping.
        let old = try decode("")
        XCTAssertNil(old.weekRating)
        XCTAssertFalse(old.hasWeekRating)
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(old), "Mixed week")
        // A value from the future / a wrong type never reads as a rating, and never falls back to the goal wording.
        for junk in [",\"weekRating\":\"great\"", ",\"weekRating\":7"] {
            let unknown = try decode(junk)
            XCTAssertNil(unknown.weekRating, junk)
            XCTAssertTrue(unknown.hasWeekRating, junk)
            XCTAssertNil(WeeklyReviewLogic.verdictLabel(unknown), junk)
        }
    }

    // MARK: - Decoding

    func testDecodesServerPayloadAndToleratesUnknownValues() throws {
        let json = """
        {
          "id": "5b0f6ac0-9c2e-4d0e-8a77-6b3c1c2f9a11",
          "seenAt": null,
          "createdAt": "2026-10-05T12:00:00.000Z",
          "review": {
            "weekStart": "2026-09-28", "weekEnd": "2026-10-04", "goal": "muscle", "verdict": "some_future_verdict",
            "headline": "3 of 4 sessions, Bench Press up 2.5 kg",
            "stats": [
              {"label": "Sessions", "value": "3", "comparison": "target 4", "tone": "neutral"},
              {"label": "Weight trend", "value": "+0.2 kg", "comparison": null, "tone": "mystery"}
            ],
            "win": "Bench up.", "slip": null, "nextWeek": "Repeat this week.",
            "dataSufficiency": {"daysWithData": 6, "statCount": 2, "sufficient": true}
          }
        }
        """
        let response = try JSONDecoder().decode(WeeklyReviewResponse.self, from: Data(json.utf8))
        XCTAssertFalse(response.isSeen)
        XCTAssertEqual(response.review.verdict, .insufficientData, "unknown verdicts never read as on-track")
        XCTAssertEqual(response.review.stats.count, 2)
        XCTAssertEqual(response.review.stats[1].tone, .neutral)
        XCTAssertNil(response.review.stats[1].comparison)
        XCTAssertNil(response.review.slip)
        XCTAssertTrue(response.review.sufficient)
    }

    func testMissingDataSufficiencyReadsAsNotSufficient() throws {
        let json = #"{"id":"r","review":{"weekStart":"2026-09-28","weekEnd":"2026-10-04","headline":"h"}}"#
        let response = try JSONDecoder().decode(WeeklyReviewResponse.self, from: Data(json.utf8))
        XCTAssertFalse(response.review.sufficient)
        XCTAssertTrue(WeeklyReviewLogic.isNotEnoughData(response.review))
    }

    // MARK: - Push route

    func testWeeklyReviewPushRoute() {
        let id = "3F2504E0-4F89-11D3-9A0C-0305E82C3301"
        let ok: [AnyHashable: Any] = ["type": "weekly_review", "id": id, "deepLink": "vital://weekly-review/\(id)"]
        XCTAssertEqual(PushRoute(userInfo: ok), .weeklyReview(id))
        let wrongHost: [AnyHashable: Any] = ["type": "weekly_review", "id": id, "deepLink": "vital://coach-nudge/\(id)"]
        XCTAssertNil(PushRoute(userInfo: wrongHost))
        let badId: [AnyHashable: Any] = ["type": "weekly_review", "id": "nope", "deepLink": "vital://weekly-review/nope"]
        XCTAssertNil(PushRoute(userInfo: badId))
    }

    // MARK: - Store

    @MainActor
    func testMarkSeenIsOptimisticAndPostsOnce() async {
        let unseen = WeeklyReviewResponse(id: "r1", review: review())
        var posted: [String] = []
        let store = WeeklyReviewStore(fetch: { unseen }, postSeen: { posted.append($0) })
        await store.load()
        XCTAssertEqual(store.latest?.isSeen, false)

        store.markSeen()
        XCTAssertEqual(store.latest?.isSeen, true, "card hides immediately")
        XCTAssertEqual(store.seenTick, 1)
        store.markSeen() // already seen: no second post / haptic
        XCTAssertEqual(store.seenTick, 1)
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(posted, ["r1"])
    }

    @MainActor
    func testFailedLoadLeavesNothingAndResetClears() async {
        struct Boom: Error {}
        let store = WeeklyReviewStore(fetch: { throw Boom() }, postSeen: { _ in })
        await store.load()
        XCTAssertNil(store.latest)

        let ok = WeeklyReviewStore(fetch: { WeeklyReviewResponse(id: "r1", review: self.review()) }, postSeen: { _ in })
        await ok.load()
        XCTAssertNotNil(ok.latest)
        ok.reset()
        XCTAssertNil(ok.latest)
    }
}
