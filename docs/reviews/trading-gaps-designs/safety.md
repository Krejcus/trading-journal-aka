# Bezpečnostní skupina — návrh pro obchodování z grafu (3. 11. 2026)

Základ: nasazený kód `7ae5c97b` (worktree `~/alphatrade-worktrees/scale-in`), seznam mezer
`docs/reviews/trading-gaps-20261103.md`. Návrh je jen podklad pro implementaci: nic se nezměnilo, nic se nespouštělo.
Každá položka mění jádro kopírky, takže **návrh i hotový diff musí projít agentem `copier-design-critic`**
(CLAUDE.md, bod 4). Critic na tento dokument zatím nepouštěl nikdo.

Položky: C1, C12, C8, C7, C9, C17, C16, C11 a TEL-ZRUŠIT (tlačítko „Zrušit“ v telefonní liště).

---

## 0. Společný základ

### 0.1 Žádná položka nepotřebuje migraci
- Atomická admission (`supabase/migrations/20261101090849_copier_manual_admission.sql`) přijímá jen dva typy
  příkazů: `place-leader-entry` a `manage-leader-order`. Z payloadu čte jen `type`, `payloadHash`,
  `operationId`, `entryOperationId`/`leaderEntryOrderId` a `action` (ř. 66–83).
  - Ze zámku brzdy je vyjmuté jen `cancel-entry` (ř. 128).
  - Z denního stropu je vyjmuté jen `close-position` (ř. 182).
- Brzda v téže transakci zneplatní čekající `move-stop`/`move-target`/`close-position` (ř. 326–335).
  - U nových ochranných akcí za DISARMED (C8, C9) je to konzervativní a správné: příkaz zadaný před brzdou neprojde
    a uživatel klikne znovu až po brzdě.
- Všechny položky jsou buď nové hodnoty existujících akcí, nebo nové volitelné pole uvnitř `copy-command` (C16).
  Admission JSON neprochází, relay validuje sdíleným `validateLeaderOrderManage`
  (`server/tradovateCopierCommandRelay.ts:380`).

### 0.2 Sólo skupina
`soloManualGroup()` = `group.manualOnly === true && group.localOnly === true && group.followers.length === 0 &&
brokerEnvironment === 'demo'`. Je to stejná podmínka jako `scaleInEnabled` (`services/manualScaleIn.ts:18–26`),
jen bez opt-inu. Holý Market, přikoupení a všechny výjimky „za vypnuté kopírky“ v tomto návrhu platí jen tady.
- Důvod: bez followerů nehrozí, že by leader dostal jinou ochranu než kopie. Kopírka za DISARMED followerům
  nic nezrcadlí (INV-DIVERGENCE-01, INV-BRAKE-01).

### 0.3 Nové capability
UI bez capability nic nového nenabídne. Starý worker nové pole odmítne validací.

| Capability | Položka |
|---|---|
| `manual-order-close-bare-v1` | C8 |
| `manual-order-protective-off-v1` | C9 |
| `manual-position-move-with-pending-add-v1` | C17 |
| `manual-order-close-foreign-v1` | C16 |
| `manual-order-stoplimit-v1` | C11 |

Capability inzeruje `server/localCopierExecutionAgent.ts:412`, konstanty jsou v `lib/copierWorkerCapabilities.ts`.

### 0.4 Pořadí nasazení
worker → web → iPhone. Reinstall workeru jen podle worker-deploy-policy.

### 0.5 Záznamy na DEMO (DEMO8661118, MNQ)
Skripty k brokerovi spouští Filip. Vzor `scripts/copier/record-*.ts` a `*Plan.ts`, tedy pojistky a `--confirm`.

| Záznam | Co ověří | Pro položku |
|---|---|---|
| R1 | nepodporované typy příkazů | C1, ověření po nasazení |
| R11 | posun SL typu StopLimit | C11 |
| R12 | TIF Day a chování v denní pauze CME | C12, část TIF |
| R16 | liquidate s cizím Limitem na kontraktu | C16 |
| R17 | posun pozastavených (Suspended) nohou čekajícího přikoupení | C17 |

---

## C1 — Nepodporovaný typ příkazu nesmí shodit stream

### (1) Verdikt: STAVĚT
- Oprava mění jen čtecí cestu adaptéru. Pád streamu se mění na fail-closed blokaci.
- Nespoléhá na žádné nezaznamenané chování zápisu. Typ se nikdy nemodifikuje ani nekopíruje.
- **Záznam R1 je povinný hned po nasazení opravy.** Do té doby se riziko v trading-gaps nesmí označit za
  „ověřené“ a žádná další funkce (trailing) s těmito typy nesmí počítat.
- R1 nejde udělat před opravou: záznamový skript používá stejný adaptér (`createTradovateBroker`,
  `scripts/copier/record-scale-in.ts:22`), který by na takovém příkazu sám spadl. Stejně tak nasazený worker.

**Ověřená příčina z kódu.** `supportedOrderType` (`services/tradovateBroker.ts:266–269`) vyhodí výjimku pro cokoli
mimo Market/Limit/Stop/StopLimit. Volá ho `buildComposedOrder` (:939) bez filtru účtu na těchto místech:
- baseline syncu: smyčka přes všechny příkazy přihlášení (:1603–1608),
- `buildRenewalSnapshot` (:1262–1268),
- `handleProps` u Order, OrderVersion a Fill (:1393–1507).

Výjimka v sémantickém rámci vede na `closeSocket('socket-message-error')` (:1964–1976), pak reconnect a znovu stejná
baseline. Vznikne smyčka.

### (2) Chování na PC a telefonu
- Příkaz typu TrailingStop / MIT / TrailingStopLimit / QTS (nebo neznámý typ) na **jiném účtu téhož přihlášení**:
  nic se nestane. Router entitu cizího účtu odfiltruje (INV-TRAD-06). Dnes v tomto případě spadne celé spojení.
- Takový příkaz na **účtu skupiny**:
  - LIVE řádek účtu ukáže štítek: „Cizí příkaz TrailingStop (z Tradovate) — appka ho neumí: vstup, přikoupení
    a správa z appky jsou blokované, kopírku nejde zapnout. Zruš ho v Tradovate nebo dej Flatten.“
  - Graf ukáže jen štítek, čáru nekreslí. Cenu takového příkazu UI za čáru nepovažuje.
  - Panel objednávky ukáže blocker `foreign-unsupported-order`.
  - Telefon ukáže stejný text v listu „Účty v obchodě“ (`components/day/LivePhoneAccounts.tsx`).
- Leader za ARMED ve skupině s followery:
  - vznikne incident „Leader má příkaz typu X, který kopírka neumí zkopírovat — followeři ho nedostali“,
  - kopírka se vypne (DISARM) bez auto-close.
- Sólo skupina: jen audit a blokace. Není co kopírovat, incident by byl jen šum.

### (3) Mechanismus
1. **`services/brokerPort.ts:23`.** `OrderType` dostane hodnotu `'Unsupported'`.
   - `BrokerOrder` dostane `brokerOrderType?: string`: surový typ, nejvýš 32 znaků, jen pro audit a UI.
   - Nový helper `isUnsupportedOrder(order)`.
2. **`services/tradovateBroker.ts:266`.** `supportedOrderType` se nahradí funkcí `mapBrokerOrderType(value)`.
   - Vrací `{ orderType, raw? }`. Čtyři známé typy beze změny.
   - Cokoli jiného (MIT, TrailingStop, TrailingStopLimit, QTS, chybějící nebo neznámý řetězec) dá
     `'Unsupported'` a surový typ. **Nikdy nevyhodí výjimku.**
   - `buildComposedOrder` (:930–962) nastaví `brokerOrderType`.
   - Tím projdou všechny čtecí cesty: sync, resync, `handleProps`, `streamOrderSnapshot` (:2302–2318),
     `listOrders` (:2320–2331) a `findOrderById`.
   - `findModifiedOrderById` (:2442) porovnává dál stejně. Unsupported nikdy není cílem modify.
3. **Obrana na straně zápisu.** Typ `'Unsupported'` vyhodí `TradovateTransportError('unsupported-order-type-write')`
   **před POSTem**, tedy definitivně „nic neodesláno“. Týká se:
   - `toPlaceOrderPayload` (`services/tradovateMapping.ts:69`, dědí ho OSO),
   - `ocoLegPayload`,
   - `modifyOrder` (`tradovateBroker.ts:2187`).

   `cancelOrder` zůstává beze změny: zrušit jde příkaz jakéhokoli typu.
4. **`services/tradovateMapping.ts:306`.** `TradovateOrderEntity.orderType: OrderType`. `fromOrderEntity` (:315)
   přenese surový typ.
5. **Plán kopírky** (`services/copierEngine.ts`):
   - `planReplication` udělá `skip('unsupported-order-type')` (u push s `orderType: event.orderType`, :840),
   - `planModify` (:659) vrátí `[]`.
   - Fill takového příkazu už dnes vzniká z `Fill` jako `Market` (`copierLeaderEventSource.ts:166`). On-fill exit
     zůstává beze změny.
6. **Controller, `handleBrokerEvent`**, hned za `source.observe` (`services/copierRuntimeController.ts:17112`):
   - `leaderEvent.orderType === 'Unsupported'` a druh `submitted` nebo `replaced`:
     1. `processor.record` (posun sekvence),
     2. audit `blocked: leader-unsupported-order-type:<raw>:<orderId>`,
     3. při `gate.armed && !soloManualGroup()` → `failClosed(…, { autoClose: false })`,
     4. jinak za DISARMED → `invalidateReconciliation()` (precedent 22. 10.); u sólo skupiny jen audit,
     5. `return`. Událost nikdy nejde do korelátorů, runneru ani k dispatchi.
   - Druh `canceled` nebo `rejected`: jen `processor.record` a `return`.
   - Případ, kdy uživatel v Tradovate změní SL ze Stop na Trailing (replaced → Unsupported), se chová stejně.
     Followeři drží původní SL, vznikne incident a SL se nikdy „nedorovnává“.
7. **Klasifikace typů.** Místa, která předpokládají „co není Limit, je stop“, musí Unsupported vyloučit:
   - `protectiveHoldProblem` (:11370–11373) už pro jiné typy vrací `null`, což znamená problém. Je to správné,
     jen se přidá test.
   - `services/manualScaleIn.ts`: `scaleInAddBlockers` a `positionManageBlockers` dostanou blocker `leg-type`,
     když SL noha lístku není `Stop` (po C11 i `StopLimit`) nebo TP noha není `Limit`.
   - `prepareManualOrderAction`: k `move-stop` (:5192) přibude kontrola, že TP pro `move-target` je `Limit`.
   - `services/copierManualActions.ts:317` (`mayResendLiquidation`): Unsupported na symbolu znamená, že se likvidace
     neopakuje. MIT se po dotyku chová jako trh.
8. **Status.** `CopierControllerStatus.unsupportedOrders` obsahuje nejvýš 10 položek
   `{ accountId, symbol, brokerOrderId, type, side, quantity, status }` z `liveOrdersByAccount`.
   - `evaluateManualEntryPreview` dostane `stateBlocker foreign-unsupported-order` jen kvůli textu.
     Vstup zablokují už stávající brány flat a no-working.
9. **UI.** `lib/liveChartOrderLines.ts` pro Unsupported čáru nekreslí. Štítek ukáže `LiveTradingScreen` a
   `LivePhoneAccounts`.

