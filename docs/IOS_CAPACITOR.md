# AlphaTrade iOS hybrid

The production web UI remains the single source of truth. `npm run ios:sync`
creates the native Vite bundle without the PWA service worker and copies it into
the Capacitor project. The original SwiftUI capability lab is preserved in
`ios/`; the shipping hybrid spike is in `capacitor-ios/`.

## Build and run

```bash
npm install
npm run ios:sync
open capacitor-ios/App/App.xcodeproj
```

`ios:sync` runs `ios:doctor` before and after Capacitor generation. The doctor
fails closed if the bundle ID, OAuth scheme, privacy usage strings, Keychain
protection, Swift plugin target membership/registration, app icon, or disabled
bridge logging drift. Generated `dist-native/` and `App/App/public/` remain
ignored; all source Swift, Xcode project, assets, config, bridge code, and tests
belong in this repository.

The native bundle uses `capacitor://localhost`, while Vercel functions remain at
`https://alphatrade-mentor-15.vercel.app`. Relative API paths must go through
`apiUrl()` from `utils/runtimeConfig.ts`. Do not add a service worker to the
native build.

## Last-known offline dashboard

After every successful full dashboard refresh, the web data layer writes one
user-scoped IndexedDB snapshot and awaits its persistence. Existing per-feature
caches remain available for newer local edits. If Supabase cannot be reached,
an authenticated returning user can open the dashboard from that cache instead
of getting an empty screen or a permanent loader. The UI always labels this as
last-known data and shows the snapshot time when available; it does not claim
that cloud-backed actions work offline. The native build still does not register
a service worker, so there is only one data cache layer.

## OAuth prerequisite

Before Google login can complete, add this exact redirect URL to the Supabase
Auth redirect allow-list:

```text
alphatrade-native://auth/callback
```

The app opens OAuth with `@capacitor/browser`, receives the custom-scheme link
with `@capacitor/app`, and exchanges the PKCE code for a Supabase session.

In the native build, Supabase session and PKCE storage is backed by the iOS
Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) rather than WebView
`localStorage`. On the first upgraded launch, an existing legacy auth value is
copied to Keychain and removed from WebView storage only after the secure write
succeeds. A failed write leaves the recoverable legacy value intact. The web
build continues to use its Safari-compatible storage adapter. Keychain items
can outlive app deletion, so a future explicit "reset this device" flow must
clear secure auth storage as part of a reviewed, versioned lifecycle migration.

## Notifications

The native build uses `@capacitor/local-notifications` for on-device tests and
the Settings alert lab. Tapping a notification routes back into the shared web
application through the native shell bridge, including after a cold launch.
The one-click gallery schedules 22 read-only scenarios covering the full trade,
copier, account-lock, risk and recovery matrix. Trade open/close scenarios
render a 1200 x 675 PNG preview from the shared web
code, store it temporarily in the iOS cache, and attach it to the expandable
notification. Cached previews older than seven days are removed the next time a
rich alert is created. The same attachment input can later receive the user's
actual saved trade screenshot.

Notification categories expose contextual system actions for LIVE, Journal,
Coach, and quick trade capture. Risk scenarios use iOS time-sensitive delivery;
the app does not request the restricted critical-alert entitlement.

Server-origin alerts use the separate official
`@capacitor/push-notifications` path. After login, the app requests permission,
waits for a real APNs device token, detects sandbox versus production signing,
and registers the token through the authenticated
`/api/native-push-subscription` endpoint. The underlying table is server-only;
neither anon nor authenticated clients can enumerate device tokens. Logout
removes the current installation before the Supabase session is revoked.

`api/cron/send-alerts.ts` fans the existing copier watchdog and configured
alerts out to both legacy Web Push and native APNs devices during the migration.
The APNs provider uses token authentication with `APNS_KEY_ID`, `APNS_TEAM_ID`,
and either `APNS_PRIVATE_KEY` or `APNS_PRIVATE_KEY_BASE64`. These secrets must
exist in the deployment. `/api/native-push-test` provides an authenticated
server-origin smoke test. Force-quit locked-phone delivery and immediate
ARM/DISARM were physically verified on the target iPhone; each newly added
event class still receives its own end-to-end smoke check.

