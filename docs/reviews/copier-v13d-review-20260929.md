# Ověřovací review V13 třetí iterace (commit 39978e6)

## Čočka orphans-oso

**Čočka OSIŘELÉ NOHY/OSO a REGRESE, commit 39978e6: 6 nálezů, 3 z nich jsou regrese proti 1a59237^**

Incident z 28. 9. je opravený: terminální nohy se vyřídí bez REST, bez `listOrders` a bez DISARM (sonda P6, vlna 2 v R1b a R7). Není ale pravda, že výsledek je ve všech sondách stejný nebo lepší než 1a59237^. Nové regrese jsou v Q1, Q2, P3, P4, P5 a v O6b/R9 (ta pochází z V12). Worktree jsem neměnil. Všechno běželo jen v exportech `v13d-osirele` (39978e6) a `v13d-osirele-pre` (1a59237^).

## Tabulka sond: 39978e6 vs 1a59237^

Poznámka k metodice: mocky ve starších sondách (zzV13Blokace, zzV13Soubeh, zzRozpocet, zzCancelLens) ignorují parametr `streamOnly`. Čtení ze streamu v nich proto dostávalo falešnou latenci, zdržení nebo chybu jako REST. Tyto sondy jsem pustil ještě jednou jako varianty `zzS_*`, kde mock `streamOnly` respektuje jako produkční Tradovate. Tabulka uvádí výsledek s touto produkční sémantikou.

| Sonda | 39978e6 | 1a59237^ | Verdikt |
|---|---|---|---|
| L1–L3, L5–L9, T2–T7, B1*, B6*, B7, B8*, B9 | nohy zrušené, stav stejný | totéž | stejné |
| L4-new | vyplněná noha 0 cancelů | 1 cancel | lepší |
| L10 (grace vyprší během čtení) | nohy zrušené, ARMED | DISARM, nohy working | lepší |
| T1 | zrušeno, re-entry zkopírováno | totéž (timeout jen při paralelním běhu, samostatně projde) | stejné |
| T8 | 0 REST, 2× `listOrders` | 0 REST, 2× `listOrders` | stejné (původní sonda počítala 62 čtení ze streamu jako REST) |
| B2 (zdržené `listOrders`, varianta BlokacePre) | zrušeno | zrušeno | stejné (B2 s čekáním na cílené čtení v obou verzích timeoutuje, jde o artefakt sondy) |
| B3, B4 (varianta `zzS`) | shodné s pre | shodné | stejné (DISARM v původních sondách je artefakt mocku) |
| B5 | fail-closed, nohy zrušené | totéž | stejné, ale v auditu chybí zrušené nohy (N5) |
| R1–R7 (`zzS_RozpocetStream`) | 0 REST; druhá vlna 0 `listOrders`; R2 1 815 ms; R5 214 ms | 0 REST; 2–6 `listOrders`; 1 810 ms; 214 ms | stejné nebo lepší |
| O1, O1b, O2, O3, O4r | nohy zrušené, ARMED | totéž | stejné |
| O3b (čekající OSO se Suspended dětmi) | děti ponechány | děti zrušeny, vstup zůstal bez SL/TP | lepší |
| O4 | SL/TP nové pozice zrušeny → DISARM → Sell Market 1 | totéž | stejné, audit horší (N5) |
| O5 / P2 (zbytek parentu, pak jeho fill) | +1 bez SL/TP, ARMED, bez chyby | totéž | stejně špatné (N1) |
| O6 / P1 | zbytek parentu Working, ARMED; po fillu +1 bez SL/TP | pre: blokace před exitem (DISARM); P1: totéž | horší / stejně špatné |
| O6b / R9 (multiplier 2, parent 1/2, Exit&Cxl) | Sell Market 2 → **−1** bez SL/TP, DISARM | blokace před exitem, +1 bez SL/TP, DISARM | horší (N2) |
| O7 (osiřelý SL_A z jiné OSO) | SL_A zrušen, ARMED | fail-closed, SL_A working | lepší |
| **P3** (PendingReplace dítě, parent 1/2) | dítě tiše ponecháno, pak Working, ARMED, bez auditu | zrušeno | **regrese** (N4) |
| P3b (parent Filled, pending dítě) | zrušeno | zrušeno | stejné |
| **P4** (pending noha s neznámým parentem + Working SL_A) | 0 cancelů, SL_A Working, DISARM | vše zrušeno, ARMED | **regrese** (N3) |
| **P5** (8 Working noh) | 0 cancelů, DISARM | 6 zrušeno, DISARM | **regrese** (N3) |
| P6 (incident 28. 9.) | 0 `listOrders`, 0 REST, ARMED | 2× `listOrders`, ARMED | lepší |
| **Q1** (bracket noha pending, follower 200 flat uprostřed obchodu) | DISARM + auto-close zdravého 300 (Sell Market, SL/TP zrušeny) | nohy zrušeny, ARMED, 300 nedotčen | **regrese** (N3) |
| **Q2** (bracket noha pending, běžný výstup) | falešný DISARM, TP **Working** nad flat followerem, 0 cancelů | zrušeno, ARMED | **regrese** (N3) |
| R8 (parciální fill leadera i followera) | follower +1 bez SL/TP v živém obchodě, ARMED, ticho | blokace před exitem (DISARM) | horší (N1 + N2) |
| R10 (nejasný modify SL, pak flat s hintem) | žádný stuck | žádný stuck | stejné |

