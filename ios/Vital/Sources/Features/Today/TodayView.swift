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
    @State private var showNotifications = false
    /// "See full plan ›" from the Next-up row — opens the existing
    /// `PlanTimelineView` in a sheet (owner decision, 2026-09-23).
    @State private var showFullPlan = false

    /// Shared with the bell badge here and the Today/RootTabView push route —
    /// see `NotificationsViewModel.shared`.
    @ObservedObject private var notificationsVM = NotificationsViewModel.shared

    /// Backs the weight_loss hero's trend/weigh-in formatting (§4.1, §5.3) —
    /// never hardcode kg/lb, always read the live preference.
    @ObservedObject private var unitPref = UnitPreference.shared

    /// `vital://log` deep links (Siri/App Intents, Shortcuts, the Home
    /// Screen quick action, a notification's "Edit in Vital") — see
    /// `LogDeepLinkRoute`. `RootTabView` switches to this tab; this view
    /// opens the Diet sheet (optionally auto-presenting LogMealView in a
    /// given input method) and clears the route once handled.
    @EnvironmentObject private var router: AppRouter
    @State private var dietSheetAutoOpenMethod: MealInputMethod? = nil

    /// The voice FAB must never overlap an open sheet.
    private var isAnySheetOpen: Bool {
        showLogSheet || showAddItem || actionsItem != nil || selectedMeal != nil
            || showNotifications || showFullPlan || vm.showWeighInSheet
    }

    var body: some View {
        ZStack(alignment: .top) {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    greetingSection
                    // Gate the data-bearing content on the tri-state load so a
                    // fresh launch shows a skeleton, a real failure with no
                    // data on screen shows `.failed` instead of stacking an
                    // error card on top of an empty dashboard, and a partial
                    // failure (some data already loaded) keeps rendering it.
                    switch vm.loadState {
                    case .loading:
                        todaySkeleton
                            .motionTransition(.fade)

                    case .failed(let message):
                        ErrorStateContainer {
                            ErrorCard(title: "Couldn't load today's data", message: message) {
                                Task { await vm.loadHealthData() }
                            }
                        }

                    case .loaded:
                        Group {
                            calibrationCard
                            pendingFactsBanner

                            // Goal hero (§4.1) — weight_loss only for T1; other
                            // goals keep their existing Today content below
                            // (T2 will add their own heroes).
                            if vm.isWeightLossGoal {
                                WeightHeroView(
                                    kcalRemaining: vm.diet.kcalRemaining,
                                    kcalTarget: vm.diet.kcalTarget,
                                    kcalFraction: vm.diet.kcalFraction,
                                    proteinHave: vm.diet.protein.current,
                                    proteinGoal: vm.diet.protein.target,
                                    trend: vm.weightLog?.trend,
                                    entries: vm.weightLog?.entries ?? [],
                                    system: unitPref.current,
                                    chip: vm.weighInChip,
                                    onChipTap: { onWeighInChipTap() },
                                    isLogging: vm.isLoggingWeight,
                                    onOpenDiet: { showLogSheet = true }
                                )
                            }

                            if vm.isMuscleGoal {
                                MuscleHeroView(
                                    session: vm.todayMoveSession,
                                    proteinHave: vm.diet.protein.current,
                                    proteinGoal: vm.diet.protein.target,
                                    lastLiftText: vm.muscleLastLiftText,
                                    sessionsThisWeekText: vm.trainingSessionsThisWeekText,
                                    sessionDots: vm.trainingSessionDots,
                                    onTapSession: { actionsItem = $0 }
                                )
                            }

                            if vm.isEnduranceGoal {
                                EnduranceHeroView(
                                    readinessWord: vm.enduranceReadinessWord,
                                    calibratingText: vm.enduranceCalibratingText,
                                    reasonLine: vm.enduranceReasonLine,
                                    session: vm.todayMoveSession,
                                    sessionDots: vm.trainingSessionDots,
                                    weeklyOverviewText: vm.enduranceWeeklyOverviewText,
                                    onTapSession: { actionsItem = $0 }
                                )
                            }

                            // "Next up" replaces the full plan list for every
                            // goal (owner decision, 2026-09-23) — guarded here
                            // (not just inside the view) so an empty payload
                            // doesn't leave a floating `Theme.Spacing.xl` gap.
                            // Shown whenever there's ANY plan item, not only
                            // when one is upcoming (screenshot-review fix,
                            // 2026-09-23) — "See full plan" must stay
                            // reachable even once everything remaining today
                            // has already passed `vm.nextUpItem`'s grace
                            // window.
                            if !vm.planItems.isEmpty {
                                NextUpRowView(
                                    item: vm.nextUpItem,
                                    onTap: { actionsItem = $0 },
                                    onSeeFullPlan: { showFullPlan = true }
                                )
                            }

                            if !CoachBubble.isEmpty(vm.coachInsight) {
                                CoachBubble(message: vm.coachInsight)
                            }
                            if vm.showHealthKitRecoveryBanner {
                                healthKitRecoveryBanner
                            }

                            // New-user first-run checklist (§4.2) replaces the
                            // three empty biometric tiles until real data exists.
                            if vm.showFirstRunChecklist {
                                FirstRunChecklistView(
                                    goal: vm.goal,
                                    mealLogged: vm.diet.kcalConsumed > 0,
                                    secondItemLogged: vm.showFirstRunChecklistSecondItemDone,
                                    healthConnected: HealthKitManager.didRequestAuthorization && !vm.showHealthKitRecoveryBanner,
                                    onLogMeal: { showLogSheet = true },
                                    onLogSecondItem: { onChecklistSecondItemTap() },
                                    onConnectHealth: { _ = HealthKitManager.openHealthApp() }
                                )
                            } else {
                                metricsGrid
                            }

                            // FuelStripView is hidden for weight_loss — the
                            // hero above already covers calories (§4).
                            if !vm.isWeightLossGoal {
                                FuelStripView(
                                    kcalRemaining: vm.diet.kcalRemaining,
                                    proteinHave: vm.diet.protein.current,
                                    proteinGoal: vm.diet.protein.target,
                                    // The muscle hero already shows a protein
                                    // have/goal line + bar above this strip —
                                    // don't repeat it (coaching review,
                                    // 2026-09-23). Endurance's hero doesn't
                                    // show protein, so it keeps this one.
                                    showsProtein: !vm.isMuscleGoal,
                                    consumedSource: vm.diet.consumedSource,
                                    consumedSourceName: vm.diet.consumedSourceName,
                                    onOpen: { showLogSheet = true }
                                )
                            }
                            if let warning = vm.diet.lowEnergyWarning {
                                CautionBanner(
                                    title: CautionBanner.lowEnergyTitle(appliedFloor: warning.appliedFloor),
                                    message: warning.message
                                )
                            }
                        }
                        .motionTransition(.fade)
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.lg)
                .padding(.bottom, Theme.Spacing.lg)
            }
            .scrollIndicators(.hidden)
            .contentMargins(.bottom, isAnySheetOpen ? 0 : (60 + 32 + 12), for: .scrollContent)
            .refreshable { await vm.loadHealthData() }
            .task {
                await vm.loadHealthData()
                if vm.didLoadToday { ReminderScheduler.shared.briefViewed(at: Date()) }
            }
            .task { await notificationsVM.refresh() }

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
        .actionToastHost(vm.actionToast)
        .sheet(isPresented: $vm.showWeighInSheet) {
            VitalSheet(detents: [.height(340)]) {
                WeighInSheet(
                    prefillKg: WeightHeroLogic.lastWeightKg(entries: vm.weightLog?.entries ?? []),
                    currentTrendKg: vm.weightLog?.trend.days.last?.trendKg,
                    system: unitPref.current,
                    isSaving: vm.isLoggingWeight,
                    onSave: { value in
                        Task { await vm.logManualWeighIn(weightInUserUnits: value, system: unitPref.current) }
                    },
                    onCancel: { vm.showWeighInSheet = false }
                )
            }
        }
        .sheet(isPresented: $showFullPlan) {
            VitalSheet(detents: [.large]) {
                ScrollView {
                    PlanTimelineView(
                        items: vm.planItems,
                        onItemTap: { showFullPlan = false; actionsItem = $0 },
                        onLogItem: { item in
                            vm.setStatus(id: item.id, .done)
                            vm.toastMessage = "Logged — nice work"
                        },
                        onOpenAdd: { showFullPlan = false; showAddItem = true },
                        onSyncCalendar: vm.calendarSyncState == .notDetermined
                            ? { Task { await vm.syncCalendar() } }
                            : nil
                    )
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.bottom, Theme.Spacing.xl)
                }
            }
        }
        .sheet(isPresented: $showLogSheet) {
            VitalSheet(detents: [.large]) {
                DietSheetView(
                    initialTarget: vm.diet.kcalTarget,
                    onRefreshToday: { Task { await vm.loadHealthData() } },
                    autoOpenLogMethod: dietSheetAutoOpenMethod
                )
            }
        }
        .onChange(of: showLogSheet) { _, isPresented in
            // Consume the auto-open request only while it drove this
            // presentation; an unrelated close (a manual fuel-strip tap
            // opened afterwards) shouldn't replay a stale deep link.
            if !isPresented { dietSheetAutoOpenMethod = nil }
        }
        .onChange(of: router.logDeepLink, initial: true) { _, route in
            guard let route else { return }
            switch route {
            case .compose(let method):
                dietSheetAutoOpenMethod = method
            case .event:
                dietSheetAutoOpenMethod = nil
            }
            showLogSheet = true
            router.logDeepLink = nil
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
        .sheet(isPresented: $showNotifications) {
            NotificationsView(coachVM: coachVM, switchToCoachTab: switchToCoachTab)
        }
    }
}

