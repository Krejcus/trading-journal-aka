# Výstupy z pozice: C2 částečné zavření, C3 víc TP, C4 otočení — návrh v1 (3. 11. 2026)

Podklad: `docs/reviews/trading-gaps-20261103.md` (★ částečné zavření, ★ víc TP, ★ reverse). Nasazený kód `7ae5c97b` (worktree `/Users/filipkrejca/alphatrade-worktrees/scale-in`, web) / `e37d7963` (worker). Vzor: `docs/reviews/scale-in-design-20261102.md` v5 (multi-ticket pozice, `scope: 'position'`, `scaleInAddBlockers`, `reviewPendingScaleIns`, `overCoverStep`, `preparePositionAction`).
Je to změna jádra kopírky (CLAUDE.md bod 4): návrh i hotový diff musí před commitem projít `copier-design-critic`. Ten zatím **nespuštěn**. Nic z toho není postavené ani ověřené u brokera.

## Shrnutí verdiktů

| Položka | Verdikt | Proč |
|---|---|---|
| C0 společný základ + `record-exits.ts` | STAVĚT | Opt-in, čistý modul, nové typy záznamů a nahrávací skript. Skript běží jen na DEMO a za DISARMED. |
| C2 částečné zavření | STAVĚT-PO-CONFORMANCE | Tradovate `modifyorder` s jiným `orderQty` u nohy OSO ani zrušení jedné nohy OCO nemáme zaznamenané. |
| C3 víc TP (TP1/TP2/TP3) | STAVĚT-PO-CONFORMANCE | Nezaznamenané: fill TP jednoho lístku zruší jen jeho SL, dva OSO z flat se souběžně vyplní, dva čekající Limit OSO z flat. |
| C4 otočení pozice | STAVĚT-PO-CONFORMANCE | Vstup z flat dnes čeká 5 s ticha po eventu leadera (`copierRuntimeController.ts:2008`, `:19651-19655`, `:19906`). Market ale vyžaduje kotaci klienta ≤ 5 s (`lib/leaderEntryPreview.ts:20`), takže otočený vstup by **vždy** skončil `market-quote-stale`. Zkrácení ticha jde jen na základě změřeného „ocasu“ eventů po `liquidateposition`. |

**Zamítnuté varianty** (každá s pravidlem, které ji blokuje):
- **Flip jedním Marketem 2N.** Staré nohy by po otočení zvětšovaly novou pozici, nebo by se musely zrušit předem. Nové nohy pak jdou až po fillu, takže vzniká okno opačné pozice bez ochrany (INV-OUTBOX-03 / INV-EXIT-01 níže).
- **Market redukce PŘED zmenšením nohou.** Nadkrytí → broker při SL otevře opačnou pozici (INV-EXIT-01).
- **Tradovate `startOrderStrategy` (ATM s víc TP).** Jiný lifecycle příkazů, kopírka ho nezná, nic není zaznamenané (INV-TRAD-02, pravidlo „nejdřív DEMO záznam“).
- **Zmenšení jednoho lístku přes „zruš nohy → Market → nové OCO“.** Má okno bez ochrany na celou zbylou pozici a při selhání `placeOco` i tvar, který by bylo nutné automaticky dostavět (INV-OUTBOX-03).

---

## 0. Společný základ (C0)

### 0.1 Rozsah a opt-in
- Jen manual-only local-only DEMO skupina bez followerů, která už má `--scale-in on` (`services/manualScaleIn.ts:19-26`, `scaleInEnabled` vyžaduje `brokerEnvironment === 'demo'`, takže real-money LIVE je vyloučené kódem).
- K tomu nový instalační opt-in `--exits on`:
  - `scripts/copier/mac-install.ts` → `pilot.ts` → `options.manualExits`;
  - `mac-reinstall-safe.sh` ho musí přenášet stejně jako `--scale-in`;
  - v controlleru `exitsOn() = scaleInOn() && options.manualExits === true`.
- Jen MNQ (`LEADER_ENTRY_SYMBOL_PATTERN`).
- Followeři a běžné skupiny se nemění: vstup dál končí `account-not-flat`, správa pozice `scale-in-off`. Fáze 2 (followeři) = samostatný návrh. Musel by řešit floor násobku, nekopírování změny qty nohou (past 27. 8., INV-TRAD-02) a INV-DIVERGENCE-01.
- Capability inzeruje agent jen při `exitsOn()` (`server/localCopierExecutionAgent.ts:405-416`, vedle scale-in) a definuje je `lib/copierWorkerCapabilities.ts`:
  - `manual-position-reduce-v1` (C2);
  - `manual-entry-split-targets-v1` (C3);
  - `manual-entry-reverse-v1` (C4).
- UI bez capability nic nového neposílá.

### 0.2 Princip výstupu: nikdy nadkrytí (návrh nového INV-EXIT-01)

Pro vlastní pozici leadera na symbolu musí v každém okamžiku platit:

`Σ_lístky max(zbytek SL_i, zbytek TP_i) + rozpracovaná Market redukce ≤ |net|`

`max` proto, že OCO pár lístku vyplní nejvýš jednu nohu.

- **Nadkrytí** (ochrana kryje víc kontraktů, než má pozice): spuštěný SL/TP prodá víc, než leader drží. Broker tím sám otevře opačnou pozici bez ochrany, tedy novou expozici, kterou nikdo nezadal. Proto je zakázané.
- **Podkrytí** (část pozice bez SL): novou expozici nevytváří, je vidět (`stopCovered < |net|`) a po selhání končí incidentem.
- **Pořadí C2:** (1) zmenšit nebo zrušit nohy dotčených lístků a počkat na potvrzení streamem, (2) teprve pak Market redukce.
  - Po kroku 1 je Σ nohou = P − N. Market N tedy dá Σ = P.
  - Když se během POSTu Marketu spustí SL, prodá P − N, Market prodá N, výsledek je flat a nikdy se nepřejde přes nulu.
  - Opačné pořadí má okno Σ = P + N. Při SL by se pozice otočila na −N.
- `overCoverStep` (`manualScaleIn.ts:427-439`) zůstává jako záloha. Během C2 nadkrytí nevznikne; `transient` je pravda díky `manualOrderActionJobs.size > 0` (`copierRuntimeController.ts:3779`).
- Podkrytí po selhání mezi kroky vyhlásí **sama operace** (deterministický incident). Obecný hlídač by ho u celého zrušeného lístku neviděl, protože tam `ownOpen ≠ |net|`.
- **Zvažovaná a odložená varianta „C2-T“:** u celého lístku převést TP nohu na Market nebo marketable limit, OCO pak u brokera samo zruší SL a okno podkrytí nevznikne. Odklad, protože:
  - je to výjimka z INV-MANUAL-01 2c („move-target k trhu dál blokovaný“);
  - marketable limit potřebuje IBKR;
  - změna typu nohy Limit→Market není zaznamenaná.

  Nahrávka C0 ji změří. Případná náhrada B = samostatné rozhodnutí + critic.

### 0.3 Model pozice (čistý, `services/manualScaleIn.ts`)
- **`ScaleInRecord`/`ScaleInTicket`** dostanou:
  - `reduced` (z nového durable `CopierManualEntryRecord.reducedQuantity`);
  - `splitOf` (C3).
- **`ownOpen`** (`:203`) = fill vstupu − filly nohou − `reduced`. **`coverCap`** (`:167`) u neživého vstupu = qty − `reduced`. Bez toho by po zmenšení jednoho lístku platilo `ownOpen ≠ |net|` a celá další správa by skončila „kontrakty mimo lístky“ (`:385`).
- **`targetLevels`**: `Array<{ price, quantity, ticketEntryIds }>`, seřazené od vstupu (TP1 = nejblíž). Posun SL dál vyžaduje `stopUniform`.
- **`pendingAdds`** (`:192`) = přikoupení s čekajícím vstupem NEBO sourozenec rozděleného vstupu (C3), jehož některý sourozenec už má fill.
- **Nový čistý modul `services/manualPositionExits.ts`** (bez IO, bez importu brokera):
  - `defaultReduceSelection`, `reduceSelectionIssues`, `planPositionReduce`;
  - `reducingNeverExceedsNet` (aserce INV-EXIT-01 nad plánem), `classifyReduceOutcome`;
  - `splitTargetIssues`, `reverseBlockers`, `reverseQuietSatisfied`.

  `defaultReduceSelection` sdílí UI i worker přes lib re-export.

### 0.4 Durable záznamy, restart, waiver
- **`CopierManualOrderActionRecord.action`** (`services/copierEngine.ts:399`) rozšířit o `'reduce-leg-cancel' | 'reduce-leg-resize' | 'reduce-market'`. Nová pole `fromQuantity?`, `toQuantity?`, `parentOperationId?`, `reverseEntryOperationId?`.
- **Id záznamů:**
  - nohy `${manage:…}~r<n>`, Market `${manage:…}~m`;
  - waiver větev `operationId.startsWith('manage:')` (`:20070`) funguje beze změny.
- **`CopierManualEntryRecord`** (`:340`) dostane `reducedQuantity?`, `split?: { parent, index, of }` a `reverseOf?`.
- **`services/copierStore.ts`** klonuje nová pole (`:194-199`). Test: worker po downgradu nový druh `action` nezná. Záznam `sending|unknown` neznámého druhu proto musí zůstat ARM-blocking a nesmí zmizet.
- **Restart** (`copierRuntimeController.ts:19494-19523`, vzor `restartedAttach`/`restartedScaleIn`):
  - `sending` reduce-* → `unknown` + trvalý incident (`recordWhenDisarmed: true`);
  - dítě rozděleného vstupu v `sending` → `unknown` + incident, i u Limit/Stop, protože sourozence bez id hlídání čekajících nevidí;
  - otočení: běh na pozadí se po restartu nikdy nedokončí, jen audit „otočení nedokončeno, pozice zůstala zavřená“.
- **`resolveManualOrderActionByLookup`** (`:4402`): reduce-* se automaticky nedořešuje (jako `attach-brackets`, `:4405`). Následuje incident a pak auditovaný waiver (`resolve-stuck-operation`, `:20067-20083`).

### 0.5 Relay a admission — bez migrace

**C2 jde jako `manage-leader-order`** s `action: 'close-position'`, `scope: 'position'` a novými poli `closeQuantity` a `closeTicketIds`.

Proč ne nová akce `reduce-position` — dnešní chování by pro ni neplatilo bez nové migrace (`CREATE OR REPLACE` dvou RPC):
- Supersede brzdou umí jen `move-stop | move-target | close-position`: RPC `enqueue_tradovate_copier_brake` (`supabase/migrations/20261101090849_copier_manual_admission.sql:333-335`) a záložní cesta relaye (`server/tradovateCopierCommandRelay.ts:975-983`).
- Výjimku z denního stropu má jen `close-position` (`…admission.sql:182`).
- TTL 5 s platí jen pro `isLeaderTradeClose` (`tradovateCopierCommandRelay.ts:117-121`).

