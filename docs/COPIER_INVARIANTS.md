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
- C12 (4. 11. 2026): po restartu je worker DISARMED, takže vlastní čekající vstupy z appky (z flat
  i přikoupení) revize čekajících vstupů zruší jedním cíleným pokusem, jakmile je spojení nahoře
  a nic se neobnovuje (`reviewPendingOwnEntries`, viz INV-BRAKE-01) — žádné „pokračování“ čekajícího
  vstupu. Záznam, jehož zrušení začalo před restartem (`cancel` `sending`/`failed`/`sent`) a vstup
  u brokera dál pracuje = incident jednou, nikdy druhý pokus. Každý ne-Market záznam `sending`
  po restartu (i vstup z flat bez id, oponentura C12 P2) = `unknown` + trvalý incident
  (`recordWhenDisarmed`); bez id ho revize zrušit nemůže, uživatel ho zruší v Tradovate.
  Oponentura kolo 2 (P3): záznam se zrušením z předchozího běhu BEZ ověřeného výsledku (`cancel` bez
  `verified` — pád mezi durable `sending` a `sent`/`verified`; ne starší než 24 h) po dokončení startovní
  obnovy spojení jednou ohraničeně přečte `verifyRestartedOwnEntryCancels` bez ohledu na cache (revize
  vidí jen vstup, který v cache pracuje; bez zápisu k brokerovi, sekvenčně): `canceled`/`ended` = jen
  výsledek, fill i dílčí (zbytek zrušený, kaskáda NEOVĚŘENÁ) = ověření nohou čtením
  (`checkCancelEntryFillProtection` — nohy i pozice, kolo 5; jinak incident `fill-unprotected`), vstup dál pracuje = incident
  `restart-cancel`, nečitelné = `unverified` + incident „nejde po startu ověřit“. `verified` se zapíše bez
  posunu `updatedAt` (push o výsledku jen v okně od zápisu; incident si `updatedAt` posune sám). Revize
  takový záznam podruhé nečte. Starší záznamy (> 24 h) se nečtou (nečitelné staré id = falešný incident).
  Oponentura kolo 3 (P3): výsledek fillu (`filled` / `partially-filled`) se uloží až PO kontrole nohou
  a nese durable značku „nohy ověřeny“ (`cancel.legsCheckedAt`, k ní `cancel.fillQty`); pozdní Fill po
  výsledku „zrušen“ zapíše pravdivý fill hned jako PŘEDZNAČKU bez `legsCheckedAt`, značku až po kontrole.
  Záznam s fillem bez `legsCheckedAt` (pád během kontroly nohou) po startu ověří
  `verifyRestartedOwnEntryCancels` znovu: nohy čtením (fill = největší známý, výsledek se nikdy nesníží
  na „zrušen“, REST cumQty může být pozadu), jinak incident `fill-unprotected`, pak značka. Test:
  `tests/manualPendingEntryReplay.test.ts` (kolo 3: restart s `verified: filled` bez značky, pád během
  kontroly nohou po zrušení i po pozdním Fill).
  Test: `tests/manualPendingEntryReplay.test.ts` (restart se zrušením v `sending`, restart v `sending`;
  kolo 2: restart v `cancel: sending` + REST `canceled` 1/2 s nohami pryč, REST nečitelný, vstup dál pracuje).

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
- C12 (4. 11. 2026): incidenty k čekajícímu vstupu (dílčí fill se neruší, zrušení bez účinku /
  neověřené, follower brání zrušení, restart se zrušením) se vyhlásí JEDNOU za (záznam, druh) —
  durable `manualEntries[].pendingIncidentKinds` přežije restart (oponentura kolo 1, P3: dedup jen
  podle záznamu by pozdější jiný problém, např. „nejde přečíst“ → „zrušení bez účinku“, schoval pod
  starým textem), `failClosed` s `recordWhenDisarmed` (i historie vypnutí za DISARMED), bez auto-close.
  Výjimka (rozhodnutí Filipa 5. 11. 2026, INV-BRAKE-01): druhy `outside-position` a `outside-position-filled` jsou
  jen upozornění, `failClosed` ani `lastError` nezapisuje a vyhlásí se z cache streamu bez čtení; nic neautorizuje. Stejně jednou za (záznam, druh).
  Poslední incident (`pendingIncidentAt` + `pendingIncidentText`) jde do statusu
  `manualEntries[].pendingIncident` → per-záznamový push watchdogu (INV-WATCH-01) — obecný
  `fail-closed` se otevře jen jednou a za kill vůbec, takže by druhý incident C12 zapadl. Incident,
  který by vznikl jen z cache streamu (vstup po zrušení z dřívějšího běhu „dál pracuje“, dílčí fill
  „zbytek dál čeká“, ruční zrušení „se neprojevilo“), se vyhlásí až podle čerstvého REST čtení
  vstupu (`confirmPendingEntryIncident`, bez zápisu; vstup skončil = žádný incident, fill → ověření
  nohou; nečitelné = incident s „stav nejde ověřit“). Fill při rušení s nepotvrzenými SL/TP
  (`checkCancelEntryFillProtection`) jde u C12 per záznam, u C7 přes `failClosed` s `recordWhenDisarmed`.
  Oponentura kolo 3 (P2): po odmítnutém / selhaném zrušení se incident „nepodařilo zrušit — vstup dál
  čeká“ / „nejde ověřit“ vyhlásí až podle čtení po ustálení (první REST po TooLateToCancel fill ještě
  neukazuje — incident by tvrdil čekající příkaz u otevřené pozice). Pozice followera, která z tohoto
  vstupu pocházet nemůže, incident (a tím DISARM) nevyvolá (INV-BRAKE-01). Rozhodnutí Filipa 5. 11. 2026: pozice
  mimo appku za ARMED vstup neruší, jen upozorní (`outside-position`, bez `failClosed`); při rušení z ostatních
  důvodů se vlastní vstup z flat proti pozici na opačné straně zruší (clOrdId = tag záznamu, záložně
  `parentOrderId` nohou — obojí u `placeOSO` NEOVĚŘENO na brokeru), incident nevznikne;
  nové druhy `copy-filled` / `copy-cancel-failed` (kopie po zrušení vstupu leadera za DISARMED).
  Oponentura kolo 2 (P1): dílčí fill doručený streamem v okně pozdní kontroly těsně před `cancelOrder`
  (vstup dál pracuje) = incident `partial` „zbytek dál čeká“ podle čerstvého REST — dřív se pokus bral
  jako uzavřený (značka zůstala, revize záznam přeskočila) a o zbytku za DISARMED / kill nikdo nevěděl.
  Hlídá test: `tests/manualPendingEntryReplay.test.ts` (dedup podle druhu, incident při už otevřeném
  jiném incidentu / kill, restart se zrušením `sent` a starou cache), `tests/liveCancelPending.test.ts`
  (C7 restart: historie vypnutí).
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
- UI (5. 11. 2026): každý safety příkaz včetně `flatten-group` synchronně zvedne `armCancelEpochRef`
  v `TradovateLiveDesk.tsx:executeSafetyCommand`. `lib/copierArmPreparation.ts:createCopierArmGuard`
  ji porovná před `snapshot-test` s opravou kamery, `activate-group` i `arm-live`; rozběhnuté ON po
  brzdě nic neodešle, i když Flatten mezitím začal i skončil. Nové ON má novou pojistku, takže rearm
  po Flattenu funguje. Hláška říká jen „tímto požadavkem se kopírka nezapnula“, po odeslaném
  `activate-group` i to, že se skupina mohla přepnout. Toast „připojený“ jen po potvrzeném ARM. Už
  odeslaný `arm-live` UI odvolat neumí. Hlídá `tests/liveSafetyFallback.test.ts`.

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
- **C12 (4. 11. 2026, nový text; `docs/reviews/trading-gaps-designs/safety.md` C12 + posudek
  copier-design-critic):** vlastní čekající vstup z appky smí existovat jen pod živým ARM. DISARM
  (ruční, incident, transport — až po obnově spojení —, restart), shadow, kill, denní zámek (i
  čekající), pauza pravidlem dne, management-only, nezpůsobilý leader, konec obchodního okna
  (i 5 min před), denní pauza CME `[16:00 − 5 min, 17:00)` CT, konec session a 5 min do vypršení ARM
  zruší **vlastní čekající vstupy z appky** (z flat i přikoupení) jedním cíleným `cancelOrder` podle id z vlastního záznamu
  (`services/copierRuntimeController.ts:reviewPendingOwnEntries` → `cancelOwnManualEntry` s
  `preRead`; čisté pravidlo `services/manualPendingEntries.ts:pendingOwnEntryViolation`). Není to
  zavření pozice ani account-wide akce; vyplněný či částečně vyplněný vstup a ochranné nohy se
  nikdy neruší (dílčí fill = jen incident). Před zrušením čerstvé REST čtení vstupu
  (`pendingEntryPreReadDecision`: zrušit jen čekající s fillem 0, nikdy nohu ani ochranu), po zrušení
  výsledek jen stavem u brokera (`verifyOwnEntryCancel` nad C7 `cancelEntryOutcome`; „zrušen“ jen
  `canceled` s fillem 0, fill → pravdivý audit + ověření nohou, dál pracuje / nečitelné = incident).
  Odklad bez pokusu: bez spojení, při běžící obnově spojení, s nezpracovanými eventy leadera,
  u přikoupení během změny celé pozice; ruční `cancel-entry` téhož vstupu (běžící / neznámý) má
  přednost a jeho neúčinný výsledek se automaticky neopakuje (jen incident). Skupina s followery:
  follower, jehož pozice na symbolu MŮŽE pocházet z tohoto vstupu (kopie vstupu z `links` má fill > 0,
  nebo vazba existuje a stav kopie cache nezná — `followerCopyFromEntryState`), follower bez načtené
  pozice (chybějící cache účtu není flat, oponentura kolo 1 P3) nebo nepokrytá on-submit vazba =
  incident místo zrušení. **Kolo 4 (P2):** „může pocházet z tohoto vstupu“ = kopie má fill i bez
  doručené Position followera (Fill před Position), nebo follower s pozicí má vazbu bez známého stavu
  kopie; „odjinud“ smí revize i C7 usoudit jen nad dohnaným a ustáleným stavem followera
  (`followerPositionOrigin`): follower bez nezpracovaných eventů (`pendingTradeIngressByAccount` 0) a jeho
  pozice na symbolu beze změny ≥ `PENDING_ENTRY_OUTSIDE_SETTLE_MS` (2 s, `followerPositionSeen`) — jinak
  ODKLAD (žádné zrušení ani incident; C7 `busy` „zkus to znovu“), protože Position followera může
  předběhnout Order/Fill kopie (sonda B3: dřív tichá divergence za DISARMED, B4: za ARMED fail-closed
  s auto-close). Stejná podmínka se synchronně vyhodnotí v pozdní kontrole těsně před `cancelOrder`
  (změna followera během předčtení / durable `sending` = nic neodejde, `cancel` zpět neodeslaný).
  **Rozhodnutí oponentury kolo 3 (P2, 4. 11. 2026):** když vstup ruší některý z důvodů výš, pozice followera
  odjinud (ruční obchod v Tradovate zkopírovaný kopírkou za ARMED — „pozice mimo appku“ —, vlastní
  pozice followera, on-fill follower bez kopie, on-submit kopie s fillem 0) zrušení NEBLOKUJE: vstup
  leadera se zruší a kopie followerů lifecycle `terminalCancel`, ARM zůstane (např. denní pauza CME). Dřív taková pozice
  vyvolala incident → `failClosed` → DISARM uprostřed živého kopírovaného obchodu (posuny SL/TP
  a dílčí výstupy leadera by se followerům přestaly zrcadlit, čekající vstup by za DISARMED dál žil).
  Stejná podmínka platí pro ruční C7 `cancel-entry` (`follower-has-position`). Kopie, která se vyplní
  až po kontrole (P3b) nebo jejíž lifecycle zrušení selže, za DISARMED (za ARMED to dál řeší běžná
  lifecycle / divergence cesta fail-closed) = incident per záznam bez auto-close: `copy-filled` (fill
  kopie ze streamu) a `copy-cancel-failed` (`cancel-failed` lifecycle zrušení kopie) —
  `noteOwnEntryCopyAfterLeaderCancel`, jen nad POZOROVANÝM koncem vstupu leadera bez známého fillu
  (dokud vstup v cache pracuje, i s rozběhnutým zrušením, rozhoduje revize: TooLateToCancel může být
  i fill leadera, jehož event ještě nedorazil); divergence se neopravuje obchodem (INV-DIVERGENCE-01). Počítají se jen
  followeři, kterých se zrušení týká — s vazbou na vstup (`links`) nebo zapojení (`enabled !== false`,
  bez aktivního vyřazení, způsobilí; stejně jako `runnerUnmappedReplaceAccounts`, oponentura kolo 2 P3):
  vyřazený follower s vlastní pozicí (INV-PART-03) kopii nemá a zrušení leadera neblokuje. Kopie
  followerů zruší lifecycle `terminalCancel` (INV-ARM-04, i pod kill). Market se nikdy neruší. Těsně
  před `cancelOrder` (po předčtení a durable `sending` byly `await`) synchronní kontrola cache
  (`ownEntryCancelLateBlock`, oponentura kolo 1 P3, kolo 2 P1/P3): plný fill nebo konec vstupu
  doručený streamem = nic se neodešle, `cancel` se vrátí na neodeslaný a u fillu se nohy ověří čtením
  na KAŽDÉ cestě (i bez předčtení — zrušení z eventů); **dílčí fill a vstup v cache dál pracuje =
  nic se neodešle a incident `partial` „zbytek dál čeká“** (pokus se nebere jako uzavřený; nohy se
  neověřují, vstup pracuje). V režimu předčtení se tamtéž synchronně znovu vyhodnotí
  `pendingOwnEntryViolation` (sdílená `pendingOwnEntryViolationNow`): důvod pominul (např. automatické
  pokračování po výpadku kopírku mezitím zapnulo, INV-RECON-04) nebo spojení dole / běží obnova = nic
  se neodešle, `cancel` zpět neodeslaný a značka pokusu se uvolní (revize rozhodne znovu novým
  předčtením; zápis neodešel). Totéž (odklad) při nezpracovaných eventech leadera
  (`pendingTradeIngressByAccount > 0`, oponentura kolo 3 P3): fill, který už dorazil, ale čeká ve
  frontě, cache nevidí. `cancelReason` je důvod platný v okamžiku zápisu. Zrušení po ACK
  (`kopírka se vypnula během odesílání`) okno nemá: stream za během ručního vstupu stojí, takže fill
  v okně cache nevidí — zrušení odejde a výsledek rozhodne stav (`partially-filled` + ověření nohou,
  nikdy „zrušen“).
  **Rozhodnutí Filipa (5. 11. 2026), nahrazuje variantu (a) oponentury kola 4:** vlastní čekající vstup
  z flat a pozice otevřená mimo appku (stejná i opačná strana) = **za ARMED jen upozornění**. Vstup se neruší,
  žádný `failClosed` ani `lastError`, kopírka zůstane zapnutá, žádný zápis ani čtení u brokera. Podmínka
  (`services/manualPendingEntries.ts:pendingOwnEntryOutsidePosition`): známá nenulová pozice, fill vstupu 0
  a ustálení ≥ 2 s bez nezpracovaných eventů leadera. Výstup (`pendingEntryOutsidePositionNotice`): audit
  a per-záznamový `pendingIncident` druhu `outside-position`, jednou za záznam (durable
  `pendingIncidentKinds`), push přes watchdog. Pozdější skutečný incident téhož záznamu má jiný druh, text
  přepíše a vlastní `failClosed` má. Text říká, co fill udělá: stejná strana pozici zvětší, opačná ji zmenší,
  zavře nebo otočí a SL/TP vstupu můžou pracovat bez pozice jako nové vstupy. Status upozornění neposílá
  (durable `pendingIncidentNoticeOnly`), jakmile má záznam `cancel`, vstup v cache nečeká nebo kopírka není
  ARMED, aby si push neprotiřečil s výsledkem. Selhaný commit značky uvolní dedup a další revize to zkusí znovu;
  audit a push vznikají až po uložení. Všechny ostatní důvody (OFF, kill,
  day lock, konec okna, CME pauza, vypršení ARM, nezpůsobilý leader) mají přednost a vstup ruší dál, i když
  je na symbolu pozice mimo appku; platí i po DISARM: jakmile kopírka není ARMED, zruší se čekající vstup
  z důvodu vypnutí. **Vstup vyplněný proti pozici za ARMED (varianta A schválená Filipem, 5. 11. 2026):** nohy
  leadera dál pracují bez pozice, nic se u leadera neruší ani nezavírá. Ve skupině běžná ARMED cesta zruší nohy
  kopie u followera; když se pak nahá noha leadera vyplní, follower ji nemá a autoritativní kontrola velikosti to
  vyhodnotí jako divergenci (`failClosed` bez auto-close; ověřeno jen v mocku). Pro tento stav je samostatná, jde
  odebrat jedinou funkcí, `reviewFilledEntryLegsWithoutPosition`: READ-ONLY z paměti, bez REST, zápisu u brokera
  a `failClosed`. Vstup z flat bez `cancel` už nepracuje, jeho noha je otevřená, bez ingress a s klidným spojením,
  `positionOverCovered` nebo pozice na opačné straně než vstup (fill ji jen zmenšil: +2, SELL 1, net +1) trvá ≥ 5 s:
  jednou za záznam druh `outside-position-filled` (audit, push „vstup se vyplnil a jeho SL/TP pracují bez pozice /
  nechrání pozici; zruš je v Tradovate nebo dej Flatten“) a `declineTransportResume`. Po ohlášení se pokračování odmítá
  bez ustálení, dokud stav trvá, i za výpadku; odklad a ustálení platí jen pro první hlášení. Nezávisí na
  prvním upozornění, kryje i fill do 2 s. Při `scaleInOn()` se přeskočí, tam je incident `reviewScaleInCoverage`.
  **Rušení vstupu z flat proti pozici na opačné straně (kolo 4, teď jen z ostatních důvodů):** není to
  ochrana, je to vlastní OSO, jehož nohy by po vyplnění (zavření pozice) začaly pracovat jako nahé vstupy.
  Vlastnictví nedokazuje tvar (bez parentu, ne noha, strana i typ = záznam) — ten má i uživatelův ochranný
  příkaz v poškozeném záznamu (C7 „nikdy ochrana“) —, ale clOrdId z REST předčtení = `tag` záznamu
  (`pendingEntryPreReadDecision` s `kind: 'from-flat'` a `expected.tag`; **NEOVĚŘENO na brokeru**, že
  REST čtení nativního `placeOSO` parentu tag vrací — záložně `parentOrderId` nohou z kola 5, taky
  NEOVĚŘENO); tag chybí / nesedí, přikoupení
  (otočená pozice) = dál incident s vlastním textem „vstup by ji zmenšil nebo otočil“, nic se neruší.
  Ruční C7 `cancel-entry` (rozhodnutí 5. 11. 2026, vědomý klik) má stejnou podmínku (`pendingEntryOppositeState`); už vyplněný vstup proti pozici dostane text `OPPOSITE_FILL_SHAPE` dřív než odmítnutí bez tagu:
  vstup z flat s clOrdId = `tag` záznamu se zruší (průběh čtení i texty po fillu přes durable `entryOpposite`);
  neprokázané vlastnictví (bez clOrdId, cizí clOrdId, přikoupení) = `not-entry` s pravdivým textem, nic se neodešle.
  Záložní důkaz z nohou má jen automatika. Na brokeru NEOVĚŘENO, zda stream a `listOrders` u `placeOSO` tag nesou.
  Ověření po zrušení (oponentura kolo 3, P2): „ustálené“ je jen druhé čtení po ustálení (jako C7) —
  ani po selhaném nebo odmítnutém zápisu („TooLateToCancel“ = vstup se vyplnil během rušení, REST fill
  ještě nemusí ukazovat) první čtení s vstupem, který dál pracuje (i s dílčím fillem) nebo nejde
  přečíst, nic nerozhodne: žádný incident „dál čeká“ ani výsledek, rozhodne čtení po ustálení.
  Kolo 4 (P3): rozhoduje největší známý fill (REST, cache streamu, filly vstupu, Order(Filled)) — fill
  doručený streamem při REST pozadu i po ustálení = cesta fillu (nohy → `filled` / `partially-filled`),
  nikdy „dál čeká“ / „nejde ověřit“; fill doručený až po výsledku `working` / `unverified` výsledek opraví
  (`noteOwnEntryFillAfterVerifiedCancel`).
  **Kolo 5 (P2, 4. 11. 2026):** fill vstupu během rušení je „pozice chráněná SL/TP“ jen tehdy, když nohy
  kryjí fill (`legsProtectionProblem`) **a** pozice leadera fill kryje (`lib/liveCancelPending.ts:
  fillPositionProblem`: znaménko strany vstupu a |net| ≥ fill; cache streamu bez nezpracovaných eventů
  leadera, jinak nejvýš dvě po sobě jdoucí ohraničená REST čtení — `leaderFillPositionProblem`
  v `checkCancelEntryFillProtection`, platí pro VŠECHNY cesty fillu C12 i C7). Vlastní vstup z flat proti
  pozici na opačné straně, který se vyplní během rušení (TooLateToCancel), pozici zavřel / zmenšil a jeho
  nohy pracují bez pozice jako nové vstupy → incident per záznam `fill-unprotected` („vstup zavřel nebo
  zmenšil pozici mimo appku a jeho SL/TP pracují bez pozice jako nové vstupy — zruš je v Tradovate nebo
  dej Flatten“), `failClosed` bez auto-close; nohy se automaticky NERUŠÍ (INV-DIVERGENCE-01). Totéž
  u vstupu na stejné straně, jehož pozici mezitím zavřel ruční obchod. Pozici nejde ověřit = incident
  (fail-closed). Předčtení zapíše tvar durable do `cancel.opposite` (z `pendingEntryPreReadDecision`
  `{ kind: 'cancel', opposite: true }`) — texty výsledku a auditu (`cancelEntryOutcome` /
  `cancelEntryVerdict` s `opposite`, ověření po startu, pozdní fill, „stream doručil fill“) pak netvrdí
  „pozice je otevřená“ (INV-UI-03); předčtení s fillem píše neutrálně „pozici a SL/TP ověřuji čtením“.
  Po rozhodnutí Filipa z 5. 11. 2026 závod vzniká jen při rušení z ostatních důvodů (typicky DISARM), proto
  `cancel.opposite` a jeho texty zůstávají.
  **Kolo 5 (P3):** kopie vstupu u followera POZOROVANĚ skončená (`canceled` / `rejected`) s pozorovaným
  fillem 0 z tohoto vstupu pozici nemá (`followerCopyFromEntryState` → null; dřív `unreadable` →
  incident „nejde ověřit“ → DISARM uprostřed kopírovaného obchodu, sonda PB); konečný stav s fillem > 0
  (`observedOrderFilledByAccount`: max fill z order eventů, snímků, čtení a Fill eventů followera, i dílčí
  fill zrušené kopie a Fill před Order(Canceled 0)) = `filled`; bez pozorovaného stavu (restart, kopie
  mimo cache) dál `unreadable` — a ten blokuje jen při nenulové pozici followera. Pozdní Fill za
  Order(Canceled) (INV-TRAD-02) po zrušení leadera zachytí hák `noteOwnEntryCopyAfterLeaderCancel`
  (DISARMED) nebo běžná ARMED cesta. **Kolo 5 (P3):** ustálení pozice followera (`followerPositionSeen`)
  zneplatní každé NAHRAZENÍ snímku pozic účtu (`AccountPositionsCache` — `set` jiné mapy, `delete`,
  `clear`; `listPositions` je úplný snímek a vynechaný symbol = flat): záznam se změněným net (i chybějící
  symbol) se smaže hned, snímek se stejným net ustálení nepřeruší. Dřív stará ustálená pozice po snímku
  bez symbolu a nové Position kopie (před jejím Fill) se stejným net obešla odklad 2 s. Zbývá vědomě:
  změna na místě 1 → 0 → 1 streamem mezi dvěma koly revize (sloučené `setTimeout`) — revize mezi nimi
  záznam smaže, jinak zálohou lifecycle / hák. **Kolo 5 (P3, A1):** REST čtení bez clOrdId (adaptér ho
  skládá z `/command/deps`, u nativního `placeOSO` parentu NEOVĚŘENO) = záložní důkaz vlastnictví z nohou
  záznamu (id z ACK): obě ohraničeně a autoritativně přečtené s `parentOrderId` = vstup
  (`pendingEntryNeedsLegOwnershipProof` → `legsProveOwnership`; čte se jen u vstupu z flat proti pozici
  na opačné straně bez clOrdId). Tag, který nesedí, nohy nepřebijí. Na brokeru NEOVĚŘENO (tag ani
  `parentOrderId` nohou u `placeOSO` po restartu).
  **Kolo 6 (P3):** (A6) fill vstupu během rušení, jehož SL nebo TP se vyplní / zruší mezi čtením nohou
  a kontrolou pozice (obchod mezitím skončil): i ve větvi „pozice nekryje fill“ se před incidentem ověří
  `leaderVerifiedFlat` (dvě čtení net 0 a working 0 + stream) → `flat`, jen audit „pozice je už zavřená
  a nic nepracuje“ — dřív falešný `fill-unprotected` s pokynem rušit nohy, které už nepracují. Nahé nohy,
  které dál pracují (kolo 5, PC), `leaderVerifiedFlat` nepustí. (C6) „stream doručil fill“ ve
  `verifyOwnEntryCancel`: dílčí fill a vstup v cache streamu dál pracuje (REST ho nevidí skončený) =
  `working` + incident `cancel-working` „zbytek dál čeká“ (`partialEntryIncidentText`), nohy se teď
  neověřují; cesta fillu (`filled` / `partially-filled` + nohy) jen nad koncem vstupu (v cache už není,
  Order(Filled), REST ho hlásí skončený). (C7) `followerPositionOrigin` vrací `unknown` pro followera bez
  načtené cache pozic — revize (incident `follower-unknown`), ruční C7 (`follower-has-position`, nic se
  neruší; dřív `?? 0` = flat) i pozdní kontrola (odklad) mají jedinou podmínku; C7 bere stejné followery
  jako revize (`pendingEntryConcernedFollowers`: vazba na vstup nebo zapojení) — vyřazený follower bez
  vazby (kopii nemá, INV-PART-03) ruční zrušení neblokuje ani bez načtených pozic. Text `copy-filled`
  je neutrální („pozice followera se změnila a leader ne“ — kopie mohla pozici followera i zavřít).
  Vlastnictví z tagu (clOrdId z REST čtení nativního `placeOSO` parentu) ani záložně z `parentOrderId` nohou
  **není na brokeru ověřené** (NEOVĚŘENO; mock dodává obojí) — když neplatí ani jedno, vstup se při rušení
  z ostatních důvodů nezruší a je `not-entry` incident (`failClosed`). Sama pozice mimo appku za ARMED na
  tomto ověření nestojí, nic se tam nečte ani neruší.
  Hlídá test: `tests/manualPendingEntryReplay.test.ts`, `tests/manualPendingEntryReview.test.ts`,
  `tests/manualScaleInReplay.test.ts` (C12: výpadek, změna celé pozice), `tests/liveCancelPending.test.ts`
  (kolo 5: `fillPositionProblem`, texty `opposite`).

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
  Třetí výjimka (3. 11. 2026 přikoupení, 4. 11. 2026 C12 rozšířeno na každý vlastní
  čekající vstup z appky — z flat i přikoupení): cílené zrušení VLASTNÍHO čekajícího
  vstupu (`reviewPendingOwnEntries` → `cancelOwnManualEntry`, raw broker mimo
  `dispatchBroker`) běží i pod kill a za DISARMED — jen zrušení, jeden pokus s durable
  `cancel: sending`, výsledek ověřený stavem, nikdy zápis, který by expozici vytvořil.
  Pod kill (oponentura C12 kolo 2, testy): kopie followera zruší lifecycle `terminalCancel`
  (`cancelLifecycleHaltReason`) a po selhaném automatickém zrušení se vstup v „Zrušit čekající“
  nabídne a ruční `cancel-entry` odejde právě jednou (`tests/manualPendingEntryReplay.test.ts`, kolo 2).
  Ruční `manage-leader-order` `cancel-entry` (fáze 2a, výslovně zapsáno 3. 11. 2026
  s C7 „Zrušit čekající“): zrušení VLASTNÍHO přijatého ručního vstupu / přikoupení
  s nulovým fillem z čerstvého REST čtení, raw broker mimo `dispatchBroker`, jeden
  pokus — kill, DISARM ani brzda po zadání (agent, relay supersede) ho nezastaví.
  C7 nepřidává novou výjimku: posílá N× tutéž akci. Ochrannou nohu otevřené pozice
  ani cizí příkaz žádná z výjimek nikdy neruší (INV-MANUAL-01, C7).
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

