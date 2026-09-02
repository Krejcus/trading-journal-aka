# PROJECT_LOG — sdílená paměť AI asistentů

Tento soubor čtou VŠICHNI AI asistenti (Claude, Codex/GPT, …) na začátku
každé session a doplňují ho na konci. Je to jediné místo, kde si předáváme
kontext — soukromá paměť jednotlivých nástrojů se sem nedostane.

## Pravidla

1. Na začátku session si přečti celý tento soubor (je záměrně krátký).
2. Po významné práci PŘIDEJ datovaný zápis nahoru do Deníku. Nepřepisuj
   cizí zápisy; oprav jen fakta, která prokazatelně přestala platit.
3. Zapisuj rozhodnutí a PROČ, ne výpis commitů — ty jsou v gitu.
4. Otevřené otázky udržuj v sekci níže: přidávej, a vyřešené škrtej
   s odkazem na zápis, který je vyřešil.
5. V repu pracuje vždy jen jeden asistent naráz. Necommitnutá rozpracovaná
   práce druhého se nezahazuje — zeptej se uživatele.

## Stav projektu (průběžně aktualizovat)

- **Copier**: jádro ověřené na Tradovate DEMO (limit, market, OCO, OSO,
  Flatten, multiplikátory i fan-out na 5 followerů napříč Tradeify + Lucid).
  Mac runtime: launchd agent + Supabase command relay + device pairing.
  Poslední úplné automatické ověření: 1729 testů, typecheck, lint bez chyb
  a produkční build čisté.
- **Bezpečnostní model**: DISARMED default; fail-closed všude; durable
  outboxy (standard/cancel/bracket/OSO); žádný blind retry — po nejistém
  výsledku vždy lookup podle `clOrdId`; divergence = halt-group, nikdy se
  neopravuje obchodem; kill switch = jednosměrná západka.
- **Risk settings**: per-follower `maxContracts`; anti-revenge cooldown
  (flat leadera → DISARM + blokovaný re-ARM, `safety.entryCooldownMinutes`);
  ARM expiruje nejpozději v 17:00 America/Chicago a otevřené kopie
  risk-redukčně zavře (`safety.armExpiryFlatten`, default `followers`);
  auto day-lock z denní ztráty leadera (`safety.dailyLossLimitUsd`,
  `dailyMaxLosingTrades`) — zamyká až po flat, nikdy uprostřed obchodu.
- **Další fáze**: přesun runtime na VPS/Fly — plán v `COPIER_VPS_PLAN.md`.
  Fencing lease (`copierWorkerLease.ts` + migrace) a `supabaseCopierStore`
  s fence jsou napsané a ČEKAJÍ na VPS worker entry — vědomě nezapojené,
  Mac pilot jede na `fileCopierStore`.

## Klíčová rozhodnutí (a proč)

- **Tradovate není idempotentní** — `customTag50` broker odmítl
  (Unregisted Tag50), používá se `clOrdId`, ale ani ten negarantuje
  odmítnutí duplicity. Outbox + lookup-before-retry je proto nosná
  konstrukce, ne pojistka. Nezjednodušovat.
- **Cooldown blokuje ARM, ne jednotlivé objednávky** — selektivní
  vynechání entry by založilo záměrnou divergenci, kterou by reconciler
  správně zabil. Obě strany flat → žádný rozdíl.
- **VPS worker nepotřebuje veřejný endpoint** — command relay přes
  Supabase (`tradovate_copier_commands`) je transport-agnostický; worker
  drží jen odchozí spojení. Kill switch z mobilu funguje přes relay.
- **Žádný stav na disku VPS** — snapshot v `copier_runtime_state`,
  box je vyměnitelný; obnova = nový deploy, ne restore zálohy.
- **Menu bar Mac aplikace zamítnuta** — leštila by kokpit letadla, které
  nahradí VPS; stejná investice jako celý VPS přechod.

## Otevřené otázky

- [x] iOS 26 WidgetKit APNs registrace — VYŘEŠENO 21. 8. (zápis „widgety a
      notifikace dokončeny"): příčinou byl Postgres regex limit v CHECK
      constraintu; registrace, push i push-triggered reload fyzicky ověřeny.
- [x] ActivityKit push-to-start — FYZICKY OVĚŘENO 21. 8.: Live Activity se
      vytvořila ze serveru při force-quit appce (ARM z Mac Safari).
- [x] Kabel rebuild — 21. 8. nainstalován build shodný s repem (devicectl).
- [ ] Pairing flow (ikona klíče v LIVE Connections) — nasazený, ale
      neproklikaný na produkci.
- [x] Multi-follower DEMO test — 18. 8. potvrzen OCO/SL lifecycle na čtyřech
      Tradeify followerech a jednom Lucid followerovi; všichni skončili flat.
- [ ] Incident 31. 8. „pending SL 29379 → 29391 se followerům nepropsal,
      leader skončil flat a šest kopií zůstalo otevřených; Flatten fyzicky
      zavřel, ale UI hlásilo unknown" — lokální oprava je nainstalovaná v Mac
      workeru a šest legacy unknown bylo 1. 9. autoritativně uzavřeno read-only
      stavem. Kód zatím není pushnutý a před dalším ARM chybí řízený DEMO
      conformance test nové pending-SL/leader-flat cesty.
- [ ] Incident 25. 8. „validní follower vstup okamžitě zploštěn“ — lokální
      kauzální oprava a deterministické regrese jsou hotové (zápis níže), ale
      před dalším LIVE ARM chybí explicitně schválený push, reinstall workeru
      ze stejného commitu a řízený DEMO test.
- [ ] Incident 26. 8. „úspěšný flat zbytečně DISARMoval session“ — přesná
      příčina i lokální oprava jsou ověřené (zápis níže), ale změna zatím není
      commitnutá, pushnutá, nasazená ani nainstalovaná do Mac workeru.
- [x] Incident 27. 8. „dvě follower pozice bez SL + nefunkční Flatten All“ —
      VYŘEŠENO: implementační commit `de93fd3a`, produkční Vercel READY,
      worker reinstalovaný ze stejného stromu, přesná regrese `6 → 11` a
      skutečný 1× MNQ DEMO emergency Flatten skončily flat/no-active.
- [x] Incident 26. 8. „změna nativního OSO parentu relativně posunula follower
      SL/TP“ — VYŘEŠENO 26. 8. (zápis „řízený DEMO důkaz OSO parent cascade“):
      přesná oprava bez povinného `parentId` je nasazená a skutečný Tradovate
      DEMO test potvrdil absolutní shodu parentu, SL i TP na 4 followerech.
- [x] Durable account eligibility + více uložených překrývajících se profilů
      s nejvýše jednou execution-aktivní skupinou — VYŘEŠENO 27. 8. včetně
      cíleného read-only ověření, zachování BREACHED po zmizení z OAuth,
      bezpečného odebrání nedostupného followera a DISARMED restartu workeru.
- [ ] Změna leadera pouze z LIVE UI — bezpečná atomická runtime epocha je
      lokálně hotová a otestovaná (zápis níže); před praktickým použitím čeká
      na explicitní push, deploy, reinstall stejného commitu a DEMO ověření.
- [ ] UI políčko pro `entryCooldownMinutes` (config i agent flag existují).
- [ ] Cross-firm kopírování: technický fan-out Tradeify -> Lucid v DEMO prošel;
      stále chybí písemné potvrzení pravidel obou prop firem pro ostré použití.
- [ ] `copytrade-preview.{html,tsx}` — poslední untracked soubory; commit
      jako dev nástroj, nebo smazat (rozhodnutí uživatele).
- [x] Test „Flatten při nejasném cancelu" už nepoužívá produkční čekání:
      deterministicky injektuje nulové čekání a dvě kontrolní iterace.
- [x] Zmizelý follower bez BREACH/DLL už neblokuje Edit group ani read-only
      reconcile — vyřešeno explicitním required/optional OAuth kontraktem
      a durable `unverifiable` klasifikací 2. 9. (zápis níže).
- [ ] Chaos test recovery proti reálnému DEMO: běžný restart flat/DISARMED
      prošel 18. 8.; kill uprostřed odesílání a výpadek WS zůstávají ověřené
      jen deterministicky a nesmí se vyrábět zbytečnou broker objednávkou.

## Deník (nejnovější nahoře)

### 2026-09-02 (Claude, přenos companionu do `main` a náprava 404)

Companion (API, migrace, Swift appka, PWA karta, spec, mockupy, testy) dosud
existoval jen v pracovním stromu větve `codex/ios-native-checkpoint-20260814`
(21 commitů za `origin/main`, tisíce řádků jiných rozdělaných copier změn).
Produkční deploy 2026-09-01 byl promovaný z lokálního zdroje; ranní pushe do
`main` (`7763bfcd`, `4b5ffada`) spustily automatický Vercel deploy, který
companion API smazal — `/api/mac-companion/status` vracel 404, appka
fail-closed ukazovala „STAV NEDOSTUPNÝ". Ověřeno curl (companion routy 404,
`native-widget-snapshot` 401). Zároveň `launchctl print` nenašel službu
`app.alphatrade.status.autostart` v aktivní uživatelské relaci.

Postup: návratový archiv celého špinavého stromu vč. untracked
(`~/Documents/AlphaTrade-backups/2026-09-02-133440-dirty-tree-before-companion-port.tar.gz`),
čistý worktree z `origin/main`, přenos pouze companion souborů + tří
integračních hunků (`App.tsx` deep link, `TradovateLiveDesk.tsx` karta a
záložka, `vite.config.ts` `launch_handler`). Vizuál: patička „READ-ONLY ·
ŽÁDNÉ OBCHODNÍ OVLÁDÁNÍ" odstraněna (uživatel ji z návrhu vyřadil už dřív),
systémový modrý focus ring na tlačítkách vypnut `focusEffectDisabled()` na
hostovaném kořeni (build 4 ho řešil jen u hlaviček sekcí); build 5. Docs:
README a spec v1.3 uvádějí skutečný stav a poučení „companion musí být
v mainu, jinak ho další deploy smaže". Žádný broker write, ARM/DISARM ani
zásah do copier workeru.

### 2026-09-02 (Claude, rollout workera 7763bfcd)

Mac worker reinstalován uživatelem přes `scripts/copier/mac-reinstall-safe.sh`
z `main` `7763bfcd` (obsahuje vanished-follower kontrakt i install guard).
První pokus selhal, protože skript četl parametry z `ps` a cesta
„Application Support" se rozpadla na mezeře → instalátor manifest nenašel,
nic se nezměnilo; opraveno čtením `ProgramArguments` z launchd plistu.
Po reinstallu: jediný čistý start 06:55 UTC (žádný crash-loop), bundle
s novými markery, read-only reconcile 0 divergence / 0 working orders,
`reconciliationRequired=false`, `lastError=null`, snímky `ready`.
Skupina zůstává DISARMED; DLL zámek LFE…016 vypršel s novou session
(autoritativně reaktivován 06:52 UTC), trvá jen BREACH 62364058.

### 2026-09-02 (Codex, bezpečné odebrání followera zmizelého z OAuth)

Routing refresh má místo seznamu s implicitním polykáním chyb explicitní
kontrakt `prepareGroupAccounts({ required, optional }) -> { missingOptional }`.
Při změně topologie je optional pouze follower, který je ve staré skupině,
není v nové a není starý ani nový leader. Všechny OAuth adresáře se vždy
obnoví celé: pouze nulová viditelnost optional účtu dovolí route vynechat a
pilot zapíše konkrétní `ROUTING OPTIONAL SKIP`; duplicita, inactive/read-only
stav nebo chybějící Account.name dál selžou. Leader a každý účet nové
topologie jsou vždy required. Žádné automatické párování ani náhrada ID
nevznikly.

Controller dostane jen validovaný seznam optional účtů skutečně chybějících
v OAuth. `reconfigureGroup`/`activateGroup` smí přeskočit pouze takového
odebíraného followera bez route. Pokud OAuth starý účet vrátí, controller dál
načte capability, pozice i working orders a změnu při expozici nebo příkazu
fail-closed odmítne; účet v nové topologii ani leader nelze výjimkou označit.

Samostatný reconcile používá leadera jako required a followery jako optional
pouze pro OAuth discovery. Chybějící follower bez dosavadního eligibility
záznamu se durable označí `unverifiable` s důvodem a zůstane vykázaný v
`oauthPreflight.missingAccounts`, zatímco zdravé routované účty projdou
autoritativní kontrolou. Tato varianta zachovává existující eligibility
mechanismus a dovolí zdravý read-only reconcile, ale nezeslabuje leadera ani
účet, který OAuth vrací. `canSafelyRestartLocalCopierAgent` se neměnil; po čisté reconciliaci
restart brána projde i s vykázaným missing účtem (ten nemá route a
restart nic neobchoduje), `oauthPreflight.missingAccounts` zůstává
viditelná diagnostika. ARM/SHADOW jsou pro missing followera dál
fail-closed přes strict routing (oprava recenze Claude 2. 9.).

Regrese pokrývají odebrání i náhradu zmizelého followera, povinného zmizelého
leadera, followera ponechaného v nové topologii, strict preflight viditelného
odebíraného účtu a reconcile bez eligibility záznamu. `npm run typecheck`
prošel; cíleně 143/143 a celá sada 205 souborů / 1737 testů. Závislosti nebyly
instalovány. Neproběhl push, deploy, reinstall workeru, ARM, Flatten ani jiný
broker side effect; aktivace v provozu čeká na samostatný schválený rollout.

### 2026-09-02 (Codex, fail-closed reinstall při rozdílu CLI a durable skupiny)

Mac instalátor už nemůže tiše ignorovat opravené `--leader/--followers`.
Pilot a instalátor sdílejí jediný helper pro stabilní
`<connectionId>-<leader>` klíč a cestu ke `group.json`; ještě před prvním
zápisem, buildem nebo restartem instalátor porovná leadera a follower
`accountId`, `multiplier` a `maxContracts`. Rozdíl bez explicitní volby skončí
nenulově a vypíše durable i CLI podobu. `--adopt-durable-group` zachová
durable autoritu a CLI nechá jen jako bootstrap fallback.

`--replace-durable-group` je pouze souborová operace: vyžaduje čerstvý
loopback status `DISARMED`, `groupFlat=true`, nula working orders a nula stuck
outboxu/operací. Před atomickým přepisem vznikne exkluzivní
`.bak-<timestamp>`; metadata, safety a existující follower mode zůstávají
zachované. Safe-reinstall skript volá install s explicitním
`--adopt-durable-group`. Selhání startovní validace nově uvádí přesnou
cestu k durable souboru a bezpečnou nápovědu pro replace nebo ruční opravu.

Oveření: 206 test souborů / 1737 testů, `npm run typecheck`, produkční
Vite/PWA build, samostatný Node 20 worker bundle, shell syntax safe-reinstallu,
cílený lint a `git diff --check`. Neproběhl push, deploy, reinstall/restart
workera, ARM, Flatten ani jiná brokerová akce.

### 2026-09-01 (Codex, AlphaTrade Status build 4 — bez modrého focus ringu)

Systémový modrý focus ring na rozbalené sekci `DISARMED` byl odstraněn přes
availability-gated SwiftUI `focusEffectDisabled()` (macOS 14+). Sekce zůstává
nativní `Button`, takže kliknutí, animace, VoiceOver i klávesová focus
sémantika zůstaly zachované; deployment target macOS 13 se nezvýšil. Release
build 0.2.0 (4) pro arm64 prošel sestavením a strict codesign kontrolou a byl
nainstalován do `/Users/filipkrejca/Applications/AlphaTrade Status.app`.
Předchozí build 3 a LaunchAgent plist jsou v návratové záloze
`mac-install-before-0.2-build4-2026-09-01-153247` uvnitř produkčního backup
balíčku. Build 4 běží; plist automatického spuštění zůstal na místě a není
disabled, ale okamžitý re-bootstrap této relace launchd odmítl oprávněním
volajícího Codexu. Při příštím přihlášení jej má načíst macOS. Copier worker,
broker ani ARM/DISARM stav se neměnily. Samostatný produkční regres status API
(404 po pozdějším deployi) tímto čistě vizuálním buildem řešen nebyl.

### 2026-09-01 (Codex + uživatel, produkční aktivace read-only companionu)

Po výslovném souhlasu uživatele byla před změnou ověřena aktuální fyzická
Supabase záloha a vytvořen lokální návratový balíček v
`/Users/filipkrejca/Documents/AlphaTrade-backups/2026-09-01-121202-before-mac-companion-prod`.
Additivní migrace `20260901101932_mac_companion_devices_v1` byla aplikována na
projekt `kopinlpdvjfgmvxydohk`. Tabulka je server-only: RLS je zapnuté bez
browser policies, `anon`/`authenticated` nemají práva a skutečné souběžné testy
potvrdily atomické per-IP i globální limity. Testovací řádky byly uklizeny.

První webový kandidát byl omylem sestaven lokálně přes `--prebuilt`, takže nový
frontend neměl produkční `VITE_SUPABASE_*`. Hlavní doména byla okamžitě vrácena
na známý zdravý deployment `dpl_7vSAKC4PaGwbF4h5LkA9qAiDjojY`; žádná databázová
nebo brokerová změna z tohoto vadného bundle nevznikla. Opravený source build
`dpl_CAJCKx5JcYXm89u9C6UTBmnS1y9Z` byl nejdřív ověřen jako staging a potom
promován na `https://alphatrade-mentor-15.vercel.app`. Nový jednorázový marker
`?open=mac-companion-pairing` přežije login, počká na autoritativní owner roli,
otevře LIVE/Connections, posune a zaměří párovací formulář a po použití se z URL
odstraní. Zůstává kompatibilní se starým odkazem a `launch_handler` řeší už
otevřenou PWA. Čistý i přihlášený produkční browser tento tok potvrdily.

Uživatel skutečně potvrdil pairing zařízení `MacBook Air`. Server po potvrzení
vymazal pairing hash i expiraci, aktivní credential má pouze scope
`copier.status.read` a `/api/mac-companion/status` od té doby opakovaně vrací
HTTP 200. Žádný nový pending kód po aktualizaci nevznikl. Reálnou revokaci jsme
záměrně neprovedli, aby funkční zařízení zůstalo připojené; endpoint i UI jsou
kryté automatickými testy.

Finální nativní `AlphaTrade Status` 0.2.0 build 3 byl arm64 Release, ad-hoc
podepsán s hardened runtime a přesně dvěma oprávněními: App Sandbox a odchozí
síť. Nainstalovaný executable má SHA-256
`28727706a37856c33320b6419daa33664bf9e4607ce8ae27f881c8fd4f18fca7`.
Předchozí build 2 i LaunchAgent jsou v návratovém balíčku. LaunchAgent nyní
spouští build 3 z `/Users/filipkrejca/Applications/AlphaTrade Status.app`, bez
fixture nebo secretu v prostředí; kontrolní `kickstart -k` změnil PID a aplikace
po restartu dál načetla stejné párování z Keychainu. Databázové `last_used_at`
i nové produkční status requesty 200 to potvrzují.

Přesná kanonická web/server sada prošla 13 soubory / 56 testy, TypeScript a
cílený lint s 0 chybami. Při nativním běhu prošlo 30/32 funkčních testů; dvě
renderovací aserce původně selhaly pouze kvůli sandboxovanému zápisu testovacího
PNG do `/tmp`, proto test harness používá cache adresář uživatele. Izolovaný
retry obou dotčených sad se sestavil, ale Xcode zůstal na `waiting for workers
to materialize` a byl ohraničeně ukončen ještě před spuštěním assertions (0
skutečných test failures); produkční proces zůstal nedotčený. Žádný broker
write, ARM, Flatten, worker reinstall ani zásah do copier runtime neproběhl.

### 2026-09-01 (Codex, lokální read-only companion 0.2 — produkce HOLD)

Po uživatelově výslovném schválení byla lokálně dokončena druhá verze
`AlphaTrade Status`: AppKit `NSStatusItem` + animovaný `NSPopover`, světlý i
tmavý vzhled, serverem korigovaný 10/90s freshness reducer, HTTPS klient s
pevným AlphaTrade hostem, Keychain credential, jednorázový pairing a revokace.
PWA má v LIVE Connections kartu pro potvrzení kódu, přejmenování a revokaci
Maců. Nové `/api/mac-companion/status` čte jen cloudové runtime tabulky; nemá
Tradovate/fetch/broker/command cestu a současnou expozici poctivě vrací jako
neověřenou. Scope je pevně `copier.status.read`; databáze ukládá jen SHA-256
digesty. Veřejný pairing start má atomický Postgres limit 10/10 min na HMAC IP
bucket a 120/10 min globálně, se server-only RLS/granty a bounded cleanupem.

Safety review doplnilo fail-closed zacházení s neplatnými runtime poli,
neúplným follower ack, neověřenými working orders a probuzením Macu: po wake se
před síťovým refreshem okamžitě zahodí časová důvěra, takže staré zelené LIVE
nemůže přežít nefunkční síť. Cílená web/server sada prošla 12 soubory / 52
testy, TypeScript a cílený lint jsou čisté; nativní sada prošla 29/29 XCTest a
Release buildem. PWA karta i menu/popover prošly lokální vizuální kontrolou.

**Nic nebylo nasazeno ani aplikováno na produkční databázi.** Kandidát 0.2
nebyl spuštěn ani nainstalován, stávající mock 0.1 a jeho LaunchAgent zůstaly
beze změny, stejně jako broker, worker a copier runtime. Před produkčním krokem
je závazná záloha a další explicitní souhlas; lokální SQL test nenahrazuje
skutečný souběžný test rate limitu a E2E pairing/revokace po migraci.

### 2026-09-01 (Codex, trvalá instalace mock menu-bar companionu)

Po uživatelově samostatném výslovném souhlasu byl mock-only prototyp
`AlphaTrade Status` 0.1.0 sestaven v Release pro arm64, lokálně ad-hoc podepsán
s hardened runtime a nainstalován do
`/Users/filipkrejca/Applications/AlphaTrade Status.app`. `LSUIElement=true`
zachovává provoz pouze v horní liště. Nainstalovaný executable má SHA-256
`6b709d32f03b77c94cb7c40fb7ad2ff98ba39da2cc3965066a8b9b847108cfda` a
`codesign --verify --deep --strict` prošel.

Autostart zajišťuje uživatelský LaunchAgent
`app.alphatrade.status.autostart` v `~/Library/LaunchAgents`; `RunAtLoad`
spouští nainstalovaný executable v Aqua session s deterministickou fixture
`live`. Kontrolní `kickstart -k` změnil PID a druhá instance zůstala ve stavu
`running`, takže byl ověřen restart z trvalé cesty. Komponentová a renderovací
sada znovu prošla **16/16**.

Toto schválení se týkalo jen lokálního mock prototypu. Neproběhlo napojení na
status endpoint, pairing, Keychain, Developer ID distribuce, síťové volání,
Vercel deploy, broker příkaz, ARM/Flatten ani zásah do copier workeru.

### 2026-09-01 (Codex, skutečný NSStatusItem + animovaný popover)

Uživatelská kontrola potvrdila limit `MenuBarExtra`: SwiftUI label měnil část
vzhledu, ale systém samostatně cacheoval obal a při kliknutí kreslil druhý
vnější highlight. Negativní padding proto nemohl zaručit jediný pill ani
spolehlivou změnu light/dark po startu v opačném režimu.

App shell byl přepojen na skutečný `NSStatusItem` řízený AppKit delegate.
Barevný stav je teď pozadí přímo `NSStatusBarButton`, jeho content má nativní
3pt inset a výsledný button přesně `28 pt`; vestavěné `highlightsBy` a
`showsStateBy` jsou vypnuté, takže kliknutí už nemá přidat druhou pilulku.
KVO na `NSApplication.effectiveAppearance` podle doporučení AppKit překreslí
současně background i text/logo a přenese nový appearance také do otevřeného
`NSPopover`. Light podklad je pale emerald složený nad `#fafafc`, dark podklad
nad `#121624`.

Popover se při každém otevření vytvoří s novým SwiftUI rootem a má jemný
180ms nástup (`scale 0.985 → 1`, `opacity 0.94 → 1`, `y -4 → 0`) společně
s nativní NSPopover animací. První frame zůstává z 94 % viditelný, takže ani
při selhání lifecycle callbacku nevznikne prázdný panel; Reduce Motion pohyb
vypne. Komponentová/renderovací sada prošla **16/16** a kontroluje jediný
system-sized button, zakázaný highlight, rozdílné light/dark barvy i layout
produkční entrance wrapper cesty. Běží právě jedna čerstvá lokální LIVE fixture
instance. Neproběhl deploy, podpis, instalace, síťové volání, broker příkaz ani
změna workeru.

### 2026-08-31 (Codex, systémový menu-bar pill a dynamický vzhled)

Další kontrola na skutečné liště ukázala dvě nativní odchylky, které samotný
Claude HTML mock nemohl zachytit: `MenuBarExtra` přidává kolem labelu vlastní
3pt content inset, takže 22pt artwork vypadal při systémovém highlightu jako
„pill v pillu“, a natvrdo zapečený light podklad nereagoval na změnu vzhledu.
Artwork má proto nově 28pt vnější systémový tvar s radiusem 7 pt; SwiftUI
label záporným 3pt insetem vyplní přesně status button a vlastní i macOS
highlight se při kliknutí překryjí. Logo a text uvnitř zachovávají původní
17pt / 12pt / 6pt rozměry.

