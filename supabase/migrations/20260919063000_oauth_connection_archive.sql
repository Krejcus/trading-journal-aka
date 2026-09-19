-- 19. 9. 2026: odpojené Tradovate připojení se nemaže (deník, journal evidence
-- a spárovaná zařízení nesou jeho ID), ale uživatel ho může skrýt z přehledu.
alter table public.tradovate_oauth_connections
  add column if not exists archived_at timestamptz null;
comment on column public.tradovate_oauth_connections.archived_at is
  'Uživatel připojení skryl z přehledu; řádek zůstává kvůli historii. Jen odpojené připojení.';
