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
