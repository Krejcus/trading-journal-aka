# Invarianty jádra kopírky

Stav ověření: 8. 10. 2026, větev `codex/copier-invariants-20261008` nad
`origin/main`. Tento dokument popisuje aktuální kód, ne pouze zamýšlenou
architekturu. `OTÁZKA` a `NEOVĚŘENO` označují mezeru, kterou nelze vydávat za
existující ochranu.

## Jak dokument používat

- Změna, která zasáhne některou z níže uvedených funkcí nebo stavů, musí znovu
  projít odpovídající invariant a testy.
- UI, cache, heartbeat ani úspěšný HTTP požadavek nejsou důkazem brokerového
  výsledku. Důkaz pochází z aktuální worker session a autoritativního broker
  snapshotu, případně z přesně popsaného durable záznamu.
- „Fail-closed“ znamená zastavit nové risk-zvyšující zápisy a přiznat neznámý
  stav. Neznamená automaticky zavřít libovolnou pozici ani incident smazat.
- Odkaz `soubor:název` míří na konkrétní funkci nebo export; je záměrně
  stabilnější než samotné číslo řádku.

## 1. Mapa jádra

### Autoritativní runtime a plánování

| Soubor | Odpovědnost |
|---|---|
| `services/copierRuntimeController.ts` | Stavový automat runtime: bootstrap, ARM/DISARM/kill, broker event queue, reconciliation, risk, daily rules, follower cut, leader-flat recovery a status. |
| `services/copierEngine.ts` | Čisté plánování replikace, quantity, sequence, eligibility, divergence a vazeb follower objednávek. |
| `services/copierRunner.ts` | Jediná běžná cesta k `placeOrder()`: risk gate → durable outbox → broker → durable výsledek; recovery a serial processor. |
| `services/copierRiskGate.ts` | Poslední brána před zápisem: ARM, connection, TTL, freshness, environment, sequence, stuck/divergence, účet a shadow mode. |
| `services/liveCopyTrading.ts` | Konfigurace skupiny, followerů a safety defaults včetně `armExpiryFlatten`, risk limitů a režimů kopírování. |
| `services/copierDailyRules.ts` | Vyhodnocení obchodních oken a denních varování/pauz/locků. |
| `services/copierArmSession.ts` | DST-safe hranice Tradovate session v 17:00 `America/Chicago`. |

### Broker vstup, korelace a vlastnictví

| Soubor | Odpovědnost |
|---|---|
| `services/tradovateBroker.ts` | Tradovate REST/WS adaptér, sync/reconnect/renewal, rate-limit a penalty handling, přesné lookupy a write endpointy. |
| `services/brokerRouter.ts` | Směrování účtů přes více OAuth spojení, agregace connection stavu, per-route epoch a reconnect snapshoty. |
| `services/copierLeaderEventSource.ts` | Převod broker Order/Fill na deduplikované leader eventy; baseline po startu/reconnectu není obchod k replayi. |
| `services/copierBracketCorrelator.ts` | Korelace samostatného OCO SL/TP páru leadera. |
| `services/copierOsoCorrelator.ts` | Korelace nativního OSO parent + SL + TP. |
| `services/copierOsoModifyCascade.ts` | Konzistentní změny OSO nohou a parentu. |
| `services/copierLeaderFlatGuard.ts` | Durable exposure epoch, ownership a přesně cílená reakce na leader open → flat. |
| `services/copierSessionRenewalPolicy.ts` | Politika obnovy Tradovate session po opakovaném sync selhání. |
| `services/copierSocketRenewal.ts` | Plánovaná obměna socketů bez obcházení hard blockerů. |

### Durable zápisy, nejistota a recovery

| Soubor | Odpovědnost |
|---|---|
| `services/copierOutbox.ts` | Standardní order outbox a lookup-before-retry. |
| `services/copierCancelOutbox.ts` | Durable cancel/modify lifecycle. |
| `services/copierBracketOutbox.ts` | Atomický dvounohý bracket; partial výsledek se automaticky neopravuje. |
| `services/copierOsoOutbox.ts` | Atomický OSO parent + dvě nohy; partial výsledek se automaticky neopravuje. |
| `services/copierStore.ts` | Snapshot formát, CAS kontrakt a konzervativní obnova neznámých operací. |
| `services/fileCopierStore.ts` | Atomický lokální Mac snapshot; vyžaduje jediný proces. |
| `services/supabaseCopierStore.ts` | Databázový CAS s fencing tokenem pro budoucí vzdálený runtime. |
| `services/copierWorkerLease.ts` | Fencing lease pro jediného vzdáleného workera; ztráta lease je terminální. |
| `services/copierLiquidationRecovery.ts` | Read-only potvrzení výsledku `liquidateposition` podle stavu, ne podle chybějícího order ID. |
| `services/copierManualActions.ts` | Ruční Flatten: nativní liquidate, bounded stavové ověření a cleanup objednávek. |

### Příkazy, worker, relay a UI hranice

| Soubor | Odpovědnost |
|---|---|
| `server/localCopierExecutionAgent.ts` | Překlad příkazů na controller, deadline, brake epoch a bypass běžné FIFO pro brzdy. |
| `server/macCopierCommandRelay.ts` | Mac polling/realtime kick; realtime je jen optimalizace, polling je záloha. |
| `server/recoverableCopierDelivery.ts` | Obnovitelný transport a ACK; nikdy automaticky neopakuje již zahájenou execution. |
| `server/tradovateCopierCommandRelay.ts` | Durable cloud fronta, idempotency key, TTL, claim/ACK, coalescing a volba device. |
| `server/tradovateCopierDevice.ts` | Párování, device secret, scope a revokace zařízení. |
| `server/macCopierDevice.ts` | Mac identita a uložení tajemství v Keychainu. |
| `server/copierIncidentWatchdog.ts` | Vzdálené vyhodnocení stale runtime/incidentů a deduplikace notifikací; samo neobchoduje. |
| `lib/localCopierAgentProtocol.ts` | Wire typy, sanitizace příkazů, deadlines a rozlišení emergency/risk-reducing akcí. |
| `lib/copierSafetyControls.ts` | Co smí UI poslat bez čerstvého statusu a jak zvolit poslední ověřenou route pro brzdu. |
| `lib/copierStatusPollFence.ts` | Fence pollů/ACK a pořadí statusů podle `startedAt` + `revision`. |
| `lib/copierForegroundPoller.ts` | Jediný foreground poll, invalidace po skrytí a limit čerstvosti. |
| `lib/copierBrakeDelivery.ts` | Pravdivé UI rozlišení durable čekající brzdy od selhání. |
| `lib/copierPowerDisplay.ts` | Pouze prezentační, uživatelsky oddělená paměť posledního ON/OFF. |
| `lib/copierAgentStatusStore.ts` | Pouze prezentační paměť posledního worker statusu. |
| `components/TradovateLiveDesk.tsx` | UI orchestrace statusu, příkazů, poslední ověřené route a safety akcí. |

### Tok jedné leader události

1. `tradovateBroker` přijme WS `Order`, `Fill` nebo `Position`. `brokerRouter`
   propustí entitu jen pro účet přidělený dané OAuth route a zvýší route epoch
   při connection/error události.
2. `copierLeaderEventSource` nejprve vytvoří baseline. Teprve nová, deduplikovaná
   změna vytvoří `LeaderEvent`; fill vzniká pouze z `Fill`, ne domyšlením z
   `Order`.
3. `copierRuntimeController` událost přijme do sériového `eventTail`, zachytí
   `safetyGeneration`/observation fence a podle typu zapojí korelátory a
   leader-flat guard.
4. `copierRunner.processLeaderEvent()` zavolá čisté plánování v
   `copierEngine.planReplication()`. `copierRiskGate` ještě jednou rozhodne,
   zda smí vzniknout write.
5. Runner před broker voláním uloží odpovídající outbox jako `planned` a
   následně `sending`. `dispatchBroker()` těsně před raw write znovu ověří
   safety generation, ARM, shutdown, shadow a halt reason.
6. Broker výsledek se uloží jako potvrzený, odmítnutý nebo `unknown`. Timeout
   se neopakuje naslepo; recovery nejprve čte broker stav. Composite OSO/OCO
   vyžaduje úplný přesný tvar.
7. `createSerialCopierProcessor()` commitne nový `CopierSnapshot` do
   `CopierStore`. Lokální Mac používá `fileCopierStore`; Supabase CAS/fence je
   připraven pro budoucí vzdálený worker, ale není zapojen do Mac pilotu.

## 2. Pravidla (invarianty)

### Výchozí stav a fail-closed

### INV-DEFAULT-01: Runtime startuje DISARMED a bez nové autoritativní kontroly nesmí posílat live zápisy

- Proč: Durable snapshot dokládá historii, nikoli aktuální broker stav po pádu,
  reconnectu nebo změně session.
- Vynucuje: `services/copierRuntimeController.ts:bootstrapCopierRuntime`,
  `services/copierRiskGate.ts:createRiskGateContext` a `haltReason`.
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierChaosScenarios.test.ts`, `tests/localCopierStartupRepair.test.ts`.
- Nikdy: Neobnovovat `armed=true` z disku, browser cache ani posledního
  heartbeat statusu.
- Bezpečné změny vs. nebezpečné: Bezpečné je obnovit durable outbox a zobrazit
  starý stav jako historický. Nebezpečné je po restartu „pokračovat tam, kde
  se skončilo“, bez syncu, reconciliation a nového ARM.

### INV-DEFAULT-02: Neznámý nebo chybový stav zastaví nové riziko; auto-close se řídí explicitní politikou a má vědomý account-wide fallback

- Proč: Obecný account-wide close může zavřít ruční pozici; pouhé DISARM bez
  správy otevřené kopie může naopak nechat orphan expozici. Aktuální politika
  mezi těmito riziky vědomě volí fail-safe account-wide fallback, pokud má
  zapojený účet lokálně známou expozici, ale runtime pro něj nezná žádný
  symbol copier stopy.
- Vynucuje: `services/copierRuntimeController.ts:failClosed`,
  `autoFlattenCopies`, `services/copierLeaderFlatGuard.ts:evaluateLeaderFlatBatch`.
- Hlídá test: `tests/copierAutoCloseV9V4.test.ts`,
  `tests/copierLeaderFlatGuard.test.ts`, `tests/copierChaosScenarios.test.ts`.
- Nikdy: Nevykládat fail-closed jako obecné povolení k libovolnému Flatten All
  ani jako důkaz, že účet je flat. Výjimkou je pouze popsaný fallback uvnitř
  `autoFlattenCopies`: bez targetů předá účet do `flatten()` bez symbolového
  omezení (`cleanupScope` pak fakticky zůstane account-wide).
- Bezpečné změny vs. nebezpečné: Bezpečné je disarmovat, uložit incident a,
  když stopa existuje, použít přesný `{accountId, symbol}` target. Nebezpečné
  je account-wide fallback tiše rozšířit do ručního DISARMu nebo tvrdit, že
  nemůže zasáhnout ruční pozici.

### INV-DEFAULT-03: Ne-transportní incident má přežít restart a odstranit jej smí jen čistá ruční kontrola

- Proč: Background preflight nebo benigní reconnect nesmí schovat incident,
  který má vidět člověk.
- Vynucuje: `services/copierRuntimeController.ts:bootstrapCopierRuntime`,
  `failClosed`, `performReconciliation`; durable
  `safety.manualRecoveryRequired`. SHADOW a kompatibilní ARM bez `prepareArm`
  už volají `reconcile({ internal: true })` (incident nemažou; dřívější známé
  porušení je opravené, ověřeno 15. 10. 2026). Incident smaže jen ON
  s potvrzením právě tohoto incidentu (`acknowledgeIncidentId`). ON se skupinou
  tuto potvrzenou kontrolu dělá před změnou konfigurace (15. 10. 2026): po
  incidentu + reconnectu visí `pendingReadOnlyConnectionRecovery` a brány
  změny konfigurace by ON jinak odmítly dřív, než dojde na potvrzení
  (produkční deadlock). Incident tak zmizí i když ON pak skončí na validaci
  konfigurace — byl potvrzen a čistě zkontrolován.
- Hlídá test: `tests/copierIncidentLostUpdate.test.ts` (durable incident se neztratí, nesoulad se srovná) a
  `tests/copierWorkerArmPreparation.test.ts` kryje restart,
  preparation a reconnect; `tests/copierIncidentReconnectArm.test.ts` incident
  + reconnect + ON se skupinou (i po restartu, nepřečtený follower, zastaralé
  potvrzení) a past bez incidentu (nečistá/5× selhaná read-only kontrola po
  reconnectu); `tests/copierOnAcknowledgeIncident.test.ts`. **Chybí regrese
  pro zachování incidentu přes SHADOW a kompatibilní ARM bez `prepareArm`**.
- Nikdy: Nemazat `lastError` ani manual-recovery marker při přípravě ON,
  heartbeatu, interním reconnect recovery nebo pouhém restartu.
- Bezpečné změny vs. nebezpečné: Bezpečné je odstranit marker po
  `authoritativelyClean` veřejném `reconcile()` vyvolaném explicitním příkazem
  uživatele. SHADOW a kompatibilní ARM mají sdílet jen interní read-only
  reconciliation bez `clearLastError`; současné volání veřejné metody je
  nebezpečná mezera, ne schválená výjimka.

### ARM brány

### INV-ARM-01: Live ARM projde pouze přes celý soubor bran, ne přes dílčí „ready“ signál

- Proč: Každá brána kryje jinou třídu duplicitní, nechráněné nebo nežádoucí
  expozice.
- Vynucuje: `services/copierRuntimeController.ts:arm` — runtime běží a
  neshutdownuje; processor recovery je `ready`; není startup repair ani
  missing leader route; kill switch je vypnutý; TTL je platné; při požadavku
  je čerstvá preparation receipt; risk je ověřen; skupina je enabled; broker
  connected; žádný stuck outbox, divergence ani working order; source
  nevyžaduje reconciliation; není `safety.managementOnly` ani
  `unconfirmedFlatLots`; není aktivní
  `dayLockUntil`; čas je uvnitř trading window; skončil cooldown;
  `positionCheckComplete`; všechny zapojené účty jsou autoritativně flat;
  leader je eligible; existuje alespoň jeden enabled, ne-`off`, eligible a
  nevyřazený follower. `services/copierRiskGate.ts:haltReason` před dispatchí
  znovu hlídá jen kill, ARM, TTL, connection/heartbeat, environment, sequence,
  stuck outbox a group divergence. Trading window, cooldown, day lock,
  management-only, flat stav a eligibility vynucuje controller dříve; risk
  gate není jejich druhá úplná kopie.
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierRiskGate.test.ts`, `tests/copierArmPreparation.test.ts`,
  `tests/copierPreflightDisarmedReconcile.test.ts`.
- Nikdy: Neslučovat seznam do jednoho booleanu, jehož původ UI neumí doložit;
  nevynechávat flat/no-working kontrolu kvůli tomu, že konfigurace je nová.
- Bezpečné změny vs. nebezpečné: Bezpečné je přidat přísnější bránu a
  strukturovaný blocker. Nebezpečné je použít cache, předchozí session nebo
  částečný účetní snapshot jako náhradu kterékoliv brány.

### INV-ARM-02: Příprava ON je krátce platný read-only důkaz svázaný s přesnou session, konfigurací a routami

- Proč: Přednačtení smí zrychlit ON, ale nesmí převést starý flat/risk snapshot
  na autorizační token po mezilehlé změně.
- Vynucuje: `services/copierRuntimeController.ts:prepareArm`,
  `readFlatPreflightSnapshot`, `hasFreshArmPreparation`,
  `armPreparationRoutes`; receipt obsahuje safety generation, trade ingress
  observation, connection sync generation, serializovanou konfiguraci,
  eligibility, account IDs a per-account route epoch, `positionCheckComplete`
  a risk proof; platí nejvýše 30 s a čtení mají 10s deadline.
- Hlídá test: `tests/copierWorkerArmPreparation.test.ts`.
- Nikdy: Nepublikovat receipt z pozdního čtení, z missing optional followera
  ani z jiné route/session; preparation nesmí volat veřejné `reconcile()`.
