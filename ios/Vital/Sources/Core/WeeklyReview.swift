import Foundation
import SwiftUI

// MARK: - Weekly review types (GET /api/review/weekly)

/// One stat tile in the review ("Weekly avg weight", "−0.6 kg", "vs the week
/// before" — a one-week change, labelled so it is never read as the goal
/// sheet's 4-week "kg/wk" trend rate). `value` / `comparison` arrive already formatted in the user's
/// unit system by the server (lib/weeklyReview.ts) — the app only lays them
/// out. Tolerant decode: unknown tone -> `.neutral`.
struct WeeklyReviewStatDTO: Decodable, Equatable, Identifiable {
    let label: String
    let value: String
    let comparison: String?
    let tone: GoalReasonTone

    var id: String { label }

    private enum CodingKeys: String, CodingKey { case label, value, comparison, tone }

    init(label: String, value: String, comparison: String? = nil, tone: GoalReasonTone = .neutral) {
        self.label = label
        self.value = value
        self.comparison = comparison
        self.tone = tone
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = (try? c.decode(String.self, forKey: .label)) ?? ""
        value = (try? c.decode(String.self, forKey: .value)) ?? ""
        comparison = try? c.decodeIfPresent(String.self, forKey: .comparison)
        tone = GoalReasonTone(wire: try? c.decode(String.self, forKey: .tone))
    }
}

/// `review.weekRating` on the wire (`lib/weeklyReview.ts` `WeekRating`): how
/// the reviewed week ITSELF went, from that week's own stats — unlike
/// `verdict`, which is the 4-week goal verdict as of that week. Unknown
/// future values fail to parse (`nil`), never read as "good".
enum WeekRating: String, Equatable, Sendable {
    case good
    case mixed
    case tough
    /// A deliberate lighter (deload) week.
    case light

    init?(wire: String?) {
        guard let wire, let rating = WeekRating(rawValue: wire) else { return nil }
        self = rating
    }
}

/// The `review` object of GET /api/review/weekly.
struct WeeklyReviewDTO: Decodable, Equatable {
    /// Monday / Sunday of the reviewed local week, "YYYY-MM-DD".
    let weekStart: String
    let weekEnd: String
    let goal: String
    /// The 4-week GOAL verdict as of the reviewed week — shared with the goal
    /// card. Not a rating of the week itself; the pill uses `weekRating`.
    let verdict: GoalVerdict
    /// The reviewed week's own rating, `nil` when the server could not rate it
    /// from that week's stats (or sent a value this build doesn't know).
    let weekRating: WeekRating?
    /// True when the payload carried a `weekRating` key at all (even `null`):
    /// the server has spoken about this week, so the pill must never fall back
    /// to the goal-verdict wording. False only for rows stored before the field
    /// existed.
    let hasWeekRating: Bool
    let headline: String
    let stats: [WeeklyReviewStatDTO]
    let win: String?
    let slip: String?
    let nextWeek: String
    /// `dataSufficiency.sufficient` — false means the server only had enough
    /// for a "not enough data yet" nudge.
    let sufficient: Bool

    private enum CodingKeys: String, CodingKey {
        case weekStart, weekEnd, goal, verdict, weekRating, headline, stats, win, slip, nextWeek, dataSufficiency
    }
    private struct Sufficiency: Decodable { let sufficient: Bool? }

    init(
        weekStart: String, weekEnd: String, goal: String = "weight_loss",
        verdict: GoalVerdict = .insufficientData,
        weekRating: WeekRating? = nil, hasWeekRating: Bool? = nil,
        headline: String,
        stats: [WeeklyReviewStatDTO] = [], win: String? = nil, slip: String? = nil,
        nextWeek: String = "", sufficient: Bool = true
    ) {
        self.weekStart = weekStart
        self.weekEnd = weekEnd
        self.goal = goal
        self.verdict = verdict
        self.weekRating = weekRating
        self.hasWeekRating = hasWeekRating ?? (weekRating != nil)
        self.headline = headline
        self.stats = stats
        self.win = win
        self.slip = slip
        self.nextWeek = nextWeek
        self.sufficient = sufficient
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        weekStart = try c.decode(String.self, forKey: .weekStart)
        weekEnd = try c.decode(String.self, forKey: .weekEnd)
        goal = (try? c.decode(String.self, forKey: .goal)) ?? ""
        verdict = GoalVerdict(wire: try? c.decode(String.self, forKey: .verdict))
        // `contains` is true for an explicit JSON null too: "server declined to
        // rate" (null) is different from an old row that has no key at all.
        hasWeekRating = c.contains(.weekRating)
        weekRating = WeekRating(wire: try? c.decodeIfPresent(String.self, forKey: .weekRating))
        headline = (try? c.decode(String.self, forKey: .headline)) ?? ""
        stats = (try? c.decode([WeeklyReviewStatDTO].self, forKey: .stats)) ?? []
        win = try? c.decodeIfPresent(String.self, forKey: .win)
        slip = try? c.decodeIfPresent(String.self, forKey: .slip)
        nextWeek = (try? c.decode(String.self, forKey: .nextWeek)) ?? ""
        sufficient = (try? c.decode(Sufficiency.self, forKey: .dataSufficiency))?.sufficient ?? false
    }
}

