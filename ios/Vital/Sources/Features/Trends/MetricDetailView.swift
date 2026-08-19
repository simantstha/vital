import SwiftUI
import Charts

/// The scrollable drill-in for one Trends metric: a glass header pill, a
/// hero reading, a range picker, the scrubbable chart with its ±1σ band,
/// three summary stats, and (once there's enough history) a distribution
/// histogram. Replaces the PR4 stub.
struct MetricDetailView: View {
    let metricKey: String

    @StateObject private var vm: MetricDetailViewModel
    @ObservedObject private var unitPref = UnitPreference.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Continuous plot-space date from `.chartXSelection` — NOT snapped to a
    /// data point. `snappedPoint` below derives the actual point to render.
    @State private var rawSelection: Date? = nil
    @State private var rangeTapTick = false
    @State private var scrubHapticTick = false

    init(metricKey: String) {
        self.metricKey = metricKey
        _vm = StateObject(wrappedValue: MetricDetailViewModel(metricKey: metricKey))
    }

    private var spec: MetricSpec? { vm.spec }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    header

                    if vm.isLoading && vm.series == nil {
                        loadingState
                            .motionTransition(.fade)
                    } else if let errorMessage = vm.errorMessage {
                        ErrorCard(title: "Couldn't load \(spec?.displayName ?? metricKey)", message: errorMessage) {
                            Task { await vm.load() }
                        }
                        .motionTransition(.fade)
                    } else {
                        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                            heroSection
                            rangePills
                            chartCard
                            statsRow
                            if showDistribution {
                                distributionSection
                            }
                        }
                        .motionTransition(.fade)
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.sm)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task { await vm.load() }
        .onChange(of: vm.range) { _, _ in rawSelection = nil }
        .sensoryFeedback(Theme.Haptics.selection, trigger: rangeTapTick)
        .sensoryFeedback(Theme.Haptics.selection, trigger: scrubHapticTick)
    }
}

// MARK: - Header pill

private extension MetricDetailView {

    /// Two layouts: the normal single-row pill, and — at AX Dynamic Type
    /// sizes — a stacked layout with the title on its own row. The pill's
    /// `HStack` (chevron + title + chip/date, all squeezed into one row)
    /// works at default text sizes but has nowhere to put an AX5-scaled
    /// title and chip side by side without truncating the title; stacking
    /// avoids that rather than clipping either.
    @ViewBuilder
    var header: some View {
        if dynamicTypeSize.isAccessibilitySize {
            GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    HStack {
                        backButton
                        Spacer()
                        headerTrailing
                    }
                    Text(spec?.displayName ?? metricKey)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }
            }
        } else {
            GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.pill) {
                HStack(spacing: Theme.Spacing.sm) {
                    backButton

                    Text(spec?.displayName ?? metricKey)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .lineLimit(1)

                    Spacer(minLength: Theme.Spacing.sm)

                    headerTrailing
                }
            }
        }
    }

    var backButton: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "chevron.left")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back")
    }

    /// Scrubbed values render here, in the header — never a floating
    /// `annotation()`, which would clip at the plot edges and cover the
    /// data being inspected.
    @ViewBuilder
    var headerTrailing: some View {
        if let scrubbedDate = vm.scrubbedDate {
            Text(Self.dayFormatter.string(from: scrubbedDate))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.Colors.textSecondary)
        } else {
            headerChip
        }
    }

    /// Mirrors `MetricTileView.verdictChip`'s tinting rule — never re-derive
    /// the polarity→color mapping outside `TrendDirection.resolve`.
    var headerChip: Chip {
        let polarity = spec?.polarity ?? .neutral
        switch latestVerdict {
        case .above:
            return Chip(text: "↑ above normal", tint: TrendDirection.resolve(polarity, rising: true).color)
        case .below:
            return Chip(text: "↓ below normal", tint: TrendDirection.resolve(polarity, rising: false).color)
        case .normal:
            return Chip(text: "in normal range")
        case .calibrating(let daysRemaining):
            return Chip(text: daysRemaining > 0 ? "\(daysRemaining)d left" : "not enough data")
        case .noData:
            return Chip(text: "no data")
        }
    }
}

