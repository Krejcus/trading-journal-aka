# LIVE: méně překreslování — návrh (26. 10. 2026)

Navazuje na `candles-realtime-pnl-20261026.md` bod 8 (LIVE = největší
naměřený náklad). Stav: **1a implementováno, 1b odloženo** — viz bod 8
(verdikt `copier-design-critic`).

## 1. Měření (dev build, vestavěný prohlížeč, panel viditelný, 36 s LIVE)

Dočasný React Profiler + diff stavů v `TradovateLiveDesk` (jen worktree,
odstraněno).

- 171 commitů (~4,7/s), 3,56 s renderu (~99 ms/s), z toho **88 %
  `LiveCopyTradeOverview`**; 41 dlouhých snímků (> 50 ms) za 30 s, většina
  s vstupním bodem `tradovateOAuthConnection.ts … Response.json.then`.
- Příčiny renderu (bez dvojitých renderů StrictMode):

| Spouštěč | Renderů / 36 s | ≈ /s | Poznámka |
|---|---|---|---|
| `App` → nové `live` + `live.apiTelemetry` (+ nové identity `journalHistory`, `journalStatus`, `cardOwner`) | ~80 | 2,2 | telemetrie Tradovate požadavků |
| `freshnessNow` (sekundový tik) | 35 | 1,0 | hodiny čerstvosti statusu |
| `displayCache` (efekt po feedu) | ~27 | 0,75 | druhý commit po každém feedu |
| `displayFeedReceipt` + `agentStatus` (poll) | ~15 | 0,4 | vlastní data pollu |

**Kořen hlavní položky**: `useTradovateLiveData` (volá ho `App`) odebírá
telemetrii API přes `useSyncExternalStore`. `beginTradovateApiRequest`
i `finishTradovateApiRequest` volají `publish()` → nový snapshot →
**synchronní** re-render celé `App` (store update má SyncLane, vykreslí se
v mikroúloze hned po `response.json()` — proto dlouhé snímky s tímhle
vstupním bodem, a to i mimo LIVE, např. při minutové synchronizaci deníku).
Každý relay poll (2 spojení) = 3–4 publikace. Telemetrii přitom zobrazuje
jediný prvek: desktopový `LivePnlPanel` (na telefonu se nevykresluje vůbec).

## 2. Cíl a hranice

- Cíl fáze 1: odstranit rendery, které **nesouvisí s časem ani s daty
  kopírky** — telemetrie a dvojí commit display cache. Odhad: ~4,7 → ~1,8
  commitu/s, dlouhé snímky po každém Tradovate požadavku zmizí na všech
  stránkách.
- **Mimo fázi 1 (vědomě)**: sekundový tik `freshnessNow`. LIVE čte čas
  v renderu přímo (`Date.now()` ~24× v `LiveCopyTradeOverview`, např.
  `dayLockActive`, `connectBlocked` tlačítka ON, souhrn dne) i skrytě přes
  pomocné funkce s výchozím `now = Date.now()` (`copyTradeAccountEligibility`,
  `liveReadFreshness`, `liveCopierIsland`, `liveTradeCard`,
  `liveBalanceDisplay`, `retainedRiskDisplay`, `liveMobilePresentation` …).
  Tik je dnes jediné, co je drží aktuální; jeho zředění by tiše změnilo
  kadenci desítek zobrazení včetně blokace ON. Fáze 2 níže (samostatný
  návrh + kritik).
- Beze změny: příjem statusu (`acceptAgentStatus`, fence), poll relaye,
  brzdy, `isCopierStatusFresh`, `armStatusRef`, odesílání příkazů, risk
  brány, cokoli ve workeru a na serveru.

## 3. Fáze 1 — změny

### 1a. Telemetrie API jen v panelu, který ji ukazuje

- `components/useTradovateLiveData.ts`: odstranit `useSyncExternalStore`
  telemetrie a `apiTelemetry` z návratové hodnoty. Interval
  `refreshTradovateApiTelemetry` (30 s) se přesune do panelu (posouvá jen
  klouzavá okna zobrazení).
