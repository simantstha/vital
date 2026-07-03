import Foundation

// MARK: - Chat message model

struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, assistant }

    let id: UUID
    let role: Role
    var text: String

    init(id: UUID = UUID(), role: Role, text: String) {
        self.id = id
        self.role = role
        self.text = text
    }
}

// MARK: - ViewModel

@MainActor
final class CoachViewModel: ObservableObject {

    @Published var messages: [ChatMessage] = [
        ChatMessage(
            role: .assistant,
            text: "Hey! I'm your Vital coach. Ask me anything about your health trends, sleep, or how to optimize your day."
        )
    ]

    @Published var input: String = ""
    @Published var isStreaming: Bool = false
    @Published var errorMessage: String? = nil

    private let api = APIClient.shared

    // MARK: - Send

    func send() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }

        input = ""
        errorMessage = nil

        // Append user message
        messages.append(ChatMessage(role: .user, text: trimmed))

        // Create placeholder assistant message that we fill in as tokens arrive
        let assistantId = UUID()
        messages.append(ChatMessage(id: assistantId, role: .assistant, text: ""))

        isStreaming = true

        Task {
            defer { isStreaming = false }

            do {
                let stream = api.streamCoach(message: trimmed)
                for try await delta in stream {
                    if let idx = messages.firstIndex(where: { $0.id == assistantId }) {
                        messages[idx].text += delta
                    }
                }
            } catch {
                // Replace empty placeholder with error text so the bubble isn't blank
                if let idx = messages.firstIndex(where: { $0.id == assistantId }) {
                    if messages[idx].text.isEmpty {
                        messages[idx].text = "Sorry, I couldn't reach the server. Please try again."
                    }
                }
                errorMessage = error.localizedDescription
            }
        }
    }
}
