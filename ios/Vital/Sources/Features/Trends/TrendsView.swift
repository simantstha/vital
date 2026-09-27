import SwiftUI

struct TrendsView: View {
    @StateObject private var vm = TrendsViewModel()
    @State private var path: [String] = []
    /// Toggled on every tile tap purely to drive `.sensoryFeedback` below —
    /// tile taps are one of the three user-committed actions the motion
    /// policy allows a haptic on (never data arriving from `vm.load()`).
    @State private var tileTapTick = false
    /// Same idiom, for the header's 7D/30D/90D period switch.
    @State private var periodTapTick = false
    @ObservedObject private var unitPref = UnitPreference.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Links each tile's `.matchedTransitionSource` to the destination's
    /// `.navigationTransition(.zoom(...))`. One namespace for the whole grid
    /// is correct here — the metric key (already unique per tile) is what
    /// disambiguates which tile is zooming, not the namespace.
    @Namespace private var trendsZoomNamespace

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                Theme.Colors.canvas.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                        headerSection

                        // Calm-layout revamp: the old "Baselines are still
                        // calibrating" banner (which could render directly
                        // under an "Everything's normal" headline — a live
                        // contradiction) is gone. `.learning` is now the ONE
                        // card for that state; `subtitleText` above renders
                        // nothing while it's showing.
                        if case .learning(let progress) = vm.headlineStatus {
                            learningCard(progress)
                        }

                        // "What moved" (customer-panel finding, Trends
                        // phase-1) sits above EVERYTHING else, including the
                        // weight_loss weight card below — it's the single
                        // "here's what changed" answer the whole screen
                        // leads with. Hidden entirely (no empty card, no
                        // header) whenever nothing is `.above`/`.below`.
                        if !vm.whatMovedRows.isEmpty {
                            whatMovedSection
                        }

                        // Weight_loss's lead card (customer-panel finding,
                        // 2026-09-23) — deliberately ahead of `showsWeekCard`
                        // and `gridBody` below, both of which lead with
                        // recovery metrics (sleep/HRV/RHR): docs/ux-spec-v4
                        // .md §9's screenshot acceptance table requires the
                        // weight card sit above the first recovery card, not
                        // just above the grid.
                        if showsWeightCard {
                            weightCardView
                                .motionTransition(.fade)
                                .staggeredAppear(index: 0)
                        }

                        if let summaryErrorMessage = vm.summaryErrorMessage, vm.errorMessage == nil {
                            // Only the weekly summary failed — the grid still
                            // loads below, so this stays an inline card
                            // rather than claiming the whole screen.
                            ErrorCard(title: "Couldn't load your summary", message: summaryErrorMessage) {
                                Task {
                                    vm.summaryErrorMessage = nil
                                    await vm.loadSummary()
                                }
                            }
                        }

                        if vm.showsWeekCard {
                            WeeklyHeadlineStrip(vm: vm)
                                .staggeredAppear(index: 1)
                        }

                        if let errorMessage = vm.errorMessage {
                            // Whole screen failed (gridBody renders EmptyView
                            // below) — center the card(s) instead of pinning
                            // them under the header with a void beneath.
                            ErrorStateContainer {
                                VStack(spacing: Theme.Spacing.md) {
                                    if let summaryErrorMessage = vm.summaryErrorMessage {
                                        ErrorCard(title: "Couldn't load your summary", message: summaryErrorMessage) {
                                            Task {
                                                vm.summaryErrorMessage = nil
                                                await vm.loadSummary()
                                            }
                                        }
                                    }
                                    ErrorCard(title: "Couldn't load your trends", message: errorMessage) {
                                        Task {
                                            vm.errorMessage = nil
                                            await vm.load()
                                        }
                                    }
                                }
                            }
                        }

