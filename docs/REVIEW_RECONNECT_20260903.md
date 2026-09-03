# Review: noční ztráta spojení Mac workeru 3. 9. 2026 (Codex read-only, zadal Claude)

# Read-only incident review — noční reconnect Mac workeru

## Verdikt

**Varianta (a): worker se skutečně přestal dostávat k dalším reconnect pokusům.** Jistota je vysoká pro výsledek, střední pro přesný vnitřní stav socketu.

Nejpravděpodobnější mechanismus je, že poslední WebSocket zůstal viset ve stavu `CONNECTING` nebo `CLOSING`:

- pro `CONNECTING` neexistuje žádný timeout,
- po `socket.close()` se reconnect plánuje výhradně z `onclose`,
- pokud `onclose` nepřijde, `socket` zůstane neprázdný a nevznikne další timer,
- `reconnect` timer sám není nominálně „zaseknutý“; problém je, že stavový automat může skončit s `reconnect === null`, ale `socket !== null`.

Varianta (b), tedy pokračující tiché tokenové pokusy, kódu ani časům neodpovídá. Varianta (c) vysvětluje noční nepravidelné intervaly, ale ne poslední více než dvouminutové okno po doloženém probuzení.

Review proběhlo proti lokální referenci `origin/main` `a3776e55`; čtyři zadané soubory se proti pracovnímu HEAD neliší. Nic jsem nezměnil ani nespustil.

## Časová osa

| UTC | Pozorování | Význam |
|---|---|---|
| 2026-09-02 15:24 | Multi-connection worker startuje se dvěma OAuth routami, jako `DISARMED`, persistentní lifetime; relay je aktivní. | Jeden dlouho běžící proces, ne restart loop. [stdout:5811](worker stdout:5811), [stdout:5816](worker stdout:5816) |
| 22:48–03:20 | Heartbeat/transport chyby se opakují přibližně po 15–18 minutách; socket renewaly jsou opožděné na 51–65 minut. | Silně konzistentní se spánkem a periodickými wake okny. Reconnect mechanismus tehdy ještě pracoval. [stderr:34440](worker stderr:34440), [stdout:6362](worker stdout:6362) |
| 03:20:04 | `renewal timeout` následovaný transport chybou. | `emitOrHoldError` není trvale zaseknutý: jeho deadline se po wake skutečně provedla. [stderr:34484](worker stderr:34484) |
| 04:41:04 | Heartbeat/transport chyby na obou connections. | Oba transporty zaznamenaly dlouhé ticho. [stderr:34512](worker stderr:34512) |
| 04:41:21 | Relayův samostatný Keychain read selže. | Keychain byl v tomto wake okně nedostupný; nejde ale přímo o důkaz, že stejný read právě dělal WebSocket provider. [stderr:34517](worker stderr:34517) |
| 04:49:02 | Poslední heartbeat timeout kritické connection. | Proces i heartbeat timer ještě žily. [stderr:34524](worker stderr:34524) |
| 04:49:03.219 | Poslední označená transport chyba. | Socket byl zavírán nebo právě selhal. [stderr:34526](worker stderr:34526) |
| 04:49:03.222–.223 | 12× `FAIL-CLOSED fetch failed`. | Dvanáct controller error vstupů ve stejném burstu; nejsou to důkazy dvanácti reconnect timerů. [stderr:34527](worker stderr:34527) |
| 04:49:03–05:02:25 | Úplné ticho starého procesu. | Chybí očekávaný 1s retry, 10s token timeout, 15s renewal timeout i periodická diagnostika. |
| 05:02 | Ruční kickstart ukončí starý proces a založí nový worker. | `05:02:32` je chyba nového procesu, ne opožděný pokus starého. [stdout:6372](worker stdout:6372), [stderr:34539](worker stderr:34539) |

Při zadaném faktu, že v 05:00 fungovala síť i Keychain z jiného procesu, měl starý worker do kickstartu přibližně 152 sekund. To je mnohonásobně více než jeho 1s reconnect delay, 5s Keychain limit, 10s lease request limit i 15s renewal deadline.

## Přesná reconnect cesta v kódu

### 1. Socket se vytváří před získáním tokenu

`ensureSocket()` okamžitě uloží výsledek factory do globálního `socket`. Žádný connect/open deadline se v této chvíli nezakládá. Sync timeout vzniká až uvnitř `onopen`. Pokud systémový WebSocket po wake zůstane navždy `CONNECTING`, není co ho zavřít ani co založit nový pokus. [tradovateBroker.ts:791](services/tradovateBroker.ts:791)

