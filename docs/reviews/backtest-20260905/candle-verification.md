# Candle/replay fixes — 2026-09-05

Scope: local isolated snapshot; no production data, broker actions, or remote writes.

| Original finding | Change | Deterministic verification |
| --- | --- | --- |
| 3 — Go To skipped executions in unloaded intervals | The cursor stays put until continuous source coverage reaches the requested target. Navigation uses the returned fresh source. Duplicate requests share work; newer requests invalidate older commits; failures preserve the cursor and permit retry. Parent processes the complete crossed interval from the candle store. | Delayed Go To, duplicate request, stale result/error, failure/retry, and real store + Go To tests confirm all 144 hourly fixture bars over six days exist before the cursor is returned. |
| 7 — Large replay step stalled before loaded edge | A step that cannot resolve from existing data explicitly loads through its requested interval, then continues across empty closure periods. The final oversized step lands on the last available session candle. Controls remain enabled at a temporary data edge. | Daily step with 800 bars remaining; closure continuation; oversized final step; actual store + `MarketDataError('no-data')` closure test. |
| 8 — Resumed session could not recover older session candles | Older requests first fill the missing already-revealed session prefix with minute data; only after reaching session start do they load pre-session context. History boundaries come from source coverage, preserving hours hidden by rounded 4h/day labels. | Resume day 20 initially loads day18; backward requests cover day11–18, day4–11, day1–4, then older hourly context. Separate first and subsequent HTF boundary cases prevent missing source hours. |

Additional coverage: initial-request coalescing, overlapping forward-request serialization, cross-instrument failure atomicity and retry, time bounds/deduplication/sorting, historical-hour no-lookahead, and concurrent history/forward response preservation.

Validation command from the snapshot:

```sh
node node_modules/vitest/vitest.mjs run tests/backtestCandleStore.test.ts tests/backtestReplayData.test.ts tests/chartReplay.test.ts tests/replayGoTo.test.ts --config /private/tmp/alphatrade-candle-review/vitest.config.mjs
```

Result: **4 files passed, 77 tests passed** (8 store + 11 navigation/coverage + 58 existing replay tests).

Browser QA entry: `tests/qa/backtest.html`, started with `node tests/qa/start.mjs`, http://127.0.0.1:4183/tests/qa/backtest.html. It uses the actual Workspace, chart, engine, market-data cache and aggregation. Candle transport and checkpoint persistence are in-memory fakes. CSP blocks external network connections; the server reads no project dotenv configuration. UI includes market/save failure injection, latency, fresh/resumed sessions, reopening the saved checkpoint, journal counts and runtime inspection. Browser results are recorded separately by the parent reviewer.

Backward selection also respects the latest child cursor whenever the execution ledger exists, preventing a parent-render delay from allowing rewind of account state.
