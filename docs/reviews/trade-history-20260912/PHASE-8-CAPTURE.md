# Fáze 8 — pasivní zachycení WebSocket evidence

Lokální stav 12. 9. 2026. Produkční worker ani databáze nebyly změněny.

## Změna

- `user/syncrequest` výslovně odebírá také `orderVersion`, `fillFee`, `fillPair` a `cashBalanceLog`. Jeden socket na připojení, žádný další socket na účet. Observer sám spojení nezakládá ani neudržuje.
- SockJS zpráva se parsuje jednou při příjmu. Evidence se zachytí před frontou asynchronního zpracování objednávek a načítáním metadat. Každá zpráva má skutečný čas příjmu; více položek v jednom rámci zachovává pořadí záznamu. Broker timestamp zůstává samostatně v allowlistu.
- Nový `journalSocketEvidence` přijímá jednotlivé/batch props, dřívější snapshot pole a úvodní objekt pojmenovaných kolekcí. Z neznámých polí, účtových profilů, chybových odpovědí nebo penalty ticketu nic nevyrábí. Broker payload nemůže podstrčit interní `connection` nebo `copylink`.
- Rozšířený odběr `orderVersion` je analytický. Tyto samostatné požadavky neaktualizují execution cache a nevydávají objednávku s nepotvrzenou novou cenou. Původní větev, která to dělala, byla odstraněna. Další order/executionReport a REST cesty zůstávají; jejich celková shoda s brokerem stále vyžaduje samostatný DEMO conformance test. Zelené lokální regrese jej nenahrazují.
- Starý nebo zavíraný socket nesmí po dokončení pomalého baseline načtení označit journal jako synchronizovaný; staré čekající autorizační pokračování nesmí odeslat token novému socketu.

## Zdroje a meze důkazu

[Oficiální user/syncrequest](https://partner.tradovate.com/overview/core-concepts/web-sockets/user-syncrequest) vyžaduje explicitní entityTypes; filtrované typy určují úvodní data i další aktualizace. Neznámé názvy nejsou odmítnuty chybou.

[Oficiální příklad úvodního objektu](https://github.com/tradovate/example-api-faq/blob/main/example-code/user-sync-request/src/index.js) uvádí mimo jiné orderVersions, commands, executionReports, fillPairs, fills a positions. Příklad je starší; použita je jeho struktura dat, nikoli zastaralý způsob přihlášení pomocí users.

Přidání správných názvů není důkaz dostupnosti poplatků nebo úplné historie na konkrétním OAuth oprávnění. Chybějící entity zůstávají neznámé. Kolekce fillFees/cashBalanceLogs jsou přijaty, pokud skutečně dorazí; nejsou považovány za zaručenou součást úvodního snímku. Žádný prázdný seznam ani i=1 ACK nevytváří důkaz flat pozice nebo historického pokrytí.

## Ověření

- 42 testů / 9 souborů prošlo: journal observer/normalizer/projection a broker reconnect, renewal, request dedupe, risk, liquidate a rate limiter.
- Regrese obsahují skutečně blokovaný REST metadata požadavek, okamžitý záznam více verzí, sanitizaci a selhávajícího observera, snapshot objekt, uzavření během baseline a již načtenou objednávku, jejíž potvrzená cena se po příchodu požadované verze nesmí změnit.
- Scoped TypeScript a ESLint prošly. Vite/PWA build prošel: 3 476 modulů a 87 precache položek; známé varování o velkých chunkech.
- Bez přihlášeného Tradovate testu, bez broker příkazů a bez nasazení.

## Pokračování

Explicitní kompletní počáteční snapshot pozic pro dosud neviděné instrumenty, analytický backfill a obnova po výpadku stále chybí. Prázdný dnešní snapshot nesmí rekonstruovat minulou flat pozici. Další otevřené položky z fáze 7 platí: LIVE obchodní karta, dlouhá historie, screenshot linkage, chart fallback a mezery ve svíčkách, raw-to-UI a přihlášený E2E. Celá funkce není hotová.
