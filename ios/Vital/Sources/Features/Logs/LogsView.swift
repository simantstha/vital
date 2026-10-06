import SwiftUI

/// Sheet target for a log row's proactive analysis — `kind` is the row's
/// log type (workout_completed / sleep_session), `analysisId` the ready
/// analysis to open.
private struct AnalysisSheetTarget: Identifiable, Equatable {
    let kind: String
    let analysisId: String
    var id: String { analysisId }
}

/// The Logs tab: a 7-day pager (today ... six days ago) over a unified
/// activity feed, with a per-day diet-budget card (live/tappable for today,
/// read-only for past days) and a hairline-separated entries list.
struct LogsView: View {
    @StateObject private var vm = LogsViewModel()
    @ObservedObject private var unitPref = UnitPreference.shared
    @State private var showDietSheet = false
    /// "Log lift" sheet (`LiftLoggerView`) — opened from the day card's
    /// "Log a lift" button.
    @State private var showLiftLogger = false
    @State private var analysisTarget: AnalysisSheetTarget?
    /// A row tapped while the *previous* analysis sheet is still animating
    /// out. `.sheet(item:)` silently drops a presentation requested during
    /// another one's dismissal — `analysisTarget` is already back to `nil`
    /// by then (SwiftUI clears the binding as soon as `dismiss()` is
    /// called, well before the close animation finishes), so there's no way
    /// to tell "a dismissal is in flight" from `analysisTarget` alone. See
    /// `isAnalysisSheetDismissing`/`presentAnalysis(_:)` below.
    @State private var queuedAnalysisTarget: AnalysisSheetTarget?
    /// `true` from the moment `analysisTarget` flips to `nil` until the
    /// sheet's `onDismiss` actually fires — i.e. exactly the window a new
    /// presentation would otherwise get silently dropped in.
    @State private var isAnalysisSheetDismissing = false
    /// Bumped only inside an *enabled* pager button's own action — never
    /// bound to `vm.selectedIndex` directly, since `LogsViewModel.load()`
    /// resets that to 0 on every pull-to-refresh, which would fire a
    /// spurious haptic. Disabled buttons don't invoke their action at all,
    /// so the ends of the 7-day range stay silent for free.
    @State private var pagerTapTick = 0

    private var currentDay: LogDay? {
        vm.days.indices.contains(vm.selectedIndex) ? vm.days[vm.selectedIndex] : nil
    }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    headerSection

