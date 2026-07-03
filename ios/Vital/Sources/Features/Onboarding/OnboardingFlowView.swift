import SwiftUI

/// Onboarding questionnaire: Basics → Goal → Training → HealthSafety →
/// Lifestyle → CoachIntro → Calibrating. Presented by RootView once a user
/// is authenticated but not yet onboarded (see Phase 5 of the ios-pivot
/// plan). HealthKit permission is requested once, at flow start.
struct OnboardingFlowView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel
    @EnvironmentObject private var backfillCoordinator: BackfillCoordinator
    @StateObject private var vm = OnboardingViewModel()

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            VStack(spacing: 0) {
                progressHeader
                stepContent
            }
        }
        .task {
            await vm.begin(authViewModel: authViewModel)
        }
    }

    private var progressHeader: some View {
        HStack(spacing: Theme.Spacing.xs) {
            ForEach(OnboardingViewModel.Step.allCases, id: \.self) { candidate in
                Capsule()
                    .fill(candidate.rawValue <= vm.step.rawValue
                          ? Theme.Colors.accent
                          : Theme.Colors.glassFill)
                    .frame(height: 4)
            }
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.top, Theme.Spacing.lg)
        .padding(.bottom, Theme.Spacing.sm)
    }

    @ViewBuilder
    private var stepContent: some View {
        switch vm.step {
        case .basics:
            BasicsStepView(vm: vm)
        case .goal:
            GoalStepView(vm: vm)
        case .training:
            TrainingStepView(vm: vm)
        case .healthSafety:
            HealthSafetyStepView(vm: vm)
        case .lifestyle:
            LifestyleStepView(vm: vm)
        case .coachIntro:
            CoachIntroStepView(vm: vm)
        case .calibrating:
            CalibratingStepView(vm: vm)
                .environmentObject(authViewModel)
                .environmentObject(backfillCoordinator)
        }
    }
}

// MARK: - Shared step scaffold

/// Title + scrollable form content + a pinned Continue (and optional Back)
/// button — the shared shell every data-collection step uses.
private struct StepScaffold<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    var continueTitle: String = "Continue"
    var continueDisabled: Bool = false
    var isBusy: Bool = false
    let onContinue: () -> Void
    var onBack: (() -> Void)? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text(title)
                            .font(Theme.Typography.titleLarge)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        if let subtitle {
                            Text(subtitle)
                                .font(Theme.Typography.bodyMedium)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    content()
                }
                .padding(Theme.Spacing.xl)
            }
            .scrollDismissesKeyboard(.interactively)

            VStack(spacing: Theme.Spacing.sm) {
                Button(action: onContinue) {
                    HStack {
                        if isBusy {
                            ProgressView().tint(Theme.Colors.onAccent)
                        } else {
                            Text(continueTitle)
                                .font(.system(size: 16, weight: .semibold))
                        }
                    }
                    .foregroundStyle(Theme.Colors.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(continueDisabled ? Theme.Colors.accent.opacity(0.3) : Theme.Colors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                }
                .disabled(continueDisabled || isBusy)

                if let onBack {
                    Button("Back", action: onBack)
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.bottom, Theme.Spacing.lg)
        }
    }
}

/// Uppercase field label + content, used above every text field / chip row.
private struct FieldLabel<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(title.uppercased())
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .tracking(0.6)
            content()
        }
    }
}

private extension View {
    /// Glass-bordered text field surface matching the design system's
    /// existing glassFill/glassBorder treatment (see GlassCard, MealRowView).
    func onboardingFieldSurface() -> some View {
        padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(Theme.Colors.glassFill)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                    )
            )
    }
}

/// A row of selectable chips, single- or multi-select depending on caller.
private struct ChipPicker: View {
    let options: [(value: String, label: String)]
    let isSelected: (String) -> Bool
    let onTap: (String) -> Void

    var body: some View {
        FlowLayout(spacing: Theme.Spacing.sm) {
            ForEach(options, id: \.value) { option in
                Chip(text: option.label, isAccent: isSelected(option.value))
                    .onTapGesture { onTap(option.value) }
            }
        }
    }
}

