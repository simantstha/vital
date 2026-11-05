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
    /// "Log lift" sheet (`LiftLoggerView`) — opened from the muscle hero.
    @State private var showLiftLogger = false
    /// Goal-progress detail sheet — opened from the one-line verdict under the hero.
    @State private var showGoalProgress = false
    /// Voice FAB dims while Today scrolls down (see `VoiceFABScroll`).
    @State private var fabCompact = false
    /// True once Today has scrolled off its resting position: fades in a
    /// blurred status-bar backdrop so content never reads through the clock.
    @State private var statusBarBackdropVisible = false
    /// Weekly review detail sheet — opened from the Mon-Wed review card.
    @State private var showWeeklyReview = false
    @ObservedObject private var weeklyReviewStore = WeeklyReviewStore.shared
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
        showLogSheet || showLiftLogger || showGoalProgress || showWeeklyReview || showAddItem || actionsItem != nil || selectedMeal != nil
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
                        ErrorStateContainer(message: message) {
                            ErrorCard(title: "Couldn't load today's data", message: message) {
                                Task { await vm.loadHealthData() }
                            }
                        }

                    case .loaded:
                        Group {
                            // New-user first-run checklist (§4.2): the clearest
                            // guidance for an account with no data yet, so it
                            // sits directly under the greeting, ABOVE the goal
                            // hero, with the calibration note right after it
                            // (a new user should see what to do today before
                            // being told what needs two weeks of data). It
                            // replaces the three empty biometric tiles.
                            if vm.showFirstRunChecklist {
                                FirstRunChecklistView(
                                    goal: vm.goal,
                                    mealLogged: vm.diet.kcalConsumed > 0,
                                    secondItemLogged: vm.showFirstRunChecklistSecondItemDone,
                                    healthConnected: HealthKitManager.didRequestAuthorization && !vm.showHealthKitRecoveryBanner,
                                    goalTargetSet: vm.hasGoalTarget,
                                    onLogMeal: { showLogSheet = true },
                                    onLogSecondItem: { onChecklistSecondItemTap() },
                                    onConnectHealth: { _ = HealthKitManager.openHealthApp() },
                                    onSetGoalTarget: {
                                        NotificationCenter.default.post(name: .vitalOpenGoalEditor, object: nil)
                                    }
                                )
                                .staggeredAppear(index: 1)

                                calibrationCard
                                    .staggeredAppear(index: 1)
                            }

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
                                    targetKg: vm.goalProgress?.target.weightKg,
                                    goalRateKgPerWeek: vm.heroGoalRateKgPerWeek,
                                    goalRateRange: vm.heroGoalRateRange,
                                    withholdsLocalRate: vm.heroWithholdsRate,
                                    serverWeightRead: vm.heroServerWeightRead,
                                    progressWeight: vm.heroProgressWeight,
                                    chip: vm.weighInChip,
                                    onChipTap: { onWeighInChipTap() },
                                    isLogging: vm.isLoggingWeight,
                                    onOpenDiet: { showLogSheet = true }
                                )
                                .staggeredAppear(index: 1)
                            }

                            if vm.isMuscleGoal {
                                MuscleHeroView(
                                    session: vm.todayMoveSession,
                                    proteinHave: vm.diet.protein.current,
                                    proteinGoal: vm.diet.protein.target,
                                    lastLiftText: vm.muscleLastLiftText,
                                    sessionsThisWeekText: vm.trainingSessionsThisWeekText,
                                    sessionDots: vm.trainingSessionDots,
                                    onTapSession: { actionsItem = $0 },
                                    onLogLift: { showLiftLogger = true }
                                )
                                .staggeredAppear(index: 1)
                            }

                            if vm.isEnduranceGoal {
                                // The recovery strip replaces the three tiles
                                // (same condition as `showMetricTiles`, so
                                // while calibrating the tiles stay).
                                if !vm.showMetricTiles {
                                    RecoveryStripView(items: vm.recoveryStripItems)
                                        .staggeredAppear(index: 1)
                                }

                                if vm.showsEnduranceHero {
                                    EnduranceHeroView(
                                        calibratingText: vm.enduranceCalibratingText,
                                        raceText: vm.enduranceRaceText,
                                        reserveRaceLine: vm.enduranceRaceLineReserved,
                                        session: vm.todayMoveSession,
                                        sessionDots: vm.trainingSessionDots,
                                        weeklyOverviewText: vm.enduranceWeeklyOverviewText,
                                        distanceProgress: vm.enduranceDistanceProgress,
                                        reconciliationText: vm.enduranceReconciliationText,
                                        onTapReconciliation: {
                                            // Same hand-off as the analysis screens'
                                            // "Ask coach" links: RootTabView observes
                                            // `router.coachContext`, prefills the coach
                                            // input and switches to the Coach tab.
                                            if let prompt = vm.enduranceReconciliationCoachPrompt {
                                                router.coachContext = prompt
                                            }
                                        }
                                    )
                                    .staggeredAppear(index: 1)
                                }
                            }

                            // One-line "am I on track?" verdict (v5 Wave 2) under
                            // whichever goal hero is showing (the three heroes are
                            // mutually exclusive) — or on its own for the general
                            // goal. Hidden until `/api/goal/progress` loads and on
                            // failure. The negative top padding pulls it up from
                            // the stack's xl spacing to sit with its hero.
                            if let progress = vm.goalProgressLine {
                                GoalProgressLine(
                                    progress: progress,
                                    system: unitPref.current,
                                    heroShowsDistance: vm.goalLineHeroShowsDistance,
                                    sessionsDoneThisWeek: vm.sessionsDoneThisWeek,
                                    onTap: { showGoalProgress = true }
                                )
                                .padding(.top, goalLineHugsHero ? -Theme.Spacing.md : 0)
                                .transition(.opacity)
                            }

                            // Safety first: the low-energy caution sits directly
                            // under the hero (and its one-line verdict), above
                            // everything else.
                            if let warning = vm.diet.lowEnergyWarning {
                                CautionBanner(
                                    title: CautionBanner.lowEnergyTitle(appliedFloor: warning.appliedFloor),
                                    message: warning.message
                                )
                            }

                            // The coach's note sits directly under the hero, above the
                            // plan (it is the point of the app).
                            if !CoachNote.isEmpty(vm.coachInsight) {
                                CoachNote(message: vm.coachInsight)
                                    .staggeredAppear(index: 2)
                            }

                            // "Rest of today" replaces the full plan list for every
                            // goal (owner decision, 2026-09-23) — guarded here
                            // (not just inside the view) so an empty payload
                            // doesn't leave a floating `Theme.Spacing.xl` gap.
                            // Shown whenever there's ANY plan item, not only
                            // when one is upcoming (screenshot-review fix,
                            // 2026-09-23) — "See full plan" must stay
                            // reachable even once everything remaining today
                            // has already passed `WeightHeroLogic`'s
                            // next-up grace window.
                            if !vm.planItems.isEmpty {
                                NextUpRowView(
                                    items: vm.upcomingItems,
                                    onTap: { actionsItem = $0 },
                                    onSeeFullPlan: { showFullPlan = true }
                                )
                                .staggeredAppear(index: 2)
                            }

                            // FuelStripView is hidden for weight_loss — the
                            // hero above already covers calories (§4).
                            if !vm.isWeightLossGoal {
                                FuelStripView(
                                    kcalRemaining: vm.diet.kcalRemaining,
                                    kcalFraction: vm.diet.kcalFraction,
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
                                .staggeredAppear(index: 4)
                            }

                            // Weekly review (v5 Wave 3): the "how did your week go"
                            // moment, Mon-Wed while unseen. Compact card, placed
                            // below the next-up row / fuel strip so the daily
                            // essentials stay above the fold; the full report
                            // lives in the detail sheet.
                            if WeeklyReviewLogic.shouldShowCard(
                                weeklyReviewStore.latest,
                                now: AppClock.now,
                                ignoreWindow: WeeklyReviewLogic.windowBypassedForFixtures
                            ), let review = weeklyReviewStore.latest {
                                WeeklyReviewCard(
                                    response: review,
                                    onOpen: { showWeeklyReview = true },
                                    onGotIt: { weeklyReviewStore.markSeen() }
                                )
                                .transition(.opacity)
                            }

                            pendingFactsBanner

                            if vm.showHealthKitRecoveryBanner {
                                healthKitRecoveryBanner
                            }

                            // Metrics grid for established users. New users get
                            // the first-run checklist at the TOP of the screen
                            // instead (see above the goal hero).
                            if !vm.showFirstRunChecklist {
                                // Endurance shows HRV / Sleep / RHR in its recovery
                                // strip above the hero — don't repeat them as tiles.
                                if vm.showMetricTiles {
                                    metricsGrid
                                        .staggeredAppear(index: 3)
                                }

                                // Calibration note for established users sits
                                // after the recovery tiles.
                                calibrationCard
                                    .staggeredAppear(index: 3)
                            }

                            // Weight hero is weight-loss only; every other
                            // goal still gets a way to log a weigh-in.
                            // Hidden while the first-run checklist is up — its
                            // "Add today's weight" item is the same action.
                            if !vm.isWeightLossGoal && !vm.showFirstRunChecklist {
                                weighInRow
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
            .onScrollGeometryChange(for: TodayScrollOffsets.self) { geo in
                TodayScrollOffsets(
                    y: geo.contentOffset.y + geo.contentInsets.top,
                    maxY: max(0, geo.contentSize.height - geo.containerSize.height
                              + geo.contentInsets.top + geo.contentInsets.bottom)
                )
            } action: { old, new in
                let next = VoiceFABScroll.isCompact(
                    current: fabCompact, oldOffset: old.y, newOffset: new.y, maxOffset: new.maxY
                )
                if next != fabCompact { fabCompact = next }
                let scrolled = new.y > TodayStatusBarBackdrop.scrolledThreshold
                if scrolled != statusBarBackdropVisible { statusBarBackdropVisible = scrolled }
            }
            .safeAreaInset(edge: .bottom) {
                if !isAnySheetOpen {
                    // Tracks `VoiceFABView.size` (46pt): FAB + its bottom margin
                    // (`Spacing.xxxl`) + 16pt breathing room, plus slack for the
                    // tab bar, so the last card scrolls fully above the FAB.
                    Color.clear.frame(height: VoiceFABView.size + Theme.Spacing.xxxl + 16 + 50)
                }
            }
            .refreshable { await vm.loadHealthData() }
            .task {
                await vm.loadHealthData()
                if vm.didLoadToday { ReminderScheduler.shared.briefViewed(at: Date()) }
            }
            .task { await notificationsVM.refresh() }

            // Content scrolls under the status bar (the ScrollView runs edge to
            // edge), so once scrolled a thin material covers just that strip.
            TodayStatusBarBackdrop(isVisible: statusBarBackdropVisible)

            if !isAnySheetOpen {
                VoiceFABView(
                    coachVM: coachVM,
                    isCompact: fabCompact,
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
        .sheet(isPresented: $showLiftLogger) {
            VitalSheet(detents: [.large]) {
                LiftLoggerView(
                    // Repeat the exercise the hero's "last time" line names.
                    preferredExercise: vm.trainingSummary?.lastLift?.exercise,
                    onSaved: {
                        vm.toastMessage = "Lift logged"
                        // Re-fetches `/api/training/summary` (the hero's
                        // "last time" + "this week" lines) along with the
                        // rest of Today.
                        Task { await vm.loadHealthData() }
                    }
                )
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .vitalGoalTargetsChanged)) { _ in
            vm.refreshGoalProgress()
            Task { await vm.refreshGoalTargetFlag() }
        }
        // The goal kind itself changed (reached goal -> maintenance): re-read
        // /api/today so the hero follows the new goal, then its progress.
        .onReceive(NotificationCenter.default.publisher(for: .vitalGoalKindChanged)) { _ in
            Task {
                await vm.loadHealthData()
                await vm.refreshGoalTargetFlag()
            }
        }
        .sheet(isPresented: $showGoalProgress) {
            if let progress = vm.goalProgress {
                VitalSheet(detents: [.large]) {
                    GoalProgressDetailView(progress: progress, system: unitPref.current)
                }
            }
        }
        .sheet(isPresented: $showWeeklyReview) {
            if let review = weeklyReviewStore.latest {
                VitalSheet(detents: [.large]) {
                    WeeklyReviewDetailView(
                        response: review, isNewAccount: weeklyReviewStore.isNewAccount,
                        onGotIt: { weeklyReviewStore.markSeen() }
                    )
                }
            }
        }
        .task { await weeklyReviewStore.load() }
        .sensoryFeedback(Theme.Haptics.commit, trigger: weeklyReviewStore.seenTick)
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

    // ── Weigh-in entry for non-weight-loss goals ────────────────────────────

    /// Small "Weigh in" row — opens the same sheet the weight hero's chip does.
    var weighInRow: some View {
        let last = WeightHeroLogic.lastWeightKg(entries: vm.weightLog?.entries ?? [])
        return Button {
            onWeighInChipTap()
        } label: {
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: "scalemass")
                    .scaledFont(size: 15, weight: .medium)
                    .foregroundStyle(Theme.Colors.accentContent)
                Text("Weigh in")
                    .scaledFont(Theme.Typography.bodyMedium.weight(.medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                if let last {
                    Text("Last \(UnitFormat.weight(kg: last, unitPref.current))")
                        .scaledFont(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                Image(systemName: "chevron.right")
                    .scaledFont(size: 12, weight: .semibold)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(Theme.Colors.glassFill)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Weigh in")
    }

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

    /// A quiet confirm row, not a card: the question, the server's label
    /// verbatim, the reason when there is one, and two hugging buttons.
    @ViewBuilder
    var pendingFactsBanner: some View {
        ForEach(vm.pendingFacts) { fact in
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("Did I get this right?")
                    .scaledFont(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)

                Text(fact.proposedNode.label)
                    .scaledFont(Theme.Typography.bodyLarge.weight(.medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)

                if let reason = fact.reason,
                   !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(reason)
                        .scaledFont(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }

                AccessibilityAdaptiveStack(spacing: Theme.Spacing.sm, stackedSpacing: Theme.Spacing.xs) {
                    Button {
                        Task { await vm.resolveFact(id: fact.id, action: "confirm") }
                    } label: {
                        Text("Yes, remember")
                            .scaledFont(Theme.Typography.bodyMedium.weight(.medium))
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .padding(.horizontal, Theme.Spacing.lg)
                            .frame(minHeight: 44)
                            .background(
                                RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                    .fill(Theme.Colors.glassFill)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                    .strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    Button {
                        Task { await vm.resolveFact(id: fact.id, action: "reject") }
                    } label: {
                        Text("Not quite")
                            .scaledFont(Theme.Typography.bodyMedium.weight(.medium))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .padding(.horizontal, Theme.Spacing.md)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.top, Theme.Spacing.xs)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
                        .scaledFont(Theme.Typography.bodySmall.weight(.semibold))
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

    /// One quiet meta line (`date · streak`), then the page title: the
    /// endurance readiness word once Today has loaded and calibration is
    /// done, otherwise the greeting (`TodayHeaderLogic.title`). The bell sits
    /// on the meta line.
    var greetingSection: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text(TodayHeaderLogic.metaLine(dateSubtitle: vm.dateSubtitle, streakText: vm.streakChipText))
                    .scaledFont(Theme.Typography.bodySmall.weight(.medium))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    // Wraps at large text sizes rather than truncating; the
                    // min height centres a one-line meta against the 44pt bell.
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 44, alignment: .leading)

                Text(headerTitle)
                    .scaledFont(size: 36, weight: .bold)
                    .tracking(-0.5)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("today.title")

                if let hint = vm.planHint {
                    Text(hint)
                        .scaledFont(size: 13)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.top, Theme.Spacing.xxs)
                }
            }

            Spacer(minLength: Theme.Spacing.sm)

            bellButton
        }
    }

    /// The goal line tucks up under a hero CARD directly above it (weight,
    /// muscle, or an endurance hero with content); otherwise it would collide
    /// with the title or the recovery strip, so it keeps normal stack spacing.
    var goalLineHugsHero: Bool {
        vm.isWeightLossGoal || vm.isMuscleGoal || (vm.isEnduranceGoal && vm.showsEnduranceHero)
    }

    var headerTitle: String {
        TodayHeaderLogic.title(
            greeting: vm.greeting,
            isEnduranceGoal: vm.isEnduranceGoal,
            isLoaded: vm.loadState == .loaded,
            calibratingText: vm.enduranceCalibratingText,
            readinessWord: vm.enduranceReadinessWord
        )
    }

    // ── Notification bell ───────────────────────────────────────────────────

    private var bellButton: some View {
        Button { showNotifications = true } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "bell")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(width: 44, height: 44)

                if notificationsVM.unreadCount > 0 {
                    // Badge on a fixed 44pt bell: stays fixed-size like the bell.
                    Text(notificationsVM.unreadCount > 9 ? "9+" : "\(notificationsVM.unreadCount)")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(Theme.Colors.onAccent)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Circle().fill(Theme.Colors.accent))
                        .overlay(Circle().strokeBorder(Theme.Colors.canvas, lineWidth: 2))
                        .offset(x: -2, y: 2)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.vital(scale: 0.94))
        .accessibilityLabel(notificationsVM.unreadCount > 0
            ? "Notifications, \(notificationsVM.unreadCount) unread"
            : "Notifications")
    }

    // ── Calibration card ────────────────────────────────────────────────────

    @ViewBuilder
    var calibrationCard: some View {
        if vm.calibrationStatus == "calibrating" {
            let daysCollected = Int((vm.calibrationProgress * 14).rounded())
            GlassCard(padding: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text(CalibrationCopy.todayTitle)
                            .scaledFont(Theme.Typography.bodyMedium.weight(.semibold))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text(CalibrationCopy.todayBody(daysCollected: daysCollected))
                            .scaledFont(Theme.Typography.bodySmall)
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
                delta: vm.hrv.delta,
                explanation: MetricExplainer.explanation(for: "hrv_sdnn")
            )
            MetricTile(
                label: "Sleep",
                value: vm.sleep.formatted,
                unit: "",
                trend: vm.sleep.trend,
                delta: vm.sleep.delta,
                explanation: MetricExplainer.explanation(for: "sleep_minutes")
            )
            MetricTile(
                label: "Resting HR",
                value: vm.restingHR.displayValue,
                unit: vm.restingHR.displayUnit,
                trend: vm.restingHR.trend,
                delta: vm.restingHR.delta,
                explanation: MetricExplainer.explanation(for: "resting_hr")
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

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(Theme.Colors.progressTrack)
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(tint)
                    .frame(width: geo.size.width * fraction)
                    .animation(reduceMotion ? nil : Theme.Motion.settle, value: fraction)
            }
        }
        .frame(height: height)
    }
}

/// Scroll snapshot for the Today ScrollView: normalised offset (0 at rest at
/// the top) and the furthest offset (bottom).
private struct TodayScrollOffsets: Equatable {
    var y: Double
    var maxY: Double
}

/// A thin material over the status-bar strip only, shown once Today has
/// scrolled: the ScrollView runs edge to edge, so without it cards and text
/// scroll straight under the clock. Zero-height and top-anchored — the
/// background extends only into the top safe area — so it never changes the
/// layout, hit-testing or any identifier.
struct TodayStatusBarBackdrop: View {
    /// Scroll offset (pt) past which the content has left its resting place.
    static let scrolledThreshold: Double = 2

    let isVisible: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Color.clear
            .background(.ultraThinMaterial)
            .ignoresSafeArea(edges: .top)
            .frame(height: 0)
            .opacity(isVisible ? 1 : 0)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: isVisible)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
