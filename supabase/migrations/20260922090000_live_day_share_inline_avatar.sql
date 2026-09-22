-- Avatar uživatele je v profilu uložený jako vložený `data:` obrázek, ne jako
-- odkaz. Původní strop 2 000 znaků ho nikdy nepustil dál, takže sdílená
-- stránka ukazovala jen iniciály — přestože v obrázkovém náhledu se fotka
-- vykreslila. Strop 64 000 znaků (~48 kB) pustí běžný avatar a zároveň
-- nepustí syrovou fotku z telefonu, která má megabajty.
alter table public.live_day_shares
  drop constraint live_day_shares_owner_avatar_url_check;

alter table public.live_day_shares
  add constraint live_day_shares_owner_avatar_url_check
  check (owner_avatar_url is null or char_length(owner_avatar_url) <= 64000);