- Ruční vstup z grafu (29. 10. 2026): vzdálená brzda čeká v sériové lince
  relaye za právě vykonávaným vstupem nejvýš ~7 s (start ve frontě ≤ 2 s +
  POST ≤ 5 s); lokální brzdy v controlleru blokování neovlivní.
- Vzdálená cesta (1. 11. 2026): `claim_tradovate_copier_command_v2` vydá
  čekající brzdu (disarm, kill-switch, lock-until-session-end) před staršími
  NErisk-redukčními příkazy zařízení; risk-redukční Flatten (account, group,
  follower-trade) je ve stejné prioritní třídě a uvnitř ní platí FIFO, takže ho
  novější brzda nepředběhne. Právě vykonávaný příkaz se nepřeruší. Detail
  a souběh s ručním vstupem v INV-RELAY-03.

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

- C12 (4. 11. 2026): automatické zrušení vlastního čekajícího vstupu ukončí epizodu automatického
  pokračování (`declineTransportResume('čekající vstup zrušen: …')`) — vstup, který uživatel zadal
  před výpadkem, po obnově nezmizí potichu pod znovu zapnutou kopírkou. Za výpadku se nic nezkouší
  (odklad do obnovy spojení). Test: `tests/manualScaleInReplay.test.ts` (C12: výpadek spojení).
  Oponentura kolo 2 (P3): epizoda se ukončí až když zápis opravdu odchází (po pozdní kontrole cache
  a přehodnocení důvodu) — pokus, který nic neodeslal (fill během durable `sending`, důvod pominul),
  pokračování nezamítne; automatické pokračování, které kopírku zapne během předčtení, zrušení zastaví
  (přehodnocení důvodu, INV-BRAKE-01). Test: `tests/manualScaleInReplay.test.ts` (C12 kolo 2),
  `tests/manualPendingEntryReplay.test.ts` (ARM během zdrženého předčtení).

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
  `tests/copierRouteGapV6.test.ts`, `tests/copierStaleStandaloneStopSweep.test.ts`.
- Nikdy: Necommitovat pomalý snapshot po mezilehlém fillu, reconnectu,
  config změně nebo DISARMu.
- Důkaz ukončených ochranných nohou (29. 10. 2026): terminální stav přítomný
  v čerstvém snapshotu platí vždy. Nepřítomnost v `/order/list` uzavře
  samostatný SL jen tehdy, když byl kandidát zachycen před čtením a jeho ACK
  padl aspoň 5 min před začátek aktuální Tradovate session (seznam vrací jen
  aktuální session). Chybějící noha z aktuální session zůstává fail-closed.
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
- Ruční vstup (1. 11. 2026): pojistka rozestupu 3 s se vyhodnotí PŘED durable
  `sending` (`executeManualEntry`) — odmítnutí nic nezapíše ani neodešle
  (detail v INV-MANUAL-01).
- C12 (4. 11. 2026): automatické zrušení vlastního čekajícího vstupu = durable `cancel: sending`
  před zápisem, jeden pokus, nikdy opakování. Nejistý výsledek (timeout, odmítnutí, „úspěch“
  adaptéru, který čeká i na `filled`) se dořeší jen ČTENÍM (`findOrderById` hned a po ustálení);
  čtení se smí opakovat, zápis nikdy. Strop čtení (oponentura kolo 1, P3 — sdílený rate-limit
  rozpočet): nečitelné předčtení = další čtení s exponenciálním odstupem 5 s → 10 s → … → strop
  5 min (`pendingEntryReadBackoffMs`, ≤ ~12 čtení/h na záznam), incident po 3. nečitelném; po
  výsledku `ended` / `filled` / `partial` / `not-entry` se v tomto běhu už nečte (značka zůstává);
  potvrzovací čtení incidentu z cache nejvýš jednou za (záznam, druh); ověření po zrušení ≤ 2 čtení.
  Restart / zastavení mezi předčtením a durable `sending` = nic neodejde, nový běh udělá vlastní
  jediný pokus (nic durable o pokusu neexistuje); po durable `sending` zápis doběhne (záznam už pokus
  tvrdí a nový běh ho neopakuje). Hlídá test: `tests/manualPendingEntryReplay.test.ts` (čtení za
  5 min, `ended` se už nečte, restart mezi předčtením a `sending`, fill streamem během `sending`).
  Oponentura kolo 2 (P3): odklad v pozdní kontrole (spojení dole, běží obnova, důvod pominul) vrátí
  `cancel` na neodeslaný a uvolní značku — zápis neodešel, další pokus = nové předčtení a jediný zápis.
  Výsledek zrušení z předchozího běhu bez `verified` se po startu jen PŘEČTE (jednou,
  `verifyRestartedOwnEntryCancels`), nikdy znovu nezapíše. Test: `tests/manualPendingEntryReplay.test.ts`
  (spojení spadne během durable `sending`, restart bez ověřeného výsledku).
  Oponentura kolo 3: odklad v pozdní kontrole i při nezpracovaných eventech leadera (ingress > 0 —
  fill ve frontě, P3); po nejistém zápisu (selhání / odmítnutí) rozhodne o výsledku až čtení po
  ustálení (P2), nikdy druhý zápis. Fill bez značky „nohy ověřeny“ se po startu jen ČTE (nohy), nic
  se neposílá. Test: `tests/manualPendingEntryReplay.test.ts` (kolo 3: ingress během `sending`,
  TooLateToCancel).

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
- C12 kolo 4 (4. 11. 2026, P2): kopie vlastního čekajícího vstupu, která se u followera vyplní po
  zrušení / konci vstupu leadera s fillem 0 (P3b), nebo jejíž lifecycle zrušení selže, je za DISARMED
  incident per záznam (`copy-filled` / `copy-cancel-failed`) bez auto-close a bez dorovnání — dřív tichá
  divergence (sonda B3). Za ARMED beze změny (lifecycle / divergence fail-closed). Revize ani C7
  nezruší vstup leadera nad neustáleným stavem followera (INV-BRAKE-01). Kolo 5: test hlídá, že hák za
  ARMED mlčí (žádné vlastní `failClosed({ autoClose: false })` před běžnou cestou, mutace X2). Kolo 5
  (P2): fill vlastního vstupu během rušení, jehož nohy pozici nekryjí (vstup proti pozici na opačné
  straně), = incident bez auto-close a bez zrušení nohou — ne dorovnání. Kolo 6 (P3, oprava dřívější
  věty „během ~4 s nevyvolala divergence fail-closed“): za ARMED kopii zrušenou lifecyclem s dílčím
  fillem (1/2) při vstupu leadera zrušeném s fillem 0 zachytí autoritativní kontrola velikosti followera
  (`follower … má autoritativně pozici 3 …, očekáváno 2 podle leadera 1 × 2` → `failClosed` bez
  auto-close, ARM dolů, bez per-záznamového incidentu) — test X2 to drží až do `armed === false`;
  ověřeno jen v mocku (simulovaný čas, ne na brokeru).
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
- Výslovná výjimka (jako C7 `cancel-entry` a dřívější zrušení přikoupení): cílené zrušení VLASTNÍHO
  čekajícího vstupu leadera (C12, `cancelOwnManualEntry`) jde raw mimo `dispatchBroker` bez fence,
  protože riziko snižuje a brzda ho zastavit nesmí. Místo fence: čerstvé REST předčtení vstupu
  těsně před zápisem a ověření výsledku stavem po něm (INV-BRAKE-01).
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
- F1b′ (2. 11. 2026): server váže příkaz k `relayIdle` jen při `last_seen_at` ≤ 4 s.
  Uspaný Mac (heartbeat čerstvý, proces stojí) nechá řádek `claimed` do probuzení;
  pak ho TTL/`created < startedAt` neprovede — bezpečné, UI jen ukazuje „čeká“.
  Restart workeru do 4 s po posledním heartbeatu: server může navázat k `relayIdle`
  staré instance (řádek v DB nese starou instanci celý, shoda `startedAt` to neodhalí);
  nová instance ho vezme větví „session se změnila“ = neprovede, UI „výsledek neznámý“.
  Okno zkracuje status s `relayIdle: null` hned při startu relaye. Po ACK nese status
  z `complete-v2` `relayIdle` bez hodnoty → push až po dalším heartbeatu (≤ ~250 ms);
  po kompaktním `complete-hot-v3` zůstane do heartbeatu stará hodnota a chrání kontrola
  `occupied` v admission.

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
- Recyklovaný klíč s jiným `command_type` (1. 11. 2026, review): dohledání
  existujícího řádku po konfliktu upsertu čte i `command_type` a při neshodě
  vrací `copier-relay-idempotency-conflict` (409, všechny typy příkazů) —
  nikdy nevrátí starší řádek jiného typu jako úspěch aktuálního příkazu.
  U brzdy totéž hlídá RPC (`copier-brake-idempotency-conflict`, propaguje se,
  viz INV-RELAY-03 bod 2).
- Bezpečné změny vs. nebezpečné: Bezpečné je při transportním retry zachovat
  původní klíč a dohledat původní command. Nebezpečné je po nejisté odpovědi
  automaticky znovu enqueueovat mutaci s novým UUID.
- Rychlost admission (30. 10. 2026, `docs/LIVE_HOT_PATH_PLAN.md` §9): u ručního
  vstupu a správy z grafu běží čtení existující operace a busy/strop souběžně
  s výběrem zařízení; vyhodnocují se ve stejném místě a pořadí (výběr zařízení →
  existující operace → busy → strop), výsledek i chyby jsou stejné. Okno mezi
  čtením a insertem je o desítky ms delší; busy, rozestup a strop atomické nikdy
  nebyly (jedinečnost operationId drží unikátní index per uživatel + zařízení,
  dvě živá zařízení = otevřená N6). Test: `tests/tradovateCopierCommandRelay.test.ts`
  („souběžná čtení admission“). Long-poll výsledku: prvních 1,5 s krok 25 ms, pak 100 ms.
  **Nahrazeno 1. 11. 2026:** viz atomická admission níže.
- **Atomická admission ručního vstupu a správy (1. 11. 2026):** `place-leader-entry`
  a `manage-leader-order` po výběru zařízení volají jediné RPC
  `public.admit_tradovate_copier_manual_command` (migrace
  `20261101090849_copier_manual_admission.sql`; SECURITY INVOKER, `search_path ''`,
  `lock_timeout 2s`, jen service_role). Jedna transakce pod jediným
  `pg_advisory_xact_lock` na uživatele (žádné pořadí více zámků): existující
  operationId per uživatel → brzda → busy/rozestup → strop → insert. Dvě různé
  operace téhož uživatele (PC + telefon, dvě záložky, dvě zařízení) se tím
  serializují: projde jedna, druhá `copier-relay-entry-busy`. `p_now` = hodiny
  Node (jako `created_at` ostatních řádků), rozdíl proti DB ≥ 2 s = RAISE.
  Cíl musí tvořit sourodou trojici: připojení patří uživateli, zařízení
  patří témuž uživateli, není odvolané a má `connection_id = p_connection_id`
  (stejně jako výběr cíle v relayi); jinak RAISE. Chyby, u kterých se
  prokazatelně nic nevložilo (RAISE `copier-admission-*`, `55P03` lock timeout,
  `57014` statement timeout, `PGRST202` chybějící funkce), vrací
  `copier-relay-entry-not-admitted: …` (409, UI „Neodesláno: tento pokus server
  nepřijal“ — platí pro tento pokus; dřívější pokus se stejným operationId mohl
  projít, proto UI neslibuje „nic se neodeslalo“). Jiná chyba RPC
  (síť, odpověď po commitu) = `copier-relay-enqueue-failed` → 502 „výsledek
  neznámý“. **Žádný fallback** na nezamčené čtení + upsert; `p_now` se bere
  těsně před RPC. Kick míří na `device_id` vráceného řádku.
  Vědomě nepokryto: zapisovatel mimo RPC (starý relay během rolloutu) zámek
  nebere — na něj zbývá unikátní index (user, device, key) a workerová pojistka
  rozestupu (INV-OUTBOX-01). Test: `tests/sql/copierManualAdmission.pg.mjs`
  (skutečný Postgres, dvě spojení, lock_timeout, force_generic_plan),
  `tests/tradovateCopierCommandRelay.test.ts` (mapování kódů, 5xx bez upsertu).

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
  restartu stejnou roli hraje `created < startedAt`. F1b′ (2. 11. 2026): nečinná
  `polling` delivery se po prázdném pollu nemaže (server k ní smí navázat), pokud patří
  této session; checkpoint předchozí session se po prázdném pollu vymění, vázaný
  řádek k němu jde konzervativní větví „session se změnila“ (neprovede se). Po ACK se
  hned uloží nová nečinná delivery; `relayIdle` se hlásí jen po potvrzeném zápisu.
  Vědomě nepokryto: ACK
  trvale 409, když DB zná novější `startedAt` (INV-WORKER-02/03). Test:
  `tests/recoverableCopierDeliveryOrphan.test.ts`.
- Kompaktní ACK horkých ručních příkazů (4. 11. 2026): pouze
  `place-leader-entry` a `manage-leader-order` po lokálně durable výsledku smí
  použít `complete-hot-v3`. RPC dál zamyká přesný command + delivery, přijímá
  jen `claimed`, kontroluje přesnou shodu `startedAt` aktuálního runtime a
  idempotentně přijme jen totožné opakování výsledku. Plný status se neposílá
  v ACK; worker jej hned publikuje existujícím fenced heartbeatem a budíček LIVE
  pošle až po jeho potvrzení. `last_seen_at` se ACKem neposouvá, čerstvost se tedy
  falešně neprodlužuje. Selhání v3 linku s brzdami trvale neblokuje (INV-BRAKE-03):
  v3 má rozpočet 3 s (SQL `lock_timeout` 2 s) a v téže delivery následuje už jen
  `complete-v2` (rozpočet 20 s jako dřív), který po zapsaném v3 vrátí jen shodu.
  `lock_timeout` platí na každý zámek zvlášť, takže v3 může commitnout až po přechodu
  na v2; oba směry končí shodou bez druhého zápisu.
  Brzda za příkazem tak v nejhorším čeká o 3 s déle než s v2. Když server v3 neumí
  (starý web 400, chybějící funkce 503 `copier-relay-hot-ack-unavailable`), worker
  ho 5 min nezkouší; přechodné chyby a 409 pauzu nezapnou.
  Brzdy, ARM, konfigurace a ostatní příkazy vždy zůstávají na atomickém
  `complete-v2` se statusem. Kompaktní ACK nikdy neopakuje execution ani
  neautorizuje další příkaz. Mezi terminálním commandem a heartbeatem může runtime
  krátce nést starou `relayIdle` delivery; admission to řeší kontrolou `occupied`,
  příkaz jde jen bez zkratky pushem. Testy:
  `tests/recoverableCopierDelivery.test.ts`,
  `tests/macCopierCommandRelay.test.ts`,
  `tests/sql/copierHotCommandCompactAck.pg.mjs`.

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
- Ruční vstup a správa při admission (1. 11. 2026): supersede update brzdy
  nemusí vidět řádek vložený souběžně s ním, proto atomická admission odmítne
  vstup/správu, je-li u uživatele (libovolné zařízení, libovolný stav) brzda
  s `created_at ≥ p_now − 500 ms` → `superseded-by-brake` →
  `copier-relay-entry-superseded` (409, nic se nevloží, UI „Neodesláno“, žádné
  automatické opakování). Výjimka: `cancel-entry` (snižuje riziko). Worker
  vstup dál odmítne podle `lastBrakeCreatedAt`/ARM brány.
- **Brzda × ruční příkaz — garantovaný výsledek (1. 11. 2026):**
  1. Relay: brzda jde jedním RPC `enqueue_tradovate_copier_brake` — insert
     (nebo idempotentní dohledání podle user + device + key) a supersede
     čekajících ARM/SHADOW téhož zařízení a ručních vstupů/posunů/zavření
     celého uživatele s `created_at ≤` brzda v TÉŽE transakci pod zámkem
     admission. Brzda proto nikdy není v DB viditelná bez svého supersede:
     claim_v2 souběžně vidí buď stav před brzdou (pak může vyzvednout starší
     vstup, který ještě nikdo nezamkl — bod 5), nebo řádek vstupu už zamčený
     supersedem (SKIP LOCKED) a brzdu neviditelnou, nebo obojí hotové. Admission, která zámek držela,
     commitne dřív a její řádek se zneplatní; pozdější admission brzdu vidí
     (`superseded-by-brake` do 500 ms) nebo vloží řádek novější než brzda.
     `cancel-entry` zůstává. Zneplatňuje se celý uživatel, i příkaz pro jiné
     zařízení/připojení (opatrné; v ms okně může propadnout i zavření obchodu
     jinde — klik znovu).
  2. Brzda nesmí selhat: RPC čeká na zámek nejvýš 500 ms; chyba RPC
     (timeout, chybí migrace, síť, divná odpověď) → dřívější cesta se STEJNÝM
     idempotency key (upsert + nezamčený supersede per zařízení). Tam okno
     mezi commitem brzdy a supersede zůstává — kryje ho bod 3.
     Jediná výjimka (1. 11. 2026, review): `copier-brake-idempotency-conflict`
     (tentýž klíč, jiný typ příkazu) se propaguje jako 409 — fallback by starší
     řádek jiného typu (klidně `arm-live`) vrátil jako úspěšnou brzdu, která
     nevznikla a nic nesupersedla. Nový klik = nový klíč = brzda projde.
     Naproti tomu `copier-brake-connection-invalid` (RPC ověřuje vlastnictví
     `tradovate_oauth_connections` jako admission; kontrola přes `devices`
     nestačí — `connection_id` je od 20261004120000 nullable, ON DELETE SET
     NULL) se NEpropaguje a padá do záložní cesty: záloha ownership check
     vědomě obchází a brzdu zařadí. Bezpečné proto, že zařízení patří
     uživateli (jinak selže výběr cíle v relayi i `copier-brake-device-invalid`)
     a brzda jen snižuje riziko; SQL check je tedy pro brzdy advisory vrstva,
     vynucená jen na RPC cestě.
  3. Claim (defense-in-depth, INV-BRAKE-03): `claim_tradovate_copier_command_v2`
     vydá přednostně třídu „brzdy + risk-redukční Flatten“ (flatten-account,
     flatten-group, flatten-follower-trade), uvnitř ní FIFO; ostatní dál FIFO.
     Durable brzda tak předběhne i starší čekající vstup, který supersede minul,
     ale nikdy starší Flatten (follower do konce obchodu za DISARMED selže).
  4. Worker: ruční vstup a posun/zavření s `createdAt ≤ lastBrakeCreatedAt`
     (+ rezerva na hodiny) vrátí `brake-after-request` a controller se vůbec
     nezavolá; novější příkaz controller za DISARMED odmítne `not-armed`.
     `lastBrakeCreatedAt` je jen v paměti procesu: po restartu chrání DISARMED
     default a brána ARM.
  5. Nepokryto: příkaz, který worker vyzvedl (claimed) dřív, než brzda
     commitla, se provede. **F1b′ (2. 11. 2026) toto okno vědomě zkracuje:** server
     váže příkaz k nečinné delivery hned po admission (stejná `claim_v2`, přednost
     brzd), takže brzda zadaná ~100 ms po vstupu/ARM ho už nezneplatní (dřív 0–750 ms
     podle pollu) — provede se až po něm. Pojistky workeru (`brake-after-request`,
     ARM brána) beze změny (supersede na jeho řádek počká a `claimed` nemění) —
     pak platí běžná pravidla brzdy (DISARM pozice nezavírá; ACK za DISARMED →
     vlastní vstup se zruší). Kdy worker brzdu převezme, závisí na sériové
     smyčce: poll ~750 ms platí jen pro nečinný zdravý worker, jinak brzda
     čeká, až doběhne právě vykonávaný příkaz a jeho ACK (u ručního vstupu
     ~7 s, viz INV-BRAKE-03), a kick zdržený pomalým RPC to neurychlí.
  Testy: `tests/sql/copierManualAdmission.pg.mjs` (držené transakce: brzda
  během admission; claim_v2 během necommitnuté brzdy = nic, po commitu brzda
  a vstup pryč; claim_v2 držící starší vstup; priorita brzdy před starším
  vstupem i ARMem; supersede ARM/SHADOW a ručních příkazů; idempotence; lock
  timeout), `tests/localCopierExecutionAgent.test.ts` („garantovaný výsledek“),
  `tests/tradovateCopierCommandRelay.test.ts` (brzdové RPC, záloha se stejným klíčem).
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
  Kanál ceny nese od 6. 11. 2026 i událost `wake` klient → worker: není to příkaz, nic neautorizuje
  a účinek má jen ve vlákně ceny, stejný jako presence (INV-WORKER-04).
