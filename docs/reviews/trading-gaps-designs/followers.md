# Followeři — návrh F1–F7 (3. 11. 2026)

Kód čtený výhradně ve worktree `/Users/filipkrejca/alphatrade-worktrees/scale-in` (HEAD 7ae5c97b = origin/main, worker e37d7963). Nic nebylo upraveno ani spuštěno, žádné spojení s brokerem. Odkazy `soubor:řádek` platí pro tento HEAD.
Každá položka mění jádro kopírky (ARM, outbox, reconcile, způsobilost, risk brány). Proto podle CLAUDE.md §4 musí návrh i hotový diff projít agentem `copier-design-critic`, a to před implementací. Tento dokument je vstup pro oponenturu, ne schválený plán.

## 0. Shrnutí verdiktů

| # | Položka | Verdikt | Velikost | Závisí na |
|---|---|---|---|---|
| F1 | Market, holý Market + Přidat SL/TP, přikoupení ve skupině s followery | **JEN-ČÁST**: Market se SL+TP a Market přikoupení až po DEMO záznamu; holý Market a „Přidat SL/TP“ s followery **ne** | L | C1, C2, C3, C7; přikoupení navíc strop běžné skupiny > 1 (jiná skupina položek) |
| F2 | On-fill followeři dostanou SL/TP nohy a jejich posuny | **STAVĚT-PO-CONFORMANCE** | L | F1 (S1), C2, C3 |
| F3 | NQ→MNQ, inverzní kopie, pevné qty | **JEN-ČÁST**: jen NQ→MNQ, a to později po C6 a rozhodnutí Filipa; inverzní kopie a pevné qty **ne** | L (podmnožina) | C6; doporučeno až po F1/F2 |
| F4 | Násobek < 1 nesmí zablokovat vstup; strop má kopii oříznout | **JEN-ČÁST**: 0 ks = follower vynechá; strop = follower vynechá epizodu přes durable pauzu; **ořez ne** | M | — |
| F5 | Ruční vstup bez flat u followerů s vlastní pozicí | **JEN-ČÁST**: UI nad existujícím INV-PART-03 a volitelně vyřazení i za ARMED; žádné automatické vracení | S (+S/M) | — |
| F6 | Samostatná správa followera z grafu | **JEN-ČÁST**: „× jen u tohoto účtu“ (existující `flatten-follower-trade`) ano; jiný SL u followera **ne** | S | — |
| F7 | Brána proti kopii bez ochrany | **STAVĚT-PO-CONFORMANCE**: část A (čekající vstup bez nohou) jde hned, část B (Market) až po F1 a C4 | M | F1 (pro B), C4 |

Doporučené pořadí: F6 → F4 → F5-A → F7-A → (C1–C3, C7) → F1 → F7-B (po C4) → F2 → F3 (po C6).

## 1. Potvrzená pravidla (beze změny)

- **Lucid ↔ Tradeify zůstává blokované.** Platí `docs/COPIER_PROPSHIELD_REVIEW_20260831.md` §0: Tradeify FTA §6.6 zakazuje použití napříč firmami a platí do písemného potvrzení Tradeify. Žádná položka tohoto návrhu nepřidává cestu, která by spojila účty různých firem v jedné skupině. F1/F2 se stavějí výhradně pro skupiny jedné firmy, případně pro DEMO.
- **Za ARMED jdou pravidla followerů jen zpřísnit.** `assertTightenOnly` (`services/copierRuntimeController.ts:5587`), `isWeakerRiskConfig` (`lib/copierRiskConfig.ts:118`, followeři `:237–268`) a relay `relayNeedsTightenOnly` (`server/tradovateCopierCommandRelay.ts:~684`) zůstávají beze změny. Nová pole z tohoto návrhu se do pravidla zařazují takto:
  - `copyRequiresProtection` (F7): true → false je zmírnění,
  - `symbolMap` (F3): přidání mapování je zmírnění,
  - vyřazení followera (F5-B) je zpřísnění.
  Žádné automatické vrácení followera za ARMED se nenavrhuje.
- Dál platí: DISARMED default, fail-closed, žádný blind retry, divergence se nikdy neopravuje obchodem (INV-DIVERGENCE-01), ruční příkazy jen přes relay (INV-RELAY-01, INV-MANUAL-01), žádný zápis do real-money LIVE prostředí, ruční vstup jen MNQ, TradingView jen pro zobrazení (INV-UI-04), cena v UI nic neautorizuje (INV-UI-01).

## 2. Sdílené stavební kameny (znovupoužití existující infrastruktury)

**S1 — nativní OSO s Market rodičem pro followera.** Broker vrstva Market rodiče už umí. `BrokerOsoRequest extends BrokerOrderRequest` (`services/brokerPort.ts:286`) a leader ho posílá v `executeManualEntry` (`services/copierRuntimeController.ts:3851`, `osoRequest` ~`:3965`). Chybí čtyři věci:
1. Korelace Market rodiče s nohami. `isEntryType` (`services/copierOsoCorrelator.ts:49`) zná jen Limit/Stop/StopLimit, Market proto dostane `unrelated` (`:99`). Jeho SL noha pak v korelátoru omylem založí kandidáta na „vstup“: `parentId` míří na Market, který v `entries` není.
2. `LeaderOsoPair.entryOrderType` (`:12`) Market nezná.
3. `processOsoPair` (`services/copierRunner.ts:1215`) neumí požadavek bez ceny vstupu.
4. Recovery outboxu: Market OSO, které po autoritativním čtení „nevzniklo“, se nesmí poslat znovu. `resolveOsoLookup` (`services/copierOsoOutbox.ts:110–111`) ho dnes vrací do `planned`. U Marketu by tím vznikla pozdní kopie.

S1 je jádro F1, F2 a F7-B.

**S2 — follower vynechá epizodu = durable pauza.** Existuje `CopierAccountSyncPause` (`services/copierEngine.ts:168`, typ reasonCode i v controlleru `:326`) s `reasonCode: 'entry-rejected' | 'protective-filled-early'`. Vzniká v CAS commitu (`sidelineRejectedFollower`, `services/copierRuntimeController.ts:7377`, pauza `:7411–7421`). Je to tvrdá brána v `cutAwareDispatchFor` (`:14891`, `withSyncPauses`): účet dostane `account-sync-paused`, runner ho zapíše jako `skipped` (`blockedAuditKind`, `services/copierRunner.ts:276`), takže nejde o kritický audit. `verifyFollowerMagnitude` takový účet přeskočí (`:7683–7692`). Po restartu se suppression obnoví jen nad autoritativně flat účtem (`currentIntentionalSuppression`, `:12947`). Pauza se uvolní sama, až jsou leader i účet flat bez příkazů.
Návrh rozšiřuje reasonCode o `'cap-exceeded'` (F4), `'late-market-copy'` (F1/F2) a `'unprotected-entry'` (F7). Nic dalšího se nemění.

**S3 — tombstone vstupu leadera.** Vzor je `blockOutsideTradingWindow` (`:13233`). Používá `rememberIntentionalEntrySuppression` (`:13125`), `rememberBlockedLeaderEntryOrder` (`:12769`) a dělí exit slice. Pozdní nohy blokované entry se dál nekopírují (`protective-child-of-blocked-entry`, `protective-pair-of-blocked-entry`, `:17250–17316`). F7 tak dostane „followeři obchod vynechali“ bez divergence a bez nového mechanismu.

**S4 — model pozice followera po lístcích.** Čistá funkce `followerPositionModel` v `services/manualScaleIn.ts`, obdoba `leaderPositionModel` (`:128`). Lístky followera jsou položky `osoOutbox` ve stavu `acknowledged`, jejichž `leaderEntryOrderId` patří lístkům leadera. Nohy se berou z `liveOrdersByAccount` followera a krytí jen nohami potvrzenými streamem (stejný predikát `confirmed`, `:186`). Funkci potřebuje přikoupení s followery (F1) a nadkrytí followera.

---

## 3. F1 — Market, holý Market + Přidat SL/TP a přikoupení ve skupině s followery

### (1) Verdikt: JEN-ČÁST
- **Stavět po DEMO záznamu (C1, C2, C3, C7):**
  - Market vstup se SL+TP ve skupině s followery,
  - přikoupení Marketem ve skupině s followery, a jen když mají všichni zúčastnění followeři celočíselný násobek ≥ 1.
- **ZAMÍTNOUT: holý Market a „Přidat SL/TP“ ve skupině s followery.** Blokuje to výslovné pravidlo INV-MANUAL-01 („Vlastní OSO se nikdy nekopíruje bez nohou“, `flushStandaloneOsoEntry`) a závazný produktový invariant PropShield §1.1 („žádný nový follower entry bez kompletního, bezpečně známého ochranného plánu — bez ohledu na typ příkazu“). Holý Market zůstává jen v manual-only DEMO skupině.
- **Zatím ne: čekající přikoupení Limit/Stop s followery.** Důvod je známý limit v INV-DIVERGENCE-01: „čekání u scale-inu (follower už v pozici) varianta 1 nepokrývá — kontrola velikosti skupinu vypne“. Kopie followera vyplněná později než leader by vždy skončila incidentem.

### (2) Chování pro uživatele
- **PC panel:**
  - Market je ve skupině s followery povolený jen s capability `manual-entry-market-followers-v1`.
  - Řádky účtů (`components/LiveOrderTicket.tsx:598–604`) ukazují `floor(q×m)` ks na followera. U 0 ks se zobrazí „vynechá (násobek)“, viz F4.
  - Poznámka v panelu: „Followeři dostanou stejné OSO (Market + SL + TP) hned po vyplnění leadera; jejich cena se může lišit o skluz.“
  - „Zkontrolovat u workeru“ vrací i kopie followerů.
  - Přikoupení s followery jde jen Marketem. Limit/Stop přikoupení má text „Ve skupině s followery jde přikoupit jen Marketem.“ Štítek: „přikoupení · SL/TP pozice · followeři ×m“.
- **Telefon:**
  - List objednávky a position box ⚡ se chovají stejně jako na PC.
  - Pilulka holého Marketu je ve skupině s followery vypnutá s textem „Holý Market jen v ručním DEMO — ve skupině s followery vždy se SL/TP.“
  - „Přidat SL/TP“ se v takové skupině nenabízí.
- **Notifikace:**
  - lepivá karta „Followeři obchod vynechali (pozdní Market kopie)“, když nastane S2 s `late-market-copy`,
  - „Follower X vynechá — broker kopii odmítl“.

### (3) Mechanismus
1. **Náhled** (`services/manualEntryPreview.ts`):
   - Blocker `market-manual-only` (`:312–315`) se nahradí podmínkou: buď manual-only DEMO, nebo zároveň:
     - nový vstup `marketFollowersEnabled` (opt-in workeru),
     - `brokerEnvironment === 'demo'`,
     - všichni zúčastnění followeři mají `on-submit` (po F2 i `on-fill`).
   - Nový blocker `bare-with-followers`, když `isBareLeaderEntry` a `group.followers.length > 0`.
   - Přikoupení: nový vstup `followerScaleIn: Map<accountId, issues[]>` a velikost kopie `q×m`. Blockery:
     - `scale-in-follower-multiplier`: násobek není celé číslo ≥ 1,
     - `scale-in-follower-limit`: přikoupení není Market,
     - `scale-in-follower-uncovered`, `scale-in-follower-foreign-orders`, `scale-in-follower-position`: model S4 nesedí,
     - `max-contracts`: na celou pozici followera `|net_f| + q×m`,
     - risk followera: `checkAccount` (`:364`) s `existing` z VWAP fillů followera; neznámý VWAP = `risk-unverified`.
