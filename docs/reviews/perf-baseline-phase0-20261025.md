# Fáze 0: výchozí měření rychlosti a plynulosti (25. 10. 2026)

Výchozí stav **před** synchronizací přes verze a před rychlými opravami
z `docs/reviews/supabase-vercel-usage-20261025.md`. Každá další změna se má
porovnat se stejným postupem (sekce „Jak měřit znovu“).

Stav: **hotovo** — web a start appky na iPhonu. Safari Timeline (plynulost
na iPhonu) a backtest replay se neměří: Filip 25. 10. rozhodl, že pro
výchozí stav stačí web a appka. Postup pro Timeline zůstává na konci pro
případné pozdější měření.

## Prostředí

- Produkční web `alphatrade-mentor-15.vercel.app` (main `6b978510`, produkční
  build), Filipův skutečný účet: ~4 800 obchodů, z toho 1 152 journal, 205 backtest.
- Prohlížeč: vestavěný prohlížeč Claude desktopu (Chromium 152) na MacBooku
  Air (8 jader), okno 1107×773, panel viditelný po celou dobu měření
  (skrytá záložka škrtí rAF i časovače — ověřováno, `hiddenEvents: 0`).
- Neděle 25. 10. 19:15–20:00 SEČ, trh zavřený, kopírka v klidu.
- Jen čtení: stránka se volila přes `sessionStorage['alphatrade:nav-restore']`
  a reload, nic se neklikalo. Režim dashboardu `combined` zůstal beze změny.

## Výsledky — načtení stránky

Časy jsou ms od začátku načtení stránky (značky `__atPerf` z appky,
`localStorage['at:dev:perf']='1'`). Dashboard 4 běhy (medián), ostatní 1 běh.

| Stránka | Hotovo z cache | Čerstvá data | Síť utichne | API požadavků do utichnutí | Dlouhé úlohy (≥ 50 ms) |
|---|---|---|---|---|---|
| Dashboard | **0,39 s** (0,31–0,65) | **5,9 s** (5,8–6,1) | 15,4 s | 228 | ~6×, celkem ~0,55 s, max 0,1–0,27 s |
| Historie | — | 6,6 s | 15,4 s | 286 (z toho 61 obrázků ze Storage) | 4×, 0,28 s |
| LIVE (studený start) | stav kopírky 1,6 s, odhalení 2,05 s | dashboard RPC až po LIVE | — (polling) | 259 za 30 s | 6×, 0,46 s |
| Portfolio | — | 8,2 s (RPC 3,8 s v konkurenci) | 18,3 s | ~245 | 4×, 0,36 s |
| Deník dne (graf) | — | journal fakta 5,1 s | — | neměřeno celé | 6×, 0,51 s |

**Rozpad čerstvých dat dashboardu** (medián 4 běhů):

| Krok | Čas |
|---|---|
| `get_dashboard_data_light_v1` (RPC) | 1,54 s (1,47–1,63) |
| journal fakta (`hydratePrivateJournalFacts`) | **2,90 s** (2,70–2,96) |
| poznámky (`hydratePrivateTradeNotes`) | 1,31 s (1,26–1,35) |
| **celkem do `boot:refresh-done`** | **5,9 s** |

Review odhadovalo journal fakta na ~1,2 s; v prohlížeči jsou největší položkou.

**Co se při každém otevření appky stahuje navíc** (dashboard, historie, LIVE
i Portfolio stejně):

| Dotaz | Počet | Součet času | Rozpětí |
|---|---|---|---|
| `trades` (stránky) | 23 (historie 28) | ~8,5 s | 0,4–11,1 s |
| `journal_trade_snapshots` (view) | 50 | ~16,5 s | 0,9–13,8 s |
| `tradovate_journal_positions` | 26 | ~3,6 s | 0,8–11,8 s |
| `rpc/get_trade_note_projection_v1` | 48 | ~3,9 s | 1,3–14,4 s |
| `backtest_trade_note_histories` | 48 | ~5,4 s | 1,4–15,1 s |
| `tradovate_journal_projection_heads` | 14 | ~1,0 s | 0,6–15,2 s |

Příčina (ověřeno v kódu): `runCopierJournalSync` v `App.tsx` běží hned po
startu a `services/journalImportSync.ts` při „first visit“ vždy volá
`loadTrades` → plné `storageService.getTrades()`. Paměť přečtených stavů
(`journalVerifiedReadsRef`) je jen v RAM, takže **každé otevření appky = druhé
plné čtení všech obchodů** vedle dashboard RPC. Na Portfoliu tím dashboard RPC
vyskočilo z 1,5 na 3,8 s. Review tuhle spoušť startu neuvádí (zmiňuje Realtime,
sync každých 20 s a návrat do záložky).