- Relay a admission: beze změny.
- Migrace: ne.
- `services/supabaseCopierStore.ts:21`: validace typu v durable outboxu Unsupported **nepřipustí**. Je to druhá
  pojistka: outbox takový typ nikdy nesmí nést.

### (4) Dotčené invarianty
- **INV-TRAD-01**: sync ani baseline už nespadnou. Unsupported v baseline je baseline, ne event.
- **INV-TRAD-02**: Unsupported ve stavu working/pending je aktivní riziko (`isOpenOrderStatus`). ARM, flat
  a no-working brány proto blokují.
- **INV-TRAD-06**: příkaz na cizím účtu téhož přihlášení nesmí zastavit route.
- **INV-DEFAULT-02**: neznámý stav zastaví nové riziko, ale proces nespadne. Bez auto-close.
- **INV-DIVERGENCE-01**: trailing leadera se nezrcadlí ani nedorovnává; vznikne incident.
- **INV-ARM-01**: working Unsupported se počítá jako working order, takže ARM je zablokovaný.
- **INV-RECON-04**: `protectiveHoldProblem` → problém, tedy žádné držení obchodu ani automatické pokračování.
- **INV-MODE-02**: `mayResendLiquidation` se při Unsupported neopakuje.
- **INV-MANUAL-01**: cizí příkaz blokuje vstup, přikoupení i správu.
- **INV-UI-03**: status je jen zobrazení.

**Návrh nového pravidla INV-TRAD-07:** „Typ příkazu, který adaptér nezná (MIT, TrailingStop, TrailingStopLimit, QTS,
chybějící/neznámý), se složí jako `orderType: 'Unsupported'` se surovým `brokerOrderType`; čtecí cesta nikdy
nevyhodí výjimku. Takový příkaz je cizí aktivní příkaz: blokuje ARM, ruční vstup, přikoupení i správu na svém účtu,
nikdy se nekopíruje ani nemodifikuje (adaptér zápis s tímto typem odmítne před POSTem), leaderův submit/replace na
něj za ARMED se skupinou s followery = incident bez auto-close. Zrušit ho smí Flatten a uživatel v Tradovate.“

### (5) Selhání a fail-closed
- **Trailing mění OrderVersion při každém posunu (NEOVĚŘENO, zjistí R1).**
  - Každá změna je `replaced` event. Event source deduplikuje podle signature, `failClosed` stejné chyby se
    deduplikuje.
  - Čítače fence (`tradeObservationVersionByAccount`) se točí, takže ruční příkazy na tom účtu dostanou
    `state-changed`. Nevadí to, cizí příkaz je blokuje stejně.
  - Kdyby R1 ukázal tok desítek událostí za sekundu, změří se zátěž `eventTail`.
- **Restart:** baseline obsahuje Unsupported, worker startuje DISARMED a ARM je blokovaný (INV-DEFAULT-01).
- **Zastaralý stream:** `streamOrderSnapshot` vrátí null, použije se REST. REST složí Unsupported stejně.
- **Částečný fill nepodporovaného příkazu:** `Fill` → `Market` (on-fill), leader-flat guard beze změny.
- **DISARM nebo kill uprostřed:** nic se nezapisuje.
- **Unsupported na followerovi za ARMED:** stávající verdikt „aktivní příkazy mimo kopii“, ARM potom zablokovaný.
  Flatten ho zruší (cleanup zná `cancelOrder` jakéhokoli typu).
- **Uživatel změní typ nohy vlastního OSO v Tradovate:** lístek má nohu Unsupported (`leg-type`), takže posun ani
  přikoupení nejdou. Zavření (liquidate) jde.

### (6) Záznam na DEMO — R1 (`scripts/copier/record-unsupported-order.ts` + `recordUnsupportedOrderPlan.ts`)
Podmínky: až po nasazení opravy, za DISARMED, v obchodní době (o víkendu broker příkaz odmítne), leader flat bez
příkazů.

Kroky:
1. TrailingStop Sell 1 MNQ s `pegDifference` 150 b, bez pozice. Bezpečné na pár sekund.
2. MIT Buy daleko pod trhem.
3. TrailingStopLimit.
4. Pozice 1 MNQ s OSO a `modifyorder` SL na `TrailingStop`, tedy změna typu.
5. Úklid: zrušit, liquidate, ověřit flat bez příkazů.

Co nahrát:
- surové rámce Order/OrderVersion/Command/ExecutionReport (`sanitizeRecordedFrame`),
- `/order/list` a `/orderVersion/deps`,
- zda trailing posílá OrderVersion při posunu,
- status workeru a počet reconnectů = 0.

Výstup: fixture `tests/fixtures/tradovate-unsupported-orders.json`.

### (7) Testy
- **`tests/tradovateUnsupportedOrderType.test.ts`**
  - Sync s TrailingStop na účtu mimo skupinu i ve skupině: žádný reconnect. **Mutace:** vrátit throw → test padá.
  - `listOrders`, `streamOrderSnapshot` a resync `complete: true` vrátí `orderType: 'Unsupported'` a
    `brokerOrderType: 'TrailingStop'`.
  - Neznámý řetězec i chybějící typ.
  - `placeOrder`/`modifyOrder` s Unsupported vyhodí výjimku a fetch se nezavolá.
- **`tests/copierUnsupportedLeaderOrder.test.ts`** (controller + mock broker, 1 on-submit follower)
  - Submit za ARMED → incident, nula zápisů followerovi. **Mutace:** bez interceptu follower dostane `placeOrder`.
  - Replaced Stop→Unsupported → žádný modify u followera.
  - Za DISARMED → jen `invalidateReconciliation`.
  - Sólo skupina → audit, náhled zablokovaný.
  - ARM s Unsupported na followerovi → blocked.
  - `protectiveHoldProblem` → problém.
  - Flatten ho zruší.
- `tests/copierEngine.test.ts` (skip), `tests/manualScaleIn.test.ts` (`leg-type`), `tests/tradovateMapping.test.ts`.
- Replay fixture z R1, až bude nahraná.

### (8) Soubory
`services/brokerPort.ts`, `services/tradovateBroker.ts`, `services/tradovateMapping.ts`, `services/copierEngine.ts`,
`services/copierRuntimeController.ts`, `services/manualScaleIn.ts`, `services/copierManualActions.ts`,
`services/manualEntryPreview.ts`, `services/mockBroker.ts`, `lib/liveChartOrderLines.ts`,
`components/LiveTradingScreen.tsx`, `components/day/LivePhoneAccounts.tsx`, `docs/COPIER_INVARIANTS.md`,
`scripts/copier/record-unsupported-order.ts`, `scripts/copier/recordUnsupportedOrderPlan.ts`, testy.

### (9) Velikost a závislosti
Velikost M. Bez závislostí. Záznam R1 se dělá až po nasazení.

---

## C12 — Automatické zrušení čekajícího vstupu (a TIF)

### (1) Verdikt: JEN-ČÁST
- **STAVĚT hned:** automatické zrušení všech vlastních čekajících vstupů, tedy vstupů z flat i přikoupení. Zrušení
  vlastního pracujícího vstupu je zaznamenané a používané (`cancelOwnManualEntry`).
- **STAVĚT-PO-CONFORMANCE (R12):** `timeInForce: 'Day'` posílané brokerovi u Limit/Stop vstupu. Je to druhá
  pojistka pro případ, že worker spadne.
- **ZAMÍTNOUT:** GTC u vstupu. Vstup by přežil ARM, session i mrtvý worker. To je proti DISARMED defaultu,
  fail-closed a novému textu INV-BRAKE-01 níže (čekající vstup smí existovat jen pod živým ARM).
- TIF **není volba uživatele.** Payload `place-leader-entry` se nemění.

### (2) Chování na PC a telefonu
Čekající vlastní vstup (Limit/Stop z flat i přikoupení) se sám zruší jedním cíleným pokusem, když:
- kopírka je vypnutá: ruční OFF, incident, výpadek spojení (až po obnově) nebo restart workeru,
- běží shadow nebo kill,
- je denní zámek (i čekající), pauza pravidlem dne nebo management-only,
- leader je nezpůsobilý,
- končí obchodní okno, i 5 min před koncem,
- **zbývá 5 min do denní pauzy CME 16:00 CT** (nové, platí i pro přikoupení), nebo 5 min do 17:00 CT,
- zbývá 5 min do vypršení ARM,
- jen u vstupu z flat: na symbolu se objeví pozice mimo appku (`pozice mimo appku`).

Co uvidí uživatel:
- Karta: „Čekající vstup BUY 1 LMT 21 000,00 zrušen: konec obchodního okna“.
- Push jen při selhání.
- PC panel u čekajícího vstupu: „Zruší se sám v 15:55 CT (denní pauza CME)“. Je to jen zobrazení.
- Telefon: stejný text v liště čekajícího vstupu (`LivePhonePositionBar`).
- Částečně vyplněný vstup se **neruší**. Vznikne jeden incident „zbytek vstupu dál čeká — zruš v Tradovate nebo
  dej Flatten“.

### (3) Mechanismus
1. **Pravidlo** (`services/manualScaleIn.ts`). `pendingAddViolation` (:328–364) se zobecní na
   `pendingOwnEntryViolation({ …stejné vstupy, kind: 'add' | 'from-flat', cmeHaltAt })`.
   - Pro `from-flat` platí: `net == null` → null (neznámá pozice není flat). `net !== 0 && entryFilled === 0` →
     `pozice mimo appku`.
   - `episodeMismatch` zůstává jen u přikoupení.
2. **Čas pauzy CME.** `cmeHaltAt = now + msUntilTradovateSessionEnd(now, 'America/Chicago', 16)`, tedy stávající
   helper s `endHour` (`services/copierArmSession.ts:69`). Je DST-safe podle INV-RISK-04.
   - Stejná rezerva se přidá do brány náhledu `services/manualEntryPreview.ts:291`. Nový vstup v 15:55–17:00 CT
     neprojde.
3. **Controller** (`services/copierRuntimeController.ts`). `reviewPendingScaleIns` (:3719–3765) se změní na
   `reviewPendingOwnEntries`:
   - Smyčka projde **všechny** záznamy leadera s `request.orderType !== 'Market'` (dnes jen `scaleIn === true`, :3727).
   - Skip zůstává jako dnes: `record.cancel`, requested, `sending` + `manualEntryExecuting`.
   - **Nové odklady, kdy se nic nezkouší a jen čeká:** `!gate.connected`, ingress leadera > 0, běžící obnova spojení
     nebo nedokončený resync po reconnectu.
     - Ve stávající revizi přikoupení odklad chybí. Pokus o zrušení podle zastaralé cache (příkaz se mezitím
       vyplnil) skončí falešným incidentem. Totéž se týká zrušení přes výpadek spojení.
   - `live.filledQuantity > 0` a porušení pravidla → incident jednou (`failClosed autoClose:false`, durable značka
     `pendingIncidentAt` jako `episodeIncidentAt`).
   - Skupina s followery: stejné předpoklady jako ruční `cancel-entry` (:5144–5149: follower s pozicí na symbolu,
     nepokrytá vazba). Když neplatí → incident místo zrušení.
   - Jinak `cancelOwnManualEntry(…, reason)` a hned `declineTransportResume('čekající vstup zrušen: …')`.
4. **`cancelOwnManualEntry`** (:3649–3709): selhané zrušení bude incident u **každého** čekajícího vstupu.
   Dnes jen u `record?.scaleIn === true` (:3695).
