# Skupina „pending“ — změny čekajících vstupů a varianty přikoupení (návrh v1, 3. 11. 2026)

Podklad: nasazený kód `~/alphatrade-worktrees/scale-in` (HEAD 7ae5c97b = origin/main, worker e37d7963 `--scale-in on`), seznam mezer `docs/reviews/trading-gaps-20261103.md`, `docs/COPIER_INVARIANTS.md`, `docs/reviews/scale-in-design-20261102.md` (v5) a `docs/CHART_ORDER_ENTRY_PLAN.md`. Jen čtení, nic se nezapisovalo, nic nespouštělo.

Rozsah fáze 1 je u všech položek stejný jako u přikoupení: **jen manual-only + local-only DEMO skupina bez followerů s `--scale-in on`** (`scaleInEnabled`, `services/manualScaleIn.ts:19-26`). Skupiny s followery (prop účty) mají dál `account-not-flat` / `scale-in-off`. Fáze 2 (followeři) se navrhuje zvlášť: kopírka zrcadlí posun rodiče OSO kaskádou (`services/copierOsoModifyCascade.ts`, DEMO 26. 8.), ale čekající nohy, žebřík a víc lístků u followerů nikdo nenahrál.

## 0. Přehled verdiktů

| ID | Položka | Verdikt | Velikost | Závisí na |
|---|---|---|---|---|
| C5a | Posun ceny čekajícího vstupu tažením (`move-entry`) | STAVĚT-PO-CONFORMANCE (R1, R2; u lístku v pozici nebo v žebříku i R3) | M | R1/R2; režim „SL/TP zůstanou“ potřebuje C5b |
| C5b | Posun SL/TP čekajícího vstupu před fillem (Suspended nohy), i jako posun celé pozice s čekajícími přikoupeními | STAVĚT-PO-CONFORMANCE (R3, R4) | M | R3/R4 |
| C5c | Změna qty čekajícího vstupu | JEN-ČÁST: snížit = zrušit lístky po 1 ks, zvýšit = další lístek (C5d/C18b); nativní modify `orderQty` rodiče OSO nestavět (R5 jen pro poznání) | S | C18a, C5d |
| C5d | Víc čekajících vstupů z flat: žebřík Limitů a další čekající vstup (stack) | STAVĚT-PO-CONFORMANCE (R6) | L | C18a, C18b |
| C5e | OCO breakout (buy stop nad + sell stop pod) | ZAMÍTNOUT (INV-OUTBOX-03, INV-MANUAL-01, INV-DIVERGENCE-01 / INV-DEFAULT-02) | S (jen průzkum) | — |
| C18a | Limit/Stop přikoupení > 1 ks | JEN-ČÁST → STAVĚT-PO-CONFORMANCE: rozdělit na N lístků po 1 ks v jednom příkazu (dílčí fill tím odpadá); jedno OSO s qty > 1 dál blokované | M | R6 |
| C18b | Víc čekajících přikoupení naráz | STAVĚT-PO-CONFORMANCE (R6) | M | C18a |
| C18c | Přikoupení s jiným SL/TP (vlastní noha jen pro přikoupenou část) | STAVĚT-PO-CONFORMANCE (R7) | L | R7; s C5b lépe |
| C18d | Přikoupení do pozice otevřené v Tradovate | JEN-ČÁST: jen po výslovném „Převzít pozici“ u holé pozice z Tradovate; pozice s nohami z Tradovate = ZAMÍTNOUT | M | jiná skupina: „Přidat SL/TP k pozici z Tradovate“ |
| C18e | Holé přikoupení z telefonní lišty | JEN-ČÁST: lišta v pozici pošle Market přikoupení **se SL/TP pozice** (jen UI); opravdu holé přikoupení = ZAMÍTNOUT | S | — (C18b jen kvůli souběhu s čekajícím) |

## 1. Co víme o Tradovate a co se musí nahrát na DEMO

### 1.1 Co už je doložené
- **K1 — posun ceny rodiče OSO posune nohy relativně.** Doloženo forenzicky na followerech (PROJECT_LOG 26. 8., „absolutní SL/TP po změně nativního OSO parentu“): po změně ceny parentu skončily SL i TP všech followerů o Δ výš. Kopírka proto u followerů po potvrzeném posunu parentu znovu nastaví absolutní SL a TP (`services/copierOsoModifyCascade.ts:60-66`). DEMO 26. 8. to potvrdilo (12 modify na 4 followerech). **Na leaderovi s naším tvarem `placeoso` to NAHRANÉ NENÍ** (TP noha bez `parentId`, jen `ocoId`, fixture `tradovate-leader-oso-api-cancel.json`). Chybí i pořadí eventů, časy a odpověď na otázku, jestli `modifyOrder` adaptéru potvrdí rodiče predikátem `waitForOrder` (`services/tradovateBroker.ts:2198-2204`: Replaced tohoto commandu + otevřený příkaz v odeslaném tvaru).
- **K2 — Suspended = `pending`.** Mapování: `services/tradovateMapping.ts:280-297`. `pending` je pro risk, cancel i Flatten aktivní (`isOpenOrderStatus`, `services/brokerPort.ts:29-30`). Zdroj eventů hlásí změnu ceny nebo typu `pending` nohy jako `replaced`, změnu qty ne (`services/copierLeaderEventSource.ts:103-110`). **Posun Suspended nohy naživo NEOVĚŘEN** (PROJECT_LOG ř. 3576: „Neověřeno naživo: … posun suspended nohy“).
- **K3 — dílčí fill OSO s qty > 1.** Broker přechodně mění qty nohou (11 → 6 → 11, incident 27. 8.), proto qty nohou není uživatelský replace (INV-TRAD-02). Co se stane s nohami po zrušení zbytku vstupu, neověřeno (INV-DIVERGENCE-01, známé limity). Dílčí fill nejde na DEMO deterministicky vyvolat.
- **K4 — víc nezávislých OSO na jedné pozici.** Nahráno ve fázi 0/0b přikoupení (`tests/fixtures/tradovate-leader-scale-in.json`): dvě až čtyři nezávislé OCO, souběžný modify 4× SL a 4× TP (`stream-replaced` za 152–176 ms). `liquidateposition` zruší všechny příkazy kontraktu včetně čekajícího přikoupení. Nahrané bylo jen JEDNO čekající přikoupení najednou a NIKDY výstup jednoho lístku vlastní nohou, zatímco ostatní lístky drží.
- **K5 — Stop přes trh.** Modify SL (Stop noha) přes trh = `InvalidPrice`, noha se nezmění (30. 10.). Pro **vstupní** Stop to nahrané není.

### 1.2 Plán záznamu (nový skript podle vzoru `scripts/copier/record-scale-in.ts` + `recordScaleInPlan.ts`)
`scripts/copier/record-pending-modify.ts` + čistý plán `scripts/copier/recordPendingModifyPlan.ts` (pojistky jako `recordScaleInProblems`):
- běží jen proti DEMO8661118, `environment === 'demo'`, manual-only + local-only skupina bez followerů, za **DISARMED**, jen MNQ front (MNQZ6), `--confirm`;
- vzdálené Limity ≥ 1,5 % od trhu, úklid = zrušit vše vlastní a ověřit flat bez příkazů (stream + REST);
- záznam mimo repo (`recordings/leader-pending-modify-*.json`), anonymizovaná fixture `tests/fixtures/tradovate-leader-pending-modify.json`;
- po záznamu read-only kontrola pozic (ne veřejné `reconcile()` z pozadí, INV-RECON-02).

| Scénář | Co udělat | Co zaznamenat a jaké je kritérium přijetí | Pro |
|---|---|---|---|
| **R1** `move-entry-limit` | Buy Limit 1 @ trh − 1,5 % se SL −20 b / TP +40 b. Modify `price` rodiče −4 b, pak +8 b, pak zrušit. | ACK modify; Replaced (exec report) rodiče; Order update OBOU nohou (cena + Δ? nová `sourceVersion`?) a jejich stav (zůstává Suspended?); časy rodič → nohy; jestli `modifyOrder` vrátil `stream-replaced`. **Přijato** = obě nohy posunuté přesně o Δ, stav `pending`, žádný fill. | C5a |
| **R2** `move-entry-stop` (s IBKR) | Buy Stop 1 @ trh + 1,5 %. Modify `stopPrice` ±4 b. Pak modify pod ask (přes trh). Pak zrušit. | Relativní posun nohou jako R1. Přes trh: odmítnutí (`InvalidPrice`) bez změny, nebo spuštění → zapsat; úklid případně `liquidateposition`. | C5a |
| **R3** `move-suspended-legs` | Buy Limit 1 daleko. Modify SL (Suspended) −4 b, TP +4 b, pak oba souběžně. Modify SL čekajícího **Buy Stop** vstupu na cenu mezi trh a vstup (Sell Stop nad trhem, dokud je Suspended). Pak zrušit rodiče. | Broker modify přijme nebo odmítne; Replaced report nohy; noha zůstane `pending`; `modifyOrder` potvrdí (predikát přijímá `pending`); zrušení rodiče zruší nohy s novou cenou. **Přijato** = přijaté, potvrzené adaptérem nebo `findOrderById`, stav beze změny. | C5b, C5a „SL/TP zůstanou“ |
| **R4** `suspended-legs-then-fill` | Buy Limit 1 na bid se SL/TP, hned (< 300 ms) modify SL a TP, čekat na fill ≤ 180 s, pak `liquidateposition`. Bez fillu = neprůkazné, zopakovat. | Po fillu jsou nohy `Working` s **upravenou** cenou a qty 1. Stojí cca spread + poplatky. | C5b |
| **R5** `parent-qty` (jen poznání) | Buy Limit 2 daleko. Modify `orderQty` 3, pak 1, pak zrušit. | Jdou qty nohou s rodičem? (Bez toho se nativní změna qty nestaví.) | C5c |
| **R6** `multi-pending` | a) Tři Buy Limit 1 OSO daleko pod trhem na různých cenách, stejné SL/TP; zrušit prostřední; zrušit zbytek. b) Základ Market 1 + dvě čekající přikoupení Limit 1 daleko; `liquidateposition`. c) **Souběžné** tři `placeoso` (jedním tikem). | Všechny páry Suspended, nezávislé; zrušení jednoho zruší jen jeho nohy; liquidate zruší oba čekající i jejich nohy; souběžné POSTy: ACK, pořadí eventů, žádný 429. | C18a, C18b, C5d |
| **R7** `per-ticket-exit` | Základ Market 1 (SL −20 b, TP +40 b). Přikoupení Market 1 s vlastním SL −20 b a TP = ask + 2 ticky (vyplní se během sekund). Pak liquidate. | TP přikoupení vyplněn, jeho SL zrušen (OCO); nohy základu **beze změny** (qty 1, ceny); pozice 1. Stojí 2 filly + poplatky. | C18c |

R1, R3, R5 a R6a/c se nevyplní, stojí jen čas. R2, R4, R6b a R7 se vyplní (DEMO). Spouští Claude nebo Filip podle souhlasu pro DEMO (fáze 0 přikoupení: „na demu je to čistě tvé“). Kopírka u toho musí být DISARMED a po záznamu se udělá read-only kontrola.

## 2. Admission „jeden čekající vstup“ a `account-not-flat`

- **Relay neomezuje počet čekajících příkazů u brokera.** Atomická admission (`supabase/migrations/20261101090849_copier_manual_admission.sql:139-151`) hlídá jen jeden **rozpracovaný příkaz** `place-leader-entry` na uživatele (pending/claimed) a 3 s rozestup. Žebřík a dávka lístků proto jdou jako **jeden příkaz** (jeden řádek relaye, jeden `operationId`) a migrace admission není potřeba. Další příčka později je další příkaz (≥ 3 s).
- **Druhý čekající vstup dnes blokuje worker.** Leader s otevřeným příkazem = `account-not-flat` (`services/manualEntryPreview.ts:372-374`), k tomu `working-orders` z poslední kontroly (`services/copierRuntimeController.ts:19904`) a brána klidu (`maintenanceRestartBlocker`). Návrh: stejný vzor jako přikoupení (`manualEntryPreview.ts:300-308`, `copierRuntimeController.ts:19903-19909`). Vlastní čistá brána nahradí `account-not-flat` jen pro leadera a jen pro **vlastní lístky** stejné strany. Cizí příkaz, jiný symbol, followeři a skupiny s followery zůstávají beze změny.
- **Brzda.** Supersede v RPC `enqueue_tradovate_copier_brake` má pevný výčet akcí `('move-stop','move-target','close-position')` (migrace ř. 326-335) a záložní cesta v TS má stejný výčet (`server/tradovateCopierCommandRelay.ts:975-983`). Nová akce `move-entry` (C5a) proto potřebuje **minimální migraci** (výčet → negativní: vše kromě `cancel-entry` a `attach-brackets`). Odmítnutí brzdou do 500 ms (migrace ř. 128-137) a agentova `brake-after-request` (`server/localCopierExecutionAgent.ts:969-975`) `move-entry` pokrývají už dnes.

## 3. Společný základ: lístky po 1 kontraktu, dávka v jednom příkazu (C18a, C18b, C5c, C5d)

