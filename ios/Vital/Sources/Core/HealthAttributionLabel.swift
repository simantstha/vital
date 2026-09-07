import Foundation

/// Shared copy for the "this consumption total came from Apple Health, not a
/// manually logged meal" attribution shown on `FuelStripView`,
/// `DietBudgetCardView`, and `DietSheetView`'s read-only summary row.
enum HealthAttributionLabel {
    /// "MyFitnessPal · via Apple Health" when a source app name is known,
    /// else the generic "via Apple Health".
    static func text(sourceName: String?) -> String {
        guard let sourceName, !sourceName.isEmpty else { return "via Apple Health" }
        return "\(sourceName) · via Apple Health"
    }
}
