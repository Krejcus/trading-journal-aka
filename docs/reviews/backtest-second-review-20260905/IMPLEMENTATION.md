# Implementace roadmapy backtestu

Aktualizováno 5. 9. 2026. Uživatel schválil pokračování „dobře, udělej to“. Cíl zůstává aktivní; tento dokument rozlišuje implementaci základů od hotových funkcí. Žádný push, deploy, broker akce nebo vzdálená databázová změna nebyla provedena.

## Aktuální blok: přesnost a uchování dat

| Nález | Stav | Důkaz / zbývá |
|---|---|---|
| B01 | Implementováno, ověřeno lokálně | Mapper vždy clipuje replay horizont; progressive refresh + durable queue; staré path při otevření skryty do dopočtu. Browser: cursor14:03, jediný pathbar14:03, complete=false. |
| B02 | Implementováno | Explicitní prefix gaps, completeness; targeted engine tests. |
| B03 | Nové obchody opraveny; legacy bezpečně označeno | Cash extrema respektují quantity-at-time; chybějící cash historie starých pozic se označí legacy-unknown a čísla null. Platí i po obnovení pozice. Rekonstrukce tam, kde existuje úplný ledger, zatím není implementována. |
| B04 | Implementováno | Společné gap/open/cutoff/slippage helpery pro CF a engine, targeted tests. |
| B05 | Implementováno | Explicit ambiguity, lower/upper MFE bounds, excluded counts Lab/MCP. |
| B06 | Implementováno | Čistá start expectancy, absorbing zero capital, oddělený DD/insolvency, 6 tests. |
| B07 | Lokálně implementováno; DB activation čeká | Fresh RPC preflight před uploadem, atomický gallery append. |
| B08 | Lokálně implementováno; DB activation čeká | Edited-field CAS RPC, mount baseline + diffs, rollback pouze failed fields; combined editor předpočítá patche mimo React updater a vrací jen neúspěšná pole. |
| B09 | Implementováno | Owner-bound legacy cleanup, preserve conflict templates. |
| B10 | Implementováno, ověřeno lokálně | Společná lokální named library pro Save/Load/NewSession. |
| B11 | Implementováno | Conditional template update + insert-only, conflict visible. |
| B12 | Implementováno | Verzionovaný úplný Trade JSON včetně ID/custom tags/auto provenance. |
| B13 | Implementováno | Vnořená validace timezone/style/appearance před mutací. |
| B14 | Implementováno | allowedRoots explicitní odmítnutí nekompatibilního workspace. |
| B15 | Implementováno | Experimenty podle doloženého research recordedAt, frozen cohort IDs/endTs/account scope; unknown dates excluded. |
| B16 | Lokálně implementováno; DB activation čeká | Legacy notes privacy a receiver consent;56 targeted tests/22 SQL checks, viz B16_PRIVACY.md. |
| B17 | Lokálně implementováno | Úplné paginated rich-read a strict export;28 targeted testů, viz B17_OWNED_EXPORT_READ.md. Nejde o atomický DB snapshot. |

## Evidence a validační stav

- Engine základ139 targeted tests; následný refresh/research clock68 (překrývající se běhy, nesčítat).
- Lab+MCP94 targeted tests včetně21 nových regresí; root experiment/coach27.
- Persistence52 targeted tests a10 PGlite SQL scénářů; SQL není nasazené.
- Workspace/export/import24 targeted tests; evidence manifest/profile10.
- Root queue/refresh ordering18 tests; root review+experiment+MC+patch17.
- Společný typecheck prošel po opravě fixtures; celý suite256 files /2133 tests prošel. Po posledním doplnění explicit unknown research clock prošlo dalších36 integračních testů (překrývající se běh, nesčítat). Produkční build do /private/tmp prošel, finální opakování po HTF callback fixu zaznamenáno ve validation.md.
- QA server4184 používá výhradně syntetická data a blokuje remote tables/functions. Původní mainlocalhost3001 karta byla crashed; nová karta načetla Dashboard/Lab. Log pouze externí currencyService fetch selhání; příčina původního pádu není prokázaná.
- Produkční gate: migration20260905173116_backtest_review_atomic_patch.sql potřebuje samostatnou zálohu a schválení. Bez RPC nový backtest review výslovně odmítne unsafe zápis, draft zůstane.

## Navazující blok: rozhodnutí a soukromé revize poznámek