## Nálezy

### N1 — VYSOKÁ (starší chyba, V13 ji neřeší): zbytek parciálně vyplněného OSO parentu zůstane Working, jeho fill otevře pozici bez SL/TP
- **Kde:** `services/copierRuntimeController.ts:1749-1918`
  - Sweep parent nikdy neruší.
  - Při nohách terminálních ve streamu končí na `:1799` a parent vůbec nečte.
  - Fill role `copied-entry` se při flat leaderovi bere jako legitimní (`:3168`, `:7817`).
- **Scénář:** follower má parent 1/2 a dostane se na flat (TP fill nebo exit). Zbytek parentu dál pracuje. Když se vyplní, follower má +1 bez SL/TP a kopírka je ARMED bez `lastError` i bez auditu.
  - V R8 (leader je taky parciální) zůstane follower bez ochrany v živém obchodě, zatímco leader ochranu má.
- **Důkaz:** P1, P2 (obě verze stejně) a R8. Commit message tvrdí opravu tichých zbytků u parciálního OSO, ale opravil jen nohy.
- **Oprava:**
  - Při flat followerovi zrušit zbytek parentu, který má `filledQuantity > 0` nebo jehož leader entry je terminální, spolu s dětmi. Je to risk-redukující cancel, ne obchod. Zapsat audit a zahrnout ho do postkontroly.
  - Pokud je leaderův zbytek legitimně živý, nerušit děti bez parentu. Jinak `failClosed({autoClose:false})` a blokovat ARM.
  - Fill `copied-entry`, který otevře pozici při flat leaderovi, brát jako divergenci.
- **Jistota:** vysoká (test). Četnost je střední: limitní vstupy, multiplier ≥ 2.

### N2 — VYSOKÁ (regrese vůči 1a59237^, původ V12 90cee98, ve 39978e6 beze změny): exit přes „pending exposure“ prodá víc, než follower drží
- **Kde:** `copierRuntimeController.ts:7111-7133`. `exactCurrentPendingExposure` omluví divergenci a pošle celý slice leader × multiplier.
- **Scénář:**
  1. Multiplier 2, follower parent Buy 2 vyplněný 1/2, leader 1/1.
  2. Leader dá Exit&Cxl a vystoupí trhem.
  3. Follower dostane Sell Market 2 nad +1, takže skončí na −1 bez SL/TP. Zbytek Buy 1 dál pracuje, kopírka je DISARM a guard „divergence není autorizovaná k automatickému zavření“ nic nezavře.
  4. Divergenci tu vytvořil obchod samotné kopírky.
