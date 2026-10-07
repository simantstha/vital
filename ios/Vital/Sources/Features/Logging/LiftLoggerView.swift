import SwiftUI
import UIKit

/// "Log lift" sheet (roadmap v5 item B): defaults to "Repeat last session",
/// pre-filled from `GET /api/workouts/last` (with a menu of recent sessions
/// from `GET /api/workouts/sessions`), typed or stepped reps/weight per set,
/// per-set last-time hints, warm-up / RPE, a date control, add set / add
/// exercise (with autocomplete), and Save → `POST /api/workouts/sets`.
///
/// Presented by the caller inside `VitalSheet(detents: [.large])` (Today's
/// muscle hero and Logs' "Log a lift" button); this view supplies its own
/// header, form and save bar — same convention as `DietSheetView`.
struct LiftLoggerView: View {
    @StateObject private var vm: LiftLoggerViewModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var nameFieldFocused: Bool
    /// Sets whose "More" (RPE) disclosure is open. A set with an RPE is
    /// always shown open.
    @State private var expandedSets: Set<UUID> = []

    /// Called once after a successful save, just before the sheet dismisses —
    /// callers use it to refresh Today/Logs (Trends listens for
    /// `.vitalWorkoutLogged` instead).
    private let onSaved: () -> Void

    init(preferredExercise: String? = nil, onSaved: @escaping () -> Void = {}) {
        _vm = StateObject(wrappedValue: LiftLoggerViewModel(preferredExercise: preferredExercise))
        self.onSaved = onSaved
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.bottom, Theme.Spacing.sm)

            Form {
                introSection
                dateSection
                exerciseSections
                addExerciseSection
                if let errorMessage = vm.errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.Colors.alert)
                            .accessibilityIdentifier("liftLogger.error")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)

            saveBar
        }
        .task { await vm.load() }
        .onChange(of: vm.didSave) { _, saved in
            guard saved else { return }
            onSaved()
            dismiss()
        }
        .sensoryFeedback(Theme.Haptics.success, trigger: vm.didSave)
        .toolbar {
            // The number pad has no return key — give typed reps/weight a way out.
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
                    )
                }
                .accessibilityIdentifier("liftLogger.keyboardDone")
            }
        }
    }
}

// MARK: - Sections

private extension LiftLoggerView {

