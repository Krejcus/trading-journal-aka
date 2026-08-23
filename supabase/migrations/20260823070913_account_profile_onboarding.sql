-- F4: explicitní potvrzení nových Tradovate profilů v dávkovém onboardingu.
-- Připraveno pouze jako soubor; před aplikací je nutný export/záloha a advisory.

begin;

alter table public.tradovate_account_profiles
  add column onboarded_at timestamptz null;

-- Profily, které existovaly před zavedením onboardingu, jsou už považované za
-- zkontrolované. Nové řádky dál dostanou výchozí NULL a objeví se v nové sekci.
update public.tradovate_account_profiles
set onboarded_at = now()
where onboarded_at is null;

-- Žádné granty pro `authenticated`: browser tuhle tabulku nikdy nečte ani
-- nezapisuje přímo (viz 20260815040436 — `revoke all ... from authenticated`).
-- Onboarding jede stejnou cestou jako zbytek profilu: Vercel funkce ověří JWT,
-- scopuje dotaz na user_id a píše service_role klíčem.

comment on column public.tradovate_account_profiles.onboarded_at is
  'Čas explicitního potvrzení profilu uživatelem; NULL znamená nový účet ke kontrole.';

commit;
