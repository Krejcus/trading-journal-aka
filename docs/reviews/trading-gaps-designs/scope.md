# Rozsah obchodování z appky (skupina „scope“): návrh, 3. 11. 2026

Podklad: nasazený kód `/Users/filipkrejca/alphatrade-worktrees/scale-in` @ 7ae5c97b (= origin/main), seznam mezer `docs/reviews/trading-gaps-20261103.md`, `docs/COPIER_INVARIANTS.md`, `docs/reviews/scale-in-design-20261102.md` (šablona), `docs/CHART_ORDER_ENTRY_PLAN.md`. Jen čtení: nic se nespouštělo, broker ani síť se nevolaly.

**Oponentura:** všechny položky kromě R1/R2 a čistě UI úklidu u C20b mění jádro kopírky. Podle CLAUDE.md bod 4 musí návrh i hotový diff projít agentem `copier-design-critic`. V tomto kroku critic **neproběhl** (read-only podagent), proto nic z dokumentu není schválené ke commitu.

## 0. Přehled verdiktů

| ID | Položka | Verdikt | Velikost | Závisí na |
|---|---|---|---|---|
| C19a | Strop kontraktů z appky (durable, reinstalace bez volby ho nevrací na 1), ruční DEMO víc než 5 | STAVĚT | M | – |
| C19b | Víc než 1 kontrakt v běžné skupině s followery | STAVĚT-PO-CONFORMANCE | M | C19a |
| C20a | Vstup jen na leadera bez kopie ve skupině s followery | STAVĚT | L | – |
| C20b | Vstup na vybraný follower / účet mimo skupinu, vstup za OFF | ZAMÍTNOUT (+ jen UI úklid textů) | S | – |
| C21 | Správa obchodů zadaných v Tradovate v ručním DEMO (cizí OSO bez outboxu) | STAVĚT-PO-CONFORMANCE | M | (S1 pro jiné kořeny než MNQ/NQ) |
| S1 | Symboly NQ, ES, MES (vstup, graf, cena IBKR, tick value, kontrakt) | STAVĚT-PO-CONFORMANCE + výslovné rozhodnutí Filipa | L | – |
| S2 | Ruční volba kontraktu v týdnu rollu | STAVĚT-PO-CONFORMANCE (lehká) | M | S1 krok 3 |
| S3a | Ochrana proti dvěma workerům na jednom připojení | STAVĚT | M | – |
| S3b | Víc skupin / workerů najednou | STAVĚT-PO-CONFORMANCE | L | S3a |
| R1 | Skutečné Tradovate LIVE s vlastními penězi | ZAMÍTNOUT | – | – |
| R2 | Market (a Stop) bez IBKR s cenou z TradingView | ZAMÍTNOUT | – | – |

Navržené pořadí: S3a → C19a → C20a → (záznam) C21 → (záznam + rozhodnutí) S1 → S2 (hotovo do ~8. 12., roll MNQZ6→MNQH7) → C19b → S3b.

## 1. Ověřený výchozí stav (z kódu)

- **Strop ručního vstupu:** `services/manualEntryPreview.ts:31-38` `manualEntryContractCap()` vrací 1. Vyšší hodnotu (nejvýš `MANUAL_ENTRY_GROUP_CAP_MAX = 5`) připouští jen u manual-only local-only skupiny. Hodnota se bere z `group.manualEntryMaxContracts`, které:
  - nastavuje jen installer (`scripts/copier/mac-install.ts:236-242, 473`),
  - pilot při startu vždy odstraní a nahradí argumentem (`scripts/copier/pilot.ts:845-854`: „reinstall bez flagu strop vždy vrátí na 1“),
  - vzdálená změna skupiny zahodí (`server/localCopierExecutionAgent.ts:483-487`),
  - cloudová knihovna neukládá (`services/copyGroupLibrary.ts:62`),
  - controller u jiné skupiny odmítne (`services/copierRuntimeController.ts:1023-1026`, `services/liveCopyTrading.ts:642-644`).
  
  `mac-reinstall-safe.sh` flag nepředává (ř. 128-153 zachovávají jen tv-stream/price-source/alerts/scale-in), proto reinstalace strop vrací na 1. Strop přikoupení počítá s celou pozicí (`services/manualScaleIn.ts:291`, `copierRuntimeController.ts:3607`). UI bere strop ze statusu přes stejnou funkci (`components/TradovateLiveDesk.tsx:1183, 1857`).
- **Validace qty:** `lib/leaderEntryPreview.ts:11` `LEADER_ENTRY_MAX_QUANTITY = 50`. Telefonní předvolby jsou `[1, 5, 10, 25, 100]` (`lib/livePhoneTrade.ts:26`). Nad strop je blokuje `components/day/LivePhoneChart.tsx:152, 331`.
- **Jen leader ve skupině s followery:** `services/manualEntryPreview.ts:449-451` `no-follower-would-copy` („vstup jen na leadera zatím není podporovaný“). Kdyby vlastní OSO nikdo nezkopíroval, controller ho zruší (`copierRuntimeController.ts:17645-17653`). UI výběr „Jen jeden účet“ existuje (`components/LiveOrderTicket.tsx:554-594`, `lib/liveTradeTarget.ts:86-97`), odeslání ale odmítne („Náhled zatím jen pro skupinu“, `LiveOrderTicket.tsx:441-465`).
- **Vynechání epizody followerem:** durable mechanismus už existuje. `safety.accountSyncPauses` (`services/copierEngine.ts:168-177`, `reasonCode: 'entry-rejected' | 'protective-filled-early'`) má tyto vlastnosti:
  - runner pozastavenému followerovi nic nepošle (`copierRuntimeController.ts:4184`),
  - kontrola velikosti ho přeskočí (`:7694`) a reconciliation taky (`:8869`),
  - pauzu uvolní jen autoritativní důkaz: leader-flat guard s čerstvým snímkem (`:10790-10816`) nebo čistá Kontrola pozic (`:20382`); predikát `accountSyncPauseReleasableFromCache` je na `:12858`,
  - Supabase store validuje `reasonCode` i neprázdné `leaderEntryOrderId` (`services/supabaseCopierStore.ts:244-254`).
- **Správa obchodů z Tradovate:** `resolveManagedTrade` (`copierRuntimeController.ts:4552-4587`) zná jen vlastní záznam (2a) nebo durable `osoOutbox`/`bracketOutbox` (2b). V manual-only skupině bez followerů žádný outbox nevzniká, proto obchod z Tradovate dostane `not-tracked`. Broker vrstva přitom nese vazby `parentOrderId`/`ocoId`/`linkedOrderId` (`services/brokerPort.ts:62-64`, `services/tradovateMapping.ts:336-338`). Záznam fáze 0 přikoupení: „SL má parentId, TP parentId nemá (jen ocoId)“.
- **MNQ napevno:**
  - `lib/leaderEntryPreview.ts:13` `/^MNQ[HMUZ]\d$/` a `:240` `previewSymbolFromChartSource` jen MNQ,
  - `services/manualEntryPreview.ts:117-118` `FEE {MNQ, NQ}`, `TICK = 0.25`,
  - `copierRuntimeController.ts:3936, 4652, 4924, 5219, 19984` `manualEntryQuote?.('MNQ')`; `:19537` `frontContract('MNQ', …)`; `:19944-19945` `quarterlyContractsAround(NQ|MNQ)`,
  - `services/ibkrPriceSource.ts:181` jediný kořen (výchozí MNQ),
  - `components/LiveTradingScreen.tsx:66-67` `ROOT`/`INSTRUMENT`; `components/day/LivePhoneChart.tsx:115`,
  - `lib/tvLivePnl.ts:76` `PRICE_FAMILY {NQ, MNQ}`,
  - správa: `lib/leaderOrderManage.ts:59` `(MNQ|NQ)`.
  
  Hodnoty bodu pro ES/MES/NQ už jsou v `services/futuresContractSpecs.ts` (ES 50, MES 5, NQ 20).
- **Roll:** v týdnu rollu jsou kandidáti oba kontrakty (`copierRuntimeController.ts:19982`). Původ kontraktu ale vyžaduje kotaci IBKR téhož kontraktu (`manualEntryPreview.ts:331-350`) a IBKR odebírá jen svůj přední kontrakt (`ibkrPriceSource.ts:483-498`). Fakticky jde obchodovat jen kontrakt, který vybral IBKR.
- **Více workerů:** relay vybírá nejčerstvější heartbeat (`server/tradovateCopierCommandRelay.ts:236-269`), což INV-WORKER-03 výslovně neuznává za fencing. Na stejném zařízení heartbeat_v2 ignoruje starší `startedAt` a ACK takové instance odmítne. `claim_tradovate_copier_command_v2` instanci nezná (`supabase/migrations/20261101090849_copier_manual_admission.sql:360-385`), takže převzatou instanci výdej příkazu nezastaví. Otevřená otázka N6 (`COPIER_INVARIANTS.md` §5 bod 1).

---

## C19a: Strop kontraktů z appky, durable; ruční DEMO víc než 5

### 1. Verdikt
**STAVĚT.** K brokerovi nejde nic nového. Market q > 1 je zaznamenaný ve fázi 0b přikoupení (přikoupení po 2, fill celý najednou). Limit/Stop q ≤ 5 v DEMO už dnes jde. V této fázi zůstává běžná skupina na stropu 1 (C19b).

### 2. Chování pro uživatele
- **PC:** Live Dashboard → karta skupiny → řádek „Strop ručního vstupu“ s krokovačem 1…strop (ruční DEMO 10). Pod ním je platná hodnota, odkud je („z appky 3. 11. 14:02“ / „z instalace“ / „výchozí“) a případné „zvýšení na 8 platí od 17:00 CT“.
  - Snížení platí hned, i za zapnuté kopírky.
  - Zvýšení za zapnuté kopírky je zašedlé („Zvýšit jde jen při vypnuté kopírce“).
  - Po prvním zapnutí v session se zvýšení uloží jako čekající a platí od začátku další session (anti-tilt, stejné pravidlo jako ostatní pravidla dne).
  
  Panel objednávky ukáže „strop 7 (z appky)“. Hláška nad stropem se nemění (`LiveOrderTicket.tsx:460-461`).
- **Telefon:** stejný krokovač v listu skupiny na Live Dashboardu (OFF zůstává tam, INV-UI-02). Předvolby qty nad stropem jsou zašedlé, list objednávky hlásí strop jako dnes.
- **Reinstalace:** bez volby hodnota zůstává. S `--manual-entry-max-contracts N` instalace hodnotu výslovně přepíše a zaloguje „instalace přepsala strop z appky M → N“.

### 3. Mechanismus
- **Durable stav:** nové pole v `CopierState.safety` (`services/copierEngine.ts` vedle `sessionArmedAt` / `manualEntries`):
  `manualEntryCap?: { groupId: string; maxContracts: number; source: 'install' | 'app'; setAt: number; pending?: { maxContracts: number; effectiveAt: number } }`.
  Klonování v `services/copierStore.ts:cloneSafety` (spread nestačí na vnořené `pending`, doplnit explicitně). Validace v `services/supabaseCopierStore.ts` (vedle `validSyncPauses`).
