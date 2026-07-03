import Foundation

extension String {
    /// Parses inline markdown (**bold**, *italic*, `code`, links) into an
    /// AttributedString, preserving whitespace and newlines. Coach/brief text
    /// from Claude is markdown, so render it through this instead of showing
    /// raw `**` markers. Falls back to plain text if parsing fails.
    var asMarkdown: AttributedString {
        guard var attributed = try? AttributedString(
            markdown: self,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        ) else {
            return AttributedString(self)
        }
        // Security: coach/brief text is AI-generated and can be influenced by
        // user-supplied content (meal names, lab text, chat). Strip any parsed
        // markdown links so `[apple.com](evil.com)` can't phish or UI-redress —
        // the link text still renders, just non-tappable.
        for run in attributed.runs where run.link != nil {
            attributed[run.range].link = nil
        }
        return attributed
    }
}
