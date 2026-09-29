# Review V13 čtvrté iterace (1a742cd) — 29. 9. 2026

Adversariální review jednou širokou čočkou, srovnání proti 1a59237^ (před V13).

**Review V13e (commit 1a742cd) proti 1a59237^: kritérium nesplněno — 5 nových nálezů, 2 z nich vysoké, plus 1 vysoký nález starší než V13**

Incident z 28. 9. je opravený pro běžný případ: sonda P6 proběhne bez `listOrders`, bez REST a zůstane ARMED. Pokud ale flat event čeká ve frontě 6 s nebo déle, kopírka se odzbrojí i při terminálních nohách (sonda V5a). Některé sondy dopadají hůř než 1a59237^: O4/P7/V3b, V5a/b, V7, V4 a funkčně V1c. Worktree jsem jen četl, všechno běželo v exportech `v13e` (1a742cd) a `v13e-pre` (1a59237^).

## Dřívější sondy (65 souborů, varianty zzS_* respektují `streamOnly`)

Na 1a742cd prošlo 283 z 286 testů, na 1a59237^ 279 z 285. Všechna selhání jsou B2, tedy stejný artefakt sondy jako v předchozích review (sonda čeká na čtení stavu orderu, které kód nevolá).

| Sonda | 1a742cd vs 1a59237^ |
|---|---|
| L1–3, L5–9, T1–7, B1, B3–9, O1b, O2, O3, P3b, Q1, Q2, F (3 epizody) | stejné |
| P6 (incident 28. 9.), R1–R7, D-B/D-C do L=4,5 s, L4, L10, T8 | lepší (P6: 0 `listOrders` místo 2) |
| D-E s novou sémantikou streamu | lepší: sourozenec zrušen za 1–4 ms (dřívější nález N2 z v13d je opravený) |
| O1, O3b, O5/P2, P1, P3, R8, R9, O6/O6b, O7 | lepší |
| P4 | jiné: zruší osiřelý SL_A a hlasitě selže (DISARM); pre zrušil děti čekajícího vstupu a zůstal ARMED |
| P5, F (4 epizody) | stejné (6 zrušeno, DISARM) |
| **O4 / P7** | **horší** — pozice +1 zůstane bez SL/TP a nic ji nezavře (N1) |
| D-C legs-working, L=8 s | nohy zlikvidovaných účtů 200/300 zůstanou working; pre je zrušil přes auto-close, který ale zavřel i zdravý účet 400 |
| D-B L=300 | re-entry se zkopíruje jako OCO plus holý Limit; jde o starou chybu S1, V13 ji jen častěji vyvolá |

Nové sondy (`zzV_Nove.test.ts`):
- **Horší než pre:** V1c (funkčně), V3b, V4, V5a, V5b, V7.
- **Bezpečnější, ale tiché:** V3c.
- **Lepší:** V2.
- **Smíšené:** V6.

## Nálezy

### N1 — VYSOKÁ (regrese): follower zůstane v pozici bez SL/TP a bez auto-close
- **Kde:** `services/copierRuntimeController.ts:1812-1825` (`failSweep` volá `autoClose:false`), `:1964-1969` (cancel bez předchozí kontroly pozice), `:2057` (pozice se kontroluje až po cancelu), `:3196` (auto-close se spustí jen z prvního `failClosed` v ARMED stavu).
- **Scénář:** parent nové epizody se vyplní dřív, než kopírka zpracuje flat předchozí epizody.
  1. Sweep zruší SL/TP nové pozice.
  2. Postkontrola najde pozici 1 a odzbrojí bez auto-close.
  3. Následná kontrola divergence už auto-close nespustí, protože kopírka je odzbrojená.
- **Důkaz:**

  | Sonda | 1a742cd | 1a59237^ |
  |---|---|---|
  | V3b po 5 s | pozice +1, SL/TP zrušené, `placed:[]` | `Sell Market 1` do 0,3 s |
  | O4 | žádný pokyn k zavření | `Sell Market 1` |

