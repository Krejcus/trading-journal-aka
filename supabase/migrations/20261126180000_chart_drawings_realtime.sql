-- Kresby v grafech: okamžité oznámení změny na ostatní zařízení (Realtime).
--
-- Dosud se druhé zařízení ptalo serveru jen jednou za minutu (a při návratu do
-- appky), takže kresba z telefonu dorazila na PC až za desítky vteřin. Tabulka
-- se přidává do publikace supabase_realtime; RLS (jen vlastní řádky) platí i pro
-- oznámení. Data ani schéma tabulky se nemění. Nikdy neautorizuje copier.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  -- Opakovatelné: tabulka už v publikaci nevadí.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chart_drawings'
  ) then
    alter publication supabase_realtime add table public.chart_drawings;
  end if;
end;
$$;
