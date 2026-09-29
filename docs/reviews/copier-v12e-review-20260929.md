# Review V12 páté iterace (fb3459b) — 29. 9. 2026

**Review V12 páté iterace (fb3459b) proti cb5cdf6^: kritérium splněné není, nenasazovat beze změny.**

Pět nálezů HIGH/MEDIUM-HIGH/MEDIUM (1–4 pod čarou, 5 je principiální). Nejvážnější je nová latence exitu u zdravých followerů, a to při každém Market exitu ve skupině s víc followery, i bez jakékoli divergence. Incident C0 projde čistě, i s ING1 a jako burst. Worktree jsem neměnil. Oba exporty jsou smazané.

## Matice

Staré sondy: 61 souborů, 270 testů na obou verzích. Porovnával jsem armed, placed, pozice a otevřené ordery. Shodných klíčů 146, rozdílných 124.

- **Opravy M1–M6 ze čtvrté review ověřené:**
  - SLF extra-1 a short-2: stejné jako pre, SL zůstane.
  - S1bCXFILL: stejné jako pre (exit, follower 0, ARMED).
  - EPR: u neplatného záznamu 0 čtení, u platného 6 čtení jednorázově, při DISARM 0.
  - INC TP a T1–T4: ARMED, žádný falešný DISARM.
  - CXO a M3R: konec flat, bez Stopu.
  - MULTILAT: zdravý A dostane exit za +1 ms (v pre +0 ms).
- **C0 (oba mocky), ING1, C0-burst dup false/true, F0x4, F3:** pre DISARM. fb3459b ARMED, SL i exity 3/5 zkopírované, follower 0.
- **Horší než pre zůstává jen S1bSLOW-2000.** Pre: exit, follower flat. fb3459b: bez exitu, follower +2, DISARM. Viz nález 3.
- **C1 a C3 (ruční modify kopie zpět na dřívější tvar):** nově DISARM bez Stopu. Je to záměrná detekce ručního zásahu, ne falešný DISARM.
- **F1b, F3, M3R:** Stop přechodně visí na flat followerovi, koncový stav je stejný jako pre. Tuhle třídu už znáte.
- **zz-b6budget:** sonda s milisekundovými rozpočty pod zátěží kolísá, pre tu funkci vůbec nemá.

**Nové sondy** (`zn-v12e`, `zo-v12e`, `zp2-v12e`):

| Sonda | cb5cdf6^ | fb3459b | Stav |
|---|---|---|---|
| E1 MULTISER, zpoždění place u 200 = 0 / 800 / 5000 ms | exit 300 a 400 za +0–1 ms | za +3 / **+802** / **+5002** ms | **latence** |
| E7 FIRSTFAIL timeout-hang (place u 200 visí 12 s) | 300 a 400 za +0 ms | za **+12004** ms | **latence** |
| E7 throw-500, reject | – | – | = |
| E3 CXTO-1200 (cancel 1,5 s, kopie se vyplní v 1,2 s) | exit, pak fill kopie, follower 0, ARMED | halt, pak fill kopie, **+8 bez SL**, DISARM | **horší** |
| E3 CXTO bez fillu | otočení na −8, kopie pracuje dál | follower 0, DISARM | lepší |
| **E8 S1bDIS (ruční DISARM, pak leader Market exit)** | 0 volání brokera | 4 REST čtení a **cancelOrder při DISARMED** | **porušení principu** |
| E2 TPSL tp-only / tp+sl / partial | DISARM / DISARM / DISARM | exit a ARMED / DISARM / DISARM | lepší / = / = |
| E5 V16R exit / reverse | A zůstane +2 / A +2 | A dostane exit, 0 / A +2 | lepší / = |
| E6 TPONLY ×3 | DISARM | ARMED, follower flat, bez orderů | lepší |
| E4 COND ×4 | Stop na flat followerovi po externím cancelu kopie | totéž | = (vada existovala už před V12) |

## Nálezy

