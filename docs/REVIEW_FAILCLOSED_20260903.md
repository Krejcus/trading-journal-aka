# Review fail-closed incidentů 2. 9. 2026 (Codex read-only, zadal Claude)

Zdroj: audit/stderr/stdout Mac workeru a snapshot z 2. 9., kód origin/main a3776e55. Časy UTC / CEST.

# Forenzní report

Prověřeno read-only nad `HEAD = origin/main = a3776e55`. Žádné soubory jsem nezměnil a neprováděl jsem broker akce ani testovací obchod. Časy níže jsou `UTC / CEST (UTC+2)`.

## Souhrnný verdikt

| Incident | Verdikt | Primární příčina | Vedlejší broker efekt |
|---|---|---|---|
| 2 — 16:01 | **Race, vysoká pravděpodobnost** | Autoritativní kontrola proběhla při postupném fillu; všichni čtyři followeři byli shodně na `-2`, leader už na `-3` | Žádný auto-close. Dočasně chyběl 1 MNQ na každém followeru |
| 3 — 16:07 | **Skutečná divergence / skutečný safety incident** | Follower SL modify skončil terminálně `rejected`; ochranné objednávky zemřely | Auto-close: 4× Buy Market 17 = 68 MNQ |
| 4 — 16:30 | **Race v exit settlementu** | Guard viděl reálnou, ale právě zanikající follower expozici; nerozpoznal částečně plněný protective exit. Další tři chyby jsou čisté 1,5s deadline races | Guard odeslal 4× Sell Market 15 = 60 MNQ; nelze prokázat, zda flat způsobil guard, nebo současně plněné SL |
| 5 — 16:44 | **Race, prakticky prokázaná** | SL fill a modify se zkřížily; followeři přirozeně odešli přes své stop objednávky, leader fill se dorovnával dalších ~14 s | Žádný další auto-close obchod; 4× follower SL 17 se vyplnily |

Důležitá nuance: u #2 a #4 autoritativní snapshot nelhal — v okamžiku kontroly rozdíl skutečně existoval. Jako „race“ je klasifikuji proto, že šlo o přechodnou, kauzálně vysvětlitelnou část právě probíhajícího fill/settlement lifecycle, nikoli stabilní rozpad kopírování.

---

## Incident 2 — scale-in `1 + 1 + 1`, follower `-2` místo `-3`

### Sekvence

1. `16:01:25.226–25.302 UTC / 18:01:25.226–25.302 CEST`: čtyři aktivní followeři dostali native OSO pro 17 kontraktů; audit už obsahuje broker order IDs. Účet `63338752` byl správně přeskočen jako ineligible. [Audit ř. 1575–1579](worker audit.jsonl:1575)

2. `16:01:27.132–27.207 / 18:01:27.132–27.207`: coverage audit potvrzuje skutečnou follower pozici `1`.

3. `16:01:28.575–28.653 / 18:01:28.575–28.653`: coverage se na všech čtyřech účtech posunula na `2`.

4. `16:01:28.662–28.672 / 18:01:28.662–28.672`: leader protective Stop/Target už nesou quantity `3`. V auditu již není následná follower coverage `3`. [Audit ř. 1598–1615](worker audit.jsonl:1598)

5. Po pevné 2s korelační lhůtě proběhly čerstvé `listPositions`:

   - `16:01:30.774 / 18:01:30.774`: `62364059 = -2`, očekáváno `-3`
   - `16:01:30.915 / 18:01:30.915`: `62364060 = -2`
   - `16:01:31.055 / 18:01:31.055`: `63338592 = -2`
   - `16:01:31.195 / 18:01:31.195`: `62364055 = -2`

   [stderr ř. 34377–34380](worker stderr.log:34377)

6. Pozdější změny SL v `16:02:28–16:03:38 UTC / 18:02:28–18:03:38 CEST` byly blokovány jako `leader-replace-unmapped`; leaderův exit v `16:04:17.544 / 18:04:17.544` byl blokován stavem DISARMED. V `16:04:20.722 / 18:04:20.722` guard autoritativně potvrdil všechny účastníky flat. [Audit ř. 1616–1641](worker audit.jsonl:1616)

### Kódová cesta

- Position event zjistí rozdíl a naplánuje kontrolu v `scheduleFollowerMagnitudeCheck`: [copierRuntimeController.ts:2933](services/copierRuntimeController.ts:2933).
- Výchozí okno je pouze `2_000 ms`: [copierRuntimeController.ts:733](services/copierRuntimeController.ts:733), timer [ř. 1792](services/copierRuntimeController.ts:1792).
- `verifyFollowerMagnitude()` udělá jediný paralelní leader/follower snapshot a při rozdílu okamžitě volá `failClosed(..., {autoClose:false})`: [ř. 1754–1788](services/copierRuntimeController.ts:1754).

