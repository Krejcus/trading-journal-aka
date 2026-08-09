# Market data Phase 2 — evidence ledger

Phase 3 is not authorized by this file. Every required item must contain direct
evidence, not an assumption or a general product statement.

## Licensing gate

- Status: **OPEN**
- Provider thread: existing Databento licensing thread
- Review draft: `docs/databento-market-data-license-draft.md`
- Required evidence:
  - permanent private retention: pending
  - authenticated commercial/paid-tier serving: pending
  - derived bars and browser cache: pending
  - continuous symbols and historical backtests: pending
  - additional CME/Databento terms, reporting and fees: pending
- Accepted by AlphaTrade: no

## Cost gate

- Status: **OPEN**
- Quote mechanism: `metadata.get_cost` only
- Dataset/schema: `GLBX.MDP3` / `ohlcv-1m`
- Symbols: `MNQ.v.0`, `NQ.v.0`
- Symbol type: `continuous`
- Range: `[2021-08-07T00:00:00.000Z, 2026-08-07T00:00:00.000Z)`
- MNQ quote: pending
- NQ quote: pending
- Total quote: pending
- Quote timestamp: pending
- Downloaded records: 0
- Accepted by AlphaTrade: no

## Production-change gate

- Separate Supabase backup/export created and verified: no
- Exact admin user UUID reviewed: pending
- Explicit approval to add the allowlist secret: no
- Explicit approval to deploy only `market-data-cost`: no
- Cost-only invocation evidence recorded: no

## Decision

Phase 3 remains blocked. It becomes eligible only after both licensing and cost
evidence are affirmative and explicitly accepted.
