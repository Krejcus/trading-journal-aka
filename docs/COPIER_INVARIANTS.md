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

### INV-DEFAULT-02: Neznámý nebo chybový stav zastaví nové riziko; auto-close smí zasáhnout jen prokázané kopie podle explicitní politiky

- Proč: Obecný account-wide close by mohl zavřít ruční pozici; pouhé DISARM
  bez správy prokázané otevřené kopie by naopak mohl nechat orphan expozici.
- Vynucuje: `services/copierRuntimeController.ts:failClosed`,
  `autoFlattenCopies`, `services/copierLeaderFlatGuard.ts:evaluateLeaderFlatBatch`.
- Hlídá test: `tests/copierAutoCloseV9V4.test.ts`,
  `tests/copierLeaderFlatGuard.test.ts`, `tests/copierChaosScenarios.test.ts`.
- Nikdy: Nevykládat fail-closed jako povolení k libovolnému Flatten All ani
  jako důkaz, že účet je flat.
- Bezpečné změny vs. nebezpečné: Bezpečné je disarmovat, uložit incident a
  použít přesný `{accountId, symbol}` ownership guard. Nebezpečné je rozšířit
  scope podle shody symbolu, historie účtu nebo pouhé konfigurace followera.

### INV-DEFAULT-03: Ne-transportní incident přežije restart a odstraní jej jen čistá veřejná kontrola pozic

- Proč: Background preflight nebo benigní reconnect nesmí schovat incident,
  který má vidět člověk.
- Vynucuje: `services/copierRuntimeController.ts:bootstrapCopierRuntime`,
  `failClosed`, `performReconciliation`; durable
  `safety.manualRecoveryRequired`.
- Hlídá test: `tests/copierWorkerArmPreparation.test.ts`.
- Nikdy: Nemazat `lastError` ani manual-recovery marker při přípravě ON,
  heartbeatu, interním reconnect recovery nebo pouhém restartu.
- Bezpečné změny vs. nebezpečné: Bezpečné je odstranit marker po
  `authoritativelyClean` veřejném `reconcile()`. Nebezpečné je volat veřejné
  `reconcile()` automaticky jen proto, aby se ON zrychlilo.

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
  nevyřazený follower. `services/copierRiskGate.ts:haltReason` stejné zásady
  znovu hlídá před dispatchí.
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
- Hlídá test: `tests/copierWorkerArmPreparation.test.ts`,
  `tests/copierArmPreparation.test.ts`.
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
  `tests/localCopierExecutionAgent.test.ts`,
  `tests/liveCopyGroupPowerInteraction.test.ts`.
- Nikdy: Nedovolit, aby timeoutovaný nebo zrušený ARM doběhl po novějším
  DISARM/kill příkazu.
- Bezpečné změny vs. nebezpečné: Bezpečné je monotónně zvyšovat generation a
  před každým write ji znovu porovnat. Nebezpečné je kontrolovat ji jen při
  začátku příkazu.

### INV-ARM-04: Shadow mode nesmí nikdy dispatchovat broker write

- Proč: Shadow slouží k pozorování a plánování bez finančního side effectu.
- Vynucuje: `services/copierRiskGate.ts:evaluateRiskGate` vrací `dispatch=false`
  v shadow; `services/copierRuntimeController.ts:dispatchBroker` shadow znovu
  odmítá.
- Hlídá test: `tests/copierRiskGate.test.ts`, `tests/copierRunner.test.ts`,
  `tests/copierRuntimeController.test.ts`.
- Nikdy: Nevykládat `armed=true, shadowMode=true` jako live ARM. Některé live
  ARM brány jsou pro shadow úmyslně volnější, protože write je zakázaný.
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

### INV-BRAKE-02: Kill switch je jednosměrná západka pro daný runtime a nesmí spustit pozdější automatiku