/// Minimal wrapping layout for chip rows so multi-option groups don't get
/// clipped inside a fixed HStack.
private struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var totalHeight: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth + size.width > maxWidth, rowWidth > 0 {
                totalHeight += rowHeight + spacing
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        totalHeight += rowHeight
        return CGSize(width: maxWidth, height: totalHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - Basics

private struct BasicsStepView: View {
    @ObservedObject var vm: OnboardingViewModel

    var body: some View {
        StepScaffold(
            title: "Let's get to know you",
            subtitle: "This helps your coach personalize everything that follows.",
            continueDisabled: !vm.canContinueFromBasics,
            onContinue: vm.advance
        ) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                FieldLabel(title: "Name") {
                    TextField("Your name", text: $vm.name)
                        .font(Theme.Typography.bodyLarge)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                }

                FieldLabel(title: "Date of birth") {
                    DatePicker("", selection: $vm.dob, displayedComponents: .date)
                        .datePickerStyle(.compact)
                        .labelsHidden()
                        .tint(Theme.Colors.accentContent)
                }

                FieldLabel(title: "Sex") {
                    ChipPicker(
                        options: [("male", "Male"), ("female", "Female"), ("other", "Other")],
                        isSelected: { vm.sex == $0 },
                        onTap: { vm.sex = $0 }
                    )
                }

                HStack(spacing: Theme.Spacing.md) {
                    FieldLabel(title: "Height (cm)") {
                        TextField("cm", value: $vm.heightCm, format: .number)
                            .keyboardType(.decimalPad)
                            .font(Theme.Typography.bodyLarge)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .onboardingFieldSurface()
                    }
                    FieldLabel(title: "Weight (kg)") {
                        TextField("kg", value: $vm.weightKg, format: .number)
                            .keyboardType(.decimalPad)
                            .font(Theme.Typography.bodyLarge)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .onboardingFieldSurface()
                    }
                }

                FieldLabel(title: "Units") {
                    ChipPicker(
                        options: [("metric", "Metric"), ("imperial", "Imperial")],
                        isSelected: { vm.units == $0 },
                        onTap: { vm.units = $0 }
                    )
                }
            }
        }
    }
}

// MARK: - Goal

private struct GoalStepView: View {
    @ObservedObject var vm: OnboardingViewModel

    private let goals: [(value: String, label: String)] = [
        ("lose_fat", "Lose fat"),
        ("build_muscle", "Build muscle"),
        ("improve_endurance", "Improve endurance"),
        ("general_health", "General health"),
    ]

    var body: some View {
        StepScaffold(
            title: "What's your goal?",
            subtitle: "Pick the one that matters most right now.",
            continueDisabled: vm.goal.isEmpty,
            onContinue: vm.advance,
            onBack: vm.back
        ) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                FieldLabel(title: "Goal") {
                    ChipPicker(
                        options: goals,
                        isSelected: { vm.goal == $0 },
                        onTap: { vm.goal = $0 }
                    )
                }

                Toggle("I have a target date", isOn: $vm.hasTargetDate)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .tint(Theme.Colors.accent)

                if vm.hasTargetDate {
                    FieldLabel(title: "Target date") {
                        DatePicker("", selection: $vm.targetDate, displayedComponents: .date)
                            .datePickerStyle(.compact)
                            .labelsHidden()
                            .tint(Theme.Colors.accentContent)
                    }
                }
            }
        }
    }
}

// MARK: - Training

private struct TrainingStepView: View {
    @ObservedObject var vm: OnboardingViewModel

    private let types: [(value: String, label: String)] = [
        ("strength", "Strength"),
        ("running", "Running"),
        ("cycling", "Cycling"),
        ("swimming", "Swimming"),
        ("yoga", "Yoga"),
        ("other", "Other"),
    ]
    private let experiences: [(value: String, label: String)] = [
        ("beginner", "Beginner"),
        ("intermediate", "Intermediate"),
        ("advanced", "Advanced"),
    ]

    var body: some View {
        StepScaffold(
            title: "How do you train?",
            subtitle: "So your coach knows what you're already doing.",
            continueDisabled: vm.trainingTypes.isEmpty || vm.experience.isEmpty,
            onContinue: vm.advance,
            onBack: vm.back
        ) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                FieldLabel(title: "Days per week") {
                    HStack {
                        Stepper(value: $vm.frequency, in: 0...7) {
                            Text("\(vm.frequency) \(vm.frequency == 1 ? "day" : "days")")
                                .font(Theme.Typography.bodyLarge)
                                .foregroundStyle(Theme.Colors.textPrimary)
                        }
                        .tint(Theme.Colors.accentContent)
                    }
                }

                FieldLabel(title: "Types") {
                    ChipPicker(
                        options: types,
                        isSelected: { vm.trainingTypes.contains($0) },
                        onTap: { value in
                            if vm.trainingTypes.contains(value) {
                                vm.trainingTypes.remove(value)
                            } else {
                                vm.trainingTypes.insert(value)
                            }
                        }
                    )
                }

                FieldLabel(title: "Experience") {
                    ChipPicker(
                        options: experiences,
                        isSelected: { vm.experience == $0 },
                        onTap: { vm.experience = $0 }
                    )
                }

                FieldLabel(title: "Anything else? (optional)") {
                    TextField("PRs, current program, injuries in training…", text: $vm.volumeNotes, axis: .vertical)
                        .lineLimit(3...6)
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                }
            }
        }
    }
}

// MARK: - Health & Safety

