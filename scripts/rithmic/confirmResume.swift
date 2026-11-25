// Invoked only for a previously granted session. The live service validates the grant again after this returns.
import Foundation
import LocalAuthentication
import Darwin

guard CommandLine.arguments.count == 2 else { exit(2) }
let context = LAContext()
func fail(_ stage: String, _ error: NSError?) -> Never {
    let detail = error.map { "\($0.localizedDescription) [\($0.domain) \($0.code)]" } ?? "macOS důvod neuvedl."
    FileHandle.standardError.write(Data("\(stage) — \(detail)\n".utf8))
    exit(1)
}
var reason: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &reason) else {
    fail("Systémové ověření není dostupné", reason)
}
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: CommandLine.arguments[1]) { accepted, error in
    if accepted { exit(0) }
    fail("Systémové ověření skončilo", error as NSError?)
}
dispatchMain()
