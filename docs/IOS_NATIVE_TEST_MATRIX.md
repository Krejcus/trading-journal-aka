# AlphaTrade iOS — test matrix

This is the completion ledger for the native-capability trial. A green build is
not enough: each row names the strongest evidence currently available and the
remaining external gate. The shared React product remains the source of truth;
no separate copy of dashboard, journal, LIVE, or charts is maintained in Swift.

| Surface | Current state | Evidence | Remaining gate |
|---|---|---|---|
| Local app bundle | Implemented | `ios:sync`; native HTML has no CDN, Google Fonts, PWA manifest, or service worker; clean simulator launch | Cloud-backed data still needs internet unless a last-known snapshot exists |
| Native API origin/CORS | Implemented | `runtimeConfig`, API CORS tests | Production deployment of server changes remains an explicit approval step |
| Google OAuth + session | Implemented | custom URL callback tests, Keychain migration tests, signed physical build launches | Repeat email and Google login on the current synced build; redirect must remain allowed in Supabase |
| Status area + Liquid Glass tab bar | Physically verified | iPhone 13 Pro Max end-to-end JS → Capacitor plugin → UIKit light/dark/OLED smoke; five visible tabs at 428 × 83 pt; normal relaunch restored persisted light theme; user confirmed the menu and live theme change visually | None for the current device/build |
| LIVE/BACKTEST world switch | Physically verified | Native More menu invokes the same React world switch as web; React reports current world back to UIKit; the target iPhone switched both directions with the scoped menus, and the full-screen green/purple transition was confirmed behind the status area; bridge tests and iOS doctor guard the contract | None for the current device/build |
| Local rich notifications | Physically verified | image attachment delivered on iPhone; categories/actions and pending calendar reminders read back from iOS | These are device-local; remote server push is a paid-program/production service |
| Notification actions and trade note | Physically verified | On the target iPhone, the text-input notification action accepted a note, foregrounded AlphaTrade, and opened the review-only trade form with `Poznámka z iOS notifikace` prefilled; no trade was saved automatically. Cold-route replay is also covered by unit tests | None for the current device/build |
| Session/evening reminders | Physically verified | iOS reported recurring calendar requests; planner/limit tests | iOS owns exact delivery timing and caps pending requests at 64 |
| Badge management | Physically verified | The current signed build set a badge through `UNUserNotificationCenter`, reported the same count through the Capacitor bridge, and displayed the number on the target iPhone Home Screen; range and bridge regressions are covered by targeted tests | None for the current device/build |
| Face ID/privacy shield | Physically verified for cold start | Current signed build on iPhone 13 Pro Max enabled Privacy Mode, completed owner authentication, persisted the setting, automatically presented Face ID after a Mac-triggered cold restart, kept financial content shielded, and restored the app after successful authentication | Optional hardening smokes before release: cancelled Face ID retry, screen recording, and repeated background/foreground cycles |
| Haptics | Physically verified | product-path tests and physical smoke patterns | Subjective strength follows the device/system setting |
| Czech dictation | Physically verified | The current signed build requested the real Speech/microphone permissions, recognized Czech speech on the target iPhone, displayed the transcript, and kept the result in the review-only trade-draft path | None for the current device/build; recognition quality still varies with noise and Apple Speech availability |
| Keep screen awake | Physically verified | The target iPhone reported the effective idle-timer override in active LIVE mode and changed to enabled-but-ineffective after switching to Backtest; the policy also disables itself on backgrounding | None for the current device/build; actual dimming time still follows the device Auto-Lock setting when ineffective |
| iOS share sheet | Physically verified | The current signed build opened the real `UIActivityViewController` on the target iPhone, dismissed cleanly back into the responsive app, and resolved cancellation without an optional-value bridge error; simulator and targeted tests cover the same cancel path and empty input | None for the current device/build |
| Siri/Shortcuts/Spotlight/quick actions | Implemented | App Intents metadata builds; cold route queue; physical deep-link/quick-action checks | Siri phrasing remains system-dependent |
| Ten Home/Lock Screen widgets | Physically verified with test data | Seven Home Screen variants plus dedicated Lock Screen P&L, Discipline, and LIVE widgets cover inline, circular, and rectangular families. The user physically confirmed all ten widgets on the target iPhone, including Recent Trades and all four Quick Actions routes (Capture, Coach, LIVE, and Journal); no route saved or submitted a trade. The Lock Screen Discipline pass also confirmed the required `containerBackground` fix in the signed build | Real values require paid Apple Developer App Group provisioning and a token-free snapshot writer from the signed-in app; test values remain deliberately labelled until that gate is met |
| Live Activity / Dynamic Island | Physically verified on Lock Screen | The target iPhone displayed the clearly labelled local TEST Live Activity and the user confirmed both its presentation and state update; ActivityKit schema is shared by app and widget extension | Dynamic Island visual still needs a supported iPhone; the current iPhone 13 Pro Max has no Dynamic Island |
| Apple Calendar editor | Physically verified | The signed arm64 app contains `EKEventEditViewController`, the `presentCalendarEvent` bridge, and `NSCalendarsWriteOnlyAccessUsageDescription`; native lab presents an explicit LIVE-session draft, exposes no calendar read/list API, and keeps Save/Cancel in system UI. The user physically confirmed both Cancel-without-save and Save followed by the event appearing in Apple Calendar | None for the current device/build |
| Control Center / Lock Screen controls | Physically verified | The signed widget extension contains `AlphaTradeLiveControl`, `AlphaTradeCaptureControl`, and both shared control intents; the main app's extracted App Intents metadata contains both intents with `openAppWhenRun`. The user physically confirmed LIVE opens the existing LIVE section and Capture opens the review-only trade form without automatically saving or submitting anything. Both routes remain navigation-only and reuse the cold-safe route queue | None for the current device/build |
| Offline | Honest last-known mode | IndexedDB snapshot path and no duplicate native service worker | Not a full offline trading journal; writes/cloud actions remain unavailable offline |
| App Store-free installation | Working for trial | signed Personal Team build installs directly on the connected iPhone | Free provisioning expires and is not a distribution channel |

## Release gates that are intentionally not bypassed

- Do not enable an App Group or claim live widget data on the free Personal Team.
- Do not call local notifications “remote push”. A production push provider,
  APNs entitlement, backend delivery, and paid developer membership are separate.
- Do not deploy Vercel/Supabase changes or change production secrets as part of
  an iPhone smoke test without explicit approval.
- Dictation, notification notes, and widget quick actions only prepare or
  navigate. They never create a trade without the user's explicit Save action.
