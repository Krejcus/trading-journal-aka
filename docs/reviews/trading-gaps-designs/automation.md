# Automatizace obchodu z LIVE — C6, C13, U14 (návrh 3. 11. 2026)

Skupina: automation.

- **Podklad:** `docs/reviews/trading-gaps-20261103.md`, kód worktree `scale-in` HEAD 7ae5c97b (web) / worker e37d7963.
- **Stav:** jen návrh. Nic neimplementováno, nic neověřeno u brokera.
- **Před implementací:** oponentura `copier-design-critic` na C6 a C13 (CLAUDE.md bod 4). U14 je UI + server notifikací, ale mění text INV-UI-04 a INV-MANUAL-01, takže také přes critic.

## 0. Společný rámec automatiky (C6 i C13)

Princip Filipa: „Filip rozhoduje o vstupech, appka o tom, kdy je konec.“ Automatika proto smí jen snížit riziko VLASTNÍ pozice z appky. Nikdy nesmí:

- otevřít, zvětšit ani otočit pozici,
- posunout SL dál od trhu,
- posunout TP.

**A1 Původ.** Každá automatická akce vychází z durable plánu nebo nastavení, které vzniklo příkazem přijatým relayí (`place-leader-entry`, `manage-leader-order`, `update-group`). Žádná nová cesta mimo relay (INV-RELAY-01, INV-MANUAL-01). Zápisy, které worker posílá sám, už existují a automatika se jim podobá:

- `reviewPendingScaleIns` → `cancelOwnManualEntry` (`services/copierRuntimeController.ts:3649–3765`),
- `autoFlattenCopies` (:11074),
- `maybeHandleArmExpiry` (:12349),
- samotná replikace kopírky.

**A2 Brány.** Automatický zápis jen za `gate.armed ∧ ¬shadowMode ∧ ¬killSwitch ∧ connected ∧ ¬managementOnly ∧ ¬pendingConnectionRecovery`. DISARM, kill i failClosed automatiku durable zastaví (`suspended`). Sama se nikdy neobnoví.

**A3 Zápis stejně jako ruční správa.**
1. Rozhodnutí synchronně z paměti, mimo `eventTail`.
2. Úloha ve frontě controlleru se startem do 2 s (jako `manageLeaderOrder`, :19995–20027).
3. Příprava bez REST: jen `broker.streamOrderSnapshot`, null = nic.
4. Durable `sending` všech nohou jedním zápisem (INV-OUTBOX-01).
5. Synchronní kontrola fence, generace, route epochy a bran.
6. Zápis MIMO frontu přes `dispatchBroker(generation)`.
7. Výsledek po nohách. `unknown` dořeší jen stream nebo čtení (`scheduleManualOrderActionLookup`), nikdy opakování.

**A4 Cena.**
- Jen kotace IBKR ve workeru: `options.manualEntryQuote('MNQ')` → `server/tvPriceStreamSupervisor.ts:388`, který vrací jen zdroj IBKR.
- Stejný konkrétní kontrakt jako pozice, čerstvost do 3 s (`workerMarketPrice`, `services/manualEntryPreview.ts:61`).
- TradingView nikdy (INV-UI-04).
- Bez čerstvé kotace se nic nestane. SL zůstane, kde je, a to je bezpečný směr.

**A5 Rozsah fáze 1.**
- Jen manual-only local-only DEMO skupina bez followerů, prostředí `demo`, MNQ.
- Instalační opt-in (vzor `scaleInEnabled`, `services/manualScaleIn.ts:19`) a capability workeru.
- Skupiny s followery (prop) až ve fázi 2, se samostatnou oponenturou. Důvod: každý automatický posun leadera se zrcadlí followerům a odmítnutý modify followera dnes končí režimem jen správy nebo fail-closed (CHART_ORDER_ENTRY_PLAN §10.3).

**A6 Restart.** Restart = DISARMED (INV-DEFAULT-01). Automatika se po restartu nikdy neobnoví; ARM stejně vyžaduje flat (INV-ARM-01).

### Navržený nový invariant INV-AUTO-01 (text do COPIER_INVARIANTS.md)

**INV-AUTO-01: Automatika pozice jen snižuje riziko vlastní pozice z appky, jen za ARMED a jen z plánu přijatého relayí.**

- **Proč:** worker zapisuje bez kliknutí uživatele. Žádná chyba nesmí zvětšit expozici ani přežít brzdu či restart.
- **Vynucuje:**
  - `services/positionAutomation.ts:automationStep` (čistá funkce),
  - `copierRuntimeController.ts:reviewPositionAutomation`,
  - `preparePositionStopMove({origin:'auto'})`,
  - `reviewWindowEndClose`,
  - `reviewPendingOwnEntries`.
- **Nikdy:**
  - posun SL dál od trhu, posun TP, nový vstup, přikoupení, otočení;
  - zápis za DISARMED, shadow, kill nebo management-only. Jediná výjimka je zrušení vlastního čekajícího vstupu podle INV-BRAKE-02;
  - cena z TradingView;
  - REST čtení ve frontě controlleru kvůli automatice;
  - opakování po `unknown`;
  - sjednocení rozjetých nohou;
  - obnova automatiky po restartu nebo po automatickém pokračování (INV-RECON-04);
  - zavření mimo vlastní lístky. Žádný account-wide fallback, na rozdíl od `autoFlattenCopies`.
- **Bezpečné:** přidat další pauzu nebo blokaci.
- **Nebezpečné:** použít automatiku jako důvod k ARM, k opakování nebo k „opravě“ divergence.

---

## C6 — automatický BE po X ticích a automatický trailing SL

### 1. Verdikt: STAVĚT-PO-CONFORMANCE

**Co se staví:** software BE a trailing. Worker sám posílá `modifyOrder` SL celé vlastní pozice, jen ochranným směrem, přes existující posun celé pozice (`scope: 'position'`).

**Podmínka:** před stavbou záznam na DEMO (§6). Rychlá série modify, SL blízko trhu ani prodleva IBKR proti Tradovate zatím zaznamenané nejsou.

**Zamítnutá část: nativní Tradovate `TrailingStop`.**
- Typ v systému není (`services/brokerPort.ts:23`).
- `supportedOrderType` (`services/tradovateBroker.ts:266`) ho neumí složit. Podle gap listu shodí sync streamu celého přihlášení.
- Kopírka ho nekopíruje.
- Platná pravidla: INV-TRAD-01/02 (neznámý tvar = neověřený stav) a povinný DEMO záznam, než se na něj jádro spolehne.
- Znovu otevřít až po opravě „nepodporovaný typ = cizí příkaz“ (riziko z gap listu) a po vlastním záznamu.

### 2. Chování pro uživatele

**PC — panel objednávky (`components/LiveOrderTicket.tsx`).** Nová skládací sekce „Automatika SL“, jen s capability `position-automation-v1`:

- „SL na BE po +X ticích zisku“ (výchozí X = 16) a „BE + n ticků“ (0–40, nápověda „+3 ≈ poplatky MNQ“).
- „Trailing“: start po +A ticích, vzdálenost D ticků, krok S ticků.
- Pojmenované šablony ATM, uložené lokálně v zařízení. Výchozí žádná.
- Text panelu: „worker posune SL nejvýš na BE+n a dál jen za cenou; nikdy dál od trhu, nikdy TP“.
- Odeslání beze změny (náhled → Odeslat). Plán jde s příkazem a uloží se k lístku.

**PC — graf po vstupu (`lib/liveChartOrderLines.ts`):**

- U čáry SL štítek „BE při 21 512,25“ (tečkovaná čára spouštěče) nebo „trail 20 t“.
- Čip stavu: aktivní / čeká na cenu IBKR / čeká (přikoupení) / pozastaveno — ruční posun / zastaveno — kopírka vypnutá / chyba.
- Menu pozice: „Automatika SL — vypnout / zapnout / upravit“.
- Tažení SL při aktivní automatice: po puštění dvoukrokově „Ruční posun automatiku pozastaví“, pak `move-stop`.
- Karta vlevo dole „SL posunut na BE 21 500 (automaticky)“ z `recentCopyEvents`, jen zobrazení.
- Push jen při pozastavení chybou.

**Telefon (`components/day/LivePhoneChart.tsx`, `lib/livePhoneOrders.ts`):**

- List objednávky má řádek „Automatika SL“ s výběrem šablony (stejné šablony jako PC).
- ⚡ z position boxu šablonu přenese.
- Holý Market z lišty automatiku nemá, protože nemá SL. Zapnout jde po „Přidat SL/TP“.
- V plném grafu čip stavu u SL. Podržení vybrané čáry SL nabídne „Vypnout automatiku“.
- OFF dál přes LIVE ▾ → Live Dashboard (INV-UI-02 beze změny).

### 3. Mechanismus

**Payload.** Validace na enqueue i claim straně relaye i ve workeru.

- `place-leader-entry` dostane volitelné `automation: { v:1, breakEven?: { triggerTicks, plusTicks }, trail?: { activateTicks, distanceTicks, stepTicks } }`.
  - Validace v `lib/leaderEntryPreview.ts:validateLeaderEntryPreview`: COMMAND_KEYS + whitelist vnořených klíčů, jen celá čísla.
  - Meze: `triggerTicks` 8–400, `plusTicks` 0–40, `triggerTicks ≥ plusTicks+8`, `distanceTicks` 8–400, `stepTicks` 2–100, `activateTicks ≥ distanceTicks`.
  - Je součástí `payloadHash`.
  - Neplatné u holého Marketu a u přikoupení (`position`). Pozice má jediný plán, ten z nejstaršího lístku.
- `manage-leader-order` dostane novou akci `set-automation` (`lib/leaderOrderManage.ts`, ACTIONS a KEYS):
  - jen `scope:'position'`, `entryOperationId` = nejstarší lístek;
  - `automation: plán | null` (null = vypnout);
  - `expect` = {SL pozice, |net|}.
- UI posílá nová pole jen s capability. Starý worker by jinak vrátil `invalid-relay-command-payload`.

