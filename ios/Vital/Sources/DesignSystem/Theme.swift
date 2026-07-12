import SwiftUI

enum Theme {

    // MARK: - Colors
    enum Colors {
        /// Canvas background — dark: #0B0F14 / light: #F4F5F7
        static let canvas = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.043, green: 0.059, blue: 0.078, alpha: 1)
                : UIColor(red: 0.957, green: 0.961, blue: 0.969, alpha: 1)
        })

        /// Lime accent fill — #C7F23B (same in both modes; always use with dark text on top)
        static let accent = Color(red: 0.780, green: 0.949, blue: 0.231)

        /// Accent for TEXT / ICON / LINE use — dark: lime #C7F23B / light: deep green #3F6212
        /// Use this instead of `accent` wherever lime appears as a foreground color, thin line,
        /// or icon; lime on a light surface fails WCAG contrast.
        static let accentContent = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.780, green: 0.949, blue: 0.231, alpha: 1)
                : UIColor(red: 0.247, green: 0.384, blue: 0.071, alpha: 1)
        })

        /// Fixed foreground for content placed ON a lime accent fill — always near-black #0B0F14.
        /// Do NOT use `canvas` here: canvas is light in light mode and would produce
        /// a low-contrast white-on-lime combination.
        static let onAccent = Color(red: 0.043, green: 0.059, blue: 0.078)

        /// Alert / warning red — dark: #FF6B6B / light: #E5484D
        static let alert = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 1.000, green: 0.420, blue: 0.420, alpha: 1)
                : UIColor(red: 0.898, green: 0.282, blue: 0.302, alpha: 1)
        })

        /// Primary text — dark: #F5F2EC / light: #11151B
        static let textPrimary = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.961, green: 0.949, blue: 0.925, alpha: 1)
                : UIColor(red: 0.067, green: 0.082, blue: 0.106, alpha: 1)
        })

        /// Secondary / muted text — dark: #7A8694 / light: #6B7280
        static let textSecondary = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.478, green: 0.525, blue: 0.580, alpha: 1)
                : UIColor(red: 0.420, green: 0.447, blue: 0.502, alpha: 1)
        })

        /// Glass fill — dark: white 5% / light: black 4%
        static let glassFill = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(white: 1.0, alpha: 0.05)
                : UIColor(white: 0.0, alpha: 0.04)
        })

        /// Glass border — dark: white 8% / light: black 8%
        static let glassBorder = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(white: 1.0, alpha: 0.08)
                : UIColor(white: 0.0, alpha: 0.08)
        })

        /// Indigo for sleep / carbs — #8B93FF (fill-only; same in both modes)
        static let indigo = Color(red: 0.545, green: 0.576, blue: 1.000)

        /// Running Coach accent — cyan in dark mode, deeper cyan in light mode
        /// so labels and icons retain contrast without changing specialist identity.
        static let specialistAccent = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.298, green: 0.788, blue: 0.941, alpha: 1)
                : UIColor(red: 0.016, green: 0.494, blue: 0.639, alpha: 1)
        })

        /// Identity edge glow stays the manifest cyan in either appearance.
        static let specialistEdgeGlow = Color(red: 0.298, green: 0.788, blue: 0.941)

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