- Proč: Nouzový freeze musí přebít fronty, recovery i resume nabídky.
- Vynucuje: `services/copierRuntimeController.ts:engageKillSwitch`;
  `services/copierRiskGate.ts:haltReason`; kill lze resetovat jen novým
  bootstrapem, který opět startuje DISARMED a vyžaduje kontrolu.
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierChaosScenarios.test.ts`, `tests/localCopierExecutionAgent.test.ts`.
- Nikdy: Nepřidávat „unlock kill“ za běhu ani automatický re-ARM po reconnectu.
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

### INV-BRAKE-04: Day lock čeká na flat, platí do konce Tradovate session a ručně se neodemyká

- Proč: Zamknutí uprostřed obchodu nesmí opustit kopie; ruční odemknutí by
  obešlo anti-revenge pojistku.
- Vynucuje: `services/copierRuntimeController.ts:maybeEngageDayLock`, `lockUntil`,
  `unlockDay`; `services/copierArmSession.ts:msUntilTradovateSessionEnd`.
- Hlídá test: `tests/copierDayRuleActions.test.ts`,
  `tests/copierArmSession.test.ts`, `tests/copierRuntimeController.test.ts`.
- Nikdy: Neaktivovat lock jako důvod k account-wide close uprostřed expozice a
  nepřidávat běžné UI odemknutí.
- Bezpečné změny vs. nebezpečné: Bezpečné je uložit pending lock a aplikovat ho
  po potvrzeném flat. Nebezpečné je počítat konec pevnými 24 hodinami bez DST.

### INV-BRAKE-05: Expirace ARM nejprve odzbrojí a podle `armExpiryFlatten` risk-redukčně zavře jen prokázané kopie; shadow nikdy neobchoduje

- Proč: Samotná expirace nesmí nechat vlastněné kopie bez dozoru, ale nesmí se
  změnit v account-wide zásah do ručních pozic.
- Vynucuje: `services/copierRuntimeController.ts:maybeHandleArmExpiry` a
  `autoFlattenCopies`; scope pochází z
  `services/liveCopyTrading.ts:DEFAULT_COPY_GROUP_SAFETY.armExpiryFlatten`.
- Hlídá test: `tests/copierAutoCloseV9V4.test.ts`,
  `tests/copierRuntimeController.test.ts`, `tests/copierChaosScenarios.test.ts`.
- Nikdy: Neprovádět expiry close v shadow režimu, při policy `off` ani mimo
  přesný ownership/scope; nečekat s DISARM na dokončení close. Policy `off`
  vypíná broker close, nikoli povinnou read-only kontrolu po reconnectu.
- Bezpečné změny vs. nebezpečné: Bezpečné je nejprve durable zaznamenat
  `arm-expiry`, vypnout gate a teprve potom spustit ohraničený close. Nebezpečné
  je prodloužit ARM kvůli tomu, že auto-close právě běží.

### Kontrola pozic a reconciliation

### INV-RECON-01: Reconnect, restart a invalidace vyžadují novou autoritativní kontrolu; reconnect nikdy sám neARMuje

- Proč: Události mohly během mezery chybět a historický model nemusí odpovídat
  venue.
- Vynucuje: `services/copierLeaderEventSource.ts:needsReconciliation` a
  `acknowledgeReconciliation`; `services/copierRuntimeController.ts:invalidateReconciliation`,
  `performReconciliation`, connection recovery.
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierChaosScenarios.test.ts`, `tests/copierGraceReconnectD1.test.ts`.
- Nikdy: Nepovažovat `connected=true` nebo úspěšný WS sync za povolení k ARM.
- Bezpečné změny vs. nebezpečné: Bezpečné je po reconnectu automaticky udělat
  read-only kontrolu a zůstat OFF. Nebezpečné je obnovit minulý ON stav.

### INV-RECON-02: Veřejné `reconcile()` je auditovaný recovery úkon; interní kontroly nesmí mazat incident

- Proč: Stejná čtení mají jinou autoritu podle toho, zda člověk výslovně
  zahájil recovery.
- Vynucuje: `services/copierRuntimeController.ts:reconcile` volá
  `performReconciliation({clearLastError:true})`; interní volání používají
  výchozí `clearLastError=false`; `runReconciliation` maže chybu jen při
  `authoritativelyClean`, nezměněné generation a neaktivním kill switchi.
- Hlídá test: `tests/copierPreflightDisarmedReconcile.test.ts`,
  `tests/copierWorkerArmPreparation.test.ts`, `tests/copierRuntimeController.test.ts`.
- Nikdy: Nevolat veřejné `reconcile()` z background preflightu nebo jako
  vedlejší efekt zobrazení stránky.
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

