import SwiftUI

@main
struct VitalApp: App {
    var body: some Scene {
        WindowGroup {
            // No forced color scheme — Vital follows the system appearance so
            // the adaptive Liquid Glass palette renders correctly in light & dark.
            RootView()
        }
    }
}
