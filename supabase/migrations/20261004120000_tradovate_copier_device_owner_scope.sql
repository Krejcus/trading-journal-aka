-- Jeden spárovaný Mac worker pro všechny propfirmy vlastníka (4. 10. 2026).
-- Výchozí scope zůstává 'connection' (lease jen pro připojení, se kterým byl
-- Mac spárován). Scope 'owner' nastaví až výslovný souhlas uživatele v LIVE;
-- pak smí zařízení brát krátké lease i pro další připojená demo připojení
-- svého vlastníka, aby nová propfirma nepotřebovala CLI ani reinstall.

alter table public.tradovate_copier_devices
  add column if not exists scope text not null default 'connection'
    check (scope in ('connection', 'owner')),
  add column if not exists owner_scope_granted_at timestamptz;

comment on column public.tradovate_copier_devices.scope is
  'connection = lease jen pro connection_id; owner = lease pro všechna připojená demo OAuth připojení vlastníka (výslovný souhlas v LIVE).';