Trade notifications also expose an authenticated text-input action named
`Přidat poznámku`. The entered text opens the existing manual trade form as a
review-only draft note, even after a cold launch; it never writes a trade by
itself. The delivery panel can set icon badges to 1 or 5 and clear them. Opening
a notification clears the badge, as does cancelling all pending alerts.

Physical smoke test: in Settings → Notifications, schedule the test, leave the
app, expand the notification, choose `Přidat poznámku`, type a short sentence,
and submit. AlphaTrade must open the manual form with that sentence in Notes;
closing the form without Save must leave the journal unchanged.

Session boundary and evening-audit reminders are mirrored into recurring iOS
calendar notifications for Monday through Friday. They therefore fire when the
app is suspended or terminated, using the same live-session times and alert
toggles as the web UI. The scheduler checks permission without prompting on
launch, replaces only its own stable identifiers when settings change, and
preserves one-off alert-lab tests. Cancelling lab tests likewise leaves the
recurring session plan active.

iOS keeps at most 64 pending local notifications per app. AlphaTrade reserves
four slots and schedules at most 60 recurring reminders, prioritizing the
evening audit. Settings reports if a larger configuration was truncated. The
data-dependent Guardian warning that preparation is still missing is not
scheduled blindly: it remains a live/push decision so the app cannot send a
stale warning after preparation was completed elsewhere.

## Native capability lab

Settings contains a device-only lab backed by `AlphaTradeNativePlugin.swift`:

- Privacy Mode verifies the owner with Face ID, Touch ID, or the device
  passcode. A native blur shield covers the window before iOS captures the app
  switcher snapshot, while the shared React gate handles foreground unlock.
- Screen recording and AirPlay/mirroring are protected independently of the
  optional Face ID lock. While iOS reports the scene screen as captured, the
  native shield replaces financial content and remains visible even if Face ID
  succeeds; it clears automatically only after capture ends.
- Haptic tests use the system selection, impact, and notification generators.
  Product flows use the same bridge for tactile confirmation after a trade or
  an explicit preparation/audit completion is actually persisted; autosave is
  intentionally silent. Explicit failures emit an error pattern, while Strict
  Mode blocking trade capture emits a warning. Web builds remain silent, and
  haptic failure can never fail the underlying product action.
- Native dictation uses Apple Speech and the microphone for a user-started,
  maximum 30-second Czech trade note. The capability lab returns text without
  saving or uploading it. It can create a review-only draft note, but never
  saves a trade without the user's final tap on the existing form's Save button.

The TypeScript boundary is `services/nativeCapabilities.ts`. Keep sensitive
system behavior in the native plugin and product UI in shared React code.

## System share sheet

The existing trade share card remains the only PNG renderer. In the native
build its preview adds `Sdílet přes iOS`, writes the generated PNG to a unique
temporary directory, and presents `UIActivityViewController` with the image,
short trade label, and existing public share URL. Completion or cancellation
removes the temporary file. Web download, image clipboard, and link actions are
unchanged.

## Siri, Shortcuts, and Spotlight

`AlphaTradeSystemActions.swift` exposes three focused App Shortcuts: open LIVE,
capture a trade, and open Coach. Spotlight indexes those destinations plus the
journal and dashboard. Every invocation enters one persisted system-route queue
and is then handed to `window.__alphaTradeNative`; this also works when iOS
launches the app before React has registered the bridge. No account or trade
records are copied into Spotlight.

Long-pressing the AlphaTrade Home Screen icon also exposes LIVE, quick trade
capture, and Coach. These static quick actions enter the same persisted route
queue as Siri and Spotlight, including when the app is cold-launched; they do
not create a second navigation stack.

## Home Screen and Lock Screen widgets

The embedded `AlphaTradeWidgets` extension exposes nine Home Screen variants:
Today plan, Daily P&L, Equity Curve, Accounts, Discipline, Recent Trades, and
Quick Actions, plus Copier LIVE and Open Positions. The paid Team signs both
targets with `group.app.alphatrade.native`. Installed widgets decode the
token-free, user-scoped `AlphaTradeWidgetSnapshotV2`; preview-only sample data
is confined to the Widget Gallery. Quick Actions only opens AlphaTrade; it
never performs a trade from the widget.