2. **Korelace vlastního Marketu podle id z ACK** (`services/copierOsoCorrelator.ts`):
   - Nová metoda `expectOwnOso(entryId, stopId, targetId)`. Volá ji `executeManualEntry` hned po ACK, na stejném místě, kde plní `ownManualLegOrderIds` (`services/copierRuntimeController.ts:~4036–4040`); holý vstup ne.
   - Eventy OSO čekají ve frontě za zápisem (komentář `:3846–3849`), takže očekávání existuje dřív, než první event dorazí.
   - `observe` přijme Market jen pro očekávaný vstup. Nohy páruje **přesnými id** (TP nemá `parentId`, ověřeno ve fixture `tests/fixtures/tradovate-leader-scale-in.json`), ne časovým oknem.
   - `LeaderOsoPair.entryOrderType` dostane `'Market'`, `correlation` dostane `'ack-ids'`.
   - Market zadaný v Tradovate zůstává `unrelated` (dnešní cesta). Jeho změna je F7-B.
3. **Odeslání kopií až po fillu leadera** (controller, větev `pair` `:17630–17700`):
   - Pro Market pár se nedispatchuje hned. Pár čeká v `pendingMarketPairs`, dokud nejsou filly vstupu = qty. Podle INV-TRAD-02 se plnost bere z fillů (`ownEntryFillPrices`, `:17103–17111`), ne ze stavu.
   - Pak `processor.processOso` se stejným `admissionGeneration`.
   - Lhůta `MARKET_FOLLOWER_COPY_MAX_DELAY_MS = 1 500` od `receivedAt` Market eventu.
   - Synchronně se kontroluje kotace workeru z IBKR stejně jako `manualEntryMarketQuoteBlockers` (`services/manualEntryPreview.ts:71`): SL i TP musí být ≥ 16 ticků na správné straně. Pokud C2 ukáže, že broker nohu přes trh při aktivaci odmítne, je tato kontrola povinná a bez čerstvé kotace = vynechat. IBKR smí jen blokovat.
   - Lhůta nebo kontrola selže → `skipFollowersForEpisode('late-market-copy')`: S2 pro každého flat followera bez příkazů a S3 tombstone. Follower, který flat není (přikoupení), znamená `failClosed(autoClose:false)`.
   - Dispatch ještě před fillem leadera se zamítá: leaderův Market může broker po ACK odmítnout a follower by zůstal v pozici sám.
4. **Runner** (`services/copierRunner.ts:1215`, `processOsoPair`):
   - Povolí `pair.entryOrderType === 'Market'` (request bez `limitPrice`/`stopPrice`).
   - Velikost z flat: `followerQuantity(q, m)` (`services/copierEngine.ts:733`).
   - Přikoupení: controller předá `quantityFor(follower) = q×m` (celočíselný m), takže Σ lístků followera = `trunc(L×m)` přesně jako očekává `verifyFollowerMagnitude` (`:7708`).
   - `exposureCappedBroker` zůstává poslední branou (`services/exposureCappedBroker.ts:19`, `placeOso :103`).
5. **Outbox Marketu** (`services/copierOsoOutbox.ts:83`):
   - `request.orderType === 'Market'` a autoritativní „nenalezeno“ → `waived` „Market kopie nevznikla — follower vynechá“ + S2. Nikdy `planned`, tedy žádný opakovaný POST.
   - Částečný nález → `abandoned` jako dnes.
6. **Odmítnutí brokerem:** `sidelinableEntryRejection` (`services/copierRuntimeController.ts:7885`) se rozšíří i na `osoOutbox` Market položky odmítnuté brokerem u flat followera. Výsledek je S2 `'entry-rejected'` (rozhodnutí 17. 9. pro standardní outbox) místo dnešního `failClosed` s auto-close. Interní policy blok (strop) dál fail-closed, viz F4.
7. **Nic nedostal žádný follower:** pojistka „vlastní vstup nesmí zůstat sám“ (`:17642–17656`) Market zrušit neumí, protože je vyplněný. Pokud skupina má followery a žádný nedostal kopii ani nevynechal legitimně (S2, 0 ks), následuje incident bez auto-close. Precedent je `reportRejectedManualLeg` (`:3477`).
8. **Přikoupení s followery:**
   - `scaleInEnabled` (`services/manualScaleIn.ts:19`) dostane sestru `scaleInFollowersEnabled` (běžná skupina, `demo`, opt-in `--followers-scale-in on`).
   - Nová čistá `followerScaleInBlockers` nad S4.
   - `scaleInGate` (`services/copierRuntimeController.ts:3589`) sbírá i followery.
   - Synchronní druhá pojistka před POSTem (`:3955–3962`) zahrne followery, bez REST.
   - `venueManagedProtectiveCoverage` (`services/copierEngine.ts:630`) se změní na součet nohou stejné role přes lístky followera. Jde o nález P2-11 ze scale-in v5 §10.3; dnes předpokládá jednu nohu = |net|.
   - Nadkrytí followera (Σ zbytků nohou > |net_f|, 5 s klid) = incident, obdoba `overCoverStep` (`services/manualScaleIn.ts:427`).
9. **Správa celé pozice** (`preparePositionAction`, `:4804`; `manageReachBlockers`, `:4166`):
   - S followery se vyžaduje dosah na každou nohu followera u každého lístku.
   - Posun leadera zrcadlí `planModify` (`services/copierEngine.ts:659`) po vazbách. Lístků je N a na každý lístek jde jeden modify na followera a roli.
   - Strop přikoupení drží počet zápisů nízko (INV-TRAD-04).
10. **Capability a instalace:**
    - `server/localCopierExecutionAgent.ts:410` inzeruje `manual-entry-market-followers-v1` a `manual-entry-scale-in-followers-v1`, ale jen s opt-in flagy instalace v `scripts/copier/mac-install.ts` (vzor `--scale-in`, `:465–468`).
    - Web: `supportsCopierManualEntryMarket` zůstává pro manual-only; nové `supports…Followers` v `lib/copierWorkerCapabilities.ts`.
11. **Relay a admission:** beze změny. `place-leader-entry` a `manage-leader-order` mají stejný tvar, `intent.followerQuantities` už existuje. **Migrace: ne.**

### (4) Dotčená INV-* a jak je návrh drží
- **INV-MANUAL-01:** vlastní OSO se kopíruje jen jako celé OSO. Pár vzniká podle id z ACK a odchází až po nohách a fillu. Holý Market s followery zůstává zakázaný. *Změna textu:* do odstavce „Nativní Market…“ doplnit, že capability `manual-entry-market-followers-v1` povoluje Market se SL+TP i ve skupině s followery: korelace podle id z ACK, kopie po plném fillu leadera nejvýš do 1,5 s, jinak followeři vynechají (pauza epizody), Market kopie se nikdy neposílá znovu.
- **INV-OUTBOX-01/02/03:** `sending` je durable před POSTem (runner `persistRuntime` před dispatchem). Market se po „nenalezeno“ nikdy neopakuje. Částečný nález = `abandoned`. Restart v `sending` = `unknown` (ARM-blocking). *Změna textu INV-OUTBOX-01:* „Market OSO followera po autoritativním nenalezení → `waived` + pauza epizody, nikdy nový POST.“
- **INV-DIVERGENCE-01:** vynechání je vždy pauza S2 nad autoritativně flat účtem, nikdy dorovnávací obchod. Celočíselný násobek u přikoupení drží `Σ lístků = trunc(L×m)`. *Změna textu:* rozšířit výčet úzkých výjimek o `late-market-copy`.
- **INV-RISK-01:** riziko followera počítá `checkAccount` s q×m a s rizikem stávající pozice po lístcích followera. Strop zůstává poslední branou a nikdy se neořezává.
- **INV-RISK-02:** okno, day lock a pauza beze změny. `blockDuringPause` a `blockOutsideTradingWindow` se volají i pro Market pár.
- **INV-FRESH-01:** `dispatchBroker(admissionGeneration)` znovu ověří generaci a ARM těsně před zápisem followera.
- **INV-ARM-01/04:** jen ARMED. Ve shadow se nic nedispatchuje (`evaluateRiskGate dispatch=false`).
- **INV-BRAKE-01/02:** DISARM nebo kill mezi párem a dispatchem → `CopierDispatchRevokedError` → `waived`. Leader drží pozici se svými nohami, bez auto-close.
- **INV-TRAD-02/03:** plnost se bere z fillů. Na `clOrdId` jako deduplikaci se nespoléhá.
- **INV-PART-02:** follower s cutem je ineligible a nedostane nic.
- **INV-UI-01/03/04:** panel jen zobrazuje. Kotace IBKR smí jen blokovat, TradingView nikdy.
- **INV-RELAY-01:** beze změny.
- **INV-WORKER-02:** dál otevřený, beze změny.

### (5) Chybové stavy a fail-closed
- **Restart během POSTu leadera:** `sending` → `unknown` → Market incident (`:3995–3999`, existuje). Followeři nic.
- **Restart s párem v paměti před dispatchem:** worker startuje DISARMED. Leader má pozici, followeři jsou flat a kontrola pozic ukáže rozdíl. Nic se automaticky nedorovnává (INV-RECON-01).
- **Restart během dispatchu followerů:** `sending` → `unknown` → lookup. Nalezeny 3 příkazy = OK. Nenalezeno = `waived` + S2. Částečně = `abandoned`, incident.
- **Částečný úspěch** (A přijato, B odmítnuto): B flat → S2 `entry-rejected`. B nejasný → `failClosed`.
- **Zastaralý stream** (nohy nedorazí): 5 s `MANUAL_ENTRY_LEG_WAIT_MS` (`:3444`) → incident bez auto-close. Followeři nic.
- **Fill před nohou TP:** pár se dokončí podle id. Pokud fill a nohy nesplní lhůtu 1,5 s, followeři vynechají.
- **DISARM/kill během čekání na fill:** pár se zahodí, followeři nic, leader beze změny.
- **Noha followera odmítnutá při aktivaci** (podle C2): incident bez auto-close, obdoba `reportRejectedManualLeg`.
- **Přikoupení:**
  - nekrytá noha followera = blocker,
  - nadkrytí followera = incident,
  - fill přikoupení v jiné epizodě = incident (existuje pro leadera).

### (6) DEMO záznam (DEMO8661118, MNQ)
- **C1:** `scripts/copier/record-leader-oso.ts --scenario market` (scénář už je v `recordLeaderOsoPlan.ts:25`) s 1 a 2 kontrakty. Potvrdí pořadí ACK → entry pending → SL(`parentId`) → TP(`ocoId`) → Working → Filled → Fill → nohy Working. Pořadí je zatím vidět jen v základu scale-in fixture.
- **C2 (nový scénář `market-tight`):** Market OSO se SL 2 ticky za trhem. Má ukázat, co broker udělá s nohou přes trh při aktivaci: odmítne / hned vyplní / nechá pracovat. Rozhoduje, zda je kontrola IBKR v kroku 3 povinná.
- **C3 (nový scénář `reduce-with-legs`):** Market OSO 2 a pak samostatný Market −1. Má ukázat, zda Tradovate zmenší qty nohou, nebo zůstanou na 2 (nadkrytí).
- **C7:** druhý DEMO účet jako follower (zakládá Filip; Claude účty nezakládá) a e2e běh workeru v DEMO skupině s followerem. Bez něj nejde první skutečný běh na prop účtech.

