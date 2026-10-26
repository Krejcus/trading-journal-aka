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

## iPhone

Čeká na Filipa (telefon byl při měření nedostupný). Postup:
`./scripts/ios/perf-measure.sh <App.app> final-<datum> 3` s několika
zahřívacími spuštěními navíc — čistá instalace maže cache WebKitu i základ
syncu, první start pak dělá úplné čtení (na iPhonu 22,9 s) a první běhy
jsou studené. Pokus 25. 10. 22:01 byl neplatný: `devicectl` ztratil spojení
(`NWError 60`) a zachytil jen 5 z 7 spuštění.

## Vědomě neudělané / další krok

- Tvar základu je „těžký“ (`getTrades` mapování vč. kreseb a analytiky,
  ~7 MB); lehčí základ by zrychlil hlavně telefon — změnit až po měření iPhonu.
- `row_version` a CAS na řádku pro zápisy (review opravy 5–6) — mimo fázi 2.
- Přesun `journal-import` do `arn1` až po sledování zátěže DB (oponentura).
- Zátěž DB po odebrání `trades` z Realtime ověřit za pár dní v
  `pg_stat_statements` (review: Realtime ~40 % času DB).
- Relay se zablokuje na checkpointu s neznámou delivery (copier-core, karta
  úkolu z 25. 10.).