- **Důkaz:** O6b a R9. Stejně se chová afae767, takže to nezpůsobila V13. 1a59237^ blokoval exit (`unexplained-position-divergence`), follower zůstal na +1, také bez SL/TP.
- **Oprava:** když pending entry vysvětluje rozdíl, nejdřív zrušit zbytek follower parentu. Exit pak velikostně omezit na skutečný `followerNet` (exit-only), případně vrátit fail-closed před exitem.
- **Jistota:** vysoká (test).

### N3 — STŘEDNÍ (regrese; hlasitá, ale falešný DISARM, žádný risk-redukující cancel a auto-close zdravých followerů): throw ještě před cancelem
- **Kde:**
  - `:1822-1827`: pending noha bez OSO parentu. Bracket/OCO nohy parent z principu nemají, takže sem padají vždy.
  - `:1836-1838`: víc než 6 Working noh.
  - Postkontrola `:1884-1886`.
  - `failSweep` `:1776-1789`, auto-close na `:1788`.
- **Scénáře:**
  - **Q2:** bracket noha v jakémkoli otevřeném, ne-Working stavu (PendingNew/Replace/Cancel, `toOrderStatus` default) při běžném výstupu vede k falešnému DISARM. Druhá noha zůstane Working nad flat followerem s 0 cancely.
  - **Q1:** totéž uprostřed obchodu. Auto-close zavře zdravého followera 300 (Sell Market) a zruší mu SL/TP.
  - **P4 (neznámý OSO parent) a P5 (8 noh):** 0 cancelů. 1a59237^ rušil.
- **Oprava:**
  - Bránu parentu uplatnit jen na nohy v `osoParentByLeg`. Pending bracket nohu rušit jako Working.
  - Neznámý parent a překročený strop zapsat jako failure, ale Working nohy nejdřív zrušit (strop jako v pre: prvních 6).
  - Pak `failClosed({autoClose:false})` s auditem.
- **Jistota:** mechanismus ověřen testem. Četnost závisí na tom, jak často Tradovate u OCO noh ukazuje přechodné stavy (například PendingCancel sourozence po fillu), to je předpoklad.

### N4 — STŘEDNÍ (regrese, tichá): pending dítě otevřeného, ale parciálně vyplněného parentu se tiše přeskočí
- **Kde:** `:1828-1830` (`continue`) a postkontrola `:1880-1882`.
- **Scénář:**
  - Parent je Working s cumQty > 0. Dítě je aktivovaná ochrana, jen přechodně `pending`: PendingReplace při modify, nebo Suspended/PendingNew při resize, zdokumentovaném v PROJECT_LOG 27. 8. jako „11 → 6 → 11“.
  - Follower je flat. Noha se přeskočí bez auditu a kopírka zůstane ARMED. Po dokončení replace noha pracuje nad flat followerem.
- **Důkaz:** P3. 1a59237^ nohu zrušil.
- **Oprava:** výjimku povolit jen pro `parent.filledQuantity === 0`. Jinak dítě rušit, případně v postkontrole brát jako failure.
- **Jistota:** test. Okno je úzké, četnost nízká.

### N5 — NÍZKÁ (regrese auditu) plus stará mezera O4
- **Kde:** `:1869`. Throw při pozici ≠ 0 přijde dřív než audit smyčka na `:1898-1912`.
- **Scénář:** když postkontrola selže na pozici (O4, B5, P7), provedené cancely nejsou v auditu. Zapíše se jen `cancel-failed` bez `brokerOrderId`. 1a59237^ auditoval každou zrušenou nohu.
- **Stará mezera O4:** pozice se před cancelem nekontroluje, takže SL/TP nové pozice se zruší a pak přijde auto-close. Stejně v obou verzích.
- **Oprava:**
  - Auditovat výsledek každého cancelu hned po zápisu.
  - `listPositions` číst souběžně s prvním `listOrders` a při net ≠ 0 nic nerušit (`failClosed({autoClose:false})`).
