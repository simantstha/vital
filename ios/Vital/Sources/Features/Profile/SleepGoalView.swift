import SwiftUI

/// Pushed from Profile → "Sleep goal". Two settings per the mock: the nightly
/// sleep goal (7.5h / 8h / 8.5h pills) and the lights-out time (compact time
/// picker). Each change persists immediately via PATCH /api/profile —
/// optimistic, reverting with an inline error on failure. The server updates
/// today's still-pending "Lights out" plan row in the same PATCH, so the
/// Today timeline reflects the change without waiting for tomorrow's seed.
struct SleepGoalView: View {
    @ObservedObject var profileVM: ProfileViewModel

    @State private var errorMessage: String?

    private let api = APIClient.shared

    private static let goalOptions: [(label: String, minutes: Int)] = [
        ("7.5h", 450), ("8h", 480), ("8.5h", 510),
    ]

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    Text("Sleep goal")
                        .screenTitleStyle()
                        .foregroundStyle(Theme.Colors.textPrimary)

                    settingsCard

                    if let errorMessage {
                        Text(errorMessage)
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.alert)
                    }

                    Text("Lights out drives the last item on your Today plan.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.xl)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
        }
        // Pushed screen — keep the nav bar (and swipe-back) working, same
        // idiom as DevicesView.
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.Colors.canvas, for: .navigationBar)
    }

    // MARK: - Card

    private var settingsCard: some View {
        VitalCard(padding: 0) {
            VStack(spacing: 0) {
                nightlyGoalRow

                lightsOutRow
                    .overlay(alignment: .top) {
                        Rectangle()
                            .fill(Theme.Colors.glassBorder)
                            .frame(height: 0.5)
                    }
            }
        }
    }

    private var nightlyGoalRow: some View {
        HStack(spacing: Theme.Spacing.md) {
            Text("Nightly goal")
                .font(Theme.Typography.bodyMedium)
                .fontWeight(.medium)
                .foregroundStyle(Theme.Colors.textPrimary)

            Spacer(minLength: Theme.Spacing.sm)

            HStack(spacing: Theme.Spacing.xs) {
                ForEach(Self.goalOptions, id: \.minutes) { option in
                    goalPill(option.label, minutes: option.minutes)
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
    }

    private func goalPill(_ label: String, minutes: Int) -> some View {
        let selected = profileVM.sleepGoalMinutes == minutes
        return Button {
            setSleepGoal(minutes)
        } label: {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(selected ? Theme.Colors.accentContent : Theme.Colors.textSecondary)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.xs + 2)
                .background(
                    Capsule().fill(selected ? Theme.Colors.accentSoft : Theme.Colors.glassFill)
                )
        }
        .buttonStyle(.plain)
    }

    private var lightsOutRow: some View {
        HStack(spacing: Theme.Spacing.md) {
            Text("Lights out")
                .font(Theme.Typography.bodyMedium)
                .fontWeight(.medium)
                .foregroundStyle(Theme.Colors.textPrimary)

            Spacer(minLength: Theme.Spacing.sm)

            DatePicker("Lights out", selection: lightsOutDate, displayedComponents: .hourAndMinute)
                .labelsHidden()
                .datePickerStyle(.compact)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
    }

    // MARK: - Persistence (optimistic)

    private var lightsOutDate: Binding<Date> {
        Binding(
            get: {
                Calendar.current.date(
                    bySettingHour: (profileVM.lightsOutMinutes / 60) % 24,
                    minute: profileVM.lightsOutMinutes % 60,
                    second: 0,
                    of: Date()
                ) ?? Date()
            },
            set: { newDate in
                let comps = Calendar.current.dateComponents([.hour, .minute], from: newDate)
                setLightsOut((comps.hour ?? 22) * 60 + (comps.minute ?? 30))
            }
        )
    }

    private func setSleepGoal(_ minutes: Int) {
        let previous = profileVM.sleepGoalMinutes
        guard minutes != previous else { return }
        profileVM.sleepGoalMinutes = minutes
        errorMessage = nil
        Task {
            do {
                try await api.updateProfile(sleepGoalMinutes: minutes)
            } catch {
                profileVM.sleepGoalMinutes = previous
                errorMessage = "Couldn't save. Try again."
            }
        }
    }

    private func setLightsOut(_ minutes: Int) {
        let previous = profileVM.lightsOutMinutes
        guard minutes != previous else { return }
        profileVM.lightsOutMinutes = minutes
        errorMessage = nil
        Task {
            do {
                try await api.updateProfile(lightsOutMinutes: minutes)
            } catch {
                profileVM.lightsOutMinutes = previous
                errorMessage = "Couldn't save. Try again."
            }
        }
    }
}
