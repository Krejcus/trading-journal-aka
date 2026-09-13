# Copier relay: oprava doručování a čekání (13. 9. 2026)

Stav: implementováno a ověřeno lokálně v izolovaném worktree z produkčního commitu `5b2265f2`. Web, vzdálená databáze a instalovaný Mac worker touto prací změněny nebyly. Žádný živý ARM/DISARM, Flatten ani jiný brokerový příkaz nebyl pro testování použit.

## Důvod

Původní worker čekal v jednom požadavku na heartbeat, převzetí příkazu a případnou práci s notifikacemi/snímky. Pokud server příkaz označil jako `claimed`, ale odpověď se ztratila, další poll jej už nevrátil. Podobná mezera byla mezi provedením a potvrzením. Historie navíc zahazovala serverové `unchanged` a znovu načítala celou historii; realtime debounce dovoloval souběžné dlouhé čtení.

Předchozí měření zaznamenalo nedělní DISARM vytvořený v 15:06:58 CEST, převzatý po 16,137 s, bez potvrzení a bez odpovídajícího záznamu o provedení v logu workeru. Samotná lokální odezva workeru měla medián 3,50 ms. To ukazuje na cestu předávání, nikoli na samotné lokální přepnutí. Produkční historie a síťové výpadky mohly zvýšit zátěž; měření neprokázalo, že nový journal byl jedinou příčinou.

## Provedené změny

- **Řízení:** `poll-v2` autentizuje zařízení a atomicky vrací příkaz. Nečeká na heartbeat, ledger, APNs, Live Activity ani snímky. Realtime kick zůstává optimalizace, pravidelný poll záloha.
- **Obnova doručení:** náhodné `delivery_id` se před prvním požadavkem ukládá na disk. RPC vrací při opakování stejného doručení stejný řádek. Unikátní index a transakční zámek zařízení brání dvojímu přidělení tohoto ID. Původní `claimed` bez delivery ID se nikdy automaticky neobnovují ani neposílají znovu.
- **Obnova potvrzení:** worker před provedením zapíše `executing` a po něm `completed` s výsledkem. Retry opakuje doručení/ACK, nikoli obchodní akci. Ztracený ACK lze dohledat jako terminální řádek. Selhání zápisu po provedení nesmí vrátit stav v paměti zpět na `polling`.
- **Restart/expirace:** původní TTL 30 s se neprodlužuje a kontroluje se znovu po zápisu na disk. Starší požadavek než start relay session a obnovený checkpoint z minulé session se neprovedou. Neověřený výsledek zůstane explicitní; starý ARM se neobnovuje. Samotné zapnutí nadále prochází existujícími kontrolami runtime a brokera.
- **Stav:** rychlý heartbeat běží samostatně, každé 2 s po dokončení předchozího, s timeoutem 3 s. Revision a `startedAt` zabrání přepsání novějšího stavu starší odpovědí; completion zapisuje výsledek i stav v jedné transakci. Opožděné první potvrzení z již nahrazeného workeru se odmítne.
- **Pozadí:** ledger, notifikace a snímky mají samostatný omezený request. ARM/DISARM notifikace navazují na potvrzený výsledek; při rychlém střídání se vybírá poslední potvrzený stav odpovídající snapshotu. Watchdog zůstává záloha. Nejde o garanci okamžitého doručení APNs.
- **Historie:** první ověřené načtení zůstává. Stejný potvrzený `unchanged` už další úplné načtení nespouští. Změna účtů, revize, realtime invalidace či přihlášeného uživatele čtení obnoví; selhání načtení nepřidá platný receipt. Realtime čtení probíhá nejvýše jedno současně s jedním navazujícím čtením při změnách za běhu. Širokou finanční projekci ani pravidla viditelnosti obchodů oprava neoslabuje.
- **Chybové okno:** při neověřeném zapnutí/vypnutí už netvrdí, že žádný příkaz nebyl odeslán. Jednoznačné blokace před odesláním mají původní text. Barvy, komponenty a rozvržení zůstávají z aplikace.
- **Diagnostika:** log obsahuje ID příkazu, čekání ve frontě, dobu provedení a dobu ACK, bez tokenů a obsahu obchodů.