- **Jistota:** test.

### N6 — INFO
- **Kde:** `:1660-1676` (`Promise.all`).
- **Riziko:** výjimka z `findOrderStatusById({streamOnly})` shodí celý sweep ještě před `listOrders`.
- **Dopad dnes:** v produkci je Tradovate cesta čistě paměťová (throw jen z `numberId`), takže to prakticky nenastane.
- **Doporučení:** chybu brát jako „nevyřešeno“.

## Ověřeno bez nálezu
- **Incident 28. 9.:** 0 REST, 0 `listOrders`, bez DISARM.
- **`streamOnly` se neztrácí:** prochází `brokerRouter.ts:177-190`, `exposureCappedBroker.ts:150-151` a `tradovateBroker.ts:1784-1797`. Jiné wrappery neexistují.
- **Hint už sweep nezužuje:** O7 a L4 jsou lepší.
- **Working noha se ruší bez čtení parentu:** O1, O1b, O2.
- **Suspended děti čekajícího OSO zůstanou:** O3b.
- **Selhání exit-only sweepu:** má `autoClose:false` (`:7383-7387`).
- **Žádný druhý cancel ani blind retry:** 1 cancel na nohu, nejasný výsledek rozhoduje postkontrola.

## Celá sada na exportu 39978e6
`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier tests/brokerRouter.test.ts`: 126/126 souborů, 1 541/1 541 testů prošlo. Žádný z nálezů N1–N5 sada nezachytí.

## Soubory
Adresář scratchpadu: `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`

- **Nové sondy:** `v13d-osirele/tests/`
  - `zzP_Osirele4.test.ts` (P1–P7)
  - `zzQ_Bracket.test.ts`, `zzQ2_Bracket.test.ts`
  - `zzR_Partial.test.ts` (R8–R10)
  - `zzS_*.test.ts` (varianty respektující `streamOnly`)
  - Kopie jsou v `v13d-osirele-pre/tests/`. V pre kopii `zzR_Partial` jsem u R9 odstranil umělý flat event.
- **Výstupy:**
  - `v13d-osirele-probes-{post,pre}.txt`
  - `v13d-osirele-probesS-{post,pre}.txt`
  - `v13d-osirele{,-pre}.{P,Q,Q2,R8,R9,SL}.txt`
  - `v13d-osirele.S.txt`
  - `v13d-osirele-cmp.txt`
  - `v13d-osirele-x-afa.txt` (afae767)
  - `v13d-osirele-suite.txt`

## Čočka budget-queue

# Čočka ROZPOČET/FRONTA/429 pro commit 39978e6: 5 nálezů, žádný vysoký

## Odpovědi na otázky čočky

- **Jeden rozpočet na událost platí jen částečně.** Protective a exit-only sweep sdílejí rozpočet jen uvnitř jednoho position eventu. Paralelně se účty čtou jen v reconciliation. Živé flat eventy více followerů jdou dál sériově přes `eventTail` a každý dostane vlastních 6 s. Vlastní rozpočet mají i:
  - exit-only sweep ve fill větvi (`:7535`),
  - breach a sideline sweep (`:3316`, `:3411`).
- **eventTail pod 10 s neplatí pro 2 a více followerů.** Viz N1.
- **REST po restartu je omezený.**
  - První flat po restartu: 2× `listOrders` a 1× `listPositions` na účet a symbol, nezávisle na délce historie. Historie se vyřeší 124–1 812 lookupy do paměti streamu.
  - U Tradovate to je zhruba 9–11 GET plus cancely.
  - Další flaty mají 0 REST, pokud jsou nohy ve streamu terminální.
  - R7 (3 followeři × 300 historických OSO): 1. vlna 6+3 volání, 2. vlna 0. 1a59237^ má 6+3 v každé vlně.
  - Riziko 429 z minulé review (1 446 čtení na vlnu) je pryč.
