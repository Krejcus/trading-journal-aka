# Rychlejší fronta relaye, zavření × a poplatky v denním limitu — návrh (2. 11. 2026)

Filip 2. 11. po DEMO měření: „Všechny tři z ‚Co by pomohlo‘“ — (1) fronta relaye,
(2) ověření flat u zavření ×, (3) poplatky v denním limitu. Měření:
`docs/reviews/night-conformance-20261102.md`.

## 1. F1b′ — server naváže příkaz za nečinný worker a pošle ho podepsaný

### Výchozí stav (měřeno 2. 11.)

insert (admission RPC) → relay pošle prázdný `kick` (Supabase broadcast, REST) → worker
`poll-v2` (Mac → Vercel arn1 → `claim_tradovate_copier_command_v2`) → execution.
`created→claimed` p50 276 ms (Market, n=11), z toho kick dorazí ~200 ms po insertu
a claim REST trvá ~170 ms (log `RELAY KICK přijat` → `RELAY CMD queueMs`).

### Proč původní F1b neprošel (30. 10.) a co se mění

| Nález 30. 10. | Řešení F1b′ |
|---|---|
| 1. Restart s nerotující delivery | Worker `deliveryId` už nerotuje po každém prázdném pollu: checkpoint `{phase:'polling', deliveryId}` zůstává, dokud k němu DB nenaváže příkaz. Po restartu se poll vede se stejným id (dnešní logika `session !== session` → příkaz se NEprovede, ACK `command-outcome-unknown-worker-session-changed`; ne-brzda vytvořená před startem → `command-expired-or-predates-worker-session`). |
| 2. Věčné `claimed` po navázání a pádu | Server váže jen na delivery, kterou worker právě ohlásil (`status.relayIdle`) při `last_seen_at` ≤ 4 s a `status.startedAt` = aktuální instance. Ohlášené id je vždy už durable v checkpointu (zápis před heartbeatem), takže restart ho znovu polluje a řádek uzavře. Ztráta checkpoint souboru = stejné riziko jako dnes u claimu těsně před pádem. |
| 3. Posun hodin z pushe | `serverNow` z pushe se ignoruje. Offset hodin a rezerva se berou z posledního úspěšného `poll-v2` (měřený midpoint); bez vzorku mladšího 60 s se push zahodí a čeká se na poll. |
| 4. Klíč pushe = oprávnění k execution | Podpis **Ed25519**: soukromý klíč existuje jen na serveru (deterministicky odvozený z `TV_PRICE_CHANNEL_SECRET` + `deviceId`, štítek `copier-push-ed25519`), worker dostane jen **veřejný** klíč v `realtime` konfiguraci autentizovaného `poll-v2`. Únik čehokoli z workeru ani z prohlížeče neumožní podvrhnout příkaz. Push navíc nenese nic, co by DB nevydala: je to přesně řádek, který `claim_v2` právě navázal k delivery workeru. |
| 5. Zúžené okno brzd | Navázání běží stejnou RPC jako poll workeru (advisory lock zařízení, přednost brzd + Flatten, FIFO). Brzda zařazená dřív než navázání má přednost jako dnes; brzda zařazená po navázání pravidla INV-RELAY-03 bod 5 („claimed před brzdou se provede“). Mění se jen délka okna, kdy čekající vstup ještě stihne supersede (dnes 0–750 ms podle pollu, nově ~0). Workerová pojistka `brake-after-request` a ARM brána beze změny. |

### Tok

1. **Worker** (`recoverableCopierDelivery`): prázdný poll checkpoint nemaže, **pokud patří
   této session**; `polling` checkpoint cizí (předchozí) session se po prázdném pollu
   vymění za nový (jinak by každý další příkaz po restartu skončil „session změněna“).
   Po ACK se rovnou uloží nový `polling` checkpoint (nové id) a `publishStatusSoon`.
   Aktuální nečinné id hlásí status `relayIdle: { deliveryId }` jen pro durable `polling`
   checkpoint této session; GET statusu pro prohlížeč pole vynechá.
2. **Server** (`POST` enqueue, po úspěšné admission/brzdě a po kicku — kick zůstává jako
   záloha): přečte jen `status->relayIdle`, `started_at`, `last_seen_at` zařízení. Platí-li
   `last_seen_at` ≤ 4 s, `status.startedAt` = `started_at` a id je UUID → zavolá
   `claimTradovateCopierCommandV2(device, relayIdle.deliveryId)` (existující RPC, žádná
   migrace). Vrácený řádek ve stavu `claimed` (libovolný — RPC vybere FIFO hlavu
   s předností brzd) pošle na téma `copier-push-<HMAC>` událost `cmd`:
   `{ body, sig }`, `body = JSON.stringify({ v:1, deviceId, deliveryId, command })`
   (`command` = tvar `poll-v2`), `sig` = Ed25519(body). Jakákoli chyba = nic (kick a poll
   jako dnes); nikdy 5xx kvůli pushi.
