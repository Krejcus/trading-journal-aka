# Review V12 čtvrté iterace (8c2591f) — 29. 9. 2026

Adversariální review dvěma čočkami (matice sond + maskování/čerstvost). Srovnání proti cb5cdf6^ (před V12). Verdikt: nenasazovat beze změny — viz nálezy.

## Čočka 1: matice a nové cesty

**V12d (8c2591f), čočka matice a nové cesty: kritérium „nic horšího než cb5cdf6^“ splněné není, nenasazovat.** Staré sondy prošly všechny: žádná není horší než pre a incident C0 projde čistě, i s duplicitním Stopem a jako burst. Nové cílené sondy ale našly šest cest, kde je 8c2591f horší než cb5cdf6^, a jedno nové riziko pro REST limit. Týkají se právě nových mechanismů: cancel v S1b větvi, vázání odvozených orderů a refresh po změně epochy. Worktree jsem neměnil. Plná sada v exportu 8c2591f: 129 souborů, 1610/1610 zelených.

## Matice (cb5cdf6^ → 8c2591f)

**Staré sondy** (zp-*, zq-v12c, zc-stale, zc-hops, zzmask2; 198 klíčů, 111 shodných, 87 rozdílných):

| Sonda | cb5cdf6^ | 8c2591f | Stav |
|---|---|---|---|
| C0 (v12probe2, la-), C0 ING0/1(dup Stop)/2/4, Z1 ×4, Z2 ×2, Z3 ×2, zzmask2 B/C, HOPS | DISARM, SL se nezkopíruje | ARMED, SL i exity zkopírované | lepší |
| C0-burst dupStop false/true | DISARM, follower +8 | Stop 8, Market 3, Market 5; follower 0; ARMED | lepší |
| ING3 (leader position resent) | DISARM | DISARM | = |
| MOD0–MOD5 / MOD6–MOD7 | Stop / DISARM | Stop / Stop | = / lepší |
| R5, R9, S3p, SC1–SC4, SC1d, EP0, Z6 (kontrola a obměna L/F), Z7 ×3 | DISARM | OK | lepší |
| S1b, Z8 Market, Z10(0), MULTI-Market | exit na flat followera, otočení na −8/−2 | kopie zrušena, follower flat, ARMED | lepší |
| O6/O6b | Sell 2 nad +1, otočení na −1 | zrušení zbytku, DISARM bez otočení | lepší |
| Z10(3/7), O6m1 | DISARM, kopie dál pracuje | DISARM, kopie zrušena | lepší |
| zzmask2 E | DISARM, follower +8 bez SL | DISARM, follower +8 se SL | lepší |
| M3 / Z5 Stop | DISARM bez Stopu | Stop na flat followera, po pozdním fillu zrušen, DISARM | = (koncový stav) |
| zzmask2 D | DISARM | DISARM, **Stop 8 zůstane na flat followerovi** | nová cesta (nález 5) |
| S1b-delayed, MULTI-Stop, RC0–2, EP1/EP2 (holý mock), Z9, Z6 s reconcile, O1–O4, R1–R13, N1–N5, S1–S7, ROUTER, M1, M4 | – | beze změny | = |
| Z11 | nejde spustit (pre nemá replaceRoutes) | fail-closed | – |

Dva artefakty sond, které v tabulce nejsou vadou kódu:
- **M3 „after-SL-fills −8“:** sonda naplní i zrušený Stop.
- **D:** v pre se skrytý fill nespustí, protože hook visí na umístění Stopu.

**Nové sondy** (`zm-v12d.test.ts`, `zm2-v12d.test.ts`):

