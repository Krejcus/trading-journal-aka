-- 14. 10. 2026: návrat service_role na výchozí 8 s timeout API (authenticator)
-- po zrychlení deníku: čtení živého vstupu 30–130 ms na stránku, zápis okna
-- 0,16 s, přepočet celé historie Lucidu (594 pozic) 0,73 s, stránka denní
-- kontroly 1,0 s (měřeno v produkci v transakcích s návratem). Ruší
-- 20261014082500. Se souhlasem Filipa.

alter role service_role reset statement_timeout;
notify pgrst, 'reload config';
