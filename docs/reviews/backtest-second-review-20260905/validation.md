# Lokální ověření backtest implementace, 5. 9. 2026

Práce proběhla v canonical `/Users/filipkrejca/Documents/trading-journal-aka`. Jiné rozpracované změny zůstaly zachované. Žádný deploy, push ani vzdálené SQL.

## Automatické kontroly

- TypeScript `--noEmit`: exit 0, prázdný log.
- Celý Vitest: 256 souborů, 2133 testů, vše prošlo za 20,60 s. Varování o chybějící typescript.js.map testy neovlivnilo.
- Poslední navazující běh: 36 testů ve 4 souborech, vše prošlo; zahrnuje explicitně neznámý recordedAt a důkazy omezené na replay kurzor. Počty se překrývají s plným během.
- Produkční Vite build do `/private/tmp/alphatrade-backtest-roadmap-build-20260905` prošel. Finální čistý build je v `implementation-evidence/build-final.log`. Jde pouze o lokální validační artefakt.
- Scoped root lint: 0 chyb, 28 starších upozornění v App a MonteCarloLab. Kontrolované změny prošly `git diff --check`.
- Skutečný lokální PostgreSQL přes PGlite: 10 kontrol prošlo. Pokryté jsou owner/RLS/anon, atomické změny a galerie, opakování stejného patche, identita a shoda hlavních sloupců s JSON. To neprokazuje nasazenou DB.

## Prohlížeč

Izolovaný syntetický QA server na portu 4184 zakazuje vzdálené tabulky a funkce mimo syntetický market loader. Testy nezadávají reálné příkazy ani neposílají AI požadavky.

1. MNQ, 1 kontrakt: vstup 101.25 ve 14:02, výstup 101.50 ve 14:03, celkové poplatky 0.74. Uložený čistý výsledek −0.24, balance 49999.76, 2 filly a jeden uzavřený obchod.
2. Ve 14:03 obsahovala executionPath jediný bar 14:03, horizont 14:03 a complete=false. Po kroku 14:04 se automaticky doplnil druhý bar a horizont 14:04. Přednačtená budoucnost do 14:28 se v analýze nevyskytla.
3. Uložit pojmenovanou výchozí šablonu → Načíst → náhled jednoho grafu → Použít → vrátit předchozí workspace: prošlo. QA konzole bez chyb.
4. Dialog kvality dat při 14:00 ukázal právě jednu svíčku a jednu minutu doloženého stažení pro MNQ i NQ; komise 0.37/1.40 za stranu, slippage 0 a cutoff 15:10 America/Chicago. Neznámý kontrakt a verzi feedu označil jako nedoložené. Unit test navíc prokazuje neměnnost hash při změně budoucích dat a uchování sourceSymbol, pokud ho loader dodá.
5. Hlavní localhost 3001 načetl Dashboard a obsah Labu. Selhalo externí načtení kurzů currencyService. Příčina starší spadlé karty nebyla zjištěna; samotný pád není důkaz regrese těchto změn.

## Zbývající hranice

- RPC migrace čeká na schválenou zálohu a aktivaci podle `DEPLOYMENT.md`. Bez ní nová save cesta vrací jasnou chybu aktivace.
- Skutečný souběh dvou zařízení, změna přihlášení, Realtime, Storage upload a obnova po řízeném výpadku nebyly ověřené na nasazené DB.
- Staré cenové extrémy s neznámým průběhem množství jsou označené jako neznámé, s hodnotou null. Rekonstrukce z úplného historického ledgeru zatím implementována není.
- Celá roadmapa 48 rozšíření není dokončená. Stav každého bodu je v `IMPLEMENTATION.md`.