Bezpečnost rolloutu: nová pole projdou sdílenou striktní validací (whitelist v `lib/leaderOrderManage.ts:63`). Starý relay i starý worker neznámý klíč odmítnou (`invalid-relay-command-payload`), nikdy ho tedy nevyloží jako plné zavření.

Další příkazy:
- **C3** = `place-leader-entry` s `targets` (bez `takeProfit`).
- **C4** = `place-leader-entry` s `position.mode: 'reverse'`.
- **Admission vstupu** se nemění (busy, rozestup 3 s, 100 za 24 h, supersede brzdou).
- **Zrušení rozděleného čekajícího vstupu** = `cancel-entry` + `scope: 'split'`. Je risk-redukční, takže výjimka z brzdy v admission (`:128`) platí.
- **Agent `brake-after-request`** (`server/localCopierExecutionAgent.ts:971`) platí beze změny pro `close-position` (C2) i pro vstupy (C3, C4).

### 0.6 DEMO conformance — `scripts/copier/record-exits.ts` + čistý `recordExitsPlan.ts`

Vzor `record-scale-in.ts` / `recordScaleInPlan.ts`. Pojistky před startem:
- jen DEMO8661118 a MNQZ6;
- worker DISARMED, skupina manual-only bez followerů;
- leader flat bez příkazů, čerstvá cena workeru;
- SL/TP ≥ 40 b, povinné `--confirm`.

Výstupy: záznam mimo repo a anonymizovaný fixture v `tests/fixtures/`. Konec musí být flat bez příkazů ověřený přes REST (exit 0/4/1). Po záznamu read-only `npm run copier:mac -- reconcile`.

| Scénář | Kroky | Co rozhodne |
|---|---|---|
| `resize` | Market OSO 3. Souběžně `modifyorder` SL 3→2 a TP 3→2 (ceny beze změny). Po potvrzení obou `placeorder` Market Sell 1. Pak liquidate. | Přijme Tradovate jiné `orderQty` u nohy OSO? Změní sám partnera OCO? Projde predikát adaptéru (Replaced s novou qty, `tradovateBroker.ts:2198-2205`)? Nechá Market redukce nohy beze změny? |
| `ticket-cancel` | 2× Market OSO 1 (2 lístky). `cancelorder` jen SL lístku 2 → co se stane s TP lístku 2. Pak zbytek. Market Sell 1. Liquidate. | Zruší zrušení jedné nohy OCO i partnera? Co vrátí cancel už zrušeného příkazu (`assertCommandAccepted`, `:2175`)? |
| `tp-fill` | 2× Market OSO 1 souběžně se stejným SL, TP1 +40 b a TP2 +60 b. TP1 posunout na marketable (bid − 2 b). V běhu `--tp-market` zkusit `orderType: 'Market'`. | Zruší fill TP1 jen SL1 a za jak dlouho? Zůstanou SL2/TP2 beze změny a pozice 1? Přijme broker změnu typu nohy (podklad pro C2-T)? |
| `split-limit` | 2× Limit OSO z flat, stejná cena ≥ 1,5 % od trhu, qty 1, různé TP. Zrušit vstup 1, pak vstup 2. | Jsou dva OSO z flat nezávislé? Ruší kaskáda jen vlastní pozastavené nohy? |
| `reverse` `--repeat 5` (i se 2 lístky) | Market OSO → liquidate → zapisovat eventy leadera až do 6 s ticha. Pak REST flat a Market OSO opačně po mezeře X ms. | Jak dlouhý je „ocas“ eventů po liquidate? Dnešní fixtury mají poslední event za +0,79 s (`tradovate-leader-scale-in.json`) a +0,67 s (`tradovate-leader-oso-api-fill.json`), druhý z nich bez Position eventu. Nesmí přijít žádný event zavření po prvním eventu nového vstupu. |
| `stop-hit` (volitelný, nedeterministický) | 2 lístky, SL 10 ticků od trhu, čekat ≤ 120 s. | Vyplní se oba SL a zruší oba TP? |

Odhad nákladů na DEMO: jednotky až nízké desítky USD + poplatky.

### 0.7 Pořadí stavby
1. C0.
2. C3 jen správa úrovní TP: posun SL všech lístků a posun jedné úrovně TP. Je malá, nepřidává nový druh zápisu (dál jen `modifyOrder` cen).
3. C2.
4. C3 vstup.
5. C4.

Každý krok: critic návrhu → diff → critic diffu → DEMO z appky → teprve „nasaď“.

---

## C2 — Částečné zavření pozice o N kontraktů

### 1. Verdikt
**STAVĚT-PO-CONFORMANCE.** Před stavbou musí proběhnout scénáře `resize` a `ticket-cancel`.

Větve podle výsledku záznamu:
- **Tradovate změnu `orderQty` u nohy OSO odmítne**, nebo ji provede nekonzistentně (partner OCO se nezmění, ale broker hlásí jinou qty) → C2 v1 se zúží na celé lístky (pozice z přikoupení nebo z C3). Zmenšení jednoho lístku se nestaví (viz zamítnuté varianty).
- **Tradovate sám přepočítá partnera OCO** → plán mění jen jednu nohu a druhou potvrzuje streamem.
- **Zrušení jedné nohy OCO zruší i partnera** → u celého lístku se ruší jen SL a čeká se na `canceled` TP.

### 2. Chování (PC a telefon)
- **PC:**
  - Štítek pozice v grafu dostane akci „−1“ (dvoukrokově, jako BE).
  - Kontextová nabídka štítku „Zavřít část…“: stepper 1…|net|−1 a náhled dotčených lístků, např. „zavře lístek TP1 (1 ks), zmenší TP2 o 1“.
  - U pozice s víc úrovněmi TP má každá čára TP „×“ = „Vybrat teď (Market)“ (dvoukrokově) = zavřít lístky té úrovně.
  - Plné zavření zůstává dnešní × (liquidate, jedním klikem).
- **Telefon:**
  - V listu pozice (`components/day/LivePhoneTrade.tsx`) pilulky „Zmenšit 1 / 2 / …“.
  - × na čáře TP = vybrat teď.
  - Vše dvoukrokově, jako ostatní × na telefonu.
  - Nouzová cesta se nemění (LIVE ▾ → Live Dashboard).
- **Výsledek (toast):**
  - „Zmenšeno o N · pozice X · SL/TP kryjí X“;
  - „Neodesláno: …“ (nic se nezměnilo);
  - při selhání sticky toast „Pozice X, SL kryje jen Y — zavři zbytek (×) nebo Flatten“.
- **Kdy UI akci nenabídne** (důvod z `leaderPositions[].reduceBlockedReason`, jen zobrazení):
  - DISARMED, shadow, kill;
  - čekající přikoupení, rozjeté SL, cizí příkaz.

### 3. Mechanismus

**Příkaz** `manage-leader-order`:
```
{ action: 'close-position', scope: 'position',
  entryOperationId: <nejstarší lístek>,
  expect: { price: SL pozice, quantity: |net| },
  closeQuantity: N, closeTicketIds: [entryId…] }
```
- **Validace** (`lib/leaderOrderManage.ts`, rozšířit `KEYS` `:63` a `:108-109`):
  - obě pole, nebo žádné; jen s `close-position` + `scope: 'position'` + vlastní vstup;
  - `1 ≤ N < expect.quantity`; id unikátní a ve tvaru `LEADER_ORDER_ID_PATTERN`.
- **Výběr lístků** `defaultReduceSelection(model, N)`:
  - nejbližší úroveň TP první, v rámci úrovně nejnovější lístek;
  - všechny lístky kromě posledního se zavřou celé, poslední se smí zmenšit;
  - worker přijme jen platný výběr (`reduceSelectionIssues`) a při jakékoli neshodě s čerstvým modelem vrátí `intent-position-changed`.

**Worker, ve frontě** — `prepareManualOrderAction` (`:5061`) → `preparePositionAction` (`:4804`) → při `closeQuantity != null` nová `preparePositionReduce`:
- **Mutex.** Zmenšení NENÍ výjimka z mutexu ani z „nevyřešené změny“. Dnes `:4817` a `:4820` pouští `close-position` vždy; podmínka se změní na `action === 'close-position' && closeQuantity == null`.
- **Předčtení** ze snímku streamu (`:4831-4857`, `streamSnapshotMatchesLive`), jinak ohraničený REST. Pak `manualEntryQueueFence` a model.
- **`reduceBlockers`:**
  - `exitsOn()`; `net` ověřený, ≠ 0;
  - `expect` sedí; výběr platný;
  - všechny vstupy `filled`; žádné čekající přikoupení ani sourozenec;
  - `ownOpen === |net|`; žádný cizí příkaz;
  - nohy `working`, bez fillu, potvrzené streamem (ne `manual-entry-ack`);
  - `stopCovered === targetCovered === |net|`; `stopUniform` (TP smí být rozjeté — C3);
  - žádná nevyřešená ruční operace na symbolu;
  - ARMED ∧ ¬shadow ∧ ¬kill; neběží Flatten.
- Pak `closeReachBlockers` (`:4214`, kotva jako `:4877-4881`).
- **Plán** `planPositionReduce` + `reducingNeverExceedsNet` (při porušení výjimka = bug, nic neodejde).
- **Durable `sending`** všech zápisů nohou jedním zápisem (`persistManualOrderActions`, `:4149`).

**Worker, mimo frontu** — `runPositionReduce` (vzor `runPositionMove`, `:4972-5059`):
1. **Synchronní kontrola 1:**
   - deadline (TTL 5 s platí jen pro ZAHÁJENÍ; po kroku 1 se operace dokončuje, jinak by si sama způsobila podkrytí);
   - fence, generace, route epoch (`:4989-4991`);
   - tvar každé dotčené nohy z cache (stejná qty, bez fillu, stará cena).
2. **Krok 1, souběžně přes `dispatchBroker(generation)`** (fence generace i `haltReason` před každým raw zápisem, `:1890-1921`):
   - celé lístky: `cancelOrder` SL i TP;
   - zmenšovaný lístek: `modifyOrder` SL a TP `{ quantity: q − n, orderType, stejná cena }`.

   Timeout 3 s. Potvrzení:
   - cancel = stav `canceled` (adaptér čeká, `:2177-2185`). Chyba + čtení `canceled` = OK (větev `ticket-cancel`). `filled` = SL/TP se mezitím spustil.
   - resize = `stream-replaced` s novou qty (`:2198-2206`), jinak ohraničené `findOrderById`.