### Verdikt

**Race, vysoká pravděpodobnost.** Všichni čtyři followeři byli identicky na druhém dílčím fillu a kontrola přišla téměř přesně po pevné dvousekundové lhůtě. To silně odpovídá zpožděnému třetímu fillu.

Nelze však z těchto artefaktů dokázat, že zbývající jednotka byla v okamžiku kontroly stále `Working/Pending`: audit neobsahuje tehdejší raw entry-order snapshot. Proto jde o silně podložený závěr, ne stoprocentní důkaz.

### Vedlejší efekt a cena

- Auto-close se nespustil, protože tato cesta explicitně používá `autoClose:false`.
- Followeři v okamžiku kontroly zůstali short `-2`; proti leaderovi chyběl jeden MNQ na každém, tedy agregovaně čtyři kontrakty expozice.
- Fill ceny followerů ani přesné fill pairy artefakty neobsahují, takže finanční rozdíl nelze spolehlivě spočítat.

### Bezpečný fix

Před prohlášením divergence:

1. Načíst podle přesného linked entry `brokerOrderId` také status, kumulativně vyplněné množství a zbývající quantity.
2. Pouze pokud chybějící množství odpovídá přesně očekávanému pending fillu stejné epochy a směru, vstoupit do krátkého write-frozen settlement okna.
3. Opakovat celý autoritativní leader/follower snapshot například po 250–500 ms, s celkovou horní mezí přibližně 4–5 s.
4. Při rejectu, cancelu, opačném znaménku, oversize, chybějící lineage nebo expiraci okamžitě DISARM.

Nesmí se poslat „dorovnávací“ Market order ani retry původního vstupu.

---

## Incident 3 — follower modify skončil `rejected`

### Sekvence

1. `16:06:44.129–44.610 UTC / 18:06:44.129–44.610 CEST`: leader Limit 17 a ochranné OCO byly zkopírovány na čtyři followery; audit obsahuje entry, stop a target broker IDs. [Audit ř. 1710–1720](worker audit.jsonl:1710)

2. Při posunu SL na `29188.75` skončily všechny čtyři follower modify terminálně `rejected`:

   - `16:07:03.097 / 18:07:03.097`
   - `16:07:03.248 / 18:07:03.248`
   - `16:07:03.403 / 18:07:03.403`
   - `16:07:03.548 / 18:07:03.548`

   Leader stop byl v `16:07:03.563 / 18:07:03.563` zaznamenán jako `InvalidPrice`. [Audit ř. 1721–1725](worker audit.jsonl:1721)

3. `16:07:03.562 / 18:07:03.562`: controller přešel do FAIL-CLOSED. [stderr ř. 34387](worker stderr.log:34387)

4. Durable snapshot dokládá čtyři native liquidation requesty `Buy Market 17`, odeslané `16:07:04.156–04.162 / 18:07:04.156–04.162`; všechny měly v `16:07:05.804–05.805 / 18:07:05.804–05.805` stav `flat-no-active`. Potvrzení ale výslovně uvádí `causality: not-proven`. [Snapshot](worker snapshot.json:1)

5. `16:07:05.817 / 18:07:05.817`: audit shrnuje „zrušeno 0 příkazů, zavřeno 4 pozic“. [Audit ř. 1730](worker audit.jsonl:1730)

6. `16:07:08.425–09.323 / 18:07:08.425–09.323`: následná magnitude kontrola hlásila `follower 0`, `leader -17`. To je očekávaný následek úspěšného bezpečnostního auto-close, nikoli druhá kořenová příčina.

7. Leaderův Market exit 17 v `16:07:28.066 / 18:07:28.066` už nebyl kopírován kvůli DISARM; `16:07:30.403 / 18:07:30.403` guard potvrdil všechny flat.

### Kódová cesta

- Po modify ACK se provádí autoritativní lookup, nikoli důvěra v HTTP ACK: [copierRunner.ts:1475](services/copierRunner.ts:1475).
- `resolveCancelLookup()` klasifikuje terminální `rejected` modify jako `abandoned/cancel-failed`, protože objednávka zemřela a follower může být bez ochrany: [copierCancelOutbox.ts:107](services/copierCancelOutbox.ts:107).
- Kritický audit jde přes `failClosedOnCriticalAudit()`: [copierRuntimeController.ts:1824](services/copierRuntimeController.ts:1824).
- `failClosed()` odzbrojí runtime a pro živě armed epizodu naplánuje auto-close: [ř. 1555–1584](services/copierRuntimeController.ts:1555).
- Closure používá durable write-ahead a neposílá stejný nejasný operation znovu: [copierManualActions.ts:245](services/copierManualActions.ts:245).

