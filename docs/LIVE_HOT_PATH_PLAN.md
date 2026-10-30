# Horká cesta LIVE — fáze 1 (návrh, 30. 10. 2026)

> **Stav po oponentuře (30. 10. večer): OPRAVIT PŘED IMPLEMENTACÍ → rozsah zúžen.**
> Implementováno: F1a (pozice ze streamu), F1d (budíček statusu), F1e (měření) a nově
> **F1f — souběžná čtení admission na serveru** (§9). **F1b odloženo** (nálezy 1–5:
> restart s nerotující delivery, věčné `claimed` po bind + pádu, posun hodin z pushe,
> klíč pushe = oprávnění k execution, zúžené okno brzd). **F1c odloženo** (výsledek
> před ACK by vrátil čáru do starého stavu; zisk jen štítek „odesílám“). Rozhodnutí
> o F1b až podle měření §6 (kde se ztrácí fronta po F1f).

Navazuje na `docs/reviews/live-quality-verdict-20261030.md` (v Documents, untracked).
Filip 30. 10.: „udělej fázi 1 a změř to“.

## 0. Měření výchozího stavu (30. 10.)

| Zdroj | Úsek | Hodnota |
|---|---|---|
| DB `tradovate_copier_commands`, 3 dny, p50 | manage-leader-order created→claimed / claimed→completed / celkem | 388 / 1087 / 1492 ms |
| | place-leader-entry | 427 / 528 / 930 ms |
| | preview-leader-entry (bez zápisu k brokerovi) | 359 / 275 / 620 ms |
| Log workeru 30. 10. odpoledne (posun SL po 5f853760) | `queueMs` (created → start execution) | 240–560, typ. ~450 ms |
| | `RELAY EXECUTED durationMs` (broker) | 210–320 ms |
| | `RELAY ACK durationMs` (complete-v2) | 200–440, typ. ~240 ms |
| curl z Prahy, odmítnutý relay POST | TTFB s novým TLS / bez | 0,13–0,16 s / ~0,07–0,09 s |
| status workeru | velikost (posílá se v každém ACK/heartbeatu) | ~39 KB |

Rozklad posunu SL (~1,3 s v prohlížeči): enqueue z prohlížeče ~0,2 s → fronta ~0,45 s
(kick + poll-v2 + checkpointy) → broker ~0,27 s → ACK ~0,24 s → long-poll (100 ms krok)
a odpověď ~0,1 s. **Broker je ~20 %, zbytek naše doručování.**

## 1. Cíl a hranice

- Klik → výsledek v grafu p50 **≈ 0,6 s** (z ~1,3 s), pozice s cenou vstupu v grafu do
  ~0,5 s po fillu.
- **Beze změny serverových bran:** admission (rozestupy, busy, denní stropy, payloadHash,
  operationId), idempotence, TTL, trvalý claim před execution a jeden durable výsledek
  zůstávají v DB přesně jako dnes. Brzdy (DISARM, kill, day lock) beze změny.
- Mimo rozsah (vědomě): zápisy přes Tradovate WebSocket (broker je ~0,27 s, zisk desítky ms
  při velkém riziku), admission ve workeru (−0,1–0,2 s, ale přepis pojistek P3/P7), VPS,
  Databento.

## 2. F1a — Pozice ze streamu (jen zobrazení)

- `BrokerPosition.averagePrice?: number` z Tradovate `netPrice` (stream `Position` i
  `/position/list`); chybějící/nekonečné/≤ 0 = vynechat.
- Controller si pamatuje poslední broker průměr pro (účet, symbol) spolu s kusy, ke kterým
  patří. `exposure.positions[].avgPrice` = broker `netPrice`, když sedí kusy s aktuální
  `netQuantity` → jinak průměr z fillů (rozdělaný diff ve worktree `manage-qty`) → jinak
  pole chybí.
- Hodnota nikdy nevstupuje do příkazu. BE dál z `manageableLeaderTrades[].entryAvgPrice`,
  zavření z kusů/stopu brokera (INV-MANUAL-01, INV-UI-03). Overlay a příznak
  `openPnlBehindPosition` beze změny (viz INV-UI-03 v diffu).

