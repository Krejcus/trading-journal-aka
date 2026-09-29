# Ověřovací review opravy 6b (68253a7) — 29. 9. 2026

**Balíček 6b (68253a7): kritérium „žádná sonda horší než d954575“ není splněné.** Všech pět nálezů review je opravených. Nová kontrola konzistence snapshotu ale otevírá cestu, na které se osiřelá kopie jiného followera nezavře, přestože ji d954575 zavřel.

## Ověření oprav z review
- **V9 N1 / V4 N1 (sondy PB/P1/P1c):** opraveno. `leaderFlatActiveOrphanLeg` (`copierRuntimeController.ts:5557–5573`) v předkontrole i postkontrole vynechá pending dítě otevřeného nevyplněného OSO parentu. Výsledek: `armed:true`, 0 cancelů.
- **V9 N2 (PC):** opraveno pro variantu, kdy má leader otevřeno (`:5908–5914`). Varianta s flat leaderem (moje sonda R8) dopadá v obou verzích stejně: fail-closed v connection recovery, který tam byl už předtím.
- **V4 N2 (P6):** cancel ochrany už nenastane. P6 ale v 6b končí DISARM s chybou „nekonzistentní snapshot“, kdežto d954575 zůstal ARMED. V sondě je snapshot nekonzistentní trvale, takže DISARM je obhajitelný.
- **V4 N3 (P2):** třetí pokus reconcile (`:9912`) skutečnou změnu nezakryje. Každý pokus čte znovu pod stejnou pojistkou a zastaralý třetí pokus vyhodí chybu. Cancel se neopakuje, protože už zrušené nohy sweep přeskočí.

## Nové nálezy

### N1 — VYSOKÁ závažnost, nízká až střední pravděpodobnost: skutečně osiřelou OSO nohu guard vyhodnotí jako „nekonzistentní snapshot“ a ukončí celý běh
- **Kde:** `:5611–5632` je heuristika (vyplněný OSO parent + otevřená noha + pozice 0), `:5648–5654` je `failClosed({autoClose:false})` a `return`. Obojí proběhne ještě před sweepem a před `evaluateLeaderFlatBatch` pro všechny účty.
- **Scénář R6x:**
  - Kopírka je ARMED. Leader zadá OSO (limit + SL/TP), kopie jde na followery 200 a 300 a všechny vstupy se vyplní.
  - Leader vystoupí přes SL. Stream nedoručí cancel TP leadera ani SL fill a flat followera 200 (mezera při reconnectu).
  - Follower 300 zůstane long 1.
- **Důkaz R6x:**
  - 6b: `pos300:[1]`, `liquidations:[]`, `armed:false`, lastError „nekonzistentní broker snapshot účtu 200 po 3 read-only pokusech (OSO parent mo-1 má fill, ale pozice MNQU6 je ve snapshotu 0)“. TP followera 200 zůstane working, 0 cancelů.
  - d954575: `liquidations:["300:MNQU6"]`, `pos300:[0]`, fail-closed se správným důvodem.
  - Závěr: osiřelá kopie na 300 zůstane otevřená, tedy horší než rodič.
- **Důkaz R6 (jediný follower):**
  - 6b: DISARM a TP zůstane working.
  - d954575: `armed:true` a TP zůstane working bez hlášení.
  - b762714 by podle kódu TP zrušil (předkontrola, pak sweep). U OSO kopií se tak úklid V4 v praxi mění na DISARM.
- **Smyčka watchdogu:** heuristika neřeší linii epochy ani `allowWrites` a epochu nepersistuje ani neukončí. Každý heartbeat proto spustí read-only watchdog a znovu `failClosed`, tedy `onError` a invalidaci reconciliation. Chyby narostly z 1 na 4 po třech heartbeatech. Podle R6r ruční reconcile stav zahojí: TP zruší, výsledek je clean, ARM projde a smyčka skončí.
- **Běžný tok:** falešný DISARM jsem v něm nereprodukoval.
  - R5 a R5m: zrcadlený cancel TP ho uklidí před guardem.
  - R1–R3 (restart): uklidí ho reconcile sweep v connection recovery.
  - Heuristika tedy spustí jen tehdy, když noha přetrvá: chybějící cancel event, PendingCancel déle než zhruba 3 RTT, nebo zpoždění OCO na venue.
