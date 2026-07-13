import SwiftUI
import Charts

struct TrendsView: View {
    @StateObject private var vm = TrendsViewModel()

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    headerSection

                    if vm.calibration?.status == "calibrating" {
                        calibratingBanner
                    }

                    summaryCards

                    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        SectionHeader(title: "Explore")
                        metricPicker
                        daysPicker
                        chartCard
                        statsRow
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.lg)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
        }
        .task {
            await vm.load()
            await vm.loadSummary()
        }
        .onChange(of: vm.selectedMetric) { Task { await vm.load() } }
        .onChange(of: vm.selectedDays)   { Task { await vm.load() } }
    }
}

// MARK: - Header + calibrating banner

private extension TrendsView {

    var headerSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Trends")
                .screenTitleStyle()
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Last 7 days")
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
    }

    var calibratingBanner: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "info.circle")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.Colors.accentContent)
                .padding(.top, 1)
            Text("Baselines are still calibrating — trends firm up as more days come in.")
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

// MARK: - Last 7 days summary cards

private extension TrendsView {

    var summaryCards: some View {
        VStack(spacing: Theme.Spacing.lg) {
            TrendSummaryCard(
                title: "Sleep",
                value: vm.sleepValueText,
                unit: "avg",
                note: "goal 8h",
                footnote: vm.sleepFootnote
            ) {
                TrendBarChart(values: vm.sleepWindow.values, dayLabels: vm.sleepWindow.dayLabels)
            }

            TrendSummaryCard(
                title: "HRV",
                value: vm.hrvValueText,
                unit: "ms",
                note: vm.hrvNote,
                footnote: vm.hrvFootnote
            ) {
                TrendLineChart(values: vm.hrvWindow.values, dayLabels: vm.hrvWindow.dayLabels)
            }

            TrendSummaryCard(
                title: "Resting HR",
                value: vm.rhrValueText,
                unit: "bpm",
                note: vm.rhrNote,
                footnote: vm.rhrFootnote
            ) {
                TrendLineChart(values: vm.rhrWindow.values, dayLabels: vm.rhrWindow.dayLabels)
            }
        }
    }
}

// MARK: - Explorer (existing metric/range explorer, restyled)

private extension TrendsView {