## 3. F1b — Přímé doručení: server převezme příkaz za worker

Dnes: insert → kick (prázdný) → worker poll-v2 (claim přes Vercel) → execution.
Nově pro **horké příkazy** (`copy-command` s `preview-leader-entry`, `place-leader-entry`,
`manage-leader-order`):

1. **Worker** nemění `deliveryId` mezi prázdnými polly (rotuje jen po dokončení vázaného
   příkazu). Aktuální volné doručení hlásí ve statusu: `relayIdle: { deliveryId, since }`
   (heartbeat-v2 i complete-v2; po rotaci `publishStatusSoon`). GET statusu pro prohlížeč
   pole vynechá (jako `deviceId`).
2. **Server** po úspěšném enqueue horkého příkazu zavolá novou RPC
   `push_claim_tradovate_copier_command(device, delivery, command)` (migrace; stejný
   advisory lock jako `claim_tradovate_copier_command_v2`). Naváže příkaz na delivery jen
   když platí vše:
   - delivery ještě nemá vázaný příkaz (unikátní index `(device_id, delivery_id)` to drží i tak);
   - příkaz je `pending` a neexpirovaný;
   - zařízení nemá jiný `pending` příkaz (žádné předbíhání FIFO, hlavně brzd);
   - runtime: `last_seen_at` ≤ 3 s, `status.relayIdle.deliveryId = delivery`,
     `status.startedAt = started_at`.
   Jinak nic nezmění → kick jako dnes (beze změny chování).
3. Po navázání server pošle na kick téma zprávu `{ v: 1, deliveryId, command }` (stejný tvar
   jako `command` v odpovědi poll-v2 + `serverNow`), podepsanou HMAC klíčem odvozeným ze
   zařízení (`TV_PRICE_CHANNEL_SECRET`, štítek `copier-push-sign`). Klíč dostane worker
   v `realtime` konfiguraci z poll-v2 (jako kanál ceny). Bez klíče/s chybou = obyčejný kick.
4. **Worker** zprávu ověří (podpis, `deliveryId` = aktuální checkpoint ve fázi `polling`),
   uloží do schránky a probudí smyčku. `delivery()` místo poll-v2 použije schránku jen při
   shodě `deliveryId`; zbytek stavového automatu beze změny (persist `executing` → execute
   → persist `completed` → complete-v2). Pozdní nebo duplicitní push (id už v `started`,
   jiné `deliveryId`) se tiše zahodí — **žádný ACK, žádná execution**.
5. Záloha: poll-v2 se stejným `deliveryId` vrátí vázaný řádek (první větev claim_v2), takže
   ztracený push = dnešní cesta. Push nikdy příkaz nevytváří ani neprodlužuje TTL.

Odhad: fronta ~450 → ~100–150 ms.

## 4. F1c — Výsledek rovnou do grafu

1. Worker po `RELAY EXECUTED` horkého příkazu (před complete-v2) pošle na **téma výsledků**
   (odvozené ze zařízení; prohlížeč dostane téma + klíč v grantu vedle kanálu ceny) podepsanou
   zprávu `{ v: 1, key: idempotencyKey, commandId, outcome, result, error }`. `result` je jen
   vnitřní výsledek příkazu, **bez statusu**. Fire-and-forget; selhání nikdy nezdrží ACK ani
   brzdy (INV-WORKER-04).
2. Prohlížeč: nová `executeTradovateHotCommand` pro preview/vstup/správu: POST enqueue jako
   dnes (long-poll) a souběžně čeká na podepsaný výsledek se svým `idempotencyKey`; vezme
   první, druhý ignoruje. Bez výsledku do deadline → dnešní hláška, bez opakování.
3. Výsledek z kanálu smí jen ukončit čekání v UI (zavřít lístek, zrušit „odesílám“, kartu).
   Stav LIVE dál jen z pollu/ACK (INV-FRESH-02/03); po výsledku hned GET statusu (dnes už
   `statusPollKickRef`).

Odhad: −0,25 až −0,3 s.

## 5. F1d — Pozice rychleji v grafu