**Proč.** Dílčí fill OSO s qty > 1 (K3) je jediná neověřená a na DEMO nevyvolatelná sémantika. Lístek s qty 1 se dílčím fillem vyplnit nemůže. Každý lístek je samostatné atomické OSO (INV-OUTBOX-03 platí pro každý zvlášť), model více lístků už existuje a je nahraný (K4). Pozice z N lístků po 1 ks se spravuje cestou, kterou nasazené přikoupení už má (`scope: 'position'`). Poplatky se nemění (účtují se za kontrakt). Rozdělení platí jen v manual-only skupině: u followerů by kopie každého lístku byla `floor(1 × násobek)`, s násobkem < 1 tedy 0.

**Protokol** (`lib/leaderEntryPreview.ts`, sdílí náhled, odeslání, relay i worker):
- nový klíč `rungs?: Array<{ price: number }>` v `COMMAND_KEYS` (ř. 109). Platí jen pro `Limit`/`Stop`, `rungs.length === quantity`, každá cena na tick, cena příkazu `price` = první příčka;
- každá příčka je jeden lístek qty 1;
- `position.mode` rozšířit na `'add' | 'stack'` (`POSITION_KEYS` ř. 110, validace ř. 140-148). `stack` = flat leader s vlastními čekajícími lístky, `quantity` smí být 0 a `ticketEntryIds` jsou čekající lístky, které uživatel viděl;
- capability `manual-entry-tickets-v1` (dávka) a `manual-entry-stack-v1` (žebřík z flat), inzerované jen při `scaleInOn()`.

**Worker — `executeManualEntry` (`services/copierRuntimeController.ts:3851-4119`) dostane dávkovou větev `executeTicketBatch`:**
1. Dedup: existuje záznam s `batchId === operationId` → souhrnný výsledek (nikdy znovu).
2. Pojistka rozestupu 3 s (ř. 3876-3879) proběhne **jednou na příkaz**. Lístky téže dávky se do rozestupu nepočítají.
3. Brány náhledu, brána přikoupení / stacku (§C18b, §C5d) a strop celé pozice **pro všech N najednou**.
4. **Jeden durable zápis všech N záznamů `sending`** (`persistManualEntry` rozšířit na `persistManualEntries`). Id lístku `${operationId}-t${k}` (vzor `entry:[a-zA-Z0-9_-]` z `lib/leaderOrderManage.ts:61` zůstane platný, takže `cancel-entry` jednoho lístku projde validací), `batchId`, u žebříku `ladderId`.
5. Jedna synchronní kontrola těsně před zápisem: deadline, fence fronty, `gate.armed`, generation, druhé kolo brány z paměti. Pak **N× `placeOso` souběžně bez čekání mezi nimi**, stejně jako `runPositionMove` (ř. 4987-5016). Sekvenčně to nejde: ACK lístku 1 zvedne `tradeObservationVersionByAccount` (ř. 4053) a jeho eventy čítače příchodu (ř. 19656-19666), takže fence druhého lístku by vždy selhala.
6. Jeden společný timeout `MANUAL_ENTRY_POST_TIMEOUT_MS` (5 s) pro celou dávku. Vzdálená brzda tak dál čeká nejvýš ~7 s (INV-BRAKE-03).
7. Výsledek po lístcích stávajícím mapováním (ř. 4041-4044) a registrace id z ACK (ř. 4036-4040, 4057-4076). `abandoned` → cílené zrušení toho vstupu + incident (beze změny). **Jakýkoli `unknown` = `failClosed`** (rozšíření ř. 4001-4005 na `ladderId`). DISARM pak čekající lístky zruší hlídáním (`reviewPendingScaleIns`).
8. `LeaderEntryPlaceResult` dostane volitelné `tickets: Array<{ operationId; status; entryBrokerOrderId? }>`. Souhrnný `status` = `acknowledged`, když prošel aspoň jeden lístek a žádný není `unknown`/`abandoned`, a `reason` řekne „přijato k z N“. Starý UI vidí jen `acknowledged` + text.
9. Restart: `sending` → `unknown` (ř. 19504-19513). Trvalý incident `restartedScaleIn` rozšířit i na `ladderId`.

**Model** (`services/manualScaleIn.ts`):
- `ScaleInRecord` + `ladderId?`, `batchId?`;
- `pendingAdds` (ř. 192) → `pendingTickets` = lístky s `entry === 'open'` a (`scaleIn` nebo `ladderId`);
- výjimka `scale-in-entry-open` (ř. 272-274) platí pro všechny `pendingTickets`;
- `unconfirmedLegs` (ř. 201) nepočítá Suspended nohy nevyplněných čekajících lístků. Ty ale musí být potvrzené streamem (ne `manual-entry-ack`) — samostatný příznak `pendingLegsUnconfirmed`;
- riziko `scaleInPositionLossPoints` (ř. 311-320, dnes čekající lístky přeskakuje, ř. 315) → `scaleInWorstCaseLossPoints`: čekající lístek = (cena vstupu − SL) × zbývající qty, u Stopu + skluz `MANUAL_ENTRY_MARKET_SLIPPAGE_TICKS`.

---

## C5a — Posun ceny čekajícího vstupu tažením (`move-entry`)

**1) Verdikt:** STAVĚT-PO-CONFORMANCE. R1 a R2 musí doložit relativní posun nohů na leaderovi s naším tvarem OSO a potvrzení adaptérem. Režim „SL/TP zůstanou“ (nutný pro lístek v pozici nebo žebříku) potřebuje i R3 (modify Suspended nohy).

**2) Chování.**
- **PC:** čára čekajícího vstupu (dnes `draggable: false`, `lib/liveChartOrderLines.ts:88`) jde táhnout. Mrtvá zóna 4 px, `expect` = cena při chycení, po puštění okamžitě příkaz, štítek „odesílám“. SL/TP čáry se při tahu posouvají s ní (režim **„s vstupem“** = stejně jako Tradovate/TradingView). Modifikátor nebo přepínač v panelu nabídne „SL/TP zůstanou“. × (zrušit) zůstává.
- **Telefon:** čáru vybrat klepnutím, pak táhnout (`selectToDrag`, `components/day/LivePhoneOrderLines.tsx:117`). Stejné režimy, × dvoukrokově jako dnes.
- **Čekající přikoupení a příčka žebříku:** vždy „SL/TP zůstanou“ (= SL/TP pozice nebo žebříku), text to řekne.
- **Výsledek:** „Vstup posunut na X · SL/TP jely s ním“ / „… zůstaly“ / „neověřeno — kontroluji u brokera“.

**3) Mechanismus.**
- **Příkaz** `manage-leader-order` s `action: 'move-entry'`:
  - `entryOperationId` = vlastní lístek (sledované obchody 2b ne);
  - `expect: { price: aktuální cena vstupu, quantity: qty lístku }`, `newPrice`;
  - nové volitelné `brackets: 'follow' | 'keep'` (výchozí `follow`; lístek se `scaleIn`/`ladderId` vyžaduje `keep`).
  - `lib/leaderOrderManage.ts`: `LeaderOrderManageAction` (ř. 16), `ACTIONS` a `KEYS` (ř. 62-63), `newPrice` povinné i pro `move-entry` (ř. 102-103), `brackets` jen u `move-entry`, `scope` u `move-entry` zakázané.
- **Worker — ve frontě:** nová `prepareMoveEntry(command, deadlineAt, queuedFence)` v `services/copierRuntimeController.ts`, volaná z `prepareManualOrderAction` vedle attach/position (ř. 5082-5083).
  - Dedup, deadline a fence jako dnes (ř. 5067-5081).
  - Mutex: `manualOrderActionJobs`/`positionActionsInFlight` (ř. 4817); nevyřešená změna lístku i pozice blokuje.
  - `resolveManagedTrade` (ř. 4552-4583), záznam `acknowledged`, ne `bare`, `orderType` Limit|Stop.
  - Tvrdé brány přes novou čistou `pendingTicketHardBlockers` (vytaženou z `pendingAddViolation`, `services/manualScaleIn.ts:328-364`, plus stavové brány náhledu `copierRuntimeController.ts:19895-19912`): ARMED ∧ ¬shadow ∧ ¬kill, ¬managementOnly, denní zámek i čekající zámek, pauza, cooldown, okno + rezerva 5 min, konec session, vypršení ARM, leader způsobilý, reconciliation, divergence, stuck outbox, incident, `pendingTradeIngressByAccount(leader) = 0`.
  - Předčtení: snímek streamu jen když sedí s `liveOrdersByAccount` (`streamSnapshotMatchesLive`, ř. 4486-4501), jinak REST ohraničený 3 s.
  - Tvar: vstup `working`/`pending`, `filledQuantity === 0`, qty a cena = `expect`. Obě nohy přítomné, `pending` (Suspended), qty = qty vstupu, potvrzené streamem. Na symbolu žádný cizí příkaz kromě vlastních lístků.
  - Cena: tick, Δ ≠ 0. Limit: s čerstvou kotací IBKR (`options.manualEntryQuote`, ≤ 3 s, stejný kontrakt) nesmí být marketable (Buy < ask, jinak `move-entry-marketable`); bez kotace projde jako dnešní Limit. Stop: vyžaduje čerstvou kotaci IBKR a správnou stranu trhu (Buy Stop > ask), jinak blocked (INV-UI-04, nikdy TV).
  - Nohy po posunu: `follow` → SL′ = SL + Δ, TP′ = TP + Δ. `keep` → SL a TP beze změny a musí platit SL < new < TP (long), min. 4 ticky.
  - Riziko: `follow` drží vzdálenost → bez přepočtu (tighten-only jako utažení). `keep` posun dál od SL → přepočet jako náhled (`manualStopLossUsd` + stávající pozice + ostatní čekající lístky, `realizedLossHeadroom`, čerstvý risk snímek novější než `lastLeaderFillObservedAt`).
  - Durable před zápisem (`persistManualOrderActions`, ř. 4149-4160): `follow` = jeden záznam `move-entry` (`targetBrokerOrderId` = vstup, `fromPrice`/`toPrice`/`quantity`/`symbol`) `sending`. `keep` = `${op}-s1` rodič `sending`, `-s2` SL a `-s3` TP ve **novém stavu `planned`** (`CopierManualOrderActionRecord.status`, `services/copierEngine.ts:398`; restart `planned` → `not-sent`, ř. 19494-19501).
- **Worker — mimo frontu** (vzor `runPositionMove`, ř. 4972-5059):
  - synchronně deadline, fence, generation, ARMED, route epoch při stream předčtení a tvar z cache;
  - pak `dispatchBroker(generation).modifyOrder(leader, entryId, { quantity, orderType, limitPrice | stopPrice: newPrice })`.
  - Potvrzení rodiče jen `stream-replaced` se stejným id, qty a novou cenou. Pak ověření nohou: ≤ 2 s v rozpočtu čekat na řádky streamu obou nohou s novou verzí.
  - `follow`: ceny = předpověď → `acknowledged`. Jinak, ale tvar platný (SL < new < TP) → `acknowledged` + „nohy se neposunuly, zkontroluj SL/TP“ + audit. Tvar neplatný → `cancelOwnManualEntry` (ř. 3649-3709, risk-redukční, i za DISARMED) + `failClosed({ autoClose: false })`. Nedoběhlo do 2 s → `unknown` + `scheduleManualOrderActionLookup`.
  - `keep`: krok `-s2`/`-s3` (`planned` → durable `sending` → modify Suspended nohy zpět na původní cenu, qty z cache) jen když je noha stále `pending` a stojí na posunuté ceně. První nejasnost zastaví zbytek (`not-sent`). Precedens kaskády 26. 8.
  - Definitivní odmítnutí → `rejected`. `CopierDispatchRevokedError` → `not-sent`. Timeout → `unknown` + lookup. Žádný retry.
- **Dořešení:** `classifyManagedOrderLookup` (ř. 4373-4399) a `resolveManualOrderActionFromStream` (ř. 4530-4545) dostanou větev `move-entry`:
  - cena vstupu (`limitPrice`/`stopPrice`) = `toPrice` → `acknowledged`;
  - `filled` → `waived` „vstup se mezitím vyplnil“;
  - `canceled` → `waived`;
  - po `settle` = `fromPrice` → `rejected`.