## Výsledky — LIVE a kopírka

| Co | Hodnota |
|---|---|
| první `live:status` / `live:conn-ready` | 0,75 s / 1,5 s |
| první stav kopírky / odhalení stránky | 1,6 s / 2,05 s |
| relay stavu kopírky (`/api/tradovate/oauth/copier-relay`) | 44×/min (každých ~1,4 s), **0,76 s** na dotaz (max 1,06 s) |
| z toho na serveru (`Server-Timing`, medián) | auth 156 ms + resolve 314 ms + runtime 157 ms ≈ **0,63 s** |
| `live-pnl` | 12×/min, ~0,56 s |
| `history-sync` při startu | 5× ~2,1 s (7,7–10,1 s) |
| základ: jednoduchý PostgREST dotaz z Prahy | 76–115 ms |

Většina času relaye je na serveru — Vercel funkce v `iad1` dělá 3–4 dotazy
do DB ve Stockholmu (review 1a). Přesun regionu je copier-core transport →
INV + `copier-design-critic`.

## Výsledky — klid a plynulost

Okno 40–60 s po ustálení stránky (30 s po načtení). Volný čas hlavního vlákna
z `requestIdleCallback` (1 000 ms/s = úplně volné).

| Stránka | Požadavků/min | Hlavní vlákno volné | fps | Dlouhé úlohy |
|---|---|---|---|---|
| LIVE | **67** (relay 44, live-pnl 12, journal-import 6, status 2) | 926 ms/s | 60 | 0 |
| Deník dne (graf) | **45** (`chart_drawings` **37,5/min**) | 931 ms/s | 60 | 0 |
| Dashboard | 9 | 907 ms/s | 60 | 2 (0,11 s / 40 s) |
| Historie | 9 | 912 ms/s | 60 | 0 |

Scroll (rAF krok 24 px, 8 s): historie 60 fps, 0 snímků nad 34 ms
(16 prvků s `backdrop-filter`); dashboard 60 fps (3 prvky).

**Na Macu je problém čekání na síť, ne výkon zařízení**: v klidu je hlavní
vlákno z ~91–93 % volné a scroll drží 60 fps. Časovače z předávky
(checkpoint, plán analytiky, překreslování) v klidu na těchto stránkách
nezatěžují CPU měřitelně; výjimka je síť — deník dne se na `chart_drawings`
ptá každých ~1,6 s, i když se nekreslí.

## Co z toho plyne pro návrh (fáze 1–2)

1. **Největší jednotlivá úspora na startu**: nepouštět plné `getTrades()`
   z journal syncu při každém otevření (perzistentní „verified read“ nebo
   delta). Dnes ~200 požadavků a ~11–15 s sítě na pozadí každého startu
   a konkurence s LIVE i dashboard RPC.
2. **Čerstvá data dashboardu 5,9 s** — journal fakta (2,9 s) a poznámky
   (1,3 s) jsou přes polovinu; RPC už poznámky obsahuje (review 1c).
3. **Relay kopírky**: 0,63 s ze 0,76 s je server → region u DB.
4. **Deník dne**: polling `chart_drawings` 37,5×/min → změny přes Realtime/
   verze, nebo delší interval, když se nekreslí.
5. Plynulost na Macu je v pořádku; skutečný test je iPhone (WebKit,
   `backdrop-filter`, 12. 10. naměřeno 28 zamrznutí s průměrem 287 ms
   v prvních 25 s po studeném startu bez cache).

## Omezení měření

- Chromium na Macu není WebKit na iPhonu — plynulost a dlouhé úlohy se musí
  změřit na telefonu.
- U požadavků na Supabase nejsou velikosti odpovědí (chybí
  `Timing-Allow-Origin`), jen časy.
- První 3 běhy dashboardu měly plný buffer Resource Timing (250) — značky
  `__atPerf` to neovlivnilo, síť se brala ze 4. běhu se zvětšeným bufferem.
- Neměřeno: studený start bez IndexedDB cache (vymazání by mohlo smazat
  neodeslané outboxy), backtest replay (otevření běhu ukládá checkpointy —
  měřit s Filipem), interakce s grafem.

## Jak měřit znovu

