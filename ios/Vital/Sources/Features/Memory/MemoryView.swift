import SwiftUI

/// Pushed from Profile → "Memory" (`NavigationLink` push, matching every
/// other Profile destination — see `ProfileView.settingsLink`). Shows what
/// the ontology has learned about the user ("About you"), everyone else it
/// has learned about ("People"), and anything still awaiting the user's
/// confirmation — the last section reuses `fetchPendingFacts()` /
/// `resolvePendingFact(id:action:)` verbatim, no new endpoints.
struct MemoryView: View {
    @StateObject private var vm = MemoryViewModel()

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    headerSection

                    if vm.isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.top, 80)
                            .motionTransition(.fade)
                    } else if let errorMessage = vm.errorMessage {
                        ErrorCard(title: "Couldn't load memory", message: errorMessage) {
                            Task {
                                vm.errorMessage = nil
                                await vm.load()
                            }
                        }
                        .motionTransition(.fade)
                    } else {
                        Group {
                            if !vm.pendingFacts.isEmpty {
                                pendingFactsSection
                            }
                            aboutYouCard
                            peopleSection
                        }
                        .motionTransition(.fade)
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.lg)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.Colors.canvas, for: .navigationBar)
        .task { await vm.load() }
        .toast(message: $vm.toastMessage)
    }
}

// MARK: - Private sub-views

private extension MemoryView {

    // ── Screen title ─────────────────────────────────────────────────────

    var headerSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Memory")
                .screenTitleStyle()
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("What Vital has learned about you.")
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // ── About you ────────────────────────────────────────────────────────

    var aboutYouCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "About you")

            VitalCard {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    Text(vm.selfFactCount == 1 ? "1 fact" : "\(vm.selfFactCount) facts")
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)

                    if vm.selfFacts.isEmpty {
                        Text("Nothing learned yet — facts appear here as you chat with your coach.")
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    } else {
                        FlowLayout(spacing: Theme.Spacing.sm) {
                            ForEach(vm.selfFacts) { fact in
                                MemoryFactChip(fact: fact)
                            }
                        }
                    }
                }
            }
        }
    }

    // ── People ───────────────────────────────────────────────────────────

    var peopleSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "People")

            if vm.entities.isEmpty {
                VitalCard {
                    Text("No one else yet — people you mention to your coach show up here.")
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                VitalCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(vm.entities.enumerated()), id: \.element.id) { index, entity in
                            NavigationLink {
                                EntityDocumentView(
                                    entityId: entity.id,
                                    fallbackLabel: entity.label,
                                    fallbackKind: entity.kind
                                )
                            } label: {
                                entityRow(entity)
                            }
                            .buttonStyle(.plain)
                            .overlay(alignment: .top) { if index > 0 { rowHairline } }
                        }
                    }
                }
            }
        }
    }

    func entityRow(_ entity: MemoryEntitySummary) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            Circle()
                .fill(Theme.Colors.glassFill)
                .frame(width: 40, height: 40)
                .overlay(
                    Text(entity.label.prefix(1).uppercased())
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(Theme.Colors.textSecondary)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(entity.label)
                    .font(Theme.Typography.bodyMedium)
                    .fontWeight(.medium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(entity.kind)
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }

            Spacer(minLength: Theme.Spacing.sm)

            Text(entity.factCount == 1 ? "1 fact" : "\(entity.factCount) facts")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(1)

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .contentShape(Rectangle())
    }

    var rowHairline: some View {
        Rectangle()
            .fill(Theme.Colors.glassBorder)
            .frame(height: 0.5)
    }

    // ── Needs your confirmation ─────────────────────────────────────────

    var pendingFactsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Needs your confirmation")

            VStack(spacing: Theme.Spacing.md) {
                ForEach(vm.pendingFacts) { fact in
                    pendingFactCard(fact)
                }
            }
        }
    }

    func pendingFactCard(_ fact: PendingFact) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Colors.caution)
                    .accessibilityHidden(true)
                Text("Vital noticed")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.caution)
                    .tracking(0.6)
                Spacer()
            }

            Text(fact.proposedNode.label)
                .font(Theme.Typography.bodyMedium)
                .fontWeight(.medium)
                .foregroundStyle(Theme.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: Theme.Spacing.sm) {
                Button {
                    Task { await vm.resolveFact(id: fact.id, action: "confirm") }
                } label: {
                    Text("Confirm")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Theme.Colors.accent)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
                }

                Button {
                    Task { await vm.resolveFact(id: fact.id, action: "reject") }
                } label: {
                    Text("Dismiss")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Theme.Colors.glassFill)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                .strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                        )
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(Theme.Colors.cautionSoft)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                        .strokeBorder(Theme.Colors.cautionLine, lineWidth: 1)
                )
        )
    }
}

// MARK: - Fact chip

/// One "About you" chip. `isConstraint` facts (e.g. an allergy) get a
/// lime-bordered treatment distinct from ordinary notes, signalling they're
/// binding on the user's own guidance rather than just background context.
private struct MemoryFactChip: View {
    let fact: MemoryFact

    var body: some View {
        Text(fact.label)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(fact.isConstraint ? Theme.Colors.accentContent : Theme.Colors.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                Capsule()
                    .fill(fact.isConstraint ? Theme.Colors.accentSoft : Theme.Colors.glassFill)
                    .overlay(
                        Capsule()
                            .strokeBorder(
                                fact.isConstraint ? Theme.Colors.accentContent : .clear,
                                lineWidth: fact.isConstraint ? 1 : 0
                            )
                    )
            )
    }
}

// MARK: - Flow layout

/// A minimal left-to-right, top-to-bottom wrapping layout for the fact
/// chips — SwiftUI has no built-in wrapping `HStack`, and chip label
/// lengths are unpredictable (backend-supplied fact text).
private struct FlowLayout: Layout {
    var spacing: CGFloat = Theme.Spacing.sm

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth > 0, rowWidth + spacing + size.width > maxWidth {
                totalHeight += rowHeight + spacing
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += (rowWidth > 0 ? spacing : 0) + size.width
            rowHeight = max(rowHeight, size.height)
        }
        totalHeight += rowHeight
        return CGSize(width: maxWidth.isFinite ? maxWidth : rowWidth, height: totalHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
