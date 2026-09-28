# Adversariální re-review V12 (commit 90cee98)

## Čočka regressions

**Verdikt: 90cee98 nenasazovat.** Opravuje většinu nálezů z první review a incident z 28. 9. v čistém sledu (C0) projde. Zavádí ale dvě nové regrese proti oběma předchozím stavům (cb5cdf6^ i cb5cdf6) a oprava incidentu je v produkčních podmínkách křehká. Všechny tři nálezy mám potvrzené testem. Že je způsobil 90cee98, jsem ověřil exportem 1a59237 (V13), kde všechny nové sondy dopadají jako na cb5cdf6.

**Metodická poznámka:** holý `mockBroker.findOrderById` nezná leader ordery vstříknuté přes `emitEvent` a vrací `null`. Staré sondy proto na 90cee98 falešně ukazují DISARM (C0, R5, R6, R9, R13, S3…). Sondy jsem spustil ve dvou variantách: s holým mockem a s obalem `tests/_laMock.ts`, kde `findOrderById` leader ordery vidí stejně jako Tradovate REST. Commitnuté testy dělají totéž přes `vi.spyOn`. V tabulce jsou výsledky s obalem.

## Nálezy

### 1. [CRITICAL] Zrušená čekající kopie zůstane natrvalo „invalidní“: DISARM a exit/SL se nezkopíruje až do konce ARM session
- **Kde:**
  - `services/copierRuntimeController.ts:7036-7046`: terminální follower order bez plného fillu se nesmaže, jen dostane trvalý `evidenceInvalid`.
  - Leader strana má stejné chování na `7062-7072`.
  - Příznak se spotřebuje na `7317-7321` a na `7417`, kde vede na divergenci.
  - Záznam maže jen ARM, disconnect a reconciliation (`8931-8934`, ta terminální záznam maže).
  - cb5cdf6 i cb5cdf6^ záznam při terminálním stavu mazaly.
- **Scénáře (všechno běžné toky):**
  - R7: zrušený pending TP.
  - R7b: limit entry z flat zrušen, později Market vstup a SL.
  - R7c: totéž, pak celý scalp. Market exit se nezkopíruje, follower zůstane +2 při flat leaderovi.
  - O1: zrušený OSO bracket entry.
  - P1: limit 4 vyplněný 2/2 na obou stranách, zbytek zrušen, pak SL.
- **Důkaz:** všude cb5cdf6^ = SL/exit zkopírován a ARMED, cb5cdf6 = totéž, 90cee98 = „nevysvětlená divergence“ a SL/exit se nezkopíruje. Sondy: `la-v12probe2` (R7), `la-r7b`, `la-oso-cancel`, `la-p1`.
- **Oprava:** terminální follower order (canceled/rejected/expired) má záznam smazat, stejně jako reconciliation prune. Osiřelý leader order pak chytí přísná kontrola. Sondy R7/R7b/R7c/O1/P1 přidat jako testy.
- **Jistota:** vysoká, ověřeno testem.

### 2. [HIGH] Maskování: u plně vyplněného leader orderu se `evidenceInvalid` ignoruje, exit/SL jde na flat followera
- **Kde:**
  - `copierRuntimeController.ts:7311-7323`: `leaderFullyFilled` přeskočí nastavení `invalidEvidence` bez ohledu na `pending.evidenceInvalid`. Celý `remaining` se přitom dál započítá do `pendingNet`.
  - Potom `7403-7415` uzná `exactCurrentPendingExposure`.
  - Spolu s nálezem 1: zrušený záznam zůstane a „vysvětlí“ chybějící pozici.
- **Scénář:**
  1. Kopii limitu followera někdo třetí zruší nebo zmenší (ruční zásah, propka), leaderův order dál pracuje.
  2. Leader limit se vyplní.
  3. Do ~2 s (`followerTransitionCorrelationWindowMs`) přijde leader exit nebo SL.