- Rozhodovací deník: taken/skipped/missed/no-setup, příprava, poznámka, záložka, vyhodnocení; zachycený známý OHLC/pozice/objednávky, klientský čas, monotónní maximum odhaleného času. Starší session bez této evidence zůstávají `unknown`.
- Revize jsou append-only v aplikační cestě, s opId pro retry, původním kontextem a retrospektivními úpravami. Snapshot se fyzicky ukládá pouze jednou. Ruční počty nejsou počet všech příležitostí trhu a nemění P&L.
- Fázované poznámky v review: před/během/po, původní poznámka oddělená, limity 20 000 znaků a 2 MiB. Poznámka doplněná k uzavřenému obchodu je zpětná bez ohledu na vybranou fázi.
- Soukromá tabulka + verzované RPC jsou připravené v nové migraci `20260905190446_backtest_private_trade_note_history.sql`. Chybějící podpora zastaví save před uploadem. Žádná historie se neukládá do veřejného `trades.data`; import nového obchodu s historií je zatím explicitně odmítnut.
- Coach v aplikaci přijímá současné fáze a omezenou historii včetně oprav, času, hindsight příznaku a počtu vynechaných položek. Remote MCP privátní historii zatím nehydratuje; automatické embeddings ji neobsahují. Nebyl proveden žádný externí AI požadavek.
- Další integrační opravy: skutečné pozastavení child replaye/cancel čekajících kroků při otevření dialogu; snapshot z jiného kurzoru odmítnut; přepnutí na jiný záznam nezahodí draft; ACK checkpointu porovnává generaci změny, nikoliv milisekundové hodiny.
- Nový **B16 / P1, stav při předchozím bloku**: read-only metadata živého `get_public_trade` a grants/RLS ukazují, že původní notes mohou být dostupné v síťové odpovědi sdíleného/připojeného trade. Klientské skrytí tuto serverovou mezeru neopravuje. Nová historie jde jinou owner-only cestou. Je potřeba samostatná serverová oprava legacy sdílení se zachováním uživatelských voleb.
- Finální společné ověření tohoto bloku:156 tests/10files, typecheck a produkční build passed; scoped lint0errors/11 starších warnings. Ověření a praktické limity viz [research-validation.md](research-validation.md). Kompletní roadmapa zůstává nedokončená.

## Další ověřený blok: verze pravidel a odolnost výsledků

- Výzkumné verze, immutable snapshot vazba session/trade, oddělení vybrané verze a účelu v Labu, přesná CAS persistence, počítání celých pozic. Nová append-only migrace je pouze připravená.
- Odolnost je zapojená do Labu: vyřazení top1/3/5 ziskových pozic/dní + deterministický blokový bootstrap s viditelnými předpoklady a vyloučeními.
- B16 lokálně vyřešené v připravené migraci a klientovi; produkční aktivace čeká. Viz [B16_PRIVACY.md](B16_PRIVACY.md). Širší existující ACL preps/reviews/accounts/profiles nejsou tímto opravené.
- F33 katalog/editor/atomické RPC hotové lokálně; strict reader a wrapper implementované; stale-draft guard hotový, hlavní UI integrace a browser ještě čekají.
- Ověření:238 testů/14files, typecheck/build passed;15 SQL kontrol historie pravidel. Samostatné B16/F33 SQL a UI scénáře viz [rule-robustness-validation.md](rule-robustness-validation.md).

## Celá roadmapa (48 bodů)

Akceptační kritéria a původní priority zůstávají v [ROADMAP.md](ROADMAP.md). „Částečně“ není dokončená funkce.