- Nový malý hook `useTradovateApiTelemetry()` (subscribe + refresh 30 s,
  jen dokud je komponenta připojená) v `LivePnlPanel`.
- `connectionUsageRows` se přestane počítat v `TradovateLiveDesk` (bral
  `live.apiTelemetry.brokerCalls`); panel dostane `connections`
  (`live.status?.connections`) a `workerUsage` (`agentStatus?.connectionUsage`)
  a řádky (`buildTradovateConnectionUsageRows`) si spočítá sám s vlastní
  telemetrií. Čistá funkce i její vstupy zůstávají stejné.
- Jediný další čtenář telemetrie čte snapshot přímo
  (`useTradovateDisplayFallback.pausedUntil` → `getTradovateApiTelemetrySnapshot()`)
  — beze změny. (`tradovateClientBackoffMs` je čistá funkce `retryAfterMs`,
  telemetrii nečte.)

Důsledek: požadavek na Tradovate API už nepřekreslí `App` ani LIVE; jen
rozbalený panel API (desktop). Sbalený panel (výchozí stav) telemetrii
neodebírá vůbec.

### 1b. Display cache v jednom commitu s feedem — ODLOŽENO (bod 8)

> Kritik: display cache **není jen zobrazení** — přes `displayValues` →
> `effectiveAccountEligibility` (odvozené `dll-locked`) → exkluze followerů
> vstupuje do ARM payloadu i UI bran ARM. Původní text níže platí jen jako
> výchozí bod; implementace jedině ve variantě z bodu 8.

Dnes: `setDisplayFeedReceipt(...)` → commit → `useEffect` →
`setDisplayCache(merge(...))` → druhý commit (celé LIVE). Změna: sloučení
se spočítá synchronně z dat, která efekt čte (`restoredDisplay`, předchozí
hodnoty, feedy, `displayMembership`) — `useReducer`/funkční update ve
stejném místě, kde se nastavuje receipt, nebo odvozením v `useMemo`
s akumulací v ref. Pořadí a obsah sloučení (`mergeTradovateAccountDisplay`)
beze změny; fallback publikace (`useTradovateDisplayFallback.publish`) dál
zapisuje stejným merge. Konkrétní varianta podle kritika (viz otázky).

### 1c. (volitelné) Stabilní props z `App`

`journalHistory`, `journalStatus`, `cardOwner` vznikají v `App` při každém
renderu znovu. Po 1a se `App` na LIVE překresluje výrazně méně; memoizace
má smysl až s `React.memo(TradovateLiveDesk)` — nechat na měření po 1a.

## 4. Dotčená pravidla INV

- **INV-UI-01** (obnovený stav jen stabilizuje zobrazení): 1b mění, kdy se
  počítá `displayCache` (obsahuje i `restoredDisplay` ze session cache).
  Hodnoty i jejich původ zůstávají; nic z cache neautorizuje příkaz.
- **INV-UI-02** (DISARM/kill vždy dosažitelné, ostatní mutace čerstvý
  status): beze změny — `executeSafetyCommand`, `selectCopierSafetyRoute`,
  tlačítka brzd se nemění; méně renderů nemění jejich dostupnost.
- **INV-UI-03** (retained risk / poslední status jen zobrazení): telemetrie
  je čistě zobrazovací. ~~Display cache taky~~ — **neplatí**: display cache
  vstupuje přes odvozenou způsobilost do exkluzí v ARM payloadu (bod 8).
- **INV-ELIG-02, INV-RISK-01, INV-ARM-01** (jen 1b): exkluze z UI smí
  způsobilost jen zpřísnit; 1b nesmí změnit výsledné exkluze proti dnešku.
- **INV-BRAKE-04** (zobrazení zámku dne): `connectBlocked`/`dayLockActive`
  čtou `Date.now()` v renderu; po 1a je kadence dána tikem (≤ 1 s, typicky
  ~0,5 s místo ~0,2 s), zpoždění v bezpečném směru, zámek vynucuje worker.