Three additional accessory widgets are designed specifically for the Lock
Screen: Daily P&L, Discipline, and a LIVE launcher. Together they cover inline,
circular, and rectangular accessory families with compact layouts and adaptive
system backgrounds. Financial values remain privacy-sensitive. The app refreshes
the shared snapshot at least once per minute while LIVE is available; after two
minutes without a refresh, LIVE surfaces visibly switch to `DATA ZASTARALÁ`
instead of presenting old information as current. The LIVE widget only opens
the app.

## Live Activity

ActivityKit mirrors the same read-only copier snapshot. It starts for ARM, an
open position, day-lock or kill switch; updates status, position summary and
local P&L; and ends after the monitored condition clears. It appears on the
Lock Screen and, on supported iPhones, in the Dynamic Island. Tapping it opens
the read-only LIVE section.

The activity requests an ActivityKit APNs token, but remote updates containing
P&L or position state remain disabled until the user separately approves that
financial payload crossing Apple APNs and the isolated server registration path
is deployed. No ActivityKit surface contains a broker command or auth token.

## Apple Calendar event editor

The native capability lab can open Apple's `EKEventEditViewController` with a
90-minute LIVE session draft. On iOS 17 and later the system editor owns the
calendar selection and final Save/Cancel decision; AlphaTrade does not request
read access, enumerate calendars, or save anything before the user confirms
Add. The bridge only receives `saved` or `cancelled` after the editor closes.

The draft contains a title, start, duration, location, and planning note. It has
no trade, broker, auth-token, or account payload. This is an explicit user
action in the iOS lab and does not modify the web product or production data.

## Control Center, Lock Screen, and Action Button controls

On iOS 18 and later the widget extension publishes two `ControlWidget` buttons:
Open AlphaTrade LIVE and Capture Trade. Their App Intent source belongs to both
the app and widget-extension targets. Because each intent opens the app, iOS
executes the app-target copy in the main process and hands the destination to
the same persisted system-route queue already used by Siri, Spotlight, and Home
Screen quick actions.

Both controls are navigation-only. LIVE opens the existing read-only overview;
Capture opens the existing review form and never saves or submits a trade. They
read no shared financial snapshot and use no broker capability, auth token, or
background order path.

## Architecture guardrails

- `AlphaTradeShellViewController` owns one persistent system `UITabBar`. It is
  deliberately not a `UITabBarController`: iOS must never reorder or detach the
  single Capacitor child while rebuilding a tab-controller hierarchy.
- Its single WebView starts below the status bar so web controls never collide
  with the clock or battery, while the themed shell paints that top safe area.
  At the bottom the WebView continues behind the translucent tab bar so Liquid
  Glass samples real app content instead of a separate solid strip.
- The shell background, status-bar safe area, WebKit under-page color, and the
  surface beneath the translucent tab bar all follow the exact shared theme
  (`#f8fafc`, `#020617`, or OLED black). Never hard-code black outside the OLED
  path: Liquid Glass needs themed content underneath it to remain coherent.
- A single `AlphaTradeBridgeViewController` is embedded below the bar and is
  never moved between tabs.
- Capacitor owns that bridge controller and its one `WKWebView`; do not create a
  second web view for plugin content.
- Use native Swift only for system surfaces and capabilities. Main product
  screens remain shared React code.

### Shell regression smoke

Debug builds accept `--alphatrade-theme-appearance-smoke`. The opt-in smoke
cycles light, dark, and OLED without restarting the process and logs one
`themeSmoke=... passed=1` result per theme only after the status-area style,
five-item tab bar, visibility, and themed tab appearance agree. Ordinary Debug
launches do not cycle themes, and the smoke is compiled out of Release builds.
The smoke invokes `AlphaTradeNative.setShellTheme` from JavaScript, so it covers
the same Capacitor bridge path used by React instead of calling UIKit directly.
Theme and pull-to-refresh completion deliberately use this registered Capacitor
plugin. Do not replace them with an optional `window.webkit.messageHandlers`
call: a handler added while Capacitor builds its WebView configuration can be
silently absent, which makes live theme changes no-op while restart-time
`localStorage` synchronization misleadingly appears to work.
`ios:doctor` separately guards the transparent system material, themed window
background, stable custom tab bar, and web content extending underneath it.

The current requirement-by-requirement evidence and remaining manual or paid
program gates are tracked in `docs/IOS_NATIVE_TEST_MATRIX.md`. Update that
ledger when a physical smoke changes state; do not turn an implementation-only
row into a physical-verification claim based on simulator evidence.