                    if vm.isLoading && vm.days.isEmpty {
                        HStack {
                            Spacer()
                            ProgressView()
                                .tint(Theme.Colors.accentContent)
                            Spacer()
                        }
                        .padding(.top, 60)
                        .motionTransition(.fade)
                    } else if let errorMessage = vm.errorMessage, currentDay == nil {
                        // Whole tab failed — no day/pager data to fall back
                        // to, so this replaces the screen instead of sitting
                        // pinned above an empty pager.
                        ErrorStateContainer {
                            ErrorCard(title: "Couldn't load your logs", message: errorMessage) {
                                Task {
                                    vm.errorMessage = nil
                                    await vm.load()
                                }
                            }
                        }
                        .padding(.horizontal, Theme.Spacing.xl)
                    } else {
                        Group {
                            if let errorMessage = vm.errorMessage {
                                ErrorCard(title: "Couldn't load your logs", message: errorMessage) {
                                    Task {
                                        vm.errorMessage = nil
                                        await vm.load()
                                    }
                                }
                                .padding(.horizontal, Theme.Spacing.xl)
                                .padding(.bottom, Theme.Spacing.lg)
                            }

                            if let day = currentDay {
                                pagerRow(day)

                                if let data = vm.dietDataByDay[day.dayKey] {
                                    DietBudgetCardView(
                                        data: data,
                                        readOnly: vm.selectedIndex != 0,
                                        onTap: vm.selectedIndex == 0 ? { showDietSheet = true } : nil
                                    )
                                    .padding(.horizontal, Theme.Spacing.xl)
                                    .padding(.bottom, Theme.Spacing.lg)
                                }

                                entriesSection(day)
                            }
                        }
                        .motionTransition(.fade)
                    }
                }
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .refreshable { await vm.load() }
        }
        .task { await vm.load() }
        .sheet(isPresented: $showDietSheet) {
            VitalSheet(detents: [.large]) {
                DietSheetView(
                    initialTarget: vm.todayTargetKcal,
                    onRefreshToday: { Task { await vm.invalidateTodayMealCache() } }
                )
            }
        }
        .sheet(isPresented: $showLiftLogger) {
            VitalSheet(detents: [.large]) {
                LiftLoggerView(onSaved: { Task { await vm.load() } })
            }
        }
        .sheet(item: $analysisTarget, onDismiss: {
            isAnalysisSheetDismissing = false
            if let queuedAnalysisTarget {
                self.queuedAnalysisTarget = nil
                // One more tick past `onDismiss` itself — presenting
                // synchronously inside it can still race the sheet's own
                // teardown on some OS versions.
                DispatchQueue.main.async { analysisTarget = queuedAnalysisTarget }
            }
        }) { target in
            if target.kind == "workout_completed" {
                WorkoutAnalysisView(id: target.analysisId)
            } else {
                SleepAnalysisView(id: target.analysisId)
            }
        }
        .onChange(of: analysisTarget) { oldValue, newValue in
            if oldValue != nil && newValue == nil {
                isAnalysisSheetDismissing = true
            }
        }
    }

    /// Presents a log row's analysis sheet, queuing it instead when the
    /// previous one is still mid-dismissal (see `isAnalysisSheetDismissing`'s
    /// doc comment) — a real user tapping the sleep row right after
    /// dismissing the workout one must not silently get nothing.
    private func presentAnalysis(_ target: AnalysisSheetTarget) {
        if isAnalysisSheetDismissing {
            queuedAnalysisTarget = target
        } else {
            analysisTarget = target
        }
    }
}

// MARK: - Private sub-views

private extension LogsView {

