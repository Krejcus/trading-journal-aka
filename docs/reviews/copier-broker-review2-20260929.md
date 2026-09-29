# Adversariální review brokerové větve 2 (dac2e05 + 8ac3cd6)

## Čočka lookup-idempotence

# Review kopírky, čočka lookup a idempotence (8ac3cd6 proti fb9fb39)

Výsledek: blind retry ani duplicitní zápis nevzniká. Vrácení `order: null` („order u brokera není“) zůstalo stejné jako v base. Požadovaná verze bez `Replaced` se dál nepovyšuje. Mám ale tři nálezy: jeden střední (násobení REST dotazů) a dva nízké. Fail-closed platí u všech tří.

## Nálezy

### 1. Střední: počet REST dotazů na jeden `findOrderById` roste s počtem modify
- **Kde:** `services/tradovateBroker.ts:1122-1133` (`loadTargetedOrder`)
- **Scénář:** Pro každou verzi orderu, jejíž id se liší od id orderu, se posílá samostatné `/executionReport/deps`. Dotazy jdou všechny najednou, bez limitu, a to i ve stavu, kdy je vše už potvrzené v cache.
  - Base měla konstantně 4 dotazy. `/executionReport/list` přidala jen tehdy, když REST ukázal novou, dosud nepovýšenou verzi.
  - Lookup se volá před každým modify followera (`copierRunner.ts:568`, `:1708`) a v OSO kaskádě leadera (`copierOsoModifyCascade.ts:177-198`).
  - Při nastaveném `maxContracts` ho wrapper volá podruhé.
  - V nouzovém flattenu ho `confirmCancel` opakuje až 50× po 100 ms (`copierManualActions.ts:240`).
  - Přes celý obchod proto počet dotazů roste kvadraticky.
- **Důkaz:** Sonda `tests/zzLookupLens.test.ts`, test B.

  | Počet modify (n) | Nová verze: 1. volání / opakování | Base: 1. volání / opakování |
  |---|---|---|
  | 0 | 5 / 4 | 5 / 4 |
  | 1 | 6 / 5 | 6 / 4 |
  | 5 | 10 / 9 | 6 / 4 |
  | 20 | 25 / 24 | 6 / 4 |

  Limit Tradovate je 5 000 dotazů za hodinu (PROJECT_LOG z 18. 9.). Po 429 zablokuje breaker na hodinu všechny REST dotazy, včetně `liquidateposition`. Selhání kteréhokoli z n dotazů navíc shodí celý lookup, takže modify ochranného SL skončí jako refused.
- **Oprava:**
  - Reporty stahovat jen pro id, která nejsou v `confirmedCommands` ani v `rejectedCommands` a jsou větší než povýšená verze. Tyto fakty se nemění, takže autorita „nutný Replaced“ zůstane zachovaná.
  - A/nebo použít jediný dotaz `/executionReport/ldeps?masterids=…`. Repo ho už používá v `lib/journalBackfillPlan.ts:14`.
  - `confirmCancel` by měl nejdřív zkusit `findOrderStatusById`.
- **Jistota:** Vysoká pro mechanismus (změřeno). Střední pro to, jak často se v praxi dojde k 429.

### 2. Nízká: prefetch se spouští u každého ExecutionReportu bez ohledu na cache
- **Kde:** `services/tradovateBroker.ts:790-800`
- **Scénář:** Větev `executionreport` nekontroluje `orderVersions` a `confirmedVersionIds`. Reporty Canceled (command zrušení nemá OrderVersion) a Trade proto vždy pošlou `/orderVersion/deps`, i když `hydrateOrderVersion` pak výsledek vůbec nepoužije. Dotaz odchází také ještě před kontrolou `isCurrent()`.
- **Důkaz:** Sonda A. Dva reporty (Canceled a Trade) na už známém orderu: nová verze 2 dotazy navíc, base 0.
- **Dopad:** Jen spotřeba limitu 5 000/h. Na správnost vliv nemá, protože nepoužitý výsledek se neaplikuje.
- **Oprava:** Použít stejnou podmínku jako v `hydrateOrderVersion`. Prefetch jen když `!orderVersions.has(orderId)`, nebo když je report New/Replaced, jeho `commandId` je větší než povýšená verze a verze s tím id ještě není v requested.
- **Jistota:** Vysoká.