- **Čistá funkce:** `manualEntryContractCap(group, capRecord, now)` v `services/manualEntryPreview.ts:34`.
  - Záznam jiné skupiny = 1.
  - `pending` platí, když `now ≥ effectiveAt` (líně, bez časovače).
  - Ořez stropem `MANUAL_ENTRY_DEMO_CAP_CEILING = 10` (nahrazuje `MANUAL_ENTRY_GROUP_CAP_MAX = 5`) pro manual-only local-only skupinu; `MANUAL_ENTRY_GROUP_CAP_CEILING = 1` pro běžnou skupinu do C19b.
  - Starý `group.manualEntryMaxContracts` se čte jen jednou při migraci (níže).
  
  Volající: `evaluateManualEntryPreview` (`:307-308` — vstupy dostanou záznam), `scaleInGate` (`copierRuntimeController.ts:3607`), UI.
- **Nový copy-command** `set-manual-entry-cap { groupId, maxContracts, expectedCurrent }`:
  - typ v unii `services/liveCopyTrading.ts:250`,
  - relay `server/tradovateCopierCommandRelay.ts:339` `remoteCopyCommands` + přísný validátor v `validatedRemoteCopyCommand` (`:362`; klíče jen tyto tři + type, celá čísla 1–50 strukturálně),
  - `relayNeedsTightenOnly` / `enforceRelayTightenOnly` (`:686-737`): zvýšení odmítne `tighten-only`, když status workeru hlásí `controller.armed`. Jde o obranu do hloubky, rozhoduje worker.
  - Nejde přes atomickou admission (není to vstup ani správa). `command_type` zůstává `copy-command` → **migrace ne**. TTL 30 s jako ostatní konfigurace.
- **Agent:** `server/localCopierExecutionAgent.ts:797` nová větev `case 'set-manual-entry-cap'`:
  - `assertGroupTarget`, pak `controller.setManualEntryCap()`, log `CONFIG SET-MANUAL-ENTRY-CAP before→after source`,
  - capability `manual-entry-cap-v1` (`:407`, konstanta v `lib/copierWorkerCapabilities.ts`).
- **Controller** `setManualEntryCap` (nová metoda vedle `updateGroupMetadata`, `copierRuntimeController.ts:20922`) běží v `eventTail`. Je proto serializovaná s `executeManualEntry`: vstup vyhodnocený před změnou doběhne se starým stropem a žádný závod mezi `evaluate` a POSTem nevzniká. Kontroly:
  - skupina sedí a není smazaná,
  - `expectedCurrent` = platná hodnota, jinak `cap-conflict` („Strop se mezitím změnil“),
  - hodnota ≤ stropu typu skupiny.
  
  Rozhodnutí:
  - snížení = commit hned;
  - zvýšení za `gate.armed` = odmítnout `cap-raise-armed`;
  - zvýšení za vypnuté kopírky:
    - `sessionArmedAt > 0` (už bylo zapnuto v session, `:1227`) = uložit `pending` s `effectiveAt = now + msUntilTradovateSessionEnd(now)` (INV-RISK-04),
    - jinak hned.
  
  Zápis přes `persistSafetyUpdate` (CAS, INV-WORKER-01). Neprovedená změna nenastaví `lastError` (precedens INV-GROUP-01).
- **Pilot** (`scripts/copier/pilot.ts:770-775, 845-854`):
  - přestat strop ze skupiny odstraňovat;
  - po načtení durable snapshotu: flag přítomen → zapsat záznam `source:'install'` (přepis, log); flag chybí → ponechat durable záznam;
  - chybí záznam a stará skupina má `manualEntryMaxContracts` → jednorázová migrace do záznamu (`source:'install'`).
  
  `mac-install.ts:240` mez = strop DEMO. `assertRuntimeGroup` (`:1023`) a sanitize (`liveCopyTrading.ts:642`) starý tvar dál přijímají (≤ 5), aby se dal přečíst rollback snapshot.
- **Status:** `controller.manualEntryCap = { value, ceiling, source, setAt, pending }`. UI (`TradovateLiveDesk.tsx:1183, 1857`) ho bere odtud, u starého workeru zůstává staré `manualEntryContractCap(group)`. Nová komponenta `components/LiveManualEntryCapControl.tsx` (PC i telefon) posílá příkaz přes stejnou cestu jako `set-multiplier` a jen nad čerstvým neobnoveným statusem (INV-UI-02).

### 4. Dotčené INV
- **INV-MANUAL-01:** věta „Strop … nastavuje ho jen installer …, pilot ho při startu vždy přepíše“ se nahradí:
  > Strop ručního vstupu je durable záznam `safety.manualEntryCap` skupiny. Mění ho jen příkaz `set-manual-entry-cap` přes relay nebo explicitní instalační flag. Snížit jde kdykoli. Zvýšit jde jen za vypnuté kopírky, a pokud byla v session zapnutá, platí až od další session. Mez: ruční DEMO 10, běžná skupina 1 (do C19b). Reinstalace bez flagu záznam nemění.
- **INV-RISK-01:** strop vynucuje worker z vlastního durable stavu v okamžiku vyhodnocení i u přikoupení (celá pozice). UI hodnota nic neautorizuje.
- **INV-RISK-04:** `effectiveAt` z `msUntilTradovateSessionEnd` (DST).
- **INV-RELAY-01:** běžný copy-command, idempotency key per volání. Duplicitní zvýšení je neškodné, protože `expectedCurrent` je idempotentní.
- **INV-UI-01/02/03:** hodnota v UI je jen zobrazení, ovládání jen nad čerstvým statusem, OFF dosažitelný beze změny.
- **INV-WORKER-01:** CAS commit.
- **INV-ARM-02/03:** strop není v serializované konfiguraci ARM důkazu. Zvýšení za ARMED je zakázané, snížení jen zpřísňuje, takže ARM důkaz se nemusí zneplatnit.

### 5. Selhání a fail-closed
- **Restart uprostřed:** commit buď prošel, nebo ne. UI výsledek nezná, a proto ukáže hodnotu z dalšího pollu (nikdy optimisticky).
- **Souběh se vstupem:** serializace v `eventTail`. Vstup už rozběhnutý ve frontě má starý strop, další vstup nový.
- **Snížení pod otevřenou pozici:** jen blokuje přikoupení (`manual-cap` v `manualScaleIn.ts:291`). Nic se automaticky nezavírá.
- **Brzda nebo kill během zvýšení:** zvýšení samo riziko neotevírá, jen dovolí větší budoucí vstup a ten projde všemi branami (ARMED, riziko v $).
- **Selhaný durable zápis:** chyba příkazu, stav beze změny, bez `lastError`.
- **Zastaralé UI:** `expectedCurrent` nesedí → `cap-conflict`.

### 6. DEMO conformance
Žádná nová broker data. Ověření po nasazení na DEMO8661118 (Filip):
1. Z telefonu nastavit 7, pak `mac-reinstall-safe.sh` bez flagu → status dál 7.
2. Limit 6 daleko od trhu → zrušit ×.
3. Za ARMED zkusit 8 → odmítnuto.

### 7. Testy
- `tests/manualEntryCap.test.ts` (čistá funkce + controller s mock brokerem):
  - snížení za ARMED hned;
  - zvýšení za ARMED odmítnuto (mutačně: bez kontroly `gate.armed` test padá);
  - zvýšení po ARM v session = `pending`, které platí až po hranici session včetně dat DST (mutačně: bez `pending` padá);
  - `expectedCurrent` konflikt; strop; jiná skupina → 1;
  - vstup zařazený před změnou použije starý strop.
- Pilot (rozšířit test startu pilota): bez flagu ponechá durable hodnotu, flag přepíše, migrace staré skupiny jen jednou.
- `tests/tradovateCopierCommandRelay.test.ts`: přísné klíče, zvýšení za `armed` odmítnuto relayem.
- `tests/localCopierExecutionAgent.test.ts`: směrování, capability.
- `tests/copierStore.test.ts`: klon `pending`.
- UI: `tests/liveOrderTicket.test.ts` (strop ze statusu), `tests/livePhoneOrders.test.ts` (předvolby).