1. V produkčním webu: `localStorage['at:dev:perf']='1'`, stránka přes
   `sessionStorage['alphatrade:nav-restore']='{"page":"<stránka>","journalTab":"daily"}'`,
   reload (nástroj `navigate`) a hned `performance.setResourceTimingBufferSize(5000)`.
2. Po 25–30 s: značky z `window.__atPerf`, síť z
   `performance.getEntriesByType('resource')` (skupiny podle endpointu),
   dlouhé úlohy z `PerformanceObserver` (`longtask`, `long-animation-frame`,
   `buffered: true`).
3. Klid: `performance.clearResourceTimings()`, 40 s počítat rAF snímky,
   `requestIdleCallback` volno, `longtask` a požadavky za minutu.
4. Po měření měřicí klíče z `localStorage` smazat.

## iPhone — start appky (25. 10. 20:23–20:26)

iPhone 13 Pro Max, nainstalovaná appka (Debug build nativního obalu, web
z `main` ze 17. 10.), teplá cache, Wi-Fi. `./scripts/ios/perf-measure.sh
--installed baseline-20261025 3`: 1 zahřívací + 3× Dashboard + 3× LIVE.
Syslog z telefonu u části procesů ztratil první řádky (i značku `origin`),
proto vestavěný report sloučil běhy do dvou — rozebráno po procesech (PID);
počty požadavků jsou proto spodní odhad.

| Co | 3 běhy | Medián |
|---|---|---|
| Dashboard z cache (`boot:dashboard-paint`) | 0,47 s (jediný čistý vzorek; zahřívací 0,96 s) | 0,47 s |
| dashboard RPC (fetch) | 2,00 / 1,94 / 1,80 s | **1,94 s** |
| journal fakta (od `dash:rpc-done`) | 3,45 / 3,67 / 3,39 s | **3,45 s** |
| poznámky | 1,81 / 1,84 / 1,75 s | 1,81 s |
| čerstvá data dashboardu (`boot:refresh-done`) | 8,31 / 8,23 / 8,05 s | **8,23 s** |
| LIVE odhalení (`live:reveal`) | 1,88 / 1,69 / 1,77 s | 1,77 s |
| LIVE první stav kopírky | 3,41 / 2,59 / 2,85 s | **2,85 s** |
| relay kopírky (fetch) | med 0,79 / 0,77 / 0,82 s | ~0,79 s (server ~0,64 s: auth 150 + resolve 332 + runtime 155 ms) |
| zamrznutí hlavního vlákna > 100 ms (prvních 25 s) | 1–3× na spuštění, max 105–183 ms, celkem 105–339 ms | — |
| plné čtení obchodů při každém startu | ≥ 46 dávek snapshotů, ≥ 19–23 stránek `trades` | — |

Srovnání s 12. 10. (PROJECT_LOG; tehdy po přeinstalaci bez cache): stav
kopírky při studeném startu 3,2–7,4 s → teď 2,6–3,4 s; dashboard tehdy
vykreslen až za 13,3 s s 28 zamrznutími (průměr 287 ms) → teď z cache
za 0,47 s a 1–3 krátká zamrznutí. Čerstvá data dashboardu jsou na iPhonu
o ~2,3 s pomalejší než na Macu (8,2 vs 5,9 s), hlavně journal fakta
(3,45 vs 2,90 s) a RPC (1,94 vs 1,54 s).

## iPhone — volitelné další měření (zatím se nedělá)

1. **Start appky** — hotovo výše. Opakování (nainstalovaná verze, nic se nepřeinstaluje):
   `./scripts/ios/perf-measure.sh --installed baseline-20261025 3` — telefon
   odemčený na stole; skript appku 7× spustí (1 zahřívací + 3× Dashboard +
   3× LIVE) a uloží značky AT-PERF včetně zamrznutí hlavního vlákna
   (`jank:frame`) do `~/alphatrade-build/perf/baseline-20261025/`.
2. **Plynulost (Safari Timeline)**: na iPhonu Nastavení → Safari → Pokročilé →
   Web Inspector; kabel k Macu; produkční web v Safari na iPhonu; na Macu
   Safari → Vývojář → iPhone → stránka → Timelines; nahrát ~15 s na
   dashboardu (scroll), historii (scroll), LIVE a deníku dne; exportovat.
3. **Backtest replay**: Filip otevře běh a 30 s přehrává, měří se stejně jako
   bod 2 (nebo na Macu v náhledu přes `requestIdleCallback`/rAF).