- Bezpečné změny vs. nebezpečné: Bezpečné je sdílet právě probíhající
  read-only přípravu a před ARM vše revalidovat. Nebezpečné je prodlužovat její
  platnost heartbeatem nebo přijmout shodné account IDs bez shody route epoch.

### INV-ARM-03: OFF, kill, config change, reconnect a nová obchodní observace zneplatní rozpracovaný nebo hotový ARM důkaz

- Proč: Pozdní výsledek ON nesmí přepsat novější bezpečnostní rozhodnutí.
- Vynucuje: `services/copierRuntimeController.ts:invalidateReconciliation`,
  `dispatchBroker`; `server/localCopierExecutionAgent.ts:execute` a
  `executeCopyCommand` používají brake epoch a deadline.
- Hlídá test: `tests/copierWorkerArmPreparation.test.ts`,
  `tests/localCopierExecutionAgent.test.ts`.
- Nikdy: Nedovolit, aby timeoutovaný nebo zrušený ARM doběhl po novějším
  DISARM/kill příkazu. Úzká výjimka je terminální cancel již známé follower
  objednávky popsaný níže; ten nesmí založit novou expozici.
- Bezpečné změny vs. nebezpečné: Bezpečné je monotónně zvyšovat generation a
  před každým write ji znovu porovnat. Nebezpečné je kontrolovat ji jen při
  začátku příkazu.

### INV-ARM-04: Shadow mode nesmí dispatchovat risk-zvyšující broker write; terminální lifecycle cancel je úzká výjimka

- Proč: Shadow slouží k pozorování a plánování bez nové expozice. Pokud ale
  leader terminálně zruší nebo odmítne již zkopírovanou neochrannou follower
  objednávku, její přesný cancel snižuje riziko osiření.
- Vynucuje: `services/copierRiskGate.ts:evaluateRiskGate` vrací `dispatch=false`
  v shadow; `services/copierRuntimeController.ts:dispatchBroker` shadow znovu
  odmítá kromě `terminalCancel`, který používá
  `services/copierRiskGate.ts:cancelLifecycleHaltReason`. Výjimka platí pouze
  pro cancel známého broker orderu z durable vazby a výslovně vylučuje
  bracket/OSO protective nohy.
- Hlídá test: `tests/copierRiskGate.test.ts`, `tests/copierRunner.test.ts`,
  `tests/copierRuntimeController.test.ts`.
- Nikdy: Nevykládat `armed=true, shadowMode=true` jako live ARM ani výjimku
  nerozšířit na place/modify/OSO nebo protective cancel. Některé live ARM brány
  jsou pro shadow úmyslně volnější, protože risk-zvyšující write je zakázaný.
- Bezpečné změny vs. nebezpečné: Bezpečné je přidat read-only audit. Nebezpečné
  je povolit write „jen do dema“ uvnitř shadow větve.

### DISARM, kill switch a day lock

### INV-BRAKE-01: DISARM zastaví nové kopie, ale sám není obecný příkaz k zavření všech pozic

- Proč: Na follower účtu mohou existovat ruční obchody. Existující prokázaná
  copy epoch může dál potřebovat přesně cílené risk-reducing řízení.
- Vynucuje: `services/copierRuntimeController.ts:disarm`,
  `services/copierLeaderFlatGuard.ts:evaluateLeaderFlatBatch`.
- Hlídá test: `tests/copierDisarmReason.test.ts`,
  `tests/copierLeaderFlatGuard.test.ts`, `tests/copierAutoCloseV9V4.test.ts`.
- Nikdy: Nepřidávat account-wide auto-close do ručního DISARMu a nemaž durable
  leader-flat epoch jen proto, že UI ukazuje OFF.
- Bezpečné změny vs. nebezpečné: Bezpečné je ukončit nové entry a ponechat
  přesné lifecycle guardy. Nebezpečné je buď zavřít celý účet, nebo zahodit
  vlastnictví rozpracované kopie.

### INV-BRAKE-02: Kill switch je jednosměrná západka pro nové riziko; ponechává jen přesně vymezené risk-reducing akce

- Proč: Nouzový freeze musí přebít fronty, recovery i resume nabídky, ale
  nesmí znemožnit uživateli ruční Flatten ani osiřit již známou neochrannou
  follower objednávku po terminálním cancelu leadera.
- Vynucuje: `services/copierRuntimeController.ts:engageKillSwitch`;
  `services/copierRiskGate.ts:haltReason`; kill lze resetovat jen novým
  bootstrapem, který opět startuje DISARMED a vyžaduje kontrolu.
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierChaosScenarios.test.ts`, `tests/localCopierExecutionAgent.test.ts`.
- Nikdy: Nepřidávat „unlock kill“ za běhu ani automatický re-ARM po reconnectu
  mimo INV-RECON-04 (kill switch ho vždy ruší).
  `dispatchBroker` smí přes kill pustit jen úzký `terminalCancel` hlídaný
  `cancelLifecycleHaltReason`; ruční Flatten je samostatná výslovná safety
  akce. Ani jedna výjimka nesmí vytvořit nebo zvětšit expozici.
- Bezpečné změny vs. nebezpečné: Bezpečné je zpřesnit audit a doručení brzdy.
  Nebezpečné je zaměnit kill za dočasný boolean ovládaný posledním poll response.

### INV-BRAKE-03: Brzdy obcházejí běžnou execution FIFO a mohou použít poslední ověřenou route i bez čerstvého statusu

- Proč: Právě při výpadku nebo visícím příkazu nemusí být čerstvý status;
  čekání na něj by zablokovalo OFF/kill/day-lock.
- Vynucuje: `server/localCopierExecutionAgent.ts:execute`,
  `lib/localCopierAgentProtocol.ts:isLocalCopierEmergencyCommand`,
  `lib/copierSafetyControls.ts:selectCopierSafetyRoute`,
  `components/TradovateLiveDesk.tsx:executeSafetyCommand` a
  `lastAgentRouteRef`.
- Hlídá test: `tests/localCopierExecutionAgent.test.ts`,
  `tests/copierSafetyControls.test.ts`, `tests/tradovateCopierCommandRelay.test.ts`.
- Nikdy: Nevázat zobrazení/odeslání DISARM a kill na fresh-15s gate běžných
  příkazů.
- Bezpečné změny vs. nebezpečné: Bezpečné je použít poslední ověřenou route a
  výsledek dál sledovat. Nebezpečné je odstranit tlačítko při unknown statusu.

### INV-BRAKE-04: Day lock čeká na flat a ručně se neodemyká; relay příkaz jej fixuje na konec session

- Proč: Zamknutí uprostřed obchodu nesmí opustit kopie; ruční odemknutí by
  obešlo anti-revenge pojistku.
- Vynucuje: `services/copierRuntimeController.ts:maybeEngageDayLock`, `lockUntil`,
  `unlockDay`; `server/localCopierExecutionAgent.ts:execute` pro
  `lock-until-session-end` počítá `tradovateSessionEndAt(commandCreatedAt)`.
  Samotné controller API `lockUntil(until, reason)` přijme libovolný platný
  budoucí čas; session-end omezení tedy garantuje protokolový příkaz, ne typ
  ani controller metoda.
- Hlídá test: `tests/copierDayRuleActions.test.ts`,
  `tests/copierArmSession.test.ts`, `tests/copierRuntimeController.test.ts`.
- Nikdy: Neaktivovat lock jako důvod k account-wide close uprostřed expozice a
  nepřidávat běžné UI odemknutí.
- Bezpečné změny vs. nebezpečné: Bezpečné je uložit pending lock a aplikovat ho
  po potvrzeném flat. Nebezpečné je počítat konec pevnými 24 hodinami bez DST.

### INV-BRAKE-05: Expirace ARM nejprve odzbrojí a podle `armExpiryFlatten` spustí přesně cílený close nebo vědomý account-wide fallback; shadow jej nespouští

- Proč: Samotná expirace nesmí nechat vlastněné kopie bez dozoru. Kde runtime
  zná copier stopu, zavírá konkrétní účty a symboly; kde u zapojeného účtu vidí
  expozici, ale nezná ani jeden cílový symbol, volí fail-safe account-wide
  fallback, který může zasáhnout i ruční pozici.
- Vynucuje: `services/copierRuntimeController.ts:maybeHandleArmExpiry` a
  `autoFlattenCopies`; scope pochází z
  `services/liveCopyTrading.ts:DEFAULT_COPY_GROUP_SAFETY.armExpiryFlatten`.
  `copierFootprintSymbols` zahrne pro followera každý symbol, který právě drží
  leader, a durable epoch/outbox/pending/cut stopy. `armExpiryFlatten: 'group'`
  zahrnuje také leader účet. Bez jakékoli stopy se `flatten()` volá bez targetů
  a `cleanupScope: 'target-symbol-or-account'` přejde pro daný účet na
  account-wide úklid.
- Hlídá test: `tests/copierAutoCloseV9V4.test.ts`,
  `tests/copierRuntimeController.test.ts`, `tests/copierChaosScenarios.test.ts`.
- Nikdy: Neprovádět expiry close v shadow režimu ani při policy `off`; nečekat
  s DISARM na dokončení close. Policy `off` vypíná broker close, nikoli
  povinnou read-only kontrolu po reconnectu. Account-wide fallback nesmí být
  dokumentován jako přesný ownership důkaz.
- Bezpečné změny vs. nebezpečné: Bezpečné je nejprve durable zaznamenat
  `arm-expiry`, vypnout gate a teprve potom spustit ohraničený close. Nebezpečné
  je prodloužit ARM kvůli tomu, že auto-close právě běží.

### Kontrola pozic a reconciliation

### INV-RECON-01: Reconnect, restart a invalidace vyžadují novou autoritativní kontrolu; reconnect nikdy sám neARMuje (jedinou výjimkou je INV-RECON-04)

- Proč: Události mohly během mezery chybět a historický model nemusí odpovídat
  venue.
- Vynucuje: `services/copierLeaderEventSource.ts:needsReconciliation` a
  `acknowledgeReconciliation`; `services/copierRuntimeController.ts:invalidateReconciliation`,
  `performReconciliation`, connection recovery.
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierChaosScenarios.test.ts`, `tests/copierGraceReconnectD1.test.ts`.
- Nikdy: Nepovažovat `connected=true` nebo úspěšný WS sync za povolení k ARM.
- Bezpečné změny vs. nebezpečné: Bezpečné je po reconnectu automaticky udělat
  read-only kontrolu a zůstat OFF. Nebezpečné je obnovit minulý ON stav —
  kromě úzké cesty INV-RECON-04, která stejně projde všemi branami ON.

### INV-RECON-04: Automatické pokračování po výpadku spojení (10. 10. 2026, rozhodnutí Filipa)

- Proč: Krátký výpadek ve flat stavu nemá znamenat, že kopírka zbytek dne
  stojí, dokud si toho člověk nevšimne.
- Vynucuje: controller `transportResume` (jen v paměti; restart ho zahodí),
  `evaluateTransportResume`, `arm({ autoResume })`; agent `autoRearmTick` +
  `autoResumeAttempt`; serverová pojistka `admitCopierAutoResume`
  (`server/tradovateCopierCommandRelay.ts`, akce relay `auto-resume-admit`).
- Podmínky (všechny): disarm triggerem `transport` z živého ARM; skupina byla
  při výpadku flat bez příkazů (zapojené účty) NEBO v obchodu, který první
  obnova přijala jako „držené kopie“ (viz níže); bez incidentu a mimo
  managementOnly; čekající příkaz bez pozice = odmítnout; mezitím žádné jiné vypnutí, ruční DISARM, kill switch,
  uspání Macu, incident ani změna konfigurace; leader v mezeře neobchodoval
  (denní statistiky beze změny, žádný příkaz leadera s časem ≥
  min(výpadek − 30 s, poslední heartbeat − 5 s) ani s vyšším ID; bez
  čitelného času = odmítnout); čerstvá read-only příprava
  (`hasFreshArmPreparation`), nikdy veřejné `reconcile()`; TTL nejvýš do
  konce původního zapnutí; agent: stejná brzdová epocha a skupina jako při
  ručním ON, tatáž session, prázdné vyzvednutí relay fronty po reconnectu,
  grace 15 s, server potvrdí, že od ručního ON (−60 s rezerva) nepřišla žádná
  brzda a nic nečeká; jeden pokus za epizodu; nejvýš 2 automatická pokračování
  na jedno ruční ON. Zapnutí jde přes `armCore` se všemi branami INV-ARM-01.
  Souběh s ručním ON: automatický pokus ustoupí; úspěšné ruční ON epizodu
  ukončí, neúspěšné ji nechá k dalšímu ticku.
- Obchod leadera v mezeře nezávisle na hodinách: jakýkoli příkaz leadera
  s vyšším (monotónním Tradovate) ID, než controller znal při výpadku
  (maximum z eventů, preflightu i reconciliace) = odmítnout. Čekání má strop
  60 min od výpadku (a nikdy přes konec původního zapnutí).
- Slepé okno: tichý výpadek se pozná až po idle timeoutu a heartbeat může
  dodat socket followera — příkaz leadera s časem ≥ min(výpadek − 30 s,
  poslední heartbeat − 5 s) i jakýkoli fill leadera v resync `gapFills` =
  odmítnout. Pozor: router při skutečném reconnectu `resync` neposílá, takže
  `gapFills` je jen doplněk; rozhodují statistiky, čas a ID příkazů. Ruční Flatten (účet / All / follower) a waive epizodu ruší;
  zámek dne a obchodní okno ji ruší, cooldown jen odkládá. Stav `resumed`
  se po jakémkoli dalším vypnutí ve statusu nehlásí; selhání po zapnutí ho
  přepíše na `declined`. Dedup stejné chyby ve `failClosed` platí jen za už
  vypnuté kopírky (jinak by druhý stejný výpadek nezaložil epizodu).
- Serverová pojistka: brzdy celého uživatele (všechna zařízení) od
  min(ON na Macu − 60 s, serverový čas posledního vzdáleného `arm-live`,
  pokud patří k tomuto zapnutí — leží v okně ON − 5 min … ON + 60 s);
  po pojistce se příprava read-only obnoví (žádné `reconcile()`);
  nedostupnost sítě = až 3 opakování pojistky, nikdy ARM. Zbytkové okno:
  brzda zařazená až PO odpovědi pojistky a před `arm()` (~latence relay)
  se provede až po zapnutí — stejně jako u ručního ON (INV-ARM-03).
- Otevřený obchod při výpadku (10. 10. 2026): první obnova přijme stav jako
  „držené kopie“ (bez incidentu) jen když nejsou divergence ani chybějící
  lineage a `protectiveHoldProblem()` nic nenajde: leader má jen příkazy
  snižující pozici; každý zapojený follower s pozicí má jen ochranné nohy
  kopírky (ID z outboxu/links), každou snižující, a pro každou třídu
  (stop / target), kterou má leader, součet zbytků přesně = pozice; žádná
  třída pozici nepřesáhne. Jinak incident jako dřív. Kopírka zůstává
  DISARMED, posuny SL leadera se nezrcadlí, ARM blokuje
  `pendingConnectionRecovery`; po vyřešení leader-flat guardu se obnova
  spustí znovu (read-only) a čistá ji dokončí.
  Automatické pokračování z drženého obchodu: první obnova musí potvrdit
  živý obchod a deník leadera musí sedět s jeho pozicí bez nového ID
  příkazu (jinak = obchodoval v mezeře, odmítnout); další výpadek během
  držení = odmítnout; konec obchodu pozorovaný živě s deníkem flat (bez
  otevřených a nepotvrzených lotů) = nový výchozí bod statistik a ID,
  pak běžné kontroly a 60min strop od něj. Samotné držení omezuje jen konec
  původního zapnutí (nejvýš do konce session). Obchod ukončený už během
  výpadku nebo kopie skončené jinak než leader = odmítnout.