// MARK: - Hero + verdict line

private extension MetricDetailView {

    var heroSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(alignment: .lastTextBaseline, spacing: 6) {
                Text(heroValueText)
                    .font(Theme.Typography.numericHero(44))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .contentTransition(.numericText())
                    .animation(Theme.Motion.numeric, value: displayedValue)
                if let unit = spec?.unit(unitPref.current), !unit.isEmpty {
                    Text(unit)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            Text(verdictLineText)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(verdictLineColor)
        }
        .padding(.top, Theme.Spacing.xs)
    }

    var heroValueText: String {
        guard let value = displayedValue else { return "—" }
        return Self.formattedNumber(value, decimals: spec?.decimals ?? 0)
    }

    /// The value the hero + verdict line currently show: the scrubbed
    /// point's value while dragging, otherwise the latest raw reading.
    var displayedValue: Double? { snappedPoint?.value ?? latestRawValue }
    var displayedDate: Date? { snappedPoint?.date ?? rawPoints.last?.date }
    var displayedVerdict: Verdict { evaluate(displayedValue) }

    var verdictLineText: String {
        let text: String
        switch displayedVerdict {
        case .above:   text = "Above your normal"
        case .below:   text = "Below your normal"
        case .normal:  text = "In your normal range"
        case .calibrating(let daysRemaining):
            return daysRemaining > 0 ? "\(daysRemaining) more day\(daysRemaining == 1 ? "" : "s")" : "Not enough variation yet"
        case .noData:
            return "No data yet"
        }
        return "\(text) · \(dateSuffix(displayedDate))"
    }

    var verdictLineColor: Color {
        guard let spec else { return Theme.Colors.textSecondary }
        switch displayedVerdict {
        case .above: return TrendDirection.resolve(spec.polarity, rising: true).color
        case .below: return TrendDirection.resolve(spec.polarity, rising: false).color
        default:     return Theme.Colors.textSecondary
        }
    }

    func dateSuffix(_ date: Date?) -> String {
        guard let date else { return "" }
        return Calendar.current.isDateInToday(date) ? "today" : Self.dayFormatter.string(from: date)
    }
}

// MARK: - Range pills

private extension MetricDetailView {

    var rangePills: some View {
        HStack(spacing: Theme.Spacing.sm) {
            ForEach(TrendsDetailRange.allCases) { range in
                let isOn = vm.range == range
                Button {
                    rangeTapTick.toggle()
                    vm.selectRange(range)
                } label: {
                    Text(range.label)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(isOn ? Theme.Colors.onAccent : Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Spacing.sm)
                        .background(Capsule().fill(isOn ? Theme.Colors.accent : Theme.Colors.glassFill))
                        .overlay(Capsule().strokeBorder(isOn ? .clear : Theme.Colors.glassBorder, lineWidth: 0.5))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(range.accessibilityLabel)
                .accessibilityAddTraits(isOn ? .isSelected : [])
            }
        }
    }
}

// MARK: - Chart card

private extension MetricDetailView {

    /// Chronological, in the metric's display units — decoded once in
    /// `MetricDetailViewModel`/`TrendsViewModel.makeSeries`, never
    /// recomputed per render.
    var rawPoints: [ChartPoint] {
        (vm.series?.points ?? []).sorted { $0.date < $1.date }
    }

    /// What the chart actually draws. `TrendsDownsample.weekly` is a no-op
    /// under 90 points, so this only differs from `rawPoints` for long
    /// windows.
    var chartPoints: [ChartPoint] {
        TrendsDownsample.weekly(rawPoints, calendar: .current)
    }

    var isDownsampled: Bool {
        MetricDetailViewModel.isDownsampled(rawPoints)
    }

