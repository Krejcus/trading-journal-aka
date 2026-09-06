# B16 — legacy trade notes privacy (prepared locally)

Status: implemented and verified locally on 2026-09-05. **No database migration, Edge Function or app deployment was performed by this block.** Current remote privacy is not fixed until an explicitly approved coordinated activation. Existing remote rows were not read; remote verification inspected definitions, grants and policies only.

## Proven problem and scope

The current `trades` SELECT policy exposes the whole `data` JSON to public/accepted-connection readers. Client hiding and `get_public_trade` removing only `notes` cannot protect the table itself, nested copies, or `sessionPreNotes` / `sessionPostNotes`. Both `anon` and `authenticated` have the necessary table SELECT grants. Current connection INSERT authorizes the sender but does not restrict the inserted status; sender-supplied `accepted` rows can satisfy the broad SELECT policies. No existing trigger prevents this.

Prepared migration `20260905193801_trade_legacy_notes_privacy_and_owner_consent.sql` moves `notes`, `sessionPreNotes`, `sessionPostNotes` out of physical `trades.data`. Recognized private keys, including `noteHistory`, are removed recursively. Exact legacy/nested captures are retained in owner-only `legacy_fragments` for recovery. Only the three supported top-level legacy fields can be shared; revision history and recovery fragments never are. Unusual old non-string values are preserved, and the client reports a recovery error instead of silently coercing them.

## Access and compatibility contract

| Reader/action | After activation |
| --- | --- |
| Owner | Owner RLS plus versioned projection restores legacy notes; new revision history uses its separate owner-only table. |
| Existing accepted connection | Other current accepted status/policies remain unchanged. Trade notes require explicit receiver confirmation; no legacy marker is fabricated. |
| Newly accepted request | Receiver atomically accepts the request and confirms the displayed permissions. Sender can only create a pending request with empty permissions. |
| Note permission/account scope changes | Server revokes the note marker; receiver must confirm the new scope. Empty/missing account list preserves existing “all accounts, including future accounts” semantics and UI states this explicitly. |
| Unrelated permission changes | Do not revoke note consent. Read status additionally compares the complete displayed permission snapshot to prevent misleading optimistic UI. |
| Public URL, `is_public=true`, `share_notes=true` | Existing explicit owner intent is preserved by `get_public_trade(uuid)`; three supported legacy fields included. |
| Public URL, note sharing off | No private note fields. Direct table reads also contain none even when sharing is on; use the projection RPC. |
| Reverse connection direction | Does not grant trade-note access; receiver owns the notes, sender follows. |
| Private revision history | Always owner-only, regardless of public share/connection consent. |

A trigger splits older clients' writes atomically: omitted note key preserves the private value, explicit null/empty clears it. Trade and connection identities cannot change. `get_dashboard_data` keeps the common older owner payload shape through an authenticated wrapper. Direct old foreign table consumers will no longer receive private notes and must use the authorized projection. New clients preserve owner read compatibility before activation but suppress unverified foreign cached notes. Missing server support makes connection confirmation unavailable with an explicit error; no unsafe fallback acceptance or silent success occurs.

`saveTrades` probes readiness before writes and uses the committed owner-only PostgREST relation to return notes when activated. Client JSON helpers, dashboard/list/detail/export hydration, review CAS, network projections and auth-switch protection are covered locally. The existing configured-owner MCP server reads the new table with an explicit `user_id` filter on every page; its revision-history hydration remains a separate documented gap. No external AI request was made.

## Remaining broader ACL risk (separate follow-up)

Read-only metadata confirmed `profiles` SELECT `true`, and accepted-connection policies on `daily_preps`, `daily_reviews`, `accounts` allow both connection directions without checking the corresponding field/account permissions. This migration prevents new forged accepted rows but **does not certify old accepted rows or rewrite their status**, nor does it silently change these other product scopes. Existing old rows and broader profile/preparation/review exposure therefore require a separate owner-approved ACL migration. `backtest_runs` currently has owner-only authenticated policies and no connection/public row sharing.

## Concrete verification

From the canonical repository:

```sh
PGLITE_MODULE_PATH=/private/tmp/ios-notification-sql-runtime/node_modules/@electric-sql/pglite node scripts/backtest/verifyLegacyNotePrivacy.cjs
./node_modules/.bin/vitest run tests/tradeLegacyNotes.test.ts tests/storageBacktestPersistence.test.ts tests/tradeNotePrivacy.test.ts tests/backtestReviewPersistence.test.ts tests/backtestTradeReviewPersistence.test.ts tests/storageSessionIdentity.test.ts tests/mcpLegacyNotes.test.ts --configLoader runner --no-cache --maxWorkers 2
```

Results: 22 PGlite checks passed; 53 tests across the first six listed test files passed; three additional actual-source MCP loader tests passed. Scoped lint: 0 errors, 15 existing warnings. Scoped `git diff --check` passed.

The PGlite fixture reproduces current grants and broad policies. It executes the complete new migration followed by ROLLBACK and proves original JSON/schema unchanged, then applies it in a fresh transaction. Adversarial assertions cover raw-table/anon denial, exact recovery data, private CAS, omission vs clear, public share on/off, old-connection denial, account scope, stale displayed scope, forged acceptance, identity rewrite, sender permission mutation, server-owned marker denial, atomic receiver acceptance, reverse direction and direct private-table write denial. No production IDs, tokens or note contents occur in fixtures. This is PostgreSQL behavior proof, not a live PostgREST/schema-cache/browser or production load test.

## Activation order and concrete rollback/recovery

1. An operator must separately approve the target and take a full verified database backup (including `trades`, `connections`, private note history and original function definitions). Run the prepared read-only `scripts/backtest/legacyNotePrivacyPreflight.sql`; it returns counts/metadata, no note content. Missing owners, unexpected policies/columns, or already-created B16 objects require resolving the mismatch first.
2. Prerequisites are the local atomic review migration `20260905173116_backtest_review_atomic_patch.sql` and owner-history migration `20260905190446_backtest_private_trade_note_history.sql`. The B16 migration intentionally is not a repeatable blind upsert. It locks `trades` and `connections` for transactional backfill; schedule the lock with measured row count/backup capacity.
3. Apply B16 only in the separately approved rollout. Its BEGIN/COMMIT, backfill assertion and schema notification are one transaction. Any error before commit rolls back both data and DDL. `verifyLegacyNotePrivacy.cjs` concretely proves this path by replacing the final COMMIT with ROLLBACK and asserting exact original bytes/schema.
4. Coordinate the updated app and local MCP Edge Function with activation, then verify owner list/detail/export/review save, a denied connection, receiver reconfirmation, allowed/denied account, public sharing on/off, and auth switch against the activated stack. Existing remote behavior has not been declared verified.
5. **After commit there is deliberately no down migration that copies secrets back into `trades.data`.** That would reopen the confirmed leak. A frontend rollback may keep the private table, triggers and safe public/dashboard compatibility RPCs. Fix server incompatibilities forward while retaining private records and markers. If a full pre-change DB restore is necessary, that is a separate operator decision: it reintroduces the prior privacy exposure and requires isolating access first.
6. For an individual owner recovery, `scripts/backtest/legacyNotePrivacyOwnerRecovery.sql` is an executable READ-ONLY query under that owner's auth session. It exports current private fields, exact nested recovery fragments and private revision history. Keep its output private. It does not modify trades or restore secrets into public JSON. Unknown legacy formats can be recovered from these exact fragments rather than silently discarded.

No broad RLS change or remote activation is implied by these prepared files.