// MARK: - Private sub-views

private extension TodayView {

    // ── Weigh-in chip (§5.3) ────────────────────────────────────────────────

    /// One-tap confirm (HealthKit reading present) logs directly; otherwise
    /// opens the 2-tap manual sheet.
    func onWeighInChipTap() {
        let chip = vm.weighInChip
        if chip.isOneTapConfirm, let kg = chip.confirmValueKg {
            Task { await vm.confirmHealthKitWeight(kg: kg) }
        } else {
            vm.showWeighInSheet = true
        }
    }

    // ── First-run checklist (§4.2) ──────────────────────────────────────────

    func onChecklistSecondItemTap() {
        if vm.goal == "muscle" || vm.goal == "endurance" {
            showAddItem = true
        } else {
            vm.showWeighInSheet = true
        }
    }

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

    // ── HealthKit recovery banner ───────────────────────────────────────────
    //
    // Shown only when `vm.showHealthKitRecoveryBanner` infers a probable
    // denial (asked once, zero data anywhere) — see
    // `TodayViewModel.shouldShowHealthKitRecoveryBanner`. The copy never
    // asserts the user denied anything, since a fresh Health store with no
    // data yet looks identical from here; it states what's observable and
    // offers a real way back for the case where it *was* a denial. There is
    // no public API to deep-link straight to this app's row in Health's
    // Sharing screen (verified against the UIKit SDK headers), so the
    // button opens the Health app itself and the message spells out the
    // remaining taps. If the Health app is not available on the device, the
    // button is hidden and only the written instructions are shown.
    var healthKitRecoveryBanner: some View {
        VStack(spacing: Theme.Spacing.sm) {
            CautionBanner(
                title: "Vital isn't seeing your Health data",
                message: "That's the same whether Health access wasn't granted or nothing's logged yet. Open Health, tap your profile icon, then Apps → Vital to check."
            )
            if HealthKitManager.canOpenHealthApp() {
                Button {
                    HealthKitManager.openHealthApp()
                } label: {
                    Text("Open Health")
                        .font(Theme.Typography.bodySmall)
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.Colors.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Spacing.sm + 2)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                                .fill(Theme.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }

    // ── Header ──────────────────────────────────────────────────────────────

    var greetingSection: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text(vm.dateSubtitle)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)

                Text(vm.greeting)
                    .font(.system(size: 30, weight: .bold))
                    .tracking(-0.4)
                    .foregroundStyle(Theme.Colors.textPrimary)

                HStack(spacing: Theme.Spacing.sm) {
                    // Before any streak fetch has ever succeeded, `streakDays`
                    // is just its zero default, not a real "0-day streak" —
                    // showing the chip then would assert something we don't
                    // actually know. Once we've loaded a real value at least
                    // once, keep showing it (last known good) even through a
                    // later failed refresh.
                    if vm.hasLoadedStreak {
                        Chip(text: "\(vm.streakDays)-day streak", icon: "flame.fill", isAccent: true)
                    }
                    if let hint = vm.planHint {
                        Text(hint)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
                .padding(.top, Theme.Spacing.xxs)
            }

            Spacer(minLength: Theme.Spacing.sm)

            bellButton
        }
    }

    // ── Notification bell ───────────────────────────────────────────────────

    private var bellButton: some View {
        Button { showNotifications = true } label: {
            ZStack(alignment: .topTrailing) {
                Circle()
                    .fill(Theme.Colors.glassFill)
                    .overlay(Circle().strokeBorder(Theme.Colors.glassBorder, lineWidth: 1))
                    .frame(width: 40, height: 40)

                Image(systemName: "bell")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(width: 40, height: 40)

                if notificationsVM.unreadCount > 0 {
                    Text(notificationsVM.unreadCount > 9 ? "9+" : "\(notificationsVM.unreadCount)")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(Theme.Colors.onAccent)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Circle().fill(Theme.Colors.accent))
                        .overlay(Circle().strokeBorder(Theme.Colors.canvas, lineWidth: 2))
                        .offset(x: 4, y: -4)
                }
            }
        }
        .buttonStyle(.vital(scale: 0.94))
        .padding(.top, 2)
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

    // ── Loading skeleton ────────────────────────────────────────────────────

    /// Mirrors Today's real geometry once loaded: a coach-bubble block, the
    /// 3-across HRV/Sleep/Resting-HR metrics row, and a fuel-strip block.
    var todaySkeleton: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
            SkeletonBlock(height: 70)
            HStack(spacing: Theme.Spacing.sm) {
                SkeletonView()
                SkeletonView()
                SkeletonView()
            }
            SkeletonBlock(height: 90)
        }
    }

    // ── Metric tiles ─────────────────────────────────────────────────────────

    var metricsGrid: some View {
        HStack(spacing: Theme.Spacing.sm) {
            MetricTile(
                label: "HRV",
                value: vm.hrv.displayValue,
                unit: vm.hrv.displayUnit,
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
                value: vm.restingHR.displayValue,
                unit: vm.restingHR.displayUnit,
                trend: vm.restingHR.trend,
                delta: vm.restingHR.delta
            )
        }
    }
}

// MARK: - Supporting views (file-private)

/// A thin rounded progress bar. Not `private` — reused by `WeightHeroView`'s
/// kcal-remaining bar.
struct VitalProgressBar: View {
    let fraction: Double
    var tint: Color = Theme.Colors.accent
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(Theme.Colors.progressTrack)
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(tint)
                    .frame(width: geo.size.width * fraction)
                    .animation(Theme.Motion.settle, value: fraction)
            }
        }
        .frame(height: height)
    }
}
