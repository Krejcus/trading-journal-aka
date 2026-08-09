# Market data platform — Phase 2 gate

No ingestion, long-term storage, redistribution, Storage bucket, manifest migration,
or production Edge Function deployment may start until both gates below have
written evidence.

## Licensing evidence required

Ask Databento to confirm all of the following for `GLBX.MDP3`, MNQ and NQ:

1. AlphaTrade may retain delayed historical OHLCV permanently on its own
   Supabase infrastructure, rather than only caching provider responses.
2. AlphaTrade may serve those derived OHLCV bars to authenticated users of a
   commercial application with paid feature tiers.
3. The permission covers immutable daily binary blocks and client-side caching,
   while users receive no raw Databento API access or bulk-download endpoint.
4. Whether the active Plus plan and the more-than-eight-hour delay are sufficient,
   or whether CME/Databento redistribution agreements, reporting, fees, display
   notices, user classifications, or limits are additionally required.
5. Whether continuous symbols `MNQ.v.0` and `NQ.v.0`, derived higher timeframes,
   and long-term historical backtests remain within the same permission.

Record the complete written reply and the final signed entitlement terms. A
general statement that delayed public display is allowed is not enough evidence
for permanent storage and paid authenticated access.

## Backfill cost evidence required

Quote the exact full range before downloading records:

- dataset: `GLBX.MDP3`
- schema: `ohlcv-1m`
- symbols: `MNQ.v.0`, `NQ.v.0`
- `stype_in`: `continuous`
- range: exact five-year half-open UTC interval
- no record `limit`

Two supported cost-only implementations exist:

- local: `npm run market-data:estimate-cost -- --start YYYY-MM-DD --end YYYY-MM-DD`
- Edge Function: `market-data-cost`, restricted by
  `MARKET_DATA_COST_ADMIN_USER_IDS`

The Edge Function calls only `metadata.get_cost`, returns
`downloadedRecords: 0`, uses `Cache-Control: private, no-store`, and never returns
or logs `DATABENTO_API_KEY`.

Store the per-symbol quote, total estimate, range and timestamp as the Phase 2
approval evidence. The existing per-request `$1` guard does not approve the
aggregate backfill spend.

## Production gate

Before deploying `market-data-cost` or changing any Supabase secret/configuration:

1. create and verify a separate Supabase backup/export;
2. identify the exact authenticated AlphaTrade user UUID for the admin allowlist;
3. obtain explicit user approval for that deployment and secret change;
4. deploy only the cost-only function;
5. invoke once, record the quote, then decide whether Phase 3 is permitted.

Phase 3 remains blocked unless licensing is affirmative and the quoted total is
explicitly accepted.