- **Záznam vstupu:** po potvrzení `persistManualEntry` doplní nové pole `currentPrice` (`request.price` zůstává původní). Riziko posunu SL dál bere nejhorší ze záměru, ceny u brokera a fillu beze změny (ř. 5244-5246).
- **Relay:** validace sdílenou lib na enqueue i claim. Admission beze změny: busy je per `entryOperationId` lístku, rozestup 2 s, strop 100/24 h (`server/tradovateCopierCommandRelay.ts:125-128`). Záložní supersede: přidat `'move-entry'` (ř. 975). **Migrace ANO, minimální:** `create or replace function public.enqueue_tradovate_copier_brake(...)`, ve které se mění jen podmínka akcí na `(payload->'command'->>'action') not in ('cancel-entry','attach-brackets')` (beze změny pro dnešní akce, každá budoucí risk-měnící akce se supersede automaticky). Bez ní by čekající `move-entry` po brzdě odmítl až agent, ale INV-RELAY-03 bod 1 by přestal platit.
- **Capability** `manual-order-move-entry-v1` (`server/localCopierExecutionAgent.ts:405-415`, jen při `scaleInOn()`).
- **UI:**
  - `lib/liveChartOrderLines.ts`: čára vstupu `draggable` při `!position && manageable && moveEntry`, pending čáry SL/TP se při tahu posouvají v režimu `follow`;
  - `components/LiveTradingScreen.tsx:442-472`: nový `onLineDrag` pro `entry` → `runLiveManage('move-entry', …)`;
  - `components/TradovateLiveDesk.tsx:1094-1135`: `manageLeaderEntry` rozšířit o `move-entry` a `brackets`, pro lístek přikoupení a žebříku `entryOperationId` toho lístku;
  - `components/day/LivePhoneOrderLines.tsx`: totéž.

**4) Dotčené INV.**
- **INV-MANUAL-01:** jen vlastní lístek, jen přes relay, worker vše přepočte. Doplnit text „změna čekajícího vstupu“ (§4.1).
- **INV-UI-01:** `expect` = co uživatel viděl. Tah ani čára nic neautorizují, worker porovná se snímkem nebo REST.
- **INV-UI-04:** marketability jen z kotace IBKR ve workeru, TV nikdy.
- **INV-OUTBOX-01/02:** durable `sending`/`planned` před zápisem. Restart → `unknown`/`not-sent`. `unknown` blokuje další změnu lístku i pozice. Žádný retry.
- **INV-OUTBOX-03:** OSO zůstává celé (rodič i obě nohy existují v každém mezistavu). `keep` je plánovaná kaskáda rodič → SL → TP, nedokončená kaskáda nechá nohy relativně posunuté a pořád platné. Nic se nedostavuje mimo plán. Návrh textu §4.4.
- **INV-FRESH-01:** fence, generation a route epoch těsně před každým zápisem kaskády.
- **INV-RELAY-01/03:** idempotence `operationId`. Supersede brzdou (migrace), 500 ms okno v admission.
- **INV-BRAKE-02/03:** `move-entry` není risk-redukční, pod kill/DISARM neprojde. Neblokuje FIFO brzd (zápis mimo frontu, ohraničený).
- **INV-TRAD-02:** qty nohou se posílá ze streamu, venue qty se nepřepisuje.
- **INV-TRAD-03:** žádný retry.
- **INV-RISK-01/02:** přepočet u `keep`, vstupní brány dne a okna jako u nového vstupu.
- **INV-MODE-01:** management-only blokuje.
- **INV-WORKER-02:** mutex jen v procesu (vědomě).

**5) Selhání a fail-closed.**
- **Restart během zápisu:** `sending` → `unknown` (lookup po startu), `planned` → `not-sent`. `unknown` blokuje další změnu lístku/pozice a automatické pokračování (`evaluateTransportResume` už `unknown` odmítá).
- **Částečný úspěch** (rodič ano, nohy jinak než předpověď): platný tvar → přiznat v `reason`; neplatný → cílené zrušení vstupu + incident bez auto-close. `keep`: rodič ano, SL krok selže → TP `not-sent`, nohy zůstanou posunuté o Δ (pořád ochrana).
- **Fill během posunu:** broker modify odmítne nebo dá „not confirmed“ → lookup `filled` → `waived`. Lístek je dál běžná pozice.
- **Zastaralý stream:** snímek `null` nebo nesedí → REST 3 s. Změna route epochy mezi předčtením a zápisem → `not-sent`.
- **DISARM/kill během operace:** před zápisem synchronní ARMED/generation → `not-sent`. Po zápisu výsledek platí (leader se posunul). U čekajícího přikoupení/žebříku pak hlídání zruší lístek (DISARM). Relay supersede + agent `brake-after-request`.
- **Marketable posun bez kotace IBKR (Limit):** vyplní se jako marketable Limit (stejně jako dnešní place). Riziko na ceně Limitu je konzervativní.

**6) DEMO:** R1, R2. Pro `keep` i R3.

**7) Testy.**
- `tests/manualPendingModify.test.ts` (čisté): předpověď nohou `follow`/`keep`, strana trhu s IBKR i bez, Stop bez kotace = blocked, `keep` přepočet rizika.
- `tests/manualPendingModifyReplay.test.ts` (replay fixture R1/R2 přes controller s mock brokerem):
  - posun → `acknowledged` bez incidentu;
  - venue neposune nohy a tvar neplatný → přesně jedno zrušení + incident (**mutace**: vypnout kontrolu tvaru → test padá);
  - fill mezi předčtením a zápisem → `waived`;
  - restart v `sending`/`planned` → `unknown`/`not-sent`, nic se znovu neodešle (**mutace**);
  - DISARM mezi frontou a zápisem → `not-sent`;
  - změna route epochy → `not-sent`;
  - `keep` kaskáda: selhání SL kroku → TP se nepošle (**mutace**).
- `tests/leaderOrderManage.test.ts`: validace `move-entry`/`brackets`.
- `tests/sql/copierManualAdmission.pg.mjs`: brzda supersede `move-entry`, nesupersede `cancel-entry`/`attach-brackets` (**mutace** výčtu).
- `tests/liveChartOrderLines.test.ts` a `tests/livePhoneOrderLinesBehavior.test.ts`: táhnutelný vstup jen s capability, `expect` = cena při chycení.

**8) Soubory:** `lib/leaderOrderManage.ts`, `services/copierRuntimeController.ts`, `services/copierEngine.ts` (stav `planned`, `currentPrice`), `services/manualScaleIn.ts` (`pendingTicketHardBlockers`), `server/tradovateCopierCommandRelay.ts`, `server/localCopierExecutionAgent.ts`, `lib/localCopierAgentProtocol.ts` (capability), nová migrace `supabase/migrations/2026110x_copier_brake_supersede_manage.sql`, `lib/liveChartOrderLines.ts`, `components/LiveTradingScreen.tsx`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneOrderLines.tsx`, `scripts/copier/record-pending-modify.ts` + plán, testy výše, `docs/COPIER_INVARIANTS.md`.

**9) Velikost M.** Závisí na R1/R2. Režim `keep` na C5b (R3).

---

## C5b — Posun SL/TP čekajícího vstupu před fillem (Suspended nohy)

**1) Verdikt:** STAVĚT-PO-CONFORMANCE (R3: modify Suspended nohy; R4: noha po fillu nese novou cenu).

**2) Chování.**
- **PC i telefon:** SL/TP čáry čekajícího vstupu (dnes štítek „čeká na vstup“, netáhnou se, protože `canMove` vyžaduje pozici — `lib/liveChartOrderLines.ts:73`, `liveLineMoveBlockReason` ř. 42) jdou táhnout. SL jen pod vstup (long) ≥ 4 ticky, TP nad vstup ≥ 4 ticky. Žádná 8tická pojistka od trhu: Suspended noha se nespustí.
- **Pozice s čekajícím přikoupením nebo žebříkem:** tah SL/TP celé pozice posune i Suspended nohy čekajících lístků. Tím odpadá dnešní blok „Posun SL/TP během čekajícího přikoupení“ (`services/manualScaleIn.ts:392`).

**3) Mechanismus.**
- **Příkaz beze změny tvaru:** `move-stop`/`move-target` s `entryOperationId` čekajícího samostatného lístku. Pro pozici nebo žebřík `scope: 'position'`.
- **Worker:** `prepareManualOrderAction` dnes pro posun vyžaduje vyplněný vstup (`services/copierRuntimeController.ts:5181-5186`). Nová větev `preparePendingLegMove`, když je vstup otevřený a `filledQuantity === 0`:
  - nohy `pending` potvrzené streamem, qty = vstup;
  - SL na ochranné straně ceny vstupu s rezervou 4 ticky (Stop vstup: od `stopPrice`), TP na ziskové straně;
  - riziko SL dál od vstupu jako náhled (`manualStopLossUsd` + čekající lístky žebříku), TP bez rizika;
  - brány: ARMED ∧ ¬shadow ∧ ¬kill (shodně s `move-*`);
  - durable `sending`, zápis mimo frontu přes `dispatchBroker`, qty ze streamu;
  - výsledek: adaptér `stream-replaced` (predikát přijímá `pending`), jinak lookup `findOrderById`. `classifyManagedOrderLookup` už stav `pending` bere jako otevřený, `filled` noha = `waived`.
- **Pozice:** `preparePositionAction` (ř. 4804-5060) + `positionManageBlockers` (`manualScaleIn.ts:370-402`):
  - čekající lístky povolit (ř. 392-393), jejich Suspended nohy přidat do `legs`;
  - pro ně platí pravidlo „SL ≥ 4 ticky pod cenou čekajícího vstupu“ místo IBKR 8 ticků;
  - pokrytí počítat jen z vyplněných lístků (Suspended nohy nejsou potvrzená ochrana, INV-TRAD-02);
  - riziko přes `scaleInWorstCaseLossPoints` (§3);
  - všechny nohy durable `sending` jedním zápisem a souběžný modify — beze změny vzoru.
- **Žebřík na flat** (net 0, jen čekající lístky): `scope: 'position'` povolit i při net 0, když jsou všechny lístky čekající se společnými SL/TP. Nová větev v `positionManageBlockers`. Klíč `positionManageKey` = nejstarší lístek, jako dnes.
- **Capability** `manual-order-pending-legs-v1`. Migrace NE (`move-stop`/`move-target` jsou už ve výčtu supersede).
- **UI:** `lib/liveChartOrderLines.ts:101-116` → `draggable` i pro čekající, nový text blokace v `liveLineMoveBlockReason` pro čekající; `components/TradovateLiveDesk.tsx:1079-1088` → `source: 'position'` i při čekajícím přikoupení / žebříku bez dnešního zákazu.

**4) Dotčené INV.**
- **INV-TRAD-02:** Suspended noha je aktivní riziko, ale ne potvrzená ochrana. Qty se nepřepisuje (posílá se venue qty ze streamu). Návrh doplnit text §4.5.
- **INV-MANUAL-01:** fáze 2a zakazovala posun před fillem, nově jen po R3/R4.
- **INV-OUTBOX-01/02:** durable, `unknown` dořeší jen čtení.
- **INV-RISK-01:** přepočet SL dál od vstupu i s čekajícími lístky.
- **INV-UI-01/04:** čáry nic neautorizují, žádná TV cena.
- **INV-BRAKE-02:** posun není redukce, pod kill neprojde.
- **INV-FRESH-01.**
- **INV-OUTBOX-03:** každá noha zvlášť, souběžně, výsledek po nohách.

**5) Selhání a fail-closed.**
- **Broker Suspended modify odmítne** → `rejected`, nic se nezměnilo (R3 rozhodne, jestli vůbec stavět).
- **Přijme bez Replaced reportu** → `unknown` + `findOrderById`.
- **Fill vstupu během posunu:** noha přejde do `Working`, modify buď doběhne (cena platí), nebo se dořeší lookupem. Utažení k trhu u právě vyplněné pozice může broker odmítnout (`InvalidPrice`) → `rejected`.
- **Restart** → `unknown`.
- **Částečně posunuté nohy pozice** (jedna odmítnutá) → souhrn „potvrzeno x z y“, nohy rozjeté, další posun blokuje `legs-diverged` (P2-6), zavřít jde. Nadkrytí hlídá `overCoverStep`.
- **DISARM** → `not-sent` před zápisem. Čekající přikoupení pak zruší hlídání.

**6) DEMO:** R3 (včetně SL čekajícího Buy Stop nad trhem) a R4.

**7) Testy.**
- `tests/manualScaleIn.test.ts`: `positionManageBlockers` s čekajícími lístky; pokrytí bez Suspended nohou (**mutace**: počítat Suspended do krytí → test padá).
- `tests/manualPendingModifyReplay.test.ts` (fixture R3/R4): posun SL čekajícího Limitu → `acknowledged`; posun SL dál → přepočet rizika (**mutace**); fill během posunu → `waived`/`acknowledged`; posun celé pozice s čekajícím přikoupením posune 2× working + 1× Suspended souběžně.
- `tests/liveChartOrderLines.test.ts`: pending čáry táhnutelné jen s capability a ve správném pásmu.

**8) Soubory:** `services/copierRuntimeController.ts`, `services/manualScaleIn.ts`, `lib/liveChartOrderLines.ts`, `components/LiveTradingScreen.tsx`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneOrderLines.tsx`, `lib/localCopierAgentProtocol.ts`, `server/localCopierExecutionAgent.ts`, skript R3/R4, testy, INV doc.

**9) Velikost M.** Závisí na R3/R4. Rozšíření „celá pozice s čekajícími“ těží z C18b/C5d.

---

## C5c — Změna qty čekajícího vstupu

**1) Verdikt:** JEN-ČÁST.
- STAVĚT: snížení = zrušit vybrané lístky po 1 ks (`cancel-entry` lístku, existuje). Zvýšení = přidat lístek stejné ceny (stack, C5d/C18b).
- NESTAVĚT: nativní `modifyorder` s `orderQty` na rodiči OSO. R5 jen nahrát pro poznání. Bez důkazu, že nohy jdou s qty rodiče, by vstup s qty 3 a nohami 2 po fillu nechal 1 kontrakt bez ochrany a opačně by noha otočila pozici (INV-TRAD-02, INV-OUTBOX-03).

