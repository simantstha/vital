import Foundation

extension Error {
    /// True when this error is a task cancellation rather than a real failure.
    /// `URLSession` surfaces cancellation as `URLError.cancelled`; structured
    /// concurrency surfaces it as `CancellationError`. Neither is worth showing
    /// the user — the work simply stopped, and the view reloads when it returns.
    var isCancellation: Bool {
        self is CancellationError || (self as? URLError)?.code == .cancelled
    }
}
