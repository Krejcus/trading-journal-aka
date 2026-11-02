# LIVE telefon — napojení dat: šipky plnění a upozornění na cenu (návrh, 2. 11. 2026)

Zadání Filipa (2. 11.): napojit data na nové UI LIVE grafu v iPhonu (větev `claude/phone-live-ui-20261101`,
handoff `docs/PHONE_LIVE_DATA_HANDOFF.md`). Úkol 1 (správa z čar) je hotový v kódu
(`TradovateLiveDesk.tsx` phoneTrade: `manage`/`closeSupported`/`entryAvg` přesně jako PC; `guardAt` přes
`withIbkrTightenMark`; testy `tests/livePhoneOrderLinesBehavior.test.ts`). Tento návrh = úkoly 2 a 3.
Mapa kódu (4 agenti, read-only): v session scratchpadu `map/*.json`; podstatné odkazy níže.

## Úkol 2 — šipky plnění (jen zobrazení)

**Dnes chybí** seznam jednotlivých plnění leadera kdekoli ve statusu (recentCopyEvents jsou přechody
pozice s časem workeru bez fillId; manualEntries timing jen průměr vlastních vstupů; recentClosedTrades
jen po zavření). REST read model `live.data.accounts[].fills` je pozdě a slučuje připojení bez dedupe.

**Návrh:**
1. Worker: čistý modul `services/copierLeaderDisplayFills.ts` (bez importu controlleru): kruh epizody
   leadera `{symbol, episodeId?, fromFlat, gap?, netAfter, fills[{fillId, orderId, at=BrokerFill.filledAt,
   price, side, quantity, role}]}`, max 40 řádků, dedupe fillId (omezená množina 500).
   `observe(fill, preNet, reducing)`: role entry/exit z **cache controlleru** `preclassifyLeaderFillExposure`
   (`leaderPreFillNetByEventId`, `leaderReducingQuantityByEventId`) — stejné rozdělení jako kopírka; preNet
   neznámé → `gap`; preNet 0 = nová epizoda `fromFlat`; flip → nová epizoda jen s entry částí.
2. Controller (`services/copierRuntimeController.ts`): instance vedle `recentCopyEvents`; v `handleBrokerEvent`
   hned za `preclassifyLeaderFillExposure(event.fill)` **synchronně v try/catch** `observe(...)`;
   po `trackLeaderFill` (také try/catch) jen `setEpisodeId`; resync gapFills → `markGap()`; změna leadera/
   retiredGroup → `reset()`; status `controller.leaderFills` (kopie). `trackLeaderFill`, dailyStats,
   persistSafety beze změny. Nic durable.
3. Exposure push (`lib/copierLiveExposure.ts`, `server/macCopierCommandRelay.ts`): `leaderFills` ve stejné
   zprávě jako exposure (stejné `seq`), validátor s mezemi; merge bere kanál jen když je novější, chybějící
   pole = hodnota z pollu (starý worker).
4. Web: čistá `liveFillMarkersFromStatus` (`lib/liveFillMarkers.ts`): nic, pokud stav není čerstvý/obnovený,
   expozice starší než 8 s (`WORKER_EXPOSURE_MAX_AGE_MS`), `connected=false`, exposure null, epizoda není
   `fromFlat` nebo má `gap`; `open` z autoritativní expozice leadera (znaménko ≠ `netAfter` → `undefined`
   = skryto, nikdy „flat“). Desk: slot `fills`/`fillsOpen`.
5. Deník: v `LivePhoneChart` skrýt plnění, jejichž `fillId` už je v `executionHistory` obchodů dne
   (deník bere id plnění Tradovate = `BrokerFill.fillId`); jen dnešní den.

**INV:** INV-TRAD-06 (jen route leadera, router filtruje účty + dedupe fillId), INV-TRAD-01 (resync
gapFills nikdy jako živé šipky → `gap`), INV-WORKER-04 (odposlech synchronní, try/catch, omezená paměť,
nic nečeká na eventTail), INV-RELAY-04 + INV-FRESH-02/03 (kanál jen zobrazení, řazení startedAt+seq),
INV-UI-01/03 (obnovený/starý stav nikdy jako aktuální), INV-UI-04 (cena/čas jen z broker fillu),
nic zobrazovacího neautorizuje příkaz (fills nikdy do phoneTrade/relay).