- **Latence ostatních followerů se zlepšila nebo je stejná.** Výjimky jsou dvě: cancel sourozence po protective fillu (N2) a zadrhlý REST (N1). Čísla jsou v tabulce D.

## Nálezy

### N1 — STŘEDNÍ: rozpočet platí na event, ne na frontu
Předchozí N3 zůstává z větší části neopravené a tvrzení v commitu „safely below the 10 s heartbeat gate“ platí jen pro jeden event.

- **Kde:**
  - `copierRuntimeController.ts:7764`: nový `createFlatSweepBudget()` pro každý follower flat event.
  - `:9403`: sériový `eventTail`.
  - `:7368`: `lastHeartbeatAt = event.at`, přičemž `tradovateBroker.ts:1234` posílá heartbeat s každou zprávou socketu. Stáří heartbeatu se tak rovná čekání leader eventu ve frontě.
  - `copierRiskGate.ts:139`, `:161`.
- **Scénář:** N followerů je současně flat, nohy mají ve streamu working a každý sweep trvá 2L + cancel. Leader event, který přijde hned za nimi, čeká N×(2L+c). Nad 10 s dostane `stale-heartbeat`, což vede na fail-closed s auto-close.
- **Důkaz (sondy D-B a D-C, 39978e6 / 1a59237^):**

| Sonda | 39978e6 | 1a59237^ |
|---|---|---|
| D-B, L=2,5 s | všechny sweepy OK a nohy zrušené, ale re-entry 3× `stale-heartbeat`, DISARM, fronta 15,5 s | DISARM po 1,5 s, 6 noh zůstane working, fronta 4,5 s |
| D-B, L=8 s | fronta 18 s, nohy working, DISARM | fronta 4,5 s, stejný výsledek |
| D-C (200+300 zlikvidované, 400 v obchodě), L=2,5 s | `stale-heartbeat`, auto-close pošle Sell Market 1 na 400 | sweep deadline, také Sell Market 1 na 400 |
| D-C, L=4,5 / 8 s | fronta 22,6 / 29,6 s | fronta 18,1 / 25,1 s |

- **Hodnocení:** výsledek není horší než 1a59237^ a mezi 1,5 a 6 s je lepší, protože nohy se zruší. Regrese je jen u zadrhlého REST (nad 6 s): fronta, auto-close a mirror cancely čekají zhruba 4× déle.
- **Mezera v testech:** regresní test „R2“ používá `listOrders` 150 ms, takže tohle nezachytí.
- **Oprava:**
  - Rozpočet na vlnu, tedy sdílený objekt, dokud neuplyne. Případně deadline počítat od ingressu eventu: `min(6 s, 10 s − rezerva − čekání ve frontě)`.
  - Jeden globální Tradovate graf na vlnu. `/order/list` je stejně globální, dnes ho každý follower stahuje 2×.
  - Test R2 s L ≥ 2 s a 2–3 followery.
- **Jistota:** test (latence v mocku) a čtení kódu.

### N2 — STŘEDNÍ (regrese vůči 1a59237^): hint protective fillu se ignoruje, cancel working sourozence čeká na globální čtení
- **Kde:** `protectiveFillBrokerOrderId` se nastaví (`:1707`, `:7771`), ale nikde se nečte. `:1801-1805` je `listOrders` před jakýmkoli cancelem.
- **Scénář:** TP se vyplní a SL zůstane working. To je anomálie z 24. 8., kdy otočení přišlo 980 ms po flatu. Stream SL nehlásí jako terminální, takže nejdřív proběhne globální `listOrders` (4–5 GET) a teprve potom cancel.
- **Důkaz (D-E):** cancel SL odešel za 303 / 1 003 / 2 501 ms při L = 0,3 / 1 / 2,5 s. 1a59237^ ho poslal za 0–1 ms.
- **Oprava:** stream-only lookup ať vrací i streamový stav working. Nohu, kterou stream hlásí jako working, zrušit hned. Podle pravidla C se u ní parent nečte a jde o první zápis, ne retry. `listOrders` zůstane jen pro pending a neznámé nohy, rozhodne postkontrola.
- **Jistota:** test. Skutečný dopad závisí na latenci `/order/list`.

