# Jednotné načítání obchodů a potvrzené statistiky

12. září 2026. Lokální pokračování PHASE-4-PERSISTENCE.md. Předchozí krok byl konkrétní pokrok (atomický import + SQL ověření), nikoli čekání nebo blokace. Celý cíl stále není hotový a import se z App ještě nespouští.

## Zapojené čtečky

- `storageService.getDashboardData`, `getTrades`, `getTradeById` a úplný `getTradesWithDataByAccounts` nyní načítají soukromá broker fakta. Seznam žádá pouze lehké údaje; detail a úplný export dostanou také vlastní historii plnění a SL/TP.
- `journalTradeHydration` váže všechny dotazy na vlastníka, stránkuje ID po 100 a kontroluje hlavičku projekce před i po načtení. Nová generace hlavičky se změní i při přepočtu stejného evidence cursoru po změně vazby účtu. Smíchané revize, chybějící člen, chybný potvrzený záznam, chybějící tabulka, přerušení nebo logout způsobí chybu, nikoli částečný potvrzený součet.
- Pending/invalidated záznamy nevstupují do potvrzené kolekce. Ruční review zůstává v DB. **Samostatný přehled těchto záznamů v UI ještě chybí**; před spuštěním automatického importu musí být přidaný.
- `getTrades` při neúspěšném serverovém načtení nesmí vydat dřívější cache broker obchodů za úspěšný čerstvý výsledek. Úvodní cache dashboardu nadále představuje poslední známý snímek; existující App při neúspěšném refreshi označí jeho offline/stale čas. To není důkaz aktuálního broker stavu.
- Běžné uložení a veřejné sdílení rekurzivně odstraňuje `executionHistory` ze sdíleného JSON. Vlastník ji dostane z owner-only tabulky při otevření detailu. Soukromé poznámky mají nadále svou samostatnou cestu.

## Serverové statistiky a veřejný odkaz

- Třetí lokální migrace nyní obsahuje `confirmed_journal_trades`, read-only view se `security_invoker=true`. Pro doložený broker záznam používá aktuální povolená fakta, zachovává review, nezveřejňuje soukromý execution ledger a vylučuje pending/invalidated či nesprávně přiřazené pozice. Běžné manuální a backtest záznamy zachovává.
- Serverové denní/týdenní přehledy, debrief, ranní texty, nová-trade notifikace, embedding backfill, feed a žebříček byly přepojené na tento pohled. Původní kořenové P&L invalidovaného review zůstává poslední známé, ale tyto čtečky je již nepočítají.
- Stávající omezená funkce `get_public_trade` zachovává původní nezbytný SECURITY DEFINER přístup pro anonymní veřejný odkaz, explicitní `is_public=true` a samostatný souhlas `share_notes`. Čte potvrzený pohled. Soukromý broker ledger se odstraňuje spolu s privátní historií poznámek. OG route používá stejný RPC místo pokusu anonymně číst soukromý pohled.
- Sociální `getTrades(targetUserId)` zatím nové broker řádky bez ověření soukromé projekce vynechá. Explicitně veřejný odkaz funguje přes omezený RPC; plné zobrazení neveřejné historie u povolených kontaktů potřebuje samostatnou serverovou projekci respektující existující connection permissions. Před vydáním nesmí být tato mez zaměněná za úplný sociální přehled.

## Doložené ověření tohoto kroku

- Cílené testy načítání, exportů, přepnutí uživatele a soukromí: 62 testů v 5 souborech prošlo.
- Izolovaný `verify-journal-positions.ts` spustil skutečné tři migrace a skutečné dřívější SQL privacy helpery. Skutečné Supabase query builder dotazy obsloužil lokální PGlite adaptér bez síťového přístupu. Ověřeny vlastní detaily 12 účtů, aktuální root i JSON P&L ve view, vynechání invalidovaných výsledků, RLS view, anonymní public RPC, skryté poznámky, explicitně sdílené poznámky a odmítnutí neveřejného/invalidovaného obchodu.
- V tomto prostředí chybí sourcemap distribuovaného TypeScript balíčku; Vitest vypsal warning, cílené testy přesto prošly. Aplikační závislosti nebyly změněné. PGlite stále není produkční ověření více souběžných Postgres sessions.
- Společná regresní kontrola: 167 testů ve 23 souborech prošlo. Scoped TypeScript bez chyb, ESLint bez chyb (jeden dřívější warning nepoužitého `skipped` v migraci screenshotů). Závěrečný Vite/PWA build prošel: 3 473 modulů, 4m44s, service worker a 85 precache položek. Existující upozornění na chunky nad 500 kB zůstává. Nejde o nasazení ani ověření vzdáleného broker spojení.

## Zbývá před aktivací

1. Viditelný přehled otevřených/neúplných/invalidovaných pozic, dostupné review a napojení nové synchronizace v App a LIVE. Nevracet starší nepotvrzené numerické výsledky do statistik přes lokální merge.
2. Bezpečná náhrada legacy importu: doložené historické přiřazení a odstranění duplicit vůči nové evidenci se zachováním screenshotů a poznámek. Aktuální leader a multiplikátor nejsou historický důkaz.
3. Úplný analytický sběr, počáteční flat pro dosud neviděný instrument, inkrementální/rozdělený dlouhodobý import, box přes mezery svíček a náhled od raw evidence po UI.
4. Ověřit samostatné Deno/serverové přehledy v koordinovaném prostředí a dokončit povolené sociální čtení. Změna názvu čtené relation není důkaz doručené push notifikace nebo hotové edge funkce.
5. Produkce zůstala beze změny. Před aktivací jsou nutné kontroly všech závislých migrací (včetně stávající privacy infrastruktury), upozornění a návrh samostatné vzdálené zálohy/exportu podle AGENTS.md, koordinované nasazení a skutečné advisors/DEMO ověření. Souhlas s přenosem evidence není souhlas s deployem nebo restartem workeru.

## Konkrétní podklad pro další krok

Aktuální `copierRuntimeController.ts` při úplném uzavření zapisuje `closedTrade.id = fill.fillId`; `tradovateBroker.ts` dává `fillId = String(fill.id)`. Relay ukládá tuto identitu jako `tradovate_copier_trades.trade_id` spolu s `connection_id`. Legacy journal používá `copierTradeId = copier-<trade_id>` a případně `copierEpisodeId`. To nabízí doložitelnou vazbu přes přesné **spojení + závěrečné broker fill ID**, nikoli přes podobný čas/cenu nebo současného leadera. Před převzetím legacy UUID/review je nutné zkontrolovat jednoznačnost této vazby i případné duplicity, historicky nesprávný journal účet a souběh se starým importérem. Finite-PnL filtr v nynějším `syncCopierJournal` už brání importu null P&L jako nuly; nesmí se zaměnit samotný fallback v `candidateFromRow` za chybějící filtr.