**Worker — čistý modul `services/positionAutomation.ts` (bez IO):**

- `positionAutomationEnabled({optIn, group, brokerEnvironment})` — stejné podmínky jako `scaleInEnabled`.
- `validatePositionAutomationPlan(plan)`.
- `automationStep({ model: LeaderPositionModel, plan, state, quote, now, limits })` vrací `{kind:'none', why}`, `{kind:'move-stop', newPrice, cause:'be'|'trail'}` nebo `{kind:'pause', reason}`.

Pravidla `automationStep`:

- **Předpoklad:** `positionManageBlockers({action:'move-stop'})` (`services/manualScaleIn.ts:370`) nic nenajde. Tedy:
  - pozice ≠ 0, vlastní lístky, `ownOpen = |net|`;
  - žádné cizí příkazy, žádné čekající přikoupení;
  - vstupy plně vyplněné;
  - nohy `working`, potvrzené streamem, bez dílčího fillu;
  - jedna cena SL i TP.
- **Vstupy (long; short zrcadlově):**
  - `vwap` = vážený průměr `ticket.entryAvg`; null → none.
  - Trh = `workerMarketPrice(quote,'Sell',now)` a zároveň `quote.contract === model.symbol`.
- **BE:** když `trh − vwap ≥ triggerTicks·0,25`, kandidát = `floorTick(vwap + plusTicks·0,25)`.
- **Trailing:** aktivní od `highWater − vwap ≥ activateTicks·0,25`. Kandidát = `floorTick(highWater − distanceTicks·0,25)`. `highWater` je maximum trhu od aktivace, drží se jen v paměti.
- **Výsledná cena:** `newPrice = max(kandidátů)`. Posun jen když platí všechno:
  - `newPrice > SL`;
  - u trailingu navíc `newPrice − SL ≥ stepTicks·0,25`;
  - `trh − newPrice ≥ 8·0,25` (`MANUAL_TIGHTEN_MIN_TICKS`, :3437);
  - `newPrice < TP`.
- **Limity:**
  - rozestup zápisů aspoň 2 s;
  - nejvýš 30 zápisů na pozici a 200 na session;
  - po odmítnutí back-off 5 s;
  - 2 odmítnutí po sobě → `pause`.

**Worker — controller (`services/copierRuntimeController.ts`):**

- **Zapnutí:** `positionAutomationOn()` vedle `scaleInOn()` (:3550). Opt-in `options.positionAutomation` z pilota (`scripts/copier/pilot.ts`) a installer flag `--position-automation on`, který přežije reinstall.
- **`reviewPositionAutomation()`** je synchronní a bez IO. Volají ji:
  - `scheduleScaleInReview` (:3797) — po kroku každého eventu (:19708) a z 1s časovače (:19563); podmínku časovače rozšířit na „existuje aktivní automatika“;
  - nový posluchač kotace s throttlem 250 ms (supervisor `onQuote` v try/catch, nikdy nevyhodí — INV-WORKER-04).

  Při `move-stop` zařadí úlohu do `eventTail` stejně jako `manageLeaderOrder` (start do 2 s, jinak nic).
- **Refaktor `preparePositionAction` (:4804).** Jádro posunu SL (:4911–5059) vytáhnout do `preparePositionStopMove({origin:'manual'|'auto', operationId, payloadHash, model, next, deadlineAt, queuedFence})`.
  - Ruční cesta beze změny chování; `tests/manualScaleInReplay.test.ts` musí projít beze změny.
  - Auto větev nemá REST fallback. Snímek streamu null → `not-sent: stream-unavailable`.
  - Před zápisem znovu `automationStep` nad cache: týž SL, kotace do 3 s, stejný `newPrice`.
  - Dále `gate.armed ∧ ¬shadow ∧ ¬kill`, fence, generace, route epoch a `manageReachBlockers`.
  - Kontrola utažení (:4923–4928) zůstává.
- **Záznamy:**
  - `CopierManualOrderActionRecord` (`services/copierEngine.ts:395`) dostane `origin?:'auto'`.
  - operationId `manage:auto-<base>-<seq>`, nohy `~n`, deadline now + 8 s.
- **Durable stav** `safety.positionAutomations[]` (typ v `copierEngine.ts`):
  - pole `{ key: positionManageKey(symbol), baseEntryOperationId, symbol, plan, state:'active'|'paused-manual'|'paused-error'|'suspended'|'done', writes, lastWriteAt, lastStop, reason?, updatedAt }`;
  - zápis patchem přes `persistSafety` (poučení 21.–22. 10.);
  - plán vstupu je uložen i v `manualEntries[].automation`.
- **Přechody stavu:**
  - ruční `move-stop`/`move-target` celé pozice → `paused-manual`, ve stejném commitu jako `sending` nohou;
  - změna SL ze streamu, kterou automatika neposlala (Tradovate UI) → `paused-manual`;
  - zavření nebo flat → `done`;
  - DISARM, kill, failClosed, management-only, disconnect → `suspended`;
  - bootstrap: každé `active` → `suspended` (vedle :19494–19503);
  - noha `rejected` dvakrát nebo `unknown` → `paused-error`;
  - `set-automation`: zapnout jen za ARMED, vypnout vždy (bez zápisu k brokerovi).
- **Mutex:** jeden zápis pozice naráz (`positionActionsInFlight`, :4817).
  - Ruční příkaz během automatického zápisu dostane `busy` (nejvýš 8 s).
  - Automatický krok se nespustí, když běží ruční změna nebo je na symbolu nevyřešený záznam.
- **Status:** `leaderPositions[].automation` (typ :239, builder :21116) — plán, stav, příští spouštěč, důvod. Jen zobrazení.
- **Capability:** `position-automation-v1` (`lib/copierWorkerCapabilities.ts`, agent `server/localCopierExecutionAgent.ts:405–421`).

**Relay, admission, migrace:**

- Relay jen validuje (`server/tradovateCopierCommandRelay.ts:378–380`).
- Admission RPC beze změny: `set-automation` se počítá jako manage, strop 100/24 h, busy podle `entryOperationId`.
- Zneplatnění brzdou v SQL (`expirePendingEntriesSupersededByBrake`, :975, a RPC brzdy) se nemění:
  - čekající `set-automation` po brzdě odmítne agent (`brake-after-request`, :971); `set-automation` NENÍ ve výjimce;
  - za DISARMED automatika stejně neběží.
- **Migrace: ne.**
- Automatické zápisy nejdou přes relay, protože nejsou ručním příkazem. Worker proto drží vlastní rozpočet zápisů (INV-TRAD-04).

### 4. Dotčené INV

- **INV-DEFAULT-01** — plán z disku se nikdy neobnoví jako `active`; bootstrap → `suspended`.
- **INV-DEFAULT-02** — chyba automatiky = pauza + upozornění, nikdy auto-close. Incident jen existujícími cestami (`unknown` noha, pozice bez SL/TP).
- **INV-ARM-01/04** — ARM beze změny; shadow nikdy nezapisuje (A2).
- **INV-BRAKE-01/02** — DISARM i kill automatiku zastaví. Žádná nová výjimka pod kill; do INV-BRAKE-02 doplnit „automatický posun SL není výjimka“.
- **INV-BRAKE-03** — příprava bez REST, start do 2 s, zápis mimo frontu. Brzdy dál obcházejí FIFO.
- **INV-OUTBOX-01/02/03** — durable `sending` všech nohou. `unknown` blokuje další automatiku i ruční posun pozice (`manage-unresolved`). Částečný úspěch → `paused-error`, žádné dorovnání nohou.
- **INV-FRESH-01** — fence, generace a route epoch synchronně před zápisem.
- **INV-RELAY-01/03/04** — plán jen z relay příkazu; brzda ruší `set-automation` přes agenta; kotace nejde Realtime kanálem a nic neautorizuje.
- **INV-TRAD-02/04** — dílčí fill nohy = nic. Rozpočet zápisů. Snímek streamu je null při rate limitu nebo penalizaci, takže automatika stojí.
- **INV-MODE-01** — management-only = `suspended`.
- **INV-MANUAL-01** — přidat odrážku „Automatika pozice (C6)“ s odkazem na INV-AUTO-01.
- **INV-UI-01..04** — stav jen z čerstvého statusu. Nový text do INV-UI-04: IBKR smí ve workeru spustit automatický posun SL jen ochranným směrem. Je to rozšíření Filipova „jen IBKR pro risk“ a vyžaduje jeho výslovný souhlas.
- **INV-RECON-04** — po automatickém pokračování zůstává automatika `suspended`. `unknown` automatická akce blokuje pokračování stejně jako ruční.
- **INV-DIVERGENCE-01** — rozjeté nohy se nikdy nesjednocují automaticky.
- **INV-WORKER-02** — mutex jen v procesu. Dvě instance workeru by poslaly dvojí modify; otevřené stejně jako dnes.
- **INV-AUTO-01** — nový invariant.

### 5. Selhání a fail-closed

- **Restart uprostřed zápisu:** nohy `sending` → `unknown` při startu (:19494–19503) a dořeší je čtení. Automatika `suspended`, kopírka DISARMED, ARM chce flat, takže automatika nikdy nepokračuje. UI: „Automatika zastavena (restart), SL je na X“.
- **Částečný úspěch nohou:** výsledek po nohách („potvrzeno u x z y“) → `paused-error`. Další posun blokuje `legs-diverged`. Uživatel řeší ručně v Tradovate nebo zavřením; nic se nedorovnává.
- **Broker vrátí `InvalidPrice`** (trh přeskočil nový SL mezi kotací a POSTem; záznam 30. 10.): SL zůstane beze změny, back-off 5 s. Po druhém odmítnutí `paused-error` a push.
- **SL se vyplní během modify:** existující větev (`waived` nebo flat) → `done`.
- **Zastaralý stream nebo IBKR:** snímek null, kotace starší než 3 s nebo jiný kontrakt (týden rollu) → nic. Status ukáže „čeká na stream / cenu IBKR“; SL zůstává.
- **DISARM nebo kill během operace:** před zápisem → `not-sent` (generace / `CopierDispatchRevokedError`). Po POSTu výsledek doběhne. Automatika `suspended`.
- **Vypršení ARM nebo konec session:** DISARM předchází `autoFlattenCopies` (:12349), takže automatika je `suspended` dřív, než zavírání začne.
- **Ruční zásah:** ruční posun nebo změna v Tradovate → `paused-manual`. Automatika s člověkem nebojuje.
- **Rate limit nebo p-ticket:** snímek null → nic. Chyba zápisu s penalizací → `paused-error`. Nikdy rychlejší pokus.
- **Přikoupení:** dokud čeká, automatika čeká. Po fillu se VWAP přepočte; BE se počítá bez stavu přímo z modelu.

