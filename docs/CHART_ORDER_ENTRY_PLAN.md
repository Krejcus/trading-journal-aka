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

Druhé kolo oponentury (b1f0811a): **OK**, podmínka před pushem = V12 E1
zeleně samostatně. Doplněno: ARMED test hlídá, že neproběhlo odmítnutí
`halt`; výsledek náhledu se při změně stavu kopírky maže (ne jen skryje).
Do fáze 1b přenést:
- zastaralá kotace grafu (`quoteInfo.stale`) musí náhled i odeslání zastavit;
- kontrakt brát jen ze zdroje `IBKR:` — konkrétní kontrakt z TradingView
  (`CME_MINI:MNQZ2026`) by jinak byl identifikátor z TV v příkazu (INV-UI-04);
- test souladu náhledu s kopírováním: náhled OK na fixture fáze 0 → kopírka
  zkopíruje stejné `followerQuantities`;
- test relay `assertPreviewAdmissible` proti falešné DB (dnes jen grep).

## 9. Fáze 1b — skutečné odeslání vstupu (návrh, 29. 10. 2026)

Cíl: z lístku poslat na LEADERA nativní OSO (Limit/Stop + SL + TP, 1 kontrakt),
které kopírka rozkopíruje followerům stávající cestou (OSO pár → nativní OSO
followera, ověřeno replay testem fáze 0). Prop účty běží na Tradovate „demo“
infrastruktuře, takže 1b a 1c splývají; strop zůstává `MANUAL_ENTRY_MAX_CONTRACTS = 1`.

**Protokol (bez migrace):** `place-leader-entry` = stejná pole jako náhled +
`payloadHash` (stableHash64 kanonického JSON všech polí kromě hashe),
`operationId` s prefixem `entry:` (náhled `preview:` se nikdy nesmí odeslat).
Relay: v `remoteCopyCommands`, striktní validace na enqueue i claim,
`idempotencyKey = operationId` (stejný klíč + jiný `payloadHash` = 409
`copier-relay-entry-conflict`), TTL 15 s, nejvýš jeden čekající/claimed vstup na
zařízení, min. 3 s odstup, denní strop 30 vstupů na uživatele; brzda
(`disarm`/`kill`/`lock`) čekající vstupy zneplatní stejně jako ARM
(`expirePendingArmsSupersededByBrake` rozšířit). Výsledek
`{ type: 'leader-entry-placed', operationId, status: 'blocked' | 'rejected' |
'acknowledged' | 'unknown' | 'abandoned', blockers, entryBrokerOrderId?,
stopBrokerOrderId?, targetBrokerOrderId?, reason? }`.

**Agent:** case `place-leader-entry`: brzda po `createdAt` = blocked (jako
náhled); jinak `controller.placeLeaderEntry(command, { expiresAt })`.
Starý worker: `unsupported-copy-command` → UI „worker odeslání neumí“.

**Controller `placeLeaderEntry` (jediná nová risk-zvyšující cesta, INV-MANUAL-01):**
1. Durable dedup: záznam se stejným `operationId` = vrátit jeho stav, nikdy
   znovu neposílat (ani po restartu). Jiný `payloadHash` = blocked.
2. Celé vyhodnocení i zápis běží v `eventTail` (sériová linka controlleru):
   události od brokera, které dorazí během POSTu, se zpracují až po commitu
   výsledku → kopírka vlastní OSO pozná podle ID deterministicky.
3. Uvnitř linky znovu `previewLeaderEntry` (stejné brány jako náhled, čerstvý
   stav) + navíc: `now + 2 s < expiresAt`, žádný ruční vstup v
   `sending`/`unknown`/`abandoned`, `gate.armed && !shadowMode`.
   Jakýkoli blocker = `blocked`, nic se nezapíše.
4. Durable záznam `manualEntries[]` v `safety` (CAS `persistSafety`) se stavem
   `sending`, tagem (`me` + 14 znaků), požadavkem a `payloadHash` PŘED POSTem
   (INV-OUTBOX-01). Po commitu znovu deadline a fence.
5. Zápis `dispatchBroker(generation).placeOso(...)` (fence safety generation,
   halt, shadow; zvyšuje `dispatchObservationVersion`). Jeden pokus, žádný retry.
