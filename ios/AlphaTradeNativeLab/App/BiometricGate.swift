import LocalAuthentication

enum BiometricGate {
    static func authenticate() async -> Bool {
        let context = LAContext()
        context.localizedCancelTitle = "Zrušit"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
        do {
            return try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Odemknout finanční data v AlphaTrade Native Lab"
            )
        } catch {
            return false
        }
    }
}
