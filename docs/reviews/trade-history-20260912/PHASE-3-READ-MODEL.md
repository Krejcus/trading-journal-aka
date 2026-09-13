# Evidence: čtení a přiřazení účtům

12. září 2026. Navazuje na PHASE-2-LOCAL.md. Celý cíl stále není dokončený a nic nebylo nasazeno. Předchozí goal turn byl pokrok: přenos, epizody a grafové segmenty byly změněné a ověřené. Tento krok doplňuje skutečnou čtecí cestu API → transakční cache → projekce účtů.

## Implementace

- POST `copier-journal` používá `append_tradovate_journal_evidence`. Nová lokální migrace `20260912115949_journal_trade_projection.sql` drží během celé dávky zámek řádku spojení a přiděluje ingest ID až pod ním. Dávky téhož spojení tak nemohou commitnout v opačném pořadí a přeskočit trvalý čtecí kurzor. Oprávnění funkce má pouze service_role, funkce je SECURITY INVOKER a opakovaně kontroluje vlastníka/spojení i odvolání zařízení. Hlavní tabulka stále přijímá jen append přes serverovou cestu; ostatní writery nesmí tento protokol obcházet.
- GET stejného endpointu používá přihlášení uživatele Bearer tokenem. Každý dotaz ověřuje vlastníka spojení a znovu filtruje owner/connection/environment. Pevná hranice `through` drží stránkování na jednom dokončeném snímku. Jedna stránka má nejvýš 250 událostí; pořadí, rozsah, identita a cizí/duplicitní události se kontrolují před uložením.
- `journalEvidenceCache` zapisuje události a kurzor v jedné IndexedDB transakci. `completeThrough` se neposune, dokud nejsou načtené všechny stránky snímku. Dvě okna mají porovnání očekávaného kurzoru; selhaná kvóta vrátí zpět data i kurzor. Cache je oddělená podle uživatele, prostředí a spojení; změna přihlášení ukončí rozpracované načítání.
- `journalAccountReadModel` stahuje jeden feed na spojení pro všechny jeho účty. Vrací explicitně ready/loading/unavailable. `journalAccountProjection` vyžaduje přesnou OAuth vazbu provider + environment + connectionId + externalAccountId a platné UUID journal účtu. Název, současný leader ani první účet v seznamu nejsou náhradní identitou.
- Nejednoznačný nebo nenapojený účet, otevřená/neúplná pozice a neznámé konečné P&L zůstávají odděleně pending. Pozdější vlastní poplatky mohou stejnou pozici převést do ready, její stabilní identita se nemění.
- Čtecí vrstva zatím neupravuje `Trade`, poznámky ani screenshoty. Záměrně nebyla použita obecná cesta `saveTrades`: ta může neplatný účet nahradit prvním účtem a při nové ne-UUID identitě založit novou DB identitu. Pro další krok je nutný přesný idempotentní zápis a atomická aktualizace pouze obchodních údajů; staré odhady potřebují doložené mapování.

## Ověření

- 73 testů ve 12 souborech prošlo společně: všechny dosavadní související testy a nové testy hranic/cursoru, přerušení načítání, izolace uživatele, JSONB pořadí klíčů, přesných vazeb 12 účtů a read-model orchestrace.
- Scoped TypeScript a scoped ESLint bez chyb. Tento krok neměnil JSX ani vzhled; poslední kompletní Vite/PWA build je doložený v PHASE-2-LOCAL.md.
- `scripts/verify-journal-storage.ts` úspěšně spustil oba skutečné SQL migrační soubory v izolovaném PGlite 0.5.8. Ověřil ACK, opakovaný zápis bez duplicit, scopes, odvolané zařízení, rollback celé vadné dávky, SELECT RLS a zákazy zápisu/spouštění funkce pro authenticated/anon. Ověřil i skutečné Supabase čtecí dotazy přes simulovaný HTTP adaptér do této lokální SQL databáze.
- Tentýž skript s fake-indexeddb 6.2.5 ověřil transakční zápis, skrytý částečný snímek, dvě cache instance, izolaci vlastníka, rollback při kvótě, opakování a souběžné transakce. PGlite používá jedinou DB session; test není důkaz skutečného souběhu dvou produkčních Postgres sessions ani náhradou Supabase advisors.
- Testovací knihovny jsou připnuté a nainstalované pouze v `/private/tmp/alphatrade-journal-verification`. Závislosti a lockfile aplikace nebyly změněny. Skript nepotřebuje žádné .env ani produkční přihlašovací údaje.

Reprodukce po instalaci těchto připnutých testovacích balíčků do dočasné složky:

```sh
./node_modules/.bin/tsx scripts/verify-journal-storage.ts /private/tmp/alphatrade-journal-verification
```

## Zbývající rozsah

1. Propojit tuto čtecí vrstvu s atomickým, idempotentním uložením journal obchodů a s hlavní historií i LIVE kartou. Oprava starých odhadů, zachování ručních úprav a pozdější korekce dosud nejsou dokončené. Neznámé P&L nesmí přes existující povinný numerický sloupec sklouznout na falešnou nulu ani ponechat starou hodnotu jako potvrzenou.
2. Dokončit úplný analytický sběr a počáteční flat důkaz i pro instrument bez předchozího Position řádku. Pasivní observer dnes neprokazuje odběr všech OrderVersion/FillFee/FillPair/CashBalanceLog.
3. Před integrací dlouhé historie změřit nároky projekce: cache ukládá stránky efektivně, ale snapshot zatím čte celou potvrzenou evidenci spojení do paměti a projekce běží v hlavním vlákně. Čtení může pokračovat po čtyřech stránkách na cyklus; spotřebitel musí respektovat stav loading.
4. Vyřešit box přes chybějící svíčky/tržní přestávky, převést náhled na raw-evidence-to-UI fixture a prověřit fullscreen i oba filtry v autentizované aplikaci.
5. Obě SQL migrace, API a worker musejí být doručené koordinovaně. Změny produkční DB/deploy/restart nejsou tímto krokem autorizované ani provedené; před produkční změnou platí AGENTS.md: upozornění, návrh samostatné zálohy/exportu, následně skutečné advisors a ověření.

Dokumentace pro tento krok: [Supabase databázové funkce](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PGlite](https://pglite.dev/docs/).
