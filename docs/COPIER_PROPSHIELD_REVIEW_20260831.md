# PropShield — tříkolové review a opravené invarianty (31. 8. 2026)

Vznik: Codex navrhl bezpečnostní funkci „PropShield — Verified Risk Copy"; Claude
udělal adversariální review (9 agentů, web research + audit repa); Codex napsal
protikritiku; Claude ověřil sporné body v kódu. Tento dokument je destilát —
**co je ověřené, co je vyvrácené, a jaké invarianty z toho plynou.**

Nic z toho nebylo implementováno. Žádné volání broker API neproběhlo.

---

## 0. Policy gate — rozhoduje dřív než jakákoli technika

**Cross-firm fan-out (Tradeify + Lucid v jedné skupině) je POLICY-BLOCKED**
do písemného potvrzení od Tradeify.

- Tradeify Funded Trader Agreement §6.6: *„While the Trader may use the bot on
  the Trader's personal accounts, using it across multiple firms is against
  Tradeify's policy."* Help Center dodává, že skenují podobné objednávky napříč
  účty a mohou požadovat video se spuštěním kódu na vlastním PC.
- Kopírování mezi **vlastními Tradeify účty** je naopak výslovně povolené
  (§6.7(b)), s bezpodmínečným zákazem opačných pozic.
- Lucid automatizaci i copiery povoluje, ale zakazuje hedging **i mezi vlastními
  účty a napříč korelovanými produkty**; explicitní povolení stejného copieru
  napříč Lucidem a další firmou se veřejně nenašlo.

**Otevřená nuance:** není rozhodnuto, zda AlphaTrade s ručním leaderem a
automatickými follower ordery spadá pod „bot/algo" dle §6.6. Do vyjasnění
platí blok.

**Důsledek:** Tradeify účty obsluhuje výhradně skupina, která nikam jinam
nesahá — nebo Tradeify z multi-firm skupiny vypustit.

---

## 1. Ověřené nálezy v kódu

### 1.1 Zero-protective-leg díra — dvě technické cesty, jeden invariant

| Cesta | Chování dnes | Stav |
|---|---|---|
| Pending Limit/Stop/StopLimit, **jedna** noha | `oso-lone-leg` audit + fail-closed, entry se NEODEŠLE | chráněno |
| Pending Limit/Stop/StopLimit, **žádná** noha | `loneLegCount === 0` propadne do `processor.process()` → **zkopíruje se** | DÍRA |
| Market, jakýkoli počet noh | `isEntryType` = `Limit\|Stop\|StopLimit`, Market vrací `unrelated` → **obchází OSO okno úplně** | DÍRA |

Důkazy: `services/copierOsoCorrelator.ts:47`, `services/copierRuntimeController.ts:1798`,
`services/copierBracketCorrelator.ts` (`prune()` tiše zahodí entry kandidáta, ke
kterému nikdy nedorazil protective leg — `awaitingPair` se plní až prvním legem).

**Produktový invariant:** žádný nový follower entry bez kompletního, bezpečně
známého ochranného plánu — bez ohledu na typ příkazu.
**Implementace je ale dvojí**, protože Market jde jinou cestou než pending.

MVP tvar (dohodnuto):
- pending entry kopírovat **pouze** jako ověřené nativní OSO,
- Market bez předem známého ochranného plánu **blokovat**,
- bezpečnostní podmínkou je **SL**; TP až jako volitelně přísnější „Full Bracket Mode",
- první verze pouze **alarmuje a DISARMuje nové vstupy** — nic nepřepisuje ani nevymýšlí.

### 1.2 Fencing lease nechrání broker writes — ale outbox drží

`fence` se předkládá na jediném místě: `services/supabaseCopierStore.ts:217`
(commit stavu). `tradovateBroker` fence nekontroluje.

**Korekce dřívějšího tvrzení Clauda:** obava „order odeslán a nezapsán do
outboxu" je NEPLATNÁ. Persist je write-ahead — `services/copierRunner.ts:1611`
(`persistRuntime`) předchází `:1620` (`broker.placeOrder`); stejný vzor u
`placeOso` (`:1080` → `:1085`) a `placeOco` (`:853` → `:862`). Když fence selže
už při persistu, broker write se neprovede. Když worker ztratí lease až potom,
objednávka zůstane v durable outboxu jako `sending` a **musí se dohledat**.

