# Layout, session appearance and account isolation — 2026-09-05

Reviewed current canonical code, then implemented only in the isolated
`/private/tmp/alphatrade-layout-tags-20260905` snapshot. No remote mutations.

## Fixed and covered by targeted deterministic tests

| Defect | Reproduction before the fix | Result after the fix |
| --- | --- | --- |
| Close could save a stale layout/drawing/appearance snapshot | Change a drawing or appearance and close within the 1,200 ms child checkpoint interval. Parent saved its older `runRef`; child's unmount checkpoint happened after save. | Child registers a live synchronous capture; every parent flush captures before reading the run. A real DrawingEngine test adds a drawing and immediately captures without advancing either debounce timer. |
| StrictMode could close the appearance scope while the session stayed mounted | Session opened scope during render/useMemo; StrictMode ran effect cleanup followed by setup, but setup did not reopen it. Later writes fell back to global storage. | Pure session lease is activated in a layout effect; charts mount only afterwards. Setup/cleanup/setup retains the scope and edited values. |
| Loading cloud appearance for the same run could retain old appearance or close the replacement's scope | Same run ID was rendered with a new React key; opening saw the same global ID and did nothing; old cleanup then closed the scope. | Each mounted instance owns a lease token. New instance restores its supplied snapshot; stale cleanup cannot close it. Both cleanup orderings are tested. |
| Panel registration could precede its drawing engine, losing saved drawings | Saved panel count matched placeholder registrations with `chartApi=null`; restore was marked complete despite skipped drawing import. | Restore checks each saved panel's chart and drawing engine. Lazy tabs retain their pending saved state in checkpoints until mounted; removed panel IDs are omitted. |
| Global chart, indicator and drawing defaults leaked across accounts | A's shared `alphatrade:*` keys survived logout; B's new session inherited them. | All three signed-in default stores use `:user:<id>` keys with account-specific memory and cache invalidation. Unknown identity is neutral. Unowned legacy keys are retained for explicit guest mode and are never silently assigned to an account. |
| Delayed auth initialization could overwrite a newer user | `getSession()` returns A after a B sign-in/logout event. | Auth binding ignores obsolete responses. Unknown → first resolved user preserves the restored session. A → B blocks stale session writes instead of letting them write B's defaults. |

Checkpoint comparison also ignores CandleKit's automatically changing export
`updatedAt`, so an otherwise idle workspace is not marked dirty on every poll.

## Verification executed

```
node node_modules/vitest/vitest.mjs run tests/chartAppearanceScope.test.ts tests/backtestWorkspaceCheckpoint.test.ts tests/chartWorkspaceHistory.test.ts --configLoader runner --no-cache --maxWorkers 2
Test Files 3 passed; Tests 26 passed

node node_modules/vitest/vitest.mjs run tests/chartAppearanceScope.test.ts tests/chartAppearanceAuth.test.ts tests/backtestWorkspaceCheckpoint.test.ts tests/chartSettings.test.ts tests/chartDrawingStyleDefaults.test.ts --configLoader runner --no-cache --maxWorkers 2
Test Files 5 passed; Tests 53 passed

node node_modules/vitest/vitest.mjs run tests/chartWorkspaceDocument.test.ts tests/backtestWorkspaceCheckpoint.test.ts tests/chartAppearanceScope.test.ts tests/chartAppearanceAuth.test.ts --configLoader runner --no-cache --maxWorkers 2
Test Files 4 passed; Tests 35 passed

node node_modules/vitest/vitest.mjs run tests/chartWorkspaceDocument.test.ts --configLoader runner --no-cache --maxWorkers 2
Test Files 1 passed; Tests 11 passed (includes final label/display-flag validation)
```

TS/TSX syntax transpilation passed for all edited components/services. No full
typecheck or full suite was run by this reviewer. These unit tests verify the
production capture/history/scope/auth contracts. Parent browser QA additionally
confirmed on the isolated mock harness:

1. Under StrictMode, enable levels and create a Rectangle, immediately Close,
   then Reopen saved: drawing and levels are present in the snapshot and visible.
2. Uložit, delete the drawing and disable levels, then Načíst: both return.

No production cloud roundtrip or live account switching was exercised in browser;
auth ordering, owner isolation and persistence contracts were tested with mocks.

## Persistence semantics and remaining boundaries

- The run's `workspaceState` autosave contains layout tree, drawings, indicators,
  chart scales, active panel, sync settings and appearance, and travels through
  the existing local + cloud run persistence service.
- Manual **Uložit/Načíst** now stores/restores the complete workspace checkpoint:
  tree/configs, drawings, indicator state, appearance, scales and synchronization.
  The named copy is scoped to the account and session in this browser. Save and
  Load also invoke the run's existing local/cloud flush; UI status distinguishes
  a saved cloud run from a local save waiting for cloud synchronization.
- Export/import uses `{format: 'alphatrade-workspace', version: 1, state: ...}`.
  It is a complete workspace document, not an order ledger or whole backtest run.
  Structural validation precedes mutation. Tests cover full roundtrip, legacy
  layout recognition, corrupt JSON/drawings/configs/IDs/indicators, independent
  cloning and ownership of named slots. Valid old manager-only JSON is accepted
  with an explicit message that it contains no drawings or appearance. Local
  storage and parse failures are shown in the workspace status.
- Named indicator/drawing templates use their own store, reviewed and fixed by
  the template reviewer.
- `pagehide` now requests a final local flush. Browser/process termination
  before asynchronous IndexedDB finishes cannot be guaranteed durable; a normal
  explicit Close awaits the local save and remains open on local failure.
- Global per-account defaults remain local to this device/origin. Session
  appearance is the cloud-backed part; no cloud sync was added for global
  defaults. Existing unowned appearance is intentionally not auto-migrated.
