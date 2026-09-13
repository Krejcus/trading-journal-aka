# Fáze 14 — dávkové uložení a úplné načtení historie

Lokální pokračování v izolovaném worktree. Žádná vzdálená migrace, deploy, změna workeru ani obchodní akce.

## Dávkový zápis

Import nad 100 pozic nebo 1 MB používá skryté staging tabulky a tři service-only RPC. Server nejdřív vypočítá úplnou projekci jednoho připojení. Obsahový SHA-256 klíč zahrnuje revizi, vazby účtů, receipt a všechny pozice. Stejný opakovaný výsledek najde původní run a pokračuje od potvrzených dávek.

Jedna dávka má nejvýš 100 celých pozic a 1 MB serializovaného vstupu; databáze ponechává prostor do 2 MB pro JSONB formát. Pozice se neroztrhává mezi fakty a soukromou historií. Každá dávka má pořadí, počet a SHA-256 kanonického JSONB. Opakování stejného obsahu je idempotentní, odlišný obsah na stejném pořadí je konflikt.

Staging vůbec nemění viditelné obchody, soukromou projekci ani její generaci. Finální RPC ověří všechny dávky, jejich součet, vlastníka a aktuální přiřazení účtů. Úplný výsledek předá původní transakční validaci/persistenci. Stejná transakce teprve aktualizuje všechny pozice, zneplatní opravené epizody a dokončí hlavu. Chyba i posledního člena vrací zpět všechny předchozí změny.

Po úspěchu zůstanou jen metadata a hashe dávek; duplikované plné payloady se odstraní. Opakované finální potvrzení nevytvoří další generaci. Starší run po novější publikaci vrací stale. Novější zdrojová revize nebo jiné přiřazení účtů odstraní překonané nedokončené runy, ostatní se čistí po 24 hodinách při dalším zahájení. Pro připojení jsou povolené nejvýš čtyři současně nedokončené runy. Databáze omezuje staged výsledek na 50 000 pozic / 128 MB, server na 96 MB. Privátní tabulky mají RLS a žádný grant pro anon/authenticated.

Menší import si ponechává přímou transakci. Přímé volání nemůže samo obejít původní limit: větší payload vyžaduje existující úplný staging run se shodným obsahem a receipt. Při velkém importu se nevrací dlouhé pole UUID; potvrzení obsahuje revizi a počet skutečně zpracovaných pozic. Kontrola legacy adopce se přeskočí jen tehdy, když vlastník nemá žádné původní legacy review řádky; její pravidla zůstávají stejná. Seznam dodaných identit pro invalidaci se materializuje jednou.

## Úplná čtečka

Při kontrole navazujícího toku byl nalezen dosavadní `getTrades().range(0, 99999)`. Velký požadovaný rozsah není spolehlivým překonáním serverového limitu odpovědi. Skutečný seznam nyní postupuje po unikátním UUID po stránkách do 250 řádků, pokračuje i při nižším serverovém capu a skončí až potvrzenou prázdnou stránkou. Ověřuje pořadí, scope a změnu vlastníka. Výsledek řadí stejně jako dřív sestupně podle času.

Generace journal projekce se čte už před načítáním kořenových řádků a znovu po hydraci faktů/poznámek. Publikace nových UUID za právě projetým kurzorem proto nemůže potichu vytvořit částečný kombinovaný seznam. Neúplná odpověď, změna účtu nebo generace skončí chybou před přepsáním cache. `getTrades` při selhání požadovaného úplného načtení už nevrací starý cache seznam jako úspěšnou odpověď; samostatné explicitní cache čtečky zůstávají dostupné. To platí i pro ruční/backtest obchody v tomto seznamu. Cizí social scope nečte owner-only hlavy.

## Ověření

- 90 testů / 7 souborů. Dávkový přenos, obsahový klíč, opakování, přerušení, chybné potvrzení a resume indexy. Skutečná metoda `storageService.getTrades` načetla 2 400 testovacích řádků přes cap 73 a zachovala řazení; změna generace během root čtení odmítla výsledek před cache. Dále regrese backtest review/private notes, owner exportu, journal fact hydration a synchronizace připojení.
- Izolovaný PGlite se skutečnými třemi migracemi: 200 různých flat-to-flat epizod na každém z 12 účtů (2 400 pozic, více než původní mez 2 000), skutečný serverový raw import, 24 zápisových dávek a skutečné owner čtení/hydrace po stránkách s capem 73. Vynucené přerušení po první dávce nezměnilo viditelnou historii; opakování přeskočilo první potvrzenou dávku. Chybný payload, nedokončený run, jiný vlastník a změněné přiřazení byly odmítnuty. Finální neplatný člen vrátil zpět předchozí změny. Pozdní fee korekce prošla stejným přerušením a zachovala review. Výsledky 12 účtů odpovídají 200 vlastním obchodům a poplatkům.
- Scoped TypeScript, ESLint bez chyb (jeden starší warning ve storage), Vite/PWA build 3 483 modulů / 89 precache. U testů je starší warning chybějící TypeScript sourcemapy ve sdílených závislostech.
- Rozšířený SQL průchod zachoval na všech 12 účtech tři brokerem potvrzené SL události s časy 1200/1400/1600 ms a cenami 20000/20000.25/20000.5, včetně opakovaného importu po opravě fee. Jeden běh skončil nativním V8/WebAssembly pádem `Check failed: end > addr` před výsledky; samostatné opakování stejného konečného testu bez změny aplikačního kódu prošlo. Diff check bez chyb.

Podklady: [Supabase databázové funkce](https://supabase.com/docs/guides/database/functions), [explicitní přístupová práva pro nově vytvořené tabulky](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) a [čtení dat s omezením odpovědi](https://supabase.com/docs/reference/javascript/select). Byl zkontrolován aktuální changelog. Vzdálené advisors neproběhly, protože žádná vzdálená změna nebyla provedena; zůstávají součástí budoucího schváleného nasazení se zálohou.

## Co tím ještě není hotové

Dávkový a obnovitelný je **přenos hotové projekce**, nikoli její výpočet. Při změně evidence server stále znovu čte celý pevný snímek; limity 100 000 událostí / 32 MB zůstávají. Finální SQL transakce skládá úplnou projekci v paměti a musí se vejít do databázového časového/memory limitu. Extrémně velká jednotlivá pozice se odmítne, její historie se neořeže. Kořenová čtečka má explicitní limit 100 000 řádků bez částečného výsledku. Výkon a timeouty přihlášeného PostgREST/Vercel toku nejsou lokálním PGlite důkazem ověřené.

Skutečné inkrementální zpracování/partitioning raw evidence tak stále zbývá. Dále obecný backfill a přehled pokrytí, velké seznamy broker API, automatické screenshoty nových záznamů, geometrie position boxu přes mezery, nonpublic social projekce, raw-to-UI a přihlášený E2E. Tato fáze neprovádí grafickou úpravu; poslední UI důkaz zůstává fiktivní preview fáze 12. Celý cíl je stále aktivní.
