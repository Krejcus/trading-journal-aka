-- 8. 10. 2026: get_dashboard_data_light_v1 trval v DB 1,7 s (klient 6,9 s, jednou
-- timeout 57014). 1,24 s z toho bral rekurzivní plpgsql průchod
-- strip_trade_private_note_fields_v1 přes každý klíč každého obchodu, přestože
-- po backfillu 5. 9. žádný obchod soukromé klíče neobsahuje (ověřeno na
-- produkci: 0 ze 4 469 řádků).
--
-- Rychlá cesta: jeden převod na text a test, zda se klíč vůbec vyskytuje.
-- Klíč v jsonb textu je vždy přesně "<klíč>", takže falešně negativní výsledek
-- nastat nemůže; falešně pozitivní (stejný text jako hodnota) jen spustí
-- původní rekurzi. Výstup je identický (ověřeno porovnáním celého výsledku RPC
-- na produkčních datech). Původní funkce zůstávají beze změny pro ostatní volající.

create or replace function public.strip_trade_private_note_fields_fast_v1(value jsonb) returns jsonb
language sql immutable security invoker set search_path = '' as $$
  select case
    when value is null then null
    when value::text !~ '"(notes|sessionPreNotes|sessionPostNotes|noteHistory|executionHistory)"' then value
    else public.strip_trade_private_note_fields_v1(value)
  end
$$;
revoke all on function public.strip_trade_private_note_fields_fast_v1(jsonb) from public, anon;
grant execute on function public.strip_trade_private_note_fields_fast_v1(jsonb) to authenticated;

create or replace function public.get_dashboard_data_light_v1()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; projected jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  result := public.get_dashboard_data_without_trade_notes_light_v1();
  select coalesce(jsonb_agg(jsonb_set(e.value,'{data}',
    public.strip_trade_private_note_fields_fast_v1(coalesce(e.value->'data','{}'::jsonb)) || public.trade_note_fields_v1(n.notes)
  ) order by e.ord),'[]'::jsonb) into projected
  from jsonb_array_elements(coalesce(result->'trades','[]'::jsonb)) with ordinality e(value,ord)
  left join public.trade_private_notes n on n.trade_id::text=e.value->>'id' and n.user_id=auth.uid();
  return jsonb_set(result,'{trades}',projected);
end; $$;
revoke all on function public.get_dashboard_data_light_v1() from public, anon;
grant execute on function public.get_dashboard_data_light_v1() to authenticated;
