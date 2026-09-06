# iOS review — widgets, Live Activities, system actions, Notification Service

Review date: 2026-09-05. Source: `/Users/filipkrejca/Documents/trading-journal-aka`. Read-only review, no source changes, no production queries, no push sends or broker actions. Only artifacts in `/private/tmp`. Read `AGENTS.md`, relevant sections of `docs/PROJECT_LOG.md`, `ios-app-intents` and `supabase` skills. Existing tests: **4 files / 27 tests passed**. Additional mock-only reproduction harness: `/Users/filipkrejca/Documents/trading-journal-aka/docs/reviews/ios-20260905/evidence/ios-review-widget-repro.ts`, passed. No claim of physical iPhone delivery or screenshots.

## Strongest findings

### W1 [P1] Kruhový LIVE widget tvrdí ARM po ztrátě čerstvého heartbeat

- Main location: [capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:712-717](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:712); producer: [server/nativeWidgetRemoteSnapshot.ts:116-123](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeWidgetRemoteSnapshot.ts:116), `30-43`.
- `runtimeStatus` correctly returns `WORKER OFFLINE` when `last_seen_at` is older than 90 seconds, but output still carries the old `connected: true` and `armed: true`. `updatedAt` is set to the time of the new HTTP response. Consequently `isLiveStale` is false and `compactLabel` returns `ARM` instead of reflecting `WORKER OFFLINE`. Copier Home color also derives from booleans at 503-508 and can show green next to an offline status.
- Reproduction: last worker heartbeat says armed+connected, simulate a missing heartbeat in an isolated fixture, let remote widget refresh after >90 seconds while broker reads still succeed. The circular widget keeps saying ARM. The mock harness verifies the contradictory DTO with a five-minute-old heartbeat and fresh fetch timestamp. UI outcome follows directly from `compactLabel`.
- Fix direction: one derived state shared between all widget presentations, with independent heartbeat freshness / status; never treat HTTP refresh as proof of worker health. Also recognize SHADOW, DIVERGENCE and STUCK OUTBOX in compact presentation instead of classifying only raw booleans.

### W2 [P2] Po odhlášení a přihlášení se neobnoví WidgetKit push registrace

- Main location: [capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:225-226](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:225).
- Related: [services/nativeWidgetRemote.ts:44-49](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeWidgetRemote.ts:44); [capacitor-ios/App/App/AlphaTradeNativePlugin.swift:134-148](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/App/AlphaTradeNativePlugin.swift:134); [api/native-widget-registration.ts:39-57](/Users/filipkrejca/Documents/trading-journal-aka/api/native-widget-registration.ts:39); [api/native-widget-push-subscription.ts:31-49](/Users/filipkrejca/Documents/trading-journal-aka/api/native-widget-push-subscription.ts:31).
- Native code caches `environment:deviceToken:widgetKinds` as `AlphaTradeWidgetPushRegisteredSignatureV1`. Logout revokes/removes the read token, but does not remove that signature. Next login creates a different read token and therefore a different `native_widget_devices` row. Because the WidgetKit APNs token and configured kinds remain unchanged, `registerIfNeeded` returns early. New row never gets APNs push fields and old row is revoked.
- Reproduction: successful widget registration → logout → login same user → trigger a state change. Ordinary/manual snapshot fetch remains functional, but automatic push refresh is no longer registered until the APNs token or widget configuration changes.
- Fix direction: include read-token identity in registration signature or clear the signature whenever the access token changes; register only after read-token registration is accepted. Test the full login/logout/login lifecycle.

### W3 [P2] Chyba načtení broker účtu se ve widgetu promění na odemčený účet a $0

- Main location: [server/nativeWidgetRemoteSnapshot.ts:61-72](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeWidgetRemoteSnapshot.ts:61), `131-139`.
- Underlying safety metadata: [server/nativeLiveActivityBrokerSnapshot.ts:153-168](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeLiveActivityBrokerSnapshot.ts:153), `253-280`, `397-399`.
- Broker loader intentionally exports `accountStatusComplete`, `accountLockStatusComplete`, `balanceAvailable`, `openPnlAvailable`, `completeOpenPnl`. The widget DTO discards all those flags and always publishes concrete balances, P&L and `locked: false` when optional broker endpoints fail. Swift account/P&L views then display those numbers as current data because response `updatedAt` is fresh. Failed open-P&L fetch likewise becomes a convincing zero or partial total.
- Mock reproduction passed: `/account/list` and `/userAccountAutoLiq/list` return 503; `/cashBalance/list` returns empty array for configured account. Broker snapshot correctly marks incomplete status and missing balance. Widget output is an unlocked account with balance 0 and no availability flag. The harness uses only mocked fetches to `review.invalid`; no network.
- Fix direction: preserve per-field availability and source times; render unknown as `—`/unverified, preserve last known lock with a stale marker rather than inventing unlock.