6. Výsledek (commit do stejného záznamu):
   - ACK se všemi třemi id → `acknowledged` (id si controller drží i v paměti
     jako „vlastní ruční OSO“, po restartu z durable);
   - ACK s id vstupu bez id obou nohou → `abandoned` + incident (failClosed bez
     auto-close) + přesně cílený cancel vlastního vstupu leadera (jeden pokus,
     stav cancelu v záznamu; Tradovate se zrušením vstupu ruší i nohy);
   - definitivní odmítnutí bez jakéhokoli id → `rejected`;
   - timeout/chyba/nedefinitivní → `unknown` (bez retry). Kopírka zůstává
     ARMED (leaderovy eventy dál zrcadlí), ale `unknown` blokuje další ruční
     vstup a ARM (nový `kind: 'manual-entry'` ve stuck operacích, rozuzlení
     jen auditovaným waiverem `resolve-stuck-operation`).
7. Restart se záznamem v `sending` → `unknown` (nikdy znovu neposlat).

**Kopírka a vlastní OSO (P2):** ve `flushStandaloneOsoEntry` (vstup bez nohou
po korelačním okně) a v `oso-lone-leg`: je-li vstup vlastní ruční OSO
(`acknowledged` id), NIKDY se nekopíruje jako samostatný vstup → failClosed +
přesný cancel vlastního vstupu leadera. Totéž bez cancelu, je-li nějaký ruční
vstup `unknown` (nevíme, čí vstup to je). OSO pár se kopíruje beze změny.

**UI:** v lístku po čerstvém náhledu bez blockerů (< 15 s, stejný otisk
návrhu) tlačítko „Odeslat 1 kontrakt“ s potvrzením; stav „odesílá se“ →
„přijato brokerem“ / „odmítnuto“ / „výsledek neznámý — zkontroluj Tradovate“
(nikdy „neprovedeno“ bez důkazu). Zastaralá kotace grafu (`stale`) zastaví
náhled i odeslání; kontrakt jen ze zdroje `IBKR:` (ne z TradingView, INV-UI-04).

**Testy:** controller s mock brokerem — ARMED odeslání → follower OSO stejné
ceny/qty (soulad s náhledem na fixture fáze 0); dedup operationId (i po
restartu); `sending` při restartu = `unknown`; timeout = `unknown`, žádný retry;
ACK bez nohou = `abandoned` + incident + jeden cancel; odmítnutí = `rejected`
bez incidentu; vstup bez nohou po okně = žádná kopie + cancel; brzda mezi
zařazením a provedením; DISARMED/shadow = blocked bez zápisu; změna násobku
mezi náhledem a odesláním = blocked. Relay: validace, idempotence/konflikt,
TTL, zneplatnění brzdou, denní strop, `assertPreviewAdmissible` s falešnou DB.

**Fáze 0 doplnit (spouští Filip):** `record-leader-oso.ts --scenario fill`:
marketable Limit 1 MNQ se SL/TP, záznam přechodu nohou Suspended → Working,
pak `liquidateposition` leadera (zruší nohy) a ověření flat; `--connection`
pro Tradeify. Jen za DISARMED kopírky; po záznamu read-only reconcile.

**INV:** INV-MANUAL-01 (rozšířit o zápis), INV-OUTBOX-01/02, INV-RELAY-01/02/03,
INV-BRAKE-01/02/03, INV-ARM-01/04, INV-DEFAULT-01/02/03, INV-FRESH-01/02/03,
INV-RISK-01..04, INV-TRAD-02/03/04/06, INV-OUTBOX-03, INV-DIVERGENCE-01,
INV-RECON-02, INV-UI-01..04, INV-WORKER-04, INV-ELIG-01, INV-PART-01..03.

### 9.1 Revize po oponentuře (29. 10. 2026, verdikt OPRAVIT PŘED IMPLEMENTACÍ)

- **OSO okno (P1):** časovač samostatného vstupu se neodpálí, dokud ve frontě
  čekají nezpracované eventy leadera (odložení po 50 ms, nejvýš 5 s); platí pro
  všechna OSO (opravuje i dnešní slabinu TV/Tradovate UI). Vlastní ruční vstup
  (id z ACK, nebo ruční vstup v `sending`/`unknown`) se NIKDY nekopíruje jako
  samostatný: časovač ani fill před nohami ho neflushnou; čeká se na nohy
  (od začátku zpracování nejvýš 5 s), pak failClosed (`autoClose:false`) +
  cílený cancel vlastního nevyplněného vstupu.
- **Blokování linky (P2):** POST má vlastní timeout 5 s → `unknown` (pozdní
  výsledek se jen dopíše do záznamu); položka, která nezačne do 2 s od
  přijetí, je `blocked`. Vzdálená brzda tak čeká nejvýš ~7 s; zapsáno
  u INV-BRAKE-03, měří se ve společném testu.