- **Oprava:**
  1. Stav „vyplněný parent + flat“ nebrat sám o sobě jako nekonzistenci. Číst pozice, pak ordery, pak znovu pozice. Za nekonzistentní považovat snapshot jen tehdy, když se obě čtení pozic liší nebo je fill parentu (`updatedAt`) novější než první čtení. Jinak jde o skutečnou osiřelou nohu a má proběhnout sweep jako v b762714.
  2. Nekonzistence na jednom účtu nesmí ukončit celý guard. Řádek označit jako `ok:false` a pokračovat do evaluace, aby ostatní followeři dostali exit nebo auto-close.
  3. Nekonzistenci řešit jen při `allowWrites`, nebo epochu persistovat jako `blocked`.
  - Regresní testy: R6x, R6 a počet chyb po heartbeatech.
- **Jistota:** vysoká (deterministická reprodukce).

### N2 — NÍZKÁ: zúžení na linii epochy závisí na `leaderEntryOrderIds`
- **Příčina:** pole se plní jen z `lastLeaderFillOrderId` v okamžiku změny pozice (`:4014`, `:4052`). Legacy epochy ho nemají vůbec. Když pozice přijde před fillem, je prázdné nebo zastaralé.
- **Sweep guardu (`:5554`):** v tom případě nic neuklidí. To je horší než b762714, ale stejné jako d954575. V R4 nohu v obou verzích uklidí reconcile sweep.
- **Exit evidence (`:5504`):** je teď užší než v d954575. Čerstvě vyplněný copier SL mimo linii už nedá settlement wait.
  - R9-noLineage 6b: „follower stav se neshoduje… potvrzené orphan kopie vyžadují cílené zavření“.
  - d954575: „follower exit stále čeká“.
  - Liquidation se v mocku neposlala a s nativní liquidací by byla neškodná. Rozdíl je jen v klasifikaci a hlášení.
- **Oprava:** evidence je jen čtení, takže v `leaderFlatExitEvidence` vrátit rozsah na účet + symbol. Filtr podle linie nechat jen pro sweep a kontrolu osiřelých noh.
- **Jistota:** vysoká pro rozdíl klasifikace, nízká pro praktickou škodu.

### N3 — NÍZKÁ: latence
- **Kde:** guard běží v `eventTail`.
- **Scénář:** sekvenční čtení orderů a pozic trvá 2 RTT místo 1. Při nekonzistenci až 6 RTT, protože pokusy jdou hned po sobě bez pauzy. Po tu dobu čekají leader eventy, například re-entry hned po grace. Retry bez pauzy navíc proti skutečnému zpoždění brokera nepomůže.
- **Oprava:** krátký backoff mezi pokusy, nebo čtení mimo `eventTail`.
- **Jistota:** střední, jen z kódu, neměřeno.

## Prověřeno bez regrese
- **Stopa rozšířená o otevřené symboly leadera (`:5908–5914`):** rodič zavíral celý účet, takže 6b nezavře nic navíc. R8-leaderOpen dopadá v obou verzích stejně.
- **„Expozice mimo stopu = unknown“ (`:5997–6040`):**
  - V běžném ARMED toku nevzniká.
  - Výsledkem je jen `onError` a stav `unknown`, bez smyčky.
  - Oproti d954575 zůstane taková pozice otevřená, ale nahlas nahlášená. To je vědomý design V9.

## Sada testů a sondy
Na exportu 68253a7 skončila předepsaná sada s **rc=0**: 170 souborů prošlo, 1 přeskočen; 1959 testů prošlo, 1 todo. Čísla zahrnují mých 13 sond, bez nich je to 169 souborů a 1946 testů.

Sondy jen zapisují výsledky do souboru z `PROBE_LOG`, nic neověřují. Leží v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/b6b-rev/zzB6bRevProbe.test.ts`. Ve stejné složce je i log sady `b6b-rev-suite.log`. Oba exporty jsem smazal.