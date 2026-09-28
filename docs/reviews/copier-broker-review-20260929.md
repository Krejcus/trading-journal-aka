# Adversariální review brokerového balíčku (commit 362b921)

## Čočka v5-durable

**Review V5 a durable formátu (commit 362b921 proti fb9fb39)**

Našel jsem jednu vysokou regresi: zadržený SL followera se může změnit ve stop vstup na flat účtu. K tomu jeden nízký nález. Durable formát je bez nálezů. Celá sada na novém exportu prošla: 126 souborů, 1517 testů, vše zelené.

---

### Nález 1 — VYSOKÁ, regrese [peníze]: po DISARM zůstane na flat followerovi pracovní stop, který otevře nechráněnou pozici

**Kde:**
- `services/copierRunner.ts:92–110`: role `standalone-stop` se určí jen jednou, při submitu, podle leader epochy. Pak už se nikdy nepřehodnotí.
- `services/copierRunner.ts:1412–1427`: cancel ukončeného leader orderu s touto rolí jde přes plnou bránu (`haltReason`). Aktuální pozice followera se nehodnotí, ani po účtech.
- `services/copierRuntimeController.ts:1938`: úklid ochranných noh po flat followera (`sweepFollowerProtectiveLegs`) bere jen bracket a OSO. Samostatné SL neuklízí.
- `services/copierRuntimeController.ts:2603–2617` (cooldown) a `3111–3118` (day-lock): kopírka se DISARMuje hned po flat celé skupiny, bez úklidu příkazů.
- `services/copierLeaderFlatGuard.ts:613`: když je follower flat, guard skončí jako `resolved` a jeho příkazy neuklízí.

V nálezu V5 byly dva body opravy, které commit nemá: výjimka pro flat followera vyhodnocená po účtech a rozšíření úklidu ochranných noh.

**Scénáře:**
- **A (reprodukováno):**
  1. Kopírka je ARM, leader je long 1 a má samostatný SL (Sell Stop 1).
  2. Leader vystoupí přes TP limit nebo market a follower exit zkopíruje, takže je flat. SL zůstane pracovat u obou.
  3. Skupina je flat, takže cooldown nebo day-lock kopírku DISARMuje. Stejně to dopadne po ručním DISARM nebo kill switchi.
  4. Leader zbylý SL zruší. Cancel followera skončí `blocked: disarmed`.
  5. Follower je flat a má pracovní Sell Stop, tedy skrytý short vstup bez SL.
  6. Po fillu je follower short −1, kopírka zůstane DISARMED, `lastError` je null a nic se neuzavře.
  - Base tento stop zrušil.
- **B (reprodukováno, přímý důsledek V5):**
  1. Kopírka je DISARMED a follower je otevřený. Leader zruší SL a follower ho podle záměru drží.
  2. Follower pak vyjde přes svůj zkopírovaný TP, takže je flat.
  3. Úklid tento SL nepokryje a zůstane jako osiřelý stop.
- **C (odvozeno z kódu):** leader za ARM otočí long 1 na short 1. Původní sell stop teď short zvětšuje, ale roli si nese dál. Po DISARM se jeho cancel zablokuje.

**Důkaz:** testy leží v obou exportech.

| Test | Nový kód (362b921) | Base (fb9fb39) |
|---|---|---|
| `tests/zzV5FlatOrphan.test.ts`, controller s `entryCooldownMinutes: 10` | follower net 0, stop `working`; po simulovaném fillu net −1, `armed: false`, `lastError: null`, žádná likvidace | stop `canceled` |
| Tatáž runner varianta | audit `[blocked, disarmed]` | audit `[canceled]` |
| `tests/zzV5Retained.test.ts` | stop `working` při net 0 | stop `canceled` |

**Oprava:**
1. Blokaci vyhodnocovat po účtech v okamžiku cancelu, podle autoritativního netu followera v symbolu (`positionsByAccount`):
   - Follower je flat, nebo by stop pozici zvětšil či otočil (strana ji nesnižuje nebo qty > |net|): pustit cestou `cancelLifecycleHaltReason` a assertem `'cancel'`.
   - Stop opravdu chrání otevřenou pozici: plná brána.
   - Pozice není známá: blokovat a hlásit kriticky.
