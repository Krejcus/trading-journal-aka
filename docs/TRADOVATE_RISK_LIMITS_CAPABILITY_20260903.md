# Tradovate risk limits — OAuth capability probe (2026-09-03)

## Verdikt

**Z dostupných dat nelze tvrdit write právo k risk limitům.** Fáze 1 prokázala,
že oba uložené OAuth tokeny umějí číst účty, `AccountRiskStatus`,
`UserAccountAutoLiq`, trading permissions, plug-in metadata a market-data
subscription metadata. Neproběhl žádný write endpoint, order/position request,
ARM, DISARM, Flatten, worker command ani přímý DB zápis.

`Approved` v `tradingPermission/list` je oprávnění obchodovat daný účet; není to
důkaz oprávnění měnit risk konfiguraci. Stejně tak HTTP 200 na čtecím endpointu
nedokazuje autorizaci k odpovídajícímu POST endpointu.

## Metoda a bezpečnostní hranice

- Běh: 2026-09-03 15:49:36 UTC, Tradovate DEMO, dvě uložená OAuth připojení.
- Skript: `scripts/copier/riskLimitAccessProbe.ts`.
- `--dry-run` odeslal 0 requestů. Skutečný běh vyžadoval explicitní
  `--confirm-read-only`.
- Všechny broker requesty byly sekvenční `GET` s 250ms pauzou a timeoutem.
- Jediný request helper nejdřív kontroluje přesný allowlist cesty a query;
  `/create`, `/update`, `/delete`, `/item`, order a position cesty odmítne před
  `fetch`. Unit test výslovně ověřuje odmítnutí
  `/userAccountAutoLiq/update` bez zavolání transportu.
- Token byl získán přes stejnou spárovanou Mac device lease cestu jako existující
  quote probe. Token, e-mail, celé jméno ani kontaktní pole se nelogují; odpovědi
  se před výpisem redukují na field allowlist.