5. **Restart s `cancel.status === 'sending'` nebo `failed`** a vstupem, který pořád pracuje: dnes ho revize
   navždy přeskočí (:3743), takže čekající vstup tiše zůstane. Nově vznikne incident jednou s durable značkou.
   Žádný druhý pokus.
6. **Časovač** (:19563–19566): podmínka `some(record => record.scaleIn)` se změní na „existuje vlastní ne-Market
   záznam s otevřeným vstupem“. Hook po eventu (:19708) zůstává beze změny.
7. **Status:** `manualEntries[].autoCancelAt` a `autoCancelReason` (jen zobrazení).
8. **TIF (po R12):**
   - `BrokerOsoRequest.timeInForce?: 'Day'`.
   - `toPlaceOsoPayload` (`services/tradovateMapping.ts:216`) přidá `timeInForce: 'Day'` **jen parentu**. Nohy podle
     R12b.
   - Nastavuje ho jen `executeManualEntry` u Limit/Stop vstupu. Kopie followerů zůstávají beze změny.

- Relay a admission: beze změny.
- Migrace: ne.

### (4) Dotčené invarianty
- **INV-BRAKE-01** (změna textu): přidat „DISARM (ruční, incident, transport po obnově, restart) zruší **vlastní
  čekající vstupy z appky** (z flat i přikoupení) jedním cíleným cancel podle id z vlastního záznamu. Není to zavření
  pozice ani account-wide akce; vyplněný či částečně vyplněný vstup a ochranné nohy se nikdy neruší.“
- **INV-BRAKE-02**: třetí výjimka se rozšíří z „čekajícího přikoupení“ na „vlastní čekající vstup“.
- **INV-DEFAULT-01**: po restartu je worker DISARMED, takže čekající vstupy se zruší. Žádné „pokračování“.
- **INV-OUTBOX-01**: durable `cancel: sending` před zápisem, jeden pokus, nikdy opakování.
- **INV-FRESH-01**: zrušení jde mimo `dispatchBroker`. Výslovná výjimka jako dnes, protože snižuje riziko.
- **INV-RISK-02/04**: obchodní okno, session a pauza CME přes sdílený helper s DST.
- **INV-RECON-04**: automatické zrušení ukončí epizodu automatického pokračování.
- **INV-ARM-04 / INV-BRAKE-02**: kopie followerů zruší lifecycle `terminalCancel` (`dispatchBroker`, :1907–1918),
  už dnes.
- **INV-MODE-01**: management-only nesmí držet čekající vstup.
- **INV-DEFAULT-03**: incidenty jsou durable.
- **INV-MANUAL-01**: text čekajícího přikoupení se zobecní.

### (5) Selhání a fail-closed
- **Restart uprostřed zrušení:** viz bod 5 mechanismu. Incident, žádný druhý pokus.
- **Zrušení prošlo, ale mezitím přišel fill:** vznikne vyplněná pozice s nohami OSO, tedy běžný stav. Incident jen při
  selhání.
- **Zastaralý stream nebo výpadek:** odklad (bod 3), nikdy pokus nad starou cache.
- **DISARM nebo kill uprostřed:** zrušení je samo reakce na brzdu. Nové ARM po zrušení vstup nevrátí, a to je záměr.
- **Selhání zrušení:** incident bez auto-close a push.
- **Zrušení odmítnuté v pauze 16:00–17:00 CT:** pravidlo 15:55 CT tomu předchází. Jestli broker v pauze zrušení
  přijímá, zjistí R12d.
- **Skupina s followery, kopie se vyplnila dřív než leader:** neruší se, vznikne incident. Divergenci řeší stávající
  S1b a V2.

### (6) Záznam na DEMO — R12 (`scripts/copier/record-time-in-force.ts`)
- **a)** `placeoso` Limit 1 MNQ daleko od trhu s `timeInForce: 'Day'`. Přijme ho broker? Nesou `/order/item` a
  `/orderVersion/deps` údaj TIF? Potom zrušit.
- **b)** Totéž v 15:50 CT a nechat do 16:00 i 17:00 CT. Stav `Expired` (`toOrderStatus` → canceled)? Zaniknou
  pozastavené nohy?
- **c)** Pozice 1 MNQ s OSO nohami bez TIF (výchozí stav) přes 16:00 CT. **Přežijí nohy?**
  - Výchozí TIF nohou je dnes NEOVĚŘENÝ (záznam fáze 0, `scale-in-design` §2) a týká se i dnešních pozic.
- **d)** `cancelorder` v pauze 16:00–17:00 CT: přijato, nebo odmítnuto?

### (7) Testy
- **`tests/manualPendingEntryReview.test.ts`** (čistá funkce): každá podmínka zvlášť; from-flat s pozicí mimo
  appku; `net` null = nic; 15:55 CT v den přechodu času (březen i listopad). Mutace na každou větev.
- **`tests/manualPendingEntryReplay.test.ts`** (controller + mock):
  - DISARM → právě jeden `cancelOrder`. **Mutace:** odstranit podmínku `!armed` → test padá.
  - Kill; konec okna; částečný fill → bez zrušení a 1 incident; zrušení selže → incident.
  - Spojení dole → žádný pokus; po obnově a resyncu pokus.
  - Follower s pozicí → incident bez zrušení. Market nikdy.
  - Restart s `cancel: sending` → incident, žádný druhý pokus. `declineTransportResume` zavolán.
- `tests/copierArmSession.test.ts` (16:00 CT přes DST), `tests/tradovateMapping.test.ts` (TIF jen parent).

### (8) Soubory
`services/manualScaleIn.ts` (nebo nové `services/manualPendingEntries.ts`), `services/copierRuntimeController.ts`,
`services/manualEntryPreview.ts`, `services/copierArmSession.ts`, `services/brokerPort.ts`,
`services/tradovateMapping.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneLiveActions.tsx`,
`docs/COPIER_INVARIANTS.md`, `scripts/copier/record-time-in-force.ts`, testy.

### (9) Velikost a závislosti
Velikost M; část TIF S. Bez tvrdé závislosti. C7 sdílí stavový seznam čekajících vstupů.

---

## C8 — × zavřít holý Market bez SL/TP

### (1) Verdikt: STAVĚT
Dnes `close-position` vyžaduje obě nohy (`resolveManagedTrade`, :4557; `executeClose` `legsLive`, :4264–4265).
`manageableLeaderTrades` holý vstup vynechává (:21099). Holou pozici proto zavře jen Flatten, který vypne kopírku.

### (2) Chování na PC a telefonu
- **Telefon:** lišta „LONG 2 · BEZ SL/TP · Přidat SL/TP · Zavřít“. „Zavřít“ (dvě klepnutí) zavře jen holou pozici
  leadera, kopírka zůstává zapnutá. Totéž dělá × na čáře pozice v grafu.
- **PC:** holá pozice založená z telefonu dostane čáru s × (dnes nemá nic).
- Výsledek: „Pozice zavřena“, nebo „Výsledek neznámý — zkontroluj leadera“ s incidentem.
- Flatten zůstává na Dashboardu.

### (3) Mechanismus
1. **Payload se nemění.** Jde o `manage-leader-order close-position`:
   - `entryOperationId` = holý záznam,
   - `expect: { price: record.request.referencePrice, quantity: record.request.quantity }`.
   - Cena je na ticku (ask/bid), takže projde validátorem.
2. **Status:** `bareLeaderTrade: { entryOperationId, symbol, side, quantity, referencePrice } | null`. Výběr je
   stejný jako `bare` v desku (`components/TradovateLiveDesk.tsx:1170`): nejnovější, acknowledged, bare, bez nohou,
   otevřený. Plus capability `manual-order-close-bare-v1`.
3. **Worker.** V `prepareManualOrderAction` (:5082), ještě před `resolveManagedTrade`: když `close-position`
   míří na holý záznam bez nohou, volá se nová funkce `prepareBareClose` podle vzoru `prepareAttachBrackets`
   (:4595–4769).
   - **Ve frontě:**
     1. sólo skupina,
     2. záznam je nejnovější a `closedAt == null` (žádné „adoptování“ cizí pozice),
     3. žádná nevyřešená správa, ingress leadera 0,
     4. ohraničené čerstvé čtení `listOrders(fresh)` a `listPositions` (3 s),
     5. fence,
     6. tvar: vstup vyplněný přesně na qty, |net| = qty na správné straně, **na symbolu nepracuje žádný příkaz**
        (jinak blocked „Flatten“, s C16 „potvrď cizí příkazy“), `expect` sedí,
     7. durable `manualOrderActions` `sending`.
   - **Mimo frontu:** `executeClose` (:4257) dostane parametr `legs: { stopId, targetId } | null`.
     - U holé pozice se místo `legsLive` synchronně ověří, že na symbolu nic nepracuje (cache) a `streamNet` = qty.
     - Brána ARM (:4266) se pro sólo skupinu uvolní teprve s C9. Do té doby jen za ARMED.
     - Raw `liquidatePosition` a `registerInFlightBrokerWrite`.
   - **Výsledek podle stavu** (`readLeaderSymbolState`, :4235):
     - flat a 0 pracujících příkazů → `acknowledged` a `closedAt` záznamu,
     - flat už před zápisem → `waived`,
     - pozice trvá → `unknown` a incident „holá pozice N trvá, zavření nepotvrzeno“ bez auto-close,
     - timeout nebo indeterminate → stávající ověřovací větev `executeClose`.
   - `unknown` dořeší jen čtení pozice (vzor 2d P4).

- Relay: TTL zavření 5 s (`server/tradovateCopierCommandRelay.ts:117`), mimo denní strop. Beze změny.
- Migrace: ne.

### (4) Dotčené invarianty
- **INV-MANUAL-01** (změna textu): věta „Zavření holé pozice v telefonu = Flatten skupiny“ se nahradí za
  „= `close-position` holého záznamu (jen sólo skupina, výsledek stavem); Flatten zůstává záloha na Dashboardu“.
- **INV-MODE-02**: výsledek likvidace se potvrzuje stavem.
- **INV-OUTBOX-01/02**: `sending` před zápisem; `unknown` blokuje další správu.
- **INV-BRAKE-01..03**: relay supersede a agent `brake-after-request` (`localCopierExecutionAgent.ts:971`) beze změny.
- **INV-RELAY-01/03**.
- **INV-DEFAULT-02**: nejasný výsledek = incident.
- **INV-PART-03**: vlastnictví jen z vlastního záznamu, ne z pozice.
- **INV-UI-01/02**: jen čerstvý status; Flatten dál dosažitelný.

### (5) Selhání a fail-closed
- **Restart v `sending`:** → `unknown`, dořeší čtení.
- **Cizí příkaz přidaný mezi čtením a zápisem:** liquidate ho zruší. Vědomě stejné jako u 2d (INV-MANUAL-01).
- **Flatten současně:** zápis je registrovaný, Flatten leadera vynechá jako nejasný zápis, takže druhá likvidace
  nevznikne.
- **Zastaralý stream:** REST.
- **DISARM mezi přípravou a zápisem:** `not-sent`, uživatel klikne znovu (po C9 projde).

### (6) Záznam na DEMO
Není potřeba. Liquidate pozice bez příkazů je cesta Flattenu používaná v produkci. Liquidate s nohami je ověřený
30. 10. a 3. 11. Po nasazení stačí akceptace z appky na DEMO.