Worker po změně u brokera už posílá heartbeat (≤ 4×/s). Po potvrzeném heartbeatu vyvolaném
změnou a po přijatém ACK příkazu pošle na vlastní téma `copier-nudge-…` (odvozené ze zařízení)
prázdnou zprávu → otevřený LIVE graf hned kickne běžný poll statusu. **Bez podpisu** (implementace
odchylka od původního návrhu): zpráva nenese data, podvržená umí jen vyvolat čtení navíc, které
klient drží ≥ 250 ms od sebe, nejvýš 60/min a jen s otevřeným grafem. Jen zobrazení; přítomnost
zpráv nikdy neznamená čerstvost workeru (INV-RELAY-04).

## 6. F1e — Měření

- Worker (už dnes): `RELAY KICK přijat` (pilot), `RELAY CMD … queueMs`, `RELAY EXECUTED
  durationMs`, `RELAY ACK durationMs`; DB `created_at`/`claimed_at`/`completed_at`.
- Prohlížeč: posledních 50 horkých příkazů do `localStorage['at:dev:hot-command-timings']`
  (`type`, `action`, `ms` od odeslání po výsledek, `via: inline|poll|error`).
- Server-Timing (auth, resolve, enqueue, kick, longpoll) s `localStorage['at:dev:perf']='1'`
  → `window.__atPerf` (strop 400 záznamů — při měření přesouvat do vlastního pole).
- Porovnání: náhledy (bez zápisu k brokerovi) o víkendu, posuny naostro v pondělí.

## 7. Dotčená pravidla

| INV | Dopad |
|---|---|
| INV-RELAY-04 | Doplněn budíček statusu (prázdná zpráva, jen podnět ke čtení). Push příkazu (F1b) a kanál výsledků (F1c) **nezavedeny** — oponentura je vrátila. |
| INV-RELAY-01 | Beze změny: idempotency key, TTL, jeden durable výsledek (complete-v2). |
| INV-RELAY-02 | Push vstupuje do stejného stavového automatu před `executing`; po startu se nic neopakuje. |
| INV-RELAY-03, INV-BRAKE-03 | Brzdy beze změny; push nesmí předběhnout žádný `pending` (RPC podmínka). |
| INV-WORKER-03/04 | Podpis klíčem odvozeným ze zařízení; vysílání výsledků mimo kritickou cestu. |
| INV-FRESH-02/03 | Výsledek/nudge z kanálu nepřepíše status ani neautorizuje příkaz. |
| INV-UI-01/03, INV-MANUAL-01 | F1a jen zobrazení; průměr nikdy do příkazu. |
| INV-OUTBOX-01, INV-DEFAULT-01 | Beze změny. |

## 8. Pořadí nasazení

Migrace (RPC) → server (push_claim, grant tématu výsledků) → worker. Starý worker bez
`relayIdle` = server nikdy nepushne (podmínka 2). Nový worker se starým serverem = kick jako
dnes. Prohlížeč bez tématu výsledků = long-poll jako dnes.

## 9. F1f — Souběžná čtení admission (bez změny pravidel)

Měření 30. 10.: `created_at` se bere na začátku `enqueueTradovateCopierCommand`, takže
„fronta“ 0,45 s z velké části není fronta, ale ~6 sériových čtení v DB před insertem
(posun SL: 2× výběr zařízení, existující operace, busy, denní strop, insert) + kick (~50 ms
změřeno) + poll-v2. Úprava:

- `findEntryByOperationId` a `assertManageAdmissible` (obě per uživatel) se spustí hned,
  souběžně s výběrem zařízení; vyhodnotí se ve stejném místě a pořadí jako dřív
  (existující operace → busy → strop). Chyba výběru zařízení má dál přednost; předem
  spuštěná čtení mají `.catch` jen proti unhandled rejection.
- Uvnitř `assertManageAdmissible` / `assertEntryAdmissible` běží busy a strop souběžně,
  vyhodnocení v původním pořadí.
- Long-poll výsledku krok 25 ms místo 100 ms.
- TOCTOU okno mezi čtením a insertem se prodlouží o jednotky až desítky ms; busy,
  rozestup a strop nikdy atomické nebyly (jen jedinečnost operationId přes unikátní index).

