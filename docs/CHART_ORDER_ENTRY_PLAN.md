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
  dalšího nestaví. Nástroj: `scripts/copier/record-leader-oso.ts` (jen MNQ,
  Limit ≥ 1,5 % od trhu, TP na vzdálené straně, úklid neruší ochranu po
  fillu, záznam anonymizovaný mimo repo). První běh pokryje jen Lucid
  leadera a cestu zadání → zrušení; zbývá Tradeify, fill scénáře (nohy po
  fillu, částečný fill) a surová REST odpověď `placeoso` — fáze 0 se
  neprohlašuje za úplnou. Prvním krokem kódu je replay test controlleru
  z fixture (nativní API OSO za DISARMED → žádný zápis followerům, žádný
  `lastError`/`manualRecovery`, ARM až po reconcile).
- **Fáze 0 — první záznam (29. 10. 2026, Lucid leader, zadání → zrušení,
  fixture `tests/fixtures/tradovate-leader-oso-api-cancel.json`):**
  - ACK `placeoso` za ~140 ms s id všech tří příkazů.
  - Pořadí WS: vstup `order Created` (PendingNew) → SL noha `order Created`
    **s `parentId`** → vstup `Updated` s `linkedId` = SL → TP noha
    `order Created` **bez `parentId`**, jen `ocoId` = SL → SL `Updated`
    s `ocoId` = TP → obě nohy `Suspended` (command `OnHold`) → vstup
    `Working`. Vstup tedy přišel před nohami; normalizované eventy nohou
    ~95 ms po vstupu.
  - Korelátor: SL se spáruje přesně přes `parentOrderId`, TP jen
    odvozeně oknem (stejný účet/symbol/qty, opačná strana) — při dvou
    souběžných vstupech by TP byl `ambiguous`. Vlastní OSO jde poznat i bez
    `parentId`: každá entita nese `correlationClOrdId` = náš tag
    (`…`, `…s`, `…t`).
  - Zrušení vstupu: Tradovate sám zruší obě nohy (vlastní Cancel commandy),
    vše `Canceled` do ~25 ms.
  - Worker za DISARMED: vstup `blocked reason=disarmed`, nohy `skipped
    reason=mode-mismatch`, žádný incident ani `lastError`, WS workeru bez
    výpadku; read-only reconcile hned čistý.
  - Replay test `tests/copierLeaderApiOsoReplay.test.ts` (záznam přehraný
    do controlleru s mock brokerem): za DISARMED nic nezkopíruje, žádný
    incident, ARM po reconcile projde; za ARMED followerovi jedno nativní
    OSO se stejnými cenami (TP spárované oknem) a zrušení vstupu leadera
    zruší všechny tři příkazy followera, bez incidentu.
  - Zbývá: Tradeify připojení, fill (nohy Suspended → Working), částečný
    fill, surová REST odpověď.
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
  cílený cancel vlastního vstupu (schváleno Filipem 29. 10.).
- Restart v `sending`: nalezeno → adoptovat, nenalezeno → `unknown`.
  Rozuzlení `unknown`/`abandoned` = nový `kind` ve
  `STUCK_OPERATION_KINDS` + `waiveStuckOperation` (auditovaný waiver).
- UI: timeout / `claimed` po `expiresAt` = „výsledek neznámý“, nikdy
  „neprovedeno“.

### Kopírka a vlastní OSO (P2)

Controller pozná vlastní ruční OSO (tag `me`/id z ACK). Pro něj nikdy
nepošle followerům samostatný vstup: chybí-li po okně nohy, fail-closed +
přesný cancel vlastního vstupu leadera (schváleno Filipem 29. 10.). Testy podle
fixture z fáze 0: nohy před parentem (s `parentId` i bez), fill před
nohami, TP po > 1500 ms, částečný fill.

## 5. Rozhodnutí Filipa (29. 10. 2026)

1. **Fáze 0 na leaderovi**: OSO Limit daleko od trhu s okamžitým zrušením
   (ne samostatný sim účet). Příkaz zadává Filip sám spuštěním nahrávacího
   skriptu (`scripts/copier/record-leader-oso.ts`); skript běží jen při
   DISARMED kopírce — leaderův příkaz za DISARMED kopírka nereplikuje, jen
   zneplatní reconciliation → po záznamu read-only `reconcile` před ARM.
2. **Automatický cancel vlastního vstupu**: ANO — při neúplném OSO od
   brokera nebo když nohy nedorazí, worker přesně cíleně zruší vlastní
   vstup leadera (incident zůstane).
3. **Fáze 1 jen za ARMED** (ne shadow, vazba na `armedAt`).

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

## 8. Fáze 1a — náhled „would place“ (návrh, 29. 10. 2026)

