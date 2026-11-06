# Typy vstupních příkazů, TIF, brány Marketu a konce okna, bid/ask — návrh (3. 11. 2026)

Skupina „types“. Zdroj: seznam mezer `docs/reviews/trading-gaps-20261103.md`, kód nasazeného worktree
`/Users/filipkrejca/alphatrade-worktrees/scale-in` (HEAD 7ae5c97b = origin/main), invarianty
`docs/COPIER_INVARIANTS.md`, šablona `docs/reviews/scale-in-design-20261102.md`, plán `docs/CHART_ORDER_ENTRY_PLAN.md`.
Jen čtení: nic se nespouštělo, nic se neposílalo k brokerovi. **`copier-design-critic` nad tímto návrhem zatím
neběžel** (podagent ho nemůže spustit). CLAUDE.md bod 4 platí pro všechny položky, které mění jádro (R0, TIF-a/b,
C10-*, C14, C15): před stavbou oponentura návrhu, před commitem oponentura diffu.

## 0. Shrnutí

| Id | Položka | Verdikt | Velikost | Závisí na |
|---|---|---|---|---|
| R0-UNSUPPORTED | Nepodporovaný typ příkazu nesmí shodit stream (předpoklad) | STAVĚT (pokud ho nevlastní skupina „Riziko“) | M | — |
| REC-TYPES | Nahrávací skript typů vstupu, TIF a „noha přes trh“ (DEMO) | STAVĚT (skript spouští Filip) | M | R0 pro scénáře S4–S6 |
| C10-STOPLIMIT | StopLimit vstup z grafu | STAVĚT-PO-CONFORMANCE | M | REC (S1–S3) |
| C10-TRAIL | TrailingStop jako SL noha OSO | JEN-ČÁST: jen manual-only DEMO bez followerů; followeři ZAMÍTNOUT | L | R0, REC (S4) |
| C10-MIT | MIT vstup | JEN-ČÁST: jen manual-only DEMO (jako Market) | M | R0, REC (S5–S6), C14 |
| TIF | TIF Day/GTC/GTD + hlídání čekajícího vstupu z flat | JEN-ČÁST: (a) hlídání ve workeru STAVĚT; (b) broker Day/GTD po záznamu; (c) GTC ZAMÍTNOUT | L | REC (S7–S8) pro (b) |
| C14 | Market se SL/TP blíž než 16 ticků | STAVĚT-PO-CONFORMANCE (větev podle S9) | M | REC (S9) |
| C15 | Vstup v posledních 5 min okna / session / ARM | JEN-ČÁST: rezerva okna konfigurovatelná; session a ARM ZAMÍTNOUT | S | TIF-a (pro Limit/Stop) |
| BIDASK | Skutečný bid/ask z IBKR v panelu + join bid/ask | JEN-ČÁST: přes podepsaný kanál ceny ano; přes status workeru ZAMÍTNOUT | S | — |

Zjištění cestou (důležitá samostatně):
1. **Marketable Limit obchází 16tickovou bránu Marketu.** Limit přes trh (nebo Limit s těsným SL v rychlém trhu)
   má stejné riziko „SL nohy přes trh při aktivaci OSO“ jako Market, ale worker ho jen poznamená
   (`services/manualEntryPreview.ts:352` `limit-marketability`). Záznam S9 rozhodne i o tom.
2. **Výchozí TIF nohou OSO není známý** (`docs/reviews/scale-in-design-20261102.md` §2: „NEOVĚŘENO: výchozí TIF“,
   `TradovateOrderVersionEntity` v `services/tradovateBroker.ts:88-95` TIF nečte). Kdyby byl `Day`, pozice leadera
   v běžné skupině držená přes konec obchodního dne (`armExpiryFlatten: 'followers'`,
   `services/liveCopyTrading.ts:205` — leader se nezavírá) by ztratila SL/TP. Záznam S7 to rozhodne.
3. **Stop vstup nemá ve workeru kontrolu strany trhu.** Buy Stop pod trhem se spustí hned = skrytý Market bez bran
   Marketu. Kontrola je jen v UI telefonu. Návrh C10-STOPLIMIT přidává blocker `entry-trigger-side` pro Stop
   i StopLimit (zpřísnění, INV-ARM-01 „bezpečné je přidat přísnější bránu“).
4. **Bid/ask už v podepsané zprávě kanálu ceny je** (`lib/tvPriceMessage.ts:37-38`, plní ho vlákno IBKR
   `scripts/copier/tvPriceStreamThread.ts:178-181` z `services/ibkrPriceSource.ts:608-615`). UI ho zahazuje
   a ask skládá jako `last + 1 tick` (`components/LiveTradingScreen.tsx:226-230`, `components/day/LivePhoneChart.tsx:117-120`).

Migrace DB: **žádná položka ji nepotřebuje.** Atomická admission (`supabase/migrations/20261101090849_copier_manual_admission.sql:63-81`)
kontroluje jen `type`, `payloadHash`, `operationId` (u správy `entryOperationId` / `action`). Nová pole payloadu jdou
v `jsonb` beze změny a otisk je pokrývá automaticky (`lib/leaderEntryPlace.ts:46-57`). Relay validuje sdílenou funkcí
(`server/tradovateCopierCommandRelay.ts:379` → `validateLeaderEntryPlace` → `validateLeaderEntryPreview`), takže nový
web se starým workerem skončí `invalid-relay-command-payload` (fail-closed). UI posílá nový typ jen s capability workeru.

---

## 1. Společné předpoklady

### 1.1 R0-UNSUPPORTED — nepodporovaný typ nesmí shodit stream

Dnes `supportedOrderType` (`services/tradovateBroker.ts:266-269`) vyhodí `TradovateTransportError` pro cokoli mimo
Market/Limit/Stop/StopLimit. Volá ho `buildComposedOrder` (`:931-959`) a skrze `composeOrder` každá cesta streamu
i REST (`:1263, 1399, 1445, 1453, 1473, 1507, 2316…`). TrailingStop nebo MIT na **kterémkoli** účtu téhož OAuth
(i mimo skupinu) tak shodí sync. Pro C10-TRAIL a C10-MIT je to blokující předpoklad. Kdo jiný už R0 řeší, tahle
sekce se nestaví.

1. Verdikt: STAVĚT. Bez toho nejde ani nahrát S4–S6 přes adaptér.
2. Chování: žádná viditelná funkce. Cizí TrailingStop/MIT na účtu skupiny zablokuje vstupy a ARM na tom účtu
   („cizí příkaz“). Na účtu mimo skupinu se neprojeví vůbec.
3. Mechanismus:
   - `services/brokerPort.ts:23` `OrderType` rozšířit o `'TrailingStop' | 'TrailingStopLimit' | 'MIT' | 'Unsupported'`.
     `Unsupported` nese surový řetězec v novém poli `BrokerOrder.rawOrderType`.
   - `supportedOrderType` přestane házet, vrací typ nebo `Unsupported`. `TradovateOrderVersionEntity` (`:88-95`) navíc
     čte `pegDifference`, `timeInForce`, `expireTime` (jen do `BrokerOrder`, nic nerozhoduje).
   - Plánovač: `services/copierEngine.ts` (planReplication) pro leader event s typem mimo jádro (Market/Limit/Stop/StopLimit)
     vrátí `unsupported-order-type`. Za ARMED/SHADOW = incident (`failClosed`, bez auto-close), za DISARMED jen audit
     + `invalidateReconciliation` (precedent 22. 10., `divergenceBeforeLeaderExit`).
   - Účet skupiny s pracujícím příkazem takového typu = „cizí příkaz“: ARM ho blokuje přes no-working (INV-ARM-01),
     `protectiveHoldProblem` (`services/copierRuntimeController.ts:11369-11372`) ho nezařadí (`classOf` → null) → fail-closed.
   - Úložiště: outbox takový typ nikdy nedostane (plánovač odmítne). `services/supabaseCopierStore.ts:21` beze změny.
   - Výjimku pro **vlastní** TrailingStop/MIT z ručního vstupu (C10-TRAIL, C10-MIT) řeší až ty položky — podle id z ACK
     (`ownManualEntryOrderIds`, `ownManualLegOrderIds`, `:4036-4040`), nikdy podle typu.
4. INV: INV-DEFAULT-02 (neznámé = stop nového rizika, ne pád procesu); INV-TRAD-01 (baseline s takovým příkazem se
   nesmí replayovat jako obchod); INV-ARM-01 (cizí příkaz blokuje ARM); INV-DIVERGENCE-01 (nekopíruje se, nic se
   nedorovnává).
5. Selhání: neznámý řetězec typu = `Unsupported` (nikdy mapování na „nejbližší“ Stop — modify/kopie by ho rozbily).
   Fill z takového příkazu na leaderovi = změna pozice bez kopie → stávající kontrola velikosti (incident).
6. Conformance: S4 a S6 dodají skutečné WS rámce TrailingStop/MIT jako fixture pro R0.
7. Testy: replay rámce TrailingStop na účtu mimo skupinu → sync zůstane `ready` (mutace: vrátit `throw` → test padá);
   na leaderovi za ARMED → incident, nula broker zápisů; na followerovi → ARM blokovaný; REST `loadOrderGraphUncached` s Unsupported.
8. Soubory: `services/brokerPort.ts`, `services/tradovateBroker.ts`, `services/tradovateMapping.ts`, `services/copierEngine.ts`,
   `services/copierRuntimeController.ts`, `tests/tradovateUnsupportedOrderType.test.ts` (nový).
9. Velikost M.

### 1.2 REC-TYPES — nahrávací skript (DEMO8661118, MNQ)

Vzor `scripts/copier/record-leader-oso.ts` + čistý plán `scripts/copier/recordLeaderOsoPlan.ts` (pojistky `:30-40`,
scénáře `:25`): nový `scripts/copier/record-entry-types.ts` + `recordEntryTypesPlan.ts`. Pevně `environment: 'demo'`,
jen `MNQ[HMUZ]\d`, účet DEMO8661118, odmítne běh za ARMED nebo s čekajícím auto-resume, před i po: flat bez příkazů
(ověřeno REST), úklid `liquidateposition` + ověření stavem, anonymizace. Záznam mimo repo do `recordings/`, anonymizované
fixture do `tests/fixtures/tradovate-entry-types-*.json`. **Spouští Filip.** Skript zapisuje surové WS rámce dřív, než
je skládá adaptér, takže S4–S6 nahraje i bez R0 (skládání ale potřebuje R0).