### 8. Soubory
`services/manualEntryPreview.ts`, `services/copierEngine.ts`, `services/copierStore.ts`, `services/supabaseCopierStore.ts`, `services/copierRuntimeController.ts`, `services/liveCopyTrading.ts`, `server/localCopierExecutionAgent.ts`, `server/tradovateCopierCommandRelay.ts`, `lib/copierWorkerCapabilities.ts`, `scripts/copier/pilot.ts`, `scripts/copier/mac-install.ts`, `components/TradovateLiveDesk.tsx`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneChart.tsx`, nový `components/LiveManualEntryCapControl.tsx`, `docs/COPIER_INVARIANTS.md`.

### 9. Velikost a závislosti
M. Bez závislostí. C19b na něm staví.

---

## C19b: Víc než 1 kontrakt v běžné skupině s followery

### 1. Verdikt
**STAVĚT-PO-CONFORMANCE.** Chybí záznam dvou věcí:
- dílčího fillu OSO s q > 1 u Tradovate (scale-in návrh: „NEOVĚŘENO … dílčí fill OSO q > 1“),
- chování kopie, když se leader a follower vyplní každý jindy.

Bez záznamu a replay testu se nestaví.

### 2. Chování
Stejný krokovač jako C19a i pro běžnou skupinu, ale jen s capability `manual-entry-group-qty-v1`. Ta je jen po instalačním opt-inu `--manual-entry-group-qty on`, zachovávaném v `mac-reinstall-safe.sh` jako `--scale-in`. Mez navrhuji 3 (rozhodne Filip).

Panel (PC i telefon) ukáže per follower `floor(q × násobek)` a jeho strop. Jen Limit/Stop, protože Market zůstává manual-only (`manualEntryPreview.ts:313-315`). Dílčí fill vstupu → čáry jen ke čtení a hláška „částečně vyplněno — jen Flatten / Tradovate“ (dnešní brána čistého tvaru).

### 3. Mechanismus
- Mez běžné skupiny v `manualEntryContractCap` = `MANUAL_ENTRY_GROUP_CAP_CEILING` jen s opt-inem, jinak 1.
- Preview beze změny vzorců: `followerQuantity` (`services/copierEngine.ts:733`), `max-contracts` (`manualEntryPreview.ts:432-434`) a `scaled-quantity-zero` už existují.
- **Nutné rozhodnutí podle replay testu:** `verifyFollowerMagnitude` (`copierRuntimeController.ts:7683-7790`) zná jen followera **za** leaderem (`awaitingCopiedEntry`, `:7666`). Follower **před** leaderem (leader 1/2, follower 2/2, zbytek leadera pracuje) dnes skončí divergencí → `failClosed` bez auto-close. To je bezpečné, ale pro q > 1 nepoužitelné.
  - Varianta A (doporučená pro první nasazení): ponechat fail-closed a q > 1 v běžné skupině povolit jen pro Limit **přes trh** (marketable) a Stop. Riziko „pomalý dílčí fill“ je tím menší, ne nulové.
  - Varianta B (změna jádra, vlastní critic): symetrický predikát „leader čeká na vyplnění zbytku vlastního vstupu“ — follower ahead ≤ zbytek pracujícího vstupu leadera × násobek, ohraničeno časem a epizodou.
- Brána správy čistého tvaru (2a/2b) se nemění: dílčí fill vstupu = blokováno.

### 4. Dotčené INV
- **INV-MANUAL-01** (text stropu běžné skupiny, opt-in).
- **INV-RISK-01** (`maxContracts` followera, `floor` násobku).
- **INV-TRAD-02:** venue-managed qty nohou při dílčím fillu se nekopíruje jako replace.
- **INV-DIVERGENCE-01:** varianta A beze změny; varianta B = nová úzká výjimka s důkazem.
- **INV-OUTBOX-03.**
- **INV-PART-02.**

### 5. Selhání
- Dílčí fill leadera a jiný stav followera → divergence → fail-closed (varianta A), žádný dorovnávací obchod.
- Restart během dílčího fillu: INV-TRAD-01 baseline a nová kontrola pozic.
- Brzda mezi fill událostmi: DISARM pozice nezavírá; ARM až po flat.
- Stream zpožděný za REST: správa z REST, dílčí fill = blokováno.

### 6. DEMO conformance (DEMO8661118, MNQZ6)
1. `scripts/copier/record-leader-oso.ts --quantity 3` (Limit na nejlepší ceně v rychlém trhu, opakovat, dokud nevznikne dílčí fill, nejvýš 5 pokusů). Zaznamenat Order / OrderVersion / Fill / ExecutionReport nohou (Suspended → Working, změny qty).
2. Zrušení zbytku dílčího vstupu: co Tradovate udělá s nohami.
3. Druhý DEMO účet jako follower (skupina na DEMO, násobek 1 a 0,5), ARMED, z appky Limit q = 2 a 3. Zaznamenat eventy obou účtů.

**Předpoklad:** druhý sim účet na stejném loginu, jinak bod 3 nejde.

### 7. Testy
- Replay nových fixtur přes controller:
  - dílčí fill leadera, plný followera (varianta A = divergence bez auto-close; B = čekání);
  - opačné pořadí;
  - násobek 0,5 a q 3 → 1;
  - `max-contracts` followera;
  - správa po dílčím fillu blokovaná (mutačně: povolení správy po dílčím fillu test shodí).
- `tests/manualEntryPreview.test.ts`: strop běžné skupiny jen s opt-inem.

### 8. Soubory
`services/manualEntryPreview.ts`, `services/copierRuntimeController.ts` (jen u varianty B), `scripts/copier/pilot.ts`, `scripts/copier/mac-install.ts`, `scripts/copier/mac-reinstall-safe.sh`, `scripts/copier/record-leader-oso.ts` (+ plan), `tests/fixtures/tradovate-leader-oso-partial-*.json`, UI jako C19a.

### 9. Velikost a závislosti
M (varianta B + L). Závisí na C19a.

---

## C20a: Vstup jen na leadera bez kopie ve skupině s followery

### 1. Verdikt
**STAVĚT.** K brokerovi jde stejný zápis (nativní OSO na leadera, fáze 1b). Nové je jen to, že followeři epizodu vynechají. K tomu se použije existující durable mechanismus `accountSyncPauses`, ne nová cesta.

### 2. Chování
- **PC:** výběr „Jen jeden účet → Leader (bez kopie)“ je aktivní i za zapnuté kopírky, pokud worker hlásí `manual-entry-leader-only-v1`.
  - Tlačítko: „Koupit 1 MNQZ6 · jen leader (bez kopie)“.
  - Nad ním věta „Followeři tento obchod vynechají; kopírovat znovu začnou samy po flat.“
  - Správa obchodu (SL/TP/BE/×) je stejná jako u vlastního vstupu (2a/2c/2d).
  - Followeři s pozastavením mají v řádku účtu štítek „vynechává obchod“.
- **Telefon:** v listu objednávky přepínač „Jen leader“. Výchozí je vypnutý a po každém odeslání se vrací. Lišta holého Marketu ho nemá (holý Market jen v manual-only).
- **Po obchodu:** běžný vstup jde až po uvolnění pauz. Do té doby blokuje s textem „Follower X ještě vynechává předchozí obchod jen na leadera — chvíli počkej / Kontrola pozic“.

### 3. Mechanismus
- **Payload:** `copy?: 'leader-only'` v `LeaderEntryPreviewCommand` (`lib/leaderEntryPreview.ts:25-63`; `COMMAND_KEYS` `:109`). Neplatné spolu s `position`. `intent.followerQuantities` musí být `[]` (`buildLeaderEntryPreviewCommand` `:214-234`). Relay validátor je sdílený (`validateLeaderEntryPlace` → preview). Admission RPC čte jen `payloadHash` / `operationId`, takže pole kryje otisk → **migrace ne**.
- **Preview** (`services/manualEntryPreview.ts:417-451`), čistě:
  - při `copy==='leader-only'` nevznikají follower příkazy ani kontroly on-fill / rizika followera;
  - pro každého **účastnícího se** followera (enabled, mode ≠ off, ne vyřazený, cut ne `done`): ověřený záznam, flat bez příkazů (`account-not-flat`), žádný rozpracovaný cut;
  - `no-follower-would-copy` se přeskočí;
  - poznámka se seznamem vynechávajících;
  - manual-only skupina → blocker `leader-only-manual-only`;
  - bez capability → `leader-only-off`.
  
  Nový blocker pro **běžný** vstup: follower s pauzou `reasonCode:'manual-leader-only'` na symbolu = `follower-paused-leader-only` (dnes je pauza jen poznámka `:430`, takže by kopie tiše chyběla).
- **Odeslání** (`executeManualEntry`, `copierRuntimeController.ts:3851`):
  1. Po vyhodnocení synchronně sestavit `pausedFollowers` = účastníci bez existující pauzy na symbolu. Každý musí mít `hasAuthoritativeFlatNoWorking(f, symbol)` (`:12800`) a `pendingTradeIngressByAccount = 0`, jinak `not-sent` před zápisem.
  2. **Jeden CAS commit** (nová pomocná `persistManualEntryAndPauses`, sourozenec `persistManualEntry` `:3617`) uloží:
     - záznam `sending` s `copy:'leader-only'` a `pausedFollowerIds`,
     - pauzy `{accountId, symbol, leaderEntryOrderId: 'manual:'+operationId, epochId: null, reasonCode: 'manual-leader-only', reason, pausedAt}`.
     
     Existující pauzu nikdy nepřepsat. `withAccountSyncPauses` (`:12826`) nahrazuje, proto se volá jen pro účty bez pauzy.
  3. Pojistka před POSTem (`:3928-3931`) navíc ověří, že všechny pauzy dál existují.
  4. Výsledky:
     - `not-sent` a `rejected` (definitivní, bez id) → v témž commitu odebrat **jen** pauzy s `leaderEntryOrderId === 'manual:'+op`;
     - `unknown` / timeout → pauzy zůstávají (fail-closed), pozdní ACK dopíše id;
     - `acknowledged` → v commitu ACK nahradit zástupné id skutečným `entryBrokerOrderId`; `epochId` doplní stejná logika jako u `entry-rejected` (`:7414-7420`) při otevření epochy;
     - `abandoned` → pauzy zůstávají.
- **Kopírka:** výjimka u `:17645-17653` — nezkopírovaný vlastní pár se neruší, má-li záznam `copy==='leader-only'`. Runner, kontrola velikosti, reconciliation a leader-flat guard pauzy už respektují (`:4184, :7694, :8869, :10713`). Guard po flat pauzy uvolní stávající cestou (`:10790-10816`).
- **Nová cesta uvolnění pro nevyplněný konec:** po `cancel-entry` `acknowledged`, nebo když stream uvidí ukončení vlastního vstupu bez fillu (filly, ne status — INV-TRAD-02), se naplánuje `releaseLeaderOnlyPauses(operationId)`:
  - ohraničené REST čtení leadera a pozastavených followerů (`listPositions` + `listOrders`, `Promise.all`, 3 s),
  - fence `tradeObservationVersionByAccount` jako `pauseReleaseFence` (`:10479`),
  - pak `releaseAccountSyncPausesSafely` (`:12874`) s predikátem: `reasonCode==='manual-leader-only'`, id sedí, `!symbolHasOpenEpoch`, oba flat bez příkazů.
  
  Selhání čtení = pauza zůstává a uvolní ji čistá Kontrola pozic (`:20382`).
- **Store a status:** `services/copierEngine.ts:174` rozšířit `reasonCode` o `'manual-leader-only'`; `services/supabaseCopierStore.ts:252` totéž. Status: `manualEntries[].copy`, `leaderOnlyPauses` (jen zobrazení), capability v `server/localCopierExecutionAgent.ts:407` jen pro skupinu s followery.
- **UI:**
  - `lib/liveTradeTarget.ts:86-97` `soloTradeBlockReason` pro leadera za ARMED vrátí `null` s capability;
  - `components/LiveOrderTicket.tsx:441-465` zrušit „Náhled zatím jen pro skupinu“ pro cíl = leader; `targetMultiplier` = 1;
  - `components/TradovateLiveDesk.tsx` předá `copy`;
  - telefon `lib/livePhoneOrders.ts`, `components/day/LivePhoneChart.tsx` přepínač.

### 4. Dotčené INV
- **INV-MANUAL-01:** nová podsekce. Návrh textu:
  > Vstup jen na leadera (`copy:'leader-only'`) jen ve skupině s followery a s capability. Všichni účastníci musí být autoritativně flat bez příkazů. Pozastavení followerů na symbolu se zapíše v jednom CAS commitu se záznamem `sending` PŘED POSTem. `not-sent`/`rejected` ho v témž commitu odeberou, ostatní výsledky ho nechají do autoritativního důkazu flat.
- **INV-DIVERGENCE-01:** předem deklarované vynechání epizody není divergence ani podnět k dorovnání. Pauza se uvolní jen autoritativním důkazem.
- **INV-OUTBOX-01** (durable před zápisem).
- **INV-PART-02/03:** pauza nemění účast ani `excludedForeignFollowers`; pozastavenému účtu se nic nepošle.
- **INV-ARM-01:** beze změny, ARM dál jen z flat.
- **INV-RELAY-03:** brzda vstup zneplatní; pauzy odebere jen `not-sent`.
- **INV-FRESH-01:** fence před POSTem i před uvolněním.
- **INV-DEFAULT-02/03:** `unknown`/`abandoned` = dnešní incidenty.
- **INV-UI-01..03:** štítky jen zobrazení.

### 5. Selhání
- **Restart po commitu před POSTem:** `sending` → `unknown` (dnešní pravidlo). Pauzy zůstávají, followerům se na symbolu nic nekopíruje, ARM stejně jen z flat. Řeší waiver + Kontrola pozic.
- **Timeout POSTu:** `unknown`, pauzy zůstávají, pozdní ACK dopíše id.
- **Dílčí fill a zrušení zbytku:** leader v pozici, followeři pozastavení. Guard po flat uvolní.
- **ACK za DISARMED** (brzda během POSTu): dnešní cílené zrušení vlastního vstupu (`:4055-4059`), pak cesta uvolnění bez fillu.
- **Uživatel během pauzy obchoduje na followerovi v Tradovate:** účet je jen pozorovaný. Uvolnění vyžaduje flat, takže pauza drží a běžné vstupy blokuje nový blocker. Žádné tiché částečné kopírování.
- **Uvolnění u jednoho followera selže:** blocker `follower-paused-leader-only` drží další běžné vstupy, dokud čistá kontrola pauzu nepustí.
- **Kill:** nové vstupy nejdou, pauzy durable zůstávají.
- **Zastaralý stream:** uvolnění vždy z REST čtení s fence.

### 6. DEMO conformance
Žádný nový záznam brokera. Ověření po nasazení vyžaduje DEMO skupinu s followerem (druhý sim účet):
1. Jen leader, Limit daleko → × zrušit → pauza uvolněna (status).
2. Jen leader, Limit přes trh → vyplnění → × zavřít → uvolnění.
3. Běžný vstup potom se zkopíruje.

### 7. Testy
`tests/manualEntryLeaderOnly.test.ts` (controller + mock broker + replay `tests/fixtures/tradovate-leader-oso-api-fill.json` / `-cancel.json`, skupina se 2 followery, ARMED):
- žádný zápis na followery (mutačně: bez pauz v commitu test padá);
- fill leadera bez divergence a fail-closed;
- vlastní pár se nezruší (mutačně: bez výjimky `:17651` padá);
- nevyplněné zrušení → uvolnění po REST;
- selhané čtení → běžný vstup blokován;
- `not-sent` / `rejected` odeberou jen vlastní pauzy (existující pauza `entry-rejected` zůstane);
- `unknown` a restart v `sending` pauzy drží;
- čistá Kontrola pozic je uvolní.

Dále:
- `tests/manualEntryPreview.test.ts`: leader-only brány, `follower-paused-leader-only`.
- `tests/leaderEntryPlace.test.ts` / relay: klíč `copy`.
- `tests/supabaseCopierStore.test.ts`: nový `reasonCode`.
- UI: `tests/liveTradeTarget*.test.ts`, `tests/livePhoneOrders.test.ts`.

### 8. Soubory
`lib/leaderEntryPreview.ts`, `lib/leaderEntryPlace.ts`, `services/manualEntryPreview.ts`, `services/copierEngine.ts`, `services/copierRuntimeController.ts`, `services/supabaseCopierStore.ts`, `server/localCopierExecutionAgent.ts`, `lib/copierWorkerCapabilities.ts`, `lib/liveTradeTarget.ts`, `components/LiveOrderTicket.tsx`, `components/TradovateLiveDesk.tsx`, `lib/livePhoneOrders.ts`, `components/day/LivePhoneChart.tsx`, `docs/COPIER_INVARIANTS.md`.

### 9. Velikost a závislosti
L (jemné souhry pauz a více kol critic). Bez závislostí.

---

## C20b: Vstup na vybraný follower / účet mimo skupinu; vstup za OFF

### 1. Verdikt
**ZAMÍTNOUT.**
- **Follower ve skupině:**
  - INV-MANUAL-01 „Ruční vstup z appky jde jen přes worker na leadera“;
  - INV-DIVERGENCE-01: ruční pozice followera ≠ leader × násobek = rozjetí, `verifyFollowerMagnitude` → `failClosed`;
  - INV-PART-03 „Nikdy: Neposílat vyřazenému účtu příkaz měnící expozici“, takže ani cesta přes vyřazení nejde.
- **Účet mimo skupinu:** worker ho nerouteuje ani nečte (INV-TRAD-06 per-account route), takže nemá read model, pozice, riziko ani fence.
- **Za OFF:** INV-MANUAL-01 „vyžaduje ARMED (ne shadow)“; OFF je brzda (INV-BRAKE-01, INV-RELAY-03: brzda ruční vstupy superseduje); bez ARM chybí čerstvý důkaz bran (INV-ARM-01/02).

Náhrady: C20a (jen leader) a S3b (vlastní manual-only worker pro samostatný účet).

### 2. Chování (jen UI úklid, STAVĚT jako S)
Výběr účtu dnes slibuje „Kopírka vypnutá — každý účet jde obchodovat samostatně“ (`components/LiveOrderTicket.tsx:589-591`, `lib/liveTradeTarget.ts:86-97`), odeslání to ale odmítne. Navrhuji:
- přepsat texty na „Obchod na follower účet / účet mimo skupinu z appky nejde — použij Tradovate, nebo Jen leader (bez kopie)“,
- položky followerů a účtů mimo skupinu nechat jen ke čtení,
- totéž na telefonu.

### 3–9.
Jádro beze změny.
- INV: INV-UI-01 (texty nesmí slibovat schopnost).
- Testy: `tests/liveTradeTarget*.test.ts` (žádný nevedoucí cíl není odeslatelný).
- Soubory: `lib/liveTradeTarget.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneChart.tsx`.
- Velikost: S.

---

## C21: Správa obchodů zadaných v Tradovate v ručním DEMO (cizí OSO bez outboxu)

### 1. Verdikt
**STAVĚT-PO-CONFORMANCE.** Tvar OSO/bracketu zadaného z Tradovate UI (ATM / OrderStrategy, text `multibracket` v `services/tradovateImport.ts:241`) a z TradingView a to, jak reaguje na `modifyorder`/`cancel`/`liquidate` z API, není v repu zaznamenané. Záznam fáze 0 pokrývá jen API `placeoso`. Riziko „TradingView po posunu z appky vrátí svou cenu nohy“ je v PROJECT_LOG 29. 10. vedené jako neověřené.

### 2. Chování
- **PC:** obchod zadaný v Tradovate na DEMO leaderovi (jedno SL + jedno TP) se v LIVE grafu chová jako obchod z appky, se štítkem „z Tradovate“: tah SL/TP (TP jen od trhu), BE, × zavřít. Čekající vstup z Tradovate má × (zrušit), jen pokud záznam prokáže, že zrušení rodiče zruší i nohy.
- Nečistý tvar (dílčí fill, ATM se 2 cíli, trailing, rozjeté nohy, víc obchodů na symbolu, mix s vlastními lístky) → čáry jen ke čtení a „spravuj v Tradovate / Flatten“.
- **Telefon:** stejné čáry v plném grafu (dvoukrokové ×).

### 3. Mechanismus
- **Bez durable adopce.** Identita se odvozuje u každého příkazu z vazeb broker příkazů a ověřuje autoritativním čtením. Přežije restart, protože baseline REST příkazů nese `parentId`/`ocoId`.
- `resolveManagedTrade` (`copierRuntimeController.ts:4552`): když outboxy nic nemají (`:4572`) **a** `group.manualOnly && group.followers.length === 0` **a** capability → `resolveObservedLeaderTrade(leaderEntryId)` (čistá funkce v novém `services/manualObservedTrade.ts`) nad cache streamu `liveOrdersByAccount.get(leader)`:
  - kandidát SL = otevřený Stop s `parentOrderId === entryId`;
  - kandidát TP = otevřený Limit s vazbou na SL podle zaznamenaného pole (`ocoId`/`linkedOrderId`);
  - oba opačná strana a stejný symbol, právě jeden od každého;
  - nic z toho není vlastní (`ownManualEntryOrderIds` / `ownManualLegOrderIds`);
  - klíč `observed:<entryId>`.
- Po autoritativním čtení (`:5120-5131`, `byId`) navíc ověřit vazby na čerstvých datech. Neshoda = `observed-shape`, nic se neodešle. Pak beze změny: čistý tvar (plný fill, obě nohy `working` bez fillu, qty = |pozice|, nic jiného na symbolu), brány dosahu (followeři prázdní), durable `manualOrderActions` `sending`, zápis mimo frontu, výsledek po noze.
- Riziko posunu SL dál od trhu z fillů vstupu / `openLots.avgPrice` jako 2b.
- `cancel-entry` jen pro tvar, u kterého záznam prokázal kaskádu na nohy. `close-position` = `liquidateposition` (2d, INV-MODE-02).
- **Status:** `manageableLeaderTrades` (`:21092`) přidá pozorované obchody se `source:'tracked'` a `origin:'observed'`. Starší UI je bere jako 2b, nový worker je vyřeší.
- **Relay a admission:** `manage-leader-order` s `leaderEntryOrderId` už admission zná (`20261101090849_copier_manual_admission.sql:67-75`) → **migrace ne**, relay beze změny. Validátor symbolu `lib/leaderOrderManage.ts:59` zůstává `(MNQ|NQ)`, jiné kořeny až se S1.
- **Capability** `manual-manage-observed-v1`, jen manual-only skupina bez followerů. V běžné skupině se větev nikdy nepoužije: tam platí 2b s pokrytím followerů.

### 4. Dotčené INV
- **INV-MANUAL-01:** nová „fáze 2e“. Návrh textu:
  > V manual-only DEMO skupině bez followerů smí `manage-leader-order` spravovat obchod leadera zadaný mimo appku. Identita z vazeb broker příkazů (`parentId`/`ocoId`) ověřená autoritativním čtením při každém příkazu; jen jeden SL + jeden TP, plný fill, nic jiného na symbolu; žádný outbox, durable je jen záznam akce.
- **INV-OUTBOX-01/02:** `manualOrderActions` durable před zápisem, `unknown` dořeší stream/čtení.
- **INV-TRAD-02:** Suspended nohy a dílčí fill = blokováno.
- **INV-TRAD-03:** identita nikdy z `clOrdId`.
- **INV-FRESH-01:** fence a route epoch před zápisem.
- **INV-MODE-02.**
- **INV-UI-01:** štítek a čáry jen zobrazení.
- **INV-DEFAULT-02.**

### 5. Selhání
- **Dvojznačná identita** (dva brackety, ATM se 2 cíli) → blokováno.
- **OrderStrategy Tradovate posun nohy vrátí:** zjistí záznam. Pokud ano, strategii poznat (pole ze záznamu do `tradovateMapping`) a takový tvar blokovat. Po posunu navíc platí dnešní potvrzení streamem (cena se po zápisu změnila na novou).
- **Zastaralý stream:** snímek nesedí → REST (dnešní `streamSnapshotMatchesLive`).
- **Restart:** identita znovu z REST baseline; `sending` → `unknown` (dnešní pravidlo).
- **Částečný úspěch** (SL ano, TP odmítnuto): výsledek po noze jako dnes, bez opakování.
- **DISARM nebo kill během posunu:** agent `brake-after-request` u `move-*`; `cancel-entry`/`close-position` dál smí (snižují riziko).

### 6. DEMO conformance (DEMO8661118, MNQZ6)
Nový `scripts/copier/record-foreign-trade.ts` (+ plan) s režimem jen naslouchání a s API variantou. Spouští ho Filip.
1. Filip zadá v Tradovate webu Limit s ATM bracketem (1 SL + 1 TP) daleko od trhu. Zaznamenat Order, OrderVersion, OrderStrategy a jejich vazby (`parentId`/`ocoId`/`linkedId`/`orderStrategyId`). Pak skript zruší rodiče → co se stane s nohami.
2. Totéž přes trh → fill. Skript `modifyorder` SL dál, TP dál, 20 s sleduje případný návrat ceny, pak SL na BE, pak `liquidateposition`.
3. ATM se 2 cíli (jen zaznamenat tvar pro test blokace).
4. Bracket zadaný z TradingView přes Tradovate (pokud ho Filip používá).
5. Kontrola: API `placeoso` (existující fixtura).

Konec vždy flat bez příkazů. Náklady jako fáze 0 (desítky USD na DEMO).

### 7. Testy
`tests/manualManageObserved.test.ts` (replay nových fixtur `tests/fixtures/tradovate-leader-foreign-*.json` přes controller):
- odvození identity;
- dvojznačné tvary blokované;
- vlastní příkazy vyloučené;
- běžná skupina nikdy nepoužije pozorovanou větev (mutačně: bez kontroly `manualOnly` test padá);
- neshoda vazby po REST → blokováno (mutačně);
- dílčí fill blokovaný;
- riziko posunu SL z fillů;
- zavření;
- `cancel-entry` jen pro prokázaný tvar;
- kompatibilita statusu.

### 8. Soubory
`services/copierRuntimeController.ts`, nový `services/manualObservedTrade.ts`, `services/tradovateMapping.ts` + `services/brokerPort.ts` (jen pokud záznam ukáže potřebu `orderStrategyId`), `server/localCopierExecutionAgent.ts`, `lib/copierWorkerCapabilities.ts`, `lib/liveChartOrderLines.ts` (štítek), `components/LiveTradingScreen.tsx`, `components/day/LivePhoneChart.tsx`, `scripts/copier/record-foreign-trade.ts`, `scripts/copier/recordForeignTradePlan.ts`, testy a fixtury, `docs/COPIER_INVARIANTS.md`.

### 9. Velikost a závislosti
M. Pro jiné kořeny než MNQ/NQ závisí na S1.

---

## S1: Další symboly NQ, ES, MES

### 1. Verdikt
**STAVĚT-PO-CONFORMANCE** a výslovné rozhodnutí Filipa per kořen. Dnešní pravidlo „jen MNQ“ zůstává výchozí: allowlist ve výchozím stavu `['MNQ']`. Další kořen jde zapnout až po záznamu na DEMO a instalačním opt-inu.

V1 jen pro manual-only DEMO. Běžné skupiny mají `maxContracts` followera bez jednotky (navrženo pro MNQ: 5 ES = 50× riziko 5 MNQ), proto jiný kořen ve skupině s followery blokuje `root-follower-caps-missing`, dokud nebudou stropy per kořen (samostatná položka).

### 2. Chování
- **PC:** v hlavičce LIVE grafu přepínač MNQ | MES | NQ | ES. Kořeny mimo allowlist workeru jsou jen ke čtení se zámkem („obchodování MES není zapnuté“).
- Panel bere tick value kořene (MNQ 0,50 USD, MES 1,25, NQ 5, ES 12,50 za tick) a riziko v $. SL/TP v bodech/ticích/$ podle kořene.
- **Telefon:** stejný přepínač v hlavičce plného grafu, list objednávky podle kořene.

### 3. Mechanismus
1. **Tabulka instrumentů** `lib/manualEntryInstruments.ts`: `{ root, tick 0.25, pointValue, feeRoundTurn, label }` pro MNQ/MES/NQ/ES. Jediný zdroj pro:
   - `services/manualEntryPreview.ts:117-118` (TICK, FEE),
   - `lib/leaderEntryPreview.ts:10, 103` (tick validace),
   - `components/LiveTradingScreen.tsx:66-67` (`INSTRUMENT`),
   - `lib/liveOrderTicket.ts`.
   
   Hodnota bodu zůstává z `services/futuresContractSpecs.ts`.
2. **Allowlist:** instalační `--manual-entry-roots MNQ,MES` (pilot, `mac-install.ts`, zachování v `mac-reinstall-safe.sh` jako `--scale-in`). Status `manualEntryRoots`, capability `manual-entry-roots-v1`.
   - Validátory strukturálně `^(MNQ|MES|NQ|ES)[HMUZ]\d$` (`lib/leaderEntryPreview.ts:13`, `lib/leaderOrderManage.ts:59`).
   - Worker vynucuje allowlist (`root-not-enabled`).
   - Relay navíc odmítne kořen, který status zařízení nehlásí (obrana do hloubky; klient, relay i worker jako dnes).
3. **Kotace klíčovaná kontraktem, ne kořenem:**
   - `services/ibkrPriceSource.ts:180` → odběr per povolený kořen (víc market-data linek). Jeden `IBApi`, jen čtení, INV-WORKER-04.
   - `server/tvPriceStreamSupervisor.ts:82` `latestQuote(root)` → `latestQuote(contract)`.
   - Controller `:3936, 4652, 4924, 5219, 19984` bere kotaci kontraktu příkazu; `:19944-19945` obecný kořen; `:19537` `frontContract` per povolený kořen (mapa).
4. **Křížová kontrola specifikace:** při startu číst Tradovate `product/find` (`valuePerPoint`, `tickSize`) per povolený kořen. Neshoda s tabulkou = kořen vypnutý (`instrument-spec-mismatch`), fail-closed.
5. **Graf:** `lib/tvLivePnl.ts:76` `PRICE_FAMILY` + `ES`/`MES`→`ES`. Historie přes `services/marketData.ts` (kořen obecný). Živé svíčky souboru rodiny `tv-live/<rodina>.json` (výjimka INV-UI-04 per rodina). `previewSymbolFromChartSource` (`lib/leaderEntryPreview.ts:240`) obecný. Pozice jiného kořene než grafu se v grafu nekreslí (štítek „pozice v ES“).

### 4. Dotčené INV
- **INV-MANUAL-01:** „Ruční vstup jen MNQ“ → „jen kořeny z instalační allowlistu (výchozí MNQ), po záznamu na DEMO a rozhodnutí Filipa“.
- **INV-UI-04:** jen IBKR pro riziko; TV jen zobrazení i u nových kořenů; licence dat platí jen pro Filipa.
- **INV-RISK-01:** hodnota bodu křížově s brokerem.
- **INV-WORKER-04** (víc odběrů ve vlákně ceny).
- **INV-UI-01.**

### 5. Selhání
- **Špatná specifikace:** kořen vypnutý.
- **IBKR nemá kořen:** Market/Stop blokované, Limit jen s frontem od brokera (dnešní pravidlo `manualEntryPreview.ts:338-350`).
- **Limit market-data linek IBKR:** odběr navíc selže → kořen bez ceny (fail-closed).
- **DEMO denní strop 250 USD:** NQ/ES se SL 12 b vyjdou nad strop → `risk-daily` blokuje. Je to správně, Filip musí strop DEMO pro větší kontrakty vědomě upravit.
- **Pozice kořene mimo graf:** čáry se nekreslí, zbývá Flatten / přepnutí grafu.

### 6. DEMO conformance (DEMO8661118)
`scripts/copier/record-symbols.ts --root MES|NQ|ES` (spouští Filip). Pro každý kořen zaznamenat:
1. `product/find` + `contractMaturity/deps` (`isFront`) + `contract/deps`.
2. `placeoso` Limit 1 daleko od trhu → zrušit.
3. `placeoso` Market 1 se SL/TP ≥ 16 ticků → `liquidateposition`. Zaznamenat `valuePerPoint`, `tickSize`, poplatky z Fill/commission.
4. IBKR jen čtení: odběr kořene, `marketDataType = 1`, bid/ask/last.

Náklad ES 1 kontrakt ~ 25–100 USD na DEMO (Filip schválí). Konec flat bez příkazů.

### 7. Testy
- Tabulka vs. zaznamenaná specifikace (fixtura).
- Riziko per kořen (ES 16 ticků = 200 USD/ks).
- Allowlist (worker, relay, klient).
- Směrování kotace podle kontraktu (mutačně: vrácené `'MNQ'` test shodí).
- `root-follower-caps-missing`.
- UI přepínač a tick value (`tests/liveOrderTicket.test.ts`).
- `tests/tvPriceClientGuards.test.ts` (TV dál nikam).

### 8. Soubory
Nový `lib/manualEntryInstruments.ts`, `lib/leaderEntryPreview.ts`, `lib/leaderOrderManage.ts`, `services/manualEntryPreview.ts`, `services/copierRuntimeController.ts`, `services/ibkrPriceSource.ts`, `server/tvPriceStreamSupervisor.ts`, `scripts/copier/tvPriceStreamThread.ts`, `scripts/copier/pilot.ts`, `scripts/copier/mac-install.ts`, `scripts/copier/mac-reinstall-safe.sh`, `services/tradovateBroker.ts` (`frontContract` per kořen + `product/find` spec), `server/tradovateCopierCommandRelay.ts`, `lib/tvLivePnl.ts`, `components/LiveTradingScreen.tsx`, `components/day/LivePhoneChart.tsx`, `lib/liveOrderTicket.ts`, `scripts/copier/record-symbols.ts`, testy, `docs/COPIER_INVARIANTS.md`.

### 9. Velikost a závislosti
L. Krok 3 je podmínkou S2.

---

## S2: Ruční volba kontraktu v týdnu rollu

### 1. Verdikt
**STAVĚT-PO-CONFORMANCE (lehká).** Broker zápis je stejný API, jen jiný kontrakt. Nezaznamenané jsou dvě věci: `placeoso` na příští kontrakt (`MNQH7`) a souběžný odběr dvou kontraktů v IB Gateway. Termín: do ~8. 12. 2026, kdy začíná okno rollu (`rollSoon` = 10 dní, `copierRuntimeController.ts:19945`).

### 2. Chování
- **PC:** v okně rollu čip `MNQZ6 ▾` v hlavičce grafu nabídne volbu MNQZ6 / MNQH7. Graf, panel i kotace se přepnou na vybraný kontrakt, se štítkem „týden rollu · vybráno ručně“. Ceny panelu jsou vždy ze stejného kontraktu, protože spread mezi měsíci je desítky až stovky bodů.
- Pozice v druhém kontraktu: čip „pozice v MNQZ6 — přepnout“. Její čáry jen na grafu jejího kontraktu.
- **Telefon:** stejný čip v hlavičce plného grafu.

### 3. Mechanismus
- **Vlákno ceny:** v okně rollu odebírá oba kontrakty, front a příští, z kandidátů `pickFrontContract` (`services/ibkrPriceSource.ts:488-498`). Zpráva kanálu už nese kontrakt (`IBKR:MNQH2027`). Žádný nový příkaz ani stav: UI jen vybírá, který stream zobrazit.
- **Controller:** kotace kontraktu příkazu (S1 krok 3). Kontrola původu už porovnává přesný kontrakt (`manualEntryPreview.ts:338-339`). `frontSymbols` v okně už obsahuje oba (`:19982`). Záložní cesta pro Limit přes front od brokera platí jen pro front (`:340-342`), takže na příštím kontraktu bez IBKR nic nejde (fail-closed).
- **Graf:** `previewSymbolFromChartSource` ze zdroje vybraného streamu; živé svíčky per kontrakt (`mergeLiveBarsFile` nikdy nemíchá kontrakty, INV-UI-04); historie příštího kontraktu ze zdroje svíček per kontrakt, jinak jen živé se štítkem.
- **Čáry:** `lib/liveChartOrderLines.ts` filtruje pozice a příkazy podle shody kontraktu. Pojistka utažení (`withIbkrTightenMark`) vyžaduje kotaci téhož kontraktu, a ta teď existuje pro oba.
- **Migrace ne.**

### 4. Dotčené INV
- **INV-MANUAL-01:** „Kontrakt jen ze zdroje ceny grafu, nikdy odhadem v týdnu rollu“ splní výslovná volba + kotace IBKR přesně toho kontraktu. Doplnit větu o ruční volbě.
- **INV-UI-04.**
- **INV-UI-01.**
- **INV-WORKER-04.**

### 5. Selhání
- IBKR drží jen jeden kontrakt → druhý nejde vybrat.
- Zastaralá kotace vybraného → Market/Stop blokované.
- Pozice v druhém kontraktu bez kotace → BE/utažení jen s cenou z P&L brokera, jinak blokované.
- Přelom frontu během okna → kandidáti se přepočtou, výběr zůstane jen pokud je mezi nimi.

### 6. DEMO conformance (DEMO8661118)
1. `record-symbols.ts --contract MNQH7`: `placeoso` Limit 1 daleko od trhu → zrušit (rozlišení kontraktu, `isFront=false`).
2. IBKR jen čtení: souběžný odběr MNQZ6 + MNQH7 (oba conId, `marketDataType 1`, kotace).

### 7. Testy
- Původ kontraktu per kontrakt (mutačně: porovnání kořene místo kontraktu test shodí).
- Výběr v UI jen v okně rollu.
- Filtrování čar podle kontraktu (mutačně).
- Pojistka utažení s kotací druhého kontraktu.

### 8. Soubory
`services/ibkrPriceSource.ts`, `server/tvPriceStreamSupervisor.ts`, `scripts/copier/tvPriceStreamThread.ts`, `services/copierRuntimeController.ts`, `lib/leaderEntryPreview.ts`, `lib/liveChartOrderLines.ts`, `lib/liveChartPosition.ts`, `components/LiveTradingScreen.tsx`, `components/day/LivePhoneChart.tsx`, `services/liveCandles.ts`, testy.

### 9. Velikost a závislosti
M. Závisí na S1 kroku 3 (kotace per kontrakt), ne na nových kořenech.

---

## S3a: Ochrana proti dvěma workerům na jednom připojení

### 1. Verdikt
**STAVĚT.** Detekce a odmítnutí jen zpřísňují. Plné fencing (lease) je v S3b. Částečně uzavírá otevřenou otázku N6.

### 2. Chování
Když relay vidí dva živé execution workery pro stejné připojení (nebo dvě instance téhož zařízení):
- **PC:** červený pruh „Na připojení běží dva workery — kopírka nejde zapnout a ruční vstupy jsou zablokované; jeden vypni“. OFF a Kill dojdou na oba.
- **Telefon:** čip kopírky „Pozor: dva workery“.

### 3. Mechanismus
1. **Relay** `selectRelayDeviceTarget` (`server/tradovateCopierCommandRelay.ts:236`) vrátí i `peers`: ostatní neodvolaná zařízení připojení (přímá + owner-scope, které připojení v statusu načetly) s čerstvým runtime < 60 s a s `status.controller`.
2. **Odmítnutí na enqueue** `copier-relay-multiple-workers` (409): `arm-live`, `activate-group`, `shadow`, `place-leader-entry`, `manage-leader-order` kromě `cancel-entry`/`close-position`/`attach-brackets` (snižují riziko), změny konfigurace.
3. **Brzdy fan-out:** `enqueue_tradovate_copier_brake` pro každé čerstvé zařízení se **stejným** idempotency key. Unikátní index je (user, device, key), takže **migrace ne**. Supersede (INV-RELAY-03) proběhne per uživatel jako dnes. Flatten zůstává na nejčerstvější, protože druhá likvidace naslepo by porušila zásadu „žádný blind retry“.
4. **Odpověď pollu/heartbeatu** nese `peerWorkers`. Worker při > 0 DISARM (jen zpřísnění) a ARM blocker `peer-worker` v `arm()` (`copierRuntimeController.ts`), audit. Zmizí po 60 s bez peeru.
5. **Dvě instance stejného zařízení:** heartbeat_v2 vrací `false` pro starší `startedAt` (`20260913154140_copier_relay_recoverable_delivery.sql:44-51`). Worker po dvou `false` za sebou přejde do terminálního stavu `superseded`: DISARMED, přestane brát příkazy relaye, proces běží dál (launchd ho nerestartuje do ping-pongu), durable incident.
6. **Server:** malá migrace `claim_tradovate_copier_command_v3(device, delivery, started_at)` odmítne výdej, když `runtime.started_at > p_started_at`.
   
   Zdůvodnění: dnes převzatá instance stále může vyzvednout příkaz, jen její ACK selže (INV-WORKER-03). Aditivní, v2 zůstává pro rollout.

### 4. Dotčené INV
- **INV-WORKER-03:** doplnit
  > Relay odmítne ARM a ruční vstupy při ≥ 2 čerstvých execution workerech připojení; brzdy jdou na všechny; převzatá instance nedostane příkaz (claim_v3). Stále to NENÍ fencing — síťově oddělený worker se neukáže.
- **INV-WORKER-02** (beze změny, lease v S3b).
- **INV-RELAY-01/03** (stejný klíč per zařízení, brzda nikdy neselže kvůli fan-outu: úspěch alespoň jednoho zařízení = úspěch).
- **INV-UI-02.**
- **INV-ARM-01** (nová brána).
- **§5 N6:** aktualizovat.

### 5. Selhání
- **Falešně pozitivní** (starý proces po reinstalaci ještě posílá heartbeat): ARM blokovaný do 60 s ticha. Bezpečné.
- **Síťově oddělený worker:** nevidí se. Je to zdokumentovaný limit, proto S3b.
- **Částečně selhaný fan-out brzdy:** výsledek per zařízení; UI ukáže, kam nedošla.
- **Restart relaye:** detekce je bezstavová, každý požadavek se počítá znovu.

### 6. DEMO conformance
Broker se nedotýká. Ověření (Filip): druhý worker s jiným device id proti DEMO připojení, nezapnutý → relay odmítne ARM a OFF dojde oběma. Pak druhá instance téhož zařízení → starší přejde do `superseded`.

### 7. Testy
- `tests/tradovateCopierCommandRelay.test.ts`: počítání peerů, matice odmítnutí, fan-out se stejným klíčem, owner-scope pokrytí.
- `tests/sql/copierClaimInstanceFence.pg.mjs` (skutečný Postgres): převzatá instance nedostane nic, nová ano.
- Worker: `superseded` po dvou `false` (mutačně: po jednom `false` ne).
- ARM blocker `peer-worker`.
- UI pruh a telefonní čip.

### 8. Soubory
`server/tradovateCopierCommandRelay.ts`, `server/macCopierCommandRelay.ts`, `server/recoverableCopierDelivery.ts`, `server/localCopierExecutionAgent.ts`, `services/copierRuntimeController.ts`, `api/tradovate/oauth/copier-relay.ts`, nová `supabase/migrations/2026110x_copier_claim_instance_fence.sql`, `tests/sql/copierClaimInstanceFence.pg.mjs`, `components/TradovateLiveDesk.tsx`, `lib/livePhoneCopierChip.ts`, `docs/COPIER_INVARIANTS.md`.

### 9. Velikost a závislosti
M. Bez závislostí.

---

## S3b: Víc skupin / workerů najednou

### 1. Verdikt
**STAVĚT-PO-CONFORMANCE** (po S3a a lease per účet). Víc skupin v jednom controlleru **nedoporučuji**: jádro má jedinou `group` napříč 21 000 řádky a přestavba je L+ s vysokým rizikem. Cesta je jeden proces = jedna skupina.

### 2. Chování
LIVE ukáže seznam běžících skupin (např. „Lucid → Tradeify“ a „Ruční DEMO“), každou s vlastní kopírkou, OFF, grafem a panelem. Na telefonu přepínač skupin v hlavičce.

### 3. Mechanismus
- Instalační slot: launchd label `com.alphatrade.copier.<slot>`, vlastní port. Stavové soubory už jsou per (připojení, leader) (`scripts/copier/pilot.ts:822 copierPilotStateKey`).
- Vlastní identita zařízení per slot (Keychain položka per slot, `server/macCopierDevice.ts`). Dnes jeden Mac = jedno zařízení, takže dva procesy by si příkazy kradly.
- IBKR `clientId` per slot, nebo jedno sdílené vlákno ceny.
- Relay routuje podle `groupId` příkazu mezi čerstvými zařízeními (ARM nese `group.id`).
- **Lease per účet:** migrace `copier_account_claims(user_id, account_id, device_id, fence, expires_at, primary key(user_id, account_id))` + RPC acquire/renew/release podle `services/copierWorkerLease.ts`. Worker je získá pro všechny účty skupiny před ARM a obnovuje s heartbeatem; ztráta = terminální DISARM (INV-WORKER-02). Disjunktní účty vynucuje DB, ne heartbeat.

### 4. Dotčené INV
- **INV-WORKER-02/03:** lease se poprvé zapojí.
- **INV-TRAD-04/06** (sdílený rate limit přihlášení, otázka 8).
- **INV-GROUP-01.**
- **INV-RELAY-01..03.**
- **INV-UI-02:** OFF pro každou skupinu i „vše“.

### 5. Selhání
- Ztráta lease → DISARM, bez zápisu.
- Překryv účtů → druhý worker se nezapne.
- Sdílený rate limit → p-ticket respektovat (INV-TRAD-04), bez reconnect storm.

### 6. DEMO conformance
Dva workery na stejném Tradovate loginu (DEMO), 1 h jen čtení (DISARMED): zaznamenat souběh dvou WS + REST, p-tickety, odpojení starší session, limity relací. Spouští Filip.

### 7. Testy
- SQL testy claim lease (dvě spojení, vypršení, fence).
- Routování podle `groupId`.
- Dva controllery nad jedním mock brokerem s disjunktními účty.
- Ztráta lease = DISARM.

### 8. Soubory
`scripts/copier/mac-install.ts`, `scripts/copier/pilot.ts`, `server/macCopierDevice.ts`, `server/tradovateCopierDevice.ts`, `server/tradovateCopierCommandRelay.ts`, `services/copierWorkerLease.ts`, nová migrace `copier_account_claims`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneChart.tsx`.

