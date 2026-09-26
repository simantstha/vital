import SwiftUI
import Charts

/// The scrollable drill-in for one Trends metric: a standard nav-bar title
/// (so edge-swipe back and the zoom transition both work), a hero reading
/// with a delta pill vs normal, an on-device insight line, a "what it means
/// today" card, the range picker, the scrubbable chart with its ±1σ band,
/// an interactive Low/Average/High/Normal stats row, a distribution
/// histogram, and (Phase 5) "Moves with it", "Your records", "About", and
/// "Ask your coach" sections.
struct MetricDetailView: View {
    let metricKey: String

    @StateObject private var vm: MetricDetailViewModel
    @ObservedObject private var unitPref = UnitPreference.shared

    /// Continuous plot-space date from `.chartXSelection` — NOT snapped to a
    /// data point. `snappedPoint` below derives the actual point to render.
    @State private var rawSelection: Date? = nil
    @State private var rangeTapTick = false
    @State private var scrubHapticTick = false
    @State private var statTapTick = false

    /// Which stats-row button is currently highlighting the chart, if any —
    /// tapping the same one again clears it (see `statButton(_:label:value:)`).
    @State private var statSelection: StatSelection? = nil

    enum StatSelection: Equatable {
        case low, average, high
    }

    init(metricKey: String) {
        self.metricKey = metricKey
        _vm = StateObject(wrappedValue: MetricDetailViewModel(metricKey: metricKey))
    }

    private var spec: MetricSpec? { vm.spec }
    private var displayName: String { spec?.displayName ?? metricKey }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if vm.isLoading && vm.series == nil {
                        loadingState
                            .motionTransition(.fade)
                    } else if let errorMessage = vm.errorMessage {
                        ErrorCard(title: "Couldn't load \(displayName)", message: errorMessage) {
                            Task { await vm.load() }
                        }
                        .motionTransition(.fade)
                    } else {
                        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                            heroSection
                            if let meaningText {
                                meaningCard(meaningText)
                            }
                            if isCalibrating {
                                stillLearningCard
                            }
                            if let insightText {
                                Text(insightText)
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(Theme.Colors.textSecondary)
                            }
                            DetailRangeSwitcher(range: vm.range) { newRange in
                                rangeTapTick.toggle()
                                vm.selectRange(newRange)
                            }
                            chartCard
                            statsRow
                            if showDistribution {
                                distributionSection
                            }
                            if !movesWithItKeys.isEmpty {
                                movesWithItSection
                            }
                            if let recordsResult {
                                recordsSection(recordsResult)
                            }
                            if let aboutCopy = MetricAbout.copy(for: metricKey) {
                                aboutSection(aboutCopy)
                            }
                            askCoachSection
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
        .navigationTitle(displayName)
        .navigationBarTitleDisplayMode(.large)
        .task { await vm.load() }
        .onChange(of: vm.range) { _, _ in
            rawSelection = nil
            statSelection = nil
        }
        .sensoryFeedback(Theme.Haptics.selection, trigger: rangeTapTick)
        .sensoryFeedback(Theme.Haptics.selection, trigger: scrubHapticTick)
        .sensoryFeedback(Theme.Haptics.selection, trigger: statTapTick)
    }
}

// MARK: - Hero

private extension MetricDetailView {

    var heroSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
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
            if let deltaPillText {
                Text(deltaPillText)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(deltaPillColor)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(deltaPillColor.opacity(0.16)))
            }
            Text(dateCaptionText)
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .padding(.top, Theme.Spacing.xs)
        .accessibilityElement(children: .combine)
    }

    var heroValueText: String {
        guard let value = displayedValue else { return "—" }
        return TrendsDeltaFormat.formattedNumber(value, decimals: spec?.decimals ?? 0)
    }

    /// The value the hero + delta pill currently show: the scrubbed point's
    /// value while dragging, otherwise the latest raw reading.
    var displayedValue: Double? { snappedPoint?.value ?? latestRawValue }
    var displayedDate: Date? { snappedPoint?.date ?? rawPoints.last?.date }
    var displayedVerdict: Verdict { evaluate(displayedValue) }

    /// "↑ 7 ms above your normal" / "↓ 3 bpm below your normal" / "In your
    /// normal range" — `nil` while calibrating or with no data, when there's
    /// no "normal" yet to compare against.
    var deltaPillText: String? {
        switch displayedVerdict {
        case .above, .below:
            guard let spec, let value = displayedValue, let mean30 = vm.series?.baseline?.mean30 else { return nil }
            let delta = value - mean30
            let arrow = TrendsDeltaFormat.arrow(delta)
            let magnitude = TrendsDeltaFormat.magnitudeText(delta, spec: spec, system: unitPref.current, includeUnit: true)
            let direction = delta >= 0 ? "above" : "below"
            return "\(arrow) \(magnitude) \(direction) your normal"
        case .normal:
            return "In your normal range"
        case .calibrating, .noData:
            return nil
        }
    }

    var deltaPillColor: Color {
        guard let spec else { return Theme.Colors.textSecondary }
        switch displayedVerdict {
        case .above: return TrendDirection.resolve(spec.polarity, rising: true).color
        case .below: return TrendDirection.resolve(spec.polarity, rising: false).color
        default:     return Theme.Colors.textSecondary
        }
    }

    /// "today" for the latest reading, otherwise the scrubbed day spelled
    /// out — e.g. "Tue, Sep 22". Replaces the old header pill's date chip.
    var dateCaptionText: String {
        guard let displayedDate else { return "" }
        return Calendar.current.isDateInToday(displayedDate) ? "today" : Self.dayFormatter.string(from: displayedDate)
    }
}

