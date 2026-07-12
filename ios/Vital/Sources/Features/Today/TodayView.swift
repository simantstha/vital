import SwiftUI

// MARK: - TodayView

struct TodayView: View {
    @StateObject private var vm = TodayViewModel()

    /// Shared with the Coach tab (owned by `RootTabView`) so the voice FAB's
    /// transcript lands in the same conversation thread; `switchToCoachTab`
    /// is the mechanism the Phase 0/1 changelog flagged as needed here.
    @ObservedObject private var coachVM: CoachViewModel
    private let switchToCoachTab: () -> Void

    init(coachVM: CoachViewModel, switchToCoachTab: @escaping () -> Void) {
        self.coachVM = coachVM
        self.switchToCoachTab = switchToCoachTab
    }

    // Sheet / navigation state
    @State private var showLogSheet = false
    @State private var showAddItem = false
    @State private var actionsItem: PlanItem? = nil
    @State private var selectedMeal: MealRow? = nil
    @State private var mealDetailPlanItemID: PlanItem.ID? = nil

    /// The voice FAB must never overlap an open sheet.
    private var isAnySheetOpen: Bool {
        showLogSheet || showAddItem || actionsItem != nil || selectedMeal != nil
    }

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
                        calibrationCard
                        pendingFactsBanner
                        PlanTimelineView(
                            items: vm.planItems,
                            onItemTap: { actionsItem = $0 },
                            onLogItem: { item in
                                vm.setStatus(id: item.id, .done)
                                vm.toastMessage = "Logged — nice work"
                            },
                            onOpenAdd: { showAddItem = true }
                        )
                        CoachBubble(message: vm.coachInsight)
                        metricsGrid
                        FuelStripView(
                            kcalRemaining: vm.diet.kcalRemaining,
                            proteinHave: vm.diet.protein.current,
                            proteinGoal: vm.diet.protein.target,
                            onOpen: { showLogSheet = true }
                        )
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.lg)
                .padding(.bottom, 120)
            }
            .scrollIndicators(.hidden)
            .task { await vm.loadHealthData() }

            if !isAnySheetOpen {
                VoiceFABView(
                    coachVM: coachVM,
                    onSent: {
                        vm.toastMessage = "Sent to your coach"
                        Task {
                            // Let the toast register on Today before handing
                            // off to the Coach tab, where the reply streams in.
                            try? await Task.sleep(for: .seconds(0.6))
                            switchToCoachTab()
                        }
                    }
                )
            }
        }
        .toast(message: $vm.toastMessage)
        .sheet(isPresented: $showLogSheet) {
            VitalSheet(detents: [.large]) {
                DietSheetView(
                    initialTarget: vm.diet.kcalTarget,
                    onRefreshToday: { Task { await vm.loadHealthData() } }
                )
            }
        }
        .sheet(isPresented: $showAddItem) {
            VitalSheet(detents: [.medium]) {
                AddPlanItemSheet(
                    onAdd: { item in
                        vm.addItem(item)
                        showAddItem = false
                    },
                    onCancel: { showAddItem = false }
                )
            }
        }
        .sheet(item: $actionsItem) { planItem in
            VitalSheet(detents: [.medium]) {
                PlanItemActionsSheet(
                    item: planItem,
                    onMarkDone: {
                        vm.setStatus(id: planItem.id, .done)
                        actionsItem = nil
                    },
                    onSkip: {
                        vm.setStatus(id: planItem.id, .skipped)
                        actionsItem = nil
                    },
                    onMarkNotDone: {
                        vm.setStatus(id: planItem.id, .later)
                        actionsItem = nil
                    },
                    onRemove: {
                        vm.removeItem(id: planItem.id)
                        actionsItem = nil
                    },
                    onViewMeal: planItem.meal.map { meal in
                        {
                            mealDetailPlanItemID = planItem.id
                            selectedMeal = meal
                            actionsItem = nil
                        }
                    },
                    onCancel: { actionsItem = nil }
                )
            }
        }
        .sheet(item: $selectedMeal) { meal in
            MealDetailView(meal: meal) {
                // Refresh Today after a plan meal is logged so the diet
                // budget updates, and mark the originating plan item done.
                if let id = mealDetailPlanItemID {
                    vm.setStatus(id: id, .done)
                }
                Task { await vm.loadHealthData() }
            }
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

    // ── Header ──────────────────────────────────────────────────────────────

    var greetingSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(vm.dateSubtitle)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Colors.textSecondary)

            Text(vm.greeting)
                .font(.system(size: 30, weight: .bold))
                .tracking(-0.4)
                .foregroundStyle(Theme.Colors.textPrimary)

            HStack(spacing: Theme.Spacing.sm) {
                Chip(text: "\(vm.streakDays)-day streak", icon: "flame.fill", isAccent: true)
                Text(vm.planHint)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            .padding(.top, Theme.Spacing.xxs)
        }
    }

    // ── Calibration card ────────────────────────────────────────────────────

    @ViewBuilder
    var calibrationCard: some View {
        if vm.calibrationStatus == "calibrating" {
            let daysCollected = Int((vm.calibrationProgress * 14).rounded())
            GlassCard(padding: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text("Calibrating your baselines")
                            .font(Theme.Typography.bodyMedium)
                            .fontWeight(.semibold)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("\(daysCollected) of 14 days of data collected")
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                    VitalProgressBar(fraction: vm.calibrationProgress, tint: Theme.Colors.accent, height: 4)
                }
            }
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
