import SwiftUI

/// Block-level markdown renderer for coach/brief text.
///
/// SwiftUI's `Text(_: AttributedString)` only lays out *inline* markdown, so a
/// reply like "Here are 3 tips:\n- Sleep\n- Hydrate\n- Walk" collapses into a
/// run-on line. `MarkdownText` splits the string into block elements
/// (paragraphs, bullet / numbered list items, and GFM tables) and stacks them,
/// rendering each block's inline markdown through the existing `String.asMarkdown`
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

                case .table(let header, let rows):
                    TableBlockView(header: header, rows: rows)
                }
            }
        }
    }
}

// MARK: - Table rendering

/// Renders a GFM table as a real grid inside a horizontal scroll view, so wide
/// tables (e.g. a week of HRV/RHR) stay readable instead of collapsing into raw
/// `| Date | HRV |` pipe text. Cells still render inline markdown via `asMarkdown`.
private struct TableBlockView: View {
    let header: [String]
    let rows: [[String]]

    private var columnCount: Int { header.count }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: Alignment(horizontal: .leading, vertical: .firstTextBaseline),
                 horizontalSpacing: Theme.Spacing.lg,
                 verticalSpacing: Theme.Spacing.xs) {
                GridRow {
                    ForEach(0..<columnCount, id: \.self) { c in
                        Text(header[c].asMarkdown)
                            .font(Theme.Typography.labelMedium)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Divider()
                    .gridCellColumns(columnCount)

                ForEach(rows.indices, id: \.self) { r in
                    GridRow {
                        ForEach(0..<columnCount, id: \.self) { c in
                            Text((c < rows[r].count ? rows[r][c] : "").asMarkdown)
                                .font(Theme.Typography.bodySmall)
                                .foregroundStyle(Theme.Colors.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(.vertical, Theme.Spacing.xs)
        }
    }
}

// MARK: - Block parsing

/// A single rendered block: a paragraph, a list item with a leading marker
/// glyph ("•" for bullets, "1." for ordered items), or a GFM table.
private struct MarkdownBlock: Identifiable {
    enum Kind: Equatable {
        case paragraph
        case listItem(marker: String)
        case table(header: [String], rows: [[String]])
    }

    let id = UUID()
    let kind: Kind
    /// Body for paragraph / list item; empty for tables (they carry their cells
    /// in the `.table` case payload).
    let text: String

    init(kind: Kind, text: String = "") {
        self.kind = kind
        self.text = text
    }

    /// Splits raw markdown into blocks. A `|`-delimited row immediately followed
    /// by a `---` delimiter row starts a table (consumed greedily). Consecutive
    /// non-list, non-table lines coalesce into one paragraph (so wrapped prose
    /// stays together); each `- `/`* `/`N. ` line becomes its own list item.
    /// Blank lines break paragraphs.
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

        let lines = raw.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let line = lines[i].trimmingCharacters(in: .whitespaces)

            // Table: a header row (contains "|") followed by a delimiter row.
            if line.contains("|"),
               i + 1 < lines.count,
               isDelimiterRow(lines[i + 1]) {
                let header = splitRow(line)
                if !header.isEmpty {
                    flushParagraph()
                    var rows: [[String]] = []
                    var j = i + 2
                    while j < lines.count {
                        let bodyLine = lines[j].trimmingCharacters(in: .whitespaces)
                        guard !bodyLine.isEmpty, bodyLine.contains("|") else { break }
                        rows.append(splitRow(bodyLine))
                        j += 1
                    }
                    blocks.append(MarkdownBlock(kind: .table(header: header, rows: rows)))
                    i = j
                    continue
                }
            }

            if line.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            if let item = listItem(from: line) {
                flushParagraph()
                blocks.append(item)
            } else {
                paragraphLines.append(line)
            }
            i += 1
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

    // MARK: Table helpers

    /// Splits a `| a | b | c |` row into trimmed cells, dropping the empty cells
    /// produced by leading / trailing pipes.
    private static func splitRow(_ rawLine: String) -> [String] {
        var s = rawLine.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// True for a GFM delimiter row like `|---|:--:|---:|` — every cell is dashes
    /// with optional leading / trailing alignment colons and at least one dash.
    private static func isDelimiterRow(_ rawLine: String) -> Bool {
        let cells = splitRow(rawLine)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            var body = cell
            if body.hasPrefix(":") { body.removeFirst() }
            if body.hasSuffix(":") { body.removeLast() }
            return !body.isEmpty && body.allSatisfy { $0 == "-" }
        }
    }
}
