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
  Poslední úplné automatické ověření: 1026 testů, typecheck a build čisté.
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
- [ ] UI políčko pro `entryCooldownMinutes` (config i agent flag existují).
- [ ] Cross-firm kopírování: technický fan-out Tradeify -> Lucid v DEMO prošel;
      stále chybí písemné potvrzení pravidel obou prop firem pro ostré použití.
- [ ] `copytrade-preview.{html,tsx}` — poslední untracked soubory; commit
      jako dev nástroj, nebo smazat (rozhodnutí uživatele).
- [x] Test „Flatten při nejasném cancelu" už nepoužívá produkční čekání:
      deterministicky injektuje nulové čekání a dvě kontrolní iterace.
- [ ] Chaos test recovery proti reálnému DEMO: běžný restart flat/DISARMED
      prošel 18. 8.; kill uprostřed odesílání a výpadek WS zůstávají ověřené
      jen deterministicky a nesmí se vyrábět zbytečnou broker objednávkou.

## Deník (nejnovější nahoře)

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