3. **Jen když jsou VŠECHNY změny potvrzené:**
   - čekat ≤ 1 s, až controller dožene stream (ingress leadera 0, nohy v očekávaném stavu v `liveOrdersByAccount`);
   - **synchronní kontrola 2:** ARMED ∧ ¬shadow ∧ ¬kill, generace, `runningEmergencyFlattens === 0`, žádný jiný zápis na leaderovi, net ze streamu = P, nedotčené nohy beze změny.
4. **Krok 2 — Market redukce:**
   - durable záznam `~m` ve stavu `sending`;
   - `registerInFlightBrokerWrite` (Flatten leadera vynechá a ohlásí nejasný zápis, takže nevznikne liquidate + Market = flip; precedent `:4280`);
   - `dispatchBroker(generation).placeOrder({ tag: 'mred…', side: výstup, quantity: N, orderType: 'Market' })`;
   - timeout 5 s, **nikdy opakování**.
5. **Ověření stavem** (jako `executeClose`, `:4317-4345`): stream ≤ 2 s, pak REST přes nové `readLeaderSymbolLegs` = rozšíření `readLeaderSymbolState` (`:4235`) o qty pracujících nohou.
6. **`classifyReduceOutcome`:**
   - P − N a nohy přesně podle plánu → `acknowledged`; zmenšenému lístku durable `reducedQuantity += n` (`persistManualEntry`).
   - Krok 1 celý odmítnutý, nic se nezměnilo → `rejected`, bez incidentu.
   - Flat (SL se spustil během kroku 2: P − N + N) → `waived` („pozici zavřel SL“), bez incidentu.
   - Cokoli jiného → `unknown` + `failClosed(…, { autoClose: false })` s textem, kolik kontraktů je bez SL. Patří sem: část nohou změněná, Market neodešel / odmítnut / neznámý, P s nohami P − N, znaménko přes nulu. Nic se automaticky nedorovnává ani nevrací.
7. `scheduleScaleInReview()` (hlídač krytí).

**Status** `leaderPositions[]` (`:21116-21146`): přidat `targetLevels`, `ticketDetails` (`{ entryOperationId, entryId, quantity, open, stopPrice, targetPrice }`), `canReduce` a `reduceBlockedReason`. Jen zobrazení.

**UI:**
- `lib/liveChartOrderLines.ts:67-129`: akce štítku a × na úrovních TP.
- `components/TradovateLiveDesk.tsx:1094-1137`: `manageLeaderEntry` dostane variantu `reducePosition(N, ids)`.
- Kontextová nabídka v `components/LiveTradingScreen.tsx`.
- Telefon: `components/day/LivePhoneTrade.tsx`, `LivePhoneOrderLines.tsx`, `lib/livePhoneOrders.ts`.

**Relay:** bez změny kódu. **Migrace:** ne (§0.5).

### 4. Dotčené INV a jak se drží

| INV | Jak |
|---|---|
| INV-EXIT-01 (nový, text níže) | Pořadí „nohy → potvrzení → Market“; aserce v plánu; property test. |
| INV-MANUAL-01 | Jen přes relay a worker na leadera; nic zobrazovacího neautorizuje; nová podsekce „Zmenšení pozice“. |
| INV-OUTBOX-01 | Durable `sending` před krokem 1 (všechny nohy jedním zápisem) i před Marketem (`~m`); žádný blind retry. |
| INV-OUTBOX-02 | Nové druhy jsou ARM-blocking; restart: `sending` → `unknown` + incident. |
| INV-OUTBOX-03 | Částečný výsledek kroku 1 se nedostavuje ani nevrací. |
| INV-DEFAULT-02/03 | Podkrytí, neznámý výsledek → incident bez auto-close, přežije restart, smaže ho jen potvrzení. |
| INV-FRESH-01 | Generace a fence před každým raw zápisem (`dispatchBroker`); route epoch při předčtení ze streamu. |
| INV-TRAD-02 | Změna qty je náš replace s očekávanou `toQuantity` potvrzenou streamem; venue-managed qty (dílčí fill nohy) = blocker. |
| INV-TRAD-03 | Tag `mred<op>` je jen korelace. |
| INV-TRAD-04 | ≤ 2k + 1 zápisů; 429 → `unknown` + incident, žádný retry. |
| INV-MODE-02 | Výsledek jen ze stavu u brokera, ne z ACK. |
| INV-BRAKE-01/02 | Žádná nová výjimka. Brzda mezi kroky → Market neodejde → podkrytí = incident (vědomě; okno ~200 ms). |
| INV-BRAKE-03 | Relay linka je obsazená nejvýš ~13 s (3 + 1 + 5 + ~4), jako dnešní `close-position`. Lokální brzdy jdou mimo FIFO. Text doplnit. |
| INV-BRAKE-05 | Expirace ARM během Marketu: Flatten leadera vynechá (precedent zavření z grafu). |
| INV-RELAY-01/03 | `operationId` idempotence; supersede brzdou a TTL 5 s díky akci `close-position`. |
| INV-RECON-04 | Podkrytí nebo nevyřešené zmenšení → `declineTransportResume` (jako nadkrytí `:3791`); `protectiveHoldProblem` stejně odmítne. |
| INV-ARM-01/04 | Neznámý výsledek blokuje ARM; v shadow `dispatchBroker` vždy odmítne. |
| INV-RISK-01/02 | Strop se nezvětšuje. Ztráta realizovaná zmenšením jde do ledgeru a day lock čeká na flat beze změny. |
| INV-DIVERGENCE-01 | Žádný dorovnávací obchod (ve fázi 2 platí plně). |
| INV-UI-01..03 | `leaderPositions` a výběr jsou jen záměr; worker ověří vše znovu. |
| INV-UI-04 | Market redukce cenu nepotřebuje, IBKR se nečte. |
| INV-WORKER-02 | Mutex pozice jen v procesu (beze změny). |

**Návrh textu INV-EXIT-01:** „Redukce vlastní pozice leadera z appky nikdy nepřekročí pozici.

- Pro pozici z lístků platí v každém okamžiku `Σ max(zbytek SL, zbytek TP) + rozpracovaná Market redukce ≤ |net|`.
- Změny ochranných nohou (resize/cancel) se potvrdí streamem PŘED odesláním Market redukce.
- Market redukce neodejde, když:
  - některá změna nohy není potvrzená;
  - pozice ze streamu ≠ P;
  - kopírka není ARMED;
  - běží Flatten nebo jiný zápis.
- Podkrytí po selhání mezi kroky = incident bez auto-close; nikdy automatické vrácení qty, opakování Marketu ani dorovnání.

Vynucuje `services/manualPositionExits.ts:planPositionReduce`, `reducingNeverExceedsNet` a `services/copierRuntimeController.ts:runPositionReduce`. Hlídá `tests/manualPositionReduce.test.ts`.“

### 5. Selhání a fail-closed

| Situace | Výsledek |
|---|---|
| Restart během kroku 1 nebo 2 | `sending` → `unknown` + trvalý incident; žádné dokončení ani návrat. |
| Část kroku 1 potvrzená, část odmítnutá nebo neznámá | Market neodejde. Stav (např. SL P−N, TP P) = incident „N bez SL“. Ven: × celé pozice (liquidate projde, `positionManageBlockers('close-position')` krytí nekontroluje), Flatten nebo Tradovate. |
| Celý krok 1 odmítnut | `rejected`, nic se nezměnilo. |
| SL/TP se spustí během kroku 1 | Kontrola 2 selže (net ≠ P) → `not-sent` Marketu. Je-li flat → `waived`, jinak incident. |
| SL se spustí během POSTu Marketu | P − N + N = flat → `waived`; nikdy flip. |
| Market odmítnut nebo timeout | Ověření stavem: P − N = OK (pozdní fill), P = incident podkrytí; nikdy opakování. |
| DISARM/kill mezi kroky | `dispatchBroker` hodí `CopierDispatchRevokedError` / kontrola 2 → Market neodejde → incident. |
| Flatten během Marketu | Leader je registrovaný zápis → Flatten ho vynechá a hlásí „nejasný“; uživatel klikne znovu. |
| Zastaralý stream | Snímek `null` → REST; route epoch změněná → `not-sent`; potvrzení jen Replaced s qty, nebo autoritativní čtení. |
| Souběžný ruční obchod v Tradovate | Mimo model (stejně jako u liquidate); ověření stavem odhalí znaménko nebo qty → incident. |

### 6. DEMO conformance
- Scénáře `resize` a `ticket-cancel` (případně `tp-fill` pro C2-T).
- Po nasazení z appky na DEMO:
  - −1 z pozice 3 v jednom lístku (PC);
  - „Vybrat TP1 teď“ u pozice ze 2 lístků (telefon);
  - × celé pozice po zmenšení;
  - posun SL po zmenšení (model s `reducedQuantity`).

### 7. Testy (M = mutačně ověřit)
`tests/manualPositionReduce.test.ts` (čistá logika + controller s mock brokerem) a `tests/manualPositionReduceReplay.test.ts` (fixture `tradovate-leader-reduce.json`):
1. (M) **Pořadí:** časová osa volání mocku; Market nikdy před potvrzením všech zápisů nohou. Mutace „Market souběžně“ musí test shodit.
2. (M) **Jedna noha odmítnutá:** žádný Market, `unknown` + incident. Mutace „pokračovat při ≥ 1 potvrzené noze“ padá.
3. **Noha `unknown`** (timeout) → žádný Market.
4. **SL vyplněný během kroku 1** → kontrola 2 selže, správný výsledek.
5. (M) **Brzda mezi kroky** → Market neodejde, incident s textem o podkrytí.
6. (M) **Market timeout** → `placeOrder` zavolán právě 1×, incident.
7. **SL během POSTu Marketu** → flat → `waived` bez incidentu.
8. (M) **Úspěch:** `reducedQuantity` je durable a následný `move-stop` celé pozice projde. Mutace bez `reduced` → blocker `shape`.
9. **Restart** s reduce-* v `sending` → `unknown` + trvalý incident.
10. (M) **Mutex:** běžící posun → `busy`; nevyřešená změna → `manage-unresolved`. Dnešní výjimka pro `close-position` je nesmí pustit.
11. **Validace lib:**
    - `N ≥ |net|` neplatné;
    - nová pole bez `scope` neplatná;
    - starý validátor nová pole odmítne (kompatibilita).
12. (M) **Property test** `reducingNeverExceedsNet` přes náhodné modely a výběry.
13. **Replay fixture** bez falešného incidentu nad- i podkrytí.
14. **Flatten během Marketu** → žádná dvojitá likvidace.
15. **UI:** `defaultReduceSelection` stejná v UI i workeru; dvoukrokovost na telefonu.

