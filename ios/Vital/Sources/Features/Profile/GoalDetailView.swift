import SwiftUI

/// Pushed from Profile → "Goal". The mock's dedicated Goal page: the coach
/// recommendation, a radio list of the four goals, the per-goal "What this
/// means" facts, and a card-button into the Coach tab. Goal editing moved
/// here from `DietBudgetEditorView` (Phase 9) — the budget editor keeps only
/// the numbers.
struct GoalDetailView: View {
    let switchToCoachTab: () -> Void

    @StateObject private var vm = DietBudgetViewModel()

    /// Radio-list rows in fixed display order, with the mock's subtitles.
    private static let goalSubtitles: [(id: String, subtitle: String)] = [
        ("weight_loss", "Calorie deficit, hold muscle"),
        ("muscle",      "Strength & size focus"),
        ("endurance",   "Train for distance"),
        ("general",     "Balanced, steady maintenance"),
    ]

    /// Static per-goal facts — moved verbatim from DietBudgetEditorView.
    private static let goalFacts: [String: [String]] = [
        "weight_loss": [
            "Moderate calorie deficit calculated from your weight trend",
            "Protein set high to preserve muscle while losing fat",
            "Budget tightens gradually, never a crash diet",
        ],
        "muscle": [
            "Calorie surplus sized to your training volume",
            "Protein set high to support muscle growth",
            "Carbs scaled to fuel strength sessions",
        ],
        "endurance": [
            "Higher carb targets on training days",
            "Protein set to preserve muscle through mileage",
            "Budget adapts to workout burn",
        ],
        "general": [
            "Calories set to maintain your current weight",
            "Balanced macros for everyday energy",
            "Budget adjusts gently with activity",
        ],
    ]

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            if vm.isLoading {
                ProgressView()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        Text("Goal")
                            .screenTitleStyle()
                            .foregroundStyle(Theme.Colors.textPrimary)

                        if vm.goal != "endurance" {
                            coachRecommendsCard
                        }

                        radioListCard
                        whatThisMeansCard
                        coachButtonCard

                        if let msg = vm.errorMessage {
                            Text(msg)
                                .font(Theme.Typography.bodySmall)
                                .foregroundStyle(Theme.Colors.alert)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.top, Theme.Spacing.xl)
                    .padding(.bottom, 40)
                }
                .scrollIndicators(.hidden)
            }
        }
        // Pushed screen — keep the nav bar (and swipe-back) working, same
        // idiom as DevicesView.
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.Colors.canvas, for: .navigationBar)
        .task { await vm.load() }
    }

    // ── Coach recommends (moved from DietBudgetEditorView, unchanged) ────────

    private var coachRecommendsCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("COACH RECOMMENDS")
                .font(.system(size: 11, weight: .bold))
                .tracking(1.0)
                .foregroundStyle(Theme.Colors.accentContent)

            Text("Endurance")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)

            Text("You're training for a marathon — endurance fueling supports your mileage.")
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)

            Button {
                vm.setGoal("endurance")
            } label: {
                Text("Use this goal")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Colors.onAccent)
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.vertical, Theme.Spacing.sm)
                    .background(Capsule().fill(Theme.Colors.accent))
            }
            .buttonStyle(.plain)
            .padding(.top, Theme.Spacing.xs)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.lg)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(Theme.Colors.accentSoft)
        )
    }

    // ── Radio list (mock's PRadio) ────────────────────────────────────────────

    private var radioListCard: some View {
        VitalCard(padding: 0) {
            VStack(spacing: 0) {
                ForEach(Array(Self.goalSubtitles.enumerated()), id: \.element.id) { index, entry in
                    radioRow(index: index, id: entry.id, subtitle: entry.subtitle)
                }
            }
        }
    }

    private func radioRow(index: Int, id: String, subtitle: String) -> some View {
        let selected = vm.goal == id
        return Button {
            vm.setGoal(id)
        } label: {
            HStack(spacing: Theme.Spacing.md) {
                ZStack {
                    Circle()
                        .strokeBorder(
                            selected ? Theme.Colors.accentContent : Theme.Colors.textTertiary,
                            lineWidth: selected ? 6 : 1.5
                        )
                        .frame(width: 20, height: 20)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(DietBudgetViewModel.goalLabels[id] ?? id)
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(subtitle)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }

                Spacer()
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) {
            if index > 0 {
                Rectangle()
                    .fill(Theme.Colors.glassBorder)
                    .frame(height: 0.5)
            }
        }
    }

    // ── What this means (moved from DietBudgetEditorView) ────────────────────

    private var whatThisMeansCard: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text("WHAT THIS MEANS")
                    .font(.system(size: 11, weight: .bold))
                    .tracking(1.0)
                    .foregroundStyle(Theme.Colors.textSecondary)

                ForEach(Self.goalFacts[vm.goal] ?? [], id: \.self) { fact in
                    HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.Colors.accentContent)
                            .padding(.top, 2)
                        Text(fact)
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textPrimary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // ── Talk it through with your coach ──────────────────────────────────────

    private var coachButtonCard: some View {
        Button {
            switchToCoachTab()
        } label: {
            VitalCard {
                HStack(spacing: Theme.Spacing.md) {
                    IconBadge(systemName: "message", style: .soft)

                    Text("Talk it through with your coach")
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
        }
        .buttonStyle(.plain)
    }
}
