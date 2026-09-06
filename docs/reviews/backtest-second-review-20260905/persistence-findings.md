# Adversarial review: workspace, templates, review, AI paths

Read-only canonical checkout: `/Users/filipkrejca/Documents/trading-journal-aka`, 2026-09-05. Application files were not changed. Reproductions execute current source functions with synthetic data and mocked transport/storage; no remote data, broker, external AI, or connector calls. No full suite/typecheck. The remotely deployed source/schema revision is unverified.

## Confirmed defects

### 1. P1 — Transient gallery read failure destroys links to existing screenshots

Locations: `services/storageService.ts:1035` and `:1052`; `services/backtestTradeReview.ts:32`–`:36`.

`getTradeScreenshots` returns an empty Map for a Supabase error or a thrown transport error. The review helper treats that as an empty gallery, uploads the new screenshot and overwrites both `screenshot` and `screenshots`. A transient first-read failure followed by successful upload/update loses all previous gallery references while reporting success. Storage objects may remain, but the trade no longer references them.

Reproduction: actual source methods plus actual review helper, existing primary and secondary image, fail only gallery SELECT, succeed upload/update. Result: one new image; old primary and second link absent; promise resolves. Script: `evidence/persistence/alphatrade-trade-review-adversarial.cjs.txt`.

Suggested correction: make the mutation path distinguish read failure from confirmed empty data; abort before upload/write on failed prerequisite. Append atomically or revision-check the gallery to also handle concurrent additions. Existing helper tests use successful/mock empty reads, not the real service's error contract.

### 2. P1 — Concurrent review updates overwrite unrelated newly saved fields

Locations: `services/storageService.ts:679` (snapshot read), `:691` (full JSON merge), `:710`–`:716` (unconditional update).

Two requests read the same `data` blob, then patch different fields. A notes save succeeds; a tags save built from the old snapshot succeeds afterward and restores the old notes. Returning the row ID proves the second write happened, not that it preserved a concurrent update.

Reproduction: `Promise.all([updateTrade(id,{notes:'new review A'}), updateTrade(id,{tags:['new tag B']})])`; both source methods confirm success, final notes equal the old value. Same script as finding 1, all DB/cache calls mocked.

Suggested correction: server-side field patch or compare-and-swap revision and explicit conflict handling; include gallery appends in this protocol. An in-process queue alone cannot protect a second browser/device.

### 3. P2 — Workspace Save and New Session's saved layout read different storage contracts

Locations: `components/AlphaTradeChartWorkspace.tsx:1489`; `services/chartWorkspaceDocument.ts:101`; `components/BacktestSessionsManager.tsx:17`–`:25`, `:134`, `:224`–`:241`.

Save writes a complete document to `alphatrade:workspace-document:v1:user:<owner>:<session-or-market>`. New Session reads only the retired, unowned `alphatrade.candlekit.layout.alphatrade-market-workspace` key. A newly saved market workspace therefore remains unavailable for New Session. Saving within a backtest session additionally has no defined bridge to a reusable starting template. `savedLayoutAvailable` is memoized with no dependencies, so it also cannot react to a later save while mounted.

The legacy fallback is a separate ownership hole: this initializer reads an old unowned layout even though the new Load button explicitly refuses to adopt that same legacy market slot for signed-in users.

Reproduction: seed only the new user-A market key using the real key builder; execute the real session-manager read helper: no layout. Seed the old unowned slot: user-A's helper now returns that layout. Script: `evidence/persistence/alphatrade-layout-review-adversarial.cjs.txt`.

Suggested correction: a shared, owner-scoped document/template reader used by Save, Load, and New Session; a deliberate reusable template choice distinct from run-specific replay state; observable updates rather than mount-only availability.

### 4. P2 — Template synchronization can resurrect a newer remote deletion

Location: `services/chartTemplateStore.ts:147`–`:158`, also the retry at `:171`.

The initial cloud SELECT is merged locally, but the subsequent upsert has no expected revision. If another device edits/deletes a template after SELECT, the older client's write overwrites the newer row. Tombstones protect a deletion that was visible in the initial SELECT; they do not protect an intervening deletion. Final status becomes `synced`.

