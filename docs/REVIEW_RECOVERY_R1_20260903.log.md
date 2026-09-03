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
session id: 01a0660d-e238-79c1-bfaa-f942f5adf1e0
--------
user
# Read-only cross-review Claudeova commitu v copier core

Repo = aktuální adresář (worktree na main). Zrecenzuj diff v /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/68dfa1b9-b400-40c9-b983-6a4b7dd71727/scratchpad/claude-recovery-fix.diff
(commit „post-connect recovery honours OAuth-missing followers; clean manual
reconcile clears the recovery flag“). Kontext: docs/PROJECT_LOG.md (2026-09-03,
Otevřená otázka „Automatická post-connect recovery selže, když follower chybí
v OAuth“) a services/copierRuntimeController.ts (runConnectionRecovery,
reconfigureLeaderEpoch pendingReasons, public reconcile).

Otázky:
1. Může shození `pendingConnectionRecovery` po čisté ruční reconciliaci
   (0 divergence, 0 working orders) přeskočit nějaký krok, který by recovery
   vlna jinak udělala (resumeLeaderFlatEpochsAfterSnapshot, auto-flatten
   osiřelých kopií po reconnectu, liveCopyOpenSince clear)? Uveď konkrétní
   scénář, kde by to bylo nebezpečné, nebo zdůvodni, proč ne.
2. Je filtrování callbacku na followery skupiny a vyloučení leadera dostatečné?
   Co když callback vrátí followera, který v OAuth JE (stale info)?
3. Race: callback je awaitován před smyčkou; může se mezitím změnit group
   (reconfigure) a vstup zestárnout? Důsledek?
4. Test: pokrývá skutečný incident? Co chybí (např. leader v callbacku,
   callback vyhodí výjimku, follower reappears)?
Výstup: markdown, verdikt (schválit / opravit), konkrétní návrhy s řádky.
Žádné změny v repu.
codex
Udělám čistě read-only cross-review. Nejprve projdu projektový log, stav worktree a přesný diff, potom zmapuju změny proti recovery/reconcile stavovému stroji a testům.
exec
/bin/zsh -lc "sed -n '1,260p' /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/68dfa1b9-b400-40c9-b983-6a4b7dd71727/scratchpad/claude-recovery-fix.diff" in /private/tmp/alphatrade-reconnect-fix
exec
/bin/zsh -lc "sed -n '1,260p' docs/PROJECT_LOG.md" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
diff --git a/scripts/copier/pilot.ts b/scripts/copier/pilot.ts
index cd1e49f8..06dc28d4 100644
--- a/scripts/copier/pilot.ts
+++ b/scripts/copier/pilot.ts
@@ -632,6 +632,14 @@ async function runLocalAgent(
         auditTail = auditTail.then(() => writeAudit(entries));
       },
       onError: logControllerError,
+      // Post-connect recovery musí vidět stejný optional-skip jako ruční
+      // Kontrola pozic, jinak zmizelý breached follower shodí recovery.
+      resolveMissingOptionalAccountIds: prepareGroupAccounts
+        ? async current => (await prepareGroupAccounts({
+          required: [current.leaderAccountId],
+          optional: current.followers.map(follower => follower.accountId),
+        })).missingOptional
+        : undefined,
       // Trade event -> okamžitý poll s příznakem -> server pushne hned.
       onCopyEvent: event => {
         relay?.nudgeCopyEvents();
diff --git a/services/copierRuntimeController.ts b/services/copierRuntimeController.ts
index b76d9989..d29c4da7 100644
--- a/services/copierRuntimeController.ts
+++ b/services/copierRuntimeController.ts
@@ -355,6 +355,14 @@ export interface BootstrapCopierOptions {
   flattenConfirmationPollMs?: number;
   flattenAccountConcurrency?: number;
   wait?: (ms: number) => Promise<void>;
+  /**
+   * Read-only zdroj „followeři právě neviditelní v žádném připojeném OAuth
+   * adresáři“ pro automatickou post-connect recovery. Stejný vstup dostává
+   * CLI/UI Kontrola pozic; bez něj broker router pro zmizelý (typicky
+   * breached) follower vyhodí chybu a recovery skončí fail-closed, i když je
+   * jeho vynechání legitimní. Vrácené ID se filtrují na followery skupiny.
+   */
+  resolveMissingOptionalAccountIds?: (group: CopyGroupConfig) => Promise<readonly number[]>;
   /**
    * Bounded okno pro spárování follower position 0→nonzero s konkrétním
    * broker fill eventem. Po vypršení následuje autoritativní read-only
@@ -2681,6 +2689,19 @@ export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): P
       return;
     }
     const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
+    // Stejný optional-skip vstup jako ruční Kontrola pozic: follower, který
+    // právě není v žádném OAuth adresáři, se nesmí routovat (router by hodil
+    // chybu), ale jeho absence je pro breached/DLL účet legitimní.
+    let missingOptionalAccountIds: readonly number[] = [];
+    if (options.resolveMissingOptionalAccountIds) {
+      try {
+        const followerIds = new Set(group.followers.map(follower => follower.accountId));
+        missingOptionalAccountIds = [...new Set(await options.resolveMissingOptionalAccountIds(group))]
+          .filter(accountId => followerIds.has(accountId) && accountId !== group.leaderAccountId);
+      } catch {
+        missingOptionalAccountIds = [];
+      }
+    }
     let reconciliation: { divergentAccounts: number[]; workingOrderAccounts: number[] } | null = null;
     for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
       if (attempt > 0) await wait(2_000);
@@ -2689,7 +2710,9 @@ export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): P
         return;
       }
       try {
-        reconciliation = await performReconciliation();
+        reconciliation = await performReconciliation({
+          missingOptionalAccountIds: [...missingOptionalAccountIds],
+        });
         break;
       } catch {
         // Spojení je čerstvé — pár pokusů, pak poctivé přiznání níže.
@@ -4296,7 +4319,15 @@ export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): P
       // Veřejná Kontrola pozic je explicitní uživatelská recovery akce.
       // Pouze její čistý výsledek smí odstranit starou chybu; automatické
       // reconnect/terminal-fill kontroly incident uživateli neschovávají.
-      return performReconciliation({ ...reconciliationOptions, clearLastError: true });
+      const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
+      if (result.divergentAccounts.length === 0 && result.workingOrderAccounts.length === 0) {
+        // Autoritativně čistý stav je přesně to, co čekající recovery vlna
+        // hledala; jinak by příznak po neúspěšné automatické vlně blokoval
+        // změnu skupiny („rozpracovaný lifecycle: connection recovery“) až do
+        // dalšího connection eventu. Při divergenci zůstává pending.
+        pendingConnectionRecovery = false;
+      }
+      return result;
     },
     async verifyAccountEligibility(accountId) {
       if (!Number.isSafeInteger(accountId) || accountId <= 0) {
diff --git a/tests/copierConnectionRecoveryOptionalFollower.test.ts b/tests/copierConnectionRecoveryOptionalFollower.test.ts
new file mode 100644
index 00000000..a9276a9e
--- /dev/null
+++ b/tests/copierConnectionRecoveryOptionalFollower.test.ts
@@ -0,0 +1,120 @@
+import { describe, expect, it } from 'vitest';
+import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
+import { createBrokerRouter } from '../services/brokerRouter';
+import { createMockBroker } from '../services/mockBroker';
+import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
+import type { CopyGroupConfig } from '../services/liveCopyTrading';
+
+/**
+ * Incident 3. 9. 2026 05:45 UTC: breached follower 63338752 zmizel z OAuth.
+ * Automatická post-connect recovery routovala i jeho → router vyhodil chybu →
+ * po pěti pokusech fail-closed a `pendingConnectionRecovery` zůstal zapnutý.
+ * Ruční Kontrola pozic (s optional skipem) prošla, ale příznak dál blokoval
+ * změnu skupiny („rozpracovaný lifecycle: connection recovery“).
+ */
+
+const MISSING = 303;
+const group: CopyGroupConfig = {
+  id: 'g-recovery', name: 'Recovery', enabled: true, leaderAccountId: 100,
+  followers: [
+    { accountId: 200, mode: 'on-submit', multiplier: 1 },
+    { accountId: 201, mode: 'on-submit', multiplier: 1 },
+    { accountId: MISSING, mode: 'on-submit', multiplier: 1 },
+  ],
+};
+const nextGroup: CopyGroupConfig = {
+  ...group,
+  followers: group.followers.filter(follower => follower.accountId !== MISSING),
+};
+
+const harness = async (options: {
+  resolveMissingOptionalAccountIds?: (current: CopyGroupConfig) => Promise<readonly number[]>;
+} = {}) => {
+  const initial = emptySnapshot();
+  initial.safety = {
+    entryCooldownUntil: 0,
+    dayLockUntil: 0,
+    // Durable stopa „za živého ARM existovaly kopie“ → boot recovery po připojení.
+    liveCopyOpenSince: 1,
+    accountEligibility: [{
+      accountId: MISSING, state: 'breached', reason: 'LIVE equity dosáhla drawdown flooru', at: 900,
+    }],
+  };
+  const mock = createMockBroker({
+    behavior: () => ({ kind: 'working' }),
+    accountCapabilities: [100, 200, 201].map(accountId => ({ accountId, active: true, canTrade: true })),
+  });
+  // Zmizelý follower nemá route — přesně jako účet, který už není v žádném OAuth.
+  const router = createBrokerRouter([{ broker: mock, accountIds: [100, 200, 201] }]);
+  const errors: string[] = [];
+  const controller = await bootstrapCopierRuntime({
+    broker: router,
+    store: createMemoryCopierStore(initial),
+    group,
+    wait: async () => undefined,
+    onError: error => errors.push(error.message),
+    ...options,
+  });
+  mock.setConnected(true);
+  // Connection event doráží přes router asynchronně; recovery se řadí až po něm.
+  await settle(controller);
+  return { controller, errors, mock };
+};
+
+const settle = async (controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>) => {
+  for (let round = 0; round < 3; round += 1) {
+    await new Promise<void>(resolve => setTimeout(resolve, 20));
+    await controller.waitForIdle();
+  }
+};
+
+describe('post-connect recovery a follower chybějící v OAuth', () => {
+  it('bez optional-skip vstupu recovery selže, ale čistá ruční Kontrola pozic odblokuje změnu skupiny', async () => {
+    const h = await harness();
+    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
+    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
+
+    // Stav po včerejšku: příznak recovery blokuje reconfigure i po jejím selhání.
+    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
+      .rejects.toThrow('connection recovery');
+
+    // Ruční Kontrola pozic se stejným optional skipem jako CLI/UI projde…
+    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
+      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
+    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
+
+    // …a čistý výsledek recovery příznak shodí: odebrání zmizelého followera už projde.
+    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
+      .resolves.toBeUndefined();
+    expect(h.controller.status().armed).toBe(false);
+    h.controller.stop();
+  });
+
+  it('s optional-skip zdrojem recovery projde napoprvé a skupina není blokovaná', async () => {
+    const seen: CopyGroupConfig[] = [];
+    const h = await harness({
+      resolveMissingOptionalAccountIds: async current => {
+        seen.push(current);
+        return [MISSING, 999_999];
+      },
+    });
+    expect(seen.length).toBeGreaterThan(0);
+    expect(h.errors).toEqual([]);
+    expect(h.controller.status()).toMatchObject({
+      armed: false, reconciliationRequired: false, lastError: null,
+    });
+    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
+      .resolves.toBeUndefined();
+    h.controller.stop();
+  });
+
+  it('neúspěšná ruční Kontrola pozic (chybějící follower bez optional skipu) příznak neshazuje', async () => {
+    const h = await harness();
+    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
+    // Bez optional skipu router pro 303 selže → reconcile hodí chybu → pending zůstává.
+    await expect(h.controller.reconcile()).rejects.toThrow();
+    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
+      .rejects.toThrow('connection recovery');
+    h.controller.stop();
+  });
+});

 succeeded in 0ms:
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
  beze změny. Beze změny jsou také server/PWA, broker, copier a jeho ARM stav;
  větev není sloučena do `main`.

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

exec
/bin/zsh -lc 'rg -n -C 3 "post-connect|pendingConnectionRecovery|OAuth-missing|runConnectionRecovery|manual reconcile|vanished-follower|68dfa1b9" /Users/filipkrejca/.codex/memories/MEMORY.md' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
185-
186-- com.alphatrade.copier, copier-agent.mjs, launchctl, service-lifetime persistent, armed=false, groupFlat=true, npm run copier:mac -- reconcile, SHA-256, reconciliationRequired
187-
188:## Task 4: Independently verify vanished-follower replacement and Mac worker reinstall, partial
189-
190-### rollout_summary_files
191-
--
193-
194-### keywords
195-
196:- vanished-follower, 64310872, 62364057, copier-agent.mjs, mac-reinstall-safe.sh, launchd, 7763bfcd, SHA-256, durable-group, reconfigureGroup(previous), rollback, 151 tests
197-
198-## User preferences
199-

exec
/bin/zsh -lc 'pwd && git status --short --branch && git rev-parse --show-toplevel && git rev-parse HEAD' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 3107ms:
git: error: couldn't create cache file '/tmp/xcrun_db-6AGQc1QL' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-xPwhwECc' (errno=Operation not permitted)
## codex/reconnect-fix-20260903...origin/codex/reconnect-fix-20260903 [ahead 11]
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-KyR56d7F' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-Ib0ZotXk' (errno=Operation not permitted)
/private/tmp/alphatrade-reconnect-fix
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-I7cUT8aS' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-usv8O2ck' (errno=Operation not permitted)
5154856da5756619b915876c23b3e99fc2108421

codex
Diff řeší dvě různé věci: předání optional-skip do automatické recovery a samostatné odblokování lifecycle flagu ruční reconciliací. Teď ověřuju, zda druhá změna nenahrazuje pouze kontrolu pozic, zatímco recovery má další side-effecty.
exec
/bin/zsh -lc "sed -n '175,215p' /Users/filipkrejca/.codex/memories/MEMORY.md && sed -n '1,260p' /Users/filipkrejca/.codex/memories/rollout_summaries/2026-09-02T17-22-10-Zr84-task-4-independently-verify-vanished-follower-replacement-and-mac-worker-reinstall-partial.md" in /private/tmp/alphatrade-reconnect-fix
 exited 1 in 0ms:

- DLL zbývá, copyTradeDailyLossRemaining, copyTradeDailyLoss, realizedPnl, unrealizedPnl, Table Settings, Accounts columns, 1b903f8e

## Task 3: Exact-commit Mac copier worker rebuild and safe restart, success

### rollout_summary_files

- rollout_summaries/2026-08-27T06-26-02-bkjY-alphatrade_live_toggle_dll_column_production_worker_restart.md (cwd=/Users/filipkrejca/Downloads/alphatrade-mentor-15, rollout_path=/Users/filipkrejca/.codex/sessions/2026/08/27/rollout-2026-08-27T08-26-02-01a041e5-9efc-75c3-a27e-68419ceeacee.jsonl, updated_at=2026-09-01T13:21:12+00:00, thread_id=01a041e5-9efc-75c3-a27e-68419ceeacee, post-restart reconciliation verified)

### keywords

- com.alphatrade.copier, copier-agent.mjs, launchctl, service-lifetime persistent, armed=false, groupFlat=true, npm run copier:mac -- reconcile, SHA-256, reconciliationRequired

## Task 4: Independently verify vanished-follower replacement and Mac worker reinstall, partial

### rollout_summary_files

- rollout_summaries/2026-09-01T06-12-20-2QZ9-alphatrade_oauth_copier_reinstall_verification.md (cwd=/Users/filipkrejca/Downloads/alphatrade-mentor-15, rollout_path=/Users/filipkrejca/.codex/sessions/2026/09/01/rollout-2026-09-01T08-12-20-01a05b98-e170-72d3-bf9c-ca9cd44c689f.jsonl, updated_at=2026-09-02T07:19:44+00:00, thread_id=01a05b98-e170-72d3-bf9c-ca9cd44c689f, independent read-only rollout verification; untested persistence rollback edge found)

### keywords

- vanished-follower, 64310872, 62364057, copier-agent.mjs, mac-reinstall-safe.sh, launchd, 7763bfcd, SHA-256, durable-group, reconfigureGroup(previous), rollback, 151 tests

## User preferences

- When the user requested ordinary enable/disable without a popup, with confirmation only on errors such as open positions -> make clean transitions one-click, but retain explicit blocking dialogs for concrete risk/error conditions. [Task 1]
- When the user said “pushni to na live” -> production push is authorized, but verify remote parity, Vercel `READY`, alias HTTP health, and runtime errors before reporting completion. [Task 1]
- When the user said “restartuj ho at to umí” -> restart is allowed, but it must not ARM, Flatten, or place/cancel/modify broker orders. [Task 3]
- When the user asked “koukni jak to claude udělal” -> independently verify rollout claims against Git, installed bundle, launchd, logs, runtime status, and production UI; keep verification read-only unless fresh, exact operational approval is given. [Task 4]

## Reusable knowledge

- `components/LiveCopyTradeOverview.tsx` exports `copyGroupPowerBlocker`; clean transitions call `runCopierTransition` directly. Positions, working entry/SL/TP orders, invalid configuration, unavailable runtime, failed preflight, and runtime failures remain fail-closed. Targeted tests passed 27/27; full verification passed 193 files/1546 tests, TypeScript, build, and `git diff --check`. [Task 1]
- Git push alone is not deployment proof: check the production commit, Vercel `READY`, alias HTTP result, and runtime logs. If GitHub port 22 is blocked, use validated SSH port 443 through `ssh.github.com`. [Task 1]
- `copyTradeDailyLossRemaining(account)` returns `dailyLossLimit + realizedPnl + unrealizedPnl`, `null` without a valid DLL, shows `—` during pending enrichment, and clamps displayed remaining amount at zero. The selectable UI path is `Table Settings → Accounts columns → DLL zbývá`. [Task 2]
- Related skill: skills/alpha-trade-copier-pilot/SKILL.md. Before and after restart require `armed=false`, `groupFlat=true`, no working orders/divergence/stuck outbox/last error; rebuild only from the exact validated commit, compare installed bundle SHA-256, then run `npm run copier:mac -- reconcile`. [Task 3]
- The verified 2026-09-02 worker replaced OAuth-vanished follower `62364057` with funded follower `64310872`, was DISARMED, connected, flat, reconciled, and error-free. A fresh esbuild build from `7763bfcd` matched the installed bundle SHA-256; five focused files passed 151 tests. Snapshot `ready` with `lastSuccessAt=null` proves CDP readiness, not a successful ENTRY/EXIT capture. [Task 4]

## Failures and how to do differently

- Symptom: a clean ON/OFF action still prompts, or an unsafe transition becomes a toast. Fix: bypass the dialog only for a `copyGroupPowerBlocker`-clear action; preserve authoritative preflight and visible fail-closed errors. [Task 1]
sed: /Users/filipkrejca/.codex/memories/rollout_summaries/2026-09-02T17-22-10-Zr84-task-4-independently-verify-vanished-follower-replacement-and-mac-worker-reinstall-partial.md: No such file or directory

exec
/bin/zsh -lc 'rg -n -C 8 "Automatická post-connect|post-connect recovery|missingOptional|connection recovery|runConnectionRecovery|liveCopyOpenSince" docs/PROJECT_LOG.md' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
51-  drží jen odchozí spojení. Kill switch z mobilu funguje přes relay.
52-- **Žádný stav na disku VPS** — snapshot v `copier_runtime_state`,
53-  box je vyměnitelný; obnova = nový deploy, ne restore zálohy.
54-- **Menu bar Mac aplikace zamítnuta** — leštila by kokpit letadla, které
55-  nahradí VPS; stejná investice jako celý VPS přechod.
56-
57-## Otevřené otázky
58-
59:- [ ] **Automatická post-connect recovery selže, když follower chybí v OAuth**
60-      (3. 9. 05:45:24 UTC, worker 03d1fc5f): po startu s breached `63338752`, který
61-      už není v žádném OAuth adresáři, skončila recovery vlna „nepodařilo se
62-      ověřit stav účtů“ bez auditního důvodu, zatímco ruční `reconcile` z CLI
63:      (routing předá optional skip) prošel. Podezření: `runConnectionRecovery`
64:      volá reconciliation bez `missingOptionalAccountIds`, takže nezpůsobilý
65-      chybějící follower je „missing required“. Fix: recovery má použít stejný
66-      optional-skip vstup jako CLI/UI cesta a při selhání zapsat audit s důvodem.
67-      Delegovat Codexu s regresí.
68-- [x] **Násobek 2× „sám“ přeskočil na funded účet při změně leadera** —
69-      VYŘEŠENO lokálně 3. 9. (zápis níže; změna zatím není commitnutá ani
70-      nasazená). Původní incident (2. 9.,
71-      15:25–15:34 UTC): `changeCopyGroupLeader` dává předchozímu leaderovi
72-      `{...promotedFollower, accountId: previousLeader}`, tedy zdědí násobek
--
255-`lastError=null`, DISARMED.
256-
257-Pozorování k ověření uživatelem před ARM: durable skupina má **leader 64310872
258-(funded Tradeify)** a všech pět followerů 1× (62364059, 62364055, 62364060,
259-63338752, 63338592) — tak ji uživatel včera večer nastavil. Lucid OAuth
260-`conn:754e4b5b` nyní vrací jediný účet **64503883**; oba včerejší Lucid účty
261-(62364553 leader dopoledne, 63338752 breached) v OAuth nejsou. `63338752` je
262-v skupině dál a routing ho správně přeskakuje jako optional (ROUTING OPTIONAL
263:SKIP). Automatická post-connect recovery skončila v 05:45:24 „nepodařilo se
264-ověřit stav účtů“ (viz Otevřené otázky), ruční read-only reconcile z CLI prošel.
265-
266-### 2026-09-03 (Claude, orchestrace šesti Codex agentů — sloučeno do main)
267-
268-Paralelně v šesti worktree nad `origin/main`, každý výsledek recenzován
269-Claudem a znovu ověřen celou sadou + tsc před sloučením (pořadí a61667fb →
270-1b349ef3/f25d4d01 → eee8ab36 → c1bdccfb → 4b1a1ea9): (A) násobek při změně
271-leadera, (B) dedupe replaye rejectů, (C) forenzní review pěti fail-closed
--
470-
471-### 2026-09-02 (Claude, nasazení opravy 56f36ebf)
472-
473-Oprava „známý nezpůsobilý follower = skip, ne fail-closed“ byla přenesena
474-z lokálního checkoutu na čistý worktree nad `origin/main` a pushnuta jako
475-`56f36ebf` (fast-forward `main`); Vercel produkce READY. Důvod přenosu: hlavní
476-checkout `Documents/trading-journal-aka` je 26 commitů za `origin/main`
477-a jeho pracovní strom by commit vrátil dnešní dřívější opravy
478:(`missingOptionalAccountIds`, `beginShutdown`, OAuth preflight). Při přenosu
479-se to projevilo zastaralým hunkem v `copierAccountEligibility.test.ts`, který
480-byl vrácen na verzi z `main`. Celá sada 218 souborů / 1803 testů a typecheck
481-prošly. Reinstall Mac workera přes `scripts/copier/mac-reinstall-safe.sh`
482-z tohoto commitu provádí uživatel ručně (klasifikátor Claude Code reinstall
483-blokuje); brána byla v čase předání zelená (DISARMED, connected, flat, bez
484-divergence, bez lastError). Dva účty zůstávají `breached` (62364058,
485-63338752); po opravě smějí zůstat ve skupině a budou jen přeskakovány.
486-V hlavním checkoutu zůstává necommitnutá práce Codexu (App.tsx `userId`,
--
573-s novými markery, read-only reconcile 0 divergence / 0 working orders,
574-`reconciliationRequired=false`, `lastError=null`, snímky `ready`.
575-Skupina zůstává DISARMED; DLL zámek LFE…016 vypršel s novou session
576-(autoritativně reaktivován 06:52 UTC), trvá jen BREACH 62364058.
577-
578-### 2026-09-02 (Codex, bezpečné odebrání followera zmizelého z OAuth)
579-
580-Routing refresh má místo seznamu s implicitním polykáním chyb explicitní
581:kontrakt `prepareGroupAccounts({ required, optional }) -> { missingOptional }`.
582-Při změně topologie je optional pouze follower, který je ve staré skupině,
583-není v nové a není starý ani nový leader. Všechny OAuth adresáře se vždy
584-obnoví celé: pouze nulová viditelnost optional účtu dovolí route vynechat a
585-pilot zapíše konkrétní `ROUTING OPTIONAL SKIP`; duplicita, inactive/read-only
586-stav nebo chybějící Account.name dál selžou. Leader a každý účet nové
587-topologie jsou vždy required. Žádné automatické párování ani náhrada ID
588-nevznikly.
589-
--
2659-header byly připravené; telefon po 1. neúspěchu tiše na relay). POZOR:
2660-Safari HTTPS→127.0.0.1 blokuje (WebKit bez localhost výjimky) — na Macu
2661-pro desk používat Chrome (<1 s); Safari/telefon jede relay ~2 s. Navíc
2662-enqueue endpoint long-polluje ~2,2 s na výsledek (UI bez polling koleček).
2663-Uživatel potvrdil „už to funguje rychle". Další krok pro telefon: VPS.
2664-Provozní poučení: reinstall workeru VŽDY gate-ovat na armed=False v
2665-skriptu (jednou proběhl při ARMED — jen flat, ale nesmí se opakovat).
2666-
2667:### 2026-08-21 dopoledne (Claude, connection recovery „podle stavu")
2668-Poslední nekrytý případ: výpadek spojení/pád Macu s otevřenými kopiemi.
2669-Rozhodnutí uživatele: po obnovení NE slepě „vždy zavřít" ani „vždy držet",
2670:ale PODLE STAVU. Implementace: durable stopa `safety.liveCopyOpenSince`
2671-(kopie vznikly za živého ARM; maže ji flat skupiny, ruční DISARM — vědomé
2672-„drž pozice" — a kill switch). Po reconnectu NEBO po bootu s touto stopou
2673-proběhne autoritativní reconciliation (sdílená `performReconciliation`,
2674-až 5 pokusů) a: (a) kopie synchronní s otevřeným leaderem → DRŽÍ SE
2675-(brackety chrání), status `resumeOffer` + notifikace „klikni ARM pro
2676-pokračování" — reconciliation už proběhla, ARM je jeden klik; (b) osiřelé
2677-nebo rozjeté kopie → risk-redukční auto-close (`autoClose.trigger:
2678-'reconnect'`); (c) ověření se nepovede → poctivý fail-closed s hláškou.

exec
/bin/zsh -lc 'rg -n "pendingConnectionRecovery|runConnectionRecovery|resumeLeaderFlatEpochsAfterSnapshot|liveCopyOpenSince|performReconciliation|reconfigureLeaderEpoch|auto.?flatten|orphan|osiř|workingOrderAccounts|reconciliationRequired" services/copierRuntimeController.ts' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
136:  reconciliationRequired: boolean;
138:  workingOrderAccounts: number[];
174:  /** Výsledek posledního auto-flatten (expirace ARM / fail-closed / reconnect); jen tento běh. */
218:  /** Co zavření spustilo: expirace ARM, fail-closed za live ARM, nebo osiřelé kopie po výpadku. */
282:    workingOrderAccounts: number[];
865:  let workingOrderAccounts = new Set<number>();
903:  let pendingConnectionRecovery = false;
1591:      const stored = current.state.safety.liveCopyOpenSince;
1595:        const { liveCopyOpenSince: _cleared, ...rest } = current.state.safety;
1600:        safety = { ...current.state.safety, liveCopyOpenSince: clock() };
1849:      pendingConnectionRecovery = true;
1883:              const reconciliation = await performReconciliation();
1885:                && reconciliation.workingOrderAccounts.length === 0
2142:        openedAt: currentRuntime().state.safety.liveCopyOpenSince ?? observedAt,
2224:    workingOrderAccounts = new Set(result.workingOrderAccounts);
2491:        ? 'orphan kopie byly stavově zploštěny; explicitní reconciliation je stále povinná'
2492:        : 'bezpečně vlastněné orphan kopie byly zploštěny, ale část batch snapshotu zůstala neověřená nebo detect-only',
2582:  const resumeLeaderFlatEpochsAfterSnapshot = async (): Promise<Set<string>> => {
2678:   * a čeká se na jediný klik ARM; osiřelé nebo rozjeté kopie se
2681:  const runConnectionRecovery = async () => {
2682:    if (!pendingConnectionRecovery || stopped) return;
2683:    pendingConnectionRecovery = false;
2688:      pendingConnectionRecovery = true;
2705:    let reconciliation: { divergentAccounts: number[]; workingOrderAccounts: number[] } | null = null;
2709:        pendingConnectionRecovery = true;
2713:        reconciliation = await performReconciliation({
2724:      pendingConnectionRecovery = true;
2730:    const guardedSymbols = await resumeLeaderFlatEpochsAfterSnapshot();
2740:    const orphanSymbols = new Set<string>();
2743:        if (quantity !== 0 && (leaderPositions.get(symbol) ?? 0) === 0) orphanSymbols.add(symbol);
2746:    const unguardedOrphanSymbols = [...orphanSymbols].filter(symbol => !guardedSymbols.has(symbol));
2753:        reason: `connection-recovery: detect-only orphan expozice bez durable opening epochy (${unguardedOrphanSymbols.join(', ')}); žádný broker write`,
2757:    if (orphanSymbols.size > 0) {
2760:        reason: `connection-recovery: leader-flat guard obnoven pro ${[...orphanSymbols].join(', ')}; runtime zůstává DISARMED`,
2789:          await runConnectionRecovery();
2923:      // rozhodne „podle stavu" (držet synchronní / zavřít osiřelé).
2925:        pendingConnectionRecovery = true;
2951:        if (event.resynced) pendingConnectionRecovery = true;
2969:            currentRuntime().state.safety.liveCopyOpenSince != null
2971:          ) pendingConnectionRecovery = true;
2973:        if (pendingConnectionRecovery) scheduleConnectionRecovery();
3128:        // Entry nebo orphan ochranu nad autoritativně flat účtem lze zrušit.
3661:    workingOrderAccounts: number[];
3669:  async function performReconciliation(
3801:      workingOrderAccounts = new Set(
3851:      // Reconciliation je autoritativní moment, kdy se osiřelé working
3880:        && workingOrderAccounts.size === 0;
3910:        workingOrderAccounts: [...workingOrderAccounts],
3938:  const reconfigureLeaderEpoch = async (
3983:        recoveryInFlight || pendingConnectionRecovery ? 'connection recovery' : '',
4052:          liveCopyOpenSince: _dropOpenFlag,
4093:      workingOrderAccounts = new Set();
4097:      pendingConnectionRecovery = false;
4153:      if (workingOrderAccounts.size > 0) throw new Error('Před ARM musí být všechny účty bez pracovních příkazů');
4238:      pendingConnectionRecovery = false;
4322:      const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
4323:      if (result.divergentAccounts.length === 0 && result.workingOrderAccounts.length === 0) {
4328:        pendingConnectionRecovery = false;
4391:      await reconfigureLeaderEpoch(nextGroup, reconfigurationOptions);
4398:      await reconfigureLeaderEpoch(nextGroup, {
4499:        reconciliationRequired: source.needsReconciliation() || !positionCheckComplete,
4501:        workingOrderAccounts: [...workingOrderAccounts],

exec
/bin/zsh -lc 'rg -n -C 5 "resolveMissingOptionalAccountIds|prepareGroupAccounts|missingOptionalAccountIds" scripts/copier/pilot.ts services tests | head -n 400' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
scripts/copier/pilot.ts-302-  leaderId: number,
scripts/copier/pilot.ts-303-  followerId: number,
scripts/copier/pilot.ts-304-  accounts: ExecutionAccount[],
scripts/copier/pilot.ts-305-  baseBroker: BrokerPort,
scripts/copier/pilot.ts-306-  renewableBrokers: ReadonlyArray<{ broker: TradovateBrokerPort; label: string }> = [],
scripts/copier/pilot.ts:307:  prepareGroupAccounts?: (request: PrepareGroupAccountsRequest) => Promise<PrepareGroupAccountsResult>,
scripts/copier/pilot.ts-308-): Promise<void> {
scripts/copier/pilot.ts-309-  const context = contexts[0];
scripts/copier/pilot.ts-310-  if (!context) throw new Error('Lokální agent potřebuje alespoň jedno OAuth spojení');
scripts/copier/pilot.ts-311-  const portValue = numberFlag('port', false) ?? LOCAL_COPIER_AGENT_PORT;
scripts/copier/pilot.ts-312-  const minutesValue = numberFlag('minutes', false) ?? 480;
--
scripts/copier/pilot.ts-632-        auditTail = auditTail.then(() => writeAudit(entries));
scripts/copier/pilot.ts-633-      },
scripts/copier/pilot.ts-634-      onError: logControllerError,
scripts/copier/pilot.ts-635-      // Post-connect recovery musí vidět stejný optional-skip jako ruční
scripts/copier/pilot.ts-636-      // Kontrola pozic, jinak zmizelý breached follower shodí recovery.
scripts/copier/pilot.ts:637:      resolveMissingOptionalAccountIds: prepareGroupAccounts
scripts/copier/pilot.ts:638:        ? async current => (await prepareGroupAccounts({
scripts/copier/pilot.ts-639-          required: [current.leaderAccountId],
scripts/copier/pilot.ts-640-          optional: current.followers.map(follower => follower.accountId),
scripts/copier/pilot.ts-641-        })).missingOptional
scripts/copier/pilot.ts-642-        : undefined,
scripts/copier/pilot.ts-643-      // Trade event -> okamžitý poll s příznakem -> server pushne hned.
--
scripts/copier/pilot.ts-795-      },
scripts/copier/pilot.ts-796-      onDevicePairingRestart: requestSafePairingRestart,
scripts/copier/pilot.ts-797-      onGroupChanged: async changed => {
scripts/copier/pilot.ts-798-        await groupStore.save(changed);
scripts/copier/pilot.ts-799-      },
scripts/copier/pilot.ts:800:      prepareGroupAccounts,
scripts/copier/pilot.ts-801-    });
scripts/copier/pilot.ts-802-    if (await abortLateStartupIfStopping()) return;
scripts/copier/pilot.ts-803-    const pendingPairingContexts = contexts.filter(candidate => (
scripts/copier/pilot.ts-804-      candidate.device?.state === 'pairing-required' && candidate.refreshPairing
scripts/copier/pilot.ts-805-    ));
--
tests/localCopierExecutionAgent.test.ts-289-  });
tests/localCopierExecutionAgent.test.ts-290-
tests/localCopierExecutionAgent.test.ts-291-  it('mění follower topologii přes DISARM, dynamický routing a bezpečnou epochu', async () => {
tests/localCopierExecutionAgent.test.ts-292-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts-293-    const onGroupChanged = vi.fn(async () => undefined);
tests/localCopierExecutionAgent.test.ts:294:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
tests/localCopierExecutionAgent.test.ts-295-    runtime.arm({ shadowMode: false });
tests/localCopierExecutionAgent.test.ts-296-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts:297:      controller: runtime, group: group(), port: 0, onGroupChanged, prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-298-    });
tests/localCopierExecutionAgent.test.ts-299-    const expanded = {
tests/localCopierExecutionAgent.test.ts-300-      ...group(),
tests/localCopierExecutionAgent.test.ts-301-      id: 'ui-test',
tests/localCopierExecutionAgent.test.ts-302-      followers: [
--
tests/localCopierExecutionAgent.test.ts-307-    const response = await post(running, running.status().nonce, {
tests/localCopierExecutionAgent.test.ts-308-      type: 'copy-command', command: { type: 'update-group', group: expanded },
tests/localCopierExecutionAgent.test.ts-309-    });
tests/localCopierExecutionAgent.test.ts-310-    expect(response.status).toBe(200);
tests/localCopierExecutionAgent.test.ts-311-    expect(runtime.disarm).toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts:312:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11, 22, 33], optional: [] });
tests/localCopierExecutionAgent.test.ts-313-    expect(runtime.reconfigureGroup).toHaveBeenCalledWith(expect.objectContaining({
tests/localCopierExecutionAgent.test.ts-314-      leaderAccountId: 11,
tests/localCopierExecutionAgent.test.ts-315-      followers: expect.arrayContaining([expect.objectContaining({ accountId: 33 })]),
tests/localCopierExecutionAgent.test.ts:316:    }), { missingOptionalAccountIds: [] });
tests/localCopierExecutionAgent.test.ts-317-    expect(runtime.updateGroup).not.toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts-318-    expect(vi.mocked(runtime.disarm).mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts:319:      .toBeLessThan(prepareGroupAccounts.mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts:320:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts-321-      .toBeLessThan(vi.mocked(runtime.reconfigureGroup).mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts-322-    expect(running.status().group.followers).toHaveLength(2);
tests/localCopierExecutionAgent.test.ts-323-    expect(onGroupChanged).toHaveBeenCalledWith(expect.objectContaining({
tests/localCopierExecutionAgent.test.ts-324-      followers: expect.arrayContaining([expect.objectContaining({ accountId: 33 })]),
tests/localCopierExecutionAgent.test.ts-325-    }));
tests/localCopierExecutionAgent.test.ts-326-  });
tests/localCopierExecutionAgent.test.ts-327-
tests/localCopierExecutionAgent.test.ts-328-  it('neviditelný nový účet skončí DISARMED ještě před změnou runtime', async () => {
tests/localCopierExecutionAgent.test.ts-329-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts-330-    runtime.arm({ shadowMode: false });
tests/localCopierExecutionAgent.test.ts:331:    const prepareGroupAccounts = vi.fn(async () => {
tests/localCopierExecutionAgent.test.ts-332-      throw new Error('Účet 33 není viditelný v žádném připojeném OAuth');
tests/localCopierExecutionAgent.test.ts-333-    });
tests/localCopierExecutionAgent.test.ts-334-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts:335:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-336-    });
tests/localCopierExecutionAgent.test.ts-337-
tests/localCopierExecutionAgent.test.ts-338-    const response = await post(running, running.status().nonce, {
tests/localCopierExecutionAgent.test.ts-339-      type: 'copy-command',
tests/localCopierExecutionAgent.test.ts-340-      command: {
--
tests/localCopierExecutionAgent.test.ts-356-    expect(running.status().group.followers).toHaveLength(1);
tests/localCopierExecutionAgent.test.ts-357-  });
tests/localCopierExecutionAgent.test.ts-358-
tests/localCopierExecutionAgent.test.ts-359-  it('dovolí odebrat followera bez eligibility záznamu, kterého OAuth už nevrací', async () => {
tests/localCopierExecutionAgent.test.ts-360-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts:361:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [22] }));
tests/localCopierExecutionAgent.test.ts-362-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts-363-      controller: runtime,
tests/localCopierExecutionAgent.test.ts-364-      group: group(),
tests/localCopierExecutionAgent.test.ts-365-      port: 0,
tests/localCopierExecutionAgent.test.ts:366:      prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-367-    });
tests/localCopierExecutionAgent.test.ts-368-
tests/localCopierExecutionAgent.test.ts-369-    const withoutFollower = {
tests/localCopierExecutionAgent.test.ts-370-      ...group(),
tests/localCopierExecutionAgent.test.ts-371-      followers: [],
--
tests/localCopierExecutionAgent.test.ts-374-      type: 'copy-command',
tests/localCopierExecutionAgent.test.ts-375-      command: { type: 'update-group', group: withoutFollower },
tests/localCopierExecutionAgent.test.ts-376-    });
tests/localCopierExecutionAgent.test.ts-377-
tests/localCopierExecutionAgent.test.ts-378-    expect(response.status).toBe(200);
tests/localCopierExecutionAgent.test.ts:379:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11], optional: [22] });
tests/localCopierExecutionAgent.test.ts-380-    expect(runtime.reconfigureGroup).toHaveBeenCalledWith(expect.objectContaining({
tests/localCopierExecutionAgent.test.ts-381-      followers: [],
tests/localCopierExecutionAgent.test.ts:382:    }), { missingOptionalAccountIds: [22] });
tests/localCopierExecutionAgent.test.ts-383-    expect(running.status().group.followers).toEqual([]);
tests/localCopierExecutionAgent.test.ts-384-  });
tests/localCopierExecutionAgent.test.ts-385-
tests/localCopierExecutionAgent.test.ts-386-  it('dovolí nahradit zmizelého followera, ale nový follower zůstává required', async () => {
tests/localCopierExecutionAgent.test.ts-387-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts:388:    const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => {
tests/localCopierExecutionAgent.test.ts-389-      expect(request).toEqual({ required: [11, 33], optional: [22] });
tests/localCopierExecutionAgent.test.ts-390-      return { missingOptional: [22] };
tests/localCopierExecutionAgent.test.ts-391-    });
tests/localCopierExecutionAgent.test.ts-392-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts:393:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-394-    });
tests/localCopierExecutionAgent.test.ts-395-
tests/localCopierExecutionAgent.test.ts-396-    const response = await post(running, running.status().nonce, {
tests/localCopierExecutionAgent.test.ts-397-      type: 'copy-command',
tests/localCopierExecutionAgent.test.ts-398-      command: {
--
tests/localCopierExecutionAgent.test.ts-402-    });
tests/localCopierExecutionAgent.test.ts-403-
tests/localCopierExecutionAgent.test.ts-404-    expect(response.status).toBe(200);
tests/localCopierExecutionAgent.test.ts-405-    expect(runtime.reconfigureGroup).toHaveBeenCalledWith(expect.objectContaining({
tests/localCopierExecutionAgent.test.ts-406-      followers: [expect.objectContaining({ accountId: 33 })],
tests/localCopierExecutionAgent.test.ts:407:    }), { missingOptionalAccountIds: [22] });
tests/localCopierExecutionAgent.test.ts-408-  });
tests/localCopierExecutionAgent.test.ts-409-
tests/localCopierExecutionAgent.test.ts-410-  it('odmítne routing výsledek, který by označil required účet jako chybějící optional', async () => {
tests/localCopierExecutionAgent.test.ts-411-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts:412:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [11] }));
tests/localCopierExecutionAgent.test.ts-413-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts:414:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-415-    });
tests/localCopierExecutionAgent.test.ts-416-
tests/localCopierExecutionAgent.test.ts-417-    const response = await post(running, running.status().nonce, {
tests/localCopierExecutionAgent.test.ts-418-      type: 'copy-command',
tests/localCopierExecutionAgent.test.ts-419-      command: { type: 'update-group', group: { ...group(), followers: [] } },
--
tests/localCopierExecutionAgent.test.ts-423-    expect(runtime.reconfigureGroup).not.toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts-424-  });
tests/localCopierExecutionAgent.test.ts-425-
tests/localCopierExecutionAgent.test.ts-426-  it('zmizelý leader zůstává při routing change povinný', async () => {
tests/localCopierExecutionAgent.test.ts-427-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts:428:    const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => {
tests/localCopierExecutionAgent.test.ts-429-      expect(request.required).toContain(11);
tests/localCopierExecutionAgent.test.ts-430-      throw new Error('Účet 11 není viditelný v žádném připojeném OAuth');
tests/localCopierExecutionAgent.test.ts-431-    });
tests/localCopierExecutionAgent.test.ts-432-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts:433:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-434-    });
tests/localCopierExecutionAgent.test.ts-435-
tests/localCopierExecutionAgent.test.ts-436-    const response = await post(running, running.status().nonce, {
tests/localCopierExecutionAgent.test.ts-437-      type: 'copy-command',
tests/localCopierExecutionAgent.test.ts-438-      command: {
--
tests/localCopierExecutionAgent.test.ts-449-    expect(runtime.reconfigureGroup).not.toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts-450-  });
tests/localCopierExecutionAgent.test.ts-451-
tests/localCopierExecutionAgent.test.ts-452-  it('zmizelý follower, který v next zůstává, není optional', async () => {
tests/localCopierExecutionAgent.test.ts-453-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts:454:    const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => {
tests/localCopierExecutionAgent.test.ts-455-      expect(request).toEqual({ required: [11, 22, 33], optional: [] });
tests/localCopierExecutionAgent.test.ts-456-      throw new Error('Účet 22 není viditelný v žádném připojeném OAuth');
tests/localCopierExecutionAgent.test.ts-457-    });
tests/localCopierExecutionAgent.test.ts-458-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts:459:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-460-    });
tests/localCopierExecutionAgent.test.ts-461-
tests/localCopierExecutionAgent.test.ts-462-    const response = await post(running, running.status().nonce, {
tests/localCopierExecutionAgent.test.ts-463-      type: 'copy-command',
tests/localCopierExecutionAgent.test.ts-464-      command: {
--
tests/localCopierExecutionAgent.test.ts-495-    expect(response.status).toBe(200);
tests/localCopierExecutionAgent.test.ts-496-    expect(runtime.reconfigureGroup).toHaveBeenCalledWith(expect.objectContaining({
tests/localCopierExecutionAgent.test.ts-497-      id: 'runtime-test',
tests/localCopierExecutionAgent.test.ts-498-      leaderAccountId: 22,
tests/localCopierExecutionAgent.test.ts-499-      followers: [expect.objectContaining({ accountId: 11 })],
tests/localCopierExecutionAgent.test.ts:500:    }), { missingOptionalAccountIds: [] });
tests/localCopierExecutionAgent.test.ts-501-    expect(runtime.updateGroup).not.toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts-502-    expect(running.status().group).toMatchObject({ leaderAccountId: 22 });
tests/localCopierExecutionAgent.test.ts-503-    expect(onGroupChanged).toHaveBeenCalledWith(expect.objectContaining({ leaderAccountId: 22 }));
tests/localCopierExecutionAgent.test.ts-504-  });
tests/localCopierExecutionAgent.test.ts-505-
tests/localCopierExecutionAgent.test.ts-506-  it('aktivuje jiný uložený profil přes samostatný fail-closed příkaz a zůstane DISARMED', async () => {
tests/localCopierExecutionAgent.test.ts-507-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts-508-    const onGroupChanged = vi.fn(async () => undefined);
tests/localCopierExecutionAgent.test.ts:509:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
tests/localCopierExecutionAgent.test.ts-510-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts-511-      controller: runtime,
tests/localCopierExecutionAgent.test.ts-512-      group: group(),
tests/localCopierExecutionAgent.test.ts-513-      port: 0,
tests/localCopierExecutionAgent.test.ts-514-      onGroupChanged,
tests/localCopierExecutionAgent.test.ts:515:      prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-516-    });
tests/localCopierExecutionAgent.test.ts-517-    const next: CopyGroupConfig = {
tests/localCopierExecutionAgent.test.ts-518-      id: 'lucid-profile',
tests/localCopierExecutionAgent.test.ts-519-      name: 'Lucid profil',
tests/localCopierExecutionAgent.test.ts-520-      enabled: false,
--
tests/localCopierExecutionAgent.test.ts-525-
tests/localCopierExecutionAgent.test.ts-526-    const result = await running.execute({ type: 'activate-group', group: next });
tests/localCopierExecutionAgent.test.ts-527-
tests/localCopierExecutionAgent.test.ts-528-    expect(result.ok).toBe(true);
tests/localCopierExecutionAgent.test.ts-529-    expect(runtime.disarm).toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts:530:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11, 33, 44], optional: [22] });
tests/localCopierExecutionAgent.test.ts-531-    expect(vi.mocked(runtime.disarm).mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts:532:      .toBeLessThan(prepareGroupAccounts.mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts:533:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts-534-      .toBeLessThan(vi.mocked(runtime.activateGroup).mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts-535-    expect(runtime.activateGroup).toHaveBeenCalledWith({
tests/localCopierExecutionAgent.test.ts-536-      ...next,
tests/localCopierExecutionAgent.test.ts-537-      enabled: true,
tests/localCopierExecutionAgent.test.ts-538-      localOnly: true,
tests/localCopierExecutionAgent.test.ts:539:    }, { missingOptionalAccountIds: [] });
tests/localCopierExecutionAgent.test.ts-540-    expect(runtime.arm).not.toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts-541-    expect(running.status().controller.armed).toBe(false);
tests/localCopierExecutionAgent.test.ts-542-    expect(running.status().group).toMatchObject({ id: 'lucid-profile', enabled: true });
tests/localCopierExecutionAgent.test.ts-543-    expect(onGroupChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'lucid-profile' }));
tests/localCopierExecutionAgent.test.ts-544-  });
--
tests/localCopierExecutionAgent.test.ts-588-    expect(response.status).toBe(409);
tests/localCopierExecutionAgent.test.ts-589-    expect(running.status().group.leaderAccountId).toBe(11);
tests/localCopierExecutionAgent.test.ts-590-    expect(runtime.reconfigureGroup).toHaveBeenNthCalledWith(
tests/localCopierExecutionAgent.test.ts-591-      1,
tests/localCopierExecutionAgent.test.ts-592-      expect.objectContaining({ leaderAccountId: 22 }),
tests/localCopierExecutionAgent.test.ts:593:      { missingOptionalAccountIds: [] },
tests/localCopierExecutionAgent.test.ts-594-    );
tests/localCopierExecutionAgent.test.ts-595-    expect(runtime.reconfigureGroup).toHaveBeenNthCalledWith(2, expect.objectContaining({ leaderAccountId: 11 }));
tests/localCopierExecutionAgent.test.ts-596-  });
tests/localCopierExecutionAgent.test.ts-597-
tests/localCopierExecutionAgent.test.ts-598-  it('reconciles before ARM and remains disarmed when reconciliation fails', async () => {
--
tests/localCopierExecutionAgent.test.ts-604-    expect(runtime.arm).not.toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts-605-  });
tests/localCopierExecutionAgent.test.ts-606-
tests/localCopierExecutionAgent.test.ts-607-  it('před každým ARM obnoví routing a až potom provede reconciliation', async () => {
tests/localCopierExecutionAgent.test.ts-608-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts:609:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
tests/localCopierExecutionAgent.test.ts-610-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts:611:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-612-    });
tests/localCopierExecutionAgent.test.ts-613-
tests/localCopierExecutionAgent.test.ts-614-    const response = await post(running, running.status().nonce, { type: 'arm-live' });
tests/localCopierExecutionAgent.test.ts-615-    expect(response.status).toBe(200);
tests/localCopierExecutionAgent.test.ts:616:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11, 22], optional: [] });
tests/localCopierExecutionAgent.test.ts:617:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts-618-      .toBeLessThan(vi.mocked(runtime.reconcile).mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts-619-    expect(vi.mocked(runtime.reconcile).mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts-620-      .toBeLessThan(vi.mocked(runtime.arm).mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts-621-  });
tests/localCopierExecutionAgent.test.ts-622-
tests/localCopierExecutionAgent.test.ts-623-  it('cíleně ověří účet bez změny execution skupiny nebo ARM', async () => {
tests/localCopierExecutionAgent.test.ts-624-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts:625:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
tests/localCopierExecutionAgent.test.ts-626-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts:627:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-628-    });
tests/localCopierExecutionAgent.test.ts-629-
tests/localCopierExecutionAgent.test.ts-630-    const result = await running.execute({ type: 'verify-account-eligibility', accountId: 63338752 });
tests/localCopierExecutionAgent.test.ts-631-
tests/localCopierExecutionAgent.test.ts-632-    expect(result.ok).toBe(true);
tests/localCopierExecutionAgent.test.ts:633:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [63338752], optional: [] });
tests/localCopierExecutionAgent.test.ts:634:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts-635-      .toBeLessThan(vi.mocked(runtime.verifyAccountEligibility).mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts-636-    expect(runtime.verifyAccountEligibility).toHaveBeenCalledWith(63338752);
tests/localCopierExecutionAgent.test.ts-637-    expect(runtime.activateGroup).not.toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts-638-    expect(runtime.arm).not.toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts-639-  });
--
tests/localCopierExecutionAgent.test.ts-648-    expect(runtime.arm).toHaveBeenCalledWith({ shadowMode: true });
tests/localCopierExecutionAgent.test.ts-649-  });
tests/localCopierExecutionAgent.test.ts-650-
tests/localCopierExecutionAgent.test.ts-651-  it('exposes read-only reconciliation and audited stuck resolution as separate commands', async () => {
tests/localCopierExecutionAgent.test.ts-652-    const runtime = controller();
tests/localCopierExecutionAgent.test.ts:653:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [22] }));
tests/localCopierExecutionAgent.test.ts-654-    running = await startLocalCopierExecutionAgent({
tests/localCopierExecutionAgent.test.ts:655:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
tests/localCopierExecutionAgent.test.ts-656-    });
tests/localCopierExecutionAgent.test.ts-657-
tests/localCopierExecutionAgent.test.ts-658-    expect((await post(running, running.status().nonce, { type: 'reconcile' })).status).toBe(200);
tests/localCopierExecutionAgent.test.ts:659:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11], optional: [22] });
tests/localCopierExecutionAgent.test.ts:660:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts-661-      .toBeLessThan(vi.mocked(runtime.reconcile).mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts-662-    expect(runtime.reconcile).toHaveBeenCalledTimes(1);
tests/localCopierExecutionAgent.test.ts:663:    expect(runtime.reconcile).toHaveBeenCalledWith({ missingOptionalAccountIds: [22] });
tests/localCopierExecutionAgent.test.ts-664-
tests/localCopierExecutionAgent.test.ts-665-    expect((await post(running, running.status().nonce, {
tests/localCopierExecutionAgent.test.ts-666-      type: 'resolve-stuck-operation',
tests/localCopierExecutionAgent.test.ts-667-      kind: 'cancel-or-modify',
tests/localCopierExecutionAgent.test.ts-668-      key: 'cm:test:22',
--
tests/localCopierExecutionAgent.test.ts-961-        group: { ...group(), id: 'jiny-profil' },
tests/localCopierExecutionAgent.test.ts-962-      });
tests/localCopierExecutionAgent.test.ts-963-      expect(runtime.disarm).toHaveBeenCalled();
tests/localCopierExecutionAgent.test.ts-964-      expect(runtime.activateGroup).toHaveBeenCalledWith(expect.objectContaining({
tests/localCopierExecutionAgent.test.ts-965-        id: 'jiny-profil', enabled: true,
tests/localCopierExecutionAgent.test.ts:966:      }), { missingOptionalAccountIds: [] });
tests/localCopierExecutionAgent.test.ts-967-      expect(runtime.activateGroup.mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts-968-        .toBeLessThan(runtime.reconcile.mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts-969-      expect(runtime.reconcile.mock.invocationCallOrder[0])
tests/localCopierExecutionAgent.test.ts-970-        .toBeLessThan(runtime.arm.mock.invocationCallOrder[0]);
tests/localCopierExecutionAgent.test.ts-971-      expect(agent.status().group.id).toBe('jiny-profil');
--
tests/copierAccountEligibility.test.ts-446-    });
tests/copierAccountEligibility.test.ts-447-    broker.setConnected(true);
tests/copierAccountEligibility.test.ts-448-    await controller.waitForIdle();
tests/copierAccountEligibility.test.ts-449-
tests/copierAccountEligibility.test.ts-450-    await expect(controller.reconfigureGroup(nextGroup, {
tests/copierAccountEligibility.test.ts:451:      missingOptionalAccountIds: [205],
tests/copierAccountEligibility.test.ts-452-    })).resolves.toBeUndefined();
tests/copierAccountEligibility.test.ts-453-    expect(controller.status()).toMatchObject({
tests/copierAccountEligibility.test.ts-454-      armed: false,
tests/copierAccountEligibility.test.ts-455-      reconciliationRequired: true,
tests/copierAccountEligibility.test.ts-456-    });
--
tests/copierRuntimeController.test.ts-510-    await controller.waitForIdle();
tests/copierRuntimeController.test.ts-511-
tests/copierRuntimeController.test.ts-512-    await expect(controller.reconfigureGroup({
tests/copierRuntimeController.test.ts-513-      ...group,
tests/copierRuntimeController.test.ts-514-      followers: [{ accountId: 300, mode: 'on-submit', multiplier: 1 }],
tests/copierRuntimeController.test.ts:515:    }, { missingOptionalAccountIds: [200] })).resolves.toBeUndefined();
tests/copierRuntimeController.test.ts-516-
tests/copierRuntimeController.test.ts-517-    expect(listPositions).toHaveBeenCalledWith(100);
tests/copierRuntimeController.test.ts-518-    expect(listPositions).toHaveBeenCalledWith(300);
tests/copierRuntimeController.test.ts-519-    expect(listPositions).not.toHaveBeenCalledWith(200);
tests/copierRuntimeController.test.ts-520-    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
--
tests/copierRuntimeController.test.ts-1475-      broker: router, store: createMemoryCopierStore(), group, clock: stepClock(),
tests/copierRuntimeController.test.ts-1476-    });
tests/copierRuntimeController.test.ts-1477-    connection.setConnected(true);
tests/copierRuntimeController.test.ts-1478-    await controller.waitForIdle();
tests/copierRuntimeController.test.ts-1479-
tests/copierRuntimeController.test.ts:1480:    await expect(controller.reconcile({ missingOptionalAccountIds: [200] })).resolves.toEqual({
tests/copierRuntimeController.test.ts-1481-      divergentAccounts: [], workingOrderAccounts: [],
tests/copierRuntimeController.test.ts-1482-    });
tests/copierRuntimeController.test.ts-1483-    expect(controller.status()).toMatchObject({
tests/copierRuntimeController.test.ts-1484-      armed: false,
tests/copierRuntimeController.test.ts-1485-      reconciliationRequired: false,
--
tests/copierConnectionRecoveryOptionalFollower.test.ts-26-  ...group,
tests/copierConnectionRecoveryOptionalFollower.test.ts-27-  followers: group.followers.filter(follower => follower.accountId !== MISSING),
tests/copierConnectionRecoveryOptionalFollower.test.ts-28-};
tests/copierConnectionRecoveryOptionalFollower.test.ts-29-
tests/copierConnectionRecoveryOptionalFollower.test.ts-30-const harness = async (options: {
tests/copierConnectionRecoveryOptionalFollower.test.ts:31:  resolveMissingOptionalAccountIds?: (current: CopyGroupConfig) => Promise<readonly number[]>;
tests/copierConnectionRecoveryOptionalFollower.test.ts-32-} = {}) => {
tests/copierConnectionRecoveryOptionalFollower.test.ts-33-  const initial = emptySnapshot();
tests/copierConnectionRecoveryOptionalFollower.test.ts-34-  initial.safety = {
tests/copierConnectionRecoveryOptionalFollower.test.ts-35-    entryCooldownUntil: 0,
tests/copierConnectionRecoveryOptionalFollower.test.ts-36-    dayLockUntil: 0,
--
tests/copierConnectionRecoveryOptionalFollower.test.ts-73-    const h = await harness();
tests/copierConnectionRecoveryOptionalFollower.test.ts-74-    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
tests/copierConnectionRecoveryOptionalFollower.test.ts-75-    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
tests/copierConnectionRecoveryOptionalFollower.test.ts-76-
tests/copierConnectionRecoveryOptionalFollower.test.ts-77-    // Stav po včerejšku: příznak recovery blokuje reconfigure i po jejím selhání.
tests/copierConnectionRecoveryOptionalFollower.test.ts:78:    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
tests/copierConnectionRecoveryOptionalFollower.test.ts-79-      .rejects.toThrow('connection recovery');
tests/copierConnectionRecoveryOptionalFollower.test.ts-80-
tests/copierConnectionRecoveryOptionalFollower.test.ts-81-    // Ruční Kontrola pozic se stejným optional skipem jako CLI/UI projde…
tests/copierConnectionRecoveryOptionalFollower.test.ts:82:    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
tests/copierConnectionRecoveryOptionalFollower.test.ts-83-      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
tests/copierConnectionRecoveryOptionalFollower.test.ts-84-    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
tests/copierConnectionRecoveryOptionalFollower.test.ts-85-
tests/copierConnectionRecoveryOptionalFollower.test.ts-86-    // …a čistý výsledek recovery příznak shodí: odebrání zmizelého followera už projde.
tests/copierConnectionRecoveryOptionalFollower.test.ts:87:    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
tests/copierConnectionRecoveryOptionalFollower.test.ts-88-      .resolves.toBeUndefined();
tests/copierConnectionRecoveryOptionalFollower.test.ts-89-    expect(h.controller.status().armed).toBe(false);
tests/copierConnectionRecoveryOptionalFollower.test.ts-90-    h.controller.stop();
tests/copierConnectionRecoveryOptionalFollower.test.ts-91-  });
tests/copierConnectionRecoveryOptionalFollower.test.ts-92-
tests/copierConnectionRecoveryOptionalFollower.test.ts-93-  it('s optional-skip zdrojem recovery projde napoprvé a skupina není blokovaná', async () => {
tests/copierConnectionRecoveryOptionalFollower.test.ts-94-    const seen: CopyGroupConfig[] = [];
tests/copierConnectionRecoveryOptionalFollower.test.ts-95-    const h = await harness({
tests/copierConnectionRecoveryOptionalFollower.test.ts:96:      resolveMissingOptionalAccountIds: async current => {
tests/copierConnectionRecoveryOptionalFollower.test.ts-97-        seen.push(current);
tests/copierConnectionRecoveryOptionalFollower.test.ts-98-        return [MISSING, 999_999];
tests/copierConnectionRecoveryOptionalFollower.test.ts-99-      },
tests/copierConnectionRecoveryOptionalFollower.test.ts-100-    });
tests/copierConnectionRecoveryOptionalFollower.test.ts-101-    expect(seen.length).toBeGreaterThan(0);
tests/copierConnectionRecoveryOptionalFollower.test.ts-102-    expect(h.errors).toEqual([]);
tests/copierConnectionRecoveryOptionalFollower.test.ts-103-    expect(h.controller.status()).toMatchObject({
tests/copierConnectionRecoveryOptionalFollower.test.ts-104-      armed: false, reconciliationRequired: false, lastError: null,
tests/copierConnectionRecoveryOptionalFollower.test.ts-105-    });
tests/copierConnectionRecoveryOptionalFollower.test.ts:106:    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
tests/copierConnectionRecoveryOptionalFollower.test.ts-107-      .resolves.toBeUndefined();
tests/copierConnectionRecoveryOptionalFollower.test.ts-108-    h.controller.stop();
tests/copierConnectionRecoveryOptionalFollower.test.ts-109-  });
tests/copierConnectionRecoveryOptionalFollower.test.ts-110-

exec
/bin/zsh -lc 'git log --oneline --decorate -15' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 1998ms:
git: error: couldn't create cache file '/tmp/xcrun_db-6OgAiGDV' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-PO0RXiNc' (errno=Operation not permitted)
5154856d (HEAD -> codex/reconnect-fix-20260903, origin/main, origin/HEAD) fix(copier): post-connect recovery honours OAuth-missing followers; clean manual reconcile clears the recovery flag
1bd779aa (origin/claude/companion-gear-focus-20260903, codex/unavailable-follower-ux-20260903) fix(companion): settings gear without system focus ring (build 7)
7ac5fdb6 (origin/codex/companion-autoopen-20260903, codex/companion-autoopen-20260903) docs(companion): build 6 installed and merged
12684fda docs(companion): record review fixes and build 6
58f16fdf fix(companion): preserve transition state and throttle alerts
9f360bdd docs(companion): record build 6 verification
8e247230 feat(companion): present transitions without stealing focus
79566289 feat(companion): detect and gate status transitions
731cc0b6 docs(log): open question — post-connect recovery vs OAuth-missing follower
9b6e878e docs(log): worker rollout 03d1fc5f
03d1fc5f docs(log): 2026-09-03 orchestration summary and pending items
4b1a1ea9 (origin/codex/reconnect-fix-20260903) fix(copier): reconnect state machine never ends in a silent terminal state
c1bdccfb (origin/codex/stats-labels-20260903, codex/stats-labels-20260903) feat(copier): label daily stats as leader-only and classify stop exits correctly
eee8ab36 (origin/codex/disarm-ux-20260903, codex/disarm-ux-20260903) feat(copier): explain every disarm — reason, what happened to copies, next step
f25d4d01 (origin/codex/reject-replay-20260903, codex/reject-replay-20260903) docs(copier): forensic review of 2026-09-02 fail-closed incidents (Codex read-only)

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '840,930p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
   840	        leaderStopOrderIds.delete(lastFill);
   841	        leaderTargetOrderIds.delete(lastFill);
   842	      }
   843	      return {
   844	        exitReason,
   845	        ...(closed?.realizedPnlUsd != null ? { pnlUsd: closed.realizedPnlUsd } : {}),
   846	      };
   847	    };
   848	    if (previousNet === 0 && nextNet !== 0) {
   849	      plannedEntryBySymbol.delete(symbol);
   850	      pushCopyEvent('entry', symbol, nextNet > 0 ? 'Long' : 'Short', Math.abs(nextNet), at);
   851	    } else if (previousNet !== 0 && nextNet === 0) {
   852	      pushCopyEvent('exit', symbol, previousNet > 0 ? 'Long' : 'Short', Math.abs(previousNet), at, exitExtra());
   853	    } else if (Math.sign(previousNet) !== Math.sign(nextNet)) {
   854	      pushCopyEvent('flip', symbol, nextNet > 0 ? 'Long' : 'Short', Math.abs(nextNet), at, exitExtra());
   855	    } else if (Math.abs(nextNet) > Math.abs(previousNet)) {
   856	      pushCopyEvent('scale-in', symbol, nextNet > 0 ? 'Long' : 'Short', Math.abs(nextNet - previousNet), at);
   857	    } else if (Math.abs(nextNet) < Math.abs(previousNet)) {
   858	      pushCopyEvent('scale-out', symbol, previousNet > 0 ? 'Long' : 'Short', Math.abs(previousNet - nextNet), at);
   859	    }
   860	  };
   861	  let stopped = false;
   862	  let shutdownRequested = false;
   863	  let shutdownPromise: Promise<void> | null = null;
   864	  let positionCheckComplete = false;
   865	  let workingOrderAccounts = new Set<number>();
   866	  let lastError: Error | null = null;
   867	  let lastDisarm: CopierDisarmRecord | undefined;
   868	  const disarmHistory: CopierDisarmRecord[] = [];
   869	  let lastOauthPreflight: NonNullable<CopierControllerStatus['oauthPreflight']> | undefined;
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

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '1560,1625p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
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
  1616	  };
  1617	
  1618	  const maybeActivateCooldown = async (now: number, symbol: string) => {
  1619	    const cooldownMinutes = group.safety?.entryCooldownMinutes ?? 0;
  1620	    if (!cooldownPending || cooldownMinutes <= 0 || !groupIsFlat()) return;
  1621	    cooldownPending = false;
  1622	    const safety = {
  1623	      ...currentRuntime().state.safety,
  1624	      entryCooldownUntil: Math.max(
  1625	        currentRuntime().state.safety.entryCooldownUntil,

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '1810,1915p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  1810	      autoClose?: boolean;
  1811	      reconcileAfterTerminalFill?: boolean;
  1812	    } = {},
  1813	  ) => {
  1814	    const wasArmed = gate.armed;
  1815	    const wasLiveArmed = gate.armed && !gate.shadowMode;
  1816	    invalidateReconciliation();
  1817	    lastError = errorOf(reason);
  1818	    const disarm = wasArmed
  1819	      ? recordDisarm(
  1820	          failure.transportLost ? 'transport' : 'fail-closed',
  1821	          lastError.message,
  1822	          groupIsFlat()
  1823	            ? 'flat'
  1824	            : 'unknown',
  1825	        )
  1826	      : undefined;
  1827	    gate = {
  1828	      ...gate,
  1829	      armed: false,
  1830	      shadowMode: true,
  1831	      ...(failure.transportLost ? { connected: false } : {}),
  1832	    };
  1833	    // Interní nejistota odzbrojí copier a vynutí novou autoritativní kontrolu,
  1834	    // ale nesmí předstírat fyzický disconnect. Živé spojení je potřeba právě
  1835	    // proto, aby mohly doběhnout risk-redukující cancely už známých objednávek.
  1836	    if (failure.transportLost) source.connection(false);
  1837	    options.onError?.(lastError);
  1838	    // Fail-closed uprostřed živého obchodu nesmí nechat kopie viset bez
  1839	    // dozoru (živý incident: rejected modify zabil follower SL a exit
  1840	    // leadera o 9 s později už byl blokovaný). Bez transportu zavřít nejde
  1841	    // a kill switch je explicitní freeze — obojí kryje jen notifikace.
  1842	    if (wasLiveArmed && !failure.transportLost && !gate.killSwitch && failure.autoClose !== false) {
  1843	      scheduleAutoClose('fail-closed', {
  1844	        reconcileAfterTerminalFill: failure.reconcileAfterTerminalFill === true,
  1845	      }, disarm?.at);
  1846	    }
  1847	    if (wasLiveArmed && failure.transportLost && hasFollowerExposure()) {
  1848	      // Bez transportu zavírat nejde — rozhodne se po reconnectu podle stavu.
  1849	      pendingConnectionRecovery = true;
  1850	    }
  1851	  };
  1852	
  1853	  /**
  1854	   * Naplánuje risk-redukující zavření kopií na konec event fronty. Jednorázové
  1855	   * per epizoda: selhání zavření volá failClosed už odzbrojené (wasLiveArmed
  1856	   * = false), takže se smyčka nikdy neroztočí.
  1857	   */
  1858	  const scheduleAutoClose = (
  1859	    trigger: 'fail-closed',
  1860	    recovery: { reconcileAfterTerminalFill?: boolean } = {},
  1861	    disarmAt = lastDisarm?.trigger === 'fail-closed' ? lastDisarm.at : undefined,
  1862	  ) => {
  1863	    if (autoCloseInFlight || stopped) return;
  1864	    autoCloseInFlight = true;
  1865	    const seed = clock();
  1866	    eventTail = eventTail
  1867	      .then(async () => {
  1868	        try {
  1869	          const autoCloseSafeForRecovery = await autoFlattenCopies(trigger, seed);
  1870	          if (disarmAt != null) {
  1871	            updateDisarmOutcome(
  1872	              disarmAt,
  1873	              autoCloseSafeForRecovery ? successfulAutoCloseOutcome(disarmAt) : 'unknown',
  1874	            );
  1875	          }
  1876	          if (
  1877	            recovery.reconcileAfterTerminalFill
  1878	            && autoCloseSafeForRecovery
  1879	            && gate.connected
  1880	            && !gate.killSwitch
  1881	          ) {
  1882	            try {
  1883	              const reconciliation = await performReconciliation();
  1884	              const clean = reconciliation.divergentAccounts.length === 0
  1885	                && reconciliation.workingOrderAccounts.length === 0
  1886	                && !hasStuckOutbox();
  1887	              options.onAudit?.([{
  1888	                at: clock(),
  1889	                leaderEventId: `terminal-fill-reconciliation:${seed}`,
  1890	                kind: clean ? 'recovered' : 'blocked',
  1891	                reason: clean
  1892	                  ? 'modify skončil filled; následná autoritativní reconciliation potvrdila synchronní flat/no-active stav'
  1893	                  : 'modify skončil filled; následná autoritativní reconciliation nepotvrdila bezpečný synchronní stav',
  1894	              }]);
  1895	            } catch (error) {
  1896	              options.onAudit?.([{
  1897	                at: clock(),
  1898	                leaderEventId: `terminal-fill-reconciliation:${seed}`,
  1899	                kind: 'blocked',
  1900	                reason: `modify skončil filled; následná autoritativní reconciliation selhala: ${errorOf(error).message}`,
  1901	              }]);
  1902	            }
  1903	          }
  1904	        } finally {
  1905	          autoCloseInFlight = false;
  1906	        }
  1907	      })
  1908	      .catch(reason => {
  1909	        autoCloseInFlight = false;
  1910	        failClosed(reason);
  1911	      });
  1912	  };
  1913	
  1914	  const followerTransitionKey = (accountId: number, symbol: string) => `${accountId}:${symbol}`;
  1915	

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '2560,2805p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
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
  2696	    if (options.resolveMissingOptionalAccountIds) {
  2697	      try {
  2698	        const followerIds = new Set(group.followers.map(follower => follower.accountId));
  2699	        missingOptionalAccountIds = [...new Set(await options.resolveMissingOptionalAccountIds(group))]
  2700	          .filter(accountId => followerIds.has(accountId) && accountId !== group.leaderAccountId);
  2701	      } catch {
  2702	        missingOptionalAccountIds = [];
  2703	      }
  2704	    }
  2705	    let reconciliation: { divergentAccounts: number[]; workingOrderAccounts: number[] } | null = null;
  2706	    for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
  2707	      if (attempt > 0) await wait(2_000);
  2708	      if (!gate.connected) {
  2709	        pendingConnectionRecovery = true;
  2710	        return;
  2711	      }
  2712	      try {
  2713	        reconciliation = await performReconciliation({
  2714	          missingOptionalAccountIds: [...missingOptionalAccountIds],
  2715	        });
  2716	        break;
  2717	      } catch {
  2718	        // Spojení je čerstvé — pár pokusů, pak poctivé přiznání níže.
  2719	      }
  2720	    }
  2721	    if (!reconciliation) {
  2722	      // Pět rychlých pokusů je jen jedna recovery vlna. Příští potvrzený
  2723	      // connected event ji musí smět spustit znovu; stav zůstává DISARMED.
  2724	      pendingConnectionRecovery = true;
  2725	      failClosed(new Error(
  2726	        'connection=aggregate phase=reconciliation Po obnovení spojení se nepodařilo ověřit stav účtů — kopie zůstávají chráněné brackety, zkontroluj Tradovate',
  2727	      ));
  2728	      return;
  2729	    }
  2730	    const guardedSymbols = await resumeLeaderFlatEpochsAfterSnapshot();
  2731	    if (!hasFollowerExposure()) {
  2732	      if (lastDisarm?.trigger === 'transport') updateDisarmOutcome(lastDisarm.at, 'flat');
  2733	      await syncLiveCopyExposureFlag('clear');
  2734	      options.onAudit?.([{
  2735	        at: clock(), leaderEventId: 'connection-recovery', kind: 'recovered',
  2736	        reason: 'connection-recovery: autoritativní reconciliation potvrdila flat/no-active stav; runtime zůstává DISARMED',
  2737	      }]);
  2738	      return;
  2739	    }
  2740	    const orphanSymbols = new Set<string>();
  2741	    for (const follower of group.followers) {
  2742	      for (const [symbol, quantity] of positionsByAccount.get(follower.accountId) ?? []) {
  2743	        if (quantity !== 0 && (leaderPositions.get(symbol) ?? 0) === 0) orphanSymbols.add(symbol);
  2744	      }
  2745	    }
  2746	    const unguardedOrphanSymbols = [...orphanSymbols].filter(symbol => !guardedSymbols.has(symbol));
  2747	    if (unguardedOrphanSymbols.length > 0) {
  2748	      failClosed(new Error(
  2749	        `Copier fail-closed: po reconnectu je leader flat a follower má neověřenou expozici (${unguardedOrphanSymbols.join(', ')}); bez opening ownership se automaticky nezavírá`,
  2750	      ), { autoClose: false });
  2751	      options.onAudit?.([{
  2752	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2753	        reason: `connection-recovery: detect-only orphan expozice bez durable opening epochy (${unguardedOrphanSymbols.join(', ')}); žádný broker write`,
  2754	      }]);
  2755	      return;
  2756	    }
  2757	    if (orphanSymbols.size > 0) {
  2758	      options.onAudit?.([{
  2759	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2760	        reason: `connection-recovery: leader-flat guard obnoven pro ${[...orphanSymbols].join(', ')}; runtime zůstává DISARMED`,
  2761	      }]);
  2762	      return;
  2763	    }
  2764	    const leaderOpen = [...(positionsByAccount.get(group.leaderAccountId)?.values() ?? [])]
  2765	      .some(quantity => quantity !== 0);
  2766	    if (leaderOpen && reconciliation.divergentAccounts.length === 0) {
  2767	      if (lastDisarm?.trigger === 'transport') {
  2768	        updateDisarmOutcome(lastDisarm.at, 'left-open-protected');
  2769	      }
  2770	      lastResumeOffer = null;
  2771	      options.onAudit?.([{
  2772	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2773	        reason: 'connection-recovery: kopie jsou synchronní s leaderem — drženy DISARMED, ARM je blokovaný do flat',
  2774	      }]);
  2775	      return;
  2776	    }
  2777	    const flat = await autoFlattenCopies('reconnect', clock());
  2778	    if (lastDisarm?.trigger === 'transport') {
  2779	      updateDisarmOutcome(lastDisarm.at, flat ? 'auto-closed' : 'unknown');
  2780	    }
  2781	  };
  2782	
  2783	  const scheduleConnectionRecovery = () => {
  2784	    if (recoveryInFlight || stopped) return;
  2785	    recoveryInFlight = true;
  2786	    eventTail = eventTail
  2787	      .then(async () => {
  2788	        try {
  2789	          await runConnectionRecovery();
  2790	        } finally {
  2791	          recoveryInFlight = false;
  2792	        }
  2793	      })
  2794	      .catch(reason => {
  2795	        recoveryInFlight = false;
  2796	        failClosed(reason);
  2797	      });
  2798	  };
  2799	
  2800	  /**
  2801	   * Expirace ARM nesmí nechat kopie viset bez dozoru. Vyhodnocuje se
  2802	   * event-driven (heartbeat chodí každé ~2,5 s) proti injektovaným hodinám,
  2803	   * takže je plně deterministická. Shadow ARM nikdy nic neposílá, ani při
  2804	   * expiraci.
  2805	   */

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '2885,2990p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  2885	      });
  2886	      runtime = result.runtime;
  2887	      if (result.audit.length > 0) options.onAudit?.(result.audit);
  2888	      failClosedOnCriticalAudit(result.audit);
  2889	      if (pending.kind === 'submitted'
  2890	        && (pending.orderType === 'Limit' || pending.orderType === 'Stop' || pending.orderType === 'StopLimit')
  2891	        && auditCleanDispatch(result.audit, 'dispatched')) {
  2892	        const pendingEntryPrice = pending.limitPrice ?? pending.stopPrice;
  2893	        if (pendingEntryPrice != null) {
  2894	          rememberPlannedEntry(pending.symbol, pendingEntryPrice, (pending.side === 'Buy' ? 1 : -1) * pending.quantity);
  2895	        }
  2896	        pushCopyEvent('order-placed', pending.symbol,
  2897	          pending.side === 'Buy' ? 'Long' : 'Short', pending.quantity, clock(), {
  2898	            ...(pendingEntryPrice != null ? { price: pendingEntryPrice } : {}),
  2899	          });
  2900	      }
  2901	    } catch (error) {
  2902	      failClosed(error);
  2903	    } finally {
  2904	      settleOsoFlush(entryOrderId);
  2905	    }
  2906	  };
  2907	
  2908	  const handleBrokerEvent = async (event: BrokerEvent) => {
  2909	    if (stopped) return;
  2910	    const now = clock();
  2911	    if (event.type === 'heartbeat') {
  2912	      gate = { ...gate, lastHeartbeatAt: event.at };
  2913	      await maybeHandleArmExpiry(now);
  2914	      return;
  2915	    }
  2916	    if (event.type === 'error') {
  2917	      failClosed(event.error, { transportLost: true });
  2918	      return;
  2919	    }
  2920	    if (event.type === 'connection') {
  2921	      const wasArmed = gate.armed;
  2922	      // Výpadek za živého ARM s otevřenými kopiemi → po reconnectu se
  2923	      // rozhodne „podle stavu" (držet synchronní / zavřít osiřelé).
  2924	      if (!event.connected && gate.armed && !gate.shadowMode && hasFollowerExposure()) {
  2925	        pendingConnectionRecovery = true;
  2926	      }
  2927	      if (!event.connected && wasArmed) {
  2928	        recordDisarm(
  2929	          'transport',
  2930	          'Spojení k brokerovi bylo přerušeno',
  2931	          groupIsFlat() ? 'flat' : 'unknown',
  2932	        );
  2933	      }
  2934	      source.connection(event.connected);
  2935	      gate = {
  2936	        ...gate,
  2937	        connected: event.connected,
  2938	        lastHeartbeatAt: event.connected ? now : gate.lastHeartbeatAt,
  2939	        // Každý disconnect ruší ARM; reconnect ho nikdy sám neobnoví.
  2940	        armed: event.connected ? gate.armed : false,
  2941	      };
  2942	      // Plánovaná obměna socketu výpadek nehlásí, aby nedělala falešné
  2943	      // poplachy — jenže v mezeře mezi zavřením a resyncem mohl leader
  2944	      // stihnout celý tržní příkaz a ten se pak nezkopíruje. Při zavírání
  2945	      // by se ale zkopíroval a follower by otevřel opačnou pozici. Po
  2946	      // obnově proto vždy vynutíme kontrolu pozic; když jsou účty
  2947	      // synchronní, runtime je bezpečně drží DISARMED. Nový LIVE ARM je navíc
  2948	      // povolen jen z autoritativně flat stavu.
  2949	      if (!event.connected || source.needsReconciliation() || event.resynced) {
  2950	        invalidateReconciliation();
  2951	        if (event.resynced) pendingConnectionRecovery = true;
  2952	      }
  2953	      if (event.connected) {
  2954	        // Boot po pádu: durable stopa říká, že kopie vznikly za živého ARM.
  2955	        if (!bootRecoveryChecked) {
  2956	          bootRecoveryChecked = true;
  2957	          const hasRecoverableLeaderFlatEpoch = currentRuntime().state.safety.leaderExposureEpochs
  2958	            ?.some(epoch => (
  2959	              epoch.groupId === group.id
  2960	              && epoch.leaderAccountId === group.leaderAccountId
  2961	              && (
  2962	                epoch.phase === 'open'
  2963	                || epoch.phase === 'grace'
  2964	                || epoch.phase === 'waiting-inflight'
  2965	                || epoch.phase === 'closing'
  2966	              )
  2967	            )) === true;
  2968	          if (
  2969	            currentRuntime().state.safety.liveCopyOpenSince != null
  2970	            || hasRecoverableLeaderFlatEpoch
  2971	          ) pendingConnectionRecovery = true;
  2972	        }
  2973	        if (pendingConnectionRecovery) scheduleConnectionRecovery();
  2974	      }
  2975	      return;
  2976	    }
  2977	    await maybeHandleArmExpiry(now);
  2978	    if (rollEligibilityToNewSession(now)) await persistEligibility();
  2979	    if (event.type === 'fill' && event.fill.accountId !== group.leaderAccountId) {
  2980	      rememberFollowerFillCause(event.fill, now);
  2981	      const cachedNet = positionsByAccount.get(event.fill.accountId)?.get(event.fill.symbol) ?? 0;
  2982	      if (
  2983	        cachedNet !== 0
  2984	        && Math.sign(cachedNet) === (event.fill.side === 'Buy' ? 1 : -1)
  2985	        && followerFillRole(event.fill.accountId, event.fill.brokerOrderId) === 'copied-entry'
  2986	      ) {
  2987	        // Kryje opačné pořadí streamu: Position dorazila před Fillem. Teprve
  2988	        // přesný brokerOrderId copier-issued entry smí posílit ownership.
  2989	        await strengthenLeaderFlatLineage(
  2990	          event.fill.accountId,

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '3640,3925p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  3640	      } else if (leaderTargetOrderIds.has(leaderEvent.orderId)) {
  3641	        pushCopyEvent('tp-moved', leaderEvent.symbol, positionSide, leaderEvent.quantity, now, {
  3642	          ...(leaderEvent.limitPrice != null ? { price: leaderEvent.limitPrice } : {}),
  3643	          ...(levelPnl(leaderEvent.symbol, leaderEvent.limitPrice) ?? {}),
  3644	        });
  3645	      } else {
  3646	        const movedPrice = leaderEvent.limitPrice ?? leaderEvent.stopPrice;
  3647	        // Posun čekajícího entry mění referenci pro potenciální P&L SL/TP.
  3648	        if (movedPrice != null && plannedEntryBySymbol.has(leaderEvent.symbol)) {
  3649	          rememberPlannedEntry(leaderEvent.symbol, movedPrice,
  3650	            (leaderEvent.side === 'Sell' ? -1 : 1) * leaderEvent.quantity);
  3651	        }
  3652	        pushCopyEvent('order-moved', leaderEvent.symbol, eventSide, leaderEvent.quantity, now, {
  3653	          ...(movedPrice != null ? { price: movedPrice } : {}),
  3654	        });
  3655	      }
  3656	    }
  3657	  };
  3658	
  3659	  type ReconciliationResult = {
  3660	    divergentAccounts: number[];
  3661	    workingOrderAccounts: number[];
  3662	  };
  3663	
  3664	  /**
  3665	   * Všechny reconciliation běhy sdílejí jednu frontu. Novější požadavek tak
  3666	   * vždy čte broker až po starším a starý snapshot nemůže doběhnout jako
  3667	   * poslední a přepsat novější bezpečnostní stav.
  3668	   */
  3669	  async function performReconciliation(
  3670	    reconciliationOptions: CopierReconciliationOptions & { clearLastError?: boolean } = {},
  3671	  ): Promise<ReconciliationResult> {
  3672	    const requestedGeneration = safetyGeneration;
  3673	    const run = reconciliationTail.then(() => runReconciliation(
  3674	      reconciliationOptions,
  3675	      requestedGeneration,
  3676	    ));
  3677	    reconciliationTail = run.then(() => undefined, () => undefined);
  3678	    return run;
  3679	  }
  3680	
  3681	  /** Autoritativní reconciliation — sdílí ji veřejné API i connection recovery. */
  3682	  async function runReconciliation(
  3683	    reconciliationOptions: CopierReconciliationOptions & { clearLastError?: boolean },
  3684	    requestedGeneration: number,
  3685	  ): Promise<ReconciliationResult> {
  3686	      const generationAtStart = safetyGeneration;
  3687	      if (!gate.connected) {
  3688	        // Holé „bez broker spojení" mate: uživatel vidí v kartě Připojení
  3689	        // platné OAuth a myslí si, že spojení stojí. Padá ale živý WebSocket
  3690	        // workeru, což je jiná vrstva — hláška proto říká i příčinu a co dál.
  3691	        const reason = lastError?.message?.trim();
  3692	        throw new Error([
  3693	          'Kontrolu pozic nelze provést: worker nemá živé spojení s Tradovate.',
  3694	          reason ? `Poslední chyba: ${reason}.` : '',
  3695	          'OAuth přihlášení tím není dotčené — spojení se obnoví samo, zkus to za chvíli znovu.',
  3696	        ].filter(Boolean).join(' '));
  3697	      }
  3698	      if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
  3699	      const accountIds = [group.leaderAccountId, ...group.followers.map(item => item.accountId)];
  3700	      const eligibilityNow = clock();
  3701	      const followerIds = new Set(group.followers.map(item => item.accountId));
  3702	      const missingOptionalAccountIds = new Set(reconciliationOptions.missingOptionalAccountIds ?? []);
  3703	      for (const accountId of missingOptionalAccountIds) {
  3704	        if (!Number.isSafeInteger(accountId) || !followerIds.has(accountId)) {
  3705	          throw new Error(`Reconciliation dostala neplatný optional follower účet ${accountId}`);
  3706	        }
  3707	      }
  3708	      let missingEligibilityChanged = false;
  3709	      for (const accountId of missingOptionalAccountIds) {
  3710	        const current = accountEligibility.get(accountId);
  3711	        if (current && current.state !== 'active') continue;
  3712	        setEligibility(accountId, {
  3713	          ...(current ?? {}),
  3714	          accountId,
  3715	          state: 'unverifiable',
  3716	          reason: 'účet není viditelný v žádném připojeném OAuth při read-only reconciliaci',
  3717	          at: eligibilityNow,
  3718	        });
  3719	        missingEligibilityChanged = true;
  3720	      }
  3721	      if (missingEligibilityChanged) await persistEligibility();
  3722	      const eligibilityByAccount = new Map<number, CopierAccountEligibility>();
  3723	      for (const [accountId, stored] of accountEligibility) {
  3724	        eligibilityByAccount.set(accountId, eligibilityAt(stored, eligibilityNow));
  3725	      }
  3726	      // Známý vyřazený follower nesmí zablokovat autoritativní kontrolu
  3727	      // zdravých účtů jen proto, že ho prop firma po BREACH/DLL přestala
  3728	      // vracet v account/list. Leader je vždy povinný. `unverifiable` účet
  3729	      // se naopak při dostupné capability dále načte a může se reaktivovat.
  3730	      const optionalFollowerIds = new Set(group.followers
  3731	        .filter(follower => (eligibilityByAccount.get(follower.accountId)?.state ?? 'active') !== 'active')
  3732	        .map(follower => follower.accountId));
  3733	      const routedAccountIds = accountIds.filter(accountId => !missingOptionalAccountIds.has(accountId));
  3734	      const capabilities = await broker.listAccountCapabilities(routedAccountIds);
  3735	      const byCapability = new Map(capabilities.map(item => [item.accountId, item]));
  3736	      const missingRequired = routedAccountIds.filter(
  3737	        accountId => !byCapability.has(accountId) && !optionalFollowerIds.has(accountId),
  3738	      );
  3739	      const missing = [...new Set([...missingOptionalAccountIds, ...missingRequired])];
  3740	      const inactive = routedAccountIds.filter(accountId =>
  3741	        byCapability.get(accountId)?.active === false && !optionalFollowerIds.has(accountId));
  3742	      const readOnlyFollowers = group.followers.filter(
  3743	        follower => byCapability.get(follower.accountId)?.canTrade === false
  3744	          && !optionalFollowerIds.has(follower.accountId),
  3745	      ).map(follower => follower.accountId);
  3746	      lastOauthPreflight = {
  3747	        missingAccounts: [...missing],
  3748	        inactiveAccounts: [...inactive],
  3749	        readOnlyFollowerAccounts: [...readOnlyFollowers],
  3750	      };
  3751	      if (missingRequired.length > 0 || inactive.length > 0 || readOnlyFollowers.length > 0) {
  3752	        gate = { ...gate, armed: false };
  3753	        invalidateReconciliation();
  3754	        const details = [
  3755	          missingRequired.length > 0 ? `missing=${missingRequired.join(',')}` : '',
  3756	          inactive.length > 0 ? `inactive=${inactive.join(',')}` : '',
  3757	          readOnlyFollowers.length > 0 ? `readOnlyFollowers=${readOnlyFollowers.join(',')}` : '',
  3758	        ].filter(Boolean).join(' ');
  3759	        throw new Error(`OAuth/account preflight selhal: ${details}`);
  3760	      }
  3761	      const snapshotAccountIds = accountIds.filter(accountId => {
  3762	        const capability = byCapability.get(accountId);
  3763	        if (!capability?.active || !capability.canTrade) return false;
  3764	        const state = eligibilityByAccount.get(accountId)?.state ?? 'active';
  3765	        // BREACHED a stále platný DLL jsou známé exclusions. Expirující DLL
  3766	        // už eligibilityAt převedlo na `unverifiable`, takže se načte a po
  3767	        // úspěšném snapshotu může bezpečně vrátit do active.
  3768	        return state !== 'breached' && state !== 'dll-locked';
  3769	      });
  3770	      const snapshots = await Promise.all(snapshotAccountIds.map(async accountId => {
  3771	        const [positions, orders] = await Promise.all([
  3772	          broker.listPositions(accountId),
  3773	          broker.listOrders(accountId),
  3774	        ]);
  3775	        return { accountId, positions, orders };
  3776	      }));
  3777	      const byAccount = new Map(snapshots.map(item => [item.accountId, item]));
  3778	      positionsByAccount.clear();
  3779	      for (const snapshot of snapshots) {
  3780	        positionsByAccount.set(snapshot.accountId, new Map(
  3781	          snapshot.positions.map(item => [item.symbol, item.netQuantity]),
  3782	        ));
  3783	      }
  3784	      leaderPositions.clear();
  3785	      // Atribuce SL/TP exitů přežije restart: ochranné nohy leadera se
  3786	      // obnoví z autoritativních working orderů (mají parent/OCO vazbu).
  3787	      for (const order of byAccount.get(group.leaderAccountId)?.orders ?? []) {
  3788	        if (order.status !== 'working') continue;
  3789	        if (order.parentOrderId == null && order.ocoId == null && order.linkedOrderId == null) continue;
  3790	        if (order.orderType === 'Stop' || order.orderType === 'StopLimit') {
  3791	          leaderStopOrderIds.add(order.brokerOrderId);
  3792	        } else if (order.orderType === 'Limit') {
  3793	          leaderTargetOrderIds.add(order.brokerOrderId);
  3794	        }
  3795	      }
  3796	      const reconciledLeaderPositions = new Map(
  3797	        (byAccount.get(group.leaderAccountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
  3798	      );
  3799	      for (const [symbol, quantity] of reconciledLeaderPositions) leaderPositions.set(symbol, quantity);
  3800	      const divergent = new Set<number>();
  3801	      workingOrderAccounts = new Set(
  3802	        snapshots.filter(item => item.orders.some(order => isOpenOrderStatus(order.status))).map(item => item.accountId),
  3803	      );
  3804	      // Reaktivace eligibility: JEDINÉ místo, kde se DLL/unverifiable vrací
  3805	      // do 'active' — autoritativní snapshot účtu se povedl. Čas sám nikdy
  3806	      // nestačí (rollEligibilityToNewSession umí jen zpřísnit na
  3807	      // 'unverifiable'). Breach zůstává trvale, dokud ho operátor neřeší.
  3808	      {
  3809	        const reactivationNow = clock();
  3810	        let eligibilityChanged = rollEligibilityToNewSession(reactivationNow);
  3811	        for (const [accountId, entry] of accountEligibility) {
  3812	          if (!byAccount.has(accountId)) continue;
  3813	          const newSessionBegan = entry.lockSessionEndAt != null
  3814	            && entry.lockSessionEndAt > 0
  3815	            && reactivationNow >= entry.lockSessionEndAt;
  3816	          if (entry.state === 'unverifiable' || (entry.state === 'dll-locked' && newSessionBegan)) {
  3817	            accountEligibility.set(accountId, {
  3818	              ...entry, state: 'active', at: reactivationNow,
  3819	              reason: 'autoritativně ověřeno při reconciliaci po nové session',
  3820	            });
  3821	            eligibilityChanged = true;
  3822	            options.onAudit?.([{
  3823	              at: reactivationNow, leaderEventId: `eligibility-reactivate-${accountId}`,
  3824	              kind: 'recovered', accountId,
  3825	              reason: 'účet znovu způsobilý — autoritativní ověření po nové session',
  3826	            }]);
  3827	          }
  3828	        }
  3829	        if (eligibilityChanged) await persistEligibility();
  3830	      }
  3831	      const ineligibleAfterReactivation = currentIneligibleAccounts();
  3832	      for (const follower of group.followers) {
  3833	        // Účet s autoritativní eligibility exclusion není participantem
  3834	        // copieru. Jeho chybějící snapshot proto není divergence zdravých
  3835	        // participantů; po reaktivaci se automaticky vrátí do této kontroly.
  3836	        if (ineligibleAfterReactivation.has(follower.accountId)) continue;
  3837	        const followerPositions = new Map(
  3838	          (byAccount.get(follower.accountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
  3839	        );
  3840	        const symbols = new Set([...reconciledLeaderPositions.keys(), ...followerPositions.keys()]);
  3841	        for (const symbol of symbols) {
  3842	          const expected = Math.trunc((reconciledLeaderPositions.get(symbol) ?? 0) * follower.multiplier);
  3843	          if ((followerPositions.get(symbol) ?? 0) !== expected) {
  3844	            divergent.add(follower.accountId);
  3845	            break;
  3846	          }
  3847	        }
  3848	      }
  3849	      // Durable dokončení sweep povinnosti: pád workeru mezi follower flat
  3850	      // a potvrzeným cancelem nesmí povinnost ztratit (review, bod 5).
  3851	      // Reconciliation je autoritativní moment, kdy se osiřelé working
  3852	      // ochranné nohy nad flat followerem dají najít a doprovodit.
  3853	      for (const follower of group.followers) {
  3854	        const snapshot = byAccount.get(follower.accountId);
  3855	        if (!snapshot) continue;
  3856	        const workingIds = new Set(
  3857	          snapshot.orders.filter(order => isOpenOrderStatus(order.status)).map(order => order.brokerOrderId),
  3858	        );
  3859	        if (workingIds.size === 0) continue;
  3860	        const flatSymbols = new Set<string>();
  3861	        const runtime = currentRuntime();
  3862	        for (const entry of [...runtime.bracketOutbox.values(), ...runtime.osoOutbox.values()]) {
  3863	          if (entry.request.accountId !== follower.accountId) continue;
  3864	          const net = snapshot.positions.find(item => item.symbol === entry.request.symbol)?.netQuantity ?? 0;
  3865	          if (net !== 0) continue;
  3866	          const hasWorkingLeg = [entry.firstBrokerOrderId, entry.secondBrokerOrderId]
  3867	            .some(id => id && workingIds.has(id));
  3868	          if (hasWorkingLeg) flatSymbols.add(entry.request.symbol);
  3869	        }
  3870	        for (const symbol of flatSymbols) {
  3871	          await sweepFollowerProtectiveLegs(follower.accountId, symbol, clock(), {
  3872	            authoritativeWorkingOrderIds: workingIds,
  3873	          });
  3874	        }
  3875	      }
  3876	      gate = { ...gate, divergentAccounts: divergent, sequenceBroken: false, armed: false };
  3877	      const sameSafetyGeneration = safetyGeneration === generationAtStart;
  3878	      positionCheckComplete = sameSafetyGeneration
  3879	        && divergent.size === 0
  3880	        && workingOrderAccounts.size === 0;
  3881	      if (positionCheckComplete) {
  3882	        await acknowledgeTerminalRejectsAfterReconciliation();
  3883	        // Acknowledge může samo čekat na durable commit. Kill switch nebo
  3884	        // nový broker incident během tohoto awaitu musí mít stále přednost.
  3885	        if (safetyGeneration !== generationAtStart) {
  3886	          positionCheckComplete = false;
  3887	        } else {
  3888	          source.acknowledgeReconciliation();
  3889	          if (
  3890	            reconciliationOptions.clearLastError
  3891	            && requestedGeneration === generationAtStart
  3892	            && !gate.killSwitch
  3893	          ) lastError = null;
  3894	        }
  3895	      }
  3896	      await resolveRejectedExecutions({
  3897	        accountIds: group.followers
  3898	          .filter(follower => {
  3899	            const snapshot = byAccount.get(follower.accountId);
  3900	            return snapshot != null
  3901	              && snapshot.positions.every(position => position.netQuantity === 0);
  3902	          })
  3903	          .map(follower => follower.accountId),
  3904	        kind: 'follower-flat',
  3905	        at: clock(),
  3906	        detail: 'autoritativní reconciliation potvrdila followera flat',
  3907	      });
  3908	      return {
  3909	        divergentAccounts: [...divergent],
  3910	        workingOrderAccounts: [...workingOrderAccounts],
  3911	      };
  3912	  }
  3913	
  3914	  const LEADER_EPOCH_READ_DEADLINE_MS = 2_500;
  3915	  const withLeaderEpochDeadline = async <T>(label: string, work: Promise<T>): Promise<T> => {
  3916	    let timer: ReturnType<typeof setTimeout> | undefined;
  3917	    try {
  3918	      return await Promise.race([
  3919	        work,
  3920	        new Promise<never>((_, reject) => {
  3921	          timer = setTimeout(
  3922	            () => reject(new Error(`${label}: broker read deadline ${LEADER_EPOCH_READ_DEADLINE_MS} ms`)),
  3923	            LEADER_EPOCH_READ_DEADLINE_MS,
  3924	          );
  3925	        }),

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '3925,4130p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  3925	        }),
  3926	      ]);
  3927	    } finally {
  3928	      clearTimeout(timer);
  3929	    }
  3930	  };
  3931	
  3932	  /**
  3933	   * Přepnutí leadera je změna celé order-lifecycle epochy, ne obyčejný
  3934	   * edit jednoho ID. Operace se řadí do stejné fronty jako broker eventy:
  3935	   * event, který dorazil před klikem, doběhne pod starým leaderem; event po
  3936	   * potvrzené změně už pod novým. Chyba se vrátí UI a frontu nezabije.
  3937	   */
  3938	  const reconfigureLeaderEpoch = async (
  3939	    nextGroup: CopyGroupConfig,
  3940	    switchOptions: CopierGroupReconfigurationOptions & {
  3941	      allowGroupChange?: boolean;
  3942	      forceEpoch?: boolean;
  3943	    } = {},
  3944	  ): Promise<void> => {
  3945	    const operation = switchOptions.forceEpoch ? 'Aktivaci skupiny' : 'Změnu leadera';
  3946	    const run = eventTail.then(async () => {
  3947	      if (stopped) throw new Error('Copier runtime is stopped');
  3948	      if (nextGroup.id !== group.id && !switchOptions.allowGroupChange) {
  3949	        throw new Error('Nelze změnit runtime na jinou copy group bez explicitní aktivace');
  3950	      }
  3951	      assertRuntimeGroup(nextGroup);
  3952	      const currentTopology = new Set([
  3953	        group.leaderAccountId,
  3954	        ...group.followers.map(item => item.accountId),
  3955	      ]);
  3956	      const nextTopology = new Set([
  3957	        nextGroup.leaderAccountId,
  3958	        ...nextGroup.followers.map(item => item.accountId),
  3959	      ]);
  3960	      const topologyChanged = currentTopology.size !== nextTopology.size
  3961	        || [...currentTopology].some(accountId => !nextTopology.has(accountId));
  3962	      if (nextGroup.leaderAccountId === group.leaderAccountId && !topologyChanged && !switchOptions.forceEpoch) {
  3963	        group = nextGroup;
  3964	        invalidateReconciliation();
  3965	        return;
  3966	      }
  3967	      if (!gate.connected) {
  3968	        throw new Error(`${operation} nelze potvrdit bez živého broker syncu workeru`);
  3969	      }
  3970	      if (currentStuckOperations().length > 0 || hasBrokerUncertainOutbox()) {
  3971	        throw new Error(`${operation} blokuje nevyřešený durable outbox`);
  3972	      }
  3973	      const pendingReasons = [
  3974	        pendingBracketTimers.size > 0 ? 'bracket correlation' : '',
  3975	        pendingOsoTimers.size > 0 || pendingOsoEvents.size > 0 || pendingOsoFlushes.size > 0
  3976	          ? 'OSO correlation'
  3977	          : '',
  3978	        pendingFollowerTransitions.size > 0 ? 'follower transition' : '',
  3979	        pendingFollowerMagnitudeChecks.size > 0 ? 'follower magnitude check' : '',
  3980	        sweepingProtectiveLegs.size > 0 ? 'protective sweep' : '',
  3981	        leaderFlatGuardTimers.size > 0 ? 'leader-flat guard' : '',
  3982	        autoCloseInFlight ? 'auto-close' : '',
  3983	        recoveryInFlight || pendingConnectionRecovery ? 'connection recovery' : '',
  3984	        cooldownPending ? 'cooldown transition' : '',
  3985	        dayLockPendingReason ? 'day-lock transition' : '',
  3986	      ].filter(Boolean);
  3987	      if (pendingReasons.length > 0) {
  3988	        throw new Error(`${operation} blokuje rozpracovaný lifecycle: ${pendingReasons.join(', ')}`);
  3989	      }
  3990	      const openLots = currentRuntime().state.safety.dailyStats?.openLots
  3991	        .filter(lot => lot.netQuantity !== 0) ?? [];
  3992	      if (openLots.length > 0) {
  3993	        throw new Error(`${operation} blokuje otevřená durable pozice leadera`);
  3994	      }
  3995	
  3996	      const accountIds = [...new Set([
  3997	        group.leaderAccountId,
  3998	        ...group.followers.map(item => item.accountId),
  3999	        nextGroup.leaderAccountId,
  4000	        ...nextGroup.followers.map(item => item.accountId),
  4001	      ])];
  4002	      const leaderIds = new Set([group.leaderAccountId, nextGroup.leaderAccountId]);
  4003	      const nextAccountIds = new Set([
  4004	        nextGroup.leaderAccountId,
  4005	        ...nextGroup.followers.map(item => item.accountId),
  4006	      ]);
  4007	      const removableFollowerIds = new Set(group.followers
  4008	        .map(item => item.accountId)
  4009	        .filter(accountId => !nextAccountIds.has(accountId) && !leaderIds.has(accountId)));
  4010	      const optionalFollowerIds = new Set(switchOptions.missingOptionalAccountIds ?? []);
  4011	      for (const accountId of optionalFollowerIds) {
  4012	        if (!Number.isSafeInteger(accountId) || !removableFollowerIds.has(accountId)) {
  4013	          throw new Error(`${operation} dostala neplatný chybějící optional follower účet ${accountId}`);
  4014	        }
  4015	      }
  4016	      const requiredAccountIds = accountIds.filter(accountId => !optionalFollowerIds.has(accountId));
  4017	      const capabilities = await withLeaderEpochDeadline(
  4018	        'leader capability preflight',
  4019	        broker.listAccountCapabilities(requiredAccountIds),
  4020	      );
  4021	      const capabilityByAccount = new Map(capabilities.map(item => [item.accountId, item]));
  4022	      const unavailable = requiredAccountIds.filter(accountId => {
  4023	        const capability = capabilityByAccount.get(accountId);
  4024	        return !capability || !capability.active || !capability.canTrade;
  4025	      });
  4026	      if (unavailable.length > 0) {
  4027	        throw new Error(`${operation} blokují neaktivní/read-only účty: ${unavailable.join(',')}`);
  4028	      }
  4029	      const snapshots = await Promise.all(requiredAccountIds.map(async accountId => {
  4030	        const [positions, orders] = await Promise.all([
  4031	          withLeaderEpochDeadline(`leader position preflight ${accountId}`, broker.listPositions(accountId)),
  4032	          withLeaderEpochDeadline(`leader order preflight ${accountId}`, broker.listOrders(accountId)),
  4033	        ]);
  4034	        return { accountId, positions, orders };
  4035	      }));
  4036	      const nonFlat = snapshots.filter(snapshot =>
  4037	        snapshot.positions.some(position => position.netQuantity !== 0));
  4038	      const withWorkingOrders = snapshots.filter(snapshot =>
  4039	        snapshot.orders.some(order => isOpenOrderStatus(order.status)));
  4040	      if (nonFlat.length > 0 || withWorkingOrders.length > 0) {
  4041	        const details = [
  4042	          nonFlat.length > 0 ? `nonFlat=${nonFlat.map(item => item.accountId).join(',')}` : '',
  4043	          withWorkingOrders.length > 0
  4044	            ? `working=${withWorkingOrders.map(item => item.accountId).join(',')}`
  4045	            : '',
  4046	        ].filter(Boolean).join(' ');
  4047	        throw new Error(`${operation} vyžaduje všechny staré i nové účty flat a bez příkazů: ${details}`);
  4048	      }
  4049	
  4050	      runtime = await processor.mutate(async current => {
  4051	        const {
  4052	          liveCopyOpenSince: _dropOpenFlag,
  4053	          leaderExposureEpochs: _dropLeaderExposureEpochs,
  4054	          ...preservedSafety
  4055	        } = current.state.safety;
  4056	        const cleanState = createCopierState([], 0, [], [], [], preservedSafety);
  4057	        const committed = await options.store.commit(
  4058	          toSnapshot(cleanState, [], [], current.revision, [], []),
  4059	          current.revision,
  4060	        );
  4061	        return createRuntime(cleanState, [], [], committed.revision, [], []);
  4062	      });
  4063	
  4064	      // Od tohoto bodu je durable stará epocha pryč a teprve teď se stává
  4065	      // nový leader autoritativní pro event source i risk vrstvu.
  4066	      group = nextGroup;
  4067	      options.broker.setCriticalAccounts?.([nextGroup.leaderAccountId]);
  4068	      bracketCorrelator = new CopierBracketCorrelator();
  4069	      osoCorrelator = new CopierOsoCorrelator(options.osoCorrelationWindowMs);
  4070	      recentCopyEvents.length = 0;
  4071	      copyEventCounter = 0;
  4072	      leaderStopOrderIds.clear();
  4073	      leaderTargetOrderIds.clear();
  4074	      lastLeaderFillOrderId.clear();
  4075	      plannedEntryBySymbol.clear();
  4076	      admittedLeaderOrders.clear();
  4077	      admittedFlatExitOrders.clear();
  4078	      leaderPositions.clear();
  4079	      positionsByAccount.clear();
  4080	      for (const snapshot of snapshots) {
  4081	        positionsByAccount.set(snapshot.accountId, new Map(
  4082	          snapshot.positions.map(position => [position.symbol, position.netQuantity]),
  4083	        ));
  4084	      }
  4085	      untrackedTradeSymbols.clear();
  4086	      recentFollowerFillCauses.clear();
  4087	      for (const timer of pendingFollowerMagnitudeChecks.values()) clearTimeout(timer);
  4088	      pendingFollowerMagnitudeChecks.clear();
  4089	      for (const timer of leaderFlatGuardTimers.values()) clearTimeout(timer);
  4090	      leaderFlatGuardTimers.clear();
  4091	      sweptProtectiveLegs.clear();
  4092	      sweepingProtectiveLegs.clear();
  4093	      workingOrderAccounts = new Set();
  4094	      lastAutoClose = null;
  4095	      lastResumeOffer = null;
  4096	      autoCloseEpisodeAttempts = 0;
  4097	      pendingConnectionRecovery = false;
  4098	      recoveryInFlight = false;
  4099	      bootRecoveryChecked = true;
  4100	      invalidateReconciliation();
  4101	      lastError = null;
  4102	      gate = {
  4103	        ...gate,
  4104	        armed: false,
  4105	        armedAt: 0,
  4106	        now: clock(),
  4107	        shadowMode: true,
  4108	        divergentAccounts: new Set(),
  4109	        sequenceBroken: false,
  4110	        stuckOutbox: false,
  4111	      };
  4112	      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
  4113	    });
  4114	    eventTail = run.then(() => undefined, () => undefined);
  4115	    try {
  4116	      await run;
  4117	    } catch (reason) {
  4118	      const error = errorOf(reason);
  4119	      lastError = error;
  4120	      options.onError?.(error);
  4121	      throw error;
  4122	    }
  4123	  };
  4124	
  4125	  const unsubscribe = broker.subscribe(event => {
  4126	    eventTail = eventTail.then(() => handleBrokerEvent(event)).catch(failClosed);
  4127	  });
  4128	
  4129	  return {
  4130	    arm({ shadowMode = false, ttlMs }: { shadowMode?: boolean; ttlMs?: number } = {}) {

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '4280,4345p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  4280	        const current = accountEligibility.get(exclusion.accountId);
  4281	        // Stav z LIVE smí runtime jen zpřísnit. `unverifiable` je
  4282	        // fail-closed a nesmí se změnit na slabší DLL lock; BREACHED je
  4283	        // nejsilnější trvalá západka.
  4284	        const currentSeverity = current?.state === 'breached'
  4285	          ? 3
  4286	          : current?.state === 'unverifiable'
  4287	            ? 2
  4288	            : current?.state === 'dll-locked'
  4289	              ? 1
  4290	              : 0;
  4291	        const nextSeverity = exclusion.state === 'breached' ? 3 : 1;
  4292	        if (nextSeverity < currentSeverity) continue;
  4293	        const existingDllSessionEnd = current?.state === 'dll-locked'
  4294	          && current.lockSessionEndAt != null
  4295	          && current.lockSessionEndAt > now
  4296	          ? current.lockSessionEndAt
  4297	          : null;
  4298	        const next: CopierAccountEligibility = {
  4299	          ...(current ?? {}),
  4300	          accountId: exclusion.accountId,
  4301	          state: exclusion.state,
  4302	          reason,
  4303	          at: now,
  4304	          lockSessionEndAt: exclusion.state === 'dll-locked'
  4305	            ? existingDllSessionEnd ?? now + msUntilTradovateSessionEnd(now)
  4306	            : undefined,
  4307	        };
  4308	        if (
  4309	          current?.state === next.state
  4310	          && current.reason === next.reason
  4311	          && current.lockSessionEndAt === next.lockSessionEndAt
  4312	        ) continue;
  4313	        setEligibility(exclusion.accountId, next);
  4314	        changed = true;
  4315	      }
  4316	      if (changed) await persistEligibility();
  4317	    },
  4318	    async reconcile(reconciliationOptions = {}) {
  4319	      // Veřejná Kontrola pozic je explicitní uživatelská recovery akce.
  4320	      // Pouze její čistý výsledek smí odstranit starou chybu; automatické
  4321	      // reconnect/terminal-fill kontroly incident uživateli neschovávají.
  4322	      const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
  4323	      if (result.divergentAccounts.length === 0 && result.workingOrderAccounts.length === 0) {
  4324	        // Autoritativně čistý stav je přesně to, co čekající recovery vlna
  4325	        // hledala; jinak by příznak po neúspěšné automatické vlně blokoval
  4326	        // změnu skupiny („rozpracovaný lifecycle: connection recovery“) až do
  4327	        // dalšího connection eventu. Při divergenci zůstává pending.
  4328	        pendingConnectionRecovery = false;
  4329	      }
  4330	      return result;
  4331	    },
  4332	    async verifyAccountEligibility(accountId) {
  4333	      if (!Number.isSafeInteger(accountId) || accountId <= 0) {
  4334	        throw new Error('Neplatné ID účtu pro ověření');
  4335	      }
  4336	      if (!gate.connected) {
  4337	        const reason = lastError?.message?.trim();
  4338	        throw new Error([
  4339	          'Stav účtu nelze ověřit: worker nemá živé spojení s Tradovate.',
  4340	          reason ? `Poslední chyba: ${reason}.` : '',
  4341	          'OAuth přihlášení tím není dotčené — spojení se obnoví samo, zkus to za chvíli znovu.',
  4342	        ].filter(Boolean).join(' '));
  4343	      }
  4344	
  4345	      const now = clock();

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '2670,2798p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
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
  2696	    if (options.resolveMissingOptionalAccountIds) {
  2697	      try {
  2698	        const followerIds = new Set(group.followers.map(follower => follower.accountId));
  2699	        missingOptionalAccountIds = [...new Set(await options.resolveMissingOptionalAccountIds(group))]
  2700	          .filter(accountId => followerIds.has(accountId) && accountId !== group.leaderAccountId);
  2701	      } catch {
  2702	        missingOptionalAccountIds = [];
  2703	      }
  2704	    }
  2705	    let reconciliation: { divergentAccounts: number[]; workingOrderAccounts: number[] } | null = null;
  2706	    for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
  2707	      if (attempt > 0) await wait(2_000);
  2708	      if (!gate.connected) {
  2709	        pendingConnectionRecovery = true;
  2710	        return;
  2711	      }
  2712	      try {
  2713	        reconciliation = await performReconciliation({
  2714	          missingOptionalAccountIds: [...missingOptionalAccountIds],
  2715	        });
  2716	        break;
  2717	      } catch {
  2718	        // Spojení je čerstvé — pár pokusů, pak poctivé přiznání níže.
  2719	      }
  2720	    }
  2721	    if (!reconciliation) {
  2722	      // Pět rychlých pokusů je jen jedna recovery vlna. Příští potvrzený
  2723	      // connected event ji musí smět spustit znovu; stav zůstává DISARMED.
  2724	      pendingConnectionRecovery = true;
  2725	      failClosed(new Error(
  2726	        'connection=aggregate phase=reconciliation Po obnovení spojení se nepodařilo ověřit stav účtů — kopie zůstávají chráněné brackety, zkontroluj Tradovate',
  2727	      ));
  2728	      return;
  2729	    }
  2730	    const guardedSymbols = await resumeLeaderFlatEpochsAfterSnapshot();
  2731	    if (!hasFollowerExposure()) {
  2732	      if (lastDisarm?.trigger === 'transport') updateDisarmOutcome(lastDisarm.at, 'flat');
  2733	      await syncLiveCopyExposureFlag('clear');
  2734	      options.onAudit?.([{
  2735	        at: clock(), leaderEventId: 'connection-recovery', kind: 'recovered',
  2736	        reason: 'connection-recovery: autoritativní reconciliation potvrdila flat/no-active stav; runtime zůstává DISARMED',
  2737	      }]);
  2738	      return;
  2739	    }
  2740	    const orphanSymbols = new Set<string>();
  2741	    for (const follower of group.followers) {
  2742	      for (const [symbol, quantity] of positionsByAccount.get(follower.accountId) ?? []) {
  2743	        if (quantity !== 0 && (leaderPositions.get(symbol) ?? 0) === 0) orphanSymbols.add(symbol);
  2744	      }
  2745	    }
  2746	    const unguardedOrphanSymbols = [...orphanSymbols].filter(symbol => !guardedSymbols.has(symbol));
  2747	    if (unguardedOrphanSymbols.length > 0) {
  2748	      failClosed(new Error(
  2749	        `Copier fail-closed: po reconnectu je leader flat a follower má neověřenou expozici (${unguardedOrphanSymbols.join(', ')}); bez opening ownership se automaticky nezavírá`,
  2750	      ), { autoClose: false });
  2751	      options.onAudit?.([{
  2752	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2753	        reason: `connection-recovery: detect-only orphan expozice bez durable opening epochy (${unguardedOrphanSymbols.join(', ')}); žádný broker write`,
  2754	      }]);
  2755	      return;
  2756	    }
  2757	    if (orphanSymbols.size > 0) {
  2758	      options.onAudit?.([{
  2759	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2760	        reason: `connection-recovery: leader-flat guard obnoven pro ${[...orphanSymbols].join(', ')}; runtime zůstává DISARMED`,
  2761	      }]);
  2762	      return;
  2763	    }
  2764	    const leaderOpen = [...(positionsByAccount.get(group.leaderAccountId)?.values() ?? [])]
  2765	      .some(quantity => quantity !== 0);
  2766	    if (leaderOpen && reconciliation.divergentAccounts.length === 0) {
  2767	      if (lastDisarm?.trigger === 'transport') {
  2768	        updateDisarmOutcome(lastDisarm.at, 'left-open-protected');
  2769	      }
  2770	      lastResumeOffer = null;
  2771	      options.onAudit?.([{
  2772	        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
  2773	        reason: 'connection-recovery: kopie jsou synchronní s leaderem — drženy DISARMED, ARM je blokovaný do flat',
  2774	      }]);
  2775	      return;
  2776	    }
  2777	    const flat = await autoFlattenCopies('reconnect', clock());
  2778	    if (lastDisarm?.trigger === 'transport') {
  2779	      updateDisarmOutcome(lastDisarm.at, flat ? 'auto-closed' : 'unknown');
  2780	    }
  2781	  };
  2782	
  2783	  const scheduleConnectionRecovery = () => {
  2784	    if (recoveryInFlight || stopped) return;
  2785	    recoveryInFlight = true;
  2786	    eventTail = eventTail
  2787	      .then(async () => {
  2788	        try {
  2789	          await runConnectionRecovery();
  2790	        } finally {
  2791	          recoveryInFlight = false;
  2792	        }
  2793	      })
  2794	      .catch(reason => {
  2795	        recoveryInFlight = false;
  2796	        failClosed(reason);
  2797	      });
  2798	  };

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '2910,2985p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  2910	    const now = clock();
  2911	    if (event.type === 'heartbeat') {
  2912	      gate = { ...gate, lastHeartbeatAt: event.at };
  2913	      await maybeHandleArmExpiry(now);
  2914	      return;
  2915	    }
  2916	    if (event.type === 'error') {
  2917	      failClosed(event.error, { transportLost: true });
  2918	      return;
  2919	    }
  2920	    if (event.type === 'connection') {
  2921	      const wasArmed = gate.armed;
  2922	      // Výpadek za živého ARM s otevřenými kopiemi → po reconnectu se
  2923	      // rozhodne „podle stavu" (držet synchronní / zavřít osiřelé).
  2924	      if (!event.connected && gate.armed && !gate.shadowMode && hasFollowerExposure()) {
  2925	        pendingConnectionRecovery = true;
  2926	      }
  2927	      if (!event.connected && wasArmed) {
  2928	        recordDisarm(
  2929	          'transport',
  2930	          'Spojení k brokerovi bylo přerušeno',
  2931	          groupIsFlat() ? 'flat' : 'unknown',
  2932	        );
  2933	      }
  2934	      source.connection(event.connected);
  2935	      gate = {
  2936	        ...gate,
  2937	        connected: event.connected,
  2938	        lastHeartbeatAt: event.connected ? now : gate.lastHeartbeatAt,
  2939	        // Každý disconnect ruší ARM; reconnect ho nikdy sám neobnoví.
  2940	        armed: event.connected ? gate.armed : false,
  2941	      };
  2942	      // Plánovaná obměna socketu výpadek nehlásí, aby nedělala falešné
  2943	      // poplachy — jenže v mezeře mezi zavřením a resyncem mohl leader
  2944	      // stihnout celý tržní příkaz a ten se pak nezkopíruje. Při zavírání
  2945	      // by se ale zkopíroval a follower by otevřel opačnou pozici. Po
  2946	      // obnově proto vždy vynutíme kontrolu pozic; když jsou účty
  2947	      // synchronní, runtime je bezpečně drží DISARMED. Nový LIVE ARM je navíc
  2948	      // povolen jen z autoritativně flat stavu.
  2949	      if (!event.connected || source.needsReconciliation() || event.resynced) {
  2950	        invalidateReconciliation();
  2951	        if (event.resynced) pendingConnectionRecovery = true;
  2952	      }
  2953	      if (event.connected) {
  2954	        // Boot po pádu: durable stopa říká, že kopie vznikly za živého ARM.
  2955	        if (!bootRecoveryChecked) {
  2956	          bootRecoveryChecked = true;
  2957	          const hasRecoverableLeaderFlatEpoch = currentRuntime().state.safety.leaderExposureEpochs
  2958	            ?.some(epoch => (
  2959	              epoch.groupId === group.id
  2960	              && epoch.leaderAccountId === group.leaderAccountId
  2961	              && (
  2962	                epoch.phase === 'open'
  2963	                || epoch.phase === 'grace'
  2964	                || epoch.phase === 'waiting-inflight'
  2965	                || epoch.phase === 'closing'
  2966	              )
  2967	            )) === true;
  2968	          if (
  2969	            currentRuntime().state.safety.liveCopyOpenSince != null
  2970	            || hasRecoverableLeaderFlatEpoch
  2971	          ) pendingConnectionRecovery = true;
  2972	        }
  2973	        if (pendingConnectionRecovery) scheduleConnectionRecovery();
  2974	      }
  2975	      return;
  2976	    }
  2977	    await maybeHandleArmExpiry(now);
  2978	    if (rollEligibilityToNewSession(now)) await persistEligibility();
  2979	    if (event.type === 'fill' && event.fill.accountId !== group.leaderAccountId) {
  2980	      rememberFollowerFillCause(event.fill, now);
  2981	      const cachedNet = positionsByAccount.get(event.fill.accountId)?.get(event.fill.symbol) ?? 0;
  2982	      if (
  2983	        cachedNet !== 0
  2984	        && Math.sign(cachedNet) === (event.fill.side === 'Buy' ? 1 : -1)
  2985	        && followerFillRole(event.fill.accountId, event.fill.brokerOrderId) === 'copied-entry'

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '3655,3820p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  3655	      }
  3656	    }
  3657	  };
  3658	
  3659	  type ReconciliationResult = {
  3660	    divergentAccounts: number[];
  3661	    workingOrderAccounts: number[];
  3662	  };
  3663	
  3664	  /**
  3665	   * Všechny reconciliation běhy sdílejí jednu frontu. Novější požadavek tak
  3666	   * vždy čte broker až po starším a starý snapshot nemůže doběhnout jako
  3667	   * poslední a přepsat novější bezpečnostní stav.
  3668	   */
  3669	  async function performReconciliation(
  3670	    reconciliationOptions: CopierReconciliationOptions & { clearLastError?: boolean } = {},
  3671	  ): Promise<ReconciliationResult> {
  3672	    const requestedGeneration = safetyGeneration;
  3673	    const run = reconciliationTail.then(() => runReconciliation(
  3674	      reconciliationOptions,
  3675	      requestedGeneration,
  3676	    ));
  3677	    reconciliationTail = run.then(() => undefined, () => undefined);
  3678	    return run;
  3679	  }
  3680	
  3681	  /** Autoritativní reconciliation — sdílí ji veřejné API i connection recovery. */
  3682	  async function runReconciliation(
  3683	    reconciliationOptions: CopierReconciliationOptions & { clearLastError?: boolean },
  3684	    requestedGeneration: number,
  3685	  ): Promise<ReconciliationResult> {
  3686	      const generationAtStart = safetyGeneration;
  3687	      if (!gate.connected) {
  3688	        // Holé „bez broker spojení" mate: uživatel vidí v kartě Připojení
  3689	        // platné OAuth a myslí si, že spojení stojí. Padá ale živý WebSocket
  3690	        // workeru, což je jiná vrstva — hláška proto říká i příčinu a co dál.
  3691	        const reason = lastError?.message?.trim();
  3692	        throw new Error([
  3693	          'Kontrolu pozic nelze provést: worker nemá živé spojení s Tradovate.',
  3694	          reason ? `Poslední chyba: ${reason}.` : '',
  3695	          'OAuth přihlášení tím není dotčené — spojení se obnoví samo, zkus to za chvíli znovu.',
  3696	        ].filter(Boolean).join(' '));
  3697	      }
  3698	      if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
  3699	      const accountIds = [group.leaderAccountId, ...group.followers.map(item => item.accountId)];
  3700	      const eligibilityNow = clock();
  3701	      const followerIds = new Set(group.followers.map(item => item.accountId));
  3702	      const missingOptionalAccountIds = new Set(reconciliationOptions.missingOptionalAccountIds ?? []);
  3703	      for (const accountId of missingOptionalAccountIds) {
  3704	        if (!Number.isSafeInteger(accountId) || !followerIds.has(accountId)) {
  3705	          throw new Error(`Reconciliation dostala neplatný optional follower účet ${accountId}`);
  3706	        }
  3707	      }
  3708	      let missingEligibilityChanged = false;
  3709	      for (const accountId of missingOptionalAccountIds) {
  3710	        const current = accountEligibility.get(accountId);
  3711	        if (current && current.state !== 'active') continue;
  3712	        setEligibility(accountId, {
  3713	          ...(current ?? {}),
  3714	          accountId,
  3715	          state: 'unverifiable',
  3716	          reason: 'účet není viditelný v žádném připojeném OAuth při read-only reconciliaci',
  3717	          at: eligibilityNow,
  3718	        });
  3719	        missingEligibilityChanged = true;
  3720	      }
  3721	      if (missingEligibilityChanged) await persistEligibility();
  3722	      const eligibilityByAccount = new Map<number, CopierAccountEligibility>();
  3723	      for (const [accountId, stored] of accountEligibility) {
  3724	        eligibilityByAccount.set(accountId, eligibilityAt(stored, eligibilityNow));
  3725	      }
  3726	      // Známý vyřazený follower nesmí zablokovat autoritativní kontrolu
  3727	      // zdravých účtů jen proto, že ho prop firma po BREACH/DLL přestala
  3728	      // vracet v account/list. Leader je vždy povinný. `unverifiable` účet
  3729	      // se naopak při dostupné capability dále načte a může se reaktivovat.
  3730	      const optionalFollowerIds = new Set(group.followers
  3731	        .filter(follower => (eligibilityByAccount.get(follower.accountId)?.state ?? 'active') !== 'active')
  3732	        .map(follower => follower.accountId));
  3733	      const routedAccountIds = accountIds.filter(accountId => !missingOptionalAccountIds.has(accountId));
  3734	      const capabilities = await broker.listAccountCapabilities(routedAccountIds);
  3735	      const byCapability = new Map(capabilities.map(item => [item.accountId, item]));
  3736	      const missingRequired = routedAccountIds.filter(
  3737	        accountId => !byCapability.has(accountId) && !optionalFollowerIds.has(accountId),
  3738	      );
  3739	      const missing = [...new Set([...missingOptionalAccountIds, ...missingRequired])];
  3740	      const inactive = routedAccountIds.filter(accountId =>
  3741	        byCapability.get(accountId)?.active === false && !optionalFollowerIds.has(accountId));
  3742	      const readOnlyFollowers = group.followers.filter(
  3743	        follower => byCapability.get(follower.accountId)?.canTrade === false
  3744	          && !optionalFollowerIds.has(follower.accountId),
  3745	      ).map(follower => follower.accountId);
  3746	      lastOauthPreflight = {
  3747	        missingAccounts: [...missing],
  3748	        inactiveAccounts: [...inactive],
  3749	        readOnlyFollowerAccounts: [...readOnlyFollowers],
  3750	      };
  3751	      if (missingRequired.length > 0 || inactive.length > 0 || readOnlyFollowers.length > 0) {
  3752	        gate = { ...gate, armed: false };
  3753	        invalidateReconciliation();
  3754	        const details = [
  3755	          missingRequired.length > 0 ? `missing=${missingRequired.join(',')}` : '',
  3756	          inactive.length > 0 ? `inactive=${inactive.join(',')}` : '',
  3757	          readOnlyFollowers.length > 0 ? `readOnlyFollowers=${readOnlyFollowers.join(',')}` : '',
  3758	        ].filter(Boolean).join(' ');
  3759	        throw new Error(`OAuth/account preflight selhal: ${details}`);
  3760	      }
  3761	      const snapshotAccountIds = accountIds.filter(accountId => {
  3762	        const capability = byCapability.get(accountId);
  3763	        if (!capability?.active || !capability.canTrade) return false;
  3764	        const state = eligibilityByAccount.get(accountId)?.state ?? 'active';
  3765	        // BREACHED a stále platný DLL jsou známé exclusions. Expirující DLL
  3766	        // už eligibilityAt převedlo na `unverifiable`, takže se načte a po
  3767	        // úspěšném snapshotu může bezpečně vrátit do active.
  3768	        return state !== 'breached' && state !== 'dll-locked';
  3769	      });
  3770	      const snapshots = await Promise.all(snapshotAccountIds.map(async accountId => {
  3771	        const [positions, orders] = await Promise.all([
  3772	          broker.listPositions(accountId),
  3773	          broker.listOrders(accountId),
  3774	        ]);
  3775	        return { accountId, positions, orders };
  3776	      }));
  3777	      const byAccount = new Map(snapshots.map(item => [item.accountId, item]));
  3778	      positionsByAccount.clear();
  3779	      for (const snapshot of snapshots) {
  3780	        positionsByAccount.set(snapshot.accountId, new Map(
  3781	          snapshot.positions.map(item => [item.symbol, item.netQuantity]),
  3782	        ));
  3783	      }
  3784	      leaderPositions.clear();
  3785	      // Atribuce SL/TP exitů přežije restart: ochranné nohy leadera se
  3786	      // obnoví z autoritativních working orderů (mají parent/OCO vazbu).
  3787	      for (const order of byAccount.get(group.leaderAccountId)?.orders ?? []) {
  3788	        if (order.status !== 'working') continue;
  3789	        if (order.parentOrderId == null && order.ocoId == null && order.linkedOrderId == null) continue;
  3790	        if (order.orderType === 'Stop' || order.orderType === 'StopLimit') {
  3791	          leaderStopOrderIds.add(order.brokerOrderId);
  3792	        } else if (order.orderType === 'Limit') {
  3793	          leaderTargetOrderIds.add(order.brokerOrderId);
  3794	        }
  3795	      }
  3796	      const reconciledLeaderPositions = new Map(
  3797	        (byAccount.get(group.leaderAccountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
  3798	      );
  3799	      for (const [symbol, quantity] of reconciledLeaderPositions) leaderPositions.set(symbol, quantity);
  3800	      const divergent = new Set<number>();
  3801	      workingOrderAccounts = new Set(
  3802	        snapshots.filter(item => item.orders.some(order => isOpenOrderStatus(order.status))).map(item => item.accountId),
  3803	      );
  3804	      // Reaktivace eligibility: JEDINÉ místo, kde se DLL/unverifiable vrací
  3805	      // do 'active' — autoritativní snapshot účtu se povedl. Čas sám nikdy
  3806	      // nestačí (rollEligibilityToNewSession umí jen zpřísnit na
  3807	      // 'unverifiable'). Breach zůstává trvale, dokud ho operátor neřeší.
  3808	      {
  3809	        const reactivationNow = clock();
  3810	        let eligibilityChanged = rollEligibilityToNewSession(reactivationNow);
  3811	        for (const [accountId, entry] of accountEligibility) {
  3812	          if (!byAccount.has(accountId)) continue;
  3813	          const newSessionBegan = entry.lockSessionEndAt != null
  3814	            && entry.lockSessionEndAt > 0
  3815	            && reactivationNow >= entry.lockSessionEndAt;
  3816	          if (entry.state === 'unverifiable' || (entry.state === 'dll-locked' && newSessionBegan)) {
  3817	            accountEligibility.set(accountId, {
  3818	              ...entry, state: 'active', at: reactivationNow,
  3819	              reason: 'autoritativně ověřeno při reconciliaci po nové session',
  3820	            });

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '3820,3915p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  3820	            });
  3821	            eligibilityChanged = true;
  3822	            options.onAudit?.([{
  3823	              at: reactivationNow, leaderEventId: `eligibility-reactivate-${accountId}`,
  3824	              kind: 'recovered', accountId,
  3825	              reason: 'účet znovu způsobilý — autoritativní ověření po nové session',
  3826	            }]);
  3827	          }
  3828	        }
  3829	        if (eligibilityChanged) await persistEligibility();
  3830	      }
  3831	      const ineligibleAfterReactivation = currentIneligibleAccounts();
  3832	      for (const follower of group.followers) {
  3833	        // Účet s autoritativní eligibility exclusion není participantem
  3834	        // copieru. Jeho chybějící snapshot proto není divergence zdravých
  3835	        // participantů; po reaktivaci se automaticky vrátí do této kontroly.
  3836	        if (ineligibleAfterReactivation.has(follower.accountId)) continue;
  3837	        const followerPositions = new Map(
  3838	          (byAccount.get(follower.accountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
  3839	        );
  3840	        const symbols = new Set([...reconciledLeaderPositions.keys(), ...followerPositions.keys()]);
  3841	        for (const symbol of symbols) {
  3842	          const expected = Math.trunc((reconciledLeaderPositions.get(symbol) ?? 0) * follower.multiplier);
  3843	          if ((followerPositions.get(symbol) ?? 0) !== expected) {
  3844	            divergent.add(follower.accountId);
  3845	            break;
  3846	          }
  3847	        }
  3848	      }
  3849	      // Durable dokončení sweep povinnosti: pád workeru mezi follower flat
  3850	      // a potvrzeným cancelem nesmí povinnost ztratit (review, bod 5).
  3851	      // Reconciliation je autoritativní moment, kdy se osiřelé working
  3852	      // ochranné nohy nad flat followerem dají najít a doprovodit.
  3853	      for (const follower of group.followers) {
  3854	        const snapshot = byAccount.get(follower.accountId);
  3855	        if (!snapshot) continue;
  3856	        const workingIds = new Set(
  3857	          snapshot.orders.filter(order => isOpenOrderStatus(order.status)).map(order => order.brokerOrderId),
  3858	        );
  3859	        if (workingIds.size === 0) continue;
  3860	        const flatSymbols = new Set<string>();
  3861	        const runtime = currentRuntime();
  3862	        for (const entry of [...runtime.bracketOutbox.values(), ...runtime.osoOutbox.values()]) {
  3863	          if (entry.request.accountId !== follower.accountId) continue;
  3864	          const net = snapshot.positions.find(item => item.symbol === entry.request.symbol)?.netQuantity ?? 0;
  3865	          if (net !== 0) continue;
  3866	          const hasWorkingLeg = [entry.firstBrokerOrderId, entry.secondBrokerOrderId]
  3867	            .some(id => id && workingIds.has(id));
  3868	          if (hasWorkingLeg) flatSymbols.add(entry.request.symbol);
  3869	        }
  3870	        for (const symbol of flatSymbols) {
  3871	          await sweepFollowerProtectiveLegs(follower.accountId, symbol, clock(), {
  3872	            authoritativeWorkingOrderIds: workingIds,
  3873	          });
  3874	        }
  3875	      }
  3876	      gate = { ...gate, divergentAccounts: divergent, sequenceBroken: false, armed: false };
  3877	      const sameSafetyGeneration = safetyGeneration === generationAtStart;
  3878	      positionCheckComplete = sameSafetyGeneration
  3879	        && divergent.size === 0
  3880	        && workingOrderAccounts.size === 0;
  3881	      if (positionCheckComplete) {
  3882	        await acknowledgeTerminalRejectsAfterReconciliation();
  3883	        // Acknowledge může samo čekat na durable commit. Kill switch nebo
  3884	        // nový broker incident během tohoto awaitu musí mít stále přednost.
  3885	        if (safetyGeneration !== generationAtStart) {
  3886	          positionCheckComplete = false;
  3887	        } else {
  3888	          source.acknowledgeReconciliation();
  3889	          if (
  3890	            reconciliationOptions.clearLastError
  3891	            && requestedGeneration === generationAtStart
  3892	            && !gate.killSwitch
  3893	          ) lastError = null;
  3894	        }
  3895	      }
  3896	      await resolveRejectedExecutions({
  3897	        accountIds: group.followers
  3898	          .filter(follower => {
  3899	            const snapshot = byAccount.get(follower.accountId);
  3900	            return snapshot != null
  3901	              && snapshot.positions.every(position => position.netQuantity === 0);
  3902	          })
  3903	          .map(follower => follower.accountId),
  3904	        kind: 'follower-flat',
  3905	        at: clock(),
  3906	        detail: 'autoritativní reconciliation potvrdila followera flat',
  3907	      });
  3908	      return {
  3909	        divergentAccounts: [...divergent],
  3910	        workingOrderAccounts: [...workingOrderAccounts],
  3911	      };
  3912	  }
  3913	
  3914	  const LEADER_EPOCH_READ_DEADLINE_MS = 2_500;
  3915	  const withLeaderEpochDeadline = async <T>(label: string, work: Promise<T>): Promise<T> => {

exec
/bin/zsh -lc "nl -ba scripts/copier/pilot.ts | sed -n '590,655p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
   590	    if (pairingRestartPending) return;
   591	    pairingRestartPending = true;
   592	    const check = () => {
   593	      pairingRestartTimer = null;
   594	      if (stopPromise) return;
   595	      if (!canSafelyRestartLocalCopierAgent(controller?.status())) {
   596	        pairingRestartTimer = setTimeout(check, 1_000);
   597	        pairingRestartTimer.unref();
   598	        return;
   599	      }
   600	      // Odložení nechá právě běžící pairing HTTP odpověď bezpečně doběhnout.
   601	      scheduleAgentRestart({
   602	        delayMs: 750,
   603	        restart: () => {
   604	          if (stopPromise) return;
   605	          if (!canSafelyRestartLocalCopierAgent(controller?.status())) {
   606	            pairingRestartTimer = setTimeout(check, 1_000);
   607	            pairingRestartTimer.unref();
   608	            return;
   609	          }
   610	          // Bez await mezi poslední flat kontrolou, nevratným runtime gate a
   611	          // signalem: broker event ani UI command se sem nemohou vložit.
   612	          void controller?.beginShutdown();
   613	          agent?.beginShutdown();
   614	          process.kill(process.pid, 'SIGTERM');
   615	        },
   616	      });
   617	    };
   618	    check();
   619	  };
   620	  try {
   621	    controller = await bootstrapCopierRuntime({
   622	      broker,
   623	      store: runtimeStore,
   624	      group,
   625	      metrics: createCopierMetrics(),
   626	      // Všichni followeři musí odejít v JEDEN okamžik. Sériový dispatch
   627	      // (pilotní `1`) rozprostřel marketové nohy přes stovky ms — každá
   628	      // kopie pak trefila jinou cenu a P&L kopií se rozcházela. Limitů se
   629	      // to netýká (kniha čeká), marketů/flatten/close zásadně.
   630	      maxConcurrentDispatches: Math.max(4, group.followers.length),
   631	      onAudit: entries => {
   632	        auditTail = auditTail.then(() => writeAudit(entries));
   633	      },
   634	      onError: logControllerError,
   635	      // Post-connect recovery musí vidět stejný optional-skip jako ruční
   636	      // Kontrola pozic, jinak zmizelý breached follower shodí recovery.
   637	      resolveMissingOptionalAccountIds: prepareGroupAccounts
   638	        ? async current => (await prepareGroupAccounts({
   639	          required: [current.leaderAccountId],
   640	          optional: current.followers.map(follower => follower.accountId),
   641	        })).missingOptional
   642	        : undefined,
   643	      // Trade event -> okamžitý poll s příznakem -> server pushne hned.
   644	      onCopyEvent: event => {
   645	        relay?.nudgeCopyEvents();
   646	        if (!snapshotsEnabled || !relay || !event.episodeId) return;
   647	        // Jen vstup a výstup (rozhodnutí uživatele 2026-08-22): posun SL je
   648	        // vlastní akce — notifikace stačí textová a snímek by byl jen šum.
   649	        if (event.kind !== 'entry' && event.kind !== 'exit') return;
   650	        const snapshotRelay = relay;
   651	        const notifyDeadlineAt = event.at + COPY_EVENT_IMAGE_PUSH_DEADLINE_MS;
   652	        // Po grace worker vyvolá druhý průchod. Pokud obrázek uspěl, serverový
   653	        // marker z něj udělá no-op; jinak tentýž event odejde jako text.
   654	        const fallbackTimer = setTimeout(
   655	          () => snapshotRelay.nudgeCopyEvents(),

exec
/bin/zsh -lc "nl -ba scripts/copier/pilot.ts | sed -n '1710,1805p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
exec
/bin/zsh -lc "nl -ba tests/copierConnectionRecoveryOptionalFollower.test.ts | sed -n '1,150p'" in /private/tmp/alphatrade-reconnect-fix
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
    50	  const controller = await bootstrapCopierRuntime({
    51	    broker: router,
    52	    store: createMemoryCopierStore(initial),
    53	    group,
    54	    wait: async () => undefined,
    55	    onError: error => errors.push(error.message),
    56	    ...options,
    57	  });
    58	  mock.setConnected(true);
    59	  // Connection event doráží přes router asynchronně; recovery se řadí až po něm.
    60	  await settle(controller);
    61	  return { controller, errors, mock };
    62	};
    63	
    64	const settle = async (controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>) => {
    65	  for (let round = 0; round < 3; round += 1) {
    66	    await new Promise<void>(resolve => setTimeout(resolve, 20));
    67	    await controller.waitForIdle();
    68	  }
    69	};
    70	
    71	describe('post-connect recovery a follower chybějící v OAuth', () => {
    72	  it('bez optional-skip vstupu recovery selže, ale čistá ruční Kontrola pozic odblokuje změnu skupiny', async () => {
    73	    const h = await harness();
    74	    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
    75	    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    76	
    77	    // Stav po včerejšku: příznak recovery blokuje reconfigure i po jejím selhání.
    78	    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
    79	      .rejects.toThrow('connection recovery');
    80	
    81	    // Ruční Kontrola pozic se stejným optional skipem jako CLI/UI projde…
    82	    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
    83	      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
    84	    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
    85	
    86	    // …a čistý výsledek recovery příznak shodí: odebrání zmizelého followera už projde.
    87	    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
    88	      .resolves.toBeUndefined();
    89	    expect(h.controller.status().armed).toBe(false);
    90	    h.controller.stop();
    91	  });
    92	
    93	  it('s optional-skip zdrojem recovery projde napoprvé a skupina není blokovaná', async () => {
    94	    const seen: CopyGroupConfig[] = [];
    95	    const h = await harness({
    96	      resolveMissingOptionalAccountIds: async current => {
    97	        seen.push(current);
    98	        return [MISSING, 999_999];
    99	      },
   100	    });
   101	    expect(seen.length).toBeGreaterThan(0);
   102	    expect(h.errors).toEqual([]);
   103	    expect(h.controller.status()).toMatchObject({
   104	      armed: false, reconciliationRequired: false, lastError: null,
   105	    });
   106	    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
   107	      .resolves.toBeUndefined();
   108	    h.controller.stop();
   109	  });
   110	
   111	  it('neúspěšná ruční Kontrola pozic (chybějící follower bez optional skipu) příznak neshazuje', async () => {
   112	    const h = await harness();
   113	    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
   114	    // Bez optional skipu router pro 303 selže → reconcile hodí chybu → pending zůstává.
   115	    await expect(h.controller.reconcile()).rejects.toThrow();
   116	    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
   117	      .rejects.toThrow('connection recovery');
   118	    h.controller.stop();
   119	  });
   120	});

codex
První závěr: čisté `0/0` samo o sobě neznamená „flat“ — může jít i o synchronně otevřeného leadera a followery. To je důležité pro flag, ale topology reconfigure má ještě vlastní broker preflight, takže otevřenou skupinu stejně nepustí. Prověřuju ještě, zda změna skupiny může callback skutečně předběhnout, nebo je serializovaná stejným `eventTail`.
exec
/bin/zsh -lc "rg -n \"updateGroup\\(|reconfigureGroup\\(|activateGroup\\(|group =\" services/copierRuntimeController.ts | tail -n 80" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
298:  reconfigureGroup(group: CopyGroupConfig, options?: CopierGroupReconfigurationOptions): Promise<void>;
303:  activateGroup(group: CopyGroupConfig, options?: CopierGroupReconfigurationOptions): Promise<void>;
305:  updateGroup(group: CopyGroupConfig): void;
422:  let group = options.group;
3963:        group = nextGroup;
4066:      group = nextGroup;
4387:    async reconfigureGroup(nextGroup, reconfigurationOptions = {}) {
4393:    async activateGroup(nextGroup, reconfigurationOptions = {}) {
4404:    updateGroup(nextGroup) {
4412:      group = nextGroup;

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '4125,4415p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  4125	  const unsubscribe = broker.subscribe(event => {
  4126	    eventTail = eventTail.then(() => handleBrokerEvent(event)).catch(failClosed);
  4127	  });
  4128	
  4129	  return {
  4130	    arm({ shadowMode = false, ttlMs }: { shadowMode?: boolean; ttlMs?: number } = {}) {
  4131	      if (stopped) throw new Error('Copier runtime is stopped');
  4132	      if (shutdownRequested) throw new Error('Copier runtime se právě bezpečně ukončuje');
  4133	      if (gate.killSwitch) throw new Error('Copier nelze armovat: kill switch je aktivní');
  4134	      if (ttlMs != null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
  4135	        throw new Error('ARM TTL musí být kladný počet milisekund');
  4136	      }
  4137	      const now = clock();
  4138	      if (!group.enabled) throw new Error('Copier nelze armovat: skupina je vypnutá');
  4139	      if (!gate.connected) throw new Error('Copier nelze armovat bez dokončeného broker syncu');
  4140	      if (source.needsReconciliation()) {
  4141	        throw new Error('Po reconnectu je nutná kontrola pozic; před ARM proveď kontrolu pozic');
  4142	      }
  4143	      const safety = currentRuntime().state.safety;
  4144	      if (!shadowMode && now < safety.dayLockUntil) {
  4145	        throw new Error(`ARM blokován denním lockem: ${safety.dayLockReason ?? 'risk lock'}`);
  4146	      }
  4147	      if (!shadowMode && now < safety.entryCooldownUntil) {
  4148	        const remainingMin = Math.ceil((safety.entryCooldownUntil - now) / 60_000);
  4149	        throw new Error(`ARM blokován anti-revenge cooldownem ještě ${remainingMin} min`);
  4150	      }
  4151	      if (hasStuckOutbox()) throw new Error('Copier má nevyřešený outbox');
  4152	      if (gate.divergentAccounts.size > 0) throw new Error('Pozice leader/follower se rozcházejí');
  4153	      if (workingOrderAccounts.size > 0) throw new Error('Před ARM musí být všechny účty bez pracovních příkazů');
  4154	      if (!shadowMode && !positionCheckComplete) throw new Error('Před live dispatch je nutné potvrdit kontrolu pozic');
  4155	      const ineligible = currentIneligibleAccounts();
  4156	      if (!shadowMode) {
  4157	        const armAccountIds = [
  4158	          group.leaderAccountId,
  4159	          ...group.followers
  4160	            .filter(follower => !ineligible.has(follower.accountId))
  4161	            .map(follower => follower.accountId),
  4162	        ];
  4163	        const allArmAccountsAuthoritativelyFlat = armAccountIds.every(accountId => {
  4164	          const positions = positionsByAccount.get(accountId);
  4165	          return positions != null && [...positions.values()].every(quantity => quantity === 0);
  4166	        });
  4167	        if (!allArmAccountsAuthoritativelyFlat) {
  4168	          throw new Error(
  4169	            'Před ARM musí být všechny zapojené účty flat; otevřený obchod se nikdy automaticky nepřebírá ani nedorovnává',
  4170	          );
  4171	        }
  4172	      }
  4173	      const leaderReason = ineligible.get(group.leaderAccountId);
  4174	      if (leaderReason) throw new Error(`Leader účet není způsobilý pro nové vstupy: ${leaderReason}`);
  4175	      if (!shadowMode) {
  4176	        const participatingFollowers = group.followers.filter(follower =>
  4177	          follower.mode !== 'off' && !ineligible.has(follower.accountId));
  4178	        if (participatingFollowers.length === 0) {
  4179	          throw new Error('ARM blokován: skupina nemá žádný způsobilý follower účet');
  4180	        }
  4181	      }
  4182	      // Kratší z limitů vyhrává: session TTL nesmí ARM prodloužit za výchozí strop.
  4183	      const armTtlMs = ttlMs != null ? Math.min(ttlMs, defaultArmTtlMs) : defaultArmTtlMs;
  4184	      gate = { ...gate, armed: true, armedAt: now, now, shadowMode, armTtlMs };
  4185	      lastResumeOffer = null;
  4186	      // Nová epizoda: ARM prošel všemi branami (flat, žádný stuck outbox),
  4187	      // takže počítadlo nouzových zavření začíná znovu.
  4188	      autoCloseEpisodeAttempts = 0;
  4189	    },
  4190	    beginShutdown() {
  4191	      if (shutdownPromise) return shutdownPromise;
  4192	      if (stopped) return Promise.resolve();
  4193	      shutdownRequested = true;
  4194	      gate = { ...gate, armed: false };
  4195	      lastResumeOffer = null;
  4196	      // Stejně jako DISARM: worker při shutdownu nesmí po restartu nabízet
  4197	      // automatické převzetí expozice. Rozpracovaný outbox/bracket/OSO drain
  4198	      // ale zůstává živý až do waitForIdle().
  4199	      shutdownPromise = syncLiveCopyExposureFlag('clear');
  4200	      // Pilot promise později autoritativně awaitne a případnou chybu vrátí;
  4201	      // handler zde pouze zabrání mezitímnímu unhandled-rejection oknu.
  4202	      void shutdownPromise.catch(() => undefined);
  4203	      return shutdownPromise;
  4204	    },
  4205	    disarm() {
  4206	      const wasArmed = gate.armed;
  4207	      gate = { ...gate, armed: false };
  4208	      if (wasArmed) {
  4209	        recordDisarm(
  4210	          'manual',
  4211	          'Uživatel vypnul kopírku ručně',
  4212	          groupIsFlat() ? 'flat' : 'unknown',
  4213	        );
  4214	      }
  4215	      lastResumeOffer = null;
  4216	      // Ruční DISARM zastaví nové kopie. Starý obecný account-wide boot
  4217	      // auto-close vypneme, ale durable leader-flat epocha zůstává: pokud
  4218	      // leader později zavře, smí dokončit jen prokázanou existující kopii
  4219	      // přes přesný account/symbol guard.
  4220	      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
  4221	    },
  4222	    engageKillSwitch(reason = 'Ruční nouzové zastavení') {
  4223	      if (stopped) return;
  4224	      const wasArmed = gate.armed;
  4225	      invalidateReconciliation();
  4226	      lastError = new Error(reason.trim() || 'Ruční nouzové zastavení');
  4227	      if (wasArmed || !lastDisarm || lastDisarm.trigger !== 'kill-switch') {
  4228	        recordDisarm(
  4229	          'kill-switch',
  4230	          lastError.message,
  4231	          groupIsFlat() ? 'flat' : 'unknown',
  4232	        );
  4233	      }
  4234	      // Kill switch se v této runtime session nedá odjistit. Nový bootstrap znovu
  4235	      // startuje DISARMED a stále vyžaduje reconciliation před ostrým ARM.
  4236	      gate = { ...gate, armed: false, killSwitch: true };
  4237	      lastResumeOffer = null;
  4238	      pendingConnectionRecovery = false;
  4239	      // Kill switch = explicitní freeze; žádná pozdější automatika.
  4240	      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
  4241	      options.onError?.(lastError);
  4242	    },
  4243	    async lockUntil(until, reason) {
  4244	      if (!Number.isFinite(until) || until <= clock()) {
  4245	        throw new Error('Denní lock musí končit v budoucnosti');
  4246	      }
  4247	      const explanation = reason.trim();
  4248	      if (explanation.length < 3) throw new Error('Denní lock vyžaduje důvod');
  4249	      gate = { ...gate, armed: false };
  4250	      await persistSafety({
  4251	        ...currentRuntime().state.safety,
  4252	        dayLockUntil: until,
  4253	        dayLockReason: explanation,
  4254	      });
  4255	    },
  4256	    async applyAccountEligibilityExclusions(exclusions) {
  4257	      // Safety metadata může přijet z webu těsně před ARM/SHADOW. Nikdy
  4258	      // nesmí za běžícího dispatchu změnit účast bez fail-safe DISARMu.
  4259	      gate = { ...gate, armed: false };
  4260	      const members = new Set([
  4261	        group.leaderAccountId,
  4262	        ...group.followers.map(follower => follower.accountId),
  4263	      ]);
  4264	      const now = clock();
  4265	      let changed = false;
  4266	      for (const exclusion of exclusions) {
  4267	        if (!Number.isSafeInteger(exclusion.accountId) || exclusion.accountId <= 0) {
  4268	          throw new Error('Eligibility exclusion obsahuje neplatné accountId');
  4269	        }
  4270	        if (!members.has(exclusion.accountId)) {
  4271	          throw new Error(`Eligibility exclusion míří mimo aktivní skupinu: ${exclusion.accountId}`);
  4272	        }
  4273	        if (exclusion.state !== 'dll-locked' && exclusion.state !== 'breached') {
  4274	          throw new Error('Eligibility exclusion smí účet pouze zamknout jako DLL nebo BREACHED');
  4275	        }
  4276	        const reason = exclusion.reason.trim();
  4277	        if (reason.length < 3 || reason.length > 500) {
  4278	          throw new Error('Eligibility exclusion vyžaduje konkrétní důvod');
  4279	        }
  4280	        const current = accountEligibility.get(exclusion.accountId);
  4281	        // Stav z LIVE smí runtime jen zpřísnit. `unverifiable` je
  4282	        // fail-closed a nesmí se změnit na slabší DLL lock; BREACHED je
  4283	        // nejsilnější trvalá západka.
  4284	        const currentSeverity = current?.state === 'breached'
  4285	          ? 3
  4286	          : current?.state === 'unverifiable'
  4287	            ? 2
  4288	            : current?.state === 'dll-locked'
  4289	              ? 1
  4290	              : 0;
  4291	        const nextSeverity = exclusion.state === 'breached' ? 3 : 1;
  4292	        if (nextSeverity < currentSeverity) continue;
  4293	        const existingDllSessionEnd = current?.state === 'dll-locked'
  4294	          && current.lockSessionEndAt != null
  4295	          && current.lockSessionEndAt > now
  4296	          ? current.lockSessionEndAt
  4297	          : null;
  4298	        const next: CopierAccountEligibility = {
  4299	          ...(current ?? {}),
  4300	          accountId: exclusion.accountId,
  4301	          state: exclusion.state,
  4302	          reason,
  4303	          at: now,
  4304	          lockSessionEndAt: exclusion.state === 'dll-locked'
  4305	            ? existingDllSessionEnd ?? now + msUntilTradovateSessionEnd(now)
  4306	            : undefined,
  4307	        };
  4308	        if (
  4309	          current?.state === next.state
  4310	          && current.reason === next.reason
  4311	          && current.lockSessionEndAt === next.lockSessionEndAt
  4312	        ) continue;
  4313	        setEligibility(exclusion.accountId, next);
  4314	        changed = true;
  4315	      }
  4316	      if (changed) await persistEligibility();
  4317	    },
  4318	    async reconcile(reconciliationOptions = {}) {
  4319	      // Veřejná Kontrola pozic je explicitní uživatelská recovery akce.
  4320	      // Pouze její čistý výsledek smí odstranit starou chybu; automatické
  4321	      // reconnect/terminal-fill kontroly incident uživateli neschovávají.
  4322	      const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
  4323	      if (result.divergentAccounts.length === 0 && result.workingOrderAccounts.length === 0) {
  4324	        // Autoritativně čistý stav je přesně to, co čekající recovery vlna
  4325	        // hledala; jinak by příznak po neúspěšné automatické vlně blokoval
  4326	        // změnu skupiny („rozpracovaný lifecycle: connection recovery“) až do
  4327	        // dalšího connection eventu. Při divergenci zůstává pending.
  4328	        pendingConnectionRecovery = false;
  4329	      }
  4330	      return result;
  4331	    },
  4332	    async verifyAccountEligibility(accountId) {
  4333	      if (!Number.isSafeInteger(accountId) || accountId <= 0) {
  4334	        throw new Error('Neplatné ID účtu pro ověření');
  4335	      }
  4336	      if (!gate.connected) {
  4337	        const reason = lastError?.message?.trim();
  4338	        throw new Error([
  4339	          'Stav účtu nelze ověřit: worker nemá živé spojení s Tradovate.',
  4340	          reason ? `Poslední chyba: ${reason}.` : '',
  4341	          'OAuth přihlášení tím není dotčené — spojení se obnoví samo, zkus to za chvíli znovu.',
  4342	        ].filter(Boolean).join(' '));
  4343	      }
  4344	
  4345	      const now = clock();
  4346	      const current = accountEligibility.get(accountId);
  4347	      const effective = current ? eligibilityAt(current, now) : undefined;
  4348	      if (effective?.state === 'breached') {
  4349	        throw new Error(`Účet je BREACHED a nelze ho automaticky reaktivovat: ${effective.reason ?? 'bez důvodu'}`);
  4350	      }
  4351	      if (effective?.state === 'dll-locked') {
  4352	        throw new Error(`DLL stále platí do konce broker session: ${effective.reason ?? 'bez důvodu'}`);
  4353	      }
  4354	
  4355	      const capabilities = await broker.listAccountCapabilities([accountId]);
  4356	      const capability = capabilities.find(item => item.accountId === accountId);
  4357	      if (!capability) throw new Error(`Broker účet ${accountId} v OAuth spojení nevrátil`);
  4358	      if (!capability.active) throw new Error(`Broker účet ${accountId} stále hlásí jako neaktivní`);
  4359	      if (!capability.canTrade) throw new Error(`Broker účet ${accountId} zatím nepovoluje obchodování`);
  4360	
  4361	      // Oba read-only dotazy jsou součástí důkazu: samotný account/list může
  4362	      // účet vrátit, i když jeho obchodní snapshot zatím není dostupný.
  4363	      await Promise.all([
  4364	        broker.listPositions(accountId),
  4365	        broker.listOrders(accountId),
  4366	      ]);
  4367	
  4368	      const verified: CopierAccountEligibility = {
  4369	        ...(current ?? {}),
  4370	        accountId,
  4371	        state: 'active',
  4372	        reason: 'autoritativně ověřeno u brokera po nové session',
  4373	        at: now,
  4374	        lockSessionEndAt: undefined,
  4375	      };
  4376	      accountEligibility.set(accountId, verified);
  4377	      await persistEligibility();
  4378	      options.onAudit?.([{
  4379	        at: now,
  4380	        leaderEventId: `eligibility-verify-${accountId}`,
  4381	        kind: 'recovered',
  4382	        accountId,
  4383	        reason: 'účet znovu způsobilý — cílené read-only ověření u brokera',
  4384	      }]);
  4385	      return verified;
  4386	    },
  4387	    async reconfigureGroup(nextGroup, reconfigurationOptions = {}) {
  4388	      // UI dostane okamžitě fail-safe DISARM ještě před čekáním na eventTail.
  4389	      gate = { ...gate, armed: false };
  4390	      invalidateReconciliation();
  4391	      await reconfigureLeaderEpoch(nextGroup, reconfigurationOptions);
  4392	    },
  4393	    async activateGroup(nextGroup, reconfigurationOptions = {}) {
  4394	      // Aktivace není ARM. Nejprve fail-safe DISARM, potom plný preflight
  4395	      // staré i nové topologie a nová durable epocha.
  4396	      gate = { ...gate, armed: false };
  4397	      invalidateReconciliation();
  4398	      await reconfigureLeaderEpoch(nextGroup, {
  4399	        ...reconfigurationOptions,
  4400	        allowGroupChange: true,
  4401	        forceEpoch: true,
  4402	      });
  4403	    },
  4404	    updateGroup(nextGroup) {
  4405	      // Jakýkoli pokus o změnu konfigurace nejdřív zavře live dispatch.
  4406	      gate = { ...gate, armed: false };
  4407	      if (nextGroup.id !== group.id) throw new Error('Nelze změnit runtime na jinou copy group');
  4408	      assertRuntimeGroup(nextGroup);
  4409	      if (nextGroup.leaderAccountId !== group.leaderAccountId) {
  4410	        throw new Error('Změna leadera vyžaduje bezpečný reconfigureGroup preflight');
  4411	      }
  4412	      group = nextGroup;
  4413	      invalidateReconciliation();
  4414	    },
  4415	    async flattenAccount(accountId, operationId) {

exec
/bin/zsh -lc "nl -ba services/brokerRouter.ts | sed -n '1,300p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
     1	import type {
     2	  BrokerAccountCapability,
     3	  BrokerEvent,
     4	  BrokerPort,
     5	} from './brokerPort';
     6	
     7	export interface BrokerRoute {
     8	  broker: BrokerPort;
     9	  accountIds: readonly number[];
    10	  /**
    11	   * `false` označuje follower-only spojení, jehož krátký výpadek smí projít
    12	   * ochrannou lhůtou (`reconnectGraceMs`) bez shození celé skupiny.
    13	   * Default `true` = kritické spojení (nese leader stream) — každý výpadek
    14	   * se hlásí okamžitě, protože ztracené leader eventy nejde dopočítat.
    15	   */
    16	  critical?: boolean;
    17	}
    18	
    19	export interface BrokerRouterOptions {
    20	  /**
    21	   * Jak dlouho smí nekritické spojení mlčet, než se výpadek ohlásí.
    22	   * Tradovate zavírá WebSocket při cyklu access tokenu (~80 min) a worker
    23	   * se do ~1 s připojí zpět — bez tolerance každé takové mrknutí JEDNOHO
    24	   * follower spojení odzbrojilo VŠECHNY propfirmy. Objednávka odeslaná
    25	   * během mezery stále selže fail-closed vlastní cestou (outbox lookup);
    26	   * lhůta jen brání planým poplachům bez broker akce.
    27	   */
    28	  reconnectGraceMs?: number;
    29	  setTimeoutImpl?: typeof setTimeout;
    30	  clearTimeoutImpl?: typeof clearTimeout;
    31	}
    32	
    33	export interface BrokerRouterPort extends BrokerPort {
    34	  /** Atomicky nahradí account -> OAuth routy; underlying sockety zůstávají stejné. */
    35	  replaceRoutes(routes: readonly BrokerRoute[]): void;
    36	}
    37	
    38	/**
    39	 * Složí několik OAuth spojení do jednoho broker portu.
    40	 *
    41	 * Každý side effect se směruje výhradně podle accountId. Výpadek kritického
    42	 * spojení (leader) hlásí agregovaný stream okamžitě a controller zruší ARM
    43	 * celé skupiny; nekritická follower spojení dostávají krátkou reconnect
    44	 * lhůtu, aby token cyklus jedné propfirmy nezastavoval všechny ostatní.
    45	 */
    46	export function createBrokerRouter(
    47	  routes: readonly BrokerRoute[],
    48	  options: BrokerRouterOptions = {},
    49	): BrokerRouterPort {
    50	  if (routes.length === 0) throw new Error('Broker router vyžaduje alespoň jedno spojení');
    51	  const environment = routes[0].broker.environment;
    52	  let byAccount = new Map<number, BrokerPort>();
    53	  let accountIdsByBroker = new Map<BrokerPort, Set<number>>();
    54	  const fixedBrokers = routes.map(route => route.broker);
    55	  const configuredBrokers = new Set(fixedBrokers);
    56	  const criticalBrokers = new Set(
    57	    routes.filter(route => route.critical !== false).map(route => route.broker),
    58	  );
    59	  const validateRoutes = (nextRoutes: readonly BrokerRoute[], requireFixedSet: boolean) => {
    60	    const nextByAccount = new Map<number, BrokerPort>();
    61	    const nextAccountIdsByBroker = new Map<BrokerPort, Set<number>>();
    62	    const seenBrokers = new Set<BrokerPort>();
    63	    for (const route of nextRoutes) {
    64	      if (seenBrokers.has(route.broker)) {
    65	        throw new Error('Stejné OAuth spojení nesmí být ve více broker routes');
    66	      }
    67	      seenBrokers.add(route.broker);
    68	      if (requireFixedSet && !configuredBrokers.has(route.broker)) {
    69	        throw new Error('Dynamická broker route obsahuje neznámé OAuth spojení');
    70	      }
    71	      if (route.broker.environment !== environment) {
    72	        throw new Error('Broker router nesmí míchat DEMO a LIVE prostředí');
    73	      }
    74	      const ids = new Set<number>();
    75	      for (const accountId of route.accountIds) {
    76	        if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    77	          throw new Error('Broker route obsahuje neplatný accountId');
    78	        }
    79	        if (nextByAccount.has(accountId)) throw new Error(`Účet ${accountId} je ve více broker routes`);
    80	        nextByAccount.set(accountId, route.broker);
    81	        ids.add(accountId);
    82	      }
    83	      nextAccountIdsByBroker.set(route.broker, ids);
    84	    }
    85	    if (requireFixedSet && (seenBrokers.size !== configuredBrokers.size || fixedBrokers.some(item => !seenBrokers.has(item)))) {
    86	      throw new Error('Dynamická změna rout nesmí přidat ani odebrat OAuth spojení');
    87	    }
    88	    return { nextByAccount, nextAccountIdsByBroker };
    89	  };
    90	  ({ nextByAccount: byAccount, nextAccountIdsByBroker: accountIdsByBroker } = validateRoutes(routes, false));
    91	
    92	  const brokerFor = (accountId: number): BrokerPort => {
    93	    const broker = byAccount.get(accountId);
    94	    if (!broker) throw new Error(`Pro účet ${accountId} není nakonfigurované OAuth spojení`);
    95	    return broker;
    96	  };
    97	
    98	  return {
    99	    environment,
   100	    replaceRoutes(nextRoutes) {
   101	      const validated = validateRoutes(nextRoutes, true);
   102	      // Přepnutí je synchronní a atomické: při jediné validační chybě zůstane
   103	      // původní mapa i event filtr beze změny.
   104	      byAccount = validated.nextByAccount;
   105	      accountIdsByBroker = validated.nextAccountIdsByBroker;
   106	    },
   107	    setCriticalAccounts(accountIds) {
   108	      const next = new Set<BrokerPort>();
   109	      for (const accountId of accountIds) next.add(brokerFor(accountId));
   110	      criticalBrokers.clear();
   111	      for (const broker of next) criticalBrokers.add(broker);
   112	    },
   113	    placeOrder: request => brokerFor(request.accountId).placeOrder(request),
   114	    liquidatePosition: async request => {
   115	      const broker = brokerFor(request.accountId);
   116	      if (!broker.liquidatePosition) throw new Error('OAuth spojení nepodporuje nativní nouzové zploštění');
   117	      return broker.liquidatePosition(request);
   118	    },
   119	    placeOco: async request => {
   120	      const broker = brokerFor(request.accountId);
   121	      if (!broker.placeOco) throw new Error('OAuth spojení nepodporuje nativní OCO');
   122	      return broker.placeOco(request);
   123	    },
   124	    placeOso: async request => {
   125	      const broker = brokerFor(request.accountId);
   126	      if (!broker.placeOso) throw new Error('OAuth spojení nepodporuje nativní OSO');
   127	      return broker.placeOso(request);
   128	    },
   129	    cancelOrder: (accountId, brokerOrderId) => brokerFor(accountId).cancelOrder(accountId, brokerOrderId),
   130	    modifyOrder: (accountId, brokerOrderId, changes) =>
   131	      brokerFor(accountId).modifyOrder(accountId, brokerOrderId, changes),
   132	    async listAccountCapabilities(accountIds): Promise<BrokerAccountCapability[]> {
   133	      const grouped = new Map<BrokerPort, number[]>();
   134	      for (const accountId of accountIds) {
   135	        const broker = brokerFor(accountId);
   136	        grouped.set(broker, [...(grouped.get(broker) ?? []), accountId]);
   137	      }
   138	      return (await Promise.all([...grouped].map(([broker, ids]) =>
   139	        broker.listAccountCapabilities(ids)))).flat();
   140	    },
   141	    listPositions: accountId => brokerFor(accountId).listPositions(accountId),
   142	    listOrders: accountId => brokerFor(accountId).listOrders(accountId),
   143	    findOrdersByTag: (accountId, tag) => brokerFor(accountId).findOrdersByTag(accountId, tag),
   144	    findOrderById: (accountId, brokerOrderId) =>
   145	      brokerFor(accountId).findOrderById(accountId, brokerOrderId),
   146	    subscribe(listener) {
   147	      const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
   148	      const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
   149	      const graceMs = options.reconnectGraceMs ?? 10_000;
   150	      const connected = new Map(fixedBrokers.map(broker => [broker, false]));
   151	      let aggregateConnected = false;
   152	      /** Zadržené error/connection eventy nekritické route během reconnect lhůty. */
   153	      const pendingOutage = new Map<BrokerPort, {
   154	        timer: ReturnType<typeof setTimeout>;
   155	        held: BrokerEvent[];
   156	      }>();
   157	
   158	      const applyConnection = (broker: BrokerPort, event: Extract<BrokerEvent, { type: 'connection' }>) => {
   159	        connected.set(broker, event.connected);
   160	        const next = [...connected.values()].every(Boolean);
   161	        if (next !== aggregateConnected) {
   162	          aggregateConnected = next;
   163	          listener({ type: 'connection', connected: next, at: event.at });
   164	        }
   165	      };
   166	
   167	      const flushOutage = (broker: BrokerPort) => {
   168	        const outage = pendingOutage.get(broker);
   169	        if (!outage) return;
   170	        pendingOutage.delete(broker);
   171	        for (const held of outage.held) {
   172	          if (held.type === 'connection') applyConnection(broker, held);
   173	          else listener(held);
   174	        }
   175	      };
   176	
   177	      const unsubs = fixedBrokers.map(routeBroker => routeBroker.subscribe((event: BrokerEvent) => {
   178	        if (event.type === 'order' || event.type === 'fill' || event.type === 'position') {
   179	          const accountId = event.type === 'order'
   180	            ? event.order.accountId
   181	            : event.type === 'fill'
   182	              ? event.fill.accountId
   183	              : event.position.accountId;
   184	          // Jedno OAuth může vidět více účtů, než mu bylo svěřeno v route.
   185	          // Takové entity sem nesmí projít: při překryvu OAuth viditelnosti by
   186	          // se leader lifecycle zpracoval dvakrát.
   187	          if (!accountIdsByBroker.get(routeBroker)?.has(accountId)) return;
   188	          listener(event);
   189	          return;
   190	        }
   191	        const grace = !criticalBrokers.has(routeBroker) && graceMs > 0;
   192	        if (event.type === 'error') {
   193	          if (!grace) {
   194	            listener(event);
   195	            return;
   196	          }
   197	          // Transport chyba nekritické route předchází jejímu disconnect
   198	          // eventu — zadržíme ji ve stejné lhůtě. Objednávky mají vlastní
   199	          // fail-closed cestu, tady jde jen o plané poplachy.
   200	          const outage = pendingOutage.get(routeBroker);
   201	          if (outage) {
   202	            outage.held.push(event);
   203	          } else {
   204	            pendingOutage.set(routeBroker, {
   205	              held: [event],
   206	              timer: setTimeoutImpl(() => flushOutage(routeBroker), graceMs),
   207	            });
   208	          }
   209	          return;
   210	        }
   211	        if (event.type !== 'connection') {
   212	          listener(event);
   213	          return;
   214	        }
   215	        if (!grace) {
   216	          applyConnection(routeBroker, event);
   217	          return;
   218	        }
   219	        const outage = pendingOutage.get(routeBroker);
   220	        if (!event.connected) {
   221	          if (outage) {
   222	            outage.held.push(event);
   223	          } else {
   224	            pendingOutage.set(routeBroker, {
   225	              held: [event],
   226	              timer: setTimeoutImpl(() => flushOutage(routeBroker), graceMs),
   227	            });
   228	          }
   229	          return;
   230	        }
   231	        if (outage) {
   232	          // Reconnect ve lhůtě: mrknutí se nikdy nestalo — zadržené eventy
   233	          // se zahodí a agregát zůstává beze změny.
   234	          clearTimeoutImpl(outage.timer);
   235	          pendingOutage.delete(routeBroker);
   236	          connected.set(routeBroker, true);
   237	          return;
   238	        }
   239	        applyConnection(routeBroker, event);
   240	      }));
   241	      return () => {
   242	        for (const outage of pendingOutage.values()) clearTimeoutImpl(outage.timer);
   243	        pendingOutage.clear();
   244	        unsubs.forEach(unsubscribe => unsubscribe());
   245	      };
   246	    },
   247	  };
   248	}

exec
/bin/zsh -lc 'rg -n "function prepareGroupAccounts|const prepareGroupAccounts|PrepareGroupAccounts" scripts/copier/pilot.ts' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
52:  type PrepareGroupAccountsRequest,
53:  type PrepareGroupAccountsResult,
307:  prepareGroupAccounts?: (request: PrepareGroupAccountsRequest) => Promise<PrepareGroupAccountsResult>,

exec
/bin/zsh -lc "nl -ba scripts/copier/pilot.ts | sed -n '1210,1375p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  1210	  if (minutes <= 0 || minutes > 120) throw new Error('--minutes musí být v rozsahu 1 až 120');
  1211	  if (context.expiresAt && Date.parse(context.expiresAt) - Date.now() <= (minutes + 5) * 60_000) {
  1212	    throw new Error(`Pilot lease nevydrží celý ${minutes}min test a 5min rezervu; stáhni nový lease`);
  1213	  }
  1214	  const root = resolve('.copier-pilot');
  1215	  await mkdir(root, { recursive: true, mode: 0o700 });
  1216	  const key = `${context.connectionId}-${leaderId}-${followerId}`;
  1217	  const releaseLock = await acquireProcessLock(resolve(root, `${key}.lock`));
  1218	  const auditPath = resolve(root, `${key}.audit.jsonl`);
  1219	  const metrics = createCopierMetrics();
  1220	  const broker = createTradovateBroker({
  1221	    environment: 'demo',
  1222	    accountSpec: context.accountSpec,
  1223	    accountSpecsByAccountId,
  1224	    getAccessToken: context.getAccessToken,
  1225	    connectionLabel: connectionLabel(context.connectionId),
  1226	    onReconnectDiagnostic: logReconnectDiagnostic,
  1227	  });
  1228	  const group: CopyGroupConfig = {
  1229	    id: `pilot-${leaderId}-${followerId}`,
  1230	    name: 'Ranní pilot',
  1231	    enabled: true,
  1232	    leaderAccountId: leaderId,
  1233	    followers: [{ accountId: followerId, mode: 'on-submit', multiplier: 1 }],
  1234	    localOnly: true,
  1235	  };
  1236	  let controller: CopierRuntimeController | null = null;
  1237	  let stopping = false;
  1238	  let stopPromise: Promise<void> | null = null;
  1239	  let auditTail: Promise<void> = Promise.resolve();
  1240	  const writeAudit = async (entries: readonly CopierAuditEntry[]) => {
  1241	    if (entries.length === 0) return;
  1242	    await appendFile(auditPath, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
  1243	    for (const entry of entries) {
  1244	      console.log(`${new Date(entry.at).toISOString()} ${entry.kind} account=${entry.accountId ?? '-'} reason=${entry.reason ?? '-'}`);
  1245	    }
  1246	  };
  1247	  const stop = (reason: string): Promise<void> => {
  1248	    if (stopPromise) return stopPromise;
  1249	    stopping = true;
  1250	    stopPromise = (async () => {
  1251	      controller?.disarm();
  1252	      await controller?.waitForIdle();
  1253	      await auditTail;
  1254	      controller?.stop();
  1255	      const total = metrics.samples.map(item => item.totalMs);
  1256	      console.log(`STOP ${reason}; dispatched=${metrics.dispatched} unknown=${metrics.unknown} duplicates=${metrics.duplicatesFound} p95=${percentile(total, 95)}ms`);
  1257	      try {
  1258	        const final = await Promise.all([leaderId, followerId].map(async accountId => ({
  1259	          accountId,
  1260	          positions: await broker.listPositions(accountId),
  1261	          orders: await broker.listOrders(accountId),
  1262	        })));
  1263	        const unsafe = final.filter(item =>
  1264	          item.positions.some(position => position.netQuantity !== 0)
  1265	          || item.orders.some(order => isOpenOrderStatus(order.status)));
  1266	        if (unsafe.length > 0) {
  1267	          console.error(`MANUAL ACTION REQUIRED: po STOP nejsou flat/no-working účty ${unsafe.map(item => item.accountId).join(',')}`);
  1268	        } else {
  1269	          console.log('PASS final state: leader i follower jsou flat a bez working orders.');
  1270	        }
  1271	      } catch (error) {
  1272	        console.error(`MANUAL CHECK REQUIRED: finální broker stav nešel ověřit (${error instanceof Error ? error.message : String(error)})`);
  1273	      }
  1274	      await releaseLock();
  1275	    })();
  1276	    return stopPromise;
  1277	  };
  1278	  const onSignal = () => { void stop('operator-signal'); };
  1279	  process.once('SIGINT', onSignal);
  1280	  process.once('SIGTERM', onSignal);
  1281	  try {
  1282	    controller = await bootstrapCopierRuntime({
  1283	      broker,
  1284	      store: createFileCopierStore(resolve(root, `${key}.snapshot.json`)),
  1285	      group,
  1286	      metrics,
  1287	      maxConcurrentDispatches: 1,
  1288	      maxLeaderOrders: mode === 'live' ? 1 : undefined,
  1289	      allowSingleFlatExit: mode === 'live',
  1290	      onLeaderEvent: event => {
  1291	        if (mode !== 'shadow') return;
  1292	        console.log([
  1293	          'LEADER',
  1294	          `kind=${event.kind}`,
  1295	          `order=${event.orderId}`,
  1296	          `type=${event.orderType}`,
  1297	          `side=${event.side}`,
  1298	          `qty=${event.quantity}`,
  1299	          `limit=${event.limitPrice ?? '-'}`,
  1300	          `stop=${event.stopPrice ?? '-'}`,
  1301	          `parent=${event.parentOrderId ?? '-'}`,
  1302	          `oco=${event.ocoId ?? '-'}`,
  1303	          `linked=${event.linkedOrderId ?? '-'}`,
  1304	        ].join(' '));
  1305	      },
  1306	      onBracketPair: pair => {
  1307	        if (mode !== 'shadow') return;
  1308	        console.log([
  1309	          'BRACKET',
  1310	          `entry=${pair.entryOrderId}`,
  1311	          `stop=${pair.stopOrderId}@${pair.stopPrice}`,
  1312	          `target=${pair.targetOrderId}@${pair.targetPrice}`,
  1313	          `side=${pair.side}`,
  1314	          `qty=${pair.quantity}`,
  1315	          `via=${pair.correlation}`,
  1316	        ].join(' '));
  1317	      },
  1318	      onAudit: entries => {
  1319	        auditTail = auditTail.then(() => writeAudit(entries));
  1320	      },
  1321	      onError: logControllerError,
  1322	    });
  1323	    await waitUntil(() => controller?.status().connected === true, 15_000, 'WebSocket sync timeout');
  1324	    const reconciliation = await controller.reconcile();
  1325	    if (reconciliation.divergentAccounts.length || reconciliation.workingOrderAccounts.length) {
  1326	      throw new Error(`Reconciliation failed: divergence=${reconciliation.divergentAccounts.join(',')} working=${reconciliation.workingOrderAccounts.join(',')}`);
  1327	    }
  1328	    controller.arm({ shadowMode: mode === 'shadow' });
  1329	    console.log(`ARMED ${mode.toUpperCase()} leader=${leaderId} follower=${followerId} multiplier=1 max=${minutes}min`);
  1330	    if (mode === 'live') console.log('Pouze jeden ručně koordinovaný entry order; jeho potvrzený OCO SL/TP lifecycle se smí bezpečně dokončit.');
  1331	    const deadline = Date.now() + minutes * 60_000;
  1332	    while (!stopping && Date.now() < deadline) {
  1333	      await delay(1_000);
  1334	      const status = controller.status();
  1335	      if (status.lastError || status.killSwitch || status.stuckOutbox || !status.connected) {
  1336	        controller.disarm();
  1337	        throw new Error(`Runtime fail-closed: ${status.lastError ?? 'connection/outbox gate'}`);
  1338	      }
  1339	    }
  1340	    await stop('time-limit');
  1341	  } finally {
  1342	    process.off('SIGINT', onSignal);
  1343	    process.off('SIGTERM', onSignal);
  1344	    if (!stopping) await stop('startup-failure');
  1345	  }
  1346	}
  1347	
  1348	async function acquireProcessLock(path: string): Promise<() => Promise<void>> {
  1349	  try {
  1350	    const handle = await open(path, 'wx', 0o600);
  1351	    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  1352	    await handle.sync();
  1353	    await handle.close();
  1354	  } catch (error) {
  1355	    if (!isCode(error, 'EEXIST')) throw error;
  1356	    let pid = 0;
  1357	    try {
  1358	      const raw = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
  1359	      pid = Number(raw.pid);
  1360	    } catch {
  1361	      throw new Error(`Pilot lock existuje a nejde ověřit: ${path}`);
  1362	    }
  1363	    if (Number.isSafeInteger(pid) && pid > 0 && processExists(pid)) {
  1364	      throw new Error(`Jiný pilot runtime už běží (pid ${pid})`);
  1365	    }
  1366	    await unlink(path);
  1367	    return acquireProcessLock(path);
  1368	  }
  1369	  let released = false;
  1370	  return async () => {
  1371	    if (released) return;
  1372	    released = true;
  1373	    await unlink(path).catch(error => { if (!isCode(error, 'ENOENT')) throw error; });
  1374	  };
  1375	}

exec
/bin/zsh -lc 'rg -n -C 5 "connection recovery|liveCopyOpenSince|resumeLeaderFlatEpochsAfterSnapshot|leaderExposureEpochs" tests | head -n 500' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
tests/copierConnectionRecoveryOptionalFollower.test.ts-8-/**
tests/copierConnectionRecoveryOptionalFollower.test.ts-9- * Incident 3. 9. 2026 05:45 UTC: breached follower 63338752 zmizel z OAuth.
tests/copierConnectionRecoveryOptionalFollower.test.ts-10- * Automatická post-connect recovery routovala i jeho → router vyhodil chybu →
tests/copierConnectionRecoveryOptionalFollower.test.ts-11- * po pěti pokusech fail-closed a `pendingConnectionRecovery` zůstal zapnutý.
tests/copierConnectionRecoveryOptionalFollower.test.ts-12- * Ruční Kontrola pozic (s optional skipem) prošla, ale příznak dál blokoval
tests/copierConnectionRecoveryOptionalFollower.test.ts:13: * změnu skupiny („rozpracovaný lifecycle: connection recovery“).
tests/copierConnectionRecoveryOptionalFollower.test.ts-14- */
tests/copierConnectionRecoveryOptionalFollower.test.ts-15-
tests/copierConnectionRecoveryOptionalFollower.test.ts-16-const MISSING = 303;
tests/copierConnectionRecoveryOptionalFollower.test.ts-17-const group: CopyGroupConfig = {
tests/copierConnectionRecoveryOptionalFollower.test.ts-18-  id: 'g-recovery', name: 'Recovery', enabled: true, leaderAccountId: 100,
--
tests/copierConnectionRecoveryOptionalFollower.test.ts-33-  const initial = emptySnapshot();
tests/copierConnectionRecoveryOptionalFollower.test.ts-34-  initial.safety = {
tests/copierConnectionRecoveryOptionalFollower.test.ts-35-    entryCooldownUntil: 0,
tests/copierConnectionRecoveryOptionalFollower.test.ts-36-    dayLockUntil: 0,
tests/copierConnectionRecoveryOptionalFollower.test.ts-37-    // Durable stopa „za živého ARM existovaly kopie“ → boot recovery po připojení.
tests/copierConnectionRecoveryOptionalFollower.test.ts:38:    liveCopyOpenSince: 1,
tests/copierConnectionRecoveryOptionalFollower.test.ts-39-    accountEligibility: [{
tests/copierConnectionRecoveryOptionalFollower.test.ts-40-      accountId: MISSING, state: 'breached', reason: 'LIVE equity dosáhla drawdown flooru', at: 900,
tests/copierConnectionRecoveryOptionalFollower.test.ts-41-    }],
tests/copierConnectionRecoveryOptionalFollower.test.ts-42-  };
tests/copierConnectionRecoveryOptionalFollower.test.ts-43-  const mock = createMockBroker({
--
tests/copierConnectionRecoveryOptionalFollower.test.ts-74-    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
tests/copierConnectionRecoveryOptionalFollower.test.ts-75-    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
tests/copierConnectionRecoveryOptionalFollower.test.ts-76-
tests/copierConnectionRecoveryOptionalFollower.test.ts-77-    // Stav po včerejšku: příznak recovery blokuje reconfigure i po jejím selhání.
tests/copierConnectionRecoveryOptionalFollower.test.ts-78-    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
tests/copierConnectionRecoveryOptionalFollower.test.ts:79:      .rejects.toThrow('connection recovery');
tests/copierConnectionRecoveryOptionalFollower.test.ts-80-
tests/copierConnectionRecoveryOptionalFollower.test.ts-81-    // Ruční Kontrola pozic se stejným optional skipem jako CLI/UI projde…
tests/copierConnectionRecoveryOptionalFollower.test.ts-82-    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
tests/copierConnectionRecoveryOptionalFollower.test.ts-83-      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
tests/copierConnectionRecoveryOptionalFollower.test.ts-84-    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
--
tests/copierConnectionRecoveryOptionalFollower.test.ts-112-    const h = await harness();
tests/copierConnectionRecoveryOptionalFollower.test.ts-113-    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
tests/copierConnectionRecoveryOptionalFollower.test.ts-114-    // Bez optional skipu router pro 303 selže → reconcile hodí chybu → pending zůstává.
tests/copierConnectionRecoveryOptionalFollower.test.ts-115-    await expect(h.controller.reconcile()).rejects.toThrow();
tests/copierConnectionRecoveryOptionalFollower.test.ts-116-    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
tests/copierConnectionRecoveryOptionalFollower.test.ts:117:      .rejects.toThrow('connection recovery');
tests/copierConnectionRecoveryOptionalFollower.test.ts-118-    h.controller.stop();
tests/copierConnectionRecoveryOptionalFollower.test.ts-119-  });
tests/copierConnectionRecoveryOptionalFollower.test.ts-120-});
--
tests/copierRuntimeController.test.ts-337-    controller.stop();
tests/copierRuntimeController.test.ts-338-  });
tests/copierRuntimeController.test.ts-339-
tests/copierRuntimeController.test.ts-340-  it('shutdown i waitForIdle čekají na durable smazání restart-recovery exposure flagu', async () => {
tests/copierRuntimeController.test.ts-341-    const initial = emptySnapshot();
tests/copierRuntimeController.test.ts:342:    initial.safety = { ...initial.safety!, liveCopyOpenSince: 123 };
tests/copierRuntimeController.test.ts-343-    const durable = createMemoryCopierStore(initial);
tests/copierRuntimeController.test.ts-344-    let releaseCommit!: () => void;
tests/copierRuntimeController.test.ts-345-    let markCommitStarted!: () => void;
tests/copierRuntimeController.test.ts-346-    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
tests/copierRuntimeController.test.ts-347-    const commitStarted = new Promise<void>(resolve => { markCommitStarted = resolve; });
tests/copierRuntimeController.test.ts-348-    const store = {
tests/copierRuntimeController.test.ts-349-      load: () => durable.load(),
tests/copierRuntimeController.test.ts-350-      commit: async (snapshot: Parameters<typeof durable.commit>[0], expectedRevision: number) => {
tests/copierRuntimeController.test.ts:351:        if (snapshot.safety?.liveCopyOpenSince == null) {
tests/copierRuntimeController.test.ts-352-          markCommitStarted();
tests/copierRuntimeController.test.ts-353-          await commitGate;
tests/copierRuntimeController.test.ts-354-        }
tests/copierRuntimeController.test.ts-355-        return durable.commit(snapshot, expectedRevision);
tests/copierRuntimeController.test.ts-356-      },
--
tests/copierRuntimeController.test.ts-371-    expect(shutdownSettled).toBe(false);
tests/copierRuntimeController.test.ts-372-    expect(idleSettled).toBe(false);
tests/copierRuntimeController.test.ts-373-
tests/copierRuntimeController.test.ts-374-    releaseCommit();
tests/copierRuntimeController.test.ts-375-    await Promise.all([shutdown, idle]);
tests/copierRuntimeController.test.ts:376:    expect((await durable.load()).safety).not.toHaveProperty('liveCopyOpenSince');
tests/copierRuntimeController.test.ts-377-    controller.stop();
tests/copierRuntimeController.test.ts-378-  });
tests/copierRuntimeController.test.ts-379-
tests/copierRuntimeController.test.ts-380-  it('shutdown clear se zařadí až za právě commitovaný exposure update', async () => {
tests/copierRuntimeController.test.ts-381-    const durable = createMemoryCopierStore();
--
tests/copierRuntimeController.test.ts-387-    let clearCommits = 0;
tests/copierRuntimeController.test.ts-388-    const store = {
tests/copierRuntimeController.test.ts-389-      load: () => durable.load(),
tests/copierRuntimeController.test.ts-390-      commit: async (snapshot: Parameters<typeof durable.commit>[0], expectedRevision: number) => {
tests/copierRuntimeController.test.ts-391-        const before = await durable.load();
tests/copierRuntimeController.test.ts:392:        if (!updateBlocked && before.safety?.liveCopyOpenSince == null && snapshot.safety?.liveCopyOpenSince != null) {
tests/copierRuntimeController.test.ts-393-          updateBlocked = true;
tests/copierRuntimeController.test.ts-394-          markUpdateStarted();
tests/copierRuntimeController.test.ts-395-          await updateGate;
tests/copierRuntimeController.test.ts-396-        }
tests/copierRuntimeController.test.ts:397:        if (before.safety?.liveCopyOpenSince != null && snapshot.safety?.liveCopyOpenSince == null) {
tests/copierRuntimeController.test.ts-398-          clearCommits += 1;
tests/copierRuntimeController.test.ts-399-        }
tests/copierRuntimeController.test.ts-400-        return durable.commit(snapshot, expectedRevision);
tests/copierRuntimeController.test.ts-401-      },
tests/copierRuntimeController.test.ts-402-    };
--
tests/copierRuntimeController.test.ts-422-
tests/copierRuntimeController.test.ts-423-    releaseUpdate();
tests/copierRuntimeController.test.ts-424-    await Promise.all([shutdown, controller.waitForIdle()]);
tests/copierRuntimeController.test.ts-425-    expect(updateBlocked).toBe(true);
tests/copierRuntimeController.test.ts-426-    expect(clearCommits).toBe(1);
tests/copierRuntimeController.test.ts:427:    expect((await durable.load()).safety).not.toHaveProperty('liveCopyOpenSince');
tests/copierRuntimeController.test.ts-428-    controller.stop();
tests/copierRuntimeController.test.ts-429-  });
tests/copierRuntimeController.test.ts-430-
tests/copierRuntimeController.test.ts-431-  it('změna konfigurace vždy disarmuje a neplatnou změnu vůbec nepřijme', async () => {
tests/copierRuntimeController.test.ts-432-    const broker = createMockBroker();
--
tests/copierRuntimeController.test.ts-3368-    await new Promise(resolve => setTimeout(resolve, 30));
tests/copierRuntimeController.test.ts-3369-    await controller.waitForIdle();
tests/copierRuntimeController.test.ts-3370-
tests/copierRuntimeController.test.ts-3371-    expect(controller.status()).toMatchObject({ armed: true, divergentAccounts: [], lastError: null });
tests/copierRuntimeController.test.ts-3372-    expect(broker.placedRequests()).toHaveLength(0);
tests/copierRuntimeController.test.ts:3373:    expect((await store.load()).safety?.leaderExposureEpochs).toEqual([
tests/copierRuntimeController.test.ts-3374-      expect.objectContaining({
tests/copierRuntimeController.test.ts-3375-        symbol: 'MNQU6',
tests/copierRuntimeController.test.ts-3376-        lastLeaderNet: 5,
tests/copierRuntimeController.test.ts-3377-        phase: 'open',
tests/copierRuntimeController.test.ts-3378-        followers: [expect.objectContaining({
--
tests/copierRuntimeController.test.ts-3380-          eligibleAtOpen: false,
tests/copierRuntimeController.test.ts-3381-          copyLineage: 'unproven',
tests/copierRuntimeController.test.ts-3382-        })],
tests/copierRuntimeController.test.ts-3383-      }),
tests/copierRuntimeController.test.ts-3384-    ]);
tests/copierRuntimeController.test.ts:3385:    expect((await store.load()).safety?.leaderExposureEpochs?.[0].followers[0])
tests/copierRuntimeController.test.ts-3386-      .not.toHaveProperty('confirmedNetQuantity');
tests/copierRuntimeController.test.ts-3387-    controller.stop();
tests/copierRuntimeController.test.ts-3388-  });
tests/copierRuntimeController.test.ts-3389-});
tests/copierRuntimeController.test.ts-3390-
--
tests/copierRuntimeController.test.ts-3441-    const store = createMemoryCopierStore({
tests/copierRuntimeController.test.ts-3442-      ...initial,
tests/copierRuntimeController.test.ts-3443-      osoOutbox: [protectiveOso],
tests/copierRuntimeController.test.ts-3444-      safety: {
tests/copierRuntimeController.test.ts-3445-        ...initial.safety!,
tests/copierRuntimeController.test.ts:3446:        liveCopyOpenSince: 90,
tests/copierRuntimeController.test.ts-3447-        accountEligibility: [{
tests/copierRuntimeController.test.ts-3448-          accountId: 200,
tests/copierRuntimeController.test.ts-3449-          state: 'active',
tests/copierRuntimeController.test.ts-3450-          at: 95,
tests/copierRuntimeController.test.ts-3451-          lastExecution: {
--
tests/copierRuntimeController.test.ts-3457-            side: 'Sell',
tests/copierRuntimeController.test.ts-3458-            stopPrice: 29_900,
tests/copierRuntimeController.test.ts-3459-            at: 95,
tests/copierRuntimeController.test.ts-3460-          },
tests/copierRuntimeController.test.ts-3461-        }],
tests/copierRuntimeController.test.ts:3462:        leaderExposureEpochs: [{
tests/copierRuntimeController.test.ts-3463-          id: 'guard-owned-epoch',
tests/copierRuntimeController.test.ts-3464-          groupId: group.id,
tests/copierRuntimeController.test.ts-3465-          leaderAccountId: 100,
tests/copierRuntimeController.test.ts-3466-          symbol: MNQ,
tests/copierRuntimeController.test.ts-3467-          openedAt: 90,
--
tests/copierRuntimeController.test.ts-3610-      expect.objectContaining({ symbol: MNQ, netQuantity: 0 }),
tests/copierRuntimeController.test.ts-3611-      expect.objectContaining({ symbol: NQ, netQuantity: 2 }),
tests/copierRuntimeController.test.ts-3612-    ]));
tests/copierRuntimeController.test.ts-3613-    expect((await store.load()).outbox.filter(entry => entry.operationKind === 'liquidate-position'))
tests/copierRuntimeController.test.ts-3614-      .toEqual([]);
tests/copierRuntimeController.test.ts:3615:    expect((await store.load()).safety?.leaderExposureEpochs).toEqual([
tests/copierRuntimeController.test.ts-3616-      expect.objectContaining({ id: 'guard-owned-epoch', phase: 'resolved' }),
tests/copierRuntimeController.test.ts-3617-    ]);
tests/copierRuntimeController.test.ts-3618-    expect(controller.status().armed).toBe(false);
tests/copierRuntimeController.test.ts-3619-    controller.stop();
tests/copierRuntimeController.test.ts-3620-  });
--
tests/copierRuntimeController.test.ts-3628-    broker.emitEvent({
tests/copierRuntimeController.test.ts-3629-      type: 'position',
tests/copierRuntimeController.test.ts-3630-      position: { accountId: 100, symbol: MNQ, netQuantity: 0 },
tests/copierRuntimeController.test.ts-3631-    });
tests/copierRuntimeController.test.ts-3632-    await controller.waitForIdle();
tests/copierRuntimeController.test.ts:3633:    expect((await store.load()).safety?.leaderExposureEpochs?.[0]).toMatchObject({
tests/copierRuntimeController.test.ts-3634-      phase: 'grace',
tests/copierRuntimeController.test.ts-3635-      leaderExitOrderIds: [],
tests/copierRuntimeController.test.ts-3636-    });
tests/copierRuntimeController.test.ts-3637-
tests/copierRuntimeController.test.ts-3638-    broker.emitEvent({
--
tests/copierRuntimeController.test.ts-3649-        filledAt: 101,
tests/copierRuntimeController.test.ts-3650-      },
tests/copierRuntimeController.test.ts-3651-    });
tests/copierRuntimeController.test.ts-3652-    await controller.waitForIdle();
tests/copierRuntimeController.test.ts-3653-
tests/copierRuntimeController.test.ts:3654:    expect((await store.load()).safety?.leaderExposureEpochs?.[0]).toMatchObject({
tests/copierRuntimeController.test.ts-3655-      phase: 'grace',
tests/copierRuntimeController.test.ts-3656-      leaderExitOrderIds: ['late-leader-exit'],
tests/copierRuntimeController.test.ts-3657-    });
tests/copierRuntimeController.test.ts-3658-    expect(broker.liquidateRequests()).toEqual([]);
tests/copierRuntimeController.test.ts-3659-    controller.stop();
--
tests/copierChaosScenarios.test.ts-254-    expect(controller.status().autoClose).toBeNull();
tests/copierChaosScenarios.test.ts-255-    controller.stop();
tests/copierChaosScenarios.test.ts-256-  });
tests/copierChaosScenarios.test.ts-257-});
tests/copierChaosScenarios.test.ts-258-
tests/copierChaosScenarios.test.ts:259:describe('connection recovery podle stavu (výpadek spojení / pád Macu)', () => {
tests/copierChaosScenarios.test.ts-260-  const recoveryGroup: CopyGroupConfig = {
tests/copierChaosScenarios.test.ts-261-    ...group,
tests/copierChaosScenarios.test.ts-262-    safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'followers' },
tests/copierChaosScenarios.test.ts-263-  };
tests/copierChaosScenarios.test.ts-264-
--
tests/copierChaosScenarios.test.ts-368-      reason: expect.stringContaining('žádný broker write'),
tests/copierChaosScenarios.test.ts-369-    })]));
tests/copierChaosScenarios.test.ts-370-    controller.stop();
tests/copierChaosScenarios.test.ts-371-  });
tests/copierChaosScenarios.test.ts-372-
tests/copierChaosScenarios.test.ts:373:  it('boot s liveCopyOpenSince bez epochy orphan pouze detekuje a durable stopu zachová', async () => {
tests/copierChaosScenarios.test.ts-374-    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
tests/copierChaosScenarios.test.ts-375-    // Kopie existuje u brokera, leader je flat — worker mezitím ležel.
tests/copierChaosScenarios.test.ts-376-    await broker.placeOrder({
tests/copierChaosScenarios.test.ts-377-      tag: 'seed-follower', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
tests/copierChaosScenarios.test.ts-378-    });
tests/copierChaosScenarios.test.ts-379-    const store = createMemoryCopierStore({
tests/copierChaosScenarios.test.ts-380-      ...emptySnapshot(),
tests/copierChaosScenarios.test.ts:381:      safety: { entryCooldownUntil: 0, dayLockUntil: 0, liveCopyOpenSince: 50 },
tests/copierChaosScenarios.test.ts-382-    });
tests/copierChaosScenarios.test.ts-383-    const placedBefore = broker.placedRequests().length;
tests/copierChaosScenarios.test.ts-384-    const controller = await bootstrapCopierRuntime({
tests/copierChaosScenarios.test.ts-385-      broker, store, group: recoveryGroup, clock: stepClock(),
tests/copierChaosScenarios.test.ts-386-    });
--
tests/copierChaosScenarios.test.ts-395-      divergentAccounts: [200],
tests/copierChaosScenarios.test.ts-396-    });
tests/copierChaosScenarios.test.ts-397-    expect(status.lastError).toContain('bez opening ownership se automaticky nezavírá');
tests/copierChaosScenarios.test.ts-398-    expect(broker.placedRequests()).toHaveLength(placedBefore);
tests/copierChaosScenarios.test.ts-399-    expect(broker.liquidateRequests()).toEqual([]);
tests/copierChaosScenarios.test.ts:400:    expect((await store.load()).safety?.liveCopyOpenSince).toBe(50);
tests/copierChaosScenarios.test.ts-401-    controller.stop();
tests/copierChaosScenarios.test.ts-402-  });
tests/copierChaosScenarios.test.ts-403-
tests/copierChaosScenarios.test.ts-404-  it('ruční DISARM smaže durable stopu — boot recovery držené pozice nezavírá', async () => {
tests/copierChaosScenarios.test.ts-405-    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
tests/copierChaosScenarios.test.ts-406-    const store = createMemoryCopierStore();
tests/copierChaosScenarios.test.ts-407-    const first = await bootstrapCopierRuntime({
tests/copierChaosScenarios.test.ts-408-      broker, store, group: recoveryGroup, clock: stepClock(), osoCorrelationWindowMs: 5,
tests/copierChaosScenarios.test.ts-409-    });
tests/copierChaosScenarios.test.ts-410-    await openCopy(broker, first);
tests/copierChaosScenarios.test.ts:411:    expect((await store.load()).safety?.liveCopyOpenSince).toBeDefined();
tests/copierChaosScenarios.test.ts-412-
tests/copierChaosScenarios.test.ts-413-    first.disarm();
tests/copierChaosScenarios.test.ts-414-    await first.waitForIdle();
tests/copierChaosScenarios.test.ts-415-    await new Promise(resolve => setTimeout(resolve, 20));
tests/copierChaosScenarios.test.ts:416:    expect((await store.load()).safety?.liveCopyOpenSince).toBeUndefined();
tests/copierChaosScenarios.test.ts-417-    first.stop();
tests/copierChaosScenarios.test.ts-418-
tests/copierChaosScenarios.test.ts-419-    const placedBefore = broker.placedRequests().length;
tests/copierChaosScenarios.test.ts-420-    const restarted = await bootstrapCopierRuntime({
tests/copierChaosScenarios.test.ts-421-      broker, store, group: recoveryGroup, clock: stepClock(),
--
tests/copierStore.test.ts-28-  });
tests/copierStore.test.ts-29-
tests/copierStore.test.ts-30-  it('prázdný store vrací prázdný snapshot', async () => {
tests/copierStore.test.ts-31-    const loaded = await createMemoryCopierStore().load();
tests/copierStore.test.ts-32-    expect(loaded).toEqual(emptySnapshot());
tests/copierStore.test.ts:33:    expect(loaded.safety).not.toHaveProperty('leaderExposureEpochs');
tests/copierStore.test.ts-34-  });
tests/copierStore.test.ts-35-
tests/copierStore.test.ts-36-  it('uložený stav nejde změnit zvenčí', async () => {
tests/copierStore.test.ts-37-    // Mutace načteného snapshotu nesmí prosáknout do úložiště — na Supabase
tests/copierStore.test.ts-38-    // verzi by se taková chyba neprojevila a tady by prošla.

exec
/bin/zsh -lc "rg -n \"\\.updateGroup\\(\" --glob '"'!services/copierRuntimeController.ts'"' ." in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
./server/localCopierExecutionAgent.ts:245:      else options.controller.updateGroup(next);
./server/localCopierExecutionAgent.ts:256:        else options.controller.updateGroup(previous);
./services/copierRuntimeCommandAdapter.ts:27:      options.controller.updateGroup(next);
./tests/copierRuntimeController.test.ts:440:    expect(() => controller.updateGroup({
./tests/copierRuntimeController.test.ts:446:    controller.updateGroup({

exec
/bin/zsh -lc "rg -n \"prepareGroupAccounts\\s*=|function prepareGroupAccounts|const prepareGroupAccounts\" scripts/copier/pilot.ts scripts/copier -g '*.ts'" in /private/tmp/alphatrade-reconnect-fix
 exited 1 in 0ms:
exec
/bin/zsh -lc "nl -ba scripts/copier/pilot.ts | sed -n '1050,1210p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  1050	          deviceSecret: pairing.deviceSecret,
  1051	          publicKey: pairing.publicKey,
  1052	        },
  1053	        onDevicePaired: async (deviceId: string) => {
  1054	          await confirmPairing(deviceId);
  1055	        },
  1056	        refreshPairing: async () => {
  1057	          try {
  1058	            await confirmPairing(pairing.deviceId);
  1059	            return true;
  1060	          } catch {
  1061	            return false;
  1062	          }
  1063	        },
  1064	      } : {}),
  1065	    };
  1066	  }
  1067	  if (deviceConfig) throw new Error('Nespárovaný Mac device potřebuje při prvním startu --lease');
  1068	  const config = readTradovateServerConfig();
  1069	  if (config.environment !== 'demo') {
  1070	    throw new Error('Pilot odmítá start: TRADOVATE_ENVIRONMENT musí být demo');
  1071	  }
  1072	  const db = createTradovateAdminClient(config);
  1073	  let query = db
  1074	    .from('tradovate_oauth_connections')
  1075	    .select('id,user_id,tradovate_email,environment,connection_status')
  1076	    .eq('environment', 'demo')
  1077	    .eq('connection_status', 'connected');
  1078	  const connectionId = options.connectionId ?? stringFlag('connection-id', false);
  1079	  if (connectionId) query = query.eq('id', connectionId);
  1080	  const { data, error } = await query.order('connected_at', { ascending: true });
  1081	  if (error) throw new Error(`OAuth connection lookup failed: ${error.message}`);
  1082	  const rows = (data ?? []) as ConnectionRow[];
  1083	  if (rows.length === 0) throw new Error('Nenalezeno aktivní Tradovate demo OAuth připojení');
  1084	  if (rows.length > 1 && !connectionId) {
  1085	    throw new Error('Je připojeno více OAuth účtů; použij --connection-id');
  1086	  }
  1087	  const connection = rows[0];
  1088	  const accountSpec = options.accountSpec
  1089	    ?? (stringFlag('account-spec', false) || connection.tradovate_email?.trim() || '');
  1090	  if (!accountSpec) throw new Error('Chybí Tradovate accountSpec; použij --account-spec');
  1091	  const getAccessToken = async () => (await getValidTradovateAccessToken({
  1092	    db,
  1093	    config,
  1094	    userId: connection.user_id,
  1095	    connectionId: connection.id,
  1096	  })).accessToken;
  1097	  return { environment: 'demo', connectionId: connection.id, accountSpec, expiresAt: null, renewable: true, getAccessToken };
  1098	}
  1099	
  1100	function validatePair<T extends ExecutionAccount>(
  1101	  accounts: T[],
  1102	  leaderId: number,
  1103	  followerId: number,
  1104	): T[] {
  1105	  if (leaderId === followerId) throw new Error('Leader a follower musí být různé účty');
  1106	  const selected = [leaderId, followerId].map(id => {
  1107	    const account = accounts.find(item => item.id === id);
  1108	    if (!account) throw new Error(`Tradovate účet ${id} nebyl nalezen`);
  1109	    if (!account.active || !account.canTrade) throw new Error(`Účet ${account.name} není aktivní pro execution`);
  1110	    return account;
  1111	  });
  1112	  return selected;
  1113	}
  1114	
  1115	/**
  1116	 * Parsování `--followers "id@multiplier[@maxContracts],..."` pro agent mode.
  1117	 *
  1118	 * Původní `--follower/--multiplier` dvojice zůstává platná (mac-install ji
  1119	 * generuje); tenhle flag ji rozšiřuje na víc účtů s vlastními parametry.
  1120	 * Příklad: `--followers "61887493@1,61887495@0.5@3"`.
  1121	 */
  1122	async function runPreflight(
  1123	  context: PilotContext,
  1124	  accounts: TradovateAccountDataAccount[],
  1125	  accountSpecsByAccountId: Readonly<Record<number, string>>,
  1126	): Promise<void> {
  1127	  const accountIds = accounts.map(item => item.id);
  1128	  assertFlatAndNoWorking(accounts);
  1129	  const broker = createTradovateBroker({
  1130	    environment: 'demo',
  1131	    accountSpec: context.accountSpec,
  1132	    accountSpecsByAccountId,
  1133	    getAccessToken: context.getAccessToken,
  1134	    connectionLabel: connectionLabel(context.connectionId),
  1135	    onReconnectDiagnostic: logReconnectDiagnostic,
  1136	  });
  1137	  let connected = false;
  1138	  let transportError: Error | null = null;
  1139	  const unsubscribe = broker.subscribe(event => {
  1140	    if (event.type === 'connection') connected = event.connected;
  1141	    if (event.type === 'error') transportError = event.error;
  1142	  });
  1143	  try {
  1144	    await waitUntil(() => connected || transportError != null, 15_000, 'WebSocket sync timeout');
  1145	    if (transportError) throw transportError;
  1146	    const capabilities = await broker.listAccountCapabilities(accountIds);
  1147	    const snapshots = await Promise.all(accountIds.map(async accountId => ({
  1148	      accountId,
  1149	      positions: await broker.listPositions(accountId),
  1150	      orders: await broker.listOrders(accountId),
  1151	    })));
  1152	    if (capabilities.length !== accountIds.length || capabilities.some(item => !item.active || !item.canTrade)) {
  1153	      throw new Error('OAuth/account execution preflight selhal');
  1154	    }
  1155	    for (const snapshot of snapshots) {
  1156	      if (snapshot.positions.some(item => item.netQuantity !== 0)) throw new Error(`Účet ${snapshot.accountId} není flat`);
  1157	      if (snapshot.orders.some(item => isOpenOrderStatus(item.status))) {
  1158	        throw new Error(`Účet ${snapshot.accountId} má aktivní working/pending order`);
  1159	      }
  1160	    }
  1161	    console.log('PASS preflight: demo, OAuth execution permission, WS sync, flat, no working orders.');
  1162	  } finally {
  1163	    unsubscribe();
  1164	  }
  1165	}
  1166	
  1167	async function runDryRun(context: PilotContext, followerId: number): Promise<void> {
  1168	  const symbol = stringFlag('symbol');
  1169	  const side = stringFlag('side');
  1170	  const orderType = stringFlag('order-type');
  1171	  const quantity = integerFlag('quantity');
  1172	  const price = numberFlag('price', orderType === 'Market' ? false : true);
  1173	  if (side !== 'Buy' && side !== 'Sell') throw new Error('--side musí být Buy nebo Sell');
  1174	  if (!['Market', 'Limit', 'Stop', 'StopLimit'].includes(orderType)) {
  1175	    throw new Error('--order-type musí být Market, Limit, Stop nebo StopLimit');
  1176	  }
  1177	  if (quantity !== 1) throw new Error('Pilot dry-run dovoluje pouze quantity 1');
  1178	  const result = await dryRunTradovateOrder({
  1179	    environment: 'demo',
  1180	    accessToken: await context.getAccessToken(),
  1181	    order: {
  1182	      tag: `at-dry-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
  1183	      accountId: followerId,
  1184	      symbol,
  1185	      side,
  1186	      quantity,
  1187	      orderType: orderType as 'Market' | 'Limit' | 'Stop' | 'StopLimit',
  1188	      ...(orderType === 'Limit' || orderType === 'StopLimit' ? { limitPrice: price } : {}),
  1189	      ...(orderType === 'Stop' || orderType === 'StopLimit' ? { stopPrice: price } : {}),
  1190	    },
  1191	  });
  1192	  if (!result.accepted) throw new Error(`Dry-run REJECTED: ${result.rejectReason}`);
  1193	  console.log('PASS dry-run: Tradovate validaci přijalo; žádná objednávka nebyla odeslána.');
  1194	}
  1195	
  1196	async function runRuntime(
  1197	  mode: 'shadow' | 'live',
  1198	  context: PilotContext,
  1199	  leaderId: number,
  1200	  followerId: number,
  1201	  accountSpecsByAccountId: Readonly<Record<number, string>>,
  1202	): Promise<void> {
  1203	  if (mode === 'live') {
  1204	    const approval = stringFlag('approval');
  1205	    if (approval !== 'POTVRZUJI_1_MNQ_DEMO_WRITE') {
  1206	      throw new Error('Live pilot vyžaduje --approval POTVRZUJI_1_MNQ_DEMO_WRITE');
  1207	    }
  1208	  }
  1209	  const minutes = numberFlag('minutes', false) ?? (mode === 'shadow' ? 30 : 15);
  1210	  if (minutes <= 0 || minutes > 120) throw new Error('--minutes musí být v rozsahu 1 až 120');

exec
/bin/zsh -lc "nl -ba services/brokerRouter.ts | sed -n '50,220p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
    50	  if (routes.length === 0) throw new Error('Broker router vyžaduje alespoň jedno spojení');
    51	  const environment = routes[0].broker.environment;
    52	  let byAccount = new Map<number, BrokerPort>();
    53	  let accountIdsByBroker = new Map<BrokerPort, Set<number>>();
    54	  const fixedBrokers = routes.map(route => route.broker);
    55	  const configuredBrokers = new Set(fixedBrokers);
    56	  const criticalBrokers = new Set(
    57	    routes.filter(route => route.critical !== false).map(route => route.broker),
    58	  );
    59	  const validateRoutes = (nextRoutes: readonly BrokerRoute[], requireFixedSet: boolean) => {
    60	    const nextByAccount = new Map<number, BrokerPort>();
    61	    const nextAccountIdsByBroker = new Map<BrokerPort, Set<number>>();
    62	    const seenBrokers = new Set<BrokerPort>();
    63	    for (const route of nextRoutes) {
    64	      if (seenBrokers.has(route.broker)) {
    65	        throw new Error('Stejné OAuth spojení nesmí být ve více broker routes');
    66	      }
    67	      seenBrokers.add(route.broker);
    68	      if (requireFixedSet && !configuredBrokers.has(route.broker)) {
    69	        throw new Error('Dynamická broker route obsahuje neznámé OAuth spojení');
    70	      }
    71	      if (route.broker.environment !== environment) {
    72	        throw new Error('Broker router nesmí míchat DEMO a LIVE prostředí');
    73	      }
    74	      const ids = new Set<number>();
    75	      for (const accountId of route.accountIds) {
    76	        if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    77	          throw new Error('Broker route obsahuje neplatný accountId');
    78	        }
    79	        if (nextByAccount.has(accountId)) throw new Error(`Účet ${accountId} je ve více broker routes`);
    80	        nextByAccount.set(accountId, route.broker);
    81	        ids.add(accountId);
    82	      }
    83	      nextAccountIdsByBroker.set(route.broker, ids);
    84	    }
    85	    if (requireFixedSet && (seenBrokers.size !== configuredBrokers.size || fixedBrokers.some(item => !seenBrokers.has(item)))) {
    86	      throw new Error('Dynamická změna rout nesmí přidat ani odebrat OAuth spojení');
    87	    }
    88	    return { nextByAccount, nextAccountIdsByBroker };
    89	  };
    90	  ({ nextByAccount: byAccount, nextAccountIdsByBroker: accountIdsByBroker } = validateRoutes(routes, false));
    91	
    92	  const brokerFor = (accountId: number): BrokerPort => {
    93	    const broker = byAccount.get(accountId);
    94	    if (!broker) throw new Error(`Pro účet ${accountId} není nakonfigurované OAuth spojení`);
    95	    return broker;
    96	  };
    97	
    98	  return {
    99	    environment,
   100	    replaceRoutes(nextRoutes) {
   101	      const validated = validateRoutes(nextRoutes, true);
   102	      // Přepnutí je synchronní a atomické: při jediné validační chybě zůstane
   103	      // původní mapa i event filtr beze změny.
   104	      byAccount = validated.nextByAccount;
   105	      accountIdsByBroker = validated.nextAccountIdsByBroker;
   106	    },
   107	    setCriticalAccounts(accountIds) {
   108	      const next = new Set<BrokerPort>();
   109	      for (const accountId of accountIds) next.add(brokerFor(accountId));
   110	      criticalBrokers.clear();
   111	      for (const broker of next) criticalBrokers.add(broker);
   112	    },
   113	    placeOrder: request => brokerFor(request.accountId).placeOrder(request),
   114	    liquidatePosition: async request => {
   115	      const broker = brokerFor(request.accountId);
   116	      if (!broker.liquidatePosition) throw new Error('OAuth spojení nepodporuje nativní nouzové zploštění');
   117	      return broker.liquidatePosition(request);
   118	    },
   119	    placeOco: async request => {
   120	      const broker = brokerFor(request.accountId);
   121	      if (!broker.placeOco) throw new Error('OAuth spojení nepodporuje nativní OCO');
   122	      return broker.placeOco(request);
   123	    },
   124	    placeOso: async request => {
   125	      const broker = brokerFor(request.accountId);
   126	      if (!broker.placeOso) throw new Error('OAuth spojení nepodporuje nativní OSO');
   127	      return broker.placeOso(request);
   128	    },
   129	    cancelOrder: (accountId, brokerOrderId) => brokerFor(accountId).cancelOrder(accountId, brokerOrderId),
   130	    modifyOrder: (accountId, brokerOrderId, changes) =>
   131	      brokerFor(accountId).modifyOrder(accountId, brokerOrderId, changes),
   132	    async listAccountCapabilities(accountIds): Promise<BrokerAccountCapability[]> {
   133	      const grouped = new Map<BrokerPort, number[]>();
   134	      for (const accountId of accountIds) {
   135	        const broker = brokerFor(accountId);
   136	        grouped.set(broker, [...(grouped.get(broker) ?? []), accountId]);
   137	      }
   138	      return (await Promise.all([...grouped].map(([broker, ids]) =>
   139	        broker.listAccountCapabilities(ids)))).flat();
   140	    },
   141	    listPositions: accountId => brokerFor(accountId).listPositions(accountId),
   142	    listOrders: accountId => brokerFor(accountId).listOrders(accountId),
   143	    findOrdersByTag: (accountId, tag) => brokerFor(accountId).findOrdersByTag(accountId, tag),
   144	    findOrderById: (accountId, brokerOrderId) =>
   145	      brokerFor(accountId).findOrderById(accountId, brokerOrderId),
   146	    subscribe(listener) {
   147	      const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
   148	      const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
   149	      const graceMs = options.reconnectGraceMs ?? 10_000;
   150	      const connected = new Map(fixedBrokers.map(broker => [broker, false]));
   151	      let aggregateConnected = false;
   152	      /** Zadržené error/connection eventy nekritické route během reconnect lhůty. */
   153	      const pendingOutage = new Map<BrokerPort, {
   154	        timer: ReturnType<typeof setTimeout>;
   155	        held: BrokerEvent[];
   156	      }>();
   157	
   158	      const applyConnection = (broker: BrokerPort, event: Extract<BrokerEvent, { type: 'connection' }>) => {
   159	        connected.set(broker, event.connected);
   160	        const next = [...connected.values()].every(Boolean);
   161	        if (next !== aggregateConnected) {
   162	          aggregateConnected = next;
   163	          listener({ type: 'connection', connected: next, at: event.at });
   164	        }
   165	      };
   166	
   167	      const flushOutage = (broker: BrokerPort) => {
   168	        const outage = pendingOutage.get(broker);
   169	        if (!outage) return;
   170	        pendingOutage.delete(broker);
   171	        for (const held of outage.held) {
   172	          if (held.type === 'connection') applyConnection(broker, held);
   173	          else listener(held);
   174	        }
   175	      };
   176	
   177	      const unsubs = fixedBrokers.map(routeBroker => routeBroker.subscribe((event: BrokerEvent) => {
   178	        if (event.type === 'order' || event.type === 'fill' || event.type === 'position') {
   179	          const accountId = event.type === 'order'
   180	            ? event.order.accountId
   181	            : event.type === 'fill'
   182	              ? event.fill.accountId
   183	              : event.position.accountId;
   184	          // Jedno OAuth může vidět více účtů, než mu bylo svěřeno v route.
   185	          // Takové entity sem nesmí projít: při překryvu OAuth viditelnosti by
   186	          // se leader lifecycle zpracoval dvakrát.
   187	          if (!accountIdsByBroker.get(routeBroker)?.has(accountId)) return;
   188	          listener(event);
   189	          return;
   190	        }
   191	        const grace = !criticalBrokers.has(routeBroker) && graceMs > 0;
   192	        if (event.type === 'error') {
   193	          if (!grace) {
   194	            listener(event);
   195	            return;
   196	          }
   197	          // Transport chyba nekritické route předchází jejímu disconnect
   198	          // eventu — zadržíme ji ve stejné lhůtě. Objednávky mají vlastní
   199	          // fail-closed cestu, tady jde jen o plané poplachy.
   200	          const outage = pendingOutage.get(routeBroker);
   201	          if (outage) {
   202	            outage.held.push(event);
   203	          } else {
   204	            pendingOutage.set(routeBroker, {
   205	              held: [event],
   206	              timer: setTimeoutImpl(() => flushOutage(routeBroker), graceMs),
   207	            });
   208	          }
   209	          return;
   210	        }
   211	        if (event.type !== 'connection') {
   212	          listener(event);
   213	          return;
   214	        }
   215	        if (!grace) {
   216	          applyConnection(routeBroker, event);
   217	          return;
   218	        }
   219	        const outage = pendingOutage.get(routeBroker);
   220	        if (!event.connected) {

exec
/bin/zsh -lc "nl -ba tests/copierChaosScenarios.test.ts | sed -n '259,405p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
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

exec
/bin/zsh -lc 'git show --stat --oneline 5154856d && git show --format=fuller --no-ext-diff --unified=40 5154856d -- services/copierRuntimeController.ts scripts/copier/pilot.ts tests/copierConnectionRecoveryOptionalFollower.test.ts' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 2145ms:
git: error: couldn't create cache file '/tmp/xcrun_db-qotPNeye' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-ju5YR9Sc' (errno=Operation not permitted)
5154856d fix(copier): post-connect recovery honours OAuth-missing followers; clean manual reconcile clears the recovery flag
 scripts/copier/pilot.ts                            |   8 ++
 services/copierRuntimeController.ts                |  35 +++++-
 ...opierConnectionRecoveryOptionalFollower.test.ts | 120 +++++++++++++++++++++
 3 files changed, 161 insertions(+), 2 deletions(-)
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-FSkkIuNn' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-QgqGTn0t' (errno=Operation not permitted)
commit 5154856da5756619b915876c23b3e99fc2108421
Author:     Krejcus <filipkrejca1@gmail.com>
AuthorDate: Thu Sep 3 08:56:03 2026 +0200
Commit:     Krejcus <filipkrejca1@gmail.com>
CommitDate: Thu Sep 3 08:56:03 2026 +0200

    fix(copier): post-connect recovery honours OAuth-missing followers; clean manual reconcile clears the recovery flag
    
    3. 9. 05:45 UTC: breached follower 63338752 už nebyl v žádném OAuth adresáři.
    Automatická recovery po připojení ho routovala → router hodil chybu → po pěti
    pokusech fail-closed a `pendingConnectionRecovery` zůstal zapnutý (I to
    zavedlo záměrně, aby další connected event recovery zopakoval). Ruční Kontrola
    pozic z CLI/UI prošla (dostává optional skip), ale příznak dál blokoval změnu
    skupiny: „Změnu leadera blokuje rozpracovaný lifecycle: connection recovery“.
    
    - BootstrapCopierOptions.resolveMissingOptionalAccountIds: recovery dostane
      stejný optional-skip vstup jako CLI/UI reconcile (filtrovaný na followery);
      pilot ho napojí na prepareGroupAccounts
    - public reconcile(): autoritativně čistý výsledek (0 divergence, 0 working)
      shodí pendingConnectionRecovery; divergentní nebo neúspěšný ho nechá
    - fail-closed při transportu, zákaz ARM bez reconciliation a auto-flatten
      osiřelých kopií po reconnectu se nemění
    
    Regrese: tests/copierConnectionRecoveryOptionalFollower.test.ts (router bez
    route pro zmizelý follower).
    
    Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>

diff --git a/scripts/copier/pilot.ts b/scripts/copier/pilot.ts
index cd1e49f8..06dc28d4 100644
--- a/scripts/copier/pilot.ts
+++ b/scripts/copier/pilot.ts
@@ -595,80 +595,88 @@ async function runLocalAgent(
       if (!canSafelyRestartLocalCopierAgent(controller?.status())) {
         pairingRestartTimer = setTimeout(check, 1_000);
         pairingRestartTimer.unref();
         return;
       }
       // Odložení nechá právě běžící pairing HTTP odpověď bezpečně doběhnout.
       scheduleAgentRestart({
         delayMs: 750,
         restart: () => {
           if (stopPromise) return;
           if (!canSafelyRestartLocalCopierAgent(controller?.status())) {
             pairingRestartTimer = setTimeout(check, 1_000);
             pairingRestartTimer.unref();
             return;
           }
           // Bez await mezi poslední flat kontrolou, nevratným runtime gate a
           // signalem: broker event ani UI command se sem nemohou vložit.
           void controller?.beginShutdown();
           agent?.beginShutdown();
           process.kill(process.pid, 'SIGTERM');
         },
       });
     };
     check();
   };
   try {
     controller = await bootstrapCopierRuntime({
       broker,
       store: runtimeStore,
       group,
       metrics: createCopierMetrics(),
       // Všichni followeři musí odejít v JEDEN okamžik. Sériový dispatch
       // (pilotní `1`) rozprostřel marketové nohy přes stovky ms — každá
       // kopie pak trefila jinou cenu a P&L kopií se rozcházela. Limitů se
       // to netýká (kniha čeká), marketů/flatten/close zásadně.
       maxConcurrentDispatches: Math.max(4, group.followers.length),
       onAudit: entries => {
         auditTail = auditTail.then(() => writeAudit(entries));
       },
       onError: logControllerError,
+      // Post-connect recovery musí vidět stejný optional-skip jako ruční
+      // Kontrola pozic, jinak zmizelý breached follower shodí recovery.
+      resolveMissingOptionalAccountIds: prepareGroupAccounts
+        ? async current => (await prepareGroupAccounts({
+          required: [current.leaderAccountId],
+          optional: current.followers.map(follower => follower.accountId),
+        })).missingOptional
+        : undefined,
       // Trade event -> okamžitý poll s příznakem -> server pushne hned.
       onCopyEvent: event => {
         relay?.nudgeCopyEvents();
         if (!snapshotsEnabled || !relay || !event.episodeId) return;
         // Jen vstup a výstup (rozhodnutí uživatele 2026-08-22): posun SL je
         // vlastní akce — notifikace stačí textová a snímek by byl jen šum.
         if (event.kind !== 'entry' && event.kind !== 'exit') return;
         const snapshotRelay = relay;
         const notifyDeadlineAt = event.at + COPY_EVENT_IMAGE_PUSH_DEADLINE_MS;
         // Po grace worker vyvolá druhý průchod. Pokud obrázek uspěl, serverový
         // marker z něj udělá no-op; jinak tentýž event odejde jako text.
         const fallbackTimer = setTimeout(
           () => snapshotRelay.nudgeCopyEvents(),
           Math.max(0, event.at + COPY_EVENT_IMAGE_GRACE_MS + 25 - Date.now()),
         );
         fallbackTimer.unref();
         // Záměrně bez await: CDP ani síť nesmí vstoupit do dispatch/eventTail.
         snapshotHealth = { ...snapshotHealth, lastAttemptAt: Date.now() };
         void withSnapshotCamera(async () => {
           const remaining = notifyDeadlineAt - Date.now();
           if (remaining <= 0) return null;
           return captureTradingViewCopierSnapshot({
             dedicated: dedicatedChartRef,
             timeoutMs: Math.min(1_200, remaining),
             onDedicatedResolved: persistResolvedChart,
           });
         }).then(async png => {
           if (!png) {
             await refreshSnapshotHealth();
             if (snapshotHealth.state === 'ready') snapshotHealth = { ...snapshotHealth, state: 'capture-failed' };
             return;
           }
           if (png.byteLength > 2 * 1024 * 1024) {
             snapshotHealth = { ...snapshotHealth, state: 'capture-failed' };
             console.warn(`${new Date().toISOString()} SNAPSHOT PNG je větší než 2 MB; zahazuji ${event.symbol} ${event.kind}`);
             return;
           }
           try {
             await snapshotRelay.uploadSnapshot({
               episodeId: event.episodeId!,
diff --git a/services/copierRuntimeController.ts b/services/copierRuntimeController.ts
index b76d9989..d29c4da7 100644
--- a/services/copierRuntimeController.ts
+++ b/services/copierRuntimeController.ts
@@ -318,80 +318,88 @@ export interface CopierRuntimeController {
   stop(): void;
 }
 
 export interface BootstrapCopierOptions {
   broker: BrokerPort;
   store: CopierStore;
   group: CopyGroupConfig;
   clock?: () => number;
   /** Injektovatelné pouze pro deterministické testy statistického episode ID. */
   episodeIdFactory?: () => string;
   risk?: Partial<RiskGateContext>;
   onAudit?: (entries: readonly CopierAuditEntry[]) => void;
   /**
    * Okamžitá notifikační cesta: zavolá se hned po přidání trade eventu do
    * deníku. Pilot přes ni šťouchne relay, aby server poslal push bez čekání
    * na minutový cron (dedup marker sdílí obě cesty).
    */
   onCopyEvent?: (event: CopierCopyEvent) => void;
   onError?: (error: Error) => void;
   metrics?: CopierMetrics;
   /** Read-only observability hook; nesmí provádět broker side effect. */
   onLeaderEvent?: (event: LeaderEvent) => void;
   /** Read-only výstup detekovaného SL/TP páru; zatím nic neodesílá. */
   onBracketPair?: (pair: LeaderBracketPair) => void;
   maxConcurrentDispatches?: number;
   /** Krátké okno pro rozpoznání nativního čekajícího entry + SL/TP. */
   osoCorrelationWindowMs?: number;
   /** Pilot pojistka: kolik nových leader orderId smí jedna session přijmout. */
   maxLeaderOrders?: number;
   /**
    * Pilot pojistka pro test exekuce: po vyčerpání vstupního limitu dovolí
    * nejvýše jeden nový opačný order, který přesně zavírá známou leader pozici.
    * Bez aktuální Position entity nebo při větším množství failne zavřeně.
    */
   allowSingleFlatExit?: boolean;
   /** Testovatelná bounded read-only konfirmace ručního Flatten. */
   flattenConfirmationAttempts?: number;
   flattenConfirmationPollMs?: number;
   flattenAccountConcurrency?: number;
   wait?: (ms: number) => Promise<void>;
+  /**
+   * Read-only zdroj „followeři právě neviditelní v žádném připojeném OAuth
+   * adresáři“ pro automatickou post-connect recovery. Stejný vstup dostává
+   * CLI/UI Kontrola pozic; bez něj broker router pro zmizelý (typicky
+   * breached) follower vyhodí chybu a recovery skončí fail-closed, i když je
+   * jeho vynechání legitimní. Vrácené ID se filtrují na followery skupiny.
+   */
+  resolveMissingOptionalAccountIds?: (group: CopyGroupConfig) => Promise<readonly number[]>;
   /**
    * Bounded okno pro spárování follower position 0→nonzero s konkrétním
    * broker fill eventem. Po vypršení následuje autoritativní read-only
    * kontrola; nikdy nejde o autorizaci k automatickému zavření nejasné pozice.
    */
   followerTransitionCorrelationWindowMs?: number;
   /** Grace pro normální opožděný follower exit po známém leader open -> flat. */
   leaderFlatGraceMs?: number;
   /** Krátké čekání na projekci Position po potvrzeném exit fillu. */
   leaderFlatExitSettlementGraceMs?: number;
   /** Interval dalšího read-only batch ověření rozpracovaného copier exitu. */
   leaderFlatInflightRetryMs?: number;
 }
 
 const errorOf = (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason));
 
 function assertRuntimeGroup(group: CopyGroupConfig): void {
   if (!group.id.trim() || !group.name.trim()) throw new Error('Copy group musí mít id a název');
   if (!Number.isSafeInteger(group.leaderAccountId) || Number(group.leaderAccountId) <= 0) {
     throw new Error('Copy group musí mít platný leader účet');
   }
   if (!Array.isArray(group.followers) || group.followers.length === 0) {
     throw new Error('Copy group musí mít alespoň jeden follower účet');
   }
   const seen = new Set<number>();
   for (const follower of group.followers) {
     if (!Number.isSafeInteger(follower.accountId) || follower.accountId <= 0) {
       throw new Error('Follower accountId musí být kladné celé číslo');
     }
     if (follower.accountId === group.leaderAccountId) {
       throw new Error('Leader nemůže být zároveň follower');
     }
     if (seen.has(follower.accountId)) throw new Error('Follower účet je ve skupině vícekrát');
     seen.add(follower.accountId);
     if (follower.mode !== 'off' && follower.mode !== 'on-submit' && follower.mode !== 'on-fill') {
       throw new Error('Follower má neplatný replication mode');
     }
     if (!Number.isFinite(follower.multiplier) || follower.multiplier <= 0 || follower.multiplier > 100) {
       throw new Error('Follower multiplier musí být větší než 0 a nejvýše 100');
     }
@@ -2644,89 +2652,104 @@ export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): P
         epoch.phase === 'grace'
         || epoch.phase === 'waiting-inflight'
         || epoch.phase === 'closing'
       ) {
         if (leaderNet === 0) {
           scheduleLeaderFlatEpochVerification(epoch, {
             epochId: epoch.id,
             generation: epoch.generation,
           });
           guardedSymbols.add(epoch.symbol);
         } else {
           await persistLeaderExposureEpoch(invalidateLeaderFlatEpoch(
             epoch,
             `leader během connection-recovery už není flat (${leaderNet})`,
             clock(),
           ));
         }
       }
     }
     return guardedSymbols;
   };
 
   /**
    * Connection recovery „podle stavu": po obnovení spojení (nebo po bootu
    * s durable stopou živých kopií) se autoritativně ověří účty.
    * Synchronní kopie s otevřeným leaderem se DRŽÍ (brackety je chrání)
    * a čeká se na jediný klik ARM; osiřelé nebo rozjeté kopie se
    * risk-redukčně zavřou. Nikdy se sám neARMuje.
    */
   const runConnectionRecovery = async () => {
     if (!pendingConnectionRecovery || stopped) return;
     pendingConnectionRecovery = false;
     // `armExpiryFlatten: off` vypíná jen automatickou broker akci, nikoli
     // povinnou read-only kontrolu po reconnectu/resyncu.
     if (gate.killSwitch || group.leaderAccountId == null) return;
     if (!gate.connected) {
       pendingConnectionRecovery = true;
       return;
     }
     const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
+    // Stejný optional-skip vstup jako ruční Kontrola pozic: follower, který
+    // právě není v žádném OAuth adresáři, se nesmí routovat (router by hodil
+    // chybu), ale jeho absence je pro breached/DLL účet legitimní.
+    let missingOptionalAccountIds: readonly number[] = [];
+    if (options.resolveMissingOptionalAccountIds) {
+      try {
+        const followerIds = new Set(group.followers.map(follower => follower.accountId));
+        missingOptionalAccountIds = [...new Set(await options.resolveMissingOptionalAccountIds(group))]
+          .filter(accountId => followerIds.has(accountId) && accountId !== group.leaderAccountId);
+      } catch {
+        missingOptionalAccountIds = [];
+      }
+    }
     let reconciliation: { divergentAccounts: number[]; workingOrderAccounts: number[] } | null = null;
     for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
       if (attempt > 0) await wait(2_000);
       if (!gate.connected) {
         pendingConnectionRecovery = true;
         return;
       }
       try {
-        reconciliation = await performReconciliation();
+        reconciliation = await performReconciliation({
+          missingOptionalAccountIds: [...missingOptionalAccountIds],
+        });
         break;
       } catch {
         // Spojení je čerstvé — pár pokusů, pak poctivé přiznání níže.
       }
     }
     if (!reconciliation) {
       // Pět rychlých pokusů je jen jedna recovery vlna. Příští potvrzený
       // connected event ji musí smět spustit znovu; stav zůstává DISARMED.
       pendingConnectionRecovery = true;
       failClosed(new Error(
         'connection=aggregate phase=reconciliation Po obnovení spojení se nepodařilo ověřit stav účtů — kopie zůstávají chráněné brackety, zkontroluj Tradovate',
       ));
       return;
     }
     const guardedSymbols = await resumeLeaderFlatEpochsAfterSnapshot();
     if (!hasFollowerExposure()) {
       if (lastDisarm?.trigger === 'transport') updateDisarmOutcome(lastDisarm.at, 'flat');
       await syncLiveCopyExposureFlag('clear');
       options.onAudit?.([{
         at: clock(), leaderEventId: 'connection-recovery', kind: 'recovered',
         reason: 'connection-recovery: autoritativní reconciliation potvrdila flat/no-active stav; runtime zůstává DISARMED',
       }]);
       return;
     }
     const orphanSymbols = new Set<string>();
     for (const follower of group.followers) {
       for (const [symbol, quantity] of positionsByAccount.get(follower.accountId) ?? []) {
         if (quantity !== 0 && (leaderPositions.get(symbol) ?? 0) === 0) orphanSymbols.add(symbol);
       }
     }
     const unguardedOrphanSymbols = [...orphanSymbols].filter(symbol => !guardedSymbols.has(symbol));
     if (unguardedOrphanSymbols.length > 0) {
       failClosed(new Error(
         `Copier fail-closed: po reconnectu je leader flat a follower má neověřenou expozici (${unguardedOrphanSymbols.join(', ')}); bez opening ownership se automaticky nezavírá`,
       ), { autoClose: false });
       options.onAudit?.([{
         at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
         reason: `connection-recovery: detect-only orphan expozice bez durable opening epochy (${unguardedOrphanSymbols.join(', ')}); žádný broker write`,
       }]);
       return;
@@ -4259,81 +4282,89 @@ export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): P
         // fail-closed a nesmí se změnit na slabší DLL lock; BREACHED je
         // nejsilnější trvalá západka.
         const currentSeverity = current?.state === 'breached'
           ? 3
           : current?.state === 'unverifiable'
             ? 2
             : current?.state === 'dll-locked'
               ? 1
               : 0;
         const nextSeverity = exclusion.state === 'breached' ? 3 : 1;
         if (nextSeverity < currentSeverity) continue;
         const existingDllSessionEnd = current?.state === 'dll-locked'
           && current.lockSessionEndAt != null
           && current.lockSessionEndAt > now
           ? current.lockSessionEndAt
           : null;
         const next: CopierAccountEligibility = {
           ...(current ?? {}),
           accountId: exclusion.accountId,
           state: exclusion.state,
           reason,
           at: now,
           lockSessionEndAt: exclusion.state === 'dll-locked'
             ? existingDllSessionEnd ?? now + msUntilTradovateSessionEnd(now)
             : undefined,
         };
         if (
           current?.state === next.state
           && current.reason === next.reason
           && current.lockSessionEndAt === next.lockSessionEndAt
         ) continue;
         setEligibility(exclusion.accountId, next);
         changed = true;
       }
       if (changed) await persistEligibility();
     },
     async reconcile(reconciliationOptions = {}) {
       // Veřejná Kontrola pozic je explicitní uživatelská recovery akce.
       // Pouze její čistý výsledek smí odstranit starou chybu; automatické
       // reconnect/terminal-fill kontroly incident uživateli neschovávají.
-      return performReconciliation({ ...reconciliationOptions, clearLastError: true });
+      const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
+      if (result.divergentAccounts.length === 0 && result.workingOrderAccounts.length === 0) {
+        // Autoritativně čistý stav je přesně to, co čekající recovery vlna
+        // hledala; jinak by příznak po neúspěšné automatické vlně blokoval
+        // změnu skupiny („rozpracovaný lifecycle: connection recovery“) až do
+        // dalšího connection eventu. Při divergenci zůstává pending.
+        pendingConnectionRecovery = false;
+      }
+      return result;
     },
     async verifyAccountEligibility(accountId) {
       if (!Number.isSafeInteger(accountId) || accountId <= 0) {
         throw new Error('Neplatné ID účtu pro ověření');
       }
       if (!gate.connected) {
         const reason = lastError?.message?.trim();
         throw new Error([
           'Stav účtu nelze ověřit: worker nemá živé spojení s Tradovate.',
           reason ? `Poslední chyba: ${reason}.` : '',
           'OAuth přihlášení tím není dotčené — spojení se obnoví samo, zkus to za chvíli znovu.',
         ].filter(Boolean).join(' '));
       }
 
       const now = clock();
       const current = accountEligibility.get(accountId);
       const effective = current ? eligibilityAt(current, now) : undefined;
       if (effective?.state === 'breached') {
         throw new Error(`Účet je BREACHED a nelze ho automaticky reaktivovat: ${effective.reason ?? 'bez důvodu'}`);
       }
       if (effective?.state === 'dll-locked') {
         throw new Error(`DLL stále platí do konce broker session: ${effective.reason ?? 'bez důvodu'}`);
       }
 
       const capabilities = await broker.listAccountCapabilities([accountId]);
       const capability = capabilities.find(item => item.accountId === accountId);
       if (!capability) throw new Error(`Broker účet ${accountId} v OAuth spojení nevrátil`);
       if (!capability.active) throw new Error(`Broker účet ${accountId} stále hlásí jako neaktivní`);
       if (!capability.canTrade) throw new Error(`Broker účet ${accountId} zatím nepovoluje obchodování`);
 
       // Oba read-only dotazy jsou součástí důkazu: samotný account/list může
       // účet vrátit, i když jeho obchodní snapshot zatím není dostupný.
       await Promise.all([
         broker.listPositions(accountId),
         broker.listOrders(accountId),
       ]);
 
       const verified: CopierAccountEligibility = {
         ...(current ?? {}),
         accountId,
diff --git a/tests/copierConnectionRecoveryOptionalFollower.test.ts b/tests/copierConnectionRecoveryOptionalFollower.test.ts
new file mode 100644
index 00000000..a9276a9e
--- /dev/null
+++ b/tests/copierConnectionRecoveryOptionalFollower.test.ts
@@ -0,0 +1,120 @@
+import { describe, expect, it } from 'vitest';
+import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
+import { createBrokerRouter } from '../services/brokerRouter';
+import { createMockBroker } from '../services/mockBroker';
+import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
+import type { CopyGroupConfig } from '../services/liveCopyTrading';
+
+/**
+ * Incident 3. 9. 2026 05:45 UTC: breached follower 63338752 zmizel z OAuth.
+ * Automatická post-connect recovery routovala i jeho → router vyhodil chybu →
+ * po pěti pokusech fail-closed a `pendingConnectionRecovery` zůstal zapnutý.
+ * Ruční Kontrola pozic (s optional skipem) prošla, ale příznak dál blokoval
+ * změnu skupiny („rozpracovaný lifecycle: connection recovery“).
+ */
+
+const MISSING = 303;
+const group: CopyGroupConfig = {
+  id: 'g-recovery', name: 'Recovery', enabled: true, leaderAccountId: 100,
+  followers: [
+    { accountId: 200, mode: 'on-submit', multiplier: 1 },
+    { accountId: 201, mode: 'on-submit', multiplier: 1 },
+    { accountId: MISSING, mode: 'on-submit', multiplier: 1 },
+  ],
+};
+const nextGroup: CopyGroupConfig = {
+  ...group,
+  followers: group.followers.filter(follower => follower.accountId !== MISSING),
+};
+
+const harness = async (options: {
+  resolveMissingOptionalAccountIds?: (current: CopyGroupConfig) => Promise<readonly number[]>;
+} = {}) => {
+  const initial = emptySnapshot();
+  initial.safety = {
+    entryCooldownUntil: 0,
+    dayLockUntil: 0,
+    // Durable stopa „za živého ARM existovaly kopie“ → boot recovery po připojení.
+    liveCopyOpenSince: 1,
+    accountEligibility: [{
+      accountId: MISSING, state: 'breached', reason: 'LIVE equity dosáhla drawdown flooru', at: 900,
+    }],
+  };
+  const mock = createMockBroker({
+    behavior: () => ({ kind: 'working' }),
+    accountCapabilities: [100, 200, 201].map(accountId => ({ accountId, active: true, canTrade: true })),
+  });
+  // Zmizelý follower nemá route — přesně jako účet, který už není v žádném OAuth.
+  const router = createBrokerRouter([{ broker: mock, accountIds: [100, 200, 201] }]);
+  const errors: string[] = [];
+  const controller = await bootstrapCopierRuntime({
+    broker: router,
+    store: createMemoryCopierStore(initial),
+    group,
+    wait: async () => undefined,
+    onError: error => errors.push(error.message),
+    ...options,
+  });
+  mock.setConnected(true);
+  // Connection event doráží přes router asynchronně; recovery se řadí až po něm.
+  await settle(controller);
+  return { controller, errors, mock };
+};
+
+const settle = async (controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>) => {
+  for (let round = 0; round < 3; round += 1) {
+    await new Promise<void>(resolve => setTimeout(resolve, 20));
+    await controller.waitForIdle();
+  }
+};
+
+describe('post-connect recovery a follower chybějící v OAuth', () => {
+  it('bez optional-skip vstupu recovery selže, ale čistá ruční Kontrola pozic odblokuje změnu skupiny', async () => {
+    const h = await harness();
+    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
+    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
+
+    // Stav po včerejšku: příznak recovery blokuje reconfigure i po jejím selhání.
+    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
+      .rejects.toThrow('connection recovery');
+
+    // Ruční Kontrola pozic se stejným optional skipem jako CLI/UI projde…
+    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
+      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
+    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
+
+    // …a čistý výsledek recovery příznak shodí: odebrání zmizelého followera už projde.
+    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
+      .resolves.toBeUndefined();
+    expect(h.controller.status().armed).toBe(false);
+    h.controller.stop();
+  });
+
+  it('s optional-skip zdrojem recovery projde napoprvé a skupina není blokovaná', async () => {
+    const seen: CopyGroupConfig[] = [];
+    const h = await harness({
+      resolveMissingOptionalAccountIds: async current => {
+        seen.push(current);
+        return [MISSING, 999_999];
+      },
+    });
+    expect(seen.length).toBeGreaterThan(0);
+    expect(h.errors).toEqual([]);
+    expect(h.controller.status()).toMatchObject({
+      armed: false, reconciliationRequired: false, lastError: null,
+    });
+    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
+      .resolves.toBeUndefined();
+    h.controller.stop();
+  });
+
+  it('neúspěšná ruční Kontrola pozic (chybějící follower bez optional skipu) příznak neshazuje', async () => {
+    const h = await harness();
+    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
+    // Bez optional skipu router pro 303 selže → reconcile hodí chybu → pending zůstává.
+    await expect(h.controller.reconcile()).rejects.toThrow();
+    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
+      .rejects.toThrow('connection recovery');
+    h.controller.stop();
+  });
+});

exec
/bin/zsh -lc "nl -ba server/localCopierExecutionAgent.ts | sed -n '200,275p'; nl -ba services/copierRuntimeCommandAdapter.ts | sed -n '1,70p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
   200	    return { missingOptional };
   201	  };
   202	
   203	  const status = (): LocalCopierAgentStatus => ({
   204	    version: 1,
   205	    environment: 'demo',
   206	    nonce,
   207	    group: structuredClone(group),
   208	    controller: options.controller.status(),
   209	    startedAt,
   210	    ...(devices[0] ? { device: structuredClone(devices[0]) } : {}),
   211	    ...(devices.length > 0 ? { devices: structuredClone(devices) } : {}),
   212	    ...(options.snapshotHealth ? { snapshotHealth: structuredClone(options.snapshotHealth()) } : {}),
   213	  });
   214	
   215	  const configurationResult = (): LiveCopyTradingCommandResult => ({
   216	    type: 'configuration',
   217	    group: structuredClone(group),
   218	  });
   219	
   220	  const applyGroup = async (
   221	    next: CopyGroupConfig,
   222	    mode: 'update' | 'activate' = 'update',
   223	  ): Promise<LiveCopyTradingCommandResult> => {
   224	    const previous = group;
   225	    const leaderChanged = previous.leaderAccountId !== next.leaderAccountId;
   226	    const topologyChanged = !sameAccountTopology(previous, next);
   227	    let runtimeChanged = false;
   228	    try {
   229	      let missingOptionalAccountIds: readonly number[] = [];
   230	      if (mode === 'activate' || topologyChanged) {
   231	        // Routing se nikdy nemění za běžícího ARM. Nejdřív odzbrojit, potom
   232	        // read-only discovery; teprve controller provede flat/no-working
   233	        // preflight nad sjednocením staré a nové topologie.
   234	        options.controller.disarm();
   235	        const prepared = await prepareAccounts(accountsForRoutingChange(previous, next));
   236	        missingOptionalAccountIds = prepared.missingOptional;
   237	      }
   238	      const reconfigurationOptions = {
   239	        missingOptionalAccountIds: [...missingOptionalAccountIds],
   240	      };
   241	      if (mode === 'activate') await options.controller.activateGroup(next, reconfigurationOptions);
   242	      else if (leaderChanged || topologyChanged) {
   243	        await options.controller.reconfigureGroup(next, reconfigurationOptions);
   244	      }
   245	      else options.controller.updateGroup(next);
   246	      runtimeChanged = true;
   247	      await options.onGroupChanged?.(structuredClone(next));
   248	      group = next;
   249	    } catch (error) {
   250	      // Po úspěšném runtime přepnutí, ale neúspěšném durable zápisu, vrať
   251	      // původní epochu stejnou bezpečnou cestou. Když selhal už preflight,
   252	      // controller původní skupinu vůbec nezměnil.
   253	      if (runtimeChanged) {
   254	        if (mode === 'activate') await options.controller.activateGroup(previous);
   255	        else if (leaderChanged || topologyChanged) await options.controller.reconfigureGroup(previous);
   256	        else options.controller.updateGroup(previous);
   257	      }
   258	      throw error;
   259	    }
   260	    return configurationResult();
   261	  };
   262	
   263	  const executeCopyCommand = async (command: LiveCopyTradingCommand): Promise<LiveCopyTradingCommandResult> => {
   264	    switch (command.type) {
   265	      case 'update-group': {
   266	        const next = mappedGroup(group, command.group);
   267	        return applyGroup(next);
   268	      }
   269	      case 'set-group-enabled': {
   270	        return applyGroup({ ...group, enabled: command.enabled });
   271	      }
   272	      case 'set-replication': {
   273	        assertMember(group, command.accountId);
   274	        return applyGroup({
   275	          ...group,
     1	import type { CopierRuntimeController } from './copierRuntimeController';
     2	import {
     3	  normalizeMultiplier,
     4	  type CopyGroupConfig,
     5	  type LiveCopyTradingAdapter,
     6	} from './liveCopyTrading';
     7	
     8	export interface CopierRuntimeCommandAdapterOptions {
     9	  controller: CopierRuntimeController;
    10	  getGroup: () => CopyGroupConfig;
    11	  setGroup: (group: CopyGroupConfig) => void;
    12	}
    13	
    14	/**
    15	 * Překládá explicitní UI příkazy do jednoho běžícího lokálního runtime.
    16	 * Samotná existence adaptéru nic nearmuje a nikdy nespouští Flatten bez
    17	 * konkrétního uživatelského commandu s operationId.
    18	 */
    19	export function createCopierRuntimeCommandAdapter(
    20	  options: CopierRuntimeCommandAdapterOptions,
    21	): LiveCopyTradingAdapter {
    22	  const applyGroup = async (next: CopyGroupConfig) => {
    23	    const current = options.getGroup();
    24	    if (current.leaderAccountId !== next.leaderAccountId) {
    25	      await options.controller.reconfigureGroup(next);
    26	    } else {
    27	      options.controller.updateGroup(next);
    28	    }
    29	    options.setGroup(next);
    30	  };
    31	
    32	  const update = async (mutate: (group: CopyGroupConfig) => CopyGroupConfig) => {
    33	    const next = mutate(options.getGroup());
    34	    await applyGroup(next);
    35	  };
    36	
    37	  return {
    38	    async execute(command) {
    39	      const current = options.getGroup();
    40	      if ('groupId' in command && command.groupId !== current.id) {
    41	        throw new Error('UI příkaz míří na jinou copy group než běžící runtime');
    42	      }
    43	      switch (command.type) {
    44	        case 'update-group':
    45	          await applyGroup(command.group);
    46	          return { type: 'configuration', group: command.group };
    47	        case 'set-group-enabled':
    48	          await update(group => ({ ...group, enabled: command.enabled }));
    49	          return { type: 'configuration', group: options.getGroup() };
    50	        case 'set-replication':
    51	          await update(group => ({
    52	            ...group,
    53	            followers: group.followers.map(follower => follower.accountId === command.accountId
    54	              ? { ...follower, mode: command.mode }
    55	              : follower),
    56	          }));
    57	          return { type: 'configuration', group: options.getGroup() };
    58	        case 'set-multiplier':
    59	          await update(group => ({
    60	            ...group,
    61	            followers: group.followers.map(follower => follower.accountId === command.accountId
    62	              ? { ...follower, multiplier: normalizeMultiplier(command.multiplier) }
    63	              : follower),
    64	          }));
    65	          return { type: 'configuration', group: options.getGroup() };
    66	        case 'flatten-account':
    67	          return { type: 'flatten', ...await options.controller.flattenAccount(command.accountId, command.operationId) };
    68	        case 'flatten-group':
    69	          return { type: 'flatten', ...await options.controller.flattenGroup(command.operationId) };
    70	        case 'create-group':

exec
/bin/zsh -lc "find /Users/filipkrejca/.codex/memories/rollout_summaries -maxdepth 1 -type f | rg '2026-09-01T06-12-20|oauth_copier_reinstall'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
/Users/filipkrejca/.codex/memories/rollout_summaries/2026-09-01T06-12-20-2QZ9-alphatrade_oauth_copier_reinstall_verification.md

exec
/bin/zsh -lc "rg -n \"prepareGroupAccounts\" -g '*.ts' ." in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
./scripts/copier/pilot.ts:307:  prepareGroupAccounts?: (request: PrepareGroupAccountsRequest) => Promise<PrepareGroupAccountsResult>,
./scripts/copier/pilot.ts:637:      resolveMissingOptionalAccountIds: prepareGroupAccounts
./scripts/copier/pilot.ts:638:        ? async current => (await prepareGroupAccounts({
./scripts/copier/pilot.ts:800:      prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:294:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
./tests/localCopierExecutionAgent.test.ts:297:      controller: runtime, group: group(), port: 0, onGroupChanged, prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:312:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11, 22, 33], optional: [] });
./tests/localCopierExecutionAgent.test.ts:319:      .toBeLessThan(prepareGroupAccounts.mock.invocationCallOrder[0]);
./tests/localCopierExecutionAgent.test.ts:320:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
./tests/localCopierExecutionAgent.test.ts:331:    const prepareGroupAccounts = vi.fn(async () => {
./tests/localCopierExecutionAgent.test.ts:335:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:361:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [22] }));
./tests/localCopierExecutionAgent.test.ts:366:      prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:379:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11], optional: [22] });
./tests/localCopierExecutionAgent.test.ts:388:    const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => {
./tests/localCopierExecutionAgent.test.ts:393:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:412:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [11] }));
./tests/localCopierExecutionAgent.test.ts:414:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:428:    const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => {
./tests/localCopierExecutionAgent.test.ts:433:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:454:    const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => {
./tests/localCopierExecutionAgent.test.ts:459:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:509:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
./tests/localCopierExecutionAgent.test.ts:515:      prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:530:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11, 33, 44], optional: [22] });
./tests/localCopierExecutionAgent.test.ts:532:      .toBeLessThan(prepareGroupAccounts.mock.invocationCallOrder[0]);
./tests/localCopierExecutionAgent.test.ts:533:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
./tests/localCopierExecutionAgent.test.ts:609:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
./tests/localCopierExecutionAgent.test.ts:611:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:616:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11, 22], optional: [] });
./tests/localCopierExecutionAgent.test.ts:617:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
./tests/localCopierExecutionAgent.test.ts:625:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
./tests/localCopierExecutionAgent.test.ts:627:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:633:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [63338752], optional: [] });
./tests/localCopierExecutionAgent.test.ts:634:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
./tests/localCopierExecutionAgent.test.ts:653:    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [22] }));
./tests/localCopierExecutionAgent.test.ts:655:      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
./tests/localCopierExecutionAgent.test.ts:659:    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11], optional: [22] });
./tests/localCopierExecutionAgent.test.ts:660:    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
./server/localCopierExecutionAgent.ts:62:  prepareGroupAccounts?: (request: PrepareGroupAccountsRequest) => Promise<PrepareGroupAccountsResult>;
./server/localCopierExecutionAgent.ts:192:    const prepared = await options.prepareGroupAccounts?.(request);

exec
/bin/zsh -lc 'git diff 5154856d''^ 5154856d --check && git diff --stat 5154856d''^ 5154856d && git status --porcelain=v1' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 2149ms:
git: error: couldn't create cache file '/tmp/xcrun_db-cTSiTLuJ' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-bUe7BCMt' (errno=Operation not permitted)
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-bhjyu6PA' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-4DIip18R' (errno=Operation not permitted)
 scripts/copier/pilot.ts                            |   8 ++
 services/copierRuntimeController.ts                |  35 +++++-
 ...opierConnectionRecoveryOptionalFollower.test.ts | 120 +++++++++++++++++++++
 3 files changed, 161 insertions(+), 2 deletions(-)
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-x42Qfiw0' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-mhAyunrM' (errno=Operation not permitted)

exec
/bin/zsh -lc "rg -n \"runLocalAgent\\(\" scripts/copier/pilot.ts" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
220:    await runLocalAgent([context], leaderId, followerId, accounts, broker);
285:  await runLocalAgent(
300:async function runLocalAgent(

exec
/bin/zsh -lc "nl -ba scripts/copier/pilot.ts | sed -n '1440,1690p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  1440	    if (!value || value.startsWith('--')) throw new Error(`Chybí hodnota pro ${key}`);
  1441	    parsed.set(key.slice(2), value);
  1442	    index += 1;
  1443	  }
  1444	  return parsed;
  1445	}
  1446	
  1447	function stringFlag(name: string, required = true): string {
  1448	  const value = flags.get(name)?.trim() ?? '';
  1449	  if (required && !value) throw new Error(`Chybí --${name}`);
  1450	  return value;
  1451	}
  1452	
  1453	function numberFlag(name: string, required = true): number | null {
  1454	  const raw = stringFlag(name, required);
  1455	  if (!raw) return null;
  1456	  const value = Number(raw);
  1457	  if (!Number.isFinite(value)) throw new Error(`--${name} musí být číslo`);
  1458	  return value;
  1459	}
  1460	
  1461	function integerFlag(name: string): number {
  1462	  const value = numberFlag(name);
  1463	  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`--${name} musí být kladné celé číslo`);
  1464	  return Number(value);
  1465	}
  1466	
  1467	async function waitUntil(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  1468	  const deadline = Date.now() + timeoutMs;
  1469	  while (!predicate()) {
  1470	    if (Date.now() >= deadline) throw new Error(message);
  1471	    await delay(50);
  1472	  }
  1473	}
  1474	
  1475	function delay(ms: number): Promise<void> {
  1476	  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
  1477	}
  1478	
  1479	function processExists(pid: number): boolean {
  1480	  try {
  1481	    process.kill(pid, 0);
  1482	    return true;
  1483	  } catch (error) {
  1484	    return !isCode(error, 'ESRCH');
  1485	  }
  1486	}
  1487	
  1488	function isCode(error: unknown, code: string): boolean {
  1489	  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
  1490	}
  1491	
  1492	function usage(error?: string): void {
  1493	  if (error) console.error(error);
  1494	  console.log(`
  1495	Ranní Tradovate copier pilot (vždy DEMO)
  1496	
  1497	  npm run copier:pilot -- keygen
  1498	  npm run copier:pilot -- mac-device-init --connection-id UUID [--api-origin https://alphatrade-mentor-15.vercel.app]
  1499	  npm run copier:pilot -- accounts
  1500	  npm run copier:pilot -- preflight --leader ID --follower ID
  1501	  npm run copier:pilot -- dry-run --leader ID --follower ID --symbol MNQU6 --side Buy --quantity 1 --order-type Limit --price PRICE
  1502	  npm run copier:pilot -- shadow --leader ID --follower ID --minutes 30
  1503	  npm run copier:pilot -- live --leader ID --follower ID --minutes 15 --approval POTVRZUJI_1_MNQ_DEMO_WRITE
  1504	  npm run copier:pilot -- agent --leader ID --follower ID --lease LEASE_JSON --device-config .copier-pilot/mac-device.json --minutes 480
  1505	  npm run copier:pilot -- agent --leader ID --follower ID --followers "ID@MULT,ID@MULT@MAXKONTRAKTU" ... (vice followeru; --followers ma prednost)
  1506	  npm run copier:pilot -- agent --connections-manifest /cesta/connections.json --leader ID --follower ID --followers "ID@MULT,..."
  1507	
  1508	Volitelné: --connection-id UUID, --account-spec USERNAME
  1509	Lokální lease: --lease /cesta/k/pilot-lease.json [--private-key /cesta/pilot-private.pem]
  1510	Spárovaný Mac: --device-config /cesta/mac-device.json (další starty už --lease nepotřebují)
  1511	Více OAuth: manifest přiřadí každý accountId právě jednomu device-config; primární connection obsluhuje UI relay.
  1512	LaunchAgent: --service-lifetime persistent běží bez časového limitu jen tehdy, když jsou všechna zařízení spárovaná a obnovitelná.
  1513	Live příkaz se nesmí spustit bez bezprostředního potvrzení uživatele.
  1514	Agent vždy startuje DISARMED, poslouchá pouze na 127.0.0.1 a brokerové akce přijímá až z potvrzeného LIVE UI.
  1515	`);
  1516	}

exec
/bin/zsh -lc "nl -ba scripts/copier/pilot.ts | sed -n '1690,1900p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
exec
/bin/zsh -lc "nl -ba server/localCopierExecutionAgent.ts | sed -n '150,205p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
   150	    if (!candidate || typeof candidate !== 'object') throw new Error('Neplatná eligibility exclusion');
   151	    const entry = candidate as { accountId?: unknown; state?: unknown; reason?: unknown };
   152	    if (typeof entry.accountId !== 'number' || !Number.isSafeInteger(entry.accountId) || entry.accountId <= 0) {
   153	      throw new Error('Eligibility exclusion obsahuje neplatné accountId');
   154	    }
   155	    if (entry.state !== 'dll-locked' && entry.state !== 'breached') {
   156	      throw new Error('Eligibility exclusion obsahuje nepovolený stav');
   157	    }
   158	    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 3 || entry.reason.trim().length > 500) {
   159	      throw new Error('Eligibility exclusion vyžaduje konkrétní důvod');
   160	    }
   161	    unique.set(entry.accountId, {
   162	      accountId: entry.accountId,
   163	      state: entry.state,
   164	      reason: entry.reason.trim(),
   165	    });
   166	  }
   167	  return [...unique.values()];
   168	};
   169	
   170	export async function startLocalCopierExecutionAgent(
   171	  options: LocalCopierExecutionAgentOptions,
   172	): Promise<LocalCopierExecutionAgent> {
   173	  const host = options.host ?? '127.0.0.1';
   174	  const allowedOrigins = options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
   175	  const nonce = randomUUID();
   176	  const startedAt = options.startedAt ?? new Date().toISOString();
   177	  let group = structuredClone(options.group);
   178	  const devices = (options.devices ?? (options.device ? [options.device] : [])).map(item => structuredClone(item));
   179	  if (new Set(devices.map(item => item.deviceId)).size !== devices.length) {
   180	    throw new Error('Lokální execution agent dostal duplicitní deviceId');
   181	  }
   182	  if (new Set(devices.map(item => item.connectionId)).size !== devices.length) {
   183	    throw new Error('Lokální execution agent dostal více zařízení pro stejné OAuth připojení');
   184	  }
   185	  let tail = Promise.resolve();
   186	  let shuttingDown = false;
   187	  let serverClosePromise: Promise<void> | null = null;
   188	  const shutdownError = () => new Error('Lokální execution agent se právě bezpečně ukončuje');
   189	  const prepareAccounts = async (
   190	    request: PrepareGroupAccountsRequest,
   191	  ): Promise<PrepareGroupAccountsResult> => {
   192	    const prepared = await options.prepareGroupAccounts?.(request);
   193	    const optional = new Set(request.optional);
   194	    const missingOptional = [...new Set(prepared?.missingOptional ?? [])];
   195	    for (const accountId of missingOptional) {
   196	      if (!Number.isSafeInteger(accountId) || !optional.has(accountId)) {
   197	        throw new Error(`Routing refresh vrátil neplatný missing optional účet ${accountId}`);
   198	      }
   199	    }
   200	    return { missingOptional };
   201	  };
   202	
   203	  const status = (): LocalCopierAgentStatus => ({
   204	    version: 1,
   205	    environment: 'demo',

exec
/bin/zsh -lc "nl -ba tests/copierRuntimeController.test.ts | sed -n '425,465p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
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
   441	      ...group, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0 }],
   442	    })).toThrow('multiplier');
   443	    expect(controller.status().armed).toBe(false);
   444	
   445	    controller.arm();
   446	    controller.updateGroup({
   447	      ...group, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0.5 }],
   448	    });
   449	    expect(controller.status().armed).toBe(false);
   450	    controller.stop();
   451	  });
   452	
   453	  it('bezpečně změní leader epochu, odzbrojí a po nové reconciliation kopíruje opačným směrem', async () => {
   454	    const setCriticalAccounts = vi.fn();
   455	    const broker = Object.assign(
   456	      createMockBroker({ behavior: () => ({ kind: 'working' }) }),
   457	      { setCriticalAccounts },
   458	    );
   459	    const controller = await bootstrapCopierRuntime({
   460	      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
   461	    });
   462	    broker.setConnected(true);
   463	    await controller.waitForIdle();
   464	    await controller.reconcile();
   465	    controller.arm();

exec
/bin/zsh -lc "nl -ba scripts/copier/pilot.ts | sed -n '180,315p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
   180	  }
   181	  const context = await pilotContext();
   182	  const accessToken = await context.getAccessToken();
   183	  const accountResult = await loadTradovateAccountData({
   184	    baseUrl: tradovateApiBaseUrl(context.environment),
   185	    accessToken,
   186	  });
   187	  const accounts = accountResult.accounts;
   188	  const accountSpecsByAccountId = Object.fromEntries(
   189	    accounts.map(account => [account.id, account.name]),
   190	  );
   191	
   192	  if (selected === 'accounts') {
   193	    printAccounts(accounts);
   194	    return;
   195	  }
   196	
   197	  const leaderId = integerFlag('leader');
   198	  const followerId = integerFlag('follower');
   199	  const selectedAccounts = validatePair(accounts, leaderId, followerId);
   200	
   201	  if (selected === 'dry-run') {
   202	    await runDryRun(context, followerId);
   203	    return;
   204	  }
   205	
   206	  if (selected === 'preflight') {
   207	    await runPreflight(context, selectedAccounts, accountSpecsByAccountId);
   208	    return;
   209	  }
   210	
   211	  if (selected === 'agent') {
   212	    const broker = createTradovateBroker({
   213	      environment: 'demo',
   214	      accountSpec: context.accountSpec,
   215	      accountSpecsByAccountId,
   216	      getAccessToken: context.getAccessToken,
   217	      connectionLabel: connectionLabel(context.connectionId),
   218	      onReconnectDiagnostic: logReconnectDiagnostic,
   219	    });
   220	    await runLocalAgent([context], leaderId, followerId, accounts, broker);
   221	    return;
   222	  }
   223	
   224	  assertFlatAndNoWorking(selectedAccounts);
   225	  await runRuntime(selected, context, leaderId, followerId, accountSpecsByAccountId);
   226	}
   227	
   228	async function runMultiConnectionAgent(): Promise<void> {
   229	  const manifest = await loadMacCopierConnectionManifest(stringFlag('connections-manifest'));
   230	  const loaded = await Promise.all(manifest.connections.map(async entry => {
   231	    const context = await pilotContext({
   232	      deviceConfigPath: entry.deviceConfigPath,
   233	      leasePath: entry.leasePath,
   234	      privateKeyPath: entry.privateKeyPath,
   235	      connectionId: entry.connectionId,
   236	    });
   237	    if (context.connectionId !== entry.connectionId) {
   238	      throw new Error(`Manifest connection ${entry.connectionId} neodpovídá device/lease ${context.connectionId}`);
   239	    }
   240	    const data = await loadTradovateAccountData({
   241	      baseUrl: tradovateApiBaseUrl(context.environment),
   242	      accessToken: await context.getAccessToken(),
   243	    });
   244	    const accountSpecsByAccountId = Object.fromEntries(data.accounts.map(account => [account.id, account.name]));
   245	    const broker = createTradovateBroker({
   246	      environment: 'demo',
   247	      accountSpec: context.accountSpec,
   248	      accountSpecsByAccountId,
   249	      getAccessToken: context.getAccessToken,
   250	      // Do chybových hlášek: bez štítku nejde z logu poznat, které OAuth
   251	      // spojení (propfirma) vypadlo.
   252	      connectionLabel: connectionLabel(entry.connectionId),
   253	      onReconnectDiagnostic: logReconnectDiagnostic,
   254	    });
   255	    return { context, accounts: data.accounts, broker };
   256	  }));
   257	  const leaderId = integerFlag('leader');
   258	  const followerId = integerFlag('follower');
   259	  const routingConnections: DynamicOAuthConnection[] = loaded.map(item => ({
   260	    connectionId: item.context.connectionId,
   261	    broker: item.broker,
   262	  }));
   263	  const initialSnapshots = new Map(loaded.map(item => [
   264	    item.context.connectionId,
   265	    item.accounts.map(account => ({
   266	      accountId: account.id,
   267	      accountSpec: account.name,
   268	      active: account.active,
   269	      canTrade: account.canTrade,
   270	    })),
   271	  ]));
   272	  const initialRouting = resolveDynamicBrokerRoutes(routingConnections, initialSnapshots);
   273	  const accounts = initialRouting.accounts;
   274	  // Spojení nesoucí leader stream je kritické (výpadek = okamžitý DISARM);
   275	  // follower-only propfirmy dostávají reconnect lhůtu, aby token cyklus
   276	  // jedné z nich nezastavoval kopírování všech ostatních.
   277	  const broker = createBrokerRouter(initialRouting.routes.map(route => ({
   278	    ...route,
   279	    critical: route.accountIds.includes(leaderId),
   280	  })));
   281	  for (const route of initialRouting.routes) {
   282	    const connection = loaded.find(item => item.broker === route.broker);
   283	    console.log(`CONNECTION conn:${connection?.context.connectionId.slice(0, 8) ?? 'unknown'} účty=${route.accountIds.join(',')}`);
   284	  }
   285	  await runLocalAgent(
   286	    loaded.map(item => item.context), leaderId, followerId, accounts, broker,
   287	    loaded.map(item => ({ broker: item.broker, label: `conn:${item.context.connectionId.slice(0, 8)}` })),
   288	    async request => {
   289	      const refreshed = await refreshDynamicBrokerRoutes(routingConnections, broker, request);
   290	      for (const accountId of refreshed.missingOptional) {
   291	        console.warn(
   292	          `${new Date().toISOString()} ROUTING OPTIONAL SKIP účet=${accountId} důvod=účet není viditelný v žádném připojeném OAuth adresáři`,
   293	        );
   294	      }
   295	      return { missingOptional: refreshed.missingOptional };
   296	    },
   297	  );
   298	}
   299	
   300	async function runLocalAgent(
   301	  contexts: PilotContext[],
   302	  leaderId: number,
   303	  followerId: number,
   304	  accounts: ExecutionAccount[],
   305	  baseBroker: BrokerPort,
   306	  renewableBrokers: ReadonlyArray<{ broker: TradovateBrokerPort; label: string }> = [],
   307	  prepareGroupAccounts?: (request: PrepareGroupAccountsRequest) => Promise<PrepareGroupAccountsResult>,
   308	): Promise<void> {
   309	  const context = contexts[0];
   310	  if (!context) throw new Error('Lokální agent potřebuje alespoň jedno OAuth spojení');
   311	  const portValue = numberFlag('port', false) ?? LOCAL_COPIER_AGENT_PORT;
   312	  const minutesValue = numberFlag('minutes', false) ?? 480;
   313	  const multiplierValue = numberFlag('multiplier', false) ?? 1;
   314	  if (!Number.isSafeInteger(portValue) || Number(portValue) < 1024 || Number(portValue) > 65_535) {
   315	    throw new Error('--port musí být celé číslo v rozsahu 1024–65535');

exec
/bin/zsh -lc "rg -n \"export async function refreshDynamicBrokerRoutes|function refreshDynamicBrokerRoutes|refreshDynamicBrokerRoutes\" services scripts -g '*.ts' && nl -ba services/dynamicBrokerRouting.ts | sed -n '1,300p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
services/dynamicBrokerRouting.ts:111:export async function refreshDynamicBrokerRoutes(
scripts/copier/pilot.ts:24:  refreshDynamicBrokerRoutes,
scripts/copier/pilot.ts:289:      const refreshed = await refreshDynamicBrokerRoutes(routingConnections, broker, request);
     1	import type { BrokerRoute, BrokerRouterPort } from './brokerRouter';
     2	import type { TradovateBrokerPort, TradovateVisibleAccount } from './tradovateBroker';
     3	
     4	export interface DynamicOAuthConnection {
     5	  connectionId: string;
     6	  broker: TradovateBrokerPort;
     7	}
     8	
     9	export interface DynamicRoutedAccount {
    10	  id: number;
    11	  name: string;
    12	  active: boolean;
    13	  canTrade: boolean;
    14	  connectionId: string;
    15	}
    16	
    17	export interface DynamicBrokerRoutingRequest {
    18	  /** Účty, jejichž absence nebo nejednoznačnost vždy zablokuje refresh. */
    19	  required: readonly number[];
    20	  /** Účty, které se smějí vynechat výhradně tehdy, když je nevrátí žádný OAuth adresář. */
    21	  optional: readonly number[];
    22	}
    23	
    24	interface AccountOwner {
    25	  connection: DynamicOAuthConnection;
    26	  account: TradovateVisibleAccount;
    27	}
    28	
    29	export interface DynamicBrokerRouteResolution {
    30	  routes: BrokerRoute[];
    31	  accounts: DynamicRoutedAccount[];
    32	  missingOptional: number[];
    33	}
    34	
    35	export interface DynamicBrokerRouteRefresh {
    36	  accounts: DynamicRoutedAccount[];
    37	  missingOptional: number[];
    38	}
    39	
    40	/**
    41	 * Čisté, fail-closed rozlišení account -> OAuth. Nikdy nehádá vlastníka:
    42	 * nula i více shod jsou chyba a router se proto vůbec nepřepne.
    43	 */
    44	export function resolveDynamicBrokerRoutes(
    45	  connections: readonly DynamicOAuthConnection[],
    46	  snapshots: ReadonlyMap<string, readonly TradovateVisibleAccount[]>,
    47	  request?: DynamicBrokerRoutingRequest,
    48	): DynamicBrokerRouteResolution {
    49	  if (connections.length === 0) throw new Error('Není nakonfigurované žádné OAuth spojení');
    50	  const owners = new Map<number, AccountOwner[]>();
    51	  for (const connection of connections) {
    52	    const accounts = snapshots.get(connection.connectionId);
    53	    if (!accounts) throw new Error(`OAuth ${connection.connectionId} nevrátilo adresář účtů`);
    54	    for (const account of accounts) {
    55	      owners.set(account.accountId, [...(owners.get(account.accountId) ?? []), { connection, account }]);
    56	    }
    57	  }
    58	
    59	  const required = request == null
    60	    ? [...owners].filter(([, matches]) => matches.some(match => (
    61	      match.account.active && match.account.canTrade && match.account.accountSpec != null
    62	    ))).map(([accountId]) => accountId)
    63	    : [...new Set(request.required)];
    64	  const optional = request == null ? [] : [...new Set(request.optional)];
    65	  const requiredSet = new Set(required);
    66	  const overlap = optional.filter(accountId => requiredSet.has(accountId));
    67	  if (overlap.length > 0) {
    68	    throw new Error(`Účet nesmí být současně required i optional: ${overlap.join(',')}`);
    69	  }
    70	  const requested = [...required, ...optional];
    71	  const optionalSet = new Set(optional);
    72	  const selected: AccountOwner[] = [];
    73	  const missingOptional: number[] = [];
    74	  for (const accountId of requested) {
    75	    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error(`Neplatné ID účtu ${accountId}`);
    76	    const matches = owners.get(accountId) ?? [];
    77	    if (matches.length === 0) {
    78	      if (optionalSet.has(accountId)) {
    79	        missingOptional.push(accountId);
    80	        continue;
    81	      }
    82	      throw new Error(`Účet ${accountId} není viditelný v žádném připojeném OAuth. Připoj nebo obnov jeho prop firmu v Connections.`);
    83	    }
    84	    if (matches.length > 1) {
    85	      throw new Error(`Účet ${accountId} je viditelný ve více OAuth spojeních; routing nelze bezpečně určit.`);
    86	    }
    87	    const match = matches[0];
    88	    if (!match.account.active) throw new Error(`Účet ${accountId} není u Tradovate aktivní`);
    89	    if (!match.account.canTrade) throw new Error(`Účet ${accountId} nemá execution oprávnění`);
    90	    if (!match.account.accountSpec) throw new Error(`Účet ${accountId} nemá platné Tradovate Account.name`);
    91	    selected.push(match);
    92	  }
    93	
    94	  return {
    95	    routes: connections.map(connection => ({
    96	      broker: connection.broker,
    97	      accountIds: selected.filter(item => item.connection === connection).map(item => item.account.accountId),
    98	    })),
    99	    accounts: selected.map(({ connection, account }) => ({
   100	      id: account.accountId,
   101	      name: account.accountSpec as string,
   102	      active: account.active,
   103	      canTrade: account.canTrade,
   104	      connectionId: connection.connectionId,
   105	    })),
   106	    missingOptional,
   107	  };
   108	}
   109	
   110	/** Obnoví všechny OAuth adresáře a teprve po úplném úspěchu atomicky přepne router. */
   111	export async function refreshDynamicBrokerRoutes(
   112	  connections: readonly DynamicOAuthConnection[],
   113	  router: BrokerRouterPort,
   114	  request?: DynamicBrokerRoutingRequest,
   115	): Promise<DynamicBrokerRouteRefresh> {
   116	  const refreshed = await Promise.all(connections.map(async connection => (
   117	    [connection.connectionId, await connection.broker.refreshAccountDirectory()] as const
   118	  )));
   119	  const resolution = resolveDynamicBrokerRoutes(connections, new Map(refreshed), request);
   120	  router.replaceRoutes(resolution.routes);
   121	  return {
   122	    accounts: resolution.accounts,
   123	    missingOptional: resolution.missingOptional,
   124	  };
   125	}

exec
/bin/zsh -lc "nl -ba server/localCopierExecutionAgent.ts | sed -n '690,790p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '4450,4530p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  4450	          }
  4451	          bracketOutbox.set(key, waiveBracketOutboxEntry(entry, explanation, clock()));
  4452	          state = applyResolved(state, [entry.key], entry.leaderSequence);
  4453	        } else if (kind === 'oso') {
  4454	          const entry = osoOutbox.get(key);
  4455	          if (!entry || !stuckOsoEntries([entry]).length) {
  4456	            throw new Error('OSO outbox položka není stuck');
  4457	          }
  4458	          osoOutbox.set(key, waiveOsoOutboxEntry(entry, explanation, clock()));
  4459	          state = applyResolved(state, [entry.key], entry.leaderSequence);
  4460	        } else {
  4461	          const entry = cancelOutbox.get(key);
  4462	          if (!entry || !stuckCancelEntries([entry]).length) {
  4463	            throw new Error('Cancel/modify outbox položka není stuck');
  4464	          }
  4465	          cancelOutbox.set(key, waiveCancelEntry(entry, explanation, clock()));
  4466	          const lifecycleEntries = [...cancelOutbox.values()].filter(
  4467	            item => item.leaderEventId === entry.leaderEventId,
  4468	          );
  4469	          if (
  4470	            lifecycleEntries.length > 0
  4471	            && lifecycleEntries.every(item => item.status === 'confirmed' || item.status === 'waived')
  4472	          ) {
  4473	            state = applyResolved(state, [], entry.leaderSequence);
  4474	          }
  4475	        }
  4476	        const committed = await options.store.commit(
  4477	          toSnapshot(
  4478	            state,
  4479	            outbox.values(),
  4480	            cancelOutbox.values(),
  4481	            current.revision,
  4482	            bracketOutbox.values(),
  4483	            osoOutbox.values(),
  4484	          ),
  4485	          current.revision,
  4486	        );
  4487	        return { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, revision: committed.revision };
  4488	      });
  4489	    },
  4490	    status() {
  4491	      const current = currentRuntime();
  4492	      const stuckOperations = currentStuckOperations();
  4493	      return {
  4494	        started: !stopped,
  4495	        armed: gate.armed,
  4496	        killSwitch: gate.killSwitch,
  4497	        shadowMode: gate.shadowMode,
  4498	        connected: gate.connected,
  4499	        reconciliationRequired: source.needsReconciliation() || !positionCheckComplete,
  4500	        divergentAccounts: [...gate.divergentAccounts],
  4501	        workingOrderAccounts: [...workingOrderAccounts],
  4502	        stuckOutbox: stuckOperations.length > 0,
  4503	        stuckOperations,
  4504	        accountEligibility: (() => {
  4505	          const now = clock();
  4506	          return [...accountEligibility.values()]
  4507	            .map(entry => eligibilityAt(entry, now))
  4508	            .filter(entry => entry.state !== 'active' || entry.lastExecution != null)
  4509	            .map(entry => ({
  4510	              ...entry,
  4511	              lastExecution: entry.lastExecution
  4512	                ? cloneRejectedExecution(entry.lastExecution)
  4513	                : undefined,
  4514	            }));
  4515	        })(),
  4516	        ...(lastOauthPreflight ? {
  4517	          oauthPreflight: {
  4518	            missingAccounts: [...lastOauthPreflight.missingAccounts],
  4519	            inactiveAccounts: [...lastOauthPreflight.inactiveAccounts],
  4520	            readOnlyFollowerAccounts: [...lastOauthPreflight.readOnlyFollowerAccounts],
  4521	          },
  4522	        } : {}),
  4523	        lastError: lastError?.message ?? null,
  4524	        ...(lastDisarm ? { lastDisarm: { ...lastDisarm } } : {}),
  4525	        disarmHistory: disarmHistory.map(record => ({ ...record })),
  4526	        revision: current.revision,
  4527	        lastSequence: current.state.lastSequence,
  4528	        groupFlat: groupIsFlat(),
  4529	        entryCooldownUntil: current.state.safety.entryCooldownUntil,
  4530	        dayLockUntil: current.state.safety.dayLockUntil,

exec
/bin/zsh -lc "rg -n \"type: 'reconcile'|arm-live|arm-shadow\" server/localCopierExecutionAgent.ts" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
334:      case 'arm-live': {
336:        // + arm-live jako dva relay round-tripy (~5 s); teď jde obojí naráz.

exec
/bin/zsh -lc "rg -n \"const invalidateReconciliation|function invalidateReconciliation|invalidateReconciliation =\" services/copierRuntimeController.ts && nl -ba services/copierRuntimeController.ts | sed -n '1060,1115p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
1800:  const invalidateReconciliation = () => {
  1060	    let workingOrderIds = hint.authoritativeWorkingOrderIds;
  1061	    try {
  1062	      if (!episodeLegIds && !workingOrderIds) {
  1063	        const orders = await withSweepDeadline(broker.listOrders(accountId));
  1064	        workingOrderIds = new Set(
  1065	          orders
  1066	            .filter(order => order.symbol === symbol && isOpenOrderStatus(order.status))
  1067	            .map(order => order.brokerOrderId),
  1068	        );
  1069	      }
  1070	    } catch (error) {
  1071	      failSweep(`autoritativní výběr pracovních noh selhal: ${errorOf(error).message}`);
  1072	      return;
  1073	    }
  1074	
  1075	    // Přesný protective fill dovoluje sáhnout jen na jeho vlastní epizodu.
  1076	    // Když fill předběhne position event a přesné ID ještě nemáme, bereme
  1077	    // pouze ID, která broker v čerstvém snapshotu opravdu hlásí jako working.
  1078	    // Durable terminální historie sama o sobě nikdy není kandidát na cancel.
  1079	    const legs = (episodeLegIds ?? [...allProtectiveLegIds].filter(id => workingOrderIds?.has(id)))
  1080	      .filter(brokerOrderId => (
  1081	        !sweptProtectiveLegs.has(brokerOrderId)
  1082	        && !sweepingProtectiveLegs.has(brokerOrderId)
  1083	      ));
  1084	    const cappedLegs = legs.slice(0, SWEEP_MAX_LEGS_PER_CALL);
  1085	    for (const brokerOrderId of cappedLegs) sweepingProtectiveLegs.add(brokerOrderId);
  1086	    // Souběžně: incidentní okno bylo 980 ms a sekvenční rušení do něj
  1087	    // přidávalo jeden round-trip za každou nohu navíc.
  1088	    const failures: string[] = [];
  1089	    await Promise.all(cappedLegs.map(async brokerOrderId => {
  1090	      const leaderEventId = `flat-sweep-${accountId}-${brokerOrderId}`;
  1091	      try {
  1092	        // Cancel chyba sama o sobě nerozhoduje (noha už mohla být terminální);
  1093	        // rozhoduje autoritativní lookup NÍŽE. Jediný inline pokus: retry
  1094	        // smyčka tady držela event stream ~15 s, eskalace je rychlejší.
  1095	        await withSweepDeadline(broker.cancelOrder(accountId, brokerOrderId)).catch(() => undefined);
  1096	        const lookup = await withSweepDeadline(broker.findOrderById(accountId, brokerOrderId));
  1097	        const outcome = lookup.order?.status;
  1098	        if (outcome != null && isOpenOrderStatus(outcome)) {
  1099	          throw new Error(`noha po cancellu stále aktivní (${outcome})`);
  1100	        }
  1101	        if (!lookup.order && lookup.completeness !== 'authoritative') {
  1102	          // Eventual prázdno není důkaz neexistence — nesmí se zapsat
  1103	          // jako zameteno (portová díra z review, bod 14).
  1104	          throw new Error('lookup bez autoritativní odpovědi');
  1105	        }
  1106	        sweptProtectiveLegs.add(brokerOrderId);
  1107	        options.onAudit?.([{
  1108	          at, leaderEventId, accountId, brokerOrderId,
  1109	          // Audit podle skutečného výsledku: vyplněná ani rejectnutá noha
  1110	          // se nesmí vydávat za zrušenou.
  1111	          kind: outcome === 'filled' ? 'filled' : outcome === 'rejected' ? 'rejected' : 'canceled',
  1112	          reason: outcome === 'filled'
  1113	            ? 'follower flat — ochranná noha se mezitím vyplnila'
  1114	            : outcome === 'rejected'
  1115	              ? 'follower flat — ochranná noha skončila rejectem'

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '1785,1810p'; nl -ba server/localCopierExecutionAgent.ts | sed -n '300,365p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
  1785	    await persistSafety({
  1786	      ...currentRuntime().state.safety,
  1787	      dayLockUntil: Math.max(currentRuntime().state.safety.dayLockUntil, until),
  1788	      dayLockReason: reason,
  1789	    });
  1790	    options.onAudit?.([{
  1791	      at: now, leaderEventId: 'auto-day-lock', kind: 'blocked', reason,
  1792	    }]);
  1793	  };
  1794	
  1795	  /**
  1796	   * Zneplatní poslední autoritativní preflight bez vytváření falešného
  1797	   * incidentu. Používá se hlavně v DISARMED, kde nová leader anomálie nic
  1798	   * neposílá followerům, ale další ARM musí nejdřív znovu načíst broker stav.
  1799	   */
  1800	  const invalidateReconciliation = () => {
  1801	    safetyGeneration += 1;
  1802	    positionCheckComplete = false;
  1803	    source.requireReconciliation();
  1804	  };
  1805	
  1806	  const failClosed = (
  1807	    reason: unknown,
  1808	    failure: {
  1809	      transportLost?: boolean;
  1810	      autoClose?: boolean;
   300	      case 'flatten-group':
   301	        assertGroupTarget(group, command.groupId);
   302	        return { type: 'flatten', ...await options.controller.flattenGroup(command.operationId) };
   303	      case 'create-group':
   304	        throw new Error('Lokální agent už má jednu aktivní skupinu');
   305	      case 'delete-group':
   306	        throw new Error('Skupinu nejdřív DISARM a ukonči lokální agent');
   307	      case 'resolve-stuck-operation':
   308	        // Durable waive: nic neposílá brokerovi, odzbrojí a vynutí novou
   309	        // reconciliation. Stejná cesta jako mac-install resolve-stuck.
   310	        await options.controller.waiveStuckOperation({
   311	          kind: command.kind,
   312	          key: command.key,
   313	          reason: command.reason,
   314	        });
   315	        return { type: 'configuration', group };
   316	      case 'cancel-order':
   317	        throw new Error('Ruční cancel z UI zatím není napojen na durable runtime');
   318	    }
   319	  };
   320	
   321	  const execute = async (command: LocalCopierAgentCommand): Promise<unknown> => {
   322	    switch (command.type) {
   323	      case 'copy-command':
   324	        return executeCopyCommand(command.command);
   325	      case 'activate-group': {
   326	        const next: CopyGroupConfig = {
   327	          ...structuredClone(command.group),
   328	          enabled: true,
   329	          localOnly: true,
   330	        };
   331	        await applyGroup(next, 'activate');
   332	        return;
   333	      }
   334	      case 'arm-live': {
   335	        // Volitelný atomický sync konfigurace: dřív UI posílalo update-group
   336	        // + arm-live jako dva relay round-tripy (~5 s); teď jde obojí naráz.
   337	        let routingPrepared = false;
   338	        if (command.group) {
   339	          if (command.group.id !== group.id) {
   340	            // Jediná atomická cesta pro bezpečné UI přepnutí bez brokerových
   341	            // side effectů: DISARM, read-only preflight staré i nové
   342	            // topologie, změna durable epochy a teprve potom reconciliation
   343	            // + ARM. Jakákoli pozice nebo working příkaz přepnutí zablokuje.
   344	            const next: CopyGroupConfig = {
   345	              ...structuredClone(command.group),
   346	              enabled: true,
   347	              localOnly: true,
   348	            };
   349	            await applyGroup(next, 'activate');
   350	            routingPrepared = true;
   351	          } else {
   352	            const next = mappedGroup(group, command.group);
   353	            routingPrepared = !sameAccountTopology(group, next);
   354	            await applyGroup(next);
   355	          }
   356	        }
   357	        options.controller.disarm();
   358	        await options.controller.applyAccountEligibilityExclusions(
   359	          validatedAccountEligibilityExclusions(command.accountEligibilityExclusions),
   360	        );
   361	        if (!routingPrepared) {
   362	          await prepareAccounts(allAccountsRequired(copyGroupAccountIds(group)));
   363	        }
   364	        const reconciliation = await options.controller.reconcile();
   365	        if (reconciliation.divergentAccounts.length > 0 || reconciliation.workingOrderAccounts.length > 0) {

codex
Našel jsem podstatnější stavovou díru než samotné filtrování: wrapper `reconcile()` shazuje recovery flag jen podle vrácených polí, i když vnitřní reconciliation kvůli změně `safetyGeneration` odmítla výsledek uznat jako autoritativní. To je potřeba zahrnout do verdiktu a regresí. Spouštím jen cílené existující testy, bez změn souborů.
exec
/bin/zsh -lc 'npm test -- --run tests/copierConnectionRecoveryOptionalFollower.test.ts tests/copierChaosScenarios.test.ts' in /private/tmp/alphatrade-reconnect-fix
 exited 1 in 154ms:
failed to load config from /private/tmp/alphatrade-reconnect-fix/vitest.config.ts

⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯
Error: EPERM: operation not permitted, open '/private/tmp/alphatrade-reconnect-fix/node_modules/.vite-temp/vitest.config.ts.timestamp-1788418759632-d05ac0aa52fed.mjs'
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
  path: '/private/tmp/alphatrade-reconnect-fix/node_modules/.vite-temp/vitest.config.ts.timestamp-1788418759632-d05ac0aa52fed.mjs'
}




exec
/bin/zsh -lc 'npm test -- --run tests/copierConnectionRecoveryOptionalFollower.test.ts tests/copierChaosScenarios.test.ts' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 739ms:

> alphatrade-mentor@0.0.0 test
> vitest run --run tests/copierConnectionRecoveryOptionalFollower.test.ts tests/copierChaosScenarios.test.ts


 RUN  v4.1.9 /private/tmp/alphatrade-reconnect-fix


 Test Files  2 passed (2)
      Tests  21 passed (21)
   Start at  08:59:29
   Duration  514ms (transform 406ms, setup 0ms, import 473ms, tests 320ms, environment 0ms)


exec
/bin/zsh -lc "git status --short --branch && git diff --check && nl -ba services/copierRuntimeController.ts | sed -n '345,370p'; nl -ba services/dynamicBrokerRouting.ts | sed -n '110,126p'; nl -ba scripts/copier/pilot.ts | sed -n '635,644p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 2240ms:
git: error: couldn't create cache file '/tmp/xcrun_db-6b1P5tFR' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-XfRZoFsS' (errno=Operation not permitted)
## codex/reconnect-fix-20260903...origin/codex/reconnect-fix-20260903 [ahead 12]
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-7y8UsYbS' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-guHo7Pak' (errno=Operation not permitted)
   345	  /** Pilot pojistka: kolik nových leader orderId smí jedna session přijmout. */
   346	  maxLeaderOrders?: number;
   347	  /**
   348	   * Pilot pojistka pro test exekuce: po vyčerpání vstupního limitu dovolí
   349	   * nejvýše jeden nový opačný order, který přesně zavírá známou leader pozici.
   350	   * Bez aktuální Position entity nebo při větším množství failne zavřeně.
   351	   */
   352	  allowSingleFlatExit?: boolean;
   353	  /** Testovatelná bounded read-only konfirmace ručního Flatten. */
   354	  flattenConfirmationAttempts?: number;
   355	  flattenConfirmationPollMs?: number;
   356	  flattenAccountConcurrency?: number;
   357	  wait?: (ms: number) => Promise<void>;
   358	  /**
   359	   * Read-only zdroj „followeři právě neviditelní v žádném připojeném OAuth
   360	   * adresáři“ pro automatickou post-connect recovery. Stejný vstup dostává
   361	   * CLI/UI Kontrola pozic; bez něj broker router pro zmizelý (typicky
   362	   * breached) follower vyhodí chybu a recovery skončí fail-closed, i když je
   363	   * jeho vynechání legitimní. Vrácené ID se filtrují na followery skupiny.
   364	   */
   365	  resolveMissingOptionalAccountIds?: (group: CopyGroupConfig) => Promise<readonly number[]>;
   366	  /**
   367	   * Bounded okno pro spárování follower position 0→nonzero s konkrétním
   368	   * broker fill eventem. Po vypršení následuje autoritativní read-only
   369	   * kontrola; nikdy nejde o autorizaci k automatickému zavření nejasné pozice.
   370	   */
   110	/** Obnoví všechny OAuth adresáře a teprve po úplném úspěchu atomicky přepne router. */
   111	export async function refreshDynamicBrokerRoutes(
   112	  connections: readonly DynamicOAuthConnection[],
   113	  router: BrokerRouterPort,
   114	  request?: DynamicBrokerRoutingRequest,
   115	): Promise<DynamicBrokerRouteRefresh> {
   116	  const refreshed = await Promise.all(connections.map(async connection => (
   117	    [connection.connectionId, await connection.broker.refreshAccountDirectory()] as const
   118	  )));
   119	  const resolution = resolveDynamicBrokerRoutes(connections, new Map(refreshed), request);
   120	  router.replaceRoutes(resolution.routes);
   121	  return {
   122	    accounts: resolution.accounts,
   123	    missingOptional: resolution.missingOptional,
   124	  };
   125	}
   635	      // Post-connect recovery musí vidět stejný optional-skip jako ruční
   636	      // Kontrola pozic, jinak zmizelý breached follower shodí recovery.
   637	      resolveMissingOptionalAccountIds: prepareGroupAccounts
   638	        ? async current => (await prepareGroupAccounts({
   639	          required: [current.leaderAccountId],
   640	          optional: current.followers.map(follower => follower.accountId),
   641	        })).missingOptional
   642	        : undefined,
   643	      // Trade event -> okamžitý poll s příznakem -> server pushne hned.
   644	      onCopyEvent: event => {

exec
/bin/zsh -lc 'git rev-parse HEAD && git log -3 --oneline --decorate && git status --porcelain=v1' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 1819ms:
git: error: couldn't create cache file '/tmp/xcrun_db-yJxy7vJ6' (errno=Operation not permitted)
73bd4a6c686d3a13378408ae16cba91782fe2597
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-QNGHsuNj' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-vibKulSG' (errno=Operation not permitted)
73bd4a6c (HEAD -> codex/reconnect-fix-20260903, origin/main, origin/HEAD) docs(log): rollout 5154856d and leader-flat guard observation
5154856d fix(copier): post-connect recovery honours OAuth-missing followers; clean manual reconcile clears the recovery flag
1bd779aa (origin/claude/companion-gear-focus-20260903, codex/unavailable-follower-ux-20260903) fix(companion): settings gear without system focus ring (build 7)
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-VnEe8Y8L' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-jrABtlDX' (errno=Operation not permitted)

codex
Mezitím se bez mého zásahu posunul `origin/main` z `5154856d` na dokumentační commit `73bd4a6c`; pracovní strom zůstal čistý a recenzovaný kód `5154856d` se nezměnil. Ještě načtu nový relevantní zápis, protože může obsahovat runtime pozorování k témuž recovery guardu.
exec
/bin/zsh -lc "nl -ba docs/PROJECT_LOG.md | sed -n '220,285p'; git show --stat --oneline 73bd4a6c; git show --format= --no-ext-diff 73bd4a6c -- docs/PROJECT_LOG.md | sed -n '1,180p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 1162ms:
git: error: couldn't create cache file '/tmp/xcrun_db-i498Qugg' (errno=Operation not permitted)
73bd4a6c docs(log): rollout 5154856d and leader-flat guard observation
 docs/PROJECT_LOG.md | 24 ++++++++++++++++++++++++
 1 file changed, 24 insertions(+)
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-ic09NnBy' (errno=Operation not permitted)
git: error: couldn't create cache file '/tmp/xcrun_db-UTGr1vO0' (errno=Operation not permitted)
diff --git a/docs/PROJECT_LOG.md b/docs/PROJECT_LOG.md
index 4038f76f..80b8d79d 100644
--- a/docs/PROJECT_LOG.md
+++ b/docs/PROJECT_LOG.md
@@ -241,6 +241,30 @@ write, ARM/DISARM ani zásahu do copier workeru.
   beze změny. Beze změny jsou také server/PWA, broker, copier a jeho ARM stav;
   větev není sloučena do `main`.
 
+### 2026-09-03 (Claude, rollout 5154856d — recovery vs. zmizelý follower)
+
+Uživatel nemohl uložit skupinu bez breached `63338752` („Změnu leadera blokuje
+rozpracovaný lifecycle: connection recovery“) ani zapnout ARM („Follower účet
+… není dostupný“). Příčina: recovery vlna po startu routovala i follower, který
+už není v žádném OAuth adresáři, router hodil chybu, po pěti pokusech
+fail-closed a `pendingConnectionRecovery` zůstal zapnutý (záměr z I), přičemž
+ruční Kontrola pozic ho neshazovala. Oprava (Claude, copier core, Codex
+cross-review vyžádán): recovery dostává přes `resolveMissingOptionalAccountIds`
+stejný optional-skip jako CLI/UI, a autoritativně čistá ruční Kontrola pozic
+příznak shodí; divergentní/neúspěšná ne. Regrese
+`tests/copierConnectionRecoveryOptionalFollower.test.ts` (router bez route).
+Celá sada 1866/1866, tsc čistý. Worker reinstalován ze `5154856d` (bundle
+`6bfcf2df0960de08…`, start 06:56:51 UTC, DISARMED), post-restart reconcile
+čistý.
+
+Pozorování: po startu ještě jednou fail-closed „leader je autoritativně flat,
+follower stav se neshoduje (ne všechny follower snapshoty jsou autoritativně
+dostupné)“ s divergencí `[63338752]` — leader-flat guard při obnově durable
+epochy vyžaduje snapshot i zmizelého followera. Fail-closed je zde správný
+(neověřitelná kopie), ruční reconcile stav vyčistil; zmizí s odebráním účtu ze
+skupiny a ukončením epochy. Paralelně Codex J: odebrání nedostupného followera
+jedním krokem přímo z modalu „Skupinu nelze zapnout“.
+
 ### 2026-09-03 (Claude + uživatel, rollout workera 03d1fc5f)
 
 Na výslovné „nasaď“: čtyři opuštěné `cancel-or-modify` z 2. 9. 18:44 (SL modify

exec
/bin/zsh -lc 'rg -n -C 12 "ne všechny follower snapshoty|leader je autoritativně flat" services/copierRuntimeController.ts && rg -n "scheduleLeaderFlatEpochVerification|verifyLeaderFlatEpoch" services/copierRuntimeController.ts' in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
2405-      return;
2406-    }
2407-
2408-    const affected = [
2409-      ...evaluation.divergentAccountIds,
2410-      ...evaluation.blockedAccountIds,
2411-    ];
2412-    gate = {
2413-      ...gate,
2414-      divergentAccounts: new Set([...gate.divergentAccounts, ...affected]),
2415-    };
2416-    failClosed(new Error(
2417:      `Copier fail-closed: leader je autoritativně flat, follower stav se neshoduje (${evaluation.reason})`,
2418-    ), { autoClose: false });
2419-    const leaderFlatDisarmAt = lastDisarm?.code === 'leader-flat-follower-open'
2420-      || lastDisarm?.trigger === 'transport'
2421-      ? lastDisarm.at
2422-      : undefined;
2423-
2424-    if (evaluation.kind !== 'close-targets') return;
2425-    const closeSafetyGeneration = safetyGeneration;
2426-    const closeToken = {
2427-      epochId: evaluation.epoch.id,
2428-      generation: evaluation.epoch.generation,
2429-    };
1514:  const scheduleLeaderFlatEpochVerification = (
1526:        .then(() => verifyLeaderFlatEpoch(token, expectedSafetyGeneration))
2176:      scheduleLeaderFlatEpochVerification(plan.epoch, plan.token);
2289:  async function verifyLeaderFlatEpoch(
2400:      scheduleLeaderFlatEpochVerification(
2614:            scheduleLeaderFlatEpochVerification(plan.epoch, plan.token);
2657:          scheduleLeaderFlatEpochVerification(epoch, {

exec
/bin/zsh -lc "nl -ba services/copierRuntimeController.ts | sed -n '2280,2435p'; nl -ba services/copierRuntimeController.ts | sed -n '1500,1545p'" in /private/tmp/alphatrade-reconnect-fix
 succeeded in 0ms:
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

codex
## Verdikt: **opravit**

Samotné předání OAuth optional-skipu řeší původní incident, ale ruční `reconcile()` nesmí obecně prohlásit recovery za dokončenou jen podle `0 divergence / 0 working orders`.

### Nálezy

1. **Vysoká závažnost: částečná ruční reconciliation může obejít nedokončenou recovery.**

   [`reconcile()`](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4318) shodí `pendingConnectionRecovery`, přestože neprovedla:

   - [`resumeLeaderFlatEpochsAfterSnapshot()`](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2730),
   - rozhodnutí o orphan expozici a případný auto-flatten,
   - [`syncLiveCopyExposureFlag('clear')`](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2733),
   - recovery audit a aktualizaci výsledku transportního DISARM.

   Konkrétní nebezpečný scénář:

   1. Durable epocha říká, že dnes OAuth-missing follower vlastnil kopii.
   2. Leader během výpadku skončil flat.
   3. Automatická recovery selže ještě před obnovením leader-flat guardu a ponechá `pendingConnectionRecovery=true`.
   4. Ruční reconcile dostane followera jako `missingOptional`, takže ho vůbec nesnímkuje. Viditelné účty jsou flat, vrátí tedy `0/0` a nový kód flag shodí.
   5. Reconfigure odebere followera; jeho preflight ho jako optional také přeskočí a následně smaže `liveCopyOpenSince` i `leaderExposureEpochs` v [řádcích 4050–4061](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4050).
   6. Případná osiřelá pozice na neviditelném účtu zůstane neověřená a durable ownership důkaz zmizí.

   Není to jen hypotéza: nový projektový zápis uvádí, že leader-flat guard po rollout skutečně skončil fail-closed právě kvůli nedostupnému snapshotu followera; tento fail-closed je označen jako správný [PROJECT_LOG.md:260](/private/tmp/alphatrade-reconnect-fix/docs/PROJECT_LOG.md:260).

   U viditelného orphan followera se to nestane: reconciliation vrátí divergenci a flag nespadne. Synchronně otevřenou skupinu zase nepustí vlastní non-flat preflight reconfigure ani ARM [controller:4036](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4036), [controller:4163](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4163). Problém je především částečný snapshot s `missingOptional`.

2. **Střední závažnost: wrapper ignoruje safety-generation fence.**

   Vnitřní reconciliation správně odmítne označit výsledek za autoritativní, pokud během broker I/O vznikne reconnect nebo jiná invalidace [controller:3877](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3877). Přesto může vrátit prázdná pole a wrapper na [řádku 4323](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4323) shodí recovery flag.

   Výsledek tedy může být současně:

   - `reconciliationRequired=true`,
   - `positionCheckComplete=false`,
   - ale `pendingConnectionRecovery=false`.

   Rozhodnutí musí používat explicitní `authoritativelyClean`/generation výsledek, ne pouze dvě pole.

3. **Filtrování callbacku je syntakticky správné, ale sémanticky nedostatečné.**

   Dedup, intersection s followery a vyloučení leadera v [řádcích 2698–2700](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2698) brání injekci cizího ID. Leader je navíc už zakázán invariantem skupiny.

   Nechrání ale před stale false-positive. Pilot předává jako optional všechny followery [pilot.ts:637](/private/tmp/alphatrade-reconnect-fix/scripts/copier/pilot.ts:637). Když resolver omylem označí stále dostupného followera jako missing, reconciliation ho změní na `unverifiable`, vynechá jeho snapshot a recovery může ostatní účty vyhodnotit jako flat a smazat marker.

   Skutečný resolver sice v jednom volání načte všechny adresáře a atomicky nahradí routy [dynamicBrokerRouting.ts:110](/private/tmp/alphatrade-reconnect-fix/services/dynamicBrokerRouting.ts:110), ale chybí routing revision/token. Souběžný refresh nebo reappearance po návratu callbacku může výsledek okamžitě zestárnout.

   Nový LIVE ARM provádí další required refresh a reconciliation, takže nové kopírování by mělo být zablokováno. To však nenahrazuje správné dokončení recovery existující expozice.

4. **Chyba callbacku se beze stopy zahodí.**

   `catch` na [řádcích 2701–2703](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2701) ji nahradí prázdným seznamem a chyby pěti reconciliation pokusů se také ignorují. Konečný error je pouze obecný. To nesplňuje otevřený požadavek z logu „při selhání zapsat audit s důvodem“ [PROJECT_LOG.md:59](/private/tmp/alphatrade-reconnect-fix/docs/PROJECT_LOG.md:59).

### Race se změnou skupiny

Běžný `reconfigureGroup()` samotnou skupinu během callbacku nezmění: recovery už běží uvnitř `eventTail` a reconfigure se za něj zařadí [controller:2783](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2783), [controller:3946](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3946).

Dvě mezery ale zůstávají:

- `updateGroup()` mění `group` synchronně mimo `eventTail` [controller:4404](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4404). Stejnoleaderová konfigurace tedy může zestárnout mezi předáním `group` callbacku a reconciliation.
- Lokální agent provádí routing refresh před zařazením topology reconfigure do controlleru. Dva souběžné refreshe mohou přepisovat router metodou „poslední vyhrává“.

Typickým následkem bude fail-closed nebo zbytečně zamítnutý reconfigure. Horší varianta nastane, pokud novější refresh followera znovu přidá, ale recovery dál použije starý seznam `missingOptional` a jeho dostupný stav přeskočí.

### Doporučená oprava

- Odstranit obecné `pendingConnectionRecovery=false` z veřejného `reconcile()`.
- Potřebné odblokování implementovat atomicky v `reconfigureLeaderEpoch()` pouze pro odebrání přesně uvedených OAuth-missing, již durable-ineligible followerů, po čerstvém preflightu všech dostupných starých i nových účtů.
- Jestli durable leader epoch obsahuje odstraňovaného followera bez autoritativního snapshotu, vyžadovat explicitní recovery waiver/důvod a auditovat ztrátu ownership; nevydávat ji za čistou full recovery.
- Rozšířit `ReconciliationResult` o `authoritativelyClean` a případně `generation`, `completeSnapshot`/`missingAccounts`. Flag nikdy neměnit při generation mismatch ani částečném snapshotu.
- Serializovat routing refresh nebo vracet routing revision a po callbacku ověřit zároveň group revision i routing revision. Při změně zahodit vstup a recovery opakovat.
- Zachovat poslední callback/reconciliation chybu a zapsat konkrétní blocked audit.

### Testy

Nový test věrně reprodukuje základ původního incidentu: durable marker, breached follower bez router route, pět neúspěšných pokusů a úspěch s optional-skipem. Neověřuje však celý skutečný safety lifecycle.

Doplnil bych:

- callback vrátí `[missingFollower, leader, outsideGroup]`;
- callback vyhodí výjimku — pending zůstane a audit obsahuje původní důvod;
- follower je mylně označen missing, přesto je routovaný a má orphan pozici;
- follower mezi callbackem a reconciliation znovu objeví;
- deferred callback + souběžný `updateGroup` a routing refresh;
- safety-generation se změní během ruční reconciliation;
- ruční `0/0` nad synchronně otevřenou skupinou;
- durable leader-flat epocha s missing followerem: nesmí se smazat ani obejít bez explicitního waiveru;
- assertion nad `liveCopyOpenSince`, stavem epochy a recovery auditem.

Cíleně jsem spustil nový recovery test spolu s chaos recovery sadou: **2 soubory, 21/21 testů prošlo**. Repo jsem nezměnil; pracovní strom zůstal čistý.


tokens used
125 901
## Verdikt: **opravit**

Samotné předání OAuth optional-skipu řeší původní incident, ale ruční `reconcile()` nesmí obecně prohlásit recovery za dokončenou jen podle `0 divergence / 0 working orders`.

### Nálezy

1. **Vysoká závažnost: částečná ruční reconciliation může obejít nedokončenou recovery.**

   [`reconcile()`](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4318) shodí `pendingConnectionRecovery`, přestože neprovedla:

   - [`resumeLeaderFlatEpochsAfterSnapshot()`](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2730),
   - rozhodnutí o orphan expozici a případný auto-flatten,
   - [`syncLiveCopyExposureFlag('clear')`](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2733),
   - recovery audit a aktualizaci výsledku transportního DISARM.

   Konkrétní nebezpečný scénář:

   1. Durable epocha říká, že dnes OAuth-missing follower vlastnil kopii.
   2. Leader během výpadku skončil flat.
   3. Automatická recovery selže ještě před obnovením leader-flat guardu a ponechá `pendingConnectionRecovery=true`.
   4. Ruční reconcile dostane followera jako `missingOptional`, takže ho vůbec nesnímkuje. Viditelné účty jsou flat, vrátí tedy `0/0` a nový kód flag shodí.
   5. Reconfigure odebere followera; jeho preflight ho jako optional také přeskočí a následně smaže `liveCopyOpenSince` i `leaderExposureEpochs` v [řádcích 4050–4061](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4050).
   6. Případná osiřelá pozice na neviditelném účtu zůstane neověřená a durable ownership důkaz zmizí.

   Není to jen hypotéza: nový projektový zápis uvádí, že leader-flat guard po rollout skutečně skončil fail-closed právě kvůli nedostupnému snapshotu followera; tento fail-closed je označen jako správný [PROJECT_LOG.md:260](/private/tmp/alphatrade-reconnect-fix/docs/PROJECT_LOG.md:260).

   U viditelného orphan followera se to nestane: reconciliation vrátí divergenci a flag nespadne. Synchronně otevřenou skupinu zase nepustí vlastní non-flat preflight reconfigure ani ARM [controller:4036](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4036), [controller:4163](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4163). Problém je především částečný snapshot s `missingOptional`.

2. **Střední závažnost: wrapper ignoruje safety-generation fence.**

   Vnitřní reconciliation správně odmítne označit výsledek za autoritativní, pokud během broker I/O vznikne reconnect nebo jiná invalidace [controller:3877](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3877). Přesto může vrátit prázdná pole a wrapper na [řádku 4323](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4323) shodí recovery flag.

   Výsledek tedy může být současně:

   - `reconciliationRequired=true`,
   - `positionCheckComplete=false`,
   - ale `pendingConnectionRecovery=false`.

   Rozhodnutí musí používat explicitní `authoritativelyClean`/generation výsledek, ne pouze dvě pole.

3. **Filtrování callbacku je syntakticky správné, ale sémanticky nedostatečné.**

   Dedup, intersection s followery a vyloučení leadera v [řádcích 2698–2700](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2698) brání injekci cizího ID. Leader je navíc už zakázán invariantem skupiny.

   Nechrání ale před stale false-positive. Pilot předává jako optional všechny followery [pilot.ts:637](/private/tmp/alphatrade-reconnect-fix/scripts/copier/pilot.ts:637). Když resolver omylem označí stále dostupného followera jako missing, reconciliation ho změní na `unverifiable`, vynechá jeho snapshot a recovery může ostatní účty vyhodnotit jako flat a smazat marker.

   Skutečný resolver sice v jednom volání načte všechny adresáře a atomicky nahradí routy [dynamicBrokerRouting.ts:110](/private/tmp/alphatrade-reconnect-fix/services/dynamicBrokerRouting.ts:110), ale chybí routing revision/token. Souběžný refresh nebo reappearance po návratu callbacku může výsledek okamžitě zestárnout.

   Nový LIVE ARM provádí další required refresh a reconciliation, takže nové kopírování by mělo být zablokováno. To však nenahrazuje správné dokončení recovery existující expozice.

4. **Chyba callbacku se beze stopy zahodí.**

   `catch` na [řádcích 2701–2703](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2701) ji nahradí prázdným seznamem a chyby pěti reconciliation pokusů se také ignorují. Konečný error je pouze obecný. To nesplňuje otevřený požadavek z logu „při selhání zapsat audit s důvodem“ [PROJECT_LOG.md:59](/private/tmp/alphatrade-reconnect-fix/docs/PROJECT_LOG.md:59).

### Race se změnou skupiny

Běžný `reconfigureGroup()` samotnou skupinu během callbacku nezmění: recovery už běží uvnitř `eventTail` a reconfigure se za něj zařadí [controller:2783](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:2783), [controller:3946](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:3946).

Dvě mezery ale zůstávají:

- `updateGroup()` mění `group` synchronně mimo `eventTail` [controller:4404](/private/tmp/alphatrade-reconnect-fix/services/copierRuntimeController.ts:4404). Stejnoleaderová konfigurace tedy může zestárnout mezi předáním `group` callbacku a reconciliation.
- Lokální agent provádí routing refresh před zařazením topology reconfigure do controlleru. Dva souběžné refreshe mohou přepisovat router metodou „poslední vyhrává“.

Typickým následkem bude fail-closed nebo zbytečně zamítnutý reconfigure. Horší varianta nastane, pokud novější refresh followera znovu přidá, ale recovery dál použije starý seznam `missingOptional` a jeho dostupný stav přeskočí.

### Doporučená oprava

- Odstranit obecné `pendingConnectionRecovery=false` z veřejného `reconcile()`.
- Potřebné odblokování implementovat atomicky v `reconfigureLeaderEpoch()` pouze pro odebrání přesně uvedených OAuth-missing, již durable-ineligible followerů, po čerstvém preflightu všech dostupných starých i nových účtů.
- Jestli durable leader epoch obsahuje odstraňovaného followera bez autoritativního snapshotu, vyžadovat explicitní recovery waiver/důvod a auditovat ztrátu ownership; nevydávat ji za čistou full recovery.
- Rozšířit `ReconciliationResult` o `authoritativelyClean` a případně `generation`, `completeSnapshot`/`missingAccounts`. Flag nikdy neměnit při generation mismatch ani částečném snapshotu.
- Serializovat routing refresh nebo vracet routing revision a po callbacku ověřit zároveň group revision i routing revision. Při změně zahodit vstup a recovery opakovat.
- Zachovat poslední callback/reconciliation chybu a zapsat konkrétní blocked audit.

### Testy

Nový test věrně reprodukuje základ původního incidentu: durable marker, breached follower bez router route, pět neúspěšných pokusů a úspěch s optional-skipem. Neověřuje však celý skutečný safety lifecycle.

Doplnil bych:

- callback vrátí `[missingFollower, leader, outsideGroup]`;
- callback vyhodí výjimku — pending zůstane a audit obsahuje původní důvod;
- follower je mylně označen missing, přesto je routovaný a má orphan pozici;
- follower mezi callbackem a reconciliation znovu objeví;
- deferred callback + souběžný `updateGroup` a routing refresh;
- safety-generation se změní během ruční reconciliation;
- ruční `0/0` nad synchronně otevřenou skupinou;
- durable leader-flat epocha s missing followerem: nesmí se smazat ani obejít bez explicitního waiveru;
- assertion nad `liveCopyOpenSince`, stavem epochy a recovery auditem.

Cíleně jsem spustil nový recovery test spolu s chaos recovery sadou: **2 soubory, 21/21 testů prošlo**. Repo jsem nezměnil; pracovní strom zůstal čistý.


