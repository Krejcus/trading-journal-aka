# Adversariální review V12 třetí iterace (commit afae767)

## Čočka matrix

**V12c regresní matice (afae767): nenasazovat bez opravy nálezu 1.** Proti cb5cdf6^ jsem našel dvě nové regrese v běžných tocích (nálezy 1 a 2) a jedno znovu zavedené maskování (nález 3). Nález 4 regrese není, ale oprava incidentu v produkčním časování drží jen napůl.

Co afae767 opravuje: C0 v čistém sledu, rodinu R7 (zrušená kopie), maskování N2–N4, S6 a nově i scale-in limit čekající během SL/TP/exitu (SC1–SC4, cb5cdf6^ tu vypínal). Plná sada v exportu afae767 prošla: 126 souborů, 1529/1529. Test ~1119 („current-runtime working entry neschová manuální follower pozici…“) je zelený. Worktree jsem neměnil, vše běželo ve scratchpadu.

## Nálezy

### 1. [HIGH, regrese] Úprava čekajícího limitu, pak fill leadera a SL: SL se nezkopíruje a kopírka se vypne
- **Kde:** `services/copierRuntimeController.ts`
  - `:6942-6976`: follower order event se srovnává s *aktuálně* očekávanou qty/cenou. Starší, ale legitimní verze (pozdě doručený event z umístění nebo mezilehlý modify) nastaví trvalé `evidenceInvalid`.
  - `:6983-6985`: leader strana invaliduje při změně `orderType` (převod Limit→Market).
  - `:7061-7076`: `updatePendingExposureAfterConfirmedModify` si nepamatuje předchozí tvary a neaktualizuje `orderType`.
  - `:7091`: nové „evidenceInvalid vždy“ pak vede na divergenci i po plném fillu leadera.
- **Scénář (okno R12):** leader Buy Limit 2, upraví cenu, limit se u leadera vyplní, kopie ještě pracuje (nebo fill followera má zpoždění 0,6–2,9 s), leader zadá SL. Je to typické i pro ATM bracket, který SL pošle hned po fillu.
- **Důkaz** (`zq-v12c.test.ts`):

  | Sonda | cb5cdf6^ | fb9fb39 | afae767 |
  |---|---|---|---|
  | MOD1 (modify, placement event followera zpožděn) | Stop | Stop | **DISARM, Stop 0** |
  | MOD2 (dvě rychlé úpravy za sebou, bez zpoždění) | Stop | Stop | **DISARM, Stop 0** |
  | MOD2h (totéž se zpožděním) | Stop | Stop | **DISARM, Stop 0** |
  | MOD5 (převod Limit→Market) | Stop | Stop | **DISARM, Stop 0** |

  Instrumentace potvrdila příčinu: `ev lp 30490` proti očekávané `30480`. Pro jistotu: MOD0 (jediná úprava bez zpoždění) projde ve všech třech verzích.
- **Oprava (ověřený prototyp):**
  - Záznam si pamatuje tvary, které kopírka sama potvrdila. Otevřený event se starším potvrzeným tvarem není anomálie.
  - `updatePending…` přenáší i `orderType`. Leader kontrola porovnává jen symbol a stranu.
  - Výsledek: MOD1–MOD7 projdou, sada 1529/1529, staré sondy beze změny.
- **Jistota:** vysoká (test + instrumentace).

### 2. [MEDIUM-HIGH, regrese] Guard S1b vypne kopírku i při pouhém zpoždění fillu followera a exit se nezkopíruje
- **Kde:** `:7164-7169` (`filledLeaderWorkingLimit`) a `:7266-7270`. Blokuje Market exit, pokud stream vidí follower kopii jako working a `followerNet === 0`.
- **Scénář:** rychlý scalp z limitu. Obě strany se u brokera vyplní, fill a pozice followera ještě nedorazily, leader do ~1–3 s vystoupí trhem.
- **Důkaz:**
  - S1b-delayed:
    - cb5cdf6^: exit zkopírován, follower 0, ARMED.
    - afae767: DISARM bez exitu, follower zůstane +2 bez řízení, leader je flat.
  - MULTI-Market (A vyplněn, B kopie pracuje):
    - cb5cdf6^: A exit, B −2 s pracujícím Buy Limit.
    - afae767: zastaví se celá skupina a ani zdravý A nedostane exit, zůstane +2.
  - S1b se skutečně pracující kopií: afae767 skončí DISARM bez zápisu, ale kopie Buy Limit 8 zůstane pracovat. Když se vyplní, follower je +8 bez SL.
  - Guard je navíc neúplný: O6/O6b (parciál followera 1/2, leader Market exit) dál posílá `Sell Market 2` nad +1 a otočí followera na −1. Stejně jako cb5cdf6^ a fb9fb39. Moje varianta O6m1 bez OSO končí DISARM všude.
