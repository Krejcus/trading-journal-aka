# Backtest — druhý audit a návrh rozvoje, 5. 9. 2026

**Verdikt:** základní ruční replay, uzavření obchodů, poplatky, obnovení lokální session a běžné uložení poznámky/tagu prošly novým izolovaným browser testem. Druhý průchod však našel další chyby v analytice, souběžném ukládání a návaznosti workspace. Nejde tedy ještě o stav „vše bez výhrad“. Nové chyby popsané níže v tomto průchodu nebyly opravovány.

Rozvojový návrh obsahuje **48 konkrétních možností**, prioritu, relativní velikost a podmínky dokončení: [ROADMAP.md](ROADMAP.md). Doporučený směr je spolehlivý výzkum a cílený trénink diskréčního NQ/MNQ obchodování nad existujícím replayem, Lab a Coach.

## Rozsah a síla důkazů

- Aktuální canonical checkout `/Users/filipkrejca/Documents/trading-journal-aka`, včetně necommitnutých dřívějších oprav. V repozitáři současně leží další práce mimo backtest; nebyla upravena ani zahozena.
- Hlavní localhost `http://localhost:3001/`: navigace a čtení Dashboardu, Sessions, formuláře nové session a načteného Lab. Nevytvářel jsem reálné obchody ani novou cloudovou session.
- Browser QA `http://127.0.0.1:4184/tests/qa/backtest.html`: skutečné aktuální React komponenty, syntetické svíčky, lokální/mock persistence, zakázané reálné Supabase/AI požadavky. Podrobný průchod je v [browser.md](browser.md).
- **127/127 existujících cílených testů** prošlo: engine, execution causality, batch, Intel, Monte Carlo, candle store a replay data. [Výstup](evidence/engine/existing-targeted-tests.log)
- **10/10 diagnostických testů** prokázalo popsané současné problematické chování. Tyto testy záměrně potvrzují chybu; nejsou dokladem její opravy. [Výstup reprodukcí](evidence/engine/results.log)
- Tři další skripty spustily aktuální funkce ukládání, šablon, importu a exportu nad mock transportem/storage. Důkazní limity u dvou importních vad jsou uvedené zvlášť.
- V tomto průchodu nebyl znovu spuštěn celý projektový build, plný test suite ani produkční roundtrip dvou zařízení. Nebyl testován aktuální vzdálený MCP build ani doručení nové poznámky reálnému modelu. Testy potvrzují lokální kód, nikoli nasazení.
- Změny tohoto průchodu: pouze reporty, reprodukční evidence a zápis do projektového deníku. Žádný nový aplikační vývoj, push nebo deploy.

## Nové otevřené nálezy

P1 = významné zkreslení výsledku, ztráta dat nebo porušení časové hranice. P2 = omezenější chyba funkce či neobvyklá hraniční situace. Pořadí odráží dopad a doporučenou prioritu opravy, nikoli četnost výskytu na produkčních datech.