| Sc. | Co | Co zaznamenat |
|---|---|---|
| S1 `stoplimit-cancel` | Buy StopLimit OSO, stop = ask + 1,5 %, limit = stop + 2 t, SL/TP platné; podržet 4 s; zrušit | přijetí, verze (orderType, price, stopPrice), nohy Suspended, kaskáda zrušení |
| S2 `stoplimit-fill` | Buy StopLimit, stop = ask, limit = ask + 8 t (spustí se dalším obchodem); po fillu liquidate | přechod při spuštění (nová verze? změna typu?), fill, nohy → Working |
| S3 `stoplimit-through` | Buy StopLimit se stop = ask − 8 t (už přes trh), limit = ask − 6 t (nevyplnitelné); zrušit | odmítnutí vs. „spuštěný ležící limit“ — rozhodne o bloceru `entry-trigger-side` |
| S4 `trailing-leg` | marketable Buy Limit (ask + 2 t) OSO, SL = TrailingStop (pegDifference podle dokumentace, stopPrice = fill − 40 t), TP + 1,5 %; držet 15 s; liquidate | přijetí nohy, znaménko a význam `pegDifference`/`stopPrice`, zda posun trailu chodí jako `orderVersion` / Order / vůbec, OCO, kaskáda liquidate |
| S5 `mit-cancel` | Buy MIT price = bid − 1,5 %; zrušit | přijetí, typ v rámcích, nohy Suspended |
| S6 `mit-touch` | Buy MIT price = ask + 4 t (už „dotčený“), SL/TP; liquidate | okamžité spuštění vs. odmítnutí; fill; nohy |
| S7 `tif-readback` | tři Limit OSO daleko: (a) bez TIF, (b) `Day`, (c) `GTC`; zrušit | kde a jak Tradovate TIF vrací (order/orderVersion/executionReport), **TIF nohou** |
| S8 `tif-gtd-expire` | Limit OSO daleko, `GTD` expireTime = teď + 90 s; čekat (výjimka max. držení 120 s jen pro S8) | řetězec `ordStatus` při vypršení, kaskáda nohou, executionReport, flat bez příkazů |
| S9 `leg-through-market` | Buy Limit = ask + 8 t (vyplní se ~ask), SL Stop = ask + 2 t (nad fillem, pod cenou limitu), TP + 1,5 %; ihned liquidate | co broker udělá se SL nohou přes trh při aktivaci: Rejected (důvod) / okamžité spuštění / Working |

Odhad nákladů: jednotky USD + poplatky na DEMO. Testy plánu: `tests/recordEntryTypesPlan.test.ts` (pojistky, vzdálenosti,
odmítnutí za ARMED, anonymizace). Velikost M.

---

## 2. C10-STOPLIMIT — StopLimit vstup z grafu

**(1) Verdikt: STAVĚT-PO-CONFORMANCE** (S1–S3). Broker vrstva ho umí (`services/tradovateMapping.ts:68-84` mapuje
`limitPrice→price`, `stopPrice→stopPrice`), kopírka ho kopíruje (`services/copierOsoCorrelator.ts:49-50` typ vstupu,
`services/copierRunner.ts:1291-1292` follower OSO nese obě ceny). Na DEMO ale není nahraný žádný StopLimit OSO.
Rozsah v1: manual-only DEMO. Běžné skupiny až po replay testu s on-submit followery a rozhodnutí Filipa (otázka Q2).

**(2) Chování**
- PC panel: typ `Limit | Stop | Stop-Limit | Market` (Stop-Limit jen s capability `manual-entry-stoplimit-v1`).
  Pole „Spouštěcí cena“ (čára vstupu v grafu, táhnutelná jako dnes) a „Limit +N ticků“ (0–20, výchozí 2). Panel ukáže
  limitní cenu. Riziko a velikost podle rizika se počítají z **limitní** ceny (nejhorší fill). Pravý klik do grafu nad
  trhem nabídne i „Buy Stop-Limit @ cena“. Čára čekajícího vstupu „STP-LMT 21 004,00 · L 21 004,50 · čeká“ s ×
  (dvoukrokově, beze změny). Potřebuje IBKR (jako Stop).
- Telefon: v listu (`components/day/LivePhoneOrderSheet.tsx:143`) čtvrtý čip „Stop-Limit“ s krokovačem offsetu.
  Plusko u kříže ho nabídne, když je cena na stop straně.

**(3) Mechanismus**
- `lib/leaderEntryPreview.ts`: `LeaderEntryOrderType` (`:66`) + `'StopLimit'`. `COMMAND_KEYS` (`:109`) + `limitPrice`.
  Validace (`:128-139`):
  - StopLimit: `price` = spouštěcí stop, `limitPrice` povinná, na tick. Buy `limitPrice ≥ price`, Sell `≤`,
    `|limitPrice − price| ≤ 20` ticků (`LEADER_ENTRY_STOP_LIMIT_MAX_OFFSET_TICKS`).
  - U ostatních typů je `limitPrice` zakázaná.
  - `position` + StopLimit = neplatné (přikoupení v1 ne).
  - `leaderEntryRiskPrice` (`:204-206`) pro StopLimit vrací `limitPrice`.
  - `LiveEntryPreviewDraft` (`:184-198`) + `limitPrice`.
- `services/manualEntryPreview.ts`:
  - Původ kontraktu (`:338-350`): StopLimit jako Stop, jen IBKR (žádný broker front).
  - Nový blocker `entry-trigger-side` pro Stop i StopLimit: Buy spoušť > čerstvý ask workeru (≤ 3 s, jinak last ≤ 3 s,
    stejně jako `workerMarketPrice` `:61-67`), Sell spoušť < bid. Jinak „spoušť je už přes trh — spustila by se hned“.
  - SL/TP strana (`:324-325`): Buy SL < min(price, limitPrice), TP > max (Sell zrcadlově).
  - Brány followerů (`:436-440`): StopLimit request s `limitPrice` i `stopPrice`.
- `services/manualScaleIn.ts:scaleInAddBlockers` (`:239-300`): blocker `scale-in-type` pro StopLimit (v1).
- `services/copierEngine.ts:340-363` `CopierManualEntryRecord.request.orderType` + `'StopLimit'`, pole `limitPrice?`.
- `services/copierRuntimeController.ts`:
  - `executeManualEntry` sestavení `request` (`:3901-3908`) nese `limitPrice`.
  - `osoRequest` (`:3958-3964`): `StopLimit → { stopPrice: price, limitPrice }`. Audit (`:3966`) „STP-LMT“.
  - `rememberLiveOrder` po ACK (`:4065-4074`) nese obě ceny.
  - Nová **synchronní** pozdní kontrola `entry-trigger-side` pro Stop/StopLimit těsně před POSTem: stejné místo
    a tvar jako pozdní kontrola Marketu (`:3932-3946`), z paměti `options.manualEntryQuote`, bez IO.
- Capability `manual-entry-stoplimit-v1`: `lib/copierWorkerCapabilities.ts`, inzerce v
  `server/localCopierExecutionAgent.ts:405-415` (v1 jen `group.manualOnly && localOnly && followers.length === 0`).
- UI:
  - `lib/liveOrderTicket.ts:17` `TicketOrderType` + `'stoplimit'`, `TicketDraft.limitOffsetTicks`. `ticketEntry` pro
    stoplimit = limitní cena. `stopIsTriggered` (`:130-132`) i pro stoplimit.
  - `components/LiveOrderTicket.tsx`: `previewDraft` (`:427-440`), `brokerOrderTypeLabel` (`:167`).
  - `lib/liveChartOrderLines.ts`: štítek čekajícího vstupu.
  - `lib/livePhoneOrders.ts:110-122`, `LivePhoneOrderSheet.tsx`.
- Relay: beze změny (sdílená validace). Migrace: ne.
- Pokud S2 ukáže, že broker při spuštění mění verzi příkazu (nový `orderVersion`, změna `orderType` na Limit), musí
  `services/copierLeaderEventSource.ts` (`executionShapeChanged`, `:133`) takovou verzi vlastního vstupu označit jako
  venue-managed (INV-TRAD-02), aby ji `copierOsoCorrelator` (`:73-95`) ani plánování nebralo jako uživatelský replace.
  V tom případě běžné skupiny ZAMÍTNOUT, dokud to není ošetřené.

**(4) Dotčené INV**
- INV-MANUAL-01: nový typ jde stejnou cestou (relay → admission → fronta → všechny brány → durable `sending` → jeden
  POST). Návrh textu: „StopLimit vstup: `price` = spoušť, `limitPrice` ≤ 20 t, jen s IBKR; spoušť na správné straně
  kotace workeru i těsně před POSTem; riziko z limitní ceny.“
- INV-UI-04: spoušť i limit jsou výslovná volba uživatele. Cena grafu je jen zobrazení. Stranu trhu rozhoduje kotace
  workeru z IBKR.
- INV-OUTBOX-01/03: atomické OSO, partial ACK = `abandoned` + cílené zrušení (beze změny).
- INV-TRAD-02: spuštěný, ale nevyplněný StopLimit je pending riziko. Cancel Completed s `cumQty < qty` = partial.
- INV-RISK-01: nejhorší fill = limit.
- INV-DIVERGENCE-01: u followerů může jejich StopLimit zůstat nevyplněný (mezera přes limit). Jde stávající cestou
  „čeká na kopii“ / S1b, nikdy dorovnání obchodem.
- INV-RELAY-01: otisk pokrývá `limitPrice`.
- INV-UI-01/02: zobrazení nic neautorizuje.

**(5) Selhání a fail-closed**
- Restart během `sending` → `unknown` (beze změny, INV-OUTBOX-02).
- ACK bez nohou → `abandoned` + incident + cílené zrušení.
- Brzda během POSTu → ACK za DISARMED = zrušit vlastní vstup (`:4089-4093`).
- Stará kotace IBKR → `entry-trigger-side` i původ kontraktu blokují (nic se neodešle).
- Mezera přes limit (spuštěný ležící limit) = běžný čekající vstup: × zruší, TIF-a ho zruší na konci okna.
- Částečný fill qty > 1: chování nohou neověřené (stejně jako u Limitu) — qty jen do stropu skupiny jako Limit.
  Doporučení: v1 StopLimit qty 1, dokud se partial nezaznamená.

**(6) DEMO conformance:** S1, S2, S3 na DEMO8661118 MNQZ6, fixture `tradovate-entry-types-stoplimit.json`.

**(7) Testy**
- `tests/leaderEntryPreview.test.ts`: validace StopLimit, offset, zákaz `limitPrice` u jiných typů, otisk se mění s
  `limitPrice`. Mutace: vypustit `limitPrice` z `COMMAND_KEYS` → test padá.
- `tests/manualEntryPreview.test.ts`: jen IBKR, `entry-trigger-side` pro Stop i StopLimit, riziko z limitu (mutace:
  riziko ze spouště → test padá), SL/TP proti oběma cenám.
- `tests/manualEntryStopLimitReplay.test.ts` (nový): replay S1–S3 přes controller.
  - Přijetí, spuštění, fill bez incidentu; nohy podle id z ACK.
  - Pozdní `entry-trigger-side` → `not-sent`.
  - Mutace: `osoRequest` bez `stopPrice` → mock odmítne.
- `tests/tradovateMapping.test.ts`: OSO payload StopLimit nese `price` i `stopPrice`.
- `tests/liveOrderTicket.test.ts`, `tests/livePhoneOrders.test.ts`: návrh a draft.