**2) Chování.** U čekajícího žebříku nebo dávky ukáže panel na PC i list na telefonu „3 × 1 @ X“ s −/+. „−“ = dvoukrokové × posledního lístku. „+“ = další lístek se stejnou cenou a SL/TP (příkaz `stack`, rozestup relaye 3 s). Starý jednoduchý vstup s qty > 1 (vznikl jako jedno OSO) má −/+ zašedlé: „zruš a zadej znovu“.

**3) Mechanismus.**
- Jen UI: `lib/liveOrderTicket.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneChart.tsx`.
- Desk: `cancel-entry` s `entryOperationId` = `${op}-tK` a qty 1. Validace projde, protože id lístku drží vzor `entry:[a-zA-Z0-9_-]`. Worker cancel cesta: `services/copierRuntimeController.ts:5140-5152`.
- „+“ = `place-leader-entry` s `position.mode: 'stack'` (C5d) nebo `'add'` (C18b).
- Worker beze změny nad rámec C5d/C18b. Migrace NE.

**4) Dotčené INV:** INV-MANUAL-01 (zrušení je risk-redukční, smí i za DISARMED), INV-RELAY-03 (výjimka `cancel-entry`), INV-RISK-01 („+“ = celé brány a strop), INV-TRAD-02 (nativní změna qty zamítnuta).

**5) Selhání a fail-closed:** zrušení lístku selže → stav jako dnes (`cancel-failed` audit, u přikoupení incident). „+“ zablokované → nic neodešlo. Souběh „−“ a fill lístku → `entry-not-pending` (blocked).

**6) DEMO:** R5 (jen poznání, nic na něm nestavět). Pro tuto část nic dalšího (zrušení lístku nahrané, R6).

**7) Testy:** `tests/liveScaleIn.test.ts` / `tests/livePhoneOrders.test.ts`: „−“ posílá `cancel-entry` právě jednoho lístku s qty 1; „+“ posílá `stack` s aktuálními `ticketEntryIds`; legacy qty > 1 má −/+ vypnuté.

**8) Soubory:** `lib/liveOrderTicket.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneChart.tsx`, `components/TradovateLiveDesk.tsx`, testy.

**9) Velikost S.** Závisí na C18a a C5d.

---

## C5d — Víc čekajících vstupů z flat: žebřík Limitů a další čekající vstup (stack)

**1) Verdikt:** STAVĚT-PO-CONFORMANCE (R6: víc čekajících OSO, zrušení jednoho, souběžné `placeoso`, liquidate s čekajícími).

**2) Chování.**
- **PC panel:** režim „Žebřík“ = počet příček, krok v bodech nebo ticích, jedna strana, společné SL a TP. Náhled ukáže nejhorší ztrátu, kdyby se vyplnilo vše. Odeslat = jeden příkaz.
- **V grafu:** každá příčka vlastní čára „BUY 1 LMT · příčka k/N“ s × (zrušit jen ji) a tahem (C5a, `keep`). Jedna SL a jedna TP čára pro celý žebřík (tah = C5b `scope: 'position'`).
- **Telefon:** v listu „Žebřík“ s počtem a krokem (jen kontrakty a ceny).
- **Po první příčce:** pozice + čekající příčky = čekající přikoupení. Při zavření pozice (TP/SL/×/Flatten) se zbylé příčky samy zruší. Při DISARM, kill, denním zámku, konci okna nebo session se zruší i před prvním fillem (rozhodnutí F1).
- **Stack:** další čekající vstup stejné strany se stejnými SL/TP k už čekajícím (tlačítko „+ příčka“ nebo kliknutí do grafu na stejné straně).

**3) Mechanismus.**
- **Protokol:** `rungs` (§3). `position: { mode: 'stack', side, quantity: 0, ticketEntryIds }` pro přidání k existujícím čekajícím. První žebřík z čistého flat jde bez `position`, ale s `rungs`.
- **Brána z flat s `rungs`:** stávající brány náhledu (flat leader bez příkazů). `manual-cap` = Σ příček ≤ `manualEntryContractCap`. Riziko = Σ (cena příčky − SL) × 1 + skluz a poplatky proti rezervě (`remainingLossHeadroom`).
- **Brána `stack`:** nová čistá `stackAddBlockers` v `services/manualScaleIn.ts` (vzor `scaleInAddBlockers`, ř. 239-295):
  - `scaleInOn()`;
  - net ověřený a **přesně 0**;
  - všechny otevřené příkazy na symbolu = vlastní čekající lístky (vstupy `open` bez fillu, nohy `pending` potvrzené streamem) téže strany a téhož `ladderId`;
  - jejich SL a TP jednotné a = SL/TP příkazu;
  - záměr = čerstvý stav (`ticketEntryIds`);
  - žádný jiný symbol, deník bez lotu, žádná nedokončená epocha, neběží správa;
  - strop Σ čekajících + nové;
  - riziko nejhoršího případu (vše vyplněno).
  - V `previewLeaderEntry` (`services/copierRuntimeController.ts:19903-19909`) se pro `stack` vynechá `working-orders` a brána klidu se zúží jako u přikoupení (`readOnlyRecoveryBlocker`). `evaluateManualEntryPreview` (`services/manualEntryPreview.ts:300-308`) bere `stack` jako `add`: nahradí `account-not-flat` leadera, cap drží brána.
- **Zápis:** dávka (§3). Záznamy `ladderId` = `operationId` prvního žebříku (stack ho převezme z lístků v záměru).
- **Životní cyklus** v `reviewPendingScaleIns` (ř. 3719-3765) rozšířený na záznamy s `ladderId`:
  - **před startem** (žádná příčka nemá fill): `pendingAddViolation` bez pravidel pozice (`net === 0` neruší). Ruší jen tvrdé podmínky (vypnutí, kill, zámek, pauza, management-only, okno, session, ARM, nezpůsobilý leader) — F1;
  - **start** = první fill příčky: durable `baseEpisodeId` = epizoda lotu s jejím `entryOrderIds` (pro všechny sourozence, `persistManualEntry`);
  - **po startu:** celé `pendingAddViolation`, včetně flat, opačné pozice a `episodeMismatch` (ř. 3732-3740) → cílené zrušení zbylých příček (výjimka INV-BRAKE-02, jeden pokus, selhání = incident).
- **Model:** `ScaleInTicket` u žebříku před startem netvoří pozici (`net 0`). `leaderPositions` ve statusu (ř. 21116-21148) se rozšíří o `pendingTickets[]` a o „žebřík na flat“ (symbol, strana, příčky s cenou, SL/TP, `canStack`, `canManage`). Jen zobrazení.
- **Relay:** bez migrace (jeden příkaz). Capability `manual-entry-stack-v1`.
- **Followeři / běžné skupiny:** `rungs` a `stack` blokované (`ladder-manual-only`).

**4) Dotčené INV.**
- **INV-MANUAL-01:** nová podkapitola „víc čekajících lístků“ (§4.1).
- **INV-RISK-01/02:** strop na nejhorší celou pozici, riziko při fillu všech, rezerva bez otevřeného P&L.
- **INV-OUTBOX-01/02:** jeden durable zápis všech lístků před POSTy, `unknown` lístku = incident.
- **INV-OUTBOX-03:** každý lístek atomické OSO, dávka není atomická a výsledek se přizná po lístcích.
- **INV-BRAKE-02:** rozšířit třetí výjimku na příčky žebříku (§4.2).
- **INV-BRAKE-03:** dávka v jednom 5s rozpočtu.
- **INV-FRESH-01:** jedna synchronní kontrola těsně před souběžnými POSTy.
- **INV-ARM-01:** čekající příčky blokují ARM, protože ARM chce flat bez příkazů. Beze změny, F1 to v praxi uvolní.
- **INV-RECON-04:** automatické pokračování s čekajícím příkazem bez pozice odmítne. Beze změny, při výpadku DISARM příčky zruší.
- **INV-DEFAULT-02:** `unknown` lístku = `failClosed` (vědomá odchylka 1b neplatí, stejně jako u přikoupení).
- **INV-DIVERGENCE-01:** fill příčky v nové epizodě = incident bez obchodu.
- **INV-UI-01:** status `pendingTickets` je jen zobrazení.

**5) Selhání a fail-closed.**
- **Restart v `sending`** → všechny `unknown` → trvalý incident (rozšířený `restartedScaleIn`). Zbylé `acknowledged` příčky ruší DISARM.
- **Částečná dávka** (2 přijaté, 1 odmítnutá) → `acknowledged` + „přijato 2 z 3“, bez incidentu. 1 `unknown` → incident.
- **TP vyplněný a příčka vyplněná ve stejném okamžiku** → zrušení po startu nestihne → `episodeMismatch` incident bez auto-close (nohy příčky chrání novou pozici).
- **Zrušení příčky selže** (výpadek spojení) → incident (dnešní chování přikoupení, viz otevřená otázka O2).
- **Zastaralý stream:** brána `stack` z paměti; `net === null` → blocked.
- **Kill během dávky:** synchronní kontrola → `not-sent` pro všechny. ACK za DISARMED → cílené zrušení (ř. 4089-4093).

**6) DEMO:** R6 (a, b, c).

**7) Testy.**
- `tests/manualScaleIn.test.ts`: `stackAddBlockers` (cizí příkaz, jiný `ladderId`, nejednotné SL, strop, riziko při vyplnění všeho).
- `tests/manualLadderReplay.test.ts` (fixture R6):
  - žebřík 3 příček → 3 záznamy, jeden durable zápis před POSTy (**mutace**: zápis po POSTu → test padá);
  - fill příčky 1, pak TP pozice → zbylé příčky zrušeny (**mutace**: vypnout pravidlo „po startu net 0 ruší“);
  - před startem net 0 nic neruší (**mutace**);
  - DISARM ruší i před startem (F1);
  - jeden `unknown` → incident;
  - restart v `sending` → incident a nic znovu;
  - souběžné ACK s eventy ve frontě → žádné `oso-lone-leg`/ambiguous.
- `tests/manualEntryPlace.test.ts`: rozestup 3 s jednou na příkaz.
- `tests/liveScaleIn.test.ts`: panel žebříku a čáry příček.

