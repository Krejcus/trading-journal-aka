-- Dynamické hosty Tradovate (docs.ninjatrader.com/api/dynamic-api-hosts): prop organizace mají vlastní
-- demo hosty (Lucid: demo-api.lucid.ninjatrader.com). Hosty z poslední autentizace se ukládají k připojení.
-- Přídavný nullable sloupec: starý kód ho ignoruje, null = výchozí sdílené hosty. Práva ani RLS se nemění.
alter table public.tradovate_oauth_connections
  add column if not exists api_hosts jsonb;

comment on column public.tradovate_oauth_connections.api_hosts is
  'Hosty organizace z odpovědi Tradovate autentizace (apiHosts); jen povolené hostname, null = výchozí hosty.';