    /// The nearest actual `ChartPoint` to the continuous `rawSelection` —
    /// see `MetricDetailViewModel.nearestPoint(to:in:)`'s doc comment for why
    /// this snap is mandatory.
    var snappedPoint: ChartPoint? {
        guard let rawSelection else { return nil }
        return MetricDetailViewModel.nearestPoint(to: rawSelection, in: chartPoints)
    }

    var latestRawValue: Double? { rawPoints.last?.value }

    /// The band is gated on the SAME verdict call the header chip uses —
    /// one source of truth, never re-derived — so the chart and the chip
    /// can never disagree about whether "your normal" is known yet.
    var latestVerdict: Verdict { evaluate(latestRawValue) }

    var showsBand: Bool {
        switch latestVerdict {
        case .calibrating, .noData: return false
        default: return true
        }
    }

    /// `nil` band bounds when `showsBand` is false — same source (the band
    /// gate) `chartYDomain` needs to know whether to tighten to data alone.
    var bandBounds: (lower: Double, upper: Double)? {
        guard showsBand, let series = vm.series, let mean30 = series.baseline?.mean30, let sd30 = series.baseline?.sd30 else {
            return nil
        }
        return (mean30 - sd30, mean30 + sd30)
    }

    /// Explicit Y domain — see `MetricDetailViewModel.chartYDomain`'s doc
    /// comment for why this is mandatory rather than letting Swift Charts
    /// auto-scale. Always computed from `rawPoints`, never `chartPoints`.
    var chartYDomain: ClosedRange<Double> {
        MetricDetailViewModel.chartYDomain(
            rawValues: rawPoints.map(\.value),
            bandLower: bandBounds?.lower,
            bandUpper: bandBounds?.upper,
            floor: spec?.minMeaningfulSD ?? 0.001
        )
    }

    func evaluate(_ value: Double?) -> Verdict {
        guard let value, let series = vm.series, let spec else { return .noData }
        return TrendsVerdict.evaluate(
            latest: value,
            established: series.established,
            dataDays: series.dataDays,
            mean30: series.baseline?.mean30,
            sd30: series.baseline?.sd30,
            minMeaningfulSD: spec.minMeaningfulSD
        )
    }

    var chartCard: some View {
        GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                if chartPoints.isEmpty {
                    EmptyStateView(icon: "chart.xyaxis.line", message: "No data in this range", height: 176)
                } else {
                    chart
                        .frame(height: 176)

                    if showsBand {
                        legend
                    } else {
                        Text("your normal range appears after 14 days")
                            .font(.system(size: 11.5))
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }

                    // Rendering weekly means in the same visual language as
                    // daily readings would claim a precision the data
                    // doesn't have — this label is mandatory whenever
                    // downsampling actually occurred.
                    if isDownsampled {
                        Text("WEEKLY AVERAGE")
                            .font(.system(size: 10, weight: .semibold))
                            .tracking(0.8)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                }
            }
        }
        .onChange(of: snappedPoint?.date) { _, newDate in
            vm.scrubbedDate = newDate
            guard newDate != nil, chartPoints.count <= 60 else { return }
            scrubHapticTick.toggle()
        }
    }

