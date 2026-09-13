# Fáze 17 — přesnost P&L a neznámé výchozí riziko

Lokální práce v izolovaném worktree; žádná změna produkce, databáze ani workeru.

## Změny

Historie a skutečný detail journal obchodů zachovávají dvě desetinná místa čistého P&L. Manuální obchody a další stávající volající si ponechávají původní implicitní formát. Konverze měny přijímá pouze konečný kladný kurz; jinak používá USD.

Journal zatím nemá doložené výchozí peněžní riziko. R/R proto zobrazuje pomlčku s vysvětlením, místo poměru entry/exit a pozdějšího SL. Hydratace odstraňuje původní legacy riskAmount/targetAmount a import je nepovažuje za lokální review. Hodnoticí formulář také nevyrábí R z původního odhadu. Nejde o nový výpočet risku ani o změnu skutečného P&L.

Procenta jednotlivého účtu používají jeho initialBalance. Kombinovaný výsledek používá součet počátečních kapitálů unikátních účtů, jejichž realizace prošly filtry. Chybějící člen, účet nebo neplatný kapitál znamená neznámé procento. Dvě realizace stejného účtu neduplikují jmenovatel. Historie při tomto čtení používá již memoizovaný index skupin, nebuduje celý index pro každou kartu.

Drobné rozestupy v hlavičce detailu zachovávají čitelnost MNQ a nové přesné částky. Byla použita stávající komponenta, tokeny a předchozí kontrola aktuálního canonical vzhledu. Preview přidává přepínač P&L/procenta/R a skutečný kombinovaný modal pro 12 fiktivních účtů po 50 000 USD. Kombinované ukládání review tento testovací scénář nesimuluje.

## Ověření

- 45 testů ve čtyřech souborech prošlo: centy, nula/ztráta, FX fallback, neznámé R/riziko, selekce účtů, duplicitní realizace, chybějící kapitál a zachování souběžných poznámek.
- Scoped TypeScript a ESLint bez chyb (53 existujících warningů v kontrolovaných souborech, zejména nepoužité importy), samostatný lint preview čistý.
- Vite/PWA build prošel, 89 precache entries; git diff --check čistý. SQL nebylo měněno ani znovu spouštěno v této fázi.
- Browser: leader +15,76 USD; follower +27,52 USD, vlastní entry/exit a dvě kontrakty; kombinace +354,24 USD; kombinované procento +0,06 %, leader +0,03 %, různé vlastní hodnoty dalších účtů. R režim ukazuje pomlčku. Screenshoty zůstávají výchozí a kombinovaný detail používá vlastní galerii vybraného účtu.

## Hranice

Počáteční kapitál je uživatelský údaj účtu; tento výpočet není brokerem potvrzená denní návratnost ani účetní procento z NAV v okamžiku vstupu. Journal R bude dostupné až s doloženým a definovaným výchozím rizikem. Hlavní statistické agregace R a sociální projekce vyžadují zbývající audit; tato fáze pokrývá historii, detail a hodnoticí formulář.

Celý cíl zůstává rozpracovaný: obecný backfill/pokrytí, velké broker seznamy a další rozdělení finančního výpočtu, position box přes mezery, nonpublic social projekce, konzistence čerstvých finančních údajů kombinovaného detailu a skutečný přihlášený raw-to-UI/Storage/PostgREST tok. Produkční nasazení vyžaduje samostatnou autorizaci, zálohu a vzdálené kontroly.
