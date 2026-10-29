# Obchodování z grafu — vnitřní vrstva (návrh, 29. 10. 2026, revize 1)

Stav: NÁVRH, nic neimplementováno. UI (lístek, čáry, tažení) ladí Filip podle
`mockups/chart-order-entry.html`; tento dokument řeší datovou vrstvu, zápis
k brokerovi a pravidla. Změna jádra kopírky → INV + `copier-design-critic`.
Revize 1 zapracovává oponenturu `copier-design-critic` (verdikt původního
návrhu: OPRAVIT PŘED IMPLEMENTACÍ, nálezy P1–P7 níže v textu).

## 0. Výchozí stav (zmapováno 29. 10.)

- Appka dnes k brokerovi zapisuje jen risk-redukčně (`flatten-account`,
  `flatten-group`, `flatten-follower-trade`, vždy nejdřív DISARM). Vstup,
  posun SL/TP, BE ani cancel z appky neexistují.
- Jediný zapisovatel k brokerovi je Mac worker. Tak to zůstane.
- Kopírka vidí leaderovy příkazy z WS bez ohledu na původ. OSO kopíruje přes
  `CopierOsoCorrelator` (vstup musí dorazit před nohami, okno 1500 ms),
  market + SL/TP přes `CopierBracketCorrelator` po fillu.
- `placeOso` NA LEADEROVI kopírka nikdy nepozorovala; OSO z Tradovate UI /
  TradingView nese jiný tvar (bez `parentId`). Tvar eventů je NEOVĚŘEN.
- Leader nemá strop qty; `maxContracts` followera je odmítnutí
  (`exposureCappedBroker`), ne strop; follower `on-fill` OSO nepodporuje
  (kritický `blocked`); `maxLeaderOrders` při překročení failClosed.
- Relay dnes výslovně nepouští žádný risk-zvyšující zápis
  (`tradovateCopierCommandRelay.ts:239-246`) — tohle je první.

## 1. Princip

Příkaz z grafu = příkaz na LEADER účtu, poslaný workerem; followerům ho
rozkopíruje existující kopírka. Kopírka ale musí VĚDĚT, že jde o vlastní
ruční OSO (tag `me` / id z ACK), aby při neobvyklém pořadí eventů nikdy
neposlala followerům vstup bez ochrany (P2).

## 2. Fáze

- **Fáze 0 — DEMO záznam (bez kódu v produkci).** Na testovacím účtu
  zadat `placeOso` (Limit, Stop) přes API a zaznamenat surový WS
  (pořadí, `parentId`, statusy, časy) zvlášť pro Lucid i Tradeify
  připojení. Záznam = fixture pro testy controlleru. Bez něj se nic
  dalšího nestaví.
- **Fáze 1a — „would place“.** Celá cesta (lístek → relay → worker →
  brány) bez zápisu k brokerovi; worker vrátí, co by poslal a proč by
  odmítl. Ověří brány, náhled qty a latenci naostro bez rizika.
- **Fáze 1b — DEMO zápis** Limit / Stop (na správné straně trhu) jako OSO
  se SL i TP, jen za ARMED, leader i skupina flat.
- **Fáze 1c — LIVE** s `manualEntryMaxContracts = 1`, pak zvýšit.
- **Fáze 2** — posun SL/TP a BE (`modifyOrder` s `expectPrice`), zrušení
  čekajícího vstupu (celé OSO), zavření pozice ZA ARM tak, aby kopírka
  zavřela kopie běžnou cestou (ne dnešní DISARMující flatten).
- **Později** — Market vstup (prověřit na DEMO `placeOso` s Market
  parentem), „jen leader“ za DISARMED, přidávání do pozice.
- **Ne:** „stop přes trh“ jako náhrada marketu — chování burzy/simu
  neověřené a okamžitý fill závodí s eventy nohou (follower bez ochrany).

## 3. Čtecí vrstva pro lístek (`useOrderTicketContext(root)`)

- **Autorita je výhradně worker**; čerstvost v klientovi je UX. Lístek
  používá `displayWorkerStatusReader` (řadí `startedAt`+revize, < 15 s)
  doplněný o ACK fence + malou sdílenou čistou funkci `ticketMaySend(...)`
  (LIVE i deník). Bez refaktoru LIVE fence. Upravit text INV-UI-03.