2. Rozšířit `sweepFollowerProtectiveLegs` o linky s rolí `standalone-stop` na daném účtu a symbolu. Postkontrola stejná jako u bracket/OSO a musí fungovat i po DISARM.
3. Blokovaný ochranný cancel za DISARM ukázat uživateli (lastError nebo push „follower drží SL, který leader zrušil“).
4. Moje testy převzít jako regresní s očekáváním `canceled`.

**Jistota:** vysoká. Reprodukováno end-to-end přes controller, nový kód proti base.

---

### Nález 2 — NÍZKÁ: ochranný cancel zahozený v závodu s DISARM nevynutí kontrolu pozic

**Kde:** `services/copierRunner.ts:1605` (nový assert `'modify'`) a `1679–1682` (`waiveCancelEntry` s `neverSent`); controller `disarm()` (`copierRuntimeController.ts:9636–9650`) a kontrola při ARM na `:9531`.

**Scénář:**
1. DISARM přijde mezi kontrolou brány v runneru a odesláním.
2. Cancel se zahodí jako `skipped`, což není kritický záznam. Sekvence se posune a `invalidateReconciliation` se nezavolá.
3. Ruční `disarm()` kontrolu pozic nevynucuje. `workingOrderAccounts` se obnovuje jen v `reconcile()`.
4. Opětovný ARM tak může projít s osiřelým stopem followera.

**Důkaz:** `tests/zzV5Rearm.test.ts` (jen v novém exportu). ARM po ručním DISARM s pracovním stopem followera projde bez reconcile. Tahle slabina ARM brány je starší než commit. Nové je, že do ní vede i samostatný SL, který base rušil mírnější cestou `'cancel'`.

**Oprava:** zahozený ochranný cancel hlásit jako kritický záznam nebo zavolat `requireReconciliation`. ARM by měl pracovní příkazy kontrolovat z živého stavu.

**Jistota:** střední. Okno závodu je v řádu milisekund, část s opětovným ARM je ověřená testem.

---

### Bez nálezů (ověřeno)

- **Durable formát:** `tests/zzV5Durable.test.ts` přes fileCopierStore na obou exportech.
  - Nový kód se starým snapshotem bez pole: načte se a link bez role se po DISARM zruší jako v base. Na SL založené před nasazením se V5 neuplatní. Při reinstallu z flat stavu bez pracovních příkazů to nevadí.
  - Starý kód s novým snapshotem (downgrade): načte se, pole při zápisu zachová a ignoruje.
  - Supabase validátor v base neznámé klíče nekontroluje. Nový přijímá jen prázdnou hodnotu nebo `'standalone-stop'`.
  - Roli zachovávají `cloneSnapshot`, `toSnapshot` i `updateFollowerLink`. `recoverOutbox` ji obnoví jen lookupem, bez druhého zápisu.
- **Dva SL nebo opačná pozice po zrušení a novém SL:** cestu jsem nenašel, kromě Nálezu 2.
  - Za DISARM se nový SL také nezkopíruje.
  - Za ARM se zdravou branou cancel projde.
  - Nový submit prochází aspoň stejně přísnou branou.
  - Po blokovaném cancelu se volá `invalidateReconciliation` a reconcile pracovní příkazy uvidí.
- **Leader-flat guard a auto-close:** u otevřeného followera cílené zavření (`cleanupScope target-symbol`) i account-wide Flatten zadržený SL po flat zruší (existující test „copier-owned orphan se stale SL“). Díra je jen u followera, který už je flat, viz Nález 1.
- **Stop ENTRY z flat stavu:** role nevznikne a cancel po DISARM projde. Zastaralou `open` epochu po restartu opraví connection-recovery (`copierRuntimeController.ts:5745–5775`) ještě před ARM. Chybná klasifikace vzniká jen tím, že role zestárne (flat nebo flip), viz Nález 1.

Exporty jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- `broker-v5dur/` (362b921): `tests/zzV5FlatOrphan.test.ts`, `tests/zzV5Retained.test.ts`, `tests/zzV5Durable.test.ts`, `tests/zzV5Rearm.test.ts`
- `broker-v5dur-pre/` (fb9fb39): stejné testy bez `zzV5Rearm`

Worktree jsem neměnil.

## Čočka v7-v8-stream