                        gridBody
                    }
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.top, Theme.Spacing.lg)
                    .padding(.bottom, 40)
                }
                .scrollIndicators(.hidden)
                .refreshable {
                    await vm.load()
                    await vm.loadSummary()
                    await vm.loadGoalContext()
                }
            }
            .navigationDestination(for: String.self) { metricKey in
                // Reduce Motion: fall back to the default push rather than
                // forcing a zoom — `.navigationTransition` is generic over
                // the concrete transition type, so the two branches must be
                // separate view-builder cases, not a ternary on the value.
                if reduceMotion {
                    MetricDetailView(metricKey: metricKey)
                } else {
                    MetricDetailView(metricKey: metricKey)
                        .navigationTransition(.zoom(sourceID: metricKey, in: trendsZoomNamespace))
                }
            }
        }
        .task {
            await vm.load()
            await vm.loadSummary()
            await vm.loadGoalContext()
        }
        .sensoryFeedback(Theme.Haptics.selection, trigger: tileTapTick)
        .sensoryFeedback(Theme.Haptics.selection, trigger: periodTapTick)
    }
}

// MARK: - Header + period switch + status card

private extension TrendsView {

    var headerSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text("Trends")
                    .screenTitleStyle()
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                PeriodSwitcher(period: $vm.period) { periodTapTick.toggle() }
            }
            subtitleText
        }
    }

    /// Replaces the old static "Last 30 days · N metrics tracked" with a
    /// one-line, data-driven summary (`TrendsHeadline`) — omitted entirely
    /// while the grid load has failed, same as the old subtitle, since the
    /// count/verdict data it needs comes from `vm.loaded`, which is empty on
    /// a failed load. Calm-layout revamp: `.learning` renders nothing here —
    /// the `learningCard` below the header carries that state's copy
    /// instead, so it's never said twice.
    @ViewBuilder
    var subtitleText: some View {
        if vm.errorMessage != nil {
            Text("Last \(vm.period.days) days")
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
        } else {
            switch vm.headlineStatus {
            case .learning:
                EmptyView()
            case .steady(let period):
                steadyHeadline(period: period)
            case .moved(let summary):
                let bold = Text(summary.boldText)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                let rest = Text(summary.trailingText)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textSecondary)
                (bold + rest)
            }
        }
    }

    /// "✓ A steady month. Nothing moved outside your normal." (W1 design) —
    /// established, nothing moved this period. `Text` `+` concatenation is
    /// deprecated, so the two-tone sentence is one `AttributedString`
    /// instead (same idiom as `WeeklyHeadlineStrip.footnoteView`), with only
    /// the checkmark icon as a separate sibling view.
    func steadyHeadline(period: TrendsPeriod) -> some View {
        var text = AttributedString(TrendsHeadline.steadyHeadlineText(period: period))
        text.foregroundColor = Theme.Colors.textPrimary
        text.font = .system(size: 15, weight: .semibold)
        var subline = AttributedString(" " + TrendsHeadline.steadySubline)
        subline.foregroundColor = Theme.Colors.textSecondary
        subline.font = .system(size: 15)
        text.append(subline)

        return HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.xs) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.Colors.positive)
            Text(text)
        }
    }

    /// The "Learning your normal" card (W2 design) — replaces both the old
    /// one-line subtitle AND the separate calibrating banner while every
    /// metric shown is still calibrating (or none is established yet).
    /// Never claims "normal" — see `TrendsHeadline.LearningProgress`.
    func learningCard(_ progress: TrendsHeadline.LearningProgress) -> some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            HStack(spacing: Theme.Spacing.md) {
                learningRing(progress)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Learning your normal")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(progress.bodyText)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Mirrors `MetricDetailView.calibrationRing` exactly (same tokens,
    /// same trim/rotation math) — the two rings should never disagree about
    /// what "N/14" looks like.
    func learningRing(_ progress: TrendsHeadline.LearningProgress) -> some View {
        ZStack {
            Circle()
                .stroke(Theme.Colors.progressTrack, lineWidth: 4)
            Circle()
                .trim(from: 0, to: min(1, Double(progress.daysDone) / 14))
                .stroke(Theme.Colors.accentContent, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(Theme.Motion.settle, value: progress.daysDone)
            Text(progress.ringLabel)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
        .frame(width: 48, height: 48)
    }
}

/// The header's 7D/30D/90D period switch: a native-feeling segmented
/// control with a sliding selected capsule (`matchedGeometryEffect`).
/// Reduce Motion substitutes a plain, animation-free swap — no slide, no
/// fade — rather than a large moving shape.
private struct PeriodSwitcher: View {
    @Binding var period: TrendsPeriod
    var onChange: () -> Void
    @Namespace private var capsuleNamespace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(TrendsPeriod.allCases) { option in
                let isOn = option == period
                Text(option.label)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isOn ? Theme.Colors.textPrimary : Theme.Colors.textSecondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background {
                        if isOn {
                            Capsule()
                                .fill(Theme.Colors.switcherThumb)
                                // Subtle in light mode only — `cardShadow` is
                                // `.clear` in dark, where a shadow wouldn't
                                // read against the dark canvas anyway (same
                                // pattern as `VitalCard`).
                                .shadow(color: Theme.Colors.cardShadow, radius: 3, y: 1)
                                .matchedGeometryEffect(id: "selectedPeriod", in: capsuleNamespace)
                        }
                    }
                    .contentShape(Capsule())
                    .onTapGesture {
                        guard period != option else { return }
                        period = option
                        onChange()
                    }
                    .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
                    .accessibilityLabel(option.label)
            }
        }
        .padding(3)
        .background(Capsule().fill(Theme.Colors.glassFill))
        .animation(reduceMotion ? nil : Theme.Motion.snap, value: period)
    }
}