- Výpadek je jeden i když Tradovate pošle `error` a pak `connection:false`;
  „další výpadek“ je jen disconnect po pozorovaném reconnectu. Požadovaná
  ochrana followera per třída = min(pozice, Σ trunc(zbytek leaderovy nohy ×
  násobek)), nejméně 1 a nejvýš pozice (runner: stop 2, TP 1). Flat skupina,
  kde pracovní příkaz má jen leader = žádný incident, jen nepokračuje.
  Držený obchod bez SL/TP: po vyřešení guardu se obnova vynutí taky. Čistá
  obnova smaže `lastError`, jen když pochází výhradně z výpadků spojení
  (`lastErrorTransportOnly`; i víc různých chyb jednoho výpadku) a není
  incident. Ochrana followera je odvozená per nohu (floor × násobek) stejně,
  jak ji kopírka zakládá — může tedy být o zbytek menší než pozice; panel
  proto mluví o „ochraně z doby před výpadkem“, ne o plném krytí.
- Hlídá test: `tests/copierTransportAutoResume.test.ts`, `tests/copierOutageMidTrade.test.ts`,
  `tests/copierArmSelfCheck.test.ts`, `tests/copierAutoResumeAdmission.test.ts`,
  `tests/copierIncidentWatchdog.test.ts`.
- Nikdy: Opakovat pokus, prodloužit TTL, pokračovat po restartu workeru,
  pokračovat bez serverové pojistky, mazat incident nebo managementOnly.

### INV-RECON-02: Veřejné `reconcile()` je auditovaný recovery úkon; interní kontroly nesmí mazat incident

- Proč: Stejná čtení mají jinou autoritu podle toho, zda člověk výslovně
  zahájil recovery.
- Vynucuje: `services/copierRuntimeController.ts:reconcile` volá
  `performReconciliation({clearLastError:true})`; interní volání používají
  výchozí `clearLastError=false`; `runReconciliation` maže chybu jen při
  `authoritativelyClean`, nezměněné generation a neaktivním kill switchi.
  SHADOW a kompatibilní ARM bez `prepareArm` volají `reconcile({ internal: true })`
  (dřívější porušení hranice opravené; ověřeno 15. 10. 2026). Veřejné
  `reconcile()` volá jen výslovný úkon uživatele: ON (Etapa 1 i časná kontrola
  před změnou konfigurace) a samostatná Kontrola pozic.
- Hlídá test: `tests/copierPreflightDisarmedReconcile.test.ts`,
  `tests/copierWorkerArmPreparation.test.ts`, `tests/copierRuntimeController.test.ts`.
- Nikdy: Nevolat veřejné `reconcile()` z background preflightu, SHADOW,
  kompatibilního ARM nebo jako vedlejší efekt zobrazení stránky. První dvě
  cesty jsou současný defect evidovaný v sekci 5, ne povolená výjimka.
- Bezpečné změny vs. nebezpečné: Bezpečné je sdílet nízkoúrovňové read-only
  funkce. Nebezpečné je sdílet i `clearLastError`/manual recovery side effect.

### INV-RECON-03: Reconciliation snapshot je serializovaný a platí jen při nezměněné safety generation a observation verzi

- Proč: Starší pomalé čtení nesmí přepsat novější broker event nebo safety
  příkaz.
- Vynucuje: `services/copierRuntimeController.ts:performReconciliation`,
  `runReconciliation`, `ReconciliationStaleSnapshotError`.
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierRouteGapV6.test.ts`.
- Nikdy: Necommitovat pomalý snapshot po mezilehlém fillu, reconnectu,
  config změně nebo DISARMu.
- Bezpečné změny vs. nebezpečné: Bezpečné jsou bounded read-only retry po
  stale výsledku. Nebezpečný je retry broker write nebo odstranění generation
  revalidace kvůli latenci.

### Outbox a idempotence

### INV-OUTBOX-01: Broker write se uloží před odesláním a po timeoutu se nikdy neopakuje naslepo

- Proč: Tradovate `clOrdId` pomáhá korelaci, ale negarantuje deduplikaci;
  opakovaný POST může být druhý obchod.
- Vynucuje: `services/copierRunner.ts:processLeaderEvent`, `recoverOutbox`;
  `services/copierOutbox.ts:nextAction`, `resolveLookup`.
- Hlídá test: `tests/copierOutbox.test.ts`, `tests/copierRunner.test.ts`,
  `tests/copierChaosScenarios.test.ts`.
- Nikdy: Neopakovat `placeOrder`, protože HTTP/WS ACK nedorazil, a neoznačit
  `unknown` za `rejected` bez autoritativního lookupu.
- Bezpečné změny vs. nebezpečné: Bezpečný je lookup podle account/order/tag
  a retry jen po autoritativním důkazu, že objednávka nevznikla. Nebezpečný je
  časový retry nebo víra v unikátnost `clOrdId`.

### INV-OUTBOX-02: `sending`, `unknown`, `rejected` a `abandoned` zůstávají ARM-blocking, dokud nemají explicitní bezpečné rozuzlení

- Proč: Terminální transportní label sám nedokládá nulový fill ani nulovou
  expozici.
- Vynucuje: `services/copierOutbox.ts:stuckEntries`,
  `services/copierCancelOutbox.ts:stuckCancelEntries`,
  `services/copierRuntimeController.ts:currentStuckOperations`.
- Hlídá test: `tests/copierOutbox.test.ts`,
  `tests/copierCancelOutboxResolution.test.ts`, `tests/copierRuntimeController.test.ts`.
- Nikdy: Neschovávat stuck položku kvůli stáří, restartu nebo tomu, že UI účet
  momentálně nezobrazuje.
- Bezpečné změny vs. nebezpečné: Bezpečné je autoritativní recovery nebo
  explicitní auditovaný waiver. Nebezpečné je automatické TTL smazání.
- Waiver z UI (`resolve-stuck-operation`, dvojí potvrzení v LIVE) jde od
  17. 10. 2026 i přes relay (iPhone / web mimo Mac): relay pustí jen přesný
  tvar (kind z výčtu, key, reason ≥ 5 znaků, nic navíc) na enqueue i claim
  straně; worker položku durable označí, kopírku vypne a vynutí novou kontrolu
  pozic. Dřív relay příkaz odmítl a visící odmítnutá objednávka blokovala
  i smazání skupiny bez cesty z telefonu.

### INV-OUTBOX-03: OCO/OSO je atomický celek; částečný venue tvar se automaticky nedostavuje

- Proč: Samostatná chybějící ochranná noha nebo duplicitní parent mění riziko
  jinak než původní požadavek.
- Vynucuje: `services/copierBracketOutbox.ts:resolveBracketLookup`,
  `services/copierOsoOutbox.ts:resolveOsoLookup`,
  `services/copierRunner.ts:processBracketPair` a `processOsoPair`.
- Hlídá test: `tests/copierBracketOutbox.test.ts`,
  `tests/copierOsoOutbox.test.ts`, `tests/copierTradovateLifecycle.test.ts`.
- Nikdy: Po partial lookupu neposílat chybějící nohu automaticky a netvrdit
  plný úspěch z jediné nalezené nohy.
- Bezpečné změny vs. nebezpečné: Bezpečné je stav označit `abandoned`/
  management-only a žádat recovery. Nebezpečné je heuristicky doplnit tvar.

### Divergence

### INV-DIVERGENCE-01: Divergence není příležitost k dorovnávacímu obchodu; default je `halt-group`, důkazně izolovaný follower je úzká výjimka

- Proč: Bez spolehlivé kauzality nelze poznat, zda rozdíl pochází z ručního
  obchodu, chybějícího eventu nebo neznámého fillu.
- Vynucuje: `services/copierRiskGate.ts:haltReason` a
  `services/copierRuntimeController.ts:performReconciliation` (výjimka
  ochranného fillu: `protectiveLegOwner` / `prepareProtectiveIsolation`). V16 dovoluje
  místo haltu izolovat konkrétního ineligible followera jen s episode-bound
  důkazem přes `authoritativelyIsolateFollowerForEpisode` /
  `episodeIsolationFromSnapshot`: přesná lineage, flat/no-working a žádný
  nejasný zbytek. Incident 6. 10. má obdobně úzkou all-or-nothing izolaci
  followera, jehož protective order se vyplnil během modify. Od 19. 10. platí
  i pro samostatný Stop přidaný po vstupu, ale jen když kopie při odeslání
  durable uložila `protectiveEpochId` a ta je pořád otevřená epocha; legacy
  položka bez epochy nebo stop z jiné epizody zůstává fail-closed. Epocha je
  jen štítek — bezpečnost dál nesou autoritativní fill přesně na potvrzenou
  kopii, flat/no-working celého účtu a nezměněný leader.
- Hlídá test: `tests/copierRiskGate.test.ts`,
  `tests/copierRuntimeController.test.ts`,
  `tests/copierV16EpisodeIsolation.test.ts`,
  `tests/copierProtectiveFilledDuringModify.test.ts`,
  `tests/copierStandaloneStopFilledDuringModify.test.ts`.
- Nikdy: Neopravovat rozdíl Market příkazem ani „Auto-Syncem“.
- Bezpečné změny vs. nebezpečné: Bezpečné je disarmovat, ukázat účty a po
  ručním zásahu autoritativně zkontrolovat flat, případně použít výše uvedenou
  důkazní izolaci jednoho followera. `services/copierEngine.ts:planReconciliation`
  je nevolaný mrtvý export, který plánuje Market dorovnání; pravidlo nevynucuje
  a jeho zapojení by je porušilo.
- **Follower čeká na svou kopii vstupu (12. 10. 2026, varianta 1 Filipa)** není
  divergence: leaderův Limit/OSO vstup se vyplnil hned, kopie followera dorazila
  pozdě a pracuje dál. `verifyFollowerMagnitude` ji pozná přes
  `awaitingCopiedEntry` (čerstvá pending expozice: leader celý vyplněný, kopie
  otevřená a pokrývá přesně zbytek do očekávané pozice) a nefailne; konec kopie
  (cancel/reject/fill) spustí novou kontrolu. Nic se nedokupuje. Když leader
  dřív snižuje: Market i Limit/Stop výstup jde přes S1b (`s1bReadCandidates`)
  — kopie vstupu se zruší, a teprve po důkazu jejího nulového fillu flat sweep
  zruší kopírkou vlastněné ochranné příkazy followera (pozastavené OSO nohy,
  zrcadlený Stop); follower vynechá obchod (suppression allowedNet 0). Nohy se
  nikdy neruší před tím důkazem — kopie se mohla mezitím vyplnit. Ne-Market
  redukce s čekajícím followerem jde rozděleně (`nonMarketS1bSplit`), aby S1b
  čekajícího nezdrželo ani nezablokovalo synchronní followery. Výjimka:
  ochranný Stop za cenou čekajícího Limit vstupu followera bez jakéhokoli fillu
  se nemůže vyplnit dřív než vstup, zrcadlí se jako dosud (V12/R12). Leader flat
  (vlastní SL/TP nohou) zruší otevřený OSO vstup flat followera přes
  `sweepFollowerProtectiveLegs` (souběžně pro všechny); u z části vyplněného
  followera zruší jen nevyplněný zbytek kopie vstupu
  (`cancelPartialCopiedEntryRemainder`, V3), pozici dál chrání jeho nohy a
  leader-flat guard. Sweep a důkaz suppression po S1b zrušení
  (`queueS1bPostCancelCleanup`, V1) startují hned po důkazu nulového fillu, ale
  čeká se na ně a jejich selhání se uplatní jako incident až po rozeslání
  příkazu všem followerům (`settleS1bPostCancelCleanups` ve `finally` broker
  eventu, jinak další krok `eventTail`); incident nese vlastní příčinu a při
  pozici na followerovi (vyplněný zrcadlený stop) vede k auto-close (V5).
  Výjimka zrcadleného Stopu se nepoužije, dokud má follower nezpracovaný
  obchodní event (V5). Samostatný SL leadera z bracket okna dostanou ověření
  followeři i vedle neověřeného; fail-closed až po dispatchi (V4). Po každém
  vypnutí (incident, ruční DISARM, Kontrola pozic, obnova po výpadku)
  `cancelStrandedCopiedEntries` jednou zruší ne-Market kopii vstupu s přesnou
  lineage z durable outboxu, když broker autoritativně hlásí leaderův vstup
  celý vyplněný a kopii followera pracující s nulovým fillem; nohy pak uklidí
  sweep (V2). Follower s pozicí (scale-in stejným směrem) se zruší jen tehdy,
  když ho kopie podle čerstvé pozice followera i leadera doplní přesně na
  leadera; kopie proti pozici followera (reverz) ani z části vyplněná se
  neruší. V2 jde ve frontě až za auto-close a při kill switch neběží
  (explicitní freeze, žádná automatika). Odložený S1b incident spustí
  auto-close jen tehdy, když kopírku vypnul incident, ne ruční DISARM. Stav čekání je ve statusu (`awaitingCopiedEntries`, jen za ARM)
  a v LIVE řádku jako „Čeká na vstup“ (V6). Hlídají testy:
  `tests/copierAwaitingCopiedEntry.test.ts`,
  `tests/copierAwaitingEntryBracketStop.test.ts`,
  `tests/liveCopyAwaitingEntryRender.test.ts`,
  `tests/copierBracketAwaitingEntryFill.test.ts`.
  **Pár SL+TP vzniklý až po vyplnění leadera (bracket strategie, 16. 10. 2026):**
  dřív šel přes `processBracket` jako OCO na plné množství všem followerům
  s kopií vstupu — i čekajícím; TP Limit pak flat followery otevřel do shortu.
  Teď OCO dostane jen follower s kladným důkazem pozice
  (`bracketFollowerPositionProven`: cache = trunc(preNet × mult) bez
  nezpracovaného eventu, nebo přesně doplněná potvrzenou Market kopií aktuální
  epochy) — hned. Ostatní jdou přes `guardBracketPairFollowers`:
  1. **Přeměna na OSO (Filip 17. 10.)** `convertAwaitingCopyToOso` — follower
     čeká dál na svůj limit, SL/TP jsou u brokera neaktivní do vyplnění
     vstupu. Jen čistý případ: flat follower, jediná **Limit** kopie s nulovým
     fillem a platnou pending expozicí, otevřené vstupní brány včetně celé
     `haltReason`, bez `maxContracts`, leader dál v obchodu (obě nohy pracují
     bez fillu, pozice beze změny, žádný nezpracovaný leader event). Čtení →
     cancel přes `dispatchBroker(admissionGeneration)` (jediný zápis, odvolaný
     = zpět na S1b) → postkontrola: vyplněno = OCO; nulový fill a cancel náš =
     OSO se stejnou cenou/velikostí a cenami nohou z páru (pozdější replace
     zrcadlí planModify na nativní nohy), obal `placeOso` těsně před zápisem
     znovu ověří brány a leadera; kopii zrušil někdo jiný nebo brány pominuly
     = follower vynechá (úklid jako S1b); částečné/nejasné = unsafe. Po OSO:
     registrace pending expozice (vlastní id eventu `:oso-convert:`), vstup
     z ACK do `liveOrdersByAccount` (kontrola velikosti i V2 o něm ví před
     order eventem), zrušená kopie do `s1bCanceledZeroFillOrderIds` (pozdní
     fill = stop skupiny), `convertedOsoFollowers`. Když leader pak sníží
     pozici dřív, než se followerovi vstup vyplní, kontrola velikosti OSO
     zruší (sweep + suppression) a follower obchod vynechá. Odmítnuté nebo
     nejisté OSO = fail-closed bez auto-close.
  2. Co se přeměnit nedá před zrušením kopie: pár se posoudí celý jako ne-Market
     redukce (TP Limit, bez výjimky ochranného Stopu) stávajícím S1b
     (`cutAwareDispatchFor`) — čekající kopie se zruší a follower obchod vynechá.
  3. Followeři bez kandidáta: čtení pozice + čerstvých příkazů u brokera (1,5 s):
     shoda = OCO; ochranu bez incidentu vynechá jen follower prokazatelně flat
     bez otevřených příkazů a bez čekající kopie (ruční zavření → kontrola
     velikosti); cokoli jiného = fail-closed **bez auto-close**. Čerstvý výpis
     příkazů se zapíše do `liveOrdersByAccount` (V2 po vypnutí). Divergence jen
     z cache (zpožděný position event) skupinu nevypne.
  Známé limity: přeměna ztrácí pořadí ve frontě na limitu (cancel/replace) a
  mezi cancel a OSO nemá follower v knize nic; neaktivní nohy OSO a jejich
  velikost po částečném fillu stojí na nativní sémantice Tradovate (stejně jako
  u kopírovaných OSO tiketů), na mocku neověřitelné; ověřování drží frontu eventů
  až ~14 s (prokázaní followeři jsou chránění hned, brzdy obcházejí FIFO);
  DISARM mezi okamžitým OCO a ověřením ostatních ověření přeskočí;
  převedený OSO vstup z části vyplněný a leader sníží přesně na jeho úroveň:
  zbytek vstupu dál pracuje a pozdější fill skončí divergencí (incident, ne
  nechráněná pozice); `unknown` OSO z přeměny bez ID nezruší V2 (ručně podle
  incidentu); scale-in leadera při čekajícím převedeném OSO neověřen;
  `rememberLiveOrderSnapshot` z REST čtení bez observation fence. Známé limity: částečně vyplněná
  čekající kopie u ne-Market redukce dál končí incidentem (V12/Z10); po
  reconnectu je pending expozice prázdná a čekající follower vede k incidentu
  (kopii pak zruší V2 při obnově); reverzní Limit/Stop leadera při čekajícím
  followerovi jde nerozděleně — neověřený follower zastaví i otevření
  protipozice ostatním (záměrně: před incidentem se nová expozice neotevírá);
  čekání u scale-inu (follower už v pozici) varianta 1 nepokrývá — kontrola
  velikosti skupinu vypne a čekající kopii pak zruší V2; stav čekání se
  ukazuje jen za ARM;
  zrušení zbytku z části vyplněného OSO vstupu u Tradovate (kaskáda na aktivní
  nohy) není ověřené proti živému brokeru.

### Pořadí a čerstvost stavu

### INV-FRESH-01: Safety generation a broker observation fence chrání raw write i výsledky pomalých čtení

- Proč: Kontrola provedená pouze na vstupu do async operace zastará během
  čekání na broker/store.
- Vynucuje: `services/copierRuntimeController.ts:dispatchBroker`,
  `invalidateReconciliation`, `performReconciliation`. Výjimkou je pouze
  `terminalCancel`: u přesného cancelu známé neochranné follower objednávky
  `dispatchBroker` záměrně nepoužije kill/DISARM/generation/shadow brány a
  kontroluje jen `cancelLifecycleHaltReason` (živé čerstvé spojení a správné
  prostředí).
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierV12Staleness.probe.test.ts`, `tests/copierRouteGapV6.test.ts`.
- Nikdy: Nepřesouvat finální generation check před await broker callu ani
  výjimku nerozšířit mimo terminální cancel z durable vazby.
