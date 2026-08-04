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

    /// Applies the server's `users.unit_system` column value. A `nil` (the
    /// column not yet set for this user) is a no-op, so the locale fallback
    /// — or a previously-applied value — stands. Idempotent: reapplying the
    /// same raw value more than once has no further effect.
    func applyServerValue(_ raw: String?) {
        guard let raw, let system = UnitSystem(rawValue: raw) else { return }
        write(system, persist: true)
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