// MARK: - What it means today

private extension MetricDetailView {

    var relatedVerdict: Verdict? {
        guard let relatedKey = MetricRelatedMetrics.primaryRelated(for: metricKey),
              let relatedSeries = vm.relatedSeries[relatedKey] else { return nil }
        return MetricDetailViewModel.verdict(for: relatedSeries, spec: MetricCatalog.spec(for: relatedKey))
    }

    var meaningText: String? {
        MetricMeaning.message(metricKey: metricKey, verdict: latestVerdict, relatedVerdict: relatedVerdict)
    }

    func meaningCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("WHAT IT MEANS TODAY")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(Color.white.opacity(0.6))
            Text(text)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.white)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.lg)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Self.meaningCardFill)
        )
        .accessibilityElement(children: .combine)
    }

    static let meaningCardFill = Color(red: 0.067, green: 0.086, blue: 0.114)
}

// MARK: - Still learning (calibrating)

private extension MetricDetailView {

    var isCalibrating: Bool {
        if case .calibrating = latestVerdict { return true }
        return false
    }

    var calibratingDaysRemaining: Int {
        if case .calibrating(let daysRemaining) = latestVerdict { return daysRemaining }
        return 0
    }

    var calibratingDaysElapsed: Int { max(0, min(14, 14 - calibratingDaysRemaining)) }