3. **Worker** zprávu ověří (podpis, `v`, `deviceId`, `deliveryId` = aktuální checkpoint
   ve fázi `polling`, řádek `claimed`) a uloží do jednoprvkové schránky + probudí smyčku.
   `delivery()` místo HTTP `poll-v2` použije schránku jen při shodě `deliveryId`
   a čerstvém vzorku hodin; zbytek automatu beze změny (persist `executing` → execute →
   persist `completed` → `complete-v2` → rotace). Pozdní/duplicitní push (jiné id, fáze
   ≠ `polling`, id v `started`) se tiše zahodí. Ztracený push = poll se stejným id vrátí
   vázaný řádek (první větev `claim_v2`).
4. Kanál nenese ARM/DISARM rozhodnutí ani stav; jen transport už durable navázaného
   řádku. INV-RELAY-04 se upraví výslovnou výjimkou.

### Odhad

`created→start execution` ~276 + 66 ms → ~120–150 ms (claim RPC uvnitř relaye + broadcast).

## 2. Zavření × — kratší cesta k brokerovi, ověření beze změny

Dnes (`prepareManualOrderAction` + `executeClose`): REST order graf před zápisem (213 ms,
jediné, co audit ukazuje) → `liquidatePosition` (`/position/list` + POST) → čekání na
stream flat ≤ 2 s → REST `/position/list` + order graf (vždy) → `acknowledged`. Worker
1,29 s; × v grafu ale mizí podle streamu expozice (F2a), ne podle ACK — viditelnou
rychlost určuje cesta **před** POSTem.

Změna:
1. **Pre-read přes stream snímek** jako u posunu SL/TP (`streamOrderSnapshot` + shoda
   s `liveOrdersByAccount` + route epocha; jinak REST jako dnes). Pre-read u zavření jen
   kontroluje tvar obchodu (vstup/SL/TP patří obchodu, `closeReachBlockers`); o výsledku
   rozhoduje výhradně následné ověření. Odhad −200 ms před POSTem.
2. **Beze změny:** `/position/list` uvnitř `liquidatePosition` (čerstvá Position entity =
   ochrana před opačným Marketem na už flat účtu, `already-flat` → `waived`), čekání na
   stream a **povinné REST ověření** flat ∧ nic nepracuje (INV-MODE-02, INV-MANUAL-01 2d).
   Snímek dál nikdy pro důkaz flat/no-working, ARM, reconcile ani Flatten.
3. **Měření:** audit zavření doplní `zápis` (POST), `stream flat` a `ověření rest` ms, aby
   bylo vidět, kde čas leží.

## 3. Poplatky v denním limitu — přísnější z ledgeru a brokera

Dnes `dailyStats.realizedPnlUsd` = hrubý ledger leadera z fillů (cena × point value), bez
poplatků. Z něj jede denní ztráta skupiny (`evaluateDailyRules`: zámek/pauza při limitu,
80 % varování) a blokátor náhledu `daily-loss-limit` + poznámka `group-daily-loss`.
Kontrola SL vůči limitu (`remainingLossHeadroom`) už bere čisté P&L brokera. Měřeno 2. 11.:
ledger −99,50 vs. broker −150,80 USD po 14 obchodech.

Změna: **ztráta pro denní pravidla = min(hrubý ledger, čisté realizované P&L leadera od
brokera)**. Broker hodnota se použije jen, když je snímek leadera:
- z téže broker session jako statistiky (`sameTradovateSession(verifiedAt, sessionEndAt − 1)`),
- ne starší než `ACCOUNT_RISK_STALE_MS` (90 s) a bez chyby,
- s `cashBalance.tradeDate` rovným obchodnímu dni session (oponentura P1: po 17:00 CT
  nesmí nevynulovaná včerejší ztráta zamknout nový den; bez `tradeDate` = ledger).
Jinak samotný ledger (dnešní stav — nikdy volnější než dnes). Platí pro `daily-loss`
zámek/pauzu i 80 %, blokátor `daily-loss-limit` a poznámku `group-daily-loss`.
Počet ztrátových obchodů zůstává z ledgeru (INV-RISK-02: limity se nezaměňují).
Status přidá `dailyStats.lossPnlUsd` (hodnota použitá pro limit) a `lossPnlSource`
(`ledger` | `broker`) — jen zobrazení. Broker realized je celoúčtový (i obchody mimo
appku) → jen přísnější. Snímek se po každém fillu skupiny vynutí (dnes) a pravidla se
vyhodnotí na dalším heartbeatu brokera.

