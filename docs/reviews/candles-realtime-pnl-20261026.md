# Svíčky a realtime P&L — předávka pro lokální session (26. 10. 2026)

Vzniklo v cloudové session navazující na `supabase-vercel-usage-20261025.md`.
Rozsah: **svíčky v grafech** (deník, backtest, LIVE), **realtime otevřené P&L
v LIVE** a **plynulost grafů**. Nic z toho zatím není implementováno.
Synchronizace dat deníku, region relay a ostatní body review řeší lokální
session zvlášť — tady se jich nedotýkat.

## 1. Rozhodnutí a omezení

- **Bez placených dat.** Databento live ne (drahé). Tradovate API ceny ne:
  doplněk API ~25 USD/měs market data neobsahuje, ceny přes API vyžadují CME
  licenci (uživatelé hlásí ~290–500 USD/měs) a účet ≥ 1 000 USD; zdarma jen
  10min zpoždění. Probe 27. 8. (`scripts/market-data/quoteAccessProbe.ts`,
  PROJECT_LOG 2026-08-27): OAuth klíč vrací `mode: None` / `UnknownSymbol`.
- **Zdroj ceny = TradingView Desktop přes worker** (CDP, read-only výraz,
  nic nepřepíná — `lib/tradingViewBars.ts` `TV_BARS_EXPRESSION`).
