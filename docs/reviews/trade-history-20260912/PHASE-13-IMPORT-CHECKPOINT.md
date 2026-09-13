# Fáze 13 — kontrolní bod nezměněného importu

Lokální pokračování v izolovaném worktree. Produkce, vzdálené schéma a worker nebyly změněny.

## Chování

Dosavadní import při každém průchodu četl a promítal celou uloženou historii jednoho připojení. Nový serverový kontrolní bod dovolí nezměněný průchod ukončit jedním RPC bez načítání raw stránek, výpočtu pozic nebo zápisu další generace. Počet účtů počet těchto RPC nenásobí.

Kontrolní bod platí pouze při shodě dokončené revize s nejnovější uloženou událostí, dokončené generaci, verzi projekce a přesném seznamu všech přiřazení účtů daného vlastníka/připojení. Nová evidence včetně zpětné opravy poplatku nebo změna OAuth přiřazení vyvolá úplný import. Čas pozdě doplněného obchodu nemusí být nový: rozhoduje pořadí uložení evidence.

`import_receipt` se ukládá atomicky s dokončením transakce. Databáze porovná aktuální vazby účtů a počty potvrzených/pending pozic s předloženou projekcí. Nesoulad vrátí chybu a celý zápis, včetně zvýšení generace, se vrátí zpět. Starší volání persist bez receipt jej vymaže; nemůže omylem zachovat dřívější certifikát. RPC jsou dostupné pouze service role a ověřují vlastníka připojení. Klient si ceny, účet ani kontrolní bod sám nedodává.

Server kontroluje také tvar odpovědi: skutečné boolean hodnoty a konečné nezáporné bezpečné celočíselné revize/počty. Poškozená nebo nedostupná odpověď není považována za úspěch. Platný prázdný import i pending účet jsou dovolené výsledky.

## Rozsah a omezení

- Jde o optimalizaci **nezměněných** průchodů. Import při nové události stále prochází celý pevný snímek. Skutečné dělení dlouhé historie a pokračování po dávkách ještě není implementované; limity 100 000 událostí / 32 MB, 2 000 pozic / 6 MB zůstávají explicitní chybou bez částečně publikovaných účtů.
- Údaj unchanged potvrzuje zpracovaný uložený snímek v okamžiku databázového čtení. Neprokazuje čerstvé spojení s brokerem, úplnou historickou dostupnost ani připravenost kopírky. Událost nebo nové přiřazení uložené později zpracuje následující průchod.
- Browser po přijatém importu stále načítá kanonické obchody; tím zachovává přenos jiných změn a smazání. Optimalizace se týká serverové evidence a projekce.
- Při budoucí změně projekčního algoritmu je nutné změnit verzi receipt i jeho databázovou kontrolu. Verze 1 není obecný podpis libovolného budoucího algoritmu.
- Úprava je ve stávajícím dosud nenasazeném draftu migrace. Žádná migrace na vzdálené DB ani vzdálené advisors neproběhly.

## Ověření

- 36 cílených testů ve 4 souborech: checkpoint, API trust boundary, synchronizace připojení a stránkování evidence. Včetně chybných odpovědí, chyb RPC, neplatného selektoru/prostředí a prázdného/pending snímku.
- Izolovaný harness se skutečnými třemi SQL migracemi a serverovým importem: 12 potvrzených účtů; další průchod nemá žádné raw čtení, zápis ani změnu generace; odpojení účtu vede k 11 potvrzeným + 1 pending a obnovení opět ke 12. Oprava poplatku se projeví v P&L. Jiný vlastník a authenticated RPC jsou odmítnuty. Chybné receipt vracejí zpět i generaci. Nedokončený nebo starší kontrolní bod se nepoužije. Smazaný obchod se nevrátí ani po vynuceném úplném importu. Předchozí adopce legacy UUID, review ochrany, RLS a rollback případy zůstávají ověřené.
- Scoped TypeScript a ESLint bez chyb; ESLint standardně ignoruje ověřovací skript, který je zahrnutý v TypeScriptu a přímo spuštěný harness.
- Vite/PWA build prošel: 3 482 modulů a 89 precache položek; zůstává obecný warning velikosti chunků. Diff check bez chyb.

Celý cíl zůstává otevřený. Kromě dlouhé historie zbývá obecný backfill a přehled dostupnosti zdrojů, velké API seznamy, automatické screenshoty nových journal záznamů, geometrie position boxu přes mezery, nonpublic social projekce, raw-to-UI/přihlášený E2E a samostatně schválené produkční doručení.