Token se získává teprve poté, co server pošle rámec `o`:

```text
open → server "o" → await token() → authorize
```

[tradovateBroker.ts:774](services/tradovateBroker.ts:774)

Proto zde ve skutečnosti není větev „token selhal před otevřením socketu“. Před `onopen` může selhat nebo viset jen samotné navazování WebSocketu. Po `onopen`, ale před autorizací, může viset či selhat `token()`.

### 2. Selhání tokenu v `authorize`

Výjimka z `await token()` odmítne `handleSocketData()`. `socketMessageTail.catch` ji:

1. předá do `emitOrHoldError`,
2. zavolá `socket?.close()`.

[tradovateBroker.ts:805](services/tradovateBroker.ts:805)

Další pokus ale nevzniká v tomto `catch`. Vznikne až v `onclose`, který:

- nastaví `socket = null`,
- zruší sync/heartbeat timery,
- založí standardně 1s `reconnect`,
- callback nejprve nastaví `reconnect = null` a pak volá `ensureSocket()`.

[tradovateBroker.ts:824](services/tradovateBroker.ts:824)

Z toho plyne:

- samotný `reconnect` handle by za normálního průběhu neměl zůstat trvale neprázdný;
- chybí ale close watchdog. Pokud `close()` nevyvolá `onclose`, reconnect se vůbec nenaplánuje;
- chybí connect watchdog. Nový socket může zůstat neprázdný v `CONNECTING`, takže další `ensureSocket()` by stejně skončilo na guardu `if (socket) return`;
- synchronní výjimka z WebSocket factory také není uvnitř retry/catch struktury.

To jsou skutečné terminální stavy reconnect automatu.

### 3. Backoff není exponenciální

`reconnectBackoffMs` se nastavuje pouze pro rate-limit/captcha chyby. Pro obyčejný transport, Keychain či `fetch failed` se používá stále stejných přibližně 1 000 ms. Po naplánování je hodnota backoffu vynulována. [tradovateBroker.ts:808](services/tradovateBroker.ts:808), [tradovateBroker.ts:834](services/tradovateBroker.ts:834)

Není zde:

- počítadlo pokusů,
- exponenciální růst,
- jitter,
- strop,
- „next attempt at“,
- periodický disconnect log.

### 4. `pendingConnectionRecovery` socket nereconnectuje

Controllerův recovery mechanismus je až následná autoritativní reconciliation. Spouští se pouze poté, co dostane `connection connected:true`. Sám nevytváří socket ani nebudí broker. [copierRuntimeController.ts:2538](services/copierRuntimeController.ts:2538)

`runConnectionRecovery()` navíc:

- na začátku shodí `pendingConnectionRecovery=false`,
- zkusí nejvýše pět reconciliation běhů,
- při ztrátě connection nastaví pending zpět,
- ale po pěti jiných selháních pouze zavolá `failClosed` a pending už neobnoví.

[copierRuntimeController.ts:2330](services/copierRuntimeController.ts:2330)

To je druhý availability problém: i po obnovení socketu může jednorázová recovery definitivně skončit. Bezpečnostně zůstane runtime DISARMED, ale další reconciliation retry už nemusí přijít bez nového connection eventu.

## Co přesně znamená 12× `fetch failed`

Prokazatelně šlo o dvanáct volání controllerového `onError`, protože právě ten formátuje každý `failClosed` jako uvedený log. [pilot.ts:608](scripts/copier/pilot.ts:608)

Nejde z nich však poctivě určit:

- která connection chybu vytvořila,
- zda šlo o token lease fetch, Tradovate REST fetch nebo jinou navazující operaci,
- která fáze nebo account ji vyvolaly,
- zda šlo o reconnect, sync replay nebo již zařazené broker eventy.

Loguje se pouze `error.message`, bez stacku, connection labelu, fáze a attempt ID.

Počet 12 svádí k vysvětlení „šest aktivních účtů × `listPositions` + `listOrders`“. Reconciliation opravdu vytváří dvě snapshot operace na každý zahrnutý účet. [copierRuntimeController.ts:3383](services/copierRuntimeController.ts:3383) Toto ale není důkaz: vnější `Promise.all` by normálně předal controlleru jen jednu agregovanou výjimku a broker navíc souběžná globální čtení deduplikuje. [tradovateBroker.ts:518](services/tradovateBroker.ts:518)

