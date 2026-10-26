# Závěrečné měření po fázích 1–2 (25.–26. 10. 2026)

Srovnání s výchozím stavem `docs/reviews/perf-baseline-phase0-20261025.md`,
stejný postup (produkční web, vestavěný prohlížeč Claude desktopu, Chromium
na MacBooku Air, panel viditelný, jen čtení). Návrh:
`docs/reviews/sync-phases-1-2-design-20261025.md`.

## Co je nasazené

| Změna | Commit | Kde |
|---|---|---|
| Relay kopírky a DB funkce v `arn1` (u databáze) | `5cc29867` | Vercel (`x-vercel-id: …::arn1::…` ověřeno) |
| Migrace `20261025220000_sync_changes_v1` (záznam změn, kurzor, meta RPC, úklid) | `eb38c899` | produkční DB (záloha `20261025T201027Z` před migrací) |
| Delta sync obchodů, Realtime přes `sync_changes`, opravy fáze 1 | `eb38c899`, `57f9f951` | web + iOS build |
| `trades` odebrané z Realtime publikace | `20261025230000` | produkční DB (publikace: `ai_messages`, `sync_changes`) |

## Web — start stránek

Medián 3 běhů u dashboardu, 1 běh u ostatních; verze `57f9f951`.

| Co | Před | Po | Změna |
|---|---|---|---|
| Dashboard z cache | 0,39 s | 0,34 s | ≈ |
| **Dashboard — čerstvá data** | **5,9 s** | **0,58 s** | **10× rychleji** |
| Dashboard — síť utichne | 15,4 s | 2,4 s | 6× |
| Dashboard — API požadavků při startu | 228 | 32 | −86 % |
| Dashboard — dlouhé úlohy | ~6×, 0,55 s | 3×, 0,22 s | −60 % |
| **Historie — čerstvá data** | **6,6 s** | **0,39 s** | **17×** |
| Historie — síť utichne | 15,4 s | 2,3 s | 7× |
| Historie — požadavků (vč. 61–62 obrázků) | 286 | 91 | −68 % |
| **LIVE — první stav kopírky** | **1,6 s** | **0,38 s** | **4×** |
| LIVE — odhalení stránky | 2,05 s | 1,24 s | −40 % |
| LIVE — požadavků za prvních 30 s | 259 | 72 | −72 % |

Delta syncu při startu: 0,07–0,37 s (první delta v relaci načítá RPC, další
jen kurzor ~0,08 s). Jednorázové první spuštění po nasazení (bez základu)
udělalo úplné čtení 14,2 s na pozadí — od dalšího startu už jen delta.

## Web — relay kopírky

| Co | Před (iad1) | Po (arn1) |
|---|---|---|
| dotaz na stav kopírky (medián) | 0,76 s | **0,19 s** |
| server: auth / resolve / runtime | 156 / 314 / 157 ms | **27 / 48 / 24 ms** |
| dotazů za minutu na LIVE | 44 | 54 (smyčka čeká až po odpovědi, rychlejší odpověď = častější) |
| čas serveru za minutu (dotazy × doba) | ~33 s | ~11 s |

Doručení příkazu kopírce přes `arn1`, ověřeno jen čtením
`tradovate_copier_commands`: jediný příkaz od přesunu (`snapshot-test`
26. 10. 05:35 UTC) worker převzal za 0,38 s a dokončil za 0,65 s. Před
přesunem bylo převzetí 0,56–1,98 s a dokončení 1,2–4,2 s (8 posledních
úspěšných příkazů 21.–23. 10.).

Ruční zkouška brzdy z telefonu (Filip, 26. 10. 05:48 UTC, kopírka bez
pozic):

| Příkaz | Převzetí | Hotovo | Před přesunem (převzetí / hotovo) |
|---|---|---|---|
| ARM | 0,52 s | 2,04 s | 1,1–2,0 s / 2,0–4,2 s |
| **DISARM** | **0,29 s** | **0,51 s** | 0,56–1,03 s / 1,17–1,80 s |

Po zkoušce: DISARMED, `lastError` prázdný, žádná divergence, outbox bez
zaseknutí.

