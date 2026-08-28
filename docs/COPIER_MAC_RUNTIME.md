# AlphaTrade copier na Macu

Tento režim provozuje jediný Tradovate DEMO execution runtime na uživatelově
Macu. `launchd` ho po přihlášení a po pádu znovu spustí, `caffeinate` drží Mac
vzhůru a krátký OAuth lease se obnovuje přes spárované zařízení.

## Bezpečnostní pravidla

- Runtime po každém startu, pádu, restartu nebo ztrátě spojení začíná `DISARMED`.
- ARM je vždy ruční a probíhá z LIVE UI až po reconciliation.
- Nikdy se automaticky neposílá `Flatten`, objednávka ani opakování nejasného
  broker requestu.
- Mac device secret je pouze v macOS Keychainu. Na disku je veřejný klíč,
  privátní klíč a konfigurace s oprávněním `0600`.
- Lokální HTTP agent poslouchá pouze na `127.0.0.1` a přijímá schválený origin.
- Procesový lock nedovolí spustit dva lokální agenty nad stejnou dvojicí účtů.

## Co je potřeba před instalací

1. Produkční web s nasazenou migrací `tradovate_copier_devices` a API endpointy.
2. Aktivní Tradovate DEMO OAuth připojení.
3. Jeden krátký pilot lease stažený z LIVE Connections.
4. Číselné Tradovate ID leadera a followera. Pilot je omezený na jednu dvojici
   a násobek `1`, dokud nebude dokončeno rozšířené DEMO ověření.
5. Nainstalované závislosti (`npm ci`) v tomto checkoutu.

## Instalace

Z kořene `oauth-data-probe`:

```bash
npm run copier:mac -- install \
  --connection-id <UUID_OAUTH_PRIPOJENI> \
  --leader <TRADOVATE_ID_LEADERA> \
  --follower <TRADOVATE_ID_FOLLOWERA> \
  --lease </absolutni/cesta/pilot-lease.json>
```

Instalátor:

- zkopíruje bootstrap lease, privátní pilotní klíč a samostatně zabalený runtime
  do `~/Library/Application Support/AlphaTrade/copier`, aby background proces
  nebyl blokovaný macOS ochranou složky Downloads,
- vytvoří RSA klíče a secret v Keychainu,
- nainstaluje `~/Library/LaunchAgents/com.alphatrade.copier.plist`,
- spustí agenta přes `caffeinate`,
- pokud TradingView neběží, spustí jej s lokálním CDP na `127.0.0.1:9222`;
  už spuštěnou aplikaci bez CDP nikdy automaticky nezabíjí ani nerestartuje,
- nechá runtime `DISARMED`.

V LIVE Connections se pak u připojení objeví ikona klíče. Po explicitním
potvrzení se Mac device uloží k přihlášenému uživateli. Od té chvíle si agent
obnovuje krátké šifrované leases sám; uživatelské heslo ani refresh token na
Mac nekopíruje.

## Kontrola

```bash
npm run copier:mac -- status
```

Logy:

- `.copier-pilot/mac-agent.stdout.log`
- `.copier-pilot/mac-agent.stderr.log`

LIVE UI kontroluje lokální agent na `http://127.0.0.1:3211`. Teprve když je
WebSocket připojený, oba účty jsou flat, bez pracovních příkazů a reconciliation
je čistá, lze ručně zvolit `ARM LIVE`.

### TradingView ENTRY/EXIT snímky

- V TradingView musí být otevřený samostatný layout `AlphaTrade Snapshoty` a
  jeho stabilní `chartId` musí být uložený v
  `~/Library/Application Support/AlphaTrade/copier/chart-snapshot.json`.
- Pracovní layout a `AlphaTrade Snapshoty` používají TradingView synchronizaci symbolu,
  timeframe a globálních kreseb. Worker v `snapshot` layoutu symbol ani
  timeframe nepřepíná. Viewport připravuje předem a periodicky; při skutečném
  ENTRY/EXIT už jen pořídí rychlý čistý ořez grafu bez resetu nebo navigace.
- LIVE zobrazuje stav **TradingView snímky**. `CDP offline` znamená, že je
  potřeba TradingView jednou ukončit a nechat znovu spustit AlphaTrade
  workerem. `Chybějící layout` znamená, že karta `AlphaTrade Snapshoty` není otevřená nebo
  nesedí uložený `chartId`.
- Nedostupný snímek nikdy nezastaví ani nezpomalí brokerovou akci. Současně se
  nikdy jako náhrada nevyfotí jiná pracovní karta.
- Při úspěchu přijde jediná notifikace už s obrázkem. Obrázková cesta má
  deadline 1,5 s; pokud ho nestihne, v 1,8 s přijde jediná textová záloha a
  pozdní obrázkový push už se nezačne odesílat.

## Co se stane při poruše

| Situace | Chování |
| --- | --- |
| Výpadek Wi-Fi / Tradovate WS | Runtime se okamžitě odzbrojí. Po reconnectu zůstane `DISARMED`. |
| Pád Node procesu | `launchd` ho znovu spustí, ale opět `DISARMED`. |
| Restart Macu | Po přihlášení se agent spustí automaticky, opět `DISARMED`. |
| Uspání / zavření víka | `caffeinate` omezuje běžné uspání, zavřené víko bez vhodného clamshell režimu ale není garantovaný serverový provoz. |
| Nejasný broker výsledek | Outbox stav se dohledá; příkaz se neposílá naslepo znovu. |
| Mac je vypnutý | Copier neběží. Objednávky z mobilu se nekopírují. |

## Omezení Mac varianty

Mac musí být zapnutý, přihlášený k uživatelskému účtu, online a nesmí být
tvrdě uspán. Je to plně použitelný první produkční krok pro řízené DEMO testy,
ale neřeší objednávky z mobilu ve chvíli, kdy je Mac offline. Pro skutečný
provoz 24/7 je později vhodný jeden fenced worker na VPS.

## Zaparkované pro VPS fázi

Migrace `20260817140000_copier_worker_lease.sql`, `services/copierWorkerLease.ts`
a fence parametr `startTradovateCopier` jsou připravené pro VPS fázi a Mac
runtime je zatím NEPOUŽÍVÁ — jede na `fileCopierStore` a procesovém locku,
což na jediném stroji stačí. Fencing řeší riziko dvou souběžných instancí
(překryv při deployi, restart hostitele), které vzniká až na VPS.

Důsledek k zapamatování: po nasazení lease migrace vyžaduje
`commit_copier_runtime_state` platný fence. Zápis přes `supabaseCopierStore`
bez drženého lease skončí `COPIER_LEASE_MISSING` — to je záměr (fail-closed),
ne chyba. Plán VPS fáze: `docs/COPIER_VPS_PLAN.md`.