- **Oprava:** číst `listPositions` před prvním cancelem (souběžně s ostatními čteními). Při net ≠ 0 nerušit žádnou nohu a zavolat `failClosed`. `autoClose:false` povolit jen při autoritativně potvrzeném flat.
- **Jistota:** vysoká (sonda). Četnost: nízká až střední (rychlý re-entry).

### N2 — VYSOKÁ (regrese): rozpočet od příchodu události do fronty nechá osiřelé nohy bez jediného pokusu o cancel
- **Kde:** `:8634-8636` (rozpočet začíná při příchodu události / začátku vlny), `:1669` (při vyčerpaném rozpočtu výjimka ještě před jakoukoli prací), `:1692-1697` (i čtení stavu z paměti streamu je pod rozpočtem).
- **Scénáře a důkaz:**
  - **V5b:** leader exit drží frontu 7 s (pomalý `placeOrder` pro účet 300, REST timeout je 45 s). Flat účtu 200 čeká ve frontě a skončí DISARM „celkový deadline 6000 ms“. Nohy mo-2 a mo-3 dál working nad flat followerem, cancel 0×. Pre: vše zrušeno, ARMED.
  - **V5a** (terminální nohy, obdoba 28. 9.): DISARM při 0 REST. Pre: ARMED.
  - **V7:** v jedné vlně má účet 200 cancel trvající 6,5 s. Sweep účtu 300 selže před cancelem a jeho nohy mo-5 a mo-6 zůstanou working. Pre: nohy účtu 300 zrušené.
- **Odpověď na otázku ke sdílenému rozpočtu vlny:** tiché to není (DISARM plus audit `cancel-failed`). Jeden pomalý účet ale ostatním sebere cancel, který riziko snižuje.
- **Oprava:**
  - Čtení stavu ze streamu (z paměti) a první cancel nohou, které stream potvrzuje jako working, provádět vždy, bez ohledu na rozpočet.
  - Rozpočet uplatnit jen na REST čtení a každému účtu dát minimální čas od začátku jeho sweepu.
  - Když jsou všechny nohy ve streamu terminální, skončit bez kontroly rozpočtu.
- **Jistota:** vysoká (sondy). Riziko je nejvyšší právě při zpomalení Tradovate.

### N3 — STŘEDNÍ (funkční regrese, tichá): zrušení parentu, když je leaderův vstup `filled`, ale leader pozici stále drží
- **Kde:** `:1890-1899` a `:1948-1958`. Terminální stav leaderova vstupu zahrnuje i `filled` a kód nekontroluje, jestli je leader flat.
- **Scénáře:**
  - **V1c** (scale-in): leader má +2 z e1 a vyplněného add-on e2, kopie e2 u followera legitimně čeká. TP e1 dostane followera na flat, leader drží +1. Sweep zruší čekající vstup mo-4 a follower zůstane 0 proti leaderovi +1, ARMED, `lastError` null až do dalšího leader exitu. Pre: čekající vstup zůstal, vyplnil se se SL/TP a pozice odpovídala leaderovi.
  - **V3c:** stejně se zruší vstup nové epizody.
- **Bezpečnost:** follower je flat, tedy v bezpečí, jen se tiše rozejde s leaderem.
- **Audit:** zrušení vstupu se zapíše jako `canceled` s důvodem „ochranná noha autoritativně nepracuje“ (`:2045-2055`), což je zavádějící.
- **Oprava:** parent rušit jen tehdy, když je leaderův vstup `canceled`/`rejected`, nebo `filled`/partial a leader je v symbolu flat. Parciálně vyplněný parent rušit jen tehdy, když leaderův vlastní vstup už nepracuje. Pro zrušený vstup použít vlastní důvod v auditu.
- **Jistota:** vysoká (sonda).