    var chart: some View {
        Chart {
            // 1. Band — mean30 ± sd30. Emitted only when the verdict isn't
            //    gated (same call as the header chip). Bounded by two thin
            //    rule lines at its edges so it reads as a zone with clear
            //    top/bottom, not just a soft wash — this is the shape the
            //    whole feature exists to make visible, so it must win
            //    against the area fill below (whose opacity is cut when the
            //    band is drawn, see step 3).
            if showsBand, let series = vm.series, let mean30 = series.baseline?.mean30, let sd30 = series.baseline?.sd30 {
                let bandLower = mean30 - sd30
                let bandUpper = mean30 + sd30

                RectangleMark(yStart: .value("Lower", bandLower), yEnd: .value("Upper", bandUpper))
                    .foregroundStyle(Theme.Colors.accentContent.opacity(0.16))
                RuleMark(y: .value("Band upper", bandUpper))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Theme.Colors.accentContent.opacity(0.3))
                RuleMark(y: .value("Band lower", bandLower))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Theme.Colors.accentContent.opacity(0.3))

                // 2. Dashed mean line, labelled. Inset a few points from the
                //    plot's trailing edge — flush-right clips the label.
                RuleMark(y: .value("Average", mean30))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 4]))
                    .foregroundStyle(Theme.Colors.textSecondary.opacity(0.55))
                    .annotation(position: .top, alignment: .trailing, spacing: 2) {
                        Text("\(formattedAverage(mean30)) avg")
                            .font(.system(size: 9))
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .padding(.trailing, 6)
                    }
            }

            // 3. Area + line. The area's opacity is cut substantially
            //    whenever the band renders — with a tight Y domain (step 0
            //    above, via `.chartYScale`) the area fills from the domain
            //    floor and would otherwise wash out the band it's meant to
            //    frame. The band must be the more prominent shape.
            ForEach(chartPoints) { point in
                AreaMark(x: .value("Date", point.date), y: .value("Value", point.value))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Theme.Colors.accentContent.opacity(showsBand ? 0.10 : 0.28), Theme.Colors.accentContent.opacity(0)],
                            startPoint: .top, endPoint: .bottom
                        )
                    )
                LineMark(x: .value("Date", point.date), y: .value("Value", point.value))
                    .interpolationMethod(.catmullRom)
                    .lineStyle(StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
                    .foregroundStyle(Theme.Colors.accentContent)
            }

            // 4. PointMark — every point only under 45 marks; above that,
            //    just the latest, to avoid diffing 90+ marks per frame.
            if chartPoints.count <= 45 {
                ForEach(chartPoints) { point in
                    PointMark(x: .value("Date", point.date), y: .value("Value", point.value))
                        .symbolSize(18)
                        .foregroundStyle(Theme.Colors.accentContent)
                }
            } else if let last = chartPoints.last {
                PointMark(x: .value("Date", last.date), y: .value("Value", last.value))
                    .symbolSize(24)
                    .foregroundStyle(Theme.Colors.accentContent)
            }

            // 5. Scrub rule + emphasized point — deliberately NOT wrapped in
            //    `withAnimation`, so it tracks the finger 1:1.
            if let snappedPoint {
                RuleMark(x: .value("Scrub", snappedPoint.date))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Theme.Colors.textPrimary.opacity(0.45))
                PointMark(x: .value("Date", snappedPoint.date), y: .value("Value", snappedPoint.value))
                    .symbolSize(70)
                    .foregroundStyle(Theme.Colors.accentContent)
            }
        }
        .chartXSelection(value: $rawSelection)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .chartYAxis(.hidden)
        .chartYScale(domain: chartYDomain)
        // VoiceOver: a Swift Chart with dozens of marks is otherwise a
        // single opaque image. The descriptor exposes every plotted point
        // for a swipe-through audit; the label/value pair covers the
        // "glance" summary (metric, range, latest, 30-day mean, verdict) and
        // whatever's currently scrubbed.
        .accessibilityChartDescriptor(
            MetricChartDescriptor(
                points: chartPoints,
                metricName: spec?.displayName ?? metricKey,
                spec: spec,
                unitSystem: unitPref.current,
                yDomain: chartYDomain
            )
        )
        .accessibilityLabel(chartAccessibilityLabel)
        .accessibilityValue(chartAccessibilityValue ?? "")
    }

    var chartAccessibilityLabel: String {
        MetricChartAccessibility.summaryLabel(
            metricName: spec?.displayName ?? metricKey,
            rangeLabel: vm.range.accessibilityLabel,
            latest: latestRawValue,
            mean30: vm.series?.baseline?.mean30,
            spec: spec,
            unitSystem: unitPref.current,
            verdict: latestVerdict
        )
    }

    /// `nil` (and the modifier above falls back to an empty string) when
    /// nothing is scrubbed — the label above already states the latest
    /// reading, so there's nothing stale to announce as a "value" until the
    /// user actually starts scrubbing.
    var chartAccessibilityValue: String? {
        guard let snappedPoint else { return nil }
        return MetricChartAccessibility.scrubbedValueText(
            date: snappedPoint.date,
            value: snappedPoint.value,
            spec: spec,
            unitSystem: unitPref.current
        )
    }

    var legend: some View {
        HStack(spacing: Theme.Spacing.md) {
            HStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(Theme.Colors.accentContent.opacity(0.45))
                    .frame(width: 11, height: 8)
                Text("your normal range")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            HStack(spacing: 4) {
                Rectangle()
                    .fill(Theme.Colors.textSecondary.opacity(0.6))
                    .frame(width: 11, height: 2)
                Text("30-day average")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
    }

    func formattedAverage(_ value: Double) -> String {
        guard let spec else { return Self.formattedNumber(value, decimals: 1) }
        return Self.formattedNumber(value, decimals: spec.decimals)
    }
}

// MARK: - Stats row

private extension MetricDetailView {

    var statsRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            StatBadge(label: "Latest", value: formattedStat(latestRawValue))
            StatBadge(label: "30-day avg", value: formattedStat(vm.series?.baseline?.mean30))
            StatBadge(label: "Your normal", value: normalRangeText)
        }
    }

    func formattedStat(_ value: Double?) -> String {
        guard let value, let spec else { return "—" }
        return spec.format(value, unitPref.current)
    }

    var normalRangeText: String {
        guard showsBand, let series = vm.series, let mean30 = series.baseline?.mean30, let sd30 = series.baseline?.sd30, let spec else {
            switch latestVerdict {
            case .calibrating(let daysRemaining):
                return daysRemaining > 0 ? "\(daysRemaining)d left" : "Not enough data"
            default:
                return "—"
            }
        }
        let lo = Self.formattedNumber(mean30 - sd30, decimals: spec.decimals)
        let hi = Self.formattedNumber(mean30 + sd30, decimals: spec.decimals)
        return "\(lo)–\(hi)"
    }
}

