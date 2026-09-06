# Kompletní review backtestingu — 5. 9. 2026

Backtesting má funkční a poměrně rozsáhlé uživatelské rozhraní, ale aktuální implementace obsahuje chyby, které umí změnit prohraný obchod na vítězný, vynechat exekuci během Go To nebo ztratit návaznost mezi replayem a deníkem. Výsledky replaye proto zatím nelze pokládat za spolehlivý podklad pro hodnocení strategie. Toto není tvrzení, že jsou chybné všechny již uložené obchody: rozsah dopadu na existující sessions by vyžadoval samostatnou rekonstrukci jejich událostí.

## Rozsah a důkazy

- Aktuální pracovní strom `/Users/filipkrejca/Documents/trading-journal-aka`, HEAD `479a5c3df12133ebbb6409b4b9dd2a7f60e0d3ed`. Strom již obsahoval cizí rozpracované změny, mimo jiné v App.tsx. Review zahrnuje pracovní soubory, nikoli pouze commit nebo produkční build.
- Spuštěný Vite na http://localhost:3001. Port 3000 již patřil jinému pracovnímu adresáři. Browser ověření proběhlo přes dostupný Codex browser/CUA; CLI `agent-browser` nebylo dostupné.
- V prohlížeči ověřeno: přepnutí do Backtest, dashboard, seznam sessions, otevření `testovka`, načtení tří MNQ grafů 1m/5m/15m, Go To nastavení, návrat, historie a detail existujícího obchodu včetně entry/exit grafu a uložených metrik. Nebyly zadány nové testovací obchody do uživatelova deníku ani měněny parametry existujících obchodů. Běžná navigace může ukládat preference, vzhled a čas otevření session.
- Exekuční chyby byly reprodukovány na skutečných engine funkcích se syntetickými svíčkami. Cloudové chyby byly reprodukovány na skutečné service s nahrazeným IndexedDB/Supabase transportem; nejde o destruktivní experimenty v produkční DB. Go To reprodukce modeluje přesné hranice callbacků a používá aktuální engine/replay funkce, nejde o kompletní automatizovaný browser test.
- První sada: **25 souborů / 310 testů prošlo**. Dodatečná sada cache, appearance, indikátorů a syncu: **5 souborů / 33 testů prošlo**. Celkem **343 testů**.
- `npm run typecheck` poprvé skončil na 2GB Node heap limitu. Opakování `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck` prošlo.
- Produkční Vite/PWA build **prošel** (3379 modulů, hlavní build 1m21s). Upozorňuje na chunky nad500kB; chart workspace má766kB /225kB gzip. To je námět pro load-performance měření, samo o sobě nikoli důkaz trhání replaye. Výstup je pouze v `/private/tmp/alphatrade-backtest-review-20260905/build`.
- Reprodukční skripty a jejich skutečné výstupy jsou ve složce `evidence` vedle tohoto reportu. Skripty odkazují na aktuální kanonický checkout; persistence test má všechny vzdálené operace nahrazené mockem.

P1 znamená vysokou prioritu kvůli nesprávnému výsledku, ztrátě dat nebo izolaci uživatelů. P2 je konkrétní chyba funkčnosti či interpretace. Celkem je níže **17 technických nálezů: 6 P1 a 11 P2**; následně samostatné poznámky z UI.

## P1 — správnost výsledků a zachování dat

### 1. Limit/stop vstup ignoruje SL/TP na své vstupní svíčce

**Místo:** [backtestEngine.ts:452](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestEngine.ts:452), řádky 452–475; ochranné příkazy se vyhodnocují již před vstupem, na 421–449.

Čekající buy limit 99, SL 98, TP 104; příští OHLC 100/100/96/97. Při sestupu musí být nejprve dosažen vstup 99 a potom SL 98. Engine přesto ponechá pozici otevřenou. Následující OHLC 100/104/100/104 ji zavře jako vítěze **+$9.26**, místo ztráty **−$2.74** při výchozí MNQ komisi. Také stop buy 101 s TP 102 ignoruje jistý TP v baru 100/104/100/103. Tyto příklady nevyžadují znalost neurčitelného pořadí high/low.