- Hlídá test: `tests/copierRelayPriceChannel.test.ts`,
  `tests/tvPriceStreamWiring.test.ts`, `tests/tvPriceChannelClient.test.ts`.
- Budíček statusu (30. 10. 2026, `docs/LIVE_HOT_PATH_PLAN.md` §5): téma
  `copier-nudge-…` odvozené ze zařízení (`copierStatusNudgeTopic`). Worker po
  potvrzeném heartbeatu vyvolaném změnou u brokera a po přijatém ACK příkazu
  (po kompaktním ACK až po potvrzeném heartbeatu, který status dorovná)
  pošle prázdnou zprávu (fire-and-forget, ≥ 250 ms od sebe); LIVE jen kickne
  běžný poll statusu (`hooks/useCopierStatusNudge.ts`: jen s otevřeným LIVE
  grafem, ≥ 250 ms, nejvýš 60 za minutu). Zpráva nenese
  data, neposouvá čerstvost ani nic neautorizuje; podvržená umí jen vyvolat
  čtení navíc. Test: `tests/macCopierCommandRelay.test.ts` (budíček),
  `tests/copierStatusNudgeTopic.test.ts`.
- Expozice přímo do grafu (F2a, 30. 10. 2026, §10 plánu): na tématu budíčku
  událost `exposure` = AES-256-GCM (klíč `copierStatusNudgeKey` ze zařízení,
  AAD = téma) výřezu statusu: `controller.exposure` (smí být `null`), ≤ 10
  událostí, `startedAt`, `displaySeq`, `displayBuiltAt`; od 4. 11. navíc ≤ 10
  `manualEntries` a `manualOrderActions` jen pro korelaci `operationId` a
  měření potvrzovací klik → worker/broker → první paint. Diagnostická pole se
  do sloučeného controlleru vůbec nekopírují a nikdy neautorizují příkaz. Worker ji jen
  naplánuje z posluchače změny (mimo eventTail), nejvýš 1 požadavek najednou,
  rozestup ≥ 16 ms (jeden obrazový snímek), fire-and-forget; klíč nedostanou zobrazovací doplňky
  (`onRealtimeConfig`) ani log. Prohlížeč: jen při otevřeném grafu, jen
  nejnovější čekající zpráva, sloučí se (`mergeCopierLiveExposure`) jen nad
  čerstvým pollem téže instance: stejný `startedAt`, vyšší `displaySeq` (novější
  poll vyhrává i s `null`), stáří od kotvy pollu, „budoucí“ zpráva zahozena.
  Výsledek jen pro graf a karty obchodů — nikdy do `acceptAgentStatus`,
  uloženého stavu, čerstvosti (`workerFresh` dál z pollu), ARM ani příkazů;
  `expect` u správy z grafu je „co uživatel viděl“ a worker ho ověří u brokera.
  Deterministický klíč: kdo ho jednou dostal (jen přihlášený uživatel s živým
  workerem), umí zobrazení číst i podvrhnout do rotace tajemství. Testy:
  `tests/copierLiveExposure.test.ts`, `tests/macCopierCommandRelay.test.ts`,
  `tests/copierRelayPriceChannel.test.ts`, `tests/copierStatusNudgeTopic.test.ts`.
- Nikdy: Poslat přes Realtime příkaz, ARM/DISARM, risk ani stav, podle
  kterého se rozhoduje — s jedinou výjimkou F1b′ níže; logovat téma nebo klíč;
  čekat v poll smyčce na přihlášení ke kanálu.
- **Výjimka F1b′ (2. 11. 2026, `docs/reviews/hot-path-f1b2-fees-close-20261102.md`):**
  transport řádku, který `claim_tradovate_copier_command_v2` už navázal k nečinné
  delivery workeru (`status.relayIdle`, runtime ≤ 4 s). Server (`server/copierCommandPushRelay.ts`)
  ho po enqueue pošle na téma `copier-push-…` (HMAC zařízení) podepsaný **Ed25519**;
  soukromý klíč existuje jen na serveru (odvozený z `TV_PRICE_CHANNEL_SECRET`), worker
  dostane jen veřejný klíč přes autentizovaný `poll-v2`. Push nic nevytváří ani
  neprodlužuje; každý krok ≤ 1 s, chyba = žádný push (kick a poll jako dřív), 202 ani
  brzdu nezdrží. Worker ověřuje jen nejnovější zprávu ve smyčce, použije ji jen pro
  aktuální nečinnou delivery této session a s offsetem hodin z pollu ≤ 60 s; jinak
  poll (vrátí tentýž řádek). Dál jde stejným automatem (INV-RELAY-02). Prohlížeč
  `relayIdle` nedostane. Tajemství: `COPIER_PUSH_SIGNING_SECRET` (≥ 32 znaků), když je
  nastavené, jinak společné `TV_PRICE_CHANNEL_SECRET` (nastaveno v Production 2. 11. 2026 10:38
  se souhlasem Filipa; ověřeno na DEMO: vstup i zavření `via=push`). Výměnu worker převezme z pollu sám. Ověřený push pro aktuální
  nečinnou delivery smí přerušit právě běžící poll (nejvýš jedno ověření za poll; podvrh ani
  starý push nikdy) — přerušení není selhání a poll se stejným id vrátí tentýž řádek. Server
  čte `relayIdle` souběžně s admission (použije jen při shodě zařízení). Testy:
  `tests/copierCommandPushDelivery.test.ts`, `tests/copierCommandPushRelay.test.ts`,
  `tests/copierRelayPriceChannel.test.ts`.
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
- C12 (oponentura kolo 2, P3, 4. 11. 2026): automatické zrušení vlastního čekajícího vstupu leadera
  bere vyřazeného followera (`enabled:false`, bez vazby na vstup) jako neparticipanta — jeho vlastní
  pozice ani chybějící cache pozic zrušení leadera neblokují (INV-BRAKE-01). Ověřeno: vyřazení drží
  followera v `group.followers` s `enabled:false`. Test: `tests/manualPendingEntryReplay.test.ts`
  (vyřazený follower s vlastní pozicí). Kolo 3 (P2): ani zapojený follower s pozicí odjinud
  (kopie vstupu má fill 0) zrušení neblokuje — blokuje jen pozice, která může pocházet z kopie tohoto
  vstupu (INV-BRAKE-01); vyřazený follower s vazbou a vyplněnou kopií blokuje dál. Kolo 4 (P3): ani
  vyřazený follower bez načtených pozic (`follower-unknown`) zrušení neblokuje — test v
  `tests/manualPendingEntryReplay.test.ts` (mutace R13 teď zabitá).
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

- Výjimka (7. 11. 2026): Market, Limit a Stop bez SL/TP nemají spočítaný strop ztráty pro DLL/MLL. Platí jen v sólo DEMO skupině, do stropu skupiny (INV-MANUAL-01).
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
- Poplatky (2. 11. 2026, `docs/reviews/hot-path-f1b2-fees-close-20261102.md` §3):
  ztráta pro `daily-loss` (zámek/pauza/80 %), blokátor náhledu `daily-loss-limit`
  a poznámku `group-daily-loss` = **min(hrubý ledger leadera, čisté realized P&L
  leadera od brokera)** (`dailyLossPnl`). Broker hodnota jen ze snímku bez chyby,
  ≤ 90 s, téže session a s `cashBalance.tradeDate` = obchodní den session
  (`realizedTradeDate`; po 17:00 CT nevynulovaná včerejší ztráta nesmí zamknout nový
  den). Jinak ledger jako dřív — nikdy volnější. Počet ztrátových obchodů zůstává
  z ledgeru (hrubý). Broker realized je celoúčtový (i obchody mimo appku) → jen
  přísnější; status ukazuje `dailyStats.lossPnlUsd` a `lossPnlSource`. Test:
  `tests/copierDailyLossFees.test.ts`. Lucid: připojení leadera běží ve stejném Tradovate
  prostředí `demo` (stejné API a entita `cashBalance`) jako DEMO8661118, kde je `tradeDate`
  i čisté P&L ověřené naostro (2. 11.); formální potvrzení až v den s leaderem — bez
  `tradeDate` platí ledger (nikdy volnější).
- Bezpečné změny vs. nebezpečné: Bezpečné je varovat/pauznout a po flat
  durable locknout. Nebezpečné je ukončit správu protective orders jen proto,
  že právě skončilo okno.
- C12 (4. 11. 2026): konec obchodního okna (i 5 min před), denní pauza CME a konec session blokují
  nový ruční vstup v náhledu (`cme-halt`, `window-ending`, `session-ending`) a ruší vlastní čekající
  vstupy (INV-BRAKE-01); ochranné nohy otevřené pozice se nikdy neruší.

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
- Denní pauza CME (C12, 4. 11. 2026, oponentura P2): `services/copierArmSession.ts:cmeDailyHaltWindow`
  = okno `[16:00 − rezerva, 17:00)` CT TÉHOŽ obchodního dne; konec = nejbližší 17:00 CT, začátek =
  16:00 téhož kalendářního dne zóny (dvouprůchodová DST konverze). `msUntilTradovateSessionEnd(now, tz, 16)`
  samo nestačí — po 16:00 ukazuje na zítřek a díra 16:00–16:55 by zůstala. Používá ho náhled vstupu
  (`cme-halt`) i revize čekajících vstupů. Svátky a zkrácené obchodní dny CME helper NEZNÁ (NEOVĚŘENO).
  Hlídá test: `tests/manualPendingEntryReview.test.ts` (16:10 CT v den přechodu času v březnu
  i v listopadu), `tests/manualEntryPreview.test.ts`.

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
- C12 (4. 11. 2026): management-only nesmí držet vlastní čekající vstup z appky — revize ho zruší
  (důvod „kopírka jen spravuje“, INV-BRAKE-01); ochranné nohy nikdy.

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
- Zavření z grafu (fáze 2d) i × holé pozice bez SL/TP (C8, 3. 11. 2026,
  `services/copierRuntimeController.ts:executeClose` s `managed: null`) se
  potvrzují stejně: flat ∧ nic nepracuje z REST čtení, pozice trvá = incident bez
  auto-close, nikdy opakování (detail v INV-MANUAL-01;
  `tests/manualEntryBareClose.test.ts`).

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
  Float64Array předaný bez kopírování, max 1 700 × 6, max 1×/3 s); hlídač
  ověří typ a délku v O(1), pak `sanitizeTvBars`, a drží je jen v paměti pro
  `latestBars` (≤ 90 s, jen živé vlákno a zapnutý kanál). Čte je jen
  `pilot.ts` pro graf dne a hodnocení (hlídá `tests/tvPriceStreamWiring.test.ts`);
  podle nich se nic nespouští. Dřívější soubor (6. 11. 2026): vlákno posílá
  svíčky i ve 2. s minuty s dokončenou minutou z obchodů a pilot je podle hodin
  nahraje ve 3. s (`earlyRead` jen IBKR, nikdy graf TV); podle zprávy vlákna se
  nic nespouští, zápisy jsou pevně 2/min a v 7. s je přepíše běžné čtení, po něm
  korekce v 10. s. Do 5 s může toto čtení vzít i `tv-bars`, opraví ho pozdější. Po výpadku
  IBKR nahraje totéž ještě běh ve 40. s, jen s posledním uploadem starším než 45 s
  (nejvýš 3 zápisy/min na kořen, běžně 2). Začátek poslechu (presence) vlákno probudí `wake()`,
  a klient hned po připojení pošle událost `wake` bez obsahu, protože presence dorazí se
  zpožděním (hypotéza z 6. 11.): stream pak nejvýš 5 s posílá i bez presence. Má stejné účinky
  jako presence (čtení zdroje včetně přepnutí zdroje, tedy i dostupnost kotace pro Market přes
  výběr zdroje), žádnou novou schopnost nepřidává, payload se nečte a obsah kotace je dál jen z IBKR. Okamžité posílání (28. 10. 2026): obchod
  z IBKR (`onTrade`) jen naplánuje čtení (`stream.nudge()`, 25 ms spojení
  dávky, rozestup 200 ms, po chybě prodleva 1 s); cesta ceny pro přehrání
  v grafu (`takeTrail`, strop 256 ve zdroji, 64 ve streamu, maže se při
  změně minuty, po odeslání a po nečinnosti) je jen v paměti vlákna.
  Rychlá cena (5. 11. 2026): i vzorek posledního obchodu z `reqMktData`
  (tick type 4, ~130 ms, odběr běžel už kvůli bid/ask) volá `onTrade`. Platí jen
  po prvním obchodu z tick-by-tick odběru od odběru nebo výpadku (vzorek nemá čas
  burzy, starou hodnotu by nešlo poznat) a jen do 1 s stáří; vzorky bez obchodu
  déle než 3 s = žádné čtení (mrtvý odběr obchodů, záloha TV). Zůstává jen v paměti
  vlákna, do `history` ani `minuteBars` nejde. Odběr je `Last`, ne `AllLast`: AllLast
  na MNQZ6 chodí o přesně 1,25 níž než svíčky IBKR a TradingView, `Last` s nimi sedí.
  Přelom minuty (6. 11. 2026): vzorek v prvních 500 ms minuty do její svíčky nejde
  (může být ještě z minulé) a vlákno první zprávou po přelomu pošle dokončenou minutu
  jen z obchodů (`pendingClosedBar`, drží se do potvrzení odeslání, nejvýš 5 s po
  přelomu, minuta s výpadkem dat ne), aby svíčka v grafu po příchodu hotových svíček
  neposkočila. Taková zpráva má `bar` minulé minuty a `last` už nové. Je to best
  effort: dvě zprávy v jednom snímku grafu ji přeskočí a opraví ji až obnova dat.
  Provoz bez TradingView (`--tv off`, `ALPHATRADE_TV=off`, 6. 11. 2026; instalátor ho
  dovolí jen s `--tv-stream on --price-source ibkr`): nic TV nespouští ani nečte, kamera a
  snímky jsou vypnuté, po pádu vlákna se dál zkouší IBKR a jistič se po 30 min znovu zapne
  (liveness tick, nikdy restart procesu). `active: 'tv'` pak znamená „žádný zdroj“: hystereze
  a nový `runId` po výpadku platí dál, kotace nejde a Market zůstává blokovaný. Tichý výpadek
  se pozná z 120 s ticha v otevřené CME seanci (`lib/cmeSession.ts`, jen zobrazení; svátky
  mohou dát falešné oznámení). `ALPHATRADE_SNAPSHOTS=off` už cenu, upozornění ani svíčky nevypíná.
  Hlídač upozornění na cenu (2. 11. 2026): druhé vlákno `price-alert-watch.mjs`
  (`scripts/copier/priceAlertWatchThread.ts`, `env: {}`, 48 MB), jen se zdrojem
  IBKR a `ALPHATRADE_PRICE_ALERTS=on` (`--price-alerts on`, přežije reinstall).
  Dostane jen klíč upozornění z poll-v2 (`realtime.priceAlert`, relay ho do
  `onRealtimeConfig` nepředá) a dávky obchodů IBKR (`takeAlertBatch` podle platnosti
  čtení IBKR, ne podle zdroje zobrazení; vlastní zpráva `alert-batch`, kotace ručního
  Marketu beze změny; supervisor ceny ji předá synchronně jen z vlákna se zdrojem IBKR); nezná
  token zařízení ani relay příkazů. Křížení počítá `services/priceAlertWatchCore.ts`
  (bez výchozí ceny nikdy, „jednou“ rozhoduje server), supervisor
  `server/priceAlertWatchSupervisor.ts` má stejná pravidla (nikdy nevyhodí, jistič
  3 pády / 10 min, liveness 15 s); do statusu jde jen stav a stáří v ms.
- Hlídá test: `tests/ibkrPriceSource.test.ts`, `tests/ibkrMarketDataTicks.test.ts`,
  `tests/tvPriceStreamSupervisor.test.ts`,
  `tests/tvPriceStreamWiring.test.ts` (allowlist importů vlákna, pořadí
  buildu, relay hook, dvě vlákna), `tests/tradingViewPriceStream.test.ts`,
  `tests/priceAlertWatch.test.ts` (importy vlákna hlídače, `env: {}`, klíč jen
  v poll-v2, jádro křížení, supervisor, bundle naběhne).
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
- C12 kolo 5 (4. 11. 2026, P3): snímek pozic účtu (reconnect, resync, reconciliation) NAHRAZUJE mapu
  účtu a vynechaný symbol znamená flat — odvozený stav z paměti, který stojí na „net beze změny“
  (`followerPositionSeen`, ustálení „odjinud“ v INV-BRAKE-01), se při nahrazení zneplatní
  (`AccountPositionsCache` v `services/copierRuntimeController.ts`). Test:
  `tests/manualPendingEntryReplay.test.ts` (kolo 5: snímek bez symbolu, Position před Fill kopie).

### INV-TRAD-02: Pending/Suspended stav je aktivní riziko, ale jeho venue-managed quantity není automaticky uživatelský replace

- Výjimka (7. 11. 2026): zbytek holého Limit/Stop (záznam `bare`, žádné nohy, žádná kaskáda) se při dílčím fillu automaticky ruší jako čekající vstup, jeden pokus a výsledek jen stavem. Vstupy s nohami dál ne (INV-MANUAL-01).
- Držený Modify (5. 11. 2026): Modify pozastavené nohy broker jen drží (Command OnHold, bez ExecutionReportu). Projeví se jen s bránou adaptéru `promoteHeldModify` (`--pending-legs on`, sólo DEMO, jen leader) a jen se stejnou qty. Není to provedený posun: záznam nese `heldMove`, po aktivaci nohy se cena ověří, nepotvrzená nebo jiná cena je incident bez automatického zavírání. Bez brány beze změny, s followery se držený Modify nezrcadlí.
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
- C12 (4. 11. 2026, oponentura P1): částečně vyplněný vlastní čekající vstup se automaticky NERUŠÍ
  (zbytek by šel s nohami, kaskáda NEOVĚŘENÁ — stejně jako C16/C7), jen jeden incident „zbytek vstupu
  dál čeká — zruš v Tradovate nebo dej Flatten“; rozhoduje cache i čerstvé REST předčtení. `cancelOrder`
  adaptéru skončí úspěchem i u vyplněného příkazu (`services/tradovateBroker.ts` čeká na
  canceled|filled|rejected) — výsledek zrušení se proto vždy čte ze stavu vstupu.
  Oponentura kolo 1 (P3): předčtení s výsledkem `filled` (i vstup, který skončil s dílčím fillem —
  zbytek zrušený jinde, cache pozadu) ověří nohy čtením (`checkCancelEntryFillProtection`, jinak
  incident per záznam); audit netvrdí „se svými nohami“ (kaskáda po dílčím zrušení NEOVĚŘENÁ).
  Ověření zrušení je jedno čtení (+ druhé po ustálení jen u nejistého výsledku): Fill vlastního
  vstupu doručený streamem PO výsledku „zrušen“ / „už nečeká“ (REST cumQty pozadu, Fill za
  Order(Canceled)) výsledek vyvrátí — `cancelVerified` se opraví na `filled` / `partially-filled`
  a nohy se ověří čtením (`noteOwnEntryFillAfterVerifiedCancel`); nic se neposílá. Zda Tradovate
  Fill po Order(Canceled) s cumQty 0 skutečně posílá, je NEOVĚŘENO (pojistka do hloubky).
  Hlídá test: `tests/manualPendingEntryReplay.test.ts` (REST `canceled` 1/2, Fill po „zrušen“).
  Oponentura kolo 3 (P3): u zrušení s fillem se nohy ověří PŘED uložením výsledku `filled` /
  `partially-filled` (stejně jako C7 a ověření po startu); výsledek nese značku „nohy ověřeny“
  (`legsCheckedAt`). Pozdní Fill po „zrušen“ zapíše fill hned jako předznačku bez značky (pravdivý
  push), značka až po kontrole; fill bez značky po startu znovu ověří nohy (INV-RESTART).
  Oponentura kolo 2 (P1): dílčí fill doručený streamem v okně pozdní kontroly (předčtení i durable
  `sending` jsou `await`; vstup dál pracuje) = incident „zbytek dál čeká“ (`confirmPendingEntryIncident`
  `partial` podle REST), ne „vyplnil se — nic se neodeslalo“ s uzavřeným pokusem; nohy se v tu chvíli
  neověřují (vstup pracuje — „SL/TP nepotvrzené“ by u nohou se starým qty byl nepravdivý text). Memo
  `cancelEntryFillChecks` drží i fill své kontroly: větší fill nohy ověří znovu; Fill ze streamu po
  výsledku `partially-filled` s už proběhlou kontrolou (REST cumQty pozadu) nohy ověří podle většího
  fillu. Test: `tests/manualPendingEntryReplay.test.ts` (kolo 2: Fill 1/2 během `sending` s nohami qty 1
  i 2, z eventů bez předčtení, memo kontroly nohou).
  Oponentura kolo 4 (P3): ověření zrušení bere fill = max(REST, cache streamu, filly vstupu, plné qty
  při Order(Filled)); REST `working 0` i po ustálení při fillu ze streamu = výsledek `filled` /
  `partially-filled` s ověřením nohou, ne incident „dál čeká“; pozdní fill opraví i `working` /
  `unverified`. Test: `tests/manualPendingEntryReplay.test.ts` (kolo 4: C1, fill po „dál čeká“).
  Oponentura kolo 5 (P2): „nohy kryjí fill“ nestačí — fill musí pozici otevřít / zvětšit
  (`fillPositionProblem`, viz INV-BRAKE-01); fill vstupu proti pozici na opačné straně = nohy jsou nahé
  vstupy → incident `fill-unprotected`. Pozice z cache (bez ingress) nebo ze dvou po sobě jdoucích REST
  čtení — první snímek `/position/list` se může připojit k požadavku z doby před fillem.
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
- C12 kolo 4/5 (4. 11. 2026): clOrdId z REST čtení (`order.tag`) slouží jako důkaz VLASTNICTVÍ čekajícího
  vstupu z flat proti pozici na opačné straně (ne jako idempotence); chybí-li (u `placeOSO` parentu
  NEOVĚŘENO), záložní důkaz jsou obě nohy záznamu s `parentOrderId` = vstup (INV-BRAKE-01). Nesedící tag
  je vždy „cizí“.
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

### INV-TRAD-07: Typ příkazu, který adaptér nezná, nikdy nezastaví čtení a nikdy se nekopíruje ani nemodifikuje

- Proč: 3. 11. 2026 se z kódu (a testem) ukázalo, že jediný TrailingStop / MIT /
  TrailingStopLimit / QTS zadaný v Tradovate na KTERÉMKOLI účtu přihlášení — i
  vyplněný nebo zrušený v `/order/list` aktuální session — shodil při skládání
  příkazu synchronizaci, po reconnectu znovu (crash loop): kopírka byla slepá do
  konce session. Kopírovat takový typ followerům bez ověřené sémantiky
  (`pegDifference`, spuštění MIT) by byl zápis s neznámým výsledkem.
