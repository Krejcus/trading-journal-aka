# Soukromý serverový sklad svíček — předání klientovi

Stav 2026-09-29: **nasazeno v produkci** (migrace 20260926071010, secret
`CANDLE_STORE_OWNER_USER_ID`, funkce `market-candle-store`; oprava
`admin.rpc.bind(admin)`). Ověřeno: filled/hit, souběh = jeden nákup. Detail
v docs/PROJECT_LOG.md (2026-09-29). Copier a stávající `market-candles`
nejsou změněny.

## API

Po samostatně schválené aktivaci poběží v Supabase Edge Functions na
`POST /functions/v1/market-candle-store` ve stejném projektu jako dosavadní
`market-candles`. Požadavek vyžaduje přihlášený `Authorization: Bearer <JWT>`
a `apikey` klienta Supabase. Server navíc ověřuje přesné UID Filipa z tajné
proměnné `CANDLE_STORE_OWNER_USER_ID`; jiný uživatel dostane 403.

```json
{
  "symbol": "MNQ.v.0",
  "schema": "ohlcv-1m",
  "start": "2026-09-20T00:00:00.000Z",
  "end": "2026-09-23T00:00:00.000Z"
}
```

Povoleny jsou `MNQ`/`NQ` kontinuální symboly i konkrétní kontrakty typu
`MNQZ6`; schémata `ohlcv-1m` a `ohlcv-1h`. Maximální rozsah odpovídá
`market-candles`: 16 dní pro 1m, 370 dní pro 1h. Úspěšná odpověď má stejná
pole `provider`, `dataset`, `schema`, `symbol`, `sourceSymbol?`, `start`,
`end`, `estimatedCostUsd?`, `candles` jako `market-candles` a navíc `store`:
`hit`, `filled`, `mixed` nebo `uncached`. `start` je včetně, `end` výlučně.
`uncached` znamená historický, ale zatím neuzavřený UTC den/měsíc; data se
neukládají. Období po 24hodinové historické hranici se odmítá 409.

Server uchovává 1m po dokončených UTC dnech a 1h po dokončených UTC měsících,
v obou případech až po dodatečném 25hodinovém bezpečnostním odstupu. Při
požadavku přes staré i právě běžící období se stará část čte/ukládá a jen
historický neúplný konec se dotáhne bez uložení. Tak roční HTF dotaz nepřijde
o výhodu skladu kvůli právě běžícímu měsíci.

`202 {"error":"store-pending","retryAfterMs":1000}` + `Retry-After: 1`
znamená, že jiný požadavek už některé období pořizuje. Klient má tento stav
opakovat; **nesmí současně volat placenou záložní `market-candles`**, jinak
obejde zámek a koupí tatáž data podruhé. Ostatní chyby: 400 neplatný vstup,
401/403 přístup, 404 skutečně prázdná řada, 409 ještě nehistorický konec,
402/429 upstream cena/limit, 503 výpadek či poškození skladu. Při 503 je
fallback na starý endpoint technicky možný, ale může znamenat další placený
dotaz; pro úsporu nejprve nabídnout retry.

## Uložení, zámek, měření

Soukromý Storage bucket `market-candles-private` obsahuje komprimované JSON
objekty. Metadata a atomický lease (180 s) jsou v neveřejném schématu
`alphatrade_private.market_candle_periods`; jen serverová service-role smí
volat claim/complete/fail RPC. Publikaci hlídá unikátní token lease a SHA-256
objektu. Klient nikdy nedostane adresu Storage ani service-role klíč.

Před stavbou byl změřen **lokální loopback prototyp**, ne živý Supabase:
syntetický den 1 440 svíček, 195 800 B JSON / 49 349 B gzip; 50 zahřátých
HTTP čtení mělo p50 1,18 ms a p95 2,48 ms pro přenos, parsování p50 0,49 ms
a p95 0,63 ms. Reprodukovatelné přes
`node scripts/market-data/benchmark-candle-store-read.mjs`. Z toho nelze
odvozovat latenci přes internet, Edge autentizaci ani telefon. Po aktivaci
změřit hit/miss na skutečném souboru a obou zařízeních odděleně.

Noční předplnění je v zadání volitelné a zatím **není zapojené**. Aktivace
vyžaduje výslovný souhlas, předchozí export/zálohu vzdáleného Supabase,
migraci, nastavení UID vlastníka, deploy funkce, bezpečnostní advisory a
skutečný test souběhu dvou požadavků a obnovy po chybě.
