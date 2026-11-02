# Upozornění na cenu — smlouva rozhraní (2. 11. 2026)

Závazná pro implementaci úkolu 3 (`docs/reviews/phone-live-data-design-20261102.md`, sekce „Po oponentuře
návrhu“). Každý díl implementuje jen své soubory; rozhraní mezi díly jsou přesně tato.

## A. DB — `supabase/migrations/20261102140000_price_alerts.sql` (+ `tests/sql/priceAlerts.pg.mjs`)

- `public.price_alerts` PK `(user_id, id)`; `user_id uuid not null default auth.uid() references auth.users on delete cascade`;
  `id text` (`^pa-[0-9a-z-]+$`, 4–64); `symbol text` in ('MNQ','NQ'); `price numeric(12,2)` (> 0);
  `condition text` cross|up|down; `condition_auto boolean not null default false`; `frequency` once|every;
  `expiry` session|gtc; `expires_at timestamptz` (null = gtc); `line jsonb`, `channels jsonb` (objekty ≤ 512 B);
  `note text` ≤ 80; `status` active|triggered|expired default active; `version bigint not null default 1`;
  `last_triggered_at timestamptz`; `trigger_count int not null default 0`; `edited_at`, `deleted_at`,
  `created_at`, `updated_at` timestamptz. **Žádná cena z IBKR** (INV-UI-04).
- Triggery (security invoker, `search_path ''`):
  - insert vlastníkem: stav spouštění vynucen (active, null, 0), `version=1`, strop 50 neodstraněných
    (advisory lock na uživatele, upsert existujícího řádku projde), `expires_at` = pro `session` nejbližší
    17:00 America/Chicago po `now()` v pracovní den (Po–Pá; DST přes `at time zone`), pro `gtc` null.
  - update vlastníkem: `user_id/id/created_at` z old; LWW (`edited_at` < old → return old); tombstone konečný;
    stav spouštění (`status`, `last_triggered_at`, `trigger_count`) **vždy z old** (rozlišeno podle
    `current_user = 'authenticated'`; RPC `security definer` běží jako vlastník funkce, takže rearm
    a spuštění trigger pustí — viz pravidlo v hlavičce migrace); změna některého
    z polí symbol/price/condition/condition_auto/frequency/expiry/deleted_at → `version = old.version + 1`
    a přepočet `expires_at`.
  - update jinou rolí než `authenticated` (definer RPC, service_role): všechna pole vlastníka z old;
    smí měnit jen stav spouštění, `version` a `expires_at`.
- `public.price_alert_defaults` (user_id PK, `defaults jsonb` ≤ 2048 B, edited_at, updated_at), LWW, RLS vlastník.
- `public.price_alert_events`: `id uuid pk default gen_random_uuid()`, `user_id`, `alert_id text`, `trigger_id uuid`,
  `level numeric(12,2)` (= úroveň upozornění v okamžiku spuštění), `condition text`, `front text`,
  `observed_at timestamptz` (ořez ±5 min od now()), `triggered_at timestamptz default now()`,
  `suppressed_reason text`; `unique(user_id, trigger_id)`. RLS select vlastník; zápis jen RPC.
- `public.price_alert_outbox` (jen service_role): `id uuid pk`, `user_id`, `event_id uuid references price_alert_events`,
  `channel text` apns|web, `target_id uuid` (subscription), `title text`, `body text`, `status` pending|sent|failed|dead,
  `attempts int`, `next_attempt_at`, `created_at`, `sent_at`, `error text`; `unique(event_id, channel, target_id)`.
- RLS: price_alerts select/insert/update vlastník (bez delete — měkké mazání); service_role select/update.
- Realtime: `price_alerts`, `price_alert_defaults`, `price_alert_events`.
- RPC (všechny `revoke execute … from public, anon, authenticated`, kromě rearm):
  - `trigger_price_alert(p_user uuid, p_alert text, p_version bigint, p_trigger uuid, p_observed_at timestamptz, p_front text)`
    returns `table(event_id uuid, status text, triggered_at timestamptz, frequency text)`; status
    `triggered` | `duplicate` | `rejected:<důvod>`; `for update` řádku; duplicita až po zámku a jen při shodě
    user+alert; odmítne: není active, `deleted_at`, vypršelo (`expires_at <= now()` → označí expired),
    jiná verze, `every` a `last_triggered_at > now()-60s`; `once` → triggered; zapíše event.
    `set lock_timeout`, `force_custom_plan` přes `set plan_cache_mode = force_custom_plan` ve funkci.
  - `rearm_price_alert(p_alert text, p_expected_trigger_count int)` returns boolean — security definer,
    `search_path ''`, `where user_id = auth.uid()` + shoda `trigger_count`; jen status triggered|expired → active,
    version+1, přepočet expires_at; `execute` jen `authenticated` (revoke public, anon).
  - **Spuštění `version` nemění** (jinak by „pokaždé“ odmítalo vlastní další spuštění do příštího `list`);
    verzi zvedá jen úprava vlastníkem a rearm. Vlákno drží stav podle dvojice (id, verze).
  - Rozpočet 20 notifikací / 10 min / uživatel je uvnitř `trigger_price_alert` (advisory zámek na
    uživatele; nad rozpočtem `suppressed_reason='budget'` a žádná fronta) — samostatné RPC není.
  - `expire_price_alerts(p_user uuid default null)` — active s `expires_at <= now()` → expired.