- `/auth/me` je oficiální GET pro ověření volajícího tokenu; oba tokeny vrátily
  HTTP 200. Citlivá identita byla z výstupu úmyslně odstraněna. [Tradovate: First
  API Call](https://partner.tradovate.com/overview/quick-setup/first-api-call)

## Výsledek per firma a účet

`changesLocked = nezjištěno` znamená, že volitelný atribut v broker JSON vůbec
nebyl přítomen. Nesmí se interpretovat jako `false`. Tradovate jej v kontraktu
`UserAccountAutoLiq` popisuje jako volitelný boolean. [Tradovate:
UserAccountAutoLiq/list](https://partner.tradovate.com/api/rest-api-endpoints/risks/user-account-auto-liq-list)

| Firma | Účet | Account | AutoLiq (`GET /deps`) | User pre-trade (`GET /userAccountPositionLimit/deps`) |
| --- | --- | --- | --- | --- |
| Tradeify | `62364060` / `TDFYG50677910442` | active, unrestricted, riskCategory `373`, autoLiqProfile `34`; risk status max/min net liq `52,208 / 49,862.4` | HTTP 200; `changesLocked` nezjištěno; daily alert `1,000`; daily auto-liq `1,250`; trailing `2,000`; stop level `999,999,999`; mode `EOD`; `doNotUnlock=false` | HTTP 200; 0 položek |
| Tradeify | `62364059` / `TDFYG50357770489` | active, unrestricted, riskCategory `373`, autoLiqProfile `34`; max/min `52,275.4 / 49,855.3` | HTTP 200; stejné parametry jako výše; `changesLocked` nezjištěno | HTTP 200; 0 položek |
| Tradeify | `64310872` / `FTDFYG50511354175` | active, unrestricted, riskCategory `373`, autoLiqProfile `34`; max/min `50,000 / 48,747.5` | HTTP 200; daily alert `1,000`; daily auto-liq `1,250`; trailing `2,000`; stop level `50,100`; mode `EOD`; `doNotUnlock=false`; `changesLocked` nezjištěno | HTTP 200; 0 položek |
| Tradeify | `63338592` / `TDFYG50307885722` | active, unrestricted, riskCategory `373`, autoLiqProfile `34`; max/min `51,912.6 / 50,000` | HTTP 200; stejné parametry jako první řádek; `changesLocked` nezjištěno | HTTP 200; 0 položek |
| Tradeify | `62364055` / `TDFYG50435948747` | active, unrestricted, riskCategory `373`, autoLiqProfile `34`; max/min `52,267.9 / 49,853.8` | HTTP 200; stejné parametry jako první řádek; `changesLocked` nezjištěno | HTTP 200; 0 položek |
| Lucid | `64503883` / `LFF05066846490007` | active, unrestricted, riskCategory `530`, autoLiqProfile `48`; max/min `50,000 / 50,000` | HTTP 200; `changesLocked` nezjištěno; daily alert/liquidate-only/auto-liq `1,200`; trailing `2,000`; stop level `50,100`; mode `EOD`; `doNotUnlock=false` | HTTP 200; 0 položek |

Pozor: každý účet má přiřazený `riskCategoryId`. Prázdný seznam
`UserAccountPositionLimit` proto znamená pouze „žádný user-account override
viditelný přes tento endpoint“, ne „účet nemá žádný pre-trade limit“. Tradovate
popisuje `RiskCategory` jako samostatnou vrstvu pro lot/product limity, kterou
zakládá Evaluation Support. Category-level endpointy nebyly součástí schválené
matice této sondy. [Tradovate: Pre-Trade
Risk](https://partner.tradovate.com/overview/prop-firm-management/risk-management/pre-trade-risk)

## Matice endpointů a oprávnění

| Endpoint | Tradeify | Lucid | Co lze tvrdit |
| --- | ---: | ---: | --- |
| `GET /auth/me` | 200 | 200 | token je přijat pro read introspekci |
| `GET /account/list` | 200, 5 | 200, 1 | token vidí uvedené účty |
| `GET /accountRiskStatus/list` + per-account `/deps` | 200 | 200 | risk status je čitelný |
| `GET /userAccountAutoLiq/list` + per-account `/deps` | 200 | 200 | post-trade AutoLiq konfigurace je čitelná |
| `GET /userAccountPositionLimit/list` | 404 | 404 | tato globální route na DEMO hostu neexistuje nebo není routovaná; není to auth důkaz |
| `GET /userAccountPositionLimit/deps?masterid=<account>` | 200, 0 pro každý účet | 200, 0 | podporovaná per-account route; žádný user override |
| `GET /userAccountRiskParameter/list` | 404 | 404 | globální route není dostupná |
| `GET /userAccountRiskParameter/deps?masterid=<position-limit>` | nevoláno | nevoláno | master musí být ID `UserAccountPositionLimit`; žádné takové ID sonda nenašla. [Tradovate: Risk Parameter Dependents](https://partner.tradovate.com/api/rest-api-endpoints/risks/user-account-risk-parameter-dependents) |
| `GET /permission/list` | 404 | 404 | obecná route není platný zdroj oprávnění |
| `GET /tradingPermission/list` | 200, 5× `Approved` | 200, 1× `Approved` | schválené trading permission pro každý viditelný účet; ne risk-write permission. [Tradovate: Trading Permission List](https://partner.tradovate.com/api/rest-api-endpoints/accounting/trading-permission-list) |
| `GET /userPlugin/list` | 200, 4 | 200, 6 | token vidí plugin/entitlement metadata; názvy entitlementů se bez dalšího mappingu neodvozují |
| `GET /user/list` | 200, 1 | 200, 1 | token vidí jednu user entitu; PII nebylo vypsáno |
| `GET /marketDataSubscription/list` | 200, 3 | 200, 4 | plán ID `3`; Tradeify měsíce 7–9/2026, Lucid 6–9/2026; všechny vrácené řádky `expired=false` |

Market-data metadata nejsou důkazem živého quote entitlementu ani kvality
streamu. To vyžaduje samostatný quote WebSocket probe; tento dokument je
nepoužívá pro risk rozhodnutí.

## AutoLiq versus skutečný pre-trade zámek

Tradovate výslovně rozlišuje dvě vrstvy:

- **Post-trade AutoLiq** se vyhodnocuje až po otevření pozice. Po dosažení
  threshold může pozice zlikvidovat a účet zamknout. `flattenTimestamp` je
  jednorázový flatten/cancel a sám nezabrání novému otevření pozice.
  `doNotUnlock=true` drží lock až po breach, není to okamžité tlačítko „zamknout
  den“. [Tradovate: Post-Trade
  Risk](https://partner.tradovate.com/overview/prop-firm-management/risk-management/post-trade-risk)
- **Pre-trade risk** se vyhodnocuje před exekucí a může order odmítnout.
  RiskCategory řídí lot/product pravidla a RiskTimePeriod umí během aktivního
  okna flattenout pozice a odmítat nové ordery. Tyto konfigurace jsou podle
  dokumentace zčásti vytvářené/řízené Evaluation Supportem či partner adminem,
  nikoli automaticky běžným OAuth trader tokenem. [Tradovate: Pre-Trade
  Risk](https://partner.tradovate.com/overview/prop-firm-management/risk-management/pre-trade-risk)

Aktuální AlphaTrade „Zamknout den“ tedy zůstává interní pojistka copieru
(DISARM + blokace ARM do konce session). Fáze 1 neprokázala ekvivalentní
okamžitý broker-side lock pro tyto OAuth tokeny.

## Co dokumentace říká — a neříká — o write právu

Oficiální API dokumentace publikuje `POST /userAccountAutoLiq/update` a uvádí,
že přes něj lze po vytvoření účtu konfigurovat post-trade risk. To dokazuje
existenci operace v API, **ne** autorizaci těchto dvou konkrétních OAuth tokenů.
[Tradovate: Post-Trade
Risk](https://partner.tradovate.com/overview/prop-firm-management/risk-management/post-trade-risk)

Dokumentace také publikuje create/update operace pro
`UserAccountPositionLimit` a `UserAccountRiskParameter`, ale user-level deps
této sondy byly prázdné a category-level risk je samostatná partner/support
vrstva. Žádný write endpoint nebyl volán, proto nemáme žádný HTTP status,
readback ani auditní důkaz write práva. `changesLocked` navíc nebylo v odpovědi
přítomné, takže ani tento atribut nelze použít jako pozitivní či negativní
důkaz.

## Doporučení pro případnou fázi 2 (není schválena ani implementována)

1. Nejdřív získat písemné potvrzení Tradovate/konkrétní prop firmy, zda trader
   OAuth token smí měnit post-trade AutoLiq a zda existuje podporovaný okamžitý
   broker-side day lock.
2. Pro důkaz **post-trade write** použít pouze samostatný osobní/disposable DEMO
   účet, flat a bez working orders. Načíst aktuální AutoLiq, odeslat přesně
   stejnou hodnotu jako no-op update, okamžitě readbacknout a porovnat všechna
   pole. I no-op je skutečný zápis: může vytvořit audit/timestamp, spustit
   validaci nebo přepočet, proto vyžaduje nové explicitní schválení.
3. Pro důkaz **pre-trade write** současné prop účty nejsou vhodné: nemají
   user-level position-limit entitu, na které by šel udělat no-op update.
   `create` + následné `delete` by byly dva materiální zápisy a nejsou nejmenší
   bezpečný důkaz. Vyžádat od Tradovate disposable DEMO účet s předem vytvořeným
   testovacím limitem, nebo capability potvrdit server-side rolí bez změny účtu.
4. Před a po případném testu archivovat read-only snapshot, ověřit flat/no
   working orders a nepřipojovat test k AlphaTrade day-lock UI, dokud není známá
   přesná rollback a failure semantika.

V tomto repu není připraven žádný spustitelný kód fáze 2.

## Prop-firm rizika

- Tradeify §6.6 dovoluje vlastní bot pouze při prokazatelném vlastnictví a
  výslovně zakazuje jeho použití napříč více firmami. Stejný dokument dovoluje
  zrcadlení vlastních obchodů mezi vlastními Tradeify účty jen v mezích dalších
  pravidel. Cross-firm AlphaTrade fan-out proto musí zůstat policy-blocked bez
  písemné výjimky. [Tradeify Evaluation Services Agreement,
  §6.6–6.7](https://tradeify.co/funded-trader-agreement)
- Lucid veřejně dovoluje automated strategies a trade copiers, ale trader nese
  odpovědnost za chyby; současně zakazuje hedging mezi účty i mezi firmami.
  To není písemné potvrzení, že konkrétní cross-firm copier nebo změna broker
  risk settings je povolena. [Lucid: Other Trading
  Activities](https://support.lucidtrading.com/en/articles/11404728-other-trading-activities),
  [Lucid: Prohibited
  Hedging](https://support.lucidtrading.com/en/articles/11404734-prohibited-hedging)

## Jednoznačný závěr

**READ: ano pro uvedené entity. WRITE: nelze z dostupných dat tvrdit.**
