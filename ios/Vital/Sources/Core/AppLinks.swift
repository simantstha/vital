import Foundation

/// External URLs the app links out to.
enum AppLinks {
    /// Hosted by the backend (app/privacy/page.tsx), rendered from
    /// docs/privacy-policy.md. NOTE: that content is an owner-reviewed DRAFT —
    /// the owner must finalize the [bracketed] items and effective date in the
    /// doc before App Store submission.
    static let privacyPolicy = URL(string: "https://vital-coach.fly.dev/privacy")!
}