Skripty k brokerovi spouští Filip s `--confirm`.

### (7) Testy
- `tests/copierOsoCorrelatorMarket.test.ts`:
  - pár podle id z ACK v libovolném pořadí,
  - Market bez očekávání zůstane `unrelated`,
  - neshoda qty → `ambiguous`,
  - mutace: bez `expectOwnOso` test spadne, protože SL se stane „vstupem“.
- `tests/manualMarketFollowersReplay.test.ts` (fixture C1 / scale-in, ARMED, dva on-submit followeři m=1 a m=2):
  - každý follower dostane přesně jedno `placeOso` Market se shodnými cenami nohou a qty `floor(q×m)`, nikdy holý `placeOrder` (mutačně ověřit),
  - permutace pořadí fill/TP,
  - nohy nedorazí → žádný dispatch + incident,
  - DISARM mezi párem a dispatchem → nic,
  - lhůta 1,5 s překročena → S2 a následné Position eventy nevyhlásí divergenci (mutace: bez pauzy test padá).
- `tests/copierOsoOutbox.test.ts`: Market + nenalezeno → `waived`, nikdy `planned` (mutačně).
- `tests/manualScaleInFollowers.test.ts`:
  - m=1,5 → blocker,
  - Limit přikoupení → blocker,
  - nekrytá noha followera → blocker,
  - velikost q×m,
  - posun pozice zrcadlí 2 lístky × 2 role,
  - součtové `venueManagedProtectiveCoverage`.
- Náhled: `market-manual-only` padá jen s capability; `bare-with-followers`.
- UI: `tests/liveScaleIn.test.ts` a `tests/livePhoneOrders.test.ts` (pilulka ve skupině s followery vypnutá).