Label čte aktuální `colorScheme` a pro každý render volí samostatnou light/dark
paletu z Claude mockupů. Light emerald `16 %` je složený nad `#fafafc`, aby
zůstal skutečně světlý i nad barevným wallpaperem; dark emerald `22 %` je
složený nad `#121624` a používá text `#a7f3d0`. Stejná pravidla platí pro
SHADOW, warning a danger. Komponentová a renderovací sada prošla **16/16**
a explicitně porovnává light/dark výstup i finální velikost po započtení
systémového insetu. Běží právě jedna čerstvá lokální LIVE fixture instance;
žádný deploy, síťové volání, broker příkaz ani změna workeru neproběhly.

### 2026-08-31 (Codex, přesná korekce LIVE pillu podle Claude mockupu)

Uživatelský screenshot odhalil, že první trvale viditelná varianta sice vyřešila
mizení podkladu, ale nebyla vizuálně věrná: AppKit kreslil logo v převrácené
souřadné soustavě, LIVE výplň míchal 22 % emerald s tmavým panelem, přidával
neexistující obrys a používal 11pt mono-black písmo. Artwork nyní přebírá
světlé tokeny přímo z `MenuBarLight.dc.html`: pill 22 pt, radius 5 pt, logo
17 pt, mezera 6 pt, horizontální padding 7 pt, nativní SF Pro 12 semibold,
text `#047857`, emerald 16 % nad světlým menu-bar podkladem a bez obrysu či
stínu. Logo respektuje flipped AppKit kontext a celý label je na skutečné
liště posunutý o 1 pt nahoru. Pale emerald se zapeče do non-template obrazu,
aby barvu znovu nezměnil wallpaper-tinted macOS menu bar.

Komponentová a renderovací sada prošla **16/16**; kontroluje rozměry, světlý
emerald kontejner i všech 18 popover PNG. Stará Debug instance byla ukončena
a spuštěn nový lokální LIVE fixture build. Neproběhl deploy, podpis, instalace,
autostart, síťové volání, broker příkaz ani zásah do copier workeru.

### 2026-08-31 (Codex, oprava skutečného menu-bar runtime po uživatelské kontrole)

Uživatel při kontrole skutečné lišty viděl obří AT logo a po otevření prázdný
panel. Předchozí závěr z offscreen PNG renderů byl nedostatečný: všechny render
testy obcházely produkční `onAppear` větev parametrem `animateOnAppear:false`.
Současně zůstala v systému běžet stará Debug instance z 19:33, zatímco novější
bundle vznikl až později; rebuild běžící `LSUIElement` proces sám nenahradí.

Kód je nyní fail-visible i v prvním frame. Celokořenový `opacity(0)` / scale /
offset gate byl odstraněn; rozbalovací animace zůstaly lokální. Pro horní lištu
vznikl samostatný AppKit obraz se skutečnou logickou velikostí přibližně
`21,64 × 17 pt`, explicitním SwiftUI frame v obou osách a zachovanými barvami
čistého skleněného loga. Nativní `NSStatusBarButton` regresní test hlídá, že se
intrinsic velikost původního PNG `112 × 88 pt` už nemůže propsat do lišty.

Vznikl také samostatný `AlphaTradeStatusUITests` target: má přes reálný
Accessibility strom najít status item, ověřit jeho frame, otevřít panel,
zkontrolovat LIVE obsah a tlačítko, rozbalit Bezpečnost, zavřít a znovu otevřít
panel a přiložit screenshoty. Target i `build-for-testing` prošly. Runtime UI
test ale na tomto hostu nebyl proveden: Xcode nevytvořil test worker a zůstal
čekat na `waiting for workers to materialize`; běh byl po 144 s ukončen bez
spuštěné assertion. Tento stav se výslovně **nepočítá jako PASS**.

Komponentová sada po opravě prošla **15/15** a znovu vytvořila všech 18 light/
dark PNG. Stará instance byla přesně ukončena a běží jediný čerstvý Debug build
z opraveného stromu. Neproběhl deploy, podpis, instalace, autostart, síťové
volání, broker příkaz, ARM, Flatten ani změna workeru; fáze 2/3 zůstávají HOLD.

Následná uživatelská kontrola skutečného buildu potvrdila správnou velikost
ikony i kompletní obsah panelu; poslední rozdíl proti mockupu byl příliš slabý
LIVE podklad v liště. První oprava přes SwiftUI background nefungovala: uživatel
ověřil, že zelená byla vidět jen během kliknutí, tedy jako systémový selected
stav. Finální label proto není složený SwiftUI layout; logo, neprůhledná zelená
výplň, stroke a `LIVE 42m` jsou zapečené do jediného barevného, non-template
`NSImage` o výšce 22 pt. macOS tak nemůže klidový podklad zahodit. Pixelová
regrese kontroluje přímo tento nativní artwork a komponentová sada zůstává
**16/16**. Unit a nativní UI testy jsou oddělené do schémat `AlphaTradeStatus`
a `AlphaTradeStatusUI`, aby blokovaný UI runner nebránil běžným testům.
Uživatel následně screenshotem v 21:39 fyzicky potvrdil, že zelený zaoblený
LIVE kontejner zůstává viditelný i v neaktivním stavu bez kliknutí.

### 2026-08-31 (Codex, AlphaTrade Status fáze 1 — nativní mock prototyp)

Vznikla izolovaná macOS aplikace `macos/AlphaTradeStatus`: skutečný SwiftUI
`MenuBarExtra` ve window stylu, `LSUIElement` bez ikony v Docku a bez hlavního
okna. Vzhled převádí Claude mockupy do nativních komponent a drží jejich
hranatější karty, světlý režim, emerald CTA a čisté skleněné AT logo. Sekce jsou
interaktivně rozbalovací, respektují Reduce Motion a problémový blok se ve
výchozím stavu otevře sám.

Prototyp má devět deterministických fixture stavů: LIVE, LIVE bez dostupného
follower acku, SHADOW, DISARMED flat, DISARMED s expozicí, DISARMED bez
ověření, VYŽADUJE ZÁSAH, STAV NEZNÁMÝ a WORKER OFFLINE. Doménová prezentace
záměrně nesmí vyrobit nepravdivé `N/N`, tvrdit flat bez čerstvého ověření ani
překrýt problém starou poslední známou hodnotou. SHADOW jasně říká, že nic
neodeslalo; freshness je oddělená od safety stavu.

**Safety hranice:** fáze 1 používá jen lokální mock data. Aplikace nemá síťové
entitlementy ani implementaci pro API, Supabase, Tradovate, auth, pairing,
Keychain, ServiceManagement, ARM nebo Flatten. Odkazy pouze otevírají existující
PWA; refresh animuje lokální mock. Diagnostika kopíruje allowlistovaný text bez
account aliasů a secretů. V panelu je trvale viditelné označení „FÁZE 1 ·
UKÁZKOVÁ DATA“, takže render nelze vydávat za živý stav.

**Ověření:** Debug i Release build prošly, celé XCTest schéma prošlo **14/14**.
Testy pokrývají všech devět fixtures, stale precedence, flat/ack invariants,
bezpečný diagnostický text, URL a light/dark layout; render test vytvořil 18 PNG
náhledů (každý stav ve světlém i tmavém režimu). Nesignovaný Debug build byl
lokálně spuštěn a zůstal stabilně běžet jako menu-bar-only proces. Neproběhl
commit, deploy, podpis, instalace, autostart, síťové volání, broker příkaz, ARM,
Flatten ani změna workeru. Fáze 2 a 3 zůstávají HOLD podle otevřené otázky výše.

### 2026-08-31 (Claude + uživatel, návrh macOS menu-bar companionu „AlphaTrade Status")
Revize dřívějšího zamítnutí menu-bar aplikace: zamítnutí platilo pro kokpit
svázaný s dočasným Mac workerem; nová varianta je čistě read-only klient
CLOUDOVÉHO stavu (vzor `/api/native-widget-snapshot`), takže přežije přesun
na VPS beze změny — proto dává smysl. Vznikl kompletní interaktivní vizuální
návrh (tmavý + světlý režim, 5 stavů ikony, 4 stavy popoveru s rozbalovacími
sekcemi a animacemi) a předávací specifikace pro implementaci Codexem:
`docs/MENUBAR_COMPANION_SPEC_20260831.md`; zdrojové mockupy
v `mockups/menubar-companion/`. Klíčová rozhodnutí: stav ARM přejmenován na
zelené LIVE (slovo ARM se v UI nepoužívá); stará data vždy přebijí poslední
známý stav (STAV NEZNÁMÝ ≠ staré DISARMED); followeři se agregují (20/20)
a jednotlivě se vypisuje jen selhavší účet; panel je read-only vynucený
serverovým token scope (`copier.status.read`), žádné ovládání copieru.
Nic se neimplementovalo — jen návrh a specifikace.

Doplněk téhož dne: Codex udělal review specifikace (GO jen pro vizuální
fázi) a Claude zapracoval **v1.1**: závazný freshness model sladěný s relay
(≤10 s ověřeno / 10–90 s NEZNÁMÝ / >90 s WORKER OFFLINE; žádná 30min zelená),
zákaz pollování `/api/native-widget-snapshot` (drahý broker snapshot) →
nový levný `/api/mac-companion/status` + broker ověření jen na otevření
panelu, verzovaný allowlist DTO s poctivými limity (followerAck může být
null — dnešní runtime neumí per-follower ack; „flat" jen z `verifiedAt`,
ne z groupFlat), Mac pairing s vlastním scope a revokací (iOS widget flow
nelze převzít — vázaný na iOS bundle), doplněný SHADOW popover do mockupů
a kontrastní korekce světlého režimu. Otevřené body pro uživatele: barva
primárního tlačítka (emerald vs. indigo) a čitelnost skleněného loga na
světlé liště.

### 2026-09-01 (Claude, nasazení názvů účtů + zaklesnutý worker na zrušené challenge)

Web: Codexův commit `5b7f10c8` (jednotné názvy účtů, strukturované
blokery) recenzován a fast-forward pushnut na `main`; Vercel READY ve
23:10, ověřeno v přihlášeném LIVE. Push šel přes
`ssh://git@ssh.github.com:443/…`, port 22 je v tomto prostředí blokovaný.

