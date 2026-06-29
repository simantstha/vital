// Template for the gitignored secrets file.
//
// Setup:
//   1. Copy this file to Sources/Core/Secrets.swift
//   2. Replace the placeholder with the real API_SHARED_SECRET (must match the
//      Fly secret on the backend).
//   3. Regenerate the Xcode project if needed:  xcodegen generate
//
// Sources/Core/Secrets.swift is gitignored and lives only on your machine.
// This .example file sits outside Sources/, so Xcode never compiles it.

import Foundation

enum AppSecrets {
    static let apiToken = "REPLACE_WITH_API_SHARED_SECRET"
}