### (8) Dotčené soubory
- `services/copierOsoCorrelator.ts`
- `services/copierRuntimeController.ts` (`executeManualEntry`, větev `pair`, `flushStandaloneOsoEntry`, `scaleInGate`, `sidelinableEntryRejection`, `preparePositionAction`, `manageReachBlockers`)
- `services/copierRunner.ts`
- `services/copierOsoOutbox.ts`
- `services/copierEngine.ts`
- `services/manualEntryPreview.ts`
- `services/manualScaleIn.ts`
- `lib/copierWorkerCapabilities.ts`
- `server/localCopierExecutionAgent.ts`
- `scripts/copier/mac-install.ts`
- `scripts/copier/recordLeaderOsoPlan.ts` + `record-leader-oso.ts` (scénáře C2, C3)
- `components/LiveOrderTicket.tsx`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneChart.tsx`, `lib/livePhoneOrders.ts`
- `docs/COPIER_INVARIANTS.md`, `docs/CHART_ORDER_ENTRY_PLAN.md`

### (9) Velikost a závislosti
**L.** Závisí na C1, C2, C3 a C7. Přikoupení s followery navíc potřebuje zvednutý strop ručního vstupu běžné skupiny (dnes 1, `MANUAL_ENTRY_MAX_CONTRACTS`, `services/manualEntryPreview.ts:31`), což je samostatná položka z jiné skupiny. Bez ní je přikoupení s followery mrtvá funkce. Pomáhá F4(a).

---

## 4. F2 — On-fill followeři dostanou SL/TP nohy a jejich posuny

### (1) Verdikt: STAVĚT-PO-CONFORMANCE
Neblokuje to žádné pravidlo. Dnešní stav je přitom horší než bez kopírky:
- OSO s on-fill followerem dává `blocked oso-on-fill-not-supported` (`services/copierRunner.ts:1268–1274`),
- bracket dává `bracket-on-fill-not-supported` (`:993–1000`).
Obojí je kritický audit (`isCriticalAuditEntry`, `services/copierRuntimeController.ts:153`), takže `failClosed` s auto-close (`:8236–8241`) přijde při každém obchodu s ochranou. Náhled proto vstup blokuje (`services/manualEntryPreview.ts:426`).

### (2) Chování pro uživatele
- Režim „Při vyplnění“ přestane vypínat kopírku. Follower dostane Market OSO (vstup + SL + TP na aktuálních cenách nohou leadera), jakmile se leader vyplní. Při dílčím fillu dostane víc lístků. Posuny SL/TP, BE i zavření se zrcadlí stejně jako u on-submit.
- V panelu (PC i telefon) má on-submit follower `floor(q×m)` ks. On-fill follower má poznámku „dostane Market OSO až po vyplnění leadera — cena se může lišit“.
- Když kopie nejde (pozdě, noha přes trh): lepivá karta „Follower X obchod vynechal“.

### (3) Mechanismus
- **F2a — bracket po fillu** (`processBracketPair`, `services/copierRunner.ts:943`): on-fill follower s prokázanou pozicí (`bracketFollowerPositionProven`, `services/copierRuntimeController.ts:15832`) dostane OCO stejně jako on-submit. Ostatní jdou přes `guardBracketPairFollowers` (`:16116`), tedy čtením. On-fill nemá čekající kopii, S1b se ho netýká.
- **F2b — OSO pár:**
  - V `processOsoPair` se on-fill follower místo `blocked` zapíše do controllerového `onFillProtectionPlans` (vstup leadera → id SL/TP).
  - Při `filled` eventu toho vstupu (zpracování v `eventTail`) controller vyřadí follower z běžné on-fill Market kopie: `processor.process` dostane skupinu s `mode:'off'` pro tyto followery (vzor `:17580–17590`).
  - Místo toho pošle S1: Market OSO o velikosti delta `floor(cum×m) − previousTarget`. Stejná logika jako `planReplication` `services/copierEngine.ts:813–825`, včetně zápisu do `followerFillTargets`.
  - Ceny nohou se berou z `liveOrdersByAccount` leadera (stream už zpracovaný v pořadí), ne z TradingView ani UI.
  - Lhůta a kontrola kotace jsou stejné jako u F1 krok 3. Při selhání: flat follower → S2 `late-market-copy`; follower už v pozici (druhý dílčí fill) → `failClosed(autoClose:false)`.
- **F2c — lifecycle nohou:** `planModify` (`services/copierEngine.ts:668`) a `planCancel` (`:716`) dnes vyžadují `mode === 'on-submit'`. Nově rozhoduje vazba: nohy s `nativeOsoRole` `stop`/`target` se zrcadlí v obou režimech. Vazba vstupu on-fill (vyplněný Market) se dál neruší (komentář `:710–715` platí).
- **F2d — náhled** (`services/manualEntryPreview.ts:426`): on-fill = poznámka a kopie s `orderType: 'Market'`. `buildLeaderEntryPreviewCommand` (`lib/leaderEntryPreview.ts:221`) zahrne on-fill do `followerQuantities`.
- **Migrace: ne.** Relay beze změny (režim `on-fill` existuje, `set-replication`).

### (4) INV-*
- **INV-OUTBOX-01/03:** S1 durable, Market se neopakuje, částečné OSO = `abandoned`.
- **INV-DIVERGENCE-01:** vynechání jen přes pauzu nad flat účtem. Dílčí filly drží `trunc(cum×m)`.
- **INV-TRAD-02:** venue-managed qty nohou leadera se na followera nikdy nekopíruje (`nativeProtective` drží `link.quantity`, `:675–681`).
- **INV-RISK-01:** strop platí pro každý lístek přes `exposureCappedBroker`. Pro vynechání viz F4.
- **INV-FRESH-01, INV-ARM-04:** shadow nic nepošle.
- **INV-BRAKE-01/02:** DISARM mezi fillem a dispatchem → nic. Existující kopie dál chrání jejich nohy.
- **INV-MODE-01:** beze změny.
- *Změna textu INV-DIVERGENCE-01:* „On-fill follower s ochranou kopíruje nativní Market OSO po fillu; jeho nohy se zrcadlí podle vazby, ne podle režimu.“

### (5) Chybové stavy
- **Noha přes trh při aktivaci (C2):** buď okamžitý výstup followera (bezpečné), nebo odmítnutá noha = incident bez auto-close.
- **Dílčí výstup leadera mimo OSO (C3):** nohy followera mohou zůstat větší než pozice. Nadkrytí = incident a flat sweep po flat (incident 24. 8. existuje).
- **Restart mezi fillem leadera a OSO followera:** DISARMED a kontrola pozic, nic se nedorovnává.
- **Zastaralý stream:** fill nedorazí → žádná kopie. Leader-flat guard beze změny.
- **Kill:** existující nohy followera zůstanou. Nový dispatch nevznikne.

### (6) DEMO záznam
- C2 a C3 (sdílené s F1).
- Navíc `--scenario fill` s Limit qty 2 na DEMO8661118: dílčí fill a qty Suspended nohou. Scénář `fill` existuje, potřeba je varianta qty 2. Výsledek je nutný pro více lístků followera.

### (7) Testy
- `tests/copierOnFillProtection.test.ts`:
  - OSO leadera + on-fill follower → po fillu jedno `placeOso` Market s cenami nohou ze streamu, žádný holý Market (mutačně),
  - dílčí filly 1+2 → dva lístky followera,
  - posun SL leadera → modify obou nohou followera,
  - zrušení zbytku vstupu → nic,
  - pozdní fill → S2,
  - bracket po fillu → OCO pro prokázanou pozici.
- Regrese: on-submit beze změny (`tests/copierTradovateLifecycle.test.ts`).
- Náhled: on-fill = poznámka, ne blocker.

### (8) Soubory
`services/copierRunner.ts`, `services/copierEngine.ts`, `services/copierRuntimeController.ts`, `services/manualEntryPreview.ts`, `lib/leaderEntryPreview.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneChart.tsx`, `docs/COPIER_INVARIANTS.md`, nové testy.

### (9) Velikost
**L.** Závisí na F1 (S1, outbox Marketu) a C2, C3.

---

## 5. F3 — Kopie na jiný symbol (NQ→MNQ), inverzní kopie, pevné qty followera

### (1) Verdikt: JEN-ČÁST
- **Inverzní kopie: ZAMÍTNOUT.** Výslovné pravidlo prop firem v PropShield §0: Tradeify FTA §6.7(b) bezpodmínečně zakazuje opačné pozice mezi vlastními účty a Lucid zakazuje hedging i mezi vlastními účty a korelovanými produkty. Skupina má navíc `preventHedging: true` jako výchozí safety (`services/liveCopyTrading.ts:109`, `:201`).
- **Pevné qty: ZAMÍTNOUT.** Závazné invarianty PropShield §2.1 („Admitted quantity je autorita… bez durable admission ledgeru se REDUCED nesmí zapnout vůbec“) a §2.3 (referenční bod `trunc(leader × multiplier)` se nenahrazuje vlastním záměrem). Technicky by se rozpadlo i na lístcích: noha followera s qty N k lístku leadera s qty 1 při dílčím výstupu leadera vyrobí divergenci.
  Náhrada už existuje: násobek 0,01–100 (`services/liveCopyTrading.ts:13`). Kdo obchoduje 1 kontrakt, nastaví násobek = požadované qty.
- **NQ→MNQ: stavět později.** Až po C6 a výslovném rozhodnutí Filipa, protože záznam NQ na DEMO naráží na pravidlo „MNQ-only“. Samotná kopie z NQ leadera zadaného v Tradovate do MNQ followerů pravidlo neporušuje: ruční vstup z appky zůstává jen MNQ (`LEADER_ENTRY_SYMBOL_PATTERN`, `lib/leaderEntryPreview.ts:13`).

### (2) Chování
- **Nastavení followera:** volba „Kopírovat NQ jako MNQ“ (jen tento pár, stejný měsíc kontraktu). UI doporučí násobek 10 pro stejné riziko.
- **LIVE:** follower ukazuje pozici v MNQ vedle NQ leadera.
- **Inverzní kopie a pevné qty:** v UI nejsou. Nápověda u násobku vysvětluje náhradu pevného qty.

### (3) Mechanismus (jen NQ→MNQ)
- **Konfigurace:**
  - `CopyFollowerConfig.symbolMap?: 'NQ->MNQ'` (`services/liveCopyTrading.ts:8`),
  - sanitizer (`:650`), relay `validatedRelayGroup`,
  - tighten-only: přidání mapování je zmírnění (`lib/copierRiskConfig.ts:237`).
- **Jediný mapper:** `followerSymbolFor(follower, leaderSymbol)` v `services/copierEngine.ts` (NQZ6 → MNQZ6, jiný root = beze změny).
- **Povinná místa** (každé vynechání je bezpečnostní díra):
  - `planReplication` (`:769`), `processOsoPair` / `processBracketPair` (`request.symbol`),
  - `cutAwareDispatchFor` (pauzy podle účtu a symbolu), `verifyFollowerMagnitude` (`:7683`, symbol followera vs. leadera),
  - přechody pozic followera (`:16926–16941`, `:16983–16995`), `sweepFollowerProtectiveLegs`, `cancelPartialCopiedEntryRemainder`,
  - `awaitingCopiedEntry` (`:7666`), S1b (`s1bReadCandidates`), `bracketFollowerPositionProven` (`:15832`), suppression klíče,
  - `flattenFollowerForCurrentTrade` (`:9892`), `exceedsMaxContracts` v náhledu, status a LIVE UI.
- **Statický test:** zakáže přímé porovnání symbolu leadera se symbolem followera mimo mapper.
- **Rozdíl ceny NQ vs. MNQ** o tick: krátká okna, kdy noha leadera spustila a noha followera ještě ne. Řeší je existující `followerTransitionCorrelationWindowMs` (2 s, `:2446`) a leader-flat guard (risk-redukční zavření kopie, ne dorovnání).
- **Migrace: ne** (konfigurace skupiny je JSON). Ověřit, že cloudová knihovna nové pole uloží, nebo zahodí bezpečně, tedy bez mapování.

### (4) INV-*
INV-DIVERGENCE-01, INV-RISK-01 (strop na symbol followera), INV-ELIG-01, INV-PART-02/03, INV-TRAD-06 (route per účet), INV-UI-04, INV-RECON-03 (snapshot podle symbolu followera).
*Nový text:* „Follower se `symbolMap` se porovnává výhradně přes `followerSymbolFor`; jiný pár než NQ→MNQ ani inverze se nepřijme.“

### (5) Chybové stavy
- **Chybějící mapování v jedné cestě** (např. sweep na NQ místo MNQ) = osiřelá noha. Proto statický test a replay celého životního cyklu.
- **Rollover:** rozdílný front kontrakt NQ a MNQ = blocker (stejná expirace se ověří kalendářem i brokerem).
- **Restart:** DISARMED. Reconcile musí číst symbol followera.

### (6) DEMO záznam
**C6** (jen po rozhodnutí Filipa kvůli pravidlu MNQ-only): na DEMO8661118 současně NQ OSO 1 ks a MNQ OSO 1 ks se stejnými cenami. Zaznamenat tvar NQ eventů, kontrakty a časový rozdíl spuštění nohou.

### (7) Testy
- Mapper (jednotkový),
- statický „žádné přímé porovnání symbolu“,
- replay NQ leadera (fixture C6) s MNQ followerem: vstup, posun, zavření, flat sweep na MNQ (mutačně: sweep na symbolu leadera musí test shodit),
- tighten-only přidání mapování za ARMED = odmítnuto,
- odmítnutí inverze a pevného qty v sanitizeru.

### (8) Soubory
`services/liveCopyTrading.ts`, `lib/copierRiskConfig.ts`, `services/copierEngine.ts`, `services/copierRunner.ts`, `services/copierRuntimeController.ts` (desítky míst), `services/manualEntryPreview.ts`, `server/tradovateCopierCommandRelay.ts`, `components/LiveCopyTradeOverview.tsx`, `docs/COPIER_INVARIANTS.md`.

### (9) Velikost
**L** (podmnožina NQ→MNQ). Doporučeno až po F1 a F2, které sahají na stejná místa. Závisí na C6.

---

## 6. F4 — Follower s násobkem < 1 nesmí zablokovat celý vstup; strop kopii ořízne

### (1) Verdikt: JEN-ČÁST
- **(a) Násobek dávající 0 ks: STAVĚT.** Follower vynechá a vstup jde ostatním.
- **(b) Strop: STAVĚT jako „follower vynechá epizodu“** (S2), ne jako ořez. **Ořez ZAMÍTNOUT:** PropShield §2.2 („Cap zůstává poslední fail-closed brána. `exposureCappedBroker` se nenahrazuje clampem a nevstupuje do `min()`“), §2.1 (bez admission ledgeru žádné REDUCED) a „Vyvrácené návrhy“ (`safeQty = min(qty, maxContracts, …)`). Ořezaná kopie s nohami velikosti leadera, nebo pozdější výstup leadera, by followera otočila do protipozice.
- Vynechání místo blokace celého vstupu podporuje PropShield §2.7 („Žádné ‚všichni bezpeční, nebo žádný vstup‘“).

### (2) Chování
- Panel na PC i list na telefonu ukazují u followera:
  - „0 ks · vynechá (násobek 0,5)“,
  - „vynechá · strop 2 ks“.
- Odeslat zůstává aktivní, dokud aspoň jeden follower kopii dostane. Jinak platí `no-follower-would-copy`.
- Po odeslání: karta „Follower X vynechal (strop)“.
- U přikoupení (follower v pozici) zůstává strop blockerem.

### (3) Mechanismus
- **(a) Náhled** (`services/manualEntryPreview.ts:428`): `scaled-quantity-zero` přestane být blocker a stane se poznámkou `follower-skipped-zero`. Runner už takového followera přeskakuje jako `skipped` (`services/copierRunner.ts:1278–1284`, `planReplication` `zero-quantity`). Kontrola velikosti očekává `trunc(q×m) = 0`, takže je konzistentní. Přikoupení s m < 1 blokuje celočíselné pravidlo z F1. UI `accountRows` (`components/LiveOrderTicket.tsx:604`) ukáže „vynechá“.
- **(b) Strop v jádru:**
  - V `cutAwareDispatchFor` (`services/copierRuntimeController.ts:14891`) pro risk-zvyšující `submitted`, a u on-fill `filled`, nová `capSkipAccounts(event, quantityFor)`.
  - Spočítá z cache (`positionsByAccount`, `liveOrdersByAccount`) **stejný vzorec** jako `exposureCappedBroker` (`services/exposureCappedBroker.ts:28–56`).
  - Při překročení a `hasAuthoritativeFlatNoWorking` (`:12800`) bez rozpracované izolace se **před dispatchem ostatním** zapíše v CAS commitu pauza S2 `reasonCode: 'cap-exceeded'`. Účet je pak `account-sync-paused`, runner ho zapíše jako `skipped`.
  - Selže commit → nedispatchuje se nikomu, `failClosed(autoClose:false)`.
  - Follower není flat nebo cache chybí → beze změny: `exposureCappedBroker` odmítne a následuje dnešní fail-closed.
  - `exposureCappedBroker` zůstává nedotčený jako poslední brána.
  - `CopierAccountSyncPause.reasonCode` se rozšíří v `services/copierEngine.ts:175` a `services/copierRuntimeController.ts:326`.
- **Náhled** (`:431–433`): `max-contracts` u flat followera je poznámka „vynechá“. Blocker zůstává jen u přikoupení.
- **Migrace: ne.** Relay beze změny.

### (4) INV-*
- **INV-RISK-01:** strop se vynucuje dál a nikdy se neořezává ani nezaokrouhluje nahoru. *Text:* „Překročený strop flat followera = follower vynechá epizodu (durable pauza `cap-exceeded`), nikdy ořez; nejasný stav = beze změny fail-closed.“
- **INV-DIVERGENCE-01:** úzká výjimka přes pauzu nad autoritativně flat účtem. Doplnit `cap-exceeded` do výčtu.
- **INV-PART-02:** cut beze změny.
- **INV-WORKER-01:** CAS commit pauzy.
- **INV-RECON-01:** po restartu se pauza obnoví jen s flat důkazem (`:12955–12971`).
- **INV-OUTBOX-02:** pauza je durable dřív než dispatch.
- **INV-UI-01:** panel zobrazuje, worker rozhoduje.

### (5) Chybové stavy
- Souběh: follower mezitím otevřel pozici. Observation fence v `hasAuthoritativeFlatNoWorking` a nezpracovaný event followera znamenají, že se pauza nevytvoří a platí dnešní cesta.
- Restart po commitu pauzy, ale před dispatchem ostatním: DISARMED, pauza platí, kontrola pozic.
- DISARM nebo kill: pauza zůstane do flat (neškodí).
- Stav ze streamu (cache) se liší od REST: rozhoduje přísnější `exposureCappedBroker`.

### (6) DEMO záznam
Žádný. Nové chování brokera se nepoužívá.

### (7) Testy
- `tests/copierCapSkip.test.ts`:
  - OSO 3 ks, follower se stropem 2 a flat → pauza `cap-exceeded`, ostatní dostanou OSO, žádný kritický audit ani divergence po Position eventech (mutace: bez pauzy test spadne divergencí),
  - follower v pozici → beze změny fail-closed,
  - commit pauzy selže → nedispatchuje se nikomu,
  - restart obnoví pauzu jen s flat důkazem.
- Náhled: m = 0,5 a q = 1 → poznámka, ne blocker; strop u flat → poznámka; u přikoupení → blocker.

### (8) Soubory
`services/copierRuntimeController.ts`, `services/copierEngine.ts`, `services/manualEntryPreview.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneChart.tsx`, `docs/COPIER_INVARIANTS.md`, testy.

### (9) Velikost
**M** (a = S, b = M). Bez závislostí.

---

## 7. F5 — Ruční vstup bez flat u followerů s vlastní pozicí (vyřazení followera ze vstupu)

### (1) Verdikt: JEN-ČÁST
- **A (UI nad existujícím INV-PART-03): STAVĚT.**
- **B (vyřazení s vlastní expozicí i za ARMED, jako zpřísnění): STAVĚT** se změnou textu INV-PART-03 a oponenturou.
- **Automatické vrácení followera po obchodu: ZAMÍTNOUT.** INV-PART-01 vyžaduje flat/no-working důkaz a follower s vlastní pozicí ho nikdy nesplní. Zpřísnění za ARMED je jednosměrné.

Kontext: zúčastněný follower, který za ARMED otevře vlastní pozici, už dnes spustí incident. Pozice followera při flat leaderovi → `scheduleFollowerTransitionVerification` (`services/copierRuntimeController.ts:16917–16922`). Za ARMED proto F5 nastává prakticky jen u cizího čekajícího příkazu na followerovi. Případ s pozicí nastává za DISARMED, tedy před ARM.

### (2) Chování
- Náhled vrátí `account-not-flat` u followera X.
- Panel na PC i list na telefonu nabídnou „Vyřadit X z kopírování (vlastní pozice / příkaz zůstane)“.
  - Za DISARMED se pošle hned.
  - Za ARMED: s B taky; bez B s textem „vypni kopírku → vyřaď → zapni“ a odkazem na Live Dashboard.
- Vyřazení je lepivé. Vrácení jde až po flat stávající cestou („Zapnout“, INV-PART-01).

### (3) Mechanismus
- **A:** existující příkaz `set-follower-enabled { enabled:false, allowOwnExposure:true }`:
  - capability `follower-exclude-exposure-v1` (`lib/copierWorkerCapabilities.ts:10`),
  - relay validace `server/tradovateCopierCommandRelay.ts:409–415`, mezi riziko snižujícími `:676–679`.
  Náhled vyřazené vynechá (`excludedFollowers`, `services/manualEntryPreview.ts:423`). Jádro beze změny.
- **B:** v `setFollowerEnabled` (`services/copierRuntimeController.ts:20734` a `assertUnchanged` `:20784`) se zruší podmínka `gate.armed` pro `allowOwnExposure`. Zůstávají a zpřísní se tyto podmínky:
  - `!gate.killSwitch`, ne shadow, žádné `transportResume`,
  - leader flat bez příkazů (stream i dvě REST čtení, `flatRequiredIds`),
  - `participationLifecyclePendingFor`, žádný stuck ani nejasný outbox,
  - `copierOwnedExposureReasons(account, { atExclusion:true })` (`:5878`) prázdné v obou čteních,
  - observation fence a `participationGeneration`.
  ARMED zůstává. Status `excludedForeignFollowers` (`:5909`).
- **Migrace: ne.** Relay beze změny (tvar existuje).

### (4) INV-*
- **INV-PART-03:** *změna textu* „jen za DISARM“ → „za DISARM, nebo za ARMED při flat leaderovi bez příkazů a bez rozpracovaného lifecycle; vyřazení za ARMED je zpřísnění, vrácení jen podle INV-PART-01“.
- **INV-PART-01:** vrácení beze změny.
- **INV-FRESH-01:** fence.
- **INV-DIVERGENCE-01:** vyřazený se nepočítá.
- **INV-ARM-03:** změna účasti nezneplatní běžící ARM, jen připravený důkaz.
- **INV-UI-02:** DISARM a kill dál dosažitelné.
- **INV-RISK-01** (tighten-only): `enabled` není v `isWeakerRiskConfig`, vrácení hlídá INV-PART-01.

### (5) Chybové stavy
- Souběh s eventem leadera: `pendingTradeEventsFor` nebo změna observation → „Stav se během ověření změnil“ a nic se nezmění.
- Restart během čtení: nic necommitnuto.
- Follower má stopu kopírky: odmítnuto s textem „zavři kopii“.
- Kill: odmítnuto.

### (6) DEMO záznam
Žádný.

### (7) Testy
- `tests/copierFollowerExcludeWithExposure.test.ts` (rozšířit):
  - ARMED + flat leader + cizí příkaz followera → vyřazen a ARMED zůstává,
  - ARMED + leader v pozici → odmítnuto,
  - stopa kopírky → odmítnuto,
  - event během čtení → odmítnuto (mutace: bez fence test spadne).
- UI: akce v panelu volá přesný payload.

### (8) Soubory
`services/copierRuntimeController.ts` (B), `components/LiveOrderTicket.tsx`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneChart.tsx`, `docs/COPIER_INVARIANTS.md`.