### (7) Testy
**`tests/manualEntryBareClose.test.ts`:**
- běžná cesta,
- cizí příkaz → blocked,
- starší záznam nebo `closedAt` → blocked,
- jiný počet kontraktů → blocked,
- pozice po zápisu trvá → `unknown` a incident. **Mutace:** vrátit `acknowledged` → test padá,
- Flatten současně,
- restart v `sending`.

Dál `tests/livePhoneOrders.test.ts` (lišta).

### (8) Soubory
`services/copierRuntimeController.ts`, `lib/copierWorkerCapabilities.ts`, `server/localCopierExecutionAgent.ts`,
`components/TradovateLiveDesk.tsx`, `lib/livePhoneOrders.ts`, `components/day/LivePhoneChart.tsx`,
`components/day/LivePhoneLiveActions.tsx`, `components/LiveTradingScreen.tsx`, `lib/liveChartOrderLines.ts`,
`docs/COPIER_INVARIANTS.md`.

### (9) Velikost a závislosti
Velikost S. Za DISARMED až s C9.

---

## C7 — „Zrušit vše“ = zrušit čekající vstupy, nikdy ochranu pozice

### (1) Verdikt: STAVĚT, s rozhodnutím
„Zrušit vše“ ruší **jen vlastní čekající vstupy a přikoupení**, které mají nulový fill. **Nikdy** neruší ochranné
SL/TP nohy otevřené pozice ani cizí příkazy.

Zdůvodnění:
1. Zrušit SL otevřené pozice zvětšuje riziko. Pozice zůstane nahá, což je proti INV-BRAKE-01/02, kde brzdové
   a správní výjimky smí riziko jen snižovat.
2. Tradovate „Cancel All“ ruší i nohy. Je to známá past. Kdo chce pryč všechno včetně pozice, má Flatten
   (likvidace a úklid ve stavovém ověření, INV-MODE-02).
3. Cizí příkaz (z Tradovate nebo TradingView) appka nevlastní (duch INV-PART-03: vlastnictví jen ze stopy appky).
   Může to být uživatelův ochranný Stop. Appka ho ukáže a pošle uživatele do Tradovate nebo na Flatten.
4. Pozastavené nohy čekajícího vstupu odejdou s parentem (nativní OSO). Nechrání žádnou pozici.
5. Dnes může existovat nejvýš **jeden** vlastní čekající vstup: vstup z flat vyžaduje účet bez příkazů a přikoupení
   jen jedno čekající. Návrh je ale připravený na N (žebřík z jiné skupiny položek).

### (2) Chování na PC a telefonu
- **PC panel objednávky a Dashboard:** tlačítko „Zrušit čekající (N)“, jen když worker hlásí vlastní čekající vstupy.
  Dvoukrokové potvrzení s textem: „SL/TP otevřené pozice zůstávají. Cizí příkazy: N — zruš v Tradovate nebo Flatten.“
- **Dashboard „Zrušit příkaz“:** dnes posílá `cancel-order` a worker vyhodí výjimku
  (`localCopierExecutionAgent.ts:926–927`; UI `LiveCopyTradeOverview.tsx:2131, 2507`). Nově:
  - u vlastního čekajícího vstupu → `cancel-entry`,
  - jinde se tlačítko neukáže.
- **Telefon:** stejné tlačítko v listu „Účty v obchodě“.

### (3) Mechanismus
- **Žádný nový příkaz.** N× `manage-leader-order cancel-entry`, každý s vlastním `operationId`. Admission má busy
  klíč per obchod, takže se příkazy neblokují. Brzda je nezneplatní (migrace ř. 128).
- **Status:** `pendingOwnEntries: [{ entryOperationId, entryBrokerOrderId, symbol, side, quantity, orderType, price,
  scaleIn }]` = `manualEntryRecords` ∩ `liveOrdersByAccount` (otevřené, fill 0). Nohy a vyplněné vstupy z definice
  vypadnou.
- **Desk:** `cancelOwnPendingEntries()` poslouží PC i telefonu. Posílá sekvenčně a vrací výsledek po položkách.
- **Worker:** `cancel-entry` pro vstup z flat i přikoupení už existuje (:5140–5152; u přikoupení desk :1107–1120).
  Beze změny.
- Agent `cancel-order` dál vyhazuje výjimku kvůli starým klientům.
- Relay a admission: beze změny.
- Migrace: ne.

### (4) Dotčené invarianty
INV-BRAKE-01/02 (ochrana pozice se nikdy neruší), INV-MANUAL-01, INV-RELAY-01/03 (výjimka `cancel-entry`),
INV-OUTBOX-01, INV-TRAD-02 (částečně vyplněný vstup se neruší), INV-PART-03, INV-UI-01..03.

### (5) Selhání a fail-closed
- **Vstup se vyplní mezi zobrazením a příkazem:** worker vrátí `entry-not-pending` (:5141) a nic nepošle.
- **Částečně vyplněný vstup:** totéž, plus text „zavři × / Flatten“.
- **Relay 409 busy:** text.
- **Jeden z N neprojde:** výsledek po položkách, nic se automaticky neopakuje.
- **DISARM mezi:** `cancel-entry` projde, protože snižuje riziko.

### (6) Záznam na DEMO
Není potřeba. `cancel-entry` je ověřené.

### (7) Testy
- `tests/liveCancelPending.test.ts`: nikdy nevybere nohu pozice ani cizí id. **Mutace:** přidat nohu → test padá.
  Plus dvoukrok a výsledky po položkách.
- Controller: status `pendingOwnEntries`.
- `tests/liveCopyCancelOrderUi.test.ts`: Dashboard už `cancel-order` neposílá.

### (8) Soubory
`services/copierRuntimeController.ts`, `components/TradovateLiveDesk.tsx`, `components/LiveOrderTicket.tsx`,
`components/LiveCopyTradeOverview.tsx`, `components/day/LivePhoneAccounts.tsx`, `lib/livePhoneOrders.ts`, nové
`lib/liveCancelPending.ts`.

### (9) Velikost a závislosti
Velikost S. Měkká závislost na C12 (společný stavový seznam).

---

## C9 — Ochranná správa za DISARMED

### (1) Verdikt: JEN-ČÁST
**Za DISARMED, shadow i kill jde jen v sólo skupině:**
- utažení SL k trhu,
- SL na BE,
- × zavřít pozici (vlastní 2a, celá pozice, holá C8),
- zrušení čekajícího vstupu a doplnění SL/TP (obojí jde už dnes).

**Nejde:**
- SL dál od trhu (zvětšuje riziko),
- posun TP (neochranný),
- cokoli ve skupině s followery. Kopírka za DISARMED nic nezrcadlí, takže leader by měl jinou ochranu nebo exit než
  kopie (INV-DIVERGENCE-01, INV-BRAKE-01). Tam zůstává Flatten nebo Tradovate.

Zdůvodnění podle invariantů:
- INV-BRAKE-01 říká, že DISARM zastavuje **nové kopie**, ne uživatelovo snížení rizika vlastní pozice.
- INV-BRAKE-02 kill ponechává „přesně vymezené risk-reducing akce“. Ruční zavření nebo utažení vlastního obchodu
  v sólo skupině je výslovný úkon uživatele, snižuje riziko a nevytváří expozici. Je to stejná třída jako Flatten
  a doplnění SL/TP, které už za DISARMED a kill smí.
- INV-ARM-01/03: nic z toho nezapíná kopírku. Fence a generation se před zápisem kontrolují dál.

### (2) Chování na PC a telefonu
- V sólo skupině za vypnuté kopírky jde čára SL táhnout jen k trhu. BE a × jsou aktivní.
- Štítek: „Kopírka vypnutá — jen utažení SL, BE a zavření“.
- Pokus táhnout SL dál nebo posunout TP zablokuje UI předkontrola s textem.
- Skupina s followery beze změny.

### (3) Mechanismus
1. **Predikát** `protectiveOffAllowed(action, away)` = `soloManualGroup() && (action === 'close-position' ||
   (action === 'move-stop' && !away))`.
2. **`manageReachBlockers`** (:4166–4208) a **`closeReachBlockers`** (:4214–4233):
   - první řádek (armed/shadow/kill) platí jen bez `protectiveOffAllowed`;
   - mimo ARMED v sólo skupině se použije `soloReachBlockers(leader, symbol)`: běžící Flatten, rozpracovaný zápis
     na leaderovi, ingress leadera, `!gate.connected`, chybějící route epoch;
   - pro utažení navíc stuck/unknown zápis (`hasDispatchBlockingStuckOutbox`, nevyřešený ruční vstup);
   - zavření takové věci neblokují, je to třída Flattenu.
3. **Zápis:**
   - `move-stop` za ARMED jde dál přes `dispatchBroker(generation)`.
   - Mimo ARMED v sólo skupině raw `options.broker.modifyOrder` (vzor attach, :4697). `dispatchBroker` by zápis
     odmítl přes `haltReason`.
   - Synchronní kontrola těsně před zápisem (:5303–5311: fence a generation) **zůstává** a dává `not-sent`. Brzda mezi
     přípravou a zápisem tedy zápis zastaví a uživatel klikne znovu. Bez nové výjimky ve fenci.
   - `executeClose` (:4266): větev `!gate.armed…` platí jen mimo sólo skupinu.
   - Stejně `preparePositionAction` (:4953–4956, :4990–4994, :4876–4881).
4. **`finish`** (:5286): hláška „followeři mají původní SL“ jen když followeři existují.
5. **Automatické pokračování:** každý takový zápis zavolá `declineTransportResume`. Nové id likvidace by
   pokračování stejně odmítlo (INV-RECON-04).
6. **UI:**
   - `livePhoneManageFields` (`lib/livePhoneOrders.ts:146`): `closeSupported` = capability ∧ runtime ∧
     ((armed ∧ ¬shadow) ∨ (sólo ∧ `manual-order-protective-off-v1`)).
   - PC `LiveTradingScreen.tsx:286` stejně.
   - `liveLineMoveBlockReason` (`lib/liveChartOrderLines.ts:37`) dostane `copierOff` a zablokuje SL dál a TP.

- Agent: beze změny. Příkaz starší než brzda dál dostane `brake-after-request`, nový po brzdě projde.
- Relay: beze změny.
- Migrace: ne.

### (4) Dotčené invarianty
- **INV-BRAKE-01**: vypnutí neznamená zákaz ručního snížení rizika uživatelem.
- **INV-BRAKE-02** — návrh čtvrté výjimky: „V sólo manual-only DEMO skupině bez followerů smí výslovný úkon
  uživatele `close-position` (vlastní / celá pozice / holá) a utažení SL či BE vlastního obchodu leadera proběhnout i
  za DISARMED, shadow a kill — raw broker, jeden pokus, výsledek stavem, nikdy posun dál od trhu ani TP.“
- **INV-ARM-01/03**: žádný ARM; fence a generation před zápisem.
- **INV-ARM-04**: shadow pustí jen risk-redukční zápis.
- **INV-FRESH-01**: raw zápis mimo `dispatchBroker` je výslovná výjimka jako attach.
- **INV-MODE-02**.
- **INV-RELAY-03**: supersede beze změny.
- **INV-RECON-04**.
- **INV-DIVERGENCE-01**: bez followerů není divergence.
- **INV-UI-02**: OFF je dál dosažitelný; ochranné akce vyžadují čerstvý status.

### (5) Selhání a fail-closed
- **Brzda mezi přípravou a zápisem:** `not-sent`.
- **Modify přes trh:** broker vrátí InvalidPrice (záznam 30. 10.) → `rejected`.
- **Kill během zápisu:** raw zápis už odešel, výsledek rozhodne stream nebo čtení.
- **Restart v `sending`:** `unknown` a dořešení čtením (stávající cesta).
- **Zastaralý stream:** REST.