**Oprava a ověření:** při aktivaci vstupu vyhodnotit zbývající dosažitelnou část vstupního baru; nejisté případy explicitně označit. Testovat oba směry, limit/stop, entry+SL, entry+TP a gap.

### 2. Market klik znovu vyhodnotí minulý high/low již odhalené svíčky

**Místo:** [BacktestWorkspace.tsx:482](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:482).

Na odhalené svíčce 100/102/98/100 uživatel vloží nový limit 99 a pak market buy. `executeOrder` pro market spustí celé zpracování svíčky: nově vložený limit se vyplní zpětně podle minulého low. Výsledkem jsou **2 kontrakty @99.5**, správně má zůstat 1 market @100 a pending limit. Další repro: buy100/SL99 a ihned Zavřít bez posunu replaye vytvoří historický stop99 a následný prázdný reduce-only fill: **3 fills a −$3.11**, místo **2 fills a −$0.74**.

**Oprava a ověření:** oddělit okamžité uživatelské market exekuce na aktuální ceně od zpracování nově odhaleného baru. Reduce-only fill smí účtovat jen skutečně uzavírané množství ([backtestEngine.ts:237](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestEngine.ts:237)). Přidat test posloupnosti více akcí bez posunu času.

### 3. Go To přes nenačtené období vynechá obchodní exekuce

**Místo:** [BacktestWorkspace.tsx:402](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:402), řádky 402–406; [AlphaTradeChartWorkspace.tsx:1146](/Users/filipkrejca/Documents/trading-journal-aka/components/AlphaTradeChartWorkspace.tsx:1146).

Go To okamžitě posune kurzor až před cíl. Engine zpracuje jen aktuálně dostupné svíčky, ale poslední zpracovaný čas nastaví až na cíl. Nové svíčky dorazí později; změna dat sama callback replaye znovu nespustí a další krok již začíná za cílem. Repro long100/TP102 se zásahem TP v nenačtené mezeře: skutečnost **0 closed / 1 pozice / balance50000**, souvislé zpracování **1 closed / 0 pozic / balance50004** (fixture bez komise).

**Oprava a ověření:** oddělit požadovaný kurzor, načtené pokrytí a skutečně zpracovaný čas. Skok dokončit až po sekvenčním zpracování všech překročených svíček. Integrační test s opožděnou odpovědí, SL/TP a pending vstupem uvnitř mezery.

### 4. Neúspěšný zápis uzavřeného obchodu se po obnovení nedožene

**Místo:** [BacktestWorkspace.tsx:377](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:377), [App.tsx:3238](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:3238), [BacktestWorkspace.tsx:148](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:148).

ID obchodu se označí za emitované před potvrzením `saveTrades`. Callback při chybě pouze zobrazí sync error. Při otevření session se všechny runtime closedTrades považují za již emitované. Síťová chyba nebo refresh mezi checkpointem runtime a trade zápisem tak nechá obchod v replayi, ale po novém načtení chybí v deníku, statistikách a exportu. `storageService.saveTrades` zapisuje cache až po úspěchu DB, takže zde není offline fronta, která by mezeru sama vyplnila.

**Důkaz:** aktuální úplná cesta callback → service → obnovení, nikoli produkční fault injection. **Oprava a ověření:** potvrzovaný idempotentní outbox a reconciliation runtime closed IDs proti uloženým trade IDs; test selhání zápisu a reloadu.

### 5. Konflikt dvou záložek přepíše novější cloudový stav starším

**Místo:** [backtestRunService.ts:271](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestRunService.ts:271), řádky 271–273.

Po neúspěšném revision match následuje bezpodmínečný upsert stejného snapshotu. Mock skutečné service: cloud revision10 obsahuje nový obchod; stale klient pošle revision4 s expected3. Výsledkem je **cloud revision4 bez nového obchodu**. Last-write-wins je v komentáři záměrné, ale jeho praktický důsledek je ztráta pokroku při běžném souběžném otevření.

**Oprava a ověření:** konflikt musí vrátit rozpoznatelný stav a vyžádat načtení/řešení aktuální revize; nepřepsat cizí pokračování. Test dvou klientů s různým průběhem a ledgerem.

### 6. Lokální sessions nejsou oddělené podle přihlášeného uživatele

