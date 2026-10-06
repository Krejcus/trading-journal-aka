# Příprava ON/OFF kopírky — 4. října 2026

Nasazeno 4. 10. 2026 na web i Mac execution worker po výslovném souhlasu
uživatele. Commit `bd02de3963c65949487dd53f9721b763d34c3316`.
Nainstalovaná nativní iPhone aplikace tímto webovým nasazením aktualizovaná není.

## Nasazení

- Čistá release kopie: `npm ci --offline --no-audit --no-fund`, TypeScript,
  build a 4 869 testů / 523 souborů PASS; 1 soubor skipped, 1 test todo.
- Preview `dpl_GVVv3RCpMCQ2Qb9YGH3sQBEFHk35` READY. Přístupový odkaz
  k chráněnému preview automatická kontrola odmítla; ochrana zůstala zapnutá.
  Vykreslení ověřeno v místním LIVE a následně přímo na produkci.
- Produkce `dpl_4LH8Asv4xuWFCqdDXDFQ7tuyyCbp` READY, alias
  `https://alphatrade-mentor-15.vercel.app`. Publikovaný LIVE bundle obsahuje
  nové zrušení ON a `manualRecoveryRequired`; přihlášené LIVE vykreslené,
  žádné console errors. Cílené runtime logy po nasazení obsahují úspěšné
  odpovědi relay 200, žádné error události v přečteném vzorku.
- Worker instalován z čistého stejného commitu, `dirty=false`, capability
  `arm-preparation-v1`. SHA-256 bundle:
  `7b724218739e52f76c13569c5bc6da070a824bfc6106e68434de9062ae528c69`.
  Stav po instalaci: connected, DISARMED, groupFlat, žádné working orders,
  divergence, stuck outbox nebo lastError; automatická příprava `ready`.
  Uložená skupina je přesně shodná s předinstalačním stavem.
- Návratová záloha původního bundle, instalačního manifestu, plist,
  routování a durable stavu: `.copier-pilot/release-backups/20261004-arm-preparation/`
  (ignorováno Gitem, soukromá oprávnění). Původní worker commit
  `acdbafce2768eb82265bd17ee3f6bfbbcefdccfc`, web `6f9dd4d9`.
- Bez ARM, Flatten nebo testovacího obchodu. Skutečná latence kliknutí ON
  zůstává nezměřená; potvrzena je automatická read-only připravenost.

## Chování

- Execution agent zapne předběžné ověřování v controlleru. Samostatní runtime
  klienti bez agenta si zachovají původní frekvenci risk dotazů.
- Po startu a běžném reconnectu se použije existující úzký read-only preflight.
  Za DISARMED se přes heartbeat obnovuje nejdříve po 20 s. Příprava se sdílí
  mezi pozadím a explicitním ON; současně běží nejvýše jedna.
- Potvrzení připravenosti žije pouze v paměti workeru, nejvýše 30 s a pouze
  v jedné broker session. Obsahuje safety generation, broker observation
  version, connection sync generation, konfiguraci, eligibility množinu,
  skutečně ověřené účty a route epoch jednotlivých účtů. Heartbeat samotný
  obchodní verzi nezvyšuje.
- Chybějící optional follower při obnově spojení nesmí vytvořit oprávnění
  pro pozdější LIVE ARM. Každý požadovaný účet musí být pokryt autoritativním
  snapshotem. Read-only leader se také čte; nesmí zmizet z flat kontroly.
- Příprava čte capabilities, pozice a příkazy, případně potřebné risk
  snapshoty. Nevolá veřejné `reconcile()`, nearmuje, neobchoduje a
  neodstraňuje incident. Brokerová čtení mají 10s deadline; pozdní výsledek
  již ukončeného čtení nemůže publikovat potvrzení.
- ON synchronizuje konfiguraci a exclusions, použije čerstvou přípravu nebo
  na ni vyčká, těsně před ARM ji znovu ověří a zachová všechny dosavadní
  armovací brány. Čerstvá cesta vynechá OAuth routing refresh, opakované
  pozice/orders, ruční recovery i nový vynucený risk poll. Běžný risk polling
  po ARM pokračuje přes heartbeat. Už ověřené limity se při ARM ihned
  vyhodnotí před nově zařazenými událostmi leadera, bez dalšího REST čtení;
  čekání na heartbeat by nechalo známý loss cut dočasně neuplatněný.
  Durable potvrzení ARM zůstává povinné.
- DISARM, kill switch a day lock dál obcházejí FIFO. Deadline a brake epoch
  dál blokují opožděný ARM. Ruční OFF ruší platnost připravenosti.
- Explicitní incident potřebuje ruční kontrolu; další benigní reconnect jej
  nemůže odkliknout. U staršího workeru UI zachová dosavadní ruční kontrolu.
- Běžná příprava nevkládá panel a neposouvá rozhraní. Při ON přepínač ukazuje
  čekání a dovolí zrušení. Výsledek starého ON nepřepíše novější OFF v UI.

## Ověření a meze

- Nová sada `tests/copierWorkerArmPreparation.test.ts`: 17 scénářů pro
  opětovné použití přípravy, deduplikaci, OFF/kill/deadline při čtení,
  expiraci, stream ingress, změnu route epoch před/během čtení, risk data,
  missing optional účet, incident přes reconnect, konfiguraci a omezení
  dotazů na pozadí a okamžité uplatnění známého follower loss cutu.
- Připravené ON přes skutečný agent a simulovaného brokera: žádné volání
  veřejného reconcile, routing refresh, listPositions, listOrders ani nový
  listAccountRiskSnapshots na cestě příkazu. Žádné odeslané obchody.
- UI: automatická příprava nevykresluje recovery panel; starší worker a
  incident jej zachovají. Zrušení ON je dostupné i při ztrátě statusu.
- Lokální prohlížeč: skutečná LIVE stránka vykreslena bez použití execution
  ovládání. Exportované komponenty ověřeny také v oddělené simulaci; kliknutí
  na zrušení přepnulo zpět na OFF. Dočasná simulace byla odstraněna.
- Screenshot simulace: `/private/tmp/alphatrade-copier-preparation-20261004.jpg`.
- Instalace závislostí z lockfile, typecheck a produkční build prošly.
  Celá sada: **4 869 testů / 523 souborů PASS**, 1 soubor skipped a 1 test
  todo. Výsledek je zaznamenán také v `PROJECT_LOG.md`.
- Cílený lint: žádná nová chyba. Stávající chyba `preserve-caught-error` v
  metadata rollbacku `server/localCopierExecutionAgent.ts` potvrzena také
  na nezměněném HEAD; zůstává mimo tuto opravu.

Měřená latence iPhone → relay → worker → potvrzení není součástí offline
testů. Po odsouhlasené instalaci je třeba ověřit konkrétní instalovaný SHA,
čerstvý status, studený start a bezpečný ON/OFF v potvrzeném flat/no-working
stavu. Samotný OFF transport se touto změnou nezrychluje; dostupnější je
jeho ovládání během čekajícího ON.