- **Důkaz:**
  - Sondy N2, N3, N4 (Market i Stop): 90cee98 pošle `Sell:Market:2` nebo `Sell:Stop:2` na flat účet a kopírka zůstane ARMED. cb5cdf6^ i cb5cdf6 skončí DISARM bez zápisu.
  - N2t: magnitude check po 2 s sice vypne kopírku (`autoClose:false`), ale nekrytý `Sell:Stop:2` u followera dál pracuje. Když přijde exit až po 2,5 s, magnitude check to chytí dřív.
  - Market exit tedy otevře protipozici, Stop zůstane nekrytý. Obojí porušuje „nic se neopravuje obchodem“.
- **Oprava:** `if (pending.evidenceInvalid) invalidEvidence = true` vždy, i u plného leader fillu. Spolu s opravou 1 jako testy N2/N3/N4 s očekáváním DISARM bez follower zápisu.
- **Jistota:** mechanismus ověřen testem. Výchozí situace (zásah třetí strany do kopie) je méně častá.

### 3. [HIGH, spolehlivost] Oprava incidentu padá, jakmile během REST čtení přijde jakýkoli event
- **Kde:**
  - `copierRuntimeController.ts:7174` + `7194`: výsledek čtení se zahodí, když se změní globální `tradeBoundaryObservationVersion`.
  - Ta verze se zvyšuje při příchodu každého order/fill/position eventu z libovolného účtu (`9562-9564`).
  - Čtení (`7362-7364`) běží uvnitř eventTail.
  - `findOrderById` v `tradovateBroker.ts:1767-1781` (přes `loadOrderGraph`, `958-963`) dělá na každé volání 4–5 REST requestů. Mezi nimi je globální `/command/list`, který v incidentu V13 trval 4,8 s. Timeout je 45 s.
- **Rozsah pro 4 followery:** ~33–36 requestů před zkopírováním SL, ×2 na každou pending kopii a followera. Leader order se čte 4× duplicitně a čte se i pro on-fill followery.
- **Důkaz (`la-f-fence`):**

  | Sonda | cb5cdf6^ | cb5cdf6 | 90cee98 |
  |---|---|---|---|
  | F0/F0x4 (bez souběžného eventu) | DISARM | Stop | Stop |
  | F1 (další order event téhož leader Stopu během čtení) | DISARM | Stop | DISARM, Stop 0 |
  | F2 (opakovaný leader position event) | DISARM | Stop | DISARM, Stop 0 |

  Vůči cb5cdf6^ to regrese není, ale cíl opravy (SL zkopírovat) splněný není.
- **Hypotéza k produkci:** Tradovate posílá k jednomu ručnímu Stopu několik order eventů (order, orderVersion, executionReport) v řádu desítek ms. Okno čtení je stovky ms až sekundy. Souběh je tedy pravděpodobný a výsledkem je stejná škoda jako při incidentu.
- **Oprava:**
  - Hlídat změny jen u relevantních objektů: leader order, follower order, fill a pozice follower účtu, leader pozice symbolu.
  - Při porušení udělat omezený opakovaný pokus jen se čtením (žádné zápisy) v krátkém deadline, pak fail-closed.
  - Lehký lookup bez `/command/list` a `/fill`.
  - Leader lookup sdílet mezi followery a číst jen pro followery, jejichž režim event přijímá.
- **Jistota:** mechanismus ověřen testem, produkční frekvence je hypotéza.

### Poznámky (nízká závažnost)
- **S1b** (leader Limit vyplněn, kopie ještě pracuje, leader Market exit): 90cee98 se vrátil k chování cb5cdf6^. Exit jde na flat followera, kterému dál pracuje Buy Limit 8 (riziko −8). cb5cdf6 tu zastavil. Není to regrese proti stavu před V12, ale zlepšení z cb5cdf6 se ztratilo.
- **Reconciliation fence** (`8917-8928`, jen čtení kódu): ruční „Kontrola pozic“ za ARM se souběžným eventem označí všechny pending záznamy trvale invalidní. U nevyplněných to vede na DISARM při dalším exitu, u plně vyplněných nemá kvůli nálezu 2 žádný účinek.
- **Blind retry ani zápis na zastaralých datech** jsem nenašel. Chyba čtení vede na `continue` a pak fail-closed. `positionsByAccount` se přepisuje až za kontrolou fence.

## Srovnání sond (s leader-aware mockem)