**Místo:** [backtestRunService.ts:15](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestRunService.ts:15) a [backtestRunService.ts:184](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestRunService.ts:184); [appStorage.ts:11](/Users/filipkrejca/Documents/trading-journal-aka/utils/appStorage.ts:11).

Globální IndexedDB index i run bloby nemají user namespace; list přimíchá veškeré lokální sessions. Logout čistí localStorage, nikoli tuto IndexedDB. Repro: A uloží `private-A`, potom se přihlásí B s prázdným cloudem; B dostane `private-A` včetně runtime a workspace. Jde o sdílený browser/origin, nikoli o prokázané prolomení vzdáleného RLS.

**Oprava a ověření:** user-scoped index/bloby a ověření vlastníka před použitím lokálního snapshotu, bezpečná migrace legacy cache. Test A → logout → B, online i offline.

## P2 — načítání, persistence a analytika

### 7. Denní krok se zastaví před koncem segmentu bez prefetch

**Místo:** [chartReplay.ts:125](/Users/filipkrejca/Documents/trading-journal-aka/services/chartReplay.ts:125), [BacktestWorkspace.tsx:333](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:333).

Repro: 800 načtených minut za kurzorem směrem do budoucnosti, krok 1d, session pokračuje dál. Krok nemá dosažitelný target, vrátí null a pauzu. Prefetch ale čeká na méně než 240 zbývajících barů nebo konec aktuálních dat. Opakované klikání tedy nic nenačte. Prefetch musí počítat s požadovanou velikostí kroku; otestovat také 4h a víkend.

### 8. Reopen delší session nedotáhne již přehrané období před okolím kurzoru

**Místo:** [BacktestWorkspace.tsx:321](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:321) a [BacktestWorkspace.tsx:288](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:288).

Příklad: session od 1. 7., uložený kurzor 20. 7. Po otevření se stáhne okolí od 18. 7.; scroll do historie smí stahovat jen před původním 1. 7. **Sedmnáctidenní interval vlastní session nemá fetch cestu.** Chybí kontext starších obchodů a souvislá historie pro HTF. Přidat zpětné načítání od skutečně načtené hranice do začátku session; až poté předsession historii.

### 9. Současná obnova několika sessions poškodí lokální index

**Místo:** [backtestRunService.ts:26](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestRunService.ts:26), [backtestRunService.ts:205](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestRunService.ts:205).

`Promise.all(saveLocal)` souběžně provádí read-modify-write společného indexu. Repro s prázdnou cache a 3 cloud sessions: online se vrátí3, uloží se3 bloby, ale index obsahuje1 ID a offline list vrátí1. Bloby nejsou fyzicky smazané, pouze se ztratí z lokálního seznamu. Index uložit jednou nebo atomicky, ověřit cold-cache restore a offline reopen.

### 10. Cloud checkpoint failure vypadá pro volajícího jako úspěch

**Místo:** [backtestRunService.ts:264](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestRunService.ts:264), [BacktestWorkspace.tsx:205](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:205).

Service při update error vrátí run místo odmítnutí. Workspace potvrdí cloud revision a čas syncu; cloudDirty už předtím vynuloval. Repro síťové chyby08006: cloud zůstává na4, klient považuje5 za synchronizované. Pokud session zůstane beze změn na pauze, další flush nic neopakuje. Chybu propagovat strukturovaným výsledkem a ponechat retry příznak. Současně zúžit `isCloudUnavailable` na101–102: text `backtest_runs` v chybě sám nedokazuje neexistující tabulku.

### 11. Změna orderu na stejné replay svíčce se nepropíše do ledgeru

**Místo:** [backtestRunService.ts:125](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestRunService.ts:125), [backtestEngine.ts:538](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestEngine.ts:538).

Deduplikace porovnává jen updatedAt, ale ten je replay čas. Repro pending@1000 → sync → cancel@1000 → sync: runtime/snapshot je cancelled, `backtest_orders` zůstává pending. Platí i pro další edity během pauzy. Potřebná samostatná monotónní revize změny nebo hash obsahu; test změna/sync/změna/sync na stejném market timestampu.

