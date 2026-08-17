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