private struct HealthSafetyStepView: View {
    @ObservedObject var vm: OnboardingViewModel

    var body: some View {
        StepScaffold(
            title: "Health & safety",
            subtitle: "Optional, but it keeps your coach's advice safe.",
            onContinue: vm.advance,
            onBack: vm.back
        ) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                FieldLabel(title: "Injuries (optional)") {
                    TextField("Past or current injuries", text: $vm.injuries, axis: .vertical)
                        .lineLimit(2...5)
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                }
                FieldLabel(title: "Conditions (optional)") {
                    TextField("Medical conditions", text: $vm.conditions, axis: .vertical)
                        .lineLimit(2...5)
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                }
                FieldLabel(title: "Medications (optional)") {
                    TextField("Current medications", text: $vm.medications, axis: .vertical)
                        .lineLimit(2...5)
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                }
            }
        }
    }
}

// MARK: - Lifestyle

private struct LifestyleStepView: View {
    @ObservedObject var vm: OnboardingViewModel

    private let sleepOptions: [(value: String, label: String)] = [
        ("early_bird", "Early bird"),
        ("night_owl", "Night owl"),
        ("variable", "Variable"),
    ]
    private let stressOptions: [(value: String, label: String)] = [
        ("low", "Low"),
        ("moderate", "Moderate"),
        ("high", "High"),
    ]

    var body: some View {
        StepScaffold(
            title: "Lifestyle",
            subtitle: "Last few questions — optional, then we'll submit your answers.",
            continueTitle: "Save & continue",
            isBusy: vm.isSubmitting,
            onContinue: { Task { await vm.submitAndAdvance() } },
            onBack: vm.back
        ) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                FieldLabel(title: "Sleep schedule (optional)") {
                    ChipPicker(
                        options: sleepOptions,
                        isSelected: { vm.sleepSchedule == $0 },
                        onTap: { vm.sleepSchedule = (vm.sleepSchedule == $0) ? "" : $0 }
                    )
                }
                FieldLabel(title: "Stress level (optional)") {
                    ChipPicker(
                        options: stressOptions,
                        isSelected: { vm.stress == $0 },
                        onTap: { vm.stress = (vm.stress == $0) ? "" : $0 }
                    )
                }
                FieldLabel(title: "Diet (optional)") {
                    TextField("Any dietary pattern or restriction", text: $vm.diet, axis: .vertical)
                        .lineLimit(2...5)
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                }

                if let error = vm.errorMessage {
                    Text(error)
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.alert)
                }
            }
        }
    }
}

// MARK: - Coach intro

private struct CoachIntroStepView: View {
    @ObservedObject var vm: OnboardingViewModel

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("Meet your coach")
                    .font(Theme.Typography.titleLarge)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("A couple of quick questions, then we'll start importing your health history.")
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.top, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.sm)

            CoachView(mode: "onboarding")

            Button(action: vm.advance) {
                Text("Continue")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Theme.Colors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.bottom, Theme.Spacing.lg)
        }
    }
}

// MARK: - Calibrating

private struct CalibratingStepView: View {
    @ObservedObject var vm: OnboardingViewModel
    @EnvironmentObject private var authViewModel: AuthViewModel
    @EnvironmentObject private var backfillCoordinator: BackfillCoordinator

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: Theme.Spacing.xl) {
                ZStack {
                    Circle()
                        .fill(Theme.Colors.accent.opacity(0.15))
                        .frame(width: 96, height: 96)
                    Image(systemName: "heart.text.square.fill")
                        .font(.system(size: 36))
                        .foregroundStyle(Theme.Colors.accentContent)
                }

                VStack(spacing: Theme.Spacing.sm) {
                    Text(backfillCoordinator.isComplete ? "You're all set" : "Importing your health history…")
                        .font(Theme.Typography.titleMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(backfillCoordinator.isComplete
                         ? "365 days of health history imported."
                         : "\(Int((backfillCoordinator.progress * 100).rounded()))% — this keeps going in the background, so feel free to continue.")
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                }

                VitalProgressBar(fraction: backfillCoordinator.progress)
                    .frame(width: 220)
            }
            .padding(.horizontal, Theme.Spacing.xl)

            Spacer()

            Button {
                authViewModel.markOnboarded()
            } label: {
                Text("Continue")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Theme.Colors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.bottom, Theme.Spacing.lg)
        }
        .task {
            await backfillCoordinator.startIfNeeded()
        }
    }
}

/// Local copy of TodayView's thin progress bar — kept file-private here to
/// avoid reaching into TodayView's private supporting types.
private struct VitalProgressBar: View {
    let fraction: Double
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(Theme.Colors.glassFill)
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(Theme.Colors.accent)
                    .frame(width: geo.size.width * fraction)
            }
        }
        .frame(height: height)
    }
}