### 12. MFE/MAE obsahuje pohyb po uzavření pozice

**Místo:** [backtestEngine.ts:418](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestEngine.ts:418), [backtestIntel.ts:927](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestIntel.ts:927).

Celé extrémy baru se připočtou před zpracováním exit. Repro long100/SL98/TP104; další OHLC100/120/100/119. Exit104, ale MFE20 bodů/10R; pro otevřenou pozici bylo možné nejvýše4 body/2R, protože cesta ke120 nutně překročila TP104. Tyto hodnoty jdou do runUp/drawdown, deníku i Lab. Existující test na [backtestEngine.test.ts:249](/Users/filipkrejca/Documents/trading-journal-aka/tests/backtestEngine.test.ts:249) dokonce očekává MAE1.5R při stop fillu1R. Oddělit skutečný excursion otevřené pozice od vývoje ceny po exitu; u nejistých intrabar případů uvést meze/nejistotu.

### 13. Monte Carlo „ztráta celého účtu“ zaměňuje ruin za velký drawdown

**Místo:** [Dashboard.tsx:642](/Users/filipkrejca/Documents/trading-journal-aka/components/Dashboard.tsx:642), label na762.

Výpočet počítá dráhy s maxDD ≥ počáteční kapitál. Repro skutečného těla useMemo s fixovaným RNG: počáteční100, všechny dráhy100→300→150 a dále flat. Účet nikdy neklesl pod100, ale UI vrací **100% ruin místo0%**. Pro uvedený label sledovat minimum absolutní equity ≤0. Není nutné měnit sampling, jen správně definovat ukazatel a přidat deterministický test.

### 14. Scale-in je označený jako partial exit

**Místo:** [backtestOrderJournal.ts:95](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestOrderJournal.ts:95), [labAnalytics.ts:1298](/Users/filipkrejca/Documents/trading-journal-aka/services/labAnalytics.ts:1298).

Každý fill uvnitř entry/exit okna se počítá jako částečný výstup bez kontroly směru. Repro buy1@1000, buy1@1500, sell2@2000 vrátí partialExits1 a `partial_runner`, přestože výstup byl jediný. Tím se chybně seskupují management varianty v Lab. Odlišit přírůstky a úbytky pozice a otestovat scale-in, partial a reverse.

### 15. Přidání SL/TP z kontextového menu chybí v management journalu

**Místo:** [BacktestWorkspace.tsx:669](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:669), [backtestEngine.ts:645](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestEngine.ts:645).

Tato UI cesta volá updatePositionBracket bez marketTime; engine bez něj přeskočí event. Repro: pozice dostane SL98/TP104, počet orderEvents zůstane0. Jiné drag/update cesty čas mají. Předat replay čas a otestovat, že se změna objeví v review i exportovaném managementu.

### 16. Poloviční výstup předčasně ukončí position box

**Místo:** [backtestManagedPosition.ts:56](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestManagedPosition.ts:56), řádky 56–65.

Repro managed vstup2 kontrakty, ½ ven uzavře1. Runtime drží1, ale první partial closedTrade způsobí state closed a terminalTime na partialu. Box se přestane prodlužovat před skutečným ukončením pozice. Stav boxu odvodit od zbývající pozice/úplného lifecycle, testovat alespoň dva partial výstupy.

### 17. Limitový TP dostane slippage přes vlastní limit

**Místo:** [backtestEngine.ts:429](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestEngine.ts:429), řádky 429–434.

Repro long s TP104 a slippage1 tick: exit je103.75. Prodejní limit nemá plnit níže než104. Běžné limit vstupy respektují clamp na457–459, bracket TP nikoli. Odlišit stop/market a limitový TP model, otestovat oba směry se slippage. Pokud produkt chce market-on-touch target, musí tuto odlišnou sémantiku jasně definovat a používat konzistentně.

## Nálezy z uživatelského rozhraní