- Bezpečné změny vs. nebezpečné: Bezpečné je přidat další monotónní epochu.
  Nebezpečné je použít wall-clock timestamp jako jediný fence.

### INV-FRESH-02: UI přijímá status jen v pořadí worker epochy a revision; poll nesmí přepsat novější mutation ACK

- Proč: Relay, local agent a browser poll mohou odpovědět mimo pořadí.
- Vynucuje: `lib/copierStatusPollFence.ts:CopierStatusPollFence`,
  `CopierStatusAckFence`, `shouldAcceptCopierStatus`;
  `components/TradovateLiveDesk.tsx:acceptAgentStatus`.
- Hlídá test: `tests/copierStatusPollFence.test.ts`,
  `tests/copierRelayStatusPoll.test.ts`.
- Nikdy: Neřadit status pouze podle arrival time nebo stejné `revision` napříč
  restarty.
- Bezpečné změny vs. nebezpečné: Bezpečné je kombinovat `startedAt` a
  monotónní revision. Nebezpečné je odstranit poll invalidaci kolem mutací.

### INV-FRESH-03: Worker status starší než 15 s ani obnovená cache nesmí autorizovat běžný příkaz

- Proč: UI může přežít reload, uspání nebo mrtvý worker, zatímco poslední
  hodnoty vypadají věrohodně.
- Vynucuje: `lib/copierForegroundPoller.ts:isCopierStatusFresh`,
  `lib/copierSafetyControls.ts:copierAgentCommandAllowedWhileRestored`,
  `components/TradovateLiveDesk.tsx:armStatusRef` a jednotlivé ARM/config
  brány. `executeAgent` sám kontroluje pouze příznak restored stavu, nikoli
  15sekundové stáří; obecné copy-commandy mají další fresh kontrolu v adapteru.
- Hlídá test: `tests/copierForegroundPoller.test.ts`,
  `tests/copierSafetyControls.test.ts`, `tests/copierPowerDisplay.test.ts`.
- Nikdy: Nepoužít localStorage/restored status pro ARM, změnu skupiny,
  reconciliation nebo risk-zvyšující příkaz.
- Bezpečné změny vs. nebezpečné: Bezpečné je cache zobrazit jako „obnovené“ a
  dovolit přesně vyjmenované risk-reducing Flatteny. Nebezpečné je zobrazit
  cached ON jako potvrzený live stav.

### Relay příkazy

### INV-RELAY-01: Jeden relay enqueue má idempotency key, konečné TTL a jeden durable výsledek; nový klientský pokus dnes dostane nový klíč

- Proč: Retry stejného HTTP záměru nemá založit druhou execution. Současný
  klient ale při každém volání `executeTradovateCopierRelayCommand` generuje
  nový `randomUUID()`, takže klíč chrání jen opakování požadavku se zachovaným
  payloadem/klíčem, nikoli dvojklik nebo nové volání po nejisté odpovědi.
- Vynucuje: `server/tradovateCopierCommandRelay.ts:enqueueTradovateCopierCommand`,
  `findInFlightFlatten`, `findInFlightArm`, `coalesceInsertedArm`; brzdy mají
  TTL 10 min, běžné příkazy 30 s a durable pole `idempotencyKey`. In-flight
  Flatten a ARM mají navíc serverové coalescing; DISARM, reconcile a ostatní
  copy-commandy se s novým klíčem mohou zařadit vícekrát.
- Hlídá test: `tests/tradovateCopierCommandRelay.test.ts`,
  `tests/copierRelayDetailedReview.test.ts`.
- Nikdy: Vydávat současný náhodný klíč per call za ochranu proti dvojkliku;
  odlišný současný ARM payload naopak nesmí být deduplikován jako shodný.
- Bezpečné změny vs. nebezpečné: Bezpečné je při transportním retry zachovat
  původní klíč a dohledat původní command. Nebezpečné je po nejisté odpovědi
  automaticky znovu enqueueovat mutaci s novým UUID.

### INV-RELAY-02: Obnovuje se transport a ACK, nikoli execution, která už začala

- Proč: Po ztracené odpovědi nelze vědět, zda broker side effect proběhl.
- Vynucuje: `server/recoverableCopierDelivery.ts:recoverableCopierDelivery`,
  `server/macCopierCommandRelay.ts:startMacCopierCommandRelay`.
- Hlídá test: `tests/recoverableCopierDelivery.test.ts`,
  `tests/macCopierCommandRelay.test.ts`.
- Nikdy: Po restartu relay nebo chybě ACK znovu nespouštět command ve stavu
  `executing`.
- Bezpečné změny vs. nebezpečné: Bezpečné je znovu poslat completion ACK.
  Nebezpečné je interpretovat chybějící ACK jako „neprovedeno“.
- Osiřelá delivery (29. 10. 2026): checkpoint `executing`/`completed`, jehož
  `delivery_id` DB nezná (obnova DB, ruční zásah), relay nezasekne. Neznámá
  delivery bez fronty → checkpoint se zaloguje (`RELAY DELIVERY ORPHANED`)
  a zahodí. DB svázala delivery s jiným příkazem → ten se zpracuje nad
  čerstvým checkpointem (nikdy s výsledkem/session původního): brzda se
  provede, ostatní se odmítnou `command-rejected-relay-delivery-recovered`
  (netvrdí „neprovedeno“). Řádek s naší delivery zase `pending` → zaloguje
  se a vezme pod novou delivery. Relay si pamatuje id zahájených příkazů této
  session (`COPIER_RELAY_STARTED_MEMORY`); ne-brzdu z nich DB vydanou znovu
  neprovede (`command-outcome-unknown-already-started-this-session`). Po
  restartu stejnou roli hraje `created < startedAt`. Vědomě nepokryto: ACK
  trvale 409, když DB zná novější `startedAt` (INV-WORKER-02/03). Test:
  `tests/recoverableCopierDeliveryOrphan.test.ts`.

### INV-RELAY-03: Novější brzda superseduje starší ARM a durable čekající brzda není selhání

- Proč: OFF může dorazit během pomalého ON; falešná chyba po úspěšném enqueue
  svádí k duplikaci.
- Vynucuje: `server/tradovateCopierCommandRelay.ts:expirePendingArmsSupersededByBrake`,
  `server/localCopierExecutionAgent.ts:execute`,
  `lib/copierBrakeDelivery.ts:CopierBrakeQueuedError`.
- Hlídá test: `tests/tradovateCopierCommandRelay.test.ts`,
  `tests/localCopierExecutionAgent.test.ts`, `tests/copierRelayApiDetailedReview.test.ts`.
- Nikdy: Nedovolit ARM s `createdAt` před poslední brake epoch a nehlásit 502,
  když brzda už durable čeká.
- Bezpečné změny vs. nebezpečné: Bezpečné je ukázat platnost fronty do
  `expiresAt`. Nebezpečné je po UI timeoutu brzdu automaticky zopakovat.

### INV-RELAY-04: Realtime kanály jsou jen optimalizace a zobrazení; nenesou příkazy ani rozhodovací stav (26. 10. 2026)

- Proč: Kick i kanál ceny jsou veřejné kanály s anon klíčem — kdo zná téma,
  může poslouchat i posílat. Poll relaye (~750 ms) zůstává jedinou cestou
  příkazů.
- Vynucuje: `server/tvPriceChannel.ts` (téma a klíč odvozené ze zařízení,
  nikdy nevyhodí; chyba = pole se vynechá, žádné 502 na cestě brzd),
  `server/macCopierCommandRelay.ts` (konfigurace kanálu se předá bez
  čekání), `lib/tvPriceChannelClient.ts` (podpis, přehrání, strop fronty
  ověřování).
- Hlídá test: `tests/copierRelayPriceChannel.test.ts`,
  `tests/tvPriceStreamWiring.test.ts`, `tests/tvPriceChannelClient.test.ts`.
- Nikdy: Poslat přes Realtime příkaz, ARM/DISARM, risk ani stav, podle
  kterého se rozhoduje; logovat téma nebo klíč; čekat v poll smyčce na
  přihlášení ke kanálu.
- Bezpečné změny vs. nebezpečné: Bezpečné je kanál vypnout (pole chybí)
  — kopírka jede dál přes poll. Nebezpečné je z přítomnosti zpráv
  odvozovat čerstvost workeru (INV-FRESH-03).

### Způsobilost účtů

### INV-ELIG-01: Stav účtu je `active`, `dll-locked`, `breached` nebo `unverifiable`; neověřitelný účet je fail-closed

- Proč: Chybějící OAuth/account directory není důkaz zdravého ani flat účtu.
- Vynucuje: `services/copierEngine.ts:CopierAccountEligibility`,
  `services/copierRuntimeController.ts:currentIneligibleAccounts` a
  `performReconciliation`.
- Hlídá test: `tests/copierAccountEligibility.test.ts`,
  `tests/copierConnectionRecoveryOptionalFollower.test.ts`.
- Nikdy: Nepřevádět missing/unverifiable na active fallbackem z uložené
  konfigurace.
- Bezpečné změny vs. nebezpečné: Bezpečné je optional followera auditovaně
  vyřadit z nových entry. Nebezpečné je nechat ho autorizovat ARM nebo mazat
  jeho možné durable ownership.

### INV-ELIG-02: Externí LIVE exclusions smějí způsobilost jen zpřísnit; návrat na `active` smí potvrdit worker reconciliation

- Proč: UI/inferovaný DLL stav nemá stejnou autoritu jako brokerová kontrola a
  nesmí odemknout účet.
- Vynucuje: `services/copierRuntimeController.ts:applyAccountEligibilityExclusions`
  přijímá jen `dll-locked`/`breached`, porovnává severity a před změnou DISARMuje;
  aktivaci řeší reconciliation/session logika.
- Hlídá test: `tests/copierAccountEligibility.test.ts`,
  `tests/localCopierExecutionAgent.test.ts`.
- Nikdy: Neposílat z UI exclusion `active` a neoslabit `breached` na DLL.
- Bezpečné změny vs. nebezpečné: Bezpečné je zpřísnit stav s konkrétním
  důvodem. Nebezpečné je použít zelený LIVE badge jako worker unlock.

### Účast followerů a cuty

### INV-PART-01: Ruční zapnutí/vypnutí followera je execution změna a vyžaduje bezpečný flat/no-working stav

- Proč: Změna účasti uprostřed lifecycle by vytvořila neřízený orphan nebo
  chybějící exit.
- Vynucuje: `services/copierRuntimeController.ts:setFollowerEnabled` — blokuje
  recovery/outbox/lifecycle, používá dvě autoritativní čtení a generation fence.
- Hlídá test: `tests/copierFollowerParticipation.test.ts`,
  `tests/liveCopyGroupPowerInteraction.test.ts`.
- Nikdy: Nepřepínat participation jen změnou config booleanu za běžícího
  obchodu.
- Bezpečné změny vs. nebezpečné: Bezpečné je vypnout/aktivovat až po
  potvrzeném flat/no-working a durable commitu. Nebezpečné je odvodit flat z
  nulové hodnoty v UI.

### INV-PART-03: Vyřazení followera s vlastní (cizí) expozicí — „Zapnout bez tohoto účtu“ (10. 10. 2026)

- Proč: Ruční obchod na jednom followerovi nemá navždy blokovat zapnutí
  zdravých účtů; kopírka ale nesmí převzít ani opustit vlastní kopii.
- Vynucuje: `setFollowerEnabled(..., { allowOwnExposure: true })` — jen
  `enabled:false`, jen za DISARM, leader flat bez příkazů (stream i dvě REST
  čtení), bez recovery/nejasného outboxu, shodný tvar expozice followera
  v obou čteních a `copierOwnedExposureReasons(account, { atExclusion })`
  prázdné (stejná klasifikace jako „účet bez kopie“ při přepnutí skupiny:
  neusazené záznamy kopírky, OTEVŘENÝ příkaz s ID kopírky, nedokončená epocha
  s lineage, pending exposure, nevyřešený/zaseknutý příkaz, cut; při vyřazení
  navíc globální `liveCopyOpenSince`). Historické ID v outboxu samo o sobě ne
  — outbox se maže jen přepnutím skupiny. Status nese
  `excludedForeignFollowers` (UI podle něj, ne podle konfigurace) a
  `participatingGroupFlat` (obnova socketů). `excludedForeignFollowerIds()` = vypnutí
  followeři bez stopy kopírky; jejich expozice se nepočítá do
  `groupIsFlat` (cooldown, day-lock, stopa kopie, managementOnly), divergence,
  working orders ani `allFlat` v preflightu/reconciliaci/`arm()`; leader-flat
  guard je vynechá jako neparticipanty; přechod pozice ani route-gap na nich
  nespustí fail-closed. Status `groupFlat` (údržba) zůstává přes všechny účty.
- Hlídá test: `tests/copierFollowerExcludeWithExposure.test.ts`,
  `tests/copierFollowerParticipation.test.ts`.
- „Zavřít jen pro tento obchod“ (`flattenFollowerTrade`) vypnutý follower
  odmítne — cut by jeho vlastní pozici nezavřel a zamkl by ho mezi „kopie“.
- Nikdy: Neposílat vyřazenému účtu příkaz měnící expozici (jediná výjimka je
  cancel příkazu prokazatelně z outboxu kopírky); nevyřadit účet, jehož
  expozice může být z kopírky; nezapnout ho zpět bez flat (INV-PART-01).
  Flatten účtu / Flatten All (explicitní akce) ho zavřou.
