import SwiftUI

/// The metric detail screen's 14d/30d/3M/1Y range switch: a native-feeling
/// segmented control with a sliding selected capsule
/// (`matchedGeometryEffect`), styled to match `TrendsView`'s own
/// `PeriodSwitcher`. Deliberately a separate type — `TrendsView.swift` is
/// owned by another engineer working in parallel, so this duplicates rather
/// than extracts/shares that private type.
struct DetailRangeSwitcher: View {
    let range: TrendsDetailRange
    /// Called with the newly tapped range. Deliberately not a `Binding` —
    /// the caller (`MetricDetailViewModel.selectRange`) has to run extra
    /// side effects (clearing the scrub, kicking off a reload) beyond
    /// setting the value, so a plain callback keeps this view from being
    /// able to silently bypass that.
    var onSelect: (TrendsDetailRange) -> Void
    @Namespace private var capsuleNamespace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(TrendsDetailRange.allCases) { option in
                let isOn = option == range
                Text(option.label)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(isOn ? Theme.Colors.textPrimary : Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background {
                        if isOn {
                            Capsule()
                                .fill(Theme.Colors.switcherThumb)
                                .shadow(color: Theme.Colors.cardShadow, radius: 3, y: 1)
                                .matchedGeometryEffect(id: "selectedDetailRange", in: capsuleNamespace)
                        }
                    }
                    .contentShape(Capsule())
                    .onTapGesture {
                        guard range != option else { return }
                        onSelect(option)
                    }
                    .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
                    .accessibilityLabel(option.accessibilityLabel)
            }
        }
        .padding(3)
        .background(Capsule().fill(Theme.Colors.glassFill))
        .animation(reduceMotion ? nil : Theme.Motion.snap, value: range)
    }
}
