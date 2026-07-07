import SwiftUI

/// Block-level markdown renderer for coach/brief text.
///
/// SwiftUI's `Text(_: AttributedString)` only lays out *inline* markdown, so a
/// reply like "Here are 3 tips:\n- Sleep\n- Hydrate\n- Walk" collapses into a
/// run-on line. `MarkdownText` splits the string into block elements
/// (paragraphs and bullet / numbered list items) and stacks them, rendering
/// each block's inline markdown through the existing `String.asMarkdown`
/// (which also strips links for safety — that still applies here).
struct MarkdownText: View {
    let markdown: String
    var lineSpacing: CGFloat = 3

    private var blocks: [MarkdownBlock] { MarkdownBlock.parse(markdown) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            ForEach(blocks) { block in
                switch block.kind {
                case .paragraph:
                    Text(block.text.asMarkdown)
                        .lineSpacing(lineSpacing)
                        .fixedSize(horizontal: false, vertical: true)

                case .listItem(let marker):
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                        Text(marker)
                            .monospacedDigit()
                        Text(block.text.asMarkdown)
                            .lineSpacing(lineSpacing)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }
}

// MARK: - Block parsing

/// A single rendered block: either a paragraph or a list item with a leading
/// marker glyph ("•" for bullets, "1." for ordered items).
private struct MarkdownBlock: Identifiable {
    enum Kind: Equatable {
        case paragraph
        case listItem(marker: String)
    }

    let id = UUID()
    let kind: Kind
    let text: String

    /// Splits raw markdown into blocks. Consecutive non-list lines coalesce into
    /// one paragraph (so wrapped prose stays together); each `- `/`* `/`N. ` line
    /// becomes its own list item. Blank lines break paragraphs.
    static func parse(_ raw: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraphLines: [String] = []

        func flushParagraph() {
            let joined = paragraphLines.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !joined.isEmpty {
                blocks.append(MarkdownBlock(kind: .paragraph, text: joined))
            }
            paragraphLines.removeAll()
        }

        for rawLine in raw.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)

            if line.isEmpty {
                flushParagraph()
                continue
            }

            if let item = listItem(from: line) {
                flushParagraph()
                blocks.append(item)
            } else {
                paragraphLines.append(line)
            }
        }
        flushParagraph()
        return blocks
    }

    /// Recognizes `- `, `* `, `+ ` (bullets) and `1. ` / `1) ` (ordered) prefixes.
    /// Returns nil for a normal prose line.
    private static func listItem(from line: String) -> MarkdownBlock? {
        // Bullets
        for bullet in ["- ", "* ", "+ "] where line.hasPrefix(bullet) {
            let body = String(line.dropFirst(bullet.count)).trimmingCharacters(in: .whitespaces)
            return MarkdownBlock(kind: .listItem(marker: "•"), text: body)
        }

        // Ordered: leading digits followed by "." or ")"
        let digits = line.prefix { $0.isNumber }
        if !digits.isEmpty {
            let afterDigits = line.dropFirst(digits.count)
            if afterDigits.hasPrefix(". ") || afterDigits.hasPrefix(") ") {
                let body = String(afterDigits.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                return MarkdownBlock(kind: .listItem(marker: "\(digits)."), text: body)
            }
        }

        return nil
    }
}