### Verdikt

**Skutečná divergence / skutečný safety incident.** `Rejected` není přechodný stav ani opožděný ACK. Ochranné follower objednávky skutečně skončily a runtime už neměl důkaz bezpečné protection parity.

### Vedlejší efekt a cena

- Odeslány byly čtyři closing requesty po 17 MNQ, celkem 68 kontraktů.
- Followeři byli do přibližně 2,25 s od fail-closed autoritativně flat.
- Finanční cenu nelze vypočítat: snapshot obsahuje quantity, ale ne execution prices. `causality:not-proven` navíc neprokazuje, který konkrétní broker lifecycle event flat způsobil.

### Bezpečný fix

Zde se grace window **nesmí** používat. `Rejected` musí nadále okamžitě DISARM + risk-reduction.

Smysluplná malá úprava je pouze UX/observability: po prokázaném auto-close označit následná hlášení `follower 0 vs leader -17` jako očekávaný post-auto-close stav a nedělat z nich další samostatný incident. Safety stav se tím nesmí změnit.

---

## Incident 4 — leader flat, současné SL filly a tři sweep timeouty

### Sekvence

1. `16:19:17.577 UTC / 18:19:17.577 CEST`: vznikl nový Buy OSO 17 a byl zkopírován čtyřem followerům.

2. `16:30:37.374–37.820 / 18:30:37.374–37.820`: všechny follower stop objednávky byly úspěšně posunuty na `29153`.

3. `16:30:37.903–37.954 / 18:30:37.903–37.954`: leader target quantity klesá `15 → 14`; `16:30:38.364–38.812 / 18:30:38.364–38.812` byly follower targety potvrzeně zrušeny. To už je stop/exit settlement. [Audit ř. 1798–1815](worker audit.jsonl:1798)

4. `16:30:41.198 / 18:30:41.198`: po 2s leader-flat grace guard vyhodnotil čtyři follower pozice jako orphan expozici. [stderr ř. 34397](worker stderr.log:34397)

5. Snapshot dokládá native `Sell Market 15` pro každý follower účet, odeslané `16:30:41.744–41.755 / 18:30:41.744–41.755`. Všechny účty byly v `16:30:43.335–43.336 / 18:30:43.335–43.336` potvrzeny jako flat/no-active, opět s `causality:not-proven`.

6. `16:30:43.397 / 18:30:43.397`: guard zaznamenal cílené zploštění čtyř expozic. Současně flat sweep zjistil u každého účtu follower stop `filled` a target `canceled`. [Audit ř. 1816–1827](worker audit.jsonl:1816)

7. První účet `62364059` prošel. Další tři postkontroly vypršely:

   - `16:30:45.731 / 18:30:45.731`: `62364060`
   - `16:30:47.587 / 18:30:47.587`: `63338592`
   - `16:30:49.396 / 18:30:49.396`: `62364055`

   Auditní `at` u těchto záznamů je starší než skutečný stderr čas, protože sweep si timestamp zachytí před čekáním a serializovaný event tail pak účty zdržuje po 1,5 s. [stderr ř. 34398–34400](worker stderr.log:34398)

8. `16:31:00.085–00.413 / 18:31:00.085–00.413`: nový leader Limit/Stop 17 už byl správně blokován jako DISARMED. Následné `follower 0, leader 17` v `16:31:02.272–02.716 / 18:31:02.272–02.716` je tedy reálný následný rozdíl způsobený novým leader obchodem během DISARM, nikoli důkaz, že předchozí guard closure selhalo. [Audit ř. 1828–1838](worker audit.jsonl:1828)

### Kódová cesta

- Leader-flat kontrola načte paralelně positions + orders všech účtů: [copierRuntimeController.ts:2021](services/copierRuntimeController.ts:2021).
- `isInflightExit()` uznává working/pending pouze u přesně mapovaného copied exitu nebo guard liquidation. U protective orderu uzná až čerstvý terminální `filled`; obyčejný či částečně plněný `Working` stop se nepovažuje za probíhající exit: [copierLeaderFlatGuard.ts:499](services/copierLeaderFlatGuard.ts:499).
- Ne-flat automaticky vlastněná pozice bez takového důkazu se stane `close-target`: [ř. 597–634](services/copierLeaderFlatGuard.ts:597).
- Controller nejprve DISARMuje a poté volá `processTargetedLiquidation()`: [copierRuntimeController.ts:2140](services/copierRuntimeController.ts:2140), [copierManualActions.ts:598](services/copierManualActions.ts:598).
- Každý sweep REST call má pevný deadline `1_500 ms`: [copierRuntimeController.ts:765](services/copierRuntimeController.ts:765). Timeout volá `failSweep()` → `failClosed()` → další plánování auto-close: [ř. 851](services/copierRuntimeController.ts:851).

