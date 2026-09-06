# Backtest persistence — implementation and verification, 2026-09-05

These changes were implemented in the isolated staging directory `/private/tmp/alphatrade-backtest-fixes-20260905`. The tests below use mocked Supabase and IndexedDB adapters; they make no network requests and perform no production database writes. They verify the current implementation, not the historical evidence scripts in `evidence/`.

| Review finding | Implemented behavior | Regression coverage |
| --- | --- | --- |
| 4 — closed trade lost after a failed journal save | `backtestTradeOutbox.ts` persists the complete generated trade under its stable UUID before acknowledging enqueue. App drains the queue independently of Workspace on initial load, every 5 seconds, and when the browser returns online. Workspace retries failed enqueue and reconciles closed runtime trades on reopen. Only server-confirmed rows enter App's journal state. | `backtestTradeOutbox.test.ts`: local failure, immutable enqueue, duplicate enqueue, network failure/retry, empty and partial server returns, concurrent triggers, enqueue during acknowledgement, reload reconciliation, user changes during reads/writes. |
| 5 — stale tab overwrites a newer cloud run | A checkpoint uses an expected cloud revision and never falls back to an unconditional upsert. A missing or different remote snapshot raises `BacktestRunConflictError`. An uncertain write can be accepted only when the server returns the same canonical payload. Explicit cloud reload archives the entire local branch before replacement. Archives are user-scoped and available for export. | `backtestRunService.test.ts`: divergent revisions, retained local branch after listing, deleted remote row, uncertain commit, full conflict archive and owner isolation. |
| 6 — another user's sessions appear from local cache | Run blobs and indexes are user-scoped. Legacy unowned blobs remain untouched and hidden until an owned cloud row or owned account proves ownership. Missing legacy remote runs are not automatically recreated. App closes an active run after an owner change and rejects its old callbacks. | `backtestRunService.test.ts`: A/B/sign-out isolation, known and unknown legacy ownership, ownership lookup failure, auth change during listing and explicit conflict resolution. Outbox tests cover isolation of pending entries and receipts. |
| 9 — parallel restore loses index entries | The blob is persisted first and index changes use `idb-keyval.update`, an atomic IndexedDB read-modify-write transaction. | `backtestRunService.test.ts`: three cold cloud sessions remain discoverable in the subsequent offline list. |
| 10 — failed cloud checkpoint treated as success | Network/schema errors reject; they do not permanently disable cloud sync. Workspace retains the dirty flag and shows local/cloud/journal status separately. The last confirmed cloud revision is stored separately from local revisions and carried across in-flight edits. A committed run with a failed ledger write raises `BacktestRunSyncError` carrying `confirmedRun`, allowing the next retry to use the correct cloud baseline. | `backtestRunService.test.ts`: network and missing-table retry, failed new-run creation remains local, exact uncertain acknowledgement, snapshot commit plus ledger failure followed by a new local edit and reload. |
| 11 — same-candle order changes skipped | Incremental order synchronization compares the persisted order content, not replay time. Fills remain deduplicated by their immutable IDs. | `backtestRunService.test.ts`: an order created and cancelled at the same replay timestamp becomes cancelled in both the run snapshot and the order ledger. |

## Additional integrity checks

- `storageService.saveTrades(trades, { insertOnly: true })` uses server-side `ignoreDuplicates` for replay outbox inserts. An already reviewed row, including a row concurrently inserted after the existence lookup, is never overwritten by a retry. Ordinary callers retain their existing editing behavior.
- When an insert-only response omits an ID, the outbox checks the server again before acknowledging it. Empty responses alone do not establish success.
- Durable acknowledgement receipts prevent an intentionally deleted journal trade from being resurrected when its old replay session is opened again.
- `excursionAmbiguous` survives the dashboard RPC mapper, the projected trades query and mapper, and full trade-detail reads. `storageBacktestPersistence.test.ts` verifies these paths.
- Auth checks capture the expected owner before asynchronous work and recheck before returning or applying results. Cloud reads and writes include the owner filter; local queues, runs, indexes, and conflict archives use separate owner keys.

## Commands and limits

```sh
npx vitest run --configLoader runner tests/backtestRunService.test.ts tests/backtestTradeOutbox.test.ts tests/storageBacktestPersistence.test.ts
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck
```

The final targeted run passed **36/36 tests across 3 files**, including both mid-request auth cases. `--configLoader runner` avoids writing Vite's temporary bundled config into the staging directory's symlinked canonical `node_modules`.

The fresh full-project typecheck completed with **exit 0 and no diagnostics** after the QA harness callback was updated to the asynchronous durable-enqueue contract.

These unit tests do not prove browser IndexedDB quota behavior, physical tab shutdown timing, a real Supabase outage/RLS response, or a production deployment. The parent task owns browser QA and combined build verification. No migration, automatic reconstruction of historical financial results, remote deployment, or restoration of deleted cloud data was performed by this persistence work.