    var metricPicker: some View {
        Menu {
            ForEach(TrendMetric.allCases) { metric in
                Button {
                    vm.selectedMetric = metric
                } label: {
                    if vm.selectedMetric == metric {
                        Label(metric.displayName, systemImage: "checkmark")
                    } else {
                        Text(metric.displayName)
                    }
                }
            }
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                Text(vm.selectedMetric.displayName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                Spacer()
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
            .background(
                Capsule().fill(Theme.Colors.card)
            )
            .shadow(color: Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
        }
        .buttonStyle(.plain)
    }

    var daysPicker: some View {
        HStack(spacing: Theme.Spacing.sm) {
            ForEach([14, 30, 90, 365], id: \.self) { days in
                Button {
                    vm.selectedDays = days
                } label: {
                    Text(Self.rangeLabel(days))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(
                            vm.selectedDays == days
                                ? Theme.Colors.accentContent
                                : Theme.Colors.textSecondary
                        )
                        .padding(.horizontal, Theme.Spacing.md)
                        .padding(.vertical, Theme.Spacing.xs)
                        .background(
                            Capsule()
                                .fill(vm.selectedDays == days ? Theme.Colors.accentSoft : Color.clear)
                        )
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
    }

    // MARK: - Chart card

    var chartCard: some View {
        VitalCard {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                HStack(alignment: .lastTextBaseline) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text(vm.currentValue)
                            .font(Theme.Typography.numericHero(36))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text(vm.selectedMetric.unit)
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                    Spacer()
                    if let pct = vm.trendDeltaPct {
                        trendChip(pct)
                    }
                    Text(vm.selectedMetric.displayName)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .tracking(0.6)
                }

                if vm.isLoading {
                    HStack {
                        Spacer()
                        ProgressView()
                            .tint(Theme.Colors.accentContent)
                        Spacer()
                    }
                    .frame(height: 180)
                } else if vm.points.isEmpty {
                    emptyChartPlaceholder
                } else {
                    trendChart
                }
            }
        }
    }

    var emptyChartPlaceholder: some View {
        HStack {
            Spacer()
            VStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "chart.line.uptrend.xyaxis")
                    .font(.system(size: 28))
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text("No data yet")
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer()
        }
        .frame(height: 180)
    }

    var trendChart: some View {
        Chart(vm.points) { pt in
            // Area gradient
            AreaMark(
                x: .value("Date", pt.date),
                y: .value("Value", pt.value)
            )
            .interpolationMethod(.catmullRom)
            .foregroundStyle(
                LinearGradient(
                    colors: [
                        Theme.Colors.accent.opacity(0.25),
                        Theme.Colors.accent.opacity(0.00)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )

            // Line
            LineMark(
                x: .value("Date", pt.date),
                y: .value("Value", pt.value)
            )
            .interpolationMethod(.catmullRom)
            .foregroundStyle(Theme.Colors.accentContent)
            .lineStyle(StrokeStyle(lineWidth: 2.5))

            // Point marks
            PointMark(
                x: .value("Date", pt.date),
                y: .value("Value", pt.value)
            )
            .foregroundStyle(Theme.Colors.accentContent)
            .symbolSize(28)
        }
        .chartXAxis {
            // Let Charts choose ~6 evenly-spaced ticks so the axis stays legible
            // across every range (14d → 1Y) instead of overcrowding at 90/365d.
            AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.3))
                    .foregroundStyle(Theme.Colors.glassBorder)
                // Long ranges: month-only labels; short ranges: month + day.
                AxisValueLabel(
                    format: vm.selectedDays > 90
                        ? .dateTime.month(.abbreviated)
                        : .dateTime.month(.abbreviated).day()
                )
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .font(Theme.Typography.labelSmall)
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.3))
                    .foregroundStyle(Theme.Colors.glassBorder)
                AxisValueLabel()
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .font(Theme.Typography.labelSmall)
            }
        }
        .frame(height: 180)
    }

    // MARK: - Stats row

    var statsRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            StatBadge(label: "Latest",  value: vm.currentValue + " " + vm.selectedMetric.unit)
            StatBadge(label: "Average", value: vm.averageValue + " " + vm.selectedMetric.unit)
            StatBadge(label: "Range",   value: vm.rangeLabel.isEmpty ? "--" : vm.rangeLabel)
        }
    }

    // ── Trend chip (first → last change over the visible window) ──────────────

    func trendChip(_ pct: Int) -> some View {
        let rising = pct >= 0
        return HStack(spacing: 2) {
            Image(systemName: rising ? "arrow.up.right" : "arrow.down.right")
                .font(.system(size: 10, weight: .bold))
            Text("\(abs(pct))%")
                .font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(Theme.Colors.accentContent)
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, 3)
        .background(
            Capsule().fill(Theme.Colors.accent.opacity(0.15))
        )
    }

    // ── Range pill labels: compact for long windows ("3M", "1Y") ─────────────

    static func rangeLabel(_ days: Int) -> String {
        switch days {
        case 365: return "1Y"
        case 90:  return "3M"
        default:  return "\(days)d"
        }
    }
}

// MARK: - Trend summary card (Sleep / HRV / Resting HR)

/// The v3 mock's `TrendCard`: title + note row, a big value line, a chart,
/// and a data-driven footnote (optionally with a bold span).
private struct TrendSummaryCard<Chart: View>: View {
    let title: String
    let value: String
    let unit: String?
    let note: String
    let footnote: TrendsSummary.Footnote
    @ViewBuilder var chart: () -> Chart

    var body: some View {
        VitalCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title.uppercased())
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .tracking(1.3)
                    Spacer()
                    Text(note)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                HStack(alignment: .lastTextBaseline, spacing: 6) {
                    Text(value)
                        .font(.system(size: 30, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.textPrimary)
                    if let unit {
                        Text(unit)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
                .padding(.top, Theme.Spacing.sm)

                chart()
                    .padding(.top, Theme.Spacing.lg)

                footnoteView
                    .padding(.top, Theme.Spacing.md)
            }
        }
    }

    @ViewBuilder
    private var footnoteView: some View {
        if let bold = footnote.bold {
            (
                Text(footnote.prefix).foregroundStyle(Theme.Colors.textSecondary)
                + Text(bold).foregroundStyle(Theme.Colors.textPrimary).fontWeight(.semibold)
                + Text(footnote.suffix).foregroundStyle(Theme.Colors.textSecondary)
            )
            .font(.system(size: 13))
        } else {
            Text(footnote.prefix)
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
    }
}

// MARK: - Stat badge

private struct StatBadge: View {
    let label: String
    let value: String

    var body: some View {
        VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.md) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(label.uppercased())
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .tracking(0.5)
                Text(value)
                    .font(Theme.Typography.numericSmall(13))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
