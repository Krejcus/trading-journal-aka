# Fáze 9 — LIVE historie, skutečná App filtrovací cesta a detail grafu

Lokální stav 12. 9. 2026; produkce, worker a broker beze změny.

## Propojení a opravy

- `LiveJournalHistory` je předán z App přes `TradovateLiveDesk` do skutečného `LiveCopyTradeOverview`, za Risk a před diagnostiku. Používá ověřené vlastní uzavřené journal řádky ze stejného výběru jako hlavní historie. Přepínač kombinované/individuální je sdílený s App, otevření řádku používá společný TradeDetailModal. Deset řádků na stránku, sbalitelná karta, jeden řádek pro společnou skupinu 12+ účtů. Aktuální copier skupina se při historickém přiřazení vůbec nepoužívá.
- FilterDropdown je dostupný také v LIVE. Archivované účty se tam nově dočítají pro správné názvy a výběr. Jde o filtr historie; neovládá kopírku.
- **Důležitá oprava oproti předchozím fázím:** App stále obsahoval starý `displayTrades` useMemo, který předem sloučil účty a součet označil jedním skutečným ID. Následující správný agregační helper už neměl jednotlivé řádky. Tento mezikrok byl odstraněn. App teď přímo filtruje vlastní `trades` pomocí `filterHistoryTrades`, až potom používá `aggregateHistoryTrades`.
- Společný filtr neodvozuje výběr z dnešního parentAccountId. Výslovně vybrané účty jsou stejné v obou režimech; funded/challenge/Backtest/active/archive brány zůstávají. Filtry výsledku a času se vyhodnotí u každého účtu samostatně. Legacy neověřené copier řádky do výsledku nevstupují.
- Sdílený detail otevřený z LIVE/AI pro journal řádky odvozuje současný záznam ze stavu App. Při invalidaci přestane být dostupný; při obnově faktů neponechá staré P&L. Má správné názvy archivovaných účtů, je vázaný na přihlášeného vlastníka a při odhlášení se výběr vymaže.
- `AccountExecutionChart` pro journal účet vyžaduje aktuální owner detail s historií. Null, chyba, jiné ID/účet, retired/estimated detail nebo chybějící history zobrazí chybu s opakováním. Před zobrazením nového účtu se starý graf skryje. Po 20 s je explicitní chyba; pozdní odpověď staré volby nepřebije novou. Vykreslení dostane celý čerstvý Trade (ceny, časy, P&L a history společně), ne novou history na starých list faktech. Pro manuální obchod zůstává standardní graf. Screenshoty zůstávají výchozí záložka.

## Ověření

- 37 testů / 6 souborů: skutečný filtr používaný App, LIVE rows, chart detail, skupiny, owner hydratace a import sync. Konkrétně 12 řádků před agregací, vybrání leadera bez jeho dnešních child účtů, ziskový follower ztrátového leadera, phase/archive/Backtest hranice, vlastní časy a starší/invalidní chart detail.
- Scoped TypeScript prošel. ESLint bez chyb; existující warningy v App/detailu zůstávají, nový kód bez warningů.
- Vite/PWA build prošel: 3 481 modulů, 89 precache položek. Známé varování velkých chunků.
- CUA: přečten a vizuálně zkontrolován aktuální kanonický LIVE i trade detail. Náhled 4189 používá skutečnou novou kartu a AccountExecutionChart s explicitním fiktivním loaderem. Ověřen součet 12 účtů, individuální řádky/stránkování, výběr účtu 12 s vlastním P&L/cenami/objemem, chyba místo starého grafu a tmavý vzhled. Není to důkaz přihlášeného App/backend E2E ani skutečného Tradovate datového toku.

## Ještě zbývá

1. Explicitní důkaz úplného počátečního snapshotu pozic pro dosud neviděné instrumenty; analytický backfill a pokrytí výpadků.
2. Dlouhá historie/partitioning místo omezeného plného snímku.
3. Přesné screenshot linkage pro nové záznamy bez adopce legacy review.
4. Position box geometry přes chybějící svíčky/trading break; samotný chart detail error fallback je touto fází opraven.
5. Ověřit a sjednotit editaci journal faktů: generický ManualTradeForm a optimistický App update zatím mohou zkusit upravovat finanční pole. Privátní fakta při dalším owner read vyhrají, ale UI nesmí mezitím vydávat ruční přepis za broker fakt. `combinedTradeChanges` stále obsahuje historické škálování P&L — pro broker journal potřebuje oddělení review změn.
6. Raw-to-UI fixture, skutečný přihlášený E2E, neveřejná sociální projekce a odděleně schválené produkční doručení. Žádný bod nezaměňovat za hotovou celou funkci.