### (9) Velikost
**S** (A), **S/M** (B). Bez závislostí.

---

## 8. F6 — Samostatná správa followera z grafu (jiný SL / × jen u něj)

### (1) Verdikt: JEN-ČÁST
- **„× jen u tohoto followera“: STAVĚT.** Je to jen UI. Jádro existuje: `flatten-follower-trade` → `flattenFollowerForCurrentTrade` (`services/copierRuntimeController.ts:9892`). Jen ARMED, nevypne kopírku, ruční cut `scope:'trade'`, ostatní účty pokračují (`:9978–9981`).
- **Jiný SL / BE jen u followera: ZAMÍTNOUT.** Další posun SL leadera by `planModify` (`services/copierEngine.ts:659`) followerovi automaticky přepsal, a utažený SL by tím oslabil. To zakazuje PropShield §2.4 („nikdy autonomně neoslabit ani nezrušit platný SL“). Ochranný plán followera je podle INV-DIVERGENCE-01 a INV-OUTBOX-03 kopie leaderova. Samostatná noha by potřebovala nový durable stav (odpojená vazba) a novou izolaci předčasně vyplněné nohy. To patří do budoucího návrhu se záznamem, ne do této vlny.

### (2) Chování
- PC: v panelu objednávky (řádky účtů) a v kompaktním seznamu účtů u position boxu. Telefon: v listu pozice.
- U followera s kopií je „× jen tento účet“, dvoukrokově (druhý klik ≥ 350 ms, do 4 s jako ostatní ×).
- Text: „Zavře kopii jen na tomto účtu; do konce obchodu ho kopírka vynechá, ostatní pokračují.“
- Výsledek jako karta. Za DISARMED se nenabízí (odkaz na Flatten účtu).

### (3) Mechanismus
- **UI:** stejný desk handler, jaký používá Live Dashboard (`components/LiveCopyTradeOverview.tsx:2062`, `requiresArmed :1737`). Příkaz nenese žádnou cenu.
- Podle `lib/copierSafetyControls.ts:8` smí riziko snižující příkaz projít i bez čerstvého statusu. Tlačítko se ale **zobrazí** jen při statusu, který ukazuje kopii followera v aktuálním obchodu.
- **Migrace: ne.** Relay beze změny (`server/tradovateCopierCommandRelay.ts:341`, `:397–407`).

### (4) INV-*
- **INV-PART-02:** přesné zavření vlastněné kopie, cut obchodu.
- **INV-BRAKE-01:** nevypíná kopírku.
- **INV-MODE-02:** výsledek `liquidateposition` stavem (background lane).
- **INV-RELAY-01/02:** existující cesta.
- **INV-UI-01/02:** cena nic neautorizuje, brzdy zůstávají dosažitelné.
- **INV-PART-03:** vypnutý follower akci odmítne (`:9913`).

### (5) Chybové stavy
- Odmítnutí workerem (DISARMED, kill, stuck operace) → text z workeru.
- Selhané potvrzené zavření → „nepodařilo se potvrzeně zavřít; ostatní účty pokračují“ (existuje).
- Dvojklik: idempotence přes `operationId` (`manualFollowerTradeOperations`).

### (6) DEMO záznam
Žádný.

### (7) Testy
- UI: tlačítko jen za ARMED a s kopií, dvoukrokové potvrzení, přesný payload.
- `tests/liveCopyGroupPowerInteraction.test.ts` (rozšířit): žádné × při DISARMED.
- Jádro má testy (`tests/copierFollowerCut.test.ts`).

### (8) Soubory
`components/LiveOrderTicket.tsx`, `components/TradovateLiveDesk.tsx`, `components/day/LivePhoneChart.tsx`, `lib/liveChartOrderLines.ts` (jen kompaktní seznam účtů, žádné čáry followerů).

### (9) Velikost
**S.** Bez závislostí.

---

## 9. F7 — Brána proti kopii bez ochrany

### (1) Verdikt: STAVĚT-PO-CONFORMANCE
- **A (čekající Limit/Stop/StopLimit z flat bez nohou): lze stavět hned.** Nové chování brokera se nepoužívá.
- **B (Market bez nohou z Tradovate „s pojistkou“): až po F1 (S1) a záznamu C4.**
- **C (SL bez TP): mimo rozsah.** Potřebuje záznam `placeoso` s jednou nohou (C5). Do té doby zůstává dnešní `oso-lone-leg` fail-closed (`services/copierRuntimeController.ts:12511–12525`).

Implementuje se tím závazná díra z PropShield §1.1 („Pending … žádná noha → zkopíruje se“ a „Market … obchází OSO okno úplně“).

### (2) Chování
- **Nastavení skupiny:** „Kopírovat jen vstupy s ochranou (SL+TP)“, výchozí **zapnuto** pro nové skupiny. U existujících skupin zapnutí = zpřísnění a jde i za ARMED. Vypnutí = zmírnění, jen DISARMED nebo nová session.
- **Leader zadá v Tradovate vstup bez SL/TP:** leader obchoduje sám, followeři obchod vynechají. Lepivá karta a push: „Vstup bez SL/TP — followeři ho vynechali.“ Kopírka zůstává ARMED. Pozdější SL/TP k tomuto vstupu se nekopírují.
- **Market s ATM bracketem (po B):** followeři dostanou Market OSO se stejnými nohami, jakmile nohy dorazí (typicky o stovky ms později). Když nedorazí do 1,5 s, followeři obchod vynechají.
- **Ruční vstupy z appky:** beze změny (vždy OSO, holý Market jen v manual-only).

### (3) Mechanismus
- **Konfigurace:**
  - `CopyGroupSafetySettings.copyRequiresProtection: boolean` (`services/liveCopyTrading.ts:105`),
  - sanitizer (`:774` vzor),
  - `isWeakerRiskConfig`: přidat do seznamu `:133` (true → false = zmírnění),
  - relay `validatedRelayGroup`.
- **A:**
  - Ve `flushStandaloneOsoEntry` (`services/copierRuntimeController.ts:12442`) za kontrolou lone-leg a před `processor.process` (`:12545`): politika zapnutá, `leaderEventIncreasesExposure(pending)`, `loneLegCount === 0`, typ Limit/Stop/StopLimit a vlastní vstup to není → `blockUnprotectedEntry(pending)`.
  - `blockUnprotectedEntry` je kopie vzoru `blockOutsideTradingWindow` (`:13233`): `rememberIntentionalEntrySuppression`, oddělení exit slice u reverzu (`allowReducingSlice`), `rememberBlockedLeaderEntryOrder`, audit `skipped` s důvodem `unprotected-entry` (ne `blocked`, ten je kritický, `:153`) a `pushCopyEvent` lepivá karta.
  - Přikoupení leadera bez nohou za otevřené pozice se chová stejně jako mimo obchodní okno dnes (S3), bez nové sémantiky.