// MARK: - Distribution

private extension MetricDetailView {

    /// Gated on the actual number of points in the distribution series — must
    /// have at least 30 real samples in the fixed 90-day window. Below that,
    /// this section is omitted entirely with no placeholder. Also requires the
    /// dedicated 90-day distribution window to have actually arrived —
    /// gating on `vm.series` alone (whose points come from the selected
    /// range) would show the section, briefly or on fetch failure, over an
    /// empty or wrong-window histogram.
    var showDistribution: Bool {
        let sampleCount = vm.distributionSeries?.points.count ?? 0
        return sampleCount >= 30
    }

    @ViewBuilder
    var distributionSection: some View {
        // Always the fixed 90-day window (`vm.distributionSeries`), never
        // `rawPoints` (the selected range) — see
        // `MetricDetailViewModel.distributionSeries`'s doc comment. `latest`
        // is still the true latest raw reading regardless of range/scrub.
        if let spec, let latest = latestRawValue, let distributionValues = vm.distributionSeries?.points.map(\.value) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("DISTRIBUTION")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .tracking(1.3)
                MetricDistributionView(
                    values: distributionValues,
                    latest: latest,
                    spec: spec,
                    unitSystem: unitPref.current
                )
            }
        }
    }
}

// MARK: - Loading

private extension MetricDetailView {

    var loadingState: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Theme.Colors.glassFill)
                .frame(width: 120, height: 44)
            RoundedRectangle(cornerRadius: Theme.Radius.pill, style: .continuous)
                .fill(Theme.Colors.glassFill)
                .frame(height: 36)
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Colors.glassFill)
                .frame(height: 176)
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(0..<3, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .fill(Theme.Colors.glassFill)
                        .frame(height: 56)
                }
            }
        }
        .redacted(reason: .placeholder)
    }
}

// MARK: - Formatting helpers

private extension MetricDetailView {
    static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d"
        return f
    }()

    static func formattedNumber(_ value: Double, decimals: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = decimals
        formatter.usesGroupingSeparator = true
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.\(decimals)f", value)
    }
}
