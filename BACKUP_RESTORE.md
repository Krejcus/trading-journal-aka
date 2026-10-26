# AlphaTrade — záloha a obnova

Tento dokument označuje bezpečný návratový bod aplikace AlphaTrade a rozšíření AlphaBridge před rozsáhlejšími úpravami.

## Bezpečný bod

- Vytvořeno: 19. 7. 2026 v 07:50 (Europe/Prague)
- Git větev: `main`
- Git commit: `38b1f0532616c765b934d96c0119c0baf43b5f07`
- Kompletní archiv: `/Users/filipkrejca/Documents/AlphaTrade-backups/alphatrade-complete-2026-07-19-0750.tar.gz`
- Git bundle: `/Users/filipkrejca/Documents/AlphaTrade-backups/alphatrade-git-2026-07-19-0750.bundle`

Archiv obsahuje zdrojové kódy aplikace, zdrojové kódy extensionu, sestavený `extension/dist`, konfiguraci, lock soubory a lokální Git repozitář. Neobsahuje `node_modules` ani dočasné build cache; ty jsou obnovitelné instalací závislostí.

## Ověřené kontrolní součty SHA-256

```text
30516e1ff3b577a8242f15b6ba4a6af0ac70d8c5109c215b8a966622b277aaad  alphatrade-complete-2026-07-19-0750.tar.gz
a1c60538912b2e69ed561f8764988f05079ab86aa4897602b8dc5ebe6b7b87e7  alphatrade-git-2026-07-19-0750.bundle
```

Git bundle byl při vytvoření ověřen příkazem `git bundle verify` a obsahuje kompletní historii všech tehdejších větví a referencí.

## Pravidlo pro budoucí úpravy

Před změnou databázového schématu, Supabase migrací/RLS/Storage, Vercel environment variables nebo jiné produkční konfigurace musí Codex uživatele výslovně upozornit. Současná souborová záloha tyto vzdálené systémy neobsahuje; před takovou změnou je potřeba vytvořit jejich samostatnou zálohu nebo export.

Při požadavku typu „vrať vše na backup“ se nejdříve musí potvrdit přesný cíl obnovy a zkontrolovat současné neuložené změny. Obnova přepíše novější práci, proto se nesmí spustit bez explicitního souhlasu uživatele.

## Postup obnovy

1. Zastavit vývojové servery a zkontrolovat současný stav pomocí `git status`.
2. Pokud existuje novější práce, nejdříve ji samostatně zazálohovat.
3. Ověřit SHA-256 archivu a Git bundle proti hodnotám výše.
4. Obnovit celý adresář `trading-journal-aka` z kompletního archivu, případně obnovit Git historii z bundle.
5. V kořeni aplikace i v `extension/` nainstalovat závislosti podle lock souborů.
6. Spustit testy a build hlavní aplikace i extensionu.
7. Ověřit localhost a načíst obnovený `extension/dist` v prohlížeči.

Tento dokument je provozní poznámka. Nemění runtime aplikace ani extensionu.

## Migrační bod pro nový Mac — 6. 8. 2026

Před smazáním původního Macu byl vytvořen nový lokální migrační bod z větve
`codex/tradecopia-shadow-sync` na commitu
`f060676bd4c8d819e56e9f5e583d08f3a5984936`.

Migrační soubory jsou v adresáři:

```text
/Users/filipkrejca/Documents/AlphaTrade-migration-2026-08-06
```

Obsah:

- `alphatrade-all-refs-2026-08-06.bundle` — kompletní Git historie a lokální větve.
- `alphatrade-source-and-extension-2026-08-06.tar.gz` — aktuální zdrojový strom bez secrets, závislostí a build cache.
- `alphabridge-dist-2026-08-06.tar.gz` — ověřený sestavený `extension/dist`.
- `PRIVATE-local-config-2026-08-06.tar.gz` — `.env.local`, `.env.vercel.txt`, `.mcp.json` a lokální Codex konfigurace.
- `PRIVATE-codex-continuity-2026-08-06.tar.gz` — lokální Codex tasky, paměti, skills, pravidla a stav aplikace bez `auth.json` a browser cookies.

