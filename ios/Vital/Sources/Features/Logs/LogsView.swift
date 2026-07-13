import SwiftUI

/// The Logs tab: a 7-day pager (today ... six days ago) over a unified
/// activity feed, with a per-day diet-budget card (live/tappable for today,
/// read-only for past days) and a hairline-separated entries list.
struct LogsView: View {
    @StateObject private var vm = LogsViewModel()
    @State private var showDietSheet = false

    private var currentDay: LogDay? {
        vm.days.indices.contains(vm.selectedIndex) ? vm.days[vm.selectedIndex] : nil
    }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    headerSection

                    if vm.isLoading && vm.days.isEmpty {
                        HStack {
                            Spacer()
                            ProgressView()
                                .tint(Theme.Colors.accentContent)
                            Spacer()
                        }
                        .padding(.top, 60)
                    } else if let day = currentDay {
                        pagerRow(day)

                        if let data = vm.dietDataByDay[day.dayKey] {
                            DietBudgetCardView(
                                data: data,
                                readOnly: vm.selectedIndex != 0,
                                onTap: vm.selectedIndex == 0 ? { showDietSheet = true } : nil
                            )
                            .padding(.horizontal, Theme.Spacing.xl)
                            .padding(.bottom, Theme.Spacing.lg)
                        }

                        entriesSection(day)
                    }
                }
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .refreshable { await vm.load() }
        }
        .task { await vm.load() }
        .sheet(isPresented: $showDietSheet) {
            VitalSheet(detents: [.large]) {
                DietSheetView(
                    initialTarget: vm.todayTargetKcal,
                    onRefreshToday: { Task { await vm.invalidateTodayMealCache() } }
                )
            }
        }
    }
}

// MARK: - Private sub-views

private extension LogsView {

    var headerSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Logs")
                .screenTitleStyle()
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Everything you and your devices record")
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.top, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.lg)
    }

    func pagerRow(_ day: LogDay) -> some View {
        HStack {
            pagerButton(systemName: "chevron.left", enabled: vm.selectedIndex < vm.days.count - 1) {
                vm.selectDay(vm.selectedIndex + 1)
            }

            Spacer()

            VStack(spacing: 2) {
                Text(day.label)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("\(day.dateLabel) · \(LogsPagerSummary.summaryLine(items: day.items))")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineLimit(1)
            }

            Spacer()

            pagerButton(systemName: "chevron.right", enabled: vm.selectedIndex > 0) {
                vm.selectDay(vm.selectedIndex - 1)
            }
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.lg)
    }

    func pagerButton(systemName: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(enabled ? Theme.Colors.card : Theme.Colors.glassFill)
                    .frame(width: 40, height: 40)
                    .shadow(color: enabled ? Theme.Colors.cardShadow : .clear, radius: 2, x: 0, y: 1)
                Image(systemName: systemName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(enabled ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    func entriesSection(_ day: LogDay) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text("LOG ENTRIES")
                    .font(.system(size: 13, weight: .semibold))
                    .tracking(1.3)
                    .foregroundStyle(Theme.Colors.textSecondary)
                Spacer()
                Text("\(day.items.count) \(day.items.count == 1 ? "entry" : "entries")")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.xs)

            VitalCard(padding: 0) {
                if day.items.isEmpty {
                    Text("Nothing logged this day.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Spacing.xxl)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(day.items.enumerated()), id: \.element.id) { index, item in
                            LogEntryRow(item: item, isFirst: index == 0)
                        }
                    }
                }
            }

            if vm.selectedIndex == 0 {
                Button {
                    showDietSheet = true
                } label: {
                    HStack(spacing: Theme.Spacing.xs) {
                        Image(systemName: "plus")
                            .font(.system(size: 13, weight: .semibold))
                        Text("Add to today's log")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md + 2)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                            .strokeBorder(
                                Theme.Colors.textTertiary.opacity(0.3),
                                style: StrokeStyle(lineWidth: 1, dash: [5])
                            )
                    )
                }
                .buttonStyle(.plain)
                .padding(.top, Theme.Spacing.md)
            }
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.lg)
    }
}

// MARK: - Log entry row

private struct LogEntryRow: View {
    let item: LogDisplayItem
    let isFirst: Bool

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            if let thumb = item.thumbnail {
                Image(uiImage: thumb)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 40, height: 40)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                IconBadge(systemName: item.sfSymbol, style: .soft)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                Text(item.subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: Theme.Spacing.sm)

            Text(item.meta)
                .font(.system(size: 12))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .overlay(alignment: .top) {
            if !isFirst {
                Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5)
            }
        }
    }
}
