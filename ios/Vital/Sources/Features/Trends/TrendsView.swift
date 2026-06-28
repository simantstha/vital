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
                    metricPicker
                    daysPicker
                    chartCard
                    statsRow
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.lg)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
        }
        .task { await vm.load() }
        .onChange(of: vm.selectedMetric) { _ in Task { await vm.load() } }
        .onChange(of: vm.selectedDays)   { _ in Task { await vm.load() } }
    }
}

// MARK: - Sections

private extension TrendsView {

    var headerSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Trends")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Track your metrics over time")
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
    }

    var metricPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(TrendMetric.allCases) { metric in
                    Button {
                        vm.selectedMetric = metric
                    } label: {
                        Text(metric.displayName)
                            .font(.system(size: 14, weight: vm.selectedMetric == metric ? .semibold : .regular))
                            .foregroundStyle(
                                vm.selectedMetric == metric
                                    ? Theme.Colors.onAccent
                                    : Theme.Colors.textSecondary
                            )
                            .padding(.horizontal, Theme.Spacing.lg)
                            .padding(.vertical, Theme.Spacing.sm)
                            .background(
                                RoundedRectangle(cornerRadius: Theme.Radius.pill, style: .continuous)
                                    .fill(vm.selectedMetric == metric
                                          ? Theme.Colors.accent
                                          : Theme.Colors.glassFill)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: Theme.Radius.pill, style: .continuous)
                                            .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                                    )
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    var daysPicker: some View {
        HStack(spacing: Theme.Spacing.sm) {
            ForEach([14, 30], id: \.self) { days in
                Button {
                    vm.selectedDays = days
                } label: {
                    Text("\(days)d")
                        .font(.system(size: 13, weight: vm.selectedDays == days ? .semibold : .regular))
                        .foregroundStyle(
                            vm.selectedDays == days
                                ? Theme.Colors.accent
                                : Theme.Colors.textSecondary
                        )
                        .padding(.horizontal, Theme.Spacing.md)
                        .padding(.vertical, Theme.Spacing.xs)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                .fill(vm.selectedDays == days
                                      ? Theme.Colors.accent.opacity(0.15)
                                      : Color.clear)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                        .strokeBorder(
                                            vm.selectedDays == days
                                                ? Theme.Colors.accent.opacity(0.4)
                                                : Theme.Colors.glassBorder,
                                            lineWidth: 0.5
                                        )
                                )
                        )
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
    }

    // MARK: - Chart card

    var chartCard: some View {
        GlassCard {
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
            AxisMarks(values: .stride(by: .day, count: vm.selectedDays == 14 ? 4 : 7)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.3))
                    .foregroundStyle(Theme.Colors.glassBorder)
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
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
            StatBadge(label: "Latest", value: vm.currentValue + " " + vm.selectedMetric.unit)
            StatBadge(label: "Range", value: vm.rangeLabel.isEmpty ? "--" : vm.rangeLabel)
            StatBadge(label: "Period", value: "\(vm.selectedDays) days")
        }
    }
}

// MARK: - Stat badge

private struct StatBadge: View {
    let label: String
    let value: String

    var body: some View {
        GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.md) {
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