    var stillLearningCard: some View {
        GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
            HStack(spacing: Theme.Spacing.md) {
                calibrationRing
                VStack(alignment: .leading, spacing: 4) {
                    Text("Still learning your normal")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(stillLearningCopy)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    var stillLearningCopy: String {
        let remaining = calibratingDaysRemaining
        let noun = remaining == 1 ? "night" : "nights"
        return "\(remaining) more \(noun) and I'll know what's typical for you."
    }

    var calibrationRing: some View {
        ZStack {
            Circle()
                .stroke(Theme.Colors.progressTrack, lineWidth: 4)
            Circle()
                .trim(from: 0, to: min(1, Double(calibratingDaysElapsed) / 14))
                .stroke(Theme.Colors.accentContent, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(Theme.Motion.settle, value: calibratingDaysElapsed)
            Text("\(calibratingDaysElapsed)/14")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
        .frame(width: 48, height: 48)
    }
}

// MARK: - Insight

private extension MetricDetailView {
    var insightText: String? {
        MetricInsight.compute(points: rawPoints, mean30: vm.series?.baseline?.mean30, sd30: vm.series?.baseline?.sd30)
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

    /// The band is gated on the SAME verdict call the hero delta pill uses —
    /// one source of truth, never re-derived — so the chart and the pill can
    /// never disagree about whether "your normal" is known yet.
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

                    if isCalibrating {
                        Text("Readings so far — no range yet, so no judgement yet.")
                            .font(.system(size: 11.5))
                            .foregroundStyle(Theme.Colors.textTertiary)
                    } else if showsBand {
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
            //    gated (same call as the hero pill). Bounded by two thin
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

            // 4. Latest-point halo, drawn behind the small per-point marks
            //    below so it reads as a soft glow rather than another dot.
            if let last = chartPoints.last {
                PointMark(x: .value("Date", last.date), y: .value("Value", last.value))
                    .symbolSize(160)
                    .foregroundStyle(Theme.Colors.accentContent.opacity(0.18))
            }

            // 5. PointMark — every point only under 45 marks; above that,
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

            // 6. Stats-row emphasis — Low/High highlight a point + rule,
            //    Average highlights the range's own mean line. Cleared by
            //    tapping the same stat button again.
            statSelectionMarks

            // 7. Scrub rule + emphasized point (with its own halo) —
            //    deliberately NOT wrapped in `withAnimation`, so it tracks
            //    the finger 1:1.
            if let snappedPoint {
                RuleMark(x: .value("Scrub", snappedPoint.date))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Theme.Colors.textPrimary.opacity(0.45))
                PointMark(x: .value("Date", snappedPoint.date), y: .value("Value", snappedPoint.value))
                    .symbolSize(160)
                    .foregroundStyle(Theme.Colors.textPrimary.opacity(0.12))
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
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine()
                    .foregroundStyle(Theme.Colors.textTertiary.opacity(0.15))
                AxisValueLabel {
                    if let doubleValue = value.as(Double.self) {
                        Text(TrendsDeltaFormat.formattedNumber(doubleValue, decimals: spec?.decimals ?? 0))
                            .font(.system(size: 9))
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                }
            }
        }
        .chartYScale(domain: chartYDomain)
        // Range change morphs the chart in place rather than cross-fading —
        // the surrounding content stays mounted (no `.motionTransition` on
        // this subtree), so this is the only animation driving the swap.
        .animation(.smooth, value: vm.range)
        // VoiceOver: a Swift Chart with dozens of marks is otherwise a
        // single opaque image. The descriptor exposes every plotted point
        // for a swipe-through audit; the label/value pair covers the
        // "glance" summary (metric, range, latest, 30-day mean, verdict) and
        // whatever's currently scrubbed.
        .accessibilityChartDescriptor(
            MetricChartDescriptor(
                points: chartPoints,
                metricName: displayName,
                spec: spec,
                unitSystem: unitPref.current,
                yDomain: chartYDomain
            )
        )
        .accessibilityLabel(chartAccessibilityLabel)
        .accessibilityValue(chartAccessibilityValue ?? "")
    }

    /// Isolated so the `if`/`else if`/`else` in `chart` above stays a single
    /// content expression rather than a switch-with-branches-that-differ
    /// inline — each case here just returns `ChartContent`.
    @ChartContentBuilder
    var statSelectionMarks: some ChartContent {
        if statSelection == .low, let point = rangeLowPoint {
            RuleMark(y: .value("Low", point.value))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                .foregroundStyle(Theme.Colors.alert.opacity(0.6))
            PointMark(x: .value("Date", point.date), y: .value("Value", point.value))
                .symbolSize(90)
                .foregroundStyle(Theme.Colors.alert)
        } else if statSelection == .high, let point = rangeHighPoint {
            RuleMark(y: .value("High", point.value))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                .foregroundStyle(Theme.Colors.positive.opacity(0.6))
            PointMark(x: .value("Date", point.date), y: .value("Value", point.value))
                .symbolSize(90)
                .foregroundStyle(Theme.Colors.positive)
        } else if statSelection == .average, let average = rangeAverage {
            RuleMark(y: .value("Range average", average))
                .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [1, 4]))
                .foregroundStyle(Theme.Colors.textPrimary.opacity(0.7))
        }
    }

    var chartAccessibilityLabel: String {
        MetricChartAccessibility.summaryLabel(
            metricName: displayName,
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
        TrendsDeltaFormat.formattedNumber(value, decimals: spec?.decimals ?? 1)
    }
}

// MARK: - Stats row

private extension MetricDetailView {

    var rangeLowPoint: ChartPoint? { rawPoints.min { $0.value < $1.value } }
    var rangeHighPoint: ChartPoint? { rawPoints.max { $0.value < $1.value } }
    var rangeAverage: Double? {
        guard !rawPoints.isEmpty else { return nil }
        return rawPoints.reduce(0) { $0 + $1.value } / Double(rawPoints.count)
    }

    var statsRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            statButton(.low, label: "Low", value: formattedStat(rangeLowPoint?.value))
            statButton(.average, label: "Average", value: formattedStat(rangeAverage))
            statButton(.high, label: "High", value: formattedStat(rangeHighPoint?.value))
            StatBadge(label: "Normal (range)", value: normalRangeText)
        }
    }

    func statButton(_ selection: StatSelection, label: String, value: String) -> some View {
        let isOn = statSelection == selection
        return Button {
            statTapTick.toggle()
            statSelection = isOn ? nil : selection
        } label: {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(label.uppercased())
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(isOn ? Theme.Colors.accentContent : Theme.Colors.textSecondary)
                    .tracking(0.5)
                Text(value)
                    .font(Theme.Typography.numericSmall(13))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(Theme.Colors.card)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .strokeBorder(isOn ? Theme.Colors.accentContent : .clear, lineWidth: 1.5)
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityLabel("\(label), \(value)\(isOn ? ", selected" : "")")
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
        let lo = TrendsDeltaFormat.formattedNumber(mean30 - sd30, decimals: spec.decimals)
        let hi = TrendsDeltaFormat.formattedNumber(mean30 + sd30, decimals: spec.decimals)
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

// MARK: - Moves with it

private extension MetricDetailView {

    var movesWithItKeys: [String] { MetricRelatedMetrics.relatedKeys(for: metricKey) }

    var movesWithItSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            sectionHeader("MOVES WITH IT")
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(movesWithItKeys, id: \.self) { key in
                    movesWithItRow(key)
                }
            }
        }
    }

    func movesWithItRow(_ key: String) -> some View {
        let relatedSpec = MetricCatalog.spec(for: key)
        let series = vm.relatedSeries[key]
        let sortedPoints = (series?.points ?? []).sorted { $0.date < $1.date }
        let latest = sortedPoints.last?.value
        let name = relatedSpec?.displayName ?? key
        let valueText = latest.map { relatedSpec?.format($0, unitPref.current) ?? "\($0)" } ?? "—"

        return GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.md) {
            HStack(spacing: Theme.Spacing.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(valueText)
                        .font(Theme.Typography.numericSmall(15))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                Spacer()
                Sparkline(
                    values: sortedPoints.map { Optional($0.value) },
                    style: relatedSpec?.sparkline ?? .line,
                    tint: Theme.Colors.accentContent,
                    height: 32
                )
                .frame(width: 90)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(valueText)")
    }
}

// MARK: - Your records

private extension MetricDetailView {

    var recordsResult: MetricRecords.Result? {
        guard let distributionPoints = vm.distributionSeries?.points, !distributionPoints.isEmpty else { return nil }
        return MetricRecords.compute(
            points: distributionPoints,
            mean30: vm.distributionSeries?.baseline?.mean30,
            sd30: vm.distributionSeries?.baseline?.sd30
        )
    }

    func recordsSection(_ result: MetricRecords.Result) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            sectionHeader("YOUR RECORDS (90 DAYS)")
            GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    HStack(spacing: Theme.Spacing.md) {
                        recordCell(label: "Highest", record: result.highest)
                        recordCell(label: "Lowest", record: result.lowest)
                    }
                    if let streakText = result.streakText {
                        Text(streakText)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
            }
        }
    }

    func recordCell(label: String, record: MetricRecords.Record) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .tracking(0.5)
            Text(formattedStat(record.value))
                .font(Theme.Typography.numericSmall(15))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text(Self.dayFormatter.string(from: record.date))
                .font(.system(size: 11))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - About

private extension MetricDetailView {

    func aboutSection(_ copy: MetricAbout.Copy) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            sectionHeader("ABOUT \(displayName.uppercased())")
            GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text(copy.body)
                        .font(.system(size: 13.5))
                        .foregroundStyle(Theme.Colors.textSecondary)
                    DisclosureGroup("How it's measured") {
                        Text(copy.measurement)
                            .font(.system(size: 12.5))
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .padding(.top, Theme.Spacing.xs)
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .tint(Theme.Colors.textPrimary)
                }
            }
        }
    }
}

// MARK: - Ask your coach

private extension MetricDetailView {

    var askCoachSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            sectionHeader("ASK YOUR COACH")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.sm) {
                    ForEach(MetricRelatedMetrics.coachQuestions(for: metricKey, displayName: displayName), id: \.self) { question in
                        Button {
                            AppRouter.shared.coachContext = question
                        } label: {
                            Text(question)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.Colors.textPrimary)
                                .padding(.horizontal, Theme.Spacing.md)
                                .padding(.vertical, Theme.Spacing.sm)
                                .background(Capsule().fill(Theme.Colors.glassFill))
                                .overlay(Capsule().strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5))
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens Coach with this question")
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }
}

// MARK: - Shared section header

private extension MetricDetailView {
    func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Theme.Colors.textSecondary)
            .tracking(1.3)
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
}