- **B:**
  - Market `submitted` z Tradovate (ne vlastní) s politikou a rostoucí expozicí se místo dnešního okamžitého `processor.process` zařadí do `pendingProtectedMarkets` s lhůtou W = 1 500 ms (stejné okno jako `CopierBracketCorrelator`).
  - Zdroje páru:
    - nohy OSO s přesným `parentId` (korelátor S1 přijme Market rodiče pro děti s přesným `parentId`),
    - pár bracketu po fillu (`bracketCorrelator.observe`, `:17287`).
  - Po fillu leadera dispatch S1 (Market OSO) všem followerům. To nahrazuje dnešní okamžitý Market a pozdější OCO pro takto drženou kopii.
  - Lhůta vyprší → S3 tombstone. Pozdní nohy → existující `protective-pair-of-blocked-entry`.
- **Nikdy si nevymýšlíme SL** (PropShield §4): žádná výchozí ani dopočítaná noha.
- **Migrace: ne** (JSON safety).

### (4) INV-*
- **INV-DIVERGENCE-01:** vynechání přes suppression nebo tombstone, ne obchod.
- **INV-OUTBOX-03:** žádné dostavění nohou.
- **INV-RISK-02:** stejný vzor jako okno.
- **INV-DEFAULT-02:** neznámý ochranný plán = žádné nové riziko.
- **INV-ARM-01:** nová brána nesmí oslabit ARM.
- **INV-MODE-01:** beze změny.
- **INV-UI-03:** zobrazení.
- **INV-BRAKE-01:** DISARM během čekání = nic.
- *Návrh nového invariantu* **INV-PROTECT-01:** „S `copyRequiresProtection` vznikne nový follower vstup jen jako nativní OSO se známým SL i TP; vstup bez ochranného plánu followeři vynechají (tombstone + suppression), nic se nedopočítává ani nepřepisuje; vypnutí politiky je session tighten-only zmírnění.“

### (5) Chybové stavy
- **Restart během čekání B:** DISARMED. Leader v pozici, followeři flat → kontrola pozic, nic se nedorovnává.
- **Nohy dorazí těsně po lhůtě:** tombstone vyhrává. Nohy se nekopírují.
- **Reverz:** exit slice odejde hned, vstupní část se vynechá (vzor stale reversal).
- **Kill nebo DISARM:** držený Market se zahodí.
- **Zastaralý stream:** pár nevznikne, tombstone.

### (6) DEMO záznam
- **C4:** nový pasivní rekordér `scripts/copier/record-passive.ts` (jen čtení WS). Filip na DEMO8661118 v Tradovate UI zadá:
  - Market s ATM SL+TP,
  - Market s ATM jen SL,
  - Limit s ATM,
  - Market bez bracketu a SL ručně po 2 s.
  Zaznamenat zpoždění nohou po fillu a tvar (`parentId` / `ocoId` / `linkedId`).
- **C5 (pro C):** `--scenario oso-stop-only`.

### (7) Testy
- `tests/copierUnprotectedEntryGate.test.ts`:
  - Limit bez nohou → followeři nic, žádný kritický audit, Position eventy bez divergence (mutace: bez suppression spadne),
  - s nohami → OSO beze změny,
  - reverz → jen exit slice,
  - politika vypnutá → dnešní chování,
  - tighten-only vypnutí za ARMED → odmítnuto.
- Po B, replay C4: ATM Market → followeři Market OSO, lhůta → tombstone, pozdní nohy se nekopírují.

### (8) Soubory
`services/liveCopyTrading.ts`, `lib/copierRiskConfig.ts`, `services/copierRuntimeController.ts`, `services/copierOsoCorrelator.ts` (B), `server/tradovateCopierCommandRelay.ts`, `components/LiveCopyTradeOverview.tsx` (nastavení), `components/LiveTradeToasts.tsx`, `scripts/copier/record-passive.ts`, `docs/COPIER_INVARIANTS.md`.

### (9) Velikost
**M** (A ≈ S/M, B ≈ M). B závisí na F1 (S1) a C4.

---

## 10. DEMO conformance plán (DEMO8661118, MNQ; spouští Filip s `--confirm`)

| Krok | Skript | Co zjistit | Pro |
|---|---|---|---|
| C1 | `record-leader-oso.ts --scenario market` (1 a 2 ks) | pořadí ACK, eventů a fillu u Market OSO z flat | F1, F7-B |
| C2 | nový `--scenario market-tight` | noha přes trh při aktivaci: odmítnuta / hned vyplněna / pracuje | F1, F2 (povinnost kontroly IBKR) |
| C3 | nový `--scenario reduce-with-legs` | dílčí snížení mimo OSO: mění Tradovate qty nohou? | F1 (přikoupení), F2 |
| C4 | nový pasivní `record-passive.ts` + Filip v Tradovate UI | zpoždění a tvar ATM nohou po fillu | F7-B |
| C5 | nový `--scenario oso-stop-only` | `placeoso` s jednou nohou | F7-C (později) |
| C6 | NQ + MNQ OSO současně (jen po rozhodnutí Filipa) | tvar NQ, rozdíl spuštění nohou | F3 |
| C7 | druhý DEMO účet jako follower (zakládá Filip) | e2e worker se skutečným followerem | F1, F2 |

Pro každý krok: záznam mimo repo, anonymizovaná fixture v `tests/fixtures/`, replay test přes controller s mock brokerem. Na záznamu stojí jen to, co se opravdu zaznamenalo (INV-OUTBOX-03, nic se nedomýšlí).

## 11. Pořadí, nasazení, oponentura
1. F6 (S, UI) a F4 (M): bez záznamu, bez migrace.
2. F5-A (UI), pak F5-B se změnou INV-PART-03.
3. F7-A s návrhem INV-PROTECT-01.
4. C1–C3 a C7 → F1 (S1 + Market s followery), pak Market přikoupení s followery (až s položkou „strop běžné skupiny“).
5. C4 → F7-B.
6. F2.
7. C6 a rozhodnutí Filipa → F3 (NQ→MNQ).

Každá položka: návrh a hotový diff projdou `copier-design-critic` před commitem (CLAUDE.md §4). Testy → tsc → commit → push jen řetězené přes `&&`. Worker se reinstaluje jen v obchodní den na „nasaď“, z čistého reconciled stavu.

## 12. Souhrn navržených změn textu INV
- **INV-MANUAL-01:** Market se SL+TP ve skupině s followery (capability, korelace podle id z ACK, kopie po plném fillu do 1,5 s, jinak vynechání, Market se neopakuje). Holý Market a „Přidat SL/TP“ jen manual-only. Přikoupení s followery jen Marketem a s celočíselným násobkem.
- **INV-OUTBOX-01:** Market OSO followera po autoritativním nenalezení → `waived` + pauza, nikdy nový POST.
- **INV-DIVERGENCE-01:** výčet úzkých výjimek přes durable pauzu: `cap-exceeded`, `late-market-copy`, `unprotected-entry`. On-fill nohy se zrcadlí podle vazby.
- **INV-RISK-01:** strop = vynechání epizody flat followera, nikdy ořez.
- **INV-PART-03:** vyřazení s vlastní expozicí i za ARMED (zpřísnění, flat leader, fence); vrácení jen podle INV-PART-01.
- **Nový INV-PROTECT-01** (F7).


---

## Posudek copier-design-critic (návrh)

**Celkový verdikt: OPRAVIT PŘED COMMITEM**

- **P1** [F1 / F2 / F7-B: dispatch kopie až po fillu leadera] (INV-DIVERGENCE-01, INV-FRESH-01, INV-MANUAL-01, INV-BRAKE-01) Kopie followera (Market OSO) odchází až po fillu leadera. Revokace v dispatchBroker ale zná jen leaderovy příkazy ve stavu `rejected|canceled` (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRuntimeController.ts:1885, :1899-1906), vyplněnou nohu nezná. Scénář: t0 se vyplní Market leadera. V t0+250 ms se vyplní TP leadera (rychlý trh nebo těsné nohy podle C2), cancel SL od OCO ještě neprošel ingressem. Follower OSO mezitím projde exposureCappedBroker (2× REST, services/exposureCappedBroker.ts:32-35) a POST odejde v t0+400 ms. Follower tak vstoupí do obchodu, který leader už opustil. Leader-flat guard kopii pak zavře, takže vznikne nechtěný obchod se dvojím skluzem. Lhůta 1,5 s ani kontrola 16 ticků tohle nezachytí.
  - Oprava: Těsně před raw zápisem (v assertDispatchAllowed) zápis revokovat, pokud platí cokoli z tohoto: kterákoli noha páru je na ingressu `filled` nebo částečně vyplněná, pozice leadera ze streamu se liší od qty páru, nebo leader má nezpracovaný ingress. Jde o rozšíření terminalLeaderOrdersOnIngress o fill nohou páru. Výsledek je vynechání (S2 nad důkazem flat), nikdy pozdější dorovnání. Deterministický test: TP leadera vyplněn mezi fillem vstupu a POSTem followera.
- **P1** [F1 / F2 / F7-B: riziko followera u pozdního Marketu] (INV-RISK-01, INV-UI-04) Při dispatchi followera návrh kontroluje jen stranu nohou a vzdálenost 16 ticků. Riziko followera (checkAccount, services/manualEntryPreview.ts:364-400) stojí na referencePrice a rezervě skluzu. U leadera se drift kotace znovu ověřuje těsně před POSTem (`market-quote-drift`, services/copierRuntimeController.ts:3941-3944). U followera, který se vyplní až o ≤ 1,5 s později (plus REST stropu), ne. Pohyb o 15 ticků proti znamená, že ztráta followera při SL přesáhne spočítanou rezervu DLL.
  - Oprava: Při dispatchi každého followera spustit stejnou synchronní kontrolu: kotace IBKR ≤ 3 s, drift od referencePrice (nebo od VWAP fillu leadera) ≤ rezerva skluzu, jinak follower vynechá (S2). Bez čerstvé kotace také vynechat. Doplnit test.
- **P1** [S2 pauza: důkaz flat (F4b, F1/F2 late-market-copy)] (INV-DIVERGENCE-01, INV-FRESH-01, INV-DEFAULT-02, INV-RISK-01, PropShield §1.5 a §2.6) Návrh tvrdí, že hasAuthoritativeFlatNoWorking má observation fence. Nemá: /Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRuntimeController.ts:12800-12810 čte jen cache positionsByAccount a liveOrdersByAccount plus pendingIsolationCommandForAccount. Precedent sidelineRejectedFollower přitom dělá REST důkaz (authoritativelyConfirmSuppression, :7384). Pauza vyřadí účet z kontroly velikosti (:7694) i z dispatchů. Follower s čerstvou ruční pozicí nebo cizím příkazem, jehož event ještě čeká na ingressu, tak dostane pauzu místo dnešního fail-closed. Ztratí se signál, že strop odhaluje cizí aktivitu (PropShield §1.5), a jeho pozice zůstane do konce epizody nehlídaná.
  - Oprava: Na horké cestě (F4) jen vyloučení z konkrétního příkazu, s fence ingressu: pendingTradeIngressByAccount==0 a verze účtu zachycená před CAS commitem a ověřená po něm (vzor releaseAccountSyncPauses :12899-12933). Durable pauzu až mimo horkou cestu s REST důkazem (authoritativelyConfirmSuppression), čímž zůstane dodržen i PropShield §2.6. U F1/F2 jde vynechání mimo horkou cestu, proto vždy REST důkaz. Test: nezpracovaný event followera = žádná pauza, platí dnešní fail-closed.