### W4 [P2] Lokální aktualizace přepisují bohatou Live Activity na starý layout a mění význam P&L

- Main locations: [services/nativeWidgetSnapshot.ts:313-340](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeWidgetSnapshot.ts:313); [capacitor-ios/App/App/AlphaTradeNativePlugin.swift:294-303](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/App/AlphaTradeNativePlugin.swift:294).
- Call site: [components/TradovateLiveDesk.tsx:254-265](/Users/filipkrejca/Documents/trading-journal-aka/components/TradovateLiveDesk.tsx:254); server state: [server/nativeLiveActivityUpdater.ts:151-155](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeLiveActivityUpdater.ts:151), `242-277`.
- Server sends `mode`, position/order symbol, side, quantity, SL/TP, follower health, countdown and stop-risk. Foreground LIVE snapshot emits only the legacy payload, and Swift constructs a new ContentState with all optional detail fields nil. `activity.update` replaces content; it does not merge those fields. Thus a subsequent local snapshot switches the card into `legacyContent` until the next server update. Local P&L is total realized+open; server position P&L is open-only. For realized +$250 and open +$100, the same activity can alternate between +$350 and +$100 depending on which writer ran last.
- Local stale deadline is 15 minutes (`AlphaTradeNativePlugin.swift:218,249-252`) versus server 180 seconds (`nativeLiveActivityUpdater.ts:277`), so the same foreground writer also lengthens the safety freshness window.
- Reproduction: remote position-mode activity → receive a new or changed foreground LIVE snapshot → inspect activity. SL/TP, countdown and followers disappear; P&L meaning changes. All three branches are statically confirmed; physical UI transition not exercised.
- Fix direction: shared DTO/presenter and identical P&L semantics + freshness rules for local/remote producers, or appoint a single owner of authoritative activity content.

### W5 [P2] Dynamic Island nemá žádné označení zastaralých Live Activity dat

- Main location: [capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:799-835](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:799).
- Lock Screen reads `context.isStale` at 892, 920, 1002. Dynamic Island expanded/compact/minimal always renders original position, P&L and positive/negative color and never reads that property. After update transport/worker outage, Lock Screen can say ARM NEOVĚŘEN while Dynamic Island still shows healthy green P&L/trend. Expanded SL/TP remains visually current too.
- Reproduction: supply `ActivityViewContext` with `isStale=true`, or cut updates beyond the server's staleDate. Dynamic Island code is unchanged in either state.
- Apple documents that consumers should respond to `isStale` when staleDate passes: https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities ; https://developer.apple.com/documentation/widgetkit/activityviewcontext/isstale .
- Fix direction: apply a shared stale presentation to Lock Screen and every Island presentation, mark numbers as last known and suppress healthy/live styling.

### W6 [P2] Pozdní widget HTTP odpověď může po odhlášení obnovit data předchozího uživatele

- Main location: [capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:173-187](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:173).
- Related logout: [App.tsx:3715-3724](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:3715), [services/nativeWidgetSnapshot.ts:375-379](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeWidgetSnapshot.ts:375).
- `getTimeline` captures old cached snapshot and access token, sends request, then unconditionally writes merged data into App Group. It neither cancels in-flight requests on logout nor checks that the token/session generation is still the same in its completion. A request authorized before revoke can complete after access-token and snapshot removal, repopulating balances/trades for a signed-out device (or after a different user signs in). Failure callback also returns captured old snapshot directly.
- Reproduction sequence: start a delayed widget snapshot request → logout clears native cache/token → allow already-authorized HTTP request to complete. Callback writes old-user data. This is a deterministic lifecycle race identified from the code; no production user data was used.
- Fix direction: compare current token/session generation before merging, persisting or delivering a timeline. On mismatch use current empty/new-user data. Avoid merging data captured under a different identity.

### W7 [P2] SL posunutý do zisku z Live Activity zmizí