### 3. Nízká: starší report přepíše čerstvější stav z `/order/item`; reporty se nefiltrují podle orderId
- **Kde:** `services/tradovateBroker.ts:1108` a `:1133`
- **Scénář:**
  - Nejdřív se aplikuje `/order/item`, potom jen reporty Modify commandů. Nejnovější z nich může být starší než skutečně poslední report orderu.
  - `rememberRawOrder` pak přepíše ne-terminální stav z itemu. Chráněný je jen terminální stav.
  - Base filtrovala podle `selectedIds` (`:1083`) a aplikovala všechny reporty orderu seřazené podle id. Posledním tak byl nejnovější report.
  - K přepisu dojde jen tehdy, když stream daný novější report nezná (studená cache po restartu nebo reconnectu). Pokud ho zná, zabrání přepisu podmínka `report.id <= previous.id`.
- **Důkaz:** Sonda `zzLookupLens3`, kdy SL z nativního OSO (child) upravený ve stavu Suspended a později aktivovaný. Item hlásí Working, Replaced report pod commandem 43 nese Suspended, novější report pod commandem 42 nese Working. Nová verze vrátí `pending`, base vrátí `working`.
- **Dopad (fail-closed):**
  - OSO kaskáda spadne na `oso-leader-protection-unverified` (`copierOsoModifyCascade.ts:193`).
  - `proveProtectedTargetModifyFailures` vrátí null (`copierRuntimeController.ts:3725`).
  - Bez filtru podle orderId navíc hypoteticky reporty sdíleného commandu změní cache sousedního orderu. Sonda D ukázala, že sourozenec se pak nedá složit: `findOrderById` vyhodí chybu a order event se neemituje.
- **Oprava:** Filtrovat `report.orderId === orderId` a `rememberRawOrder(raw)` volat až po reportech. Novější terminální stav z reportu tím nezanikne, protože ho ochrana terminálního stavu udrží.
- **Jistota:** Střední. Mechanismus je ověřený; jak často to v praxi nastane, záleží na tom, co Tradovate posílá v syncu.

## Ověřeno bez nálezu
- **Lookup-before-retry u place:** `findOrdersByTag` (clOrdId, globální graf, completeness `eventual`) commit 8ac3cd6 nemění. `order: null` pořád vzniká jen z 404 na `/order/item` nebo z nesouladu účtu, takže nová mylná „no-send“ odpověď nevzniká.
- **Autorita potvrzení modify (Replaced),** sonda `zzLookupLens2`, 4/4:
  - Pouze požadovaná verze se nepovýší, ani zamítnutá (Rejected).
  - Verze s `Replaced` se povýší i bez command deps.
  - Když REST vrátí `Replaced` bez odpovídající verze, lookup vyhodí chybu a modify je refused. To je přísnější než base.
- **Význam masterid u deps:** executionReport má za master command, konzistentně s `journalBackfillPlan.ts:14`, `inspectCommandReports.ts` a dřívějším `findModifiedOrderById`. Deps se nestránkují. Zpoždění REST vede nanejvýš ke starší potvrzené podobě orderu, nebo k chybě; stejná třída chování jako base.
- **`/command/deps` s `.catch(() => [])` (`:1105`):** Base při chybě `/command/list` padala, nová verze pokračuje. Povýšení verze na commandech nezávisí (sonda). Chybí jen tag (vrací se `''`) a žádný konzument výsledku `findOrderById` `order.tag` nečte.
- **Souběžná hydratace:**
  - Výsledky se aplikují a eventy emitují v serial tailu v původním pořadí.
  - Chyba prefetch se zachytí a vyhodí se až při skutečném použití.
  - `composeOrder` nic neemituje, pokud je potvrzené id větší než známá verze.
  - Verze načtené „z budoucna“ se bez potvrzení nepovyšují.
  - Jediný rozdíl: snímek z doby příchodu rámce je starší než fetch base v době zpracování. Při zpoždění REST se event emituje až s OrderVersion ze streamu. Chybná data to ale nedá.
