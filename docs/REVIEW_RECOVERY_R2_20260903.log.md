Reading additional input from stdin...
OpenAI Codex v0.149.0
--------
workdir: /private/tmp/alphatrade-reconnect-fix
model: gpt-5.6-sol
provider: openai
approval: on-request
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: 01a06617-e210-7750-a12b-f21477026b73
--------
user
# Read-only cross-review (2. kolo) — Claudeův commit 30a48144

Repo = aktuální adresář (main). Diff: /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/68dfa1b9-b400-40c9-b983-6a4b7dd71727/scratchpad/claude-recovery-fix-2.diff. Tvé první kolo
(verdikt „opravit“) je v /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/68dfa1b9-b400-40c9-b983-6a4b7dd71727/scratchpad/codex-review-recovery.log od řádku „## Verdikt“.
Změny podle něj: (1) public reconcile() už příznak neshazuje, jen při čistém
výsledku znovu naplánuje recovery vlnu (`scheduleConnectionRecovery`), která si
vezme optional-skip a příznak shodí sama po kompletním doběhu; (2) chyba
resolveru i poslední chyba pěti pokusů se auditují a propíší do fail-closed
zprávy; (3) brána „otevřená durable pozice leadera“ v reconfigureLeaderEpoch
používá session-aware `currentDailyStats(now)` (lot z už skončené session 17:00
CT neblokuje; autoritativní flat/no-working preflight následuje).

Otázky: Řeší (1) tvůj nález 1 a 2 (částečný snapshot, generation fence)?
Zbývá riziko u (3): může lot z minulé session skrývat skutečnou přenesenou
expozici, kterou by preflight nezachytil? Nálezy 3 (stale resolver) a race
(updateGroup mimo eventTail) zůstávají otevřené — potvrď, že jsou správně
odložené do PROJECT_LOG, nebo řekni, co z nich je nutné teď. Verdikt
schválit/opravit + konkrétní řádky. Žádné změny v repu.
codex
Udělám čistě read-only druhé kolo: nejdřív ověřím stav checkoutu a přečtu `PROJECT_LOG`, potom přesně porovnám commit/diff s původními nálezy a projdu recovery i leader-preflight cestu v okolním kódu. Nic neupravím ani nespustím proti brokeru či produkci.
  → Ověřit checkout, Git stav, PROJECT_LOG a relevantní paměť
  • Porovnat commit 30a48144, diff a původní verdikt
  • Trasovat recovery/generation a session-aware leader gate v okolním kódu
  • Ověřit odložení stale resolveru a updateGroup race v PROJECT_LOG
  • Vydat read-only verdikt s konkrétními řádky
exec
/bin/zsh -lc "pwd && git status --short --branch && sed -n '1,240p' docs/PROJECT_LOG.md && rg -n \"recovery|reconcile|resolver|updateGroup|leader epoch|generation fence|partial snapshot|30a48144\" /Users/filipkrejca/.codex/memories/MEMORY.md" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 1916ms:
git: error: couldn't create cache file '/tmp/xcrun_db-6t7g885r' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-PvtGlaZu' (errno=Operation not permitted)
## codex/reconnect-fix-20260903...origin/codex/reconnect-fix-20260903 [ahead 13]
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

- [ ] **Automatická post-connect recovery selže, když follower chybí v OAuth**
      (3. 9. 05:45:24 UTC, worker 03d1fc5f): po startu s breached `63338752`, který
      už není v žádném OAuth adresáři, skončila recovery vlna „nepodařilo se
      ověřit stav účtů“ bez auditního důvodu, zatímco ruční `reconcile` z CLI
      (routing předá optional skip) prošel. Podezření: `runConnectionRecovery`
      volá reconciliation bez `missingOptionalAccountIds`, takže nezpůsobilý
      chybějící follower je „missing required“. Fix: recovery má použít stejný
      optional-skip vstup jako CLI/UI cesta a při selhání zapsat audit s důvodem.
      Delegovat Codexu s regresí.
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
186:- com.alphatrade.copier, copier-agent.mjs, launchctl, service-lifetime persistent, armed=false, groupFlat=true, npm run copier:mac -- reconcile, SHA-256, reconciliationRequired
210:- Related skill: skills/alpha-trade-copier-pilot/SKILL.md. Before and after restart require `armed=false`, `groupFlat=true`, no working orders/divergence/stuck outbox/last error; rebuild only from the exact validated commit, compare installed bundle SHA-256, then run `npm run copier:mac -- reconcile`. [Task 3]
211:- The verified 2026-09-02 worker replaced OAuth-vanished follower `62364057` with funded follower `64310872`, was DISARMED, connected, flat, reconciled, and error-free. A fresh esbuild build from `7763bfcd` matched the installed bundle SHA-256; five focused files passed 151 tests. Snapshot `ready` with `lastSuccessAt=null` proves CDP readiness, not a successful ENTRY/EXIT capture. [Task 4]
217:- Symptom: `tsx` status/reconcile gives `EPERM` creating a temporary IPC pipe. Fix: treat it as an environment restriction, not a worker defect; do not overwrite a dirty/occupied canonical worktree—use an exact-commit clean release worktree. [Task 3]
218:- Symptom: pre-restart status is clean. Fix: startup can briefly set `reconciliationRequired`; always reconcile again after restart before reporting a safe state. [Task 3]
328:# Task Group: AlphaTrade Tradovate copier safety hardening and reconciliation recovery
336:- rollout_summaries/2026-08-27T18-30-20-CdRj-copier_review_fixes_reconciliation_drift_recovery.md (cwd=/Users/filipkrejca/Downloads/alphatrade-mentor-15, rollout_path=/Users/filipkrejca/.codex/sessions/2026/08/27/rollout-2026-08-27T20-30-20-01a0447c-be0d-7821-ae70-3ba48d760aed.jsonl, updated_at=2026-08-27T18:56:30+00:00, thread_id=01a0447c-be0d-7821-ae70-3ba48d760aed, implemented and locally verified in the canonical checkout; no production rollout)
350:- `safetyGeneration` plus serialized `reconciliationTail` prevents an older clean reconciliation from confirming `positionCheckComplete` or clearing a newer incident, reconnect, or kill switch. Automatic reconciliation must not clear `lastError`; only explicit user `reconcile({ clearLastError: true })` of the same generation may do so. [Task 1]
351:- Terminal-fill recovery requires proven-successful auto-flatten and an all-abandoned/filled-modify critical batch. A mixed critical batch returns false. Persistent same-sign follower drift is checked from fresh leader/follower broker snapshots against `Math.trunc(leaderNet * follower.multiplier)`, then sets divergence and disarms without automatic correction. [Task 1]

codex
Checkout je správný dočasný review worktree, pracovní strom podle `git status --short` nemá lokální změny; větev je však `codex/reconnect-fix-20260903`, ne doslova `main`, a je 13 commitů před svým upstreamem. Teď dohledávám přesný vztah `30a48144` k HEAD a relevantní deníkové zápisy, aby verdikt nestál jen na popisu změn.
exec
/bin/zsh -lc "wc -l docs/PROJECT_LOG.md && sed -n '241,520p' docs/PROJECT_LOG.md && sed -n '521,900p' docs/PROJECT_LOG.md && rg -n -C 5 \"30a48144|recovery vlna|stale resolver|updateGroup|eventTail|currentDailyStats|generation|částeč|partial|resolver\" docs/PROJECT_LOG.md && sed -n '328,356p' /Users/filipkrejca/.codex/memories/MEMORY.md && git rev-parse --verify HEAD && git show -s --format='%H%n%P%n%an%n%ad%n%s' 30a48144 && git merge-base --is-ancestor 30a48144 HEAD; printf 'ancestor_exit=%s\\n' \""'$?" && git diff --stat 30a48144''^ 30a48144 && git status --porcelain=v1' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 3179ms:
git: error: couldn't create cache file '/tmp/xcrun_db-kVLkqhRJ' (errno=Operation not permitted)
30a4814444b198733fd666e9eebf9b27e0d8c13b
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-g189oBv3' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-JCis7gPh' (errno=Operation not permitted)
30a4814444b198733fd666e9eebf9b27e0d8c13b
73bd4a6c686d3a13378408ae16cba91782fe2597
Krejcus
Thu Sep 3 09:06:11 2026 +0200
fix(copier): clean manual reconcile re-runs the recovery wave; group-change gate uses session-aware daily stats
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-vgzPNpzQ' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-irNUcSkf' (errno=Operation not permitted)
ancestor_exit=0
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-kJZ3Ukwt' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-ZSkJTNvc' (errno=Operation not permitted)
 services/copierRuntimeController.ts                | 48 +++++++++++----
 ...opierConnectionRecoveryOptionalFollower.test.ts | 50 +++++++++++-----
 tests/copierReconfigureStaleOpenLots.test.ts       | 69 ++++++++++++++++++++++
 3 files changed, 140 insertions(+), 27 deletions(-)
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-0tnL7hn6' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-oizcgCoB' (errno=Operation not permitted)

exec
/bin/zsh -lc 'rg -n "''^## Verdikt" /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/68dfa1b9-b400-40c9-b983-6a4b7dd71727/scratchpad/codex-review-recovery.log && sed -n '"'/"'^## Verdikt/,$p'"' /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/68dfa1b9-b400-40c9-b983-6a4b7dd71727/scratchpad/codex-review-recovery.log && sed -n '1,260p' /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/68dfa1b9-b400-40c9-b983-6a4b7dd71727/scratchpad/claude-recovery-fix-2.diff && git show --format=fuller --find-renames --find-copies 30a48144 -- services/copierRuntimeController.ts tests/copierConnectionRecoveryOptionalFollower.test.ts tests/copierReconfigureStaleOpenLots.test.ts" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 529ms:
git: error: couldn't create cache file '/tmp/xcrun_db-Ws5uclGv' (errno=Operation not permitted)
commit 30a4814444b198733fd666e9eebf9b27e0d8c13b
Author:     Krejcus <filipkrejca1@gmail.com>
AuthorDate: Thu Sep 3 09:06:11 2026 +0200
Commit:     Krejcus <filipkrejca1@gmail.com>
CommitDate: Thu Sep 3 09:06:11 2026 +0200

    fix(copier): clean manual reconcile re-runs the recovery wave; group-change gate uses session-aware daily stats
    
    Navazuje na 5154856d po Codex cross-review:
    
    - public reconcile(): čistý výsledek už `pendingConnectionRecovery` neshazuje
      (částečný snapshot s optional skipem by obešel obnovu leader-flat guardu,
      úklid exposure markeru i recovery audit). Místo toho znovu naplánuje recovery
      vlnu; ta si vezme optional-skip vstup a příznak shodí až po kompletním doběhu.
      Při selhání zůstává pending.
    - connection recovery: chyba optional-skip resolveru i poslední chyba pěti
      pokusů se auditují (`connection-recovery` blocked) a propíší do fail-closed
      zprávy — dosud se ztrácely.
    - reconfigureLeaderEpoch: brána „otevřená durable pozice leadera“ používá
      session-aware `currentDailyStats(now)` jako zbytek controlleru. Lot z už
      skončené session (17:00 CT) blokoval dnes změnu skupiny, přestože broker byl
      flat; autoritativní flat/no-working preflight následuje beze změny.
    
    Testy: copierConnectionRecoveryOptionalFollower (3 scénáře vč. resolveru, který
    napoprvé selže), copierReconfigureStaleOpenLots (2 scénáře).
    
    Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>

diff --git a/services/copierRuntimeController.ts b/services/copierRuntimeController.ts
index d29c4da7..450854ff 100644
--- a/services/copierRuntimeController.ts
+++ b/services/copierRuntimeController.ts
@@ -2693,13 +2693,21 @@ export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): P
     // právě není v žádném OAuth adresáři, se nesmí routovat (router by hodil
     // chybu), ale jeho absence je pro breached/DLL účet legitimní.
     let missingOptionalAccountIds: readonly number[] = [];
+    let lastRecoveryError: string | null = null;
     if (options.resolveMissingOptionalAccountIds) {
       try {
         const followerIds = new Set(group.followers.map(follower => follower.accountId));
         missingOptionalAccountIds = [...new Set(await options.resolveMissingOptionalAccountIds(group))]
           .filter(accountId => followerIds.has(accountId) && accountId !== group.leaderAccountId);
-      } catch {
+      } catch (reason) {
+        // Bez optional-skip vstupu pokračujeme s plným routingem; důvod se
+        // nesmí ztratit — jinak je pět tichých pokusů nečitelných (3. 9.).
         missingOptionalAccountIds = [];
+        lastRecoveryError = `optional-skip resolver: ${errorOf(reason).message}`;
+        options.onAudit?.([{
+          at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
+          reason: `connection-recovery: ${lastRecoveryError}`,
+        }]);
       }
     }
     let reconciliation: { divergentAccounts: number[]; workingOrderAccounts: number[] } | null = null;
@@ -2714,16 +2722,23 @@ export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): P
           missingOptionalAccountIds: [...missingOptionalAccountIds],
         });
         break;
-      } catch {
+      } catch (reason) {
         // Spojení je čerstvé — pár pokusů, pak poctivé přiznání níže.
+        lastRecoveryError = errorOf(reason).message;
       }
     }
     if (!reconciliation) {
       // Pět rychlých pokusů je jen jedna recovery vlna. Příští potvrzený
-      // connected event ji musí smět spustit znovu; stav zůstává DISARMED.
+      // connected event (nebo čistá ruční Kontrola pozic) ji musí smět spustit
+      // znovu; stav zůstává DISARMED.
       pendingConnectionRecovery = true;
+      options.onAudit?.([{
+        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
+        reason: `connection-recovery: reconciliation selhala 5× — ${lastRecoveryError ?? 'bez důvodu'}`,
+      }]);
       failClosed(new Error(
-        'connection=aggregate phase=reconciliation Po obnovení spojení se nepodařilo ověřit stav účtů — kopie zůstávají chráněné brackety, zkontroluj Tradovate',
+        'connection=aggregate phase=reconciliation Po obnovení spojení se nepodařilo ověřit stav účtů — kopie zůstávají chráněné brackety, zkontroluj Tradovate'
+        + (lastRecoveryError ? ` (${lastRecoveryError})` : ''),
       ));
       return;
     }
@@ -3987,8 +4002,11 @@ export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): P
       if (pendingReasons.length > 0) {
         throw new Error(`${operation} blokuje rozpracovaný lifecycle: ${pendingReasons.join(', ')}`);
       }
-      const openLots = currentRuntime().state.safety.dailyStats?.openLots
-        .filter(lot => lot.netQuantity !== 0) ?? [];
+      // Stejná session-aware statistika jako všude jinde: lot z už skončené
+      // session (po 17:00 CT) je jen historie, ne důkaz otevřené expozice.
+      // Autoritativní flat/no-working preflight následuje níže tak jako tak.
+      const openLots = currentDailyStats(clock()).openLots
+        .filter(lot => lot.netQuantity !== 0);
       if (openLots.length > 0) {
         throw new Error(`${operation} blokuje otevřená durable pozice leadera`);
       }
@@ -4320,12 +4338,18 @@ export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): P
       // Pouze její čistý výsledek smí odstranit starou chybu; automatické
       // reconnect/terminal-fill kontroly incident uživateli neschovávají.
       const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
-      if (result.divergentAccounts.length === 0 && result.workingOrderAccounts.length === 0) {
-        // Autoritativně čistý stav je přesně to, co čekající recovery vlna
-        // hledala; jinak by příznak po neúspěšné automatické vlně blokoval
-        // změnu skupiny („rozpracovaný lifecycle: connection recovery“) až do
-        // dalšího connection eventu. Při divergenci zůstává pending.
-        pendingConnectionRecovery = false;
+      if (
+        result.divergentAccounts.length === 0
+        && result.workingOrderAccounts.length === 0
+        && pendingConnectionRecovery
+        && !recoveryInFlight
+        && gate.connected
+      ) {
+        // Čistý ruční výsledek recovery NEnahrazuje (přeskočil by obnovu
+        // leader-flat guardu, úklid exposure markeru i recovery audit) — jen
+        // ji znovu spustí. Vlna si sama vezme optional-skip vstup a příznak
+        // shodí až po kompletním doběhu; při selhání zůstává pending.
+        scheduleConnectionRecovery();
       }
       return result;
     },
