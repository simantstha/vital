import SwiftUI

struct LogsView: View {
    @StateObject private var vm = LogsViewModel()

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    headerSection

                    if vm.isLoading {
                        HStack {
                            Spacer()
                            ProgressView()
                                .tint(Theme.Colors.accent)
                            Spacer()
                        }
                        .padding(.top, 60)
                    } else if vm.groups.isEmpty {
                        emptyState
                    } else {
                        ForEach(vm.groups) { group in
                            daySection(group)
                        }
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.lg)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .refreshable { await vm.load() }
        }
        .task { await vm.load() }
    }
}

// MARK: - Private sub-views

private extension LogsView {

    var headerSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Logs")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Last 7 days of activity")
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
    }

    var emptyState: some View {
        HStack {
            Spacer()
            VStack(spacing: Theme.Spacing.md) {
                Image(systemName: "list.bullet.clipboard")
                    .font(.system(size: 36))
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text("No activity logged yet")
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer()
        }
        .padding(.top, 80)
    }

    func daySection(_ group: LogDayGroup) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: group.displayLabel)

            ForEach(group.items) { item in
                LogRowView(item: item)
            }
        }
    }
}

// MARK: - Log row

private struct LogRowView: View {
    let item: LogDisplayItem

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            // Icon badge — or photo thumbnail when the log has one
            ZStack {
                if let thumb = item.thumbnail {
                    Image(uiImage: thumb)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 40, height: 40)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
                } else {
                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                        .fill(item.accentColor.opacity(0.15))
                        .frame(width: 40, height: 40)
                    Image(systemName: item.sfSymbol)
                        .font(.system(size: 16))
                        .foregroundStyle(item.accentColor)
                }
            }

            // Text stack
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(item.title)
                    .font(Theme.Typography.bodySmall)
                    .fontWeight(.medium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)

                Text(item.subtitle)
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(1)
            }

            Spacer()

            // Relative time
            Text(item.relativeTime)
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .monospacedDigit()
        }
        .padding(Theme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Colors.glassFill)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                )
        )
    }
}