### 9. Velikost a závislosti
L. Závisí na S3a.

---

## R1: Skutečné Tradovate LIVE s vlastními penězi
**ZAMÍTNOUT.** Tvrdé pravidlo projektu: žádný příkaz do real-money LIVE prostředí Tradovate. Vynucuje:
- environment fence `services/copierRiskGate.ts:145, 167` (`environment-mismatch`, INV-RISK-01),
- heartbeat_v2 pouští jen zařízení s `environment = 'demo'` (`20260913154140_copier_relay_recoverable_delivery.sql:41-42`).

Prop účty v demo prostředí zůstávají beze změny.

## R2: Market (a Stop) bez IBKR s cenou z TradingView
**ZAMÍTNOUT.**
- INV-UI-04: TradingView je jen zobrazení, nikdy riziko, kopírka ani příkazy (Filip 1. 11.: „jen IBKR pro risk“).
- INV-UI-01: cena v UI nic neautorizuje.

Bez IBKR zůstává jen Limit s frontem od brokera (`services/manualEntryPreview.ts:338-350`).

## Otevřené otázky pro Filipa
1. Meze stropu: ruční DEMO 10? Běžná skupina (C19b) 3?
2. Zvýšení stropu po zapnutí v session: odložit na další session (návrh, anti-tilt), nebo odmítnout?
3. C20a: má mít odeslání „jen leader“ dvoukrokové potvrzení?
4. S1: pořadí kořenů (návrh MES → NQ → ES) a úprava DEMO denního stropu 250 USD pro NQ/ES.
5. Je na DEMO loginu druhý sim účet jako follower (C19b, ověření C20a)?
6. S3a: přijmout, že detekce není fencing, do doby S3b?