- Bezpečné změny vs. nebezpečné: Bezpečné je rozšířit důkazy vlastnictví
  (konzervativněji). Nebezpečné je opírat „cizí“ o cokoli jiného než absenci
  vlastní stopy kopírky na účtu.

### INV-GROUP-01: Smazání skupiny workeru a běh bez skupiny (11. 10. 2026)

- Proč: Po breachi všech účtů (skupina dvsvds) worker držel nepoužitelnou
  skupinu v režimu opravy a smazat ji nešlo — worker měl vždy právě jednu
  skupinu a UI ji ze statusu znovu adoptovalo.
- Vynucuje: `retireGroup({ reason, missingAccountIds })` = cesta přepnutí
  skupiny (`reconfigureLeaderEpoch`) s prázdnou novou topologií: jen DISARMED
  a bez kill switche, bez stuck/nejistého outboxu, bez rozpracovaného
  lifecycle (pending connection recovery a leader-flat guard smazání
  neblokují — nedostupné účty nejde obsloužit a účty se stopou kopírky musí
  být flat; rozpracovaný follower cut, zápis outboxu, cut lifecycle ani
  reconciliace běžet nesmí), stejný fence a dvě autoritativní kola čtení.
  Účty, které OAuth vůbec nevrací, se vyřadí auditovaně bez flat důkazu.
  Účty, které OAuth vrací jako neaktivní (`inactiveOptional`), jde bez důkazu
  vyřadit jen bez stopy kopírky (neusazená kopie, epocha, cut, izolace,
  stuck, `liveCopyOpenSince`) — mohou držet pozici; chybí-li rozlišení, bere
  se každý chybějící jako neaktivní. Aktivní viditelné účty se stopou kopírky
  musí být flat a bez příkazů; bez stopy (ruční obchod) zůstávají jak jsou.
  Značka `safety.retiredGroup` jde ve stejném CAS commitu jako čistý stav
  a maže ji až commit aktivace další skupiny. Neprovedené smazání nenastaví
  `lastError` (nic se nezměnilo).
- Běh bez skupiny: ARM, `prepareArm`, `reconcile`, Flatten, úpravy skupiny
  a účast followerů odmítnou; obchodní eventy starých účtů se nezpracují
  (výjimka: účty ve fence probíhající aktivace); heartbeat jen liveness;
  reconnect bez connection recovery, transport-only `lastError` po návratu
  spojení zmizí. Status: `retiredGroup`, `groupFlat`/`participatingGroupFlat`
  true, žádné divergence/working/exposure/účast, `reconciliationRequired`
  false. Restart: pilot (`isRetiredDurableGroup`) uloženou skupinu nevaliduje
  proti OAuth, controller nemá kritický účet a startuje DISARMED bez skupiny.
- Aktivace ze stavu bez skupiny je vždy čerstvá aktivace (i stejného ID):
  stará topologie je prázdná, nic se z ní nečte ani nepřebírá (účast, cut),
  routují se jen účty nové skupiny a ty musí být flat (dvě kola). Agent bez
  nové konfigurace nic nezapne.
- Durable incident (`manualRecovery`) smazání nemaže; ON nové skupiny ho dál
  vyžaduje výslovně potvrdit (INV-DEFAULT-03).
- UI: execution skupina je `copierWorkerExecutionGroup(status)` — smazaná
  skupina se nepředává jako `runtimeGroup` (jinak ji `adoptRuntimeCopyGroup`
  vrátí do seznamu). Mazání skupiny workeru jen s capability `group-delete-v1`;
  relay pouští `delete-group` jen s `groupId`.
- Hlídá test: `tests/copierDeleteActiveGroup.test.ts`,
  `tests/localCopierDeleteGroup.test.ts`, `tests/liveCopyDeleteGroupUi.test.ts`,
  relay v `tests/tradovateCopierCommandRelay.test.ts`.
- Nikdy: Smazáním neposlat brokerový příkaz ani nevypnout zapnutou kopírku;
  nevyřadit viditelný účet se stopou kopírky bez flat důkazu; nezapnout nic
  bez aktivace skupiny.

### INV-PART-02: Follower cut izoluje účet od nových entry, ale dokončení existující kopie zůstává risk-reducing a přesně ohraničené

- Proč: Jeden DLL/breached follower nemá nutně zastavit zdravé účty, ale jeho
  otevřená kopie nesmí být opuštěna ani rozšířena.
- Vynucuje: `services/copierRuntimeController.ts:activeFollowerCut`, follower
  cut background lanes a `cancelFollowerCutBackgroundLanes`;
  `services/copierEngine.ts:planReplication`.
- Hlídá test: `tests/copierFollowerCut.test.ts`,
  `tests/copierV16EpisodeIsolation.test.ts`, `tests/copierSidelinedSuppressionA2.test.ts`.
- Nikdy: Po cutu neposílat nový entry/scale-in a nevykládat cut jako waiver
  neznámé expozice.
- Bezpečné změny vs. nebezpečné: Bezpečné jsou přesné cancel/exit/flatten
  akce pro vlastněnou kopii. Nebezpečné je znovu účet přidat do téže epizody
  podle pouhého návratu `active`.

### Risk a denní pravidla

### INV-RISK-01: Quantity, DLL/MLL a per-follower risk se vynucují čerstvými worker důkazy, ne jen UI hodnotou při ARM

- Proč: Stav i cena se mohou změnit po ARM; `maxContracts`, daily loss
  auto-liquidation (DLL), trailing/max-loss drawdown floor (MLL), eligibility,
  divergence a environment fence musí platit i v hot path.
- Vynucuje: `services/copierEngine.ts:followerQuantity`,
  `services/copierRiskGate.ts:evaluateRiskGate`,
  `services/exposureCappedBroker.ts`; `services/copierRuntimeController.ts:assertVerifiedArmRisk`,
  `applyAccountRiskPoll`, `applyPropReserveCap`, `classifyFollowerBrokerBreach`;
  `services/tradovateBroker.ts:listAccountRiskSnapshots`.
- Hlídá test: `tests/copierRiskGate.test.ts`, `tests/copierRiskConfig.test.ts`,
  `tests/copierRiskDetailedReview.test.ts`.
- Nikdy: Neobcházet `maxContracts` u modify/OSO, nezaokrouhlovat quantity
  nahoru a nenahrazovat chybějící/stale risk snapshot nulovou ztrátou nebo
  zeleným LIVE badge.
- Bezpečné změny vs. nebezpečné: Bezpečné je floor multiplikátoru, čerstvý
  snapshot ve stejné Tradovate session a tighten-only reserve cap. Nebezpečné
  je spoléhat na původní leader quantity, retained P&L nebo neaktuální MLL
  floor bez aktuální follower expozice.

### INV-RISK-02: Denní limity a trading window mohou blokovat nové vstupy; day lock se aktivuje až po flat

- Proč: Uprostřed obchodu je nejbezpečnější dokončit risk-reducing lifecycle,
  nikoli náhle opustit ochranu.
- Vynucuje: `services/copierRuntimeController.ts:evaluateDailyRules`,
  `maybeEngageDayLock`; `services/copierDailyRules.ts:tradingWindowStateAt` a
  `lastTradingWindowEnd`; `services/liveCopyTrading.ts:DEFAULT_COPY_GROUP_SAFETY`.
- Hlídá test: `tests/copierDailyRules.test.ts`,
  `tests/copierDayRuleActions.test.ts`, `tests/copierRuntimeControllerRiskConfig.test.ts`.
- Nikdy: Nezaměňovat `dailyLossLimitUsd`, počet losing trades a počet trades;
  neaplikovat window-end lock po prvním dílčím okně dne.
- Bezpečné změny vs. nebezpečné: Bezpečné je varovat/pauznout a po flat
  durable locknout. Nebezpečné je ukončit správu protective orders jen proto,
  že právě skončilo okno.

### INV-RISK-03: Cooldown začíná až po potvrzeném flat a blokuje ARM jako celek

- Proč: Selektivní přeskočení entry by samo vytvořilo divergence a countdown
  během otevřeného obchodu by zkrátil skutečnou pauzu.