**Skutečný problém je „pozdní broker write po takeoveru", ne ztracená objednávka.**
Hard fencing na úrovni brokera vyžaduje gateway, přes který jdou všechny broker
writes — to je předpoklad HA / multiworkeru, ne úkol na příští týden.

### 1.3 Prop plan katalog — víc základu, než návrh tvrdil; méně, než je potřeba

Spuštěno nad `lib/tradovatePropPlanCatalog.ts`:

```
CELKEM: 35   (Tradeify 8, Lucid 27)
accountType:  { evaluation: 35 }        ← žádný funded preset
drawdownType: { eod_trailing: 27, trailing: 8 }
verifiedAt:   ['2026-08-18']            ← jediná hodnota pro všech 35
```

Tři důsledky:
1. **Funded účty katalog nepokrývá vůbec** — tam jsou přitom skutečné peníze.
2. `drawdownType` **není jednotný** (LucidDaily má `trailing` varianty). Právě
   tahle veličina určuje, jestli je „rezerva nad floorem" statická během dne,
   nebo pohyblivý cíl. Jakýkoli výpočet dostupného risku na tom stojí.
3. `verifiedAt` je hardcoded konstanta per commit, ne per pravidlo, a **nikdo ji
   nečte** (grep vrací jen definice). Runtime passport tedy neexistuje.

**Rozhodnutí:** passport jako data ANO, `verifiedAt` jako blokující západka NE.
Brána, která trestá uživatele za neaktualizovanou vlastní dokumentaci, se vypne
při prvním výskytu. Správný tvar: amber banner + odkaz na `sourceUrl`.

### 1.4 Worker nemá živý numerický cushion

`accountRiskFloor()` / `accountRiskCushion()` (`lib/tradovateLiveView.ts:143-169`)
žijí v read-modelu prohlížeče. Do execution runtime jde jen **binární** exclusion,
**jednou při ARM** (`server/localCopierExecutionAgent.ts:313`). Mezi ARM a fillem
se stav neaktualizuje.

**Důsledek:** dynamický `safeQty` ve workeru dnes spočítat nelze. Vyžadoval by
nový důvěryhodný snapshot/cache model — a NE další synchronní REST dotazy před
každým orderem: `exposureCappedBroker` už dnes dělá 2 cally (`listPositions` +
`listOrders`) před každým place na každém účtu, tedy 10 callů na vstup při pěti
followerech. Limit je 5 000 req/h; `429` = hodinové okno, které každý předčasný
pokus restartuje, a při něm neprojde ani emergency cancel/flatten.

### 1.5 `maxContracts` je zároveň detektor cizí aktivity

`services/exposureCappedBroker.ts` počítá `worstLong` / `worstShort` přes aktuální
pozici a všechna working orders na obou stranách, a celý příkaz fail-closed
odmítne. Docstring: *„množství nikdy potichu nezkracuje."* Zamčeno testy
`tests/copierEngine.test.ts:175`, `tests/copierRuntimeController.test.ts:414`.

Protože strop započítává i **cizí** pozice a ordery, je dnešní odmítnutí zároveň
signál, že na účtu je něco, o čem copier neví. **Nahrazení clampem ten signál
ruší.** `safeQty` (pokud vůbec vznikne) se počítá PŘED capem a stejně jím prochází;
cap se nikdy nesmí objevit uvnitř `min()`.

