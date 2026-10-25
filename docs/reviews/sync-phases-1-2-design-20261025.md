# Návrh: fáze 1–2 synchronizace přes verze (25. 10. 2026)

Vychází z `docs/reviews/supabase-vercel-usage-20261025.md` (review),
`docs/reviews/perf-baseline-phase0-20261025.md` (výchozí měření) a rozhodnutí
Filipa v PROJECT_LOG (vlastní sync nad Postgresem, ne placený nástroj; offline
úpravy se neřeší; jeden uživatel, multi-user se neřeší).

## Cíl a výchozí čísla

| Co | Dnes (web / iPhone) | Cíl |
|---|---|---|
| čerstvá data dashboardu po startu | 5,9 s / 8,2 s | < 1 s, když se od minula skoro nic nezměnilo |
| síť při každém startu | ~228 požadavků, utichne za 15 s | jednotky požadavků |
| LIVE: dotaz na stav kopírky | 0,76 s (0,63 s server v USA) | ~0,2 s |
| deník dne v klidu | upsert kreseb každých 1,7 s | nic |

## Fáze 1 — rychlé opravy (bez nového syncu)

| # | Oprava | Soubor | Proč |
|---|---|---|---|
| 1.1 | Podpis kresby nezávislý na pořadí klíčů | `services/chartDrawingLayer.ts`, `services/chartAnnotationMigration.ts` | `jsonb` vrací klíče jinak seřazené → `ShortPosition` kresby vypadají pořád změněné → upsert každých 1,7 s |
| 1.2 | `needsReview` posílat jen při změně z `true` | `components/BacktestTradeReviewDialog.tsx` | 204/205 backtest obchodů pole nemá, klient z něj dělá `false` → CAS konflikt 55000 (spoušť retry bouře 25. 10.) |
| 1.3 | Backtest analytics outbox: backoff, pauza ve skryté záložce, zahození položky smazaného obchodu (P0002) | `services/backtestAnalyticsOutbox.ts`, `App.tsx` | dnes zaseknutá položka = 2 RPC každých 5 s navždy |
| 1.4 | Journal sync z prohlížeče 20 s → 60 s | `App.tsx` | cron importuje každou minutu; nové obchody stejně dorazí přes Realtime |
| 1.5 | `send-alerts`: odstranit globální `.limit(500)` u `tradovate_copier_trades` | `api/cron/send-alerts.ts` | chyba správnosti (u více dat by se notifikace ztrácely) |
| 1.6 | `Cache-Control: immutable` pro `/assets/*` | `vercel.json` | hashované soubory se nemusí znovu ověřovat |

## Fáze 2 — delta sync obchodů přes verze

### Princip

Obchod v appce je složený z řádku `trades` + journal pozice
(`tradovate_journal_positions`) + snapshoty kopírky (view
`journal_trade_snapshots` nad `copier_trade_snapshots` a
`tradovate_copier_trades`) + poznámky (`trade_private_notes`,
`backtest_trade_note_histories`). Všechno je klíčované ID obchodu.
Server vede záznam změn; klient si pamatuje kurzor a při startu, po importu
nebo po Realtime události stáhne jen **seznam změněných ID** a ty dočte
**stejnými funkcemi jako dnes** (`getTradesOnce` mapování + hydratace faktů
a poznámek). Server tedy neposílá rozdíly, ale klient vždy dočte aktuální
složený stav změněných obchodů (review: „posílat stav místo rozdílů“).

### Server (migrace)

- `public.sync_changes(id bigserial, user_id uuid, entity text, entity_id text,
  xid xid8 default pg_current_xact_id(), created_at timestamptz)` + index
  `(user_id, xid)` a `(created_at)`. RLS: vlastník smí jen číst.
- Trigger `sync_log_change()` (SECURITY DEFINER, `search_path=''`, jen jeden
  INSERT, nikdy nevyhazuje chybu do zápisu) AFTER INSERT/UPDATE/DELETE na:
  - `trades` → entita `trade` = `id` (UPDATE jen `WHEN old.* IS DISTINCT FROM new.*`),
  - `tradovate_journal_positions` → `trade` = `trade_id` (OLD i NEW, když se liší);
    UPDATE jen při změně `trade_id, journal_account_id, status, facts, history` —
    holá změna `revision` se nelogují (jinak by každá nová revize projekce
    znamenala dočíst všech ~1 150 journal obchodů),
  - `trade_private_notes`, `backtest_trade_note_histories` → `trade` = `trade_id`,
  - `copier_trade_snapshots`, `tradovate_copier_trades` → `episode` = `episode_id`.
  (Review oprava 1: triggery jen při skutečné změně, OLD i NEW ID.)
- `public.sync_meta(id=1, epoch int, horizon_xid xid8)` — `epoch` se zvedne
  při obnově DB nebo změně výpočtu (všichni klienti udělají plné čtení),
  `horizon_xid` posouvá úklid.
- RPC `sync_trade_changes_v1(p_cursor text, p_epoch int)` — STABLE,
  SECURITY INVOKER, filtr vlastníka:
  - kurzor = `pg_snapshot_xmin(pg_current_snapshot())` z jednoho snapshotu
    (review: watermark pod READ COMMITTED; řádky ≥ xmin se mohou vrátit
    znovu, čtení je idempotentní),
  - `reset` při: chybějícím kurzoru, jiné epoše, kurzoru ≤ horizon (úklid),
    kurzoru > `pg_snapshot_xmax` (DB vrácená zálohou do minulosti), > 2 000 ID,
  - epizody se přeloží na ID obchodů přes `journal_trade_snapshots`.
