# TradeCopia sync

V adresáři jsou dva oddělené datové toky:

- `sync.mjs` / `install.sh` — původní import exekucí do deníku.
- `shadow-sync.mjs` / `install-shadow.sh` — izolovaný read-only obraz živého stavu TradeCopie pro ověření datové kvality.

Shadow collector nic nezapisuje do SQLite databáze TradeCopie a jeho tabulky zatím
nečte aplikace ani AI Coach. Do Supabase posílá pouze allowlist tabulek bez OAuth
tokenů, uživatelů, feed credentials a dalších secrets.

## Sbírané tabulky

`accounts`, `cash_balances`, `positions`, `orders`, `fills`,
`account_risk_statuses`, `account_risk_configs`, `order_strategies`, `groups`,
`group_leader_accounts`, `group_follower_accounts` a `prop_firm_accounts`.

Aktuální stav je v `tradecopia_shadow_current`, audit změn v
`tradecopia_shadow_changes` a jednotlivé běhy v `tradecopia_shadow_sync_runs`.
View `tradecopia_shadow_latest` zpřístupňuje jen aktuální, nesmazané řádky.
Všechny objekty mají RLS a uživatel vidí pouze vlastní data.

Příkaz `--verify` neporovnává jen počty: pro každou tabulku počítá deterministický
SHA-256 otisk všech dvojic `source_key + payload_hash` lokálně i na serveru.
Odhalí proto i změněnou hodnotu při nezměněném počtu řádků.

## Instalace a kontrola

```bash
bash scripts/tradecopia-sync/install-shadow.sh
node scripts/tradecopia-sync/shadow-sync.mjs --verify
node scripts/tradecopia-sync/shadow-sync.mjs --dry-run
```

Instalátor zkopíruje runtime do `~/.alphatrade/bin`, takže služba není závislá na
aktuálně checkoutnuté git branchi. Při každé změně collectoru je potřeba instalátor
spustit znovu.

Služba běží každých 5 sekund a každou minutu odešle heartbeat i bez změn. Stav:

```bash
launchctl print "gui/$(id -u)/com.alphatrade.tradecopia-shadow-sync"
tail -f ~/.alphatrade/tradecopia-shadow-launchd.log
```

Změnu schématu zdrojové DB collector zastaví. Po ruční kontrole lze nový otisk
jednorázově přijmout pomocí `--accept-schema`.

## Vypnutí a návrat

Collector lze bezpečně vypnout bez zásahu do původního importu:

```bash
launchctl bootout "gui/$(id -u)/com.alphatrade.tradecopia-shadow-sync"
```

Tím se nemažou žádná data. Shadow tabulky jsou aditivní a aplikace na nich není
závislá. Jejich případné odstranění musí proběhnout samostatnou verzovanou Supabase
migrací až po novém vzdáleném backupu a advisory kontrole.
