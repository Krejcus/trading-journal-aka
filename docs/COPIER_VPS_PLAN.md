# Copier na VPS — plán fáze 2

Mac runtime je řízený první krok. Jeho poctivě přiznaný limit: když je Mac
vypnutý nebo bez sítě, leader se hýbe a copier to nevidí — a výpadek domácí
wifi shodí copier přesně ve chvíli, kdy uživatel sáhne po mobilu. Ty dvě
poruchy jsou zapojené do série. VPS je rozpojuje.

## Proč je přechod menší, než vypadá

Command relay postavený pro Mac (`tradovate_copier_commands`,
`tradovate_copier_device_runtime`, `claim_tradovate_copier_command`) je
**transport-agnostický**. UI zapisuje příkazy do Supabase, worker si je
claimuje a hlásí stav zpět. Workeru je jedno, kde běží.

Z toho plyne to podstatné: **VPS worker nepotřebuje žádný veřejný HTTP
endpoint.** Žádné TLS na workeru, žádná autentizace příchozích spojení,
žádný otevřený port. Worker drží jen odchozí spojení (Tradovate WS +
Supabase). ARM, DISARM, Kill switch a Flatten fungují z libovolného
prohlížeče včetně mobilu — přes relay, který už existuje a je otestovaný.

Localhost agent (`localCopierExecutionAgent`) tím na VPS odpadá celý,
včetně origin/nonce/PNA logiky. Zůstává jako Mac-only vrstva.

## Co se musí dopojit (a už je napsané)

| Komponenta | Stav | Práce |
| --- | --- | --- |
| `copier_worker_lease` migrace + `copierWorkerLease.ts` | hotové, bez volajícího | worker entry ji musí vzít při startu a držet renewem |
| `supabaseCopierStore` s fence | hotové | nahradit `fileCopierStore` ve worker entry |
| Command relay | hotové, používá Mac | worker claimuje stejně jako Mac pilot |
| OAuth lease obnova přes device | hotové | VPS je jen další device |
| `latencyProbe.ts` | hotové | spustit v kandidátních regionech |
| `watchdog.ts` | hotové (osascript) | notifikační kanál vyměnit za push/Discord |

Nová práce je tedy: **worker entry point** (bootstrap = lease → store →
relay → broker) a **deploy pipeline**. Odhad: 2–3 dny včetně DEMO ověření.

## Pravidla, která na VPS platí nově

1. **Fencing je povinný.** Worker bez platného lease nesmí nastartovat
   (`CopierLeaseHeldError` = okamžitý konec procesu, žádné čekání ve smyčce).
   Ztráta lease za běhu (`CopierLeaseLostError`, `CopierFenceStaleError`)
   = DISARM + stop. Lease se NIKDY nepřebírá násilím; to je ruční rozhodnutí.
2. **Přesně jeden Machine.** Při deployi žádný overlap (Fly:
   `auto_stop_machines = "off"`, `auto_start_machines = false`, strategie
   `immediate` s jedním strojem). Fencing je pojistka, ne omluva pro
   souběžný běh.
3. **Po každém převzetí fence plná reconciliation proti brokerovi** —
   dohledání podle `clOrdId` + porovnání pozic. Stará instance mohla mít
   rozpracovaný `placeOrder`, který doběhl po ztrátě jejího fence.
4. **Žádný stav na disku VPS.** Snapshot v `copier_runtime_state`,
   konfigurace v Supabase. Box je vyměnitelný; obnova = nový deploy,
   ne restore zálohy (stará záloha stavu je zdroj divergence, ne záchrana).
5. **ARM s tvrdou expirací** vázanou na session brokera (17:00 CT), ne na
   kalendářní den. Expirace NEzavírá pozice — hlasitě notifikuje.
6. **Watchdog mimo box.** Kontrola `tradovate_copier_device_runtime.last_seen_at`
   (Vercel cron / Supabase cron) + push notifikace. Watchdog na samotném
   VPS neuvidí pád vlastního stroje.

## Postup nasazení

1. `latencyProbe.ts` v regionech `ord`, `iad`, `ewr`, `dfw` — během živé
   session, rozhoduje p95/p99 a stabilita, ne p50.
2. Worker entry + Dockerfile; DEMO worker na vítězném regionu, produkce
   DISARMED, Mac runtime vypnutý (jeden aktivní device na skupinu).
3. Zopakovat DEMO conformance scénáře z `COPIER_MORNING_PILOT_2026-08-17.md`
   proti VPS workeru (limit, market, OCO, OSO, Flatten, multiplier).
4. Chaos test: kill workeru uprostřed odesílání, restart Machine, výpadek
   sítě — ověřit lookup-before-retry a čistý DISARM start.
5. Teprve potom zvážit ostrý provoz.

## Co VPS neřeší

Prop pravidla (písemné potvrzení Tradeify pro vlastní copy nástroj),
Gate podmínky ARM a lidská rozhodnutí u stuck operací zůstávají stejné.
VPS mění KDE runtime běží, ne CO smí dělat.
