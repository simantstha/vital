import SwiftUI

/// Pushed from Profile → "Goal". The mock's dedicated Goal page: the coach
/// recommendation, a radio list of the four goals, the per-goal "What this
/// means" facts, and a card-button into the Coach tab. Goal editing moved
/// here from `DietBudgetEditorView` (Phase 9) — the budget editor keeps only
/// the numbers.
struct GoalDetailView: View {
    let switchToCoachTab: () -> Void

    @StateObject private var vm = DietBudgetViewModel()
    @StateObject private var targets = GoalTargetsViewModel()
    @FocusState private var weightFieldFocused: Bool

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
                    .motionTransition(.fade)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        Text("Goal")
                            .screenTitleStyle()
                            .foregroundStyle(Theme.Colors.textPrimary)

                        radioListCard
                        targetsCard
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
                .motionTransition(.fade)
            }
        }
        // Pushed screen — keep the nav bar (and swipe-back) working, same
        // idiom as DevicesView.
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.Colors.canvas, for: .navigationBar)
        .task {
            await vm.load()
            await targets.load()
        }
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

    // ── Targets (target weight / date / workouts per week / weekly distance) ──

    @ViewBuilder
    private var targetsCard: some View {
        let showWeight = GoalTargetLogic.showsTargetWeight(goal: vm.goal)
        let showSessions = GoalTargetLogic.showsWeeklySessions(goal: vm.goal)
        let showDistance = GoalTargetLogic.showsWeeklyDistance(goal: vm.goal)
        if showWeight || showSessions || showDistance {
            VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    Text("TARGETS")
                        .font(.system(size: 11, weight: .bold))
                        .tracking(1.0)
                        .foregroundStyle(Theme.Colors.textSecondary)

                    if let started = targets.startedLine {
                        Text(started)
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }

                    if showWeight {
                        targetWeightRow
                        targetDateRow
                    }
                    if showDistance {
                        weeklyDistanceRow
                    }
                    if showSessions {
                        weeklySessionsRow
                    }

                    if let msg = targets.errorMessage {
                        Text(msg)
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.alert)
                    }

                    Button {
                        weightFieldFocused = false
                        Task { await targets.save() }
                    } label: {
                        HStack {
                            if targets.isSaving {
                                ProgressView().tint(Theme.Colors.onAccent)
                            } else {
                                Text("Save targets")
                                    .font(.system(size: 16, weight: .semibold))
                            }
                        }
                        .foregroundStyle(Theme.Colors.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Theme.Colors.accent)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                    }
                    .opacity(targets.canSave ? 1.0 : 0.4)
                    .disabled(!targets.canSave)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var targetWeightRow: some View {
        let units = UnitPreference.shared.current
        return VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack {
                Text("Target weight")
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                TextField("None", text: $targets.targetWeightText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .focused($weightFieldFocused)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(width: 90)
                Text(units.weightUnit)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            if let error = targets.weightError {
                Text(error)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.alert)
            } else if let warning = GoalTargetLogic.sanityWarning(
                goal: vm.goal,
                currentKg: targets.currentWeightKg,
                targetKg: targets.targetKg,
                targetDate: targets.hasTargetDate ? targets.targetDate : nil,
                units: units
            ) {
                Text(warning)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.caution)
            } else if GoalTargetLogic.isLossGoal(vm.goal),
                      let hint = GoalTargetLogic.paceHint(
                        currentKg: targets.currentWeightKg, targetKg: targets.targetKg, units: units
                      ) {
                Text(hint)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
    }

    private var targetDateRow: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Toggle("Target date", isOn: $targets.hasTargetDate)
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textPrimary)
                .tint(Theme.Colors.accent)
            if targets.hasTargetDate {
                DatePicker(
                    "", selection: $targets.targetDate,
                    in: GoalTargetLogic.targetDateRange(), displayedComponents: .date
                )
                .datePickerStyle(.compact)
                .labelsHidden()
                .tint(Theme.Colors.accentContent)
            }
        }
    }

    /// Endurance: the measurable weekly target the goal card tracks
    /// ("24.5 of 30 km this week"). Unit-aware; empty = no distance target.
    private var weeklyDistanceRow: some View {
        let units = UnitPreference.shared.current
        return VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack {
                Text("Weekly distance")
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                TextField("None", text: $targets.weeklyDistanceText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .focused($weightFieldFocused)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(width: 90)
                    .accessibilityIdentifier("goal.weeklyDistanceField")
                Text("\(units.distanceUnit)/week")
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            if let error = targets.distanceError {
                Text(error)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.alert)
            }
        }
    }

    private var weeklySessionsRow: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Toggle("Weekly workout goal", isOn: $targets.hasWeeklySessions)
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textPrimary)
                .tint(Theme.Colors.accent)
            if targets.hasWeeklySessions {
                Stepper(value: $targets.weeklySessions,
                        in: GoalTargetLogic.minWeeklySessions...GoalTargetLogic.maxWeeklySessions) {
                    Text("\(targets.weeklySessions) \(targets.weeklySessions == 1 ? "workout" : "workouts") per week")
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                }
                .tint(Theme.Colors.accentContent)
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