**Adversariální review 362b921, čočka V7/V8 (stream): 1 vysoký, 1 střední a 2 nízké nálezy**

Dvojí emise téhož fillu nevzniká. Hlavní problém je jinde: synchronní liveness v `onmessage` odstranila jedinou horní mez zpoždění sémantické fronty. Druhý bod zabezpečení, který review V8 k tomu požadovalo (hlídat stáří události), chybí. Kopírka tak může dohánět vstup leadera se zpožděním i desítek sekund, bez fail-closed.

Exporty: `…/scratchpad/broker-stream` (362b921) a `…/scratchpad/broker-stream-pre` (fb9fb39). Moje testy leží v obou exportech: `tests/reviewStreamStall.test.ts`, `tests/reviewFillDedup.test.ts`, `tests/reviewThrowingListener.test.ts`. Worktree jsem neměnil (čistý, HEAD 362b921).

### 1. VYSOKÁ: zaseknutá fronta zpráv už nevede k fail-closed, vstup leadera se zkopíruje pozdě (regrese proti base)
- **Kde:**
  - `services/tradovateBroker.ts:1451-1472`: `lastSocketMessageAt` a heartbeat se nastaví hned při příjmu frame.
  - `:1579-1592`: idle guard teď měří příjem, ne zpracování.
  - `:1501`: fronta `a` zpráv nemá žádný watchdog.
  - Chybí kontrola stáří události. `copierRuntimeController.ts:8079` razítkuje leader event časem zpracování (`source.observe(..., now)`) a `copierRiskGate.ts:139` kontroluje jen heartbeat.
- **Scénář:**
  - Jedna REST hydratace ve frontě (`/orderVersion/deps`, `/contract/items`) trvá 15–45 s. Stačí timeout 45 s na jeden request a víc requestů může jít za sebou.
  - Mezitím chodí `h` frame, takže heartbeat je čerstvý a ARM trvá.
  - Market vstup leadera, který čeká za tím requestem, se pak zkopíruje jako čerstvý.
  - Base v takovém případě po 15 s ohlásil heartbeat-timeout, poslal `error`, controller vypnul kopírku (`failClosed` s `transportLost`, bez auto-close) a zbytek fronty zahodil.
- **Důkaz:** `reviewStreamStall.test.ts` pouští tok broker → `CopierLeaderEventSource` → gate → `processLeaderEvent`.
  - **Base:** v 15 000 ms přijde `error` a `connection=false`, nic se neodešle.
  - **362b921:** v 30 000 ms přijdou `order#41` a `order#43`, poslední heartbeat je v 30 000 ms, `disconnected=false`. Follower dostal Market Buy 28 s po vstupu leadera.
  - Pravděpodobnost je reálná: REST pomalejší než 15 s už v provozu byl (17. 9.) a může to způsobit i fetch, který zůstal viset při uspání Macu.
- **Oprava (dvě části):**
  - Watchdog stáří nejstaršího nezpracovaného `a` frame. Při překročení limitu (např. 15 s) poslat `error` a `closeSocket` s důvodem `semantic-lag`. `h` odpověď i liveness zůstanou synchronní.
  - Předávat `receivedAt` z frame do order/fill eventů. U operací zvyšujících expozici blokovat staré eventy kritickým auditem (bod 2 opravy V8 z review).
- **Jistota:** mechanismus vysoká (reprodukováno), výskyt v provozu střední.

### 2. STŘEDNÍ: „stale posun SL → kritický blocked audit“ není změna kódu a vede k auto-close
- **Kde:** `copierRunner.ts:1424-1428` (`replaced` jde přes `haltReason`), `copierRuntimeController.ts:3886-3928`, `:3182` (`scheduleAutoClose`).
- **Důkaz:** nový test „stale heartbeat posun SL…“ projde beze změny i na base, v `copierRunner.post.test.ts` v pre exportu. Chování je stejné jako dřív; tvrzení v commitu i v PROJECT_LOG je zavádějící.
- **Dopad:** blocked audit za ARM spustí `failClosed` bez `transportLost`, tedy auto-close všech followerů. Podle V9 jde o Flatten celého účtu nad zdravými pozicemi, zatímco leader dál drží.
- **Co zbývá:**
  - Stale-heartbeat teď prakticky vzniká jen zpožděním fronty controlleru o víc než 10 s. `gate.lastHeartbeatAt` se nastavuje až v serializovaném `handleBrokerEvent` (`:7497`) a to commit neřeší.
  - Body 2 a 3 opravy V8 nejsou implementované: ochranný posun se nemá blokovat podle stáří a neodeslaný posun se má znovu prosadit po čerstvém lookupu.