- **P1** [F4b / F7-A: posun čekajícího vstupu leadera s vyloučeným followerem] (INV-DEFAULT-02, INV-DIVERGENCE-01) Pauza (F4b) i tombstone (F7-A) vznikají nad ČEKAJÍCÍM vstupem, kdy ještě není otevřená epocha. Když leader v Tradovate posune cenu limitu, přijde `replaced` a controllerUnmappedReplaceFollowers (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRuntimeController.ts:16217-16236) vidí followera bez linku. Suppression vyžaduje otevřenou epochu (:12971) a pauzy nejsou v currentIneligibleAccounts (:1553-1562). Výsledek je `unmapped-leader-replace` a failClosed s auto-close (:17817-17827; autoClose je ve failClosed výchozí, :6965). Slibované vynechání bez divergence se tak při běžném posunu limitu změní na DISARM a automatické zavírání.
  - Oprava: Výslovně určit, že follower vyloučený z konkrétního leader order id (F4b per-order, F7-A přes blockedLeaderEntryOrderIds) je pro replace i cancel tohoto id bezpečně bez linku; replace se jen zaznamená. Test pro F4b i F7-A: posun čekajícího limitu a jeho zrušení.
- **P1** [F4b: pauza založená už při submit čekajícího vstupu] (INV-DIVERGENCE-01, INV-UI-03) Pauza platí pro dvojici (účet, symbol) bez vazby na epochu (:12816-12820). Uvolní ji jen leader-flat guard epochy na symbolu (:10713-10816) nebo veřejná Kontrola pozic (:20382). Když leader limit zruší bez fillu, žádná epocha nevznikne a pauza přežije. Follower pak tiše vynechá celý PŘÍŠTÍ obchod, dokud neskončí ta další epocha, a uživatel si myslí, že kopíruje.
  - Oprava: Při submit jen vyloučení z daného order id (osoOpeningExcludedAccounts) plus suppression. Durable pauzu až při fillu, kdy je epocha otevřená, nebo ji uvolnit při terminálním zero-fill daného leaderEntryOrderId s důkazem flat. Test: vynechání kvůli stropu, leader limit zruší, další vstup se followerovi zkopíruje.
- **P1** [F2: klíč OSO outboxu u dílčích fillů] (INV-OUTBOX-01, INV-DIVERGENCE-01) processOsoPair používá klíč `oso:${group.id}:${pair.entryOrderId}:${follower}` (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRunner.ts:1286). Při druhém dílčím fillu téhož vstupu najde položku `acknowledged` a přeskočí ji jako already-acknowledged (:1340-1344). Druhý lístek se tak nepošle, follower drží trunc(1×m) místo trunc(2×m) a následuje divergence a incident. Změna klíče bez idempotence by naopak riskovala dvojí POST po restartu.
  - Oprava: Klíč odvodit z cílového kumulativního množství; followerFillTargets ukládat durable ve stejném commitu jako `sending`. Testy: dílčí filly 1+1 a restart mezi nimi.
- **P1** [F2: fill vstupu dřív, než se sestaví pár nohou] (INV-OUTBOX-03, PropShield §1.1) Leaderův OSO vstup z Tradovate se může vyplnit dřív, než korelátor sestaví pár (marketable limit, nohy dorazí o stovky ms později). Fill vyvolá flushStandaloneOsoEntry (:17460-17469) a obecnou cestu, kde planReplication pošle on-fill followerovi holý Market (services/copierEngine.ts:813-845). onFillProtectionPlans v tu chvíli ještě neexistuje. F2 slibuje, že on-fill follower dostane OSO, ale v tomto pořadí dostane nechráněnou pozici.
  - Oprava: Pro on-fill followery v režimu F2 platí: fill vstupu bez známého páru = vynechat (tombstone nebo pauza), nikdy holý Market. Pozdní nohy jdou přes protective-*-of-blocked-entry. Test permutace fill < SL < TP.
- **P1** [F1 / F2: odmítnutá noha nebo částečný OSO u followera s vyplněným Marketem] (INV-OUTBOX-03, INV-DEFAULT-02, PropShield §2.4) U Market OSO je vstup followera vyplněný okamžitě. Dva případy vedou k nahé pozici followera na prop účtu: noha odmítnutá při aktivaci (C2), nebo recovery lookup typu „vstup nalezen, nohy ne“, který skončí jako abandoned (services/copierOsoOutbox.ts:113-116). Návrh volí incident bez auto-close podle vzoru reportRejectedManualLeg, jenže ten se týká VLASTNÍHO obchodu leadera. Navíc resolveOsoLookup označí celou položku `rejected`, i když je odmítnutá jen noha a vstup je vyplněný (:97-100). Rozšíření sidelinableEntryRejection na osoOutbox (krok 6) proto nesmí z `rejected` odvozovat flat. NEOVĚŘENO: jak dnes controller reaguje na async reject nohy OSO followera (recordAccountRejection :1381 míří na standardní outbox).
  - Oprava: Potřeba rozhodnutí Filipa: buď cíleně zavřít přesně tu kopii followera bez SL ({účet, symbol}, lineage z outboxu) jako risk-redukční krok, nebo výslovně zdokumentovat incident i s rizikem nahé pozice. Sideline rozšířit jen pro rejectedBy:'broker' na celém POSTu a vždy s REST důkazem. Test: async reject nohy po fillu Marketu followera.
- **P1** [F7-A: výchozí zapnutí, Market a vstup jen se SL] (INV-RISK-01 (tighten-only), INV-UI-03, INV-ARM-01, PropShield §1.1) (a) Část A je „lze stavět hned“ a pro nové skupiny výchozí ON, ale tvar Limit+ATM z Tradovate (C4) neznáme. INV-DIVERGENCE-01 popisuje bracket strategii, kde nohy přicházejí až po fillu (16. 10.); followeři by takové obchody tiše vynechávali. (b) Nastavení slibuje kopírování jen vstupů s ochranou, ale Market z Tradovate se až do F7-B dál kopíruje okamžitě a holý. (c) Vstup s jedinou nohou (SL bez TP) dál končí failClosed DISARM (services/copierRuntimeController.ts:12515-12528), kdežto vstup bez nohou dostane jen vynechání. Bezpečnější vstup tak dostane přísnější reakci. (d) Sanitizer musí u uložených skupin bez pole zachovat `false`, jinak upgrade workeru změní chování skupiny za běhu.
  - Oprava: Výchozí OFF do C4 nebo do výslovného rozhodnutí Filipa. Se zapnutou politikou hned tombstonovat i risk-zvyšující Market z Tradovate (žádné nové chování brokera, jen vynechání) a také vstup jen se SL (followeři vynechají, žádný DISARM). Text nastavení psát přesně podle toho, co je hotové.
- **P2** [F1: pojistka „vlastní vstup nesmí zůstat sám“ při odloženém dispatchi] (INV-MANUAL-01) Kontrola po páru (:17642-17655) se zařadí do eventTail hned po větvi pair. U Market páru drženého v pendingMarketPairs ještě žádná kopie v osoOutbox neexistuje, takže se zavolá cancelOwnManualEntry na leaderův Market. Ten může být ještě `working`, takže zrušení závodí s fillem: vznikne částečný vstup leadera a followeři čekají na „filly = qty“ až do vypršení lhůty.
  - Oprava: Pro Market pár kontrolu přesunout až za vyřízení odloženého dispatchu, nebo ji pro Market vypnout a nahradit krokem 7. Test pořadí.
- **P2** [F1: lhůta 1,5 s a identita eventu pro odložené processOso] (INV-OUTBOX-01, INV-FRESH-01, INV-TRAD-01) Lhůta se měří od receivedAt Market submitu, ale eventTail mezitím stojí za executeManualEntry (POST a persist, :3846-3849), což povede k falešným vynecháním. processOsoPair navíc kontroluje sekvenci eventu (services/copierRunner.ts:1226-1233): pár vzniká na TP eventu, dispatch až na Fill eventu, a návrh neurčuje, s jakým eventem a sekvencí se processOso zavolá.
  - Oprava: Lhůtu měřit od Fill eventu leadera a hodnotu ověřit v C1/C7. Určit event pro processOso a pokrýt testem permutací (pár před fillem, fill před TP, Position mezi nimi).
- **P2** [F1: `brokerEnvironment === 'demo'` neomezuje na DEMO účet] (INV-MANUAL-01) Prop účty Lucid a Tradeify běží v Tradovate prostředí `demo` (poznámka u INV-RISK-02). Podmínka v náhledu tedy neomezuje Market s followery na DEMO8661118; skutečnou bránou je jen instalační opt-in.
  - Oprava: V návrhu to pojmenovat přesně. Pokud má první běh jet jen na DEMO účtu, bránu vázat na allowlist konkrétních account id z instalace; C7 musí proběhnout před prvním během na prop účtech.
- **P2** [F5-B: vyřazení posledního followera za ARMED] (INV-ARM-01, INV-PART-03, INV-FRESH-03) Vyřazení posledního zúčastněného followera za ARMED nechá skupinu ARMED bez followerů, což by samotný ARM nepustil. Ruční vstupy pak spadnou na no-follower-would-copy a vstupy z Tradovate se nekopírují. Nabídka v panelu objednávky a na telefonu smí vycházet jen z čerstvého neobnoveného statusu.
  - Oprava: Odmítnout (nebo DISARMovat), když by nezbyl žádný enabled, eligible a nevyřazený follower. UI nabídku zobrazit jen nad čerstvým statusem. Test.
- **P2** [F2c: zrcadlení zrušení nohou u on-fill followera] (INV-DEFAULT-02, PropShield §2.4) On-fill follower má horší cenu vstupu (Market po fillu). Když se vyplní TP leadera, OCO zruší jeho SL a nové planCancel zruší SL i followerovi, jehož TP na stejné ceně se kvůli frontě ještě nevyplnil. Follower tak zůstane bez SL. NEOVĚŘENO, jak tuhle situaci dnes kryje on-submit (flat sweep, leader-flat guard).
  - Oprava: Test: TP leadera vyplněn, TP followera ne. SL followera musí zůstat, dokud nezasáhne flat sweep nebo leader-flat guard; jinak zrcadlit jen posun nohou, ne jejich zrušení.
- **P2** [F3: časování ochrany u NQ→MNQ a změna symbolMap] (INV-DIVERGENCE-01, INV-PART-01) Tvrzení, že rozdíl NQ/MNQ pokryje followerTransitionCorrelationWindowMs a leader-flat guard, platí jen když se leader zavře první. Když SL followera (MNQ) spustí dřív než SL leadera (NQ), follower je flat za otevřeného leadera. verifyFollowerMagnitude to vyhodnotí jako divergenci a spustí failClosed (/Users/filipkrejca/alphatrade-worktrees/scale-in/services/copierRuntimeController.ts:7766-7797). Izolace „ochranná noha followera vyplněná dřív“ dnes existuje jen během modify. Odebrání symbolMap uprostřed obchodu by navíc osiřelo nohy MNQ; tighten-only na to nestačí.
  - Oprava: Před F3 navrhnout izolaci ochranné nohy vyplněné dřív i bez modify (s lineage a důkazem flat), nebo incident vědomě přijmout. symbolMap měnit jen ve flat stavu podle INV-PART-01.