**8) Soubory:** `lib/leaderEntryPreview.ts`, `lib/leaderEntryPlace.ts` (result `tickets`), `services/manualScaleIn.ts`, `services/manualEntryPreview.ts`, `services/copierRuntimeController.ts`, `services/copierEngine.ts` (`ladderId`, `batchId`), `server/localCopierExecutionAgent.ts`, `lib/localCopierAgentProtocol.ts`, `lib/liveOrderTicket.ts`, `components/LiveOrderTicket.tsx`, `lib/liveChartOrderLines.ts`, `components/LiveTradingScreen.tsx`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneChart.tsx`, `lib/livePhoneOrders.ts`, testy, INV doc.

**9) Velikost L.** Závisí na C18a (dávka), C18b (víc čekajících v modelu) a R6.

---

## C5e — OCO breakout (buy stop nad + sell stop pod)

**1) Verdikt: ZAMÍTNOUT** (dnes).
- Tradovate `placeoso` nemá vnořené OCO dvou rodičů (náš tvar: `bracket1`/`bracket2` jen jako nohy, `services/tradovateMapping.ts:217-232`).
- Varianta A: dvě nezávislá OSO, druhé zruší worker po fillu prvního. V rychlém trhu se vyplní obě dřív, než worker zruší. Výsledek je flat nebo otočená pozice se 4 pracujícími nohami, z nichž každá otevře nechráněnou pozici. Náprava by byla obchod. **Porušuje INV-OUTBOX-03** (atomicitu nese venue, worker emulace OCO je neatomický celek), **INV-DIVERGENCE-01 / INV-DEFAULT-02** (nápravu nelze udělat obchodem, fail-closed by nechal sirotčí nohy) a **INV-MANUAL-01** („vlastní OSO se nikdy… bez nohou“ a samo musí zůstat chráněné).
- Varianta B: nativní `placeoco` dvou holých Stopů + automatické doplnění SL/TP po fillu. Pozice je bez ochrany přesně v nejrychlejším okamžiku (breakout), doplnění nohou ≥ 8 ticků od trhu může selhat. Holý vstup smí být jen výslovný Market z lišty (INV-MANUAL-01, holý Market).

**2) Chování:** v panelu ne. Text v nápovědě: „OCO breakout zatím ne — zadej jeden směr, druhý po zrušení.“

**3) Mechanismus:** nic. Průzkum (read-only, bez zápisu): zjistit z dokumentace Tradovate, jestli `orderStrategy/startOrderStrategy` (multibracket) umí OCO dvou vstupů každý s vlastním bracketem. Pokud ano, vznikne nový návrh se záznamem na DEMO (podmínka: venue-side atomicita i nohou).

**4) INV:** INV-OUTBOX-03, INV-MANUAL-01, INV-DIVERGENCE-01, INV-DEFAULT-02.

**5) Selhání:** nic se nestaví.

**6) DEMO:** jen pokud průzkum najde nativní cestu.

**7) Testy:** `tests/leaderEntryPreview.test.ts`: `rungs` s opačnou stranou nebo smíšené Buy/Sell neprojdou validací (žebřík je jednostranný).

**8) Soubory:** žádné (validace v C5d).

**9) Velikost S** (průzkum). Bez závislostí.

---

## C18a — Limit/Stop přikoupení > 1 kontrakt

**1) Verdikt:** JEN-ČÁST → STAVĚT-PO-CONFORMANCE.
- Stavět: přikoupení N Limit/Stop jako **N lístků po 1 ks v jednom příkazu** (dávka §3, `rungs` se stejnou cenou nebo s krokem).
- Nestavět: jedno OSO qty > 1 (`scale-in-limit-qty`, `services/manualScaleIn.ts:261`). Dílčí fill (K3) na DEMO nejde vyvolat a model by musel věřit venue qty nohou.
- Conformance R6 (souběžné `placeoso`, víc čekajících).

**2) Chování.** PC panel a list telefonu: přikoupení Limit/Stop 3 ks = „3 × 1 @ X“ (volitelný krok mezi příčkami), SL/TP pozice zamčené. Výsledek „přijato 3 z 3“. V grafu tři čáry „PŘIKOUPENÍ … · čeká“, každá s ×. Dílčí „vyplnění“ = vyplněné lístky.

**3) Mechanismus.**
- Dávka (§3).
- Brána přikoupení (`scaleInAddBlockers`): `scale-in-limit-qty` → povinné `rungs.length === quantity` pro Limit/Stop qty > 1. Market dál jedno OSO qty N (nahráno 0b).
- Strop (ř. 290-293) už počítá `pendingSame`.
- Riziko přes `scaleInWorstCaseLossPoints` (každá příčka za svou cenu).
- `executeManualEntry` druhá synchronní pojistka (`services/copierRuntimeController.ts:3947-3954`) pro celou dávku.
- `reviewPendingScaleIns` už iteruje záznamy (každý lístek má `scaleIn: true`).
- `restartedScaleIn` (ř. 19507) beze změny pokryje dávku.
- UI: `lib/livePhoneOrders.ts:62` a PC `lib/liveScaleIn.ts` místo blokace rozdělí na `rungs`.
- Capability `manual-entry-tickets-v1`. Migrace NE.

**4) Dotčené INV:** INV-MANUAL-01 (přikoupení: „Limit/Stop jen po 1 kontraktu“ nahradit „Limit/Stop jako lístky po 1 kontraktu“), INV-RISK-01, INV-OUTBOX-01/02/03, INV-BRAKE-02/03, INV-FRESH-01, INV-TRAD-02 (dílčí fill vyloučen konstrukcí), INV-TRAD-03/04 (N POSTů; 429 → jistič, `unknown` → incident).

**5) Selhání a fail-closed.** Jako §3 a C5d.
- **Čekající přikoupení a ochrana:** venue mohou mít až N čekajících lístků. `pendingAddViolation` každý ruší zvlášť (jeden pokus, selhání = incident).
- **Nadkrytí** se Suspended nohou netýká (`coverCap` = fill vstupu, ř. 167).
- **Liquidate** zruší všechny čekající (K4, R6b).

**6) DEMO:** R6.

**7) Testy.**
- `tests/manualScaleIn.test.ts`: `rungs` povinné u Limit qty > 1 (**mutace**: pustit qty > 1 bez rungs).
- `tests/manualScaleInReplay.test.ts`: přikoupení 3 × 1 Limit → 3 lístky, strop celé pozice, riziko všech; DISARM zruší všechny 3; liquidate pozice zruší všechny.
- `tests/livePhoneOrders.test.ts` / `tests/liveScaleIn.test.ts`: rozdělení v UI.

**8) Soubory:** `lib/leaderEntryPreview.ts`, `services/manualScaleIn.ts`, `services/copierRuntimeController.ts`, `services/copierEngine.ts`, `lib/leaderEntryPlace.ts`, `lib/liveScaleIn.ts`, `lib/livePhoneOrders.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneChart.tsx`, testy, INV doc.

**9) Velikost M.** Závisí na R6. Je základem C18b, C5c a C5d.

---

## C18b — Víc čekajících přikoupení naráz

**1) Verdikt:** STAVĚT-PO-CONFORMANCE (R6).

**2) Chování.** Druhé (a další) čekající přikoupení jde i když první ještě čeká (dnes „Předchozí přikoupení ještě čeká“, `services/manualScaleIn.ts:271`, `lib/livePhoneOrders.ts:57`). Strop i riziko počítají se všemi čekajícími. V grafu každé vlastní čára s ×. S C5b jde posun SL/TP celé pozice včetně čekajících, jinak je během čekání blokovaný jako dnes.

**3) Mechanismus.**
- `scaleInAddBlockers`: odstranit `scale-in-pending`. Přidat `scale-in-pending-brackets`: každý čekající lístek má Suspended nohy potvrzené streamem na SL/TP pozice. Výjimku `scale-in-entry-open` rozšířit na `pendingTickets`.
- Riziko: `scaleInWorstCaseLossPoints`.
- Status `leaderPositions.pendingAdd` (jeden) → `pendingTickets[]`. `pendingAdd` nechat (první) kvůli starým klientům.
- Desk (`components/TradovateLiveDesk.tsx:1108-1121`): `cancel-entry` podle vybrané čáry (id lístku na čáře `${LIVE_PENDING_ADD_LINE_ID}:${operationId}`).
- `lib/liveChartOrderLines.ts:117-127` → čára pro každý lístek.
- Capability `manual-entry-multi-pending-v1`. Migrace NE.

**4) Dotčené INV:** INV-MANUAL-01 (přikoupení: „žádné čekající přikoupení“ v bráně odpadá), INV-RISK-01 (nejhorší případ všech čekajících), INV-BRAKE-02 (výjimka zrušení platí pro každý), INV-UI-01 (čáry jen zobrazení), INV-OUTBOX-02.

**5) Selhání a fail-closed.**
- Dvě přikoupení vyplněná souběžně → model se srovná ze streamu. Brána dalšího přikoupení čeká na uklidnění (`pendingTradeIngressByAccount`, epocha `lastLeaderNet`).
- Zrušení jednoho selže → incident.
- Pozice zavřená, jedno čekající nezrušené včas → `episodeMismatch` incident.
- Restart → `unknown` → incident.

**6) DEMO:** R6b.

**7) Testy.**
- `tests/manualScaleIn.test.ts`: brána bez `scale-in-pending`, ale s `scale-in-pending-brackets` (**mutace**: Suspended noha s jiným SL projde → test padá).
- `tests/manualScaleInReplay.test.ts`: dvě čekající, fill jedné, zrušení druhé při TP pozice.
- `tests/liveScaleIn.test.ts`: dvě čáry a × posílá správné id.

**8) Soubory:** `services/manualScaleIn.ts`, `services/copierRuntimeController.ts`, `lib/liveChartOrderLines.ts`, `lib/liveScaleIn.ts`, `lib/livePhoneOrders.ts`, `components/TradovateLiveDesk.tsx`, `components/LiveTradingScreen.tsx`, testy.

**9) Velikost M.** Závisí na C18a.

---

## C18c — Přikoupení s jiným SL/TP (vlastní nohy jen pro přikoupenou část)

**1) Verdikt:** STAVĚT-PO-CONFORMANCE (R7).
- Broker strana: nezávislé OCO na lístek nahrané (K4).
- Nenahrané: výstup jednoho lístku jeho nohou, zatímco nohy ostatních zůstanou (že Tradovate nohy jiných OSO při zmenšení pozice nepřepočítá ani nezruší). Na tom celé „vlastní SL/TP lístku“ stojí.

**2) Chování.**
- **Přikoupení:** v panelu a listu se SL/TP odemknou (přepínač „SL/TP jen pro přikoupení“). Štítek „vlastní SL/TP“.
- **Graf:** pozice se nejednotnými SL/TP kreslí čáry po lístcích („SL #2 · 1 ks“). Tah čáry posune nohu **jen toho lístku** (`scope: 'ticket'`). BE po lístcích (na VWAP lístku). × u pozice = zavřít celou (liquidate).
- **Jednotné SL/TP** se dál táhnou jako celá pozice. Sjednocení rozjetých nohou je samostatná výslovná akce „Sjednotit SL“ (žádné tiché sjednocení, P2-6).

**3) Mechanismus.**
- **Brána přikoupení** (`services/manualScaleIn.ts:281-284`): `scale-in-legs-diverged` a `scale-in-brackets-mismatch` se při `brackets: 'own'` nahradí kontrolou per lístek:
  - SL/TP přikoupení na správné straně jeho vstupu (náhled);
  - Market ≥ 16 ticků (`manualEntryMarketQuoteBlockers`).
  - Pokrytí: dál Σ potvrzených SL = |net| a Σ TP = |net| (každý lístek kryje sám sebe).
- **Riziko:** `scaleInPositionLossPoints` per lístek s vlastním SL (`Σ max(0, směr·(VWAP_i − SL_i)) × qty_i`).
- **Nová kontrola podkrytí:** `positionUnderCovered` (Σ zbytků SL nebo TP < |net| ustálené 5 s, mimo rozpracované eventy a správu) → incident bez auto-close, jen za ARMED; za DISARMED upozornění. Vzor `overCoverStep` (ř. 427-439) v `reviewScaleInCoverage` (`services/copierRuntimeController.ts:3769-3794`). Podkrytí je hlavní riziko výstupu po lístcích, dnes se nehlídá.
- **Správa lístku:** `manage-leader-order` `scope: 'ticket'` (`lib/leaderOrderManage.ts:42`, 108-109: `scope` ∈ {`position`, `ticket`}; `ticket` jen `move-stop`/`move-target`), `entryOperationId` = lístek. Ve workeru `prepareManualOrderAction` (ř. 5088-5090: `position-multi`) pustí `scope: 'ticket'` na pozici s víc lístky. Tvar platí jen pro lístek: vstup plně vyplněný, jeho nohy working bez fillu, qty = fill lístku, nic cizího na symbolu, žádný čekající lístek.
  - Utažení: IBKR 8 ticků (ř. 5216-5224).
  - SL dál: riziko celé pozice s novým SL lístku.
  - TP k trhu blokovaný.
- **Celá pozice** (`positionManageBlockers`): při nejednotných nohách dál blokovaná (`legs-diverged`, ř. 398). Nová akce `unify-stop` (`move-stop`, `scope: 'position'`, příznak `unify: true`) jen jako výslovné tlačítko.
- **Status `leaderPositions`:** `tickets[]` s cenami nohou (jen zobrazení).
- **Capability** `manual-entry-ticket-brackets-v1`. Migrace NE (akce `move-*` jsou ve výčtu supersede).

**4) Dotčené INV.**
- **INV-MANUAL-01:** přikoupení „SL/TP přikoupení = SL/TP pozice“ se mění na volbu; text §4.1.
- **INV-OUTBOX-03:** každý lístek atomický, nic se nedostavuje.
- **INV-RISK-01:** riziko per lístek.
- **INV-DEFAULT-02:** podkrytí = incident bez auto-close.
- **INV-TRAD-02.**
- **INV-UI-01..04:** čáry po lístcích jsou jen záměr, worker vše ověří.
- **INV-MODE-01.**
- **INV-FRESH-01.**

**5) Selhání a fail-closed.**
- **Venue sníží nebo zruší nohy jiného lístku** při výstupu (R7 to vyvrátí nebo potvrdí) → podkrytí → incident, žádný obchod.
- **Ruční změna nohy v Tradovate** → nejednotnost nebo nadkrytí → blokace, případně incident.
- **Restart** → `unknown`.
- **Posun nohy lístku odmítnut** → `rejected`.
- **Fill nohy během posunu** → `waived`.

**6) DEMO:** R7 (TP přikoupení vyplněný, nohy základu beze změny). Volitelně obdoba se SL přikoupení blíž (stop vyplněný).

**7) Testy.**
- `tests/manualScaleIn.test.ts`: brána `own` brackets; riziko per lístek; `positionUnderCovered` (**mutace**: vypnout → replay s vyplněným TP jednoho lístku a zrušenými nohami druhého nevyhlásí incident).
- `tests/manualScaleInReplay.test.ts` (fixture R7): výstup jednoho lístku, model bez něj, správa druhého; `scope: 'ticket'` na víc lístcích projde jen s capability; starý tvar = `position-multi`.
- `tests/liveChartOrderLines.test.ts`: čáry po lístcích.

**8) Soubory:** `services/manualScaleIn.ts`, `services/copierRuntimeController.ts`, `lib/leaderOrderManage.ts`, `lib/leaderEntryPreview.ts` (`position.brackets: 'own'`), `services/manualEntryPreview.ts`, `lib/liveChartOrderLines.ts`, `lib/liveScaleIn.ts`, `components/LiveTradingScreen.tsx`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneOrderLines.tsx`, `components/LiveOrderTicket.tsx`, `lib/livePhoneOrders.ts`, testy, INV doc.

