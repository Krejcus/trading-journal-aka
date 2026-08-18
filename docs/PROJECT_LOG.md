# PROJECT_LOG — sdílená paměť AI asistentů

Tento soubor čtou VŠICHNI AI asistenti (Claude, Codex/GPT, …) na začátku
každé session a doplňují ho na konci. Je to jediné místo, kde si předáváme
kontext — soukromá paměť jednotlivých nástrojů se sem nedostane.

## Pravidla

1. Na začátku session si přečti celý tento soubor (je záměrně krátký).
2. Po významné práci PŘIDEJ datovaný zápis nahoru do Deníku. Nepřepisuj
   cizí zápisy; oprav jen fakta, která prokazatelně přestala platit.
3. Zapisuj rozhodnutí a PROČ, ne výpis commitů — ty jsou v gitu.
4. Otevřené otázky udržuj v sekci níže: přidávej, a vyřešené škrtej
   s odkazem na zápis, který je vyřešil.
5. V repu pracuje vždy jen jeden asistent naráz. Necommitnutá rozpracovaná
   práce druhého se nezahazuje — zeptej se uživatele.

## Stav projektu (průběžně aktualizovat)

- **Copier**: jádro ověřené na Tradovate DEMO (limit, market, OCO, OSO,
  Flatten, multiplikátory). Mac runtime: launchd agent + Supabase command
  relay + device pairing. 964 testů, typecheck čistý.
- **Bezpečnostní model**: DISARMED default; fail-closed všude; durable
  outboxy (standard/cancel/bracket/OSO); žádný blind retry — po nejistém
  výsledku vždy lookup podle `clOrdId`; divergence = halt-group, nikdy se
  neopravuje obchodem; kill switch = jednosměrná západka.
- **Risk settings**: per-follower `maxContracts`; anti-revenge cooldown
  (flat leadera → DISARM + blokovaný re-ARM, `safety.entryCooldownMinutes`);
  ARM expiruje nejpozději v 17:00 America/Chicago.
- **Další fáze**: přesun runtime na VPS/Fly — plán v `COPIER_VPS_PLAN.md`.
  Fencing lease (`copierWorkerLease.ts` + migrace) a `supabaseCopierStore`
  s fence jsou napsané a ČEKAJÍ na VPS worker entry — vědomě nezapojené,
  Mac pilot jede na `fileCopierStore`.

## Klíčová rozhodnutí (a proč)

- **Tradovate není idempotentní** — `customTag50` broker odmítl
  (Unregisted Tag50), používá se `clOrdId`, ale ani ten negarantuje
  odmítnutí duplicity. Outbox + lookup-before-retry je proto nosná
  konstrukce, ne pojistka. Nezjednodušovat.
- **Cooldown blokuje ARM, ne jednotlivé objednávky** — selektivní
  vynechání entry by založilo záměrnou divergenci, kterou by reconciler
  správně zabil. Obě strany flat → žádný rozdíl.
- **VPS worker nepotřebuje veřejný endpoint** — command relay přes
  Supabase (`tradovate_copier_commands`) je transport-agnostický; worker
  drží jen odchozí spojení. Kill switch z mobilu funguje přes relay.
- **Žádný stav na disku VPS** — snapshot v `copier_runtime_state`,
  box je vyměnitelný; obnova = nový deploy, ne restore zálohy.
- **Menu bar Mac aplikace zamítnuta** — leštila by kokpit letadla, které
  nahradí VPS; stejná investice jako celý VPS přechod.

## Otevřené otázky

- [ ] Pairing flow (ikona klíče v LIVE Connections) — nasazený, ale
      neproklikaný na produkci.
- [ ] Multi-follower DEMO test (`--followers` se 3 účty, nejdřív shadow).
- [ ] UI políčko pro `entryCooldownMinutes` (config i agent flag existují).
- [ ] Cross-firm kopírování: runtime má jeden broker na skupinu; potřeba
      `brokerFor(accountId)` + dotaz na prop firmy, zda cross-firm povolují.
- [ ] `copytrade-preview.{html,tsx}` — poslední untracked soubory; commit
      jako dev nástroj, nebo smazat (rozhodnutí uživatele).
- [ ] Test „Flatten při nejasném cancelu" je na hraně 5s timeoutu
      při izolovaném běhu (pre-existing) — zvednout timeout.
- [ ] Chaos test recovery proti reálnému DEMO (kill uprostřed odesílání,
      výpadek WS) — outbox recovery zatím ověřená jen deterministicky.

## Deník (nejnovější nahoře)

### 2026-08-18 (Claude)
Založen tento log. Dnes: ARM session TTL (17:00 CT, DST-safe),
per-follower maxContracts (jádro+UI+reconciler), multi-follower agent
(`--followers "id@mult[@max],…"`), anti-revenge cooldown, watchdog
(osascript notifikace), latencyProbe pro výběr VPS regionu,
`COPIER_VPS_PLAN.md`. Opraven prune bug v bracket correlatoru
(úklid cache uměl odzbrojit fail-closed timer — `awaitingPair` teď žije
mimo `prune()`). Commity `9cf94062`…`04da423e`.

### 2026-08-17 (Codex/GPT + uživatel)
Kompletní DEMO ověření copieru: limit/market/OCO/OSO lifecycle, Flatten,
Flatten All, multiplikátory, 2× násobek. `customTag50` → `clOrdId`.
Nativní `/order/placeoco` a `/order/placeoso` + durable outboxy + bracket
correlator (Tradovate posílá nohy 200–330 ms od sebe, někdy bez vazeb).
Attached ATM detekován a správně fail-closed. Mac runtime: launchd,
Keychain, device pairing, Supabase command relay. p95 162–269 ms.
