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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Links each tile's `.matchedTransitionSource` to the destination's
    /// `.navigationTransition(.zoom(...))`. One namespace for the whole grid
    /// is correct here — the metric key (already unique per tile) is what
    /// disambiguates which tile is zooming, not the namespace.
    @Namespace private var trendsZoomNamespace

    /// Single column at accessibility Dynamic Type sizes — a 2-up tile is
    /// already tight at the default text size (see `MetricTileView`'s chip
    /// copy note), and AX1–AX5 text simply can't fit two columns without
    /// clipping or crushing the sparkline/value row.
    private var isSingleColumn: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                Theme.Colors.canvas.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                        headerSection

                        if vm.calibration?.status == "calibrating" {
                            calibratingBanner
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

// MARK: - Header + period switch + calibrating banner

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
    /// a failed load.
    @ViewBuilder
    var subtitleText: some View {
        if vm.errorMessage != nil {
            Text("Last \(vm.period.days) days")
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
        } else {
            let bold = Text(vm.headline.boldText)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
            let rest = Text(vm.headline.trailingText)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
            (bold + rest)
        }
    }

    var calibratingBanner: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "info.circle")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.Colors.accentContent)
                .padding(.top, 1)
            Text("Baselines are still calibrating — \"your normal\" appears once each metric has 14 days.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.accentContent)
        }
        .padding(Theme.Spacing.lg)
        .background(
            // Mock's `rounded-2xl` (16pt) — between Theme.Radius.md and .lg,
            // kept as a literal since it's a shape radius, not a color.
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Theme.Colors.accentSoft)
        )
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
                                .fill(Theme.Colors.card)
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
                                WhatMovedRowView(row: row, unitSystem: unitPref.current)
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

// MARK: - Grid index

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
            }
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
                        sectionTilesView(section.tiles)
                    }
                }
            }
            .motionTransition(.fade)
        }
    }

    var loadingGrid: some View {
        let columns = isSingleColumn
            ? [GridItem(.flexible())]
            : [GridItem(.flexible(), spacing: Theme.Spacing.md), GridItem(.flexible())]
        return LazyVGrid(columns: columns, spacing: Theme.Spacing.md) {
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

    /// Orphan tile: `LazyVGrid` can't span a cell across columns, so a
    /// section with an odd tile count is laid out as a `VStack` of rows
    /// instead — a full `HStack` pair per row, with a lone last tile given
    /// the full row width rather than sitting half-empty next to a gap.
    /// Single column (unchanged) at accessibility Dynamic Type sizes.
    @ViewBuilder
    func sectionTilesView(_ tiles: [TrendsTile]) -> some View {
        if isSingleColumn {
            VStack(spacing: Theme.Spacing.md) {
                ForEach(Array(tiles.enumerated()), id: \.element.key) { index, tile in
                    entrance(index: index) { tileButton(tile) }
                }
            }
        } else {
            VStack(spacing: Theme.Spacing.md) {
                ForEach(Array(TrendsRowGrouping.pairedRows(tiles).enumerated()), id: \.offset) { rowIndex, row in
                    HStack(spacing: Theme.Spacing.md) {
                        ForEach(Array(row.enumerated()), id: \.element.key) { columnIndex, tile in
                            entrance(index: rowIndex * 2 + columnIndex) {
                                tileButton(tile)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        // A lone last tile spans the row alone (no trailing
                        // empty column) — the `HStack` above already sizes
                        // it full-width via `.frame(maxWidth: .infinity)`,
                        // so nothing further is needed here.
                    }
                }
            }
        }
    }

    func tileButton(_ tile: TrendsTile) -> some View {
        Button {
            tileTapTick.toggle()
            path.append(tile.key)
        } label: {
            MetricTileView(tile: tile)
        }
        .buttonStyle(TilePressStyle())
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
