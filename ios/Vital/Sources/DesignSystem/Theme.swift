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

        /// Muted chart fill for below-threshold values (e.g. short-sleep bars) —
        /// light: #E4E5E0 / dark: #2A3038. A solid neutral, not an opacity of
        /// `accent`, so it reads as "off" rather than "dim lime".
        static let chartMuted = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.165, green: 0.188, blue: 0.220, alpha: 1)
                : UIColor(red: 0.894, green: 0.898, blue: 0.878, alpha: 1)
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

        /// Empty progress-bar track — dark: white 13% / light: black 4%.
        /// Deliberately lighter than `glassFill` in dark mode only: an empty
        /// track (calibration's "0 of 14 days", the kcal/protein bars) using
        /// `glassFill`'s white-5%-on-near-black-card read as nearly invisible
        /// (~1.1:1). White 13% lands close to the ~1.5:1 target against
        /// `card` while staying subtle. Light mode is unchanged — its
        /// black-4%-on-white track already has plenty of contrast.
        static let progressTrack = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(white: 1.0, alpha: 0.13)
                : UIColor(white: 0.0, alpha: 0.04)
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

        /// Caution — guidance the user should read but that isn't a failure
        /// (e.g. a diet target near the low-energy floor). Distinct from
        /// `alert`, which is reserved for red/failure states. Amber:
        /// light: #B4741A / dark: #E8A94D.
        static let caution = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.910, green: 0.663, blue: 0.302, alpha: 1)
                : UIColor(red: 0.706, green: 0.455, blue: 0.102, alpha: 1)
        })

        /// Soft fill for a caution banner — light: #FBF0DC / dark: #2A2216.
        static let cautionSoft = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.165, green: 0.133, blue: 0.086, alpha: 1)
                : UIColor(red: 0.984, green: 0.941, blue: 0.863, alpha: 1)
        })

        /// Hairline border for a caution banner — light: #E4C489 / dark: #5C4620.
        static let cautionLine = Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.361, green: 0.275, blue: 0.125, alpha: 1)
                : UIColor(red: 0.894, green: 0.769, blue: 0.537, alpha: 1)
        })

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

    // MARK: - Motion
    /// Canonical animation curves for the whole app. Every spring here stays
    /// at `dampingFraction: 0.8` — never lower it, and never add `.bouncy`.
    /// No duration above 0.5s outside the three ambient loops (`breathe`,
    /// `pulseRing`, `pulse`), which are meant to run indefinitely at a calm,
    /// unobtrusive pace.
    enum Motion {
        /// Fast micro-interactions — segmented control selection, small toggles.
        static let micro: Animation = .easeInOut(duration: 0.15)
        /// Quick state changes — send-button enable/disable.
        static let quick: Animation = .easeInOut(duration: 0.2)
        /// Something leaving the screen (scroll-to-bottom, dismissal).
        static let exit: Animation = .easeOut(duration: 0.2)
        /// Default state-change duration for most view transitions.
        static let standard: Animation = .easeInOut(duration: 0.25)
        /// Something newly appearing.
        static let appear: Animation = .easeOut(duration: 0.25)
        /// Small springy confirmations — toasts, chips.
        static let snap: Animation = .spring(response: 0.35, dampingFraction: 0.8)
        /// Medium springy confirmations — cards settling into place.
        static let settle: Animation = .spring(response: 0.4, dampingFraction: 0.8)
        /// Larger springy arrivals — bottom sheets, coach bubbles.
        static let arrive: Animation = .spring(response: 0.5, dampingFraction: 0.8)
        /// Numeric roll-up for `.contentTransition(.numericText())`.
        static let numeric: Animation = .snappy
        /// Ambient breathing glow loop. Never attach with `.animation` directly —
        /// use `.ambient` so Reduce Motion is honored.
        static let breathe: Animation = .easeInOut(duration: 1.8).repeatForever(autoreverses: true)
        /// Ambient expanding pulse-ring loop. Use with `.ambient`.
        static let pulseRing: Animation = .easeOut(duration: 1.3).repeatForever(autoreverses: false)
        /// Ambient mic-listening pulse loop. Use with `.ambient`.
        static let pulse: Animation = .easeInOut(duration: 0.4).repeatForever(autoreverses: true)
        /// ✚ Endpointing countdown ring (spec §6, delivery slice V5):
        /// linear, since it's tracing down a fixed window rather than
        /// settling into place. `duration` is the adaptive window itself
        /// (`EndpointPolicy`'s 0.6–1.2s range, read off
        /// `CoachVoiceController.endpointDeadline`) — not a fixed constant,
        /// so this is a function rather than a stored `Animation`.
        static func endpoint(_ duration: TimeInterval) -> Animation {
            .linear(duration: duration)
        }

        /// Reduce Motion state, for use outside a View body (e.g. deciding
        /// whether to even start an imperative animation). Inside a View,
        /// prefer `@Environment(\.accessibilityReduceMotion)` so the view
        /// re-renders when the setting changes mid-session.
        static var isReduced: Bool { UIAccessibility.isReduceMotionEnabled }
    }

    // MARK: - Haptics
    /// Canonical `SensoryFeedback` tokens. Haptics fire on state the user
    /// *committed*, never on state the user *observed* — no buzz when data
    /// loads, a stream token arrives, an error card appears, or a background
    /// refresh lands. There is deliberately no `.warning`/`.error` token here:
    /// an error card in this app is always the result of a load, not a tap.
    ///
    /// **Exception (spec §6):** the three `✚` turn-taking cues below —
    /// `turnEnd`, `yourTurn`, `interrupt` — exist so a voice conversation can
    /// be followed without looking at the screen, so they fire on state the
    /// user only *heard themselves cause* (their turn ending, the mic
    /// re-arming, a barge-in landing), not on something they tapped. They
    /// require `setAllowHapticsAndSystemSoundsDuringRecording(true)` on the
    /// active `AVAudioSession` — otherwise iOS silently mutes every haptic
    /// while the mic is live — which `VoiceAudioSession.activate()` sets.
    enum Haptics {
        /// Picking an option — segmented control, list selection.
        static let selection: SensoryFeedback = .selection
        /// Committing an action — sending a message, logging a meal.
        static let commit: SensoryFeedback = .impact(weight: .medium, intensity: 0.7)
        /// A committed action completed successfully.
        static let success: SensoryFeedback = .success
        /// A light on/off toggle the user tapped. Spec §3.1/§6: mic
        /// touch-down and mic stop.
        static let toggle: SensoryFeedback = .impact(weight: .light, intensity: 0.5)

        /// ✚ Turn captured (Listening → Thinking) — the mic stopped and the
        /// turn is now waiting on a transcript. Wired in V3 from
        /// `CoachVoiceController.turnEndTrigger`'s Listening → Transcribing
        /// transition (push-to-talk's closest equivalent); conversation
        /// mode's own Thinking state (V5) reuses the same token.
        static let turnEnd: SensoryFeedback = .impact(weight: .light, intensity: 0.6)
        /// ✚ Mic re-armed after a reply finishes, conversation mode only.
        /// Defined per spec §6/§10 V3 but unused until auto re-arm lands
        /// (V5) — no V3 call site fires this yet.
        static let yourTurn: SensoryFeedback = .selection
        /// ✚ Barge-in accepted. Defined per spec §6/§10 V3 but unused until
        /// barge-in/echo cancellation lands (V7) — no V3 call site fires
        /// this yet.
        static let interrupt: SensoryFeedback = .impact(weight: .light, intensity: 0.4)
    }
}

