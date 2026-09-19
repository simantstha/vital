import SwiftUI

/// Pushed from `MemoryView`'s People card. `fallbackLabel`/`fallbackKind`
/// come from the summary row so the header can render instantly instead of
/// blank while `fetchEntityDocument` is in flight.
struct EntityDocumentView: View {
    let entityId: String
    let fallbackLabel: String
    let fallbackKind: String

    @StateObject private var vm = EntityDocumentViewModel()

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    header

                    if vm.isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.top, 80)
                            .motionTransition(.fade)
                    } else if let errorMessage = vm.errorMessage {
                        ErrorCard(title: "Couldn't load", message: errorMessage) {
                            Task {
                                vm.errorMessage = nil
                                await vm.load(id: entityId)
                            }
                        }
                        .motionTransition(.fade)
                    } else if let document = vm.document {
                        Group {
                            // The safety-critical piece: a fact about someone
                            // else must never read as a fact about the user.
                            // Omitted entirely when `isSelf` — the backend
                            // shouldn't route the user's own document through
                            // this screen, but the check is defensive either way.
                            if !document.isSelf {
                                CautionBanner(
                                    title: "About \(document.label), not you",
                                    message: "These facts are recorded about \(document.label) — they aren't applied as your own health constraints, and are only used where they bear on your own care, such as inherited risk."
                                )
                            }

                            if document.facts.isEmpty {
                                emptyFactsCard(label: document.label)
                            } else {
                                ForEach(EntityDocumentViewModel.groupFactsByType(document.facts)) { group in
                                    factGroupSection(group, entityLabel: document.label)
                                }
                            }
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
        .task { await vm.load(id: entityId) }
    }
}

// MARK: - Private sub-views

private extension EntityDocumentView {

    var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(vm.document?.label ?? fallbackLabel)
                .screenTitleStyle()
                .foregroundStyle(Theme.Colors.textPrimary)

            if let document = vm.document {
                Text("\(document.kind) · \(document.facts.count == 1 ? "1 fact" : "\(document.facts.count) facts")")
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textSecondary)
            } else {
                Text(fallbackKind)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    func emptyFactsCard(label: String) -> some View {
        VitalCard {
            Text("Nothing recorded about \(label) yet — facts appear here as they come up in chat.")
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    func factGroupSection(_ group: EntityDocumentViewModel.FactGroup, entityLabel: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: group.type)

            VStack(spacing: Theme.Spacing.md) {
                ForEach(group.facts) { fact in
                    factRow(fact, entityLabel: entityLabel)
                }
            }
        }
    }

    func factRow(_ fact: EntityFact, entityLabel: String) -> some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                    Text(fact.label)
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)

                    Spacer(minLength: Theme.Spacing.sm)

                    Chip(text: "About \(entityLabel)")
                }

                Text("\u{201C}\(fact.evidence)\u{201D}")
                    .font(Theme.Typography.bodySmall.italic())
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: Theme.Spacing.sm) {
                    Chip(
                        text: EntityDocumentViewModel.sourceBadgeText(fact.source),
                        isAccent: fact.source == "confirmed"
                    )

                    Spacer()

                    Text(EntityDocumentViewModel.dateLabel(fromISO: fact.createdAt))
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
        }
    }
}
