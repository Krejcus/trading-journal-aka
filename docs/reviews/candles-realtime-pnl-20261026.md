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
- Souhlas se změnou pravidla (P&L z TV jen pro zobrazení).
- Autentizace workeru pro Realtime a kvóty (bod A).
- Má Filip v TradingView realtime CME data (ne zpožděná)?
- Až worker poběží na VPS, TV zůstane na Macu → živá cena závisí na Macu;
  je to přijatelné?
