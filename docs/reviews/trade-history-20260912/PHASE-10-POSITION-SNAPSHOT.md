# Fáze 10 — úplný počáteční snapshot pozic

Lokální stav 12. 9. 2026, bez nasazení nebo broker příkazů.

## Implementace

- Po dokončení socket synchronizace a dále po pěti minutách při aktivním evidence observeru proběhne vlastní čerstvý GET account/list a position/list. Žádný dotaz na každý účet zvlášť; 12 účtů sdílí dva požadavky. Pozice se nenačítají přes starý in-flight cache požadavek, protože by jeho začátek neležel ve zdokumentovaném časovém okně.
- Capture je asynchronní, mimo execution frontu a execution cache. Má 20s deadline, jeden běžící požadavek, zrušení při zavření socketu/odhlášení posledního observera a kontrolu stejného socketu před přijetím odpovědi. Observer sám nezakládá ani neudržuje socket. Selhání přístupu se zaznamená jako nedostupný snapshot; nevydává žádné příkazy a samo neshazuje připojení. Existující rate-limit breaker se při reálném rate limitu zachovává.
- Nová allowlist evidence `positionsnapshot` ukládá čísla účtů/instrumentů/netPos, snapshotId, startedAt/completedAt a počet pozic pro každý výslovně viditelný účet. Neobsahuje názvy ani profilová/autorizační data. Samostatná dokončovací položka musí odpovídat všem řádkům daného účtu. Prázdný kompletní seznam tohoto účtu může stanovit net=0 i pro instrument, který se objeví až v následujícím obchodu.
- Episode builder používá tento důkaz až od okamžiku dokončení. Chybějící/duplicitní řádek, chybějící completion, rozpor časových mezí, jiné session/connection, výpadek v průběhu načítání nebo fill/stream změna pozice v daném okně anchor zneplatní. Kontroluje i broker čas pozdě doručeného fillu. Záznam přijatý během okna se konzervativně bere jako možná změna; hraniční milisekundová shoda může znamenat vynechání anchoru a čekání na další snapshot/flat událost, nikdy domyšlení ploché pozice.
- Původní zkratka, která z jednotlivé REST/handshake Position položky vytvářela anchor bez znalosti okna požadavku, je odstraněna. Metadata položky se zachovají, stav ale musí doložit stream nebo nový úplný snapshot.
- Účty mimo doloženou roster nedostávají nulovou pozici. Neplatný/chybový REST výsledek není prázdný úspěšný seznam. Běžný broker props payload nemůže podstrčit interní positionsnapshot typ.
- Schema migraci tato fáze nepotřebuje: tabulka ukládá textový entity type a celé immutable allowlist evidence; nový typ prochází stejnou API hash/identity validací.

## Zdroj kontraktu

[Tradovate Position List](https://partner.tradovate.com/api/rest-api-endpoints/positions/position-list) dokumentuje kompletní seznam Position entit s accountId, contractId a netPos; id může být nepřítomné. Snapshot witness jej proto nepotřebuje. [Oficiální API reference](https://api.tradovate.com/) uvádí account/list jako seznam Account entit. Návrh nepovažuje úvodní WebSocket ACK nebo libovolný chybějící seznam za úplný snapshot.

## Ověření

- 60 testů / 10 souborů: snapshot parser/anchor, pozice/realizace, observer, reconnect/renewal, evidence projekce, durable store, account mapping, server import a wire allowlist.
- Ověřeno prázdné počáteční konto → entry/exit → vlastní net P&L; odmítnutí zpětného použití snapshotu; chybějící řádky, pozdní plnění, spojení/session, HTTP 403, zrušení rozpracovaného čtení a přesně dva GETy pro 12 účtů.
- Snapshot prošel durable JSONL → upload batch → skutečná API hash validace → anchor rekonstrukce.
- Isolovaný SQL/server/owner-read harness nyní místo syntetických jednotlivých flat Position událostí používá nový kompletní prázdný snapshot pro všech 12 účtů. Prošel import, pending poplatky → potvrzené výsledky, opravy, zachování review, RLS, stale revize, rollback i tombstone; přesná legacy adopce také prošla.
- Scoped TypeScript/ESLint a Vite/PWA build prošly (3 481 modulů, 89 precache). Broker část je testovaná fiktivním transportem; nebyla spuštěna proti přihlášenému Tradovate.

## Pokračování

Úplný počáteční snapshot pro budoucí obchody je tímto lokálně implementovaný. Není to backfill starších obchodů nebo historie chybějící za výpadku. Další nutné kroky: analytický backfill/pokrytí, zpracování dlouhé historie bez plného snímku na každém importu, review-only editace broker faktů, přesné screenshot linkage, position-box mezery mezi svíčkami, raw-to-UI a přihlášený E2E. Samostatně schválené doručení do produkce stále čeká. Celá funkce není hotová.