## Úkol 3 — upozornění na cenu (telefon teď, PC potom)

**Rozhodnutí (výchozí, k oponentuře):**
- **DB (migrace přes supabase-migrate, bez db push, až se souhlasem):**
  - `price_alerts` (PK `(user_id, id)`, vzor `chart_drawings`): owner sloupce (symbol MNQ/NQ, price, condition
    cross|up|down, `condition_auto`, frequency once|every, expiry session|gtc, line, channels, note, edited_at,
    deleted_at = měkké mazání) + stav spouštění (status active|triggered|expired, last_triggered_at,
    last_trigger_price, trigger_count, `expires_at`). Triggery: vlastník nemůže měnit stav spouštění kromě
    re-armu `status='active'` (úprava/posun spuštěného „jednou“ ho znovu zapne jako TradingView); LWW podle
    edited_at; tombstone konečný; strop 50 aktivních/uživatel; `expires_at` pro `session` = nejbližší
    17:00 America/Chicago pracovního dne (svátky vědomě ne).
  - `price_alert_events` (trigger_id unique, cena, observed_at, front, source 'ibkr', enqueued_at,
    suppressed_reason) — RLS select vlastník, zápis jen přes RPC.
  - `price_alert_defaults` (user_id PK, jsonb), RLS vlastník.
  - RPC `trigger_price_alert(p_user, p_alert, p_version, p_trigger_id, p_price, p_observed_at, p_front)`:
    `for update`, odmítne když není active / vypršelo / jiná verze (edited_at) / `every` < 60 s; jinak
    `once` → triggered, zápis události; stejné trigger_id = vrátí existující (idempotence).
  - `notification_delivery` (nebo stávající tabulka fronty) + sloupec `category` (default 'general'),
    drain stávajících volajících `category <> 'price-alert'` → upozornění nikdy nehladoví rizikové
    notifikace; vlastní rozpočet 20 / 10 min / uživatel (`consume_price_alert_budget`), přebytek se uloží
    jako událost bez pushe (`suppressed_reason`).
  - Realtime: `price_alerts`, `price_alert_events`, `price_alert_defaults`.
- **Mac worker:** nové vlákno `scripts/copier/priceAlertWatchThread.ts` (worker_threads, resourceLimits),
  supervisor `server/priceAlertWatchSupervisor.ts` (sémantika `tvPriceStreamSupervisor`: nikdy nevyhodí,
  jistič 3 pády/10 min, liveness 15 s). Ticky: vlákno ceny posílá přes **MessageChannel** souhrn dávky
  IBKR obchodů (prev/min/max/last, ≤ 10×/s) jen když je zdroj IBKR živý; **TV nikdy nespouští**.
  Vlákno nemá secret zařízení ani přístup ke kopírce/brokeru/relayi — jen odvozený HMAC klíč
  (`priceAlertWatchGrant`, label `price-alert-watch-sign`) z realtime konfigurace poll-v2.
  Křížení čistou funkcí `lib/priceAlertCross.ts` (up: prev < P ≤ max; down obráceně; cross obojí);
  baseline reset při výpadku IBKR, změně frontu, mezeře > 15 s, startu, změně verze upozornění;
  automatický směr se přepočítá z IBKR (`condition_auto`), ruční volba platí. Opakování jen transportní se
  stejným trigger_id. Za výchozí stav vypnuto: flag instalace `--price-alerts on`.
- **Server:** `api/price-alerts/watch.ts` (arn1): podpis zařízení ±60 s, zařízení neodvolané a s
  heartbeatem ≤ 30 s; akce `list` (aktivní, nevypršelé) a `trigger` (RPC → zařazení notifikace
  `price-alert:<id>:<triggeredAt>` kategorie price-alert, APNs/web push podle channels, route `live:chart`).
  Záloha v cronu `send-alerts` ZA sekcí kopírky (vlastní try/catch).
- **Klient:** `services/priceAlertServerStore.ts` se stejným rozhraním `PriceAlertStore` (optimistické
  úpravy, LWW, offline cache v localStorage, jednorázový import lokálních upozornění), `alertEvents`
  z realtime událostí, `alertWatch` jen z čerstvého statusu (`priceAlertWatch.state==='watching'`, ≤ 8 s,
  nikdy z cache). Hlas: nativní `speak` (AVSpeechSynthesizer, ducking) v pluginu, web `speechSynthesis`.
  Strop karet upozornění, aby nevytlačily kartu rizika. PC až potom.