| Sonda | cb5cdf6^ | cb5cdf6 | 90cee98 | Stav |
|---|---|---|---|---|
| C0 incident (Stop, částečný exit, exit) | DISARM | OK | OK | opraveno (bez souběhu, viz nález 3) |
| R1, R2, R2b, R3 on-fill/on-submit, R11, R12 | OK | DISARM | OK | regrese cb5cdf6 opraveny |
| S4 (bez/s leader fillem), S5, S7 | OK/OK, OK, OK | OK/DISARM, DISARM, DISARM | OK | opraveno |
| R5, R2p, S3p (posun ceny) | DISARM | OK | OK | lepší |
| R6, S3, R2-mask (změna qty) | OK | DISARM | OK | opraveno |
| R9 (symetrický partial TP) | DISARM | DISARM | OK | lepší |
| R10 fill (samostatný SL) | DISARM | OK | OK | lepší |
| R13 (OSO pending) | DISARM | OK | OK | lepší |
| S6 (router blip, follower u brokera 0) | DISARM | Stop (maskování) | DISARM | opraveno |
| M3-probe (vyplněné zrcadlo nepozorováno) | DISARM | Stop + nekrytý Stop | DISARM bez zápisu | opraveno |
| M1, M3-mask, M4, R8, R10 working, S1, N1, N5, ROUTER single | fail-closed | fail-closed | fail-closed | beze změny |
| ROUTER nekritický follower | DISARM | OK | OK | lepší (follower je +8) |
| S1b | exit na flat | DISARM | exit na flat | jako před V12 |
| **R7, R7b, R7c, O1, P1 (cancel)** | OK | OK | **DISARM, SL/exit nezkopírován** | **nová regrese** |
| **N2, N3, N4 (kopie zrušena/zmenšena, leader filled)** | DISARM | DISARM | **exit/SL na flat followera** | **nové maskování** |
| F1, F2 (event během REST) | DISARM | OK | DISARM | proti cb5cdf6 horší |

Sondy M2, S2 a R4 v dodaných souborech nejsou. V12mask obsahuje M1, M3, M4, R1, R1b, R2 a R2p.

## Plná sada
V exportu 90cee98 jsem spustil `npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier`: 124 souborů, 1489/1489 zelených. Žádný test nepokrývá nálezy 1–3. Worktree jsem neměnil.