- **Svíčky z TradingView** jsou v souladu s dnešním pravidlem (jen zobrazení).
- **P&L z TradingView vyžaduje výslovné rozhodnutí Filipa** — dnešní pravidlo
  (`lib/tradingViewBars.ts:5`): *„jen pro zobrazení — nikdy nevstupují do
  copieru ani do výpočtů P&L (non-display licence dat TradingView)“*.
  Navržená nová formulace: **„jen P&L zobrazené člověku na obrazovce; nikdy
  risk brány, day lock, limity ztráty, kopírka ani jiná automatika.“**
  Podmínky TradingView licencují data pro zobrazení člověku a zakazují
  strojové/risk použití (https://in.tradingview.com/policies). Bez souhlasu
  stavět jen svíčky.

## 2. Současný stav (měřeno 25. 10., Supabase edge/function logy, kód)

**Svíčky**
- Historie: Databento → `market-candle-store` (Edge Function, soukromý sklad,
  `docs/CANDLE_STORE_SERVER_HANDOFF.md`) → v zařízení po dnech v IndexedDB
  (`services/marketData.ts`). Sklad p50 0,21 s, p95 13,2 s (= první nákup
  období z Databenta).
- **Dnešek je nejpomalejší místo grafů**: sklad ukládá jen dny starší než
  24 h + 25 h odstup a novější konec odmítne `409` → klient spadne na placený
  `market-candles` (`services/candleStoreClient.ts`): **p50 6,4 s, p95 20 s**,
  21 volání / 24 h.
- TV svíčky dnes: worker čte **1× za minutu** (`TV_LIVE_BARS_INTERVAL_MS`,
  `services/tradingViewBars.ts:62`), posílá **celé okno 27 h (až 1 700
  svíček)** přes Vercel relay (`api/tradovate/oauth/copier-relay.ts:149-160`,
  limit 4 zápisy/min, max stáří 2 min) do Storage
  (`server/copierSnapshotStore.ts:182-200`), max 2 cenové rodiny, jen 1m graf.
  V appce jsou tedy až 1–2 min staré.

**Otevřené P&L**
- REST `api/tradovate/oauth/live-pnl.ts` (zůstává v `iad1` — volá Tradovate
  v USA): interval 3 s s pozicí / 6 s / 15 s flat
  (`components/useTradovateLiveData.ts:122-124`), kotva = brokerovo `openPnL`
  z `cashBalance/getcashbalancesnapshot` (`server/tradovateLivePnl.ts`,
  `loadTradovateLivePnlAnchor`).
- Strop: Tradovate ~80 požadavků/min na token; 18. 9. překročení → Tradovate
  zavíral WS workeru a kopírka nešla zapnout. **Frekvenci REST nezvyšovat.**

## 3. Návrh

### A. Rychlý kanál ceny z TradingView (společný základ pro P&L i svíčky)
- Worker čte jen poslední 1–2 svíčky + čas (lehký CDP výraz, ne celé okno)
  každých ~250–500 ms a posílá jen při změně.
- Transport mimo Vercel a Storage, přímo do Supabase Realtime (Broadcast,
  privátní kanál `tv:<uid>`, RLS na `realtime.messages`, klient nesmí psát).
  **Rozhodnout autentizaci workeru** (dnes mluví jen s Vercel API přes device
  token): (a) krátkodobý JWT pro Realtime vydaný relayem — ověřit, jak to jde
  s aktuálními podpisovými klíči Supabase; (b) Edge Function, která volá
  `realtime.send` — pozor na počet invokací při 2–4 zprávách/s; (c) přes
  relay v `arn1` — nejjednodušší, ale Vercel invokace za každou zprávu.
  Ověřit kvóty Realtime (zprávy/měsíc, fan-out) a posílat často jen když je
  otevřená pozice nebo graf (jinak ~1/s nebo nic).
- Každá zpráva: symbol grafu, čas TV, `seq`. Klient: stáří > ~2 s nebo
  mezera v `seq` = „stojí“ → fallback.
- Čtení ceny běží odděleně od smyček kopírky (vlastní časovač, timeout,
  žádné sdílení s exekucí). Worker = runtime kopírky → `copier-design-critic`.

### B. Realtime P&L (jen zobrazení)
- **Kotva + pohyb**: P&L = poslední kotva brokera (`openPnL`, dál po 3 s) +
  (cena TV teď − cena TV v čase kotvy) × počet × multiplikátor. Chyba se
  nesčítá — každá kotva srovná rozdíly TV vs Tradovate, poplatky a zaokrouhlení.
- Cena v čase kotvy: držet krátkou historii TV cen s časem; pozor na posun
  hodin Mac vs Tradovate (tolerance, nejbližší vzorek).
- Multiplikátor z metadat kontraktu (MNQ 2 USD, NQ 20 USD …); cena sdílená
  v rodině (MNQ/NQ), kotva zvlášť pro každý účet (leader i followeři).
- **Roll kontraktů**: TV `MNQ1!` přepíná na další měsíc podle svých pravidel,
  pozice je v konkrétním kontraktu → v týdnu rollu mohou být ceny o spread
  jinde. Ověřit symbol grafu proti kontraktu pozice; při nesouladu pohyb
  vypnout (jen kotva).
- **Zpožděná data v TV**: bez realtime CME předplatného TV ukazuje 10min
  zpoždění. Detekovat (čas poslední svíčky vs hodiny) a v tom případě nepoužít.
- Bez Macu / TV / při stáří → automaticky dnešní 3s kroky + štítek.
  UI odliší „živě (TradingView)“ vs „broker“. Pravidla `INV-UI-*`: nic
  zobrazovacího nesmí autorizovat příkaz; risk brány dál jen z brokera.

### C. Svíčky
1. **Dnešek z TV**: Databento (sklad) pro část starší než hranice skladu +
   TV svíčky pro zbytek → dnešní graf ~0,3–0,5 s místo 6–20 s a méně
   placených volání `market-candles`. Když TV chybí (Mac vypnutý): dnešní
   fallback, nebo viditelná mezera — nikdy tiché míchání.
2. TV svíčky jsou „předběžné“; nahrazení finálními z Databenta po 24 h dělat
   na pozadí při dalším otevření, ne pod rukama během prohlížení.
3. **Živá poslední svíčka** ze stejného kanálu (A) — aktualizovat poslední bar
   na místě, ne znovu nastavovat celá data grafu.
4. **Předstahování**: při otevření deníku svíčky k dnešním obchodům, v
   backtestu další den; hlídat velikost IndexedDB a mazání nejstarších dní.

### D. Plynulost grafů a zátěž zařízení
Nalezeno v kódu (main, 26. 10.):
- Backtest: každých **1,2 s** `JSON.stringify` celého stavu workspace jen
  kvůli porovnání (`components/AlphaTradeChartWorkspace.tsx:2200`,
  `services/backtestWorkspaceCheckpoint.ts:49`) → při skutečné změně
  (dirty flag / událost), případně `requestIdleCallback`.
- Backtest: plán dopočtu analytiky každé **2 s** i bez pohybu
  (`components/BacktestWorkspace.tsx:526`) → jen při změně kurzoru/horizontu.
- Komponenty překreslované každou 1 s (odpočty, „před X s“) a 250 ms
  (`components/CopierCooldownPanel.tsx`) → malé izolované komponenty nebo CSS.
- Živé aktualizace (svíčka, P&L) kreslit mimo React (jako už replay
  „kreslí se přímo do grafu mimo React“), max 1 aktualizace za snímek.
- **202× `backdrop-blur`** — na telefonu a nad hýbajícím se grafem drahé
  (přepočet v každém snímku = sekání + teplo). Lehčí varianta na mobilu a při
  posunu grafu (poloprůhledné pozadí bez blur), vzhled zachovat.
- Těžké výpočty (struktura CHoCH/BoS, parsování velkých sad svíček) ve Web
  Workeru, ne v hlavním vlákně.
- Dlouhá historie při scrollu roste v DOM (`components/TradeHistory.tsx`,
  PAGE_SIZE 20 bez virtualizace) → virtualizace.

Měření (před/po): Safari Web Inspector → Timeline (CPU, snímky, vrstvy),
na grafu, v backtestu, v LIVE, 60 s bez interakce + posun/zoom. Cíle: plynulý
posun (60/120 fps), žádný task > 50 ms při ovládání, nízké CPU v klidu.

## 4. Pořadí kroků

0. Rozhodnutí Filipa o pravidle P&L z TV (svíčky ho nepotřebují).
1. **Měřicí skript jen pro čtení na Macu**: latence CDP čtení poslední
   svíčky (p50/p95), jak často se cena mění, zda TV ukazuje realtime (ne
   zpoždění), jaký symbol/kontrakt je na grafu.
2. Krátký návrh (transport A + B + C) → `copier-design-critic` (worker
   část) + kontrola `INV-UI-*` (`docs/COPIER_INVARIANTS.md`).
3. Kanál A za feature flagem → 4. dnešní svíčky + živá svíčka → 5. P&L
   s kotvou (jen po souhlasu z kroku 0).
6. Plynulost grafů (D) — nezávislé, může jít souběžně s čímkoli.

## 5. Otevřené otázky
- ~~Souhlas se změnou pravidla (P&L z TV jen pro zobrazení).~~ Ano (26. 10.,
  bod 6).
- Autentizace workeru pro Realtime a kvóty (bod A).
- ~~Má Filip v TradingView realtime CME data (ne zpožděná)?~~ Ano, ověřeno
  měřením (bod 7).
- Až worker poběží na VPS, TV zůstane na Macu → živá cena závisí na Macu;
  je to přijatelné?

## 6. Rozhodnutí Filipa (26. 10. 2026)

- **Pravidlo TV dat**: cena z TradingView smí počítat P&L **zobrazené na
  obrazovce**; nikdy risk brány, day lock, limity ztráty, kopírku ani jinou
  automatiku. Formulace je v `lib/tradingViewBars.ts` (hlavička).
- V TradingView má realtime CME data (potvrzeno i měřením níže).
- Začít krokem 1 a bodem D.

## 7. Výsledky kroku 1 — měřicí sonda (26. 10. 07:10 CET)

Skript `scripts/market-data/tvPriceFeedProbe.ts` (jen `Runtime.evaluate`
s výrazy bez vedlejších efektů, nic nepřepíná; testy
`tests/tvPriceFeedProbe.test.ts`). Spuštění:
`npx tsx scripts/market-data/tvPriceFeedProbe.ts --duration 60 --interval 100 --cold 20 --json out.json`.
Měřeno v noční Globex seanci (01:10 CT, klidný trh) na 2 oknech TV
(`chart/2Na0Tv48` 5m+1m, `chart/JLtpkCHq` 1m), 60 s po 100 ms.

| Co | Výsledek |
|---|---|
| Realtime vs zpoždění | **realtime**: `quotes().update_mode = "streaming"`, symbol `CME_MINI:MNQ1!` (zpožděná varianta by byla `CME_MINI_DL:`), poslední 1m svíčka = aktuální minuta |
| Kontrakt za `MNQ1!` | `symbolInfo().front_contract = MNQZ2026` → Tradovate `MNQZ6`; přepnutí TV na další kontrakt `quotes()['front-contract-switch-time']` = 14. 12. 2026 22:00 UTC (za 49,7 d) |
| Multiplikátor, tick | `pointvalue 2`, tick 0,25 (`minmov 25 / pricescale 100`) |
| Čtení přes trvalé CDP spojení | RTT p50 1,3 ms, p95 18 ms (ocas = během měření se v TV přepnul timeframe grafu, UI bylo zaneprázdněné); výraz v TV p50 0,1 ms |
| Čtení cestou dnešního workeru (nové spojení) | p50 6,6 ms, p95 17 ms |
| Velikost odpovědi | lehký výraz 300–500 B (všechny grafy v okně); celé 1m okno 16,5 kB (TV mělo načteno jen ~326 svíček) |
| Jak často se cena mění (1m) | 1,45–1,58×/s, nejvíc 4/s, změna v 83–85 % vteřin; mezera p50 0,4–0,5 s, p95 1,4–1,7 s, **max 2,3–2,6 s** |
| Čtení po 250 ms | 1,4–1,5 zprávy/s (≈ 5,2–5,5 tis./h), zpoždění průměr ~120 ms, p95 ~240 ms |
| Čtení po 500 ms | 1,2–1,3 zprávy/s (≈ 4,4–4,7 tis./h), zpoždění ~255 ms, p95 ~480 ms |
| Čtení po 1 s (dnes) | 0,7 zprávy/s, zpoždění ~490 ms, p95 ~970 ms |
| Dvě okna se stejným grafem | stejná cena v 77 % čtení, rozdíl max 1,5 bodu (každé okno má svůj stream) |

Důsledky pro návrh A/B:
- CDP čtení není úzké hrdlo — 250 ms je levných; použít **trvalé spojení**
  (studená cesta je ~5× pomalejší) a lehký výraz (poslední svíčka +
  `series.quotes()`: `last_price`, `bid`, `ask`, `update_mode`).
- `lp_time` v kotaci je jen minuta (začátek svíčky), ne čas obchodu — na
  čerstvost nepoužívat. Kotace a svíčka jsou dva streamy TV, vůči sobě
  ±100–500 ms; pro P&L brát jeden zdroj (1m svíčka = to, co je v grafu).
- Cena i v noci stojí až ~3 s → „stojí“ odvozovat ze **sekvence/heartbeatu**
  zprávy (≥ 1/s), ne ze změny ceny.
- Roll: porovnávat `front_contract` s kontraktem pozice; čas přepnutí TV je
  známý dopředu (`front-contract-switch-time`).
- Zpoždění detekovat `update_mode` + `_DL:` + svíčka vs hodiny
  (`classifyFeed` ve skriptu).
- Kvóty Realtime: noc ~1,5 zprávy/s; při otevření USA bude cena měnit
  častěji (strop 4/s při 250 ms ≈ 14,4 tis./h) → **změřit znovu v 15:30–16:30
  CET** stejným skriptem.
- Zdroj ceny = jeden konkrétní graf (1m), ne „první okno, co odpoví“ —
  dvě okna se stejným symbolem se na okamžik liší až o 1,5 bodu.

## 8. Bod D — ověření a měření (26. 10. 2026)

Měřeno v dev buildu ve vestavěném prohlížeči (Chromium, Mac), přihlášený
účet, panel viditelný (skrytá záložka škrtí rAF i časovače — měření by
lhalo). Nástroje: React Profiler (dočasně), Long Animation Frames, JS
Self-Profiling API (dočasná hlavička `Document-Policy` jen ve worktree),
počítadlo rAF. Dev React je ~3–5× pomalejší než produkce — čísla jsou horní
odhad, poměry platí.

| Bod z předávky | Ověření | Verdikt |
|---|---|---|
| Checkpoint backtestu 1,2 s | Node bench se skutečnou `ChartWorkspaceHistory` + CandleKit kresbami: 0,04 ms (2×20 kreseb) – 0,29 ms (4×150) na volání → ≤ 0,44 ms/s i s druhou kadencí 1,5 s | zanedbatelné, **beze změny** |
| Dopočet analytiky 2 s | klient posílá ořezané obchody, ledger/zdroje jen při změně reference, worker cachuje hashe | už optimalizované, **beze změny** |
| Odpočty 1 s / 250 ms | `ZonedClock` izolovaný; odpočet svíčky v grafu má Filip vypnutý (výchozí off); `CopierCooldownPanel` jen při běžícím cooldownu | malé; **skutečný náklad je LIVE** (níže) |
| Živé aktualizace mimo React | graf už používá `updateBar` (celé `setData` jen při prepend/couvnutí) | týká se kanálu A, až vznikne |
| 202× `backdrop-blur` | na dotykových zařízeních vypnuto 25. 10.; Filipův Chrome blur nekreslí; posun grafu v Chromiu plynulý | **beze změny** |
| Struktura/FVG ve workeru | už přírůstkové akumulátory (O(1) na svíčku) | **beze změny** |
| Historie bez virtualizace | **skutečný problém** — viz níže | **opraveno část** |

Graf sám: Deník dne, 6 s nepřetržitého zoomu a posunu kolečkem → 60 fps,
snímek p50 16,7 ms, p99 17,7 ms, 0 dlouhých snímků. V klidu JS ~2,6 %
hlavního vlákna (profil 70 s); jednou za minutu dávka 61–107ms úloh ze
synchronizace deníku v `App` (v dev vrací `journal-import` 405 z read-only
proxy, takže produkce se může lišit).

**LIVE (největší naměřený náklad, neopraveno)**: 4,3 commitu/s, render
p50 23 ms, p95 35 ms → ~95 ms renderu za sekundu (dev); 41 dlouhých snímků
za 30 s. Rozpad: sekundový tik `freshnessNow` v `TradovateLiveDesk`
(~25–38 ms/s), každý poll relaye (~2,3 s) kaskáda 4–6 commitů
(~80–110 ms), obnova ~15 s 21 commitů (~260 ms). Tik nejde jen zředit:
`LiveCopyTradeOverview` čte `Date.now()` přímo v renderu (`dayLockActive`,
`connectBlocked` tlačítka ON, souhrn dne, stáří hodnot) a spoléhá na
sekundové překreslení celého LIVE. Oprava = časově závislé údaje do malých
komponent s vlastními hodinami + slučování commitů pollu → samostatný krok
s `copier-design-critic` (INV-UI-01..03).

**Historie (opraveno, větev `claude/chart-smoothness-20261026`)**: každé
`onLoad` screenshotu měnilo stav celé Historie a efekt náhledů kopírky se
po každé pětici podepsaných URL restartoval a přerenderoval všechny karty.
15 s scrollu se 170 kartami: **116 commitů / 5,6 s renderu → 3,5 s**,
nejdelší commit 414 → 251 ms (dev). Náhled má vlastní stav načtení
(`components/HistoryShotImage.tsx`), náhledy kopírky se do stavu slučují
(první pětice hned, další po 400 ms). Zbývá O(n) render celé historie při
„načíst další“ a sloučených náhledech → další krok: memoizované karty.

Další kroky D: (1) LIVE refaktor výše; (2) memoizace karet historie;
(3) zbytečné rendery `App` při minutové synchronizaci beze změny (změřit
v produkčním buildu); (4) změřit LIVE a historii na iPhonu (Web Inspector
nebo perf značky appky).
