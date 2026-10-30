import SwiftUI

/// A small, reusable "What is this?" explainer: an info button that opens a
/// popover with one plain-English sentence. Copy lives in one place,
/// `MetricExplainer` (MetricCatalog.swift) — callers pass
/// `MetricExplainer.explanation(for:)` and render nothing when it is `nil`.
///
/// Do NOT place this inside another `Button`'s label (e.g. a tappable row):
/// nested buttons fight over the tap. For those, use `WhatMovedExplainer`'s
/// disclosure pattern instead.
struct WhatIsThisButton: View {
    /// Display name of the thing being explained ("HRV") — used for the
    /// VoiceOver label only.
    let title: String
    let text: String
    /// `true` renders the "What is this?" text beside the icon (metric
    /// detail); `false` is the icon alone, for tight spaces (Today tiles).
    var showsLabel: Bool = false

    @State private var isPresented = false

    var body: some View {
        Button {
            isPresented = true
        } label: {
            if showsLabel {
                HStack(spacing: 4) {
                    Image(systemName: "info.circle")
                    Text("What is this?")
                }
                .scaledFont(size: 12.5, weight: .medium)
                .padding(.vertical, 4)
            } else {
                Image(systemName: "info.circle")
                    .font(.system(size: 13, weight: .medium))
                    .frame(minWidth: 24, minHeight: 24)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.Colors.textSecondary)
        .popover(isPresented: $isPresented) {
            Text(text)
                .scaledFont(size: 14)
                .foregroundStyle(Theme.Colors.textPrimary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(Theme.Spacing.lg)
                .frame(maxWidth: 300, alignment: .leading)
                .presentationCompactAdaptation(.popover)
        }
        .accessibilityLabel("What is \(title)?")
        .accessibilityHint(text)
    }
}

/// "What do these mean?" disclosure for card rows that are themselves
/// tappable (Trends' "What moved"): one expandable list of every shown
/// metric's one-sentence explanation, so no per-row button has to nest
/// inside the row's own navigation `Button`.
struct WhatMovedExplainer: View {
    /// Raw metric keys in display order; keys without a catalog explanation
    /// are skipped.
    let metricKeys: [String]

    @State private var isExpanded = false

    private var entries: [(name: String, text: String)] {
        metricKeys.compactMap { key in
            guard let text = MetricExplainer.explanation(for: key) else { return nil }
            return (MetricCatalog.spec(for: key)?.displayName ?? key, text)
        }
    }

    var body: some View {
        if !entries.isEmpty {
            DisclosureGroup("What do these mean?", isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.name)
                                .scaledFont(size: 12.5, weight: .semibold)
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Text(entry.text)
                                .scaledFont(size: 12.5)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, Theme.Spacing.xs)
            }
            .scaledFont(size: 13, weight: .semibold)
            .tint(Theme.Colors.textPrimary)
        }
    }
}