| ID | Priorita | Nález a dopad | Důkaz |
|---|---|---|---|
| B01 | P1 | **Přednačtená budoucnost je v uložené analýze obchodu.** Mapper dostává celou sadu svíček bez hranice replay cursoru. Potenciál, varianty managementu a execution path mohou obsahovat dosud neodhalené bary. | Čistý test: budoucí bar změní 1R na 10R. Browser: při cursoru 14:03 uložený execution path končí až 14:28. Přímé otevření těchto metrik v uživatelském detailu během aktivního replaye nebylo zvlášť prokázáno. |
| B02 | P1 | **Chybějící úvodních 59 minut se označí jako kompletní cesta.** První existující svíčka až za hodinu zasáhne TP a výsledek je WIN/complete bez gapu, přestože neznáme předchozí průběh. | Deterministická reprodukce Intel; následné použití příznaku complete v Lab doloženo zdrojovým tokem. |
| B03 | P1 | **Scale-in zkresluje historické MFE/MAE.** Dřívější cenové extrémy se vyhodnotí proti nové průměrné ceně a množství. | Dvě reprodukce: MFE $120 místo $40; MAE $40 místo $0. Samotný realizovaný P&L v těchto případech zůstává správný. |
| B04 | P1 | **Counterfactual používá jinou exekuci než opravený engine.** Přes gap plní na nominálním SL; z cutoff svíčky používá pozdější knot. | Gap: engine −5R, původní bracket v analytice −1R. Cutoff: engine 0R, varianta initial +2R a no_target +10R. |
| B05 | P1/P2 | **Analytika ztrácí informaci o nejednoznačnosti.** Potenciál započítá celý příznivý knot stopové svíčky; uložená varianta zahodí flag `ambiguous`. | Svíčka zasahující SL i vyšší cíle se vydává za dosažený potenciál 10R. Horní odhad je legitimní, ale musí být jako horní odhad označen. |
| B06 | P2 | **Rozšířené Monte Carlo míchá hrubou expectancy s čistými cestami a pokračuje po vyčerpání kapitálu se záporným rizikem.** | Přesné pomocné funkce ze současné komponenty: povolené vstupy ukazují +0,17R expectancy při všech čistých výsledcích záporných; následně záporná equity i risk. Jde o jiný model než dashboard bootstrap. |
| B07 | P1 | **Chyba načtení galerie může odstranit odkazy na starší screenshoty.** Read error vrací stejnou prázdnou Map jako potvrzeně prázdná galerie; přidání nového obrázku potom přepíše seznam. | Reálná read metoda + review helper s mockem: selže jen SELECT, upload/update uspějí; zbude jen nový odkaz. Není tvrzeno fyzické smazání storage objektů. |
| B08 | P1 | **Souběžná úprava poznámky a tagů může vrátit starou poznámku.** Obě operace čtou celý JSON a druhá zapíše svůj starý snapshot. | Dvě současná `updateTrade` hlásí úspěch; finální tag je nový, poznámka stará. Mockované úložiště, aktuální metoda. |
| B09 | P1 | **Legacy import šablon může při quota chybě a přepnutí účtu odstranit jedinou kopii.** Cleanup po await posuzuje globální sync stav jiného uživatele. | Aktuální store: zanikne legacy klíč, žádná kopie účtu A, nula cloud upsertů. Vedlejší kolize stejného názvu s jinou hodnotou rovněž nemá archiv odmítnuté varianty. |
| B10 | P2 | **Save a Nová session nesdílejí stejnou knihovnu layoutů.** Save zapisuje nový user-scoped dokument, manager čte starý neowned klíč; dostupnost navíc zamrazí při mountu. | Aktuální key builder + helper: nový uložený dokument nenalezen, starý klíč přijat. UI nové session zobrazuje volbu vlastního layoutu, ale samotná její neaktivita není důkaz této chyby bez uvedeného kódu/repro. |
| B11 | P2 | **Cloud sync šablon může přepsat novější smazání.** Mezi SELECT a nepodmíněným upsertem proběhne změna na druhém zařízení. | Store reprodukce: novější tombstone zmizí a status je `synced`. Dosavadní tombstones chrání jen smazání viditelné při úvodním SELECT. |
| B12 | P2 | **JSON export pro AI ztrácí vlastní tagy a původ konfluencí.** Vynechává také setupType a stabilní ID obchodu. Poznámky v exportu zůstávají. | Přímé spuštění současného `buildTradeRecord` s vyplněnými poli. Legenda navíc chybně označuje všechny konfluence za ruční. |
| B13 | P2 | **Import přijme neplatnou timezone, kterou formatter neumí vykreslit.** | Parser přijme `Mars/InvalidZone`; současný merge ji zachová a formatter vyhodí RangeError. Následná mounted UI recovery nebyla přehrána; dopad po předání stavu doložen kódem. |
| B14 | P2 | **Import dovolí NQ panel do MNQ-only runu.** Chybí kontextová kontrola povolených instrumentů. | Parser akceptace reprodukována; cesta k trvale prázdnému loading panelu doložena kódem, nikoli nově založenou reálnou session. Nejde o důkaz exekuce špatného instrumentu. |
| B15 | P2 | **Experiment porovnává dnešní založení s historickým datem trhu.** Obchody provedené dnes v replayi srpna mohou všechny spadnout „před experiment“. | Přímý tok dat: `Date.now()` v LabPage → historický exit timestamp v mapperu → before/after porovnání v Lab. V tomto průchodu bez samostatného mounted experiment testu. |

Detailní technické nálezy a přesné řádky: [engine a analytika](engine-findings.md), [ukládání, šablony, import a AI export](persistence-findings.md).

### Přímé zdrojové kotvy