| ID | Funkce | Stav | Detail |
|---|---|---|---|
| F01 | Manifest kvality dat a badge u obchodu | Částečně | Manifest + immutable fetch metadata + cursor-scoped evidence dialog/JSON implementovány; badge u jednotlivého trade a archival link čekají |
| F02 | Jemnější ověření citlivých svíček | Čeká | Podle akceptace v ROADMAP.md |
| F03 | Společné execution profily | Částečně | Execution policy sjednocena; snapshot nákladů/cutoff a dialog/JSON hotové; vlastní verzované profily a plná batch parity čekají |
| F04 | Kalendář, DST, kontrakty a rollover | Čeká | Podle akceptace v ROADMAP.md |
| F05 | Timeline celé pozice | Částečně | Nové position ID a quantity-aware cash extrema; legacy audit běží |
| F06 | Knihovna pojmenovaných workspace šablon | Částečně | Lokální knihovna implementována; browser Save/Load/preview/return prošel, NewSession resolver testy prošly |
| F07 | Stav synchronizace a obnova konfliktu | Částečně | Atomické review + template CAS + durable outbox; cloud activation čeká |
| F08 | Preview importu a návrat k předchozí verzi | Částečně | Validace/preview/recovery implementovány; browser Load/preview/return prošel |
| F09 | Výzkumný případ s verzemi pravidel | Částečně | Verze/hash/čas, editor, vazby run/trade a report vybrané verze/účelu implementované; server guard activation a úplné remote ověření čekají |
| F10 | Uzamčený neviděný vzorek | Čeká | Podle akceptace v ROADMAP.md |
| F11 | Walk-forward plánovač | Čeká | Podle akceptace v ROADMAP.md |
| F12 | Párové porovnání SL/TP/BE/trail/partial | Částečně | Net R, stejné risk denominátory a exclusion metadata opraveny; rozšíření čeká |
| F13 | Stres nákladů a zpoždění | Čeká | Podle akceptace v ROADMAP.md |
| F14 | Mapa stability parametrů | Čeká | Podle akceptace v ROADMAP.md |
| F15 | Intervaly nejistoty a blokový bootstrap | Lokálně implementováno a ověřeno | Celé pozice/dny, seed/blok/intervaly/Infinity PF, Lab UI a27 společných testů; live cloud evidence je mimo lokální důkaz |
| F16 | Závislost výsledku na výjimečných obchodech | Lokálně implementováno a ověřeno | Baseline vs bez top1/3/5 ziskových pozic/dní s přesnýmiID a metrikami, browser ověřen |
| F17 | Prop challenge simulátor | Čeká | Podle akceptace v ROADMAP.md |
| F18 | Sjednocený risk lab | Částečně | Parametrická MC oprava insolvency/nákladů; sjednocení modulů čeká |
| F19 | Uložené filtry a srovnání skupin | Čeká | Podle akceptace v ROADMAP.md |
| F20 | Funnel příležitostí | Částečně | Ruční počty rozhodnutí s explicitním denominator limitem; automatický census a vazby na setup čekají |
| F21 | Režimy trhu a podobné dny | Čeká | Podle akceptace v ROADMAP.md |
| F22 | Časové heatmapy s velikostí vzorku | Čeká | Podle akceptace v ROADMAP.md |
| F23 | Přehled dodržování pravidel | Čeká | Podle akceptace v ROADMAP.md |
| F24 | Hodnocení setupu před výsledkem | Čeká | Podle akceptace v ROADMAP.md |
| F25 | Příprava → replay → debrief | Částečně | Druhy zápisů prep/debrief existují; vedený workflow a evidence-linked debrief čekají |
| F26 | Jednoklikový deník rozhodnutí | Částečně | Deník, 4 akce, kontext, snapshot, revize, export a local checkpoint implementované; skutečný remote reload a rozšířené research vazby čekají |
| F27 | Balíčky neviděných dní | Čeká | Podle akceptace v ROADMAP.md |
| F28 | Větev scénáře od cursoru | Čeká | Podle akceptace v ROADMAP.md |
| F29 | Cvičení konkrétní dovednosti | Čeká | Podle akceptace v ROADMAP.md |
| F30 | Záložky událostí v replayi | Částečně | Bookmark zápis s časem a kontextem; navigace/filtrování záložek čekají |
| F31 | Fronta review, Uložit a další | Čeká | Podle akceptace v ROADMAP.md |
| F32 | Poznámka před/v průběhu/po obchodu | Částečně | Revize/editor/privátní RPC a Coach kontext implementované; DB activation, remote MCP hydration a přímé psaní k otevřené pozici před/během čekají |
| F33 | Správa vlastních tagů | Částečně | Kategorie/alias/merge/archive editor a atomickáSQL+CAS persistence lokálně připravené; strict full reader a wrapper hotové lokálně; draft guard hotový; UI integrace a cloud activation čekají |
| F34 | Vysvětlení automatického tagu | Částečně | Automatický původ a manual ownership existují; evidence vysvětlení čeká |
| F35 | Coach s hranicí replay času | Čeká | Podle akceptace v ROADMAP.md |
| F36 | AI oponent hypotézy | Čeká | Podle akceptace v ROADMAP.md |
| F37 | Rozbor timeline s odkazy na důkazy | Čeká | Podle akceptace v ROADMAP.md |
| F38 | Osobní tréninkový plán | Čeká | Podle akceptace v ROADMAP.md |
| F39 | Hledání podobných rozhodnutí | Čeká | Podle akceptace v ROADMAP.md |
| F40 | Pravidlový vyhledávač situací | Čeká | Podle akceptace v ROADMAP.md |
| F41 | Vizuální sestavení a dávkový test pravidel | Čeká | Podle akceptace v ROADMAP.md |
| F42 | Ověřitelný výzkumný balíček | Částečně | Úplný JSON export existuje; společný research package čeká |
| F43 | Fronta porovnání více runů | Čeká | Podle akceptace v ROADMAP.md |
| F44 | Plynulost dlouhých session | Čeká | Podle akceptace v ROADMAP.md |
| F45 | Klávesové ovládání a command menu | Čeká | Podle akceptace v ROADMAP.md |
| F46 | Šablony kontextu NQ/MNQ | Čeká | Podle akceptace v ROADMAP.md |
| F47 | Historické makro události | Čeká | Podle akceptace v ROADMAP.md |
| F48 | Výzkum více instrumentů/portfolia | Čeká | Podle akceptace v ROADMAP.md |

## Další pořadí

1. Po schválení zálohy aktivovat review RPC a ověřit skutečné cloud concurrency/auth/realtime. Lokální validační blok dokončen; legacy cash reconstruction zůstává případné rozšíření.
2. Doplnit manifest/profile odkazy k archivovanému runu/trade/research package (dialog a JSON již existují).
3. Rozhodovací deník, fázované poznámky, výzkumné verze a explicitní run/trade vazby; pak uzamčené OOS/exposure evidence.
4. Následné roadmap body podle závislostí a priority; položky C/XL neoznačovat hotové náhradním malým UI.

Lokální implementace může pokračovat před produkční aktivací. Lokální zelené testy neprokazují skutečné remote concurrency/realtime/auth chování.