- **P142 (cap jen s `maxContracts`):** `maxContractsFor` čte aktuální `group` (je to `let`, přiřazuje se při změně topologie, `copierRuntimeController.ts:711` a `:9274`). Mezi kontrolou na null a zápisem není žádný await. `modifyOrder` volá jen runner a obě jeho cesty dělají povinný lookup (a když order chybí, skončí refused). Nastavení `maxContracts` za běhu platí od dalšího modify.
- **P143:** Getter se nikde nerozbaluje spreadem, controller čte `options.maxConcurrentDispatches` při každém volání.

## Testy (vše v exportu, worktree nedotčený)
- Původní testy první review (zkopírované jako `origR_*`) i verze z commitu: 15 souborů prošlo, 1 přeskočený; 28 testů prošlo, 1 todo.
- Celá sada `tests/copier`, `tests/pendingEntryProtection.test.ts`, `tests/tradovate`, `tests/localCopier`, `tests/macCopier`, `tests/supabaseCopier`: 127/127 souborů, 1519/1519 testů. Flake `copierFlatSweepV13` se tentokrát neobjevil.
- Testy `exposureCappedBroker`, `tradovateSpeed11b` a `tradovateMapping`: 59/59.
- `tsc`: v žádném změněném souboru chyba není. Chyby hlásí jen `extension/*` a můj zkopírovaný starý test `origR_zzV5Durable.test.ts`.

Soubory:
- Export: `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/brk2-lookup` (8ac3cd6) a `…/scratchpad/brk2-lookup-pre` (fb9fb39)
- Sondy: `…/scratchpad/brk2-lookup/tests/zzLookupLens.test.ts`, `zzLookupLens2.test.ts`, `zzLookupLens3.test.ts`
- Log celé sady: `…/scratchpad/brk2-lookup-full.log`

## Čočka v5-v8-followup

**Review dac2e05 + 8ac3cd6 proti fb9fb39, čočka V5/V8 follow-up: 2 vysoké, 2 střední a 2 nízké nálezy**

Scénáře A a C z první review jsou opravené. Scénář B dál reprodukuje osiřelý stop na flat followerovi. Nová oprava V5 i nový watchdog V8 ale každá zavádí vlastní regresi proti base.

## Nálezy

### 1. VYSOKÁ, regrese: čtení pozic je i v ARM cestě, zpožďuje exit a při chybě flatne followera
- **Kde:** `services/copierRunner.ts:1454–1496`. Každý cancel standalone SL čeká na `broker.listPositions` (REST `/position/list`), a to i za zdravého ARM. Controller zpracovává eventy sériově (`eventTail`, `copierRuntimeController.ts:9509`).
- **Scénář a:** leader udělá „Exit at Mkt & Cxl“, tedy nejdřív cancel SL a hned market exit. Exit followera čeká ve frontě, dokud nedoběhne čtení pozic. Když je REST pomalý, čeká až 45 s (timeout REST).
- **Scénář b:** leader zruší SL a nový položí (cancel+replace), ale jedno čtení pozice followera selže. Výsledek je `blocked`, pak `failClosed` a auto-close. Follower se zavře, zatímco leader drží pozici.
- **Důkaz** (`tests/brk2ExitLatency.test.ts`, `tests/brk2ArmedReadFail.test.ts`):

  | | Nový kód | Base |
  |---|---|---|
  | Exit followera, čtení trvá 400 ms | odeslán v 406 ms | odeslán v 0 ms |
  | Jedno čtení selže | `armed:false`, nový příkaz `Sell Market 1`, follower net 0 | cancel projde, `armed:true`, follower net 1 |