**(8) Soubory:** `lib/leaderEntryPreview.ts`, `services/manualEntryPreview.ts`, `services/manualScaleIn.ts`,
`services/copierEngine.ts`, `services/copierRuntimeController.ts`, `lib/copierWorkerCapabilities.ts`,
`server/localCopierExecutionAgent.ts`, `lib/liveOrderTicket.ts`, `components/LiveOrderTicket.tsx`,
`components/LiveTradingScreen.tsx`, `lib/liveChartOrderLines.ts`, `lib/livePhoneOrders.ts`,
`components/day/LivePhoneOrderSheet.tsx`, testy výše.

**(9) Velikost M.** Závisí na REC (S1–S3). TIF-a doporučeno (zrušení spuštěného ležícího limitu na konci okna).

---

## 3. C10-TRAIL — TrailingStop jako SL noha OSO

**(1) Verdikt: JEN-ČÁST.**
- Ano: jen manual-only local-only DEMO skupina bez followerů. Vstup Limit/Stop/Market z flat (ne přikoupení, ne
  `attach-brackets`). Až po R0 a záznamu S4.
- Followeři: **ZAMÍTNOUT** pro tento návrh.
  - INV-TRAD-02: posun trailu dělá broker sám; replikace jako modify by byla kopírování venue-managed změny
    (historický incident 27. 8.) a při každém ticku by tlačila modify přes rate limit (INV-TRAD-04).
  - INV-DIVERGENCE-01: každý účet trailuje od vlastního fillu, výstupy se rozejdou a rozdíl nejde opravit obchodem.
- Alternativa pro skupiny s followery: „auto-trail ve workeru“ (posun obyčejného Stopu přes existující
  `move-stop` / kaskádu) patří skupině „Správa pozice“ (auto-BE / auto-trail).
- Podporuje Tradovate trailing v bracketu? Podle veřejné dokumentace API mají nohy `placeoso` pole `orderType`
  (včetně `TrailingStop`) a `pegDifference`. NEOVĚŘENO — proto S4.

**(2) Chování**
- PC i telefon: v řádku SL přepínač „Trailing“ (vzdálenost = |vstup − SL| v ticích, jen pro zobrazení). Čára SL má
  štítek „TRAIL 12 t“.
- Čára SL není táhnutelná a BE je skryté s vysvětlením „Trailing SL se posouvá u brokera sám“. × zavřít pozici
  i zrušení čekajícího vstupu fungují.
- Posun trailu (pokud ho stream hlásí) se kreslí jen jako zobrazení. Když ho nehlásí, čára ukazuje „trailing — poloha
  u brokera“ bez vymyšlené ceny (INV-UI-01).

**(3) Mechanismus**
- Port: `services/brokerPort.ts:261-266` `BrokerOcoLeg.orderType` + `'TrailingStop'`, pole `pegDifference?: number`
  (typ přidává R0).
- Mapování: `services/tradovateMapping.ts:159-164` `ocoLegPayload` posílá `pegDifference`. `fromOrderEntity`
  (`:319-343`) ho čte do `BrokerOrder.trailOffset` (jen zobrazení a audit).
- Payload: nový klíč `stopLossTrailTicks` (celé číslo 4–400) v `lib/leaderEntryPreview.ts`. Jen se SL i TP, zakázaný
  s `position`. `stopLoss` zůstává jako počáteční stop (kotva rizika).
- Náhled: `services/manualEntryPreview.ts` blocker `trailing-manual-only` (stejná podmínka jako `market-manual-only`
  `:313-315`). Riziko = max(|vstup − stopLoss|, trailTicks × tick) + skluz. Přesný význam aktivace (od fillu, nebo od
  `stopPrice`) podle S4, riziko bere horší variantu.
- Controller: `executeManualEntry` `osoRequest.first` (`:3962`) = `{ orderType: 'TrailingStop', stopPrice, pegDifference }`
  podle S4. `rememberLiveOrder` typ `TrailingStop`.
- Vlastní trailing nohu poznat **jen podle id z ACK** (`ownManualLegOrderIds`, `:4039`):
  - `leaderPositionModel` (`services/manualScaleIn.ts:128`) a `protectiveHoldProblem.classOf` (`:11369-11372`)
    zařadí vlastní TrailingStop jako třídu `stop`.
  - Cizí TrailingStop zůstává neznámý (R0, fail-closed).
- `services/copierOsoCorrelator.ts:133`: jiný než Limit = `stop` už pokrývá TrailingStop dítě. Replace s jinou
  `stopPrice` u vlastní trailing nohy bez našeho modify commandu = `venueManaged` v `copierLeaderEventSource`
  (nová značka). Nevyvolá `manualOrderActions` dořešení ani incident.
- Správa:
  - `move-stop` / BE už blokuje `stop-type` (`:4917`, `:5191-5193`).
  - `positionManageBlockers` / `scaleInAddBlockers` dostanou `trailing-sl` (přikoupení ani posun pozice ne).
  - v1 jen `close-position` a `cancel-entry`. `move-target` později po S4.
- Capability `manual-entry-trailing-v1` jen pro manual-only. Relay beze změny, migrace ne.

**(4) Dotčené INV**
- INV-TRAD-02, návrh textu: „Posun `stopPrice` vlastní TrailingStop nohy brokerem je venue-managed: nikdy uživatelský
  posun, nikdy replikace ani důvod k incidentu; trailing jen v manual-only bez followerů.“
- INV-OUTBOX-03: OSO s trailing nohou atomicky, partial = `abandoned`.
- INV-MANUAL-01: doplnit odstavec o trailing SL.
- INV-RISK-01: riziko z počátečního stopu, trailing ho jen snižuje.
- INV-DEFAULT-02 (přes R0).
- INV-DIVERGENCE-01 (followeři zamítnuti).
- INV-UI-01: žádná vymyšlená poloha trailu.
- INV-MODE-01: management-only nesmí trailing zakládat.

**(5) Selhání**
- Broker odmítne trailing nohu při zadání → celé OSO `rejected`. ACK bez nohy → `abandoned` + zrušení.
- Odmítne ji při aktivaci → `reportRejectedManualLeg` (`:3475`) = incident bez auto-close (beze změny).
- Stream posun trailu nehlásí → model drží počáteční stop (riziko přeceněné = bezpečný směr). Nadkrytí počítá nohu
  podle id.
- Restart: nohy z REST (vyžaduje R0).
- DISARM/kill: ochranná noha zůstává.
- Liquidate zruší i trailing nohu (ověřit v S4).

**(6) DEMO conformance:** S4 (přijetí, znaménko `pegDifference`, posuny ve streamu, OCO s TP, kaskáda liquidate)
+ R0 fixture.

**(7) Testy**
- Mapování nohy s `pegDifference`.
- Replay S4: bez incidentu po 15 s posunů trailu (mutace: brát posun jako replace → incident / modify → test padá).
- `stop-type` / `trailing-sl` blokují posun a přikoupení.
- Cizí TrailingStop na leaderovi stále blokuje (mutace: klasifikace podle typu místo id → test padá).
- Náhled: blocker mimo manual-only.

**(8) Soubory:** `services/brokerPort.ts`, `services/tradovateMapping.ts`, `services/tradovateBroker.ts`,
`lib/leaderEntryPreview.ts`, `services/manualEntryPreview.ts`, `services/manualScaleIn.ts`,
`services/copierLeaderEventSource.ts`, `services/copierRuntimeController.ts`, `lib/copierWorkerCapabilities.ts`,
`server/localCopierExecutionAgent.ts`, `components/LiveOrderTicket.tsx`, `lib/liveChartOrderLines.ts`,
`components/day/LivePhoneOrderSheet.tsx`, `components/day/LivePhoneOrderLines.tsx`.

**(9) Velikost L.** Závisí na R0 a REC (S4).

---

## 4. C10-MIT — Market-if-touched vstup

**(1) Verdikt: JEN-ČÁST.** Jen manual-only DEMO bez followerů, po R0 a S5–S6. Důvod je stejný jako u Marketu
(`services/manualEntryPreview.ts:313-315`): korelátor OSO typ MIT nezná (`copierOsoCorrelator.ts:49-50`). Nohy MIT
rodiče by se ve skupině s followery zkorelovaly jako samostatný „vstup“ a kopie by vznikla bez nohou. Followeři =
ZAMÍTNOUT, dokud korelátor a plánování MIT neumí (samostatný návrh jádra).

**(2) Chování:** PC typ „MIT“ a čip v listu telefonu (jen s capability `manual-entry-mit-v1`). Cena na limitní straně
(Buy pod trhem). Štítek „MIT … · čeká“ s ×. Panel upozorní: „po dotyku jde jako Market — skluz“.

**(3) Mechanismus**
- `LeaderEntryOrderType` + `'MIT'`, `price` = spoušť. Typ `MIT` přidává R0.
- Náhled: povinně IBKR. Blocker `mit-trigger-side`: Buy spoušť < čerstvý bid − 1 t, Sell > ask + 1 t. Jinak by se MIT
  spustil hned = Market bez bran Marketu.
- Riziko: cena = spoušť ± skluz Marketu (`MANUAL_ENTRY_MARKET_SLIPPAGE_TICKS` `:110` + `MANUAL_ENTRY_SLIPPAGE_TICKS` `:116`).
- SL/TP aspoň `marketMinBracketTicks` (C14) od spouště.
- Controller: `osoRequest` `orderType 'MIT'`, `limitPrice` = spoušť (Tradovate `price`, podle S5). Pozdní synchronní
  kontrola `mit-trigger-side` před POSTem.
- `cancelOwnManualEntry` (`:3649-3709`): MIT čekající jde zrušit (není Market). TIF-a ho hlídá.
- Neznámý výsledek POSTu = incident (jako Market: mohl se spustit a vyplnit hned).

**(4) INV:** INV-MANUAL-01, INV-UI-04 (stranu rozhoduje kotace IBKR workeru), INV-OUTBOX-01/03, INV-DIVERGENCE-01
(followeři zamítnuti), INV-DEFAULT-02 (neznámý výsledek = incident, žádné opakování).

**(5) Selhání:**
- S6 ukáže odmítnutí „přes trh“ → stačí blocker. Ukáže okamžité spuštění → blocker je nutný a stejný.
- Stará kotace → blokováno.
- Brzda během POSTu → ACK za DISARMED: čekající MIT zrušit; už vyplněný = incident (jako Market `:4082-4088`).

**(6) DEMO:** S5, S6.

**(7) Testy:** validace, `mit-trigger-side` náhled i pozdní, riziko se skluzem, replay S5/S6, neznámý výsledek → incident
(mutace: bez incidentu → test padá).

**(8) Soubory:** jako C10-STOPLIMIT, navíc `services/brokerPort.ts`, `services/tradovateMapping.ts`.