### N4 — STŘEDNÍ až NÍZKÁ (regrese, hlasitá): postkontrola dá přednost opožděnému streamu před čerstvým REST
- **Kde:** `:2000-2005` a `services/tradovateBroker.ts:1790-1795`.
- **V4:** potvrzení cancelu vyprší, protože stream je pozadu. REST už hlásí `canceled`, stream stále working. Výsledek: falešný DISARM. Pre: ARMED.
- **Vedlejší účinek:** i volání bez `streamOnly` (obnova v `copierRunner.ts:96-100` přes `copierCancelOutbox.ts:185`) teď dostanou working ze streamu a stav zůstane `unknown` tam, kde by `/order/item` stav vyřešil. Je to fail-closed, jde jen o průchodnost.
- **Oprava:** terminální stav z libovolného zdroje má přednost. Autoritu streamu pro working omezit na `streamOnly`.
- **Jistota:** vysoká (sonda). Nastane jen při zpožděném streamu.

### N5 — NÍZKÁ až STŘEDNÍ: zastaralý snapshot sdílený ve vlně
- **Kde:** `:8181-8210` (snapshot orderů se použije pro celou vlnu) a `:1919` (noha chybějící ve snapshotu se zapíše jako terminální do `sweptProtectiveLegs`, které se maže jen na `:10291`).
- **V6:** flat 200, leaderova OSO e2 a flat 300 přijdou v jedné vlně. Výsledek: falešný DISARM a nohy e2 se natrvalo vyřadí ze všech dalších sweepů. Po skončení epizody zůstanou working nad flat účtem 300 bez cancelu.
- **Podmínka:** leader a followeři na stejném spojení a události ve stejném frame. U Filipa (Lucid a Tradeify na různých loginech) to pravděpodobně nenastane.
- **Oprava:** nohu chybějící v cizím nebo starém snapshotu brát jako neznámou, ne jako terminální. Snapshot vlny nepoužívat, pokud byl mezitím zpracován dispatch.
- **Jistota:** střední (mock vrací snapshot ze začátku requestu).

### S1 — VYSOKÁ, ale starší než V13 (není regrese, jen ji V13 častěji vyvolá)
- **Kde:** `services/copierBracketCorrelator.ts:99-104` a controller `:8929`.
- **Chyba:** inference bracketu přiřadí nohy nové OSO (s `parentOrderId` čekajícího vstupu) k jinému vstupu, který se vyplnil do 1,5 s. Followerům pak odejde nativní OCO dřív než vstup a vstup se zkopíruje jako holý Limit. Follower má working SellStop a SellLimit, zatímco je flat, a dotek ceny na TP úrovni otevře short bez ochrany.
- **Důkaz:** reprodukováno i na 1a59237^ (`zzV_Guard`, L=0). 1a742cd okno rozšiřuje (D-B L=300).
- **Oprava:** když má noha `parentOrderId`, který nepatří známému vyplněnému vstupu, neodvozovat bracket a nechat ji OSO korelátoru.

## Ověřeno bez nálezu
- Pending bracket/OCO noha se ruší jako working (Q1, Q2).
- Pending dítě parciálně vyplněného parentu se ruší (P3).
- Do stropu 6 noh se ruší a pak hlasité selhání (P5).
- Hint zruší sourozence bez globálního čtení (D-E).
- Při neznámém parentu se nejdřív zruší prokazatelně working noha (P4).
- Pozdní fill vstupu, který sweep rušil, vede na DISARM (P1, P2).
- Audit obsahuje jen skutečně zrušené ordery.
- Nikde se neopakuje zápis (write) naslepo.
- Každé vyčerpání rozpočtu končí hlasitě.

## Celá sada v exportu 1a742cd
`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier tests/brokerRouter.test.ts`: 129 z 129 souborů, 1618 z 1618 testů prošlo. Žádný z nálezů N1–N5 ani S1 sada nezachytí.

Soubory jsou ve `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- **Exporty:** `v13e/`, `v13e-pre/`
- **Nové sondy:** `v13e/tests/zzV_Nove.test.ts` (V1–V7), `zzV_Guard.test.ts`, `zzW_RozpocetD.test.ts`; kopie jsou ve `v13e-pre/tests/`
- **Výstupy:** `v13e-probes-{post,pre}.txt`, `v13e-cmp.txt`, `v13e-V-{post,pre}.txt`, `v13e-V7-{post,pre}.txt`, `v13e-guard-{post,pre}.txt`, `v13e-W-D.txt`, `v13e-suite.txt`