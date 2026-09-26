import Foundation

/// Pure copy generator behind the Trends header's one-line summary
/// ("Three things moved this month — 2 good, 1 to watch."), replacing the
/// old static "Last 30 days · N metrics tracked" subtitle. No SwiftUI
/// import, no `Date()` — every input is a plain count so `TrendsHeadlineTests`
/// can pin exact copy for every good/watch/period combination.
///
/// Numbers below nine spell out as words ("Three", "one"); ten and up fall
/// back to digits — this never actually needs to render past the grid's tile
/// count (well under ten), but the fallback keeps the helper honest rather
/// than crashing on an out-of-range index.
enum TrendsHeadline {
    /// `boldText` is the emphasized "N things moved <period>" clause;
    /// `trailingText` is the plain-weight remainder, already including its
    /// leading " — " (or, when nothing moved, the entire sentence — in that
    /// case `boldText` is empty and the view renders `trailingText` alone).
    struct Summary: Equatable {
        let boldText: String
        let trailingText: String

        /// The full sentence, boldText + trailingText concatenated — for
        /// contexts (VoiceOver, tests) that don't care about the bold split.
        var fullText: String { boldText + trailingText }
    }

    static func summary(goodCount: Int, watchCount: Int, period: TrendsPeriod) -> Summary {
        let total = goodCount + watchCount
        guard total > 0 else {
            return Summary(boldText: "", trailingText: "Everything's in your normal range.")
        }

        let thingWord = total == 1 ? "thing" : "things"
        let bold = "\(wordForCount(total).capitalizedFirstLetter) \(thingWord) moved \(period.headlineWord)"

        let detail: String
        if goodCount > 0 && watchCount > 0 {
            detail = "\(wordForCount(goodCount)) good, \(wordForCount(watchCount)) to watch"
        } else if goodCount > 0 {
            detail = sideOnly(goodCount, label: "good")
        } else {
            detail = sideOnly(watchCount, label: "to watch")
        }
        return Summary(boldText: bold, trailingText: " — \(detail).")
    }

    /// "both good" / "both to watch" when the omitted side leaves exactly
    /// two on the other — otherwise a spelled-out (or, past nine, digit)
    /// count word plus the label.
    private static func sideOnly(_ count: Int, label: String) -> String {
        count == 2 ? "both \(label)" : "\(wordForCount(count)) \(label)"
    }

    private static let numberWords = [
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    ]

    static func wordForCount(_ n: Int) -> String {
        (n >= 0 && n < numberWords.count) ? numberWords[n] : "\(n)"
    }
}

private extension String {
    var capitalizedFirstLetter: String {
        guard let first else { return self }
        return first.uppercased() + dropFirst()
    }
}