**(9) Velikost M.** Závisí na R0, REC (S5–S6), C14 (sdílená minimální vzdálenost), doporučeně TIF-a.

---

## 5. TIF — Time-in-force (Day/GTC/GTD) a hlídání čekajícího vstupu

**(1) Verdikt: JEN-ČÁST.**
- **(a) STAVĚT hned**: hlídání čekajícího vstupu z flat ve workeru („TIF aplikace“). Zrušení vlastního nevyplněného
  vstupu na konci okna / session / ARM a při brzdách. Rozšiřuje existující `reviewPendingScaleIns`, nic nového
  u brokera nezávisí na nenahraném chování (cílené zrušení vlastního vstupu je nahrané a používané).
- **(b) STAVĚT-PO-CONFORMANCE**: broker `timeInForce` `Day` a `GTD` (+ `expireTime`) v příkazu. Pojistka i při mrtvém
  workeru (uspaný Mac). Po S7–S8, v1 jen manual-only. U followerů by kopie TIF nenesla
  (`copierRunner.ts:1291-1292`), to je v2.
- **(c) GTC — ZAMÍTNOUT.** Čekající vstup, který přežije konec session, vypršení ARM nebo výpadek workeru, se vyplní
  mimo dozor kopírky:
  - Po restartu je runtime DISARMED (INV-DEFAULT-01), leader se otevře bez kopie a bez bran.
  - Vypršení ARM zavírá jen známou expozici (INV-BRAKE-05).
  - Obchodní okno (INV-RISK-02) a reset denní paměti v 17:00 CT (INV-RISK-04) by se obešly.

**(2) Chování**
- Panel PC: pod cenou volba „Platnost: Do konce okna (výchozí při zapnutém okně) | Den | Do času…“ (GTD). Market ji
  nemá. Čára čekajícího vstupu „· do 21:55“.
- Telefon: čip „Platnost“ v listu.
- Když worker vstup zruší, karta vlevo dole: „Čekající vstup zrušen — konec obchodního okna“. Z části vyplněný vstup
  se nezruší, karta řekne „Vstup z části vyplněn — zbytek běží, zruš ho ×“.

**(3) Mechanismus (a)**
- `services/manualScaleIn.ts:328-364` rozdělit `pendingAddViolation` na čistou `pendingOrderTimeViolation`
  (kopírka off*, kill, day lock, pauza, management-only, nezpůsobilý leader, okno, session, ARM, nově `expireAt`)
  a poziční část pro přikoupení.
- *Pro vstup z flat se běžný ruční DISARM NEbere jako důvod (INV-BRAKE-01 beze změny, otázka Q1). Kill a ostatní
  brzdy ano.
- `services/copierRuntimeController.ts:3719-3765` `reviewPendingScaleIns` → `reviewPendingManualEntries`. Pro záznamy
  `scaleIn !== true`, `status === 'acknowledged'`, vstup v `liveOrdersByAccount` otevřený a `filledQuantity === 0`
  zavolá `cancelOwnManualEntry` (`:3649-3709`), která už odmítá vyplněný vstup (`:3666-3668`).
- Spouštění beze změny: `scheduleScaleInReview` (`:3797-3812`) po kroku eventu + 1s časovač. Nikdy `await` v `eventTail`.
- Rezerva okna z C15 (`MANUAL_ENTRY_END_RESERVE_MS` nebo instalační hodnota).
- Se followery: zrušení leadera zrcadlí kopírka stávajícím lifecycle (terminalCancel smí i za DISARMED/kill,
  INV-ARM-04, INV-BRAKE-02) — stejná cesta jako dnešní „ACK za DISARMED = zrušit vlastní vstup“.
- Selhané zrušení = incident (`failClosed`, jako přikoupení). Z části vyplněný = jeden audit + karta, bez zrušení
  (zbytek z části vyplněného OSO u Tradovate neověřený, INV-DIVERGENCE-01 známé limity).

**(3) Mechanismus (b)**
- Payload `timeInForce?: 'Day' | 'GTD'`, `expireAt?: number` (epoch ms, jen s GTD). Market oboje zakazuje, `GTC` je
  neplatná hodnota. `COMMAND_KEYS` (`lib/leaderEntryPreview.ts:109`).
- Náhled: blocker `tif-expire-range`. GTD `expireAt` ∈ [teď + 60 s, min(konec aktuálního okna − rezerva, konec session
  − 5 min, vypršení ARM − 5 min)].
  - Nový pomocník `tradingWindowEndAt(window, now)` v `services/copierDailyRules.ts` (DST přes `zonedMinuteOfDay`,
    `:25`; existuje jen `lastTradingWindowEnd` v minutách, `:40`).
  - Konec session jen přes `tradovateSessionEndAt` (INV-RISK-04).
- `services/brokerPort.ts:32-48` `BrokerOrderRequest` + `timeInForce?`, `expireAt?`.
- `services/tradovateMapping.ts:68-84` `toPlaceOrderPayload` + `timeInForce`, `expireTime: new Date(expireAt).toISOString()`.
- Nohy podle S7. Když jejich výchozí TIF ≠ ochrana do konce pozice, samostatné rozhodnutí Q5.
- `CopierManualEntryRecord.request` (`services/copierEngine.ts:348-363`) + `timeInForce`, `expireAt`.
  `record.expireAt` = další důvod pro (a).
- Vypršení u brokera: `toOrderStatus('Expired') → 'canceled'` (`services/tradovateMapping.ts:289`) = normální konec
  záznamu (jako „zrušení nebo vypršení brokerem“ u přikoupení).
- Capability `manual-entry-tif-v1`. Relay beze změny, migrace ne.

**(4) Dotčené INV**
- INV-BRAKE-02, návrh textu: třetí výjimka platí pro „cílené zrušení VLASTNÍHO čekajícího vstupu (přikoupení
  i vstup z flat) — konec okna/session/ARM, kill, day lock, pauza, management-only, nezpůsobilý leader, vypršení
  zvolené platnosti; jen nevyplněný, jeden pokus, nikdy zápis zvyšující expozici“.
- INV-BRAKE-01: ruční DISARM dál vstup z flat neruší (Q1).
- INV-RISK-02: konec okna nově ruší čekající vstup.
- INV-RISK-04: konec session jen přes sdílený helper.
- INV-BRAKE-05: ARM − rezerva.
- INV-OUTBOX-01/02: durable značka `cancel` před zápisem, žádné opakování. Restart s `cancel.status === 'sending'`
  = incident jako u přikoupení.
- INV-TRAD-02: Expired s částečným fillem = partial.
- INV-FRESH-01: rozhoduje jen paměť controlleru. Neznámá pozice/příkaz = nic se neruší (≠ flat).
- INV-MANUAL-01: doplnit odstavec o TIF a GTC zakázaném.

**(5) Selhání:**
- Worker mrtvý → (b) GTD/Day vyprší u brokera. Bez (b) vstup čeká do návratu workeru: ten startuje DISARMED, reconcile
  vidí pracující příkaz a ARM je blokovaný (INV-ARM-01). Pak ho (a) zruší podle času.
- Restart během zrušení → durable značka, žádný druhý pokus, incident.
- Stream bez dat → vstup chybí v `liveOrdersByAccount` → nic (unknown ≠ flat).
- Zrušení vs. souběžný fill → `cancelOwnManualEntry` vyplněný neruší. Fill mezi kontrolou a cancel = broker cancel
  zbytku → stávající partial cesta.
- Kill uprostřed → zrušení smí (výjimka).

**(6) DEMO:** S7 (kde se TIF vrací, výchozí TIF vstupu i nohou), S8 (Expired string, kaskáda nohou).

**(7) Testy**
- `tests/manualScaleIn.test.ts` rozšířit o `pendingOrderTimeViolation` (hranice okna s rezervou, session, ARM,
  `expireAt`; ruční DISARM u vstupu z flat nic). Mutace: přehodit `<` na `<=` u rezervy → test padá.
- `tests/manualPendingEntryReview.test.ts` (nový, controller s mock brokerem):
  - Konec okna zruší Limit z flat jednou i pod kill switchem.
  - Z části vyplněný se neruší.
  - Selhané zrušení = incident.
  - Restart s `cancel: sending` = bez opakování.
  - S followerem kopírka zrcadlí zrušení.
- Validace TIF a mapování `expireTime`. Replay S8 (Expired → konec záznamu bez incidentu).

**(8) Soubory:** `services/manualScaleIn.ts`, `services/copierRuntimeController.ts`, `services/copierDailyRules.ts`,
`lib/leaderEntryPreview.ts`, `services/manualEntryPreview.ts`, `services/brokerPort.ts`, `services/tradovateMapping.ts`,
`services/tradovateBroker.ts` (čtení TIF), `services/copierEngine.ts`, `lib/copierWorkerCapabilities.ts`,
`server/localCopierExecutionAgent.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneOrderSheet.tsx`,
`components/LiveTradeToasts.tsx` (jen text).

**(9) Velikost L** (a = M, b = M). (b) závisí na REC (S7–S8).

---

## 6. C14 — Market se SL/TP blíž než 16 ticků

Fakta:
- `MANUAL_ENTRY_MARKET_MIN_BRACKET_TICKS = 16` (`services/manualEntryPreview.ts:48`): SL i TP ≥ 16 t od ceny, kterou
  viděl uživatel, i od kotace workeru, a na správné straně (`:93-99`).
- Posun reference ↔ worker ≤ 8 t (`:43`, `:89-91`).
- Pozdní kontrola těsně před POSTem: trh proti riziku ≤ 4 t (`services/copierRuntimeController.ts:3932-3946`).
- Účel: skluz fillu nesmí dostat SL nohu přes trh. Když broker takovou nohu při aktivaci odmítne, zůstane pozice bez SL
  a vznikne incident bez auto-close (INV-MANUAL-01: „Broker odmítl SL/TP nohu přijatého ručního vstupu = incident“).

**(1) Verdikt: STAVĚT-PO-CONFORMANCE.** Rozhoduje S9:
- **Větev A** — broker SL přes trh hned spustí (výstup na trhu, malá ztráta): povolit konfigurovatelné minimum
  8–16 t (8 = `MANUAL_TIGHTEN_MIN_TICKS`, `:3437`, stejná hranice jako utažení SL).
- **Větev B** — broker nohu odmítne (holá pozice): snížení **ZAMÍTNOUT** (zůstává 16). Alternativa „Market
  s cenovým stropem“ (marketable Limit z kotace IBKR workeru + N t) je nové použití IBKR jako ceny příkazu → jen po
  výslovném souhlasu Filipa se změnou INV-UI-04 (Q3). Zároveň přidat minimální vzdálenost SL i pro marketable
  Limit (zjištění 1).

**(2) Chování:** Panel PC i list telefonu ukážou „Market: SL/TP aspoň N ticků“ (N ze stavu skupiny) a označí chybu
dřív než worker (jen zobrazení). Text bloceru `market-bracket-too-close` s N.