- **Oprava:**
  - Jen v této vzácné větvi udělat jedno omezené cílené čtení kopie a pozice followera (deadline 1–2 s, mimo horkou cestu).
  - Kopie vyplněna → exit pustit. Pořád working → blokovat jen tohoto followera a pracující vstupní kopii zrušit (rizikově redukující cancel, ne obchod).
  - Podmínku rozšířit na `followerNet !== expectedPreNet`. Ověřeno: O6/O6b pak skončí DISARM bez zápisu, sada zelená.
- **Jistota:** vysoká (test). Četnost závisí na zpoždění streamu followera.

### 3. [HIGH, maskování, vzácné] Stream-only důkaz věří zpožděnému streamu followera a vznikne nekrytý Stop
- **Kde:**
  - `:7108-7110`: `ingressClear` vidí jen eventy, které už do workeru dorazily.
  - `:7135-7141`: `zeroFillMirror`.
- **Scénář (M3):** kopie čekajícího TP limitu se u brokera vyplní jen u followera, eventy ještě letí, leader zadá SL.
- **Důkaz** (`zp-m3probe`, `zp-la-m3probe`):
  - cb5cdf6^: DISARM bez zápisu. fb9fb39: také DISARM bez zápisu.
  - afae767: `Sell:Stop:8` na followera, který je u brokera flat. Po doručení eventů DISARM, ale Stop se nezruší. Když se spustí leaderův SL, follower skončí −8.
  - Je to návrat chování cb5cdf6, které 90cee98 opravil. Moje automatická klasifikace to omylem vedla jako „lepší“, protože přibyl zápis.
- **Oprava:**
  - Stop zadaný na základě zero-fill mirroru evidovat jako podmíněný.
  - Když do ~5 s dorazí fill té kopie (tedy důkaz byl nepravdivý), Stop zrušit (cancel, ne obchod), zapsat audit a DISARM.
  - Případně jedno lehké čtení samotné follower kopie jen v této větvi.
- **Jistota:** mechanismus vysoká (test), výchozí situace vzácná.

### 4. [HIGH spolehlivost, ne regrese] Ingress plot po celých účtech: oprava incidentu v reálném časování drží jen napůl
- **Kde:** `:7108-7110` a účtování `:9447-9474` (per account, bez symbolu a bez vlastního orderu).
- **Důkaz:**
  - C0 + duplicitní order event téhož Stopu (Tradovate adaptér emituje `order` pro order, orderVersion i executionReport), cizí symbol followera nebo leadera (ING1/2/4), nebo znovu poslaná leader pozice (ING3): afae767 DISARM, Stop 0, tedy přesně incident.
  - C0-burst (order+fill+pozice Market exitu v jednom ticku): Stop se zkopíruje, ale parciální i finální exit skončí DISARM a follower zůstane +8.
  - EP1/EP2 (plánovaná obměna WS po 50–70 min, bump epochy routy): DISARM.
  - Router nekritický follower: vrátil se na DISARM jako cb5cdf6^. To je daň za S6 a je to v pořádku.
  - cb5cdf6^ ve všech těchto sondách končí také DISARM.
- **Oprava (ověřený prototyp):** na straně followera počítat backlog jen pro účet+symbol, na straně leadera jen eventy téhož pending leader orderu (pozice leadera a eventy redukujícího orderu ne). ING1/2/4 a C0-burst pak projdou, ING3 dál fail-closed, sada 1529/1529, staré sondy beze změny (kromě O6 a E, obojí k lepšímu).
- **Jistota:** mechanismus vysoká. Že adaptér pošle sourozenecké eventy dřív, než controller dojde k rozhodnutí, je hypotéza podložená `await` před `cutAwareDispatchFor`.