    var header: some View {
        HStack {
            Text("Log lift")
                .font(.system(size: 18, weight: .bold))
                .tracking(-0.2)
                .foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
            Button {
                dismiss()
            } label: {
                ZStack {
                    Circle()
                        .fill(Theme.Colors.glassFill)
                        .frame(width: 36, height: 36)
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
    }

    @ViewBuilder
    var introSection: some View {
        if vm.isLoading {
            Section {
                HStack(spacing: Theme.Spacing.sm) {
                    ProgressView()
                    Text("Loading your last session…")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        } else if vm.isRepeatingLast {
            Section {
                if vm.recentSessions.count > 1 {
                    sessionMenu
                }
                Text(repeatNote)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .accessibilityIdentifier("liftLogger.repeatNote")
            }
        } else if vm.exercises.isEmpty {
            Section {
                Text("No previous session to repeat — add an exercise to start.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .accessibilityIdentifier("liftLogger.emptyNote")
            }
        }
    }

    /// "Repeating your last session — …" while the newest session is loaded
    /// (kept verbatim: the screenshot flow keys off it), else names the day.
    var repeatNote: String {
        if let picked = vm.repeatedSession, picked.id != vm.recentSessions.first?.id {
            let day = LiftLoggerLogic.dayLabel(localDay: picked.localDay)
            return "Repeating \(day)'s session — adjust anything that changed, then save."
        }
        return "Repeating your last session — adjust anything that changed, then save."
    }

    /// "Repeat: Mon · Bench, OHP, …" with a menu of recent distinct sessions.
    var sessionMenu: some View {
        Menu {
            ForEach(vm.recentSessions) { session in
                Button(LiftLoggerLogic.sessionTitle(session)) {
                    vm.repeatSession(id: session.sessionId)
                }
            }
        } label: {
            HStack(spacing: Theme.Spacing.sm) {
                Text("Repeat: \(vm.repeatedSession.map { LiftLoggerLogic.sessionTitle($0) } ?? "pick a session")")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: Theme.Spacing.sm)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
        .accessibilityIdentifier("liftLogger.repeatMenu")
    }

    /// "Logging for: Today ▾" — compact date picker, capped at today.
    @ViewBuilder
    var dateSection: some View {
        if !vm.isLoading {
            Section {
                HStack {
                    Text("Logging for: \(LiftLoggerLogic.dateLabel(vm.performedDate))")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Spacer()
                    DatePicker(
                        "Date",
                        selection: $vm.performedDate,
                        in: ...Date(),
                        displayedComponents: .date
                    )
                    .labelsHidden()
                    .datePickerStyle(.compact)
                    .accessibilityIdentifier("liftLogger.date")
                }
            }
        }
    }

    var exerciseSections: some View {
        ForEach($vm.exercises) { $exercise in
            Section {
                ForEach($exercise.sets) { $set in
                    setRow(exercise: exercise, set: $set)
                }
                .onDelete { offsets in
                    vm.removeSets(in: exercise.id, at: offsets)
                }

                Button {
                    vm.addSet(to: exercise.id)
                } label: {
                    Label("Add set", systemImage: "plus")
                        .font(.system(size: 15, weight: .semibold))
                }
                .accessibilityIdentifier("liftLogger.addSet")
            } header: {
                Text(exercise.name)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .textCase(nil)
            } footer: {
                Text(LiftLoggerLogic.summaryLine(for: exercise, system: vm.system))
            }
        }
    }

    func setRow(exercise: LiftDraftExercise, set: Binding<LiftDraftSet>) -> some View {
        let number = (exercise.sets.firstIndex { $0.id == set.wrappedValue.id } ?? 0) + 1
        let id = set.wrappedValue.id
        let showRPE = expandedSets.contains(id) || set.wrappedValue.rpe != nil
        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Text("Set \(number)")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                warmupToggle(number: number, set: set)
                Spacer()
                Button {
                    if showRPE && set.wrappedValue.rpe == nil {
                        expandedSets.remove(id)
                    } else {
                        expandedSets.insert(id)
                    }
                } label: {
                    Text(showRPE ? "Less" : "More")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                .buttonStyle(.borderless)
                .opacity(set.wrappedValue.rpe != nil ? 0 : 1)
                .disabled(set.wrappedValue.rpe != nil)
                .accessibilityLabel(showRPE ? "Hide RPE for set \(number)" : "More options for set \(number)")
                .accessibilityHidden(set.wrappedValue.rpe != nil)
                .accessibilityIdentifier("liftLogger.more")
            }
            LiftStepperLine(
                title: "Reps",
                valueText: "\(set.wrappedValue.reps)",
                editText: "\(set.wrappedValue.reps)",
                keyboard: .numberPad,
                accessibilityName: "Set \(number) reps",
                identifier: "liftLogger.reps",
                canDecrement: set.wrappedValue.reps > LiftLoggerLogic.minReps,
                canIncrement: set.wrappedValue.reps < LiftLoggerLogic.maxReps,
                onDecrement: {
                    set.wrappedValue.reps = max(LiftLoggerLogic.minReps, set.wrappedValue.reps - 1)
                },
                onIncrement: {
                    set.wrappedValue.reps = min(LiftLoggerLogic.maxReps, set.wrappedValue.reps + 1)
                },
                onCommit: { text in
                    if let reps = LiftLoggerLogic.parseReps(text) { set.wrappedValue.reps = reps }
                }
            )
            LiftStepperLine(
                title: "Weight",
                valueText: LiftLoggerLogic.loadText(set.wrappedValue.load, system: vm.system),
                editText: LiftLoggerLogic.editText(forLoad: set.wrappedValue.load),
                keyboard: .decimalPad,
                accessibilityName: "Set \(number) weight",
                identifier: "liftLogger.load",
                canDecrement: set.wrappedValue.load > 0,
                canIncrement: set.wrappedValue.load < LiftLoggerLogic.maxLoad(for: vm.system),
                onDecrement: {
                    set.wrappedValue.load = max(0, set.wrappedValue.load - LiftLoggerLogic.loadStep(for: vm.system))
                },
                onIncrement: {
                    set.wrappedValue.load = min(
                        LiftLoggerLogic.maxLoad(for: vm.system),
                        set.wrappedValue.load + LiftLoggerLogic.loadStep(for: vm.system)
                    )
                },
                onCommit: { text in
                    // Empty input means "bodyweight", not "ignore".
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if trimmed.isEmpty {
                        set.wrappedValue.load = 0
                    } else if let load = LiftLoggerLogic.parseLoad(trimmed, system: vm.system) {
                        set.wrappedValue.load = load
                    }
                }
            )
            if let last = set.wrappedValue.last {
                Text(LiftLoggerLogic.hintText(last))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .monospacedDigit()
                    .accessibilityIdentifier("liftLogger.lastHint")
            }
            if showRPE {
                rpeMenu(number: number, set: set)
            }
        }
        .padding(.vertical, Theme.Spacing.xs)
    }

    /// Outlined "+ Warm-up" chip (filled "Warm-up" when on): tap to flag a warm-up set (excluded from working-set
    /// stats server-side).
    func warmupToggle(number: Int, set: Binding<LiftDraftSet>) -> some View {
        let on = set.wrappedValue.isWarmup
        return Button {
            set.wrappedValue.isWarmup.toggle()
        } label: {
            Text(on ? "Warm-up" : "+ Warm-up")
                .font(.system(size: 12, weight: on ? .bold : .medium))
                .foregroundStyle(on ? Theme.Colors.onAccent : Theme.Colors.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .background(Capsule().fill(on ? Theme.Colors.accent : Color.clear))
                .overlay(
                    Capsule().strokeBorder(Theme.Colors.textSecondary.opacity(on ? 0 : 0.5), lineWidth: 1)
                )
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(on ? "Set \(number) warm-up set, double tap to unmark" : "Mark set \(number) as warm-up")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("liftLogger.warmup")
    }

    /// RPE 6–10 in 0.5 steps, or none.
    func rpeMenu(number: Int, set: Binding<LiftDraftSet>) -> some View {
        Menu {
            Button("None") { set.wrappedValue.rpe = nil }
            ForEach(LiftLoggerLogic.rpeOptions, id: \.self) { value in
                Button(LiftLoggerLogic.numberText(value)) { set.wrappedValue.rpe = value }
            }
        } label: {
            HStack(spacing: Theme.Spacing.sm) {
                Text("RPE")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textSecondary)
                Spacer()
                Text(LiftLoggerLogic.rpeText(set.wrappedValue.rpe))
                    .font(.system(size: 16, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.textPrimary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
        .accessibilityLabel("Set \(number) RPE")
        .accessibilityValue(LiftLoggerLogic.rpeText(set.wrappedValue.rpe))
        .accessibilityIdentifier("liftLogger.rpe")
    }

    var addExerciseSection: some View {
        Section("Add exercise") {
            HStack(spacing: Theme.Spacing.sm) {
                TextField("Exercise name", text: $vm.newExerciseName)
                    .focused($nameFieldFocused)
                    .submitLabel(.done)
                    .onSubmit { vm.addTypedExercise() }
                    .accessibilityIdentifier("liftLogger.exerciseField")
                Button("Add") {
                    vm.addTypedExercise()
                    nameFieldFocused = false
                }
                .buttonStyle(.borderless)
                .disabled(vm.newExerciseName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("liftLogger.addExercise")
            }

            if !vm.completions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Theme.Spacing.sm) {
                        ForEach(vm.completions, id: \.key) { option in
                            Button {
                                vm.addExercise(named: option.display)
                                vm.newExerciseName = ""
                                nameFieldFocused = false
                            } label: {
                                Chip(text: option.display, icon: "plus", isAccent: true)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("liftLogger.completion")
                        }
                    }
                }
            }

            if !vm.availableSuggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Theme.Spacing.sm) {
                        ForEach(vm.availableSuggestions, id: \.self) { key in
                            Button {
                                vm.addExercise(named: key)
                            } label: {
                                Chip(text: LiftLoggerLogic.displayName(forKey: key), icon: "plus")
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    var saveBar: some View {
        Button {
            Task { await vm.save() }
        } label: {
            HStack(spacing: Theme.Spacing.sm) {
                if vm.isSaving {
                    ProgressView().tint(Theme.Colors.onAccent)
                }
                Text(vm.isSaving ? "Saving…" : "Save lift")
                    .font(.system(size: 16, weight: .bold))
            }
            .foregroundStyle(Theme.Colors.onAccent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.md + 2)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(vm.canSave ? Theme.Colors.accent : Theme.Colors.glassFill)
            )
        }
        .buttonStyle(.vital(scale: 0.98))
        .disabled(!vm.canSave)
        .accessibilityIdentifier("liftLogger.save")
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.vertical, Theme.Spacing.md)
    }
}

// MARK: - Stepper line

/// One labelled line of a set row: "Reps   [−] 5 [+]". Custom (not `Stepper`)
/// so two lines can sit in one `Form` row without their controls stacking at
/// the trailing edge. The value between the buttons is tappable: it swaps to a
/// numeric `TextField` for typed entry (commits on Done / focus loss through
/// `onCommit`, which validates and clamps). VoiceOver sees the value as one
/// adjustable element ("Set 1 reps, 5"); the ± buttons are hidden from it.
private struct LiftStepperLine: View {
    let title: String
    let valueText: String
    /// Raw text seeded into the field when editing starts.
    let editText: String
    let keyboard: UIKeyboardType
    let accessibilityName: String
    let identifier: String
    let canDecrement: Bool
    let canIncrement: Bool
    let onDecrement: () -> Void
    let onIncrement: () -> Void
    let onCommit: (String) -> Void

    @State private var isEditing = false
    @State private var draft = ""
    @FocusState private var fieldFocused: Bool

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(title)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
                .accessibilityHidden(true)
            Spacer(minLength: Theme.Spacing.sm)
            stepButton(systemName: "minus", enabled: canDecrement, action: onDecrement)
            valueView
                .frame(minWidth: 84)
            stepButton(systemName: "plus", enabled: canIncrement, action: onIncrement)
        }
    }

    @ViewBuilder
    private var valueView: some View {
        if isEditing {
            TextField("", text: $draft)
                .keyboardType(keyboard)
                .focused($fieldFocused)
                .multilineTextAlignment(.center)
                .font(.system(size: 16, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.textPrimary)
                .onSubmit { finishEditing() }
                .onChange(of: fieldFocused) { _, focused in
                    if !focused { finishEditing() }
                }
                .onAppear { fieldFocused = true }
                .accessibilityLabel(accessibilityName)
                .accessibilityIdentifier(identifier)
        } else {
            Text(valueText)
                .font(.system(size: 16, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.textPrimary)
                .multilineTextAlignment(.center)
                .frame(minHeight: 36)
                .contentShape(Rectangle())
                .onTapGesture {
                    draft = editText
                    isEditing = true
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(accessibilityName)
                .accessibilityValue(valueText)
                .accessibilityHint("Double tap to type a value")
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier(identifier)
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: if canIncrement { onIncrement() }
                    case .decrement: if canDecrement { onDecrement() }
                    @unknown default: break
                    }
                }
        }
    }

    private func finishEditing() {
        guard isEditing else { return }
        isEditing = false
        onCommit(draft)
    }

    private func stepButton(systemName: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(enabled ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
                .frame(width: 44, height: 36)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Theme.Colors.glassFill)
                )
        }
        // Borderless so each button takes its own taps inside a Form row.
        .buttonStyle(.borderless)
        .disabled(!enabled)
        .accessibilityHidden(true)
    }
}
