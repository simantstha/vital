import SwiftUI

// MARK: - TodayView

struct TodayView: View {
    @StateObject private var vm = TodayViewModel()
    @State private var showLogSheet = false

    var body: some View {
        ZStack(alignment: .top) {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    greetingSection
                    // Gate the data-bearing content so a fresh launch shows a
                    // spinner instead of a flash of stale/fake numbers.
                    if vm.isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.top, 60)
                    } else {
                        chipRow
                        pendingFactsBanner
                        CoachBubble(message: vm.coachInsight)
                        metricsGrid
                        dietBudgetCard
                        todaysPlanSection
                        actionButtons
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.lg)
                .padding(.bottom, 100)
            }
            .scrollIndicators(.hidden)
            .task { await vm.loadHealthData() }
        }
        .sheet(isPresented: $showLogSheet) {
            LogMealView()
        }
    }
}

// MARK: - Private sub-views

private extension TodayView {

    // ── Pending-fact banner ──────────────────────────────────────────────────

    @ViewBuilder
    var pendingFactsBanner: some View {
        ForEach(vm.pendingFacts) { fact in
            GlassCard(padding: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    HStack(spacing: Theme.Spacing.sm) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.Colors.accentContent)
                        Text("Vital noticed")
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.accentContent)
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
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm,
                                                            style: .continuous))
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
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm,
                                                            style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.Radius.sm,
                                                     style: .continuous)
                                        .strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                                )
                        }
                    }
                }
            }
        }
    }

    // ── Greeting ────────────────────────────────────────────────────────────

    var greetingSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(vm.greeting)
                .font(.system(size: 28, weight: .bold, design: .default))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text(vm.dateSubtitle)
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
    }

    // ── Chip row ─────────────────────────────────────────────────────────────

    var chipRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Chip(text: vm.dateSubtitle)
            Chip(text: "\(vm.streakDays)-day streak",
                 icon: "flame.fill",
                 isAccent: true)
        }
    }

    // ── Metric tiles ─────────────────────────────────────────────────────────

    var metricsGrid: some View {
        HStack(spacing: Theme.Spacing.sm) {
            MetricTile(
                label: "HRV",
                value: "\(vm.hrv.value)",
                unit: "ms",
                trend: vm.hrv.trend,
                delta: vm.hrv.delta
            )
            MetricTile(
                label: "Sleep",
                value: vm.sleep.formatted,
                unit: "",
                trend: vm.sleep.trend,
                delta: vm.sleep.delta
            )
            MetricTile(
                label: "Resting HR",
                value: "\(vm.restingHR.bpm)",
                unit: "bpm",
                trend: vm.restingHR.trend,
                delta: vm.restingHR.delta
            )
        }
    }

    // ── Diet budget card ──────────────────────────────────────────────────────

    var dietBudgetCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {

                SectionHeader(title: "Diet Budget")

                // Remaining kcal hero number
                HStack(alignment: .lastTextBaseline) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text("\(vm.diet.kcalRemaining)")
                            .font(Theme.Typography.numericHero(38))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("kcal remaining")
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: Theme.Spacing.xxs) {
                        Text("\(vm.diet.kcalTarget)")
                            .font(Theme.Typography.numericSmall(17))
                            .foregroundStyle(Theme.Colors.textSecondary)
                        Text("daily target")
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }

                // Calorie progress bar
                VitalProgressBar(fraction: vm.diet.kcalFraction,
                                 tint: Theme.Colors.accent)

                // Divider
                Rectangle()
                    .fill(Theme.Colors.glassBorder)
                    .frame(height: 0.5)
                    .padding(.vertical, Theme.Spacing.xs)

                // Macro mini-bars
                VStack(spacing: Theme.Spacing.md) {
                    MacroRowView(label: "Protein",
                                 progress: vm.diet.protein,
                                 color: Theme.Colors.accent)
                    MacroRowView(label: "Carbs",
                                 progress: vm.diet.carbs,
                                 color: Theme.Colors.indigo)
                    MacroRowView(label: "Fat",
                                 progress: vm.diet.fat,
                                 color: Theme.Colors.alert)
                }
            }
        }
    }

    // ── Today's plan ─────────────────────────────────────────────────────────

    var todaysPlanSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Today's Plan")
            ForEach(vm.meals) { meal in
                MealRowView(meal: meal)
            }
        }
    }

    // ── Action buttons ────────────────────────────────────────────────────────

    var actionButtons: some View {
        HStack(spacing: Theme.Spacing.md) {
            // Primary — lime filled
            Button {
                showLogSheet = true
            } label: {
                Text("Log it")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Theme.Colors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md,
                                               style: .continuous))
            }

            // Secondary — glass outline
            Button {
                // TODO: suggest lunch
            } label: {
                Text("Suggest lunch")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.md,
                                         style: .continuous)
                            .fill(Theme.Colors.glassFill)
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.Radius.md,
                                                  style: .continuous)
                                    .strokeBorder(Theme.Colors.glassBorder,
                                                  lineWidth: 1)
                            )
                    )
            }
        }
    }
}

// MARK: - Supporting views (file-private)

/// A thin rounded progress bar.
private struct VitalProgressBar: View {
    let fraction: Double
    var tint: Color = Theme.Colors.accent
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(Theme.Colors.glassFill)
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(tint)
                    .frame(width: geo.size.width * fraction)
            }
        }
        .frame(height: height)
    }
}

/// A single macro row: label | mini-bar | consumed / target.
private struct MacroRowView: View {
    let label: String
    let progress: MacroProgress
    let color: Color

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            Text(label)
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 52, alignment: .leading)

            VitalProgressBar(fraction: progress.fraction, tint: color, height: 4)

            Text(progress.consumedLabel)
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 34, alignment: .trailing)
                .monospacedDigit()
        }
    }
}

/// A single meal row card.
private struct MealRowView: View {
    let meal: MealRow

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            // Icon badge
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                    .fill(Theme.Colors.accent.opacity(0.15))
                    .frame(width: 44, height: 44)
                Image(systemName: meal.icon)
                    .font(.system(size: 18))
                    .foregroundStyle(Theme.Colors.accentContent)
            }

            // Name + reason
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(meal.name)
                    .font(Theme.Typography.bodySmall)
                    .fontWeight(.medium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                Text(meal.reason.asMarkdown)
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(2)
            }

            Spacer()

            // Kcal badge
            Text("\(meal.kcal)")
                .font(Theme.Typography.numericSmall(14))
                .foregroundStyle(Theme.Colors.textSecondary)
                .monospacedDigit()
        }
        .padding(Theme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Colors.glassFill)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                )
        )
    }
}
