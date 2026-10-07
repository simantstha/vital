import Foundation
import SwiftUI

/// Pushed from Profile → "Memory" (`NavigationLink` push, matching every
/// other Profile destination — see `ProfileView.settingsLink`). The
/// redesigned Memory screen (memory-contract.md §4): a client-side search
/// over facts and people, a "Did I get this right?" confirmation card,
/// facts grouped into Health / Goals / Routines & preferences / Food /
/// Other, and People — pushing to the existing `EntityDocumentView`.
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
                            searchField

                            if !vm.pendingFacts.isEmpty {
                                pendingFactsSection
                            }

                            if let goal = vm.goalSummary {
                                goalSection(goal)
                            }

                            ForEach(vm.groupedSections) { section in
                                factSection(section)
                            }

                            if !vm.filteredEntities.isEmpty {
                                peopleSection
                            }

                            if vm.groupedSections.isEmpty && vm.filteredEntities.isEmpty {
                                emptyStateCard
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
        .task { await vm.load() }
        .toast(message: $vm.toastMessage)
        .sheet(item: $vm.editingFact) { fact in
            EditFactSheet(fact: fact) { newLabel in
                Task { await vm.saveEdit(fact: fact, newLabel: newLabel) }
            }
        }
        .confirmationDialog(
            forgetDialogTitle,
            isPresented: forgetDialogPresented,
            titleVisibility: .visible,
            presenting: vm.factPendingForget
        ) { fact in
            Button("Forget", role: .destructive) {
                Task { await vm.forget(fact) }
            }
            Button("Cancel", role: .cancel) {
                vm.factPendingForget = nil
            }
        } message: { _ in
            Text("Your coach won't use it anymore.")
        }
    }

    /// "Forget “<label>”?" — the confirmation dialog's title. Empty (never
    /// actually shown) once `factPendingForget` clears back to `nil`.
    private var forgetDialogTitle: String {
        guard let label = vm.factPendingForget?.label else { return "" }
        return "Forget \u{201C}\(label)\u{201D}?"
    }

    /// `confirmationDialog(_:isPresented:...)` wants a plain `Bool` binding —
    /// this derives one from `factPendingForget` so dismissing the dialog any
    /// way (swipe, the system's own Cancel) clears the source-of-truth field
    /// on `vm` too.
    private var forgetDialogPresented: Binding<Bool> {
        Binding(
            get: { vm.factPendingForget != nil },
            set: { isPresented in if !isPresented { vm.factPendingForget = nil } }
        )
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
            Text(vm.headerSubline)
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // ── Search ───────────────────────────────────────────────────────────

    var searchField: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
            TextField("Search memory", text: $vm.searchText)
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textPrimary)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .frame(height: 40)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                .fill(Theme.Colors.glassFill)
        )
    }

    // ── "Did I get this right?" ─────────────────────────────────────────

    var pendingFactsSection: some View {
        VStack(spacing: Theme.Spacing.md) {
            ForEach(vm.pendingFacts) { fact in
                pendingFactCard(fact)
            }
        }
    }

    func pendingFactCard(_ fact: PendingFact) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                GroupIconBadge(systemName: "sparkle")
                Text("DID I GET THIS RIGHT?")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.6)
                    .foregroundStyle(Theme.Colors.textSecondary)
                Spacer()
            }

            Text(fact.proposedNode.label)
                .font(Theme.Typography.bodyLarge)
                .fontWeight(.semibold)
                .foregroundStyle(Theme.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Text(MemoryLogic.pendingReasonText(fact.reason))
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)

            HStack(spacing: Theme.Spacing.sm) {
                Button {
                    Task { await vm.resolveFact(id: fact.id, action: "confirm") }
                } label: {
                    Text("Yes, remember")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Theme.Colors.accent)
                        .clipShape(Capsule())
                }

                Button {
                    Task { await vm.resolveFact(id: fact.id, action: "reject") }
                } label: {
                    Text("Not quite")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Theme.Colors.glassFill)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule().strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                        )
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(Theme.Colors.card)
        )
    }

    // ── Goal (read-only, owned by Profile) ───────────────────────────────

    /// The user's goal comes from the profile — the one place it's edited —
    /// so Memory never carries a second, free-text copy that can disagree.
    func goalSection(_ goal: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                GroupIconBadge(systemName: "target")
                Text("Goals")
                    .font(Theme.Typography.bodyLarge)
                    .fontWeight(.bold)
                    .foregroundStyle(Theme.Colors.textPrimary)
            }
            .padding(.horizontal, Theme.Spacing.xs)

            VitalCard {
                HStack(spacing: Theme.Spacing.md) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(goal)
                            .font(Theme.Typography.bodyMedium)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("Set in Profile")
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Button("Edit in Profile") {
                        NotificationCenter.default.post(name: .vitalOpenGoalEditor, object: nil)
                    }
                    .font(Theme.Typography.labelSmall)
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.accentContent)
                    .accessibilityIdentifier("memory.goal.edit")
                }
            }
        }
    }

    // ── Fact groups ──────────────────────────────────────────────────────

    func factSection(_ section: MemoryLogic.Section) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            groupHeader(section)

            VitalCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(section.facts.enumerated()), id: \.element.id) { index, fact in
                        FactRow(
                            fact: fact,
                            onEdit: { vm.startEdit(fact) },
                            onForget: { vm.confirmForget(fact) }
                        )
                        .padding(.horizontal, Theme.Spacing.lg)
                        .overlay(alignment: .top) { if index > 0 { rowHairline } }
                    }
                }
            }
        }
    }

    func groupHeader(_ section: MemoryLogic.Section) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            GroupIconBadge(systemName: groupIcon(section.group))
            Text(section.group.title)
                .font(Theme.Typography.bodyLarge)
                .fontWeight(.bold)
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("\(section.facts.count)")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .padding(.horizontal, Theme.Spacing.xs)
    }

    func groupIcon(_ group: MemoryLogic.Group) -> String {
        switch group {
        case .health:   return "heart.fill"
        case .routines: return "clock"
        case .food:     return "fork.knife"
        case .other:    return "ellipsis.circle"
        }
    }

    // ── People ───────────────────────────────────────────────────────────

    var peopleSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                GroupIconBadge(systemName: "person.2.fill")
                Text("People")
                    .font(Theme.Typography.bodyLarge)
                    .fontWeight(.bold)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("\(vm.filteredEntities.count)")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            .padding(.horizontal, Theme.Spacing.xs)

            VitalCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(vm.filteredEntities.enumerated()), id: \.element.id) { index, entity in
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

    // ── Empty state ──────────────────────────────────────────────────────

    var emptyStateCard: some View {
        VitalCard {
            Text(
                vm.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "Nothing learned yet — facts appear here as you chat with your coach."
                    : "No matches for \u{201C}\(vm.searchText)\u{201D}."
            )
            .font(Theme.Typography.bodySmall)
            .foregroundStyle(Theme.Colors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    var rowHairline: some View {
        Rectangle()
            .fill(Theme.Colors.glassBorder)
            .frame(height: 0.5)
    }
}

// MARK: - Group icon badge

/// A small purple-tinted icon badge for a group header or the pending-fact
/// card — `Theme.Colors.memory`/`memorySoft` (memory-contract.md §4).
private struct GroupIconBadge: View {
    let systemName: String

    var body: some View {
        Circle()
            .fill(Theme.Colors.memorySoft)
            .frame(width: 24, height: 24)
            .overlay(
                Image(systemName: systemName)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Colors.memory)
            )
    }
}

// MARK: - Fact row

/// One fact row: label (+ an "Always avoid" tag when `isConstraint`), the
/// origin/date secondary line, and a "…" menu with Edit/Forget. The label
/// and secondary line are one accessibility element reading "label, origin
/// line"; the menu button carries its own "More for <label>" label
/// (memory-contract.md §4), matching the mock's `aria-label`.
private struct FactRow: View {
    let fact: MemoryFact
    let onEdit: () -> Void
    let onForget: () -> Void

    private var sourceLine: String {
        MemoryLogic.sourceLine(origin: fact.origin, recordedAt: fact.recordedAt)
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Spacing.sm) {
                    Text(fact.label)
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    if fact.isConstraint {
                        ConstraintTag()
                    }
                }
                Text(sourceLine)
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(fact.label), \(sourceLine)")

            Spacer(minLength: Theme.Spacing.sm)

            Menu {
                Button("Edit", action: onEdit)
                Button("Forget", role: .destructive, action: onForget)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("More for \(fact.label)")
        }
        .padding(.vertical, Theme.Spacing.sm)
    }
}

/// "Always avoid" — `isConstraint == true`'s tag, using the caution tokens
/// (memory-contract.md §4: "The 'Always avoid' tag uses the caution tokens").
private struct ConstraintTag: View {
    var body: some View {
        Text("Always avoid")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(Theme.Colors.caution)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                Capsule().fill(Theme.Colors.cautionSoft)
            )
    }
}

// MARK: - Edit sheet

/// A text field + Save, disabled while the text is empty or unchanged
/// (memory-contract.md §4). Save is fire-and-forget into `onSave`; the sheet
/// dismisses itself once `MemoryViewModel.saveEdit` clears `editingFact`
/// (the `.sheet(item:)` binding this is presented from), not from a direct
/// `dismiss()` call here.
private struct EditFactSheet: View {
    let fact: MemoryFact
    let onSave: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(fact: MemoryFact, onSave: @escaping (String) -> Void) {
        self.fact = fact
        self.onSave = onSave
        _text = State(initialValue: fact.label)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !trimmed.isEmpty && trimmed != fact.label }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                TextField("Fact", text: $text)
                    .font(Theme.Typography.bodyLarge)
                    .padding(Theme.Spacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                            .fill(Theme.Colors.glassFill)
                    )
                Spacer()
            }
            .padding(Theme.Spacing.xl)
            .background(Theme.Colors.canvas.ignoresSafeArea())
            .navigationTitle("Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(text)
                    }
                    .disabled(!canSave)
                }
            }
        }
    }
}