### INV-DIVERGENCE-01: Divergence je `halt-group`, ne příležitost k automatickému dorovnávacímu obchodu

- Proč: Bez spolehlivé kauzality nelze poznat, zda rozdíl pochází z ručního
  obchodu, chybějícího eventu nebo neznámého fillu.
- Vynucuje: `services/copierRiskGate.ts:haltReason`,
  `services/copierEngine.ts:planReconciliation`,
  `services/copierRuntimeController.ts:performReconciliation`.
- Hlídá test: `tests/copierEngine.test.ts`, `tests/copierRiskGate.test.ts`,
  `tests/copierRuntimeController.test.ts`.
- Nikdy: Neopravovat rozdíl Market příkazem ani „Auto-Syncem“.
- Bezpečné změny vs. nebezpečné: Bezpečné je disarmovat, ukázat účty a po
  ručním zásahu autoritativně zkontrolovat flat. Nebezpečné je odvodit cíl jen
  z leader quantity a automaticky followera dorovnat.

### Pořadí a čerstvost stavu

### INV-FRESH-01: Safety generation a broker observation fence chrání raw write i výsledky pomalých čtení

- Proč: Kontrola provedená pouze na vstupu do async operace zastará během
  čekání na broker/store.
- Vynucuje: `services/copierRuntimeController.ts:dispatchBroker`,
  `invalidateReconciliation`, `performReconciliation`.
- Hlídá test: `tests/copierRuntimeController.test.ts`,
  `tests/copierV12Staleness.probe.test.ts`, `tests/copierRouteGapV6.test.ts`.
- Nikdy: Nepřesouvat finální generation check před await broker callu.
- Bezpečné změny vs. nebezpečné: Bezpečné je přidat další monotónní epochu.
  Nebezpečné je použít wall-clock timestamp jako jediný fence.

### INV-FRESH-02: UI přijímá status jen v pořadí worker epochy a revision; poll nesmí přepsat novější mutation ACK

- Proč: Relay, local agent a browser poll mohou odpovědět mimo pořadí.
- Vynucuje: `lib/copierStatusPollFence.ts:CopierStatusPollFence`,
  `CopierStatusAckFence`, `shouldAcceptCopierStatus`;
  `components/TradovateLiveDesk.tsx:acceptAgentStatus`.
- Hlídá test: `tests/copierStatusPollFence.test.ts`,
  `tests/copierRelayStatusPoll.test.ts`, `tests/liveCopyGroupPowerInteraction.test.ts`.
- Nikdy: Neřadit status pouze podle arrival time nebo stejné `revision` napříč
  restarty.
- Bezpečné změny vs. nebezpečné: Bezpečné je kombinovat `startedAt` a
  monotónní revision. Nebezpečné je odstranit poll invalidaci kolem mutací.

### INV-FRESH-03: Worker status starší než 15 s ani obnovená cache nesmí autorizovat běžný příkaz

- Proč: UI může přežít reload, uspání nebo mrtvý worker, zatímco poslední
  hodnoty vypadají věrohodně.
- Vynucuje: `lib/copierForegroundPoller.ts:isCopierStatusFresh`,
  `lib/copierSafetyControls.ts:copierAgentCommandAllowedWhileRestored`,
  `components/TradovateLiveDesk.tsx:executeAgent`.
- Hlídá test: `tests/copierForegroundPoller.test.ts`,
  `tests/copierSafetyControls.test.ts`, `tests/copierPowerDisplay.test.ts`.
- Nikdy: Nepoužít localStorage/restored status pro ARM, změnu skupiny,
  reconciliation nebo risk-zvyšující příkaz.
- Bezpečné změny vs. nebezpečné: Bezpečné je cache zobrazit jako „obnovené“ a
  dovolit přesně vyjmenované risk-reducing Flatteny. Nebezpečné je zobrazit
  cached ON jako potvrzený live stav.

### Relay příkazy

### INV-RELAY-01: Relay příkaz má stabilní idempotency key, konečné TTL a jeden durable výsledek

- Proč: Opakované kliknutí nebo ztracená HTTP odpověď nesmí založit druhou
  execution.
