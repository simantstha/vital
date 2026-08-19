import SwiftUI

struct TrendsView: View {
    @StateObject private var vm = TrendsViewModel()
    @State private var path: [String] = []
    /// Toggled on every tile tap purely to drive `.sensoryFeedback` below —
    /// tile taps are one of the three user-committed actions the motion
    /// policy allows a haptic on (never data arriving from `vm.load()`).
    @State private var tileTapTick = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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

                        if let summaryErrorMessage = vm.summaryErrorMessage {
                            ErrorCard(title: "Couldn't load your 7-day summary", message: summaryErrorMessage) {
                                Task {
                                    vm.summaryErrorMessage = nil
                                    await vm.loadSummary()
                                }
                            }
                        }

                        WeeklyHeadlineStrip(vm: vm)

                        if let errorMessage = vm.errorMessage {
                            ErrorCard(title: "Couldn't load your trends", message: errorMessage) {
                                Task {
                                    vm.errorMessage = nil
                                    await vm.load()
                                }
                            }
                            .motionTransition(.fade)
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
                }
            }
            .navigationDestination(for: String.self) { metricKey in
                MetricDetailView(metricKey: metricKey)
            }
        }
        .task {
            await vm.load()
            await vm.loadSummary()
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

    var subtitle: String {
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
        TrendsIndexSections.build(loaded: vm.loaded, today: Date())
    }

    var visibleMetricCount: Int {
        sections.reduce(0) { $0 + $1.tiles.count }
    }

    @ViewBuilder
    var gridBody: some View {
        if vm.isLoading && vm.loaded.isEmpty {
            loadingGrid
                .motionTransition(.fade)
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
    }
}
