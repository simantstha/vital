import SwiftUI

/// Encodes whether a metric arrow points up or down,
/// and whether that direction is an improvement.
enum TrendDirection: Equatable {
    case upGood      // ↑ green — e.g. HRV rising
    case downGood    // ↓ green — e.g. resting HR falling
    case upBad       // ↑ red   — e.g. strain spiking
    case downBad     // ↓ red   — e.g. sleep dropping
    case neutral     // —  gray
    case upNeutral   // ↑ gray  — e.g. steps rising (polarity-neutral metric)
    case downNeutral // ↓ gray  — e.g. steps falling (polarity-neutral metric)

    var arrowSystemImage: String {
        switch self {
        case .upGood, .upBad, .upNeutral:     return "arrow.up.right"
        case .downGood, .downBad, .downNeutral: return "arrow.down.right"
        case .neutral:                         return "minus"
        }
    }

    var color: Color {
        switch self {
        case .upGood, .downGood:       return Theme.Colors.positive
        case .upBad, .downBad:         return Theme.Colors.alert
        case .neutral:                 return Theme.Colors.textSecondary
        case .upNeutral, .downNeutral: return Theme.Colors.textSecondary
        }
    }
}
