import XCTest
@testable import Vital

/// A fake `QuickLogServicing` — success/failure driven by `result`/`error`,
/// records calls so tests can assert what `LogMealIntent`/`UndoQuickLogIntent`
/// passed through.
final class FakeQuickLogService: QuickLogServicing, @unchecked Sendable {
    var result: QuickLogResult?
    var error: Error?
    private(set) var quickLogCalls: [String] = []
    private(set) var undoCalls: [String] = []

    func quickLog(text: String) async throws -> QuickLogResult {
        quickLogCalls.append(text)
        if let error { throw error }
        return result ?? QuickLogResult(id: "event-1", name: "food", kcal: 100, slot: "lunch")
    }

    func undo(id: String) async throws {
        undoCalls.append(id)
        if let error { throw error }
    }
}

@MainActor
final class LogMealIntentTests: XCTestCase {

    // MARK: - Pure dialog formatting

    func testConfirmationDialogFormatsNameAndKcal() {
        XCTAssertEqual(
            LogMealIntent.confirmationDialog(name: "2 eggs and toast", kcal: 320),
            "Logged 2 eggs and toast, 320 kcal"
        )
    }

    // MARK: - perform() success

    func testPerformCallsServiceWithTrimmedTextAndSucceeds() async throws {
        let fake = FakeQuickLogService()
        fake.result = QuickLogResult(id: "event-42", name: "2 eggs and toast", kcal: 320, slot: "breakfast")
        var intent = LogMealIntent(service: fake)
        intent.text = "  two eggs and toast  "

        _ = try await intent.perform()

        XCTAssertEqual(fake.quickLogCalls, ["two eggs and toast"])
    }

    // MARK: - perform() failure paths

    func testPerformThrowsEmptyTextValidationErrorForBlankInput() async {
        let fake = FakeQuickLogService()
        var intent = LogMealIntent(service: fake)
        intent.text = "   "

        await XCTAssertThrowsErrorAsync(try await intent.perform()) { error in
            XCTAssertEqual(error as? LogMealIntentError, .emptyText)
        }
        XCTAssertTrue(fake.quickLogCalls.isEmpty, "must not call the service for empty text")
    }

    func testPerformMaps401ToNotSignedInDialog() async {
        let fake = FakeQuickLogService()
        fake.error = APIError.serverError(401)
        var intent = LogMealIntent(service: fake)
        intent.text = "two eggs and toast"

        await XCTAssertThrowsErrorAsync(try await intent.perform()) { error in
            XCTAssertEqual(error as? LogMealIntentError, .notSignedIn)
        }
        XCTAssertEqual(LogMealIntentError.notSignedIn.errorDescription, "Open Vital to sign in first.")
    }

    func testPerformMapsMealNotFoundToNotFoundDialog() async {
        let fake = FakeQuickLogService()
        fake.error = APIError.mealNotFound
        var intent = LogMealIntent(service: fake)
        intent.text = "unobtainium soup"

        await XCTAssertThrowsErrorAsync(try await intent.perform()) { error in
            XCTAssertEqual(error as? LogMealIntentError, .notFound)
        }
        XCTAssertEqual(
            LogMealIntentError.notFound.errorDescription,
            "I couldn't find that food. Try being more specific."
        )
    }

    // MARK: - UndoQuickLogIntent

    func testUndoIntentCallsServiceUndoWithId() async throws {
        let fake = FakeQuickLogService()
        let intent = UndoQuickLogIntent(id: "event-42", service: fake)

        _ = try await intent.perform()

        XCTAssertEqual(fake.undoCalls, ["event-42"])
    }
}

/// XCTest has no built-in async `assertThrowsError` — this is the standard
/// small helper shape for it.
func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void = { _ in },
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected an error to be thrown", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}