/// GET /api/review/weekly's full response: the stored row plus its review.
struct WeeklyReviewResponse: Decodable, Equatable {
    let id: String
    /// ISO timestamp the user tapped "Got it", or nil while unseen.
    let seenAt: String?
    let review: WeeklyReviewDTO

    var isSeen: Bool { seenAt != nil }

    init(id: String, seenAt: String? = nil, review: WeeklyReviewDTO) {
        self.id = id
        self.seenAt = seenAt
        self.review = review
    }

    func markingSeen(at stamp: String) -> WeeklyReviewResponse {
        WeeklyReviewResponse(id: id, seenAt: seenAt ?? stamp, review: review)
    }
}

// MARK: - Shared store

/// Single source of the latest weekly review for Today's card, the Trends row
/// and the push deep link. Fail-soft: a failed load leaves `latest` as it was
/// (nil on a cold start, so nothing renders) — never zeros or placeholders.
@MainActor
final class WeeklyReviewStore: ObservableObject {
    /// What the "First review on …" / "To get started" copy keys off
    /// (`WeeklyReviewLogic.isNewAccount`): the profile's `createdAt` and
    /// `stats.loggedDays`.
    struct Account: Equatable {
        let createdAtISO: String?
        let loggedDays: Int?
    }

    static let shared = WeeklyReviewStore(fetchAccount: {
        let profile = try await APIClient.shared.fetchProfile()
        return Account(createdAtISO: profile.createdAt, loggedDays: profile.stats.loggedDays)
    })

    @Published private(set) var latest: WeeklyReviewResponse?
    /// Bumped each time the user commits "Got it" — drives the haptic.
    @Published private(set) var seenTick = 0
    /// False once the account is established (older than 14 days with real
    /// logging history): a veteran back after a gap sees "Your next review: …",
    /// never "First review on …". Starts true, and stays true when the profile
    /// can't be read, so the long-standing copy is the fail-soft default.
    @Published private(set) var isNewAccount = true

    private let fetch: () async throws -> WeeklyReviewResponse
    private let postSeen: (String) async throws -> Void
    private let fetchAccount: (() async throws -> Account)?
    private let now: () -> Date

    init(
        fetch: @escaping () async throws -> WeeklyReviewResponse = { try await APIClient.shared.fetchWeeklyReview() },
        postSeen: @escaping (String) async throws -> Void = { try await APIClient.shared.markWeeklyReviewSeen(id: $0) },
        fetchAccount: (() async throws -> Account)? = nil,
        now: @escaping () -> Date = { AppClock.now }
    ) {
        self.fetch = fetch
        self.postSeen = postSeen
        self.fetchAccount = fetchAccount
        self.now = now
    }

    func load() async {
        do {
            let fresh = try await fetch()
            // The account only matters for the not-enough-data copy, so skip the
            // extra request otherwise. Resolved BEFORE publishing the review so a
            // veteran never sees "First review" flash and flip.
            var newAccount = isNewAccount
            if WeeklyReviewLogic.isNotEnoughData(fresh.review), let fetchAccount,
               let account = try? await fetchAccount() {
                newAccount = WeeklyReviewLogic.isNewAccount(
                    createdAtISO: account.createdAtISO, loggedDays: account.loggedDays, now: now()
                )
            }
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) {
                latest = fresh
                isNewAccount = newAccount
            }
        } catch {
            if !error.isCancellation {
                print("[Vital] fetchWeeklyReview failed: \(error.localizedDescription)")
            }
        }
    }

    /// Optimistic: hides the card immediately, then tells the server. A
    /// failed POST is not retried — the card would reappear on the next
    /// launch's load, which is acceptable for a dismissal.
    func markSeen() {
        guard let current = latest, !current.isSeen else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) {
            latest = current.markingSeen(at: stamp)
        }
        seenTick += 1
        let id = current.id
        Task { [postSeen] in
            do { try await postSeen(id) } catch {
                if !error.isCancellation {
                    print("[Vital] markWeeklyReviewSeen failed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// Sign-out: drop the previous account's review.
    func reset() {
        latest = nil
        isNewAccount = true
    }
}
