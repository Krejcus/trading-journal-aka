# Review: využití Supabase a Vercelu (25. 10. 2026)

Kontext: e-mail Supabase „CPU > 80 %“ (příčina opravena migrací
`20261025130801`, viz PROJECT_LOG). Tohle review hledá, co dalšího zbytečně
zatěžuje DB, zabírá místo nebo zpomaluje appku — a co by se rozbilo při ~100
uživatelích. Zatím **nic z níže uvedeného není provedeno**.

Zdroje: `pg_stat_statements` (od 24. 10. 05:40Z, ~31 h), `pg_stat_user_tables`,
velikosti tabulek, Supabase edge/postgres logy (24 h), Vercel billing (22.–23. 10.),
čtení kódu (klient, server, worker).

## Hlavní čísla

| Co | Hodnota |
|---|---|
| Velikost DB | 5,3 GB z 8 GB (Pro) |
| `tradovate_journal_evidence` | 4,1 GB / 3,1 mil. řádků, 2,6 mil. z týdne 14. 9. (backfill 16. 9.) |
| Čas DB za 31 h (bez retry bouře) | ~3 500 s, z toho **Realtime 1 395 s (40 %)** |
| `journal_trade_snapshots` (view) | 4 079 volání × 200 ms = 815 s |
| `get_dashboard_data_light_v1` | 1,45 s průměr, max 6,9 s; vrací všech ~4 860 obchodů (~6 MB) |
| Odkud jdou požadavky do Supabase | **99,8 % z IAD (Washington)** — Vercel funkce běží v USA, DB ve Stockholmu |
| Vercel | ~1,31 USD/den efektivně (~40 USD/měs), z toho většina „Fluid Provisioned Memory“ (30 GB-h/den) |

## 1. Rychlost appky (to, co uživatel cítí)

**1a. Vercel funkce v USA, databáze ve Švédsku** — *nejvyšší dopad, nízké riziko*
`vercel.json` nemá `regions`, funkce běží v `iad1`. Každý API požadavek tedy jde
Praha → Washington → Stockholm (každý SQL dotaz ~100 ms tam a zpět) → Washington
→ Praha. Endpointy dělají 3–6 dotazů (getUser, oauth_connections, devices,
runtime…), takže jen latence je 0,5–1 s na požadavek. Kód to sám zmiňuje
(`server/tradovateCopierCommandRelay.ts:145`).
Návrh: přesunout funkce do `arn1` (Stockholm) nebo `fra1`. Výjimka k ověření:
cesty, které hlavně volají Tradovate API v USA (live-pnl, OAuth) — tam změřit.
Copier relay je DB-heavy → patří k DB. *Copier relay = copier-core transport,
před přesunem projít INV-* (latence brzd/heartbeat se má zlepšit, ne zhoršit).*

**1b. Plné přenačítání všech obchodů stokrát denně** — *vysoký dopad, střední riziko*
`storageService.getTrades()` (`services/storageService.ts:641-879`) stránkuje
všechny obchody s velkými JSON poli a pro každých 100 obchodů volá ještě 4 další
dotazy (journal positions, snapshots view, notes RPC, note histories).
Spouští ho: každá Realtime změna journal řádku (`App.tsx:2439`), journal sync,
návrat do záložky po 30 s (`App.tsx:2855`). Retry se vnořují (až 16 plných čtení).
Návrh: inkrementální načítání (`updated_at > cursor` nebo podle ID z Realtime
eventu), list bez těžkých analytických polí, detail až při otevření.

**1c. Dashboard RPC vrací vše** — `get_dashboard_data_light_v1` 1,45 s, při
každém otevření, bez `since`. Klient pak ještě znovu volá notes RPC (data už
obsahuje) a při 15s timeoutu pustí druhé plné čtení paralelně (`App.tsx:2285`
neruší první). Návrh: delta RPC `p_since`, vypustit duplicitní notes, AbortController.

