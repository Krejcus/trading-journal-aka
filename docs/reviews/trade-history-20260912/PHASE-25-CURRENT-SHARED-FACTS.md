# Fáze 25 — aktuální finanční fakta a neznámé R

Lokální pracovní kopie `/private/tmp/alphatrade-history-20260912`, základ `e61ab59a`.

## Výsledek

Nová sedmá migrace `20260912190422_journal_confirmed_root_projection.sql` udržuje aktuální finanční fakta a databází spravovaný stav na kořenovém obchodu ve stejné transakci jako soukromou projekci. Dosavadní security-invoker pohled spojoval obchody s owner-only tabulkou pozic; povolený sledující proto nové journal řádky neviděl. Pohled nyní používá potvrzený stav na kořenovém řádku a zachovává jeho RLS. Soukromá evidence ani execution historie se sledujícím nezpřístupňují.

Pozdní poplatek aktualizuje P&L včetně JSON faktů. Chybějící nové SL/risk odstraní starou hodnotu. Poznámky, screenshoty a ostatní review pole zůstávají. Pending/invalidované/smazané pozice vypadnou z potvrzeného pohledu. Klient nemůže vyrobit potvrzovací stav ani jej přenést na jiné ID/účet. Aktualizace nevytváří zpět smazaný obchod.

Sdílený feed zachovává znaménko a centy, používá jednotku zdroje i po rozkliknutí a neznámé riziko journal obchodu zobrazuje neutrální pomlčkou. Starý dodatečný SL/risk neprokazuje počáteční riziko. Chybějící P&L nemá výchozí hodnotu 0. Dva původně bílé popisky ve světlém detailu nyní používají stejnou podmíněnou barvu jako sousední údaje.

## Ověření

- Kompletní Vitest: 371 souborů / 3 433 testů prošlo. Po závěrečném formátovacím fallbacku a opravě dvou CSS tříd prošlo dalších 18 cílených testů.
- TypeScript, Vite/PWA build (90 precache položek) a `git diff --check` prošly. Scoped lint: 0 chyb, 15 existujících varování; oba SQL ověřovací skripty zvlášť s `--no-ignore` bez chyb/varování.
- PGlite nad skutečnými migračními SQL: follower RLS z existujícího projektu, odvolání spojení, soukromá evidence nedostupná, aktuální root fakta po opravě, pending/invalidace/delete, ochrana identity a odmítnutí podvrženého stavu.
- Kompletní lokální raw → import → SQL → owner hydration a public RPC test prošel; staging 2 400 epizod přes 12 účtů, přerušení/obnovení, atomická oprava posledního člena, pozdní poplatek, uchování review, rollback a izolace vlastníků.
- Browser: skutečný NetworkHub s fiktivním storage adaptérem na dočasném portu 4190, styly z aktuálního buildu aplikace. USD karta i detail zobrazily −27,52 USD; journal R karta/detail a realizované RRR zobrazily pomlčku. Screenshot potvrdil čitelnost opraveného světlého detailu. Testovací tab uzavřen; hlavní náhled 4189 zachován.
- Logy `/private/tmp/journal-phase25-{tests,final-tests,types,lint,script-lint,sql,build}.log`. Dočasný browser fixture `/private/tmp/journal-network-check` není produkční kód.

## Přesné hranice a zbývající práce

Toto není hotové oprávněními omezené serverové DTO. Starší root RLS používá accepted connection oběma směry; jemnější account/P&L/media oprávnění dosud aplikuje klient. Tato migrace tuto existující politiku nerozšiřuje, ale ani neopravuje. Před aktivací je nutné dokončit serverově vynucený sdílený přístup. Spectator cesta stále filtruje nové journal řádky v owner hydrátoru a feed má staré heuristické seskupování podle dne/instrumentu/směru. Nelze jej vydávat za hotový přehled skutečných kopií. Oprava seskupování hlavní vlastní historie z předchozích fází se tím neruší.

Zůstávají také ověření limitů velké projekce, přihlášený skutečný raw-to-UI tok a broker conformance. Lokální SQL se simulovanými rolemi není ověření hostovaného PostgREST/JWT. Migrace nebyla vzdáleně aplikovaná; Supabase advisors se mají spustit v rámci schválené aktivace po záloze. Žádný commit/push, deploy, vzdálená migrace, restart/reinstalace workeru ani broker akce. Celkový cíl zůstává rozpracovaný.
