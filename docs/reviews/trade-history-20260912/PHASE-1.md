# History by account — phase 1, 2026-09-12

## Scope

The user approved starting gradual implementation after a standalone mockup review.
This first increment fixes presentation scope and labels existing estimates. It does
not introduce a broker collector, durable SL/TP history, historical data repair, or
the new position overlay. It is prepared in an isolated worktree based on e61ab59a;
the canonical checkout has concurrent uncommitted LIVE display/broker changes.

## Implemented

- Combined rows retain the exact member IDs which passed the existing filters.
  Opening the detail no longer brings back the rest of the unfiltered group.
- Individual details show the selected account record only, preserving its own
  entry/exit timestamps (including milliseconds), prices, quantity and PnL.
- Group relationships require explicit group IDs. Same symbol, direction and
  timestamp do not establish a copy relationship. A master is identified by an
  explicit flag or member linkage, not account names or array order.
- Counts describe distinct journal accounts, not successful broker executions.
  Separate realizations are not discarded merely because they share an account.
- Combined PnL propagates the existing `pnlEstimated` quality flag. Both layouts
  label estimates and the detail explains that account fills/times remain unproven.
- Combined screenshot loading resolves a real included account ID instead of
  querying the synthetic `combined_*` ID. Screenshots remain the default tab.
- The chart receives the actual included representative account row and labels
  that account. It never consumes the synthetic sum as an account execution.
- Combined edit/delete target resolution uses the same filtered membership; a
  missing combined selection cannot fall back to mutating the entire group.
- Changes to an open combined card refresh from the current filtered projection;
  individual optimistic edits still fall back to the complete source list.

## Deliberately unresolved data gaps

The current copier journal creates follower rows from the leader plus the *current*
configured multiplier. It copies leader entry/exit prices and times and marks PnL
estimated. The current broker adapter receives fills, orders, execution reports,
command reports and order versions, but retains the latest order version per order.
This does not prove that the complete history required by the proposal is captured.

This increment cannot turn existing synthetic follower records into factual fills.
It does not deduplicate existing persisted copier rows: multiple rows may represent
duplicate imports or valid separate realizations, which need execution identity.
Changing the display mode is not evidence reconciliation.

## Agreed subsequent increments

1. Capture immutable account-scoped evidence: connection/environment, account,
   episode, order, order version, command and fill IDs; source timestamp and receive
   timestamp; event status and capture continuity. Raw observations and accepted
   protection states are separate. Reconnection snapshots cannot be backdated as
   original protection or interpreted as a complete historical change sequence.
2. Derive account executions from own fills, including partial fills, scale-ins,
   partial exits, reversals, cancellations/rejections and fees. Net PnL must not be
   claimed when fees are missing. Link copies by execution provenance and original
   participant configuration, never by today's copy group or matching minutes.
3. Persist all SL/TP requests, confirmations, rejections and cancellations. Preserve
   multiple changes in the same minute and distinguish timestamps of submission,
   broker confirmation and local observation. Ambiguous ordering stays ambiguous.
   Duplicate delivery must not duplicate the timeline or journal. Do not invent
   missing original SL/TP, risk, exit reason or missing historical changes.
4. Reuse the existing backtesting position-box visuals in the Chart tab of the
   existing detail. Screenshots stay first/default. Render original protection
   separately from stepwise confirmed history. Dense changes get a count and exact
   event list; OHLC bars do not reveal the intraminute market path. Preserve zoom
   and viewport when switching overlays or account comparisons.
5. Combined mode defaults to grouped common state plus exceptions, with one account
   comparison on demand. Individual mode uses that account's own timeline and PnL.
   No wall of 12 overlapping boxes. Existing unknown/estimated records remain visibly
   limited until evidence-based reconciliation is possible.

## Delivery boundary

No changes to the canonical working files, deployed application, broker orders,
worker process, database configuration or existing journal records were made.
The localhost HTML mockup on port 4178 is still the reviewed mockup, not this increment.
Production activation and historical reconciliation require a later reviewed step.


## Validation of final source snapshot

- 13 regression tests passed in `tests/tradeHistoryPresentation.test.ts`.
- Scoped ESLint completed with zero errors (`--quiet`; not a claim of zero warnings).
- TypeScript passed for App.tsx, both changed history/detail components, the helper,
  its tests and their dependency graph. The check used the repository compiler
  settings and a temporary files-only configuration. The initial whole-repository
  check reported missing Chrome/extension development dependencies in the isolated
  checkout; a repeated whole-repository check was stopped under resource pressure.
  Do not interpret the scoped pass as a complete extension/server test run.
- Final `vite build` completed, including the PWA service worker. It retains the
  existing warning about bundles larger than 500 kB.
- `git diff --check` passed. Final source hashes were unchanged through validation.
- No authenticated browser or broker conformance test was run for this increment.
