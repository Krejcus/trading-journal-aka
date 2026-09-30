-- Krok 2/2 soukromých preferencí — AŽ po nasazení kódu, který čte přes
-- funkce z 20260930070000. profiles má SELECT policy `true` (vyhledávání
-- lidí, síť, sdílené obchody), takže co je vidět, rozhodují sloupcová práva.
-- Dosud anon i každý přihlášený četl `preferences` všech (železná pravidla,
-- emoce, business nastavení…) a anon i e-maily. Teď:
-- - preferences nikdo přímo (jen přes funkce),
-- - anon jen id, jméno, avatar (sdílené obchody); přihlášený navíc e-mail a
--   roli (vyhledávání přátel),
-- - anon nesmí do profiles zapisovat vůbec.
-- Řádkové politiky se nemění. Rollback: grant select on public.profiles to anon, authenticated;

revoke select on public.profiles from anon, authenticated;
grant select (id, full_name, avatar_url) on public.profiles to anon;
grant select (id, full_name, avatar_url, created_at, updated_at, email, role) on public.profiles to authenticated;
revoke insert, update, delete on public.profiles from anon;
