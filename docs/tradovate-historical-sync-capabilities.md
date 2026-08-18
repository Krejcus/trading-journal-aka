# Tradovate historical sync capability matrix

Verified on 2026-08-15 against the connected Tradeify Growth 50K demo accounts.
All probes were read-only; the copier remained DISARMED.

## Live evidence

- The standard REST snapshot exposed current accounts, balances, positions, orders and only the recent bounded entity history. It omitted the 2026-08-13 trading session.
- The same OAuth access token received HTTP 200 from `rpt-demo.tradovateapi.com/v1/reports/requestReportDefinitions`.
- Eight report definitions were returned: Performance, Orders, Position History, Cash History, Order Details, Chat History, Fills and Account Balance History.
- A Performance CSV request for account `TDFYG50549979811` covering 2026-08-01 through 2026-08-15 returned 47 rows, including MNQU6 trades from 2026-08-13 that occurred before AlphaTrade was connected.
- Therefore an account connected after a week of trading can be backfilled. Continuous connection is not required for the historical Performance report.
- The official Account entity includes `timestamp`. AlphaTrade treats this broker value as the exact account creation timestamp; Account Balance History remains a reconciliation source rather than the primary creation-date guess.

## Capability matrix

| Need | Source | Verified | Notes |
| --- | --- | --- | --- |
| Current balance, net liq, positions, working orders | Standard REST preflight | Yes | Snapshot/current-state source. |
| Historical paired trades, prices, timestamps, quantity, gross P&L | Performance report | Yes | Returned pre-connection trades. |
| Historical fills | Fills report | Definition verified, row format not yet validated | Must preserve `fill.id` and `fill.orderId` for execution-level reconstruction. |
| Historical orders and lifecycle | Orders + Order Details | Definitions verified, row format not yet validated | Exact historical SL/TP needs the closing order plus type and parent/OCO/link relation. |
| Cash changes, commissions and fees | Cash History | Definition verified | Keep separate from gross trade P&L. |
| Exact account creation timestamp | Account `timestamp` | Documented and implemented | Used as the historical import start when present. |
| Daily EOD balance and creation-date cross-check | Account Balance History | Definition verified | A zero-P&L first row can independently confirm the creation date. |
| Real-time events after connection | `user/syncRequest` WebSocket | Planned | Persist forward with durable cursors and deduplication. |
| Fallback when Reporting API is unavailable | Tradovate CSV import | Available | Manual but deterministic recovery path. |

## Recommended architecture

1. On first connection, list accounts and persist their stable Tradovate IDs and names.
2. Backfill each account with Performance, Fills, Orders, Cash History and Account Balance History in bounded date windows.
3. Store raw source rows plus normalized trades. Deduplicate by report type, account, stable source IDs and timestamps.
4. Start the user WebSocket for live events and persist every fill/order/account update forward.
5. Periodically reconcile recent report windows against stored live events; reports are the repair source, not the low-latency copier source.
6. Keep CSV import as an explicit fallback for tokens or account types where the reporting endpoint is denied.

## Implemented locally on 2026-08-15

- Performance backfill starts at the exact Tradovate Account `timestamp`. If the broker omits or invalidates it, the bounded fallback is the previous 12 calendar months; the scanner never starts blindly in 2010.
- A broad requested range is automatically split only when Tradovate times out or returns more rows than the bounded response can safely consume.
- Sync progress is durable: pending ranges, an expiring in-flight lease and a revision guard allow a later request to recover after a serverless timeout or restart.
- Normalized trades are unique by AlphaTrade user, environment, stable Tradovate account ID and deterministic source key. Reconnects and overlapping reports therefore upsert instead of duplicating trades.
- Historical Performance rows are merged with recent REST fill pairs and daily summaries in the LIVE read model. Existing recent pairs are not counted twice.
- Cash History, Fills, Orders and Account Balance History remain behind a format-validation gate. Their definitions are available, but only Performance has been verified end-to-end against this OAuth account.

## Entry / SL / TP evidence boundary

- `Performance` alone proves the completed round trip: side, quantity, entry price/time, exit price/time and gross P&L. It does **not** identify the closing order, so AlphaTrade must display `důvod výstupu neurčen` instead of guessing SL or TP from price movement.
- An exact historical classification is possible only if the connected account's `Fills` report exposes the closing `orderId` and `Orders` / `Order Details` exposes that order's type and relation (`parentId`, `ocoId` or `linkedId`). The available report definitions make this path plausible, but the CSV columns have not yet been verified end-to-end on this OAuth account.
- For current and future events the canonical relation is deterministic: `FillPair` identifies the closing fill, `Fill.orderId` identifies the closing order, and the broker Order entity identifies a Stop or a linked bracket/OCO Limit. Only that chain may produce the labels `Stop loss` or `Take profit`.
- A plain unlinked Limit is shown as `Limitní výstup (TP nepotvrzen)`, because the same order type can be a discretionary/manual exit.

The implementation is intentionally not active in production until the hosted Supabase project has been backed up, the migration is applied, advisors are reviewed and the matching Vercel build is explicitly approved.

## Product comparison

TradeZella documents that leaving the Tradovate sync start date blank imports all available records, while a custom start date limits the import. It also documents a historical commission/fee limitation. AlphaTrade can match the historical trade backfill using Tradovate's reporting API, while using Cash History to preserve fees as a separate ledger where available.

## Safety constraints

- Reporting calls are server-side, authenticated to the AlphaTrade user and account ownership is verified before a report is requested.
- Historical endpoints never place, modify or cancel orders.
- Reporting should not be polled for copier latency. Use it for initial backfill and reconciliation.
- The Performance backfill treats live `Too long range` responses as a split signal and an empty CSV (including an empty JSON `data` wrapper) as a valid zero-trade interval. Successful imports are cached and resumable to avoid repeating accepted windows.
- Account identity and its exact creation timestamp are resolved through the lightweight read-only `/account/item` endpoint only until persisted. Resumed ranges then use the user-scoped durable sync identity so historical progress cannot repeatedly consume the account-list rate limit.
