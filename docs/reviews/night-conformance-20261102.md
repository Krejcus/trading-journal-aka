# Noční implementace a DEMO conformance — 1.→2. 11. 2026

Účet: **DEMO8661118 (61038658)**, skupina `manual-demo-61038658` (manual-only, bez followerů, DEMO).
Jen MNQ (MNQZ6). Autorizace: Filip 1. 11. večer.

## Shrnutí

Všechny povinné změny A–F jsou implementované, oponované (copier-design-critic) a nasazené. Web i worker
běží z **`0f710405`**. Skutečným DEMO brokerem (Tradovate) je ověřeno:
- 8× vzdálený Limit (1/2/3/5 MNQ) submit + cancel;
- 5× nativní Market round-trip (1/1/1/2/3 MNQ) se SL+TP, fill, ochranou, posunem SL i TP a zavřením ×;
- telefon (úzký web): holý Market z lišty, „Přidat SL/TP“ (OCO) a zavření Flattenem;
- původ kontraktu od brokera (front MNQZ6).

Bez ověření zůstalo BE (UI ho správně blokovalo), 5 MNQ round-trip, 3× 2 MNQ a 3× 3 MNQ (zastaveno na
rozpočtu −50 USD: broker realizováno −48,10 USD) a nativní iPhone (dohodnuto na ráno).
Od 23:45 do 05:23 byl IB Gateway odhlášený (Auto log off) a 01:28–02:06 Tradovate DEMO neodpovídal na
datová čtení.

## Stav po oblastech

| Oblast | Implementováno | Lokálně otestováno | Nasazeno web | Ve workeru | Ověřeno DEMO brokerem |
|---|---|---|---|---|---|
| A. Nativní Market (bez ceny, MKT, OSO, čerstvost IBKR) | ano | ano | ano | ano | **ano** (6 Marketů, SL/TP OSO, fill) |
| B. Strop 1–5 MNQ jen manual-only (instalace) | ano | ano | ano | ano | **ano** (Limit 2/3/5, Market 2/3; 6 blok UI) |
| C. Jen MNQ, konkrétní kontrakt, původ IBKR/broker | ano | ano | ano | ano | **ano** (vše MNQZ6; TV/kontinuální = blok) |
| D. `+`/pravý klik jen návrh, typ podle živé kotace | ano | ano | ano | – | **ano** (UI návrh, přesná cena, 0 POST; Limit u brokera) |
| E. Telefon: holý Market, list, „Přidat SL/TP“, Flatten | ano | ano | ano | ano | **ano** úzký web; **ne** nativní iPhone, list z position boxu |
| F. Instrumentace operationId | ano | ano | ano | ano | **ano** (fronta, POST, ACK, Order, Fill, Position) |

## Commity (vše na `main`, fast-forward)

| Commit | Co | Kritik |
|---|---|---|
| `2f87cb2e` | Vlna 1: nativní Market, strop skupiny, MNQ-only + původ IBKR, Market+brzda/unknown/odmítnutá noha = incident, čekající Limit v manual-only se už sám neruší, časy | 1–2 OPRAVIT → 3 OK |
| `68e43b22` | Vlna 2: telefon přes stejný relay, holý Market, `attach-brackets`, Flatten; oprava posunu SL v manual-only (`risk-unknown`) | návrh OPRAVIT (P0) → 2 OPRAVIT → 3 OK |
| `c2c7c94f` | Pravý klik: typ podle živé kotace, ne podle poslední viditelné svíčky | jen web |
| `4438feb7` | Uzavření holých vstupů po prokázaném flat | OK |
| `34a78b5a` | Původ kontraktu od brokera (Tradovate `isFront`), jen pro Limit bez IBKR | OPRAVIT (INV) → OK |
| `e42c9a8c` | Panel drží vzdálenosti SL/TP při změně ceny; gramatika | jen web |
| `0f710405` | Start workeru: retry uvnitř procesu místo launchd smyčky | provoz |