| Sonda | cb5cdf6^ | 8c2591f | Stav |
|---|---|---|---|
| SLF matched | DISARM, SL zůstane | exit zkopírován, ARMED | lepší |
| **SLF extra-1 / short-2** | DISARM, SL zůstane | **SL zrušen**, follower 9/6 bez SL | **horší** (1) |
| **S1bCXFILL** | exit, follower 0, ARMED | follower přeskočen, **+8 sirotek** | **horší** (2) |
| **EPR invalid (i DISARMED)** | 0 REST čtení | **6 čtení na každý event, bez konce** | **nové riziko** (3) |
| SCL scale-in, INC TP-partial-3 | DISARM už při SL, bez SL | SL zkopírován, při legitimním fillu zrušen, DISARM, bez SL | = koncový stav, vada (4) |
| INC TP-full-8 | DISARM při SL | falešný DISARM po běžném TP | = (5) |
| **M3R-reconnect, zzmask2 D** | bez Stopu | **Stop 8 visí na flat followerovi** | **horší** (5) |
| **CXO fill-first / position-first** | follower 0 | **follower −8**; position-first zůstane ARMED i po 5 s | **horší** (5) |
| **S1bSLOW-2000** | exit OK | bez exitu, follower +2, DISARM | **horší** (6) |
| **MULTILAT read-1200 / cancel-5000** | exit zdravého A za 1 ms | exit A za 1204 / 5002 ms | **latence** (6) |
| C0SLOW-1200 | DISARM, +8 bez SL | DISARM, +8 se SL, exity nezkopírované | lepší než pre |
| SCLAG-1/4, S1bRACE, M3R-late-fill | – | – | = nebo lepší |

## Nálezy

### 1. [HIGH, regrese] S1b „unsafe“ zruší ochranný SL followera, který je v pozici
- **Kde:** `services/copierRuntimeController.ts:7693-7700` (`shouldCancelWorking` platí i pro `unsafe`) a výběr kandidátů `:7661-7675`.
- **Scénář:**
  - Leader zadá Sell Stop 8 z flat, tedy SL před vstupem. Kopírka ho eviduje jako pending vstup.
  - Pak Buy Market 8, follower +8.
  - Follower se liší od leadera: ruční kontrakt, odmítnutý add, parciál (9 nebo 6).
  - Leader pošle Market částečný exit. Čtení vrátí `unsafe`, kopírka zruší Stop (ten ale funguje jako SL) a vypne se.
- **Důkaz:** SLF-follower-extra-1 a SLF-follower-short-2:
  - 8c2591f: fOpen `[]`, audit „working vstupní kopie zrušena“, follower 9/6 bez SL.
  - cb5cdf6^: DISARM a `mo-1:Sell:Stop:8` dál pracuje.
- **Oprava:** rušit jen order, který by |freshNet| zvětšil (stejné znaménko jako pozice, nebo follower flat). U `unsafe` zastavit bez zápisu jako pre.
- **Jistota:** vysoká (sonda).

### 2. [HIGH, regrese] Cancel v souběhu s fillem kopie: exit se nepošle a follower zůstane sirotek
- **Kde:**
  - `:7700-7722`: úspěch `cancelOrder` se bere jako „zrušeno“ a follower se přeskočí.
  - `tradovateBroker.ts:1648-1649`: `cancelOrder` se vyřeší i terminálním stavem `filled`. Mock se chová stejně.
- **Scénář (S1b):** leaderův limit je vyplněn, kopie followera stojí ve frontě na stejné ceně, leader jde ven trhem. Kopie se vyplní právě během cancelu.
- **Důkaz:** S1bCXFILL:
  - 8c2591f: follower +8, leader 0, ARMED ještě po 3 s. Po ~9 s přijde jen detect-only DISARM a +8 zůstane bez exitu i bez SL.
  - cb5cdf6^: exit Sell 8, follower 0, ARMED.
- **Oprava:**
  - Po cancelu ověřit terminální stav a `filledQuantity` (stream nebo `findOrderStatusById`). Při `filled` followera nepřeskočit: buď pustit exit po přečtení pozice, nebo zastavit.
  - Každý pozdější fill kopie zrušené v S1b brát jako okamžitý fail-closed.
- **Jistota:** vysoká (sonda + kód adaptéru). Okno je jeden REST round-trip, pravděpodobnost je střední.

### 3. [HIGH, dostupnost] Refresh epochy dělá smyčku REST čtení, hrozí 429 a hodinová blokace
- **Kde:**
  - `:6836-6843`: stale filtr nevylučuje `evidenceInvalid`.
  - `:6904`: neplatný záznam se nikdy znovu neorazí, takže zůstane stale navždy.
  - `:8053`: plánuje se na každém eventu, i po DISARM.
  - `tradovateBroker.ts:525` a `:553-557`: po 429 breaker odmítá všechno REST (place/cancel/liquidate) 1 h.
- **Scénář:**
  - Pending záznam je neplatný (ruční úprava kopie, MOD7-typ event) nebo ho refresh sám zneplatní.
  - Přijde jakýkoli bump epochy (plánovaná obměna po 50–70 min je povolená i s pracujícím limitem).
  - Od té chvíle každý WS rámec spustí `listPositions`, `listOrders` a 2× `findOrderById`. V Tradovate je to ~13–18 REST požadavků na refresh.