### 5. [LOW] Plot reconciliation
- **Kde:** `:8781-8792`.
- **Chování:** jakýkoli event čtených účtů během čtení vede na throw a `lastError`. Kontrola pozic odzbrojuje ve všech verzích (RC0), takže nový DISARM to není.
- **Dopad:**
  - občasné falešné odmítnutí ARM,
  - pokusy recovery po reconnectu (5× po 2 s) mohou padat během sync burstu,
  - reconciliation po terminal-fill přepíše původní `lastError`.
- **Oprava:** pravděpodobně stačí jen zahodit snapshot bez nastavení `lastError` a zkusit znovu.
- **Jistota:** sondy RC1/RC2 plus čtení kódu.

**Poznámka (hypotéza, neověřeno):** `brokerRouter.ts:132` `routeEpoch` hodí výjimku u účtu bez routy (`:100-104`). Controller ji nechytá (`:6796`), výsledkem by byl failClosed. Prakticky nepravděpodobné.

## Srovnávací tabulka

afae767 dává s holým i leader-aware mockem stejné výsledky (1 rozdíl z 57, jen časování).

| Scénář | cb5cdf6^ | fb9fb39 | afae767 | Stav |
|---|---|---|---|---|
| C0 incident, čistý sled | DISARM | OK (la) | OK | lepší |
| C0-burst / ING1–4 / EP1–2 | DISARM | DISARM | DISARM, případně Stop + DISARM na exitu | nález 4 |
| R1, R1b, R2b, R3 on-fill/on-submit, R11, R12, S4, S5, S7 | OK | OK | OK | beze změny |
| R2, R6, S3 (qty) | OK | DISARM (raw) | OK | = |
| R2p, R5, S3p (cena) | DISARM | OK | OK | lepší |
| R7, R7b, R7c, O1 cancel, P1, A | OK | DISARM | OK | regrese 90cee98 opravena |
| R9, R10 fill, R13 | DISARM | OK | OK | lepší |
| SC1–SC4 (scale-in limit čeká) | DISARM | DISARM | OK | lepší (SC1d dup → DISARM) |
| MOD6 (zvýšení qty) | DISARM | OK | OK | lepší |
| MOD7 (qty + zpožděný event) | DISARM | OK | DISARM | = pre |
| **MOD1, MOD2, MOD2h, MOD5** | **Stop** | **Stop** | **DISARM** | **nález 1** |
| N1–N5, N2t, D | DISARM | exit/SL na flat (N2–N4, D) | DISARM bez zápisu | maskování opraveno |
| S6 | DISARM | DISARM | DISARM | = |
| **M3-probe** | **DISARM bez zápisu** | **DISARM** | **Stop na flat, nekrytý** | **nález 3** |
| M1, M3-mask, M4, R8, R10 working, S1, ROUTER single | fail-closed | fail-closed | fail-closed | = |
| ROUTER nekritický follower | DISARM | OK | DISARM | = pre |
| S1b (kopie pracuje) | exit na flat | exit na flat | DISARM bez zápisu (limit dál pracuje) | lepší |
| **S1b-delayed / MULTI-Market** | **exit OK** | **exit OK** | **DISARM, bez exitu** | **nález 2** |
| MULTI-Stop | OK | OK | OK | = |
| O6/O6b | Sell 2 nad +1 | totéž | totéž | beze změny, nález 2 |
| F0–F3, zzmask2 B/C/E | DISARM | část DISARM | OK (není REST) | reálný analog viz ING |
| O2 | OK | DISARM | DISARM | V13, mimo čočku |

Sondy M2, S2 a R4 v dodaných souborech nejsou.

