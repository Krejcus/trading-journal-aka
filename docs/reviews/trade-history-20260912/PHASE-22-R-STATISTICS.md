# Fáze 22 — doložené R ve statistikách (lokálně)

Pracovní kopie `/private/tmp/alphatrade-history-20260912`, základ `e61ab59a`. Žádná aktivace produkce ani změna brokeru.

## Opravené chování

- `tradeRMultiple` vyžaduje konečné P&L a kladný konečný peněžní risk. Journal importy zatím nemají důkaz původního peněžního risku; pozdější SL ani zděděné legacy `riskAmount` takovým důkazem nejsou.
- `calculateTotalRR` vrací `null`, pokud chybí risk kteréhokoli provedeného obchodu. Zmeškané obchody jsou mimo reálný součet. Prázdný součet je 0. Neúplný součet se nevydává za úplný.
- Průměry a extrémy v Dashboardu používají jednotlivá R. Každá skupina výher/ztrát vyžaduje úplný risk vlastní populace. BE override nemění skutečné peníze, ale vylučuje obchod ze skupiny výher/ztrát.
- Drawdown v R vzniká z chronologického součtu R; stejný čas tvoří jeden krok. Chybějící čas či risk znamená neznámý drawdown. Výplaty a incidenty nejsou součástí R obchodů a tooltip to vysvětluje.
- Formátování neznámého R vrací „—“, nikoli dolarový fallback. Skutečné záporné R zůstává záporné i při opačném znaménku dolarového součtu nebo `showSign=false`.
- Kalendář zpracuje `null` v denních, týdenních, měsíčních i individuálních detailech. Neznámá hodnota má neutrální text/heatmapu. Pozitivní dolarový součet nepřebarví záporné R zeleně. Zachována stávající struktura, komponenty a barvy.
- NetworkHub již neoznačuje dolarové extrémy dnů nebo dolarové body equity jako R, průměrné R zachovává znaménko a vyžaduje celou populaci. Peněžní křivka a extrémy zůstávají v měně; kompletní přepínání těchto grafů do R není součástí této opravy.
- Monte Carlo nepředvyplňuje skutečný risk ze vzorku, který obsahuje obchody s neznámým riskem; uživatelské parametry simulace zůstávají samostatné.
- Fiktivní preview může zobrazit skutečný `DashboardCalendar`, respektuje režim součtu nebo vybraný individuální účet.

## Ověření

- 38 testů ve 4 souborech: `tradeRisk`, `formatPnL`, `analysis`, `journalRiskCalendar`. Včetně skutečného SSR kalendáře, různých risků, odmítnutí legacy journal risku, chybějících hodnot, BE, Missed, pořadí/současných časů a neplatných čísel.
- Klientský typecheck prošel (včetně obou nových testů). Scoped ESLint 0 chyb, 86 existujících varování v rozsáhlých UI souborech; preview samostatně bez chyb.
- Vite/PWA sestavení prošlo, 90 precache položek. `git diff --check` čistý.
- Browser na portu 4189: 12 účtů v souhrnu → neznámý den/týden/měsíc v R; detail dne má 12 obchodů a každé R „—“; rozkliknutý obchod má Risk/Realized RR „—“. Individuální účet 2 zachovává vlastní 27,52 USD a neznámé R. Vizuálně ověřena neutrální heatmapa.
- Referenční tab hlavní aplikace na portu 3000 byl v této fázi spadlý a běžné obnovení nepomohlo. Nový design se nevytvářel; použité komponenty byly čtené ze zdroje a vykreslené ve fungujícím izolovaném preview. Nejde o aktuální browser důkaz produkční aplikace.
- Logy `/private/tmp/journal-phase22-{tests,types,lint,preview-lint,build}.log`.

## Zbývající práce celého cíle

Neveřejné sdílené čtení finanční projekce; přiměřené rozdělení velké finanční projekce; okno skutečných svíček pro dlouhé obchody; konečné ověření importu až do přihlášené aplikace. Zvlášť zkontrolovat starší detail kalendáře proti společnému owner detailu (tato fáze opravuje jeho R, nesjednocuje celý modal). Produkční záloha, migrace, deploy a případná aktivace workeru potřebují konkrétní schválený postup. Celkový cíl není dokončený.
