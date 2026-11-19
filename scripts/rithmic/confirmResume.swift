// Invoked only for a previously granted session. The live service validates the grant again after this returns.
import Foundation
import LocalAuthentication
import Darwin

guard CommandLine.arguments.count == 2 else { exit(2) }
let context = LAContext()
context.localizedFallbackTitle = ""
var reason: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &reason) else {
    FileHandle.standardError.write(Data("Touch ID není dostupné.\n".utf8))
    exit(1)
}
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: CommandLine.arguments[1]) { accepted, _ in
    exit(accepted ? 0 : 1)
}
dispatchMain()
