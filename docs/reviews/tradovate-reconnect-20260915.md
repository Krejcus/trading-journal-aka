# Tradovate reconnect — 15. 9. 2026

## Verified incident evidence (read-only)

- Both Tradeify profiles remain stored and active in AlphaTrade, and remain in the saved Hlavní group. Missing current OAuth data is not evidence of deleted broker accounts.
- The Tradeify connection's last persisted refresh was 17:47:19 Prague time; stored access expiry was 19:07:19. Production OAuth refresh requests returned `Invalid token`. These failures also occurred before access expiry, so access-token expiry alone is not the explanation.
- Around 17:46–17:47 production also logged database/schema-cache failures while resolving device authentication. A narrower log search found no `token refresh save failed` record. This does not prove that a response was never lost or that every write succeeded.
- At 19:21 the worker logged heartbeat timeouts; repeated reconnect/lease failures followed. At the read-only inspection it reported DISARMED, disconnected and reconciliation required. Historical flat state was not treated as current broker proof.
- The new FundedNext OAuth connection was absent from the installed connection manifest; integration with that worker is a separate issue, not repaired here.

## What can and cannot be concluded

Confirmed: Tradovate rejected the refresh grant; the browser lost this diagnosis because read endpoints returned a generic 502. The Connections badge represented saved credentials rather than successful broker reads.

Exact reason for token invalidation is not recoverable from the present evidence. Candidate mechanisms are refresh-token expiry/revocation and concurrent rotation with a lost or unsuccessful persistence step. The store uses a conditional write and rereads on rejection, but has no cross-instance refresh mutex. This is a code-level risk, not proof it caused this incident. No broker requests were made to try consuming or reproducing the rejected token.

The [official OAuth endpoint schema](https://partner.tradovate.com/api/rest-api-endpoints/authentication/o-auth-token) includes `refresh_token_expires_in` independently of access lifetime. Its example is 14 days, not a guaranteed lifetime for this connection. AlphaTrade previously discarded this field. The connection was authorized on August 31; that timing alone does not establish when a later rotated token expires. The [NinjaTrader partner guide](https://partner.ninjatrader.com/connect/overview/partner-integration/partner-token) describes rotating single-use refresh tokens for partner sessions; applying all of those partner-specific rules to this authorization-code connection requires confirmation from Tradovate.

## Local correction

- Definitive refresh rejection is mapped to `tradovate-reauthorization-required` only after checking for credentials saved by a concurrent request. Network, DB, rate-limit, app-session and ambiguous failures remain distinct.
- Per-connection read evidence drives `Obnov přihlášení` and a scoped Reconnect button, plus an explanatory banner in every LIVE tab. A timeout shows `Data nedostupná`; saved credentials alone no longer produce green `Connected`.
- Connection-health state is owner-scoped, retains the reconnect remedy through transient failures, rejects older results, and recovers after a newer successful read. No account deletion, group mutation or automatic copier ARM.
- Safe refresh telemetry includes attempt ID, connection ID, credential revision, start/exchange failure/save conflict/save failure/success phases and broker refresh expiry when supplied. Never logs tokens, client secrets or request bodies.
- Actual reconnect remains user initiated and keeps the existing connection ID.

Validation: 53 tests in 9 files passed; TypeScript passed; production build passed; scoped lint has zero errors (existing warnings remain); isolated browser fixture using the actual Connections component and reconnect notice verified in light/dark appearance, with a mock click confirming the connection target. Deployment and real reauthorization have not been performed.