- Main location: [server/nativeLiveActivityBrokerSnapshot.ts:333-338](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeLiveActivityBrokerSnapshot.ts:333).
- Stop candidate is accepted only on the loss side of the average entry (`long stop <= entry`, `short stop >= entry`). A legitimate profitable trailing stop is rejected even though it remains a working protective broker order. The activity loses SL, progress and risk information after the trader improves protection.
- Mock harness passed: long 1 MNQ entry 20000, market-implied price 20050, working sell stop 20010. `stopPrice` becomes null. Symmetric failure for shorts.
- Fix direction: determine protective side from position direction and order action; validate against current market where appropriate, not the entry-price loss side. Explicitly represent locked-in profit instead of absolute negative risk.

## Additional concrete concerns / improvements

- **Local pending-order lifecycle differs from server:** [services/nativeWidgetSnapshot.ts:331-342](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeWidgetSnapshot.ts:331) has no `workingOrderCount > 0` in shouldBeActive and ends a flat DISARMED activity even with pending entry orders. Server correctly keeps it (`nativeLiveActivityUpdater.ts:231-234`, existing regression at `tests/nativeLiveActivityUpdater.test.ts:371-387`). Useful regression for shared producer logic; activity disappearance on returning to app can follow.
- **30-minute stale marker lacks its own timeline entry:** `AlphaTradeWidgets.swift:87-89,191-194` emits only one current entry and requests another timeline after 5 minutes. The computed `Date()` comparison does not itself schedule a view refresh. With iOS-delayed reloads, the rendered state can remain apparently current past the 30-minute cutoff. Provide future stale/ARM-expiry entries and visibly show data timestamp; Apple explicitly says extension is not continuously active and `after` is the earliest reload time, not a deadline: https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date and https://developer.apple.com/documentation/widgetkit/timeline . Even entry times are best-effort, so avoid claiming guaranteed instant state from widgets.
- **iOS compatibility mismatch remains:** widget/Live Activity extension deployment target is 26.0 in both configs (`App.xcodeproj/project.pbxproj:572,599`), while app declares 15.0 and plugin reports Live Activity supported from 16.2. Existing older project-log finding remains unresolved. Separate iOS-26 push support behind availability guards if iOS 16–18 support is intended, or align user-facing requirements.
- **Multi-device activity start suppression:** `server/nativeLiveActivityStarter.ts:93-100,120-126` uses any active activity for user to suppress starts for all of that user's installations. With an existing activity on iPhone A, iPhone B never starts and its trigger is marked consumed. Subscription schema would need installation linkage to scope suppression correctly.
- **Journal/live clocks and scopes mix:** remote widget fetch preserves journal indefinitely (`AlphaTradeWidgets.swift:135-140`) while bumping shared timestamp. P&L chooses live totals but R and trade count choose local journal (`75-79`); after app has been closed across trading days, newly refreshed live $ can be paired with yesterday's R/trades/discipline. Separate source timestamps/day identifiers, and refresh or explicitly label journal metrics.
- **Medium account widget layout:** DTO allows six accounts; `AccountsView` iterates all at `412`, and widget supports only `.systemMedium` at 599. Each row has two text lines plus dividers, so six accounts exceed typical medium height. Limit rows with a +N indicator or supply a large family; verify Dynamic Type and longest real names.

## Paths that looked sound in code

- NotificationService: HTTPS-only original and redirected URLs; JPEG/PNG allowlist; actual accumulated body capped at 5 MiB; 8-second fallback; one-shot content completion guarded by lock; OS expiry fallback. No concrete blocker found in this source. Actual image APNs delivery still requires a signed device test.
- System intents and controls are thin navigation handoffs, allowlisted by the main route queue, and do not contain broker writes. Their cold-start route is persisted until acknowledgement. Physical Siri/Control Center routing still needs device verification.
- Existing remote updater uses 180-second staleDate and ~110-second heartbeat renewal, avoids ending on failed broker fetch, and models divergence. Existing suite verifies these branches, but not Swift presentation or local/remote consistency above.

## Verification detail

Successful commands, from canonical repo:

```
node --import ./node_modules/tsx/dist/loader.mjs /Users/filipkrejca/Documents/trading-journal-aka/docs/reviews/ios-20260905/evidence/ios-review-widget-repro.ts
node node_modules/vitest/vitest.mjs run tests/nativeWidgetRemoteSnapshot.test.ts tests/nativeWidgetRegistration.test.ts tests/nativeLiveActivityUpdater.test.ts tests/nativeWidgetPushUpdater.test.ts --no-cache --configLoader native
```

First Vitest attempt without `--configLoader native` failed only because its config bundler tried to write `.vite-temp` outside writable roots. Native config loader avoided the write; all 27 tests passed. No escalation required.