- Vynucuje: `services/tradovateBroker.ts:observedOrderType` složí neznámý typ
  jako `orderType: 'Unsupported'` se surovým `brokerOrderType` (nikdy výjimka);
  `services/brokerPort.ts` — zápisy (`BrokerOrderRequest`, modify) nesou jen
  `OrderType`, pozorované příkazy `ObservedOrderType`;
  `services/tradovateMapping.ts:assertWritableOrderType` (placeorder, OCO/OSO
  nohy) a `modifyOrder` adaptéru vyhodí PŘED POSTem;
  `services/copierRuntimeController.ts` hned za `source.observe`: submitted /
  replaced `Unsupported` leadera = jednou na id `processor.record` + audit
  `leader-unsupported-order-type`, se followery za ARMED `failClosed` bez
  auto-close (text jmenuje followery se starou kopií), za DISARMED
  `invalidateReconciliation`, v manual-only skupině jen audit; canceled/rejected
  jdou dál běžnou cestou (runner zruší kopie podle durable vazeb);
  `services/copierEngine.ts:planReplication/planModify` druhá pojistka
  (`unsupported-order-type`); `services/manualScaleIn.ts` `leg-type`;
  `prepareManualOrderAction` posouvá jen SL typu Stop a TP typu Limit;
  `copierManualActions.mayResendLiquidation` se při `Unsupported` neopakuje;
  durable `lastExecution` typ `Unsupported` nikdy neukládá (validace ho nezná).
  Pracující `Unsupported` je aktivní příkaz (`isOpenOrderStatus`), takže ARM,
  flat a no-working brány i `foreignOrders` přikoupení blokují. Kopie followera
  (vazba v `links`), kterou někdo v Tradovate změní na takový typ, = za ARMED
  `failClosed` bez auto-close (další modify zastaví změna generace), za DISARMED
  zneplatnění. Text incidentu leadera jmenuje i followery, kteří drží pozici na
  symbolu bez této ochrany (typicky trailing SL k otevřené pozici). Fill takového
  příkazu (např. MIT vyplněný hned, bez viditelného submitu) se on-fill followerům
  kopíruje jako Market — kopíruje se exekuce, ne typ (záměr).
- Hlídá test: `tests/tradovateBrokerUnsupportedOrderType.test.ts`,
  `tests/copierUnsupportedLeaderOrder.test.ts` (mutace: vypnutý intercept → 3 testy padají;
  vypnutá kontrola kopie followera → test „kopie followera změněná…“ padá).
- Nikdy: Nemapovat neznámý typ na nejbližší známý (TrailingStop ≠ Stop — follower
  by dostal statický stop), neposílat ho ve `modifyOrder`, nedorovnávat trailing
  leadera obchodem a nevyhazovat ze čtecí cesty kvůli typu.
- Bezpečné změny vs. nebezpečné: Bezpečné je přidat typ do `OrderType` až se
  záznamem chování u brokera na DEMO (R1) a s vlastním návrhem pro critic.
  Nebezpečné je povolit `Unsupported` v outboxu nebo ve validaci durable stavu.
- Ověření u brokera: záznam R1 (`docs/reviews/trading-gaps-designs/safety.md`, C1)
  až po nasazení této opravy do VŠECH workerů na přihlášení — dřív by sám
  záznam shodil běžící worker.

### INV-TRAD-08: WebSocket write se po odeslání nikdy neopakuje přes REST; ACK je korelovaný request ID, ne execution důkaz

- Proč: Tradovate přijímá stejné order endpointy přes autorizovaný WebSocket.
  Ztráta odpovědi ale neříká, zda broker zápis provedl; REST fallback po
  `send()` by mohl vytvořit duplicitní objednávku.
- Vynucuje: `services/tradovateBroker.ts:requestSocketWrite` registruje request
  před odesláním, páruje odpověď podle jedinečného `i`, timeout/close/send
  failure vrací jako neznámý výsledek a blokuje plánovanou obnovu socketu,
  dokud write čeká. `writeOrderRequest` smí použít REST jen před WS odesláním,
  pokud socket není plně synchronizovaný. Přímý ACK se vyřídí mimo semantic
  frame tail, ale broker Order/Fill/Position události zůstávají ve svém pořadí.
- Aktivace: výchozí stav je vypnuto. Mac installer dovolí
  `--tradovate-ws-writes on` pouze pro `manual-only` DEMO worker; funded/live
  cesta se tím bez výslovné budoucí validace nemění.
- Hlídá test: `tests/tradovateBrokerWebSocketWrites.test.ts`,
  `tests/tradovateBrokerReconnect.test.ts`, `tests/tradovateBrokerRenewal.test.ts`,
  `tests/copierAgentLifecycle.test.ts`.
- Nikdy: Po WS timeoutu, pádu nebo chybě `send()` neposlat totéž přes REST;
  nepovažovat transportní ACK za fill ani výslednou pozici; neobnovit socket
  uprostřed nevyřízeného write requestu.
- Bezpečné změny vs. nebezpečné: Bezpečný je REST fallback před prvním WS
  bytem a pozdější read-only lookup podle `clOrdId`/order ID. Nebezpečný je
  transportní retry nebo přepsání execution state jen z ACK payloadu.

### UI pravidla

### INV-UI-01: Obnovený stav může krátce stabilizovat zobrazení, ale neautorizuje příkaz; po grace je stale/unknown neutrální

- **Jedno kliknutí (rozhodnutí Filipa 5. 11. 2026, „jsem zvyklý z TradingView, že se nedoptává“):** dvoukrok
  „Opravdu?“ je v LIVE obchodování zrušený. První klik, klepnutí nebo stisk rovnou odešle BE a jeho varianty, posun
  SL/TP číslem, × vstupu, přikoupení a pozice (čára i panel), Odeslat z Náhledu, holý Market, Zrušit čekající,
  Zrušit na Dashboardu, Shift+E/X/C a na telefonu lištu Zavřít / Zrušit / Flatten a list správy. Zůstává: dialog
  Flatten All na Dashboardu a Shift+F, dialog ARM, dvoukrok mazání šablony (není to příkaz k brokerovi) a dvoukrok
  čar backtestu (`confirmCancel` / `confirm`). Pojistky: sdílený zámek jednoho příkazu (`busyRef`, `placingRef`,
  `directBusyRef`); dvojklik do 400 ms na týž klíč se spolkne, i když první příkaz doběhl (`lib/liveClickGate.ts`);
  tlačítko, které do 1 s změnilo význam, klik spolkne, ať neodejde jiná akce než viděná (`createLiveClickGate`,
  na čárách `BacktestOrderLinesOverlay:liveLineClick`: čekající → vyplněno, holá → spravovaná, zmizelé přikoupení;
  overlay zůstává připojený i bez čar, podpis nebere ✎ ani ceny; spolknutí změnou napíše `LIVE_ACTION_CHANGED_TEXT`, dvojklik je tichý);
  telefonní lišta má pojistku v rodiči (`useLivePhoneBarGuard`, přežije stav bez pozice) a spolkne jen Zrušit → Flatten,
  pozice → pozice nikdy; velké tlačítko panelu je po neznámém výsledku zamčené do změny návrhu nebo stavu;
  „Posunout → X“ pošle jen cenu z tlačítka (`liveMoveClick`); Dashboard „Zrušit“ klíčuje na id vstupu a ověří řádek;
  všechny brány panelu a kontroly čerstvosti při kliku; fokus po kliku pryč z tlačítka. Worker se nemění a ověří
  všechno znovu. Starší věty o dvoukroku níže platí jen tam, kde je to výslovně řečeno. Hlídá
  `tests/liveC7C8Ui.test.ts`, `tests/useLiveManageRunner.test.ts`, `tests/liveHotkeys.test.ts`.
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
- Nouzová lišta se v běžném provozu nekreslí (rozhodnutí Filipa 5. 11. 2026, vědomě proti původní
  statické liště, je to o klik dál): OFF, Kill a Flatten All jsou na Dashboardu LIVE (OFF a Kill
  v menu ⋮ bez vazby na skupinu, Flatten All u skupiny), OFF i v hlavičce PC grafu. Přechod na
  Dashboard je povolený z každé záložky i při čekající změně konfigurace
  (`lib/tradovateLiveTab.ts:liveTabNavigationAllowed`). `components/LiveSafetyControls.tsx` zůstává
  jako jediná instance mountnutá s `hideBar` kvůli dialogu Shift+F a hláškám o výsledku.
  Lišta se vrací, když Dashboard na obrazovce není (`lib/liveSafetyAction.ts:liveSafetyBarNeed`):
  hned bez Tradovate připojení (`ConnectionRequired`), po pádu přehledu nebo grafu (PC i telefon,
  i nad `FallbackLayer`) a po selhání chunku přehledu; po prodlevě 3 s při ověřování připojení,
  studeném startu a dlouhém načítání chunku přehledu. Na záložce Připojení ani na grafu bez pádu
  se nevrací, cesta na Dashboard tam je. Vykreslená je na úzkém webu nad BottomNav, v native
  shellu používá `native-fixed-above-tab-bar` a při otevřeném dialogu se schová. Bez lišty drží
  fixní prvky nad nativní lištou a BottomNav `--live-bottom-clear` (`index.css`).
- Dialog běžícího příkazu Dashboardu brzdy nezakrývá natrvalo: potvrzovací dialog, list Flatten,
  editor skupiny, průvodce zapnutí a odebrání nedostupného followera jdou zavřít tlačítkem i během
  běhu. Příkaz doběhne na pozadí, nic se tím neruší ani neopakuje, výsledek přijde toastem a jiný
  otevřený dialog se nezavře. Potvrzení zůstává při běhu zamčené, klik mimo dialog a Esc běžící dialog
  dál nezavírají. Zvolené místo brzd nad dialogem: menší změna bez nové vrstvy, cesta jde ⋮ a Flatten.
  Zavření průvodce zapnutí během vyřazení účtu ruší záměr: vyřazení doběhne, ARM nikdy
  (`armBlockExclusionOutcome`). Selhané zapnutí nepřepíše otevřený dialog Flatten All.
- Výsledek Flatten All z Dashboardu ověřuje `liveSafetyReceipt` nad potvrzeným cílem a předává ho desk
  do hlášky `LiveSafetyControls` (i s `hideBar`, přežije záložky, chyba zůstává do ×). Bez výsledku,
  s nekrytými účty nebo po novější brzdě je to chyba; rearm nabídne jen potvrzený flat
  (`flattenRearmAllowed`) a jde přes přepínač, takže je po cestu vidět OFF. Během Flattenu žádný jiný
  příkaz nezačne: `flattenRunning` je odvozený i z `flattenCoordinator.anyPending`, takže platí po
  remountu přehledu i pro Flatten z lišty, Shift+F a telefonu, a stejně ho hlídá pojistka zapínání.
  Příkaz nese ID skupiny workeru z potvrzeného cíle, i když má knihovna jiné.
  Během zapínání na pozadí je OFF v menu ⋮ i v grafu i nad stavem „prokazatelně vypnuto“.
  OFF, Kill, zámek dne a Flatten All synchronně zvednou `armCancelEpochRef` v `executeSafetyCommand`;
  `createCopierArmGuard` pak před každým `arm-live` a `activate-group` nic neodešle a vyhodí „zapnutí
  zrušeno brzdou“ (i po Flatten All, viz INV-ARM-03). Už odeslaný příkaz tím odvolat nejde: je-li `arm-live` v letu, rozhoduje pořadí
  u workeru a skutečný stav ukáže přehled.
  Hlášky desku mají v `LiveSafetyControls` vlastní sloty (`externalNotices`), `notice` lišty je nepřepíše.
- „Zrušit čekající“ v liště vedle Flatten All (C7 UI, 4. 11. 2026; od 5. 11. je na PC vidět jen
  v nouzových stavech lišty, jinak ruší Dashboard „Zrušit“ a Shift+C) NENÍ safety akce: jen
  s capability a vlastními čekajícími vstupy, nad čerstvým neobnoveným statusem s relayem,
  jedním klikem a sdíleným zámkem jednoho příkazu desku (`liveCommandLockRef`). OFF, kill
  a Flatten All tím zámkem ani jeho `busy` zamčené nejsou a jejich cesta se nemění. Část C7
  se v liště vykresluje ve VLASTNÍ hranici chyb (`LiveCancelPendingBoundary`, fallback nic)
  a pohled `liveCancelPendingView` / `dashboardOrderCancelView` status workeru sanitizuje
  (`validPendingOwnEntries`, `validPendingCancelContext`: pole s `null` prvkem, objekt místo pole,
  položka bez ceny, objekt místo textu důvodu) a chybu výpočtu chytí (= nic se nenabídne) — rozjetý
  status web/worker tak nesundá render desku ani OFF / Kill / Flatten All (oponentura UI kolo 1).
- Full-group Flatten z lišty i přehledu sdílí jediný zámek podle `groupId`
  (`lib/liveSafetyAction.ts:createFlattenGroupCoordinator`). Na Dashboardu jde mimo zámek běžných
  příkazů `busyCommand` (`dashboardCommandLock`, `dashboardDialogBusy`) a jde stejnou trasou brzdy
  jako lišta a Shift+F: `routeDashboardCommand` ověří cíl uložený při otevření dialogu
  (`assertSameSafetyTarget`) a volá `executeSafetyCommand`, tedy poslední známou route bez nutnosti
  aktuálního `agentTransport` (INV-BRAKE-03). Flatten jednoho účtu ani jiné příkazy touto trasou
  nejdou. Druhý caller se
  připojí ke skutečnému výsledku prvního; lokální Flatten nemá 10s abort a
  zámek se uvolní až po resolve/reject workeru. Nikdy nesmí timeout UI vytvořit
  druhý brokerový příkaz. Hlídá `tests/liveSafetyControls.test.ts`.
- Zkratka Shift+F na PC (U1, 3. 11. 2026) je opt-in, výchozí vypnutá (`readLiveHotkeysEnabled`),
  a funguje jen v grafu. Není to tedy záruka dosažitelnosti brzdy. Akce notifikace, která by
  dialog otevřela, v kódu neexistuje; `source: 'native-intent'` je jen připravený typ a jediný
  volající je graf. Zkratka jen OTEVŘE dialog
  Flatten All z `LiveSafetyControls` (`lib/liveSafetyShortcut.ts:requestLiveSafetyConfirmation`
  → `LiveSafetyControls.tsx:liveSafetyShortcutListener` → `setConfirmation`) se stejným
  cílem a týmž zámkem skupiny; nic neprovedou. Otevřený dialog se nepřepíše, běžící
  Flatten ani neznámá skupina dialog neotevře, Kill switch zkratkou nikdy. Dialog
  otevřený zkratkou má fokus na **Zrušit** (`liveSafetyDialogInitialFocus`,
  `ConfirmActionDialog` `initialFocus: 'cancel'`), takže reflexní Enter / mezerník hned
  po Shift+F Flatten nepotvrdí; potvrzuje se klikem (nebo Tab + Enter). Dialog
  otevřený tlačítkem lišty má fokus beze změny. Neověřený cíl uvede sám dialog
  (`liveSafetyFlattenMessage`), lišta bývá skrytá.
  Hlídá `tests/liveSafetyShortcut.test.ts`, `tests/liveChartPcIntegration.test.ts`,
  `tests/liveWaveBCriticFixes.test.ts`.
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
- LIVE na telefonu (nativní appka, 1. 11. 2026): LIVE se otevírá rovnou na
  celoobrazovkovém grafu (`components/day/LivePhoneChart.tsx`,
  `role="dialog"`, takže případná nouzová lišta je pod ním schovaná; od 1. 11. je na
  grafu schovaná i nativní lišta iOS, na ostatních záložkách LIVE se vrací). **Výjimka podle
  výslovného rozhodnutí uživatele:** nouzová lišta ani Vypnout NEJSOU na
  telefonním grafu, v menu LIVE ▾ ani v •••. DISARM je dosažitelný takto:
  - LIVE ▾ → Live Dashboard (menu obsahuje přehled vždy) → OFF → potvrzení,
    tedy 4 klepnutí; s otevřeným listem (účty v obchodě, objednávka,
    nástroje, menu plusu, nastavení a seznam upozornění) o jedno víc, list
    zakrývá i LIVE ▾ (vědomě přijato 2. 11.);
  - vrstva LIVE v ploše grafu (štítky příkazů, upozornění, plusko, karty,
    lišta) je ve vlastním stacking contextu se z-indexem 20, tedy vždy pod
    listy a menu LIVE ▾ (40+) — nic z grafu nesmí zakrýt ani pohltit
    klepnutí na cestu k vypnutí (`tests/priceAlerts.test.ts`, oponentura 2. 11.);
  - přechod z grafu na přehled je povolený vždy (`lib/tradovateLiveTab.ts`);
  - notifikace z kopírky (risk, zámek dne, odpojený follower, časovače)
    otevírají `live:overview` (`lib/liveOverviewRoute.ts`) přímo na
    přehledu;
  - pád telefonního grafu se pamatuje jako na PC
    (`rememberLiveChartCrash`), takže do konce relace se LIVE otevírá na
    přehledu; v okamžiku pádu se vrátí nouzová lišta (`liveSafetyBarNeed`).

  Rizikové notifikace i tlačítko „Zkontrolovat LIVE“ (lokální i APNs
  s `route: 'live'`) převádí `services/nativeNotifications.ts:dispatchNativeNotificationAction`
  na tuto cestu. Server dál posílá `live`, protože starší build appky novou
  cestu nezná.

  Čip kopírky v hlavičce (`lib/livePhoneCopierChip.ts`) ukazuje ZAP/VYP jen
  z čerstvého neobnoveného stavu. Vychází ze stejného výkladu jako stavová
  lišta na PC (`copierValue`) a s důvody `liveAttentionReasons` (incident,
  rozjeté účty, zaseknutá operace…) se změní na „Pozor: …“. Hlídá to
  `tests/livePhoneCopierChip.test.ts`. Obchodní lišta a list objednávky
  na telefonu (fáze A) nemají cestu k brokerovi
  (`tests/livePhoneTrade.test.ts`). Odesílání z telefonu je nová cesta do
  jádra a půjde přes INV-* a critic.

- **Upozornění na cenu na PC (6. 11. 2026):** čáry alertů leží pod čarami příkazů (z 14 pod z-115), dialog a seznam pod
  hlavičkou LIVE (z-700 pod z-800), takže OFF zůstává klikatelné. Otevřený dialog (`role="dialog"`, `aria-modal`) ztiší
  klávesové zkratky včetně Shift+F, jako ostatní dialogy; Esc nebo klik vedle ho zavře. Alert nemá cestu k příkazu.

- **Naléhavost upozornění na cenu (7. 11. 2026, INV-WATCH-01):** notifikace alertu je `time-sensitive`, má vlastní vlákno i collapse-id, `apns-expiration: 0` a rozpočet 20 za 10 minut, takže rizikovou nevytlačí. Pozor: přepínač Time Sensitive je v iOS společný pro celou appku. Když ho uživatel vypne kvůli alertům, přijdou o průchod Focusem i rizikové pushe. Entitlement zároveň poprvé opravdu zapíná průchod Focusem u všech pushů, které `time-sensitive` už posílají (riziko, obchody, snímky).
- **Upozornění na cenu v Live Activity (7. 11. 2026):** tik a cron čtou `price_alert_events` jen pro zobrazení (strop 300 ms, nikdy nevyhodí) a přidají úroveň uživatele do běžné aktualizace ze skutečného plánu. Žádné přehrávání uloženého stavu ani vlastní aktivita. Do `end`, rizikového a offline stavu se alert nepřidá; `aps.alert` je bez zvuku a jen při prvním odeslání po spuštění. Běžná notifikace je na tom nezávislá.

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
- C12 (4. 11. 2026): `controller.manualEntries[].cancelVerified`, `cancelReason`, `autoCancelAt`,
  `pendingIncident` a `pendingOwnEntries` jsou jen zobrazení — „zrušen“ smí UI napsat jen
  u `cancelVerified: 'canceled'`, nabídka „Zrušit čekající“ nic neautorizuje (worker znovu čte REST
  a rozhoduje sám, INV-MANUAL-01). Oponentura kolo 3 (P3): `manualEntries[]` nese posledních 10
  záznamů a navíc každý starší s otevřeným vstupem / nohou v cache nebo s incidentem / zrušením
  v okně notifikace (10 min) — `manualEntryStatusRecords`, pořadí podle `createdAt`; jen zobrazení
  a per-záznamový push (INV-WATCH-01). Kolo 5 (P2): `cancelVerified: 'filled'` neznamená „pozice je
  otevřená“ — fill vstupu proti pozici na opačné straně ji zavřel; audit ani push to netvrdí (durable
  `cancel.opposite` jen pro texty, nic neautorizuje). UI navázání (komponenty se v C12 neměnily): text
  „vyplnil se během rušení“ v LIVE by neměl dovozovat otevřenou pozici z `cancelVerified`.
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
  reconcile nebo „pozice neověřena“ zůstanou na REST. Platí i pro LIVE.
  Průměrná cena po změně velikosti pozice (30. 10. 2026, oponentura):
  přednost má průměr z REST pro tutéž `netPosition`; jinak průměr od workeru
  (`exposure.positions[].avgPrice`): broker `netPrice` ze streamu Position
  (`displayAveragePrice` v události, záměrně mimo `BrokerPosition`), jinak
  průměr z fillů (denní počítadlo leadera, risk ledger followera) — vždy jen
  když sedí na kusy pozice a cena je konečná > 0; jinak `null`. Pozice tak v grafu stojí hned po fillu (dřív až po REST
  ticku). Když REST za workerem zaostává, overlay nastaví
  `openPnlBehindPosition` → `unrealizedPnlBehindPosition`: karta obchodu,
  telefonní detail i TV noha řádku P&L z dřívějšího stavu neukáží, cena
  trhu z P&L je `null`, takže utažení SL k trhu i BE zůstanou blokované
  do dalšího plného REST ticku. `unrealizedPnlSource` se záměrně nemění
  (odvození denního limitu účtu, `lib/copyTradeAccountEligibility.ts`).
  Průměr do žádného příkazu nevstupuje (BE bere `entryAvgPrice` od workeru,
  zavření stop a kusy ze streamu). Známé omezení: chybí-li zavírací i
  vstupní fill téže velikosti, nebo pozice 2→0→2 předběhne fill, ukáže se
  do REST ticku starý průměr (čára vstupu a částky SL/TP) — ceny trhu ani
  brány se to netýká. Testy `tests/tradovateWorkerExposureOverlay.test.ts`,
  `tests/copierRuntimeController.test.ts`, `tests/tvLivePnl.test.ts`,
  `tests/liveMobilePresentation.test.ts`.
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

### INV-MANUAL-01: Ruční vstup z appky jde jen přes worker na leadera; náhled (fáze 1a) nic nezapíše (29. 10. 2026)

- Limit a Stop opravdu bez SL/TP (7. 11. 2026, capability `manual-entry-bare-pending-v1`, rozhodnutí Filipa „opravdu bez“ a „víc kontraktů“): u brokera jediný příkaz bez nohou, jen sólo manual-only DEMO skupina bez followerů, do stropu skupiny, jen z flat, čerstvá kotace IBKR stejného kontraktu. Limit nesmí být přes trh, Stop musí být aspoň 8 ticků na straně průrazu; kontrola v náhledu i synchronně těsně před POSTem. Výjimka z „vlastní vstup se nekopíruje bez nohou“ (`flushStandaloneOsoEntry`) platí jen pro id z ACK se záznamem `bare`; před ACK a při neznámém výsledku zůstává `maybe`, nic se nepřiřazuje podle účtu, symbolu ani počtu. Neznámý výsledek POST = `failClosed`, nikdy opakování. Čekající holý vstup je pro C12 a C7 běžný čekající vstup: OFF, kill, day lock, konec session, CME pauza a konec ARM ho zruší, × ho zruší (`resolveManagedTrade` jen pro `cancel-entry`). Počet fillu jen z `order.filledQuantity`, durable `filledQuantity` jen roste (`noteBareEntryOrder`). `filled` s menším fillem je nejednoznačný (zbylé filly, nebo raw Filled se zrušeným zbytkem): rozhodne další událost, nebo čtení po ustálení. Správa SL/TP a × pozice až po durable `filledAt` (`bareEntryFilled`) a na skutečný počet (`bareEntryOpenQuantity`). Zrušený nebo odmítnutý bez fillu = `closedAt`, pozdní fill ho vrací; fill po uzavření obchodu nebo po `filledAt` = incident `bare-late-fill`, záznam se nevrací. Dílčí fill se zbytkem: čipy ani × pozice nejsou, status `barePartial` kreslí zbytek čarou s ×; ruční × projde jen s `expect.filledQuantity` shodným s čerstvým stavem a je bez incidentu, větší fill během rušení jde běžnou cestou. Fill při rušení nebo za vypnuté kopírky = incident „BEZ SL/TP“ (na ověřeně flat účtu jen audit), za ARMED zpráva `bare-filled`. Starý vstup nepřevezme cizí pozici: `closedAt` na flat a kontrola lotu deníku. Okamžité odeslání: položka menu pravého tlačítka (jen kliknutí, `event.detail > 0`, a jen když typ z menu sedí s typem z kotace, jinak panel) a menu plusu v telefonu (dotyk do 350 ms po otevření se ignoruje), jen s capability, bez pozice a bez návrhu; klávesa nikdy. Vědomě přijaté riziko (Filip): fill bez dozoru nemá strop ztráty a při výpadku workeru se vstup nezruší ani nepřijde zpráva. Posun ceny holého vstupu a čipy před fillem nejsou.
- Nohy nevyplněného vstupu a TP blíž k trhu (5. 11. 2026, `--pending-legs on`, sólo DEMO): SL/TP čekajícího Limit/Stop vstupu jde posunout jen na správnou stranu vstupu, i u víc kontraktů (rozhodnutí Filipa, jen DEMO: částečný fill během zápisu může nechat nohu na plný počet, oponentura to označila za P1); TP blíž k trhu jen s čerstvou kotací IBKR a aspoň 8 ticků na ziskové straně. Conformance z API se dělá z appky na DEMO před zapnutím flagu.
- Potvrzování: od 5. 11. 2026 bez dvoukroku, první klik odesílá (viz „Jedno kliknutí“ v INV-UI-01). Brány a worker beze změny.
- Proč: Obchodování z grafu je první risk-zvyšující cesta z appky. Fáze 1a
  ověřuje brány naostro bez zápisu, aby „náhled OK“ nikdy nebylo zaměněno
  za odeslání.