- **Důkaz:** EPR-invalid-record i invalid-record-disarmed: 120 čtení na 20 heartbeatů. valid-record: 6 čtení jednorázově. cb5cdf6^: 0.
- **Oprava:** neplatné záznamy z refreshe vyřadit. Pro dvojici epoch povolit jeden pokus, retry jen s backoffem (≥30 s). Bez ARM refresh nespouštět.
- **Jistota:** mechanismus vysoká. Že to spustí 429, je odhad; limity Tradovate jsem neměřil.

### 4. [MEDIUM-HIGH, vada návrhu; koncový stav = pre] Legitimní pozdější fill zdrojové kopie zruší SL
- **Kde:**
  - `:8161-8163` → `:7528-7575`: každý follower fill zdroje ruší závislé ordery. Nerozlišuje, jestli fill proběhl před dispatchem nebo po něm, a nekontroluje, jestli ho leader zrcadlí.
  - Vazba (`:7504-7526`, `:7769-7775`) vzniká i při přesné pozici (`followerNet === expectedPreNet`).
- **Scénář a důkaz:**
  - **SCL:** +2, pracující scale-in Buy Limit 2, SL 2. Scale-in se legitimně vyplní u obou. Výsledek: `zrušeno=mo-3` (SL), follower +4 bez SL, DISARM.
  - **INC TP-partial-3** (sled incidentu): parciál TP 3 zruší SL, follower +5 bez SL.
  - **INC TP-full-8:** každý běžný TP v sledu incidentu skončí falešným DISARM. Incident tedy „projde čistě“, jen pokud obchod skončí Market exitem nebo SL.
- **Oprava:**
  - Vyvrácení platí jen pro `fill.filledAt` < čas dispatche závislého orderu, nebo pro fill, který leader nezrcadlí (leaderCum < fill/multiplier).
  - Jinak vazbu tiše zahodit.
  - Vazbu rušit i při terminálním stavu leader zdroje nebo závislého orderu.
- **Jistota:** vysoká (sondy).

### 5. [MEDIUM, regrese, vzácné] Podmíněný Stop na flat followerovi se nemusí zrušit
- **Kde:**
  - `:8067-8068` a `:8079-8080`: vazby se mažou při error nebo disconnectu.
  - `:7480-7485` (cílené čtení) a refresh zjistí vyplněný zdroj, ale závislé ordery nezruší.
  - `:3527`: pro `copied-exit` pending přechod smaže a nic dalšího neudělá.
  - `:8519`: DISARM `copied-exit` pokrývá jen pořadí fill → position.
- **Důkaz:**
  - M3R-reconnect: Stop 8 zůstane na flat followerovi.
  - zzmask2 D (fill se nedoručí): `open200 ["mo-3:Sell:Stop:8"]`.
  - CXO: SL se spustí dřív, než dorazí pozdní TP fill. Follower skončí na −8; při pořadí position-first zůstane ARMED i po +5 s.
  - cb5cdf6^ má ve všech případech follower 0 a žádný Stop.
- **Oprava:**
  - Vazby nemazat při disconnectu; po reconnectu je vyhodnotit proti REST.
  - Cancel spustit i z cíleného čtení a refreshe.
  - V `rememberFollowerFillCause` při `copied-exit` a flat leaderovi volat failClosed.
- **Jistota:** vysoká (sondy). Výchozí situace je vzácná: vyplní se jen kopie followera a stream je pozadu.

### 6. [MEDIUM, regrese a latence] S1b čtení a cancel blokují exit všech followerů
- **Kde:** `:7640-7728`. `Promise.all` čtení (deadline 1–1,5 s) a `cancelOrder` bez deadline (Tradovate POST až 45 s plus čekání až 5 s) proběhne před dispatchem celé skupiny. `unverified` znamená halt bez exitu.
- **Důkaz:**
  - MULTILAT: zdravý A dostane exit za +1204 ms (pomalé čtení B) a za +5002 ms (pomalý cancel B). V pre za 1 ms.
  - S1bSLOW-2000: bez exitu, follower +2, DISARM; pre exit správně.
  - C0SLOW-1200: exity incidentu se nezkopírují (v pre ale nebyly zkopírované vůbec).