**9) Velikost L.** Závisí na R7. S C5b lépe (posun Suspended nohy přikoupení s vlastními SL/TP).

---

## C18d — Přikoupení do pozice otevřené v Tradovate

**1) Verdikt:** JEN-ČÁST.
- **Pozice z Tradovate s vlastními nohami (bracket z Tradovate/TV) = ZAMÍTNOUT.** Přijmout cizí nohy jako lístek jen podle shody účtu, symbolu, qty a ceny je rozšíření vlastnictví ze shody tvaru (kontrolní seznam INV, otázka 10). INV-MANUAL-01 (holý Market) to výslovně zakazuje: „starý záznam nesmí adoptovat cizí pozici“. V manual-only DEMO navíc kopírka obchody z Tradovate nesleduje (mezera „Správa obchodů zadaných v Tradovate v ručním DEMO“).
- **Holá pozice z Tradovate** (žádný příkaz na symbolu) = STAVĚT až po položce jiné skupiny „Přidat SL/TP k pozici z Tradovate“. Výslovná akce „Převzít pozici“ = OCO SL/TP na celou |net|, které vytvoří převzatý lístek. Teprve pak jde běžné přikoupení (dnes nasazené).

**2) Chování.** Holá pozice z Tradovate: v grafu „Převzít pozici do appky (doplnit SL/TP)“. Po úspěchu se pozice chová jako lístek z appky (posun, BE, ×, přikoupení). Pozice s nohami z Tradovate: „Pozice má SL/TP z Tradovate — přikupuj v Tradovate (nebo nohy zruš a převezmi)“.

**3) Mechanismus.**
- Generalizovat `prepareAttachBrackets` (`services/copierRuntimeController.ts:4595`) na `attach-brackets` s `target: 'adopt'`:
  - leader má pozici, na symbolu nic nepracuje (REST, fresh);
  - deník má lot s `avgPrice` z fillů od brokera (ne `netPrice` ze streamu, ten je jen zobrazení — INV-UI-03);
  - žádný vlastní lístek;
  - nohy ≥ 8 ticků od IBKR;
  - risk-redukční (smí i za DISARMED, výjimka jako `attach-brackets`).
- Úspěch zapíše nový durable záznam `manualEntries` druhu `adopted` (`entryBrokerOrderId` = null, VWAP z lotu, `stopBrokerOrderId`/`targetBrokerOrderId` z ACK OCO). `leaderPositionModel` ho bere jako lístek s `entryFilled` = |net| při převzetí a `entryAvg` = VWAP lotu.
- Brána přikoupení pak beze změny (`ownOpen === net`).
- Tento návrh jen určuje rozhraní. Samotné převzetí patří do skupiny „správa pozice / Přidat SL/TP“ a jde přes vlastní oponenturu.

**4) Dotčené INV.**
- **INV-MANUAL-01:** převzetí jen výslovně, jen holá pozice, nohy OCO z vlastního ACK.
- **INV-UI-03:** průměr pro riziko z deníku (filly), ne z `displayAveragePrice`.
- **INV-DEFAULT-02:** nejasný attach = incident (jako dnes).
- **Kontrolní seznam INV, otázka 10:** žádné vlastnictví ze shody tvaru.
- **INV-RISK-01.**

**5) Selhání a fail-closed.**
- **Attach `unknown` / restart** = incident (dnešní pravidlo).
- **Mezitím vznikl příkaz v Tradovate** → blocked.
- **Lot chybí** (pozice otevřená za výpadku) → blocked „průměr není známý“.

**6) DEMO:** záznam pozice z Tradovate UI bez nohou + OCO attach. Patří k té položce.

**7) Testy:** `tests/manualEntryBareAttach.test.ts` rozšířit: adopt holé pozice z Tradovate; pozice s cizím příkazem → blocked (**mutace**: dovolit adopt s cizí nohou); přikoupení po adopci projde bránou.

**8) Soubory:** `services/copierRuntimeController.ts`, `services/manualScaleIn.ts`, `services/copierEngine.ts`, `lib/leaderOrderManage.ts`, UI desk a grafy, testy.

**9) Velikost M.** Závisí na položce jiné skupiny „Přidat SL/TP k pozici z Tradovate“.

---

## C18e — Holé přikoupení z telefonní lišty

**1) Verdikt:** JEN-ČÁST.
- **STAVĚT (jen UI):** lišta Koupit/Prodat **v pozici na její stranu** pošle Market přikoupení se **SL/TP pozice** (stejné jako dnešní přikoupení z listu: `withScaleInIntent`, `lib/liveScaleIn.ts:30-45`). Worker beze změny ověří `scale-in-brackets-mismatch`.
- **Opravdu holé přikoupení = ZAMÍTNOUT.** Rozhodnutí v5 přikoupení: „holé přikoupení neprojde validací“ (`lib/leaderEntryPreview.ts:144`). INV-MANUAL-01 (přikoupení): krytí = |net| nohami potvrzenými streamem. Holá část by pozici vyřadila ze správy (`ownOpen !== net` blokuje posun i × zavření, zbyl by jen Flatten, který vypne kopírku) a nechala část pozice bez ochrany.

**2) Chování.** V pozici lišta ukáže „+1 · SL/TP pozice“ (tlačítko strany pozice). Opačná strana: „V pozici jde jen přikoupit na její stranu — zavři ji ×“. Rozhodnutí F4: jedno klepnutí, nebo dvoukrokově „Přikoupit 1 se SL/TP pozice?“. Čekající přikoupení → text z `livePhoneScaleInBlocked`, dokud není C18b.

**3) Mechanismus.**
- `components/day/LivePhoneChart.tsx:149-155` (`onSide`): když `trade.scaleIn` existuje a strana sedí → `livePhoneScaleInDraft` + `withScaleInIntent` místo `livePhoneBareMarket`. Draft Market s `referencePrice`/`quoteReceivedAt` z kotace IBKR, SL/TP pozice, `position.mode 'add'`.
- Pojistky `livePhoneScaleInBlocked` (`lib/livePhoneOrders.ts:54-66`) beze změny.
- Worker, relay a migrace beze změny.

**4) Dotčené INV:** INV-UI-01 (SL/TP pozice ze statusu jsou jen návrh, worker vyžaduje přesnou shodu), INV-UI-04 (`referencePrice` jen z IBKR), INV-MANUAL-01 (holé přikoupení dál zakázané), INV-UI-02 (vypnutí dál přes Live Dashboard, beze změny).

**5) Selhání a fail-closed:** zastaralý status → worker `intent-position-changed`. SL/TP se mezitím posunuly → `scale-in-brackets-mismatch`, nic neodešlo. Výsledek `unknown` Marketu = incident (dnes).

**6) DEMO:** nic nového (Market přikoupení z telefonu ověřené 3. 11.).

**7) Testy:** `tests/livePhoneOrders.test.ts`: lišta v pozici staví Market se SL/TP pozice a záměrem (**mutace**: holý draft v pozici → test padá); opačná strana blokovaná; flat beze změny (holý Market).

**8) Soubory:** `components/day/LivePhoneChart.tsx`, `lib/livePhoneOrders.ts`, `tests/livePhoneOrders.test.ts`.

**9) Velikost S.** Bez závislostí (s C18b i při čekajícím přikoupení).

---

## 4. Navržené změny textu invariantů (`docs/COPIER_INVARIANTS.md`)

1. **INV-MANUAL-01, nová podkapitola „Čekající lístky a jejich změny (návrh 3. 11. 2026)“:**
   - V manual-only DEMO se Limit/Stop přikoupení a žebřík posílají jako lístky po 1 kontraktu v jednom příkazu: jeden durable zápis všech `sending`, jedna synchronní kontrola a souběžné POSTy v rozpočtu 5 s. `unknown` kteréhokoli lístku = incident.
   - Žebřík z flat (`ladderId`): po prvním fillu je zbytek čekající přikoupení. Před startem ho ruší jen tvrdé podmínky (F1).
   - `move-entry` posouvá rodiče OSO. Venue posouvá nohy relativně (záznam R1/R2). Režim `keep` = plánovaná kaskáda rodič → SL → TP, první nejasnost zastaví zbytek.
   - Posun Suspended nohou jen po R3/R4; jejich qty se nepřepisuje.
   - Nativní změna `orderQty` rodiče OSO se nepoužívá.
   - OCO breakout se neposílá (venue atomicita chybí).
2. **INV-BRAKE-02, třetí výjimka:** „…cílené zrušení VLASTNÍHO čekajícího přikoupení **nebo čekající příčky žebříku** (`reviewPendingScaleIns`)…“.
3. **INV-RELAY-03, bod 1:** supersede ručních příkazů = `place-leader-entry` a `manage-leader-order` se **všemi akcemi kromě `cancel-entry` a `attach-brackets`** (negativní výčet, migrace).
4. **INV-OUTBOX-03:** „Změna čekajícího vlastního vstupu v režimu `keep` je staged cascade podle precedentu 26. 8. (durable `planned` kroky, potvrzení předchozího kroku je podmínkou dalšího, mezistav je vždy platné OSO).“
5. **INV-TRAD-02:** „Vlastní posun ceny Suspended nohy je uživatelský replace (záznam R3), venue qty ne.“
6. **INV-BRAKE-03:** „Dávka lístků jednoho příkazu sdílí jeden 5s rozpočet POSTů — brzda čeká dál nejvýš ~7 s.“

## 5. Rozhodnutí pro Filipa
- **F1:** Příčky žebříku před prvním fillem zrušit při DISARM, kill, zámku a konci okna nebo session? Doporučuji ano: jinak čekající žebřík blokuje ON a po DISARM může otevřít obchod bez dozoru.
- **F2:** Výchozí režim tažení vstupu: „SL/TP jedou se vstupem“ (jako Tradovate/TV, doporučeno) nebo „SL/TP zůstanou“?
- **F3:** Limit/Stop přikoupení > 1 jako lístky po 1 ks (doporučeno) místo jednoho OSO?
- **F4:** Lišta telefonu v pozici: přikoupení se SL/TP pozice jedním klepnutím, nebo dvoukrokově?
- **F5:** Chceš převzetí pozice z Tradovate (C18d) vůbec?

## 6. Pořadí stavby a nasazení
1. Záznam R1–R7 na DEMO za DISARMED (skript + fixture + replay testy) → vyhodnocení.
2. C18e (jen UI).
3. C18a + C18b (dávka a víc čekajících) → C5d + C5c.
4. C5b → C5a (+ migrace brzdy).
5. C18c.
6. C18d po položce jiné skupiny.

Každý krok jádra: návrh i diff přes `copier-design-critic`, verdikt v odpovědi. Pořadí nasazení: relay a validace (web, sdílená lib — starý relay nové klíče odmítne, tedy fail-closed) → worker reinstall s capability → iPhone build. Migrace jen se souhlasem Filipa.

## 7. Otevřené otázky
- **O1:** Potvrdí `modifyOrder` adaptéru rodiče OSO, když venue posune i nohy (víc Replaced reportů za jeden command)? Rozhodne R1.
- **O2:** Zrušení čekajícího přikoupení nebo příčky během výpadku spojení dnes selže a vyhlásí incident (`cancelOwnManualEntry` jde rovnou na broker). Zvážit odklad na obnovu spojení — změna nasazeného chování, samostatně přes critic.
- **O3:** Fáze 2 (followeři): kopie lístků po 1 ks s násobkem < 1 dává 0. Žebřík a lístky u followerů potřebují jiný model (jedno OSO s qty N + nahraný dílčí fill na prop účtu).


---

## Posudek copier-design-critic (návrh)

**Celkový verdikt: OPRAVIT PŘED COMMITEM**

- **P1** [C5a (move-entry, režim follow)] (INV-RISK-01, INV-MANUAL-01 (2a/2c: posun SL dál od vstupu vždy s přepočtem rizika), INV-DEFAULT-02) V režimu follow návrh přepočet rizika vynechává („follow drží vzdálenost“). Přitom připouští výsledek „nohy se neposunuly, tvar platný → acknowledged + audit“. Scénář: Buy Limit 1 @ 20000, SL 19980, TP 20060 (přijaté riziko 20 b). Uživatel táhne vstup na 20030. Venue posune jen rodiče nebo jen nohu s parentId. TP noha našeho tvaru parentId nemá (fixture tradovate-leader-oso-api-cancel.json) a K1 na leaderovi s naším placeoso nahrané není. SL tak zůstane 19980. Tvar 19980 < 20030 < 20060 platí, takže výsledek je acknowledged. Po fillu je ale riziko 50 b a nikdo ho neověřil proti rezervě. Navíc se rezerva od place mohla zmenšit. Přepočet dnes existuje jen pro move-stop dál od trhu (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRuntimeController.ts:5226-5259 a :4930-4952) a follow ho obchází.
  - Oprava: V prepare spočítat riziko pro oba možné výsledky (nohy posunuté i neposunuté, tedy max(new−SL, new−SL′) × qty + skluz a poplatky) proti čerstvé rezervě, stejně jako náhled: snímek ≤ MANUAL_ENTRY_RISK_MAX_AGE_MS, stejná session, novější než lastLeaderFillObservedAt. Když neprojde, výsledek je blocked. Po zápisu platí: skutečné nohy ≠ předpověď a riziko > přijaté → cancelOwnManualEntry + failClosed({autoClose:false}), nikdy acknowledged. Mutační test: vypnout kontrolu neposunutých nohou → replay R1 s nohou, která se nepohnula, musí skončit zrušením vstupu.