- **TTL a loopback (P3):** relay předá `expiresAt` i pro ruční vstup; bez něj
  `blocked`. `place-leader-entry` z loopbacku se odmítá.
- **Fence (P4):** při vyhodnocení se zachytí čítače příchodu (trade verze
  účtů skupiny, `configurationControlVersion`, `connectionSyncGeneration`)
  a těsně před zápisem porovnají; neshoda = terminální `not-sent`.
- **Dvojí vstup (P5):** id z ACK se při commitu zapíšou do
  `liveOrdersByAccount` leadera → brána klidu skupiny blokuje další vstup,
  dokud stream příkazy neukončí. Relay hledá `operationId` per uživatel
  a po upsertu porovná `payloadHash`.
- **Brzda během POSTu (P7):** přijde-li ACK, když už kopírka není ARMED,
  vlastní vstup se hned cíleně zruší (followeři ho nedostanou).
- **Cancel (P8):** jen id z vlastního záznamu na účtu leadera, raw broker
  mimo `eventTail`, jeden pokus s durable stavem; smí i za DISARMED/kill
  (risk-redukční). Obě cesty (abandoned / chybějící nohy / brzda) sdílí jednu funkci.
- **Visící ruční vstup (P9):** vlastní predikát; blokuje jen ARM a další
  ruční vstup (ne dispatch, Flatten, brzdy, obnovu spojení). Rozuzlení
  `resolve-stuck-operation` s `kind: 'manual-entry'`, `key = operationId`.
- **Úložiště (P10):** `safety.manualEntries` (hluboký klon, funkční patch
  podle `operationId`, max 50 záznamů); bootstrap `sending` → `unknown`
  a uložit. Selhání commitu výsledku = vlastnictví zůstává v paměti + failClosed.
  Rollback workeru pod 1b jen s prázdnými/vyřešenými záznamy.
- **Mapování (P11):** všechna tři id → `acknowledged`; id vstupu bez nohou →
  `abandoned`; definitivní odmítnutí bez id → `rejected`; jinak `unknown`.
  429 na `placeoso` zapne hodinový jistič REST (vědomé riziko).
- **INV-MANUAL-01** rozšířit: zápis jen ve frontě controlleru s ohraničeným
  čekáním; `unknown` ponechá ARMED (výslovná odchylka od INV-DEFAULT-02:
  kopírka dál zrcadlí leadera, vlastní vstup bez nohou se nikdy nekopíruje).
- **Před prvním skutečným odesláním:** nahraný `--scenario fill` a jeho
  replay s asynchronním store (kopie, fill i nohy bez incidentu).

### 9.2 Stav implementace (29. 10. 2026)

Hotovo ve větvi `claude/chart-entry-1b-20261029`: relay (validace, idempotence,
TTL, brzda, rate limit, denní strop), agent (jen relay, platnost povinná,
capability `manual-entry-v1`), controller (`placeLeaderEntry`, durable
`safety.manualEntries`, fence, timeout, mapování výsledku, cílené zrušení,
waiver `manual-entry`, restart `sending` → `unknown`), pravidla OSO (odklad
časovače při čekajících eventech leadera, vlastní vstup nikdy bez nohou),
UI (Odeslat po čerstvém náhledu, stavy výsledku, zastaralá kotace a kontrakt
jen z IBKR zastaví náhled i odeslání), skript záznamu fillu.

**Společný test s Filipem (pořadí):**
1. `record-leader-oso.ts --scenario fill` na leaderu (Lucid) za DISARMED, pak
   reconcile; podle možnosti i Tradeify (`--non-group-account`). Replay záznamu
   do controlleru (Claude) před krokem 3d.
2. Nasazení (web + worker reinstall z čistého stavu).
3. 1 MNQ za ARMED:
   a) vzdálený Limit → Odeslat → follower dostane OSO stejných cen/qty →
      zrušit v Tradovate UI → vše zrušeno, bez `lastError`;
   b) DISARM z telefonu hned po Odeslat → změřit `RELAY EXECUTED durationMs`
      brzdy, ověřit zrušení vlastního vstupu a text UI;
   c) dvojklik / druhé zařízení → jen jeden vstup;
   d) až po replay fillu: vstup u trhu, vyplní se → followeři se SL/TP →
      výstup TP/SL nebo Flatten běžnou cestou;
   e) po každém kroku read-only reconcile čistý.


## 10. Fáze 2 — správa otevřeného obchodu z grafu + notifikace (návrh, 29. 10. 2026)

