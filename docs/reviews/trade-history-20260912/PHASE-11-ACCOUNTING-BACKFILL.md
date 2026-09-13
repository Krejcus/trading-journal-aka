# Fáze 11 — doplnění poplatků a spárovaných plnění

Lokální implementace 12. 9. 2026 v izolovaném worktree. Žádná komunikace s přihlášeným brokerem, deploy, migrace nebo změna workeru.

## Chování

- Po počátečním snímku pozic a při následném pětiminutovém průchodu se čtou `fillFee/list` a `fillPair/list`. Dva další GETy platí pro celé spojení, včetně 12+ účtů. Jeden průchod sdílí 20s deadline, běží pouze s evidence observerem a už připojeným execution socketem. Nepoužívá execution cache a jeho dokončení neblokuje trading události.
- Odmítnutí pozic/fees HTTP 403 nezablokuje dostupný druhý zdroj; skutečný rate limit zachovává společný breaker a zastaví další požadavky. Rate-limit status se vyhodnotí před načítáním těla odpovědi. Čtení je zrušitelné při zavření socketu/odhlášení posledního observera.
- Používají se pouze doložené ID položek a stávající allowlist. Celý seznam musí projít validací, duplicitní ID se odmítnou. Limit každé odpovědi je 4 MiB během čtení i bez Content-Length a 10 000 položek. Velká nebo neplatná odpověď se označí jako nedostupná, není potichu oříznutá.
- Cache nanejvýš 20 000 sanitizovaných stavů potlačuje stejné opakované snapshoty, ale uchová změněné částky/aktivitu. Chybějící položka v seznamu nic nemaže; prázdná odpověď neznamená nulové poplatky. Každý účet nadále čerpá vlastní fills, fees a pairs; nepoužívají se násobky leadera.
- Monotónní interní revize brání přepsání události, která dorazila během REST čtení, včetně shodné milisekundy. Revalidace probíhá i před každým zápisem, protože stream může přijít během čekání na disk. Při vyhození cache položky se rozpracované čtení konzervativně odmítne; při reconnectu a neúspěšném/nejistém zápisu se cache resetuje.
- Observer nyní může vrátit asynchronní potvrzení zápisu. Místní recorder vrací skutečný výsledek append+datasync. Backfill jej čeká po jednotlivých položkách, aby se nezahltila fronta; synchronní doručení běžných stream událostí pokračuje bez čekání. Chyba listenera/promise neproniká do controlleru. Deadline ukončí průchod i při neodpovídajícím potvrzení; nepotvrzené položky se mohou zopakovat. Totéž ID evidence z uploadu nadále řeší existující idempotentní ukládání.
- `journalbackfill` zaznamená typ zdroje, okno čtení, scanned/recorded/contended nebo sanitizovaný důvod nedostupnosti. `observed` označuje jen zpracovanou odpověď, není potvrzením úplné historické retence, splacených poplatků ani opraveného výpadku. Tento interní typ nelze podstrčit přes broker socket a nevstupuje jako finanční entita do projekce.
- Odstraněný FillFee nyní zneplatní známé poplatky místo zachování staré částky po Deleted události. Opravu doloží další relevantní broker evidence; backfill sám neobnovuje známý tombstone.

## Ověřený kontrakt

[Tradovate Fill Fee List](https://partner.tradovate.com/api/rest-api-endpoints/orders/fill-fee-list) a [Fill Pair List](https://partner.tradovate.com/api/rest-api-endpoints/positions/fill-pair-list) dokumentují oba connection-wide GETy. Dokumentace nedokládá, že konkrétní OAuth scope zpřístupní všechny historické záznamy bez časového omezení. Tyto předpoklady proto implementace nedělá.

## Ověření a hranice

- Cílené testy zahrnují 12 účtů bez fees/pairs → doplnění → 12 vlastních výsledků; dedup a pozdější opravu; souběh s REST i čekáním na disk; Deleted fee; prázdná/chybová odpověď bez vymyšleného P&L či opravy gapu; 403; 429; abort, deadline a zopakování nepotvrzeného zápisu; limity odpovědi a cache.
- Zahrnuté jsou stávající regrese snapshotů, episode builderu, socketu/reconnectu/renewal/rate-limit breakeru, diskového úložiště, account mappingu a server importu. Scoped TypeScript/ESLint a aplikace se ověřují lokálně. Aktuální počty jsou v předávacím checkpointu.
- Čtení backendu/SQL schéma se touto fází nemění. Předchozí SQL/server/owner-read harness z fáze 10 zůstává samostatným důkazem, nebyl v této fázi znovu spuštěn. Mockované HTTP testy nejsou OAuth/DEMO/LIVE conformance.
- Nová metadata jsou dostupná v surové evidenci; uživatelský přehled dostupnosti jednotlivých doplňovaných zdrojů zatím není propojený. Potvrzené účetní hodnoty se ale běžnou projekcí projeví až po doručení jejich skutečných položek.

## Zbývá

Tato fáze doplňuje účetnictví, ne obecný backfill všech order/command/execution reportů nebo historických výpadků. Stále je nutné vyřešit dlouhou historii (server dnes znovu čte celý omezený snímek), velké API seznamy cílenými dávkami, review-only editaci broker faktů, automatické screenshot linkage nových importů, position-box mezery, nonpublic social projekci, raw-to-UI a přihlášený E2E. Celá práce zůstává rozpracovaná; produkční doručení vyžaduje samostatně schválený postup.
