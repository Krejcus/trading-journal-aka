# Fáze 6 — přesný převod původních obchodů a dostupnost poznámek

Lokální stav 12. 9. 2026, izolovaný worktree z `e61ab59a`. Produkční DB, nasazení a worker se neměnily.

## Identita a původní záznamy

- Třetí lokální migrace používá přesné závěrečné fill ID a spojení z legacy ledgeru. Follower vyžaduje doloženou historickou vazbu na leadera a vlastní externí účet. Aktuální nastavení kopírky, podobná cena a čas se pro spojení nepoužívají.
- Při jednoznačném převodu zachovává nejstarší původní Trade UUID, poznámky, screenshoty a kresby. Opravuje původně chybný účet podle vlastní doložené pozice. Další přesné duplicity zůstávají uložené a odkazují na kanonický záznam; review se nemaže ani neslévá.
- Nejednoznačný původ či chybějící doložení spojení skončí explicitním konfliktem. Opakovaný import nemění již doloženou vazbu. Smazaný kanonický Trade se neobnovuje.
- Sdílený owner advisory lock a trigger brání legacy INSERT po zahájení nového importu. Běžný autentizovaný UPDATE nemůže odstranit migrační identitu ani změnit účet kanonického záznamu. Sekvenční chování ověřeno v PGlite; skutečný souběh dvou PostgreSQL spojení zatím neověřen.
- Potvrzené view a klientské čtečky vylučují původní odhady a nahrazené duplicity. Opravené legacy kopie používají vlastní potvrzená fakta. Cache/fallback také nesmí vrátit vyřazené odhady do statistik.

## Přehled zachovaných review

- `JournalReviewInbox` je v historii dostupný i tehdy, když není žádný potvrzený obchod. Výchozí stav je sbalený; nevzniká dvanáct samostatných karet. Archiv má výslovně vlastní filtr účtu, oddělený od analytických filtrů historie.
- Dvě části: pending/invalidated pozice a původní záznamy/odhady. Neobsahují P&L ani celkový počet provedených kopií. Stav pending zatím nerozlišuje konkrétní příčinu přímo na řádku; možné důvody vysvětluje společný text.
- Owner-only čtečka má keyset stránky po 25 + jeden kontrolní záznam, malé projekce sloupců, timeout a kontrolu přihlášení před i po čtení. Screenshoty a soukromé poznámky načítá až při otevření konkrétního UUID. Při chybě ukazuje nedostupnost, nikoli prázdnou historii jako potvrzený výsledek.
- Detail zobrazuje původní obrázky, poznámky a historii jejich verzí; nepředává staré finanční hodnoty zpět jako `Trade[]`. Kresby zůstávají uložené, archiv zatím zobrazuje jejich počet, nikoli původní graf. Pending pozice bez review nabízí jen stavový řádek.
- Náhled na portu 4189 používá tuto skutečnou komponentu s explicitně fiktivními loadery. Ověřeno rozbalení 12 účtů, přepnutí na starší záznamy, filtr účtu 11, otevření poznámky, světlý i tmavý vzhled. Nejde o přihlášený cloudový E2E test ani o raw-to-UI fixture.

## Ověření

- Izolovaný SQL průchod: přesné leader/follower UUID, chybný původní účet, zachování duplicitních poznámek, ochrana identity, blokace legacy INSERT, chybějící/nejednoznačný ledger. Navazující server→SQL→owner detail průchod pro 12 účtů zůstal zelený.
- 55 testů / 7 souborů pro legacy a čtečky prošlo; po doplnění archivu 28 testů / 4 soubory včetně čtyř nových testů archivu prošlo. Tyto běhy se překrývají; nesčítat jako unikátní testy.
- Scoped TypeScript prošel; ESLint archivu bez chyb. `storageService` má starší warning `no-useless-assignment` mimo tuto změnu. Vite/PWA build prošel: 3 475 modulů, 86 precache položek. Varování velkých chunků a chybějící sourcemap instalovaného TypeScriptu jsou známé.

## Zbývá před aktivací

Nový import stále není automaticky spouštěný z App; starý master import je dosud zapojený. Je nutné je koordinovaně vyměnit, ukázat konkrétní příčiny čekání a napojit LIVE kartu. Dále chybí úplný analytický sběr, důkaz počátečního flat u dosud neviděných instrumentů, inkrementální/partitioned dlouhá historie, oprava position boxu přes chybějící svíčky, povolená neveřejná sociální projekce a přihlášený E2E průchod. Produkční migrace, deploy a worker změny vyžadují samostatné schválené doručení podle AGENTS.