    var headerSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Logs")
                .screenTitleStyle()
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Everything you and your devices record")
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.top, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.lg)
    }

    func pagerRow(_ day: LogDay) -> some View {
        HStack {
            pagerButton(systemName: "chevron.left", enabled: vm.selectedIndex < vm.days.count - 1) {
                vm.selectDay(vm.selectedIndex + 1)
            }
            .accessibilityLabel("Previous day")
            .accessibilityIdentifier("logs.pager.previous")

            Spacer()

            VStack(spacing: 2) {
                Text(day.label)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("\(day.dateLabel) · \(LogsPagerSummary.summaryLine(items: day.items, units: unitPref.current))")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineLimit(1)
            }

            Spacer()

            pagerButton(systemName: "chevron.right", enabled: vm.selectedIndex > 0) {
                vm.selectDay(vm.selectedIndex - 1)
            }
            .accessibilityLabel("Next day")
            .accessibilityIdentifier("logs.pager.next")
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.lg)
        .sensoryFeedback(Theme.Haptics.selection, trigger: pagerTapTick)
    }

    func pagerButton(systemName: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button {
            pagerTapTick += 1
            action()
        } label: {
            ZStack {
                Circle()
                    .fill(enabled ? Theme.Colors.card : Theme.Colors.glassFill)
                    .frame(width: 40, height: 40)
                    .shadow(color: enabled ? Theme.Colors.cardShadow : .clear, radius: 2, x: 0, y: 1)
                Image(systemName: systemName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(enabled ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
            }
        }
        .buttonStyle(.vital(scale: 0.94))
        .disabled(!enabled)
    }

    func entriesSection(_ day: LogDay) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text("LOG ENTRIES")
                    .font(.system(size: 13, weight: .semibold))
                    .tracking(1.3)
                    .foregroundStyle(Theme.Colors.textSecondary)
                Spacer()
                Text("\(day.items.count) \(day.items.count == 1 ? "entry" : "entries")")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.xs)

            VitalCard(padding: 0) {
                if day.items.isEmpty {
                    Text("Nothing logged this day.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Spacing.xxl)
                } else {
                    VStack(spacing: 0) {
                        // No row here has a delete affordance today — deleting a
                        // logged meal only happens in the Diet Sheet. If one is
                        // ever added, it must exclude `type == "nutrition_healthkit"`:
                        // that row is a synthetic, read-only HealthKit rollup with
                        // no underlying event id, so a delete call has nothing to
                        // target and must never reach `deleteMealLog`.
                        ForEach(Array(day.items.enumerated()), id: \.element.id) { index, item in
                            if let analysisId = item.analysisId {
                                Button {
                                    presentAnalysis(AnalysisSheetTarget(kind: item.type, analysisId: analysisId))
                                } label: {
                                    LogEntryRow(item: item, isFirst: index == 0)
                                }
                                .buttonStyle(.plain)
                                // Stable hooks for the screenshot harness — it
                                // taps these rather than matching on row text,
                                // which varies per fixture scenario.
                                .accessibilityIdentifier(item.type == "workout_completed" ? "logs.workoutRow" : "logs.sleepRow")
                            } else {
                                LogEntryRow(item: item, isFirst: index == 0)
                            }
                        }
                    }
                }
            }

            if vm.selectedIndex == 0 {
                Button {
                    showDietSheet = true
                } label: {
                    HStack(spacing: Theme.Spacing.xs) {
                        Image(systemName: "plus")
                            .font(.system(size: 13, weight: .semibold))
                        Text("Add to today's log")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md + 2)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                            .strokeBorder(
                                Theme.Colors.textTertiary.opacity(0.3),
                                style: StrokeStyle(lineWidth: 1, dash: [5])
                            )
                    )
                }
                .buttonStyle(.plain)
                .padding(.top, Theme.Spacing.md)

                // Strength logging entry point (roadmap v5 item B) — the
                // same "Log lift" sheet Today's muscle hero opens.
                Button {
                    showLiftLogger = true
                } label: {
                    HStack(spacing: Theme.Spacing.xs) {
                        Image(systemName: "dumbbell")
                            .font(.system(size: 13, weight: .semibold))
                        Text("Log a lift")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md + 2)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                            .strokeBorder(
                                Theme.Colors.textTertiary.opacity(0.3),
                                style: StrokeStyle(lineWidth: 1, dash: [5])
                            )
                    )
                }
                .buttonStyle(.plain)
                .padding(.top, Theme.Spacing.sm)
                .accessibilityIdentifier("logs.logLift")
            }
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.lg)
    }
}

// MARK: - Log entry row

private struct LogEntryRow: View {
    let item: LogDisplayItem
    let isFirst: Bool

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            if let thumb = item.thumbnail {
                Image(uiImage: thumb)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 40, height: 40)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                IconBadge(systemName: item.sfSymbol, style: .soft)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                Text(item.subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: Theme.Spacing.sm)

            Text(item.meta)
                .font(.system(size: 12))
                .foregroundStyle(Theme.Colors.textTertiary)

            if item.analysisId != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .overlay(alignment: .top) {
            if !isFirst {
                Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5)
            }
        }
        // This row's label sits inside a `.buttonStyle(.plain)` Button, which
        // (with no background) is only hit-testable on its drawn glyphs —
        // the Spacer between the title/subtitle and the trailing meta text
        // is empty space, not part of the tap target. A row whose meta text
        // happens to start well right of center (e.g. "auto" on a short
        // sleep row) could then have a real dead zone in its middle where a
        // tap lands on nothing. `.contentShape` makes the whole padded row
        // tappable, matching what it visually looks like.
        .contentShape(Rectangle())
    }
}
