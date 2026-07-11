import SwiftUI

/// Notification preferences sheet — modeled on `DietBudgetEditorView`'s
/// sheet shape (NavigationStack + GlassCard sections + toolbar Done). All
/// state is `@AppStorage`-bound (D2: UserDefaults only, no server copy);
/// every change re-triggers `ReminderScheduler.resync()` so the pending
/// local notifications immediately reflect the new settings.
struct NotificationSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var notificationManager = NotificationManager.shared

    @AppStorage(NotificationPrefsKeys.briefEnabled) private var briefEnabled = true
    @AppStorage(NotificationPrefsKeys.briefMinutes) private var briefMinutes = 450

    @AppStorage(NotificationPrefsKeys.mealsEnabled) private var mealsEnabled = true
    @AppStorage(NotificationPrefsKeys.mealsLunchMinutes) private var lunchMinutes = 750
    @AppStorage(NotificationPrefsKeys.mealsDinnerMinutes) private var dinnerMinutes = 1170

    @AppStorage(NotificationPrefsKeys.weighinEnabled) private var weighinEnabled = true
    @AppStorage(NotificationPrefsKeys.weighinWeekday) private var weighinWeekday = 7
    @AppStorage(NotificationPrefsKeys.weighinMinutes) private var weighinMinutes = 480

    private static let weekdaySymbols = Calendar.current.weekdaySymbols

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Colors.canvas.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: Theme.Spacing.lg) {
                        if notificationManager.permissionState == .denied {
                            deniedCard
                        }
                        briefSection
                        mealsSection
                        weighinSection
                    }
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.top, Theme.Spacing.md)
                    .padding(.bottom, 40)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .task {
            await notificationManager.refreshPermissionState()
            // D3: existing users (who predate the onboarding-time ask) get
            // the one-time system prompt when they first open this sheet.
            // Only fires from .notDetermined — a denied user is never
            // re-prompted; they see the "Open Settings" row instead.
            if notificationManager.permissionState == .notDetermined {
                await notificationManager.requestPermission()
                await ReminderScheduler.shared.resync()
            }
        }
    }

    // ── Denied state ─────────────────────────────────────────────────────

    private var deniedCard: some View {
        Button {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        } label: {
            GlassCard {
                HStack(spacing: Theme.Spacing.md) {
                    ZStack {
                        RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                            .fill(Theme.Colors.alert.opacity(0.2))
                            .frame(width: 38, height: 38)
                        Image(systemName: "bell.slash.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.Colors.alert)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Notifications are off")
                            .font(Theme.Typography.bodyMedium)
                            .fontWeight(.medium)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("Open Settings to allow reminders")
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }

                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // ── Morning brief ────────────────────────────────────────────────────

    private var briefSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Morning Brief")
            GlassCard {
                VStack(spacing: Theme.Spacing.md) {
                    Toggle("Remind me", isOn: $briefEnabled)
                        .tint(Theme.Colors.accent)
                        .onChange(of: briefEnabled) { _, _ in resync() }

                    if briefEnabled {
                        Divider().overlay(Theme.Colors.glassBorder)
                        DatePicker("Time", selection: minutesBinding($briefMinutes), displayedComponents: .hourAndMinute)
                            .onChange(of: briefMinutes) { _, _ in resync() }
                    }
                }
            }
        }
    }

    // ── Meal reminders ───────────────────────────────────────────────────

    private var mealsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Meal Reminders")
            GlassCard {
                VStack(spacing: Theme.Spacing.md) {
                    Toggle("Remind me", isOn: $mealsEnabled)
                        .tint(Theme.Colors.accent)
                        .onChange(of: mealsEnabled) { _, _ in resync() }

                    if mealsEnabled {
                        Divider().overlay(Theme.Colors.glassBorder)
                        DatePicker("Lunch", selection: minutesBinding($lunchMinutes), displayedComponents: .hourAndMinute)
                            .onChange(of: lunchMinutes) { _, _ in resync() }
                        DatePicker("Dinner", selection: minutesBinding($dinnerMinutes), displayedComponents: .hourAndMinute)
                            .onChange(of: dinnerMinutes) { _, _ in resync() }
                    }
                }
            }
        }
    }

    // ── Weekly weigh-in ──────────────────────────────────────────────────

    private var weighinSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Weekly Weigh-In")
            GlassCard {
                VStack(spacing: Theme.Spacing.md) {
                    Toggle("Remind me", isOn: $weighinEnabled)
                        .tint(Theme.Colors.accent)
                        .onChange(of: weighinEnabled) { _, _ in resync() }

                    if weighinEnabled {
                        Divider().overlay(Theme.Colors.glassBorder)
                        Picker("Day", selection: $weighinWeekday) {
                            ForEach(1...7, id: \.self) { weekday in
                                Text(Self.weekdaySymbols[weekday - 1]).tag(weekday)
                            }
                        }
                        .onChange(of: weighinWeekday) { _, _ in resync() }
                        DatePicker("Time", selection: minutesBinding($weighinMinutes), displayedComponents: .hourAndMinute)
                            .onChange(of: weighinMinutes) { _, _ in resync() }
                    }
                }
            }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /// Converts an `@AppStorage` "minutes since midnight" `Int` into a
    /// `Date` binding for `DatePicker(.hourAndMinute)` — the picker only
    /// reads/writes the hour and minute components, so the calendar day
    /// carried by the intermediate `Date` is irrelevant.
    private func minutesBinding(_ minutes: Binding<Int>) -> Binding<Date> {
        Binding<Date>(
            get: {
                var components = DateComponents()
                components.hour = minutes.wrappedValue / 60
                components.minute = minutes.wrappedValue % 60
                return Calendar.current.date(from: components) ?? Date()
            },
            set: { newDate in
                let components = Calendar.current.dateComponents([.hour, .minute], from: newDate)
                minutes.wrappedValue = (components.hour ?? 0) * 60 + (components.minute ?? 0)
            }
        )
    }

    private func resync() {
        Task { await ReminderScheduler.shared.resync() }
    }
}