## B. Server — klíč, endpoint, outbox

- `server/priceAlertWatchKey.ts`: `priceAlertWatchGrant(deviceId, secret = process.env.TV_PRICE_CHANNEL_SECRET)`
  → `{ key }` (HMAC-SHA256 base64url, label `price-alert-watch-sign:<deviceId lower>`), nikdy nevyhodí (null).
  `signPriceAlertWatchRequest({deviceId, key, action, body, ts})` → hlavička
  `X-AlphaTrade-Alert-Auth: v1.<deviceId>.<ts>.<mac>`; mac = HMAC(key, `${ts}\n${action}\n${sha256hex(body)}`);
  `verifyPriceAlertWatchRequest(header, action, body, now, secret)` → `{deviceId}` | null (±60 s, `timingSafeEqual`).
- `api/tradovate/oauth/copier-relay.ts`: vlastní funkce jen pro poll-v2 (NE ve sdílené `tvPriceRealtimeFields`,
  kterou čte poll, poll-v2 i `background-v2`) → `priceAlert: { key, deviceId }` (try/catch; chyba = pole chybí).
  Test: odpověď prohlížeči (GET) `alertKey` nikdy neobsahuje.
- `api/price-alerts/watch.ts` (POST, JSON, region arn1 jako ostatní DB-only funkce):
  - autentizace hlavičkou; zařízení `tradovate_copier_devices` neodvolané; runtime heartbeat ≤ 30 s.
  - `{action:'list'}` → `{ alerts: [{ id, symbol, price, condition, conditionAuto, frequency, version, expiresAt }], serverNow }`
    (jen active, neodstraněné, nevypršelé; nejdřív `expire_price_alerts(user)`).
  - `{action:'trigger', triggers: [{ alertId, version, triggerId, observedAt, front }]}` (≤ 10) →
    `{ results: [{ triggerId, status }] }`; po `triggered` → `consume_price_alert_budget` → zařadit outbox
    (channels.phone → `native_push_subscriptions` APNs, channels.pc → `push_subscriptions` web) nebo
    `suppressed_reason='budget'`; pak omezený drain těchto řádků (try/catch, nikdy 5xx kvůli doručení).
  - Text: titulek `MNQ nahoru přes 21 480,00` (podle condition: „nahoru přes“ / „dolů přes“ / „přes“, úroveň uživatele),
    tělo = poznámka nebo „Upozornění na cenu“; data `{ route: 'live', category: 'price-alert', alertId, eventId }`;
    APNs `apns-collapse-id = price-alert:<alertId>`, `interruption-level` active, zvuk podle channels.sound.
- `server/priceAlertOutbox.ts`: `enqueuePriceAlertDeliveries`, `drainPriceAlertOutbox({db, limit, ids?})` — sdílí jen
  `sendApnsNotification` (server/apns.ts) a web push funkci (vytáhnout z `api/cron/send-alerts.ts` do `server/webPush.ts`).
  `notification_delivery_outbox` / `drainNotificationDeliveries` se NEMĚNÍ.
- `api/cron/send-alerts.ts`: ZA sekcí kopírky, vlastní try/catch: `expire_price_alerts()` + `drainPriceAlertOutbox`.

## C. Mac worker

- `scripts/copier/tvPriceStreamThread.ts`: stávající zpráva `{type:'quote', ...}` (250 ms, jen IBKR živě) dostane
  `batch: { prev: number|null, min: number, max: number, last: number }` = obchody od minulé zprávy quote
  (`prev` = poslední cena před nimi); try/catch, jinak beze změny.
- `server/tvPriceStreamSupervisor.ts`: volitelný posluchač `onQuoteBatch?(quote)` — jen ve větvi IBKR
  (`workerSource === 'ibkr'`), až po uložení `latestQuote`, synchronně v try/catch (chyba nikdy nezablokuje
  kotaci ručního Marketu). `prev` po restartu vlákna ceny nebo změně kontraktu = `null` (jen nová výchozí cena).