## 4. Dotčená pravidla

| INV | Dopad |
|---|---|
| INV-RELAY-04 | Výjimka: podepsaný (Ed25519) transport řádku, který `claim_v2` už navázal; bez podpisu/shody = zahodit. |
| INV-RELAY-02 | Push vstupuje do stejného automatu před `executing`; nic se neopakuje. |
| INV-RELAY-03, INV-BRAKE-03 | Navázání stejnou RPC (přednost brzd); bod 5 — kratší okno supersede. |
| INV-RELAY-01, INV-OUTBOX-01 | Beze změny (admission, TTL, jeden durable výsledek). |
| INV-WORKER-03/04 | Veřejný klíč přes autentizovaný poll; push mimo kritickou cestu brzd. |
| INV-FRESH-03 | Navázání jen nad čerstvým runtime (≤ 3 s, stejná instance). |
| INV-MANUAL-01 (2d, zrychlení posunu) | Stream snímek nově i pro pre-read zavření; důkaz flat dál jen REST. |
| INV-MODE-02 | Beze změny (stav po `liquidateposition` přes REST). |
| INV-RISK-01, INV-RISK-02 | Denní ztráta = přísnější z ledgeru a čerstvého broker snímku téže session; počty obchodů beze změny. |
| INV-BRAKE-04 | Beze změny (day lock až po flat). |

## 5. Po oponentuře návrhu (2. 11. dopoledne) — zapracováno

- F1b′ P1-A: `relayIdle` jen po potvrzeném zápisu checkpointu (`polling`, tato session);
  checkpoint staré session se mění jen po prázdném pollu; test restart → nový id → příkaz
  se provede (`tests/copierCommandPushDelivery.test.ts`).
- F1b′ P1-B: `server/copierCommandPushRelay.ts` — souběžně s kickem a long-pollem, každý
  krok (čtení runtime, claim, broadcast) s vlastním `AbortSignal` 1 s, nikdy nevyhodí;
  odpověď 202 čeká na push nejvýš 300 ms po long-pollu (`tests/copierCommandPushRelay.test.ts`:
  zavěšený claim → `failed` do limitu).
- F1b′ P1-C: push jde stejným automatem; testy obou pořadí, pozdního pushe, staré session,
  příkazu staršího než session, bez vzorku hodin.
- F1b′ P2: okno brzdy zapsáno do INV-RELAY-03 bod 5; ověřování podpisu jen nejnovější zprávy
  ve smyčce (záplava podvrhů nepřidá ověření); práh runtime 4 s; uspaný Mac v INV-FRESH-03;
  vlastní tajemství pro podpis = změna secrets → čeká na Filipův souhlas.
- Zavření: INV-MANUAL-01 upraveno, testy snímek nesedí → REST a změna route epochy → `not-sent`.
- Poplatky P1: `realizedTradeDate` z `cashBalance.tradeDate`; test přelomu session.

## 6. Po prvním DEMO běhu (2. 11. 09:03) — pořadí kicku

Naostro push vyhrál jen 2 ze 4 horkých příkazů: kick dorazil dřív, worker si příkaz vzal pollem
(fronta 399–439 ms) a push zahodil. Úprava (critic OK s P2, zapracováno): vstup, náhled a posun
SL/TP z grafu pošlou kick až po pokusu o push (`scheduleCopierKickAfterPush`: neúspěch hned,
po pushi +250 ms, nejpozději 400 ms, s výsledkem už ne). Brzdy, Flatten, ARM a risk-redukční
správa (`close-position`, `cancel-entry`, `attach-brackets`) kick hned. Odpověď na kick ani push
nečeká déle než 300 ms po výsledku. Testy: `tests/copierCommandPushRelay.test.ts`.

## 7. Měření na DEMO (2. 11. 09:03–09:18, worker `a83a214a`, web/relay `ed17d09b`)

4 round tripy 1 MNQ (vstup, posun SL, posun TP, ×), vše `succeeded`, flat, DB audit: 12 příkazů,
vše `leaderAccountId 61038658`, `MNQZ6`. Fronta = zařazení (DB `created_at`) → start execution
ve workeru (`RELAY CMD queueMs`; DB `claimed_at` už neměří worker — váže server).

| cesta | n | hodnoty (ms) | medián |
|---|---|---|---|
| push (F1b′) | 6 | 188, 187, 279, 226, 418, 236 | ~231 |
| kick + poll (nový kód) | 6 | 439, 399, 277, 229, 188, 290 | ~284 |
| ráno před změnou (kick + poll) | 11 | log `queueMs` | ~330 |

