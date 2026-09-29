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
| 1 | Večerní výjimka `retireMissingOldGroup` | Codex | ne | hotovo 1802df6 |
| 2 | UI: brzdy bez ověřeného stavu (ST1), expirace ARM, retence přepínače (ST2), varování V1, UI-10a–e | Claude + Codex | ne | hotovo (UI větev) |
| 3 | V12 + V13 + ST4 | Codex | ano | V12 6 iterací (f47a109), V13 6 iterací (4db7130); **ověřovací review 6. iterací neproběhlo** |
| 4 | V16 | Codex | ano | hotovo 0b13040 |
| 5 | 5b V5/V7/V8 + rychlost; 5c V17, V18, ST28, ST31, standalone stop, receivedAt, ST6, N10 | Codex | ano | hotovo (32bb813, cdeec40) |
| 6 | V9 + V4 + ST4 | Codex | ano | hotovo 6/6b/6c (20786d1), review 6c neproběhlo |
| 7 | V10 + ST32 | Codex | ano | 7/7b (f8ce845); **otevřené 7c**: visící write na jednom účtu blokuje celý flattenGroup/auto-close (rozdělit účty, viz review 7b) |
| 8 | V1 + V3 + V15 | Codex | ano | hotovo 8/8b/8c (2d7ca5a); review 8c neproběhlo |
| 9 | V6 obměna spojení | Codex | ano | 9/9b (60b9462); review 9b neproběhlo |
| 10 | UI DLL/P&L, editor, texty | Claude + Codex | ne | hotovo (UI větev) |
| 11 | V11/ST25 rychlost, ST33–ST35 | Codex | ano/ne | hotovo kromě ST34 (vrácen, otevřený) |
| 12 | ST7, ST8, ST9, ST19, ST24, ST27, ST29, ST30 | Codex (+ Claude oprava management-only reconcile) | ano | hotovo 50865e5; **ST22 (provenance workeru) neudělán**; review neproběhlo |
| 13 | UI: tlačítko „Zkontrolovat pozice“ (+ relay allowlist reconcile), texty nových kódů vypnutí | Claude | ne | čeká |
| 14 | Závěrečné integrované review celé větve, sloučení s origin/main, build, nasazení | Claude | ano | čeká na „nasaď“ |
| — | Rozhodnutí o politice (V14 strop, V15, ST5, ST21, ST26, ST20) | Filip | — | nechat výchozí bezpečnější variantu, zapsat do PROJECT_LOG |