### 8. Soubory
`lib/leaderOrderManage.ts`, `services/manualPositionExits.ts` (nový), `services/manualScaleIn.ts`, `services/copierEngine.ts`, `services/copierStore.ts`, `services/copierRuntimeController.ts` (`preparePositionAction`, `preparePositionReduce`, `runPositionReduce`, `readLeaderSymbolLegs`, restart, status), `lib/liveChartOrderLines.ts`, `lib/liveScaleIn.ts`, `components/TradovateLiveDesk.tsx`, `components/LiveTradingScreen.tsx`, `components/day/LivePhoneTrade.tsx`, `components/day/LivePhoneOrderLines.tsx`, `lib/livePhoneOrders.ts`, `docs/COPIER_INVARIANTS.md`, testy a fixture.

### 9. Velikost a závislosti
**L.** Závisí na C0 (opt-in, typy záznamů, `record-exits` `resize`/`ticket-cancel`) a na nasazeném přikoupení (`e37d7963`). „Vybrat TP teď“ potřebuje úrovně z C3, jinak jde jen podle počtu.

---

## C3 — Víc TP / rozdělený výstup (TP1 + TP2 + TP3)

### 1. Verdikt
**STAVĚT-PO-CONFORMANCE.** Před stavbou musí proběhnout `tp-fill` a `split-limit` (volitelně `stop-hit`).

Kdy C3 nestavět:
- fill TP jednoho lístku nezruší jeho SL do ~1 s;
- nebo zasáhne cizí lístek.

Za takového chování by každý TP1 vytvořil nadkrytí, a tedy riziko flipu.

Rozsah v1:
- vstup Market (2–3 lístky, Σ ≤ strop 5);
- Limit/Stop jen po 1 kontraktu na lístek, tedy nejvýš 3 (dílčí fill OSO s qty > 1 je neověřený, stejné pravidlo jako u přikoupení);
- přikoupení do pozice s víc TP blokované;
- otočení s `targets` až po C4.

### 2. Chování (PC a telefon)
- **PC panel objednávky** (`components/LiveOrderTicket.tsx`):
  - přepínač „Rozdělit výstup“ → řádky TP1 / TP2 (/ TP3) s počtem kontraktů a cenou v dnešních jednotkách (b / ticky / $);
  - výchozí rozdělení podle qty: 2 = 1+1, 3 = 1+1+1 (u Marketu i 2+1);
  - návrh v grafu kreslí táhnutelné čáry TP1 a TP2;
  - náhled ukáže riziko (stejné jako jeden lístek) a „3 lístky · TP1 1 ks @ … · TP2 1 ks @ …“.
- **Telefon** (`components/day/LivePhoneOrderSheet.tsx`): „+ TP2“ přidá řádek se stejnými omezeními.
- **Otevřená pozice:**
  - jedna čára SL (táhnutí a BE posouvají všechny lístky);
  - čára TP pro každou úroveň „TP1 1 ks +$…“, táhnutí posune jen tu úroveň (jen dál od trhu, jako dnes);
  - × na čáře TP = „Vybrat teď“ (C2).
- **Čekající rozdělený vstup:**
  - jedna čára „BUY 2 LMT · TP1/TP2 · čeká“;
  - × zruší všechny sourozence (dvoukrokově).
  - Vyplní-li se jen část, zbytek se chová jako čekající přikoupení (vlastní čára s ×).
- **Výsledek:** „Odesláno 2/2 lístky“ / „Odesláno 1 ze 2 (TP2 odmítnut: …)“ (sticky).

### 3. Mechanismus

**Příkaz** `place-leader-entry` + `targets: [{ price, quantity }]` (2–3), bez `takeProfit`, `stopLoss` povinný.

**Validace** (`lib/leaderEntryPreview.ts`: `COMMAND_KEYS` `:109`, holý vstup `:138-139`):
- Σ qty = `quantity`;
- ceny na tick, různé, seřazené od vstupu;
- Limit/Stop: každý target qty 1;
- bez `position`; ne holý Market;
- `operationId` ≤ 96 znaků, protože děti mají přípony `_t1…_t3` a vzor `^entry:[a-zA-Z0-9_-]{8,100}$` musí platit i pro `entryOperationId` správy.

**Náhled** (`services/manualEntryPreview.ts`):
- riziko při SL se nemění (stejný SL × N);
- `target-side` pro každou úroveň (`:325`);
- Market `manualEntryMarketQuoteBlockers` (`:72-101`) pro každou úroveň (≥ 16 ticků);
- swing pro DD z nejvzdálenějšího TP (`:362`, konzervativně);
- `wouldPlace.leader.targets`.

**Worker** — `executeManualEntry` (`:3851`) → nová větev `executeSplitEntry`:
1. Všechny dnešní kontroly (`:3864-3893`).
2. Záznamy dětí (`entry:…_t<i>`, tag `${tag}${i}`, `split: { parent, index, of }`, každé s qty a TP) — jeden durable zápis přes nový `persistManualEntries`, PŘED zápisem k brokerovi.
3. Jedna synchronní pojistka těsně před POSTem:
   - Market kotace znovu (`:3932-3946`);
   - fence a generace (`:3929`).
4. Hned N× `dispatchBroker(generation).placeOso(...)` souběžně. Bez čekání mezi lístky — vlastní eventy prvního ACK by jinak shodily fence druhého. Vzor `runPositionMove` `:4987-5014`. Každý POST má timeout 5 s.
5. Pro každé dítě dnešní zpracování výsledku, vytažené z `:3987-4113` do `settleManualEntryAck(child, outcome)`:
   - `ownManualEntryOrderIds` a `ownManualLegOrderIds` (TP bez `parentId`, `:4037-4040`);
   - `rememberLiveOrder` z ACK;
   - brzda během POSTu (Limit/Stop → `cancelOwnManualEntry`, Market → incident, `:4082-4093`);
   - `abandoned` → incident + zrušení;
   - kontrola odmítnuté nohy (`:4105-4113`).
6. Složený výsledek (`lib/leaderEntryPlace.ts` + `tickets[]`, `partial?`):
   - vše `acknowledged` → `acknowledged`;
   - část odmítnuta → `acknowledged` + `partial` s textem;
   - vše odmítnuto → `rejected`;
   - kterékoli `unknown` → `unknown` + `failClosed`.
7. `manualEntryResultFromRecord` (`:3823`) skládá opakovaný dotaz z dětí, jako `positionActionResult`.

**Čekající sourozenci** (`reviewPendingScaleIns`, `:3719-3765`):
- jakmile má některý sourozenec fill, zbylý čekající sourozenec podléhá `pendingAddViolation` (`manualScaleIn.ts:328-364`): flat, opačná pozice, brzdy, day lock, okno, session, ARM → jedno cílené zrušení;
- před prvním fillem platí totéž co dnes pro jeden Limit (uživatelské ×);
- `cancel-entry` + `scope: 'split'` (validace v `lib/leaderOrderManage.ts`) zruší všechny sourozence s nulovým fillem raw `cancelOrder` (jako `:5325`). Smí i za DISARMED a výsledek je po sourozencích.

**Správa:**
- **`positionManageBlockers`** (`manualScaleIn.ts:370-402`):
  - `move-stop` vyžaduje jen `stopUniform`;
  - `move-target` vybere úroveň `expect.price` (její nohy musí být potvrzené, `working`, bez fillu);
  - rozjeté SL dál blokují (P2-6: žádné tiché sjednocení).
- **`preparePositionAction`**, posun (`:4911-4952`): `legs = stopMove ? všechny SL : TP nohy s limitPrice === expect.price`; `current = expect.price`. Zbytek beze změny (výsledek po nohách, `:5025-5055`).
- **Zpětná kompatibilita:** u jednotné TP je výběr shodný s dneškem.
- **`scaleInAddBlockers`** (`:281-284`): rozjeté TP → nový blocker `scale-in-split` („Přikoupení do pozice s víc TP zatím nejde“).
- **Status:** `targetLevels`; čekající rozdělený vstup souhrnně.

**UI:**
- `lib/liveOrderTicket.ts`, `components/LiveOrderTicket.tsx` (zámek SL/TP `:383-389`, problémy `:451-457`);
- `lib/livePhoneOrders.ts`, `components/day/LivePhoneOrderSheet.tsx`;
- `lib/liveChartOrderLines.ts` (`:101-116`: jedna čára TP pro každou úroveň s id `takeProfit:<i>`);
- `components/TradovateLiveDesk.tsx` (`expect.price` úrovně, zrušení split).

**Relay:** beze změny kódu. **Migrace:** ne.

### 4. Dotčené INV a jak se drží

| INV | Jak |
|---|---|
| INV-MANUAL-01 | Nová podsekce „Rozdělený výstup“: N nezávislých nativních OSO, jedna kontrola, durable před zápisem. |
| INV-OUTBOX-01 | Všechny děti `sending` jedním zápisem před prvním POSTem; žádný retry. |
| INV-OUTBOX-02 | Neznámé dítě je ARM-blocking. |
| INV-OUTBOX-03 | Každý lístek je atomický OSO; chybějící lístek se nedostavuje (menší chráněná pozice). |
| INV-EXIT-01 | Každý lístek kryje jen sám sebe; fill TP zruší jen vlastní SL (podmínka conformance); hlídač nadkrytí jako záloha. |
| INV-RISK-01/02 | Riziko Σ při společném SL; strop na Σ; DD swing z nejvzdálenějšího TP. |
| INV-UI-04 | Market: kotace, drift a ≥ 16 ticků pro každý TP; ceny jen z IBKR, nikdy z TV. |
| INV-BRAKE-02 | Rozšířit výjimku 3 (zrušení čekajícího přikoupení i pod kill a za DISARMED) na čekajícího sourozence po fillu prvního — jen zrušení, jeden pokus. |
| INV-TRAD-02 | Limit/Stop jen qty 1 na lístek; TP nohy bez `parentId` se přiřadí podle id z ACK. |
| INV-TRAD-03 | Tag na dítě (`me…<i>`, `s`/`t`). |
| INV-FRESH-01 | `dispatchBroker(generation)` pro každý POST. |
| INV-RELAY-01/03 | Admission vstupu beze změny; `cancel-entry` split je risk-redukční výjimka. |
| INV-DEFAULT-02/03 | Neznámé dítě = incident (i Limit, sourozence bez id nikdo nehlídá). |
| INV-UI-01..03 | Úrovně a čáry jen zobrazení; `expect.price` = co uživatel viděl. |