**Web commit: `0f710405` · worker commit: `0f710405`** (dirty=false, lifetime persistent,
`--manual-only --manual-entry-max-contracts 5 --tv-stream on --price-source ibkr`).

## Měření (skutečný DEMO broker)

Zdroje: časy workeru v záznamu operationId, DB relay (`created/claimed/completed`) a kliknutí v
prohlížeči. **Řádky „UI“ jsou zkreslené:** testovací panel běžel jako skrytá stránka, Chrome škrtil
časovače na ~1 s, takže jsou kvantované nahoru (až o +1 s). Serverové, workerové a DB časy jsou přesné.

| scénář | metrika | n | p50 | p90 | p95 | min | max | zdroj |
|---|---|---|---|---|---|---|---|---|
| Limit cancel | cancel-entry: claimed→hotovo (worker) | 7 | 413 | 425 | 429 | 372 | 432 | broker |
| Limit cancel | cancel-entry: created→claimed | 8 | 238 | 288 | 290 | 208 | 291 | broker |
| Limit cancel | cancel-entry: klik→server | 8 | 251 | 280 | 284 | 150 | 288 | broker |
| Limit cancel | cancel: klik→zmizení v UI | 8 | 1985 | 1990 | 1990 | 1979 | 1990 | broker; UI kvantováno ~1 s |
| Limit submit | ACK→Order (stream) | 8 | -14 | 3 | 13 | -28 | 23 | broker |
| Limit submit | broker request→HTTP ACK | 8 | 220 | 249 | 249 | 157 | 250 | broker |
| Limit submit | claimed→broker request | 8 | 30 | 48 | 48 | 28 | 48 | broker |
| Limit submit | created→claimed | 8 | 240 | 322 | 328 | 124 | 334 | broker |
| Limit submit | klik→důvěryhodný UI výsledek | 8 | 1928 | 1998 | 1999 | 989 | 1999 | broker; UI kvantováno ~1 s |
| Limit submit | klik→server přijetí | 8 | 225 | 273 | 275 | 142 | 276 | broker |
| Limit submit | klik→čára v grafu | 7 | 2995 | 2997 | 2998 | 1991 | 2998 | broker; UI kvantováno ~1 s |
| Market round-trip (desktop) | ACK→Order (stream) | 5 | -24 | -12 | -9 | -32 | -7 | broker |
| Market round-trip (desktop) | Fill→Position (worker) | 5 | 203 | 234 | 241 | 194 | 248 | broker |
| Market round-trip (desktop) | Order→Fill | 5 | 18 | 21 | 22 | 12 | 23 | broker |
| Market round-trip (desktop) | broker request→HTTP ACK | 5 | 229 | 251 | 251 | 183 | 252 | broker |
| Market round-trip (desktop) | claimed→broker request | 5 | 70 | 83 | 86 | 51 | 89 | broker |
| Market round-trip (desktop) | close-position: claimed→hotovo (worker) | 5 | 1293 | 1840 | 2021 | 1275 | 2202 | broker |
| Market round-trip (desktop) | close-position: created→claimed | 5 | 264 | 282 | 286 | 247 | 289 | broker |
| Market round-trip (desktop) | created→claimed | 5 | 303 | 392 | 395 | 268 | 399 | broker |
| Market round-trip (desktop) | klik→důvěryhodný UI výsledek | 5 | 1048 | 1262 | 1263 | 969 | 1264 | broker; UI kvantováno ~1 s |
| Market round-trip (desktop) | klik→pozice v grafu | 5 | 2007 | 2107 | 2116 | 1307 | 2125 | broker; UI kvantováno ~1 s |
| Market round-trip (desktop) | klik→server přijetí | 5 | 174 | 245 | 263 | 105 | 281 | broker |
| Market round-trip (desktop) | move-stop: claimed→hotovo (worker) | 4 | 208 | 304 | 325 | 201 | 345 | broker |
| Market round-trip (desktop) | move-stop: created→claimed | 4 | 229 | 289 | 298 | 78 | 306 | broker |
| Market round-trip (desktop) | move-target: claimed→hotovo (worker) | 4 | 200 | 264 | 277 | 182 | 289 | broker |
| Market round-trip (desktop) | move-target: created→claimed | 4 | 208 | 242 | 249 | 97 | 256 | broker |
| Telefon (úzký web) | ACK→Order (stream) | 1 | -5 | -5 | -5 | -5 | -5 | broker |
| Telefon (úzký web) | Fill→Position (worker) | 1 | 150 | 150 | 150 | 150 | 150 | broker |
| Telefon (úzký web) | Order→Fill | 1 | 10 | 10 | 10 | 10 | 10 | broker |
| Telefon (úzký web) | attach-brackets: claimed→hotovo (worker) | 1 | 674 | 674 | 674 | 674 | 674 | broker |
| Telefon (úzký web) | attach-brackets: created→claimed | 1 | 221 | 221 | 221 | 221 | 221 | broker |
| Telefon (úzký web) | attach: klik→„přijaty brokerem“ v UI | 1 | 1407 | 1407 | 1407 | 1407 | 1407 | broker; UI kvantováno ~1 s |
| Telefon (úzký web) | broker request→HTTP ACK | 1 | 148 | 148 | 148 | 148 | 148 | broker |
| Telefon (úzký web) | claimed→broker request | 1 | 62 | 62 | 62 | 62 | 62 | broker |
| Telefon (úzký web) | created→claimed | 1 | 286 | 286 | 286 | 286 | 286 | broker |
| Telefon (úzký web) | klik→důvěryhodný UI výsledek | 1 | 991 | 991 | 991 | 991 | 991 | broker; UI kvantováno ~1 s |
| Telefon (úzký web) | klik→pozice v grafu | 1 | 1018 | 1018 | 1018 | 1018 | 1018 | broker; UI kvantováno ~1 s |
| Telefon (úzký web) | klik→server přijetí | 1 | 199 | 199 | 199 | 199 | 199 | broker |
| Telefon (úzký web) | klik→„Flatten potvrzen“ v UI | 1 | 2063 | 2063 | 2063 | 2063 | 2063 | broker; UI kvantováno ~1 s |