Zpřesnění dřívější formulace Clauda („min() je matematicky nedefinované"): bezpečné
**přírůstkové** množství vypočítat lze — ze strany obchodu, aktuální pozice, pending
orderů a risk budgetu. Nedefinovaný je jen *statický skalár „qty povolené capem"*.
`safeQty` a `maxContracts` nejsou náhrady jeden za druhý.

### 1.6 Regrese incidentu 27. 8. UŽ EXISTUJE

`tests/copierReviewRegressions.test.ts:583` — *„nativní OSO partial fill 6→11 nikdy
neposílá child qty modify; price move zachová qty 11"*, se sekvencí
`incident-stop-suspended-6` → `incident-stop-working-11`.

**Korekce dřívějšího tvrzení Clauda:** požadavek „dokud neexistuje deterministický
regresní test, nesmí žádná větev sáhnout na SL" byl postavený na neexistující
podmínce. Test existuje od 27. 8.

---

## 2. Opravené invarianty (závazné pro jakoukoli budoucí práci)

1. **Admitted quantity je autorita.** Pokud kdy vznikne REDUCED, musí přijaté
   množství řídit entry, SL, TP, partial filly, modify, scale-in, exit **i
   reconciliation**. Bez durable admission ledgeru se REDUCED nesmí zapnout vůbec.
   Důvod: ochranné nohy se dnes sizují z leadera (`services/copierRunner.ts:739`,
   `:1008` — `followerQuantity(pair.quantity, multiplier)`), takže zmenšené entry
   s nezmenšeným SL otočí followera do opačné pozice bez ochrany.

2. **Cap zůstává poslední fail-closed brána.** `exposureCappedBroker` se nenahrazuje
   clampem a nevstupuje do `min()`.

3. **Ledger nesmí nahradit nezávislý referenční bod.** Očekávání
   `trunc(leader × multiplier)` (`copierRuntimeController.ts:2663`, `:1507`,
   `copierEngine.ts:570`) pochází z externího zdroje; `effectiveTargetQty` je
   odvozený z vlastního záměru a nemůže odhalit vlastní chybu. Ledger smí být jen
   DRUHÁ, přísnější podmínka. Test `tests/copierRuntimeController.test.ts:438` se
   nemaže, jen doplňuje.

4. **Ochrana SL: nikdy autonomně neoslabit ani nezrušit platný SL.** Risk-redukující
   zásahy a **prokazatelně doložené** leader lifecycle změny (zrcadlení posunu SL,
   zrušení prokazatelně osiřelé nebo oversized nohy) zůstávají povolené.
   Dřívější absolutní formulace „žádná větev nesmí sáhnout na SL" je zamítnuta jako
   nebezpečná — znemožnila by legitimní risk-redukci.

5. **Žádná zelená.** Protection proof je konzervativní observační důkaz a
   **negativní alarm**. Výchozí stav „neověřeno"; zobrazuje se pouze „ochrana
   nekryje". Nepřítomnost alarmu ≠ potvrzená bezpečnost. Zelené PROTECTED by
   vyřadilo lidskou kontrolu právě tam, kde je nejpotřebnější.

6. **Nula nových synchronních broker callů na horké cestě.** Viz 1.4.

7. **Žádné „všichni bezpeční, nebo žádný vstup".** Eval účet by dostal právo veta
   nad funded účtem — přesný opak zadání. Reprodukuje kaskádu `maxContracts=1`
   z 19. 8. (fail-closed → DISARM → stuck operace → zablokovaný re-ARM).

---

## 3. Vyvrácené návrhy (aby se znovu nenavrhovaly)

| Návrh | Proč padl |
|---|---|
| `safeQty = min(qty, maxContracts, floor(risk/riskPerContract))` | cap do `min()` nepatří (1.5); bez admission ledgeru vyrábí nahé reverzní pozice (2.1) |
| `effectiveTargetQty` jako **náhrada** očekávání reconcileru | ruší jediný nezávislý referenční bod (2.3) |
| „Všichni bezpeční, nebo žádný vstup" (rollout fáze 2) | 2.7 |
| `verifiedAt` jako blokující stale-gate | 1.3 |
| Zelený stav PROTECTED jako gate | 2.5 |
| Dead man's switch fencovaný pouze DB lease | fence nechrání broker writes (1.2); vyžaduje gateway |
| „Jeden GET rozhodne, jestli jde zapisovat venue limity" | `/list` vrací viditelné objekty; pro účty je vhodnější `/ldeps?masterids=`; `changesLocked:false` nedokazuje právo na update; AutoLiq je post-trade, ne pre-trade contract cap |
| Pine/webhook jako „zjednodušení zdarma" | odstraní bracket inference, ale mění způsob obchodování — ruční klik webhook nevytvoří |

---

## 4. Co z PropShieldu přežilo

- **Shadow Safety Receipt** — read-only, mimo horkou cestu. Falzifikační hodnota:
  po měsíci ukáže, jestli by REDUCED vůbec kdy nastalo. Staví se PRVNÍ, ne poslední.
- **Durable admitted-exposure ledger** — ale jako předpoklad REDUCED, ne jako
  náhrada reconcileru.
- **Politika „nikdy si nevymýšlíme náhradní SL"** — reálný rozdíl proti trhu
  (Duplikium při překročení Max Risk % přepíše cizí SL a při chybějícím SL si ho
  dopočítá; FX Blue má `FixedSLPips`; Affordable Indicators odmítnutý ochranný stop
  automaticky přeposílá jako market). Je to **politika, ne funkce** — tak ji i
  formulovat.

## 5. Co konkurence prokazatelně nemá

Doloženo veřejnou dokumentací; formulace „nenašli jsme", ne „neexistuje".

- **Plan-based reconciliation.** CrossTrade doslova: *„fixed-qty drift only
  auto-corrects to flat (when the leader is flat); mid-position the right target
  size is ambiguous, so it's logged as a warning."* Lídr segmentu přiznává, že to
  neumí.
- **Safety Receipt** (zdůvodnění velikosti, ne jen log akcí). Thor o něm napsal
  blog jako o best practice, ale nedeklaruje implementaci.
- **Durable outbox + lookup-before-retry.** U žádného produktu nedoloženo.
- **Cross-account correlation guard** napříč firmami a korelovanými produkty.
- **Payout/consistency guard** — všechny guardy světa hlídají ztrátu, ne to, že jsi
  už vyhrál.
- **Journal jako brána** — copiery journal nemají; my máme `services/labAnalytics.ts`.

NENÍ unikátní (návrh to prodával jako novinku): risk sizing podle vzdálenosti SL
(FX Blue `CashRisk*`/`MaxCashRiskPerTrade`; TradersPost `risk_per_position`,
doslova `qty = risk / (entry − SL)`, per účet, futures/Tradovate), Stop Sovereignty
(Affordable Indicators „Exit Shield"), karanténa účtu (Replikanto Follower Guard,
Sierra Chart Liquidation Only Mode).

---

## 6. Doporučené pořadí prací

1. **Tento dokument** — ADR s opravenými invarianty. (hotovo)
2. **Zero-leg oprava** — zvlášť pending politika, zvlášť Market politika. Pouze
   alarm + DISARM nových vstupů; nic se nepřepisuje ani nevymýšlí.
3. **Shadow Safety Receipt + durable admitted-exposure ledger.**
4. **Read-only capability matice** napříč konkrétními Tradeify/Lucid eval i funded
   účty — **až po výslovném schválení uživatelem.** Jeden GET nestačí (viz 3).
5. **Jeden VPS worker v DEMO.**
6. **Gateway** — před HA/multiworkerem, nebo před jakýmkoli tvrzením o
   „broker-level hard fencingu".

Mimo pořadí, nulové náklady: **multipliery podle poměru `maxLoss`.** `multiplier` je
durable, rozsah 0.01–100 (`services/liveCopyTrading.ts:313`), a reconciler už dnes
očekává `trunc(leader × multiplier)` — asymetrické velikosti tedy nativně podporuje.
Odstraní většinu situací, kdy by dynamický sizing vůbec musel blokovat.

---

## 7. Otevřené otázky

- [ ] Považuje Tradeify AlphaTrade s ručním leaderem za „bot/algo" dle §6.6?
      (písemné potvrzení supportu, archivovat)
- [ ] Dovolují Tradeify/Lucid OAuth tokeny **zápis** do `userAccountAutoLiq` /
      `userAccountPositionLimit`? `changesLocked` je přesně důvod, proč nemusí.
- [ ] Jak se má počítat rezerva nad floorem u plánů s `drawdownType: 'trailing'`
      (8 z 35 presetů), kde se floor hýbe během obchodu?
- [ ] Funded presety v katalogu — dnes žádné.
- [ ] Leader model: zůstává technický signal account (risk-bearing jsou followery),
      nebo se jde do leaderless webhook executoru? Rozhoduje o tom, jestli má
      admission ledger vůbec smysl.
