# Tradovate OAuth setup

OAuth registration alone does not start the copier. AlphaTrade uses a
server-side authorization-code callback so the client secret and broker tokens
never enter the Vite bundle, localStorage, logs, or copier snapshots.

## Registered callback

The OAuth registration must contain this exact redirect URI:

`https://alphatrade-mentor-15.vercel.app/oauth/tradovate/callback`

`vercel.json` rewrites that public path to the server function at
`/api/tradovate/oauth/callback`.

## Required server-only Vercel variables

- `TRADOVATE_CLIENT_ID`
- `TRADOVATE_CLIENT_SECRET`
- `TRADOVATE_REDIRECT_URI`
- `TRADOVATE_OAUTH_STATE_SECRET` — at least 32 random bytes
- `TRADOVATE_TOKEN_ENCRYPTION_KEY` — exactly 32 random bytes encoded as
  base64url or 64 hexadecimal characters
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Do not prefix broker or service-role secrets with `VITE_`. Do not paste their
values into source files, chat, screenshots, or deployment logs.

Generate the two random secrets locally and paste only their values directly
into Vercel's encrypted environment-variable UI:

```sh
openssl rand -base64 48
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

## Database gate

Migration `20260814172719_tradovate_oauth_connections.sql` creates the
server-only encrypted token store. Before applying it to hosted Supabase:

1. create and verify a current database backup/export;
2. obtain explicit approval for the production schema change;
3. apply the migration;
4. run Supabase security and performance advisors;
5. verify that `anon` and `authenticated` cannot select the table.

## Activation sequence

1. Deploy the callback and configure the server-only variables.
2. In LIVE → Connections, click **Připojit Tradovate**.
3. Authorize at Tradovate and return to AlphaTrade.
4. Run **Read-only test**. It may only call `account/list`, `position/list`, and
   `order/list`; it cannot place, modify, cancel, or flatten anything.
5. Keep the copier DISARMED and complete WebSocket/shadow conformance.
6. A minimal simulation order requires a new explicit approval immediately
   before the test.

OAuth completion is not evidence that every prop/evaluation account allows
automated copying. Account capability and prop-firm rules remain separate
gates.