**Market skluz** (viděná cena vs. fill, n=6): +1, +4, −1, −1, +1, 0 ticků (p50 0,5, max 4; + = proti).
Viděná cena je odhad: bid = poslední obchod, ask = bid + 1 tick. Všechny Market requesty šly jako
Tradovate `Market` bez `price` (OSO, resp. jediný `placeOrder` u holého).

**Limit**: všech 8 na přesné ceně (tick), žádný nečekaně vyplněný, cena se s trhem nehýbala, cancel
všech 8 potvrzen u brokera.

### Před / po

| Metrika | Před (30. 10., PROJECT_LOG, malé n) | Po (2. 11.) |
|---|---|---|
| Market submit → fill | Limit +2 b, fill neměřen | POST→ACK p50 229 ms; Order→Fill p50 18 ms; Fill→Position (worker) p50 203 ms (n=5) |
| Limit submit: klik → server | – | p50 225 ms (n=8) |
| server → claim (vstup) | ~427 ms p50 (DB 3 dny) | Limit p50 240 ms, Market p50 303 ms |
| broker request → HTTP ACK | 200–440 ms | Limit p50 220 ms, Market p50 229 ms |
| Limit cancel | – | klik→server 251, server→claim 238, worker 413 ms (p50, n=8) |
| SL/TP modify (claimed→hotovo) | posun SL 1087 ms | move-stop p50 208 ms, move-target p50 200 ms (n=4) |
| close-position (claimed→hotovo) | – | p50 1,29 s (ověření flat čtením u brokera, n=5) |
| Fill → graf | – | Fill→Position worker ~0,2 s; klik→pozice v grafu p50 2,0 s* |
| klik → důvěryhodný výsledek | 963–1567 ms (n=4) | Market p50 1,05 s*, Limit p50 1,93 s* |
| Desktop vs. telefon (Market) | – | telefon klik→server 199 ms, POST→ACK 148 ms, klik→výsledek 0,99 s* (n=1) |