- **P2** [C5a (režim keep – kaskáda rodič → SL → TP)] (INV-BRAKE-03, INV-RELAY-03 bod 5) manageLeaderOrder vrací až výsledek celého jobu (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRuntimeController.ts:20021-20026). Agent čeká na copy-commandy v sériovém tail (/Users/filipkrejca/alphatrade-worktrees/scale-in/server/localCopierExecutionAgent.ts:1408-1413) a Mac relay smyčka čeká na doručení (/Users/filipkrejca/alphatrade-worktrees/scale-in/server/macCopierCommandRelay.ts:518). Vzdálená brzda z telefonu proto čeká za celou kaskádou: rodič (MANUAL_ORDER_MANAGE_TIMEOUT_MS 8 s, :3435) + nohy 2 s + krok SL 8 s + krok TP 8 s ≈ 26 s. INV-BRAKE-03 dnes počítá s ~7 s. Návrh tvrdí „neblokuje FIFO brzd (zápis mimo frontu, ohraničený)“, ale plete si frontu controlleru se sériovou linkou relaye.
  - Oprava: Jeden rozpočet na celou kaskádu (např. 8 s celkem). Deadline předávat do každého kroku; krok, který by začal po rozpočtu, je not-sent s textem „SL/TP zůstaly posunuté o Δ“. Kroky -s2/-s3 posílat souběžně (nohy jsou nezávislé), ne za sebou. Nový horní odhad zapsat do INV-BRAKE-03. Test: brzda zařazená během kaskády se vykoná nejpozději po uplynutí rozpočtu.
- **P2** [C5a (dořešení unknown / restart)] (INV-OUTBOX-02, INV-OUTBOX-03, INV-RISK-01) Návrh doplňuje větev move-entry do classifyManagedOrderLookup (:4373-4399) a resolveManualOrderActionFromStream (:4530-4545) jen s podmínkou „cena vstupu = toPrice → acknowledged“. Když nohy nedorazí do 2 s, což je pravděpodobné (venue je hlásí jako další Replaced), nebo když se worker restartuje v sending, lookup potvrdí posun bez kontroly nohou. Tvar ani riziko z P1 se pak nikdy nevyhodnotí.
  - Oprava: move-entry potvrdit jen z autoritativního čtení rodiče i obou nohou (findOrderById ×3 nebo listOrders fresh, ohraničené 3 s) se stejným vyhodnocením tvaru a rizika jako po zápisu. Jinak záznam zůstane unknown: blokuje další změnu lístku i pozice a automatické pokračování (:12124).
- **P2** [C5a (marketability a kotace)] (INV-UI-04, INV-MANUAL-01 (vlastní OSO musí zůstat chráněné), INV-FRESH-01) Podle návrhu Limit bez čerstvé kotace IBKR projde „jako dnešní Limit“; náhled to má jen jako poznámku (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/manualEntryPreview.ts:352). Tažením čáry se ale přes trh přejede mnohem snáz než zapsanou cenou. Scénář: Buy Limit 20000, SL 19980, trh 20010, IBKR neběží (jede záloha TV). Uživatel táhne na 20040 v režimu follow → okamžitý fill kolem 20010. SL′ 20020 je Sell Stop NAD trhem: broker nohu odmítne (incident, pozice bez SL), nebo se stop hned spustí. Kotaci navíc návrh kontroluje jen ve frontě. Mezi přípravou a modify běží durable zápis, a proto má Market synchronní druhou kontrolu (:3932-3946).
  - Oprava: move-entry jen s čerstvou kotací IBKR téhož kontraktu, a to pro Limit i Stop; bez kotace blocked. Nový vstup nesmí být marketable. SL′/TP′ v režimu follow musí ležet aspoň MANUAL_TIGHTEN_MIN_TICKS na správné straně kotace. Kotaci znovu synchronně ověřit těsně před modify (vzor P1-3 u Marketu). V UI tah přes IBKR mark zastavit.
- **P2** [§3 / C5d / C18a (rungs – strana SL/TP vůči každé příčce)] (INV-MANUAL-01, INV-OUTBOX-03, INV-RISK-01) Strana SL/TP se dnes kontroluje jen proti entryPrice = price, tedy proti první příčce (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/manualEntryPreview.ts:316-326). Žebřík Buy 20000/19990/19980 se SL 19985 projde. OSO příčky 3 pak má SL nad vstupem: po fillu broker nohu odmítne (pozice bez SL → incident) nebo se SL hned spustí. U Sell žebříku totéž s TP. Návrh mluví o riziku Σ příček, ale validaci strany pro každou příčku nezmiňuje.
  - Oprava: Ve sdílené validaci (lib/leaderEntryPreview.ts, relay i worker) a v náhledu kontrolovat každou příčku: SL ostře na ochranné straně a TP na ziskové straně, každé ≥ 4 ticky; u Stop příček navíc rezerva skluzu. Dále: příčky na jedné straně, unikátní ceny, rungs.length = quantity ≤ strop. Riziko i DD swing počítat po příčkách. Mutační test: kontrola jen první příčky → test padá.
- **P2** [§2 / §6 (migrace supersede, pořadí nasazení)] (INV-RELAY-03 bod 1, INV-BRAKE-03) Supersede move-entry brzdou potřebuje migraci RPC, ale capability manual-order-move-entry-v1 inzeruje worker. Pořadí v §6 migraci jako předpoklad neuvádí („jen se souhlasem Filipa“). Když se worker s capability nasadí dřív, bod 1 INV-RELAY-03 tiše přestane platit a zůstane jen agentův brake-after-request. Záložní TS cesta (/Users/filipkrejca/alphatrade-worktrees/scale-in/server/tradovateCopierCommandRelay.ts:975) navíc zůstane u pozitivního výčtu, zatímco SQL přejde na negativní, takže se budoucí akce rozejdou.
  - Oprava: Pořadí: migrace → relay/web → worker s capability. Worker smí capability inzerovat, až je migrace potvrzená (nebo relay move-entry bez ní odmítne). Výjimky ('cancel-entry', 'attach-brackets') držet jako jedinou sdílenou konstantu v lib a negativně ji použít v TS záloze i v SQL. SQL test projde všechny ACTIONS z lib/leaderOrderManage.ts:62 a u každé ověří supersede nebo výjimku.
- **P3** [§3 (id a tag lístků)] (INV-OUTBOX-01, INV-TRAD-03, INV-MANUAL-01) (a) Délka: entry: + až 100 znaků (lib/leaderEntryPlace.ts:21) + „-t5“ přesáhne ENTRY_OPERATION_ID_PATTERN {8,100} (/Users/filipkrejca/alphatrade-worktrees/scale-in/lib/leaderOrderManage.ts:61). cancel-entry příčky pak neprojde validací a zbude jen Flatten. (b) Kolize: relay povolí nezávislé operationId entry:X-t1. Pozdější dávka entry:X pak přes persistManualEntry (:3614-3627, nahrazení podle operationId) přepíše živý záznam, a worker tím ztratí vlastnictví živého OSO. (c) tag/clOrdId je dnes jeden na příkaz (:3897), dávka potřebuje tag pro každý lístek.
  - Oprava: operationId dávky ≤ 96 znaků. Před durable zápisem vrátit blocked operation-conflict, pokud některé id lístku už existuje. Tag pro každý lístek zvlášť. Ideálně oddělovač, který klient vyrobit nemůže, a pattern cancel-entry rozšířit právě jen o něj.
- **P3** [C5a (stav planned)] (INV-OUTBOX-02, INV-RECON-04) planned není v UNRESOLVED_MANUAL_ORDER_ACTION (:4123). Nevidí ho proto ořez (:4143, :4156), durable mutex pozice (:4820), automatické pokračování (:12124) ani waiver. Mezi dokončeným krokem rodiče a persistem -s2 = sending drží mutex jen paměť procesu.
  - Oprava: Přidat planned mezi nevyřešené stavy. Při restartu mapovat planned → not-sent (jak návrh uvádí). Doplnit test ořezu a restartu s kaskádou rozpracovanou uprostřed.
- **P3** [C5a / C5b (mutex v paměti)] (INV-OUTBOX-01, INV-WORKER-02) manualOrderActionJobs se plní až po návratu prepare (:20024), kdežto positionActionsInFlight se plní uvnitř prepare (:4887, :4964). Jednolístková cesta (:5084-5100) positionActionsInFlight vůbec nekontroluje. Dnes to kryje sériový tail agenta, takže přes relay se dvě změny nepřekryjí (ověřeno v kódu). Automatické cancelOwnManualEntry z reviewPendingScaleIns ale běží souběžně a návrh move-entry na něj nereaguje (record.cancel / manualEntryCancelRequested).
  - Oprava: prepareMoveEntry a preparePendingLegMove mají in-flight registrovat synchronně uvnitř prepare a kontrolovat obě sady. move-entry vrátit blocked, když běží cílené zrušení téhož lístku. Test: dva příkazy zařazené přímo na controller bez agenta.
- **P3** [§3 (zápis výsledků dávky)] (INV-BRAKE-03) Výsledky lístků se ukládají přes persistManualEntry po jednom. To je N durable zápisů ve frontě controlleru po POSTech, takže vzdálená brzda čeká déle než slibovaných ~7 s.
  - Oprava: Výsledky uložit jedním persistManualEntries a tento čas započítat do rozpočtu dávky.
- **P3** [C5d (start žebříku)] (INV-DIVERGENCE-01, INV-MANUAL-01 (čekající přikoupení jako stavová podmínka)) Start žebříku se pozná jen podle durable baseEpisodeId. Selže-li persist, nebo ještě nedoběhl, a pozice z příčky 1 rychle skončí na TP, review vidí stav „před startem“ a net 0 nic neruší. Zbylé příčky zůstanou na flat účtu a mohou automaticky znovu vstoupit; episodeMismatch bez baseEpisodeId nic nehlásí.
  - Oprava: Start odvozovat také synchronně z paměti: fill kteréhokoli sourozence (ownEntryFillPrices nebo stav filled), případně lot či uzavřený obchod s jeho entryOrderIds. Selhání persistu baseEpisodeId = failClosed (DISARM → F1 příčky zruší).
- **P3** [C5d (F1, O2)] (INV-BRAKE-01/02, INV-DEFAULT-01, INV-RECON-04) F1 je v návrhu jen otázka pro Filipa. Bez F1 příčky přežijí DISARM, kill i restart a mohou se bez dozoru vyplnit až do N kontraktů (rezerva se ověřovala jen při odeslání). S F1 zase každé zakolísání spojení spustí pokus o zrušení: selže → incident (O2), nebo uspěje → žebřík tiše zmizí.
  - Oprava: F1 brát jako podmínku stavby C5d, ne jako volbu. O2 rozhodnout ještě před C5d a v UI popsat, že žebřík po výpadku zmizí.
- **P3** [C5b (Suspended nohy)] (INV-MODE-01, INV-TRAD-02, INV-RISK-01) (a) U Stop vstupu stačí TP ≥ vstup + 4 ticky bez rezervy skluzu, takže po fillu se skluzem je TP hned marketable (okamžitý výstup). (b) Brány jsou jen ARMED ∧ ¬shadow ∧ ¬kill. Posun Suspended SL dál od vstupu proto není v management-only výslovně zakázaný. (c) Pozice s čekajícím lístkem: utažení SL nad cenu čekajícího vstupu musí zablokovat celou změnu, ne jen část nohou. runPositionMove před zápisem vyžaduje status working (:4996) a úprava musí platit jen pro Suspended nohy čekajících lístků. (d) close-position na žebříku na flat (net 0) musí zůstat blokovaný.
  - Oprava: U Stop vstupu přidat k TP rezervu skluzu (MANUAL_ENTRY_MARKET_SLIPPAGE_TICKS). V management-only blokovat posun Suspended SL dál od vstupu. Pravidlo všechno-nebo-nic pro celou pozici. Pro každý bod test.
- **P3** [§1.2 (záznam R1–R7 na DEMO)] (INV-RISK-02/03, INV-TRAD-04, INV-RECON-04) Filly ze scénářů R2/R4/R6b/R7 jdou na DEMO8661118, který je leaderem manual-only skupiny. Započítají se do denních statistik (strop 250 USD, 40 obchodů za session, cooldown) a mohou zamknout den reálnému DEMO provozu. Skript také sdílí OAuth rate budget s běžícím workerem. Kdo skript spouští, je nejasné: §1.2 uvádí „Claude nebo Filip“, ale podle dřívější dohody skripty k brokerovi spouští Filip.
  - Oprava: Pro každý scénář, který vyplní příkaz, výslovný souhlas. Spouštět mimo obchodní okno skupiny. Před během ověřit DISARMED a že neběží žádné automatické pokračování po výpadku. Po běhu udělat Kontrolu pozic jako výslovný úkon a dopad na denní statistiky zapsat.