diff --git a/tests/copierConnectionRecoveryOptionalFollower.test.ts b/tests/copierConnectionRecoveryOptionalFollower.test.ts
index a9276a9e..83defa14 100644
--- a/tests/copierConnectionRecoveryOptionalFollower.test.ts
+++ b/tests/copierConnectionRecoveryOptionalFollower.test.ts
@@ -47,18 +47,22 @@ const harness = async (options: {
   // Zmizelý follower nemá route — přesně jako účet, který už není v žádném OAuth.
   const router = createBrokerRouter([{ broker: mock, accountIds: [100, 200, 201] }]);
   const errors: string[] = [];
+  const audit: { kind: string; leaderEventId?: string; reason?: string }[] = [];
   const controller = await bootstrapCopierRuntime({
     broker: router,
     store: createMemoryCopierStore(initial),
     group,
     wait: async () => undefined,
     onError: error => errors.push(error.message),
+    onAudit: entries => audit.push(...entries.map(entry => ({
+      kind: entry.kind, leaderEventId: entry.leaderEventId, reason: entry.reason,
+    }))),
     ...options,
   });
   mock.setConnected(true);
   // Connection event doráží přes router asynchronně; recovery se řadí až po něm.
   await settle(controller);
-  return { controller, errors, mock };
+  return { controller, errors, audit, mock };
 };
 
 const settle = async (controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>) => {
@@ -69,24 +73,24 @@ const settle = async (controller: Awaited<ReturnType<typeof bootstrapCopierRunti
 };
 
 describe('post-connect recovery a follower chybějící v OAuth', () => {
-  it('bez optional-skip vstupu recovery selže, ale čistá ruční Kontrola pozic odblokuje změnu skupiny', async () => {
+  it('bez optional-skip zdroje recovery selže s auditovaným důvodem a zůstává pending i po čisté ruční Kontrole pozic', async () => {
     const h = await harness();
     expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
+    expect(h.audit.some(entry => entry.kind === 'blocked'
+      && entry.leaderEventId === 'connection-recovery'
+      && entry.reason?.includes('303'))).toBe(true);
     expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
-
-    // Stav po včerejšku: příznak recovery blokuje reconfigure i po jejím selhání.
     await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
       .rejects.toThrow('connection recovery');
 
-    // Ruční Kontrola pozic se stejným optional skipem jako CLI/UI projde…
+    // Ruční Kontrola pozic s optional skipem projde…
     await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
       .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
-    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
-
-    // …a čistý výsledek recovery příznak shodí: odebrání zmizelého followera už projde.
+    await settle(h.controller);
+    // …ale recovery jen znovu spustí; bez optional-skip zdroje vlna opět selže,
+    // takže částečný ruční snapshot recovery nikdy sám „nedokončí“.
     await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
-      .resolves.toBeUndefined();
-    expect(h.controller.status().armed).toBe(false);
+      .rejects.toThrow('connection recovery');
     h.controller.stop();
   });
 
@@ -95,7 +99,7 @@ describe('post-connect recovery a follower chybějící v OAuth', () => {
     const h = await harness({
       resolveMissingOptionalAccountIds: async current => {
         seen.push(current);
-        return [MISSING, 999_999];
+        return [MISSING, 999_999, current.leaderAccountId];
       },
     });
     expect(seen.length).toBeGreaterThan(0);
@@ -108,13 +112,29 @@ describe('post-connect recovery a follower chybějící v OAuth', () => {
     h.controller.stop();
   });
 
-  it('neúspěšná ruční Kontrola pozic (chybějící follower bez optional skipu) příznak neshazuje', async () => {
-    const h = await harness();
+  it('když zdroj napoprvé selže, čistá ruční Kontrola pozic spustí novou vlnu, která doběhne celá a odblokuje skupinu', async () => {
+    let calls = 0;
+    const h = await harness({
+      resolveMissingOptionalAccountIds: async () => {
+        calls += 1;
+        if (calls === 1) throw new Error('OAuth adresář dočasně nedostupný');
+        return [MISSING];
+      },
+    });
     expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
-    // Bez optional skipu router pro 303 selže → reconcile hodí chybu → pending zůstává.
-    await expect(h.controller.reconcile()).rejects.toThrow();
+    expect(h.audit.some(entry => entry.reason?.includes('optional-skip resolver'))).toBe(true);
     await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
       .rejects.toThrow('connection recovery');
+
+    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
+      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
+    await settle(h.controller);
+    expect(calls).toBeGreaterThanOrEqual(2);
+    expect(h.audit.some(entry => entry.kind === 'recovered'
+      && entry.leaderEventId === 'connection-recovery')).toBe(true);
+    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
+    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
+      .resolves.toBeUndefined();
     h.controller.stop();
   });
 });
diff --git a/tests/copierReconfigureStaleOpenLots.test.ts b/tests/copierReconfigureStaleOpenLots.test.ts
new file mode 100644
index 00000000..37fe9e6c
--- /dev/null
+++ b/tests/copierReconfigureStaleOpenLots.test.ts
@@ -0,0 +1,69 @@
+import { describe, expect, it } from 'vitest';
+import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
+import { createMockBroker } from '../services/mockBroker';
+import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
+import type { CopyGroupConfig } from '../services/liveCopyTrading';
+
+/**
+ * 3. 9. 2026 09:00: „Změnu leadera blokuje otevřená durable pozice leadera“,
+ * přestože broker hlásil všechny účty flat. V denní statistice visel zbytkový
+ * lot z předchozí session (18:44 předchozího dne) a brána změny skupiny četla
+ * uložené `openLots` bez ohledu na hranici session (17:00 CT).
+ */
+
+const group: CopyGroupConfig = {
+  id: 'g-lots', name: 'Lots', enabled: true, leaderAccountId: 100,
+  followers: [
+    { accountId: 200, mode: 'on-submit', multiplier: 1 },
+    { accountId: 201, mode: 'on-submit', multiplier: 1 },
+  ],
+};
+const nextGroup: CopyGroupConfig = {
+  ...group,
+  followers: group.followers.filter(follower => follower.accountId !== 201),
+};
+
+const harness = async (sessionEndAt: number, now: number) => {
+  const initial = emptySnapshot();
+  initial.safety = {
+    entryCooldownUntil: 0,
+    dayLockUntil: 0,
+    dailyStats: {
+      sessionEndAt,
+      realizedPnlUsd: 0,
+      losingTrades: 0,
+      openLots: [{
+        episodeId: 'stale', symbol: 'MNQU6', netQuantity: -3, avgPrice: 29_141.5,
+        tradePnlUsd: 0, tradePnlPoints: 0, openedAt: now - 60_000, side: 'Short',
+      }],
+      recentClosedTrades: [],
+      unpricedSymbols: [],
+    },
+  };
+  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
+  const controller = await bootstrapCopierRuntime({
+    broker, store: createMemoryCopierStore(initial), group, clock: () => now,
+    wait: async () => undefined,
+  });
+  broker.setConnected(true);
+  await controller.waitForIdle();
+  await controller.reconcile();
+  return controller;
+};
+
+describe('brána změny skupiny a durable openLots', () => {
+  it('lot z už skončené session změnu skupiny neblokuje', async () => {
+    const now = Date.UTC(2026, 8, 3, 7, 0, 0);
+    const controller = await harness(now - 3_600_000, now);
+    await expect(controller.reconfigureGroup(nextGroup)).resolves.toBeUndefined();
+    controller.stop();
+  });
+
+  it('lot z běžící session změnu skupiny dál blokuje', async () => {
+    const now = Date.UTC(2026, 8, 3, 7, 0, 0);
+    const controller = await harness(now + 3_600_000, now);
+    await expect(controller.reconfigureGroup(nextGroup))
+      .rejects.toThrow('otevřená durable pozice leadera');
+    controller.stop();
+  });
+});

exec
/bin/zsh -lc "rg -n \"pendingConnectionRecovery|recoveryInFlight|scheduleConnectionRecovery|runConnectionRecovery|performReconciliation|currentDailyStats|reconfigureLeaderEpoch|updateGroup\\(|syncLiveCopyExposureFlag|resumeLeaderFlatEpochsAfterSnapshot|leaderExposureEpochs|liveCopyOpenSince|missingOptionalAccountIds\" services/copierRuntimeController.ts && nl -ba services/copierRuntimeController.ts | sed -n '2600,2805p' && nl -ba services/copierRuntimeController.ts | sed -n '3760,3925p' && nl -ba services/copierRuntimeController.ts | sed -n '3940,4085p' && nl -ba services/copierRuntimeController.ts | sed -n '4290,4465p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
203:  missingOptionalAccountIds?: readonly number[];
212:  missingOptionalAccountIds?: readonly number[];
305:  updateGroup(group: CopyGroupConfig): void;
903:  let pendingConnectionRecovery = false;
904:  let recoveryInFlight = false;
1413:    currentRuntime().state.safety.leaderExposureEpochs?.find(epoch => (
1421:    const others = (safety.leaderExposureEpochs ?? []).filter(item => !(
1428:      leaderExposureEpochs: [...others, epoch].slice(-20),
1586:  const syncLiveCopyExposureFlag = async (reason: 'update' | 'clear') => {
1591:      const stored = current.state.safety.liveCopyOpenSince;
1595:        const { liveCopyOpenSince: _cleared, ...rest } = current.state.safety;
1600:        safety = { ...current.state.safety, liveCopyOpenSince: clock() };
1649:  const currentDailyStats = (at: number): CopierDailyStats => {
1672:    const stats = currentDailyStats(at);
1849:      pendingConnectionRecovery = true;
1883:              const reconciliation = await performReconciliation();
2142:        openedAt: currentRuntime().state.safety.liveCopyOpenSince ?? observedAt,
2294:    const storedEpoch = currentRuntime().state.safety.leaderExposureEpochs
2373:      await syncLiveCopyExposureFlag('clear');
2494:    if (fullyResolved) await syncLiveCopyExposureFlag('clear');
2556:        await syncLiveCopyExposureFlag('clear');
2582:  const resumeLeaderFlatEpochsAfterSnapshot = async (): Promise<Set<string>> => {
2585:    const matching = currentRuntime().state.safety.leaderExposureEpochs?.filter(epoch => (
2681:  const runConnectionRecovery = async () => {
2682:    if (!pendingConnectionRecovery || stopped) return;
2683:    pendingConnectionRecovery = false;
2688:      pendingConnectionRecovery = true;
2695:    let missingOptionalAccountIds: readonly number[] = [];
2700:        missingOptionalAccountIds = [...new Set(await options.resolveMissingOptionalAccountIds(group))]
2705:        missingOptionalAccountIds = [];
2717:        pendingConnectionRecovery = true;
2721:        reconciliation = await performReconciliation({
2722:          missingOptionalAccountIds: [...missingOptionalAccountIds],
2734:      pendingConnectionRecovery = true;
2745:    const guardedSymbols = await resumeLeaderFlatEpochsAfterSnapshot();
2748:      await syncLiveCopyExposureFlag('clear');
2798:  const scheduleConnectionRecovery = () => {
2799:    if (recoveryInFlight || stopped) return;
2800:    recoveryInFlight = true;
2804:          await runConnectionRecovery();
2806:          recoveryInFlight = false;
2810:        recoveryInFlight = false;
2940:        pendingConnectionRecovery = true;
2966:        if (event.resynced) pendingConnectionRecovery = true;
2972:          const hasRecoverableLeaderFlatEpoch = currentRuntime().state.safety.leaderExposureEpochs
2984:            currentRuntime().state.safety.liveCopyOpenSince != null
2986:          ) pendingConnectionRecovery = true;
2988:        if (pendingConnectionRecovery) scheduleConnectionRecovery();
3310:      await syncLiveCopyExposureFlag('update');
3684:  async function performReconciliation(
3717:      const missingOptionalAccountIds = new Set(reconciliationOptions.missingOptionalAccountIds ?? []);
3718:      for (const accountId of missingOptionalAccountIds) {
3724:      for (const accountId of missingOptionalAccountIds) {
3748:      const routedAccountIds = accountIds.filter(accountId => !missingOptionalAccountIds.has(accountId));
3754:      const missing = [...new Set([...missingOptionalAccountIds, ...missingRequired])];
3953:  const reconfigureLeaderEpoch = async (
3998:        recoveryInFlight || pendingConnectionRecovery ? 'connection recovery' : '',
4008:      const openLots = currentDailyStats(clock()).openLots
4028:      const optionalFollowerIds = new Set(switchOptions.missingOptionalAccountIds ?? []);
4070:          liveCopyOpenSince: _dropOpenFlag,
4071:          leaderExposureEpochs: _dropLeaderExposureEpochs,
4115:      pendingConnectionRecovery = false;
4116:      recoveryInFlight = false;
4130:      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
4217:      shutdownPromise = syncLiveCopyExposureFlag('clear');
4238:      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
4256:      pendingConnectionRecovery = false;
4258:      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
4340:      const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
4344:        && pendingConnectionRecovery
4345:        && !recoveryInFlight
4352:        scheduleConnectionRecovery();
4415:      await reconfigureLeaderEpoch(nextGroup, reconfigurationOptions);
4422:      await reconfigureLeaderEpoch(nextGroup, {
4428:    updateGroup(nextGroup) {
  2600	            previousNet: epoch.lastLeaderNet,
  2601	            nextNet: 0,
  2602	            observedAt,
  2603	            graceMs: leaderFlatGraceMs,
  2604	            nextEpochId: globalThis.crypto.randomUUID(),
  2605	            groupId: group.id,
  2606	            leaderAccountId,
  2607	            symbol: epoch.symbol,
  2608	            // Ownership pochází výhradně z opening epochy; reconnect ji
  2609	            // nesmí rozšířit odhadem z právě nalezené pozice.
  2610	            followersAtOpen: epoch.followers,
  2611	          });
  2612	          if (plan.kind === 'scheduled') {
  2613	            await persistLeaderExposureEpoch(plan.epoch);
  2614	            scheduleLeaderFlatEpochVerification(plan.epoch, plan.token);
  2615	            guardedSymbols.add(epoch.symbol);
  2616	          } else {
  2617	            await persistLeaderExposureEpoch(invalidateLeaderFlatEpoch(
  2618	              epoch,
  2619	              `connection-recovery nedokázala obnovit leader-flat guard (${plan.kind})`,
  2620	              observedAt,
  2621	            ));
  2622	          }
  2623	          continue;
  2624	        }
  2625	
  2626	        if (Math.sign(leaderNet) !== Math.sign(epoch.lastLeaderNet)) {
  2627	          // Směrový flip proběhl během mezery streamu. Novou expozici jsme
  2628	          // neviděli vzniknout, proto založíme pouze detect-only ownership.
  2629	          await persistLeaderExposureEpoch(createLeaderFlatEpoch({
  2630	            id: globalThis.crypto.randomUUID(),
  2631	            groupId: group.id,
  2632	            leaderAccountId,
  2633	            symbol: epoch.symbol,
  2634	            openedAt: clock(),
  2635	            leaderNet,
  2636	            generation: epoch.generation + 1,
  2637	            followers: epoch.followers.map(follower => ({
  2638	              ...follower,
  2639	              eligibleAtOpen: false,
  2640	              copyLineage: 'unproven',
  2641	              confirmedNetQuantity: undefined,
  2642	            })),
  2643	          }));
  2644	        } else if (leaderNet !== epoch.lastLeaderNet) {
  2645	          // Same-sign změna zachová jen dříve prokázaný quantity ceiling.
  2646	          await persistLeaderExposureEpoch({ ...epoch, lastLeaderNet: leaderNet });
  2647	        }
  2648	        continue;
  2649	      }
  2650	
  2651	      if (
  2652	        epoch.phase === 'grace'
  2653	        || epoch.phase === 'waiting-inflight'
  2654	        || epoch.phase === 'closing'
  2655	      ) {
  2656	        if (leaderNet === 0) {
  2657	          scheduleLeaderFlatEpochVerification(epoch, {
  2658	            epochId: epoch.id,
  2659	            generation: epoch.generation,
  2660	          });
  2661	          guardedSymbols.add(epoch.symbol);
  2662	        } else {
  2663	          await persistLeaderExposureEpoch(invalidateLeaderFlatEpoch(
  2664	            epoch,
  2665	            `leader během connection-recovery už není flat (${leaderNet})`,
  2666	            clock(),
  2667	          ));
  2668	        }
  2669	      }
  2670	    }
  2671	    return guardedSymbols;
  2672	  };
  2673	
  2674	  /**
  2675	   * Connection recovery „podle stavu": po obnovení spojení (nebo po bootu
  2676	   * s durable stopou živých kopií) se autoritativně ověří účty.
  2677	   * Synchronní kopie s otevřeným leaderem se DRŽÍ (brackety je chrání)
  2678	   * a čeká se na jediný klik ARM; osiřelé nebo rozjeté kopie se
  2679	   * risk-redukčně zavřou. Nikdy se sám neARMuje.
  2680	   */
  2681	  const runConnectionRecovery = async () => {
  2682	    if (!pendingConnectionRecovery || stopped) return;
  2683	    pendingConnectionRecovery = false;
  2684	    // `armExpiryFlatten: off` vypíná jen automatickou broker akci, nikoli
  2685	    // povinnou read-only kontrolu po reconnectu/resyncu.
  2686	    if (gate.killSwitch || group.leaderAccountId == null) return;
  2687	    if (!gate.connected) {
  2688	      pendingConnectionRecovery = true;
  2689	      return;
  2690	    }
  2691	    const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  2692	    // Stejný optional-skip vstup jako ruční Kontrola pozic: follower, který
  2693	    // právě není v žádném OAuth adresáři, se nesmí routovat (router by hodil
  2694	    // chybu), ale jeho absence je pro breached/DLL účet legitimní.
  2695	    let missingOptionalAccountIds: readonly number[] = [];
  2696	    let lastRecoveryError: string | null = null;
  2697	    if (options.resolveMissingOptionalAccountIds) {
  2698	      try {
  2699	        const followerIds = new Set(group.followers.map(follower => follower.accountId));
  2700	        missingOptionalAccountIds = [...new Set(await options.resolveMissingOptionalAccountIds(group))]
  2701	          .filter(accountId => followerIds.has(accountId) && accountId !== group.leaderAccountId);
  2702	      } catch (reason) {
  2703	        // Bez optional-skip vstupu pokračujeme s plným routingem; důvod se
  2704	        // nesmí ztratit — jinak je pět tichých pokusů nečitelných (3. 9.).
  2705	        missingOptionalAccountIds = [];
  2706	        lastRecoveryError = `optional-skip resolver: ${errorOf(reason).message}`;
  2707	        options.onAudit?.([{
  2708	          at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2709	          reason: `connection-recovery: ${lastRecoveryError}`,
  2710	        }]);
  2711	      }
  2712	    }
  2713	    let reconciliation: { divergentAccounts: number[]; workingOrderAccounts: number[] } | null = null;
  2714	    for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
  2715	      if (attempt > 0) await wait(2_000);
  2716	      if (!gate.connected) {
  2717	        pendingConnectionRecovery = true;
  2718	        return;
  2719	      }
  2720	      try {
  2721	        reconciliation = await performReconciliation({
  2722	          missingOptionalAccountIds: [...missingOptionalAccountIds],
  2723	        });
  2724	        break;
  2725	      } catch (reason) {
  2726	        // Spojení je čerstvé — pár pokusů, pak poctivé přiznání níže.
  2727	        lastRecoveryError = errorOf(reason).message;
  2728	      }
  2729	    }
  2730	    if (!reconciliation) {
  2731	      // Pět rychlých pokusů je jen jedna recovery vlna. Příští potvrzený
  2732	      // connected event (nebo čistá ruční Kontrola pozic) ji musí smět spustit
  2733	      // znovu; stav zůstává DISARMED.
  2734	      pendingConnectionRecovery = true;
  2735	      options.onAudit?.([{
  2736	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2737	        reason: `connection-recovery: reconciliation selhala 5× — ${lastRecoveryError ?? 'bez důvodu'}`,
  2738	      }]);
  2739	      failClosed(new Error(
  2740	        'connection=aggregate phase=reconciliation Po obnovení spojení se nepodařilo ověřit stav účtů — kopie zůstávají chráněné brackety, zkontroluj Tradovate'
  2741	        + (lastRecoveryError ? ` (${lastRecoveryError})` : ''),
  2742	      ));
  2743	      return;
  2744	    }
  2745	    const guardedSymbols = await resumeLeaderFlatEpochsAfterSnapshot();
  2746	    if (!hasFollowerExposure()) {
  2747	      if (lastDisarm?.trigger === 'transport') updateDisarmOutcome(lastDisarm.at, 'flat');
  2748	      await syncLiveCopyExposureFlag('clear');
  2749	      options.onAudit?.([{
  2750	        at: clock(), leaderEventId: 'connection-recovery', kind: 'recovered',
  2751	        reason: 'connection-recovery: autoritativní reconciliation potvrdila flat/no-active stav; runtime zůstává DISARMED',
  2752	      }]);
  2753	      return;
  2754	    }
  2755	    const orphanSymbols = new Set<string>();
  2756	    for (const follower of group.followers) {
  2757	      for (const [symbol, quantity] of positionsByAccount.get(follower.accountId) ?? []) {
  2758	        if (quantity !== 0 && (leaderPositions.get(symbol) ?? 0) === 0) orphanSymbols.add(symbol);
  2759	      }
  2760	    }
  2761	    const unguardedOrphanSymbols = [...orphanSymbols].filter(symbol => !guardedSymbols.has(symbol));
  2762	    if (unguardedOrphanSymbols.length > 0) {
  2763	      failClosed(new Error(
  2764	        `Copier fail-closed: po reconnectu je leader flat a follower má neověřenou expozici (${unguardedOrphanSymbols.join(', ')}); bez opening ownership se automaticky nezavírá`,
  2765	      ), { autoClose: false });
  2766	      options.onAudit?.([{
  2767	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2768	        reason: `connection-recovery: detect-only orphan expozice bez durable opening epochy (${unguardedOrphanSymbols.join(', ')}); žádný broker write`,
  2769	      }]);
  2770	      return;
  2771	    }
  2772	    if (orphanSymbols.size > 0) {
  2773	      options.onAudit?.([{
  2774	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2775	        reason: `connection-recovery: leader-flat guard obnoven pro ${[...orphanSymbols].join(', ')}; runtime zůstává DISARMED`,
  2776	      }]);
  2777	      return;
  2778	    }
  2779	    const leaderOpen = [...(positionsByAccount.get(group.leaderAccountId)?.values() ?? [])]
  2780	      .some(quantity => quantity !== 0);
  2781	    if (leaderOpen && reconciliation.divergentAccounts.length === 0) {
  2782	      if (lastDisarm?.trigger === 'transport') {
  2783	        updateDisarmOutcome(lastDisarm.at, 'left-open-protected');
  2784	      }
  2785	      lastResumeOffer = null;
  2786	      options.onAudit?.([{
  2787	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2788	        reason: 'connection-recovery: kopie jsou synchronní s leaderem — drženy DISARMED, ARM je blokovaný do flat',
  2789	      }]);
  2790	      return;
  2791	    }
  2792	    const flat = await autoFlattenCopies('reconnect', clock());
  2793	    if (lastDisarm?.trigger === 'transport') {
  2794	      updateDisarmOutcome(lastDisarm.at, flat ? 'auto-closed' : 'unknown');
  2795	    }
  2796	  };
  2797	
  2798	  const scheduleConnectionRecovery = () => {
  2799	    if (recoveryInFlight || stopped) return;
  2800	    recoveryInFlight = true;
  2801	    eventTail = eventTail
  2802	      .then(async () => {
  2803	        try {
  2804	          await runConnectionRecovery();
  2805	        } finally {
  3760	      ).map(follower => follower.accountId);
  3761	      lastOauthPreflight = {
  3762	        missingAccounts: [...missing],
  3763	        inactiveAccounts: [...inactive],
  3764	        readOnlyFollowerAccounts: [...readOnlyFollowers],
  3765	      };
  3766	      if (missingRequired.length > 0 || inactive.length > 0 || readOnlyFollowers.length > 0) {
  3767	        gate = { ...gate, armed: false };
  3768	        invalidateReconciliation();
  3769	        const details = [
  3770	          missingRequired.length > 0 ? `missing=${missingRequired.join(',')}` : '',
  3771	          inactive.length > 0 ? `inactive=${inactive.join(',')}` : '',
  3772	          readOnlyFollowers.length > 0 ? `readOnlyFollowers=${readOnlyFollowers.join(',')}` : '',
  3773	        ].filter(Boolean).join(' ');
  3774	        throw new Error(`OAuth/account preflight selhal: ${details}`);
  3775	      }
  3776	      const snapshotAccountIds = accountIds.filter(accountId => {
  3777	        const capability = byCapability.get(accountId);
  3778	        if (!capability?.active || !capability.canTrade) return false;
  3779	        const state = eligibilityByAccount.get(accountId)?.state ?? 'active';
  3780	        // BREACHED a stále platný DLL jsou známé exclusions. Expirující DLL
  3781	        // už eligibilityAt převedlo na `unverifiable`, takže se načte a po
  3782	        // úspěšném snapshotu může bezpečně vrátit do active.
  3783	        return state !== 'breached' && state !== 'dll-locked';
  3784	      });
  3785	      const snapshots = await Promise.all(snapshotAccountIds.map(async accountId => {
  3786	        const [positions, orders] = await Promise.all([
  3787	          broker.listPositions(accountId),
  3788	          broker.listOrders(accountId),
  3789	        ]);
  3790	        return { accountId, positions, orders };
  3791	      }));
  3792	      const byAccount = new Map(snapshots.map(item => [item.accountId, item]));
  3793	      positionsByAccount.clear();
  3794	      for (const snapshot of snapshots) {
  3795	        positionsByAccount.set(snapshot.accountId, new Map(
  3796	          snapshot.positions.map(item => [item.symbol, item.netQuantity]),
  3797	        ));
  3798	      }
  3799	      leaderPositions.clear();
  3800	      // Atribuce SL/TP exitů přežije restart: ochranné nohy leadera se
  3801	      // obnoví z autoritativních working orderů (mají parent/OCO vazbu).
  3802	      for (const order of byAccount.get(group.leaderAccountId)?.orders ?? []) {
  3803	        if (order.status !== 'working') continue;
  3804	        if (order.parentOrderId == null && order.ocoId == null && order.linkedOrderId == null) continue;
  3805	        if (order.orderType === 'Stop' || order.orderType === 'StopLimit') {
  3806	          leaderStopOrderIds.add(order.brokerOrderId);
  3807	        } else if (order.orderType === 'Limit') {
  3808	          leaderTargetOrderIds.add(order.brokerOrderId);
  3809	        }
  3810	      }
  3811	      const reconciledLeaderPositions = new Map(
  3812	        (byAccount.get(group.leaderAccountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
  3813	      );
  3814	      for (const [symbol, quantity] of reconciledLeaderPositions) leaderPositions.set(symbol, quantity);
  3815	      const divergent = new Set<number>();
  3816	      workingOrderAccounts = new Set(
  3817	        snapshots.filter(item => item.orders.some(order => isOpenOrderStatus(order.status))).map(item => item.accountId),
  3818	      );
  3819	      // Reaktivace eligibility: JEDINÉ místo, kde se DLL/unverifiable vrací
  3820	      // do 'active' — autoritativní snapshot účtu se povedl. Čas sám nikdy
  3821	      // nestačí (rollEligibilityToNewSession umí jen zpřísnit na
  3822	      // 'unverifiable'). Breach zůstává trvale, dokud ho operátor neřeší.
  3823	      {
  3824	        const reactivationNow = clock();
  3825	        let eligibilityChanged = rollEligibilityToNewSession(reactivationNow);
  3826	        for (const [accountId, entry] of accountEligibility) {
  3827	          if (!byAccount.has(accountId)) continue;
  3828	          const newSessionBegan = entry.lockSessionEndAt != null
  3829	            && entry.lockSessionEndAt > 0
  3830	            && reactivationNow >= entry.lockSessionEndAt;
  3831	          if (entry.state === 'unverifiable' || (entry.state === 'dll-locked' && newSessionBegan)) {
  3832	            accountEligibility.set(accountId, {
  3833	              ...entry, state: 'active', at: reactivationNow,
  3834	              reason: 'autoritativně ověřeno při reconciliaci po nové session',
  3835	            });
  3836	            eligibilityChanged = true;
  3837	            options.onAudit?.([{
  3838	              at: reactivationNow, leaderEventId: `eligibility-reactivate-${accountId}`,
  3839	              kind: 'recovered', accountId,
  3840	              reason: 'účet znovu způsobilý — autoritativní ověření po nové session',
  3841	            }]);
  3842	          }
  3843	        }
  3844	        if (eligibilityChanged) await persistEligibility();
  3845	      }
  3846	      const ineligibleAfterReactivation = currentIneligibleAccounts();
  3847	      for (const follower of group.followers) {
  3848	        // Účet s autoritativní eligibility exclusion není participantem
  3849	        // copieru. Jeho chybějící snapshot proto není divergence zdravých
  3850	        // participantů; po reaktivaci se automaticky vrátí do této kontroly.
  3851	        if (ineligibleAfterReactivation.has(follower.accountId)) continue;
  3852	        const followerPositions = new Map(
  3853	          (byAccount.get(follower.accountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
  3854	        );
  3855	        const symbols = new Set([...reconciledLeaderPositions.keys(), ...followerPositions.keys()]);
  3856	        for (const symbol of symbols) {
  3857	          const expected = Math.trunc((reconciledLeaderPositions.get(symbol) ?? 0) * follower.multiplier);
  3858	          if ((followerPositions.get(symbol) ?? 0) !== expected) {
  3859	            divergent.add(follower.accountId);
  3860	            break;
  3861	          }
  3862	        }
  3863	      }
  3864	      // Durable dokončení sweep povinnosti: pád workeru mezi follower flat
  3865	      // a potvrzeným cancelem nesmí povinnost ztratit (review, bod 5).
  3866	      // Reconciliation je autoritativní moment, kdy se osiřelé working
  3867	      // ochranné nohy nad flat followerem dají najít a doprovodit.
  3868	      for (const follower of group.followers) {
  3869	        const snapshot = byAccount.get(follower.accountId);
  3870	        if (!snapshot) continue;
  3871	        const workingIds = new Set(
  3872	          snapshot.orders.filter(order => isOpenOrderStatus(order.status)).map(order => order.brokerOrderId),
  3873	        );
  3874	        if (workingIds.size === 0) continue;
  3875	        const flatSymbols = new Set<string>();
  3876	        const runtime = currentRuntime();
  3877	        for (const entry of [...runtime.bracketOutbox.values(), ...runtime.osoOutbox.values()]) {
  3878	          if (entry.request.accountId !== follower.accountId) continue;
  3879	          const net = snapshot.positions.find(item => item.symbol === entry.request.symbol)?.netQuantity ?? 0;
  3880	          if (net !== 0) continue;
  3881	          const hasWorkingLeg = [entry.firstBrokerOrderId, entry.secondBrokerOrderId]
  3882	            .some(id => id && workingIds.has(id));
  3883	          if (hasWorkingLeg) flatSymbols.add(entry.request.symbol);
  3884	        }
  3885	        for (const symbol of flatSymbols) {
  3886	          await sweepFollowerProtectiveLegs(follower.accountId, symbol, clock(), {
  3887	            authoritativeWorkingOrderIds: workingIds,
  3888	          });
  3889	        }
  3890	      }
  3891	      gate = { ...gate, divergentAccounts: divergent, sequenceBroken: false, armed: false };
  3892	      const sameSafetyGeneration = safetyGeneration === generationAtStart;
  3893	      positionCheckComplete = sameSafetyGeneration
  3894	        && divergent.size === 0
  3895	        && workingOrderAccounts.size === 0;
  3896	      if (positionCheckComplete) {
  3897	        await acknowledgeTerminalRejectsAfterReconciliation();
  3898	        // Acknowledge může samo čekat na durable commit. Kill switch nebo
  3899	        // nový broker incident během tohoto awaitu musí mít stále přednost.
  3900	        if (safetyGeneration !== generationAtStart) {
  3901	          positionCheckComplete = false;
  3902	        } else {
  3903	          source.acknowledgeReconciliation();
  3904	          if (
  3905	            reconciliationOptions.clearLastError
  3906	            && requestedGeneration === generationAtStart
  3907	            && !gate.killSwitch
  3908	          ) lastError = null;
  3909	        }
  3910	      }
  3911	      await resolveRejectedExecutions({
  3912	        accountIds: group.followers
  3913	          .filter(follower => {
  3914	            const snapshot = byAccount.get(follower.accountId);
  3915	            return snapshot != null
  3916	              && snapshot.positions.every(position => position.netQuantity === 0);
  3917	          })
  3918	          .map(follower => follower.accountId),
  3919	        kind: 'follower-flat',
  3920	        at: clock(),
  3921	        detail: 'autoritativní reconciliation potvrdila followera flat',
  3922	      });
  3923	      return {
  3924	        divergentAccounts: [...divergent],
  3925	        workingOrderAccounts: [...workingOrderAccounts],
  3940	        }),
  3941	      ]);
  3942	    } finally {
  3943	      clearTimeout(timer);
  3944	    }
  3945	  };
  3946	
  3947	  /**
  3948	   * Přepnutí leadera je změna celé order-lifecycle epochy, ne obyčejný
  3949	   * edit jednoho ID. Operace se řadí do stejné fronty jako broker eventy:
  3950	   * event, který dorazil před klikem, doběhne pod starým leaderem; event po
  3951	   * potvrzené změně už pod novým. Chyba se vrátí UI a frontu nezabije.
  3952	   */
  3953	  const reconfigureLeaderEpoch = async (
  3954	    nextGroup: CopyGroupConfig,
  3955	    switchOptions: CopierGroupReconfigurationOptions & {
  3956	      allowGroupChange?: boolean;
  3957	      forceEpoch?: boolean;
  3958	    } = {},
  3959	  ): Promise<void> => {
  3960	    const operation = switchOptions.forceEpoch ? 'Aktivaci skupiny' : 'Změnu leadera';
  3961	    const run = eventTail.then(async () => {
  3962	      if (stopped) throw new Error('Copier runtime is stopped');
  3963	      if (nextGroup.id !== group.id && !switchOptions.allowGroupChange) {
  3964	        throw new Error('Nelze změnit runtime na jinou copy group bez explicitní aktivace');
  3965	      }
  3966	      assertRuntimeGroup(nextGroup);
  3967	      const currentTopology = new Set([
  3968	        group.leaderAccountId,
  3969	        ...group.followers.map(item => item.accountId),
  3970	      ]);
  3971	      const nextTopology = new Set([
  3972	        nextGroup.leaderAccountId,
  3973	        ...nextGroup.followers.map(item => item.accountId),
  3974	      ]);
  3975	      const topologyChanged = currentTopology.size !== nextTopology.size
  3976	        || [...currentTopology].some(accountId => !nextTopology.has(accountId));
  3977	      if (nextGroup.leaderAccountId === group.leaderAccountId && !topologyChanged && !switchOptions.forceEpoch) {
  3978	        group = nextGroup;
  3979	        invalidateReconciliation();
  3980	        return;
  3981	      }
  3982	      if (!gate.connected) {
  3983	        throw new Error(`${operation} nelze potvrdit bez živého broker syncu workeru`);
  3984	      }
  3985	      if (currentStuckOperations().length > 0 || hasBrokerUncertainOutbox()) {
  3986	        throw new Error(`${operation} blokuje nevyřešený durable outbox`);
  3987	      }
  3988	      const pendingReasons = [
  3989	        pendingBracketTimers.size > 0 ? 'bracket correlation' : '',
  3990	        pendingOsoTimers.size > 0 || pendingOsoEvents.size > 0 || pendingOsoFlushes.size > 0
  3991	          ? 'OSO correlation'
  3992	          : '',
  3993	        pendingFollowerTransitions.size > 0 ? 'follower transition' : '',
  3994	        pendingFollowerMagnitudeChecks.size > 0 ? 'follower magnitude check' : '',
  3995	        sweepingProtectiveLegs.size > 0 ? 'protective sweep' : '',
  3996	        leaderFlatGuardTimers.size > 0 ? 'leader-flat guard' : '',
  3997	        autoCloseInFlight ? 'auto-close' : '',
  3998	        recoveryInFlight || pendingConnectionRecovery ? 'connection recovery' : '',
  3999	        cooldownPending ? 'cooldown transition' : '',
  4000	        dayLockPendingReason ? 'day-lock transition' : '',
  4001	      ].filter(Boolean);
  4002	      if (pendingReasons.length > 0) {
  4003	        throw new Error(`${operation} blokuje rozpracovaný lifecycle: ${pendingReasons.join(', ')}`);
  4004	      }
  4005	      // Stejná session-aware statistika jako všude jinde: lot z už skončené
  4006	      // session (po 17:00 CT) je jen historie, ne důkaz otevřené expozice.
  4007	      // Autoritativní flat/no-working preflight následuje níže tak jako tak.
  4008	      const openLots = currentDailyStats(clock()).openLots
  4009	        .filter(lot => lot.netQuantity !== 0);
  4010	      if (openLots.length > 0) {
  4011	        throw new Error(`${operation} blokuje otevřená durable pozice leadera`);
  4012	      }
  4013	
  4014	      const accountIds = [...new Set([
  4015	        group.leaderAccountId,
  4016	        ...group.followers.map(item => item.accountId),
  4017	        nextGroup.leaderAccountId,
  4018	        ...nextGroup.followers.map(item => item.accountId),
  4019	      ])];
  4020	      const leaderIds = new Set([group.leaderAccountId, nextGroup.leaderAccountId]);
  4021	      const nextAccountIds = new Set([
  4022	        nextGroup.leaderAccountId,
  4023	        ...nextGroup.followers.map(item => item.accountId),
  4024	      ]);
  4025	      const removableFollowerIds = new Set(group.followers
  4026	        .map(item => item.accountId)
  4027	        .filter(accountId => !nextAccountIds.has(accountId) && !leaderIds.has(accountId)));
  4028	      const optionalFollowerIds = new Set(switchOptions.missingOptionalAccountIds ?? []);
  4029	      for (const accountId of optionalFollowerIds) {
  4030	        if (!Number.isSafeInteger(accountId) || !removableFollowerIds.has(accountId)) {
  4031	          throw new Error(`${operation} dostala neplatný chybějící optional follower účet ${accountId}`);
  4032	        }
  4033	      }
  4034	      const requiredAccountIds = accountIds.filter(accountId => !optionalFollowerIds.has(accountId));
  4035	      const capabilities = await withLeaderEpochDeadline(
  4036	        'leader capability preflight',
  4037	        broker.listAccountCapabilities(requiredAccountIds),
  4038	      );
  4039	      const capabilityByAccount = new Map(capabilities.map(item => [item.accountId, item]));
  4040	      const unavailable = requiredAccountIds.filter(accountId => {
  4041	        const capability = capabilityByAccount.get(accountId);
  4042	        return !capability || !capability.active || !capability.canTrade;
  4043	      });
  4044	      if (unavailable.length > 0) {
  4045	        throw new Error(`${operation} blokují neaktivní/read-only účty: ${unavailable.join(',')}`);
  4046	      }
  4047	      const snapshots = await Promise.all(requiredAccountIds.map(async accountId => {
  4048	        const [positions, orders] = await Promise.all([
  4049	          withLeaderEpochDeadline(`leader position preflight ${accountId}`, broker.listPositions(accountId)),
  4050	          withLeaderEpochDeadline(`leader order preflight ${accountId}`, broker.listOrders(accountId)),
  4051	        ]);
  4052	        return { accountId, positions, orders };
  4053	      }));
  4054	      const nonFlat = snapshots.filter(snapshot =>
  4055	        snapshot.positions.some(position => position.netQuantity !== 0));
  4056	      const withWorkingOrders = snapshots.filter(snapshot =>
  4057	        snapshot.orders.some(order => isOpenOrderStatus(order.status)));
  4058	      if (nonFlat.length > 0 || withWorkingOrders.length > 0) {
  4059	        const details = [
  4060	          nonFlat.length > 0 ? `nonFlat=${nonFlat.map(item => item.accountId).join(',')}` : '',
  4061	          withWorkingOrders.length > 0
  4062	            ? `working=${withWorkingOrders.map(item => item.accountId).join(',')}`
  4063	            : '',
  4064	        ].filter(Boolean).join(' ');
  4065	        throw new Error(`${operation} vyžaduje všechny staré i nové účty flat a bez příkazů: ${details}`);
  4066	      }
  4067	
  4068	      runtime = await processor.mutate(async current => {
  4069	        const {
  4070	          liveCopyOpenSince: _dropOpenFlag,
  4071	          leaderExposureEpochs: _dropLeaderExposureEpochs,
  4072	          ...preservedSafety
  4073	        } = current.state.safety;
  4074	        const cleanState = createCopierState([], 0, [], [], [], preservedSafety);
  4075	        const committed = await options.store.commit(
  4076	          toSnapshot(cleanState, [], [], current.revision, [], []),
  4077	          current.revision,
  4078	        );
  4079	        return createRuntime(cleanState, [], [], committed.revision, [], []);
  4080	      });
  4081	
  4082	      // Od tohoto bodu je durable stará epocha pryč a teprve teď se stává
  4083	      // nový leader autoritativní pro event source i risk vrstvu.
  4084	      group = nextGroup;
  4085	      options.broker.setCriticalAccounts?.([nextGroup.leaderAccountId]);
  4290	        }
  4291	        if (exclusion.state !== 'dll-locked' && exclusion.state !== 'breached') {
  4292	          throw new Error('Eligibility exclusion smí účet pouze zamknout jako DLL nebo BREACHED');
  4293	        }
  4294	        const reason = exclusion.reason.trim();
  4295	        if (reason.length < 3 || reason.length > 500) {
  4296	          throw new Error('Eligibility exclusion vyžaduje konkrétní důvod');
  4297	        }
  4298	        const current = accountEligibility.get(exclusion.accountId);
  4299	        // Stav z LIVE smí runtime jen zpřísnit. `unverifiable` je
  4300	        // fail-closed a nesmí se změnit na slabší DLL lock; BREACHED je
  4301	        // nejsilnější trvalá západka.
  4302	        const currentSeverity = current?.state === 'breached'
  4303	          ? 3
  4304	          : current?.state === 'unverifiable'
  4305	            ? 2
  4306	            : current?.state === 'dll-locked'
  4307	              ? 1
  4308	              : 0;
  4309	        const nextSeverity = exclusion.state === 'breached' ? 3 : 1;
  4310	        if (nextSeverity < currentSeverity) continue;
  4311	        const existingDllSessionEnd = current?.state === 'dll-locked'
  4312	          && current.lockSessionEndAt != null
  4313	          && current.lockSessionEndAt > now
  4314	          ? current.lockSessionEndAt
  4315	          : null;
  4316	        const next: CopierAccountEligibility = {
  4317	          ...(current ?? {}),
  4318	          accountId: exclusion.accountId,
  4319	          state: exclusion.state,
  4320	          reason,
  4321	          at: now,
  4322	          lockSessionEndAt: exclusion.state === 'dll-locked'
  4323	            ? existingDllSessionEnd ?? now + msUntilTradovateSessionEnd(now)
  4324	            : undefined,
  4325	        };
  4326	        if (
  4327	          current?.state === next.state
  4328	          && current.reason === next.reason
  4329	          && current.lockSessionEndAt === next.lockSessionEndAt
  4330	        ) continue;
  4331	        setEligibility(exclusion.accountId, next);
  4332	        changed = true;
  4333	      }
  4334	      if (changed) await persistEligibility();
  4335	    },
  4336	    async reconcile(reconciliationOptions = {}) {
  4337	      // Veřejná Kontrola pozic je explicitní uživatelská recovery akce.
  4338	      // Pouze její čistý výsledek smí odstranit starou chybu; automatické
  4339	      // reconnect/terminal-fill kontroly incident uživateli neschovávají.
  4340	      const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
  4341	      if (
  4342	        result.divergentAccounts.length === 0
  4343	        && result.workingOrderAccounts.length === 0
  4344	        && pendingConnectionRecovery
  4345	        && !recoveryInFlight
  4346	        && gate.connected
  4347	      ) {
  4348	        // Čistý ruční výsledek recovery NEnahrazuje (přeskočil by obnovu
  4349	        // leader-flat guardu, úklid exposure markeru i recovery audit) — jen
  4350	        // ji znovu spustí. Vlna si sama vezme optional-skip vstup a příznak
  4351	        // shodí až po kompletním doběhu; při selhání zůstává pending.
  4352	        scheduleConnectionRecovery();
  4353	      }
  4354	      return result;
  4355	    },
  4356	    async verifyAccountEligibility(accountId) {
  4357	      if (!Number.isSafeInteger(accountId) || accountId <= 0) {
  4358	        throw new Error('Neplatné ID účtu pro ověření');
  4359	      }
  4360	      if (!gate.connected) {
  4361	        const reason = lastError?.message?.trim();
  4362	        throw new Error([
  4363	          'Stav účtu nelze ověřit: worker nemá živé spojení s Tradovate.',
  4364	          reason ? `Poslední chyba: ${reason}.` : '',
  4365	          'OAuth přihlášení tím není dotčené — spojení se obnoví samo, zkus to za chvíli znovu.',
  4366	        ].filter(Boolean).join(' '));
  4367	      }
  4368	
  4369	      const now = clock();
  4370	      const current = accountEligibility.get(accountId);
  4371	      const effective = current ? eligibilityAt(current, now) : undefined;
  4372	      if (effective?.state === 'breached') {
  4373	        throw new Error(`Účet je BREACHED a nelze ho automaticky reaktivovat: ${effective.reason ?? 'bez důvodu'}`);
  4374	      }
  4375	      if (effective?.state === 'dll-locked') {
  4376	        throw new Error(`DLL stále platí do konce broker session: ${effective.reason ?? 'bez důvodu'}`);
  4377	      }
  4378	
  4379	      const capabilities = await broker.listAccountCapabilities([accountId]);
  4380	      const capability = capabilities.find(item => item.accountId === accountId);
  4381	      if (!capability) throw new Error(`Broker účet ${accountId} v OAuth spojení nevrátil`);
  4382	      if (!capability.active) throw new Error(`Broker účet ${accountId} stále hlásí jako neaktivní`);
  4383	      if (!capability.canTrade) throw new Error(`Broker účet ${accountId} zatím nepovoluje obchodování`);
  4384	
  4385	      // Oba read-only dotazy jsou součástí důkazu: samotný account/list může
  4386	      // účet vrátit, i když jeho obchodní snapshot zatím není dostupný.
  4387	      await Promise.all([
  4388	        broker.listPositions(accountId),
  4389	        broker.listOrders(accountId),
  4390	      ]);
  4391	
  4392	      const verified: CopierAccountEligibility = {
  4393	        ...(current ?? {}),
  4394	        accountId,
  4395	        state: 'active',
  4396	        reason: 'autoritativně ověřeno u brokera po nové session',
  4397	        at: now,
  4398	        lockSessionEndAt: undefined,
  4399	      };
  4400	      accountEligibility.set(accountId, verified);
  4401	      await persistEligibility();
  4402	      options.onAudit?.([{
  4403	        at: now,
  4404	        leaderEventId: `eligibility-verify-${accountId}`,
  4405	        kind: 'recovered',
  4406	        accountId,
  4407	        reason: 'účet znovu způsobilý — cílené read-only ověření u brokera',
  4408	      }]);
  4409	      return verified;
  4410	    },
  4411	    async reconfigureGroup(nextGroup, reconfigurationOptions = {}) {
  4412	      // UI dostane okamžitě fail-safe DISARM ještě před čekáním na eventTail.
  4413	      gate = { ...gate, armed: false };
  4414	      invalidateReconciliation();
  4415	      await reconfigureLeaderEpoch(nextGroup, reconfigurationOptions);
  4416	    },
  4417	    async activateGroup(nextGroup, reconfigurationOptions = {}) {
  4418	      // Aktivace není ARM. Nejprve fail-safe DISARM, potom plný preflight
  4419	      // staré i nové topologie a nová durable epocha.
  4420	      gate = { ...gate, armed: false };
  4421	      invalidateReconciliation();
  4422	      await reconfigureLeaderEpoch(nextGroup, {
  4423	        ...reconfigurationOptions,
  4424	        allowGroupChange: true,
  4425	        forceEpoch: true,
  4426	      });
  4427	    },
  4428	    updateGroup(nextGroup) {
  4429	      // Jakýkoli pokus o změnu konfigurace nejdřív zavře live dispatch.
  4430	      gate = { ...gate, armed: false };
  4431	      if (nextGroup.id !== group.id) throw new Error('Nelze změnit runtime na jinou copy group');
  4432	      assertRuntimeGroup(nextGroup);
  4433	      if (nextGroup.leaderAccountId !== group.leaderAccountId) {
  4434	        throw new Error('Změna leadera vyžaduje bezpečný reconfigureGroup preflight');
  4435	      }
  4436	      group = nextGroup;
  4437	      invalidateReconciliation();
  4438	    },
  4439	    async flattenAccount(accountId, operationId) {
  4440	      const allowed = new Set([
  4441	        group.leaderAccountId as number,
  4442	        ...group.followers.map(follower => follower.accountId),
  4443	      ]);
  4444	      if (!allowed.has(accountId)) throw new Error('Účet není součástí této copy group');
  4445	      return flatten([accountId], operationId);
  4446	    },
  4447	    async flattenGroup(operationId) {
  4448	      if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
  4449	      return flatten(
  4450	        [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)],
  4451	        operationId,
  4452	      );
  4453	    },
  4454	    async waiveStuckOperation({ kind, key, reason }) {
  4455	      const explanation = reason.trim();
  4456	      if (explanation.length < 5) throw new Error('Ruční resolution vyžaduje konkrétní důvod');
  4457	      gate = { ...gate, armed: false };
  4458	      invalidateReconciliation();
  4459	      await processor.mutate(async current => {
  4460	        const outbox = new Map(current.outbox);
  4461	        const bracketOutbox = new Map(current.bracketOutbox);
  4462	        const osoOutbox = new Map(current.osoOutbox);
  4463	        const cancelOutbox = new Map(current.cancelOutbox);
  4464	        let state = current.state;
  4465	        if (kind === 'place') {

codex
První dvě původní mezery jsou odstraněné v tom úzkém místě: veřejný `reconcile()` už příznak neshazuje a pouze zařadí plnou recovery do `eventTail`. Kontroluji ale ještě důležitý detail: zda samotná nově spuštěná recovery respektuje `safetyGeneration`, protože její vnitřní reconciliation může vrátit prázdná pole i při neautoritativním výsledku. To rozhodne, zda je verdikt opravdu „schválit“.
exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '870,930p' && nl -ba services/copierRuntimeController.ts | sed -n '1625,1685p' && nl -ba services/copierRuntimeController.ts | sed -n '2674,2825p' && nl -ba services/copierRuntimeController.ts | sed -n '3650,3950p' && nl -ba services/copierRuntimeController.ts | sed -n '4080,4140p' && rg -n -C 4 \"function invalidateReconciliation|const invalidateReconciliation|invalidateReconciliation =|safetyGeneration \\+=\" services/copierRuntimeController.ts" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
   870	  /**
   871	   * Monotónní verze bezpečnostního stavu. Reconciliation si ji zapamatuje
   872	   * před broker I/O a čistý výsledek smí potvrdit pouze tehdy, když během
   873	   * čtení nevznikl novější incident, reconnect ani jiná invalidace.
   874	   */
   875	  let safetyGeneration = 0;
   876	  let eventTail: Promise<void> = Promise.resolve();
   877	  let reconciliationTail: Promise<void> = Promise.resolve();
   878	  const admittedLeaderOrders = new Set<string>();
   879	  const admittedFlatExitOrders = new Set<string>();
   880	  const leaderPositions = new Map<string, number>();
   881	  const positionsByAccount = new Map<number, Map<string, number>>();
   882	  let cooldownPending = false;
   883	  /** Důvod čekajícího auto day-locku; zamyká se až po zploštění skupiny. */
   884	  let dayLockPendingReason: string | null = null;
   885	  /**
   886	   * Symboly, jejichž obchod běžel už před startem počítadla (restart workeru
   887	   * uprostřed pozice). Bez známé průměrné ceny by se P&L spočítal špatně —
   888	   * takový obchod se do denního limitu nepočítá, dokud symbol není flat.
   889	   */
   890	  const untrackedTradeSymbols = new Set<string>();
   891	  let lastAutoClose: CopierAutoClose | null = null;
   892	  let autoCloseInFlight = false;
   893	  /**
   894	   * Mez na auto-close v jedné fail-closed epizodě. Flatten bez reduce-only
   895	   * podpory venue teoreticky umí přestřelit (externí zavření mezi čtením
   896	   * pozice a odesláním) a detektor otočení by pak plánoval další close —
   897	   * konvergence je pravděpodobná, ale nesmí být nekonečná. Po vyčerpání
   898	   * zbývá DISARMED stav, audit a notifikace; reset až úspěšným flat/ARM.
   899	   */
   900	  const AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE = 3;
   901	  let autoCloseEpisodeAttempts = 0;
   902	  /** Po reconnectu/bootu se má rozhodnout o osudu otevřených kopií. */
   903	  let pendingConnectionRecovery = false;
   904	  let recoveryInFlight = false;
   905	  let bootRecoveryChecked = false;
   906	  let lastResumeOffer: { at: number } | null = null;
   907	  const pendingBracketTimers = new Map<string, ReturnType<typeof setTimeout>>();
   908	  const pendingOsoTimers = new Map<string, ReturnType<typeof setTimeout>>();
   909	  const pendingOsoEvents = new Map<string, LeaderEvent>();
   910	  const pendingOsoFlushes = new Map<string, Promise<void>>();
   911	  const pendingOsoResolvers = new Map<string, () => void>();
   912	  type FollowerFillRole = 'copied-entry' | 'protective';
   913	  interface RecentFollowerFillCause {
   914	    role: FollowerFillRole;
   915	    sign: 1 | -1;
   916	    brokerOrderId: string;
   917	    observedAt: number;
   918	  }
   919	  interface PendingFollowerTransition {
   920	    accountId: number;
   921	    symbol: string;
   922	    netQuantity: number;
   923	    timer: ReturnType<typeof setTimeout>;
   924	  }
   925	  const recentFollowerFillCauses = new Map<string, RecentFollowerFillCause>();
   926	  const pendingFollowerTransitions = new Map<string, PendingFollowerTransition>();
   927	  const pendingFollowerMagnitudeChecks = new Map<string, ReturnType<typeof setTimeout>>();
   928	  const leaderFlatGuardTimers = new Map<string, ReturnType<typeof setTimeout>>();
   929	  const followerTransitionCorrelationWindowMs = options.followerTransitionCorrelationWindowMs ?? 2_000;
   930	  const leaderFlatGraceMs = options.leaderFlatGraceMs ?? 2_000;
  1625	        currentRuntime().state.safety.entryCooldownUntil,
  1626	        now + cooldownMinutes * 60_000,
  1627	      ),
  1628	    };
  1629	    await persistSafety(safety);
  1630	    gate = { ...gate, armed: false };
  1631	    options.onAudit?.([{
  1632	      at: now,
  1633	      leaderEventId: `cooldown-${symbol}`,
  1634	      kind: 'blocked',
  1635	      reason: `entry-cooldown ${cooldownMinutes}min po potvrzeném zploštění celé skupiny`,
  1636	    }]);
  1637	  };
  1638	
  1639	  const emptyDailyStats = (at: number): CopierDailyStats => ({
  1640	    sessionEndAt: at + msUntilTradovateSessionEnd(at),
  1641	    realizedPnlUsd: 0,
  1642	    losingTrades: 0,
  1643	    openLots: [],
  1644	    recentClosedTrades: [],
  1645	    unpricedSymbols: [],
  1646	  });
  1647	
  1648	  /** Mutovatelná kopie statistik aktuální session; po 17:00 CT začíná nový den. */
  1649	  const currentDailyStats = (at: number): CopierDailyStats => {
  1650	    const stored = currentRuntime().state.safety.dailyStats;
  1651	    if (!stored || at >= stored.sessionEndAt) return emptyDailyStats(at);
  1652	    return {
  1653	      ...stored,
  1654	      openLots: stored.openLots.map(lot => ({ ...lot })),
  1655	      recentClosedTrades: stored.recentClosedTrades?.map(trade => ({ ...trade })) ?? [],
  1656	      unpricedSymbols: [...stored.unpricedSymbols],
  1657	    };
  1658	  };
  1659	
  1660	  /**
  1661	   * Denní read-only ledger z leader fillů (avg-cost matching per symbol).
  1662	   * Běží vždy, aby uzavřené copier obchody a P&L přežily restart a mohly
  1663	   * napájet widgety. Risk limity jsou pouze volitelní konzumenti; při jejich
  1664	   * překročení se day-lock stále aktivuje až po zploštění celé skupiny.
  1665	   */
  1666	  const trackLeaderFill = async (fill: BrokerFill, now: number) => {
  1667	    const limitUsd = group.safety?.dailyLossLimitUsd ?? 0;
  1668	    const maxLosing = group.safety?.dailyMaxLosingTrades ?? 0;
  1669	    const at = fill.filledAt > 0 ? fill.filledAt : now;
  1670	    const stored = currentRuntime().state.safety.dailyStats;
  1671	    if (stored && at >= stored.sessionEndAt) untrackedTradeSymbols.clear();
  1672	    const stats = currentDailyStats(at);
  1673	
  1674	    const preNet = leaderPositions.get(fill.symbol) ?? 0;
  1675	    const hasLot = stats.openLots.some(lot => lot.symbol === fill.symbol);
  1676	    if (!hasLot && preNet !== 0 && !untrackedTradeSymbols.has(fill.symbol)) {
  1677	      untrackedTradeSymbols.add(fill.symbol);
  1678	      options.onAudit?.([{
  1679	        at: now, leaderEventId: `daily-risk-${fill.symbol}`, kind: 'blocked',
  1680	        reason: `denní počítadlo: obchod ${fill.symbol} běžel před startem počítadla, do limitu se nepočítá`,
  1681	      }]);
  1682	    }
  1683	    if (untrackedTradeSymbols.has(fill.symbol)) return;
  1684	
  1685	    const pv = pointValueUsd(fill.symbol);
  2674	  /**
  2675	   * Connection recovery „podle stavu": po obnovení spojení (nebo po bootu
  2676	   * s durable stopou živých kopií) se autoritativně ověří účty.
  2677	   * Synchronní kopie s otevřeným leaderem se DRŽÍ (brackety je chrání)
  2678	   * a čeká se na jediný klik ARM; osiřelé nebo rozjeté kopie se
  2679	   * risk-redukčně zavřou. Nikdy se sám neARMuje.
  2680	   */
  2681	  const runConnectionRecovery = async () => {
  2682	    if (!pendingConnectionRecovery || stopped) return;
  2683	    pendingConnectionRecovery = false;
  2684	    // `armExpiryFlatten: off` vypíná jen automatickou broker akci, nikoli
  2685	    // povinnou read-only kontrolu po reconnectu/resyncu.
  2686	    if (gate.killSwitch || group.leaderAccountId == null) return;
  2687	    if (!gate.connected) {
  2688	      pendingConnectionRecovery = true;
  2689	      return;
  2690	    }
  2691	    const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  2692	    // Stejný optional-skip vstup jako ruční Kontrola pozic: follower, který
  2693	    // právě není v žádném OAuth adresáři, se nesmí routovat (router by hodil
  2694	    // chybu), ale jeho absence je pro breached/DLL účet legitimní.
  2695	    let missingOptionalAccountIds: readonly number[] = [];
  2696	    let lastRecoveryError: string | null = null;
  2697	    if (options.resolveMissingOptionalAccountIds) {
  2698	      try {
  2699	        const followerIds = new Set(group.followers.map(follower => follower.accountId));
  2700	        missingOptionalAccountIds = [...new Set(await options.resolveMissingOptionalAccountIds(group))]
  2701	          .filter(accountId => followerIds.has(accountId) && accountId !== group.leaderAccountId);
  2702	      } catch (reason) {
  2703	        // Bez optional-skip vstupu pokračujeme s plným routingem; důvod se
  2704	        // nesmí ztratit — jinak je pět tichých pokusů nečitelných (3. 9.).
  2705	        missingOptionalAccountIds = [];
  2706	        lastRecoveryError = `optional-skip resolver: ${errorOf(reason).message}`;
  2707	        options.onAudit?.([{
  2708	          at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2709	          reason: `connection-recovery: ${lastRecoveryError}`,
  2710	        }]);
  2711	      }
  2712	    }
  2713	    let reconciliation: { divergentAccounts: number[]; workingOrderAccounts: number[] } | null = null;
  2714	    for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
  2715	      if (attempt > 0) await wait(2_000);
  2716	      if (!gate.connected) {
  2717	        pendingConnectionRecovery = true;
  2718	        return;
  2719	      }
  2720	      try {
  2721	        reconciliation = await performReconciliation({
  2722	          missingOptionalAccountIds: [...missingOptionalAccountIds],
  2723	        });
  2724	        break;
  2725	      } catch (reason) {
  2726	        // Spojení je čerstvé — pár pokusů, pak poctivé přiznání níže.
  2727	        lastRecoveryError = errorOf(reason).message;
  2728	      }
  2729	    }
  2730	    if (!reconciliation) {
  2731	      // Pět rychlých pokusů je jen jedna recovery vlna. Příští potvrzený
  2732	      // connected event (nebo čistá ruční Kontrola pozic) ji musí smět spustit
  2733	      // znovu; stav zůstává DISARMED.
  2734	      pendingConnectionRecovery = true;
  2735	      options.onAudit?.([{
  2736	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2737	        reason: `connection-recovery: reconciliation selhala 5× — ${lastRecoveryError ?? 'bez důvodu'}`,
  2738	      }]);
  2739	      failClosed(new Error(
  2740	        'connection=aggregate phase=reconciliation Po obnovení spojení se nepodařilo ověřit stav účtů — kopie zůstávají chráněné brackety, zkontroluj Tradovate'
  2741	        + (lastRecoveryError ? ` (${lastRecoveryError})` : ''),
  2742	      ));
  2743	      return;
  2744	    }
  2745	    const guardedSymbols = await resumeLeaderFlatEpochsAfterSnapshot();
  2746	    if (!hasFollowerExposure()) {
  2747	      if (lastDisarm?.trigger === 'transport') updateDisarmOutcome(lastDisarm.at, 'flat');
  2748	      await syncLiveCopyExposureFlag('clear');
  2749	      options.onAudit?.([{
  2750	        at: clock(), leaderEventId: 'connection-recovery', kind: 'recovered',
  2751	        reason: 'connection-recovery: autoritativní reconciliation potvrdila flat/no-active stav; runtime zůstává DISARMED',
  2752	      }]);
  2753	      return;
  2754	    }
  2755	    const orphanSymbols = new Set<string>();
  2756	    for (const follower of group.followers) {
  2757	      for (const [symbol, quantity] of positionsByAccount.get(follower.accountId) ?? []) {
  2758	        if (quantity !== 0 && (leaderPositions.get(symbol) ?? 0) === 0) orphanSymbols.add(symbol);
  2759	      }
  2760	    }
  2761	    const unguardedOrphanSymbols = [...orphanSymbols].filter(symbol => !guardedSymbols.has(symbol));
  2762	    if (unguardedOrphanSymbols.length > 0) {
  2763	      failClosed(new Error(
  2764	        `Copier fail-closed: po reconnectu je leader flat a follower má neověřenou expozici (${unguardedOrphanSymbols.join(', ')}); bez opening ownership se automaticky nezavírá`,
  2765	      ), { autoClose: false });
  2766	      options.onAudit?.([{
  2767	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2768	        reason: `connection-recovery: detect-only orphan expozice bez durable opening epochy (${unguardedOrphanSymbols.join(', ')}); žádný broker write`,
  2769	      }]);
  2770	      return;
  2771	    }
  2772	    if (orphanSymbols.size > 0) {
  2773	      options.onAudit?.([{
  2774	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2775	        reason: `connection-recovery: leader-flat guard obnoven pro ${[...orphanSymbols].join(', ')}; runtime zůstává DISARMED`,
  2776	      }]);
  2777	      return;
  2778	    }
  2779	    const leaderOpen = [...(positionsByAccount.get(group.leaderAccountId)?.values() ?? [])]
  2780	      .some(quantity => quantity !== 0);
  2781	    if (leaderOpen && reconciliation.divergentAccounts.length === 0) {
  2782	      if (lastDisarm?.trigger === 'transport') {
  2783	        updateDisarmOutcome(lastDisarm.at, 'left-open-protected');
  2784	      }
  2785	      lastResumeOffer = null;
  2786	      options.onAudit?.([{
  2787	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2788	        reason: 'connection-recovery: kopie jsou synchronní s leaderem — drženy DISARMED, ARM je blokovaný do flat',
  2789	      }]);
  2790	      return;
  2791	    }
  2792	    const flat = await autoFlattenCopies('reconnect', clock());
  2793	    if (lastDisarm?.trigger === 'transport') {
  2794	      updateDisarmOutcome(lastDisarm.at, flat ? 'auto-closed' : 'unknown');
  2795	    }
  2796	  };
  2797	
  2798	  const scheduleConnectionRecovery = () => {
  2799	    if (recoveryInFlight || stopped) return;
  2800	    recoveryInFlight = true;
  2801	    eventTail = eventTail
  2802	      .then(async () => {
  2803	        try {
  2804	          await runConnectionRecovery();
  2805	        } finally {
  2806	          recoveryInFlight = false;
  2807	        }
  2808	      })
  2809	      .catch(reason => {
  2810	        recoveryInFlight = false;
  2811	        failClosed(reason);
  2812	      });
  2813	  };
  2814	
  2815	  /**
  2816	   * Expirace ARM nesmí nechat kopie viset bez dozoru. Vyhodnocuje se
  2817	   * event-driven (heartbeat chodí každé ~2,5 s) proti injektovaným hodinám,
  2818	   * takže je plně deterministická. Shadow ARM nikdy nic neposílá, ani při
  2819	   * expiraci.
  2820	   */
  2821	  const maybeHandleArmExpiry = async (now: number) => {
  2822	    if (stopped || !gate.armed || gate.armTtlMs <= 0) return;
  2823	    if (now - gate.armedAt <= gate.armTtlMs) return;
  2824	    const armedAt = gate.armedAt;
  2825	    const wasShadow = gate.shadowMode;
  3650	      if (leaderStopOrderIds.has(leaderEvent.orderId)) {
  3651	        pushCopyEvent('sl-moved', leaderEvent.symbol, positionSide, leaderEvent.quantity, now, {
  3652	          ...(leaderEvent.stopPrice != null ? { price: leaderEvent.stopPrice } : {}),
  3653	          ...(levelPnl(leaderEvent.symbol, leaderEvent.stopPrice) ?? {}),
  3654	        });
  3655	      } else if (leaderTargetOrderIds.has(leaderEvent.orderId)) {
  3656	        pushCopyEvent('tp-moved', leaderEvent.symbol, positionSide, leaderEvent.quantity, now, {
  3657	          ...(leaderEvent.limitPrice != null ? { price: leaderEvent.limitPrice } : {}),
  3658	          ...(levelPnl(leaderEvent.symbol, leaderEvent.limitPrice) ?? {}),
  3659	        });
  3660	      } else {
  3661	        const movedPrice = leaderEvent.limitPrice ?? leaderEvent.stopPrice;
  3662	        // Posun čekajícího entry mění referenci pro potenciální P&L SL/TP.
  3663	        if (movedPrice != null && plannedEntryBySymbol.has(leaderEvent.symbol)) {
  3664	          rememberPlannedEntry(leaderEvent.symbol, movedPrice,
  3665	            (leaderEvent.side === 'Sell' ? -1 : 1) * leaderEvent.quantity);
  3666	        }
  3667	        pushCopyEvent('order-moved', leaderEvent.symbol, eventSide, leaderEvent.quantity, now, {
  3668	          ...(movedPrice != null ? { price: movedPrice } : {}),
  3669	        });
  3670	      }
  3671	    }
  3672	  };
  3673	
  3674	  type ReconciliationResult = {
  3675	    divergentAccounts: number[];
  3676	    workingOrderAccounts: number[];
  3677	  };
  3678	
  3679	  /**
  3680	   * Všechny reconciliation běhy sdílejí jednu frontu. Novější požadavek tak
  3681	   * vždy čte broker až po starším a starý snapshot nemůže doběhnout jako
  3682	   * poslední a přepsat novější bezpečnostní stav.
  3683	   */
  3684	  async function performReconciliation(
  3685	    reconciliationOptions: CopierReconciliationOptions & { clearLastError?: boolean } = {},
  3686	  ): Promise<ReconciliationResult> {
  3687	    const requestedGeneration = safetyGeneration;
  3688	    const run = reconciliationTail.then(() => runReconciliation(
  3689	      reconciliationOptions,
  3690	      requestedGeneration,
  3691	    ));
  3692	    reconciliationTail = run.then(() => undefined, () => undefined);
  3693	    return run;
  3694	  }
  3695	
  3696	  /** Autoritativní reconciliation — sdílí ji veřejné API i connection recovery. */
  3697	  async function runReconciliation(
  3698	    reconciliationOptions: CopierReconciliationOptions & { clearLastError?: boolean },
  3699	    requestedGeneration: number,
  3700	  ): Promise<ReconciliationResult> {
  3701	      const generationAtStart = safetyGeneration;
  3702	      if (!gate.connected) {
  3703	        // Holé „bez broker spojení" mate: uživatel vidí v kartě Připojení
  3704	        // platné OAuth a myslí si, že spojení stojí. Padá ale živý WebSocket
  3705	        // workeru, což je jiná vrstva — hláška proto říká i příčinu a co dál.
  3706	        const reason = lastError?.message?.trim();
  3707	        throw new Error([
  3708	          'Kontrolu pozic nelze provést: worker nemá živé spojení s Tradovate.',
  3709	          reason ? `Poslední chyba: ${reason}.` : '',
  3710	          'OAuth přihlášení tím není dotčené — spojení se obnoví samo, zkus to za chvíli znovu.',
  3711	        ].filter(Boolean).join(' '));
  3712	      }
  3713	      if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
  3714	      const accountIds = [group.leaderAccountId, ...group.followers.map(item => item.accountId)];
  3715	      const eligibilityNow = clock();
  3716	      const followerIds = new Set(group.followers.map(item => item.accountId));
  3717	      const missingOptionalAccountIds = new Set(reconciliationOptions.missingOptionalAccountIds ?? []);
  3718	      for (const accountId of missingOptionalAccountIds) {
  3719	        if (!Number.isSafeInteger(accountId) || !followerIds.has(accountId)) {
  3720	          throw new Error(`Reconciliation dostala neplatný optional follower účet ${accountId}`);
  3721	        }
  3722	      }
  3723	      let missingEligibilityChanged = false;
  3724	      for (const accountId of missingOptionalAccountIds) {
  3725	        const current = accountEligibility.get(accountId);
  3726	        if (current && current.state !== 'active') continue;
  3727	        setEligibility(accountId, {
  3728	          ...(current ?? {}),
  3729	          accountId,
  3730	          state: 'unverifiable',
  3731	          reason: 'účet není viditelný v žádném připojeném OAuth při read-only reconciliaci',
  3732	          at: eligibilityNow,
  3733	        });
  3734	        missingEligibilityChanged = true;
  3735	      }
  3736	      if (missingEligibilityChanged) await persistEligibility();
  3737	      const eligibilityByAccount = new Map<number, CopierAccountEligibility>();
  3738	      for (const [accountId, stored] of accountEligibility) {
  3739	        eligibilityByAccount.set(accountId, eligibilityAt(stored, eligibilityNow));
  3740	      }
  3741	      // Známý vyřazený follower nesmí zablokovat autoritativní kontrolu
  3742	      // zdravých účtů jen proto, že ho prop firma po BREACH/DLL přestala
  3743	      // vracet v account/list. Leader je vždy povinný. `unverifiable` účet
  3744	      // se naopak při dostupné capability dále načte a může se reaktivovat.
  3745	      const optionalFollowerIds = new Set(group.followers
  3746	        .filter(follower => (eligibilityByAccount.get(follower.accountId)?.state ?? 'active') !== 'active')
  3747	        .map(follower => follower.accountId));
  3748	      const routedAccountIds = accountIds.filter(accountId => !missingOptionalAccountIds.has(accountId));
  3749	      const capabilities = await broker.listAccountCapabilities(routedAccountIds);
  3750	      const byCapability = new Map(capabilities.map(item => [item.accountId, item]));
  3751	      const missingRequired = routedAccountIds.filter(
  3752	        accountId => !byCapability.has(accountId) && !optionalFollowerIds.has(accountId),
  3753	      );
  3754	      const missing = [...new Set([...missingOptionalAccountIds, ...missingRequired])];
  3755	      const inactive = routedAccountIds.filter(accountId =>
  3756	        byCapability.get(accountId)?.active === false && !optionalFollowerIds.has(accountId));
  3757	      const readOnlyFollowers = group.followers.filter(
  3758	        follower => byCapability.get(follower.accountId)?.canTrade === false
  3759	          && !optionalFollowerIds.has(follower.accountId),
  3760	      ).map(follower => follower.accountId);
  3761	      lastOauthPreflight = {
  3762	        missingAccounts: [...missing],
  3763	        inactiveAccounts: [...inactive],
  3764	        readOnlyFollowerAccounts: [...readOnlyFollowers],
  3765	      };
  3766	      if (missingRequired.length > 0 || inactive.length > 0 || readOnlyFollowers.length > 0) {
  3767	        gate = { ...gate, armed: false };
  3768	        invalidateReconciliation();
  3769	        const details = [
  3770	          missingRequired.length > 0 ? `missing=${missingRequired.join(',')}` : '',
  3771	          inactive.length > 0 ? `inactive=${inactive.join(',')}` : '',
  3772	          readOnlyFollowers.length > 0 ? `readOnlyFollowers=${readOnlyFollowers.join(',')}` : '',
  3773	        ].filter(Boolean).join(' ');
  3774	        throw new Error(`OAuth/account preflight selhal: ${details}`);
  3775	      }
  3776	      const snapshotAccountIds = accountIds.filter(accountId => {
  3777	        const capability = byCapability.get(accountId);
  3778	        if (!capability?.active || !capability.canTrade) return false;
  3779	        const state = eligibilityByAccount.get(accountId)?.state ?? 'active';
  3780	        // BREACHED a stále platný DLL jsou známé exclusions. Expirující DLL
  3781	        // už eligibilityAt převedlo na `unverifiable`, takže se načte a po
  3782	        // úspěšném snapshotu může bezpečně vrátit do active.
  3783	        return state !== 'breached' && state !== 'dll-locked';
  3784	      });
  3785	      const snapshots = await Promise.all(snapshotAccountIds.map(async accountId => {
  3786	        const [positions, orders] = await Promise.all([
  3787	          broker.listPositions(accountId),
  3788	          broker.listOrders(accountId),
  3789	        ]);
  3790	        return { accountId, positions, orders };
  3791	      }));
  3792	      const byAccount = new Map(snapshots.map(item => [item.accountId, item]));
  3793	      positionsByAccount.clear();
  3794	      for (const snapshot of snapshots) {
  3795	        positionsByAccount.set(snapshot.accountId, new Map(
  3796	          snapshot.positions.map(item => [item.symbol, item.netQuantity]),
  3797	        ));
  3798	      }
  3799	      leaderPositions.clear();
  3800	      // Atribuce SL/TP exitů přežije restart: ochranné nohy leadera se
  3801	      // obnoví z autoritativních working orderů (mají parent/OCO vazbu).
  3802	      for (const order of byAccount.get(group.leaderAccountId)?.orders ?? []) {
  3803	        if (order.status !== 'working') continue;
  3804	        if (order.parentOrderId == null && order.ocoId == null && order.linkedOrderId == null) continue;
  3805	        if (order.orderType === 'Stop' || order.orderType === 'StopLimit') {
  3806	          leaderStopOrderIds.add(order.brokerOrderId);
  3807	        } else if (order.orderType === 'Limit') {
  3808	          leaderTargetOrderIds.add(order.brokerOrderId);
  3809	        }
  3810	      }
  3811	      const reconciledLeaderPositions = new Map(
  3812	        (byAccount.get(group.leaderAccountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
  3813	      );
  3814	      for (const [symbol, quantity] of reconciledLeaderPositions) leaderPositions.set(symbol, quantity);
  3815	      const divergent = new Set<number>();
  3816	      workingOrderAccounts = new Set(
  3817	        snapshots.filter(item => item.orders.some(order => isOpenOrderStatus(order.status))).map(item => item.accountId),
  3818	      );
  3819	      // Reaktivace eligibility: JEDINÉ místo, kde se DLL/unverifiable vrací
  3820	      // do 'active' — autoritativní snapshot účtu se povedl. Čas sám nikdy
  3821	      // nestačí (rollEligibilityToNewSession umí jen zpřísnit na
  3822	      // 'unverifiable'). Breach zůstává trvale, dokud ho operátor neřeší.
  3823	      {
  3824	        const reactivationNow = clock();
  3825	        let eligibilityChanged = rollEligibilityToNewSession(reactivationNow);
  3826	        for (const [accountId, entry] of accountEligibility) {
  3827	          if (!byAccount.has(accountId)) continue;
  3828	          const newSessionBegan = entry.lockSessionEndAt != null
  3829	            && entry.lockSessionEndAt > 0
  3830	            && reactivationNow >= entry.lockSessionEndAt;
  3831	          if (entry.state === 'unverifiable' || (entry.state === 'dll-locked' && newSessionBegan)) {
  3832	            accountEligibility.set(accountId, {
  3833	              ...entry, state: 'active', at: reactivationNow,
  3834	              reason: 'autoritativně ověřeno při reconciliaci po nové session',
  3835	            });
  3836	            eligibilityChanged = true;
  3837	            options.onAudit?.([{
  3838	              at: reactivationNow, leaderEventId: `eligibility-reactivate-${accountId}`,
  3839	              kind: 'recovered', accountId,
  3840	              reason: 'účet znovu způsobilý — autoritativní ověření po nové session',
  3841	            }]);
  3842	          }
  3843	        }
  3844	        if (eligibilityChanged) await persistEligibility();
  3845	      }
  3846	      const ineligibleAfterReactivation = currentIneligibleAccounts();
  3847	      for (const follower of group.followers) {
  3848	        // Účet s autoritativní eligibility exclusion není participantem
  3849	        // copieru. Jeho chybějící snapshot proto není divergence zdravých
  3850	        // participantů; po reaktivaci se automaticky vrátí do této kontroly.
  3851	        if (ineligibleAfterReactivation.has(follower.accountId)) continue;
  3852	        const followerPositions = new Map(
  3853	          (byAccount.get(follower.accountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
  3854	        );
  3855	        const symbols = new Set([...reconciledLeaderPositions.keys(), ...followerPositions.keys()]);
  3856	        for (const symbol of symbols) {
  3857	          const expected = Math.trunc((reconciledLeaderPositions.get(symbol) ?? 0) * follower.multiplier);
  3858	          if ((followerPositions.get(symbol) ?? 0) !== expected) {
  3859	            divergent.add(follower.accountId);
  3860	            break;
  3861	          }
  3862	        }
  3863	      }
  3864	      // Durable dokončení sweep povinnosti: pád workeru mezi follower flat
  3865	      // a potvrzeným cancelem nesmí povinnost ztratit (review, bod 5).
  3866	      // Reconciliation je autoritativní moment, kdy se osiřelé working
  3867	      // ochranné nohy nad flat followerem dají najít a doprovodit.
  3868	      for (const follower of group.followers) {
  3869	        const snapshot = byAccount.get(follower.accountId);
  3870	        if (!snapshot) continue;
  3871	        const workingIds = new Set(
  3872	          snapshot.orders.filter(order => isOpenOrderStatus(order.status)).map(order => order.brokerOrderId),
  3873	        );
  3874	        if (workingIds.size === 0) continue;
  3875	        const flatSymbols = new Set<string>();
  3876	        const runtime = currentRuntime();
  3877	        for (const entry of [...runtime.bracketOutbox.values(), ...runtime.osoOutbox.values()]) {
  3878	          if (entry.request.accountId !== follower.accountId) continue;
  3879	          const net = snapshot.positions.find(item => item.symbol === entry.request.symbol)?.netQuantity ?? 0;
  3880	          if (net !== 0) continue;
  3881	          const hasWorkingLeg = [entry.firstBrokerOrderId, entry.secondBrokerOrderId]
  3882	            .some(id => id && workingIds.has(id));
  3883	          if (hasWorkingLeg) flatSymbols.add(entry.request.symbol);
  3884	        }
  3885	        for (const symbol of flatSymbols) {
  3886	          await sweepFollowerProtectiveLegs(follower.accountId, symbol, clock(), {
  3887	            authoritativeWorkingOrderIds: workingIds,
  3888	          });
  3889	        }
  3890	      }
  3891	      gate = { ...gate, divergentAccounts: divergent, sequenceBroken: false, armed: false };
  3892	      const sameSafetyGeneration = safetyGeneration === generationAtStart;
  3893	      positionCheckComplete = sameSafetyGeneration
  3894	        && divergent.size === 0
  3895	        && workingOrderAccounts.size === 0;
  3896	      if (positionCheckComplete) {
  3897	        await acknowledgeTerminalRejectsAfterReconciliation();
  3898	        // Acknowledge může samo čekat na durable commit. Kill switch nebo
  3899	        // nový broker incident během tohoto awaitu musí mít stále přednost.
  3900	        if (safetyGeneration !== generationAtStart) {
  3901	          positionCheckComplete = false;
  3902	        } else {
  3903	          source.acknowledgeReconciliation();
  3904	          if (
  3905	            reconciliationOptions.clearLastError
  3906	            && requestedGeneration === generationAtStart
  3907	            && !gate.killSwitch
  3908	          ) lastError = null;
  3909	        }
  3910	      }
  3911	      await resolveRejectedExecutions({
  3912	        accountIds: group.followers
  3913	          .filter(follower => {
  3914	            const snapshot = byAccount.get(follower.accountId);
  3915	            return snapshot != null
  3916	              && snapshot.positions.every(position => position.netQuantity === 0);
  3917	          })
  3918	          .map(follower => follower.accountId),
  3919	        kind: 'follower-flat',
  3920	        at: clock(),
  3921	        detail: 'autoritativní reconciliation potvrdila followera flat',
  3922	      });
  3923	      return {
  3924	        divergentAccounts: [...divergent],
  3925	        workingOrderAccounts: [...workingOrderAccounts],
  3926	      };
  3927	  }
  3928	
  3929	  const LEADER_EPOCH_READ_DEADLINE_MS = 2_500;
  3930	  const withLeaderEpochDeadline = async <T>(label: string, work: Promise<T>): Promise<T> => {
  3931	    let timer: ReturnType<typeof setTimeout> | undefined;
  3932	    try {
  3933	      return await Promise.race([
  3934	        work,
  3935	        new Promise<never>((_, reject) => {
  3936	          timer = setTimeout(
  3937	            () => reject(new Error(`${label}: broker read deadline ${LEADER_EPOCH_READ_DEADLINE_MS} ms`)),
  3938	            LEADER_EPOCH_READ_DEADLINE_MS,
  3939	          );
  3940	        }),
  3941	      ]);
  3942	    } finally {
  3943	      clearTimeout(timer);
  3944	    }
  3945	  };
  3946	
  3947	  /**
  3948	   * Přepnutí leadera je změna celé order-lifecycle epochy, ne obyčejný
  3949	   * edit jednoho ID. Operace se řadí do stejné fronty jako broker eventy:
  3950	   * event, který dorazil před klikem, doběhne pod starým leaderem; event po
  4080	      });
  4081	
  4082	      // Od tohoto bodu je durable stará epocha pryč a teprve teď se stává
  4083	      // nový leader autoritativní pro event source i risk vrstvu.
  4084	      group = nextGroup;
  4085	      options.broker.setCriticalAccounts?.([nextGroup.leaderAccountId]);
  4086	      bracketCorrelator = new CopierBracketCorrelator();
  4087	      osoCorrelator = new CopierOsoCorrelator(options.osoCorrelationWindowMs);
  4088	      recentCopyEvents.length = 0;
  4089	      copyEventCounter = 0;
  4090	      leaderStopOrderIds.clear();
  4091	      leaderTargetOrderIds.clear();
  4092	      lastLeaderFillOrderId.clear();
  4093	      plannedEntryBySymbol.clear();
  4094	      admittedLeaderOrders.clear();
  4095	      admittedFlatExitOrders.clear();
  4096	      leaderPositions.clear();
  4097	      positionsByAccount.clear();
  4098	      for (const snapshot of snapshots) {
  4099	        positionsByAccount.set(snapshot.accountId, new Map(
  4100	          snapshot.positions.map(position => [position.symbol, position.netQuantity]),
  4101	        ));
  4102	      }
  4103	      untrackedTradeSymbols.clear();
  4104	      recentFollowerFillCauses.clear();
  4105	      for (const timer of pendingFollowerMagnitudeChecks.values()) clearTimeout(timer);
  4106	      pendingFollowerMagnitudeChecks.clear();
  4107	      for (const timer of leaderFlatGuardTimers.values()) clearTimeout(timer);
  4108	      leaderFlatGuardTimers.clear();
  4109	      sweptProtectiveLegs.clear();
  4110	      sweepingProtectiveLegs.clear();
  4111	      workingOrderAccounts = new Set();
  4112	      lastAutoClose = null;
  4113	      lastResumeOffer = null;
  4114	      autoCloseEpisodeAttempts = 0;
  4115	      pendingConnectionRecovery = false;
  4116	      recoveryInFlight = false;
  4117	      bootRecoveryChecked = true;
  4118	      invalidateReconciliation();
  4119	      lastError = null;
  4120	      gate = {
  4121	        ...gate,
  4122	        armed: false,
  4123	        armedAt: 0,
  4124	        now: clock(),
  4125	        shadowMode: true,
  4126	        divergentAccounts: new Set(),
  4127	        sequenceBroken: false,
  4128	        stuckOutbox: false,
  4129	      };
  4130	      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
  4131	    });
  4132	    eventTail = run.then(() => undefined, () => undefined);
  4133	    try {
  4134	      await run;
  4135	    } catch (reason) {
  4136	      const error = errorOf(reason);
  4137	      lastError = error;
  4138	      options.onError?.(error);
  4139	      throw error;
  4140	    }
1796-   * Zneplatní poslední autoritativní preflight bez vytváření falešného
1797-   * incidentu. Používá se hlavně v DISARMED, kde nová leader anomálie nic
1798-   * neposílá followerům, ale další ARM musí nejdřív znovu načíst broker stav.
1799-   */
1800:  const invalidateReconciliation = () => {
1801:    safetyGeneration += 1;
1802-    positionCheckComplete = false;
1803-    source.requireReconciliation();
1804-  };
1805-

exec
/bin/zsh -lc "rg -n \"const hasFollowerExposure|hasFollowerExposure|scheduleLeaderFlatEpochVerification|verifyLeaderFlat|leaderFlatGuardTimers|invalidateLeaderFlatEpoch|missing snapshot|snapshot\" services/copierRuntimeController.ts | head -120 && nl -ba services/copierRuntimeController.ts | sed -n '1390,1615p' && nl -ba services/copierRuntimeController.ts | sed -n '2250,2610p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
24:  invalidateLeaderFlatEpoch,
275:   * Zpřísní eligibility podle čerstvého LIVE broker snapshotu. Tato cesta
416: * Pořadí je záměrné: load durable snapshot -> recover unknown side effects ->
492:    // Kompatibilita se snapshotem před durable ledgerem: alespoň poslední
928:  const leaderFlatGuardTimers = new Map<string, ReturnType<typeof setTimeout>>();
1017:      /** Čerstvý autoritativní snapshot z reconciliation, je-li už načtený. */
1077:    // pouze ID, která broker v čerstvém snapshotu opravdu hlásí jako working.
1514:  const scheduleLeaderFlatEpochVerification = (
1519:    const existing = leaderFlatGuardTimers.get(epoch.id);
1524:      leaderFlatGuardTimers.delete(epoch.id);
1526:        .then(() => verifyLeaderFlatEpoch(token, expectedSafetyGeneration))
1529:    leaderFlatGuardTimers.set(epoch.id, timer);
1537:  const hasFollowerExposure = () => group.followers.some(follower =>
1599:        if (!(gate.armed && !gate.shadowMode && hasFollowerExposure())) return current;
1847:    if (wasLiveArmed && failure.transportLost && hasFollowerExposure()) {
2167:        const staleTimer = leaderFlatGuardTimers.get(epoch.id);
2169:        leaderFlatGuardTimers.delete(epoch.id);
2176:      scheduleLeaderFlatEpochVerification(plan.epoch, plan.token);
2181:        await persistLeaderExposureEpoch(invalidateLeaderFlatEpoch(
2289:  async function verifyLeaderFlatEpoch(
2330:    // Cache aktualizujeme až po ověření tokenu; pozdní snapshot staré epochy
2358:      snapshot: { observedAt: clock(), accounts: batchAccounts },
2400:      scheduleLeaderFlatEpochVerification(
2492:        : 'bezpečně vlastněné orphan kopie byly zploštěny, ale část batch snapshotu zůstala neověřená nebo detect-only',
2578:   * Obnoví durable leader-flat epochy po autoritativním snapshotu. Tato
2614:            scheduleLeaderFlatEpochVerification(plan.epoch, plan.token);
2617:            await persistLeaderExposureEpoch(invalidateLeaderFlatEpoch(
2657:          scheduleLeaderFlatEpochVerification(epoch, {
2663:          await persistLeaderExposureEpoch(invalidateLeaderFlatEpoch(
2746:    if (!hasFollowerExposure()) {
2939:      if (!event.connected && gate.armed && !gate.shadowMode && hasFollowerExposure()) {
3056:      // Po autoritativním snapshotu znamená chybějící symbol flat. Bez
3057:      // snapshotu je stav neznámý a ochranný příkaz se nikdy naslepo neruší.
3681:   * vždy čte broker až po starším a starý snapshot nemůže doběhnout jako
3776:      const snapshotAccountIds = accountIds.filter(accountId => {
3782:        // úspěšném snapshotu může bezpečně vrátit do active.
3785:      const snapshots = await Promise.all(snapshotAccountIds.map(async accountId => {
3792:      const byAccount = new Map(snapshots.map(item => [item.accountId, item]));
3794:      for (const snapshot of snapshots) {
3795:        positionsByAccount.set(snapshot.accountId, new Map(
3796:          snapshot.positions.map(item => [item.symbol, item.netQuantity]),
3817:        snapshots.filter(item => item.orders.some(order => isOpenOrderStatus(order.status))).map(item => item.accountId),
3820:      // do 'active' — autoritativní snapshot účtu se povedl. Čas sám nikdy
3849:        // copieru. Jeho chybějící snapshot proto není divergence zdravých
3869:        const snapshot = byAccount.get(follower.accountId);
3870:        if (!snapshot) continue;
3872:          snapshot.orders.filter(order => isOpenOrderStatus(order.status)).map(order => order.brokerOrderId),
3879:          const net = snapshot.positions.find(item => item.symbol === entry.request.symbol)?.netQuantity ?? 0;
3914:            const snapshot = byAccount.get(follower.accountId);
3915:            return snapshot != null
3916:              && snapshot.positions.every(position => position.netQuantity === 0);
3996:        leaderFlatGuardTimers.size > 0 ? 'leader-flat guard' : '',
4047:      const snapshots = await Promise.all(requiredAccountIds.map(async accountId => {
4054:      const nonFlat = snapshots.filter(snapshot =>
4055:        snapshot.positions.some(position => position.netQuantity !== 0));
4056:      const withWorkingOrders = snapshots.filter(snapshot =>
4057:        snapshot.orders.some(order => isOpenOrderStatus(order.status)));
4098:      for (const snapshot of snapshots) {
4099:        positionsByAccount.set(snapshot.accountId, new Map(
4100:          snapshot.positions.map(position => [position.symbol, position.netQuantity]),
4107:      for (const timer of leaderFlatGuardTimers.values()) clearTimeout(timer);
4108:      leaderFlatGuardTimers.clear();
4386:      // účet vrátit, i když jeho obchodní snapshot zatím není dostupný.
4601:      for (const timer of leaderFlatGuardTimers.values()) clearTimeout(timer);
4602:      leaderFlatGuardTimers.clear();
  1390	      const current = accountEligibility.get(accountId);
  1391	      const execution = current?.lastExecution;
  1392	      if (!current || !execution) continue;
  1393	      if (symbol != null && execution.symbol !== symbol) continue;
  1394	      if (execution.resolution && execution.resolution.kind !== 'unresolved') continue;
  1395	      previous.set(accountId, current);
  1396	      accountEligibility.set(accountId, {
  1397	        ...current,
  1398	        lastExecution: {
  1399	          ...execution,
  1400	          resolution: { kind, at, ...(detail ? { detail } : {}) },
  1401	        },
  1402	      });
  1403	    }
  1404	    if (previous.size === 0) return;
  1405	    try {
  1406	      await persistEligibility();
  1407	    } catch {
  1408	      for (const [accountId, entry] of previous) accountEligibility.set(accountId, entry);
  1409	    }
  1410	  };
  1411	
  1412	  const leaderExposureEpoch = (symbol: string): LeaderFlatEpoch | null =>
  1413	    currentRuntime().state.safety.leaderExposureEpochs?.find(epoch => (
  1414	      epoch.groupId === group.id
  1415	      && epoch.leaderAccountId === group.leaderAccountId
  1416	      && epoch.symbol === symbol
  1417	    )) ?? null;
  1418	
  1419	  const persistLeaderExposureEpoch = async (epoch: LeaderFlatEpoch) => {
  1420	    const safety = currentRuntime().state.safety;
  1421	    const others = (safety.leaderExposureEpochs ?? []).filter(item => !(
  1422	      item.groupId === epoch.groupId
  1423	      && item.leaderAccountId === epoch.leaderAccountId
  1424	      && item.symbol === epoch.symbol
  1425	    ));
  1426	    await persistSafety({
  1427	      ...safety,
  1428	      leaderExposureEpochs: [...others, epoch].slice(-20),
  1429	    });
  1430	  };
  1431	
  1432	  const copiedEntryLineage = (
  1433	    accountId: number,
  1434	    symbol: string,
  1435	    netQuantity: number,
  1436	  ): boolean => {
  1437	    if (netQuantity === 0) return false;
  1438	    const cause = recentFollowerFillCauses.get(`${accountId}:${symbol}`);
  1439	    if (
  1440	      !cause
  1441	      || cause.role !== 'copied-entry'
  1442	      || cause.sign !== Math.sign(netQuantity)
  1443	      || clock() - cause.observedAt > followerTransitionCorrelationWindowMs
  1444	    ) return false;
  1445	    const live = currentRuntime();
  1446	    const links = [...live.state.links.values()].flat().filter(link => link.accountId === accountId);
  1447	    if (!links.some(link => link.brokerOrderId === cause.brokerOrderId)) return false;
  1448	    const standard = [...live.outbox.values()].some(entry => (
  1449	      entry.status === 'acknowledged'
  1450	      && entry.operationKind !== 'liquidate-position'
  1451	      && entry.request.accountId === accountId
  1452	      && entry.request.symbol === symbol
  1453	      && entry.brokerOrderId === cause.brokerOrderId
  1454	    ));
  1455	    if (standard) return true;
  1456	    return [...live.osoOutbox.values()].some(entry => (
  1457	      entry.status === 'acknowledged'
  1458	      && entry.request.accountId === accountId
  1459	      && entry.request.symbol === symbol
  1460	      && entry.entryBrokerOrderId === cause.brokerOrderId
  1461	    ));
  1462	  };
  1463	
  1464	  const leaderFlatFollowersAt = (symbol: string, leaderNet: number): LeaderFlatFollowerOwnership[] =>
  1465	    group.followers.map(follower => {
  1466	      const eligibleAtOpen = follower.mode !== 'off'
  1467	        && !currentIneligibleAccounts().has(follower.accountId);
  1468	      const followerNet = positionsByAccount.get(follower.accountId)?.get(symbol);
  1469	      const expectedNet = Math.trunc(leaderNet * follower.multiplier);
  1470	      const exactManagedNet = followerNet != null
  1471	        && followerNet !== 0
  1472	        && followerNet === expectedNet
  1473	        && copiedEntryLineage(follower.accountId, symbol, followerNet);
  1474	      return {
  1475	        accountId: follower.accountId,
  1476	        replicationModeAtOpen: follower.mode,
  1477	        eligibleAtOpen,
  1478	        copyLineage: exactManagedNet ? 'confirmed' : 'unproven',
  1479	        ...(exactManagedNet ? { confirmedNetQuantity: followerNet } : {}),
  1480	      };
  1481	    });
  1482	
  1483	  const strengthenLeaderFlatLineage = async (
  1484	    accountId: number,
  1485	    symbol: string,
  1486	    netQuantity: number,
  1487	  ) => {
  1488	    const epoch = leaderExposureEpoch(symbol);
  1489	    if (!epoch || epoch.phase !== 'open' || netQuantity === 0) return;
  1490	    const follower = group.followers.find(item => item.accountId === accountId);
  1491	    if (!follower || follower.mode === 'off') return;
  1492	    const leaderNet = leaderPositions.get(symbol);
  1493	    if (leaderNet == null || leaderNet === 0) return;
  1494	    const expectedNet = Math.trunc(leaderNet * follower.multiplier);
  1495	    if (
  1496	      netQuantity !== expectedNet
  1497	      || !copiedEntryLineage(accountId, symbol, netQuantity)
  1498	    ) return;
  1499	    const participant = epoch.followers.find(item => item.accountId === accountId);
  1500	    if (!participant || !participant.eligibleAtOpen) return;
  1501	    if (
  1502	      participant.copyLineage === 'confirmed'
  1503	      && participant.confirmedNetQuantity === netQuantity
  1504	    ) return;
  1505	    await persistLeaderExposureEpoch(mergeLeaderFlatEpochLineage(epoch, {
  1506	      followers: [{
  1507	        ...participant,
  1508	        copyLineage: 'confirmed',
  1509	        confirmedNetQuantity: netQuantity,
  1510	      }],
  1511	    }));
  1512	  };
  1513	
  1514	  const scheduleLeaderFlatEpochVerification = (
  1515	    epoch: LeaderFlatEpoch,
  1516	    token: LeaderFlatGuardToken,
  1517	    expectedSafetyGeneration = safetyGeneration,
  1518	  ) => {
  1519	    const existing = leaderFlatGuardTimers.get(epoch.id);
  1520	    if (existing) clearTimeout(existing);
  1521	    const scheduledAt = clock();
  1522	    const delay = Math.max(0, (epoch.graceUntil ?? scheduledAt) - scheduledAt);
  1523	    const timer = setTimeout(() => {
  1524	      leaderFlatGuardTimers.delete(epoch.id);
  1525	      eventTail = eventTail
  1526	        .then(() => verifyLeaderFlatEpoch(token, expectedSafetyGeneration))
  1527	        .catch(reason => failClosed(reason, { autoClose: false }));
  1528	    }, delay);
  1529	    leaderFlatGuardTimers.set(epoch.id, timer);
  1530	  };
  1531	
  1532	  const groupIsFlat = () => [group.leaderAccountId, ...group.followers.map(item => item.accountId)]
  1533	    .filter((accountId): accountId is number => accountId != null)
  1534	    .every(accountId => [...(positionsByAccount.get(accountId)?.values() ?? [])]
  1535	      .every(quantity => quantity === 0));
  1536	
  1537	  const hasFollowerExposure = () => group.followers.some(follower =>
  1538	    [...(positionsByAccount.get(follower.accountId)?.values() ?? [])].some(quantity => quantity !== 0));
  1539	
  1540	  const recordDisarm = (
  1541	    trigger: CopierDisarmTrigger,
  1542	    detail: string,
  1543	    copiesOutcome: CopierCopiesOutcome,
  1544	  ): CopierDisarmRecord => {
  1545	    const record = createCopierDisarmRecord({
  1546	      at: clock(), trigger, detail, copiesOutcome,
  1547	    });
  1548	    lastDisarm = record;
  1549	    disarmHistory.push(record);
  1550	    if (disarmHistory.length > COPIER_DISARM_HISTORY_LIMIT) {
  1551	      disarmHistory.splice(0, disarmHistory.length - COPIER_DISARM_HISTORY_LIMIT);
  1552	    }
  1553	    return record;
  1554	  };
  1555	
  1556	  const disarmIndexAt = (recordAt: number): number => {
  1557	    let index = -1;
  1558	    for (let candidate = disarmHistory.length - 1; candidate >= 0; candidate -= 1) {
  1559	      if (disarmHistory[candidate].at === recordAt) {
  1560	        index = candidate;
  1561	        break;
  1562	      }
  1563	    }
  1564	    return index;
  1565	  };
  1566	
  1567	  const updateDisarmOutcome = (
  1568	    recordAt: number | undefined,
  1569	    copiesOutcome: CopierCopiesOutcome,
  1570	  ) => {
  1571	    if (recordAt == null) return;
  1572	    const index = disarmIndexAt(recordAt);
  1573	    if (index < 0) return;
  1574	    const updated = { ...disarmHistory[index], copiesOutcome };
  1575	    disarmHistory[index] = updated;
  1576	    if (lastDisarm?.at === recordAt) lastDisarm = updated;
  1577	  };
  1578	
  1579	  const successfulAutoCloseOutcome = (recordAt: number): CopierCopiesOutcome => (
  1580	    disarmHistory[disarmIndexAt(recordAt)]?.copiesOutcome === 'flat'
  1581	      ? 'flat'
  1582	      : 'auto-closed'
  1583	  );
  1584	
  1585	  /** Durable stopa „za živého ARM existují kopie" — podklad boot recovery. */
  1586	  const syncLiveCopyExposureFlag = async (reason: 'update' | 'clear') => {
  1587	    // Čtení i rozhodnutí musí proběhnout až uvnitř serial processoru. Kdyby
  1588	    // clear četl stav před zařazením, mohl by minout právě commitovaný update
  1589	    // a po clean shutdownu nechat stale boot-recovery marker.
  1590	    await processor.mutate(async current => {
  1591	      const stored = current.state.safety.liveCopyOpenSince;
  1592	      let safety: CopierRuntime['state']['safety'];
  1593	      if (reason === 'clear' || groupIsFlat()) {
  1594	        if (stored == null) return current;
  1595	        const { liveCopyOpenSince: _cleared, ...rest } = current.state.safety;
  1596	        safety = rest;
  1597	      } else {
  1598	        if (stored != null) return current;
  1599	        if (!(gate.armed && !gate.shadowMode && hasFollowerExposure())) return current;
  1600	        safety = { ...current.state.safety, liveCopyOpenSince: clock() };
  1601	      }
  1602	      const state = { ...current.state, safety };
  1603	      const committed = await options.store.commit(
  1604	        toSnapshot(
  1605	          state,
  1606	          current.outbox.values(),
  1607	          current.cancelOutbox.values(),
  1608	          current.revision,
  1609	          current.bracketOutbox.values(),
  1610	          current.osoOutbox.values(),
  1611	        ),
  1612	        current.revision,
  1613	      );
  1614	      return { ...current, state, revision: committed.revision };
  1615	    });
  2250	      const copiedExit = epoch.leaderExitOrderIds.includes(entry.leaderOrderId);
  2251	      if (!guardLiquidation && !copiedExit) continue;
  2252	      const brokerOrder = entry.brokerOrderId ? orderById.get(entry.brokerOrderId) : undefined;
  2253	      const status = entry.status === 'sending' || entry.status === 'unknown'
  2254	        ? entry.status
  2255	        : brokerOrder?.status;
  2256	      if (!status || status === 'canceled' || status === 'rejected') continue;
  2257	      evidence.push({
  2258	        accountId,
  2259	        symbol: epoch.symbol,
  2260	        role: guardLiquidation ? 'guard-liquidation' : 'copied-exit',
  2261	        status,
  2262	        ...(guardLiquidation ? { epochId: epoch.id } : {}),
  2263	        ...(copiedExit ? { leaderOrderId: entry.leaderOrderId } : {}),
  2264	        ...(entry.brokerOrderId ? { brokerOrderId: entry.brokerOrderId } : {}),
  2265	        updatedAt: brokerOrder?.updatedAt ?? entry.updatedAt,
  2266	      });
  2267	    }
  2268	    const protectiveIds = new Set<string>();
  2269	    for (const entry of [...currentRuntime().osoOutbox.values(), ...currentRuntime().bracketOutbox.values()]) {
  2270	      if (entry.request.accountId !== accountId || entry.request.symbol !== epoch.symbol) continue;
  2271	      for (const id of [entry.firstBrokerOrderId, entry.secondBrokerOrderId]) {
  2272	        if (id) protectiveIds.add(id);
  2273	      }
  2274	    }
  2275	    for (const order of orders) {
  2276	      if (!protectiveIds.has(order.brokerOrderId) || order.symbol !== epoch.symbol) continue;
  2277	      evidence.push({
  2278	        accountId,
  2279	        symbol: epoch.symbol,
  2280	        role: 'protective',
  2281	        status: order.status,
  2282	        brokerOrderId: order.brokerOrderId,
  2283	        updatedAt: order.updatedAt,
  2284	      });
  2285	    }
  2286	    return evidence;
  2287	  };
  2288	
  2289	  async function verifyLeaderFlatEpoch(
  2290	    token: LeaderFlatGuardToken,
  2291	    expectedSafetyGeneration: number,
  2292	  ): Promise<void> {
  2293	    if (stopped) return;
  2294	    const storedEpoch = currentRuntime().state.safety.leaderExposureEpochs
  2295	      ?.find(item => item.id === token.epochId) ?? null;
  2296	    const epoch = storedEpoch
  2297	      && storedEpoch.groupId === group.id
  2298	      && storedEpoch.leaderAccountId === group.leaderAccountId
  2299	      ? storedEpoch
  2300	      : null;
  2301	    if (
  2302	      !isLeaderFlatGuardTokenCurrent(epoch, token)
  2303	      || safetyGeneration !== expectedSafetyGeneration
  2304	      || !gate.connected
  2305	    ) return;
  2306	
  2307	    const accountIds = [...new Set([
  2308	      epoch.leaderAccountId,
  2309	      ...epoch.followers.map(follower => follower.accountId),
  2310	    ])];
  2311	    const rows = await Promise.all(accountIds.map(async accountId => {
  2312	      try {
  2313	        const [positions, orders] = await Promise.all([
  2314	          broker.listPositions(accountId),
  2315	          broker.listOrders(accountId),
  2316	        ]);
  2317	        return { accountId, ok: true as const, positions, orders };
  2318	      } catch (reason) {
  2319	        return { accountId, ok: false as const, error: errorOf(reason).message };
  2320	      }
  2321	    }));
  2322	
  2323	    const current = leaderExposureEpoch(epoch.symbol);
  2324	    if (
  2325	      !isLeaderFlatGuardTokenCurrent(current, token)
  2326	      || safetyGeneration !== expectedSafetyGeneration
  2327	      || !gate.connected
  2328	    ) return;
  2329	
  2330	    // Cache aktualizujeme až po ověření tokenu; pozdní snapshot staré epochy
  2331	    // nesmí přepsat novější obchod ani autorizovat jeho zavření.
  2332	    for (const row of rows) {
  2333	      if (!row.ok) continue;
  2334	      const map = positionsByAccount.get(row.accountId) ?? new Map<string, number>();
  2335	      for (const position of row.positions) map.set(position.symbol, position.netQuantity);
  2336	      positionsByAccount.set(row.accountId, map);
  2337	      if (row.accountId === epoch.leaderAccountId) {
  2338	        const leaderNet = row.positions
  2339	          .filter(position => position.symbol === epoch.symbol)
  2340	          .reduce((sum, position) => sum + position.netQuantity, 0);
  2341	        leaderPositions.set(epoch.symbol, leaderNet);
  2342	      }
  2343	    }
  2344	
  2345	    const batchAccounts: LeaderFlatAccountBatchSnapshot[] = rows.map(row => row.ok
  2346	      ? {
  2347	        accountId: row.accountId,
  2348	        ok: true,
  2349	        positions: row.positions.map(position => ({
  2350	          symbol: position.symbol,
  2351	          netQuantity: position.netQuantity,
  2352	        })),
  2353	        exitEvidence: leaderFlatExitEvidence(epoch, row.accountId, row.orders),
  2354	      }
  2355	      : { accountId: row.accountId, ok: false, error: row.error });
  2356	    const evaluation = evaluateLeaderFlatBatch({
  2357	      epoch,
  2358	      snapshot: { observedAt: clock(), accounts: batchAccounts },
  2359	      autoCloseFollowerPositions: (
  2360	        group.safety?.autoCloseFollowerPositions
  2361	        ?? DEFAULT_COPY_GROUP_SAFETY.autoCloseFollowerPositions
  2362	      ) && !gate.killSwitch,
  2363	      exitSettlementGraceMs: leaderFlatExitSettlementGraceMs,
  2364	      inflightRetryMs: leaderFlatInflightRetryMs,
  2365	    });
  2366	    await persistLeaderExposureEpoch(evaluation.epoch);
  2367	
  2368	    if (evaluation.kind === 'resolved') {
  2369	      options.onAudit?.([{
  2370	        at: clock(), leaderEventId: `leader-flat:${epoch.id}`, kind: 'recovered',
  2371	        reason: 'leader-flat guard: leader i všichni účastníci jsou autoritativně flat',
  2372	      }]);
  2373	      await syncLiveCopyExposureFlag('clear');
  2374	      await resolveRejectedExecutions({
  2375	        accountIds: epoch.followers.map(follower => follower.accountId),
  2376	        kind: 'follower-flat',
  2377	        at: clock(),
  2378	        symbol: epoch.symbol,
  2379	        detail: 'leader-flat guard autoritativně potvrdil followera flat',
  2380	      });
  2381	      return;
  2382	    }
  2383	
  2384	    if (evaluation.kind === 'wait-inflight') {
  2385	      const afterGrace = evaluation.waitingInflightAccountIds.length > 0
  2386	        || evaluation.divergentAccountIds.length > 0;
  2387	      if (afterGrace) {
  2388	        gate = {
  2389	          ...gate,
  2390	          divergentAccounts: new Set([
  2391	            ...gate.divergentAccounts,
  2392	            ...evaluation.divergentAccountIds,
  2393	            ...evaluation.blockedAccountIds,
  2394	          ]),
  2395	        };
  2396	        failClosed(new Error(
  2397	          `Copier fail-closed: leader je flat, follower exit stále čeká (${evaluation.reason})`,
  2398	        ), { autoClose: false });
  2399	      }
  2400	      scheduleLeaderFlatEpochVerification(
  2401	        evaluation.epoch,
  2402	        { epochId: evaluation.epoch.id, generation: evaluation.epoch.generation },
  2403	        safetyGeneration,
  2404	      );
  2405	      return;
  2406	    }
  2407	
  2408	    const affected = [
  2409	      ...evaluation.divergentAccountIds,
  2410	      ...evaluation.blockedAccountIds,
  2411	    ];
  2412	    gate = {
  2413	      ...gate,
  2414	      divergentAccounts: new Set([...gate.divergentAccounts, ...affected]),
  2415	    };
  2416	    failClosed(new Error(
  2417	      `Copier fail-closed: leader je autoritativně flat, follower stav se neshoduje (${evaluation.reason})`,
  2418	    ), { autoClose: false });
  2419	    const leaderFlatDisarmAt = lastDisarm?.code === 'leader-flat-follower-open'
  2420	      || lastDisarm?.trigger === 'transport'
  2421	      ? lastDisarm.at
  2422	      : undefined;
  2423	
  2424	    if (evaluation.kind !== 'close-targets') return;
  2425	    const closeSafetyGeneration = safetyGeneration;
  2426	    const closeToken = {
  2427	      epochId: evaluation.epoch.id,
  2428	      generation: evaluation.epoch.generation,
  2429	    };
  2430	    if (
  2431	      !isLeaderFlatGuardTokenCurrent(leaderExposureEpoch(epoch.symbol), closeToken)
  2432	      || closeSafetyGeneration !== safetyGeneration
  2433	      || gate.killSwitch
  2434	      || !gate.connected
  2435	    ) return;
  2436	
  2437	    let closeResult: ManualFlattenResult | null = null;
  2438	    try {
  2439	      await processor.mutate(async runtimeBeforeClose => {
  2440	        // Poslední fencing kontrola bezprostředně před durable write-ahead a
  2441	        // případným POSTem. Novější epocha ani safety incident nesmí proklouznout.
  2442	        if (
  2443	          !isLeaderFlatGuardTokenCurrent(leaderExposureEpoch(epoch.symbol), closeToken)
  2444	          || safetyGeneration !== closeSafetyGeneration
  2445	        ) return runtimeBeforeClose;
  2446	        const processed = await processTargetedLiquidation({
  2447	          runtime: runtimeBeforeClose,
  2448	          broker,
  2449	          store: options.store,
  2450	          groupId: group.id,
  2451	          targets: evaluation.targets,
  2452	          operationId: `leader-flat:${epoch.id}`,
  2453	          clock,
  2454	          confirmationAttempts: options.flattenConfirmationAttempts,
  2455	          confirmationPollMs: options.flattenConfirmationPollMs,
  2456	          accountConcurrency: options.flattenAccountConcurrency,
  2457	          wait: options.wait,
  2458	        });
  2459	        closeResult = processed.result;
  2460	        return processed.runtime;
  2461	      });
  2462	    } catch (reason) {
  2463	      failClosed(new Error(
  2464	        `Leader-flat cílené zavření selhalo: ${errorOf(reason).message}`,
  2465	      ), { autoClose: false });
  2466	      return;
  2467	    }
  2468	
  2469	    const result = closeResult as ManualFlattenResult | null;
  2470	    const finalEpoch = leaderExposureEpoch(epoch.symbol);
  2471	    if (
  2472	      !result
  2473	      || !result.flat
  2474	      || !finalEpoch
  2475	      || !isLeaderFlatGuardTokenCurrent(finalEpoch, closeToken)
  2476	    ) {
  2477	      failClosed(new Error('Leader-flat cílené zavření není autoritativně potvrzené'), {
  2478	        autoClose: false,
  2479	      });
  2480	      return;
  2481	    }
  2482	    const fullyResolved = evaluation.blockedAccountIds.length === 0
  2483	      && evaluation.detectOnlyAccountIds.length === 0
  2484	      && evaluation.waitingInflightAccountIds.length === 0;
  2485	    await persistLeaderExposureEpoch({
  2486	      ...finalEpoch,
  2487	      generation: finalEpoch.generation + 1,
  2488	      phase: fullyResolved ? 'resolved' : 'blocked',
  2489	      terminalAt: clock(),
  2490	      terminalReason: fullyResolved
  2491	        ? 'orphan kopie byly stavově zploštěny; explicitní reconciliation je stále povinná'
  2492	        : 'bezpečně vlastněné orphan kopie byly zploštěny, ale část batch snapshotu zůstala neověřená nebo detect-only',
  2493	    });
  2494	    if (fullyResolved) await syncLiveCopyExposureFlag('clear');
  2495	    options.onAudit?.([{
  2496	      at: clock(), leaderEventId: `leader-flat:${epoch.id}`,
  2497	      kind: fullyResolved ? 'recovered' : 'blocked',
  2498	      reason: fullyResolved
  2499	        ? `leader-flat guard cíleně zploštil ${evaluation.targets.length} account/symbol expozic; runtime zůstává DISARMED`
  2500	        : `leader-flat guard zploštil ${evaluation.targets.length} bezpečně vlastněných expozic, ale neověřený zbytek vyžaduje ruční reconciliation`,
  2501	    }]);
  2502	    await resolveRejectedExecutions({
  2503	      accountIds: evaluation.targets.map(target => target.accountId),
  2504	      kind: 'guard-flattened',
  2505	      at: clock(),
  2506	      symbol: epoch.symbol,
  2507	      detail: 'leader-flat guard cíleně zploštil kopii a potvrdil flat stav',
  2508	    });
  2509	    updateDisarmOutcome(leaderFlatDisarmAt, 'guard-flattened');
  2510	  }
  2511	
  2512	  /**
  2513	   * Risk-redukující zavření kopií — jediná automatická broker akce copieru.
  2514	   * Ruší working příkazy a zavírá pozice k nule; nikdy nezvětší |pozici|
  2515	   * ani neotočí směr (planFlatten). Spouští ji expirace ARM a fail-closed
  2516	   * za živého ARM. Bez lokálně známé expozice se nic neposílá — výpadek na
  2517	   * hranici session nesmí vyrábět falešné FAIL-CLOSED poplachy z flattenu
  2518	   * naprázdno (working day-orders ruší burza sama).
  2519	   */
  2520	  const autoFlattenCopies = async (
  2521	    trigger: CopierAutoClose['trigger'],
  2522	    seed: number,
  2523	  ): Promise<boolean> => {
  2524	    const scope = group.safety?.armExpiryFlatten ?? DEFAULT_COPY_GROUP_SAFETY.armExpiryFlatten;
  2525	    if (scope === 'off' || group.leaderAccountId == null || gate.killSwitch) return false;
  2526	    const accountIds = scope === 'group'
  2527	      ? [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]
  2528	      : group.followers.map(follower => follower.accountId);
  2529	    const hasExposure = accountIds.some(accountId =>
  2530	      [...(positionsByAccount.get(accountId)?.values() ?? [])].some(quantity => quantity !== 0));
  2531	    // Nulová lokální expozice nevyžaduje broker side effect; následující
  2532	    // reconciliation je právě autoritativní důkaz, že stav zůstal flat.
  2533	    if (!hasExposure) return true;
  2534	    if (autoCloseEpisodeAttempts >= AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE) {
  2535	      options.onAudit?.([{
  2536	        at: clock(), leaderEventId: `auto-close-limit:${trigger}:${seed}`, kind: 'blocked',
  2537	        reason: `auto-close vyčerpal ${AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE} pokusů v epizodě — nutný ruční zásah`,
  2538	      }]);
  2539	      return false;
  2540	    }
  2541	    autoCloseEpisodeAttempts += 1;
  2542	    const operationId = `auto-close:${trigger}:${seed}`;
  2543	    const at = clock();
  2544	    try {
  2545	      const result = await flatten(accountIds, operationId);
  2546	      lastAutoClose = {
  2547	        at, operationId, trigger, scope, accountIds, flat: result.flat,
  2548	        canceledOrders: result.canceledOrders, submittedClosures: result.submittedClosures,
  2549	      };
  2550	      options.onAudit?.([{
  2551	        at: clock(), leaderEventId: operationId, kind: 'blocked',
  2552	        reason: `auto-close (${trigger}, ${scope}): zrušeno ${result.canceledOrders} příkazů, zavřeno ${result.submittedClosures} pozic`,
  2553	      }]);
  2554	      if (result.flat) {
  2555	        autoCloseEpisodeAttempts = 0;
  2556	        await syncLiveCopyExposureFlag('clear');
  2557	        await resolveRejectedExecutions({
  2558	          accountIds: group.followers
  2559	            .map(follower => follower.accountId)
  2560	            .filter(accountId => accountIds.includes(accountId)),
  2561	          kind: 'auto-closed',
  2562	          at: clock(),
  2563	          detail: `auto-close (${trigger}) autoritativně potvrdil followera flat`,
  2564	        });
  2565	      }
  2566	      return result.flat;
  2567	    } catch (error) {
  2568	      lastAutoClose = {
  2569	        at, operationId, trigger, scope, accountIds, flat: false,
  2570	        canceledOrders: 0, submittedClosures: 0, error: errorOf(error).message,
  2571	      };
  2572	      failClosed(new Error(`Auto-close kopií (${trigger}) selhal: ${errorOf(error).message}`));
  2573	      return false;
  2574	    }
  2575	  };
  2576	
  2577	  /**
  2578	   * Obnoví durable leader-flat epochy po autoritativním snapshotu. Tato
  2579	   * funkce pouze plánuje stejný symbolově cílený guard; sama neposílá broker
  2580	   * write. Legacy/restart expozice bez opening ownership zůstává detect-only.
  2581	   */
  2582	  const resumeLeaderFlatEpochsAfterSnapshot = async (): Promise<Set<string>> => {
  2583	    const leaderAccountId = group.leaderAccountId;
  2584	    if (leaderAccountId == null) return new Set();
  2585	    const matching = currentRuntime().state.safety.leaderExposureEpochs?.filter(epoch => (
  2586	      epoch.groupId === group.id && epoch.leaderAccountId === leaderAccountId
  2587	    )) ?? [];
  2588	    const latestBySymbol = new Map<string, LeaderFlatEpoch>();
  2589	    for (const epoch of matching) latestBySymbol.set(epoch.symbol, epoch);
  2590	
  2591	    const guardedSymbols = new Set<string>();
  2592	    for (const epoch of latestBySymbol.values()) {
  2593	      const leaderNet = positionsByAccount.get(leaderAccountId)?.get(epoch.symbol) ?? 0;
  2594	      if (epoch.phase === 'open') {
  2595	        if (leaderNet === 0) {
  2596	          const observedAt = clock();
  2597	          const plan = planLeaderPositionTransition({
  2598	            epoch,
  2599	            previousKnown: true,
  2600	            previousNet: epoch.lastLeaderNet,
  2601	            nextNet: 0,
  2602	            observedAt,
  2603	            graceMs: leaderFlatGraceMs,
  2604	            nextEpochId: globalThis.crypto.randomUUID(),
  2605	            groupId: group.id,
  2606	            leaderAccountId,
  2607	            symbol: epoch.symbol,
  2608	            // Ownership pochází výhradně z opening epochy; reconnect ji
  2609	            // nesmí rozšířit odhadem z právě nalezené pozice.
  2610	            followersAtOpen: epoch.followers,

exec
/bin/zsh -lc "rg -ni -C 6 \"stale|resolver|routing revision|routing refresh|updateGroup|eventTail|optional-skip|partial snapshot|generation fence|safetyGeneration|ownership|missing follower|chybějící follower|přenesen\" docs/PROJECT_LOG.md | sed -n '1,900p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
59-- [ ] **Automatická post-connect recovery selže, když follower chybí v OAuth**
60-      (3. 9. 05:45:24 UTC, worker 03d1fc5f): po startu s breached `63338752`, který
61-      už není v žádném OAuth adresáři, skončila recovery vlna „nepodařilo se
62-      ověřit stav účtů“ bez auditního důvodu, zatímco ruční `reconcile` z CLI
63-      (routing předá optional skip) prošel. Podezření: `runConnectionRecovery`
64-      volá reconciliation bez `missingOptionalAccountIds`, takže nezpůsobilý
65:      chybějící follower je „missing required“. Fix: recovery má použít stejný
66:      optional-skip vstup jako CLI/UI cesta a při selhání zapsat audit s důvodem.
67-      Delegovat Codexu s regresí.
68-- [x] **Násobek 2× „sám“ přeskočil na funded účet při změně leadera** —
69-      VYŘEŠENO lokálně 3. 9. (zápis níže; změna zatím není commitnutá ani
70-      nasazená). Původní incident (2. 9.,
71-      15:25–15:34 UTC): `changeCopyGroupLeader` dává předchozímu leaderovi
72-      `{...promotedFollower, accountId: previousLeader}`, tedy zdědí násobek
--
212-
213-- Implementována závazná matice §11 nad výstupem stávajícího freshness reduceru:
214-  čistý `CompanionTransitionDetector` vrací zhoršení, zlepšení nebo změnu režimu
215-  s cílovou sekcí/řádkem a bezpečným důvodem bez účtů a P&L. Store přidává
216-  třísekundové ustálení, nejvýše jedno povolené auto-otevření za 30 sekund,
217-  odmítnutí nižší revize a potlačení startu, wake a ručního refreshu. Zlepšení
218:  vzniká jen z ověřeně čerstvé prezentace, nikdy ze stale/UNKNOWN mostu.
219-- Popover se otevírá přes `NSPopover.show` bez aktivace aplikace a zůstává
220-  `.transient`; zhoršení má 60s timer, toast 8s, hover timer pozastaví. Při už
221-  otevřeném ručním popoveru se pouze aktualizuje obsah. Rozbalí se jen cílová
222-  sekce, řádek se zvýrazní na 1,2 s a pill třikrát pulzuje; Reduce Motion pohyb
223-  i dočasný highlight vypne. Ozubené kolo ukládá čtyři přepínače do
224-  `UserDefaults` s defaulty dle specifikace.
--
247-rozpracovaný lifecycle: connection recovery“) ani zapnout ARM („Follower účet
248-… není dostupný“). Příčina: recovery vlna po startu routovala i follower, který
249-už není v žádném OAuth adresáři, router hodil chybu, po pěti pokusech
250-fail-closed a `pendingConnectionRecovery` zůstal zapnutý (záměr z I), přičemž
251-ruční Kontrola pozic ho neshazovala. Oprava (Claude, copier core, Codex
252-cross-review vyžádán): recovery dostává přes `resolveMissingOptionalAccountIds`
253:stejný optional-skip jako CLI/UI, a autoritativně čistá ruční Kontrola pozic
254-příznak shodí; divergentní/neúspěšná ne. Regrese
255-`tests/copierConnectionRecoveryOptionalFollower.test.ts` (router bez route).
256-Celá sada 1866/1866, tsc čistý. Worker reinstalován ze `5154856d` (bundle
257-`6bfcf2df0960de08…`, start 06:56:51 UTC, DISARMED), post-restart reconcile
258-čistý.
259-
--
324-`pendingConnectionRecovery`, takže další `connected:true` event spustí novou
325-vlnu. Order/fill cesty, `emitOrHoldError`, reconnect reconciliation i zákaz
326-automatického ARM zůstaly beze změny.
327-
328-Deterministické regrese kryjí visící CONNECTING, chybějící `onclose`, factory
329-throw, tři chyby tokenu a čtvrtý úspěch, backoff strop/reset/rate minimum,
330:pětiminutové souhrny, stale-token rezervu, opožděný starý callback, unsubscribe
331-a druhou controller recovery vlnu. Finální sada prošla 222/222 souborů a
332-1831/1831 testů, strict TypeScript bez výstupu, produkční Vite/PWA build,
333-cílený ESLint a `git diff --check`. Nic nebylo commitnuto, pushnuto,
334-deploynuto ani spuštěno na workeru/brokeru; neproběhl ARM, DISARM ani Flatten.
335-
336-### 2026-09-03 (Claude + uživatel, návrh auto-otevření companionu při změně stavu)
--
345-nativní notifikace pro fullscreen; čtyři přepínače v nastavení. Bez
346-ovládání copieru, bez nových endpointů. Nic neimplementováno.
347-### 2026-09-03 (Codex, násobek followera už nepřeskakuje mezi účty)
348-
349-Změna leadera nyní vždy vrátí dostupného předchozího leadera jako followera
350-`1×`, `on-submit`, bez `maxContracts`; nastavení povýšeného followera zanikne
351:s jeho rolí. Ruční náhrada stale follower účtu zachová režim, ale násobek a
352-`maxContracts` záměrně resetuje na bezpečné výchozí hodnoty a UI to viditelně
353-oznámí. Potvrzovací variantu jsme nezvolili, protože účetní risk parametry
354-nemají jedním rutinním kliknutím přecházet na jinou identitu; uživatel je může
355-novému účtu znovu nastavit ručně.
356-
357-Poslední krok editoru před uložením vždy vykreslí diff proti uložené skupině:
--
491-což druhý obchod potvrdil. Kosmetika k pozdějšímu řešení: exit leadera přes
492-vlastní stop, jehož order event dorazil po fillu, se v denním přehledu
493-klasifikoval jako `manual`.
494-
495-### 2026-09-02 (Claude, nasazení opravy 56f36ebf)
496-
497:Oprava „známý nezpůsobilý follower = skip, ne fail-closed“ byla přenesena
498-z lokálního checkoutu na čistý worktree nad `origin/main` a pushnuta jako
499-`56f36ebf` (fast-forward `main`); Vercel produkce READY. Důvod přenosu: hlavní
500-checkout `Documents/trading-journal-aka` je 26 commitů za `origin/main`
501-a jeho pracovní strom by commit vrátil dnešní dřívější opravy
502-(`missingOptionalAccountIds`, `beginShutdown`, OAuth preflight). Při přenosu
503-se to projevilo zastaralým hunkem v `copierAccountEligibility.test.ts`, který
--
598-`reconciliationRequired=false`, `lastError=null`, snímky `ready`.
599-Skupina zůstává DISARMED; DLL zámek LFE…016 vypršel s novou session
600-(autoritativně reaktivován 06:52 UTC), trvá jen BREACH 62364058.
601-
602-### 2026-09-02 (Codex, bezpečné odebrání followera zmizelého z OAuth)
603-
604:Routing refresh má místo seznamu s implicitním polykáním chyb explicitní
605-kontrakt `prepareGroupAccounts({ required, optional }) -> { missingOptional }`.
606-Při změně topologie je optional pouze follower, který je ve staré skupině,
607-není v nové a není starý ani nový leader. Všechny OAuth adresáře se vždy
608-obnoví celé: pouze nulová viditelnost optional účtu dovolí route vynechat a
609-pilot zapíše konkrétní `ROUTING OPTIONAL SKIP`; duplicita, inactive/read-only
610-stav nebo chybějící Account.name dál selžou. Leader a každý účet nové
--
615-v OAuth. `reconfigureGroup`/`activateGroup` smí přeskočit pouze takového
616-odebíraného followera bez route. Pokud OAuth starý účet vrátí, controller dál
617-načte capability, pozice i working orders a změnu při expozici nebo příkazu
618-fail-closed odmítne; účet v nové topologii ani leader nelze výjimkou označit.
619-
620-Samostatný reconcile používá leadera jako required a followery jako optional
621:pouze pro OAuth discovery. Chybějící follower bez dosavadního eligibility
622-záznamu se durable označí `unverifiable` s důvodem a zůstane vykázaný v
623-`oauthPreflight.missingAccounts`, zatímco zdravé routované účty projdou
624-autoritativní kontrolou. Tato varianta zachovává existující eligibility
625-mechanismus a dovolí zdravý read-only reconcile, ale nezeslabuje leadera ani
626-účet, který OAuth vrací. `canSafelyRestartLocalCopierAgent` se neměnil; po čisté reconciliaci
627-restart brána projde i s vykázaným missing účtem (ten nemá route a
628-restart nic neobchoduje), `oauthPreflight.missingAccounts` zůstává
629:viditelná diagnostika. ARM/SHADOW jsou pro missing followera dál
630-fail-closed přes strict routing (oprava recenze Claude 2. 9.).
631-
632-Regrese pokrývají odebrání i náhradu zmizelého followera, povinného zmizelého
633-leadera, followera ponechaného v nové topologii, strict preflight viditelného
634-odebíraného účtu a reconcile bez eligibility záznamu. `npm run typecheck`
635-prošel; cíleně 143/143 a celá sada 205 souborů / 1737 testů. Závislosti nebyly
--
895-Keychain, ServiceManagement, ARM nebo Flatten. Odkazy pouze otevírají existující
896-PWA; refresh animuje lokální mock. Diagnostika kopíruje allowlistovaný text bez
897-account aliasů a secretů. V panelu je trvale viditelné označení „FÁZE 1 ·
898-UKÁZKOVÁ DATA“, takže render nelze vydávat za živý stav.
899-
900-**Ověření:** Debug i Release build prošly, celé XCTest schéma prošlo **14/14**.
901:Testy pokrývají všech devět fixtures, stale precedence, flat/ack invariants,
902-bezpečný diagnostický text, URL a light/dark layout; render test vytvořil 18 PNG
903-náhledů (každý stav ve světlém i tmavém režimu). Nesignovaný Debug build byl
904-lokálně spuštěn a zůstal stabilně běžet jako menu-bar-only proces. Neproběhl
905-commit, deploy, podpis, instalace, autostart, síťové volání, broker příkaz, ARM,
906-Flatten ani změna workeru. Fáze 2 a 3 zůstávají HOLD podle otevřené otázky výše.
907-
--
1218-
1219-ENTRY/EXIT textový APNs se při zdravé snapshot pipeline nově na krátkou dobu
1220-odloží. Obrázková větev má absolutní deadline 1,5 s; pokud APNs obrázek přijme,
1221-atomicky posune společný copy-event marker a textový duplikát už nevznikne.
1222-Pokud capture, Storage nebo APNs deadline nestihne, worker v 1,8 s vyvolá
1223-stejným plannerem jedinou textovou zálohu. Server po deadline nový obrázkový
1224:push nezačne a broker dispatch/eventTail na žádnou z těchto větví nečeká.
1225-Zabalená nativní appka už pro ENTRY/EXIT nevyrábí paralelní lokální textovou
1226-notifikaci; ostatní order/risk eventy zůstávají beze změny.
1227-
1228-Součástí stejného release je stabilní vazba `copierEpisodeId`, která doplní
1229-pozdě nahraný ENTRY/EXIT obrázek k existujícímu journal masteru bez duplikace
1230-a bez přepsání reflexe. Worker umí TradingView bezpečně spustit s lokálním CDP,
--
1475-Vercel deployment `dpl_44aJNbLPyPBh8KoRjnLDaqE2eW4F` (`READY`, produkční
1476-alias HTTP 200). Mac worker byl přeinstalován z totožného canonical commitu a
1477-zůstal `DISARMED`/SHADOW; read-only reconciliation potvrdila `groupFlat: true`,
1478-žádné divergentní účty, žádné working orders, žádný stuck outbox a žádný nový
1479-`lastError`. Během deploye a kontroly nebyl odeslán žádný broker příkaz.
1480-
1481:### 2026-08-26 (Codex, stale účet je opravitelný čistě z LIVE UI)
1482-Read-only kontrola všech spárovaných OAuth `/account/list` potvrdila, že
1483-uložený follower `63338592` není účet vracený Tradovate. Lucid OAuth vrací
1484-aktivní účet `63338752` (`LFE05066846490016`). Dynamický router proto správně
1485-selhal nahlas: odstranění statického `connections.json` routingu nemůže udělat
1486-z neplatného účtu platný a AlphaTrade nesmí podobné ID automaticky zaměnit.
1487-
--
1496-Nic se nepáruje automaticky a tento krok neposlal žádný broker příkaz. Změna
1497-je nasazená v produkci v commitu `d7c206a2`: `origin/main` je shodný, Vercel
1498-deployment `dpl_5o3Cvg6ZSNZ197hV47ezoxhzJ7io` je READY a Mac worker byl ze
1499-stejného canonical checkoutu bezpečně reinstalován DISARMED. Ověření:
1500-kompletní sada 1515/1515, `npx tsc --noEmit`, `git diff --check` a produkční
1501-build čisté (pouze existující upozornění na velikost bundlu). Canonical Vite
1502:preview navíc s dočasnou stale fixture vizuálně potvrdil čip `1× nedostupný`,
1503-explicitní řádek i ruční náhradu v editoru; po volbě náhrady staré ID a
1504-varování zmizely při zachování počtu followerů a bez error overlay. Fixture
1505-byla po ověření odstraněna.
1506-
1507-### 2026-08-26 (Codex, dynamický account -> OAuth routing z LIVE UI)
1508-Lokálně je dokončený dynamický account -> OAuth routing, který odstraňuje
1509-nutnost ručně dopisovat platné nově zjištěné účty do connection manifestu.
1510:Pozdější read-only kontrola upřesnila, že konkrétní `63338592` je stale ID;
1511-jeho oprava je popsaná v novějším zápisu výše. `accountIds` v Mac connection manifestu už nejsou autoritou
1512-pro vlastnictví účtu; slouží pouze jako instalační/bootstrap metadata. Worker
1513-si při startu, změně topologie skupiny, aktivaci uloženého profilu, SHADOW i
1514-před každým ARM znovu read-only načte `/account/list` ze všech už spárovaných
1515-OAuth spojení. Z přesné viditelnosti účtu sestaví account -> OAuth mapu a
1516-přepne ji atomicky bez restartu socketů a bez broker order side effectu.
--
1527-
1528-Rozsah je záměrně omezen na účty viditelné v už spárovaných OAuth spojeních.
1529-Přidání úplně nového OAuth spojení stále vyžaduje jeho bezpečné device pairing;
1530-samotné přidání účtu nebo změna skupiny v rámci existujících spojení už žádný
1531-ruční manifest zásah nevyžaduje. Ověření: cílené router/runtime/Tradovate testy
1532-75/75, kompletní sada 1512/1512, `npx tsc --noEmit` a produkční build čisté.
1533:Změna byla commitnutá jako `b842640f` a spolu s navazující opravou stale členů
1534-`d7c206a2` je pushnutá na `origin/main`, nasazená na Vercelu a nainstalovaná do
1535-Mac workeru. Worker po reinstalaci zůstal bezpečně DISARMED.
1536-
1537-### 2026-08-26 (Codex, řízený DEMO důkaz OSO parent cascade)
1538-Commit `dfdc4d9e5cffe71a2ab3835deff5d980323dc6a5` byl ověřen na produkčním
1539-Vercelu i Mac workeru a řízeným Tradovate DEMO testem leadera `62364553` se
--
1678-Connection status a eligibility jsou v UI samostatné vrstvy — odpojení už
1679-neskryje silnější DLL/BREACHED stav ani neztlumí celý řádek.
1680-
1681-Zavedeno výhradní globální členství `accountId`: leader i follower smí patřit
1682-právě do jedné kopírovací skupiny, včetně skupin momentálně disabled. Editor
1683-už obsazený účet označí názvem skupiny a nedovolí jej vybrat; stejný invariant
1684:znovu vynucuje doménová validace při uložení, ARM preflight a runtime resolver.
1685-Starší nebo ručně poškozená konfigurace s duplicitou proto fail-closed —
1686-nemůže způsobit dvojité kopírování.
1687-
1688-Regrese kryjí restart s DLL stavem, reject leadera, nulovou LIVE účast,
1689-oddělení disconnected/eligibility, kolize skupin i fail-closed runtime.
1690-Ověření: 190 test files, 1482/1482 testů, TypeScript typecheck a produkční
--
1955-
1956-### 2026-08-23 (Claude, review mobilní appky — falešné ARM opraveno)
1957-Společná review appky na telefonu (Claude + Codex, dva statické passy
1958-a interaktivní kontrola). Nejcennější třída nálezů: **UI tvrdilo ARM, aniž
1959-mělo čím ověřit stav kopírky.** Všechny tři jsem před opravou potvrdil
1960-čtením kódu, ne jen z hlášení:
1961:1. Live Activity ignorovala `context.isStale` (nula výskytů v 1140 řádcích),
1962:   zatímco server posílá stale-date 180 s. Po pádu workeru nebo APNs zůstalo
1963-   na zamčené obrazovce svítit zelené „ARM LIVE". Nově se přepíše na
1964-   „ARM NEOVĚŘEN" a skryje se odpočet, který nejde ověřit.
1965-2. Kruhový widget odvozoval text z holého `live.armed`, takže vedle varovné
1966:   stale ikony mohl svítit nápis „ARM". Text teď vychází ze stejného
1967-   fail-safe stavu jako ikona (`?`/`STOP`/`LOCK`/`OFF`/`ARM`). Velká
1968-   obdélníková varianta to řešila správně už dřív.
1969-3. Cache broker snapshotu měla klíč jen `user_id:connection_id` a ignorovala
1970-   `allAccounts`; sběrač účtů tak Live Activity podstrčil pozice účtů mimo
1971-   copier skupinu. Klíč nově obsahuje rozsah dotazu.
1972-K tomu datový závod: správa observerů ActivityKit se dělala ze tří kontextů
--
2797-soubory — commit se řeší s uživatelem, worker se nasazuje z lokálního
2798-stromu nezávisle na gitu.
2799-
2800-### 2026-08-20 (Codex, durable copier obchody + WidgetKit refresh bez otevřené appky)
2801-Příčina falešného `DATA ZASTARALÁ` byla potvrzena: WidgetKit četl jen App Group
2802-snapshot, který React obnovoval po minutě pouze za běhu aplikace, a po 120 s ho
2803:označil stale. Současně copier držel poslední position eventy jen v RAM a neměl
2804-spolehlivý per-trade P&L zdroj. Nově worker vždy (i s vypnutými risk limity)
2805-vede durable avg-cost ledger leader fillů, uzavřené obchody posílá idempotentně
2806-v heartbeat a server je ukládá do `tradovate_copier_trades`. Neznámá hodnota
2807-bodu zůstává `null`, nikdy se nevydává za $0. Equity se rekonstruuje pouze pro
2808-leadera; follower fill/slippage se neodhaduje.
2809-
--
2811-ukládá pouze SHA-256 do `native_widget_devices`. `anon` i `authenticated` mají
2812-na obě nové tabulky nulová práva, RLS je zapnuté a CRUD má jen `service_role`.
2813-Endpoint `/api/native-widget-snapshot` načte heartbeat + omezený broker snapshot
2814-a neobsahuje žádnou broker-write cestu. Widget zachová lokální journal, obnovuje
2815-LIVE přes WidgetKit (požadavek 5 min; skutečný budget řídí iOS), při síťové chybě
2816-ponechá poslední dobrá data. Skutečný worker outage je `WORKER OFFLINE` po 90 s;
2817:obecný stale badge až po 30 min bez úspěšné obnovy.
2818-
2819-Migrace `native_widget_remote_refresh` je na produkci jako `20260820105246`.
2820-Finální izolovaný preview `dpl_HPEjF5qxTXfRCUXSX2Xm2etqaecL` prošel
2821-bezpečnostním 401 testem a byl povýšen jako produkční
2822-`dpl_3zs5wVqs9a16mQR4SpUuLBaPh4Rg` (`READY`, hlavní alias). Mac worker byl po
2823-potvrzeném exit→flat, DISARMED a read-only reconciliation přeinstalován z
--
2837-`dpl_HB3dAizW1q6u7cVojTZtrzB3jbYF` (`READY`, hlavní alias). Nejnovější
2838-placeně podepsaný build s retry tokenu a častými ActivityKit aktualizacemi je
2839-na iPhone 13 Pro Max. Telefon zaregistroval skutečný ActivityKit token, cron
2840-odeslal vzdálený payload bez chyby a uživatel potvrdil, že se Live Activity po
2841-serverovém zjištění DISARMED + brokerem potvrzeného flat stavu sama ukončila.
2842-Copier LIVE widget na ploše fyzicky ukazuje reálné `DISARMED`; zbývající Home
2843:widgety, tři Lock Screen widgety, stale/recovery a galerie 22 notifikací ještě
2844-čekají na fyzické potvrzení. Měnící se remote P&L se ověří až při přirozeně
2845-aktivní pozici — test nesmí vyrábět broker obchod.
2846-
2847-### 2026-08-20 (Codex, live widgety a kompletní nativní alert matice)
2848-Widget extension už nepoužívá test data mimo systémovou galerii. Devět Home
2849-Screen a tři Lock Screen widgety čtou token-free user-scoped snapshot z App

exec
/bin/zsh -lc "rg -n \"safetyGeneration|generation|reconcile.*pending|pending.*reconcile|updateGroup.*recovery|connection recovery|resolveMissingOptionalAccountIds|leaderExposureEpoch|liveCopyOpenSince\" tests | sed -n '1,260p' && git diff --check 30a48144"'^ 30a48144' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 2088ms:
git: error: couldn't create cache file '/tmp/xcrun_db-Nyd1DiXx' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-Mlh6xDXF' (errno=Operation not permitted)

exec
/bin/zsh -lc "nl -ba tests/copierConnectionRecoveryOptionalFollower.test.ts | sed -n '1,170p' && nl -ba tests/copierChaosScenarios.test.ts | sed -n '250,435p' && nl -ba tests/copierRuntimeController.test.ts | sed -n '320,440p' && nl -ba tests/copierRuntimeController.test.ts | sed -n '3420,3495p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
     1	import { describe, expect, it } from 'vitest';
     2	import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
     3	import { createBrokerRouter } from '../services/brokerRouter';
     4	import { createMockBroker } from '../services/mockBroker';
     5	import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
     6	import type { CopyGroupConfig } from '../services/liveCopyTrading';
     7	
     8	/**
     9	 * Incident 3. 9. 2026 05:45 UTC: breached follower 63338752 zmizel z OAuth.
    10	 * Automatická post-connect recovery routovala i jeho → router vyhodil chybu →
    11	 * po pěti pokusech fail-closed a `pendingConnectionRecovery` zůstal zapnutý.
    12	 * Ruční Kontrola pozic (s optional skipem) prošla, ale příznak dál blokoval
    13	 * změnu skupiny („rozpracovaný lifecycle: connection recovery“).
    14	 */
    15	
    16	const MISSING = 303;
    17	const group: CopyGroupConfig = {
    18	  id: 'g-recovery', name: 'Recovery', enabled: true, leaderAccountId: 100,
    19	  followers: [
    20	    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    21	    { accountId: 201, mode: 'on-submit', multiplier: 1 },
    22	    { accountId: MISSING, mode: 'on-submit', multiplier: 1 },
    23	  ],
    24	};
    25	const nextGroup: CopyGroupConfig = {
    26	  ...group,
    27	  followers: group.followers.filter(follower => follower.accountId !== MISSING),
    28	};
    29	
    30	const harness = async (options: {
    31	  resolveMissingOptionalAccountIds?: (current: CopyGroupConfig) => Promise<readonly number[]>;
    32	} = {}) => {
    33	  const initial = emptySnapshot();
    34	  initial.safety = {
    35	    entryCooldownUntil: 0,
    36	    dayLockUntil: 0,
    37	    // Durable stopa „za živého ARM existovaly kopie“ → boot recovery po připojení.
    38	    liveCopyOpenSince: 1,
    39	    accountEligibility: [{
    40	      accountId: MISSING, state: 'breached', reason: 'LIVE equity dosáhla drawdown flooru', at: 900,
    41	    }],
    42	  };
    43	  const mock = createMockBroker({
    44	    behavior: () => ({ kind: 'working' }),
    45	    accountCapabilities: [100, 200, 201].map(accountId => ({ accountId, active: true, canTrade: true })),
    46	  });
    47	  // Zmizelý follower nemá route — přesně jako účet, který už není v žádném OAuth.
    48	  const router = createBrokerRouter([{ broker: mock, accountIds: [100, 200, 201] }]);
    49	  const errors: string[] = [];
    50	  const audit: { kind: string; leaderEventId?: string; reason?: string }[] = [];
    51	  const controller = await bootstrapCopierRuntime({
    52	    broker: router,
    53	    store: createMemoryCopierStore(initial),
    54	    group,
    55	    wait: async () => undefined,
    56	    onError: error => errors.push(error.message),
    57	    onAudit: entries => audit.push(...entries.map(entry => ({
    58	      kind: entry.kind, leaderEventId: entry.leaderEventId, reason: entry.reason,
    59	    }))),
    60	    ...options,
    61	  });
    62	  mock.setConnected(true);
    63	  // Connection event doráží přes router asynchronně; recovery se řadí až po něm.
    64	  await settle(controller);
    65	  return { controller, errors, audit, mock };
    66	};
    67	
    68	const settle = async (controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>) => {
    69	  for (let round = 0; round < 3; round += 1) {
    70	    await new Promise<void>(resolve => setTimeout(resolve, 20));
    71	    await controller.waitForIdle();
    72	  }
    73	};
    74	
    75	describe('post-connect recovery a follower chybějící v OAuth', () => {
    76	  it('bez optional-skip zdroje recovery selže s auditovaným důvodem a zůstává pending i po čisté ruční Kontrole pozic', async () => {
    77	    const h = await harness();
    78	    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
    79	    expect(h.audit.some(entry => entry.kind === 'blocked'
    80	      && entry.leaderEventId === 'connection-recovery'
    81	      && entry.reason?.includes('303'))).toBe(true);
    82	    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    83	    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
    84	      .rejects.toThrow('connection recovery');
    85	
    86	    // Ruční Kontrola pozic s optional skipem projde…
    87	    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
    88	      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
    89	    await settle(h.controller);
    90	    // …ale recovery jen znovu spustí; bez optional-skip zdroje vlna opět selže,
    91	    // takže částečný ruční snapshot recovery nikdy sám „nedokončí“.
    92	    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
    93	      .rejects.toThrow('connection recovery');
    94	    h.controller.stop();
    95	  });
    96	
    97	  it('s optional-skip zdrojem recovery projde napoprvé a skupina není blokovaná', async () => {
    98	    const seen: CopyGroupConfig[] = [];
    99	    const h = await harness({
   100	      resolveMissingOptionalAccountIds: async current => {
   101	        seen.push(current);
   102	        return [MISSING, 999_999, current.leaderAccountId];
   103	      },
   104	    });
   105	    expect(seen.length).toBeGreaterThan(0);
   106	    expect(h.errors).toEqual([]);
   107	    expect(h.controller.status()).toMatchObject({
   108	      armed: false, reconciliationRequired: false, lastError: null,
   109	    });
   110	    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
   111	      .resolves.toBeUndefined();
   112	    h.controller.stop();
   113	  });
   114	
   115	  it('když zdroj napoprvé selže, čistá ruční Kontrola pozic spustí novou vlnu, která doběhne celá a odblokuje skupinu', async () => {
   116	    let calls = 0;
   117	    const h = await harness({
   118	      resolveMissingOptionalAccountIds: async () => {
   119	        calls += 1;
   120	        if (calls === 1) throw new Error('OAuth adresář dočasně nedostupný');
   121	        return [MISSING];
   122	      },
   123	    });
   124	    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
   125	    expect(h.audit.some(entry => entry.reason?.includes('optional-skip resolver'))).toBe(true);
   126	    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
   127	      .rejects.toThrow('connection recovery');
   128	
   129	    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
   130	      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
   131	    await settle(h.controller);
   132	    expect(calls).toBeGreaterThanOrEqual(2);
   133	    expect(h.audit.some(entry => entry.kind === 'recovered'
   134	      && entry.leaderEventId === 'connection-recovery')).toBe(true);
   135	    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
   136	    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
   137	      .resolves.toBeUndefined();
   138	    h.controller.stop();
   139	  });
   140	});
   250	    broker.emitEvent({ type: 'order', order: leaderOrder() });
   251	    await controller.waitForIdle();
   252	
   253	    expect(controller.status().armed).toBe(false);
   254	    expect(controller.status().autoClose).toBeNull();
   255	    controller.stop();
   256	  });
   257	});
   258	
   259	describe('connection recovery podle stavu (výpadek spojení / pád Macu)', () => {
   260	  const recoveryGroup: CopyGroupConfig = {
   261	    ...group,
   262	    safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'followers' },
   263	  };
   264	
   265	  const openCopy = async (broker: ReturnType<typeof createMockBroker>, controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>) => {
   266	    broker.setConnected(true);
   267	    await controller.waitForIdle();
   268	    await controller.reconcile();
   269	    controller.arm();
   270	    broker.emitEvent({ type: 'order', order: leaderOrder() });
   271	    await controller.waitForIdle();
   272	    expect(broker.placedRequests().filter(request => request.accountId === 200)).toHaveLength(1);
   273	  };
   274	
   275	  it('synchronní kopie po reconnectu DRŽÍ DISARMED a nový ARM do flat odmítne', async () => {
   276	    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
   277	    const store = createMemoryCopierStore();
   278	    const controller = await bootstrapCopierRuntime({
   279	      broker, store, group: recoveryGroup, clock: stepClock(), osoCorrelationWindowMs: 5,
   280	    });
   281	    await openCopy(broker, controller);
   282	    // Leader má u brokera stejnou pozici jako kopie (2 kontrakty).
   283	    await broker.placeOrder({
   284	      tag: 'seed-leader', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
   285	    });
   286	    const placedBefore = broker.placedRequests().length;
   287	
   288	    broker.setConnected(false);
   289	    await controller.waitForIdle();
   290	    broker.setConnected(true);
   291	    await controller.waitForIdle();
   292	
   293	    const status = controller.status();
   294	    expect(broker.placedRequests()).toHaveLength(placedBefore);
   295	    expect(status.resumeOffer).toBeNull();
   296	    expect(status.autoClose).toBeNull();
   297	    expect(status.armed).toBe(false);
   298	    expect(() => controller.arm()).toThrow('všechny zapojené účty flat');
   299	    expect(broker.placedRequests()).toHaveLength(placedBefore);
   300	    controller.stop();
   301	  });
   302	
   303	  it('armExpiryFlatten off stále provede povinnou read-only reconciliation po reconnectu', async () => {
   304	    const audit = vi.fn();
   305	    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
   306	    const controller = await bootstrapCopierRuntime({
   307	      broker,
   308	      store: createMemoryCopierStore(),
   309	      group: {
   310	        ...recoveryGroup,
   311	        safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'off' },
   312	      },
   313	      clock: stepClock(),
   314	      osoCorrelationWindowMs: 5,
   315	      onAudit: audit,
   316	    });
   317	    await openCopy(broker, controller);
   318	    await broker.placeOrder({
   319	      tag: 'seed-leader-off', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
   320	    });
   321	    const placedBefore = broker.placedRequests().length;
   322	
   323	    broker.setConnected(false);
   324	    await controller.waitForIdle();
   325	    broker.setConnected(true);
   326	    await controller.waitForIdle();
   327	
   328	    const audits = audit.mock.calls.flatMap(call => call[0] as CopierAuditEntry[]);
   329	    expect(audits.some(item => (
   330	      item.leaderEventId === 'connection-recovery'
   331	      && item.reason?.includes('synchronní s leaderem')
   332	    ))).toBe(true);
   333	    expect(controller.status()).toMatchObject({ armed: false, autoClose: null });
   334	    expect(broker.placedRequests()).toHaveLength(placedBefore);
   335	    controller.stop();
   336	  });
   337	
   338	  it('orphan bez durable opening epochy je po reconnectu detect-only bez broker write', async () => {
   339	    const audit = vi.fn();
   340	    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
   341	    const controller = await bootstrapCopierRuntime({
   342	      broker, store: createMemoryCopierStore(), group: recoveryGroup, clock: stepClock(), osoCorrelationWindowMs: 5,
   343	      onAudit: audit,
   344	    });
   345	    await openCopy(broker, controller);
   346	    const placedBefore = broker.placedRequests().length;
   347	
   348	    broker.setConnected(false);
   349	    await controller.waitForIdle();
   350	    broker.setConnected(true);
   351	    await controller.waitForIdle();
   352	
   353	    const status = controller.status();
   354	    expect(status).toMatchObject({
   355	      armed: false,
   356	      autoClose: null,
   357	      reconciliationRequired: true,
   358	      divergentAccounts: [200],
   359	    });
   360	    expect(status.lastError).toContain('bez opening ownership se automaticky nezavírá');
   361	    expect(status.resumeOffer).toBeNull();
   362	    expect(broker.placedRequests()).toHaveLength(placedBefore);
   363	    expect(broker.liquidateRequests()).toEqual([]);
   364	    const audits = audit.mock.calls.flatMap(call => call[0] as CopierAuditEntry[]);
   365	    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({
   366	      leaderEventId: 'connection-recovery',
   367	      kind: 'blocked',
   368	      reason: expect.stringContaining('žádný broker write'),
   369	    })]));
   370	    controller.stop();
   371	  });
   372	
   373	  it('boot s liveCopyOpenSince bez epochy orphan pouze detekuje a durable stopu zachová', async () => {
   374	    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
   375	    // Kopie existuje u brokera, leader je flat — worker mezitím ležel.
   376	    await broker.placeOrder({
   377	      tag: 'seed-follower', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
   378	    });
   379	    const store = createMemoryCopierStore({
   380	      ...emptySnapshot(),
   381	      safety: { entryCooldownUntil: 0, dayLockUntil: 0, liveCopyOpenSince: 50 },
   382	    });
   383	    const placedBefore = broker.placedRequests().length;
   384	    const controller = await bootstrapCopierRuntime({
   385	      broker, store, group: recoveryGroup, clock: stepClock(),
   386	    });
   387	    broker.setConnected(true);
   388	    await controller.waitForIdle();
   389	
   390	    const status = controller.status();
   391	    expect(status).toMatchObject({
   392	      armed: false,
   393	      autoClose: null,
   394	      reconciliationRequired: true,
   395	      divergentAccounts: [200],
   396	    });
   397	    expect(status.lastError).toContain('bez opening ownership se automaticky nezavírá');
   398	    expect(broker.placedRequests()).toHaveLength(placedBefore);
   399	    expect(broker.liquidateRequests()).toEqual([]);
   400	    expect((await store.load()).safety?.liveCopyOpenSince).toBe(50);
   401	    controller.stop();
   402	  });
   403	
   404	  it('ruční DISARM smaže durable stopu — boot recovery držené pozice nezavírá', async () => {
   405	    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
   406	    const store = createMemoryCopierStore();
   407	    const first = await bootstrapCopierRuntime({
   408	      broker, store, group: recoveryGroup, clock: stepClock(), osoCorrelationWindowMs: 5,
   409	    });
   410	    await openCopy(broker, first);
   411	    expect((await store.load()).safety?.liveCopyOpenSince).toBeDefined();
   412	
   413	    first.disarm();
   414	    await first.waitForIdle();
   415	    await new Promise(resolve => setTimeout(resolve, 20));
   416	    expect((await store.load()).safety?.liveCopyOpenSince).toBeUndefined();
   417	    first.stop();
   418	
   419	    const placedBefore = broker.placedRequests().length;
   420	    const restarted = await bootstrapCopierRuntime({
   421	      broker, store, group: recoveryGroup, clock: stepClock(),
   422	    });
   423	    broker.setConnected(true);
   424	    await restarted.waitForIdle();
   425	    expect(broker.placedRequests()).toHaveLength(placedBefore);
   426	    expect(restarted.status().autoClose).toBeNull();
   427	    restarted.stop();
   428	  });
   429	});
   430	
   431	describe('chaos: agresivní scalp', () => {
   432	  it('4 rychlé vstupy a okamžitý flat zůstanou bez falešného fail-closed i při opožděných follower fillech', async () => {
   433	    vi.useFakeTimers();
   434	    vi.setSystemTime(new Date('2026-08-24T14:00:00.000Z'));
   435	    let controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>> | undefined;
   320	
   321	  it('shutdown gate blokuje pozdní ARM bez zahození graceful runtime drainu', async () => {
   322	    const broker = createMockBroker();
   323	    const controller = await bootstrapCopierRuntime({
   324	      broker,
   325	      store: createMemoryCopierStore(),
   326	      group,
   327	    });
   328	    broker.setConnected(true);
   329	    await controller.waitForIdle();
   330	    await controller.reconcile();
   331	    controller.arm({ shadowMode: true });
   332	
   333	    await controller.beginShutdown();
   334	    expect(controller.status()).toMatchObject({ started: true, armed: false });
   335	    expect(() => controller.arm({ shadowMode: true })).toThrow('bezpečně ukončuje');
   336	    await expect(controller.waitForIdle()).resolves.toBeUndefined();
   337	    controller.stop();
   338	  });
   339	
   340	  it('shutdown i waitForIdle čekají na durable smazání restart-recovery exposure flagu', async () => {
   341	    const initial = emptySnapshot();
   342	    initial.safety = { ...initial.safety!, liveCopyOpenSince: 123 };
   343	    const durable = createMemoryCopierStore(initial);
   344	    let releaseCommit!: () => void;
   345	    let markCommitStarted!: () => void;
   346	    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
   347	    const commitStarted = new Promise<void>(resolve => { markCommitStarted = resolve; });
   348	    const store = {
   349	      load: () => durable.load(),
   350	      commit: async (snapshot: Parameters<typeof durable.commit>[0], expectedRevision: number) => {
   351	        if (snapshot.safety?.liveCopyOpenSince == null) {
   352	          markCommitStarted();
   353	          await commitGate;
   354	        }
   355	        return durable.commit(snapshot, expectedRevision);
   356	      },
   357	    };
   358	    const controller = await bootstrapCopierRuntime({
   359	      broker: createMockBroker(),
   360	      store,
   361	      group,
   362	    });
   363	
   364	    const shutdown = controller.beginShutdown();
   365	    await commitStarted;
   366	    let shutdownSettled = false;
   367	    let idleSettled = false;
   368	    void shutdown.then(() => { shutdownSettled = true; });
   369	    const idle = controller.waitForIdle().then(() => { idleSettled = true; });
   370	    await Promise.resolve();
   371	    expect(shutdownSettled).toBe(false);
   372	    expect(idleSettled).toBe(false);
   373	
   374	    releaseCommit();
   375	    await Promise.all([shutdown, idle]);
   376	    expect((await durable.load()).safety).not.toHaveProperty('liveCopyOpenSince');
   377	    controller.stop();
   378	  });
   379	
   380	  it('shutdown clear se zařadí až za právě commitovaný exposure update', async () => {
   381	    const durable = createMemoryCopierStore();
   382	    let releaseUpdate!: () => void;
   383	    let markUpdateStarted!: () => void;
   384	    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
   385	    const updateStarted = new Promise<void>(resolve => { markUpdateStarted = resolve; });
   386	    let updateBlocked = false;
   387	    let clearCommits = 0;
   388	    const store = {
   389	      load: () => durable.load(),
   390	      commit: async (snapshot: Parameters<typeof durable.commit>[0], expectedRevision: number) => {
   391	        const before = await durable.load();
   392	        if (!updateBlocked && before.safety?.liveCopyOpenSince == null && snapshot.safety?.liveCopyOpenSince != null) {
   393	          updateBlocked = true;
   394	          markUpdateStarted();
   395	          await updateGate;
   396	        }
   397	        if (before.safety?.liveCopyOpenSince != null && snapshot.safety?.liveCopyOpenSince == null) {
   398	          clearCommits += 1;
   399	        }
   400	        return durable.commit(snapshot, expectedRevision);
   401	      },
   402	    };
   403	    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
   404	    const controller = await bootstrapCopierRuntime({
   405	      broker,
   406	      store,
   407	      group,
   408	      clock: stepClock(),
   409	    });
   410	    broker.setConnected(true);
   411	    await controller.waitForIdle();
   412	    await controller.reconcile();
   413	    controller.arm();
   414	    broker.emitEvent({ type: 'order', order: leaderOrder({ orderType: 'Market', limitPrice: undefined }) });
   415	
   416	    await updateStarted;
   417	    const shutdown = controller.beginShutdown();
   418	    let shutdownSettled = false;
   419	    void shutdown.then(() => { shutdownSettled = true; });
   420	    await Promise.resolve();
   421	    expect(shutdownSettled).toBe(false);
   422	
   423	    releaseUpdate();
   424	    await Promise.all([shutdown, controller.waitForIdle()]);
   425	    expect(updateBlocked).toBe(true);
   426	    expect(clearCommits).toBe(1);
   427	    expect((await durable.load()).safety).not.toHaveProperty('liveCopyOpenSince');
   428	    controller.stop();
   429	  });
   430	
   431	  it('změna konfigurace vždy disarmuje a neplatnou změnu vůbec nepřijme', async () => {
   432	    const broker = createMockBroker();
   433	    const controller = await bootstrapCopierRuntime({
   434	      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
   435	    });
   436	    broker.setConnected(true);
   437	    await controller.waitForIdle();
   438	    await controller.reconcile();
   439	    controller.arm();
   440	    expect(() => controller.updateGroup({
  3420	      tag: 'guard-seed-follower-nq', accountId: 200, symbol: NQ,
  3421	      side: 'Buy', quantity: 2, orderType: 'Market',
  3422	    });
  3423	    const staleMnqStop = await broker.placeOrder({
  3424	      tag: 'guard-stale-mnq-stop', accountId: 200, symbol: MNQ,
  3425	      side: 'Sell', quantity: 5, orderType: 'Stop', stopPrice: 29_900,
  3426	    });
  3427	    const untouchedNqStop = await broker.placeOrder({
  3428	      tag: 'guard-untouched-nq-stop', accountId: 200, symbol: NQ,
  3429	      side: 'Sell', quantity: 2, orderType: 'Stop', stopPrice: 19_900,
  3430	    });
  3431	    const protectiveOso = acknowledgedFollowerOso({
  3432	      key: 'oso:guard-owned-mnq',
  3433	      tag: 'guard-owned-mnq',
  3434	      side: 'Buy',
  3435	      entryBrokerOrderId: followerEntry.brokerOrderId,
  3436	      firstBrokerOrderId: staleMnqStop.brokerOrderId,
  3437	      secondBrokerOrderId: 'guard-missing-target',
  3438	      sequence: 1,
  3439	    });
  3440	    const initial = emptySnapshot();
  3441	    const store = createMemoryCopierStore({
  3442	      ...initial,
  3443	      osoOutbox: [protectiveOso],
  3444	      safety: {
  3445	        ...initial.safety!,
  3446	        liveCopyOpenSince: 90,
  3447	        accountEligibility: [{
  3448	          accountId: 200,
  3449	          state: 'active',
  3450	          at: 95,
  3451	          lastExecution: {
  3452	            kind: 'rejected',
  3453	            reason: 'The current price is outside the price limits set for this product.',
  3454	            symbol: MNQ,
  3455	            brokerOrderId: 'guard-rejected-stop',
  3456	            orderType: 'Stop',
  3457	            side: 'Sell',
  3458	            stopPrice: 29_900,
  3459	            at: 95,
  3460	          },
  3461	        }],
  3462	        leaderExposureEpochs: [{
  3463	          id: 'guard-owned-epoch',
  3464	          groupId: group.id,
  3465	          leaderAccountId: 100,
  3466	          symbol: MNQ,
  3467	          openedAt: 90,
  3468	          lastLeaderNet: 5,
  3469	          generation: 1,
  3470	          phase: 'open',
  3471	          followers: [{
  3472	            accountId: 200,
  3473	            replicationModeAtOpen: 'on-submit',
  3474	            eligibleAtOpen: true,
  3475	            copyLineage: 'confirmed',
  3476	            confirmedNetQuantity: 5,
  3477	          }],
  3478	          leaderEntryOrderIds: [leaderEntry.brokerOrderId],
  3479	          leaderExitOrderIds: [],
  3480	        }],
  3481	      },
  3482	    });
  3483	    const controller = await bootstrapCopierRuntime({
  3484	      broker,
  3485	      store,
  3486	      group: {
  3487	        ...group,
  3488	        safety: { ...DEFAULT_COPY_GROUP_SAFETY, autoCloseFollowerPositions },
  3489	      },
  3490	      clock,
  3491	      leaderFlatGraceMs: graceMs,
  3492	      leaderFlatExitSettlementGraceMs: 0,
  3493	      leaderFlatInflightRetryMs: 1,
  3494	      flattenConfirmationAttempts: 2,
  3495	      flattenConfirmationPollMs: 0,

exec
/bin/zsh -lc "rg -n \"function evaluateLeaderFlatBatch|export const evaluateLeaderFlatBatch|export function evaluateLeaderFlatBatch|blockedAccountIds|ne všechny follower snapshoty\" services tests | sed -n '1,220p' && nl -ba services/copierLeaderFlatGuard.ts | sed -n '240,470p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
tests/copierLeaderFlatGuard.test.ts:370:      blockedAccountIds: [200],
tests/copierLeaderFlatGuard.test.ts:555:      blockedAccountIds: [300],
tests/copierLeaderFlatGuard.test.ts:561:      .toMatchObject({ kind: 'blocked', blockedAccountIds: [LEADER] });
tests/copierLeaderFlatGuard.test.ts:563:      .toMatchObject({ kind: 'blocked', blockedAccountIds: [LEADER] });
tests/copierLeaderFlatGuard.test.ts:565:      .toMatchObject({ kind: 'blocked', blockedAccountIds: [200] });
services/copierRuntimeController.ts:2393:            ...evaluation.blockedAccountIds,
services/copierRuntimeController.ts:2410:      ...evaluation.blockedAccountIds,
services/copierRuntimeController.ts:2482:    const fullyResolved = evaluation.blockedAccountIds.length === 0
services/copierLeaderFlatGuard.ts:182:  blockedAccountIds: number[];
services/copierLeaderFlatGuard.ts:481:    blockedAccountIds: sortedUniqueNumbers(values.blocked ?? []),
services/copierLeaderFlatGuard.ts:545:export function evaluateLeaderFlatBatch(
services/copierLeaderFlatGuard.ts:647:    return evaluation('blocked', epoch, observedAt, 'ne všechny follower snapshoty jsou autoritativně dostupné', {
   240	    }
   241	    const current = byAccount.get(follower.accountId);
   242	    if (!current) {
   243	      byAccount.set(follower.accountId, follower);
   244	      continue;
   245	    }
   246	    if (
   247	      current.replicationModeAtOpen !== follower.replicationModeAtOpen
   248	      || current.eligibleAtOpen !== follower.eligibleAtOpen
   249	    ) {
   250	      throw new Error(`Follower ${follower.accountId} má konfliktní ownership snapshot`);
   251	    }
   252	    // Late ACK may strengthen lineage, but must never weaken the opening snapshot.
   253	    if (follower.copyLineage === 'confirmed') current.copyLineage = 'confirmed';
   254	    if (follower.confirmedNetQuantity != null) {
   255	      if (
   256	        current.confirmedNetQuantity != null
   257	        && current.confirmedNetQuantity !== 0
   258	        && follower.confirmedNetQuantity !== 0
   259	        && Math.sign(current.confirmedNetQuantity) !== Math.sign(follower.confirmedNetQuantity)
   260	      ) {
   261	        throw new Error(`Follower ${follower.accountId} má konfliktní quantity ownership`);
   262	      }
   263	      if (
   264	        current.confirmedNetQuantity == null
   265	        || Math.abs(follower.confirmedNetQuantity) > Math.abs(current.confirmedNetQuantity)
   266	      ) {
   267	        current.confirmedNetQuantity = follower.confirmedNetQuantity;
   268	      }
   269	    }
   270	  }
   271	  return [...byAccount.values()].sort((a, b) => a.accountId - b.accountId);
   272	}
   273	
   274	export function createLeaderFlatEpoch(input: CreateLeaderFlatEpochInput): LeaderFlatEpoch {
   275	  if (input.leaderNet === 0) throw new Error('Leader exposure epoch vyžaduje nenulovou pozici');
   276	  const generation = input.generation ?? 1;
   277	  if (!Number.isSafeInteger(generation) || generation < 1) {
   278	    throw new Error('Leader exposure generation musí být kladné celé číslo');
   279	  }
   280	  return {
   281	    id: nonEmpty(input.id, 'epoch id'),
   282	    groupId: nonEmpty(input.groupId, 'group id'),
   283	    leaderAccountId: positiveAccountId(input.leaderAccountId, 'leader accountId'),
   284	    symbol: nonEmpty(input.symbol, 'symbol'),
   285	    openedAt: finite(input.openedAt, 'openedAt'),
   286	    lastLeaderNet: finite(input.leaderNet, 'leaderNet'),
   287	    generation,
   288	    phase: 'open',
   289	    followers: snapshotLeaderFlatFollowers(input.followers),
   290	    leaderEntryOrderIds: uniqueStrings(input.leaderEntryOrderIds ?? []),
   291	    leaderExitOrderIds: uniqueStrings(input.leaderExitOrderIds ?? []),
   292	  };
   293	}
   294	
   295	export function mergeLeaderFlatEpochLineage(
   296	  epoch: LeaderFlatEpoch,
   297	  update: {
   298	    followers?: readonly LeaderFlatFollowerOwnership[];
   299	    leaderEntryOrderIds?: readonly string[];
   300	    leaderExitOrderIds?: readonly string[];
   301	  },
   302	): LeaderFlatEpoch {
   303	  return {
   304	    ...epoch,
   305	    followers: snapshotLeaderFlatFollowers([...epoch.followers, ...(update.followers ?? [])]),
   306	    leaderEntryOrderIds: uniqueStrings([
   307	      ...epoch.leaderEntryOrderIds,
   308	      ...(update.leaderEntryOrderIds ?? []),
   309	    ]),
   310	    leaderExitOrderIds: uniqueStrings([
   311	      ...epoch.leaderExitOrderIds,
   312	      ...(update.leaderExitOrderIds ?? []),
   313	    ]),
   314	  };
   315	}
   316	
   317	const matchesEpoch = (
   318	  epoch: LeaderFlatEpoch,
   319	  input: Pick<PlanLeaderPositionTransitionInput, 'groupId' | 'leaderAccountId' | 'symbol'>,
   320	) => epoch.groupId === input.groupId
   321	  && epoch.leaderAccountId === input.leaderAccountId
   322	  && epoch.symbol === input.symbol;
   323	
   324	export function planLeaderPositionTransition(
   325	  input: PlanLeaderPositionTransitionInput,
   326	): LeaderPositionTransitionPlan {
   327	  finite(input.previousNet, 'previousNet');
   328	  finite(input.nextNet, 'nextNet');
   329	  finite(input.observedAt, 'observedAt');
   330	  duration(input.graceMs, 'graceMs');
   331	  positiveAccountId(input.leaderAccountId, 'leader accountId');
   332	  nonEmpty(input.groupId, 'group id');
   333	  nonEmpty(input.symbol, 'symbol');
   334	
   335	  if (!input.previousKnown) {
   336	    return { kind: 'ignored', reason: 'previous-unknown', epoch: input.epoch };
   337	  }
   338	  if (input.previousNet === input.nextNet) {
   339	    return { kind: 'ignored', reason: 'no-change', epoch: input.epoch };
   340	  }
   341	
   342	  const opening = input.previousNet === 0 && input.nextNet !== 0;
   343	  const directFlip = input.previousNet !== 0
   344	    && input.nextNet !== 0
   345	    && Math.sign(input.previousNet) !== Math.sign(input.nextNet);
   346	  if (opening || directFlip) {
   347	    const next = createLeaderFlatEpoch({
   348	      id: nonEmpty(input.nextEpochId ?? '', 'next epoch id'),
   349	      groupId: input.groupId,
   350	      leaderAccountId: input.leaderAccountId,
   351	      symbol: input.symbol,
   352	      openedAt: input.observedAt,
   353	      leaderNet: input.nextNet,
   354	      generation: (input.epoch?.generation ?? 0) + 1,
   355	      followers: input.followersAtOpen,
   356	      leaderEntryOrderIds: input.leaderEntryOrderIds,
   357	      leaderExitOrderIds: input.leaderExitOrderIds,
   358	    });
   359	    return { kind: 'opened', epoch: next };
   360	  }
   361	
   362	  if (input.previousNet !== 0 && input.nextNet === 0) {
   363	    if (!input.epoch) return { kind: 'blocked', reason: 'missing-open-epoch', epoch: null };
   364	    if (!matchesEpoch(input.epoch, input)) {
   365	      return { kind: 'blocked', reason: 'epoch-mismatch', epoch: input.epoch };
   366	    }
   367	    if (input.epoch.lastLeaderNet !== input.previousNet) {
   368	      return { kind: 'blocked', reason: 'epoch-position-mismatch', epoch: input.epoch };
   369	    }
   370	    if (input.epoch.phase !== 'open') {
   371	      return { kind: 'blocked', reason: 'epoch-not-open', epoch: input.epoch };
   372	    }
   373	    const epoch = mergeLeaderFlatEpochLineage(input.epoch, {
   374	      leaderExitOrderIds: input.leaderExitOrderIds,
   375	    });
   376	    const scheduled: LeaderFlatEpoch = {
   377	      ...epoch,
   378	      lastLeaderNet: input.previousNet,
   379	      generation: epoch.generation + 1,
   380	      phase: 'grace',
   381	      flatObservedAt: input.observedAt,
   382	      graceUntil: input.observedAt + input.graceMs,
   383	      terminalAt: undefined,
   384	      terminalReason: undefined,
   385	    };
   386	    return {
   387	      kind: 'scheduled',
   388	      epoch: scheduled,
   389	      token: { epochId: scheduled.id, generation: scheduled.generation },
   390	    };
   391	  }
   392	
   393	  if (!input.epoch) return { kind: 'blocked', reason: 'missing-open-epoch', epoch: null };
   394	  if (!matchesEpoch(input.epoch, input)) {
   395	    return { kind: 'blocked', reason: 'epoch-mismatch', epoch: input.epoch };
   396	  }
   397	  if (input.epoch.phase !== 'open') {
   398	    return { kind: 'blocked', reason: 'epoch-not-open', epoch: input.epoch };
   399	  }
   400	  return {
   401	    kind: 'updated',
   402	    epoch: {
   403	      ...mergeLeaderFlatEpochLineage(input.epoch, {
   404	        leaderEntryOrderIds: input.leaderEntryOrderIds,
   405	        leaderExitOrderIds: input.leaderExitOrderIds,
   406	      }),
   407	      lastLeaderNet: input.nextNet,
   408	    },
   409	  };
   410	}
   411	
   412	export function invalidateLeaderFlatEpoch(
   413	  epoch: LeaderFlatEpoch,
   414	  reason: string,
   415	  at: number,
   416	): LeaderFlatEpoch {
   417	  return {
   418	    ...epoch,
   419	    generation: epoch.generation + 1,
   420	    phase: 'invalidated',
   421	    terminalAt: finite(at, 'invalidatedAt'),
   422	    terminalReason: nonEmpty(reason, 'invalidation reason'),
   423	  };
   424	}
   425	
   426	export function isLeaderFlatGuardTokenCurrent(
   427	  epoch: LeaderFlatEpoch | null,
   428	  token: LeaderFlatGuardToken,
   429	): boolean {
   430	  return epoch != null && epoch.id === token.epochId && epoch.generation === token.generation;
   431	}
   432	
   433	const nextEpoch = (
   434	  epoch: LeaderFlatEpoch,
   435	  phase: LeaderFlatEpochPhase,
   436	  at: number,
   437	  reason: string,
   438	  graceUntil?: number,
   439	): LeaderFlatEpoch => ({
   440	  ...epoch,
   441	  generation: epoch.generation + 1,
   442	  phase,
   443	  graceUntil: phase === 'waiting-inflight' && graceUntil != null ? graceUntil : undefined,
   444	  ...(phase === 'resolved' || phase === 'blocked'
   445	    ? { terminalAt: at, terminalReason: reason }
   446	    : { terminalAt: undefined, terminalReason: undefined }),
   447	});
   448	
   449	const sortedUniqueNumbers = (values: readonly number[]) => [...new Set(values)].sort((a, b) => a - b);
   450	
   451	const evaluation = (
   452	  kind: LeaderFlatEvaluationKind,
   453	  epoch: LeaderFlatEpoch,
   454	  at: number,
   455	  reason: string,
   456	  values: {
   457	    targets?: LeaderFlatCloseTarget[];
   458	    divergent?: number[];
   459	    detectOnly?: number[];
   460	    waiting?: number[];
   461	    blocked?: number[];
   462	    waitUntil?: number;
   463	  } = {},
   464	): LeaderFlatEvaluation => {
   465	  const phase: LeaderFlatEpochPhase = kind === 'resolved'
   466	    ? 'resolved'
   467	    : kind === 'close-targets'
   468	      ? 'closing'
   469	      : kind === 'wait-inflight'
   470	        ? 'waiting-inflight'

exec
/bin/zsh -lc "nl -ba services/copierLeaderFlatGuard.ts | sed -n '535,665p' && nl -ba tests/copierLeaderFlatGuard.test.ts | sed -n '530,575p' && nl -ba docs/PROJECT_LOG.md | sed -n '55,70p' && nl -ba docs/PROJECT_LOG.md | sed -n '240,270p' && nl -ba docs/PROJECT_LOG.md | sed -n '598,638p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
   535	  followerNet: number,
   536	): boolean => {
   537	  const confirmed = follower.confirmedNetQuantity;
   538	  return confirmed != null
   539	    && Number.isFinite(confirmed)
   540	    && confirmed !== 0
   541	    && Math.sign(confirmed) === Math.sign(followerNet)
   542	    && Math.abs(followerNet) <= Math.abs(confirmed);
   543	};
   544	
   545	export function evaluateLeaderFlatBatch(
   546	  input: EvaluateLeaderFlatBatchInput,
   547	): LeaderFlatEvaluation {
   548	  const { epoch, snapshot } = input;
   549	  const observedAt = finite(snapshot.observedAt, 'snapshot observedAt');
   550	  const settlementGraceMs = duration(input.exitSettlementGraceMs, 'exitSettlementGraceMs');
   551	  const inflightRetryMs = duration(input.inflightRetryMs, 'inflightRetryMs');
   552	  if (epoch.phase !== 'grace' && epoch.phase !== 'waiting-inflight' && epoch.phase !== 'closing') {
   553	    return evaluation('blocked', epoch, observedAt, `epoch není připravená ke kontrole (${epoch.phase})`);
   554	  }
   555	  if (epoch.graceUntil != null && observedAt < epoch.graceUntil) {
   556	    return evaluation('wait-inflight', epoch, observedAt, 'leader-flat grace ještě neuplynula', {
   557	      waitUntil: epoch.graceUntil,
   558	    });
   559	  }
   560	
   561	  const byAccount = new Map<number, LeaderFlatAccountBatchSnapshot>();
   562	  const duplicates = new Set<number>();
   563	  for (const account of snapshot.accounts) {
   564	    if (byAccount.has(account.accountId)) duplicates.add(account.accountId);
   565	    else byAccount.set(account.accountId, account);
   566	  }
   567	  if (duplicates.size > 0) {
   568	    return evaluation('blocked', epoch, observedAt, 'batch snapshot obsahuje duplicitní účty', {
   569	      blocked: [...duplicates],
   570	    });
   571	  }
   572	
   573	  const leader = byAccount.get(epoch.leaderAccountId);
   574	  if (!leader || !leader.ok) {
   575	    return evaluation('blocked', epoch, observedAt, 'leader snapshot není autoritativně dostupný', {
   576	      blocked: [epoch.leaderAccountId],
   577	    });
   578	  }
   579	  const leaderNet = accountNet(leader, epoch.symbol);
   580	  if (leaderNet == null) {
   581	    return evaluation('blocked', epoch, observedAt, 'leader snapshot obsahuje neplatnou pozici', {
   582	      blocked: [epoch.leaderAccountId],
   583	    });
   584	  }
   585	  if (leaderNet !== 0) {
   586	    return evaluation('blocked', epoch, observedAt, `leader už není flat (${leaderNet})`, {
   587	      blocked: [epoch.leaderAccountId],
   588	    });
   589	  }
   590	
   591	  const divergent: number[] = [];
   592	  const detectOnly: number[] = [];
   593	  const waiting: number[] = [];
   594	  const blocked: number[] = [];
   595	  const targets: LeaderFlatCloseTarget[] = [];
   596	
   597	  for (const follower of epoch.followers) {
   598	    const account = byAccount.get(follower.accountId);
   599	    if (!account || !account.ok) {
   600	      blocked.push(follower.accountId);
   601	      continue;
   602	    }
   603	    const followerNet = accountNet(account, epoch.symbol);
   604	    if (followerNet == null) {
   605	      blocked.push(follower.accountId);
   606	      continue;
   607	    }
   608	    if (followerNet === 0) continue;
   609	    divergent.push(follower.accountId);
   610	
   611	    if (!automaticOwnership(follower) || !quantityOwnershipCovers(follower, followerNet)) {
   612	      detectOnly.push(follower.accountId);
   613	      continue;
   614	    }
   615	    const inflight = (account.exitEvidence ?? []).some(item => (
   616	      item.accountId === follower.accountId
   617	      && isInflightExit(item, epoch, observedAt, settlementGraceMs)
   618	    ));
   619	    if (inflight) {
   620	      waiting.push(follower.accountId);
   621	      continue;
   622	    }
   623	    if (input.autoCloseFollowerPositions) {
   624	      targets.push({ accountId: follower.accountId, symbol: epoch.symbol });
   625	    } else {
   626	      detectOnly.push(follower.accountId);
   627	    }
   628	  }
   629	
   630	  if (targets.length > 0) {
   631	    return evaluation('close-targets', epoch, observedAt, 'leader je flat; potvrzené orphan kopie vyžadují cílené zavření', {
   632	      targets, divergent, detectOnly, waiting, blocked,
   633	    });
   634	  }
   635	  if (divergent.length > 0 && detectOnly.length > 0) {
   636	    return evaluation('detect-only', epoch, observedAt, 'leader je flat; divergence není autorizovaná k automatickému zavření', {
   637	      divergent, detectOnly, waiting, blocked,
   638	    });
   639	  }
   640	  if (waiting.length > 0) {
   641	    const waitUntil = observedAt + inflightRetryMs;
   642	    return evaluation('wait-inflight', epoch, observedAt, 'copier exit nebo liquidation je stále v běhu', {
   643	      divergent, waiting, blocked, waitUntil,
   644	    });
   645	  }
   646	  if (blocked.length > 0) {
   647	    return evaluation('blocked', epoch, observedAt, 'ne všechny follower snapshoty jsou autoritativně dostupné', {
   648	      blocked,
   649	    });
   650	  }
   651	  return evaluation('resolved', epoch, observedAt, 'leader i všichni účastníci epochy jsou flat');
   652	}
   530	      account(LEADER),
   531	      account(200, { [SYMBOL]: 1 }, [evidence(200, {
   532	        role: 'guard-liquidation', status: 'sending', epochId: epoch.id,
   533	      })]),
   534	    ]);
   535	    expect(current).toMatchObject({ kind: 'wait-inflight', waitingInflightAccountIds: [200] });
   536	
   537	    const foreign = evaluate(epoch, [
   538	      account(LEADER),
   539	      account(200, { [SYMBOL]: 1 }, [evidence(200, {
   540	        role: 'guard-liquidation', status: 'sending', epochId: 'other-epoch',
   541	      })]),
   542	    ]);
   543	    expect(foreign).toMatchObject({ kind: 'close-targets', waitingInflightAccountIds: [] });
   544	  });
   545	
   546	  it('při částečné chybě batchu vrátí známé bezpečné cíle a chybějící účet explicitně blokuje', () => {
   547	    const result = evaluate(scheduledEpoch([follower(200), follower(300)]), [
   548	      account(LEADER),
   549	      account(200, { [SYMBOL]: 1 }),
   550	      failedAccount(300),
   551	    ]);
   552	    expect(result).toMatchObject({
   553	      kind: 'close-targets',
   554	      targets: [{ accountId: 200, symbol: SYMBOL }],
   555	      blockedAccountIds: [300],
   556	    });
   557	  });
   558	
   559	  it('blokuje neautoritativního nebo znovu otevřeného leadera a duplicitní účty', () => {
   560	    expect(evaluate(scheduledEpoch(), [failedAccount(LEADER), account(200)]))
   561	      .toMatchObject({ kind: 'blocked', blockedAccountIds: [LEADER] });
   562	    expect(evaluate(scheduledEpoch(), [account(LEADER, { [SYMBOL]: 1 }), account(200)]))
   563	      .toMatchObject({ kind: 'blocked', blockedAccountIds: [LEADER] });
   564	    expect(evaluate(scheduledEpoch(), [account(LEADER), account(200), account(200)]))
   565	      .toMatchObject({ kind: 'blocked', blockedAccountIds: [200] });
   566	  });
   567	});
    55	  nahradí VPS; stejná investice jako celý VPS přechod.
    56	
    57	## Otevřené otázky
    58	
    59	- [ ] **Automatická post-connect recovery selže, když follower chybí v OAuth**
    60	      (3. 9. 05:45:24 UTC, worker 03d1fc5f): po startu s breached `63338752`, který
    61	      už není v žádném OAuth adresáři, skončila recovery vlna „nepodařilo se
    62	      ověřit stav účtů“ bez auditního důvodu, zatímco ruční `reconcile` z CLI
    63	      (routing předá optional skip) prošel. Podezření: `runConnectionRecovery`
    64	      volá reconciliation bez `missingOptionalAccountIds`, takže nezpůsobilý
    65	      chybějící follower je „missing required“. Fix: recovery má použít stejný
    66	      optional-skip vstup jako CLI/UI cesta a při selhání zapsat audit s důvodem.
    67	      Delegovat Codexu s regresí.
    68	- [x] **Násobek 2× „sám“ přeskočil na funded účet při změně leadera** —
    69	      VYŘEŠENO lokálně 3. 9. (zápis níže; změna zatím není commitnutá ani
    70	      nasazená). Původní incident (2. 9.,
   240	- Nic nebylo instalováno ani spuštěno, LaunchAgent i instalovaný build 5 zůstaly
   241	  beze změny. Beze změny jsou také server/PWA, broker, copier a jeho ARM stav;
   242	  větev není sloučena do `main`.
   243	
   244	### 2026-09-03 (Claude, rollout 5154856d — recovery vs. zmizelý follower)
   245	
   246	Uživatel nemohl uložit skupinu bez breached `63338752` („Změnu leadera blokuje
   247	rozpracovaný lifecycle: connection recovery“) ani zapnout ARM („Follower účet
   248	… není dostupný“). Příčina: recovery vlna po startu routovala i follower, který
   249	už není v žádném OAuth adresáři, router hodil chybu, po pěti pokusech
   250	fail-closed a `pendingConnectionRecovery` zůstal zapnutý (záměr z I), přičemž
   251	ruční Kontrola pozic ho neshazovala. Oprava (Claude, copier core, Codex
   252	cross-review vyžádán): recovery dostává přes `resolveMissingOptionalAccountIds`
   253	stejný optional-skip jako CLI/UI, a autoritativně čistá ruční Kontrola pozic
   254	příznak shodí; divergentní/neúspěšná ne. Regrese
   255	`tests/copierConnectionRecoveryOptionalFollower.test.ts` (router bez route).
   256	Celá sada 1866/1866, tsc čistý. Worker reinstalován ze `5154856d` (bundle
   257	`6bfcf2df0960de08…`, start 06:56:51 UTC, DISARMED), post-restart reconcile
   258	čistý.
   259	
   260	Pozorování: po startu ještě jednou fail-closed „leader je autoritativně flat,
   261	follower stav se neshoduje (ne všechny follower snapshoty jsou autoritativně
   262	dostupné)“ s divergencí `[63338752]` — leader-flat guard při obnově durable
   263	epochy vyžaduje snapshot i zmizelého followera. Fail-closed je zde správný
   264	(neověřitelná kopie), ruční reconcile stav vyčistil; zmizí s odebráním účtu ze
   265	skupiny a ukončením epochy. Paralelně Codex J: odebrání nedostupného followera
   266	jedním krokem přímo z modalu „Skupinu nelze zapnout“.
   267	
   268	### 2026-09-03 (Claude + uživatel, rollout workera 03d1fc5f)
   269	
   270	Na výslovné „nasaď“: čtyři opuštěné `cancel-or-modify` z 2. 9. 18:44 (SL modify
   598	`reconciliationRequired=false`, `lastError=null`, snímky `ready`.
   599	Skupina zůstává DISARMED; DLL zámek LFE…016 vypršel s novou session
   600	(autoritativně reaktivován 06:52 UTC), trvá jen BREACH 62364058.
   601	
   602	### 2026-09-02 (Codex, bezpečné odebrání followera zmizelého z OAuth)
   603	
   604	Routing refresh má místo seznamu s implicitním polykáním chyb explicitní
   605	kontrakt `prepareGroupAccounts({ required, optional }) -> { missingOptional }`.
   606	Při změně topologie je optional pouze follower, který je ve staré skupině,
   607	není v nové a není starý ani nový leader. Všechny OAuth adresáře se vždy
   608	obnoví celé: pouze nulová viditelnost optional účtu dovolí route vynechat a
   609	pilot zapíše konkrétní `ROUTING OPTIONAL SKIP`; duplicita, inactive/read-only
   610	stav nebo chybějící Account.name dál selžou. Leader a každý účet nové
   611	topologie jsou vždy required. Žádné automatické párování ani náhrada ID
   612	nevznikly.
   613	
   614	Controller dostane jen validovaný seznam optional účtů skutečně chybějících
   615	v OAuth. `reconfigureGroup`/`activateGroup` smí přeskočit pouze takového
   616	odebíraného followera bez route. Pokud OAuth starý účet vrátí, controller dál
   617	načte capability, pozice i working orders a změnu při expozici nebo příkazu
   618	fail-closed odmítne; účet v nové topologii ani leader nelze výjimkou označit.
   619	
   620	Samostatný reconcile používá leadera jako required a followery jako optional
   621	pouze pro OAuth discovery. Chybějící follower bez dosavadního eligibility
   622	záznamu se durable označí `unverifiable` s důvodem a zůstane vykázaný v
   623	`oauthPreflight.missingAccounts`, zatímco zdravé routované účty projdou
   624	autoritativní kontrolou. Tato varianta zachovává existující eligibility
   625	mechanismus a dovolí zdravý read-only reconcile, ale nezeslabuje leadera ani
   626	účet, který OAuth vrací. `canSafelyRestartLocalCopierAgent` se neměnil; po čisté reconciliaci
   627	restart brána projde i s vykázaným missing účtem (ten nemá route a
   628	restart nic neobchoduje), `oauthPreflight.missingAccounts` zůstává
   629	viditelná diagnostika. ARM/SHADOW jsou pro missing followera dál
   630	fail-closed přes strict routing (oprava recenze Claude 2. 9.).
   631	
   632	Regrese pokrývají odebrání i náhradu zmizelého followera, povinného zmizelého
   633	leadera, followera ponechaného v nové topologii, strict preflight viditelného
   634	odebíraného účtu a reconcile bez eligibility záznamu. `npm run typecheck`
   635	prošel; cíleně 143/143 a celá sada 205 souborů / 1737 testů. Závislosti nebyly
   636	instalovány. Neproběhl push, deploy, reinstall workeru, ARM, Flatten ani jiný
   637	broker side effect; aktivace v provozu čeká na samostatný schválený rollout.
   638	

exec
/bin/zsh -lc "node -p \"require('./package.json').scripts.test\" && node -p \"require('./package.json').devDependencies?.vitest || require('./package.json').dependencies?.vitest\"" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 57ms:
vitest run
^4.1.9

codex
Nové testy potvrzují zamýšlený happy path, ale nemají durable `leaderExposureEpochs`; tedy nereprodukují přesně scénář z prvního nálezu. V kódu navíc recovery po partial snapshotu naplánuje guard, ale ještě před jeho výsledkem může označit recovery jako recovered a smazat `liveCopyOpenSince`. Prověřuji teď tento řetězec proti testům a session-aware preflightu.
exec
/bin/zsh -lc 'npx vitest run tests/copierConnectionRecoveryOptionalFollower.test.ts tests/copierReconfigureStaleOpenLots.test.ts tests/copierChaosScenarios.test.ts --cache=false' in /private/tmp/alphatrade-reconnect-fix
 exited 1 in 881ms:
failed to load config from /private/tmp/alphatrade-reconnect-fix/vitest.config.ts

⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯
Error: EPERM: operation not permitted, open '/private/tmp/alphatrade-reconnect-fix/node_modules/.vite-temp/vitest.config.ts.timestamp-1788419371967-e08ac7e254e36.mjs'
    at async open (node:internal/fs/promises:642:25)
    at async Object.writeFile (node:internal/fs/promises:1249:14)
    at async loadConfigFromBundledFile (file:///private/tmp/alphatrade-reconnect-fix/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:49588:5)
    at async bundleAndLoadConfigFile (file:///private/tmp/alphatrade-reconnect-fix/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:49433:22)
    at async loadConfigFromFile (file:///private/tmp/alphatrade-reconnect-fix/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:49396:44)
    at async resolveConfig (file:///private/tmp/alphatrade-reconnect-fix/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:48891:24)
    at async _createServer (file:///private/tmp/alphatrade-reconnect-fix/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:38478:66)
    at async createViteServer (file:///private/tmp/alphatrade-reconnect-fix/node_modules/vitest/dist/chunks/cli-api.24X8XwN1.js:8835:17)
    at async createVitest (file:///private/tmp/alphatrade-reconnect-fix/node_modules/vitest/dist/chunks/cli-api.24X8XwN1.js:14221:18)
    at async prepareVitest (file:///private/tmp/alphatrade-reconnect-fix/node_modules/vitest/dist/chunks/cli-api.24X8XwN1.js:14588:14) {
  errno: -1,
  code: 'EPERM',
  syscall: 'open',
  path: '/private/tmp/alphatrade-reconnect-fix/node_modules/.vite-temp/vitest.config.ts.timestamp-1788419371967-e08ac7e254e36.mjs'
}




exec
/bin/zsh -lc 'npx vitest run tests/copierConnectionRecoveryOptionalFollower.test.ts tests/copierReconfigureStaleOpenLots.test.ts tests/copierChaosScenarios.test.ts --cache=false' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 1221ms:

 RUN  v4.1.9 /private/tmp/alphatrade-reconnect-fix


 Test Files  3 passed (3)
      Tests  23 passed (23)
   Start at  09:09:42
   Duration  725ms (transform 671ms, setup 0ms, import 799ms, tests 480ms, environment 0ms)


exec
/bin/zsh -lc "nl -ba /Users/filipkrejca/.codex/memories/MEMORY.md | sed -n '328,353p' && git status --short --branch && git diff --stat && git diff -- docs/PROJECT_LOG.md services/copierRuntimeController.ts tests/copierConnectionRecoveryOptionalFollower.test.ts tests/copierReconfigureStaleOpenLots.test.ts" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 3039ms:
git: error: couldn't create cache file '/tmp/xcrun_db-eqhYJE1P' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-6vSP2Dts' (errno=Operation not permitted)
## codex/reconnect-fix-20260903...origin/codex/reconnect-fix-20260903 [ahead 13]
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-h9NIoSOt' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-lmOBqZgb' (errno=Operation not permitted)
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-sjO0mlek' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-pWIGcbNS' (errno=Operation not permitted)

Read-only review dokončeno. Commit je přesně HEAD; cílené testy jsou zelené, ale statická trasa odhalila, že partial snapshot a generation fence zůstávají uvnitř samotné recovery vlny nedořešené a PROJECT_LOG nové race explicitně neeviduje.
  ✓ Ověřit checkout, Git stav, PROJECT_LOG a relevantní paměť
  ✓ Porovnat commit 30a48144, diff a původní verdikt
  ✓ Trasovat recovery/generation a session-aware leader gate v okolním kódu
  ✓ Ověřit odložení stale resolveru a updateGroup race v PROJECT_LOG
  ✓ Vydat read-only verdikt s konkrétními řádky
codex
## Verdikt: **opravit**

Změna opravuje přímé shazování příznaku ve veřejném `reconcile()`, ale nálezy 1 a 2 neřeší end-to-end. Riziko se přesunulo do samotné recovery vlny.

### Blokující nálezy

1. **Partial snapshot stále může dokončit recovery a smazat durable důkaz.**

Veřejný [`reconcile()`](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4336) už správně pouze naplánuje recovery. Ta ale:

- shodí `pendingConnectionRecovery` hned na začátku ([ř. 2681–2688](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2681)),
- přeskočí OAuth-missing followera ([ř. 2695–2723](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2695)),
- následně ho `hasFollowerExposure()` považuje fakticky za flat, protože v mapě nemá snapshot ([ř. 1537–1538](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:1537)),
- a recovery může smazat `liveCopyOpenSince` a auditovat `recovered` ještě před výsledkem leader-flat guardu ([ř. 2745–2753](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2745)).

Guard později správně označí chybějící snapshot jako blocked, ale po doběhnutí už není aktivní timer. Reconfigure kontroluje jen právě běžící timer/recovery ([ř. 3988–4003](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3988)), dovolí missing followera vynechat z preflightu a následně smaže `liveCopyOpenSince` i `leaderExposureEpochs` ([ř. 4025–4079](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4025)).

Nový recovery test obsahuje pouze `liveCopyOpenSince`, nikoli durable `leaderExposureEpochs` ([test ř. 33–42](/private/tmp/alphatrade-reconnect-fix/tests/copierConnectionRecoveryOptionalFollower.test.ts:33)). Přesný původní scénář tedy nekryje.

2. **Generation fence je opravený ve wrapperu, ale recovery ho stále ignoruje.**

Reconciliation při změně `safetyGeneration` správně nastaví `positionCheckComplete=false` ([ř. 3891–3903](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3891)), její návratová hodnota však stále obsahuje jen dvě pole bez `authoritativelyClean` ([ř. 3674–3677](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3674)). Recovery tato pole přijme jako úspěch a pokračuje úklidem ([ř. 2721–2753](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2721)).

To je reálné zejména proto, že `updateGroup()` mění skupinu a invaliduje generation synchronně mimo `eventTail` ([ř. 4428–4437](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4428)).

### Session-aware `openLots`

Použití `currentDailyStats(now)` je samo o sobě správné: starý denní ledger není autoritou aktuální broker pozice. Přenesenou expozici leadera nebo dostupného followera následující `listPositions` preflight zachytí ([ř. 4014–4065](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4014)).

Výjimkou je odstraňovaný OAuth-missing optional follower, který se z preflightu úmyslně vynechá. Jeho orphan expozice zachycena být nemusí. Dokud se neopraví durable-epoch/partial-snapshot mezera výše, změna (3) odstraňuje poslední konzervativní blokaci právě v rizikovém scénáři.

### Ostatní body

Audit resolveru a poslední chyby pěti pokusů je opraven správně na [ř. 2702–2742](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2702).

Stale resolver ani `updateGroup` race nejsou v `PROJECT_LOG` správně odložené. Otevřený bod na [ř. 59–67](/private/tmp/alphatrade-reconnect-fix/docs/PROJECT_LOG.md:59) stále popisuje již opravené chybějící předání optional-skipu a audit; nové race nezmiňuje. Aktuální deníkový zápis [ř. 244–265](/private/tmp/alphatrade-reconnect-fix/docs/PROJECT_LOG.md:244) je také neobsahuje.

Nutné nyní:

- recovery nesmí skončit `recovered`, shodit pending ani mazat durable markery, pokud chybí snapshot účastníka neukončené epochy;
- výsledek reconciliation musí nést a recovery kontrolovat `authoritativelyClean`/generation;
- `updateGroup` musí být serializovaný nebo během recovery odmítnutý;
- stale resolver musí mít revision/revalidation, případně musí incomplete-snapshot brána konzervativně zabránit jakémukoli dokončení recovery.

Ověření: HEAD je přesně `30a48144`, pracovní strom zůstal čistý. Tři cílené testovací soubory prošly **23/23**, ale výše uvedené scénáře nekryjí. Repo jsem nezměnil.


tokens used
120 241
## Verdikt: **opravit**

Změna opravuje přímé shazování příznaku ve veřejném `reconcile()`, ale nálezy 1 a 2 neřeší end-to-end. Riziko se přesunulo do samotné recovery vlny.

### Blokující nálezy

1. **Partial snapshot stále může dokončit recovery a smazat durable důkaz.**

Veřejný [`reconcile()`](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4336) už správně pouze naplánuje recovery. Ta ale:

- shodí `pendingConnectionRecovery` hned na začátku ([ř. 2681–2688](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2681)),
- přeskočí OAuth-missing followera ([ř. 2695–2723](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2695)),
- následně ho `hasFollowerExposure()` považuje fakticky za flat, protože v mapě nemá snapshot ([ř. 1537–1538](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:1537)),
- a recovery může smazat `liveCopyOpenSince` a auditovat `recovered` ještě před výsledkem leader-flat guardu ([ř. 2745–2753](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2745)).

Guard později správně označí chybějící snapshot jako blocked, ale po doběhnutí už není aktivní timer. Reconfigure kontroluje jen právě běžící timer/recovery ([ř. 3988–4003](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3988)), dovolí missing followera vynechat z preflightu a následně smaže `liveCopyOpenSince` i `leaderExposureEpochs` ([ř. 4025–4079](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4025)).

Nový recovery test obsahuje pouze `liveCopyOpenSince`, nikoli durable `leaderExposureEpochs` ([test ř. 33–42](/private/tmp/alphatrade-reconnect-fix/tests/copierConnectionRecoveryOptionalFollower.test.ts:33)). Přesný původní scénář tedy nekryje.

2. **Generation fence je opravený ve wrapperu, ale recovery ho stále ignoruje.**

Reconciliation při změně `safetyGeneration` správně nastaví `positionCheckComplete=false` ([ř. 3891–3903](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3891)), její návratová hodnota však stále obsahuje jen dvě pole bez `authoritativelyClean` ([ř. 3674–3677](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3674)). Recovery tato pole přijme jako úspěch a pokračuje úklidem ([ř. 2721–2753](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2721)).

To je reálné zejména proto, že `updateGroup()` mění skupinu a invaliduje generation synchronně mimo `eventTail` ([ř. 4428–4437](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4428)).

### Session-aware `openLots`

Použití `currentDailyStats(now)` je samo o sobě správné: starý denní ledger není autoritou aktuální broker pozice. Přenesenou expozici leadera nebo dostupného followera následující `listPositions` preflight zachytí ([ř. 4014–4065](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4014)).

Výjimkou je odstraňovaný OAuth-missing optional follower, který se z preflightu úmyslně vynechá. Jeho orphan expozice zachycena být nemusí. Dokud se neopraví durable-epoch/partial-snapshot mezera výše, změna (3) odstraňuje poslední konzervativní blokaci právě v rizikovém scénáři.

### Ostatní body

Audit resolveru a poslední chyby pěti pokusů je opraven správně na [ř. 2702–2742](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2702).

Stale resolver ani `updateGroup` race nejsou v `PROJECT_LOG` správně odložené. Otevřený bod na [ř. 59–67](/private/tmp/alphatrade-reconnect-fix/docs/PROJECT_LOG.md:59) stále popisuje již opravené chybějící předání optional-skipu a audit; nové race nezmiňuje. Aktuální deníkový zápis [ř. 244–265](/private/tmp/alphatrade-reconnect-fix/docs/PROJECT_LOG.md:244) je také neobsahuje.

Nutné nyní:

- recovery nesmí skončit `recovered`, shodit pending ani mazat durable markery, pokud chybí snapshot účastníka neukončené epochy;
- výsledek reconciliation musí nést a recovery kontrolovat `authoritativelyClean`/generation;
- `updateGroup` musí být serializovaný nebo během recovery odmítnutý;
- stale resolver musí mít revision/revalidation, případně musí incomplete-snapshot brána konzervativně zabránit jakémukoli dokončení recovery.

Ověření: HEAD je přesně `30a48144`, pracovní strom zůstal čistý. Tři cílené testovací soubory prošly **23/23**, ale výše uvedené scénáře nekryjí. Repo jsem nezměnil.