- **Oprava:**
  - Nejistého followera rozhodovat odděleně a ostatním exit poslat hned.
  - Cancel omezit deadlinem 1 s (jako cancel podmíněných orderů).
  - U `unverified` s pracující kopií počkat na stream fill kopie (~3 s) a teprve pak zastavit.
- **Jistota:** vysoká (sondy). REST > 1,5 s je doložený (17. 9.: >15 s).

### 7. [LOW, jen čtení kódu]
- `:7303` a `:7366`: `marketPendingExplainsExpected` obchází celý ingress plot (leader order, follower symbol), ne jen klíče vlastního Market vstupu.
- `:1723-1729`: když zmizí klasifikace (limit 2000 eventů), role je `null` místo `copied-entry`. Posílení lineage se pak neudělá a přechod se jen ověřuje read-only.
- Refresh (`:6924-6931`) může po cíleném S1b čtení zapsat starší REST snímek; plot nevidí změny viditelné jen v REST.

## Ověřeno bez nálezu
- **Plot refreshe:** je per účet, zahodí snímek při ingressu během čtení. Eventy ve frontě dřív jsou starší než REST, jde jen o přechodný stav.
- **Selhání refreshe:** fail-closed je v pořádku, první leader event po bumpu jen zastaví.
- **Retry zastaralé reconciliation:** volající chyby chytají, nová cesta DISARM ani ztráta kontroly nevzniká.
- **Legitimní vstup nové epizody:** S1b `working-flat` zruší opačnou pending kopii jen na skutečně flat followerovi. Follower pak nový obchod vynechá, rizikově to nevadí.
- **Bez blind retry:** cancel se neopakuje, nejasný výsledek znamená halt.

Soubory jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- **Exporty:** `v12d-matice` (8c2591f), `v12d-matice-pre` (cb5cdf6^); do obou je doplněn `services/mockBrokerLk.ts` a do pre `tests/_laMock.ts`.
- **Nové sondy:** `zm-v12d.test.ts`, `zm2-v12d.test.ts`.
- **Výstupy:** `v12d-matice{,-pre}-all.txt`, `-zm.txt`, `-zm-cxo.txt`, `-zm2.txt`, `-zm2b.txt`, `-zm2c.txt`.
- **Srovnání:** `v12d-matice-cmp.txt`, `v12d-matice-worse.txt`.
- **Plná sada:** `v12d-matice-suite.txt`.
## Čočka 2: maskování a čerstvost

**V12d (8c2591f), čočka maskování a čerstvost: nenasazovat beze změny.** Samotný incident 28. 9. prochází čistě, i s duplicitním Stop eventem a jako burst. Všechny dřívější sondy jsou vůči cb5cdf6^ stejné nebo lepší. Nové sondy ale našly tři cesty, které jsou **horší než před V12** (nálezy 2–4). Nález 1 horší než pre není, ale porušuje pravidlo „cancel jen risk-snižující“ a v sousedním běžném toku vrací škodu incidentu. Worktree jsem neměnil.

## Nálezy

### 1. [VYSOKÁ] Podmíněný cancel se spustí i při legitimním zásahu TP: SL zmizí z otevřené pozice a kopírka se vypne
- **Kde:** `services/copierRuntimeController.ts:7528-7572` (`cancelConditionalMirrorWritesAfterLateFill`), volání na `:8162`.
  - Stačí jakýkoli fill zdrojové kopie. Nekontroluje se, jestli se stejně vyplnil i leaderův order.
  - Vazba se nikdy neuvolní, když se zrcadlo potvrdí.
  - Zruší všechny závislé ordery včetně ochranného SL, pak `failClosed(autoClose:false)`.
- **Scénář:** vzor z incidentu (TP Sell Limit 8 z flat, Market vstup, SL). Pak se TP zasáhne u leadera i followera.
- **Důkaz** (`zr-mask4c.test.ts` T1–T4):

  | Varianta | 8c2591f | cb5cdf6^ | afae767 |
  |---|---|---|---|
  | T1/T3 (plný TP) | follower 0, **DISARM** „pozdní fill vyvrátil zero-fill mirror“ | DISARM už u SL | ARMED |
  | T2/T4 (parciální TP 3/8) | SL zrušen, DISARM, **follower +5 bez SL** | DISARM u SL, SL nikdy nevznikl | SL zůstal, ARMED |

  Konečný stav tedy horší než pre není. Je to ale regrese proti afae767 a zrušení SL nad otevřenou pozicí riziko nesnižuje.
