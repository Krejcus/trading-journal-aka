# Fáze 20 — dostupnost podkladů historie

Lokální implementace v izolované pracovní kopii. Žádná vzdálená migrace, nasazení, broker požadavek ani změna běžícího workeru.

## Chování

Historie a LIVE mají sbalený přehled „Podklady historie“. Jeden blok patří připojení, nikoliv každému účtu. Aktuální a archivované účty se deduplikují podle identity; 12 účtů společného připojení nezakládá 12 dotazů. Počet propojených účtů popisuje rozsah připojení, není počtem provedených kopií. Přehled se vztahuje ke společnému připojení, nikoliv ke konkrétnímu filtrovanému obchodu či období.

Deset zdrojů rozlišuje načtený seznam, načtenou dávku, chybu a chybějící záznam. Starší metadata bez popisu rozsahu mají „Načteno · rozsah neurčen“. Uvádí poslední čas čtení, počet nalezených a nově uložených položek a u dávek počty známých odkazů. Zbylé odkazy jsou zbývající část konkrétního průchodu, nikoliv počet chybějících obchodů. Úspěšný seznam není důkaz neomezené retence. Chybějící metadata dodatečného čtení nevylučují existenci průběžně zachycených událostí.

Čtení začíná až po rozbalení, změně připojení nebo ruční obnově. Obnova čte uložený přehled; nespouští broker dotaz ani finanční import. Zpracování každé další importní dávky přehled znovu nestahuje. Chyba nenahrazuje nejistotu starým úspěšným výsledkem. Přihlášení je hlídané před prvním čekáním i po každé dávce a dokončení; změna vlastníka či zrušení načítání zahodí výsledek. Chybějící či duplicitní části odpovědi se odmítnou jako celek.

## Uložení a oprávnění

Verzovaná lokální migrace `20260912174837_journal_source_status.sql` přidává částečný index a stabilní read-only RPC. Index vybírá poslední journalbackfill podle času zaznamenání, pak ingest ID; starší úspěch nahraný později nezakryje novější zaznamenanou chybu. Časy jsou záznamem čtení, nikoliv časem broker exekuce. Finanční kompakce ani P&L se nemění.

RPC je SECURITY INVOKER s pevným search_path a je spustitelné pouze serverovou service_role. API `/api/tradovate/oauth/journal-sources` ověří Supabase JWT a předá výhradně jeho vlastníka; klient může dodat jen seznam připojení. Funkce kontroluje vlastnictví všech požadovaných připojení. Neshoda odmítne celou dávku. Klient ani anon nedostávají přístup k registru OAuth či k této RPC. Návrat obsahuje pouze vybraná metadata čtení, nikoliv OAuth údaje ani libovolný obsah raw evidence.

Při review první verze se ukázalo, že owner RPC nemůže přímo číst server-only registr OAuth. Původní lokální testovací schéma dávalo tomuto registru nepřesné owner SELECT oprávnění. Finální řešení i SQL test zachovávají skutečný zákaz browser přístupu a používají ověřenou serverovou cestu; oprávnění registru se nerozšiřují.

Nejvýše 25 připojení na serverový požadavek a 250 na klientský průchod; deset zdrojů každého připojení je uvnitř jednoho JSON výsledku, takže je neodřízne limit počtu řádků API. Server a jednotlivé dotazy mají 20s deadline, celý klientský průchod 60s. Neplatné počty, chybějící části, obrácené časy a pozorování více než pět minut v budoucnosti znamenají neověřitelný přehled. Nejde o indikátor aktuálního zdraví workeru.

Zkontrolován veřejný [Supabase changelog](https://supabase.com/changelog) a [dokumentace database functions](https://supabase.com/docs/guides/database/functions). Pro návrh použita již instalovaná CLI 2.116.0 a `migration new`; nové závislosti se neinstalovaly. Bez vzdálené změny nejsou tvrzené hosted advisors ani produkční PostgREST ověření. Před nasazením platí samostatná záloha/export, schválení migrací a security/performance advisors podle AGENTS.md.

## Ověření

44 testů v sedmi souborech prošlo: sdílení připojení, 26 připojení ve dvou dávkách, neúplné odpovědi, neplatné počty a časy, odhlášení/abort, API autentizace, odmítnutí klientem dodané identity, chybové odpovědi a související načítání detailů/import. Test runner upozornil na chybějící existující `typescript.js.map` ve sdílených závislostech; všechny testy a proces skončily úspěšně.

Samostatný PGlite harness vykonal skutečnou migraci a SQL dotazy: dva vlastníci, DEMO/LIVE, pozdě dodaný starší úspěch, novější chyba, chybějící zdroj, špatné prostředí, neznámý typ, omezená dávka a whitelist výstupu. Ověřil zamítnutí RPC pro anon i authenticated, zákaz browser čtení OAuth registru, service_role execution, SECURITY INVOKER/stable/search_path a přijetí pouze přesných vlastnických scope. Test je lokální; nesimuluje skutečné přihlášení, hosted PostgREST ani Storage.

TypeScript prošel. Scoped ESLint má 0 chyb; 21 existujících warningů v App/storage, nové a upravené samostatné soubory jsou bez warningů. Vite/PWA build prošel, 90 precache entries. Diff check čistý. Browser ověřil skutečnou komponentu na 12 fiktivních účtech, rozbalení, všechny čtyři stavy a odstranění předchozího přehledu při chybě. Světlý a tmavý vzhled používají aktuální tokeny AlphaTrade; v tmavém byly popisky upravené na text-secondary kvůli čitelnosti. Canonical LIVE obrazovka sloužila jen jako vizuální reference.

## Další práce

Zůstávají hranice velké finanční projekce, přesná geometrie position boxů při chybějících svíčkách, R ve statistikách a neveřejné social projekce, skutečné owner raw-to-UI E2E a závěrečný audit. Současná karta zviditelňuje dostupnost posledních zaznamenaných čtení, ne úplné časové pokrytí celé historie. Nasazení, vzdálené migrace a worker/broker ověření se touto fází neprovedly. Celkový cíl zůstává aktivní.
