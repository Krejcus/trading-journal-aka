# F33 tag library — local implementation and activation boundary

Prepared 2026-09-05. No production queries, writes, migration application, deployments, or AI calls performed by this block.

## Contract

`loadBacktestTagLibrary(ownerId)` performs `get_backtest_tag_library_v1()` and requires a successful, owner-matched response. Missing capability throws; it is never treated as an empty catalog.

`commitBacktestTagLibrary(plan)` performs one `commit_backtest_tag_library_v1` RPC with owner, operation ID, expected library, next library, explicit scope, every scoped trade snapshot, and allowed field patches in the POST body. Returns `{library,operationId,alreadyApplied,tradePatches:[{tradeId,updates}]}`. The parent should merge only confirmed `updates` into matching IDs and replace the library with the confirmed current library; preserve all unrelated Trade fields. Keep the original plan/opId unchanged after uncertain transport failure. Mount `BacktestTagManager` with `key={ownerId}`.

The backend locks the owner's library and scoped trades in ID order. It checks full library CAS, canonical trade/account/run identity, actual account/run ownership and link, and selected fields (including full automatic provenance for HTF/LTF scopes). A failure rolls back the entire request. A persisted SHA256 receipt allows exact request retry after subsequent changes; the response contains current tag values and current library, never a replay of old requested values. The hash is an idempotency check, not an authorization mechanism.

Catalog IDs are stable; archive/delete are retained catalog tombstones. Merge links the source ID to its target; old source labels/aliases remain resolvable through `resolveBacktestLibraryTag`. Historical strings change only through the explicit preview's patches. Automatically owned source capsules are preserved; a manually merged target takes manual ownership if it collides with a generated target.

## Scope and limits

At most 500 tags, 32 aliases per tag, 500 selected trades/patches, 1 MiB library, 2 MiB complete request. PostgreSQL JSONB textual whitespace makes server byte bounds slightly more conservative than JSON.stringify. Invalid/oversized requests fail without truncating data. UI allows explicit selection of up to 500 loaded trades and displays affected IDs/field changes; it never silently chooses the first 500 or claims unloaded records were checked.

## Activation gate

Migration: `supabase/migrations/20260905194508_backtest_tag_library_atomic_commit.sql`.

Creates `alphatrade_private.backtest_tag_libraries` and `alphatrade_private.backtest_tag_operations`, owner RLS and explicit grants, two private validation/key helpers, and two public SECURITY INVOKER RPCs. Anonymous/PUBLIC execution is revoked. It does not alter existing trade columns, trade policies, or private note storage. On successful explicit merge it updates only selected trade JSON tag fields.

**Before activation, verify `alphatrade_private` is absent from exposed Data API/GraphQL schemas.** The invoker RPC requires authenticated table privileges; exposing that private schema would permit direct owner table mutations outside the CAS API. Canonical repo has no `supabase/config.toml`; production exposure was not queried in this block. Recheck existing schema privileges if this name already exists. Test anon and another authenticated owner over actual PostgREST, not only SQL. Run production security/performance advisors only during the separately approved activation.

Back up the current schema/function definitions/ACLs/RLS for affected objects and relevant owner trade tag fields before applying; new tables are absent before the first activation. Preserve deployment commands and migration hashes in the approved activation record. This file deliberately contains no credentials or remote execution command.

Rollback compatibility: disabling/removing the new RPC makes management fail closed and leaves ordinary existing trade tag entry available. Do not drop the new data tables merely to roll back frontend code. Schema rollback does **not** undo historical tag merges already explicitly committed; restoring such values requires the original preview/snapshot backup plus a new conditional patch, preserving subsequent edits. Receipts store request hashes/revisions, not complete before-images.

## Verification

- `npx vitest run tests/backtestTagLibrary.test.ts tests/backtestTagManagerRender.test.ts tests/backtestTagLibraryPersistence.test.ts --maxWorkers=1` — 31 tests, 3 files passed.
- Scoped ESLint: six TypeScript/TSX files passed with no errors; the additional CJS verifier is ignored by repository lint configuration (one informational ignored-file warning). Its execution parsed and exercised it successfully.
- `PGLITE_MODULE_PATH=/private/tmp/ios-notification-sql-runtime/node_modules/@electric-sql/pglite node scripts/backtest/verifyTagLibraryAtomic.cjs` — 23 assertions/groups passed using real local PostgreSQL WASM. Includes transaction rollback after a later scoped-row conflict, library CAS, actual account/run ownership, alias ambiguity/folding, receipt retry after newer tags/library, unauthorized fields, provenance field scope, bounds, RLS and anonymous grants.
- PGlite tests use serial calls with deliberately stale snapshots. They do not claim two-device HTTP conformance, deployed schema availability, or a live Supabase advisor result.

Evidence logs: `/private/tmp/backtest-tag-library-tests-20260905.log`, `/private/tmp/backtest-tag-library-lint-20260905.log`, `/private/tmp/backtest-tag-library-sql-verification-20260905.log`.

Official references checked: [Supabase database functions](https://supabase.com/docs/guides/database/functions), [securing the Data API](https://supabase.com/docs/guides/api/securing-your-api), [2026 table exposure changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically), [PostgreSQL binary-string hash functions](https://www.postgresql.org/docs/current/functions-binarystring.html). Public changelog snapshot: `/private/tmp/backtest-tag-supabase-changelog-20260905.md`.