Nejpřesnější závěr tedy je:

> Ve 04:49 proběhl burst dvanácti již rozběhnutých nebo zařazených async operací nad nefunkčním fetch transportem. Nešlo o dvanáct doložených reconnect pokusů. Přesnou identitu těch operací současný log neuchoval.

Tato neurčitelnost je sama o sobě významný observability bug.

## Token provider

Provider drží:

- poslední úspěšný `payload`,
- jednu sdílenou in-flight `renewal` promise.

Souběžní volající správně čekají na tutéž promise. `finally` nastaví `renewal=null` po úspěchu i po odmítnutí, takže běžné `fetch failed` nezanechá rejected promise trvale uloženou. [macCopierDevice.ts:154](server/macCopierDevice.ts:154)

Po selhání:

- starý `payload` zůstane v paměti,
- pokud je pořád více než deset minut platný, další `getAccessToken()` jej může vrátit,
- pokud je blízko expirace nebo expirovaný, další volání znovu provede `refresh()`,
- interní časovaný retry provider nemá; závisí na dalším volajícím.

[macCopierDevice.ts:199](server/macCopierDevice.ts:199)

Keychain read má vlastní 5s `execFile` timeout a `SIGKILL`; lease HTTP/body část má 10s abort. [macCopierDevice.ts:14](server/macCopierDevice.ts:14), [macCopierDevice.ts:157](server/macCopierDevice.ts:157)

Verdikt pro provider:

- **nezachovává odmítnutou `renewal` promise**;
- **zachovává starý payload**, ale při blízké expiraci jej po neúspěšném refreshi nevrací;
- **chybí samostatný retry/backoff a diagnostika fáze**;
- provider sám pravděpodobně není příčinou trvalého ticha; odhalil však slabinu socketového automatu po chybě autorizace.

## `emitOrHoldError` a ticho

`emitOrHoldError` tlumí chyby pouze během plánované výměny socketu. Při úspěšném resyncu se zadržené chyby záměrně zahodí. [tradovateBroker.ts:260](services/tradovateBroker.ts:260)

Při neúspěchu je nejpozději po 15 sekundách:

- `renewalInProgress` shozen,
- všechny držené chyby emitovány,
- přidán `WebSocket renewal timeout`,
- socket zavřen nebo connection označena jako disconnected.

[tradovateBroker.ts:1027](services/tradovateBroker.ts:1027)

Za fungujícího event loopu tedy nemůže vysvětlit třináct minut ticha. Může chyby zpozdit během spánku, což je vidět ve 03:20/03:35 burstech, ale po probuzení by deadline doběhla.

## Prioritizované opravy

### P0 — konečný stavový automat reconnectu

**Složitost: M, přibližně 1–2 dny včetně deterministických testů.**

Do `tradovateBroker.ts` zavést jedinou funkci `scheduleReconnect(reason)` a explicitní stavy `idle / connecting / authorizing / syncing / connected / closing / waiting`.

Požadavky:

- exponenciální backoff například `1s → 2s → 4s → … → 60s`, s jitterem;
- nikdy nepřestat, dokud existují listeners;
- backoff resetovat až po kompletním authorization + sync, nikoli po TCP `open`;
- connect timeout založit ihned po vytvoření socketu;
- close watchdog: když po `close()` nepřijde `onclose`, bezpečně odpojit handler, uvolnit pouze tento socket a naplánovat retry;
- zachytit synchronní chybu factory;
- handlery navázat na lokální `const candidate`, nikoli bezpodmínečně měnit globální `socket`; opožděný callback starého socketu nesmí shodit nový;
- `reconnectNow()` pro wake detekci, idempotentní a bez broker write.

### P0 — regresní testy terminálních stavů

**Složitost: S–M, 0,5–1 den.**

Doplnit testy:

- WebSocket zůstane navždy `CONNECTING`;
- `close()` nikdy nevyvolá `onclose`;
- `getAccessToken()` selže během `authorize`, potom uspěje;
- několik token/fetch selhání za sebou a následné zotavení;
- opožděný `onclose` starého socketu po vytvoření nového;
- sleep-like skok hodin;
- listener unsubscribe skutečně ukončí nekonečný retry;
- reconnect nikdy neobnoví ARM a vždy vyžádá reconciliation.

### P1 — token refresh retry s kontextem

**Složitost: S, přibližně 0,5 dne.**

Provider už správně čistí `renewal`; měnit tuto vlastnost není nutné. Doplnit:

