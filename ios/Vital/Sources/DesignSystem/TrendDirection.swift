import SwiftUI

/// Encodes whether a metric arrow points up or down,
/// and whether that direction is an improvement.
enum TrendDirection {
    case upGood    // ↑ green — e.g. HRV rising
    case downGood  // ↓ green — e.g. resting HR falling
    case upBad     // ↑ red   — e.g. strain spiking
    case downBad   // ↓ red   — e.g. sleep dropping
    case neutral   // —  gray

    var arrowSystemImage: String {
        switch self {
        case .upGood, .upBad:     return "arrow.up.right"
        case .downGood, .downBad: return "arrow.down.right"
        case .neutral:            return "minus"
        }
    }

    var color: Color {
        switch self {
        case .upGood, .downGood: return Theme.Colors.positive
        case .upBad, .downBad:   return Theme.Colors.alert
        case .neutral:           return Theme.Colors.textSecondary
        }
    }
}
