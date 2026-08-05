import Foundation

/// Device-wide unit-system preference — metric vs imperial — backing every
/// `UnitFormat` call site across Profile, Trends, and PersonalDetails.
/// Singleton over `UserDefaults`, the same shared-singleton idiom as
/// `NotificationManager.shared`. Unlike `NotificationManager` (which
/// resolves permission state asynchronously off `UNUserNotificationCenter`),
/// `current` is resolved SYNCHRONOUSLY in `init` so there is no flash of
/// wrong units on cold start.
@MainActor
final class UnitPreference: ObservableObject {

    static let shared = UnitPreference()

    /// The resolved unit system for this session. Starts at the stored
    /// preference (or the device's locale-derived default if none is
    /// stored) and is later overridden by `applyServerValue` once
    /// `users.unit_system` loads.
    @Published private(set) var current: UnitSystem

    private let defaults: UserDefaults

    /// Guards the locale-default adoption PATCH (see `applyServerValue`) so
    /// it fires at most once per app session. `applyServerValue` is called
    /// from both `ProfileViewModel.load()` and `TrendsViewModel.loadSummary()`
    /// on cold start; without this flag both call sites would independently
    /// observe a `nil` server value and race to PATCH the same adoption.
    private var hasAdoptedLocaleDefault = false

    private enum Keys {
        static let unitSystem = "vital.unitSystem"
    }

    /// `defaults` is injectable so tests can pass a `UserDefaults(suiteName:)`
    /// instance instead of polluting `.standard`.
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        current = Self.resolve(stored: defaults.string(forKey: Keys.unitSystem))
    }

    /// Pure resolution: nil or an unrecognised stored raw value falls back
    /// to the device's locale-derived default rather than hardcoding metric.
    static func resolve(stored: String?) -> UnitSystem {
        guard let stored, let system = UnitSystem(rawValue: stored) else {
            return .deviceDefault
        }
        return system
    }

    /// Applies the server's `users.unit_system` column value.
    ///
    /// Why this exists: the column is nullable, and NULL resolves
    /// differently on each side of the client/server split. The iOS client
    /// falls back to the device's locale (`resolve(stored:)` above) because
    /// only the client can see that locale. The backend, which has no
    /// concept of device locale, falls back to hardcoded `'metric'`. Every
    /// user who onboarded before this column existed has NULL, so a
    /// US-locale user sees imperial units in the app while server-generated
    /// prose (coach, brief, analysis) talks in km/kg.
    ///
    /// The client is the only party that can see the true locale-derived
    /// default, so on a `nil`/unrecognised server value it needs to adopt the
    /// current (locale-derived) value permanently by persisting it to the
    /// server — turning the implicit default into an explicit stored
    /// preference so both sides agree from then on. This does NOT touch
    /// `current`: the value the user already sees is correct, we're just
    /// flagging that it needs to be persisted. Do not "simplify" this into a
    /// plain no-op — that reintroduces the asymmetry for every pre-existing
    /// NULL user.
    ///
    /// When `raw` IS a valid value, behaviour is unchanged from before:
    /// apply and persist it locally. Idempotent: reapplying the same raw
    /// value more than once has no further effect.
    ///
    /// Returns `true` exactly once per session — the first time a `nil`/
    /// unrecognised value is seen — to tell the caller it should PATCH the
    /// locale default up to the server. This preference store only owns
    /// preference state, not network I/O, so it reports intent rather than
    /// making the call itself; the two call sites (`ProfileViewModel.load`,
    /// `TrendsViewModel.loadSummary`) both check this flag, so the one-shot
    /// guard here prevents both from firing the PATCH.
    @discardableResult
    func applyServerValue(_ raw: String?) -> Bool {
        guard let raw, let system = UnitSystem(rawValue: raw) else {
            return adoptLocaleDefaultIfNeeded()
        }
        write(system, persist: true)
        return false
    }

    /// One-shot guard described in `applyServerValue`. Returns `true` the
    /// first time it's called per session (or since the last `clear()`), and
    /// `false` on every subsequent call.
    private func adoptLocaleDefaultIfNeeded() -> Bool {
        guard !hasAdoptedLocaleDefault else { return false }
        hasAdoptedLocaleDefault = true
        return true
    }

    /// Explicit user choice (e.g. from a future settings toggle).
    func set(_ system: UnitSystem) {
        write(system, persist: true)
    }

    /// Drops the stored preference and reverts to the device default —
    /// called on sign-out so the next account starts from a clean locale
    /// fallback rather than inheriting the previous user's server value.
    func clear() {
        defaults.removeObject(forKey: Keys.unitSystem)
        write(.deviceDefault, persist: false)
        hasAdoptedLocaleDefault = false
    }

    /// Persists to `UserDefaults` whenever asked, but only publishes
    /// (mutates `current`, firing `objectWillChange`) when the value
    /// actually changes.
    private func write(_ system: UnitSystem, persist: Bool) {
        if persist { defaults.set(system.rawValue, forKey: Keys.unitSystem) }
        guard system != current else { return }
        current = system
    }
}
