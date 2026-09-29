# Opravy kopírky podle ultra review 28. 9. 2026

Zdroj nálezů: [copier-ultra-review-20260928.md](copier-ultra-review-20260928.md). Oponentura Codexe je v [copier-ultra-review-20260928-codex-response.md](copier-ultra-review-20260928-codex-response.md) a určuje pořadí.

Zadání od Filipa (28. 9. večer): „vše oprav s Codexem“.

**Dělba práce:**
- **Codex** implementuje jádro (worker, controller, runner, broker, relay).
- **Claude** zadává balíčky, dělá review diffů, spouští testy a commituje. UI dělá Claude.
- **Nasazení** (reinstall workeru, push na main = produkce) jen na Filipovo „nasaď“, z čistého stavu DISARMED + flat + reconciled a mimo obchodování.

## Pravidla pro každý balíček

**Kde se pracuje:**
- Worktree `/private/tmp/alphatrade-copier-fixes-20260928`, větev `codex/copier-fixes-20260928` nad origin/main.
- `node_modules` je symlink na sdílené závislosti. **Nikdy** nespouštěj `npm ci`, `npm install` ani `rm -rf node_modules`.
- Checkout `/Users/filipkrejca/Documents/trading-journal-aka` nečti kvůli zápisu a neměň. Je v něm cizí rozdělaná práce.

**Bezpečnostní model se nesmí oslabit:**
- DISARMED default, fail-closed.
- Durable outboxy, žádný blind retry: po nejistém výsledku lookup podle clOrdId.
- Divergence = halt, nikdy se neopravuje obchodem.
- Kill switch je jednosměrná západka.

Oprava false-positive smí jen **zpřesnit klasifikaci** s autoritativním důkazem. Nic, co nejde doložit, nesmí projít. Opakovat se smí jen čtení, zápis k brokerovi nikdy.

**Zakázáno:**
- volat Tradovate API,
- mutující endpointy lokálního agenta (127.0.0.1:3211),
- reinstall workeru,
- commit a push. Commituje Claude po review.

**Testy:**
- Každá oprava má regresní test, který bez opravy padá a s opravou prochází. Ověř to.
- Spouštěj cílené soubory: `npx vitest run tests/<soubor>`, plus `npx tsc --noEmit`.
- **Na konci každého balíčku spusť celou sadu kopírky** (`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier tests/liveCopy tests/zz tests/brk2 tests/review tests/exposureCappedBroker.test.ts tests/brokerRouter.test.ts tests/recoverableCopierDelivery.test.ts` — VČETNĚ testů převzatých z review; spouštěj samostatně a kontroluj exit kód, ne přes grep) a nahlas každý pád. Lekce z 28. 9.: V12 prošel 4 cílenými soubory, ale rozbil `copierChaosScenarios` a `copierManagementOnly`.

**Výstup každého běhu (česky):**
- co a proč jsi změnil (soubor:řádek),
- které testy padaly před opravou a které prošly po ní,
- zbylá rizika a otevřené otázky,
- co jsi záměrně NEudělal.

## Integrace

Od 29. 9. 02:38 jsou větve jádra, brokeru, agenta a UI sloučené v `codex/copier-release-20260929` (worktree `/private/tmp/alphatrade-copier-release-20260929`). Další balíčky vznikají nad ní (případně v odbočce s vlastním worktree) a slučují se zpět.

## Balíčky (pořadí z oponentury)

| # | Obsah | Kdo | Reinstall | Stav |
|---|---|---|---|---|
| 1 | Večerní výjimka `retireMissingOldGroup`: přesunout audit za durable zápis, test, že jiná „missing leader route“ zůstane fatální | Codex | ne (commit) | hotovo 1802df6 |
| 2 | UI: nouzový DISARM/kill i při neznámém stavu (ST1), skutečná expirace ARM (V14 UI), retence stavu přepínače (ST2), varování, že úprava skupiny vypne kopírku (V1 UI), UI-10a–e | Claude + Codex | ne | hotovo, větev claude/copier-ui-fixes-20260928 (687bb6b…7abec38) |
| 3 | V12 + V13 + ST4 — po iteracích | Codex | ano | V12 v4 8c2591f: review našlo cesty horší než pre → V12 v5 čeká; V13 v4 1a742cd: review běží |
| 4 | V16 (izolace breached/ineligible followeru pro divergenci) | Codex | ano | hotovo 0b13040 |
| 5 | 5b: V5, V7, V8 + rychlost (broker větev); 5c: V17, V18, ST28, ST31, standalone-stop sweep, receivedAt, SL reassert, ST6, N10 | Codex | ano | 5b hotovo (větev codex/copier-broker-20260929, 32bb813); 5c rozpracováno |
| 6 | V9 + V4 (+ ST4 kontrola) | Codex | ano | rozpracováno (worktree alphatrade-copier-autoclose-20260929) |
| 7 | V10 + ST32 (flatten do konce obchodu mimo frontu s bariérou; rozjezd store); ST3 hotovo v agent větvi | Codex | ano | čeká |
| 8 | V1 + V3 + V15 (validace před DISARM, fence jen na obchodní události, cut vs. rezerva, bootstrap) | Codex | ano | čeká |
| 9 | V6 (resync, route-gap); V7 hotovo v broker větvi | Codex | ano | čeká |
| 10 | UI: DLL a denní P&L (ST10–ST12), editor a hlášky (V2 UI, P116), texty | Claude + Codex | ne | hotovo v UI větvi (UI-10b–e) |
| 11 | V11/ST25 rychlost (broker 8ac3cd6), hardening ST33–ST35 (agent větev; ST34 vrácen, otevřené) | Codex | ano/ne | hotovo kromě ST34 |
| — | Rozhodnutí o politice (V14 strop, V15, ST5, ST21, ST26, ST20) | Filip | — | nechat výchozí bezpečnější variantu, zapsat do PROJECT_LOG |