- **Oprava:** nejdřív spočítat `protectiveLifecycleHaltReason(commandContext)`. Když vrátí null, cancel pustit bez čtení. `haltReason` obsahuje všechny kontroly `cancelLifecycleHaltReason`, takže obě brány by prošly tak jako tak. Číst pozice jen když ochranná brána blokuje (DISARM, kill switch…), a to s krátkým deadlinem.
- **Jistota:** vysoká.

### 2. VYSOKÁ, regrese dostupnosti: semantic-lag watchdog zabíjí pomalý sync a reconnect se zacyklí
- **Kde:** `services/tradovateBroker.ts:1779–1791`. Watchdog běží před sync logikou (`:1796`) a nezáleží u něj na fázi socketu. Frame s odpovědí na sync (`i===1`) čeká v tailu na `/order/list` a na něj se vztahuje limit 15 s. Produkce má `WS_SYNC_TIMEOUT_MS = 45_000` (`scripts/copier/pilot.ts:84–86`), protože 17. 9. trval `/order/list` přes 15 s a kratší limit reconnect „jen roztočil“.
- **Scénář:** během takového zpomalení Tradovate zavře REST delší než 15 s v tailu socket (to je v pořádku). Každý další sync ale znovu spadne v 15 s.
  - Kopírka se nepřipojí po celou dobu zpomalení.
  - Otevření followeři čekají na `pendingConnectionRecovery`, exity se jim nekopírují.
  - Každý pokus spotřebuje syncrequest z limitu 300/h, hrozí penalizace p-ticket.
  - Base v téže situaci sync dokončil.
- **Důkaz** (`tests/brk2SyncLag.test.ts`, `/order/list` trvá 20 s, `h` rámce chodí):
  - nový kód: `15000: error(semantic lag)`, `connection=false`, close;
  - base: `connection=true` po vyřízení, žádný close.
- **Oprava:** před `syncReady` použít limit `max(semanticLag, syncTimeoutMs)`, stejně jako idle guard, nebo sync frame z watchdogu vyjmout. Frames čekající za syncem má pokrýt kontrola stáří přes `receivedAt` v controlleru.
- **Jistota:** vysoká.

### 3. VYSOKÁ, známé otevřené, nezměněno: scénář B, k tomu A při selhání čtení; hlášení jen auditem
- **Scénář B:** za DISARM follower SL správně podrží, pak vyjde přes TP a je flat. Stop dál pracuje (skrytý vstup), `lastError: null`. Test `zzV5Retained` je jen `it.todo`.
- **A se selháním čtení:** follower je flat, cooldown DISARM, jedno selhání `/position/list`. Výsledek je `blocked`, stop zůstane `working` a `lastError: null`. Opakované čtení neexistuje. Jediný viditelný příznak je odmítnutý ARM („Před ARM musí být všechny účty bez pracovních příkazů“, `tests/brk2DisarmReadFail.test.ts`).
- **Kde:** `copierRunner.ts:1494–1496`. `failClosedOnCriticalAudit` za DISARM jen invaliduje reconcile.
- **Oprava:**
  - Doplnit sweep `standalone-stop` v controlleru, i za DISARM, včetně postkontroly.
  - Za DISARM zopakovat čtení s omezeným počtem pokusů.
  - Neznámou pozici hlásit přes `lastError` nebo push, ne jen auditem.
- **Jistota:** vysoká.

### 4. STŘEDNÍ, 8ac3cd6, zátěž při burstu: každý ExecutionReport spustí zbytečný REST
- **Kde:** `tradovateBroker.ts:790–793`. Prefetch u ExecutionReport nekontroluje cache. `hydrateOrderVersion` přitom REST přeskočí, když zná verzi ≥ `desired`.
- **Důkaz** (`tests/brk2PrefetchCount.test.ts`, běžný průběh New → Trade → Fill → Updated):
  - nový kód: 2× `/orderVersion/deps`, souběžně;
  - base: 0×.
- **Dopad:** při vstupu s víc followery desítky souběžných REST na stejném spojení, které posílá příkazy followerů. Odpověď 429 zapne breaker na hodinu, p-ticket na p-time. Breaker pak blokuje i `placeOrder` a `cancel`.
- **Oprava:** prefetch jen pro `execType` New nebo Replaced, kde `commandId` > známé verze.
- **Jistota:** mechanismus vysoká, reálný dopad na limity střední.

