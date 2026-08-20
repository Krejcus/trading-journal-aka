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