- Vynucuje: `server/tradovateCopierCommandRelay.ts:enqueueTradovateCopierCommand`,
  `findInFlightFlatten`, `findInFlightArm`, `coalesceInsertedArm`; brzdy mají
  TTL 10 min, běžné příkazy 30 s a durable pole `idempotencyKey`.
- Hlídá test: `tests/tradovateCopierCommandRelay.test.ts`,
  `tests/copierRelayDetailedReview.test.ts`.
- Nikdy: Nevytvářet nový command ID při pouhém timeoutu čekání na starý
  výsledek; odlišný současný ARM payload nesmí být deduplikován jako shodný.
- Bezpečné změny vs. nebezpečné: Bezpečné je dohledat původní command podle
  idempotency key. Nebezpečné je automaticky znovu enqueueovat mutaci.

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
  `tests/copierRuntimeCommandAdapter.test.ts`.
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
- Hlídá test: `tests/copierArmSession.test.ts`, `tests/copierDailyRules.test.ts`.
- Nikdy: Nepočítat konec session jako `now + 24h` ani jako konstantní UTC čas.
- Bezpečné změny vs. nebezpečné: Bezpečné je používat jedinou sdílenou helper
  funkci. Nebezpečné jsou lokální kopie časové logiky v UI/relay.

### Management-only, shadow a liquidation recovery

### INV-MODE-01: Management-only se zapne jen pro autoritativně prokázanou existující kopii a nesmí přijímat nové entry

- Proč: Při neúplném lifecycle je bezpečnější udržet SL/TP/exit známé kopie než
  celý runtime vypnout; režim ale nesmí rozšířit riziko.
- Vynucuje: `services/copierRuntimeController.ts:enterManagementOnlyAfterProtectedTargetFailure`,
  `services/copierRiskGate.ts:haltReason`, `arm` a `reconcile`.
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
  odmítá stale fence. **NEOVĚŘENO V RUNTIME:** vyhledání volajících potvrzuje,
  že lease nemá worker entry; Mac používá `scripts/copier/pilot.ts` +
  `fileCopierStore`.
- Hlídá test: `tests/supabaseCopierStore.test.ts`; **žádný přímý test lease API
  ani end-to-end test reálného VPS entry**, protože entry neexistuje.
- Nikdy: Nespouštět druhou execution instanci jen s předpokladem, že relay
  vybere jednu; heartbeat routing není fencing.
- Bezpečné změny vs. nebezpečné: Bezpečné pořadí je acquire lease → store s
  fence → runtime → renew; první renew failure → terminální DISARM/stop.
  Nebezpečné je lease za běhu znovu získat po možné změně vlastníka.

### INV-WORKER-03: Device secret a scope určují identitu/oprávnění relaye, ale samy neřeší souběh dvou workerů

- Proč: Párování chrání přístup, nikoli jedinečnost execution vlastníka.
- Vynucuje: `server/tradovateCopierDevice.ts:registerTradovateCopierDevice`,
  `authenticateTradovateCopierDevice`; `server/macCopierDevice.ts` Keychain
  helpers; `server/tradovateCopierCommandRelay.ts:selectRelayDeviceTarget`.
- Hlídá test: `tests/tradovateCopierDevice.test.ts`,
  `tests/macCopierDevice.test.ts`, `tests/copierRelayOwnerResolve.test.ts`.
- Nikdy: Nevydávat „nejčerstvější heartbeat vyhrává“ za split-brain ochranu.
- Bezpečné změny vs. nebezpečné: Bezpečné je revokovat zařízení a scope
  kontrolovat serverově. Nebezpečné je povolit ARM při více čerstvých
  execution zařízeních bez lease/fence.

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
  `tests/tradovateBrokerRequestDedup.test.ts`.
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

### INV-UI-01: Neznámý, stale nebo obnovený stav se zobrazuje neutrálně a nesmí se tvářit jako ON, connected nebo flat

- Proč: Prezentační cache přežívá worker a její kladná hodnota by jinak
  vytvořila falešnou autoritu.
- Vynucuje: `components/TradovateLiveDesk.tsx:agentStatusDisplayFresh` a
  `runtimeAvailable`,
  `lib/copierPowerDisplay.ts:readCopierPowerDisplay`,
  `lib/copierAgentStatusStore.ts:readCopierAgentStatusSnapshot`.