\* UI hodnoty kvantované škrcením skrytého panelu.

## Bezpečnostní důkazy na konci (05:38)

- DEMO8661118 **flat**, **žádné working orders** (worker exposure `positions=[]`, `orders=[]`,
  `workingOrderAccounts=[]`, preflight OK).
- Worker **OFF/DISARMED**, kill switch vypnutý, `lastError=null`, `stuckOutbox=false`.
- **Žádný příkaz na jiném účtu:** DB audit noci (relay `copy-command` od 22:30 UTC) = 14×
  `place-leader-entry` (8 Limit, 6 Market) a 22× `manage-leader-order`, vše `leaderAccountId 61038658`,
  vše `succeeded`; jediná route `7cce8c5b…` → `[61038658]`, prostředí `demo`, `followers=[]`.
- **Žádný NQ broker request:** všech 14 vstupů `MNQZ6`.
- **Neznámé výsledky: žádné.** Všechny vstupy `acknowledged`, všechny akce `acknowledged`.
- P&L: broker realizováno **−48,10 USD** (cash 49 951,90). Testy jsem zastavil před limitem −50 USD.

## Incidenty a nálezy noci

1. **23:45 IB Gateway Auto log off** (`~/Jts/launcher.log`: „Daily auto-restart is not enabled“).
   Do 05:23 bez IBKR. Market/Stop byly zablokované (fail-closed), Limit šel přes front od brokera.
   **Doporučení:** v IB Gateway zapnout Auto restart (session vydrží do týdenního 2FA) nebo IBC.
2. **01:28–02:06 Tradovate DEMO REST s tokenem neodpovídal** (všech 8 čtení timeout 10 s, ověřeno
   `NODE_DEBUG=fetch`; auth i AlphaTrade API odpovídaly). Restartovaný worker nemohl naběhnout a launchd
   ho restartoval každých ~11 s (`retryTransient` unref). Opraveno v `0f710405`. Rollback na `4438feb7`
   selhával stejně, takže šlo o prostředí, ne o kód. Účet byl celou dobu flat a DISARMED.
3. **BE na desktopu nešlo ani jednou:** „Nový SL je blíž než 8 ticků od trhu“ a pak „Cena trhu od brokera
   není známá — utažení SL teď nejde“. Utažení SL potřebuje cenu trhu z P&L brokera, která u leadera
   (bez otevřeného P&L ze streamu) chyběla. Je to fail-closed, ale BE je teď v praxi nedostupné.
   **Další krok:** zdroj ceny pro utažení (IBKR kotace workeru).
4. **Panel v pozadí:** skrytá stránka = poller stojí = příkazy blokované („stav cíle neověřený“). To je
   správně (INV-FRESH-03). Pro test byla viditelnost přepnuta ručně.
5. **UI výsledky po ~1 s:** z části škrcení skrytého panelu. Backend cesta je 0,5–0,7 s.
6. Opravené drobnosti: SL/TP se při změně ceny v panelu neposouvaly (`e42c9a8c`), „5 kontrakty“ → „kontraktů“.

## Neověřeno

- BE u brokera (viz nález 3).
- 5 MNQ Market round-trip; 3× 2 MNQ a 3× 3 MNQ (proběhl 1× 2 MNQ a 1× 3 MNQ; dál bránil rozpočet −50 USD).
- Telefonní list objednávky z position boxu (long-press) se skutečným odesláním.
- Nativní iPhone appka (build + pozadí/popředí): ráno s Filipem. Návrat z pozadí ověřen jen simulací
  v prohlížeči: „Stav kopírky se ověřuje…“, 0 POST.
- Odmítnutí stopu přes trh u Market OSO naostro (při 16tickové minimální vzdálenosti nenastalo).
