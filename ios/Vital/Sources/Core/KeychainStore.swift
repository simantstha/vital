import Foundation
import Security
import os

/// Minimal generic-password Keychain wrapper for the session token.
///
/// Stored under a fixed service name so the token survives app relaunches
/// but is scoped to this app only (Keychain access groups aren't used).
enum KeychainStore {
    private static let service = "com.vital.session"
    private static let account = "sessionToken"

    /// Same `Logger(subsystem:category:)` convention as `APIClient`'s
    /// `voiceLogger`/`VoiceTurnTimer.logger` — lets Console/Instruments
    /// filter Keychain persistence failures on their own.
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.simantstha.vital",
        category: "keychain"
    )

    /// Saves (or replaces) the session token.
    static func saveSessionToken(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]

        // Remove any existing item first — SecItemAdd fails on a duplicate.
        let deleteStatus = SecItemDelete(query as CFDictionary)
        if deleteStatus != errSecSuccess, deleteStatus != errSecItemNotFound {
            logger.error("saveSessionToken: SecItemDelete failed with status \(deleteStatus, privacy: .public)")
        }

        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        if addStatus != errSecSuccess {
            logger.error("saveSessionToken: SecItemAdd failed with status \(addStatus, privacy: .public)")
        }
    }

    /// Loads the session token, or nil if none is stored.
    static func loadSessionToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8)
        else { return nil }

        return token
    }

    /// Deletes the stored session token, if any.
    static func deleteSessionToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        // errSecItemNotFound just means there was nothing to delete — fine.
        if status != errSecSuccess, status != errSecItemNotFound {
            logger.error("deleteSessionToken: SecItemDelete failed with status \(status, privacy: .public)")
        }
    }

    /// Keychain items survive app deletion, but UserDefaults do not. On the
    /// first launch after a fresh install we therefore purge any session token
    /// left behind by a previous install — otherwise a reinstall resurrects a
    /// stale (often invalid, e.g. expired or signed with a rotated secret)
    /// session, skipping the sign-in screen and leaving every API call 401ing.
    ///
    /// Must run before anything reads the token (AuthViewModel.init,
    /// AppDelegate, APIClient), so it's invoked at the very top of
    /// application(_:didFinishLaunchingWithOptions:).
    static func purgeIfFreshInstall() {
        let installedKey = "app.hasLaunchedBefore"
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: installedKey) else { return }
        deleteSessionToken()
        defaults.set(true, forKey: installedKey)
    }
}