### 1. [HIGH, nová latence] Per-follower S1b větev serializuje exity všech followerů
- **Kde:** `services/copierRuntimeController.ts:10270-10333` (`Promise.all` volá `processor.process` zvlášť pro každého followera) a `services/copierRunner.ts:2572` (sériový procesor).
- **Scénář:**
  - Exit followera N startuje až po dokončení celého `processLeaderEvent` předchozího followera, včetně broker POST.
  - Platí to pro každý redukující Market ve skupině s víc než jedním followerem, i bez divergence.
  - Pomalý nebo visící POST u prvního followera (v Tradovate až do 45s timeoutu) zdrží exity všech ostatních.
- **Důkaz:** E1 a E7, čísla v tabulce výše. V pre jde fan-out souběžně.
- **Oprava:**
  - O followerech rozhodovat souběžně.
  - Followery bez REST kandidátů (a `filled-synced` / `working-matched`) poslat jedním voláním `processor.process` se společným fan-outem jako v pre.
  - Samostatné volání jen pro followery, kteří čekali na čtení, a nikdy je nestavět ve frontě před rychlé.
- **Jistota:** vysoká.

### 2. [MEDIUM-HIGH, regrese] Kopie se vyplní až po 1s deadline cancelu: sirotek bez SL
- **Kde:** `:8514-8552`. Timeout cancelu, jediné post-read vidí `working`, halt. Pozdější fill nic nezachytí, protože `s1bCanceledZeroFillOrderIds` (`:8554`) se plní jen při potvrzeném zero-fill.
- **Scénář:** leaderův limit je vyplněn, kopie čeká na stejné ceně, leader jde ven trhem, cancel trvá přes 1 s a kopie se mezitím vyplní.
- **Důkaz:** CXTO-1200. Pre: follower 0, ARMED. fb3459b: follower +8 bez SL, leader 0, DISARM, bez auto-close.
- **Kompromis:** bez fillu je nová verze lepší (pre otočí followera na −8).
- **Oprava:**
  - Při ne-terminálním post-read počkat omezeně (≤3 s) na terminál nebo fill kopie ze streamu. Ostatní followeři už díky per-follower větvi exit mají.
  - Pak rozhodnout: filled znamená exit, zero-fill znamená suppression, jinak halt.
  - Fill takto haltnuté kopie při flat leaderovi okamžitě hlásit jako sirotka.
- **Jistota:** vysoká (sonda). Pravděpodobnost nízká až střední.

### 3. [MEDIUM, nedořešený zbytek M6] S1bSLOW-2000 zůstává horší než pre
- **Kde:** `:8497-8503`. Cílené čtení má deadline 1–1,5 s, výsledek `unverified` znamená `pendingReadUnsafeAccounts` a halt bez exitu.
- **Scénář:** kopie je u brokera vyplněná, stream followera se zpožďuje a REST trvá přes 1,5 s. Týká se to jediného followera, nebo pomalého followera ve skupině.
- **Důkaz:** pre dá exit a follower je 0. fb3459b: follower +2, leader 0, DISARM.
- **Oprava:** stejné omezené čekání na stream kopie jako v nálezu 2. Navrhovala ho už čtvrtá review a zatím se neudělalo.
- **Jistota:** vysoká.

### 4. [MEDIUM, princip DISARMED] S1b čte REST a ruší order i při DISARMED
- **Kde:**
  - Market blok v `cutAwareDispatchFor` (`:8454-8560`) nemá bránu `gate.armed` ani `!shadowMode`.
  - `broker.cancelOrder` na `:8520` jde přímo, mimo bránu `dispatchBroker`.
- **Důkaz:** E8 volá `findOrderById`, `listPositions`, `cancelOrder`, `listOrders`, `listPositions` na účtu 200 při DISARMED. Pre nevolá nic. Zrušený je vlastní vstupní order kopírky (snižuje riziko), ale DISARMED má znamenat žádné zápisy. Shadow režim jsem nesondoval.
- **Oprava:** čtení i cancel pustit jen za ARM a mimo shadow a cancel vést přes `haltReason`. Jinak jen zaznamenat.
- **Jistota:** vysoká.

