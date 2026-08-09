# Databento licensing confirmation — review draft

This is a local review draft only. Do not send it, modify the existing Gmail
thread, sign an agreement, or enable public display without explicit approval.

## Subject

Clarification: long-term GLBX.MDP3 storage and authenticated commercial access

## Reply body

Hello,

Thank you for confirming that delayed GLBX.MDP3 MNQ display (more than eight
hours after publication) can be enabled with an active Plus plan.

Before we build our historical-data ingestion layer, could you please confirm
the licensing scope for the following specific architecture?

AlphaTrade is a commercial trading-journal and deterministic backtesting
application with authenticated users and paid feature tiers. We would use
Databento as the upstream source for delayed historical MNQ and NQ OHLCV data,
but would not expose Databento credentials, raw API access, or a bulk-download
endpoint to users.

We need written confirmation of whether we may:

1. permanently retain delayed historical GLBX.MDP3 MNQ and NQ OHLCV bars on
   our own private Supabase infrastructure;
2. serve those derived OHLCV bars to authenticated users of the commercial
   AlphaTrade application, including users on paid tiers;
3. store the data as immutable compressed daily blocks and allow browser-side
   caching for charting and deterministic backtests;
4. use continuous symbols such as MNQ.v.0 and NQ.v.0 and derive higher
   timeframes from the licensed one-minute bars; and
5. retain the data for long-term historical backtests rather than only as a
   short-lived cache of individual Databento responses.

Could you also confirm whether the Plus plan and the more-than-eight-hour delay
are sufficient for this use case, or whether additional CME or Databento
redistribution agreements, reporting obligations, user classifications, fees,
display notices, attribution, or technical restrictions apply?

If any part of this architecture is not permitted, please identify the allowed
retention period and the exact boundary between permitted display caching and
redistribution/storage.

We will keep the ingestion layer and public/customer access disabled until the
licensing scope and required activation steps are confirmed in writing.

Kind regards,

Filip Krejca
AlphaTrade