**1d. View `journal_trade_snapshots` počítá párování při každém čtení** —
200 ms/volání, a je to hlavní důvod 81 mil. sekvenčně přečtených řádků
`tradovate_copier_trades` za 31 h. Návrh: párování (trade → episode) uložit do
tabulky při importu/projekci a view nahradit jednoduchým joinem s indexem.

## 2. Zátěž CPU databáze

**2a. Realtime `postgres_changes` = 40 % času DB.** V publikaci jsou `trades`
a `ai_messages`. Každá změna obchodu (i každý zápis backtest analytiky, ~12/min při
backtestu) se vyhodnocuje přes RLS a posílá celý řádek včetně `data`. Návrh:
klient odebírá jen journal řádky, nebo přejít na Broadcast (trigger pošle jen
`id` + typ změny) a data dočíst inkrementálně (souvisí s 1b). Ověřit, jestli
`ai_messages` Realtime vůbec někdo poslouchá.

**2b. Backtest analytics outbox každých 5 s i ve skryté záložce** —
`App.tsx:1846`, `services/backtestAnalyticsOutbox.ts`. Každá položka = 2 RPC
(prepare s `FOR UPDATE` + update), chybná položka se opakuje každých 5 s bez
backoffu a nikdy se nezahodí (smazaný obchod → P0002 navždy). Návrh: backoff,
zahodit položku při P0002/smazání, pauza mimo backtest a ve skryté záložce,
read-only prepare bez zámku.

**2c. Falešný konflikt `needsReview` (pravděpodobná spoušť dnešní smyčky).**
204 z 205 backtest obchodů v DB `needsReview` nemá; klient z chybějící hodnoty
dělá `false` (`storageService.ts:355,807`) a dialog posílá
`needsReview:false` (`BacktestTradeReviewDialog.tsx:341`). Pokud `expected`
pochází z paměti klienta, SQL CAS vidí `NULL` ≠ `false` → konflikt.
Návrh: `expected` brát ze serverového snapshotu, `needsReview` posílat jen při
změně, odvozená pole (přepočet) neposílat z UI uložení. *K ověření testem.*

**2d. Journal sync z prohlížeče každých 20 s** (`App.tsx:61,1310`) — dělá to
samé, co cron každou minutu, a navíc smyčka po 2 s při `processing`. Návrh:
Realtime na `tradovate_journal_projection_heads` nebo interval ≥ 60 s.

**2e. Worker: `last_used_at` PATCH ~36,7 tis./den, nikdo ho nečte**
(`server/tradovateCopierDevice.ts:122-128`). Návrh: zapisovat jen když je
starší než 10 min. *Bezpečné, mimo safety logiku (revokace se nemění).*

**2f. Worker poll `tv_alert_webhooks` ~21 tis./den** (`copier-relay.ts:276`,
`server/tvAlertNotifications.ts:92`) — při každém prázdném pollu. Návrh: cache
60 s / dotaz jen pokud `last_alert_at` je čerstvé.

**2g. Ověřování JWT síťovým voláním** — `auth.getUser()` na každý API požadavek
(`server/supabaseServer.ts:48`, `tradovateOAuthStore.ts:101`) + nový klient na
každé volání. Návrh: lokální ověření `getClaims()`/JWKS, klient na úrovni modulu.

## 3. Místo v DB (aby se nemuselo platit víc)

Pozor: po `DELETE` se místo vrátí až po `VACUUM FULL` / `pg_repack` (zamyká
tabulku → dělat mimo obchodní hodiny).

