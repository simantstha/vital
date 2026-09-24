import SwiftUI

struct TrendsView: View {
    @StateObject private var vm = TrendsViewModel()
    @State private var path: [String] = []
    /// Toggled on every tile tap purely to drive `.sensoryFeedback` below —
    /// tile taps are one of the three user-committed actions the motion
    /// policy allows a haptic on (never data arriving from `vm.load()`).
    @State private var tileTapTick = false
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
    private var gridColumns: [GridItem] {
        dynamicTypeSize.isAccessibilitySize
            ? [GridItem(.flexible())]
            : [GridItem(.flexible(), spacing: Theme.Spacing.md), GridItem(.flexible())]
    }

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
    }
}

// MARK: - Header + calibrating banner

private extension TrendsView {

    var headerSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Trends")
                .screenTitleStyle()
                .foregroundStyle(Theme.Colors.textPrimary)
            Text(subtitle)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
    }

    /// Omits the metric count while the grid load has failed — the count
    /// comes from `vm.loaded`, which is empty on a failed load, so showing
    /// "0 metrics tracked" next to the error card would assert something we
    /// don't actually know (the count isn't 0, we just couldn't fetch it).
    var subtitle: String {
        guard vm.errorMessage == nil else { return "Last 30 days" }
        let count = visibleMetricCount
        return "Last 30 days · \(count) metric\(count == 1 ? "" : "s") tracked"
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

// MARK: - Grid index

private extension TrendsView {

    var sections: [TrendsSection] {
        let built = TrendsIndexSections.build(loaded: vm.loaded, today: Date())
        return TrendsGoalOrdering.sections(for: vm.goal, available: built)
    }

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

    var visibleMetricCount: Int {
        sections.reduce(0) { $0 + $1.tiles.count }
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
        } else if sections.isEmpty {
            EmptyStateView(
                icon: "chart.xyaxis.line",
                message: "No trends yet — check back once your data syncs.",
                height: 160
            )
            .motionTransition(.fade)
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                ForEach(sections, id: \.group.rawValue) { section in
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        sectionHeaderView(section.group)
                        LazyVGrid(columns: gridColumns, spacing: Theme.Spacing.md) {
                            ForEach(section.tiles, id: \.key) { tile in
                                tileButton(tile)
                            }
                        }
                    }
                }
            }
            .motionTransition(.fade)
        }
    }

    var loadingGrid: some View {
        LazyVGrid(columns: gridColumns, spacing: Theme.Spacing.md) {
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

    func sectionHeaderView(_ group: MetricGroup) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(sectionTitle(group).uppercased())
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Colors.textSecondary)
                .tracking(1.3)
            // WHOOP metrics get their own source badge — hrv_sdnn/whoop_hrv_rmssd
            // are different measurements on different scales from different
            // devices, and conflating them has already burned this codebase once.
            if group == .whoop {
                Chip(text: "WHOOP")
            }
            Spacer()
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
}
