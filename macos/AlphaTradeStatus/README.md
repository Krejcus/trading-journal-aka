# AlphaTrade Status — macOS 0.2 local candidate

Native, menu-bar-only companion built with AppKit `NSStatusItem` + `NSPopover`
and SwiftUI content. It is a read-only observer of the allowlisted AlphaTrade
cloud status; it has no broker credential, broker request, copier command,
ARM/DISARM, Flatten, worker-control, or incoming-network path.
The native target links neither the Supabase SDK nor Tradovate code; Supabase
is used only behind the separately deployed server API.

Version 0.2.0 (build 5) is the installed production client in
`/Users/filipkrejca/Applications/AlphaTrade Status.app` (ad-hoc signed,
hardened runtime, App Sandbox + outgoing network only). The Supabase migration
`20260901101932_mac_companion_devices_v1` is applied in production and the
Mac is paired. Build 5 removes the read-only footer note and the system focus
ring on footer buttons (`focusEffectDisabled()` at the hosted root).

Operational lesson (2026-09-02): the companion API must live in `origin/main`.
A production deployment promoted from a local source tree is replaced by the
next automatic Vercel deploy from `main`; that is exactly how the status route
went 404 while the app kept showing a fail-closed "STAV NEDOSTUPNÝ".

## Read-only cloud runtime

- Release builds use only the fixed HTTPS origin
  `https://alphatrade-mentor-15.vercel.app`; redirects, cookies, URL cache, and
  persistent response cache are disabled.
- The credential and pending pairing code live only in the standard macOS
  login Keychain under service `app.alphatrade.status.companion`, account
  `credential-v1`, without synchronization. The store requests
  `AfterFirstUnlockThisDeviceOnly` where the login Keychain supports that
  accessibility class and otherwise keeps the item under the login Keychain's
  encrypted per-app ACL; it never falls back to a plaintext file.
- The only accepted server scope is `copier.status.read`. A rejected or revoked
  credential is removed locally and cannot regain access.
- Status polling is at most every 5 seconds for LIVE/problems and 8 seconds for
  quiet SHADOW/DISARMED. A local one-second tick enforces the exact 10/90 second
  freshness boundaries without waiting for the next request; polling shortens
  adaptively near `verifiedUntil`.
- A wake notification first invalidates the old server-time anchor and renders
  the last-known state as unknown, then fetches. A failed wake request can never
  restore a pre-sleep green LIVE state.
- Status data comes only from the cloud runtime database. Exposure is currently
  unverified (`verifiedAt: null`, no positions, no follower ack, unknown working
  orders), so 0.2 never claims accounts are flat.
- Safe diagnostics contain version, pairing yes/no, presentation state,
  contract/revision, transport label, and scope only — never a credential or
  pairing code.

When no credential exists, the Mac creates a 12-character one-time code. The
user confirms it while signed in at LIVE → Connections (deep link
`?page=live&tab=connections`). The secret never leaves Keychain in plaintext;
only its digest is sent at pairing start. The same PWA card lists devices and
allows rename or revocation without knowing the secret.

## Build and test

Run the component, reducer, API, Keychain, lifecycle, and render suite:

```bash
xcodebuild \
  -project macos/AlphaTradeStatus/AlphaTradeStatus.xcodeproj \
  -scheme AlphaTradeStatus \
  -configuration Debug \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath /tmp/AlphaTradeStatusDerivedData \
  CODE_SIGNING_ALLOWED=NO \
  -only-testing:AlphaTradeStatusTests \
  test
```

Build the same code path that a production installation would use:

```bash
xcodebuild \
  -project macos/AlphaTradeStatus/AlphaTradeStatus.xcodeproj \
  -scheme AlphaTradeStatus \
  -configuration Release \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath /tmp/AlphaTradeStatusReleaseDerivedData \
  CODE_SIGNING_ALLOWED=NO \
  build
```

The current local gate is 32 XCTest plus a clean Release build. This is not
a substitute for the post-migration production E2E gate.

## Native menu-bar regression gate

`AlphaTradeStatusUITests` launches the real AppKit status item, validates its
native frame, opens the popover, checks visible LIVE content, expands a section,
closes it, and reopens it. Build the UI runner with:

```bash
xcodebuild \
  -project macos/AlphaTradeStatus/AlphaTradeStatus.xcodeproj \
  -scheme AlphaTradeStatusUI \
  -configuration Debug \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath /tmp/AlphaTradeStatusDerivedData \
  CODE_SIGNING_ALLOWED=NO \
  build-for-testing
```

On 2026-09-01 the current managed host's XCUITest runner could stall before
creating its test worker (`waiting for workers to materialize`). That
historical attempt is not a passing UI test. Deterministic render snapshots and
manual native inspection are useful visual gates, but the real UI test should
still be run on a host where the runner starts normally.

Always stop an older Debug run before evaluating a rebuild. macOS can keep an
existing `LSUIElement` process alive; rebuilding its bundle does not replace
already loaded code.

## Deterministic Debug fixtures

Only Debug builds honor an explicitly supplied `ALPHATRADE_STATUS_FIXTURE`:

- `live`
- `live-ack-unavailable`
- `shadow`
- `disarmed`
- `disarmed-exposure`
- `disarmed-unverified`
- `intervention`
- `unknown`
- `offline`

Without that variable, Debug uses the read-only cloud client. Release builds
always ignore the fixture variable, specifically so the old mock LaunchAgent
cannot pin a future 0.2 installation to illustrative LIVE data. No fixture
performs a network or broker request.
