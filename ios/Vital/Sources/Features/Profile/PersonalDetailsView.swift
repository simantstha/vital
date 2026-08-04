import SwiftUI

/// Pushed from Profile → "Personal details". Editable name / age / height /
/// weight, saved with a single PATCH /api/profile carrying only the fields the
/// user actually changed. Height/weight follow `UnitPreference.shared`:
/// metric shows a single cm field, imperial shows a ft/in split (each
/// converted to cm for the API via `UnitFormat`).
struct PersonalDetailsView: View {
    let profileVM: ProfileViewModel

    @Environment(\.dismiss) private var dismiss

    @State private var nameText: String
    @State private var ageText: String
    @State private var heightText: String
    @State private var heightFeetText: String
    @State private var heightInchesText: String
    @State private var weightText: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let units: UnitSystem
    private let initialName: String
    private let initialAge: String
    private let initialHeight: String
    private let initialHeightFeet: String
    private let initialHeightInches: String
    private let initialWeight: String

    private let api = APIClient.shared

    init(profileVM: ProfileViewModel) {
        self.profileVM = profileVM

        let units = UnitPreference.shared.current
        self.units = units

        let details = profileVM.details
        let name = profileVM.name
        let age = details?.age.map(String.init) ?? ""
        let heightCm = details?.heightCm
        let height = units == .metric ? Self.heightFieldText(heightCm) : ""
        let heightParts = heightCm.map(UnitFormat.heightParts(cm:))
        let heightFeet = units == .imperial ? heightParts.map { String($0.feet) } ?? "" : ""
        let heightInches = units == .imperial ? heightParts.map { String($0.inches) } ?? "" : ""
        let weight = Self.weightFieldText(details?.weightKg, units: units)

        initialName = name
        initialAge = age
        initialHeight = height
        initialHeightFeet = heightFeet
        initialHeightInches = heightInches
        initialWeight = weight
        _nameText = State(initialValue: name)
        _ageText = State(initialValue: age)
        _heightText = State(initialValue: height)
        _heightFeetText = State(initialValue: heightFeet)
        _heightInchesText = State(initialValue: heightInches)
        _weightText = State(initialValue: weight)
    }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    Text("Personal details")
                        .screenTitleStyle()
                        .foregroundStyle(Theme.Colors.textPrimary)

                    fieldsCard

                    if let errorMessage {
                        Text(errorMessage)
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.alert)
                    }

                    Text("Your coach uses these to size your budgets and targets.")
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
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { save() }
                    .fontWeight(.semibold)
                    .disabled(isSaving)
            }
        }
    }

    // MARK: - Fields card

    private var fieldsCard: some View {
        VitalCard(padding: 0) {
            VStack(spacing: 0) {
                fieldRow(index: 0, label: "Name", text: $nameText, unit: nil, keyboard: .default)
                fieldRow(index: 1, label: "Age", text: $ageText, unit: "yrs", keyboard: .numberPad)
                if units == .metric {
                    fieldRow(index: 2, label: "Height", text: $heightText, unit: "cm", keyboard: .decimalPad)
                    fieldRow(index: 3, label: "Weight", text: $weightText, unit: "kg", keyboard: .decimalPad)
                } else {
                    fieldRow(index: 2, label: "Height (ft)", text: $heightFeetText, unit: "ft", keyboard: .numberPad)
                    fieldRow(index: 3, label: "Height (in)", text: $heightInchesText, unit: "in", keyboard: .numberPad)
                    fieldRow(index: 4, label: "Weight", text: $weightText, unit: "lb", keyboard: .decimalPad)
                }
            }
        }
    }

    private func fieldRow(
        index: Int, label: String, text: Binding<String>,
        unit: String?, keyboard: UIKeyboardType
    ) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 72, alignment: .leading)

            TextField("--", text: text)
                .keyboardType(keyboard)
                .multilineTextAlignment(.trailing)
                .font(Theme.Typography.bodyMedium)
                .fontWeight(.medium)
                .foregroundStyle(Theme.Colors.textPrimary)

            if let unit {
                Text(unit)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(width: 26, alignment: .leading)
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md + 2)
        .overlay(alignment: .top) {
            if index > 0 {
                Rectangle()
                    .fill(Theme.Colors.glassBorder)
                    .frame(height: 0.5)
            }
        }
    }

    // MARK: - Save

    private func save() {
        guard !isSaving else { return }

        // Build a patch of only the fields the user actually edited.
        let name: String? = {
            let trimmed = nameText.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed != initialName && !trimmed.isEmpty ? trimmed : nil
        }()
        let age: Int? = ageText != initialAge ? Int(ageText.trimmingCharacters(in: .whitespaces)) : nil

        let heightCm: Double?
        switch units {
        case .metric:
            heightCm = heightText != initialHeight ? Double(
                heightText.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
            ) : nil
        case .imperial:
            if heightFeetText != initialHeightFeet || heightInchesText != initialHeightInches {
                let feet = Int(heightFeetText.trimmingCharacters(in: .whitespaces)) ?? 0
                let inches = Int(heightInchesText.trimmingCharacters(in: .whitespaces)) ?? 0
                heightCm = UnitFormat.cm(fromFeet: feet, inches: inches)
            } else {
                heightCm = nil
            }
        }

        let weightKg: Double? = weightText != initialWeight ? UnitFormat.kg(fromEntry: weightText, units) : nil

        guard name != nil || age != nil || heightCm != nil || weightKg != nil else {
            dismiss()
            return
        }

        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await api.updateProfile(name: name, age: age, heightCm: heightCm, weightKg: weightKg)
                await profileVM.load()
                dismiss()
            } catch {
                errorMessage = "Couldn't save. Check the values and try again."
                isSaving = false
            }
        }
    }

    // MARK: - Field seeding

    /// Metric-only text seed — imperial seeds its ft/in drafts directly from
    /// `UnitFormat.heightParts` in `init` instead.
    private static func heightFieldText(_ heightCm: Double?) -> String {
        guard let heightCm else { return "" }
        return String(Int(heightCm.rounded()))
    }

    private static func weightFieldText(_ weightKg: Double?, units: UnitSystem) -> String {
        UnitFormat.weightEntryText(kg: weightKg, units)
    }
}
