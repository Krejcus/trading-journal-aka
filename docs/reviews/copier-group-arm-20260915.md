# Group ARM risk floor and execution connection precheck — 2026-09-15

## Confirmed cause

The active worker retained Hlavní with a one-minute entry cooldown and a nonzero
sessionArmedAt. The saved FundedNext group had the default zero-minute cooldown.
ARM sends the entire target configuration. Both the relay and worker therefore
correctly rejected the weaker value, even though the user only intended to switch
groups. The relay returned `tighten-only`; direct loopback returned the exact
field. The UI presented both as an unknown outcome.

## Change

Before ARM, prepare the requested group against the latest received worker state.
Retain stronger session-wide settings without weakening any target setting.
Use the existing risk comparator for a final check against BOTH inputs. Conflicting
windows and account-specific risk differences remain explicit blockers; never
invent an account loss limit. Risk editing still follows the existing strict
validation. The relay/worker checks are unchanged and reject a race with another
client's stricter configuration. No additional network round trip on healthy ARM.

Preparation is repeated after a possible screenshot-repair dialog. Check loaded,
paired worker devices against unambiguous OAuth account ownership before offering
that dialog. OAuth Connected alone is insufficient. Skip disabled or explicitly
excluded followers, but never skip leader ownership. Known local prechecks and the
two specific risk-rejection formats show a blocked result. Timeouts/network errors
remain unknown and are never automatically retried.

## FundedNext activation still requires operator-approved enrollment

Read-only local status confirmed two paired routes (Lucid and Tradeify) and no
FundedNext route. The worker was DISARMED, connected and reconciled, with no stuck
operations in its current group. This does not establish the state of FN accounts
outside the installed routes.

Deployment plan: approve the scoped web push; back up the installed manifest,
LaunchAgent and durable copier state locally before any configuration change;
create a separate revocable FN worker identity and pair it through the existing
authenticated AlphaTrade flow. Add ONLY the FN connection and its five confirmed
account IDs, preserving the primary connection, existing routes and current group.
Verify FN positions and working orders with read-only broker evidence. If any
position/order or unknown state exists, stop before restarting. Reload the existing
worker bundle only after the complete safe-state check, then verify all three
routes, durable rules and DISARMED state again. Never ARM/Flatten or test with a
real order as part of this release. The current runtime still supports one active
execution group; this patch does not introduce simultaneous group execution.

## Verification

- 129 tests across ARM preparation, risk comparator, relay and local agent passed.
- Worker regression accepts the prepared 1-minute cross-group ARM with mocked
  execution, and rejects a stale prepared payload after the floor rises to 2 minutes.
- Typecheck and scoped ESLint passed; production build checked separately.
- Actual overview component exercised with an isolated mock callback in dark and
  light themes. Known rejection shows a blocked result and leaves the switch off.
- Temporary fixture and dev server removed before release.
- No production settings, pairing, runtime restart or broker action performed.