// MARK: - What moved

private extension TrendsView {

    var whatMovedSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(alignment: .firstTextBaseline) {
                Text("What moved")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Text("vs your normal")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }

            VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
                VStack(spacing: 0) {
                    ForEach(Array(vm.whatMovedRows.enumerated()), id: \.element.key) { index, row in
                        entrance(index: index) {
                            Button {
                                tileTapTick.toggle()
                                path.append(row.key)
                            } label: {
                                WhatMovedRowView(row: row, unitSystem: unitPref.current, animatesIn: !vm.hasAnimatedIn)
                            }
                            .buttonStyle(.plain)
                        }
                        if index < vm.whatMovedRows.count - 1 {
                            Divider().overlay(Theme.Colors.glassBorder)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Metric-group list (calm-layout revamp — was a 2-column tile grid)

private extension TrendsView {

    /// Weight_loss's lead card (customer-panel finding, 2026-09-23) — `nil`
    /// until `vm.loadGoalContext()` resolves both the goal and the
    /// `/api/weight-log` fetch it gates on that goal, so it simply doesn't
    /// render rather than showing a half-loaded card.
    var showsWeightCard: Bool {
        vm.goal == "weight_loss" && vm.weightLog != nil
    }

    var weightCardView: some View {
        // `body_mass_kg` always has a `MetricCatalog` spec (and so a detail
        // page) — see MetricCatalog.swift — so the card is always tappable
        // here; `TrendsWeightCard.onTap` still supports `nil` (rendered
        // non-interactive) for the day that stops being true.
        TrendsWeightCard(
            trend: vm.weightLog?.trend,
            entries: vm.weightLog?.entries ?? [],
            system: UnitPreference.shared.current,
            onTap: {
                tileTapTick.toggle()
                path.append("body_mass_kg")
            },
            // Not `!vm.hasAnimatedIn`: `weightLog` loads via the separate,
            // later `loadGoalContext()` call (after `load()`/`loadSummary()`
            // have already flipped `hasAnimatedIn` true), so that flag would
            // already read `true` by the time this card ever gets data and
            // the entrance would never play. This card mounts into the tree
            // exactly once data first arrives, so its own `@State`
            // (`TrendsWeightCard`'s `onAppear`) already plays the entrance
            // exactly once per session without needing a shared flag.
            animatesIn: true
        )
    }

    @ViewBuilder
    var gridBody: some View {
        if vm.isLoading && vm.loaded.isEmpty {
            loadingGrid
                .motionTransition(.fade)
        } else if vm.errorMessage != nil {
            // The `ErrorCard` above already covers this state with a Retry
            // action — don't also claim "no trends yet" underneath it. That
            // copy means "you have no data", which is a different, false
            // statement when the truth is "we couldn't load your data".
            EmptyView()
        } else if vm.sections.isEmpty {
            EmptyStateView(
                icon: "chart.xyaxis.line",
                message: "No trends yet — check back once your data syncs.",
                height: 160
            )
            .motionTransition(.fade)
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                ForEach(vm.sections, id: \.group.rawValue) { section in
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        sectionHeaderView(section.group)
                        sectionCard(section.tiles)
                    }
                }
            }
            .motionTransition(.fade)
        }
    }

    /// Calm-layout revamp: skeletons stack as a single column now, matching
    /// the list-row layout they're standing in for (no more 2-column grid).
    var loadingGrid: some View {
        VStack(spacing: Theme.Spacing.md) {
            ForEach(0..<6, id: \.self) { _ in SkeletonView() }
        }
    }

    func sectionTitle(_ group: MetricGroup) -> String {
        switch group {
        case .recovery: return "Recovery"
        case .sleep:    return "Sleep"
        case .activity: return "Activity"
        case .body:     return "Body"
        case .whoop:    return "Whoop"
        }
    }

    /// Sentence case, 20pt bold, no letter tracking — Trends phase-1 drops
    /// the old uppercase-tracked treatment. The WHOOP source `Chip` stays.
    func sectionHeaderView(_ group: MetricGroup) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(sectionTitle(group))
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(Theme.Colors.textPrimary)
            // WHOOP metrics get their own source badge — hrv_sdnn/whoop_hrv_rmssd
            // are different measurements on different scales from different
            // devices, and conflating them has already burned this codebase once.
            if group == .whoop {
                Chip(text: "WHOOP")
            }
            Spacer()
        }
    }

