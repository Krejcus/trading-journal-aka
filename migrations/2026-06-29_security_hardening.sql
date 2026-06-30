-- ============================================================================
-- BEZPEČNOSTNÍ HARDENING — k ručnímu schválení a aplikaci (NEAPLIKOVÁNO automaticky)
-- ============================================================================
-- Vychází z auditu RLS na živé DB (projekt kopinlpdvjfgmvxydohk).
-- POZOR: aplikuj přes Supabase SQL editor / supabase-migrate skill, který hned
-- zkontroluje advisory. Žádný z těchto příkazů NEMAŽE data — mění jen politiky.
-- Před aplikací si ověř NÁZVY živých policies (mohou se lišit od těch v repu):
--   select policyname, cmd, roles, qual, with_check from pg_policies
--   where tablename in ('candle_cache','connections','profiles');
-- ============================================================================


-- ─── H1: candle_cache — zápis jen service_role (server) ──────────────────────
-- Problém: živě jsou policies "Authenticated can upsert/update candles" s
-- USING/WITH CHECK (true) → kterýkoli přihlášený uživatel může přepsat/smazat
-- cache svíček všem (otrávení grafů). Čtení (SELECT) necháváme veřejné.
-- (Uprav názvy dle skutečného pg_policies výpisu.)

ALTER TABLE public.candle_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can upsert candles" ON public.candle_cache;
DROP POLICY IF EXISTS "Authenticated can update candles" ON public.candle_cache;
DROP POLICY IF EXISTS "Anyone can manage candles" ON public.candle_cache;  -- pokud existuje z MASTER_CANDLE_SETUP

-- Čtení zůstává veřejné (svíčky nejsou citlivá data):
DROP POLICY IF EXISTS "Anyone can read candles" ON public.candle_cache;
CREATE POLICY "Public read candles" ON public.candle_cache
  FOR SELECT USING (true);

-- Zápis dělá výhradně server (service_role obchází RLS, takže žádná write policy
-- pro anon/authenticated není potřeba). Zruš případné GRANT INSERT/UPDATE/DELETE:
REVOKE INSERT, UPDATE, DELETE ON public.candle_cache FROM anon, authenticated;


-- ─── M5: connections — accept (status) smí měnit JEN příjemce ─────────────────
-- Problém: živá UPDATE policy "Users can update their connections" má
-- USING (auth.uid() = sender_id OR auth.uid() = receiver_id) → odesílatel si může
-- sám přepnout status='accepted' a získat přístup k cizím datům přes "Friends can
-- view" policies. Status na 'accepted' smí překlopit jen receiver.

DROP POLICY IF EXISTS "Users can update their connections" ON public.connections;

-- Příjemce smí měnit cokoli (accept/reject/permissions):
CREATE POLICY "Receiver can update connection" ON public.connections
  FOR UPDATE
  USING ((SELECT auth.uid()) = receiver_id)
  WITH CHECK ((SELECT auth.uid()) = receiver_id);

-- Odesílatel smí měnit svou žádost, ALE nesmí ji sám akceptovat. Pokud je v tabulce
-- sloupec status, omez ho ve WITH CHECK tak, aby sender nemohl nastavit 'accepted'.
-- (Když by app potřebovala, aby sender mohl jen rušit, použij rovnou DELETE policy.)
CREATE POLICY "Sender can update own request (not accept)" ON public.connections
  FOR UPDATE
  USING ((SELECT auth.uid()) = sender_id)
  WITH CHECK ((SELECT auth.uid()) = sender_id AND status <> 'accepted');


-- ─── H2: profiles — únik e-mailů + preferences pro anon (DOPORUČENÝ POSTUP) ───
-- Problém: živá policy "Profiles are searchable by anyone" má qual = true a roli
-- {public} (vč. anon). Tabulka profiles obsahuje email + preferences (JSONB s
-- pushSubscription, systemSettings, …). Kdokoli i nepřihlášený může přes PostgREST
-- stáhnout `select=email,preferences` všech uživatelů.
--
-- RLS je row-level, ne column-level → nelze "skrýt jen email". Dvě varianty:
--
--  VARIANTA A (rychlá, menší zásah): omez SELECT na authenticated a jen vlastní
--  + propojené uživatele; veřejné vyhledávání řeš přes SECURITY DEFINER RPC, které
--  vrací JEN id/full_name/avatar. Pozor: ověř, že feed/leaderboard/spectator čtou
--  profily ve scope, který tahle policy dovolí (jinak je přepiš na RPC).
--
--    DROP POLICY IF EXISTS "Profiles are searchable by anyone" ON public.profiles;
--    CREATE POLICY "Own or connected profile" ON public.profiles
--      FOR SELECT TO authenticated
--      USING (
--        (SELECT auth.uid()) = id
--        OR EXISTS (
--          SELECT 1 FROM public.connections c
--          WHERE c.status = 'accepted'
--            AND ((c.sender_id = (SELECT auth.uid()) AND c.receiver_id = profiles.id)
--              OR (c.receiver_id = (SELECT auth.uid()) AND c.sender_id = profiles.id))
--        )
--      );
--
--    -- Vyhledávání vrací jen nezbytné sloupce, bez emailu/preferences:
--    CREATE OR REPLACE FUNCTION public.search_profiles(q text)
--    RETURNS TABLE (id uuid, full_name text, avatar_url text)
--    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
--      SELECT id, full_name, avatar_url FROM public.profiles
--      WHERE full_name ILIKE '%' || q || '%' LIMIT 20;
--    $$;
--    -- + uprav storageService.searchUsers() na rpc('search_profiles').
--
--  VARIANTA B (čistší, větší zásah): přesuň citlivé sloupce (email, preferences,
--  pushSubscription) do tabulky profiles_private chráněné `auth.uid() = id`, a v
--  profiles nech jen veřejně nezbytné (id, full_name, avatar_url). Tím může public
--  SELECT zůstat, ale citlivá data jsou pryč.
--
-- => Doporučuji VARIANTU A jako první krok (zavře anon harvesting hned).
--    Aplikuj až po ověření, že žádný klientský dotaz nečte profily mimo dovolený scope.


-- ─── L2: CORS na edge funkcích (volitelné) ───────────────────────────────────
-- gemini-chat a další mají Access-Control-Allow-Origin: '*'. Funkce mají verify_jwt,
-- takže riziko nízké, ale ideálně omez origin na produkční doménu appky.