### 5. [LOW] Post-cancel „autoritativní“ čtení nemusí být čerstvé
- **Kde:** `:8098-8100` (`listOrders`) a `tradovateBroker.ts:971` (`listOrders` se připojí k už běžícímu načítání order grafu). Terminální order bez OrderVersion navíc `listOrders` vyfiltruje (`tradovateBroker.ts:2024-2034`), výsledkem je „kopie chybí“ a `unverified`.
- **Dopad:** falešný halt po úspěšném cancelu. Je fail-closed, ne nebezpečný.
- **Oprava:** kopii číst přes `findOrderById` a `listOrders` načíst čerstvě, bez připojení k běžícímu requestu.
- **Jistota:** střední (jen čtení kódu).

### 6. [LOW, návrh] V16 odstraňuje náhodnou pojistku pre
- **Zjištění:** exit zdravému followerovi snižuje riziko jen tehdy, když jeho cache odpovídá brokeru. Když divergence jiného followera pochází ze sdíleného zpoždění OAuth spojení, pre skupinu náhodou zastavil. E5 horší výsledek neukázala.
- **Návrh:** při `unverified` u jiného followera uvolnit exit zdravému účtu jen bez ingress backlogu na jeho účtu.
- **Jistota:** nízká (hypotéza).

### 7. [LOW, hygiena]
- `s1bCanceledZeroFillOrderIds` se čistí jen při resetu (`:12302`).
- `conditionalMirrorSourcesByLeaderEvent` zůstávají položky unsafe followerů.
- Re-evaluace vazeb v reconciliation volá `findOrderById` (`:10622`) bez deadline a bez try/catch. REST chyba shodí reconciliation; archivovaný zdroj nechá vazbu viset a stojí jedno REST čtení na každou reconciliation.
- Refresh epochy přeruší jakýkoli ingress během čtení a pak 30 s neběží. Stale záznam po tu dobu fail-closne při leader SL nebo exitu. To je stejné jako pre, jen horší než 8c2591f. Trvalý stav to není, další pokus přijde po 30 s s prvním eventem.

## Ověřeno bez nálezu
- **Dvojí exit nevzniká:** klíče replikace a `followerFillTargets` jsou per follower a duplicitní sekvence je jen audit. Ověřeno v MULTISER, V16R a FIRSTFAIL.
- **Cancel jen risk-snižující:** SLF je stejné jako pre.
- **Cancel „úspěšný“, ale order vyplněný:** vede na `filled-synced` a exit (S1bCXFILL).
- **Uvolnění vazby při zrcadleném nebo pozdějším fillu:** Stop na flat followerovi po něm nezůstává (TPONLY ×3, T1–T4).
- **Uvolnění vazby terminálním eventem leaderova zdroje:** v sondách Stop na flat followerovi nenechalo (E4).
- **Více opačných pending:** fail-closed stejně jako pre.
- **Smyčka REST čtení:** žádná.

## Testy
- **Požadovaná sada ve fb3459b:** 170 souborů prošlo, 1 přeskočený; 1957 testů prošlo, 1 todo; rc=0.
- **Flake B6/R6:** v běhu se neobjevil. `copierFlatSweepV13` izolovaně 32/32.

Soubory jsou ve `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- **Nové sondy** v `probes/v12e/`: `zn-v12e.test.ts`, `zo-v12e.test.ts`, `zp2-v12e.test.ts`. Potřebují `services/mockBrokerLk.ts` a `tests/_laMock.ts` z `probes/v12d-matice`.
- **Výstupy:** `v12e-all.txt`, `v12e-pre-all.txt`, `v12e-cmp.txt`, `v12e-{,pre-}zn.txt`, `v12e-{,pre-}zo.txt`, `v12e-{,pre-}zp2.txt`, `v12e-suite.txt`; pomocné `v12e-cmp2.py`, `v12e-run.sh`.