Provozní nález: follower `62364057` (TDFYG50335049318) byla challenge,
kterou uživatel prošel; Tradeify ji zrušila a vydala funded
`64310872` (FTDFYG50511354175). Zrušený účet Tradovate už nevrací, ale
NEMÁ eligibility záznam BREACH/DLL, takže `accountsRequiredForRoutingChange`
ho při každé změně skupiny drží ve sjednocení topologií → dynamic routing
odmítne („není viditelný v žádném připojeném OAuth") a stejně padá i
read-only reconcile. Worker tak zůstal s `reconciliationRequired` +
`divergentAccounts=[62364057]` (reálná divergence +1/−1 MNQU6 18:19–18:25
UTC, fail-closed správně) a z UI se z toho nedá dostat. Rozhodnutí
uživatele: nahradit `62364057@1` za `64310872@1` reinstallem workera z CLI
(skupina se bere z parametrů), potom read-only reconcile, teprve pak
„Obnovit snímky". Přidán `scripts/copier/mac-reinstall-safe.sh`: přebírá
parametry z běžícího agenta, brána zrcadlí `canSafelyRestartLocalCopierAgent`
+ `lastError` a bez čistého stavu neudělá nic. Reinstall spouští uživatel
ručně (auto-mode klasifikátor Claude Code reinstall služby blokuje).

Dokončení (23:55): reinstall s novým `--followers` skupinu NEZMĚNIL —
durable `<conn>-<leader>.group.json` je po první UI změně autoritativní
(pilot.ts, `persistedGroup ?? fallbackGroup`) a `validateStoredCopyGroupForStartup`
worker se starým followerem shodila do crash-loopu (launchd runs=8). Jediná
operátorská cesta: záloha + ruční nahrazení `accountId` v group.json
(62364057 → 64310872, mode/multiplier zachovány), launchd worker sám
nastartoval, TradingView CDP 9222 naběhlo automaticky (`snapshotHealth:
ready`), read-only reconcile čistý (0 divergence, 0 working orders),
`reconciliationRequired=false`, `lastError=null`. Skupina zůstává DISARMED.

Otevřené: worker by měl umět odebrat/nahradit followera, kterého OAuth
adresář už nevrací, i bez BREACH/DLL záznamu (viz otevřené otázky);
`mac-install.ts` by měl při rozdílu CLI `--followers` vs. durable skupiny
zastavit s jasnou hláškou místo tichého ignorování parametru.
Pozn. k review: pět „502" v konzoli mého tabu nebylo doloženo URL a Vercel
od deploye 5xx neeviduje — pravděpodobně zbytky z doby před nasazením.

### 2026-09-01 (Codex, jednotné názvy účtů a strukturované LIVE blokery)

LIVE copier nyní používá jednu read-only kaskádu názvu účtu pro
tabulku, editor skupiny, dialogy a toasty: živý snapshot, profil, uložená
source group a nakonec `Účet <id>`. Známý název se v blokerech zobrazuje
jako `název (ID <id>)`. Doménové validační texty, workerové chyby, logy a
audit zůstaly beze změny; nové `issues` a UI-only render překlad jsou
aditivní a kompatibilní se staršími volajícími.

Oprava TradingView snímků vrací při zamítnutí strukturovaný
`snapshot-repair-blocked` s přesnými podmínkami, divergentními/working
účty a posledním read-only OAuth preflightem. Diagnostická funkce přesně
zrcadlí původní restart bránu; samotná brána ani její podmínky se
nezměnily. Struktura se zachová přes loopback i command relay, zatímco starší
worker bez struktury dál zobrazí původní obecný text.

Kompletní sada prošla 205 soubory / 1729 testy, TypeScript, cílený lint
upravených React/protokolových souborů, produkční Vite/PWA build a
`git diff --check`. Závislosti nebyly instalovány. Neproběhl push, deploy,
reinstall workeru, ARM, Flatten ani jiná brokerová akce.

### 2026-09-01 (Codex, volitelný DLL sloupec v LIVE tabulce)

Do `Table Settings → Accounts columns` přibyl volitelný sloupec
`DLL zbývá`. Používá stejný konzervativní základ jako existující DLL risk
gate: potvrzený denní limit účtu plus dnešní realizovaný a otevřený P&L.
Během nehotového denního enrichmentu a u účtu bez přiřazeného DLL ukazuje
pomlčku; po dosažení hranice nikdy nezobrazuje záporný „zbývající“ prostor.
Tooltip zachovává konkrétní limit i použitý denní P&L.

V localhost LIVE UI byl sloupec i jeho checkbox ověřen na reálných read-only
datech: Tradeify 1 250 USD, Lucid leader 1 200 USD a Lucid účet s denním
P&L -220 USD zobrazil 980 USD. Cílené render/eligibility testy prošly 15/15,
TypeScript a `git diff --check` jsou čisté. Mac worker nebyl restartován ani
měněn a žádný brokerový příkaz nebyl odeslán.

### 2026-09-01 (Codex, kompatibilita opravy TradingView snímků)

Lokální LIVE UI už nenabízí tlačítko `Obnovit snímky` workeru, který ještě
neumí bezpečný restart TradingView s CDP. Nový worker publikuje explicitní
capability `snapshotHealth.repairSupported`; chybějící hodnota se kvůli
zpětné kompatibilitě vyhodnotí jako starý bundle a UI místo nefunkční akce
ukáže požadavek na aktualizaci Mac workeru. Po aktualizaci zůstane tlačítko
dostupné pouze ve stavu `cdp-offline`.

V reálném localhost UI byla potvrzena přesná diagnóza: web běží s novou
opravnou cestou, ale nainstalovaný worker je starší a požadavek ignoroval.
Regrese LIVE renderu a TradingView lifecycle prošly, workerová sada prošla
33/33 mimo sandbox, TypeScript, produkční build a `git diff --check` jsou
čisté. Worker nebyl bez výslovného souhlasu reinstalován; kopírka zůstala
DISARMED a žádný brokerový příkaz nebyl odeslán.

### 2026-09-01 (Codex, bezpečná UI obnova TradingView snímků po restartu Macu)

Po restartu počítače se TradingView obnovilo dřív než Mac worker a běželo bez
loopback CDP; copier execution zůstal zdravý, ale ENTRY/EXIT grafy by se
neuložily. LIVE dashboard nyní při přesném stavu `cdp-offline` nabízí tlačítko
„Obnovit snímky“. Po uživatelském potvrzení worker požádá TradingView o
standardní ukončení, nikdy nepoužije násilný kill, počká na konec procesu a
spustí aplikaci znovu s CDP pouze na `127.0.0.1:9222`. Pokud se aplikace
neukončí nebo CDP nenaběhne, druhou instanci nespustí a chyba zůstane viditelná.

Maintenance příkaz sdílí existující neobchodní `snapshot-test` relay typ, takže
nepotřebuje novou DB migraci, ale nese explicitní `repairCamera:true`. Worker
jej přijme jen v čerstvém bezpečném runtime stavu: connected, reconciled,
DISARMED, group flat, bez working orders, divergence a stuck outboxu. Akce je
fire-and-forget mimo broker dispatch frontu; nemůže ARMovat, Flattenovat ani
odeslat objednávku a neblokuje nouzové ovládání. U běžícího CDP je idempotentní
no-op. Kompletní sada prošla 203 soubory / 1710 testy, TypeScript, produkční
Vite/PWA build, samostatný Node 20 worker bundle, lint s 0 errors / 352
existujícími warnings a `git diff --check`.

Změna je zatím pouze lokálně v integrační větvi. Mac worker nebyl znovu
instalován, web nebyl pushnut ani nasazen a neproběhl ARM, Flatten ani jiný
broker write.

### 2026-09-01 (Codex, instalace incidentní opravy a stavové uzavření legacy Flatten)

Po ukončení uživatelova obchodu čerstvá read-only reconciliation potvrdila
`armed=false`, všech sedm účtů flat, žádné working orders/divergence a
`lastError=null`; jediným blockerem zůstalo šest `manual-flatten` položek ve
stavu `unknown`. Incidentní změny byly bez konfliktu složeny nad aktuálním
`origin/main` `7932c6ae`, aby reinstall zachoval opravený persistentní worker
lifecycle. Cílená sada prošla 14 soubory / 313 testy; plná sada 203 soubory /
1705 testy. TypeScript, lint s 0 errors, produkční Vite/PWA build, samostatný
Node worker bundle a `git diff --check` prošly.

Mac LaunchAgent byl po uživatelově výslovném pokynu reinstalován se stejným
leaderem `62364553`, šesti followery a `--service-lifetime persistent`.
Nainstalovaný bundle má SHA-256
`4fdb3bbe756f0faf0615abdb53671a2fffb4fd7a34b91c74704f90c45681f8bd`, přesně
shodný s předem ověřeným bundlem. Restart recovery všech šest starých položek
uzavřel jako `confirmed-by-state` z důkazu `flat-no-active`, `netQuantity=0`,
`workingOrders=0`, `causality=not-proven`; neposlal lookup retry ani nový
liquidation POST. Závěrečná reconciliation potvrdila `connected=true`,
`armed=false`, `groupFlat=true`, `reconciliationRequired=false`, prázdný stuck
outbox, žádné working orders/divergence a `lastError=null`.

Neproběhl ARM, Flatten ani jiný broker write a nebyl proveden Vercel deploy ani
push. TradingView snapshot health zůstal samostatně `cdp-offline`; execution
neblokuje. Před dalším ostrým ARM stále chybí řízený DEMO conformance důkaz
nové pending-SL propagace a leader-flat guardu.

### 2026-08-30 (Codex, oprava lifecycle nedostupného Mac workeru)
Příčinou hlášky „Mac worker není právě dostupný" nebyla delší nečinnost
uživatele. LaunchAgent stále spouštěl pilot s limitem `--minutes 720`; po
12 hodinách worker korektně zavřel loopback port i relay, ale kvůli zbývajícímu
Node handle proces neskončil. Launchd jej proto dál považoval za běžící a
KeepAlive neměl co restartovat, zatímco cloud heartbeat zestárl.

Worker nyní v plně spárovaném režimu používá explicitní
`--service-lifetime persistent`; časově omezený fallback zůstává jen pro stav,
kdy nelze bezpečně obnovovat device token nebo není dostupný relay. Ukončení
má synchronní ingress gate, abortovatelné síťové čekání, bounded Keychain/fetch
operace, 20s watchdog a po dokončení bezpečnostního cleanupu explicitně ukončí
proces, takže launchd může službu spolehlivě obnovit. Durable stopa otevřených
kopií se při shutdownu čistí ve stejné serializované frontě jako její zápis,
aby restart nemohl minout právě commitovaný stav. LaunchAgent má zároveň
`ExitTimeOut=25`.

Před reinstalací read-only reconciliation potvrdila DEMO runtime
`armed=false`, `groupFlat=true`, `reconciliationRequired=false`, žádné working
orders, divergence, stuck outbox/operace ani `lastError`; snapshot layout
`AlphaTrade Snapshoty` byl `ready`. Nainstalovaný persistentní worker běží pod
novým PID `65168`, vlastní listener `127.0.0.1:3211`, relay je aktivní a log
potvrzuje vypnutý plánovaný časový restart. SHA-256 nainstalovaného bundle se
přesně shoduje s bundlem z ověřeného zdroje
(`c7de828a…185fb14`). Následná read-only reconciliation znovu nastavila
`reconciliationRequired=false` a potvrdila stejný flat/DISARMED stav i
snapshot health `ready`.

Prošlo 199 test souborů / 1 633 testů, TypeScript, lint bez chyb,
Vite/PWA build a samostatný Node 20 worker bundle. Nebyl proveden ARM, Flatten,
objednávka ani jiný broker write. Po explicitním pokynu uživatele `pushni na
live` byl `main` bez force fast-forwardnut `e0d8d6ff..366688dd`. Produkční
Vercel deployment `dpl_CG7m1HcYrp3Qwzfd1EFWciQtAXVb` dosáhl `READY` pro přesný
SHA `366688dd`; hlavní alias vrací HTTP 200 a neautorizovaný POST na
`/api/tradovate/oauth/pilot-lease` správně 401 `missing-auth-token`. Build
skončil úspěšně. První scan byl čistý; následný minutový cron zapsal na stderr
jen dlouhodobý Node `DEP0169 url.parse()` deprecation warning (historie od
června), ale request `/api/cron/send-alerts` skončil HTTP 200 a bez aplikačního
selhání. Finální read-only reconciliation znovu potvrdila DISARMED/flat stav
bez working orders, divergence, stuck položek a bez broker write.

### 2026-08-29 (Codex, produkční rollout per-capture normalizace viewportu)
Po explicitním pokynu uživatele `pushni to` proběhl worker-first rollout commitu
`34369fd7`. Před restartem byl remote `main` přesně na rodiči `c0277326` a
čerstvá autoritativní reconciliation potvrdila DEMO runtime `armed=false`,
`groupFlat=true`, bez working orders, divergence, stuck outboxu/operací a bez
`lastError`; snapshot layout `AlphaTrade Snapshoty` byl `ready`. Reconciliation
byla pouze read-only a neposlala žádný broker příkaz.

Mac worker byl přebalen z čistého release worktree stejného kanonického git
repozitáře. SHA-256 očekávaného a nainstalovaného `copier-agent.mjs` se přesně
shoduje (`47831c8c…27330a`). Restart zachoval leadera, šest followerů a jejich
multipliery, runtime zůstal DISARMED a snapshot target `ready`. Druhá read-only
reconciliation po restartu znovu potvrdila flat stav bez working orders,
divergence i stuck operací a `reconciliationRequired=false`. Nebyl proveden
ARM, Flatten, objednávka ani jiný broker write.

GitHub `main` byl bez force fast-forwardnut `c0277326..34369fd7`. Produkční
Vercel deployment `dpl_7WrC7MCJWQnFkWffx3Xbz3Vi1YDb` dosáhl `READY` pro přesný
SHA `34369fd7`; hlavní alias vrací HTTP 200 a neautorizovaný POST na
`/api/tradovate/oauth/pilot-lease` správně vrací 401 `missing-auth-token`.
Error/fatal scan nového deploymentu je čistý a build skončil úspěšně. Jeden
starší `BadWebPushTopic` z cron route patří předchozímu deploymentu `c0277326`
a na novém deploymentu ani po tomto rolloutu nepřibyl.

### 2026-08-29 (Codex, viewport se srovná při každém ENTRY/EXIT snapshotu)
Ruční test demo notifikace odhalil, že hot-camera předpokládala viewport
připravený posledním 30s health cyklem. Když uživatel mezitím graf posunul nebo
změnil zoom, demo i ostrý ENTRY/EXIT capture vyfotily tento ruční stav. Lokální
oprava proto v jediném CDP evaluate před každým snímkem vyžaduje jeden panel,
`chartReset`, dynamický bar spacing a 28% pravý offset. Symbol ani timeframe se
nemění, TradingView kresby a synchronizovaný position box zůstávají zachované.
Po změně počtu panelů se nejprve čeká na reflow a šířka se počítá až z nového
panelu. Před focením se navíc kontroluje, že canvas už skutečně přepsal bitmapu
na plnou šířku; bez potvrzeného resetu, spacingu, offsetu, renderu nebo platných
bounds capture fail-closed vrátí `null` a server zachová textovou notifikaci.

Periodický health refresh nyní během capture nezačne druhý reset a po svém
síťovém probe znovu kontroluje, zda focení mezitím nezačalo. Fyzický test na
layoutu `AlphaTrade Snapshoty` záměrně rozhodil viewport z bar spacing/offset
`10 / 38` na `40 / -130`; capture jej vrátil přesně na `10 / 38` za 165 ms.
Pět dalších reálných měření bylo 210/142/160/135/137 ms, všechna s validním
142667B PNG, tedy hluboko pod ostrým limitem 1,2 s. Prošlo 198 test souborů /
1 609 testů (lokální HTTP suite byla kvůli sandbox `listen EPERM` ověřena
samostatně), TypeScript, lint bez chyb, Vite/PWA build a Mac worker esbuild.
Změna je zatím pouze v lokálním release worktree: nebyla pushnutá, nasazená ani
nainstalovaná do běžícího workeru.

### 2026-08-29 (Codex, ruční end-to-end test TradingView snapshot notifikace)
V Nastavení je připravené tlačítko `Poslat test snapshotu TradingView`, které
funguje z webu i nativní appky. Autorizovaný endpoint vybere pouze čerstvý DEMO
Mac worker se snapshot health `ready`, ověří aktivní nativní APNs token a přes
stávající durable command relay pošle nový typ `snapshot-test`. Command pouze
naplánuje fire-and-forget observability práci a okamžitě uvolní relay; nevolá
ARM, DISARM, reconciliation, Flatten ani žádnou brokerovou metodu.

Worker vyfotí vyhrazený layout `AlphaTrade Snapshoty` stejnou hot-camera cestou
jako ENTRY/EXIT a nahraje validované PNG pod jedinečnou privátní Storage cestu.
Server pošle mutable APNs v obecné testovací kategorii. Nevzniká copier event,
trade episode ani `copier_trade_snapshots`/journal řádek; starší testovací PNG
stejného workeru se best-effort uklidí. Test je omezen na jeden za 30 sekund a
upload dál sdílí globální snapshot rate limit. Device upload je přijat jen jako
pokračování čerstvého JWT-autorizovaného `snapshot-test` commandu.

Lokálně prošlo 198 test souborů / 1 608 testů, TypeScript, scoped ESLint
(0 chyb), produkční Vite/PWA build a Mac worker esbuild. Po výslovném souhlasu
proběhl produkční rollout v pořadí databáze -> worker -> server: migrace
`20260829050558_allow_copier_snapshot_test_command.sql` byla transakčně
aplikovaná a ověřená podle constraintu i migrační historie; Mac worker ze
stejného release stromu byl přeinstalovaný a zůstal DISARMED, připojený, flat,
bez pracovních příkazů, divergence, stuck outboxu a chyby. Snapshot health je
`ready` pro layout `AlphaTrade Snapshoty`. GitHub/Vercel push následoval až
jako poslední krok, bez ARM, Flatten nebo jiné brokerové akce.

### 2026-08-29 (Codex, bezpečný rollout hot-camera — nejdřív Mac worker)
Po výslovném souhlasu uživatele proběhla před produkčním pushem serveru
reinstalace Mac workeru z izolovaného release stromu. SHA-256 nainstalovaného
`copier-agent.mjs` přesně odpovídá ověřenému release bundlu. Restart zachoval
stejného leadera a všech šest followerů včetně multiplikátoru 2×; runtime je
DISARMED, připojený, plochý, bez working orders, divergence, kill switch,
stuck outboxu a `lastError`. Snapshot health je `ready`: CDP odpovídá a layout
`AlphaTrade Snapshoty` byl nalezen. `reconciliationRequired` je po restartu
očekávaně aktivní a další skutečné ověření patří až do řízeného DEMO testu.

Nativní Capacitor sync v čistém release prošel, ale nový bundle zatím nebyl
fyzicky nainstalován: iPhone byl nedostupný a generický unsigned Xcode build
skončil pouze na zaplněném disku (`No space left on device`). Lock-screen /
background obrázková APNs cesta používá už existující Notification Service
Extension; přesné potlačení paralelní lokální ENTRY/EXIT notifikace v popředí
vyžaduje pozdější instalaci nového nativního bundlu.

### 2026-08-28 (Codex, ENTRY/EXIT hot-camera a jediná notifikace už s obrázkem)
Vyhrazený TradingView layout `AlphaTrade Snapshoty` se nyní připravuje předem
a periodicky na pozadí: jeden panel, `chartReset`, dynamická hustota svíček,
28 % prostoru vpravo a skrytá plovoucí lišta. Při samotném ENTRY/EXIT už worker
viewport nemění; pouze probudí lifecycle karty, počká na dva paint framy a
pořídí oříznutý PNG v měřítku 1×. Pět read-only měření nad živým layoutem bez
uploadu trvalo 136–199 ms (průměr 162 ms, přibližně 148 kB) proti původnímu
průměru 1 252 ms a přibližně 545 kB.

ENTRY/EXIT textový APNs se při zdravé snapshot pipeline nově na krátkou dobu
odloží. Obrázková větev má absolutní deadline 1,5 s; pokud APNs obrázek přijme,
atomicky posune společný copy-event marker a textový duplikát už nevznikne.
Pokud capture, Storage nebo APNs deadline nestihne, worker v 1,8 s vyvolá
stejným plannerem jedinou textovou zálohu. Server po deadline nový obrázkový
push nezačne a broker dispatch/eventTail na žádnou z těchto větví nečeká.
Zabalená nativní appka už pro ENTRY/EXIT nevyrábí paralelní lokální textovou
notifikaci; ostatní order/risk eventy zůstávají beze změny.

Součástí stejného release je stabilní vazba `copierEpisodeId`, která doplní
pozdě nahraný ENTRY/EXIT obrázek k existujícímu journal masteru bez duplikace
a bez přepsání reflexe. Worker umí TradingView bezpečně spustit s lokálním CDP,
znovu najít layout podle stabilního `chartId` a do LIVE statusu publikuje
zdraví snapshot cesty. Nevznikla žádná migrace ani změna RLS/bucketu.

Izolovaný release nad čistým `origin/main` prošel 196 test soubory / 1 594
testy (první sandboxový běh selhal pouze na zákazu `listen 127.0.0.1`, opakovaný
běh mimo síťový sandbox je celý zelený), TypeScriptem po instalaci samostatného
extension lockfile, produkčním Vite/PWA buildem, samostatným esbuild bundlem
Mac workeru a `git diff --check`. Cílený ESLint má 0 chyb a jen dva existující
warningy ve `storageService`.

### 2026-08-27 (Codex, falešný FAIL-CLOSED po pravidelném socket reconnectu)
V `13:09:14Z` pravidelná obnova Tradovate socketu znovu přehrála dvě staré
terminální objednávky `625378672326` a `625378701959`. Worker zůstal
DISARMED, všechny účty byly flat, bez pracovních příkazů, divergence nebo
stuck operace, ale order-stream quantity guard porovnal historický total
`11` s durable asserted maximem `6` ještě před kontrolou statusu. Starý
`filled` order proto znovu otevřel falešný fail-closed incident a watchdog ho
později doručil jako copier alert.

Detektor cizího navýšení teď běží jen pro `isOpenOrderStatus`, tedy
`working/pending`. `filled/canceled/rejected` historie už po reconnectu nový
incident neotevře; skutečný dopad terminálního fillu dál hlídá fill/position
větev a autoritativní reconciliation. Přesná regrese simuluje durable OSO
link, socket reconnect a oversized `filled` replay bez poplachu, poté v
odděleném runtime dokazuje, že stejná odchylka ve `working` stavu pořád
fail-closed odzbrojí skupinu a spustí risk-redukční cancel.

Ověření: cílených 131/131 safety testů, kompletních 1563/1563 testů,
TypeScript, globální lint bez errorů, produkční Vite build a `git diff
--check`. Během diagnostiky ani testů neproběhl ARM, Flatten ani brokerový
příkaz; produkční worker zůstal DISARMED/flat.

### 2026-08-27 (Codex, úplný post-incident audit — serverless ESM a pending-order gate)
Produkční runtime audit našel 65 odpovědí HTTP 500 v hodinovém okně: 59×
`/api/cron/send-alerts` a 6× `/api/native-widget-snapshot`. Oba endpointy
padaly ještě před handlerem, protože TypeScript ve Vercel funkci zachoval
extensionless ESM import z `lib/tradovateLivePnl.ts`; Node 24 pak nenašel
existující `tradovateOrderReadModel.js`. Stejná chyba byla i v deploymentu
před SL/Flatten incident fixem, takže ji incidentní commit nezpůsobil.
Všechny serverless importy sdíleného modulu teď explicitně používají `.js` a
regresní test drží tento Node ESM packaging kontrakt. Lokální `vercel build`
po opravě vytvořil nula extensionless relativních importů a oba vzniklé
`tradovateLivePnl.js` moduly se v Node načetly.

Safety průchod oddělil dva významy order stavu. Zelený štít a SL coverage dál
vyžadují pouze přesný broker stav `Working`; `PendingNew`, `Suspended` ani
unknown se nikdy nevydávají za funkční ochranu. Pro vypnutí/přepnutí skupiny
je ale každý neterminální stav aktivní riziko, takže přechodný příkaz už UI
nepřehlédne. Audit znovu potvrdil, že Flatten účtu i skupiny obchází kill
switch a starý outbox, používá čerstvý stavový `liquidatePosition`, dočistí
aktivní ordery a úspěch vrací až po flat/no-active kontrole; ARM vyžaduje
autoritativní flat stav a bez pracovních/pending orderů.

Globální lint dřív chybně analyzoval vygenerované `.vercel/output`,
`dist-native` a nativní web bundle; ignore seznam je nyní úplný. Ověření:
194 souborů a 1562/1562 testů, cílených 223 copier safety testů, TypeScript,
globální lint bez errorů, produkční Vite build, lokální Vercel build a
`git diff --check` čisté. Během auditu neproběhl ARM, Flatten ani jiný
brokerový side effect; worker zůstal DISARMED.

### 2026-08-27 (Codex, fatal SL/Flatten incident — stavový emergency close a flat-first ARM)
Incident vznikl při partial fillu nativního Tradovate OSO: broker přechodně
měnil child SL/TP `11 → 6 → 11`. Runtime přechodný `Suspended/PendingNew`
stav vydával za běžný `Working` replace, zkopíroval leader child quantity 6
na followery a durable ji uložil. Když venue správně obnovilo follower SL na
skutečnou expozici 11, detekce to mylně označila za cizí navýšení a na dvou
účtech zrušila správný SL. Dvě rozletěné `unknown` modify položky následně
zablokovaly ruční Flatten i auto-close. UI správně ukázalo chybějící SL a
umožnilo incident včas odhalit.

Nativní OSO child quantity se už nikdy nekopíruje z leaderovy přechodné
hodnoty; price move zachová follower quantity a autoritou pro coverage je
přesná brokerová follower pozice. `PendingNew`/`Suspended` nezakládá replace,
ale zůstává aktivní pro ARM, exposure cap, cancel a Flatten. Venue návrat SL
na přesnou pozici durable opraví link a waivne překonaný nejasný modify bez
zrušení ochrany. LIVE UI vyžaduje přesné krytí: 6/11 i 12/11 zobrazí výrazný
`SL x/y` alarm a štít se ukáže jen při přesném SL i TP.

Ruční Flatten účtu i skupiny nyní nejdřív používá stavový Tradovate
`liquidatePosition` nad čerstvou venue pozicí, potom dočistí všechny zbývající
aktivní příkazy a úspěch hlásí teprve po autoritativním potvrzení flat + bez
aktivních orderů. Starý `unknown` outbox, kill switch ani shozená WebSocket
brána už nezablokují samotný REST pokus; skutečný broker/REST výpadek se dál
poctivě vrátí jako neúspěch. Běžný live ARM nově vyžaduje všechny zapojené
účty autoritativně flat a nikdy neadoptuje ani nedorovnává už otevřený obchod.
Po reconnectu se synchronní otevřené pozice pouze drží DISARMED; ani dříve
spravovaná epizoda nedostane výjimku a ARM je blokovaný až do skutečného flat.

Ověření: 194 souborů a 1560/1560 testů, `npx tsc --noEmit`, produkční build a
`git diff --check` čisté. Implementační commit `de93fd3a` je na `origin/main`;
produkční deployment `dpl_4Rw8gXDhLCq3JTQ2gQ4p3iTd3DfP` je `READY`, hlavní
alias vrací HTTP 200, správný commit a neautorizovaný lease POST je odmítnut
401. Mac worker byl ze stejného stromu reinstalován, po restartu zůstal
DISARMED a autoritativní reconciliation byla čistá.

Externí gate proběhl pouze v Tradovate DEMO: read-only preflight, broker dry-run
bez objednávky, krátký SHADOW a jeden minimální 1× MNQ vstup na účtu
`62364057`. Nový workerový `flatten-account` operace
`demo-emergency-7ca2f004-84e2-4266-a6b2-374d438e6ccc` odeslal právě jednu
nativní closure a potvrdil `flat: true`, `remainingPositionAccounts=[]`,
`workingOrderAccounts=[]`. Následná nezávislá kontrola i preflighty obou OAuth
spojení potvrdily všech sedm účtů `positions=0`, bez working/pending orderů a
worker nadále DISARMED. Přesný venue přechod `6 → 11` zůstal záměrně
deterministickým incidentním testem; na broker se kvůli němu neposílalo 11
kontraktů.

### 2026-08-27 (Codex, čisté ZAPNOUT/VYPNOUT už nevyžaduje potvrzení)
Běžné zapnutí flat a validní skupiny i běžné vypnutí flat skupiny nyní běží
rovnou na jedno kliknutí bez potvrzovacího dialogu. Bezpečnostní kontroly se
nemění: otevřená pozice, pracovní entry/SL/TP, neplatná konfigurace,
nedostupný runtime nebo odmítnutý autoritativní preflight zobrazí blokovací
dialog s konkrétním důvodem a bez automatického Flatten či dalšího brokerového
příkazu. Úspěšný výsledek zůstává viditelný jako stavový toast; chybu runtime
nelze zaměnit za úspěch. Cílené LIVE testy: 27/27.
Celkové lokální ověření: 193 souborů a 1546/1546 testů, TypeScript,
produkční build a `git diff --check` čisté. Uživatel následně výslovně schválil
produkční push. Implementační commit `c6b2ed4e` je na `origin/main` a Vercel
production deployment `dpl_4rj1bSnEzRsrT8sYFV2tkL6z7rYP` je `READY`; build
log potvrzuje commit `c6b2ed4` a hlavní alias vrací HTTP 200. Během rollout
ověření neproběhl ARM, Flatten ani jiný brokerový side effect.

### 2026-08-27 (Codex, BREACHED se už neztratí po zmizení účtu z OAuth)
Účet `62364058` byl durable označený jako `BREACHED`, ale po zmizení z
aktuálního Tradovate OAuth snapshotu UI jeho závažnější stav přebilo obecným
`Nedostupný účet`. Read-model nyní dává durable `DLL`/`BREACHED`/`nelze
ověřit` přednost před dostupností spojení, takže řádek i souhrn skupiny dál
ukazují skutečný risk stav a nepřidávají k němu zavádějící druhý čip
`nedostupný`.

Skupinu lze nově bezpečně uložit po odebrání followera, který už není v OAuth,
pokud jeho durable eligibility prokazatelně není aktivní. Leader a každý
neznámý nebo aktivní chybějící účet zůstávají fail-closed povinné. Cílené
`Ověřit` používá nový read-only relay příkaz `verify-account-eligibility`;
stav se vrátí na aktivní až po úspěšném ověření přesného OAuth routingu,
capability, pozic a working příkazů. Supabase CHECK migrace byla aplikovaná do
projektu `kopinlpdvjfgmvxydohk`.

Během rollout kontroly se ukázala ještě startup mezera: uložená skupina se
známým BREACHED followerem mimo OAuth shodila Mac worker dřív, než načetl
durable eligibility, a UI ho proto nemohlo odebrat. Startup nyní povolí pouze
takového známého neaktivního followera, načte stejný durable snapshot a
nastartuje DISARMED; chybějící leader nebo účet bez prokázaného neaktivního
stavu stále start zablokuje. Opravy jsou v commitech `f40bb9f3` a `89a8a4aa`,
`origin/main` je shodný a Vercel production pro `89a8a4aa` je `READY`
(`alphatrade-mentor-15-dx2vgrkng-krejcus-projects.vercel.app`). Ověření:
192 souborů, 1542/1542 testů, TypeScript, produkční build a `git diff --check`
čisté. Mac worker byl reinstalován z canonical checkoutu; běží připojený,
`armed=false`, `groupFlat=true`, bez working orders a stuck outboxu. Během
opravy, migrace a deploye neproběhl ARM, Flatten ani brokerový side effect.

### 2026-08-26 (Codex, skupiny se přepínají jedním bezpečným ZAPNOUT/VYPNOUT)
LIVE už nerozlišuje uložený profil a skutečně běžící copier matoucím
`ULOŽENÁ`/`ON`/`OFF`. Každý řádek nyní ukazuje pouze autoritativní runtime
stav `ZAPNUTÁ` nebo `VYPNUTÁ`; právě ARMED skupina je vždy první. Kliknutí na
čistou vypnutou skupinu provede po jednom výslovném potvrzení jediný atomický
tok: DISARM současné epochy, read-only preflight sjednocení staré a nové
topologie, aktivaci cílové skupiny, reconciliation a teprve potom ARM LIVE.
Worker tím přepíná i překrývající se profily bez restartu a bez mezistavu,
kdy by byly aktivní dvě skupiny.

Přepnutí ani obyčejný DISARM se nesmí stát skrytým riskem. Klient blokuje
akci, pokud současná nebo cílová skupina ukazuje otevřenou pozici či jakýkoli
working entry/SL/TP, a nic neodesílá. Nezávislá autoritativní brána ve workeru
znovu ověří obě topologie proti brokerovi; pozice, working příkaz nebo
nečitelný lookup nechají runtime DISARMED. Automatické `Flatten + switch +
ARM` nebylo přidáno: destruktivní brokerová akce zůstává samostatné výslovné
`Flatten All`, po kterém musí uživatel ověřit flat stav a zapnutí zopakovat.

Regrese ověřují české stavy přepínače, dva vypnuté překrývající se profily,
ZAPNUTOU skupinu seřazenou nahoře, úspěšné pořadí `DISARM -> activate-group
preflight -> reconcile -> ARM` i fail-closed selhání preflightu bez ARM.
Ověření: plná sada 192 souborů a 1530/1530 testů, TypeScript, produkční build a
`git diff --check` čisté. Lokální preview vizuálně potvrdilo `VYPNUTÁ` a
čekající entry pill. Implementační commit `55f020cc` byl po explicitním
souhlasu pushnut na `origin/main`; Vercel production deployment
`dpl_7g2gw7EidsohCYEAKtTXQuWhQmqj` je `READY`, build log potvrzuje commit
`55f020c` a hlavní alias vrací HTTP 200. Mac worker byl z téhož canonical
checkoutu přeinstalován, nastartoval `DISARMED` a závěrečná read-only
reconciliation potvrdila `connected=true`, `groupFlat=true`, žádné divergentní
účty ani working orders. Během rollout kontroly neproběhl ARM, Flatten ani jiný
broker side effect.

### 2026-08-26 (Codex, LIVE DLL je nově execution brána, ne jen badge)
Účet `LFE05066846490016` měl v čerstvém LIVE snapshotu denní P&L
`-1 206,50 USD`, ale skupina ho stále vykazovala jako aktivní. Příčina byla
mezi dvěma read-modely: detail účtu znal brokerové `dailyLossAutoLiq`, zatímco
group eligibility používala pouze ručně uložený profil. Navíc webový ARM
posílal workeru celou skupinu a odvozený DLL stav používal jen pro vzhled a
klientskou kontrolu; nebyl durable execution vstupem.

Lokální oprava přenáší broker/profile DLL do společného LIVE snapshotu a před
ARM i SHADOW posílá explicitní safety exclusions (`dll-locked`/`breached`)
přes validovaný relay protokol. Mac agent je aplikuje durable ještě před
reconciliation a runtime je kontroluje ve všech stávajících dispatch cestách.
Tato cesta umí účet pouze vyřadit nebo zpřísnit; nikdy neaktivuje účet a DLL
nesmí zeslabit `unverifiable` ani `breached`. Po začátku nové session zůstává
stávající fail-closed reaktivace přes autoritativní reconciliaci.

Regrese dokazují broker DLL inference bez profilu, badge/souhrn ve skupině,
neztracený web → relay → worker payload, validaci proti odemknutí a skutečné
vynechání DLL followera při dalších vstupech. Ověření: cíleně 56/56, plná sada
192 souborů a 1528/1528 testů, TypeScript, produkční build, ESLint změněných
souborů a `git diff --check` čisté. Změna zatím není commitnutá, pushnutá,
nasazená ani nainstalovaná do Mac workeru; během práce neproběhl broker side
effect ani ARM.

### 2026-08-26 (Codex, uložené skupiny už nefalšují aktivní účty)
LIVE UI dříve počítalo eligibility pouze z právě dostupného Mac workeru.
Když worker/relay nebyl dosažitelný nebo se zobrazovala jiná uložená skupina,
prázdný stav se chybně změnil na `active` a skupina například ukazovala
`7/7 aktivních`, přestože jeden účet byl za DLL a druhý pod drawdown floorem.
Read-model nyní konzervativně slučuje durable runtime klasifikaci s LIVE
snapshotem: rezerva `<= 0` znamená `BREACHED`, denní P&L pod explicitně
nastaveným DLL znamená `DLL · do konce session`; inference smí stav pouze
doplnit nebo zpřísnit. Brokerové side effecty ani ARM logika se nemění.
Regrese ověřuje souhrn `0/2 aktivních`, oba badge i důvody v řádcích; celkem
1521 testů, TypeScript, produkční build a `git diff --check` jsou čisté.

### 2026-08-26 (Codex, flat cleanup už nerozhoduje podle délky historie)
Read-only forenzika posledního uživatelova DEMO obchodu potvrdila, že kopírování
i opakované posuny ochrany fungovaly správně: od `14:47:20Z` do `15:10:59Z`
worker zapsal 85 potvrzených follower `modified` výsledků, tedy 17 kompletních
fan-outů na všech pět účtů bez rejectu. Chyba nastala až při ukončení pozic.
Na čtyřech followerech se po úspěšném cleanupu objevilo přesně
`Flat sweep nedokončen (0 selhání, 6 odloženo)` a session následně přešla do
DISARMED. Všechna skutečná zrušení přitom proběhla; starý kód ale považoval
každou ochrannou nohu z celé durable historie za aktuální cancel kandidát a
samotné překročení dávkového limitu šesti noh vyhodnotil jako incident.

Lokální oprava vybírá cancel kandidáty podle aktuální broker reality, ne podle
délky historie. Při známém protective fillu pracuje jen s přesnou bracket/OSO
epizodou; bez této kauzality načte autoritativní working snapshot a vezme pouze
skutečně pracovní ID. Po cleanupu vždy znovu ověří `flat + zero working
protective legs`. Teprve nečitelný broker, nezrušená pracovní noha nebo
ne-flat pozice dál spouští fail-closed. Po prokázaném flat se pouze terminálně
označí odpovídající pending cancel/modify outbox položky; auditní historie se
nemaže.

Regrese reprodukuje dnešní stav s 12 terminálními historickými nohami nad
limitem a dokazuje, že nová živá epizoda po ochranném fillu zůstane ARMED.
Protiscénář ponechá skutečnou pracovní orphan nohu a potvrzuje DISARM +
`Flat sweep nedokončen`. Ověření: chaos sada 17/17, všech 25 copier testovacích
souborů 361/361 a `npx tsc --noEmit` čisté. Po následném explicitním souhlasu
uživatele byla oprava commitnuta jako `d67c2fd5` a nasazena do produkce jako
Vercel deployment `dpl_44aJNbLPyPBh8KoRjnLDaqE2eW4F` (`READY`, produkční
alias HTTP 200). Mac worker byl přeinstalován z totožného canonical commitu a
zůstal `DISARMED`/SHADOW; read-only reconciliation potvrdila `groupFlat: true`,
žádné divergentní účty, žádné working orders, žádný stuck outbox a žádný nový
`lastError`. Během deploye a kontroly nebyl odeslán žádný broker příkaz.

### 2026-08-26 (Codex, stale účet je opravitelný čistě z LIVE UI)
Read-only kontrola všech spárovaných OAuth `/account/list` potvrdila, že
uložený follower `63338592` není účet vracený Tradovate. Lucid OAuth vrací
aktivní účet `63338752` (`LFE05066846490016`). Dynamický router proto správně
selhal nahlas: odstranění statického `connections.json` routingu nemůže udělat
z neplatného účtu platný a AlphaTrade nesmí podobné ID automaticky zaměnit.

LIVE UI nyní takového člena neskrývá ani nepočítá jako aktivního. Skupina
ukáže čip `nedostupný`, řádek explicitní stav a důvod a editor nabídne ruční
volbu přesné náhrady z aktuálního OAuth snapshotu nebo odebrání. Při náhradě
se zachová režim replikace, násobek i `maxContracts`. Nedostupný bývalý leader
se při volbě nového leadera už nepřenese mezi followery. Aktivace skupiny i
ARM jsou v UI fail-closed blokované, dokud validace proti aktuálním účtům
neprojde; stejnou kontrolu nezávisle zopakuje worker před side effectem.

Nic se nepáruje automaticky a tento krok neposlal žádný broker příkaz. Změna
je nasazená v produkci v commitu `d7c206a2`: `origin/main` je shodný, Vercel
deployment `dpl_5o3Cvg6ZSNZ197hV47ezoxhzJ7io` je READY a Mac worker byl ze
stejného canonical checkoutu bezpečně reinstalován DISARMED. Ověření:
kompletní sada 1515/1515, `npx tsc --noEmit`, `git diff --check` a produkční
build čisté (pouze existující upozornění na velikost bundlu). Canonical Vite
preview navíc s dočasnou stale fixture vizuálně potvrdil čip `1× nedostupný`,
explicitní řádek i ruční náhradu v editoru; po volbě náhrady staré ID a
varování zmizely při zachování počtu followerů a bez error overlay. Fixture
byla po ověření odstraněna.

### 2026-08-26 (Codex, dynamický account -> OAuth routing z LIVE UI)
Lokálně je dokončený dynamický account -> OAuth routing, který odstraňuje
nutnost ručně dopisovat platné nově zjištěné účty do connection manifestu.
Pozdější read-only kontrola upřesnila, že konkrétní `63338592` je stale ID;
jeho oprava je popsaná v novějším zápisu výše. `accountIds` v Mac connection manifestu už nejsou autoritou
pro vlastnictví účtu; slouží pouze jako instalační/bootstrap metadata. Worker
si při startu, změně topologie skupiny, aktivaci uloženého profilu, SHADOW i
před každým ARM znovu read-only načte `/account/list` ze všech už spárovaných
OAuth spojení. Z přesné viditelnosti účtu sestaví account -> OAuth mapu a
přepne ji atomicky bez restartu socketů a bez broker order side effectu.

Nové Account.name se stejným refreshem doplní přímo do Tradovate brokeru, takže
nově detekovaný účet lze následně použít pro execution bez ruční editace
`connections.json` a bez reinstallu workeru. Při chybějícím, duplicitně
viditelném, neaktivním nebo read-only účtu se změna odmítne nahlas, původní
routing zůstane beze změny a runtime zůstane DISARMED. Změna followerů i
leadera jde přes DISARM -> refresh routing -> reconfigure/activate preflight;
ARM jde přes DISARM -> refresh routing -> reconciliation -> ARM. Uložená UI
skupina je po restartu autoritativní i tehdy, když původní instalační
leader/follower už není aktivní.

Rozsah je záměrně omezen na účty viditelné v už spárovaných OAuth spojeních.
Přidání úplně nového OAuth spojení stále vyžaduje jeho bezpečné device pairing;
samotné přidání účtu nebo změna skupiny v rámci existujících spojení už žádný
ruční manifest zásah nevyžaduje. Ověření: cílené router/runtime/Tradovate testy
75/75, kompletní sada 1512/1512, `npx tsc --noEmit` a produkční build čisté.
Změna byla commitnutá jako `b842640f` a spolu s navazující opravou stale členů
`d7c206a2` je pushnutá na `origin/main`, nasazená na Vercelu a nainstalovaná do
Mac workeru. Worker po reinstalaci zůstal bezpečně DISARMED.

### 2026-08-26 (Codex, řízený DEMO důkaz OSO parent cascade)
Commit `dfdc4d9e5cffe71a2ab3835deff5d980323dc6a5` byl ověřen na produkčním
Vercelu i Mac workeru a řízeným Tradovate DEMO testem leadera `62364553` se
čtyřmi záměrnými followery `62364057`, `62364060`, `62364059`, `62364055`.
Pátý dřívější follower `62364058` uživatel úmyslně odebral a test jej správně
nezasáhl.

Shadow fáze rozpoznala nativní OSO vytvoření, změnu parentu i tři cancel větve
v přesném fan-outu 4 účtů bez broker side effectu. V následném live DEMO byl
leader Buy Limit 1 MNQU6 @ 29126 se SL 29110,5 a TP 29136,5 zkopírován na
všechny čtyři followery se správnými parent/OCO vazbami. Změna leader parentu
na 29123 vytvořila přesně 12 autoritativně potvrzených modify výsledků:
4 parent modify, 4 absolutní SL reassert a 4 absolutní TP reassert. Read-only
broker kontrola potvrdila na všech followerech parent 29123, SL 29110,5 a
TP 29136,5; žádná ochrana se relativně neposunula.

Zrušení celého leader bracketu vytvořilo přesně 12 potvrzených follower cancel
výsledků (parent, SL, TP × 4). Následná broker kontrola před i po read-only
reconciliation potvrdila na leaderovi i všech followerech nulové pozice a
nulové working příkazy. Runtime skončil `DISARMED`, připojený, bez divergence,
bez `reconciliationRequired`, bez stuck outboxu/operace a bez `lastError`.
Reconciliation vrátila `ok: true` a žádný broker příkaz neodeslala. Tento test
prokazuje opravu konkrétního nativního OSO parent-modify incidentu; není důkazem
všech možných partial-fill a venue race scénářů.

### 2026-08-26 (Codex, TradingView OSO child bez parentId)
Řízený DEMO test změny čekajícího nativního OSO parentu zablokoval všech pět
followerů před prvním side effectem s chybou `stop není child očekávaného
parentu`. Read-only forenzika přes raw Tradovate `/order/item`, orderVersion,
command report i execution report potvrdila, že leader bracket vytvořený přes
TradingView nemá na stopu ani targetu `parentId`; nejde o chybu našeho mapperu.
Follower brackety vytvořené copierem explicitní parent/OCO vazby mají.

Validátor teď nepovažuje chybějící parent metadata za rozpor, protože bracket
už bezpečně kotví durable mapping přes přesná leader entry/stop/target order
ID. Všechny ostatní autoritativní kontroly zůstaly povinné: exact order ID,
leader účet, kontrakt, opačná strana, working stav, množství/fill, typ a cena.
Pokud broker `parentOrderId` poskytne a liší se od očekávaného entry orderu,
cesta dál fail-closed skončí před jakýmkoli follower modify.

Regrese pro skutečný TradingView tvar bez `parentId` prochází celou sekvencí
parent modify -> absolutní SL reassert -> absolutní TP reassert; sesterská
regrese s explicitně cizím parentem ověřuje nulový broker side effect a
neposunutou leader sekvenci. Ověření: cílený `copierRunner` 68/68, širší
incidentní/recovery sada 98/98, celé repo 190 test files a 1504/1504 testů,
TypeScript typecheck, produkční build i `git diff --check` čisté. Změna je jen
lokální: nebyla commitnuta, pushnuta, deploynuta ani instalována do Mac workeru;
runtime zůstává DISARMED. Záměrné odebrání jednoho followera uživatelem není
součást incidentu ani chyba konfigurace.

### 2026-08-26 (Codex, absolutní SL/TP po změně nativního OSO parentu)
Read-only broker forenzika potvrdila, že Tradovate po změně ceny nativního OSO
parentu automaticky relativně posunul child ochrany followerů: parent ceny se
shodovaly s leaderem, ale všech pět follower SL i TP skončilo o bod výš.
Původní lifecycle měnil pouze parent, takže UI sice hlásilo potvrzený modify,
ale ochranné ceny už nebyly absolutní kopií leadera.

Oprava je záměrně omezena jen na potvrzený OSO-parent replace. Před prvním
follower side effectem načte přes exact order IDs autoritativní leader SL a TP;
bez úplných dat se nepohne parent ani ochrany. Každý follower potom prochází
durable sekvencí parent modify -> autoritativní potvrzení -> absolutní SL
reassert -> potvrzení -> absolutní TP reassert -> potvrzení. Followeři mohou
běžet souběžně, ale kroky jednoho účtu se nikdy nepředběhnou. První nejasnost
nebo chyba ponechá pozdější kroky `planned`, neposílá blind retry, neposune
leader sequence a stuck outbox dál blokuje nový ARM.

Každý durable follower link nativního OSO nově explicitně nese roli
`entry | stop | target`. Parent replace proto nelze zaměnit za přímý posun
SL/TP jen podle společného textového prefixu `oso:`. Starší snapshot bez role
se rozliší přes přesná leader/follower child ID v durable OSO outboxu; při
poškozeném snapshotu bez bezpečného důkazu se cesta fail-closed zablokuje.
Přímý SL/TP modify dál používá obecnou lifecycle cestu a po autoritativním
potvrzení se do follower linku zapíše nejen množství, ale i nová cena.

Pokud není úplný OSO mapping pro každý follower nebo nejsou autoritativní
leader child data, nevznikne žádný follower side effect: vrátí se kritický
`blocked` audit, runtime se fail-closed odzbrojí a vyžádá novou reconciliation.
Smíšená situace, kdy by se parent posunul jen části followerů s opravenou
ochranou, je samostatně zakázaná. Mapping se vybírá přes exact klíč aktuální
skupiny (`group + leader entry + follower`), takže stará durable vazba z jiné
skupiny nemůže přesměrovat modify na cizí child order IDs. Duplicitní follower
modify je rovněž fail-closed. OSO původ se navíc pozná i z durable follower
linku: pokud se poškodí snapshot a zmizí úplně všechny OSO mapping položky,
parent nespadne do obecné parent-only cesty, ale zablokuje se před brokerem.

Ve staged cestě je `working` skutečný precondition další vrstvy: parent, který
byl po modify zrušen, nepustí reassert SL a zrušený SL nepustí target. Pokud
proces spadne po zahájení předchozí vrstvy, zbývající durable `planned` kroky
se nově počítají jako stuck operace a blokují ARM až do reconciliation; nikdy
nezahájená čistě planned sada broker nejistotu nevytváří.

Mock broker nově umí simulovat venue-side relativní child reprice a oba druhy
modify timeoutu. Regrese pokrývají přesný návrat SL/TP na leader ceny, zastavení
targetu po chybě stop korekce, izolaci chyby jednoho followera, úplnost OSO
mapování, ignorování staré vazby jiné skupiny, zrušený staged parent,
restart/ARM bránu a nulový follower side effect bez autoritativních leader child
dat. Ověření: cílená copier sada 138/138, celý repo 190 test files a 1503/1503
testů, TypeScript typecheck, produkční build, lint změněných copier souborů i
`git diff --check` čisté. Celorepový lint zůstává neplatná brána kvůli tisícům
starých chyb ve vygenerovaných `capacitor-ios/.../assets` a `dist-native`
bundlech mimo tuto změnu. Oprava byla commitnuta jako `8a252f1f`, pushnuta na
`origin/main` a produkční Vercel deployment
`dpl_HxBTaZ8EAwr32oma3UDntmKf6d6v` je `READY`; build log potvrzuje branch
`main` a commit `8a252f1`. Mac worker byl ze stejného canonical repa
reinstalován a read-only reconciliation potvrdila připojení, flat skupinu,
nulové working příkazy, nulovou divergenci i nulový stuck outbox. Runtime
zůstal `DISARMED`; před dalším ostrým ARM zbývá řízený DEMO test.

### 2026-08-26 (Codex, překrývající se profily + jediná execution skupina)
Uživatel může uložit více kopírovacích skupin se stejným leaderem, followery i
účty; užitečné jsou jako pojmenované varianty násobků a safety pravidel. Účet
už proto není globálně rezervovaný jednou uloženou skupinou. Execution runtime
ale smí mít vybranou nejvýše jednu skupinu: explicitní `activate-group` nejprve
DISARMuje, v jedné serializované operaci autoritativně ověří starou i novou
topologii jako flat a bez working příkazů, založí novou durable epochu a po
úspěchu zůstane DISARMED s povinnou novou reconciliation. Samotné přepnutí
profilu nikdy automaticky neARMuje ani neposílá broker příkaz.

Identita skupiny je založená na stabilním `group.id`; shodná topologie se bez
ID adoptuje jen při jediném jednoznačném kandidátovi. ARM příkaz pro jinou
skupinu musí nejdřív projít bezpečnou aktivací a relay podporuje nový typ
`activate-group` včetně databázového CHECK rozšíření. UI rozlišuje profil
vybraný runtime slotem od skutečně `enabled` skupiny, takže aktivních může být
nula nebo jedna a vypnutý profil ani při prvním renderu krátce nesvítí jako
aktivní. Ostatní profily zůstávají pouze „Uložená“ a jejich editace nemění
běžící runtime.

Regrese pokrývají překryv účtů, duplicitní topologii, stabilní ID, relay
round-trip, bezpečný preflight a novou epochu, zákaz side-switch přes ARM,
zachování DISARMED i první UI render. Ověření: 190 test files, 1489/1489 testů,
115/115 cílených testů, TypeScript typecheck, scoped ESLint, produkční build a
`git diff --check` čisté (build má pouze existující upozornění na velké chunky).
Změny jsou pouze lokální: nebyly commitnuté, pushnuté, migrované, deploynuté
ani instalované do workeru.

### 2026-08-25 (Codex, durable eligibility + jeden účet právě v jedné skupině)
Account eligibility už není pouze procesová `Map`: ukládá se do existujícího
durable safety snapshotu a po restartu se obnoví včetně DLL/BREACHED,
session-end a posledního execution výsledku. Reject klasifikace zahrnuje i
leadera; leader s DLL/BREACH nesmí být ARMován. LIVE ARM bez jediného
způsobilého followera nyní selže nahlas, zatímco shadow zůstává dostupný.
Connection status a eligibility jsou v UI samostatné vrstvy — odpojení už
neskryje silnější DLL/BREACHED stav ani neztlumí celý řádek.

Zavedeno výhradní globální členství `accountId`: leader i follower smí patřit
právě do jedné kopírovací skupiny, včetně skupin momentálně disabled. Editor
už obsazený účet označí názvem skupiny a nedovolí jej vybrat; stejný invariant
znovu vynucuje doménová validace při uložení, ARM preflight a runtime resolver.
Starší nebo ručně poškozená konfigurace s duplicitou proto fail-closed —
nemůže způsobit dvojité kopírování.

Regrese kryjí restart s DLL stavem, reject leadera, nulovou LIVE účast,
oddělení disconnected/eligibility, kolize skupin i fail-closed runtime.
Ověření: 190 test files, 1482/1482 testů, TypeScript typecheck a produkční
build čisté; scoped ESLint změněných souborů bez chyb (jedno starší hook
warning v `TradovateLiveDesk`). Globální lint nadále nabírá generované
Capacitor/dist soubory a hlásí jejich existující chyby. Změny jsou pouze
lokální: nebyly commitnuté, pushnuté, deploynuté ani instalované do workeru.

### 2026-08-25 večer (Claude, account-eligibility systém + oprava execution sémantiky)
Incident TDFYG (DLL reject vykázaný jako dispatched/canceled) → nový
account-status systém. Eligibility je oddělená vrstva od connection
statusu, poslední execution události i členství ve skupině: enum
active | dll-locked | breached | unverifiable v copierRuntimeController
(recordFollowerRejection klasifikuje broker reject string konzervativně;
breach je sticky). Async Rejected event po REST acku přepisuje outbox:
vysvětlený reject (DLL/breach) se auto-waivne, aby stuck-outbox nezastavil
zdravé followery — nevysvětlený zůstává fail-closed pro celou skupinu.
Potvrzovací smyčka audituje kind podle resolved.outcome (rejected ≠
canceled). Risk gate má ineligibleAccounts (nový block reason
account-ineligible) ve všech třech cestách — vyřazení je vždy jen skip
s auditem, nikdy obchod. DLL se NIKDY neodemyká časem: po sessionEndAt
(fallback msUntilTradovateSessionEnd) jen zpřísní na unverifiable a
reaktivaci smí provést jedině autoritativní reconciliation po nové
session. Status vystavuje accountEligibility → UI: pill sloupec Status
(Aktivní/DLL/BREACHED/Odpojeno/Nelze ověřit), důvod pod jménem, hlavička
„Followeři X/Y aktivní“, ARM dialog jmenuje vyřazené a tlačítko říká
„ARM · N followerů“. Testy: 3 eligibility scénáře padají bez oprav
(incident 4+1, audit pravda, reaktivace jen ověřením) + 5 SSR render
testů pillu; celkem 1475/1475, tsc čistý. Nepushnuto, nenasazeno.

### 2026-08-25 (Codex, bezpečná změna leadera čistě z LIVE UI)
Změna leader účtu už nevyžaduje edit CLI argumentu, env ani reinstall workeru.
Existující `update-group` UI příkaz při změně leadera nově spustí samostatný
`reconfigureGroup`: okamžitě DISARMuje, zařadí změnu do stejné sériové fronty
jako broker eventy a vyžádá autoritativní preflight sjednocení staré i nové
topologie. Všechny účty musí být aktivní, obchodovatelné, flat a bez working
příkazů; broker reads mají 2,5s deadline a Tradovate adapterův rate-limit
breaker. Nejasný stav pouze odmítne změnu — neposílá žádný broker příkaz.

Po úspěšném preflightu se přes CAS založí čistá durable lifecycle epocha,
teprve potom se přepne leader, event source, dynamický critical OAuth route a
uložená skupina. Staré order/fill eventy všech účtů jsou průběžně baselinované,
takže nový leader po přepnutí nereplayuje historii. Příští ARM vždy vyžaduje
novou reconciliation. Když durable zápis konfigurace selže, runtime se bezpečně
vrátí na původní epochu; UI se aktualizuje jen po potvrzení execution runtime.

Regrese pokrývají změnu směru kopírování, working-order odmítnutí, persistence
rollback, stabilní group ID přes relay, all-account event baseline a dynamickou
critical connection. Původní incidenty venue qty=7, opožděný cancel i timeout
neznámé follower pozice bez auto-close zůstaly zelené. Ověření: cíleně 101/101,
incidentně 21/21, širší copier sada 389/389, celý repo 1464/1464, ESLint bez
chyb, typecheck a produkční build čisté. Nic nebylo pushnuto, deploynuto ani
reinstalováno; worker zůstává na dosavadní verzi a má zůstat DISARMED.

Lokální UI průchod navíc odhalil, že pouhý výběr jiného leadera původního
leadera tiše vyřadil ze skupiny. Editor nyní provede atomický role swap: nový
leader se odebere z followerů a původní leader převezme jeho replikační režim,
násobek i `maxContracts`; celková topologie tak při běžné výměně zůstane
zachovaná. UI výslovně popisuje, že se původní leader přesune mezi followery.
Regrese změny leadera a navazující runtime vrstvy prošly 95/95, TypeScript
typecheck je čistý a lokální browser průchod potvrdil 4/4 followerů po swapu.
Dialog byl zavřen bez uložení, takže nevznikl žádný broker side effect.

### 2026-08-25 (Codex, kauzální oprava falešného auto-flattenu followerů)
Forenzika runtime logu prokázala nový incident: nativní OSO vstupy qty 13 byly
na všech pět followerů přijaty, leader position event LONG 13 dorazil v
07:13:31.358Z, ale follower position event o ~130 ms později vyhodnotila stará
znaménková heuristika proti ještě neaktualizované leader cache jako
„neobjednanou pozici“. `failClosed` pak zrušil ochrany a auto-close zploštil
všech pět legitimních kopií; leader zůstal otevřený až do SL v 07:16:45Z.

Oprava už nerozhoduje podle existence libovolné historické ochranné nohy
stejného znaménka. Fill se klasifikuje pouze přes přesné broker `orderId` jako
náš copied-entry nebo protective leg. Follower position předbíhající fill či
leader event dostane 2s kauzální okno a potom autoritativní read-only
`listPositions` kontrolu. Stejný směr leader/follower je legitimní; přesně
prokázaný protective reversal dál fail-closed a auto-flattenuje. Neznámá
pozice bez prokazatelné příčiny pouze DISARMuje a eskaluje — bez neodůvodněného
market close. Guard kryje i přímý sign flip bez mezilehlého flat eventu a
časovače se čistí při flat/stopu.

Regrese kryjí: starou historickou ochranu vs. nový validní vstup, pořadí
position→fill, fill→position, ztracený fill s autoritativně shodným směrem,
neznámou příčinu bez auto-close, přesný protective reversal a přímý sign flip.
Copier runtime + chaos: 75/75; celý repo: 1456/1456; typecheck a produkční build
čisté. První souběžný full test měl tři časové flaky pády pod zátěží; všechny
tři prošly samostatně a celý full run následně prošel bez souběžného tsc.
Oprava je lokálně commitnutá jako `dbad27de`, ale nebyla pushnuta, nasazena ani
reinstalována; worker zůstává DISARMED. Souběžné rozpracované LIVE pill/SL
read-model změny byly zachovány.

### 2026-08-25 (Codex, čekající limit a přesné rozpoznání ochranného SL)
Tradovate mutable údaje příkazu nemusí spolehlivě vracet přímo v `/order/list`;
typ, množství a ceny jsou autoritativně v nejnovější `/orderVersion/list`.
Společný read model proto vybírá poslední verzi podle `orderId` a obohacuje jí
úplný snapshot i lehký LIVE P&L tick. Díky tomu se čekající Limit může vykreslit
jako pill i bez otevřené pozice a Stop/StopLimit se při otevřené pozici správně
pozná jako ochranný SL. Za aktivní se nově považuje pouze broker stav `Working`;
`Suspended`, neznámé a terminální stavy nesmějí v UI předstírat ochranu.
Cílené ověření: 37/37 testů; společně s incidentní opravou následně prošlo
1456/1456 testů, TypeScript typecheck a produkční build. Změna je lokálně
commitnutá spolu s tímto zápisem, ale nebyla pushnuta ani nasazena.

### 2026-08-25 (Codex, integrační debug chybějícího Positions pillu)
Hypotéza C se pro flat leader účet s numericky shodným account ID a working
Limitem nepotvrdila. Nový SSR integrační test renderuje celý
`LiveCopyTradeOverview`, projde `groupRows -> groupOrders -> AccountRow` a v
leaderově Positions buňce prokáže pending MNQ pill; příkaz jiného účtu se do ní
nepropíše.
Globální „Pozice a příkazy“ i copy-trade `orders` prop čtou tentýž
`live.data.accounts[*].orders`, používají stejnou klasifikaci working statusu a
refresh nahrazuje snapshot novým objektem. Positions má 260 px, jeho `td` nemá
overflow/truncate a jeden pill CSS nemůže oříznout do neviditelnosti.

Produkční kód se neměnil; zbývají klientská stará bundle/PWA nebo jiný pohled či
stav (zejména jiný account ID, terminální status, nepodporovaný order type,
stejný symbol jako otevřená pozice, sbalená skupina nebo skrytý/odscrollovaný
sloupec). Prošlo 5 souvisejících Vitest souborů / 27 testů, `npx tsc --noEmit`
a `git diff --check`. Nic nebylo commitnuto, pushnuto ani nasazeno.

### 2026-08-25 (Codex, LIVE copy-trading Positions pills)
Sloupec Positions v rozbalené Accounts tabulce už neukazuje pouhý počet.
Každá otevřená pozice má jednořádkový long/short pill se zkráceným futures
kořenem; chybějící working stop zvýrazní amber badge „bez SL“ a štít se ukáže
jen tehdy, když opačné working Stop/StopLimit i Limit příkazy na stejném plném
kontraktu množstevně pokrývají celou pozici. Working Limit/Stop na symbolu bez
otevřené pozice se zobrazí jako neutrální čekající entry s hodinami, takže vedle
sebe fungují i různé symboly. Vše vzniká pouze z existujících `rows` a `orders`;
žádný fetch, broker příkaz ani změna `services/`/`server/` nepřibyla.

Přímý GroupDetail snapshot v repu neexistoval, proto přibyl cílený SSR render
test buňky včetně long/short, úplné i částečné ochrany, split nohou, chybného
účtu/kontraktu/strany, flat entry a více symbolů. Prošlo 5 souvisejících Vitest
souborů / 22 testů, `npx tsc --noEmit` a `git diff --check`. Vizuální browser
kontrola s reálnými multi-symbol daty v této relaci neproběhla. Nic nebylo
commitnuto, pushnuto ani deploynuto.

### 2026-08-25 (Claude+Codex, rate limit breaker + tržní research kopírek)
Codex web research komerčních kopírek uložen v docs/COPIER_MARKET_RESEARCH.md.
Klíčové: Replikanto changelog 22.11.2024 opravoval přesně třídu našeho
incidentu (venue OCO snížení leader exitu po partial fillu) — potvrzuje
správnost dnešního preflightu; nikdo z komerčních nemá preventivní reversal
ochranu (TradeSyncer reaguje s 1,5–3 s delay), reduce-only na Tradovate
neexistuje, divergence se řeší alarmem+vypnutím (ne delta-tradem, shodné
s naší politikou). Nejtvrdší mezera u nás: Tradovate 429 = hodinové okno,
které KAŽDÝ další pokus restartuje, a p-ticket chodí i v HTTP 200. Adapter
p-ticket/429 detekoval, ale nikdo nectil retryAfterMs → přidán circuit
breaker přímo v tradovateBroker (fail-fast lokálně po celou penalizaci,
p-ticket blokuje jen p-time). Testy breakeru padají bez opravy; 1439/1439.

### 2026-08-25 (Claude, dvě vlny oprav po adversariální review obrany 24. 8.)
Codex review trojité obrany našla 14 děr (8 kritických). Vlna 1 — detekce:
`assertedFollowerQuantity` čte i rozletěné modify intence z cancelOutboxu
(vlastní navýšení už není „cizí zásah“) a potvrzený modify srovnává link
`updateFollowerLinkQuantity` (venue návrat po legitimním snížení je vidět);
modify preflight posílá intenci leadera, cíl ≤ filled ruší živý zbytek
příkazu; preflight odmítnutí má nový příznak `neverSent` — blokuje ARM, ale
už ne nouzový Flatten; stream detekce cizího navýšení sama ruší oversized
nohu i při nulové expozici; OSO nohy doplněny do protective-cancel
klasifikace; sweep i detektor otočení jsou symbolově izolované a znaménková
heuristika ignoruje prokazatelně zrušené nohy (filled zůstávají podezřelé).
Vlna 2 — robustnost: sweep má jediný inline pokus s 1,5s deadlinem
(jen mimo testy), cap 6 nohou proti restart bouři, audit podle skutečného
výsledku (filled/rejected/canceled), waive nahrazených modify a eskalaci
selhání do failClosed + auto-flatten; auto-close má mez 3 pokusů na epizodu
(reset úspěšným flat/ARM) proti ping-pongu; reconciliation doprovodí osiřelé
working nohy nad flat followerem (durable povinnost přes pád workeru);
Flatten recheckuje nejistý outbox uvnitř serializace. Nevyřešené a přiznané:
TOCTOU okno lookup→modify bez CAS na venue API (kryté stream detekcí),
prune durable outbox historie, deadliny mimo sweep. Ověření: 6 nových
regresí padá bez oprav a prochází s nimi, celkem 1437/1437, tsc čistý.

### 2026-08-25 (Codex, šest regresí copieru po review)
Přibyl samostatný testovací soubor se šesti deterministickými regresními
scénáři: vlastní rozletěné navýšení 5→6, potvrzený downsize 5→3 a venue návrat,
cancel živého zbytku při cíli ≤ filled, `neverSent` preflight vs. Flatten/ARM,
přímé zrušení oversized ochranné nohy při flat followerovi a symbolově
izolovaný MNQ/NQ sweep. Každý test míří na vlastní hunk aktuálního `services/`
diffu a bez něj by zčervenal; produkční kód se v této práci neměnil. Prošlo
6/6 nových testů, celé `copierChaosScenarios` 15/15, celý `copierRunner` 56/56,
společně 77/77, `npx tsc --noEmit` a `git diff --check`.

### 2026-08-24 (Codex, RED test prevence venue-side OSO qty=7)
K recovery chaos testu incidentu přibyl sesterský PREVENCE scénář bez
umělého zdržení cancelu. Sdílený lokální helper přehrává follower OSO qty 5,
částečné filly 1 až 5 a cizí venue OrderVersion qty 7; prevenční test ukládá
stav ještě před leader flat, aby pozdější flat sweep nemohl výsledek falešně
zazelenit. Na aktuálním kódu oba incidentní testy záměrně padají: recovery
končí followerem -2 při leaderovi 0, prevence vidí oversized stop stále
`working` a skupinu stále ARMED. Zbylých 12 chaos testů a TypeScript prošlo.
Produkční soubory změněné souběžnou cizí prací tento zásah neupravoval.

### 2026-08-24 večer (Claude, forenzika otočení followerů + trojitá obrana)
Doplnění ranního incidentu: followeři se otočili do long 1, protože jejich
stopy byly u brokera navýšeny z qty 6 na qty 7. Forenzika orderVersion +
command entit prokázala, že fatální Modify (14:59:19.148Z, všech 5 účtů
v 16ms rozestupech) **neposlal náš worker**: příkaz nemá `userSessionId`
(server-generated, Tradovate engine), worker log i audit jsou v tom čase
prázdné a náš rytmus je ~150 ms/účet. Náš poslední zásah byl :09.8 s qty 6.
Follower brackety jsou nativní OSO spravované venue enginem — přímé modify
stop nohy s totálem závodí s jeho správou. KOREKCE dřívějšího závěru:
copier fatální modify nevygeneroval; regresní test „engine spočítá 7"
napsat nejde, engine 7 nikdy nespočítal.

Trojitá obrana (testy všech tří větví ověřeně padají bez opravy):
1. **Flat sweep** — follower přechod pozice ≠0 → 0 okamžitě ruší jeho
   ochranné nohy (bracket/OSO outbox), bez čekání na kopii leaderova
   cancelu. Risk-redukující, funguje i po DISARM. Incidentní okno bylo
   980 ms; sweep ho zavírá na jednotky RTT. Vstupní limitky neruší.
2. **Autoritativní lookup před modify** — částečně vyplněný příkaz nikdy
   nedostane zastaralý total: fill ≥ cíl ⇒ skip; čistý posun ceny drží
   venue total; nikdy se neposílá total < už vyplněné množství.
3. **Detekce cizího zásahu** — venue total > náš cíl ⇒ modify se neodešle,
   operace unknown ⇒ standardní fail-closed řetěz.

Pozn.: venue si o vlastní vůli navýšil follower stop i bez našeho
souběžného příkazu — flat sweep je proto primární pojistka, lookup a
detekce zmenšují prostor závodu. Před ostrým ARM zopakovat DEMO sekvenci
z incidentu (OSO vstup, 3× posun SL, částečné filly stopu).

### 2026-08-24 (Codex, Lucid po zavření leadera falešně zešednul)
Deterministická příčina byla v částečném post-close refreshi LIVE dat, ne
v OAuth ani broker spojení. Po přechodu Tradeify leadera do flat stavu hook
načetl jen dotčené Tradeify connection ID, ale výsledkem nahradil celou mapu
`connectionData`. Lucid tak dočasně zmizel ze snapshotu a UI ho vykreslilo
jako offline, přestože připojení zůstalo aktivní.

Oprava rozlišuje dva režimy: úplný refresh dál nahrazuje mapu a může odstranit
skutečně odpojené spojení, zatímco cílený post-close refresh data slučuje a
zachová ostatní prop firmy. Regresní testy ověřují oba směry. Ověření: 1425
testů, typecheck a produkční build čisté. Změna je zatím pouze lokální — nebyla
pushnuta ani nasazena.

### 2026-08-24 (Claude, incident: první živý obchod se nezkopíroval)
Postmortem provedl Codex (DB forensika), nálezy jsem ověřil v kódu a opravil.
Řetěz příčin:
1. **Verzní rozjezd** — noční opravy z auditu (mj. relay přenos skupiny,
   commit 3dd8078d) zůstaly jen lokálně; produkce jela 8cefc75f a worker byl
   z 23. 8. 17:25. Frontend posílal `{type:'arm-live', group}` — relay ale
   payload zredukoval na `{}`, worker se ozbrojil se svou zastaralou
   konfigurací (skupina `enabled:false`).
2. **OCO/OSO cesty obcházely `group.enabled`** — `planReplication` vypnutou
   skupinu přeskočí, ale `processBracketPair`/`processOsoPair` bránu neměly
   (v celém copierRunner.ts nebyl jediný výskyt `group.enabled`). Proto se
   první obchod nekopíroval a pozdější brackety ano — zdánlivě chaotické
   chování.
3. Neznámý DISARM 2 min před vstupem (tabulka příkazů neukládá actora).

Opravy (obě s testy, které bez opravy prokazatelně padají):
- brána `group.enabled` v processBracketPair i processOsoPair — POUZE tam;
  hlavní cesta ji nedostala schválně, protože přes ni jedou risk-redukující
  rušení už zkopírovaných příkazů, která vypnutá skupina osiřet nesmí;
- relay `arm-live` BEZ skupiny nyní selže nahlas (`invalid-relay-command`)
  na enqueue i claim straně — nikdy se tiše nepřevede na `{}`. Starý řádek
  s payload `{}` po nasazení selže na claim straně = fail-loud, žádný ARM
  se zastaralou konfigurací.

Procesní poučení (závazné): oprava klasifikovaná jako bezpečnostní se
nesmí nechat nepushnutá přes obchodní den. Frontend, relay a worker musí
běžet ze stejného commitu; před ostrým během ověřit
`git log origin/main..HEAD` prázdný a worker build čas > čas posledního
copier commitu.

Zbývá (viz Codex doporučení): rozlišit v UI OAuth/snapshot/worker/WS/ARM
stavy (dnes splývají — Lucid „zešednul" bez skutečného výpadku),
skupina Connected přes some(), telemetrie follower_count ukazuje
konfiguraci místo výsledku, actor u příkazů v DB.

### 2026-08-23 (Claude, review mobilní appky — falešné ARM opraveno)
Společná review appky na telefonu (Claude + Codex, dva statické passy
a interaktivní kontrola). Nejcennější třída nálezů: **UI tvrdilo ARM, aniž
mělo čím ověřit stav kopírky.** Všechny tři jsem před opravou potvrdil
čtením kódu, ne jen z hlášení:
1. Live Activity ignorovala `context.isStale` (nula výskytů v 1140 řádcích),
   zatímco server posílá stale-date 180 s. Po pádu workeru nebo APNs zůstalo
   na zamčené obrazovce svítit zelené „ARM LIVE". Nově se přepíše na
   „ARM NEOVĚŘEN" a skryje se odpočet, který nejde ověřit.
2. Kruhový widget odvozoval text z holého `live.armed`, takže vedle varovné
   stale ikony mohl svítit nápis „ARM". Text teď vychází ze stejného
   fail-safe stavu jako ikona (`?`/`STOP`/`LOCK`/`OFF`/`ARM`). Velká
   obdélníková varianta to řešila správně už dřív.
3. Cache broker snapshotu měla klíč jen `user_id:connection_id` a ignorovala
   `allAccounts`; sběrač účtů tak Live Activity podstrčil pozice účtů mimo
   copier skupinu. Klíč nově obsahuje rozsah dotazu.
K tomu datový závod: správa observerů ActivityKit se dělala ze tří kontextů
bez synchronizace (mohl shodit proces) — vše izolováno na `@MainActor`.

Mobilní UI: bezpečnostní akce měly změřeno 82×28 / 71×28 / 56×28 px, tedy
hluboko pod 44px cílem. Po opravě 44 px při zachovaném vzhledu; ověřeno, že
řádky narostly o 1 px (44 → 45) a skupinový se zmenšil z 57 na 45. Stavové
hlášky byly `fixed bottom-5`, tedy schované za nativní lištou (49 px +
safe-area) — nová třída `.native-fixed-above-tab-bar` je zvedne.

Metodická poznámka: simulátor pro přihlášení nepoužitelný — nepodepsaný
build nemá keychain entitlement a padá na `-34018`. Interaktivní část se dá
zastoupit prohlížečem v šířce 402 px; nativní věci (push, Live Activity,
widgety) ale potřebují reálné zařízení a zůstávají neověřené.

Otevřené: widget target má deployment target iOS 26, hlavní appka iOS 15 —
na starších systémech by widgety ani Live Activity nebyly dostupné vůbec.

### 2026-08-23 (Codex, opravy mobilních UI nálezů z review)
Bezpečnostní Connect/Disconnect, Flatten All a účtové Flatten v LIVE mají
skutečný 44px dotykový cíl, ale zachovávají původní 28px vizuál. Účtové řádky
mají minimální 44px rozteč, takže šest cílů pod sebou se nepřekrývá. Payout
dialog má pevnou hlavičku/patičku a samostatně scrollující obsah; nastavení
grafu pod `sm` používá horní horizontální taby a skládaná pole; nastavení
indikátorů pod `sm` skládá 280px pole do jednoho sloupce a zalamuje patičku.
Ikonové account akce a onboarding checkbox labely mají 44px cíle a kliknutí
account akcí se nepropaguje do karty.

Portálový LIVE toast i další nalezené fixní stavové zprávy (Nastavení,
Network Hub a backtest loading/error) používají společný native-only offset
nad `49px + safe-area` lištou; desktopové pozice zůstaly stejné. React kontrola
nenašla změnu hooků, datového toku ani obchodní logiky. Prošlo `npx tsc
--noEmit`, cílených 24/24 testů a celá sada `npx vitest run` (183 souborů,
1 410 testů). Vizuální browser/device kontrola v této relaci neproběhla. Nic
nebylo commitnuto, pushnuto ani deploynuto; tato práce neměnila copier runtime,
iOS widgety ani native live-activity updater.

### 2026-08-23 (Codex, LIVE karta: bezpečný Connect/Disconnect)
Panel „Session řízení copieru“ a Shadow ovládání byly odstraněny z běžného
LIVE UI. Stav ve sloupci Status nyní používá jediný animovaný
Connect/Disconnect přepínač: Connect zachovává existující potvrzený ARM LIVE
flow, Disconnect volá DISARM. Kill switch a ruční day-lock zůstaly dostupné
v menu skupin. `copierArmed` už správně odráží každý armed runtime; výjimečný
CLI stav `armed && shadowMode` se předává jen jako zobrazovací
`copierObservingOnly` a místo tlačítka ukáže „Kopírka jen sleduje, neodesílá
příkazy“, takže jej UI nemůže omylem přepnout na ostrý provoz. Runtime
controller/runner/risk gate nebyly změněny.

Lokálně prošel `npx tsc --noEmit` a celý `npx vitest run` (182 souborů,
1 405 testů). V browseru ověřeno: výchozí Live Dashboard, automaticky
rozbalená skupina, žádný Session/Shadow panel, jediný horizontální scroller,
bezpečnostní položky v menu a DISCONNECTED přepínač. Connect/Disconnect nebyl
prokliknut, aby test nezpůsobil ARM/DISARM. Výjimečný observing-only štítek
nebyl živě vykreslen, protože aktuální runtime v tomto stavu nebyl.

Následný UI polish odstranil inline Off/On Submit/On Fill select z Accounts
tabulky: řádek nyní ukazuje jen „Kopíruje“ nebo „Vypnuto“, zatímco skutečný
replikační režim zůstává upravitelný v Edit group. Connect ovladač používá
sidebar morph: DISCONNECTED v klidu → zelený CONNECT při hoveru; po připojení
zelený pulzující CONNECTED → červený DISCONNECT při hoveru, spinner při
přechodu. Po změně znovu prošel typecheck i všech 1 405 testů; browser ověřil
5 stavových štítků, žádný replication select a jediný horizontální scroller.
DISCONNECT nebyl živě aktivován.

Pravý account akční sloupec dostal pevnou šířku 92 px a GroupDetail už
neodečítá horizontální padding od šířky společného scrolleru. Na maximálním
pravém scrollu browser změřil všech 6 Flatten tlačítek jako plně viditelných
(55,7 px); druhý scrollbar nevznikl. Typecheck a 1 405 testů znovu prošly.
Runtime se během read-only kontroly sám zobrazil jako připojený, takže byla
živě potvrzena červená varianta DISCONNECT bez kliknutí Codexu.

Accounts tabulka už nemá samostatný Replication sloupec; On Submit/On Fill/Off
zůstává pouze v Edit group. Leader je označen výraznější zlatou korunkou přímo
napravo za názvem účtu v Account buňce. Browser ověřil nulový Replication header, právě jeden leader
badge, jeden horizontální scroller a plně viditelné Flatten; typecheck i všech
1 405 testů zůstávají zelené.

Primární vizuální důraz byl stažen z pomocných akcí: Přidat skupinu je
neutrální outline tlačítko a Flatten All má pouze jemný rose tint/outline;
jejich potvrzovací a runtime chování se nezměnilo. Browser ověřil výsledné
barvy a celý test suite zůstal zelený.

Connect/Disconnect morph byl ztenčen na 28 px (řádek 41,5 px); browser změřil
symetrický vnitřní odstup 6,75 px nahoře i dole, takže ovladač už řádek
neroztahuje. Text byl následně zkrácen na stavový morph OFF → ON / ON → OFF a
šířka na 82 px; ikona a typografie byly proporcionálně zmenšeny, potvrzení i
runtime chování zůstalo. Přístupné Connect/Disconnect aria-labely jsou zachované.

Opravena bezpečnostně důležitá stavová chyba: ON/OFF už není odvozeno z
`connected && group.enabled && commandAdapter && copierArmed`, ale přímo z
autoritativního `copierArmed` pro execution group. Skutečně armovaný runtime se
tak nemůže maskovat jako OFF kvůli vedlejšímu UI/data stavu. Po uživatelově ARM
browser read-only ověřil `aria-checked=true`, Disconnect aria-label a zelené
pulzující ON; typecheck i všech 1 405 testů prošly.

### 2026-08-23 (Codex, onboarding vybírá katalogový plán)
Dávkový onboarding už nevybírá samostatnou payout šablonu, ale stabilně
identifikovaný preset z `TRADOVATE_PROP_PLAN_PRESETS`. Potvrzení z presetu
zapíše firmu, plán, velikost, drawdown, loss/DLL/consistency/target a limity
kontraktů; typ účtu preset předvyplní, ale uživatel ho může přepsat. Payout
pravidla se odvozují jen pro Growth, Lightning, LucidFlex a LucidPro;
nenamapovatelný nebo žádný plán pravidla nemaže ani nezapisuje. Automatické F0
založení dál nechává `account_type` i rizikové parametry NULL až do potvrzení.

UI má jediný select plánu v řádku i hromadné liště a pod ním ukazuje velikost,
max loss a typ drawdownu. Cílených 7/7 onboarding testů a `npx tsc --noEmit`
prošlo. Celá sada mimo sandbox doběhla na 180/182 souborů a 1403/1405 testů;
dva reprodukovatelné pády jsou v nedotčeném cizím rozsahu: očekávání grantů v
`tradovateAccountProfiles.test.ts` neodpovídá aktuální rozpracované migraci a
`copierChartSnapshot.test.ts` timeoutuje před prvním CDP příkazem. Zakázané
copier/TradingView soubory se neměnily. Nic nebylo commitnuto, pushnuto,
deploynuto ani migrováno; UI nebylo vizuálně proklikáno.

### 2026-08-23 (Codex, dávkový onboarding nových Tradovate účtů)
Karta Účty má nahoře sekci „N nových účtů ke kontrole“ s výběrem řádků,
inline názvem, firmou včetně nové vlastní hodnoty, typem účtu a payout šablonou.
Společný řádek aplikuje firmu/typ/šablonu jen na zaškrtnuté účty. Potvrzení
nejdřív upsertne pravidla přes existující `saveFirmPayoutRules` a teprve potom
uloží všechny profily přes stávající account-profiles PUT s `onboarded_at`;
„bez pravidel“ žádný existující řádek pravidel nemaže.

Nové broker účty se po dostupnosti schématu založí automaticky s
`onboarded_at = NULL`, ale `account_type = NULL`: UI typ předvyplní z názvu a
teprve explicitní potvrzení ho uloží, aby zůstal zachovaný konzervativní F0
healing evaluace/funded. Před migrací server z `select *` vrací profil bez
klíče `onboardedAt`; sekce se pak úplně skryje a zůstane původní profilový
dialog. Smíšené/neurčité schéma je také fail-safe skryté.

Připravená migrace `20260823070913_account_profile_onboarding.sql` přidává
nullable sloupec, backfilluje všechny dosavadní profily na `now()` a obsahuje
omezené column granty i select/update-own RLS přes `(select auth.uid())`.
ZÁMĚRNĚ NEBYLA APLIKOVANÁ; Supabase CLI soubor nevytvořilo kvůli lokální
Keychain chybě `SecItemCopyMatching failed -50`, proto vznikl ručně v přesně
požadovaném migračním formátu. Copier logika ani `scripts/copier/pilot.ts` se
neměnily. Ověření: `npx tsc --noEmit`, 182/182 Vitest souborů a 1403/1403
testů, `npm run build` i `git diff --check` prošly. UI nebylo vizuálně
proklikáno s reálným post-migration profilem. Nic nebylo commitnuto, pushnuto,
deploynuto ani aplikováno do Supabase.

### 2026-08-23 (Codex, F2 nastavení TradingView webhooku)
Do Nastavení → Notifikace přibyla sekce TradingView alerty. Klient čte vlastní
`tv_alert_webhooks` přímo přes existující Supabase session/RLS, token ve URL
výchozí maskuje a kopíruje vždy plnou URL. Chybějící řádek zakládá nový
autentizovaný serverless endpoint; 256bit token vzniká výhradně na serveru a
service-role upsert je odolný proti souběžnému provisioningu.

Připravená migrace `20260823065352_tv_alert_webhook_settings.sql` přidává
per-user `alerts_enabled` a `images_enabled`, omezený column UPDATE grant a
update-own RLS přes `(select auth.uid())`; ZÁMĚRNĚ NEBYLA APLIKOVANÁ.
Webhook před migrací zachovává oba defaulty jako true. Vypnuté alerty vracejí
HTTP 200 `alerts-disabled` bez rate limitu, uložení, pushu i snapshotu. Vypnuté
obrázky zachovají alert a okamžitý text, ale alert dostane ne-pending sentinel,
worker nedostane request a pozdní upload/follow-up se znovu kontroluje a odmítne.
Copier order/risk logika ani `scripts/copier/pilot.ts` se neměnily.

Ověření: `npx tsc --noEmit` čistý; kompletní `npx vitest run` mimo loopback
sandbox prošel 181/181 souborů a 1397/1397 testů; `npm run build` prošel.
V relaci nebyl dostupný ovladatelný browser, proto dark/light render nebyl
vizuálně proklikán. Nic nebylo commitnuto, pushnuto, deploynuto ani aplikováno
do Supabase. Ruční aktivace vyžaduje aplikaci nové migrace přes Management API
a následnou kontrolu security/performance advisory.

### 2026-08-23 (Claude, F2 obrázkové alerty — ladicí nálezy, pipeline ověřena end-to-end)
TV alert → text push (~2 s) → tichá náhrada s obrázkem grafu (~5 s) funguje
a je potvrzena uživatelem na iPhonu. Čtyři nálezy z ladění, které stojí za
zapamatování:
1. **Symbol regex**: TradingView tickery nesou `!` (kontinuální futures
   `MNQ1!`) a `:` (prefix burzy `CME_MINI:`) — validace snapshot payloadu
   v `server/copierSnapshotStore.ts` je musí povolit (`/^[A-Z0-9._:!-]+$/`),
   jinak padá `invalid-snapshot-payload` a fotka tiše chybí.
2. **Renderování na pozadí**: TradingView Desktop (Electron) throttluje
   neaktivní záložky — snímek přes CDP je pak prázdný/zamrzlý. Lék je před
   capture poslat `Emulation.setFocusEmulationEnabled` +
   `Page.setWebLifecycleState active`; ořez na plochu grafu vyžaduje
   `captureScreenshot` s `fromSurface: true` (jinak je `clip` ignorován).
3. **Electron CDP neumí `/json/new`** — dedikovanou záložku nelze vytvořit
   programově. Řešení: ručně vytvořený unikátní layout „AlphaTrade Snapshoty"
   (chartId `JLtpkCHq`); worker ho hledá podle targetId (primárně) a chartId
   z `~/Library/Application Support/AlphaTrade/copier/chart-snapshot.json`.
   Bez nalezené záložky se hodí `snapshot-cdp-dedicated-tab-missing` a jede
   pasivní fallback (screenshot aktuálního okna bez navigace) — hlavní
   uživatelův layout se NIKDY nesmí přepínat.
4. **Viewport**: navigace jde přes `TradingViewApi` (`setSymbol`,
   `setResolution`, `timeScale().setRightOffset(40)` a `setBarSpacing(3)`);
   bounds se čtou ze selektoru `.chart-container.active` s fallbackem
   `.layout__area--center`, capture v `scale: 2`.
Snapshot capture nikdy nesmí zdržet obchodní logiku ani textovou notifikaci
(kick → text hned, obrázek dorazí náhradou přes `apns-collapse-id`).

### 2026-08-23 (Codex, odstraněn starý TradeCopia shadow collector z Macu)
LaunchAgent `com.alphatrade.tradecopia-shadow-sync` byl vypnut a jeho plist,
runtime, konfigurace, stav i logy byly přesunuty do obnovitelné složky v Koši
`alphatrade-tradecopia-shadow-sync-20260823-0632`. Důvodem byly opakované
notifikace při krátkém SQLite `database is locked`; collector už není používán.
TradeCopia databáze, původní import a aktuální Tradovate copier zůstaly beze změny.

### 2026-08-22 (Codex, Notification Service Extension pro obrázkové pushy)
Do přímo spravovaného `App.xcodeproj` přibyl target `AlphaTradeNotifications`
s bundle ID `app.alphatrade.native.notifications`, deployment targetem iOS 15.0
shodným s hlavní appkou a embed/dependency vazbou do `App`. Service extension
vyžaduje `aps.mutable-content = 1`, čte existující serverový klíč `imageUrl`, přijímá pouze HTTPS (včetně kontroly
redirectů), JPEG/PNG a nejvýše 5 MB. Osmisekundový deadline, URLSession timeout
a `serviceExtensionTimeWillExpire` vždy jednorázově doručí původní obsah při
jakékoli chybě; pouze úspěšný download přidá `UNNotificationAttachment` s
příponou odvozenou z Content-Type. Serverový payload zůstal beze změny.

Ověření: požadovaný generic iOS Debug build bez signing prošel (`BUILD
SUCCEEDED`); dependency graf zahrnul nový target a výsledná appex je vložená v
`App.app/PlugIns` s bundle ID, iOS 15.0 a správným service-extension plist.
`npx tsc --noEmit` prošel a plná sada `npx vitest run` mimo sandbox prošla
179/179 souborů a 1391/1391 testů (první sandboxový běh selhal pouze na zákazu
`listen 127.0.0.1`). Nic nebylo commitnuto, pushnuto, deploynuto ani instalováno
na zařízení; fyzické doručení obrázkového APNs pushu zůstává neověřené.

### 2026-08-22 (Codex, F2a obrázkové notifikace — server + worker)
Připravený, ale NENASAZENÝ tok pro dva spotřebitele obrázkových pushů. Nový
TradingView webhook má per-user 256bit hex token, validovaný bounded payload,
lokální i atomický Postgres limit 30/min a okamžitý textový APNs push. Alert se
uloží jako `tv_alerts`; worker dostává pouze pending requesty mladší než 60 s.
Text nikdy nečeká na obrázek. Dedikovaný TradingView CDP target je evidovaný v
Application Support, naviguje symbol/resolution/rightOffset/barSpacing v
samostatné šestisekundové fire-and-forget větvi a při problému použije pasivní
F1b capture. `ALPHATRADE_SNAPSHOTS=off` vypíná i tuto cestu.

Copier entry/exit/sl-moved textové pushy mají deterministický collapse-id z
`episodeId + kind + timestamp zaokrouhlený na sekundu`. Po úspěšném uploadu
server z aktuálního runtime eventu zrekonstruuje stejný title/body, vytvoří
hodinovou signed URL a pošle samostatný `mutable-content: 1` payload se stejným
collapse-id a `imageUrl`; chyba follow-upu je jen warning. TV alert používá
stejný mechanismus s `tvalert-<alert UUID>`. Minutový cron pouze na UTC hodině
maže TV alert řádky/objekty starší 24 h a metadata filtruje výhradně přes kind
`tv-alert`; copier snapshoty deníku nemaže.

Migrace `20260822193000_tv_alert_image_notifications.sql` přidává
`tv_alert_webhooks`, `tv_alerts`, service-only rate-limit stav/RPC a rozšiřuje
snapshot kind o `tv-alert`; ZÁMĚRNĚ NEBYLA APLIKOVANÁ. Ověření: `npx tsc
--noEmit` čistý; cíleně 65/65; kompletně 179/179 souborů a 1391/1391 testů
(loopback běh mimo sandbox); `npm run build` prošel. Nic nebylo commitnuto,
pushnuto, deploynuto, migrováno ani reinstalováno. Aktivace vyžaduje nejdřív
Supabase export/zálohu + explicitně schválenou migraci a advisory, potom server
deploy a bezpečný worker reinstall v DISARMED/flat stavu. iOS Notification
Service Extension pro stažení `imageUrl` je záměrně samostatná další várka.

### 2026-08-22 (Codex, F3c Kokpit: broker floor, payout limity, cross-firm Funeral)
Kokpit nyní dostává živý `connectionData` a drawdown používá stejnou sdílenou
funkci jako LIVE desk. Pořadí je autoritativní broker `autoLiqLevel`/LIVE
mapování → poslední snapshot s `auto_liq_level` → dosavadní deterministická
rekonstrukce. Serverový snapshot loader pouze propisuje auto-liq hodnotu z již
načítaných broker odpovědí; žádný nový Tradovate REST request nepřibyl.

Payout pravidla mají editovatelné `withdrawablePctOfProfit` a
`minBalanceToRequestUsd`; LucidFlex šablona používá 50 % zisku a Tradeify Growth
50K minimum balance 53 000 USD. Vybratelná částka je minimum skutečného profitu,
procentního limitu, payout capu a částky nad minimální balance. Starší JSON
pravidla bez nových klíčů se normalizují na `null`.

Funeral dialog ze všech vstupů nabízí všechny aktivní OAuth účty, seskupuje je
napříč firmami, předvolí otevřený účet i všechny známé breach účty a ukládá
jeden incident s volitelným nástupcem zvlášť pro každý účet. Čistý plán a testy
pokrývají výběr účtů z více firem i individuální statistiky/nástupce.

Připravená migrace `20260822160000_account_snapshots_auto_liq_level.sql` přidává
nullable konečný broker floor; ZÁMĚRNĚ NEBYLA APLIKOVANÁ. Aktivace snapshotové
cesty vyžaduje nejdřív export/zálohu produkčního Supabase, explicitní souhlas,
aplikaci migrace a security/performance advisory. Ověření: `npx tsc --noEmit`
čistý; `npx vitest run` 176/176 souborů a 1378/1378 testů (loopback běh mimo
sandbox); `npm run build` prošel. Nic nebylo commitnuto, pushnuto, deploynuto
ani migrováno; finální UI nebylo v této relaci vizuálně proklikáno.

### 2026-08-22 (Codex, F3b Kokpit účtů)
Karta Účty má nový OAuth kokpit podle `docs/design/ucty-kokpit-mock.html`,
zatímco ruční účty dál používají původní renderer. Jeden uživatelsky izolovaný
RLS dotaz načte a v paměti cachuje 35 dní `copier_account_snapshots`; řádky se
párují současně přes `connection_id` i `external_account_id`, aby se nesmíchaly
stejné broker ID z různých spojení. Souhrn i karty používají jen skutečné
snapshoty: poslední balance, Chicago daily ledger, snapshot sparkline a
profilové limity. Chybějící pravidlo nebo datum se nevyrábí jako nula/odhad.

Finanční model je mimo React v `propFirmMetrics` + čistém `accountCockpit`:
daily semafor (<50 / 50–80 / >80 %), autoritativní trailing floor a historický
breach, funded profit-day/min-max/consistency checklist, evaluation target a
consistency a risk-first řazení danger → warning → ok. Hlavička firmy má editor
uživatelských `firm_payout_rules` s bezpečným template fallbackem a upozorněním,
že firmy pravidla mění bez varování.

Existující Funeral flow byl rozšířen o checkboxy, jediný společný popis
incidentu a volitelného nástupce; nikdy se nespouští automaticky. Čistý
`planMultiAccountFuneral` ukládá společnou reflexi, ale individuální finanční
statistiky každého vybraného účtu. Graveyard ukazuje příčinu, datum, životní
P&L a nástupce. Přibyl volitelný `Account.successorOfAccountId`, uložený ve
stávajícím `accounts.meta`; žádná migrace, server ani worker se neměnily.

Ověření: `npx tsc --noEmit` čistý; `npx vitest run` mimo sandbox (loopback
testy) 176/176 souborů a 1373/1373 testů; `npm run build` prošel. Lokální Vite
server běžel na `127.0.0.1:3011`, ale v relaci nebyl připojen žádný ovladatelný
browser, takže finální render dark/light/oled není vydáván za vizuálně ověřený.
Nic nebylo commitnuto, pushnuto, deploynuto ani změněno v Supabase.

### 2026-08-22 (Codex, F3a snapshoty účtů + payout datová vrstva)
Připravená datová vrstva budoucího Kokpitu bez UI a bez worker změn. Minutový
`send-alerts` nejvýše jednou za 15 minut projde všechna connected OAuth spojení,
načte všechny jejich účty přes stejný per-connection broker snapshot cache jako
Live Activity/WidgetKit a batchově uloží dostupný balance, realized P&L dne a
open P&L. Používá stejné Tradovate endpointy jako dosavadní snapshot; žádný nový
endpoint ani druhé načtení v témže ticku nepřibylo. DB throttle je autoritativní
po cold startu, teplá instance má navíc per-account cache. Query, broker i insert
chyby končí pouze varováním a nemohou shodit alerty ani nativní větve; neúplný
broker balance se neukládá jako falešná nula.

Nové upravitelné šablony pokrývají Tradeify Growth/Lightning a LucidFlex/Pro,
klientská služba ukládá přes RLS a bez řádku vrací kopii šablony. Čisté metriky
počítají Chicago EOD ledger, profit dny, consistency, payout eligibility/cap,
static/EOD/intraday trailing floor a historicky správný breach. Monotónní jádro
trailingu je sdílené s existujícím `propDrawdown`, ne duplikované.

Migrace `20260822083921_account_snapshots_and_firm_payout_rules.sql` přidává obě
tabulky, FK/indexy, least-privilege granty a RLS s `(select auth.uid())`; ZÁMĚRNĚ
NEBYLA APLIKOVANÁ a před produkcí vyžaduje export/zálohu, explicitní souhlas a
security/performance advisory. Ověření: `npx tsc --noEmit` čistý, cíleně 25/25 a
celkem 174 souborů / 1369 testů. Sandboxový full run selhal jen na zákazu
`listen 127.0.0.1`; mimo sandbox vše prošlo. Nic nebylo commitnuto, pushnuto,
deploynuto, migrováno ani reinstalováno.

### 2026-08-22 (Claude, nasazení bloku F0+F1+F1b/c)
Celý blok „kopírka plní deník" je NASAZENÝ: web (commity 4d4f77e5→05db3dbd
na main), migrace aplikované přes Management API (mapped_account_id,
trade fakta+RLS, copier_trade_snapshots + privátní bucket + atomický
rate limit) a worker reinstalován 2× přes DISARMED bránu (06:07 UTC,
armed=False, connected). Review nálezy opravené za pochodu: skupiny firem
(firmOverride z propFirm) + evaluace vs funded z profile.accountType
včetně hojení, a brána hojícího efektu (spouštěl se jen pro nenamapované
profily). NOVÁ POLITIKA (pokyn uživatele): o víkendu/zavřené burze se
worker nasazuje automaticky; skriptová brána armed=False platí VŽDY.
Čeká na přirozené ověření: první pondělní obchod = epizoda + kopie
s multiplikátorem + snapshoty v detailu obchodu.

### 2026-08-22 (Codex, F1b auto-snapshoty TradingView k copier obchodům)
Durable leader lot dostal volitelné UUID `episodeId`, které se beze změny
order/risk logiky propisuje do close ledgeru a relevantních copy eventů.
Mac pilot pro entry/exit a nejvýše jeden posun SL za 30 s na symbol spouští
striktně fire-and-forget pasivní CDP `Page.captureScreenshot` s
`fromSurface:false`; společný capture deadline je 3 s, vypínač
`ALPHATRADE_SNAPSHOTS=off` a nedostupný TradingView/CDP se tiše přeskakuje.
PNG nad 2 MB se zahodí, relay upload má nejvýše dva retry a všechny chyby
končí pouze v `SNAPSHOT` logu; broker command/safety cesta se nezměnila.

Device relay validuje UUID, whitelist, strict base64, PNG magic a velikost.
Limit 12/min/device má lokální fast-path i atomickou Postgres sliding-window
pojistku pro více Vercel instancí. Service-role ukládá privátní objekt do
`copier-snapshots` a metadata do `copier_trade_snapshots`; Storage/DB selhání
vrací pouze best-effort výsledek a nemůže shodit poll. Připravená migrace
`20260822055450_copier_trade_snapshots.sql` přidává tabulky/RLS/bucket/policy,
rate-limit RPC a nullable `tradovate_copier_trades.episode_id`; ZÁMĚRNĚ NEBYLA
APLIKOVANÁ. Journal sync přilepí metadata episode k novému masteru a detail
obchodu teprve při otevření vytvoří hodinové signed URL; ruční screenshoty
zůstávají oddělené a nezměněné.

Ověření: `npx tsc --noEmit` čistý; cíleně 84/84 a finálně 171/171 souborů,
1361/1361 Vitest testů. První sandboxový full run měl pouze známý zákaz
`listen 127.0.0.1`; mimo sandbox vše prošlo. Nic nebylo commitnuto, pushnuto,
deploynuto, migrováno ani reinstalováno. Aktivace vyžaduje nejdřív schválenou
Supabase migraci + server deploy a potom bezpečný worker reinstall ve
stavu DISARMED/flat; galerie bez těchto kroků nemá data.

### 2026-08-22 (Codex, F1c journal master + follower kopie)
Copier journal sync nyní dostává všechny aktivní followery skupiny a pro
každý leader close zakládá master i deterministické per-account kopie. Master
má `groupId=copier-group-<trade_id>`, `isMaster=true` a žádný
`masterTradeId`; kopie sdílí groupId a odkazují na skutečné storage UUID
mastera. Follower quantity i P&L se škálují multiplierem, P&L kopie je
označené `pnlEstimated=true` a kopie nemají `needsReview`. Chybějící journal
mapping se pouze započítá do `skippedFollowers`; žádný účet se automaticky
nezakládá.

Healing pro posledních 30 dní doplňuje starým copier masterům pouze
chybějící `groupId`/`isMaster` přes merge-safe `updateTrade` a dozaloží
chybějící kopie; poznámky, emoce, review a excursion data mastera nemění.
`pnlEstimated` je součástí Trade typu i obou storage read cest. Stávající
TradeHistory čítač/filtr není třeba měnit: váže se na `needsReview`, které
má pouze master, a group lookup pro kombinovaný pohled pracuje nad plnou sadou.
Oveření: `npx tsc --noEmit` čistý; `npx vitest run` 169/169 souborů a
1351/1351 testů. První sandboxový běh selhal jen na zakázaném listen
127.0.0.1, mimo sandbox celá sada prošla. Nic nebylo commitnuto, pushnuto,
deploynuto ani aplikováno do produkce; worker/server/migrace zůstaly beze změny.

### 2026-08-22 (Codex, F1 copier close -> nezkontrolovaný journal draft)
Durable statistika leader fillů nyní při uzavření ukládá volitelný důvod
`sl/tp/manual`, průměrný vstup a cenu závěrečného fillu; změna zůstala pouze v
`trackLeaderFill`/datovém typu a nijak nemění order, risk ani safety logiku.
Heartbeat relay nová fakta validuje a propouští do ledgeru. Připravená migrace
`20260822153000_copier_journal_trade_facts.sql` přidává tři nullable sloupce a
authenticated SELECT vlastních řádků přes `(select auth.uid())`; ZÁMĚRNĚ NEBYLA
APLIKOVANÁ.

Nový `copierJournalSync` čte od lokálního cursoru (první průchod 30 dní),
mapuje aktivního leadera přes `accounts.meta.oauth`, přeskakuje existující
provenance a zapisuje pouze přes merge-safe `storageService`. Logické ID
`copier-<trade_id>` zůstává v `copierTradeId`, protože fyzické `trades.id` je
Supabase UUID. Bez mappingu nevznikne žádný obchod: Historie ukáže čekající
banner a účet přiřadí až po explicitní volbě; volba doplní i F0 account/profile
OAuth vazbu, je-li profil dostupný. Draft má fakta, `source=copier`,
`needsReview=true`, badge a filtr/čítač; libovolné uživatelské uložení přes
existující edit flow příznak shodí. Sync běží po přihlášení a z LIVE refresh
lifecycle, nejvýše jednou za 60 s. Ověření: TypeScript čistý; 169 test files a
1348/1348 Vitest testů prošlo (sandboxový první full run selhal pouze na
zakázaném listen 127.0.0.1, mimo sandbox vše zelené). Nic nebylo commitnuto,
pushnuto, deploynuto, aplikováno do Supabase ani reinstalováno. Worker změna
začne fungovat až po bezpečném reinstallu v DISARMED/flat stavu.

### 2026-08-22 (Codex, OAuth účty v trvalém journal registru)
Tradovate account profil dostal připravenou, ale NEAPLIKOVANOU migraci s
`mapped_account_id`; service-role server/API mapping čte i zapisuje a browser
dál nemá přímý přístup k tabulce. Sdílený `useTradovateLiveData` na stránkách
Účty/LIVE po načtení profilů idempotentně dopojí existující journal účet podle
OAuth identity, nebo založí Funded účet s broker metadaty v `accounts.meta`.
Pád mezi založením účtu a zapsáním mappingu při dalším průchodu nevytvoří
duplikát. AccountsManager ukazuje zdroj, firmu, připojení a poslední kontakt;
stávající edit flow dál mění journalový název. Pokus o smazání OAuth účtu je
nahrazen archivací s vysvětlením, takže vazby obchodů zůstávají zachované.
Hook neběží v backtest světě ani na ostatních stránkách. Copier runtime,
skripty, relay whitelist a broker-write cesty se neměnily. Ověření: TypeScript
čistý, 168 souborů / 1341 Vitest testů a produkční Vite build prošly; první
sandboxový full test selhal pouze na zákazu lokálního listen socketu a mimo
sandbox prošel. Nic nebylo commitnuto, pushnuto, deploynuto ani aplikováno do
Supabase.

### 2026-08-21 večer (Claude, Live Activity nešla — diagnóza a fix)
Po polední upgrade instalaci kabelem přestala fungovat Live Activity úplně
(push-to-start i lokální test): hláška o úspěchu, karta nikde, iOS po
opakovaných pokusech appce sám vypínal Živé aktivity. Server byl čistý
(push odešel, APNs přijal, token platný, schéma dekódovatelné — ověřeno).
Skutečná příčina nalezena přes pymobiledevice3 syslog z telefonu:
`ChronoCoreErrorDomain Code=1 "Unknown extension process"` — chronod měl
po devicectl UPGRADE instalaci (přes běžící appku) rozbitou registraci
widget rozšíření pro aktivity; malé widgety jely dál (běžící proces),
aktivita se vytvořila, ale obsah se nikdy nevyrenderoval. Restart telefonu
NEPOMÁHÁ (registr je na disku). FIX: `devicectl device uninstall` + čistá
instalace → „Ensure content complete", karta fyzicky potvrzena uživatelem.
LEKCE pro kabelové deploye: když po upgrade instalaci Live Activity
nenaskakuje, nezkoumat kód — rovnou odinstalovat a nainstalovat načisto
(daň: nové přihlášení + případně znovu přidat widgety).
Diagnostický postup: `xcrun devicectl device copy from --domain-type
systemCrashLogs` (pády), `python3 -m pymobiledevice3 syslog live` (live log).

### 2026-08-21 (Codex, Live Activity: obchodní stav + ARM countdown)
Live Activity na Lock Screen a Dynamic Island má nový light-first vzhled
(slate/indigo, adaptivní navy dark mode) a tři read-only režimy: čekající
leader Limit/Stop entry, otevřenou pozici s live open P&L a SL→TP gradientem,
nebo ARM idle s followery. ARM expirace se posílá jako epoch seconds a iOS ji
vykresluje nativním `timerInterval`, takže odpočet běží bez dalších pushů.
Broker snapshot nově bezpečně páruje working leader orders s nejnovějšími
`orderVersion`, vybírá nejbližší SL/TP k entry a dopočítává cenu z kompletního
open P&L pouze pro známý futures point value; selhání volitelného version
fetchu jen vynuluje cenové detaily. Pending working order brání předčasnému
ukončení aktivity. APNs transportní allowlist byl rozšířen o typovaná volitelná
pole; staré payloady se dál dekódují a mají legacy UI fallback. Žádná broker
akce, copier/relay změna, cadence ani priority pushů nepřibyla. Ověření:
TypeScript čistý, 166 souborů / 1336 Vitest testů prošlo a generic iOS Debug
build bez signing prošel (`BUILD SUCCEEDED`). První sandboxové běhy celé suite
a Xcode selhaly pouze na zákazu loopback socketu/cache zápisu; opakování mimo
sandbox prošla. Nic nebylo commitnuto, pushnuto, deploynuto ani instalováno na
telefon; finální vizuální kontrola na fyzickém Lock Screen/Dynamic Island tedy
zůstává samostatný krok.
DOPLNĚNÍ (Claude, tentýž den): review přidal dvě opravy — `quantity` na kartě
je leaderova velikost (ne součet přes followery, „LONG 72 MNQ" by mátl)
a followers řádek se bez kompletních dat schová (žádné falešné „0/5").
NASAZENO: server push na main (594a2ce5) + signed build nainstalován do
iPhonu kabelem (devicectl, „App installed"). Nové UI se ukáže od příští
ARM session; vizuální kontrola na fyzickém Lock Screenu stále čeká na
první ostrý ARM/obchod.

### 2026-08-21 (Codex, Flatten All follow-up re-ARM)
Frontendový follow-up po potvrzeném skupinovém Flatten All už nenabízí vypnutí
replikace, ale volitelný explicitní `ARM & pokračovat`. Nabídka vznikne pouze
s dostupnou ARM akcí, vypnutým kill switchem a zapnutým novým view nastavením;
ARM dál prochází existující čerstvou reconciliation a controllerové DISARM
chování flattenu se nemění. Starý localStorage klíč pro disable follow-up se
ignoruje. TypeScript a všech 1333 Vitest testů prošly.

### 2026-08-21 odpoledne V (Claude + GPT cross-review, Flatten přes relay)
Uživatel narazil: Flatten/Flatten All ze Safari na produkci → „copier relay
failed". Příčina: relay whitelist ZÁMĚRNĚ blokoval broker-write příkazy a
Safari nemá přímý loopback (blokuje https→127.0.0.1) → fallback na relay →
odmítnuto s generickým 502. Rozhodnutí (se souhlasem uživatele): Flatten je
risk-snižující nouzová brzda stejné třídy jako disarm/kill-switch — panic
button musí fungovat ze Safari i z iPhone appky. Změny:
- relay pouští copy-commandy `flatten-account`/`flatten-group`; ostatní
  broker-write (cancel-order, …) dál blokované;
- validační chyby mapované na 400 místo generického 502;
- ingress strukturální validace flatten payloadu (groupId, operationId dle
  operationToken regexu, accountId) — vadný příkaz dřív doputoval k workerovi,
  který PŘED validací DISARMuje → zbytečný fail-closed (nález GPT review);
- agent autoritativně ověřuje `groupId` proti runtime skupině (nález GPT:
  frontend kontrola není bezpečnostní hranice); testy posílaly nekonzistentní
  groupId a starý kód to mlčky polykal — opraveno + negativní testy.
ZNÁMÝ LIMIT (GPT nález, pre-existující všude): market close z planFlatten
není atomický reduce-only — při souběžné změně pozice cizím klientem může
teoreticky otočit směr. Budoucí řešení: Tradovate `/order/liquidateposition`.
NASAZENÍ: relay část funguje hned po push na main (bez workera); agent
groupId check se aktivuje příštím worker reinstallem (DISARMED gate).

### 2026-08-21 odpoledne IV (Codex implementace + Claude spec/review, paralelní Flatten)
Příprava na ~20 účtů: `processManualFlatten` přepsán na per-account
pipelines (uvnitř účtu SEKVENČNĚ cancel → close — bezpečnostní invariant;
napříč účty paralelně, `accountConcurrency` default 5 kvůli Tradovate rate
limitům). Izolace chyb: zaseknutý účet už NEblokuje zavření ostatních —
jeho durable outbox položky zůstávají (unknown/rejected/…) pro
reconciliation a účet skončí v `failedAccounts`. Výsledek nese
`accounts: ManualFlattenAccountResult[]` (ok/error/zbylé pozice per účet);
fail-closed na `!flat` zůstává, hláška teď říká „zavřeno 18/20 účtů;
selhaly …". Klíčová záludnost: durable store má CAS commity s revizí →
broker I/O běží paralelně, ale commity jdou serializovanou frontou
(sdílený runtime holder, řetězení revizí); žádný `cancelOrder`/`placeOrder`
se neodešle před dokončeným commitem položky ve stavu `sending` — platí
i při selhání commitu (fail-stop). Workflow: Claude napsal spec +
invarianty, Codex (`codex exec --sandbox workspace-write`) implementaci
a 7 testů, Claude review diffu řádek po řádku. 1326/1326 testů.
NASAZENÍ: worker reinstall čeká na DISARMED + pokyn uživatele.

### 2026-08-21 odpoledne III (Claude, trade notifikace okamžitě)
Trade eventy chodily přes minutový cron (~30–60 s). Nová okamžitá cesta:
controller `onCopyEvent` → pilot → `relay.nudgeCopyEvents()` (probudí
poll s příznakem `copyEvents`) → server v poll handleru zavolá
`sendImmediateCopyEventPushes` (APNs na native_push_subscriptions).
Dedup přes SDÍLENÝ marker `state:copy-events` — kdo doběhne první (nudge
vs cron), posune hranici; nikdy dvakrát. Latence ~1–2 s. Web/PWA push
záměrně zůstává na cronu. Nasazeno server i worker.

### 2026-08-21 odpoledne II (Claude, order lifecycle notifikace)
Trade notifikace rozšířeny z pozičních přechodů na celý lifecycle:
`order-placed` (čekající limit/stop s cenou; u OSO včetně SL/TP),
`bracket-placed`, `order-canceled` (OCO auto-cancel druhé nohy po exitu
se záměrně filtruje jako šum), `order/sl/tp-moved` (série modify při
tažení v platformě collapsuje na poslední úroveň). Exit/flip nese
`exitReason` (sl/tp/manual — párování orderId závěrečného leader fillu
proti evidovaným ochranným nohám) a `pnlUsd` z recentClosedTrades →
tituly „SL HIT −400 USD" / „TP HIT +240 USD". Market vstupy order-placed
nedělají (kryje je entry z pozice). Ring buffer 10→20.
GPT cross-review chytil 4 reálné díry, opraveno: (1) lifecycle event jen
při plně čistém auditu — částečný dispatch (dispatched+rejected) končí
fail-closed a nesmí poslat „obchod zadán"; (2) ochranné nohy se obnovují
při reconciliation z working orderů s parent/OCO vazbou — atribuce přežije
restart; (3) sety id: úklid po exitu + strop 300; (4) flip se v cron
suppresi počítá jako close — žádná dvojitá zpráva s přesným P&L alertem.
NASAZENÍ: web/cron hned; nové eventy začne worker vysílat až po
reinstallu (gate na armed=False tentokrát skriptem — při pushi byl ARMED,
reinstall čeká).

### 2026-08-21 odpoledne (Claude, widgety a notifikace dokončeny)
Kořen `500 widget-push-upsert-failed`: CHECK constraint
`widget_push_token ~ '^[0-9a-f]{64,512}$'` — POSIX regex v Postgresu má
limit opakování {n,m} s m ≤ 255. DDL prošlo (regex se nevaliduje při
CREATE), ale KAŽDÉ vyhodnocení při zápisu padalo `2201B invalid
repetition count` → každý POST 500. Oprava: char_length hlídá délku,
regex jen znakovou sadu (migrace 20260821080500, aplikováno přes
Management API — supabase migration history je vůči repu rozjetá
z Codexova MCP apply, db push nepoužívat bez repair). POZOR pro příště:
regex délkové limity v SQL vždy přes char_length.
Po opravě end-to-end: registrace tokenu (160 zn., 6 widget kinds) ✓,
APNs send ✓, reload ✓. Latence reloadu vyřešena dvěma kroky:
(1) urgentní widget push s prioritou 10 (5 = power-friendly, iOS odkládá);
(2) okamžitý widget nudge ve stejném místě jako okamžitá ARM notifikace
(sendImmediateCopierArmPush) — předtím widget čekal na minutový cron
(~35 s), teď se překreslí do pár vteřin (fyzicky ověřeno).
Dále: kabel rebuild nainstalován (repo = telefon), push-to-start Live
Activity fyzicky ověřen při force-quit. Zbývá přirozeně: galerie 22
alertů (ruční matice) a přesné P&L widgetu při přirozeném close (nesmí
se vyrábět obchodem). Pozn.: při ladění jsem si testovacím revertem
přepsal první úspěšnou registraci — diagnostické zápisy do produkčních
řádků dělat jen s uloženou kopií původních hodnot.

### 2026-08-21 (Codex, uzavření nativní větve pro předání Claude session)
Rozdělaný widget retry v `AlphaTradeNativePlugin.swift` a
`nativeWidgetRemote.ts` byl vrácen jako diagnostický experiment: WidgetKit
callback už token sám správně ukládal a odesílal, nový most jen duplikoval
stejný produkční požadavek a zbytečně vystavoval APNs token JavaScriptu.
Skutečný blok je serverový: telefon vydal 160znakový WidgetKit token, hlásí pět
konfigurací a autorizovaně načítá snapshot, ale každý POST na
`/api/native-widget-push-subscription` skončí `500
widget-push-upsert-failed`. Vercel runtime potvrzuje přijetí požadavků;
`native_widget_devices.widget_push_token` proto zůstává prázdný. WidgetKit APNs
push ani push-triggered reload tedy nejsou fyzicky hotové. Ruční tlačítko
Obnovit vyvolalo nový serverový snapshot request, ale běžný systémový timeline
zůstává oportunistický.

Fyzicky ověřené na iPhone 13 Pro Max: placeně podepsaný development APNs build;
serverová notifikace dorazila při force-quit aplikaci a zamčeném telefonu;
existující Live Activity přijala vzdálenou aktualizaci a vzdáleně se ukončila;
Copier Home widget dříve zobrazil reálný `DISARMED` stav a v tomto finálním kole
po ruční obnově skutečně kontaktoval snapshot endpoint. Nový ActivityKit
push-to-start token se 21. 8. zaregistroval do produkce, ale vzdálené vytvoření
úplně nové aktivity při force-quit ještě nebylo fyzicky vyvoláno. Všechny Home
a Lock Screen varianty ani celá 22-alert galerie nebyly po posledním buildu
znovu vyčerpávajícím způsobem otestované; přesné P&L při přirozeném novém close
se dál nesmí nahrazovat vyrobeným broker obchodem. Telefon aktuálně obsahuje
build s později vráceným diagnostickým retry, takže pro shodu s repem zbývá
jeden rebuild a instalace přes kabel.

Všech pět migrací z 20. 8. je na projektu `kopinlpdvjfgmvxydohk` skutečně
aplikovaných pod časy produkční aplikace:
`20260820061451 native_push_subscriptions`,
`20260820091413 native_live_activity_subscriptions`,
`20260820105246 native_widget_remote_refresh`,
`20260820165149 native_widget_push_updates` a
`20260820170636 native_live_activity_push_to_start`. Ověřeno i podle skutečného
schématu: všech pět souvisejících tabulek existuje, RLS je zapnuté, `anon` a
`authenticated` nemají žádné table grants, `service_role` má potřebný přístup
a widget push sloupce jsou přítomné. Nic se znovu neaplikovalo.

Známý lokální CandleKit incident: Codexův `npm install` z 20. 8. přepsal vlastní
AlphaTrade build publikovaným `@getcandlekit/charts@0.1.0`. Správná verze není
jiné semver číslo, ale **AlphaTrade-patched build 0.1.0** s Text,
Long/Short Position, Fib a hover rozšířeními. Neporušená kopie je v
`~/Downloads/alphatrade-mentor-15/oauth-data-probe/node_modules/@getcandlekit/charts`;
obnova znamená nejdřív odložit současný
`node_modules/@getcandlekit/charts` a tuto složku zkopírovat na jeho místo.
Pouhé opakování `patch-package` nad už nekonzistentním lokálním `node_modules`
selže; reprodukovatelná obnova je čisté `npm ci` (nebo odložení celé složky
`node_modules/@getcandlekit/charts` a nový `npm install`), aby `postinstall`
aplikoval `patches/@getcandlekit+charts+0.1.0.patch` na čerstvý registry
tarball. Tento postup následně potvrdil i čistý Vercel build, kde se CandleKit
i Lightweight Charts patch aplikovaly úspěšně. V tomto checkoutu byl správný
build obnoven také z neporušené kopie (původní registry kopie je dočasně v
`/private/tmp/alphatrade-candlekit-published.5s25yj/charts`). Před obnovou
selhávalo přesně 36 chart/CandleKit testů a typecheck; po obnově a opravě typu
Live Activity mocku prošlo `164/164` test files, `1309/1309` testů a celý
`tsc --noEmit`.

### 2026-08-20 (Codex, ActivityKit push-to-start při zavřené appce)
Audit odhalil, že APNs uměla existující Live Activity aktualizovat a ukončit,
ale bez běžící aplikace ji neuměla poprvé vytvořit. iOS větev proto registruje
device-scoped ActivityKit push-to-start token a sleduje i serverem vytvořené
aktivity; server vytvoří novou read-only Live Activity jen pro novou stabilní
ARM session nebo autoritativně otevřenou pozici. Trigger se ukládá, takže ručně
zavřená aktivita se ve stejné session znovu neobjeví. Token je v server-only
RLS tabulce bez grantů pro anon/authenticated, sdílí se už existující bounded
broker snapshot a žádná větev nemá broker-write cestu. Migrace
`native_live_activity_push_to_start` i deployment
`dpl_84CizzhgkpbotZNfe5ju4H6PBgH7` jsou v produkci; endpoint i cron bez secretu
vrací 401. Prošlo 20 cílených testů, lint změněných souborů, izolovaný TypeScript
a Vercel build, native sync, iOS doctor a podepsaný device build. Fyzická
instalace čeká jen na to, až CoreDevice přestane připojený iPhone hlásit jako
`unavailable`.
Následný source audit navíc odstranil zavádějící prázdné hodnoty: Home i Lock
Screen widgety bez platného snapshotu už nevypisují `$0` ani `100 %`, ale
explicitní „Čekám na skutečná data“. Rozšířená sada 53 testů pro APNs,
push-to-start, WidgetKit, P&L, account-lock a watchdog prošla a podepsaný build
po této úpravě znovu prošel celým Xcode sestavením.

### 2026-08-20 (Codex, iOS 26 WidgetKit push + ruční garantovaná obnova)
Fyzický force-quit test potvrdil, že samotná `.after(+5 min)` timeline není
pětiminutový slib: iOS neposlal nový request ani po ~26 minutách. Apple běžný
widget budgetuje; interakce App Intent ale garantuje nový timeline request a
iOS 26 navíc nabízí opportunistický WidgetKit APNs push. Všech 12 Home/Lock
widgetů proto nově registruje `WidgetPushHandler`, server ukládá jeho APNs token
jen v server-only tabulce a cron sdílí stejný read-only broker snapshot jako
ActivityKit. ARM/lock/pozice/order změny žádají refresh hned, pohyb P&L nejvýše
jednou za 5 minut. Home widgety mají i tlačítko Obnovit, které neotevírá appku
a nemá broker-write cestu. Migrace `native_widget_push_updates` je v produkci;
anon/authenticated nemají granty a deployment `dpl_8VHUdZi1NiqKqN16VK9s41mPSoeE`
je READY. Prošlo 29 cílených testů, TypeScript, lint, web build, widget i celý
iOS build; podepsaná app i extension mají development APNs entitlement.
Fyzická registrace push tokenu a push-triggered reload čekají na odemčený iPhone,
který CoreDevice momentálně hlásí jako `unavailable`.

### 2026-08-20 (Codex, vzdálené P&L + broker account-lock APNs)
Aktuální podepsaný widget build byl nainstalován na iPhone 13 Pro Max a po
spuštění vznikl jeden revokovatelný WidgetKit token; server zaznamenal i
první autorizované načtení snapshotu. Audit ale našel rozdíl mezi ukázkovou
22-alert galerií a skutečnou force-quit cestou: vstup/scale/exit a copier
incidenty chodily přes APNs, přesné P&L uzavřeného obchodu a broker lock/unlock
se plánovaly jen v otevřené appce. Produkční cron proto nově čte durable
`tradovate_copier_trades`, posílá jednu deduplikovanou zprávu s leader P&L
(obecný exit se v tom ticku potlačí) a přes sdílený read-only Tradovate snapshot
hlásí změny `canTrade`/`changesLocked`. Neúplná broker odpověď nikdy nevyrábí
falešné odemčení a žádná větev nemá broker command. Cíleně prošlo 38 testů,
TypeScript, lint změněných souborů, produkční build a `git diff --check`.
Izolovaný deployment `dpl_Dbhp9qiEN2GU3z9T4Xuxtxm4PbhH` je `READY` na hlavním
aliasu; první minutový cron založil markery pro dvě runtime zařízení a všech
šest současných účtů jako odemčené bez replaye čtyř starších close záznamů a
bez falešné notifikace. Běžný Home widget od 18:16 do 18:38 nový timeline
request neudělal; přesný closed-app interval proto zůstává fyzicky neověřený a
nesmí se zaměňovat s okamžitou APNs/Live Activity cestou řízenou serverem.

### 2026-08-21 poledne (Claude, cross-model delegace: Codex jako nástroj Claude Code)
Nastaveno spojení předplatných (Claude + ChatGPT Max 20x) bez API billingu:
Codex CLI (`~/.local/bin/codex`, auth_mode chatgpt) + `codex mcp-server`
registrován v Claude Code (user scope). Politika: „svaly GPT, hlava
Claude" — objemná implementace/testy/mechanické refactory a REVIEW
Claudových diffů → Codex (vždy `--sandbox read-only` pro review); copier
core píše Claude a GPT recenzuje; architektura/integrace/gate → Claude.
Zvažovaný OpenRig (persistentní tmux tým) zamítnut: malá adopce, seaty
pálí limity, tohle řeší totéž levněji. První ostrý test delegace našel
reálný bug: long-poll v enqueue endpointu při selhání čtení vracel 502
po durable zápisu → klientský retry s novým idempotencyKey = duplicitní
příkaz; opraveno degradací na 202 (18acb729). Pozn. pro Codex: když
pracuješ v repu přímo, pravidlo „jeden asistent naráz" platí dál — tahle
delegace běží POD Claude session, ne vedle ní.

### 2026-08-21 dopoledne II (Claude, ARM z 5–6 s na <1 s / ~2 s — čtyři nálezy)
Uživatel: „ARM trvá 5–6 s." Postupná diagnóza měřením, čtyři skutečné
příčiny (žádná nebyla „pomalá reconciliation" sama o sobě):
(1) list metody brokeru stahují GLOBÁLNÍ seznamy a filtrují per účet —
reconciliation pro 5 účtů = ~25 identických REST dotazů; in-flight dedup
(sdílení souběžných fetchů, žádná TTL cache) → reconciliation 335–635 ms.
(2) UI posílalo update-group + arm-live jako DVA sériové relay round-tripy;
arm-live teď volitelně nese `group` a synchronizuje atomicky (1 round-trip).
(3) Realtime kick se ZAHAZOVAL, když přišel během poll requestu (wake byl
null) → fronta 1,1–1,5 s; `kickPending` ho drží → fronta 0,4–0,7 s.
Telemetrie: `RELAY KICK přijat` + `RELAY CMD … čekal ve frontě X ms`.
(4) Přímý loopback agent se používal jen na http://localhost — produkční
HTTPS web na Macu teď zkouší 127.0.0.1 napřímo (CORS + private-network
header byly připravené; telefon po 1. neúspěchu tiše na relay). POZOR:
Safari HTTPS→127.0.0.1 blokuje (WebKit bez localhost výjimky) — na Macu
pro desk používat Chrome (<1 s); Safari/telefon jede relay ~2 s. Navíc
enqueue endpoint long-polluje ~2,2 s na výsledek (UI bez polling koleček).
Uživatel potvrdil „už to funguje rychle". Další krok pro telefon: VPS.
Provozní poučení: reinstall workeru VŽDY gate-ovat na armed=False v
skriptu (jednou proběhl při ARMED — jen flat, ale nesmí se opakovat).

### 2026-08-21 dopoledne (Claude, connection recovery „podle stavu")
Poslední nekrytý případ: výpadek spojení/pád Macu s otevřenými kopiemi.
Rozhodnutí uživatele: po obnovení NE slepě „vždy zavřít" ani „vždy držet",
ale PODLE STAVU. Implementace: durable stopa `safety.liveCopyOpenSince`
(kopie vznikly za živého ARM; maže ji flat skupiny, ruční DISARM — vědomé
„drž pozice" — a kill switch). Po reconnectu NEBO po bootu s touto stopou
proběhne autoritativní reconciliation (sdílená `performReconciliation`,
až 5 pokusů) a: (a) kopie synchronní s otevřeným leaderem → DRŽÍ SE
(brackety chrání), status `resumeOffer` + notifikace „klikni ARM pro
pokračování" — reconciliation už proběhla, ARM je jeden klik; (b) osiřelé
nebo rozjeté kopie → risk-redukční auto-close (`autoClose.trigger:
'reconnect'`); (c) ověření se nepovede → poctivý fail-closed s hláškou.
Auto-ARM záměrně neexistuje — „copier se nikdy sám neozbrojí" platí dál.
Scope řídí `safety.armExpiryFlatten` (off vypíná). Tím je tabulka „jak ARM
skončí vs. co s pozicemi" kompletní: jediné ruční zbytky jsou kill switch
(záměr) a doba, kdy fyzicky není spojení (kryto SL/TP brackety u brokera).
Gate: 1265+42 testů (chart selhání = známé prostředí).

### 2026-08-21 ráno (Claude, rychlost: plynulá obměna WS + realtime kick pro příkazy)
(1) **Plynulá obměna socketu** (`TradovateBrokerPort.renewSocket()`):
plánovaná údržba zavře WS bez disconnect eventu a hned se připojí s
čerstvým tokenem — controller výpadek nevidí, ARM přežije. Zadržené chyby
se při nezdaru (deadline 15 s) přiznají a výpadek se ohlásí poctivě.
Bezpečnost překryvu: order eventy dedupuje sourceVersion, filly
`emittedFillIds` (broker-level), resync doplní stav z autoritativního
snapshotu; baseline filly se nikdy neemitují (jen markují). Pilot obměňuje
po 50 min (čeká na flat), po 70 min i v obchodě — lepší řízený sub-sekundový
swap než tvrdé zavření serverem (DISARM + reconciliation). Status má nové
`groupFlat`. Tím mizí poslední zdroj samovolných DISARMů (token cyklus
~80 min, včetně leader spojení).
(2) **Realtime kick pro relay příkazy**: enqueue endpoint po zařazení
příkazu pošle Supabase Realtime broadcast (`copier-kick-{deviceId}`,
service key přes HTTP broadcast API); worker odebírá kanál (config přijde
v poll odpovědi — URL+anon key, worker nepotřebuje žádné env) a poll
proběhne okamžitě. ARM/DISARM z telefonu: ~0,7–1,2 s místo 2–5 s. Kick je
POUZE optimalizace latence — transport zůstává autentizovaný REST relay
s idempotencí, poll interval (750 ms) jako záloha. Kanál nenese žádná data.
Gate: 1261 testů (36 známých chart selhání = downgrade @getcandlekit/charts
v node_modules, netýká se repa). Worker přeinstalován.

### 2026-08-20 večer III (Claude, živý pád: OSO inference okno vs. sekvence)
Uživatel zadal limit (19:04 lokálně) → FAIL-CLOSED `out-of-order`. Kořen:
entry se drží v OSO inference okně (500 ms); dorazil jen JEDEN protective
leg (druhý se z TradingView propsal později) → pár nevznikl → leg mezitím
posunul `lastSequence` (recordLeaderEventOnly) → odložený flush entry
vyhodnocen jako out-of-order → sequence-broken → DISARM. Entry s jedním
legem se navíc dřív mohl teoreticky zkopírovat bez ochrany (leg samostatně
nikdy neodejde). Opravy: (1) `deferredReplay` v processLeaderEvent — flush
už zaznamenané události toleruje posunutou sekvenci stejně jako duplicate
(idempotence = replikační klíče + outbox, ne pořadí); `gap` dál failuje;
(2) lone-leg při expiraci okna = explicitní fail-closed „zadej SL i TP
společně" — žádná tichá kopie bez ochrany, žádný kryptický pád;
(3) OSO okno 500 → 1500 ms (reálná TV→Tradovate latence; zdrží jen kopie
čekajících limit/stop entry, market jde mimo okno). Z labelů spojení také
potvrzeno: WS blipy (~16:23, 18:06, 18:23, 18:40Z) jsou na PRIMÁRNÍM
spojení conn:53157614 (leader) — reconnect grace na něj záměrně neplatí,
takže plynulá obměna socketu před expirací tokenu zůstává P1 pro klid.
Gate: copier testy 162/162; celková suite obsahuje ~36 pádů z Codexovy
rozdělané práce na chart drawing (mimo copier). Worker přeinstalován.

### 2026-08-20 večer II (Claude, škálování na více propfirem: reconnect grace + diagnostika spojení)
Uživatel plánuje rozšíření na více firem a ~20 účtů. Diagnóza „odpojil se
Lucid": každá propfirma jede přes vlastní OAuth spojení s vlastním WS;
Tradovate zavírá socket při cyklu access tokenu (~80 min) a worker se do
~1 s připojí zpět — ale JEDNO mrknutí odzbrojilo VŠECHNY firmy (router:
any-down = disconnect). S N firmami by to znamenalo DISARM každých ~80/N
minut. Opravy: (1) chybové hlášky WS nesou štítek spojení
(`conn:<id8>`, mapování na účty se loguje při startu) + timestampy na
FAIL-CLOSED/COPIER RELAY řádcích — do dneška nešlo z logu poznat, které
spojení padlo; (2) `brokerRouter` reconnect grace: follower-only spojení
(route `critical:false`) smí mlčet `reconnectGraceMs` (10 s) — kratší
mrknutí se nikdy neohlásí; spojení nesoucí leader stream zůstává bez
tolerance (ztracené leader eventy nejde dopočítat → okamžitý DISARM +
reconciliation). Objednávka odeslaná během mezery selže fail-closed
vlastní outbox cestou — grace jen ruší plané poplachy bez broker akce.
Další velcí kandidáti pro scale (zapsáno, neimplementováno): plynulá
obměna socketu před expirací tokenu (kryje i leader spojení), paralelní
manual-flatten přes účty (dnes sekvenční — na 20 účtech pomalé),
parita jako metrika. Gate: 1270 testů. `COPIER RELAY fetch failed` ×22
(deduplikováno) naznačuje i mikrovýpadky sítě Macu → argument pro VPS.

### 2026-08-20 večer (Claude, živý incident: rejected modify → fail-closed → otevřené kopie)
Incident 16:45: uživatel z TradingView posouval SL na BE, cena už byla za
úrovní → Tradovate cancel-replace REJECTL (a tím objednávku ZABIL — cancel
prošel, replace ne; TV na leaderovi založil nový SL). Copier reject
vyhodnotil jako kritický → fail-closed DISARM; exit leadera o 9 s později
už byl `blocked disarmed` → follower pozice zůstaly otevřené a mirror
cancelů jim sundal i brackety. Tři opravy:
(1) **Tolerantní lifecycle resolution** (`resolveCancelLookup`): cancel
proti objednávce ve stavu canceled/rejected = cíl splněn (confirmed no-op);
modify proti canceled = bezpředmětný no-op. Fail-closed zůstává pro modify
→ rejected/filled (mrtvá ochrana / změněná pozice) a cancel → filled
(divergence).
(2) **Auto-flatten kopií i při fail-closed za živého ARM** — sdílená
mašinerie s expirací ARM (`autoFlattenCopies`), stejné pojistky: scope
`safety.armExpiryFlatten` (teď pokrývá OBĚ příčiny), jen při lokálně známé
expozici, nikdy shadow/kill-switch/transport-lost (bez spojení zavírat
nejde). Status pole přejmenováno `armExpiryClose` → `autoClose`
(+`trigger`), watchdog marker `state:auto-close`. Jednorázovost: selhání
flattenu volá failClosed už odzbrojené → smyčka se neroztočí.
(3) **Reconciliation samočistka**: čistá autoritativní reconciliation
waivne i `abandoned` cancel/modify položky (terminálně známé; případný
`filled` outcome by reconciliation rozbil dřív) — 10 stuck položek z
incidentu zmizí prvním reconcile.
Gate: 1267 testů, tsc čistý. POZOR: strom obsahuje rozsáhlou necommitnutou
práci Codexu (APNs push, widgety, Live Activities) propletenou se stejnými
soubory — commit se řeší s uživatelem, worker se nasazuje z lokálního
stromu nezávisle na gitu.

### 2026-08-20 (Codex, durable copier obchody + WidgetKit refresh bez otevřené appky)
Příčina falešného `DATA ZASTARALÁ` byla potvrzena: WidgetKit četl jen App Group
snapshot, který React obnovoval po minutě pouze za běhu aplikace, a po 120 s ho
označil stale. Současně copier držel poslední position eventy jen v RAM a neměl
spolehlivý per-trade P&L zdroj. Nově worker vždy (i s vypnutými risk limity)
vede durable avg-cost ledger leader fillů, uzavřené obchody posílá idempotentně
v heartbeat a server je ukládá do `tradovate_copier_trades`. Neznámá hodnota
bodu zůstává `null`, nikdy se nevydává za $0. Equity se rekonstruuje pouze pro
leadera; follower fill/slippage se neodhaduje.

Widget extension má revokovatelný 256bit read-only token v App Group; Postgres
ukládá pouze SHA-256 do `native_widget_devices`. `anon` i `authenticated` mají
na obě nové tabulky nulová práva, RLS je zapnuté a CRUD má jen `service_role`.
Endpoint `/api/native-widget-snapshot` načte heartbeat + omezený broker snapshot
a neobsahuje žádnou broker-write cestu. Widget zachová lokální journal, obnovuje
LIVE přes WidgetKit (požadavek 5 min; skutečný budget řídí iOS), při síťové chybě
ponechá poslední dobrá data. Skutečný worker outage je `WORKER OFFLINE` po 90 s;
obecný stale badge až po 30 min bez úspěšné obnovy.

Migrace `native_widget_remote_refresh` je na produkci jako `20260820105246`.
Finální izolovaný preview `dpl_HPEjF5qxTXfRCUXSX2Xm2etqaecL` prošel
bezpečnostním 401 testem a byl povýšen jako produkční
`dpl_3zs5wVqs9a16mQR4SpUuLBaPh4Rg` (`READY`, hlavní alias). Mac worker byl po
potvrzeném exit→flat, DISARMED a read-only reconciliation přeinstalován z
kanonického repa; po restartu druhá reconciliation potvrdila 0 divergencí a
0 working orders. 58 cílených testů, TypeScript, `ios:doctor`, web/native build
a Swift build app+widget extension prošly. iPhone je momentálně `unavailable`;
instalace a fyzický closed-app refresh čekají na kabel/odemknutí. První řádek
ledgeru vznikne až přirozeně uzavřeným dalším obchodem — test nesmí vyrábět
broker pozici.

### 2026-08-20 (Codex + uživatel, remote Live Activity nasazena a fyzicky ověřena)
Uživatel výslovně povolil read-only přenos P&L a pozic přes APNs. Produkční
tabulka `native_live_activity_subscriptions` je aplikovaná s RLS, bez grantů
pro `anon`/`authenticated` a s CRUD pouze pro `service_role`; finanční hodnoty
se do ní neukládají. Izolovaný snapshot `origin/main` plus jen APNs/Live
Activity backend byl nasazen jako Vercel deployment
`dpl_HB3dAizW1q6u7cVojTZtrzB3jbYF` (`READY`, hlavní alias). Nejnovější
placeně podepsaný build s retry tokenu a častými ActivityKit aktualizacemi je
na iPhone 13 Pro Max. Telefon zaregistroval skutečný ActivityKit token, cron
odeslal vzdálený payload bez chyby a uživatel potvrdil, že se Live Activity po
serverovém zjištění DISARMED + brokerem potvrzeného flat stavu sama ukončila.
Copier LIVE widget na ploše fyzicky ukazuje reálné `DISARMED`; zbývající Home
widgety, tři Lock Screen widgety, stale/recovery a galerie 22 notifikací ještě
čekají na fyzické potvrzení. Měnící se remote P&L se ověří až při přirozeně
aktivní pozici — test nesmí vyrábět broker obchod.

### 2026-08-20 (Codex, live widgety a kompletní nativní alert matice)
Widget extension už nepoužívá test data mimo systémovou galerii. Devět Home
Screen a tři Lock Screen widgety čtou token-free user-scoped snapshot z App
Group: journal P&L/R/equity/discipline, účty a zámky, broker pozice, open i
realized P&L, copier ARM/spojení/cooldown/day-lock/kill-switch a poslední
potvrzené obchody. Snapshot má minutový heartbeat; po dvou minutách bez obnovy
Copier a Lock Screen LIVE viditelně ukazují `DATA ZASTARALÁ`. Barvy používají
systémový light/dark vzhled. Lokální Live Activity se automaticky váže na
ARM/open position/day-lock/kill-switch, je read-only a žádná její akce nemůže
odeslat broker příkaz.

Notifikační plán nově rozlišuje entry, scale-in, scale-out, exit a flip; hlásí
offline/recovery, broker disconnect/reconnect, fail-closed, stuck outbox a jeho
vyřešení, divergence/reconciliation, cooldown start/end, day-lock, account
lock/unlock a ARM-expiry auto-flatten success/failure. Brokerem potvrzený close
vytvoří lokální iOS P&L zprávu. Jedním tlačítkem lze naplánovat 22 read-only
testů včetně PNG trade preview. Cílených 99 testů, TypeScript, `ios:doctor` a
podepsaný arm64 Xcode build prošly. Nic z této fáze nebylo deploynuto a zařízení
je pro instalaci momentálně `unavailable`. Remote Live Activity P&L/pozice
zůstávají vypnuté: jejich payload přes Apple APNs vyžaduje výslovný souhlas
uživatele a následně samostatně schválenou migraci/deploy.

Následný completion audit opravil jednu důležitou hranici: P&L widget a
lokální P&L notifikace teď berou pouze `trade-closed`, nikdy vstupní ani
samostatný exit fill. Při pouhém otevření pozice proto nevznikne falešný
`$0` výsledek. Galerie 22 alertů má pětisekundové rozestupy a celá doběhne
za méně než dvě minuty. Regresní test, TypeScript, `ios:doctor`, nativní
bundle i podepsaný Xcode build prošly.

### 2026-08-20 (Codex + uživatel, APNs fyzicky ověřeno)
Aktuální placeně podepsaný build byl nainstalován na iPhone 13 Pro Max.
Aplikace po přihlášení úspěšně zaregistrovala development APNs token přes
produkční `/api/native-push-subscription` (`200`) a první serverový test
doručila. Následně uživatel AlphaTrade úplně ukončil a zamkl telefon; nezávislý
APNs test Apple přijal (`200`, APNs ID
`EFCCA7C1-D1E4-A5AF-1EC7-01598761122A`) a uživatel potvrdil jeho doručení na
zamčený telefon. Tím je reálně prokázán scénář server -> force-quit appka ->
zamčený iPhone; remote push už není jen laboratorně připravený.

### 2026-08-20 (Codex, APNs backend nasazen do produkce)
Dokončena serverová část skutečných nativních push notifikací. V Apple
Developer portálu vznikl týmový Sandbox & Production APNs klíč
`QYVLP2Y6QM`; privátní klíč nebyl zapsán do repa a jeho tři hodnoty jsou ve
Vercelu jako citlivé Production proměnné. Supabase migrace
`20260820054128_native_push_subscriptions.sql` je aplikovaná: RLS je zapnuté,
`anon` ani `authenticated` nemají přístup a CRUD má pouze `service_role`.
Produkční deployment `dpl_37cddUT47oHS7bAdqMVtvnX3JuUq` je `READY` na hlavním
aliasu; `/api/native-push-test` i `/api/native-push-subscription` při smoke
testu správně vrátily `401 missing-token` a runtime log neobsahoval chyby.
Kvůli špinavému checkoutu byl nasazen čistý snapshot `origin/main` plus jen
APNs backend a napojení existujícího alert/watchdog cronu, takže žádná jiná
rozpracovaná změna nešla do produkce. Aktuální nativní bundle prošel
`ios:doctor`, sestavením i strict codesignem; podpis obsahuje APNs a App Group.
Zbývá pouze instalace na fyzický iPhone a důkaz server -> force-quit + zamčený
telefon; zařízení bylo při pokusu stále `offline/unavailable`.

### 2026-08-20 (Codex, placený Apple Team + připravená APNs větev)
Apple Developer členství je aktivní a Xcode ho skutečně použil: generický
arm64 Debug build je platně podepsaný Teamem `7CUFT9738Q`; podpis appky obsahuje
`aps-environment=development` a `group.app.alphatrade.native`, widget extension
stejnou App Group. Přidán oficiální Capacitor Push Notifications plugin,
bezpečná registrace APNs tokenu po přihlášení (server-only tabulka, odstranění
při logoutu), přímý HTTP/2 APNs provider, autentizovaný serverový test a fan-out
stávajícího copier watchdogu do Web Push i APNs. `ios:sync`, typecheck, strict
codesign a 23 cílených testů prošly. Nic nebylo nasazeno: před deployem je nutné
v Apple portálu vytvořit jednorázově stahovaný `.p8` klíč, vložit tři APNs
secrety do Vercelu, aplikovat migraci `20260820054128_native_push_subscriptions.sql`
a teprve potom po schválení deploynout. iPhone byl při finálním buildu
`unavailable`, takže instalace a důkaz server -> force-quit + zamčený telefon
zůstávají otevřené. Widgety úmyslně dál používají test data; reálný token-free
snapshot writer uživatel odložil na finále.

### 2026-08-20 (Claude, bezpečnostní trojice: auto-flatten po ARM, auto day-lock, chaos testy)
Uživatelův požadavek: „když jsem v obchodě a kopírka se vypne, mám všude
otevřeno" — expirace ARM nechávala kopie viset bez dozoru (fail-open na risk).
(1) **Auto-flatten po expiraci ARM** — VĚDOMÁ ZMĚNA POLITIKY „systém
neobchoduje sám": expirace ARM teď smí spustit risk-redukující flatten
(`safety.armExpiryFlatten`: default `followers` — leader je ruka uživatele
a zůstává mu; volby `group`/`off`). Jde o JEDINOU automatickou broker akci:
ruší working příkazy a market-close k nule, nikdy nezvětší |pozici| ani
neotočí směr (planFlatten). Vyhodnocuje se event-driven na heartbeatu proti
injektovaným hodinám (žádný setTimeout — deterministické testy). Shadow ARM
nikdy nic neposílá; bez lokálně známé expozice se neposílá nic (výpadek
spojení na hranici session nesmí vyrábět falešný FAIL-CLOSED). Selhání =
fail-closed + `armExpiryClose.error` + notifikace „SELHAL, zkontroluj
Tradovate". Výsledek hlásí watchdog (marker `state:arm-expiry-close`,
per-operationId) i nativní appka.
(2) **Auto day-lock z denní ztráty leadera** — `safety.dailyLossLimitUsd`
a `dailyMaxLosingTrades` (0 = off). Worker počítá realizovaný denní P&L
z leader fillů (avg-cost per symbol, `futuresContractSpecs.pointValueUsd`;
neznámý symbol se do USD nepočítá a audit varuje — žádný tichý odhad).
Počítadlo je v durable snapshotu (`state.safety.dailyStats`) — restart
neodpustí ranní ztráty. Breach NIKDY nezasahuje uprostřed obchodu: nastaví
pending a zamkne (`dayLockUntil` do 17:00 CT) až po flat celé skupiny,
stejný vzor jako cooldown. Obchod rozjetý před startem počítadla se
nepočítá (neznámá průměrná cena → konzervativní podpočet). Notifikace:
watchdog marker `state:day-lock` per dayLockUntil; daylock-end lokální
notifikace už existovala. UI: pole v editoru skupiny + denní P&L chip
v session panelu + důvod locku v panelu.
(3) **Chaos testy** (`tests/copierChaosScenarios.test.ts`) — end-to-end
invarianty: pád workeru po přijetí objednávky → restart dohledá podle tagu,
nikdy druhý send; duplicitní tag u brokera → abandoned + stuck, nikdy třetí
pokus; WS výpadek → okamžitý DISARM, po reconnectu nic bez reconciliation.
Gate: 1228 testů (+23), tsc čistý. NASAZENÍ: web jde s pushem; worker
potřebuje reinstall (`npm run copier:mac -- install`) až bude flat/disarmed
— NEDĚLAT za běhu obchodu. V repu zůstala cizí rozdělaná práce
(@capacitor/push-notifications + migrace native_push_subscriptions.sql) —
nezahazovat, není moje, čeká na majitele.

### 2026-08-19 (Claude, „kopírka se furt vypíná" + parita kopií)
Dvě příčiny z reálného obchodování (leader 4-8 MNQ):
(1) maxContracts=1 z pilotní éry odmítal celé OSO -> fail-closed -> DISARM
při každém vstupu; 5 stuck operací blokovalo re-ARM. Vyřešeno resolve-stuck
+ skupina bez stropu (rozhodnutí uživatele). POZOR: persistovaná skupina
(.group.json, plněná update-group z UI) má přednost před CLI flagy —
změna stropu vyžaduje úpravu UI konfigurace, jinak ji ARM vrátí.
(2) Kopie se rozcházely v P&L i u limitů: fill analýza prokázala sériový
dispatch (maxConcurrentDispatches:1, rozestupy ~150-180 ms v timestampech)
— okamžitě vyplněné (marketable) limity trefily každá jiný tick. Restující
limity = parita na cent vč. Lucid. Fix: paralelní dispatch (`ef91c543`),
worker reinstalován. Zbývá ověřit příštím obchodem. Leader-vs-kopie gap
(~0.8 s) zůstává — řeší až VPS u burzy.

### 2026-08-19 (Claude, nativní appka + noční výpadek cronu)
Capacitor appka poprvé nese celý copier kokpit (instalace kabelem).
Tři opravy po cestě: (1) relativní /api/ cesty z klonu -> apiUrl() pro
nativní build; (2) CORS preflight pro capacitor://localhost do všech
tradovate endpointů (handleNativeCors); (3) KRITICKÉ: extensionless ESM
import v send-alerts shodil celý alertový cron přes noc (500/min) —
Vercel runtime vyžaduje .js u relativních importů, TS/vitest to nechytí;
opraveno i v push-test a exchange-rates. Watchdog poté ověřen e2e
(reálný incident -> PWA push). Nové: deterministické lokální notifikace
v hlavní appce (konec ARM/cooldownu/day-locku plánované dopředu — iOS
doručí i zavřené appce; incidenty hned při běžící appce). Worker hlásí
armExpiresAt (reinstalován). Limity: nepředvídatelné incidenty do
zavřené Capacitor appky = jen APNs (placený účet) — do té doby PWA.
Doporučení pro uživatele změněno na: Apple Developer účet koupit.

### 2026-08-18 (Claude, migrace + první deploy z hlavního repa)
Migrace copier_alert_state aplikovaná na produkční DB přes Supabase MCP;
advisors bez nálezu na nové tabulce (RLS + (select auth.uid()), FK krytý
PK). Větev fast-forward pushnutá na main (main neměl nic navíc) -> auto
deploy na produkci. Tím KONČÍ ruční vercel deploye z klonu — od teď je
jediný kanál push na main z Documents/trading-journal-aka. Vzdálený
watchdog je tedy kompletní: heartbeat -> cron -> dedupe -> PWA push.

### 2026-08-18 (Claude, vzdálený copier watchdog)
Podle auditu GPT (PWA push na iPhonu funguje — 320 doručení/týden — ale
copier do něj nic neposílá) doplněn chybějící článek: serverový watchdog
v cronu send-alerts (`f7eb18d4`). Čte heartbeat z device_runtime, hlásí
worker-offline / fail-closed / kill-switch / stuck-outbox /
broker-disconnected + zotavení, jednorázově tichý konec ostrého ARM.
Dedupe přes novou tabulku copier_alert_state (migrace
20260818200000_copier_alert_state.sql — JEŠTĚ NEAPLIKOVANÁ na produkci!).
Vyhodnocení = čistá funkce s 12 testy. Rozhodnutí: placený Apple účet
zatím NE — PWA push stačí; koupit až kvůli jedné ikoně/TestFlightu.
K nasazení zbývá: aplikovat migraci + deploy na Vercel (jde spolu).

### 2026-08-18 (Claude, sjednocení repozitářů)
Odhalena a vyřešena dvojí pracovní kopie: hlavní appka (Documents,
kresby/charty/Capacitor iOS) vs. klon v ~/Downloads (celý copier vývoj).
Copier větev pushnutá na GitHub a MERGNUTÁ do hlavního repa (`6af57be8`):
copier soubory z klonu, App.tsx = native most + oprava deps, vite.config
= unie. Gate: 1175/1175 testů (unie obou sad), typecheck, build. Od teď
JEDNA pracovní kopie = Documents/trading-journal-aka; klon v Downloads
je vyřazený — nepracovat v něm. Důležité opravy modelu: aktuální iOS
appka je Capacitor s bundlovaným dist-native (deploy webu telefon
NEaktualizuje; nutný rebuild appky) a Capacitor WKWebView nativní
confirm() implementuje (modal je i tak lepší). Produkce: pozor, ruční
vercel deploye z klonu končí — příští deploy musí jít z hlavního repa.

### 2026-08-18 (Claude, in-app confirm modal)
Zjištěno v praxi: window.confirm nefunguje v Claude browser panelu a ověřeno
ve zdrojáku shellu, že iOS WKWebView (bez WKUIDelegate) ho zahodí stejně —
ARM z iPhonu by tiše nedělal nic. Všech 5 confirm() v TradovateLiveDesk
nahrazeno promise-based ConfirmActionDialog (`02d6188f`); zbytek aplikace
nativní dialogy nepoužívá. Také: worker přeinstalován z checkpointu
`5765f6b7` poté, co starý build po fail-closed nechal umřít Tradovate WS
(connected:false blokoval ARM) — nový build spojení drží. Rozhodnutí:
VPS se zatím nestaví; Mac-only plán = modal ✓ -> deploy na Vercel ->
watchdog push na telefon -> ARM-expiry close -> cooldown UI.

### 2026-08-18 (Claude, Git checkpoint)
Checkpoint práce GPT z 18. 8.: quality gate (1029/1029 testů, typecheck,
produkční build, sken tajemství) a commit `5765f6b7` (broker router,
exposureCappedBroker, cancel lifecycle po fail-closed, day-lock UI).
`copytrade-preview.*` commitnut jako dev nástroj (`a3c21b71`) — otázka
uzavřena. Strom je čistý. Další krok dle plánu: ARM-expiry risk-reducing
close (samostatná cesta jako Flatten + invariantní test), potom jeden
deploy a aktualizace Mac workeru ze stejné verze.

### 2026-08-18 (Claude, review stavu a repriorizace)
Review reportu GPT: cross-firm fan-out (broker router + connection manifest)
uzavírá poslední mezeru jádra. Přepis maxContracts na exposureCappedBroker
(reject celé objednávky místo ořezu) potvrzen jako lepší — pozor ale:
překročení limitu = halt skupiny, ne zmenšená účast. K ARM-expiry close dvě
doplnění: (1) samostatná příkazová cesta s vlastním outboxem/operationId jako
Flatten, ne výjimka v risk gate; (2) invariantní test — žádný výstup nesmí
zvětšit |pozici| ani otočit směr. DŮRAZNĚ: Git checkpoint musí předcházet
další práci (38 souborů / +2867 řádků necommitnuto při zelených testech) —
prohodit kroky 1 a 3 doporučeného postupu.

### 2026-08-18 (Codex/GPT, restart recovery cancelu a deterministický test)
Doplněna mezera v recovery: pokud starší modify zůstal nejasný, následný cancel
broker skutečně provedl a proces spadl před lookupem, restart nyní po potvrzení
cancelu označí i tento starší modify jako nahrazený. Nezůstane tak falešně
`stuck/abandoned` a neblokuje pozdější bezpečný ARM. Přibyla explicitní matice
cancel lifecycle: známý terminální cancel projde přes DISARM, expirovaný ARM,
kill switch, divergenci i rozbitou sekvenci, ale dál fail-closed stojí při
odpojení, starém heartbeat nebo nesprávném prostředí. Flaky test nejasného
cancelu při Flatten už nečeká reálných pět sekund; používá injektované
deterministické polling parametry. Kompletní sada prošla `1026/1026`, TypeScript
typecheck, produkční build, lint změněných souborů a `git diff --check` prošly.
Nic nebylo nasazeno a brokerovi nebyl odeslán žádný příkaz.

### 2026-08-18 (Codex/GPT, dokončení cancel lifecycle po fail-closed)
Audit leader-only close ukázal přesnou posloupnost: follower OSO bylo nejdřív
odesláno, následný leader modify zůstal bez autoritativního potvrzení order
streamem a runtime se správně fail-closed přepnul do `DISARMED`; pozdější
leader cancel pak stará větev chybně přeskočila jako `mode-mismatch`. Oprava
ponechává při interní nejistotě fyzické broker spojení živé, ale dál vypne ARM
a vyžádá reconciliation. Terminální cancel už známé durable follower vazby se
dokončí i po DISARM, po expiraci ARM TTL a po restartu, zatímco nové příkazy a
modify zůstávají blokované. Cancel se stále neodešle bez živého spojení,
čerstvého heartbeat nebo ve špatném DEMO/LIVE prostředí. Potvrzený cancel také
označí starší nejasný modify stejného broker orderu jako nahrazený.
Regrese pokrývají DISARM, expirovaný ARM, restart v SHADOW, nejasný modify,
odpojený broker a blokaci dalších modify. Cílená sada prošla `104/104`, kompletní
sada `1016/1016`, TypeScript typecheck, produkční build, lint změněných souborů
a `git diff --check` prošly. Globální lint repa dál zahrnuje existující
generované `.vercel/output` artefakty. Změna nebyla nasazena.

### 2026-08-18 (Codex/GPT, restart s leader příkazy)
Mac execution runtime byl restartován ve chvíli, kdy broker snapshot leadera
obsahoval existující working/suspended příkazy. Po restartu se runtime znovu
připojil, zůstal fail-closed `DISARMED` a na followery nevytvořil žádnou
objednávku ani pozici. Existující leader příkazy následně přešly do uživatelova
vlastního manuálního obchodu; do něj test nijak nezasahoval a `ARM LIVE` se za
otevřené pozice úmyslně nezkoušel. Cílená deterministická safety sada
(`copierRuntimeController`, `localCopierExecutionAgent`, `copierRiskGate`,
`copierWatchdog`) prošla `67/67`; první sandboxový běh selhal pouze na zákazu
lokálního listen socketu (`EPERM`) a opakování mimo sandbox prošlo celé.
Po přirozeném ukončení obchodu na SL následná read-only kontrola produkčního
Tradovate snapshotu potvrdila `0` otevřených pozic, `0` working orders a runtime
stále `DISARMED`. Kompletní regrese následně prošla `1002/1002` testů a
TypeScript typecheck bez chyby.

### 2026-08-18 (Codex/GPT, restart recovery)
Po multi-follower OCO/SL testu byl při potvrzeném `0 positions / 0 working`
a DISARMED stavu restartován macOS LaunchAgent `com.alphatrade.copier`.
Launchd spustil nový proces, runtime se znovu připojil a fail-closed zůstal
DISARMED. Produkční UI po reloadu potvrdilo dvě aktivní OAuth connection,
všech šest účtů flat/no-working a zachovanou topologii skupiny včetně Lucid
followera. Tím je ověřen běžný restart/reconnect bez broker side effectu;
nejistý pád uprostřed `sending` zůstává pouze pro deterministický fault test.

### 2026-08-18 (Codex/GPT + uživatel, multi-follower OCO/SL)
Uživatel ručně provedl DEMO obchod na leaderovi `TDFYG50621860230` s ochranným
SL/TP; runtime kopíroval na čtyři Tradeify followery a Lucid
`LFE05066846490015`. Operátor potvrdil zásah SL a uzavření všech účtů.
Následná nezávislá read-only kontrola produkčního UI/broker snapshotu potvrdila
`0` otevřených pozic, `0` working orders a všech šest účtů ve skupině. Historie
obsahuje terminal fill/exit záznamy pro leadera, všechny čtyři Tradeify
followery i Lucid a zrušené ochranné protikusy. Runtime skončil DISARMED.
Tím je reálný DEMO fan-out OCO/SL na pěti followerech včetně cross-firm Lucid
technicky ověřen; další objednávkový test musí mít novou hypotézu.

### 2026-08-18 (Codex/GPT)
Opraveno mizení Lucid follower účtu při dočasně neúplném Tradovate
snapshotu: execution runtime zůstává autoritou pro topologii skupiny a UI
pro chybějící live řádek použije uložený profil účtu (název i prop firma).
Současně opravena fan-out chyba OCO/OSO: nově vytvořené `sending` položky
jedné dávky už neblokují další followery jako `stuck-outbox`; starší nevyřešený
outbox dál blokuje celou dávku fail-closed. Regrese pokrývají pět followerů
u OCO i OSO a chybějící Lucid účet. Ověření: 53 cílených testů, 1002 testů
celkem, TypeScript typecheck a produkční build. Reálný DEMO retest protective
OCO na všech followerech zůstává nutný. Celý aktuální pracovní stav byl se
souhlasem uživatele nasazen do produkce jako deployment
`dpl_5ub3t7tA7Y357xvQkiiQ9tpUyXNs`; hlavní alias
`https://alphatrade-mentor-15.vercel.app` vrací HTTP 200. Následná vizuální
kontrola potvrdila 5 účtů Tradeify + 1 účet Lucid, Lucid ve skupině jako pátý
follower, připojený execution runtime a bezpečný výchozí stav DISARMED.
Následně byl aktualizován i lokální macOS execution bundle a LaunchAgent se
stejnou topologií (leader `62364058`, followeři `62364057`, `62364060`,
`62364059`, `62364055`, `62364553`, všichni 1x a max 1 kontrakt). Kontrola po
restartu: broker `connected: true`, SHADOW/DISARMED, bez divergence, pracovních
příkazů, stuck outboxu a `lastError`. Tím byla odstraněna situace, kdy nový web
ovládal starší lokální bundle, který zůstal fail-closed po nepotvrzeném OCO.

### 2026-08-18 (Claude)
Založen tento log. Dnes: ARM session TTL (17:00 CT, DST-safe),
per-follower maxContracts (jádro+UI+reconciler), multi-follower agent
(`--followers "id@mult[@max],…"`), anti-revenge cooldown, watchdog
(osascript notifikace), latencyProbe pro výběr VPS regionu,
`COPIER_VPS_PLAN.md`. Opraven prune bug v bracket correlatoru
(úklid cache uměl odzbrojit fail-closed timer — `awaitingPair` teď žije
mimo `prune()`). Commity `9cf94062`…`04da423e`.

### 2026-08-17 (Codex/GPT + uživatel)
Kompletní DEMO ověření copieru: limit/market/OCO/OSO lifecycle, Flatten,
Flatten All, multiplikátory, 2× násobek. `customTag50` → `clOrdId`.
Nativní `/order/placeoco` a `/order/placeoso` + durable outboxy + bracket
correlator (Tradovate posílá nohy 200–330 ms od sebe, někdy bez vazeb).
Attached ATM detekován a správně fail-closed. Mac runtime: launchd,
Keychain, device pairing, Supabase command relay. p95 162–269 ms.
