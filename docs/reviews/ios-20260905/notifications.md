# iOS notification review — current working tree, 2026-09-05

Scope: `/Users/filipkrejca/Documents/trading-journal-aka`, main Capacitor app. Read-only source review; no DB/API/APNs/broker calls, deployment, source edits or installed-device changes. The independent native lab is excluded.

Existing working-tree changes relevant here: `server/nativePushRegistration.ts` only changes `.js` import extension; `services/nativeCopierNotificationPlan.ts` adds reconciliation notification lines 164–177. The findings below are in surrounding pre-existing behavior, not introduced by those changes. `App.tsx` and `components/TradovateLiveDesk.tsx` are also dirty; reviewed current content without altering it.

## P2 — Failures are marked notified and never retried

Primary: [/Users/filipkrejca/Documents/trading-journal-aka/server/nativeCopierStatePush.ts:59-90](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeCopierStatePush.ts:59), especially 80–89. Also [/Users/filipkrejca/Documents/trading-journal-aka/api/cron/send-alerts.ts:829-840](/Users/filipkrejca/Documents/trading-journal-aka/api/cron/send-alerts.ts:829).

`sendApnsNotification` returns `{ status: 'failed' }` for transient errors/timeouts. The immediate sender counts successful sends, but unconditionally advances `state:copy-events` and writes `notified_at`, even when every send failed. The next immediate call and cron both skip the event. The cron likewise commits all incident/financial/copy markers regardless of send outcome. Thus a temporary APNs/server outage can permanently lose a safety/trade alert, including the watchdog's WORKER OFFLINE alert. A device-specific delivery state with retryable/unknown status is needed; marking one user's whole event after only one device succeeded also loses delivery to other failed devices.

Dynamic reproduction PASS: fake APNs returns `failed/apns-timeout`; first run `{notifications:1,sent:0}`, durable marker advances, second run `{notifications:0,sent:0}`, only one APNs attempt. This is a unit-level proof of current sender logic, not a physical delivery test.

## P2 — Local and APNs notification producers still duplicate notifications

Primary copier range: [/Users/filipkrejca/Documents/trading-journal-aka/services/nativeCopierNotificationPlan.ts:267-274](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeCopierNotificationPlan.ts:267); callers [/Users/filipkrejca/Documents/trading-journal-aka/services/nativeCopierNotifications.ts:119-127](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeCopierNotifications.ts:119) and [/Users/filipkrejca/Documents/trading-journal-aka/components/TradovateLiveDesk.tsx:171-176](/Users/filipkrejca/Documents/trading-journal-aka/components/TradovateLiveDesk.tsx:171).

Only ENTRY/EXIT are excluded locally. SL/TP moves, brackets, scale events and other events still fire locally while server `planCopyEventNotifications` sends the same event via APNs. Local incident transitions also independently duplicate cron incident transitions. There is no shared notification ID/ack between local and remote channels. Opening LIVE while the event occurs is enough; hiding the app after scheduling local alert preserves the duplicate.

Dynamic reproduction PASS: one `sl-moved` event creates one local `fireNow` plus one server notification with identical title/body.

Session variant: `/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:990-995` always calls `syncNativeSessionReminders`, whose planner creates session/audit notifications at [/Users/filipkrejca/Documents/trading-journal-aka/services/nativeSessionReminders.ts:100-162](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeSessionReminders.ts:100). Cron `/Users/filipkrejca/Documents/trading-journal-aka/api/cron/send-alerts.ts:333-378,467-473` also sends those same settings' alerts to every APNs device. Local reminders are not conditioned on APNs status and there is no remote flag excluding their types. Therefore enabled session-start/end/audit alerts have two delivery owners on a native phone. Local audit additionally remains scheduled after the review is already completed because the planner never receives review completion; the server does honor `hasReview`.

## P2 — Existing ARM/cooldown/day-lock timers are canceled just before delivery

Primary: [/Users/filipkrejca/Documents/trading-journal-aka/services/nativeCopierNotificationPlan.ts:99-112](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeCopierNotificationPlan.ts:99) and 128–135.

`MIN_LEAD_MS=15000` is applied when computing desired times for both new and existing slots. At the first normal status poll within 15 seconds of an existing slot, its target disappears from `desired`; the reconciliation loop schedules cancellation. With LIVE open/polling, the supposedly reliable scheduled local fallback never fires. It affects ARM expiration, cooldown end and day-lock end. Lead-time filtering should prevent creation of late new slots while preserving existing unexpired slots.

Dynamic reproduction PASS: slot 42 scheduled at T; same unchanged status at T−14 seconds produces `{cancel:[42],schedule:[],fireNow:[]}`.

## P2 — Test cleanup cancels real copier safety notifications

Primary: [/Users/filipkrejca/Documents/trading-journal-aka/services/nativeNotifications.ts:170-183](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeNotifications.ts:170) and 211–225.

`scheduleNativeNotification` stamps every caller's alert `source:'test'`, including real copier risk timers. `cancelPendingNativeTestNotifications` removes all notifications whose source is not `sessionReminder`. Settings exposes this as “Zrušit čekající testy” at [/Users/filipkrejca/Documents/trading-journal-aka/components/Settings.tsx:1486-1492](/Users/filipkrejca/Documents/trading-journal-aka/components/Settings.tsx:1486). A user cleaning up test notifications also deletes ARM/cooldown/day-lock timers and queued incidents. The copier's separate localStorage slots remain, so the next normal sync treats removed timers as present and does not reschedule them. Explicit production/test source and pending-ID reconciliation are needed.

Dynamic reproduction PASS: scheduling a real `actionType:'risk'`, route LIVE alert marks it `test`; invoking test cleanup cancels it, remaining count 0.