### 6. DEMO conformance (DEMO8661118, MNQ)

Skript `scripts/copier/record-auto-trail.ts` + čistý `recordAutoTrailPlan.ts`.

**Podmínky běhu:** kopírka DISARMED, otevřený trh. Spouští Filip, nebo Claude po jeho výslovném „spusť“. Po záznamu read-only `reconcile` před ARM. Anonymizovaná fixture `tests/fixtures/tradovate-leader-auto-trail.json`.

**Scénáře:**
1. Market OSO 1 MNQ (SL 40 t, TP 80 t). 20× modify SL ochranným směrem po 1 s (+2 t), pak 10× po 250 ms. Zaznamenat časy ACK a `stream-replaced` a jakékoli 429, `p-ticket` nebo `p-time`.
2. Modify SL na 8 t a 4 t pod bid IBKR a 1 t přes trh. Přijato, `InvalidPrice`, nebo okamžitý fill? Dnes NEOVĚŘENO.
3. Pozice ze 3 lístků (Market + 2 Market přikoupení): 5 kol souběžného 3× modify po 1 s.
4. Prodleva IBKR proti Tradovate: časy kotací IBKR vedle Fill/Position eventů a ACK modify; rozdělení odchylky v ticích.
5. Rychlý trh: modify 9 t od bid. Pořadí Replaced vs. Filled, když trh projde novým SL během POSTu.
6. Úklid: liquidate, flat bez příkazů.

Výsledek záznamu určí rozestup, krok, rozpočet a minimální X.

### 7. Testy

**`tests/positionAutomation.test.ts`** (čistá logika, mutačně):
- BE přesně na X ticích;
- nikdy od trhu — záměna `>` za `>=` nebo směru musí test shodit;
- nikdy za TP; aspoň 8 ticků od trhu; zaokrouhlení k ochraně; long i short;
- krok, rozestup, rozpočet;
- stará kotace, jiný kontrakt, `entryAvg` null, čekající přikoupení, rozjeté nohy, dílčí fill → none;
- validace plánu.

**`tests/positionAutomationReplay.test.ts`** (controller s fixture přikoupení + umělá kotace):
- BE proběhne jednou; trailing jde po krocích;
- DISARM mezi přípravou a zápisem → `not-sent`; kill → žádné volání brokera; shadow → nic;
- restart v `sending` → `unknown` + `suspended`;
- `InvalidPrice` 2× → `paused-error`;
- `unknown` noha blokuje ruční posun;
- ruční posun během automatického zápisu → `busy`, pak `paused-manual`;
- změna ze streamu → `paused-manual`;
- snímek null → žádný REST; změna route epochy → `not-sent`;
- vypršení ARM → `suspended` dřív než auto-close.

**Relay a agent:**
- `tests/leaderEntryPlace.test.ts`, `tests/tradovateCopierCommandRelay.test.ts` — whitelist `automation`, akce `set-automation`, payloadHash;
- `tests/localCopierExecutionAgent.test.ts` — `set-automation` po brzdě = `brake-after-request`.

**Ostatní:**
- Statický test: `positionAutomation.ts` nesmí importovat nic z TV kanálu (rozšířit `tests/tvPriceClientGuards.test.ts`).
- UI: `tests/liveScaleIn.test.ts`, `tests/liveChartOrderLines.test.ts`, `tests/livePhoneOrders.test.ts`.
- `tests/recordAutoTrailPlan.test.ts`.

### 8. Soubory

- **Worker a jádro:** `services/positionAutomation.ts` (nový), `services/copierRuntimeController.ts`, `services/copierEngine.ts`, `services/manualScaleIn.ts`, `server/tvPriceStreamSupervisor.ts` (`onQuote`).
- **Protokol, relay, agent:** `lib/leaderEntryPreview.ts`, `lib/leaderEntryPlace.ts`, `lib/leaderOrderManage.ts`, `lib/copierWorkerCapabilities.ts`, `server/localCopierExecutionAgent.ts`, `server/tradovateCopierCommandRelay.ts` (jen validace).
- **Instalace a záznam:** `scripts/copier/pilot.ts` + installer, `scripts/copier/record-auto-trail.ts`, `scripts/copier/recordAutoTrailPlan.ts`.
- **UI:** `components/LiveOrderTicket.tsx`, `lib/liveOrderTicket.ts`, `components/TradovateLiveDesk.tsx`, `lib/liveChartOrderLines.ts`, `components/day/LivePhoneChart.tsx`, `lib/livePhoneOrders.ts`.
- **Dokumentace a testy:** `docs/COPIER_INVARIANTS.md`, testy z §7.

### 9. Velikost a závislosti

**L.** Závisí na:
- modelu pozice a správě `scope:'position'` (nasazeno 3. 11.);
- záznamu z §6;
- Filipově souhlasu s IBKR jako spouštěčem.

Šablony ATM může sdílet s U14 (volitelné).

---

## C13 — zavření leadera při denní ztrátě, denní cíl zisku, zavření na konci okna

### 1. Verdikt: JEN-ČÁST

**Stavět:**
- **(a) Denní cíl zisku** — nové pravidlo dne `daily-profit`. Zámek nebo pauza, čeká na flat, nic neobchoduje.
- **(b1) Time-in-force vlastních čekajících vstupů z flat.** Zrušení 5 min před koncem okna, session nebo ARM a při day locku (i čekajícím), pauze a kill. Dnes to umí jen přikoupení.
- **(b2) Opt-in zavření vlastní pozice na konci posledního okna.** Jen pozice složená z lístků appky, jen manual-only DEMO ve fázi 1.

**Nestavět — automatické zavření leadera při denní ztrátě:**
- **Obchody mimo lístky appky** (TradingView, Tradovate, followeři). Šlo by o „strážce flattenujícího ruční obchody“, kterého Filip 3. 9. 2026 výslovně zamítl (rozhodnutí o broker-side zámku). INV-BRAKE-04 navíc zakazuje použít zámek jako důvod k zavírání uprostřed expozice. INV-DEFAULT-02 nedovoluje vykládat fail-closed jako povolení k libovolnému Flattenu.
- **Vlastní lístky** už denní ztrátu drží přes SL. Vstup, přikoupení i posun SL dál od trhu projdou jen tehdy, když ztráta při SL ≤ rezerva bez otevřeného P&L (`realizedLossHeadroom`, :4942, :5254). SL tedy je zavření při limitu (± skluz).
- **Spouštěč z otevřeného P&L** by potřeboval cenu. Risk snímek brokera chodí po 30 s (:2036) a platí do 90 s, což je pozdě. IBKR jako spouštěč zavření by bylo nové rozhodnutí Filipa (INV-UI-04).
- **Holý Market bez SL** (jen ruční DEMO, vědomě bez stropu, INV-MANUAL-01) — řešením je „Přidat SL/TP“, ne auto-close.

**Konec session** už kryje vypršení ARM: TTL běží do konce session (agent :1204) a manual-only DEMO má `armExpiryFlatten:'group'` (`services/liveCopyTrading.ts:221`).

### 2. Chování pro uživatele

**PC — Risk záložka a nastavení skupiny:**
- **Cíl zisku:**
  - Pole „Denní cíl zisku (USD)“ + akce (zámek / pauza N min).
  - Hlavička LIVE: „Cíl dne 300 $ · zbývá 120 $“.
  - Po dosažení banner „Cíl dne splněn — po zavření pozice se den zamkne“ (stejně jako u daily-loss).
  - Panel objednávky blokuje nové vstupy (dnešní brána čekajícího zámku).
- **Zavření na konci okna:**
  - Volba „Na konci okna zavřít pozici z appky“ (jen ruční DEMO, výchozí vypnuto).
  - 5 min před koncem okna karta „Čekající vstup zrušen — konec okna za 5 min“.
  - Na konci okna karta „Pozice zavřena — konec obchodního okna“, pak zámek dne (výchozí akce okna).
  - Pozice s kontrakty nebo příkazy mimo appku se nezavře. Přijde push „Okno skončilo — pozice obsahuje kontrakty mimo appku, zavři ji ručně“.

**Telefon:** stejné notifikace (route `live:overview`), čip „cíl dne splněn“ v hlavičce grafu, nastavení v Risk záložce. OFF beze změny.

### 3. Mechanismus

**(a) Denní cíl zisku — bez zápisu k brokerovi**

- **`services/liveCopyTrading.ts`:**
  - `CopyGroupSafetySettings.dailyProfitTargetUsd` (0 = vypnuto);
  - `CopyGroupDayRuleActions.dailyProfit: { atLimit: CopierRuleAction }` (výchozí `lock`);
  - `DayLockTrigger` += `'daily-profit'`;
  - `sanitizeDayRuleActions` (:172) a `sanitizeCopyGroupSafety` dají starým skupinám default, neplatná hodnota = null (fail-closed).
- **`lib/copierRiskConfig.ts:isWeakerRiskConfig` (:118):**
  - `comparePositiveSafetyLimit('dailyProfitTargetUsd')` — zvýšení nebo vypnutí cíle = zmírnění, za ARMED v session zakázané;
  - nová dvojice akcí v `ruleActions`.