- Hlídá test: `tests/copierPowerDisplay.test.ts`,
  `tests/copierForegroundPoller.test.ts`, `tests/liveCopyCompactRender.test.ts`.
- Nikdy: Neukazovat cached ON zeleně jako aktuální worker stav a nedoplňovat
  missing positions nulou.
- Bezpečné změny vs. nebezpečné: Bezpečné je „načítám/neověřeno/obnoveno“ se
  zachovanou poslední hodnotou pro kontext. Nebezpečné je skrýt unknown za
  optimistický přepínač.

### INV-UI-02: DISARM a kill jsou vždy dosažitelné; ostatní mutace vyžadují čerstvý worker status

- Proč: Safety akce musí fungovat právě tehdy, když běžná command brána neví,
  zda je runtime dostupný.
- Vynucuje: `components/TradovateLiveDesk.tsx:executeSafetyCommand`,
  `lib/copierSafetyControls.ts:selectCopierSafetyRoute` a
  `copierAgentCommandAllowedWhileRestored`.
- Hlídá test: `tests/copierSafetyControls.test.ts`,
  `tests/liveCopyDisarmPanelRender.test.ts`, `tests/liveCopyAdversarialUiReview.test.ts`.
- Nikdy: Neschovávat OFF kvůli stale pollu a naopak nepouštět ARM/config přes
  poslední známou route bez fresh statusu.
- Bezpečné změny vs. nebezpečné: Bezpečné je oddělit safety command path od
  běžných commandů. Nebezpečné je sdílet jednu obecnou `disabled={!fresh}`.

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

### Vzdálený watchdog

### INV-WATCH-01: Watchdog pouze vyhodnocuje a deduplikuje incidentní notifikace; nesmí řídit execution

- Proč: Serverový cron nemá stejný čerstvý broker kontext jako lokální worker
  a může se opozdit o celý tick.
- Vynucuje: `server/copierIncidentWatchdog.ts:evaluateCopierIncidents` a
  `planCopyEventNotifications` vracejí popis akcí, samy nezapisují brokerovi;
  `DEFAULT_STALE_AFTER_MS` je 90 s.
- Hlídá test: `tests/copierIncidentWatchdog.test.ts`, `tests/copierWatchdog.test.ts`.
- Nikdy: Nepřidávat do watchdogu ARM, auto-reconcile nebo broker Flatten.
- Bezpečné změny vs. nebezpečné: Bezpečná je notifikace opened/resolved s
  dedupe. Nebezpečné je z nepřítomnosti heartbeat odvodit flat nebo poslat
  obchodní příkaz.

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
  manual-recovery marker. Viz `docs/COPIER_ARM_PREPARATION_20261004.md`.
- **5. 10. — Cancel Completed s `cumQty 6/18` vypadal jako plný Fill.** Zbytek
  entry se followerům nezrušil a Market exit skončil divergencí. Terminální
  status proto na nejasné cestě vyžaduje celý Order+Fill graph. Viz PROJECT_LOG
  „Incident 15:05 UTC“ a `tests/copierIncident20261005.test.ts`.
- **6. 10. — follower protective order se vyplnil během modify.** Prosté
  `modify→filled` celé skupiny fail-closed bylo příliš hrubé; izolace je
  dovolena jen s přesnou lineage, flat/no-working a all-or-nothing důkazem.
  Viz PROJECT_LOG „Ranní incidenty a nasazení“ a
  `tests/copierProtectiveFilledDuringModify.test.ts`.
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

## Minimální předávací důkazy po změně

Dokumentace invariantů nenahrazuje testování. Podle rozsahu změny je minimem:

- cílené testy každého dotčeného invariantu včetně chyby, stale výsledku,
  restartu a opačného pořadí;
- celá relevantní `tests/copier*`, relay a Tradovate sada;
- `npx tsc --noEmit`, `npm test -- --run`, `npm run build` podle pravidel repa;
- samostatně uvést, zda proběhl jen lokální test, render UI, deployment,
  instalace workeru, čerstvý broker read nebo řízený trade conformance;
- nikdy z úspěchu jedné vrstvy nedovozovat úspěch jiné.