- **INV-TRAD-06** (jen 1b): membership po připojeních, klíč
  `env:connectionId:accountId`.
- **INV-FRESH-02** (pořadí statusů, fence): beze změny, `acceptAgentStatus`
  a poll se nemění.
- **INV-FRESH-03** (15 s čerstvost): beze změny. Správný důvod (kritik):
  `armStatusRef.current` je čistá funkce pěti stavů (`agentStatus`,
  `agentStatusObservedAt`, `freshnessNow`, `agentStatusReadHealthy`,
  `agentStatusRestored`); render z telemetrie žádný z nich neměnil, čtenáři
  čtou jen `.fresh`/`.status`. Flip stale↔fresh nastane ve stejném okamžiku
  jako dnes. (Starší slabina mimo 1a: `freshnessNow` je až ~1 s starý →
  UI pustí status starý až ~16 s; server relay drží vlastních 10 s pro
  `arm-live`. Fáze 2: čerstvost počítat v okamžiku volání.)
- **INV-TRAD-04** (rate limit je execution stav): telemetrie v UI je jen
  zobrazení; skutečný backoff workeru i klienta zůstává.
- **INV-BRAKE-03** (brzdy přes poslední ověřenou route): beze změny.

## 5. Ověření

- Testy: existující LIVE render testy (`tests/liveCopyCompactRender.test.ts`,
  `tests/liveCopyAdversarialUiReview.test.ts`, `tests/copierPowerDisplay.test.ts`,
  `tests/copierForegroundPoller.test.ts`, `tests/copierSafetyControls.test.ts`)
  + nový test: `buildTradovateConnectionUsageRows` v panelu dostává stejné
  vstupy; hook `useTradovateLiveData` už telemetrii nevrací (typ).
- Měření stejnou metodikou (Profiler + diff stavů, 36 s LIVE): cíl ≤ 2
  commity/s, žádný dlouhý snímek s `Response.json.then` po relay pollu.
- Ruční kontrola v náhledu: přepínač ON/OFF a brzdy (jen zobrazení, nic
  neklikat), panel API (minuta/hodina/24 h, řádky spojení), zůstatky
  a denní P&L po pollu, obnovené hodnoty po návratu na LIVE.
- iPhone: perf značky appky před/po (LIVE 60 s v klidu).

## 6. Fáze 2 (jen náčrt, samostatný návrh)

Sekundový tik nahradit hodinami s explicitním `now`: (1) pomocné funkce
volané v renderu LIVE dostanou `now` výslovně (bez výchozího `Date.now()`
v renderu); (2) časové hranice (konec zámku dne, pauzy, cooldownu, stáří
statusu 15 s, `LIVE_READ_MAX_AGE_MS`, hranice Tradovate dne) naplánují
re-render přesně na hranici; (3) údaje typu „před X s“ do malých komponent
s vlastním 1s tikem. Cíl: celé LIVE se překreslí jen při datech nebo na
hranici. Vyžaduje vlastní kritiku (INV-UI-01..03, INV-FRESH-03,
INV-BRAKE-04 zobrazení zámku dne).

## 7. Otázky pro kritika

1. Je bezpečné, že `armStatusRef.current` se po 1a přepisuje méně často
   (jen tik + data), když ARM/config brány čtou `armStatusRef.current.fresh`?
2. 1b: `useReducer` (receipt + cache jednou akcí) vs. odvození v `useMemo`
   s akumulací v ref — která varianta lépe zachová sloučení s fallback
   publikací a s `restoredDisplay`?
3. Je něco v LIVE, co na telemetrii reaguje jinak než zobrazením (např.
   stav „rate limited“ blokující tlačítko)? Vlastní kontrola: mimo
   `LivePnlPanel` čte telemetrii jen `useTradovateDisplayFallback`
   (`pausedUntil` přímo ze snapshotu, ne přes React stav); `tradovateBroker`
   má vlastní `rateLimitedUntil` ve workeru.