- RPC `get_dashboard_meta_v1()` — totéž co `get_dashboard_data_light_v1`
  bez obchodů (profil, preference, účty, přípravy, review, weekly focus).
- `sync_prune_v1()` (jen service_role) — smaže záznamy starší 3 dnů a posune
  `horizon_xid`; volá ho cron `journal-import`.
- Realtime publikace: přidat `sync_changes` (malé řádky); `trades` z publikace
  odebrat až po nasazení nového webu i iOS appky.

### Klient

- `storageService.getTrades()` (vlastník) = **sync engine**:
  1. základ v IndexedDB `alphatrade_sync_trades_v1_<uid>` = `{epoch, cursor,
     trades, syncedAt}` (zapisuje jen engine — ostatní cesty do něj nesahají),
  2. bez základu / reset / základ starší 24 h → dvoufázový bootstrap:
     kurzor z RPC → plné `getTradesOnce` → uložit se starým kurzorem (změny
     během čtení přijdou v další deltě),
  3. jinak delta: změněná ID → `readTradesByIds` (dávky po 100, stejné
     mapování + hydratace) → nahradit/přidat/odebrat → uložit nový kurzor,
  4. souběžná volání se sloučí do jednoho běhu; jakákoli chyba delty =
     plné čtení (fail-safe, nikdy neukázat neověřený stav jako čerstvý).
- Dashboard při startu: když existuje základ, `getDashboardData` = 
  `get_dashboard_meta_v1` + `getTrades()` (delta) místo 6 MB RPC + hydratace
  všech 4 800 obchodů. Bez základu zůstává dnešní cesta.
- Realtime: místo `postgres_changes` na `trades` (celé řádky s `data`) se
  odebírá INSERT do `sync_changes` (filtr `user_id`); událost = sloučené
  `getTrades()` + aplikace jen změněných ID. Journal řádky dál přes
  `mergeImportedJournalTrades` (nepřepíše rozepsané review), ostatní po ID;
  toast „nový obchod“ zůstává.
- Journal sync: `loadTrades` = `getTrades()` → po importu jen delta.
- Brána zobrazení: dnešní chování (cache hned, pak čerstvá data) zůstává;
  když obnova trvá > 1,5 s, v hlavičce se ukáže nenápadné „Aktualizuji…“,
  offline štítek zůstává. Nic se neztlumuje (s deltou < 1 s by to blikalo).

### Pojistky (proč se nikdy neukáže staré jako aktuální)

- epocha, horizon a detekce „DB vrácená do minulosti“ → plné čtení,
- každá chyba delty → plné čtení; základ starší 24 h → plné čtení,
- journal fakta se dál ověřují hlavami projekce při každém čtení (beze změny),
- trigger na všech zdrojích složeného obchodu + test, že každá tabulka
  hydratace má trigger (registr v testu).

### Vědomě mimo tuto fázi

- `row_version` a CAS na řádku pro všechny zápisy (review opravy 5–6) — zápisy
  zůstávají jako dnes (CAS po polích tam, kde je); sync řeší čtení.
- Sjednocení ~30 cest `setTrades` do jednoho store — engine sedí pod
  `getTrades()`, takže je zrychlí všechny bez přepisu UI.
- Otevřené P&L ze streamu ceny, dnešní svíčky (mimo rozsah předávky).

## Kopírka — region relaye u databáze (copier-core transport)

- `vercel.json` `functions[...].regions = ["arn1"]` (Stockholm, u DB) pro funkce,
  které volají jen DB: `copier-relay`, `copier-device`, `copier-journal`,
  `pilot-lease`, `status`, `journal-import`, `journal-sources`,
  `account-profiles`, cron `journal-import` a `send-alerts`. Funkce volající
  Tradovate API (`preflight`, `live-pnl`, `history*`, `start`, `callback`)
  zůstávají v `iad1`.
- Mění se jen umístění, ne logika: dotčené INV-RELAY-01/02/03, INV-FRESH-02/03,
  INV-BRAKE-03, INV-UI-02, INV-WORKER-03 — kratší latence je drží beze změny;
  oponentura `copier-design-critic` před commitem.
- Push stavu kopírky místo pollingu se nedělá: worker posílá heartbeat každé
  2 s, takže push by zátěž nesnížil bez přepracování jádra (INV-FRESH-02).

## Plynulost na telefonu

- `backdrop-filter` vypnout na dotykových zařízeních (`pointer: coarse`) —
  sklo má vlastní výplň (paměť: Chrome bez blur), blur je jen bonus.

## Nasazení

1. záloha `scripts/backup-supabase.sh` (neděle večer = mimo obchodní dobu),
2. migrace (aditivní: tabulka, triggery, funkce) přes `db query -f` +
   `migration repair`, advisory,
3. web (push na main → Vercel), ověření v produkci,
4. iOS build z `main` a instalace na iPhone,
5. odebrání `trades` z Realtime publikace,
6. závěrečné měření stejným postupem jako fáze 0.

Rollback: web = předchozí deployment; DB = triggery `DROP` (sync_changes jen
přibývá, nic nečte appka bez nového kódu); `trades` zpět do publikace.