- **P2: LIVE import panel se zobrazuje v Backtest historii.** Browser skutečně ukázal 58 nepřiřazených copier obchodů, výběr živých účtů a akci „Přiřadit a vytvořit drafty“ nad backtestovými záznamy. [App.tsx:4260](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:4260) předává pending copier data i callback bez kontroly světa; [TradeHistory.tsx:673](/Users/filipkrejca/Documents/trading-journal-aka/components/TradeHistory.tsx:673) panel bez kontroly vykreslí. Oddělení statistik live/backtest tím není samo o sobě vyvrácené, ale Backtest nabízí akci nad live deníkem. V review tato akce nebyla provedena.
- **P3: nezformátovaná čísla v detailu.** Skutečně zobrazeno `VWAP +0.8397743080640748Σ`, MFE `+4.065573770491803R` a MAE `−0.11475409836065574R`. Sjednotit zobrazení na účelné 1–2 desetinné pozice, přesnost ponechat v datech.
- Grafy, rozložení, Go To dialog i detail existujícího tradu se načetly. V ověřované session nebyl runtime crash ani chyba načtení svíček. V konzoli byl neúspěšný fetch směnných kurzů, upozornění Tailwind CDN a při mountu Recharts rozměry −1; není to důkaz problému samotného candle backendu.
- Pro odlišení dat a výpočtu by pomohl přímo viditelný stav „lokálně uloženo / cloud synchronizován / čeká na retry“ a pokrytí svíček při skoku. Aktuální pozitivní vzhled grafu nedokazuje, že engine všechny bary zpracoval.

## Co je na současném řešení dobré

- Oddělené replay sessions a live/backtest filtrování hlavních dat; existující session a detail skutečně fungují.
- Řazení a deduplikace sloučených svíček podle timestampu, cache po denních bucketech.
- Předsession provider HTF bary se přijímají až po dokončení; odhalené session bary se filtrují podle replay kurzoru. Existují cílené no-lookahead/HTF testy.
- Edge parser odmítá HTTP206 a dosažený limit25000, takže tato konkrétní forma zkrácení není tiše přijata.
- Engine má tick normalizaci, gap přes SL, komise, počáteční riziko, konzervativní SL-first s explicitní ambiguity a session cutoff.
- Dřívější výkonnostní témata už mají implementované změny: dávkové zpracování barů, omezené React rendery, lokální checkpoint1.5s a řidší cloudový checkpoint s incremental ledgerem. Starý performance audit proto nelze bez kontroly přebírat jako seznam současných chyb; současné chyby se týkají zejména koordinace a potvrzování změn.
- Při změně aktivního grafu na NQ se nemění executionSymbol; zadání z nesprávného instrumentu má guard. Tento prověřený kandidát není nález.

## Doporučené pořadí oprav a přejímací zkouška

1. **Exekuce:** body1–3, potom12 a17. Výsledek musí být stejný při jednotlivých krocích, batch replayi, Go To a rychlém klikání; žádné použití předvstupního high/low pro nové příkazy.
2. **Data:** body4–6 a9–11. Session/runtime, journal trade a order/fill ledger musí po selhání sítě, reloadu, konfliktu dvou klientů a přepnutí uživatele skončit v prokazatelně konzistentním stavu.
3. **Načítání:** body7–8. Ověřit dlouhou session od cold cache, reopen u konce, scroll ke starým obchodům, denní krok a víkend.
4. **Statistiky a management:** body13–16, až poté vzhled. Výsledky odvozovat od správných exekucí a definovat jeden trade vs. partial fill, skutečný excursion vs. post-exit potenciál a ruin vs. drawdown.
5. Po opravách vytvořit izolovanou QA session a browser scénář od založení přes market/limit/stop, partial, SL/TP, reload a výpadek po export; teprve pak zvážit rekonstrukci dotčených historických dat. Žádný automatický přepočet uživatelových výsledků v rámci tohoto review neproběhl.

## Meze závěru

Jde o kompletní průchod hlavními oblastmi backtestu, nikoli matematický důkaz absence dalších chyb. Nebyla ověřena ticková pravdivost externího datasetu proti nezávislému feedu, licence, produkční verze Edge Function, všechny časové zóny/DST ani dlouhodobý benchmark výkonu. Celá aplikace nebyla otestována plnou sadou nesouvisejících copier testů. Zjištěné chyby nevyžadují tyto neprovedené kontroly: jsou reprodukovatelné uvnitř aktuálního kódu. Review nemění zdroje aplikace a nic nenasazuje.
