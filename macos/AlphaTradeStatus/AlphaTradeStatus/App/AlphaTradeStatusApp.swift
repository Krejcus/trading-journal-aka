import SwiftUI

@main
struct AlphaTradeStatusApp: App {
    @NSApplicationDelegateAdaptor(AlphaTradeStatusAppDelegate.self)
    private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