---

## Posudek copier-design-critic (návrh)

**Celkový verdikt: OPRAVIT PŘED COMMITEM**

- **P1** [C19a] (INV-MANUAL-01, INV-RISK-01, INV-RISK-04 (anti-tilt)) Instalační flag se uplatní při každém startu procesu, nejen při instalaci. Installer ho zapisuje do ProgramArguments v plistu (scripts/copier/mac-install.ts:473) a launchd ho předá při KeepAlive restartu, pádu, rebootu Macu i kickstartu. Návrh v pilotu říká „flag přítomen → zapsat záznam source:'install' (přepis)“. Scénář: instalace s `--manual-entry-max-contracts 5`, uživatel po ztrátě sníží strop z appky na 1, worker spadne (nebo se restartuje Mac), pilot vidí flag a zapíše 5. Snížení z appky tak tiše zmizí. Ohrožená je přesně ta anti-tilt vlastnost, kvůli které má být strop durable. Navíc návrh vychází z `mac-reinstall-safe.sh`, který manual-only instalaci vůbec neumí: bez `--followers` skončí `exit 5` (scripts/copier/mac-reinstall-safe.sh:65-68, PROJECT_LOG:430). Krok 1 DEMO conformance proto nejde provést a tvrzení „reinstalace bez flagu strop vrací na 1“ pro manual-only neplatí.
  - Oprava: Instalační hodnotu uplatnit jednou za instalaci. Installer zapíše `installId` (manifest už existuje: `--install-manifest`) a pilot přepíše záznam jen tehdy, když `record.appliedInstallId !== installId`. Alternativně installer zapíše durable záznam sám a plist flag nenese. Test: restart se stejným plistem nezmění hodnotu nastavenou z appky, nová instalace s flagem ji přepíše jednou (mutačně: bez kontroly installId test padá). Conformance krok 1 přepsat na skutečný postup reinstalace manual-only, případně nejdřív rozšířit `mac-reinstall-safe.sh` o manual-only tvar.