- **Controller `evaluateDailyRules` (:6517):**
  - `dailyProfitPnl(stats, at)` = **max(ledger hrubý, broker čisté)**. Platí stejné podmínky jako u `dailyLossPnl` (:6506): bezchybný snímek do 90 s, stejná session, `tradeDate`. Dřívější zámek = nikdy volnější;
  - `addCandidate('daily-profit', …)`;
  - zámek čeká na flat (`maybeEngageDayLock`, :6862).
- **Další místa:** `services/copierDailyRules.ts:dayLockRuleLabel`, status `dailyStats`, UI Risk záložky.
- **Migrace ne** — konfigurace skupiny je JSON (`copy_groups.config jsonb`).

**(b1) Time-in-force čekajících vstupů**

- **Zobecnění:** `reviewPendingScaleIns` (:3719) se změní na `reviewPendingOwnEntries` pro každý vlastní pracující Limit/Stop vstup bez fillu, nejen pro přikoupení.
- **Nová čistá `pendingEntryViolation`** v `services/manualScaleIn.ts` (sdílí tělo s `pendingAddViolation`, :328).
- **Důvody ke zrušení u vstupu z flat:**
  - kill;
  - day lock, i čekající;
  - pauza;
  - management-only;
  - nezpůsobilý leader;
  - konec okna, i do 5 min;
  - konec session do 5 min;
  - vypršení ARM do 5 min.
- **Kdy se neruší:** ne při prostém OFF a ne podle pozice. Důvod je INV-BRAKE-01 (DISARM není obecný příkaz k zavření) a čekající OSO má po fillu vlastní SL/TP. Zrušit jde dál ručně křížkem. Zůstává jako otevřená otázka pro Filipa.
- **Provedení** přes `cancelOwnManualEntry` (:3649):
  - jeden pokus, raw broker, smí i pod kill;
  - durable značka `cancel`;
  - selhání = incident (`failClosed` bez auto-close).
- **Časovač** :19563 rozšířit na „existuje vlastní čekající vstup“.
- **Rozsah:** fáze 1 jen manual-only DEMO. Skupiny s followery až s predikátem pokrytí jako u `cancel-entry` (:5144–5149).

**(b2) Zavření na konci okna**

- **Nastavení** `CopyGroupSafetySettings.windowEndClose: 'off'|'own-position'`. Výchozí `off`, i v `manualOnlyDemoSafety`. Sanitizer; tighten-only (`own-position → off` = zmírnění).
- **Kdy se kontroluje:** controller `reviewWindowEndClose()` volaný z heartbeatu (:16277–16287, za `evaluateDailyRules`) a z 1s časovače.
- **Podmínky zápisu (musí platit všechny):**
  - opt-in a zapnuté okno;
  - `isAfterTradingWindowsAt` (`services/copierDailyRules.ts:65`), stejně jako kandidát window-end (:6645);
  - `gate.armed ∧ ¬shadow ∧ ¬kill ∧ connected`;
  - skupina je manual-only DEMO;
  - `leaderPosition(symbol)` (:3560) ≠ 0 a `positionManageBlockers({action:'close-position'})` nic nenajde (expect si worker vezme z modelu);
  - na symbolu není nevyřešený záznam a neběží Flatten.
- **Četnost:** nejvýš jeden zápis za session (paměť + durable záznam `manage:auto-wend-<sessionEndAt>`). Kontroly se opakují, dokud zápis nezačne.
- **Provedení:**
  - zavírací větev `preparePositionAction` (:4876–4910) vytáhnout do `preparePositionClose({origin:'auto-window-end', operationId})` a volat `executeClose` (:4257);
  - tag `mclose…` brát z operationId bez předpokladu prefixu z UI;
  - brány těsně před zápisem beze změny (ARMED, generace, fence, Flatten, jiný zápis, ingress, nohy).
- **Výsledek** jen ze stavu u brokera (INV-MODE-02). Pozice bez SL/TP = incident bez auto-close (beze změny).
- **Cizí kontrakty nebo příkazy** → žádný zápis, jen audit `blocked` + karta/push. Watchdog jen notifikuje.
- **Zámek okna** (`windowEnd.atEnd`) se nemění a čeká na flat.
- **Relay, admission, migrace:** nic nového. Nastavení jde stávajícím `update-group` (tighten-only).

### 4. Dotčené INV

- **INV-RISK-02** — doplnit text: pravidlo `daily-profit` (blokuje vstupy, zámek po flat) a opt-in zavření vlastní pozice na konci okna jako jediná automatika okna. „Ukončit správu ochrany kvůli konci okna“ zůstává zakázané.
- **INV-BRAKE-04** — zámek dál čeká na flat a sám nic nezavírá. Zavření je samostatná opt-in akce cílená na vlastní lístky, nikdy account-wide.
- **INV-BRAKE-05** — obdoba vypršení ARM, ale bez account-wide fallbacku a jen za ARMED.
- **INV-BRAKE-02** — doplnit text: výjimku „zrušení čekajícího přikoupení pod kill“ rozšířit na každý vlastní čekající vstup (jen zrušení, jeden pokus).
- **INV-BRAKE-01** — prosté OFF čekající vstup z flat neruší.
- **INV-DEFAULT-02** — žádný account-wide fallback; nejasný stav = žádný zápis + upozornění.
- **INV-MODE-02** — liquidate se potvrzuje stavem.
- **INV-OUTBOX-01/02** — durable `sending`, restart → `unknown`, dořešení čtením.
- **INV-ARM-04** — shadow nic nedělá.
- **INV-RISK-04** — časy jen přes sdílené helpery.
- **INV-RISK-01 / tighten-only** — nová pole jdou za session jen zpřísnit.
- **INV-RECON-04** — automatické pokračování po zámku nebo konci okna neběží (beze změny).
- **INV-UI-03** — „zbývá do cíle“ je jen zobrazení.
- **INV-WATCH-01** — watchdog jen notifikuje.
- **Nový INV-AUTO-02:** zavření na konci okna je opt-in, jen pro vlastní pozici z lístků appky, jen za ARMED, jeden zápis za session, výsledek ze stavu; cizí kontrakty = jen upozornění.

### 5. Selhání a fail-closed

**Cíl zisku:**
- Snímek brokera chybí, je starý nebo z jiného dne → platí ledger. Hrubý ledger ≥ čisté P&L, takže zámek nastane dřív, tedy bezpečně.
- Restart: varování jsou durable a zámek se znovu vyhodnotí (:6526–6543).
- Změna pravidla za session jde jen zpřísnit.

**TIF zrušení:**
- Selhání zrušení = incident (jako u přikoupení).
- Vstup se mezitím vyplnil → nic se neruší, jen audit; pozice má OSO nohy.
- Po restartu durable značka `cancel` brání druhému pokusu.
- Vstup z flat se ruší jen podle času a pravidel dne, ne podle pozice.

**Zavření na konci okna:**
- Restart před koncem okna → DISARMED → nic. Pak platí vypršení ARM nebo ruční Flatten.
- Restart ve stavu `sending` → `unknown`, dořeší čtení pozice.
- Nohy zrušené a Market neprošel → incident (`raiseUnprotected`, :4297).
- DISARM nebo kill mezi rozhodnutím a zápisem → `not-sent` (`executeClose`, :4266); zámek dál čeká na flat.
- Souběžný Flatten → leader je „nejasný zápis“ (precedens fáze 2d).
- `net` null ze zastaralého streamu → žádný zápis, kontrola se opakuje.
- Skupiny s followery jsou ve fázi 1 vypnuté.

### 6. DEMO conformance

Nové chování brokera se nezavádí:
- liquidate je zaznamenaný ve fázi 2d (30. 10.);
- přikoupení fáze 0/0b (3. 11.): liquidate zruší i čekající přikoupení do 500 ms;
- zrušení vstupu zruší jeho nohy za ~25 ms.

Před zapnutím jen **akceptační běh** na DEMO8661118 MNQ (není to conformance):
1. Okno nastavit na „teď + 3 min“, otevřít pozici z 1–2 lístků a přidat čekající Limit vstup.
2. Ověřit zrušení vstupu v −5 min, zavření pozice na konci okna a zámek dne.
3. Nastavit cíl zisku 5 $ a ověřit zámek po flat.

### 7. Testy

**`tests/copierDailyProfitRule.test.ts`:**
- zámek až po flat; varianta pauza;
- max(ledger, broker); starý nebo cizí `tradeDate` → ledger;
- restart;
- tighten-only — záměna srovnání musí test shodit.

**`tests/manualEntryTimeInForce.test.ts`:**
- zrušení v −5 min okna, session i ARM; při čekajícím zámku, pauze a kill;
- NE při prostém OFF;
- vyplněný vstup se neruší;
- selhání = jeden incident;
- restart se značkou = žádný druhý pokus;
- Market nikdy.

**`tests/copierWindowEndClose.test.ts`** (replay fixture přikoupení, falešné hodiny):
- vypnuto → nic;
- zapnuto + ARMED → jeden liquidate a `acknowledged` ze stavu;
- cizí příkaz → žádný zápis + audit;
- DISARM, kill, shadow → nic;
- restart v `sending` → `unknown` → dořešeno;
- druhý heartbeat → žádný druhý zápis;
- zámek po flat;
- odstranění kontroly ARMED musí test shodit.

**Rozšířit:** `tests/copierRiskConfig.test.ts`, `tests/copierDailyRules.test.ts`, `tests/copierDayRuleActions.test.ts`, UI Risk záložky.

### 8. Soubory

- `services/liveCopyTrading.ts`
- `lib/copierRiskConfig.ts`
- `services/copierDailyRules.ts`
- `services/copierRuntimeController.ts`
- `services/manualScaleIn.ts`
- `services/copierEngine.ts`
- komponenty Risk záložky a nastavení skupiny
- `components/LiveTradeToasts.tsx`
- `server/copierIncidentWatchdog.ts` (jen texty)
- `docs/COPIER_INVARIANTS.md`
- testy z §7

### 9. Velikost a závislosti

