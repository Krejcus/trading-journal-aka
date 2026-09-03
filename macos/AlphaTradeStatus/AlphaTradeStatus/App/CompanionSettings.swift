import Foundation

@MainActor
final class CompanionSettings: ObservableObject {
    enum Key {
        static let autoOpen = "companion.autoOpenOnChange"
        static let includeImprovements = "companion.autoOpenImprovements"
        static let nativeNotifications = "companion.nativeNotifications"
        static let worseningSound = "companion.worseningSound"
    }

    @Published var autoOpen: Bool {
        didSet { defaults.set(autoOpen, forKey: Key.autoOpen) }
    }

    @Published var includeImprovements: Bool {
        didSet { defaults.set(includeImprovements, forKey: Key.includeImprovements) }
    }

    @Published var nativeNotifications: Bool {
        didSet { defaults.set(nativeNotifications, forKey: Key.nativeNotifications) }
    }

    @Published var worseningSound: Bool {
        didSet { defaults.set(worseningSound, forKey: Key.worseningSound) }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Key.autoOpen: true,
            Key.includeImprovements: false,
            Key.nativeNotifications: true,
            Key.worseningSound: false
        ])
        autoOpen = defaults.bool(forKey: Key.autoOpen)
        includeImprovements = defaults.bool(forKey: Key.includeImprovements)
        nativeNotifications = defaults.bool(forKey: Key.nativeNotifications)
        worseningSound = defaults.bool(forKey: Key.worseningSound)
    }
}
