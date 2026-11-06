# Noční implementace a DEMO conformance — 1.→2. 11. 2026

Účet: **DEMO8661118 (61038658)**, skupina `manual-demo-61038658` (manual-only, bez followerů, DEMO).
Jen MNQ (MNQZ6). Autorizace: Filip 1. 11. večer.

## Shrnutí

Všechny povinné změny A–F jsou implementované, oponované (copier-design-critic) a nasazené. Web i worker
běží z **`4ce53856`** (ranní oprava BE). Skutečným DEMO brokerem (Tradovate) je ověřeno:
- 8× vzdálený Limit (1/2/3/5 MNQ) submit + cancel;
- nativní Market round-trip se SL+TP, fill, ochranou, posunem SL i TP a zavřením ×: v noci 1/1/1/2/3 MNQ,
  ráno (rozpočet zvednut na 500 USD) 2/2/3/3/5 MNQ → **3× 1, 3× 2, 3× 3 a 1× 5 MNQ**;
- **BE u brokera** (ráno, `4ce53856`): stop posunut přesně na průměr vstupu;
- telefon (úzký web): holý Market z lišty, „Přidat SL/TP“ (OCO) a zavření Flattenem;
- původ kontraktu od brokera (front MNQZ6).

Nativní iPhone zůstává na dopoledne s Filipem. Od 23:45 do 05:23 byl IB Gateway odhlášený
(Auto log off) a 01:28–02:06 Tradovate DEMO neodpovídal na datová čtení.

### Ráno 2. 11. (06:50–07:25)

- **BE oprava `4ce53856`** (critic OK): když broker nedá cenu trhu pro P&L, utažení SL/BE použije čerstvou
  IBKR kotaci (≤ 3 s, stejný kontrakt jako pozice); worker navíc odmítne utažení blíž než 8 ticků od
  čerstvé IBKR ceny (`tighten-too-close`). Nasazeno web + worker v 06:55.
- **BE naostro:** short 1 MNQ @ 28791.50; po pohybu ≥ 8 ticků se BE odemklo („SL na BE leadera
  28791.50“), dvoukrokové potvrzení → `move-stop 611860530548 → 28791.5` (zápis u brokera 247 ms,
  klik→server 236 ms, worker 297 ms). Pak zavřeno × (+24 USD). Předtím dva longy 1 MNQ skončily na SL
  dřív, než trh došel k BE: UI přitom ukazovalo novou hlášku „Nový SL je blíž než 8 ticků“ místo staré
  „Cena trhu od brokera není známá“.
- **Market 3× navíc u 2/3 MNQ a 1× 5 MNQ** se SL/TP posunem a ×: všechno `succeeded`, flat po každém.
- **Pojistky, které zafungovaly naostro:** 2× `market-quote-drift` (rychlý trh, nic neodešlo) a 1× denní
  limit skupiny („ztráta při SL ~143 $ je víc, než zbývá do denního limitu (126 $)“). 5 MNQ pak šlo
  s SL 8 b.
- **Telefonní list z position boxu (úzký web 390×844, 07:28–07:42):** long box → „Quick Order z position
  boxu“ → list (Limit, cena z boxu, SL/TP z boxu). Při OFF: „Kopírka je vypnutá“, 0 POST. Velikost z rizika
  boxu 22 ks: „Strop ručního vstupu je 5 kontraktů“, 0 POST. Po ARM 1 MNQ Limit 28753.50 (80–134 ticků pod
  trhem): broker OSO přijal (POST 224–232 ms), klik→„přijal“ v UI 1,27 s. **Nález:** lišta ukázala čekající
  Limit jako „LONG 1 · Zavřít“. Opraveno ve `f6465e28` (jen web): teď „ČEKÁ BUY 1 LMT 28753.50 · Zrušit“,
  bez „Přidat SL/TP“. Ověřeno naostro: „Zrušit“ → „Opravdu zrušit?“ → Flatten potvrzen, příkazy zrušené,
  flat. Flatten skupinu zároveň vypne (DISARM) a `reconciliationRequired` se do 30 s samo vyčistí.
  Testovací box jsem z grafu smazal.
