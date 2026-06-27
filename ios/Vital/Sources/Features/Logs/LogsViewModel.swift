import Foundation
import SwiftUI

// MARK: - Display model

struct LogDisplayItem: Identifiable {
    let id: String
    let type: String
    let title: String
    let subtitle: String
    let date: Date
    let sfSymbol: String
    let accentColor: Color

    var relativeTime: String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - Day group

struct LogDayGroup: Identifiable {
    let id: String           // e.g. "2026-06-26"
    let displayLabel: String // e.g. "Today" / "Yesterday" / "Thu, Jun 26"
    let items: [LogDisplayItem]
}

// MARK: - ViewModel

@MainActor
final class LogsViewModel: ObservableObject {

    @Published var groups: [LogDayGroup] = []
    @Published var isLoading = false
    @Published var errorMessage: String? = nil

    private let apiClient = APIClient.shared

    func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let response = try await apiClient.fetchLogs(days: 7)
            groups = buildGroups(from: response.items)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    // MARK: - Private helpers

    private func buildGroups(from items: [LogItem]) -> [LogDayGroup] {
        let calendar = Calendar.current
        let isoParser = ISO8601DateFormatter()
        isoParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        // Parse dates, fallback to omitting fractional seconds
        let isoParserNF: ISO8601DateFormatter = {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime]
            return f
        }()

        let displayItems: [LogDisplayItem] = items.compactMap { item in
            let date = isoParser.date(from: item.timestamp)
                    ?? isoParserNF.date(from: item.timestamp)
            guard let date else { return nil }
            return LogDisplayItem(
                id:          item.id,
                type:        item.type,
                title:       item.title,
                subtitle:    item.subtitle,
                date:        date,
                sfSymbol:    symbol(for: item.type),
                accentColor: color(for: item.type)
            )
        }

        // Group by calendar day
        let grouped = Dictionary(grouping: displayItems) { item in
            calendar.startOfDay(for: item.date)
        }

        let today     = calendar.startOfDay(for: Date())
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!

        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "EEE, MMM d"

        let keyFormatter = DateFormatter()
        keyFormatter.dateFormat = "yyyy-MM-dd"

        return grouped
            .sorted { $0.key > $1.key }
            .map { (day, items) in
                let label: String
                if calendar.isDate(day, inSameDayAs: today) {
                    label = "Today"
                } else if calendar.isDate(day, inSameDayAs: yesterday) {
                    label = "Yesterday"
                } else {
                    label = dayFormatter.string(from: day)
                }
                let sortedItems = items.sorted { $0.date > $1.date }
                return LogDayGroup(
                    id: keyFormatter.string(from: day),
                    displayLabel: label,
                    items: sortedItems
                )
            }
    }

    private func symbol(for type: String) -> String {
        switch type {
        case "meal_logged":       return "fork.knife"
        case "workout_completed": return "figure.run"
        case "weight_logged":     return "scalemass"
        case "hrv_reading":       return "waveform.path.ecg"
        case "sleep_session":     return "bed.double.fill"
        default:                  return "circle.fill"
        }
    }

    private func color(for type: String) -> Color {
        switch type {
        case "meal_logged":       return Theme.Colors.accent
        case "workout_completed": return Theme.Colors.indigo
        case "weight_logged":     return Theme.Colors.textSecondary
        case "hrv_reading":       return Theme.Colors.alert
        case "sleep_session":     return Theme.Colors.indigo
        default:                  return Theme.Colors.textSecondary
        }
    }
}
