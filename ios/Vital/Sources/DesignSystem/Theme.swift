import SwiftUI

enum Theme {

    // MARK: - Colors
    enum Colors {
        /// Canvas background — #0B0F14
        static let canvas = Color(red: 0.043, green: 0.059, blue: 0.078)
        /// Lime accent — #C7F23B
        static let accent = Color(red: 0.780, green: 0.949, blue: 0.231)
        /// Alert / warning red — #FF6B6B
        static let alert = Color(red: 1.000, green: 0.420, blue: 0.420)
        /// Primary text — #F5F2EC
        static let textPrimary = Color(red: 0.961, green: 0.949, blue: 0.925)
        /// Secondary / muted text — #7A8694
        static let textSecondary = Color(red: 0.478, green: 0.525, blue: 0.580)
        /// Glass fill — white 5 % opacity
        static let glassFill = Color.white.opacity(0.05)
        /// Glass border — white 8 % opacity
        static let glassBorder = Color.white.opacity(0.08)
        /// Indigo for sleep / carbs — #8B93FF
        static let indigo = Color(red: 0.545, green: 0.576, blue: 1.000)
    }

    // MARK: - Spacing
    enum Spacing {
        static let xxs: CGFloat = 2
        static let xs: CGFloat  = 4
        static let sm: CGFloat  = 8
        static let md: CGFloat  = 12
        static let lg: CGFloat  = 16
        static let xl: CGFloat  = 20
        static let xxl: CGFloat = 24
        static let xxxl: CGFloat = 32
    }

    // MARK: - Corner Radius
    enum Radius {
        static let sm: CGFloat  = 10
        static let md: CGFloat  = 14
        static let lg: CGFloat  = 20
        static let xl: CGFloat  = 24
        static let pill: CGFloat = 999
    }

    // MARK: - Typography
    enum Typography {
        // Numeric / SF Rounded
        static func numericHero(_ size: CGFloat = 40) -> Font {
            .system(size: size, weight: .bold, design: .rounded)
        }
        static func numericLarge(_ size: CGFloat = 28) -> Font {
            .system(size: size, weight: .semibold, design: .rounded)
        }
        static func numericSmall(_ size: CGFloat = 17) -> Font {
            .system(size: size, weight: .medium, design: .rounded)
        }

        // Body — SF Pro
        static let bodyLarge  = Font.system(size: 17, weight: .regular)
        static let bodyMedium = Font.system(size: 15, weight: .regular)
        static let bodySmall  = Font.system(size: 13, weight: .regular)

        // Labels
        static let labelMedium = Font.system(size: 12, weight: .medium)
        static let labelSmall  = Font.system(size: 11, weight: .medium)

        // Headings
        static let titleLarge  = Font.system(size: 28, weight: .bold)
        static let titleMedium = Font.system(size: 22, weight: .semibold)
    }
}