- Konec 07:24: **DISARM** tlačítkem v grafu, preflight OK, flat, žádné working orders, `lastError=null`.
- P&L u brokera za celý test: **−150,80 USD** (cash 49 849,20; noc −48,10, ráno −102,70) v rámci
  rozpočtu 500 USD.

## Stav po oblastech

| Oblast | Implementováno | Lokálně otestováno | Nasazeno web | Ve workeru | Ověřeno DEMO brokerem |
|---|---|---|---|---|---|
| A. Nativní Market (bez ceny, MKT, OSO, čerstvost IBKR) | ano | ano | ano | ano | **ano** (16 Marketů vč. telefonu, SL/TP OSO, fill, BE) |
| B. Strop 1–5 MNQ jen manual-only (instalace) | ano | ano | ano | ano | **ano** (Limit 2/3/5, Market 2/3/5; 6 blok UI; denní limit blokoval 5 MNQ s SL 12 b) |
| C. Jen MNQ, konkrétní kontrakt, původ IBKR/broker | ano | ano | ano | ano | **ano** (vše MNQZ6; TV/kontinuální = blok) |
| D. `+`/pravý klik jen návrh, typ podle živé kotace | ano | ano | ano | – | **ano** (UI návrh, přesná cena, 0 POST; Limit u brokera) |
| E. Telefon: holý Market, list, „Přidat SL/TP“, Flatten | ano | ano | ano | ano | **ano** úzký web vč. listu z position boxu; **ne** nativní iPhone |
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
| `f6465e28` | Telefon: čekající vstup jako „ČEKÁ … · Zrušit“, ne jako pozice | jen web (zobrazení) |
| `4ce53856` | BE / utažení SL: čerstvá IBKR kotace, když chybí cena od brokera; worker guard `tighten-too-close` | OK |