### (6) Záznam na DEMO
Žádný nový. Modify Stop k trhu a přes trh je zaznamenaný 30. 10., liquidate také. Po nasazení akceptace na DEMO za
DISARMED.

### (7) Testy
**`tests/manualOrderProtectiveOff.test.ts`:**
- sólo skupina DISARMED: utažení → raw modify,
- SL dál → blocked. **Mutace:** povolit „away“ → test padá,
- TP → blocked,
- kill: zavření projde,
- skupina s followery DISARMED → blocked jako dnes. **Mutace:** odstranit `soloManualGroup` → test padá,
- brzda mezi přípravou a zápisem → `not-sent`,
- `declineTransportResume` zavolán.

### (8) Soubory
`services/copierRuntimeController.ts`, `lib/copierWorkerCapabilities.ts`, `server/localCopierExecutionAgent.ts`,
`lib/livePhoneOrders.ts`, `components/LiveTradingScreen.tsx`, `lib/liveChartOrderLines.ts`,
`components/TradovateLiveDesk.tsx`, `docs/COPIER_INVARIANTS.md`.

### (9) Velikost a závislosti
Velikost M. Závisí na C8 (holá pozice).

---

## C17 — Posun SL/TP celé pozice během čekajícího přikoupení

### (1) Verdikt: STAVĚT-PO-CONFORMANCE (R17)
Modify pozastavených nohou nevyplněného OSO nebylo nahrané. Fáze 0 nahrála jen modify pracujících nohou a pozastavené
nohy čekajícího přikoupení bez modify.

### (2) Chování na PC a telefonu
- Tah SL/TP pozice nebo BE posune na jednu novou cenu i SL/TP čekajícího přikoupení.
- Text u čáry: „posune i čekající přikoupení“.
- Blokace „nejdřív zruš přikoupení“, když nový SL leží blíž než 8 ticků k ceně čekajícího přikoupení nebo za ní
  (long: SL musí být pod Limitem přikoupení). Totéž platí pro TP vůči Stop přikoupení nad trhem.

### (3) Mechanismus
1. **`positionManageBlockers`** (`services/manualScaleIn.ts:370–402`). Místo `scale-in-pending` (:392) povolit
   **právě jedno** čekající přikoupení s `entryFilled === 0`, jehož nohy mají stav `pending` a stejnou cenu.
   - `stopUniform` a `targetUniform` už počítají všechny otevřené nohy (:198–200).
   - Krytí (`stopCovered`) a `unconfirmedLegs` se počítají jen z vyplněných lístků (nové pole modelu).
   - `tickets.some(entry !== 'filled')` vyjme tento jeden čekající lístek.
   - Nové vstupy `pendingAddPrice` a `pendingAddType` a pravidla 8 ticků.
2. **`preparePositionAction`** (:4911–4963):
   - `legs` = nohy vyplněných lístků (`working`) a nohy čekajícího přikoupení (`pending`). Každý záznam nohy nese
     očekávaný stav.
   - Riziko při posunu SL dál (:4930–4952) = `scaleInPositionLossPoints` a ztráta přikoupení z jeho ceny (Limit) nebo
     z ceny + 6 ticků (Stop) × qty.
3. **Kontrola těsně před zápisem** (:4992–5000):
   - noha přikoupení musí mít `live.status === 'pending'`,
   - vstup přikoupení musí být otevřený s fill 0,
   - jinak `notSentAll`: přikoupení se mezitím vyplnilo, uživatel klikne znovu.
4. **Potvrzení:** predikát adaptéru `modifyOrder` (`tradovateBroker.ts:2199`) a controller (:5031) přijímají
   `isOpenOrderStatus`, tedy i `pending`. Beze změny.
5. **Capability** `manual-position-move-with-pending-add-v1`. Bez ní zůstává dnešní blokace.

- Relay a admission: beze změny (`scope: 'position'`).
- Migrace: ne.

### (4) Dotčené invarianty
- **INV-MANUAL-01** (změna textu přikoupení): místo „posun: žádné čekající přikoupení“ → „posun smí s jedním
  čekajícím přikoupením bez fillu, jehož pozastavené nohy se posunou stejně (po R17)“.
- **INV-TRAD-02**: Suspended je aktivní riziko a qty spravuje venue. Posílá se qty potvrzené streamem; přikoupení má
  jen 1 kontrakt.
- **INV-OUTBOX-01/02**: všechny nohy durable `sending` jedním zápisem.
- **INV-OUTBOX-03**: tvar se nedostavuje, jen se modifikují existující nohy.
- **INV-RISK-01**: riziko zahrnuje přikoupení.
- **INV-FRESH-01**.
- **INV-UI-01**.

### (5) Selhání a fail-closed
- **Přikoupení se vyplní uprostřed N× modify:** výsledek se hodnotí po nohách. Rozjetí hlídá `legs-diverged`
  (náprava přes C16 „Sjednotit SL“), nadkrytí hlídá `overCoverStep`.
- **Modify pozastavené nohy odmítnut:** rozjeté ceny, takže jde jen zavřít nebo sjednotit.
- **Restart:** `sending` → `unknown`.
- **DISARM uprostřed:** `dispatchBroker` zápis zruší → `not-sent` po nohách.

### (6) Záznam na DEMO — R17 (`scripts/copier/record-scale-in.ts --scenario pending-modify`)
1. Základ 1 MNQ Market OSO.
2. Čekající přikoupení Limit 1 s pozastavenými nohami.
3. Souběžný modify SL a TP základu i pozastavených nohou o 1 b dál.
   - Je modify přijat? Zůstane noha Suspended s novou cenou? Přijde `stream-replaced`?
4. Posunout Limit přikoupení k trhu, ať se vyplní. Nohy pak pracují s novou cenou?
5. Pozastavený SL posunutý **přes trh** (long: nad trh): přijme ho broker, nebo odmítne InvalidPrice?
   Po vyplnění by se hned spustil — rozhodne o pravidle 8 ticků.
6. Modify pozastavené nohy a pak zrušení přikoupení.
7. Liquidate, ověřit flat bez příkazů.

### (7) Testy
- `tests/manualScaleIn.test.ts`: brána s jedním čekajícím přikoupením, krytí jen z vyplněných, pravidla 8 ticků.
  **Mutace:** bez pravidla → test padá.
- `tests/manualScaleInReplay.test.ts` s fixture z R17: posun všech nohou; přikoupení vyplněné mezi přípravou a
  zápisem → `not-sent`; odmítnutá pozastavená noha → `legs-diverged`.
- `tests/liveScaleIn.test.ts` (UI).

### (8) Soubory
`services/manualScaleIn.ts`, `services/copierRuntimeController.ts`, `lib/copierWorkerCapabilities.ts`,
`server/localCopierExecutionAgent.ts`, `components/TradovateLiveDesk.tsx`, `lib/liveScaleIn.ts`,
`lib/liveChartOrderLines.ts`, `scripts/copier/record-scale-in.ts`, `scripts/copier/recordScaleInPlan.ts`,
`docs/COPIER_INVARIANTS.md`.

### (9) Velikost a závislosti
Velikost M. Závisí na R17. Měkce na C16 (náprava rozjetí).

---

## C16 — Správa při cizím příkazu, rozjetých nohou a částečně vyplněném vstupu

### (1) Verdikt: JEN-ČÁST (jen sólo skupina)
**Bezpečná podmnožina:**
- **(a)** × zavřít pozici, i když na symbolu pracuje cizí příkaz. Jen když uživatel id cizích příkazů výslovně
  potvrdí v payloadu.
- **(b)** × zavřít částečně vyplněný vlastní vstup. Liquidate zruší zbytek vstupu i nohy a zavře net.
- **(c)** „Sjednotit SL“: rozjeté SL nohy se posunou na nejochrannější cenu. Každá noha jen k trhu, takže jde o
  utažení.

**Ne:**
- posun SL/TP s cizím příkazem nebo dílčím fillem nohy,
- zrušení zbytku částečně vyplněného vstupu. Kaskáda na nohy je u Tradovate NEOVĚŘENÁ (INV-DIVERGENCE-01, známé
  limity) a dílčí fill na DEMO nejde spolehlivě vyvolat,
- skupiny s followery (Flatten).

### (2) Chování na PC a telefonu
- × u pozice s cizím příkazem ukáže potvrzení: „Zavření zruší i cizí příkazy na MNQZ6: SELL STP 20 950 (Tradovate),
  … — Opravdu?“
- U rozjetých SL nohou se ukáže tlačítko „Sjednotit SL na X“.
- Částečně vyplněný vstup má × s textem „zavře X kontraktů a zruší zbytek vstupu“.

### (3) Mechanismus
1. **Payload** (`lib/leaderOrderManage.ts`): nové volitelné pole `acknowledgedForeignOrderIds?: string[]`.
   - Nejvýš 10 položek, `LEADER_ORDER_ID_PATTERN`, jen u `close-position`.
   - Přidat do `KEYS` (:60) a do hashe.
   - Capability `manual-order-close-foreign-v1`.
   - Relay validuje sdíleně (:380). Admission pole nečte → **migrace ne.**
2. **Zavření s cizím příkazem.** Týká se 2a (:5165–5167), celé pozice (`positionManageBlockers` :383 a :4876–4881)
   a holé pozice (C8).
   - V sólo skupině se místo `others.length > 0 → blocked` porovná množina cizích otevřených příkazů na symbolu
     s `acknowledgedForeignOrderIds`. Shoda musí být přesná, jinak `order-changed`.
   - Cizí příkaz na jiném symbolu likvidace nezasáhne.
3. **Částečně vyplněný vstup (2a, :5158):** v sólo skupině projde tvar „vstup pracuje s fill > 0, |net| = fill,
   správná strana“. `expect.quantity` = |net|. Liquidate zruší i zbytek vstupu (záznam fáze 0).
4. **Sjednotit SL** (`positionManageBlockers` :398 a `preparePositionAction`):
   - `move-stop` s `newPrice === model.stopPrice` (nejochrannější) při `!stopUniform` a žádném dílčím fillu nohy je
     povolený;
   - modify jde jen nohám s jinou cenou; každá jde k trhu, takže platí pravidla utažení (8 ticků od IBKR, pod TP).
5. **Status:** `leaderPositions[].foreignOrders: [{ id, type, side, qty, price }]` pro potvrzovací text. Jen
   zobrazení.

### (4) Dotčené invarianty
- **INV-MODE-02**: zavření se potvrzuje stavem.
- **INV-MANUAL-01**.
- **INV-OUTBOX-03**: nic se nedostavuje.
- **INV-TRAD-02**: dílčí fill — modify nohou se nedělá.
- **INV-PART-03**: cizí příkaz se ruší jen s výslovným potvrzením uživatele.
- **INV-DIVERGENCE-01**.
- **INV-UI-01/03**: potvrzené id = „co jsem viděl“; worker je ověří u brokera.
- **INV-BRAKE-01**.

### (5) Selhání a fail-closed
- **Nový cizí příkaz po potvrzení:** množina nesedí → `order-changed`, nic se nepošle.
- **Cizí příkaz přibude mezi kontrolou a zápisem:** liquidate ho zruší. Vědomý závod, stejně jako 2d.
- **Pozice po zavření trvá:** `unknown` a incident.
- **Sjednocení částečně odmítnuto:** výsledek po nohách, žádné opakování.
- **Restart:** `sending` → `unknown`.