### N3 — STŘEDNÍ až NÍZKÁ (regrese, hlasitá): nad 6 working noh se nezruší žádná
- **Kde:** `:1836-1838`. Vyhodí chybu dřív, než se cokoli zruší. 1a59237^ zrušil prvních 6 a teprve potom selhal.
- **Scénář:** 4 add-on OSO dají 8 working noh a follower je flat dřív, než dorazí mirror cancely.
- **Důkaz (sonda F):**
  - 39978e6: 0 cancelů, DISARM „broker stále hlásí 8 pracovních ochranných noh“, 6+ noh dál working. Auto-close flat účet přeskočí.
  - 1a59237^: zrušil až 6 (strop), DISARM „stále 2“.
- **Oprava:** zrušit vše po dávkách v rámci rozpočtu, pak hlasitě selhat v postkontrole.
- **Jistota:** test.

### N4 — NÍZKÁ: jeden flat přechod může dostat až dva rozpočty
- **Kde:** `:7535`, `:3316`, `:3411`, `:7283`.
- **Scénář:** flat přes fill event (exit-only sweep s vlastními 6 s) plus position event (dalších 6 s) dá až 12 s na jeden přechod.
- **Navíc:** exit-only sweep znovu čte `listOrders`, i když protective sweep právě ve stejném eventu udělal čerstvou postkontrolu (+L).
- **Oprava:** předávat rozpočet a snapshot mezi fill a position eventem, snapshot z postkontroly znovu použít.
- **Jistota:** čtení kódu.

### N5 — NÍZKÁ (přetrvává z minulé review, ne regrese): selhání protective sweepu stále plánuje auto-close
- **Kde:**
  - `:1788` (`scheduleAutoClose` bezpodmínečně).
  - `:1639-1640`: kontrola jen `remaining <= 0`, zápis tak může odejít s nulovou rezervou.
- **Důkaz:**
  - D-B při L=4,5 s: cancely proběhly, všechny 3 sweepy přesto selžou na deadline postkontroly, DISARM.
  - D-C při L=4,5 a 8 s: auto-close pošle Sell Market na 400, který je v obchodě spolu s leaderem.
- **Oprava:** `failClosed(..., {autoClose:false})` jako u exit-only. Před zápisem vyžadovat rezervu zhruba na jedno naměřené čtení.
- **Jistota:** test.

## Tabulka dřívějších sond (39978e6 vs 1a59237^)
Sady v13-zruseni, v13-soubeh, v13c-* (Blokace 1–9, BlokacePre), zzO_Osirele a všechny zzF_*: 29 souborů, 116 testů. 39978e6 prošel 116/116, 1a59237^ 113/116. Tři selhání B2 na 1a59237^ jsou artefakt: sonda čeká na `findOrderStatusById`, které 1a59237^ nevolá.