### Verdikt

**Race v exit settlementu.** Follower expozice v `16:30:41` ještě skutečně existovala, ale audit krátce poté ukazuje všechny přesné protective stop IDs jako `filled`. Guard neměl dost bohatá data, aby poznal částečný fill stále vedený jako `Working`, a po dvousekundové grace jej považoval za orphan.

Tři pozdější `deadline 1500 ms` jsou samostatné čisté races: durable final-check už před nimi potvrzoval flat/no-active stav.

### Vedlejší efekt a cena

- Guard odeslal čtyři native liquidation requesty po 15 MNQ, tedy 60 kontraktů.
- Ve stejném intervalu skončily follower stop objednávky jako `filled`.
- Nelze dokázat, zda flat způsobil protective stop, guard liquidation, nebo jejich broker-side souběh. Právě proto snapshot správně uvádí `causality:not-proven`.
- Bez fill cen nelze určit slippage ani peněžní dopad. Toto je nejrizikovější incident z hlediska možného redundantního exit requestu.

### Bezpečný fix

- Rozšířit `LeaderFlatExitEvidence` o `filledQuantity`, remaining quantity a poslední fill timestamp.
- Čekat pouze tehdy, když se po `leader.flatObservedAt` mění **přesná protective objednávka stejné epochy** a její kumulativní fill vysvětluje pokles pozice.
- Po 250–500 ms opakovat celý autoritativní batch; celková settlement grace může být například 4–5 s.
- Jakýkoli cizí Working SL, chybějící lineage, opačný směr nebo neměnící se pozice zůstává okamžitým close-targetem.
- Pro flat sweep použít čerstvý generation-fenced důkaz `position → orders → position`, který už manual flatten získal, případně dvě omezené postkontroly s deadline přibližně 3–5 s. Přetrvávající timeout musí zůstat fail-closed.

---

## Incident 5 — modify během fillu skončil `filled`

### Sekvence

1. `16:40:24.616 UTC / 18:40:24.616 CEST`: předchozí epochu guard potvrdil jako čistě flat.

2. `16:41:18.085–18.330 / 18:41:18.085–18.330`: nový native OSO 17 byl zkopírován čtyřem followerům. [Audit ř. 1874–1878](worker audit.jsonl:1874)

3. Tři předchozí stop posuny byly autoritativně potvrzeny:

   - `16:43:03.298–03.759 / 18:43:03.298–03.759`: `29139.75`
   - `16:43:47.258–47.702 / 18:43:47.258–47.702`: `29142`
   - `16:44:20.124–20.555 / 18:44:20.124–20.555`: `29142.75`

   [Audit ř. 1879–1890](worker audit.jsonl:1879)

4. Další modify na `29141` se střetl s fill lifecycle. Všechny přesné follower stop IDs skončily `filled`:

   - `16:44:27.695 / 18:44:27.695`
   - `16:44:27.840 / 18:44:27.840`
   - `16:44:27.988 / 18:44:27.988`
   - `16:44:28.143 / 18:44:28.143`

5. `16:44:28.159 / 18:44:28.159`: FAIL-CLOSED na prvním kritickém `modify … filled`. [stderr ř. 34408](worker stderr.log:34408)

6. `16:44:28.161–28.264 / 18:44:28.161–28.264`: follower coverage postupně ukazuje pozici `12`, potom `11`.

7. `16:44:28.277–29.648 / 18:44:28.277–29.648`: flat sweep u všech účtů potvrzuje stop `filled` a target `canceled`. To je přímý důkaz, že followeři odešli přes své ochranné stopy. [Audit ř. 1891–1910](worker audit.jsonl:1891)

8. `16:44:30.412 / 18:44:30.412`: okamžitá terminal-fill reconciliation ještě viděla nesynchronní stav a skončila `blocked`; ve stejné chvíli vznikl sekundární `leader-replace-unmapped`.

9. `16:44:30.866–32.251 / 18:44:30.866–32.251`: autoritativní kontroly viděly followery `0`, leader stále `17`.