### (6) Záznam na DEMO — R16 (`record-scale-in.ts --scenario foreign-close`)
Pozice 1 s OSO a „cizí“ Limit daleko od trhu na stejném kontraktu, položený skriptem mimo záznamy appky. Liquidate:
zruší broker i cizí Limit? Úklid. Sjednocení nohou (modify) je zaznamenané už ve fázi 0b.

### (7) Testy
- `tests/manualOrderCloseForeign.test.ts`: potvrzená množina projde, jiná množina → blocked. **Mutace:** bez porovnání
  → test padá.
- Částečně vyplněný vstup → liquidate; skupina s followery → blocked.
- `tests/manualScaleIn.test.ts`: sjednocení jen k trhu a jen nohy s jinou cenou.

### (8) Soubory
`lib/leaderOrderManage.ts`, `services/copierRuntimeController.ts`, `services/manualScaleIn.ts`,
`lib/copierWorkerCapabilities.ts`, `server/localCopierExecutionAgent.ts`, `components/TradovateLiveDesk.tsx`,
`components/LiveTradingScreen.tsx`, `components/day/LivePhoneOrderLines.tsx`, `docs/COPIER_INVARIANTS.md`.

### (9) Velikost a závislosti
Velikost M. Závisí na C1 (Unsupported v potvrzené množině), C8 a měkce na C9.

---

## C11 — Posun SL typu StopLimit

### (1) Verdikt: STAVĚT-PO-CONFORMANCE (R11)
Dnes je blokovaný (:5192, :4917), protože modify posílá jen `stopPrice` a limit by zůstal pozadu. Například long SL
stop 95 s limitem 99,75: stop se spustí na 95, ale prodejní limit nad trhem se nevyplní a pozice zůstane bez ochrany.

### (2) Chování na PC a telefonu
- SL typu StopLimit (změněný v Tradovate nebo u sledovaného obchodu) jde táhnout a dát na BE stejně jako Stop.
- Limit se posune o stejný odstup.
- Štítek: „SL STP-LMT · limit −2 t“.

### (3) Mechanismus
1. **Kontrola tvaru** (:5192, :4917): `StopLimit` se povolí, když:
   - `limitPrice` existuje,
   - odstup `limit − stop` je na ticku,
   - limit leží na horší straně (long SL: limit ≤ stop; short: ≥),
   - |odstup| ≤ 40 ticků.

   Jinak `stop-limit-shape`.
2. **Zápis:** modify s `{ orderType: 'StopLimit', stopPrice: new, limitPrice: new + offset }` (:5326–5330,
   :5006–5009). Adaptér `price` posílá už dnes (`tradovateBroker.ts:2193`).
3. **Utažení:** pravidlo 8 ticků od IBKR platí pro stop i limit.
4. **Riziko při posunu dál:** ztráta se počítá z limitu (horší cena). UI upozorní, že při nevyplnění limitu je
   ztráta neomezená.
5. **Potvrzení:** rozšířit o `confirmed.limitPrice === newLimit` (:5371–5376, :5031).
6. **Followeři:** `planModify` kopíruje obě ceny. `copierOsoModifyCascade.ts:50–52` už StopLimit s limitem připouští.
7. **Capability** `manual-order-stoplimit-v1`.

- Relay: beze změny.
- Migrace: ne.

### (4) Dotčené invarianty
- **INV-MANUAL-01 2c** (změna textu): místo „Jen prostý `Stop`“ → „`Stop`, nebo `StopLimit` s posunem obou cen o
  zachovaný odstup na horší straně (po R11)“.
- **INV-OUTBOX-01/02**, **INV-RISK-01**, **INV-DIVERGENCE-01** (modify u followera běžnou cestou), **INV-TRAD-02**,
  **INV-UI-04** (IBKR jen jako brzda utažení).

### (5) Selhání a fail-closed
- **Broker modify odmítne:** `rejected`, noha zůstane beze změny.
- **Přijatý modify s jiným limitem:** potvrzení nesedí → `unknown`, dořeší čtení.
- **Stop přes trh:** zda broker odmítne InvalidPrice, ověří R11.
- **Odmítnutý modify u followera:** stávající cesta (režim jen správy, nebo fail-closed).

### (6) Záznam na DEMO — R11 (`record-leader-oso.ts --scenario stop-limit`)
1. Pozice 1 s OSO.
2. Změna typu SL na StopLimit (stop − 2 t).
3. Posun dál, utažení, BE.
4. Posun přes trh. Odmítne ho broker?
5. Limit na lepší straně. Odmítne ho broker?
6. Tvar `stream-replaced`.
7. Liquidate.

### (7) Testy
`tests/manualOrderManage.test.ts` a `tests/manualScaleInReplay.test.ts`:
- StopLimit posun zachová odstup. **Mutace:** posílat jen stop → test padá.
- Tvar na lepší straně → blocked.
- Potvrzení vyžaduje oba limity.

### (8) Soubory
`services/copierRuntimeController.ts`, `services/manualScaleIn.ts`, `lib/copierWorkerCapabilities.ts`,
`server/localCopierExecutionAgent.ts`, `lib/liveChartOrderLines.ts`, `lib/liveChartPosition.ts`,
`components/TradovateLiveDesk.tsx`, `scripts/copier/record-leader-oso.ts`, `scripts/copier/recordLeaderOsoPlan.ts`,
`docs/COPIER_INVARIANTS.md`.

### (9) Velikost a závislosti
Velikost S. Závisí na R11.

---

## TEL-ZRUŠIT — „Zrušit“ v telefonní liště pošle cancel-entry, ne Flatten

### (1) Verdikt: STAVĚT

**Dnešní chyba.** `LivePhonePositionBar` (`components/day/LivePhoneLiveActions.tsx:15–51`) má „Zrušit“ u čekajícího
vstupu i „Zavřít“ u pozice napojené na `trade.flatten()` (`components/day/LivePhoneChart.tsx:408`). To je Flatten celé
skupiny, který vypne kopírku.

**Druhá, skrytá vada.** Potvrzovací stav (`armedAt`, :26–27) nemá klíč akce. Když se vstup mezi dvěma klepnutími
vyplní, druhé klepnutí potvrdí jinou akci. Dnes jsou obě Flatten, po opravě by to byla záměna „zrušit“ za „zavřít“.
Je to stejné poučení jako `cancelConfirmKey` (INV-MANUAL-01, 2. 11.).

### (2) Chování na telefonu
- **Čekající vstup:** „ČEKÁ BUY 1 LMT … · Zrušit“ → dvě klepnutí → `cancel-entry`. Kopírka zůstává zapnutá.
  Hláška výsledku je stejná jako u × na čáře.
- **Když `cancel-entry` nejde** (vstup není spravovatelný, chybí capability nebo stav není čerstvý): text s důvodem
  a samostatné tlačítko „Flatten (vypne kopírku)“, také na dvě klepnutí.
- **Pozice se SL/TP:** „Zavřít“ = `close-position` (stejné jako ×), když `closeSupported`. Jinak Flatten s výslovným
  štítkem.
- **Holá pozice:** C8.

### (3) Mechanismus
1. **`LivePhonePositionBar`** dostane props `primary: 'cancel-entry' | 'close-position' | 'close-bare' | 'flatten'`
   a callbacky.
   - Potvrzení `armedFor: { key, at }`, kde klíč = akce + id vstupu.
   - Změna klíče mezi klepnutími potvrzení zruší.
2. **Společný běžec.** `run` se vytáhne z `components/day/LivePhoneOrderLines.tsx:84–110` do
   `useLivePhoneManageRunner(lineState, manage, say)`.
   - Lišta i čáry sdílí `busyRef`, takže platí jeden příkaz naráz.
   - `expect` = `summary.leader?.entry` (stejně jako čára, :134).
3. **Směrování** v `LivePhoneChart.tsx:404–409`.

- Worker, relay a admission: beze změny (`cancel-entry` existuje a brzda ho nezneplatní).
- Migrace: ne.

### (4) Dotčené invarianty
- **INV-UI-02**: Flatten a OFF zůstávají na Live Dashboardu (výjimka telefonu).
- **INV-MANUAL-01**: text telefonu.
- **INV-RELAY-03**: výjimka `cancel-entry`.
- **INV-UI-01**: odeslat jen nad čerstvým stavem.

### (5) Selhání a fail-closed
- **Vstup se vyplní mezi klepnutími:** klíč se změní a potvrzení se zruší.
- **Busy:** hláška.
- **Worker vrátí `entry-not-pending`:** hláška.
- **Neznámý výsledek:** „zkontroluj“, nic se neopakuje.

### (6) Záznam na DEMO
Není potřeba.

### (7) Testy
**`tests/livePhonePositionBar.test.ts`:**
- čekající vstup → `cancel-entry`, nikdy Flatten. **Mutace:** vrátit Flatten → test padá,
- potvrzení se zruší při změně klíče,
- busy je sdílený s čarami.

Dál `tests/livePhoneOrders.test.ts`.

### (8) Soubory
`components/day/LivePhoneLiveActions.tsx`, `components/day/LivePhoneChart.tsx`, `components/day/LivePhoneOrderLines.tsx`,
`lib/livePhoneOrders.ts`, `docs/COPIER_INVARIANTS.md`.

### (9) Velikost a závislosti
Velikost S. Bez závislostí. C8 a C9 lištu rozšíří.

---

## Doporučené pořadí stavby
1. TEL-ZRUŠIT a C1. Jsou nezávislé a C1 odstraňuje skutečné riziko.
2. C12 bez TIF, pak C7.
3. C8, pak C9.
4. Záznamy R1, R11, R12, R16 a R17 (spouští Filip). Pak C11, C17, část TIF z C12 a C16.

## Slabiny nalezené cestou (opraví návrh výše)
1. Revize čekajícího přikoupení nečeká na spojení. Zrušení podle zastaralé cache nebo během výpadku skončí falešným
   incidentem (C12, bod 3).
2. Restart s `cancel: sending` nechá čekající vstup tiše žít. Revize ho přeskočí (:3743) (C12, bod 5).
3. Pravidlo „17:00 CT − 5 min“ ruší v 16:55, tedy uprostřed pauzy CME. Zda broker zrušení přijme, je NEOVĚŘENO
   (C12, pravidlo 15:55 a R12d).
4. Výchozí TIF ochranných nohou je NEOVĚŘENÝ. Pozice držená přes 16:00 CT může přijít o nohy (R12c).
5. Potvrzení v telefonní liště nemá klíč akce (TEL-ZRUŠIT).
6. `mayResendLiquidation` hlídá jen `Market`. MIT nebo neznámý typ na symbolu se musí počítat taky (C1).


---

## Posudek copier-design-critic (návrh)

**Celkový verdikt: OPRAVIT PŘED COMMITEM**