- Vynucuje: `lib/leaderEntryPreview.ts:validateLeaderEntryPreview` (stejná
  validace na enqueue, claim i ve workeru; `operationId` jen `preview:`),
  `server/tradovateCopierCommandRelay.ts:assertPreviewAdmissible` (nejvýš
  jeden náhled na zařízení, 3 s rozestup, TTL 15 s — sériová linka relaye
  nezdrží brzdy), `services/copierRuntimeController.ts:previewLeaderEntry`
  (jen synchronní sběr zmrazených vstupů, žádné IO, audit, persist ani
  lastError), čisté `services/manualEntryPreview.ts:evaluateManualEntryPreview`
  (bez importu brokera; chybějící data ≠ flat; riziko = MIN ze všech limitů),
  `server/localCopierExecutionAgent.ts` (brzda po zadání = blocker; neznámý
  copy-command = throw), panel `components/LiveOrderTicket.tsx:PreviewSection`
  (stáří od přijetí, po 15 s zastaralé, nikdy „připraveno“, Odeslat vypnuté).
- Hlídá test: `tests/manualEntryPreview.test.ts`,
  `tests/manualEntryPreviewController.test.ts` (ARMED controller s mock
  brokerem: nula volání brokera, commitů a auditů), `tests/localCopierExecutionAgent.test.ts`.
- Nikdy: Náhled nesmí autorizovat odeslání ani se stát jeho deduplikačním
  záznamem; odeslání (fáze 1b) vše přepočítá z čerstvého stavu a kotace
  brokera. Kontrakt jen ze zdroje ceny grafu, nikdy odhadem v týdnu rollu.
- Bezpečné vs. nebezpečné: Bezpečné je přidat blocker. Nebezpečné je náhledu
  dát přístup k brokerovi, REST čtení nebo čekání na `eventTail`.
- **Manual-only DEMO (1. 11. 2026):** výjimka bez followerů je platná pouze
  pro skupinu s `localOnly: true` a `manualOnly: true`. Installer ji vytvoří
  jen explicitním `--manual-only`, který se nesmí kombinovat s follower
  parametry. Skupina smí posílat výhradně vlastní ruční vstup/správu leadera;
  běžná copy group dál vyžaduje alespoň jednoho odlišného followera. Sanitizer
  odmítne manual-only skupinu s followerem nebo bez local-only příznaku.
  Worker instalační topologii uzamkne: vzdálený příkaz nesmí změnit leadera,
  přidat followera ani převést běžnou skupinu na manual-only. Cloudová knihovna
  příznak `manualOnly` neukládá. Instalační safety profil má denní strop 250 USD,
  nejvýše 40 obchodů za session a při expiraci ARM zavírá celou skupinu (tedy
  jediný DEMO účet). Venue bez vlastního DLL/DD používá pro preview tento lokální
  strop; bez něj zůstává `risk-unknown` fail-closed.
- **Fáze 1b — odeslání (29. 10. 2026):** jediný risk-zvyšující příkaz appky
  `place-leader-entry` (`lib/leaderEntryPlace.ts`: prefix `entry:`, otisk
  payloadu). Jen přes relay (loopback = `manual-entry-relay-only`), s
  platností 15 s (`deadlineAt` bez ACK rezervy; chybí = blocked), jeden
  na uživatele (do 1. 11. 2026 na zařízení; od té doby atomicky v DB, viz
  INV-RELAY-01), 3 s rozestup, 100 za 24 h (do 30. 10. 2026 30; Filip zvedl;
  denní strop správy 100 neplatí pro zavření obchodu — snižuje riziko),
  idempotence `operationId` per
  uživatel, brzda čekající vstup zneplatní. Controller
  (`placeLeaderEntry`/`executeManualEntry`): běží ve frontě controlleru
  s ohraničeným startem (2 s), znovu projde VŠEMI branami náhledu, vyžaduje
  ARMED (ne shadow) a žádný nevyřešený ruční vstup; durable záznam
  `safety.manualEntries` ve stavu `sending` PŘED zápisem; fence z čítačů
  příchodu eventů (trade verze účtů, `configurationControlVersion`,
  `connectionSyncGeneration`, safety generation) těsně před zápisem —
  neshoda = `not-sent`; jeden POST přes `dispatchBroker` s timeoutem 5 s,
  nikdy retry. Výsledek: všechna tři id = `acknowledged` (id se zapíšou do
  živých příkazů leadera → další vstup blokuje brána klidu); id vstupu bez
  nohou = `abandoned` + incident bez auto-close + cílené zrušení vstupu;
  definitivní odmítnutí bez id = `rejected`; jinak `unknown`. ACK za
  DISARMED (brzda během POSTu) = vlastní vstup se hned zruší. Restart
  v `sending` = `unknown`.
- **Pojistka za relay (1. 11. 2026):** worker před durable `sending` odmítne
  vstup `manual-entry-too-soon`, pokud poslední záznam ve stavu sending |
  acknowledged | unknown | abandoned | waived vznikl před méně než
  `MANUAL_ENTRY_MIN_INTERVAL_MS` (3 s, `lib/leaderEntryPlace.ts`, sdílí relay).
  rejected a not-sent se nepočítají. ACK s id vstupu je pozorování obchodu
  leadera: zvýší `tradeObservationVersionByAccount` leadera,
  `tradeBoundaryObservationVersion` i `brokerObservationVersion` (stejné
  čítače jako eventy téhož OSO o ~100 ms později), takže REST snímek
  rozběhnutý před ACK neprojde fence a nesmaže id z ACK z živých příkazů.
  Snímkové cesty: reconcile, route-epoch refresh a přepnutí followera čtou
  verzi účtu; návrat ručně zavřeného followera `tradeBoundaryObservationVersion`;
  ARM preflight `brokerObservationVersion` (a běží jen za DISARMED); route-gap
  porovnání při neshodě failClosed; opravné čtení followerů leadera nečte.
  Test: `tests/manualEntryPlace.test.ts` — vypnutí followera za ARMED čte REST
  před POSTem, aplikace po ACK (eventy OSO zadržené) skončí „Stav se během
  ověření změnil“ a další vstup po 3,1 s zastaví brána klidu (mutačně ověřeno:
  bez zvýšení verze test padá); pojistka rozestupu má vlastní testy.
  Dvě živé instance workeru tím nejsou vyřešené (INV-WORKER-02 zůstává otevřený).
- **Vědomá odchylka od INV-DEFAULT-02:** `unknown` nechá kopírku ARMED
  (leaderovy eventy dál zrcadlí; vstup bez nohou se během `unknown` nikdy
  nekopíruje). `unknown`/`abandoned` blokuje jen ARM a další ruční vstup —
  ne dispatch, Flatten, brzdy ani obnovu spojení; rozuzlení jen auditovaným
  `resolve-stuck-operation` s `kind: 'manual-entry'` (vypne, vynutí kontrolu pozic).
- **Fáze 2a — správa vlastního vstupu (29. 10. 2026):** `manage-leader-order`
  (`lib/leaderOrderManage.ts`) jen pro vlastní přijatý ruční vstup (id ze
  `safety.manualEntries`), jen přes relay. Posun SL/TP jen DÁL od trhu
  (pracující SL/TP je jediný broker důkaz strany trhu; utažení/BE až po
  záznamu „modify přes trh“), posun SL přepočítá riziko leadera i followerů.
  Ve frontě: autoritativní `listOrders`, čistý tvar (plný fill, obě nohy
  working bez fillu, qty = pozice, nic jiného na symbolu), brána dosahu
  (`manageReachBlockers`: stejné predikáty jako controller i runner u replace,
  živé nohy followerů, žádný rozpracovaný cancel/modify, žádný halt), durable
  `safety.manualOrderActions` `sending`; zápis mimo frontu po synchronní
  kontrole fence a brány. `unknown` neblokuje ruční ARM (flat-first), ale
  blokuje automatické pokračování a další změnu téhož vstupu; vyřeší ho jen
  stream (cena dosedla / příkaz skončil) nebo auditovaný waiver.
  `cancel-entry` jen nevyplněný vstup a žádný follower s pozicí; smí i za DISARMED.
- **Fáze 2b — obchody, které kopírka sleduje (29. 10. 2026):** `manage-leader-order`
  s `leaderEntryOrderId` místo `entryOperationId` (právě jedno). Id vstupu, SL a TP
  leadera z durable `osoOutbox` + `bracketOutbox` (hledá se v obou), jen bílá listina:
  všechny položky pro vstup `acknowledged`, shodná id nohou a symbol
  (`resolveManagedTrade`). `cancel-entry` navíc vyžaduje pokrytí: každý zapojený
  follower má vazbu na vstup leadera (runnerův predikát nad entry sadou). Čistý tvar
  platí i pro nohy followerů (bez fillu, qty = |pozice followera|; i pro 2a). Riziko
  posunu SL od nejhorší ceny vstupu včetně durable `openLots.avgPrice`; Market/Stop
  vstup bez známého fillu = blocked. `manageableLeaderTrades` ve statusu je jen výběr
  pro UI. Hlídá test: `tests/manualOrderManageTracked.test.ts`.
- **Fáze 2c — utažení SL a SL na BE (30. 10. 2026):** `move-stop` smí k trhu
  (ruší P4 §10.1); stop přes trh odmítne broker (záznam 30. 10.: `InvalidPrice`,
  noha beze změny). Jen prostý `Stop`, SL ostře na ochranné straně čerstvého TP,
  utažení bez přepočtu limitů; `move-target` k trhu dál blokovaný. Úspěch jen
  s autoritativním `findOrderById` ohraničeným 3 s (adaptér bez syncu hlásí úspěch
  i u odmítnutí) — nebo (zrychlení 30. 10.) řádkem streamu, jehož cena se po zápisu
  změnila na novou (ne syntetický ACK řádek); noha `filled` = `waived` s důvodem, zrušená noha při trvající
  pozici = `unknown` (nikdy úspěch); `unknown` se dořeší jen čtením (po zápisu,
  po kontrole pozic, po startu), `rejected` z čtení jen po skončeném zápisu.
  Brzda během zápisu = výsledek přizná původní SL followerů. Odmítnutý modify
  followera jde stávající cestou (jen správa u nativního OSO, jinak fail-closed),
  žádná nová výjimka. UI pojistka (8 ticků od ceny z P&L brokera) jen blokuje.
  **BE / utažení bez ceny z P&L (2. 11. 2026, noční test: BE nešlo ani jednou):** UI pojistka smí místo
  chybějící ceny z P&L brokera vzít čerstvou kotaci IBKR (≤ 3 s) téhož konkrétního kontraktu pozice
  (`lib/liveChartPosition.ts:withIbkrTightenMark`; TradingView/kontinuální nikdy; při akci se vyhodnotí
  znovu). Worker při `move-stop` k trhu nově sám odmítne nový SL blíž než 8 ticků od své kotace IBKR
  (`tighten-too-close`); bez čerstvé kotace dál rozhoduje broker (SL přes trh odmítne). Hlídá
  `tests/liveTightenIbkrMark.test.ts`, `tests/manualEntryMarketController.test.ts` (BE).
  Hlídá test: `tests/manualOrderManage.test.ts` (fáze 2c), `tests/liveChartData.test.ts`.
- **Zrychlení posunu SL/TP (30. 10. 2026, oponentura návrhu):** jen `move-stop`
  a `move-target` smí místo REST order grafu předčíst synchronní snímek
  dohnaného streamu adaptéru (`BrokerPort.streamOrderSnapshot`, completeness
  eventual). Adaptér vrací `null` bez syncu, při obměně socketu, rozpracovaném
  rámci nebo command reportu, tichu socketu > 2 heartbeaty, běžícím REST merge
  do map a při rate limitu/penalizaci; aktivní příkaz bez potvrzené verze nebo
  neznámý kontrakt = `null` (nikdy vynechání). Snímek je čistý (žádný zápis do
  `orders`, žádné buzení čekatelů). Controller ho použije jen když pracující
  příkazy symbolu sedí s `liveOrdersByAccount` (tvar, stav, `sourceVersion`)
  a vstup se stavem, který už zpracoval; jinak REST. Před zápisem se navíc
  porovná `routeEpoch` leadera (změna = `not-sent`). **Od 4. 11. 2026 i
  risk-redukční `cancel-entry`** smí použít tentýž přesně shodný snímek pro
  předčtení; obecný controller přijme bez dalšího REST jen jako terminální
  `canceled|filled|rejected` Order přesně rušeného id a účtu, který adaptér
  autoritativně dohnal. Tradovate adaptér tuto zkratku vrací pouze pro přesný
  `Order(Canceled)`; `Filled`/odmítnutí nechává původnímu REST fallbacku, protože
  u partial fillu může raw `Filled` předběhnout Completed cancel report. Chybějící, neterminální nebo neshodné
  potvrzení = původní přesný REST lookup; fill dál spouští kontrolu ochranných
  nohou a nikdy se nevydává za „zrušeno“. **Od 2. 11. 2026 i `close-position`** bere pre-read ze snímku
  (jen kontrola tvaru před `liquidateposition`; výsledek dál výhradně z REST ověření
  po zavření, INV-MODE-02; audit nese `zápis`, `stream flat` a `ověření rest` ms).
  Vědomě beze změny: `liquidateposition` zruší všechny příkazy kontraktu — cizí příkaz,
  který stream ještě nedohnal, zruší stejně jako dřív s REST pre-readem (závod existoval
  i tehdy). Testy: `tests/manualOrderManage.test.ts` (snímek nesedí → REST, změna route
  epochy → `not-sent`). Snímek nikdy pro ARM, reconcile,
  důkaz flat/no-working ani Flatten. Třetí důkaz úspěchu posunu: potvrzení
  adaptéru z `modifyOrder` (Replaced přesně odeslaného commandu + otevřený
  příkaz v odeslaném tvaru), které controller přijme jen pro stejné id, účet
  leadera, typ, qty a novou cenu; do cache controlleru ani read modelu se
  nezapisuje. Audit nese časy (`[čtení stream|rest … · zápis … · ověření …]`).
  Bez `routeEpoch` (broker bez routeru) se snímek nepoužije. Známá cena: token
  nebo rate limit, který selže až u zápisu (dřív u REST předčtení jako
  `read-failed`), skončí `unknown` místo `blocked` — fail-closed, dořeší čtení.
  Hlídá test: `tests/manualOrderManage.test.ts` (zrychlení posunu),
  `tests/tradovateConfirmedOrderVersions.test.ts` (snímek streamu).
- **OrderVersion hydratace nesmí zadržet následující Fill za pomalejším REST
  (4. 11. 2026):** `/orderVersion/deps` dál začíná při přijetí Order/ExecutionReport
  rámce a zůstává autoritativním fallbackem. Serializované zpracování socket frame se
  nikdy nepřeskakuje a žádný budoucí tvar se neaplikuje předčasně. Starší rámec smí
  přestat čekat na REST pouze tehdy, když ve stejném nebo přesně následujícím již
  přijatém rámci je `OrderVersion` stejného orderu s dostatečným version ID a zároveň
  je první relevantní entitou tohoto orderu v daném rámci. Skutečnou verzi pak v
  pořadí aplikuje až její vlastní socket frame. Fill/Order/Command před verzí, verze
  v pozdějším rámci, chybějící verze nebo konec socketu vždy ponechá původní REST
  cestu. Zavření a nové připojení maže všechny staged verze i čekatele. Regrese:
  `tests/tradovateSpeed11b.test.ts` (rychlá socket cesta, pomalý REST po ní nesmí
  přepsat stav, Fill před verzí nesmí odblokovat starší Order).
- **Graf (30. 10. 2026):** živá pozice leadera ve štítcích jako návrh
  (`lib/liveChartOrderLines.ts`). Tah SL/TP = okamžité `move-*` po puštění (mrtvá
  zóna 4 px), `expect` = cena při chycení čáry (změna během tahu = nic se nepošle);
  BE a × čekajícího vstupu jedním klikem (od 5. 11., INV-UI-01). Jen jedna
  změna naráz; „odesílám“ drží do výsledku. Notifikace vlevo dole
  (`components/LiveTradeToasts.tsx`) jsou jen zobrazení `recentCopyEvents`; tečky
  nejsou důkaz kopie (zelené jen za zapnuté kopírky). Hlídá test:
  `tests/liveChartOrderLines.test.ts`, `tests/liveTradeToasts.test.ts`.
- **Fáze 2d — zavřít obchod leadera z grafu (30. 10. 2026):** `close-position` =
  `liquidatePosition` leadera (Tradovate zruší nohy +0,3 s, pak Market), kopírka
  zrcadlí zrušení nohou a exit. Jen ARMED ∧ ¬shadow ∧ ¬kill, čistý tvar, „co jsem
  viděl“ = SL leadera + |pozice|, `closeReachBlockers` (obě nohy dosažitelné,
  follower s pozicí mimo exit sadu = blocked, ingress, běžící Flatten). Synchronně
  před zápisem fence, generation, žádný jiný zápis na leaderovi; zápis registrovaný
  jako rozpracovaný (Flatten leadera vynechá a ohlásí nejasný zápis — žádná druhá
  likvidace). Výsledek jen ze stavu u brokera (čekání na stream ≤ 2 s, pak REST čtení,
  při rozporu se streamem opakované do ~4 s): flat ∧ nic nepracuje =
  `acknowledged`; pozice bez SL/TP = incident bez auto-close (ve všech větvích i při
  dořešení); `already-flat` / flat při dořešení = `waived` (kauzalitu netvrdit).
  Brzda zavření zneplatní (relay supersede, agent `brake-after-request`), TTL 5 s.
  UI: × u pozice, zrušení čekajícího vstupu i BE jedním kliknutím (Filip 30. 10. a 5. 11.).
  Market: SL/TP jedou s cenou (i SL z position boxu).
  Hlídá test: `tests/manualOrderManage.test.ts` (fáze 2d).
- - **Vlastní OSO se nikdy nekopíruje bez nohou** (`flushStandaloneOsoEntry`):
  časovač ani fill před nohami ho neflushnou, čeká se nejvýš 5 s, pak
  failClosed + cílené zrušení. Cílené zrušení (`cancelOwnManualEntry`) jen
  id z vlastního záznamu na leaderu, raw broker mimo frontu, jeden pokus
  s durable stavem, smí i za DISARMED/kill, vyplněný vstup se neruší.
- **Nativní Market, strop skupiny a jen MNQ (2. 11. 2026, oponentura
  copier-design-critic):** `place-leader-entry` zná `orderType: 'Market'` bez
  `price` (povinné `referencePrice` + `quoteReceivedAt`, viz INV-UI-04); broker
  dostane `placeoso` s Market rodičem. Capability `manual-entry-market-v1`
  inzeruje worker jen pro manual-only skupinu; bez ní UI Market neodešle
  (žádný převod na Limit). Market a brzda: ACK za DISARMED Market neruší
  (je vyplněný) — `acknowledged` + incident; neznámý výsledek Marketu =
  incident (DISARM, lastError), nikdy opakování. Broker odmítl SL/TP nohu
  přijatého ručního vstupu = incident bez auto-close. Strop kontraktů
  `group.manualEntryMaxContracts` (1–5) smí mít jen manual-only local-only
  skupina, nastavuje ho jen installer (`--manual-entry-max-contracts`),
  pilot ho při startu vždy přepíše instalační hodnotou, vzdálená změna
  skupiny ho nepřevezme a cloudová knihovna ho neukládá; jinak 1.
  Ruční vstup jen MNQ (`LEADER_ENTRY_SYMBOL_PATTERN`) na klientu, relayi i ve
  workeru; správa existujících obchodů (`manage-leader-order`) NQ dál smí
  (risk-redukční). Měření: `timing` v záznamu (fronta, start, POST, ACK)
  a v paměti přesný návrat durable commitu + stream (Order, vyplnění, Fill +
  průměr, Position), jen zobrazení. `committedAt` se nastavuje až po úspěšném
  návratu stávajícího commitu; nevytváří další zápis ani neovlivňuje příkaz.
- **Holý Market a doplnění SL/TP z telefonu (2. 11. 2026, rozhodnutí Filipa
  „pilulka koupí/prodá market ihned bez SL/TP, je to fakt objednávka“, oponentura
  copier-design-critic):** jen manual-only DEMO skupina (`market-manual-only`,
  capability `manual-entry-bare-v1`). `place-leader-entry` Market bez obou nohou
  (jen jedna noha = neplatný payload) → worker pošle jediný Market `placeOrder`,
  záznam `bare: true`; pozice je VĚDOMĚ bez ochrany (ztráta otevřené pozice nemá
  strop kromě Flattenu / vypršení ARM; day lock až po flat). Stejné brány jako
  Market (kontrakt + čerstvá cena IBKR, posun, strop, flat, ARMED). Nohy doplní
  `manage-leader-order` `attach-brackets` (`stopLoss` + `takeProfit`): jen vlastní
  přijatý holý vstup bez nohou, REST (fresh, s limitem) plně vyplněný vstup,
  pozice = qty na správné straně, na symbolu nic nepracuje, fence fronty; nohy
  ≥ 8 ticků od čerstvé ceny IBKR na správné straně; riziko attach NIKDY
  neblokuje (snižuje ho). Snižuje riziko, proto smí i za DISARMED/kill a agent ho
  nechá projít po brzdě (jako `cancel-entry`). Těsně před POSTem synchronně:
  žádný běžící Flatten, jiný zápis na leaderovi, nové eventy, fence a pozice
  ze streamu; zápis je registrovaný (Flatten ho vidí jako rozpracovaný). Po ACK
  se pozice vždy autoritativně přečte: prokazatelně flat = obě nohy se cíleně
  zruší + incident; neověřeno = jen incident (nohy zůstávají, pozice může trvat).
  Výjimka bez incidentu (5. 11. 2026): právě jedna noha vyplněná na celý počet, druhá
  skončila bez fillu a až potom dvojí ověření flat (`leaderVerifiedFlat`); nohy se ruší hned,
  důkaz má společný limit a po tu dobu je registrovaný jako rozpracovaný zápis. Štítky „+ SL“ / „+ TP“
  na čáře holé pozice jen připravují návrh; příkaz je týž `attach-brackets` po kliku přes `liveAttachIntent`.
  **SL a TP po jedné (6. 11. 2026, capability `manual-order-single-leg-v1`, `docs/reviews/instant-legs-design-20261106.md`):**
  se starým workerem platí věta výše. Nový worker v sólo skupině: záznam `bare: true` s 0, 1 nebo 2 id; `add-leg`, `remove-leg`
  a posun jediné nohy odejdou hned po puštění čipu nebo čáry. Filip vědomě přijal, že × na SL nechá pozici bez stropu ztráty.
  SL → SL + TP: nejdřív OCO se stejným SL, potom zrušit starý SL (krátce dva SL, starý ≥ 8 ticků od trhu; zrušení proběhne vždy,
  i na flat a po brzdě). TP → SL + TP: nejdřív zrušit TP, potom OCO (při flat, Flattenu a změně kopírky se OCO neposílá).
  Za brzdy jde jen přidání SL k pozici bez nohou; `remove-leg` a `add-leg` TP supersede brzda a zastaví je i worker (výjimka v INV-BRAKE-02 není).
  Do okna korelátoru po fillu vrací `fill-settling`. Vlastní noha na flat účtu (zavření mimo appku) = jen incident po 3 s, bez zrušení, a jen za běžícího
  workeru: Filip obchoduje jen z appky a riziko přijal. Přikoupení k pozici s jednou nohou zůstává blokované.
  Výsledek přijato / neznámo nabídku na 30 s schová (panel, čára i telefon).
  Attach jen k NEJNOVĚJŠÍMU ručnímu vstupu, dokud leader na symbolu od jeho
  fillu nezplochl (`closedAt`, status `open`) — starý záznam nesmí „adoptovat“
  cizí pozici. Flatten v telefonu jde stejným zámkem skupiny jako Dashboard
  a nečeká na rozpracovaný vstup/attach. Flatten při rozběhnutém attach leadera
  vynechá jako nejasný zápis (precedent zavření z grafu); relay strop/rozestup
  se pro attach nemění; zápisy ručního vstupu nejdou přes `dispatchBroker`
  (INV-WORKER-02 dál otevřený). Úspěch zapíše id nohou do záznamu vstupu → dál běžný
  spravovaný obchod (posun SL/TP, BE, ×). `unknown` attach / restart v `sending`
  = incident, automaticky se nedořešuje (Flatten + auditovaný waiver). Zavření
  holé pozice = `close-position` holého záznamu (jen sólo skupina, výsledek stavem;
  C8 níže, od 3. 11. 2026); Flatten skupiny (jediný DEMO účet) zůstává záloha na
  Dashboardu a v telefonní liště.
  Telefon (`components/day/LivePhoneChart.tsx`, `lib/livePhoneOrders.ts`) posílá
  přes stejný desk callback, relay a admission jako PC; odeslat jen nad čerstvým
  neobnoveným stavem, zapnutou kopírkou, bez rozpracovaného vstupu a mimo
  přehrávání; zámek jednoho příkazu naráz. „Zrušit“ čekajícího vstupu v liště
  pozice (`cancel-entry`, ne Flatten) jde přes sdílený zámek čar a listu správy
  (`LivePhoneLiveActions.tsx:createLivePhoneBarClose` + `lineState.busyRef`; od 4. 11. 2026 je to
  tentýž ref jako zámek desku `liveCommandLockRef` — i pro vstup, attach a Dashboard), takže
  souběžně s × / BE / posunem z čáry neodejde druhý příkaz; Flatten pozice zůstává
  mimo zámek i mimo `busy` (INV-UI-02). OFF/Kill/Flatten celé skupiny zůstávají na Live
  Dashboardu (Filip: žádná nouzová lišta na telefonním grafu; INV-UI-02 se plní
  navigací LIVE ▾ → Live Dashboard). Posun SL dál od trhu v manual-only skupině
  počítá s lokálním denním stropem jako náhled (dřív `risk-unknown`).
  Hlídá test: `tests/manualEntryBareAttach.test.ts`, `tests/livePhoneOrders.test.ts`.