- **Oprava:** podle review V8, body 2 a 3.
- **Jistota:** vysoká.

### 3. NÍZKÁ: synchronní `emit` v `onmessage` nemá try/catch (regrese vůči base)
- **Kde:** `tradovateBroker.ts:1457-1458`.
- **Důkaz:** `reviewThrowingListener.test.ts`.
  - **Base:** zachytí se to ve frontě, přijde `error` a `connection=false`.
  - **362b921:** výjimka vyletí z `onmessage`, `order#43` se tiše ztratí a nepřijde ani chyba, ani disconnect.
  - V Node (globální undici WebSocket) to znamená uncaughtException a pád workeru. Dnešní listenery (router, controller) nevyhazují, takže jde o latentní riziko.
- **Oprava:** obalit `emit` a `observe` do try/catch, v catch zavolat `emitOrHoldError` a `closeSocket`.

### 4. NÍZKÁ, teoretická: pending fill se nově vyšle až při pozdějším WS `Updated`
- **Kde:** `tradovateBroker.ts:1117-1122`.
- **Scénář:**
  - WS Fill přijde s neznámým účtem, takže čeká v `pendingFills`. REST lookup pak order pozná, ale žádný WS Order, ExecutionReport ani OrderVersion už nepřijde.
  - Base takový fill nevyslal nikdy. Nová verze ho vyšle až s `Updated`, což může být o hodiny později (vzor 16. 9. 23:34). Za ARM by to znamenalo pozdní on-fill kopii.
- **Důkaz:** `reviewFillDedup` CASE-C: base `[]`, 362b921 `["12"]`, a to až v okamžiku `Updated`.
- **Oprava:** nedoručený, už započtený fill posílat jen z `eventType: 'Created'`, nebo pro on-fill blokovat starý `filledAt`.
- **Drobné zpevnění:** `emitMappedFill` přidá ID do `deliveredFillIds` až po `await hydrateContracts` (`:808-817`). Dřív WS cestu hlídal synchronní `rememberFill`. Stačí přidat ID před `await`. Se skutečným formátem syncu (objekt, ne pole) jsem to nezreprodukoval.

### Ověřeno bez nálezu
- **Dvojí emise nevzniká (`reviewFillDedup`, oba exporty):**

  | Případ | Base | 362b921 | Poznámka |
  |---|---|---|---|
  | A: REST → WS Created → WS Updated | 0× | 1× | oprava V7 |
  | B: Created i Updated v jednom frame | 0× | 1× | |
  | D: reconnect, doručený fill + nový baseline + Updated | 1× | 1× | |
  | E: fill jen přes REST v mezeře → baseline → WS Created na novém socketu | 0× | 0× | fill z mezery se nepřehrává (V6) |

- **Druhá vrstva dedup:** kopie hlídá `CopierLeaderEventSource.seenFillIds`, risk `seenFollowerRiskFillIds`. `trackLeaderFill` vlastní dedup nemá a spoléhá na broker, ten doručí právě jednou. cumQty se nezapočítá dvakrát.
- **Baseline:** obchází in-flight dedup a čte čerstvě, což je správně. Stojí to jedno REST kolo navíc při každém reconnectu.
- **Pořadí `o`/`h`:** v pořádku.
- **Zombie po spánku Macu:** mrtvé TCP dál zavře idle guard (měří wall clock). Stav, kdy server posílá jen `h` a sémantická subscription je mrtvá, nezachytí base ani nová verze, jde o starší problém.
- **Heartbeat předbíhá frontu:** `maybeReleaseManualTradeCuts` je krytý dvojím REST snapshotem a kontrolou verze pozorování.
- **Celá sada na exportu 362b921:** 126/126 souborů, 1517/1517 testů prošlo. Na base 2 ze 3 nových broker testů padají, podle očekávání. Test baseline a stale-SL runner test na base procházejí, takže jde jen o popis stávajícího chování.