- **P1** [C1] (INV-ARM-04, INV-BRAKE-02, INV-ARM-03 (terminální lifecycle cancel), INV-DIVERGENCE-01 (V2)) Návrh (bod 6 mechanismu) u druhů canceled/rejected nepodporovaného příkazu udělá jen processor.record a return. Event se tak nedostane do runneru a dispatchBroker nespustí terminalCancel kopie followera (services/copierRuntimeController.ts:1908-1914). terminalCancel přitom vyžaduje, aby event leadera canceled/rejected došel až k dispatchi. Scénář: ARMED, follower on-submit. Limit/Stop vstup leadera je zkopírovaný a vazba je durable. (1) Uživatel v Tradovate změní typ příkazu na MIT nebo TrailingStop (modifyorder s orderType). Přijde replaced→Unsupported, vznikne incident a kopírka se vypne. (2) Uživatel příkaz v Tradovate zruší. Event canceled typu Unsupported se spolkne a kopie vstupu u followera dál pracuje. Může se vyplnit a otevřít followerovi pozici, kterou leader nikdy neměl. V2 (cancelStrandedCopiedEntries) řeší jen leadera s plně vyplněným vstupem. Text incidentu „followeři ho nedostali“ je navíc nepravdivý, protože followeři drží starou kopii.
  - Oprava: Zachytávat jen submitted a replaced. Události canceled/rejected nezávisí na typu, a proto vždy pokračují běžnou cestou do runneru, kde funguje terminalCancel z durable vazby. Totéž platí aspoň pro každé orderId, které má links nebo outbox. U replaced→Unsupported na příkaz s vazbou má incident vyjmenovat kopie followerů. Cílené zrušení neochranné kopie vstupu (snižuje riziko, přesná lineage) je rozhodnutí pro Filipa. Test: replaced→Unsupported→canceled s vazbou followera vede právě k jednomu cancelOrder kopie, i za DISARMED.
- **P1** [C12] (INV-TRAD-02, INV-DIVERGENCE-01 (známý limit: kaskáda zrušení zbytku OSO neověřená), INV-MODE-02 (výsledek stavem), INV-DEFAULT-02) Automatické zrušení rozhoduje podle cache a výsledek po zrušení nijak neověřuje. (a) Vstup z flat o qty ≥ 2 (strop 1–5) se mezi kontrolou cache a zpracováním zrušení u brokera z části vyplní. Zrušení pak zruší zbytek, tedy přesně tu NEOVĚŘENOU kaskádu na nohy, kterou návrh v C16 sám odmítá. Může vzniknout pozice bez SL/TP a nikdo ji nezkontroluje. (b) cancelOrder adaptéru skončí úspěchem i u vyplněného příkazu: predikát obsahuje 'filled' a waitForOrder vrátí rovnou cache (services/tradovateBroker.ts:2178-2179, :973-974). Audit i karta pak napíšou „Čekající vstup zrušen“, přestože uživatel drží celou pozici. Za DISARMED tak odejde od trhu s mylnou představou, že je flat. (c) Nové pravidlo „pozice mimo appku“ (net≠0 ∧ entryFilled=0) se spustí i v okně, kdy Position předběhne Fill. Takové pořadí kód sám přiznává (:17063-17066). Odklad podle ingress ho nemusí zachytit, a tak se ruší vlastní vstup, který se právě plní.
  - Oprava: Po každém automatickém zrušení provést ohraničené autoritativní čtení: findOrderById vstupu a readLeaderSymbolState. Výsledek pravdivě klasifikovat: canceled s cumQty 0 = OK; filled nebo partial = pravdivý audit; net≠0 bez pracujících nohou = incident bez auto-close. Pravidlo „pozice mimo appku“ podmínit ustálením (bez ingress, stabilní ≥ 2 s) a čerstvým REST čtením vstupu, nebo z něj udělat jen incident bez zrušení. Dokud není ověřené dílčí zrušení: vstup z flat s qty > 1 rušit automaticky jen po čerstvém REST důkazu, že fill = 0. Testy: fill mezi cache a zrušením, zrušení vyplněného příkazu („úspěch“ adaptéru), Position před Fill.
- **P2** [C12] (INV-RISK-04, INV-RISK-02) Rezervu na denní pauzu CME nejde vzorcem z návrhu vynutit celou. Výpočet cmeHaltAt = now + msUntilTradovateSessionEnd(now,'America/Chicago',16) vrací po 16:00 CT až 16:00 dalšího dne (services/copierArmSession.ts:76-80). reserve() v náhledu (services/manualEntryPreview.ts:288-290) proto blokuje jen 15:55–16:00 a stávající pravidlo pro 17:00 jen 16:55–17:00. Nový Limit/Stop vstup v 16:00–16:55 CT projde a revize ho nezruší. Jestli ho broker v pauze přijme a zařadí, je NEOVĚŘENO (R12).
  - Oprava: Explicitní predikát „uvnitř [16:00 − 5 min, 17:00) CT“ v náhledu i v revizi, s oběma hranicemi přes sdílený helper (DST). Testy: 16:10 CT v den přechodu času v březnu i v listopadu. Svátky a zkrácené obchodní dny CME uvést jako NEOVĚŘENO.
- **P2** [C12] (INV-DEFAULT-01, INV-OUTBOX-02, INV-BRAKE-01 (nový text)) Restart workeru ve stavu `sending` u vstupu z flat (Limit/Stop, ještě bez id): incident dostane jen přikoupení, Market a attach (services/copierRuntimeController.ts:19504-19521). Vstup z flat tiše přejde do `unknown`. Revize ho bez id zrušit nemůže, ale u brokera může pracovat. Slib nového INV-BRAKE-01 („čekající vstup smí existovat jen pod živým ARM“) pro tento případ neplatí.
  - Oprava: Každý ne-Market záznam `sending` po restartu = trvalý incident (recordWhenDisarmed). Případně nejdřív read-only dohledání podle tagu a cílené zrušení jen s přesným id. Test: restart v sending u vstupu z flat.
- **P2** [C1] (INV-FRESH-01, INV-RECON-03, INV-BRAKE-01 (leader-flat guard), INV-TRAD-04) Za DISARMED ve skupině s followery zavolá každý replaced trailing příkazu invalidateReconciliation(), tedy safetyGeneration++ (:6890-6896), a processor.record s durable commitem. Pokud trailing posílá OrderVersion při každém posunu (NEOVĚŘENO, R1), generace se točí neustále. Důsledky: příprava ON se stále zneplatňuje, ruční akce končí `not-sent` a leader-flat guard má omezený počet přeplánování po změně generace (:5849-5868). Při souběžném zavírání jiné epochy může guard vyčerpat limit a skončit terminálním fail-closed. Kopie pak nezavře.
  - Oprava: Unsupported id označit jednou (Set). Další replaced téhož označeného id nemá dělat invalidateReconciliation ani durable commit, nanejvýš omezený záznam v paměti. ARM blokuje už samotný pracující příkaz (INV-ARM-01). V R1 změřit četnost OrderVersion.
- **P2** [C1] (INV-DEFAULT-02, INV-OUTBOX-03) Bracket strategie po fillu: vstup leadera se zkopíruje hned, ale SL noha přijde jako Unsupported a skončí v interceptu, takže páru SL+TP se nikdy nedočká. Kopírka se vypne s autoClose:false a follower drží pozici bez SL/TP, dokud leader-flat guard nezareaguje na flat leadera. Že guard za DISARMED spolehlivě běží, je podle dokumentu INV-BRAKE-01 pravděpodobné, ale tady NEOVĚŘENO. Když worker mezitím spadne, follower zůstane nechráněný. Návrh tento případ nepopisuje.
  - Oprava: V incidentu výslovně vyjmenovat followery bez ochranné nohy. Filip rozhodne, zda pro followera bez jakékoli ochrany použít přesně cílený auto-close (INV-DEFAULT-02 to explicitní politikou dovoluje), nebo jen incident. Test: kopie vstupu u followera a Unsupported SL leadera.
- **P2** [C9] (INV-ARM-04, INV-DEFAULT-01, INV-BRAKE-02) C9 povoluje raw modify i liquidate i v shadow režimu. INV-ARM-04 přitom doslova říká: „Nebezpečné je povolit write ‚jen do dema‘ uvnitř shadow větve“ a výjimku nesmí rozšířit na modify. C9 navíc posílá živé zápisy po restartu bez veřejné kontroly pozic (INV-DEFAULT-01) a přidává výjimku z kill switche. Precedent existuje (attach, cancel-entry), ale invarianty dnes takový zápis nepovolují. Dosah do skupin s followery, posun SL dál od trhu a posun TP návrh správně zakazuje.
  - Oprava: Shadow z C9 vyřadit: v sólo skupině nemá žádný účel. Druhá možnost je výslovná změna INV-ARM-04 s rozhodnutím Filipa. Do INV-DEFAULT-01 a INV-BRAKE-02 doplnit uzavřený seznam výjimek (attach, cancel-entry, C8, C9). Testy: shadow, kill a brzda mezi přípravou a zápisem (`not-sent`).
- **P2** [TEL-ZRUŠIT] (INV-UI-02, INV-MANUAL-01 (Flatten v telefonu nečeká na rozpracovaný vstup/attach)) Sdílený busyRef: běžec vrací při busy hned „Čeká se na výsledek…“ (components/day/LivePhoneOrderLines.tsx:87). Kdyby záložní tlačítko „Flatten (vypne kopírku)“ v liště šlo přes useLivePhoneManageRunner, rozpracovaný posun nebo zavření by Flatten zablokoval. Návrh to výslovně nevylučuje. Druhé klepnutí lišty navíc nemá spodní hranici ≥ 350 ms jako potvrzení čáry.
  - Oprava: Flatten zůstane mimo busyRef: vlastní cesta trade.flatten() se zámkem skupiny. Pro potvrzení zavést klíč akce + id a minimum 350 ms. Test: busy = true a Flatten přesto odejde.
- **P2** [C17] (INV-OUTBOX-02, INV-MANUAL-01, INV-TRAD-02) Zrušení čekajícího přikoupení nehlídá mutex pozice. Automatické zrušení (C12 přes cancelOwnManualEntry) ani ruční cancel-entry (cesta 2a, :5084 a dál) nekontrolují positionActionsInFlight (mutex je jen v preparePositionAction, :4815-4818). Během posunu všech nohou podle C17 se tak rodič přikoupení zruší a jeho Suspended nohy zmizí. Modify těchto nohou skončí rejected/canceled, classifyManagedOrderLookup je označí `unknown` „SL leadera už u brokera není“ (:4385-4391) a další správa pozice je zablokovaná (manage-unresolved). Výsledek je falešný poplach a zaseknutá pozice.
  - Oprava: Při běžící změně pozice automatické zrušení přikoupení odložit a ruční cancel-entry přikoupení odmítnout jako busy. Nohu přikoupení zrušenou spolu s rodičem s fill 0 klasifikovat jako `waived`. Test: zrušení přikoupení uprostřed posunu.
- **P2** [C16] (INV-PART-03 (duch), INV-UI-03, INV-MODE-02) Synchronní kontrola těsně před liquidate v executeClose (:4262-4273) neporovnává znovu množinu cizích příkazů s acknowledgedForeignOrderIds. Cizí příkaz přidaný mezi předčtením a zápisem tak liquidate zruší bez souhlasu uživatele. Návrh to přiznává jako vědomý závod, ale levnou kontrolu nad cache vynechává. U C8 tutéž kontrolu „nic nepracuje (cache)“ přidává.
  - Oprava: Těsně před zápisem ověřit nad liveOrdersByAccount, že množina otevřených cizích příkazů na symbolu = potvrzená množina, jinak `not-sent`. Test: cizí příkaz přidaný po přípravě.
