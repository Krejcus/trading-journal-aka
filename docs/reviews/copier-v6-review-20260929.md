# Review V6 obměny spojení (48a8163) — 29. 9. 2026

**V6 review (48a8163 proti 23011e6): kritérium „žádná sonda horší než 23011e6“ NESPLNĚNO.** Tři sondy dopadly hůř než rodič: PI, PH a PJ. Sonda PM navíc ukazuje zhoršení dostupnosti. Worktree jsem neměnil.

**N1 – VYSOKÁ: SL/TP, které leader zadá nebo posune v mezeře, se na followera nedostane; ten zůstane bez SL nebo se starým SL a DISARMED bez auto-close**
- Kde: `services/tradovateBroker.ts:517-521` (`emitBrokerState` během obměny zahodí i entity `order`) a `services/copierRuntimeController.ts:9001-9015` (`route-gap-divergence` → `failClosed(..., { autoClose: false })`).
- Scénář: leader je v obchodě, obměna je vynucená po ≥70 min nebo proběhne závod N3. V mezeře leader (ručně nebo ATM) založí SL+TP, případně posune SL.
  - 23011e6 order entity ze sync odpovědi a z baseline pouštěl live ještě před `resynced`. Controller tak stihl zrcadlit OCO nebo modify a teprve potom DISARM.
  - 48a8163 je zahodí; order skončí jen ve snapshotu, ten nesedí s modelem a následuje DISARM bez ochrany followera.
- Důkaz:
  - PK (broker): nová verze `seq=["connection:resynced"]`, order 43 jen v `resync.orders`; rodič `["order:43","order:43","connection:resynced"]`.
  - PI (SL+TP v mezeře): nová verze `followerStops=[]`, `oco=0`, `armed=false`, follower pozice 1; rodič `followerStops=[29900]`, `oco=1`.
  - PH (posun SL v mezeře): nová verze `stopsAfter=[29900]`, `modifies=[]`; rodič `stopsAfter=[30000]`, `modifies=[30000]`.
- Oprava: během obměny potlačovat jen `fill` a `position` (to je riziko opožděné kopie). Order entity nechat projít live cestou jako v 23011e6 a snapshot porovnávat až potom. Kde zůstane divergence a follower má expozici, nenechávat `autoClose: false` bez ochrany: spustit stavovou recovery (`pendingConnectionRecovery`) nebo povolit risk-redukující zrcadlení a modify bracketů.
- Jistota: mechanismus vysoká. PI a PH emulují výstup brokeru každé verze přes mock; rozdíl ve výstupu brokeru dokazuje PK.

**N2 – VYSOKÁ: resync jedné route obejde agregované spojení routeru, takže jde zapnout ARM, i když leader stream neběží**
- Kde: `services/brokerRouter.ts:247` a `:347` (`listener(scopedResync(...))` se pošle bez ohledu na agregát) a controller `:9004` (`gate = {...gate, connected: true}`).
- Scénář: leader route (critical) spadne v době, kdy follower route dokončuje plánovanou obměnu. Controller přejde na connected=true, Kontrola pozic i ARM projdou a kopírka je ARMED bez leader WS.
- Důkaz PJ (pro critical=true i false): nová verze `afterFollowerResync.connected=true`, `reArm="armed=true"`; rodič `connected=false` a Kontrola pozic skončí chybou „worker nemá živé spojení s Tradovate“.
- Oprava: router scoped resync předá jen při `aggregateConnected` (jinak heartbeat nebo zahodit). Controller v resynced větvi nesmí přejít z disconnected na connected.
- Jistota: mechanismus vysoká. Výskyt vyžaduje překryv výpadku s mezerou nebo grace oknem.

**N3 – STŘEDNÍ: `connectionRenewalBlocker` nevidí události čekající ve frontě controlleru**
- Kde: `copierRuntimeController.ts:11346`.
- Důkaz PD: hned po emitu leader working Market vrací blocker `null` a `groupFlat=true`; po zpracování fronty vznikne kopie (`placed=1`).
- Dopad: pilot se ptá každou 1 s ze samostatné smyčky, takže obměna může začít přesně na vstupu. Kopie pak odchází přes REST do mezery a fill a pozice followera se potlačí. Pokud leader ATM brackety přijdou v mezeře, nastává N1 (follower bez SL), jinak falešný DISARM.
- Oprava: blokovat, dokud má controller frontu neprázdnou, a držet klidové okno asi 5 s po každé leader události.
- Jistota: střední, okno je úzké.

**N4 – NÍZKÁ až STŘEDNÍ (dostupnost, expozice ne hůř než rodič): jeden order bez tvaru rozbije každou obměnu na reálný výpadek**
- Kde: `tradovateBroker.ts:1137`. `buildRenewalSnapshot` vyhodí chybu u jakéhokoli orderu z `/order/list`, který nejde složit, i terminálního nebo z cizího účtu; 23011e6 takový order přeskočil.
- Důkaz PM (zrušený order bez OrderVersion): nová verze 4 sockety během deadline, chyby a `connection:false` (DISARM transport, navíc syncrequesty z limitu 300/h na IP); rodič `connection:true:resynced`.
- Oprava: skládat jen otevřené ordery účtů přiřazených route; při selhání fail-closed jako `route-gap-divergence`, ne jako chyba transportu.
- Jistota: střední. Nevím, jestli REST Tradovate takový order opravdu vrací.

**Bez nálezu nebo stejné jako rodič**
- **(1) fill leadera v mezeře:** leader příkaz poprvé viděný až jako gap fill dává DISARM a nikdy kopii (existující testy). Gap filly jdou do baseline a nepřehrávají se. Filly známých orderů kontrola „poprvé viděný“ ignoruje, pokrývá je ale tvar pozic a orderů. Sonda PA ukazuje, že leader 1 / follower 0 zachytí `follower-position-mismatch` do ~3 s v obou verzích. Doporučuji zpevnit: jakýkoli leader gap fill = divergence.
- **Leader exit v mezeře (PB):** follower zůstane otevřený bez auto-close v obou verzích, tedy ne regrese.
- **(5) závod se snapshotem (PL):** frame přijatý během REST snapshotu se zpracuje po `resynced` právě jednou a v gapFills není. V pořádku.
- **(2) disabled follower (PC):** nová verze drží ARM, falešný DISARM nenastává.
- **(3) trvalý odklad (PE):** po reálném reconnectu se synchronní otevřenou pozicí drží blocker `'connection recovery'` celý obchod, obměna se neudělá a server spojení nakonec zavře. Nastává ale jen ve stavu DISARMED, takže ne hůř než rodič. OSO okno 1,5 s je konečné.
- **(4) V12 a 429:** REST na jednu obměnu ≤ rodič, protože rodič po každém resyncu dělal read-only reconciliation. `/account/list` ve snapshotu je zbytečný.
- **(6) scheduler:** jedna route na poll, rozestup 30 s. Počítá s `Date.now` a po reálném reconnectu stáří nenuluje, stejně jako pilot v rodiči.

**Požadovaná sada na exportu nové verze** (bez mých sond): rc=0, 171 souborů prošlo a 1 přeskočen, 1980 testů prošlo a 1 todo. Žádný flake, izolované opakování nebylo potřeba.

Sondy jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/v6a/`:
- `zzV6RouteGapAdversarial.probe.test.ts` (PA–PJ)
- `zzV6BrokerGap.probe.test.ts` (PK–PM)

Spouští se s `PROBE_VERSION=v6a` pro větev nové verze (jakákoli jiná hodnota = rodič) a `PROBE_OUT=<soubor>` pro log. Oba exporty jsou smazané.