Soubory jsou ve scratchpadu `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- Exporty: `v12b-regrese` (90cee98), `v12b-regrese-pre` (cb5cdf6^), `v12b-regrese-cb5`, `v12b-regrese-v13`.
- Nové sondy: `la_mock.ts`, `n-mask.test.ts`, `n2t.test.ts`, `f-fence.test.ts`, `r7b.test.ts`, `p1.test.ts`, `oso-cancel.test.ts`. V exportech jsou jako `tests/la-*.test.ts` a `tests/_laMock.ts`.
- Výstupy: `v12b-regrese-la-post.txt`, `v12b-regrese-la-pre.txt`, `v12b-regrese-la-cb5.txt`, `v12b-regrese-probes-post.txt`, `v12b-regrese-probes-pre.txt`, `v12b-regrese-suite.txt`.

## Čočka masking-latency

**V12b (90cee98), čočka maskování a latence: 90cee98 opravuje nálezy první review, ale přináší 1 kritickou regresi a 5 dalších nálezů. V této podobě nenasazovat.**

Oprava původních nálezů je potvrzená sondami:
- vlastní fill leadera už kopírku nevypne (R1–R3, S4, S5, S7, R11, R12),
- změna množství a ceny limitu projde (R2, R2p, R5, R6, S3, S3p),
- symetrický částečný fill projde (R9, Stop 5 se zkopíruje),
- skrytý reconnect nekritické follower routy teď končí zastavením (S6),
- fill kopie followera bez fillu leadera končí u SL zastavením (M3).

Nová kritická regrese ale vrací škodu incidentu 28. 9. (nezkopírovaný SL, DISARM, follower v pozici) v běžném toku.

**Poznámka k harnessu:** výchozí mock vrací z `findOrderById` jen příkazy, které sám založil, ne leaderovy příkazy vstříknuté přes `emitEvent`. Proto jsem sondy pouštěl ještě s obalem `mockBrokerLk.ts`, který leaderovy příkazy zná jako skutečný Tradovate. Se samotným mockem vyjdou R2, R6 a S3 jako DISARM, ale to je chyba mocku. Skutečná regrese je jen R7.

---

### 1. KRITICKÁ (regrese, mimo čočku) – zrušená kopie limitu zůstane natrvalo „neplatná“, další SL/exit vypne kopírku a nezkopíruje se
- **Kde:** `services/copierRuntimeController.ts:7036` a `:7045` (`terminalWithoutFullFill`), strana leadera `:7062–7073`. Záznam se maže jen při plném fillu (`:7031–7034`). Mapa se čistí jen při ARM, chybě nebo odpojení (`:7573`, `:7583`, `:9481`). V cb5cdf6 i dřív se záznam při terminálním stavu kopie smazal.
- **Scénář A:**
  1. Leader zadá Buy Limit 2 z flat a pak ho zruší; kopírka úspěšně zruší i kopii.
  2. Leader nakoupí Market Buy 2, pak zadá SL Stop Sell 2 → „nevysvětlená divergence“, DISARM, Stop se nezkopíruje.
  3. Leaderův Market exit se nezkopíruje, follower zůstane +2.
  - Totéž platí pro R7 (zrušení TP limitu zadaného z flat). Podle kódu stejně skončí i zrušená nativní OSO vstupní objednávka a stop-entry.
- **Důkaz (sonda A, R7-lk):**

  | Stav | Výsledek |
  |---|---|
  | cb5cdf6^ | Stop i exit zkopírovány, ARMED |
  | cb5cdf6 | Stop i exit zkopírovány, ARMED |
  | 90cee98 | `armed:false`, placed jen `Buy:Limit:2, Buy:Market:2`, follower `netQuantity:2` |

  Commitnutý test „leader cancel“ pokrývá jen osiřelou kopii, úspěšné zrušení kopie netestuje.
- **Oprava (ověřená patchem, sada 1489/1489, A i R7 projdou):**
  ```ts
  } else if (!isOpenOrderStatus(event.order.status) && followerCoreShapeValid && followerFillValid) {
    currentRuntimePendingExposure.delete(event.order.brokerOrderId);
  } else { ...
  ```
  Terminální kopie nemá budoucí expozici. Osiřelá kopie je dál otevřená, takže zůstane fail-closed.
- **Jistota:** ověřeno testem.

### 2. VYSOKÁ – oplocení čtení zahodí důkaz při jakékoli události kdekoli, takže oprava V12 v reálném časování většinou selže
- **Kde:**
  - Plot `:7191–7194` porovnává globální `tradeBoundaryObservationVersion`.
  - Ten se zvyšuje při příchodu každé `order`/`fill`/`position` události libovolného účtu a symbolu (`:9562–9564`).
  - Zahozený důkaz vede přes `:7320` k DISARM na `:8686–8700`.
- **Scénář:** během REST čtení přijde cokoli z tohoto:
  - navazující `order` událost téhož leaderova SL (adaptér vydá na jedno zadání víc `order` eventů: order, orderVersion, executionReport),
  - zpožděný fill nebo pozice followera ze vstupu (0,6–2,9 s podle V11),
  - pozice jiného účtu nebo symbolu.
  - Výsledek: DISARM, SL se nezkopíruje.
- **Důkaz (sonda B):**

  | Varianta | cb5cdf6 | 90cee98 |
  |---|---|---|
  | bez události (`none`) | SL zkopírován | SL zkopírován |
  | navazující event leaderova SL | SL zkopírován | DISARM, SL nezkopírován |
  | pozice jiného symbolu (MESU6) | SL zkopírován | DISARM, SL nezkopírován |
  | pozdní pozice followera ze vstupu | SL zkopírován | DISARM, SL nezkopírován |

  Sonda E: leader zavře pozici během čtení → po čtení DISARM, SL ani exit se nezkopírují, follower zůstane +8 bez SL (pre stejně, cb5cdf6 vše zkopíroval).
- **Oprava:**
  - Plot omezit na události účtu followera pro daný symbol a na obě order ID.
  - Při zásahu plotu čtení 1–2× zopakovat. Jde o idempotentní čtení, ne o blind retry zápisu.
  - Teprve potom fail-closed.
- **Jistota:** mechanismus ověřen testem. Že se události v produkci skutečně překryjí s čtením, je dobře podložená hypotéza.

### 3. STŘEDNÍ – čtení běží v eventTail a blokuje frontu až do 45s REST timeoutu; celou dobu je kopírka ARMED s divergentním followerem
- **Kde:**
  - `:7362–7364` čeká na `Promise.all` přes followery, kandidáti jednoho followera jdou sekvenčně (`:7173`).
  - Volá se z `handleBrokerEvent` (`:8420`, `:8525`, `:8686`) a z časovače SL přes eventTail (`:8263–8269`).
  - `flushStandaloneOsoEntry` běží mimo eventTail (`:8481`), ale k čtení se dostane jen u redukujícího OSO vstupu.
  - V adaptéru: `tradovateBroker.ts:522` (45 s na request) a `findOrderById` → `loadOrderGraphUncached` (`:955–986`). To jsou 4 paralelní requesty, pak případně `/executionReport/list` a hydratace kontraktu, obojí sekvenčně.
  - Watchdog na zaseknutý eventTail neexistuje.
- **Důkaz (sonda E, čtení 1,5 s):** během zaseknutí `armed:true`, leader 0, follower +8, exit neodeslán. Po timeoutu DISARM a follower zůstane +8 bez SL (`slow-timeout`). Selhání je fail-closed, ne tiché propuštění.
- **Oprava:**
  - Vlastní krátký deadline pro tato důkazní čtení (1–2 s) a pak okamžitě fail-closed.
  - Nedržet eventTail 45–90 s.
- **Jistota:** ověřeno testem (zpoždění), délky timeoutů z kódu.

### 4. STŘEDNÍ – REST dávka na každou redukující událost, 429 zablokuje celé spojení na hodinu
- **Kde:**
  - `:7180–7185` čte leaderův order jednou za každého followera, bez deduplikace.
  - `findOrderById` v Tradovate = `/order/item`, `/orderVersion/deps`, globální `/command/list` a `/fill/deps` (sonda F `restCalls`).
  - 429 zapne v adaptéru jistič: `tradovateBroker.ts:553–560`, `:396–411` blokuje všechny REST na 1 h, včetně place/cancel/Flatten.
- **Důkaz (sonda C):**
  - 4 followeři → 12 čtení na jeden SL, leaderova L-lim 4×. V Tradovate zhruba 33 HTTP requestů.
  - 429 při čtení: DISARM, `findCalls 2`, žádný zápis ani opakování. **Blind retry to není.**
  - Samotná dávka ale může limit vyvolat: pak neprojde kopie SL a hodinu ani nouzové zavření.
- **Oprava:**
  - Leaderův order číst jednou na událost.
  - Ordery followerů číst jedním listem na spojení, `/command/list` sdílet.
- **Jistota:** počty ověřeny, limity Tradovate jsou hypotéza. Komentář v kódu k 17. 9. uvádí, že throttling spustilo už ~25 requestů.

### 5. STŘEDNÍ – REST čtení „spolkne“ pozdější stream fill a nová kontrola to spouští na horké cestě
- **Kde:**
  - `tradovateBroker.ts:984`: REST `rememberFill` zapíše fill mezi „emitted“.
  - `:1102`: `if (!rememberFill(fill)) continue;`, takže stream fill se už nikdy neemituje.
  - Leader `filled` vzniká výhradně z Fill (`copierLeaderEventSource.ts`).
- **Důkaz (sonda F, skutečný adaptér):**
  - `findOrderById` vidí fill 3 a pozdní WS Fill téhož ID vydá `fillEvents: 0`.
  - Nepřijde ani aktualizovaný order (`["working:0"]`).
- **Dopad:** refresh čte follower kopii (WS followera je pozadu o 0,6–2,9 s) i leaderův TP při částečném fillu. Ztratí se:
  - `filled` leader event (on-fill followeři nedostanou slice),
  - `trackLeaderFill` a `trackFollowerRiskFill` (denní risk a day-lock),
  - uvolnění exit-only rezervací.
- **Oprava:** oddělit množinu fillů „započteno do fillTotals“ od „emitováno“. Stream fill vždy pustit přes `emitMappedFill` (dedup podle `deliveredFillIds`).
- **Jistota:** mechanismus ověřen testem. Je to starší bug adaptéru, 90cee98 ale výrazně zvyšuje jeho četnost.

### 6. NÍZKÁ–STŘEDNÍ (maskování) – stará autoritativní značka přežije neúspěšné nové čtení
- **Kde:**
  - Při `catch` (`:7186–7190`), neautoritativním výsledku (`:7195`) a `!zeroFill && !matchedPartial` (`:7271`) se `authoritativeMirrorKind` nemaže.
  - `:7306–7310` ji použije, dokud se globální verze pozorování nezmění.
  - Tím se porušuje komentář na `:7187`.
- **Scénář D:**
  1. Ve frontě čekají dvě události: Stop Sell 8 a Market Sell 3.
  2. Eventy followera se tiše ztrácejí (skrytý výpadek).
  3. Follower TP se vyplní jen u brokera.
  4. Druhé čtení skončí timeoutem nebo 429.
- **Důkaz:** po Market Sell 3 zůstane kopírka ARMED, follower je reálně −3 a leader +5.
- **Oprava (ověřená patchem, D pak skončí zastavením, sada 1489/1489):** na začátku každého pokusu značku smazat (`initial = {...stale, authoritativeMirrorKind: undefined, authoritativeObservationVersion: undefined}`). Lepší je značku vázat na konkrétní leader event.
- **Jistota:** ověřeno testem. Předpoklady jsou vzácné.

### 7. NÍZKÁ – polknutá příčina a zavádějící DISARM
- **Kde:** `catch {}` (`:7186`) a zásah plotu nic nezaudituje.
- **Dopad:** důvod zastavení je „nevysvětlená divergence účtů“ (B, C, E), i když pozice seděly. Selhalo jen čtení (429 / timeout / plot). Obsluha pak hledá neexistující divergenci.
- **Oprava:** audit „V12 důkaz neověřen: <příčina>“.

**Hypotéza, neověřeno:** `:7242` přepíše celou mapu pozic účtu z REST, i když se důkaz nepotvrdí. Může se tak rozejít s `exitOnlyPositionApplied`: dvojité započtení exit-only fillu by vedlo k falešnému fail-closed, ne k zamaskování.

### Ověřeno bez nálezu
- **Retry:** žádný blind retry, zápis se po selhaném čtení neopakuje.
- **Chyba čtení:** 429, timeout i neautoritativní odpověď končí zastavením (kromě nálezu 6).
- **Neatomické paralelní čtení** (pozice a order se čtou v různých okamžicích): nesouměrná zastaralost dává nesoulad → fail-closed. Souměrný fill na obou stranách dává zrcadlový stav.
- **Router s nekritickým followerem:** S6 (pozice 0 během mezery) → zastavení. Nezměněný stav → SL správně zkopírován.
- **Reconciliation:** plot reconciliation zastaralá data jen zneplatní.
- **Rozdíly mezi stavy:** proti cb5cdf6^ se výsledky starých sond liší jen tam, kde 90cee98 kopíruje správně, a v R7 (nález 1).

**Sada `npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier`:**
- export 90cee98: 124 souborů, **1489/1489**,
- 90cee98 s patchi A+D: 1489/1489.

Worktree jsem neměnil, vše běželo ve scratchpadu (`/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`):
- Sondy: `zzmask2.test.ts` (A–E), `zzfillsupp.test.ts` (F), `mockBrokerLk.ts`.
- Exporty:
  - `v12b-mask` = 90cee98,
  - `v12b-mask-pre` = cb5cdf6^,
  - `v12b-mask-cb5` = cb5cdf6,
  - `v12b-mask-fix` = 90cee98 + probe patche A a D.
- Výstupy:
  - `v12b-mask-probes-{pre,post}.sorted`,
  - `v12b-mask-lk-{pre,post,fix}.sorted`,
  - `v12b-mask-suite.txt`, `v12b-mask-fix-suite.txt`.