- **P2** [TESTY] (Kontrolní seznam bod 25) Chybí deterministické testy chyby, závodu a opačného pořadí: (C1) replaced→Unsupported→canceled s vazbou followera; nativní OSO s Unsupported nohou při submit (ARMED, on-submit) bez kopie vstupu bez nohou; záplava replaced bez změn generace a commitů; recordAccountRejection s Unsupported. (C12) Position před Fill; zrušení vyplněného příkazu; dílčí fill mezi kontrolou a zrušením; 16:10 CT; restart v `sending` u vstupu z flat; skupina s followery, když se kopie vyplní mezi kontrolou a zrušením. (C9) shadow, kill, `manual-entry-unresolved` u zavření. (C17) zrušení přikoupení uprostřed posunu. (TEL) Flatten při busy. Testy jsem podle zadání nespouštěl; tvrzení návrhu o testech jsou NEOVĚŘENO.
  - Oprava: Doplnit do testových souborů jmenovaných v návrhu, každý s mutací (vrácení kódu musí test shodit).
- **P3** [C1] (INV-WORKER-01 (Supabase CAS validace)) recordAccountRejection ukládá orderType příkazu do durable accountEligibility[].lastExecution (services/copierRuntimeController.ts:1381-1395). Odmítnutý cizí MIT na účtu skupiny by tam uložil 'Unsupported' a supabaseCopierStore.validRejectedExecution (:175-176, :228) by odmítl celý snímek, pokud se zapojí VPS. Rámování návrhu „druhá pojistka: outbox Unsupported nikdy nenese“ proto nestačí: typ se do durable stavu dostane i mimo outbox.
  - Oprava: V lastExecution ukládat orderType jen ze známé čtveřice, surový typ dát do samostatného volitelného textového pole. Test: validace store s odmítnutým Unsupported.
- **P3** [C1] (INV-MANUAL-01 2d (co jsem viděl)) Návrh tvrdí, že při vlastní noze změněné na TrailingStop „zavření (liquidate) jde“. Jenže expect.price u zavření = cena SL (services/manualScaleIn.ts:391, 2a :5170) a stopPrice trailingu se mění s každým posunem. Zavření tak bude prakticky vždy `order-changed`.
  - Oprava: Buď do dokumentace napsat „jen Flatten“, nebo pro Unsupported nohu použít jiné „co jsem viděl“, například qty a id nohou. Test.
- **P3** [C12] (INV-DEFAULT-02, INV-DIVERGENCE-01) (a) Záznam s cancel.status 'sent', jehož vstup dál pracuje (zrušení „proběhlo“, ale nemělo účinek), revize navždy přeskočí (:3743). (b) Ve skupině s followery se kopie může vyplnit mezi kontrolou pozice followera a zrušením leadera. Pak zůstane jen audit a rozjetí v LIVE, žádný incident.
  - Oprava: Stav 'sent' u stále otevřeného vstupu = incident jednou. Po zrušení ve skupině s followery ohraničeně ověřit pozice followerů, při pozici incident.
- **P3** [C8] (INV-UI-03, INV-PART-03) expect.price = referencePrice holého záznamu je konstanta, takže zastaralé zobrazení nezachytí. Ochranu nese až worker: nejnovější záznam, closedAt == null, vstup v aktuální session, |net| = qty a nic nepracuje. Ta je dostatečná, ale v dokumentaci to tak nestojí.
  - Oprava: Do INV-MANUAL-01 zapsat, že u holého zavření „co jsem viděl“ = qty a že vlastnictví dokládají jen kontroly ve workeru.

### Verdikty po položkách

- 0 (společný základ): **OK** — Ověřeno v kódu: admission přijímá jen dva typy příkazů, výjimka z brzdy je jen cancel-entry a výjimka z denního stropu jen close-position (supabase/migrations/20261101090849_copier_manual_admission.sql:63-66, 128-137, 182). Brzda zneplatní move-stop, move-target a close-position (:326-335). Validátor správy přijímá jen klíče z KEYS a otisk počítá ze všech polí (lib/leaderOrderManage.ts:62, 88-122), takže starý worker nové pole odmítne. Migrace opravdu není potřeba. soloManualGroup odpovídá scaleInEnabled bez opt-inu (services/manualScaleIn.ts:19-26).
- C1: **OPRAVIT** — Diagnóza sedí: supportedOrderType vyhodí výjimku (services/tradovateBroker.ts:266-269). Volá ho composeOrder při sync baseline (:1607), v resync snímku (:1263), v handleProps (:1435-1507) a v listOrders (:2326), takže dnes vzniká smyčka reconnectů (:1957, :1985) a listOrders účtu s takovým příkazem selže. Hrozí to i Flattenu toho účtu. Oprava je naléhavá a čtecí strana je navržena dobře. P1: spolknuté canceled/rejected rozbíjí terminalCancel kopie followera. P2: změna generace u každé verze trailingu; follower bez SL u bracketu. P3: lastExecution ve store, zavření s trailing nohou. R1 až po nasazení je správně.
- C12: **OPRAVIT** — Zjištěné slabiny 1 a 2 návrhu jsem v kódu potvrdil: revize přikoupení nekontroluje spojení (:3719-3765) a záznam s jakýmkoli `cancel` se přeskočí (:3743). P1: chybí ověření stavu po zrušení; cancelOrder skončí úspěchem i u vyplněného příkazu; závod Position před Fill u pravidla „pozice mimo appku“; dílčí fill u qty > 1. P2: díra v pauze 16:00–16:55 CT a restart v `sending` u vstupu z flat bez incidentu. Zamítnutí GTC je ZAMÍTNUTÍ SPRÁVNÉ. TIF Day až po R12 je správně.
- C8: **OK S VÝHRADAMI** — Vzor prepareAttachBrackets (nejnovější záznam, closedAt, čerstvé REST čtení, nic nepracuje, kontrola streamu před zápisem) je správný. executeClose už dnes vyhlásí incident pro net≠0 bez pracujících příkazů (:4302-4307), takže trvající holá pozice skončí incidentem, jak návrh říká. U holé pozice se přeskočí closeReachBlockers: v sólo skupině nevadí, jen to zapsat. Za DISARMED až s C9. P3: expect je konstanta.
- C7: **OK** — Ruší se jen vlastní čekající vstupy s fill 0 přes existující cancel-entry; ochranné nohy ani cizí příkazy nikdy. Admission má busy klíč podle obchodu (v_trade, :76-82), takže N příkazů se navzájem neblokuje. Zrušení počítá do denního stropu správy (100), vadí jen teoreticky. Že `cancel-order` dnes vyhodí výjimku, jsem ověřil (server/localCopierExecutionAgent.ts:926-927). Odstranění nefunkčního tlačítka je správně.
- C9: **OK S VÝHRADAMI** — Omezení na sólo skupinu, zákaz posunu SL dál od trhu i TP a ponechání generace a fence před raw zápisem (:5297-5300) jsou správné. Zákaz pro skupiny s followery je ZAMÍTNUTÍ SPRÁVNÉ. Výhrady: vyřadit shadow (INV-ARM-04 ho výslovně zakazuje) a výslovně doplnit výjimky do INV-DEFAULT-01 a INV-BRAKE-02. U zavření ujasnit, zda blokuje i `manual-entry-unresolved` (dnes ano, :5101). Text návrhu („zavření tyto věci neblokují“) tomu odporuje.
- C17: **OK S VÝHRADAMI** — Stavět až po R17 je správně, modify Suspended nohou je NEOVĚŘENÝ. Pravidlo 8 ticků vůči ceně přikoupení i riziko včetně přikoupení jsou správně. P2: zrušení přikoupení (automatické z C12 i ruční cancel-entry) uprostřed posunu nehlídá mutex pozice a vede k falešnému `unknown`.
- C16: **OK S VÝHRADAMI** — Výslovné potvrzení cizích id, přesná shoda množiny a jen sólo skupina jsou v pořádku. Sjednocení SL míří na model.stopPrice, což je opravdu nejochrannější cena (services/manualScaleIn.ts:198-199). Odmítnutí zrušit zbytek z části vyplněného vstupu je ZAMÍTNUTÍ SPRÁVNÉ, stejná logika ale musí platit i pro C12 (viz P1). P2: přidat synchronní kontrolu množiny cizích příkazů před zápisem. Závisí na C1.
- C11: **OK S VÝHRADAMI** — Až po R11. Adaptér posílá price i stopPrice a predikát porovnává obě ceny (services/tradovateBroker.ts:2187-2204), takže potvrzení je už dnes přísné. Omezení odstupu na horší stranu a nejvýš 40 ticků je rozumné. Riziko z limitu je jen odhad, ztráta při nevyplnění limitu je neomezená; varování v UI nestačí jako ochrana, je to vědomé přijetí rizika a musí ho schválit Filip.
- TEL-ZRUŠIT: **OK S VÝHRADAMI** — Chybu jsem potvrdil: tlačítko Zrušit i Zavřít volá trade.flatten() (components/day/LivePhoneChart.tsx:408) a armedAt nemá klíč akce (components/day/LivePhoneLiveActions.tsx:26-27). Oprava je správná. P2: záložní Flatten musí zůstat mimo sdílený busyRef. Doplnit minimum 350 ms na druhé klepnutí.
- KONTROLNÍ SEZNAM (26): **viz poznámka** — 1 drží: arm() se nemění, pracující Unsupported blokuje ARM přes isOpenOrderStatus. 2 PORUŠENO u C12: automatické zrušení podle cache (Position před Fill, fill 0 v cache); C1 chybějící typ → Unsupported, nikdy Stop, drží. 3 drží: nikde veřejné reconcile ani mazání lastError. 4 netýká se. 5 PORUŠENO: C1 replaced→canceled, C12 zrušení vs fill, C17 zrušení přikoupení uprostřed posunu. 6 drží: C8/C9 fence a generace před zápisem (:4264-4273, :5297-5300); C12 zrušení bez fence je výslovná výjimka INV-FRESH-01. 7 drží: nikde opakování; restart s cancel sending → incident. 8 drží: persistManualOrderAction sending před zápisem; C12 durable cancel sending (:3672-3676). 9 PORUŠENO u C12: dílčí zrušení bez ověření stavu; C17 Suspended NEOVĚŘENO (R17). 10 drží: nikde dorovnání obchodem; C1 incident bez modify. 11 drží s výhradou: C8 vlastnictví z vlastního záznamu; C16 cizí příkazy jen s potvrzením, závod před zápisem. 12 drží: zavření se ověřuje stavem (:4318-4345), unknown → čtení. 13 drží: C12 ruší vstupy i v režimu jen správy, nohy nikdy. 14 netýká se (sólo); C12 ve skupině kontroluje pokrytí. 15 netýká se. 16 PORUŠENO u C12: helper s endHour 16 nekryje 16:00–16:55 CT; DST jinak drží. 17 výhrada: Flatten v liště telefonu mimo busyRef; brzdy beze změny. 18 drží: každá akce má vlastní operationId, admission beze změny. 19 drží: closeSupported jen z čerstvého stavu (INV-FRESH-03). 20 PORUŠENO u C12: vstup z flat v sending po restartu bez incidentu (:19504-19521); C8/C9 sending → unknown drží. 21 drží a zlepšuje: C1 odstraní pád celé route kvůli cizímu účtu (INV-TRAD-06). 22 beze změny: raw zápisy, INV-WORKER-02 zůstává otevřený. 23 zlepšení: C1 ruší smyčku reconnectů; výhrada k záplavě replaced eventů. 24 drží: R1 a R12 jen v obchodní době, žádná výjimka pro víkend. 25 částečně: chybí testy závodů (viz TESTY). 26 drží: návrh odlišuje záznam na DEMO, NEOVĚŘENO a nasazení; testy jsem podle zadání nespouštěl.