- **Oprava:**
  - Při fillu kopie porovnat s fillem leaderova orderu (leaderOrderId si uložit do vazby). Legitimní fill vazbu jen uvolní.
  - Při pořadí „follower první“ nejdřív krátké kauzální okno nebo jedno read-only čtení leader orderu.
  - Když důkaz opravdu padl, rušit jen závislé ordery, které by u followera otevřely nebo převýšily pozici (podle read-only pozice). Ochranný stop nad pozicí ve stejném směru nerušit, jen halt.
- **Jistota:** vysoká (sonda + kód).

### 2. [STŘEDNĚ VYSOKÁ, horší než pre] SL postavený na nevyplněném Market pendingu zůstane na flat followerovi po asynchronním RiskRejected
- **Kde:**
  - `:7285-7304` a `:7365-7372`: `marketPendingExplainsExpected` obchází ingress plot.
  - `:7769-7774`: podmíněné závislosti se registrují jen pro zero-fill mirror, pro Market pending ne.
  - `tradovateBroker.ts` `placeOrder` vrací ack hned; reject přijde později přes commandReport.
- **Scénář:** Market kopie vstupu přijata, pak asynchronně odmítnuta (limit prop účtu). Reject je ještě na cestě a leader zadá SL.
- **Důkaz** (`zr-mask3c.test.ts` F3):
  - 8c2591f: `Sell:Stop:8` na flat followera, ARMED. Po rejectu DISARM (magnitude), ale **Stop dál pracuje**.
  - cb5cdf6^: DISARM bez SL.
- **Oprava:** zápisy odůvodněné Market pendingem evidovat jako podmíněné na tu kopii. Když skončí terminálně s fillem menším než qty, zrušit závislé ordery (jen pokud je follower read-only flat) a zapsat failClosed.
- **Jistota:** mechanismus vysoká. Četnost závisí na asynchronních rejectech.

### 3. [STŘEDNÍ, horší než pre] S1b: kopie se vyplní mezi cíleným čtením a cancelem a „úspěšný“ cancel ji maskuje
- **Kde:**
  - `:7693-7725`: úspěch `cancelOrder` se bere jako „zrušeno bez fillu“ a follower se přeskočí.
  - `tradovateBroker.ts:1648-1649`: `cancelOrder` resolvne úspěšně i u stavu `filled`.
- **Scénář:** leader limit vyplněn, kopie pracuje, leader do pár sekund vystoupí trhem, cena je na úrovni limitu.
- **Důkaz** (`zr-mask2.test.ts` a `zr-mask5.test.ts`):

  | Varianta | 8c2591f | cb5cdf6^ |
  |---|---|---|
  | A1 (cancel „úspěšný“) | **follower +2, leader flat, ARMED ≥1 s**; po ~2 s leader-flat guard | follower 0, ARMED |
  | A3 (cancel odmítnut) | DISARM, +2 | 0 |
  | A2 (parciál) | +1 bez řízení | −1 (stejná velikost) |
- **Oprava:** po cancelu (i po chybě) jedno read-only čtení kopie:
  - `canceled` a fill 0 → skip,
  - plný fill → exit pustit,
  - parciál → halt.
  - Cancel nikdy neopakovat.
- **Jistota:** vysoká.

### 4. [STŘEDNÍ, horší než pre] Dva opačné pendingy při přesné pozici: bez čtení se follower otočí
- **Kde:** `:7668-7675`. Komentář tvrdí „zachová původní přímý exit“, jenže pre tu dělal DISARM (sonda B2 pre).
- **Scénář:** TP1 a TP2 z flat, Market vstup. Fill TP1 kopie jen u followera je ještě na cestě, leader vystoupí trhem.
- **Důkaz** (B1):
  - 8c2591f: `Sell:Market:8` na +4, follower **−4** a TP2 Sell Limit 4 dál pracuje. Pozdní fill ohlásí „zrušeno“ vyplněný Market, pak DISARM.
  - cb5cdf6^: DISARM, +4, TP2 by pozici zavřel.
- **Oprava:** cílené čtení pro všechny kandidáty (jeden `listOrders` + `listPositions`), nebo fail-closed jako pre.
- **Jistota:** vysoká. Výchozí situace je vzácná.