- **P1** [C20a] (INV-DIVERGENCE-01, INV-MANUAL-01 (2a/2c/2d), INV-DEFAULT-02, INV-PART-02) Návrh tvrdí, že správa obchodu jen na leadera je „stejná jako u vlastního vstupu“ a že pauzy už respektují všechna místa. V kódu to neplatí na třech místech. (1) `controllerUnmappedReplaceFollowers` (copierRuntimeController.ts:16217-16236) pauzy nezná. Pozastavený follower bez linku je `unmapped`, ledaže existuje intentional suppression. Ta se z durable pauzy odvodí jen při OTEVŘENÉ epoše a shodě `leaderEntryOrderId` s `epoch.leaderEntryOrderIds` (:12947-12975). (2) Coverage u `cancel-entry` (:5148) bere `currentEntryIneligibleAccounts()` (:1575), které pauzy neobsahuje. Scénář A: Limit jen na leadera čeká daleko od trhu a uživatel klikne v appce × → `coverage` „Followeři … nemají kopii vstupu navázanou“. Krok 1 conformance C20a tím selže. Scénář B (pravděpodobný, ověřit testem): uživatel v Tradovate posune čekající vstup nebo Suspended SL/TP obchodu jen na leadera. Přijde leader `replaced` s `executionShapeChanged`, epocha ještě není, pozastavení followeři jsou unmapped a :17811-17829 za ARMED volá `failClosed` (incident) při běžné akci. Scénář C: `unknown`/timeout s pozdním ACK. Návrh přepisuje zástupné id `manual:<op>` jen v commitu ACK. Pozdní ACK (:3986-4000) pauzu nepřepíše, suppression se po fillu neodvodí a posun SL nebo zavření jsou zablokované nebo skončí incidentem. Tvrzení „epochId doplní stejná logika jako u entry-rejected (:7414-7420)“ nesedí: tam se epochId nastaví jen při založení, žádné pozdější doplnění neexistuje a uvolnění epochId nepoužívá.
  - Oprava: Followera s pauzou `manual-leader-only`, jejíž id odpovídá operaci nebo vstupu, výslovně počítat jako `safelyUnmapped` v `controllerUnmappedReplaceFollowers`, v coverage `cancel-entry` i v `closeReachBlockers`. Platí to i bez otevřené epochy, ale jen pro příkazy patřící tomuto vlastnímu OSO (vstup a nohy z `ownManualEntryOrderIds`/`ownManualLegOrderIds`), nikdy obecně pro symbol. Id pauzy přepsat i v cestě pozdního ACK. Větu o doplňování epochId z návrhu i z INV vyhodit. Testy: (a) × čekajícího vstupu jen na leadera z appky, (b) modify čekajícího vstupu nebo nohy z Tradovate za ARMED bez failClosed, (c) posun SL a BE po fillu, (d) pozdní ACK, pak fill a posun SL. Vše mutačně: bez výjimky pro pauzu test padá.
