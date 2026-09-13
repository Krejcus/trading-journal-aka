# Fáze 19 — obecný historický sběr a omezené dávky

Lokální implementace; žádná komunikace s přihlášeným brokerem, instalace workeru, vzdálená migrace ani nasazení.

## Chování

Dosavadní dva účetní seznamy rozšiřuje pasivní průchod o order, fill, orderVersion, command, commandReport a executionReport. Doplní také názvy přesně známých contract ID a cashBalanceLog podle známých account ID. Sdílí již existující spojení a běží až po snímku pozic. Nezakládá sockety na jednotlivé účty, nevkládá načtené analytické položky do execution cache a neposílá obchodní příkazy.

Průchod má původní společný 20s deadline a jeden pokus na každý zdroj. Před čekáním na HTTP se posune pořadí zdrojů, takže další pětiminutový průchod po timeoutu začne u dalšího zdroje. Zdroj, který odmítne přístup, neblokuje ostatní; skutečný rate limit zastaví průchod a zachová společný breaker. Reconnect a odpojení posledního observera ruší požadavky a resetují dočasný plán. Trading fronta nečeká na diskové ACK této analytiky.

Zůstává kontrola celého seznamu před prvním zápisem, limit 4 MiB při čtení těla a 10 000 položek. Příliš velký zdroj se od dalšího průchodu čte přes doložené rodičovské vazby: fees → fills, pairs → positions, orders → accounts, versions/fills/commands → orders, reports → commands. Jedna dávka má nejvýše 100 známých rodičů, další průchod pokračuje dalšími ID a po projetí se cyklus opakuje kvůli opravám. Nejde o vymyšlené stránkování /list ani o generování ID. Odpověď musí odpovídat vybraným rodičům. Contract používá items; cashBalanceLog nemá list v použitých podkladech a používá doložené account ldeps.

Dedup a stream revision/tombstone guard se rozšířily na tyto entity. Celková analytická cache má nyní limit 100 000 sanitizovaných položek pro více zdrojů (dříve 20 000 pro účetnictví). Překročení nadále zneplatní probíhající snapshot místo přijetí potenciálně staré odpovědi. Jde o optimalizaci, ne trvalé úložiště: zdrojem pravdy zůstává append-only evidence.

Metadata journalbackfill nově uvádějí available-list / known-parents, počet vyžádaných rodičů a počet ještě neprojetých známých rodičů. Observed potvrzuje zpracování konkrétní odpovědi, nikoliv kompletní historickou retenci nebo úplnost účtu. Žádný známý rodič znamená nedostupný omezený zdroj, nikoli prázdnou historii. Chybějící položka nic nemaže a neuzavírá gap. Cena orderVersion stále nestačí k potvrzení ochrany; musí existovat odpovídající command a execution report. Broker timestamp reportu se zachovává v milisekundách.

## Podklady

Doložené GETy: [Order Version List](https://partner.tradovate.com/api/rest-api-endpoints/orders/order-version-list), [Command List](https://partner.tradovate.com/api/rest-api-endpoints/orders/command-list), [Execution Report List](https://partner.tradovate.com/api/rest-api-endpoints/orders/execution-report-list). Přesné rodičovské dávky popisují [Fill Fee L Dependents](https://partner.tradovate.com/api/rest-api-endpoints/orders/fill-fee-l-dependents), [Order Version L Dependents](https://partner.tradovate.com/api/rest-api-endpoints/orders/order-version-l-dependents) a [Cash Balance Log L Dependents](https://partner.tradovate.com/api/rest-api-endpoints/accounting/cash-balance-log-l-dependents). Ostatní vazby a GETy jsou v [oficiálním API katalogu](https://api.tradovate.com/).

Dokumentace nedokládá neomezenou retenci konkrétního OAuth spojení. Proto absence starší změny neznamená, že k ní nedošlo. Výpis účtů pouze dodává známé rodiče, nevytváří historický důkaz nulové pozice.

## Ověření

96 testů v 15 souborech prošlo. Zahrnují tři historické SL změny během jedné minuty a skutečné broker timestamps, čekající a rozporná potvrzení, 12 vlastních účetních výsledků, dedup, souběh stream/HTTP/disk ACK, tombstones, celé a chybné seznamy, 205 rodičů v dávkách 100/100/5, scoped parent validation, oversized fee list → známé fill IDs, scope metadata, abort/deadline, rate limiter, reconnect/renewal a regresi diskového evidence store/uploadu. Broker simulation dodává historii až po initial sync, aby test odděloval nové analytické čtení od legitimního úvodního execution snapshotu. První verze testu toto nerozlišovala a správný dedup proto vyhodnotila jako chybu; konečný test prošel.

Scoped TypeScript a ESLint prošly bez chyb; Vite/PWA build prošel (89 precache entries), diff check čistý. SQL a UI se touto fází neměnily; předchozí databázové a browser důkazy zůstávají ve fázi 18. Mockované GETy nejsou produkční OAuth/DEMO conformance.

## Zbývá

Přehled dostupnosti jednotlivých zdrojů se zatím uživatelsky nezobrazuje. Metadata existují v raw evidence; nelze je přebrat z finanční kompakce, která je používá pouze jako watermark. Je potřeba samostatné owner čtení posledního stavu jednotlivých zdrojů.

Ani omezené dávky negarantují získání všech starých obchodů: pracují jen se známými rodiči a stále platí limit jedné odpovědi. Příliš velkou historii jediného rodiče nelze bez doloženého dalšího endpointu potichu oříznout. Cache a parent cursor se neobnovují napříč restartem procesu; po restartu znovu objevují dostupné zdroje, uložená raw evidence zůstává. Automatická rekonstrukce nezaznamenaných období ani Reporting API backfill nejsou touto fází tvrzené.

Celkově dále zbývá dostupnost/pokrytí v UI, velká finanční projekce, position-box mezery, statistické R a nonpublic social projekce, raw-to-UI/authenticated E2E a závěrečný audit. Nasazení, záloha, vzdálené advisors a worker/broker ověření potřebují samostatnou autorizaci. Cíl zůstává aktivní.