**M** (a = S, b1 = S, b2 = M). Závisí na modelu pozice a `executeClose`; obojí je nasazené. Refaktor `preparePositionClose` sdílí s C6.

---

## U14 — upozornění / TradingView webhook → příkaz

### 1. Verdikt: JEN-ČÁST

**Stavět — bezpečná podmnožina:**
- Upozornění smí nést **připravený příkaz**.
- Při spuštění přijde karta nebo push s akcí „Připravit příkaz“. Ta otevře LIVE graf s vyplněným panelem (PC) nebo listem objednávky (telefon).
- Odeslání vždy jen tlačítkem Odeslat po čerstvém náhledu, stávající cestou `place-leader-entry` se všemi branami.
- Fáze 1: vlastní upozornění na cenu (spouští je IBKR, úroveň zadal uživatel).
- Fáze 2: TradingView webhook, jen strana + šablona.

**Nestavět:**
- automatické odeslání z upozornění ani z webhooku;
- akci „Odeslat“ v notifikaci, Live Activity nebo widgetu;
- prefill telefonní lišty (okamžitý Market);
- cenu příkazu z TV `{{close}}`;
- serverové zařazení obchodního příkazu.

**Proč ne plná automatizace:**
1. **INV-MANUAL-01 + INV-FRESH-03.** Příkaz nese záměr (`armedAt`, `groupConfigHash`, kontrakty followerů) z čerstvého statusu, který viděl uživatel. Webhook ani server ho nemají a vymyslet ho nesmějí.
2. **INV-WATCH-01 / INV-RELAY-04.** Server (cron, watchdog, webhook) nesmí řídit execution a kanály nenesou příkazy. Plná automatizace by byla první serverová cesta risk-zvyšujícího příkazu.
3. **Autentizace.** Webhook má token v URL (`api/tradingview/alert-webhook.ts`, `?token=`) bez druhého faktoru. Kdo zná URL (logy, sdílené upozornění, servery TV), vystřelí ho. Smí proto nanejvýš poslat notifikaci.
4. **INV-UI-04.** `{{close}}` jsou data z TradingView a ta nikdy nevstupují do příkazu ani rizika.
5. **Pravidlo Filipa z 29. 10.** „⚡ v live jen vyplní panel.“ Jediná výjimka je výslovné klepnutí na lištu telefonu; upozornění klepnutí není.
6. **Opakování webhooků.** Webhooky se mohou opakovat. Idempotence by stála na obsahu upozornění, ne na záměru uživatele (INV-RELAY-01).
7. **Disciplína a propky.** „Filip rozhoduje o vstupech“ — vstup bez člověka obchází denní disciplínu. Pravidla propek k automatizaci jsou NEOVĚŘENÁ.

### 2. Chování pro uživatele

**PC:**
- V nastavení upozornění (`lib/priceAlerts.ts`) nová sekce „Při spuštění připravit příkaz“ (výchozí vypnuto):
  - strana;
  - vstup: Limit na úrovni upozornění / Stop na úrovni / Market;
  - šablona SL/TP (ticky, R nebo ATM šablona z C6);
  - velikost (riziko v $ nebo kontrakty).
- Při spuštění karta vlevo dole „Upozornění 21 480 ↑ · připraven Buy Stop 21 480, SL 12 b, TP 2R“ s tlačítkem „Do panelu“ (platí 60 s).
- Klik vyplní panel stejně jako ⚡ (`draftFromPositionBox`) a nakreslí čáry se štítkem „z upozornění · před 12 s“.
- Nic neodejde. Odeslat dál vyžaduje čerstvý náhled.
- Limit na špatné straně trhu ukáže problém panelu (`ticketProblems`); typ příkazu se potichu nepřepíná.

**Telefon:**
- APNs push s akcí „Připravit příkaz“, nikdy „Odeslat“. Otevře LIVE graf s vyplněným listem objednávky.
- Spodní lišta (holý Market) se z upozornění nikdy nepředvyplní.
- Bez čerstvého statusu, za OFF nebo za zámku list ukáže důvod jako dnes.
- Nová kategorie notifikace vyžaduje nový build iPhonu.

**TradingView (fáze 2):**
- Zpráva smí nést `"side":"buy|sell"` a `"draft":"<šablona>"`.
- Push: „TV: <název> · připravit Buy (šablona X)“.
- Panel dostane stranu a šablonu. Vstup = Market (cena panelu z IBKR) nebo prázdný Limit k zadání. Cena z TV je jen text.

### 3. Mechanismus

**Migrace — minimální, odůvodněná:**
- `alter table public.price_alerts add column if not exists order_draft jsonb` + check `order_draft is null or (jsonb_typeof(order_draft)='object' and pg_column_size(order_draft) <= 512)`.
- V `price_alerts_before_update` (`supabase/migrations/20261102140000_price_alerts.sql:118–176`) v serverové větvi `new.order_draft := old.order_draft`. Změna draftu nezvyšuje `version`, protože draft není podmínka spouštění.
- Fáze 2: `alter table public.tv_alerts add column if not exists order_draft jsonb` + stejný check.
- **Proč migrace:** upozornění se sdílí PC ↔ telefon přes server a sloupce `line`/`channels` mají vlastní sémantiku i limity. RLS a granty jsou tabulkové, beze změny.

**`lib/alertOrderDraft.ts` (nový, čistý, bez importu desku a relaye):**
- typ `AlertOrderDraft { v:1; side; entry:'alert-limit'|'alert-stop'|'market'; stopTicks; target:{r}|{ticks}; sizing:{riskUsd}|{quantity} }`;
- `validateAlertOrderDraft`;
- `ticketDraftFromAlert(draft, level, quote, instrument)` přes `newTicketDraft`/`withEntryPrice`/`withBracket` (`lib/liveOrderTicket.ts`);
- `alertDraftUsable` (do 60 s);
- draft z TV nikdy nenastaví cenu vstupu.

**Úložiště upozornění:** `services/priceAlertServerStore.ts` a `lib/priceAlerts.ts` dostanou pole `orderDraft`.

**`server/priceAlertOutbox.ts` (:81–101):**
- číst `order_draft`;
- s draftem push `category:'ALPHATRADE_ALERT_DRAFT'`, data `{route:'live:chart', alertId, eventId}`;
- bez draftu beze změny.

**Notifikace a UI:**
- `services/nativeNotifications.ts`: akce `prepare-order` jen naviguje (`navigateNativeShell`), nikdy nic neposílá. Doplnit route `live:chart`.
- PC: `components/LiveTradeToasts.tsx`, `components/LiveTradingScreen.tsx`, `components/LiveOrderTicket.tsx`.
- Telefon: `components/day/LivePhoneChart.tsx`, `lib/livePhoneOrders.ts`.

**Fáze 2:**
- `server/tvAlertNotifications.ts:validateTradingViewAlertPayload` (:30) přijme volitelné `side` a `draft` (do 40 znaků, `[a-z0-9 _-]`).
- `api/tradingview/alert-webhook.ts` je uloží do `tv_alerts.order_draft`.
- Šablona se dohledá v appce.

**Relay, worker, admission:** beze změny. Žádný nový copy-command.

### 4. Dotčené INV

- **INV-MANUAL-01** — jediný risk-zvyšující příkaz zůstává `place-leader-entry` z kliknutí uživatele. Doplnit text: „Upozornění smí jen předvyplnit panel nebo list, nikdy neodešle.“
- **INV-UI-01/03** — prefill je jen zobrazení; starý nebo obnovený status odeslání nepovolí.
- **INV-UI-02** — cesta k OFF beze změny.
- **INV-UI-04** — cena z TV nikdy do ceny příkazu ani do prefillu. Doplnit do odstavce „Upozornění“: draft smí použít jen úroveň uživatele.
- **INV-FRESH-03** — Odeslat jen nad čerstvým statusem.
- **INV-RELAY-01/04** — žádný nový příkaz; push ani Realtime nenesou nic k vykonání.
- **INV-WATCH-01** — webhook, cron ani drain fronty nikdy nezařadí obchodní příkaz.
- **INV-WORKER-04** — hlídač upozornění beze změny.
- **Pravidlo Filipa ⚡** — rozšířené i na upozornění.

### 5. Selhání a fail-closed

- Draft starší než 60 s → tlačítko zmizí.
- Upozornění mezitím smazané nebo změněné, případně neplatný draft → nic se nevyplní.
- Push za OFF, zámku nebo nečerstvého workeru → panel se vyplní, ale Odeslat je blokované.
- Dvojí klepnutí → prefill je idempotentní.
- Neznámá šablona z TV → jen notifikace.
- Špatný token nebo překročený limit → beze změny (401/429).
- Nic z toho nevytvoří řádek v `tradovate_copier_commands`.

### 6. DEMO conformance

U brokera žádná, nic se neposílá. Ověřit:
- iPhone: kategorie notifikace, akce, deep link, lišta zůstane nedotčená;
- PC: karta „Do panelu“;
- jeden ruční běh na DEMO8661118: upozornění s draftem → panel → Odeslat → běžný vstup se všemi branami.

### 7. Testy

- **`tests/alertOrderDraft.test.ts`:** validace; každý typ vstupu; starší než 60 s → null; TV draft nikdy nenastaví cenu; Limit na špatné straně → problém panelu.
- **`tests/alertOrderDraftGuards.test.ts`** (statický): `lib/alertOrderDraft.ts`, `server/priceAlertOutbox.ts`, `api/tradingview/alert-webhook.ts` ani `services/nativeNotifications.ts` neimportují cestu odeslání (`placeLeaderEntry`, `buildLeaderEntryPlaceCommand`, relay execute).
- **`tests/sql/priceAlerts.pg.mjs`:** check `order_draft`, serverová větev draft zachová.
- **Další:** `tests/priceAlerts.test.ts`, testy webhooku TV, `tests/livePhoneOrders.test.ts`.

### 8. Soubory

