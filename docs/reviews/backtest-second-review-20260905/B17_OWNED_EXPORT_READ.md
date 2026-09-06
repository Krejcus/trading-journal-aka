# B17 / P2 — incomplete full-trade export read

Confirmed locally on 2026-09-05: `getTradesWithDataByAccounts` previously executed one unpaginated `SELECT *` with no deterministic order and returned `[]` on a database error. `BacktestSessionsManager.exportSessions` called it directly. A server row cap could therefore truncate a rich export; a failed query could look like a valid empty account. No remote data was queried or changed for this fix.

The bounded storage fix now requests pages ordered by unique trade ID until the server confirms an empty page. Offsets advance by the actual returned row count, so a server cap below the requested 1,000 rows does not truncate the result. Rich JSON fields remain intact, authoritative root run ID/drawings/signal/sharing fields are mapped, and existing private legacy/history hydration is preserved.

API:

```ts
getTradesWithDataByAccounts(accountIds, targetUserId?, {
  strict: true,
  expectedOwnerId?,
  signal?,
  onProgress?: (loaded: number) => void,
})
```

Strict mode captures the auth generation before the initial owner await, requires the original signed-in owner, checks every page's owner/account scope, and rejects query failure, malformed response, repeated IDs, cancellation, or identity change (including after private-note hydration). It never returns a successful partial prefix. Progress reports rows loaded, not an invented total/percentage. Cancellation reaches trade queries; cancellation during private hydration discards the completed result but currently does not abort those individual note requests. Empty requested account selection performs no trade query.

Compatibility callers retain the default database-error `[]` behavior; callers requiring trustworthy completeness must explicitly use strict mode. The parent task has wired the session exporter to strict mode with its captured owner. This report does not claim browser export verification.

Validation: `tests/storageOwnedTradeRead.test.ts` executes the actual method body with synthetic transport; eight cases cover 1,205 rows under a 500-row server cap, rich/private fields, later-page errors, confirmed empty versus malformed response, owner/target/returned-scope mismatch, A→B→A generation race, cancellation, and private-hydration races. `tests/storageBacktestPersistence.test.ts` retains 20 integration regressions with actual legacy/history hydration. **28/28 passed**.

```sh
./node_modules/.bin/vitest run tests/storageOwnedTradeRead.test.ts tests/storageBacktestPersistence.test.ts --configLoader runner --no-cache --maxWorkers 2
```

Limit: several paginated SELECTs are not an atomic PostgreSQL snapshot. Repeated IDs fail explicitly, but arbitrary concurrent inserts/deletes/edits cannot all be detected by this read-only client method. Research provenance must not claim a transactionally frozen dataset from pagination alone.