### 5. [NÍZKÁ] Starý potvrzený tvar maskuje ruční modify followera
- **Kde:** `:7129-7137`, `:7156`, `:7259-7262`.
- **Důkaz** (C1): kopie ručně vrácena na dřívější cenu 30380 (pod SL 30400). SL se zkopíruje a kopírka zůstane ARMED.
  - cb5cdf6^ totéž.
  - afae767 DISARM.
  - Nová cena (C3) i qty (C2) → DISARM.
- **Oprava:** starší tvar přijmout jen dokud stream ještě neviděl aktuální potvrzený tvar, nebo porovnávat verzi/`updatedAt`.
- **Jistota:** vysoká.

### 6. [NÍZKÁ] Klamavý audit
- **Kde:** `:7545-7556`, `:7614-7617`.
- **Chování:** vyplněný závislý order se hlásí jako `canceled` a v textu chyby „zrušeno=…“, přestože Market exit proběhl.
- **Oprava:** po cancelu rozlišit `filled`, Market závislé ordery nerušit.

### 7. [NÍZKÁ, poznámka] Závod při obnovení epochy
- **Kde:** `:6905-6906`.
- **Chování:** refresh bere epochu až na konci, takže druhé zvýšení epochy během čtení se „spolkne“. Dopad v praxi kryje už existující díra, kdy se pozice po obnově spojení znovu nenačtou.
- **Oprava:** epochy zachytit na startu a znovu je razit jen při shodě, jinak přeplánovat.

## Ověřeno bez nálezu
- **Objektový ingress plot:** adaptér nevydá obchodní event bez symbolu (`tradovateBroker.ts:650-658` hodí výjimku). Heartbeat, connection a error kryje route epocha. Symbolový klíč followera je nadmnožinou klíče jeho orderu. ING1/2/4 a C0-burst (s duplicitou i bez) projdou, ING3 zůstává fail-closed.
- **Cílené čtení:** jednorázové, s deadlinem, bez retry.
- **Stale reconciliation:** mimo ARM nic nemaskuje. ARM stejně vyžaduje autoritativně flat pozice.
- **Router renewal** (EP s leader-aware mockem): 8c2591f SL zkopíruje, pre dělá DISARM. EP s holým mockem je artefakt.

## Srovnání (8c2591f vs cb5cdf6^)
- **Staré sondy** (49 souborů, 195 testů): žádná horší.
  - Lepší: C0, C0-burst, ING, Z1–Z3, Z6, Z7, SC1–4, MOD6/7, R, MULTI-Market, O6/O6b, Z8 Market, Z10.
  - Stejné: MOD0–5, RC, S1b-delayed, O1–O5.
  - Automatická klasifikace označila 5 případů jako „WORSE“. Ručně jsem je prošel a všechny jsou lepší (žádný exit na flat followera).
  - Pro čistotu: zzmask2 D je artefakt sondy; Z11 v pre nejde spustit (router nemá `routeEpoch`).
- **Nové sondy:**

  | Výsledek proti pre | Sondy |
  |---|---|
  | Horší | A1, A3, B1, F3 |
  | Stejné | A2, B0, C1, C2, F1b, T1–T4 |
  | Lepší | A0, B2, C3, EPla |

## Plná sada v exportu
- 8c2591f: 129 souborů, **1609/1610**. `copierFlatSweepV13` B6/R6 padá v plném běhu 2× ze 2 (armed zůstane true). Izolovaně 3× ze 3 zelené.
- Rodič 8c2591f^ v plném běhu 1547/1547 zelený.
- Je to časová závislost pod zátěží a je potřeba ji vyjasnit před nasazením.

Soubory jsou ve scratchpadu `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- **Exporty:** `v12d-mask` (8c2591f), `v12d-mask-pre` (cb5cdf6^), `v12d-mask-parent` (8c2591f^)
- **Nové sondy:** `zr-mask.test.ts`, `zr-mask2.test.ts`, `zr-mask3c.test.ts`, `zr-mask4c.test.ts`, `zr-mask5.test.ts`, `zr-ep.test.ts`
- **Výstupy sond:** `v12d-mask-probes-{post,pre}.txt`, `v12d-mask-zr*-{post,pre}.txt`
- **Plná sada:** `v12d-mask-suite.txt`, `v12d-mask-suite2.txt`, `v12d-mask-parent-suite.txt`