- chyby s fází `keychain / lease-fetch / lease-body / decrypt / expiry`;
- connection ID v redigované podobě;
- bounded retry řízený socketovým automatem, ne nekonečnou smyčku uvnitř jednoho `getAccessToken()`;
- při chybě starý payload nezahazovat, ale nikdy nepoužít token za hranicí povolené validity;
- stav `lastRefreshFailureAt`, `nextRefreshAt`, `refreshAttempts`.

### P1 — okamžitá reakce po probuzení

**Složitost: M, přibližně 0,5–1 den.**

Protože jde o Node script, Electron `powerMonitor` zde přímo není. Nejmenší řešení:

- pilot už má 1s servisní loop; ukládat wall-clock i monotonic tick;
- skok například nad 10–15 sekund klasifikovat jako sleep/wake;
- okamžitě zavolat `reconnectNow('wake-gap')` na všech connections;
- invalidovat reconciliation a ponechat DISARMED;
- pokud síť ještě není připravena, pokračovat standardním capped backoffem.

Současný servisní loop pouze zvažuje plánovaný socket renewal a při `connected:false` rovnou skončí bez akce. [pilot.ts:891](scripts/copier/pilot.ts:891)

### P1 — viditelná průběžná diagnostika

**Složitost: S, přibližně 0,25–0,5 dne.**

Při disconnectu logovat:

```text
WS DISCONNECTED conn:… state=connecting attempt=7
lastError=lease-fetch: fetch failed
nextAttemptIn=32s disconnectedFor=4m12s
```

- jeden řádek při každé změně fáze,
- opakovaný souhrn nejméně každých 5 minut,
- totéž vystavit ve statusu,
- raw chyby vždy doplnit o connection a operation label,
- nezahltit log každou sekundu.

### P1 — nekonečný post-connect reconciliation retry

**Složitost: S, přibližně 0,5 dne.**

Po pěti rychlých pokusech má `pendingConnectionRecovery` zůstat aktivní a pokračovat pomalejším backoffem, dokud:

- reconciliation neuspěje,
- runtime není zastaven,
- není aktivní kill switch.

Stav musí zůstat DISARMED a žádný retry nesmí znamenat ARM ani slepý broker write.

### P2 — fail-safe supervisor restart

**Složitost: M, přibližně 1–2 dny včetně launchd testu.**

Stávající watchdog výslovně jen upozorňuje a nic neopravuje. [watchdog.ts:1](scripts/copier/watchdog.ts:1) Launchd má `KeepAlive`, ale živý zaseknutý proces nepovažuje za mrtvý. [mac-install.ts:350](scripts/copier/mac-install.ts:350)

Oddělený supervisor může po například 10 minutách disconnectu ukončit proces, pouze pokud jsou současně splněny všechny podmínky:

- `armed=false`,
- žádný kill-switch cleanup ani probíhající broker command,
- `groupFlat=true` podle posledního autoritativního snapshotu,
- žádná durable `liveCopyOpenSince` ani otevřená leader-exposure epocha,
- žádné working orders,
- žádný stuck/sending/unknown outbox,
- žádná divergence,
- restart rate limit, například nejvýše jednou za 30 minut.

Současnou `canSafelyRestartLocalCopierAgent` nelze bezmyšlenkovitě použít: oprávněně blokuje každý disconnected/reconciliation-required stav. [localCopierAgentProtocol.ts:195](lib/localCopierAgentProtocol.ts:195) Pro incident supervisor je potřeba samostatná, užší „restart-no-write“ brána s durable důkazem nulové expozice. Pokud důkaz chybí, watchdog pouze upozorní.

## Co se nesmí změnit

Navržené availability opravy nesmějí oslabit bezpečnostní model:

- Každá transportní chyba dál volá `failClosed(..., {transportLost:true})`, ruší ARM a označuje connection jako false. [copierRuntimeController.ts:1499](services/copierRuntimeController.ts:1499)
- Reconnect nikdy automaticky neobnoví ARM; connection event explicitně zachovává `armed=false` po disconnectu. [copierRuntimeController.ts:2544](services/copierRuntimeController.ts:2544)
- Po reconnectu zůstává povinná autoritativní reconciliation a runtime zůstává DISARMED. [copierRuntimeController.ts:2323](services/copierRuntimeController.ts:2323)
- Žádný watchdog restart nesmí provést Flatten, ARM ani broker write.
- Neznámý výsledek broker operace zůstává v durable outboxu; žádný blind retry.