- Push na serveru ~90–105 ms (čtení runtime + claim RPC + broadcast za sebou, Server-Timing)
  + Realtime na Mac ~100 ms. Ušetří claim REST workeru (~170 ms), ale polovinu vrátí. Zisk proti
  ránu ~100 ms, ne očekávaných ~150–200 ms. Push vyhrál 6 z 12 (po úpravě pořadí kicku 4 z 8).
- **Další krok (vyžaduje migraci = souhlas):** navázání v téže transakci jako atomická admission
  (`admit_tradovate_copier_manual_command` vrátí rovnou vázaný řádek k `relayIdle`) a čtení
  runtime souběžně s admission → server ~40 ms místo ~100 ms; přerušit rozběhnutý poll workeru
  při příchodu pushe (dnes až +170 ms, když push dorazí během pollu).
- **Zavření ×:** pre-read ze snímku 1–2 ms (dřív REST 213 ms); worker celkem 1,07–1,14 s (dřív
  p50 1,29 s); audit: zápis 341–373 ms (`/position/list` + POST), stream flat 504–508 ms, REST
  ověření 210–244 ms.
- **Poplatky:** Tradovate DEMO posílá `cashBalance.tradeDate` (2026-11-02) → `lossPnlUsd` −146
  (`broker`) proti ledgeru −89; limit 250 USD tak počítá skutečnou ztrátu.

## 8. Zrychlení bez migrace (2. 11. odpoledne, Filip: „Ano udělej“)

Migraci (navázání v admission RPC) jsem nedoporučil: mění atomickou admission, která hlídá
i brzdy, a nasazuje se ručně (rozešlá historie) za ~60 ms. Místo ní:
1. **Předčtení `relayIdle` souběžně s admission** (`readCopierRelayIdle` podle uživatele +
   připojení; push ho použije jen při shodě `deviceId`, jinak čte sám). Nikdy nevyhodí. Zastaralé
   předčtení (rotace mezi čtením a claimem) = claim vrátí hotový řádek → žádný push, kick.
2. **Ověřený push přeruší běžící poll** workeru (dřív až +RTT pollu ~170 ms). Jen po ověřeném
   podpisu, jen pro aktuální nečinnou delivery, nejvýš jedno ověření za běžící poll — podvrh ani
   starý push poll nezastaví (jinak by záplava zpráv mohla blokovat i doručení brzd). Přerušený
   poll není selhání (bez backoffu); další kolo vezme push, nebo poll se stejným id vrátí tentýž
   řádek (claim je idempotentní). Testy: `tests/copierPushAbortsPoll.test.ts`,
   `tests/copierCommandPushRelay.test.ts`.
- P2 (oponentura diffu): ověřený push přeruší poll nejvýš jednou pro danou delivery — přehrávání téže zprávy nezastaví polly ani obnovu hodin.

## 9. Měření po zrychlení bez migrace (2. 11. 09:44–09:47, web/relay + worker `8652e136`)

| verze | n | fronta (ms) | medián |
|---|---|---|---|
| ráno před změnou (kick + poll) | 11 | log `queueMs` | ~330 |
| F1b′ (`ed17d09b`) — push | 6 | 188, 187, 279, 226, 418, 236 | ~231 |
| + přerušení pollu (server bez předčtení) | 4 | 316, 282, 217, 250 | ~266 |
| + předčtení `relayIdle` (`8652e136`) | 4 | 181, 236, 156, 208 | **~194** |

- Všech 8 horkých příkazů po úpravě kicku prošlo pushem. Server: push 133–146 ms od zařazení
  (claim RPC + broadcast), Realtime na Mac ~40–80 ms. Proti ránu −~135 ms (~40 %).
- Malé vzorky (n=4) a různé chvíle trhu — čísla berte jako orientační.
- **Nález (zobrazení, ne bezpečnost):** 2× `market-quote-drift` — lístek ukazoval bid/ask
  28 761,50/75 s „před 0 s“, TradingView 28 763,75 (9 ticků). `useLiveTicketQuote` bere jako
  čas ceny příchod jakékoli notifikace kanálu, ne změnu ceny → údaj o stáří může lhát. Worker
  má vlastní čerstvou IBKR cenu a drift gate nic nepustil. **Opraveno `915bb2dd`:** skutečná
  příčina byla animace přehrání ticků — bez `requestAnimationFrame` (skrytý panel/karta na
  pozadí) uvízla v dokreslení a `current()` vracel starou svíčku. Panel objednávky (a hlídač BE)
  bere `feed.final(root)` bez přehrání. Ověřeno na produkci ve skrytém panelu: lišta 28 752,75
  vs. TradingView 28 752,50 (1 tick).
- Konec 09:48 DISARMED, flat, DB audit od 08:40 UTC: 10 příkazů, vše 61038658 / MNQZ6, `succeeded`.