- `scripts/copier/priceAlertWatchThread.ts` (bundle `price-alert-watch.mjs`, `env: {}`, resourceLimits ~48 MB):
  zprávy dovnitř `{type:'config', apiOrigin, deviceId, key} | {type:'config', off:true}` a
  `{type:'batch', contract, prev, min, max, last, at}`; směr `condition_auto` přepočítává jen v paměti
  (`priceAlertWatchCondition`), nikam ho neukládá; ven `{type:'watch', state:'watching'|'no-price'|'no-sync'|'off',
  alerts, priceAt, syncAt}` 1×/s. `list` každých 5 s (single-flight, `AbortSignal.timeout(4000)`, backoff), křížení
  `lib/priceAlertCross.ts`, baseline reset (výpadek ceny > 15 s, změna kontraktu, změna verze upozornění, start),
  jeden `triggerId` (uuid) na křížení, opakování jen transportní se stejným id, lokální strop 30/10 min.
  Importy jen `node:worker_threads`, `node:crypto`, `lib/priceAlertCross.ts`, `server/priceAlertWatchKey.ts` (podpis).
- `server/priceAlertWatchSupervisor.ts`: jako `tvPriceStreamSupervisor` (nikdy nevyhodí, jistič 3 pády/10 min,
  liveness 15 s), `update(config)`, `onBatch(batch)`, `status()` → pole statusu nebo null (obranně).
- `server/macCopierCommandRelay.ts`: volba `onPriceAlertConfig?(cfg|null)` jen s `alertKey/alertDeviceId/apiOrigin`;
  `alertKey` se do `onRealtimeConfig` NEPŘEDÁVÁ.
- Status workeru: `priceAlertWatch?: { state, alerts: number, priceAt: number|null, syncAt: number|null } | null`.
- `scripts/copier/pilot.ts` + `mac-install.ts`: flag `--price-alerts on` → `ALPHATRADE_PRICE_ALERTS=on`; výchozí vypnuto.

## D. Klient

- `lib/priceAlerts.ts`: `PriceAlert` + volitelné `status`, `conditionAuto`, `version`, `lastTriggeredAt`;
  `PriceAlertState` + volitelné `sync`, `events`. Automaticky odvozený směr (`alertConditionFor`) nastaví `conditionAuto: true`.
- `services/priceAlertServerStore.ts`: implementuje `PriceAlertStore` (supabase-js + realtime, optimistické úpravy,
  LWW `edited_at`, měkké mazání, offline cache, jednorázový import lokálních upozornění, `rearm` při úpravě
  spuštěného „jednou“). `lib/priceAlerts.ts` zůstává bez supabase.
- Sloty telefonu: `alertEvents` z realtime `price_alert_events` (id = event id; hlas a karta jen pro události ≤ 30 s);
  `alertWatch` z čerstvého statusu (≤ 8 s, neobnovený) jen při `state === 'watching'` a `priceAt`/`syncAt` ≤ 15 s.
- Hlas: nativní `speak({ text, lang: 'cs-CZ' })` / `stopSpeaking` v `AlphaTradeNativePlugin.swift`
  (AVSpeechSynthesizer, `.duckOthers`, deaktivace s notifyOthersOnDeactivation), JS obal; web `speechSynthesis`.
- Strop karet upozornění (nejvýš 2 najednou), aby nevytlačily kartu rizika.
- Spuštění potlačená rozpočtem (`suppressed_reason='budget'`) nemají kartu, hlas ani push — při
  záplavě by jinak přehlušila riziko; zůstávají jen v `price_alert_events`.
- Spuštěné „jednou“ se kreslí tlumeně jako „spuštěno“ a nepočítá se mezi aktivní; „hlídá“ se
  netvrdí, dokud rearm nepotvrdí server (výsledek RPC).

## E. Formulace a doklady

- „Jednou“ je atomické jen v DB (`trigger_price_alert` pod zámkem řádku); doručení APNs/web push je
  „aspoň jednou“ s `apns-collapse-id` / `Topic` podle upozornění.
- INV-UI-04: IBKR smí upozornění spustit; cena se nikam neukládá ani neposílá, jen pro vlastní IBKR uživatele.
- INV-WATCH-01 a INV-WORKER-04: odstavec o `price_alert_outbox` a vláknu `price-alert-watch`.
- `tests/tvPriceStreamWiring.test.ts`: allowlist nového vlákna (`new Worker` jen pro známé bundly), nezeslabovat.
- Nezjištěno: rozpočet 20/10 min proti limitu APNs na token zařízení.