- **× zavřít holý Market bez SL/TP (C8, 3. 11. 2026, `docs/reviews/trading-gaps-designs/safety.md`,
  oponentura copier-design-critic):** payload beze změny — `manage-leader-order` `close-position`
  s `entryOperationId` holého záznamu a `expect = { price: referencePrice, quantity }`
  (`lib/manualBareClose.ts:bareCloseManageFields`). Jen **sólo skupina** (`soloManualGroup`:
  manual-only ∧ local-only ∧ bez followerů ∧ DEMO; smazaná skupina nikdy), capability
  `manual-order-close-bare-v1` (worker ji inzeruje jen když `manualBareCloseEnabled()`);
  starý worker stejný payload odmítne `not-own-entry` (`resolveManagedTrade` chce obě nohy)
  a nic neodešle. Status `bareLeaderTrade` (nejnovější, acknowledged, holý, bez nohou,
  otevřený) je jen výběr pro UI (INV-UI-01/03).
  - **Jen ARMED ∧ ¬shadow ∧ ¬kill** (jako dnešní × fáze 2d) — ve frontě (`not-armed`) i
    synchronně před zápisem. C8 tedy NENÍ výjimkou z INV-DEFAULT-01, INV-BRAKE-02 ani
    INV-ARM-04; za DISARMED až s C9 (výjimka se pak zapíše uzavřeným seznamem). Relay
    supersede brzdou, agent `brake-after-request`, TTL 5 s a výjimka z denního stropu beze změny.
  - **„Co jsem viděl“ = počet kontraktů** (oponentura P3): `expect.price` = `referencePrice`
    záznamu je konstanta a zastaralé zobrazení nezachytí. Vlastnictví pozice dokládají
    VÝHRADNĚ kontroly ve workeru: vlastní přijatý holý záznam bez nohou, NEJNOVĚJŠÍ ruční vstup
    a `closedAt == null` (starý záznam nesmí „adoptovat“ cizí pozici), vstup v aktuální session
    (čerstvý REST graf příkazů) vyplněný přesně na qty, |net| = qty na správné straně, **otevřený
    lot deníku dne obsahuje fill vstupu a jeho pozice = očekávaná se znaménkem**
    (`bareCloseLotBlockers`, `entry-not-open`; oponentura C8 P3: Tradovate umí obrat +2 → −2 → +2
    jedním fillem bez eventu net 0, `closedAt` se pak nenastaví — lot vstupu se ale uzavře a nový
    nemá jeho id; chybějící lot = jiná session / obchod před startem počítadla = taky blokováno,
    zavři Flattenem) a na symbolu NIC nepracuje (REST i cache streamu, včetně typu, který appka
    nezná — INV-TRAD-07; cizí příkaz se bez souhlasu neruší → `other-orders`, zavři Flattenem).
    Z pozice samotné se vlastnictví nikdy neodvozuje (INV-PART-03).
  - Ve frontě (`prepareBareClose`, vzor attach): nic nevyřešeného u záznamu ani pozice
    (`manage-unresolved`), žádný nevyřešený ruční vstup, žádný běžící Flatten, ingress leadera 0,
    ohraničené čerstvé REST čtení příkazů i pozic (3 s, snímek streamu ne), fence fronty,
    tvar, durable `safety.manualOrderActions` `sending` (INV-OUTBOX-01).
  - Mimo frontu `executeClose` s `managed: null`: synchronně ARM/shadow/kill, generace + fence,
    Flatten, jiný zápis na leaderovi, ingress a z cache „na symbolu nic nepracuje ∧ stream net =
    qty“ (místo `legsLive`); jinak `not-sent`. `closeReachBlockers` se u holé pozice VĚDOMĚ
    přeskočí celé — přesně (oprava textu po oponentuře C8): ARM/shadow/kill a běžící Flatten se
    kontrolují zvlášť (výše); `sequenceBroken` / `needsReconciliation` za ARMED bez DISARM nenastane
    (odpojení, failClosed i Flatten nejdřív odzbrojí a zvednou generaci — zachytí brána ARM
    a generace), proto se do holé větve nepřidávají (stav by nešel ani otestovat); stuck outbox,
    divergence, čekající kopie vstupu, vyřazení followera, nenamapovaní followeři, jejich pozice,
    exit sada a ingress followerů jsou jen o followerech — sólo skupina je nemá. Raw
    `liquidatePosition` jeden pokus, registrovaný jako rozpracovaný zápis (Flatten leadera
    vynechá jako nejasný zápis — druhá likvidace nevznikne). Flatten běžící už před × zastaví
    × dvakrát: odzbrojí (`not-armed`) a `busy`.
  - Výsledek jen stavem u brokera (INV-MODE-02): flat ∧ nic nepracuje = `acknowledged`
    a `closedAt` záznamu zapíše worker sám (nečeká na stream); `already-flat` / flat při
    odmítnutí = `waived` „ne tímto příkazem“ (kauzalita se netvrdí) + `closedAt`; pozice trvá po
    timeoutu / výjimce / indeterminate / potvrzeném zápisu = `unknown` + incident „holá pozice N
    trvá, zavření nepotvrzeno“ bez auto-close (INV-DEFAULT-02); **pozice trvá po DEFINITIVNÍM
    odmítnutí = incident, ale záznam `rejected`** (broker nic neprovedl; oponentura C8 P3) — `rejected`
    neblokuje doplnění SL/TP, jedinou risk-redukční akci, která smí i za DISARMED. Flat po timeoutu /
    indeterminate = `unknown` bez incidentu. `unknown` (i restart v `sending`) dořeší jen čtení
    pozice: trvá = incident, flat = `waived` + `closedAt`; do té doby blokuje další × i attach
    téhož záznamu (`manage-unresolved`). **Dořešení nevyhlásí incident o cizí pozici**
    (`bareCloseSuperseded`, oponentura C8 P3): když stream holý záznam mezitím uzavřel (`closedAt`)
    nebo ho nahradil novější ruční vstup, který došel k brokerovi a není přikoupení (prošel branou
    z flat), = `waived` „současná pozice patří jinému vstupu“ bez čtení a bez incidentu — **ale jen
    když surový liquidate této operace už doběhl** (`manageWritesInFlight`; oponentura kolo 3, P3):
    jinak rozhodne čtení navázané na konec zápisu, protože pozdě doběhnutý liquidate by zavřel
    i současnou pozici. Nikdy opakování.
  - **Nový ruční vstup se nepustí, dokud na leaderovi běží surový zápis** (`inFlightBrokerWritesByAccount`:
    × liquidate, doplnění SL/TP; kolo 3, P3) — `leader-write-in-flight`, brána ve frontě (bez záznamu)
    i synchronně těsně před POST (`not-sent`). Po timeoutu × tak liquidate nemůže tiše zavřít nový
    vstup. Nový vstup během `unknown` zavření s už doběhlým zápisem se neblokuje (řeší
    `bareCloseSuperseded`).
  - Dořešení čtením, které najde holou pozici trvající, vyhlásí incident i za DISARMED
    (`recordWhenDisarmed`, kolo 3 — výhrada C8 č. 6; worker po restartu startuje DISARMED). Restart
    v `sending` sám incident nevyhlásí: flat / cizí pozice by byly falešný incident; výsledek
    neznámý hlásí push záznamu `unknown`.
  - Vědomě beze změny (jako 2d): cizí příkaz, který vznikne až po synchronní kontrole a před
    zpracováním liquidate u brokera, liquidate zruší.
  Hlídá test: `tests/manualEntryBareClose.test.ts` (mutačně ověřeno 18 pravidel; po oponentuře
  dalších 12: timeout s pozicí / flat, výjimka, indeterminate, odmítnutí s pozicí / flat, `unknown`
  blokuje attach, nejnovější záznam v controlleru, obrat přes nulu, Flatten před ×, `scope:
  'position'`, dořešení po novém vstupu / `closedAt`; kolo 3 mutačně dalších 4: zkratka až po konci zápisu,
  nový vstup během zápisu ve frontě i před POST, incident za DISARMED po restartu),
  `tests/localCopierExecutionAgent.test.ts` (capability).
  - **UI (4. 11. 2026, `lib/liveBareCloseUi.ts`, `hooks/liveCommandRuns.ts:createLiveBareCloseRun`):**
    nabídka `liveBareCloseOffer` = jen zobrazení (INV-UI-01/03): capability, `bareLeaderTrade`,
    žádný spravovatelný obchod s nohami na grafu a pozice leadera skupiny workeru, která PŘESNĚ
    sedí s Marketem (kontrakt, strana, počet, ne čekající) — neznámá / nesedící pozice = žádné ×
    (unknown ≠ flat, zůstává Flatten). Neaktivní s důvodem nad zastaralým / obnoveným statusem,
    bez relaye a mimo ARMED ∧ ¬shadow ∧ ¬kill. PC: × na čáře vstupu (id čáry nese
    `entryOperationId`), Shift+X tutéž čáru a panel (sekce „Přidat SL/TP“)
    TOUŽ funkcí obrazovky `closeBare`; telefon: „Zavřít“ v liště pozice vedle „Flatten“ (klíč
    akce + `entryOperationId`, jen mimo přehrávání; záložní tlačítko u holé pozice se VŽDY jmenuje
    „Flatten“, i bez nabídky a při přehrávání — „Zavřít“ znamená jen C8). JEDEN zámek jednoho
    příkazu desku `liveCommandLockRef` (oponentura UI kolo 1): PC čáry, Shift+E/X/C, panel (vstup
    velkým tlačítkem i Náhled → Odeslat, „Přidat SL/TP“, × holé pozice — `runWithCommandLock`),
    lišta „Zrušit čekající“ a Dashboard; telefon dostane týž ref mostem (`commandLockRef`) pro čáry,
    lištu pozice, list správy, vstup, attach i čip C7. Flatten, OFF a Kill mimo zámek. VĚDOMÝ
    dopad (oponentura UI kolo 2, P3): zámek drží i běžící vstup z panelu / telefonu (POST zápisu
    a relay až ~35 s) a celou sekvenci C7 (až 10× `cancel-entry`), takže na tomto zařízení mezitím
    neodejde ani akce, která riziko SNIŽUJE (× zavření, posun SL, BE, C8). Cesta, která jde vždy, je
    Flatten (lišta pozice / Flatten All, mimo zámek, INV-UI-02) — text obsazeného zámku to říká
    („… Zavřít jde hned Flattenem“, `LIVE_MANAGE_BUSY_TEXT` / `LIVE_COMMAND_BUSY_TEXT`, Shift+E/X/C
    „… Flattenem (Shift+F)“). Zkrácení zámku C7 (uvolnit po prvním `unknown` / timeoutu) by byla
    změna jádra `cancelOwnPendingEntries` — jen přes critic, zatím ne. Od 5. 11. bez dvoukroku:
    panel, telefonní lišta a C7 jdou přes `lib/liveClickGate.ts:createLiveClickGate` (dvojklik a právě
    změněný klíč nabídky se spolknou, zablokováno = důvod), čáry grafu přes
    `BacktestOrderLinesOverlay:liveLineClick` a `liveLineClickSync`: podpis čar živé pozice (id, akce ×,
    tlačítka, bez ceny a zablokování) po změně spolkne klik na 1 s, i přes stav bez čáry; holá →
    spravovaná, čekající → vyplněno i zmizelé přikoupení, po kterém pod kurzor dojede × pozice.
    Spolknutí změnou nabídky to napíše (`onClickSwallowed`), jen dvojklik je tichý.
    Odeslání = deskový `closeBareLeader` (čistá továrna `lib/liveDeskCommands.ts`): čerstvý status
    + capability + `sameBareTrade` (odejde jen obchod, který uživatel viděl) →
    `buildLeaderOrderManageCommand({ …, ...bareCloseManageFields })` → jediné relay odeslání správy
    `sendLeaderManage` (sdílené se správou, attach a C7).
    Texty `liveBareCloseResultNotice`: ověřeně flat = „zavřena — ověřeno stavem“; `waived` (worker
    hlásí `acknowledged` s „ne tímto příkazem“) = „Leader je flat — ne tímto příkazem“; `rejected`
    = „Broker zavření odmítl… zkontroluj, případně Flatten“; `unknown` i výjimka po odeslání =
    „Neověřeno — zkontroluj Tradovate“, NIKDY „zavřeno“; nic se neopakuje.
    Hlídá test: `tests/liveC7C8Ui.test.ts` (behaviorálně přes čisté továrny a pojistku kliku;
    bezpečnostní větve mutačně ověřil stavitel v kolech oprav oponentury UI 1 a 2 skriptem mimo repo).
- **„Zrušit vše“ = zrušit VLASTNÍ čekající vstupy, nikdy ochranu pozice (C7, 3. 11. 2026,
  `docs/reviews/trading-gaps-designs/safety.md`; oponentura copier-design-critic: návrh OK, diff
  kolo 1 „OPRAVIT PŘED COMMITEM“ → opraveno týž den; kolo 2 „OK S VÝHRADAMI“ (8× P3) → výhrady
  uzavřené týž den; kolo 3 (1× P2, 5× P3) → opraveno týž den, viz níže):**
  žádný nový příkaz ani výjimka — N× existující `manage-leader-order` `cancel-entry`, každý
  s vlastním `operationId`, sekvenčně, výsledek po položkách, nic se automaticky neopakuje
  (`lib/liveCancelPending.ts:cancelOwnPendingEntries`). Capability `manual-order-cancel-pending-v1`
  (worker se správou); bez ní UI nic nenabídne.
  - **Nikdy:** „Zrušit čekající“ neruší ochrannou SL/TP nohu otevřené pozice (zrušení zvětšuje
    riziko — INV-BRAKE-01/02; kdo chce pryč i pozici, má Flatten), cizí příkaz bez stopy appky
    (může to být uživatelův ochranný Stop; duch INV-PART-03 — appka ho jen spočítá a pošle do
    Tradovate / na Flatten) ani částečně vyplněný vstup (INV-TRAD-02: zbytek by šel i s nohami,
    kaskáda NEOVĚŘENÁ → blokováno s kódem `entry-partially-filled` „pozice je otevřená, zavři ji
    Flattenem (× u částečně vyplněné pozice nejde)“ — × chce vstup vyplněný přesně na qty, oponentura
    C7 kolo 2). **Worker to hlídá sám, ne jen výběr pro zobrazení** (oponentura C7 kolo 2,
    `cancelEntryTargetProblem`): cíl `cancel-entry` z přesně shodného synchronizovaného snímku
    (jinak z čerstvého REST) nesmí mít `parentOrderId`, jeho id
    nesmí být id žádné známé ochranné nohy (vlastní záznamy + OSO/bracket outboxy) a u vlastního vstupu
    musí strana i typ sedět se záznamem — jinak `not-entry` a nic se neodešle (chyba mapování ACK
    ani poškozený store nikdy nezruší SL). Kolo 3 (P3, obrana do hloubky): příkaz na OPAČNÉ straně,
    než je otevřená pozice leadera v cache streamu, by ji zmenšil = ochrana (i uživatelův samostatný
    Stop/Limit z Tradovate, který žádný záznam nezná) → taky `not-entry`; přikoupení je vždy na
    stejné straně a běžný vstup jde jen z flat. Automatické zrušení čekajícího vstupu (C12,
    `cancelOwnManualEntry` s `preRead`) dělá tutéž kontrolu nad čerstvým REST čtením
    (`pendingEntryPreReadDecision` → `cancelEntryTargetProblem`; jinak incident, nic se nezruší).
    Mimo rozsah zůstávají ostatní volání `cancelOwnManualEntry` (zrušení vlastního vstupu po ACK /
    `submitted` eventu za DISARMED, chybějící nohy): berou id z právě přijatého ACK bez těchto
    kontrol (hypotetické riziko poškozeného záznamu, NEOVĚŘENO, k posouzení); jejich výsledek se od
    C12 taky ověřuje stavem. Po liquidate nohy zmizí, protože liquidate ruší VŠE na
    kontraktu — to kaskádu rodič → nohy nedokazuje. Odchod pozastavených nohou s rodičem při přímém
    zrušení čekajícího vstupu je **NEOVĚŘENÝ** (hlavně TP přikoupení bez `parentId`; DEMO záznam
    zrušení čekajícího přikoupení chybí) a po čistém zrušení worker nohy nečte — vědomá mezera.
    Zbývající pojistka je jen kontrola nadkrytí přikoupení (`reviewScaleInCoverage`): za ARMED
    incident, za DISARMED jen audit (C7 je dostupné i za DISARMED). Obecné `cancel-order` (starý
    Dashboard) worker i běžící runtime adaptér odmítnou `unsupported-copy-command:cancel-order` bez
    jakéhokoli zápisu; relay ho nepouští.
  - Status `pendingOwnEntries` (`selectOwnPendingEntries`, jen zobrazení INV-UI-01/03) = vlastní
    `acknowledged` Limit/Stop záznam leadera s id vstupu i obou nohou ∩ otevřený příkaz v cache
    streamu s fillem 0, stejného symbolu/strany/typu, bez `parentOrderId` a s id, které není id
    žádné vlastní nohy; bez rozběhnutého zrušení či nevyřešené změny. `pendingCancelContext` jen
    počítá, co zůstává (cizí, ochranné nohy, částečně vyplněné) a proč teď nejde nic
    (nevyřešený ruční vstup). Worker při každém zrušení vše ověří ze synchronizovaného, přesně
    shodného snímku s route fence; při jakékoli nejistotě znovu čerstvým REST čtením.
  - **Výsledek `cancel-entry` jen stavem (od C7, `lib/liveCancelPending.ts:cancelEntryOutcome`):**
    Tradovate adaptér `cancelOrder` vrátí rychlé potvrzení jen po přesném `Order(Canceled)`; vstup,
    který se mezitím vyplnil, broker typicky ODMÍTNE („TooLateToCancel“) a raw `Filled` se za úspěch
    nikdy nevydává. Proto po platném streamovém potvrzení terminální stav přesně tohoto id/účtu, jinak — a po
    definitivním odmítnutí vždy — ohraničené autoritativní `findOrderById` vstupu:
    `canceled` s fillem 0 = `acknowledged` (po odmítnutí `waived` „ne tímto
    příkazem“ — kauzalita se netvrdí); jakýkoli fill = `rejected` s kódem `entry-filled` /
    `entry-partially-filled` (nikdy „zrušeno“, kód je i v durable záznamu `resultCode` a vrací ho
    idempotentní replay); `waived` nese kód ověřený stavem (`canceled-elsewhere` / `entry-ended`)
    a replay ho mapuje na „zrušeno“ JEN s tímto kódem — ruční waiver (`waiveManualEntry`) ani starý
    záznam bez kódu nikdy nejsou „zrušeno“, replay vrátí `unknown` „ověř v Tradovate“ (kolo 2).
    Vstup po odmítnutí dál čeká = nejdřív `unknown` „vstup zatím pracuje — ověřuji“ (REST hned po
    „TooLateToCancel“ nemusí fill ještě ukazovat, kolo 2) a teprve čtení po ustálení (časovač nebo
    konec vstupu ve streamu) rozhodne: dál čeká = `rejected` „vstup dál čeká“, fill = `entry-filled`
    + kontrola nohou; totéž u pozdního odmítnutí po timeoutu. **Odmítnutí se při odkladu uloží do
    záznamu** (`brokerRejection`, kolo 3, P3; v paměti synchronně, durable pro restart) — vstup
    zrušený během ustálení jinak (uživatel v Tradovate) je pak `waived` `canceled-elsewhere` „ne tímto
    příkazem“, nikdy `acknowledged` „zrušení potvrzeno“. Pozdní výsledek zápisu (odmítnutí i „úspěch“)
    přijde dřív, než se zápis uklidí z `manageWritesInFlight`, a plánovaná čtení už mohla proběhnout —
    odklad se proto naváže na konec zápisu (čtení hned po něm), takže záznam nezůstane navždy
    `unknown` (kolo 3, P3). Při konečném fillu se PŘED uložením
    výsledku ohraničeně přečtou obě nohy: chrání jen PŘESNĚ — obě `working`, otevřené qty = fill,
    opačná strana, stejný symbol (`legsProtectionProblem`; přerostlá noha by po vyplnění otočila
    pozici); noha `pending` (Suspended hned po fillu) se v rozpočtu ověření přečte znovu. Od C12 kola 5
    (P2) navíc pozice leadera musí fill krýt (`fillPositionProblem`: znaménko strany vstupu, |net| ≥ fill;
    cache bez ingress, jinak dvě po sobě jdoucí REST čtení) — vstup, jehož pozici mezitím zavřel ruční
    obchod, má nohy bez pozice → incident, ne „chráněná“ (C7 i C12 sdílí `checkCancelEntryFillProtection`).
    Kontrola běží jednou na operaci a proces a souběžní volající (stream konec vstupu, pozdní výsledek zápisu,
    časovač) čekají na TENTÝŽ běh (`Map` s promise) — konečný výsledek se tak uloží až po kontrole
    i při souběhu; pád mezi = záznam zůstane `unknown` a dořešení po startu kontrolu zopakuje. Než
    se vyhlásí incident, přečte se pozice: leader ověřeně flat a na symbolu nic nepracuje = obchod
    mezitím skončil (SL/TP, Flatten). **„Ověřeně flat“ (`leaderVerifiedFlat`, kolo 3, P2):** DVĚ po
    sobě jdoucí čtení shodně net 0 a working 0 (`listPositions` adaptéru se přidá k už běžícímu
    `/position/list` — první snímek může být z doby PŘED fillem, zatímco `listOrders(fresh)` je nový;
    druhé čtení začíná až po konci prvního) A stream po zpracování všech přijatých eventů leadera
    (`pendingTradeIngressByAccount` 0) nehlásí na symbolu nenulovou pozici ani otevřený příkaz; jinak
    incident. Pak → jen audit a text „pozice už je zavřená (příčina neověřena)“,
    žádný falešný incident (kód `entry-filled` zůstává — push „Vstup se vyplnil během rušení“ je
    pravdivý); jinak (pozice trvá, osiřelá noha pracuje, nečitelné) incident bez auto-close
    (INV-DEFAULT-02). Nečitelné = `unknown` + dořešení jen čtením; `unknown`, u kterého vstup po
    ustálení (`settle`) dál pracuje (zrušení k brokerovi nedorazilo, restart v `sending`), =
    `rejected` „zrušení se neprojevilo“ — vstup se znovu nabídne, nic se automaticky neopakuje.
    Stream konec vstupu jen spustí totéž čtení (Order(Canceled) může předběhnout Fill). Vyplnění mezi
    zobrazením a příkazem = blokováno s kódem `entry-filled` „pozice je otevřená; nic se nezrušilo“.
    Zrušení přikoupení během běžící změny celé pozice = `busy` (oponentura C17, P2), po změně celé
    pozice s neznámým výsledkem = `manage-unresolved`.
  - UI (`cancelOwnPendingEntries`): výjimka relaye „neodesláno“ jen u prokazatelně neodeslaných vzorů
    (`CANCEL_PENDING_NOT_SENT_PATTERN`, stejné jako `LiveTradingScreen`), jinak „výsledek neznámý“.
    Status `manualOrderActions[].resultCode` nese kód vyplnění; push watchdogu pak hlásí „Vstup se
    vyplnil během rušení“, nikdy „vstup dál čeká“ (`server/copierIncidentWatchdog.ts`); u „pozice už
    je zavřená“ radí „Ověř v Tradovate“, ne „Zkontroluj SL/TP“; `unknown` zrušení mladší než 20 s
    (čeká na ustálení) se zatím nehlásí, aby „výsledek neznámý“ nepředběhl konečný výsledek; důvod
    s koncovou tečkou bez „..“ (kolo 3). Dashboard
    „Zrušit příkaz“ (`dashboardCancelTarget`) má stejné brány jako tlačítko: čerstvý neobnovený
    status a relay (INV-FRESH-03, INV-UI-01/02; kolo 2).
  - **UI (4. 11. 2026, `lib/liveCancelPendingUi.ts`, `components/LivePendingCancel.tsx`,
    `hooks/liveCommandRuns.ts:createLiveCancelPendingRun`):** tlačítko „Zrušit čekající (N)“ jen když
    `cancelPendingAvailability` říká `show` (PC lišta pod grafem vedle Flatten All, od 5. 11. jen v nouzových stavech lišty; telefon čip nad
    grafem); neaktivní s důvodem nad zastaralým / obnoveným statusem, bez relaye, při blokaci workeru
    a během přehrávání. První klik odesílá (od 5. 11.; klíč = `cancelPendingConfirmKey` přesně zobrazené
    sady, vyplnění / nový vstup do 1 s před klikem = nic a hláška, dvojklik nic dalšího).
    `cancelPendingConfirmStep` jádra se v UI NEPOUŽÍVÁ (rychlý klik neposouvá kotvu — trojklik
    0/200/400 ms by potvrdil); test hlídá, že ho žádný runtime soubor neimportuje, sjednocení nebo
    odstranění exportu je samostatná změna jádra přes critic. Text potvrzení `cancelPendingConfirmText`
    (kolik a čeho, co zůstává) přes `liveCancelPendingConfirmText`: kontext ze statusu, který je, ale
    není objekt (pole, text), = zamčeno „Stav čekajících příkazů nejde přečíst — zruš v Tradovate nebo
    Flatten.“ (fail-closed, i Dashboard); nečitelný / chybějící počet = `null` a text přidá „Co zůstává
    (…), nejde ověřit“ — nikdy se neukáže jako „nic nezůstává“ (INV-UI-01 unknown ≠ 0, INV-DEFAULT-02;
    kolo 2). Telefonní čip se schová jen když tutéž jedinou položku cíleně ruší „Zrušit“ lišty pozice
    (most má `manage` a čekající příkaz lišty sedí kontraktem, stranou, počtem i cenou —
    `livePhoneCancelPendingChipShown`); jinak by lišta spustila Flatten a cílené C7 by na grafu
    chybělo (kolo 2). Sdílený zámek jednoho příkazu = `liveCommandLockRef` desku (PC čáry,
    zkratky, panel, lišta; telefon mostem `commandLockRef`; Dashboard), Flatten mimo zámek; sekvence
    drží zámek celou dobu — na zařízení mezitím neodejde × / posun SL / BE ani vstup (vědomě, viz C8
    UI výše; zbývá Flatten). Desk
    `cancelPendingEntries` (`lib/liveDeskCommands.ts`): čerstvý status + capability +
    `cancelPendingSeenProblem` (každá potvrzená položka pořád v čerstvém statusu se stejným id, cenou
    a počtem) → `cancelOwnPendingEntries` přes `sendLeaderManage` s trasou relaye zachycenou JEDNOU před
    sekvencí (INV-TRAD-06, INV-RELAY-01): změna trasy uprostřed = zbytek „Neodesláno“, nic na jinou
    trasu; výsledek po položkách `cancelPendingSummary` (fill nikdy „zrušeno“), ukáže se i když
    nabídka mezitím zmizela (status dřív než ACK). Dashboard: nefunkční `cancel-order` nahrazeno
    `dashboardOrderCancelView` → `dashboardCancelTarget` (jen vlastní čekající vstup leadera skupiny
    workeru, jedním klikem, týž zámek); `blockedReason` workeru zamkne i Dashboard (jako lištu); skupina,
    kterou worker neřídí, má vlastní text („Zrušit jde jen u skupiny, kterou řídí worker“); starý
    worker bez capability, SL/TP noha, follower, cizí příkaz i neověřený stav = tlačítko zamčené
    s vysvětlením; přehled `cancel-order` už nikdy nesestaví. Hlídá test: `tests/liveC7C8Ui.test.ts`
    (behaviorálně; bezpečnostní větve mutačně ověřil stavitel v kolech oprav oponentury UI 1 a 2 skriptem mimo repo).
  Hlídá test (kolo 1 mutačně 16 mutací, kolo 2 dalších 20, kolo 3 dalších 15):
  `tests/liveCancelPending.test.ts` (odmítnutí inline i pozdě, dvojí zrušení, přerostlé nohy, pořadí
  kontrola→záznam i při souběhu, odmítnutí s REST „working“, restart v `sending`, replay po waiveru,
  flat po fillu, noha `pending`, cíl = noha, texty částečné pozice, Dashboard brány; kolo 3: zastaralé
  první čtení pozic, stream s pozicí / pracující nohou, odmítnutí v záznamu inline / pozdě / po
  restartu, pozdní odmítnutí i „úspěch“ po obou čteních, ochrana z opačné pozice), `tests/manualOrderManage.test.ts`
  (`entry-filled`), `tests/manualScaleInReplay.test.ts` (`busy`, `manage-unresolved`),
  `tests/copierIncidentWatchdog.test.ts` (push), `tests/localCopierExecutionAgent.test.ts`
  a `tests/copierRuntimeCommandAdapter.test.ts` (capability, odmítnutí `cancel-order`).