- **Databáze:** `supabase/migrations/<ts>_alert_order_draft.sql`.
- **Logika upozornění:** `lib/alertOrderDraft.ts`, `lib/priceAlerts.ts`, `services/priceAlertServerStore.ts`, `server/priceAlertOutbox.ts`.
- **Notifikace a navigace:** `services/nativeNotifications.ts`, `lib/liveOverviewRoute.ts`.
- **UI:** `components/LiveTradeToasts.tsx`, `components/LiveTradingScreen.tsx`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneChart.tsx`, `lib/livePhoneOrders.ts`.
- **Fáze 2:** `server/tvAlertNotifications.ts`, `api/tradingview/alert-webhook.ts`.
- **Ostatní:** iOS kategorie notifikací, `docs/COPIER_INVARIANTS.md`, testy z §7.

### 9. Velikost a závislosti

**M.** Bez závislosti na jádru kopírky. Šablony může sdílet s C6, ale stačí výchozí 12 b / 2R. Vyžaduje nový build iPhonu.

---

## Otevřené otázky pro Filipa

1. **C6:** souhlasíš s IBKR jako spouštěčem automatického posunu SL? Je to rozšíření INV-UI-04.
2. **C6:** má ruční posun automatiku pozastavit (návrh), nebo jen přeplánovat?
3. **C13:** rušit čekající vstup z flat i při ručním OFF? Návrh: ne, kvůli INV-BRAKE-01.
4. **C13:** spouštět cíl zisku podle dřívějšího z hrubého a čistého P&L (návrh), nebo jen podle čistého?
5. **C13:** potvrď, že auto-close při denní ztrátě se nestaví (rozhodnutí z 3. 9.).
6. **U14:** akci „Připravit příkaz“ v notifikaci ano, Live Activity a widget ne?

## Postup

1. Oponentura `copier-design-critic` na C6 + C13 a na texty INV pro U14.
2. Postavit C13a a C13b1 (malé, bez zápisu k brokerovi).
3. Postavit U14 fázi 1.
4. Spustit záznam C6 na DEMO.
5. Postavit C6 a C13b2 pod stejným opt-inem ručního DEMO.
6. Akceptační běhy na DEMO.
7. Teprve potom fáze 2 (followeři, prop účty).

---

## Posudek copier-design-critic (návrh)

**Celkový verdikt: OPRAVIT PŘED COMMITEM**

- **P1** [C6 — rozpočet zápisů a rate limit] (INV-TRAD-04, INV-BRAKE-03, INV-UI-02 (dopad), INV-AUTO-01) Návrh počítá rozpočet v „zápisech“ (30 na pozici, 200 na session, rozestup 2 s), ne v brokerových požadavcích. U pozice ze 3 lístků je jeden krok trailingu 3× modify, k tomu lookupy po `unknown`, risk poll a REST čtení webu na stejném loginu. Po HTTP 429 adaptér lokálně odmítá KAŽDÝ request spojení až hodinu (services/tradovateBroker.ts:434-458, `assertNotRateLimited`), tedy i liquidate a cancel nouzového Flattenu, zavření z grafu i zrušení čekajícího vstupu. Scénář: trend, trailing s krokem 2 t, 2 s rozestup → 90 modify/min → 429 → hodinová blokace → Flatten ani × na tomto spojení nic nezmůže. Automatika by si tak sama vypnula brzdy. Navíc scénář 1 conformance (§6: 10× modify po 250 ms) může 429 vyvolat sám. Zda je limit per login, nebo per IP (tedy i pro živé Lucid/Tradeify spojení ze stejného Macu), je NEOVĚŘENO (slabé místo 8).
  - Oprava: Rozpočet počítat v požadcích (nohy × modify + lookupy) a dát mu globální strop na spojení s pevnou rezervou pro Flatten (např. průměr ≤ 1 req/s, ≤ 20 za minutu). Při jakémkoli 429, p-ticketu nebo `p-time` přejít hned do `paused-error` s pushem, nikdy nezkoušet znovu. Conformance nesmí limit sondovat: jen s rozestupem ≥ 1 s, jen na loginu bez živých účtů a nejdřív ověřit, zda se limit počítá per login, nebo per IP.
- **P1** [C6 / INV-AUTO-01 — přechod do `suspended` napojený na jednotlivé události] (INV-RECON-04, INV-DEFAULT-01, INV-AUTO-01) Návrh vyjmenovává přechody (DISARM, kill, failClosed, management-only, disconnect, bootstrap → `suspended`). Controller ale vypíná ARM na 17 místech přímým `gate = { ...gate, armed: false }` (např. :6869 maybeEngageDayLock, :12359 vypršení ARM bez zvýšení generace, :8529 emergencyFlatten, :20092 waiver), k tomu failClosed. Stačí vynechat jeden hook a plán zůstane `active`. Automatické pokračování je v pilotu výchozí (scripts/copier/pilot.ts:1577) a umí znovu zapnout i s drženým obchodem. Automatika by pak po něm sama pokračovala, což INV-RECON-04 i navržený INV-AUTO-01 zakazují.
  - Oprava: Při aktivaci svázat plán s ARM epochou (`tradeEpochGeneration`, zvyšuje se při každém ARM, :19823). Automatika je efektivně aktivní jen když: durable `active` ∧ shoda epochy ∧ gate.armed ∧ ¬shadow ∧ ¬kill. Každé nové zapnutí (ruční i automatické) ji tak vypne bez ohledu na hooky; hooky zůstanou jen kvůli zobrazení stavu. Test: výpadek s drženým obchodem → automatické pokračování → žádný automatický zápis.
- **P1** [C13b2 — zavření na konci okna z heartbeatu] (INV-BRAKE-03, INV-MODE-02, INV-FRESH-01) `reviewWindowEndClose()` má podle návrhu volat heartbeat (:16277-16287). Heartbeat se ale zpracovává uvnitř `eventTail` (handleBrokerEvent) a čeká na výsledek. Zavolá-li se odtud executeClose (:4257: liquidate ≤ 8 s, čekání na stream ~2 s, REST ověření ~4 s), stojí fronta leaderových eventů až ~14 s. Stream flat se navíc nikdy neukáže, protože pozice se aktualizuje až ve frontě za čekajícím zavřením, takže ověření vždy spadne na REST. Ruční příkazy mezitím dostávají `controller-busy` (start ≤ 2 s).
  - Oprava: Převzít vzor manageLeaderOrder (:19995-20027): heartbeat i 1s časovač úlohu jen naplánují (bez await), příprava `preparePositionClose` běží ve frontě se startem ≤ 2 s, liquidate i ověření mimo frontu. Před zavřením převést C6 automatiku pozice do `suspended`. Test: heartbeat nečeká na liquidate a eventy leadera se během zavírání dál zpracují.
- **P2** [C6 — „nikdy dál od trhu“ při souběhu s ručním posunem v Tradovate] (INV-AUTO-01, INV-DIVERGENCE-01, INV-FRESH-01) Tradovate modify nemá podmíněný zápis (CAS). Scénář: SL je na 100, uživatel ho v Tradovate utáhne na 105. Automatika z cache (SL 100) mezitím spočítá 103 a pošle modify, broker ho zpracuje až po uživatelově změně, takže SL skončí na 103 — dál od trhu, než ho měl uživatel. Detekce `paused-manual` podle posledního stavu streamu to nepozná: pořadí Replaced(105) → Replaced(103) vypadá jako vlastní zápis. Tvrzení „Nikdy posun SL dál od trhu“ v INV-AUTO-01 proto neplatí absolutně.
  - Oprava: Přeformulovat záruku na „nikdy dál než SL, který worker viděl v čerstvém streamu“. Před zápisem vyžadovat ticho streamu leadera ≥ 500 ms. Po zápisu projít všechny verze nohy mezi snímkem a vlastním Replaced; jakákoli cizí verze = `paused-manual` + push „automatika mohla přepsat tvůj posun SL“. Test s opačným pořadím eventů.
- **P2** [C6 / A5 — „jen DEMO“ se vynucuje jen podle prostředí] (INV-MANUAL-01 (manual-only DEMO), INV-AUTO-01) `scaleInEnabled` (services/manualScaleIn.ts:19-26) a navržené `positionAutomationEnabled` kontrolují jen manualOnly ∧ localOnly ∧ bez followerů ∧ `brokerEnvironment === 'demo'`. Prop evaluační účty (Lucid, Tradeify) běží v Tradovate ale také v prostředí `demo` a installer `--manual-only` typ účtu nekontroluje (scripts/copier/pilot.ts:765-838). Worker by tak mohl sám zapisovat na prop účtu. Zda to pravidla propek o automatizaci dovolují, je NEOVĚŘENO.
  - Oprava: Opt-in svázat s konkrétním ID účtu z instalace (např. `--position-automation-account <id>`) a ideálně i se jménem účtu z adresáře účtů (DEMO…). Při neshodě capability `position-automation-v1` vůbec nenabízet.
- **P2** [C6 — zastavení automatiky bez upozornění] (INV-DEFAULT-02, INV-UI-01/03) Push má přijít jen při pozastavení chybou. Přechody active → `suspended` (restart, výpadek spojení, uspání Macu, DISARM, vypršení ARM), `paused-manual` a vyčerpání rozpočtu 30 zápisů ale nastávají právě ve chvíli, kdy uživatel odešel od počítače a spoléhá na trailing. SL pak tiše zůstane, kde je, a uživatel to nezjistí.
  - Oprava: Push a sticky karta při každém odchodu ze stavu `active`, pokud je pozice otevřená, včetně vyčerpání rozpočtu, s textem „SL zůstává na X, automatika už neběží“.
- **P2** [C6 — vstup s plánem automatiky na workeru bez opt-inu] (INV-MANUAL-01, INV-FRESH-03) Návrh neříká, co se stane, když `place-leader-entry` nese `automation`, ale worker má automatiku vypnutou nebo plán neplatí v aktuálním stavu. Tiché přijetí vstupu bez automatiky znamená, že uživatel věří v BE nebo trailing, který neběží.
  - Oprava: Vstup s plánem, který worker nepovolí, musí skončit `blocked` (nic se neodešle) — už v náhledu a znovu synchronně před POSTem. Pokrýt testem. `set-automation` posílat jen nad čerstvým neobnoveným statusem.
- **P2** [C6 — ruční příkazy během automatických zápisů] (INV-MANUAL-01, INV-UI-02) Mutex pozice (:4817) vrací ručnímu move-stop/move-target `busy`, dokud běží automatický zápis (až 8 s). Při aktivním trailingu se to může opakovat. Uživatel pak SL nebo TP nepohne z appky a jde do Tradovate, kde vzniká souběh z nálezu výše. `set-automation null` navíc stojí ve stejné frontě a počítá se do denního stropu 100 správ (migrace 20261101090849:182-193).
  - Oprava: Při přijetí ručního příkazu synchronně, ještě před frontou, nastavit příznak, který zastaví další automatický krok. Rozestup 2 s měřit od konce zápisu. `set-automation null` aplikovat synchronně v paměti (vypnutí bez zápisu k brokerovi) a vyjmout ze stropu 100 / 24 h stejně jako zavření.
- **P2** [C13a/C13b2 — nová pole safety a starší klienti] (INV-RISK-01 (tighten-only), INV-FRESH-03, INV-RISK-02) `update-group` nahrazuje celou skupinu. Starší klient (nepřestavěný iPhone, starý web) pošle safety bez `dailyProfitTargetUsd` a `windowEndClose`, sanitizer doplní výchozí hodnotu (0 / off). Za DISARMED se tak cíl dne i zavírání na konci okna tiše vypnou; za ARMED skončí update nesrozumitelným „zmírněním“. Opačně: starší worker neznámá pole zahodí a UI ukáže, že jsou nastavená.
  - Oprava: Zavést capability (`daily-profit-v1`, `window-end-close-v1`). Bez ní UI pole nenabízí. Worker při chybějícím novém poli zachová současnou hodnotu, nebo update s chybějícím polem odmítne.
- **P2** [C13b1 — z části vyplněný čekající vstup] (INV-BRAKE-04, INV-TRAD-02, INV-RISK-02) Vstup s dílčím fillem se neruší (`cancelOwnManualEntry` :3683-3687), což je správně, protože zrušení zbytku OSO u Tradovate není ověřené (kaskáda na nohy). Vstup z flat ale v manual-only skupině smí mít 1–5 kontraktů. Zbytek Limitu tak pracuje po konci okna i session a může pozici zvětšit mimo okno, aniž o tom kdo ví. Pozitivní je, že b1 zavírá i existující mezeru: `groupIsFlat` (:5924 → `accountsFlatInCache` :5915) počítá jen pozice, takže zámek dne dnes zapne (= DISARM) i s pracujícím vlastním vstupem a ten pak přežije zámek.
  - Oprava: Z části vyplněný čekající vstup v −5 min = push a incident „zbytek vstupu pracuje, zruš ho ručně“. Nebo ve fázi 1 omezit čekající Limit/Stop vstup z flat na 1 kontrakt jako u přikoupení. Doplnit regresní test: zámek se zapne s pracujícím vstupem → b1 vstup zruší.
- **P3** [C13a — výčty `daily-profit` mimo seznam souborů] (INV-UI-03, INV-WATCH-01) `server/macCompanionStatus.ts:58-62, 280, 325, 358` při neznámém triggeru nebo pravidle vrátí za zámek, pauzu i pravidla dne `null`. Companion tak zámek ani pauzu neukáže (zobrazení selže otevřeně, ne bezpečně). `dayLockRuleLabel` (services/copierDailyRules.ts:86) vrátí undefined. `configuredRuleAction` (:6496) bez nové větve spadne na akci konce okna. Notifikace (services/nativeCopierNotificationPlan.ts) a LiveDayRulesCard/LiveRiskTab v seznamu souborů chybí.
  - Oprava: Doplnit `daily-profit` do všech výčtů (lib/macCompanionContract.ts, macCompanionStatus, notifikace, UI) a přidat test úplnosti výčtů.
- **P3** [C6 — opakování po `rejected`] (INV-OUTBOX-01, INV-AUTO-01) Odmítnutí odvozené z lookupu (`settled && price === fromPrice`, :4392) je jen domněnka. Pozdě zpracovaný modify na 103 by po novém automatickém kroku na 105 vrátil SL dolů, tedy dál od trhu.
  - Oprava: Nový automatický pokus povolit jen po definitivním odmítnutí z commandReportu (`definitiveBrokerRejection`, :4371). Odmítnutí odvozené z lookupu = `paused-error`.
- **P3** [C6 — ořez záznamů správy] (INV-OUTBOX-02, INV-RELAY-02 (obrana do hloubky)) `MANUAL_ORDER_ACTION_KEEP = 50` (:4122). Automatické záznamy (nohy × kroky) vytlačí vyřešené ruční záznamy během ~30 s, čímž slábne idempotence `prepareManualOrderAction` (:5065-5079) proti znovu doručenému příkazu a mizí audit.
  - Oprava: Automatickým záznamům dát vlastní limit, nebo je ořezávat přednostně; ruční záznamy nechat.
- **P3** [C6 — highWater z jediného ticku] (INV-UI-04, INV-AUTO-01) highWater podle `workerMarketPrice` může vzít `last` (:61-67). Jeden chybný tisk z IBKR nafoukne highWater a trailing pak podle něj utáhne SL.
  - Oprava: highWater brát jen z bid (long) / ask (short) potvrzených ≥ 2 kotacemi v rozmezí ≥ 250 ms a omezit maximální posun jednoho kroku.
- **P3** [C6 — chyba v rozhodování automatiky] (INV-WORKER-04, INV-DEFAULT-02) Pokud `reviewPositionAutomation` poběží ve sdíleném try ve `scheduleScaleInReview` (:3797-3811), výjimka v automatice vyvolá failClosed (DISARM + incident). To odporuje §4 návrhu („chyba = pauza“), a pokud automatika poběží dřív, nedoběhne ani kontrola čekajících přikoupení.
  - Oprava: Dát automatice vlastní try/catch, výjimka v čistém rozhodování = `paused-error`. Pořadí: nejdřív kontrola čekajících přikoupení a krytí nohou, pak automatika. Nejvýš jedna automatická úloha na pozici ve frontě nebo v běhu.
- **P3** [C6 — dvojí zdroj plánu a klíč bez epizody] (INV-AUTO-01) Plán leží v `manualEntries[].automation` i v `safety.positionAutomations[]`; `set-automation` mění jen to druhé. Klíč `position:<leader>:<symbol>` neobsahuje epizodu, takže vynechaný přechod do `done` by mohl plán přenést na další pozici na stejném symbolu.
  - Oprava: Jediný autoritativní zdroj plánu. Každým krokem ověřit `baseEntryOperationId === model.tickets[0].operationId` a epochu expozice.
- **P3** [C6 — dva workery] (INV-WORKER-02, INV-WORKER-03) Dvě živé instance (např. Mac + testovací VPS nad stejným DEMO účtem) by trailovaly zvlášť, každá s jiným highWater. Pozdější zápis nižší ceny tak posune SL dál od trhu.
  - Oprava: Uvést v INV-AUTO-01 jako známé omezení a automatiku nikdy nezapínat na druhé instanci. Pokud jde split-brain (N6) zjistit, automatika = `suspended`.
- **P3** [C13b2 — cizí kontrakty, které stream ještě nedohnal] (INV-DEFAULT-02, kontrolní otázka 11) liquidate zavírá celý kontrakt. Kontrakt koupený ručně v Tradovate těsně před koncem okna, který ještě nedorazil streamem, se zavře automaticky — bez kliknutí uživatele. Kontrola „cizí kontrakty → jen push“ by se navíc opakovala každou sekundu.
  - Oprava: Před zápisem vyžadovat ticho streamu leadera ≥ 2 s (`pendingTradeIngress` už kontroluje executeClose). Push o cizích kontraktech poslat jednou za session. Holý Market bez nohou se nezavře — upozornit, že ho zavře až vypršení ARM.
- **P3** [U14 — snímek draftu a strana Stopu] (INV-UI-04, INV-MANUAL-01, INV-RELAY-01) Draft se čte až při drainu nebo ťuknutí, ne v okamžiku spuštění. Změna draftu na jiném zařízení mezi spuštěním a ťuknutím vyplní jiný příkaz, než slibovala notifikace. „Stop na úrovni“ je po křížení přes trh — návrh řeší jen Limit na špatné straně. Text TV webhooku (`name`) ovládá kdokoli, kdo zná token, a s „připravit Buy“ vybízí k rychlému Odeslat.
  - Oprava: Při spuštění uložit snímek draftu do `price_alert_events` (obsah uživatele, ne cena IBKR). `ticketProblems` musí hlídat i Stop. Draft z TV označit jako neověřený zdroj a šablony pro webhook nechat uživatele výslovně povolit.
- **P3** [C6/U14 — šablony ATM] (INV-UI-01) Šablony mají být „uložené lokálně v zařízení“, a zároveň telefon má mít „stejné šablony jako PC“ — to si odporuje. Draft z webhooku podle jména šablony pak na různých zařízeních vyplní různé hodnoty.
  - Oprava: Synchronizovat šablony přes server, nebo výslovně pracovat per zařízení. Příkaz vždy nese explicitní čísla a panel je ukazuje.
- **P2** [Chybějící testy (všechny položky)] (Kontrolní otázka 25) Testy v návrhu kryjí hlavně happy path a vyjmenované brány. Chybí: (1) souběh s ručním posunem SL v Tradovate a opačné pořadí Replaced eventů; (2) 429 nebo p-ticket během trailingu → `paused-error`, žádný další požadavek, Flatten dál funguje; rozpočet počítaný v požadavcích; (3) automatické pokračování s drženým obchodem → automatika se neobnoví (vazba na ARM epochu) a každé ze 17 míst s `armed:false` → žádný automatický zápis; (4) heartbeat nečeká na zavření na konci okna; (5) zámek dne zapnutý s pracujícím vlastním vstupem → b1 ho zruší; z části vyplněný vstup v −5 min → push nebo incident; (6) update-group od staršího klienta bez nových polí → hodnota zůstane; (7) parse `daily-profit` v companion statusu a notifikacích; (8) vstup s plánem na workeru bez opt-inu → blocked; (9) restart nebo výpadek → push „automatika zastavena“; (10) změna draftu mezi spuštěním a ťuknutím a Stop přes trh (U14); (11) mutační test: záměna `tradeEpochGeneration` nebo vynechání ARM brány musí test shodit.
  - Oprava: Doplnit do tests/positionAutomationReplay.test.ts, tests/copierWindowEndClose.test.ts, tests/manualEntryTimeInForce.test.ts, tests/copierDailyProfitRule.test.ts a tests/alertOrderDraft.test.ts a ke každému přidat i variantu s chybou, restartem, zastaralým výsledkem a opačným pořadím eventů.

### Verdikty po položkách

- A — společný rámec a INV-AUTO-01: **OK S VÝHRADAMI** — Hranice sedí: jen snížení rizika, jen za ARMED, plán jen z relaye, žádné REST ve frontě, žádné opakování po `unknown`, žádné sjednocování nohou. Ověřeno v kódu: dispatchBroker kontroluje generaci, shadow a haltReason těsně před zápisem (:1891-1925); durable `sending` všech nohou jedním zápisem (:4963); pojistky těsně před zápisem (:4980-4991); restart převede `sending` na `unknown` (:19494-19501). Výhrady: (1) „nikdy dál od trhu“ přeformulovat kvůli souběhu bez CAS; (2) `suspended` svázat s ARM epochou místo výčtu událostí; (3) „jen DEMO“ je dnes jen prostředí `demo`, kam patří i prop účty.
- C6 — software BE + trailing: **OPRAVIT** — Podmínky jsou správně: STAVĚT-PO-CONFORMANCE, Filipův souhlas s IBKR jako spouštěčem (rozšíření INV-UI-04) a fáze 1 jen manual-only. Před implementací ale opravit: rozpočet v požadcích s rezervou pro Flatten a reakci na 429 (hodinový breaker by zablokoval brzdy), vazbu na ARM epochu, detekci cizího posunu SL, push při zastavení, blokaci vstupu s plánem bez opt-inu a prioritu ručních příkazů. Kotace IBKR: realtime-only (`marketDataType !== 1` = null, ibkrPriceSource.ts:601), čerstvost 3 s podle přijetí, kontrola kontraktu — v pořádku.
- C6 — zamítnutí nativního TrailingStop: **ZAMÍTNUTÍ SPRÁVNÉ** — `OrderType` typ TrailingStop nezná (brokerPort.ts:23) a `supportedOrderType` na něm vyhodí TradovateTransportError (tradovateBroker.ts:266-269). Znovu otevřít až po opravě „nepodporovaný typ = cizí příkaz“ a vlastním DEMO záznamu. Stávající riziko trvá: TrailingStop zadaný ručně v Tradovate na účtu leadera shodí sync — C6 ho neřeší.
- C13a — denní cíl zisku: **OK S VÝHRADAMI** — Bez zápisu k brokerovi, zámek čeká na flat (maybeEngageDayLock :6862), max(ledger, broker) zamkne dřív, tedy nikdy volněji. `positiveLimitIsWeaker` (copierRiskConfig.ts:85-89) má pro cíl správnou sémantiku (vyšší nebo 0 = zmírnění). Výhrady: capability a starší klienti u update-group; výčty v companion statusu, notifikacích a UI. Pozor: `groupIsFlat` bere chybějící cache jako flat (:5915) — u zámku to vede jen k DISARM, tedy bezpečným směrem.
- C13b1 — time-in-force čekajících vstupů: **OK S VÝHRADAMI** — Jen zrušení, jeden pokus, durable značka, i pod kill (rozšíření výjimky INV-BRAKE-02) — v souladu s INV-BRAKE-02/04. Zároveň opravuje existující mezeru: zámek dne zapne DISARM s pracujícím vstupem, protože `groupIsFlat` nepočítá příkazy. Výhrady: z části vyplněný zbytek po konci okna; brána fáze 1 (`reviewPendingScaleIns` dnes `scaleInOn` nekontroluje, :3721); incident při selhání zrušení rozšířit ze `scaleIn === true` na všechny vstupy (:3708). Nerušit při prostém OFF je v souladu s INV-BRAKE-01; je to Filipova otázka 3.
- C13b2 — zavření na konci okna: **OPRAVIT** — Opt-in, jen vlastní lístky, jen za ARMED, jeden zápis za session, výsledek ze stavu (executeClose :4257-4270 kontroluje armed, shadow, kill, generaci, fence, Flatten a jiný zápis) — v pořádku. Opravit: nesmí běžet z heartbeatu uvnitř eventTail (zastaví frontu i ověření ze streamu), před zavřením převést C6 automatiku do `suspended`, ošetřit souběh s cizími kontrakty a dedupe pushů. Doplnit text INV-RISK-02 a INV-BRAKE-04 podle návrhu.
- C13 — zamítnutí auto-close při denní ztrátě: **ZAMÍTNUTÍ SPRÁVNÉ** — V souladu s rozhodnutím z 3. 9., INV-BRAKE-04 a INV-DEFAULT-02. SL vlastních lístků se proti rezervě bez otevřeného P&L kontroluje už při vstupu (:4942, :5254). Konec session kryje TTL ARM (agent :1204) a `armExpiryFlatten: 'group'` (liveCopyTrading.ts:221). IBKR jako spouštěč zavření by vyžadoval nové rozhodnutí Filipa.
- U14 — připravený příkaz z upozornění: **OK S VÝHRADAMI** — Jen předvyplnění, odeslání dál přes `place-leader-entry` s čerstvým náhledem, žádný nový copy-command, push ani Realtime nic nenesou — v souladu s INV-MANUAL-01, INV-RELAY-04 a INV-WATCH-01. Statický test importů je dobrý. Výhrady: snímek draftu při spuštění, kontrola Stopu na špatné straně, označení TV draftu jako neověřeného zdroje, šablony mezi zařízeními. Serverová větev triggeru (migrace 20261102140000:154-167) musí zachovat i `order_draft`, jak návrh uvádí.
- U14 — zamítnutí automatického odeslání a webhooku jako příkazu: **ZAMÍTNUTÍ SPRÁVNÉ** — Webhook má token v URL bez druhého faktoru (api/tradingview/alert-webhook.ts:11-17), server nezná záměr uživatele (INV-FRESH-03), INV-UI-04 zakazuje cenu `{{close}}` a platí Filipovo pravidlo ⚡. Odůvodnění je správné.
- Texty INV (AUTO-01/02, UI-04, BRAKE-02, RISK-02, MANUAL-01): **OK S VÝHRADAMI** — INV-AUTO-01: změnit „nikdy dál od trhu“ na záruku vůči viděnému SL, doplnit vazbu na ARM epochu, rozpočet v požadavcích a omezení dvou workerů. INV-UI-04: rozšíření (IBKR spouští automatický posun SL) bez Filipova výslovného souhlasu nezapisovat. INV-BRAKE-02: výslovně uvést, že automatický posun SL výjimkou není, a že výjimka pro zrušení čekajícího vstupu platí jen pro vstup bez fillu.
- Kontrolní seznam (26 otázek): **viz poznámka** — 1 drží: automatika nikdy nezapíná ARM, ARM jde dál přes armCore. 2 drží: snímek streamu null, chybějící kotace nebo entryAvg = nic; mezera: groupIsFlat bere chybějící cache jako flat (:5915), jen směrem k DISARM. 3 netýká se: nic nemaže lastError. 4 netýká se. 5 částečně: DISARM, kill a změnu konfigurace mezi přípravou a zápisem chytí dispatchBroker a fence (:1891-1925, :4980-4991); cizí posun SL v Tradovate během zápisu NE (P2). 6 drží: fence a generace těsně před zápisem; výsledky jsou fakta od brokera. 7 drží pro `unknown`; nový pokus po `rejected` jen po definitivním odmítnutí (P3). 8 drží: `sending` durable před zápisem (:4963). 9 drží: dílčí fill a Suspended nohy = nic, vyplnění během modify = waived, chybějící noha = shape. 10 drží: legs-diverged blokuje, nic se nesjednocuje. 11 C13b2: cíl jsou vlastní lístky, ale liquidate zavře celý kontrakt — souběh s ještě nedoručeným cizím kontraktem (P3). 12 drží: executeClose ověřuje stavem (INV-MODE-02). 13 drží: management-only = suspended. 14 netýká se ve fázi 1 (bez followerů). 15 částečně: nová pole jdou jen zpřísnit, ale starší klient je může tiše shodit (P2). 16 drží: zámek až po flat, časy přes sdílené helpery. 17 drží: brzdy beze změny; `set-automation` po brzdě odmítne agent (:966-972), SQL supersede ho nezahrnuje (migrace :333-335) — přijatelné. 18 drží: automatické zápisy nejdou přes relay, `set-automation` jde přes atomickou admission. 19 drží, pokud se `set-automation` posílá jen nad čerstvým statusem (doplnit). 20 částečně: `sending` → `unknown` a `suspended` ano; chybí push o zastavení (P2). 21 drží: route epocha před zápisem; rate limit sdílený přes login nebo IP je NEOVĚŘENO (P1). 22 OTEVŘENÉ: INV-WORKER-02, dva workery = dvojí trailing (P3). 23 PORUŠENO v návrhu: rozpočet nepočítá požadavky, 429 = hodinová blokace i Flattenu (P1). 24 drží: o víkendu stará kotace = nic. 25 chybí testy chyby, souběhu a opačného pořadí (viz nález). 26 drží: návrh odděluje „nic neimplementováno ani neověřeno“ od conformance.