- **P3** [C18c (vlastní SL/TP lístku)] (INV-RISK-01, INV-DEFAULT-02, INV-UI-01) unify-stop převede nohy na jednu cenu. U části nohou to je utažení (platí 8 ticků od IBKR), u části rozšíření (nutný přepočet rizika); návrh to nerozlišuje. positionUnderCovered je navržené jen pro vlastní nohy lístků, přitom podkrytí vzniká i u jednotných nohou (např. noha ručně zrušená v Tradovate).
  - Oprava: V unify-stop kontrolovat každou nohu zvlášť (utažení → 8 ticků, rozšíření → riziko). positionUnderCovered hlídat u všech pozic s lístky. Stavět až po úspěšném R7.
- **P3** [C18d (převzetí pozice)] (INV-MANUAL-01 (attach jen nejnovější záznam, žádná adopce cizí pozice), kontrolní seznam ot. 10, INV-UI-03) Převzetí mění vlastnictví a otevírá cestu k dalším přikoupením, která riziko zvyšují. Návrh chce lot z deníku, ale chybí podmínka lot.netQuantity === |net|, shodná otevřená epocha, výslovné dvoukrokové potvrzení a změna textu INV-MANUAL-01, které adopci dnes zakazuje.
  - Oprava: Podmínky: REST fresh bez jakéhokoli příkazu na symbolu, lot.netQuantity = net, jediná otevřená epocha se stejným lastLeaderNet, dvoukrokové potvrzení, rozhodnutí F5 a nový odstavec INV-MANUAL-01. Celé jako samostatná oponentura.
- **P3** [C18e (lišta v pozici)] (INV-UI-01/02, INV-MANUAL-01) Jedno klepnutí v pozici zvýší riziko (přikoupení Marketem). Dvojklik zachytí rozestup 3 s, ale omylem klepnutá stejná strana zdvojnásobí expozici.
  - Oprava: Doporučuji dvoukrokové potvrzení (jako × čekajícího vstupu), nebo výslovné rozhodnutí F4 zapsané do INV-MANUAL-01.
- **P3** [Testy (všechny položky)] (Kontrolní seznam ot. 25) Navržené testy míří do neexistujících souborů tests/leaderOrderManage.test.ts a tests/leaderEntryPreview.test.ts; validace dnes žije v tests/manualOrderManage.test.ts a tests/manualEntryPreview.test.ts. Chybějící scénáře: follow s neposunutými nohami; lookup unknown s nohami jinde; brzda během kaskády keep; DISARM mezi krokem rodiče a krokem SL; druhá kontrola kotace před modify; příčka za SL; capability bez migrace; kolize a délka id; planned při ořezu a restartu; dávka s jedním POSTem 4,9 s a eventy ostatních lístků (okno lone-leg a ambiguous v osoCorrelator); restart mezi fillem příčky a persistem baseEpisodeId; opačné pořadí Position/Fill příčky. Testy se nespouštěly (zadání čtení bez běhu).
  - Oprava: Scénáře doplnit jako deterministické replay testy s mock brokerem a u každé nové pojistky mutačním testem.

### Verdikty po položkách

- §1.2 Plán záznamu R1–R7: **OK S VÝHRADAMI** — Směr je správný: DISARMED, jen DEMO, MNQ, --confirm, úklid ověřený streamem i REST a po něm read-only kontrola. Výhrady: dopad fillů na denní statistiky, sdílený rate budget s workerem, výslovný souhlas pro každý fill-produkující scénář (P3).
- §2 Admission a brzda: **OK S VÝHRADAMI** — Tvrzení sedí s kódem: RPC hlídá jen busy a rozestup place-leader-entry (migrace ř. 139-151), supersede má pozitivní výčet (ř. 326-335) a agentův brake-after-request je negativní, takže move-entry kryje (localCopierExecutionAgent.ts:969-975). Migrace musí předcházet capability a TS záloha má mít stejný negativní výčet (P2).
- §3 Lístky po 1 ks, dávka: **OPRAVIT** — Koncept (qty 1 vylučuje dílčí fill, jeden durable zápis, jedna synchronní kontrola, souběžné POSTy, unknown → failClosed) je správný a sekvenční varianta by skutečně selhala na fence (ř. 4053). Opravit: validace SL/TP vůči každé příčce (P2), délka, kolize a tag id (P3), jeden zápis výsledků (P3).
- C5a move-entry: **OPRAVIT** — Follow neověřuje riziko, ale přijme výsledek s neposunutými nohami (P1). Kaskáda keep drží sériovou linku relaye až ~26 s (P2). Lookup nekontroluje nohy (P2). Limit jde bez IBKR a bez druhé kontroly kotace (P2). planned chybí mezi nevyřešenými a mutex je potřeba zpevnit (P3). STAVĚT-PO-CONFORMANCE (R1/R2/R3) platí až po těchto opravách.
- C5b Suspended nohy: **OK S VÝHRADAMI** — Správně je, že krytí počítá jen vyplněné lístky, qty nohou jde ze streamu a stavět se má až po R3/R4. Doplnit rezervu skluzu TP u Stop vstupu, blokaci v management-only, pravidlo všechno-nebo-nic pro pozici s čekajícím lístkem a úpravu kontroly před zápisem jen pro Suspended nohy (P3).
- C5c Změna qty: **OK S VÝHRADAMI** — Zamítnutí nativního orderQty na rodiči OSO je správné (INV-TRAD-02). „−“ = cancel-entry lístku (riziko snižuje), „+“ = nový příkaz se všemi branami. Závisí na opravě id lístků (délka validace) a na C5d/C18b.
- C5d Žebřík / stack: **OPRAVIT** — Chybí validace SL/TP vůči každé příčce (P2). F1 musí být podmínkou stavby (P3). Start žebříku jen z durable baseEpisodeId nechává okno (P3). R6c souběžné placeoso musí ukázat, že osoCorrelator při N stejných tvarech nehlásí ambiguous ani lone-leg.
- C5e OCO breakout: **ZAMÍTNUTÍ SPRÁVNÉ** — Varianta A je neatomická emulace OCO: obě strany se mohou vyplnit a náprava by byla obchodem. Varianta B nechá breakout bez ochrany. Obojí porušuje INV-OUTBOX-03, INV-DIVERGENCE-01 a INV-MANUAL-01. Průzkum multibracketu jen read-only je v pořádku.
- C18a Limit/Stop přikoupení > 1: **OK S VÝHRADAMI** — Rozdělit na N lístků po 1 ks místo jednoho OSO s qty > 1 je správné. Přebírá opravy z §3 (strana SL/TP pro každou příčku, id, zápis výsledků). Strop už počítá čekající (ř. 290-293).
- C18b Víc čekajících přikoupení: **OK S VÝHRADAMI** — scale-in-pending-brackets se Suspended nohami potvrzenými streamem a riziko nejhoršího případu jsou v pořádku. pendingAddViolation ruší každý lístek zvlášť a selhání = incident. Stavět až po R6b.
- C18c Vlastní SL/TP lístku: **OK S VÝHRADAMI** — Nové hlídání podkrytí je správný a potřebný přírůstek. Návrh výslovně odmítá tiché sjednocení. unify-stop musí kontrolovat každou nohu zvlášť a podkrytí hlídat u všech pozic (P3). Stavět až po R7.
- C18d Převzetí pozice z Tradovate: **OK S VÝHRADAMI** — Zamítnutí pozice s cizími nohami je správné (ot. 10). Převzetí holé pozice mění politiku INV-MANUAL-01 a potřebuje F5, lot.netQuantity = net, shodnou epochu, dvoukrokové potvrzení a vlastní oponenturu.
- C18e Lišta telefonu v pozici: **OK S VÝHRADAMI** — Jen UI, worker beze změny ověří přesnou shodu SL/TP a záměr. Holé přikoupení zůstává zakázané (správně). Doporučuji dvoukrokové potvrzení (F4).
- §4 Text invariantů: **OK S VÝHRADAMI** — Doplnit: follow vyžaduje riziko pro oba výsledky; horní mez času kaskády do INV-BRAKE-03; F1 jako pravidlo; validace stran pro každou příčku; planned jako nevyřešený stav; migrace jako předpoklad capability.
- §6 Pořadí stavby a nasazení: **OK S VÝHRADAMI** — Pořadí R → C18e → C18a/b → C5d/c → C5b → C5a → C18c → C18d dává smysl. Chybí výslovné pořadí migrace → relay → worker pro capability move-entry.
- Q1 ARM bez syncu/flat: **netýká se** — ARM se nemění. Čekající příčky ARM blokují přes flat/no-working (INV-ARM-01).
- Q2 unknown → flat/zero: **drží s výhradou** — Stack při net === null je blocked a pendingAddViolation při neznámé pozici nic neruší. PORUŠENO v C5a: neověřené riziko neposunutých nohou návrh přijme jako acknowledged.
- Q3 mazání lastError: **netýká se** — Žádný reconcile z pozadí. Kontrola po záznamu je výslovná.
- Q4 veřejné vs interní reconcile: **drží** — §1.2 výslovně zakazuje veřejné reconcile() z pozadí.
- Q5 DISARM/kill/fill/reconnect během await: **drží s výhradou** — Před každým krokem kaskády se znovu kontroluje gate a generation. Kotace IBKR se ale mezi přípravou a modify znovu neověřuje (P2). Mutex souběžných změn dnes drží jen díky sériovému tail agenta (P3).
- Q6 fence před write i commitem: **drží** — U dávky jedna synchronní kontrola a dispatchBroker před každým voláním (exposureCappedBroker.ts:103-121), u kaskády před každým krokem. Commit výsledku se nefencuje (správně).
- Q7 dvojí vykonání: **drží s výhradou** — Žádný retry, dedup podle batchId, restart převede sending na unknown. Výhrada: kolize id lístku s nezávislou operací (P3).
- Q8 durable před write, unknown ARM-blocking: **drží s výhradou** — Platí persistManualEntries a sending/planned před zápisem. planned ale chybí mezi nevyřešenými stavy (P3).
- Q9 partial / Suspended / chybějící noha: **PORUŠENO částečně** — qty 1 vylučuje dílčí fill a Suspended nohy jdou až po R3/R4. Ale: příčka za SL dá OSO se SL na špatné straně (P2) a lookup move-entry nohy neověřuje (P2).
- Q10 divergence obchodem / vlastnictví ze shody: **drží** — C5e zamítnuto, C18d jen výslovné převzetí holé pozice, nic se nedorovnává.
- Q11 cíl zavření: **netýká se** — liquidate beze změny. Příčky se jen cíleně ruší podle id z vlastního záznamu.
- Q12 nejasná likvidace: **netýká se** — Beze změny (INV-MODE-02). R6b ověří, že liquidate zruší i čekající lístky.
- Q13 management-only: **drží s výhradou** — pendingAddViolation čekající lístky ruší a move-entry blokuje. Posun Suspended SL dál od vstupu v management-only ale výslovně zakázaný není (P3).
- Q14 follower toggle/cut/změna skupiny: **netýká se** — Fáze 1 je bez followerů a topologii zamyká installer (scaleInEnabled).
- Q15 eligibility jen zpřísňuje: **netýká se** — Nová cesta k active nevzniká.
- Q16 day lock/cooldown: **drží s výhradou** — F1 ruší příčky při zámku i konci okna či session. Fill ze záznamu na DEMO se ale počítá do denních statistik (P3).
- Q17 brzda bez čerstvého statusu, starší ARM po brzdě: **PORUŠENO (návrh)** — Kaskáda keep drží sériovou linku relaye až ~26 s (P2). Supersede move-entry stojí na migraci, kterou pořadí nasazení nezaručuje (P2).
- Q18 relay retry/idempotence/TTL: **drží** — Jeden příkaz, operationId, TTL 15 s, atomická admission beze změny.
- Q19 řazení UI statusu: **netýká se** — pendingTickets a ladder ve statusu jsou jen zobrazení (INV-UI-01).
- Q20 restart v planned/sending/unknown: **drží s výhradou** — sending → unknown + incident (scaleIn/ladderId), planned → not-sent. Start žebříku jen z durable baseEpisodeId (P3).
- Q21 dvě OAuth route: **netýká se** — Jediný DEMO účet a jedna route.
- Q22 dva živé workery: **vědomě otevřené** — Mutex je jen v procesu (INV-WORKER-02), návrh to přiznává.
- Q23 p-time/Retry-After: **drží s výhradou** — N souběžných POSTů a cancelů a skript sdílející token. R6c má ověřit 429, adaptér respektuje p-time.
- Q24 víkend: **netýká se** — Žádná kalendářní výjimka.
- Q25 deterministické testy chyb/restartu/pořadí: **částečně** — Mutační testy navržené jsou, chybí ale scénáře uvedené ve zjištění Testy. Testy jsem nespouštěl (zadání).
- Q26 oddělení tvrzení test/nasazení/broker: **drží s výhradou** — Návrh odděluje DEMO záznam, replay testy a nasazení. Doplnit migraci jako předpoklad capability.