### 5. Selhání a fail-closed
- **Dítě odmítnuté** → menší chráněná pozice, `partial`; bez incidentu, bez dosílání.
- **Dítě `abandoned`** (vstup bez nohou) → dnešní cesta: Limit cílené zrušení + incident, Market incident.
- **Dítě `unknown`, restart v `sending`** → incident (trvalý). Pozdní ACK za DISARMED → cílené zrušení Limitu (`:4009-4022`).
- **Brzda během POSTů** → Limit/Stop děti se zruší, Market = incident.
- **Sourozenec vyplněn, pak flat (SL)** → zbylý sourozenec se zruší (jinak by znovu vstoupil). Selhané zrušení = incident (`:3695-3697`).
- **TP1 fill a broker opožděně ruší SL1** → přechodné nadkrytí. `overCoverStep` počká 5 s, za ARMED pak incident.
- **Posun úrovně TP potvrzený jen u části nohou** → úrovně se rozdělí na dvě ceny. To není problém krytí; výsledek „potvrzeno u x z y“, bez incidentu.
- **Posun SL částečný** → rozjeté SL blokují další posun (dnes), zbývá zavřít nebo Flatten.
- **Zastaralý stream** → nohy z ACK jsou syntetické, posuny blokované do potvrzení streamem.

### 6. DEMO conformance
- Scénáře `tp-fill`, `split-limit` (`stop-hit` volitelně).
- Po nasazení z appky:
  - Market 1+1 (PC i telefon);
  - posun jen TP2;
  - BE celé pozice;
  - „Vybrat TP1 teď“ (C2);
  - Limit split 1+1 a × čekajícího;
  - Limit split s fillem jen jednoho a pak flat → zrušení sourozence.

### 7. Testy (M = mutačně ověřit)
1. (M) **Validace:** Σ ≠ quantity, Limit qty 2 na lístek, `targets` + `takeProfit`, stejné ceny, `operationId` > 96.
2. (M) **Náhled:** Market TP2 blíž než 16 ticků blokuje.
3. **Controller (mock):**
   - (M) všechny POSTy odejdou po jedné kontrole; varianta s čekáním na ACK prvního by druhý shodila na fence;
   - částečný úspěch → `partial`;
   - `unknown` → incident;
   - brzda během POSTu;
   - restart → incident;
   - idempotentní opakování příkazu vrátí složený výsledek, žádný druhý POST.
4. (M) **Čekající sourozenec** po fillu prvního a flat → zrušen.
5. **`cancel-entry` split** zruší všechny.
6. **Správa:**
   - (M) posun jedné úrovně nehne druhou;
   - (M) `move-stop` s rozjetými TP projde, s rozjetými SL ne;
   - přikoupení s rozjetými TP blokované.
7. (M) **Replay `tradovate-leader-split.json`:** TP1 fill → lístek 1 vypadne, lístek 2 zůstane, bez falešného incidentu nadkrytí. Mutace „settle 0“ shodí test.
8. **UI:** `tests/liveScaleIn.test.ts` (úrovně, čáry), `tests/liveOrderTicket.test.ts` (řádky), `tests/livePhoneOrders.test.ts`.

### 8. Soubory
`lib/leaderEntryPreview.ts`, `lib/leaderEntryPlace.ts`, `lib/leaderOrderManage.ts`, `services/manualEntryPreview.ts`, `services/manualScaleIn.ts`, `services/manualPositionExits.ts`, `services/copierEngine.ts`, `services/copierStore.ts`, `services/copierRuntimeController.ts` (`executeSplitEntry`, `settleManualEntryAck`, `manualEntryResultFromRecord`, `reviewPendingScaleIns`, `preparePositionAction`, zrušení split, restart, status), `components/LiveOrderTicket.tsx`, `lib/liveOrderTicket.ts`, `components/day/LivePhoneOrderSheet.tsx`, `lib/livePhoneOrders.ts`, `lib/liveChartOrderLines.ts`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneOrderLines.tsx`, `docs/COPIER_INVARIANTS.md`, testy a fixture.

### 9. Velikost a závislosti
**L.**
- Závisí na C0 (`tp-fill`, `split-limit`).
- Část „správa úrovní“ jde postavit před C2.
- „Vybrat TP teď“ = C2.

---

## C4 — Otočení (reverse) pozice

### 1. Verdikt
**STAVĚT-PO-CONFORMANCE.** Před stavbou musí proběhnout `reverse --repeat 5`.

Bez zkráceného ticha je otočení bezpečné, ale nefunkční:
- 5 s ticha po posledním eventu zavření (`connectionRenewalQuietMs`, `:2008`) je víc než povolené stáří kotace Marketu 5 s (`LEADER_ENTRY_MARKET_QUOTE_MAX_AGE_MS`, `lib/leaderEntryPreview.ts:20`);
- vstup by vždy skončil `market-quote-stale` a uživatel by zůstal flat.

INV-UI-04 (stáří ≤ 5 s, drift ≤ 8 ticků od ceny, kterou uživatel viděl) se NEuvolňuje. Zkracuje se jen ticho, a to výhradně po vlastním ověřeném zavření, o hodnotu změřenou na DEMO.

Když záznam ukáže, že eventy zavření chodí i > 2 s po liquidate, C4 se nestaví.

### 2. Chování (PC a telefon)
- **Spuštění:**
  - PC: akce štítku pozice „Otočit“;
  - telefon: list pozice „Otočit“.
- Otevře se panel nebo list objednávky předvyplněný: opačná strana, Market, qty = |net| (smí být méně, strop 5), SL/TP z výchozích hodnot panelu (dnes SL 12 b / TP 2R) vůči ceně grafu. Se štítkem „OTOČENÍ: nejdřív zavře LONG 2“.
- **Odeslání:** PC jedním „Odeslat“, telefon dvoukrokově.
- **Průběh a výsledek** (toasty):
  - „Zavírám…“ → „Zavřeno · otáčím…“ (≈ 1–2 s) → „Otočeno: SHORT 2 @ … SL … TP …“;
  - nebo sticky „Zavřeno, opačný vstup neodešel: <důvod>“, například:
    - trh se pohnul o > 8 ticků;
    - kotace stará;
    - zámek dne po realizované ztrátě;
    - brzda.
- **Zablokuje se předem, nic nezavře:**
  - konec okna, session nebo ARM do 5 min;
  - day lock (i čekající), pauza, cooldown (`entryCooldownMinutes > 0`, protože cooldown po flat stejně vypne kopírku);
  - strop, chybějící IBKR, čekající přikoupení, cizí příkaz, rozjeté SL.

### 3. Mechanismus

**Příkaz** `place-leader-entry`:
```
{ side: opačná, orderType: 'Market', quantity: Q, stopLoss, takeProfit (nebo targets po C3),
  referencePrice, quoteReceivedAt,
  position: { mode: 'reverse', side: strana pozice, quantity: |net|, ticketEntryIds } }