Soukromé archivy mají oprávnění pouze pro vlastníka. Přenášejí se přímo mezi
Macy (například AirDrop nebo šifrovaný disk), nikdy přes GitHub ani nešifrované
sdílené úložiště. Přihlašovací údaje a browser relace se na novém Macu obnoví
novým přihlášením.

Kontrolní součty všech migračních souborů jsou uložené vedle archivů v
`SHA256SUMS.txt`.

Před smazáním starého Macu musí na novém projít:

1. Ověření uvedených SHA-256 a `git bundle verify`.
2. Obnova/klon repozitáře a checkout commitu `f060676`.
3. Bezpečné obnovení lokální konfigurace bez commitu secrets.
4. `npm ci`, TypeScript, testy a produkční build hlavní aplikace.
5. `npm ci` a build v `extension/`, následně načtení `extension/dist` v Chrome.
6. Přihlášení do Codexu, GitHubu, Supabase, Vercelu, TradingView a TradeCopie.
7. Ověření localhostu, MCP AlphaTrade, živého sběru dat a funkce AlphaBridge.

Při vytvoření tohoto bodu prošlo 54 testovacích souborů / 319 testů, TypeScript,
produkční build aplikace a produkční build AlphaBridge.

## Záloha Supabase (od 25. 10. 2026)

Souborové zálohy výše obsahují jen kód. Tahle část popisuje zálohu živé databáze
a souborů ze Supabase Storage, zkušební obnovu a co dělat, když je potřeba
něco vrátit. Obnova vždy přepisuje novější data — cíl obnovy se nejdřív potvrdí
s Filipem.

### Co je zálohované a kde

| Vrstva | Co obsahuje | Kde a jak dlouho | Jak obnovit |
|---|---|---|---|
| Denní zálohy Supabase (plán Pro) | fyzická kopie celé DB | u Supabase, 7 dní; PITR vypnutý → ztráta až ~24 h | Dashboard → Database → Backups; jen celá DB, přepíše vše novější; nejde stáhnout |
| Naše logická záloha | celá DB (`pg_dump -Fc`), role, schéma, soubory ze Storage, git bundle (jen ruční běh) | `~/AlphaTrade-backups/supabase/<UTC čas>/` (stará cesta `~/Documents/AlphaTrade-backups/supabase` je odkaz sem); každou noc ve 3:30, drží poslední 3 + poslední zkušebně obnovenou; soubory Storage ve sdíleném `storage-mirror/` | po tabulkách i celá, viz scénáře níže |
| Kód | všechny commitnuté větve | GitHub + `alphatrade-git.bundle` v každé záloze | `git clone alphatrade-git.bundle` |

Ověřeno 25. 10. 2026: Supabase má 7 denních záloh (poslední 24. 10. 22:15 UTC),
`pitr_enabled: false`. DB má 5,3 GB (z toho 4,1 GB `tradovate_journal_evidence`),
Storage 1 603 souborů / 262 MB v 5 bucketech.

**V žádné záloze není** (obnovuje se ručně z vlastních zdrojů):

- Vercel environment proměnné (lokální kopie `.env.vercel.txt`, mimo git),
  secrets Edge funkcí, APNS/VAPID klíče;
- nastavení Supabase Auth (poskytovatelé, redirect URL, e-mailové šablony);
- tajemství ve Vaultu — jsou šifrovaná klíčem, který drží Supabase (dnes 0 řádků);
- durable stav Mac workeru kopírky (`fileCopierStore` na disku Macu) — záměrně,
  viz „Kopírka a obnova databáze“;
- necommitnutá práce v repu.

Zálohy leží jen na tomto Macu. Při ztrátě Macu data dál drží Supabase (i jeho
denní zálohy); pro případ ztráty obojího občas zkopírovat poslední zálohu na
šifrovaný externí disk.

### Jednorázové nastavení

