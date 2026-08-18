# Tradovate prop-account read model

`POST /api/tradovate/oauth/preflight` is an authenticated, non-cached, read-only snapshot. It reads the encrypted OAuth token server-side and never returns the token to the client.

## Returned data

For every visible Tradovate account the response contains:

- current cash, net liquidation, SOD values, open/realized/weekly P&L and margin fields from `cashBalance/getcashbalancesnapshot`;
- normalized risk values from `accountRiskStatus` and `userAccountAutoLiq` (disabled sentinel values are returned as `null`);
- full rows currently visible through `position/list`, `order/list`, `fill/list`, `fillPair/list` and `fillFee/list`;
- contract names resolved through `contract/items`;
- the account cash ledger from `cashBalanceLog/deps`;
- daily summaries grouped by Tradovate's `tradeDate`, not by the browser's calendar date;
- fill-pair segments correlated with gross `TradePaired` P&L and known fill fees.

Historical fills are associated with an account through both historical orders and the account cash ledger. This preserves fills whose original order is no longer present in `order/list`.

## Interpretation boundaries

- `daily[].reportedRealizedPnl` is the latest broker-reported `realizedPnL` for that trade date.
- `daily[].grossTradePnl` is the sum of `TradePaired` cash deltas.
- `daily[].feeDelta` is the signed sum of recognized fee cash deltas.
- `fillPairs[].netPnl` is only populated when both gross P&L and fee coverage are available.
- `history.realizedBalanceDrawdown` is a cash-ledger peak-to-trough calculation. It is not a prop firm's challenge trailing drawdown.
- `availability: partial`, `denied`, or `unavailable` must be shown as incomplete data rather than as zero.
- Lists contain the history visible to the OAuth token. The API response alone does not prove that a prop firm exposes every record since account creation.

## Deliberately excluded

- no market-data subscription, quotes, DOM or chart history;
- no writes, order placement, cancellation, risk-setting changes or demo-balance changes;
- no inferred Tradeify loss limits or challenge rules;
- no persistence/import into the AlphaTrade journal yet;
- no always-on WebSocket session yet.

## Persistent account profiles

`GET/PUT /api/tradovate/account-profiles` stores user-entered labels and prop-firm rules separately from OAuth credentials. Profiles are keyed by `user_id + provider + environment + external_account_id`, so reconnecting the same Tradovate account restores its metadata. Disconnecting OAuth deletes only the token row. A replacement challenge with a new Tradovate account ID starts with a new profile; the old profile is not silently reused.

The setup UI opens after a read-only snapshot detects an account without a profile. It supports common values for the whole connection and per-account overrides for display name, prop firm, plan, account type, account size, drawdown type, max/daily loss, consistency, profit target and mini/micro contract limits.

The migration is intentionally server-only: browser roles have no direct table grants. The API validates the caller's Supabase JWT, scopes every query to that user ID and uses the service role. Before applying the migration remotely, export/back up the hosted Supabase project and run the current security/performance advisors.

Official endpoint references:

- <https://partner.tradovate.com/api/rest-api-endpoints/accounting/get-cash-balance-snapshot>
- <https://partner.tradovate.com/api/rest-api-endpoints/accounting/cash-balance-log-dependents>
- <https://partner.tradovate.com/api/rest-api-endpoints/orders/fill-list>
- <https://partner.tradovate.com/api/rest-api-endpoints/orders/fill-fee-list>
- <https://partner.tradovate.com/api/rest-api-endpoints/positions/fill-pair-list>
- <https://partner.tradovate.com/api/rest-api-endpoints/positions/position-list>
