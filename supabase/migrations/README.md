# Canonical Supabase migrations

Only timestamped migrations generated with `supabase migration new <name>` belong here.

The SQL files in `/migrations` are a legacy archive and must not be replayed automatically:
they contain historical setup, fix and revert scripts whose final production state is unknown.
Before the next schema change, link the intended Supabase project, pull its current schema as a
baseline, review the security/performance advisors, and then add new forward-only migrations here.

Never copy `MASTER_*`, `FIX_*` or `REVERT_*` files into this directory without reconciling them
against the live schema.