Cíl: celá cesta lístek → relay → worker → brány naostro, ale **bez zápisu
k brokerovi**. Worker vrátí, co by poslal (leader + kopie followerů) a proč by
odmítl. Odeslat zůstává vypnuté.

**Protokol (bez migrace):** nový člen `LiveCopyTradingCommand`
`{ type: 'preview-leader-entry', groupId, operationId, leaderAccountId,
symbol, side: 'Buy'|'Sell', quantity, orderType: 'Limit'|'Stop', price,
stopLoss, takeProfit, intent: { armedAt, groupConfigHash,
followerQuantities: [{accountId, quantity}] } }` uvnitř `copy-command`
(DB constraint se nemění). Relay: přidat do `remoteCopyCommands`, striktní
whitelist klíčů ve `validatedRemoteCopyCommand` (enqueue i claim), ceny
konečné kladné na tick 0,25, qty celé 1–50, symbol `^(MNQ|NQ)[FGHJKMNQUVXZ]\d$`,
TTL standard 30 s. Výsledek nový člen `LiveCopyTradingCommandResult`
`{ type: 'leader-entry-preview', operationId, checkedAt, wouldPlace,
blockers: [{code, text}], notes: [{code, text}] }`.

**Agent:** nový case v `executeCopyCommand`; agent navíc přidá brzdový
blocker, když `createdAt ≤ lastBrakeCreatedAt + skew` (copy-command dnes
context nedostává → předat). Sériově přes FIFO jako ostatní ne-brzdy.

**Controller `previewLeaderEntry(input)`** — jen čtení, nikdy `dispatchBroker`
ani žádná zápisová metoda brokera (test spy). Jediné IO je čerstvé
`broker.listAccountCapabilities([leader])` (read-only, `canTrade`). Brány
(každá s kódem a textem, náhled vrátí VŠECHNY, ne jen první):
1. `haltReason` jako dispatch (gate + `sequenceBroken || needsReconciliation`,
   `stuckOutbox || hasDispatchBlockingStuckOutbox`), `shadowMode`,
   `reconciliationRequired`, `manualRecovery`/incident;
2. managementOnly, `dayLockPending`, `dayLockUntil > now`, pauza, obchodní
   okno ≠ inside; rezerva: do konce okna, do konce session 17:00 CT a do
   `armExpiresAt` aspoň 5 min;
3. klid skupiny: `maintenanceRestartBlocker()` == null, `allGroupAccountsFlat()`,
   `liveOrdersByAccount` prázdné u leadera i followerů, žádný aktivní cut,
   `transportResume`;
4. leader: `currentIneligibleAccounts` bez leadera, čerstvé `canTrade`;
   `accountRisk` leadera čerstvý (< 90 s, stejná session) a ztráta při SL ≤
   zbývající denní limit (`dailyLossAutoLiq + realized + open`, jinak
   `propLimitUsd`); jinak blocker;
5. followeři (zapojení, ne vyřazení): režim `on-submit` (jinak blocker
   `oso-on-fill-not-supported`), `followerQuantity` ≥ 1 (jinak blocker),
   `maxContracts` nejhorší případ z `positionsByAccount`+`liveOrdersByAccount`
   stejným vzorcem jako `exposureCappedBroker` (jinak blocker), riziko vs.
   jejich denní limit jako u leadera; nezpůsobilý/cut follower = poznámka
   „nedostane“ (stejně jako kopírka);
6. strop ručního vstupu `group.safety.manualEntryMaxContracts` (nové
   tighten-only pole; chybí = blocker „strop není nastaven“), qty ≤ strop;
7. SL i TP povinné, na správné straně vstupu; symbol = aktuální front
   (`quarterlyContractsAround`), jinak blocker;
8. záměr: `armedAt` = `gate.armedAt`, otisk konfigurace skupiny = aktuální,
   `followerQuantities` = přepočet; jinak blocker „nastavení se změnilo“.
`maxLeaderOrders` produkce nenastavuje → jen pokud je nastaven.

**UI:** v panelu tlačítko „Zkontrolovat u workeru (nic se neodešle)“ — jen
Limit/Stop se SL+TP a čerstvý stav; desk pošle přes `executeAgent`
(copy-command, fresh gate); panel ukáže „Worker by poslal: …“, kontrakty
followerů a seznam blockerů. Odeslat dál vypnuté.

**INV:** INV-DEFAULT-01/02, INV-ARM-01, INV-BRAKE-01/02/04, INV-RISK-01..04,
INV-RELAY-01/02/03, INV-FRESH-01..03, INV-ELIG-01, INV-PART-01..03,
INV-DIVERGENCE-01, INV-MODE-01, INV-TRAD-03/06, INV-UI-01..04,
INV-WORKER-04; návrh INV-MANUAL-01 (náhled nikdy nezapisuje — vynuceno
typem: metoda nemá přístup k `dispatchBroker`).
**Nasazení:** server (relay validace) + worker (agent, controller) → push
a reinstall workeru jen po „nasaď“ (obchodní den), DISARMED/flat.