```
Validace (`lib/leaderEntryPreview.ts:68-76`, `:140-148`): `mode: 'reverse'` ⇒ `position.side ≠ side`, Market, ne holý vstup.

**Worker** — `placeLeaderEntry` (`:20028`) → větev otočení:

**R0 ve frontě (`prepareReverse`):**
- `exitsOn()`;
- `reverseBlockers`: model sedí se záměrem, `positionManageBlockers('close-position')` čisté (`manualScaleIn.ts:384-390`), `ownOpen = |net|`, žádný cizí příkaz;
- ARMED ∧ ¬shadow ∧ ¬kill ∧ ¬managementOnly; `closeReachBlockers`;
- **předkontrola vstupu.** Neautorizuje nic, jen zabrání zavření, když vstup určitě neprojde. Bere `previewLeaderEntry` odvozeného příkazu z flat se „sondou otočení“, která ignoruje vlastní lístky leadera a ticho. Kontroluje okno, session, rezervu ARM, day lock (i čekající), pauzu, cooldown, strop, kotaci (stáří, drift, ≥ 16 ticků na nové straně) a riziko konzervativně: rezerva bez otevřeného P&L minus ztráta stávající pozice ke SL (`scaleInPositionLossPoints`);
- zachytí `generationR0 = safetyGeneration` a `armedAtR0`;
- durable záznam zavření (`manage:rev…`, `close-position`, `reverseEntryOperationId`) ve stavu `sending`;
- vrátí thunk.

**R1 mimo frontu:** dnešní zavření celé pozice (`runPositionClose` `:4895` → `executeClose` `:4257`). Výsledek jen ze stavu u brokera (INV-MODE-02).

**Odpověď relayi hned po R1:**
- `status: 'acknowledged'` + `reverse: { close: 'acknowledged', entry: 'scheduled', entryOperationId }` jen při `acknowledged` zavření;
- jinak `blocked` (nic se nestalo) nebo `unknown` (zavření neznámé) a vstup nikdy.
- `waived` (pozice už byla flat jinak) → vstup NE (uživatel chtěl otočit pozici, kterou už nemá).

Proč vracet hned: relay je sériová linka (INV-BRAKE-03). Brzda čekající za 6–8s složeným příkazem by vstup nezastavila. Po uvolnění linky brzda dorazí do controlleru → zvedne generaci → R3 neodejde.

**R2 na pozadí** (`reverseEntryJobs`, blokují `connectionRenewalBlocker` jako `manualEntryCancelJobs`, `:19869`):
- každých 100 ms čistý `previewLeaderEntry(odvozený vstup z flat)` s kontextem výjimky ticha;
- konec když:
  - `safetyGeneration ≠ generationR0` nebo `armedAt ≠ armedAtR0` → audit „otočení zrušeno brzdou / novým ON“;
  - deadline (`deadlineAt` příkazu − 1 s) → „vstup neodešel: <první blocker>“;
  - žádný blocker → R3.

**Výjimka ticha — `reverseQuietSatisfied`, jediná změna brány z flat** (`:19906`, místo 5 s z `:19651-19655`). Platí, když současně:
- zavření `acknowledged` REST stavem (flat ∧ nic nepracuje);
- stream flat; ingress leadera 0;
- každý event leadera od začátku R1 patří vlastním id (vstupy a nohy lístků, likvidační Market na symbolu se stranou výstupu a qty |net|);
- od posledního eventu leadera uplynulo ≥ `REVERSE_QUIET_MS`, hodnota z conformance, návrh `max(1 500 ms, 2 × nejdelší naměřený ocas)`;
- risk snímek je novější než fill zavření (`manualEntryPreview.ts:378`);
- deník zavřel lot (`unconfirmedFlatLots` 0).

Jakýkoli nepřiřaditelný event = dnešních 5 s.

**R3:**
- zařazení do `eventTail`: `executeManualEntry(odvozený vstup, deadlineAt, evaluate, manualEntryQueueFence())`;
- navíc `generation === generationR0 && gate.armedAt === armedAtR0` těsně před durable `sending` i před POSTem (`dispatchBroker(generationR0)`);
- jinak dnešní cesta z flat beze změny (kotace znovu, OSO, ACK, brzda během POSTu).

**Další pravidla:**
- Konečný výsledek je ve statusu (`manualEntries`, záznam `entry:<base>_r` s `reverseOf`) a v toastu.
- Během R2 se jiný `place-leader-entry` odmítne (`manual-entry-reverse-busy`; relay busy kryje 3 s).
- Restart v R2 → vstup nikdy, audit. Restart v R3 během POSTu → dnešní incident Marketu (`:19509-19522`).

**Relay:** beze změny kódu. **Migrace:** ne.

**UI:**
- `components/LiveOrderTicket.tsx` (režim otočení);
- `components/TradovateLiveDesk.tsx` (odeslání, zobrazení `reverse`);
- `components/day/LivePhoneTrade.tsx`, `LivePhoneOrderSheet.tsx`, `lib/livePhoneOrders.ts`;
- `components/LiveTradeToasts.tsx`.

### 4. Dotčené INV a jak se drží

| INV | Jak |
|---|---|
| INV-MANUAL-01 | Nová podsekce „Otočení“: dva samostatné kroky; mezistav = flat (bezpečný); výjimka z 5s ticha jen po vlastním REST-ověřeném zavření, s hodnotou z DEMO záznamu. |
| INV-MODE-02 | Zavření potvrzené stavem; `waived` / `unknown` → vstup nikdy. |
| INV-UI-04 | Beze změny: stáří ≤ 5 s, drift ≤ 8 ticků, ≥ 16 ticků i v R3. Proto zkrácené ticho a ne uvolnění kotace. |
| INV-BRAKE-01/02/03 | Brzda během R2 nebo R3 → generace → vstup neodejde. Text INV-BRAKE-03 doplnit: vstup otočení běží po ACK relaye, vzdálená brzda ho zastaví. |
| INV-RELAY-01/02/03 | Idempotence (`existing` + záznam zavření s `reverseEntryOperationId` brání druhému zavření); relay nikdy nespouští execution znovu; supersede brzdou platí pro vstupy. |
| INV-RISK-02/03 | Day lock (i čekající) a cooldown po zavření vstup zablokují (cooldown už předkontrolou). |
| INV-ARM-01/03 | Vstup jen za téhož ARM (`armedAt`); nový ON během R2 = zrušeno. |
| INV-OUTBOX-01/02 | Zavření i vstup mají vlastní durable `sending` před zápisem; restart → `unknown` podle dnešních pravidel. |
| INV-FRESH-01 | `dispatchBroker(generationR0)`, fence fronty v R3. |
| INV-DEFAULT-02 | Neznámý Market vstup = incident; neznámé zavření = dnešní dořešení čtením. |
| INV-DIVERGENCE-01 | Žádné opakování vstupu ani zavření. |
| INV-WORKER-04 | Úloha R2 je jen čistá čtení paměti, neblokuje poll ani brzdy. |

### 5. Selhání a fail-closed

| Situace | Výsledek |
|---|---|
| Předkontrola selže | Nic se nezavře, `blocked`. |
| Zavření `rejected` / `unknown` / `waived` | Vstup nikdy; `unknown` se dořeší čtením (dnes `scheduleManualOrderActionLookup`). |
| Zavření OK, vstup blokovaný (drift, stáří, day lock, deadline) | Uživatel je flat (bezpečné), sticky toast, bez incidentu. |
| DISARM/kill během R2 | Generace → zrušeno, flat. |
| Brzda + nové ON během R2 | `armedAt` se liší → zrušeno. |
| Pozdní event zavření po R3 | Brání výjimka jen pro vlastní eventy + změřený ocas. Kdyby přesto přišel, ledger ho přiřadí podle id likvidace (replay test). |
| Restart v R2 | Vstup nikdy, audit, pozice flat (ARM po restartu stejně vyžaduje kontrolu). |
| Restart během POSTu R3 | Market `sending` → `unknown` → trvalý incident. |
| Market vstup ACK za DISARMED | Dnešní cesta: `acknowledged` + incident (`:4082-4088`). |

### 6. DEMO conformance
- `reverse --repeat 5` (1 lístek i 2 lístky; měřit poslední event po liquidate a pořadí eventů při vstupu po X ms).
- Po nasazení z appky: otočení z PC i telefonu; otočení u pozice ze 2 lístků; otočení blokované předem (konec okna); otočení zrušené brzdou (DISARM ihned po kliknutí).

### 7. Testy (M = mutačně ověřit)
1. (M) **Předkontrola blokuje bez zavření:** mock nezavolá `liquidatePosition`.
2. (M) **Zavření `unknown` / `waived` / `rejected`** → žádný `placeOso`.
3. (M) **Brzda (disarm) během R2** → žádný vstup. Mutace bez fence generace vstup pošle a test padá.
4. **Nové ON během R2** → žádný vstup.
5. **Day lock po realizované ztrátě** → vstup blokovaný; cooldown blokuje předem.
6. (M) **Výjimka ticha:**
   - cizí event leadera → čeká 5 s;
   - vlastní eventy → `REVERSE_QUIET_MS`;
   - mutace „výjimka vždy“ padá.
7. **Deadline** → zrušeno.
8. **Restart po zavření** → žádný vstup + audit.
9. **R3 Market `unknown`** → incident.
10. **Relay výsledek** vrácen po R1 (časování).
11. **Opakovaný příkaz** nezavírá podruhé.
12. **Replay `tradovate-leader-reverse.json`:** ledger má dvě oddělené epizody, žádný fill zavření v nové epizodě.

### 8. Soubory
`lib/leaderEntryPreview.ts`, `lib/leaderEntryPlace.ts`, `services/manualPositionExits.ts`, `services/copierRuntimeController.ts` (`placeLeaderEntry`, `prepareReverse`, `reverseEntryJob`, kontext ticha v `previewLeaderEntry`, `connectionRenewalBlocker`, restart, status), `services/copierEngine.ts`, `services/copierStore.ts`, `components/LiveOrderTicket.tsx`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneTrade.tsx`, `components/day/LivePhoneOrderSheet.tsx`, `lib/livePhoneOrders.ts`, `components/LiveTradeToasts.tsx`, `docs/COPIER_INVARIANTS.md`, testy a fixture.

### 9. Velikost a závislosti
**M.**
- Závisí na C0 (`reverse` záznam, opt-in).
- Používá dnešní zavření celé pozice a vstup z flat.
- C3 je volitelné (otočení s `targets`).

---

## Otázky pro Filipa a critic
1. C2 přes B (podkrytí ~200 ms, při selhání incident) teď, a C2-T (TP→Market, bez podkrytí, ale výjimka „TP k trhu“) až po záznamu? Nebo rovnou C2-T u celých lístků?
2. Zmenšení a otočení jen za ARMED (jako dnešní ×)? Za DISARMED zůstává Flatten.
3. „Vybrat TP teď“ na PC dvoukrokově (navrženo), nebo jedním klikem jako × celé pozice?
4. Otočení: běh na pozadí po ACK relaye (navrženo kvůli brzdě), nebo držet relay linku (jednodušší, ale brzda čeká až ~15 s)?
5. Instalační opt-in `--exits on` samostatně, nebo součást `--scale-in on`?



---

## Posudek copier-design-critic (návrh)

**Celkový verdikt: OPRAVIT PŘED COMMITEM**

- **P1** [C2 — restart mezi krokem 1 a Marketem] (INV-OUTBOX-01/02, INV-DEFAULT-02/03, INV-EXIT-01 (nový)) Žádný durable záznam nepokrývá úsek od dokončení kroku 1 do založení `~m`. Při restartu se na `unknown` mění jen záznamy `sending` (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRuntimeController.ts:19494-19500) a `~m` podle návrhu vzniká až po kroku 1. Scénář: (1) krok 1 je potvrzený a každý `~r` se uloží jako `acknowledged` vlastním zápisem (stejně jako settleLeg :4973-4975). (2) Proces spadne (launchd, OOM, uspání) dřív, než se zapíše `~m sending`. (3) Po startu není nic ve stavu `sending`, takže nevznikne incident. Worker je DISARMED a pozice P má SL jen na P−N. (4) `reducedQuantity` se nezapsal, proto ownOpen≠|net| a positionManageBlockers vrátí 'shape' (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/manualScaleIn.ts:385) i pro ×. Výsledek: N kontraktů bez SL a bez incidentu, tedy schovaný incident.
  - Oprava: Rodičovský záznam `manage:…` (např. action 'reduce-position') zapsat jako `sending` stejným zápisem `persistManualOrderActions` jako `~r`, a `~m` rovnou jako planned. Rodič zůstane `sending`, dokud `classifyReduceOutcome` neuloží výsledek. Při restartu: rodič `sending` nebo `unknown` → unknown + failClosed({autoClose:false, recordWhenDisarmed:true}). Výsledek `~m` a `reducedQuantity` uložit jedním persistSafety. Test: pád po potvrzení všech `~r` a před `~m`, mutace bez rodiče musí test shodit.
- **P1** [C3 — korelace souběžných OSO se stejnou qty] (INV-TRAD-02, INV-OUTBOX-03, INV-MANUAL-01, INV-DEFAULT-02) TP noha chodí bez parentOrderId, nese jen ocoId (fixture /Users/filipkrejca/alphatrade-worktrees/scale-in/tests/fixtures/tradovate-leader-oso-api-fill.json, t=2589). Korelátory ji přiřazují odhadem podle qty, strany a okna. (a) Market 1+1: bracketCorrelator najde dva vyplněné vstupy qty 1 (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierBracketCorrelator.ts:104-111), vrátí null a pár E1 zůstane neúplný. Po časovači následuje `incomplete-bracket-pair` → failClosed (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRuntimeController.ts:17330-17337). (b) Limit split: osoCorrelator vrátí `ambiguous` (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierOsoCorrelator.ts:106-113) → failClosed (:17482-17487). ownManualLegOrderIds se dnes používá jen pro standaloneReduction (:17477) a ocoId žádný korelátor nečte. Výchozí rozdělení 1+1 a 1+1+1 by tak každým rozděleným vstupem vyhlásilo incident. Návrh tyto cesty v seznamu souborů vůbec nemá.
  - Oprava: Před odhadem v obou korelátorech přiřadit vlastní nohy přesně podle id z ACK (stop/target → vstup lístku), případně přes ocoId → SL → parentOrderId. Odhad nechat jen pro cizí příkazy. Replay test s prokládanými eventy 2–3 souběžných OSO se stejnou qty (Market i Limit); mutace „bez přiřazení z ACK“ musí test shodit. Do záznamů `tp-fill` a `split-limit` zapsat pořadí eventů a pole parentId/ocoId.
