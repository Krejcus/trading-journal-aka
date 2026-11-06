# LIVE: posun limitu a fronta brokerových událostí — 6. 11. 2026

> **Oprava po oponentuře:** tvrzení níže „SL/TP na původních cenách“ a „SL/TP beze změny“ neplatí. Broker nohy OSO při Modify vstupu posouvá; platný stav je v `INV-MANUAL-LIMIT-01`. Web, worker a iPhone byly nasazeny z `6bf590a1`.

Stav: uživatel následně výslovně schválil „v tom případě to nasaď a změř“. Databázová migrace aplikována 6. 11. 2026 13:23 UTC po exportu původní funkce. Web, worker a iPhone čekají na dokončení release ověření; živé měření PO změně ještě neproběhlo.
Pracovní větev `codex/live-command-speed-on-main`, izolovaný checkout `/private/tmp/alphatrade-speed-20261106`, základ `1986b1a6`, ověřený na vzdáleném main. Claudův51851a14 byl dočasně integračně otestovaný, ale není na main a není součástí tohoto vydání. Kanonický Documents checkout se nepřepisuje.

## Výchozí měření

Pouze DEMO8661118, 1 MNQZ6. Stopy aplikace click→paint v aktivní kartě; nejsou optickým měřením displeje. Každá položka je jeden vzorek, nikoli medián či p95.

| Akce | Fyzický iPhone, ms | PC Safari, ms |
|---|---:|---:|
| Limit | 640 | 764 |
| Cancel | 1328 | 620 |
| Market → pozice | 1118 | 902 |
| SL | 683 | 543 |
| TP | 548 | 652 |
| Close → graf | 1295 | 1442 |
| Close → výsledek | 1928 | 1834 |

Nejde o párované A/B: jiný čas trhu, PC bez TV snímkování, telefon se snímky; PC Market byl OSO se SL/TP, telefon holý Market a pozdější samostatné attach. Phone attach začal 5011 ms po Market kliknutí, jeho vlastní click→paint bylo1247 ms. Nezaměňovat za pětisekundovou brokerovou latenci. PC web po reloadu změnil bundle; zdroj obou webových verzí je třeba před porovnáním znovu sjednotit.

PC broker Market zápis148 ms, Fill čekal v semantic frontě311 ms. To lokalizuje čekání, neprokazuje, že jedna oprava odstraní všech311 ms. Jednorázové výsledky nepodporují slib150–250 ms end-to-end.

## Lokální změny

1. Samostatné ACK odpovědi WebSocket zápisů už nespotřebují pořadové číslo obchodní fronty. Dříve tím vznikla díra mezi Order a následujícím OrderVersion a čekalo se na REST, i když data ze streamu byla dostupná. Korelace ACK, pořadí skutečných událostí, watchdog a execution cache se nemění. Test s nerozhodnutým REST před opravou selhal; po opravě se Order zpracuje bez REST odpovědi. Varianta s intervenující skutečnou Order událostí zůstává blokovaná.
2. `move-limit`: jediný Modify vlastního nevyplněného MNQ Limit ID, stejné množství, SL/TP na původních cenách. Jen manual-only local-only DEMO bez followerů s opt-inem pending-legs. Capability `manual-order-move-limit-v1` brání nabízení starému workeru.
3. Worker kontroluje čerstvou kotaci stejného kontraktu, odstup8 ticků mimo trh, flat účet, tvar obou ochranných nohou, očekávanou cenu/množství a riziko. Po durable sending opakuje brány, kotaci, stav rodiče/nohou a riziko. Neznámý výsledek se neposílá znovu. Posun se neprovádí zrušením a novým vstupem.
4. Telefon i PC používají stávající společnou cestu a zámek. V telefonním overlayi nejdřív výběr a potom tah. Cena měnící se během tahu, nepodporovaný worker a pozice jsou blokované. Pokud při posunu přijde fill, skutečná cena pozice má přednost před čekajícím návrhem.
5. Brzdová funkce i fallback relaye zahrnou novou akci. Migrace `20261106132322_copier_move_limit_brake.sql` zachovává zámek, práva, limity a výběr uživatele; rozšiřuje pouze seznam supersedovaných akcí.

## Ověření

- Základní dotčené sady102/102; po dodatečných kontrolách worker/relay/stream106/106; UI finální48/48.
- Skutečný dočasný Postgres18:26/26 včetně souběžných transakcí, práv a supersede move-limit. Cluster zastaven.
- Skutečná telefonní komponenta s reálným overlayem v lokálním browseru (390px plocha, syntetický zdroj cen a fake manage): vybrat/táhnout29500→29498, právě1 volání, SL29480/TP29560 beze změny; po vypnutí capability čára netáhnutelná. Není to fyzický iPhone ani brokerová konformance.
- Finální vydávaný základ1986b1a6 s tímto balíkem:7903 testů prošlo,1todo,745 souborů prošlo a1 přeskočený. Během přípravy test odhalil chybějící capability v memo porovnání wrapperu; opraveno a celá sada znovu zelená. Dočasná integrace Claudovy nepublikované větve není součástí vydání.
- Finální TypeScript i web build prošly. Sestaveny všechny3 worker bundly (pilot, cenové vlákno, hlídač cen); nejsou nainstalované. Nativní iOS sestavení/instalace zatím neproběhly.

## Produkční brána a následné měření

- Z produkce přečtena pouze definice a práva `enqueue_tradovate_copier_brake`; tělo odpovídá původní migraci. Samostatný export `/private/tmp/at-speed-brake-backup-20261106.sql` obsahuje návratovou definici a grants. Nejde o kompletní zálohu dat.
- Před nasazením: ověřit finální diff, čistý release, aktuální produkční základ a čerstvý status DEMO/flat/no orders/OFF. Novější souhlas zahrnuje databázi, web, worker a iPhone. Záloha původní DB funkce: /private/tmp/at-speed-brake-backup-20261106.sql. Po migraci ověřeno move-limit=true, EXECUTE pouze service_role a owner; anon/authenticated=false. Security/performance advisors bez nálezu k upravené funkci; ostatní hlášení mimo rozsah.
- Pořadí: migrace+advisory → worker s nezměněnými účty a bránami → web/nativní bundle. Ověřit SHA instalací a capability, bez automatického ARM mimo schválené DEMO testy.
- Stejné scénáře na obou zařízeních: vložit Limit mimo trh, posunout existující Limit o tick/několik ticků, zrušit; Market s oběma ochrannými příkazy už při zadání, posun SL, posun TP, close. Stejný kontrakt,1kus, foreground, stejné snímkování, stejná síť telefonu, klidný Mac bez buildu. Každou stopu spojit přes operationId s brokerem a ověřit skutečná ID/ceny/nohy. Nakonec flat/no orders/OFF.
- Fyzický iPhone zatím nejde dálkově ovládat; následné klepání provede uživatel, logy lze odečíst. Úzké desktopové okno není měření telefonu.