**INV:** INV-WORKER-04 (oddělená doména selhání, nesmí zdržet relay poll ani brzdy; vlákno bez přístupu
k příkazům), INV-WATCH-01 (upozornění nikdy neřídí execution; kategorie a dedupe oddělené od incidentů
kopírky, rizikové dál otevírají `live:overview`), INV-UI-04 (IBKR jen pro spuštění upozornění = zobrazení
/ notifikace, nikdy do rizika ani příkazů; TV nikdy), INV-RELAY-04 (nový kanál nenese příkazy),
INV-UI-01..03 (`alertWatch` jen z čerstvého stavu), INV-WORKER-03 (klíč odvozený ze zařízení, odvolání
zařízení = konec přístupu).


## Po oponentuře návrhu (2. 11.) — úkol 3 přepracován

Verdikt: úkol 1 OPRAVIT (P7 opraveno: klíč potvrzení × včetně akce), úkol 2 OPRAVIT (P8–P10
zapracováno), úkol 3 BLOKUJE (P1) → změny:

- **P1 INV-UI-04:** cena z IBKR se NIKAM neukládá ani neposílá. Upozornění hlásí úroveň, kterou
  zadal uživatel („MNQ nahoru přes 21 480“); DB/Realtime/push nesou jen úroveň, směr a časy
  (`triggered_at`, `observed_at`). IBKR jen rozhoduje o spuštění (kryté INV-UI-04 výjimkou pro
  hlídání = zobrazení/notifikace).
- **P2 INV-WATCH-01:** vlastní tabulka `price_alert_outbox` a vlastní drain (sdílené jen funkce
  APNs/web push). Na `notification_delivery_outbox` ani `drainNotificationDeliveries` se nesahá →
  žádné riziko pořadí nasazení pro rizikové notifikace; relay `background-v2` upozornění nikdy
  nerozesílá. APNs `apns-collapse-id = price-alert:<id>`, nikdy `time-sensitive`, rozpočet 20/10 min.
  v1 trasa `route:'live'` (přehled) — starý iOS build `live:chart` nezná.
- **P3:** `version bigint` (trigger +1 při každé změně vlastníka), RPC porovnává verzi.
- **P4:** `unique(user_id, trigger_id)`; existence ověřena až po `for update`; duplicita vrátí
  existující jen při shodě `user_id` + `alert_id`; `p_user` jen ze zařízení na serveru;
  `p_observed_at` ořez ±5 min; `revoke execute … from public, anon, authenticated`.
- **P5:** vlastník `status` nikdy nemění; znovuzapnutí jen RPC `rearm_price_alert(id, expected_trigger_count)`
  (klient ho volá při úpravě/posunu spuštěného „jednou“); klient `status` neposílá.
- **P6:** vlákno ceny se nemění kromě rozšíření stávající zprávy `quote` (250 ms) o `min`/`max`/`prev`
  dávky (jen čísla, try/catch); hlavní vlákno ji přepošle vláknu upozornění (`postMessage`, bez
  čekání). Vlákno upozornění: `env: {}`, allowlist importů (bez fs/child_process), jeden request
  v letu, `AbortSignal.timeout`, exponenciální backoff, souhrnné logy; `status()` supervisora
  obranně (`null` při výjimce); `alertKey` přes vlastní callback (ne `onRealtimeConfig`), label
  `price-alert-watch-sign`, MAC přes `ts + akce + sha256(body)`, `timingSafeEqual`; odvození v
  poll-v2 v try/catch (pole chybí).
- **P11:** `alertWatch` „hlídá“ jen při zdroji IBKR, `syncAt` a `priceAt` ≤ 15 s; hlas/karta jen pro
  události mladší 30 s; ztracená křížení (výpadek IBKR, spánek Macu) přiznat v UI; žádný tvrdý
  purge (DELETE realtime obchází RLS); migrace `set lock_timeout`, PGlite test vč.
  `force_generic_plan` a DST hranic `expires_at`.