- **Čáry obchodu na telefonu — napojení dat (2. 11. 2026):** `phoneTrade` dostává
  `manage`/`closeSupported`/`entryAvg` z `livePhoneManageFields` = výrazy PC grafu (capability
  + jediný vlastní obchod; × jen za dostupného runtime, zapnuté kopírky a ne shadow; BE průměr
  jen ze stavu pollu). Pojistky utažení SL a BE berou souhrn s kotací IBKR (`guardAt` →
  `withIbkrTightenMark`, jako PC `guardSummaryAt`), vyhodnocený znovu v okamžiku akce.
  × jde prvním klepnutím; čekající vstup vyplněný do 1 s před klepnutím se spolkne (`liveLineClick`),
  takže nezavře pozici místo zrušení vstupu (PC i telefon). Testy: `tests/livePhoneOrderLinesBehavior.test.ts`, `tests/livePhoneOrders.test.ts`.
- **Šipky plnění v LIVE grafu (2. 11. 2026, jen zobrazení):** controller drží v paměti kruh
  plnění leadera aktuální epizody (`services/copierLeaderDisplayFills.ts`, max 40), plněný
  synchronně v try/catch hned po `preclassifyLeaderFillExposure` z jeho rozdělení vstup/výstup;
  nic durable, risk/ledger/příkazy ho nečtou. Neúplná řada = `gap` (neznámá pozice, pozice 0
  s redukující částí, neplatný čas, výpadek spojení, resync `gapFills` — INV-TRAD-01);
  reset při změně leadera a přelomu seance; status pole v try/catch (`null`). Web
  (`liveFillMarkersFromStatus`): jen čerstvý neobnovený stav, expozice ≤ 8 s, `connected`,
  epizoda `fromFlat` bez mezery, `open` z expozice leadera (nesoulad znaménka = skryto, ne
  flat); jakmile je kterékoli plnění epizody v deníku, kreslí ji deník celou. Kanál expozice
  pole v1 neposílá (telefon ho nečte); neplatné pole zprávu nikdy nezahodí. `phoneFills` nikdy
  nejde do `phoneTrade` ani relay (statický test). Testy: `tests/copierLeaderDisplayFills.test.ts`,
  `tests/liveFillMarkersFromStatus.test.ts`.
- **Čáry obchodu na telefonu (2. 11. 2026, UI; data napojí další session):**
  `components/day/LivePhoneOrderLines.tsx` kreslí štítky jako PC
  (`BacktestOrderLinesOverlay` + `livePositionChartLines`) se stejným ošetřením
  (startLine = „co jsem viděl“, `liveLineMoveBlockReason`, `liveBreakEven`).
  Na telefonu se čára nejdřív klepnutím vybere a teprve vybraná jde táhnout,
  tah drží v ploše grafu (`selectToDrag`, PC beze změny); × (zavřít pozici
  i zrušit vstup) jde od 5. 11. i na telefonu prvním klepnutím (INV-UI-01).
  Akce jdou jen přes volitelné `LivePhoneTradeBridge.manage` = deskový
  `manageLeaderEntry`, předané jen za stejných podmínek jako PC
  (`supportsCopierManualOrderManage && ownManualEntry`); bez něj jsou čáry jen
  zobrazení. Zámek jednoho příkazu a „odesílám“ žijí v rodiči
  (`useLivePhoneLineState`), aby přežily odpojení vrstvy. Ve dvou oknech (U3,
  3. 11. 2026) kreslí každé okno vlastní vrstvu (`paneLayer`) se svým API grafu:
  štítky, BE, ×, tah SL/TP, čáry návrhu, pracující příkazy a ✎ správy v měřítku
  toho okna; zámek jednoho příkazu (`lineState`) je společný, plusko jen v aktivním
  okně, skryté okno (druhé maximalizované) nekreslí nic. Při přehrávání žádné
  ovládání ani odeslání (čáry, návrh, plusko, list objednávky i správy, lišta
  Koupit/Prodat, lišta návrhu) — jen štítek živé pozice a cesta zpět na živo;
  Zavřít a Přidat SL/TP v liště pozice zůstávají (snižují riziko). Plusko u crosshairu volí typ příkazu ze čerstvé kotace
  (`clickedOrderType`, ≤ 3 s) a otevírá stejný list objednávky; odeslání z listu
  (i z position boxu) znovu odmítne limit/stop, který je proti čerstvé kotaci
  už na druhé straně trhu. Karty vlevo dole = `LiveTradeToasts` z týchž událostí
  kopírky jako PC; problémové (sticky) karty nic nevytlačí (`keepStickyToasts`).
  Hlídá test: `tests/priceAlerts.test.ts`, `tests/livePhoneTrade.test.ts`.
- **Obchodování z PC grafu — UI vlna B (3. 11. 2026, `docs/reviews/trading-gaps-20261103.md`,
  oponentura copier-design-critic):** jádro, relay ani worker se nemění; všechno jde přes
  stávající desk callbacky (`placeLeaderEntry`, `manageLeaderEntry`, `attachBrackets`,
  `runStaticSafetyAction`), které bez `armStatusRef.fresh` hodí „nic se neodeslalo“.
  - **Klávesy PC (U1):** opt-in (výchozí vypnuto, `at:live:hotkeys`). Shift+B/S jen návrh
    v panelu jako ⚡ (Market jen s capability a kotací ≤ 3 s, jinak Limit ±10 b; SL/TP
    z výchozí šablony ★) a fokus pryč z panelu (`liveReleaseTicketFocus`); Esc zahodí
    návrh jen při nečinném kreslení; Shift+E/X/C prvním stiskem (od 5. 11.; rychlý dvojstisk s klíčem
    akce + čára + cena nic dalšího nepošle) TOUŽ funkcí jako BE / × na čáře
    (Shift+X jen když × nabízí čára); Shift+F jen dialog Flatten All (INV-UI-02). Zkratky mlčí
    při `repeat`, IME, Meta/Ctrl/Alt, fokusu v poli / editoru / dialogu, otevřeném dialogu
    nebo menu, odchodu z grafu, skryté stránce a během přehrávání (kromě Flatten dialogu,
    nápovědy a zahození návrhu). **Žádná klávesa neodešle vstup:** globální Enter není,
    odesílací tlačítka panelu po kliku pouští fokus (`event.currentTarget.blur()`), takže
    Enter / mezerník po zkratce nepošle vyměněný návrh.
  - **Holý Market z PC panelu (U4):** jen s `manual-entry-bare-v1`, jen skupina (vstup na
    leadera), jen v kontraktech, kontrakt jen z kotace IBKR ≤ 3 s. Výstražné tlačítko
    „MARKET · BEZ SL/TP“, první klik odesílá (od 5. 11.), dvojklik jeden příkaz;
    brána (`liveBareMarketBlockReason`: brána desku, capability, kotace, strop, pozice) se
    vyhodnotí při KAŽDÉM kliku (`liveBareSendClick`); tlačítka Správy po kliku pouští fokus.
    Neověřené čtení pozice (`issue`) i chybějící data = ne flat (`liveTicketBarePosition`,
    unknown ≠ flat), autoritou zůstává worker (`account-not-flat`). Holý Market NIKDY přes
    Náhled → Odeslat (Náhled ho jen zkontroluje); ostatní vstupy z Náhledu prvním klikem,
    čerstvost náhledu (≤ 15 s)
    a brána panelu při kliku (`livePreviewPlaceClick`). Velké tlačítko běžného vstupu
    zůstává jedním klikem (Filip 30. 10.).
  - **„Přidat SL/TP“ z PC (U4):** jen s capability, `onAttachBrackets` a vlastním holým
    vstupem (`newestOpenBareEntry`); záměr `liveAttachIntent` se skládá při kliku (kotace
    IBKR téhož kontraktu ≤ 3 s, pozice = holý vstup, nohy ≥ 8 ticků na správné straně);
    přijatý nebo neznámý výsledek se neodešle znovu, „nic se neodeslalo“ = Neodesláno
    (jde opravit). Čáry „· přidat“ jen mění nohy v panelu. Předvolby qty a šablony
    (U4/U8) ukládají jen velikost, jednotky a vzdálenosti, nikdy cenu.
  - **Správa číslem a BE varianty (U10, PC panel i telefonní list):** jen záměr pro
    sdílený runner (`useLiveManageRunner`, jeden zámek s čarami grafu; PC jen s runnerem
    a jen u leadera skupiny workeru, `leaderManageBasis`). SL/TP zadané v ceně / bodech /
    ticích / $ od průměru z pollu se převede na absolutní cenu záměru, která je vidět na
    tlačítku („Posunout → X“). Kontrola „cena viděná ≥ 350 ms“ od 5. 11. odpadla (rozhodnutí
    Filipa): změna průměru pollem těsně před klikem odešle novou cenu z téhož tlačítka, „co jsem
    viděl“ je dál cena nohy a worker ji porovná. Všechno jedním klikem na PC i telefonu.
    BE, BE + n (1–40 t) a BE + odhad poplatků jsou jen jiná cena záměru `move-stop`. **Poplatky jsou ODHAD**
    z poslední sazby brokera (`lib/liveTradeCard.ts:tradeCardFeeRates`: průměrný poplatek
    za kontrakt z posledních ≤ 20 fillů účtu × kusy), ne skutečné poplatky pozice;
    neznámé = tlačítko se nenabízí.
  - **Pojistka přehrávání na PC (U3-PC):** během přehrávání zůstanou jen čáry živé
    pozice pro čtení; návrh a „· přidat“ zmizí, pravý klik ani ⚡ nic nevytvoří, panel
    Objednávka je zavřený a `inert`, zkratky nic nenavrhnou ani nespustí.
  - Pracující příkazy (U5) a šipky plnění na PC (U4) jsou jen zobrazení: vlastní vrstva
    bez ovládání, do příkazů ani do „co jsem viděl“ nevstupují.
  Hlídá test: `tests/liveOrderTicketPanel.test.ts`, `tests/liveChartPcIntegration.test.ts`,
  `tests/liveHotkeys.test.ts`, `tests/liveManagePrices.test.ts`, `tests/livePhoneSheets.test.ts`,
  `tests/livePhoneChartB5.test.ts`, `tests/liveWaveBCriticFixes.test.ts` (mutačně ověřeno).
- Hlídá test (1b): `tests/manualEntryPlace.test.ts`, `tests/leaderEntryPlace.test.ts`,
  `tests/localCopierExecutionAgent.test.ts`, `tests/tradovateCopierCommandRelay.test.ts`.

- **Automatické zrušení čekajícího vstupu (C12, 4. 11. 2026, `docs/reviews/trading-gaps-designs/safety.md`;
  posudek návrhu copier-design-critic „OPRAVIT“ — P1/P2 vyřešené v implementaci, diff čeká na critic):**
  pravidla a mechanismus v INV-BRAKE-01 (nový text). Shrnutí pro ruční vstup:
  - TIF není volba uživatele, payload `place-leader-entry` se nemění; `timeInForce: 'Day'` jako druhá
    pojistka až po záznamu R12 (NEPOSTAVENO); GTC u vstupu ZAMÍTNUTO (vstup by přežil ARM i worker).
  - Náhled nového vstupu blokuje denní pauzu CME `[15:55, 17:00)` CT (`cme-halt`, INV-RISK-04).
  - Ruční `cancel-entry` (C7) a automatické zrušení se navzájem vylučují v jednom synchronním kroku
    (`manualEntryCancelRunning` ↔ `manualCancelEntryInFlight`): běží-li automatické (předčtení,
    durable `sending`, zápis, první ověření), ruční vrátí `entry-canceling` a nic nepošle; běží-li /
    je neznámé ruční, automatika čeká; neúčinné ruční se automaticky neopakuje (incident).
    Oponentura kolo 1 (P2): skončený automatický pokus (selhaný, neúčinný, neověřený) ruční zrušení
    NEBLOKUJE — je to nový výslovný záměr uživatele s vlastním durable záznamem a výsledkem ze stavu;
    automatika sama dál nic neopakuje (`manualEntryCancelRequested` drží jeden pokus za běh). Status
    `pendingOwnEntries` nenabízí jen vstup s PRÁVĚ běžícím zrušením (`excluded` →
    `manualEntryCancelRunning`); durable `cancel: sending` bez běžícího jobu (restart, selhaný zápis
    výsledku) ho od kola 2 (P3, duch INV-UI-02) NEvylučuje — incident radí „zruš ho v Tradovate“
    a ruční „Zrušit čekající“ musí jít i z telefonu (jinak by zbyl jen Flatten). Vědomá odchylka od
    návrhu oponentury: durable `cancel: sending` bez běžícího jobu bránu `entry-canceling` nedrží —
    blokovalo by to natrvalo (revize stav nemění). Ruční zrušení funguje i pod kill switch (test).
  - Push (watchdog, INV-WATCH-01) rozhoduje podle `cancelVerified`, ne podle `cancel` (oponentura
    kolo 1, P1): `cancel: sent` znamená jen „adaptér skončil“. Bez `cancelVerified` se čeká (jako
    `sending`), po 60 s „nejde ověřit“; `canceled`/`ended` = informace bez věty „followeři vstup
    nedostali“ (je-li `cancelReason`); `filled`/`partially-filled` = „vyplnil se během rušení —
    pozice je otevřená, zkontroluj SL/TP“; `working`/`unverified` = „vstup může dál čekat“.
    Incident záznamu (`pendingIncident`) = vlastní push. **Pořadí nasazení (oponentura kolo 2, P3):
    nejdřív web** (watchdog na Vercelu je bez capability zpětně kompatibilní — starý worker dostane
    staré texty), **až potom reinstall workeru** s capability `manual-entry-auto-cancel-v1`. Před
    reinstallem ověřit na Vercelu, že produkční deploy obsahuje nový `manualEntryNotifications`
    (commit s C12). Opačné pořadí vrátí P1 z kola 1: starý watchdog čte jen `cancel: sent`, capability
    nezná a u vyplněného vstupu pošle „Vstup na leaderovi je zrušený“.
  - Status `manualEntries[]`: `cancelVerified` (`canceled` | `ended` | `filled` | `partially-filled` |
    `working` | `unverified`), `cancelReason`, `autoCancelAt` + `autoCancelReason` (`cme-halt` |
    `arm-expiry`; konec okna se tu nepočítá), `pendingIncident` (`at` + `text` posledního incidentu
    záznamu, oponentura kolo 1 P2). Jen zobrazení (INV-UI-01/03): UI smí napsat „zrušen“ jen
    u `cancelVerified: 'canceled'`. Capability `manual-entry-auto-cancel-v1`.
  - Vědomě ne: ověření pozic followerů po zrušení ve skupině s followery (oponentura P3b — kopie se
    může vyplnit mezi kontrolou a zrušením; dnes řeší S1b/V2), dohledání vstupu z flat v `sending`
    po restartu podle tagu (jen incident), svátky a zkrácené dny CME (NEOVĚŘENO), zda broker v pauze
    16:00–17:00 zrušení přijme (R12d, NEOVĚŘENO), odklad na naplánovanou ještě neběžící obnovu
    spojení (`pendingConnectionRecovery` / `pendingReadOnlyConnectionRecovery` můžou po incidentu
    zůstat true natrvalo — odklad by vstup nikdy nezrušil; falešné incidenty z cache místo toho
    řeší REST potvrzení), C7 `cancel-entry` s neznámou pozicí followera (C7 dál počítá jako 0),
    a dvě OAuth route ověřené jen mockem (route leadera dole = nečitelné čtení → incident, NEOVĚŘENO
    proti adaptéru). Kolo 3 změnilo C7: `follower-has-position` blokuje jen pozici followera, která
    může pocházet z TOHOTO vstupu (kopie s fillem > 0 / stav kopie nejde přečíst) — vyřazený follower
    s vlastní pozicí ruční zrušení už neblokuje (dřívější výhrada kola 2 je tím vyřešena). Mimo C12
    (předchozí stav, NEZMĚNĚNO): stream, který po restartu bez úplného
    čtení doručí vlastní vstup jako nový, ho zruší cestou „kopírka vypnutá dřív, než se vstup
    zkopíroval“ bez předčtení a bez kontroly followerů (k posouzení; od kola 2 aspoň s pozdní kontrolou
    dílčího / plného fillu a ověřením nohou). Vědomě ne: zrušení z předchozího běhu starší než 24 h
    se po startu nečte; stav kopie followera se čte z cache streamu (ne REST). **Oprava kola 4:** dřívější
    věta „kopie, která se vyplní mezi kontrolou a zrušením, zůstane jako dřív (P3b, S1b/V2)“ NEPLATILA —
    S1b/V2 tenhle případ neřeší (sonda B3: follower long, leader flat, `lastError: null`, žádný incident).
    Od kola 4: revize i C7 rozhodnou „odjinud“ jen nad ustáleným a dohnaným stavem followera, pozdní
    kontrola před zápisem stav followera přehodnotí a kopie vyplněná / nezrušená po zrušení leadera je
    za DISARMED incident per záznam (INV-BRAKE-01, INV-DIVERGENCE-01). C7 s neznámou pozicí followera
    dál počítá jako 0 — **neplatí od kola 6**: C7 i revize mají jedinou podmínku (`followerPositionOrigin`
    → `unknown`, follower bez načtené cache pozic není flat).
  - Oponentura kolo 3 (4. 11. 2026): (P2) výsledek po odmítnutém / selhaném zrušení rozhodne až čtení
    po ustálení — žádný nepravdivý incident „vstup dál čeká“ u TooLateToCancel; (P2) watchdog souběžný
    nový výsledek zrušení připojí k pushi incidentu, jinak ho nechá nedoručený (INV-WATCH-01); (P2)
    pozice followera blokuje zrušení jen z kopie tohoto vstupu (INV-BRAKE-01, i C7); (P3) nohy před
    výsledkem a značka „nohy ověřeny“ s ověřením po startu (INV-RESTART, INV-TRAD-02); (P3) status nese
    i starší záznamy s otevřeným vstupem / incidentem (INV-UI-03); (P3) pozdní kontrola odkládá při
    nezpracovaných eventech leadera (INV-OUTBOX-01).
  - Oponentura kolo 4 (4. 11. 2026): (P1) ve worktree zůstala mutace M17 ze zabitého mutačního běhu —
    vráceno (sha = premut), mutace od kola 4 jen v paměti (Vite `transform`, worktree se nemění), diskový
    runner se zámkem, zálohou na disku a obnovou při signálu / startu; (P2) vlastní vstup z flat proti
    pozici mimo appku na opačné straně se zruší (clOrdId = tag; za ARMED nahrazeno rozhodnutím Filipa
    z 5. 11. 2026, INV-BRAKE-01);
    (P2) pozice followera „odjinud“ jen po ustálení a bez ingress followera (revize, C7, pozdní kontrola),
    Fill kopie před Position blokuje, kopie vyplněná / nezrušená po zrušení leadera za DISARMED = incident
    per záznam; (P3) fill ze streamu rozhodne výsledek zrušení i při REST pozadu po ustálení a opraví
    `working` / `unverified`; (P3) test vyřazeného followera bez načtených pozic (R13); (P3) runbook
    nasazení: záznamy `cancel` bez `verified` z dosavadního workeru (COPIER_MAC_RUNTIME.md).
  - Oponentura kolo 5 (4. 11. 2026): (P2) fill vstupu během rušení je „chráněná SL/TP“ jen nad pozicí,
    kterou fill otevřel (`fillPositionProblem`, INV-BRAKE-01 / INV-TRAD-02); vstup proti pozici na opačné
    straně = incident `fill-unprotected`, nohy se neruší; texty a push bez „pozice je otevřená“
    (`cancel.opposite`, INV-UI-03, INV-WATCH-01); (P3) skončená kopie s fillem 0 = „nic z ní“, s fillem
    = `filled`, bez stavu `unreadable` (INV-BRAKE-01); (P3) nahrazení snímku pozic zneplatní ustálení
    followera (`AccountPositionsCache`, INV-TRAD-01); (P3) záložní důkaz vlastnictví z nohou bez
    clOrdId (A1; na brokeru NEOVĚŘENO, INV-TRAD-03); (P3) testy X2 (hák za ARMED mlčí) a X4 (follower
    flat + neznámý stav kopie → zrušení projde).
  - Oponentura kolo 6 (4. 11. 2026, jen P3): (A6) SL/TP vyplněné mezi čtením nohou a kontrolou pozice →
    `leaderVerifiedFlat` i ve větvi pozice = `flat` bez falešného incidentu (INV-UI-03, INV-DEFAULT-03);
    (C6) dílčí fill ze streamu a vstup v cache dál pracuje = `working` + incident „zbytek dál čeká“, cesta
    fillu jen nad koncem vstupu (INV-TRAD-02, INV-BRAKE-01); (C7) follower bez načtené cache pozic blokuje
    ruční zrušení (`unknown` ≠ flat, INV-DEFAULT-02) — jediná podmínka s revizí, C7 bere stejné followery
    jako revize; (X2) test drží ARMED cestu až do autoritativní kontroly velikosti (jen mock); text
    `copy-filled` neutrální. A1 (tag z REST čtení `placeOSO` parentu / `parentOrderId` nohou) dál
    NEOVĚŘENO na brokeru.
  - Rozhodnutí Filipa (5. 11. 2026, nahrazuje variantu (a) kola 4): pozice mimo appku za ARMED = jen upozornění
    (`outside-position`, bez `failClosed`), všechny ostatní důvody a DISARM vstup dál ruší; detail v INV-BRAKE-01.
    `cancel.opposite` zůstává kvůli rušení z ostatních důvodů.
  - Oponentura kolo 7 (5. 11. 2026, bez P1): ruční `cancel-entry` proti pozici s prokázaným vlastnictvím projde;
    druhé upozornění po fillu (varianta A, `outside-position-filled`); status neposílá zastaralé upozornění;
    texty „zmenší, zavře nebo otočí“; selhaný commit značky uvolní dedup.
  Hlídá test: `tests/manualPendingEntryReplay.test.ts` (137, controller + mock), `tests/manualPendingEntryReview.test.ts`
  (čisté), `tests/manualEntryPreview.test.ts` (`cme-halt`), `tests/manualScaleInReplay.test.ts` (C12 ×4),
  `tests/copierIncidentWatchdog.test.ts` (C12 push, kolo 3), `tests/liveCancelPending.test.ts`;
  rozhodnutí Filipa a kolo 7 v paměti (`c12r8fix/c12r8-mut.log`) ve scratchpadu;
  mutačně ověřeno: sada kola 2 (72) + kolo 3, plný běh v `c12r3-mut.log` ve scratchpadu; kolo 4 v paměti
  (sada kola 3 s aktualizovanými vzory + 21 nových), `c12r4-mut.log` ve scratchpadu; kolo 5 v paměti
  (34 mutací — nové + X1/X2/X4/X5/X6 oponentury, `c12r5fix/c12r5-mut.log`; R5-07/R5-24/R5-25 po úpravě
  textu a unit testu `AccountPositionsCache` znovu v `c12r5fix/c12r5b-mut.log`, vše KILLED) ve scratchpadu.