**(3) Mechanismus (větev A)**
- Instalační pole `group.manualEntryMarketMinBracketTicks` (8–16), jen manual-only local-only. Stejný precedent jako
  `manualEntryMaxContracts`:
  - sanitizace `services/liveCopyTrading.ts:642-644, 683`,
  - vzdálená změna ho nepřevezme (`server/localCopierExecutionAgent.ts:484-486`),
  - flag `--market-min-bracket-ticks` v `scripts/copier/pilot.ts:771-775, 847-854`, pilot ho při startu přepíše.
- `manualEntryMarketQuoteBlockers` (`services/manualEntryPreview.ts:73-101`) dostane `minTicks`. Požadavek od kotace
  workeru = max(minTicks, posun(reference, worker) v ticích + 4). Od reference ≥ minTicks. Správná strana kotace
  beze změny.
- Pozdní kontrola v `executeManualEntry` volá totéž se stejným `minTicks` (synchronně, bez IO).
- Bez pole / neplatné = 16. Běžné skupiny vždy 16.
- MIT (C10-MIT) sdílí stejné minimum.
- Relay beze změny, migrace ne.

**(4) INV**
- INV-UI-04, návrh textu: „SL i TP ≥ `manualEntryMarketMinBracketTicks` (instalace manual-only, 8–16, výchozí 16)
  od obou cen a ≥ posun + 4 t od kotace workeru“.
- INV-MANUAL-01: odmítnutá noha = incident, beze změny.
- INV-OUTBOX-03.
- INV-RISK-01: riziko dál z horší ceny + 6 t skluzu.
- INV-DEFAULT-02: chybějící konfigurace = přísnější 16.

**(5) Selhání:**
- Stará kotace → `market-worker-quote-stale` (beze změny).
- Prudký pohyb mezi kontrolou a fillem → větev A: okamžitý stop-out (známá malá ztráta). Větev B se nestaví.
- Restart → instalační hodnota znovu z pilota.
- Neznámý výsledek Marketu = incident (beze změny).

**(6) DEMO:** S9 (Buy, volitelně zrcadlově Sell). Rozhoduje větev.

**(7) Testy:**
- `tests/manualEntryMarketCapMnq.test.ts`: minimum z konfigurace, dynamická složka s posunem, běžná skupina vždy 16
  (mutace: brát konfiguraci i mimo manual-only → test padá).
- `tests/manualEntryMarketController.test.ts`: pozdní kontrola se stejným minimem.
- Test pilota a agenta: vzdálená změna pole se nepřevezme.

**(8) Soubory:** `services/manualEntryPreview.ts`, `services/copierRuntimeController.ts`, `services/liveCopyTrading.ts`,
`server/localCopierExecutionAgent.ts`, `scripts/copier/pilot.ts`, `scripts/copier/mac-install.ts`,
`lib/liveOrderTicket.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneOrderSheet.tsx`.

**(9) Velikost M.** Závisí na REC (S9).

---

## 7. C15 — Vstup v posledních 5 minutách okna / session / ARM

Fakta: `MANUAL_ENTRY_END_RESERVE_MS = 5 min` (`services/manualEntryPreview.ts:112`). Tři blokery `window-ending`,
`session-ending`, `arm-expiring` (`:287-292`), vstupy z controlleru (`services/copierRuntimeController.ts:19968-19970`).
Stejná rezerva ruší čekající přikoupení (`:3754-3757`).

**(1) Verdikt: JEN-ČÁST.**
- **Rezerva obchodního okna: konfigurovatelná 0–5 min.** Market hned. Limit/Stop/StopLimit/MIT s rezervou < 5 min
  jen s TIF-a (zrušení čekajícího vstupu na konci okna mínus rezerva). Bez něj by čekající vstup mohl otevřít obchod
  po konci okna (INV-RISK-02).
- **Rezerva session 17:00 CT — ZAMÍTNOUT změnu.** CME equity index futures mají denní přestávku 16:00–17:00 CT,
  takže 16:55–17:00 nic obchodovatelného neblokuje. Hranice nuluje denní paměť a day lock (INV-RISK-04), nemá
  smysl ji zkracovat.
- **Rezerva vypršení ARM — ZAMÍTNOUT.** Vypršení ARM odzbrojí a v manual-only zavře celou skupinu
  (`armExpiryFlatten: 'group'`, `services/liveCopyTrading.ts:221`). Vstup minutu před tím = vynucený výstup na trhu
  (INV-BRAKE-05). Prodloužení ARM neexistuje (nový ARM jen z flat, INV-ARM-01).

**(2) Chování**
- PC i telefon: čip „Okno končí za 3:12“ v hlavičce panelu a listu. Blocker říká skutečnou rezervu („Obchodní okno
  končí do 1 minuty“). Čekající vstup ukáže „zruší se v 21:59:00“.
- U ARM odpočet „Zapnutí vyprší za 6 min — vstup jde nejdřív po novém zapnutí (z flat)“.

**(3) Mechanismus**
- v1: instalační `group.manualEntryWindowReserveMinutes` (0–5) jen pro manual-only. Stejný precedent jako C14
  (`liveCopyTrading.ts:642-644`, `localCopierExecutionAgent.ts:484-486`, `pilot.ts:771-775`).
- v2 (volitelně, Q4): pole bezpečnosti skupiny `safety.manualEntryWindowReserveMinutes` (`CopyGroupSafetySettings`,
  `services/liveCopyTrading.ts:105`, sanitizace `:710`). Snížení = zmírnění v `isWeakerRiskConfig`
  (`lib/copierRiskConfig.ts:118`), takže za ostré session jde jen zvýšit.
- `evaluateManualEntryPreview` dostane `windowReserveMs` místo konstanty jen pro `window-ending`. `session-ending`
  a `arm-expiring` zůstávají na 5 min.
- Controller `:19968` počítá `tradingWindowStateAfterReserve` s nakonfigurovanou rezervou. `pendingOrderTimeViolation`
  (TIF-a) bere stejnou hodnotu.
- Pro ne-Market s rezervou < 5 min blocker `window-reserve-needs-pending-guard`, dokud worker neinzeruje
  `manual-entry-tif-v1` (TIF-a).
- Relay ani migrace beze změny.

**(4) INV:**
- INV-RISK-02: okno dál blokuje nové vstupy; čekající ruší TIF-a; day lock po flat beze změny.
- INV-RISK-04 a INV-BRAKE-05: zamítnuté části.
- INV-ARM-01 / pravidlo „za ARMED jen zpřísnit“ (`assertTightenOnly`, `copierRuntimeController.ts:5589-5600`) pro v2.
- INV-MANUAL-01: text rezervy.

**(5) Selhání:**
- Chybějící nebo neplatná hodnota = 5 min.
- Vstup v okně, fill po konci okna (Market je hned, čekající ruší TIF-a) → obchod se dál spravuje, lock po flat
  (INV-RISK-02).
- Restart → instalační hodnota z pilota.
- DST: okno přes `tradingWindowStateAt` v zóně okna.

**(6) DEMO:** není potřeba (jen čas a brány). Ručně na DEMO ověřit s oknem končícím za 2 min: Market projde, Limit
se po konci zruší.

**(7) Testy:**
- `tests/manualEntryPreview.test.ts`: rezerva 0/1/5 min, session a ARM pevně 5 (mutace: konfigurace i pro ARM → test padá).
- `tests/copierRiskConfig.test.ts` (v2): snížení = weaker.
- Agent: vzdálená změna se nepřevezme.
- `tests/manualPendingEntryReview.test.ts`: zrušení na hranici okna s rezervou.

**(8) Soubory:** `services/manualEntryPreview.ts`, `services/copierRuntimeController.ts`, `services/liveCopyTrading.ts`,
`server/localCopierExecutionAgent.ts`, `scripts/copier/pilot.ts`, `lib/copierRiskConfig.ts` (v2),
`components/LiveOrderTicket.tsx`, `components/day/LivePhoneOrderSheet.tsx`.

**(9) Velikost S** (v1), M s v2. Pro ne-Market závisí na TIF-a.

---

## 8. BIDASK — skutečný bid/ask z IBKR v panelu a join bid/ask

**(1) Verdikt: JEN-ČÁST.**
- Cesta **přes status workeru ZAMÍTNOUT.** INV-UI-04 „Nikdy: zapsat cenu … z TV do … worker statusu“ platí celé
  i pro IBKR („platí pro ni celé toto pravidlo“).
- Cesta **přes podepsaný kanál ceny STAVĚT.** Zpráva bid/ask už nese.
- Status workeru smí nést jen stav a stáří kotace bez ceny (precedent hlídače upozornění v INV-WORKER-04).

**(2) Chování**
- PC panel: dlaždice Bid/Ask ukazují skutečné IBKR ceny se štítkem „IBKR“ a rozpětím. Bez nich zůstává dnešní
  odhad se štítkem „orientačně z poslední ceny“.
- Tlačítka „Join bid“ (Buy Limit na bid) a „Join ask“ (Sell Limit na ask) jen nastaví cenu návrhu. Pasivní strana,
  jednorázově, žádné „pegování“ (posun čekajícího vstupu neexistuje).
- Market bere `referencePrice` = skutečný ask/bid. Méně falešných `market-quote-drift`.
- Telefon: v listu řádek „Bid 21 003,25 · Ask 21 003,50“ a čipy Join. Plusko volí typ podle skutečné kotace.

**(3) Mechanismus**
- `lib/liveCandleFeed.ts:10-20` `LiveCandleFeed` + volitelné
  `quote?(root): { bid: number; ask: number; contract: string; receivedAt: number } | null`.
- Implementace v `hooks/useTvLiveCandleFeed.ts` ze `store.view().latest` (`lib/tvPriceStore.ts:33-41`). Jen když:
  - `chart` začíná `IBKR:`, `interval === '1'`, `mode === 'streaming'`,
  - `bid` i `ask` nejsou null, `bid ≤ ask`, rozpětí ≤ 8 t,
  - přijetí ≤ 3 s (čerstvost od příchodu, INV-UI-04),
  - `front` = kontrakt grafu.
- `hooks/useLiveTicketQuote.ts:11-45` vrací `{ price, bid, ask, at, source: 'ibkr-quote' | 'last' }`.
  `components/LiveTradingScreen.tsx:226-230` a `components/day/LivePhoneChart.tsx:117-120` použijí skutečný bid/ask,
  jinak odhad.
- `components/LiveOrderTicket.tsx:432` a `lib/livePhoneOrders.ts:103, 120` berou `referencePrice` ze skutečné strany.
- Join: `lib/liveOrderTicket.ts` `joinDraft(side, quote)`. Před odesláním UI znovu `limitIsMarketable` (`:125-127`)
  s čerstvou kotací → varování.
- Vlákno: `services/ibkrPriceSource.ts:543` `onQuote` → nová závislost `onQuote` → `stream.nudge()` se stávajícím
  rozestupem 200 ms (`scripts/copier/tvPriceStreamThread.ts:285`). Bid/ask se pak posílá i bez obchodu
  (INV-WORKER-04: jen vlákno).
