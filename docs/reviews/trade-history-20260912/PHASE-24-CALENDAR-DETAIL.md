# Fáze 24 — společný detail z kalendáře

Lokální pracovní kopie `/private/tmp/alphatrade-history-20260912`, základ `e61ab59a`.

## Výsledek

Vlastní Dashboard předává kalendáři `onOpenTrade`. Kliknutí z denního nebo týdenního seznamu zavře přehled a předá přesné ID vybraného obchodu již existujícímu `TradeDetailModal` v Dashboardu. Ten u journal záznamů používá stávající čerstvé owner čtení společných finančních faktů a execution historie; otevřený detail začíná na screenshotech. Kalendář nepřepočítává čas ani nepřiřazuje jiný účet.

Denní i týdenní řádky zobrazují název účtu a jsou skutečnými tlačítky ovladatelnými klávesnicí. Týdenní řádek používá stejný formát journal P&L na centy a neutrální neznámé R jako denní seznam. Změna přebírá vzhled stávající aplikace; nepřidává nový design.

Kalendář zobrazený u cizího sdíleného profilu callback nedostává. Jeho dosavadní omezený detail nad již povoleným DTO zůstává oddělený a nezískává owner loader ani možnost editace. Tato fáze nemění seskupování statistických vstupů kalendáře ani sdílené SQL čtení.

## Ověření

- 42 cílených testů v 5 souborech: skutečný SSR kalendáře, přesná členská identita, čerstvý detail, chyby/neúplné odpovědi a formát P&L.
- TypeScript prošel. Scoped lint 0 chyb (70 existujících varování ve dvou velkých komponentách a hláška o ignorovaném preview); preview samostatně s `--no-ignore` prošel bez chyb i varování.
- Vite/PWA build prošel, 90 precache položek. `git diff --check` čistý.
- Browser na portu 4189: den 10. 9. → seznam 12 pojmenovaných účtů → účet 2 → společný detail, 27,52 USD, ENTRY 20109.25, EXIT 20116.75, 2 kontrakty, Screenshoty první.
- Browser: týden 2 → seznam 12 pojmenovaných účtů s centy → účet 11 → společný detail, 31,52 USD, ENTRY 20111.5, EXIT 20120, 2 kontrakty. Denní/týdenní modal po přechodu není otevřený pod detailem.
- Vizuální screenshot potvrdil původní rozvržení detailu. Náhled používá fiktivní data a loadery; nepředstavuje přihlášený produkční E2E ani nové ověření skutečných svíček.
- Logy `/private/tmp/journal-phase24-{tests,types,lint,preview-lint,build}.log`.

## Zbývající práce

Kontrola staršího vlastního kalendářového detailu uvedená ve fázi 23 je tímto vyřešena. Zůstává oprávněními omezené sdílené čtení finanční projekce, limity velké projekce a přihlášené ověření sběru/importu/čtení. Samostatné potvrzení broker conformance, záloha a schválená produkční aktivace jsou stále potřeba. Žádný commit/push, deploy, vzdálená migrace, restart/reinstalace workeru ani broker akce. Celkový cíl není dokončený.
