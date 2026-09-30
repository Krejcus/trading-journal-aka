-- Krok 1/2 soukromých preferencí (jen přidává, nic nerozbije): funkce, přes
-- které appka čte preference bez přímého přístupu ke sloupci. Krok 2
-- (20260930071000) zavře sloupce až po nasazení kódu, který je používá.
-- Vlastní preference (a sledovaného v režimu diváka jen při přijatém
-- spojení) přes get_profile_preferences_v1; železná pravidla sledovaných pro
-- feed sítě přes get_followed_iron_rules_v1.

create or replace function public.get_profile_preferences_v1(p_user_id uuid default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select p.preferences from public.profiles p
  where p.id = coalesce(p_user_id, (select auth.uid()))
    and (p.id = (select auth.uid())
      or exists (select 1 from public.connections c
        where c.sender_id = (select auth.uid()) and c.receiver_id = p.id and c.status = 'accepted'))
$$;

create or replace function public.get_followed_iron_rules_v1(p_ids uuid[])
returns table(id uuid, iron_rules jsonb) language sql stable security definer set search_path = '' as $$
  select p.id, p.preferences -> 'ironRules'
  from public.profiles p
  where cardinality(p_ids) <= 500
    and p.id = any(p_ids)
    and (p.id = (select auth.uid())
      or exists (select 1 from public.connections c
        where c.sender_id = (select auth.uid()) and c.receiver_id = p.id and c.status = 'accepted'))
$$;

revoke all on function public.get_profile_preferences_v1(uuid) from public, anon;
revoke all on function public.get_followed_iron_rules_v1(uuid[]) from public, anon;
grant execute on function public.get_profile_preferences_v1(uuid) to authenticated;
grant execute on function public.get_followed_iron_rules_v1(uuid[]) to authenticated;
