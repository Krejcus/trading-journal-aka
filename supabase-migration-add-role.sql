-- Migrace: přidat role do profiles tabulky
-- Spusť v Supabase Dashboard → SQL Editor

-- 1) Přidat sloupec role (additive — nic se nerozbije)
alter table profiles
add column if not exists role text default 'user';

-- 2) Constraint na povolené hodnoty
alter table profiles
drop constraint if exists profiles_role_check;

alter table profiles
add constraint profiles_role_check
check (role in ('owner', 'friend', 'user'));

-- 3) Nastavit svoji roli na 'owner'
--    Najdi své user_id v Supabase Dashboard → Authentication → Users
update profiles set role = 'owner'
where id = 'TVOJE_USER_ID_SEM';

-- 4) Nastavit kamarádovi roli 'friend' (až se zaregistruje)
-- update profiles set role = 'friend'
-- where id = 'KAMARADOVO_USER_ID_SEM';

-- Verifikace:
select id, full_name, role from profiles;