| Sonda | 39978e6 | 1a59237^ |
|---|---|---|
| L1–L3, L5–L9, T1–T7, T9, B1/B1b/B1r, B6/B6x, B7, B8/B8b, O1, O1b, O2, O3, O4r (i zzF varianty) | stejné, liší se jen text auditu | |
| L4-new | 0 cancelů vyplněné nohy | 1 |
| L10 (čtení nad 2 s) | nohy zrušené, ARMED | DISARM „deadline 1500 ms“, nohy working |
| B3 / B4 | DISARM, ale mock nechá stream-only lookup viset nebo házet, což reálný stream-only nedělá (artefakt); účet 300 zrušen v obou | |
| B5 | obě fail-closed „pozice 1“, nohy zrušené | |
| T8 | 2× `listOrders` (plus 62 lookupů v paměti) | 2× `listOrders` |
| O3b | Suspended nohy čekajícího OSO nechá (správně) | zruší |
| O4 | stejné | |
| O7 | osiřelý SL_A zrušen, ARMED | fail-closed |
| O5 | zbytek parentu working bez SL/TP a tiše | totéž, s auditem noh |
| O6 / O6b | Sell Market 2 nad +1 | blok „nevysvětlená divergence“ |

O5 a O6/O6b jsou mimo tuto čočku a nejde o regresi V13: O5 je nevyřešené N4 z osiřelé čočky, O6/O6b pochází z V12.

**R sondy s mockem, který respektuje stream-only** (původní `zzRozpocet` počítá stream-only lookupy jako REST s latencí, což je artefakt):

| Sonda | 39978e6 | 1a59237^ |
|---|---|---|
| R1a | 247 ms, 2+1 volání, 0 čtení po ID | 371 ms |
| R1b, 2. kolo | 0 REST | 2+1 |
| R2 | 1 816 ms | 1 819 ms |
| R3 | 247 ms | 366 ms |
| R4 | 802 ms | 802 ms |
| R5 / R5b | 456 / 449 ms, ARMED | 456 / 458 ms |
| R6 | 949 ms OK | 1 070 ms |
| R7 | 6+3, pak 0 | 6+3 v každé vlně |

**Tabulka D** (L = latence `listOrders`, RTT 150 ms, heartbeat s každou stream zprávou):

| Sonda | 39978e6 | 1a59237^ |
|---|---|---|
| D-B re-entry, L=0,3 s | 2,27 s | 2,70 s |
| D-B re-entry, L=1,4 s | 8,87 s | 9,31 s |
| D-C SL pro 400, nohy terminální ve streamu | ≈320 ms při všech L, 0 REST | 1,48 s (L 0,3), 5,9 s (L 1,4); od L 2,5 s DISARM a Sell Market 400 |
| D-C SL pro 400, nohy working, L=0,3 s | 1,81 s | 2,10 s |
| D-C SL pro 400, nohy working, L=1,4 s | 6,20 s | 6,50 s |
| D-E cancel sourozence | viz N2 | |

## Celá sada
`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier tests/brokerRouter.test.ts` na exportu 39978e6: 126/126 souborů, 1 541/1 541 testů prošlo. Nálezy N1–N5 tedy stávající sada nezachytí.

## Ověřeno bez nálezu
- `streamOnly` projde přes router i exposure wrapper a Tradovate při něm nesáhne na REST.
- Terminální stav je absorpční, takže plnění `orders` mapy z REST v `composeOrder` není problém.
- Reconciliation sdílí rozpočet, sweepy běží paralelně a `listOrders` se v rámci jednoho Tradovate spojení deduplikuje.
- Vyčerpaný rozpočet vždy končí hlasitě.
- Exit-only selhání má `autoClose:false`.
- Zápis se nikdy neopakuje.

Worktree jsem neměnil, pracoval jsem jen s `git archive 39978e6`. Worktree má mezitím cizí změny a HEAD je 0b13040.

Vše je v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- **Sondy:** `v13d-rozpocet/tests/zzRozpocetS.test.ts`, `zzRozpocetD.test.ts`, `zzRozpocetF.test.ts`. Kopie jsou v `v13d-rozpocet-pre/tests/`.
- **Výstupy:**
  - `v13d-rozpocet{,-pre}.probesA.txt`, `.R.txt`, `.D.txt`, `.DC.txt`, `.F.txt`
  - `v13d-rozpocet-cmpA2.txt`
  - `v13d-rozpocet-suite.txt`
  - `v13d-rozpocet.diff`