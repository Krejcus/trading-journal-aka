# AlphaTrade pro iOS — testovací build

## AlphaTrade iOS

Projekt nyní používá mobilní informační architekturu původní AlphaTrade (`Dashboard · Historie · Zapsat · Deník · AI · Více`) a zachovává Native Capability Lab uvnitř aplikace.

Skutečná data se připojují bezpečně přes existující `get_dashboard_data` RPC. Do buildu nastav pouze veřejnou klientskou konfiguraci:

- `ALPHATRADE_SUPABASE_URL`
- `ALPHATRADE_SUPABASE_PUBLIC_KEY` (publishable nebo legacy anon key; nikdy service role)

Po přihlášení je access/refresh session uložena do iOS Keychainu. Mobilní adapter pouze čte dashboard RPC; neobsahuje databázové write endpointy. Bez konfigurace nebo přihlášení aplikace dál funguje nad izolovanými lokálními daty.

Aktuální rozsah ověření je zaznamenaný v `VALIDATION.md`.

Postup přímé instalace bez App Storu a kompletní fyzický checklist jsou v `IPHONE_TEST_PLAN.md`.

Projekt obsahuje samostatné unit testy (`AlphaTradeNativeLabTests`) a UI testy (`AlphaTradeNativeLabUITests`). Pro stabilní společný UI běh použij v Xcode vypnuté paralelní testování.

Native SwiftUI test build for iOS 26. It can run from isolated local data or read the signed-in user's AlphaTrade dashboard through the existing RLS-protected RPC. Journal data created locally is encrypted with AES-GCM; its 256-bit key lives in Keychain as `WhenUnlockedThisDeviceOnly`.

## Safety boundary

- Separate Xcode project and bundle ID: `app.alphatrade.nativelab`
- No imports from, writes to, or build coupling with the main AlphaTrade web repository
- Only a public Supabase client URL/key may be injected at build time; no service-role secret, broker endpoint, OAuth credential, or Databento key
- Remote dashboard access is read-only and authenticated; the adapter has no trade/account write operation
- LIVE is read-only; without login it shows clearly marked local sample data, after login it derives account summaries from the read-only dashboard snapshot; replay actions are local state only
- No App Store or TestFlight publishing configuration

## Run

Open `AlphaTradeNativeLab.xcodeproj`, choose the `AlphaTradeNativeLab` scheme and an iOS 26 simulator, then Run.

Aktuální testovací verze obsahuje funkční Dashboard, Historii, rychlý zápis, Deník, AI, Replay, read-only LIVE a nativní Lab. Má lokální šifrovaný zápis, Face ID/passcode privacy shielding, App Shortcuts a rozbalitelné řádky obchodů a účtů.

The project also includes an isolated WidgetKit extension with seven selectable widgets (Today Plan, Daily P&L, Equity Curve, Accounts, Discipline, Recent Trades and Quick Actions) plus a local demo Live Activity. A paid Apple Developer profile can enable the dedicated `group.app.alphatrade.nativelab` App Group for snapshot sharing. The current free Personal Team build cannot carry that entitlement, so widgets intentionally fall back to clearly marked test data. Money can be shown, reduced to R/percent, or hidden completely.

Coach supports Czech speech-to-text and an optional on-device Apple Foundation Models summary. The local model is explicitly restricted to journal reflection and must not produce trading signals or execution instructions.

Coach conversation history and bookmarked conclusions use a separate encrypted local vault. The bookmark is functional and survives an app restart; UI tests use an isolated in-memory store so they never pollute normal app data.

Local journal entries are indexed into on-device Spotlight, saves produce native haptic confirmation, and moving the app into the background automatically engages Privacy Mode before it can be reopened. Temporary system overlays such as a permission prompt do not cause an unnecessary lock.

Spotlight results preserve the exact trade identifier: opening a result selects Journal, scrolls to that trade, expands its note, and highlights the row. If Privacy Mode is active, the exact destination waits until biometric unlock. Siri and Shortcuts use the iOS 26 `supportedModes` API and the same central handoff path as notifications, including when the app is already running.

The Native Capability Lab contains a twelve-scenario Notification Gallery. It covers basic delivery, an expandable trade screenshot, target and stop events, daily P&L, time-sensitive risk warning, cooldown/snooze, preparation, review, discipline, mock connection loss and an image-based weekly equity report. The full gallery can be staggered across roughly 2.5 minutes or each scenario scheduled separately. Pending requests show destination, delivery time and attachment state and support individual or bulk cancellation.

Three notification categories expose preparation, capture, Journal, Coach, a two-minute snooze and a text-input action. Text entered from the notification is handed into Quick Capture. Privacy Mode defers every sensitive destination until unlock, dismiss does not accidentally navigate, and badge/delivered-test cleanup is explicit.

The same screen is an executable native test console rather than a feature checklist: it can start or end the Live Activity, open the camera/Photos OCR capture, engage the biometric privacy shield, run Czech speech recognition, enter Coach, and compare selection/success/warning/error haptics. Features that need physical hardware are clearly labelled for iPhone verification.

The Live Activity uses a system timer and restores its running state after the app process is relaunched.