    /// One `VitalCard` per metric group (W1/W2 calm-layout revamp,
    /// replacing the old 2-column `MetricTileView` grid): every tile in the
    /// group renders as a `TrendsMetricRowView` row, divided the same way
    /// the "What moved" card divides its rows.
    func sectionCard(_ tiles: [TrendsTile]) -> some View {
        VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
            VStack(spacing: 0) {
                ForEach(Array(tiles.enumerated()), id: \.element.key) { index, tile in
                    entrance(index: index) { rowButton(tile) }
                    if index < tiles.count - 1 {
                        Divider().overlay(Theme.Colors.glassBorder)
                    }
                }
            }
        }
    }

    func rowButton(_ tile: TrendsTile) -> some View {
        Button {
            tileTapTick.toggle()
            path.append(tile.key)
        } label: {
            TrendsMetricRowView(tile: tile, animatesIn: !vm.hasAnimatedIn)
        }
        .buttonStyle(.plain)
        .matchedTransitionSource(id: tile.key, in: trendsZoomNamespace)
    }

    /// Trends-phase-1 entrance: fade in + rise 8pt, staggered 40ms per row,
    /// on the FIRST successful load only (`vm.hasAnimatedIn`). A later
    /// period switch or pull-to-refresh renders the same rows without
    /// replaying it — see `TrendsViewModel.hasAnimatedIn`'s doc comment for
    /// why that flag lives on the view model rather than a per-cell
    /// `@State` (which a `LazyVGrid` would have reset on scroll; this
    /// section is a plain `VStack` precisely so identity — and this
    /// `@State`-backed modifier — survives).
    @ViewBuilder
    func entrance<Content: View>(index: Int, @ViewBuilder content: () -> Content) -> some View {
        if vm.hasAnimatedIn {
            content()
        } else {
            content().staggeredAppear(index: index)
        }
    }
}

// MARK: - Tile press feedback
//
// Moved here from the deleted `MetricTileView.swift` (calm-layout revamp —
// the grid tile itself is gone, but `TrendsWeightCard`'s lead card still
// uses this exact press style).

/// Trends-phase-1: tiles moved off `GlassCard` onto the solid `VitalCard`
/// surface, so the old backdrop-blur-resampling hazard that kept press
/// feedback opacity-only no longer applies — a `VitalCard` is a plain
/// `RoundedRectangle` fill, not a `.glassEffect()`, so scaling it costs
/// nothing extra. Reduce Motion still gets opacity-only feedback (no
/// motion), matching every other press style in this file family.
struct TilePressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(!reduceMotion && configuration.isPressed ? 0.97 : 1.0)
            .opacity(configuration.isPressed ? 0.85 : 1.0)
            .animation(Theme.Motion.micro, value: configuration.isPressed)
    }
}