- **P2** [C2 — cesta ven po podkrytí] (INV-DEFAULT-02, INV-UI-02, INV-MANUAL-01 (2d)) Tabulka §5 tvrdí „× celé pozice projde“. Po incidentu ale failClosed vypne kopírku (:6898 a dál). executeClose pak skončí na !gate.armed (:4266) a closeReachBlockers→manageReachBlockers také (:4168). Lístek se zrušenými nohami navíc z modelu vypadne, takže ownOpen≠|net| a close blokuje 'shape' (manualScaleIn.ts:385). Ven vede jen Flatten (na telefonu přes LIVE ▾ → Live Dashboard) nebo Tradovate.
  - Oprava: Opravit text v návrhu i v sticky toastu: nabídnout Flatten, ne ×. Test: po incidentu podkrytí je × zablokované a Flatten projde (žádný zápis na leaderovi neběží).
- **P2** [C2 — automatické dořešení reduce-* streamem] (INV-OUTBOX-02, INV-DEFAULT-03) Návrh vyjímá reduce-* jen z resolveManualOrderActionByLookup (:4402). resolveManualOrderActionFromStream (:4530-4545) ale vyjímá jen close-position a attach-brackets. Záznam `reduce-leg-cancel` nebo `reduce-leg-resize` ve stavu `unknown` proto při konci nohy přejde na `waived` („cílový příkaz skončil“). Stejně tak classifyManagedOrderLookup (:4373-4399) zachází s neznámou akcí jako s move-target.
  - Oprava: Vyjmout reduce-* i rodiče v obou funkcích a přidat test, že stream ani čtení takový záznam nedořeší.
- **P2** [C2 — idempotentní opakování uprostřed operace] (INV-RELAY-01/02, INV-UI-01) prepareManualOrderAction (:5067-5071) skládá výsledek přes positionActionResult (:4784-4803) ze všech záznamů `~*`. Když jsou všechny `~r` acknowledged a `~m` ještě neexistuje, vrátí 'acknowledged' („Zmenšeno“) dřív, než Market odešel.
  - Oprava: Pro reduce vlastní skládání výsledku podle rodiče a `~m`. Test opakovaného příkazu mezi krokem 1 a 2.
- **P2** [C2 — tvrzení „nové druhy jsou ARM-blocking“ a downgrade] (INV-OUTBOX-02, INV-ARM-01) arm() blokuje jen unresolvedManualEntry (:19759). Záznamy manualOrderActions v `unknown` ARM neblokují (INV-MANUAL-01 2a). ARM drží jen incident (manualRecoveryRequired) a flat brána. Po potvrzení incidentu zůstanou visící reduce-* záznamy a přes `record.symbol === symbol` (:4820) zablokují veškerou další správu pozic na kontraktu, dokud je někdo nevyřeší výjimkou. Slib „po downgradu zůstane ARM-blocking“ starý worker splnit neumí, protože neznámou akci dořeší streamem (viz nález o dořešení reduce-*).
  - Oprava: Buď přidat do arm() výslovnou bránu na nevyřešený reduce rodič, nebo opravit text INV. Popsat cestu přes výjimku (`manage:`) a downgrade tvrzení vypustit.
- **P2** [C2 — kontrola 2 a rozpočet na dohnání streamu] (INV-FRESH-01, INV-EXIT-01) Čekání ≤ 1 s na ingress 0 a liveOrders je krátké. eventTail s durable commity stál i > 1,5 s (past 29. 10.), takže hrozí časté falešné incidenty podkrytí. Kontrola 2 také nemá route epoch ani connectionSyncGeneration. Fence fronty se použít nedá, protože vlastní eventy z kroku 1 ji samy změní.
  - Oprava: Když dohnání nestihne rozpočet, udělat jedno ohraničené REST čtení (readLeaderSymbolLegs, :4235) jako autoritu pro kontrolu 2 a teprve pak rozhodnout. Do synchronní kontroly 2 přidat route epoch leadera a connectionSyncGeneration.
- **P2** [C2 — co znamená vyřešený cancelOrder] (INV-TRAD-02, INV-MODE-02) Adaptér cancelOrder se vyřeší i pro stav 'filled' nebo 'rejected' a bez syncReady i bez jakéhokoli potvrzení (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/tradovateBroker.ts:2171-2186). Vyřešený promise tedy neznamená zrušenou nohu.
  - Oprava: Stav nohy brát jen z pozorovaného stavu (stream nebo autoritativní findOrderById). 'filled' znamená, že se SL/TP spustil, nikdy „cancel OK“.
- **P2** [C2 — × celé pozice během běžícího zmenšení (pojistka do hloubky)] (INV-EXIT-01, INV-MANUAL-01 (2d)) Worker dál pouští plné zavření mimo mutex (:4817/:4820 s closeQuantity==null). Dnes souběh brání jen sériová relay linka a busy podle klíče obchodu (v_trade = entryOperationId v admission SQL). Když zmenšení zavře nejstarší lístek (C3 „Vybrat TP1 teď“), × dostane jiný klíč a admission ho přijme. Kdyby se linka uvolnila dřív (timeout delivery, budoucí paralelismus), může nastat: liquidate doběhne, kontrola 2 nevidí rozpracovaný zápis (POST už skončil), ingress je 0 a stream je ještě starý → Market N po flat → otočení na −N bez ochrany.
  - Oprava: Ve workeru blokovat plné zavření, dokud v positionActionsInFlight běží zmenšení, nebo do kontroly 2 přidat příznak „od kroku 1 začalo zavření či liquidate“. Test: × doručené během kroku 1 a během čekání na dohnání.
- **P2** [C2 — brzda mezi kroky (rozhodnutí)] (INV-BRAKE-01/02/05, INV-DEFAULT-02) Okno není „~200 ms“: trvá od odeslání kroku 1 (timeout až 3 s) přes dohnání (≤ 1 s) až po Market. Spustit ho může lokální DISARM z Macu, expirace ARM, pauza pravidlem dne nebo jakýkoli failClosed. Výsledek je N kontraktů bez SL za DISARMED (jen incident).
  - Oprava: Rozhodnutí pro Filipa: (a) okno přijmout jako vědomé a opravit text, nebo (b) zavést úzkou výjimku „dokončení už zahájené redukce“ za DISARM (ne pod kill). Market nemůže pozici otočit, protože nohy už jsou na P−N. Varianta (b) vyžaduje text v INV-BRAKE-01/02.
- **P2** [C4 — význam výsledku „acknowledged + scheduled“] (INV-UI-01/03, INV-RELAY-02) `leader-entry-placed` se stavem 'acknowledged' dnes znamená přijatý vstup. Desk, toasty, uložený výsledek relaye i notifikace ho tak mohou vyložit, přestože vstup zatím jen čeká a nemusí vůbec odejít.
  - Oprava: Použít odlišný stav (např. 'close-acknowledged'/'scheduled') nebo vlastní typ výsledku. Konečný stav vstupu brát jen z manualEntries.
- **P2** [C4 — rozpočet stáří kotace] (INV-UI-04, INV-MANUAL-01) Stáří kotace se počítá od quoteReceivedAt klienta a smí být ≤ 5 s (/Users/filipkrejca/alphatrade-worktrees/scale-in/lib/leaderEntryPreview.ts:20, /Users/filipkrejca/alphatrade-worktrees/scale-in/services/manualEntryPreview.ts:80-83). Do toho se musí vejít relay, předčtení v R0, celé R1 (timeout liquidate 8 s :3435, ověření až ~4 s :4317-4333), ticho ≥ 1,5 s a R3. Častým výsledkem bude „zavřeno, neotočeno“.
  - Oprava: R0 nesmí zavřít, když zbývající rozpočet kotace < očekávané R1 + REVERSE_QUIET_MS + rezerva. Na DEMO měřit celou osu klik → R3, nejen „ocas“ eventů.
- **P2** [C4 — riziko v R3 po zavření (NEOVĚŘENO)] (INV-RISK-01/02) Náhled chce risk snímek novější než fill zavření (manualEntryPreview.ts:377-378) a fill vynutí nové čtení (:16617). Rezerva ale vychází z realizovaného P&L a netLiq od brokera (:212-222). Jestli Tradovate cashBalance zahrne realizovanou ztrátu do ~1 s, není ověřené. Snímek „po fillu, ale před zaúčtováním“ by rezervu nadhodnotil.
  - Oprava: V R3 brát rezervu jako min(konzervativní odhad z R0, snímek po zavření), případně realizované P&L jako min(deník, broker) jako v dailyLossPnl. Do záznamu `reverse` přidat, kdy se realizované P&L po liquidate projeví v cashBalance.
- **P3** [C4 — mezery předkontroly a výjimky ticha] (INV-OUTBOX-01, INV-RISK-02) Předkontrola nehlídá `manual-entry-too-soon` (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRuntimeController.ts:3449/:3876) při pozici otevřené před < 3 s. Nehlídá ani limity ztrátových obchodů a počtu obchodů dne, které samo zavření může naplnit. Výjimku ticha musí dostat i evaluate v R3. reverseEntryJobs v connectionRenewalBlocker (:19866-19880) by jinak blokoval vlastní vstup jako 'group-busy'. Přípona `_r` může přetéct vzor ^entry:[…]{8,100}$.
  - Oprava: Doplnit tyto kontroly do předkontroly. Výjimku ticha předat i do R3 a vlastní úlohu z blockeru vyjmout. Délku základu operationId omezit na ≤ 98 znaků.
- **P3** [C3 — idempotence: místa vyhledání existující operace] (INV-RELAY-01, INV-OUTBOX-01) placeLeaderEntry (:20029) i executeManualEntry (:3864) hledají přesné operationId. Děti `_t<i>` nenajdou, takže opakovaný příkaz by běžel znovu. Brání tomu jen relay a paměť agenta.
  - Oprava: Hledat děti podle `split.parent` na obou místech. Test 3 (opakování bez druhého POSTu) musí jít přes placeLeaderEntry.
- **P3** [C0 — doplnění DEMO záznamu] (INV-TRAD-02, pravidlo „nejdřív DEMO záznam“) Scénář `resize` mění obě nohy souběžně, takže nerozliší, jestli Tradovate sám upraví partnera OCO (větev v C2 §1). `stop-hit` se SL 10 ticků je v rozporu s pojistkou SL/TP ≥ 40 b. Chybí záznam prokládání parentId/ocoId u 2–3 souběžných OSO se stejnou qty a záznam časování risk snímku po liquidate.
  - Oprava: Přidat `resize-one-leg` (modify jen SL) a výslovnou výjimku pojistky pro `stop-hit`. Zapisovat ocoId/parentId a čas cashBalance. Skripty spouští jen Filip.
