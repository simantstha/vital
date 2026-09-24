import AppIntents
import SwiftUI

/// The small confirmation snippet Siri/Shortcuts shows under
/// `LogMealIntent`'s dialog: the logged meal's name · kcal, an inline
/// `Undo` button (wired straight to `UndoQuickLogIntent`, no app launch
/// needed), and "Edit in Vital" which opens the Diet sheet via
/// `vital://log?event=<id>` (see `LogDeepLinkRoute`).
struct QuickLogSnippetView: View {
    let id: String
    let name: String
    let kcal: Int

    private var editURL: URL? {
        URL(string: "vital://log?event=\(id)")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(name)
                    .font(.headline)
                Spacer()
                Text("\(kcal) kcal")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Button(intent: UndoQuickLogIntent(id: id)) {
                    Text("Undo")
                }

                Spacer()

                if let editURL {
                    Link("Edit in Vital", destination: editURL)
                        .font(.footnote)
                }
            }
        }
        .padding()
    }
}