### 5. NÍZKÁ: `receivedAt` broker nese správně, controller ho zahazuje
- **Broker:** správně. Pending fill si drží čas Created frame. Pozdě emitovaný order nese `rx=1000` při emitu ve 30 000 ms.
- **Controller:** `leaderEvent.receivedAt = clock()` až při zpracování (`copierRuntimeController.ts:7495`, `8079`).
  - Latency audit P145 (`queueMs`, `totalMs`) proto nevidí čekání v broker tailu ani ve frontě controlleru. To jsou přesně místa, kde se zasekává, včetně čtení z nálezu 1.
  - Kontrola stáří (V8 bod 2) chybí. Pozdní kopie je dnes shora omezená jen watchdogem (~15 s), protože `h` rámce drží gate čerstvou.
- **Drobnost:** `flushCommandReports` (`tradovateBroker.ts:1180`) razítkuje dříve přijaté CommandReporty časem pozdějšího Command frame.
- **Oprava:** předávat `event.receivedAt` do zdroje leader eventů jako samostatné pole a doplnit kontrolu stáří.

### 6. NÍZKÁ, návrh: hrany klasifikace
- Stop větší než |net| se za DISARM zruší a zbytek pozice zůstane bez SL. Lepší je zmenšit množství na |net|, nebo zablokovat a nahlásit.
- Klasifikace jde jen podle množství linku, ne podle zbylého množství stopu.
- Stopy bez role (starý snapshot, SL zadaný před otevřenou epochou) se dál ruší jako v base. Rozhodnutí podle pozice by šlo použít na všechny Stop/StopLimit linky.
- **Jistota:** střední.

## Ověřeno bez nálezu
- **Scénář A:** controller i runner stop zruší (`canceled`). Opravené rozhodování podle pozice followera je v pořádku.
- **Scénář C (flip):** net −1 se Sell stopem se zruší přes cancel-only bránu.
- **Neznámá pozice:** zablokuje se kritickým `blocked` (hlášení viz nález 3). `hydrateContracts` při chybějícím kontraktu vyhodí chybu, takže nedojde k tomu, že by se follower tvářil jako flat.
- **Původ netu:** REST `/position/list` se čte čerstvě, sdílí se jen souběžné volání. Jednoznačnost se kontroluje podle `matching.length <= 1`.
- **Závod s DISARM:** zahozený ochranný cancel je kritický `cancel-failed`. Cancel-only cesta se o DISARM nezastaví, takže orphan stop na flat followerovi se v tomto závodu neztratí.
- **Watchdog při běžném burstu:** zavírá až při 15 s nezpracovaného frame, stejně jako dřívější heartbeat-timeout. `h` rámce se odpovídají synchronně. Frame rozpracovaný při zavření po zpoždění REST už nic neemituje (`brk2StaleEmit`, obě verze).
- **Mezera při reconnectu (V6):** zahozené frames znamenají `failClosed(transportLost)`, tedy DISARM bez auto-close. Fills z mezery se nepřehrávají, stejně jako v base.

## Testy
- **Testy první review** v novém exportu: 8 souborů, 14 testů, vše prošlo.
  - A: stop `canceled`.
  - B: stop dál `working` při net 0.
  - Stall: `error` v 17 500 ms.
  - FillDedup beze změny.
- **Celá sada** (`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier tests/supabaseCopier tests/zzV5 tests/review tests/exposureCapped`): 135 souborů prošlo a 1 přeskočen, 1542 testů prošlo a 1 todo, bez flaku.

Worktree jsem neměnil (čistý, HEAD 8ac3cd6).

Exporty jsou ve scratchpadu:
- `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/brk2-v58` (8ac3cd6)
- `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/brk2-v58-pre` (fb9fb39)

Moje testy leží v `tests/brk2*.test.ts`, v novém exportu kromě `brk2DisarmReadFail` i v `-pre`. Testy první review jsou v `tests/r1/`.