| Krok | Uvolní cca | Riziko |
|---|---|---|
| Drop `tradovate_journal_evidence_time_idx` (jen pro jednorázový backfill) | 63 MB | nízké |
| `candle_cache` — žádný zápis v appce, čtou jen skripty; export → drop | 229 MB | nízké (ověřit) |
| `notification_delivery_outbox` — mazat odeslané/expir. po 7 dnech (pg_cron) | jednotky MB, hlavně trvale | nízké |
| `tradecopia_shadow_*` — držet posledních N běhů | ~90 MB | nízké, pokud TradeCopia skončila |
| Evidence v retained módu, `ingest_id <= through`, starší 14 dní (držet poslední řádek na připojení a journalbackfill) | stovky MB | nízké–střední |
| Archiv entity-mode evidence starší než checkpoint do Storage (gzip JSONL) — vč. 1,15 mil. `command` z 16. 9. | **až ~3 GB** | vyžaduje návrh (late-arrival rebuild čte historii entity od 0) |

Oprava mého dřívějšího tipu: `tradovate_journal_evidence_entity_idx` (432 MB)
**nemazat** — používá ho rebuild pozdních událostí (statistiky byly 24. 10.
resetované, proto 0 scanů).

Disk na Macu: lokální JSONL evidence se nikdy nerotuje
(`server/fileJournalEvidenceStore.ts:51`) — rotovat za potvrzeným kurzorem.

## 4. Co by se rozbilo při ~100 uživatelích

- **Cron `journal-import`** zpracuje max. 20 připojení podle `updated_at`
  (`api/cron/journal-import.ts:21-38`) → ostatní by se nikdy nezpracovali;
  běží každou minutu s rozpočtem 270 s a může se překrývat. Návrh: „dirty“
  příznak z append RPC + fronta.
- **Cron `send-alerts`** každou minutu čte všechny profily, subscriptions, runtime
  a alert state; `tradovate_copier_trades` má **globální `.limit(500)`**
  (`api/cron/send-alerts.ts:504-507`) → u více uživatelů by se notifikace
  o obchodech ztrácely (chyba správnosti už teď, jen se neprojevuje).
- **Polling na uživatele se násobí**: UI status kopírky každé 2 s (6 dotazů),
  live P&L 3 s, journal sync 20 s, worker poll 750 ms + heartbeat 2 s +
  background 1 s. Při 100 uživatelích to jsou stovky požadavků za sekundu jen na
  udržování stavu. Cesta: Realtime/Broadcast místo pollingu, delší intervaly
  když je kopírka DISARMED/flat. *Worker smyčky = copier-core, nutné INV review.*
- **Plná čtení na uživatele** (1b, 1c) rostou s počtem obchodů × počtem uživatelů.
- Indexy na `user_id` u hot tabulek jsou v pořádku; problém jsou nefiltrované
  service_role dotazy v cronech.

## 5. Vercel

- Náklady ~40 USD/měs efektivně, převážně provisioned memory: dva crony každou
  minutu (`send-alerts`, `journal-import` s `maxDuration` 300) + worker relay
  (každý poll = invokace). Region (1a) zkrátí i dobu běhu → nižší náklad.
- Statické assety: přidat `Cache-Control: public, max-age=31536000, immutable`
  pro `/assets/*`.
- Mrtvý kód: `services/copierJournalSync.ts`, `services/journalAccountReadModel.ts`
  (+ jediný konzument GET feedu evidence od kurzoru 0).

## Doporučené pořadí

1. **Rychlé a bezpečné** (1 větev, bez copier-core): falešný `needsReview`
   konflikt (2c), backtest outbox backoff/pauza (2b), journal sync 60 s (2d),
   `last_used_at` throttle (2e), tv_alert cache (2f), `send-alerts` limit (bug),
   drop `time_idx`, outbox retention, cache headers.
2. **Region Vercelu** (1a) — změřit před/po na pár endpointech; copier relay
   s INV review.
3. **Místo**: `candle_cache` export+drop, retained evidence retention, pak
   `pg_repack` mimo trh. Archiv staré evidence (3 GB) jako samostatný návrh.
4. **Inkrementální načítání obchodů + Realtime na Broadcast** (1b, 1c, 2a) —
   největší dlouhodobý přínos pro plynulost i škálování, ale větší zásah.
5. **Snapshot linkage tabulka** místo view (1d).
6. **Škálování na více uživatelů**: journal-import fronta, polling → push.