## Web — klid

| Stránka | Požadavků/min před | po | Hlavní vlákno volné před → po |
|---|---|---|---|
| LIVE | 67 | 76,5 (relay rychlejší, viz výše) | 926 → 916 ms/s |
| **Deník dne** | **45 (37,5× upsert kreseb)** | **0** | 931 → 946 ms/s |
| Dashboard | 9 | 0 v 40s okně (journal sync 1× za minutu) | 907 → 942 ms/s |

Scroll historie: 60 fps, žádný snímek nad 34 ms (beze změny — na Macu
plynulost problém nebyla).

## Konzistence dat

Stará cesta (plné RPC + hydratace) a nová (meta RPC + delta) ukazují na
dashboardu tatáž čísla (Net P&L +$4 268, výhry/BE/ztráty 859/23/1086) —
ověřeno vynuceným během staré cesty 26. 10. 00:05. Realtime ověřen
koncem na konec: vložený řádek do `sync_changes` spustil v otevřené appce
deltu a dočtení obchodu.

## iPhone (26. 10. 06:26–06:50)

iPhone 13 Pro Max, Debug build, Wi-Fi. Syslog jde jen přes USB kabel, takže
appka si značky ukládá do localStorage (`at:perf:runs`, `c08a42c6`) a ty se
stáhly z kontejneru appky bezdrátově (`devicectl device copy from`). Každý
build: čistá instalace, 1 + 3 zahřívací starty (úplné čtení základu na
iPhonu 22,9 s jednorázově), pak 3× Dashboard + 3× LIVE.

Poctivé A/B ve stejný den na stejném telefonu — **A** = `main` těsně před
změnami (`1115d799`, jen s ukládáním značek), **B** = finální build:

| Co | A: před změnami | B: po změnách |
|---|---|---|
| **Dashboard — čerstvá data** | **9,5 s** (9,4–11,0) | **1,2 s** (1,05–1,49) |
| Dashboard z cache | 1,30 s | 0,64 s |
| Zaseknutí > 100 ms na start (dashboard) | 16–18×, celkem 4,1–13,0 s | 10–16×, celkem 1,8–3,3 s |
| LIVE — první stav kopírky | 2,05 s | 1,85 s |
| LIVE — odhalení stránky | 2,28 s | 2,45 s |
| relay kopírky | 0,23 s | 0,25 s |

Relay vychází stejně, protože přesun do `arn1` je na serveru a platil pro
oba buildy (výchozí měření ze 17. 10., ještě `iad1`: 0,79 s). Proti
výchozímu stavu z fáze 0 (build ze 17. 10.): dashboard 8,2 → 1,2 s, první
stav kopírky 2,85 → 1,85 s. Zaseknutí při startu je víc než u buildu ze
17. 10. (1–3×), ale to je od jiných změn appky za poslední týden — build A
bez delta syncu jich má ještě víc; delta sync je snížil zhruba na polovinu.
Zbytek je vykreslování dashboardu po startu (kandidát na další krok).

Při prvním bezdrátovém měření se v DB objevily zápisy šesti backtest
obchodů (05:28–05:31 UTC); během měření A ani při dalších startech se
neopakovaly — nejde o smyčku nového kódu (pravděpodobně souběžná práce
v appce).

## Vědomě neudělané / další krok

- Tvar základu je „těžký“ (`getTrades` mapování vč. kreseb a analytiky,
  ~7 MB); lehčí základ by zrychlil hlavně telefon.
- Zaseknutí při startu na iPhonu (10–16× po >100 ms) — vykreslení dashboardu
  (Monte Carlo, grafy) po načtení; samostatný krok.
- `row_version` a CAS na řádku pro zápisy (review opravy 5–6) — mimo fázi 2.
- Přesun `journal-import` do `arn1` až po sledování zátěže DB (oponentura).
- Zátěž DB po odebrání `trades` z Realtime ověřit za pár dní v
  `pg_stat_statements` (review: Realtime ~40 % času DB).
- Relay se zablokuje na checkpointu s neznámou delivery (copier-core, karta
  úkolu z 25. 10.).