- Volitelně status `controller.manualEntryQuoteState = { fresh, ageMs, contract }` bez ceny. UI tím předem vypne
  Market/Stop, když worker kotaci nemá.
- Worker, relay ani migrace beze změny.

**(4) INV:**
- INV-UI-04, návrh textu: „Panel smí zobrazit bid/ask z ověřené zprávy kanálu (jen zdroj IBKR, čerstvost od
  příchodu ≤ 3 s) a použít ho jako `referencePrice`. Nikdy do statusu workeru, rizika ani rozhodnutí.“
- INV-UI-01: zobrazení nic neautorizuje, Join je výslovná volba ceny uživatelem.
- INV-RELAY-04: kanál jen zobrazení.
- INV-FRESH-03: čerstvost workeru dál jen z pollu.
- INV-WORKER-04: šťouchnutí kotací ve vlákně.

**(5) Selhání:**
- Kanál stojí nebo jede TV → odhad se štítkem.
- Podvržená zpráva → neprojde podpisem.
- `bid > ask` nebo široké rozpětí → odhad.
- Rozdíl panel ↔ worker → worker rozhoduje svou kotací (`manualEntryPreview.ts:84-91`).
- Join na starou cenu → Limit uživatele, nanejvýš marketable (varování).

**(6) DEMO:** není potřeba. Jednorázové ruční porovnání bid/ask panelu s DOM v Tradovate.

**(7) Testy:**
- `tests/useLiveTicketQuote.test.ts` / `tests/tvPriceClientGuards.test.ts`:
  - Jen IBKR, čerstvost od příchodu, `bid ≤ ask`, kontrakt.
  - Žádný import kanálu mimo povolené moduly.
  - Status nemá cenová pole (statický test).
- `tests/liveOrderTicket.test.ts`: join a referencePrice.
- `tests/tvPriceStreamWiring.test.ts`: nudge kotací.