Cíl: z panelu u otevřené pozice / čekajícího vstupu leadera posunout SL nebo
TP (včetně SL na BE), zrušit čekající vstup (celé OSO) a zavřít pozici ZA
zapnuté kopírky tak, aby kopírka followerům provedla totéž běžnou cestou
(posun nohou = stávající zrcadlení modify, zrušení = lifecycle cancel, exit
= kopie leaderova market exitu — vše ověřeno naostro 29. 10., kroky A–D).
Funguje pro jakýkoli obchod leadera (z grafu, TradingView i Tradovate UI).

**Protokol:** jeden nový copy-command `manage-leader-order` { groupId,
operationId (`manage:`), leaderAccountId, symbol, action: `move-stop` |
`move-target` | `cancel-entry` | `close-position`, expect: { price, quantity }
(co uživatel viděl), newPrice (jen move-*), payloadHash }. Relay: whitelist,
validace na enqueue i claim, idempotence `operationId` per uživatel, TTL 15 s,
nejvýš jeden čekající na zařízení. Brzda čekající `move-*` zneplatní; `cancel-entry`
a `close-position` jsou risk-redukční a brzda je neruší.

**Worker najde příkaz sám** (UI id příkazů nezná) z živých příkazů a pozice
leadera na symbolu:
- `move-stop` / `move-target`: pozice ≠ 0, právě jeden pracující Stop
  (resp. Limit) na výstupní straně; víc / žádný = blocked `ambiguous`.
  `expect.price`/`quantity` musí sedět s aktuálním příkazem, jinak blocked
  `order-changed`. Nová cena na tick; SL musí zůstat na ochranné straně
  vstupu nebo BE (long: SL ≤ … ověří broker vůči trhu; worker kontroluje
  jen, že SL < TP u longu a SL > TP u shortu).
- `cancel-entry`: pozice = 0, právě jeden pracující vstup bez `parentOrderId`
  (nohy OSO se ruší s ním); jinak blocked.
- `close-position`: pozice ≠ 0 → `liquidatePosition` leadera (Tradovate zruší
  i nohy). Kopírka zkopíruje exit; nohy followerů zruší lifecycle.

**Brány:** běží ve frontě controlleru (jako ruční vstup) s fence fronty;
`move-*` jen ARMED (jinak by followeři neměli stejnou ochranu) a ne kill;
`close-position` jen ARMED a bez haltu (za DISARMED nabídne UI stávající
Flatten); `cancel-entry` i za DISARMED (lifecycle cancel followerů funguje
i vypnutě, ověřeno). Žádný ruční vstup v `sending`, žádná rozpracovaná
OSO korelace na symbolu.

**Zápis:** durable záznam `safety.manualOrderActions` (sending → acknowledged
| rejected | unknown | not-sent), jeden pokus, timeout 5 s, žádný retry.
`unknown` neblokuje ARM ani kopírku: skutečný stav příkazu leadera přijde
streamem a kopírka ho zrcadlí (odchylka od INV-OUTBOX-02 — záznam slouží jen
idempotenci a zobrazení); blokuje jen další správu téhož symbolu do 60 s.
`move-*` přes `dispatchBroker` (fence, halt); `cancel-entry` a `close-position`
raw (risk-redukční).

**UI (minimální, vzhled ladí Filip):** v lístku u pozice tlačítka „SL na BE“,
„Zavřít pozici (kopírka zavře kopie)“, pole pro nový SL / TP s odesláním;
u čekajícího vstupu „Zrušit vstup“. Vše dvoukrokové potvrzení, výsledek jako
u ručního vstupu.

**Notifikace:** watchdog (`evaluateCopierIncidents`, cron) z
`status.manualEntries` pošle push při změně stavu ručního vstupu na
`acknowledged` / `rejected` / `unknown` / `abandoned` (klíč
`manual-entry:<operationId>`, detail = stav; jen záznamy změněné za
posledních 10 min — žádný replay po nasazení). Čistě výstraha (INV-WATCH-01).

**Tradeify leader:** kód nemá omezení na Lucid; před prvním vstupem s leaderem
na Tradeify nahrát fixture (`record-leader-oso.ts --non-group-account`, oba
scénáře) a přehrát.

**INV:** INV-MANUAL-01 (rozšířit o správu), INV-BRAKE-01/02/03, INV-OUTBOX-01/02,
INV-RELAY-01/03, INV-FRESH-01, INV-MODE-02 (liquidate potvrzuje stav),
INV-DIVERGENCE-01, INV-WATCH-01, INV-UI-01..04.
