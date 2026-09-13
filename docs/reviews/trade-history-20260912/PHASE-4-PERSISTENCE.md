# Automatické uložení vlastní pozice

12. září 2026. Lokální pokračování PHASE-3-READ-MODEL.md. Celá funkce stále není aktivovaná ani dokončená.

## Co je implementované

- `journal-import` přijímá pouze identifikátor spojení, ověří přihlášeného vlastníka a pracuje pouze s DEMO. Server znovu načte uložené raw události do pevné hranice a sám odvodí pozice. P&L, ceny, časy, účty ani finanční projekci z těla klientského požadavku nepřijímá.
- Třetí lokální migrace `20260912122352_journal_position_persistence.sql` odděluje soukromá broker data od uživatelova review. Stabilní identita pozice rezervuje UUID obchodu jednou. Otevřená pozice nebo neznámé poplatky rezervují pouze soukromý pending záznam; nevytváří se falešný uzavřený obchod s P&L 0.
- Úplná projekce všech účtů spojení se zapisuje v jediné transakci. Starší revize je odmítnutá. Chyba jednoho účtu vrací zpět celou transakci. Neexistuje veřejný postup, který by umožnil potvrdit neúplnou sadu klientských dávek.
- Po doplnění poplatků vznikne běžný Trade pod rezervovaným UUID. Pozdější oprava aktualizuje pouze kořenové broker sloupce a soukromá fakta/historii; JSON ručních poznámek, screenshotů a kreseb se znovu nepřepisuje. Jednoznačná historická pozice se nesmí automaticky přesunout na jiný journal účet po vytvoření Trade.
- Ruční smazání Trade ponechá soukromou informaci, že záznam už existoval. Opakovaný import jej nevzkřísí. Pozice odstraněná korekcí má soukromý stav invalidated a zachované review.
- `mergeJournalTradeFacts` přepisuje pouze explicitní broker pole, zachovává ruční review a nepustí pending/invalidated/chybějící či vadná fakta do potvrzené kolekce. **Tento helper zatím není zapojený do storageService/App.**
- Tabulky mají owner SELECT RLS, soukromé finanční zápisy a RPC jsou pouze pro service_role; SECURITY INVOKER, prázdný search_path. SQL znovu kontroluje aktuálního vlastníka spojení, přesnou OAuth vazbu a její jednoznačnost.

## Ověření

- 80 testů / 14 souborů prošlo společně, včetně nového slučování review a hranice API, které odmítá podstrčené finanční údaje nebo vlastníka.
- Scoped ESLint a TypeScript bez chyb. Emitovaný serverový modul prošel nativním Node ESM importem bez browser globals; runtime importy této závislostní větve mají explicitní `.js`. Tento krok neměnil JSX/vzhled, poslední úplný Vite/PWA build je doložený v PHASE-2-LOCAL.md.
- `scripts/verify-journal-positions.ts` používá všechny tři skutečné migrační soubory v izolovaném PGlite 0.5.8. Skutečné Supabase query builder požadavky jsou přesměrované do této lokální SQL databáze; žádný fetch neopustí adaptér.
- Fiktivní raw data pro 12 účtů projdou serverovou projekcí a RPC: chybějící poplatky → pending bez Trade, pozdější poplatky → stejné UUID, retry bez duplikátů, změna poplatku → správné P&L a identické review. Dále stará revize, cizí vlastník, nesprávné/duplicitní přiřazení účtu, chybějící povinná pole, rollback vadného člena, zákaz opětovného vytvoření smazaného Trade, zachování invalidovaného review a RLS obou nových tabulek.
- Dřívější `verify-journal-storage.ts` znovu prošel (append, paged read, RLS a transakce IndexedDB). PGlite má jednu DB session, takže to není produkční důkaz konkurence dvou Postgres sessions ani náhrada Supabase advisors. Závislosti a lockfile aplikace se neměnily.

```sh
./node_modules/.bin/tsx scripts/verify-journal-positions.ts /private/tmp/alphatrade-journal-verification
```

## Co je nutné před aktivací

1. Zapojit soukromá fakta a jejich stavy do storageService, App, hlavní Historie i LIVE. Neúplná/korekcí invalidovaná pozice musí mít dostupné review a viditelný stav, ale nesmí se započítat jako potvrzený výsledek. **Kořenový sloupec trades.pnl nyní u dříve potvrzeného, později invalidovaného záznamu zůstává poslední známou hodnotou. Veškeré statistiky, serverové čtečky, Coach a exporty musí respektovat stav nové projekce, než se import aktivuje.** Samotný nově přidaný helper to zatím globálně nezajišťuje.
2. Nahradit legacy import bez ztráty review a bez nových kopírovaných duplikátů. Aktuální leader není důkaz historického účtu. Staré odhady lze opravit jen podle doloženého spojení.
3. Server nyní čte úplný snímek a má explicitní mez 100 000 událostí / 32 MB, 250 účtů, 2 000 pozic / 6 MB projekce. Překročení vrací `journal-import-partition-required` bez částečného zápisu. Pro dlouhodobou historii je nutné oddělení historie do částí nebo inkrementální projekce; tato hranice není vydávána za hotové neomezené řešení.
4. Úplný analytický sběr, počáteční flat důkaz pro dosud neviděné instrumenty, box přes chybějící svíčky, raw-evidence-to-UI náhled a autentizované koncové ověření stále zbývají podle PHASE-3.
5. Změny jsou pouze v izolovaném worktree. Žádná produkční migrace, deploy, push, restart workeru ani broker akce. Před změnou vzdálené DB je podle AGENTS.md nutné upozornění a samostatný návrh zálohy/exportu; následně skutečné advisors a koordinované ověření.