**(8) Soubory:** `lib/liveCandleFeed.ts`, `hooks/useTvLiveCandleFeed.ts`, `hooks/useLiveTicketQuote.ts`,
`components/LiveTradingScreen.tsx`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneChart.tsx`,
`components/day/LivePhoneOrderSheet.tsx`, `lib/liveOrderTicket.ts`, `lib/livePhoneOrders.ts`,
`services/ibkrPriceSource.ts`, `scripts/copier/tvPriceStreamThread.ts`, volitelně `services/copierRuntimeController.ts` (status).

**(9) Velikost S.** Bez závislostí.

---

## 9. Pořadí stavby

1. **BIDASK** (UI a vlákno, bez jádra).
2. **REC-TYPES** + **R0-UNSUPPORTED** (pokud ho nevlastní jiná skupina) → Filip spustí S1–S9 na DEMO8661118.
3. **TIF-a** (hlídání čekajícího vstupu z flat) → **C15 v1** (instalační rezerva okna).
4. Po záznamu: **C10-STOPLIMIT** (S1–S3), **C14** (S9, větev A/B), **TIF-b** (S7–S8).
5. **C10-MIT** (S5–S6), **C10-TRAIL** (S4), oba jen manual-only.

Každý krok jádra: návrh → `copier-design-critic` → diff → critic → testy → tsc → commit (deploy chain jen přes `&&`).
Reinstall workeru v obchodní den až po „nasaď“.

## 10. Otázky pro Filipa

- **Q1:** Má ruční DISARM rušit čekající vstup z flat (jako u přikoupení)? Návrh: ne (INV-BRAKE-01 beze změny).
  Ruší jen čas a ostatní brzdy.
- **Q2:** StopLimit i pro běžné skupiny s followery v1, nebo nejdřív jen manual-only DEMO?
- **Q3** (jen větev B u C14): smí worker použít vlastní kotaci IBKR jako cenu příkazu („Market s cenovým stropem“)?
  Mění INV-UI-04.
- **Q4:** Rezerva okna jen instalací (v1), nebo i v nastavení skupiny (tighten-only)?
- **Q5:** Ukáže-li S7, že výchozí TIF nohou je `Day`: posílat nohy jako `GTC`? Změna jádra pro leadera i kopie
  followerů, samostatný návrh.

## 11. Navržené změny textu invariantů (souhrn)

- **INV-MANUAL-01**: odstavec „Typy vstupu a platnost (návrh 3. 11.)“:
  - StopLimit (spoušť + `limitPrice` ≤ 20 t, IBKR, strana spouště i před POSTem, riziko z limitu);
  - MIT jen manual-only;
  - TrailingStop SL jen manual-only bez followerů (správa jen × / zrušení);
  - TIF jen Day/GTD (GTC zakázané);
  - worker ruší vlastní nevyplněný čekající vstup z flat na konci okna/session/ARM a při brzdách.
- **INV-BRAKE-02**: třetí výjimka rozšířená na vlastní čekající vstup z flat (jen nevyplněný, jeden pokus).
- **INV-TRAD-02**: posun `stopPrice` vlastní TrailingStop nohy brokerem je venue-managed. Spuštění StopLimit podle S2.
- **INV-UI-04**:
  - minimum nohou Marketu konfigurovatelné instalací (8–16, výchozí 16, jen manual-only);
  - bid/ask z ověřené zprávy kanálu (jen IBKR) smí do panelu a `referencePrice`, nikdy do statusu workeru.
- **INV-RISK-02**: rezerva okna pro ruční vstup konfigurovatelná (0–5 min, tighten-only za session). Session a ARM
  rezerva pevně 5 min.
- **INV-DEFAULT-02** (R0): nepodporovaný typ příkazu = cizí příkaz / incident, nikdy pád streamu.


---

## Posudek copier-design-critic (návrh)

**Celkový verdikt: OPRAVIT PŘED COMMITEM**

- **P1** [C10-MIT] (INV-MANUAL-01, INV-DIVERGENCE-01, INV-OUTBOX-03, INV-DEFAULT-02, INV-UI-01 (capability nic neautorizuje)) Pravidlo „MIT jen manual-only bez followerů“ hlídá podle návrhu jen capability (`server/localCopierExecutionAgent.ts:405-415`). Blocker typu `mit-manual-only` ve workeru chybí (na rozdíl od `market-manual-only`, `services/manualEntryPreview.ts:313-315`) a výjimka z R0 „podle id z ACK“ není omezená na manual-only. Scénář: (1) MIT pro běžnou skupinu projde validací relaye i workeru (sdílená `validateLeaderEntryPreview`). (2) Vlastní id ho pustí přes R0. (3) Korelátor MIT rodiče vrátí `unrelated` (`services/copierOsoCorrelator.ts:99`). (4) Jeho SL (Sell Stop) a TP (Sell Limit) nemají známého rodiče, takže se každá noha zapíše jako samostatný nový vstup (`:116-120`). (5) Po okně je `flushStandaloneOsoEntry` pošle přes `processor.process`. `manualEntryOwnership(childId)` je null, protože id nohou nejsou v `ownManualEntryOrderIds` (`services/copierRuntimeController.ts:3632-3635`), a followeři dostanou samostatné otevírací příkazy opačného směru bez ochrany. Ani v manual-only není chování definované: nohy se vedou jako vstupy (epochy, `admittedLeaderOrders`, deník). Dál: restart ve stavu `sending` dělá incident jen u Marketu (`:19504`). ACK za DISARMED u ne-Marketu jen ruší (`:4082-4093`). Neúspěšné zrušení dělá incident jen u přikoupení (`:3695`), takže MIT vyplněný během brzdy zůstane otevřený bez incidentu.
  - Oprava: (a) Ve workeru přidat blocker `mit-manual-only` se stejnou podmínkou jako `market-manual-only` (manualOnly ∧ localOnly ∧ 0 followerů ∧ demo), v náhledu i v pozdní kontrole. (b) Výjimku z R0 povolit jen pro manual-only bez followerů. (c) V korelátoru výslovně spárovat vlastní MIT podle id z ACK (`ownManualEntryOrderIds` / `ownManualLegOrderIds`) ještě před `observe`, nikdy podle typu. (d) MIT dostane stejné zacházení jako Market: restart v `sending` = incident, ACK za DISARMED = incident (zrušení navíc smí), neúspěšné zrušení = incident. (e) Testy: MIT v běžné skupině → blocked; nohy MIT se nikdy nedostanou do `processor.process` jako vstup (mutace: odebrat párování podle id → test padá).
- **P1** [C10-TRAIL] (INV-OUTBOX-03, INV-MANUAL-01 (vlastní OSO se nikdy nekopíruje bez nohou), INV-TRAD-02, INV-UI-02) Tvrzení „`copierOsoCorrelator.ts:133` už pokrývá TrailingStop dítě“ neplatí. Na `:99` se `!isEntryType(event.orderType)` vrátí `unrelated` dřív, než se k řádku 133 dojde. Scénář: (1) Vlastní OSO = Limit + TrailingStop SL + Limit TP. (2) Korelátor uvidí jen TP nohu (`leg`), pár nikdy nevznikne. (3) Po `MANUAL_ENTRY_LEG_WAIT_MS` 5 s (`copierRuntimeController.ts:3443`, `:12501-12509`) přijde `failClosed` a `cancelOwnManualEntry`. (4) U vstupu přes trh (scénář S4) je vstup už vyplněný: zrušení se odmítne a zůstane incident s otevřenou pozicí. Každý trailing vstup by tedy skončil incidentem. Navíc tvrzení „× zavřít pozici funguje“ není pravda: zavření vyžaduje `expect.price === model.stopPrice` (`services/manualScaleIn.ts:386-389`) a fence controlleru. Posun trailu u brokera obojí mění při každém pohybu, takže × v rychlém trhu opakovaně skončí „Obchod se od zobrazení změnil“ / `state-changed`, a to právě ve chvíli, kdy je potřeba.
  - Oprava: Korelátor musí přijmout vlastní TrailingStop nohu podle `ownManualLegOrderIds` jako `stop`, nikdy podle typu. Cizí TrailingStop zůstane `unrelated`, R0 pak dá incident. Zavření pozice s trailing SL ať neporovnává cenu SL, ale id SL nohy a |pozici|. Je to změna fáze 2d, vlastní mini-návrh pro critic. Testy: replay S4 s posuny trailu → pár vznikne a bez incidentu (mutace: klasifikace podle typu → test padá); × během posunu trailu projde.
- **P1** [REC-TYPES / R0 (pořadí)] (INV-TRAD-04, INV-TRAD-06, INV-WORKER-04 (spirit), INV-DEFAULT-01) Návrh říká, že S4–S6 „nahraje i bez R0“, a pořadí v §9 je nedovoluje. Při každém syncu WS adaptér skládá celý `/order/list` všech účtů loginu, včetně ukončených příkazů aktuální session (`services/tradovateBroker.ts:1203-1212`, `:1601-1606`; `syncRequestBody` `:538-541` nemá filtr účtů). Pro TrailingStop nebo MIT vyhodí `supportedOrderType` (`:266-269`) → `closeSocket('socket-message-error')` (`:1985`) → reconnect → stejný seznam → nová chyba. Jediný TrailingStop nebo MIT ze S4–S6, i vyplněný nebo zrušený, tak běžícímu workeru na tomtéž loginu znemožní sync až do konce session: smyčka reconnectů, rozpočet rate-limitu, kopírka mimo provoz. Skript podle vzoru `recordLeaderOsoPlan` počítá s běžícím workerem (kotva ceny z workeru). NEOVĚŘENO: zda login DEMO8661118 nevidí i produkční účty. Pokud ano, padne i produkční kopírka.
  - Oprava: S4–S6 pouštět až po nasazení R0 do VŠECH workerů na tom loginu. Skript to před S4–S6 ověří (capability R0 ve statusu workeru); jinak vyžadovat zastavený worker do 17:00 CT. R0 dát v pořadí stavby na první místo jako samostatnou opravu existující produkční pasti (stačí jeden ruční trailing stop v Tradovate na kterémkoli účtu loginu) a nečekat na BIDASK. Do testů R0 přidat baseline sync s UKONČENÝM TrailingStop v `/order/list`.
- **P1** [R0-UNSUPPORTED] (INV-DEFAULT-02, INV-DIVERGENCE-01, INV-TRAD-01/02, INV-OUTBOX-01) Kontrola je umístěná jen v `planReplication`. Typ leader eventu ale do zápisů kopíruje víc cest: `planModify` (`services/copierEngine.ts:687`, `orderType: event.orderType`), ostatní plánovače a S1b. Mapování posílá `orderType` brokerovi beze změny (`services/tradovateMapping.ts:77`). Scénář: replace navázaného leader příkazu na typ mimo jádro, nebo budoucí kód, který typ rozšíří, a modify followera odejde s `TrailingStop` bez `pegDifference`, případně s řetězcem `Unsupported`. Dál: `streamOrderSnapshot` volá `buildComposedOrder` synchronně (`tradovateBroker.ts:2316`). Dnes tím vyhodí do předčtení u move-stop/close, po R0 vrátí příkaz neznámého typu. Chování musí být výslovné (cizí příkaz = blocked/REST, ne výjimka).
  - Oprava: (1) Jedna kontrola na vstupu leader eventu v controlleru, PŘED korelátorem, epochami a deníkem: typ mimo jádro a ne vlastní manual-only id → za ARMED/SHADOW incident bez auto-close, za DISARMED audit + `invalidateReconciliation`. (2) Pojistka na straně zápisu v `toPlaceOrderPayload`, modify a OCO/OSO mapování: typ mimo Market/Limit/Stop/StopLimit vyhodí výjimku, pokud ho výslovně nepovoluje ruční cesta. (3) Testy: replace Stop→TrailingStop na leaderovi s linky → nula zápisů k followerům + incident; snímek streamu s Unsupported → REST/blocked; LIVE desk vykreslí status s Unsupported bez pádu (INV-UI-02, brzdy musí zůstat dosažitelné).
- **P2** [Zjištění 1 a 3 (marketable Limit, Stop pod trhem) — existující mezera] (INV-UI-04 / INV-UI-01 (UI nic neautorizuje), INV-MANUAL-01, INV-ARM-01 (přísnější brána je bezpečná)) Worker dnes stranu spouště Stopu nekontroluje vůbec. Limit přes trh má jen poznámku (`services/manualEntryPreview.ts:352`). Stranu trhu hlídá jen UI: na PC je marketable Limit jen varování, spuštěný Stop chyba (`lib/liveOrderTicket.ts:158-163`). Scénář v BĚŽNÉ skupině: Buy Limit nad ask a SL mezi ask a limitem. Fill proběhne kolem ask, SL je nad fillem, takže noha při aktivaci leží přes trh. Broker ji odmítne (`InvalidPrice` u modify je nahraný 30. 10.) a leader i followeři zůstanou bez SL, s incidentem bez auto-close. Návrh opravu Stopu váže na C10-STOPLIMIT, tedy až po S1–S3, a opravu Limitu na větev B C14 po S9.
  - Oprava: Vyčlenit hned stavitelnou samostatnou položku bez záznamu u brokera (jde o zpřísnění). Za prvé `entry-trigger-side` pro Stop v náhledu i v synchronní pozdní kontrole. Za druhé u Limitu, který je podle čerstvé kotace workeru přes trh, vynutit stejnou minimální vzdálenost SL/TP od tržní ceny workeru jako u Marketu; bez čerstvé kotace beze změny (nebo blocked, rozhodne Filip). Tuto položku postavit dřív než BIDASK, protože Join bid/ask vyrábí Limity přes trh snáz.
- **P2** [TIF-a (hlídání čekajícího vstupu z flat)] (INV-BRAKE-01/02, INV-OUTBOX-01/02, INV-DEFAULT-02/03, INV-RISK-02) (1) Tvrzení „restart s `cancel.status === 'sending'` = incident jako u přikoupení“ nemá předlohu v kódu. Bootstrap řeší jen `status === 'sending'` (`copierRuntimeController.ts:19504-19523`) a `cancelOwnManualEntry` při existujícím `record.cancel` jen vrátí (`:3658`). Po restartu uprostřed zrušení se vstup znovu nezkusí zrušit ani nenahlásí, a může se vyplnit po konci okna. Stejná díra je dnes i u přikoupení. (2) Neúspěšné zrušení dává incident jen u `scaleIn` (`:3695`). (3) „Spouštění beze změny“ neplatí: 1s časovač běží jen při existujícím záznamu přikoupení (`:19563-19564`). (4) Návrh bere jen `acknowledged`. Smyčka přikoupení správně bere i `unknown` s `lateResult.entryBrokerOrderId` (`:3726-3729`), takže pozdě potvrzený čekající Limit by se na konci okna nezrušil. (5) Není určeno, které DISARMy ruší: failClosed incident a vypršení ARM také, nebo ne? Po incidentu nechat vlastní čekající vstup žít je nové riziko během incidentu (INV-DEFAULT-02). (6) Q1 se opírá o INV-BRAKE-01, ale to zakazuje zavření celého účtu, ne zrušení vlastního nevyplněného vstupu („Bezpečné je ukončit nové entry“). Přikoupení už na DISARM ruší. V běžné skupině pak leader i kopie followerů zůstanou čekat a vyplní se bez dohledu kopírky. (7) Zbytek z části vyplněného vstupu (qty > 1, manual-only) dál otevírá expozici po konci okna.
  - Oprava: Postavit výslovnou kontrolu při startu: záznam s `cancel.status` 'sending'/'failed' a vstup u brokera stále otevřený → `failClosed` (`recordWhenDisarmed`). Selhání zrušení zobecnit na všechny vlastní čekající vstupy. Rozšířit podmínku časovače. Brát i `unknown` s `lateResult`. Výslovně vyjmenovat spouštěče (doporučení: incident i vypršení ARM ruší; ruční DISARM aspoň ve skupině s followery ruší, rozhodne Q1 s opravenou argumentací). Přeskočit, když na tomtéž vstupu běží `cancel-entry` z UI (dvojí zrušení = falešný incident). Pro qty > 1 buď limit 1 kontrakt jako u přikoupení, nebo záznam částečného fillu a zrušení zbytku.
- **P2** [TIF-b (Day/GTD u brokera)] (INV-OUTBOX-03, INV-TRAD-02, INV-ARM-04 (ochranné nohy), INV-MANUAL-01) `toPlaceOsoPayload` rozprostře TIF jen do rodiče (`services/tradovateMapping.ts:217-231`); nohy dostanou výchozí hodnotu Tradovate. Pokud se GTD/Day rodiče u Tradovate přenáší na nohy, vstup vyplněný před `expireAt` ztratí SL/TP v `expireAt` a pozice zůstane bez ochrany. Ve v2 by navíc kopírka zrcadlila konec ochranné nohy followerům. S8 testuje jen vypršení NEVYPLNĚNÉHO rodiče, S7 jen zpětné čtení. Rozsah „v1 jen manual-only“ zase hlídá jen capability, ne blocker ve workeru.
  - Oprava: Přidat záznam S8b: GTD rodič se vyplní před vypršením, sledovat nohy až za `expireTime` (stav, TIF, `expireTime`). Nohám v payloadu nastavit TIF výslovně na hodnotu, která drží ochranu do konce pozice, nebo TIF zablokovat, dokud S7/S8b neprokážou, že se nepřenáší. Přidat blocker `tif-manual-only` ve workeru.
- **P2** [C10-STOPLIMIT] (INV-MANUAL-01, INV-TRAD-02, INV-UI-04, INV-UI-01) (1) Rozsah v1 „jen manual-only“ hlídá jen capability. Worker ani relay StopLimit pro běžnou skupinu neodmítnou a korelátor i runner ho zkopírují (`copierRunner.ts:1288-1292`) bez záznamu u brokera. (2) Pokud S2 ukáže změnu verze nebo typu při spuštění, týká se to už DNES leaderova StopLimitu zadaného v Tradovate v běžné skupině: `planModify` by followerům poslal StopLimit→Limit nad trh, tedy okamžitý fill. Návrh to řeší jen pro vlastní vstup. (3) „qty 1“ je jen doporučení. (4) `entry-trigger-side` je nové použití kotace IBKR v rozhodnutí workeru (jen blokuje); v §11 chybí text pro INV-UI-04.
  - Oprava: Blocker `stoplimit-manual-only` ve workeru (do rozhodnutí Q2). Qty 1 jako tvrdý blocker (jako `scale-in-limit-qty`). Pokud S2 ukáže změnu typu, otevřít samostatný nález pro existující kopírování StopLimitu a značku „venue-managed“ dát i cizímu leader StopLimitu. Do textu INV-UI-04 doplnit, že IBKR smí rozhodovat stranu spouště (jen blokovat).
- **P2** [ACK/pozdní ACK za DISARMED u ne-Marketu (Stop, StopLimit, MIT)] (INV-BRAKE-02, INV-DEFAULT-02, INV-MANUAL-01) Větev ACK za DISARMED a pozdní ACK po timeoutu volají u ne-Marketu jen `cancelOwnManualEntry` (`copierRuntimeController.ts:4013`, `:4090-4093`). Vstup spuštěný a vyplněný během brzdy (Stop/StopLimit/MIT) zrušení odmítne. `cancelOwnManualEntry` buď ze streamu vidí vyplnění a zapíše jen audit, nebo dojde k chybě zrušení a incident vznikne jen u přikoupení (`:3695`). Pozice leadera zůstane otevřená za vypnuté kopírky bez incidentu. U Stopu je to už dnes, MIT to zhorší (může se spustit hned).
  - Oprava: Selhání nebo odmítnutí zrušení vlastního vstupu = incident pro všechny typy. U MIT (a doporučeně i u Stopu) se při ACK za DISARMED chovat jako u Marketu: incident a k tomu cílené zrušení.
- **P2** [BIDASK] (INV-UI-04, INV-UI-01, INV-WORKER-04, INV-RELAY-04) (1) „Join bid/ask“ vloží cenu z kanálu přímo do ceny příkazu. INV-UI-04 v „Nikdy“ výslovně vylučuje cenu z kanálu v „příkazech“ a výjimky dosud schvaloval Filip výslovně. Navržený text v §11 Join nezmiňuje a mezi otázkami Q1–Q5 není. (2) Zpráva nenese `quoteAt`. Když se zastaví kotace bid/ask, ale obchody běží dál, UI podle času příchodu považuje starý bid/ask za čerstvý a Join položí Limit přes trh (viz zjištění 1). (3) „Worker beze změny“ nepřesné: změna vlákna ceny = nový bundle = reinstalace workeru, podle pravidel deploye. (4) NEOVĚŘENO: zda šťouchání kotacemi i mimo hlavní obchodní hodiny (až 5 zpráv/s) nepřekročí kvótu Supabase Realtime. (5) Rozšíření neutrálního `LiveCandleFeed` o `quote()` zpřístupní bid/ask všem konzumentům grafu.
  - Oprava: Doplnit otázku Q6 pro Filipa a výslovnou výjimku INV-UI-04 pro Join (jen předvyplnění viditelné před odesláním, jen IBKR). Kontrola konzistence: last ∈ [bid − k, ask + k] a `quoteAt` ve zprávě. Join stavět až po bráně Limitu přes trh ve workeru. Bid/ask dávat přes samostatné úzké rozhraní jen pro `useLiveTicketQuote`. Do testů přidat statickou kontrolu, že `quote()` čte jen panel.
- **P3** [C15] (INV-RISK-02) Při rezervě 0 se čekající vstup ruší až ve chvíli `windowNow === 'outside'`. Kontrola běží po 1 s a zrušení trvá další latenci, takže čekající vstup se může vyplnit ~1–2 s po konci okna. Rezerva pro přijetí i rušení je jedna hodnota.
  - Oprava: Pro rušení čekajících vstupů držet spodní hranici rezervy (např. ≥ 60 s) nezávisle na rezervě pro přijetí Marketu.
- **P3** [C14] (INV-UI-04, INV-MANUAL-01) Větev A/B rozhoduje jediné pozorování S9, Sell volitelně. Chování „přes trh při aktivaci“ může záviset na straně i vzdálenosti. Nahraný modify přes trh (30. 10.) skončil odmítnutím, takže větev B je pravděpodobnější.
  - Oprava: S9 povinně Buy i Sell, ideálně dvakrát. Větev A jen pokud všechna pozorování shodně ukážou okamžité spuštění.

### Verdikty po položkách

- R0-UNSUPPORTED: **OPRAVIT** — Směr správný a naléhavý: past existuje v produkci, ověřeno `tradovateBroker.ts:266-269`, `:1601-1606`, `:538-541`. Postavit jako PRVNÍ, samostatně. Kontrolu dát na vstup leader eventu a do mapování zápisů, ne jen do planReplication. Výjimka pro vlastní id jen pro manual-only bez followerů.
- REC-TYPES: **OPRAVIT** — S4–S6 před R0 = worker na loginu bez syncu do konce session. Gate na capability R0. Přidat S8b (GTD vyplněný → nohy) a S2b (verze nebo typ při spuštění StopLimitu, i pro cizí StopLimit). U S3 počítat s fillem. Worker během záznamu DISARMED; denní statistiky manual-only skupiny se znečistí.
- C10-STOPLIMIT: **OPRAVIT** — Mechanismus jinak drží: korelátor StopLimit zná, partial ACK = abandoned, synchronní pozdní kontrola. Chybí blocker rozsahu ve workeru a tvrdé qty 1. Výsledek S2 může odhalit existující problém kopírování StopLimitu z Tradovate.
- C10-TRAIL: **OPRAVIT** — Faktická chyba o korelátoru (`:99` předchází `:133`) → každý trailing vstup skončí incidentem. × zavřít s trailing SL kvůli `expect.price` a fence nefunguje. Zamítnutí pro followery je SPRÁVNÉ (INV-TRAD-02, INV-DIVERGENCE-01).
- C10-MIT: **OPRAVIT** — Chybí blocker `mit-manual-only` ve workeru i párování vlastního MIT podle id. Bez nich mohou nohy MIT odejít followerům jako samostatné otevírací příkazy. Zamítnutí pro followery je SPRÁVNÉ.
- TIF-a: **OPRAVIT** — Užitečné a správným směrem (dnešní čekající vstup v běžné skupině přežije vypršení ARM). Předloha pro restart s cancel 'sending' neexistuje. Rozšířit časovač, záznamy `unknown`+lateResult, zobecnit incident při selhání a určit spouštěče DISARM. Argumentaci Q1 opravit.
- TIF-b: **OPRAVIT** — Záznam S8b o přenosu TIF na nohy je povinný. TIF nohou nastavit výslovně, blocker rozsahu ve workeru.
- TIF-c (GTC): **ZAMÍTNUTÍ SPRÁVNÉ** — Vstup přežívající session, ARM nebo výpadek by se vyplnil bez dozoru (INV-DEFAULT-01, INV-BRAKE-05, INV-RISK-02/04). Pozor: pokud S7 ukáže, že výchozí TIF je GTC, je to už dnešní stav a TIF-a je nutné.
- C14: **OK S VÝHRADAMI** — Větvení podle S9 je správné, větev B (zamítnutí snížení) je správná. Výhrada: víc pozorování, obě strany. Bránu Limitu přes trh (zjištění 1) stavět hned, ne až ve větvi B.
- C15 rezerva okna: **OK S VÝHRADAMI** — Jen instalační hodnota, jen manual-only, výchozí 5 min. Pro rušení čekajících vstupů držet spodní hranici rezervy.
- C15 session a ARM: **ZAMÍTNUTÍ SPRÁVNÉ** — Mezi 16:00 a 17:00 CT CME neobchoduje. Vypršení ARM v manual-only zavírá skupinu (`liveCopyTrading.ts:221`).
- BIDASK přes kanál ceny: **OK S VÝHRADAMI** — Zobrazení a referencePrice odpovídají INV-UI-04 a worker rozhoduje vlastní kotací. Join potřebuje výslovnou výjimku od Filipa (Q6), kontrolu konzistence kotace a bránu Limitu přes trh ve workeru. Změna vlákna = reinstalace.
- BIDASK přes status workeru: **ZAMÍTNUTÍ SPRÁVNÉ** — INV-UI-04 „Nikdy … worker statusu“ platí i pro IBKR.
- Pořadí stavby §9: **OPRAVIT** — Nejdřív R0 a zpřísnění Stopu a Limitu přes trh (bez záznamu u brokera), pak REC. S4–S6 až s R0 ve workeru. BIDASK až po bráně Limitu přes trh.
- KONTROLNÍ SEZNAM 1–26: **INFO** — 1 ARM bez bran: drží, nic nemění ARM; pracující Unsupported blokuje no-working. 2 unknown→flat: drží (TIF-a: neznámé = nic se neruší; R0: Unsupported, ne nejbližší typ; chybějící konfigurace = 16 / 5 min). 3 mazání lastError: netýká se. 4 reconcile: netýká se. 5 brzda/fill během await: PORUŠENO u ne-Marketu vyplněného během brzdy (`:4090-4093`, `:3695`); TIF-a falešný incident při souběhu se zrušením z UI. 6 fence před zápisem: drží (pozdní kontroly synchronně v místě kontroly Marketu; zrušení vlastního vstupu = existující výjimka). 7 dvojí provedení: drží (žádné opakování, jeden pokus o zrušení). 8 durable outbox / nejistota: PORUŠENO v návrhu, restart s cancel 'sending' neohlášen (`:3658`, `:19504-19523`); MIT restart v sending bez incidentu. 9 OSO partial/Suspended/noha: PORUŠENO (trailing noha se nespáruje `:99`; nohy MIT = samostatné vstupy `:116-120`; StopLimit partial a spuštění NEOVĚŘENO). 10 divergence obchodem: drží. 11 cíl zavření: netýká se, × s trailing blokované. 12 liquidation nejasná: netýká se. 13 management-only: drží (TIF-a ruší, trailing zakázán). 14 toggle/cut uprostřed: netýká se. 15 eligibility jen zpřísňuje: drží. 16 day lock / DST: drží, potřeba testu DST pro `tradingWindowEndAt`. 17 DISARM/kill dostupné: drží s výhradou testu vykreslení Unsupported v LIVE desku. 18 relay retry/hash: drží (otisk přes všechny klíče, `leaderEntryPlace.ts:46-57`). 19 pořadí v UI: drží (BIDASK od příchodu, chybí `quoteAt`). 20 restart uprostřed: viz 8. 21 dvě OAuth / účet navíc: R0 opravuje pád přes cizí účet; REC na sdíleném loginu NEOVĚŘENO. 22 dva workery: netýká se, žádné nové fencing (INV-WORKER-02 otevřený). 23 p-time / reconnect storm: R0 opravuje existující spouštěč; REC S4–S6 před R0 ho vyvolá. 24 víkend: netýká se. 25 deterministické testy: chybí (viz níže). 26 oddělení tvrzení: drží, návrh uvádí, že critic nad ním neběžel a conformance chybí.
- CHYBĚJÍCÍ TESTY: **INFO** — (1) Baseline sync s UKONČENÝM TrailingStop/MIT na účtu mimo skupinu → sync ready, žádný reconnect. (2) Replace Stop→TrailingStop na leaderovi s linky → nula zápisů k followerům, incident. (3) `streamOrderSnapshot` s Unsupported → REST/blocked, ne výjimka. (4) Korelátor: vlastní OSO s trailing nohou → pár podle id; cizí trailing → bez páru → incident. (5) MIT v běžné skupině → `mit-manual-only`; nohy vlastního MIT se nikdy nezpracují jako vstup. (6) MIT/Stop vyplněný během brzdy → incident. (7) Restart s cancel 'sending' a vstupem stále otevřeným → incident; restart MIT v sending → incident. (8) TIF-a: `unknown`+lateResult se na konci okna zruší; souběh s `cancel-entry` → bez falešného incidentu; spouštěč incident/DISARM podle rozhodnutí. (9) S8b: GTD vyplněný → nohy přežijí `expireTime`. (10) StopLimit/MIT/TIF pro skupinu s followerem → blocker ve workeru (mutace: odstranit blocker → test padá). (11) LIVE desk/telefon vykreslí status s Unsupported/TrailingStop bez pádu, OFF/Kill dosažitelné. (12) DST pro `tradingWindowEndAt` a hranice slotů okna. Testy jsem podle zadání nespouštěl: NEOVĚŘENO.