## P2 — Concurrent server senders have no atomic claim

Primary: `/Users/filipkrejca/Documents/trading-journal-aka/server/nativeCopierStatePush.ts:23-41,59-90`. Cron reads the same state at [/Users/filipkrejca/Documents/trading-journal-aka/api/cron/send-alerts.ts:631-637](/Users/filipkrejca/Documents/trading-journal-aka/api/cron/send-alerts.ts:631) and writes much later at 829–840. Snapshot writer [/Users/filipkrejca/Documents/trading-journal-aka/server/snapshotImagePush.ts:118-136](/Users/filipkrejca/Documents/trading-journal-aka/server/snapshotImagePush.ts:118) is also read-before-unconditional-upsert, despite its monotonicity comment.

Immediate relay requests, the minute cron, and snapshot pushes can overlap. Both evaluate the same old cursor and send the event before either writes the cursor; a slow older writer may then overwrite a newer boundary with an older one, replaying later events on subsequent runs. A unique upsert of a state row after sending is not an atomic delivery claim or monotonic compare-and-set. Non-image events can have no collapse ID, so duplicate requests are independent notifications.

Dynamic reproduction PASS: two parallel calls blocked inside fake APNs both sent the same SL event; each returned `{notifications:1,sent:1}`, APNs call count 2.

## P2 — APNs registration cannot recover from denied permission or first network failure

Primary: `/Users/filipkrejca/Documents/trading-journal-aka/services/nativePushNotifications.ts:46-56,61-82,94-102`. App invocation `/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:875-905`; Settings enable path [/Users/filipkrejca/Documents/trading-journal-aka/components/Settings.tsx:546-559](/Users/filipkrejca/Documents/trading-journal-aka/components/Settings.tsx:546).

The initialization promise is cached indefinitely for the same user, including resolved `false` after permission denial, registration HTTP failure or timeout. Reinvoking initialize returns false without rechecking permissions or registering. Native App has no foreground retry and Settings' “enable notifications” branch only requests LocalNotifications permission and schedules reminders, so it can announce enabled while no APNs token is registered. Reopening the entire WebView/process or logging out/in is currently required to clear the cache.

Dynamic reproduction PASS: initial permission denied; then change fake permission to granted and call initialize again → false, one permission check total and zero `register()` calls. The same cache applies to false HTTP outcomes by the inspected code.

## P2 — APNs custom action buttons ignore the action and typed note

Primary: [/Users/filipkrejca/Documents/trading-journal-aka/services/nativePushNotifications.ts:89-92](/Users/filipkrejca/Documents/trading-journal-aka/services/nativePushNotifications.ts:89). Registered action definitions are [/Users/filipkrejca/Documents/trading-journal-aka/services/nativeNotifications.ts:253-290](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeNotifications.ts:253); local action dispatch correctly handles them at 295–317.

Server APNs uses the same ALPHATRADE_TRADE/RISK categories as local alerts. Long-press “Otevřít Deník”, “Zapsat obchod”, “Přidat poznámku” or “Otevřít Coach” on a remote copier alert, however, is handled only by `notification.data.route`, normally LIVE. `actionId` and `inputValue` are ignored; requested view/capture is not opened and typed note is discarded. Reuse the action dispatcher for remote notifications and retain input.

Dynamic reproduction PASS: invoke remote callback with `actionId:'OPEN_JOURNAL'` and payload `route:'live'` → actual route LIVE.

## P2 — The same sessionEndAlert10m setting means before-end on server and after-end on iOS

Primary: [/Users/filipkrejca/Documents/trading-journal-aka/services/nativeSessionReminders.ts:145-149](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeSessionReminders.ts:145) vs [/Users/filipkrejca/Documents/trading-journal-aka/api/cron/send-alerts.ts:348-349](/Users/filipkrejca/Documents/trading-journal-aka/api/cron/send-alerts.ts:348).

With sessionEndAlert10m enabled, local planner schedules an audit at `endTime + 10min`; server schedules “končí za 10 minut” at `endTime − 10min`. E.g. session ending 22:00 causes alerts at 21:50 and 22:10 from a single preference. This should have a single defined meaning or separate before-close and after-session-audit toggles. App's foreground web logic also treats it as after-end (App.tsx:948), so fixing only native would retain cross-channel inconsistency.

## Verification and limitations

- Existing tests: **6 files, 74 tests passed**: `nativeCopierNotificationPlan`, `nativeNotifications`, `nativeSessionReminders`, `nativePushRegistration`, `copierIncidentWatchdog`, `snapshotImagePush`. Config/cache was placed under `/private/tmp`, source untouched.
- Reproduction: `node /Users/filipkrejca/Documents/trading-journal-aka/docs/reviews/ios-20260905/evidence/ios-notification-repro.cjs` compiled actual current source with esbuild plus in-memory dependency mocks; exit 0, eight scenarios reproduced. It additionally demonstrates an at-only cursor ignores a second distinct event with identical millisecond time. That latter case was not promoted to a formal finding because current worker timing/reachability wasn't independently proved.
- Artifacts: `/Users/filipkrejca/Documents/trading-journal-aka/docs/reviews/ios-20260905/evidence/ios-notification-repro.cjs`, `/private/tmp/ios-notification-vitest.config.mjs`.
- Reviewed notification extension source: HTTPS-only, bounded 5 MB, 8-second deadline, MIME guard, exactly-once completion/text fallback are implemented. This is not physical proof of image rendering/delivery.
- No actual APNs registration, Focus/locked-phone/force-quit behavior, background cadence, permission UI, badge behavior, or signed installed bundle was verified by this subtask. Existing passing unit tests are not evidence those device flows work end-to-end.