**Web commit: `4ce53856` · worker commit: `4ce53856`** (dirty=false, lifetime persistent,
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
| BE (short 1 MNQ) | move-stop: claimed→hotovo (worker) | 1 | 297 | 297 | 297 | 297 | 297 | broker |
| BE (short 1 MNQ) | move-stop: created→claimed | 1 | 154 | 154 | 154 | 154 | 154 | broker |
| BE (short 1 MNQ) | move-stop: klik→server | 1 | 236 | 236 | 236 | 236 | 236 | broker |
| Market round-trip (desktop) | ACK→Order (stream) | 11 | -7 | 7 | 8 | -32 | 10 | broker |
| Market round-trip (desktop) | Fill→Position (worker) | 11 | 203 | 221 | 234 | 162 | 248 | broker |
| Market round-trip (desktop) | Order→Fill | 11 | 19 | 38 | 48 | 12 | 57 | broker |
| Market round-trip (desktop) | broker request→HTTP ACK | 11 | 235 | 252 | 254 | 183 | 255 | broker |
| Market round-trip (desktop) | claimed→broker request | 11 | 66 | 74 | 82 | 35 | 89 | broker |
| Market round-trip (desktop) | close ×: klik→zmizení v UI | 3 | 1291 | 1655 | 1700 | 1038 | 1746 | broker; UI kvantováno ~1 s |
| Market round-trip (desktop) | close-position: claimed→hotovo (worker) | 10 | 1294 | 1452 | 1827 | 1258 | 2202 | broker |
| Market round-trip (desktop) | close-position: created→claimed | 10 | 248 | 274 | 281 | 41 | 289 | broker |
| Market round-trip (desktop) | close-position: klik→server | 3 | 218 | 267 | 273 | 171 | 279 | broker |
| Market round-trip (desktop) | created→claimed | 11 | 276 | 381 | 390 | 57 | 399 | broker |
| Market round-trip (desktop) | klik→důvěryhodný UI výsledek | 7 | 1048 | 1262 | 1263 | 893 | 1264 | broker; UI kvantováno ~1 s |
| Market round-trip (desktop) | klik→pozice v grafu | 11 | 1975 | 2122 | 2124 | 986 | 2125 | broker; UI kvantováno ~1 s |
| Market round-trip (desktop) | klik→server přijetí | 11 | 190 | 254 | 268 | 105 | 281 | broker |
| Market round-trip (desktop) | move-stop: claimed→hotovo (worker) | 9 | 202 | 237 | 291 | 186 | 345 | broker |
| Market round-trip (desktop) | move-stop: created→claimed | 9 | 259 | 293 | 300 | 78 | 306 | broker |
| Market round-trip (desktop) | move-stop: klik→server | 3 | 218 | 232 | 234 | 204 | 236 | broker |
| Market round-trip (desktop) | move-target: claimed→hotovo (worker) | 9 | 207 | 253 | 271 | 179 | 289 | broker |
| Market round-trip (desktop) | move-target: created→claimed | 9 | 199 | 260 | 269 | 22 | 278 | broker |
| Market round-trip (desktop) | move-target: klik→server | 3 | 195 | 209 | 210 | 194 | 212 | broker |
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

**Market skluz** (viděná cena vs. fill, + = proti): noc +1, +4, −1, −1, +1, 0; ráno +1, +2, +6, +7, +4, −8,
−2, +4 ticků (n=14, p50 +1, nejhorší +7). +6/+7 přišly v rychlém propadu 07:04–07:11. Drift gate (≤ 8 ticků
mezi viděnou cenou a IBKR při odeslání) je propustil, fill byl o 1,5–1,75 b horší.
Viděná cena je odhad: bid = poslední obchod, ask = bid + 1 tick. Všechny Market requesty šly jako
Tradovate `Market` bez `price` (OSO, resp. jediný `placeOrder` u holého).

**Limit**: všech 8 na přesné ceně (tick), žádný nečekaně vyplněný, cena se s trhem nehýbala, cancel
všech 8 potvrzen u brokera.

### Před / po

| Metrika | Před (30. 10., PROJECT_LOG, malé n) | Po (2. 11.) |
|---|---|---|
| Market submit → fill | Limit +2 b, fill neměřen | POST→ACK p50 235 ms; Order→Fill p50 19 ms; Fill→Position (worker) p50 203 ms (n=11) |
| Limit submit: klik → server | – | p50 225 ms (n=8) |
| server → claim (vstup) | ~427 ms p50 (DB 3 dny) | Limit p50 240 ms, Market p50 276 ms |
| broker request → HTTP ACK | 200–440 ms | Limit p50 220 ms, Market p50 235 ms |
| Limit cancel | – | klik→server 251, server→claim 238, worker 413 ms (p50, n=8) |
| SL/TP modify (claimed→hotovo) | posun SL 1087 ms | move-stop p50 202 ms, move-target p50 207 ms (n=9); BE 297 ms (n=1) |
| close-position (claimed→hotovo) | – | p50 1,29 s (ověření flat čtením u brokera, n=10) |
| Fill → graf | – | Fill→Position worker ~0,2 s; klik→pozice v grafu p50 1,98 s* |
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

**Ráno (07:25):** DISARMED, flat, žádné working orders, `lastError=null`, preflight OK. DB audit od 05:45 UTC:
11× `place-leader-entry` (8 přijatých, 2× drift a 1× denní limit zablokované u workeru) a 17×
`manage-leader-order`, vše `leaderAccountId 61038658`, `MNQZ6`, `succeeded`. Broker: realizováno
−150,80 USD za celý test, cash 49 849,20.

## Incidenty a nálezy noci

1. **23:45 IB Gateway Auto log off** (`~/Jts/launcher.log`: „Daily auto-restart is not enabled“).
   Do 05:23 bez IBKR. Market/Stop byly zablokované (fail-closed), Limit šel přes front od brokera.
   **Doporučení:** v IB Gateway zapnout Auto restart (session vydrží do týdenního 2FA) nebo IBC.
2. **01:28–02:06 Tradovate DEMO REST s tokenem neodpovídal** (všech 8 čtení timeout 10 s, ověřeno
   `NODE_DEBUG=fetch`; auth i AlphaTrade API odpovídaly). Restartovaný worker nemohl naběhnout a launchd
   ho restartoval každých ~11 s (`retryTransient` unref). Opraveno v `0f710405`. Rollback na `4438feb7`
   selhával stejně, takže šlo o prostředí, ne o kód. Účet byl celou dobu flat a DISARMED.
3. **BE v noci nešlo ani jednou:** „Cena trhu od brokera není známá — utažení SL teď nejde“. Utažení SL
   potřebovalo cenu trhu z P&L brokera, která u leadera chyběla. **Opraveno ráno v `4ce53856`** (IBKR
   kotace + worker guard) a ověřeno u brokera (viz Ráno 2. 11.).
4. **Panel v pozadí:** skrytá stránka = poller stojí = příkazy blokované („stav cíle neověřený“). To je
   správně (INV-FRESH-03). Pro test byla viditelnost přepnuta ručně.
5. **UI výsledky po ~1 s:** z části škrcení skrytého panelu. Backend cesta je 0,5–0,7 s.
6. Opravené drobnosti: SL/TP se při změně ceny v panelu neposouvaly (`e42c9a8c`), „5 kontrakty“ → „kontraktů“.
7. **Denní limit workeru počítá hrubé P&L bez poplatků:** `dailyStats.realizedPnlUsd` −99,50 USD vs.
   broker `dailyRealizedPnL` −150,80 USD po 14 obchodech (27 kontraktů). Rozdíl ~1,90 USD na kontrakt za
   round trip jsou poplatky. Vlastní denní zámek je tak o poplatky měkčí než broker/propka.
   **Návrh (jádro, přes critic):** započítat poplatky z `fillFee` nebo brát přísnější z obou hodnot.
8. **Ranní graf:** „Svíčky: obnova selhala“: `market-candles` vrací opakovaně 502 a `market-candle-store` 409.
   Živé IBKR ticky i příkazy běžely dál; jde jen o doplnění historie.
9. **Testovací poznámka:** skrytý panel prohlížeče natáhne `setTimeout(400)` až na 11 s (intensive
   throttling), takže dvoukrokové potvrzení (4 s) se skriptem nestihlo. Skutečného uživatele se to netýká.

## Neověřeno

- Nativní iPhone appka (build + pozadí/popředí): ráno s Filipem. Návrat z pozadí ověřen jen simulací
  v prohlížeči: „Stav kopírky se ověřuje…“, 0 POST.
- Odmítnutí stopu přes trh u Market OSO naostro (při 16tickové minimální vzdálenosti nenastalo).

## Nativní iPhone (2. 11. 10:17–10:21)

- Build z `c5547419` (vč. ceny lístku z `feed.final`, lišty „ČEKÁ … · Zrušit“, BE přes IBKR),
  čistá instalace (uninstall → install → launch `alphatrade-native://live`) na iPhone 13 Pro Max.
- Pozadí → popředí: AlphaTrade na LIVE, 30 s v pozadí (otevřené Nastavení), návrat. Appka
  přihlášená, skupina „Ruční DEMO test“, „Kopírka VYP“, živá cena v liště (28 776,50/75), během
  ~5 s dočetla data dne (značky obchodů, svíčky). DB: žádný příkaz od začátku testu, DISARMED, flat.
- Neověřeno: ťuknutí na lištu Koupit/Prodat hned po návratu („Stav kopírky se ověřuje…“, 0 POST)
  — na fyzickém telefonu bez dotyku neumím; v noci ověřeno simulací v prohlížeči.
- Pozor: jiná session („Svíčky realtime P&L…“) chystá vlastní build do iPhonu — upozorněna, ať
  staví z aktuálního `main`.