- **P1** [S3a (krok 5 a 6)] (INV-WORKER-01/02/03, INV-BRAKE-03, INV-UI-02, §5 bod 1 a 7) (a) Worker `false` z `heartbeat_tradovate_copier_v2` nikdy nedostane: `heartbeatTradovateCopierDevice` boolean zahodí (server/tradovateCopierCommandRelay.ts:1325-1335; api/tradovate/oauth/copier-relay.ts:136, 278). (b) RPC vrací `false` i zdravé jediné instanci, když dorazí starší revize (supabase/migrations/20260913154140…sql:44-51). `background-v2` a `heartbeat-v2` běží souběžně s `++statusRevision` (server/macCopierCommandRelay.ts:417, 458) a `complete-v2` dělá vlastní heartbeat. Dva `false` za sebou tedy nastanou i bez druhé instance. Zdravý ARMED worker uprostřed obchodu by přešel do terminálního `superseded`. (c) `superseded` podle návrhu „přestane brát příkazy relaye, proces běží dál“. Proces přitom drží broker sockety i automatické zápisy v procesu (leader-flat guard, `cancelOwnManualEntry`, V2 cancel, ruší se i přikoupení). OFF, Kill a Flatten z telefonu na něj nedojdou a běží split-brain se dvěma zapisujícími. (d) Dvě instance téhož zařízení můžou sdílet `fileCopierStore` (.copier-pilot, klíč podle připojení a leadera). Superseded proces dál commituje (INV-WORKER-01: sdílený file store je nebezpečný). Při jiném cwd mají instance naopak oddělené stavy a nová o otevřených epochách neví.
  - Oprava: Server musí vracet výslovný důvod `superseded` jen při `runtime.started_at > vlastní startedAt`, nikdy při starší revizi. `superseded` = zastavit controller: žádný broker zápis ani automatika, zavřít sockety, žádný commit do store. Durable incident ohlásí nová instance. Hlavní ochrana pro stejný Mac: výhradní OS lock (flock) na globální cestě (Application Support, podle zařízení / klíče stavu, ne podle cwd) při startu pilota, takže druhá instance vůbec nenaběhne. Testy: revize mimo pořadí nikdy nespustí `superseded` (mutačně), skutečně starší startedAt ano, superseded nevolá broker ani store, druhý start s drženým lockem skončí bez zápisu.
- **P2** [C20a] (INV-DIVERGENCE-01, INV-UI-01, INV-PART-02) Zaseknutá pauza tiše vynechá další skutečný obchod leadera zadaný v Tradovate. Nový blocker `follower-paused-leader-only` kryje jen ruční vstupy z appky. Scénář: Limit jen na leadera se zruší, ohraničené REST čtení pro uvolnění selže (3 s, rate limit), pauza zůstane a kopírka zůstane ARMED. Leader pak otevře obchod v Tradovate. Runner bere pozastaveného followera jako ineligible (:4184, :14909), kontrola velikosti ho přeskočí (:7694) a guard uvolní pauzu až po flat TOHOTO obchodu (:10790-10816). Follower tak vynechá celý obchod bez incidentu, jen se štítkem. Další mezery: chování při všech pozastavených followerech v běžné skupině (OSO pár bez jediné kopie) není doloženo testem. Zda ON s připravenou receipt (bez veřejného `reconcile()`) zaseknuté pauzy uvolní, je NEOVĚŘENO.
  - Oprava: Uvolnění opakovat ohraničeně s backoffem. Když leader otevře novou epizodu se vstupem ≠ id pauzy a pauza `manual-leader-only` patří vstupu, který je podle streamu ukončený, nevynechávat potichu. Má to být viditelný incident (DISARM + lastError „follower by vynechal obchod“), případně ARM blocker do Kontroly pozic. Testy: selhané čtení pro uvolnění + nový obchod leadera z Tradovate (nesmí projít tiše), všichni followeři pozastavení (bez failClosed a bez kopie), ON s připravenou receipt a zaseknutou pauzou.
- **P2** [S3a] (INV-RELAY-03, INV-BRAKE-03, INV-ARM-01, INV-FRESH-03) (1) „Úspěch alespoň jednoho zařízení = úspěch brzdy“: když enqueue selže právě u ARMED workeru a projde u nečinného, UI ohlásí doručené OFF, které na zapnutou kopírku nedošlo. (2) Stav peerů ve workeru „zmizí po 60 s bez peeru“: při nedostupném relayi to znamená unknown → 0 peerů a lokální ARM přes loopback projde bez důkazu (fail-open). (3) Matice odmítnutí „změny konfigurace“ blokuje i risk-redukční a recovery příkazy (`resolve-stuck-operation`, vypnutí followera, `delete-group`). Uživatel pak stav nedokáže uklidit.
  - Oprava: Brzda je doručená jen tehdy, když se zařadila u všech čerstvých zařízení. Jinak výsledek „částečně“ s uvedením, kam nedošla, nikdy automatické opakování. Blocker `peer-worker` mazat jen úspěšným pollem s 0 peery. Neznámý stav peerů (žádný úspěšný poll do N s) = ARM blocker. Risk-redukční a recovery příkazy výslovně vyjmout. Testy pro všechny tři body.
- **P2** [C19a] (INV-RISK-01, INV-BRAKE-02, INV-ARM-03) (1) Pozdější snížení nezruší čekající `pending` zvýšení: snížení na 1 za tiltu, a v 17:00 CT naskočí dřívější čekajících 8. (2) Snížení pod pozici + čekající přikoupení: Limit přikoupení už leží u brokera a jeho fill pozici nad nový strop dostane. Návrh to neřeší. (3) Strop se v `executeManualEntry` znovu nekontroluje synchronně těsně před POSTem (u přikoupení ano, :3946-3953). Serializace v eventTail sice drží (placeLeaderEntry :20039), ale pojistka by měla být stejná. (4) Zvýšení pod kill switchem, `dayLockUntil` nebo cooldownem návrh nezakazuje. (5) Záznam podle `groupId` přežije smazání a znovuaktivaci skupiny se stejným id, přitom INV-GROUP-01 chápe aktivaci jako čerstvou. (6) `relayRiskGroup`/`isWeakerRiskConfig` strop neznají, protože není v group. Relay nesmí kvůli `tighten-only` odmítnout snížení.
  - Oprava: Snížení vždy smaže `pending`. Snížení pod |pozice| + čekající přikoupení buď odmítnout (`cap-below-open`), nebo výslovně zdokumentovat. Synchronní kontrola stropu těsně před POSTem. Zvýšení odmítnout za kill, day locku i cooldownu. Záznam smazat při retire/activate. Relay validovat vlastní logikou: snížení nikdy neblokovat. Testy pro každý bod.