Reproduction: cloud snapshot at 01:00, local version at 02:00; immediately after producing the SELECT response simulate a remote tombstone at 03:00. The actual store upserts 02:00 and removes the tombstone. Script: `evidence/persistence/alphatrade-template-adversarial-audit.cjs.txt`.

Suggested correction: conditional server update/compare-and-swap, insert-only first creation, preserve both versions on conflict. Client timestamps alone also cannot resolve devices with clock skew reliably. Current tests cover deletion before SELECT and a UUID uniqueness conflict, not this read/write race.

### 5. P1 — Legacy template import cleanup can erase the only copy after an account switch

Location: `services/chartTemplateStore.ts:210`–`:224`, particularly cleanup after the await at `:221`.

The starting owner is checked before the import. After awaiting sync, cleanup instead trusts global `syncStatus` without rechecking owner/generation. With localStorage quota failure, A's imported templates only exist in memory. Switch to B while A's cloud read is pending; B's empty cloud sync succeeds. Import cleanup now sees B's `synced` status and removes the legacy source although A's import was never persisted.

Reproduction with the real store: quota failure for writes, deferred A read, auth switch to B, B sync queued, A read fails. Final state: legacy key deleted, no A cache, zero cloud upserts, status `synced`. Script: `evidence/persistence/alphatrade-template-adversarial-audit.cjs.txt`.

Related deterministic loss at `:215`–`:223`: a legacy template with the same normalized name but a different value is skipped and the entire legacy source is then deleted. The account-wins policy is explicit in code, but the UI provides neither a conflict preview nor an archive of the rejected variant. The same script demonstrates this branch.

Suggested correction: cleanup only on a durable acknowledgement bound to the original user, generation, and exact imported records; retain source/conflicting variants until explicitly resolved.

### 6. P2 — AI JSON export drops the newly supported custom tags and provenance

Locations: `components/BacktestSessionsManager.tsx:84`–`:103`, `:181`–`:188`; legend at `:79`.

Full rows are fetched, then `buildTradeRecord` omits `id`, `tags`, `autoConfluence`, and `setupType`. The downloaded AI analysis file cannot filter by the user's new custom tags, distinguish automatic versus manual confluence, or precisely cite a trade ID. The legend incorrectly describes all HTF/LTF capsules as manually chosen. Ordinary notes themselves are included.

Reproduction: invoke the actual export helper with all four fields populated; all are absent from the output. Script: `evidence/persistence/alphatrade-layout-review-adversarial.cjs.txt`.

Suggested correction: share an explicit versioned review/evidence DTO among export and Coach tools, keep stable trade/run/account IDs, tags and their provenance, and correct the field legend. Full-data retrieval without pagination (`storageService.ts:1514`) additionally risks server row-limit truncation; the remote configured cap was not checked, so this is not claimed as an observed truncation.

### 7. P2 — Complete-workspace validation accepts appearance data that crashes its consumer

Locations: `services/chartWorkspaceDocument.ts:63`–`:66`; `components/AlphaTradeChartWorkspace.tsx:1450`–`:1467`; `services/chartTimeAxisFormat.ts:48`.

Appearance is checked only for object-shaped slots. An otherwise valid document with `appearance.chartSettings.symbol.timeZone = 'Mars/InvalidZone'` is accepted unchanged; actual `mergeChartSettings` preserves it and actual chart time formatting throws `RangeError`. Import's synchronous catch only covers appearance replacement and layout import. The offending settings are consumed later during chart render, after the new state has been handed to session persistence, so that catch cannot restore the prior workspace.

Reproduction proves validator acceptance and formatter failure using current modules, not a fabricated validator. Script: `evidence/persistence/alphatrade-layout-review-adversarial.cjs.txt`. The resulting mounted UI recovery path was not separately exercised in this subtask.

Suggested correction: validate/normalize nested appearance and drawing/indicator schemas before any mutation, including valid time zones and bounded numbers; make import a staged transaction with a retained recovery snapshot. Unknown library indicator names are similarly accepted at `chartWorkspaceDocument.ts:81` and silently ignored by the existing library controller after `AlphaTradeChartWorkspace.tsx:485` clears its old indicators.

### 8. P2 — Imported chart roots bypass the current run's instrument allowlist