### 8.1 Revize po oponentuře (29. 10. 2026, verdikt OPRAVIT PŘED IMPLEMENTACÍ)

- **Bez REST:** náhled nečte brokera (sériová linka relaye by zdržela vzdálené
  DISARM/kill a 429 by zapnulo hodinový jistič pro všechno). `canTrade`
  leadera v náhledu = poznámka „neověřeno, ověří odeslání“. Relay pustí
  nejvýš jeden čekající náhled na zařízení a nejvýš jeden za 3 s.
- **Čistý modul:** controller jen synchronně sebere zmrazené vstupy
  (`collectManualEntryPreviewInputs`), vyhodnocení je čistá funkce
  `services/manualEntryPreview.ts` bez importu brokera; žádný await na
  `eventTail`, žádný audit/persist/lastError, chyba náhledu nejde do failClosed.
- **Riziko:** zbývá = MIN ze známých: DLL + min(0, realized + open);
  equity − minNetLiq; u followera i `effectiveDailyLossCutUsd` − ztráta.
  Nic neznámé = blocker. Riziko = |vstup − SL| × qty × pointValue (podle
  kořene symbolu) + poplatky + skluz 2 ticky; pro rezervu DD konzervativně
  |TP − SL| (trailing intradenně neověřen). Snapshot < 90 s, stejná session
  a novější než poslední fill skupiny, jinak blocker. Vlastní
  `dailyLossLimitUsd` = poznámka.
- **Chybějící data = blocker** (účet bez záznamu pozic/příkazů není flat).
- **Doplněné brány:** `group.enabled`; per-request `evaluateRiskGate` nad
  stejnými třemi requesty jako `processOsoPair`; recovery/startup repair;
  `unconfirmedFlatLots`; cooldown; `positionCheckComplete`;
  `divergentAccounts`; pauza vs. `now`; prahy pravidel dne čistě ze stavu
  dne; rozpracovaný cut = blocker, hotový = poznámka; `transportResume`
  jen waiting/ready; sync pauza = poznámka „nedostane“; žádný follower by
  nedostal kopii = blocker `no-follower-would-copy`; `maxContracts` z cache
  + poznámka o fallbacku při rozpadu OSO korelace.
- **Strop ručního vstupu:** žádné nové pole; konstanta workeru 1 kontrakt
  (qty > 1 = blocker) do doby, než bude UI a perzistence.
- **Starý worker:** `executeCopyCommand` `default: throw unsupported`; UI bez
  výsledku typu `leader-entry-preview` = „worker náhled neumí“.
- **Symbol:** povolit oba kandidáty kolem rollu s poznámkou; měsíce jen
  `[HMUZ]`.
- **UI:** samostatná čtecí cesta bez mutation ACK fence; „Náhled (nic
  neodesláno) · ověřeno před X s“, po 15 s / změně ARM / DISARM zešedne;
  nikdy „připraveno“, Odeslat dál vypnuté; `operationId` s prefixem
  `preview:`; poznámka „marketabilita limitu neověřena“.
- **Otisk skupiny** jen z polí statusu workeru: id, enabled, leader,
  followeři (accountId, mode, enabled, multiplier, maxContracts).
- Dotčená INV navíc: INV-BRAKE-03, INV-TRAD-04, INV-WORKER-04, INV-RISK-04,
  INV-RECON-04, INV-ARM-01, INV-PART-02/03, INV-OUTBOX-02, INV-TRAD-02.

### 8.2 Stav implementace (29. 10. 2026)

Hotovo ve větvi `claude/chart-entry-1a-20261029`; diff oponentura OPRAVIT
PŘED COMMITEM → opraveno: behaviorální test controlleru (ARMED, mock broker:
nula volání brokera/commitů/auditů), testy agenta (neznámý příkaz, brzda po
zadání), kontrakt ze zdroje ceny grafu (`previewSymbolFromChartSource`,
kontinuální řada = náhled nejde), `copier-relay-preview-busy` = 409,
INV-MANUAL-01. Výhrady opravené: cut followera = přísnější z nastaveného
a efektivního, DLL ≤ 0 = nenastaveno, konec ARM null bez TTL, texty pravidel
dne („ruční vstup je přísnější“), stáří výsledku od přijetí a zahození při
změně stavu kopírky. Vědomě přijato: `lastGroupFillAt` jen z uzavřených
obchodů leadera (okno sekund, částečně kryje quiet window), konec okna jen
jako stav za 5 min, poplatky odhadem.