10. Teprve `16:44:41.131–42.174 / 18:44:41.131–42.174` leader target quantity klesá `16 → 15 → 9` a pak se ruší. Leader exit settlement tedy pokračoval ještě přibližně 13–14,5 s po follower fillu. [Audit ř. 1911–1934](worker audit.jsonl:1911)

### Kódová cesta

- `filled` modify je správně klasifikován jako kritický, protože změnil pozici: [copierCancelOutbox.ts:107](services/copierCancelOutbox.ts:107).
- `criticalAuditAllowsTerminalFillRecovery()` dovolí zvláštní recovery pouze homogenní dávce `modify → filled`: [copierRuntimeController.ts:78](services/copierRuntimeController.ts:78).
- Přesto se nejdříve zavolá `failClosed()`, následně `autoFlattenCopies()` a okamžitá reconciliation: [ř. 1597–1634](services/copierRuntimeController.ts:1597).
- Protože lokální follower expozice už byla nulová, auto-flatten správně skončil bez broker write: [ř. 2256–2260](services/copierRuntimeController.ts:2256).
- Pozdější replace neměl živý follower link a skončil jako `leader-replace-unmapped`: [ř. 3251–3267](services/copierRuntimeController.ts:3251), all-or-none plánování [copierRunner.ts:1209](services/copierRunner.ts:1209).

### Verdikt

**Race, prakticky prokázaná.** Přesné follower stop IDs byly `filled`, protilehlé targety `canceled` a všechny follower pozice flat. Leader stav se pouze dorovnával výrazně pomaleji. Okamžitá reconciliation přišla asi o 12–14 s dříve než úplné leader settlement evidence.

### Vedlejší efekt a cena

- Auto-close neposlal žádný další closing order.
- Čtyři follower SL po 17 kontraktech se vyplnily běžnou protective cestou; souhrnný follower exit volume byl 68 MNQ.
- Cena posledního potvrzeného SL `29142.75` ani požadovaný modify `29141` nejsou execution prices. Z dostupných dat proto nelze spočítat P&L či slippage.

### Bezpečný fix

Zavést před samotným DISARM explicitní stav typu `TERMINAL_FILL_SETTLING`:

- Okamžitě zastavit všechny nové replikační write operace.
- Aktivovat jej jen tehdy, když **všechny** kritické položky dávky jsou přesné linked follower `modify → filled`.
- Opakovaně číst leader order/position a všechny follower positions/orders po 250–500 ms.
- Vzhledem k pozorovaným ~14,5 s použít konfigurovatelnou horní mez přibližně 15–20 s.
- Návrat do normálního stavu připustit pouze při synchronním flat/no-active výsledku stejné session, epochy a `safetyGeneration`.
- Jakýkoli další critical audit, nová leader expozice, chybějící lineage, reconnect, timeout nebo nejednoznačnost musí okamžitě skončit standardním DISARM.

`filled` se nikdy nesmí vydávat za úspěšně provedený modify; nesmí se retryovat ani otevírat follower zpět. `leader-replace-unmapped` lze během přesně identifikovaného settlementu pouze deduplikovat jako sekundární symptom, nikoli ignorovat mimo něj.

---

## Priority a odhad složitosti

1. **P0 — incident 4: partial-fill-aware leader-flat guard + sdílený fresh-flat důkaz.**  
   Největší riziko redundantního broker exitu. Složitost **střední až vyšší**, přibližně 2–4 vývojové dny včetně deterministických testů partial fillu, stale eventu, wrong-lineage a timeoutů.

2. **P1 — incident 5: bounded terminal-fill settling state.**  
   Největší zdroj zbytečného DISARM při rychlém stop fillu. Složitost **vyšší**, přibližně 2–4 dny; vyžaduje generation fencing, restart/reconnect testy a jistotu, že během čekání neprojde žádný nový write.

3. **P1 — incident 2: pending-entry-aware magnitude grace.**  
   Složitost **střední**, přibližně 1–2 dny. Nestačí prodloužit pevný timer; musí se ověřit přesný linked entry order a opakovat autoritativní snapshot.

4. **P2 — incident 3: deduplikace post-auto-close alarmů.**  
   Safety logika je správná. Pouze lepší incident grouping/UX, složitost **nízká**, zhruba 0,5–1 den.

Napříč všemi opravami musí zůstat: fail-closed jako default při nejednoznačnosti, žádné obchodní „dorovnávání“ divergence, žádný blind retry, durable write-ahead a žádné automatické znovu-ARM po skutečném DISARM. Právě tyto hranice jsem držel i při review podle copier-pilot guidance.


