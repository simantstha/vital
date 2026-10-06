import SwiftUI

/// "Log lift" sheet (roadmap v5 item B): defaults to "Repeat last session",
/// pre-filled from `GET /api/workouts/last`, with reps/load steppers per set,
/// add set / add exercise, and Save → `POST /api/workouts/sets`.
///
/// Presented by the caller inside `VitalSheet(detents: [.large])` (Today's
/// muscle hero and Logs' "Log a lift" button); this view supplies its own
/// header, form and save bar — same convention as `DietSheetView`.
struct LiftLoggerView: View {
    @StateObject private var vm: LiftLoggerViewModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var nameFieldFocused: Bool

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

            saveBar
        }
        .task { await vm.load() }
        .onChange(of: vm.didSave) { _, saved in
            guard saved else { return }
            onSaved()
            dismiss()
        }
        .sensoryFeedback(Theme.Haptics.success, trigger: vm.didSave)
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
                Text("Repeating your last session — adjust anything that changed, then save.")
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
        return VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.sm) {
                Text("Set \(number)")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                if set.wrappedValue.isWarmup {
                    Chip(text: "Warm-up")
                }
                Spacer()
            }
            Stepper(
                value: set.reps,
                in: LiftLoggerLogic.minReps...LiftLoggerLogic.maxReps
            ) {
                Text("\(set.wrappedValue.reps) reps")
                    .font(.system(size: 16, weight: .semibold))
                    .monospacedDigit()
            }
            .accessibilityIdentifier("liftLogger.reps")
            Stepper(
                value: set.load,
                in: 0...LiftLoggerLogic.maxLoad,
                step: LiftLoggerLogic.loadStep(for: vm.system)
            ) {
                Text(LiftLoggerLogic.loadText(set.wrappedValue.load, system: vm.system))
                    .font(.system(size: 16, weight: .semibold))
                    .monospacedDigit()
            }
            .accessibilityIdentifier("liftLogger.load")
        }
        .padding(.vertical, Theme.Spacing.xs)
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
