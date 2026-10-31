import XCTest
@testable import Vital

/// server_error__coach: the "Coach is offline" banner sat above an active-looking
/// "Ask me anything..." greeting, chips and composer. While offline the view model
/// now says so in the transcript and reports `showsOfflineState`, which `CoachView`
/// reads to dim and disable the chips, the mic and the composer.
@MainActor
final class CoachOfflineStateTests: XCTestCase {

    private func makeViewModel(openerFailure: Error?) -> (CoachViewModel, FakeCoachAPI) {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(messages: [], activePersona: .vital, pendingCard: nil))
        api.openerFailure = openerFailure
        return (CoachViewModel(api: api), api)
    }

    private func waitForOpener(_ viewModel: CoachViewModel) async {
        for _ in 0..<300 {
            if !viewModel.isOpening { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    private func assistantTexts(_ viewModel: CoachViewModel) -> [String] {
        viewModel.rows.compactMap { row in
            if case .message(let message) = row, message.role == .assistant { return message.text }
            return nil
        }
    }

    func testOfflineOpenerReplacesTheGreetingAndLocksTheComposer() async {
        let (viewModel, _) = makeViewModel(openerFailure: URLError(.notConnectedToInternet))

        viewModel.loadOpener()
        await waitForOpener(viewModel)

        XCTAssertTrue(viewModel.isCoachOffline)
        XCTAssertTrue(viewModel.showsOfflineState)
        XCTAssertEqual(assistantTexts(viewModel), [CoachViewModel.offlineOpenerText])
        // Not the greeting that invites a question the coach cannot answer.
        let line = CoachViewModel.offlineOpenerText
        XCTAssertFalse(line.contains("Ask me anything"))
        XCTAssertNotEqual(line, CoachViewModel.returningFallbackOpener)
        XCTAssertNotEqual(line, CoachViewModel.newUserFallbackOpener)
    }

    func testOnlineOpenerLeavesTheComposerUnlocked() async {
        let (viewModel, _) = makeViewModel(openerFailure: nil)

        viewModel.loadOpener()
        await waitForOpener(viewModel)

        XCTAssertFalse(viewModel.showsOfflineState)
        XCTAssertEqual(assistantTexts(viewModel), ["Fresh opener"])
    }

    func testOnboardingNeverShowsTheOfflineState() {
        let viewModel = CoachViewModel(mode: "onboarding", api: FakeCoachAPI(
            restoration: CoachRestorationResponse(messages: [], activePersona: .vital, pendingCard: nil)
        ))
        XCTAssertFalse(viewModel.showsOfflineState)
    }

    func testRetryClearsTheOfflineLineAndRecoversWhenTheCoachIsBack() async {
        let (viewModel, api) = makeViewModel(openerFailure: URLError(.notConnectedToInternet))
        viewModel.loadOpener()
        await waitForOpener(viewModel)
        XCTAssertTrue(viewModel.showsOfflineState)

        api.openerFailure = nil
        viewModel.retryOpener()
        await waitForOpener(viewModel)

        XCTAssertFalse(viewModel.showsOfflineState)
        XCTAssertEqual(assistantTexts(viewModel), ["Fresh opener"], "the offline line is gone, not stacked")
    }

    func testRetryWhileStillOfflineKeepsTheLockWithOneOfflineLine() async {
        let (viewModel, _) = makeViewModel(openerFailure: URLError(.notConnectedToInternet))
        viewModel.loadOpener()
        await waitForOpener(viewModel)

        viewModel.retryOpener()
        await waitForOpener(viewModel)

        XCTAssertTrue(viewModel.showsOfflineState)
        XCTAssertEqual(assistantTexts(viewModel), [CoachViewModel.offlineOpenerText])
    }

    func testRetryIsANoOpWhenNotOffline() async {
        let (viewModel, _) = makeViewModel(openerFailure: nil)
        viewModel.loadOpener()
        await waitForOpener(viewModel)

        viewModel.retryOpener()

        XCTAssertEqual(assistantTexts(viewModel), ["Fresh opener"])
        XCTAssertFalse(viewModel.isOpening)
    }

    func testSendingClearsTheOfflineLock() async {
        let (viewModel, _) = makeViewModel(openerFailure: URLError(.notConnectedToInternet))
        viewModel.loadOpener()
        await waitForOpener(viewModel)
        XCTAssertTrue(viewModel.showsOfflineState)

        viewModel.input = "hello"
        viewModel.send()

        XCTAssertFalse(viewModel.showsOfflineState)
    }

    func testRowsRemovingOfflineOpenerKeepsEverythingElse() {
        let offline = ChatRow.message(ChatMessage(role: .assistant, text: CoachViewModel.offlineOpenerText))
        let user = ChatRow.message(ChatMessage(role: .user, text: CoachViewModel.offlineOpenerText))
        let other = ChatRow.message(ChatMessage(role: .assistant, text: "Fresh opener"))
        let kept = CoachViewModel.rowsRemovingOfflineOpener([offline, user, other])
        XCTAssertEqual(kept, [user, other])
    }
}
