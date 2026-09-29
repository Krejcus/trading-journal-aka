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

## Balíčky (pořadí z oponentury)

| # | Obsah | Kdo | Reinstall | Stav |
|---|---|---|---|---|
| 1 | Večerní výjimka `retireMissingOldGroup`: přesunout audit za durable zápis, test, že jiná „missing leader route“ zůstane fatální | Codex | ne (commit) | hotovo 1802df6 (182/182) |
| 2 | UI: nouzový DISARM/kill i při neznámém stavu (ST1), skutečná expirace ARM (V14 UI), retence stavu přepínače (ST2), varování, že úprava skupiny vypne kopírku (V1 UI) | Claude | ne | hotovo 687bb6b ve větvi claude/copier-ui-fixes-20260928; UI-10a (relay stav, poller, revision fence, re-probe) Codex rozpracováno |
| 3 | V12 + V13 + ST4 (dnešní incidenty + reconcile fence) — po částech 3a/3b/3c | Codex | ano | 3a (V12) rozpracováno |
| 4 | V16 (izolace breached/ineligible followeru pro divergenci) | Codex | ano | čeká |
| 5 | V5, V8, V17, V18, ST28, ST31 | Codex | ano | čeká |
| 6 | V9 + V4 (auto-close jen doložené vlastnictví, guard přežije DISARM) | Codex | ano | čeká |
| 7 | V10 + ST32, ST3 (práce mimo eventTail s bariérou, přednost brzd) | Codex | ano | čeká |
| 8 | V1 + V3 (validace před DISARM, fence jen na obchodní události) | Codex | ano | čeká |
| 9 | V6 + V7 (resync, dedup fillů) | Codex | ano | čeká |
| 10 | UI: DLL a denní P&L (ST10–ST12), editor a hlášky (V2 UI, P116), texty | Claude | ne | čeká |
| 11 | V11/ST25 rychlost, hardening ST33–ST35 | Codex | ano/ne | čeká |
| — | Rozhodnutí o politice (V14 strop, V15, ST5, ST21, ST26, ST20) | Filip | — | nechat výchozí bezpečnější variantu, zapsat do PROJECT_LOG |