Odhad: −2 až −3 kola DB (~50–100 ms) u posunu/vstupu, −~40 ms na výsledku.

## 10. Fáze 2 — pozice z workeru přímo do grafu (návrh, 30. 10. večer)

Filip po nasazení fáze 1: pozice se v grafu ukáže 1–2 s po vyplnění. Rozklad posledního vstupu
(19:49:35): broker fill 35,466 → worker zpracoval 35,953 (+0,49 s) → heartbeat do relaye
(+0,25–0,5 s) → poll/budíček + GET (+0,2–0,5 s). Broker ve streamu `netPrice` posílá (záznamy
29. a 30. 10.), cena vstupu je tedy hned.

### F2a — zašifrovaná expozice na tématu budíčku (jen zobrazení)
- Server: k tématu budíčku klíč `nudgeKey` = HMAC(`TV_PRICE_CHANNEL_SECRET`, `copier-nudge-enc:<deviceId>`)
  (32 B, base64url). Worker ho dostane v `realtime` (poll-v2, legacy poll), prohlížeč v GET statusu
  vedle `nudgeTopic` — jen při `connected`, nikdy neukládat, nelogovat.
- Controller: `exposure.builtAt` = čas sestavení (hodiny workeru) — jen řazení zobrazení.
- Worker (`macCopierCommandRelay`): po změně u brokera (`subscribeLiveChange`) hned, bez čekání na
  heartbeat, nejvýš 1× za 150 ms (trailing), pošle REST broadcast `event: 'exposure'` na téma budíčku:
  `{ v: 1, iv, ct }` = AES-256-GCM(`{ v: 1, startedAt, exposure, events }`), `events` = posledních
  ≤ 10 `recentCopyEvents`. Fire-and-forget, strop velikosti 64 KB (jinak neposlat), žádný await
  v poll smyčce ani u brzd (INV-WORKER-04). Budíček po heartbeatu zůstává.
- Prohlížeč (`useCopierStatusNudge`): událost `exposure` dešifruje (jeden slot „nejnovější“, viz níže),
  ověří tvar a předá; LIVE desk drží poslední zobrazovací expozici. Pro **graf a karty obchodů**
  (`useLiveChartData`, toasty) se použije sloučený status: když `startedAt` sedí a `exposure.builtAt`
  je novější než v pollovaném statusu, nahradí se `controller.exposure` (události se sjednotí); stáří
  viz „Po oponentuře“ bod 2 (kotva pollu), ne čas přijetí. Čerstvost stavu, ARM, povolení příkazů, brzdy a vše ostatní
  dál jen z pollovaného statusu (INV-FRESH-02/03, INV-UI-01/03). Jiný `startedAt` = zahodit.
- Odhad: fill → graf ≈ 0,5–0,8 s (z 1–2 s); zbývá hlavně zpracování fillu ve workeru (F2b).

### F2b — měření zpracování fillu ve workeru
- `tradovateBroker`: u emitovaného `fill` log `STREAM FILL acc=… brokerTs→frame … frame→emit …`
  (časová značka brokera, přijetí rámce, emit). Jen log, žádná změna chování. Podle čísel pak
  rozhodnout o odstranění REST dočítání (hydrate) v cestě streamu.
- `macCopierCommandRelay`: každý pokus rychlé expozice loguje jen technická čísla
  (`seq`, bajty, šifrování, HTTP, celkem a status), nikdy účet, pozici, téma ani klíč.
- Prohlížeč s `localStorage['at:dev:perf']='1'`: `live:exposure:decrypt`,
  `live:exposure:to-paint`, `live:chart:component-ready`, `live:chart:first-candles-data`,
  `live:chart:first-candles-paint`, historický/live snapshot a vzorkované `tick-to-paint`
  ve `window.__atPerf`.

### Dotčená pravidla
INV-RELAY-04 (téma budíčku nese zašifrovanou expozici jen pro zobrazení), INV-UI-03, INV-UI-01,
INV-FRESH-02/03 (nic z kanálu neautorizuje ani neposouvá čerstvost), INV-WORKER-04 (fire-and-forget),
INV-MANUAL-01 (průměr ani pozice z kanálu nevstupují do příkazu; příkazy dál z pollovaného statusu).

