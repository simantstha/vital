import UIKit

/// Helper for preparing text from chat messages for clipboard copying.
enum ChatCopy {
    /// Strips markdown formatting from text for clean pasting.
    /// - Removes `**`, `__`, and backticks
    /// - Converts leading `- ` or `* ` bullets to `• `
    /// - Trims whitespace
    nonisolated static func copyableText(_ markdown: String) -> String {
        var text = markdown

        // Remove bold markers: ** and __
        text = text.replacingOccurrences(of: "**", with: "")
        text = text.replacingOccurrences(of: "__", with: "")

        // Remove backticks (inline code)
        text = text.replacingOccurrences(of: "`", with: "")

        // Convert markdown bullets to bullet point
        // Match leading - or * with optional horizontal whitespace
        // (?m) enables multiline mode so ^ matches each line, [ \t] matches only spaces/tabs (not newlines)
        text = text.replacingOccurrences(of: #"(?m)^[ \t]*[-*][ \t]+"#, with: "• ", options: .regularExpression)

        // Trim whitespace
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)

        return text
    }
}
