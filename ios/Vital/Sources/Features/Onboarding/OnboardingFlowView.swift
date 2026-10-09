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
        Group {
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
        .id(vm.step)
        .motionTransition(vm.stepDirection == .forward ? .pushForward : .pushBackward)
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
                    .background(Theme.Colors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                }
                // Whole-button opacity (not just a diluted background fill)
                // so the label dims along with the fill — a background-only
                // dim left full-contrast text sitting on a still-legible
                // green and read as enabled even with every field empty.
                .opacity(continueDisabled ? 0.4 : 1.0)
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
                let selected = isSelected(option.value)
                Button {
                    onTap(option.value)
                } label: {
                    Chip(text: option.label, isAccent: selected)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
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

    // Display-unit text drafts, kept local rather than bound straight to
    // `vm.heightCm`/`vm.weightKg` — a converting Binding would reformat the
    // field on every keystroke and fight the user's typing mid-entry.
    // Drafts are parsed and committed back to the VM's canonical cm/kg on
    // every change, and re-seeded from the canonical values whenever the
    // unit system changes.
    @State private var heightCmText = ""
    @State private var heightFeetText = ""
    @State private var heightInchesText = ""
    @State private var weightText = ""

    var body: some View {
        StepScaffold(
            title: "Let's get to know you",
            subtitle: "We use this to set your calorie and protein targets. You can change it anytime.",
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
                    if vm.dob != nil {
                        DatePicker("", selection: dobBinding, in: ...Date(), displayedComponents: .date)
                            .datePickerStyle(.compact)
                            .labelsHidden()
                            .tint(Theme.Colors.accentContent)
                    } else {
                        // No pre-filled default: a silently accepted date
                        // gave users a wrong age. Choosing is explicit.
                        Button {
                            vm.dob = Calendar.current.date(byAdding: .year, value: -25, to: Date()) ?? Date()
                        } label: {
                            HStack {
                                Text("Select your date of birth")
                                    .font(Theme.Typography.bodyLarge)
                                    .foregroundStyle(Theme.Colors.textSecondary)
                                Spacer()
                                Image(systemName: "calendar")
                                    .foregroundStyle(Theme.Colors.accentContent)
                            }
                            .onboardingFieldSurface()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Select your date of birth")
                    }
                }

                FieldLabel(title: "Sex") {
                    ChipPicker(
                        options: [("male", "Male"), ("female", "Female"), ("other", "Other")],
                        isSelected: { vm.sex == $0 },
                        onTap: { vm.sex = $0 }
                    )
                }

                FieldLabel(title: "Units") {
                    ChipPicker(
                        options: [(UnitSystem.metric.rawValue, "Metric"), (UnitSystem.imperial.rawValue, "Imperial")],
                        isSelected: { vm.units.rawValue == $0 },
                        onTap: { raw in
                            guard let system = UnitSystem(rawValue: raw) else { return }
                            vm.units = system
                            UnitPreference.shared.set(system)
                        }
                    )
                }

                heightWeightFields
            }
        }
        .onAppear { seedHeightDraft(); seedWeightDraft() }
        .onChange(of: vm.units) { seedHeightDraft(); seedWeightDraft() }
        .onChange(of: vm.heightCm) { reseedHeightIfDraftEmpty() }
        .onChange(of: vm.weightKg) { reseedWeightIfDraftEmpty() }
    }

    /// Only read once `vm.dob` is non-nil (the picker is hidden before that).
    private var dobBinding: Binding<Date> {
        Binding(get: { vm.dob ?? Date() }, set: { vm.dob = $0 })
    }

    // MARK: - Height/weight fields (unit-dependent layout)

    @ViewBuilder
    private var heightWeightFields: some View {
        switch vm.units {
        case .metric:
            HStack(spacing: Theme.Spacing.md) {
                FieldLabel(title: "Height (cm)") {
                    TextField("cm", text: $heightCmText)
                        .keyboardType(.decimalPad)
                        .font(Theme.Typography.bodyLarge)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                        .onChange(of: heightCmText) { commitHeight() }
                }
                FieldLabel(title: "Weight (kg)") {
                    TextField("kg", text: $weightText)
                        .keyboardType(.decimalPad)
                        .font(Theme.Typography.bodyLarge)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                        .onChange(of: weightText) { commitWeight() }
                }
            }
        case .imperial:
            HStack(spacing: Theme.Spacing.md) {
                FieldLabel(title: "Height (ft)") {
                    TextField("ft", text: $heightFeetText)
                        .keyboardType(.numberPad)
                        .font(Theme.Typography.bodyLarge)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                        .onChange(of: heightFeetText) { commitHeight() }
                }
                FieldLabel(title: "Height (in)") {
                    TextField("in", text: $heightInchesText)
                        .keyboardType(.numberPad)
                        .font(Theme.Typography.bodyLarge)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                        .onChange(of: heightInchesText) { commitHeight() }
                }
                FieldLabel(title: "Weight (lb)") {
                    TextField("lb", text: $weightText)
                        .keyboardType(.numberPad)
                        .font(Theme.Typography.bodyLarge)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .onboardingFieldSurface()
                        .onChange(of: weightText) { commitWeight() }
                }
            }
        }
    }

    // MARK: - Draft ↔ VM

    private func commitHeight() {
        switch vm.units {
        case .metric:
            vm.heightCm = Double(heightCmText.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
        case .imperial:
            guard !heightFeetText.isEmpty || !heightInchesText.isEmpty else {
                vm.heightCm = nil
                return
            }
            let feet = Int(heightFeetText.trimmingCharacters(in: .whitespaces)) ?? 0
            let inches = Int(heightInchesText.trimmingCharacters(in: .whitespaces)) ?? 0
            vm.heightCm = UnitFormat.cm(fromFeet: feet, inches: inches)
        }
    }

    private func commitWeight() {
        vm.weightKg = weightText.isEmpty ? nil : UnitFormat.kg(fromEntry: weightText, vm.units)
    }

    private func seedHeightDraft() {
        switch vm.units {
        case .metric:
            heightCmText = vm.heightCm.map { String(Int($0.rounded())) } ?? ""
            heightFeetText = ""
            heightInchesText = ""
        case .imperial:
            if let cm = vm.heightCm {
                let parts = UnitFormat.heightParts(cm: cm)
                heightFeetText = String(parts.feet)
                heightInchesText = String(parts.inches)
            } else {
                heightFeetText = ""
                heightInchesText = ""
            }
            heightCmText = ""
        }
    }

    private func seedWeightDraft() {
        weightText = UnitFormat.weightEntryText(kg: vm.weightKg, vm.units)
    }

    /// Reflects `vm.heightCm` changing out from under an untouched draft
    /// (HealthKit prefill lands asynchronously, after this view has already
    /// appeared with empty fields) without stomping on live typing — a draft
    /// that already has characters in it never gets overwritten here.
    private func reseedHeightIfDraftEmpty() {
        let isEmpty = vm.units == .metric
            ? heightCmText.isEmpty
            : (heightFeetText.isEmpty && heightInchesText.isEmpty)
        if isEmpty { seedHeightDraft() }
    }

    private func reseedWeightIfDraftEmpty() {
        if weightText.isEmpty { seedWeightDraft() }
    }
}

// MARK: - Goal

private struct GoalStepView: View {
    @ObservedObject var vm: OnboardingViewModel

    /// Display-unit draft for the optional target weight; committed to
    /// `vm.targetWeightKg` (kg) on every edit, cleared when the goal changes.
    @State private var targetWeightText = ""
    /// Same for the optional endurance weekly distance (display unit; committed as km).
    @State private var weeklyDistanceText = ""

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
                        onTap: { vm.selectGoal($0) }
                    )
                }

                if GoalTargetLogic.showsTargetWeight(goal: vm.goal) {
                    targetWeightSection
                }

                if GoalTargetLogic.showsWeeklyDistance(goal: vm.goal) {
                    FieldLabel(title: "Weekly distance (\(vm.units.distanceUnit), optional)") {
                        TextField(vm.units.distanceUnit, text: $weeklyDistanceText)
                            .keyboardType(.decimalPad)
                            .font(Theme.Typography.bodyLarge)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .onboardingFieldSurface()
                            .accessibilityIdentifier("onboarding.weeklyDistanceField")
                            .onChange(of: weeklyDistanceText) {
                                vm.weeklyDistanceKmTarget = weeklyDistanceText.isEmpty
                                    ? nil
                                    : UnitFormat.km(fromDistanceEntry: weeklyDistanceText, vm.units)
                            }
                    }
                }

                if GoalTargetLogic.showsWeeklySessions(goal: vm.goal) {
                    FieldLabel(title: "Workouts per week") {
                        Stepper(value: $vm.weeklySessionsTarget,
                                in: GoalTargetLogic.minWeeklySessions...GoalTargetLogic.maxWeeklySessions) {
                            Text("\(vm.weeklySessionsTarget) \(vm.weeklySessionsTarget == 1 ? "workout" : "workouts")")
                                .font(Theme.Typography.bodyLarge)
                                .foregroundStyle(Theme.Colors.textPrimary)
                        }
                        .tint(Theme.Colors.accentContent)
                    }
                }

                Toggle("I have a target date", isOn: $vm.hasTargetDate)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .tint(Theme.Colors.accent)

                if vm.hasTargetDate {
                    FieldLabel(title: "Target date") {
                        DatePicker("", selection: $vm.targetDate, in: GoalTargetLogic.targetDateRange(), displayedComponents: .date)
                            .datePickerStyle(.compact)
                            .labelsHidden()
                            .tint(Theme.Colors.accentContent)
                    }
                }
            }
        }
        .onAppear {
            // The step is rebuilt when navigating back to it; re-seed the
            // draft from the canonical kg value.
            targetWeightText = UnitFormat.weightEntryText(kg: vm.targetWeightKg, vm.units)
            weeklyDistanceText = UnitFormat.distanceEntryText(km: vm.weeklyDistanceKmTarget, vm.units)
        }
        .onChange(of: vm.goal) {
            targetWeightText = ""
            weeklyDistanceText = ""
        }
        .onChange(of: vm.units) {
            targetWeightText = UnitFormat.weightEntryText(kg: vm.targetWeightKg, vm.units)
            weeklyDistanceText = UnitFormat.distanceEntryText(km: vm.weeklyDistanceKmTarget, vm.units)
        }
    }

    @ViewBuilder
    private var targetWeightSection: some View {
        FieldLabel(title: "Target weight (\(vm.units.weightUnit), optional)") {
            TextField(vm.units.weightUnit, text: $targetWeightText)
                .keyboardType(.decimalPad)
                .font(Theme.Typography.bodyLarge)
                .foregroundStyle(Theme.Colors.textPrimary)
                .onboardingFieldSurface()
                .onChange(of: targetWeightText) {
                    vm.targetWeightKg = targetWeightText.isEmpty
                        ? nil
                        : UnitFormat.kg(fromEntry: targetWeightText, vm.units)
                }
        }

        if let warning = GoalTargetLogic.sanityWarning(
            goal: vm.goal,
            currentKg: vm.weightKg,
            targetKg: vm.targetWeightKg,
            targetDate: vm.hasTargetDate ? vm.targetDate : nil,
            units: vm.units
        ) {
            Text(warning)
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.caution)
        } else if GoalTargetLogic.isLossGoal(vm.goal),
                  let hint = GoalTargetLogic.paceHint(
                    currentKg: vm.weightKg, targetKg: vm.targetWeightKg, units: vm.units
                  ) {
            Text(hint)
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
        } else if let nudge = GoalTargetLogic.missingTargetNudge(goal: vm.goal, targetKg: vm.targetWeightKg) {
            // Optional, never blocking — just says what a target unlocks.
            Text(nudge)
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
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
                Text("Last step \u{2014} tell Vital anything it should know.")
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
                         ? OnboardingCopy.importSummary(daysUploaded: backfillCoordinator.daysUploaded)
                         : "\(Int((backfillCoordinator.progress * 100).rounded()))% — this keeps going in the background, so feel free to continue.")
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                }

                OnboardingProgressBar(fraction: backfillCoordinator.progress)
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
/// avoid reaching into TodayView's private supporting types. Named
/// distinctly from `TodayView.VitalProgressBar` (which became internal for
/// `WeightHeroView` to reuse) to avoid a top-level redeclaration collision.
private struct OnboardingProgressBar: View {
    let fraction: Double
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(Theme.Colors.progressTrack)
                RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                    .fill(Theme.Colors.accent)
                    .frame(width: geo.size.width * fraction)
            }
        }
        .frame(height: height)
    }
}