### Po oponentuře návrhu F2 (OPRAVIT PŘED IMPLEMENTACÍ → zapracováno)
1. Řazení `displaySeq` (monotónní za běh, na úrovni statusu agenta, vždy přítomné) + `displayBuiltAt`;
   novější poll vyhrává i s `exposure: null`; ne podle hodin.
2. `exposureObservedAt` jen pro overlay (`useLiveChartData.exposureObservedAt`); `workerFresh`,
   `statusFresh` a vše ostatní z pollu; slučuje se jen nad čerstvým pollem; stáří = kotva pollu
   + (builtAt − displayBuiltAt), nejvýš čas přijetí; zpráva z budoucnosti (> uplynulý čas + 1 s) pryč.
3. Worker: posluchač jen plánuje (setTimeout), 1 požadavek najednou, nejnovější stav, rozestup 150 ms.
4. Karty: sjednocení událostí podle id (poll ∪ kanál, max 20), nikdy nahrazení.
5. Klíč: v nevyhazující `tvPriceRealtimeFields`; `onRealtimeConfig` ho nedostane; desk ho maže při
   změně uživatele; AAD = téma; deterministický klíč zapsán do INV-RELAY-04.
6. Text: `expect` u správy z grafu je ze zobrazeného (sloučeného) souhrnu = „co uživatel viděl“;
   worker vyžaduje přesnou shodu s brokerem. `fresh`, `manageableLeaderTrades`, `entryAvgPrice`,
   `canClose` z pollu.
7. Prohlížeč: jeden slot „nejnovější“; `exposure` nekickuje poll.

### Po oponentuře diffu F2 (OPRAVIT PŘED COMMITEM → zapracováno)
- `copier.status` pro panel grafu dál z pollu; karty dostanou `copyEvents` zvlášť (hlídací test).
- Meze tvaru zprávy (čas v rozsahu Date, celá čísla, délky textů, typy polí událostí).
- Hook drží klíč v refu (odběr se při změně klíče neotevírá znovu).
- Události: u stejného id vyhrává verze z kanálu.
- BE skryté, dokud expozice z kanálu předbíhá poll (`manageEntryAvgPrice` null).
- Log fillu (`BROKER FILL …`) v try/catch.

## 11. F2c — souběžné ověření identity a connection lookup

Měření po fázi 1 ukázalo před vytvořením příkazu dalších ~0,2–0,28 s v úseku
`auth + resolve`. Původní cesta nejdřív celá čekala na `auth.getUser()` a teprve
potom spouštěla owner-scoped DB lookup připojení.

- Nejprve oficiální `auth.getClaims(accessToken)`: podpis, expirace a `sub` se
  kryptograficky ověří. Teprve potom se souběžně spustí owner-scoped DB lookup
  a čerstvé `auth.getUser(accessToken)` potvrzení. Odpověď čeká na obě větve.
- Čerstvá kontrola Auth serverem zůstala záměrně zachovaná: samotný platný JWT
  totiž nemusí odhalit relaci odvolanou z jiného zařízení. Optimalizace mění
  pořadí čekání, ne autorizační výsledek.
- U asymetrického klíče se veřejný JWKS po prvním načtení sdílí v paměti všech
  klientů v dané instanci a úvodní ověření je lokální.
- Ověřeno read-only proti současnému projektu: JWKS vrací jeden klíč `ES256`, takže
  rychlá cesta není jen teoretická. U legacy `HS256` auth-js automaticky volá
  `getUser()` a bezpečnostní chování zůstává stejné.
- Chybějící token, chyba podpisu nebo ověřené claims bez neprázdného `sub` dál
  končí `invalid-auth-token`; payload se nikdy jen slepě nedekóduje.
- Přesný zisk určí existující `Server-Timing`: `auth` nyní měří úvodní ověření a
  `resolve` kritickou cestu souběžného fresh-auth + DB lookupu. Očekávání je ušetřit
  kratší z těchto dříve sériových větví, ne slibovat pevnou latenci před měřením.