## Ověření a naměřený rozsah

- Celá sada před posledními dvěma doplňkovými testy: 3541 testů. V sandboxu prošlo 3495; zbývajících 46 potřebovalo lokální testovací port a následně prošlo mimo sandbox. Poslední cílená sada včetně dalších dvou ochran: 82/82. Celkem pokryto 3543 testů.
- TypeScript, webový produkční build, lokální sestavení workeru a kontrola syntaxe jeho bundlu prošly. Worker bundle nebyl spuštěn ani instalován.
- SQL migrace spuštěna v izolovaném PGlite 0.5.8: 20 kontrol doručování, idempotence, starých příkazů, pořadí stavů a práv rolí prošlo. PGlite je jednosession engine; test není důkazem chování produkčního Postgresu při více souběžných spojeních. Před aktivací patří ověřit stejnou migraci a advisory na cílové databázi.
- Kontrola změněného kódu: lint bez chyb; starší warningy v UI zůstávají.

Offline benchmark používá skutečnou implementaci relay a atomické zápisy/fsync, fiktivní server s **umělou 60ms odezvou** a fiktivní 15ms provedení. Nejde o měření produkčního kliknutí v prohlížeči.

| Scénář | Výsledek |
|---|---|
| Běžná odpověď, 12 vzorků | medián potvrzení 163 ms, maximum 176 ms |
| Zdržení pozadí 11 s | potvrzení 159 ms, jedno provedení |
| Ztracená odpověď po převzetí | dohledání stejného doručení a potvrzení za 3670 ms, jedno provedení |
| Ztracená odpověď po potvrzení | dohledání terminálního výsledku za 3671 ms, jedno provedení |
| Původní implementace, předchozí offline reprodukce | po 11,5 s stále `claimed`, žádné provedení |

Dalších 20 stejných importních odpovědí po prvním načtení v testu způsobilo **0 dalších úplných čtení historie**, místo původních 20. Tento výsledek nevyjadřuje procentuální úsporu celkové produkční zátěže.

Reprodukce lokálně:

```sh
npm run typecheck
npm test -- --run --maxWorkers=2 --testTimeout=15000 --hookTimeout=15000
npm run build
node --import tsx scripts/verify-copier-relay-delivery.ts /path/to/isolated-pglite-dependencies
node --import tsx scripts/measure-copier-relay-delivery.ts
```

## Pořadí aktivace po souhlasu

1. Zvlášť exportovat/zálohovat vzdálené schéma a dotčené tabulky příkazů/stavů. Ověřit aktuální revizi main, pracovní změny a nasazení; nepřepsat cizí práci.
2. Aplikovat pouze migraci `20260913154140_copier_relay_recoverable_delivery.sql`, ověřit funkce, práva, security/performance advisory. Nevkládat testovací příkazy pro živé zařízení a neopakovat staré neověřené příkazy.
3. Nasadit web/API a ověřit přesný commit a Vercel READY. Stará v1 cesta zůstává kompatibilní se starým workerem, její původní slabiny ale opraví až nový worker.
4. Před samostatně schválenou aktualizací Mac workeru ověřit aktuální DISARMED, flat, žádné pracovní příkazy/divergence/stuck outbox a stav spojení; porovnat hash nainstalovaného bundlu. Po restartu zopakovat čtení stavu. Nový worker vyžaduje v2, automatický fallback na v1 nemá.
5. Skutečné ON/OFF měřit až při schváleném přepnutí v bezpečném stavu. Porovnat vytvoření/převzetí/dokončení DB, nové logy a čas zobrazení v prohlížeči. Laboratorní latence není slíbená produkční odezva.

Rollback: v2 migrace je přídavná a může zůstat. Nevracet API na verzi bez v2, dokud běží v2 worker. Checkpointy ani staré neověřené řádky při rollbacku nemazat. Změna transportu neřeší uspání/vypnutí Macu ani výpadek internetového/brokerového spojení.
