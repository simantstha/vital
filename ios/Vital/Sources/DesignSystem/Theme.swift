import SwiftUI

enum Theme {

    // MARK: - Colors
    enum Colors {
        /// Canvas background — dark: #0B0F14 / light: #F4F4F6 (v3)
        static let canvas = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.043, green: 0.059, blue: 0.078, alpha: 1)
                : UIColor(red: 0.957, green: 0.957, blue: 0.965, alpha: 1)
        })

        /// Card surface — dark: ~#151A21 / light: #FDFDFD (v3). Pair with `cardShadow`
        /// in light mode; in dark mode add a hairline `glassBorder`-style edge instead
        /// since shadows are invisible against the dark canvas (see `VitalCard`).
        static let card = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.082, green: 0.102, blue: 0.129, alpha: 1)
                : UIColor(red: 0.992, green: 0.992, blue: 0.992, alpha: 1)
        })

        /// Card drop shadow — light: black 4% / dark: clear (dark cards use a subtle
        /// border instead of a shadow; see `VitalCard`).
        static let cardShadow = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor.clear
                : UIColor(white: 0.0, alpha: 0.04)
        })

        /// Lime accent fill — dark: #C7F23B / light: #B7E249 (v3). Always use with
        /// dark text on top.
        static let accent = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.780, green: 0.949, blue: 0.231, alpha: 1)
                : UIColor(red: 0.718, green: 0.886, blue: 0.286, alpha: 1)
        })

        /// Pale lime fill for soft chips/bubbles/badges — light: #EDF6D6 / dark: lime @ 15%.
        static let accentSoft = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.780, green: 0.949, blue: 0.231, alpha: 0.15)
                : UIColor(red: 0.929, green: 0.965, blue: 0.839, alpha: 1)
        })

        /// Accent for TEXT / ICON / LINE use — dark: lime #C7F23B / light: olive #55650F
        /// Use this instead of `accent` wherever lime appears as a foreground color, thin line,
        /// or icon; lime on a light surface fails WCAG contrast.
        static let accentContent = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.780, green: 0.949, blue: 0.231, alpha: 1)
                : UIColor(red: 0.333, green: 0.396, blue: 0.059, alpha: 1)
        })

        /// Fixed foreground for content placed ON a lime accent fill — always near-black #0B0F14.
        /// Do NOT use `canvas` here: canvas is light in light mode and would produce
        /// a low-contrast white-on-lime combination.
        static let onAccent = Color(red: 0.043, green: 0.059, blue: 0.078)

        /// Positive delta (e.g. HRV rising, resting HR falling) — light: #6DA33C / dark: #7BC96F.
        static let positive = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.482, green: 0.788, blue: 0.435, alpha: 1)
                : UIColor(red: 0.427, green: 0.639, blue: 0.235, alpha: 1)
        })

        /// Alert / warning red — dark: #FF6B6B / light: #D9483B (v3)
        static let alert = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 1.000, green: 0.420, blue: 0.420, alpha: 1)
                : UIColor(red: 0.851, green: 0.282, blue: 0.231, alpha: 1)
        })

        /// Primary text — dark: #F5F2EC / light: #17181A (v3)
        static let textPrimary = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.961, green: 0.949, blue: 0.925, alpha: 1)
                : UIColor(red: 0.090, green: 0.094, blue: 0.102, alpha: 1)
        })

        /// Secondary / muted text — dark: #7A8694 / light: #75767A (v3)
        static let textSecondary = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.478, green: 0.525, blue: 0.580, alpha: 1)
                : UIColor(red: 0.459, green: 0.463, blue: 0.478, alpha: 1)
        })

        /// Tertiary / faint text (placeholders, disabled) — light: #A6A7AB / dark: ~#5A6472.
        static let textTertiary = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.353, green: 0.392, blue: 0.447, alpha: 1)
                : UIColor(red: 0.651, green: 0.655, blue: 0.671, alpha: 1)
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
        static let sheet: CGFloat = 35
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

        /// Screen-level title (e.g. "Today") — 34pt bold. Prefer the
        /// `.screenTitleStyle()` view modifier below, which also applies the
        /// mock's tight tracking.
        static let screenTitle = Font.system(size: 34, weight: .bold)
    }
}

extension View {
    /// Applies `Theme.Typography.screenTitle` with the mock's tight tracking.
    func screenTitleStyle() -> some View {
        self
            .font(Theme.Typography.screenTitle)
            .tracking(-0.4)
    }
}