Všechno je ve scratchpadu `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- **Exporty:** `v12c-regrese` (afae767), `v12c-regrese-pre` (cb5cdf6^), `v12c-regrese-90c` (fb9fb39)
- **Nové sondy:** `zq-v12c.test.ts` (MOD, ING, SC, S1b-delayed, O6m1, MULTI, RC, EP, C0-burst); staré sondy jsou v exportech jako `tests/zp-*`
- **Výstupy starých sond:** `v12c-regrese{,-pre,-90c}-probes.txt`
- **Výstupy nových sond:** `v12c-regrese{,-pre,-90c}-zq.txt`
- **Srovnání:** `v12c-regrese-compact.txt`
- **Plná sada:** `v12c-regrese-suite.txt`
- **Prototyp oprav 1, 4 a O6** (sada 1529/1529): `v12c-regrese-proto.patch`, kopie `v12c-dbg3`

## Čočka staleness

**V12c (afae767), čočka zastaralost a maskování: nenasazovat beze změny.** Incident C0 v čistém sledu projde a S1b, R7, N2–N4 i router blip S6 jsou opravené. Pojistka čerstvosti ale nebere v úvahu zpoždění streamu followera, které je naměřené (0,6–2,9 s, při zamrzlém socketu až 15 s). Ve dvou sondách to vede k maskování, které před V12 nebylo: výstup odejde na followera, který je u brokera už flat. Dále vidím tři fail-closed nedostatky: kvůli nim se oprava v běžných podmínkách vrací ke škodě incidentu. Worktree jsem neměnil.

## Nálezy

### 1. VYSOKÁ – vyplněná kopie followera, o které stream ještě neví, pustí exit nebo SL na flat followera (regrese proti cb5cdf6^ i 90cee98)
- **Kde:** `services/copierRuntimeController.ts`
  - `:7105-7154`: důkaz čerstvosti je jen „stejná route epocha + prázdná fronta přijatých eventů“. Eventy, které jsou ještě na cestě, nepokrývá.
  - `:1768-1771`: každý order z outboxu, i zkopírovaný exit, má roli `copied-entry`. Kontrola přechodu `:7866-7893` proto otevření pozice exitem při flat leaderovi bere jako legitimní.
  - `:7908`: magnitude check běží jen při `leaderNet≠0`.
  - `copierLeaderFlatGuard.ts:641`: leader-flat guard pak jen detekuje, nic nezavře.
- **Scénář:**
  1. TP kopie (Sell Limit 8) se u brokera vyplní, leaderův TP ne.
  2. Stream followera je pozadu.
  3. Leader v okně zpoždění pošle Market exit nebo SL.
- **Důkaz:**
  - **Z5 Market:** afae767 pošle `200:Sell:Market:8`, follower skončí na −8. Kopírka zůstává ARMED ještě 3 s po doručení eventů. Pak přijde jen detect-only DISARM a pozice −8 zůstane otevřená. cb5cdf6^ skončí DISARM bez zápisu a follower zůstane 0.
  - **Z5 Stop a la-m3probe:** Stop 8 odejde na flat followera a stav je ARMED. Po doručení eventů přijde DISARM (`autoClose:false`) a `Sell:Stop:8` dál pracuje bez krytí. cb5cdf6^ skončí DISARM bez zápisu.
- **Oprava:**
  - Kontrola přechodu `:7866`: když je leader flat a pozici followera otevřel fill zkopírovaného exitu, okamžitě DISARM (role podle směru leader eventu, ne vždy `copied-entry`).
  - Market redukci krytou výjimkou nad pending kopií na opačné straně pozice (typ TP) neposílat bez čerstvého důkazu. Buď ji blokovat, nebo udělat jedno cílené čtení (kopie + pozice followera, deadline ≤1 s).
  - Když později dorazí fill kopie, o kterou se výjimka opřela, zrušit ordery odeslané na jejím základě. Zrušení riziko snižuje, nejde o obchod.
- **Jistota:** mechanismus ověřen testem. Pravděpodobnost v produkci je nízká: kopie followera stojí ve frontě za leaderem, takže fill kopie bez fillu leadera je vzácný. Dopad je vysoký.

### 2. STŘEDNÍ – po každé obměně socketu nebo blipu se výjimka pro už čekající kopie trvale ztratí
- **Kde:**
  - `brokerRouter.ts:250-254`: epocha se zvýší i při plánované obměně (`connected:true, resynced`).
  - `copierRuntimeController.ts:7105-7107`: záznam si drží epochu ze vzniku a nikdo ho znovu neoraží.
  - `scripts/copier/pilot.ts:1122-1137`: obměna po 50 min, když není otevřený obchod, i s čekajícími limity. Dvě spojení.
- **Scénář:** TP nebo entry limit zadaný z flat, pak obměna socketu, pak vstup a SL. Výsledek: DISARM, SL se nezkopíruje, follower zůstane v pozici (škoda jako při incidentu).
- **Důkaz (Z6):** leader-renewal i follower-renewal skončí DISARM a SL chybí. Kontrola bez obměny SL zkopíruje. cb5cdf6^ skončí DISARM vždy.
- **Oprava:** po zvýšení epochy naplánovat mimo horkou cestu read-only čtení pozic a orderů účtů té route. Záznamy, které sedí, oražení na novou epochu. Do té doby fail-closed.
- **Jistota:** mechanismus vysoká. Četnost je odhad (přibližně 2·D/50 min pro kopii čekající D minut).

### 3. STŘEDNÍ – čítač přijatých eventů je po účtech, ne po objektech; falešný DISARM na hraně jednoho mikrotasku
- **Kde:** `copierRuntimeController.ts:9448-9474` (inkrement a dekrement) a `:7108-7110`.
- **Důkaz:**
  - **Z1:** druhý order event téhož leader Stopu přijde synchronně nebo o jeden mikrotask později → DISARM, SL nezkopírován. Přijde-li v dalším makrotasku, projde.
  - **Měření:** kontroler se ke kontrole dostane za 4 mikrotask kola (paměťový i souborový store). Skutečný `tradovateBroker` vydá druhý order event téhož Stopu z jednoho WS rámce (order + executionReport) po 4 kolech. Rozhoduje tedy jedno kolo.
  - **Z2:** Market částečný exit s vlastním fillem ve stejném ticku → DISARM, exit nezkopírován.
  - **Z3:** event jiného symbolu na účtu leadera nebo followera → DISARM.
  - **zzmask2 E:** exit se nezkopíruje, follower zůstane +8 při flat leaderovi (se zkopírovaným SL).
  - cb5cdf6^ skončí DISARM ve všech případech, takže nejde o regresi.
- **Oprava:** čítač vázat na relevantní klíče: follower (účet, symbol), leader pozice symbolu a obě order ID pending záznamu. Eventy orderu, který kontrolu spustil, a jiné symboly ignorovat.
- **Jistota:** mechanismus vysoká. Produkční četnost závisí na tom, jak Tradovate slučuje eventy do rámců. Adaptér s rámcem order + orderVersion počítá (`tradovateBroker.ts:1072-1080`).

### 4. STŘEDNÍ – SL zadaný v okně zpoždění followera po vstupu vede na DISARM (škoda incidentu)
- **Kde:** `copierRuntimeController.ts:7134`. `followerNet === expectedPreNet` nezapočítá Market kopii vstupu, která je ještě na cestě.
- **Důkaz (Z7):**
  - Eventy vstupu followera dorazí před SL: SL se zkopíruje.
  - Dorazí se SL nebo po něm: DISARM, SL nezkopírován.
  - cb5cdf6^ skončí DISARM ve všech třech variantách. 90cee98 tento případ zvládal díky REST čtení.
- **Oprava:** podmínku změnit na `followerNet + zbytek Market pendingů v aktuální epoše bez fillu === expectedPreNet`. Kód už tento předpoklad pro Market ACK připouští (`:7157`).
- **Jistota:** test. SL zadaný do přibližně 3 s po vstupu je běžný tok.

### 5. STŘEDNÍ (existovalo už před V12, mimo diff) – router spolkne `resynced`
- **Kde:** `brokerRouter.ts:213` publikuje jen změnu agregátu, takže kontroler plánovanou obměnu nevidí. Neproběhne tedy ani DISARM s vynucenou kontrolou, kterou předepisuje `copierRuntimeController.ts:7480-7497`.
- **Pozice se po obměně neobnoví:** synchronizační odpověď `d` je objekt (`tests/tradovateJournalObserver.test.ts:81`) a `tradovateBroker.ts:1195` ji zpracuje jen jako pole.
- **Důkaz (Z9, stejné v obou stavech):** přímý broker: `armed:false`. Router s obměnou leadera i followera: `armed:true`.
- **Poznámka:** zápis v deníku z 21. 8. obměnu záměrně skrývá („ARM přežije“). Tyto dva návrhy si odporují a je potřeba rozhodnout, který platí. Routeová epocha z V12c obměnu vidí, ale jen pro pending záznamy.
- **Jistota:** mechanismus vysoká.

### 6. NÍZKÁ – OSO flush běží mimo eventTail
- **Kde:** `copierRuntimeController.ts:8354`. Dekrement čítače (`:9471`) proběhne o několik `await` dřív, než se událost aplikuje (`:7537`). Mezitím může flush vidět důkaz jako čerstvý, i když není.
- **Dosah:** týká se jen redukujícího OSO vstupu.
- **Oprava:** dekrementovat až po aplikaci události, nebo pouštět flush přes eventTail.
- **Jistota:** jen čtení kódu.

### 7. NÍZKÁ (poznámka, existovalo už před V12) – S1b blokuje jen Market
Limit TP se zkopíruje na flat followera, kterému dál pracuje nevyplněná Buy Limit 8. Z8 Limit-TP dopadne v obou stavech stejně.

## Srovnání sond (leader-aware mock; holý mock dává totéž, protože REST už na horké cestě není)

| Sonda | cb5cdf6^ | afae767 |
|---|---|---|
| C0 (SL, částečný exit, exit) | DISARM, nic | ARMED, Stop 8 + Market 3 + Market 5 |
| R5, R2p, S3p, R9, R10 fill, R13 | DISARM | OK |
| F0–F3, zzmask2 B/C | DISARM | OK, ale `findCalls 0`: injekce se nespustí a sondy souběh netestují (nahrazují je Z1–Z3) |
| S1b / Z10 (0/3/7) | exit na flat, ARMED / DISARM | DISARM bez zápisu |
| **M3-probe** | DISARM bez zápisu | **Stop 8 na flat followera, ARMED; pak DISARM a nekrytý Stop dál pracuje** |
| zzmask2 E | DISARM, nic | SL ano, exit ne, DISARM |
| R1–R3, R6, R7, R7b/c, O1, P1, R8, R10 working, R11, R12, M1, M3 (v12mask), M4, N1–N5, N2t, S1, S3–S7, ROUTER, zzmask2 D, zzfillsupp | shodně | shodně |
| Z1 sync / microtask / macrotask | DISARM ×3 | DISARM / DISARM / OK |
| Z2 odděleně / v jednom ticku | DISARM ×2 | OK / DISARM |
| Z3 jiný symbol leader / follower | DISARM | DISARM |
| **Z5 Market** | DISARM, follower 0 | **Sell Market 8, follower −8, ARMED ≥3 s** |
| **Z5 Stop** | DISARM | **Stop na flat followera, zůstane po DISARM** |
| Z6 kontrola / obměna leader / obměna follower | DISARM ×3 | OK / DISARM / DISARM |
| Z7 před / se / po SL | DISARM ×3 | OK / DISARM / DISARM |
| Z9 přímý / router leader / router follower | ARM zrušen / zůstane / zůstane | shodně |

## Ověřeno bez nálezu
- **Čítač nemůže uniknout:**
  - Dekrement je bezpodmínečný na začátku `.then`.
  - `Math.max(0)` brání záporné hodnotě.
  - eventTail nikdy nerejectne: všechna přiřazení končí `catch` nebo `then(…, () => undefined)`.
  - Deduplikace fillů je až za dekrementem.
  - Trvale kladný čítač vznikne jen při zaseknutém eventTail, a pak se stejně nic nezpracuje.
- **Epocha:** zvýší se i při blipu skrytém v grace okně (commitnutý test, S6, Z6).
- **Viditelný reconnect leadera:** vymaže pending a udělá DISARM.
- **Restart workeru:** pending je jen v paměti a ARM blokují pracovní příkazy (M4).
- **`evidenceInvalid` vždy a vyřazení terminální kopie:** N2–N4 skončí DISARM bez zápisu, R7/R7b/R7c/O1/P1 zkopírují SL i exit.
- **Reconciliation fence:** hlídá jen čtené účty a zastaralý výsledek odmítne dřív, než přepíše cache.
- **Hypotéza, že `routeEpoch` hodí výjimku pro účet bez route:** sondou Z11 nepotvrzena.

## Plná sada
V exportu afae767: `npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier tests/brokerRouter.test.ts`: 126 souborů, **1529/1529 zelených**. Žádný test nepokrývá nálezy 1–5. Dva vlastní zaseknuté vitest procesy (smyčka mikrotasků v mé sondě) jsem ukončil.

Soubory jsou ve scratchpadu `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- Exporty: `v12c-stale` (afae767), `v12c-stale-base` (cb5cdf6^)
- Nové sondy: `zc-stale.test.ts` (Z1–Z11), `zc-hops.test.ts` (měření mikrotasků)
- Výstupy:
  - `v12c-stale.probes.txt`, `v12c-stale-base.probes.txt` (dřívější sondy)
  - `v12c-stale.cmp.txt` (srovnání)
  - `v12c-stale.zc-final.txt`, `v12c-stale-base.zc-final.txt` (nové sondy)
  - `v12c-stale.suite.txt` (plná sada)