- **Skupina** z worker statusu (ne z cache), **kontrakt** z nového
  `tradableContracts` ve statusu (worker z Tradovate contract library:
  `name`, `contractId`, `tickSize`, `pointValue`, `front`, `rollAt`);
  centrální `tickSize` místo natvrdo 0,25.
- **Stav bran** jen zobrazení; rozhoduje worker.
- **Náhled qty followerů**: stejná čistá funkce jako kopírka
  (`followerQuantity`) + lístek předem ukáže odmítnutí, když
  floor(qty × mult) > `maxContracts` nebo vyjde 0.
- **Riziko v $** per účet (leader i každý follower) z absolutních cen
  zadaných uživatelem; TV/IBKR cena jen zobrazení (INV-UI-04).

## 4. Zápis: relay příkaz `place-leader-entry`

Payload: `{ groupId, operationId, deviceId, leaderAccountId, contractId,
contractName, action, quantity, orderType: Limit|Stop, price,
stopLoss: { price }, takeProfit: { price },
intent: { armedAt, groupConfigHash, followerQuantities: [{accountId, qty}] },
payloadHash }`

- **Idempotence (P5)**: `operationId` = relay `idempotencyKey`; `deviceId`
  připnutý ze statusu, ze kterého lístek vychází (nesouhlas = odmítnout,
  jinak dvě zařízení = dva řádky); stejný klíč s jiným `payloadHash` =
  odmítnout. Worker: durable dedup ve stejném CAS commitu jako `sending`.
- **TTL**: Limit/Stop 15 s; kontrola stáří i těsně před raw zápisem
  (`deadlineAt = expires`, bez ARM ACK rezervy) — příkaz může čekat ve FIFO.
- **Brzdy (INV-RELAY-03)**: odmítnout vstup s `createdAt` ≤ poslední brzda
  + skew; serverově rušit čekající vstupy brzdou (jako
  `expirePendingArmsSupersededByBrake` u ARM).
- **Bezpečnost relaye (P7)**: rate limit na uživatele, denní strop počtu
  ručních vstupů, audit, push „ruční vstup odeslán / proveden / odmítnut“.
- **Intent místo `statusRevision` (P6)**: worker ověří `armedAt` (stejná ARM
  session), otisk konfigurace skupiny (násobky, `maxContracts`, režimy,
  enabled), leadera, kontrakt a přepočítá qty followerů — musí přesně sedět,
  jinak odmítnout (např. `set-multiplier` mezi náhledem a provedením).

### Brány ve workeru (fail-closed, vlastní důvod pro UI)

1. ARMED, ne shadow, connected, ne kill, ne managementOnly, ne
   reconciliationRequired, žádná divergence / stuck outbox / ruční vstup
   v `sending`/`unknown`/`abandoned`.
2. `accountId === leaderAccountId`, `canTrade`, eligibility `active`.
3. Celá skupina „klidná“: leader i followeři flat a bez working orders,
   žádná čekající kopie, rozpracovaná OSO/bracket korelace, leader-flat
   epocha, běžící cut, `pendingConnectionRecovery` / `transportResume`.
4. Všichni účastnící se followeři `on-submit`; žádný by neskončil odmítnutím
   `maxContracts` ani qty 0; nepřekročí se `maxLeaderOrders`.
5. Denní pravidla přes TYTÉŽ funkce controlleru (`evaluateDailyRules`,
   `entryRestrictionActive`, pauza, okno); rezerva před expirací ARM, koncem
   okna, koncem session 17:00 CT a čekajícím day lockem.
6. Riziko: leader (|vstup − SL| × qty × pointValue) ≤ zbývající DLL/prop
   z čerstvého `accountRisk` (< 90 s); totéž per follower s jeho qty.
7. `quantity` ≤ povinný `manualEntryMaxContracts` leadera (tighten-only
   pravidlo v relay); nejhorší případ nad čerstvým čtením těsně před
   zápisem.
8. SL i TP povinné, na správné straně vstupu, ceny na tick; Limit/Stop na
   správné straně trhu kontroluje broker (odmítnutí = `rejected` bez
   order id).
9. Zápis přes `dispatchBroker` (fence `safetyGeneration`, zvýšení
   `dispatchObservationVersion`) + nová kontrola trade observation a route
   epochy leadera těsně před raw zápisem (souběžný příkaz z Tradovate UI,
   reconnect Lucid route).
