import Foundation

extension String {
    /// Parses inline markdown (**bold**, *italic*, `code`, links) into an
    /// AttributedString, preserving whitespace and newlines. Coach/brief text
    /// from Claude is markdown, so render it through this instead of showing
    /// raw `**` markers. Falls back to plain text if parsing fails.
    var asMarkdown: AttributedString {
        (try? AttributedString(
            markdown: self,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        )) ?? AttributedString(self)
    }
}
