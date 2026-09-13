# Fáze 27 — omezené serverové čtení obchodů

Lokální pracovní kopie `/private/tmp/alphatrade-history-20260912`, základ `e61ab59a`.
Dokončeno lokálně 13. 9. 2026; migrace vytvořena CLI 12. 9. před přerušením turnu.

## Výsledek a důvod

Read-only kontrola skutečného produkčního katalogu 12. 9. ukázala pravidlo `Trades visibility`: vlastník, veřejný obchod nebo libovolná strana accepted connection může číst celý řádek. Nejde o staré jméno Followers can view trades z lokálního SQL souboru. Guard `guard_connection_owner_consent_v1` v produkci již chrání pending request a dovoluje přijmout/změnit oprávnění pouze příjemci; nebylo nutné tuto část přepisovat.

Osmá lokální migrace `20260912193935_journal_shared_read_boundary.sql` přidává restrictive SELECT pravidlo pro nové journal kořenové záznamy. Skládá se s existujícími permissive pravidly a nenechá je obejít omezení přes is_public ani opačný směr spojení. Přímo je čte pouze vlastník; úzké veřejné odkazy nadále obsluhuje existující get_public_trade. RLS je v migraci výslovně zapnuté.

Nové read_shared_trades_v1 vrací výhradně vyjmenovaná pole. Veřejný wrapper je security invoker; nutné privilegované čtení je v odděleném journal_private schématu, s prázdným search_path, bez EXECUTE pro PUBLIC/anon a s kontrolou auth.uid() na každém volání. Klientské argumenty nemohou zadat oprávnění ani identitu diváka. Accepted connection musí mít správný směr divák → vlastník a nesmí být nejednoznačná. Malformované omezení account IDs selže uzavřeně.

USD vrací vlastní současné výsledky; R se počítá jen z platného známého počátečního rizika ručního obchodu. Journal R je nadále neznámé. R-only/hidden výstup neobsahuje dolarové P&L, ceny, počet kontraktů, SL/TP ani další původní finanční JSON. Obrázky jsou vrácené pouze při vlastním oprávnění a pouze jako řetězce. Soukromé poznámky a execution evidence v tomto RPC nejsou; stávající samostatný note-consent RPC je nadále načítá podle svého souhlasu. Vnořený arbitrary JSON se nepřenáší.

Feed nyní načítá stránku i úplné skupiny přes nové RPC, respektuje jednotku vrácenou spolu s daty a nic nepřepočítává podruhé. Nepoužívá fallback na raw trades/confirmed_journal_trades. Názvy účtů přicházejí spolu s povoleným řádkem. Typ sdíleného člena připouští skutečně chybějící pole, nevyrábí povinné nulové metriky.

## Ověření

- 16 cílených testů nové RPC klientské cesty, skutečné storage metody a skupin; zákaz raw fallbacku, unit, account filtr, revokace, neúplná odpověď a session změna.
- Kompletní regrese: 374 souborů / 3 449 testů prošlo. TypeScript, Vite/PWA build (90 precache položek), scoped lint (0 chyb, jedno starší varování storageService) a git diff --check prošly. Oba SQL verifikátory s --no-ignore bez chyb/varování.
- Skutečná nová SQL migrace v PGlite: produkční tvar Trades visibility, zákaz raw journal SELECT i při is_public, směr a účet, hidden/R/obrázky, canary pro soukromé/vnořené údaje, známé ruční −1,5R, anonymní/nesprávný vstup, duplicitní consent, pending/invalidace/obnova, vlastník a veřejný odkaz. SQL výstup prošel i skutečným klientským readSharedTradePage adaptérem.
- Celý SQL harness dále pokrývá import/hydrataci, opravy/review, rollback, owner izolaci a 2 400 epizod přes 12 účtů. Nová migrace se pro tyto sdílené testy aplikuje v oddělené lokální transakci a po testu rollbackne; nepřepisuje vzdálené prostředí.
- Logy `/private/tmp/journal-phase27-{tests,full-tests,types,lint,script-lint,sql,build}.log`. Browser nebyl v této fázi znovu použit; poslední vizuální ověření skutečného feedu/selectoru je fáze 26. Hosted PostgREST/JWT není ověřeno simulací rolí.
- Dokumentace: https://supabase.com/docs/guides/database/postgres/row-level-security a https://supabase.com/docs/guides/database/functions .

## Aktivační vazby a zbývající práce

Tuto migraci je nutné aktivovat společně s klientem RPC. Starý klient po omezení přímého čtení nové cizí journal řádky neuvidí; nový klient bez nasazeného RPC zobrazí chybu, nepoužije nebezpečný fallback. Ještě zbývá přepojit spectator historii a žebříček, aby po restrictive pravidle neztratily potvrzené journal řádky. Čtení notes má svůj samostatný již existující consent protokol.

Tato fáze nemění starší raw sdílení ručních obchodů ani RLS příprav/review/účtů. Není to tvrzení, že celá sociální část aplikace má hotový bezpečnostní audit. Pro novou journal historii je nyní připravený serverový limit údajů; zbytek klientských cest se musí dopojit před aktivací.

Zůstává dokončení spectator/žebříčku, limitů velké projekce, přihlášeného raw-to-UI toku a broker conformance. Vzdálená migrace, deploy ani restart/reinstalace workeru či broker akce nebyly provedené. Před vzdálenou aktivací patří samostatný export/záloha a schválení podle AGENTS.md; advisors a skutečný JWT/RPC test až nad schváleným prostředím. Celkový cíl není hotový.
