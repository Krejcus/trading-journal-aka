# Review: `docs/COPIER_INVARIANTS.md` (362ef735)

Reviewer: Claude (ověřovací agent, 48 pravidel, 18 do hloubky proti kódu), 2026-10-08 · Pro: Codex

Verdikt: struktura a odkazy z ~95 % správně. Opravit níže. Každý bod ověř v kódu,
nepřebírej ho slepě; pokud nesouhlasíš, napiš proč.

## (a) Rozbité / zavádějící odkazy
1. INV-WORKER-03: `authenticateTradovateCopierDevice` neexistuje → `authorizeTradovateCopierDevice` (`server/tradovateCopierDevice.ts:100`).
2. INV-MODE-01: `copierRiskGate.ts:haltReason` management-only nehlídá. Vstupy blokuje controller (`blockDuringPause` ~`copierRuntimeController.ts:9564`, `entryRestrictionActive` ~`:10961`).
3. INV-DIVERGENCE-01: `copierEngine.ts:planReconciliation` (~:749) pravidlo nevynucuje — plánuje Market dorovnání a nikde se nevolá (mrtvý kód). Uveď to jako past (mrtvý kód, který by porušil pravidlo, kdyby ho někdo zapojil) a doporuč v sekci 5 odstranění.
4. Testy, které pravidlo nehlídají (oprav nebo napiš „žádný přímý test“):
   - ARM-02 → `copierArmPreparation.test.ts` (merge risk konfigurace; skutečný je jen `copierWorkerArmPreparation`).
   - RISK-04 → `copierDailyRules.test.ts` (Europe/Prague okno, ne 17:00 Chicago).
   - TRAD-03 → `tradovateBrokerRequestDedup.test.ts` (dedup čtení, ne clOrdId).
   - ELIG-02 → `copierRuntimeCommandAdapter.test.ts` (bez exclusions).
   - WATCH-01 → `copierWatchdog.test.ts` testuje `scripts/copier/watchdog.ts`, ne `server/copierIncidentWatchdog.ts`.
   - WORKER-02 → `supabaseCopierStore.test.ts` netestuje `CopierFenceStaleError`.
   - ARM-03, FRESH-02 → `liveCopyGroupPowerInteraction.test.ts` (politika dialogu, ne generation/pořadí).

## (b) Věcné nepřesnosti
1. BRAKE-05 / DEFAULT-02 přeceňují cílení auto-close: `autoFlattenCopies` (~:8130–8136) bez známé copier stopy volá flatten bez targetů → při `cleanupScope: 'target-symbol-or-account'` account-wide čištění (`copierManualActions.ts:175–177`), záměrně a testováno (`copierAutoCloseV9V4.test.ts:83`). Stopa followera zahrnuje každý symbol, který leader drží (~:7988–7993). `armExpiryFlatten: 'group'` zavírá i leadera (~:8064). Přepiš pravidlo podle skutečnosti, fallback popiš jako vědomé rozhodnutí.
2. ARM-04, FRESH-01, ARM-03, BRAKE-02: chybí výjimka terminálního cancelu — `dispatchBroker` (~:1546–1553) pouští cancel přes `cancelLifecycleHaltReason` (`copierRiskGate.ts:162`) bez kontroly kill/DISARM/generation/shadow. Kill switch také pouští ruční Flatten. Doplnit výjimky a proč jsou bezpečné.
3. ARM-01: „`haltReason` stejné zásady znovu hlídá“ je přehnané — hlídá jen kill, armed, TTL, connected, heartbeat, environment, sequence, stuck, divergence (`copierRiskGate.ts:139–151`); okno, cooldown, day lock, management-only, flat, eligibility ne.
4. RELAY-01: idempotency key chrání jen opakování téhož HTTP požadavku; klient generuje nový `randomUUID()` při každém volání (`services/tradovateOAuthConnection.ts:321`), server když chybí (~:587). Dvojklik chrání jen coalescing Flatten/ARM; DISARM, reconcile, toggle se zařadí dvakrát. Uveď a do sekce 5 přidej, zda je to problém.
5. **DEFAULT-03 / RECON-02 — nejdůležitější:** SHADOW příkaz (`localCopierExecutionAgent.ts` ~:850) a kompatibilní ARM bez `prepareArm` (~:818) volají veřejné `reconcile()` → smaže `lastError` i `manualRecoveryRequired` (a při ARMED auditovaně DISARMuje, ~:15091). Ověř. Pokud platí, je to porušení slibu „incident smaže jen ruční Kontrola pozic“ — zapiš výjimku do pravidla a do sekce 5 jako konkrétní slabé místo s doporučenou opravou (kód neměň).
6. DIVERGENCE-01: chybí výjimka izolace followera (V16, incident 6. 10.), kdy skupina nemusí haltnout.
7. FRESH-03 / UI-01: `executeAgent` hlídá jen restored stav, ne 15 s; 15s brána je `armStatusRef.fresh` (`components/TradovateLiveDesk.tsx` ~783/865/886). `runtimeAvailable` je 1,2 s `true` i pro obnovený status starý až 10 min (~:146, 308, 379) — popiš přesně (zobrazení ano, autorizace ne).
8. BRAKE-04: `lockUntil` přijme libovolné budoucí `until` (~:14991); konec session fixuje až příkaz `lock-until-session-end`.

## Hotovo, když
Všechny body opravené nebo zdůvodněně odmítnuté, commit ve stejné větvi, krátký dovětek do PROJECT_LOG zápisu.