10. Nikdy nevolat `reconcile()` (INV-RECON-02); jen read-only čtení.

### Vlastní outbox ručního vstupu (P1, P3)

- Samostatný durable `manualEntryOutbox` v novém poli snapshotu, NE
  `copierOsoOutbox` (ten by kopírku zablokoval: `sending` = stuck →
  followeři `blocked` → failClosed; a sloužil by jako stopa pro auto-close).
- Stavy: `planned` → `sending` → `acknowledged` | `rejected` (jen bez
  jakéhokoli order id) | `unknown` | `abandoned`. Nikdy zpět `planned`;
  prázdný lookup (`findOrdersByTag` je vždy `eventual`) = `unknown`.
- Blokuje ARM a další ruční vstup; NEblokuje replikaci leaderových eventů.
  `acknowledged` se commitne v serializované lince controlleru dřív, než se
  zpracují eventy téhož OSO.
- Odpověď s `orderId` bez id obou nohou = `abandoned` + incident + přesně
  cílený cancel vlastního vstupu (ROZHODNUTÍ FILIPA — viz otázky).
- Restart v `sending`: nalezeno → adoptovat, nenalezeno → `unknown`.
  Rozuzlení `unknown`/`abandoned` = nový `kind` ve
  `STUCK_OPERATION_KINDS` + `waiveStuckOperation` (auditovaný waiver).
- UI: timeout / `claimed` po `expiresAt` = „výsledek neznámý“, nikdy
  „neprovedeno“.

### Kopírka a vlastní OSO (P2)

Controller pozná vlastní ruční OSO (tag `me`/id z ACK). Pro něj nikdy
nepošle followerům samostatný vstup: chybí-li po okně nohy, fail-closed +
přesný cancel vlastního vstupu leadera (ROZHODNUTÍ FILIPA). Testy podle
fixture z fáze 0: nohy před parentem (s `parentId` i bez), fill před
nohami, TP po > 1500 ms, částečný fill.

## 5. Otázky pro Filipa

1. **Fáze 0 — kde.** Záznam vyžaduje skutečný (byť testovací) příkaz přes
   API. Na jakém účtu: samostatný Tradovate sim / demo účet mimo prop
   firmy, nebo leader s limitem daleko od trhu a okamžitým zrušením?
2. **Automatický cancel vlastního vstupu** leadera, když broker vrátí
   neúplné OSO nebo nohy nedorazí (jinak leader zůstane s čekajícím
   vstupem bez ochrany a skupina ve fail-closed). Ano/ne?
3. **Jen za ARMED** ve fázi 1 (doporučeno) — souhlas?

## 6. Dotčená pravidla INV

INV-DEFAULT-01/02, INV-ARM-01/04, INV-BRAKE-01/02/04, INV-RISK-01/02/03/04,
INV-OUTBOX-01/02/03, INV-RELAY-01/02/03, INV-FRESH-01/02/03, INV-ELIG-01,
INV-RECON-02, INV-TRAD-02/03/04/06, INV-UI-01/02/03/04, INV-MODE-01,
INV-DIVERGENCE-01, INV-WORKER-03. Nové **INV-MANUAL-01** (ruční vstup jen
přes worker na leadera, durable `operationId` + vlastní outbox, krátké TTL,
povinné SL+TP, strop qty leadera, brány denních pravidel, vazba na ARM
session a konfiguraci; nic zobrazovacího ho neautorizuje). Úprava
INV-UI-03 (čtečka deníku + `ticketMaySend` jako UX, autorita worker).

## 7. Testy

Fixture fáze 0; vlastní `sending`/`unknown` neblokuje replikaci; restart
v `sending`; prázdný lookup neodesílá; placeOso bez id nohou; asynchronní
Rejected; p-ticket/429 na POST = unknown; brány zvlášť (on-fill,
`maxContracts`, qty 0, `maxLeaderOrders`, okno/session/ARM expirace);
brzda a OFF→ON mezi enqueue a provedením; `set-multiplier` mezi náhledem
a provedením; souběžný příkaz z Tradovate UI; reconnect route; TTL ve FIFO;
dvě zařízení / jiný payload se stejným klíčem; validace payloadu; dvojklik;
regrese kopírování OSO z Tradovate UI.
