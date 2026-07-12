import SwiftUI

/// Bottom-sheet content for adding a user-defined item to today's plan.
/// Mirrors the mock's `AddItemSheet`: a 4-way type picker, a title field, a
/// time picker with quick-time pills, and Cancel/Add pill buttons.
///
/// Presented inside a `VitalSheet` by the caller (see `TodayView`).
struct AddPlanItemSheet: View {
    var onAdd: (PlanItem) -> Void
    var onCancel: () -> Void

    private enum ItemType: CaseIterable, Hashable {
        case meal, move, rest, other

        var label: String {
            switch self {
            case .meal:  return "Meal"
            case .move:  return "Move"
            case .rest:  return "Rest"
            case .other: return "Other"
            }
        }
        var sfSymbol: String {
            switch self {
            case .meal:  return "fork.knife"
            case .move:  return "figure.walk"
            case .rest:  return "moon"
            case .other: return "circle"
            }
        }
        var kind: PlanItem.Kind {
            switch self {
            case .meal:  return .meal
            case .move:  return .move
            case .rest:  return .rest
            case .other: return .other
            }
        }
    }

    @State private var type: ItemType = .meal
    @State private var title: String = ""
    @State private var time: Date = Self.defaultTime
    @FocusState private var titleFocused: Bool

    private static var defaultTime: Date {
        var comps = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        comps.hour = 20
        comps.minute = 0
        return Calendar.current.date(from: comps) ?? Date()
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            Text("Add to today")
                .font(.system(size: 18, weight: .bold))
                .tracking(-0.2)
                .foregroundStyle(Theme.Colors.textPrimary)

            typePicker

            TextField("What is it? e.g. Protein shake", text: $title)
                .focused($titleFocused)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textPrimary)
                .tint(Theme.Colors.accentContent)
                .submitLabel(.done)
                .padding(Theme.Spacing.md + 2)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.md + 2, style: .continuous)
                        .fill(Theme.Colors.card)
                        .shadow(color: Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
                )

            timeRow

            buttons
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.xxl)
        .onAppear { titleFocused = true }
    }

    private var typePicker: some View {
        HStack(spacing: Theme.Spacing.sm) {
            ForEach(ItemType.allCases, id: \.self) { candidate in
                let selected = candidate == type
                Button {
                    type = candidate
                } label: {
                    VStack(spacing: Theme.Spacing.xs) {
                        Image(systemName: candidate.sfSymbol)
                            .font(.system(size: 17, weight: .medium))
                        Text(candidate.label)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(selected ? Theme.Colors.accentContent : Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                            .fill(selected ? Theme.Colors.accentSoft : Theme.Colors.card)
                            .shadow(color: selected ? .clear : Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var timeRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "clock")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textSecondary)
                DatePicker("", selection: $time, displayedComponents: .hourAndMinute)
                    .labelsHidden()
                    .datePickerStyle(.compact)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm + 2)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.Colors.card)
                    .shadow(color: Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
            )

            ForEach([18, 20, 21], id: \.self) { hour in
                quickTimePill(hour: hour)
            }
        }
    }

    private func quickTimePill(hour: Int) -> some View {
        let isSelected = Calendar.current.component(.hour, from: time) == hour
            && Calendar.current.component(.minute, from: time) == 0
        let label = hour > 12 ? "\(hour - 12) PM" : "\(hour) PM"

        return Button {
            var comps = Calendar.current.dateComponents([.year, .month, .day], from: time)
            comps.hour = hour
            comps.minute = 0
            time = Calendar.current.date(from: comps) ?? time
        } label: {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(isSelected ? Theme.Colors.accentContent : Theme.Colors.textSecondary)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.sm + 2)
                .background(Capsule().fill(isSelected ? Theme.Colors.accentSoft : Theme.Colors.glassFill))
        }
        .buttonStyle(.plain)
    }

    private var buttons: some View {
        HStack(spacing: Theme.Spacing.md) {
            Button(action: onCancel) {
                Text("Cancel")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md + 2)
                    .background(Capsule().fill(Theme.Colors.glassFill))
            }

            Button {
                add()
            } label: {
                Text("Add")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(trimmedTitle.isEmpty ? Theme.Colors.textTertiary : Theme.Colors.card)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md + 2)
                    .background(Capsule().fill(trimmedTitle.isEmpty ? Theme.Colors.glassFill : Theme.Colors.textPrimary))
            }
            .disabled(trimmedTitle.isEmpty)
        }
        .padding(.top, Theme.Spacing.xs)
    }

    private func add() {
        guard !trimmedTitle.isEmpty else { return }
        let comps = Calendar.current.dateComponents([.hour, .minute], from: time)
        let minutes = (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
        let item = PlanItem(
            timeMinutes: minutes,
            title: trimmedTitle,
            subtitle: "Added by you",
            sfSymbol: type.sfSymbol,
            status: .later,
            source: .user,
            kind: type.kind
        )
        onAdd(item)
    }
}