- **P3** [S2 vs. S3: nekonzistence reasonCode] (INV-DIVERGENCE-01) `unprotected-entry` je uvedený mezi novými reasonCode durable pauzy S2, ale F7 ve skutečnosti používá S3 (suppression jen v paměti).
  - Oprava: Sjednotit popis s mechanismem.
- **P3** [INV-WORKER-02 a Market kopie] (INV-WORKER-02, INV-OUTBOX-01) Dva živé workery znamenají duplicitní Market OSO, tedy okamžitou dvojitou pozici. Čekající OSO šlo dřív ještě zrušit, Market už ne. Pravděpodobnost se nemění, dopad roste.
  - Oprava: Uvést jako vědomé riziko v INV-MANUAL-01 a na prop účty F1 pouštět jen po vyřešení N6 nebo s výslovným souhlasem.

### Verdikty po položkách

- F1 Market+SL/TP a Market přikoupení s followery: **OPRAVIT** — Směr je správný: korelace podle id z ACK, dispatch až po fillu, Market se nikdy neopakuje. Před implementací ale opravit: revokaci při fillu nohy leadera, kontrolu driftu a rizika followera při dispatchi, REST důkaz pro S2, rozhodnutí o nahé kopii po odmítnuté noze, přesun pojistky „vstup nesmí zůstat sám“, měření lhůty od fillu a identitu eventu pro processOso. Přikoupení s followery je navíc závislé na zvednutí stropu a na součtovém venueManagedProtectiveCoverage.
- F1 holý Market / Přidat SL/TP s followery: **ZAMÍTNUTÍ SPRÁVNÉ** — Odpovídá INV-MANUAL-01 (vlastní OSO se nikdy nekopíruje bez nohou) a PropShield §1.1.
- F1 čekající přikoupení Limit/Stop s followery: **ZAMÍTNUTÍ SPRÁVNÉ** — Odpovídá známému limitu z INV-DIVERGENCE-01: čekání u scale-inu varianta 1 nepokrývá.
- S1 krok 4: Market nenalezeno → waived: **OK** — Je to striktně bezpečnější než dnešní `planned` (copierOsoOutbox.ts:110-111). Částečný nález má ale dořešit nález o nahé kopii (P1).
- F2 on-fill followeři s nohami: **OPRAVIT** — Klíč outboxu u dílčích fillů (P1), fill dřív než pár znamená holý Market (P1), zrušení SL po OCO u on-fill (P2) a stejné nálezy jako F1 (revokace, drift, S2 důkaz).
- F3 NQ→MNQ: **OPRAVIT** — Tvrzení o krytí časování NQ/MNQ neplatí pro případ, kdy se zavře nejdřív follower. symbolMap měnit jen ve flat stavu. Odklad za C6 a rozhodnutí Filipa je správný.
- F3 inverzní kopie a pevné qty: **ZAMÍTNUTÍ SPRÁVNÉ** — PropShield §0 (Tradeify §6.7(b), Lucid hedging), preventHedging, §2.1 a §2.3; náhrada násobkem je v pořádku.
- F4a násobek dávající 0 ks: **OK S VÝHRADAMI** — Runner už vrací `skipped`, kontrola velikosti očekává 0. Výhrada: s m<1 a pozdějším přikoupením z Tradovate se Σfloor nerovná trunc a vznikne incident; to existuje už dnes, ale F4a takovou konfiguraci zpřístupní. Doplnit test posunu čekajícího vstupu u 0-ks followera (safelyUnmapped stojí na cache flat).
- F4b vynechání při překročení stropu: **OPRAVIT** — Důkaz flat jen z cache bez fence (P1), pauza založená při submit čekajícího vstupu přežije zrušený vstup (P1), posun čekajícího vstupu vede k unmapped-leader-replace a auto-close (P1).
- F4 ořez kopie: **ZAMÍTNUTÍ SPRÁVNÉ** — PropShield §2.1, §2.2 a vyvrácený safeQty=min().
- F5-A UI vyřazení (existující INV-PART-03): **OK S VÝHRADAMI** — Jen nad čerstvým neobnoveným statusem (INV-FRESH-03); za ARMED bez F5-B jen text s odkazem.
- F5-B vyřazení s vlastní expozicí za ARMED: **OK S VÝHRADAMI** — Fence ve setFollowerEnabled (:20778-20795, :20841-20862) drží. Doplnit odmítnutí, když by nezbyl žádný zúčastněný follower, a test eventu leadera během čtení.
- F5 automatické vrácení followera: **ZAMÍTNUTÍ SPRÁVNÉ** — INV-PART-01 vyžaduje důkaz flat a bez příkazů.
- F6 „× jen u tohoto účtu“: **OK S VÝHRADAMI** — Jádro existuje (flattenFollowerForCurrentTrade :9892-9991, ARMED, cut scope 'trade', idempotence přes operationId). Výhrada: zobrazení tlačítka podle statusu je jen prezentační; cesta přes Live Dashboard musí zůstat.
- F6 jiný SL / BE jen u followera: **ZAMÍTNUTÍ SPRÁVNÉ** — planModify by utažený SL přepsal (PropShield §2.4); potřebuje nový durable stav.
- F7-A brána pro čekající vstup bez nohou: **OPRAVIT** — Posun tombstonovaného čekajícího vstupu vede k failClosed s auto-close (P1). Výchozí ON před C4 a nastavení slibující ochranu i pro Market (P1). Vstup jen se SL končí přísněji než vstup bez nohou.
- F7-B Market z Tradovate s ATM: **OPRAVIT** — Dědí všechny nálezy z F1 (revokace, drift, S2 důkaz, nahá kopie). Navíc závisí na C4.
- F7-C SL bez TP: **OK S VÝHRADAMI** — Mimo rozsah je v pořádku, ale do té doby by se politikou ON mělo vynechávat místo DISARM (viz F7-A).
- Pořadí F6 → F4 → F5-A → F7-A → …: **OK S VÝHRADAMI** — F4b a F7-A jen po opravě nálezů P1. F7-A nedělat jako výchozí ON před C4.
- Testy (nespuštěny: zadání výslovně zakazuje spouštět testy): **CHYBÍ** — Doplnit deterministické testy: (1) fill TP nebo SL leadera mezi fillem vstupu a POSTem followera, kopie se revokuje; (2) drift kotace nad rezervu při dispatchi followera, follower vynechá; (3) S2 při nezpracovaném ingressu followera, žádná pauza; (4) F4b a F7-A s posunem i zrušením čekajícího vstupu, žádný unmapped failClosed; (5) vynechání kvůli stropu, cancel vstupu bez fillu, další obchod se kopíruje; (6) F2 dílčí filly 1+1, dva lístky, restart mezi nimi bez dvojího POSTu; (7) F2 fill dřív než pár, on-fill follower nedostane holý Market; (8) async reject nohy OSO followera po fillu Marketu; (9) restart s Market OSO ve `sending` a částečným lookupem; (10) pojistka „vstup nesmí zůstat sám“ u odloženého Market páru; (11) on-fill: TP leadera vyplněn, TP followera ne, SL followera zůstane; (12) F5-B s posledním followerem; (13) permutace pořadí ACK, Order, Fill a Position z fixture C1; (14) mutační testy uvedené v návrhu.
- K1 ARM bez syncu/flat: **netýká se** — Žádná nová cesta k ARM; F5-B jen zpřísňuje za běžícího ARM.
- K2 cache/default mění unknown→flat: **PORUŠENO** — hasAuthoritativeFlatNoWorking (:12800) se v F4b a S2 používá jako důkaz flat z cache bez fence; podmínka demo env vydávaná za DEMO bránu.
- K3 mazání lastError/incidentu: **drží** — Žádný nový reconcile; pauzy se uvolňují stávajícími cestami (:10809, :20382).
- K4 veřejné vs. interní reconcile: **netýká se** — Beze změny.
- K5 souběh během await: **PORUŠENO** — Fill nohy leadera před POSTem followera se nerevokuje (:1899-1906); posun čekajícího vstupu s vyloučeným followerem vede k failClosed s auto-close (:16217, :17827). DISARM a kill jdou přes dispatchBroker (drží).
- K6 fence těsně před zápisem a commitem: **riziko** — dispatchBroker drží (:1912-1919); CAS commit pauzy v F4b nemá fence před commitem ani po něm.
- K7 dvojí provedení po timeoutu/restartu: **drží s výhradou** — Market nenalezeno → waived (zlepšení). F2 kolize klíče (:1286) vede k podkrytí, ne ke zdvojení; změna klíče musí zachovat idempotenci.
- K8 outbox durable před zápisem: **drží** — persistRuntime (copierRunner.ts:1353) proběhne před placeOso (:1358).
- K9 OSO partial/Suspended/chybějící noha: **riziko** — Částečný nález nebo odmítnutá noha u vyplněného Marketu = nahá kopie; resolveOsoLookup značí `rejected` i při vyplněném vstupu (:97-100).
- K10 oprava divergence obchodem: **drží** — Jen vynechání nebo pauza, nikdy dorovnání. F3 nepravdivě tvrdí krytí časování (P2).
- K11 cíl zavírání: **drží** — F6 = existující přesný flatten-follower-trade.
- K12 nejasná likvidace: **netýká se** — INV-MODE-02 beze změny.
- K13 management-only: **drží (NEOVĚŘENO do diffu)** — Market pár musí projít blockDuringPause (:17521, :17682).
- K14 toggle/cut uprostřed lifecycle: **drží s výhradou** — F5-B: fence a participationLifecyclePendingFor OK, chybí kontrola posledního followera.
- K15 tighten-only/eligibility: **drží s výhradou** — copyRequiresProtection true→false a přidání symbolMap jsou správně zmírnění. Chybějící pole u uložených skupin musí zůstat false. Změna symbolMap musí vyžadovat flat.
- K16 day lock/cooldown po flat: **netýká se** — Beze změny.
- K17 DISARM/kill dostupné, starší ARM po brzdě: **drží** — F5/F6 jsou jen UI; nouzová cesta beze změny.
- K18 relay retry/idempotence: **drží** — Relay beze změny.
- K19 pořadí UI pollu/stale stav: **drží s výhradou** — Tlačítka F5/F6 jen nad čerstvým neobnoveným statusem (INV-FRESH-03).
- K20 restart uprostřed planned/sending/unknown: **riziko** — sending → unknown → lookup OK; částečný nález = nahý Market followera bez automatické akce; pendingMarketPairs se ztratí (DISARMED, OK).
- K21 dvě OAuth route: **NEOVĚŘENO** — Dispatch a strop jdou per route; nespojování firem se opírá o PropShield §0, ověřit v diffu.
- K22 dva živé workery: **otevřené (INV-WORKER-02)** — Duplicitní Market OSO = okamžitá dvojitá pozice; dopad roste.
- K23 p-time/Retry-After: **drží s výhradou** — Žádné nové synchronní volání (PropShield §2.6), pokud S2 REST důkaz zůstane mimo horkou cestu. Přikoupení s followery: N lístků × followeři × 2 modify.
- K24 víkend: **netýká se** — Beze změny.
- K25 testy chyby/restartu/stale/pořadí: **CHYBÍ** — Viz položku Testy výše.
- K26 oddělení tvrzení test/UI/worker/broker/conformance: **drží** — Návrh odděluje DEMO záznamy C1–C7 od testů a od nasazení.
