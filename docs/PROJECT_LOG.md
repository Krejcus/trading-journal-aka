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

  Poslední úplné automatické ověření: 1705 testů, typecheck a build čisté;
  plný lint má 0 chyb (352 starších warningů mimo tuto změnu).
- **Bezpečnostní model**: DISARMED default; fail-closed všude; durable
  outboxy (standard/cancel/bracket/OSO); žádný blind retry — po nejistém
  výsledku vždy lookup podle `clOrdId`; divergence = halt-group, nikdy se
  neopravuje obchodem; kill switch = jednosměrná západka.
- **Risk settings**: per-follower `maxContracts`; anti-revenge cooldown
  (flat leadera → DISARM + blokovaný re-ARM, `safety.entryCooldownMinutes`);
  ARM expiruje nejpozději v 17:00 America/Chicago a otevřené kopie
  risk-redukčně zavře (`safety.armExpiryFlatten`, default `followers`);
  auto day-lock z denní ztráty leadera (`safety.dailyLossLimitUsd`,
  `dailyMaxLosingTrades`), počtu uzavřených obchodů (`dailyMaxTrades`) a konce
  volitelného `tradingWindow` — zamyká až po flat, nikdy uprostřed obchodu.
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
- **Samostatný menu-bar kokpit Mac workeru zůstává zamítnutý** — leštil by
  řídicí plochu dočasného stroje, který má nahradit VPS. Povolená odbočka je
  pouze oddělený read-only cloud companion bez execution schopností. Jeho
  verze 0.2 (status API/DTO, pairing/revokace, Keychain a PWA správa zařízení)
  byla 1. 9. po samostatném souhlasu aktivována v produkci a nainstalována jako
  build 3. Scope zůstává pevně `copier.status.read`; companion nesmí získat
  broker write, execution příkazy ani řízení workeru.

## Otevřené otázky

- [ ] **UI větev po balíčku 7a-3 (F4 + texty ARM odmítnutí)** — brzdy mají
      desetiminutovou relay TTL, takže UI po 35 s nesmí tvrdit, že se příkaz
      už automaticky neprovede; má ukázat čekající brzdu/platnost do konkrétního
      času. `copierArmRejection` má samostatně a jistě klasifikovat „nejdřív
      vypni“, `copier-relay-arm-config-conflict`,
      `copier-relay-worker-disconnected`, deadline a
      `superseded-by-brake`. V balíčku 7a-3 nebyly podle dělby práce změněny
      žádné `components/*` ani UI služby.
- [ ] **ST34 bezpečný bootstrap pilot lease bez kruhové závislosti** —
      kontrola z 15ae535 byla v balíčku 7a-2 vrácena, protože nová instalace
      potřebuje lease před vznikem/spárováním device klíče. Cílově vydávat
      lease jen přes Device auth po párování; pokud zůstane JWT bootstrap,
      pouze pro klíč z potvrzeného pairing requestu, s krátkým TTL a bez
      obnovy. Vyžaduje samostatný instalační/pairing redesign.
- [ ] **N6 dvě živá copier zařízení na jednom OAuth connection** — ST35
      správně routuje na nejčerstvější heartbeat, ale není to fencing.
      Budoucí oprava má odmítnout ARM při více čerstvých workerech a brzdu
      fan-outovat na všechna nerevokovaná zařízení connection.
- [ ] **N10 day-lock snapshot race v controlleru** — `maybeEngageDayLock`
      má ukládat funkčním `persistSafetyUpdate(current => ...)`, aby
      nepřepsal souběžnou novější safety hodnotu. Balíček 7a-2 soubor
      `services/copierRuntimeController.ts` podle dělby práce neměnil.
- [x] **Zápis venue risk limitů / skutečný broker-side day lock** — UZAVŘENO
      3. 9. rozhodnutím uživatele: nepokračovat. Fáze 1 (read-only sonda,
      `docs/TRADOVATE_RISK_LIMITS_CAPABILITY_20260903.md`) prokázala jen read
      právo; pre-trade zámek žije v RiskCategory/RiskTimePeriod pod správou
      prop firmy a trader token ho neovlivní — s více firmami se to jen
      násobí. Pro budoucí komerční produkt by byl broker-side lock závislý na
      dobré vůli každé firmy zvlášť, tedy děravý. Rozhodnutí: zlepšovat
      interní day-lock/copier pojistky AlphaTrade (viz zápis 2026-09-03).
- [ ] **Automatická post-connect recovery a follower chybějící v OAuth** —
      optional-skip i konkrétní blocked audit jsou hotové v `5154856d`/`30a48144`.
      Lokálně 3. 9. doplněno zbývající hardening z obou cross-review: partial
      snapshot lineage participanta ani generation race už nesmí dokončit recovery
      nebo smazat durable markery; stale resolver se revaliduje, `updateGroup` se za
      běhu recovery/reconciliation odmítá a odebrání neověřitelného vlastníka
      vyžaduje explicitní auditovaný waiver. Zbývá nezávislé review a výslovně
      schválený commit/push/reinstall; produkční worker tuto lokální změnu nemá.
- [x] **Násobek 2× „sám“ přeskočil na funded účet při změně leadera** —
      VYŘEŠENO lokálně 3. 9. (zápis níže; změna zatím není commitnutá ani
      nasazená). Původní incident (2. 9.,
      15:25–15:34 UTC): `changeCopyGroupLeader` dává předchozímu leaderovi
      `{...promotedFollower, accountId: previousLeader}`, tedy zdědí násobek
      povýšeného followera (63338592@2 → leader, Lucid 62364553 dostal @2).
      Výsledná skupina měla funded 64310872@2, aniž by mu uživatel 2× kdy
      nastavil; přesný poslední krok (tři copy-command edity 15:25–15:34) se
      bez payloadů z `tradovate_copier_commands` nedá dovodit —
      `replaceCopyGroupFollowerAccount` sice násobek dědí, ale existujícího
      followera odmítne. Ten účet pak narazil na DLL 1 250. Lokální oprava:
      předchozí leader vždy `multiplier: 1`; náhrada účtu resetuje násobek a
      `maxContracts` s viditelným upozorněním; editor před uložením ukazuje
      zvýrazněný diff leadera a všech změn followerů. Povinné regrese prošly.
- [ ] **Frekvence fail-closed při rychlém obchodování velkých velikostí**
      (2. 9. odpoledne, 5× DISARM za 70 min): 16:01 divergence -2 vs -3 uprostřed
      scale-in (pravděpodobně latence fillu followera), 16:30 „Flat sweep
      nedokončen: postkontrola selhala: deadline 1500 ms“, 16:44 „modify nebyl
      potvrzen; objednávka skončila jako filled“ (posun SL během fillu). Každý
      důvod je z pohledu safety legitimní, ale dohromady byla kopírka při
      17-kontraktových vstupech a SL posunech po pár sekundách nepoužitelná a
      každý DISARM zanechal followery mimo synchron. Potřebuje samostatný
      read-only review Codexu: která z těchto cest je race (a snese grace
      window / opakovanou autoritativní kontrolu) a která je skutečná
      divergence. Nikdy neopravovat obchodem.
- [x] **Replay starých rejectů při 50-min obnově WebSocketu** — VYŘEŠENO
      3. 9. (zápis „durable dedupe replayovaných rejectů“ níže). Původní nález
      z 2. 9. večer: po každém `SOCKET RENEWAL` leader event source znovu vydal
      `leader-reject-<orderId>` pro už dávno odmítnuté příkazy (645218030049
      z 17:36 a 645218030433 „InvalidPrice“), controller je znovu zapíše do
      `lastExecution` s novým časem a UI ukáže „Příkaz odmítnut · InvalidPrice ·
      21:34“ na účtech, kde nikdo neobchodoval. Bez broker side effectu, ale
      matoucí a zahlcoval audit.

- [ ] **Backtest audit a roadmapa 5. 9.** — lokální opravy B01–B15 a označení neznámých legacy metrik ověřené; zbývá aktivace RPC, skutečné cloudové ověření a rozvoj 48 bodů. Podrobnosti v implementačním zápisu a `docs/reviews/backtest-second-review-20260905/IMPLEMENTATION.md`.

- [x] **AlphaTrade Status — produkční aktivace** — VYŘEŠENO 1. 9. (zápis
      „produkční aktivace read-only companionu“): záloha, izolovaná migrace,
      RLS/limiter, API/PWA deploy, skutečný pairing/status, instalace buildu 3,
      Keychain persistence a restart LaunchAgentu jsou ověřené. Aktivní zařízení
      zůstalo schválně nerevokované; revoke cesta je krytá automatickými testy.
- [ ] **Rotace diagnosticky zobrazených Vercel secretů** — při preflightu se
      hodnoty některých environment secrets objevily v interním výstupu nástroje.
      Hodnoty sem nezapisovat; naplánovat cílenou rotaci. Samostatně odstranit a
      rotovat `VITE_GROQ_API_KEY`, protože každá `VITE_*` hodnota je součástí
      klientského bundle.
- [ ] **Cross-firm copy Tradeify + Lucid** — policy-blocked do písemného potvrzení
      od Tradeify (§6.6 zakazuje bota napříč firmami). Nerozhodnuto, jestli
      AlphaTrade s ručním leaderem vůbec spadá pod „bot/algo". Detaily v
      `COPIER_PROPSHIELD_REVIEW_20260831.md` §0.
- [ ] **Leader model** — zůstává technický signal account (risk-bearing jsou
      followery), nebo leaderless webhook executor s `entry+SL+TP` v payloadu?
      Rozhoduje o tom, jestli má admitted-exposure ledger vůbec smysl. Pine/webhook
      není zjednodušení zdarma — ruční klik webhook nevytvoří.
- [ ] **Zápis venue risk limitů** — dovolují Tradeify/Lucid OAuth tokeny update
      `userAccountAutoLiq` / `userAccountPositionLimit`? `changesLocked:false`
      nedokazuje právo na update a AutoLiq je post-trade, ne pre-trade contract cap.
      Read-only capability matice až po výslovném schválení uživatelem.
- [x] **Rezerva nad floorem u `drawdownType: 'trailing'`** — VYŘEŠENO
      29. 9. politikou balíčku 8c níže: růst flooru sám kopii nezavírá;
      session cut se durable omezí 95% rezervou a likvidace přijde až po
      dosažení omezeného loss limitu.

- [x] iOS 26 WidgetKit APNs registrace — VYŘEŠENO 21. 8. (zápis „widgety a
      notifikace dokončeny"): příčinou byl Postgres regex limit v CHECK
      constraintu; registrace, push i push-triggered reload fyzicky ověřeny.
- [x] ActivityKit push-to-start — FYZICKY OVĚŘENO 21. 8.: Live Activity se
      vytvořila ze serveru při force-quit appce (ARM z Mac Safari).
- [x] Kabel rebuild — 5. 9. čistá reinstalace z `origin/main` 3b88dfb8
      (devicectl uninstall + install); přihlášení přežilo.
- [ ] Pairing flow (ikona klíče v LIVE Connections) — nasazený, ale
      neproklikaný na produkci.

- [x] Kabel rebuild — 21. 8. nainstalován build shodný s repem (devicectl).
- [x] Pairing flow (AlphaTrade Status v LIVE Connections) — 1. 9. skutečně
      proklikaný v produkci; deep-link otevře a zaměří kartu i v běžící PWA.
- [x] Multi-follower DEMO test — 18. 8. potvrzen OCO/SL lifecycle na čtyřech
      Tradeify followerech a jednom Lucid followerovi; všichni skončili flat.
- [ ] Incident 31. 8. „pending SL 29379 → 29391 se followerům nepropsal,
      leader skončil flat a šest kopií zůstalo otevřených; Flatten fyzicky
      zavřel, ale UI hlásilo unknown" — lokální oprava je nainstalovaná v Mac
      workeru a šest legacy unknown bylo 1. 9. autoritativně uzavřeno read-only
      stavem. Kód zatím není pushnutý a před dalším ARM chybí řízený DEMO
      conformance test nové pending-SL/leader-flat cesty.

      zavřel, ale UI hlásilo unknown" — oprava všech tří příčin je lokálně
      commitnutá jako `416e9042` a nainstalovaná v Mac workeru. Šest legacy
      unknown bylo autoritativně uzavřeno read-only stavem. Kód není pushnutý
      ani nasazený na Vercel; před dalším ARM chybí řízený DEMO conformance
      test nové pending-SL/leader-flat cesty.
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
- [ ] **Standalone SL sweep po pozdějším zploštění followera** — balíček 5b-2
      umí při leader cancelu po účtech rozlišit skutečně ochranný SL od flat,
      oversized nebo opačně orientovaného stopu. Když se ale SL za DISARM
      správně podrží a follower se zploští až později přes TP, runner už
      nedostane leader lifecycle událost. `sweepFollowerProtectiveLegs`
      v controlleru musí v navazujícím controller balíčku zahrnout i durable
      `protectiveRole: standalone-stop` pro přesný účet+symbol a zachovat
      stejnou autoritativní postkontrolu jako bracket/OSO.
- [ ] **V8 stáří execution eventu a ochranný reassert** — broker od 5b-2 nese
      `receivedAt` na Order/Fill eventu a semantic-lag watchdog zavře přetížený
      socket. Controller ještě musí blokovat staré události zvyšující expozici,
      ochranný posun SL nesmí zamítnout jen kvůli stáří a neodeslaný ochranný
      posun se musí po čerstvém lookupu znovu prosadit. Runner 5b-2 tyto body
      záměrně nemění bez controller kontraktu.
- [ ] **ST6 pending okno musí běžet od přijetí leader eventu** — balíček 11b
      odstranil serializovanou REST hydrataci před doručením eventu, ale timer
      v `copierRuntimeController.ts` se stále zakládá až po zpracování eventu
      na plných `pendingWindowMs() + 50`. Navazující controller změna má počítat
      jen zbývající rozpočet z `leaderEvent.receivedAt`, včetně testu, kde
      brokerová hydratace spotřebuje celé okno. Soubor je záměrně beze změny,
      protože ho v této worktree vlastní paralelní Codex.
- [ ] **ST17 baseline množiny účtů pro session tighten-only** — balíček 8b
      sjednotil relay/loopback podle P-B pro ruční re-enable followera a změnu
      on-submit/on-fill, ale záměrně nerozhodl, zda má session držet zvláštní
      baseline množiny účtů proti pozdějšímu odebrání/přidání. Vyžaduje
      samostatné produktové rozhodnutí; současná flat-only execution brána
      zůstává fail-closed.

## Deník

### 2026-10-04 — Byznys přestavěn: měsíce, prop firmy, galerie výplat, nová okna (Claude)

Podle náhledu `mockups/business-redesign.html` (Filip schvaloval po krocích).
- **Pryč:** záložka Cíle (data `goals` v DB zůstávají, jen se nezobrazují) a
  daňová rezerva — čistá hotovost = výplaty − náklady. Přepínač Finance/Cíle
  v hlavičce App.tsx zrušen, nadpis „Byznys“.
- **Stránka:** pás 4 čísel (hotovost, výplaty, náklady, návratnost), řádek
  měsíců (plus i mínus, barva podle výsledku, klik = bublina s rozpisem),
  tabulka Prop firmy (klik = detail firmy s důkazy a historií), výplaty jako
  galerie důkazů / seznam, náklady seskupené po měsících (poslední 2 otevřené).
- **Firma nákladu** nemá v DB pole → `lib/businessFirms.ts` ji pozná z popisu
  („5x tradeify“, smíšený nákup se dělí rovným dílem); firma výplaty z účtu
  (`accountFirmKey`, umí i Tradovate kódy FNFT…/LFF…/TDFY…). Nový formulář
  nákladu popis skládá („5× Tradeify 50k“), takže to drží i dál. Testy
  `tests/businessFirms.test.ts`.
- **Okna** ve stylu appky (`.glass-modal`: skleněná dlaždice s ~95% výplní —
  Filipův Chrome nekreslí backdrop-filter): `ExpenseModal` (nový),
  `PayoutModal` (přetažení / ⌘V screenshotu, účty po firmách, funded první;
  logika ukládání beze změny), `PayoutDetailModal` (šířka podle obrázku,
  animace při listování a tažení, Upravit/Smazat; API beze změny — používá ho
  i Dashboard).
- Loga Apex a Alpha Futures staženy z oficiálních webů (512 px → 128 px) do
  `public/firms/`, zapsány v `KNOWN_FIRMS`.
- Důkazy výplat se načítají 10–30 s (base64 z `description`, stávající
  chování) — dlaždice do té doby ukazují neutrální ikonu.

### 2026-10-03 — Styl Aurora v celé aplikaci + Nastavení → Vzhled, fáze 1 (Claude)

Filip po dlouhém výběru (náhled `mockups/app-styles.html`: 5 stylů → 5 skel →
Aurora; Liquid Glass zamítnut kvůli čitelnosti čísel, terminál/papír/bento/
monochrom „hrozné“, nálada podle P&L ne, svíčky/záře/likvidita/vrstevnice/
seance/vlastní obrázek jako pozadí ne) vybral **Auroru s pozadím Hlubiny**.
Stejná větev/worktree jako glass detail (`claude/trade-detail-glass-20261003`),
Nasazeno 2026-10-04 jako `ed592837` (push na main → Vercel).

- **Jak to funguje:** třída `aurora` na `<html>` (světlé + tmavé téma; OLED
  zůstává čistě černé) přepíše `--bg-card`/`--glass-bg`/`--bg-page` na
  průsvitné (`color-mix` s `--aurora-card-opacity`). Tím zesklovatí všech ~220
  míst s `bg-[var(--bg-card)]` + `.glass-panel`/`.theme-card` najednou.
  Selektory `html.aurora.aurora.aurora…` s `!important` — musí přebít
  `[data-accent]` palety (ty u světlého/OLED mají `!important`).
- **Karty bez backdrop-filter** (stejný výkonový důvod jako `.glass-panel`,
  83→51 ms): leží nad plynulým pozadím, kde by blur vypadal stejně.
- **Pozadí** `components/AppBackground.tsx`: pevná vrstva `z-index:-1` za
  obsahem (bez třídy `flex` kvůli `.fixed.inset-0.flex` v nativním shellu).
  Hlubiny = jednou nakreslené plátno (3 světla + prach, žádná animace);
  Barevné pole = 5 rozmazaných skvrn s pomalým driftem.
- **Nastavení → Vzhled** (`components/AppearanceSettings.tsx`, nový tab
  `appearance`): režim (Světlý/Tmavý/OLED), pozadí, palety + vlastní barva,
  posuvníky Síla (Jemné↔Výrazné) a Průhlednost karet (Neprůhledné↔Průhledné,
  10–90 %), zmenšený dashboard jako náhled. Kompaktní, bez scrollu.
  Posuvníky mění CSS proměnné živě a do stavu ukládají až po puštění
  (jinak by se celé App překreslovalo při každém pohybu).
- **Ukládání:** `profiles.preferences.appearance` (bez migrace), cache
  `alphatrade_appearance` pro okamžitý start. Na rozdíl od tématu se vzhled
  v `applyPreferences` APLIKUJE — má platit na všech zařízeních.
  `lib/appearance.ts` normalizuje vstup (poškozené/staré hodnoty → výchozí),
  testy `tests/appearance.test.ts`.
- **Fáze 2 (nehotové):** natvrdo zapsané plochy (`bg-white`, `bg-[#…]`,
  `bg-slate-9xx` — stovky míst, nejvíc NetworkHub, DashboardCalendar,
  DailyJournal, TradeHistory vnitřky) a malá písmena v nadpisech (818×
  `uppercase tracking-` v 77 souborech, Filip chce malá písmena) — stránku po
  stránce. Akcentový picker zůstává v Systému (palety Vzhledu ho de facto
  nahrazují — rozhodnout).
- **Fáze 2 · kalendář (hotovo):** `DashboardCalendar` — plochy widgetu i
  detailu týdne/dne/obchodu z `--bg-card`/`--bg-page`/`--border-subtle` místo
  větvení bílá/slate/černá podle tématu; všech 41 `uppercase` popisků → malá
  písmena (`text-[11px] font-semibold`). Zbývá: anglické popisky v detailech
  (Week, Net Result, Daily Overview…) — Filip zatím nezadal překlad.
- **Fáze 2 · dashboard (hotovo):** Dashboard, Charts, DisciplineDashboard,
  DailyFocus/DailyInsight, MonteCarloLab, WidgetEditOverlay — 79 verzálkových
  popisků → malá písmena (skript na řetězce tříd s `uppercase`; mění jen
  třídy, diff ověřen), nadpisy karet `text-[13px] font-bold` v barvě textu,
  trojcestné větvení `theme === 'oled' ? … : 'dark' ? … : …` u ploch/tooltipů
  → `--bg-card`/`--border-subtle`. Rituály a Monte Carlo má Filip v uloženém
  rozložení skryté (`visible:false`) — vizuálně neověřeno.
- **Fáze 2 · LIVE + Historie (hotovo):** 13 souborů LIVE/kopírky/historie —
  popisky na malá písmena (jen třídy, žádná logika kopírky), plochy historie
  (menu, seznamové zobrazení, hromadné tagy, slot snímku) z proměnných;
  štítky karet Validní/Nevalidní/Missed/Funded bez verzálek; nadpis stránky v
  horní liště (App.tsx) bez `uppercase`; LIVE ostrůvek (`.live-island-*`).
  ON/OFF na spínači kopírky ZÁMĚRNĚ ponecháno (značka spínače).
  **Nové globální pravidlo:** v Auroře `fixed inset-0` ztmavení modálů
  (`bg-black/…`, `bg-slate-950/…`, `bg-theme-page…`, ne pointer-events-none)
  dostane `backdrop-filter: blur(10px)` — průsvitná okna by jinak ukazovala
  ostrý obsah pod textem.
  Lint ověřen JSON porovnáním před/po (pozor: `eslint -f unix` v ESLint 9
  neexistuje a vrací prázdno).
- **Fáze 2 · ostatní stránky (hotovo):** 46 souborů (Síť, Portfolio/účty,
  Deník, Byznys, Lab, Insights, AI Coach, Nastavení, Graveyard, backtest
  dialogy, formulář obchodu, výplaty, modály, Sidebar/BottomNav, App.tsx
  přepínače záložek) — ~930 verzálkových popisků → malá písmena, 247
  větvení ploch podle tématu → `--bg-card`/`--bg-page`/`--border-subtle`,
  `Card` v Nastavení sjednocena. Nadpisy psané verzálkami přímo v textu
  (DENNÍ PŘEHLED, BACKTEST DENÍK, NOVÝ OBCHOD, ULOŽIT…, OTEVŘENÉ POZICE…)
  přepsány ručně; kurzíva + `tracking-tighter` u `<h1–h4>` pryč (styl starého
  „terminálu“). ZÁMĚRNĚ beze změny: Auth, sdílecí karty/stránka, grafový
  workspace a jeho dialogy, NativePrivacyGate, WorldShiftOverlay, popisky v
  grafu (ENTRY, LONG/SHORT), PDF export Deníku, ErrorBoundary. Ověřeno: tsc,
  4790 testů, lint parita, vizuálně světlé/tmavé/OLED.
  **Pozor při ověřování v živém náhledu:** „poslední `header button`“ je na
  Portfoliu „Potvrdit vybrané (27)“ onboardingu, ne přepínač motivu —
  tlačítka vybírat jen podle přesného `title`/`aria-label` (zápis nenastal,
  ověřeno SQL).
- **Sidebar + kalendář (dotaženo):** položky postranního panelu v Auroře
  bez vlastních bílých „kapek“ (`.glass-lens-light` 90 % bílá) — průhledné
  řádky ve skle panelu, najetí jemný tón, aktivní světlejší sklo (CSS
  `html.aurora .liquid-glass-lens…`, Sidebar.tsx beze změny). Kalendář:
  záhlaví dnů bez krabiček, stejná mezera jako mřížka (dřív `gap-3` vs
  `gap-2` = posunuté sloupce), dny se ziskem/ztrátou už ne plnou barvou —
  tón 8–40 % podle velikosti P&L, číslo v barvě výsledku; `.cal-cell` má v
  Auroře horní světelnou hranu. Detaily týdne/dne/obchodu přeloženy do
  češtiny (Týden N, Čistý výsledek, Exekuce, Výhry/Ztráty, Ranní příprava,
  Večerní review…, `tradeWord()` pro 1 obchod / 2–4 obchody / 5 obchodů);
  opraveny bílé texty neviditelné ve světlém tématu („N Trades“, MetricCell).
- **Nastavení — přestavba (hotovo):** podle náhledu `mockups/settings-control.html`
  (Filip zamítl oblé „iOS“ karty → hranaté `rounded-lg` jako zbytek appky,
  záložky nahoře ve stylu LIVE, bez dlaždic přehledu). Záložky
  `SettingsTab = 'trading' | 'tags' | 'alerts' | 'appearance' | 'app'`
  (Obchodování · Štítky · Upozornění · Vzhled · Účet a aplikace) se vykreslují
  přímo ve stránce (border-b-2 indigo jako LIVE); přepínač v hlavičce App.tsx
  zrušen, `alphatrade:open-native-system` → `'app'`. Hledání (klávesa `/`)
  prochází všechny záložky: `SettingsSearchContext` + `searchIndex` v
  Settings.tsx; sekce, která neodpovídá, se nevykreslí, v nalezené zůstanou jen
  odpovídající řádky. Prvky v `components/SettingsUi.tsx` (sekce, řádek,
  přepínač, segment, štítky s přidáváním v řadě) používají i
  TradingViewAlertSettings a NativeShellTabsSettings.
  Železná pravidla = tabulka se sloupcem **Dodrženo** (`lib/ruleAdherence.ts`:
  posledních 30 *vyhodnocených* dní, review má přednost před přípravou —
  kalendářních 30 dní by po pauze v deníku bylo prázdné); seance = časová osa
  s pruhem pro každou seanci + tabulka s délkou a překryvem
  (`lib/sessionSchedule.ts`, umí seance přes půlnoc); testy
  `tests/settingsHelpers.test.ts`. Testovací nástroje (snapshot, galerie iOS
  alertů, badge, Live Activity, haptika, kalendář, sdílení, diktování) jsou ve
  sbalené Diagnostice. **Barva zvýraznění zrušena**: picker pryč, App drží
  `data-accent="blue"` a maže `alphatrade_accent_color` (barvy pozadí řeší
  Vzhled). Vzhled: radius `rounded-lg`, řádky se na telefonu zalomí (dřív
  přetékaly). Ukládání dat beze změny.
- **Historie bez rušivých bloků:** stav načtení (`JournalImportStatus`),
  Podklady historie a archiv Neúplné záznamy už nejsou nad seznamem obchodů.
  Stav je malá ikona vedle ⋯ (`compact`; jen při problému / zpracování,
  zpráva + Obnovit v bublině), podklady a archiv jsou položky menu ⋯
  (`TradeHistory` props `toolbarStatus`, `menuItems`) a otevřou se v
  `HistoryPanelModal` rovnou rozbalené (`defaultOpen`). Bez obchodů (žádná
  lišta) se bloky dál ukazují na stránce — vysvětlují prázdnou Historii. LIVE
  je má dál dole beze změny. Aktivní položka bočního panelu v Auroře zjemněna.

### 2026-10-03 — Detail obchodu: skleněná vrstva, události u Průběhu (Claude)

Podle náhledu `mockups/trade-detail-glass.html` (Filip si vybral glass).
Větev `claude/trade-detail-glass-20261003` ve worktree
`/private/tmp/alphatrade-trade-detail-glass`, nasazeno 2026-10-04 jako `ed592837`.

- **Sklo jen jako vrstva:** okno detailu je průsvitné nad rozmazanou stránkou
  (`.td-modal`), levý sloupec má záři v barvě výsledku (`.td-side`, síla podle
  |R|), dlaždice/karty jsou jen průsvitné BEZ backdrop-filter (pod nimi je
  plynulá záře, blur by nic nezměnil a stál by GPU na telefonu). Skutečný
  blur mají jen věci nad grafem: lišta přehrávání, menu, seznam Průběhu.
  Bez vlastního přepínače i bez `prefers-reduced-transparency` (Filip:
  nestojí za údržbu; Safari/iOS ho stejně nepodporuje).
- **Hlavička:** „Validní“ pryč (výchozí stav = šum), ukazuje se jen
  „Nevalidní“; „Nezkontrolováno“ pryč, stav nese samo tlačítko Zkontrolovat.
  ‹ › sdílet ⋯ v jedné kapsli, zavřít zvlášť, bez svislých čar.
- **Výběr náhledu/grafu neutrální** (tmavý obrys) — zelená/červená jen pro peníze.
- **Průběh:** bubliny pod tlačítkem zrušeny (zakrývaly pravý horní roh grafu,
  kde se posouvá SL). Poslední událost se ukazuje vlevo od tlačítka Průběh
  (`TradeProgress`, „ostrůvek“), v grafu jen krátce problikne kroužek v místě
  události (`TradeEventPings`). Seznam má jednořádkové řádky (šíře 300 px).
  Varianty zamítnuté Filipem: událost v liště Bar Replay (lišta je
  přetahovatelná, zbytečně široká) a pruh na časové ose.
- Ověřeno: tsc (bez `extension/`, ve worktree chybí její node_modules),
  eslint beze změny počtu warningů, 39 souvisejících testů, náhled na 5273.
  Při ověřování jsem omylem klikl na „Snímek“ → k obchodu MNQ 2. 10. přibyl
  snímek grafu (Filip ho případně smaže sám).

### 2026-10-03 — LIVE na telefonu bez probliknutí, scroll stránek, pozice na pozadí (Claude)

Filip po nasazení fáze 1 (telefon): krátce problikne zapnutý účet, zapnutá
kopírka po návratu „najede“ jako při zapínání, svítí „Pozice neověřeny“,
a stránky po přepnutí v navbaru nezačínají nahoře.

- **Příčina mrknutí OFF→ON a přepínačů:** `TradovateLiveDesk` startoval
  s prázdným `copyGroups` → první snímek bez execution skupiny. Na webu
  neviditelné (klik = diskrétní událost, efekty před paintem), v iOS shellu
  navigace přes `window.__alphaTradeNative.navigate` → snímek se vykreslí.
  Reprodukce na webu: `?native=1` + `__alphaTradeNative.navigate('live')`.
  Oprava: start z `readCopyGroupCache`.
- **Scroll:** všechny stránky sdílí kontejner (`PullToRefresh`
  `[data-page-scroll]`) → reset `scrollTop` při změně `activePage`.
- **„Pozice neověřeny“ (varianta 1, rozhodnutí Filipa):** mimo LIVE se pozice
  čtou na pozadí po 30 s (jen s načtenými daty a appkou v popředí, ~4 req/min);
  bezpečnostní pravidlo „starý snapshot se netváří jako ověřený“ zůstává
  (test `liveCopyCompactRender`). Varianta s lhůtou zamítnuta kvůli němu.
- **„Stav neověřen“ po návratu:** obnovený stav workeru (≤ 10 min) se 1,2 s
  zobrazuje jako platný; příkazy zamčené do vlastního potvrzení, editor skupin
  validuje proti přísně čerstvému stavu.
- **Past iOS buildu:** worktree bez `.env.local` → bundle bez Supabase →
  věčný splash. Stavět s `.env.local`, kontrola `grep kopinlpdvjfgmvxydohk
  dist-native/assets/*.js`.

### 2026-10-02 — LIVE kopírka: načítání bez problikávání, fáze 1 (Claude, oponentura Codex)

Filip: na LIVE „naskočí data, pak problikne a až pak naskočí ON / DLL do konce
session“; studený start horší. Zadání a dohodnutý rozsah:
`docs/reviews/live-copier-loading-20261002.md` (měření, dvě nezávislé Codex
analýzy, povinné podmínky). Větev `claude/live-loading-20261002`; nasazeno
3. 10. 2026 (`4ec99534` na main, Vercel READY) + čistá reinstalace iPhonu.

- **Příčina probliknutí:** řádek účtu bral `eligibility?.state ?? 'active'` —
  před první odpovědí workeru ukazoval „Aktivní“. Nově „Ověřuji“ přes
  `WorkerEligibilityUnknownContext`; sloty přepínačů vyhrazené předem.
- **Nespolehlivost:** relay poll čekal na nejpomalejší spojení
  (`relayPoll.settled`) → stav workeru zestárl přes 15 s. Nově
  `runCopierRelayStatusRound` (první živý worker hned, zbytek na pozadí).
- **Návrat na LIVE:** stav workeru v paměti (`copierAgentStatusStore`) — jen
  zobrazení; příkazy kromě Flatten (a brzd přes vlastní cestu) čekají na
  čerstvou odpověď této instance. Úložiště se maže při odhlášení/změně uživatele.
- **Deadline čtení** pro read-only POSTy; execution zápisy beze změny.
  iOS popředí autoritativně z `@capacitor/app` (`lib/appForeground.ts`).
- Rozhodnutí: obnovený stav mladší 15 s se zobrazuje bez ztlumení (stejné
  pravidlo čerstvosti jako dosud; ztlumení by problikávalo při každém
  návratu). Pevné čekání a trvalý DLL zámek vědomě NE (viz review).
- Mimo rozsah, pre-existující: globální App brána při přímé změně účtu A→B.
- Localhost odhalil druhý zdroj: DLL se odvozuje z broker denního reportu
  (až plný preflight) a z plánů účtů; DISARMED worker hlásí `active`. Účty
  s nerozhodnutelným DLL (nebo před načtením plánů) jsou proto „Ověřuji“.
- Otevření LIVE bez rušivých efektů: detail skupiny vjížděl zprava
  (`live-detail-pane-in` i při mountu) — animuje se jen přepnutí Účty/Příkazy;
  „Přidat skupinu“ nešedne (knihovna skupin si pamatuje načtení, klik během
  prvního načtení otevře editor po dokončení); kolečko u přepínače kopírky až
  po 1,2 s ověřování; přepínače followerů zůstanou vidět zamčené („ověřuje se“).

### 2026-10-02 — Vstupní příkazy v grafu (varianta D) a nevzaté obchody (Claude)

- **Limity/stopy v grafu:** najetí jen animuje (jedna SL/TP linka, box jen
  po vyplnění, „kdybys nezrušil“ tečkovaně). Klik příkaz připne a detail
  ukáže seznam: v Hodnotit levý „Průběh obchodu“, v Historii dropdown
  „Průběh“ v grafu. Tooltip v grafu zrušen (překrýval obchod, dole vypadal
  jako chyba). Objevitelnost: kurzor ruky, „›“ v cedulce, nápověda
  „Klikni pro detail“ jen na první 4 použití (`at:entry-order-hint`).
- **Nevzaté obchody = samostatné karty**, ne součást následujícího obchodu.
  Patří sem jen zrušený vstup **s bracketem** (bez SL/TP se ignoruje —
  rozhodnutí Filipa), zadaný bez otevřené pozice, ne kopie kopírky. Leader
  bracket: ruční OSO nemá parentId → copylinky leaderova vlastního účtu
  (role stop/target) + záloha přes sourozence do 1 s.
- Import je best-effort ukládá do `tradovate_journal_untaken_orders`
  (migrace `20261002120000`, uživatel smí měnit jen sloupec `review`).
  Do statistik strategie ani P&L se nepočítají; Hodnotit chce jen důvod
  zrušení (návrh z dat podle výsledku „kdybys nezrušil“) a nepovinnou
  poznámku. Výsledek se při hodnocení ukládá jako snímek do `review`.
- Skutečný obchod drží jen svůj vyplněný vstupní příkaz. Starší uložené
  historie ukazují zrušené pokusy, dokud neproběhne nový import.
- Past (1cbb8397): neúplná epizoda bez výstupu se brala jako otevřená
  navždy — 7 leaderových ze 16.–17. 9. schovalo všechny pozdější nevzaté.
  Do nekonečna teď jen skutečně `open` pozice. Lokální sondy nad výřezem
  evidence to neodhalí, server projektuje celou historii.
- Ruční OSO (49d06f6e): Tradovate nedá dětem parentId a kopírka ve shadow
  módu nepíše vazby → obchod z limitu se SL/TP hlásil „bez SL/TP“. Obchod
  teď páruje SL/TP opačné strany do 1 s po vstupním příkazu (stejně jako
  detail příkazu); bracket příkazu = stav při vyplnění.
- Otevřené: 5 nevzatých na followerovém připojení (53157614, před 1. 10.)
  — ověřit, že to nejsou nepoznané kopie, až se objeví v říjnu.

### 2026-10-01 — Hodnotit: tlustá čára, přehrávač, dotyková gesta grafu (Claude)

- **Fronta Hodnotit jen od 1. 10. 2026** (Filip: měsíc starý obchod nemá smysl
  hodnotit) — `inReviewQueue` v `lib/tradeReviewFacts.ts`; starší obchody jdou
  otevřít jednotlivě z Historie, data v DB beze změny.
- **Přehrávač v hodnocení (web):** Bar Replay lišta je vidět hned, ▶/⏭ startuje
  15 min před vstupem, přepnutí obchodu replay ukončí.
- **Boční panely hodnocení scrollují** (položky se dřív flex-shrinkem mačkaly),
  rozbalování má pružnou animaci (obsah zůstává do konce sbalení).
- **Dotyk na grafu (telefon):** `services/chartTouchPriceAxis.ts` — `touch-action:
  none` na grafu (stránka se pod prstem nehne ani při dojíždějícím scrollu) +
  `vertTouchDrag: true` (lightweight-charts jinak zahodil každý tah strmější než
  ~27° → rychlé šoupání palcem „na chvíli nefungovalo“). Auto-scale drží cenu,
  tah po cenové ose roztahuje. Ověřeno Filipem na iPhonu.
- **Úklid:** Loss Day Debrief a automatický Daily Start pryč; dnešní předběžné
  svíčky doplněny jednorázově přes `supabase storage cp`; Documents převeden na
  main (stash `documents-dirty-tree-20261001` + záloha v AlphaTrade-backups).
- **Vlastní chyba:** f09271d5 commitnul `CapApp-SPM/Package.swift` s absolutními
  cestami z worktree (`git add -A` po `ios:sync`), opraveno v 6c2daec6.
### 2026-10-01 — Násobek followera: za vypnuté kopírky libovolně, za zapnuté vůbec (Claude, rozhodnutí Filipa)

Filip na telefonu nemohl zvýšit násobek: od prvního ARM dne platilo pro
násobek „jen snížit“ (tighten-only proti tiltu). Filipovo rozhodnutí: když je
kopírka VYPNUTÁ, násobek jde měnit libovolně (i zvýšit); když je ZAPNUTÁ,
nejde měnit vůbec — ani snížit (dřív snížení skupinu odzbrojilo). Vynucuje
worker (`applyGroup` odmítne změnu násobku za ARM), controller (tighten-only
pro násobek podle ARM stavu na začátku změny), relay a příprava ARM
(`isWeakerRiskConfig(..., { allowMultiplierIncrease })`); UI násobek za ARM
zamkne (telefon, tabulka, editor). Ostatní denní pravidla (DLL, cut,
maxContracts, okno, cooldown) dál jdou během session jen zpřísnit.
Doplněk 2. 10. (Filip): v LIVE (tabulka i karta na telefonu) je násobek jen
ke čtení v běžné velikosti; měnit jde výhradně v nastavení skupiny (editor
skupiny → účet → Násobek). Inline editor i telefonní list násobku odstraněny.

### 2026-09-30 — Hodnotit místo ručního zápisu, konec Guardiana, předběžné svíčky z TradingView (Claude)

**Rozhodnutí Filipa (produktové):** AlphaTrade se bude prodávat čistě jako
Tradovate kopírka → ruční zápis obchodu (včetně missed trades) i Guardian
(strict mode, DebtCollector, ranní dluh) jsou **pryč**. Místo „Zapsat“ je
„Hodnotit“: fronta `needsReview` obchodů z kopírky (sidebar, FAB, iOS tab
s badge, notifikace „Ohodnotit obchod“, Siri/Spotlight/widget/control).
Ceny z brokera se **neupravují** — fakta jsou zamčená; `ManualTradeForm`
zůstal jen jako editace existujícího obchodu.

**Obrazovka hodnocení** (`components/TradeReview.tsx`, návrh
odsouhlasený přes mockup): workspace graf + levý panel (výsledek, plnění
z Tradovate, „Tvůj plán“ = plánovaný SL/TP mění jen R, nikdy P&L; průběh
obchodu z historie plnění/ochran — hover zvýrazní bod v grafu; účty
s logy propek) a pravý panel (Podle plánu / Mimo plán, štítky jako
akordeon, poznámka). **Mimo plán** vyžaduje důvod + popis ≥ 5 znaků,
vyřazuje obchod ze statistik strategie, ale P&L účtu zůstává. Nová pole
`plannedStopLoss/plannedTakeProfit/invalidReasons/invalidNote` —
migrace `20260930200000_journal_review_plan_fields.sql` rozšiřuje whitelist
triggeru `protect_journal_trade_identity` (1. 10. spuštěna na produkci
a zapsaná přes `migration repair --workdir <worktree>`). Hotovo → animace + toast s „Vrátit“ (undo vrací
i `needsReview`).

**Opravená past:** kombinovaná skupina (`combined_<id>`) nese v `notes`
syntetický text „(Kombinováno z N účtů)“ — hodnocení i WeeklyReview ho
dřív mohly uložit do všech členů. Poznámka se teď bere ze zdrojového řádku.
Produkční data ověřena read-only: žádný poškozený řádek.

**Připomínky přípravy** (60/15 min před seancí) zůstaly — server by je
jinak posílal dál bez možnosti vypnutí; v Nastavení je sekce „Připomínky
přípravy“ místo „Alpha Guardian“.

**Předběžné svíčky:** Databento historical má data až ~24 h po trhu, takže
hodnocení dnešních obchodů nemělo graf. Worker po výstupu (65 s a 20 min)
read-only přes CDP přečte 1m svíčky z grafu TradingView (Filipův layout:
graf 1 = MNQ1! 1m, ~6 h), relay akce `bars` je uloží jako JSON do
soukromého bucketu `copier-snapshots` (`<user>/tv-bars/<UTC den>/`),
existující policy „vlastní složka“ stačí — bez nové tabulky. Klient
(`services/provisionalCandles.ts`) je použije v hodnocení i v detailu
obchodu, jen když Databento ještě nemá data; jinak „Graf dorazí zítra“.
Žádný Yahoo ani kostra grafu (Filip). **Jen zobrazení — nikdy do copieru.**
Chyba čtení/uploadu = log `TV BARS …`, nic neblokuje; vypnutí
`ALPHATRADE_TV_BARS=off`. Worker část začne platit až po reinstallu workeru
(obchodní den → čeká na „nasaď“).

**Review před pushem (nezávislý reviewer) a opravy:** „Vrátit“ volalo
handler se starým `trades` → nic nevrátilo (teď přes ref, prázdná pole se
vrací na neutrální hodnoty, `executionStatus` na `Valid`, protože trigger
`null` zahodí; toast sám zmizí po 8 s); předběžný graf se po prvním
neúspěchu už nezkusil znovu (retry 45 s, po druhém čtení workeru znovu);
typ výstupu se bere z objednávky, která výstup vyplnila (stop-market
skluz), záloha tolerance = 1 tick podle kořene a jen proti ochraně, která
ve chvíli výstupu ještě stála; plánovaný SL/TP na špatné straně vstupu
blokuje uložení; nová pole doplněna do `dashboardTradeFields`; cílený
`review()` (notifikace) při otevřeném hodnocení přepne obchod, rozepsané
hodnocení se ptá; staré soubory `tv-bars` (> 3 dny) server maže při uložení.
Svíčky sdílí limit snímků 12/min/zařízení — při 2 čteních na výstup stačí.

**1. 10., další úklid (Filip):** pryč je i Loss Day Debrief (automatické
okno při P&L < −250 USD s „Tohle se neuloží“) a automatický ranní Daily
Start rituál (6–12 h bez přípravy) — obojí vyskakovalo samo; ranní příprava
zůstává v Deníku. Z cronu zmizel testovací push „Alpha Guard: PŘÍSTUP
BLOKOVÁN“. Ponechané: připomínky přípravy 60/15 min (vypínatelné), push
k seancím, večerní review a sociální notifikace; pojistky copieru beze změny.

### 2026-09-30 — Review nasazené kopírky 061836f6 a opravy nejvážnějších nálezů (Claude)

**Nasazeno 30. 9. na Filipovo „nasaď“:** web acaf509d dopoledne; worker
a iPhone až večer (18:57), protože Filip mezitím kopírku zapnul a brána
reinstallu správně zastavila. Před reinstallem read-only reconcile vyčistil
divergenci leadera 65333277 po transport chybě; worker adoptoval durable
skupinu leader 65333343 + follower 65333277, po restartu reconcile čistý.
iPhone čistou reinstalací (znovu povolit oznámení).

Filip chtěl review celé nasazené verze (6 paralelních reviewerů, bez
Codexe). Výsledek a tabulka 25 nálezů: `docs/reviews/copier-deployed-review-20260930.md`.
Opraveno v pořadí, které Filip schválil (D1, A3, A2, A1, B1, Flatten dialog,
režim opravy), větev `claude/copier-review-fixes-20260930`; ověřovací review
našlo mezery v D1/A3/A2/B1 a ty jsou opravené v ae5213be, druhé kolo
(A3 replace, D1 cizí gap fill) v 064065d3; třetí kolo commit schválilo.
Známý kompromis A3: když leader zpožděný limitní reversal změní dřív, než se
vyplní, kopírka se vypne a on-fill followeři exit nedostanou (hláška to
říká) — lepší než dřívější zvětšení kopie na celý reversal. D1:
`observedOrderStatusesByAccount` bere jako známý i ruční order viděný před
výpadkem; drží to přesná shoda s cílem podle leadera.

Rozhodnutí a proč:
- **D1:** skutečný reconnect nekritické route v 10s lhůtě routeru dostane
  stejný route snapshot jako plánovaná obměna. Změna pozice followera v mezeře
  je v pořádku jen tehdy, když teď sedí na cíl podle živého leadera — přičítat
  gap filly k modelu nejde, model je může mít už z REST čtení (dvojí započtení).
- **A3:** zpožděný reversal kopíruje jen exit (risk-redukující), vstup pozdě
  ne; fail-closed až po dispatchi, u on-fill followerů až po fillu téhož orderu.
- **A2:** neškodná událost vyřazeného followera je jen Position 0 nebo
  canceled/rejected bez fillu u známého orderu. Tradovate Order(Filled) může
  přijít dřív než Fill s filledQuantity 0 — nikdy ho nebrat jako neškodný.
- **B1:** Flatten followera do konce obchodu vrací po durable přijetí + max 3 s
  `pending`; relay i FIFO agenta jsou sériové a brzdy z telefonu dřív čekaly
  až 90 s. Starší iOS shell `pending` nezná a ukáže falešnou chybu → při
  nasazení přeinstalovat i iPhone.
- **Režim opravy:** vyřazení bez flat důkazu jen explicitním uložením skupiny,
  nikdy v rámci ARM (E6); neaktivní (breached) optional účet se bere jako
  nedostupný jen při auditovaném vyřazení.

Neopraveno (další kolo): A4 samostatný TP před vyplněním limitního vstupu
followera, A5 rozpočet sweepu 6 s > limit stáří 5 s, A6 unhandled rejection
při ENOSPC, B2 souběžný liquidate nouzového Flattenu s hlavní lane, B3 ARM
během nouzového Flattenu, B5 ruční day-lock v obchodu nepřežije restart,
C1–C3 prop cap V15 (DLL jako zbývající rezerva, nerealizovaný zisk), D2
deadline obměny 15 s < sync 45 s, F2 odmítnutý ARM jako „nepotvrzené“, F3
toast po „Zrušit“, F4 starý výsledek Kontroly pozic. Pozice vzniklá na
vyřazeném followerovi bez order eventu se neodhalí ani při TP (starší).

### 2026-09-29 — Nasazení oprav kopírky (Claude, na Filipovo „nasaď")

- Web: main 34b8cda1 (Vercel READY), pak oprava 5f6bf7f2. Worker: reinstall
  z čistého release worktree, finálně 5f6bf7f2 (status `installation.gitSha`,
  dirty=false), DISARMED/flat/bez chyby. iOS: čistá reinstalace z 34b8cda1
  (web v appce shodný s 5f6bf7f2), oznámení znovu povolena.
- Při nasazení: breached leader 66142378 (+ followeři 66142377/81/82) shodil
  nový worker do crash loopu (launchd, 10 s). Služba zastavena, durable skupina
  „Hlavní“ zazálohována (`…64503883.group.json.bak-20260929-breached-66142378`)
  a přepsána na leader 64503883 + follower 65333343 (Filip pak v UI přidal
  65333277). Otevřené: breached/chybějící leader má nastartovat DISARMED
  s výběrem skupiny v UI místo crash loopu.
- Po úpravě skupiny ARM z UI padal v preflightGroupChange na čekající
  reconciliation → opraveno v 5f6bf7f2 (za DISARMED samotný požadavek na
  reconciliation změnu konfigurace neblokuje).

### 2026-09-29 — Balíček 7d: ověřovací opravy 7c/ST22 (Codex)

- Emergency `liquidatePosition` i `cancelOrder` se nyní evidují ve stejné
  per-account mapě raw broker write promise jako background follower cut. Ani
  timeout čekání, retry stejného `operationId`, nový Flatten, auto-close nebo
  leader-flat guard proto neposílá na účet druhý write, dokud první raw request
  skutečně nedoběhl. Chráněný účet je pravdivě v `failedAccounts` i
  `remainingPositionAccounts`; UI vypíše jeho ID a per-account chybu.
- Leader-flat diagnostika nese `failedAccounts`, background syntetickou chybu
  dostanou jen skutečně chráněné účty, ne-background cut neuloží `closed` po
  neúplném Flattenu a neúplný auto-close ukládá konkrétní `lastAutoClose.error`.
- Mac provenance guard bez výjimky povolí jen shodný SHA nebo candidate, jehož
  předkem je nainstalovaný commit. Downgrade, divergence/rebase a dirty candidate
  či instalace vyžadují dokumentovaný `--allow-downgrade`. Chybějící git nebo
  ne-git strom mají českou chybu; nečitelný starý manifest toleruje pouze flag.
  Worker čte manifest best-effort, zůstane DISARMED a status ukáže
  `provenance neznámá`, takže poškozená provenance neodstaví panic cestu.
- Regrese před opravou: 7c chráněný účet měl prázdné remaining účty a P4 retry
  poslal druhý liquidate; ancestry, dirty i best-effort testy také padaly. Po
  opravě cíleně `114/114`; úplný předepsaný copier gate `180 passed + 1 skipped`,
  `2135 passed + 1 todo`, exit 0. TypeScript s explicitně vyloučeným
  `extension/`, oba script bundly, `bash -n` a `git diff --check` prošly.
  Bez npm install/ci, commitu, push/deploye, reinstalu workeru, broker API nebo
  mutujícího lokálního agenta.

### 2026-09-29 — Balíček 7c + ST22 (Codex)

- Nouzový `flattenGroup`, běžný `flatten`, auto-close a leader-flat guard nyní
  oddělí účty s dosud běžícím/nejasným background broker write. Na chráněný
  účet neposílají druhý write, vrátí ho jako `ok:false`/nejasný a fail-closed,
  ale leadera a ostatní bezpečné účty dál zploští. Neúplný nebo odmítnutý
  emergency výsledek se pod `operationId` necachuje, takže po doběhnutí ochrany
  lze stejný příkaz znovu stavově ověřit bez blind retry.
- Mac instalátor ukládá do `install-manifest.json` plný git SHA, dirty příznak
  a čas instalace; worker provenance vystavuje v `/v1/status`. `mac-install.ts`
  i `mac-reinstall-safe.sh` odmítnou candidate HEAD, který je předkem (starší)
  nainstalovaného SHA, pokud operátor výslovně nepoužije `--allow-downgrade`.
- Regrese před opravami padaly na celovolací background bariéře a chybějícím
  modulu provenance. Po opravě: cílené 7c `247/247`, cílené ST22/agent `90/90`,
  celá kopírková sada `180 passed + 1 skipped`, `2127 passed + 1 todo`, exit 0;
  TypeScript bez `extension/` exit 0, oba instalační entrypointy bundle check
  exit 0 a shell syntax exit 0. Nic nebylo commitnuto, instalováno ani nasazeno;
  žádný broker ani mutující lokální agent endpoint nebyl volán.

### 2026-09-29 — Opravy kopírky podle ultra review: stav integrace (Claude + Codex)

- Všechny opravy jsou v integrační větvi `codex/copier-release-20260929`
  (worktree `/private/tmp/alphatrade-copier-release-20260929`, HEAD po sloučení
  balíčku 12). Celá sada kopírky 179 souborů / 2122 testů zelená. NIC NENASAZENO:
  produkční worker, web i iOS jsou beze změny; nasazení jen na Filipovo „nasaď“,
  z čistého stavu DISARMED + flat + reconciled a mimo obchodování.
- Přehled balíčků a otevřených bodů: `docs/reviews/copier-fixes-20260928.md`.
  7c/7d a ST22 doplněny (bd4b5953, sada 2135/2135, build OK). Otevřené:
  UI tlačítko Kontrola pozic + relay allowlist, ověřovací review posledních iterací (V12 v6, V13 v6,
  6c, 8c, 9b, 12) a závěrečné integrované review, sloučení s origin/main.
- Politiky zvolené bezpečnější variantou (Filip může změnit):
  P-A změna velikosti/topologie při otevřené pozici se odmítne bez DISARM;
  P-B znovuzapnutí followera a on-submit/on-fill nejsou tighten-only porušení
  (worker vyžaduje flat); V15 prop rezerva dynamicky snižuje cut místo zavírání
  kopie v zisku; ST19 ARM vyžaduje čerstvý risk snapshot jen u followera s risk
  pravidlem; Kontrola pozic za ARM nejdřív auditovaně vypne (kromě
  management-only, kde se odmítne); zdravý follower dostane exit i když jiný
  diverguje (skupina se pak vypne). Neřešeno, čeká na Filipa: ST5, ST17, ST18,
  ST21, ST26, V14.
- Nasazení (až na „nasaď“): sloučit s aktuálním origin/main, reinstall workeru
  `scripts/copier/mac-reinstall-safe.sh` z ČISTÉHO stromu integrační větve
  (guard nově odmítne dirty strom, downgrade i sourozeneckou větev), push na
  main = web, pak iOS build. První instalace ještě nemá manifest pro porovnání.
- Lekce: exporty repa z review zaplnily disk (30 GB) — viz paměť; sémantické
  konflikty při slučování paralelních větví (V12 per-follower dispatch vs 7b
  write-ahead store) zachytila až celá sada — po každém merge ji spouštět.

### 2026-09-29 — Balíček 8c: ověřovací opravy V15, in-place cutu a background lane (Codex)

- V15 už nikdy neodvozuje otevřenou ztrátu z `cashBalance.amount − netLiq`.
  Použije pouze přímé broker `openPnL`; čerstvý streamový flat stav vynutí
  open loss 0. Chybějící open P&L se pro reserve cap hodnotí konzervativně
  jako 0, aby se PR5 (realized ztráta už obsažená v net liq) neschovala
  dvojím odečtem realizované ztráty.
- Produktová politika prop-reserve: menší rezerva už config neodmítne ani
  okamžitě nezavře ziskovou kopii po zvýšení trailing flooru. Runtime durable
  a tighten-only sníží absolutní denní cut na nejvýše aktuální loss + 95 %
  rezervy, vydá auditní upozornění a v téže session cap po restartu ani při
  pozdějším růstu rezervy neuvolní. Close-copy nastane až když součet dnešní
  realized a přímé otevřené ztráty dosáhne capu. Produkční `/cashBalance/deps`
  obvykle neposílá `netLiq` ani `openPnL`; V15 tam proto reálně hlídá realized
  loss a cash-derived vzdálenost od flooru, ale bez těchto polí nevidí
  nerealizovanou ztrátu otevřené pozice.
- In-place let-run→close-copy počítá kandidáty až uvnitř `eventTail`, změnou
  `groupRevision` zastaví starou lane, počká na už rozběhnutý zápis daného
  účtu a teprve potom zavírá. Let-run lane před každým cancel write ověřuje
  revision i aktivní cut. Za ARM používá per-follower scoped failure a emituje
  follower-cut event; SHADOW neposílá cancel/liquidate. Syrové
  `disableReplicationOnBreach=false` už není tighten-only porušení, protože
  sanitizer/runtime hodnotu stejně vždy vynutí na true.
- Nové regrese před opravou padaly pro přímé `openPnL`, PR1/PR2, PR5,
  dynamický cap, bootstrap, scoped failure, SHADOW a raw config. Merge race
  bez lane broker bariéry provedl 2 cancel write místo 1. Po opravě cíleně
  184/184 a širší controller/risk blok 195/195. Předepsaná copier sada prošla
  174 souborů + 1 skipped, 2056 testů + 1 todo; dynamic routing 5/5, exit 0.
  Root `tsc --noEmit` hlásí jen povolené chyby `extension/`; typecheck bez
  extension prošel exit 0. Bez npm install/ci, commitu, push/deploye, broker
  API, ARM/Flatten produkce nebo reinstalu workeru.

### 2026-09-29 — Balíček 12: pravdivé DISARM důvody a autoritativní bariéry (Codex)

- Všechna controllerová vypnutí teď používají jeden durable záznam
  `disarmHistory` (max. 20 položek) se stabilním kódem, technickým detailem,
  výsledkem kopií a volitelným ID leader epizody. Ruční `reconcile` za ARM
  nejprve auditovaně DISARMne kódem `reconcile-request` a pak provádí jen
  broker read; odmítnutí/požadavek kontroly se nevydává za FAIL-CLOSED.
- Klasifikace rozlišuje config/route/prop/divergence, `host-sleep`, selhání
  leader-flat čtení a leader-flat guard. Výsledek později potvrzeného guardu
  se doplňuje jen do stejné epizody. DISARMED divergence pouze zneplatní
  reconciliation a zapíše audit, ale nepřepíše poslední příčinu vypnutí.
- Pilot porovnává wall clock s monotónním časem. Po uspání zůstává bezpečně
  DISARMED, status nese čas, od kdy Mac neodpovídal, ale skutečné broker
  spojení se nefalšuje jako odpojené. Leader-flat REST čtení mají 2,5s
  deadline a chybové/non-flat výsledky už netvrdí, že leader byl flat.
- Follower toggle už nepoužívá pětiminutovou časovou brzdu: změnu dovolí až
  dvě shodná read-only kola flat/no-working/no-pending pro leadera a dotčený
  účet. Vypnutí ignoruje ARM/incident blokery, ale ne neověřený broker stav;
  zapnutí zůstává přísné. Existující controller `reconcile` je použitelný pro
  budoucí UI tlačítko bez nového write příkazu.
- Ručně vypnutý follower chybějící v OAuth je při startu optional a dostane
  startup audit; zapnutý chybějící účet zůstává povinný. ARM účtu s DLL cutem
  vyžaduje čerstvý bezchybný risk snapshot stejné Tradovate session.
- Venue-managed navýšení nativního STOP/targetu je výjimka jen při přesné
  working coverage autoritativně načtené pozice. Runner neposílá zastaralé
  množství zpět; celý working OSO pár přejde do management-only. Chybějící,
  nepracující nebo nadměrná ochrana dál vede fail-closed/auto-close.
- ST22 (instalační provenance/downgrade) nebyl měněn: podle dělby práce patří
  paralelnímu balíčku 8b. Nebyl proveden commit, instalace workeru, broker write,
  deploy ani změna extensionu.
- Ověření: předepsaná copier sada 2038 passed / 1 todo (174 files passed,
  1 skipped), dynamic routing 5/5, disarm/live 165/165 po závěrečném doplnění
  klasifikace a cílená sada 364/364. Čtyři lokální HTTP soubory nejprve v
  sandboxu spadly na `listen EPERM`; mimo socket sandbox prošel každý 3×.
  `npx tsc --noEmit` hlásí pouze ignorované `extension/` chyby chybějících
  Chrome typů a `@crxjs/vite-plugin`; mimo extension nevypisal chybu.

### 2026-09-29 — Balíček 6c: oprava N1/N2 z ověřovacího review 6b (Codex)

- Leader-flat snapshot nyní čte pozice → ordery → pozice. Filled OSO parent
  nad stabilně flat followerem už není sám o sobě nekonzistence a doložená
  osiřelá noha se sweepne; race je pouze změna pozice mezi čteními nebo parent
  fill novější než první position read. Nejvýše dva retry mají read-only
  backoff 25/50 ms. Read-only watchdog při nejistotě nebo nalezené owned noze
  epochu durable zablokuje bez broker write, takže heartbeat nevyrábí smyčku.
- Nekonzistentní účet je v batchi `ok:false`, ale už neukončí celý guard:
  ostatní doložené orphan kopie mohou dostat symbolově cílený auto-close.
  Exit evidence je znovu account+symbol; lineage dál omezuje pouze sweep a
  kontrolu owned osiřelých noh.
- Dodané sondy byly převedeny na 14 asertovaných regresí včetně R6/R6x/R6r,
  R9-noLineage, počtu chyb po heartbeatech a doplňkové R6i pro nekonzistentní
  účet vedle otevřeného followera. Před opravou padaly 4/13 (R6, R6x, R6r,
  R9-noLineage); po opravě cíleně 35/35 a širší controller sada 249/249.
  Předepsaná copier sada mimo sandbox prošla 170 souborů + 1 skipped,
  1960 testů + 1 todo, exit 0. Sandboxový běh měl pouze 89× známé
  `listen EPERM 127.0.0.1`. Root `tsc --noEmit` hlásí výhradně povolené
  chybějící Chrome/CRX typy v `extension/`, žádnou chybu mimo extension.
- Bez commitu, push/deploye, instalace závislostí, broker API, ARM/Flatten ani

### 2026-09-29 — Balíček 7b: durable background flatten a account write fence (Codex)

- Background follower cut už nepoužívá izolovaný memory store pro outbox:
  každý `planned`/`sending`/výsledek cancelu či liquidation se před broker
  write synchronně slučuje přes hlavní serial processor a durable store.
  Selhání commitu broker write zastaví a celý runtime zůstane fail-closed;
  restart u `sending` provádí jen read-only stavové dohledání, nikdy druhý
  slepý liquidate.
- Per-account lane fence nyní blokuje/odmítne reconcile, běžný Flatten,
  auto-close, leader-flat recovery i cut re-run, dokud může na stejném účtu
  běžet background broker write. DISARM, kill, shutdown a stop přeruší wait a
  potvrzovací čtení, durable uloží `indeterminate` a `waitForIdle` nečeká na
  90s deadline. Pozdní návrat po zneplatněné bariéře nemění `closed` ani
  novější cut; pouze vynutí reconciliation. Outbox aktivní lane je neblokující
  jen pro dispatch jiných followerů, takže P4 latence zůstala zachovaná.
- Serial processor reloaduje jen po explicitně označené chybě/nejistotě
  commitu, automaticky nejvýše 3× s exponenciálním backoffem. Po vyčerpání
  zůstane `failed`, ARM je blokovaný, ale `waitForRecovery`/`waitForIdle`
  resolvne; risk-snižující auto-close v `reloading/failed` používá nativní
  izolovanou emergency lane.
- Review sondy P1–P5b byly převedeny na aserce. Na exportu báze `bf76e24`
  prošel P1; padly P2/P3/P4/shutdown/P5b a policy-reload regrese. P5a už na
  bázi broker write zablokoval, ale nesplnil nový přesný durable-state assertion.
  Nový stav cíleně prošel 140/140. Předepsaný plný gate měl v sandboxu jen
  89 `listen EPERM 127.0.0.1` pádů ve 4 loopback souborech (165 passed + 1
  skipped); stejné 4 soubory mimo sandbox prošly 94/94. `npx tsc --noEmit`
  hlásí jen ignorované Chrome/CRX chyby v `extension/`; stejný root typecheck
  s vyloučenou `extension/` prošel, `git diff --check` čistý. Bez commitu,
  push/deploye, broker API, ARM/Flatten, reinstalu workeru či instalace balíčků.

### 2026-09-29 — Balíček 7: background follower cut a zotavení durable CAS (Codex)

- Ruční „Flatten followera do konce obchodu“ i broker/ledger DLL close-copy
  nyní po krátkém durable admission běží mimo `eventTail`. Aktivní cut okamžitě
  vyřadí účet z nových vstupů, zatímco leader exit/ochranné změny ostatních
  followerů pokračují. Broker lane má produkční 90s celkový deadline, 10s
  per-call deadline, omezené read-only konfirmace s backoffem a jediný
  liquidate pokus; nejistý výsledek se uloží do hlavního outboxu a skončí
  fail-closed. Návratová bariéra ověřuje safety/group/connection/trade epochu,
  aktivní cut, ARM a kill latch; DISARM/kill nečekají na běžící broker call.
- Serial processor po odmítnuté operaci zastaví další mutace a načte čerstvý
  durable snapshot včetně nové CAS revize. ARM se po dobu reloadu explicitně
  odmítá; neúspěšný reload lze znovu vyvolat přes reconciliation. Tradovate
  native emergency Flatten zůstává v izolované lane bez závislosti na stale
  processor CAS. Regrese simuluje post-commit výjimku: ARM je do odblokování
  loadu zamítnut, Flatten účtu projde a po reloadu + reconciliation lze znovu
  ARM.
- Dvě základní regrese před opravou padaly (leader exit čekal za liquidate;
  ARM po post-commit chybě neměl durable-reload blokaci). Po opravě cíleně
  prošlo 154/154 a širší controller sada 406/406; agent mimo sandbox 66/66.
  První kompletní copier gate měl jediný známý timing pád V13 B6/R6
  (1960 passed, exit 1); izolovaný test dal 2/3, celý V13 soubor potom 3×
  32/32 a opakovaný kompletní gate prošel 169 souborů + 1 skipped,
  1961 testů + 1 todo, exit 0. Root `tsc --noEmit` má pouze povolené chyby
  Chrome typů a `@crxjs/vite-plugin` v `extension/`; `git diff --check` čistý.
  Bez commitu, push/deploye, instalace závislostí, broker API, ARM/Flatten ani
  reinstalu workeru.

### 2026-09-29 — Balíček 9b: V6 renewal/order parity, agregovaný resync a fail-closed snapshot (Codex)

- Během plánované obměny se dál potlačují pouze Fill a Position entity;
  Order lifecycle jde live cestou před route snapshotem, takže nový OCO SL/TP
  i posun SL projdou existujícím durable runnerem. Jakýkoli leader gap fill je
  divergence. Zbylá divergence s follower expozicí zakládá stávající
  `pendingConnectionRecovery`; nevznikl doháněcí trade ani nový write retry.
- Router předá scoped `resynced` jen nad `aggregateConnected=true` a controller
  dílčím resyncem nikdy nepřejde z disconnected na connected. Renewal blocker
  vidí přijaté eventy čekající v `eventTail` a používá oddělené monotónní hodiny
  pro 5s klidové okno po dokončení každého leader trade eventu; první verze
  omylem posouvala testovací trading clock a rozbila 5ms OCO korelaci, což
  odhalila plná sada a následná oprava prošla izolovaně 3×.
- Renewal snapshot už nevolá `/account/list`, skládá jen otevřené ordery účtů
  svěřených route a terminální/cizí neúplné ordery přeskočí. Skutečně
  nesložitelný otevřený route order nebo jiné selhání snapshotu se předá jako
  neautoritativní `resync` a controller skončí `route-gap-divergence`; nový
  synchronizovaný socket se kvůli tomu neroztáčí a nespotřebovává další
  syncrequesty.
- Sondy PA–PM byly převedeny do `tests/review/` a doplněny o přesné 5s okno
  a nekompletní open-order snapshot. Na 48a8163 padalo 11/14 původních sond;
  po opravě prošlo všech 16 finálních asercí. Změnová sada 183/183 a finální
  předepsaná copier sada mimo sandbox 173 souborů + 1 skipped, 1998 testů +
  1 todo, exit 0. První sandbox full run měl 91 `listen EPERM` pádů a jednu
  skutečnou clock regresi; ta byla opravena, neoznačena za flake.
- Finální `npx tsc --noEmit` končí exit 2 pouze na povolených chybějících
  Chrome typech a `@crxjs/vite-plugin` v `extension/`; root-only typecheck bez
  extension prošel exit 0. Bez commitu, push/deploye, npm install/ci, broker
  API, ARM/Flatten nebo reinstalu workeru.

### 2026-09-29 — Balíček 9: V6 route-gap resync po obměně spojení (Codex)

- Obměna Tradovate spojení nyní sestaví read-only snapshot dotčené route
  (účty, pozice, working ordery a filly vzniklé v mezeře). Gap fill se nikdy
  nepřehraje do živého event streamu; router předá `resynced` samostatně pro
  každé spojení i během follower grace okna a snapshot omezí na jeho účty.
- Controller porovná pouze účty dotčené route se svým lokálním modelem.
  Shoda zachová ARMED, neshoda nebo leader order poprvé viděný až jako filled
  skončí fail-closed důvodem `route-gap-divergence`, bez doháněcího broker
  write, auto-close nebo blokování jiné route. Pro následný refresh používá
  existující V12 `scheduleRouteEpochRefresh`; nevznikl druhý refresh mechanismus.
- Scheduler obměn respektuje hard blockery auto-close, recovery/reconciliation,
  rozpracovaného durable outboxu a OSO korelace nezávisle na ARM. Jedno spojení
  obnovuje nejdřív po 50 min, při otevřené pozici nejpozději po 70 min, route
  jsou rozložené nejméně o 30 s a plánovaná obměna nepoužívá reconnect backoff.
- Před opravou cílená sada měla 6 pádů: chyběl scheduler, čistá obměna
  DISARMovala, divergence ani leader gap fill neměly nový důvod, router zahodil
  `resynced` a broker neměl snapshot. Po opravě cílená/sousední sada prošla
  323/323. Předepsaná celá copier sada mimo sandbox prošla 171 souborů + 1
  skipped, 1980 testů + 1 todo, exit 0; první sandbox běh měl pouze 91
  `listen EPERM 127.0.0.1` pádů. Root `tsc --noEmit` končí exit 2 pouze na
  povolených chybějících Chrome typech a `@crxjs/vite-plugin` v `extension/`.
  Bez commitu, push/deploye, instalace závislostí, broker write, ARM/Flatten
  ani reinstalu workeru.

### 2026-09-29 — Balíček 6b: review regrese leader-flat/auto-close/ST4 (Codex)

- Leader-flat guard čte pro každý účet sekvenčně ordery a až potom pozice.
  Vyplněný vlastní OSO parent s nulovou pozicí a stále aktivní ochranou je
  nekonzistentní snapshot: nejvýše 3× se opakuje pouze read, pak fail-closed
  bez cancelu. Ochranné nohy i exit evidence guardu jsou omezené na entry
  linii dané epochy; pending dítě otevřeného nevyplněného OSO parentu používá
  stejnou výjimku jako sweep a nezpůsobí falešný DISARM.
- Auto-close stopa participujícího followera zahrnuje aktuálně otevřené symboly
  leadera. Expozice mimo doloženou stopu se nikdy nevydá za flat: zůstane
  nedotčená, vznikne blocked audit + onError, výsledek je unknown a durable
  `liveCopyOpenSince` se nemaže. Reconciliation má třetí omezený pokus, aby
  vlastní sweep cancel nespotřeboval jedinou rezervu pro živý stream event.
- Review sondy PA/PB/PC a P1/P1c/P2–P6 byly převedeny na aserce. Před opravou
  cílený soubor reprodukoval 7 pádů; po opravě 22/22, sousední sada 105/105.
  Předepsaná celá copier sada mimo sandbox finálně prošla: 169 souborů + 1
  skipped, 1946 testů + 1 todo, exit 0. První sandbox běh měl 89 očekávaných
  `listen EPERM 127.0.0.1` pádů a 1 skutečnou epochovou regresi; ta byla
  opravena. Časový B6/R6 jednou padl v plné sadě a 1/3 prvních izolovaných
  běhů, potom celý soubor prošel 32/32 třikrát a finální plná sada byla čistá.
- Root `tsc --noEmit` má pouze povolené chyby Chrome typů a
  `@crxjs/vite-plugin` v `extension/`; controller/testy jsou bez TS chyby.
  Bez commitu, push/deploye, instalace závislostí, broker API, ARM/Flatten ani
  reinstalu workeru.

### 2026-09-29 — Balíček 8b: review V1/V3/V15, politika P-A/P-B (Codex)

- Rozhodnutí P-A: změny velikosti/topologie (`multiplier`, `maxContracts`,
  replikační mode, účty, leader) se za otevřené pozice dál odmítají ještě před
  DISARM s českou hláškou, že uložení jde jen ve flat stavu a běžící kopírka
  zůstává na starém nastavení. In-place změna násobku uprostřed obchodu se
  nezavádí, protože by vytvořila zbytek pozice. Rozhodnutí P-B: ruční re-enable
  followera a přechody on-submit/on-fill nejsou session tighten-only porušení;
  worker je dál pustí jen po dvojím read-only flat/no-working ověření. ST17
  baseline množiny účtů zůstává otevřený.
- Metadata cesta má explicitní whitelist `name`, `color` a pouze zpřísňující
  safety změny. Vypnutí `autoCloseFollowerPositions`, `preventHedging`,
  `positionReconciler` nebo `disableReplicationOnBreach` je oslabení a po
  prvním LIVE ARM se odmítne bez persistence, DISARM či runtime mutace.
  Přidání/snížení follower cutu a let-run→close-copy mají oddělenou in-place
  cestu serializovanou na `eventTail`; aktivní let-run cut se opravdu dokončí.
- Relay mapuje stale follower `enabled` z runtime skupiny jako worker, P-B
  příkazy neblokuje a risk-snižující `enabled=false`/`mode=off` pustí i bez
  čitelného baseline; worker zůstává autoritou. SHADOW ARM→LIVE už není no-op.
- V15 odečítá z cut prostoru realizovanou i otevřenou ztrátu odvozenou jako
  `max(0, cashBalanceUsd - netLiq)`, takže stejný open P&L není započten dvakrát
  proti rezervě založené na net liq. `prop-reserve` vždy používá close-copy i
  při uživatelském let-run; bezpečnější jednoduchá varianta nenechá pozici nad
  likvidací bez leader exitů.
- Connection/error a budoucí `resynced`/`route-gap` zvyšují ingress control
  verzi, durable follower toggle ji kontroluje a při race vrátí původní zápis.
  Heartbeat release ručního trade cutu čeká už při jediném queued trade eventu.
  Poslední group preflight je před durable CAS; event během fsyncu proto
  dokončí konzistentní DISARMED přepnutí místo staré group nad clean stavem.
- Převzaté sondy před opravou reprodukovaly očekávané pády A1/A1b/A2/A3/A,
  D(-100/-150), R1-R5 a post-commit stav; heartbeat regrese po dočasném návratu
  staré podmínky také padla. Po opravě cíleně prošlo 254/254 a navazující
  risk/adapter sada 97/97. Předepsaná plná copier sada: 169 souborů prošlo,
  1 skipped; 1978 testů prošlo, 1 todo, exit 0. `dynamicBrokerRouting` 5/5,
  exit 0. `npx tsc --noEmit` hlásí jen povolené staré chyby `extension/`
  (Chrome typy a `@crxjs/vite-plugin`); stejný root typecheck s vyloučenou
  `extension/` prošel exit 0. Bez commitu, push/deploye, npm instalace,
  broker API, ARM/Flatten produkce či reinstalu workeru; `brokerRouter.ts`
  zůstal beze změny.

### 2026-09-29 — Balíček 8: V1 transakční config, V3 scoped fence a V15 prop-reserve (Codex)

- Pracovní větev `codex/copier-config-20260929`, bez commitu/deploye/reinstalu
  workeru. Změna konfigurace se nyní nejprve sanitizuje, ověří proti
  tighten-only, streamovým blockerům a routing dry-runu bez `replaceRoutes`.
  Odmítnutá změna zachová zdravý ARM. Execution změna teprve potom provede
  DISARM s důvodem `config-change` a dvě read-only autoritativní kola; selhání
  po DISARM zůstává vypnuté bez auto-ARM. Metadata a neexpoziční pravidla jdou
  samostatnou cestou a ARM neruší.
- Relay odmítá 409 ještě před enqueue, pokud zvýšení násobku, aktivace
  followera nebo změna replikace poruší session tighten-only. Agent loguje
  původ příkazu (`loopback`/`relay`/`internal`) bez payloadu.
- Heartbeat už nezvyšuje broker-state fence ani pending trade count. Follower
  toggle i změna skupiny čtou REST mimo `eventTail`; výsledek se aplikuje až
  za mezitím přijatými eventy s kontrolou account-scoped verzí, connection,
  safety generation a group revision. Dvě read-only kola jsou pod limitem tří
  a nikdy neopakují broker write. Skutečný order/position/connection event
  změnu dál odmítá fail-closed.
- V15 porovnává `dailyLossCutUsd - dnešní realizovaná ztráta` s `0,95 ×`
  čerstvé aktuální prop rezervy ve stejné Tradovate session. Disabled/off nebo
  už cutnutý follower se vynechá. Periodický breach založí per-account cut se
  zdrojem `prop-reserve`; skupina zůstává ARM podle §3.3, kromě existujícího
  invariantního fail-close při neznámém broker write výsledku. Neplatný čerstvý
  snapshot při bootstrapu už neukončí proces: runtime startuje DISARMED s
  `lastDisarm.code=prop-reserve`.
- Regrese před opravou reprodukovaly: keepalive falešně rušil fence, nízká
  rezerva vypnula celou skupinu, bootstrap vyhodil výjimku a odmítnutý config
  po předčasném DISARM zůstal vypnutý. Po opravě cíleně prošlo 221/221
  controller, 117/117 V3/V15/routing/reason a 113/113 agent/relay testů.
  Přesná plná copier sada: 169 souborů prošlo, 1 skipped; 1952 testů prošlo,
  1 todo. UI/lib disarm/liveCopy: 15 souborů, 159/159. `npx tsc --noEmit`
  hlásí jen výslovně ignorované chyby `extension/` (chybějící Chrome typy a
  `@crxjs/vite-plugin`), žádnou chybu v kořenovém copier kódu.

### 2026-09-29 — Balíček 3a-6 V12 šestá iterace: rychlý fan-out a bounded S1b settlement (Codex)

- S1b multi-follower redukující Market znovu posílá účty bez REST kandidáta
  jedním `processor.process` fan-outem; followeři čekající na read-only důkaz
  běží odděleně a nikdy nejsou před rychlou skupinou. Při souběžném ingress
  backlogu se zdravý účet odloží a po unsafe readu jiného účtu se neposílá.
- Timeout cíleného readu/cancelu má nejvýše 3s stream settlement okno. Fill
  vyžaduje čerstvé ověření pozice, zero-fill terminál suppressne exit a
  neověřený výsledek haltne. Pozdní fill haltnuté kopie při flat leaderovi je
  fail-closed orphan incident podle stávající auto-close politiky.
- DISARMED/shadow větev nedělá S1b REST ani cancel; cancel jde přes
  `dispatchBroker` a nikdy se naslepo neopakuje. Post-cancel používá exact
  `findOrderById`, fresh `listOrders` a terminální status fallback pro brokery
  bez `OrderVersion`.
- Reconciliation conditional lookup je bounded a jeho chyba pouze označí
  účet divergentní/fail-closed; S1b a conditional pomocné mapy se uklízejí
  na terminálu, authoritative flat reconcile a stop/disconnect.
- Nové regrese na původním `fb3459b`: hlavní sada měla 9/10 pádů a fresh
  Tradovate test padal; opravený S1bSLOW izolovaně rovněž padal bez market
  exitu. Po změně 61/61 nových+mapping, cílený průřez 423/423 a povinná sada
  1969 passed + 1 todo (exit 0). První sandboxovaný úplný běh měl 89 pádů
  pouze kvůli `listen EPERM 127.0.0.1`; mimo sandbox prošel. `tsc --noEmit`
  má exit 2 výhradně kvůli ignorovanému `extension/` (`chrome` typy a
  `@crxjs/vite-plugin`); v měněných souborech TypeScript chyba není.
- Změny zůstávají necommitnuté; nebyl proveden push, deploy, broker akce ani
  instalace závislostí. Jediný dočasný baseline worktree byl odstraněn.

### 2026-09-29 — Balíček 3a-5 V12 pátá iterace: ověřené cancely a podmíněná lineage (Codex)

- S1b je per-follower: zdravý follower dostane Market exit bez čekání na
  pomalý účet; `unsafe` haltne bez cancelu. Risk-snižující cancel má deadline
  1 s, nikdy se neopakuje a jediný následný snapshot `listOrders +
  listPositions` rozliší zero-fill terminal, plný fill a parciál. Pozdější fill
  autoritativně zero-fill zrušené kopie failne okamžitě. Více opačných pending
  kopií zůstává bez zápisu fail-closed.
- Podmíněné zápisy nesou leader order ID, multiplier, zdrojovou qty/fill a čas
  dispatch. Legitimní zrcadlený nebo pozdější fill vazbu tiše uvolní; skutečné
  vyvrácení ruší právě jednou jen risk-zvyšující non-Market order nad flat nebo
  stejně orientovanou pozicí, nikdy ochranný order nad otevřenou pozicí.
  Vazby přežívají disconnect/error a vyhodnotí je reconnect REST, cílené čtení
  i epoch refresh. Async reject Market zdroje a copied-exit reverse mají
  samostatné fail-closed důkazy a audit rozlišuje cancel/fill.
- Route-epoch refresh ignoruje `evidenceInvalid`, běží jen za ARM, má jeden
  pokus na dvojici epoch a nejméně 30s backoff. Snapshot nesmí přepsat novější
  S1b read ani změněnou epochu. Market pending obchází pouze backlog vlastních
  přesných order/fill klíčů; starý potvrzený modify tvar po přijetí aktuálního
  tvaru už není platný a vypadlá bounded klasifikace defaultuje bezpečně na
  `copied-entry`.
- Nový 12testový regresní soubor proti čistému HEAD `b347d53` před opravou
  skončil 12/12 červeně (11 společně, reconnect audit zvlášť); po opravě 12/12.
  Staré K4/Z10/V16 očekávání byla upravena podle nové specifikace (halt bez
  cancelu, per-follower dispatch). B6/R6 prošel izolovaně 3/3 a v závěrečné
  plné sadě také, takže review pád byl zátěžový wall-clock flake bez změny kódu.
- Předepsaná kompletní copier sada: 166 souborů zelených + 1 skipped, 1868
  testů zelených + 1 todo; 89 testů ve čtyřech loopback souborech spadlo pouze
  na sandboxovém `listen EPERM 127.0.0.1` (exit 1). Všechny controllerové
  regrese jsou zelené. `npx tsc --noEmit` hlásí jen povolené chybějící Chrome
  typy a `@crxjs/vite-plugin` v `extension/`; `git diff --check` čistý.
- Bez commitu/pushe/deploye, npm install/ci, Supabase změny, broker write,
  ARM/Flatten nebo reinstalace workeru. Dočasný baseline export byl odstraněn.

### 2026-09-29 — V13 šestá iterace: obnovitelný cancel tombstone, OSO parent a okamžitý sibling cleanup (Codex, balíček 3b-7)

- Nejasný flat-sweep cancel už nezablokuje broker order navždy: do nového
  autoritativního account snapshotu zůstává write zakázaný, ale čerstvé
  `flat + working` dovolí jediné nové risk-redukující rozhodnutí. Tombstones
  se uzavírají terminální/absent evidencí a mažou při reconciliation i
  runtime resetu; stejný kontrakt platí pro exit-only cleanup. Žádný cancel
  se neopakuje bez nového read-only snapshotu.
- Flat sweep před terminálním early returnem kontroluje stream-only stav OSO
  parentu. Když ruší poslední živé děti otevřeného parentu, zruší s nimi
  i parent; otevřený leader remainder je hlasitá fail-closed divergence.
  Opožděný copied-entry fill po tomto cleanupu spouští policy auto-close.
- Přesně korelovaný sourozenec vyplněné SL/TP nohy se ruší ještě před
  pomalým `/position/list`; pre-read dál chrání všechny ostatní nohy.
  Stream-only lookup má 250ms deadline a po timeoutu/chybě pokračuje jako
  neznámý stav do autoritativního globálního čtení.
- Osm nových/obrácených V13 regresí před opravou padalo (X1 fail/hang,
  X5, F2 V2/P1/P2, X6/N1, X3 a B3 hang); samostatně červeně potvrzena
  i exit-only tombstone regrese. Po opravě V13 + follower-cut 82/82
  a širší controller/bracket/guard sada 223/223. Jedna stará chaos fixture
  modelovala follower pozici při OSO parentu `Working/0`; po opravě fixture na
  skutečně filled parent prošla izolovaně 3× i v širší sadě.
- Předepsaná copier sada: sandbox 166 pass + 1 skipped, 89 loopback pádů
  výhradně `listen EPERM 127.0.0.1`; opakování celého stejného příkazu mimo
  sandbox prošlo 170 souborů + 1 skipped, 1961 testů + 1 todo, exit 0.
  Root `tsc --noEmit` má jen povolené chybějící Chrome/CRX typy v
  `extension/`; dočasný config bez `extension/` prošel exit 0 a byl smazán.
  Bez npm install/ci, commitu, broker volání, ARM/Flatten, deploye nebo
  reinstalace workeru; leader-flat guard F5 zůstal záměrně beze změny.

### 2026-09-29 — V13 v5b: deadline visícího flat-sweep cancelu (Codex, balíček 3b-6)

- Každý protective/OSO i exit-only cancel ve flat sweepu má vlastní
  `flatSweepCancelTimeoutMs` (default 2 s). Timeout je nejasný výsledek:
  write se podruhé neposílá a výsledek rozhodne jen následný stream/REST
  snapshot; working nebo neznámý stav skončí čitelně fail-closed.
- Runtime tombstone drží nejvýše jeden cancel write na broker order ID i při
  dalším flat eventu. Visící cancel jednoho účtu po svém deadlinu propustí
  další účet ve stejné ingress vlně; brokerem už provedený cancel s visící
  HTTP odpovědí se read-only potvrdí a navazující leader exit není blokován.
- Nová B6/R6 hang regrese před opravou skončila timeoutem (`waitForIdle` se
  neuvolnil); po opravě celý V13 soubor prošel 40/40 a související
  follower-cut/V13 guard/exit-latency sada 39/39. Předepsaná plná copier sada
  prošla mimo sandbox: 170 souborů + 1 skipped, 1956 testů + 1 todo, exit 0.
  První sandbox běh měl pouze 89 `listen EPERM 127.0.0.1` pádů ve čtyřech
  loopback souborech. Root `tsc --noEmit` má jen povolené chybějící Chrome
  typy a `@crxjs/vite-plugin` v `extension/`; typecheck bez extension prošel
  exit 0. Bez npm install/ci, commitu, broker volání, ARM/Flatten, deploye
  nebo reinstalace workeru.

### 2026-09-29 — V13 pátá iterace: pre-cancel flat proof, stream-first sweep a OSO lineage (Codex, balíček 3b-5)

- Flat-sweep před prvním cancelem čte `listPositions` dotčeného followera
  souběžně s order grafem. Ne-flat followera nejprve fail-closed odzbrojí a
  auto-close; `autoClose:false` používá jen po autoritativním potvrzení flat.
  Streamové working nohy se ruší bez čekání na REST budget a bez retry;
  rozpočet omezuje jen REST a začíná pro každý účet až jeho sweepem. Všechny
  streamové terminály končí bez falešného DISARM.
- Terminální stav z REST/streamu má přednost; streamové `working` je autorita
  jen pro explicitní `streamOnly`. Cizí/starý nebo dispatch-em překonaný
  snapshot už neznamená terminál a neotráví `sweptProtectiveLegs`. OSO parent
  se ruší jen podle leader vstupu/flat důkazu a má samostatný auditní důvod.
  Noha s explicitním neznámým `parentOrderId` se nepovýší časovou heuristikou
  na bracket, takže zůstane OSO korelátoru a follower nedostane holý Limit.
- Nové hard regrese před opravou reprodukovaly 9 pádů: V1c, V3b/O4/P7, V4,
  V5a, V5b, V6, V7, parent audit a S1 guard; po opravě cílená sada prošla
  99/99. Původních 72 review probe souborů dalo 63 pass a 9 starých timeout
  fixture pádů (B2 známý artefakt; B3/B5 čekají na dřívější horší chování),
  zatímco bezpečnostní výstupy P6, V1c, V3b/c, V4–V7, Guard a RozpočetD jsou
  stejné nebo lepší než `1a59237^`.
- Předepsaná kompletní copier sada prošla mimo sandbox kvůli loopback socketu:
  170 souborů + 1 skipped, 1953 testů + 1 todo, exit 0. První sandbox běh měl
  jen 89 `listen EPERM 127.0.0.1` pádů a jednu opravenou starou BRK2 aserci,
  která nově očekává povinný bezpečnostní read, ale dál hlídá market exit pod
  200 ms. Root `tsc --noEmit` hlásí pouze povolené chybějící Chrome typy a
  `@crxjs/vite-plugin` v `extension/`; `git diff --check` je čistý. Bez
  commitu, push/deploye, instalace závislostí nebo broker/worker akce.

### 2026-09-29 — Balíček 6: V9 ownership auto-close, V4 durable guard a ST4 fence (Codex)

- Auto-close nyní úplně vynechá pouze followery s `enabled=false`; jejich
  expozici hlásí auditem/notifikací bez broker write. Eligibility/cut followeři
  zůstávají v cílech. Známá durable stopa kopírky omezuje cleanup na přesné
  account+symbol cíle, účet bez známé stopy zachovává fail-safe account-wide
  fallback. Recovery hodnotí synchronní držení jen z participujících followerů
  a cizí expozice vypnutého účtu už nezavře zdravé kopie. `copiesOutcome` je
  `auto-closed` jen po skutečném cancelu/liquidation, jinak `flat`.
- Leader-flat guard přežije změnu `safetyGeneration`: nejvýše třikrát se
  přeplánuje s aktuální generací, potom skončí hlasitě fail-closed bez
  auto-close. Heartbeat obnoví ztracený timer nedokončené epochy jako read-only
  watchdog; restart/reconnect dál obnovuje plný durable guard. Flat followerovi
  guard uklidí jen broker ID doložené durable OCO/OSO stopou pro přesný symbol
  a po cancelu stav znovu autoritativně přečte.
- Reconciliation má druhý account-scoped observation fence těsně před finálním
  přepsáním gate/cache, takže pozdní event během sweep/persistence nemůže skončit
  ARMED nad starým snapshotem (ST4). Nový 12testový soubor před opravou měl 4
  reprodukované pády (disabled účet, cizí symbol, reconnect, DISARM guard); po
  opravě 12/12. Cílená sada 263/263. Předepsaná kompletní copier sada mimo
  sandbox prošla 169 souborů + 1 skipped, 1936 testů + 1 todo, exit 0. První
  sandbox běh měl pouze 89 `listen EPERM 127.0.0.1` pádů ve čtyřech loopback
  souborech; samostatné opakování mimo sandbox prošlo 94/94.
- Finální root `tsc --noEmit` má jen výslovně povolené chyby Chrome typů a
  `@crxjs/vite-plugin` v `extension/`; cílený typecheck bez extension prošel.
  Bez commitu, push/deploye, instalace závislostí, broker API, ARM/Flatten nebo
  reinstalu workeru.

### 2026-09-29 — Controller balíček 5c: epoch suppression, partial exity a stale ingress (Codex)

- V17/V18 jsou svázané s konkrétním leader orderem a otevřenou exposure
  epochou. Historický `acknowledged` z jiné epizody už nepotlačí aktuální
  broker reject; nová epizoda starou suppression přepíše. `allowedNet=0`
  vznikne a zůstane platný jen po autoritativním potvrzení flat účtu, bez
  working orderu a pending commandu, při nezměněné observation/generation.
  Neověřitelná nula dál končí fail-closed bez broker write.
- ST28 dovolí unmapped replace pouze followerovi, jehož škálované množství je
  stále nula a broker snapshot potvrzuje flat/no-working/no-pending, nebo má
  platnou suppression stejné epizody. Každý jiný chybějící link zůstává
  fail-closed. ST31 sleduje počáteční net a už zpracované filly exit-only
  rezervace, takže pořadí Position před Fillem neodečte partial exit dvakrát
  a další redukce nezůstane neodeslaná.
- Order/fill ingress nese skutečný `receivedAt`: risk-zvyšující leader event
  starší než 5 s se durable zaznamená a kriticky zablokuje bez pozdního copy;
  redukující/protective eventy se jen kvůli stáří neblokují. Bracket/OSO
  časovače používají zbývající rozpočet od ingressu, ne nové celé okno po
  doběhnutí fronty. Runnerův existující modify tok dál dělá čerstvý lookup
  před jediným write; žádný blind retry nebyl přidán.
- Flat sweep nyní zahrne i durable standard outbox/link s rolí
  `standalone-stop`, takže pozdější TP→flat followera zruší osiřelý stop i za
  DISARM a autoritativně zkontroluje výsledek. Změna je strukturálně
  kompatibilní s brokerovou větví `codex/copier-broker-20260929`; větev nebyla
  mergována a oblast controller auditu kolem `standalone-position-unknown`
  zůstala nedotčená.
- `maybeEngageDayLock` používá funkční `persistSafetyUpdate(current => ...)`;
  deterministická race regrese blokuje commit `sessionArmedAt`, vloží souběžný
  day-lock a potvrzuje zachování obou polí. Nové testy dále kryjí V17, V18,
  ST28, ST31, stale entry, starý protective move, zbývající ST6 budget a
  DISARM sweep standalone stopu. Před opravou cíleně padaly stale entry/ST6
  (2/2), unmapped zero-scale replace a position-before-fill zanechal jen jeden
  ze dvou potřebných exitů; po opravě jsou dotčené controller soubory 184/184.
- Předepsaná úplná kopírková sada prošla mimo sandbox kvůli loopback socketu:
  144/144 souborů a 1768/1768 testů. Root `tsc --noEmit` hlásí pouze výslovně
  ignorované chybějící `chrome`/`@crxjs/vite-plugin` typy v `extension/`;
  cílený typecheck bez `extension/` i root `npm run build` prošly a
  `git diff --check` je čistý. Žádný commit,
  merge, push, deploy, worker reinstall, ARM/DISARM ani broker/produkční akce
  nebyly provedeny.

### 2026-09-29 — V13 čtvrtá iterace: bezpečný flat sweep, wave budget a pravdivý audit (Codex, balíček 3b-4)

- Opraveny N1–N5 a budget lens z `copier-v13d-review-20260929.md`: pending
  bracket/OCO noha bez OSO parentu se ruší jako working; pending dítě partial
  parentu se už nepřeskakuje; partial nebo leader-terminální OSO parent se nad
  flat followerem risk-redukčně ruší spolu s dětmi. Neznámý parent a více než
  šest noh nejdřív zruší prokazatelně working nohy (u stropu prvních šest),
  potom hlasitě selžou bez auto-close zdravých followerů.
- Protective-fill hint používá synchronizovaný stream k přímému cancelu
  working sourozence před globálním readem. Jedna synchronní ingress vlna flat
  eventů sdílí deadline i líně spuštěný globální order graf; broker write se
  nikdy neopakuje a nejistotu řeší jen stream/globální read-only postkontrola.
- Audit `kind=canceled` vzniká pouze pro nohy/parenty, na které sweep skutečně
  poslal cancel a jejich terminální stav následně doložil. Pozdní fill
  copied-entry parentu, který sweep rušil, při flat leaderovi nově zakládá
  divergenci a `DISARM` s `autoClose:false`.
- Regresní V13 soubor před opravou: 8/30 selhání; po opravě 32/32. Dotčená sada
  270/270. Předepsaná kompletní copier sada 1759/1759; 53 loopback testů bylo
  kvůli sandboxovému `listen EPERM` zopakováno mimo sandbox a prošlo 53/53.
  Root typecheck má jen známé chyby v `extension/` (Chrome typy/CRX plugin),
  žádnou chybu v aplikaci ani upravených službách.
- Bez commitu, push/deploy, ARM/Flatten, broker spojení nebo worker reinstalace.

### 2026-09-29 — V12 čtvrtá iterace: tvarová lineage, cílené read-y a epoch refresh (Codex, balíček 3a-4)

- Pending záznam nyní uchovává i dříve potvrzené follower tvary
  `qty/price/orderType`; opožděný event se starším potvrzeným tvarem proto není
  falešná anomálie. Leader kontrola porovnává jen symbol a stranu. Ingress
  plot je po objektech (follower účet+symbol, leader pozice a obě pending order
  ID), ignoruje právě zpracovávaný order event a cizí symboly.
- Vzácná S1b/opposite-Market větev má jedno omezené cílené read-only ověření
  konkrétní kopie a follower pozice. Potvrzený fill dovolí exit; working kopie
  na flat followerovi se jednou risk-snižujícím způsobem zruší a přeskočí se
  jen tento follower. Nejasný stav, partial nebo `followerNet !== expectedPreNet`
  dál znamená fail-closed bez obchodního zápisu.
- Zápisy povolené zero-fill výjimkou jsou svázané s důkazní kopií. Její pozdní
  fill zruší jednou všechny takto odvozené ordery, zapíše audit a DISARM; write
  se neopakuje. Copied-exit fill, který při flat leaderovi otevře followera,
  okamžitě DISARMu je. Pending Market zbytky v aktuální epoše se započítávají
  do očekávaného netu.
- Po každém route-epoch bumpu běží mimo event hot-path omezený read-only refresh
  pozic a přesných orderů; pouze stále sedící lineage se přerazítkuje. Účet bez
  routy končí řízeně fail-closed. Reconciliation stale snapshot zahodí bez
  `lastError` a jednou omezeně zopakuje čtení.
- Převzaté a asertované V12c sondy v nových testech pokrývají MOD, ING/C0-burst,
  SC, S1b, MULTI, O6, RC, EP a Z1–Z11. Před opravou selhávaly zejména
  MOD1/2/2h/5, ING1/2/4, C0-burst, S1b-delayed, MULTI-Market, O6/O6b/O6m1,
  EP1/2, Z5–Z7 a RC1/2; po opravě jsou všechny nové sondy zelené a ING3 zůstává
  záměrně fail-closed. Přímá Z11b navíc prokázala, že výjimka `routeEpoch`
  řízeně DISARMu je skupinu bez zápisu. Předepsaná kompletní copier sada prošla
  mimo sandbox kvůli loopback socketu 144/144 souborů a 1751/1751 testů.
  Sedm přímo dotčených souborů prošlo samostatně 261/261.
  Širší root sada prošla 451/451 souborů a 4198/4198 testů v sandboxu;
  loopback soubor samostatně 53/53. Root typecheck po odfiltrování výslovně
  povolených `extension/` chyb nemá další chybu; `git diff --check` je čistý.
- Žádný commit, push, deploy, worker reinstall, ARM/DISARM, broker API ani
  produkční změna nebyly provedeny. Nezávislé review a řízené DEMO ověření
  zůstávají před případným nasazením povinné.

### 2026-09-29 — V16: episode-bound izolace BREACHED/DLL followera (Codex, balíček 4)

- Divergence před leader exitem nebo ochranným příkazem už nebere samotný
  `breached`/`dll-locked` stav jako výjimku. Pro každý takový účet provede
  čerstvou read-only kontrolu pozic a příkazů a izoluje jej pouze tehdy, když
  autoritativně potvrdí celý účet flat, žádný working order, žádný pending
  place/bracket/OSO/cancel command ani runtime pending/exit reservation a
  nezměněnou aktuální otevřenou leader epochu. Čtyři izolované účty proto
  neblokují SL ani exit zdravému followerovi; broker write se neopakuje.
- `unverifiable`, selhané čtení, změna stream observation během čtení, pozice
  z dřívější epizody, working order nebo pending command dál znamenají
  fail-closed divergence. Hot-path nyní takovou divergenci zapíše i do
  `divergentAccounts`; chybějící lokální position snapshot už ji nesmí skrýt.
- Reconciliation používá tentýž episode/eligibility/flat/no-working/no-pending
  predikát. BREACHED/DLL followera v otevřené epizodě zkusí read-only načíst
  i při `active=false`/`canTrade=false`; chybějící či neověřitelný snapshot
  není důkaz izolace. Mimo otevřenou epizodu zůstává dosavadní optional OAuth
  chování zachované.
- Nový `tests/copierV16EpisodeIsolation.test.ts` kryje čtyři breach skipy +
  zdravý SL/exit bez DISARMu, starou kopii, `unverifiable`, DLL a pozitivní i
  negativní reconcile. Původní pěti-testový V16 soubor před opravou skončil
  5/5 fail; po opravě a doplnění reconcile parity je 6/6 pass. Dotčených pět
  souborů 199/199 a samostatný V13 24/24 pass. Předepsaná copier sada má
  137/137 souborů v sandboxu; jediný loopback soubor prošel samostatně mimo
  sandbox 53/53 (v sandboxu očekávané `listen EPERM`). Cílený TypeScript je
  čistý; root typecheck hlásí jen povolené chybějící `chrome`/CRX typy v
  `extension/`; ESLint má 0 chyb a 3 starší warningy v controlleru.
- Žádný commit, push, deploy, worker reinstall, ARM/DISARM, broker API ani
  produkční změna nebyly provedeny. Zbývá nezávislé review a před nasazením
  výslovně schválený commit/reinstall + řízené DEMO ověření.

### 2026-09-29 — V13 třetí iterace: návrat flat-sweepu na globální snapshot + stream-only filtr (Codex, balíček 3b-3)

- Podle rozhodnutí v `docs/reviews/copier-v13c-review-20260928.md` byl V13
  flat-sweep vrácen na osvědčený pre-V13 tok: jeden globální `listOrders`
  snapshot účtu, cancel kandidátů bez blind retry a společná globální
  postkontrola `listPositions` + `listOrders`. Odstraněny byly cílené historické
  status read-y po každém ID, concurrency=2, dvě čtení/ID i per-call 1,5s timeout,
  které po restartu vyráběly desítky REST požadavků.
- Před globálním REST snapshotem se durable kandidáti filtrují pouze terminálním
  stavem ze synchronizovaného streamu (`findOrderStatusById(..., {streamOnly:true})`).
  Pokud jsou všichni terminální, flat incident končí bez REST, cancelu a DISARM.
  Router, Tradovate i exposure wrapper přenášejí explicitní `streamOnly`; bez
  streamového důkazu vrací neautoritativní `null` a nesmějí sáhnout na REST.
- Celá flat událost má jediný 6s budget (pod 10s heartbeat bránou), sdílený
  protective a exit-only sweepem. Reconciliation sdílí jeden budget napříč
  followery a účtové sweepy spouští paralelně. Broker write se neopakuje;
  nejasný cancel rozhodne jen následující read-only globální snapshot.
- OSO pravidlo je úzké: vlastní `working` noha se nad flat followerem ruší vždy.
  Vlastní `pending`/Suspended noha se zachová jen tehdy, když stejný autoritativní
  snapshot obsahuje její otevřený/nevyplněný parent. Chybějící parent je hlasitý
  fail-closed. Protective-fill hint již nesmí skrýt osiřelé nohy jiné OSO epizody.
- Regrese v `tests/copierFlatSweepV13.test.ts` pokrývají sondy O1/O1b/O2/O3/O3b/O7,
  R1a/R1b/R2/R3/R5/R6/R7, L1–L10, T1–T9, B1–B9 a incident s 0 REST;
  `tests/tradovateMapping.test.ts` navíc hlídá nulový REST při stream-only missu.
  Tentýž 24testový V13 soubor proti `fb9fb39` měl 12 failů, po opravě 24/24 pass.
- Ověření: cílených 7 souborů 325/325 pass;
  finální kopírková sada 137/137 souborů a 1641/1641 testů pass (136 souborů /
  1588 testů v sandboxu, loopback `localCopierExecutionAgent` 53/53 samostatně
  mimo sandbox kvůli `listen EPERM 127.0.0.1`). Cílený TypeScript config je čistý;
  root `tsc` hlásí pouze známé chybějící `chrome`/`@crxjs/vite-plugin` typy v
  `extension/`, které zadání výslovně dovolilo ignorovat. Žádný commit, push,
  deploy, worker reinstall ani broker/produkční akce nebyly provedeny.

### 2026-09-29 — V12 třetí iterace: stream-only pending mirror bez REST hot-path (Codex, balíček 3a-3)

- Odstraněno V12 ověřování přes `findOrderById` leader/follower orderu a
  `listPositions` followera před redukujícím zápisem. Výjimka pro zero-fill a
  symetrický partial mirror nyní stojí jen na shodném streamovém tvaru,
  množství/ceně/fillech, přesné follower pozici, prázdném per-account ingressu
  a nepřerušené route epoše leadera i followera. Router epochu zvyšuje při
  každém connection/error blipu, i když follower reconnect grace výpadek skryje.
- Terminální validní follower kopie se retireuje; orphan working kopie zůstává
  fail-closed. Sticky `evidenceInvalid` se respektuje i po plném leader fillu.
  Zachované jsou remaining exposure po leader fillu, retire po follower full
  fillu, potvrzený modify qty/ceny a partial mirror pouze s fill eventy obou
  stran. S1b (filled Limit + working kopie + Market exit na flat followera)
  zůstává záměrně blokovaný bez zápisu.
- Reconciliation má account-scoped observation fence a stale snapshot odmítne
  před přepsáním cache; žádný nový stream event během čtení se nesmí potvrdit
  jako čerstvá kontrola. Přidána explicitní regresní matice C0, R1–R13,
  R7b/R7c/O1/P1, S1b/S3–S7, N2–N4, F1/F2, M1–M4, router blip a test ~1119.
- Ověření: nový V12-3 soubor proti `90cee98` prokazatelně 12 failed / 9 passed,
  po opravě 21/21; dotčené čtyři soubory 175/175 (první post-fix běh měl jen
  3 příliš úzké aserce textu při správném DISARM/no-write výsledku);
  celá filtrovaná copier sada 1514/1514 — 1461 v sandboxu a jediný loopback
  serverový soubor 53/53 mimo sandbox po očekávaném `listen EPERM`. Cílený
  TypeScript check dotčeného grafu je čistý; root check hlásí jen povolené
  chybějící Chrome typy/plugin v `extension/`; `git diff --check` čistý.
  Nic nebylo commitnuto, nasazeno ani odesláno brokerovi.

### 2026-09-29 — 5b-3 follow-up: unknown standalone pozice jako audit bez broker write (Codex)

- Claudeho plná sada odhalila rozpor kontraktu: po třech neúspěšných
  read-only čteních follower pozice `processLeaderEvent` vyhazoval výjimku,
  zatímco runner kontrakt očekával kritický `blocked` audit. Výjimka přes
  controllerový `.catch(failClosed)` sice zapsala `lastError`; auto-close se
  nespustil jen proto, že read větev je dosažitelná až za DISARM. To byla
  správná současná vlastnost, ale nepřímá a křehká vůči budoucím změnám.
- Runner nyní vrací `blocked` audit se strojovým
  `reasonCode: standalone-position-unknown`. Pokud je neznámý byť jeden účet,
  celá dávka se vrátí před dispatchí: nevznikne cancel, modify, place ani
  liquidation ani pro jiného followera, jehož stop by jinak šel bezpečně
  zrušit. Controller tento konkrétní audit explicitně převádí na DISARMED
  fail-closed `lastError` s `autoClose:false` a vynutí novou reconciliation.
- Přímá runner regrese ověřuje dva followery: read účtu 200 selže třikrát,
  účet 300 je autoritativně flat, ale oba stop příkazy zůstanou working.
  Controllerová regrese ověřuje tři pokusy/deadline, DISARMED,
  `reconciliationRequired`, `lastError`, nulové nové place/liquidation a
  zachovaný working stop. Zdravý ARM cancel dál nečte REST a neDISARMuje.
- Cíleně prošly samostatně `zzV5FlatOrphan` 4/4,
  `brk2DisarmReadFail` 3/3 a `brk2ArmedReadFail` 1/1. Předepsaná celá copier
  sada po finální změně prošla mimo loopback sandbox: 156 souborů, 1694
  vykonaných testů, 1 skipped soubor a 1 záměrný todo, exit 0. První sandbox
  běh měl pouze očekávaný `listen EPERM 127.0.0.1`; ostatních 155 souborů a
  1641 testů prošlo. Produkční build a root typecheck bez `extension/` prošly;
  plný root `tsc` dál hlásí jen známé chybějící Chrome typy/plugin. Scoped
  ESLint má 0 chyb a 2 starší unused-import warningy v controlleru.
- Změny jsou pouze lokální: žádný commit, push, deploy, worker reinstall,
  produkční konfigurace ani brokerové volání.

### 2026-09-29 — Balíček 5b-3: ARM cancel bez REST brzdy, sync watchdog a targeted lookup (Codex)

- Změny jsou pouze lokální, bez commitu, push/deploye, reinstalu workeru,
  produkční konfigurace nebo brokerového volání. Výslovně zakázané
  `services/copierRuntimeController.ts` a `services/brokerRouter.ts` zůstaly
  beze změny.
- Standalone SL cancel nejdřív vyhodnotí plnou protective bránu. Za zdravého
  ARM jde rovnou do cancel lifecycle bez čtení pozic; těsně před side effectem
  dál platí plný dispatch fence. Jen když brána blokuje (DISARM/kill apod.),
  čte se follower pozice nejvýše 3x, každý pokus má 400ms deadline a backoff
  75/150 ms (celkem pod 2 s). Jedna přechodná chyba se zotaví; po třech
  chybách se žádný broker write neprovede, stop zůstane a controller dostane
  výjimku do `lastError` i v DISARMED. ARM regrese už nezpůsobí fail-closed
  auto-close zdravé pozice a bezprostřední market exit nečeká na REST.
- Semantic-lag watchdog před `syncReady` používá maximum semantic limitu a
  `syncTimeoutMs`; 20s `/order/list` při produkčním 45s sync budgetu naváže
  spojení. Po syncu zůstává přísnější 15s semantic guard beze změny.
- Targeted `findOrderById` stahuje execution report jen pro dosud
  nepotvrzené/neodmítnuté command ID nad povýšenou verzí, cizí `orderId`
  reporty ignoruje a čerstvý `/order/item` aplikuje až po reportech. Opakovaný
  lookup je konstantní (4 REST čtení i po 20 modify). ExecutionReport prefetch
  běží jen pro `New`/`Replaced`, chybějící vyšší command version a aktuální
  socket. Manual Flatten potvrzuje cancel nejdřív přes status-only lookup;
  celý Order+Fill graf potřebuje jen autoritativní `Rejected`.
- Devět převzatých `zzLookupLens*`/`brk2*` sond bylo změněno z diagnostických
  `expect(true)` na skutečné regrese a přibyl status-only Flatten kontrakt.
  Před opravou sondy naměřily 403ms zdržení exitu, ARM -> DISARM + Market
  auto-close, osiřelý working stop bez `lastError`, sync kill v 15 s, 2
  zbytečné prefetch requesty a repeat lookup 24 requestů po 20 modify.
  Po opravě všechny cílené soubory prošly samostatně; širší runner/broker/
  lifecycle/follower-cut blok prošel. Předepsaná celá copier sada mimo
  loopback sandbox prošla 137/137 souborů a 1623/1623 testů. První sandbox
  běh měl pouze `listen EPERM 127.0.0.1` (136 souborů a 1570 testů prošlo).
  Scoped ESLint je bez warningů/chyb, produkční build prošel.
- Root `tsc --noEmit` skončil exit 2 pouze na předem známých chybějících
  Chrome typech a `@crxjs/vite-plugin` v `extension/`; v měněných root
  souborech chybu nehlásil. Stejný typecheck s vyloučenou `extension/`
  prošel exit 0. `npm ci`/`npm install` se podle pravidel nespouštěly.
- Otevřený bod zůstává beze změny: controller sweep musí později zahrnout
  durable `protectiveRole: standalone-stop`, protože stop podržený za DISARM
  nedostane nový leader event, pokud follower zploští až následně přes TP.

### 2026-09-29 — Balíček 11b: rychlost kopírování bez oslabení bezpečnosti (Codex)

- Změny jsou pouze lokální, bez commitu, push/deploye, reinstalu workeru,
  produkční konfigurace nebo brokerového volání. Paralelně vlastněné
  `services/copierRuntimeController.ts` a `services/brokerRouter.ts` zůstaly
  beze změny.
- V11 byl nejdřív reprodukován řízeným testem se dvěma Order eventy a 60ms
  REST latencí: druhý `/orderVersion/deps` se před opravou spustil až po prvním
  a kritická cesta měla 120 ms. Po opravě se read-only hydratace obou frameů
  překrývá na 60 ms; aplikace výsledků a emise do controlleru zůstávají ve
  stávajícím serial tailu a v původním pořadí. Bez kompletní OrderVersion se
  žádný event neemituje. Nečiní se obecný závěr, že každý order získá pevně
  0,6–2,9 s — test dokazuje jen odstranění konkrétní serializace.
- P142: `ExposureCappedBroker.modifyOrder` při chybějícím `maxContracts`
  přestal dělat duplicitní order/position/order-graph čtení; při nastaveném
  limitu zůstává celý fail-closed exposure výpočet. Povinný pre-write lookup
  runneru se nemění.
- P334: Tradovate `findOrderById` už pro pre-modify lookup nestahuje globální
  `/command/list` ani `/executionReport/list`. Používá přesné order ID,
  `/orderVersion/deps`, `/command/deps`, `/fill/deps` a execution-report deps
  jen pro konkrétní modify command/version. Requested modify bez potvrzujícího
  execution reportu se dál nepovažuje za broker-confirmed; lookup-before-retry
  zůstává povinný a blind retry nevznikl.
- P143: limit paralelních dispatchů je getter odvozený z aktuální durable
  skupiny, ne startup snapshot. Test mění aktivní followery za běhu 2 -> 7 -> 3
  a ověřuje limity 4 -> 7 -> 4; skupina se do runtime promítne až po úspěšném
  durable save.
- P145: úspěšné place, native OCO/OSO a modify audit záznamy nesou
  `leaderReceivedAt`, `dispatchStartedAt`, `ackAt`, `queueMs`, `brokerMs` a
  `totalMs`. Hodnoty pouze znovu používají existující časové body; řídicí
  logika je nečte a nevznikly další clock tick/race změny.
- Baseline testy před opravou měly očekávané 3 pády (P142 duplicitní lookup,
  V11 serializace 120 ms, P334 globální seznamy). Po opravě cílené bloky
  prošly 11/11, 173/173 a execution/cap review 41/41. Celá předepsaná copier
  sada prošla mimo loopback sandbox 137/137 souborů a 1622/1622 testů;
  produkční build a `git diff --check` prošly, scoped ESLint má 0 chyb.
  Root `tsc --noEmit` hlásí pouze předem známé chybějící Chrome typy a
  `@crxjs/vite-plugin` v `extension/`, nikoli chybu změněných root souborů.
- ST6 bod 1 zůstává otevřený výše: controller musí timer zkrátit o stáří
  `leaderEvent.receivedAt`. ST6 bod 2 je pokryt V11. V `brokerRouter.ts` není
  pro tento balíček potřeba žádná změna, protože cílený lookup zachovává
  existující broker rozhraní.

### 2026-09-29 — V5/V8 adversariální follow-up: per-account SL cancel a semantic-lag (Codex, balíček 5b-2)

- Opraven lokálně follow-up commitu `362b921`, bez commitu, deploye,
  reinstalu workeru, produkční konfigurace nebo brokerového volání.
  `services/copierRuntimeController.ts` ani `services/brokerRouter.ts` se
  nezměnily.
- Cancel durable standalone stopu se v okamžiku leader cancelu klasifikuje
  zvlášť pro každý follower z autoritativního `listPositions`: flat účet,
  stop na špatnou stranu a množství větší než `|net|` používají cancel-only
  bránu; stop skutečně snižující otevřenou pozici používá plnou bránu.
  Neznámý nebo nejednoznačný net je kritický `blocked`. Smíšený fan-out tak
  zruší orphan stop jen bezpečným účtům a zachová SL otevřeným účtům. Audit
  blokace za DISARM obsahuje text „follower drží SL, který leader zrušil“.
- Protective cancel zahozený změnou safety generation těsně před side
  effectem už není tichý `skipped`, ale kritický `cancel-failed` s požadavkem
  na reconciliation; stávající controller tím invaliduje reconcile stav.
- Tradovate transport eviduje nejstarší nezpracovaný `a` frame. Po 15 s
  (konfigurovatelné `semanticLagTimeoutMs`, jinak socket idle limit) emituje
  chybu a zavře socket důvodem `semantic-lag`; synchronní odpověď na `h` i
  liveness heartbeat zůstávají mimo tail. Synchronní výjimka execution
  listeneru/journal observeru se převádí na error + close místo úniku z
  `onmessage`.
- Order/Fill `BrokerEvent` nese `receivedAt` původního frame. Pending Fill se
  doručí jen z `Created` (legacy event bez typu zůstává kompatibilní), pozdní
  `Updated` jej zahodí; `deliveredFillIds` se rezervuje před hydratací
  kontraktu, při chybě hydratace se rezervace uvolní.
- Opraveno nepřesné tvrzení balíčku 5b: „stale posun SL → kritický audit“
  nebyla změna proti base. Stejná věta v těle historického commitu `362b921`
  zůstává kvůli zákazu commitu/rewrite pouze historickým chybným popisem a
  nesmí se používat jako důkaz. Chybějící controller body V8 a standalone
  sweep jsou vedené výše jako otevřené otázky.
- Převzaté adversariální testy před opravou reprodukovaly 4 V5 a 5 V8 pádů.
  Po opravě cílený blok 148/148 a execution review 20/20; scoped ESLint
  i `git diff --check` čisté, produkční build prošel. Root `tsc --noEmit` má
  jen předem známé chybějící Chrome typy a `@crxjs/vite-plugin` v `extension/`;
  po jejich odfiltrování není žádná chyba. Celá předepsaná copier sada prošla
  s loopbackem 143/143 vykonaných souborů a 1634/1634 vykonaných testů; jeden
  záměrný `todo` kryje výše popsaný controller sweep. První sandbox běh měl
  jen `listen EPERM 127.0.0.1` a dva staré auditní kontrakty, které byly
  aktualizované na novou kritickou sémantiku.

### 2026-09-29 — V5/V7/V8: durable standalone SL a oddělená broker liveness/fill dedup (Codex, balíček 5b)

- Opraven lokálně balíček 5b bez commitu, deploye, reinstalu workeru,
  produkční konfigurace nebo brokerového volání. Zakázané paralelně měněné
  `copierRuntimeController.ts` a `brokerRouter.ts` zůstaly beze změny.
- Samostatný Stop/StopLimit, který autoritativní otevřená leader epocha
  klasifikuje jako redukující, nyní nese durable
  `protectiveRole: standalone-stop` v place outboxu i follower linku. Jeho
  leader cancel proto po DISARM/kill projde plnou fail-closed bránou; obyčejný
  čekající Stop entry se dál smí risk-redukčně zrušit. Recovery dělá pouze
  lookup podle tagu, neposílá druhý place a durable roli obnoví s linkem.
- Tradovate transport zapisuje `lastSocketMessageAt`, emituje heartbeat a na
  `h` odpovídá `[]` přímo v raw `onmessage`; serial tail zůstal jen pro
  sémantické `a` zprávy. Pomalá REST hydratace Orderu tak už nevyrábí falešný
  heartbeat timeout/stale-heartbeat. Původní tvrzení, že tím nově vznikl
  kritický audit pro stale posun SL, bylo nepřesné: stejné chování měla base;
  navazující body V8 jsou vedené jako otevřená otázka v zápisu 5b-2 výše.
- Fill dedup je rozdělen na započtené ID, explicitní úvodní REST baseline a
  ID skutečně doručená controlleru. Běžný REST lookup už nepotlačí pozdější
  WS Fill stejného ID, ale historický fill z úvodního sync baseline se
  nereplayuje; order cumQty se v obou případech nezapočítá dvakrát.
- Čtyři nové hlavní regrese před opravou padaly (DISARM, kill, REST→WS fill
  race, heartbeat za pomalým handlerem). Po opravě cíleně 169/169 a širší
  broker blok 212/212; scoped ESLint i `git diff --check` čisté, produkční
  build prošel. Root `tsc --noEmit` má jen předem známé chybějící Chrome typy
  a `@crxjs/vite-plugin` v `extension/` (závislosti se podle plánu
  nedoinstalovávaly). Celá předepsaná copier sada prošla jednovláknově
  136/136 souborů a 1620/1620 testů; první sandbox běh měl pouze
  `listen EPERM 127.0.0.1`, paralelní loopback běh jeden zátěžový V13 timing
  flake, který samostatně prošel 13/13 a ve finálním běhu se neopakoval.
- Zbývá nezávislé review a až po výslovném souhlasu commit/reinstall a řízený
  DEMO conformance test; nic z toho v tomto balíčku neproběhlo.

### 2026-09-28 — Konzervativní V13: serializovaný flat sweep bez background fencing regresí (Codex, balíček 3b-2)

- Commit `1a59237` byl na `HEAD 90cee98` přepracován bez revertu V12
  follow-upu, commitu, deploye, reinstalu workeru nebo brokerového volání.
  Flat sweep je znovu součástí `eventTail`: DISARM, běžný přechod leader
  epochy ani souběžný nový vstup už risk-redukující cancel starých přesných
  noh tiše nezahodí a dispatch nemá per-account `flat-sweep-in-progress`
  blokaci.
- Kandidáti se nejdřív ověřují přes `findOrderStatusById`; terminální stav ze
  synchronizovaného streamu proto nepotřebuje REST ani cancel. Zbylé ID mají
  jeden společný budget 5,25 s, souběh nejvýš 2, celkem nejvýš 2 cílená čtení
  na ID s backoffem. Broker write se neopakuje; po cancelu rozhoduje
  `listPositions` a stav jen ID, která byla před zápisem pracovní.
- Odstraněny durable klíče `flat-sweep:*`, background joby a fencing přes
  `generation`/`safetyGeneration`. Exit-only chyba znovu volá fail-closed s
  `autoClose:false`. Sweep i reconciliation před cancelem OSO SL/TP ověřují
  parent a `Suspended`/`pending` nohy nevyplněného vstupu zachovají.
- Na původním stavu padalo 8/11 nových konzervativních regresí. Po opravě V13
  13/13 a cílený širší blok 175/175; cílený TypeScript check čistý, ESLint 0
  chyb (2 starší warningy), root typecheck má jen povolené chybějící Chrome
  typy/plugin v `extension/`. Celá předepsaná copier sada prošla 136/136
  souborů a 1608/1608 testů; první sandboxovaný běh měl jen environmentální
  `listen EPERM 127.0.0.1`, opakování s loopbackem bylo čisté.
- Zbývá nezávislé review, schválený commit/reinstall a řízený DEMO test; nic
  z toho v tomto balíčku neproběhlo.

### 2026-09-29 — Balíček 7a-3: dokončení relay/ARM brzd a Mac dev originu (Codex)

- K1 obnovuje base chování „Přepnout a zapnout“: pouze shodná ARMED
  konfigurace je no-op; jiná skupina nebo nová eligibility exclusion projde
  serializovanou atomickou cestou DISARM → activate/read-only preflight →
  reconciliation → ARM. Selhání zůstane explicitní a DISARMED.
- F1 váže pre-insert i post-insert ARM coalescing na nejnovější brzdu téhož
  zařízení. F2 přidává do `poll-v2` `serverNow`; durable transport převádí
  `createdAt`/`expiresAt` do hodin workeru a při relay ARM fence používá
  minimálně 2s rezervu. F5 po durable enqueue brzdy pouze zaloguje selhání
  best-effort expirace starších ARM a nevrátí falešné 502.
- F3 počítá day-lock konec z autoritativního `context.createdAt`; pozdní lock
  po konci své session se neprovede a vrátí „session skončila“. F6 vybírá
  nejčerstvější runtime až z nerevokovaných zařízení a stále platný day-lock
  vytvořený před startem workeru smí projít restartovým filtrem.
- Mac instalátor má explicitní `--allow-full-dev-origins`, který zapisuje
  `ALPHATRADE_COPIER_ALLOW_FULL_DEV_ORIGINS=1` do launchd plistu. Bezpečný
  reinstall jej kvůli Filipovu localhost:3000 workflow předává defaultně;
  `COPIER_ALLOW_FULL_DEV_ORIGINS=0` jej vypne. Postup je v
  `docs/COPIER_MAC_RUNTIME.md`.
- Převzaty review regrese `zzAgentBBrzdy`, `zzbKompatMatrix`,
  `zzbKompatRerun` a `zzbFakeRelayDb` (plus nutný helper `zzAgentBEmu`) a
  otočeny na očekávané opravené chování. Před opravou padalo 8 relevantních
  scénářů K1/F1/F2/F3. Finálně prošla povinná copier sada 140 souborů / 1674
  testů, scoped TypeScript a ESLint bez chyb a produkční Vite/PWA build.
  Root `tsc --noEmit` dál hlásí pouze známé chybějící extension závislosti
  (`chrome`, `@crxjs/vite-plugin`).
- Záměrně nebyly změněny `services/copierRuntimeController.ts`,
  `brokerRouter.ts`, `tradovateBroker.ts`, `copierRunner.ts` ani `components/*`.
  Nic nebylo commitnuto, pushnuto, nasazeno, reinstalováno ani posláno
  brokerovi.

### 2026-09-29 — Balíček 7a-2: obnovitelné brzdy a přesná ARM idempotence (Codex)

- Tento zápis nahrazuje transportní rozhodnutí z balíčku 7a níže.
  Samostatná `poll-priority` linka, claim bez `delivery_id`, v1 ACK,
  `pendingPriorityAck` a druhý 750ms poller byly odstraněny. DISARM, kill
  switch a ruční day-lock znovu procházejí jedinou obnovitelnou FIFO v2
  linkou (`delivery_id` + idempotentní `complete-v2`), takže ztracená claim
  odpověď ani ACK brzdu nepohřbí a nezasekne další polling. Lokální agent
  je nadále provede okamžitě mimo svůj běžící command tail.
- Nově vložená brzda service-role updatem ve stejném serverovém requestu
  expiruje starší `pending` ARM/SHADOW stejného zařízení s
  `superseded-by-brake`; nová DB migrace nebyla potřeba. Worker dostává
  serverové `createdAt`, pamatuje poslední provedenou brzdu a odmítne ARM
  s `createdAt <= lastBrakeCreatedAt`. HTTP ingress zachytí brake epoch ještě
  synchronně před čtením body.
- Brzdy mají konečnou desetiminutovou enqueue TTL (nejsou
  „nevypršitelné“); ARM zůstává 30 s. Worker ukončí ARM nejpozději
  `expiresAt - 10 s`, aby zbyl rozpočet na durable ACK. Lokální
  `X-AlphaTrade-Command-Deadline` se omezuje na 30 s od příchodu requestu.
- Idempotentní ARM je no-op pouze pro tutéž sanitizovanou/mapped konfiguraci
  a exclusions, které už platí (nebo je nahrazuje přísnější stav).
  Jiná skupina nebo nová exclusion se odmítne textem, že je nutné kopírku
  nejdřív vypnout. Relay deduplikuje/coalescuje jen přesně shodný payload;
  konflikt vrací 409. `pending` i `claimed` kandidáti musejí mít
  `expires_at > now`, takže legacy osiřelý claimed ARM nový ARM nepohltí.
- ST34 JWT pilot-lease kontrola spárovaného klíče byla vrácena na stav
  před 15ae535, protože vytvořila kruhovou závislost instalace/párování.
  **Otevřený bod:** správné řešení je vydat lease až přes Device auth po
  párování; případná JWT bootstrap větev smí pečetit jen klíč z
  potvrzeného pairing requestu, s krátkým TTL a bez obnovy.
- Zachováno: omezení dev originů s
  `ALPHATRADE_COPIER_ALLOW_FULL_DEV_ORIGINS` a ST35 routing na zařízení s
  nejčerstvějším heartbeatem. **Otevřený starší problém N6:** dvě současně
  živá zařízení jednoho connection nemají fencing; ARM je třeba v takovém
  stavu odmítnout a brzdy doručit všem nerevokovaným zařízením. **Otevřený
  bod N10:** `maybeEngageDayLock` v `copierRuntimeController.ts` má ukládat
  přes `persistSafetyUpdate(current => ...)`, ne zachycený safety snapshot;
  soubor byl podle dělby práce záměrně nedotčen.
- Regrese převzaté z adversariálních PoC před opravou selhaly v 9
  bezpečnostních/kompatibilitních scénářích. Po opravě prošlo 6 cílených
  souborů / 162 testů a povinná celá copier sada 136 souborů / 1 627 testů.
  Scoped TypeScript a ESLint jsou čisté, produkční build prošel. Root
  `tsc --noEmit` hlásí pouze předexistující chybějící extension závislosti
  (`chrome`, `@crxjs/vite-plugin`). Nic nebylo commitnuto, pushnuto,
  nasazeno, migrováno, párováno ani posíláno brokerovi.

### 2026-09-28 — Balíček 7a: přednostní brzdy a bezpečný lokální relay (Codex)

- Bez změny `services/copierRuntimeController.ts` a `services/copierRunner.ts`
  dostaly DISARM, kill switch a ruční day-lock samostatnou lokální i cloudovou
  prioritní linku. V2 worker polluje brzdy souběžně s recoverable FIFO; claim je
  podmíněný na `pending` a ACK se smí opakovat, execution nikdy. Brzdy mají
  pětiminutovou enqueue platnost místo 30 s.
- ARM nyní přenáší serverové `expiresAt` až do agenta, lokální cesta má 30s
  strop. Deadline a „brake epoch“ se kontrolují po každém async preflightu i
  před/po durable potvrzení; souběžná brzda ARM zruší. Druhý pending ARM se
  přichytí k nejstaršímu commandu nebo se lokálně odmítne, race po vložení
  expiruje duplicitní řádek. ARM už ARMED workeru je čistý no-op bez DISARM,
  reconciliation nebo prodloužení TTL. Odpojený worker ARM odmítne ihned.
- Relay už nevybírá zařízení podle `last_used_at`, ale stejné nejčerstvější
  heartbeat zařízení pro connection, které čte UI, a následně ověří, že není
  revokované. Nevyžaduje nové párování. JWT pilot lease zůstává kvůli ručnímu
  downloadu, ale smí zapečetit token jen na přesný veřejný klíč již spárovaného
  nerevokovaného zařízení vlastníka.
- Lokální CORS hranice nově odděluje produkční allowlist od dev originů.
  `localhost:3000`, `127.0.0.1:3000` a `127.0.0.1:3011` mají defaultně jen
  status, DISARM, kill switch a Flatten. Plnou dev sadu lze zapnout jen
  instalačním env flagem `ALPHATRADE_COPIER_ALLOW_FULL_DEV_ORIGINS=1`.
- Nové regrese proti base commitu selhaly v 9 scénářích. Po opravě cílený běh
  prošel 7 souborů / 162 testů (včetně concurrent ARM race), scoped TypeScript
  a ESLint jsou čisté, produkční build prošel.
  Povinná celá copier sada prošla 136 souborů / 1619 testů; první běh odhalil
  tři zastaralé DB mocky v `copierRiskDetailedReview`, po jejich aktualizaci
  prošla celá. Root `tsc --noEmit` má pouze známé chybějící extension závislosti
  (`chrome`, `@crxjs/vite-plugin`), které se v tomto worktree podle pravidel
  nesmějí doinstalovat.
- Nic nebylo commitnuto, pushnuto, nasazeno, párováno ani posláno brokerovi.
  Aktivace prioritní cloudové linky a agentových ochran vyžaduje budoucí
  schválený deploy/reinstall; zde proběhly jen lokální testy a build.

### 2026-09-28 — V12 follow-up: filled lineage, modify/partial mirror a reconcile fence (Codex, balíček 3a-2)

- Opraveny regrese commitu `cb5cdf6` bez commitu, deploye, reinstalu workeru
  nebo brokerového volání. Pending lineage po fillu leaderova Market i Limit
  orderu znovu používá původní remaining výpočet a po plném follower fillu se
  retiroje i bez terminálního order eventu; skutečný overfill, shape mismatch
  nebo orphan zůstává sticky fail-closed.
- Zero-fill i symetrický partial-fill mirror se před redukujícím dispatchcem
  opírá o autoritativní lookup konkrétního leader/follower orderu a čerstvé
  `listPositions` followera. Kontroluje aktuální qty přes multiplier i cenu;
  potvrzený modify aktualizuje uložený tvar. Partial zbytek se vyjme jen při
  fill eventech na obou stranách, shodném zbytku a shodných pozicích. Tím je
  bezpečná i follower route, jejíž krátký reconnect router zatím skryje.
- Reconciliation zachytí observation version před čtením. Při souběžném
  ingressu pending nemaže ani nepřerazítkuje a pouze jej označí invalidním.
  Reconnect test nyní používá skutečný router; leader-cancel test už nepadá na
  umělém cancel timeoutu, ale ověřuje orphan pending logiku.
- Na stavu před opravou padalo 9/11 nových scénářů; po doplnění průkazného
  reconcile race padalo 10/11. Současně padaly původní chaos scalp a
  management-only testy. Po opravě: cílené 4 soubory 164/164, cílený
  TypeScript check čistý, ESLint 0 chyb (2 starší warningy), root typecheck má
  jen povolené chyby chybějících závislostí v `extension/`. Celá předepsaná
  copier sada prošla 136/136 souborů a 1604/1604 testů; první sandboxovaný běh
  měl pouze environmentální `listen EPERM 127.0.0.1`, opakování s loopbackem
  bylo čisté.
- Zbývá nezávislé review, schválený commit/reinstall a řízený DEMO test; nic
  z toho v tomto balíčku neproběhlo.

### 2026-09-28 — V13: flat sweep po výstupu mimo eventTail a bez globálního order grafu (Codex, balíček 3b)

- Opravena pouze V13 ve worktree `codex/copier-fixes-20260928`, bez commitu,
  deploye, reinstalu workeru nebo brokerového volání. Flat sweep nyní běží
  jako samostatná úloha pro `accountId+symbol` mimo `eventTail`, sdílí jeden
  skutečný sedmisekundový budget a čte jednotlivá durable order ID přes
  `findOrderStatusById`; terminální stav ze synchronizovaného streamu proto
  nepotřebuje REST ani globální `listOrders`.
- Před každým cancelem se znovu čte pozice a ověřuje safety generation,
  revize skupiny, connection generation, trade epoch, leader/follower účet,
  symbol, exposure epoch a stále platný flat. Po dobu čtení blokuje dispatch
  nového vstupu jen dotčený účet+symbol. Nový leader entry starou práci
  synchronně zneplatní; DISARM, kill, config change, reconnect i shutdown ji
  rovněž zastaví před broker write.
- Cancel se nejprve durable uloží jako `sending`; nejasný výsledek přejde do
  `unknown` a rozhoduje výhradně následný cílený lookup. Stejné ID se nikdy
  neposílá podruhé. Opakují se jen read-only dotazy. Postkontrola kombinuje
  `listPositions` a stav každého jednotlivého ID; eventual/neúplný důkaz,
  otevřená noha nebo vyčerpaný budget zůstává fail-closed.
- Nová regrese před opravou padala, protože terminální stream přesto volal
  `listOrders` dvakrát. Po opravě: V13 9/9, celý controller 128/128,
  exposure-cap 7/7, review regrese 8/8, follower-cut 36/36 a původní
  flat-sweep chaos blok 5/5; cílený TypeScript check čistý, ESLint 0 chyb
  (2 starší warningy), `git diff --check` čistý. Celý chaos soubor má nadále
  1 známý V12 setup fail (`follower close Market příkaz nebyl vytvořen`),
  reprodukovaný beze změny i na výchozím `cb5cdf6`.
- Zbývá nezávislé review, schválený commit/reinstall a řízený DEMO test;
  nic z toho v tomto balíčku neproběhlo.

### 2026-09-28 — V12: zero-fill pending limit už nevyvolá falešnou divergenci (Codex, balíček 3a)

- Opravena pouze V12 ve worktree `codex/copier-fixes-20260928`, bez commitu,
  deploye, reinstalu workeru nebo brokerového volání. Dnešní sled Sell Limit
  8 z flat → Market Buy 8 → Stop Sell 8 se čtyřmi followery nyní zkopíruje
  Stop všem a controller zůstane ARMED.
- Runtime pending lineage nově drží konkrétní leader/follower order ID, typ,
  symbol, stranu, množství, leader i follower fill, obchodní epochu a broker
  sync generation. Non-Market pending se z divergence vyjme jen při čerstvém
  stejnogeneračním důkazu, že oba odpovídající ordery jsou stále otevřené a
  oba mají nulový fill (`filledQuantity` i durable `leaderCumQty`). Chybějící,
  terminální, částečně plněný, tvarově odlišný nebo pre-reconnect důkaz zůstává
  fail-closed; původní ochrana proti zamaskování ruční follower pozice platí.
- `reconfigureLeaderEpoch` pending lineage čistí; `runReconciliation` ji
  prořezává podle autoritativního `listOrders` a orphan working kopii nepovýší
  na bezpečný důkaz. Přidány regrese pro incident 4×8, add-on Buy Limit,
  partial leader fill, follower fill při pending orderu, leader cancel,
  stale/reconnect generation a více současných pending kopií.
- Před opravou padaly 4 nové bugové regrese (incident, add-on, stale po
  reconciliation, více pending). Po opravě: povinné 4 soubory 168/168,
  cílený TypeScript check controlleru + testu čistý, ESLint 0 chyb (3 starší
  warningy v controlleru), `git diff --check` čistý. Root `tsc --noEmit`
  nebyl použit jako finální důkaz: worktree nemá závislosti Chrome extension
  (`@types/chrome`, `@crxjs/vite-plugin`) a podle plánu se zde nesmí spouštět
  `npm ci`/`npm install`.

### 2026-09-29 — UI-10e: jisté ARM rejecty, durable brzdy a ochranný follower SL (Codex)

- ARM dialog rozlišuje nové definitivní rejecty workeru/relay od neověřeného
  výsledku: konflikt konfigurace, odpojený worker, vypršený deadline včetně
  `command-expired-*`, `superseded-by-brake`, brzdu během přípravy a ARM starší
  než poslední brzda. Každý říká česky, že se nic nezapnulo; síťový timeout
  bez autoritativního výsledku dál zůstává neověřený.
- DISARM, kill switch i ruční day-lock používají společnou safety cestu. Lokální
  loopback si ponechal 10s timeout, relay brzda se už po 10 s neabortuje. Když
  po 35 s stále čeká, UI ukáže informační text „Brzda čeká ve frontě workeru
  (platí do HH:MM)“ ze serverového `expiresAt`; nevydává ji za chybu ani za
  potvrzený úspěch a pravidelný status polling dál převezme pozdější výsledek.
- Brokerový V5 audit/lastError „follower drží SL, který leader zrušil“ a závod
  ochranného cancelu mají vlastní kód `protective-stop-retained` a v dashboardu
  i Událostech text „Follower drží svůj SL, který leader zrušil — rozhodni
  ručně v Tradovate.“ Historie se překládá přes aktuální UI mapu; neznámý nový
  worker kód už incident panel neshodí a zkusí bezpečnou klasifikaci detailu.
- Ověřeny přesné core texty V16 (`nevysvětlená divergence ... před leader
  exitem`) a V13 (`Flat sweep nedokončen`, s/bez deadline) proti českým titulům.
  Cílené regrese 87/87. Povinná sada: 149 souborů / 1744 testů v sandboxu;
  jediný loopback soubor zde narazil na `listen EPERM`, samostatně mimo sandbox
  prošel 49/49, tedy celkem 150 souborů / 1793 testů. `npx tsc --noEmit` hlásí
  jen povolené staré chyby `extension/` (Chrome typy a `@crxjs/vite-plugin`),
  `git diff --check` čistý. Bez npm install/ci, Tradovate/agent mutací, commitu,
  pushnutí, deploye nebo reinstalace workeru.

### 2026-09-28 — UI-10d: adversariální hardening ovládání a LIVE dat (Codex)

- Opraveny všechny vysoké a střední nálezy z `docs/reviews/copier-ui-review-20260928.md`
  a převzaty důkazní scratch scénáře do trvalých testů. Neověřený nebo retained
  stav už dovolí pouze risk-snižující flatten/DISARM/kill akce; followery,
  násobky, editor i šablony jsou do ověření blokované a všechny skupiny ukazují
  `Neověřeno`. Dialogy odvozují API readiness z `runtimeAvailable`.
- Relay čerstvost používá serverové `ageMs` (včetně tolerance budoucího času),
  retention se zapisuje jen z přijatého runtime stavu a brzdy volí trasu
  `poslední ověřená -> aktuální -> local`. Po zhruba 10 s timeoutu UI výslovně
  hlásí neověřený výsledek. Lokální ACK fence odmítá starší odpověď; úplné
  distribuované řešení zůstává worker `gateSeq` v balíčku 7.
- LIVE full refresh je single-flight po connection, pending ruší starý retry,
  retry timer i sloučený `visibilitychange`/`focus` respektují backoff a běžící
  request. Explicitní broker `Retry-After` se nezkracuje, prefetch 429 se ukládá
  a trvalá chyba ukončí loading stav textem chyby.
- DLL se při full loadingu neztrácí, používá stejný live daily P&L zdroj jako
  displej a konzervativně horší z dostupných hodnot. `profile.updatedAt` není
  freshness důkaz limitu; stale P&L se nepovažuje za verified. Neplatný
  `capturedAt` už neshodí render.
- Ověření: adversariální/změnový balík 195/195; povinná plná sada
  `npx vitest run tests/liveCopy tests/copier tests/tradovate tests/live tests/localCopier`
  1771/1771 (150 souborů). `npx tsc --noEmit` hlásí jen předem povolené chyby
  v `extension/` (chybějící Chrome typy a `@crxjs/vite-plugin`), žádnou chybu
  aplikace/testů. `git diff --check` čistý. Bez `npm ci/install`, broker/agent
  mutací, commitu, push/deploye nebo reinstalace workeru.

### 2026-09-28 — UI-10c: worker manifest v editoru, lidské blokery a přesný DISARM důvod (Codex)

- Editor skupiny spojuje webový OAuth katalog s čerstvým manifestem z
  `status.devices` (legacy fallback `device` / `connectionUsage`) a drží tři
  stavy: routovatelný, chybí v Mac workeru, nelze ověřit. Účet z jednoznačně
  chybějícího připojení nejde nově vybrat ani uložit a dostane odznak s krokem
  manifest + bezpečný reinstall; nečerstvý/neúplný status pouze varuje a výběr
  neblokuje. `accountDisplay` se záměrně nepoužívá k rozhodování.
- Odmítnutí změn už pro známé případy neukazuje interní kódy/ID: race radí
  několik sekund počkat, ARMED radí bezpečně vypnout, outbox vede do Událostí
  a chybějící OAuth jmenuje všechny známé účty a vysvětluje, že samotné
  Connections bez manifestu nestačí. Neznámý broker reject drží originál jen
  v detailu, ne v hlavním textu.
- DISARM notice/panel/status strip zpřesní starý `unknown` z `lastDisarm.detail`
  a poté `lastError`, aniž by domýšlel `copiesOutcome`. Přibyly UI kódy pro
  nevysvětlenou divergenci, prop limit a budoucí `config-change`; text posledního
  je přesně „Kopírka se vypnula kvůli uložení změny skupiny.“
- Mobilní `Flatten All` je na samostatném řádku mimo primární ARM zónu;
  potvrzovací sheet i příkaz zůstaly beze změny. Cooldown texty výslovně říkají:
  po potvrzeném flat kopírku vypne, blokuje ARM a nikdy ji sám nezapne; jiná
  risk pauza pouze blokuje nové vstupy.
- Ověření: 10 cílených souborů, 106/106 testů. `npx tsc --noEmit` nemá chybu
  mimo povolené staré `extension/` chyby (chybějící Chrome typy a
  `@crxjs/vite-plugin`); `git diff --check` čistý. Neběželo `npm ci/install`,
  plná sada ani build. Bez Tradovate/agent mutation, reinstallu, commitu,
  pushnutí a nasazení; worker zdroj se neměnil.

### 2026-09-28 — UI-10b: DLL a denní P&L bez globálního pendingu (Codex)

- Full enrichment se sleduje pro každé OAuth připojení zvlášť. Selhání už
  neschová DLL a denní P&L ostatních účtů; neúspěšný full refresh má vlastní
  retry 15/30/60 s až 10 min, respektuje per-connection 429 a při návratu do
  popředí se obnoví pending nebo nejméně pět minut staré připojení.
- Server u 429 čte `p-time` z těla a bez `Retry-After` používá 5 minut. Klient
  backoff omezuje na 10 minut a nepřenáší limit jednoho připojení na ostatní.
- Daily P&L i `DLL zbývá` používají tentýž validovaný realized vstup: novější
  worker display feed má přednost před OAuth snapshotem. DLL timestamp skládá
  jen z realized, unrealized a skutečně použitého limitu; cash timestamp není
  vstup. Stará čísla jsou šedá a mají stáří v title i v mobilním detailu.
- Risk hodnota rozlišuje loading, nedostupné, neznámý limit a účet bez DLL.
  Poslední známá worker risk hodnota v souhrnné kartě po 15 s nezmizí, ale je
  výslovně šedá a označená stářím; execution/risk brány dál používají jen
  striktně čerstvá data.
- Daily záznamy se párují přes Chicago trade date. UI inference DLL locku je
  povolená jen pro aktuální trade date, dostupné daily P&L a nestale open P&L,
  takže rollover 17:00–19:00 CT nevyrábí falešný zámek.
- Ověřeno cíleně: 11 souborů / 135 testů. `npx tsc --noEmit` hlásí jen předem
  povolené chyby `extension/` (chybějící Chrome typy a `@crxjs/vite-plugin`).
  Bez npm install/ci, broker/Tradovate volání, commitu, push, deploye či změny
  produkční konfigurace.

### 2026-09-28 — UI-10a: stabilní stale stav kopírky a rychlejší relay poll (Codex)

- `TradovateLiveDesk` už při jediném neúspěšném nebo starém relay čtení
  nemaže poslední worker snapshot ani čas jeho pozorování. Okamžitě ho ale
  označí jako nečerstvý, takže ARM, konfigurace a follower toggle zůstávají
  fail-closed. Stav se zahazuje jen při změně identity uživatele; DISARM/kill
  při stale stavu dál používá poslední skutečně ověřenou trasu.
- Více relay připojení se čte souběžně: první odpověď s připojeným workerem se
  zobrazí bez čekání na nejpomalejší spojení, přednostně se startuje poslední
  použitá trasa a zbytek doběhne přes `Promise.allSettled` kvůli display feedům.
- Poll a ACK snapshoty mají monotónní fence `(startedAt, controller.revision)`:
  starší stav nepřepíše potvrzený DISARM/kill/toggle, ale restart workeru s
  novějším `startedAt` může bezpečně začít od revision 0.
- Čerstvost se odvozuje z tikajících hodin a `observedAt` s prahem 15 s.
  Focus bez změny visibility stav nezneplatní, krátký shluk resume událostí se
  slučuje a zahazují se jen čtení zahájená před posledním skrytím.
- Desktop po pádu lokální cesty zkouší loopback znovu po 20 s a při návratu do
  okna; nativní iOS build lokální sondu vůbec nespouští.
- Ověřeno cíleně: 17 souborů / 144 testů včetně všech `liveCopy*`; typecheck má
  jen předem známé chyby `extension/` kvůli chybějícím Chrome typům a
  `@crxjs/vite-plugin`. Bez npm install/ci, Tradovate/agent volání, commitu,
  push, deploye nebo reinstalace workeru.

### 2026-09-30 — iOS menu Více: skleněná bublina místo sheetu (Claude)
Filip vybral variantu C z náhledu `mockups/more-menu.html` (lokální, necommitovat).
`capacitor-ios/App/App/AlphaTradeShellViewController.swift`: menu Více už není
systémový sheet, ale bublina nad lištou (UIHostingController + ztmavení), vyskočí
pružinou z tlačítka Více (ikona se mění na křížek). Navigace startuje hned při
klepnutí souběžně se zavíráním (dřív až po zajetí sheetu). Nahoře posuvný
přepínač LIVE/BACKTEST, řádky s ikonou, kapitálkami a popisem
(`AlphaTradeTabCatalog.menuSubtitle`), LIVE s pulzující tečkou, Nastavení
oddělené. Past: `UITapGestureRecognizer` na ztmavení nad WKWebView se nespustil
(hitTest vracel správný view) → ztmavení je `UIControl` s `.touchUpInside`.
Ověřeno v simulátoru (otevření, zavření klepnutím mimo i tlačítkem, přepnutí do
backtestu skryje LIVE-only a ukáže Session) a nainstalováno na iPhone (čistá
reinstalace z worktree nad origin/main 0105913d + jen tento soubor). Zatím
necommitováno; webová BottomNav má pořád starý vzhled.
Doplněk: na iOS 26 posouvá lišta skleněnou lupu výběru vlastním gestem
(`_UIContinuousSelectionGestureRecognizer` na UITabBar) už při dotyku, takže
Zapsat/Více poskočily a výběr se vracel. `gestureRecognizerShouldBegin` na liště
nepomohl (lupa reaguje dřív) → nad Zapsat/Více leží průhledné `UIControl`
mimo hierarchii lišty (rámy z `_UITabButton`, záloha rovnoměrné dělení),
VoiceOver je přeskočí a platí záloha v `didSelect`. Ověřeno videem ze
simulátoru snímek po snímku. Nekonečný spinner po reinstalaci se vyřešil sám
(Filip: „už mi appka jede“), příčina neověřena.
Změna na přání Filipa: pilulka MÁ jezdit i na Zapsat/Více → průhledná tlačítka
zrušena, výběr řídí jediné `syncTabSelection()`: otevřený zápis → Zapsat,
otevřené menu → Více, jinak stránka; stránka jen z menu (Lab, LIVE…) svítí na
Více. Web hlásí otevřený zápis (`isManualEntryOpen || isGuardianOverlayOpen`)
novou metodou pluginu `setShellCapture` (`reportNativeShellCapture` v
utils/nativeShell.ts, efekt v App.tsx, test v nativeShellBridge.test.ts);
když web do 1,5 s nepotvrdí, pilulka se vrátí. Ověřeno v simulátoru (logy),
nainstalováno na iPhone. Navíc: přechod z nativní lišty / menu Více
(bridge `navigate`) zavře otevřený zápis i Guardian stejně jako křížek —
formulář dřív visel nad novou stránkou. Pushnuto přes worktree nad origin/main
(jen tyto soubory, tsc + 4680 testů + build zelené, copier DISARMED);
telefon přestavěn z téhož worktree a čistě přeinstalován.

### 2026-09-30 — Automatické snímky zahozeny (rozhodnutí Filipa) (Claude)

- Filip: „automatické snímky zahodit a nechat jen to, co máme v grafu“.
  Graf v detailu se ze skladu svíček načte ~1 s a je interaktivní; noční
  worker (skrytý Chrome s vlastním přihlášením, fronta, další tabulky) by
  byl složitost navíc. Kamera TradingView v copieru běží dál beze změny.
- Rozpracovaný krok 3 (fronta, worker, instalátor LaunchAgentu, migrace
  trade_chart_snapshots) smazán — nebyl v gitu ani v produkci. Zjištění
  pro případný návrat: skrytý Chrome (headless=new) proti produkci občas
  nedočkal stránky fronty (cdp-timeout / queue-timeout), proti localhost OK
  — nevyřešeno. Klasifikátor odmítl variantu, kde server vydá Macu session.
- Zůstává (užitečné i bez snímků): sklad svíček, profil grafu na serveru,
  soukromé preference. Vykreslovací stránka `/?snapshotRender=…` zůstává
  nasazená, ale nic ji nepoužívá.

### 2026-09-30 — Soukromé preference v profiles (bezpečnost) (Claude)

- Díra: `profiles` má SELECT policy `true` (role public) a anon i
  authenticated měli SELECT na celou tabulku → kdokoli s veřejným klíčem
  četl `preferences` všech (železná pravidla, emoce, business nastavení,
  kariérní plán…) a anon i e-maily a role. Registrace je otevřená, takže
  i „jen pro přihlášené“ = veřejné.
- Oprava ve dvou krocích (starý kód se sloupcovým čtením by po zavření
  spadl, nový potřebuje funkce):
  1. `20260930070000_profiles_preferences_rpcs.sql` (jen přidává):
     `get_profile_preferences_v1(p_user_id default null)` — vlastní, nebo
     sledovaného při přijatém spojení (režim diváka); `get_followed_iron_rules_v1(p_ids)`
     — jen `ironRules` sledovaných pro feed sítě.
  2. `20260930071000_profiles_private_columns.sql` (až po nasazení kódu):
     anon jen id/jméno/avatar, authenticated navíc e-mail, roli, časy
     (vyhledávání přátel); preferences nikdo přímo; anon bez zápisu.
- Kód: getUser/getProfile bez `*`, getPreferences a notifikace sítě přes
  funkci, savePreferences ověřuje zápis přes `id`, feed sítě bere železná
  pravidla z funkce, záložní načtení dashboardu čte preference funkcí,
  sdílený obchod už nebere e-mail jako náhradní jméno autora.
- PGlite 18/18 (včetně: po kroku 1 funguje starý i nový kód). Testy appky
  31/31. Pozor: iPhone appka má zabalený starý kód — po kroku 2 na ní
  selže ukládání preferencí a feed sítě, dokud se nepřestaví.
- INCIDENT 2026-09-30 ~06:30: při ověřování v náhledu (proti produkci) Claude
  zavolal `getPreferences()` hned po načtení stránky → `null` (getUserId při
  inicializaci přihlášení krátce vrací null) a testem ho uložil zpět
  `savePreferences(null)` → preference Filipa v produkci = NULL na pár minut.
  Obnoveno z kopie v localStorage náhledu (`alphatrade_preferences_<uid>`,
  uložená při načtení stránky těsně předtím; 18 položek) + záloha do
  scratchpadu. Ověřeno: 18 položek, 5 železných pravidel, 2 seance.
  Poučení: proti produkci nikdy nezapisovat v testu; zapisovat jen
  ověřený objekt.
- Pojistky (i proti starší pasti): `savePreferences` odmítne ne-objekt;
  `getPreferences` při chybě RPC vyhodí výjimku (ne „prázdno“), čtecí
  pomocníci (playbook, business, šablony) mají vlastní `.catch`; zápisy
  „přečti–uprav–zapiš“ (šablony kreseb, notifikace sítě) při chybě čtení nic
  nezapíšou; FocusSync v App při `null` už nepoužije `{}` a neoznačí stav jako
  synchronizovaný (dřív mohla další úprava uložit prázdné preference);
  PullRefresh chybu preferencí spolkne a obnoví obchody. Test
  `tests/profilePreferencesPrivacy.test.ts`.
- Nasazeno 2026-09-30: kód 0105913d (READY), pak krok 2 (Filip). Ověřeno
  přes veřejné REST API bez přihlášení: preferences / email / `*` / RPC
  → 401 (42501); id+jméno+avatar 200. Přihlášený: přímé čtení preferences
  42501, vlastní přes RPC 18 položek, profil a feed sítě OK. Občasné `null`
  z `getPreferences` jen při obnově přihlášení (getUserId) — beze změny
  proti dřívějšku, pojistky brání uložení.
- iPhone appka přestavěna z origin/main 0105913d (worktree + symlink
  node_modules a .env.local, `ios:sync`, xcodebuild, čistá reinstalace):
  balíček obsahuje `get_profile_preferences_v1`, žádné přímé čtení
  preferences; na telefonu přihlášený dashboard s preferencemi (layout).

### 2026-09-30 — Profil grafu na serveru (krok 2 automatických snímků) (Claude)

- Nová tabulka `public.user_chart_profiles` (migrace 20260929180000, pustil
  Filip): jeden řádek na uživatele, RLS jen vlastník (select/insert/update,
  bez delete), anon nic, service_role čte (worker). Záměrně NE
  `profiles.preferences` — ta má veřejné čtení (viz níže). PGlite 11/11.
- `services/chartProfile.ts`: profil = zapnuté indikátory, jejich styl
  (`detailIndicatorStyleSnapshot`) a obálka nastavení grafu; kontrola tvaru
  ze serveru, otisk se seřazenými klíči (jsonb je přeskládá).
- `services/chartProfileSync.ts` (start v index.tsx mimo stránku snímku):
  po přihlášení zařízení bez vlastního nastavení (styl, volby indikátorů,
  nastavení grafu) profil převezme, jinak se místní nahraje; pak každých
  30 s a při skrytí stránky jen při změně. Chyba/tabulka chybí → ticho.
  Past: dotaz uvnitř `onAuthStateChange` čeká na zámek přihlášení →
  práce odložená `setTimeout(0)`.
- Zjištění: vykreslovací stránka dosud nekreslila tvůj vzhled — uživatel
  pro vzhled grafu se nastavoval až modulem grafu, takže snímky měly výchozí
  barvy a styl. Teď stránka nastaví uživatele a použije profil ze serveru
  (`chartProfile: 'server' | 'local'` ve stavu). Ověřeno živě: `server`,
  ready. Testy `tests/chartProfile.test.ts`.
- BEZPEČNOST (starší, neopraveno): `profiles` má SELECT policy `true` pro
  roli public a anon má SELECT na sloupec `preferences` → kdokoli s veřejným
  klíčem čte preference všech uživatelů (železná pravidla, emoce, business
  nastavení…). Řešit zvlášť (RPC pro vlastní preference + revoke).

### 2026-09-29 — Sklad svíček nasazen (Claude přebírá po Codexovi)

- Codex stranou (bez limitu) → Claude převzal jeho lokální sklad svíček
  (`supabase/functions/market-candle-store/`, migrace
  `20260926071010_market_candle_private_store.sql`, klient už v appce).
- Lokální zkouška migrace v PGlite s produkčními právy (13/13): zámek
  období (souběžný požadavek → 202, jen jeden nákup), selhání a propadlý
  zámek, cizí token, authenticated/anon bez přístupu k tabulce, funkcím
  i bucketu, tagy backtestu ve stejném schématu dál čitelné.
- Produkce: schéma `alphatrade_private` UŽ EXISTOVALO (backtest_tag_*) —
  rollback smí mazat jen tabulku skladu, nikdy schéma. Cílená záloha
  storage policies + bucketů a rollback SQL ve scratchpadu. Zápisy spustil
  Filip (klasifikátor blokuje produkční DDL z Claude): migrace přes
  `db query -f`, `migration repair 20260926071010`, secret
  `CANDLE_STORE_OWNER_USER_ID`, `functions deploy market-candle-store`.
- Chyba v Codexově funkci: `admin.rpc` volaný bez objektu (`this.rest`
  undefined → TypeError → obecná 503). Oprava `admin.rpc.bind(admin)`,
  druhý deploy. Testy Codexe kryly jen shared.ts, ne handler.
- Ověřeno v produkci: 22. 9. filled 12 s / 0,005 $ → hit 1,3 s / 0 $;
  souběh dvou požadavků na 23. 9. → jeden soubor (jeden nákup); 14 dní
  filled 10,7 s / 0,05 $; 16 dní hit 1,0 s / 0 $ (stará cesta ~6 s a platí
  pokaždé). Soubor ~22 kB/den. Security advisors přes MCP nešly
  (neautorizováno) — práva ověřena `has_table_privilege`/`has_function_privilege`.
- Pozor pro frontu snímků: den se uloží až 25 h po konci UTC dne; dřívější
  požadavek dostane data „uncached“ (platí znovu).

### 2026-09-28 — Obchod bez celého SL/TP: výsledkový box + štítek (Claude)

- Filip: vstup bez SL/TP (market in/out, jen SL, trailing stop položený po
  vstupu) byl v grafu jen šipkami. Návrh `mockups/trade-partial-sltp.html`,
  vybraná varianta C.
- Journal primitiv: `resultBox` (true = výsledkový box vstup → výstup vždy,
  když obchod nemá position box; dřív jen u obchodu úplně bez SL/TP) a
  `protectionNote` — štítek v řádku s popiskem výsledku: „bez SL/TP“,
  „bez SL“, „SL po 2:40“, „SL po 20 s · bez TP“ (jantarově = chyběl SL) nebo
  „bez TP“ (šedě). `entryProtectionNote` (lib/tradeReplay.ts): SL/TP
  platné do 10 s po prvním vstupu se počítají jako při vstupu
  (`ENTRY_PROTECTION_GRACE_MS` — stop po market vstupu). Trailing stop dál
  jako schody. CandleKit: detail/fullscreen/review/snímky; ostatní obchody
  review dostanou výsledkový box bez štítku. Vypnuté position boxy
  v nastavení → původní chování. Testy v `tests/snapshotRender.test.ts`.
- Ověřeno živě: obchod 25. 9. 20:42 (SL 20 s po vstupu, bez TP) →
  „SL po 20 s · bez TP“ + „+9,00 b. · +180,00 $“; obchod s celým position
  boxem beze změny. Snímek při vstupu ukazuje stav v tu chvíli („bez SL/TP“,
  pozdější SL do něj nepatří).

### 2026-09-28 — Vykreslovací stránka automatických snímků (Claude)

- Moje část náhrady kamery TradingView (návrh Codexe: noční fronta + worker
  se skrytým prohlížečem). Stránka `/?snapshotRender=<id obchodu>&mode=
  entry|exit&w=1600&h=900&theme=dark` (`lib/snapshotRender.ts`,
  `components/SnapshotRenderPage.tsx`) vykreslí graf obchodu stejně jako
  detail (`TradeMarketChart` prop `snapshotRender`): pevná velikost, bez
  lišty, přehrávání, úvodní animace, myši a ovládání `data-snapshot-hide`
  (nově i tlačítka měřítka A/L/% — platí i pro ruční Snímek), vždy s plnou
  historií (levely). `index.tsx` ji pouští místo appky a neregistruje ani
  neruší service worker (jeho `alert` by skrytý prohlížeč zablokoval).
- Signál pro workera: `<html data-snapshot-status>` `loading` → `ready` |
  `error`, detail ve `window.__alphatradeSnapshot` (tradeId, mode,
  `renderVersion` 1, rozměry, `error`). Ready = svíčky + dotažená historie
  + usazený záběr (`onViewportSettled` z CandleKitu) 400 ms v kuse + písma
  + 2 snímky. Timeout 60 s → `error`, stránka nikdy nevisí.
- `mode=entry` nevidí do budoucnosti: přehrávání stojí na svíčce vstupu,
  historie končí koncem prvního vstupního příkazu (+ SL/TP odeslané s ním,
  max 2 s, nikdy další plnění; `entrySnapshotMoment`), svíčka vstupu jen
  otevření → cena vstupu (`candleUntilFill`, maxima uvnitř minuty jsou jen
  odhad). Časová osa stejná jako u `exit` (snímky jdou porovnat).
- Přihlášení: zatím session v prohlížeči. `token` v URL → `error`, dokud
  Codex nedodá kontrakt jednorázového tokenu. Indikátory se berou z
  localStorage prohlížeče — pro workera je bude potřeba uložit na server.
- Ověřeno živě na obchodu z 25. 9. (1200×675): exit i entry `ready` za
  ~2,8 s; jednou `error` „journal-facts-unavailable“ po 21 s ze čtení
  obchodu (přechodné, další pokus prošel) — stránka chybu nahlásila. Pozor:
  snímek náhledu v panelu u okna většího než panel ořezává (pixely plátna
  byly v pořádku). Testy `tests/snapshotRender.test.ts`.
- Doladěno podle náhledů 4 posledních obchodů (Filip: užší svíčky, vše ve
  světlém režimu): výchozí motiv snímků světlý (`theme=dark` jen výslovně);
  CandleKit `tradeViewFrame` — snímek celého obchodu 50 svíček kontextu na
  obě strany (detail dál 15), snímek při vstupu 80 před a 20 za vstupem
  (vstup vpravo, bez prázdné poloviny budoucnosti) a bez popisku výsledku
  (`hideResultLabel`, průběžné „+0,00 $“). Čtení obchodu se na stránce
  opakuje až 3× (po čerstvém načtení občas visí do 20s limitu dotazu,
  `journal-facts-unavailable`; jde jen o čtení), timeout stránky 90 s.
  Náhled: dočasný `public/snapshot-preview.html` (NEcommitovat) — 8 snímků
  `ready` za 2,5–2,8 s.

### 2026-09-27 — Review týdne (Claude)

- Historie → „Review týdne“ (`components/WeeklyReview.tsx`, návrh
  `mockups/weekly-review.html`, varianta A): fullscreen workspace obchodu
  (stejné rozložení s ikonou 1/2/… grafů, indikátory, poznámky, Snímek) s
  místy pro review — pruh se souhrnem týdne a „Zkontrolováno x/y“, pás
  obchodů po dnech dole (místo časové osy plnění), hodnocení vpravo.
  `AlphaTradeChartWorkspace` prop `review` (header/side/bottom),
  `TradeMarketChart`/`AccountExecutionChart` prop `review` (vždy
  fullscreen, zavření/Esc = konec review; Esc v poli pro psaní ne).
- ← → přepínají obchody (mimo pole pro psaní a mimo aktivní Bar Replay),
  Enter = „Hotovo → další“ nezkontrolovaný. Hodnocení = stejná pole jako
  formulář Zkontrolovat: Dle plánu (Ano/Částečně/Ne → planAdherence +
  executionStatus/isValid), HTF/LTF confluence z preferencí, emoce, chyby,
  poznámka; ukládá `onUpdateTrade` → `needsReview: false`.
- Detaily Tradovate obchodů celého týdne jedním dotazem
  (`getJournalTradeDetails`), graf je dostane jako ověřené → přepnutí bez
  načítání detailu. Týdny/dny/souhrn v `lib/weeklyReview.ts` (+ testy).
- Ověřeno živě: týden 21.–25. 9. (61 obchodů), přepnutí šipkou vycentruje
  oba grafy, zavření vrátí Historii. „Hotovo“ na produkčních datech
  netestováno (mění hodnocení obchodu).
- Doplněno (Filip: „kousavé“ přepínání): graf v review zůstává stát —
  stabilní klíč ChartView (`reviewMode`), celá série, svíčky celého týdne
  jedním oknem (`review.loadTiming` v TradeMarketChart), kresby patří týdnu
  (`drawingKeyId`). Přepnutí obchodu = plynulý přejezd záběru (560 ms,
  cena autoscale), přestavba překryvů navázaných na vstup až po animaci.
  Změřeno: stejné plátno (bez remountu), animace začne za ~140 ms, ~108
  snímků/s. Ostatní obchody týdne tlumeně (`muted` v journal primitivu:
  alfa 0,3, bez najetí, bez vlivu na osu). Nahoře „‹ Obchod n / N ›“.
- Kolo 2 (Filip: pořád trochu sekavé; ostatní obchody normálně, popisek
  výsledku jen u aktuálního; obchod v jedné minutě není vidět):
  - Ostatní obchody plně (bez tlumení), bez popisku výsledku a bez najetí;
    vrstva se vytvoří jednou za týden (dřív při každém přepnutí 60+
    primitivů), vybraný se v ní jen skryje (`isHidden`).
  - Žádná přestavba grafu po přepnutí; FVG vstupu / struktura vstupu se v
    review nekreslí. TradeMarketChart počítá indikátory klasického grafu
    jen pro klasický engine (dřív struktura přes celý týden při každém
    přepnutí). Bez kaskády renderů: koncept hodnocení odvozený (ne efekt),
    úvodní animace a okno svíček v review se nenastavují.
  - Změřeno (dev): dlouhé úlohy při přepnutí 68 + 98 ms → ~56–60 ms,
    vykreslení snímku grafu ~7 ms. Produkce bude rychlejší.
  - `journalVisibleSpanCoordinates`: úsek celý uvnitř jedné svíčky (vstup i
    výstup v téže minutě) → box/čáry SL/TP přes celou svíčku; úseky ořízlé
    chybějící svíčkou zůstávají přesné (+ testy).
- Position boxy i u ostatních obchodů týdne (bez štítků na ose, vytvoří se
  jednou za týden spolu s šipkami; vybraný kreslí hlavní vrstva). Změřeno
  (dev): animace ~10 ms/snímek, start přepnutí ~65 + 90–115 ms.
- Kolo 3 (Filip: blízké obchody se trhají; při velkém oddálení se graf seká):
  - Přejezd startuje hned při kliknutí událostí `REVIEW_FOCUS_EVENT` přímo v
    grafu (mimo React). Panel, pás a pruh se kreslí přes portál do míst ve
    workspace (`onSlotsReady`) a graf je memo prvek → změna výběru graf
    nepřekresluje; graf převezme nový obchod až po dojetí (540 ms, transition).
    Karty pásu jsou memo. Změřeno (dev): první snímek přejezdu 180 → ~30 ms,
    dál 7–9 ms; ~75 ms až po dojetí, kdy graf stojí.
  - Oddálení: 5 křivek VWAP z Liquidity Levels se kreslilo bod po bodu
    (~338 000 `lineTo` na snímek). `drawCurve` ředí na ~1 bod/px → ~6 000;
    snímek při maximálním oddálení ve Filipově okně (2469 px) 80–95 → 7–11 ms.
    Platí pro všechny grafy s Levely (detail, fullscreen, backtest).
- Kolo 4: šipky nového obchodu se po dojetí na 1,2 s ukážou jako po najetí
  myší (zvětšené, záře, popisek) — `highlightMs` v journal primitivu, čas se
  drží podle obchodu v CandleKitu (vrstva se může přestavět); skutečné
  najetí myší zvýraznění převezme. (První pokus s „pulzem“ se neprojevil —
  vrstva se po přepnutí vytvořila dvakrát a pulz zanikl.) Pravý panel kompaktní (252 px, návrh
  `mockups/review-panel-compact.html`, Filip: „C, ale vybrané jako dlaždice
  z B“): rozbalovací sekce (`ReviewSection`, výška animovaná 0fr → 1fr,
  zavřené `inert`), sbalená sekce ukazuje vybrané dlaždice s pružinkou
  (klik = odebrat) a počet u názvu; stav rozbalení drží i při přepnutí;
  Hotovo/Přeskočit pevně dole. Oprava: mřížka Vstup/Výstup ve sloupci s
  posouváním se smrskla na 2 px (overflow-hidden + shrink) — děti `shrink-0`.
- Kolo 5 (2026-09-28, Filip: týden 14.–18. 9., obchod 12/38 — obchody i
  boxy ~300 bodů nad svíčkami): review bral svíčky celého týdne podle
  kontraktu PRVNÍHO obchodu, týden přes rollover (MNQU6 → MNQZ6) pak kreslil
  prosincové ceny na zářijové svíčky. Teď `loadReviewWeekCandles`
  (`services/tradeChartData.ts`) → `loadMarketCandlesForEntries` /
  `resolveContractsForEntries` (`services/marketData.ts`): kontrakt se volí
  pro každý obchod zvlášť podle vzdálenosti vstupní ceny od svíčky
  (`priceDistanceFromCandle`, >10 bodů → zkusí čtvrtletní kontrakty kolem
  data), každý kontrakt se stáhne jednou. `review.data` předává
  TradeMarketChartu svíčky vybraného obchodu (už si je nenačítá sám),
  ostatní obchody týdne se kreslí jen ze stejného kontraktu. CandleKit po
  výměně série v review znovu vycentruje obchod (staré logické indexy by
  ukazovaly jinam). Obchod mladší než 24 h drží poslední graf + poznámku.
  Test `tests/reviewContracts.test.ts`. Ověřeno živě: 12/38 (Dec, 29 437)
  i 1/38 (28 940) sedí, přepínání tam a zpět vycentruje.
- Kolo 6 (Filip): zvýraznění po přepnutí jen šipky + čáry k cenové ose,
  bez štítků u šipek (`labelsQuiet` v journal primitivu, platí i během
  doznění; štítky vrátí až skutečné najetí). Otevírání review: místo hlášek
  „Načítám obchody týdne…“ / „Načítám graf vybraného účtu…“ točící se logo
  appky (`QuantumSpinner` z `QuantumLoader.tsx`) — fallback lazy importu,
  načítání týdne i Suspense grafu; zavřít jde křížkem v rohu. Změřeno:
  spinner od 83 ms, graf ve 2,3 s, žádný text mezi tím. Doladěno (Filip:
  větší, „hryzne a jede odznovu“ 2×): 128 px jako úvodní loader; během
  otevírání se vystřídají 3 instance (70/384/1629 ms) a CSS animace každé
  startovala znovu (druhá navíc o ~240 ms později než render). Teď Web
  Animations se `startTime = 0` → fáze z hodin dokumentu; změřeno 0°
  odchylka přes všechny instance (104 vzorků).
- Víc obchodů v jedné svíčce (Filip: 22. 9. 10:50 ×2 + 10:51): šipky se
  skládaly jen v rámci jednoho obchodu, každý obchod týdne je vlastní vrstva
  → šipky různých obchodů ležely přes sebe. `createJournalArrowStacks`
  (sdílený registr, option `arrowStacks`) skládá šipky všech obchodů podle
  času prvního plnění; vybraný obchod (hlavní vrstva) dostane stejné místo
  jako ve vrstvě ostatních → po přepnutí neposkočí. + test.
- Nasazeno 2026-09-28 (80d54b9). Kolo 7 (Filip: obchod vždy celý vidět i s
  position boxem, daleký TP → svíčky se smrsknou): fullscreen/review
  CandleKit neměl `autoscaleLevels` (jen klasický detail). Review má vlastní
  primitiv `createReviewPriceFocus` (rozsah = plnění + všechny SL/TP,
  `journalTradePriceRange`): cenová osa = svíčky v záběru + vybraný obchod,
  při přepnutí se rozsah přelije za 520 ms souběžně s přejezdem (easing,
  `requestUpdate` → fullUpdate přepočte autoscale). Obchod z jiného
  kontraktu do osy nevstoupí, dokud nepřijdou jeho svíčky. + test.
- Kolo 8 (Filip: osa se při přepnutí „sekem zmenší a hned zase zvětší“;
  prodleva, než se rozsvítí šipky):
  - Měřeno po snímcích (`priceScale().getVisibleRange()`): horní hrana osy
    skočila o 45 bodů v jednom snímku. Dvě příčiny: (1) událost přepnutí
    nesla id obchodu ze seznamu, graf zná sloučené obchody pod id zdroje →
    obchod „nenalezen“, rozsah vynulován, po převzetí obchodu zpět;
    (2) `drawingOptions` v CandleKitu závisely na `trade.id` i s klíčem týdne
    → každé přepnutí = nový DrawingController a nové API grafu → všechny
    vrstvy (i ~60 primitivů ostatních obchodů, rozsah osy) se připojily
    znovu. Oprava: id zdroje v události; klíč kreseb z `drawingKeyId ??
    trade.id`. Po opravě: 0 nových připojení, přechod 78 snímků, max 9 bodů
    za snímek, bez otočky osy.
  - Zvýraznění šipek začíná hned při kliknutí ve vrstvě ostatních obchodů
    (`highlight()` na journal primitivu), hlavní vrstva ho po převzetí
    dokončí bez nového nafouknutí (`highlightContinues`); 1,4 s od kliknutí
    (dřív start až ~0,54 s po kliknutí). + test.
- Zatím ne: hvězdičková známka.

### 2026-09-27 — Detail obchodu otevírá rovnou graf (Claude)

- Filip: graf se načítá rychle → výchozí pohled detailu je graf, snímky jsou
  druhá záložka. Obchody mladší než 24 h (Databento svíčky ještě nemá,
  `tradeChartDataAvailable`) dál začínají snímkem. `defaultVisualMode` v
  `TradeDetailModal`, i při přepnutí na další obchod.

### 2026-09-27 — Tlačítko Snímek v grafu obchodu (Claude)

- Detail i fullscreen obchodu mají „Snímek“ (`components/ChartSnapshotButton.tsx`):
  vyfotí graf, jak je vidět (šipky, SL/TP, indikátory, poznámky; fullscreen
  celé rozložení grafů), krátce blikne a uloží obrázek ke Snímkům obchodu
  stejnou cestou jako vložený screenshot (`onAttachScreenshotFile`), graf
  zůstane otevřený. Stav na tlačítku (Ukládám… / Uloženo / chyba).
- Focení: `captureChartWorkspaceSnapshotDataUrl(…, { hideControls })` —
  html-to-image bez prvků `data-snapshot-hide` (přehrávací lišta detailu,
  legenda indikátorů, Bar Replay lišta fullscreenu). Backtest beze změny.
- Ověřeno: focení detailu 0,4 s, 1230×1100 px, bez ovládání; tlačítko ve
  fullscreenu. Nahrání testováno nebylo (uklidit testovací snímek z
  Tradovate obchodu nejde) — jde přes existující cestu vložení snímku.
- Oprava (Filip: snímek z fullscreenu „špatně oříznutý“): kořen workspace
  je `absolute left-[52px]` a html-to-image si umístění klonu přenese → obraz
  ujel o 52 px doprava, pravá cenová osa se usekla, vlevo prázdný pruh.
  Při focení se kořeni nuluje left/top/margin/transform (`style` v toPng);
  ověřeno: 1982×1054 px, oba grafy celé i s osami. Platí i pro backtest.
- Pozn.: ruční snímky jdou do bucketu `trade-images` přes getPublicUrl
  (veřejné URL) — dotaz na Codexe spolu s návrhem auto snímků z našeho grafu.

### 2026-09-27 — Šipky jako v TradingView, vteřiny a přesné držení (Claude)

- Šipky plnění stojí nad/pod svíčkou (nákup pod low hrotem nahoru, prodej
  nad high), uprostřed svíčky; víc šipek stejné strany v jedné svíčce se
  vyskládá. Najetí kamkoli do těla svíčky s plněním (nebo na šipku) ukáže
  přesné plnění: značka na ceně uvnitř svíčky, tečkovaná spojnice a štítek
  s časem na vteřiny. Priorita: šipka > svíčka > čára SL/TP; čára vyhraje
  i ve svíčce, je-li kurzor přímo na ní (≤ 3 px / svislý posun ≤ 5 px).
- Detail: Vstup/Výstup na vteřiny, Držení z přesných časů
  (`lib/holdDuration.ts`: „54 s“, „3 min 12 s“, „1 h 05 min“) místo
  zaokrouhlených „0 min“.
- Cenová osa v detailu: jen vstup a výstup, bez popisků, v barvě šipek
  (short vstup červeně, výstup modře). SL/TP na ose ne (Filipovo přání) —
  ani štítky position boxu (`priceLabels` vypnuté v `centeredTradeView`).
  Dřív tam byl vstup vždy modře a SL bez popisku (30 900 = SL zadaný až
  během obchodu, proto R „bez stopu“). Po najetí na šipku tenká čára od
  plnění k ose a štítek ceny na ose (priceAxisViews).
- Zvětšení krátkých obchodů v grafu zatím ne — se šipkami nad/pod svíčkou
  je vstup i výstup ve stejné minutě vidět; vteřinová data (Databento
  ohlcv-1s) jen případně později přes Codexe.

### 2026-09-27 — Poznámky v grafu detailu obchodu (Claude)

- Varianta B z `mockups/chart-notes.html` (Filip vybral): dvojklik nebo menu
  grafu „Přidat poznámku“ připíchne bod (čas 1m svíčky + cena), bublina jede
  za myší, klik ji položí a píše se (Enter uloží, Esc zruší). Bublinu jde
  přetáhnout (odstup v px, při zoomu stejný), bod taky (přichytí se ke
  svíčce, bublina stojí); klik bez tahu = úprava/smazání. Dlouhý text se
  sbalí na 4 řádky, po najetí celý. V přehrávání až od svého času.
- `components/ChartNotesLayer.tsx`: DOM vrstva nad grafem, polohy přímo v
  DOM z prázdného primitivu série (`updateAllViews` = každé překreslení).
  Data `lib/chartNotes.ts` (+ testy): položky `type: 'note'` v
  `trade.drawings` — sloupec, který DB trigger u Tradovate obchodů povoluje,
  takže bez migrace. 8 obchodů má v `drawings` staré kresby; zůstávají.
- Ukládání: detail → `TradeHistory.saveChartNotes` → App
  `handleSaveChartNotes` → `handleUpdateTrades` (jako snímek: sloučená karta
  do všech účtů, nesmaže „nezkontrolováno“, zruší předstažený detail).
  Detail drží optimistický stav, nepovedené uložení vrátí.
- Ověřeno živě na sloučeném obchodu 24. 9. 18:30: přidání, uložení do 4
  řádků (read-only SQL), přetažení bubliny i bodu, smazání (v DB 0).
- Fullscreen obchodu: stejné poznámky v každém panelu (i 5m/15m/…: bod leží
  na svíčce, která jeho čas obsahuje), přidávání/úpravy odtud ukládá detail.
  Čas pod myší se bere ze série grafu (`dataByIndex`) — fullscreen kreslí jen
  výřez dat, pozice v poli nesedí. Rozdělanou poznámku má vždy jen jeden
  panel; pole pro psaní se zaměří až po dokončení kliku (graf si fokus bere
  zpět), prázdnou bublinu zavře jen klik mimo. Backtest poznámky nemá.
  Ověřeno: přidáno na 5m, vidět na 1m i v detailu, smazáno.
- Otevřené: `get_public_trade` vrací `drawings` vždy → poznámky jsou u
  veřejného obchodu čitelné z API, i když se nikde nezobrazují (sdílená
  stránka graf nemá). Filip chce přepínač — navrženo: řídí je
  „Sdílet i poznámku“ (`share_notes`); úprava RPC = Codex.

### 2026-09-26 — Indikátory detailu = fullscreen obchodu, úpravy v legendě (Claude)

- Filipovo zadání: v detailu je to, co ve fullscreenu; v detailu jde
  upravit/skrýt/odebrat, přidává se ve fullscreenu. Tlačítko „Indikátory“
  v liště detailu (`DetailIndicatorMenu`) zrušeno.
- Sdílený stav `{fvg, levels, structure}` v `services/detailIndicators.ts`
  (klíč `alphatrade:detail-indicators`, událost pro otevřené grafy). Starší
  zápis se samostatným VWAP se čte jako levely — VWAP je teď jako ve
  fullscreenu součást stylu levelů (maskování `detailIndicatorSettings`
  zrušeno, detail ukazuje levely přesně podle stylu).
- Fullscreen obchodu (`AlphaTradeChartWorkspace` bez backtest session) si
  dřív zapnuté indikátory nepamatoval vůbec; teď panely startují ze
  sdíleného stavu a každé zapnutí/odebrání se propíše zpět. Backtest beze
  změny (má vlastní stav panelů).
- Legenda v detailu: Skrýt (dočasně) / Nastavit / Odebrat (= vypnout i ve
  fullscreenu). Nastavení se uloží jen globálně — panel `alphatrade-chart-1`
  globální obálky + „naposledy použitý“ styl — nikdy do otevřené backtest
  session. Dialog nastavení je v portálu (modal detailu ho ořezával) a v
  detailu nemá „Na všechny grafy“.
- Ověřeno živě: legenda má 3× Skrýt/Nastavit/Odebrat, uložení FVG max 5 se
  propsalo do obou úložišť, fullscreen startuje se stejnými 3 indikátory,
  odebrání struktury ve fullscreenu → detail ukáže 2. Filipovo nastavení
  po testu vráceno.

### 2026-09-26 — LIVE na telefonu: přepínač followera, Flatten All, úprava skupiny (Claude, jen UI)

- Rozhodnutí uživatele z mockupů `mockups/live-mobile-controls.html` a
  `mockups/live-mobile-decisions.html`: přepínač vlevo jako na desktopu (A),
  Flatten All potvrzovaný spodním listem s výčtem (A), úprava skupiny jako
  seznam se souhrnem → detail followera (B), DLL/DD vždy jako tichý řádek pod
  jménem. Režim replikace se v mobilním editoru vůbec nenabízí (uživatel ho
  nemění); uložená hodnota zůstává a jiná než „Při zadání“ je vidět v souhrnu.
- Telefon nemá hover: zamčený `FollowerCopySwitch` s `onBlockedTap` zůstane
  klepnutelný a důvod (`participationBlockerLabel` překládá kódy automatického
  vyřazení) ukáže pod řádkem; odmítnutí workerem tamtéž místo toastu.
- Opraveno na mobilu: pozice ze starého čtení se tvářily ověřené (chyběly
  `positionsVerified/ordersVerified/staleLabel`), otevřený P&L bez tečky
  „stale“, rozbalené řádky za šestým bez `tradeCut`, ručně vypnutý follower
  v jantarovém „N/M aktivních“. Přidáno: „N× nedostupný“, skrytí jmen v ⋮,
  rychlý násobek (klepnutí na ×N → stejný `set-multiplier`; list výslovně
  říká, že worker při změně konfigurace kopírku odzbrojí), detail pozice na
  klepnutí (HoverCard přepíná dotykem).
- Rychlé přepínání více followerů po sobě selhávalo: runCommand kontroloval
  `busyCommand` ze zastaralého uzávěru (druhé klepnutí během čekání prvního
  nikdy nedošlo k workeru) a přes relay (~3 s) nestačila okna opakování na
  přechodné „Stav se během ověření změnil“. Nově `busyCommandRef`, fronta
  přepnutí a 4 pokusy s pauzou 0,7/1,4/2,1 s. Worker log 26. 9. 16:57Z
  potvrdil přechodná odmítnutí; jádro beze změny.
- Karta dne (LiveDayCard) jako u Spotify: najetí myší ±15° (dřív ±3°),
  dotyk/stisk zhoupne kartu k prstu a pruží zpět, na telefonu gyroskop ±10°
  s pomalu se přizpůsobující klidovou polohou. Gyroskop bez nativní změny:
  Capacitor `WebViewDelegationHandler` schvaluje DeviceOrientation `.grant`;
  `requestPermission()` se volá synchronně z klepnutí na „Dnešní P&L“.
- Připomínka před zapnutím kopírky, když je některý follower ručně vypnutý —
  platí i pro desktop (stejný `requestGroupPower`), jen UI krok `proceed`.
- DLL/DD výpočet vytažen do `accountRiskValues`, sdílí ho desktop i mobil.
  Jádro kopírky beze změny. Ověřeno: 438 souborů / 4 054 testů, typecheck,
  cílený ESLint, produkční build a proklikání v dočasném náhledu na 375 px.
  Pushnuto na main po „nasaď“. iOS build z worktree `claude/live-mobile-controls-20260926`
  nainstalován čistě (uninstall + install); první build byl bez `.env.local`
  (worktree ho nemá) a visel na splashi — opraveno symlinkem, viz paměť iOS.

### 2026-09-26 — Animace svíček v přehrávání detailu (Claude)

- Varianta C z `mockups/replay-candle-animation.html`: nová svíčka během
  kroku „žije“ (open → extrémy → close). Pořadí high/low v 1m datech neznáme,
  proto `lib/candleReplayPath.ts` cestu **ukotví na plnění obchodu** v té
  minutě (přesný čas i cena) — SL/TP/vstup ve stejné svíčce se tak nikdy
  neukáže v opačném pořadí. Zbylé extrémy: býčí low→high, medvědí high→low,
  do nejdelší volné mezery. Konec kroku = vždy skutečná svíčka. Bez dalších
  dat (sekundová data odmítnuta jako zbytečná).
- `TradeMarketChart`: `setInterval` nahrazen rAF smyčkou; rozpracovaná
  svíčka jde přímo do `controller.updateBar` mimo React (záběr se při
  přidání baru vrací na původní logický rozsah), kurzor + indikátory až po
  dokončení kroku. Pauza svíčku dokončí, krok/Go To animaci zruší, změna
  rychlosti pokračuje z rozehraného místa. Jen timeframe 1m; s
  `prefers-reduced-motion` svíčka naskočí celá jako dřív.
- Testy `tests/candleReplayPath.test.ts` (5). Ověřeno živě v detailu
  (0,5×: poslední cena se v kroku mění, záběr stojí, pauza nechá celou svíčku).

### 2026-09-26 — FVG vstupu automaticky (Claude)

- Filip vstupuje na hraně FVG, někdy na starším nevyplněném mimo limit
  posledních N. `findEntryEdgeFairValueGap` (marketDataCalculations): FVG
  vzniklé nejvýš 26 h před vstupem, nevyplněné do vstupu (svíčka vstupu se
  nezapočítá), hrana = aktuální zbývající hrana po částečném vyplnění,
  první plnění do ±1 tick (0,25) od ní; víc kandidátů → nejbližší, pak
  novější. Bez tagu, jen se zapnutým FVG; ruční tag dál přes
  `findEntryFairValueGap`.
- Graf: ukáže se i mimo limit posledních N, vypadá jako ostatní FVG (bez
  obrysu a štítku — Filipovo přání). V přehrávání v detailu až od vstupu
  (nic neprozradí dopředu).
- Na 40 posledních obchodech (7.–24. 9.) našel FVG vstupu u 15, i 6 h starý
  (24. 9. 15:47 short). Některé nálezy jsou drobné půlbodové FVG vzniklé
  minutu před vstupem — může jít o náhodu; zatím bez filtru velikosti.

### 2026-09-26 — Sekání grafu s indikátory: lineární hledání svíčky (Claude)

- Změřeno v detailu (16 dní historie, přehrávání): struktura 7 fps
  a 3,5 s blokování ze 4 s, se všemi čtyřmi indikátory úplné zamrznutí
  (snímek 1,2 s). Příčina: `nearestCandleIndex` v CandleKitTradeChart
  hledal lineárně a `structureOverlayEvents` ho volá pro každou událost
  struktury (≈1 960 událostí × 15k svíček) v každém kroku.
- Oprava: binární hledání v `services/candleSearch.ts` (stejný výsledek
  vč. remízy → dřívější svíčka; test proti staré lineární verzi na 200
  náhodných děravých osách). Pomáhá i backtestu. Po opravě se všemi
  čtyřmi: 246 ms blokování za 6 s, levely 24× ~19 ms (škrcené 4×/s),
  ostatní výpočty pod 10 ms.
- Limit struktury: nové nastavení „Max počet posledních BOS/CHoCH“
  (`structure.maxCount`, výchozí 10, 1–50) jako u FVG; kreslí se jen
  posledních N (+ struktura vstupu). V detailu mimo přehrávání „posledních“
  k výstupu obchodu + 30 min, v přehrávání do kurzoru.
- Plynulost levelů (Codexův krok „c“, bez změny výsledku): `weekKey` jen při
  změně obchodního dne (dřív Date + ISO text pro každou z 12k svíček),
  `afterIb` jen od RTH openu, ATR svíček průběžně bez pomocného pole (stejné
  pořadí operací). 12k svíček: medián 10,5 → 2,3 ms, p95 13,2 → 6,1 ms.
  Shoda hlídaná testem proti zamrzlé referenci
  (`tests/fixtures/liquidityLevelsReference.ts`): DST jaro/podzim, týden,
  chybějící svíčky, posuvné 12k okno, kroky přehrávání, <14 svíček, 3 sady
  nastavení. Krok přehrávání v detailu teď stojí s indikátory i bez nich
  ~20 ms (dev) — akumulátor ani worker zatím nejsou potřeba.
- Struktura kouká do budoucnosti? Výpočet je kauzální (swing potvrzený
  následující svíčkou, zlom na zavření svíčky), v přehrávání se událost
  objeví až po zlomu. Popisek leží v půlce mezi swingem a zlomem, takže ve
  statickém grafu sedí vlevo od zlomu — může tak působit. Čeká se na
  konkrétní případ od Filipa.
- BOS/CHoCH „z budoucnosti“ při přehrávání od začátku: mimo přehrávání se
  struktura kreslí jako generované kresby `auto-structure-*` z celé série;
  dřív je smazal nový ChartView při startu přehrávání, detail ho ale drží
  (stabilní klíč). Oprava: v detailu (`centeredTradeView`) se při
  zapnutí/vypnutí přehrávání přestaví překryvy (`handleReady`), což `auto-`
  kresby smaže a v přehrávání je nevytvoří. Ověřeno naživo.
- Přepínače indikátorů v detailu byly po reloadu pryč: čtení běželo dřív,
  než se ověřilo přihlášení (jiný klíč než zápis). Přepínače teď bez ID
  uživatele (volba zobrazení v prohlížeči); styl se znovu přečte po
  `onChartAppearanceScopeBroadcast`.

### 2026-09-26 — Klient soukromého skladu svíček (Claude)

- `loadMarketCandles` → `fetchCandleRange` zkouší nejdřív
  `market-candle-store` (Codexův server, zatím NEnasazený), při jeho
  nedostupnosti dosavadní `market-candles`. Rozhodování v
  `services/candleStoreClient.ts` podle `docs/CANDLE_STORE_SERVER_HANDOFF.md`:
  202 store-pending = čekat a opakovat (max 60 s), **nikdy** současně placená
  záloha; 404 no-data = prázdná řada; 409 = stará cesta (ořízne konec);
  402/429/400 = chyba bez zálohy; 401/403/404 funkce/503 store-not-configured
  = stará cesta a sklad do konce relace vypnout.
- Jiný 503 → jedno automatické opakování po 1 s, pak stará cesta (graf se
  musí dát otevřít i při rozbitém skladu) — Codex schválil s výhradou: zámek
  chrání jen souběžné běžné požadavky. Selže-li sklad až po stažení
  z Databenta, nebo síť bez HTTP odpovědi, záloha může zaplatit tatáž data
  znovu; jediný nákup je zaručený jen přes 202 store-pending.
- Zjištění: nenasazená funkce v prohlížeči neprojde CORS → supabase-js vrátí
  `FunctionsFetchError` bez HTTP odpovědi, ne 404 → stará cesta a sklad
  5 min nezkoušet. Ověřeno naživo: první nový den +37 ms na neúspěšný
  pokus, další dny sklad přeskočí. Vypínač `at:dev:candle-store=off`.
- Databento dnes znovu výkyv: 1 seance 16 s (běžně 4–6 s).

### 2026-09-26 — Indikátory v detailu obchodu (Claude)

- Jedno tlačítko „Indikátory“ v liště detailu (`DetailIndicatorMenu`):
  Levely, VWAP, FVG, Struktura. Volba platí pro všechny obchody
  (localStorage `alphatrade:detail-indicators`, po uživateli). VWAP je
  součást indikátoru levelů — „jen VWAP“ = levely se vším ostatním vypnutým
  (`detailIndicatorSettings` v `services/chartIndicatorSettings.ts`).
- Styly jen pro čtení (podmínka Codexe): detail nikdy nečte otevřenou
  backtest session. Backtest/fullscreen při uložení stylu indikátorů zapíše
  i „naposledy použitý styl“ (`services/detailIndicators.ts`), styl uložený
  dřív jen v session se povýší při jejím otevření. CandleKit dostane
  `indicatorSettingsOverride`: nic neuloží, legenda bez nastavení/odebrání,
  ignoruje změny z jiných grafů.
- Levely a VWAP až s plnou historií (PDH/PDL/PWH z neúplných dat by lhaly):
  zapnutí spustí dotažení 16 dní po načtení seance; do té doby jen FVG
  a struktura, v menu kolečko. V přehrávání se počítá jen z odkrytých
  svíček (ověřeno naživo — nic dopředu).
- Databento: appka povoluje jen `ohlcv-1m` a `ohlcv-1h`; Databento má
  i sekundové a tickové schéma (~60× víc dat) — pro detail zbytečné.

### 2026-09-26 — Rychlost grafu v detailu: měření, seance napřed, předstažení (Claude)

- Měřeno na :3000 (dev). Obchod v cache prohlížeče: 1,1 s od kliknutí na
  graf, z toho 0,7 s = 7 Supabase dotazů za sebou (detail obchodu), 54 ms
  svíčky z IndexedDB, ~0,3 s vykreslení 15k svíček. Nový obchod: navíc
  4–6 s (jednou výkyv 34 s) — pevná režie edge funkce `market-candles`
  (metadata.get_cost + timeseries.get_range za sebou), skoro nezávislá na
  velikosti okna; 16 dní 0,06 $, jedna seance ~0,005–0,015 $.
- Detail načte nejdřív jen seanci (`marketDataSessionWindowForTrade`:
  od půlnoci Praha dne vstupu − max(2 h, délka obchodu), konec jako plné
  okno). Plných 16 dní až po posunu doleva (`onNeedOlderHistory`) nebo ve
  fullscreenu, vždy až po dokončeném prvním načtení a ke stejnému kontraktu
  (`loadTradeChartHistory(loadedSymbol)`) — podmínky od Codexe.
- Předstažení: detail po 1 s (ne při rychlém listování — limit 12 dotazů/min
  na tržní data) stáhne na pozadí detail obchodu i svíčky seance
  (`services/tradeChartData.ts`, sdílený výpočet časů/okna s grafem).
  Detail si graf vyzvedne jednou (lhůta 3 s kvůli dvojímu efektu
  StrictMode, nevyzvednutý zastará za 60 s).
- Výsledek: obchod v cache 0,08 s od kliknutí (první graf po načtení
  stránky ~0,7 s kvůli inicializaci modulů); nový obchod po předstažení
  0,3 s, bez čekání dál 4–6 s (jen 1 dotaz místo 2).
- Další fáze (ne teď): neveřejný serverový sklad svíček —
  `docs/CANDLE_STORE_PLAN.md`; stavět až po změření částí a ověření licence.

### 2026-09-26 — Ruční vypnutí followera ve skupině + animace přepínačů (Claude UI, Codex jádro)

- Nové pole `enabled` ve `CopyFollowerConfig` + příkaz `set-follower-enabled`
  (Codex). Nezávislé na `mode`: `mode: 'off'` nastavuje i runtime při
  automatických vyřazeních a zapnutí musí vrátit `on-submit`/`on-fill`.
  Přepnout jde jen když leader i follower nemají pozici ani příkaz — worker
  to ověřuje na `eventTail`, UI jen zamyká podle
  `controller.followerParticipation`. Reconciliation u vypnutého followera
  očekává 0. Zadání a diskuse: `docs/reviews/follower-toggle.md`.
- Proč ne obecný `update-group`: dnes nejdřív DISARMuje. Výjimka z pravidla
  „přepnutí nikdy nevypne kopírku": selže-li zápis group.json i rollback,
  runtime fail-closed odzbrojí (Codex, souhlas Claude).
- UI: přepínač na začátku řádku followera (knoflík hned na stranu záměru +
  kolečko do potvrzení workerem, pulz / zatřesení při odmítnutí, zámek
  v knoflíku když nejde přepnout), vypnutý řádek zešedne bez štítku,
  hlavička „kopíruje 3/4", připomínka v toastu při ARM. Stejná animace
  u přepínače skupiny (kolej/ON zezelená až po potvrzení).
- Čekající limit s bracketem už nehlásí „bez SL": Suspended SL/TP se
  u čekajícího vstupu počítají (otevřená pozice dál jen Working).
- Mobilní karty přepínač zatím nemají — samostatná session.
### 2026-09-24 — Nový detail obchodu: A2, galerie, graf jako fullscreen, průběh a přehrávání (Claude)

Podle odsouhlaseného náhledu `mockups/trade-detail-final.html`. Nic se
nenasazovalo, stav je v pracovní složce.

- `TradeDetailModal`: hranaté okno (8 px), hlavička (symbol, směr, validita,
  datum · čas, Nezkontrolováno + Zkontrolovat/Upravit, ‹ ›, sdílet, ⋯ s
  Upravit / BE / Smazat, zavřít). Levý sloupec: čistý výsledek + hrubě a
  poplatky z `executionHistory`, tenké dlaždice (vstup/výstup s časem, pohyb
  v bodech, velikost, držení, R), účty, hodnocení, konfluence, intel,
  galerie snímků + řádek „Interaktivní graf“ (zelený obrys). Snímek ↔ graf
  se prolnou (`.trade-stage-layer`), graf se připojí až při prvním otevření.
  Poznámka pod plochou jde upravit na místě. „Označit jako BE“ je v ⋯.
- R u deníku = čistý P&L / (vzdálenost vstupu od SL platného při vstupu ×
  kontrakty × point value) za JEDEN účet — u sloučené karty hlavní účet
  (v grafu vybraný); součet účtů proti riziku jednoho by R zkreslil.
- `TradeMarketChart variant="detail"`: jen trh · 1m · CME, Obchod, Průběh,
  Fullscreen; bez timeframů, indikátorů a kreslení (vše ve fullscreenu).
  Přehrávání: kurzor po 1m svíčkách, `CandleKitTradeChart` dostane odkryté
  svíčky + `replayActive` a historii oříznutou `historyAt()` — nový prop
  `journalHistoryInReplay` nechá SL/TP čáry kreslit i v replayi (backtest
  ho nepoužívá, beze změny). `TradeReplayBar` = vzhled Bar Replay z
  workspace; Go To skáče na události.
- `lib/tradeReplay.ts` (+ testy na skutečném shortu 23. 9.): události z
  historie (sloučená dílčí plnění, důvod výstupu stop/cíl/ručně, posuny
  SL/TP jen při změně ceny, ≥ 3 posuny SL za sebou = série), `historyAt`,
  `initialRiskPoints`. `TradeProgress`: bubliny z tlačítka Průběh se
  skládají pod sebe (každá 2,2 s, max 6), klik = celý seznam.
- `AccountExecutionChart` při obnovení stejného obchodu na pozadí už graf
  neodpojí (jinak se vynulovalo rozběhnuté přehrávání).
- Box pozice (`journalPositionDrawing`) se u obchodů kopírky nikdy
  nevykreslil: čekal na SL/TP `confirmed` + `operation: 'new'`, ale Tradovate
  posílá `new` jako pending a potvrzení jako `modify` pár ms po plnění. Nově
  platí úroveň potvrzená do 2 s po vstupu (fallback: původní pravidlo);
  zábrany (strana, souběžné rozporné ceny, výpadek) zůstávají. Otevřená
  pozice (přehrávání) má box do `observedThrough`, neúplná žádný. Testy.
- Čáry SL/TP v `journalChartPrimitive`: SL červeně, TP zeleně (dřív oranžová
  a modrá = barvy výstupu a vstupu). Platí i ve fullscreenu.
- Detail: štítky na cenové ose (`createPriceLine`) jen pro to, co box
  neukazuje — aktuální SL/TP, když se liší od původního, nebo vše bez boxu.
  Při prvním zobrazení se svíčky odkryjí zleva doprava (`.trade-chart-reveal`).
- Plnění v grafu jako šipky (TradingView): nákup modře zespodu, prodej
  červeně shora, hrot na ceně; dílčí plnění příkazu = jedna šipka
  (`tradeFillGroups`). Šipky jsou tenké (čára + otevřený hrot); po najetí
  myší (`subscribeCrosshairMove`, hit-test v primitivu) se animovaně zvětší
  a ukážou štítek „Vstup / Přikoupeno / Částečný výstup / Výstup · Buy 6 ·
  cena · čas“. Trvalé popisky ani tlačítko Popisky nejsou — uživatel nechce
  další ikony. Odkrývání svíček se spustí při každém návratu na graf
  (`revealKey`).
- Čáry SL/TP jsou tenké (1 px); po najetí (±10 px, přes konce úseku 4 px)
  se celá linie daného druhu zesílí a u kurzoru ukáže štítek „SL cena ·
  ±body · ±USD · N MNQ“ — `protectionValueAt` v `lib/tradeReplay.ts`
  počítá pro pozici otevřenou v okamžiku pod kurzorem (průměrná cena,
  přikoupení mění průměr, částečný výstup zmenšuje velikost; před vstupem
  „plán“ podle prvního příkazu, po uzavření nic). Hodnota bodu podle
  kontraktu obchodu (MNQ 2, NQ 20 $), ne podle zobrazeného grafu.
  Svislý úsek (okamžik posunu) má vlastní zásah a štítek „SL a → b ·
  ±body · ±USD · posun ±b. · čas“ — body/USD = hodnota NOVÉ úrovně (jako na
  vodorovné čáře; dřív tu byl jen posun a „+20 b.“ u SL v mínusu mátlo);
  když je kurzor v jeho výšce do 6 px, vyhrává nad vodorovnými čarami.
- SL/TP přidané až během obchodu samostatnou objednávkou (ne bracket ani
  kopírka) se přiřadí k pozici (`lib/journalPositionEpisodes.ts`): stop (SL)
  nebo limit (TP) na opačné straně, stejný účet a kontrakt, vzniklý při
  otevřené pozici a nejvýš na její tehdejší velikost (větší = stop-and-reverse,
  nepřiřadí se; objednávky z doby před vstupem taky ne). Události nesou
  `source: 'standalone'`; do faktů `stopLoss/takeProfit` (riziko, R) se
  počítají jen, když vznikly do 2 s od vstupu. Import běží jako Vercel API
  (`api/tradovate/oauth/journal-import.ts`) → projeví se po nasazení.
- Obchod bez SL/TP dostane v grafu výsledkový box (varianta B z
  `mockups/trade-no-sltp.html`): od vstupu po výstup × průměrný vstup →
  průměrný výstup, zeleně/červeně, tečkovaně vstup, štítek „±body · ±USD“
  (uzavřený = hrubý výsledek brokera). V přehrávání končí na poslední
  odkryté svíčce. Zahrnut v autoscale detailu.
- Barvy boxu pozice jsou sdílené: styl nástroje Long/ShortPosition se
  vždy zapisuje i do globálních výchozích stylů (`SHARED_TOOLS`
  v `chartDrawingStyleDefaults.ts`) a globální hodnota má přednost i uvnitř
  backtest session. Box obchodu v detailu i fullscreenu ho čte přes
  `getDrawingStyleDefault`. Styl uložený dřív jen v session se povýší při
  jejím otevření. Globální = localStorage daného prohlížeče (per origin),
  ne cloud. V detailu žádné nastavení barev — edituje se jen v backtestu
  nebo ve fullscreenu. Long a Short sdílí jeden vzhled (úprava jednoho se
  zapíše do obou; dřív uložený jen jeden převezme i druhý).
- Detail (`centeredTradeView` v CandleKitTradeChart): každý návrat na graf
  (`revealKey` → `focusRequest`) dá obchod doprostřed s okraji podle délky
  obchodu; cenová osa zahrne SL/TP a plnění v záběru (`autoscaleLevels` →
  `autoscaleInfo` journal primitivu); okraj = max(15 barů, ½ délky obchodu).
  Přehrávání v detailu neskáče doprava jako backtest: graf stojí, budoucí
  svíčky zakryje clona zprava doleva (`.trade-chart-rewind`, 0,5 s), pak se
  přehrávají na místě. Cenová osa se na startu zamkne na rozsah celého
  obchodu; pohled se posune (animace 260 ms) jen když kurzor dojede
  k pravému okraji. „Celý obchod“ v Go To vrátí autoscale přes focus.
- Odskok grafu v detailu (otevření, „Celý obchod“, start přehrávání) měl tři
  příčiny, změřené po snímcích: (1) nový ChartView ukázal výchozí záběr
  u konce dat a ten spustil rozšíření okna → druhé vytvoření grafu;
  (2) efekt nastavení znovu aplikoval `rightOffset` na nový graf a odhodil
  vycentrovaný záběr na konec; (3) výměna dat při startu přehrávání drží
  odsazení od posledního baru. Opravy: detail dostává celou sérii a jeden
  stálý klíč ChartView (bez nového grafu při přehrávání), ChartView během
  přehrávání drží poslední plná data, `rightOffset` se znovu nenastavuje,
  když ho graf už má, nový graf je skrytý do usazení záběru (prolnutí
  140 ms) a záběr po výměně dat se drží přes `scrollToPosition`.
- Rollover: kopírkou zapsané obchody nemají `symbol` → graf bral `MNQ.v.0`,
  což u mikra 15. 9. byl ještě U6 (~29 060), ale obchod byl na Z6 (~29 360);
  box, šipky i čáry ležely ~300 b. nad grafem („nevidím obchody“).
  `loadTradeMarketCandles` (detail i fullscreen) ověří cenu prvního plnění
  proti svíčce; když je dál než 10 b., zkusí aktuální a příští čtvrtletní
  kontrakt (`quarterlyContractsAround`) a vezme ten, kde cena sedí.
- Pozor: plná sada testů pod zátěží (load 15–20) trvala 18 min a 8 souborů
  nedoběhlo na timeoutu workeru; v obchodní době ji nespouštět vedle copier
  agenta, stačí cílené soubory.
- Známé: graf v tmavém motivu zůstane bílý, pokud se poprvé otevřel ve
  světlém a motiv se přepnul bez reloadu — `loadChartSettings` cachuje
  nastavení per panel bez ohledu na `isDark` (starší chování, i fullscreen).
- Testy: celá sada zelená v izolaci; pod zátěží (dev server + prohlížeč)
  občas timeout v `liveCopyCompactRender`, `chartReplayPaint`,
  `tradovateBrokerSessionSuspect`, `tradovateBrokerRenewal` — samostatně projdou.

### 2026-09-24 — Historie: snímek vložený ⌘V z karty i detailu (Claude)

Obchod mimo kopírku (ruční, jen na jednom účtu) nemá snímek — kopírka ho
pořizuje jen pro obchody leadera — a karta v Historii byla prázdná bez
vysvětlení. Nově `components/HistoryScreenshotSlot.tsx`: šrafa + pilulka
„Bez screenshotu“ + „Vložit ⌘V · nahrát“; stejná plocha (větší) v detailu.

- ⌘V na kartě jen pro kartu pod myší; ne při otevřeném detailu, v editoru,
  v poli s textem ani v hromadném výběru. Detail má vlastní ⌘V, vypnuté při
  otevřeném editačním formuláři (ten má svoje).
- Sloučená karta uloží snímek ke všem účtům (`shotTargetIds`); chybí-li
  některý řádek, neuloží se nic.
- Uložení jde přes `handleUpdateTrades` (teď vrací `Promise<boolean>`), NE
  přes `handleUpdateTrade`, který nastaví `needsReview: false` — vložený
  obrázek není reflexe.
- Po uložení se zahodí předem načtený detail (`preparedJournalDetailRef` a
  spol.) — najetí na kartu ho načetlo ještě bez snímku a detail pak snímek
  ukázal až po expiraci cache. Detail navíc drží právě vložený snímek lokálně.
- Otevřené: ranní obchod 23. 9. (6 účtů) má snímky kopírky jen u 5 účtů;
  u hlavního `journal_trade_snapshots` řádek chybí a sloučená karta bere
  média z hlavního. Proč kopírka odkaz nezapsala, nezjištěno.

### 2026-09-23 — Sdílení karty dne: neviditelná bublina a odkaz na localhost (Claude)

**Po kliknutí byla vidět jen fajfka.** Odkaz vznikl, ale bublina „Sdílet /
Kopírovat“ sedí uvnitř `.live-day-tools`, který má kvůli animaci vysunutí
`overflow: hidden` — ořízl ji celou. `.live-day-tools:has(.live-day-sharepop)`
teď obal drží rozevřený a ořez pouští. Test hlídá pravidlo v CSS.

**Obecné „Odkaz se nepodařilo vytvořit“.** Dev server na :3000 mezitím
spadl, a `html-to-image` při nenačteném obrázku hází holý `Event`, ne
`Error`. Selhání náhledu má teď vlastní hlášku.

**Odkaz z dev serveru mířil na `http://localhost:3000/day/…`.** Snapshot
přitom leží v produkční DB. `liveDayShareOrigin` z neveřejné adresy
(localhost, LAN, `.local`) skládá odkaz na `publicAppOrigin()`; veřejná
adresa i preview deploy zůstávají, kde uživatel je.

**Ranní obchod chyběl v Historii.** Short MNQ 09:35–10:07 (23. 9.) zůstal
v `tradovate_journal_positions` jako `pending/incomplete` s issue
`conflicting-position-anchors`. SL výstup se rozpadl na 1 + 1 + 11 lotů,
poslední dva fills ve stejné milisekundě, a broker k nim poslal stavy −11 a
0 se stejným `timestamp`. `buildJournalPositionEpisodes` bral jakékoli dva
různé stavy v jedné ms jako rozpor a shodil už uzavřenou pozici. Nově je to
v pořádku jen tehdy, když všechny stavy leží na cestě fills (před/mezi/po)
a konečný stav mezi nimi je; cokoli jiného dál přeruší (fail-closed, dva
testy na to). Replay produkční evidence 06:30–08:45: starý kód 5×
`incomplete`, nový 5× `closed` +170 net (183 hrubě − 13 poplatky), druhý
obchod beze změny. Běží ve Vercel `api/tradovate/oauth/journal-import.ts`,
nasazení = push; jestli se stará pending pozice po deployi sama přepočítá,
je třeba ověřit.

**Deník:** Codexova kopie tohoto souboru (necommitnutá, 23. 9.) vznikla nad
starší verzí a vypustila pět záznamů Claude z 21.–22. 9. Vrátil jsem je
zpátky; diff souboru proti HEAD je teď čistě přírůstkový. Nic z toho zatím
není pushnuté — uživatel chce pokračovat v úpravách.

### 2026-09-23 — Ruční Flatten followera pouze pro aktuální obchod (Codex)

- Přidán samostatný command `flatten-follower-trade`: za zapnutého LIVE
  copieru smí zavřít pouze followera s autoritativně potvrzenou copier
  lineage, zruší jeho copier-owned čekající entry/SL/TP a používá existující
  durable cancel/liquidation cestu. Ostatní účty i ARM pokračují; běžný
  nouzový `flatten-account` zůstává oddělený a dál DISARMuje.
- Účet dostane durable `manual/trade` exclusion ještě před broker side
  effectem. Po úspěšném flat nedostává další scale-in, protection ani leader
  exit, takže nemůže reverse-open. Ruční close je vždy `close-copy` bez ohledu
  na nastavení automatického denního cutu; neověřená cizí pozice/order se
  nikdy account-wide nezavírá naslepo.
- Automatický návrat je možný až po dvojím úplném read-only snapshotu všech
  účtů: všechny pozice flat, žádný aktivní order, žádný stuck/unknown outbox,
  stejné safety generation a žádná čekající position/order/fill událost.
  Mezilehlý flat při okamžitém reverzu proto účet neuvolní; nejpozději jej
  uvolní další heartbeat po skutečně čisté hranici. Session risk cuty se tím
  nemění.
- UI followera tlumeně označí oranžovým `ČEKÁ NA DALŠÍ OBCHOD`, vysvětlí
  automatický návrat a odečte jej z `N/M zařazených`. Risk panel rozlišuje
  ruční trade cut (oranžový) od denního session cutu (červený); notifikace už
  u ručního zavření nevymýšlejí ztrátový limit. Relay, lokální agent i dlouhý
  risk-reducing timeout znají nový command a jeho stabilní operation ID.
- Ověření: typecheck čistý; 429 souborů / 3939 testů prošlo; produkční build
  prošel; scoped ESLint změněných souborů 0 chyb (3 starší warningy v
  `copierRuntimeController.ts`). Globální lint dál selhává na 62 starších
  chybách v archivních `docs/reviews/*/evidence` souborech mimo změnu.
  Kanonický localhost běží na `127.0.0.1:3001`; bez přihlášení šla vizuálně
  ověřit pouze login obrazovka bez error overlay; konzole na loginu hlásí
  starší neblokující selhání načtení kurzů měn. Konkrétní LIVE řádky kryjí
  render regrese.
  Release commit `7382d2e` byl pushnut na `origin/main`; produkční Vercel
  deployment `dpl_CoHYCnb6YDcGbUCeVCSUZkDoNvQ3` je READY a veřejný alias
  obsahuje nový command i stavový label. Nepřihlášený pilot-lease POST vrací
  401. Worker byl po čistém preflightu reinstalovaný ze stejného stromu;
  čerstvý i instalovaný bundle mají SHA-256
  `96233fabe166a779336560699dd0521d818765c1a13bbe67cfdaa84108f874da`.
  První pokus s novým storage klíčem načetl fallback group ID, což odhalila
  okamžitá post-install kontrola; worker byl hned vrácen na původní durable
  klíč přes `--adopt-durable-group`. Finální stav znovu potvrzuje skupinu
  `Hlavní` (`local-1789500528863`), DISARMED/shadow, connected, flat,
  no-active, bez divergence/stuck outbox a `lastError=null`. Žádný ARM,
  Flatten ani broker write nebyl proveden.

### 2026-09-22 — Sdílí se jen odkaz + rozbitý build z dělení po hunkách (Claude)

**Odkaz se lepil s průvodním textem.** Uživateli vyšlo
`…/day/<token>%20Karta%20dne%202026-09-21%20·%20AlphaTrade` — cíl sdílení
slepil `url` a `text` do jednoho řetězce, chat to zlinkoval celé a token
přestal být platné UUID. Stránka „Odkaz je poškozený“ tedy hlásila pravdu;
chyba byla o krok dřív. `navigator.share` i nativní plugin teď dostávají
POUZE odkaz. Datum a částku nese stránka sama v og: metadatech, takže náhled
ve zprávě o nic nepřijde. Přibyl test na znění volání.

**Fotka ve sdílení funguje.** Ověřeno na produkci: odkaz z 22. 9. nese
`owner_avatar_url` (22 875 znaků) a veřejný endpoint ho vrací. Starší odkazy
ji mít nebudou — snapshot je neměnný.

**Rozbil jsem produkční build.** Commit `f2edd15` dělil `index.css` po hunkách
a řez začal u `.live-day-close` uvnitř mobilní `@media (max-width: 480px)`.
Spolkl její uzavírací závorku, blok ovládání skončil uvnitř media query a
soubor přestal být platné CSS — Vercel padl na „Missing closing }“.

**Poučení pro dělení commitů:** typecheck ani testy CSS neparsují a
`npm run build` jsem pouštěl nad pracovním stromem, kde je soubor celý, ne nad
tím, co šlo do commitu. Kontrola podmnožiny v izolovaném worktree musí
zahrnovat i `npm run build`, jinak se dá poslat soubor, který nikdy nikdo
nesestavil. Produkce mezitím běžela na předchozím dobrém nasazení, takže
uživateli appka nespadla.

### 2026-09-22 — Karta dne: ovládání až po najetí a fotka ve sdílení (Claude)

**Jméno vpravo, ovládání po najetí.** V klidu je v hlavičce karty jen jméno
a datum; sdílení i křížek se odhalí až po najetí na kartu. Vybráno z
`mockups/day-card-stamp.html` (varianta A): nástroje si rozevřou místo mřížkou
`0fr → 1fr`, takže se jméno plynule odsune a šířka se nikde nepíše natvrdo —
přibude-li třetí ikona, animace to unese. Na dotykovém zařízení (`hover: none`)
je ovládání vidět rovnou.

**Bublina sdílení byla schovaná za tělem karty.** Hlavička i tělo měly stejné
`z-index: 2`; hlavička si tím udělá vlastní kontext stohování, bublina z něj
neuteče a tělo ji jako pozdější sourozenec překreslí. Napoprvé jsem to opravil
špatně — pravidlo se neuplatnilo, protože obecný selektor nad ním má kvůli
dvěma `:not()` specificitu (0,3,0). Přibyl test na přesné znění selektoru.

**Fotka na sdílené stránce.** Avatar je v profilu uložený jako vložený `data:`
obrázek, ale `publicLiveDayAvatar` pouštěl dál jen HTTPS odkazy, takže na
veřejné stránce zůstaly vždycky iniciály — přestože v appce i v obrázkovém
náhledu se fotka vykreslila. Vložený obrázek teď projde, ale jen
`image/png|jpeg|webp` s platnou base64 (délka na násobek čtyř, kontrolovaná
abeceda) a do 64 000 znaků; syrová fotka z telefonu má megabajty a zdražila by
každou veřejnou odpověď, takže se zahodí a zůstanou iniciály. Tělo se
kontroluje po částech, ne jedním velkým regexem — na dvaceti kilobajtech by se
hvězdička s alternativou mohla zvrhnout v backtracking.

Migrace `20260922090000_live_day_share_inline_avatar.sql` zvedá strop sloupce
z 2 000 na 64 000 znaků. **Na produkci je už nasazená** (přes `db query
--linked`, ověřeno čtením `pg_get_constraintdef`).

Datum v textu sdílení je česky (`21. 09. 2026`) místo ISO — sjednoceno s tím,
co stojí na kartě, přes `liveDayDateLabel`.

### 2026-09-21 — „invalid share token“ u sdílené karty (Claude)

Uživatel hlásil, že po otevření odkazu dostane `invalid share token`, a ptal
se, jestli se mu odkazy nemíchají. Nemíchají — každý nese vlastní snapshot.
Ověřeno na produkci: všech pět dnešních odkazů má platný token a vrací 200
na HTML, JSON i náhledový obrázek; v úložišti nejsou žádné osiřelé náhledy,
takže žádné vytvoření neselhalo v půlce.

Příčinu našlo až zkoušení tvarů adresy:

    /day/<token>    → 200
    /day/<token>.   → 400 {"error":"invalid-share-token"}
    /day/<token>/   → 404 (obecná stránka Vercelu)

Ke zkopírovanému odkazu se ve zprávě přilepí tečka nebo závorka a token
přestane být platné UUID. To samo o sobě je správné chování; špatné bylo, co
u toho appka ukázala — **holý JSON, který vidí i příjemce odkazu**.

Endpoint teď rozlišuje, kdo se ptá: stroj (og crawler, appka přes `?format=json`
nebo `Accept: application/json`) dostane dál JSON, člověk čitelnou stránku
„Odkaz je poškozený“ s radou zkopírovat adresu znovu. Totéž pro neexistující
nebo zneplatněný odkaz místo `{"error":"share-not-found"}`. Přibyl rewrite pro
`/day/:token/`, aby koncové lomítko nekončilo na obecné 404 Vercelu.

### 2026-09-21 — Na kartě dne svítil cizí demo účet (Claude)

Uživatel na sdílené kartě našel účet `PTLOP1748077962`, který nezná. Dohledáno
v produkční DB: `environment = demo`, profil bez propky, typu i plánu — je to
demo účet, který chodí s Tradovate přihlášením. „Tradovate“ u něj nebyl název
firmy, ale náhrada, když se žádná neodvodí.

Příčina byla v mém původním rozhodnutí: `buildLiveDaySummary` sčítal
`snapshot.accounts`, tedy VŠECHNO, co OAuth připojení vidí. Zdůvodnil jsem to
tehdy „úplným obrazem dne“, jenže snapshot nese i demo účty — a ty pak šly ven
i ve veřejném odkazu.

Karta teď počítá jen účty z kopírovacích skupin (`knownAccountIds`: leadeři
i followeři napříč všemi skupinami včetně těch s `mode: off`, plus runtime
skupina). Demo se tím odfiltruje samo. Přímo podle prostředí to nejde —
`LiveAccount` si `environment` nenese — a členství ve skupině je stejně
přesnější odpověď na otázku, které účty uživatel provozuje.

Důsledek, který nejde vzít zpět: **odkazy vytvořené dřív ten demo účet
obsahují**, protože snapshot je neměnný. Zneplatnit odkaz zatím z appky nejde
(schéma i endpoint `revoked_at` mají, UI ne) — tohle je konkrétní důvod to
dodělat.

### 2026-09-21 — Vizuální doladění karty dne a sdílení (Claude)

Codex postavil sdílení karty dne (veřejný odkaz `/day/<token>`, redigovaný
snapshot, privátní bucket s náhledem, RLS jen na vlastníka). Prošel jsem
bezpečnostní část a sedí: jména účtů se redigují na klientu PŘED odesláním,
takže server neredigovanou verzi nikdy nevidí; cesta k náhledu je vynucená
databázovým CHECK na `owner_id/token.png`; veřejný endpoint jede přes
service_role, ale vrací jen normalizovanou projekci a respektuje `revoked_at`.
Tenhle commit veze POUZE kartu dne a sdílení — zbytek Codexovy rozpracované
práce (copier runtime, Historie, TradeDetail) zůstává necommitnutý v pracovním
stromu Documents.

Vizuální změny:
- **Lišta sdílení zmizela zpod karty.** Byla to samostatná plovoucí lišta, která
  rozbíjela kompozici, kterou má karta držet i ve chvíli, kdy ji posíláš dál.
  Sdílení je teď tichá ikona v hlavičce karty vedle data (tam, kde ho měl
  původní mockup) a stavy se dějí v bublině pod ní, takže se karta neposouvá.
- **Karta na veřejné stránce byla úzká z jiného důvodu, než to vypadalo.** Nešlo
  o `max-width`: `LiveDayCard` je flex položka bez vlastní šířky, takže se
  smrskla na obsah (~490 px). V dialogu ji roztahoval obal `w-full`, na veřejné
  stránce chyběl. Strop je 1060 px.
- **Graf svíček jede i ve světlém režimu.** Měl natvrdo černou výplň, proto byl
  ve světlém vypnutý. `AnimatedTradingBackground` má teď `variant`: světlá deska
  a tmavší svíčky. Překryvná vrstva nad plátnem dělá v tmavém vinětaci, ale ve
  světlém dusila svíčky do mlhy, takže tam jen naznačí rohy.
- **Karta na veřejné stránce je sklo** (`translucent`), aby svíčky prosvítaly:
  deska 26 % (tmavá) / 22 % (světlá), dlaždice s čísly krytější, ať zůstanou
  čitelné. V appce se to NEpoužívá — pod dialogem je tabulka účtů, ne graf.
  Na export do PNG to nemá vliv, ten se renderuje nad statickým přechodem.
- **Oprava v exportu:** `html-to-image` kreslí i posuvník a do tmavého snímku se
  zapékal bílý pruh přes celou výšku seznamu. V exportním režimu je posuvník
  schovaný; ořez hlásí patička „+ N účtů“.

Codexův test hlídal, že graf jede jen v tmavém — to byl právě požadavek ke
změně, takže test popisuje nový záměr a přibyl druhý na chybějící `w-full`.

Náhledy bez Supabase: `mockups/shared-day-live.html` (veřejná stránka) a
`mockups/shared-day-glass.html` (čtyři míry průhlednosti nad běžícím grafem).

Ověřeno: typecheck, lint a 3912 testů čisté.

### 2026-09-21 — Protected-target race už neukončuje zdravé otevřené kopie (Codex)

- Incident 13→14→15→18 kontraktů na šesti followerech ukázal, že starší
  globální fail-closed větev nerozlišovala selhání samotného TP modify od
  ztráty ochrany: při potvrzeném pracovním SL i TP poslala followerům market
  close. Přidán durable režim `safety.managementOnly` („Jen správa pozic“),
  který v této úzce prokázané situaci zablokuje nové vstupy, ale ponechá
  aktivní správu existujících kopií, exity, SL/TP a ruční Flatten.
- Přechod je dovolen jen po autoritativním důkazu pro každou zasaženou větev
  a současně pro každého dalšího followera s otevřenou kopií ve skupině:
  přesný neúspěšný target modify v outboxu, přesná durable OSO role/lineage,
  pracovní target i stop na brokerovi, stejný účet/symbol/protisměr, nulové
  filled množství a množství obou ochran přesně rovné skutečné otevřené pozici.
  Jakákoli neúplnost nebo nepracující stop zachová původní tvrdý fail-closed a
  native auto-liquidate; nejde o obecné změkčení bezpečnostní politiky.
- Běžná „Kontrola pozic“ nesmí management-only shodit, dokud nejsou pozice
  leadera a všech followerů celé skupiny lokálně známé jako flat. Durable blok se
  smaže až po autoritativně čisté flat/no-active reconciliation; nový ARM je do
  té doby odmítnut. Stav je viditelný oranžovým chipem i v jinak tichém LIVE
  dashboardu.
- Regrese přesně simuluje šest followerů a pořadí 13→14→15→18, ověřuje žádný
  market liquidate, blokování nového entry, pokračující kopii plného exitu,
  blokovanou předčasnou reconciliation, tvrdý fallback při chybějícím SL na
  zasaženém i jiném otevřeném followerovi a odemčení teprve po autoritativním
  flat stavu. Ověření: kompletní sada 3911/3911 testů v 429 souborech,
  TypeScript čistý, scoped ESLint 0 chyb (3 starší warningy), produkční build
  čistý a `git diff --check` čistý. Globální ESLint baseline nyní selhává na 62
  starších chybách v archivních `docs/reviews/*/evidence` skriptech mimo tuto
  změnu. Localhost LIVE se po reloadu vykreslil bez
  pádu; zůstávají dřívější nesouvisející warningy Recharts a chyba načtení FX.
  Bez deploye, reinstalace workeru, ARM/Flatten nebo jiného broker write.
- Read-only předinstalační kontrola běžícího Mac workeru potvrdila DEMO,
  `armed=false`, `shadowMode=true`, připojený stream, čerstvou autoritativně
  čistou reconciliation, flat všech účtů, žádné working orders/divergence ani
  stuck outbox a `lastError=null`. Instalační preflight navíc potvrdil přesnou
  shodu CLI leadera a všech šesti followerů s durable skupinou
  (`compareDurableGroupWithCli.matches=true`), takže nebyly potřeba žádné
  `--adopt-durable-group` ani `--replace-durable-group` zásahy. Po výslovném
  souhlasu uživatele byl Mac worker reinstalován; SHA-256 čerstvého kandidáta i
  nainstalovaného bundle je shodně
  `df0c278c312e1569bcdc53eeb4aef5d908cde9a699ca3950767a49489f101ff4`.
  LaunchAgent po restartu běží jako persistentní služba (PID 89312) a status už
  obsahuje nové pole `managementOnly: null`. Následná read-only reconciliation
  znovu autoritativně potvrdila flat stav, žádné working orders, divergence,
  missing accounts ani stuck outbox a `lastError=null`; worker zůstal
  `armed=false`, `shadowMode=true` a připojený. Reinstalace ani ověření
  neposlaly ARM, Flatten, objednávku ani jiný broker write.

### 2026-09-21 — Veřejný odkaz na kartu dne z LIVE (Codex)

Karta dne má pod původním vizuálem samostatnou akci `Připravit odkaz`. Vytvoří
neměnný snapshot s automaticky redigovanými názvy a ID účtů, privátní PNG náhled
1200 × 630 pro sociální sítě a veřejnou adresu `/day/:token`. Po otevření odkazu
se zobrazí stejná interaktivní karta; crawler dostane OG/Twitter metadata a
náhledový obrázek bez zpřístupnění Storage bucketu.

- Snapshoty jsou owner-scoped přes RLS. Veřejné čtení probíhá serverem pouze
  podle náhodného UUID tokenu; klient ani anonymní role nemají přímý přístup k
  tabulce nebo bucketu.
- Vizuál karty zůstal beze změny. Sdílecí ovládání je mimo kartu a export používá
  stabilní režim bez číselné a řádkové animace.
- Lokální ověření: 4 cílené soubory / 27 testů, TypeScript, scoped ESLint bez
  chyb, produkční build a vizuální kontrola v LIVE dashboardu. Viditelná zůstala
  pouze známá localhost chyba načítání měnových kurzů.
- Migrace `20260921101224_live_day_shares.sql` byla aplikovaná pouze do propojeného
  projektu `kopinlpdvjfgmvxydohk`: RLS zapnuté, anon bez SELECT, čtyři owner
  politiky, dvě Storage politiky a privátní bucket. Kvůli starému rozdílu historie
  se nepoužil hromadný `db push`.
- Izolovaný produkční deploy `dpl_6vZkXpq4urNT39NGW9EYBr3RVX98` je READY na
  `alphatrade-mentor-15.vercel.app`. Dnešní veřejný snapshot má token
  `ef8b82a8-1d57-43f3-9f65-9ad2754914e2`; HTML, redigovaný JSON i PNG vracejí
  200 a rozkliknutá karta byla vizuálně ověřená. Bez broker zásahu.
- Následná úprava pozadí vytáhla přihlašovací canvas se svíčkami do společné
  komponenty: tmavý i OLED veřejný odkaz používají přesně stejnou animaci jako
  login, světlý odkaz zůstává na čistém `slate-200` bez canvasu. Obě větve byly
  vizuálně ověřené; login se nezměnil. Cílených 8 testů, TypeScript a produkční
  build prošly. Izolovaný produkční deploy `dpl_Djv2M82iqCteZNm2c4BEYRUPe1Ju`
  je READY na stejné doméně a původní veřejný odkaz, JSON i PNG znovu vracejí
  200. Error log obsahuje jen existující Node `url.parse()` deprecation warning.

### 2026-09-20 — Historie: šipky mezi obchody bez loadingu screenshotu (Codex)

Navigace v otevřeném detailu připravuje journal obchody jako jeden celek:
owner-ověřené řádky, privátní podepsané snapshot URL i dekódované pixely. Klik
na šipku nechá současný kompletní obchod na obrazovce, dokud není cíl připravený,
a potom atomicky přepne P&L, fakta i screenshot. Starý `fullTrade` zároveň nesmí
ani na jeden render vystupovat pod identitou nového obchodu.

- Odhalená runtime příčina zbylého spinneru byla nenápadná: přímé
  `array.map(preloadDecodedImage)` předávalo kromě URL také index jako volitelný
  loader. Dekódování sousedů proto selhalo hláškou `load is not a function`,
  zatímco `Promise.allSettled` chybu záměrně nepropustil do UI. Callback nyní
  posílá přesně jediný argument a regresní test tuto aritu hlídá.
- Připravené podepsané snapshoty se předávají z Historie přímo do modalu;
  modal z nich synchronně složí i owner-ověřený obchod a členy účtů. Už první
  render cíle je kompletní a nikdy znovu nespustí `visibility:hidden`. Navigaci
  blokuje jen první skutečně zobrazený obrázek; další ENTRY/EXIT se dekódují na
  pozadí.
- Měření studeného nového obchodu se 7 účty našlo hlavní brzdu v owner ověření:
  5,7–6,3 s; podpis URL a dekódování byly v tomto běhu pod 1 ms z cache. Každý
  soused předtím opakoval celý fingerprint/facts/snapshot řetězec. Nyní se až
  12 prvních výběrů a posuvné navigační okno ověří jedním konzistentním batch
  readem, rozdělí se do owner-scoped cache a souběžní žadatelé sdílejí stejný
  in-flight požadavek. Finanční kontrola se nevynechává.
- První modal připraví čtyři kroky na obě strany; po pohybu se s výběrem posouvá
  runway osmi obchodů ve směru a dvou zpět. Opakovaná návštěva může 10 minut
  použít již ověřený detail, zatímco kontrola po 25 s běží na pozadí. Cache je
  pouze v paměti a při změně vlastníka se zahodí.
- Rozdíl u 11. 9. je datový: karty jsou `Starší záznam`, mají 1 účet a nepoužívají
  novou přísnou `journal:` rehydrataci; proto jsou instantní z načteného seznamu.
  Novější 14.–18. 9. mají 2–7 owner-ověřovaných účtů a úplnou historii plnění.
- Localhost: frame měření běžného přechodu 115 ms, návrat po více než 25 s 87 ms
  a vzdálený krok 116 ms. Sekvence 15 rychlých kroků zachovala přesné pořadí,
  modal byl vždy viditelný a spinner se neobjevil. Bez nové konzolové chyby.
- Ověření: 426 souborů / 3 898 testů, TypeScript, scoped ESLint 0 chyb a
  produkční Vite/PWA build. Zůstávají jen starší lint warningy, známý localhost
  výpadek kurzů a existující upozornění na velikost chunků. Bez deploye, pushnutí
  nebo broker zásahu.

### 2026-09-20 — Historie: odstraněný dvojitý záblesk a rychlejší první náhled (Codex)

Následná reálná zpětná vazba ukázala, že 160ms crossfade dvou ostrých grafů
působí jako `entry → exit → entry → exit`. Crossfade je proto zrušený: cílový
snímek se nejdřív stáhne/dekóduje a potom proběhne jediný atomický swap. V DOM
je při přepnutí vždy právě jeden aktivní screenshot; žádný návrat na starý.

- App na pozadí připraví jen první čtyři copier miniatury a nejvýše čtyři
  ověřené journal detaily z první obrazovky. Limity záměrně brání návratu
  starého problému „stáhni celou historii“; ruční screenshoty se tímto warmupem
  nestahují.
- Miniatury používají owner-scoped memory cache a chybějící cesty podepíšou
  jedním Storage batch požadavkem. Seznam připojí každou URL hned a každý obrázek
  se od skeletonu odemkne vlastním `onLoad`, takže nečeká na nejpomalejší kus
  pětice. Úvodní 300ms opacity animace copier náhledu byla odstraněna.
- Journal detail se dál nezobrazí bez owner-ověřené konzistentní sady. Text
  „Načítám společný přehled…“ se ale ukáže až po 180 ms, takže cache hit ani
  rychlý prefetch neblikne; při skutečně pomalé síti zůstává stav pravdivý.
- Localhost: po studeném otevření Historie byly podepsané 2730px miniatury při
  dalším 300ms vzorku už připojené, první desítka byla kompletně vykreslená a
  opacity byla 1. Otevření detailu neukázalo načítací text. Entry → Exit i
  Exit → Entry měly okamžitě i po 30 ms přesně jeden kompletní aktivní obrázek.
- Ověření: 426 souborů / 3 893 testů, TypeScript, scoped ESLint 0 chyb,
  `git diff --check` a produkční Vite/PWA build. Zůstávají jen starší lint
  warningy, známý výpadek kurzů na localhostu a existující upozornění na velikost
  chunků. Žádný deploy, push, broker zásah ani změna finančních výpočtů.

### 2026-09-20 — Historie: stabilní detail a plynulé screenshoty (Codex)

První dvě fáze zrychlení historie jsou hotové bez změny grafu, brokeru nebo
finančních výpočtů. Příčina opakovaného „Načítám společný přehled…“ byla
referenční identita `trade`/pole účtů: běžný background refresh vytvořil nové
objekty a otevřený detail považoval stejné ID za jiný výběr.

- Otevřený journal detail je nově svázaný se stabilním klíčem vybraných ID.
  Refresh seznamu se stejným výběrem zachová ověřený detail; aktuální review
  pole se dál propíšou, ale nepřepíšou ověřené exekuce ani média.
- Kompletní owner-ověřený detail má krátkou 30s memory-only cache, oddělenou
  `authStateVersion + userId`, maximálně 32 položek. Změna účtu/session stará
  data nikdy nepoužije; cache se neukládá na disk.
- Privátní screenshoty se místo N samostatných Storage požadavků podepisují
  jedním `createSignedUrls` batch voláním. Úspěšné URL mají 50min memory-only,
  auth-scoped cache; částečné selhání nezahodí ostatní snímky.
- Galerie nejprve stáhne a dekóduje aktivní i sousední snímky. Při šipce starý
  snímek zůstane vidět a s novým se 160 ms překrývá; žádný spinner ani prázdný
  mezisnímek. Staré URL se při přechodu na jiný obchod nesmí zobrazit.
- Browser na localhostu ověřil dva skutečné 2730px auto-screenshoty: během
  přepnutí byly oba `complete` a překryté (opacity 0.988/0.012), po přechodu
  zůstal nový. Nové konzolové chyby nevznikly; zůstává známý nesouvisející
  výpadek kurzů a Recharts varování z dashboardu.
- Ověření: 425 souborů / 3 889 testů, TypeScript, scoped ESLint bez nových chyb,
  `git diff --check` a produkční Vite/PWA build. Žádný deploy, push, migrace,
  ARM/DISARM ani broker akce neproběhly.

### 2026-09-20 — Plynulejší LIVE ON/OFF bez umělého čekání (Codex)

Uživatel upozornil, že přepínač kopírovací skupiny nejdřív zbytečně dlouho
točí spinner a teprve potom přesune kolečko. Příčina byla prezentační: po
autoritativním ARM/DISARM potvrzení UI vždy dorovnávalo animaci nejméně na
650 ms a následný posun trval dalších 340 ms.

- Pevné čekání 650 ms je odstraněné; bezpečnostní preflight, runtime ACK a
  fail-closed chování zůstávají beze změny. ON/OFF se stále nesmí změnit před
  potvrzením workeru.
- Spinner se odhalí až po 140 ms. Rychlý ACK tedy kolečkem neproblikne, pomalý
  broker/relay zůstává pravdivě viditelný jako čekající.
- Posun knoflíku trvá 220 ms, barva koleje 200 ms a popisky 160–200 ms.
  `prefers-reduced-motion` dál vypíná pohyb a nově i rotaci spinneru.
- Ověřeno 12 cílenými testy, TypeScriptem, scoped ESLintem, `git diff --check`,
  produkčním buildem a v prohlížeči na skutečném LIVE přehledu bez error
  overlaye. Ostrý přepínač se při ověření neklikl; žádný ARM/DISARM, broker
  příkaz, push ani deploy neproběhl.

### 2026-09-20 — LIVE na telefonu: hustší řádky, dvě sekce, Flatten nahoru (Claude)

Uživatel: „přijde mi, že jsou ty řádky zbytečně velké.“ Změřeno: jeden účet
zabíral **82 px** (dva bloky pod sebou a u každého účtu znovu popisky
DENNÍ / OTEVŘENÝ / POZICE, které stojí i v souhrnu skupiny nad tím). Při
dvaceti účtech 1 660 px jen na seznam. Vybráno z mockupů
`live-mobile-rows`, `-flatten`, `-columns`, `-header`.

- **Účty ve dvou sekcích** místo jedné tabulky se čtyřmi sloupci. Sekce
  rozlišuje jen popisek pravého sloupce (`Otevřený` u účtů v trhu, `Dnes`
  u ostatních); pruh s názvem sekce nad nimi byl druhý řádek chrome, který
  nic nepřidal, a šel pryč. Důvod: uživatel chtěl adaptivní poslední
  sloupec (otevřený P&L u účtu v pozici, jinak denní). Jedna tabulka by
  pak měla sloupec se dvěma významy a lživou hlavičkou. Dvě sekce to
  obejdou — popisek platí pro všechny řádky pod sebou. Bonus: většinu dne
  v pozici nejsi, takže běžný stav je dvousloupcová tabulka, kde se
  **jméno účtu vejde celé** (122 px místo 101 px; bez otevřených pozic až
  209 px v mockupu). U propek, kde se účty liší až posledními číslicemi,
  je to to hlavní.
- „V trhu“ = otevřená pozice **nebo** čekající vstupní příkaz, protože obojí
  kreslí sloupec Pozice stejně jako na počítači.
- **Pilulky pozice jsou na druhém řádku**, ne ve sloupci. Ve sloupci o 86 px
  zbylo na jméno 70 px a zkracovalo se na „TDF0000…“. Druhý řádek ty účty
  stejně mají kvůli tlačítku Flatten účet, takže to nestojí ani pixel.
- **Flatten All nahoru** vedle vypínače, nápisem (ne ikonou). Je vidět bez
  scrollování i při dvaceti účtech; dole zbyla jen správa skupiny.
- **Hlavička skupiny na jeden řádek**: název · Flatten All · vypínač. Název
  je jediný pružný prvek, takže se zkrátí on a nikdy nevytlačí ovládání.
  Kolečka firem se přesunula do souhrnu jako úzká čtvrtá buňka (Kapitál se
  přitom nesmí ztratit) a v ní jsou bez textu — název nese `title`.
- Varovné štítky (`N/M aktivních`, DLL, BREACHED, leader nedostupný, Shadow)
  mají vlastní řádek, ale jen když nějaké jsou.
- **Zelené „Aktivní“ u každého účtu je pryč** — pilulka způsobilosti se
  ukáže jen tehdy, když něco není v pořádku. `×N` naopak zůstává i u ×1:
  násobek je risk parametr a jeho nepřítomnost by šla splést s „nevím“.
- Souhrn skupiny je na telefonu bez haléřů: „-$225.00“ se do buňky nevešlo
  a ořízlo se na „-$225.0…“, což je horší než zaokrouhlení. U jednotlivých
  účtů haléře zůstávají.
- **Souhrn skupiny je adaptivní**: v obchodu ustoupí Kapitál a zbydou Firmy,
  Denní a Otevřený (127 px na číslo místo 86). Kapitál se v obchodu nehýbe,
  zatímco otevřený P&L ano. Čekající vstup se za obchod nepočítá — dokud
  není fill, není co sledovat a kapitál je užitečnější.
- **Seznam účtů bez pozice se sbalí na prvních 6** s přepínačem „Zobrazit
  dalších N“. Účty v trhu se nesbalují nikdy — kvůli nim se na telefon
  člověk dívá. Sbalením se nic naléhavého neztratí: neaktivní účty hlásí
  štítky v hlavičce skupiny (`N/M aktivních`, DLL, BREACHED) bez ohledu na
  to, jestli je jejich řádek vidět. Pořadí zůstává přirozené (leader první),
  ne podle velikosti čísla — jinak by řádky při každé aktualizaci skákaly.
  Rozbalení animuje výšku mřížkou `0fr → 1fr` (`.live-accounts-more`), ne
  `max-height`: nemusí se hádat horní mez ani měřit v JS, takže se chová
  stejně při šesti i padesáti skrytých účtech. Řádky uvnitř naskakují
  postupně; samotná animace výšky vypadá jako skok. Skryté řádky zůstávají
  v DOMu a sbalený obal má `inert` — nulová výška je schová jen očima
  a tlačítka „Flatten účet“ uvnitř by zůstala dosažitelná tabem.
- Řádek je 36 px, ne méně: pod tím už je z něj špatný dotykový cíl a přitom
  otevírá detail účtu.
- Výsledek: řádek **36 px** místo 82; karta s 20 účty **630 px** sbalená
  (vejde se celá na obrazovku telefonu) a 1 074 px rozbalená. Ověřeno
  v prohlížeči na 375 px ve světlém i tmavém režimu, nula přetečení a žádný
  vodorovný posuv. `copytrade-preview.tsx` rozšířen na 20 účtů ve skupině
  (dva v pozici), aby šlo ladit v zátěži.
- Desktopová tabulka se nemění: `CompactStat` a `marksOnly` jsou jen pro
  kompaktní kartu, `FirmMark` má nový `size` s původní výchozí hodnotou.
- 424 souborů / 3878 testů, typecheck i lint čisté.

**Past, do které jsem spadl:** ověřovací příkaz `npx vitest run 2>&1 | grep …
&& npx eslint` mi ohlásil úspěch i s padlým testem — roura váže silněji než
`&&`, takže exit kód byl z `grep`. Je to přesně to, na co upozorňuje zápis
ze 4. 9. Brána musí jít do souboru (`> log 2>&1 && …`), ne přes rouru.

### 2026-09-20 — Karta dne v LIVE + spouštěč v hlavičce (Claude)

Chyběl denní souhrn napříč účty, který konkurence má. Průzkum: Tradesyncer
má v „Cockpitu“ jen tenký textový proužek pod lištou akcí (`Total Day PnL |
Total Open PnL | Total Balance`, vpravo `Open Positions`) — vždy vidět,
nekliknutelný; hezkou kartu mají až v Journalu (kalendář, denní sloupcový
graf) a v Prop Firm Trackeru. My to spojili: **hodnota je vidět pořád a
zároveň je to vstup do karty**.

- `lib/liveDaySummary.ts` (+10 testů): sečte `liveDailyPnlDisplay` přes
  `snapshot.accounts`, seřadí od nejlepšího, nepotvrzené účty dá nakonec.
- Rozhodnutí: NEpoužívá `liveGroupDailyPnlDisplay`, který vrací null, jakmile
  chybí jediný účet. U dvaceti účtů by karta nikdy nic neukázala. Místo toho
  `confirmed` = součet potvrzených + `partial`/`confirmedCount`, a UI to
  **řekne nahlas** (jantarová tečka u spouštěče, věta „Sečteno z N z M účtů“
  na kartě). Dílčí součet s uvedeným jmenovatelem není odhad. Žádný
  potvrzený účet → `null` a pomlčka, nikdy nula.
- `components/LiveDayCard.tsx` (+11 render testů): karta v jazyce
  přihlašovací stránky (vždy černá, běžící světla po obvodu, sklo blur 28px,
  aurora, náklon ±6° a odlesk podle kurzoru, dopočítávané číslo). Vlevo
  dlaždice s dnešním P&L + Obchodů/Win-Loss, vpravo scrollující soupis účtů
  s počítadlem „+ N účtů“. Obchodů/Win-Loss jde z leader-only
  `dailyStats`; bez běžícího runtime pomlčka, nedopočítává se z účtů.
- Spouštěč = varianta 2 z návrhů (popisek + číslo + šipka) vedle nadpisu
  „Kopírovací skupiny“. Win/Loss z něj vypadl — poměr je hned v kartě.
- Jméno a avatar na kartu tečou z `App.tsx` přes `cardOwner`; karta se posílá
  dál, anonymní být nesmí.
- Sdílení karty jako obrázek zatím ZÁMĚRNĚ není (uživatel odložil). Tlačítko
  raději chybí, než aby nedělalo nic.
- Světlý režim karty (`.light-theme .live-day-*`): není to černá naruby. Na
  bílé nefunguje nic, co svítí. Vybráno z `mockups/day-card-light.html`
  (4 pozadí × 5 variant okrajů × 3 loga):
  - **pozadí = vinětace** místo mřížky. Čtverečkovaná textura byla na bílé
    vidět a rušila; ztmavené okraje navíc dají odlesku co rozsvěcet, nad
    čistě bílou plochou by nebyl vidět vůbec.
  - **okraje = tyrkysová po všech čtyřech.** Tmavá vodorovná stopa vypadala
    na bílé jako dvě různé animace.
  - **logo = stejný soubor, jen dosycený a ztmavený** filtrem
    `saturate(3.2) brightness(.72) contrast(1.15)`, bez jakékoli dlaždice pod
    sebou (varianta D z `mockups/day-card-light-logo.html`). `contrast` tam
    musí být: vnitřek loga je taky světlý a bez něj splyne s vlastním obrysem.
    Cesta sem vedla přes dva zamítnuté pokusy — plná černá (uživatel chce
    logo světlé) a tmavý čip pod logem (vypadal jako záplata).
  `.oled-theme` je tmavé téma, spadá pod výchozí styl. Past, která tam byla:
  zkratka `background` v override shodila `background-clip: text` a z nápisu
  „ALPHA“ byl plný obdélník — nutné `background-image`.
- Čísla na kartě nejsou monospace, ale Inter s `tabular-nums`: SF Mono kreslí
  přeškrtnutou nulu. Tím zároveň padl hack `word-spacing: -0.34em`, kterým se
  stahoval oddělovač tisíců — v monospace zabíral celé pole, v Interu je
  správně široký sám o sobě. POZOR na řezy: `index.html` načítá Inter jen
  v 300/400/500/700/900, takže napsat 600 znamená vykreslit 700. Velké číslo
  je proto 300 (nejlehčí dostupný), zbytek 500.
- Zavírací křížek je uvnitř karty vedle jména, ne přilepený na rohu scrimu;
  naběhne až při najetí na kartu (`opacity`, ne `display`, aby se nic
  neposunulo) a na dotykovém zařízení (`@media (hover: none)`) svítí trvale.
- Ověřeno v `copytrade-preview.html` (rozšířen na 20 účtů) v prohlížeči:
  desktop i 375px, světlé i tmavé téma, Escape zavírá, počítadlo mizí na
  konci seznamu. Dvě chyby nalezené a opravené až tam: oddělovač tisíců
  v monospace zabíral celé pole (`+$2  906`) a název účtu se v úzkém sloupci
  ořízl na jedno písmeno.
- 424 souborů / 3870 testů, typecheck i lint čisté.

### 2026-09-17 — Proč včerejší obchody nemají screenshoty (Claude, jen analýza)

Uživatel: část obchodů z 16. 9. je v historii bez screenshotu. Nález (bez
změny kódu, DB, workeru ani brokera):
- Snímky VZNIKLY: worker nahrál entry+exit ke všem 15 epizodám (SNAPSHOT
  uploaded, `copier_trade_snapshots` 30 řádků, `snapshotHealth` ready).
- Od 14. 9. nevznikají journal obchody klientským `syncCopierJournal`
  (`copier-…`, snímky v `data.copierSnapshots`), ale serverovou projekcí
  evidence (`journal:<id>`, skupina `execution:demo:…`). Snímky k nim
  přiřazuje jen DB pohled `journal_trade_snapshots` (migrace 20260914125323):
  vyžaduje potvrzenou uzavřenou journal pozici, jejíž závěrečný fill ID ==
  `tradovate_copier_trades.trade_id` leadera. Včera propojeny 3/15 (09:19,
  13:30, 15:14:16) — přesně ty, kde existuje potvrzená pozice účtu leadera.
- Kořen: připojení leadera `754e4b5b` (Lucid 64503883 + 4 followeři) má 24
  pozic `pending/incomplete` (19× issue `connection-gap`, 5× `conflicting-
  position-anchors`), další epizody bez pozice vůbec. Mezery pocházejí z
  evidence `connection {state: recording-gap, reason: local-write-failed}`
  — v `server/fileJournalEvidenceStore.ts` je to přetečení fronty zapisovače
  (`maxQueued` 10 000 → `journal-queue-full-history-incomplete`), ne chyba
  disku (33 GB volných). Objem evidence tohoto připojení: až 125 tis. řádků
  za hodinu při otevřené pozici (760 tis. za den, journal.jsonl 515 MB),
  převážně `command`/`commandReport`; append+datasync na každou událost
  nestíhá. Okna mezer 13:39–13:46, 14:09–14:17, 15:14–15:27, 16:13–16:49,
  18:41–18:51, 19:02 přesně odpovídají obchodům bez snímku. Poprvé 15. 9.
  (69 událostí), 14. 9. žádné. FTD připojení `53157614` (2 účty) mezery
  nemá, proto má všech 14 obchodů potvrzených — ale bez snímků, protože
  jeho fill ID není leaderovo.
- Vedlejší nálezy: worker log neobsahuje žádný řádek o přetečení fronty
  (`onError` se do logu nedostane); hlava projekce třetího připojení
  `7cce8c5b` visí 4 484 událostí za evidencí; lokální Documents checkout
  je 22 commitů za origin/main a localhost:3000 tím pádem journal snímky
  neumí zobrazit vůbec (nemá `journalSnapshotHydration`).
- Návrh (nerealizováno, čeká na rozhodnutí): (1) zapisovač evidence —
  dávkový append + jeden datasync na dávku a/nebo filtrovat `command`/
  `commandReport` z lokálního záznamu, (2) logovat přetečení fronty a
  ukazovat `JournalRecorderHealth` v LIVE, (3) pohled snímků: fallback
  přiřazení přes episode + účet leadera i bez potvrzené pozice je
  bezpečnostně sporné — raději opravit zdroj.
- Korekce po Codex review (8:52): jsou to DVĚ chyby. Prázdné karty FTD
  followerů způsobuje výhradně pravidlo pohledu (follower má vlastní fill
  ID); přesná vazba existuje přes `copylink` evidenci: leader fill → leader
  order → copylink → follower order → follower fill, u 10 z 12 epizod
  dohledatelná → zpětné doplnění je bezpečné bez ručního párování.
  Přetečení zapisovače vysvětluje jen to, proč chybí obchody pěti účtů
  Lucid připojení (leader + 4 followeři) v historii vůbec. Otevřená výhrada:
  followeři často vystupují vlastní ochrannou nohou (leader 15:23:57 vs
  followeři 15:27:32), copylink k exitu pak nemusí existovat → řetězit
  raději přes vstupní order. Hlava třetího připojení mezitím dohnala
  evidenci. Hlášení `journal-queue-full-history-incomplete` jde jen do
  `console.warn` přes `logControllerError`; v logu workeru 15.–17. 9. se
  nevyskytuje ani jednou.
- **Oprava hotová 2026-09-17 dopoledne** (větev
  `claude/journal-snapshots-copylink-20260917`, pushnutá na origin): dávkový
  zapisovač evidence s dedupe totožných snapshotů a prioritou, zdraví
  zapisovače ve statusu + LIVE chip, ledger sloupec `leader_entry_order_ids`,
  pohled `journal_trade_snapshots` s follower cestou přes copylink/`groupId`
  (tolerance 2 s na 1ms skew Tradovate razítek), backfill 20/21 epizod.
  Migrace `20260917071500` JE aplikovaná na produkci (historie ukazuje snímky
  u 42/43 obchodů z 16. 9.). Web/server + worker čekají na „nasaď“. Korekce
  ranního nálezu: přetečení SE logovalo (1,3 mil. řádků bez časového razítka),
  spouštěčem je REST resync po WS heartbeat timeoutu. Plný zápis je v
  PROJECT_LOG na té větvi.
- **Druhá oprava na stejné větvi (11:10)**: falešný BREACHED čtyř nových
  Lucid funded účtů LFF…0008–0011. Worker četl `accountRiskStatus.maxNetLiq`
  jako net liq a `minNetLiq` jako floor; jsou to zaznamenané extrémy net
  liq, u neobchodovaného účtu obě = 50 000. Floor je nově
  `min(highWater − trailingMaxDrawdown, trailingMaxDrawdownLimit)`, equity
  = net liq nebo realizovaný cash. BREACHED zruší jen ruční „Ověřit“
  s broker důkazem. Po reinstalu workeru kliknout Ověřit u všech čtyř účtů.
- **Nasazeno (11:15, po „nasaď“)**: fast-forward push 89e880a na main,
  Vercel `dpl_FTYSSodnhxTsE3UuBiUhX26b5UGR` READY s produkčním aliasem.
  Worker NEreinstalován: hlásil connected=false, reconciliationRequired,
  lastError z výpadku 7cce8c5b (10:40Z). Nezávislá GET kontrola 09:15Z:
  všech 12 účtů flat/no-working, DISARMED. Příkaz reinstalu z worktree
  `/private/tmp/alphatrade-journal-snapshots-20260917` (přesný 89e880a)
  předán uživateli (`--connections-manifest` + `--adopt-durable-group`).
- **Odpoledne (Claude, plné zápisy v PROJECT_LOG na větvi
  `claude/journal-snapshots-copylink-20260917`, vše na main)**: Tradovate
  výpadky a `kickstart -k` → 40× crash loop workeru při startu (lease 10 s vs
  17–61 s obnova tokenu) → 7ffaaf2 ohraničený retry přechodných chyb
  (`server/retryTransient.ts`, 120 s/lease, WS sync 20 s), reinstal workeru.
  Copier stále „leader nedostupný“/`command-expired`: PostgREST pool
  vyčerpaný. 6a5379a = indexované stránkování `read_journal_input_snapshot`
  (migrace `20260917153000`) + relay timeouty 20/30 s. 3ecebdc = odstranění
  retry bouře: `journal-input-changed` bylo SQLSTATE 40001, které HTTP
  vrstva opakuje donekonečna se zastaralou generací (~1 400 volání/s);
  migrace `20260917154500` → errcode 55000. Rollbacky ~1 100/s → 0, API
  ~70 ms, heartbeat 0,3 s, ARM od 15:29Z drží. Migrace aplikovány
  `db query -f` + `migration repair`, soubory zkopírovány sem.
- **18:10 (Claude, analýza)**: 15:43:43Z Tradovate zavřel WS všech tří
  loginů uprostřed obchodu (short 7 MNQ, 11 followerů); reconnecty prošly
  authorize+sync a server mlčel (stejný vzor 05:35Z, 08:52Z, 13:40Z,
  14:03Z), samo se vrátilo za 11 min. Copier správně DISARM. Flatten All
  15:57Z zavřel 5/12 — Tradeify/FundedNext selhaly na 5s REST timeout čtení
  pozic; followeři uzavřeni ručně v Tradovate do 16:04:18Z (ověřeno journal
  evidencí, všech 12 flat). Návrh: delší deadline + opakování nouzového
  flattenu (čeká na rozhodnutí). Plný zápis na větvi.
- **19:15 (Claude, 2db341c na main, web nasazen)**: oprava celého řetězce —
  REST brokeru 15s deadline (kořen zamrzlých risk snímků a pomalé recovery),
  nouzový Flatten s opakováním čtení, opakovanými průchody a stavově
  ověřeným resendem liquidate (deadline 180 s), relay přichytí druhý
  Flatten k běžícímu, lease importu journalu (migrace `20260917190000`
  aplikována, soubor zkopírován sem), recorder se vrací do `recording`,
  plánovaná WS obměna už netvoří mezeru, WS/live-pnl diagnostika.
  Testy 3706/3707 → zelené, tsc/eslint/build čisté. Worker čeká na
  reinstall: nejdřív v LIVE vyřešit stuck operace (4× rejected Lucid, prop
  limit 25 MNQ) + Kontrola pozic, pak `scripts/copier/mac-reinstall-safe.sh`.
- **21:00 (Claude, na main)**: brokerem odmítnutý vstup followera (limit
  pozice) už nevypne skupinu — follower se vyřadí z epizody (potlačení
  vstupu 0, exity se přeskočí, položky vysvětlené), ostatní followeři se
  řídí dál. Synchronní varianta (reject přímo v dávce → fail-closed +
  auto-close) záměrně beze změny, čeká na rozhodnutí. Plný zápis na větvi.
  **Worker reinstalován 19:12Z** (aa0c83f, bundle 3ae56cef…), po startu
  sám potvrdil flat, DISARMED, streamy i journal v pořádku.
- **21:45 (Claude, na main)**: synchronní varianta sjednocena (jen verdikt
  brokera; interní maxContracts blok dál kritický), izolace svázaná
  s epochou leadera a konkrétními položkami, relay Flatten rozlišuje
  `groupId`, REST/sync limity 45 s (19:30Z Tradovate >15 s z Macu i AWS).
  **18. 9. 04:04Z**: worker reinstalován z 40737f8 (bundle 2fb31a43…),
  reconcile čistý, DISARMED, flat, vše připojeno.
- **18. 9. 06:40 (Claude)**: Mac companion panel dostává skutečnou expozici:
  worker posílá v heartbeatu `controller.exposure` (čas broker kontroly,
  pozice, per-follower shoda), server ho překládá do stávajícího DTO
  (`verifiedAt`, `positions` leadera, `followerAck`, working orders).
  Swift beze změny. Worker reinstalován 05:58Z (2461613, po DISARM
  uživatele; brána předtím správně zastavila živý ARM). Plný zápis na větvi.
- **18. 9. 08:30 (Claude)**: LIVE po návratu z pozadí ukazuje poslední známé
  pozice se stářím místo „Pozice neověřena" (štítek jen nad 2 min nebo při
  nedostupném čtení), live hook čte hned při návratu do popředí, backoff po
  `429` podle `p-time`/`Retry-After` (fallback 5 min místo hodiny). Jen
  web/server, worker beze změny.
- **18. 9. 10:15 (Claude)**: LIVE bere pozice a aktivní příkazy účtů kopírky
  přednostně z heartbeatu workeru (`controller.exposure` + nové `orders`
  z cache stream událostí), REST přes Vercel jen jako záloha při heartbeatu
  starším 8 s nebo odpojeném streamu. Worker reinstalován 10:55Z (acd6741).
- **18. 9. 12:40 (Claude)**: banner „Data deníku čekají na obnovení" — RPC
  `get_dashboard_data` 12,7 MB / 7,8 s (3 720 obchodů; 3,9 MB analytická pole
  obchodů + 3,7 MB avatar profilu jako base64). Nové `get_dashboard_data_light_v1`
  (5,1 MB / 1,7 s; bez analytických polí, avatar nad 256 kB odložený) a
  `get_trade_analytics_v1` pro Lab/AI kouče (dotažení jednou za session,
  sloučení na čtení); fallback 500 řádků/stránka, limity 45 s / 90 s, banner
  ukazuje důvod selhání; nahrání avataru zmenšuje na 256 px. Migrace
  `20260918120000` nasazena `db query -f` + repair. Commit cbbdc17, detail
  ve worktree logu. Stávající avatar v DB zůstal 3,7 MB — stačí ho znovu
  nahrát v profilu.
- **18. 9. 15:40 (Claude)**: odebrání nedostupného followera z řádku LIVE
  nikdy neprošlo — plán odebíral jen kliknutý účet, další nedostupné FNFTCH
  účty (breach 14:17Z) ve skupině zůstaly a validace uložení selhala; worker
  žádný příkaz nedostal. Plán teď odebírá všechny nedostupné followery. Worker
  drží `reconciliationRequired` (65839434: -25 MNQ vs leader 0 ve 14:16Z) →
  před změnou skupiny je nutná Kontrola pozic. Detail ve worktree logu.
- **18. 9. 16:50 (Claude)**: od 15:41Z Tradovate neobsluhuje sessions Tradeify a
  FundedNext (sync timeout, REST 45 s, na Vercelu 408), Lucid běží; zapnutí
  proto worker odmítá. Opraveno (čeká na reinstall): broker router nepočítá
  spojení bez účtů skupiny do `connected` (FundedNext bez účtů by blokovalo
  kopírku i po návratu ostatních) a start workera přežije spojení s nečitelným
  adresářem účtů (startuje bez účtů, nic se na něj nesměruje). Otevřené
  rozhodnutí: izolace followerů na mrtvém follower-only spojení místo
  odzbrojení skupiny. Detail ve worktree logu.
- **18. 9. 17:50 (Claude)**: příčina dnešního výpadku dohledána z Vercel logu
  `pilot-lease`: tokeny Tradeify/FundedNext obnovené 15:31Z dostaly na straně
  Tradovate mrtvou session (sync timeout, REST 408) od vypršení starých tokenů
  15:41Z až do další obnovy 16:41Z; ožilo hned s třetím tokenem. Oprava: broker
  hlásí sync timeouty v řadě, worker po dvou vynutí obnovu tokenu přes
  pilot-lease (cooldown 5 min, server neobnoví token mladší 3 min). Server část
  nasazena, worker čeká na reinstall. Detail ve worktree logu.
- **18. 9. 19:52 (Claude)**: worker reinstalován z 3408088 na „nasaď" (všechny
  tři dnešní fixy + diagnostika close kódů), FundedNext 7cce8c5b odebráno z
  manifestu (záloha `.bak-20260918T175002Z`). Start 17:50:15Z se dvěma
  připojeními, autorizace ~140 ms, reconcile čistý, DISARMED.
- **18. 9. 20:50 (Claude)**: mrtvé sessions se opakovaly i po reinstallu (Lucid
  18:08Z close 1005, Tradeify REST visí od ≤18:12Z, close 1006 při obměně
  18:40Z); vynucená obnova tokenu je vyřešila za 1,5 min. Nejlepší hypotéza:
  překročení REST limitu Tradovate (~80/min, 5000/h) hlavně kvůli live-pnl
  pollování z webu (~90 volání/min na token při otevřeném LIVE) + journal
  import + cron; Tradovate místo 429 zavírá sockety a stalluje session (p-time
  ~1 h). Návrh: web bez REST pollování pozic při čerstvém heartbeatu, vlastní
  token pro worker, odpojit FundedNext v aplikaci. Detail ve worktree logu.
- **18. 9. 21:20 (Claude)**: penalizace potvrzena chováním — po obnově tokenu
  18:52Z Tradovate odpověděl na syncrequest p-ticketem a broker potichu čekal
  p-time (REST zůstatků přitom fungoval). Nasazeno na web: intervaly live-pnl
  3/6/15 s, sdílení ticků na serveru 2,5 s / zůstatků 5 s; broker loguje WS
  PENALTY a hlásí ji jako chybu (čeká na reinstall). Detail ve worktree logu.
- **18. 9. 21:45 (Claude)**: LIVE „Diagnostika dat a API" nově ukazuje na každý
  Tradovate login skutečná volání (web přes server + worker REST/WS) proti
  limitu 80/min a 5 000/h se semaforem a stav session workeru (penalizace s
  odpočtem, poslední close kód a kdo zavřel, fáze, sync timeouty). Web live,
  worker část po reinstallu. Penalizace Tradeify trvala ~32 min (18:52–19:25Z).
- **18. 9. 21:50 (Claude)**: worker reinstalován z 0df6c6b (bundle d393c9a2…) —
  diagnostika penalizace a `connectionUsage` pro panel v LIVE. DISARMED,
  reconcile po startu.
- **18. 9. 22:15 (Claude, po review Codexu)**: oficiální limity Tradovate:
  5 000/h na uživatele (429; dnes nikdy nepřišlo → nepřekročeno), endpointové
  limity na IP /24 (syncrequest 300/h, accesstokenrequest 5/h → p-ticket);
  žádný limit 80/min. p-ticket workeru tedy nemohl způsobit Vercel; do IP
  budgetu se počítá i platforma Tradovate a iPhone na téže síti. Nový token
  rate-limit prostor nevytváří. Panel a počítadlo opraveny, broker počítá
  syncrequest zvlášť (po reinstallu). Otevřené: ověřit účet 65839434 v historii
  FundedNext. Detail ve worktree logu.
- **18. 9. 22:30 (Claude)**: kompletní předání session pro Codex v
  `docs/HANDOVER_2026-09-18_claude.md` (incidenty, commity, chybné závěry,
  otevřené body).
- **18. 9. 22:20 (Claude)**: čtvrtý pád Tradeify session 20:07Z (5 min, obnova
  tokenu pomohla). Korelace z Vercel logů: každý pád přišel 0–5 min po dávce
  full preflightů (načtení LIVE = 17–30 Tradovate volání na login během
  sekundy × 3 připojení), zatímco socket-error ve 12:38Z bez LIVE se zotavil
  hned. Server teď sdílí preflight na (uživatel, připojení, režim) 20 s.
  Zítra: LIVE otevřít jednou bez reloadů a sledovat panel. Detail ve worktree.
- **19. 9. 08:40 (Claude)**: ráno 05:01:48Z oba sockety zavřeny naráz (Tradovate
  strana, víkendová údržba), worker se obnovil sám za 1,5 min. Odpojené
  připojení jde nově skrýt z přehledu (migrace `20260919063000`, sloupec
  `archived_at`, POST status s `archived`); nic se nemaže, FundedNext odpojen
  uživatelem 08:17. Detail ve worktree logu.

### 2026-09-16 — AlphaTrade 1.0 (10) nainstalována do iPhonu (Codex)

- Po uživatelově opětovném připojení kabelu dokončena dříve schválená instalace již sestaveného a ověřeného App.app; bez dalšího buildu. devicectl potvrdil instalaci app.alphatrade.native a následné spuštění. Samostatné info apps na fyzickém zařízení potvrdilo verzi 1.0, Bundle Version 10.
- Verze obsahuje opravu pádu LIVE na nullable propFirm i schválené zachování posledního ON/OFF stavu. Instalace a start jsou ověřeny; konkrétní otevření LIVE dashboardu na fyzické obrazovce zatím neověřeno. Žádný ARM, broker příkaz, worker restart ani web deploy.
- Doklady: /tmp/alphatrade-ios-build10-install-retry.json, /tmp/alphatrade-ios-build10-launch.json, /tmp/alphatrade-ios-build10-installed-app.json. Předchozí blokace odemčením je vyřešena.

### 2026-09-16 — iOS 1.0 (10) podepsáno, instalace čeká na odemčení (Codex)

- Uživatel potvrdil licenci a výslovně autorizoval instalaci. Xcode 27 funguje; CLI doplnilo nové systémové součásti CoreDevice. Sestavení App Debug generic iOS s CURRENT_PROJECT_VERSION=10, jobs=2, stávající DerivedData skončilo BUILD SUCCEEDED. Xcode GUI ani simulátor nebyly otevřeny.
- Podepsaný App.app v /Users/filipkrejca/Library/Developer/Xcode/DerivedData/App-ausqwvwdwpzpyvbauwjqdeunkitb/Build/Products/Debug-iphoneos/ prošel codesign --verify --deep --strict mimo sandbox. Všech 112 webových souborů odpovídá ověřenému dist-native. Obsahuje opravu propFirm a již schválené uchování přepínače.
- První instalace na iPhone UDID 00008110-0002098A1EDB801E (CoreDevice DB4D6D2E-5D1E-5A78-9028-2D2EA3738811) selhala při montování DDI: device locked (10003 / -402652958). Uživateli odeslána žádost odemknout a ponechat telefon odemčený; zatím bez odpovědi. Read-only lockState následně vrátil Could not allocate a resource. Nová verze zatím NENÍ potvrzeně nainstalována. Navázat instalací a launch, ne dalším buildem.
- Log sestavení /tmp/alphatrade-ios-build10.log, první neúspěšná instalace /tmp/alphatrade-ios-build10-install.json. Žádný broker příkaz nebo web deploy.

### 2026-09-16 — Oprava pádu mobilního LIVE při chybějící prop firmě (Codex)

- Stack trace uživatele odpovídá funkci Cw v dodaném native assetu index-Ddc5sLJI.js: buildTradovateConnectionSummaries volal profile.propFirm.trim(), přestože propFirm smí být null. Chyba přesně reprodukována regresním testem před opravou.
- Jednořádková oprava v lib/tradovateLiveConnectionCache.ts používá propFirm?.trim() || ''. Zachovány existující fallbacky organizace, filtrování účtů i počty. Doplněny testy null, undefined, prázdných hodnot, deduplikace a fallbacků.
- Prošlo 23 cílených testů, typecheck, eslint, ios:doctor, build:native a ověření native bundlu. cap copy ios dokončeno; asset index-BDVbd4VH.js je shodný v dist-native a iOS projektu. Žádný broker příkaz ani web deploy.
- Podepsané iOS sestavení/instalace zatím neprovedeny: po aktualizaci na Xcode 27.0 (27A266a) git a devicectl odmítají spuštění kvůli nepotvrzené licenci. Vyžaduje ruční kontrolu a přijetí uživatelem přes sudo xcodebuild -license; asistent licenci nepřijímal.

### 2026-09-15 — Zachování posledního stavu přepínače kopírky (Codex, lokálně)

- Schváleno uživatelem: po běžném návratu ponechat poslední potvrzené Zapnuto/Vypnuto, průběžně obnovovat na pozadí a neproblikávat „Neověřeno“. Společný `CopierConnectionSwitch` platí pro plné i kompaktní zobrazení.
- Oddělená cache uchovává pouze prezentační boolean + čas, podle uživatele a skupiny (24 h; mazání při odhlášení přes existující `alphatrade_` prefix). Cache se nikdy nevrací do execution/runtime stavu. Přepínač zůstává do čerstvého potvrzení neaktivní, po 8 s bez ověření ve viditelné aplikaci ukáže „Stav není aktuální“. Bez předchozího potvrzení se OFF nevymýšlí.
- Read-only status poll se spouští ihned po návratu/focus/online, běží sekvenčně a nečte v pozadí. Odpovědi zahájené před uspáním/návratem/unmountem se nepřijímají; stávající mutation fence zůstává zachovaná. Pozice, freshness/risk limity a broker příkazy se touto úpravou nemění.
- Ověření: 35 cílených testů prošlo, typecheck a eslint změněných souborů bez chyb, standardní `npm run build` prošel. V lokálním náhledu skutečné komponenty ověřeny ON/OFF během obnovy, aktualizace oběma směry, remount a upozornění po výpadku i jeho odstranění po zotavení. Nebyl proveden broker příkaz, push/deploy ani instalace do telefonu. Záloha výchozích dvou upravených komponent: `/tmp/alphatrade-power-retention/before/`.

### 2026-09-13 — Schválené nasazení registrace Live Activity a iPhone 1.0 (9) (Codex)

- Uživatel schválil nasazení. Schválených osm serverových/testovacích souborů odděleno v `/private/tmp/at-live-activity-release-20260913` nad aktuálním origin/main `4ac346ac`; kanonický pracovní strom zůstal zachován, bez zahrnutí ostatních změn. Izolovaný release prošel 56 testy / 6 souborů, TypeScriptem a produkčním buildem.
- Commit `f4f04147427b186075186b95819ce035635bcbc8` pushed na main. Vercel `dpl_HY18M6NztftMKSBF6XRyyfiXFBoW` READY pro přesný commit, alias `alphatrade-mentor-15.vercel.app` HTTP 200, nový registrační guard s neplatným grantem vrací očekávaný 401. V logách jen Node url.parse deprecation warning u relay HTTP 200; žádný zjištěný fatální import/runtime problém.
- Podepsaný build 1.0 (9) nainstalován (první pokus přerušení CoreDevice, druhý úspěšný), aplikace spuštěna. QuickTime zatím hlásí přerušený náhled. Fyzický důkaz nové registrace při zamčeném telefonu stále čeká na uživatelovo další zapnutí.
- Worker pouze přečten: connected=true, armed=false, reconciliationRequired=false, lastError=null, groupFlat=true. Bez ARM, broker příkazů, restartu workeru, migrací a změn konfigurace.

### 2026-09-13 — Nativní registrace Live Activity na pozadí, připraven build 9 (Codex)

- Uživatel odmítl nové vizuály a požádal pokračovat pouze v opravě. Vzhled zůstává beze změn.
- Fyzicky a serverově potvrzeno: start karty proběhl, ale její odběr aktualizací vznikl až po otevření appky v 16:20:06 UTC. Oprava přesouvá registraci z uspávaného JavaScriptu do vlastníka spouštěného AppDelegatem. Server předává do startu podepsané devítihodinové oprávnění omezené na registraci dané session; žádné rozšíření přihlášení nebo broker oprávnění.
- Native registry serializuje POST/DELETE, uchová nedoručené záznamy v odděleném Keychain, při probuzení je zopakuje a po expiraci uklidí. Server ponechává end marker proti opožděnému POST. Starší aktivity a klienti zůstávají kompatibilní.
- Prošlo 65 testů / 8 souborů, TypeScript, ESLint, native bundle, iOS build a podpis. Připraven build 1.0 (9), 112 webových souborů hashově shodných. Zatím nenainstalován, server nepushed/nedeployed, žádný broker zásah ani restart workeru. E2E na zamčeném telefonu vyžaduje serverové nasazení a novou aktivitu s novými atributy.
- Rozsah release a omezení: `docs/reviews/live-activity-background-20260913/README.md`. Dřívější audit OFF/ON souhrnů a frekvence aktualizací není touto samostatnou opravou dokončen.

### 2026-09-13 — Oprava starých registrací Live Activity, iPhone 1.0 (8) (Codex)

- Při uživatelem hlášeném chybějícím startu byl aktuální ARM trigger na serveru označen za pokrytý starší aktivitou (poslední skutečný push-to-start 13:06 UTC, nové ARM 15:37 UTC). QuickTime ukázal ARM notifikaci bez velké Live Activity; později uživatel ručně vypnul kopírku. Žádné ARM/obchody/restart workeru nebyly provedeny asistentem.
- Nalezená cesta ke vzniku falešně aktivních záznamů: retry uložených tokenů bez kontroly ActivityKit znovu aktivoval serverový řádek; neúspěšný DELETE se při příštím startu měnil na POST. Nový nativní bridge vrací ID pouze active/stale aktivit. Klient před POST ověřuje skutečnou existenci, chybějící registrace odstraňuje, neověřitelný stav ponechá k retry.
- Ukončení se trvale označí před síťovým požadavkem a požadavky stejné aktivity se řadí, takže opožděný POST nemůže předběhnout finální DELETE. Ručně zavřená aktivita se tím automaticky znovu nespouští; start trigger ani serverová pravidla nebyla měněna.
- Ověření: 56 testů / 6 souborů, TypeScript, cílený ESLint, native bundle a podepsaný iOS build prošly. Build 1.0 (8), všech 112 webových souborů hashově shodných, nainstalován a spuštěn na fyzickém iPhonu; otevření aplikace viděno v QuickTime. Bez Xcode GUI/simulátoru, bez push/deploy.
- Nový skutečný push-to-start při dalším uživatelově zapnutí ještě není ověřen. Auditované serverové změny frekvence, OFF/ON životního cyklu a neověřených dat zůstávají samostatnou rozpracovanou položkou.

### 2026-09-13 — Audit Live Activity: latence, OFF/ON duplicita a čerstvost (Codex)

- Uživatel chce posoudit vzhled/výkon a hlásí zpoždění limitů, další kartu
  po OFF/ON a nejasné stavy vypnuto/neověřeno. Audit bez úprav aplikace/deploy.
- Kód a pure-function reprodukce: OFF+flat ukončí aktivitu se shrnutím na
  dalších 900 s; nové ARM má nový start trigger, takže staré shrnutí a nová
  karta mohou zůstat vedle sebe. Tick běží jen armed=true, i s otevřenou
  pozicí po DISARM spadne na cron. Čerstvost tick 30 s vs cron 180 s.
- Při chybějícím open P&L může mode=position použít realized P&L (repro +$250).
  Broker=null může zachovat ARM LIVE a čerstvé updatedAt; reconciliationRequired
  chybí ve statusText. Nutné oddělit data freshness od transport heartbeat.
- Výkon: šest broker seznamů/OAuth připojení každých cca 5 s, další dotazy
  při pozici; vše ActivityKit priority 10; relay await až 2,5 s a Promise.race
  nezruší dotazy. Doporučeno oddělení od relay, stream se skutečnou čerstvostí,
  stavové změny prioritně, jediný životní cyklus karty napříč krátkým OFF/ON.
- 42 existujících testů/4 soubory prošly. Baterie, CPU ani produkční APNs
  neměřeny; QuickTime hlásí odpojený iPhone, aktuální render neověřen.
  Podrobnosti: /private/tmp/alphatrade-live-activity-review-20260913.md.

### 2026-09-13 — Ruční read-only reconciliation po hlášce na PC i iPhonu (Codex)

- Uživatel požádal opravit „reconciliation je nutná“. Před kontrolou worker
  připojený, DISARMED, bez divergence/working orders/stuck outbox/lastError,
  ale reconciliationRequired=true. Proveden pouze lokální příkaz reconcile.
- Broker kontrola vrátila authoritativelyClean=true, missingAccounts=[],
  divergentAccounts=[] a workingOrderAccounts=[]. Následný stav potvrdil
  reconciliationRequired=false, groupFlat=true, connected=true, armed=false,
  stuckOutbox=false a lastError=null. Bez ARM, broker write nebo restartu.
- Samostatný stav snímků je stále cdp-offline; obnova TradingView v tomto
  kroku nebyla provedena. Nejde o chybu mobilního zobrazení.

### 2026-09-13 — Detail mobilního účtu nad menu, otevírání shora, iPhone 1.0 (7) (Codex)

- Podle screenshotu uživatele detail překrývala nativní spodní lišta. Detail
  nyní odečítá její výšku + 8 px z dostupné výšky a respektuje horní safe area.
  Na následné upřesnění je zarovnaný nahoře pod stavovou lištou, delší obsah
  se posouvá uvnitř. Zachované komponenty, barvy, data i obchodní handlery.
- Otevření: jemný posun shora + fade 240 ms; zavření opačně 180 ms, včetně
  backdropu. Křížek, spodní tlačítko, backdrop i Escape sdílejí zavírání;
  dialog/focus trap zůstává do konce animace, s timeout pojistkou a cleanupem.
  Respektuje prefers-reduced-motion, opakované zavření je blokované.
- Ověřen browserový odstup 8 px od modelované nativní lišty, horní zarovnání,
  dokončení obou animací a zavření včetně Escape/obnovy body overflow.
  18 souvisejících testů, TypeScript, cílený lint a native build prošly.
  Podpis a shoda všech 112 webových souborů v App.app ověřeny; finální 1.0 (7)
  nainstalována do stejného iPhonu. Skutečný nový render na telefonu zatím
  vizuálně nepotvrzen; Xcode GUI ani simulátor nebyly spuštěny.
- Dočasný náhled a vstupy odstraněny. Bez push/deploy, worker restartu nebo
  broker akce. Dříve doložené dvě chyby celkové sady zůstávají mimo tento rozsah.

### 2026-09-13 — Ztenčení řádků a Flatten All v hlavičce, iPhone 1.0 (6) (Codex)

- Uživatel na telefonu potvrdil vzhled buildu 5 a požádal o dostupnější Flatten
  All při mnoha účtech. V mobilní hlavičce je nyní přímo vedle ZAPNUTÁ/VYPNUTÁ;
  spodní duplicita odstraněna. Handler i potvrzení původní, nově blokuje double
  click během probíhajícího UI příkazu. Žádný Flatten nebyl proveden.
- Stav účtu (Aktivní i všechny blokace) je vedle násobku a badge pozice. Řádky
  běžných účtů mají asi 60 px; původní Flatten účtu/odebrání neověřitelného
  followera a read-only ověření jsou v kontextovém menu ⋮. Chyby a důvody
  blokací zůstávají viditelné. Leader má pouze korunku na logu.
- Browser ověřil pořadí ovládání nad seznamem, společný status řádek,
  kontextové akce a detail; 18 souvisejících testů, TypeScript a cílený lint
  prošly. Znovu sestaven aktuální native web, ověřena shoda všech souborů
  v podepsaném App.app, nainstalována 1.0 (6) do stejného iPhonu.
- Dočasný izolovaný localhost náhled a jeho dva vstupní soubory odstraněny.
  Bez push/deploy či změn workeru a broker akcí. Dvě dříve doložené chyby
  celkové sady nejsou součástí těchto úprav.

### 2026-09-13 — Mobilní LIVE, volba zobrazení a iPhone 1.0 (5) (Codex)

- Schválený kompaktní LIVE je výchozí pod 1024 px. Nabídka ⋮ → Zobrazení
  přepíná Mobilní / Plné a pamatuje volbu jen v localStorage tohoto zařízení;
  široký desktop nadále používá původní tabulky a stejné execution handlery.
- Mobilní přehled: součet dnešního a otevřeného P&L, loga firem, leader pouze
  korunkou na logu, jednotné řádky s P&L, původní badge pozic/SL a čekajících
  BUY/SELL STOP/LIMIT příkazů. Rozbalovací příkazy a akce zachovány, Flatten All
  dál používá původní skupinový příkaz a potvrzení. Detail účtu má Přehled,
  Příkazy a Historii, limity a SL/TP; neověřené pozice/příkazy nejsou vydávány
  za flat nebo chráněné. Stav snímků odkazuje na existující Události.
- SL/TP: vzdálenost od přibližné ceny odvozené z čerstvého account P&L pouze
  při jediné pozici; výsledek od vstupu před poplatky. Skupina sčítá skutečné
  množství včetně leadera. Jiný kontrakt/strana, split úrovně, částečné či
  nadměrné krytí a chybějící data se neslévají do falešného společného výsledku.
  Výpočty jsou výhradně prezentační, nejdou do risk/execution.
- Jediná položka Nastavení v nativním menu; duplicitní iOS funkce odstraněny.
  iPhone otevírá Nastavení na Systém / Tento iPhone; staré deep linky zachovány.
  Nabídka obnovy TradingView při ARM již existovala společně pro local i relay;
  přenesena do čerstvého telefonního balíčku, bez provedení ARM nebo restartu TV.
- Oprava dřívější instalace v této session: starý uložený web bundle ze září 5
  nebyl novější verzí telefonu. Tentokrát build:native z aktuálního canonical
  checkoutu, cap copy ios, build jedním jobem/Swift -j1 bez Xcode GUI a simulátoru.
  Nainstalována 1.0 (5) na iPhone 13 Pro Max. SHA-256 všech 112 webových souborů
  v podepsané App.app souhlasí s dist-native; systémový codesign verify prošel.
- Ověření: 42 cílených testů, TypeScript, cílený lint bez chyb, web/native build
  a ios:doctor prošly. Browser: mobilní karty, detail a jeho záložky, přepnutí
  na Plné a zachování po reloadu, automatická tabulka při širokém viewportu.
  Celá sada: 3207/3209; dvě chyby (liveCopyGroupDetailRender DLL tooltip a
  tradovateBrokerReconnect daily cash value) reprodukovány i v izolované kopii
  stavu před těmito úpravami. Nejsou opraveny v rámci UI práce.
- Fyzické spuštění po instalaci odmítl iPhone jako Locked; čeká na odemknutí
  uživatelem. Instalace je potvrzená, fyzický finální průchod zatím ne.
  Evidence a návratové kopie jen změněných souborů: /private/tmp/at-mobile-ui/.
  Bez push/deploy, broker akcí nebo změny/restartu copier workeru.

### 2026-09-13 — Dočasný náhled iPhonu přes QuickTime (Codex)

- Na výslovnou žádost uživatele přidáno do nativního capture shieldu tlačítko
  „Povolit náhled na 15 minut“, pouze pod `#if DEBUG`. Souhlas je pouze v paměti,
  expiruje po 15 minutách, odpojením capture nebo restartem appky; nezruší
  samostatný privacy/Face ID lock. Release nadále capture vždy zakrývá.
- Přímý QuickTime náhled přes USB funguje bez Xcode GUI a simulátoru. Uživatel
  prochází skutečný telefon, Codex čte snímky QuickTime. Po instalaci vizuálně
  ověřeno nové tlačítko a opravený kontrast vysvětlujícího textu na iPhonu 13 Pro Max.
- Nainstalováno AlphaTrade 1.0 (4), debug build přes `nice -n 15`, `-jobs 1`
  a Swift `-j1`. Použita existující DerivedData cache; všech 120 webových souborů
  přesně shodných s předchozím uloženým device buildem. Žádný web rebuild,
  odinstalace, push, deploy ani zásah do copier workeru či broker příkazů.
- Ověřeno: nativní build, systémový codesign verify, ios doctor, diff whitespace,
  10 Swift lifecycle assertions (`node scripts/ios/test-capture-preview.mjs`).
  Fyzické klepnutí na nové tlačítko a uplynutí celých 15 minut zatím nejsou
  ověřené; uživatel musí náhled povolit na telefonu. Testy pokrývají hranici
  expirace, reconnect, nový proces a návrat po expiraci bez simulátoru.
- Záloha původního nativního souboru a App.app 1.0 (1), test/build evidence:
  `/private/tmp/alphatrade-mirroring-20260913`. Ostatní rozpracované změny zachovány.

### 2026-09-13 — Retire obsolete Tradecopia and CSV import UI (local)

- Removed Tradecopia notification settings/samples, old auto-import and pairing queue, Tradovate/Tradesyncer CSV dialogs and account/history entry points including empty-history upload. Current copier journal sync, pending account assignment, screenshot linking and native copier alerts retained.
- Legacy notification API and two Tradecopia Edge ingestion sources now return 410; not deployed. Historical database records and Coach incident reads retained; shared instrument/pairing/live types remain.
- Unloaded com.alphatrade.tradecopia-fast-events and com.alphatrade.tradecopia-sync; verified both absent from launchd. Plists backed up in Library/Application Support/AlphaTrade/retired-tradecopia-20260913. Old source installers/collectors fail immediately to prevent reactivation. Current copier worker untouched.
- Validation: 58 focused tests passed (journal sync, snapshot storage, historical pairing, instrument helpers, retired API). Typecheck and production build passed. Targeted lint: 0 errors (74 warnings). No production push, Edge deploy, database mutation or broker action.

### 2026-09-11 — Lokální průběžná data LIVE (ověřeno lokálně, Codex)
Potvrzené zůstatky a denní P&L jsou oddělené od 45s risk brány; původní execution pole se nepřepisují. Worker změny cash/position/fill invalidují omezenou frontu snapshotů, stav se přenáší přídavným accountDisplay DTO. Dashboard má per-user/per-connection/per-environment cache a záložní cílené čtení; pro staré API dočasně jeden společný preflight/minutu. Stav streamu je oddělený od stáří částky. Vše pouze lokálně, instalovaný worker a produkce beze změny. Přesný stav, ověření a zbývající kroky v docs/reviews/live-cash-stream-20260911/PROGRESS.md; lokální audit je dokončen v souboru VERIFICATION.md ve stejné složce (3185 testů prošlo). Aktivace API a instalovaného workeru vyžaduje souhlas nad rámec localhostu.

### 2026-09-12 (Codex, pouze localhost: hodnoty LIVE po reloadu)
Doplněna session cache pouze potvrzeného zůstatku a denního P&L pro konkrétního uživatele/připojení/prostředí/účet. Po načtení aktuálního seznamu účtů se zobrazí uložené částky během obnovování; nepersistuje se risk ani execution stav. Zachované původní časy, expirace 24 h, denní P&L pouze ve stejném obchodním dni, denied účty bez hodnot. Kontrola reloadu zobrazila všech 7 zůstatků při prvním zachyceném vykreslení tabulky. Typecheck, lint a build prošly; cílené testy ověřují obnovu, identitu, den a zachování risk gate. Bez push/deploy či změny workeru.

### 2026-09-12 (Codex, localhost: DLL/DD bez prázdných mezistavů)
AccountRow zobrazuje poslední známou částku DLL a rezervy DD při expirovaném nebo neúplném čtení neutrálně s původním časem v tooltipu. Krátkodobá paměť hodnot je pouze v UI, oddělená podle uživatele, účtu, pravidla a obchodního dne; není vstupem do risk/execution. Přísná 45s kontrola zachována, změna potvrzené částky se promítá hned. Browser potvrdil 14 částek (DLL/DD u 7 účtů) se stavem last-known a původními časy. Bez nasazení či změny workeru.

### 2026-09-12 (Codex, localhost: úplný průběh DLL/DD obnovování)
Opraveny další mezistavy: stabilní React klíč podle accountId namísto názvu/pořadí; identita uchování podle uživatele, OAuth připojení/prostředí, explicitního profilu a obchodního dne, nikoli dopočítaného DD flooru. Neznámý limit při dílčí odpovědi již neznamená vypnutý limit. Před dokončením bootstrapu/čtení risk podkladů se nezobrazí předběžný DD z profilu; první načtení ukazuje statický placeholder, obnovení ponechá poslední známé číslo. Pro localhost přidán pouze GET copier-relay; POST/DELETE zůstávají blokované. Browser zachytil nejdřív 14 placeholderů, následně všech 14 správných částek u 7 účtů a čerstvý OFF stav workeru. 28 cílených testů passed. Bez push/deploy či restartu workeru.

### 2026-09-12 (Codex, localhost: zelené DLL/DD a paměť po reloadu)
Na žádost uživatele stáří hodnot nemění barvu částek; tooltip a data-risk-display stále rozlišují last-known. Přidána sessionStorage cache výhradně pro zobrazení DLL/DD, oddělená uživatelem, připojením, prostředím, účtem, explicitním profilem a obchodním dnem. Obnova zachová původní čas a nikdy neoznačuje cache za nové ověření. Na změně pravidel nebo dni se nepoužije; při vypnutí se odstraní. Risk/execution se z cache nepočítá. Bez push/deploy či změny workeru.

### 2026-09-20 — Claude: čekající vstup nese směr, varování a vlastní bublinu

Uživatel se zeptal, jestli chip čekajícího vstupu rozlišuje Buy/Sell. Nerozlišoval:
vykresloval jen hodiny, symbol a počet, typ příkazu byl pouze v nativním
`title` a směr nikde — přestože u otevřené pozice sloupec směr ukazuje
znaménkem i barvou. Z porovnaných provedení
(`mockups/pending-entry.html`, `mockups/pending-warning.html`) vybráno:

- **Směr slovem** — barevný odznak BUY/SELL v chipu. Znaménko a barva písma
  byly na 10px textu nečitelné, plná barevná výplň se zase pletla s otevřenou
  pozicí (v trhu ještě nejsi).
- **Varování uvnitř chipu**, ne jako samostatný štítek. Naměřeno: štítek
  „bez SL“ jako u pozice roztáhne nejhorší případ (pozice + vstup) na 224 px,
  sloupec má 200. Trojúhelník uvnitř dá 177 px. Oranžový = bez stop lossu,
  červený s „2/3“ = kryje jen část.
- **Vlastní bublina místo `title`.** Nativní tooltip naskočí až po sekundě,
  kreslí ho OS a na dotyku nefunguje. `HoverCard` jde portálem s
  `position: fixed`, protože tabulka účtů má vlastní posuvník, který by
  absolutně umístěnou bublinu ořízla; u horního okraje se překlápí pod kotvu
  a zavírá se při scrollu. Nese cenu vstupu, SL, target a stáří příkazu; totéž
  dostala i otevřená pozice, kde dosud po najetí nebylo nic.

`pendingEntryProtection` (7 testů) odvozuje ochranu stejným pravidlem jako
u pozic — working příkaz na opačnou stranu a přesně stejný kontrakt, sám vstup
se nepočítá. Omezení: broker vazbu mezi příkazy (bracket, OCO) neposílá, takže
dvě protilehlé čekající objednávky na jednom kontraktu by se navzájem
označily za ochranu. Řádek, který to přiznával v bublině, uživatel nechal
smazat jako otravný — chybějící SL hlásí štítek.

`contractsLabel` (2 testy) opravuje skloňování: dosud „2 kontraktů“.

Zrušen úzký režim tabulky účtů. Pod 1100 px tabulka zahazovala uživatelův výběr
sloupců a nechala sedm „základních“, k tomu se objevilo tlačítko „Všechny
sloupce“ na přepnutí zpět. Nastavení sloupců se dělá právě proto, aby platilo
pořád — širší tabulka se teď vodorovně odscrolluje v `.live-accounts-scroll`.
Ověřeno při šířce okna 1096 px: tlačítko je pryč a vykreslí se všech
12 sloupců.

### 2026-09-19 — Claude: přepínač Účty/Příkazy z hlavičky detailu dolů

Uživatel ukázal na kolizi: záložka „Účty“ stála přímo nad sloupcem „ÚČET“ —
totéž slovo dvakrát pod sebou. Měření odhalilo víc: pruh se záložkami měří
988 × 36,5 px a na záložce Účty v něm byla jen dvě tlačítka (~870 px prázdna),
protože pravá půlka (chip zařazených followerů, počet working, obnovit) se
ukazovala **jen** na Příkazech. Kolik příkazů skupina má se tedy nedalo zjistit
bez kliknutí.

Nová podoba: pruh nahoře zrušen, po řádku skupiny jde rovnou tabulka.
Přepínač je vlevo **pod obsahem**, podtržený jako dřív, ale menší (10 px proti
11, řádek 26 proti 30,5) a bez barvy akcentu — funkce se používá zřídka, tak
nemá tahat oči. Nese počty („Účty 6“, „Příkazy 3“); počet working a obnovit
zůstaly vpravo na záložce příkazů.

Chip „Followeři X/Y zařazení“ zrušen bez náhrady. Je to stav skupiny a vidíme
ho tam, kde na něj je vidět bez rozbalování: oranžový chip v řádku skupiny se
objeví právě při odchylce (stejné pravidlo jako u ostatních chipů — plný počet
nic neříká) a stavová tečka u konkrétního účtu.

Překlopení animuje: obsah se přelije do strany podle směru
(`live-detail-pane` / `-back`) a karta přejede na novou výšku, aby přepínač
neuskočil zpod kurzoru. `min-height: 180px` drží kartu pohromadě — bez ní by
přechod z dvaceti účtů (strop 60vh ≈ 502 px) na tři příkazy složil téměř
400 px naráz. Respektuje `prefers-reduced-motion`.

Tabulka příkazů ztenčena z 53 na 37 px na řádek. Výšku nedržel text, ale
tlačítko Cancel (30 px) v řádku o jediné řádce; zmenšeno na 24 px, k tomu
svislé odsazení buněk 10 → 6 px, logo brokera 20 → 16 px a hlavička 47 → 28 px.
Spodní hranice se tím zvýraznila (u tří příkazů zbývalo 114 px prázdna), proto
snížena z 260 na 180 px — prázdna zbyde 34 px.

Zamítnuto při návrhu: varianta „příkazy jako sekce pod účty bez záložek“.
Uživatelova námitka byla správná a moje protiargumentace špatná — tabulka účtů
má strop `min(60vh, 620px)` s vlastním posuvníkem, takže ani při dvaceti účtech
by se sekce neztratila. Nakonec přesto vyhrál přepínač, protože je úspornější.

Ověřeno v prohlížeči na skutečné komponentě (`mockups/live-groups-live.html`,
mountuje `LiveCopyTradeOverview` s daty z render testů): výška jede
313 → 274 → 260 px v deseti mezikrocích, oba směry animace sedí, spodní hranice
drží. 3722 testů, typecheck i lint čisté.

### 2026-09-19 — Claude: editor skupiny přestavěn (průvodce → jedna obrazovka)

Založení i úprava skupiny jely stejným čtyřkrokovým průvodcem. Naměřeno na
dnešní verzi: úprava existující skupiny startovala na obrazovce „Pojmenuj
skupinu“ a záložky kroků šly jen zpátky (`index <= step`), takže změna jednoho
násobku stála 3× „Další“; dialog měnil výšku mezi kroky o 370 px (400 → 545 →
612 → 770); poslední krok přetékal o 301 px a přehled změn před uložením byl
celý pod okrajem; kroky „Leader“ a „Followeři“ nabízely tentýž seznam účtů
dvakrát; při otevření svítilo 15 zašedlých ovládacích prvků.

Nová podoba (varianta F z `mockups/group-editor-leader.html`): **leader vlevo
ve vlastním sloupci, followeři vpravo**, žádné kroky. Leader je jedna volba, tak
má vlastní místo a zlatou korunku — ne šestý sloupec v řádku. Účet zvolený jako
leader z tabulky followerů zmizí, takže nemůže kopírovat sám sebe. Přibylo
„Označit vše / Odebrat vše“ (nepřepisuje už nastavené followery a leadera se
nedotkne) a průběžná **souhrnná expozice** v hlavičce
(`copyGroupExposureMultiple`, 4 testy — follower s replikací „Vypnuto“ se
nepočítá). Ochrany a přehled změn jsou rozbalovací, přehled otevřený.

Hlavička: titulek okna („Vytvořit skupinu“ / „Upravit skupinu“), popisek
„Název skupiny“ a **barva jako destička uvnitř pole** s paletou v popoveru —
osm volných koleček bylo devět prvků za jednu volbu a zabíralo 389 px proti
dnešním 264. Barva patří k názvu, protože v tabulce LIVE je to jeho tečka.

Ovládání v řádku followera už není nativní: `<select>` má `appearance:none`
a vlastní chevron, číselníky nahradil krokovač `− hodnota +`. U Max limitu je
„bez limitu“ plnohodnotný stav (∞) a krok dolů z jedničky se do něj vrací, takže
se limit ruší stejným ovládáním, jakým se nastavuje. Psát hodnotu jde pořád.

Opraveno při přejímce: `changeCopyGroupLeader` přidával předchozího leadera
mezi followery **vždy**, takže proklikání seznamu leaderů postupně označilo
všechny účty jako followery. Prohazování rolí bylo na přání zrušeno úplně —
přidat obchodující účet do skupiny musí být vědomé rozhodnutí. Funkce je teď
hloupá: nastaví leadera a odebere ho z followerů, nic nedoplňuje.

Samotné zrušení ale otevřelo opačnou past: povýšený follower z tabulky vypadl
a nic ho nevracelo, takže projetí seznamu skupinu naopak **vyprázdnilo** i se
zadanými násobky. Editor si proto drží `displacedFollowers` — koho vytlačilo
povýšení, ten se při změně leadera vrátí přesně s původním nastavením.
Výsledek ověřen v prohlížeči: projití všech šesti účtů jako leaderů nechá
followery i násobek 2× beze změny a návrat k původnímu leaderovi obnoví
výchozí stav.

V řádku leadera je logo propfirmy s korunkou jako odznakem v rohu (korunka je
role, ne ikona účtu) a pod názvem zůstatek v USD. Krokovače Násobku a Maxu
zúženy z 92 na 74 px.

Zachováno beze změny: režim „dnes jen zpřísnit“ (nelze přidat followera, zvýšit
násobek ani uvolnit Max nad uloženou hodnotu, ani přepnout leadera), náhrada
nedostupných účtů z uložené skupiny, hlášení stavu cloudové knihovny, validace
přes `validateCopyGroup` a Escape pro zavření (nejdřív zavře paletu).
Layout se pod `md` skládá pod sebe a tabulka followerů dostala vodorovný scroll
— původní jednosloupcový editor na úzké obrazovce fungoval a nesmělo to být
horší. Ověřeno v prohlížeči na skutečné komponentě
(`mockups/group-editor-live.html`): krokovače, hromadný výběr i přepnutí leadera
se správně promítají do přehledu změn. 3718 testů, typecheck čistý.

### 2026-09-19 — Claude: mazání skupiny přímo z menu řádku

Smazat skupinu šlo dosud jen přes „Upravit skupinu“ → tlačítko v patičce
editoru. Přidáno do menu ⋮ u řádku skupiny i u kompaktní karty, pod čáru a
úplně dolů, aby se na něj nedalo trefit cestou k něčemu jinému. Používá
beze změny existující cestu `pendingAction` → `command: delete-group`, takže
potvrzovací dialog, cloudová fence i chování při chybě zůstávají stejné.

Bezpečnost: `runCommand` volá runtime adaptér dřív, než sáhne na lokální
stav, a runtime smazání běžící skupiny odmítne („Skupinu nejdřív DISARM“) —
konfigurace tedy nemůže zmizet pod běžícím agentem. UI na to navíc
upozorní dopředu vlastním dialogem, ať uživatel nenaráží do chyby.

Menu dopřeloženo do češtiny („Upravit skupinu“, „Použít šablonu“, titulek
„Další akce“) — zbývala v něm angličtina vedle českých položek.
`mockups/group-menu-live.html` mountuje skutečné `GroupActionMenu` s mock
akcemi (proto je exportované).

### 2026-09-19 — Claude: Nastavení tabulky přestavěno na boční lištu + pořadí sloupců

Dialog „Nastavení tabulky“ na LIVE byl jedna 1069px dlouhá roura s 32
zaškrtávátky (452 px se muselo scrollovat), 23 anglickými popisky proti 12
českým a třemi seznamy sloupců ve dvou různých provedeních. Přestavěn na
boční lištu (macOS styl): sekce Účty / Skupiny / Příkazy s počtem zapnutých
sloupců, plus Soukromí a Bezpečnost. Vše česky, pevná výška 352 px, aby
přepnutí sekce nehýbalo dialogem pod kurzorem.

**Pořadí sloupců** je nové a jde napříč všemi třemi tabulkami. Tabulka účtů
už byla datová (`columns.map`), tabulka skupin a příkazů měly sloupce natvrdo
v JSX — převedeny na mapu buněk podle klíče, která se skládá v uživatelově
pořadí. Logika je v `lib/tableColumnOrder.ts` (12 testů): neznámý klíč se
zahodí, nově přidaný sloupec se vrátí na své výchozí místo (ne na konec, kde
by ho nikdo nehledal), a `account`/`actions` drží krajní pozice bez ohledu na
uložené pořadí. Ukládá se do `alphatrade_live_copytrade_column_order`.

Přetahování (`components/ColumnOrderList.tsx`) jede na pointer events, ne na
HTML5 drag — tažený řádek se drží pod prstem přes `transform` a ostatní se
překládají FLIP animací, takže to vypadá jako prohazování, ne jako skok.
První verze se sekala: každý přesun o řádek zapsal do stavu
`LiveCopyTradeOverview`, což překreslilo celou stránku LIVE a zapsalo do
localStorage — desetkrát za jeden tah. Přeskládání proto běží lokálně
(`localOrder`), posun pod prstem se píše rovnou do DOM bez `setState` a
pointermove se slučuje po snímcích; nadřazený stav dostane jediný výsledný
přesun až při puštění. Naměřeno 59 fps při tahu přes devět řádků.
Pointermove se poslouchá na `window`, ne na úchytu: samotné `setPointerCapture`
nestačilo a tah se zastavil, jakmile ruka vyjela do strany mimo ikonu.
Rychlý tah pak odhalil tři další chyby: (1) FLIP měřil `getBoundingClientRect`
na prvku, po kterém zrovna běžela animace, takže si uložil místo, kde je prvek
zrovna vidět, ne kam patří — běžící animace se teď ruší PŘED měřením;
(2) posun taženého řádku se zapisoval do DOM hned při přepočtu, tedy o snímek
dřív, než se seznam přeskládal, takže řádek na snímek visel mezi místy — píše
se až v layout efektu po překreslení; (3) při švihnutí a okamžitém puštění se
naplánovaný snímek vůbec nestihl a přesun se zahodil — cílová pozice se proto
dopočítá znovu ze souřadnice `pointerup`. Ověřeno: 40 pohybů se změnami směru
v pěti snímcích, řádky sedí přesně na mřížce po 28 px a tažený řádek drží prst
s nulovou odchylkou. `pointercancel` pořadí nemění.
`useFlipReorder` dostal `skipId` (tažený řádek se neanimuje proti ruce) a ruší
předchozí animaci na témže prvku, aby se při rychlém tahu nesčítaly. Pořadí
jde měnit i klávesnicí (šipky na úchytu). Ověřeno v prohlížeči: řádky mají
28 px a rozteč taky 28 px, takže řádek pod prstem nedriftuje.

**Zrušena hustota tabulky.** Nastavovala `fontSize: N%` na obalu, jenže
Tailwind sází v `rem` (root-relative), takže to na `text-xs` nemělo žádný
vliv — volba nikdy nic nedělala. Odstraněn i stav a zápis do
`VIEW_SETTINGS_STORAGE_KEY`; starší uložená hodnota se ignoruje.

Viditelnost sloupce se přepíná zaškrtávátkem, ne kolébkovým přepínačem:
přepínač v této appce znamená zapnutou kopírku a nesmí vypadat stejně jako
volba sloupce.

Smazána dočasná ukázka stavů ostrova (`islandDemo` + panel dole vlevo), která
podstrkovala ostrovu falešné vstupy kvůli návrhu.

Volba „Po Flatten All nabídnout zapnutí a pokračovat“ je chování copieru, ne
nastavení tabulky — přesunuta do sekce Bezpečnost téhož dialogu (zatím ne
jinam, aby se nerozbíjelo, kde ji uživatel hledá).

`mockups/table-settings.html` jsou čtyři porovnané návrhy (vybrána varianta B).
`mockups/table-settings-live.html` mountuje **skutečnou** komponentu dialogu
s mock stavem — náhled designu bez přihlášení; proto je `TableSettingsDialog`
exportovaný.

Ověřeno: 3714 testů, typecheck bez chyb (mimo předchozí `extension/` chyby
kvůli chybějícím `@types/chrome`).

### 2026-09-19 08:40 — Claude: odpojené Tradovate připojení jde skrýt z přehledu (archivace), nemaže se

Uživatel v 08:17 odpojil FundedNext (tokeny smazány, `connection_status =
disconnected`) a ptal se, proč řádek zůstává. Zůstává záměrně (deník, journal
evidence a spárovaná zařízení nesou ID připojení, Reconnect bez nového
párování). Nově: migrace `20260919063000_oauth_connection_archive.sql`
(sloupec `archived_at`, nasazena `db query -f` + repair, zkopírována do
Documents), `setTradovateConnectionArchived` (jen odpojené; připojené → 409),
`POST /api/tradovate/oauth/status { connectionId, archived }`, klient
`setTradovateOAuthConnectionArchived`, hook `setArchived`, v Connections
tlačítko „Skrýt" u odpojeného řádku, přepínač „Archivovaná (n)" a „Obnovit".
Živá čtení archivovaná připojení už nedělají (jsou odpojená). Nic se nemaže.

**Ráno 05:01:48Z (07:01 místního):** oba sockety (Tradeify 1006, Lucid čistý
1005 ze stavu connected) zavřeny během 10 ms, sync na obou 2× timeout, 05:03:23Z
vynucená obnova tokenů, 05:03:27Z obě sessions synchronizované. Mac bez
síťové události, relay bez výpadku. Zátěž z webu v 04:43–04:49 (socket-error
04:48 se zotavil hned) byla stejná jako v 04:56–05:02 → korelace se zátěží
slábne; nejlepší čtení: událost na straně Tradovate (status page: probíhající
víkendová údržba, je sobota, burza zavřená).

### 2026-09-18 22:20 — Claude: čtvrtý pád session Tradeify (20:07Z) a korelace s dávkami čtení z webu

**Pád 20:07:17Z:** socket-error → close 1006 (socket starý 1504 s), reconnect
autorizace 158 ms, sync 2× timeout (fáze syncing), 20:08:52Z vynucená obnova
tokenu, 20:08:55Z autorizace, 20:12:12Z read-only kontrola potvrdila flat →
připojeno. Kopírka byla ARMED → transport-lost DISARM (flat). Výpadek 5 min.

**Korelace (Vercel, 5 min před každým pádem, group by requestPath):**
| okno | preflight | history-sync | live-pnl | výsledek |
|---|---|---|---|---|
| 12:33–12:38 (Tradeify socket-error 12:38) | 0 | 0 | 0 (LIVE zavřené) | reconnect + sync OK hned |
| 15:36–15:41 (Tradeify+FundedNext) | 12 | 14 | 420 | hodinu mrtvé |
| 18:03–18:08 (Lucid) | 6 | 7 | 429 | mrtvé do obnovy tokenu |
| 18:46–18:51 (Tradeify) | 3 | 0 | 307 | mrtvé, pak p-ticket |
| 20:04–20:07 (Tradeify) | 15 (3 dávky po 6 během 2 s = načtení stránky) | 14 | 168 | mrtvé 5 min |
| kontrola 19:45–19:50 (klid) | 0 | 0 | 54 | žádný pád |
Jeden „full" preflight = account/list + 4 volání na účet + 7 listů + probe ≈
17 (Tradeify) až 30 (Lucid) Tradovate volání během sekundy; načtení LIVE =
bootstrap + full na každé připojení (i FundedNext bez účtů). Samotný socket-error
není patologie (12:38 se zotavil okamžitě); patologie je „sync po reconnectu
neodpoví, když token právě dostává dávky REST". Zůstává korelace, ne důkaz.
Worker sám: Tradeify ~275–300 REST/h, Lucid ~600 REST/h (risk poll 60 s ×
účet v DISARMED, čtení zůstatků při stream událostech, reconcile).

**Změna (commit tohoto zápisu):** `api/tradovate/oauth/preflight.ts` sdílí
výsledek na (uživatel, připojení, režim) 20 s — opakované načtení stránky,
iPhone a companion už dávku neopakují. Web live.

**Doporučení pro zítřek:** LIVE otevřít jednou a nechat (bez reloadů), sledovat
panel; zvážit: live čtení jen pro připojení s účty (FundedNext vynechat),
history-sync na vyžádání, worker risk poll v DISARMED 60 s → 120 s.

### 2026-09-18 22:15 — Claude: oprava podle review Codexu — oficiální limity Tradovate, p-ticket je na IP, ne na token

Codex správně opravil moje závěry, ověřeno v oficiální dokumentaci
(partner.tradovate.com/overview/core-concepts/rate-limits a /penalty-tickets):
- **Limity uživatele:** 5 000 požadavků/h přes všechny endpointy (překročení =
  429, na WS `[{"s":429}]`). Žádný pevný limit 80/min neexistuje — ten byl z
  třetích stran (Tradesyncer). Dnešní ~90 volání/min z webu by hodinový limit
  překročilo jen při trvalém běhu; 429 jsme za celý den neviděli, takže
  uživatelský limit prokazatelně překročen NEBYL.
- **Endpointové limity jsou na IP rozsah /24, ne na token/uživatele:**
  `syncrequest` 300/h (počítá každé volání), `accesstokenrequest` 5/h.
  Překročení = `p-ticket`/`p-time` v jinak úspěšné odpovědi; předčasné
  opakování `p-time` sčítá. → p-ticket workeru na Macu nemohl způsobit Vercel
  (jiné IP). Na téže domácí síti ale běží i platforma Tradovate uživatele
  („nic tam nejde") a iPhone — jejich syncrequesty a přihlášení se počítají
  do stejného IP budgetu jako worker.
- **Nový token nevytváří nový rate-limit prostor.** Že obnova tokenu dvakrát
  „pomohla", je časová shoda s novým socketem/syncrequestem, ne důkaz.
  Vlastní token workeru má smysl jen pro oddělení execution session, ne jako
  lék na limity.
- **Close kódy:** 1005 = bez status kódu, 1006 = abnormální ukončení (server,
  síť, proxy i lokální transport). Lucid 18:08 (čistý 1005 ze stavu connected)
  je silně podezřelý na vzdálené zavření; Tradeify 1006 po socket-error
  jednoznačný není.
- Dva různé jevy: (a) tiché stally (syncrequest bez odpovědi, REST 45 s
  timeout) 15:41–16:42, 18:08 Lucid, 18:50 Tradeify — příčina neprokázaná;
  (b) p-ticket na syncrequest 18:52 po sérii reconnectů — prokázaný
  endpointový limit na IP.

**Změny (web + worker, commit tohoto zápisu):** počítadlo a panel používají
oficiální hodnoty (5 000/h uživatel, tempo 83/min jen orientačně, syncrequest
300/h na IP); broker počítá `user/syncrequest` zvlášť (`syncRequests` ve
`connectionUsage`), panel ho ukazuje s poznámkou „limit na IP, sdílený s
celou sítí". Worker část po dalším reinstallu.

**Doporučení Codexu, se kterými souhlasím:** support nejdřív Tradovate Partner
Support (p-ticket není vázaný na propku) s UTC časy, endpointem, close kódy a
poli tiketu; izolace mrtvého spojení podle fáze obchodu (flat účty vyřadit
z nových vstupů, při otevřeném obchodu zdravým dál kopírovat exity/SL/TP,
odpojené držet jako UNKNOWN/DEGRADED); FundedNext: spojení zachovat, živé
brokerové čtení pozastavit; jeden řízený datový tok na login s rozpočtem
požadavků, web čte z uloženého streamu/cache. **Neuzavřené riziko:** účet
65839434 (-25 MNQ při flat leaderu ve 14:16Z) ověřit ve FundedNext/Tradovate
historii — odebrání z manifestu nic nepotvrzuje.

### 2026-09-18 21:50 — Claude: worker reinstalován z 0df6c6b (na „nasaď worker")

Brána prošla (DISARMED, připojený, reconciled, flat, bez chyby). Bundle
sha256 d393c9a2e29b4867…; nese diagnostiku penalizace (WS PENALTY + lastError),
`connectionUsage` ve statusu (REST/WS volání, fáze, close kód, penaltyUntil)
pro panel v LIVE, plus všechny dřívější dnešní fixy. Manifest jen Tradeify +
Lucid. Po startu read-only reconcile. Runtime DISARMED.

### 2026-09-18 21:45 — Claude: LIVE Diagnostika ukazuje čerpání limitu Tradovate na login a stav session workeru

Uživatel: dosavadní panel „jen počet požadavků prohlížeče" byl k ničemu —
token na ~90 Tradovate volání/min vypadal v klidu. Nově (commit e3281ab):
- `lib/tradovateUsageMeter.ts` — klouzavé minutové/hodinové počítadlo, limity
  80/min a 5000/h, semafor (60 % = oranžová, nad limit = červená).
- Server: `live-pnl` vrací `brokerCalls` (tick = počet Tradovate volání, cash
  = 3, sdílený výsledek z cache = 0); klientská telemetrie je sčítá po
  připojení (`brokerCalls` ve snapshotu).
- Worker: broker počítá REST (`request`) i WS požadavky (`sendSocketRequest`),
  drží `lastClose` (kód, důvod, clean, kdo zavřel), `penaltyUntil` (p-time)
  a `consecutiveSyncTimeouts`; `usage()` na `TradovateBrokerPort`; pilot
  posílá `connectionUsage[]` ve statusu (protokol `CopierConnectionUsage`).
- UI: `buildTradovateConnectionUsageRows` (label z organizationName /
  tradovateEmail / conn:xxxx) → v „Diagnostika dat a API" na login: web +
  worker vs. limit, věta o session („penalizace Tradovate, sync za 12 min",
  „bez streamu (syncing, 2× sync timeout) · poslední zavření 20:50:56
  (Tradovate, kód 1006)", „session připojená").
Web část je live; worker část čeká na reinstall (kopírka je teď ARMED, uživatel
zapíná/vypíná, penalizace Tradeify vypršela ~19:25Z po ~32 min).

### 2026-09-18 21:20 — Claude: penalizace Tradovate potvrzena chováním (p-ticket na syncrequest), snížený objem REST z webu

**Nový důkaz:** Tradeify session umřela potřetí (18:50:56Z, close 1006 po 474 s
na tokenu z 18:42Z). Po vynucené obnově (18:52:30Z) se socket autorizoval za
143 ms a pak 18 minut nic: to je větev `p-ticket` v `handleMessageObject` —
Tradovate odpověděl na `user/syncrequest` penalizačním tiketem a broker potichu
čeká `p-time`. Současně REST čtení zůstatků na stejném tokenu z Macu fungovala
(accountDisplay confirmedAt 19:10:15Z). Tradovate dokumentace: „when you
trigger the rate limit or flood the API with too many reconnections, Tradovate
may assign a p-ticket“; partner docs: „Only one syncrequest is sent per socket
lifecycle“. Zdroje: github.com/tradovate/example-api-faq
HowToHandleRequestLimits.md, partner.tradovate.com Stage 2 WebSocket
Management, help.tradesyncer.com (80/min, 5000/h).

**Změny (commit v tomto zápisu):**
- `services/tradovateBroker.ts`: penalizace už není tichá — `WS PENALTY
  request p-time p-captcha p-message` v diagnostice a chybová událost
  „Tradovate WebSocket sync penalized (p-time X s)“ do controlleru (lastError).
  Worker to dostane příštím reinstallem.
- `components/useTradovateLiveData.ts`: intervaly 1/2/5 s → 3/6/15 s (pozice a
  příkazy má LIVE z heartbeatu workera každou sekundu, REST je záloha a
  zůstatky).
- `api/tradovate/oauth/live-pnl.ts`: sdílení ticků na (uživatel, připojení,
  cursor) 2,5 s a zůstatků na účet 5 s ve warm instanci — web, iPhone a
  companion už netáhnou každý zvlášť. Selhání se nesdílí. Test.

Odhad: z ~90 Tradovate volání/min na token na ~20–30. Zbývá: vlastní token
pro worker (oddělená session), odpojení FundedNext v aplikaci (web ho stále
polluje), volitelně delší backoff reconnectů po sync timeoutu.

### 2026-09-18 20:50 — Claude: vzorec „mrtvá session" se opakoval 2× i po reinstallu; nová diagnostika ukazuje close kódy 1005/1006 a hlavní podezřelý je objem REST z webu

**Pozorování (worker 3408088, nová diagnostika):**
- 18:08:10Z Tradovate zavřel socket Lucid (`code=1005 clean=true socketAgeS=1075`, stav connected, kopírka ARMED od 18:01:44Z → transport-lost DISARM, flat). Reconnect: `WS AUTHORIZED afterMs≈145`, pak `WS SYNC TIMEOUT phase=syncing` 45 s, znovu totéž → 18:09:44Z `SESSION RENEWAL 2× sync timeout → vynucená obnova tokenu`, 18:09:45Z token obnoven, 18:09:49Z autorizace a session funguje. Výpadek 1,5 min místo hodiny.
- Tradeify: socket zůstal otevřený (věk 3002 s), ale REST `/account/list` a `/order/list` visely 45 s už v 18:12:52Z; plánovaná obměna socketu 18:40:17Z (`code=1006`), reconnect autorizován, sync 2× timeout → 18:42:46Z vynucená obnova → 18:43:02Z autorizace, 18:43:04Z read-only kontrola potvrdila flat. Zapnutí kopírky mezitím 4× odmítnuto po 45 s (UI „worker příkaz včas nepotvrdil").
- Vercel live-pnl se stejnými tokeny po celou dobu 200 (žádné 408, žádné 429 za 3 h).

**Hypotéza (zatím nejlepší, nepotvrzená):** Tradovate limituje REST ~80/min a 5000/h
na uživatele/session; při překročení podle komunitních vláken nezřídka nevrací
429, ale zavírá sockety s 1005/1006 a stalluje session (p-time typicky 3600 s
— dnešní první výpadek trval přesně 61 min). Web při otevřeném LIVE volá
`live-pnl` ~67×/min (3 připojení, 1–2 s interval), každé volání = position/list
+ order/list + orderVersion/list + rotující cashBalance snapshot ≈ 4 Tradovate
volání → ~90/min na token, plus worker (risk poll 30 s × účet), cron snapshoty,
status/preflight. Sessions umíraly vždy při otevřeném LIVE (15:41Z, 18:08Z,
≤18:12Z); v noci a bez LIVE běží worker hodiny. Nový token = nová session =
nový budget, proto vynucená obnova pomáhá.

**Návrh (rozhodnutí uživatele):** 1) web při čerstvém heartbeatu workera
nepolluje pozice/příkazy přes REST (má je z heartbeatu), cash snapshot jen
každých 10–30 s, na pozadí nic; 2) worker dostane vlastní Tradovate token
(vlastní session) oddělený od tokenu pro webové čtení, aby ho web nemohl
penalizovat; 3) FundedNext připojení odpojit i v aplikaci (live-pnl ho stále
polluje bez účtů). Zdroje limitů: Tradesyncer „REST 5000 requests/hour or 80
requests/minute", Tradovate fórum „API and Websocket limitation" (1005/1006 bez
vysvětlení).

### 2026-09-18 19:52 — Claude: worker reinstalován z 3408088 (na „nasaď"), FundedNext odebráno z manifestu

Brána bezpečného skriptu prošla (DISARMED, připojený, po Kontrole pozic, flat,
bez chyby; uživatel dnes neobchoduje). Před reinstallem záloha manifestu
`connections.json.bak-20260918T175002Z` a odebrání připojení 7cce8c5b
(FundedNext, po breachi bez účtů). Worker startoval 17:50:15Z jen se dvěma
připojeními (Tradeify 65333343/65333277, Lucid leader + 4 followeři), oba
sockety `WS AUTHORIZED afterMs≈140`, automatická kontrola po startu potvrdila
flat, read-only reconcile `authoritativelyClean: true`, bez divergence.
Bundle sha256 ddc925e6f18819b0…, obsahuje: router ignorující spojení bez účtů,
tolerantní start bez čitelného adresáře, vynucenou obnovu tokenu po 2 sync
timeoutech a diagnostiku close kódů. Runtime DISARMED; zapnutí je na uživateli.
Plist stále nese starý `--followers` seznam (jen fallback, durable skupina má 6).

### 2026-09-18 17:50 — Claude: mrtvá Tradovate session ožívá až s novým tokenem → worker si obnovu vynutí (čeká na reinstall)

**Nález (uživatel odmítl „je to Tradovate" bez důkazu, právem):** Vercel log
`pilot-lease` ukazuje, že server obnovil access tokeny Tradeify a FundedNext
v 15:31:20–21Z (worker si vyžádal lease, token měl < 35 min). Staré tokeny
vypršely 15:41:2xZ a přesně tehdy Tradovate zavřel oba sockety. Reconnect s
novými tokeny 39× skončil sync timeoutem, REST s týmiž tokeny vracel z Vercelu
408. V 16:41:28/39Z si worker vyžádal lease znovu (token < 10 min), server
vydal třetí token a reconnect v 16:42:15Z prošel napoprvé. Lucid s tokenem z
15:16Z běžel celou dobu. Závěr: session svázaná s tokenem z 15:31 byla na
straně Tradovate mrtvá; nová session (nový token) ji nahradila. Bez zásahu to
trvá do přirozeného okna obnovy, tedy až hodinu. Breach FundedNext s tím
nesouvisí (Tradeify breach nebyl, umřel stejně).

**Oprava (commit v tomto zápisu, worker + server):**
- `services/tradovateBroker.ts`: `onSessionSuspect({ reason:'sync-timeout',
  consecutive, at })` — počítá sync timeouty v řadě, nuluje po dokončeném syncu.
- `services/copierSessionRenewalPolicy.ts`: práh 2 timeouty v řadě, cooldown
  5 min na spojení. Test.
- `scripts/copier/pilot.ts`: `sessionSuspectHandler` → `context.forceTokenRenewal()`
  (jen párované zařízení), log `SESSION RENEWAL conn:x …`. Broker sám nic
  neposílá; příští reconnect vezme nový token z provideru.
- `server/macCopierDevice.ts`: `refresh({ forceRenewal: true })` → tělo
  `{"forceRenewal":true}`; běžící obyčejná obnova se nejdřív nechá doběhnout.
- `api/tradovate/oauth/pilot-lease.ts`: `forceRenewal` jen s device auth;
  token mladší než 3 min se znovu neobnovuje (brzda proti smyčce); obnova přes
  `getValidTradovateAccessToken` s validitou 81 min (> životnost 80 min), takže
  nový token dostane i Vercel (live-pnl). Testy API, provideru i brokeru.

Očekávaný efekt: dnešní 61min výpadek by trval ~2–3 min (dva sync timeouty
po 45 s + obnova). Server část je v produkci po pushi; worker po reinstallu.

**Dodatek 18:20 — co příčinu NEvysvětluje a co se má sledovat:** Lucid token
byl obnoven stejnou cestou v 15:16Z (starý vypršel 15:26Z) a jeho socket se v
15:26 nezavřel; zavřel se až v 15:41:04Z spolu s ostatními (Tradeify 15:40:58Z
socket-error, FundedNext 15:41:04Z socket-error, Lucid socket-close). Zavření
tří socketů v jedné minutě tedy nebylo vypršením tokenů, ale událostí na
straně Tradovate; po ní byly sessions tokenů vydaných 15:31Z mrtvé (authorize
nebo sync neodpověděl, REST 408) a session tokenu z 15:16Z v pořádku. Broker
dosud nelogoval close kód ani fázi handshaku → doplněno: `WS CLOSE state code
reason clean socketAgeS`, `WS AUTHORIZED afterMs`, `WS SYNC TIMEOUT
phase=authorizing|syncing`. Příště z toho půjde poznat, zda Tradovate zavírá s
kódem (1008 policy / 4xxx) a zda mlčí už authorize (token/session) nebo až sync.

### 2026-09-18 16:50 — Claude: mrtvé OAuth spojení bez účtů nesmí držet kopírku v „nepřipojeno" (čeká na reinstall workera)

**Co se stalo:** od 15:41Z Tradovate neobsluhuje sessions Tradeify (53157614)
a FundedNext (7cce8c5b): socket se otevře, `user/syncrequest` nikdy nedoběhne
(45 s), REST `/account/list` a `/order/list` vyprší po 45 s, Vercel dostává na
stejných tokenech HTTP 408. Lucid (leader + 4 followeři) běží celou dobu.
Tokeny jsou platné (obnova 15:31Z), worker nepadá (běží od 10:51Z), lease ani
relay dnes nevypršely — chyby `mac-copier-lease-timeout` ve stderr jsou ze
včerejší crash smyčky. Status page Tradovate hlásí vše OK. Čtyři pokusy o
zapnutí (15:57–16:00Z) worker odmítl po 45 s čekání na sync; relay TTL 30 s →
UI „worker příkaz včas nepotvrdil". Nic se nezapnulo.

**Chyba k opravě (uživatel: „tu chybu musíme opravit"):** FundedNext spojení
už nemá žádné účty (propka je po breachi odebrala, skupina je 15:33Z přestala
obsahovat), přesto ho `createBrokerRouter` počítal do agregátu `connected`
(každé spojení muselo být připojené) a jeho transport chyby šly do controlleru.
Takové spojení by kopírku blokovalo i po návratu Tradeify a Lucidu.

**Oprava (worker, čeká na „nasaď"):**
- `services/brokerRouter.ts`: agregát `connected` počítá jen spojení, která
  nesou aspoň jeden účet skupiny; spojení bez účtů si jen pamatuje stav
  socketu, chyby ani entity nepropouští; `replaceRoutes` agregát přepočítá
  (vyprázdněná mrtvá routa ho uvolní, znovu osazená ho hned zase drží; zadržené
  chyby z reconnect lhůty se zahodí). Testy v `tests/brokerRouter.test.ts`.
- `scripts/copier/pilot.ts`: start workera přežije spojení, jehož adresář
  účtů zůstane nečitelný po celém 10min retry budgetu — startuje bez účtů
  (nic se na něj nesměruje); účet skupiny, který tam bydlel, nahlásí
  routing/preflight jako chybějící a ARM zůstane blokovaný. Bez toho by
  reinstall při mlčícím FundedNext skončil v launchd crash smyčce.

**Co to neřeší (rozhodnutí pro uživatele):** výpadek follower-only spojení,
které účty skupiny NESE (dnes Tradeify), pořád po 10 s lhůtě shodí ARM celé
skupiny (`transport-lost`). Alternativa = izolovat jen followery na mrtvém
spojení (jako breach/reject) a nechat skupinu ARMED pro ostatní; je to změna
bezpečnostní sémantiky, neudělal jsem ji bez potvrzení.

**Reinstall:** brána bezpečného skriptu vyžaduje `connected` → možné až po
návratu Tradeify. Doporučení: před reinstallem odebrat FundedNext z
`connections.json` (manifest) — spojení bez účtů je v workeru zbytečné.

### 2026-09-18 15:40 — Claude: odebrání nedostupného followera z řádku nikdy neprošlo validací

**Symptom:** po breachi FundedNext účtů (14:17Z „liquidation only due to low net
liquidating value") byly všechny FNFTCH účty v LIVE „Nedostupný účet". Klik na
odebrání jednoho z nich otevřel dialog (převzetí odpovědnosti za neověřenou
kopii z epochy 5deacf15), ale uložení selhalo: plán odebíral jen požadovaný
účet, ve skupině zůstali další nedostupní followeři a `validateCopyGroup`
vrátil „Follower účet … není dostupný" → „Změna nebyla uložena". Relay ani
worker žádný příkaz nedostaly (ověřeno v `tradovate_copier_commands` a logu
workera), takže selhání bylo čistě klientské.

**Oprava:** `unavailableFollowerRemovalPlan` odebírá vždy všechny nedostupné
followery (řádek, editor i zapnutí se chovají stejně; diff v dialogu je
vypisuje všechny). Parametr `requestedAccountIds` zrušen. Test v
`tests/liveCopyUnavailableFollowerRemoval.test.ts`.

**Stav workera v tu dobu (nezměněno, k rozhodnutí operátora):** DISARMED,
connected, `reconciliationRequired=true`, lastError 14:16:44Z „follower
65839434 má autoritativně pozici -25 na MNQZ6, leader 0"; exposure po
14:17:08Z bez pozic. Worker odmítá `update-group`, dokud běží
recovery/reconciliation → po nasazení je nutné nejdřív spustit Kontrolu pozic.
Všech 11 followerů nese durable ownership marker epochy 5deacf15.

### 2026-09-18 12:40 — Claude: lehké načtení deníku (banner „Data deníku čekají na obnovení")

**Symptom:** po delším pozadí na telefonu/webu zůstal viset banner „Data deníku
čekají na obnovení — zobrazuji poslední známá data … Obnovuji…". Příčina změřená
na produkci: `get_dashboard_data` vracel **12,7 MB za 7,8 s** (3 720 obchodů);
klientský limit 20 s na pomalé mobilní lince nestačil a recovery smyčka to
opakovala pořád dokola. Rozklad velikosti: analytická pole obchodů
(counterfactual, entryContext, excursion, aiSuggestions, executionPath,
entryMap, visionAnalysis) 3,9 MB, **avatar profilu 3,7 MB** (base64 JPEG
z telefonu uložený v `profiles.avatar_url`, cestoval s každým načtením).

**Řešení (commit cbbdc17, migrace `20260918120000_dashboard_light_and_trade_analytics.sql`
nasazená přes `db query -f` + `migration repair`):**
- `get_dashboard_data_light_v1` — stejná data bez sedmi analytických polí a
  s avatarem odloženým, když má přes 256 kB (`avatar_deferred: true`).
  Změřeno jako přihlášený uživatel: **5,1 MB / 1,7 s**. Starý
  `get_dashboard_data` zůstává (nikdo ho už z webu nevolá).
- `get_trade_analytics_v1(p_trade_ids uuid[] default null)` — odložená pole,
  RLS invoker. Lab a AI kouč si je dotáhnou jednou za session
  (`storageService.getTradeAnalytics`) a dostávají obchody sloučené na čtení
  (`lib/tradeAnalyticsMerge`); hlavní stav `trades` se nemění, detail obchodu
  čte celý řádek jako dřív. TradeHistory potřebuje jen `excursionComplete`,
  které zůstává.
- Stránkovaný fallback: 500 řádků na stránku (dřív 100) bez analytických polí;
  limity požadavků 20 s → 45 s, deadline obnovy na pozadí 60 s → 90 s.
- Banner nově ukazuje důvod posledního selhání (`cloudRefreshError`).
- Avatar: nahrání v profilu zmenší obrázek na 256 px JPEG
  (`lib/avatarImage.downscaleAvatar`); odložený avatar drží poslední známý
  (`mergeDeferredAvatar`, cache v localStorage) a dotáhne se po prvním
  vykreslení; `saveUser` odmítne přepsat uložený avatar placeholderem.

**Co zbývá / rozhodnutí pro uživatele:** stávající avatar v DB má pořád 3,7 MB —
stačí ho jednou znovu nahrát v profilu (nový upload se zmenší), nebo ho
nechat zmenšit z DB (je to změna uživatelských dat, neudělal jsem to sám).
Worker se neměnil (jen web + SQL). Testy 3 747/3 747, tsc, build OK.

**Dodatek 12:45:** uživatel nahrál nový avatar, ale v DB zůstal starý — API logy
Supabase (edge_logs) neukazují žádný POST na `profiles` (jen GET), takže zápis
z klienta vůbec neodešel. Modal profilu přitom hlásil „Profil byl úspěšně
aktualizován" bez ohledu na výsledek (`onUpdate` se nečekal). Opraveno: modal
čeká na zápis a ukazuje důvod selhání, `saveUser` bez session vyhazuje chybu
místo tichého návratu, po zmenšení avataru se loguje velikost.

### 2026-09-18 10:15 — Claude: LIVE bere pozice a příkazy z heartbeatu workeru (čeká na reinstall workera)

Uživatel: „udělej i ty pozice z heartbeatu workeru". Dosud web/telefon četl
pozice a příkazy jen přes Vercel `live-pnl` z Tradovate REST (pomalé, 502/504
při zatížení, hlavní zdroj API spotřeby).
- **Worker**: `controller.exposure.orders` — aktivní příkazy účtů skupiny
  z cache `liveOrdersByAccount`, plněné z `order` událostí streamu
  (`rememberLiveOrder`, terminální stav položku odebere) a z úplných broker
  čtení při reconciliation/recovery (`rememberLiveOrderSnapshot`). Jen pro
  read-only status; execution z ní nevychází. `listOrders` brokeru je REST,
  proto se neptá přímo.
- **Web** (`lib/tradovateWorkerExposureOverlay.ts`): v LIVE desku se nad
  `live.data` položí `overlayWorkerExposure(data, agentStatus,
  agentStatusObservedAt)`: účtům skupiny nahradí pozice a příkazy z
  heartbeatu, `readState.positionsAsOf/ordersAsOf` = čas heartbeatu,
  coverage available/empty. Podmínky: heartbeat ≤ 8 s, `connected`, blok
  `exposure` existuje; jinak se vrátí původní REST data beze změny (starší
  worker bez `orders` nechá REST příkazy). Zůstatky a P&L se nemění; účty
  mimo skupinu nedotčeny. Průměrná cena pozice se převezme z REST, worker ji
  nezná.
- Efekt: pozice v LIVE jsou čerstvé, dokud worker žije (heartbeat každou
  sekundu), nezávisle na Tradovate REST latenci; „Neověřeno" jen při
  odpojeném streamu. Redukce `live-pnl` pollingu (P&L) zatím ne.
- Testy: `tradovateWorkerExposureOverlay.test.ts` (10), rozšířený test
  expozice v controlleru (order → heartbeat → cancel). Pozor při hromadném
  přejmenování `live.data`: v desku existuje i `live.dataEnrichmentPending`.
- **10:55Z worker reinstalován** (Claude, brána prošla: DISARMED, flat,
  čistý), bundle 731d3419… z acd6741; po startu reconcile čistý, heartbeat
  nese `exposure.orders`. Celá sada 3740/3740, build OK.

### 2026-09-18 08:30 — Claude: LIVE ukazuje poslední známé pozice místo „Pozice neověřena"

Uživatel: po delší době v pozadí (telefon/web) všude „Pozice neověřena". Příčina:
`liveReadFreshness` považuje čtení za ověřené jen do 45 s a buňka pozic
místo dat vykreslila varování; pozice čte web přes Vercel `live-pnl` z
Tradovate REST (ne z workeru), live hook nereagoval na návrat do popředí a po
jediném `429` čekal paušálně hodinu (server i klient). Změny (jen web/server,
worker beze změny):
- Buňka pozic a metriky LIVE desku vždy ukážou poslední známý stav; štítek
  „před 3 min" / „nedostupné" jen u čtení staršího než 2 min nebo
  nedostupného (`LIVE_READ_STALE_MS`, `liveReadStaleLabel`). Ověření do 45 s
  zůstává vnitřně beze změny (risk logika se neopírá o zobrazení). Neověřené
  čtení nikdy netvrdí flat ani nehodnotí ochranu: prázdná buňka nese tichý
  „?", pilulka místo štítu/„bez SL" neutrální „?" (test
  `liveCopyPositionsRender` z 9/2026 upraven na nové chování).
- Live hook čte hned při `visibilitychange` (návrat z pozadí), s guardem pro
  testovací `document` bez event API.
- `429`: server posílá `retryAfterMs` z `p-time`/`Retry-After`, bez hintu 5 min
  místo hodiny; klientský fallback také 5 min.
- Testy: `liveReadFreshness.test.ts`, `copyTradePositionsCellRender.test.ts`,
  3× 429 v `tradovateLivePnl.test.ts`.
- Nezměněno (další krok, až bude čas): brát pozice primárně z heartbeatu
  workeru (`controller.exposure`, každou sekundu) a Tradovate REST přes
  Vercel nechat jen jako zálohu — sníží API zátěž i závislost na REST latenci.

### 2026-09-18 06:40 — Claude: Mac companion dostává skutečnou expozici (čeká na reinstall workera)

Uživatel: „proč mi Mac panel píše Expozice neověřena / Potvrzení followerů
nedostupné?" Od 2. 9. (4b821bc) plnil `/api/mac-companion/status` blok
`exposure` natvrdo `null`, protože heartbeat workera nenesl pozice ani
per-follower potvrzení. Na žádost doplněno:
- **Worker** (`CopierControllerStatus.exposure`): `verifiedAt` = max(čas
  poslední úplné broker kontroly při reconciliation/recovery, poslední
  Position entita ze streamu), `positions` = nenulové pozice všech účtů z
  `positionsByAccount`, `followers` = per follower shoda s očekávanou
  expozicí (divergence, working orders, breached/DLL, neověřená pozice,
  cut a záměrné potlačení jako `ok` s vysvětlením). `null` bez úplné
  kontroly v tomto běhu nebo při odpojeném streamu.
- **Server** (`macCompanionStatus.ts`): striktní parse; pozice do DTO jen
  leaderovy (panel nemá pole účtu, followeři jdou přes `followerAck` s
  redigovaným „Follower N"), `accountsWithWorkingOrders` z known evidence,
  cokoli vadného → původní `null` (nikdy „flat" bez důkazu). Mac aplikace
  DTO už dekóduje (`ExposureDTO`, `FollowerAcknowledgementDTO`), Swift beze
  změny. Reducer: ověřeně flat DISARMED → `disarmed` místo `unknown`.
- Testy: 3 nové v `macCompanionStatus.test.ts` (naplněná expozice, ověřeně
  flat, 6 malformed variant), 1 v controlleru (null → po reconcile → po
  vstupu → null při odpojení). Web nasazen pushem (2461613).
- **05:58Z worker reinstalován** (Claude na žádost uživatele, který není u
  PC; první pokus brána zastavila kvůli živému ARM 05:52Z, po DISARM prošel):
  bundle 00787140… z 2461613, po startu reconcile čistý, DISARMED, flat.

### 2026-09-17 21:45 — Claude: sjednocení synchronní varianty, vazba na epizodu, groupId ve Flattenu, limity 45 s (čeká na reinstall)

Uživatel potvrdil sjednocení; druhý Claude (review) našel dvě mezery, obě
opraveny:
- **Původ rejectu**: `BrokerOrderAck.policy` značí interní blok
  (`exposureCappedBroker` / maxContracts), outbox položka nese
  `rejectedBy: 'broker' | 'policy'` (runner i async `recordAccountRejection`).
  Vyřadit followera smí jen verdikt brokera; policy blok zůstává kritický
  (`order-blocked`, fail-closed) — stávající maxContracts testy beze změny.
- **Synchronní cesta** (`failClosedOnCriticalAudit`): skupina se nevypne jen
  když VŠECHNY kritické položky dávky jsou brokerem odmítnuté vstupy
  followerů, kteří jsou podle známého snapshotu flat, položka patří k této
  dávce (`leaderEventId`) a pro účet+symbol nic neběží (žádné
  planned/sending/unknown/acknowledged). Jinak fail-closed + auto-close
  jako od 20. 8.
- **Asynchronní cesta** svázána s epizodou: jen otevřená
  `leaderExposureEpoch` a jen její `leaderEntryOrderIds`; vysvětlí se
  pouze konkrétní odmítnuté položky (ne vše téhož účtu); reject starší
  15 min nebo mimo epochu = fail-closed.
- **Relay**: `findInFlightFlatten` vyžaduje shodu `groupId` (a u
  flatten-account i účtu). Flatten skupiny B se nikdy nepřichytí ke skupině A.
- **Limity**: 19:30Z Tradovate REST (`/account/list`, `/order/list`)
  odpovídal >15 s — z Macu i z AWS (Vercel `live-pnl`: 1 timeout z 5 000
  volání 19:12–19:29Z, poté 40 za 9 min). Worker s 15s REST a 20s sync
  limitem točil reconnect (`socket-message-error`), ARM nešel. REST default
  a `WS_SYNC_TIMEOUT_MS` → 45 s; heartbeat guard během handshaku nesmí
  předběhnout sync limit. Pomalý ≠ mrtvý; 45 s stále brání pětiminutovému
  visení eventTailu.
- Korekce dřívějších zápisů: „Tradovate zavřel WS" bylo z workeru odvozeno,
  ne ověřeno; večerní zpomalení 19:30Z je první případ potvrzený i z AWS.
- Ověření: testy brokeru/controlleru/relay zelené, tsc/eslint čisté (celá
  sada viz commit).
- **18. 9. 04:04Z**: Tradovate od půlnoci v pořádku; read-only reconcile
  uzavřel nedokončenou epochu leadera (automatická kontrola ji přeskakovala),
  uživatel reinstaloval worker z 40737f8 (bundle 2fb31a43…, obsahuje
  sjednocení, vazbu na epizodu i 45s limity), po startu reconcile čistý,
  DISARMED, flat, streamy i journal v pořádku.

### 2026-09-17 21:00 — Claude: odmítnutý follower už nevypne skupinu (nasazeno na main)

Uživatel: „Lucidy se neotevřely kvůli max 20 MNQ, ostatní ano, kopírka se
vypla a obchod jsem nemohl managovat." Nález: 16:11:33Z Tradovate odmítl
vstupy čtyř Lucid followerů (`Your maximum position limit has been met …
Rule #3968`), brackety odmítl také (žádné osiřelé nohy). Za 1 s
`verifyFollowerMagnitude` viděl follower net 0 vs. očekáváno 25 →
`failClosed` bez auto-close: skupina DISARMED, sedm otevřených kopií bez
řízení exitů (leader vystoupil 16:31Z, followery zavíraly jen jejich
brackety). Fail-closed byl tu špatná odpověď: reject vstupu není nejistota.
- **Oprava (asynchronní cesta = dnešní případ)**: flat follower, jehož jediný
  outbox záznam pro symbol je definitivně odmítnutý vstup ve směru leadera
  (nic pending/acknowledged/unknown, reject ≤ 15 min), se vyřadí z epizody
  stejně jako propkou zlikvidovaný účet: záměrné potlačení vstupu
  s povolenou pozicí 0 (exity se přeskočí, další epizoda ho zase zapojí),
  odmítnuté položky se označí za vysvětlené (ne stuck), ochranné nohy se
  uklidí, audit `skipped`, skupina zůstává ARMED. Test: „asynchronně
  odmítnutý vstup followera (dnešní Lucid případ)" — follower 300 dostane
  exit, 200 nic, `armed: true`, `stuckOutbox: false`.
- **Neopraveno (čeká na rozhodnutí)**: synchronní varianta — broker odmítne
  vstup už v dispatch dávce → `failClosedOnCriticalAudit` dnes vypne skupinu
  a auto-close zavře všechny kopie (followeři nezůstanou bez dozoru, ale
  kopírka je pryč a leader obchoduje sám). Připravená změna (jen definitivní
  rejecty flat followerů se známým snapshotem pozic se vyřadí, cokoli
  jiného zůstává fail-closed) byla zablokována bezpečnostním klasifikátorem
  jako oslabení fail-closed cesty; uživatel rozhodne.
- Ověření: 177 testů dotčených souborů, tsc čistý mimo `extension/`, eslint 0.
- **Worker reinstalován uživatelem 19:12Z** přes `mac-reinstall-safe.sh` z
  aa0c83f (bundle 3ae56cef…): brána prošla (stuck operace vyřešeny v LIVE),
  po startu connection-recovery sama potvrdila flat/no-active, streamy všech
  tří loginů připojené, journal `recording`, DISARMED, bez chyby.

### 2026-09-17 19:15 — Claude: „dnešek byl extrém" — oprava celého řetězce (2db341c, web nasazen, worker čeká na reinstall)

Uživatel: kompletní research a oprava všech dnešních bodů. Řetězec a opravy:
- **REST brokeru bez deadline** (kořen zamrzlých risk snímků `stale-snapshot`
  20+ min po návratu streamu i pomalé recovery): hung fetch držel eventTail
  až 5 min (undici default). `restRequestTimeoutMs` 15 s na celé volání
  včetně těla (`tradovateBroker.requestRaw`). Test
  `tradovateBrokerRestTimeout.test.ts`.
- **Nouzový Flatten** (5/12): čtení (positions/orders/lookup) se po
  timeoutu/síti/5xx/429 opakují s prodlevou 1→5 s v rozpočtu 60 s; účty
  s přechodnou chybou projdou znovu se stejným operationId (durable outbox
  brání druhému odeslání) až do celkového deadline 180 s; nativní liquidate
  po `indeterminate` se pošle znovu jen stavově: čerstvé čtení pozici stále
  ukazuje, na symbolu neběží žádný Market close, nejvýše 2 pokusy
  (`flattenLiquidateAttempts`). Zápisy se nikdy neopakují slepě; po `submitted`
  ani `rejected` se neposílá nic. Per-call deadline 5 → 20 s.
  `copierManualActions.ts`, `copierRuntimeController.ts`; 7 nových testů +
  2 v controlleru.
- **Relay**: druhý Flatten vypršel ve frontě za 265s prvním. `flatten-group`/
  `flatten-account` se na serveru přichytí k čekajícímu/běžícímu Flattenu
  stejného cíle (`findInFlightFlatten`, okno 5 min) — UI dostane výsledek
  toho běžícího, nikdy druhou likvidaci po změně stavu. Web na risk-redukční
  příkaz čeká 240 s místo 35 s.
- **Import journalu**: souběžné importy (web, iPhone, localhost) si posouvaly
  generaci → `journal-input-changed` → restart. Lease 120 s na (user,
  connection): migrace `20260917190000_journal_import_lease.sql`
  (APLIKOVÁNA `db query -f` + `migration repair`), ostatní importéři
  dostanou `processing`. Testy vitest + `tests/sql/journalImportLease.pg.mjs`.
- **Recorder**: upload timeout 10 → 30 s; úspěšný upload vrací stav
  `recording` (dřív zůstal `degraded` navždy po jediném timeoutu).
- **Plánovaná 50min obměna WS**: onclose hlásí důvod `planned-renewal`;
  projekce mezeru zahodí, když nový socket resyncne do 60 s (sync nese
  kompletní stav, nic nechybí). Skutečné výpadky zůstávají mezerou.
- **Diagnostika**: WS authorize/sync selhání nese `s=` a text odpovědi;
  `live-pnl` mapuje timeout brokeru na 504 `tradovate-timeout`.
- `retryTransient` přesunut do `lib/` (sdílený s jádrem copieru).
- Ověření: cílené 343 + celá sada 3706/3707 (jediný pád = kolize testu
  observeru s `ms === 20_000`, REST default proto 15 s; po opravě zelený),
  tsc čistý mimo `extension/`, eslint 0, `vite build` OK, PGlite SQL 4/4.
- **Mezitím (16:05–16:32Z)**: uživatel znovu ARMoval, 16:11:32Z leader long
  25 MNQ; 4 Lucid followeři odmítnuti prop limitem („Fungible Exposed 2",
  Rule #3968) → `follower-position-mismatch` fail-closed 16:11:34Z (správně).
  Tradeify/FundedNext kopie dostaly brackety; leader vystoupil 16:31:06Z,
  všech 12 účtů flat do 16:31:53Z (journal evidence). Worker teď:
  DISARMED, divergentní Lucid followeři, stuck outbox (4× rejected) —
  reinstall workera (bundle s těmito opravami) vyžaduje nejdřív v LIVE
  označit stuck operace za vyřešené + Kontrola pozic, pak
  `scripts/copier/mac-reinstall-safe.sh`.
- **Nezměněno záměrně**: DISARM při ztrátě transportu (fail-closed design);
  následné leader exity při DISARMED se nekopírují — brackety followerů u
  brokera jsou jediná ochrana; auto re-ARM bez důkazu nezavádíme.

### 2026-09-17 18:10 — Claude: výpadek Tradovate uprostřed obchodu, Flatten All 5/12 (jen analýza, bez změny kódu)

- 15:37Z leader short 7 MNQZ6, 11 followerů s native OSO brackety, ARM od
  15:29Z. 15:43:43Z padly WS všech tří loginů naráz (příčina na straně
  Tradovate/trasy neověřena; z AWS REST v tu dobu fungoval); každý
  reconnect prošel authorize i syncrequest (stav `syncing`) a pak server
  15 s mlčel (`heartbeat-timeout`); REST téže doby: `stale-snapshot`,
  `fetch failed`. Status Tradovate hlásil vše UP; síť Macu i procesu v
  pořádku (test stejnou node binárkou: REST 0,35 s, WS „o“ ihned).
  Stejný vzor jako dnešní 05:35Z, 08:52Z (jen Lucid), 13:40Z a 14:03Z
  (`sync-timeout` před zvýšením limitu na 20 s). Streamy se samy vrátily
  15:54:45Z (11 min); FundedNext 7cce8c5b padá znovu od 16:03Z.
- Copier při ztrátě transportu správně DISARM (`transport-lost`, 15:43:50Z);
  po návratu zůstal DISARMED s `reconciliationRequired` (fail-closed, žádný
  auto re-ARM). Leader zavřel ručně ~15:57Z (−7 USD).
- **Flatten All 15:57:13Z**: zavřeno 5/12 (Lucid leader + 4 followeři,
  15:57:20Z). Tradeify 2 + FundedNext 5 selhaly: `Flatten broker request
  timeout (positions <acct>, 5000 ms)` — nouzový flatten čte pozice přes
  REST s 5 s deadline (`withEmergencyDeadline`, copierRuntimeController
  ~3316) a Tradovate REST těch loginů odpovídal pomaleji. Příkaz běžel 265 s,
  druhý Flatten (15:58Z) vypršel ve frontě (`command-expired`). Followeři
  uzavřeni ručně v Tradovate účet po účtu: Tradeify 15:58:51Z, FundedNext
  16:01:00Z, 16:03:15Z, 16:04:01Z, 16:04:12Z, 16:04:18Z (ověřeno journal
  evidencí: netPos 0 + fill 7 ks). Mezi zrušením bracketů (16:02:40–48Z) a
  uzavřením byly tři účty ~1,5 min bez SL — ruční postup, ne copier.
- Vercel `live-pnl` vrací 502 (`tradovate-live-pnl-failed`) 167× za
  20 min — serverové REST k Tradovate selhává stejně; `copier_account_snapshots`
  FundedNext zamrzly 15:55:19Z.
- **Návrh (čeká na rozhodnutí uživatele)**: nouzový flatten nesmí vzdát po
  jednom 5s REST timeoutu — prodloužit deadline (20–30 s) a opakovat čtení
  pozic/liquidateposition po dobu života příkazu; relay TTL Flattenu (30 s)
  prodloužit, aby druhý pokus nevypršel ve frontě. Bezpečnostní kód → jen
  po výslovném „udělej“.

### 2026-09-17 17:45 — Claude: pomalé API po nasazení = retry bouře importu journalu (6a5379a + 3ecebdc, nasazeno)

Po 7ffaaf2 se copier stále nedal zapnout („leader nedostupný", „Neověřeno",
`command-expired`): relay (3 s) a lease (10 s) vypršely, protože KAŽDÁ trasa
Vercel API čekala desítky sekund na PostgREST pool („Timed out acquiring
connection from connection pool"). DB přitom byla téměř nečinná.
- **Příčina 1 (6a5379a)**: `read_journal_input_snapshot` sestavil, seřadil
  a zahodil celou množinu entit+retained (44 000 řádků na připojení) na
  KAŽDÉ stránce; jeden import = ~180 stránek po 1,2 s, tři připojení a více
  klientů naráz vyčerpaly pool. Migrace `20260917153000`: výrazové indexy
  na `('e:'||entity_key) collate "C"` / `('r:'||event_id) collate "C"`,
  funkce čte dvě ohraničené stránky a slije je — stejný obsah i pořadí
  (ověřeno v PGlite porovnáním všech stránek), 1,2 s → ~0,2–0,4 s.
  Relay timeouty 3/10 s → 20/30 s. ARM prošel 15:29Z.
- **Příčina 2 (3ecebdc)**: i po indexech ~1 100–1 600 rollbacků/s a 6–8
  PostgREST sessions `idle in transaction (aborted)` na téže funkci.
  Diagnostická varianta (15 s, zápis volajících do dočasné tabulky místo
  výjimky) ukázala: `service_role`, user-agent `node`, AWS IP = Vercel
  `journal-import`, `p_generation` o 6–20 za hlavou. `journal-input-changed`
  se vyhazovalo s SQLSTATE **40001** (serialization_failure) a HTTP vrstva
  40001 automaticky opakuje — se stejnou zastaralou generací, tedy donekonečna
  po dobu života invokace. Smyčky se zastavily v okamžiku, kdy funkce
  přestala 40001 vyhazovat. Migrace `20260917154500`: stejná funkce, errcode
  **55000**; zpráva i mapování v `journalIncrementalInput.ts` beze změny;
  dočasná `journal_input_diag` smazána. Po nasazení 15:41Z: rollbacky
  11 048 987 → +1 za 35 s, 0 busy PostgREST sessions, heartbeat 0,3 s,
  API ~70 ms. Obě migrace aplikovány `db query -f` + `migration repair`
  (`db push` zůstává zakázán).
- **Ponaučení**: 40001 patří jen skutečným serializačním konfliktům, kde
  opakování stejného požadavku může uspět. Stále 40001 používají
  `backtest_review_atomic_patch`, `tag_library_atomic_commit`,
  `private_trade_note_history`, `legacy_notes_privacy` (CAS z prohlížeče,
  jednorázová volání — pár zbytečných pokusů, ne smyčka; neměněno).
- **Otevřené**: souběžné importy jednoho připojení si navzájem posouvají
  generaci (časté `journal-input-changed` → celý import od začátku) —
  serializovat import per připojení; 10 s timeout uploadu journalu dělá
  z recorderů `degraded` (šum, zápis probíhá); plánované 50min WS obnovy
  tvoří 2s mezery, které označí otevřené epizody jako neúplné.
- Worker: bundle 7028a177 (7ffaaf2), connected, reconciled, ARM od 15:29Z
  (expirace 19:00 Chicago). Bez reinstalu.

### 2026-09-17 17:00 — Claude: worker přežije pomalý Tradovate při startu (7ffaaf2, nasazeno)

Po Codexově `9e3d09c` (lease timeout 10→60 s, worker zastaven) uživatel
předal dokončení mně. Kořen dnešních pádů: Tradovate potřeboval 17–61 s na
obnovu tokenu a >5 s na WS sync; pevné limity workeru z toho dělaly tvrdé
chyby při startu (proces skončil, launchd ho 40× restartoval).
- `server/retryTransient.ts`: ohraničený retry jen pro přechodné chyby
  (timeout, síť, 408/425/429/5xx, `tradovate-pilot-lease-failed`); auth,
  identita, dešifrování, `expired` jsou finální. Rostoucí prodleva 5→60 s,
  deadline 10 min, pak chyba probublá jako dřív (stále fail-closed).
- `createMacCopierDeviceTokenProvider`: 120 s na požadavek, retry jen když
  není použitelný token (start); s platným tokenem jediný pokus a fallback
  jako dřív (ověřeno stávajícím testem). Nespárované zařízení retry nemá.
- Pilot: `loadTradovateAccountData` při startu se stejným retry a logem
  `STARTUP …`; `syncTimeoutMs` 5 → 20 s pro agent brokery (reconnect backoff
  zůstává). Nové testy `tests/retryTransient.test.ts` + 2 v
  `tests/macCopierDevice.test.ts`.
- Ověření: 3686/3686, tsc čistý mimo `extension/`, web build, esbuild bundle.
  Push 7ffaaf2 na main (Vercel auto-deploy), reinstall workeru z téhož
  stromu s `--adopt-durable-group` (záloha
  `/private/tmp/alphatrade-release-7ffaaf2-20260917/before`), start
  DISARMED. Codexův 120s návrh nebyl nikde uložený, nahrazuje ho tato změna.

### 2026-09-17 odpoledne — Claude: výpadky Tradovate, restart workeru a předání Codexovi

- 15:35 ARM prošel (0,8 s). 15:40:23 padly WebSockety všech tří loginů ve
  stejnou sekundu; každý další pokus prošel TCP/TLS, ale `user/syncrequest`
  nedoběhl do 5 s (`syncTimeoutMs` default) → smyčka reconnect/sync-timeout,
  kopírka fail-closed DISARMED. Produkční preflight Lucid loginu 502 po 10–13 s,
  Tradeify/FundedNext REST v pořádku. Dva ARM pokusy (15:41, 15:47) vypršely po
  5 min bez potvrzení workeru („Mac worker příkaz včas nepotvrdil“).
- 15:53 jsem na žádost uživatele provedl `launchctl kickstart -k` (runtime
  DISARMED, všech 12 účtů nezávisle ověřeno flat/no-working). Start v 15:56:32
  se připojil, reconciliace prošla, ARM 15:57:41 OK. 15:58:36 vstup short 3
  MNQZ6 na 11 followerů s nativním OSO (SL 29 682,25 / TP 29 555), posuny SL
  16:01 a 16:03 OK. 16:03:46 opět pád Lucid WS → DISARM „unknown“; SL u brokera
  se vyplnil sám na všech účtech (~−230/−238 USD/účet), flat sweep pak jen
  nestihl potvrdit zrušení už neexistujících noh (deadline 1 500 ms). V 16:07
  vše flat bez working orders.
- **Vedlejší účinek restartu (zjistil Codex):** worker se po mém kickstartu
  dostal do havarijní smyčky (40+ startů): lease požadavek na produkční API
  trval 17–61 s (obnova Tradovate tokenu 61,4 s), worker měl limit 10 s a
  timeout shodil celý proces, launchd ho znovu startoval. Codex smyčku zastavil,
  worker je vypnutý, DISARMED, a nasadil `9e3d09c` (lease timeout 60 s);
  navrhuje 120 s + reinstall. Od této chvíle worker vlastní Codex.
- Společný kořen všech dnešních odpoledních potíží je extrémně pomalý
  Tradovate (auth/renew 61 s, sync nedoběhne do 5 s, REST 502): 5s sync
  timeout a 10s lease timeout jsou pod tímto zatížením příliš přísné a mění
  pomalost v tvrdé výpadky. Doporučení pro navazující práci: (1) timeout lease
  nikdy neshazovat proces, dokud platí stávající lease — retry s backoffem;
  (2) `syncTimeoutMs` zvýšit/adaptivně (15–20 s) a při opakovaném timeoutu
  prodlužovat backoff místo smyčky každých 5 s; (3) relay timeouty
  (`copier-relay-request-timeout`) mají stejný původ. Dnes s kopírkou dál
  neobchodovat, dokud Tradovate neodpovídá stabilně.

### 2026-09-17 — Claude: falešný BREACHED čtyř nových Lucid funded účtů (chybné čtení Tradovate risk statusu)

Uživatel: LFF…0008–0011 (nové Lucid funded účty, založené 06:45Z) se v LIVE
ukázaly jako BREACHED „net liq 50000.00 USD dosáhla drawdown flooru 50000.00“.
Lucid dashboard: 50 000 / floor 48 000, aktivní. Příčina v
`services/tradovateBroker.ts` `listAccountRiskSnapshots`: `accountRiskStatus`
`maxNetLiq`/`minNetLiq` jsou zaznamenané extrémy net liq (high-/low-watermark),
ne prahy. Kód vydával `maxNetLiq` jako net liq a `minNetLiq` jako floor →
nikdy neobchodovaný účet (obě = 50 000) splnil `netLiq <= minNetLiq` a
`classifyFollowerBrokerBreach` ho durable vyřadil (10:39Z, všechny čtyři),
což v 10:40Z ještě přispělo k fail-closed „nevysvětlená divergence“.
Důkaz: leader 0007 má maxNetLiq 52 718,5 / minNetLiq 49 300, ale Lucid floor
50 100 = `trailingMaxDrawdownLimit`; čerstvé účty 50 000 / 50 000, floor 48 000
= 50 000 − `trailingMaxDrawdown` 2 000.

- **Oprava** (`services/brokerPort.ts` `propDrawdownFloor`, `brokerRiskEquity`):
  floor = `min(highWater − trailingMaxDrawdown, trailingMaxDrawdownLimit)`,
  bez kladného trailingu nebo bez watermarku null (nikdy se nehádá ze
  startovního zůstatku). `netLiq` jen když ho transport opravdu vydal;
  `/cashBalance/deps` nese `amount` → nové `cashBalanceUsd` (u flat účtu =
  net liq). Snapshot nese i `highWaterNetLiq`, `trailingMaxDrawdownLimit`.
  Controller: breach jen když `equity (netLiq ?? cash) <= floor`;
  `propLimitUsd = dailyLossAutoLiq ?? equity − floor` (tím se opravil i limit
  „Max ztráta ≤ 95 % limitu propky“ v Risk tabu). Frontend `accountRiskFloor`
  v `lib/tradovateLiveView.ts` počítal správně už dřív; worker teď používá
  stejnou logiku.
- **Zrušení falešného BREACHED**: stav je trvalý a reconciliace ho nemění.
  `verifyAccountEligibility` (ruční „Ověřit“, nově dostupné i u BREACHED)
  ho zruší jedině s úplným broker důkazem: `classifyFollowerBrokerBreach`
  nic nehlásí, floor i equity známé, equity > floor, účet active/canTrade,
  pozice/příkazy čitelné. Jinak vyhodí konkrétní důvod. Skutečná likvidace
  (cash na flooru, canTrade=false) zůstává vyřazená — testy
  `tests/copierAccountEligibility.test.ts`, `tests/propDrawdownFloor.test.ts`,
  `tests/tradovateBrokerAccountRisk.test.ts`.
- **Postup pro uživatele po nasazení workeru**: v LIVE u každého ze čtyř
  účtů kliknout „Ověřit“; worker udělá read-only kontrolu a vrátí je mezi
  způsobilé (audit `eligibility-verify-<id>` „BREACHED zrušen operátorem“).
  Bez reinstalu workeru by ověření dopadlo stejně jako dnes.
- Ověření: cílené sady 290/290, tsc čistý mimo `extension/`, `vite build`
  a esbuild bundle OK; celá sada viz commit. Žádný ARM, broker příkaz ani
  změna skupiny. Větev `claude/journal-snapshots-copylink-20260917`.

### 2026-09-17 — Claude: zapisovač evidence bez přetečení + screenshoty followerů přes copylink

Navazuje na ranní analýzu (chybějící snímky u obchodů z 16. 9.) a review od
Codexe (dvě chyby, ne jedna). Větev `claude/journal-snapshots-copylink-20260917`
(worktree `/private/tmp/alphatrade-journal-snapshots-20260917`, základ `7f2a39e`).

- **Příčina mezer v historii**: `server/fileJournalEvidenceStore.ts` psal každou
  observaci zvlášť s `datasync`; fronta 10 000 přetekla vždy po reconnectu
  (heartbeat timeout → REST resync všech entit, 90 % byly `command` snapshoty
  z velké části totožné s předchozím stavem). Přetečení se logovalo na každý
  zahozený řádek bez časového razítka (1,3 mil. řádků `[JOURNAL] …queue-full…`
  za 15.–17. 9.), proto ho grep podle data minul. Každá ztráta = `recording-gap`
  → `connection-gap` → pozice `incomplete` → účty Lucid připojení bez obchodů
  i snímků. Poprvé 15. 9. 12:18 hned po WS heartbeat timeoutu.
- **Zapisovač**: dávkový append + jeden `datasync` na dávku (max 2 000 řádků /
  4 MB); totožná REST snapshot re-observace (stejný `entityType:id`, stejná
  entita) se neukládá (vrací `true`, aby broker accounting neresetoval);
  `positionsnapshot`/`journalbackfill`/`connection` a stream události se nikdy
  nededuplikují. Priorita: `command`/`commandreport` se zahazují už na měkkém
  limitu bez gap markeru (ztráta historie příkazů, ne pozic), pozice-kritické
  typy až na 4× limitu s `recording-gap reason=queue-full`. Ztráta se hlásí
  jednou za epizodu, s časem. Zdraví (`queued`, `dropped`,
  `droppedLowPriority`, `deduplicated`, `lastGapAt/Reason`, `lastWriteMs`) jde
  do `LocalCopierAgentStatus.journalHealth` a LIVE lišta má chip „Historie“
  jen při ztrátě (ztráta pozic = danger, projde i tichým dashboardem).
- **Vazba snímků**: worker nyní posílá u uzavřeného obchodu
  `leaderEntryOrderIds` (lot si pamatuje entry ordery), server je ukládá do
  nového sloupce `tradovate_copier_trades.leader_entry_order_ids`. Pohled
  `journal_trade_snapshots` (migrace `20260917071500`) k původní fill-identitě
  leadera přidává follower cestu: `facts.groupId`
  (`execution:demo:<leaderConn>:<leaderOrderId>`, materializovaný z copylink
  evidence follower připojení) = `any(leader_entry_order_ids)` + instrument +
  směr + vstup v okně epizody s tolerancí 2 s (Tradovate razítkuje kopie někdy
  o 1 ms dřív než leaderův fill; 13:30 a 16:12 by jinak vypadly). Order
  nárokovaný dvěma epizodami → nic. Copylink role `exit` neexistuje (jen
  entry/stop/target), řetězec přes exit fill tedy nebyl možný.
- **Backfill** (jednorázově v migraci, tři zdroje, jen NULL řádky, jen
  jednoznačný výsledek): potvrzená pozice leadera podle fill-identity →
  fill v evidenci s přesným razítkem + copylink self-link leadera → jediný
  leader order z potvrzených follower pozic v okně epizody. Na produkci
  doplněno 20/21 epizod od 12. 9.; bez klíče zůstala jen 09:28→10:04 (žádný
  follower, pozice Lucid pending). Pohled váže 42/43 obchodů z 16. 9.
- **Ověření**: SQL PGlite 47/47 (`PGLITE_MODULE=<scratch>/node_modules/@electric-sql/pglite/dist/index.js node --test tests/sql/journalSnapshotLinks.pg.mjs`),
  Vitest celá sada 3667/3668 (1 timeout `liveCopyCompactRender` pod zátěží,
  samostatně prošel), tsc čistý mimo `extension/`, `vite build` OK, esbuild
  bundle workeru OK. Migrace aplikována přes `npx supabase db query --linked -f`
  z Documents (CLI je linknuté; `db push` NEPOUŽÍVAT, lokální/vzdálená historie
  se rozcházejí) a zapsána do `supabase_migrations.schema_migrations`; rollback
  v `/private/tmp/claude-501/…/scratchpad/rollback-20260917071500.sql`.
- **Nasazení**: DB část je živá (produkční historie ukazuje snímky followerů
  hned). Web/server (ledger sloupec, LIVE chip) a worker (zapisovač, entry
  ordery) čekají na „nasaď“ — obchodní den, worker reinstall jen z čistého
  reconciled stavu. Do reinstallu vznikají nové ledger řádky bez klíče;
  doplní se stejným backfillem (migrace je opakovatelná).
- Otevřené: každý plánovaný WS renewal (50 min) otevírá 2s gap, který
  přeruší otevřenou pozici (`interrupt('connection-gap')` bez ohledu na délku);
  09:28 epizoda skončila `conflicting-position-anchors`. Netýká se snímků,
  ale historie pozic delších než 50 min.

### 2026-09-17 — Codex: prioritní nouzový Flatten All (lokálně)
Incident z 16. 9. prokázal, že ruční Flatten čekal ve stejné serializované
frontě jako leader lifecycle/SL modify; jeden visící broker call tak zdržel
nouzové zavření o několik minut. Ruční Flatten účtu i celé skupiny proto na
Tradovate nově používá samostatnou prioritní lane mimo leader processor,
reconciliation i journal. Lane vyžaduje broker-native stavové
`liquidatePosition`, zpracovává účty paralelně, potvrzuje position → orders →
position stav a každý broker call omezuje na 5 s. Timeout se nepovažuje za
úspěch ani se slepě neopakuje; účet musí být následně autoritativně flat.
Stejné operationId v jednom procesu sdílí tentýž promise. Hlavní runtime po
zásahu zůstává DISARMED a vyžaduje novou reconciliation. Adaptéry bez nativní
likvidace zachovávají původní durable serializovanou cestu.

Regrese simuluje visící follower write: běžný processor zůstane blokovaný,
ale Flatten All zavře leadera i followera a ověří oba flat. Druhá regrese
simuluje nikdy nekončící native liquidate a potvrzuje řízený timeout místo
nekonečného „Připravuji“. Ověření: 105/105 cílených testů, kompletní sada
3662/3662, TypeScript, lint změněných souborů bez chyb, `git diff --check` a
produkční build. Nebyl odeslán brokerovský příkaz, worker nebyl restartován a
změna zatím nebyla nasazena.

### 2026-09-16 — DD rezerva ve sloupci DLL u plánů bez denního limitu

Na žádost uživatele sloupec DLL u potvrzeného plánu bez DLL ukazuje stejnou
rezervu jako Rezerva DD, s označením „· DD“ a vysvětlením. Sdílí výpočet,
cache identitu, stáří a dostupnost původní DD buňky; částka není pevně 1500.
Klasifikace vychází z explicitní nuly profilu nebo známého katalogového plánu,
nikoliv z chybějícího broker limitu. Kladný efektivní DLL má stále přednost.
Není změněn risk gate, runtime ani broker konfigurace. Ověření: 33 cílených
testů včetně nulové/záporné rezervy, chybějících/denied/pending dat a priority
DLL; typecheck, scoped lint a produkční build prošly. Izolovaný statický
náhled skutečné komponenty s fiktivními účty ověřen v prohlížeči. Zatím lokální,
nasazení spolu s předchozí opravou cloudové knihovny čeká na souhlas s pushem.

### 2026-09-16 — obnova cloudové knihovny v otevřeném editoru skupiny

Při výpadku během vyplňování editor nyní přímo ukazuje příčinu a nabízí
„Znovu načíst a uložit“. Název, leader, followeři a pravidla zůstávají
v otevřeném formuláři; reload stránky ani trvalé uložení rozpracovaného
formuláře se neslibuje. Čtení má 15s timeout včetně čekání na auth, abort
a ochranu před opožděným zápisem do cache. Výslovná obnova drží write fence,
takže ji focus/online ani staré odpovědi nepřepíšou. Pokud byl konfigurační
požadavek potvrzen a selhal až cloud, nezměněný draft opakuje jen cloudový
upsert. Import starých skupin zůstává výslovný. Žádné automatické ARM ani
změny brokerových kontrol. UI s fiktivními daty ověřeno při 390×844: výpadek
čtení neposlal zápis, chyba zápisu zachovala draft, po obnově uložen stejný
název/leader/follower a formulář zavřen, bez console errors. Fyzický Safari
na iPhonu zatím neověřen. Dočasný náhled a server odstraněny. Existující
render test stale followera aktualizován na text již přítomný v HEAD 9e34d309.
Ověření: 102 cílených testů (po opravě starého textového očekávání), typecheck,
scoped ESLint a produkční build prošly. Nasazení této opravy zatím neprovedeno.

### 2026-09-15 — ARM oprava nasazena, FundedNext worker připojen

Po výslovném souhlasu push `9e34d309` na main; produkční Vercel
`dpl_Hw5Dac8pGvicTnwnpSmWPqjMWNte` READY se správným SHA a aliasem.
Záloha manifestu, bundle, LaunchAgentu a durable stavu je lokálně v
`/private/tmp/alphatrade-fn-backup-20260915-204443` (bez exportu Keychain).
FN dostalo vlastní odvolatelné spárování přes autentizovaný web; manifest
rozšířen pouze o FN, existující dvě routy i primární připojení zachovány.
Před restartem byl worker odpojený od Tradeify WS a jeho reconcile vypršel.
Uživatel výslovně schválil výjimku: restart i při tomto odpojení po novém
nezávislém GET ověření všech 12 účtů jako flat/no-working a runtime DISARMED.
Tato kontrola prošla; restart stejného bundle obnovil spojení. Následný
reconcile autoritativně čistý, všech pět FN účtů ověřeno přímo přes worker.
Skupina/risk i bundle nezměněny, 3 paired zařízení, cloud heartbeat čerstvý,
connected=true, armed=false, žádná divergence, stuck operace ani lastError.
Žádný ARM/Flatten/order/cancel; reálné kopírování tímto během netestováno.
Výpadek WS byl restartem odstraněn, jeho kořenová příčina není prokázaná.

### 2026-09-15 — připravená oprava ARM při přepnutí skupiny

- Potvrzen konflikt Hlavní cooldown 1 min versus nová FN skupina 0 min.
  ARM nyní připravuje konfiguraci se zachováním přísnějších potvrzených pravidel
  session i cílové skupiny. Neslučitelné okno či follower limity se nevymýšlejí;
  zůstávají blokované. Autoritativní relay/worker kontroly se nemění.
- Přidána kontrola, zda má OAuth připojení účtu spárovanou routu v běžícím
  workeru. Lokální worker dosud obsahuje jen Lucid/Tradeify; FN potřebuje
  samostatné schválené spárování a bezpečné načtení konfigurace.
- Známé odmítnutí se zobrazuje jako zablokované zapnutí, timeout zůstává neznámý.
  129 cílených testů, typecheck a lint prošly; dialog ověřen ve světlém/tmavém
  režimu na skutečné komponentě s mock callbackem. Žádný skutečný ARM ani broker
  příkaz. Podrobnosti: `docs/reviews/copier-group-arm-20260915.md`.

### 2026-09-15 (Codex, rozlišení Tradovate Reconnect)
Lokálně opraveno maskování odmítnutého OAuth refresh jako obecné 502 a zelené Connected. Per-connection read evidence ukazuje Obnov přihlášení + Reconnect a banner napříč LIVE; timeout/429/app-session chyby nezaměňuje za broker reautorizaci. Tradeify profily a skupina zůstávají uložené. Přesná příčina Invalid token není z existujících logů prokazatelná; riziko souběžné rotace a chybějící evidence refresh expiry popsány v docs/reviews/tradovate-reconnect-20260915.md. Přidána bezpečná diagnostika bez tokenů. Žádný deploy, DB změna, broker akce ani změna workeru.

### 2026-09-15 — Codex: FundedNext Futures v LIVE a katalogu plánů

- Prefix FNFT nyní rozpozná FundedNext i u existujících null profilů. Znovu použité logo z `public/firms/fundednext.svg` a současné komponenty; název viditelný v Připojení, účtech i kopírovací skupině. Ruční firma má přednost; rozpoznání nezapisuje profil ani nehádá plán/fázi/velikost.
- Katalog obsahuje 19 futures variant: Rapid Pro DLL ON/OFF, Rapid Daily, Legacy, Flex a označené starší Rapid/Bolt. Oficiální zdroje, omezení a datum ověření jsou v `docs/fundednext-futures-plans.md`. Evaluace/funded rozlišují consistency, profit target a kontrakty; drawdown lock je pro Legacy/Rapid na počátečním zůstatku a pro Flex/Pro/Daily/Bolt +100 USD. Bez automatického převzetí pravidel pro real-money live nebo CFD/Labs produkty.
- Tlačítko Nastavit účty u připojení nyní omezuje hromadný formulář na jeho účty, banner na účty s chybějícím plánem. FundedNext volba plánu/fáze doplní odpovídající pravidla, změna na plán bez DLL/consistency odstraní staré hodnoty i při použití na více účtů. Žádná automatická firm-wide payout šablona pro různorodé FundedNext plány.
- Lokálně prošlo 66 testů v 9 souborech, typecheck, scoped ESLint a build. Browser ověřil skutečné 3. připojení s logem, rozsah 5 účtů a neuložené hromadné změny Legacy evaluation/funded → Pro DLL ON → Flex. Formulář uzavřen bez uložení. Uživatelův konkrétní plán zatím nepotvrzen; žádný broker příkaz, zápis profilu, restart workeru ani produkční deploy. Změna připravena v izolovaném worktree `/private/tmp/alphatrade-entry-history-fix-20260914`.

### 2026-09-15 — Codex: oprava pádu LIVE po přidání prop připojení

- Nahlášený Safari stack `null is not an object (evaluating u.propFirm.trim)` přesně reprodukován v `buildTradovateConnectionSummaries`. Nový onboarding profil dovoluje `propFirm=null`; nechráněný `.trim()` zrušil render celé LIVE stránky.
- Souhrn připojení nyní toleruje nevyplněnou prop firmu a zachovává dosavadní fallback názvu organizace. Žádná změna account mappingu, dat profilu, broker příkazů ani workeru.
- Dva nové regresní testy nejprve selhaly se stejnou TypeError; po opravě prošlo 20 testů cache/onboardingu/bridge, TypeScript a produkční build. Test zahrnuje tři připojení Tradeify + Lucid + nový účet s null firmou a prázdné názvy/fallback.
- Localhost 4190 s read-only proxy vizuálně ověřen: LIVE se načetl se třemi připojeními a stávající skupinou; null prop firma již render neshodí.
- Po výslovném souhlasu uživatele nasazen commit `2e053e1c8c7780843d7f4036a30b250aaa5eaf2f`; shoda s origin/main ověřena. Vercel `dpl_2pZAPjaDeURfwUHofw6MTfyAnAKp` je READY a produkční alias vrací HTTP 200. Novější `f9b27f69` z dřívější kontroly byl pouze dependabot preview.
- Produkční browser načetl nový bundle `index-Db0tilh7.js`; LIVE i Připojení se vykreslily bez pádu, seznam ukázal 3 aktivní připojení / 12 účtů včetně nové prop firmy bez názvu. První načtení provázely samostatné chyby fetch/synchronizace a dashboard RPC timeout; nejsou důkazem selhání opraveného null trim a nejsou tímto patchem opravené. Žádné 5xx v dostupných logách nového deploymentu při kontrole. Worker ani DB se při tomto webovém nasazení neměnily; SQL migrace v parent commitu je záznam již aplikované opravy. Tento odstavec je lokální záznam po deploymentu.
- Po obnovení produkční stránky chyba synchronizace účtů zmizela; LIVE načetlo 3 připojení a stávající skupinu. Obnova historie ještě běžela, takže tento krok neověřuje dokončení journal synchronizace ani obchodní exekuci.


### 2026-09-14 — Codex: opravené propojení screenshotů přes více OAuth připojení

- Produkční `journal_trade_snapshots` již nepovažuje `tradovate_copier_trades.connection_id` za připojení zdrojového obchodu: tento sloupec označuje relay zařízení, které zde přenáší Lucid leadera přes Tradeify. Vztah určuje unikátní potvrzené závěrečné broker fill ID, přesný čas uzavření, známý čas otevření, instrument, směr a ověřený účet z dokončené journal projekce. Duplicitní/konfliktní fill nebo episode vazby se nepřipojí. RLS security_invoker zachován.
- Použita jen verzovaná migrace pohledu; žádné přepisování obchodů, ledgeru, obrázků nebo broker stavu. Původní produkční definice/granty, dry-run a návratový SQL jsou privátně v `/private/tmp/alphatrade-snapshot-link-fix-20260914`. CLI vytvořil migraci; název souboru byl následně sladěn s verzí přidělenou produkční migration history `20260914125323`.
- Ověřeno 25 PostgreSQL/PGlite regresních testů a 24 testů frontendového načítání. SQL test obsahuje reprodukci původního selhání, Lucid/Tradeify, 12 followerů, partial exit, late upload, duplicitní relay, kolize ID, špatné účty/časy/instrumenty, neúplnou projekci a autentizované RLS. Samostatné spuštění: `PGLITE_MODULE=/path/to/pglite/dist/index.js node --test tests/sql/journalSnapshotLinks.pg.mjs`.
- Produkční dry-run a následná kontrola: 0 -> 2 vazby u dnešního obchodu 12:52, žádná původní vazba odebrána. V prohlížeči potvrzeno Screenshoty (2), vykreslené AUTO ENTRY 12:52:03 i AUTO EXIT 12:53:10. Security/performance advisory žádný nový nález proti baseline.
- Oprava funguje pro existující i budoucí jednoznačně spárované obchody. Ranní obrázky, které vůbec nevznikly, se neregenerují. Worker ani Vercel bundle se kvůli této čistě databázové opravě neměnily; žádný ARM, DISARM, restart, Flatten ani brokerový test.


### 2026-09-14 — Codex: schválené nasazení opravy kopírky a screenshot capture

- Po výslovném souhlasu uživatele nasazen přesný commit `d039aa32452445faacad40778cdd1230a06949ad` včetně `86d72d2e`; origin/main ověřen. Vercel `dpl_2k1TgBDn1HPPzMqNQR37QEYjBKqb` je READY a produkční alias ukazuje na tuto verzi. Žádné změny DB schématu ani produkční konfigurace.
- Před reinstalací vznikla privátní záloha bundle, manifestu, launchd a durable state v `/private/tmp/alphatrade-release-d039aa32-20260914/before`. Read-only reconciliation před i po restartu potvrzuje všech 7 účtů flat, bez working orders/divergence/stuck outbox; connected=true, armed=false, reconciliationRequired=false, lastError=null. Nastavení skupiny zachováno přes adopt-durable-group.
- Nainstalovaný Mac bundle SHA-256 `22d09bf751a8ac2243e532a3fabc58cf6c1847d39d6372e75353c7f8ffd9217d` odpovídá předem otestovanému buildu. Worker spuštěn 11:56:01.188Z, launchd running, persistent lifetime; cloud heartbeat ověřen s věkem 1.6 s. Nové worker logy neobsahují execution chybu. Produkční HTTP 200, unauthenticated POST pilot-lease 401, žádné 5xx nového deploymentu; jeden existující Node url.parse deprecation warning v úspěšném cronu.
- Před vydáním prošlo 397 test files / 3603 tests, typecheck a build. Produkční LIVE ověřen vizuálně: 6/6 followers, vypnutá kopírka, historie zpracovaná. Graf detailu zobrazuje existující čekání na historická data Databento (přibližně 24 hodin po trhu), nikoli syntetické svíčky.
- OTEVŘENÉ: detail dnešního obchodu 12:52 ukazuje BEZ SCREENSHOTU, přestože metadata ENTRY/EXIT i oba objekty v copier-snapshots existují. Propojení obrázků do historie vyžaduje navazující opravu; toto nasazení řeší capture/durable upload, nikoli ověřené zobrazení tohoto historického případu. Neslibovat zpětnou rekonstrukci chybějících ranních snímků.
- Žádný ARM, broker order, Flatten ani broker-write test. Zelené testy, deploy a flat reconciliation nedokazují nový reálný copy lifecycle. Tento záznam je lokální evidence po deploymentu a nebyl součástí dalšího push.


### 2026-09-14 — Codex: oprava druhého incidentu a rozšířené execution regrese (lokálně)
- Opraven přenos přesně potvrzeného OrderVersion přes ExecutionReport New/Replaced, včetně obráceného pořadí, pozdních verzí, REST obnovy, odmítnutých požadavků a zachování parent/OCO vazeb. Modify/Cancel reject již neshazuje platný pracovní order; HTTP ACK ani stejná stará cena nejsou potvrzení modify.
- Standalone follower SL/TP již není nekonečný in-flight exit pro leader-flat guard. Unknown/sending/Market ochrana, vlastnictví epochy, nativní account/symbol likvidace, následné flat potvrzení a DISARM zůstávají přísné. Kompletní prázdný position snapshot odstraní starou lokální expozici.
- Redukující SL/TP po otevření nečeká na nové OSO. Samotný ručně přidaný SL bez TP těsně po fillu po korelačním okně projde samostatně jen s novým potvrzením order/pozice/epochy; cancel, DISARM a změna generace ruší odložené odeslání. Neúplné nativní pending OSO se tím nepovoluje.
- Nový HTTP/WebSocket test harness používá skutečný Tradovate adaptér + controller: fan-out 1/6/12, posuny SL, orphan exit, 12 on-fill účtů s partial 1+4+1, duplicate fills, partial/final exit, standalone SL, cancel/DISARM a přesný command ACK/reject. Celá sada 397 souborů / 3603 testů passed; typecheck/build passed, lint 0 errors (3 stávající warnings), worker bundle + syntax check passed.
- Zdroj zůstává v izolovaném worktree navazujícím na 33ea4271 a lokální screenshot opravu 86d72d2e. Žádný push, deploy, restart workeru, ARM ani broker příkaz. Podrobnosti a hranice důkazů: `docs/reviews/copier-entry-history-20260914/COPIER_RELIABILITY.md`.

### 2026-09-14 — Codex: druhý incident 12:52–12:53, pouze analýza

- Všech 7 účtů mělo potvrzený vstup. Leader posunul samostatný SL 28941,25 → 28930,50; broker potvrdil Replaced, ale 6 followerů zůstalo na původní ceně. Adaptér při ExecutionReport použije starou OrderVersion kvůli cache early-return. Pasivní zachytávání nové verze se do execution nepromítne ani po potvrzení. Reprodukováno offline na skutečném adaptéru. Větev byla změněna v journal commitu 0163c891.
- Po leader exit ochrana chybně označí stále čekající ochranný Stop za probíhající copied-exit. Guard čeká bez omezení, opakovaně hlásí fail-closed. Reálná epocha v čisté offline funkci vrací wait-inflight pro 6 účtů po 2,5 i 60 sekundách. Followery uzavřel až samostatný uživatelský flatten-group, potvrzený cca 17–18 sekund po leaderovi.
- Poslední úplné broker snapshoty potvrdily všech 7 účtů flat. Worker zůstává vypnutý, reconciliationRequired/divergence zůstaly jako stav incidentu. Oba snímky tohoto druhého obchodu byly úspěšně nahrané.
- Zdroj, produkce a worker beze změn. Žádný ARM, DISARM, Flatten ani reconcile touto analýzou. Schválení screenshot release 86d72d2e je stále nevyřízené; nebyl nasazen. Soukromé důkazy a reprodukce: `/private/tmp/alphatrade-exit-incident-20260914/ANALYSIS.md`.

### 2026-09-14 — Codex: oprava pořizování screenshotů a uchování obrázků (lokálně)

- Zachycení už nemá starý 2,5s limit sdílený s doručením; dostává maximálně 8 s v 15s okně původní události. Souběžné capture běží postupně, při novém vstupu/výstupu se neaktuální obrázek nepřiřadí ke staré události. Chyby obsahují fázi, bezpečný kód a dobu trvání; čekání na překreslení je omezené.
- ENTRY/EXIT PNG se nejdřív uloží do soukromé atomické diskové fronty. Retry po výpadku/restartu používá totožné bytes a ID, žádné opožděné focení. Původní deadline notifikace se nemění a neomezuje samotné uložení historie. Fronta je omezená, poškození/plný disk nevede k tichému smazání.
- Trvalá chyba chybějícího snímku přežije restart i další ready probe. Zobrazení v existujícím LIVE chipu se nevrátí na „Připravené“ pouhým nalezením TradingView. Obchodní controller, limity, ARM a broker příkazy beze změn.
- Ověření: kompletní 394 souborů / 3580 testů; po posledních doplněních cíleně 4 soubory / 34 testů. Typecheck, produkční web build, cílený lint a esbuild worker bundle. Podrobná evidence/hranice v `docs/reviews/copier-entry-history-20260914/SCREENSHOTS.md`.
- **Tato oprava zatím nebyla nasazena ani instalována do workeru.** Původní ranní obrázky neexistují a nebyly vymyšleny. Následuje schválení konkrétního release a oddělené produkční ověření focení. Předchozí oprava vstupu/historie 33ea4271 zůstává nasazená.

### 2026-09-14 — Codex: schválené nasazení ranní opravy a obnovená historie

- Po výslovném souhlasu push přesného `33ea4271a066de00a41e34d8ff893cb5357f1d20` na main. Vercel `dpl_4ZYCZr7i9qdmTLzea6mMfVyYSUpp` READY, produkční alias odpovídá tomuto commitu; nepřihlášený POST pilot-lease vrací 401.
- Před i po aktualizaci Mac workeru proběhla reconciliation. Kopírka byla již vypnutá a flat, bez pracovních příkazů; nebylo třeba odeslat DISARM. Záloha původního workeru/state/config je v soukromém `Documents/AlphaTrade-backups/2026-09-14-entry-history`. Instalace zachovala durable skupinu a párování.
- Instalovaný bundle SHA-256 `0f947457c2e65aea4968434811d7cd3c74c6e78907ba22c4c5dd1e1921763065` odpovídá ověřenému sestavení. Worker start `2026-09-14T10:15:31.415Z`; kontrola 10:24:07 UTC: connected, DISARMED, groupFlat, bez reconciliationRequired, orders, divergence, stuck outbox a lastError.
- Obě skutečná připojení zachytila Currency USD, evidence dorazila do DB a běžný import potvrdil všech sedm dnešních epizod. Původní position_id/trade_id zachované, pending_reason null; čisté P&L celkem 1156,20 USD. Bez ručního přepisování obchodů nebo DB migrace.
- Produkční UI ověřeno: LIVE kombinovaně 7 účtů / 1156,20 USD při VŠE; individuálně všech 7 s vlastními časy a P&L. Režim FUNDED ukazuje 3 účty / 400,20 USD; dnešní karta ověřena také v hlavní Historii. Po ověření vrácen FUNDED / kombinované zobrazení.
- Žádný nový obchod, ARM ani Flatten. Reálný nový vstup po opravě nebyl prováděn; automatizované regresní výsledky jsou v předchozím zápisu. Soukromé důkazy aktivace: `/private/tmp/alphatrade-activation-20260914`. Tento následný dokumentační zápis není součástí nasazeného commitu.

### 2026-09-14 — Codex: oprava prvního vstupu a měny poplatků (lokálně)

- Uživatel schválil pouze ranní chybu a historii; obnova správy otevřeného obchodu zůstává odložená. Izolovaný worktree `/private/tmp/alphatrade-entry-history-fix-20260914`, základ produkční `f4f04147`; cizí rozpracované změny v hlavní složce zachované.
- Leader Position transition nyní používá již existující důkaz úplného prázdného snapshotu. Nový vstup 1+4+1 založí vlastní epochu od prvního fillu místo opětovného použití terminální epochy minulého obchodu. Unknown/reconnect ani shoda follower množství nevytváří neprokázané ownership.
- Poplatky a TradePaired ledger rozpoznávají měnu z pasivně uložené Currency entity stejného broker připojení, nikoliv konstantou 840. GET `/currency/list` je na konci omezeného journal cyklu; nezasahuje do execution cache. Nová evidence posune cursor a běžný import dokončí stejné epizody. Bez změny DB schématu a bez ručního přepisování P&L.
- Finální kompletní regrese **393 souborů / 3571 testů passed**. Typecheck passed, lokální produkční build passed, cílený lint 0 errors (3 starší warnings v controlleru), diff check passed. Mac bundle sestaven a syntakticky ověřen bez spuštění. Devět původních offline scénářů po opravě bez DISARM a broker zápisů; šest kopií ve dvou pořadích Fill/Position provedlo všechny čtyři SL změny.
- Soukromé replay podklady zůstávají mimo git v `/private/tmp/alphatrade-incident-20260914`. Offline účetní replay s testovacím USD číselníkem vrátil všech sedm očekávaných výsledků; produkční číselník/import tím není ověřen.
- **Bez push/deploy, bez aktualizace nebo restartu běžícího workeru, bez broker příkazů.** Nasazení vyžaduje web/server i worker a následnou kontrolu skutečného Currency capture a sedmi dokončených epizod. Detail: `docs/reviews/copier-entry-history-20260914/FIXES.md`.


### 2026-09-13 — Codex: lokální oprava latence a obnovy copier relay

Po měření ztraceného `claimed` příkazu připravena izolovaná oprava z `5b2265f2`: oddělené řízení / rychlý heartbeat / pozadí, durable delivery checkpoint, idempotentní claim a completion, ochrana proti opakování execution a starému ARM po restartu. Přídavná migrace zůstává lokální; v1 kompatibilita pro postupné nasazení zachována. Opožděné snapshoty nesmějí přepsat novější stav. Historie zachovává `unchanged`, první čtení a invalidace; realtime čtení je single-flight. Neověřený ON/OFF dialog už netvrdí, že nic nebylo odesláno.

Ověření: celá sada 3541 testů (46 vyžadovalo povolení lokálního testovacího portu a následně prošlo), navíc 2 nové ochrany v cílené sadě 82/82; TypeScript, web build, worker bundle a 20 izolovaných SQL kontrol. Offline výpadek claim/ACK se zotavil za cca 3,7 s s jediným provedením; není to produkční rychlost. Žádný deploy, remote migrace, reinstall ani živé přepínání. Detaily, omezení a pořadí aktivace: `docs/COPIER_RELAY_RECOVERY_20260913.md`.

### 2026-09-13 — Retire obsolete Tradecopia import and notifications

- Removed legacy notification settings, auto-import queue, Tradovate/Tradesyncer CSV dialogs and account/history upload entry points. Preserved current journal import, account source status, historical records and current copier alerts.
- Legacy notification API and Edge ingestion functions return 410. Edge functions deployed as import-trades v10 and tradecopia-shadow-ingest v7 with previous JWT settings retained; original source backed up before replacement. Old Mac collectors unloaded and source installers disabled. No data deletion or current worker changes.
- Rebased removal onto production d7a5aebf to preserve newer journal work. Typecheck, production build and targeted regression tests passed.

### 2026-09-13 — návrat původních obchodů po aktivaci nové historie

Oprava migrační regrese: vlastník znovu vidí explicitní starší hlavní záznamy kopírky (isMaster, bez masterTradeId, bez pnlEstimated), označené jako „Starší záznam“. Chybějící nová fill evidence nesmí odstranit existující historii. Odhadované followery, nahrazené řádky a nepotvrzené nové journal pozice se nevracejí do součtů. Duplicitní původní import stejného owner/account/copier ID má jediný stabilní řádek; uložená data a hodnocení zůstávají zachovaná v archivu. Stejné pravidlo platí pro cache, historii a LIVE; detail vysvětluje původ cen/P&L a nedostupnost starých posunů SL/TP. Databázové confirmed/shared projekce, oprávnění, Edge Functions a worker se touto opravou nemění. Uživatel výslovně požádal „nasad opravu“.

### 2026-09-13 — Historie fáze 31: schválená aktivace (Codex)

Po explicitním schválení samostatná soukromá DB/Edge/worker záloha, osm migrací,
šest Edge Functions a Vercel 26efeada (dpl_4DwVJPEjSheiE7wjiGeFCbtFFbWW READY).
DEMO worker aktualizován až po autoritativní flat/DISARMED kontrole; po restartu
zůstává DISARMED, connected a bez pracovních příkazů. 138 skutečných událostí
ze dvou připojení má shodné event-ID hashe na disku a v DB; upload ACK a import
200, dokončené projekční cursory. Nedělní broker seznamy neobsahují fill/order
historii: nový obchod a opakované posuny SL/TP nejsou tímto ověřeny. Zůstává
uživatelský DEMO scénář a produkční UI ověření odebrání sdílecího souhlasu.
Původní syntetické copier výsledky jsou oddělené od potvrzených statistik.
Podrobnosti, záloha, advisories a hranice důkazů:
`docs/reviews/trade-history-20260912/PHASE-31-ACTIVATION.md`.
Weekly-report v6 nasazen po doplňujícím souhlasu s existujícím přenosem do
Anthropic. V DB již bylo 9 reportů; kód je používá v Coach, neposílá automaticky
email/push. Hromadné kopírování Storage objektů zamítnuto kontrolou, provedena
pouze schválená kontrola metadat/HEAD; DB záloha neobsahuje obrázkové objekty.


### 2026-09-13 — Codex: historie, fáze 30 — izolovaná integrace main

- Lokální práce uložena jako 0163c891 do větve `codex/history-evidence-20260913`, následně sloučen main 110aa0db. Zachovaný display feed i journal sběr přes jeden socket; oba dostávají resync. Canonical necommitnuté pracovní soubory beze změny.
- Sloučený kód: 3 515 testů/386 souborů, TypeScript, scoped lint, Vite/PWA build a oddělený esbuild worker bundle + node syntax check prošly. Worker nebyl spuštěn nebo instalován. Browser ověřil hlavní fiktivní graf se třemi SL změnami v jedné minutě.
- Dvě upstream testovací očekávání opravena podle aktuálního Currency/LiveRiskValue kontraktu, číselné/risk aserce zachované. Podrobnosti `PHASE-30-INTEGRATION.md` v review složce.
- Připravené `ACTIVATION-REVIEW.md` a `ACTIVATION-FILES.txt`: požadavky → důkazy, 190 cest, 8 migrací, záloha, souběžné nasazení RPC/klienta a bezpečný restart workeru. Žádný push, vzdálená migrace ani broker akce. Další krok vyžaduje výslovné schválení aktivačního plánu.


### 2026-09-13 — Codex: historie, fáze 29 — kapacita a dávkový staging (lokálně)

- Na 12 fiktivních účtech ověřeno až 24 000 obchodů/120 013 raw řádků se správnými vlastními součty. Výpočet 2,236 s, projekce 34,4 MB; není to síťový ani vzdálený výkonový důkaz.
- Staging nově nejvýše 8 bloků na požadavek, s kontrolou 5s rozpočtu mezi RPC. Processing pokračuje ze serverem potvrzených bloků, viditelná generace se změní až po úplném publikování. Limity zůstávají explicitní, bez tichého zkrácení.
- 3 466 testů/376 souborů, SQL harness (2 400 epizod/12 účtů včetně zachování head během processing), TypeScript, lint bez chyb/varování a build prošly. Podrobnosti `docs/reviews/trade-history-20260912/PHASE-29-CAPACITY-AND-STAGING.md`.
- Read-only fetch potvrdil novější main 110aa0db; další krok je izolovaná integrace jeho oprav před aktivačním review. Žádné vzdálené zápisy, deploy, worker ani broker akce.


### 2026-09-13 — Codex: historie, fáze 28 — spectator a žebříček (lokálně)

- Dokončené přepojení spectator historie/žebříčku na omezené RPC z fáze 27; bez raw fallbacku. Historie po 250 až do úplného konce, kontroly počtu/jednotky/session/oprávnění; žebříček explicitně posledních 100 povolených řádků na tradera.
- Neznámé výsledky zachované bez falešné nuly, ranku či úspěšnosti. NaN je pouze přechodný kompatibilní model; UI kontroluje konečnost, hidden kalendář ani v prázdných týdnech neukazuje dolary. Křivka bez úplných výsledků uvádí nedostupnost.
- Celá regrese 376 souborů/3 462 testů; po posledním okrajovém případu 37 cílených testů včetně nového. TypeScript/build/diff-check prošly, lint 0 chyb/59 varování. Browser na skutečném NetworkHub s fiktivními 12 účty: účet 1 −4,52 → účet 11 +5,48 USD, skryté výsledky, chyba/retry. Fiktivní testovací server zastaven.
- Podrobný rozsah a limity: `docs/reviews/trade-history-20260912/PHASE-28-SPECTATOR-LEADERBOARD.md`. Bez vzdálených změn/broker akcí. Celkový cíl nadále čeká na kontrolu velké projekce, přihlášený tok/conformance a schválenou aktivaci.


### 2026-09-13 — Codex: historie, fáze 27 — serverové omezení sdílených obchodů (lokálně)

Read-only produkční katalog potvrdil široké Trades visibility (včetně is_public a opačné connection strany), ale funkční guard souhlasu příjemce. Osmá lokální migrace přidává restrictive journal SELECT a úzké RPC s auth.uid()/směrem/account filtrem/unit/media projekcí; privilegovaná část je v journal_private, veřejný wrapper invoker, anon nemá EXECUTE. Feed nyní používá RPC bez raw fallbacku a bez dvojího převodu R. Skutečné SQL + klientský adaptér, 3 449 testů, TS, lint bez chyb a build prošly. Spectator/žebříček ještě potřebují přepojení před společnou aktivací; starší raw ruční obchody/preps/reviews nejsou globálně auditované touto změnou. Bez vzdálené migrace/deploye/workeru/brokeru. Podrobnosti: `docs/reviews/trade-history-20260912/PHASE-27-SHARED-READ-BOUNDARY.md`.

### 2026-09-12 — Codex: historie, fáze 26 — přesné skupiny ve sdíleném feedu (lokálně)

Odstraněno heuristické slučování dle dne/instrumentu/směru. Explicitní skupiny se doplní z celé odpovědi s exact count; limit/chyba/změna oprávnění nepředstírá menší počet účtů. Karta zobrazuje součet povolených členů, rozkliknutí vlastní účet s jeho cenami/P&L/časy na ms přes kompaktní selector. Klient zahazuje odpovědi po změně rozsahu a ukazuje chybu s opakováním. 3 445 testů, TS, lint bez chyb, build a browser 12 účtů → účet 11 +5,48 USD při součtu +11,76 USD prošly; neúplná skupina součet nezobrazí. Serverová oprávnění/spectator a živé ověření ještě zbývají; bez produkce/workeru/brokeru. Podrobnosti: `docs/reviews/trade-history-20260912/PHASE-26-EXPLICIT-FEED-GROUPS.md`.

### 2026-09-12 — Codex: historie, fáze 25 — aktuální sdílená fakta (lokálně)

Sedmá lokální migrace aktualizuje finanční root fakta/stav atomicky se soukromou projekcí, bez zpřístupnění privátní evidence. Opravy poplatků zachovají review; pending/invalidace/delete odstraní řádek z potvrzeného pohledu. Klient nemůže podvrhnout stav. Feed/detail zachovává mínus/centy a neznámé R; opraveny dva nečitelné světlé popisky. 3 433 testů, TS, lint bez chyb, build, skutečné SQL s follower RLS a 2 400 epizodami/12 účty, browser s fiktivními daty prošly. Jemná serverová oprávnění, spectator a heuristické seskupování feedu stále nedokončeny; bez produkce/workeru/brokeru. Podrobnosti: `docs/reviews/trade-history-20260912/PHASE-25-CURRENT-SHARED-FACTS.md`.

### 2026-09-12 — Codex: historie, fáze 24 — kalendář otevírá společný detail (lokálně)

Denní i týdenní seznam vlastního Dashboardu předává přesné ID do stávajícího TradeDetailModal a zavírá původní přehled. Řádky rozlišují účty názvem, používají skutečná tlačítka a týdenní P&L zachovává centy/neznámé R. Cizí sdílený kalendář nezískává owner čtení ani editaci. 42 testů, TS, lint bez chyb, Vite/PWA build a browser den→účet 2 / týden→účet 11 prošly; Screenshoty zůstávají první. Fiktivní UI není produkční E2E. Bez produkce/workeru/brokeru. Podrobnosti: `docs/reviews/trade-history-20260912/PHASE-24-CALENDAR-DETAIL.md`.


### 2026-09-12 — Codex: historie, fáze 23 — časové okno a plné regrese (lokálně)

Graf zahrnuje skutečný den výstupu; cache nezamyká neúplná historická data a respektuje publikovaný konec. Opravena jednotka již převedeného R-only DTO v NetworkHubu (upřesnění fáze 22). Plná sada odhalila neplatné nativní ESM importy a tři regrese po odstranění OrderVersion větve ve fázi 8: doplněny přípony a úzká počáteční korelace nového Order s verzí ze stejné dávky, bez přepsání známé ceny samostatným požadavkem. 370 souborů / 3 429 testů, TS, lint bez chyb, Vite/PWA build a načtení fiktivního náhledu prošly. Broker conformance a přihlášený tok nejsou tímto prokázané. Bez produkce/workeru/brokeru. Podrobnosti a zbývající práce: `docs/reviews/trade-history-20260912/PHASE-23-COMPATIBILITY.md`.


### 2026-09-12 — Codex: historie, fáze 22 — skutečné R ve statistikách (lokálně)

Souhrny už neberou chybějící risk jako 0R ani náhradní 1 USD. Doložená R se počítají po jednotlivých obchodech, ne jako dolarová metrika dělená průměrným riskem. Kalendář i rozkliknuté R používají neutrální neznámý stav; souběžné účty mají jeden časový krok R drawdownu. Opraveny zavádějící R popisky dolarových hodnot NetworkHubu a neúplný risk prefill Monte Carlo. 38 testů včetně skutečného SSR kalendáře, TS, lint bez chyb, build a browser fiktivního náhledu pro 12 účtů i účet 2 prošly. Hlavní tab 3000 byl spadlý; produkční UI ani raw-to-UI tok tím nejsou ověřené. Bez deploye/migrace/workeru/brokeru. Podrobnosti a zbývající práce: `docs/reviews/trade-history-20260912/PHASE-22-R-STATISTICS.md`.



### 2026-09-12 — Codex: historie, fáze 21 — přesné promítání grafu (lokálně)

V izolované pracovní kopii sjednoceno promítání journal position boxu, SL/TP a plnění na zlomky svíček. Dostupné úseky se zachovávají, chybějící svíčky ani výpadky evidence se nespojují; chybějící 1m zůstává mezerou i uvnitř agregované 5m. Box používá stávající CandleKit renderer s přesnými anchors, nikoliv extrapolaci obecného kreslicího engine. Staré přichycené ENTRY/EXIT značky nahrazují přesná vlastní plnění. Reference prvních doložených SL/TP je vysvětlená v legendě, neplatné bracket ceny se nedopočítávají. 31 testů včetně skutečného rendereru/backtest regrese, typecheck/lint bez chyb, build a browser s různými účty/časovými mezerami prošly. Změny jsou lokální, bez brokeru/deploye/workeru. Podrobnosti: `docs/reviews/trade-history-20260912/PHASE-21-CHART-GEOMETRY.md`.


### 2026-09-12 — Codex: historie, fáze 20 — dostupnost zdrojů (lokálně)

V izolovaném `/private/tmp/alphatrade-history-20260912` přibyl sbalený owner přehled podkladů v Historii i LIVE, jeden na připojení i pro 12+ účtů. Rozlišuje poslední seznam/dávku/chybu/chybějící metadata bez tvrzení úplné historie. Ověřený serverový endpoint a service-only read RPC zachovávají zákaz browser přístupu k OAuth registru. Starší úspěch nahraný později nepřepíše novější chybu; scope i auth generation se validují a neúplná odpověď se odmítne. Finanční projekce a ovládání brokeru se nemění. 44 testů, skutečná lokální SQL migrace se dvěma vlastníky a kontrolou oprávnění, TypeScript, lint bez chyb, Vite/PWA a browser prošly. Bez deploye/vzdálené migrace/restartu workeru. Podrobnosti a zbývající práce: `docs/reviews/trade-history-20260912/PHASE-20-SOURCE-AVAILABILITY.md`.

### 2026-09-12 — Codex: lokální historie SL/TP a vlastních účtů (rozpracováno)

- Fáze 19: pasivní historický sběr rozšířen o orders/fills/verze/commands/reporty, přesné contract a account podklady. Velké odpovědi přecházejí na doložené dávky známých rodičů; pořadí zdrojů po timeoutu pokračuje, scope metadata neoznačují úplnou historickou retenci. 96 testů, scoped TS/lint/build prošly; bez execution akcí. Podrobnosti a limity: `docs/reviews/trade-history-20260912/PHASE-19-HISTORY-BACKFILL.md`. UI dostupnosti zdrojů stále zbývá, nic nenasazeno.

- Fáze 18: společný owner detail přesných filtrovaných ID obnovuje všechna P&L, ceny a historii ve stejné generaci; graf v modalu používá stejný ověřený objekt. Chyba jednoho člena nedovolí částečný součet. Údaje o plnění sledují účet vybraný v grafu. 79 testů, SQL průchod 12/2 400 epizod, scoped TS/lint/build a browser s opravou součtu i třemi SL změnami v minutě prošly. Skutečné svíčky v preview nejsou dostupné. Podrobnosti: `docs/reviews/trade-history-20260912/PHASE-18-CONSISTENT-DETAIL.md`. Lokální draft, nic nenasazeno.

- Fáze 17: historie a detail zobrazují vlastní čisté P&L na centy; procentní součet používá kapitál unikátních vybraných účtů, ne leadera. Nedoložené výchozí riziko znamená neznámé R/R, původní odhady rizika se při hydrataci/importu odstraní. 45 testů, scoped TS/lint/build a skutečný modal pro leadera, followera i 12 účtů prošly. Podrobnosti a hranice: `docs/reviews/trade-history-20260912/PHASE-17-RESULT-PRECISION.md`. Jen lokální draft, cíl dále rozpracovaný.

- Fáze 16: automatické screenshoty nového journalu se čtou přes přesný finální fill → owner/connection ledger → episode, bez současné konfigurace či kopírování obrázků followerům. Pozdní upload nevyžaduje finanční reimport; chyby metadat/odkazů mají vlastní stav a retry. Privátní security_invoker view, 79 testů, skutečný SQL/owner hydration průchod (včetně 2 400 epizod), TS/lint/build a skutečný modal ve fiktivním preview prošly. Capture/CDP a přihlášený Storage tok zatím neověřeny. Detaily a hranice: `docs/reviews/trade-history-20260912/PHASE-16-SNAPSHOT-LINKAGE.md`. Nic nenasazeno; další konkrétní UI položka je přesnost P&L/RR.

- Fáze 15: nový raw vstup se zpracovává trvale po 250 událostech s pevným cílem, atomickým potvrzením a kontrolou generace. Pozdní vložení přehrává jen historii dotčené entity; časové kotvy/plnění/mezery se neslučují. Aplikace rozlišuje processing a automaticky pokračuje další dávkou. 88 testů, skutečný SQL/server import 2 400 epizod na 12 účtech, input rollback/CAS/role, jednořádková fee korekce a cílený replay prošly; TS/lint/build a actual-component preview také. Finanční výpočet stále prochází celý omezený kompaktní vstup. Podrobnosti a zbývající práce: `docs/reviews/trade-history-20260912/PHASE-15-INCREMENTAL-INPUT.md`. Lokální draft, nic nenasazeno.

- Fáze 14: velká hotová projekce se přenáší skrytými dávkami s obsahovou identitou, pokračováním po přerušení a jednou atomickou finální transakcí. Skutečné `getTrades` navíc opravuje velký rozsah jednoho dotazu na úplné UUID stránkování, s kontrolou generace před root čtením i po hydraci. 90 testů, SQL/server/paged-owner-read pro 2 400 epizod na 12 účtech, pozdní korekce a rollback posledního člena prošly; TypeScript/ESLint/build také. Výpočet raw historie stále není inkrementální a produkční timeouty nejsou ověřené. Přesné hranice: `docs/reviews/trade-history-20260912/PHASE-14-STAGED-HISTORY.md`. Pouze lokální draft.

- Fáze 13: atomický import receipt ověřuje dokončenou revizi, verzi projekce a přesné vazby účtů. Nezměněný import už nečte raw historii, nepřepočítává pozice ani nezvyšuje generaci; nová evidence či přiřazení znovu spustí import. 36 testů, izolovaný SQL/server harness pro 12 účtů, scoped TypeScript a ESLint prošly. Skutečné dělení dlouhé historie zatím není implementované. Detaily: `docs/reviews/trade-history-20260912/PHASE-13-IMPORT-CHECKPOINT.md`. Pouze lokální draft, produkce/worker beze změny.

- Fáze 12: journal review-only allowlist před optimistickým stavem, bez škálování P&L kopií, kontrola podle uložené identity ve storage a ochrana root/JSON faktů ve stávajícím lokálním draft triggeru. Formulář Hodnocení obchodu zobrazuje brokerové P&L, ukládá jen skutečně měněné review, čeká na potvrzení a zachová text při chybě. Preview používá i skutečný TradeDetailModal; browser odhalil a opravil nechtěný automatický přechod z prázdných Screenshotů na Graf. 26 testů, SQL/server/owner-read harness, TS/ESLint/build prošly. Detaily a omezení: `docs/reviews/trade-history-20260912/PHASE-12-REVIEW-ONLY.md`. Produkce/worker beze změny.

- Fáze 11: doplnění fillFee/fillPair ze dvou connection-wide GETů, bez násobení požadavků účty. Omezená odpověď/cache, potlačení duplicit, revize proti přepsání stream oprav, asynchronní potvrzení diskového zápisu mimo execution frontu, explicitní nedostupnost a retry po timeoutu. Deleted fee už neponechává starou částku. Testováno 12 vlastních P&L, souběh stream/REST/disk, 403/429, abort/timeout a regrese. Detaily/hranice: `docs/reviews/trade-history-20260912/PHASE-11-ACCOUNTING-BACKFILL.md`. Obecný backfill, dlouhá historie a ostatní otevřené body pokračují; produkce/worker beze změny.

- Fáze 10: doplněn úplný počáteční account/position snapshot, jeden čerstvý pár GETů pro 12+ účtů. Doložené řádky/completion a časové okno umožňují stanovit budoucí flat stav i pro nový instrument; chybějící data, výpadek nebo souběžné/pozdní plnění důkaz odmítnou. 60 testů / 10 souborů, durable/API hash průchod a izolovaný SQL import pro 12 účtů s novým snapshotem prošly, stejně jako TS/ESLint/build. Backfill, dlouhá historie a další úkoly stále zbývají. Detaily: `docs/reviews/trade-history-20260912/PHASE-10-POSITION-SNAPSHOT.md`. Produkce/worker beze změny.

- Fáze 9: skutečná LIVE karta historie napojena na App/shared detail. Při integraci nalezen a odstraněn zbývající starý pre-filter aggregate v App — jinak správný nový helper dostával už sloučená data. Sdílený filtr teď pracuje s vlastními řádky a exact výběrem účtů. Journal chart vyžaduje současný owner detail a má explicitní chybu/timeout/retry, bere čerstvé ceny i historii společně. 37 testů / 6 souborů, scoped TS/ESLint a Vite/PWA build 3 481 modulů / 89 precache prošly. Fiktivní UI ověřeno, přihlášený tok stále ne. Úplnost sběru a další otevřené body v `docs/reviews/trade-history-20260912/PHASE-9-LIVE-AND-FILTERS.md`; produkce beze změny.

- Fáze 8: doplněn explicitní odběr analytických entit, okamžitá pasivní capture před metadata frontou a normalizace úvodního snapshot objektu. Samostatné požadované orderVersion nesmějí změnit execution cache. Staré async dokončení po zavření socketu nesmí potvrdit synchronizaci. 42 testů / 9 souborů, scoped TypeScript/ESLint a Vite/PWA build prošly. Doklad úplného počátečního flat stavu, backfill i další úkoly fáze 7 stále zbývají; žádný produkční zásah. Detaily: `docs/reviews/trade-history-20260912/PHASE-8-CAPTURE.md`.

- Fáze 7: App lokálně nahradil starý import podle aktuálního leadera serverovým importem po historických připojeních (jeden požadavek pro 12 účtů). Přidány statusy, konkrétní pending důvody, zachování lokálních review při aktualizaci a slučování Realtime událostí do ověřené čtečky. Nepřevzatý legacy leader je stejně jako starý follower mimo potvrzené statistiky, protože jeho původní účet nebyl historicky doložený; review zůstává v archivu. 58 testů / 8 souborů, izolovaný SQL průchod, scoped TypeScript a Vite/PWA build (3 476 modulů, 87 precache) prošly. Úplný sběr, LIVE obchodní karta, dlouhá historie a E2E stále zbývají. `docs/reviews/trade-history-20260912/PHASE-7-APP-SYNC.md` uvádí konkrétní další kroky. Produkce beze změny.

- Fáze 6: přesný legacy převod podle spojení a finálního fill ID zachovává UUID/review, opravuje účet a ponechává duplicitní poznámky jako navázané původní záznamy. SQL ověření včetně followera, konfliktů a starého INSERT prošlo. Přidán sbalený owner archiv pending/invalidated a původních odhadů, dostupný i bez potvrzených obchodů, s vlastním filtrem účtu a lazy poznámkami/screenshoty. Zobrazení ověřeno na 12 fiktivních účtech ve světlém/tmavém náhledu. Poslední cílený běh: 28 testů / 4 soubory; TypeScript a Vite/PWA build (3 475 modulů, 86 precache) prošly. Import stále čeká na výměnu starého App syncu, LIVE a úplný sběr. Detaily a omezení: `docs/reviews/trade-history-20260912/PHASE-6-LEGACY-REVIEWS.md`.

- Nově je soukromá finanční projekce zapojená do dashboardu, seznamu, detailu a úplného exportu. Kontrola generace brání smíchání dvou verzí mezi dávkami. Read-only SQL view vylučuje neplatné výsledky ze serverových přehledů; veřejný RPC zachovává `is_public`/`share_notes` a soukromý ledger nesdílí. Izolovaný SQL průchod včetně 12 vlastních detailů a anonymního sdílení prošel; 62 cílených testů čteček/exportů/soukromí prošlo. UI neúplných pozic, automatický start importu, legacy dedupe, plný sběr a dlouhá historie stále zbývají. Podrobnosti: `docs/reviews/trade-history-20260912/PHASE-5-READERS.md`.
- Závěrečné společné ověření čteček: 167 testů / 23 souborů, scoped TypeScript, ESLint bez chyb a Vite/PWA build (3 473 modulů, 85 precache) prošly. Žádná produkční migrace ani deploy. Pro další dedupe je doložené, že legacy `trade_id` pochází z finálního broker `fill.id`; propojení vyžaduje také přesné spojení a jednoznačný původní záznam, nikoli aktuálního leadera.

- Doplněn lokální serverový import raw evidence → pozice → atomická SQL transakce pro všechny účty spojení. Rezervované UUID brání duplicitám, pending poplatky nevyrábí P&L 0, opravy nepoškozují review a smazané obchody se znovu nevytváří. 80 testů / 14 souborů a izolovaný průchod tří migrací s 12 fiktivními účty prošly. Soukromá fakta/stavy ještě nejsou zapojené do všech čteček a statistik; bez toho se import nesmí aktivovat. Dlouhá historie zatím má explicitní mez místo částečných zápisů. Podrobnosti a zbývající práce: `docs/reviews/trade-history-20260912/PHASE-4-PERSISTENCE.md`. Produkce beze změny.

- Další pokrok: připraven owner-scoped GET evidence, serializovaný append RPC, transakční IndexedDB cache s pevnou hranicí snímku a read model pro všechny účty jednoho spojení. Přesná OAuth identita bez fallbacku na první účet; otevřené/neúplné pozice a chybějící poplatky zůstávají pending. 73 testů / 12 souborů, scoped TypeScript/ESLint a izolované SQL/RLS + IndexedDB transakční ověření prošly. Uložení `Trade` a napojení obou karet ještě chybí. Podrobnosti: `docs/reviews/trade-history-20260912/PHASE-3-READ-MODEL.md`. Produkce a worker zůstaly beze změny.

- Navazující výslovné „souhlasím“ schválilo přenos vyjmenované obchodní evidence přes `alphatrade-mentor-15.vercel.app` do vlastníkova Supabase. Dřívější zamítnutí uploaderu je vyřešené. Lokální kód nyní uploader zapojuje, vynucuje přesný origin, úplné ACK a integritu obsahu, zachovává ID při opakování a nečeká na síť v exekuční cestě. Nejde o souhlas s deployem, migrací nebo restartem workeru.
- Doplněna oddělená projekce celých pozic (počáteční doložený flat, scale-in, partial close, reversal, poměrné poplatky), segmenty SL/TP přes rozpory a výpadky a seznam událostí ve fullscreen. 62 cílených testů / 10 souborů prošlo. UI/import nové projekce, úplný analytický sběr a skutečné DB ověření stále zbývají; stav je podrobně v PHASE-2-LOCAL.md.
- Aktuální závěrečná kontrola po tomto doplnění: opakovaných 9 testů epizod, scoped TypeScript a ESLint bez chyb, úspěšný Vite/PWA build (3471 modulů) a DOM individuálního účtu 11 s přesnými posuny a odmítnutím. Nedošlo k produkčnímu nasazení.

- Izolovaný worktree `/private/tmp/alphatrade-history-20260912` z e61ab59a; cizí necommitnutá práce v Documents zůstala nedotčená.
- Fiktivní ukázka na portu 4189 používá skutečný CandleKit graf a styly appky: 12 účtů, vlastní ceny/časy/poplatky/P&L, tři změny SL uvnitř minuty, odmítnutí a mezera záznamu. Screenshoty jsou první. Opraven převod zlomkového času přes celočíselné souřadnice LWC 5.2.
- Připraven pasivní observer, lokální JSONL evidence, projekce SL/TP a FillPair realizací, výběr účtu/realizace a lazy-load detailu. Copier sync už nevyrábí nové follower obchody z aktuálního nastavení. Staré odhady zůstávají označené.
- Celá funkce NENÍ dokončená: zbývá úplný ověřený sběr, cloudový přenos/read model/import, celé epizody pozic, oprava starých odhadů a LIVE karta. Legacy ledger bez historického accountId neprokazuje přiřazení po změně leadera.
- Původní stav před navazujícím souhlasem: automatická kontrola zamítla uploader a vznikl jen lokální recorder. SQL/API jsou nadále místní soubory. Žádné broker akce, ARM, restart/reinstalace workeru, push, deploy ani změna DB.
- Ověřeno 48 cílených testů / 9 souborů, scoped ESLint bez chyb, scoped TypeScript klienta/pilotu/API, produkční Vite/PWA build a přepínání fiktivních účtů v browseru. Podrobný stav a zbývající ověření: `docs/reviews/trade-history-20260912/PHASE-2-LOCAL.md`.


### 2026-09-12 — Historie podle účtu, první izolovaná část (Codex)

- Po schválení návrhu zahájena postupná implementace v odděleném worktree
  `/private/tmp/alphatrade-history-20260912` z `e61ab59a`; kanonický checkout
  obsahuje jinou rozpracovanou úpravu LIVE.
- Individuální detail pracuje s vybraným záznamem účtu. Kombinovaná karta nese
  přesné členství po filtrech, odhadované PnL se propaguje do součtu a označuje.
  Seskupení podle shodného času/instrumentu odstraněno; počty jsou unikátní účty
  deníku, nikoli tvrzení o skutečně provedených kopiích.
- Screenshoty zůstávají první; kombinovaný detail načítá screenshot i graf přes
  skutečný zahrnutý účet. Nový position box a historie SL/TP zatím nejsou zapojeny.
- Vlastní přesná plnění followerů, poplatky, sběr SL/TP událostí a oprava starých
  duplicit následují samostatně. Dnešní syntetické kopie nelze změnou UI ověřit.
- Ověření: 13 regresí, scoped ESLint bez chyb, typová kontrola dotčené
  aplikační závislostní větve a finální Vite/PWA build prošly. Celý extension/server
  scope nebyl ověřen; build má existující upozornění na velikost chunků.
- Rozsah a návaznosti: `docs/reviews/trade-history-20260912/PHASE-1.md`.
  Bez nasazení, změny databáze, instalace workeru a broker akcí.
### 2026-09-12 — LIVE display reload persistence

- Balance and daily P&L restore from user-scoped session display cache; DLL/DD retain their last known values across partial refresh and reload, with original timestamps and value-based colors. Cache is scoped to user, broker connection, account, explicit risk profile and trading session.
- Presentation cache never feeds execution or risk eligibility. Local read proxy additionally allows authenticated GET copier-relay only.
- Release validation: 35 focused tests passed, typecheck and production build passed. Isolated from unrelated account profile UI work.

### 2026-09-11 — Schválené nasazení oprav této session (Codex)

- Uživatel schválil nasazení všech oprav session. Izolovaný balíček zahrnuje
  obnovu/paginaci dat deníku, auth-session a abort ochrany, skutečný cooldown,
  expiraci/odstranění duplicitních DISARM upozornění, aktuální Risk blokace
  a opravy stale leader expozice, výměny followerů a reconnectu workeru.
- Rozpracovaný TradovateAccountProfileSetup a lokální review artefakty jsou
  výslovně mimo balíček; nejsou přibaleny změny jiného agenta. Žádná změna DB,
  RLS, secrets, účtů, ARM, obchodních příkazů ani restart Mac workeru.
- Ověřen izolovaný strom na základě a3d7ef7f: 332 souborů / 3154 testů,
  TypeScript a produkční web/PWA build prošly. Scoped lint: 0 errors,
  30 existujících warnings. První testovací běh omezil sandbox u listen;
  kompletní opakování s lokálním testovacím HTTP serverem prošlo.
- Worker sestavený z tohoto stromu je bajtově shodný s již nainstalovaným:
  SHA-256 a6756eb925065c6da0ad80e1b9b321cad978c6fa5a193cedff40143a50fcf94a.
  Web deploy tedy nevyžaduje přeinstalaci ani přerušení kopírky.
- Předchozí produkční deployment pro případ návratu:
  dpl_DYjCQQFBRT7dnP8uqPToLHcsBEha (a3d7ef7f). Finální READY/alias a browser
  se ověřují až po pushi; tento přednasazovací zápis je sám nepotvrzuje.

### 2026-09-11 — Obnovené sockety zůstávaly pro controller odpojené (Codex)

- Incident 13:37 CEST: oba sockety ztratily heartbeat; close watchdog je
  uvolnil bez onclose a založil nové. Kritický error přepnul controller na
  disconnected, ale router bez connection=false dál držel true a potlačil
  následné úspěšné sync true. Nová regrese se dvěma reálnými broker adaptéry
  nad FakeSocket a brokerRouter před opravou selhala přesně po druhém syncu.
- Úzká oprava tradovateBroker.closeSocket oznamuje neplánovaný disconnect
  ihned, i když onclose nikdy nedorazí. Onclose pro takto zavřený socket
  nezdvojuje zprávu; plánovaná renewal si zachovává dosavadní chování.
- Ověření: finálních 26 transport/router/renewal/rate-limit testů prošlo,
  103 controller testů prošlo v širším běhu; scoped ESLint, TypeScript,
  diff whitespace a syntax sestaveného workeru ověřeny. Původní širší běh
  odhalil duplicitní false při renewal deadline; opraveno a renewal zopakována.
- Přímé GET čtení všech 7 účtů v 14:08 a znovu 14:10 CEST potvrdilo aktivní
  účty, flat a žádné aktivní příkazy. Backup do
  /private/tmp/alphatrade-reconnect-backup-LPcVXO. Nový bundle se od dosud
  instalovaného liší jen dvěma místy této opravy; SHA-256
  a6756eb925065c6da0ad80e1b9b321cad978c6fa5a193cedff40143a50fcf94a.
- Mac worker restartován 14:10 CEST se zachovanou durable skupinou všech
  6 followerů a původním plist. Automatická kontrola potvrdila flat/no-active;
  status 14:10:42 connected=true, armed=false, reconciliationRequired=false,
  lastError=null, bez divergence, stuck outboxu či neověřených kopií.
  Žádný ruční ARM, broker write, ruční přepis evidence, push ani web deploy.
- Dynamic API Hosts je samostatná kompatibilitní mezera. Přímé čtení Tradeify
  i Lucid v 13:42 CEST vrátilo HTTP 200 ze sdíleného demo.tradovateapi.com
  s redirect:manual, bez 307. Tato routovací migrace není potvrzenou příčinou
  incidentu. OAuth host-discovery kontrakt zůstává dokumentačně nevyjasněný.

### 2026-09-11 — Automatické read-only ověření po startu/reconnectu (Codex)

- Opravena příčina, kvůli které zůstal flat a DISARMED worker po startu nebo
  běžném WebSocket reconnectu trvale v `reconciliationRequired=true` a LIVE UI
  proto odmítalo ARM. Controller nyní po startu/reconnectu naplánuje úzký
  snapshot-only preflight; při autoritativním flat/no-working výsledku u všech
  účastníků obnoví pouze ověřený runtime stav a zůstane DISARMED.
- Automatická cesta nic neposílá brokerovi, neruší příkazy, nelikviduje pozice,
  neřeší durable historii/eligibility a nikdy sama neARMuje. Pozice, working
  order, divergence, OAuth/capability problém, stuck outbox, follower cut,
  durable open-copy marker, nedokončená leader epocha nebo rozběhnutý lifecycle
  dál zůstávají fail-closed a vyžadují explicitní kontrolu.
- Planned resync za běžícího ARM nyní nejdřív explicitně DISARMuje. ARM preflight
  zároveň ukáže konkrétní blocker (working order/divergence/stuck stav) před
  obecným `reconciliation-required` hlášením.
- Doplněny regrese pro startup, DISARMED reconnect, synchronní otevřené pozice,
  working order a ARMED disconnect. Celá sada: **332 souborů / 3153 testů**;
  TypeScript, scoped ESLint (jen tři již existující warningy) a `diff --check`
  prošly.
- Aktuální funded sestava obnovena v LaunchAgentu s leaderem **64503883** a
  followery **65333343 / 65333277**. Čerstvý a instalovaný bundle mají shodné
  SHA-256 `f6ea5d4f9321990529cb38c32fa927c0adbbbdd39f7e8c60b452290d2fa6455b`.
  Worker je connected, `groupFlat=true`, `reconciliationRequired=false`, bez
  working orders, divergence, stuck outboxu a `lastError`; zůstává záměrně
  `armed=false`. Žádný broker příkaz ani ARM nebyl odeslán.
- Při prvním reinstallu odhalen installer fallback na výchozí skupinu po změně
  leader-key. Worker zůstal DISARMED, přesná konfigurace `Hlavní` včetně safety
  byla obnovena a před finálním restartem byly všechny tři účty znovu read-only
  ověřeny jako flat/no-working.
- Localhost běží přes Vercel dev s polling watcherem (obejití macOS `EMFILE`).
  Preview secret hodnoty Vercel z bezpečnostních důvodů nestahuje a vrací jen
  `[SENSITIVE]`, takže lokální serverové Tradovate API vyžaduje samostatné
  lokální secret hodnoty; worker ani produkční Vercel tím nejsou dotčeny.

### 2026-09-10 — Worker aktualizován, funded followeři úspěšně nahrazeni (Codex)

- Na výslovný souhlas proveden backup starého bundlu, plist, group, snapshotu
  a auditu do `/private/tmp/alphatrade-worker-upgrade.3DfJ5e/`; původní worker
  se korektně ukončil DISARMED. LaunchAgent parametry/instalační slot zachovány.
- Start narazil na další bránu: chybějící followeři dosud nebyli durable
  ineligible, takže se API vůbec nespustilo. Automatické opakování zastaveno.
  Úzká oprava `validateStoredCopyGroupForStartup` dovoluje chybějící followery
  pouze ve výslovně vypnuté skupině (ne chybějící leader). Při zastaveném workeru
  změněno pouze `group.enabled=false`; žádné ruční mazání snapshotu/ownership.
  87 souvisejících testů, TypeScript a scoped lint prošly.
- Finální worker spuštěn **2026-09-10T19:38:09.611Z**. Instalovaný bundle má
  SHA-256 `1d52c8e3f6dc332b5e55a7605aceadb1b281910c4a33172ec178f9c6360828cb`,
  shodný se sestavením `/private/tmp/alphatrade-funded-recovery-final.mjs`.
- **19:38:38 UTC:** jeden potvrzený `update-group` s již schválenou ownership
  výjimkou vrátil HTTP 200. Worker i durable group obsahují leadera **64503883**,
  followery **65333343 / FTDFYG50719650896** a **65333277 / FTDFYG50488642119**,
  on-submit, **1×**, `enabled=false`, `armed=false`, connected, bez stuck outboxu,
  `lastError=null`. Výměna je dokončena; nejde o povolení/ověření ostrého ARM.
- Durable stale short lot -15 MNQU6 archivován do `unconfirmedFlatLots` s
  broker-flat timestampem, `openLots=[]`, dosavadní P&L -507 beze změny.
  Neověřený výsledek uzavření dále blokuje ostrý ARM ve stejné session.
  ReconciliationRequired zůstává true po změně topologie, nebylo obcházeno.
- Nezávislá broker čtení před i po výměně: všechny tři aktuální účty dostupné,
  aktivní, bez pozic a aktivních příkazů. Žádný ARM, ruční controller reconcile,
  obchodní příkaz nebo web deploy/push. Startup recovery proběhla automaticky
  a před výměnou detekovala staré chybějící lineage; nedělala orphan close.

### 2026-09-10 — Lokální oprava stale leader lotu při změně skupiny (Codex)

- Odstraněno předčasné odmítnutí topology switch pouze podle `dailyStats.openLots`.
  Změna nyní nejdřív vyžaduje capability a úspěšný flat/no-working snapshot
  všech požadovaných starých/nových účtů. Missing follower ownership stále
  vyžaduje původní samostatné potvrzení; outbox/lifecycle brány se neobcházejí.
- Broker event nebo změna safety generation během preflightu zneplatní důkaz;
  kontrola se opakuje i před durable mutací. Generická chyba už říká změna
  skupiny, nikoli změna leadera při pouhé výměně followerů.
- Po potvrzení flat se zbytkové loty atomicky přesunou do
  `dailyStats.unconfirmedFlatLots` včetně původního leader accountId a času
  ověření. Nejde o vymyšlený fill: P&L, losingTrades ani tradesToday se nemění.
  Evidence přežije serializaci/restart. Ostrý ARM v této session se při
  nepotvrzeném výsledku uzavření odmítne; nová session má vlastní statistiky.
- Ověření: 11 cílených regresí (včetně skutečných pozic, working příkazu,
  neúspěšného read/write, příchodu eventu a restartu); širší sada 52 souborů /
  **845 testů** prošla. TypeScript a scoped ESLint exit 0, bundle sestaven
  do `/private/tmp/alphatrade-funded-recovery-check.mjs`, `node --check` prošel.
- Změny nejsou instalované ani pushnuté. Žádný ARM, broker write nebo ruční
  přepis snapshotu. Uživatel byl požádán o souhlas s aktualizací/restartem
  workeru před dokončením už schválené výměny followerů.

### 2026-09-10 — Funded výměna po potvrzení ownership: další blokace durable leader lotem (Codex)

- Uživatel výslovně potvrdil uzavřený stav starých challenge účtů a odpojení
  přes ownership warning. Jeden nový `update-group` proto obsahoval pouze
  schválený `waiveUnverifiableFollowerOwnership: true`, nové followery
  **65333343/65333277**, násobek 1 a `enabled=false`; ostatní nastavení zachována.
- V 21:24 CEST nezávislý broker inventář znovu potvrdil leadera **64503883** i
  oba funded účty active/canTrade, bez pozic a aktivních příkazů. Aktuální
  group/snapshot/audit zazálohovány do `/private/tmp/alphatrade-funded-confirmed.beLjjn/`.
- Pokus 21:25 CEST odmítnut HTTP 409: `Změnu leadera blokuje otevřená durable
  pozice leadera`. Zpráva je generická pro topology switch; leader se neměnil.
  Ownership výjimka tuto jinou kontrolu neobchází. Status po pokusu
  `armed=false`, původní followeři; group soubor je shodný se zálohou.
- Žádné ruční mazání lotů, nový waiver, restart, ARM ani broker příkaz.
  Controller reconcile nebyl spuštěn: navzdory komentáři read-only jeho cesta
  může provádět follower cut / protective cancel. Další práce vyžaduje opravu
  rozporu durable leader evidence proti čerstvému broker flat stavu, ne další
  slepý update ani vypnutí bezpečnostní kontroly.

### 2026-09-10 — Izolované nasazení opravy zůstatků (Codex)

- Nasazení následně ověřeno: `a3d7ef7f662a56cd346d0df1fec115e25ca68f83` na origin/main, Vercel `dpl_DYjCQQFBRT7dnP8uqPToLHcsBEha` production READY a hlavní alias na stejném commitu. Veřejné HTML i LIVE chunk HTTP 200; chunk obsahuje `data-balance-state` a tooltip posledního známého zůstatku. Časná kontrola runtime logů 19:01:50–19:03:15 UTC bez error/fatal záznamů; nejde o broker conformance ani dlouhodobý monitoring.
- Na výslovné „pushni to“ připravena pouze prezentace cash: poslední potvrzená hodnota zůstává vidět po zastarání/failed read a nese „čeká na ověření“ i čas potvrzení. Nový broker údaj ji nahradí; chybějící/denied evidence není vymyšlená nula. Stejné pravidlo pro účet i kapitál desktop/mobile.
- Risk freshness, DLL, pozice, execution a Mac worker beze změny. Ostatní rozpracované změny jiné session nejsou součástí tohoto commitu.
- Přesný staged strom ověřen v izolované kopii: 31/31 cílených testů, TypeScript a web/PWA build prošly. První typecheck postrádal závislosti extensionu; po připojení stávajících závislostí prošel beze změny kódu. Produkční READY/alias je nutné ověřit až po pushi; žádný restart workeru ani broker akce.

### 2026-09-10 — Schválená výměna challenge → funded: zastavena ownership kontrolou (Codex)

- Uživatel potvrdil pass challenge a schválil náhradu followerů za funded
  **65333343 / FTDFYG50719650896**, **65333277 / FTDFYG50488642119**, 1×, bez ARM.
- Read-only broker kontrola 17:13 CEST: oba nové účty i leader **64503883**
  active/canTrade, bez pozic a aktivních příkazů. Záloha group/snapshot/audit:
  `/private/tmp/alphatrade-funded-change.f5bHf9/`.
- Jeden `update-group` přes lokální agent API v 17:15 CEST odmítnut HTTP 409:
  původní **64832671/64832689** mají neověřenou kopii z epochy
  `9cf68829-e70d-47e3-8c4a-170254602e7f`. Nedostupnost u brokera neprokazuje flat;
  nebyl přidán `waiveUnverifiableFollowerOwnership` ani proveden další pokus.
- Status po pokusu: `armed=false`, původní konfigurace obnovena; durable group
  soubor bajtově shodný se zálohou. Žádný broker příkaz, restart ani deploy.
  Před dalším pokusem je třeba explicitně potvrdit odpojení neověřitelných
  starých účtů (a jejich externě ověřený uzavřený stav); jiné kontroly zůstávají.

### 2026-09-10 — Oprava Supabase testovacího mocku; vysvětlení chybějících followerů (Codex)

- Opraveny dvě deterministické chyby posledního plného běhu: mock v
  `tests/storageBacktestPersistence.test.ts` nyní odpovídá lazy PostgREST
  builderu včetně `.abortSignal()`. Produkční timeouty nebyly oslabeny.
  Pět nových regresí ověřuje propagaci zrušení a nezměněnou cache bez zápisů;
  s testy recovery/fallback/session identity prošlo **48/48**, lint bez errors.
- Čerstvý read-only broker adresář v 17:02 CEST: Tradeify připojení je dostupné,
  ale vrací jen účty **65333343 / FTDFYG50719650896** a
  **65333277 / FTDFYG50488642119**. Původní followeři **64832671/64832689** chybí
  v celém adresáři, nikoli jen ve filtru aktivních účtů. Leader **64503883**
  byl bez pozice/příkazů. Chybějící účet není důkaz flat ani breach.
- Dotaz uživateli, zda nové účty mají nahradit původní. Žádná automatická výměna,
  ARM, reconciliation controlleru, broker write, instalace/restart ani push.
  Provozní brána zůstává zavřená do vyjasnění účtů a kompletního flat/no-orders
  ověření. Podrobnosti: `docs/reviews/live-changes-20260910/VERIFICATION.md`.

### 2026-09-10 — Kompletní kontrola změn: restart zatím blokován (Codex)

- Report: `docs/reviews/live-changes-20260910/VERIFICATION.md`. Celý běh 332 souborů: 3133/3136 testů prošlo. Backtest timeout prošel izolovaně 30/30 se stejným limitem. Dvě opakovatelné chyby `storageBacktestPersistence` jsou `rpc(...).abortSignal is not a function` — zastaralý async mock, zatímco reálný PostgREST builder tuto metodu má. Mock ani aplikační kód se při tomto ověřování neměnily.
- TypeScript, web/PWA build a lint errors všech změněných TS/TSX prošly; diff whitespace čistý. Browser kontrola není potvrzená: schvalovací timeout a jediné povolené opakování skončilo timeoutem kernelu. Žádné obcházení přes jiný browser/API povrch.
- Předinstalační read-only kontrola v 16:08–16:09 CEST: worker DISARMED, connected, vyžaduje reconciliation, `groupFlat=false`. Broker potvrdil leadera 64503883 flat/no-active; followery 64832671 a 64832689 nevrátila žádná z dostupných OAuth capabilities čtení. Jejich stav nelze považovat za flat ani dovozovat breach. **Instalace/restart zastaveny** do ověření všech účtů. Bez ARM, controller reconciliation, cancel/flatten, broker writes, deploye či změny konfigurace.

### 2026-09-10 — Nový vstup nesmí použít starou leader expozici (Codex, lokální oprava)

- Ranní log dokládá zapnutí 09:32, dispatch obou followerů 09:33 a opakované `nevysvětlená divergence … před OSO leader exitem MNQU6` od 09:44. Přesný historický pre-net se neukládal; mechanismus je ale reprodukovaný integračně: stará blocked epocha ±15 + autoritativně flat účty → opačný nový vstup byl vyhodnocen jako exit a DISARMoval skupinu.
- Controller rozlišuje známou nulu od neznámého symbolu (včetně prázdného úplného position snapshotu). Pro nové/změněné příkazy respektuje pořadí fill-ledger vs Position: novější fill nesmí přebít stará nula a novější nulu nesmí přebít ještě neuzavřený lot. Pre-fill klasifikace skutečných exitů zachovává kauzální ledger a remaining quantity pro partial/reversal.
- Po čisté, generation-valid reconciliaci se staré flat epochy přestanou používat jako fallback expozice i pro vstupní fill bez order eventu. Ownership, audit, unresolved markery ani broker data se nemažou; baseline se po restartu obnovuje povinnou reconciliací, není persistovaným tvrzením o aktuální bezpečnosti. Reconnect ruší úplnost snapshotu, změna leadera a hranice denní session resetují odpovídající volatilní důkazy.
- Nový `copierStaleExposure.test.ts`: 14 scénářů — standard/OSO/on-fill bez orderu, BUY/SELL, explicitní nula/prázdný snapshot, dva followeři, zachování ARM a historie, žádný auto-close; navíc oba směry pořadí fill/Position během pauzy. Před opravou regrese padaly stejným divergence důvodem. Finální sada kopírky: **65 souborů / 955 testů prošlo**. Celoprojektový typecheck i následný cílený typecheck finálních změn a jejich závislostí prošly (dočasný cílený config musí zahrnout `vite-env.d.ts`). Scoped lint: 0 errors, 3 existující warningy; finální worker sestaven pouze do `/private/tmp` a syntax zkontrolována. `git diff --check` čistý.
- Bez commitu, push/deploye, instalace/restartu workeru, ARM, reconciliace skutečných účtů nebo broker writes. Běžící worker opravu zatím nemá. `workingOrderAccounts` jako poslední výsledek kontroly není touto změnou převeden na realtime inventář; neslibovat aktuální no-working stav z tohoto pole. Souběžné změny UI zůstatků zachovány.

### 2026-09-10 — Zůstatek zůstává viditelný při zastarání cash snapshotu (Codex)

- Pouze UI: `liveBalanceDisplay`/`liveCapitalDisplay` zobrazují poslední známé cash hodnoty s platným potvrzovacím timestampem i po 45 s nebo po failed read, který datová vrstva již mergeuje s předchozí hodnotou. Poznámka „čeká na ověření“ + tooltip s časem. Nová hodnota nahrazuje starou bez lokální odvozené cache.
- Desktop účet, součet kapitálu i kompaktní kapitál používají stejné pravidlo. Chybějící/denied/neplatný údaj zůstává pomlčkou; skupina nesčítá neúplné členy jako nuly. Skutečná nula i legacy shadow snapshot kompatibilní. `isLiveAccountReadVerified`, DLL, pozice a runtime risk beze změn.
- 31 cílených testů prošlo ve 4 souborech; dva import-timeouty při zátěži vyřešeny opakováním s 15s timeoutem. Browser potvrdil `last-known` částku a čas posledního potvrzení bez error boundary. Při editaci vznikla opravená chybějící závorka UI komponenty, poté obnoven pouze frontend. Typecheck při zápisu ještě běžel. Bez worker restartu, ARM/broker operací či deploye. Cizí změny runtime zachovány.

### 2026-09-10 — Risk ukazuje aktuální blokace, ne historický lastError (Codex)

- LiveRiskTab už nevykresluje samotný `lastError` jako „Chyba workeru“. Technický detail zůstává v Událostech. Aktuální banner je odvozen pouze z dostupného runtime: kill switch, stopped, broker disconnected, reconciliation, divergence, stuck outbox a neověřené vlastnictví kopií. Při nedostupném runtime zobrazuje neověřený stav místo starých příznaků.
- Browser ověřil Risk s textem „Kopírování blokováno — Worker vyžaduje kontrolu stavu účtů“, bez starého WebSocket erroru. 60 testů ve 3 souborech + typecheck prošly; diff whitespace čistý. Jen prezentace, beze změn konfigurace, ARM, kontroly pozic, workeru nebo produkce.

### 2026-09-10 — Odstranění dočasné ukázky cooldownu (Codex)

- Na žádost uživatele odstraněno tlačítko, demo dialog, samostatná preview stránka i její DEV/loopback helper a specifický test. Skutečný panel v LIVE, odpočet, čas konce pauzy, animace a bezpečnostní UI blokace zůstávají. Regrese desktop/mobile kontroluje nepřítomnost tlačítka ukázky. Pouze lokální změna, bez push/deploye a restartu workeru.

### 2026-09-10 — Viditelný čas konce cooldownu (Codex)

- Pod odpočtem je nově přímo „Konec pauzy v HH:mm“ v místním čase zařízení, podle pozdějšího konce obou pauz. Není nutné otevírat Podrobnosti. Neověřený stav dál neukazuje slíbený čas odemčení; konec času nezapíná kopírku ani neruší ostatní blokace. Lokální UI změna a render regrese, bez push/deploye či restartu.

### 2026-09-10 — Další příčiny opakovaného banneru deníku (Codex)

- Browser log doložil `dashboard-read-invalidated` na background paginaci bez abort signálu a několik `dashboard-refresh-timeout`; poslední timeout následoval těsně po dokončení základních stránek před hydratací poznámek.
- `authStateVersion` se dosud zvyšoval při každém Supabase auth eventu. Stejno-uživatelské SIGNED_IN/TOKEN_REFRESHED/INITIAL_SESSION už nezneplatňují rozpracované čtení; změna uživatele, odhlášení, USER_UPDATED a bezpečnostní události dál ano. Regrese ověřují i logout/login stejného uživatele.
- Background recovery má 60s celkový limit pro vícestupňové načtení místo 20s; jednotlivé paginované/notes requesty max 20s. Abort signál se propisuje do obou hydrátorů soukromých poznámek a pozdní výsledky se odmítnou. Chyba fallback requestu obsahuje tabulku a DB code; success log je nově až po dokončení poznámek/cache, nikoli po samotných základních stránkách.
- 68 testů v 7 souborech prošlo; po doplnění abort regresí samostatně 23 notes testů prošlo. Typecheck při zápisu stále běží. Finální browser ověření obnovy není potvrzené: po reloadu CDP operation exceeded deadline. Netvrdit, že banner už zmizel nebo je produkce opravená. Bez DB/RLS změn, deploye či broker akcí.

### 2026-09-10 — Kompaktní cooldown a izolovaná lokální ukázka (Codex)

- Pouze localhost: `CopierCooldownPanel` ve skupině na desktopu i mobilu ukazuje maximum z `entryCooldownUntil` a `pause.until`. Dvě samostatné položky vysvětlují situaci, kdy 15min cooldown skončil, ale 20min pauza pravidel ještě běží. UI blokace zapnutí nyní zahrnuje i tuto pauzu, včetně menu; vypnutí zůstává dostupné. Runtime ani broker logika se nemění.
- Konec odpočtu má jemnou animaci a desetisekundové potvrzení pouze uplynutí času, nikdy automatický ARM ani tvrzení o flat účtech. Neověřený worker zobrazuje pomlčku; kill switch, denní zámek, spojení a reconciliation/outbox problémy nedostávají úspěšnou dokončovací animaci. Časování je uvnitř panelu, ne celé tabulky; respektuje reduced motion a po dokončení se uklidí.
- DEV + loopback-only tlačítko `Ukázka cooldownu` otevírá samostatný dialog se simulovanými daty. Alternativa `/cooldown-preview.html`. Tlačítka 10 s / 20 s / 02:48, scénáře vypnutá kopírka / neověřený worker / denní zámek. Demo nemá execution adaptéry, neukládá falešný stav do runtime či localStorage a není součástí produkčního bundlu (ověřeno hledáním demo textů v dist).
- Browser ověřil otevření dialogu přímo v LIVE, vizuální odpočet, přechod na 00:00 s textem „Kopírka zůstává vypnutá. Sama se nezapne.“ a neověřený stav bez falešného odpočtu. Typecheck, scoped lint a build prošly (jen běžné upozornění na velké chunky). Regrese pokrývají 15/20min mezeru, desktop/mobil, blokaci ARM a dostupnost DISARM. Bez push/deploye, restartu workeru a obchodních příkazů; souběžné změny druhého agenta zachovány.

### 2026-09-10 — Expirace historického DISARM upozornění (Codex)

- Na výslovný požadavek uživatele se oznámení posledního vypnutí zobrazuje pouze 15 minut od události; poté zůstává incident jen v Událostech. Společné časové pravidlo pro detail skupiny, horní notice i popisek vypnuté kopírky, s timerem pro expiraci bez dalšího pollingu.
- Jde pouze o životnost UI oznámení, ne potvrzení výsledku: lastDisarm/history, unknown outcome, ARM gate, reconciliation a kill switch beze změny. Žádné broker akce ani deploy.
- 14 cílených testů prošlo (časová hranice, 12h starý incident, zachování historie a bezpečnostních stavů). Browser potvrdil načtený LIVE Dashboard/skupiny bez starého oznámení.

### 2026-09-10 — Historický DISARM bez duplicitního banneru (Codex)

- LIVE Dashboard potlačuje horní DISARM notice při dostupném detailu skupiny; během loadingu/chyby a na ostatních záložkách zůstává zachován. Obnova TradingView se tím neschovává.
- Obě podoby nyní uvádějí poslední zaznamenané vypnutí s datem, nikoli jen čas. Detail rozlišuje výsledek při incidentu od aktuálního stavu pozic. Unknown ani nechráněné kopie se nemažou, nepřeklasifikují na flat a bezpečnostní stav runtime se nemění.
- Browser potvrdil jediný panel u skupiny s datem 9. 9. 2026 16:15:18. 12 cílených testů prošlo; bez broker akcí, restartu workeru a deploye. Souběžné změny cooldown UI zachovány.

### 2026-09-10 — Localhost LIVE API a role při obnově deníku (Codex)

- Plain Vite na portu 3000 vracel pro LIVE API HTML. Přepnuto na existující `npm run dev:live -- --host 127.0.0.1 --port 3000 --strictPort` s read-only Tradovate proxy; neautentizovaný status nyní správně vrací JSON 401.
- Opravena vlastní regrese v paginovaném dashboard fallbacku: projekce `profiles` vynechávala `role`, takže mapper vracel `friend` a uzamkl LIVE skutečnému ownerovi. Nyní se přenáší databázová role; přidány regresní případy owner/friend/user bez změn oprávnění nebo RLS.
- Ověřeno v přihlášeném browseru: LIVE zobrazuje skupinu, leadera a dva followery, kapitál a P&L, bez chyby neplatného API. Existující fail-closed varování zůstává viditelné, kopírka OFF. 29 cílených testů + typecheck prošly. Zůstávají nesouvisející Recharts layout warnings.
- Bez ARM/Flatten, restartu workeru, produkčních změn, commitu nebo deploye.

### 2026-09-10 (Codex, lokální obnova cloudových dat dashboardu)

Diagnostika localhostu potvrdila `get_dashboard_data` chybu `57014 canceling
statement due to statement timeout`; dřívější souběžné `Failed to fetch` /
Realtime chyby samy neurčovaly příčinu. Globální banner navíc přetrvával po
návratu sítě: online handler pouze nastavil networkOnline.

Lokálně doplněn `dashboardRecovery`: jeden request současně, 20s deadline,
abort při cleanupu, backoff 5–60s, obnova při online/focus/visibility a ruční
opakování. Úspěch musí být úplný, cache ani dílčí pull-refresh banner nesmažou.
Recovery načítá potvrzené owner-scoped tabulky po 100 řádcích přes
`dashboardFallback`, nikoli opakovaně pomalou agregaci. Původní RPC při 57014
také přechází na tuto cestu. Projekce trade polí zachovává stávající mapper;
private notes hydratace zůstává. Žádné neúplné tabulky se neaplikují.
Banner říká, že se týká deníku, na LIVE výslovně nehodnotí broker/worker.

Ověření: 26 cílených testů (recovery, paginace a izolace session), typecheck,
produkční build a lint nových modulů prošly. Nový banner a probíhající
obnova byly viditelné na localhostu. Finální úspěch paginované obnovy proti
cloudu NEPOTVRZEN: browser kontrola skončila CDP timeoutem; neoznačovat
serverový výkon za opravený. Změny necommitnuté, bez push/deploy, bez změny
DB, workeru či broker příkazů. Zbývá živé ověření a případně samostatné
DB performance šetření se zálohou před jakoukoli vzdálenou změnou.

### 2026-09-08 (Claude, Live Activity: cooldown svítí i po ručním DISARM)

Uživatel: „nesvítí cooldown". Worker měl `entryCooldownUntil` platný (15 min
po SL exitu), ale `armed: false` po ručním vypnutí. Po DISARM + flat server
aktivitu ukončil souhrnem L5 a starter startoval jen při ARM nebo otevřené
pozici, takže K3 odpočet neměl kde svítit.

- `planNativeLiveActivityUpdate.shouldEnd` navíc čeká na vypršení
  `entryCooldownUntil` (stejně jako u day-locku); stav je `COOLDOWN`,
  `mode: idle` → widget vybere layout `.cooldown` (K3).
- `planNativeLiveActivityStart`: odzbrojený a flat runtime dostane trigger
  `daylock:<device>:<until>` nebo `cooldown:<device>:<until>` (identita =
  konec odpočtu, po ručním zavření se do dalšího cooldownu nevrací); push-to-
  start titulky „Denní zámek" / „Cooldown běží". Cron (1 min) to pokryje bez
  tiku, ten zůstává jen pro ARM.
- Po vypršení cooldownu při DISARM následuje souhrn L5 jako dřív.

### 2026-09-08 (Claude, cena pro čekající limit z TradingView CDP — postaveno)

Navazuje na sondu výše. Bezplatný zdroj ceny mimo pozici: grafy TradingView
Desktop přes lokální CDP, které worker už používá pro snímky.

- `services/tradingViewMarketPrice.ts`: `readTradingViewMarketPrices` přečte
  přes `Runtime.evaluate` (read-only výraz, jen `symbolExt()` + poslední
  svíčka hlavní série) VŠECHNY otevřené chart targety (obchodní graf i
  snímkový layout), vrátí `{ symbol bez prefixu, price, at, continuous }`.
  `startTradingViewMarketPriceFeed` = 1 s smyčka bez překrývání, hodnoty
  starší 5 s se nehlásí; nedostupné CDP = prázdný seznam, žádný hluk.
- Protokol `LocalCopierAgentStatus.marketPrices?: CopierMarketPrice[]`
  (jen když je co hlásit); pilot feed spouští při zapnutých snapshotech,
  vypnout jde `ALPHATRADE_MARKET_PRICE=off`; `stop()` ve shutdownu. Ceny
  NIKDY nevstupují do rozhodování copieru, jsou jen pro zobrazení.
- Server `pickNativeLiveActivityMarketPrice`: stejný kořen kontraktu
  (`marketSymbolRoot`: `CME_MINI:MNQ1!` → `MNQ`), stáří ≤ 10 s, přesný
  kontrakt má přednost před kontinuálním `1!` (rollover spread). Použije se
  jen v pending režimu; v pozici zůstává broker P&L cena.
- Widget K2: s cenou ukáže bílou čárku, cenu nad příčkou, fialovou výplň
  k limitu a levou buňku „+18 b k fillu" místo „SL −50 b".
- Testy: `tests/tradingViewMarketPrice.test.ts` (čtení, offline, smyčka),
  updater (výběr ceny, stáří, cizí symbol, pozice beze změny). Celá sada
  3063 testů, tsc, lint, `xcodebuild` widgetu.
- Nasazení: server automaticky (push na main). Worker se instaluje až na
  „nasaď" z čistého stavu (worker deploy politika), widget na „nainstaluj".
  Do té doby pending zůstává bez čárky ceny.

### 2026-09-08 (Claude, sonda: aktuální cena pro čekající limit z TradingView CDP)

Otázka: může worker posílat aktuální cenu, aby K2 ukázalo čárku ceny a body
k fillu? Tradovate API kotace jsou pro prop tokeny zavřené (probe 27. 8.,
`mode: None`). Sonda read-only přes stávající TradingView most:

- TradingView Desktop běží s `--remote-debugging-port=9222` (spouští ho
  `server/tradingViewCdpLifecycle.ts`); worker už přes CDP dělá snímky grafu
  (`services/copierChartSnapshot.ts`), takže kanál i lifecycle existují.
- Cena se čte z poslední svíčky aktivního grafu:
  `window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`
  → `valueAt(lastIndex())[4]`. Aktualizuje se v reálném čase, žádný zásah do
  grafu (health check před/po: symbol i rozlišení beze změny).
- Most argument symbolu ignoruje: kotace pro `MESU6` vrátila MNQ data. Cena
  je tedy vždy cena AKTIVNÍHO grafu; worker ji musí přijmout jen když
  `symbolExt()` odpovídá kořenu kontraktu leadera (MNQ).
- Riziko rollover: graf `MNQ1!` (typespecs continuous/synthetic) neprozradí
  podkladový kontrakt; v týdnu před expirací může leader obchodovat Z6,
  zatímco `1!` ještě ukazuje U6 (rozdíl = kalendářní spread). Bez konkrétního
  kontraktu na grafu se cena musí brát jako orientační, nebo přijmout jen
  když je na grafu přímo `MNQU6`/`MNQZ6`.
- Bez TradingView / bez CDP: `/json/version` neodpoví → cena chybí → K2 bez
  čárky (dnešní stav). Žádný pád.

Návrh (neimplementováno): worker 1× za sekundu `Runtime.evaluate` na
aktivní graf, do `status` přidat `{ marketPrice, marketSymbol, marketAt }`;
server propustí `currentPrice` jen při shodě kořene symbolu a stáří ≤ 5 s;
widget už čárku, výplň i „b k fillu" umí.

### 2026-09-08 (Claude, Live Activity K2: čekající limit s bracketem)

Uživatel po opravě dvou připojení viděl „LIMIT BUY", ale jen hlavičku — widget
měl pro pending jediný řádek „Čeká na fill". Předloha K2 z mockupů má příčku
SL → limit → TP a buňky s rizikem a cílem.

- `nativeLiveActivityBrokerSnapshot.ts`: `pendingOrder` nese `stopPrice`,
  `targetPrice` (leaderovy pracovní příkazy opačného směru na stejném kontraktu,
  qty ≥ vstup, jednoznačné; OSO děti jsou před fillem „Suspended", tedy
  ne-terminální) a `groupQuantity` (součet stejných čekajících vstupů přes
  účty skupiny).
- `nativeLiveActivityUpdater.ts`: v pending režimu jdou do stavu `stopPrice`,
  `targetPrice`, `stopPnlText`, `targetPnlText` z bracketu × skupinové množství
  × hodnota bodu. `currentPrice` mimo pozici není (Tradovate REST kotace
  nedává, worker cenu neposílá) → příčka bez čárky, buňky ukazují body od
  limitu, riziko, cíl a R.
- Widget: `pendingContent` + `LiveActivityPendingBar` (tlumená dráha, fialový
  zářez + popisek „limit", SL/TP popisky; bílá čárka a cena jen když
  `currentPrice` přijde). Bez bracketu zůstává původní řádek.
- Kompilace `xcodebuild … generic/platform=iOS CODE_SIGNING_ALLOWED=NO` prošla;
  do telefonu se nasadí s příští čistou instalací (spolu s restartem po
  ručním Ukončit v Nastavení).

### 2026-09-08 (Claude, Live Activity: broker snapshot přes všechna OAuth připojení)

**Problém:** limit buy zadaný na leaderovi se v Live Activity nikdy neukázal jako
„LIMIT BUY" (pending). Diagnostika z `nativeLiveActivityBrokerSnapshot` ukázala
`leaderRawOrders: []` při `leaderAllowed: true` — token, kterým tick četl, vůbec
neviděl účet leadera. Příčina: uživatel má **dvě** Tradovate OAuth připojení
(Lucid = leader, Tradeify = followeři), Mac worker běží se dvěma copier
zařízeními (jedno na připojení, `connections.json` manifest) a Tradovate listy
(`/order/list`, `/position/list`, `/cashBalance/list`…) vrací jen účty
vlastního loginu. `createNativeBrokerSnapshotLoader` bral token jen z
`runtime.connection_id` zařízení, které zrovna pollovalo → snapshot skupiny byl
poloviční (bez leadera), takže chyběl pending, P&L leadera i jeho SL/TP.

**Řešení:**
- `server/nativeLiveActivityBrokerSnapshot.ts`: fetch rozdělen na per-token
  `loadBrokerRawBundle` (listy, kontrakty, cash snapshoty otevřených účtů) a
  `mergeBrokerRawBundles` (dedupe pozic podle účet+kontrakt, příkazů a verzí
  podle id, cash snapshotů podle účtu; `complete` flagy AND). Výpočet zůstal
  stejný nad sloučenými daty. `loadNativeLiveActivityBrokerSnapshot` přijímá
  `accessTokens[]` (`accessToken` zůstává kompatibilní).
- `server/tradovateOAuthStore.ts`: `listConnectedTradovateConnectionIds`.
- `server/nativeLiveActivityUpdater.ts`: pro rozsah skupiny (Live Activity)
  loader tahá tokeny všech připojených OAuth připojení uživatele (runtime
  připojení první); cache klíč `user:group:<účty>`. Rozsah `allAccounts` (cron
  sběr účtů) zůstává per připojení, jinak by se účty duplikovaly. Fail-closed:
  když token kteréhokoli připojení chybí, snapshot je null (bez pushe), ne
  poloviční P&L.
- Test v `tests/nativeLiveActivityUpdater.test.ts`: leader na druhém loginu →
  pending rozpoznán a účty sloučené; jednotokenové čtení zůstává slepé.

**Poučení:** „copier skupina = jedno Tradovate připojení" byl tichý předpoklad
na serverové straně; worker s ním nikdy nepracoval (manifest hlídá, že účet
patří právě jednomu připojení). Každý serverový čtenář broker dat pro skupinu
musí iterovat připojení.

### 2026-09-08 (Claude, Live Activity: duplicitní aktivity, jedna na uživatele, lokální fallback)

Z logu telefonu (syslog přes USB, `App{ActivityKit}`, `liveactivitiesd`,
`WidgetRenderer_Activities`): každý push-to-start založí NOVOU aktivitu, i když
už jedna běží — po opakovaných startech (reinstalace, ruční resety triggeru)
běžely na zámku 3+ aktivity a zámek ukazoval tu nejstarší (s rozbitou
hlavičkou ze staršího buildu). Vykreslování samotné je v pořádku
(„Evaluated inner view with result: LIVE"). Zároveň appka lokálním záložním
syncem (`nativeWidgetSnapshot.syncLiveActivity`) přepisovala aktivity
vlastním, chudším payloadem — `isNativeLiveActivityRemoteManaged()` bylo po
restartu appky chvíli false.

Opravy: (1) tik drží **jednu aktivitu na uživatele** — starší odběry dostanou
`end` (dismissal 2 s) a `expires_at`; test v `nativeLiveActivityTick.test.ts`.
(2) Příznak „remote managed" je trvalý v localStorage (nastaví se po první
přijaté registraci, smaže při odhlášení), takže lokální fallback po startu
appky neběží. (3) Hlavička zámku: levý sloupec `frame(maxWidth: .infinity)`
místo `layoutPriority`, `privacySensitive` jen u peněz (na zamčeném zámku se
„LIVE" a titulek ztrácely). Poznámka: `.env.vercel.txt` nemá APNs klíče,
lokální „end" se poslat nedá — dělá to nasazený tik. Ruční expirace odběrů
„expired-by-reinstall" byla omyl (aktivity žily), vráceno.
### 2026-09-08 (Claude, Live Activity: heartbeat mimo pozici a start z tiku; diagnóza „prodlevy")

Diagnóza z DB (read-only přes service key): aktivita po zapnutí 09:39 běží,
odběr aktualizací je registrovaný a tik ho každých 5 s obsluhuje, ale mimo
pozici tik neposílal žádný heartbeat (jen při změně obsahu), takže „před X s"
na zámku rostlo až do 110s heartbeatu cronu — to uživatel vnímal jako
zpoždění. Start aktivity dělal jen cron (až 60 s po ARM). Buy limit se
neukázal, protože v tu chvíli aktivita po čisté reinstalaci neběžela (appka
nebyla spuštěná → bez registrace tokenů).

Změny v `server/nativeLiveActivityTick.ts`: heartbeat 45 s i mimo pozici
(20 s v pozici zůstává); bez aktivního odběru tik zavolá
`startNativeLiveActivities` pro daný runtime (dedup podle session triggeru,
throttle 15 s per instance), takže aktivita naskočí do ~5 s po ARM místo
cronu. Testy rozšířeny. Poznámka: v DB zůstává 6 aktivních push-to-start
řádků z předchozích instalací (APNs je zatím nevrací jako Unregistered) —
neškodí, staré instalace nic nezobrazí.
### 2026-09-08 (Claude, LIVE: jedna stavová lišta místo tří informačních karet)

Uživatel chtěl tři informační prvky nad skupinami (karta stavu workeru s
„Worker hlásí problém", zelená karta TradingView snímků a panel odzbrojení
ve skupině) sjednotit a zminimalizovat: „jen když TradingView snímky vypadnou,
nějaké tlačítko, jinak čisto", detaily přesunout do Událostí.

- **`LiveStatusStrip` + čistý model `services/liveStatusStrip.ts`:** čtyři
  chipy Worker · Broker · Kopírka · Snímky (tečka + slovo). Zdravý stav je
  šedý; problém zbarví jen svůj chip a vysvětlení nese tooltip. Jediné
  tlačítko „Obnovit TradingView" jen při `cdp-offline` s `repairSupported`.
  Jediná věta pod chipy jen pro automatické odzbrojení s nepotvrzeným
  výsledkem kopií (`left-open-unprotected` / `unknown`) — to nesmí zapadnout.
  `lastError` workeru se v liště neukazuje vůbec: po reconnectu zůstával viset
  („Worker hlásí problém" vedle „Broker stream Připojený"), takže by oranžová
  ztratila význam. Chip Worker při `reconciliationRequired` říká „Čeká na
  ověření účtů", ne jen barvu.
- **Panel odzbrojení ve skupině** (`CopierDisarmPanel`) jen pro
  `trigger !== 'manual'`, bez rozbalovacího technického detailu a historie
  (detail zůstává v tooltipu). Ruční vypnutí = čistě vypnutá kopírka.
- **Záložka Události** dostala nahoře `CopierEventsPanel`: worker, broker,
  ověření účtů, poslední chyba workeru, stav snímků s časy kontroly a
  posledního uloženého snímku, a celá historie odzbrojení (ruční šedě,
  automatické s dalším krokem a technickým textem).
- Smazán `LiveRuntimeStatus.tsx`, z `LiveCopyTradeOverview` odešly
  `SnapshotHealthBanner`, `snapshotHealthMessage` (přesunuto do
  `liveStatusStrip.ts`), props `snapshotHealth`/`onRepairSnapshots`/
  `disarmHistory`; oprava snímků se volá z desku (`repairSnapshots`).
  `copytrade-preview.tsx` přepnut na lištu.

Ověření: tsc čisté, lint změněných souborů beze změny, testy
`liveStatusStrip.test.ts` (model + render lišty a panelu Událostí) a upravený
`liveCopyDisarmPanelRender.test.ts` (ruční vypnutí bez panelu), celá sada
3030 zelená. Na localhost:3000 s reálným workerem: lišta „Worker · Broker
Připojený · Kopírka Vypnutá · Snímky Připravené", žádná karta, žádný panel po
ručním vypnutí; Události nesou lastError, časy snímků i 4 odzbrojení dne.

Navazující: řádek „odmítnutý příkaz" pod účtem visel dny (limit množství z
3. 9., InvalidPrice). Pravidlo v `services/rejectedExecutionVisibility.ts`:
nevyřešené odmítnutí (follower není potvrzeně flat) je vidět vždy;
vyřešené zmizí s koncem Tradovate session (`sameTradovateSession`, hranice
17:00 CT, nová v `copierArmSession.ts`) nebo dřív křížkem. Zavření je jen
na tomto zařízení, v localStorage `at:live:rejection-dismissed` s expirací
na konci session, přes `useSyncExternalStore` bez prop drillingu; worker
se nemění. Překlad rejectů rozšířen o `quantity-limit` („Broker odmítl:
limit množství (max 2, požadováno 3)") a `invalid-price`; originál zůstává
v tooltipu. Testy: pravidlo + úložiště, překlad, render křížku.

Doladění po zpětné vazbě: Live Dashboard je úplně čistý — lišta chipů se tam
vykreslí jen v tichém režimu (`quiet`): chip Snímky s tlačítkem obnovy při
CDP offline, nebo bezpečnostní věta po automatickém vypnutí; jinak nic.
Plná lišta je nahoře v Událostech nad `CopierEventsPanel`. Risk je i na
desktopu jeden klepnutelný řádek (varianta `compact` z mobilního commitu
65a894bb) až pod skupinami, aby byly obchody vidět hned. Při sloučení
s `origin/main` (mobilní layout) zůstal `LiveRuntimeStatus.tsx` smazaný;
jeho test v `liveCompactHeaderRender` přepsán na `LiveStatusStrip`.

### 2026-09-08 (Claude, telefon: pozice první, kompaktní Risk a stav, indigo lišta, vlastní menu Více)

- **LIVE na telefonu** (`useCompactViewport`): skupiny s pozicemi jsou hned
  pod stavem workeru; karta Risk je jeden klepnutelný řádek
  (`LiveRiskSummaryCard compact`: Ztráta / Ztrátové / Obchody / Nejblíž,
  zámek či pauza jako pilulka, odkaz do záložky Risk) a stav workeru je jeden
  řádek s tečkami (`LiveRuntimeStatus compact`). Banner snímků až pod
  skupinami. Desktop beze změny. Testy `tests/liveCompactHeaderRender.test.ts`.
- **Nativní lišta**: vybraná karta v indigu (indigo-400 v tmavém, indigo-600 ve
  světlém) místo azurové — stejný akcent jako web.
- **Menu Více**: místo systémového `UIAlertController` vlastní spodní panel
  (`AlphaTradeMoreMenuView`, SwiftUI přes `UIHostingController` s custom
  detentem, iOS <16 fallback `.medium()`): přepínač světa nahoře, cíle mimo
  lištu s ikonami, barvy podle tématu (navy / paper / oled). Žádná broker akce.
- Ověření: 324 souborů / 3040 testů, tsc čistý, iOS build z CLI, čistá
  reinstalace do telefonu.
- Doladění (tentýž den): v tmavém režimu je vybraná karta lišty bílá a
  ostatní tlumené (jako webová BottomNav), světlý režim zůstává indigo.
  Spodní panely (filtry `FilterDropdown`, „Upravit dashboard") se v
  Capacitoru vysouvaly pod nativní lištu — třída `native-bottom-sheet`
  (`html.native-shell` → `bottom: var(--native-shell-tab-bar-height)`).
- Průšvih a poučení: `ios:doctor` po změně menu Více selhal (kontrola
  starého literálu), a protože byl `npm run ios:sync` řetězený přes `| grep`,
  chyba prošla a telefon dostal dvakrát starý web bundle (08:07) → „filtry
  jsou stále pod lištou". Oprava: doctor přijímá nový tvar položky menu,
  řetězení přes `set -o pipefail` + `&&` s logem do souboru. Lišta je nově
  bez systémového materiálu, jen lehký tón (uživatel chce vidět obsah pod
  ní); doctor to připouští výslovně.

### 2026-09-07 (Claude + uživatel, nový vzhled Live Activity „J5D")

Vzhled zamčené obrazovky vybrán z živých mockupů (artefakt „Live Activity
návrhy", varianty A–J): **velké P&L** (34 pt, celé dolary) a pod ním
„LONG 2 MNQ · kopíruje se 3/3", vpravo pilulka **LIVE** (místo „ARM LIVE")
a „před X s" tikající lokálně; **přechodová lišta SL→TP** svítí jen od SL
po aktuální cenu, zbytek zhasnutý, bílá čárka jen přes lištu, bílá cena nad
ní, zářez na vstupu, ceny SL / vstup / TP pod lištou; dole dvě buňky
„−68 b k SL / −$129" a „+22 b k TP / +$231". Spodní řádek s ARM odpočtem a
followery zrušen. Rozbalený Dynamic Island má stejnou lištu v kompaktní
podobě; kompaktní ostrůvek beze změny.

Server (`planNativeLiveActivityUpdate`) nově posílá `pnlCompactText`,
`stopPnlText`, `targetPnlText` (P&L při zásahu úrovně přes všechny účty,
hodnota bodu ze serveru); body k SL/TP počítá widget z cen. Starší payload
bez nových polí se ořízne z `pnlText`. Testy
`tests/nativeLiveActivityLevels.test.ts`; tsc čistý; celá sada zelená; iOS
build z CLI, čistá reinstalace. Vizuál se fyzicky ukáže až při příští
aktivitě (po reinstalaci se aktivita nespustí sama, až s dalším ARM).

**Obrazovky mimo pozici (2026-09-08, vybrané L2 / L4 / L5 z mockupů):**
rozvržení karty se řídí stavem — kritický (DIVERGENCE / KILL SWITCH /
STUCK OUTBOX: celá karta červená, stav jako hero, důvod, pozice dole),
pozice (J5D), **shrnutí dne** po DISARM+flat (`mode: 'summary'`, hero denní
P&L z copier ledgeru, „Den uzavřen · n obchodů · k ztrátových", obchody
jako čipy SL/TP/M, nejlepší / nejhorší / podle plánu; `dismissal-date`
15 min místo 30 s), **zámek / cooldown** (hero = lokální odpočet, důvod,
poslední obchod + denní P&L, limity), čekající limit (hero LIMIT BUY/SELL),
**po obchodu** (hero denní P&L, „Dnes · 3 obchody · 1 ztrátový · kopíruje se
3/3", čipy, řádek limitů Ztrátové / Ztráta / Obchody — blízko limitu
oranžově, spuštěno červeně, vypnuté pravidlo se neukazuje) a **zapnuto bez
obchodu** (hero LIVE bez pilulky, „Kopíruje se 3/3 · zapnuto HH:mm",
„Čeká na první obchod · session končí HH:mm", nulové limity). Server posílá
`dayTrades` (≤8, chronologicky, z `dailyStats.recentClosedTrades`),
`tradesToday`, `losingTrades`, `dayPnlText`, `dayLossUsd`, limity ze safety
skupiny (0 = vypnuto → neposílá se), `armedAt`, `sessionEndAt`,
`cooldownUntil`, `dayLockUntil` + `dayLockReason`. Testy rozšířeny (38 v LA
sadě, celkem 3020 zelených), tsc čistý, iOS build z CLI, čistá reinstalace.

### 2026-09-07 (Claude, Live Activity na zamčené obrazovce: 5s tik z relay pollu)

Live Activity dostávala P&L jen z minutového cronu, takže na zamčené
obrazovce bývalo číslo 1–2 minuty staré. Nový modul
`server/nativeLiveActivityTick.ts` běží uvnitř `poll` akce copier relay
(worker volá každých ~750 ms) a při **armovaném** copieru pošle ActivityKit
update nejvýše jednou za **5 s** ze stejného read-only Tradovate snapshotu a
stejného plánovače (`planNativeLiveActivityUpdate`) jako cron — význam P&L,
SL/TP a stavů se nemění, žádný broker příkaz na této cestě nevzniká.

Pravidla tiku: pokus se zapisuje do `updated_at` odběru i při skipu (nezměněný
obsah nevyvolá snapshot při každém pollu); push jde při změně hashe, při
`end`, nebo jako heartbeat po 20 s při otevřené pozici; `stale-date` je
30 s při otevřené pozici, jinak zůstává 180 s cronu. Tik má rozpočet 2,5 s
(`Promise.race`), po něm poll odpoví bez čekání, ať kick/příkazy nezpozdí;
chyba tiku se jen zaloguje. Bez ARM tik neběží — DISARM/konec aktivity dál
řeší cron do minuty. Info.plist už má `NSSupportsLiveActivitiesFrequentUpdates`.
Worker se nemění (žádná reinstalace), stačí deploy webu/API.

Ověření: `tests/nativeLiveActivityTick.test.ts` (throttle, heartbeat,
stale-date, chybějící snapshot, timeout), rozšířený
`copierRelayApiDetailedReview` (tik jen bez příkazu, přežije selhání);
`tsc` čistý mimo `extension/`; celá sada vitest zelená. Fyzicky ověřit při
příští otevřené pozici: P&L na zamčené obrazovce se má hýbat po ~5 s.
### 2026-09-07 (Claude, ARM LIVE bez připravených snímků — varování a nabídka opravy)

Uživatel: dnes se zase nepořídil ENTRY/EXIT snímek. Diagnóza z agenta a logu:
TradingView bylo 6. 9. ve 21:37 spuštěné ručně bez CDP (`snapshotHealth.state
= cdp-offline`, worker to zalogoval hned a znovu při obchodu), banner v LIVE si
uživatel nevšiml. Požadavek: při zapnutí kopírky to zkontrolovat, ale zapnutí
nezpomalit; když je to rozbité, dostat notifikaci a případně hned opravit.

Řešení bez zásahu do workeru a bez zásahu do brány `snapshot-repair-blocked`:

- **Notifikace:** `server/copierArmNotification.ts` (vyčleněno z
  `nativeCopierStatePush`, aby ho bez kruhového importu sdílel relay push i
  incident watchdog). `copierSnapshotArmWarning(snapshotHealth)` doplní k ARM
  pushi větu podle stavu (cdp-offline / layout-missing / capture- a
  upload-failed); titulek „Copier: ARM aktivní bez snímků". Relay bere
  `snapshotHealth` z ACK statusu workeru (`copier-relay.ts`, action
  `complete`), watchdog z celého runtime statusu (leží mimo `controller`).
  Starší worker bez `snapshotHealth` = původní text.
- **Kontrola před ARM v LIVE (`TradovateLiveDesk.armLiveGroup`):** čte jen už
  napollovaný `agentStatus.snapshotHealth` (žádný round-trip). Ve zdravém
  stavu, při `checking` nebo bez stavu se ARM nezdrží. Když snímky nejsou
  připravené, dialog: u `cdp-offline` s `repairSupported` nabídne „Obnovit
  TradingView a zapnout" (spustí existující `snapshot-test` + `repairCamera`
  ještě v DISARMED, tj. přesně jak vyžaduje brána workeru, počká až 30 s na
  `ready` a teprve pak pošle `arm-live`) nebo „Zapnout bez snímků"; u
  ostatních stavů jen „Zapnout bez snímků" / „Zrušit". Restart TradingView
  zůstává na potvrzení uživatele kvůli neuloženým změnám layoutu.
  Rozhodovací logika je čistá funkce `services/copierSnapshotArmOffer.ts`.
- Vědomě nezvoleno: automatický restart TradingView po ARM (brána vyžaduje
  DISARMED a restart může narazit na dialog o neuložených změnách) a nový hook
  do `localCopierExecutionAgent` (ARM cesta je bezpečnostně kritická, 30s
  periodický health check stačí).

Ověření: tsc čisté, lint změněných souborů 0 problémů, nové testy
(`copierArmNotification.test.ts`: warning, notifikace, arm offer) + rozšířený
watchdog test; cílená sada 131 testů zelená. Dialog v desku nebyl klikán
naživo, protože ARM posílá skutečný příkaz workeru. Nasazení: jen web/API
(Vercel), Mac worker se nemění.

### 2026-09-07 (Claude, breach jednoho followera odzbrojil celou kopírku — izolace místo DISARMu)

Incident 16:01 (14:01Z): leader 64503883 short 15 MNQ, tři followeři po 15.
Tradeify účet 64310872 narazil na daily loss auto-liq a propka ho zlikvidovala
→ follower flat, leader dál −15. `verifyFollowerMagnitude` to vyhodnotil jako
nesoulad pozic a `failClosed` odzbrojil **celou** skupinu: zbylí dva followeři
(64832671, 64832689) zůstali short 15 s SL/TP z 13:59:45Z a tři následné posuny
SL leadera skončily `blocked leader-replace-unmapped`. Uživatel dojel obchod
ručně. Fail-closed byl formálně správný, ale sebral synchronizaci zdravým
účtům přesně ve chvíli, kdy ji potřebovaly.

Oprava (`copierRuntimeController.ts`): když follower za otevřeného leadera
skončí autoritativně na 0, controller **před** DISARMem provede read-only
`classifyFollowerBrokerBreach` — `listAccountCapabilities` (účet už
nesmí obchodovat) a `listAccountRiskSnapshots` (realizovaná ztráta ≤
−dailyLossAutoLiq, nebo netLiq ≤ minNetLiq). Důkaz → `isolateBreachedFollower`:
durable eligibility `breached` („propka zlikvidovala účet: …“), zrušení
čekajících kontrol daného účtu, audit `skipped` („kopírka pokračuje pro ostatní
followery“), sweep vlastních ochranných noh; skupina zůstává ARMED. Bez důkazu
(chyba čtení, zdravý snapshot) zůstává původní fail-closed. Reconciliace bere
breached účastníka lineage jako očekávaně flat (pozice na něm je dál
divergence). Testy: dva nové v `copierRuntimeController.test.ts` (likvidace →
breached + ARMED; flat bez důkazu → fail-closed), mock broker dostal
`setPosition`. Copier sady 253/253, tsc 0. **Worker zatím na starém bundlu**,
reinstall spolu s fixem zombie socketu na „nasaď“.

Poznámky k limitům: `netLiq` z `accountRiskStatus.maxNetLiq` je trailing
high-water, ne aktuální equity, takže rozhoduje hlavně realizovaná ztráta vs.
auto-liq; Tradovate `adminAction`/`liquidateOnly` zatím nečteme — kandidát
na další, ještě přímější důkaz.

### 2026-09-07 (Claude, kopírka nešla zapnout — zombie WebSocket po spánku Macu)

Uživatel 15:33: „Copier se nepodařilo zapnout … worker nemá živé spojení
s Tradovate“. Diagnóza z lokálního agenta a logů: proces workeru běžel
(start 6. 9. 21:37, PID 781), internet i Tradovate API dostupné, ale poslední
WS záznam byl 6. 9. 21:42:23 „WS CONNECT attempt=2“ — 24 s po zavření víka
(`pmset` Sleep 21:41:59, Wake 7. 9. 06:06). Pak 18 hodin ticho: žádný
heartbeat-timeout, žádný „WS DISCONNECTED“ (ten mlčí při stavu `connected`),
controller `connected=false`, `lastError` z pokusu o ARM. Příčina v
`services/tradovateBroker.ts`: heartbeat začínal
`if (socket !== candidate || candidate.readyState !== 1) return;` — socket,
který po spánku spadl do CLOSING/CLOSED bez `onclose` (undici čeká na TCP,
které už neexistuje), tak každý tik tiše přeskočil a nikdo ho nikdy neuvolnil
ani nepřipojil znovu. Fail-closed zafungoval správně (ARM odmítnut), ale bez
ručního zásahu se stream neobnovil.

Okamžitá náprava: `launchctl kickstart -k gui/$(id -u)/com.alphatrade.copier`
z DISARMED/flat stavu (13:35:25Z); do 10 s `connected=true`, do 3 min
reconciliace hotová a uživatel kopírku ARMoval. Oprava v kódu: heartbeat
u `readyState >= 2` po `closeTimeoutMs` (5 s) zaloguje
`WS ZOMBIE state=… readyState=… reason=no-close-event`, emituje chybu
+ `connection:false`, uvolní socket a naplánuje reconnect `zombie-socket`;
CONNECTING (0) dál hlídá connect watchdog. Test v
`tradovateBrokerReconnect.test.ts` (handshake → readyState=2 bez onclose →
po 4 s nic, po 6 s zombie + reconnect + druhý socket). Broker testy 17/17,
tsc 0. **Worker běží stále na starém bundlu** — reinstall až na „nasaď“
(obchodní den).

### 2026-09-07 (Claude, backtest review: snapshot se točil donekonečna; nůžky replay „neustřihly“)

Snapshot: `html-to-image` 1.11.13 v `createImage` čeká na `img.decode()`
(bez catch — Chromium ho u velkých SVG/foreignObject odmítá `EncodingError`)
a pak na `requestAnimationFrame` (v neviditelném tabu nikdy nepřijde). Obojí
znamená promise, která se nikdy nevyřeší → tlačítko „Pořizuji všechny grafy…“
točí navždy a Uložit je disabled. Reprodukováno v náhledu (skrytý panel:
i `toPng` na 50px divu neskončil). Oprava: `patches/html-to-image+1.11.13.patch`
(es i lib) — decode() `then(after, after)`, rAF závodí se `setTimeout(120)`;
plus `captureChartWorkspaceSnapshotDataUrl` má 30 s deadline se srozumitelnou
chybou (`CHART_WORKSPACE_SNAPSHOT_TIMEOUT_MS`, test s fake timery).

Nůžky: kliknutí před aktuální kurzor je v session s obchody záměrně blokované
(`selectReplayStart`, engine je forward-only; BacktestWorkspace to hlásí
„Po zadání objednávky nelze vrátit kurzor zpět“), ale hláška šla jen do
stavového řádku lišty, který je `hidden 2xl:block` — pod 1536 px uživatel
neviděl nic. Teď: workspace zobrazí toast uprostřed (sdílený
`quickOrderFeedback`, přesunutý nad replay callbacky) a graf dostane
`replaySelectionMinimumTime`: náhled nůžek před hranicí je červený s textem
„Nelze vrátit před zpracované obchody“. Otevřená otázka: povolit návrat až k
poslednímu fillu, když je skupina flat a bez pracovních příkazů (bezpečné
přepočítání je no-op) — zatím neimplementováno.

### 2026-09-06 (Claude, dvojklik na splitter grafů vrací dělení doprostřed)

Uživatel: dvojklik funguje jen na hraně čáry, ne uprostřed. Reprodukováno v
náhledu: druhý klik dvojkliku dopadne na dočasný překryv
`flexlayout__splitter_drag` (dítě `flexlayout__layout`, ne splitteru), takže
původní `closest('.flexlayout__splitter')` neuspěl; syntetický dblclick
fungoval, myší ne. Oprava v `AlphaTradeChartWorkspace`: capture `pointerdown`
si pamatuje poslední splitter (`data-layout-path`), dvojklik na překryv do
700 ms se k němu přiřadí a vyrovnání běží po `setTimeout(0)`, aby ho flexlayout
drag-end nepřepsal. `centerMainSplit` nahrazeno `centerSplitter(path)`: parsuje
`<rodič>/s<i>` a vyrovná váhy jen dvou sousedů daného splitteru (funguje i pro
vnořená dělení; ostatní panely si šířku drží). Ověřeno reálným dvojklikem do
středu i na hranu (332/734 → 533/533, 779/287 → 533/533); tsc čistý, chart
workspace testy 49/49.

Doplněk (problik): uživatel hlásil při dvojkliku „zvláštní problik“. Příčina:
`workspace.importLayout(next)` hydratuje nový FlexLayout `Model`, takže se oba
panely s grafy odmontují a namontují znovu. Oprava: `patches/@getcandlekit+
charts+0.1.0.patch` přidává do driveru adaptéru `getModel: () => modelRef.current`
(index.js i index.cjs) a `centerSplitter` nejdřív zkusí živý model —
rodiče splitteru najde přes `Model.visitNodes` (kořen = řada bez rodiče) a
zavolá `Actions.adjustWeights(parentId, weights)` se zprůměrovanými vahami
dvou sousedů. JSON export/import zůstává jen jako fallback bez živého modelu.
Ověřeno v náhledu: reálný dvojklik do středu 733/333 → 533/533 a označené
DOM prvky `.flexlayout__tabset` si zachovaly identitu (žádný remount).
tsc 0, chart workspace testy 49/49.

### 2026-09-06 (Claude + uživatel, Documents checkout přepnut na main)

Po výslovném souhlasu („udělej to bezpečně“): záloha špinavého stromu do
`~/Documents/AlphaTrade-backups/2026-09-06-203817-documents-dirty-tree/`
(tarball 481 souborů, `tracked-changes.diff` 1,3 MB, `git-status.txt`,
`HEAD.txt`) a druhá pojistka `git stash@{0}` „documents-dirty-tree-20260906“.
`git cherry origin/main` potvrdil, že tři lokální commity větve
`codex/ios-native-checkpoint-20260814` už jsou v main patch-ekvivalentně.
Pak `git checkout -B main origin/main`: strom čistý, HEAD = origin/main,
`.env.local` a `node_modules` nedotčené. Hlavní checkout je od teď
plnohodnotný `main`; stará větev zůstává lokálně jako historie.

### 2026-09-06 (Claude, triáž ~300 necommitnutých souborů v Documents checkoutu)

Trojcestné porovnání (společný základ 479a5c3d, origin/main, pracovní strom):
86 souborů shodných s main, 257 untracked shodných s main, 21 s lokální změnou
už obsaženou v main, 19 „konfliktních“ — u nich kontrola identifikátorů ukázala,
že strana Documents je starší forma toho, co main už má jinak (copier core
z 2. 9., iOS/LIVE review z 5. 9.; v main chybí jen zbytky staršího business
loadingu v App.tsx, které se brát nemají). 36 untracked lišících se = macOS
companion, lib/macCompanion*, notificationDelivery, leaderFlatGuard — ve všech
je main novější (3.–6. 9.) než Documents (31. 8.–1. 9.). Jediné unikátní a
hodné zachování: novější design canvas menubar companionu (17 vs 12 artboardů)
a launch konfigurace `alphatrade-main` — commit 832fab6b (jeho zpráva zmiňuje
i 24 evidence logů; ty jsou gitignorované `*.log`/evidence a v repu záměrně
nejsou). Závěr: Documents checkout už nenese žádnou nezachráněnou práci a lze
ho bezpečně přepnout na `main` — čeká na výslovný souhlas uživatele (destruktivní
krok, ~300 souborů). Podrobná tabulka: scratchpad `documents-triage.md`.

### 2026-09-06 (Claude, záchrana rozdělané práce Codexu v backtestu)

Codex předplatné skončilo; uživatel: „Codexovi už nic nezadávej.“ Jeho poslední
backtest práce nebyla v `main`: (1) worktree
`/private/tmp/alphatrade-backtest-performance-20260906` nad `cf7f98bf` se 44
necommitnutými soubory (worker pro analytiku, bounded cache, hydratace, FVG/
viewport úspory, odstranění rozhodovacího deníku; viz dva zápisy Codexu níže),
(2) hlavní checkout v Documents, kam Codex přenášel „canonical“ patche a kde
navíc udělal dialog „Stav session“ místo pevného horního panelu (přání uživatele)
a funkci „ceny obchodů na cenové ose“ (`trading.orderPriceLabels`, 7 souborů).
Kopie v `~/Downloads/alphatrade-mentor-15` už není repozitář (jen zálohy).
Obnova na čisté větvi nad `main a999862e`: tracked diff worktree (bez logu) +
nové soubory, potom pouze štítkové a Stav-session hunky z Documents; App.tsx
z Documents záměrně NE (je tam starší než main). Ověření: tsc čistý, celá sada
a produkční build viz commit. Zbytek 303 necommitnutých souborů v Documents
zůstává nedotčený (mix starých a nových změn, vyžaduje samostatné třídění).

### 2026-09-06 — Codex: odstranění rozhodovacího deníku z backtestu

- Na žádost uživatele odstraněn celý rozhodovací deník: tlačítko, panel, zápisy/revize/export rozhodnutí, registry pro snímky grafu a samostatná služba s jejími testy. Z backtest runtime typu odstraněn aktivní model tohoto deníku.
- Poznámky/tagy/historie poznámek/screenshoty u skutečných obchodů, kvalita dat, strategy research binding a záznam času vstupu zachovány. Starý JSON při načtení/uložení zůstává průchozí; žádné mazání uložených uživatelských dat ani DB migrace.
- Ověřeno:554testů/49souborů, úplný TypeScript, produkční build a izolovaný browser se3grafy: tlačítko pryč, krok replaye a zavření/uložení fungují, konzole bez error/warn.
- Pouze localhost3001; bez push/deploy. Předchozí soubory jsou pro návrat v `/private/tmp/backtest-decision-removal-20260906/original`.


### 2026-09-06 — Codex: lokální plynulost backtestu

- Po výslovném souhlasu lokální výkonové opravy: worker pro analytiku a mapování, persistentní bounded cache se zachovanými hashi, identity preflight před recovery, samostatná opakovatelná hydratace chybějících UI obchodů, levnější FVG/viewport/cenové čáry a stabilní checkpoint/reference. Poznámky a ruční review zůstávají chráněné.
- Stejná syntetická fixture (3grafy1m/5m/15m,80obchodů,16 561barů,10×): rAFp95 349,1→17,7ms; průměr7,4→56,4rAF/s. Pauza:14longtasks/30,2s→0/49,9s. Jde o jednotlivé lokální vzorky, nikoli garanci všech zařízení/dat.
- BUY→krok→close→reopen ověřen:81řádků, jediný nový closecallback, správný zůstatek po cenovém pohybu a komisích. Celý hlavní projekt2463testů/278souborů, tsc a build PASS.
- Ověřený patch přenesen pod SHA stráží do canonical projektu; další rozpracované App změny zachovány. Localhost3001 aktualizovaný; žádný deploy/push/SQL/broker akce. Důkazy: `docs/reviews/backtest-performance-20260906/README.md`.

### 2026-09-06 (Claude, detail obchodu — screenshot jako výchozí pohled)

Uživatel: v historii obchodů se v detailu ukazoval nejdřív graf a screenshot
až jako druhý; chce to obráceně. Změna v `TradeDetailModal`: výchozí
`visualMode` je `screenshots`, přepínač má pořadí Screenshoty | Graf (desktop
hlavička i mobilní overlay) a při přechodu na další obchod se resetuje na
screenshoty. Aby importované obchody bez jediného screenshotu (a bez copier
snapshotu) neotvíraly prázdnou plochu „BEZ SCREENSHOTU", přepne se po dohrání
lazy-loadu detailu (`detailsLoadedTradeId`) automaticky na graf; ruční klik
na Screenshoty tím není dotčen. Při ověřování se ukázala starší závada:
guard `if (isLoadingDetails) return` v lazy-loadu četl hodnotu ze zastaralé
closure a po zrušeném fetchu (rychlé Další/Předchozí) zůstal spinner zapnutý
a další obchody se už nenačítaly — dříve neviditelné, protože default byl
graf. Guard odstraněn a větev „screenshot už je v props" spinner vypíná.
Ověřeno v náhledu na main (port 5274): obchod s 2 copier snapshoty se otevře
rovnou na obrázku (1 / 2), obchod bez snapshotů skončí na grafu, 6× rychle
Další a 6× Zpět nechá správný stav bez zaseknutého spinneru. tsc čisté
(mimo předexistující `extension/` chyby z chybějících chrome typů v
symlinkovaných node_modules), lint souboru beze změny (10 starších warningů).

Navazující požadavek: karta v historii ukazovala pro obchody jen s copier
snapshoty ikonu procesoru, protože náhled bral pouze ruční screenshoty a
privátní snapshoty se podepisovaly až v detailu. Nová služba
`services/copierSnapshotThumbs.ts`: `pickCopierThumbSnapshot` vybere snapshot
po uzavření (`exit`, při více nejnovější), bez něj nejnovější podle `at`;
`getCopierThumbUrl` podepíše jen ten jeden, deduplikuje souběžné požadavky a
drží module-level cache s TTL 50 min (signed URL platí 60 min, do localStorage
se záměrně neukládá). `TradeHistory` podepisuje jen pro vykreslené karty bez
ručního screenshotu, po pěti; ruční screenshot má vždy přednost; chyba
načtení `<img>` copier náhledu ho jednou invaliduje a podepíše znovu místo
DB retry. Platí pro grid i tabulku (obě čtou `getScreenshot`). Testy služby
(8) + ověření na localhost:3000: karty z 2. 9. dostaly signed URL
`…/exit-*.png`, obchody jen se vstupem `entry-*.png`, GET 200 image/png.
Při plné sadě jednou spadl `tradovateCopierDevice` na 5s timeoutu generování
RSA klíče pod zátěží, samostatně prošel.
Doplněk: copier náhled (TradingView auto-foto) se na kartě i v tabulce ořezává
na 80 % šířky (`object-[80%_50%]`, po zkoušce úplného pravého okraje); ruční screenshot zůstává
na středu, protože kompozici určil uživatel. Ověřeno: computed
`object-position` 80% 50% u copier náhledů, 50% 50% u ručních.

### 2026-09-06 (Claude, LIVE detail skupiny — vodorovný posuvník)

Uživatel: v kartě Kopírovací skupiny nešlo v rozbaleném detailu účtů skrolovat
do strany (sloupce Rezerva DD, Exec/Limit, Násobek, Flatten mimo obraz při
~1200 px). Příčina ověřená v DOM: detail leží v animačním obalu
`grid overflow-hidden` + `min-h-0 overflow-hidden` a vnitřní `<table>` (min
šířka 1602 px ze součtu sloupců) neměl žádný vlastní `overflow-x-auto`; vnější
posuvník patří jen tabulce skupin. Oprava: obal tabulky účtů i tabulky příkazů
v `GroupDetail` dostal `overflow-x-auto`. Ověřeno v náhledu (dev:live worktree
na main, viewport 1200 px): scrollWidth 1602 / clientWidth 1040, scrollLeft se
posune. Render testy detailu a tsc čisté. Při 800 px komponenta sloupce sama
redukuje (770 px), posuvník se tam neobjeví, což je správně.

### 2026-09-06 (Claude, volitelné karty nativní lišty + mobilní LIVE karty, přenesené nad iOS release)

Práce z 5. 9. (větev `claude/native-tabs-live-mobile`) byla po Codexově
release iOS oprav (`cf7f98bf`) znovu nanesena nad aktuální `origin/main`,
protože upstream mezitím přepsal `LiveDayRulesCard` (vlastní sbalení s
`at:live:day-rules-collapsed`) a zrušil `CopierDailyStatsSummary`. Rebase
původních commitů byl zahozen, změny se nanesly soubor po souboru.

**Nativní lišta (Swift):** `AlphaTradeTabCatalog` v
`AlphaTradeShellViewController.swift` — tři volitelné sloty z deseti cílů,
pevné Zapsat/Více, volba v UserDefaults (`AlphaTradeShellTabSlots`), menu
Více ukazuje jen cíle mimo lištu, v backtestu jsou LIVE-only položky
disabled. Plugin `getShellTabs` / `setShellTabs` / `setShellPage`; web hlásí
`activePage`, takže lišta zvýrazní skutečnou stránku nebo nic. Volba v
Nastavení → Nativní iOS funkce → „Karty spodního menu"
(`components/NativeShellTabsSettings.tsx`, čistá logika v
`lib/nativeShellTabs.ts`). Výchozí zůstává Dashboard / Historie / Deník.

**LIVE pod 1024 px** (`useCompactViewport`, desktop beze změny):
`CompactGroupCard` místo 900px tabulky — hlavička s přepínačem, řádek
Kapitál / Denní / Otevřený P&L, účty pod sebou s pilulkou stavu, P&L,
pozicemi a důvodem odmítnutí, seznam příkazů se Zrušit, Flatten All /
Upravit / menu; panel Diagnostika dat a API se na telefonu neukazuje;
Pravidla dne začínají na telefonu sbalená, dokud uživatel volbu neuloží.
Dev háček `at:dev:live-copy-fixture` (`lib/devLiveCopyFixture.ts`, jen DEV
build) podstrčí ukázkovou skupinu pro ladění v Browser panelu přes
`npm run dev:live` + `?native=1`.

Ověření: `tsc` bez chyb mimo předexistující `extension/`; vitest 313 souborů /
2982 testů; iOS Debug build z CLI. Instalace do telefonu = čistá reinstalace
(uninstall + install; resetuje oprávnění k oznámením → potvrdit „Povolit").
Telefon do té doby nese Codexův build 1.0 (3) z checkoutu 110 commitů za
mainem, nainstalovaný jako upgrade (riziko rozbité Live Activity z 21. 8.).

### 2026-09-06 (Claude, rollout workeru a companion 18 po sloučení Risk záložky)

Po ranním sloučení celého rozpracovaného checkoutu do `main` (`cf7f98bf`,
350 souborů) ověřeno na čistém worktree: Risk záložka a worker změny přežily,
tsc bez chyb, 2969 testů zeleně. Produkce bundle nový, cron bez nových chyb.
Migrace: pět aplikováno 06.09. 05:18–05:20 přes MCP pod automatickými
verzemi (`20260906051859…052039`), takže `supabase migration list` je
neukazuje pod názvy souborů; přítomnost ověřena přes REST/RPC (outbox,
review patch, historie poznámek, legacy notes privacy, tag library). Trigger
`guard_backtest_research_rule_history_v1` („prepared only") zřejmě
neaplikován — jen ochrana, ne runtime chyba.

Worker: záloha `~/Documents/AlphaTrade-backups/2026-09-06-*-copier-worker-before-risk-reinstall`,
read-only reconciliation `authoritativelyClean`, ARM/disarm v 07:51–07:52 byl
přímý zásah z appky (bez relay záznamu), ne reconciliation. Reinstall
`copier:mac install --adopt-durable-group` z `cf7f98bf` → bundle
`e6451212…`, capabilities `risk-config-v1`, po startu VYPNUTO, `lastError=null`,
druhá reconciliation 0 divergencí. Worker nově čte limity propek i ve VYPNUTO
(leader 64310872: 1 250 USD, 64503883: 1 200 USD). Runtime skupina je
`localOnly` s jedním followerem (64503883) — stav po uživatelově ARM testu,
durable pětice zůstává fallback. Companion build 18 nainstalován (záloha
buildu 17 v `AlphaTrade-backups/2026-09-06-companion-build17`), LaunchAgent
běží. Žádný broker příkaz, ARM ani Flatten z této session.

### 2026-09-06 — Codex: společná release backtestingu, iOS a LIVE oprav

- Do izolované release větve sloučeny rozpracované změny backtestingu/iOS a samostatného LIVE review nad aktuálním produkčním main. Zachováno novější copier jádro, Risk/day-lock a Mac companion; původní pracovní adresáře zůstaly zachované.
- Vyřešeny konflikty dashboardu, šablon, cloudových copy groups a mobilních notifikací. Doplněna ochrana proti starému cloudovému refreshi během ukládání; obrázková notifikace používá durable outbox a 45s deadline bez ztráty textového alertu. Business metadata a obrázky jsou izolované auth epochou.
- Celá integrovaná verze: 311 testovacích souborů / 2 969 testů PASS, TypeScript PASS, produkční build PASS. Native část navíc 100 testů a Swift parser; tento release není nový Xcode build ani instalace telefonu/workeru.
- Před databázovým převodem provedena soukromá záloha dotčených tabulek a ověřena obnova všech 1 659 obchodů. Všech sedm migrací prošlo na skutečných obnovených datech. Produkční migrace chart templates, notification outbox, atomic review, private note history, legacy notes/owner consent, atomic tag library a research rule guard byly aplikovány; zásah do starých poznámek měl samostatný výslovný souhlas uživatele.
- MCP Edge Function nasazena jako verze 12, všech devět vzdálených zdrojových souborů se shoduje s release. Webový deploy bude ověřen proti přesnému SHA, produkčnímu aliasu a runtime logům; tento zápis sám není potvrzením jeho dokončení.
- Omezení: produkci chybí serverový GROQ_API_KEY pro zabezpečený přepis hlasu. Nová historie poznámek ještě nemá kompletní vzdálenou MCP hydrataci. Rozšíření z celé 48bodové backtest roadmapy nejsou všechna implementována. Žádná broker operace ani přeinstalace execution workeru nebyla součástí nasazení.

### 2026-09-05 — Codex: verze výzkumných pravidel, odolnost výsledků a B16

Rozšířil jsem Lab o skutečné revize pravidel, snapshot vazby session/trade a report konkrétní verze/účelu. Cíl i kvalita vzorku používají celé pozice; partial výstupy nezvyšují důkaz. Odolnost počítá citlivost bez top ziskových pozic/dní a blokový bootstrap. Lokálně byla připravena také oprava B16 legacy notes/receiver consent a atomický tag katalog; tag wrapper a strict paginated reader následně dokončené v47 a28 cílených testech. Hlavní integrace katalogu a browser ještě čekají.

Root238 testů/14files, typecheck a build prošly; rule SQL15 invariantů. Browser ověřil změnu verze→failed save→retry bez ztráty/duplikace, oddělení development/validation a uloženou session vazbu. Neviděný OOS není zatím implementovaný. Podrobnosti: `docs/reviews/backtest-second-review-20260905/rule-robustness-validation.md`. Připravených migrací je nyní5; žádná vzdálená aktivace, push, deploy, broker nebo externí AI požadavek neproběhly. Aktivace nadále vyžaduje samostatnou zálohu a potvrzení. Celý48bodový cíl zůstává nedokončený.
 (nejnovější nahoře)

### 2026-09-05 — Codex: jednotlivé mobilní testy notifikací a instalace buildu 3

- Uživatel nemohl posílat testy jednotlivě. Fyzický snímek prokázal tlačítka mimo viewport v min760px tabulce. Settings nyní pod640px zobrazuje osm samostatných karet, desktopovou tabulku zachovává a galerii22 schovává do sekundárního sbaleného detailu. Shared ref blokuje dvojklik a souběh s galerií.
- Za uživatele byl spuštěn jediný lokální rich DEBUG test: iOS potvrdil konkrétní ID s jednou přílohou, doručený počet23→24 a zachování všech30 session připomínek. Předchozí uživatelské „ano“ bylo následně upřesněno jako galerie a není důkazem řízeného jednotlivého UI testu. Textová akce/Face ID/APNs ještě fyzicky neověřeny; Zrcadlení iPhonu systém odmítl jako nedostupné v regionu.
- Skutečný JSX+nové CSS prošly vizuální kontrolou430px/1100px bez horizontálního přesahu; cílené handlery a syntax PASS, scoped lint0errors/5existing warnings, nezávislé review bez blockeru. Nový úplný tsc byl přerušen kvůli RAM, neprohlašuje se za PASS. Native build+scanner/copy, signed Xcode a codesign PASS. **1.0 (3) nainstalováno a spuštěno na telefonu.**
- Canonical Settings integrován pod SHA stráží, ostatní rozpracovaný backtest a jeho výstupy zachovány; phone build vychází z předchozího otestovaného iOS snapshotu + této opravy. Bez simulatoru, produkčního deploye, migrace, klíčů a broker akcí. QA server/tab zavřeny. Důkazy: `docs/reviews/ios-20260905/FIXES.md`, `evidence/mobile-alert-fix.json`.


### 2026-09-05 — Codex: rozhodovací deník a soukromé revize backtest poznámek

- Navazuje na schválenou roadmapu. Přidán deník decisions/prep/note/bookmark/debrief, známý replay kontext, monotónní exposure horizon (legacy unknown), snapshot jednou, revize/opId a export; počty ručních pozorování nikdy nemění obchodní ledger/P&L.
- Review má fázované poznámky s historií a hindsight. Nová historie jde přes připravenou owner-only tabulku/private_v1 RPC; veřejné trades.data ji neobsahuje. Missing capability zastaví save před uploadem. Coach aplikace dostává phase/revision provenance; vzdálené MCP hydration zatím chybí.
- Browser odhalil/final check ověřil pause child replaye, snapshot time mismatch a ochranu draftu. Checkpoint ACK nyní používá mutation generation proti ztrátě změn při stejné milisekundě. Model40tests + notes29 + storage/privacy/Coach46 passed; PostgreSQL WASM11 invariants. Finální integrační156tests/10files, tsc a build passed; scoped lint0errors/11 starších warnings. Důkazy v `docs/reviews/backtest-second-review-20260905/research-validation.md`.
- Nový otevřený B16/P1: původní notes mohou být dostupné v síťové odpovědi public/connection trades přes stávající grants/RLS. Nová private history tuto cestu nepoužívá; legacy serverovou mezeru klientský stripping neopravuje.
- Migrace `20260905173116` a `20260905190446` nejsou aktivované; čeká souhlas se zálohou a cílenou DB změnou. Žádný push/deploy/broker akce/externí AI požadavek. Celá roadmapa zůstává aktivní a nedokončená.

### 2026-09-05 — Codex: opravený iOS build 2 na fyzickém telefonu

- Uživatel připojil iPhone pro pokračování fyzického ověření. Na iPhone 13 Pro Max / iOS 26.6.1 byla instalována aktualizace AlphaTrade **1.0 (2)**, bez odinstalování; systémový dotaz potvrdil nový build. Simulátor zůstal vypnutý.
- Podepsané sestavení s jedinou úlohou a nízkou prioritou, hluboká kontrola podpisu, development APNs/App Group profily a shoda zabalených assetů: PASS. Build vychází z přesného 63souborového manifestu předchozích 19 iOS oprav. Novější rozpracované backtest úpravy zůstaly v repozitáři zachovány a nebyly míchány do otestovaného telefonního buildu.
- Po odemčení uživatelem **spuštění PASS**: fyzický snímek ukazuje dashboard s existujícími daty a spodní navigací; stejný proces zůstal přítomen přibližně minutu po startu. Předchozí blokace `Locked` je vyřešená. Uživatel odpovědí „ano“ nejprve potvrdil doručení/otevření Deníku; následně upřesnil, že přišly všechny testy společně. Jde proto o report galerie, nikoli průkazný test jediného scénáře. Poznámková akce a serverové APNs tím ověřeny nejsou. Face ID a widgetové UI zatím neověřeny. Bez deploye, migrace, rotace klíčů a broker akcí.
- Důkaz a navazující krátký postup: `docs/reviews/ios-20260905/FIXES.md`, `evidence/phone-install.json`. Provedený alert byl pouze lokální na tomto iPhonu; serverový test posílá na všechna zařízení uživatele a neověřuje nový outbox.


### 2026-09-05 — Codex: implementace backtest oprav a první základ roadmapy

- Po schválení „dobře, udělej to“ pokračuje celý plán 48 rozšíření. Přesný stav je v `docs/reviews/backtest-second-review-20260905/IMPLEMENTATION.md`; hotový je první lokální blok, nikoli celá roadmapa.
- B01–B06: analýzy respektují odhalený čas replaye a postupně se doplňují přes trvalou frontu. Opravené pokrytí svíček, gapy, cutoff, slippage, MFE/MAE podle tehdejšího množství, meze nejistoty a čisté R. Lab i lokální MCP používají správný rizikový základ a počty vyřazených záznamů. Staré nedoložené cash metriky mají `legacy-unknown` a null.
- B07–B11: atomické změny jednotlivých polí review a append galerie; šablony chrání vlastník a podmíněný zápis. App posílá skutečné změny s původními hodnotami a při chybě vrací pouze neúspěšná pole, včetně editoru spojených obchodů. Save, Load a Nová session mají společnou lokální knihovnu s výchozí šablonou, náhledem a návratovou kopií.
- B12–B15: úplný JSON pro AI, validace vnořeného importu a povolených instrumentů, experimenty podle času výzkumného zápisu s pevnou výchozí skupinou. Explicitně neznámý recordedAt se při pozdějším uploadu nenahradí createdAt. Mapper dostává načtené HTF svíčky i při ručním přepočtu.
- Základ F01/F03: uchování metadat úspěšných požadavků, SHA-256 manifest, popis exekuce a dialog kvality dat s JSON exportem omezeným na kurzor. Chybějící kalendář, kontrakt nebo revize feedu zůstávají neznámé.
- Ověření: celý Vitest 256 souborů / 2133 testů prošel; po posledních změnách dalších 36 integračních testů, typecheck a Vite build. Scoped lint bez chyb. PGlite ověřil skutečný SQL v 10 scénářích. Browser QA potvrdilo vstup/výstup, časově omezený dopočet 14:03 → 14:04, Save/Load/obnovu a přehled kvality dat. Hlavní Dashboard a Lab se načetly; externí currencyService fetch selhal.
- **Produkční podmínka:** migrace `20260905173116_backtest_review_atomic_patch.sql` je pouze lokální. Před aktivací je potřeba samostatná záloha a výslovný souhlas podle AGENTS; postup je v `DEPLOYMENT.md`. Bez RPC nové backtest ukládání hlásí nedostupnost bezpečného zápisu a zachová draft/frontu. Žádný deploy, push nebo broker akce neproběhly.
- Další práce: verze výzkumných pravidel s vazbou na run/obchod, rozhodovací deník, fázované poznámky a historie odhalení OOS; potom ostatní priority roadmapy. Vedlejší agenti narazili na limit účtu, finální integraci a ověření převzal root.

### 2026-09-05 — Codex: druhý backtest audit a návrh 48 rozšíření

- Uživatel požádal o další kompletní kontrolu a precizní brainstorm. Tento průchod mění pouze dokumentaci/evidenci; nové aplikační opravy ani funkce nebyly implementované.
- Canonical localhost:3001 read-only navigace; izolované syntetické QA:4184 ověřilo market entry/close, komise, lokální obnovení, poznámku a vlastní tag. Testovací server a tab uzavřeny, hlavní localhost ponechán na Backtest Lab.
- Nové nálezy: prefetched budoucnost v journal analytics (browser cursor14:03, path až14:28), neúplná první hodina jako complete, scale-in MFE/MAE, odlišná CF exekuce gap/cutoff a ztracená nejistota, parametrické MC náklady/insolvence. Dále screenshot read failure, souběžný notes/tags JSON overwrite, legacy cleanup při auth/quota, Save→New Session kontrakt, cloud template race, neúplný AI export a dvě importní validační mezery. Lab experiment směšuje čas založení s historickým market timestampem. Podrobnosti/limity důkazu v reportu.
- Validace: 127/127 existujících cílených testů (7 files), 10 diagnostických testů potvrzujících současné chyby, 3 skutečné-module/mock persistence skripty exit0. SHA-256 20 unikátních auditovaných zdrojů při finalizaci shodné. Žádný nový full build/full suite, produkční roundtrip dvou zařízení ani reálný AI/MCP požadavek.
- Výstup: `docs/reviews/backtest-second-review-20260905/README.md`, `ROADMAP.md` (48 možností, priority, velikosti, akceptace), detailní nálezy a evidence. Priorita nejdřív zachování dat a správná analytika; poté příprava→rozhodnutí→review→verze experimentu, OOS a cílený AI trénink. Existující Lab/Monte Carlo/Coach se rozšiřují, neduplikují.
- Aplikační, iOS/copier a jiné rozpracované soubory ostatních nebyly měněny. Žádný commit/push/deploy ani broker action.


### 2026-09-05 — Codex: opravy 19 nálezů iOS review

- Implementované opravy Face ID, mobilního logoutu, oddělení cache podle session, APNs registrace/akcí, časovačů a vlastnictví upozornění. Server má durable per-device outbox s retry/CAS a monotónní discovery hranicí; widgety/Live Activities rozlišují neověřená data a chrání identitu při logoutu. Profitabilní trailing SL zůstává viditelný.
- Groq přesunut na autentizovaný serverový endpoint; nahrávka po chybě zůstává pro retry/export. Rebuilt lokální web/native assets procházejí kontrolou klíčů. Výměna již zveřejněného klíče stále vyžaduje produkční aktivaci.
- Finální integrace zachovala další současné úpravy grafů/backtestu. PASS: 2 000 testů / 241 souborů, úplný TypeScript, lint bez chyb (33 warningů), web/native build, unsigned generic iOS kompilace App + widgetů, ios:doctor. SQL/RLS/CAS ověřené skutečným lokálním PostgreSQL/PGlite. Simulátor se znovu nespouštěl.
- Před serverovým nasazením je NUTNÁ migrace `20260905155220_notification_delivery_outbox.sql`, samostatný export/záloha produkce a serverový `GROQ_API_KEY` s revokací starého klientského klíče. Nebyl push/deploy, vzdálená migrace, rotace tajemství, broker akce ani instalace na telefon. APNs end-to-end ověření vyžaduje nový podepsaný build na fyzickém iPhone.
- Přehled a hranice ověření: `docs/reviews/ios-20260905/FIXES.md`; otisky a výsledky: `docs/reviews/ios-20260905/evidence/fix-validation.json`. Lokální návratové soubory v `/private/tmp/alphatrade-ios-fix-backup-20260905` nejsou zálohou živé databáze.

### 2026-09-05 — backtest layouty, šablony, poznámky a vlastní tagy (Codex)

- Po auditu opraveno zachycení posledního workspace při Close, StrictMode/cloud remount a lazy obnova kreseb. Uložit/Načíst/export/import nyní přenáší kompletní workspace snapshot s validací vstupu a pravdivým local/cloud stavem. Named kopie je lokální per-account/session, run se zároveň flushne svou cloudovou cestou.
- Defaults vzhledu i cache šablon oddělené podle uživatele; serializovaný sync a tombstones brání ztrátě či návratu smazaných šablon. Nepřiřazené staré šablony se importují pouze explicitně. Position šablona zachová pointValue/tickSize cílového instrumentu; opraveny Fib/Position defaults.
- Review má Vlastní tagy s nabídkou z uložených obchodů a HTF/LTF z nastavení. Auto konfluence mají explicitní provenance; přepočet nemaže ruční hodnocení. Same-ID refresh nemaže draft, save blokuje souběžné editace a chyby zachovají formulář. Coach dohledává aktuální poznámky a tagy ve správném live/backtest světě.
- Ověřeno: fullsuite 1895 passed / 1 timing failure (renewal40ms; samostatně3/3passed), finální cílené49/49 + document11/11, full typecheck a Vite/PWA build, scoped lint0errors. Browser synteticky ověřil poznámky/tagy/recalc/retry a Close/Reopen i Save/Load kresby+indikátoru.
- Žádný deploy/push/remote write/broker akce. Automatická kontrola odmítla nové automatické embedding odesílání i MCP předávání poznámek do ChatGPT bez konkrétního souhlasu; embeddingService/MCP zdroj beze změn. MCP zdroj má dál60s cache a30kJSON truncation, nasazená verze neověřena. Detaily: docs/reviews/backtest-layout-tags-20260905.md.


### 2026-09-05 — Review hlavní iOS aplikace (Codex)

Review současného Capacitor pracovního stromu je v
`docs/reviews/ios-20260905/README.md`: 19 doložených nálezů (2 P1, 17 P2),
podrobné dílčí reporty a reprodukční harnessy. Priority: Groq secret v již
vytvořených native assets, neověřené ARM ve widgetu, ztracené/duplicitní
notifikace, rušení timerů před doručením, remote akce, privacy cancel/resume,
mobilní logout a konzistence lokální/remote Live Activity. Cache nález platí
pro cold start; další focus/pull refresh má vlastní obnovu.

Prošlo ios:doctor, kontrola existujícího native HTML, Swift simulator build
a 152 cílených testů. Mock reprodukce běžely bez produkčních volání.
Simulátor nástrojově potvrdil instalaci/launch, nikoli použitelný průchod UI.
Uživatel jej vypnul kvůli zpomalení Macu; vlastní zbývající typecheck a nový
native JS build byly zastaveny a nemají PASS. Přesný instalovaný iPhone build,
APNs doručení a fyzické scénáře nebyly v tomto review ověřeny. Žádné opravy
zdrojů, push test, deploy, instalace telefonu ani broker akce.



### 2026-09-05 — Kompletní review backtestingu (Codex)

Review aktuálního pracovního stromu je v `docs/reviews/backtest-20260905/README.md`
včetně izolovaných reprodukcí a výstupů v `evidence/`. Nalezeno 17 technických
chyb (6 P1, 11 P2) a dvě UI připomínky. Priorita: entry-bar SL/TP, opakované
zpracování aktuální svíčky při market akci, Go To přes nenačtená data, spolehlivý
zápis closed trade do deníku, konflikt cloud revizí a user-scoped IndexedDB.
MFE/MAE, management a Monte Carlo mají další konkrétní nepřesnosti. Staré
performance návrhy už jsou zčásti implementované; rozhodovat podle tohoto
čerstvého review, nepřebírat starý audit jako seznam současných vad.

Ověřeno v browseru na localhost:3001: session testovka, tři replay grafy,
Go To nastavení, historie a detail obchodu. 343 cílených testů prošlo,
typecheck prošel s 4GB heap (výchozí 2GB běh OOM), Vite/PWA build prošel
do /private/tmp. Repro cloudových chyb používá mock transport, žádné produkční
fault injection. Žádné opravy zdrojů, nové obchody, deploy ani broker akce.
Rozsah dopadu chyb na existující sessions není rekonstruován.

### 2026-09-02 (Codex, předem známý nezpůsobilý follower už neodzbrojí kopírku)

Runner nyní vykazuje `account-ineligible` jako `skipped` pouze tehdy, když byl
konkrétní follower už ve vstupním `context.ineligibleAccounts`. Risk gate ani
globální halt logika se nezměnily a každý jiný `blocked`, stejně jako reject,
unknown a rozbitá sekvence, zůstává kritický a fail-closed. Standardní,
deferred, OCO i OSO controller větev používají jeden společný kritický filtr;
duplicitní inline OCO/OSO filtry byly odstraněny. `leader-replace-unmapped`
all-or-none dál vynechává pouze známé nezpůsobilé účty a jinak zůstává tvrdý
`blocked`.

Regrese pokrývají pokračující ARMED stav, prázdný `lastError`, nulový auto-close
a žádný nový order pro DLL/BREACHED followera; OCO i OSO navíc prokazují, že
následný reject zdravého followera skupinu stále odzbrojí. Zadaná sada prošla
7/7 souborů a 217/217 testů; `npx tsc --noEmit -p .` prošel s 4GB Node heapem
(výchozí přibližně 2GB běh skončil pouze OOM). Nic nebylo commitnuto, pushnuto,
deploynuto ani spuštěno/reinstalováno; neproběhl broker příkaz, ARM ani Flatten.

### 2026-09-02 (Claude, review incidentu „breached follower odzbrojil kopírku“)

Ověření Codexovy diagnózy incidentu z 15:37/15:40 v kódu. Spouštěč souhlasí:
Lucid účet byl `BREACHED`, risk gate ho správně vrátil jako `account-ineligible`
a pět zdravých followerů dostalo OSO. Kořenová příčina je ale obecnější než
„OSO cesta“: `isCriticalAuditEntry` v `copierRuntimeController.ts` považuje
KAŽDÝ audit `kind: 'blocked'` za kritický a všechny čtyři cesty (standardní,
deferred replay, bracket i OSO) mu předávají celý audit bez filtru. Předem
známé vyřazení followera (`account-ineligible`) tak vyvolá `failClosed` stejně
jako skutečné selhání. Reprodukováno na standardní cestě: stávající test
„async DLL reject: 4 aktivní / 1 dll-locked … skupina jede dál“ po druhém
leader vstupu ověřuje jen počty objednávek, ne `armed`; po dočasném doplnění
aserce `status().armed === true` test padá (`armed: false`). Test má tedy díru
a chování je shodné pro limit/market i OSO.

Druhý důsledek: `failClosed` za živého ARM (bez transportLost/kill switche)
volá `scheduleAutoClose('fail-closed')`, takže pouhé přeskočení breached účtu
může zdravým followerům risk-redukčně zavřít právě otevřené kopie. To je horší
než samotný DISARM a je to důvod, proč se incident opakuje při každém ARM se
známým breached členem.

Doporučená oprava (neimplementováno, jen review): blokace s důvodem
`account-ineligible` pro follower účet, který je v `ineligibleAccounts` už při
plánování, se má vykazovat jako `skipped` (nebo být z kritického filtru
vyjmutá) ve všech čtyřech cestách; jakékoli jiné `blocked` (quantity-limit,
symbol-not-allowed, divergence, halt) zůstává fail-closed. Doplnit regresi
`armed` po skipu pro standardní i OSO cestu a scénář „ARM se známým breached
followerem → dva leader vstupy → skupina zůstává ARMED, breached účet bez
objednávky“. Kód, účty ani broker se při tomto review neměnily.

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

### 2026-09-01 (Codex, instalace incidentní opravy a stavové uzavření legacy Flatten)

Po ukončení uživatelova obchodu čerstvá read-only reconciliation potvrdila
`armed=false`, všech sedm účtů flat, žádné working orders/divergence a
`lastError=null`; jediným blockerem zůstalo šest `manual-flatten` položek ve
stavu `unknown`. Incidentní změny byly bez konfliktu složeny nad aktuálním
`origin/main` `7932c6ae`, aby reinstall zachoval opravený persistentní worker
lifecycle. Výsledkem je lokální větev `codex/incident-20260901-worker-fix` a
commit `416e9042`. Cílená sada prošla 14 soubory / 313 testy; plná sada 203
soubory / 1705 testy. TypeScript, lint s 0 errors, produkční Vite/PWA build,
samostatný Node worker bundle a `git diff --check` prošly.

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

### 2026-08-31 (Codex, lokální oprava fatálního SL / leader-flat / Flatten incidentu — NENASAZENO)

Forenzní časová osa z broker/worker logů (lokální čas diagnostiky
Europe/Prague) potvrdila tři samostatné chyby. V 15:37:46 vznikl leader SL
29379 a šest follower bracketů také na 29379. V 15:37:55 se stejný čekající
leader SL posunul na 29391, ale copier neposlal followerům ani jeden Modify.
V 15:38:44 vstoupil leader i všech šest followerů za 29404; leader ochrana
pracovala na 29391, všech šest follower SL zůstalo brokerem potvrzených na
29379. V 15:39:12 leader SL vyplnil 5 kontraktů průměrně 29390,5. Follower
SL proto neměly důvod fillnout (ležely o 12 bodů níž); copier zrušil follower
TP, ale otevřené follower pozice nezavřel. Ruční Flatten v 15:40:30 fyzicky
zavřel všech šest kopií za 29427,50–29427,75. UI přesto ukázalo chybu a šest
durable položek zůstalo `unknown`, protože odpověď `liquidateposition`
neobsahovala `orderId`.

**1. Pending/pre-link SL/TP lifecycle je opravený.** Event source nyní sleduje
execution shape (typ/cena) odděleně od plného venue shape: cenový/type replace
emituje i ve stavu Pending/Suspended, zatímco čistý venue-managed quantity
resize ochranné nohy zůstává šum. Když replace přijde před vznikem follower
linku, OSO/bracket korelátor přepíše čekající execution shape; samostatný
čekající entry převezme i uživatelsky změněnou quantity, protective child si
naopak drží venue quantity. Po vzniku linků se execution replace provede jen
all-or-none pro všechny způsobilé followery. Přesný nový shape lze potvrdit
ve stavu Pending/Suspended i Working a potvrzený modify aktualizuje durable
link v běžné i restart recovery cestě. Přesná regrese incidentu ověřuje
SL `29379 → 29391` na všech followerech ještě před entry fillem.

**2. Leader open → flat je nově durable post-condition celé copy epochy.**
`LeaderFlatGuard` zachytí při otevření pouze způsobilé followery a posiluje
ownership jen čerstvým, přesným broker `orderId` copier-issued fillu; historický
link stejného účtu/symbolu nestačí. Quantity ownership je strop a nesmí se
pozdější same-sign změnou rozšířit. Po leader flat následuje grace a jeden
autoritativní batch `positions + orders`; stale working SL se nepovažuje za
probíhající exit. Copier DISARMuje a podle policy smí zavřít pouze prokázaný
orphan target `{accountId, symbol}` nativním liquidation endpointem. Nikdy
account-wide, nikdy Market fallback. Copier-issued exit nebo unknown/sending
liquidation stejné epochy blokuje druhý exit. Pozdní Fill po dřívějším
Position=0 doplní exit lineage bez zneplatnění generation tokenu. Restart a
reconnect obnoví jen durable epochu; orphan bez opening ownership je
detect-only + DISARM a **žádný broker write**. Kill switch auto-close zakazuje.

**3. Flatten se potvrzuje stavem, ne existencí `orderId`.** Nativní
`liquidatePosition` má vlastní výsledek `already-flat | submitted | rejected |
indeterminate`; HTTP úspěch bez orderId znamená jen „přijato ke stavovému
ověření". Úspěch je až přesný důkaz `position → orders → position` = flat a
žádný aktivní příkaz. Outbox končí `confirmed-by-state` s evidencí a netvrdí
kauzalitu konkrétního POSTu. Stejné nejasné operationId se nikdy neposílá
znovu. Restart umí nové i šest legacy `manual-flatten:*` unknown položky
uzavřít pouze read-only snapshotem, bez tag lookupu, POSTu nebo blind retry.
Ruční Flatten dál funguje i při DISARM, kill switchi a jiném stuck outboxu;
symbolově cílenou variantu používá LeaderFlatGuard.

**Ověření:** související sada 14 files / 300 tests prošla; celý projekt
202 files / **1673/1673 tests** prošel. TypeScript prošel s 4GB Node heapem,
task-scoped ESLint i `git diff --check` jsou čisté, plný lint skončil 0 chybami
(353 starších warningů) a lokální produkční Vite/PWA build prošel. Mezi
regresemi je policy-off detect-only, follower flat během grace, restart bez
opening epochy bez write, unknown liquidation bez retry, opačné pořadí
Position=0 → Fill, částečný batch a přesné zachování jiného NQ symbolu/SL na
stejném follower účtu.

**Hranice oprávnění:** neproběhl žádný broker příkaz, ARM, Flatten, deploy,
push ani restart/reinstall workeru. Běžící worker bundle se tímto zápisem
nezměnil a oprava proto zatím není LIVE. Copier musí zůstat vypnutý, dokud
nebude samostatně schválený a dokončený push/deploy + reinstall stejného
commitu, následný read-only reconcile a řízený DEMO conformance důkaz.

### 2026-08-31 (Claude, potvrzení příčin incidentu „ztracený SL modify před fillem")
Živý DEMO incident (15:37–15:40 CT): uživatel posunul SL čekajícího leader
příkazu z 29379 na 29391 PŘED entry fillem; copier změnu followerům neposlal.
Leader vystoupil na SL 29390,5, šest followerů zůstalo otevřených se starým SL
29379 a bez TP (copier je zrušil); uživatel je zavřel ručním Flatten
(29427,50–29427,75). Codex diagnózu určil z logů, Claude ji potvrdil v kódu —
tři samostatné díry:
1. **Ztracený modify v pending stavu** — `copierLeaderEventSource.orderEvent`
   ukládá signature/shape do cache VŽDY (řádky 74–77), ale u `pending` statusu
   emituje event jen při prvním spatření; komentář mylně předpokládá, že změny
   v pending jsou „venue tranzice, nikdy replace". Při přechodu do `working` už
   `previousShape === shape` (cache má novou cenu), takže `replaced` nevznikne.
2. **Chybí kontrola followerů při flat leadera** — `verifyPendingFollowerTransition`
   se spouští jen z follower transition; když leader zplatní přes SL a follower
   fill nepřijde (jeho SL je jinde), žádná kontrola neběží a stav „leader flat,
   followeři open" projde bez detekce.
3. **Flatten `unknown` kvůli chybějícímu orderId** — `liquidatePosition` sdílí
   `fromPlaceOrderResult` (tradovateMapping.ts:99), který bez `orderId` vrací
   nedefinitivní výsledek → `markUnknown`; Tradovate ale `liquidateposition`
   dokumentuje jako žádost bez garance, potvrzení musí přijít z autoritativního
   position snapshotu, ne z odpovědi na příkaz.
Ověřený stav po incidentu: všech 6 účtů flat, žádné working orders, copier
DISARMED, v outboxu 6 `unknown` Flatten záznamů. **Copier se NESMÍ zapnout,
dokud běžící worker bundle (build 30. 8.) nedostane opravu všech tří bodů.**
Nic se zatím neopravovalo — jen potvrzení diagnózy v kódu.

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

### 2026-08-31 (Claude + Codex, tříkolové review návrhu „PropShield" — ADR a opravené invarianty)
Codex navrhl bezpečnostní funkci PropShield (per-follower risk admission, durable
risk reservation, stav PROTECTED, „no SL no copy", Stop Sovereignty, Safety Receipt,
Prop Rule Passport). Claude na to pustil adversariální review, Codex napsal
protikritiku, Claude sporné body ověřil v kódu. Výsledek je
`docs/COPIER_PROPSHIELD_REVIEW_20260831.md`. **Nic se neimplementovalo, žádné volání
broker API neproběhlo.** Sem jen to, co mění rozhodování.

**Policy gate rozhoduje dřív než technika.** Tradeify Funded Trader Agreement §6.6
zakazuje použití stejného bota/alga napříč firmami a Help Center uvádí, že skenují
podobné objednávky napříč účty a mohou požadovat video se spuštěním kódu na vlastním
PC. Kopírování mezi vlastními Tradeify účty je naopak výslovně povolené. Lucid
copiery povoluje, ale zakazuje hedging i mezi vlastními účty a napříč korelovanými
produkty. **Cross-firm fan-out Tradeify + Lucid je proto policy-blocked do písemného
potvrzení od Tradeify.** Neuzavřená nuance: zda AlphaTrade s ručním leaderem vůbec
spadá pod „bot/algo" dle §6.6.

**Jedna skutečná runtime díra, dvě technické cesty.** Pending Limit/Stop s JEDNOU
ochrannou nohou je chráněný (`oso-lone-leg`, controller:1798), ale se ŽÁDNOU nohou
propadne do `processor.process()` a zkopíruje se. Market OSO okno obchází úplně —
`isEntryType` v `copierOsoCorrelator.ts:47` zná jen Limit/Stop/StopLimit.
`copierBracketCorrelator.prune()` navíc entry kandidáta bez legu tiše zahodí.
Invariant je jeden (žádný entry bez známého ochranného plánu), opravy jsou dvě.
MVP: pending jen jako ověřené nativní OSO, Market bez plánu blokovat, podmínkou je
SL (TP až jako přísnější „Full Bracket Mode"), a první verze pouze alarmuje a
DISARMuje — nic nepřepisuje ani nevymýšlí.

**Katalog prop plánů: 35 presetů, ale všech 35 je `evaluation`** (funded účty
nepokryté) a `drawdownType` není jednotný — 27× `eod_trailing`, 8× `trailing`.
Právě tahle veličina určuje, jestli je rezerva nad floorem během dne statická, nebo
pohyblivý cíl; každý výpočet dostupného risku na ní stojí. `verifiedAt` je jedna
hardcoded konstanta pro všechny a nikdo ji nečte. Rozhodnutí: passport jako data
ano, `verifiedAt` jako blokující západka NE (brána, která trestá za neaktualizovanou
vlastní dokumentaci, se vypne při prvním výskytu).

**Dvě dřívější tvrzení Clauda byla ověřena jako NEPLATNÁ a jsou opravená v ADR:**
(1) „zombie worker může odeslat order, který nebude v outboxu" — persist je
write-ahead, `copierRunner.ts:1611` předchází `:1620`, takže objednávka zůstane jako
`sending` a dohledá se; skutečný problém je pozdní broker write po takeoveru a hard
fencing vyžaduje gateway. (2) „žádná větev nesmí sáhnout na SL, dokud neexistuje
regrese incidentu 27. 8." — ta regrese existuje:
`tests/copierReviewRegressions.test.ts:583` (partial fill 6→11, sekvence
`suspended-6` → `working-11`). Správné pravidlo je proto užší: nikdy autonomně
neoslabit ani nezrušit platný SL, ale risk-redukující zásahy a prokazatelně doložené
leader lifecycle změny zůstávají povolené.

**Závazné invarianty z ADR:** admitted quantity musí být autoritou pro entry, SL, TP,
partial filly, modify, scale-in, exit i reconciliation — bez durable admission
ledgeru se REDUCED nesmí zapnout vůbec (jinak zmenšené entry s nezmenšeným SL otočí
followera do nechráněné opačné pozice, protože ochranné nohy se dnes sizují z leadera
— `copierRunner.ts:739`, `:1008`); `maxContracts` zůstává poslední fail-closed brána a
nikdy nevstupuje do `min()`, protože započítává i cizí pozice, a je tak zároveň
detektor cizí aktivity na účtu; ledger smí být jen druhá, přísnější podmínka vedle
`trunc(leader × multiplier)`, nikdy jeho náhrada (test
`copierRuntimeController.test.ts:438` se nemaže); protection proof je negativní alarm,
žádná zelená; žádné nové synchronní broker cally na horké cestě (cap už dnes dělá
10 callů na vstup při pěti followerech, limit je 5 000/h a při 429 neprojde ani
emergency flatten); zamítnuto „všichni bezpeční, nebo žádný vstup" — eval účet by
dostal právo veta nad funded účtem.

**Dohodnuté pořadí:** ADR → zero-leg oprava (pending a Market zvlášť) → shadow Safety
Receipt + admitted-exposure ledger → read-only capability matice (jen po výslovném
schválení; jeden GET nerozhodne, `changesLocked:false` nedokazuje právo na update a
AutoLiq je post-trade, ne pre-trade cap) → jeden VPS worker v DEMO → gateway před HA.
Mimo pořadí a zadarmo: multipliery podle poměru `maxLoss` — `multiplier` je durable a
reconciler už dnes očekává `trunc(leader × multiplier)`, takže asymetrické velikosti
nativně podporuje.


### 2026-08-28 (Codex, spolehlivé ENTRY/EXIT snímky z layoutu `AlphaTrade Snapshoty`)
Copier už nefotí první náhodný TradingView target. ENTRY a EXIT používají pouze
vyhrazený layout s uloženým `chartId`; při capture jej srovnají na jeden panel,
provedou `chartReset`, dynamický bar spacing, 28% místo vpravo, skryjí plovoucí
lištu a oříznou výsledek na graf. Symbol a timeframe nemění — přebírá je
TradingView synchronizace mezi pracovním layoutem a layoutem
`AlphaTrade Snapshoty`, takže zůstávají kresby, levely a position box. Když
vyhrazená karta chybí, snímek se raději nepořídí; pracovní graf se nikdy
nepoužije jako tichý fallback.

Mac instalátor nově zapíná bezpečný auto-start TradingView s CDP pouze tehdy,
když aplikace neběží. Už spuštěné TradingView bez portu 9222 worker nikdy
násilně neukončuje ani nerestartuje. Lehký 30s health probe se propisuje do
statusu workera a LIVE UI rozlišuje připraveno, CDP offline, chybějící layout,
capture chybu a upload chybu včetně času posledního úspěchu. Diagnostika je
oddělená od controlleru a nijak neblokuje broker execution.

Journal master nově uchovává stabilní `copierEpisodeId`, takže pozdě nahraný
ENTRY/EXIT obrázek se při dalším syncu doplní k existujícímu obchodu bez
duplikace a bez přepsání reflexe. Starší mastery za 30 dní dostanou jednorázový
backfill vazby z ledgeru. Obrázkový APNs follow-up už není závislý na tom, zda
původní event ještě zůstal ve volatilním `recentCopyEvents`; při jeho absenci
odešle bezpečný obecný text. Privátní Storage bucket, podepsané URL a existující
RLS zůstaly beze změny; nevznikla žádná migrace ani produkční DB operace.

Ověření: cíleně 6 souborů / 58 testů, celkem 199 souborů / 1603 testů,
TypeScript, produkční Vite/PWA build, samostatný esbuild Mac workeru a
`git diff --check` prošly. ESLint změněných souborů má 0 errors (jen existující
warningy ve `storageService` a dva ignorované worker skripty).

Po následném explicitním schválení uživatele byl Mac worker z kanonického
checkoutu přebalen a LaunchAgent restartován se stejným leaderem, šesti
followery a multipliery. TradingView bylo po potvrzení uloženého stavu jednou
ukončeno a worker je automaticky spustil s CDP na `127.0.0.1:9222`. Živá UI
kontrola ukázala, že správný layout se jmenuje `AlphaTrade Snapshoty` a má
stabilní `chartId=JLtpkCHq`; po otevření jeho karty worker sám obnovil nový
session `targetId`. Lokální capture bez uploadu vytvořil čistý PNG o 560 104 B
v `/tmp/alphatrade-tv-snapshot-test.png`; vizuálně je v něm jeden MNQ 1m graf,
kresby/levely, dynamické svíčky a místo vpravo. Finální status: CDP i target
ready, broker socket read-only connected, runtime `armed=false`,
`reconciliationRequired=true`, kill switch false a bez chyby. Nebyl odeslán
žádný broker write, ARM ani Flatten; testovací PNG nešel do Storage,
notifikací ani journalu. Kód nebyl commitnut, pushnut ani nasazen a produkční
DB/RLS se neměnily.

### 2026-08-28 (Codex, cloudová knihovna kopírovacích skupin)
Lokálně je připravena per-user synchronizace všech uložených copy-group profilů
přes novou Supabase tabulku `copy_groups`; web i zabalená aplikace používají
uživatelsky oddělený `localStorage` jen jako rychlou cache. Prázdný cloud nikdy
automaticky nepřevezme náhodná stará data zařízení: UI nabídne explicitní
jednorázový import lokální knihovny, poté je cloud autoritativní a při návratu
do popředí se znovu načte. Databáze i klient vynucují `enabled=false` a
odstraňují `localOnly`; skutečný ARMED stav a jediná aktivní execution skupina
zůstávají výhradně na copier workeru. RLS dovoluje CRUD pouze vlastníkovi.
Cloudové profily se při live refreshi zachovají, i když právě neběží, a chyba
cloudového zápisu po úspěšném runtime příkazu nesmí vrátit UI do nepravdivého
starého stavu. TypeScript, cílený lint, 198 test souborů / 1593 testů a
produkční build prošly. Před databázovou změnou byla přes CLI ověřena poslední
fyzická záloha `COMPLETED` z 27. 8. 22:14 UTC (Supabase drží 7 denních bodů).
Obě verzované migrace byly aplikovány: tabulka je prázdná, má zapnuté RLS a
čtyři vlastnické CRUD politiky. Nový nepotřebný index hlášený performance
advisorem byl následnou migrací odstraněn; opakovaný security i performance
advisor nemá pro `copy_groups` žádný nález. Aplikace zatím nebyla pushnuta ani
nasazena a zabalená iOS aplikace nebyla přestavěna.

### 2026-08-28 (Codex, odstranění vodopádu při prvním otevření LIVE)
První otevření LIVE po reloadu už nestahuje 171kB lazy bundle až po kliknutí:
po dokončení úvodního dashboardu se modul přednačte na pozadí. Čerstvý OAuth
status, profily a bootstrap známých read-only připojení se nyní spouštějí
souběžně; cached shell slouží pouze k předstartování ID a žádná brokerová data
se nezobrazí, dokud připojení nepotvrdí aktuální status. Každý úspěšný
preflight se promítne samostatně, takže rychlá prop firma už nečeká na
nejpomalejší připojení ani na profily/onboarding. Historický backfill se posunul
z 1,5 s na 5 s po ustálení flat snapshotu, aby nebral request budget prvnímu
renderu. Copier runtime ani polling živých pozic se neměnily. Nové
deterministické testy kryjí reuse předstartu, průběžné vykreslení a odmítnutí
nepotvrzeného cached ID; přesný čistý commit prošel 195 soubory / 1575 testy,
typecheckem a produkčním buildem, lint změněných souborů je bez chyb. Commit
`58dbc35c` byl pushnut na `main`; Vercel deployment
`dpl_3taLRxQwh4cxCh6xCpQJMKgNimBa` skončil READY a produkční alias na něj míří.
Zabalená iOS aplikace zůstala beze změny.

### 2026-08-28 (Codex, aktualizace zabalené iOS aplikace na produkční commit)
iOS Capacitor aplikace nepoužívá vzdálenou `server.url`; spouští lokální
`dist-native` bundle uvnitř instalace. Samotný Vercel push proto web v telefonu
neaktualizuje. Z přesného `origin/main` commitu `e5ed71d3` byl v odděleném
dočasném worktree vytvořen a ověřen nový native bundle (`npm run ios:sync`),
podepsán Debug device build včetně widget a notification extensions a přes
`devicectl` nainstalován přes existující `app.alphatrade.native` do připojeného
iPhonu 13 Pro Max. Podpis prošel `codesign --verify --deep --strict` a aplikace
byla po instalaci úspěšně spuštěna. Do copier runtime nebylo zasaženo a žádný
brokerový příkaz nebyl odeslán. Budoucí webové změny dál vyžadují nový native
bundle a instalaci/TestFlight build, dokud se vědomě nezmění architektura
na vzdáleně načítaný produkční web.

### 2026-08-28 (Codex, fresh-only dvoufázový start LIVE dashboardu)
Studený start LIVE po reloadu už nečeká na celý Tradovate preflight. UI ihned
vykreslí strukturální skeleton bez starých broker hodnot a serverový bootstrap
načte jen čerstvé účty, pozice, příkazy, jejich kontrakty a cash balance
snapshoty. Fill/fee historie, cash ledger, risk detail a osmivteřinový report
capability probe se doplní druhým plným preflightem na pozadí. Pro jeden účet
má bootstrap šest read-only broker requestů; denní P&L zůstane do doplnění
ledgeru jako pomlčka, nikdy jako falešná nula. Copier přepínač je během této
krátké neúplné fáze pending a eligibility se neinferuje z chybějícího denního
ledgeru. Návrat v rámci SPA dál použije okamžitě poslední potvrzený in-memory
snapshot a do bootstrap režimu se nepřepíná.

Více OAuth/prop připojení se načítá přes `allSettled`: chyba jednoho už
nezahodí úspěšný snapshot druhého. Plný snapshot se neukládá do
sessionStorage, takže nevznikají synchronní zápisy při 1s P&L ticku ani riziko
tichého zobrazení starých pozic. Copier runtime, polling intervaly a brokerové
write endpointy se nezměnily; při implementaci nebyl broker kontaktován.
Ověření: 195 test souborů / 1585 testů, TypeScript, produkční Vite/PWA build a
`git diff --check` čisté; lint změněných souborů 0 errors (1 existující hook
warning). Produkční subset byl následně oddělen od rozpracovaných copier změn,
ověřen v čistém worktree (194 souborů / 1572 testů, TypeScript a build),
commitnut jako `e5ed71d3` a pushnut na `main`. Vercel deployment
`dpl_E1mFQX3xLm6BQXDE7ReTQ7XX9jeY` je `READY`; hlavní alias vrací HTTP 200,
neautentizovaný bootstrap preflight správně 401 a desetiminutový error scan je
prázdný. Mac copier worker nebyl měněn ani reinstalován.

### 2026-08-27 (Codex, reálný probe Tradovate quote WebSocket oprávnění)
Krátký read-only probe přes oba existující spárované Mac device lease otevřel
produkční i legacy DEMO market-data WebSocket, autorizoval OAuth token a zkusil
`md/subscribeQuote` pro aktuální `MNQU6`. U obou připojení a obou hostů
autorizace socketu prošla, ale samotný odběr quote skončil `401`; nepřišla
žádná `md` událost. REST `marketDataSubscription/list` současně vrátil `200`
a aktivní platformní subscriptions (4 a 3), takže problém není absence běžných
dat v Tradovate UI, ale oddělené API/non-display quote oprávnění současných
prop OAuth tokenů. Oficiální OAuth response ukládá pouze `access_token`;
samostatný `mdAccessToken` je dokumentovaný u přímého API-key přihlášení, ne
v našem OAuth response.

Probe je uložený v `scripts/market-data/quoteAccessProbe.ts` pro opakování po
změně oprávnění. Nevypisuje tokeny ani ceny a posílá pouze authorize,
subscribeQuote a best-effort unsubscribeQuote. Nebyl použit žádný order
endpoint, copier runtime se nezměnil a žádná objednávka nevznikla. Přihlášené
webové rozhraní bylo prop prostředí a nezpřístupnilo osobní `Application
Settings → API Access`; oprávnění retail API klíče placeného účtu proto zatím
není ověřené. TypeScript, lint probe skriptu a `git diff --check` jsou čisté.

Následná kontrola v osobním Tradovate účtu odhalila u používaného OAuth klíče
`Market Data: Denied`. Po explicitním schválení uživatele bylo změněno pouze
na `Read only`; UI potvrdilo úspěšné uložení. Nový probe tím odstranil vnější
`401`, ale odpověď subscription obsahuje `mode: None` a `UnknownSymbol`, takže
reálný odběr nevznikne. Stejný výsledek vrací název `MNQU6` i jeho číselné
contract ID, oba prop OAuth lease a oba market-data hosty. Aktivní platformní
subscriptions tedy nestačí pro API/non-display entitlement; žádný quote paket
nepřišel. Probe nově správně nepovažuje status `200` s vloženou chybou za
úspěšné přihlášení a posílá klientský heartbeat každých 2,5 s. Nebyl použit
žádný order endpoint a žádná objednávka nevznikla.

### 2026-08-27 (Codex, bezplatný 1s mezitick LIVE ceny/P&L)
LIVE karta při otevřené NQ/MNQ pozici nově střídá autoritativní 2s
position/order tick s levným 1s balance-only mezitikem. Mezitick udělá na
každé připojení nejvýše jeden read-only
`cashBalance/getcashbalancesnapshot`; brokerovo `openPnL` použije jako kotvu
jen pro účet s právě jednou odpovídající otevřenou pozicí a z ní dopočítá
mark a P&L dalších účtů na stejném kontraktu podle jejich vlastní vstupní
ceny. Pozice a objednávky dál mění pouze plný 2s tick. Nejednoznačné pozice,
nepodporovaný kontrakt, skrytá záložka a HTTP 429 zůstávají fail-safe; flat
režim zůstává na 5 s. Řešení nepotřebuje další market-data předplatné, ale
není tick-by-tick burzovní feed.

Copier runtime ani jeho příkazy se nezměnily a Tradovate/broker nebyl při
implementaci kontaktován. Ověření: cíleně 13/13 live-P&L testů, celkem
195 souborů / 1583 testů, TypeScript a `git diff --check` čisté, lint změněných
souborů 0 errors (1 pre-existing hook warning), produkční Vite/PWA build
prošel. Změny byly spolu s fresh-only bootstrapem nasazeny v produkčním
commitu `e5ed71d3`; produkční chování proti reálnému DEMO snapshotu zatím
nebylo interaktivně ověřeno.

### 2026-08-27 (Codex, oprava hloubkového review copieru — race, drift a recovery)
Nálezy z `docs/REVIEW_COPIER_FINDINGS_20260827.md` jsou lokálně opravené bez
brokerového side effectu. Všechny reconciliation call-sites sdílejí jednu
frontu a monotónní safety generation; starší clean snapshot proto nemůže
přepsat novější kill switch, incident ani reconnect invalidaci. Automatická
reconciliation už nemaže `lastError`; odstranit starou chybu smí jen čistá,
explicitní uživatelská Kontrola pozic stejné generace. Kill-switch race má
deterministickou regresi včetně zachování důvodu a blokovaného ARM.

Terminal-fill recovery pokračuje jen po prokazatelně úspěšném auto-flattenu
a jen když KAŽDÁ kritická položka dávky je tentýž abandoned/filled modify.
Selhání flattenu zachová FAIL-CLOSED a nikdy nevydá `recovered`. Same-sign
follower drift se po krátkém kauzálním okně ověřuje čerstvým leader/follower
broker snapshotem proti přesnému multiplieru; persistentní `2 → 5` odzbrojí,
označí divergenci a nic automaticky neobchoduje, zatímco legitimní follower
scale-in event před leader position eventem zůstává bez falešného poplachu.
DISARMED bracket/OSO anomálie dál nevyrábějí falešný incident, ale vždy
zneplatní ARM preflight a vynutí novou reconciliation.

Další opravy: `armExpiryFlatten: off` už nevypíná povinnou read-only reconnect
reconciliation; flat recovery má audit; nekompletní bracket po timeru uvolní
`awaitingPair`; všechny relativní statické importy v `server/**` mají `.js`
a globální ESM regrese brání návratu extensionless importu. DISARMED invalidace
preflightu má vlastní neduplicitní notifikační hranu a mrtvý, nikde
neimportovaný `components/LiveDesk.tsx` byl odstraněn; aktivní LIVE zůstává
`components/TradovateLiveDesk.tsx`. Ověření: 46 copier test souborů / 538 testů
a celkem 195 souborů / 1579 testů čistě, TypeScript
čistý, globální lint 0 errors (353 pre-existing warnings), produkční Vite/PWA
build a `git diff --check` čisté. Nic nebylo commitnuto, pushnuto, nasazeno ani
nainstalováno do Mac workeru; runtime/broker nebyl kontaktován a neproběhl ARM
ani Flatten. Před LIVE dál platí explicitní schválení push + reinstall stejného
commitu + řízený DEMO test.

### 2026-08-27 (Claude, hloubkové review incident fixů z 27. 8. — nálezy před dalším LIVE ARM)
Read-only review commitů `de93fd3a`→`cf316f37` (4 paralelní průchody + vlastní
verifikace; 1566/1566 testů a typecheck čisté, žádný brokerový side effect).
Plný report: `docs/REVIEW_COPIER_FINDINGS_20260827.md`. Klíčové nálezy:
(1) CRITICAL — `performReconciliation` po čisté kontrole bezpodmínečně maže
`lastError` (nové v `cf316f37`); souběžný `engageKillSwitch` tak může přijít
o svůj důvod ve `status()` a tři volací body reconciliace nesdílí zámek.
(2) HIGH — plošné `lastError = null` umlčuje hranovou push notifikaci
i watchdog dřív, než incident zachytí. (3) HIGH — po `6d0caefb` není same-sign
navýšení follower pozice při leaderovi v pozici detekováno ničím do příští
(neperiodické) reconciliace. (4) HIGH — `if (gate.armed)` guardy v DISARMED
ztratily eskalaci (žádný `lastError`/push) a nevynucují `positionCheckComplete
= false`. Dále: `shadowMode: true` v reconciliaci je mrtvý kód, komentář „ARM
pokračuje po resyncu" neodpovídá chování (resync vždy DISARMuje — řádek 2524
z 17. 8.), dva extensionless ESM importy zbývají v `server/`. Doporučení:
opravit 1–4 před push/reinstalací workeru a dalším LIVE ARM. Nezávislá
oponentura (Opus, týž den) všechny nálezy potvrdila a zpřesnila: CRITICAL je
jen race souběžných reconciliací (starší clean běh přepíše novější špinavý
stav → ARM nad divergencí); smazání důvodu kill switche je „jen" auditní
chyba (západka drží). Sjednocený návrh opravy = monotónní incidentGeneration
+ jediný in-flight běh reconciliace + mazání pouze chyby vlastní epizody;
D.2 řešit kauzálním oknem s broker snapshotem, ne slepým fail-closed
(scale-in ordering). Shoda: DEMO/LIVE ARM no-go do oprav. Detaily v dodatku
reportu. Konkurenční
průzkum (v reportu): fail-closed/DISARMED default a durable outbox nemá žádný
konkurent; bracket sync na Tradovate je slabina celé kategorie — doložené
breache účtů u PickMyTrade/TradeSyncer kvůli tichým výpadkům.

### 2026-09-05 (Codex, podrobný lokální audit celé kopírky)

Pouze pracovní kopie `codex/live-reliability-20260905` na localhostu.
Bez push/deploy, reinstalu workeru, ARM/Flatten či skutečného broker zápisu.
Přibylo 75 regresí v šesti souborech `*DetailedReview.test.ts`; původní
červené reprodukce a finální logy jsou v
`/private/tmp/alphatrade-copier-detail-20260905/`.

Nejzávažnější potvrzená chyba: controller mohl po DISARM/kill, který
přišel během durable `sending` commitu, ještě odeslat nový follower vstup.
Broker wrapper nyní kontroluje aktuální gate a generaci přijaté události
přímo před raw write, po preflight I/O i při jeho selhání. Starý úkol
neoživí nový ARM; generace přežívá frontu i odložené OSO. Prokazatelně
neodeslané revokované operace končí durable waived/skipped bez retry či
nového auto-close. Již zahájený raw write si zachovává ACK/unknown.
20 nových exekučních testů pokrývá standard/OCO/OSO, modify, ochranný
cancel, fanout, re-ARM, obnovu a chybové lookupy včetně OSO cascade.

Další opravy: tighten-only již nelze obejít změnou časové zóny aktivního
okna; Risk nezapočítá nezpůsobilé followery mezi kopírující a progress
ukazuje účinný, nikoli rozepsaný limit. Načtená data se při odebrání
připojení prořezávají a při změně uživatele nepřetečou ani v prvním renderu;
opožděné odpovědi chrání identity/connection epochy. Bootstrap/full/manual
refresh respektují 429 i uvnitř částečného výsledku a Retry-After. Server
po 401/429 nezačíná další čtení účtů; volitelné scope403 dál izoluje.
Preflight zachová broker429 místo obecné502 a vrátí Retry-After.

Relay odmítne neplatnou expiraci před exekucí, neztratí druhou událost
přijatou během event heartbeatu a nepotvrzený výsledek neoznačuje za
prokazatelnou expiraci. Již zařazený příkaz má přednost před APNs;
durable eventy v takovém pollu převezme existující watchdog se stejným
dedup markerem. Nový příkaz přicházející až během běžícího APNs pollu
může nadále čekat — úplné oddělení notifikací vyžaduje samostatnou cestu.

Ověření: celá sada **2265/2265 ve 250 souborech**, `tsc --noEmit`,
produkční build a diff check prošly; scoped ESLint 0 chyb, 4 stávající
warnings. První souběžný full run byl zastaven po timeoutu tří testů;
finální běh s dvěma workery a infrastrukturním timeoutem15s prošel celý.
Assertiony bezpečnosti a časování se neměnily. První typecheck zachytil
nevhodný `Probe<never>` pro null marker; opraven na `Probe<unknown>`.

Browser: po zaseknutém auth-locku v testovací kartě se nový náhled načetl;
read-only prošlo všech šest LIVE záložek, dva účty a jedna skupina.
Stávající worker stále hlásí WebSocket error a nepotvrzuje nové Risk
capabilities, UI správně blokuje jejich uložení. Seznam Mac companion
zařízení není v omezeném localhost proxy dostupný; externí měnové kurzy
hlásí fetch error. Auth-lock se po obnově neopakoval, jeho původní příčina
není potvrzená. Lokální serverové změny ověřují mock testy — produkční
read-only proxy je nespouští. Zelené lokální testy nejsou real-broker proof.

### 2026-09-05 (Codex, klientské záseky LIVE — Monte Carlo, skupiny a Tailwind)

Pouze localhost, bez push/deploy. Přímý React profil odhalil opakované
přepočty Monte Carlo při Realtime UPDATE celých trade záznamů. Widget nyní
memoizuje své skutečné vstupy (pořadí non-Missed PnL + počáteční kapitál),
algoritmus 600 simulací zůstal identický; metadata a všechny realtime změny
se dál propisují. Ve stejných prvních 14,647 s klesl součet render práce
widgetu 1816,2 → 384,9 ms (78,8 %), nikoli celého načtení. Neúčinný pokus
s porovnáváním celých trade snapshotů byl odstraněn, App je přesně obnoven
na stav před tímto profilováním. Konfigurace kopírovacích skupin se při
nezměněném snapshot/runtime merge stabilizuje úplným porovnáním polí;
ceny, runtime a capturedAt tím nejsou filtrovány.

Odstraněn duplicitní runtime Tailwind CDN (Vite už generuje CSS). CDN nebylo
prokázáno jako hlavní zdroj sekundových záseků. Zachovány theme/fonty,
54 konkrétních dynamických utilit, dark variant podle app theme a opraveny
kolize CSS vrstev pro polohu hlavičky/spodní lišty i focus/hover theme stylů.
Vizuálně zkontrolováno light/dark/OLED a úzké rozložení, dočasný viewport
resetován. Testy: 2190/2190 ve 244 souborech, tsc, build, cílený lint bez
chyb (27 existujících unused warnings), CSS kompilace a diff-check prošly.

Finální 3 první vstupy: oba účty 1571 / 987 / 1126 ms (medián 1126 ms),
full 2153 / 1683 / 1780 ms; od posledního nutného API responseEnd zbývalo
179 / 201 / 60 ms. Jeden návrat ukázal cache za 87 ms a fresh full za
1310 ms. Všechny úvodní status/bootstrap/full HTTP 200 a ověřeny oba
konkrétní datasety, coverage a viditelné řádky. Nejde o produkční percentily
ani server A/B; API latence a doba před kliknutím kolísaly. Dosavadní proxy
používá produkční loader, ne lokální serverovou optimalizaci. Report + data:
LIVE-CLIENT-PROFILE-20260905.md/json ve visualization složce tasku.
Veškerá dočasná instrumentace odstraněna; žádné brokerové ovládání,
reinstall ani práce s přihlašovacími klíči.

### 2026-09-05 (Codex, browser měření prvního vstupu a návratu na LIVE)

Na explicitní žádost změřeny 3 první vstupy a 3 návraty na localhostu se
skutečnou produkční read API proxy: oba účty 1,529 / 1,842 / 3,179 s
(medián 1,842 s), full 2,165 / 2,626 / 4,133 s; návrat s cache
0,185 / 0,378 / 0,394 s, nový full refresh na pozadí 1,632 / 1,784 / 2,334 s.
Všechny úvodní status/bootstrap/full HTTP 200, dva konkrétní datasety
s úplnou coverage a validním cash, dva viditelné řádky a skupina.
Po posledním potřebném responseEnd zbývalo 134 / 402 / 1389 ms do
pozorovaného vykreslení; u pomalého běhu 936 ms už mezi responseEnd
a fetch.then callbackem. Není to jen API; přesnou klientskou příčinu má
určit CPU profil (runtime Tailwind/statistiky/mount Overview jsou zatím
jen kandidáti). Nejde o A/B nového serveru ani produkční percentily.
Vzorky měly různou dobu usazení hlavního Dashboardu a nová náhradní karta
používala postranní navigaci.

Kalibrace s DOM diagnostikou a následný pád původní karty jsou vyřazené;
platné vzorky mají pouze console instrumentaci. Ve třetím vzorku nastal
timeout browser ovládání ještě před zachyceným kliknutím. Report/data:
LIVE-BROWSER-MEASUREMENT-20260905.md/json ve visualization složce tasku.
Dočasná měření index.html a TradovateLiveDesk jsou přesně odstraněná,
SHA-256 obou souborů odpovídá aktuální záloze před měřením. Bez push/deploy,
reinstalu, brokerových příkazů či přístupu ke klíčům. Úspěšné HTTP čtení
není důkaz ready workeru (broker stream offline).

### 2026-09-05 (Codex, serverový benchmark — Vercel odmítl přístup)

Po dalším explicitním „potvrzuji“ uživatel autorizoval existující Vercel
přihlášení a čtení pouze produkční TRADOVATE_TOKEN_ENCRYPTION_KEY tohoto
projektu. Úprava runneru i spuštění prošly automatickou kontrolou. Vercel
API však odmítlo už GET metadat proměnných: HTTP 403, code forbidden,
kategorie permission-denied; jedno diagnostické opakování stejného GET
potvrdilo výsledek. Nejde o další chybějící souhlas a není doložena expirace
přihlášení. Produkční klíč nebyl načten a reálné Tradovate A/B se nespustilo.
Pokračování vyžaduje funkční oprávnění existujícího přihlášení nebo správný
klíč bezpečně dostupný lokální serverové konfiguraci. Report aktualizován;
syntetické výsledky nejsou skutečné síťové časy. Bez push/deploy, worker
zásahu, brokerového příkazu či obnovy tokenů. Předchozí zápisy níže jsou
historie již vyřešených požadavků na souhlas.

### 2026-09-05 (Codex, serverový benchmark — neplatná lokální konfigurace)

Po explicitním „ano potvrzuji“ pro existující serverový klíč a tokeny dvou
připojení vytvořen a spuštěn jednorázový `run-authorized.mjs`. Omezený read
Supabase záznamů fungoval, ale lokální TRADOVATE_TOKEN_ENCRYPTION_KEY
nemá platný 32bajtový formát. Pokus skončil před jakýmkoli Tradovate
požadavkem, tokeny nebyly obnovené ani ukládané. Doplněn pouze benchmark
agregát complete pro HTTP/content/coverage/cash validitu; offline sanity
prošla. Žádná produktová změna.

Projekt ověřen přes Vercel connector. Návrh získat existující produkční
klíč přes lokální Vercel přihlášení automatická kontrola zamítla jako nový
credential access mimo dosavadní souhlas; patch nebyl aplikován. Vyžádán
konkrétní doplňující souhlas pro tento jediný klíč/projekt. Skutečné časy
zatím nemáme; nesmějí být nahrazeny syntetickými výsledky. Aktuální stav
v `LIVE-API-BENCHMARK-20260905.md`. Bez deploy/push nebo změny workeru.

### 2026-09-05 (Codex, připravené A/B měření serverového bootstrapu)

Na souhlas se změřením serverové úpravy připraven samostatný harness
`/private/tmp/alphatrade-api-benchmark-20260905`, skutečný loader z HEAD
08bf59eb a aktuálního worktree, source hashes, ABBA, allowlist pouze čtecích
Tradovate cest, stop při 401/403/429 a výstup bez payloadů/tokenů/ID.
Žádná aplikační změna. Existující lokální serverový config je přítomný,
ale automatická kontrola zamítla vytvoření auth-provider skriptu: měření
podle ní samo neautorizuje service-role přístup k encrypted access tokenům.
Skript nebyl vytvořen/spuštěn; požádáno o explicitní jednorázový souhlas
pro dvě connection ID z aktuálního worker manifestu, bez obnovování tokenů.

Dokončeno pouze syntetické srovnání s virtuálními latencemi: dominuje-li
account/list bez kontraktů 240→240 ms, malý překryv 130→120 ms, pomalé
seznamy+kontrakty 180→140 ms. Všech 6 párů vrací shodná data a sanity checks
prošly včetně nezávislého opakování rootem. Nejde o skutečné Tradovate
měření ani predikci produkční úspory. Další krok po souhlasu: přesně
omezený read-only přístup a přímé lokální A/B; auth/DB/Vercel/UI režii
vykázat zvlášť. Report `LIVE-API-BENCHMARK-20260905.md`, data výslovně
`LIVE-API-SYNTHETIC-20260905.json`. Žádný push/deploy/worker zásah.

### 2026-09-05 (Codex, kontrola domnělého zpomalení po animaci)

Na dotaz uživatele znovu změřené první vstupy, potvrzená data obou účtů
za 1,154 / 1,382 / 1,829 s, full za 2,262 / 1,982 / 2,649 s. Dřívější
medián účtů 1,221 s, nyní 1,382 s: vzorky tedy opravdu mohou být pomalejší.
Základní API odpovídalo za 646–1230 ms, v každém běhu jeden OAuth status
a dva bootstrapy. Samotné zobrazení při návratu s existujícími daty 155 ms.
Malé sekvenční vzorky neprokazují příčinu v odstranění animace. App/datový
hook/navigace obsahově totožné se zálohou před animací; v renderování není
nové načítání ani dodatečný podstrom. Možný jednorázový Fast Refresh remount
po editaci není doklad regresní chyby. Přesná metodika a omezení v Codex
artifactu `LIVE-MOTION-CHECK-20260905.md`. Instrumentace přesně odstraněna;
žádná další produktová změna, push, deploy nebo brokerová akce.

### 2026-09-05 (Codex, klidné zobrazení LIVE tabulek — pouze localhost)

Uživatel popsal dojíždění skupiny a účtů při přepnutí jako zaseknutý obsah.
Oba pružinové `motion.tr layout="position"` nahrazené běžnými řádky,
odstraněné 300ms rozbalování detailu i úvodní fade LIVE. Počáteční rozbalení
se nyní odvozuje ze skutečných draft/runtime skupin už při prvním renderu,
aby následný efekt nemusel nejprve zavřené účty otevírat. Datové načítání
a brokerové/runtime příkazy se nemění. Odstraněna jen zastaralá testová
podmínka vyžadující motion atribut.

CUA ověřil vstup z Dashboardu a návrat Připojení → Live Dashboard: skupina
i oba účty vykreslené, řádky bez transformace/animace a detail s přechodem
0 s. TypeScript, scoped lint a 26 existujících render/interakčních testů
prošly. Změna zůstává v lokálním worktree, bez push/deploy.

### 2026-09-05 (Codex, přednačtení a priorita prvního vstupu LIVE — pouze localhost)

Na schválené „udělej to“ desktopové i mobilní menu přednačítá LIVE kód
a read-only status/bootstrap při pointerenter, focus a pointerdown. Následný
vstup převezme stejnou práci; 3s TTL omezuje přijetí, nikoliv dokončení již
převzatého požadavku. Kontroluje se uživatel/identity epoch, potvrzené
connection ID i rate-limit backoff. Původní capturedAt zůstává zachované;
prefetch sám nepublikuje stav ani nespouští polling či worker.

LIVE odkládá sekundární moduly a obnovu business metadat na Dashboardu.
Uložená metadata se hydratují hned; bez payout cache se vzdálené čtení
neodkládá. Účty/Byznys mají okamžitý refresh a sdílí rozběhnutý požadavek.
Payout obrázky se stahují až v Byznysu, s cache podle uživatele/metadat
a možností retry po chybě. Review opravilo invalidaci, finanční cache
a pomalý status překračující TTL, aby optimalizace nezhoršovala spolehlivost.

Kontrolní tři kliky původního kódu ve stejném prostředí: účty za
2,073 / 1,218 / 1,389 s; nový běžný klik 1,185 / 1,313 / 1,221 s
(medián přibližně −12 %). Při přednačtení 1,34–1,46 s před otevřením
účty po kliknutí za 0,138–0,387 s. Jde o malý lokální vzorek s produkční
read proxy, nikoliv produkční percentily. Přímý URL start se touto změnou
prokazatelně nezrychlil. Žádné duplicitní startup požadavky při čerstvém
prefetch; expirace v browseru ověřena novým načtením. Pozdější background
live-pnl měl jednou 502 až po úspěšném full načtení; backend se neměnil.
Podrobnosti: Codex artifact `LIVE-STARTUP-20260905.md/json`.

Měřicí instrumentace je odstraněna. Stabilizovaný existující test pasivního
CDP snímku čeká na registraci listeneru místo pollingu proti 100ms deadline;
produkční timeout ani samostatné deadline testy se nemění. Bez push/deploy,
reinstalu workeru nebo brokerového ovládání.

Ověření: celá sada 2164/2164 prošla se čtyřmi souběžnými test workery,
včetně 13 nových prefetch a 4 payout-image testů. TypeScript a produkční
Vite/PWA build prošly, scoped lint bez chyb (32 stávajících warningů),
diff check čistý.
První souběžný běh s buildem měl dva časovací pády; targeted retry a finální
celá sada jsou zelené. Logy `/private/tmp/alphatrade-startup-final-*`.

### 2026-09-05 (Codex, měření prvního vstupu LIVE — pouze localhost)

Tři první kliky LIVE po novém dokumentu: oba účty a skupina za
0,921 / 2,520 / 2,317 s; full data za 1,577 / 3,592 / 3,400 s.
Tři přímé vstupy přes deep link: účty 1,150 / 1,175 / 1,483 s, full
2,601 / 2,182 / 2,727 s. Tři návraty v SPA: již načtené účty za
0,120 / 0,062 / 0,038 s. Měřeno performance značkami a kontrolou UI,
přihlášený uživatel, dva účty, zachovaná běžná cache. Vite klient stále
čte produkční API; nové serverové zrychlení se v těchto číslech neprovádí.
První klik po dokončení hlavního Dashboardu byl rychlejší než během jeho
startu; z kódu je potvrzena souběžná nepotřebná práce, ale její podíl proti
kolísání API zatím není izolovaně změřený. Cíl k A/B ověření: 1–1,5 s
účty a 2–3 s denní doplnění za podobné odezvy služeb. Dočasná instrumentace
odstraněna; žádné produktové změny, push, deploy ani zásahy do workeru.
Podrobná metodika a čísla: Codex artifact `LIVE-LOAD-20260905.md/json`.


### 2026-09-05 (Codex, celá aplikace na localhostu)

Na „celkově zapni localhost“ běží `npm run dev:live -- --host 127.0.0.1
--port 3000 --strictPort` ze stejného izolovaného worktree. Ignorovaná
`.env.local` obsahuje pouze existující veřejný Supabase URL a anon key.
CUA ověřil `http://localhost:3000/`, zachované lokální přihlášení, skutečný
dashboard a oba účty v LIVE s novým rozložením. Jde o lokální frontend se
stávajícím Supabase úložištěm a existující Tradovate read proxy na produkční
API, nikoliv izolovanou kopii databáze ani místní Vercel API backend.
Běžící worker i produkční nasazení zůstaly beze změny.


### 2026-09-05 (Codex, LIVE review opravy — pouze localhost)

Na souhlas uživatele s review 08bf59eb a explicitní „zatím pouze localhost“
vznikl izolovaný worktree `/private/tmp/alphatrade-live-fixes-20260905`, větev
`codex/live-reliability-20260905`. Původní dirty checkout zůstal nedotčený.
Nic není commitnuté, pushnuté, nasazené ani instalované do běžícího workeru.

Opraven extensionless import v `copierRiskConfig`, který na produkci shazoval
cloudový relay. Nová regrese emituje a cold-importuje všech 33 API přímo Node
ESM. Nový worker deklaruje capability `risk-config-v1`; UI u starého workeru
neukazuje domyšlené akce a neumožní uložit nové Risk parametry. Úspěšný ACK se
porovnává s požadovanou konfigurací. Bez změn pravidel exekuce/order cesty.

Datová oprava rozlišuje unavailable od potvrzeného prázdna, zachovává poslední
údaje a původní časy per účet, odmítá starší refresh/anchor i po souběžném cash
enrichmentu. Přesný úspěšný snapshot obnoví cash coverage; selhání cash nezahodí
pozice. Stará cena nedostane nový čas (TTL odhadu 15 s). Cache publikuje stav
konzistentně přes ref před React renderem. Cash běží už po account/list vedle
kontraktů, nejvýše pro tři účty současně; polling zobrazuje firmy průběžně.
Stav workeru nečeká na historii, status read má 1,5 s deadline a UI expiruje
nepotvrzený worker snapshot po 15 s. GET OAuth má 20 s deadline; write beze změny.

Z dashboardu odstraněny uživatelem označené statistiky leadera/účtů a banner
TradingView snímků. Diagnostika je pod skupinami, kompaktní tabulka nabízí
základní i všechny sloupce. Risk rozlišuje nastavení od skutečného kopírování,
vypnutá pravidla od neověřených a stav offline/pauza/shadow/lock/unknown.

Finální lokální sada 2147/2147 testů, tsc čistý po připojení existujících
extension závislostí, Vite/PWA build úspěšný. Cílený lint bez chyb; zůstává
předchozí warning journalOptions v hooku. Nezávislé review datových závodů
uzavřeno. CUA vizuálně ověřil dashboard, vypnutý Risk, pauzu a starý worker.
Náhled `http://127.0.0.1:4387/copytrade-preview.html` používá pouze ukázková data,
žádný broker ani produkční přihlašovací údaje. Rychlost na reálném brokerovi
nebyla měřena. Produkční cloud relay i starý Mac worker čekají na zvláštní rollout.


### 2026-09-05 (Claude, Risk záložka — sloučení fází A/B/C a review workeru)

Fáze A (worker + relay) Codex nedokončil — vyčerpal usage limit 1,74 M tokenů
před commitem; zbytek (tsc oprava testu agenta, review, commit) dodělal Claude.
Sloučeno do `claude/risk-tab-20260905` (A `93d27f3d`, B `7f6a3cd2` + opravy
`f6a3c8ec` (skupina bez `dayRuleActions` shazovala kartu) a `e035793d` (jeden
řádek na pravidlo), C `9a88f9ef` + `4b6bf282` (počítadlo vyřazených účtů
přeskočí vadný záznam místo nuly)). Celá sada 2090+ testů zeleně, tsc bez
nových chyb.

Nezávislé review workeru (code-reviewer) našlo blocker: selhání `close-copy`
při vyřazení účtu volalo `failClosed` a odzbrojilo celou skupinu, proti spec
§0 („vyřazení nikdy nezamyká skupinu"). Konečné řešení rozlišuje stav
brokeru: odmítnutí před odesláním (cizí symbol, neověřitelná kopie, cancel
u let-run) je per účet — `closed=false`, audit, skupina zůstává ARM,
neuzavřená kopie je exit-eligible jako let-run; neznámý výsledek liquidate
(outbox `unknown`) zůstává fail-closed pro skupinu, protože mock i Tradovate
transport hlásí výjimku jako neznámý stav a druhý pokus je zakázaný. Recovery
a update-group cesty (runtime DISARMED) zůstaly beze změny — pokus o scoped
chování i tam rozbil restart testy (reconnect auto-close). Dále: validace
`followerCuts`/`accountRisk` při načtení durable stavu. Nepřidáno: claim-side
tighten-only kontrola v relay (worker je autoritativní, enqueue kontrola stačí).

### 2026-09-05 (Codex, Risk tab — závazná specifikace a fáze C)

`docs/RISK_TAB_SPEC_20260905.md` sjednotila risk řízení copieru do samostatné
záložky Risk a rozdělila dodání na A (autoritativní worker + relay), B (PWA) a
C (read-only Mac companion, nativní notifikace a dokumentace). Tento worktree
řeší fázi C; fáze A/B zůstávají oddělené, aby UI ani companion nikdy
nevyhodnocovaly pravidla místo workeru.

`unlock-day` je zrušený: denní zámek lze ukončit jen novou broker session
(00:00 Chicago). Pauza je naopak dočasný stav rodiny LIVE — neDISARMuje,
nezavírá pozice, blokuje jen vstupy leadera zvyšující expozici, dál propouští
exity a sama vyprší; současný zámek má vždy přednost. Od prvního ostrého ARM v
session lze pravidla i limity už jen zpřísnit, nová session omezení resetuje.

Limity účtů jsou per follower: `dailyLossCutUsd` smí být nejvýš 95 %
`propLimitUsd`; po zásahu se vyřadí pouze dotčený účet do konce session, skupina
se nezamkne a účet se v téže session automaticky nevrací. Chybějící nebo starý
snapshot není důkaz bezpečí. Companion proto pouze promítá autoritativní PAUZA,
počet vyřazených účtů a tighten-only stav v additivním contractu v1; notifikace
hlídají jednu pauzu a jeden cut na účet/session, selhání `close-copy` je
samostatný critical incident.

### 2026-09-05 (Codex, Risk záložka PWA — fáze B)

LIVE PWA má samostatnou sdílitelnou záložku `?page=live&tab=risk`: kompaktní
kartu Pravidla dne s akcemi pauza/zámek a tighten-only ovládáním, tabulku osmi
sloupců Účty a propky s per-follower cut/max/onCut validací a Dashboard souhrn
se čtyřmi průběhy. Odemknutí dne bylo z PWA odstraněno; aktivní zámek nemá
zadní vrátka a vysvětluje konec v 00:00 Chicago. Neznámý původ zámku, safety,
broker P&L i výsledek otevřené kopie se zobrazují neutrálně jako neověřené,
nikdy jako odhadnutý bezpečný stav.

Risk zápisy posílají celý `update-group` přímo workeru a UI je přijme až z ACK;
společný mutex serializuje konfiguraci z Dashboardu, Risku i ARM. Generační
bariéra zahazuje status poll zahájený před/během zápisu, takže starší snapshot
nemůže ACK přepsat. Čerstvý (< 90 s), bezchybný worker `accountRisk` má pro
P&L přednost; stale/error/null nebo chybějící účet v existujícím worker feedu
zůstane neověřený. Broker fallback se používá jen při zcela prázdném Phase-A
feedu. Po Risk ACK se synchronizuje parent cache a Dashboard už v prvním
renderu adoptuje runtime skupinu, aby následující ARM neposlal starý draft.

Ověření: 8 cílených souborů / 63 testů zeleně; produkční Vite + PWA build
zelený. `npx tsc --noEmit -p tsconfig.json` nemá novou chybu a končí pouze na
známých chybějících Chrome typech a `@crxjs/vite-plugin` v `extension/`.
Bez push/deploy/broker akce; worker, relay, native companion a notifikace jsou
záměrně ponechané paralelním fázím A/C.

### 2026-09-05 (Claude + uživatel, čistá reinstalace iOS appky z `origin/main` 3b88dfb8)

Telefon (iPhone 13 Pro Max) měl stále bundle z 28. 8. (`e5ed71d3`), tedy
91 commitů za `origin/main` — chyběla mu karta pravidel dne / day-lock, unlock
flow i snapshoty v první notifikaci. Postup bez otevřeného Xcode: čistý
worktree nad `origin/main` (`3b88dfb8`), `npm run ios:sync` (doctor OK),
`xcodebuild -scheme App -configuration Debug -allowProvisioningUpdates` pro
zařízení, `codesign --verify --deep --strict` OK, obsah `App.app/public`
shodný s `dist-native` (navíc jen Capacitor `cordova*.js`). Poté záměrně
**`devicectl device uninstall` + čistá `install`** (ne upgrade přes běžící
appku), protože upgrade instalace podle zápisu z 21. 8. rozbíjí vykreslování
Live Activity. Appka po spuštění naběhla rovnou do Dashboardu s daty —
**přihlášení přežilo reinstalaci** (session je v Keychainu), nové přihlášení
nebylo potřeba.

Poznámky: (1) `cap sync` se symlinkovaným `node_modules` přepíše
`CapApp-SPM/Package.swift` na absolutní cesty — změna vrácena, nekomitovat.
(2) Screenshot telefonu bez Xcode: `python3 -m pymobiledevice3 developer dvt
screenshot out.png`. (3) Live Activity po čisté reinstalaci zatím fyzicky
neověřena — ověřit při příštím reálném ARM/obchodu. Copier runtime nedotčen,
žádný broker příkaz, ARM ani Flatten neproběhl.

### 2026-09-05 (Claude, rollout workera e018c3bb — snímky s reálným deadline)

Mac byl 4. 9. večer restartován (všechny worktree v /private/tmp zanikly,
`git worktree prune`), worker se přes launchd sám nastartoval 22:16 UTC a
zůstal s `lastError` transport chyby z doby restartu. Na „nasaď“ (sobota):
read-only reconcile → `mac-reinstall-safe.sh` z nového worktree na `main`
`e018c3bb` (bundle `1fa7f7f92e020090…`) → reconcile čistý, DISARMED, flat.
Bundle obsahuje 45 s deadline pro upload snímku a log `SNAPSHOT uploaded`;
`snapshotHealth: ready` (CDP i cílový graf dostupné). První ostrý důkaz přijde
s prvním vstupem/výstupem: očekávaný řádek `SNAPSHOT uploaded <symbol> <kind>
(N kB, +M ms)` a obrázek v notifikaci nahrazující text přes stejný
`collapseId`. Serverová část (validace deadline do 60 s) běží na Vercelu od
bec78536.

### 2026-09-04 (Claude, main měl po day-lock merge 3 červené testy)

Při deployi opravy snímků (bec78536) měla celá sada 3 pády, které na `main`
přinesl už merge day-lock pravidel (`efd9bf43` → `fa2674e4`): `cloneSafety`
vyráběla `dayLockSnoozedRules: []` a `dayUnlock: null` i do prázdného snapshotu
(test „prázdný store vrací prázdný snapshot“) a fake Supabase `rpc` v testu
služby vracel stále revizi 1, zatímco runtime od day-lock pravidel commituje
při startu vícekrát („invalid revision“). Oprava: volitelná pole se klonují,
ale nevyrábějí (runtime si defaulty doplní sám), fake `rpc` vrací rostoucí
revizi. Můj push bec78536 prošel přes červenou sadu, protože řetězení v shellu
použilo `;` místo `&&` — poučení zapsáno. Sada 1915/1915, tsc čistý.

### 2026-09-04 (Claude, snímky grafu k obchodům nikdy nedorazily)

Uživatel: včerejší ani dnešní obchody nemají v notifikaci ani v journalu
screenshot, přestože `snapshotHealth` hlásí `ready`. Worker log: každý pokus
3. 9. (14:01–15:24 UTC) i 4. 9. (07:09–07:30 UTC) skončil
`SNAPSHOT copier-relay-request-timeout`, `lastSuccessAt` nikdy nenastaveno.
Příčina v návrhu z `ba0551e6` („obrázek v první notifikaci“): celý capture +
upload musel stihnout `COPY_EVENT_IMAGE_PUSH_DEADLINE_MS = 1,5 s` od události,
capture sám směl 1,2 s → na upload 1–2 MB PNG zbývaly stovky ms a klient request
sám přerušil. Server navíc přijímal `notifyDeadlineAt` nejvýš 5 s po události.
Oprava: capture do 2,5 s, upload deadline 45 s (8 s na pokus, 3 pokusy),
server přijímá deadline do 60 s; textová notifikace odchází dál po 1,8 s a
obrázek ji nahradí přes stejný `collapseId` (text i image push ho sdílejí).
Úspěšný upload se nově loguje (`SNAPSHOT uploaded … kB, +ms`). Serverová část
je nasazena pushem; **worker část platí až po reinstallu** (obchodní den →
čeká na „nasaď“). Journal snímek dostane přes `copier_trade_snapshots`, jakmile
upload projde; staré obchody zpětně nedoplní.

### 2026-09-04 (Claude + uživatel, nasazení „Pravidla dne + zámek dne" — fáze A+B+C)

Po uživatelově „kopírka je vyplá, můžeš komplet pokračovat a nasadit":
1. Release větev `codex/daylock-release-20260904` = A (worker/relay/DTO)
   + B (PWA karta Pravidla dne, banner, dialog Odemknout) + C (companion
   build 17, ZAMČENO); ověřeno 105/105 cílených testů, typecheck, PWA build,
   Swift Release build. Bezpečnostní jádro A prošlo ruční kontrolou:
   `unlockDay` nikdy neARMuje a snoozuje jen spouštějící pravidlo, lock čeká
   na flat, ARM i entry mimo okno blokované, relay validuje důvod.
2. Supabase migrace `allow_copier_day_lock_commands` aplikována přes
   konektor (CHECK na `command_type` nově obsahuje `lock-until-session-end`
   a `unlock-day`; původní seznam neobsahoval ani lock — proto je změna
   nutná pro oba příkazy; všechny existující řádky v novém seznamu).
3. `main` fast-forward na `dcdac608` → auto-deploy serveru + PWA.
4. Worker: stav před reinstallem hlásil 5 divergentních followerů +
   `lastError` (leader flat, orphan kopie) — read-only reconciliation
   (`copier:mac reconcile`) potvrdila `authoritativelyClean` a flagy vyčistila
   bez broker příkazu. Záloha bundle+plist+config
   `~/Documents/AlphaTrade-backups/2026-09-04-101235-copier-worker-before-daylock-reinstall`.
   Reinstall `copier:mac install --adopt-durable-group` — durable skupina
   (leader `64310872`, 5 followerů) je autoritativní, CLI followeři z plistu
   jen fallback. Nový bundle `6eebfa95…`, služba běží, po startu VYPNUTO,
   druhá read-only reconciliation: 0 divergencí, `lastError=null`.
5. Companion build 17 nainstalován (záloha buildu 16).
Žádný ARM, Flatten ani broker write neproběhl. Klasifikátor reinstall
tentokrát neblokoval.

### 2026-09-04 (Codex, fáze B PWA Pravidla dne a odemknutí)

LIVE přehled má nad dosavadním obsahem jednotnou kartu Pravidla dne podle
schváleného `LockRules` vizuálu: šest group-safety pravidel, jejich hodnoty,
autoritativní průběh z controller statusu, stavový pill a zvýraznění pravidla,
které skutečně spustilo denní zámek. Staré denní safety vstupy byly z editoru
skupiny a šablon odstraněny; použití topologické šablony je už také nesmí tiše
přepsat. Uložení dál používá existující `update-group` cestu a neplatný číselný
limit, čas ani okno přes půlnoc se fail-closed neodešlou. Text v kartě
výslovně říká, že změna začne platit od příštího zapnutí.

Aktivní `dayLockUntil` zobrazuje rose banner s časem, ručním/automatickým
triggerem, worker důvodem a tlačítkem Odemknout. Dialog vyžaduje důvod 3–200
znaků bez řídicích znaků a desetisekundovou prodlevu; potom předá výhradně
existující relay příkaz `unlock-day`. Úspěch i chyba workeru zůstávají čitelně
v UI a úspěch výslovně potvrzuje VYPNUTO — nevznikla žádná ARM cesta. Ruční
„Zamknout den“ zůstal zachovaný a související PWA texty používají terminologii
VYPNUTO/ZAMČENO. Worker, server, push plán, companion ani broker se neměnily.

Ověření: všechny `tests/liveCopy*.test.ts` plus LIVE tab a relay sada prošly
13/13 souborů a 99/99 testů; loopback `localCopierExecutionAgent` po povolení
lokálního listen prošel 40/40. Scoped ESLint a `git diff --check` jsou čisté,
produkční Vite/PWA build prošel. `npm run typecheck` hlásí jen předexistující
chyby v `extension/` kvůli chybějícím Chrome typům a `@crxjs/vite-plugin`,
žádný změněný soubor. Karta a unlock dialog byly navíc vizuálně ověřeny v
reálném Chrome v dark i light PWA tokenech. Závislosti nebyly instalovány.

### 2026-09-04 (Codex, fáze A pravidel dne a zámku dne)

Dokončena fáze A podle `docs/DAY_LOCK_RULES_SPEC_20260904.md`: safety parser
na store/relay/controller hranicích doplňuje legacy defaulty, ale explicitně
neplatné `dailyMaxTrades`/`tradingWindow` odmítá. Worker persistuje trigger,
čas, snooze, auditované odemknutí, počet uzavřených leader obchodů, stav okna
a jednorázová varování; všechny automatické i ruční locky používají společnou
flat-only cestu. Entry mimo okno se pouze auditovaně blokuje, exit se nechává
proběhnout, LIVE ARM mimo okno je odmítnut a `unlock-day` nikdy neARMuje.

Relay/protocol, additivní companion contract v1, fail-closed server DTO a
redigované push druhy `daylock-engaged`/`rule-warning` jsou doplněné. DB CHECK
pro nový relay příkaz je připraven jako verzovaná migrace
`20260904120000_allow_copier_day_lock_commands.sql`, ale nebyl aplikován na
vzdálený Supabase; před aplikací je nutný samostatný backup/export a potom
security/performance advisory. Nebyla měněna PWA fáze B ani Swift fáze C,
neproběhl worker reinstall, broker akce ani produkční konfigurace.

Ověření: relevantní worker/store/relay/DTO/notifikační sada 237/237 a local
agent protocol 40/40, scoped ESLint bez nálezů, produkční Vite build prošel.
Root `tsc --noEmit` dál selhává pouze na již existujícím chybějícím
`chrome` typings a `@crxjs/vite-plugin` v `extension/`; změněné soubory v jeho
výstupu nemají chybu. Úmyslně se nespouštěl `npm ci`/`npm install` ani plná
testovací sada přesahující zadaný časový limit.

### 2026-09-04 (Codex, fáze C — Pravidla dne a ZAMČENO v macOS companionu)
- Build 17 ve větvi `codex/daylock-companion-20260904` dekóduje nová pole
  contract-v1 `dayLock` a `dailyRules` jako volitelná; jejich absence zachová
  dosavadní prezentaci. Reducer ukáže ZAMČENO jen pro čerstvě ověřený
  DISARMED lock bez problému; stale/unknown/offline a `!N` zůstávají nadřazené.
- Native UI podle `Lock*` mocků přidává rose `lock.fill` pill, DEN ZAMČENÝ,
  read-only cestu Otevřít LIVE a autoritativní sekci Pravidla dne. Sekce se bez
  `dailyRules` nevyrábí; `realizedLossUsd` se renderuje jen uvnitř ní. Nebyl
  přidán unlock/ARM command ani ruční animace rámu `NSPopover`.
- Detektor zachovává 3s anti-flap a 30s rate limit: lock je 60s zhoršení s
  notifikací a volitelným zvukem, warning je tichý nejvýš jednou pro
  `rule + sessionEndsAt`, nová session dá tichý 8s expiry toast a copier nikdy
  sama nezapne. Lock/warning notifikace neobsahují účty ani dolarové částky.
- Oveření: `build-for-testing` pro macOS arm64 prošel; plný systémový XCTest
  runner mimo sandbox prošel 68/68 včetně popover probe (span horní hrany a
  headeru 0,000 pt) a 20 light/dark snapshotů. CLI transition/resize probe
  prošel 126 kontrolami. Release arm64 0.2.0 (17) prošel, binár byl znovu
  ad-hoc podepsán s hardened runtime (`flags=adhoc,runtime`), strict codesign
  verification prošla; SHA-256 bináru
  `fd37612815f3578dbb9803dbdd1a5273ebd861bbd6ff46ef6966eb227f57e94b`.
- Aplikace nebyla instalována ani spuštěna jako uživatelský companion,
  LaunchAgent se neměnil a nic se nemergovalo. Serverová fáze A musí dodat
  DTO pole z autoritativního heartbeatu; do té doby build 17 funguje jako dnes.

### 2026-09-04 (Claude + uživatel, schválený návrh „Pravidla dne + zámek dne")

Uživatel schválil vizuál (canvas stránka „Zamčený den", `mockups/menubar-companion/Lock*.dc.html`)
a zadal implementaci bodů 1 (zámek viditelný všude), 3 (automatické zámky
z pravidel dne) a 5 (notifikace). Závazná specifikace:
`docs/DAY_LOCK_RULES_SPEC_20260904.md` — nová pravidla `dailyMaxTrades` a
`tradingWindow`, stav zámku s triggerem/snooze/unlock, příkaz `unlock-day`
(jen z přihlášené PWA přes relay, nikdy neARMuje, snooze spouštějícího
pravidla), varování N-1 / 80 % / 10 min před koncem okna, additivní DTO pro
companion (`dayLock`, `dailyRules`), prezentace ZAMČENO v liště/popoveru,
LIVE karta Pravidla dne s dialogem odemknutí, push druhy `daylock-engaged`
a `rule-warning`. Fáze: A worker+relay+server, C companion (paralelně),
B PWA (po A). Worker reinstall podle deploy politiky.

### 2026-09-03 (Claude + uživatel, rozhodnutí: broker-side day lock se nestaví)

Po read-only sondě práv OAuth tokenu (viz zápis Codexe a capability report)
uživatel rozhodl fázi 2 nedělat ani se neptát prop firem na lockout: skutečný
pre-trade zámek by závisel na admin vrstvě každé propky zvlášť, a pro budoucí
komerční nasazení by to bylo děravé. Směr: vylepšovat vlastní pojistky —
AlphaTrade day-lock (DISARM + blokace ARM do konce session) zůstává jediný
okamžitý zámek a je to interní vlastnost copieru, ne brokera. Otevřená
otázka „Zápis venue risk limitů" je uzavřená. Žádná změna kódu.

### 2026-09-03 (Codex, read-only Tradovate risk-limit capability probe)

Nová ručně spouštěná sonda má tvrdý GET allowlist, odmítá všechny jiné cesty
před `fetch`, tokeny/PII redukuje z výstupu a vyžaduje buď `--dry-run`, nebo
explicitní `--confirm-read-only`. Dry-run odeslal 0 requestů. Schválený skutečný
DEMO běh přes dvě existující paired-device OAuth identity provedl jen sekvenční
čtení s pauzami: Tradeify token vidí 5 účtů, Lucid 1; `/auth/me`, `/account/list`,
`accountRiskStatus`, `userAccountAutoLiq`, `tradingPermission`, `userPlugin`,
`user/list` a `marketDataSubscription/list` vrátily 200. Všech 6 account-specific
`/userAccountPositionLimit/deps` vrátilo 200 a prázdný seznam; globální
position-limit/risk-parameter `/list` a obecný `/permission/list` vrátily 404.
`changesLocked` nebylo v žádné AutoLiq odpovědi přítomné, tedy stav je neznámý,
ne `false`. Každý účet má riskCategory, takže prázdný user override nedokazuje
absenci category-level pre-trade limitů.

Verdikt: čtecí přístup je prokázaný, ale z 200 na GET, `Approved` trading
permission ani existence dokumentovaných POST endpointů nelze odvodit write
právo. AutoLiq je post-trade likvidace/lock po threshold; není to okamžitý
pre-trade „Zamknout den“. Fáze 2 nebyla provedena ani připravena jako
spustitelný write kód. Unit test allowlistu prošel 4/4 a celá sada 228/228
souborů, 1893/1893 testů; ESLint skončil s 0 chybami a 353 existujícími
warningy. Typecheck hlásí pouze předem známé `extension/` chyby kvůli
chybějícím Chrome typům a `@crxjs/vite-plugin`. Závislosti nebyly instalovány.

### 2026-09-03 (Claude, „Zamknout den" z produkční PWA — relay příkaz nepropouštěl)

Uživatel hlásil, že „Zamknout den" v LIVE nefunguje. Příčina: produkční HTTPS
PWA posílá příkazy workerovi přes relay (`tradovateCopierCommandRelay`), jehož
allowlist `lock-until-session-end` neobsahoval — ingress vracel
`unsupported-relay-command`, worker se o příkazu nedozvěděl (v agent logu
žádný pokus). Handler ve workeru existuje (`lockUntil`: `armed=false` +
persistovaný `dayLockUntil/dayLockReason` do konce Tradovate session) a je
i v nasazeném bundle `7763bfcd`, takže reinstall workeru není potřeba.
Bezpečnostní rozhodnutí: denní lock je čistě riziko snižující (DISARM +
zákaz ARM), patří do stejné vzdálené třídy jako `disarm`/`kill-switch`;
`resolve-stuck-operation` a broker-write příkazy zůstávají na relay
zamítnuté. Přidáno do allowlistu s validací `reason` (string, trim 3–200
znaků, bez řídicích znaků) na enqueue i claim straně; testy round-tripu a
odmítnutí neplatných payloadů. Cílené sady 72/72, eslint 0 chyb, typecheck
mimo `extension/` čistý. Codex byl zadán, ale selhal na výpadku OpenAI
backendu (404), proto opravu udělal Claude. Serverová změna — nasazení až
po „nasaď".

### 2026-09-03 (Codex, page deep link funguje i v už otevřené PWA)

Externí `page` intent se už nečte jen při prvním mountu. PWA jej zachytí při
`focus`, `pageshow`, `popstate`, návratu do viditelného stavu i přes
`launchQueue`, přijme pouze podporovanou stránku, počká na autoritativní DB
roli a teprve potom naviguje; zakázaná stránka dál skončí na Dashboardu.
Zpracované `page`/`tab` se jednorázově odstraní přes `replaceState`, takže
další focus navigaci neopakuje. Pairing marker, legacy LIVE/Connections odkaz
i sessionStorage round-trip přes login zůstaly zachované.

LIVE dostává validovaný jednorázový `requestedTab` z App; již připojený
`TradovateLiveDesk` proto umí přepnout na `overview` bez remountu. Právě tato
záložka obsahuje `LiveCopyTradeOverview` s ovládáním copieru. Současný Swift
odkaz zůstává podle zadání beze změny jako `?page=live`; chybějící nebo neznámý
LIVE tab bezpečně končí na `overview`, explicitní `?page=live&tab=overview`
funguje stejně.

Ověření: cílené Vitest testy deep linku a LIVE tabů prošly 2 soubory / 9 testů,
produkční Vite/PWA build prošel a scoped ESLint má 0 chyb (26 předexistujících
warningů v `App.tsx`). Root `npm run typecheck` hlásí pouze předem známé chyby
v `extension/` kvůli chybějícím Chrome typům a `@crxjs/vite-plugin`, žádnou
chybu v dotčených souborech. Závislosti nebyly instalovány a Swift, worker,
broker, ARM/DISARM, Flatten, produkční konfigurace ani `main` se neměnily.

### 2026-09-03 (Claude, opakované push notifikace včerejších obchodů)

Uživatel od 2. 9. večera dostával pořád dokola notifikace včerejších obchodů.
Vercel log `/api/cron/send-alerts`: každou minutu „36 copier alerts“ (12
notifikací × 3 zařízení), přes 1 200 běhů. Příčina v
`server/nativeFinancialAlertPlanner.ts::planClosedTradePnlNotifications`:
marker `state:closed-trade-pnl` drží jen 40 nejnovějších `trade_id`, ale cron
načítá až 500 řádků `tradovate_copier_trades`; jakmile počet obchodů zařízení
přesáhl 40 (včerejších 13 obchodů), starší vypadly z okna a byly „čerstvé“
navždy. Oprava: obchod uzavřený před více než 30 minutami se nikdy neoznamuje
(jen se zapíše do markeru) a právě oznámená ID v markeru vždy zůstávají.
Regrese: 45 obchodů + marker 40 → 0 notifikací; čerstvý close projde právě
jednou; stale close bez markeru se neoznámí. Sada 1884/1884, tsc čistý.
Nasazeno pushem na main (cron běží na Vercelu, worker se nemění).

### 2026-09-03 (Claude, rollout 1bb55621 — recovery hardening)

Codex K (zpevnění recovery podle cross-review R1+R2) zrecenzován Claudem a
sloučen jako `1bb55621`; celá sada 1882/1882, tsc čistý. Worker reinstalován
z tohoto commitu (start 07:41:06 UTC), post-restart reconcile čistý,
`unverifiableFollowerOwnership: []`. Dnešní zmizelý breached follower 63338752
je v durable epoše `eligibleAtOpen:false / copyLineage:unproven`, tedy
neparticipant — jeho odebrání ze skupiny nevyžaduje waiver. Web deploy
automaticky. Zbývá na uživateli: odebrat 63338752 (jedním klikem z ARM modalu
nebo v editoru), případně přidat nový Lucid 64503883, Kontrola pozic, vědomý
ARM. Otevřené: race opravy z review C (P0 partial-fill-aware guard, P1 settling
okna), zbytkový lot −3 v denní statistice po flat (proč vznikl).

### 2026-09-03 (Codex, recovery partial-snapshot a ownership-waiver hardening)

`ReconciliationResult` nyní rozlišuje `authoritativelyClean` a vypisuje
nesnímkované účty. Čistota vyžaduje nulovou divergenci i working orders,
nezměněnou safety generation přes veškeré I/O a žádného přeskočeného
participanta neukončené leader-flat epochy. Guard má jen lineage hodnoty
`confirmed | unproven`; participant je proto `eligibleAtOpen` nebo
`copyLineage: confirmed`, zatímco `eligibleAtOpen:false + unproven` je známý
neparticipant a jeho OAuth absence je legitimní.

Recovery drží pending a durable markery, dokud tento důkaz není čistý. OAuth
resolver běží před každým pokusem a po reconciliation znovu; změna množiny
snapshot zahodí a nově dostupný follower se v dalším pokusu skutečně snímkuje.
Synchronní `updateGroup` zachová okamžitý DISARM, ale za aktivní recovery nebo
reconciliation odmítne změnu, takže vstup snapshotu nezestárne.

Odebrání OAuth-missing lineage participanta přes `reconfigureGroup` i
`activateGroup` bez waiveru vrátí konkrétní účet/epochu. LIVE modal a editor
zobrazí druhé potvrzení; teprve to pošle
`waiveUnverifiableFollowerOwnership:true` přes relay/agenta. Controller zapíše
blocked audit `ownership waived by operator` a až potom zahodí staré markery.

Oveření: kompletní Vitest **227/227 souborů, 1882/1882 testů**; strict TypeScript bez
výstupu a `git diff --check` čistý. Závislosti nebyly instalovány. Nic nebylo
commitnuto, pushnuto, deploynuto ani spuštěno/reinstalováno na workeru nebo
brokeru; neproběhl ARM, DISARM ani Flatten.

### 2026-09-03 (Codex, companion build 16 — jednotné VYPNUTO a odložený preflight)

Uživatelská terminologie companionu je sjednocená na VYPNUTO: hero, menu-bar
pill, notifikace, accessibility, tooltipy, fixture katalog i diagnostické
texty už nezobrazují DISARM/DISARMED. Interní enum `.disarmed` a serverový
kontrakt `copierState: "disarmed"` zůstávají beze změny. Ověřený flat stav má
neutrální `power` pill VYPNUTO a badge „flat ověřen“, neověřená expozice dál
zůstává rose VYPNUTO. Regrese pro všechny remote prezentace a všechny fixtures
prohledává rozšířené `allVisibleText` regulárním výrazem `(?i)\bdisarm`.

Samotná reconciliation `review` ve VYPNUTO/SHADOW je nově považovaná za
odloženou kontrolu před příštím zapnutím, pouze pokud nejsou divergence,
zaseknutý outbox, kill switch ani jiný druh problému. Nezvyšuje issue count,
nepřepíná stav na ZÁSAH NUTNÝ, neotevírá popover a sekce Bezpečnost zůstává
sbalená s amber souhrnem „Kontrola před zapnutím“ a řádkem „Proběhne před
zapnutím“. Stejná reconciliation v LIVE nebo spolu s jiným problémem zůstává
fail-closed incident. Přechodová logika potlačuje i falešné worsening/improved
notifikace od tohoto odloženého preflightu.

Build číslo bylo zvýšeno na 16. Runner-independent probe prošel 105 kontrolami,
celý XCTest target 58/58 testy včetně AppKit sondy s rozpětím horní hrany okna
i hlavičky `0,000 pt` při expand i collapse a samostatný Debug
`build-for-testing` prošel. Release 0.2.0 (16) je thin arm64; po explicitním
ad-hoc přepodpisu má hardened runtime a jen app sandbox + network client
entitlement, `codesign --verify --deep --strict` prošel. SHA-256 Release
executable je
`46155847cd1255ab5ddb4961d8dccb50777393247fefa1187cc4cb117ce3fde5`.
Nic nebylo instalováno ani spuštěno přes LaunchAgent; serverový runtime,
produkce a hlavní repo se neměnily.

### 2026-09-03 (Codex, companion build 15 — změřená stabilní hlavička popoveru)

Nový AppKit XCTest `PopoverAnimationProbeTests` otevírá skutečný `NSPopover`
s LIVE fixture, vyvolá rozbalení i sbalení sekce Bezpečnost a po 8 ms po dobu
0,4 s tiskne `window.frame.maxY`, rám hosting view v okně a obrazovkovou pozici
kotvy vložené přímo přes title `alphaTrade.status.title`. Baseline buildu 14
ukázala, že kotva popoveru se nehýbe, ale hosting view se při rozbalení
přechodně smrští a SwiftUI obsah se v něm přepočítá:

| Fáze | t [ms] | window.maxY | content height | header.maxY |
| --- | ---: | ---: | ---: | ---: |
| build 14 expand | 0 | 700,000 | 485 | 671,000 |
| build 14 expand | ~150 | 700,000 | ~261 | ~815,9 |
| build 14 expand | ~250 | 700,000 | ~132 | ~910,5 |
| build 14 expand | ~270 | 700,000 | 615 | 671,000 |
| build 14 collapse | 0–400 | 700,000 | 615 → 485 | 671,000 |

Naměřený span buildu 14 byl při rozbalení `window.maxY = 0,000 pt`, ale
`header.maxY ≈ 241,582 pt`; při sbalení byly oba spany 0. Příčinou tedy není
posun okna vůči arrow/kotvě. Cold-start diagnostika navíc ukázala
`NSHostingController.fittingSize = 0–1 pt`, i když jeho skutečný zobrazený
`view.bounds.height` už byl 487 pt. První target se proto mohl na jeden snímek
spočítat jako `1 + 130 = 131 pt`. Jde o nesoulad hosting view a SwiftUI obsahu
při souběhu implicitní animace `NSPopover.contentSize` s `withAnimation`
(kandidát c, s fázovým přesahem kandidáta a). `.move(edge: .top)` pohyb ještě
zbytečně propagoval do layoutu, ale nebyl zdrojem pohybu `window.maxY`.

Build 15 používá deterministický fallback bez ruční animace rámu a bez
autoresizing hosting view: rozbalení nejdřív okamžitě rezervuje finální
`contentSize`, vloží detail bez layoutové animace a až další průchod run loopu
animuje jen opacity/offset/y-scale; sbalení detail nejdřív vizuálně skryje a
teprve po 0,25 s bez animace zmenší layout i `contentSize`. Hlavička je
layoutově izolovaná v top-aligned overlay a rezervovaný prostor je vyplněný
barvou panelu. Každý přechod bere jako výchozí velikost aktuální
`contentViewController.view.bounds`, takže není závislý na cold fitting size.
Koordinátor mezilehlá měření dál slučuje, ale žádný AppKit rám ručně neanimuje.

Finální sonda měla po všech vzorcích rozbalení `window.maxY = 700,000`,
`content height = 617,000`, `header.maxY = 671,000`; při sbalení zůstal obsah
617 pt do konce vizuální animace a potom přešel na 487 pt, zatímco
`window.maxY` i `header.maxY` byly konstantní. Span hlavičky i horní hrany je
v obou směrech `0,000 pt`, tedy pod limitem 0,5 pt.

Build číslo bylo zvýšeno na 15. Runner-independent probe prošel 91 kontrolami,
celý XCTest target 54/54 testy včetně AppKit sondy a light/dark renderů a
samostatný Debug `build-for-testing` prošel. Release 0.2.0 (15) prošel jako
thin arm64; po explicitním ad-hoc přepodpisu má hardened runtime a pouze app
sandbox + network client entitlement, `codesign --verify --deep --strict`
prošel. SHA-256 Release executable je
`b332d63b81e6c8a1e540052b6d607d4006937a725cb2bc1e2fa01a9613a81131`.
Nic nebylo instalováno ani spuštěno přes LaunchAgent.

### 2026-09-03 (Codex, companion build 14 — samostatný stav VYPNUTO)

Čerstvý (≤ 10 s), bezpečnostně čistý `copierState: disarmed` bez
`exposure.verifiedAt` už není prezentován jako porucha STAV NEZNÁMÝ. Reducer
vrací samostatný `disarmedUnverified`: rose pill se SF `power` a textem
VYPNUTO, hero výslovně potvrzuje jen to, že copier neposílá příkazy, a muted
věta říká, že brokerem neověřenou expozici nelze označit za flat. Ověřený flat
DISARMED zůstal neutrální a neúplný brokerový důkaz se známým `verifiedAt`
zůstává fail-closed NEZNÁMÝ; stale heartbeat přebíjí i VYPNUTO.

VYPNUTO má všechny sekce sbalené v pořadí Bezpečnost → Expozice → Copier
runtime → Snímky. Primární „Zapnout v LIVE" pouze naviguje na
`?page=live&tab=overview`; žádná ARM/DISARM/Flatten ani jiná command cesta
nepřibyla a scope zůstává `copier.status.read`. Přechody VYPNUTO ↔
LIVE/SHADOW jsou režimové notifikace bez zvuku, samotná ztráta flat evidence
z ověřeného DISARMED není zhoršení. Popover dál mění jen
`NSPopover.contentSize`; rám okna se ručně neanimuje.

Build číslo bylo zvýšeno na 14. Runner-independent probe prošel 91 kontrolami.
Sandboxovaný XCTest narazil na zákaz přístupu k `testmanagerd`, následné
spuštění mimo sandbox prošlo 51/51 testy včetně light/dark renderů VYPNUTO.
Samostatný Debug `build-for-testing` prošel. Release 0.2.0 (14) je thin arm64,
ad-hoc podepsaný s hardened runtime (`adhoc,runtime`), po opětovném podpisu
obsahuje jen app sandbox + network client entitlement; `codesign --verify
--deep --strict` prošel. SHA-256 Release executable je
`6d53f51788d5ff3543a4fa52d3ca21f97d22c9747483a49d8f0680a13430ac3e`.
Release aplikace nebyla instalována ani interaktivně spuštěna; LaunchAgent ani
PWA se neměnily (XCTest spustil pouze Debug test host).

### 2026-09-03 (Claude, companion build 13 — návrat k contentSize animaci, buildy 10–12 zahozeny)

Build 12 (autoresizing hosting view během animace rámu okna) vytvořil
měřicí smyčku: view hlásilo SwiftUI novou velikost → koordinátor znovu
animoval okno → dokola; popover zůstal s prázdnou plochou dole a aplikace
zamrzla. Uživateli byl okamžitě vrácen build 11 ze zálohy. Poučení: rám okna
NSPopoveru neanimovat ručně — obsahové view mění jen NSPopover při změně
`contentSize`. Build 13 = Codexova původní implicitní animace
`popover.contentSize` (build 8, uživatelem potvrzená jako plynulá) + přišpendlení
obsahu k hornímu okraji (build 11), které samo o sobě řeší „ujetí od shora"
způsobené vertikálním centrováním. Okenní úpravy z buildů 10 a 12 odstraněny.
Release build 13 a build-for-testing prošly, build 11 zálohován, appka
vyměněna, autostart znovu bootstrapován.

### 2026-09-03 (Claude, companion build 12 — obsah sleduje rám okna během rozbalení)

Po buildu 11 zůstalo „ujetí od shora" jen při rozbalení. Příčina: NSPopover
mění velikost svého content view až při změně `contentSize`; během animace
rámu okna si hosting view drželo starou velikost ukotvenou vlevo dole,
sjelo s rostoucím oknem dolů a při závěrečné synchronizaci skočilo zpět.
Při sbalení se okno zmenšuje až na konci, proto asymetrie. Oprava
v `animatePopoverWindow`: `autoresizingMask = [.width, .height]` +
`autoresizesSubviews` na kontejneru a srovnání rámu před animací, takže
obsah sleduje okno po celou dobu. Release build 12 (sestavený uživatelem
v terminálu během výpadku klasifikátoru) a build-for-testing prošly,
build 11 zálohován, appka vyměněna, autostart znovu bootstrapován.

### 2026-09-03 (Claude, companion build 11 — obsah přišpendlený k hornímu okraji)

Build 10 (pevná horní hrana okna) „ujíždění od shora" nevyřešil. Skutečná
příčina je uvnitř hostovaného view: kořen má pevnou šířku a ideální výšku,
a když je okno během animace vyšší než obsah, NSHostingView obsah vertikálně
vycentruje — hlavička se tak během rozbalení posune dolů a zpět. Oprava:
oba vstupní wrappery (`StatusPopoverEntranceView`, `CompanionRootEntranceView`)
mají `.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)`,
takže přebytek výšky zůstává dole a hlavička se nehýbe. Release build 11 a
build-for-testing prošly, build 10 zálohován, appka vyměněna, autostart
znovu bootstrapován.

### 2026-09-03 (Claude, companion build 10 — popover při rozbalení „nevytahuje" horní hranu)

Po plynulém rozbalení (build 8) uživatel hlásil, že se při otevření/zavření
sekce hýbe i horní část popoveru — okno se natáhne nad kotvu a zase zajede.
Příčina: animovaná větev nastavovala `popover.contentSize` uvnitř
`NSAnimationContext` s implicitní animací; AppKit rám okna mění kolem
počátku vlevo dole, takže roste i nahoru, a NSPopover ho až po doběhnutí
vrátí pod status item. Oprava (`animatePopoverWindow(to:duration:)`):
animovat přímo `window.animator().setFrame` s pevným `maxY` (výška i posun
počátku o stejný delta), po doběhnutí zesynchronizovat `contentSize` bez
animace. Koordinátor beze změny. Release build 10 + build-for-testing
prošly, build 9 zálohován, appka vyměněna, autostart znovu bootstrapován.

### 2026-09-03 (Claude, companion build 9 — lišta o krok pozadu)

Uživatel hlásil, že pill v liště reaguje se zpožděním o jeden stav (po
zapnutí LIVE ukazuje DISARMED, po vypnutí teprve LIVE). Příčina: `@Published`
emituje ve `willSet`, a sink na `store.$menuBarPresentation` volal
`applyAppearance`, který si hodnotu znovu četl ze store — tedy ještě starou.
Oprava: kreslit z hodnoty nesené eventem (`applyAppearance(_:menuBar:)`),
re-render při změně vzhledu dál čte aktuální stav. Zároveň v build 8/9:
lišta jen `LIVE` (minuty zůstávají v popoveru), sekce Kopírování bez
ověřených dat říká „Expozice neověřena" / „Nedostupné". Release build 9 a
build-for-testing prošly, XCTest runner se v této session nespojil
(Codex měl 48/48 na buildu 8). Build 8 zálohován, appka vyměněna, autostart
znovu bootstrapován. Jen `macos/` a `docs/`.

### 2026-09-03 (Codex, companion build 8 — plynulá změna výšky sekcí)

Příčina drhnutí buildu 7 byla potvrzena: oba `NSHostingController` používaly
automatické `preferredContentSize`, takže SwiftUI během 0,25s transition
posílalo popoveru mezivýšky a AppKit měnil okno mimo jediný společný rytmus.
Build 8 používá řešení 1: `sizingOptions = []`, kořen měří skutečnou velikost
přes SwiftUI preference a čistý koordinátor zná cílový rozdíl výšky sekce už
před animací. `NSPopover.contentSize` dostane jediný cíl v
`NSAnimationContext` se stejnými 0,25 s ease-in-out; všechny meziměry jsou do
konce přechodu koalescované. Šířka je vždy 360 pt. Reduce Motion mění velikost
okamžitě; 0,22s chevron, vstupní pop-in, in-place §11 aktualizace, hover a
auto-close se nezměnily. Nevznikl nový fokusovatelný AppKit prvek.

Samostatná AppKit sonda na skutečném WindowServeru potvrdila, že řešení 1 na
tomto macOS skutečně interpoluje frame `146 → 263 → 326 pt` a horní kotva
zůstává přesně `700 pt`; fallback na přímý frame okna proto nebyl potřeba.
Deterministický koordinátor i render sada prošly cíleně 10/10 a celá nativní
sada 48/48 XCTest. Runner-independent CLI probe prošel 73/73, Debug
`build-for-testing` i arm64 Release build prošly. Build má CFBundleVersion 8;
dočasný bundle byl ad-hoc podepsán s Hardened Runtime a dodanými App Sandbox +
outgoing-network entitlements, `codesign --verify --deep --strict` prošel a
binární SHA-256 je
`b95efe8cf5e958a597a3bf2023ca703aa60400c9b29e03e9a6888e714f6d3dc2`.

Webový `npx tsc --noEmit` nebylo možné v tomto izolovaném worktree dokončit:
nemá vlastní `node_modules`, `npx` skončilo na Keychain
`SecItemCopyMatching failed -50` a přímý sdílený `tsc` nemohl z tohoto kořene
najít `@types/node`; TypeScript soubory se neměnily. Build 8 nebyl instalován,
spuštěn jako produkční companion ani mergován; LaunchAgent, server/PWA,
worker, broker a copier zůstaly beze změny.

### 2026-09-03 (Codex, odebrání nedostupného followera přímo z blokace)

ARM dialog pro skupinu blokovanou pouze účty chybějícími v aktuálním OAuth
snapshotu nově rozlišuje leadera a followery. Chybějící leader nabízí jen
ruční `Edit group`; chybějící followeři dostanou potvrzení se stejným diffem
jako editor a akcí „Odebrat nedostupné účty a uložit“. Úspěch nechá copier
DISARMED a nabídne `Zapnout` až jako samostatný klik. Stejná potvrzovací cesta
je dostupná hromadně v amber banneru kroku Followeři a jednotlivě v řádku
nedostupného followera. Selhání reconfigure zůstane viditelné ve stejném modalu
s doporučením spustit Kontrolu pozic.

UI dál posílá existující `update-group`; lokální agent beze změny odvodí
odebírané chybějící followery jako optional a volá
`reconfigureGroup(next, { missingOptionalAccountIds })`. Formát
`CopyGroupConfig`, runtime/controller a ARM politika se neměnily. Cíleně
prošlo 3 soubory / 24 testů a agent 38/38; plná sada prošla 225/225 souborů a
1867/1867 testů, strict TypeScript bez výstupu, cílený ESLint, produkční build
a `git diff --check`. Nic nebylo commitnuto, pushnuto, deploynuto ani spuštěno
na workeru/brokeru; neproběhl ARM, DISARM ani Flatten.

### 2026-09-03 (Claude, companion build 7 — ozubené kolo bez focus ringu)

Uživatel nahlásil modrý rámeček kolem nového tlačítka nastavení. Příčina:
SwiftUI `Menu(.borderlessButton)` je AppKit pop-up button s vlastním focus
ringem, který `focusEffectDisabled()` na hostovaném kořeni neovlivní, a po
otevření popoveru byl prvním fokusovatelným prvkem. Náhrada: `NSViewRepresentable`
s `NSButton` (`focusRingType = .none`, bordered=false) a nativním `NSMenu`
se čtyřmi stavovými položkami nad `CompanionSettings`; vzhled i chování
přepínačů beze změny. Release build 7 + build-for-testing prošly, codesign
strict OK, build 6 zálohován, appka vyměněna a autostart znovu bootstrapován.
Jen `macos/` a `docs/`, bez zásahu do serveru, PWA, brokeru či copieru.

### 2026-09-03 (Claude + uživatel, nasazení companion build 6 s auto-otevřením)

Po dvou kolech Codexu (implementace §11 + opravy z nezávislého review: sekce
podle §5 zůstávají otevřené, in-place aktualizace otevřeného popoveru,
samostatný 30s limiter notifikací, reset rate limitu po wake) uživatel řekl
„nasaď". Build 6 sestaven z `12684fda` (arm64 Release, adhoc+runtime, SHA-256
`c88ca47cc46935d9d95921583bd016d190d008eb986c8badcdbc725d8c9befad`), build 5
zálohován v `~/Documents/AlphaTrade-backups/2026-09-03-082833-mac-app-build5-before-build6`,
aplikace vyměněna a autostart znovu bootstrapován (`state = running`).
`main` fast-forwardován `731cc0b6..12684fda` — dotčené jen `macos/` a `docs/`,
PWA/server beze změny. XCTest runner na tomto Macu dál nefunguje; ověřeno CLI
probe 58/58 + build-for-testing + Release build. Interaktivní kontrola
(notifikace, hover timer, zachování fokusu) zůstává na uživateli. Bez broker
write, ARM/DISARM ani zásahu do copier workeru.

### 2026-09-03 (Codex, druhé kolo review AlphaTrade Status auto-open)

- Přechod už nesbalí povinně otevřené problémové sekce: výsledná množina je
  `isInitiallyExpanded` plus cílová sekce a při aktualizaci zachová i ručně
  rozbalené sekce. Už otevřený popover dostává nový `transitionEvent` přes
  existující observed store; AppDelegate nevytváří nový hosting controller,
  takže nezahodí SwiftUI `@State` ani znovu nepřehraje vstupní animaci.
- Nativní notifikace mají vlastní 30s limiter nezávislý na auto-open bráně.
  Limiter používá wall clock, který započítá spánek; přechod v už otevřeném
  popoveru tedy smí notifikovat, ale další během stejného okna ne. Auto-open
  brána při wake uvolní pouze své 30s okno a zachová revision guard, settled
  stav i anti-flap kandidáta. Lokální macOS `clock_gettime(3)` potvrdil, že
  `CLOCK_MONOTONIC` spánek započítává; cílený wake reset byl menší změna bez
  výměny dosavadního injektovatelného clocku.
- Čerstvý CLI probe prošel 58/58 kontrolami a `xcodebuild build-for-testing`
  sestavil app i test target. XCTest runner v sandboxu skončil ještě před
  assertions na blokovaném `testmanagerd`; mimo sandbox se spustil host, ale
  zůstal na `waiting for workers to materialize` a po přibližně 60 s byl
  ohraničeně přerušen. Nebyla provedena žádná XCTest assertion a netvrdíme
  XCTest PASS.
- Finální arm64 Release build 6 prošel. Dočasný artefakt byl ad-hoc podepsán
  s Hardened Runtime a dodanými App Sandbox + outgoing-network entitlements;
  `codesign --verify --deep --strict` prošel, flags jsou `adhoc,runtime`,
  TeamIdentifier není nastaven a binární SHA-256 je
  `1cdca39710e079692670fe6bc14e2fbd19a73129e41caac84ed6cf2594d6c79b`.
  Nic nebylo instalováno ani spuštěno jako běžná aplikace, LaunchAgent a
  instalovaný build 5 zůstaly beze změny. Server/PWA, broker i copier se
  neměnily; větev není sloučená do `main`.

### 2026-09-03 (Codex, AlphaTrade Status v1.4 auto-open; build 6 pouze připraven)

- Implementována závazná matice §11 nad výstupem stávajícího freshness reduceru:
  čistý `CompanionTransitionDetector` vrací zhoršení, zlepšení nebo změnu režimu
  s cílovou sekcí/řádkem a bezpečným důvodem bez účtů a P&L. Store přidává
  třísekundové ustálení, nejvýše jedno povolené auto-otevření za 30 sekund,
  odmítnutí nižší revize a potlačení startu, wake a ručního refreshu. Zlepšení
  vzniká jen z ověřeně čerstvé prezentace, nikdy ze stale/UNKNOWN mostu.
- Popover se otevírá přes `NSPopover.show` bez aktivace aplikace a zůstává
  `.transient`; zhoršení má 60s timer, toast 8s, hover timer pozastaví. Při už
  otevřeném ručním popoveru se pouze aktualizuje obsah. Rozbalí se jen cílová
  sekce, řádek se zvýrazní na 1,2 s a pill třikrát pulzuje; Reduce Motion pohyb
  i dočasný highlight vypne. Ozubené kolo ukládá čtyři přepínače do
  `UserDefaults` s defaulty dle specifikace.
- Zhoršení a změna režimu mohou po prvním souhlasu poslat nativní notifikaci;
  klik otevře stejný read-only popover, nikdy LIVE ani ovládání copieru. Zvuk
  je samostatně opt-in pouze pro zhoršení.
- Ověření: test target prošel `xcodebuild build-for-testing`; samostatný Swift
  CLI probe prošel 49/49 kontrolami matice, negativních případů, anti-flapu,
  rate limitu, rollbacku revize, start/wake/manual refresh a vypnutých
  nastavení. Samotný XCTest runner v sandboxu nenavázal `testmanagerd`; mimo
  sandbox zůstal na `waiting for workers to materialize` a po přibližně 98 s
  byl přerušen, takže nebyla provedena žádná XCTest assertion a netvrdíme
  XCTest PASS.
- Arm64 Release build 6 prošel. Dočasný artefakt byl znovu ad-hoc podepsán
  dodanými sandbox/network-client entitlements a Hardened Runtime; `codesign
  --verify --deep --strict` prošel, flags jsou `adhoc,runtime`, architektura
  `arm64`, TeamIdentifier není nastaven a binární SHA-256 je
  `0e0939ab54cdce36ee0f8c6753a897ab131e793429c7ca8bd8cb55c1c853eda5`.
- Nic nebylo instalováno ani spuštěno, LaunchAgent i instalovaný build 5 zůstaly
  beze změny. Beze změny jsou také server/PWA, broker, copier a jeho ARM stav;
  větev není sloučena do `main`.

### 2026-09-03 (Claude, rollout 30a48144 + J; druhé kolo cross-review)

Codex cross-review commitu 5154856d dal „opravit“: čistá ruční Kontrola pozic
s optional skipem nesmí sama shodit `pendingConnectionRecovery` (přeskočila by
obnovu leader-flat guardu, úklid exposure markeru a recovery audit; částečný
snapshot ≠ dokončená recovery). Přepracováno (30a48144): čistý ruční výsledek
recovery jen znovu naplánuje; vlna si vezme optional-skip a příznak shodí sama
po kompletním doběhu, při selhání zůstává pending. Chyby resolveru i pěti
pokusů se auditují a jsou ve fail-closed zprávě. Druhý dnešní blocker „Změnu
leadera blokuje otevřená durable pozice leadera“ = zbytkový lot MNQ −3 z 2. 9.
18:44 v denní statistice po hranici session; brána nyní používá session-aware
`currentDailyStats(now)` jako zbytek controlleru. Regrese: 5 nových testů,
celá sada 1868, tsc čistý. Worker reinstalován ze 30a48144 (start 07:06:28
UTC), post-restart reconcile čistý. Codex J sloučen (3699fe12): odebrání
OAuth-missing followera jedním krokem z ARM modalu, editoru i řádku účtu; ARM
zůstává samostatný klik. Otevřené z review: stale resolver (routing revision),
`updateGroup` mimo eventTail, zbytkový lot ve statistice (proč −3 po flat).
Provozní incident: v 07:06 UTC se vyprázdnil sdílený `node_modules` hlavního
checkoutu (příčina neprokázána), obnoven `npm ci`; Codex briefy dostanou zákaz
`npm ci`/`npm install`.

### 2026-09-03 (Claude, rollout 5154856d — recovery vs. zmizelý follower)

Uživatel nemohl uložit skupinu bez breached `63338752` („Změnu leadera blokuje
rozpracovaný lifecycle: connection recovery“) ani zapnout ARM („Follower účet
… není dostupný“). Příčina: recovery vlna po startu routovala i follower, který
už není v žádném OAuth adresáři, router hodil chybu, po pěti pokusech
fail-closed a `pendingConnectionRecovery` zůstal zapnutý (záměr z I), přičemž
ruční Kontrola pozic ho neshazovala. Oprava (Claude, copier core, Codex
cross-review vyžádán): recovery dostává přes `resolveMissingOptionalAccountIds`
stejný optional-skip jako CLI/UI, a autoritativně čistá ruční Kontrola pozic
příznak shodí; divergentní/neúspěšná ne. Regrese
`tests/copierConnectionRecoveryOptionalFollower.test.ts` (router bez route).
Celá sada 1866/1866, tsc čistý. Worker reinstalován ze `5154856d` (bundle
`6bfcf2df0960de08…`, start 06:56:51 UTC, DISARMED), post-restart reconcile
čistý.

Pozorování: po startu ještě jednou fail-closed „leader je autoritativně flat,
follower stav se neshoduje (ne všechny follower snapshoty jsou autoritativně
dostupné)“ s divergencí `[63338752]` — leader-flat guard při obnově durable
epochy vyžaduje snapshot i zmizelého followera. Fail-closed je zde správný
(neověřitelná kopie), ruční reconcile stav vyčistil; zmizí s odebráním účtu ze
skupiny a ukončením epochy. Paralelně Codex J: odebrání nedostupného followera
jedním krokem přímo z modalu „Skupinu nelze zapnout“.

### 2026-09-03 (Claude + uživatel, rollout workera 03d1fc5f)

Na výslovné „nasaď“: čtyři opuštěné `cancel-or-modify` z 2. 9. 18:44 (SL modify
zkřížený s fillem; follower stopy filled, guard 18:44:36 potvrdil flat, od té
doby flat podle fill pairs) ručně označeny jako vyřešené přes `resolve-stuck`
s approval stringem — bez broker příkazu. Read-only reconcile → čistý stav →
`mac-reinstall-safe.sh` z `main` `03d1fc5f` (bundle sha256 `94c29873a97262b5…`).
Klasifikátor tentokrát reinstall neblokoval. Jediný start 05:45:16 UTC, žádný
crash-loop, bundle obsahuje B (seenTerminalRejects), D (disarm record), E
(leader-only label) i I (`WS CONNECT attempt=1` diagnostika obou connections).
Post-restart read-only reconcile 0/0, `reconciliationRequired=false`,
`lastError=null`, DISARMED.

Pozorování k ověření uživatelem před ARM: durable skupina má **leader 64310872
(funded Tradeify)** a všech pět followerů 1× (62364059, 62364055, 62364060,
63338752, 63338592) — tak ji uživatel včera večer nastavil. Lucid OAuth
`conn:754e4b5b` nyní vrací jediný účet **64503883**; oba včerejší Lucid účty
(62364553 leader dopoledne, 63338752 breached) v OAuth nejsou. `63338752` je
v skupině dál a routing ho správně přeskakuje jako optional (ROUTING OPTIONAL
SKIP). Automatická post-connect recovery skončila v 05:45:24 „nepodařilo se
ověřit stav účtů“ (viz Otevřené otázky), ruční read-only reconcile z CLI prošel.

### 2026-09-03 (Claude, orchestrace šesti Codex agentů — sloučeno do main)

Paralelně v šesti worktree nad `origin/main`, každý výsledek recenzován
Claudem a znovu ověřen celou sadou + tsc před sloučením (pořadí a61667fb →
1b349ef3/f25d4d01 → eee8ab36 → c1bdccfb → 4b1a1ea9): (A) násobek při změně
leadera, (B) dedupe replaye rejectů, (C) forenzní review pěti fail-closed
(`docs/REVIEW_FAILCLOSED_20260903.md`), (D) panel odzbrojení s kódem důvodu,
výsledkem kopií a dalším krokem, (E) leader-only popisky denní statistiky +
klasifikace stop výstupu, (H+I) review a oprava reconnect automatu
(`docs/REVIEW_RECONNECT_20260903.md`). Web nasazen automaticky. Mac worker
stále běží ze `56f36ebf` (restart 05:02 UTC po nočním výpadku přes
`launchctl kickstart`, DISARMED); B, D, E a I v něm začnou platit až po
reinstallu na výslovné „nasaď“ — dnes je obchodní den. iOS widget/Live Activity
část E vyžaduje rebuild nativní appky. Otevřené: opravy race z review C
(P0 partial-fill-aware guard, P1 settling okna) zatím neimplementovány; čtyři
opuštěné modify operace z 2. 9. čekají na ruční „Označit za vyřešené“; hlavní
checkout v Documents zůstává 26 commitů za main a dirty (rozhodnutí uživatele).

### 2026-09-03 (Codex, konečný Tradovate WebSocket reconnect automat)

Tradovate broker má explicitní socket stavy a jediný idempotentní plánovač
reconnectu. Každý kandidátní socket je identity-guarded; 10s connect watchdog
a 5s close watchdog jej uvolní i bez `onclose`, synchronní chyba factory i
chyby authorize/streamu plánují další pokus nezávisle na callbacku. Retry běží
exponenciálně s jitterem od 1 s do 60 s, rate-limit/captcha zůstává minimální
delší prodleva a počítadlo se resetuje až po úplném authorization + sync.
Worker loguje connection, fázi, číslo/důvod pokusu, příští delay a při delším
výpadku nejméně minutový souhrn; opožděné handlery starého socketu nový socket
nemohou shodit a poslední unsubscribe ukončí retry i diagnostické timery.

Mac device token provider dál nemá vlastní retry smyčku: neúspěšný refresh
vrátí poslední payload jen nad oddělenou 5min bezpečnostní rezervou, jinak
propaguje fázovanou chybu. Controller po pěti neúspěšných post-connect
reconciliation pokusech zůstane DISARMED/fail-closed, ale znovu nastaví
`pendingConnectionRecovery`, takže další `connected:true` event spustí novou
vlnu. Order/fill cesty, `emitOrHoldError`, reconnect reconciliation i zákaz
automatického ARM zůstaly beze změny.

Deterministické regrese kryjí visící CONNECTING, chybějící `onclose`, factory
throw, tři chyby tokenu a čtvrtý úspěch, backoff strop/reset/rate minimum,
pětiminutové souhrny, stale-token rezervu, opožděný starý callback, unsubscribe
a druhou controller recovery vlnu. Finální sada prošla 222/222 souborů a
1831/1831 testů, strict TypeScript bez výstupu, produkční Vite/PWA build,
cílený ESLint a `git diff --check`. Nic nebylo commitnuto, pushnuto,
deploynuto ani spuštěno na workeru/brokeru; neproběhl ARM, DISARM ani Flatten.

### 2026-09-03 (Claude + uživatel, návrh auto-otevření companionu při změně stavu)

Companion po merge do `main` běží a ukazuje skutečný stav (ZÁSAH NUTNÝ:
reconciliation vyžaduje kontrolu, 4 příkazy stuck). Uživatel chce, aby se
popover při změně stavu (connect/disconnect, problém, LIVE start/konec) sám
ukázal s rozbalenou sekcí. Návrh je ve specu §11 (v1.4) a zadání pro Codex
v `docs/MENUBAR_COMPANION_AUTOOPEN_BRIEF_20260903.md`: spouštějí jen
přechody z freshness reduceru, STAV NEZNÁMÝ do 90 s nikdy; anti-flap 3 s,
max jedno otevření za 30 s; popover bez krádeže fokusu s auto-zavřením;
nativní notifikace pro fullscreen; čtyři přepínače v nastavení. Bez
ovládání copieru, bez nových endpointů. Nic neimplementováno.
### 2026-09-03 (Codex, násobek followera už nepřeskakuje mezi účty)

Změna leadera nyní vždy vrátí dostupného předchozího leadera jako followera
`1×`, `on-submit`, bez `maxContracts`; nastavení povýšeného followera zanikne
s jeho rolí. Ruční náhrada stale follower účtu zachová režim, ale násobek a
`maxContracts` záměrně resetuje na bezpečné výchozí hodnoty a UI to viditelně
oznámí. Potvrzovací variantu jsme nezvolili, protože účetní risk parametry
nemají jedním rutinním kliknutím přecházet na jinou identitu; uživatel je může
novému účtu znovu nastavit ručně.

Poslední krok editoru před uložením vždy vykreslí diff proti uložené skupině:
změnu leadera a všechny přidané, odebrané nebo parametricky změněné followery;
každá zobrazená hodnota násobku nad `1×` je zvýrazněná. Regrese pokrývají oba
typy povýšení, nedostupného starého leadera, reset náhrady a SSR náhled diffu.
Celá sada prošla 221 souborů / 1817 testů, strict TypeScript, cílený ESLint,
produkční build a `git diff --check`. Beze změny zůstal runtime/controller i
formát `CopyGroupConfig`; nic nebylo commitnuto, pushnuto, deploynuto ani
spuštěno na workeru/brokeru.
### 2026-09-03 (Codex, durable dedupe replayovaných rejectů)

Příčina nebyla v chybějícím porovnání `sourceVersion` uvnitř leader event
source: controller zpracovával každý `rejected` order přímo ještě před
`source.observe()`, takže při syncrequest replayi znovu měnil eligibility,
`lastExecution`, async outbox a přímý `leader-reject-*` audit, i když event
source stejnou signaturu následně zahodil. Přímá reject větev nyní ve stejném
CAS commitu jako eligibility/outbox ukládá bounded ledger posledních 2048
`accountId + brokerOrderId`; známý reject je v této větvi no-op i po restartu.
Starý snapshot bez ledgeru zůstává validní a jako migrační dedupe použije
alespoň brokerOrderId dosavadního `lastExecution`. Brokerový `updatedAt`
brání staršímu nebo stejně starému rejectu přepsat novější kartu; nový orderId
s novějším časem se zapíše normálně. První async DLL reject dál klasifikuje
účet, waivne vysvětlený acknowledged outbox a audituje stejně jako dřív.

Regrese pokrývá trojí doručení téhož async rejectu včetně restartu, jediný
audit a beze změny `lastExecution`/outboxu, nový i starší jiný orderId,
legacy snapshot a Supabase validaci tvaru, unikátnosti a limitu ledgeru.
Cíleně prošlo 4 soubory / 44 testů a controller sada 2 soubory / 108 testů.
Finální kompletní běh prošel 220/220 souborů a 1818/1818 testů; strict
TypeScript prošel bez výstupu. Jeden předchozí full run měl pouze známý
zátěžový 1s timeout mock CDP testu, který izolovaně prošel 11/11 a následný
celý běh byl zelený. Nic nebylo commitnuto, pushnuto, deploynuto ani
instalováno; worker/broker, ARM, DISARM ani Flatten se nespouštěly.
### 2026-09-03 (Codex, srozumitelné odzbrojení kopírky)

Controller status additivně nese `lastDisarm` a nejvýše 20 odzbrojení aktuální
session. Čistý klasifikátor převádí známé fail-closed cesty na stabilní kód,
český důvod a jediný další krok; původní technický text zůstává celý v detailu.
Výsledek kopií se zpřesní na `guard-flattened`/`auto-closed` až po potvrzeném
zavření, jinak zůstává konzervativně `unknown`; execution ani fail-closed
logika se nezměnily.

LIVE karta po DISARM ukáže amber/rose panel vedle dostupného ARM, technický
detail a historii dne; po novém ARM historii nemaže, jen panel skryje. Nativní
fail-closed notifikace zachovala stejnou hranu a počet, ale místo raw chyby
použije lidský titul a výsledek kopií. Cíleně prošlo 4 soubory / 139 testů,
celá sada 222 / 1843, strict TypeScript, scoped lint bez výstupu a produkční
build. Plný lint skončil bez chyb, se 353 existujícími warningy mimo změněné
soubory. Nic nebylo commitnuto, pushnuto ani deploynuto; žádný reálný worker,
broker, ARM, DISARM ani Flatten se nespouštěl.
### 2026-09-03 (Codex, jednoznačné denní P&L a pozdní atribuce SL/TP)

`dailyStats` zůstává beze změny leader-only ledgerem copieru a day-lock dál
počítá pouze tuto metriku. LIVE, notifikace, Mac companion DTO a iOS
widget/Live Activity ji nyní označují „Leader · jen obchody přes kopírku · bez
poplatků“; LIVE a widget vedle ní ukazují samostatný součet OAuth
`cashBalance.realizedPnL` jako „Účty (broker, vč. poplatků)“. Pozdní leader
protective order event může do 2 s čistě reportingově opravit již uložené
`manual` na `sl`/`tp`; execution, routing ani safety rozhodnutí nemění.

Regrese pokrývá stop fill před order eventem i popisky všech DTO/renderů.
Kompletní Vitest: 220 souborů / 1817 testů; strict TypeScript, web build,
macOS build a samostatný iOS Simulator build cíle `AlphaTradeWidgets` prošly.
Celý iOS shell vyžaduje předem vygenerované Capacitor `public/config` soubory,
které tento worktree nemá. Nic nebylo commitnuto, pushnuto ani deploynuto a
žádný worker/broker/ARM/DISARM/Flatten nebyl spuštěn.

### 2026-09-02 (Claude, večerní review dne — skutečná čísla a replay bug)

Read-only stažení `/fill/list` + `/fillPair/list` + `/cashBalance/list` přes
device tokeny workeru (skript mimo repo, žádný zápis) dalo skutečný den napříč
7 účty: realizováno **−4 590,80 USD**, z toho **−1 274,80 USD poplatky**
(1 376 zobchodovaných kontraktů, ≈0,95 USD/kontrakt). Denní statistika workeru
(leader-only, jen copier obchody) ukazovala 0,00 — je to metrika kopírky, ne
účtů, a takto se nesmí prezentovat. Rozpad: Lucid leader dopoledne +455;
Lucid follower −640 → BREACHED (ruční 10-kontraktové longy mimo copier 15:35,
druhý pár do breachu); Tradeify leader odpoledne −787, tři 1× followeři ≈ −786
až −795, 2× follower −1 252,50 = přesně DLL 1 250 → lock do konce session.
Followeři přišli o dopolední +412 (11× Long se vyplnil jen na leaderovi, copier
byl po incidentu DISARMED) a dostali všechny odpolední ztráty včetně 5 flipů
18:26–18:44 a eskalace velikosti po ztrátě (8 → 17 → 16). Pojistky
`dailyLossLimitUsd`, `dailyMaxLosingTrades`, `entryCooldownMinutes` jsou ve
skupině vypnuté (0). Zjištěn replay bug rejectů při socket renewal (viz Otevřené
otázky). Kód, účty ani broker se neměnily.

### 2026-09-02 (Codex, srozumitelný reject a autoritativní výsledek pozice)

Poslední broker reject na kartě účtu už není jen syrový alarm. Čistý překladač
rozlišuje price-through, DLL, interní Tag50/customTag a neznámý důvod; UI vždy
zachová celý původní broker text v tooltipu. `lastExecution` additivně nese
typ/side/cenu příkazu a volitelné durable `resolution`. Controller zapisuje
`guard-flattened` pouze po úspěšné finální kontrole cílené leader-flat
likvidace, `auto-closed` pouze po potvrzeném auto-close a konzervativní
`follower-flat` po autoritativní reconciliation nebo guard snapshotu, který
našel followera už flat. Selhání persistence tohoto reportingového doplňku
nemění safety výsledek ani pořadí execution operací.

LIVE řádek je rose jen tehdy, když resolution chybí/je unresolved a současný
živý účet není autoritativně flat. Potvrzené uzavření nebo aktuální flat stav
se vykreslí muted s výsledkem a sekundovým časem; stop reject ukáže také
například `SL Buy @ 29189.75`. Staré snapshoty bez nových polí zůstávají
platné a beze změny se načtou. Controller regrese pokrývají reconciliation i
skutečnou leader-flat guard likvidaci a durable zápis; render regrese rose,
muted i tooltip s originálem.

Ověření: cíleně 6 souborů / 141 testů, kompletní sada 220 souborů / 1814 testů,
strict TypeScript, scoped ESLint změněných souborů bez výstupu, `git diff
--check` a lokální produkční Vite/PWA build prošly. První sandboxovaný celý
běh měl pouze očekávané `listen EPERM 127.0.0.1` u 38 lokálních HTTP testů;
opakování stejného příkazu s povoleným loopbackem prošlo celé. Nic nebylo
commitnuto, pushnuto ani deploynuto; žádný reálný worker/broker, ARM, DISARM
ani Flatten se nespouštěl a sémantika `nativeCopierNotificationPlan.ts` se
neměnila.

### 2026-09-02 (Claude, první živý běh opravy 56f36ebf a incident „stop mimo cenový limit“)

Worker reinstalován uživatelem z `56f36ebf` (start 15:24 UTC, jediný start, bundle
obsahuje nový skip helper i markery z `main`). Uživatel změnil leadera na
`63338592` a v 15:35:52 UTC otevřel Short 1 MNQ. Oprava se poprvé potvrdila
živě: breached `63338752` byl v auditu `skipped account-ineligible`, skupina
zůstala ARMED a vstup se zkopíroval na 4 followery.

Nová chyba nebyla v copieru: leader zadal ochranný Buy Stop 29189.75 až ve
chvíli, kdy trh už byl na 29190 — leader byl fill/flat v 15:36:02.79, copier
stop událost zpracoval v 15:36:02.88 a follower Stop příkazy broker odmítl
(„current price is outside the price limits“, cena už byla za stopem). Followeři
tak drželi short bez ochrany při flat leaderovi; fail-closed „leader je
autoritativně flat, follower stav se neshoduje“ zafungoval a leader-flat guard
do 4 s cíleně zploštil všechny 4 kopie. Uživatel v 15:36:55 udělal Kontrolu
pozic (4 rejecty waived) a re-ARM. Druhý obchod (Short 10 Limit + nativní OCO,
tři posuny SL, výstup na SL, cancel targetů, guard potvrdil vše flat) proběhl
bez jediné anomálie. Stav při zápisu: ARMED, clean, revize 794.

Závěr: kód beze změny. Provozně platí, že SL zadaný „do trhu“ se nedá
zreplikovat (latence ≈100–250 ms) — bracket/OSO při vstupu je bezpečná cesta,
což druhý obchod potvrdil. Kosmetika k pozdějšímu řešení: exit leadera přes
vlastní stop, jehož order event dorazil po fillu, se v denním přehledu
klasifikoval jako `manual`.

### 2026-09-02 (Claude, nasazení opravy 56f36ebf)

Oprava „známý nezpůsobilý follower = skip, ne fail-closed“ byla přenesena
z lokálního checkoutu na čistý worktree nad `origin/main` a pushnuta jako
`56f36ebf` (fast-forward `main`); Vercel produkce READY. Důvod přenosu: hlavní
checkout `Documents/trading-journal-aka` je 26 commitů za `origin/main`
a jeho pracovní strom by commit vrátil dnešní dřívější opravy
(`missingOptionalAccountIds`, `beginShutdown`, OAuth preflight). Při přenosu
se to projevilo zastaralým hunkem v `copierAccountEligibility.test.ts`, který
byl vrácen na verzi z `main`. Celá sada 218 souborů / 1803 testů a typecheck
prošly. Reinstall Mac workera přes `scripts/copier/mac-reinstall-safe.sh`
z tohoto commitu provádí uživatel ručně (klasifikátor Claude Code reinstall
blokuje); brána byla v čase předání zelená (DISARMED, connected, flat, bez
divergence, bez lastError). Dva účty zůstávají `breached` (62364058,
63338752); po opravě smějí zůstat ve skupině a budou jen přeskakovány.
V hlavním checkoutu zůstává necommitnutá práce Codexu (App.tsx `userId`,
TradovateLiveDesk, macCopierDevice, nativeCopierNotificationPlan) — nezahozena,
čeká na rozhodnutí uživatele.

### 2026-09-02 (Codex, předem známý nezpůsobilý follower už neodzbrojí kopírku)

Runner nyní vykazuje `account-ineligible` jako `skipped` pouze tehdy, když byl
konkrétní follower už ve vstupním `context.ineligibleAccounts`. Risk gate ani
globální halt logika se nezměnily a každý jiný `blocked`, stejně jako reject,
unknown a rozbitá sekvence, zůstává kritický a fail-closed. Standardní,
deferred, OCO i OSO controller větev používají jeden společný kritický filtr;
duplicitní inline OCO/OSO filtry byly odstraněny. `leader-replace-unmapped`
all-or-none dál vynechává pouze známé nezpůsobilé účty a jinak zůstává tvrdý
`blocked`.

Regrese pokrývají pokračující ARMED stav, prázdný `lastError`, nulový auto-close
a žádný nový order pro DLL/BREACHED followera; OCO i OSO navíc prokazují, že
následný reject zdravého followera skupinu stále odzbrojí. Zadaná sada prošla
7/7 souborů a 217/217 testů; `npx tsc --noEmit -p .` prošel s 4GB Node heapem
(výchozí přibližně 2GB běh skončil pouze OOM). Nic nebylo commitnuto, pushnuto,
deploynuto ani spuštěno/reinstalováno; neproběhl broker příkaz, ARM ani Flatten.

### 2026-09-02 (Claude, review incidentu „breached follower odzbrojil kopírku“)

Ověření Codexovy diagnózy incidentu z 15:37/15:40 v kódu. Spouštěč souhlasí:
Lucid účet byl `BREACHED`, risk gate ho správně vrátil jako `account-ineligible`
a pět zdravých followerů dostalo OSO. Kořenová příčina je ale obecnější než
„OSO cesta“: `isCriticalAuditEntry` v `copierRuntimeController.ts` považuje
KAŽDÝ audit `kind: 'blocked'` za kritický a všechny čtyři cesty (standardní,
deferred replay, bracket i OSO) mu předávají celý audit bez filtru. Předem
známé vyřazení followera (`account-ineligible`) tak vyvolá `failClosed` stejně
jako skutečné selhání. Reprodukováno na standardní cestě: stávající test
„async DLL reject: 4 aktivní / 1 dll-locked … skupina jede dál“ po druhém
leader vstupu ověřuje jen počty objednávek, ne `armed`; po dočasném doplnění
aserce `status().armed === true` test padá (`armed: false`). Test má tedy díru
a chování je shodné pro limit/market i OSO.

Druhý důsledek: `failClosed` za živého ARM (bez transportLost/kill switche)
volá `scheduleAutoClose('fail-closed')`, takže pouhé přeskočení breached účtu
může zdravým followerům risk-redukčně zavřít právě otevřené kopie. To je horší
než samotný DISARM a je to důvod, proč se incident opakuje při každém ARM se
známým breached členem.

Doporučená oprava (neimplementováno, jen review): blokace s důvodem
`account-ineligible` pro follower účet, který je v `ineligibleAccounts` už při
plánování, se má vykazovat jako `skipped` (nebo být z kritického filtru
vyjmutá) ve všech čtyřech cestách; jakékoli jiné `blocked` (quantity-limit,
symbol-not-allowed, divergence, halt) zůstává fail-closed. Doplnit regresi
`armed` po skipu pro standardní i OSO cestu a scénář „ARM se známým breached
followerem → dva leader vstupy → skupina zůstává ARMED, breached účet bez
objednávky“. Kód, účty ani broker se při tomto review neměnily.

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
v mainu, jinak ho další deploy smaže". Po uživatelově „nasaď" byl `main`
fast-forwardován na `d054fd30`; auto-deploy `dpl_DEtm6KKEQw44bFS7JZxwRYm92suq`
obnovil companion API (status 401 bez credentialu, pairing/start 405 na GET,
devices 401 — routy existují). Žádný broker write, ARM/DISARM ani zásah do
copier workeru.

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


## 2026-09-05 — Opravy kompletního review backtestingu

- Opraveny nálezy 1–17 a obě UI připomínky: kauzální market/limit/stop a SL/TP exekuce, partial/scale-in/reversal identita, MFE/MAE dolní meze, Monte Carlo ruin; souvislý Go To/denní krok a historie po reopen; durable journal outbox, izolace uživatele, CAS konflikty a viditelný retry.
- Přenos z izolovaného snapshotu s porovnáním původních bajtů; rozpracované změny copieru zachovány. Žádný push, deploy, DB migrace ani broker akce.
- Ověření: kompletní 221 souborů / 1 834 testů passed; finální cílené 26 souborů / 330 testů passed; typecheck 4 GB a standardní produkční build passed; browser market/partial/final/pending-limit, denní krok+výpadek/retry, reopen bez duplicit. Podrobnosti: docs/reviews/backtest-20260905/FIXES.md.
- Po přenosu do hlavního adresáře: 330/330 cílených testů passed, typecheck exit 0, diff --check exit 0, localhost:3001 spuštěn a Dashboard načten.


### 2026-09-11 (Codex, localhost: potvrzení Tradovate účtů)
Pouze TradovateAccountProfileSetup: kompaktní rozbalovací účty, hromadná identita jen pro vybrané řádky, původ hodnot, chybějící risk z dostupného broker snapshotu, zachování uložených hodnot a viditelné rozdíly. Katalog doplňuje pouze prázdná pole a při shodné fázi Evaluation; velikost z názvu vyžaduje potvrzení. Browser ověřil 7 účtů, Lucid risk 1200/2000/EOD, změnu jediného označeného účtu a discard. Testy katalogu 7/7, lint a diff check passed; celoprojektový typecheck po více než 5 minutách bez výsledku zastaven. Žádné profily neuloženy, žádný deploy ani broker/worker změna. Localhost dev:live stále používá read-only proxy; uložení profilů nebylo ověřeno.