- B01: [BacktestWorkspace.tsx:389](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestWorkspace.tsx:389), [backtestIntel.ts:649](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestIntel.ts:649).
- B02–B05: [backtestIntel.ts:178](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestIntel.ts:178), [backtestEngine.ts:269](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestEngine.ts:269), [backtestIntel.ts:373](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestIntel.ts:373), [backtestIntel.ts:791](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestIntel.ts:791).
- B06: [MonteCarloLab.tsx:33](/Users/filipkrejca/Documents/trading-journal-aka/components/MonteCarloLab.tsx:33), [MonteCarloLab.tsx:97](/Users/filipkrejca/Documents/trading-journal-aka/components/MonteCarloLab.tsx:97).
- B07–B09: [storageService.ts:1035](/Users/filipkrejca/Documents/trading-journal-aka/services/storageService.ts:1035), [storageService.ts:679](/Users/filipkrejca/Documents/trading-journal-aka/services/storageService.ts:679), [chartTemplateStore.ts:210](/Users/filipkrejca/Documents/trading-journal-aka/services/chartTemplateStore.ts:210).
- B10–B12: [BacktestSessionsManager.tsx:17](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestSessionsManager.tsx:17), [chartTemplateStore.ts:147](/Users/filipkrejca/Documents/trading-journal-aka/services/chartTemplateStore.ts:147), [BacktestSessionsManager.tsx:84](/Users/filipkrejca/Documents/trading-journal-aka/components/BacktestSessionsManager.tsx:84).
- B13–B14: [chartWorkspaceDocument.ts:42](/Users/filipkrejca/Documents/trading-journal-aka/services/chartWorkspaceDocument.ts:42), [chartWorkspaceDocument.ts:63](/Users/filipkrejca/Documents/trading-journal-aka/services/chartWorkspaceDocument.ts:63).
- B15: [LabPage.tsx:209](/Users/filipkrejca/Documents/trading-journal-aka/components/LabPage.tsx:209), [backtestIntel.ts:1007](/Users/filipkrejca/Documents/trading-journal-aka/services/backtestIntel.ts:1007), [labAnalytics.ts:1620](/Users/filipkrejca/Documents/trading-journal-aka/services/labAnalytics.ts:1620).

## Odpovědi k dřívějším otázkám

**Layouty, kresby a indikátory:** běžná lokální persistence byla pokryta předchozím průchodem; aktuální druhý audit prověřil navazující kontrakty a souběh. Nový workspace formát obsahuje panely, drawings, indikátory a vzhled. Pro bezvýhradné potvrzení všech cest zbývá opravit B09–B11 a B13–B14 a ověřit dvě zařízení nad odpovídajícím testovacím cloudem. Save/Load v jednom místě není totéž jako přenos šablony do nové session.

**Poznámky a AI:** běžné uložení a opětovné otevření poznámky prošlo browser QA. App Coach má aktuální detail/hydrataci a může poznámky použít; skutečný nový modelový rozbor nebyl volán. Export zatím postrádá nové tagy/provenanci (B12). Zdrojový MCP má stále 60s cache a oříznutí JSON na 30 000 znaků; na dlouhém detailu může odříznout poznámku a vrátit neplatný JSON. Nasazená verze nebyla ověřena. Dřívější blokované změny MCP/embedding přenosů se v tomto průchodu znovu neprováděly.

**Vlastní tagy:** nový tag se přes review UI uložil a po otevření zůstal spolu s poznámkou. Další smysluplné rozšíření je správa kategorií, aliasů a slučování s náhledem. Současnou souběžnou změnu více polí je třeba chránit před B08.

**Auto tagy:** existuje oddělení automatického původu (`autoConfluence`) a ruční interpretace/setupu, včetně přepočtu s náhledem. V novém browser průchodu zůstaly auto konfluence při uložení vlastního tagu i poznámky zachované. To samo nedokazuje přesnost všech detektorů; pro research přidat jejich pravidlo, verzi a okamžik, kdy bylo možné značku znát. Výzkumný filtr musí rozlišovat předvstupní informaci od pozdějšího hodnocení.

## Metodické limity, které nejsou samy o sobě novou chybou

- Minutové OHLC neurčuje pořadí dotyků uvnitř svíčky. Konzervativní stop-first je možná modelová volba, pokud je explicitní a nejistota se neztratí v dalších výpočtech.
- Úspěšné načtení intervalu není úplný důkaz zdrojové datové kvality. Tento průchod nepotvrdil poškození produkčního feedu; ukázal slabinu v detekci neúplnosti a v její interpretaci.
- Dashboard bootstrap dnes resampluje realizované řádky jako nezávislé. Partialy nebo obchody stejného dne tuto nezávislost nemusí splňovat. Doporučení je uchovat position ID a nabídnout resampling bloků.
- Třicet obchodů samo o sobě neprokazuje stabilní edge; záleží na nezávislosti, výběru, nákladech, extrémech a počtu hledaných variant.
- Současné dva grafové instrumenty neznamenají portfolio simulaci více současně oceňovaných instrumentů.

## Doporučený další krok

Nejprve uzavřít chyby se ztrátou dat a zkreslením výsledků, doplnit regresní testy očekávaného správného chování. Poté spojit **šablonu → přípravu → rozhodovací deník → rychlé review → verzi experimentu**. Tento celek připraví pevný základ pro OOS, kvalitnější counterfactual a AI trénink; konkrétní pořadí je v roadmapě.