## 8. Verdikt `copier-design-critic` (26. 10.) a co z něj plyne

**Celkově OPRAVIT PŘED IMPLEMENTACÍ; 1a OK S VÝHRADAMI (může samostatně),
1b OPRAVIT PŘED IMPLEMENTACÍ.**

- Otázka 1: bezpečné (viz INV-FRESH-03 výše). Otázka 3: telemetrii mimo
  zobrazení nečte nic (jen `useTradovateDisplayFallback.pausedUntil` přímo
  ze snapshotu).
- 1a výhrady → splněno: `getServerSnapshot` předán a pokrytý render testem
  těla panelu (`tests/livePnlPanelBodyRender.test.ts`: telemetrie, 429,
  řádek spojení s voláními webu i workeru), řádky čerpání se počítají jen
  v rozbaleném panelu, prop `apiTelemetry` z přehledu odstraněn, pojistné
  testy zdrojů `tests/liveRerenderGuards.test.ts` (jediný odběratel
  telemetrie = hook panelu; hook volá jen `LivePnlPanelBody`; hook dat ji
  nevrací; `armStatusRef` v renderu; sekundový tik zůstává; deps pollu).
- Diff 1a: druhý průchod kritika **OK S VÝHRADAMI, commit povolen**
  (cesta příkazů beze změny, přesun 30s refreshe bezpečný — `publish()`
  `rateLimitedUntil` nikdy nenastaví, jen vyprší).
- 1b je zčásti jádro (edituje callback status pollu, mění vstup exkluzí
  ARM). Nálezy: (1) display cache → `dll-locked` → exkluze v `arm-live`;
  (2) dnešní efekt znovu slučuje i při změně `displayMembership` (receipt
  dřív než `connectionData` při studeném startu) — sloučení jen při příjmu
  receiptu by hodnoty ztratilo; (3) dispatch uvnitř efektu pollu nesmí
  přidat deps (restart pollu při každém REST ticku → vyhladovění statusu);
  (4) fallback publish nesmí měnit receipt (`receivedAt` čte display
  poller); (5) merge zahazuje `confirmedAt > now + 1 s` — dnes se kvůli
  opakovanému slučování přijme později, po 1b nikdy (skew iPhone/Mac
  NEOVĚŘENO); (6) sloučení při mountu z `restoredAgent.feedReceipt`.
- Podoba 1b, pokud se bude dělat: čistá funkce v `lib/` + `useReducer`
  `{userId, receipt, values}` s akcemi `worker-feed` (jen tam, kde je dnes
  `setDisplayFeedReceipt`, za `acceptAgentStatus`/`pollStillCurrent`),
  `fallback-feed` (jen `values`), `membership` (efekt klíčovaný obsahem,
  jako `membershipKey`), `reset`; membership do pollu přes ref. Testy:
  pořadí receipt/membership, zúžení a rozšíření membership, fallback před
  i po, fallback nemění receipt, `restoredDisplay` a obchodní den, owner
  reset, idempotence (StrictMode), **ekvivalence exkluzí proti dnešku**,
  skew +2 s; source guard deps pollu. Přínos ~0,75 commitu/s — část
  odstraní už samotný efekt klíčovaný obsahem.

### Výsledek 1a (dev, vestavěný prohlížeč, LIVE ~40 s)

| | Před | Po 1a |
|---|---|---|
| Commity LIVE | 4,7/s | 2,8/s |
| Render LIVE | ~99 ms/s | ~62 ms/s |
| Dlouhé snímky (> 50 ms) | ~1,4/s (41 / 30 s) | ~0,1/s (4 / 41 s) |
| … s `Response.json.then` | většina | 0 |

Měření renderu, ne stavu brokera. Telefon: panel API se tam nevykresluje,
takže telemetrie nepřekresluje nic.