/// Drives a `repeatForever` animation declaratively so it re-evaluates
/// (and stops) when Reduce Motion is flipped mid-session — an imperative
/// `withAnimation(...repeatForever...)` cannot be cancelled by a later
/// `.animation(nil, value:)` once it has started.
private struct AmbientAnimation<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation
    let value: V
    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}

/// Named transition styles for `.motionTransition`. Reduce Motion means "no
/// large movement", not "no animation" — a cross-fade is substituted, never
/// a hard cut.
enum MotionTransition { case fade, card, fromTop, fromBottom }

private struct MotionTransitionModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let style: MotionTransition
    func body(content: Content) -> some View { content.transition(resolved) }
    private var resolved: AnyTransition {
        guard !reduceMotion else { return .opacity }
        switch style {
        case .fade:       return .opacity
        case .card:       return .opacity.combined(with: .scale(scale: 0.97, anchor: .top))
        case .fromTop:    return .opacity.combined(with: .move(edge: .top))
        case .fromBottom: return .opacity.combined(with: .move(edge: .bottom))
        }
    }
}

/// Press feedback for large tappable cards/rows where `.buttonStyle(.plain)`
/// gives zero visual response to a touch. Scales and dims the label while
/// pressed, animated with `Theme.Motion.micro`.
///
/// Do NOT apply this inside a `.glassEffect` container — scaling a glass view
/// forces a backdrop blur re-render every frame.
struct VitalButtonStyle: ButtonStyle {
    var scale: CGFloat = 0.97
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1.0)
            .opacity(configuration.isPressed ? 0.85 : 1.0)
            .animation(Theme.Motion.micro, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == VitalButtonStyle {
    /// Default press feedback — 0.97 scale + opacity dim.
    static var vital: VitalButtonStyle { VitalButtonStyle() }
    /// Press feedback with a custom scale (e.g. smaller controls want a
    /// subtler 0.94, pills nested in an already-scaling card want 1.0).
    static func vital(scale: CGFloat) -> VitalButtonStyle { VitalButtonStyle(scale: scale) }
}

/// Unified press state for tappable cards/rows (fuel strip, plan rows,
/// profile rows) — 0.98 scale + a slight opacity dim, both animated with
/// `Theme.Motion.micro`. Prefer `.pressableCard` over `.vital`/`.plain` for
/// any new card/row press state so every tappable card in the app reads as
/// one consistent family. Do NOT apply inside a `.glassEffect` container —
/// see `VitalButtonStyle`'s warning above; glass cards (e.g.
/// `MetricTileView`'s grid tiles, `TrendsWeightCard`) keep the opacity-only
/// `TilePressStyle` instead, for the same backdrop-blur-resampling reason.
struct PressableCardStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .opacity(configuration.isPressed ? 0.88 : 1.0)
            .animation(Theme.Motion.micro, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableCardStyle {
    static var pressableCard: PressableCardStyle { PressableCardStyle() }
}

extension View {
    /// Applies `Theme.Typography.screenTitle` with the mock's tight tracking.
    func screenTitleStyle() -> some View {
        self
            .font(Theme.Typography.screenTitle)
            .tracking(-0.4)
    }

    /// The only approved way to attach a `repeatForever` animation. Reads
    /// Reduce Motion from the environment so an ambient loop starts, stops,
    /// or restarts correctly if the user flips the accessibility setting
    /// while the view is on screen.
    func ambient<V: Equatable>(_ animation: Animation, value: V) -> some View {
        modifier(AmbientAnimation(animation: animation, value: value))
    }

    /// Applies a named `MotionTransition`, substituting a cross-fade for any
    /// large movement when Reduce Motion is on.
    func motionTransition(_ style: MotionTransition) -> some View {
        modifier(MotionTransitionModifier(style: style))
    }

    /// A short staggered fade + slide-up for a tab's first-load content
    /// (skeleton → content), applied per card. `index` is clamped to 0...4
    /// (a 5-item cap) so a longer list can never push the last card's
    /// entrance past the 0.5s the screenshot harness's `waitForExistence`
    /// budgets for settling — at 40ms/step plus `Theme.Motion.appear`'s
    /// 0.25s duration, the slowest card finishes at 0.16s + 0.25s = 0.41s.
    /// Reduce Motion: no slide/delay, the card just appears (a crossfade is
    /// still provided by the skeleton→content `.motionTransition` this sits
    /// inside, so nothing pops in as a hard cut).
    ///
    /// Don't use inside `Lazy*` containers — cell reuse resets `@State` and
    /// replays the entrance on scroll.
    func staggeredAppear(index: Int) -> some View {
        modifier(StaggeredAppearModifier(index: index))
    }
}

private struct StaggeredAppearModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let index: Int
    @State private var appeared = false

    func body(content: Content) -> some View {
        content
            .opacity(appeared || reduceMotion ? 1 : 0)
            .offset(y: appeared || reduceMotion ? 0 : 8)
            .onAppear {
                guard !reduceMotion else { return }
                let step = min(max(index, 0), 4)
                let delay = Double(step) * 0.04
                withAnimation(Theme.Motion.appear.delay(delay)) {
                    appeared = true
                }
            }
    }
}