- Vynucuje: `services/copierRuntimeController.ts:maybeActivateCooldown`,
  `arm`; `services/liveCopyTrading.ts:entryCooldownMinutes`.
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierCooldownDisplay.test.ts`.
- Nikdy: Neřešit cooldown tím, že se jednotlivé leader eventy tiše skipnou.
- Bezpečné změny vs. nebezpečné: Bezpečné je flat → DISARM → durable timestamp
  → ARM blocker. Nebezpečné je nechat skupinu ARMED a filtrovat jen entry.

### INV-RISK-04: Session hranice je 17:00 America/Chicago a musí respektovat DST

- Proč: Pevný UTC offset se dvakrát ročně rozchází a mohl by předčasně
  odemknout den nebo prodloužit ARM.
- Vynucuje: `services/copierArmSession.ts:tradovateSessionEndAt`,
  `msUntilTradovateSessionEnd`; controller přes session end resetuje denní
  paměť a expiruje ARM/locky.
- Hlídá test: `tests/copierArmSession.test.ts`.
- Nikdy: Nepočítat konec session jako `now + 24h` ani jako konstantní UTC čas.
- Bezpečné změny vs. nebezpečné: Bezpečné je používat jedinou sdílenou helper
  funkci. Nebezpečné jsou lokální kopie časové logiky v UI/relay.

### Management-only, shadow a liquidation recovery

### INV-MODE-01: Management-only se zapne jen pro autoritativně prokázanou existující kopii a nesmí přijímat nové entry

- Proč: Při neúplném lifecycle je bezpečnější udržet SL/TP/exit známé kopie než
  celý runtime vypnout; režim ale nesmí rozšířit riziko.
- Vynucuje: `services/copierRuntimeController.ts:enterManagementOnlyAfterProtectedTargetFailure`,
  `blockDuringPause`, `entryRestrictionActive`, `arm` a `reconcile`. Obecný
  `services/copierRiskGate.ts:haltReason` management-only nezná; nové entry
  blokuje controller ještě před dispatchí.
- Hlídá test: `tests/copierManagementOnly.test.ts`.
- Nikdy: Nevstupovat do management-only bez přesného targetu a obou working
  protective orders; nevypínat ho ruční kontrolou, dokud skupina není známě flat.
- Bezpečné změny vs. nebezpečné: Bezpečné jsou lifecycle modify/cancel/exit
  existující kopie. Nebezpečné jsou entry, scale-in nebo odvozený target.

### INV-MODE-02: Výsledek nativního `liquidateposition` se potvrzuje stavem, nikoli přítomností `orderId`

- Proč: Endpoint může přijmout požadavek bez order ID a jeho timeout může
  skrývat úspěšný close.
- Vynucuje: `services/copierLiquidationRecovery.ts:recoverLiquidationEntryByState`,
  `services/copierManualActions.ts:processManualFlatten`.
- Hlídá test: `tests/copierLiquidationRecovery.test.ts`,
  `tests/copierManualActions.liquidate.test.ts`,
  `tests/copierManualActions.parallel.test.ts`.
- Nikdy: Neopakovat stejnou liquidation operation naslepo a netvrdit kauzalitu
  POSTu jen proto, že následný snapshot je flat.
- Bezpečné změny vs. nebezpečné: Bezpečné je `position → orders → position`,
  potvrdit flat/no-active a uložit `confirmed-by-state`. Nebezpečné je Market
  fallback bez nového přesného stavu nebo account-wide rozšíření cíle.

### Worker identita, durable store a lease

### INV-WORKER-01: Durable commit je CAS; stale proces nesmí přepsat novější snapshot

- Proč: Async eventy, restart a budoucí překryv instancí mohou jinak vrátit
  stav zpět a znovu vykonat outbox.
- Vynucuje: `services/copierStore.ts:CopierStore` a `createMemoryCopierStore`,
  `services/fileCopierStore.ts:createFileCopierStore`,
  `services/supabaseCopierStore.ts:createSupabaseCopierStore`.
- Hlídá test: `tests/copierStore.test.ts`, `tests/fileCopierStore.test.ts`,
  `tests/supabaseCopierStore.test.ts`.
- Nikdy: Nepřepisovat snapshot „last write wins“ bez expected revision/fence.
- Bezpečné změny vs. nebezpečné: Bezpečný je atomický temp+fsync+rename na
  jediném Mac procesu nebo DB CAS s fence. Nebezpečné je sdílet file store mezi
  dvěma procesy.

### INV-WORKER-02: Vzdálený worker musí držet fencing lease a po jeho ztrátě skončit; tato ochrana zatím není zapojená do Mac pilotu ani hotového VPS entry

- Proč: Dva živé workery nad jednou skupinou mohou vytvořit duplicitní příkazy
  navzdory outboxu uloženému odděleně v každém procesu.
- Vynucuje: `services/copierWorkerLease.ts:acquireWorkerLease`,
  `startLeaseRenewal`; `services/supabaseCopierStore.ts:createSupabaseCopierStore`
  překládá stale fence/expired/missing lease na terminální
  `CopierFenceStaleError`. **NEOVĚŘENO V RUNTIME:** vyhledání volajících
  potvrzuje, že lease nemá worker entry; Mac používá `scripts/copier/pilot.ts`
  + `fileCopierStore`.
- Hlídá test: `tests/supabaseCopierStore.test.ts` kryje CAS a validaci store;
  **žádný přímý test nekryje překlad stale fence na `CopierFenceStaleError`,
  lease API ani end-to-end reálného VPS entry**, protože entry neexistuje.
- Nikdy: Nespouštět druhou execution instanci jen s předpokladem, že relay
  vybere jednu; heartbeat routing není fencing.
- Bezpečné změny vs. nebezpečné: Bezpečné pořadí je acquire lease → store s
  fence → runtime → renew; první renew failure → terminální DISARM/stop.
  Nebezpečné je lease za běhu znovu získat po možné změně vlastníka.

### INV-WORKER-03: Device secret a scope určují identitu/oprávnění relaye, ale samy neřeší souběh dvou workerů

- Proč: Párování chrání přístup, nikoli jedinečnost execution vlastníka.
- Vynucuje: `server/tradovateCopierDevice.ts:registerTradovateCopierDevice`,
  `authorizeTradovateCopierDevice`; `server/macCopierDevice.ts` Keychain
  helpers; `server/tradovateCopierCommandRelay.ts:selectRelayDeviceTarget`.
- Hlídá test: `tests/tradovateCopierDevice.test.ts`,
  `tests/macCopierDevice.test.ts`, `tests/copierRelayOwnerResolve.test.ts`.
- Nikdy: Nevydávat „nejčerstvější heartbeat vyhrává“ za split-brain ochranu.
- Bezpečné změny vs. nebezpečné: Bezpečné je revokovat zařízení a scope
  kontrolovat serverově. Nebezpečné je povolit ARM při více čerstvých
  execution zařízeních bez lease/fence.

### INV-WORKER-04: Neexekuční moduly workeru běží v oddělené doméně selhání; jejich chyba ani zaseknutí nesmí ukončit proces ani zdržet relay poll a brzdy (26. 10. 2026)

- Proč: Pád procesu workeru = launchd restart = DISARMED (INV-DEFAULT-01).
  Doplněk jen pro zobrazení (kanál ceny z TradingView) nesmí kopírku vypnout
  ani zpomalit doručení DISARM/kill.
- Vynucuje: `scripts/copier/tvPriceStreamThread.ts` (samostatný bundle
  `tv-price-stream.mjs` v `node:worker_threads`, nic z kopírky neimportuje),
  `server/tvPriceStreamSupervisor.ts` (restart s prodlevou, jistič 3 pády
  / 10 min, liveness, pády po probuzení se nepočítají, posluchači v
  try/catch), `server/macCopierCommandRelay.ts:notifyRealtimeConfig`
  (synchronně, bez čekání, před kickem), `scripts/copier/pilot.ts` (výchozí
  vypnuto, `ALPHATRADE_TV_STREAM=on` + existující bundle). Zdroj IBKR
  (`ALPHATRADE_PRICE_SOURCE=ibkr`, 28. 10. 2026) běží ve stejném vlákně
  (`services/ibkrPriceSource.ts`, záloha TV, přepnutí zdroje = nový `runId`);
  bundle vlákna má hlavičku s `require` pro CommonJS knihovnu `@stoqey/ib`.
  Fáze 4 (28. 10. 2026): vlákno posílá hlídači i svíčky dne (`bars`,
  Float64Array předaný bez kopírování, max 1 700 × 6, max 1×/10 s); hlídač
  ověří typ a délku v O(1), pak `sanitizeTvBars`, a drží je jen v paměti pro
  `latestBars` (≤ 90 s, jen živé vlákno a zapnutý kanál). Čte je jen
  `pilot.ts` pro graf dne a hodnocení (hlídá `tests/tvPriceStreamWiring.test.ts`);
  podle nich se nic nespouští. Okamžité posílání (28. 10. 2026): obchod
  z IBKR (`onTrade`) jen naplánuje čtení (`stream.nudge()`, 25 ms spojení
  dávky, rozestup 200 ms, po chybě prodleva 1 s); cesta ceny pro přehrání
  v grafu (`takeTrail`, strop 256 ve zdroji, 64 ve streamu, maže se při
  změně minuty, po odeslání a po nečinnosti) je jen v paměti vlákna.
- Hlídá test: `tests/tvPriceStreamSupervisor.test.ts`,
  `tests/tvPriceStreamWiring.test.ts` (allowlist importů vlákna, pořadí
  buildu, relay hook), `tests/tradingViewPriceStream.test.ts`.
- Nikdy: Spouštět bundle workeru jako vlákno, přidávat globální
  `process.on('unhandledRejection')` kvůli doplňku, čekat v poll smyčce na
  přihlášení k Realtime, spouštět/ukončovat TradingView z vlákna.
- Bezpečné změny vs. nebezpečné: Bezpečné je vypnout stream serverem
  (vynechat `priceTopic`/`priceKey` v odpovědi pollu) bez restartu workeru.
  Nebezpečné je přesunout čtení TV do hlavního event loopu workeru.

### Tradovate specifika

### INV-TRAD-01: Initial sync je baseline, nikoli sada nových obchodů; skutečný reconnect vyžaduje route-scoped resync a zůstává DISARMED

- Proč: Tradovate po syncu přehrává existující entity a krátký follower
  reconnect může být skryt agregovaným connection stavem.
- Vynucuje: `services/copierLeaderEventSource.ts:orderEvent`,
  `services/tradovateBroker.ts:handleMessageObject`,
  `services/brokerRouter.ts:scopedResync` a per-route epoch.
- Hlídá test: `tests/copierLeaderEventSource.test.ts`,
  `tests/tradovateBrokerReconnect.test.ts`, `tests/copierGraceReconnectD1.test.ts`,
  `tests/brokerRouter.test.ts`.
- Nikdy: Nereplikovat baseline Order/Fill a nezahodit krátkou route mezeru bez
  snapshotového porovnání.
- Bezpečné změny vs. nebezpečné: Bezpečné je scopeovat snapshot na route a
  fail-closed při neúplnosti. Nebezpečné je spoléhat jen na agregované
  `connected=true`.

### INV-TRAD-02: Pending/Suspended stav je aktivní riziko, ale jeho venue-managed quantity není automaticky uživatelský replace

- Proč: Tradovate při partial fillu OSO přechodně mění child quantity; slepé
  kopírování této hodnoty v minulosti zrušilo správnou ochranu followerů.
- Vynucuje: `services/copierLeaderEventSource.ts:orderEvent`,
  `services/copierOsoModifyCascade.ts:planOsoModifyCascade`,
  `services/copierRunner.ts:resolveBrokerLifecycleEntry`.
- Hlídá test: `tests/copierTradovateLifecycle.test.ts`,
  `tests/tradovatePartialCancel.test.ts`,
  `tests/copierProtectiveFilledDuringModify.test.ts`.
- Nikdy: Nepovažovat `Order(Filled)` samotné za důkaz plného fillu; Cancel
  Completed s `cumQty < orderQty` je partial cancel, ne plný fill.
- Bezpečné změny vs. nebezpečné: Bezpečné je číst celý Order+Fill graph na
  terminální nejasné cestě. Nebezpečné je rozhodovat jen podle status stringu.

### INV-TRAD-03: `clOrdId` je korelační klíč, ne idempotency garance; Tag50 se nesmí znovu zavést

- Proč: Tradovate odmítl `customTag50` jako unregistered a ani `clOrdId`
  nebrání duplicitnímu přijetí.
- Vynucuje: `services/copierKeys.ts:brokerTag`,
  `services/tradovateBroker.ts:commandCorrelationTag`; skutečnou ochranu vynucují
  outboxy a lookup-before-retry.
- Hlídá test: `tests/tradovateMapping.test.ts`, `tests/copierOutbox.test.ts`,
  **žádný přímý test neprokazuje, že `clOrdId` na venue deduplikuje — právě
  proto se za takový důkaz nepovažuje**.
- Nikdy: Neposílat Tag50 bez broker registrace a nepoužít shodný `clOrdId` jako
  důvod k blind retry.
- Bezpečné změny vs. nebezpečné: Bezpečné je zachovat legacy lookup jen pro
  čtení starších záznamů. Nebezpečné je vrátit Tag50 do write payloadu.

### INV-TRAD-04: Rate limit a penalty ticket jsou execution stav; respektuje se broker `p-time`/Retry-After a captcha je terminální

- Proč: Předčasný retry prodlužuje penalizaci a reconnect storm může držet
  worker dlouho DISARMED.
- Vynucuje: `services/tradovateBroker.ts:request`, `handleMessageObject`,
  `scheduleReconnect`; hodinový breaker a sync penalty retry používají
  brokerův minimální delay.
- Hlídá test: `tests/tradovateBrokerRateLimitBreaker.test.ts`,
  `tests/tradovateBrokerSessionSuspect.test.ts`,
  `tests/tradovateBrokerRestTimeout.test.ts`.
- Nikdy: Nezkracovat explicitní `p-time`/Retry-After a neřešit limit novým
  tokenem jako by tím vznikl nový budget.
- Bezpečné změny vs. nebezpečné: Bezpečné je snížit read traffic, exponenciálně
  čekat a zůstat OFF. Nebezpečné je agresivně reconnectovat nebo během penalty
  tvrdit connection ready.

### INV-TRAD-05: Víkendový reconnect nemá safety výjimku; zavřený trh ani prázdný snapshot nejsou automatický důkaz pro ARM

- Proč: Víkendová údržba už způsobila oba sockety zavřené a opakované sync
  timeouty. Burza zavřená neznamená, že worker zná stav všech účtů.
- Vynucuje: `services/tradovateBroker.ts:scheduleReconnect` používá stejný
  bounded backoff bez kalendářního bypassu; `services/copierRuntimeController.ts:arm`
  stále vyžaduje connected, reconciliation, authoritative flat a no-working.
- Hlídá test: `tests/tradovateBrokerReconnect.test.ts`,
  `tests/copierRuntimeController.test.ts`; **žádný dedikovaný test kalendářně
  simulující celý víkend — OTÁZKA**.
- Nikdy: NeARMovat nebo nemaž incident jen proto, že je sobota/neděle, a
  neinterpretovat nedostupná data jako nuly.
- Bezpečné změny vs. nebezpečné: Bezpečné je delší backoff a read-only obnova.
  Nebezpečný je „weekend mode“, který oslabí completeness/flat požadavky.

### INV-TRAD-06: Více OAuth spojení se routuje per account a event z cizí/duplicitně viditelné route se nesmí zpracovat dvakrát

- Proč: Jedno OAuth může vidět více účtů a skupina může používat Tradeify i
  Lucid; překryv by jinak duplikoval leader lifecycle.
- Vynucuje: `services/brokerRouter.ts:createBrokerRouter` filtruje entity podle
  `accountIdsByBroker`, počítá relevantní agregát a scopeuje resync;
  `scripts/copier/pilot.ts` staví route manifest.
- Hlídá test: `tests/brokerRouter.test.ts`,
  `tests/copierWorkerAccountRoutes.test.ts`, `tests/copierRouteGapV6.test.ts`.
- Nikdy: Nebroadcastovat broker event všem runtime účtům a nebrat connection
  health jedné OAuth route jako důkaz zdraví druhé.
- Bezpečné změny vs. nebezpečné: Bezpečné je explicitní account→route mapa a
  per-route epoch. Nebezpečný je fallback „první broker, který účet vidí“ bez
  stabilního ownership.

### UI pravidla

### INV-UI-01: Obnovený stav může krátce stabilizovat zobrazení, ale neautorizuje příkaz; po grace je stale/unknown neutrální

- Proč: Prezentační cache přežívá worker a její kladná hodnota nesmí vytvořit
  execution autoritu. UI ale záměrně až 1,2 s zobrazuje obnovený status starý
  nejvýše 10 minut jako dostupný, aby při návratu na LIVE neproblikávalo;
  tento krátký stav proto může vizuálně zachovat poslední ON/connected hodnotu.
- Vynucuje: `components/TradovateLiveDesk.tsx:agentStatusDisplayFresh` a
  `runtimeAvailable`, `restoredDisplayGrace` a `armStatusRef`,
  `lib/copierPowerDisplay.ts:readCopierPowerDisplay`,
  `lib/copierAgentStatusStore.ts:readCopierAgentStatusSnapshot`.
- Hlídá test: `tests/copierPowerDisplay.test.ts`,
  `tests/copierForegroundPoller.test.ts`, `tests/liveCopyCompactRender.test.ts`.
- Nikdy: Použít display grace jako důkaz pro ARM/config/reconcile nebo
  doplňovat missing positions nulou. Po 1,2 s bez čerstvého pollu musí grace
  skončit; `armStatusRef.fresh` zůstává pro restored stav false po celou dobu.
- Bezpečné změny vs. nebezpečné: Bezpečné je krátké, výslovně prezentační
  zachování poslední hodnoty se samostatnou autorizační branou. Nebezpečné je
  odvodit povolení příkazu z `runtimeAvailable` nebo display grace.

### INV-UI-02: DISARM a kill jsou vždy dosažitelné; ostatní mutace vyžadují čerstvý worker status

- Proč: Safety akce musí fungovat právě tehdy, když běžná command brána neví,
  zda je runtime dostupný.
- Vynucuje: `components/TradovateLiveDesk.tsx:executeSafetyCommand`,
  `lib/copierSafetyControls.ts:selectCopierSafetyRoute` a
  `copierAgentCommandAllowedWhileRestored`; `lib/appForeground.ts` volá
  posluchače popředí izolovaně (výjimka jednoho, např. kanálu ceny z TV,
  nezastaví obnovu pollu LIVE — `tests/tvPriceClientGuards.test.ts`).
- Hlídá test: `tests/copierSafetyControls.test.ts`,
  `tests/liveCopyDisarmPanelRender.test.ts`, `tests/liveCopyAdversarialUiReview.test.ts`.
- Nikdy: Neschovávat OFF kvůli stale pollu a naopak nepouštět ARM/config přes
  poslední známou route bez fresh statusu.
- Bezpečné změny vs. nebezpečné: Bezpečné je oddělit safety command path od
  běžných commandů. Nebezpečné je sdílet jednu obecnou `disabled={!fresh}`.
- LIVE → Graf (29. 10. 2026): tlačítko Vypnout v hlavičce grafu nezávisle na
  skupině, skryté jen při `lib/liveTradeGroupSource.ts:copierProvablyOff`
  (čerstvý stav, `armed: false` a žádné čekající automatické pokračování —
  jinak „Zrušit automatické pokračování“, INV-RECON-04). Volá
  `TradovateLiveDesk.tsx:disarmFromChart` = stabilní funkce nad
  `executeSafetyCommand` přes ref (vždy aktuální trasa a fence), zámek proti
  dvojkliku přes ref, neověřený stav s potvrzením stejného textu jako přehled
  přímo v grafu (dialog desku je pod vrstvou grafu), brzda ve frontě relaye
  = informace, nic se neopakuje; výsledek i na přehledu s časem, po zapnutí
  kopírky nebo 10 min zmizí (`tests/liveChartData.test.ts`).

### INV-UI-03: Retained risk, „rozhodnutí dne“ a poslední worker status jsou pouze zobrazení

- Proč: Udržení hodnoty při krátkém výpadku zlepšuje čitelnost, ale její stáří
  ruší rozhodovací autoritu.
- Vynucuje: `components/TradovateLiveDesk.tsx:runtimeAvailable`,
  `lib/copierForegroundPoller.ts:isCopierStatusFresh`,
  `lib/copierSafetyControls.ts:copierAgentCommandAllowedWhileRestored`.
- Hlídá test: `tests/copierForegroundPoller.test.ts`,
  `tests/copierRiskDetailedReview.test.ts`, `tests/copierPowerDisplay.test.ts`.
- Nikdy: Nepřenášet retained hodnotu zpět do worker command payloadu jako
  potvrzený risk/eligibility/flat stav.
- Bezpečné změny vs. nebezpečné: Bezpečné je ukázat timestamp a stale badge.
  Nebezpečné je z retained hodnoty odvozovat povolení tlačítka ON.
- Ručení workeru (26. 10. 2026): `LiveAccount.displayVouch`
  (`lib/tradovateAccountDisplayMerge.ts:nextTradovateDisplayVouches`,
  `lib/liveBalanceDisplay.ts:liveDisplayVouchedAt`, `liveCushionEvidence`) smí
  jen přebarvit STEJNOU částku jako ověřenou, nejvýš 45 s od statusu workeru;
  při výpadku streamu, backoffu, chybějícím feedu nebo jiné částce se ruší hned.
  Nikdy nemění `isLiveAccountReadVerified`, hodnoty (`.value`) ani nevstupuje do
  příkazů, ARM, reconcile a způsobilosti (`tests/copyTradeAccountEligibility.test.ts`).
- Živá pozice v grafu deníku (27. 10. 2026): vlastní čtečka stavu workeru
  (`lib/displayWorkerStatusReader.ts`, `hooks/useDisplayWorkerStatus.ts`) —
  jen GET relaye po 2 s v popředí, čerstvost jako INV-FRESH-03 (< 15 s,
  připojený runtime), revize nikdy zpět, čtení zahájené před odchodem do
  pozadí se zahodí. Nemá fenci ani ACK, a proto nesmí ovládat kopírku ani
  povolit příkaz (INV-UI-02); používá ji jen `useJournalLivePosition`.
  Pozice z workeru se přes `overlayWorkerExposure` přijmou nejvýš 8 s staré
  a u followera jen tehdy, když ji worker prokazatelně zná (OK verdikt po
  porovnání, „drží X, očekáváno Y“ nebo záznam pozice) — zlikvidovaný účet,
  denní limit, příkazy mimo kopii, vypnutý režim, rozjetí čekající na
  reconcile nebo „pozice neověřena“ zůstanou na REST. Platí i pro LIVE,
  stejně jako `averagePrice: null` po změně velikosti pozice (vstup, body
  SL/TP a TV P&L do dalšího plného REST ticku chybí) — obojí jen přísněji.
  Test hlídá, že každý OK verdikt ve workeru před kontrolou `held` je jeden
  ze tří známých.
  Neověřené čtení pozic (> 45 s), chybějící účet skupiny, neověřené příkazy
  čekajícího vstupu nebo rozjetá skupina = štítek to řekne a čáry se
  nekreslí — žádná poslední známá poloha (INV-UI-01). Rozjetí (jiný směr,
  leader flat a follower drží, osiřelý příkaz) se hlásí až po 10 s trvání
  (déle než cyklus čtení deníku 6 s; začátek podle skutečného času, jeden
  pro všechny cesty), do té doby neutrální „Kopie dobíhá…“ (výstup, vstup
  on-submit i otočení se kopírují se zpožděním — falešný poplach by sváděl
  k ručnímu zásahu). Rozjetí potvrzené workerem („pozice se liší od
  leadera“ hned, „drží X, očekáváno Y“ po 5 s) se ukáže hned. Souhrn při
  flat leaderovi jen když má každý držící follower OK verdikt čerstvého
  workeru (kopírka ho vědomě neřídí); ne-OK verdikt (neověřená pozice,
  denní limit, zlikvidovaný účet…) nic nepotlačí. Výslovně ručně vypnutá
  kopírka v klidu (`journalCopierArmed`: čerstvý heartbeat, `armed === false`,
  `lastDisarm.trigger === 'manual'` s kopiemi flat a z tohoto běhu workeru
  (`lastDisarm.at >= startedAt`), spojení běží, žádné čekání na
  automatické obnovení, bez `lastError`, ruční obnovy a kill switche) poplach
  o rozjetí vypne: followeři kopírovat nemají, takže pohled skupiny ukáže, co
  účty skutečně drží (jediný účet = jeho pohled se jménem), se štítkem
  „kopírka vypnutá“ — jen když souhrn obsáhne každý účet s expozicí a příkazy
  všech členů jsou ověřené (jinak „vyber účet“ / „Příkazy neověřené“); SL/TP
  souhrnu víc účtů jen společné, čekající vstupy víc účtů se nesčítají („vyber
  účet“). Jakékoli jiné vypnutí (fail-closed při rozjetí, výpadek spojení,
  restart workeru, budoucí důvody) a neznámý stav = poplachy jako výš (seznam
  povolených, ne zakázaných). Známé omezení: vypnutí bez nového záznamu po
  pozdějším zapnutí v témže běhu (cooldown, day lock, změna skupiny…) starý
  ruční záznam nepřebije; úplné řešení = čas posledního zapnutí od workeru. Verdikty „aktivní příkazy mimo
  kopii“, „účet zlikvidován“, „denní limit“ mají ve workeru přednost před
  porovnáním kusů — rozdíl u takového followera deník nepozná (LIVE ano). Otevřené P&L starší
  než 15 s nebo bez známého vstupu se neukáže („P&L —“). Čtení z brokera pro
  deník má úsporné tempo (`useTradovateLiveData` `journalFocus`: plný tick
  6 s s pozicí, jinak 30 s, restart čtení nejdřív 6 s od posledního čtení;
  plné čtení jednou bez dat — nepovedené znovu
  nejdřív po 5 min — a po uzavření pozice kvůli zůstatkům jako na pozadí).
  429 se zapíše i z ticku, jehož data se zahodí (INV-TRAD-04). Bootstrap
  může jako otevření LIVE nabídnout nastavení profilů účtů; kopírku ani
  příkazy neovládá. Známé omezení: zavření a nový vstup stejné velikosti
  během jednoho cyklu REST nechá čáru vstupu na staré ceně do dalšího ticku.
  Hlídá `tests/displayWorkerStatusReader.test.ts`,
  `tests/journalLivePosition.test.ts`, `tests/tradovateWorkerExposureOverlay.test.ts`,
  `tests/tvPriceClientGuards.test.ts` (jen čtení, žádný příkaz ani úložiště).

### INV-UI-04: Data z TradingView jsou jen pro zobrazení; nikdy nevstupují do read modelu, rozhodování ani úložišť (26. 10. 2026)

- Proč: Filip 26. 10. povolil cenu z TV pro P&L zobrazené na obrazovce, nikdy
  pro risk, day lock, limity ani kopírku. Veřejný Realtime kanál je
  podvrhnutelný, proto se zprávy podepisují.
- Vynucuje: `lib/tvPriceMessage.ts` (HMAC nad surovým řetězcem, přísný
  tvar), `lib/tvPriceStore.ts` (jen paměť, ochrana proti přehrání
  `seq`/`runId`/`at`), `lib/tvPriceChannelClient.ts` (postupné ověření,
  změna tématu = reset, serverový vypínač), `lib/tvLivePnl.ts` (kotva
  brokera + pohyb, kontroly 1–5), listová komponenta
  `components/LiveOpenPnlValue.tsx` — jediné místo, kde hodnota s pohybem
  z TV existuje (v renderu; render-prop smí hodnotu jen formátovat). Grant
  (téma + klíč) jde z relaye vedle statusu, nikdy v něm
  (`api/tradovate/oauth/copier-relay.ts`); LIVE desk vidí jen úzké rozhraní
  `services/tvPriceGrant.ts` (žádný store ani hodnota). Živá svíčka grafu
  dne: `lib/tvLiveCandle.ts` + `hooks/useTvLiveCandleFeed.ts` (jen v datech
  grafu dne); grafy dostávají jen neutrální `LiveCandleFeed`
  (`lib/liveCandleFeed.ts`, `hooks/useLiveCandleBinding.ts`) a svíčku jen
  překreslí (`updateBar`) — do dat grafu, cache dne ani storage nejde.
  Od 28. 10. 2026 se tvořící se bar řady (živá svíčka, přehrávaná svíčka)
  bere i do kreslení FVG (`fairValueGapsWithFormingBars`, posluchač
  `subscribeDataChanged` v `CandleKitTradeChart`): zaplnění a tvořící se FVG
  hned, jako TV. Bere se celý konec řady grafu od posledního baru dat
  (`controller.getBars()`), ne jen poslední bar — na přelomu minuty drží graf
  dokončenou živou svíčku, kterou data ještě neznají. Jen vrstva kreslení
  FVG — `fvgs` pro magnet kreslení, FVG vstupu, hodnocení ani úložiště ho
  nevidí. Výměnu dat grafu (`setData`, sběrnice `data`) hlídá
  `bindLiveCandleDataResets`: záznam změn grafu zahodí a živou svíčku vrátí
  v témže kroku; při vypnutém feedu (návrat na data) ji nekreslí. Dokončené
  živé bary od posledního baru dat dál vrátí taky (`carryFinishedLiveBars`):
  server dodává minutu se zpožděním a jeho poslední bar bývá nedokončený,
  takže na 1m živá dokončená minuta přebije poslední bar dat — data vyhrají,
  jakmile mají novější bar; výpadek ceny vrací přesně data (přepsaný bar je
  v `originals`, připsané v `appended`). Nové cíle záznam změn nemažou
  (`refreshLiveCandleTargets`) — smazání by po výpadku ceny nechalo živou
  svíčku nakreslenou jako skutečnou; graf, který z cílů vypadl, se vrátí na
  data.
  Štítek živé pozice v grafu deníku (`components/day/DayLivePositionChip.tsx`,
  27. 10. 2026) používá stejnou listovou komponentu se stejným pravidlem;
  čáry pozice v grafu (vstup, SL/TP) jsou jen z read modelu brokera/workeru,
  nikdy z ceny TV.
  Přehrání ticků z dávky (28. 10. 2026): zpráva smí nést cestu ceny
  (`TvPriceTrail`, skutečně zobchodované ceny rozpracované minuty od minulé
  zprávy, max 64) v polích obálky `t`/`ts` — zvlášť podepsané (HMAC nad
  `"trail\n" + t`, stejný klíč), mimo `p`, aby starší klienti s přísným tvarem
  `p` zprávu přijali beze změny. Cesta se ověřuje až po `p`, se stejným
  časovým limitem (`lib/tvPriceChannelClient.ts`; neplatná nebo zaseknutá =
  zpráva bez cesty, fronta se nezablokuje) a je vázaná na `runId`, `seq`,
  minutu baru, konec = `last` = close, vše uvnitř high/low baru
  (`isTvPriceTrailFor`). Čte ji jen `lib/tvLiveCandleReplay.ts`: živá svíčka
  jimi projde za 100 ms a skončí přesně na baru zprávy; na přelomu minuty
  během přehrání se stará minuta nejdřív dokreslí celá. P&L, `samples` ani
  nic jiného cestu nečte. Volba grafu `scales.liveTickReplay` (výchozí
  zapnuto).
- Hlídá test: `tests/tvPriceTrail.test.ts` (podpis, vazba, kompatibilita,
  sběr ve workeru, přehrání), `tests/tvPriceClientGuards.test.ts` (kdo smí moduly
  importovat vč. aliasu `@/`, rozhodovací/ukládací/sdílené cesty kanál
  nevidí ani tranzitivně, žádné storage, grant jen do kanálu, render-prop
  jen formátuje — 6 bloků bez `set*`/`on*`/ref/limitů, ekvivalence
  způsobilosti a souhrnu dne; živá svíčka jen do překreslení grafu),
  `tests/tvLivePnl.test.ts`, `tests/tvLiveCandle.test.ts`,
  `tests/tvPriceGrantRefresh.test.ts`, `tests/tvPriceStore.test.ts`,
  `tests/tvPriceChannelClient.test.ts`, `tests/copierRelayPriceChannel.test.ts`.
- Nikdy: Zapsat cenu nebo P&L z TV do `unrealizedPnl`/`openPnL`, marks
  (`livePnlMarksRef`), způsobilosti a exkluzí, DLL a „zbývá do limitu“,
  ostrova, ARM payloadu a příkazů, worker statusu, Live Activity/push/widgetu,
  `displayCache`/`writeTradovateDisplaySession`, sdílených karet, žurnálu ani
  storage. Neověřenou zprávu nikdy nezobrazit.
- Bezpečné změny vs. nebezpečné: Bezpečné je přidat další listové zobrazení
  přes `LiveOpenPnlValue` (jeden obchod skupiny, řádek účtu). Nebezpečné je
  vrátit číslo s pohybem z TV z komponenty ven nebo z něj počítat součet
  s limity.
- IBKR (28. 10. 2026): cena z IB Gateway (`services/ibkrPriceSource.ts`)
  jde stejnou zprávou a stejnou cestou jako cena z TV (symbol `IBKR:…`),
  platí pro ni celé toto pravidlo. Klient podle symbolu mění jen štítek
  („živě · IBKR“). Spojení na Gateway je jen čtecí: jediný `IBApi` je ve
  `services/ibkrMarketData.ts` za zmrazeným úzkým rozhraním, jen 127.0.0.1
  (hlídá `tests/ibkrMarketData.test.ts`), Gateway má navíc „Read-Only API“.
- Výjimka pro úložiště (Filip 28. 10. 2026 pro TV i IBKR): předběžné 1m svíčky
  smí worker přes relay uložit do soukromého bucketu `copier-snapshots`, a to
  jen `<user>/tv-live/<rodina>.json` (graf dne a přípravy) a `<user>/tv-bars/…`
  (graf hodnocení obchodu, mazané po 3 dnech; obojí nahradí Databento). Nic
  jiného: nikdy risk, day lock, limity, kopírka, způsobilost ani read model.
  Soubor dne nese `source` a `contract`; server (`mergeLiveBarsFile`) nikdy
  nesmíchá dva kontrakty a TV nepřepíše minuty z IBKR. Svíčky k hodnocení
  z IBKR jen pro kontrakt obchodu (`barsContractMatchesSymbol`). Zapisuje jen
  `server/copierSnapshotStore.ts`, čtou jen `services/liveCandles.ts`,
  `services/provisionalCandles.ts` a jejich zobrazovací konzumenti (hlídá
  `tests/liveBarsMerge.test.ts`). Pro produkt pro další uživatele neplatí
  (licence dat pro distribuci).
- LIVE → Graf, data (29. 10. 2026): skupina, účty, dnešní výsledek, „Do
  limitu“ a pozice dodává desk (`hooks/useLiveChartData.ts`,
  `lib/liveTradeGroupSource.ts`) ze stejných vstupů a funkcí jako přehled
  (`liveDailyPnlDisplay`, `liveDailyLossRemainingDisplay` se stářím; neznámé =
  „—“, nikdy 0 ani „flat“). Stav kopírky pro výběr účtu jen z čerstvého stavu
  desku (`copierArmedForRules`; obnovený/starý/čekající pokračování = null =
  zapnuto), vyřazení jen z čerstvého `excludedForeignFollowers`, ostatní
  nekopírující followeři samostatně za ARMED nejdou. Pozice a rozjetí přes
  `hooks/useLiveTradeCardView.ts` sdílený s deníkem (jen čerstvý heartbeat
  ≤ 8 s, reset paměti při novém `startedAt`); pohled skupiny bez vyřazených
  followerů, účet mimo skupinu sám za sebe, pohled tiše spadlý na skupinu se
  neukáže. Nic z toho neautorizuje příkaz.
- LIVE → Graf (29. 10. 2026, jen UI): `components/LiveTradingScreen.tsx`
  předává živou svíčku z kanálu jen grafu (`liveCandles={chart.liveFeed}`,
  výjimka v `tests/tvPriceClientGuards.test.ts`); panel objednávky ji nečte.
  Jeho orientační bid/ask je close poslední svíčky dat grafu (původ TV/IBKR)
  se štítkem zdroje a stáří, zašedlý, když data nejsou živá. Typ příkazu,
  počet kontraktů podle rizika i cena Market v panelu jsou proto jen ODHAD:
  krok odeslání (jádro kopírky) je musí přepočítat z kotace brokera nebo
  z výslovné volby uživatele, nikdy z této ceny. Hlídání denního limitu
  v panelu jen u Limit/Stop (vstup zadal uživatel), nikdy u Market
  (`lib/liveOrderTicket.ts:ticketProblems`, `tests/liveOrderTicket.test.ts`).

### Vzdálený watchdog

### INV-WATCH-01: Watchdog pouze vyhodnocuje a deduplikuje incidentní notifikace; nesmí řídit execution

- Proč: Serverový cron nemá stejný čerstvý broker kontext jako lokální worker
  a může se opozdit o celý tick.
- Vynucuje: `server/copierIncidentWatchdog.ts:evaluateCopierIncidents` a
  `planCopyEventNotifications` vracejí popis akcí, samy nezapisují brokerovi;
  `DEFAULT_STALE_AFTER_MS` je 90 s.
- Hlídá test: `tests/copierIncidentWatchdog.test.ts`,
  `tests/copierRelayStuckCron.test.ts`.
- Nikdy: Nepřidávat do watchdogu ARM, auto-reconcile nebo broker Flatten.
- Bezpečné změny vs. nebezpečné: Bezpečná je notifikace opened/resolved s
  dedupe. Nebezpečné je z nepřítomnosti heartbeat odvodit flat nebo poslat
  obchodní příkaz.
- Zaseknutá relay fronta (29. 10. 2026, `relay-stuck`): cron jen ČTE
  `tradovate_copier_commands` (`api/cron/send-alerts.ts:readCopierRelayQueue`)
  pro zařízení s heartbeatem ≤ 30 s. Výstraha: `claimed` brzda > 30 s,
  arm-live/shadow/snapshot-test > 60 s, Flatten/skupina/eligibility > 5 min;
  `pending` brzda > 30 s, jiné > 60 s až po 120 s od startu workeru. Claimed
  jen v2 a z posledních 24 h (pending bez okna). Brzda čekající za běžícím
  (ještě ne zaseknutým) příkazem nevyzývá k ručnímu zavírání — relay je
  sekvenční a ruční exit by kolidoval s Flattenem; v `detail` je jako `w:`
  a jakmile před ní nic legitimně neběží, eskaluje jednou na poplach (`b:`).
  Ohlášená brzda `expired`/`rejected` nebo osiřelá převzatá (> 24 h) =
  okamžitý poplach jednou per příkaz
  (`relay-brake-failed:<id>`), nikdy „průchozí“. Výstraha se uzavírá až bez
  otevřených řádků starších než 30 s a se známým koncem ohlášených id;
  nejistý `copy-command` = poplach. Chyba čtení, výjimka nebo plný limit =
  beze změny. Fronta se nikdy neexpiruje, neopakuje ani nemění a
  `lastError` se nedotýká. PostgREST `.or(...)` filtru je ověřen jen
  mockem (NEOVĚŘENO proti serveru).

## 3. Kontrolní seznam před změnou jádra

Agent-oponent má před schválením změny výslovně odpovědět na každou otázku:

1. Může změna způsobit live ARM bez čerstvého broker syncu, autoritativního
   flat/no-working snapshotu nebo bez všech bran z `INV-ARM-01`?
2. Přidává cache, fallback nebo default, který mění unknown/missing na
   active, flat, connected, eligible nebo zero?
3. Může background proces, reconnect, preparation nebo render stránky smazat
   `lastError`, divergence či `manualRecoveryRequired`?
4. Rozlišuje změna veřejné ruční `reconcile()` od interní read-only kontroly?
5. Co se stane, když během každého await přijde DISARM, kill, config change,
   fill, reconnect, route change nebo restart?
6. Je generation/observation fence zkontrolovaný těsně před raw broker write
   i těsně před commitem výsledku?
7. Může se broker příkaz po timeoutu, ztraceném ACK, restartu nebo retry
   automaticky vykonat podruhé?
8. Je outbox durable uložen před write a zůstane nejistý výsledek viditelný a
   ARM-blocking, dokud ho nepotvrdí autoritativní lookup?
9. U OCO/OSO/modify/cancel: co znamená partial fill, `Filled` po Cancel
   Completed, Pending/Suspended a chybějící jedna noha?
10. Může změna „opravit“ divergence obchodem, dorovnat followera nebo rozšířit
    ownership z pouhé shody account/symbol/quantity?
11. Pokud se zavírá pozice, je cíl prokázaná kopie konkrétního účtu a symbolu?
    Může zásah zavřít ruční obchod nebo jiný symbol?
12. Co se stane, když je výsledek liquidation nejasný nebo chybí order ID?
13. Zachová se management-only správa protective orders bez povolení nových
    entry/scale-in?
14. Může ruční follower toggle, cut, změna leadera/skupiny nebo OAuth route
    proběhnout uprostřed lifecycle či během recovery?
15. Zpřísňuje externí eligibility/risk update pouze stav, nebo umí nechtěně
    obnovit `active`/oslabit `breached`?
16. Proběhne day lock/cooldown až po flat a počítá session hranici přes
    `America/Chicago`, včetně DST?
17. Zůstane DISARM/kill dostupný bez čerstvého statusu a obejde běžnou FIFO?
    Může starší ARM doběhnout po novější brzdě?
18. Je relay retry omezen na transport/ACK, má stabilní idempotency key a
    respektuje serverový `expiresAt`?
19. Řadí UI poll a ACK podle worker `startedAt`, revision a mutation fence?
    Co uvidí uživatel při stale/restored/unknown stavu?
20. Co udělá změna po restartu uprostřed `planned`, `sending`, `unknown`,
    composite partial nebo management-only stavu?
21. Co se stane při dvou OAuth route, skrytém follower reconnectu nebo eventu
    z OAuth, které vidí účet navíc?
22. Co se stane při dvou živých workerech? Pokud odpověď spoléhá na
    nejčerstvější heartbeat, změna nemá skutečné fencing.
23. Respektuje Tradovate `p-time`, Retry-After a sync deadline, nebo může
    vytvořit reconnect/retry storm?
24. Je víkend/closed market jen provozní okolnost, nikoli výjimka z důkazů?
25. Mají nové invarianty deterministický test chyby, restartu, stale výsledku
    a opačného pořadí eventů — nejen happy path?
26. Odděluje předání tvrzení „test prošel“, „UI se vykreslilo“, „worker je
    nainstalovaný“, „broker potvrdil stav“ a „reálný trade conformance“?

## 4. Známé pasti a historické incidenty

- **27. 8. — partial-fill OSO quantity a zrušená ochrana.** Přechodnou
  Pending/Suspended child quantity runtime mylně kopíroval jako replace a na
  followerech zrušil správný SL. Oprava oddělila venue-managed quantity od
  execution shape a zavedla flat-first ARM. Viz `docs/PROJECT_LOG.md`, zápis
  „fatal SL/Flatten incident — stavový emergency close a flat-first ARM“.
- **31. 8. — posun pending SL se ztratil.** Cache shape přepsala cenu, ale
  event nevydala; leader vystoupil na novém SL a followeři zůstali se starým.
  Z toho vznikl pending lifecycle handling, durable leader-flat guard a
  stavové potvrzení Flattenu. Viz zápisy „fatální SL / leader-flat / Flatten“.
- **27. 8. — replay starých terminálních orderů po renewal.** Historický
  oversized `filled` order otevřel falešný fail-closed. Baseline/terminální
  replay se nesmí vydávat za nový risk event. Viz zápis „falešný FAIL-CLOSED
  po pravidelném socket reconnectu“.
- **17.–19. 9. — WS stally, p-ticket a víkendová údržba.** Krátký sync deadline
  vytvořil reconnect loop; p-ticket musí čekat broker `p-time`. V sobotu oba
  sockety během údržby spadly a obnovily se až po nových sessions. Viz
  `docs/PROJECT_LOG.md` 18.–19. 9. a `scripts/copier/pilot.ts:WS_SYNC_TIMEOUT_MS`.
- **17. 9. — druhý Flatten čekal za prvním 265 s.** Druhý risk-reducing
  příkaz nesmí vzniknout naslepo; relay nyní stejné in-flight Flatteny
  coalescuje. Viz komentář v
  `server/tradovateCopierCommandRelay.ts:enqueueTradovateCopierCommand`.
- **Nedělní DISARM bez potvrzeného doručení.** Oddělená prioritní linka mohla
  při ztrátě claim/ACK brzdu pohřbít. Brzdy proto používají obnovitelnou FIFO
  v2, ale execution obcházejí lokální command tail. Viz
  `docs/COPIER_RELAY_RECOVERY_20260913.md` a PROJECT_LOG „balíček 7a-2“.
- **2. 9. — násobek přeskočil na jiný účet při změně leadera.** Konfigurace
  účasti a multiplikátoru je execution stav, nikoli nevinná metadata. Viz
  PROJECT_LOG otevřená otázka/uzavření incidentu a testy
  `tests/liveCopyGroupLeaderSwap.test.ts`.
- **2. 9. — velké rychlé obchody odhalily legitimní i závodní fail-closed.**
  Divergence během scale-in, deadline flat sweepu a modify→filled nesmějí být
  „opraveny“ automatickým obchodem. Viz PROJECT_LOG otevřený bod „Frekvence
  fail-closed při rychlém obchodování velkých velikostí“.
- **30. 9. — krátký reconnect follower route byl skryt agregátem.** Router
  nyní i v grace předává route-scoped resync a controller porovnává stav s
  modelem. Viz `docs/reviews/copier-deployed-review-20260930.md`, D1.
- **4. 10. — návrh automatického veřejného reconcile by schoval incident.**
  ARM preparation proto používá jen interní read-only preflight a durable
  manual-recovery marker. Review 8. 10. ale našlo stejnou starší chybu stále v
  SHADOW a kompatibilní ARM cestě; viz slabé místo 12 níže a
  `docs/COPIER_ARM_PREPARATION_20261004.md`.
- **5. 10. — Cancel Completed s `cumQty 6/18` vypadal jako plný Fill.** Zbytek
  entry se followerům nezrušil a Market exit skončil divergencí. Terminální
  status proto na nejasné cestě vyžaduje celý Order+Fill graph. Viz PROJECT_LOG
  „Incident 15:05 UTC“ a `tests/copierIncident20261005.test.ts`.
- **6. 10. — follower protective order se vyplnil během modify.** Prosté
  `modify→filled` celé skupiny fail-closed bylo příliš hrubé; izolace je
  dovolena jen s přesnou lineage, flat/no-working a all-or-nothing důkazem.
  Viz PROJECT_LOG „Ranní incidenty a nasazení“ a
  `tests/copierProtectiveFilledDuringModify.test.ts`.
- **19. 10. — totéž u samostatného Stopu.** Leader přidal Stop 40 s po vstupu
  a posunul ho; stopy followerů se vyplnily dřív, než modify odešel
  (`neverSent`). Výjimka 6. 10. hledala vlastníka nohy jen v OSO/bracket
  outboxu, celá skupina se vypnula. Oprava: `protectiveEpochId` na place
  položce. `tests/copierStandaloneStopFilledDuringModify.test.ts`.
- **21. 10. — deadlock režimu opravy po startu.** Leader uložené skupiny
  zmizel z OAuth; automatická kontrola po startu nemohla uspět a zůstala
  dlužná (`pendingReadOnlyConnectionRecovery`), `preflightGroupChange` pak
  odmítl i opravu skupiny z UI. Výjimka E2 (30. 9.) byla jen v
  `activateGroup`, z UI nedosažitelná. Teď obě místa používají jedinou
  podmínku `matchesStartupRepairRetirement` (přesně nedostupné účty) a
  preflight dlužnou recovery pro takovou opravu promíjí; běžící recovery dál
  blokuje, aktivace vynutí novou reconciliation. Aktivace přitom maže i
  nedurable `lastError` (starší chování, durable incident přežije).
  `tests/copierStartupRepairDeadlock.test.ts`.
- **21.–22. 10. — ztracený durable incident.** `persistSafety` ukládal celou
  kopii bezpečnostního stavu načtenou při volání; zápis epochy leadera ve
  frontě za `failClosed` vrátil starší incident. UI pak potvrzovalo jiný
  incident, než byl uložený, a Zapnout selhávalo dokola. `persistSafety` je
  teď patch nad stavem v okamžiku zápisu (celou náhradu dělá jen
  `persistSafetyUpdate`); při nesouladu paměť→durable potvrzení nic nesmaže,
  srovná paměť na uložený incident a vyžádá nové výslovné potvrzení
  (INV-DEFAULT-03 beze změny). `tests/copierIncidentLostUpdate.test.ts`.
- **22. 10. — ruční obchod leadera za vypnuté kopírky.** Divergence před
  exitem leadera (follower flat, protože se nic nekopírovalo) zakládala
  durable incident a další Zapnout vyžadovalo potvrzení. Za DISARMED je teď
  stejně jako u kontroly velikosti pozice jen audit + `invalidateReconciliation`
  (`divergenceBeforeLeaderExit`); ARM dál vyžaduje autoritativně flat skupinu
  (INV-ARM-01), za ARMED/SHADOW zůstává fail-closed incident.
  `tests/copierDisarmedManualLeaderTrade.test.ts`.
- **UI flicker po návratu na LIVE.** Uložené ON/OFF a status mají zabránit
  vizuálnímu probliknutí, ale jsou výhradně presentation cache. Viz PROJECT_LOG
  „LIVE kopírka: načítání bez problikávání“ a `lib/copierPowerDisplay.ts`.

## 5. Slabá místa a otevřené otázky

1. **OTÁZKA — dvě živá zařízení na jednom OAuth connection (N6).** Relay
   vybírá nejčerstvější heartbeat, ale to není fencing. ARM má být odmítnut při
   více čerstvých execution workerech a brzda fan-outována na všechna
   nerevokovaná zařízení, nebo musí být zaveden jediný lease owner.
2. **NEOVĚŘENO V RUNTIME — VPS/Fly entry a worker lease.** Lease, Supabase
   store i migrace existují, ale žádný worker entry je společně nezapojil.
   `docs/COPIER_VPS_PLAN.md` je plán, ne důkaz hotového runtime.
3. **OTÁZKA — bezpečný bootstrap pilot lease (ST34).** Nová instalace potřebuje
   lease před vznikem/spárováním device klíče. Pokud zůstane JWT bootstrap,
   musí být omezený na klíč z potvrzeného pairing requestu, krátký TTL a bez
   obnovy; cílově se lease vydává až přes device auth po párování.
4. **OTÁZKA — úplný distribuovaný ACK fence.** `CopierStatusAckFence` chrání
   jednu UI instanci, ale komentář v kódu výslovně uvádí, že worker nemá vlastní
   `gateSeq`. Brake epoch chrání ARM v execution agentu; obecná distribuovaná
   monotónnost všech mutací není formálně sjednocena.
5. **OTÁZKA — ST17 baseline množiny účtů pro session tighten-only.** Přidání
   nebo záměna účtů během session má být posuzována proti neměnné baseline;
   otevřený bod je veden v PROJECT_LOG.
6. **OTÁZKA — víkendový end-to-end reconnect test.** Kód nemá kalendářní
   bypass a jednotlivé reconnect/safety testy existují, ale chybí explicitní
   scénář dlouhé víkendové maintenance: dva OAuth sockety, p-ticket, restart,
   prázdné/opožděné snapshoty a následný ARM pokus.
7. **OTÁZKA — Mac file store předpokládá jediný proces.** Tento předpoklad
   drží launchd/instalační disciplína, ne databázový fence. Před jakýmkoli
   paralelním Mac workerem je nutné zavést OS lock nebo přejít na fenced store.
8. **OTÁZKA — reconnect rate-limit rozpočet je sdílen s dalšími klienty na
   IP/login.** Worker umí breaker a respektuje p-ticket, ale nemá globální
   koordinátor s webem, Tradovate platformou a dalšími zařízeními.
9. **OTÁZKA — přepnutí/odpojení OAuth vs. ARM není atomická DB transakce.**
    Worker provádí těsnou serverovou kontrolu a fail-safe DISARM, ale PROJECT_LOG
    stále uvádí milisekundové okno jako odložené.
10. **OTÁZKA — watchdog hranice 90 s je observační kompromis.** Watchdog je
    správně neobchodní, ale upozornění může přijít později než 10s freshness
    relay brány. Tyto dvě hodnoty se nesmějí sloučit do jedné „worker alive“
    autority.
11. **NEOVĚŘENO — skutečná latence připraveného ON a plný live conformance po
    posledních změnách.** Offline testy potvrzují vynechaná čtení a zachované
    brány; neprokazují konkrétní telefon→relay→worker latenci ani celý nový
    DEMO/LIVE trade cycle.
12. **SLABÉ MÍSTO — SHADOW a kompatibilní ARM mohou smazat incident.** Obě
    cesty v `localCopierExecutionAgent` volají veřejné `reconcile()`, které má
    `clearLastError:true` a po čistém výsledku odstraní také
    `manualRecoveryRequired`. Oprava má oddělit interní read-only preflight od
    explicitní uživatelské recovery a přidat regrese pro obě cesty; do té doby
    nelze tvrdit, že incident smaže výhradně tlačítko „Kontrola pozic“.
13. **SLABÉ MÍSTO — relay idempotency nekryje nový klientský pokus.** Webový
    klient generuje UUID při každém volání. Server coalescuje Flatten a ARM,
    ale opakovaný DISARM, reconcile nebo set-konfigurace s novým klíčem založí
    další durable command. Downstream brány a outbox brání blind broker retry,
    takže nejde samo o sobě o důkaz duplicitního obchodu; je to ale porušení
    vazby „jeden uživatelský záměr = jeden command“ a může opakovat preflight,
    audit či mutaci. Oprava má držet operation key přes retry/dvojklik nebo
    zavést přesně definované serverové coalescing i pro tyto příkazy.
14. **MRTVÝ NEBEZPEČNÝ EXPORT — `planReconciliation`.** Funkci volají jen její
    unit testy; runtime ji nepoužívá. Plánuje Market order k dorovnání follower
    pozice a její budoucí zapojení by porušilo zákaz Auto-Sync. Doporučení je
    export i testy odstranit, případně jej přesunout mimo execution kód tak,
    aby jej nešlo omylem připojit bez nového explicitního safety rozhodnutí.
15. **SLABINA — commit izolace po ochranném fillu bez fence (od 6. 10.).**
    `commitProtectiveIsolation` po posledním `await` v prepare už nekontroluje
    `stopped`, safety generation ani `gate.armed`; DISARM/kill zařazený mezi
    prepare a `processor.mutate` přesto zapíše pauzu a waiver. Dopad je malý
    (stav je autoritativně flat), ale fence by měl odpovídat ostatním cestám.

## Minimální předávací důkazy po změně

Dokumentace invariantů nenahrazuje testování. Podle rozsahu změny je minimem:

- cílené testy každého dotčeného invariantu včetně chyby, stale výsledku,
  restartu a opačného pořadí;
- celá relevantní `tests/copier*`, relay a Tradovate sada;
- `npx tsc --noEmit`, `npm test -- --run`, `npm run build` podle pravidel repa;
- samostatně uvést, zda proběhl jen lokální test, render UI, deployment,
  instalace workeru, čerstvý broker read nebo řízený trade conformance;
- nikdy z úspěchu jedné vrstvy nedovozovat úspěch jiné.