1. Nainstalovat [Postgres.app](https://postgresapp.com) do Aplikací. Server
   spouštět nemusíš — skripty si berou jen jeho programy (`pg_dump`,
   `pg_restore`, `psql`, `initdb`), nejnovější verzi ≥ 17 (verze serveru).
   Jiné umístění: proměnná `PG_BIN`.
2. Uložit heslo k databázi do Keychainu (příkaz se na heslo zeptá, nezůstane
   v historii shellu):
   ```bash
   security add-generic-password -U -s alphatrade-supabase-db -a postgres -w
   ```
   Heslo je v Supabase Dashboard → Project Settings → Database. Když ho neznáš,
   použij „Reset database password“: appka, Vercel funkce ani worker přímé
   heslo nepoužívají (25. 10. ověřeno — žádné `DATABASE_URL` v kódu ani v env;
   Supabase CLI si vytváří vlastní dočasnou roli), takže reset nic nerozbije.
3. Ověřit: `./scripts/backup-supabase.sh --check` (nástroje, heslo, spojení, místo).

### Spuštění zálohy

```bash
./scripts/backup-supabase.sh
```

- Spouštět mimo obchodní hodiny (víkend, večer). `pg_dump` přečte celou DB
  přes session pooler (`aws-1-eu-north-1.pooler.supabase.com:5432`, SSL) a na
  pár minut ji zatíží.
- V obchodní době (Po–Pá 8:00–22:30 pražského času) skript odmítne začít,
  pokud nedostane `--force`: pg_dump zatíží DB, přes kterou jede relay
  kopírky. Během zálohy nespouštět migrace ani `VACUUM FULL`/`pg_repack` —
  DDL by čekal na zámek pg_dump a zablokoval tabulku i pro appku.
- Volby: `--no-storage`, `--no-git`, `--keep N` (výchozí 5), `--check`, `--force`.
  Proměnné: `BACKUP_ROOT`, `BACKUP_MIN_FREE_GB` (výchozí 10), `PGSSLROOTCERT`
  (kořenový certifikát Supabase → `verify-full` místo `require`).
- Skript odmítne začít, když by po záloze zbylo méně než 10 GB volna — na
  stejný disk zapisuje durable stav worker kopírky.
- Rozpracovaná záloha se jmenuje `<čas>.partial` a přejmenuje se až po všech
  kontrolách. Při selhání se z ní hned smaže `db.dump` a bundle (logy zůstanou
  pro diagnostiku); zbytky smaže až další běh. Odkaz `latest` ukazuje na
  poslední kompletní zálohu. Rotace nikdy nesmaže nejnovější zálohu ani
  poslední zálohu, jejíž zkušební obnova prošla.
- Návratový kód: 0 = vše v pořádku; 1 = záloha selhala; 2 = databáze
  zálohovaná, ale soubory ze Storage ne celé.

### Noční záloha (launchd, od 26. 10. 2026)

Úloha `com.alphatrade.supabase-backup` spouští zálohu každý den ve 3:30
místního času (Mac je v noci vzhůru kvůli workeru kopírky, `caffeinate`).

```bash
./scripts/backup/install-nightly.sh              # instalace, nebo aktualizace po změně skriptů zálohy
./scripts/backup/install-nightly.sh --run-now    # navíc hned jeden běh přes launchd (mimo obchodní dobu)
./scripts/backup/install-nightly.sh --uninstall  # odebrat (zálohy zůstanou)
```

- **Proč kopie skriptů**: launchd úloha nesmí číst `~/Documents` (macOS TCC,
  „Operation not permitted“, ověřeno 26. 10.). Instalace proto kopíruje
  `backup-supabase.sh`, `scripts/backup/*` a z `supabase/.temp` project ref
  a host poolera (bez hesla) do
  `~/Library/Application Support/AlphaTrade/supabase-backup/`. Heslo zůstává
  v Keychainu. Proto jsou i zálohy mimo `~/Documents`. **Po každé změně
  skriptů zálohy spusť instalaci znovu**, jinak noc poběží se starou kopií
  (`installed-from.txt` říká, ze kterého commitu je).
- Noční běh = `backup-supabase.sh --no-git --keep 3`: bez git bundle (repo je
  v `~/Documents` a na GitHubu), drží poslední 3 noční zálohy a navíc
  poslední zálohu se zkušební obnovou PASS. Ruční běh dál drží 5 a dělá bundle.
- Když se Mac probudí až v obchodní době, běh se přeskočí; upozornění přijde,
  jen když je poslední kompletní záloha starší než 2 dny.
- Selhání (kód 1) nebo neúplné soubory ze Storage (kód 2) = upozornění
  „AlphaTrade záloha“ v Centru oznámení. Nejčastější důvod je málo místa:
  záloha nezačne, když by zbylo méně než 10 GB (26. 10. bylo volno 11,9 GB,
  takže na hraně).
- Kde se dívat: `~/AlphaTrade-backups/supabase/nightly-runs.log` (řádek na
  běh: čas UTC, OK / PARTIAL / FAIL / SKIP, záloha nebo důvod),
  `nightly.log` (celý výpis, posledních 5000 řádků) a
  `launchctl print gui/$(id -u)/com.alphatrade.supabase-backup` (poslední
  návratový kód).
- Zkušební obnova se sama nespouští — jednou měsíčně ručně
  `./scripts/restore-test-supabase.sh` (bere poslední zálohu).

Obsah jedné zálohy:

| Soubor | Co to je |
|---|---|
| `db.dump` | `pg_dump --format=custom` celé databáze (všechna schémata, schéma i data) |
| `roles.sql` | role clusteru bez hesel (`pg_dumpall --roles-only --no-role-passwords`) |
| `schema.sql` | čitelné schéma vytažené z `db.dump` (diff, ruční obnova) |
| `db.toc.txt` | seznam objektů v archivu |
| `table-rowcounts.tsv` | přesné počty řádků v archivu — při jejich výpočtu se celý archiv dekomprimuje, takže je to zároveň kontrola čitelnosti |
| `tables.tsv` | velikosti a odhady řádků tabulek v produkci v okamžiku zálohy |
| `storage-objects.json`, `storage-manifest.tsv` | seznam objektů Storage a SHA-256 jejich souborů v zrcadle |
| `alphatrade-git.bundle` | všechny commitnuté větve repa |
| `manifest.txt`, `SHA256SUMS`, `backup.log`, `pg_dump.log` | metadata, kontrolní součty, průběh |

Kontroly během zálohy: verze `pg_dump` ≥ verze serveru; archiv nesmí být bez
dat a každá běžná tabulka (ne součást rozšíření) v něm musí mít blok dat;
seznam souborů Storage musí odpovídat `storage.objects` v archivu; soubory ze
Storage se stahují jen chybějící nebo změněné (velikost, MD5 z eTagu) a po
stažení se ověří; ze zrcadla se nikdy nemaže, takže smazaný soubor ve Storage
zůstane zálohovaný (přepsaný soubor se stejným jménem ale zůstane jen
v nejnovější verzi). Soubor přepsaný mezi výpisem a stažením (worker průběžně
přepisuje `copier-snapshots/…/tv-live/*.json`) se uloží v novější verzi,
pokud obsah souhlasí s ETagem odpovědi; v logu je „změněno během zálohy“
a není to chyba.

**Citlivost**: záloha obsahuje e-maily a hashe hesel z `auth.users`, Tradovate
tokeny, poznámky a výplatní doklady. Adresáře mají práva jen pro vlastníka
(700/600). Nikam je nenahrávat a nesdílet. Od 26. 10. leží mimo `~/Documents`,
takže je nezachytí ani případně zapnutý iCloud „Plocha a Dokumenty“.

### Zkušební obnova

```bash
./scripts/restore-test-supabase.sh            # poslední záloha
./scripts/restore-test-supabase.sh <adresář>  # konkrétní záloha
```

Co skript dělá (na produkci ani na Supabase nesahá):

1. ověří SHA-256 všech souborů zálohy;
2. založí dočasný PostgreSQL ve `~/AlphaTrade-backups/supabase/.restore-test/`
   (jen unix socket v `/tmp`, žádný TCP port, vlastní superuser `atrestore`);
3. nahraje `roles.sql` (členství udělená `GRANTED BY supabase_admin` udělí
   lokální superuser — `supabase_admin` tu nemá ADMIN OPTION);
4. obnoví `db.dump` přes `pg_restore -j 4` bez rozšíření, která lokálně nejsou
   (typicky `supabase_vault`), a bez schématu `vault`;
5. porovná počet řádků každé tabulky s archivem (musí sedět přesně) a počet
   RLS politik s archivem;
6. zapíše výsledek do `<záloha>/restore-test-<čas>.txt`, celý výpis
   `pg_restore` a `roles.sql` do `restore-test-<čas>.log` a řádek do
   `restore-tests.log`; server zastaví a smaže.

PASS = žádná chyba `pg_restore`, všechny tabulky souhlasí a sedí počet RLS
politik. První běh může narazit na neškodné chyby obnovy Supabase dumpu do
čistého PostgreSQL (vlastníci, event triggery) — ty se po rozboru logu buď
odstraní filtrem, nebo vědomě povolí; přísnost zůstává záměrná. Bez `--full` se
neobnovují data `tradovate_journal_evidence` (~4 GB) — jejich počet řádků
ověřila už záloha přečtením archivu. `--full` obnoví vše (vyžaduje ~8 GB
volna + 10 GB rezervu, jinak `RESTORE_WORKDIR` na externí disk). `--keep`
nechá obnovenou DB běžet a vypíše, jak se připojit a jak uklidit.

Kdy: po první záloze, pak jednou měsíčně a po každé velké změně schématu.
Při FAIL: přečíst sekci „Chyby pg_restore“ v reportu. Chybějící rozšíření
(např. `vector` pro `ai_embeddings`) = doinstalovat do Postgres.app; chyba
v datech nebo počtech = záloha není použitelná, řešit hned.

### Scénáře obnovy

**A. Zpět jedna tabulka nebo pár řádků** (omylem smazané obchody, rozbitá migrace):

1. `./scripts/restore-test-supabase.sh --keep <záloha>` → lokální kopie DB.
2. Najít řádky a vyexportovat je, např.
   `\copy (select * from public.trades where id in (…)) to 'rows.csv' csv header`.
   Jedna tabulka jde vytáhnout i přímo z archivu bez serveru:
   `pg_restore --data-only --table=trades --file=trades.sql db.dump`.
3. V produkci nejdřív zkopírovat aktuální stav tabulky do `migration_backups`
   (viz „Před každou migrací“), pak vrátit jen chybějící/rozbité řádky
   (`insert … on conflict do nothing`, nebo cílený `update`). Celou tabulku
   nikdy nepřepisovat naslepo; u journal tabulek počítat s triggery projekce.
4. Přechodné kopírkové tabulky (`tradovate_copier_commands`,
   `tradovate_copier_device_runtime`, `copier_alert_state`,
   `notification_delivery_outbox`, `*_rate_limits`) se nevracejí nikdy.
   Zařízení, OAuth připojení a push registrace jen
   `insert … on conflict do nothing` — existující řádek nikdy nepřepisovat.
   Ostatní kopírkové tabulky podle „Kopírka a obnova databáze“.

**B. Poškozená celá DB, projekt existuje**: přednostně denní záloha Supabase
(Dashboard → Database → Backups → Restore). Obnoví i `auth` a `storage`
v konzistentním stavu; projekt je během obnovy nedostupný a ztratí se vše od
času zálohy. Data z té doby mohou být v novější logické záloze (porovnat
`created_utc` v `manifest.txt`) — doplnit postupem A. Před obnovou projít
„Kopírka a obnova databáze“ kroky 0–2, po obnově kroky 3–8 v tomto pořadí,
dřív než se cokoli připojí (projekt je online hned po obnově).
Hned po obnově taky zvednout epochu delta syncu, ať si všechny appky
přečtou obchody znovu celé (jejich kurzor může ukazovat za obnovený stav):
`update public.sync_meta set epoch = epoch + 1, updated_at = now() where id = 1;`

**C. Projekt ztracený nebo smazaný** — nový projekt v `eu-north-1`
s Postgres ≥ `server_major` z `manifest.txt`. Postup vychází z dokumentace
Supabase „Backup and Restore using the CLI“; při první skutečné obnově ho
ověřit a doplnit sem. Vždy s „Kopírka a obnova databáze“.

1. Role: `roles.sql` obsahuje jen role, které Supabase zakládá sám (25. 10.
   žádná vlastní role) — nic nevytvářet, jen zkontrolovat.
2. Vlastní schémata se strukturou i daty:
   `pg_restore --no-owner -d "$NEW_DB_URL" -n public -n alphatrade_private -n journal_private -n private -n migration_backups db.dump`
   (granty pro `anon`/`authenticated`/`service_role` zůstanou).
3. Uživatelé: `pg_restore --data-only -n auth -d "$NEW_DB_URL" db.dump`
   s `SET session_replication_role = replica` (přes `psql` z `pg_restore -f -`;
   psql musí být stejně nový jako pg_dump kvůli `\restrict`).
4. Ještě před přepnutím čehokoli na nový projekt v nové DB revokovat všechna
   zařízení a vyčistit tokeny odpojených připojení — obnovené hashe tajemství
   a tokeny by jinak fungovaly hned, i pro zařízení revokovaná po záloze:
   ```sql
   update public.tradovate_copier_devices set revoked_at = now() where revoked_at is null;
   update public.mac_companion_devices set revoked_at = now() where revoked_at is null;
   ```
   (a u `tradovate_oauth_connections` se stavem odpojeno vymazat tokeny).
   Mac worker a companion se pak spárují znovu.
5. Storage: z archivu jen řádky `storage.buckets`, soubory nahrát ze
   `storage-mirror/<bucket>` přes `npx supabase storage cp -r … ss:///<bucket> --linked`
   (řádky `storage.objects` založí upload).
6. Epocha delta syncu: `update public.sync_meta set epoch = epoch + 1 where id = 1;`
   (appky pak obchody přečtou celé, starý kurzor neplatí).
7. Mimo DB: `supabase link`, Auth nastavení, deploy Edge funkcí (`mcp-server`
   s `--no-verify-jwt`), function secrets, Vercel env (`VITE_SUPABASE_URL`,
   klíče), nový build iOS appky a extensionu.
8. Všichni se přihlásí znovu (nový JWT secret); Tradovate připojit znovu.

### Kopírka a obnova databáze

Platí pro B, C a pro A, pokud se vrací kopírková tabulka. Prošlo oponenturou
`copier-design-critic` 25. 10. 2026 (nálezy ověřené v kódu, viz PROJECT_LOG).
Dotčená pravidla (`docs/COPIER_INVARIANTS.md`): INV-DEFAULT-01,
INV-DEFAULT-03, INV-RELAY-01, INV-RELAY-02, INV-RELAY-03, INV-BRAKE-03,
INV-BRAKE-04, INV-UI-01, INV-UI-02, INV-WORKER-01, INV-WORKER-02,
INV-WORKER-03, INV-FRESH-03, INV-WATCH-01, INV-ELIG-02, INV-RISK-01,
INV-RISK-02, INV-TRAD-06.

Durable stav Mac workeru (outbox, incidenty, checkpoint relaye) je na disku
Macu, ne v DB — obnova ho nepřepisuje a nikdy se z žádné zálohy nevrací
(INV-WORKER-01, INV-DEFAULT-03). Kopírkové tabulky v DB podle toho, co
s nimi obnova smí:

| Třída | Tabulky | Pravidlo |
|---|---|---|
| přechodné | `tradovate_copier_commands`, `tradovate_copier_device_runtime`, `copier_alert_state`, `notification_delivery_outbox` | nevracet; po celé obnově vyčistit (kroky 5–6) |
| identita a tajemství | `tradovate_copier_devices`, `mac_companion_devices`, `tradovate_oauth_connections`, `push_subscriptions`, `native_push_subscriptions`, `native_widget_devices`, `native_live_activity_*` | platí aktuální produkční hodnota (krok 0 export, kroky 3–4) |
| konfigurace s vlivem na risk | `copy_groups`, `tradovate_account_profiles` | porovnat s exportem před ON (krok 7) |
| historie | `copier_account_snapshots`, `copier_trade_snapshots`, `tradovate_copier_trades` | obnova bezpečná |
| budoucí DB store workeru | `copier_runtime_state`, `copier_worker_lease` | 25. 10. v produkci neexistují; kdyby vznikly, pod běžícím workerem se nikdy neobnovují (INV-WORKER-02) |

0. **Před obnovou** (jde-li produkční DB ještě číst): vyexportovat třídu
   „identita“, „konfigurace“ a `copier_alert_state` do adresáře zálohy,
   např. `\copy (select * from public.copy_groups) to 'copy_groups-pre-restore.csv' csv header`.
   Zapsat čas zálohy T0 (čas denní zálohy Supabase, nebo `created_utc`
   z `manifest.txt`). Zálohu mladší 15 minut neobnovovat (viz krok 5).
1. **Brána těsně před krokem 2**: stav workeru
   `curl -s -H "Origin: http://localhost:3000" http://127.0.0.1:3211/v1/status`
   jako v `scripts/copier/mac-reinstall-safe.sh` (started, DISARMED, bez kill
   switche, connected, reconciled, flat, bez divergence, working orders,
   stuck outboxu/operací a bez `lastError`), mimo obchodní session. Relay
   fronta musí být prázdná — tenhle dotaz musí vrátit 0 řádků:
   ```sql
   select id, command_type, status, created_at from public.tradovate_copier_commands
    where status = 'pending' or (status = 'claimed' and claimed_at > now() - interval '15 minutes');
   ```
   Mezi kontrolou a krokem 2 nic neposílat z telefonu ani z webu.
2. **Zastavit worker**: `launchctl bootout gui/$(id -u)/com.alphatrade.copier`.
   Ověřit, že `launchctl print gui/$(id -u)/com.alphatrade.copier` službu
   nenajde a `pgrep -fl copier-agent.mjs` nic nevrátí. Pak checkpointy relaye
   (název je `<klíč>.relay-delivery.json`, nebo `<klíč>.relay-<deviceId>.json`,
   když relay drží jiné zařízení než primární — viz
   `scripts/copier/pilot.ts:782-790`; 25. 10. byl aktivní ten druhý; worker
   svůj přepisuje při každém pollu, takže má nejnovější čas změny):
   ```bash
   ls -lt ~/Library/Application\ Support/AlphaTrade/copier/.copier-pilot/*.relay*.json
   head -c 300 ~/Library/Application\ Support/AlphaTrade/copier/.copier-pilot/*.relay*.json
   ```
   Každý musí být `null` nebo mít `"phase":"polling"`. Pokud některý má
   `executing` nebo `completed`, **NEOBNOVOVAT**: worker spustit (krok 8),
   počkat na `RELAY ACK` v logu a zopakovat kroky 1–2. Proč: checkpoint
   s `delivery_id`, které obnovená DB nezná, relay zablokuje —
   `claim_tradovate_copier_command_v2` přiřadí další příkaz k neznámé
   delivery a worker ho donekonečna odmítá jako `relay-delivery-command-mismatch`.
   Prvním takovým příkazem by byl třeba DISARM z telefonu a zůstal by navždy
   `claimed` (INV-BRAKE-03, INV-UI-02).
3. **Hned po obnově, jako první: zařízení.** Revokace z exportu znovu
   použít. Zařízení s jiným `secret_hash`, `public_key` nebo `scope` než
   v exportu vrátit na exportované hodnoty — jinak se Mac spárovaný po T0
   neautorizuje a nedoručí brzdu, a naopak vzkříšené zařízení může dostávat
   brzdy (směrují se na nejčerstvější heartbeat). Totéž pro
   `mac_companion_devices`. Bez exportu: revokovat vše kromě aktuálního Macu;
   když se pak Mac neautorizuje, spárovat ho znovu (INV-WORKER-03).
4. **OAuth připojení** porovnat s exportem (`connection_status`,
   `disconnected_at`, `updated_at`). Připojení odpojená po T0 znovu odpojit,
   připojení obnovená po T0 připojit znovu (starý refresh token skončí
   `tradovate-reauthorization-required`). Chybějící trasu leadera neobcházet
   (INV-TRAD-06).
5. **Relay fronta** — ukončit čekající příkazy z obnovené DB:
   ```sql
   update public.tradovate_copier_commands
      set status = 'expired', completed_at = now(), error = 'restored-from-backup'
    where status = 'pending' and created_at <= '<T0>'
   returning id, command_type, created_at;
   ```
   Worker sám odmítne ne-brzdový příkaz starší než svůj start, ale obnovené
   brzdy (DISARM, kill switch, zámek dne v téže session) by v jejich TTL
   provedl — a kill switch ani zámek dne se ručně zrušit nedají
   (INV-BRAKE-04). Řádky `claimed` neměnit: `expired` by o příkazu se
   ztraceným výsledkem tvrdilo „neprovedeno“ (INV-RELAY-02); skutečný
   výsledek je v `.copier-pilot/<key>.audit.jsonl`. Proto i limit 15 minut
   z kroku 0: `claimed` Flatten mladší 5 minut by k sobě přichytil nový
   Flatten téhož cíle.
6. **Notifikace**:
   ```sql
   update public.notification_delivery_outbox
      set status = 'expired', last_error = 'restored-from-backup', updated_at = now()
    where status in ('pending', 'retry', 'sending') and created_at <= '<T0>';
   ```
   (jinak by se znovu odeslaly staré pushe — outbox má TTL 60 minut).
   `copier_alert_state` vrátit z exportu; bez exportu
   `delete from public.copier_alert_state where incident_key not like 'state:%';`
   — obnovený `active = true` by umlčel push o právě trvajícím incidentu
   (dedupe jen podle klíče, INV-WATCH-01). Otevřít appku na iPhonu (obnoví
   push token) a ověřit doručení. Push „WORKER OFFLINE“ během odstávky je
   očekávaný.
7. **Konfigurace**: `copy_groups` a `tradovate_account_profiles` porovnat
   s exportem (leader, followeři, násobky, `safety` — denní limity,
   maxContracts, okna, cooldown, `armExpiryFlatten` —, prop limity, stav
   účtů). Skupiny smazané po T0 smazat znovu. ON a aktivace posílají workeru
   konfiguraci z UI — u jiné než aktivní skupiny je to obnovená verze
   z cloudu — a pravidlo „jen zpřísnit“ platí jen uvnitř session
   (INV-RISK-01, INV-RISK-02, INV-ELIG-02).
8. **Spustit worker**:
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.alphatrade.copier.plist`.
   Ověřit `npm run copier:mac -- status` (DISARMED, `lastError` stejný jako
   před obnovou, zařízení spárované). V
   `~/Library/Application Support/AlphaTrade/copier/mac-agent.stderr.log`
   nesmí být `relay-delivery-command-missing`, `relay-delivery-command-mismatch`,
   `relay-delivery-checkpoint-invalid` ani `invalid-copier-device-auth` —
   při kterékoli worker zastavit a nic nezapínat. Worker startuje DISARMED
   a potřebuje novou autoritativní kontrolu (INV-DEFAULT-01); stav kopírky
   z obnovené DB je jen historický údaj a nic neautorizuje (INV-FRESH-03,
   INV-UI-01). ARM jen ručně, po čisté kontrole a po kroku 7.

### Před každou migrací

- Tabulky, kterým migrace mění data (`UPDATE`, `DELETE`, změna typu sloupce,
  `DROP`), nejdřív zkopírovat — konvence už existuje
  (`migration_backups.trades_pre_day_journal_20261013` …):
  ```sql
  create table migration_backups.<tabulka>_pre_<popis>_<YYYYMMDD> as table public.<tabulka>;
  select (select count(*) from migration_backups.<tabulka>_pre_<popis>_<YYYYMMDD>)
       = (select count(*) from public.<tabulka>);
  ```
  Schéma `migration_backups` nemá `USAGE` pro `anon` ani `authenticated`,
  kopie tedy nejsou vidět přes API.
- Velké tabulky (`tradovate_journal_evidence` 4,1 GB, `…_input_retained`,
  `…_input_entities`) do DB nekopírovat (místo je 5,3 z 8 GB) — místo toho
  pustit `./scripts/backup-supabase.sh` těsně před migrací.
- Kopie starší než měsíc po ověření smazat; rozhoduje Filip.

### Záznam ověření

| Datum | Co | Výsledek |
|---|---|---|
| 2026-10-25 | denní zálohy Supabase (`supabase backups list`) | 7 dní, poslední 24. 10. 22:15 UTC, PITR vypnutý |
| 2026-10-25 | zrcadlo Storage (`scripts/backup/storage-sync.mjs`) | 1 603 souborů / 262 MB, MD5 sedí u všech; druhý běh 0 stažení za 3 s |
| 2026-10-25 | první plná záloha `20261025T180530Z` (Postgres.app 18.6) | 214 s, dump 332 MB, celkem 395 MB; 134 tabulek / 4 486 575 řádků v archivu; Storage beze změny |
| 2026-10-25 | zkušební obnova téže zálohy | **PASS**: 0 chyb `pg_restore`, 0 chyb `roles.sql`, 132 tabulek / 1 275 154 řádků přesně, `tradovate_journal_evidence` 3 211 421 řádků jen z archivu, RLS 147/147, `auth.users` 5; obnova 5 s |
