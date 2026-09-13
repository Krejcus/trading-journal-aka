# Fáze 23 — celé časové okno a společné regrese

Lokální pracovní kopie `/private/tmp/alphatrade-history-20260912`, základ `e61ab59a`. Bez produkční aktivace nebo obchodních příkazů.

## Změny

- Graf načítá kontext před vstupem až do skutečného dne výstupu, včetně přechodu přes půlnoc a změny času v Praze. Neplatná chronologie má chybový stav. Kontrola dostupnosti historických dat bere i čas výstupu.
- Denní cache svíček respektuje existující 24hodinové omezení backendu a vrácený konec dat. Částečná odpověď se nezamkne v paměti jako hotové okno; staré neúplné denní záznamy se znovu načtou. Dostatečně stará kompletní cache zůstává použitelná. Změna neprokazuje úplnost jednotlivých tržních svíček, tu graf dále kontroluje zvlášť.
- Oprava závěru fáze 22: `getSpectatorData` již převádí povolené R-only výsledky před vstupem do NetworkHubu. Proto body křivky a denní extrémy používají jednotku sdíleného DTO a nepřevádějí R znovu na peníze. Soukromé journal pozice zatím nejsou tímto cizím čtením zpřístupněné.
- Nové serverové moduly používají přípony `.js` v relativních importech. Před opravou nativní Node nedokázal načíst API kvůli importu z `journalInputCompaction` bez přípony; produkční frontend build tento problém neodhaloval.
- Plná sada odhalila tři regrese po odstranění samostatného OrderVersion z execution větve ve fázi 8. Nový Order může převzít první parametry ze stejné dávky, pokud dosud není uložený ani Order, ani jeho verze. Samostatná požadovaná verze stále nemění existující execution cache. Regrese ověřuje i opakování nepotvrzené verze vedle dalšího Order oznámení. Jde o zachování počáteční korelace, ne o nový důkaz potvrzení ochrany; analytická projekce stále vyžaduje vazbu na execution evidence.

## Ověření

- Celá sada: **370 souborů / 3 429 testů prošlo**, exit 0. Obsahuje původní mapování brokeru, pasivního observera, nativní serverové importy i nové testy cache a časových oken.
- Klientský a zapojený pilot/API TypeScript prošel. Scoped ESLint: 0 chyb, 14 existujících varování.
- Vite/PWA sestavení prošlo, 90 precache položek. `git diff --check` čistý.
- Existující upozornění: chybějící sourcemap TypeScript dependency a velké build chunky. Sdílené node_modules nebyly reinstalované; Vite cache vyžadovala povolení zápisu mimo izolovanou kopii.
- Browser: fiktivní náhled na portu 4189 se načetl, zobrazil 12 účtů s vlastními plněními, součet 354,24 USD a výchozí Screenshoty. Nejde o nový důkaz skutečného poskytovatele svíček ani přihlášeného cloudového toku.
- Logy: `/private/tmp/journal-phase23-full-tests.log`, `/private/tmp/journal-phase23-types.log`, `/private/tmp/journal-phase23-lint.log`, `/private/tmp/journal-phase23-build.log`.

## Zbývající hranice

Celý cíl ještě není dokončený. Před aktivací musí být uzavřeno oprávněními omezené sdílené čtení finančních výsledků, posouzené limity velké finanční projekce a ověřený import až do přihlášené aplikace. Zůstává kontrola staršího kalendářového modalu proti společnému owner detailu. Změna odběru OrderVersion vyžaduje samostatnou conformance kontrolu existujících modify/confirmation cest; zelené lokální testy nejsou Tradovate DEMO/LIVE důkaz.

Šest SQL migrací zůstává lokálními návrhy. Před vzdálenou migrací je potřeba konkrétní plán zálohy/exportu a schválená aktivace. Nebyl commit, push, deploy, restart/reinstalace workeru, ARM ani broker write.