- **P2** [S1] (INV-RISK-01 („nikdy volnější“), INV-MANUAL-01) Tabulka instrumentů nepokrývá natvrdo zapsané hodnoty mimo vyjmenovaná místa. `copierRuntimeController.ts:4940` `const fee = symbol.startsWith('NQ') ? 5 : 1.5` dá ES/MES poplatek 1,5 USD, takže riziko posunu SL dál od trhu vyjde nižší (volnější). Dále tick 0,25 natvrdo v pojistce utažení (:4926) a v driftu Marketu (:3942); pro čtyři navržené kořeny sedí, ale není z tabulky. `:19944-19945` rozlišuje jen NQ/MNQ. Ochranný odstup Marketu jako marketable limit (+2 b) je potřeba per kořen. `lib/leaderOrderManage.ts:59` je `(MNQ|NQ)`.
  - Oprava: Všechny výskyty vést přes `lib/manualEntryInstruments.ts`. Přidat statický test, který v cestách ručního vstupu a správy zakáže literály `'MNQ'`, `startsWith('NQ')` a `* 0.25`. Neznámý kořen = poplatek nejvyšší z tabulky (přísněji), nikdy 1,5. Test rizika posunu SL pro ES s poplatkem.
- **P2** [C21] (INV-RISK-01, INV-MANUAL-01 (2b), INV-UI-04) Zdroj rizika pro posun SL dál od trhu u pozorovaného obchodu chybí. Kód počítá body z `scaleInPositionLossPoints(leaderPosition(symbol))` (:4933) a model staví jen z vlastních ručních záznamů a fillů v paměti (:3560-3570). U obchodu zadaného v Tradovate je výsledek `null`, takže `risk-unverified` a posun dál od trhu nikdy nepůjde. Zmínka „jako 2b“ mechanismus nepopisuje. Riziko návratu ceny nohy přes TradingView po BE (uživatel věří utaženému SL, ale platí původní, vzdálenější) je správně svázané s conformance, jen je potřeba výslovná blokace TV bracketů, dokud záznam nevyloučí návrat.
  - Oprava: Riziko pozorovaného obchodu brát z autoritativních fillů vstupu (REST fill list podle id vstupu, s fence). Bez nich posun dál od trhu blokovat a utažení, BE a × nechat. Brackety z TV blokovat, dokud conformance neprokáže, že se cena nevrací. Test: posun dál bez fillů = blokováno, s fill fixturou = správné riziko.
- **P3** [C19b] (INV-DIVERGENCE-01, INV-TRAD-02) Podmínku varianty A „Limit přes trh“ worker dnes neověřuje: v náhledu je to jen poznámka `limit-marketability` (manualEntryPreview.ts:349). Není definováno, jak se „přes trh“ prokáže. Bez toho je q > 1 i u pasivního Limitu, tedy s vyšším rizikem dílčího fillu.
  - Oprava: q > 1 v běžné skupině povolit jen s čerstvou kotací IBKR (≤ 3 s), podle které je Limit přes trh aspoň N ticků, jinak blocker. Replay fixtury dílčího fillu musí existovat před implementací. Ponechat `failClosed` bez auto-close (ověřeno :7790).
- **P3** [S3b] (INV-WORKER-02, INV-WORKER-01) „Ztráta lease = terminální DISARM“ nestačí: DISARM nezastaví leader-flat guard ani automatické cancel cesty. INV-WORKER-02 požaduje skončit. Mac `fileCopierStore` nemá fence, takže lease je bez fencovaného store jen poradní.
  - Oprava: Ztráta lease = zastavit všechny broker zápisy i commity a ukončit. Lease svázat se store s fence (Supabase store) nebo s OS lockem. Dvě skupiny se stejným leaderem výslovně odmítnout (lease leadera).
- **P2** [Testy (všechny položky)] (§3 otázka 25) Testy se nespouštěly (zadání: jen čtení). Návrh uvádí hlavně happy path a mutační testy. Chybí: C19a restart se stejným plistem, snížení s čekajícím pending, kill + zvýšení. C20a pending modify z Tradovate, × z appky, pozdní ACK, všichni followeři pozastavení, selhané uvolnění + nový obchod z Tradovate, výpadek spojení uprostřed obchodu jen na leadera (INV-RECON-04 `protectiveHoldProblem`). S3a heartbeaty mimo pořadí, superseded bez zápisů, částečný fan-out brzdy, nedostupný relay a ARM přes loopback. S1 poplatek ES v :4940. C21 posun dál bez fillů.
  - Oprava: Doplnit tyto scénáře jako deterministické testy (mutačně) před commitem jednotlivých položek.

### Verdikty po položkách

- C19a: **OPRAVIT** — Durable záznam, CAS přes persistSafetyUpdate (:3396) a serializace s placeLeaderEntry v eventTail (:20039) jsou správně. Instalační flag v plistu ale přepíše hodnotu z appky při každém restartu (mac-install.ts:473), takže anti-tilt snížení zmizí. Conformance krok 1 nejde provést, protože mac-reinstall-safe.sh manual-only neumí (exit 5). K tomu výhrady: pending vs. snížení, čekající přikoupení, kill/day lock, relay.
- C19b: **OK S VÝHRADAMI** — STAVĚT-PO-CONFORMANCE je správně a fail-closed bez auto-close je ověřený (:7790). Varianta A musí podmínku „Limit přes trh“ dokázat kotací IBKR. Závisí na opraveném C19a.
- C20a: **OPRAVIT** — Opřít se o accountSyncPauses je správný směr: auto-close (:11089-11113), guard (:10713, :10790), kontrola velikosti (:7694) a runner (:4184) pauzy respektují. Kontrola unmapped replace (:16217) a coverage pro cancel-entry (:5148) je ale neznají. × čekajícího vstupu je proto blokované, modify z Tradovate povede k failClosed a pozdní ACK nechá zástupné id. Zaseknutá pauza tiše vynechá další obchod z Tradovate. Tvrzení o doplňování epochId nesedí s kódem.
- C20b: **ZAMÍTNUTÍ SPRÁVNÉ** — INV-MANUAL-01, INV-DIVERGENCE-01, INV-PART-03 i neroutovaný účet mimo skupinu (INV-TRAD-06) zamítnutí podporují. Úklid textů v UI (INV-UI-01) je v pořádku.
- C21: **OK S VÝHRADAMI** — Bez durable adopce, identita z parentOrderId/ocoId (brokerPort.ts:62-64, tradovateMapping.ts:336-338) ověřená REST čtením, jen manual-only. STAVĚT-PO-CONFORMANCE je správně. Chybí zdroj rizika pro posun SL dál od trhu (dnes vyjde null) a výslovná blokace TV bracketů.
- S1: **OK S VÝHRADAMI** — Allowlist s výchozím MNQ, křížová kontrola s product/find a blokace kořenů ve skupině s followery jsou správně. Tabulka musí nahradit i :4940 (poplatek ES/MES 1,5), :19944-19945 a odstup marketable limitu. Riziko nikdy nesmí vyjít volnější.
- S2: **OK S VÝHRADAMI** — Kontrola původu podle přesného kontraktu (manualEntryPreview.ts:338-339) a flat brána přes celý účet (:372) dvě pozice v různých kontraktech zablokují. Záloha pouze pro front je fail-closed. Potřebuje kotaci podle kontraktu z S1 a conformance dvou odběrů IBKR.
- S3a: **OPRAVIT** — Detekce, odmítnutí ARM a fan-out brzd jsou správné zpřísnění a správně přiznávají, že nejde o fencing. Krok 5 ale stojí na signálu, který worker nedostává, a `false` vzniká i z revizí mimo pořadí. Stav `superseded` bere brzdy z relaye procesu, který dál drží broker i store. Sémantika částečného fan-outu brzdy a neznámý stav peerů jsou fail-open.
- S3b: **OK S VÝHRADAMI** — Jedna skupina na proces a lease per účet je správná cesta. Ztráta lease ale musí zastavit všechny zápisy, ne jen DISARM, a lease potřebuje store s fence. Stavět až po S3a a vlastní oponentuře.
- R1: **ZAMÍTNUTÍ SPRÁVNÉ** — Environment fence (copierRiskGate.ts:145, 167) a heartbeat_v2 jen pro `environment='demo'` (migrace 20260913154140, ř. 41-42).
- R2: **ZAMÍTNUTÍ SPRÁVNÉ** — INV-UI-04 a INV-UI-01. Bez IBKR zůstává jen Limit s frontem od brokera (manualEntryPreview.ts:338-350).
- Kontrolní seznam (26): **viz poznámka** — 1 ARM bez bran: drží (žádná položka ARM neoslabuje). S3a: neznámý stav peerů nesmí povolit ARM, PORUŠENO v návrhu. 2 Unknown→flat/0: C20a zakládá pauzu z cache jen jako zpřísnění (:12800), drží. S3a „zmizí po 60 s“ dělá z unknown 0 peerů, PORUŠENO. 3 Mazání lastError: nová cesta uvolnění volá jen releaseAccountSyncPausesSafely (:12874), drží. 4 Veřejný vs. interní reconcile: uvolnění Kontrolou pozic je ruční (:20382), nová cesta interní, drží. 5 Souběh během await: C19a eventTail drží. C20a kontrola pauz před POSTem drží. S3a superseded uprostřed obchodu PORUŠENO. 6 Fence před zápisem a commitem: C20a fronta (:3922) + pauseReleaseFenceHolds, C21 REST vazby, drží. 7 Druhé provedení: bez opakování, fan-out se stejným klíčem per zařízení, drží. 8 Outbox durable: C20a záznam sending + pauzy jedním CAS commitem, drží. 9 Dílčí fill OCO/OSO: C19b a C21 až po conformance, C20a guard po flat, drží. 10 Divergence obchodem: nikde. C20a ale vede na failClosed místo deklarovaného vynechání (:17811), OPRAVIT. 11 Cíl zavření: auto-close pauzy respektuje (:11089-11113), C21 jen jediný DEMO účet, drží. 12 Nejasná likvidace: beze změny (INV-MODE-02). 13 Management-only: vstup jen na leadera prochází branami náhledu (halt), NEOVĚŘENO testem. 14 Toggle/cut/skupina: setFollowerEnabled vyžaduje flat leadera (:20740+), aktivace maže pauzy (:19271), drží. Záznam stropu C19a podle groupId je výhrada. 15 Eligibility: jen zpřísnění (S1 instrument-spec-mismatch), drží. 16 Session/DST: msUntilTradovateSessionEnd (copierArmSession.ts:69), líný roll sessionArmedAt je přísnější, drží. 17 Dosažitelnost DISARM/kill: S3a superseded nebere brzdy z relaye, PORUŠENO. 18 Relay TTL/klíč: drží, sémantika částečného fan-outu chybí. 19 Pořadí pollů v UI: hodnoty jen z pollu, drží. 20 Restart uprostřed: C20a sending→unknown drží pauzy, pozdní ACK nepřepíše id, OPRAVIT. 21 Dvě OAuth route: pilot má jeden relay (:1906), drží. 22 Dva workery: S3a není fencing (přiznáno), krok 5 PORUŠENO, S3b lease bez store s fence. 23 p-time: product/find při startu a dva loginy (S3b) musí respektovat p-ticket, výhrada. 24 Víkend: netýká se. 25 Testy: chybí scénáře chyby, pořadí a restartu (viz nález Testy). Testy jsem nespouštěl. 26 Oddělení tvrzení: návrh odděluje kód, instalaci a conformance, drží. Krok 1 C19a ale nejde provést.