- **P3** [C2 — drobnosti] (INV-BRAKE-03) Obsazení relay linky je podhodnocené: přičte se start ve frontě ≤ 2 s (:3442) a REST předčtení ≤ 3 s, takže to je až ~18 s, ne 13 s. Navíc je zbytečně přísné hlásit incident, když se SL/TP během kroku 1 spustí a zbylá pozice je přesně krytá.
  - Oprava: Opravit čísla v INV-BRAKE-03. Stav „pozice P−q přesně krytá“ klasifikovat jako `waived` bez incidentu.

### Verdikty po položkách

- Celkově: **OPRAVIT PŘED COMMITEM** — Architektura drží: Market až po potvrzených nohách, žádné opakování, výsledek ze stavu u brokera, otočení přes flat. Před první řádkou kódu ale musí návrh opravit dva nálezy P1 (restart v C2, korelace v C3) a vyjasnit nálezy P2. Ověřeno jen čtením kódu ve /Users/filipkrejca/alphatrade-worktrees/scale-in; testy ani nic u brokera jsem nespouštěl.
- C0 opt-in, capability, record-exits: **OK S VÝHRADAMI** — exitsOn() = scaleInOn() && opt-in. scaleInEnabled vyžaduje demo (manualScaleIn.ts:19-26), capability vedle scale-in (localCopierExecutionAgent.ts:405-416). Výhrady: tvrzení o ARM-blocking a downgradu (P2) a doplnění scénářů (P3).
- §0.5 relay bez migrace: **OK S VÝHRADAMI** — Ověřeno: striktní whitelist (lib/leaderOrderManage.ts:63, :86) odmítne closeQuantity u starého relaye i workeru, TTL 5 s (tradovateCopierCommandRelay.ts:117-121), supersede brzdou (:975-983 a SQL :333-335), close bez denního stropu (SQL :182). Výhrada: všechny vrstvy UI a notifikací, které chápou 'close-position' jako zavření celé pozice, musí rozlišit closeQuantity.
- INV-EXIT-01 (text): **OK S VÝHRADAMI** — Vzorec Σmax(SL,TP) + Market ≤ |net| platí, pokud Tradovate zpracuje OCO atomicky (výsledek conformance). Doplnit durable rodiče, správnou cestu ven (Flatten) a rozhodnutí o brzdě mezi kroky.
- C2 částečné zavření: **OPRAVIT** — P1 restart bez rodiče. P2: × po incidentu neprojde; stream dořeší reduce-*; idempotence vrátí 'acknowledged' před Marketem; ARM-blocking neplatí; dohnání 1 s; vyřešený cancel ≠ zrušeno; × během zmenšení; brzda mezi kroky. Pořadí „nohy → potvrzení → Market“ je správné.
- C3 víc TP: **OPRAVIT** — P1: dnešní korelátory párují TP bez parentId odhadem. Souběžná OSO se stejnou qty dají ambiguous nebo neúplný pár → failClosed. Ostatní (jeden durable zápis dětí, výsledek po dětech, sourozenec jako čekající přikoupení, výjimka 3 z INV-BRAKE-02) drží.
- C4 otočení: **OK S VÝHRADAMI** — Dva kroky přes flat, vstup nikdy po unknown/waived zavření, fence generationR0 + armedAt. Flatten zvedá safetyGeneration (invalidateReconciliation :8530), takže R2 zruší. Výhrady: stav výsledku, rozpočet kotace, riziko v R3 (NEOVĚŘENO), mezery předkontroly. Když vlastní zavření zvedne generaci jinou cestou, otočení nikdy neproběhne (pozitivní test).
- Zamítnuto: flip jedním Marketem 2N: **ZAMÍTNUTÍ SPRÁVNÉ** — Staré nohy po otočení zvětšují novou pozici, nebo vzniká okno opačné pozice bez ochrany.
- Zamítnuto: Market redukce před nohami: **ZAMÍTNUTÍ SPRÁVNÉ** — Okno Σ = P+N: SL by pozici otočil (INV-EXIT-01).
- Zamítnuto: startOrderStrategy (ATM): **ZAMÍTNUTÍ SPRÁVNÉ** — Neznámý lifecycle, bez DEMO záznamu (INV-TRAD-02).
- Zamítnuto: zruš nohy → Market → nové OCO: **ZAMÍTNUTÍ SPRÁVNÉ** — Okno bez ochrany na celou pozici a částečný tvar, který by se musel automaticky dostavět (INV-OUTBOX-03).
- Odloženo: C2-T (TP→Market): **ZAMÍTNUTÍ SPRÁVNÉ** — Odklad je správný: jde o výjimku z INV-MANUAL-01 2c a změna typu nohy není zaznamenaná. Po záznamu `tp-fill --tp-market` znovu přes critic.
- Otázka 1 (B vs C2-T): **OK S VÝHRADAMI** — Variantu B stavět až po conformance a s opravou P1 (rodič) a P2 (cesta ven, brzda). C2-T samostatně po záznamu.
- Otázka 2 (jen ARMED): **OK** — Ano. dispatchBroker za DISARM/shadow odmítne (:1913-1919), shoda s ×. Za DISARMED zůstává Flatten.
- Otázka 3 (Vybrat TP teď): **OK** — Dvoukrokově: jde o dva zápisy s oknem podkrytí, ne o jeden nativní liquidate.
- Otázka 4 (otočení na pozadí): **OK S VÝHRADAMI** — Na pozadí ano (brzda se nečeká ~17 s), ale s odlišným stavem výsledku a s rozpočtem kotace v R0.
- Otázka 5 (--exits on): **OK** — Samostatný opt-in, rollback po krocích. mac-reinstall-safe.sh ho musí přenášet (vzor :152).
- Dotčená INV: **info** — INV-EXIT-01 (nový), MANUAL-01, OUTBOX-01/02/03, DEFAULT-02/03, FRESH-01, TRAD-02/03/04, MODE-02, BRAKE-01/02/03/05, RELAY-01/02/03, RECON-04, ARM-01/03/04, RISK-01/02/03, DIVERGENCE-01, UI-01..04, WORKER-02/04.
- Chybějící testy: **info** — Pád po potvrzení `~r` a před `~m`. Replay 2–3 souběžných OSO se stejnou qty (Market i Limit), mutace bez přiřazení z ACK. Opakovaný příkaz mezi kroky C2. Stream ani čtení nedořeší reduce-*. × a Flatten po incidentu podkrytí. × doručené během kroku 1 a během dohnání. Dohnání > 1 s → REST místo incidentu. Rozpočet kotace v R0 (zavření se neodešle). Rezerva v R3 se snímkem bez realizované ztráty. Flatten, kill a day lock (vyvolaný zavřením) během R2 → žádný vstup. Pozitivní test: běžné zavření nezvedne safetyGeneration. Opakování place-leader-entry s dětmi `_t<i>` → žádný druhý POST.
- KS-01 ARM bez syncu/bran: **netýká se** — arm() se nemění; zmenšení i otočení vyžadují ARMED.
- KS-02 unknown→flat/zero: **drží** — Chybějící reducedQuantity je konzervativní (blokace 'shape'); net null blokuje. Rezerva v R3 NEOVĚŘENO.
- KS-03 mazání lastError: **netýká se** — Žádné reconcile; výjimka `manage:` incident nemaže.
- KS-04 veřejné vs interní reconcile: **netýká se** — —
- KS-05 souběh během await: **PORUŠENO** — Restart mezi kroky C2 bez incidentu (P1). Brzda mezi kroky = vědomé podkrytí. × během zmenšení (P2).
- KS-06 fence před zápisem/commitem: **drží s výhradou** — dispatchBroker kontroluje generaci před každým zápisem. Do kontroly 2 doplnit route epoch a connectionSyncGeneration.
- KS-07 dvojí provedení: **drží s výhradou** — Žádné opakování. Idempotence vyhledání dětí C3 a skládání výsledku C2 (P2/P3).
- KS-08 durable před zápisem, unknown blokuje ARM: **PORUŠENO** — `~m` vzniká až po kroku 1 (P1). Manual order actions ARM neblokují (:19759), tvrzení návrhu neplatí.
- KS-09 OCO/OSO partial/Suspended: **drží s výhradou** — Závisí na conformance. Vyřešený cancelOrder ≠ zrušeno (tradovateBroker.ts:2171-2186). Korelace C3 (P1).
- KS-10 divergence obchodem: **drží** — Žádné dorovnání ani vrácení qty, Market nikdy opakovaně.
- KS-11 cíl zavření: **drží** — ownOpen === |net|, vlastní lístky. Liquidate ruší i cizí příkaz kontraktu (známé).
- KS-12 nejasná likvidace: **drží** — Zavření C4 unknown/waived → vstup nikdy (INV-MODE-02).
- KS-13 management-only: **drží** — Otočení blokované. Zmenšení snižuje riziko, manual-only skupina management-only fakticky nemá.
- KS-14 toggle/leader/route uprostřed: **netýká se** — Topologie manual-only je uzamčená instalací.
- KS-15 eligibility jen zpřísňuje: **netýká se** — —
- KS-16 day lock/cooldown po flat, DST: **drží** — Otočení blokuje cooldown > 0 a čekající lock předem. Lock po zavření vypne kopírku → R2 se zruší.
- KS-17 brzdy mimo FIFO: **drží s výhradou** — C4 uvolní linku po R1. C2 drží linku až ~18 s (text INV-BRAKE-03).
- KS-18 relay retry, klíč, expiresAt: **drží** — Whitelist, TTL 5 s / 15 s, supersede, admission beze změny.
- KS-19 řazení UI: **drží s výhradou** — Nová pole jsou jen zobrazení. Stav výsledku C4 (P2).
- KS-20 restart uprostřed: **PORUŠENO** — C2 úsek mezi kroky (P1). C3 děti `sending` → incident a C4 R2 → vstup nikdy jsou v pořádku.
- KS-21 dvě OAuth: **drží** — Jen leader. Route epoch při předčtení, doplnit do kontroly 2.
- KS-22 dva workery: **netýká se** — INV-WORKER-02 zůstává otevřený, změna ho nezhoršuje.
- KS-23 p-time/429: **drží** — ≤ 2k+1 zápisů; 429 → unknown + incident, bez opakování.
- KS-24 víkend: **netýká se** — —
- KS-25 deterministické testy: **částečně** — Seznam testů je dobrý, chybí scénáře z řádku „Chybějící testy“.
- KS-26 oddělení tvrzení: **drží** — Návrh výslovně říká, že nic není postavené ani ověřené u brokera.