- Přikoupení do otevřené pozice (3. 11. 2026, `docs/reviews/scale-in-design-20261102.md` v5):
  jen manual-only local-only DEMO skupina bez followerů s instalačním opt-inem
  `--scale-in on` (capability `manual-entry-scale-in-v1`). Příkaz nese záměr
  `position` (pozice, kterou uživatel viděl); bez něj platí `account-not-flat`
  beze změny. Brána `scaleInAddBlockers` (čistá, z paměti) nahrazuje flat bránu
  jen pro leadera: vstupy lístků plně vyplněné podle fillů, krytí = |net| nohami
  potvrzenými streamem bez dílčího fillu, jedna cena SL/TP a přikoupení s touž
  cenou, žádný cizí příkaz, deník a epocha sedí, strop na CELOU pozici, čekající
  Limit/Stop jen po 1 kontraktu; synchronně znovu těsně před POSTem (nikdy REST).
  Riziko po lístcích z VWAP fillů, rezerva bez otevřeného P&L. Čekající přikoupení
  je stavová podmínka — od C12 (4. 11. 2026) společná pro každý vlastní čekající vstup
  (níže „Automatické zrušení čekajícího vstupu“); selhané zrušení, neznámý výsledek POSTu
  a restart během odesílání = incident. Správa pozice s víc lístky
  jen celá (`scope: 'position'`): jedna kontrola, všechny nohy durable `sending`,
  souběžné modify s qty ze streamu, výsledek po nohách bez opakování; starý tvar
  příkazu na takové pozici = `position-multi`.
  Hlídá test: `tests/manualScaleIn.test.ts`, `tests/manualScaleInReplay.test.ts`,
  `tests/manualScaleInPreview.test.ts`, `tests/liveScaleIn.test.ts`.

### INV-UI-04: Data z TradingView jsou jen pro zobrazení; nikdy nevstupují do read modelu, rozhodování ani úložišť (26. 10. 2026)

- Proč: Filip 26. 10. povolil cenu z TV pro P&L zobrazené na obrazovce, nikdy
  pro risk, day lock, limity ani kopírku. Veřejný Realtime kanál je
  podvrhnutelný, proto se zprávy podepisují.
- **Živé P&L na obrazovce (Filip 5. a 6. 11. 2026):** `liveDisplayOpenPnl` smí do štítku linky,
  hlavičky telefonu a panelu, bez poplatků, jen s cenou z IBKR téhož kontraktu ≤ 60 s a bez `stale`;
  jinak `liveShownOpenPnl` ukáže číslo brokera s vrácenými poplatky.
  Stejně jako `LiveOpenPnlValue` nikdy do rizika, limitů, day locku ani příkazů.
- **Nativní Market a IBKR v riziku ručního vstupu (Filip 1. 11. 2026 večer,
  výslovně schváleno: „jen IBKR pro risk“):** od 2. 11. 2026 Market z panelu
  posílá skutečný Market (`orderType: 'Market'`, bez ceny příkazu; výjimka
  „Limit +2 b“ níže tím skončila). Cena grafu jde jen jako `referencePrice`
  (Buy = ask, Sell = bid) + `quoteReceivedAt`: odhad rizika, strana SL/TP
  a zobrazení, nikdy cena příkazu. Worker smí pro ruční vstup číst VLASTNÍ
  kotaci z IBKR (vlákno ceny → `server/tvPriceStreamSupervisor.ts:latestQuote`,
  jen když je IBKR aktivní zdroj; TradingView NIKDY): (1) původ kontraktu —
  i Limit/Stop vyžaduje stejný konkrétní kontrakt v kotaci ≤ 15 s; rozpor
  s kotací IBKR blokuje vždy. Jen když kotace IBKR chybí, smí LIMIT (ne Stop,
  ne Market) potvrdit front kontrakt přímo od brokera: Tradovate
  `product/find` → `contractMaturity/deps` (právě jedna nearchivovaná `isFront`)
  → `contract/deps` (právě jeden název), čteno jen při připojení, nejvýš po
  5 min, platnost ≤ 30 min (`BrokerPort.frontContract`, status
  `brokerFrontContract`; Filip 1. 11.: „když IBKR spadne, Market se zablokuje
  a pojedou jen vzdálené Limity“; 2. 11. po auto log off IB Gateway).
  Kalendářní `frontSymbols` platí dál. Hlídá `tests/brokerFrontContract.test.ts`
  a blok „původ kontraktu bez IBKR“ v `tests/manualEntryMarketCapMnq.test.ts`;
  (2) Market — cena workeru (ask/bid ≤ 3 s, jinak last ≤ 3 s), posun od
  `referencePrice` ≤ 8 ticků (sólo DEMO 40 ticků; klient pouští cenu starou do 5 s, zkratky do 3 s), SL i TP ≥ 16 ticků od obou cen a na správné
  straně trhu, riziko z horší z obou cen + 6 ticků skluzu; totéž se znovu
  synchronně ověří těsně před POSTem. Do read modelu, day locku, ARM,
  reconcile ani kopírování followerů kotace nevstupuje. Market jen pro
  instalační manual-only DEMO skupinu bez followerů (`market-manual-only`).
  Utažení SL / BE (2. 11. 2026): UI pojistka smí bez ceny z P&L brokera použít čerstvou kotaci IBKR
  téhož kontraktu — tedy blok i uvolnit; worker utažení znovu hlídá 8 ticků od své kotace IBKR
  (INV-MANUAL-01 fáze 2c). Čerstvost v UI se měří od příchodu zprávy, ne od času IBKR.
  Vynucuje `services/manualEntryPreview.ts:manualEntryMarketQuoteBlockers`,
  `services/copierRuntimeController.ts:executeManualEntry`; hlídá
  `tests/manualEntryMarketCapMnq.test.ts`, `tests/manualEntryMarketController.test.ts`.
- **Upozornění na cenu (2. 11. 2026):** IBKR smí upozornění SPUSTIT (vlákno hlídače,
  INV-WORKER-04), ale cena z IBKR se nikam neukládá ani neposílá: `price_alerts` /
  `price_alert_events` nesou jen úroveň uživatele, podmínku, kontrakt a časy; notifikace,
  karta i hlas říkají úroveň uživatele, ne cenu trhu. Automaticky odvozený směr se
  přepočítá z IBKR jen v paměti hlídače (událost pak tvrdí „překročí“). Platí jen pro
  vlastní IBKR uživatele (licence dat, viz zdroj ceny výše). TradingView upozornění nikdy
  nespouští. Hlídá `tests/sql/priceAlerts.pg.mjs`, `tests/priceAlertWatch.test.ts`.
- **Výjimka Market (Filip 30. 10. 2026, výslovně schváleno; NAHRAZENO 2. 11. 2026
  nativním Marketem výše):** Market z panelu
  posílá Limit o `MARKET_GUARD_POINTS` (2 b) přes ask/bid grafu. Cena grafu smí
  být JEN strop ceny příkazu uživatele (Buy se vyplní za ni nebo lépe), a jen
  se zprávou mladší než 3 s; nikdy nevstupuje do read modelu, rizika, day locku ani
  rozhodnutí kopírky (worker počítá riziko z ceny příkazu jako z nejhoršího vstupu).
  Pozor: brána (5 s, zkratky 3 s, od 5. 11. 2026) hlídá příjezd zprávy, ne stáří ceny. Heartbeat 1/s posílá poslední cenu
  dál, takže cena samotná může být stará až `IBKR_STALE_MS` (15 s).
  Cenu panelu objednávky (zobrazení + strop Marketu) bere `hooks/useLiveTicketQuote.ts`
  přímo z kanálu ceny (`last` poslední zprávy, ≤ 10×/s; do 6. 11. 2026 `close`, který na přelomu minuty nese close minulé minuty) — jediný čtenář feedu
  mimo graf; hlídá `tests/tvPriceClientGuards.test.ts`. Cena nejde přes přehrání ticků:
  animace grafu se při netikajícím `requestAnimationFrame` (karta na pozadí) zasekne
  v dokreslení a panel by ukazoval starší cenu jako čerstvou (DEMO 2. 11.: 9 ticků,
  2× `market-quote-drift`). Test: `tests/tvPriceTrail.test.ts`.
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
  Telefon po 5 s bez ceny v otevřené seanci ukáže „Živá cena teď nechodí“ (jen text, mimo
  blokace i dotyky; INV-UI-01, seance z `lib/cmeSession.ts`, svátky nezná).
  Pilulka telefonu bez živé ceny ukazuje „—“, nikdy close svíčky. Pojistka skoku (cena panelu i svíčka): s potvrzeně stejným
  kontraktem (`contractMatchesData`) 1 %, bez důkazu 0,2 %. Pásmo samo kontrakt nerozezná.
  Historie grafu dne v IndexedDB (`readDayTail`, 6. 11. 2026) nese jen odpověď
  Databenta (`response.candles`), nikdy živé svíčky ani výstup `composeDayCandles`;
  do grafu a panelu jde až se živým čtením (`historyReadyForChart`), jinak by
  panel vzal ~24 h starou cenu, a jen s rozdílem hranic do 2 h kvůli díře v řadě.
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
  nikdy z ceny TV. Totéž P&L skupiny a list účtů na LIVE grafu telefonu
  (`components/day/LivePhoneAccounts.tsx`, 2. 11. 2026; nohy
  `liveChartPositionTvLegs` v `lib/tvLivePnl.ts`).
  Upozornění na cenu (`lib/priceAlerts.ts`, 2. 11. 2026): podmínka nahoru/dolů
  se při založení a posunu odvodí z close svíčky grafu — jen popisek v UI.
  Skutečné hlídání musí brát cenu z IBKR ve workeru (nikdy z TV) a podmínku
  přepočítat tam; upozornění nikdy neobchoduje a nevstupuje do rizika.
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
  zapnuto). Od rychlé ceny (5. 11. 2026, INV-WORKER-04) se při čerstvém vzorku
  cesta z IBKR neposílá, protože by vracela cenu zpět: u IBKR je tedy přehrání
  prakticky vypnuté a volba platí hlavně bez vzorků. `close`, `last` a high/low
  mohou být ze vzorku; minuta a open jen z obchodů.
- Hlídá test: `tests/tvPriceTrail.test.ts` (podpis, vazba, kompatibilita,
  sběr ve workeru, přehrání), `tests/tvPriceClientGuards.test.ts` (kdo smí moduly
  importovat vč. aliasu `@/`, rozhodovací/ukládací/sdílené cesty kanál
  nevidí ani tranzitivně, žádné storage, grant jen do kanálu, render-prop
  jen formátuje — 9 bloků bez `set*`/`on*`/ref/limitů, ekvivalence
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
  Telefon (2. 11. 2026): stejný `useLiveChartData` je zapnutý i pro LIVE graf
  telefonu (`phoneChartAvailable`), tempo čtení se nemění (`chartOpenRef`,
  budíček i expozice jen pro graf na PC). Hlavička ukáže P&L skupiny
  (`components/day/LivePhoneAccounts.tsx`, listová komponenta INV-UI-04),
  list „Účty v obchodě“ P&L a SL/TP každého účtu. P&L řádku účtu má stejnou
  brzdu 15 s jako souhrn (`finalize` v `lib/journalLivePosition.ts` vynuluje
  `openPnl` účtu se starou kotvou nebo bez vstupu — platí i pro PC panel
  objednávky). Neověřené příkazy účtu = „SL ?“, víc cen = „víc cen“, „bez SL“
  jen u ověřených příkazů s nulovým krytím (`tests/livePhoneAccounts.test.ts`).
  Žádné tlačítko příkazu.
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
- Upozornění na cenu (2. 11. 2026): vlastní fronta `price_alert_outbox`, kterou plní
  `trigger_price_alert` v téže transakci jako spuštění; drain `server/priceAlertOutbox.ts`
  běží v endpointu hlídače (`api/price-alerts/watch.ts`) a v cronu ve vlastním
  try/catch ZA sekcí kopírky. `notification_delivery_outbox` a `drainNotificationDeliveries`
  se nemění; rozpočet 20 notifikací / 10 min / uživatel a sbalení podle upozornění,
  aby záplava upozornění nevyčerpala limit ani nepotlačila rizikové notifikace.
  Upozornění nikdy nevstupuje do ARM, risku, day locku ani kopírky. Rozpočet proti
  limitu APNs na token zařízení je NEOVĚŘENO.
- Zrušení vlastního čekajícího vstupu (C12, oponentura kolo 1 P1/P2, 4. 11. 2026):
  `manualEntryNotifications` u workeru s capability `manual-entry-auto-cancel-v1` rozhoduje podle
  `cancelVerified` (výsledek ověřený stavem), nikdy podle samotného `cancel: sent` („úspěch“ adaptéru
  přijde i u vyplněného vstupu). Bez `cancelVerified` se čeká, po 60 s
  (`MANUAL_ENTRY_CANCEL_VERIFY_GRACE_MS`) „nejde ověřit — vstup může dál čekat“; `filled` = „vyplnil se
  během rušení — zkontroluj pozici a její SL/TP“ (kolo 5, P2: fill vstupu proti pozici na opačné straně
  ji zavřel — dovětek se připojuje i k pushi incidentu `fill-unprotected` a netvrdí „pozice je
  otevřená“). Detail klíče `manual-entry:<op>` = `status:cancel:cancelVerified`
  `[|incident:<at>]`, takže pravdivý výsledek přijde i po dřívějším `sent`. Incident záznamu
  (`pendingIncident`) = vlastní push s tímtéž klíčem nezávisle na globálním `fail-closed` (otevře se
  jen jednou) a i za kill switch. Starý worker bez capability = původní texty. Jen notifikace,
  nic neřídí. Hlídá test: `tests/copierIncidentWatchdog.test.ts` (C12 oponentura kolo 1).
  Oponentura kolo 3 (P2): nový incident a v témž průchodu nový výsledek (jiný než naposledy odeslaný)
  — výsledek se zapíše jako doručený, jen když ho push opravdu nese: krátký text výsledku zrušení
  (např. „vyplnil se během rušení — zkontroluj pozici a její SL/TP“) se připojí k tělu incidentu; výsledek bez
  krátkého textu zůstane nedoručený a odejde vlastní zprávou v dalším průchodu. (P3) průchod čte až
  50 záznamů statusu (worker C12 nese i starší záznamy s incidentem, INV-UI-03). Test:
  `tests/copierIncidentWatchdog.test.ts` (C12 kolo 3).
  Oponentura kolo 2 (P3): `cancel: sending` bez `verified` se dál nehlásí (čeká se) — po restartu ho
  worker ověří čtením (`verified` → push podle výsledku, INV-RESTART). Pořadí nasazení: **nejdřív web
  (watchdog), až potom reinstall workeru s capability** `manual-entry-auto-cancel-v1` — starý watchdog
  capability nezná a u vyplněného vstupu by z `cancel: sent` poslal „zrušený“ (detail INV-MANUAL-01,
  runbook `docs/COPIER_MAC_RUNTIME.md`).

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
- **28.–29. 10. — kopírka se po každém exitu sama vypínala.** Samostatné SL
  followerů vyplněné 26. a 28. 10. zůstaly v durable outboxu a links; po
  restartu je sweep paměť prázdná a `/order/list` je už nevrací, takže každý
  flat sweep skončil „stav ochranné nohy … chybí v autoritativních zdrojích“
  (~12× za den). Reconciliation uzavírala jen OSO/bracket nohy. Teď uzavře
  i samostatné SL podle pravidla u INV-RECON-03. Současně opraveno: sweep bral
  samostatné SL z links bez symbolu, takže flat MNQ by zrušil pracující SL
  otevřené NQ pozice. `tests/copierStaleStandaloneStopSweep.test.ts`.
  Zbývá: follower mimo snapshot reconciliation (`breached`/`dll-locked` bez
  epizody) staré nohy neuzavře a po přechodu do flat dál fail-closed.
- **29. 10. — OSO okno a zdržená fronta (oponentura 1b).** Časovač
  samostatného vstupu počítal okno od příchodu eventu; když fronta
  controlleru stála > 1,5 s (pomalý commit, POST), vystřelil mezi vstupem
  a nohami → `oso-lone-leg`, nebo kopie vstupu bez ochrany. Teď se flush
  odloží, dokud čekají nezpracované eventy leadera (po 50 ms, nejvýš 5 s).
  `tests/manualEntryPlace.test.ts` (fixture fáze 0 + zpoždění 2 s).
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


### INV-MANUAL-LIMIT-01: Posun existujícího limitu není nový vstup

- `move-limit` je dostupný jen pro vlastní, nevyplněný MNQ Limit v lokální manual-only DEMO skupině bez followerů, s instalačním opt-inem pending-legs. Nová capability `manual-order-move-limit-v1` chrání staré workery. Pozice, Stop, přikoupení a sledované cizí příkazy se touto akcí nespravují.
- Worker znovu ověřuje ARMED, shadow, kill, route/fence, reconciliation, busy, flat účet, přesnou očekávanou cenu/množství, obě pending ochranné nohy, jejich stranu a riziko do SL. Nová cena musí být na správné straně čerstvé kotace stejného kontraktu nejméně 8 ticků od trhu. Kontroly ceny, nohou, rizika a fillu se opakují po durable zápisu těsně před brokerem.
- Zápis je jediný Modify původního brokerOrderId, se stejným množstvím. SL/TP zůstávají na svých cenách. Žádný cancel/recreate ani automatické opakování při neznámém výsledku. Částečný fill / terminální vstup není důkaz úspěšného posunu.
- OFF/Kill superseduje `move-limit` pod stejným uživatelským zámkem jako admission (migrace `20261106125237`); záložní relay cesta i worker brake epoch jej také zastaví. SQL migrace musí předcházet zpřístupnění nové akce ve webu.
- UI nejdřív vybere čáru, až další tah pošle záměr; původní cena z počátku tahu, společný zámek desku a stav odesílání brání dvojímu odeslání. UI nikdy samo nepotvrzuje brokerový výsledek.
- Důkazy: `manualPendingLegs.test.ts`, `livePhoneOrderLinesBehavior.test.ts`, `tests/sql/copierManualAdmission.pg.mjs`, `tradovateCopierCommandRelay.test.ts`.

### INV-TRAD-ACK-01: Transportní ACK nemění pořadí obchodních událostí

- Korelovaná odpověď na WebSocket zápis se vyřídí nezávisle na semantic tailu. Frame obsahující pouze tuto odpověď nespotřebuje pořadové číslo sémantické fronty.
- Díky tomu další skutečný OrderVersion může uvolnit čekající hydrataci bez čekání na REST. Jakákoli intervenující sémantická událost zůstává bariérou. Execution cache, zpracování fillů, watchdog i pravidla potvrzení změny zůstávají stejné.
- Regrese s nerozhodnutým REST čtením: `tradovateBrokerWebSocketWrites.test.ts`; varianta s intervenujícím Order zůstává blokovaná. Test s ACK-only bez opravy selže.