Locations: `services/chartWorkspaceDocument.ts:42`; `components/AlphaTradeChartWorkspace.tsx:1470`–`:1480`, `:497`–`:503`. In contrast, normal symbol switching checks the allowlist at `:1355` and New Session sanitizes NQ at `BacktestSessionsManager.tsx:31`.

An MNQ-only run can import an otherwise valid NQ panel. The parser accepts either market root without run context and import applies it unchanged. The backtest panel then only consults its session candle map, receives no NQ candles, sets loading=true, and never requests that absent instrument. The result is a persistently empty loading panel. This is a display/data-availability failure; existing execution-instrument checks prevent claiming that it executes NQ orders as MNQ.

Reproduction proves acceptance of the NQ input using the actual parser. Source traces the empty-data path; no new browser session was created. Script: `evidence/persistence/alphatrade-layout-review-adversarial.cjs.txt`.

Suggested correction: pass allowed roots into import validation or present an explicit NQ→MNQ mapping before committing the document.

## Existing MCP limitation reverified, unchanged

`supabase/functions/mcp-server/index.ts:149` caches core data for 60 seconds. `get_trade` at `:718` reads that cache and at `:729` slices serialized JSON at 30,000 characters. Actual-handler mocked reproduction again confirms a 35,000-character `entryContext` before the notes drops those notes and returns invalid JSON, whereas an ordinary small detail includes notes/tags. Script: `evidence/persistence/alphatrade-mcp-notes-audit.cjs.txt`.

This is source behavior, not a claim about the remotely deployed revision. No MCP or automatic embedding changes were retried: earlier approval review had rejected those transfers without specific external destination/payload authorization. App Coach current-record hydration is present; semantic ranking may still use older embeddings. The current review dialog also contains the saving locks added after the prior review; that earlier pending-save draft-loss issue is not repeated as still open.

## Product/AI development ideas grounded in current modules

1. **One reusable workspace library.** Extend the owner-scoped `chartWorkspaceDocument` contract into a named layout catalog that New Session, Save and Load all use. Separate a reusable chart template from a full run checkpoint so another session does not inherit an unrelated replay viewport by accident. Start with explicit “Use as next-session default.”
2. **Import preview and one-click recovery.** Reuse `readWorkspaceState`, `workspaceLayoutPanelIds` and `applyWorkspaceState` to preview panels, instruments, drawings, indicator changes, and incompatibilities. Keep the previous complete document as a local recovery version until the import and persistence are confirmed.
3. **Review queue with Save & Next.** Build on confirmed `journalTrades`, the existing durable trade outbox and `BacktestTradeReviewDialog`. Show missing review fields, keep independent drafts per trade ID, add previous/next shortcuts, and make keyboard review of a session possible without reopening each marker.
4. **Tag management with evidence and aliases.** Build on `backtestTagCatalog`, `Trade.tags`, `autoConfluence`, `entryContext` and `entryMap`. Show why an automatic capsule exists, let the user pin/rename a manual tag, and offer aliases/merge preview instead of accumulating spelling variants. Keep generated evidence separate from the user's interpretation.
5. **Explicit “Analyze this review” action.** Open App Coach with the selected trade ID, full current notes, current tags, and only the requested execution context. A scoped, paginated review-detail domain can extend the existing `get_coach_records`; show evidence links and the note revision used. No automatic background transfer is necessary.
6. **Turn a tag hypothesis into a Lab experiment.** Reuse `get_stats` tag grouping (`coachTools.ts:894`), `buildLabDataset` (`labAnalytics.ts:383`) and `computeExperimentReport` (`:1615`). Compare manually selected cohorts, show sample sizes and ambiguous-outcome exclusions, and record the hypothesis before evaluating a new segment rather than inferring an edge from retrospective tags alone.
7. **Portable, traceable AI evidence export.** Share the same reviewed-trade DTO across App Coach and downloadable JSON, with IDs, provenance, note revision, engine/config revision and data-quality flags. Include a compact manifest and omitted-field/pagination counts so a human or AI can see exactly which evidence was supplied. Any future remote connector rollout remains a separate authorized step.

Priority: fix the four data-loss/conflict cases and the Save→New Session contract before adding more AI automation. Then import preview/recovery and review queue provide immediate productivity without depending on remote model calls.
