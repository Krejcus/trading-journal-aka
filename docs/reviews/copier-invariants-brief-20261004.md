# Zadání pro Codex: sepsat pravidla jádra kopírky (`docs/COPIER_INVARIANTS.md`)

Autor zadání: Claude, 2026-10-04 · schválil Filip · zpracovává Codex

## Proč

Za 5 dní končí předplatné Codexe. Údržbu kopírky pak převezme jen Claude.
Claude zná dobře UI, ale jádro kopírky čte jen po výsecích, a proto u
složitějších návrhů opakovaně přehlíží pravidla, která jádro drží (příklad:
4. 10. navrhl automaticky volat veřejné `reconcile()`, které maže `lastError`,
čímž by schoval incident).

Cílem je **přenést tvou znalost jádra do repa**: jeden dokument, podle kterého
Claude (a jeho agent-oponent) pozná, čeho se změna dotýká, co nesmí obejít a
proč. Dokument je důležitější než jakákoli nová funkce — piš ho tak, aby
z něj šlo pracovat bez tebe.

## Výstup

Soubor `docs/COPIER_INVARIANTS.md` (česky), commit ve vlastní větvi.
Nic jiného neměň (kromě případného zápisu do `docs/PROJECT_LOG.md`).

## Pravidla práce

- Pracuj ve worktree nad `origin/main`: `git worktree add -b
  codex/copier-invariants-20261004 /private/tmp/alphatrade-copier-invariants
  origin/main`. Nikdy nespouštěj `npm ci` / `npm install` / `rm -rf
  node_modules` (node_modules je sdílený symlinkem).
- **Žádné změny kódu.** Jen dokument.
- **Ověřuj proti kódu, ne proti paměti.** Každé pravidlo musí mít odkaz
  `soubor:řádek` (nebo název funkce), kde se vynucuje. Co nejde z kódu
  potvrdit, označ výslovně `NEOVĚŘENO` nebo `OTÁZKA`.
- Nic nepushuj na `main`. Commit ve větvi; o merge rozhodne Filip.
- Raději úplnost než krása; ale strukturuj tak, aby šlo rychle najít
  konkrétní téma (nadpisy, ID pravidel).

## Struktura dokumentu

### 1. Mapa jádra (krátce)
Které soubory tvoří jádro a co dělají — minimálně: `services/copierRuntimeController.ts`,
`copierEngine.ts`, `copierOutbox.ts` + `copierBracketOutbox.ts` + `copierCancelOutbox.ts` +
`copierOsoOutbox.ts`, `copierLeaderEventSource.ts`, `copierLeaderFlatGuard.ts`,
`copierRiskGate.ts`, `copierDailyRules.ts`, `copierArmSession.ts`,
`copierWorkerLease.ts`, `copierStore.ts`/`fileCopierStore.ts`/`supabaseCopierStore.ts`,
`copierLiquidationRecovery.ts`, `copierManualActions.ts`,
`server/localCopierExecutionAgent.ts`, `server/macCopierCommandRelay.ts`,
`server/tradovateCopierCommandRelay.ts`, `server/copierIncidentWatchdog.ts`,
`lib/localCopierAgentProtocol.ts`, `lib/copierSafetyControls.ts`,
`lib/copierStatusPollFence.ts`, `lib/copierBrakeDelivery.ts`. Doplň, co chybí.
Tok jedné leader události od Tradovate po follower příkaz a durable stav.

### 2. Pravidla (invarianty)
Každé pravidlo ve tvaru:

```
### INV-<oblast>-<číslo>: <jedna věta pravidla>
- Proč: <důvod, incident nebo historie, která k němu vedla>
- Vynucuje: <soubor:řádek / funkce>
- Hlídá test: <tests/…> (nebo „žádný test“ — pak to výslovně uveď)
- Nikdy: <co se nesmí udělat, i kdyby to vypadalo jako zjednodušení>
- Bezpečné změny vs. nebezpečné: <příklady>
```

Oblasti (každou pokryj; přidej další, pokud existují):

- **Výchozí stav a fail-closed** — DISARMED default, co se děje při chybě,
  neznámém stavu, výpadku, restartu, ztrátě lease.
- **ARM brány** — úplný seznam podmínek ARM (connected, outbox, divergence,
  working orders, reconciliation, management-only, unconfirmed flat lots,
  day lock, trading window, cooldown, position check, eligibility, risk,
  shadow mode…) a proč každá existuje. Včetně nové přípravy ON/OFF
  (`docs/COPIER_ARM_PREPARATION_20261004.md`): co přesně potvrzení
  připravenosti obsahuje, kdy se zneplatní, proč nevolá `reconcile()`.
- **DISARM, kill switch, day lock** — jednosměrná západka, obcházení FIFO,
  doručení brzdy přes relay (`lastAgentRoute`), co se děje s otevřenými
  kopiemi (`armExpiryFlatten`), proč brzda nečeká na čerstvý stav.
- **Kontrola pozic / reconciliation** — kdy se vyžaduje
  (`needsReconciliation`, `positionCheckComplete`), rozdíl mezi veřejným
  `reconcile()` (ruční recovery, `clearLastError`, auditovaný DISARM) a
  interními kontrolami; co smí a co nesmí smazat incident/`lastError`.
- **Outbox a idempotence** — Tradovate není idempotentní, `clOrdId`,
  lookup-before-retry, žádný blind retry, nejistý výsledek, stuck operace.
- **Divergence** — halt-group, nikdy se neopravuje obchodem, kdo ji smí
  vyčistit.
- **Pořadí a čerstvost stavu** — `CopierStatusAckFence`, poll fence,
  `shouldAcceptCopierStatus` (startedAt + revision), safety generation,
  15s freshness; co smí UI dělat se zastaralým/obnoveným stavem (jen
  zobrazení, nikdy autorizace).
- **Relay příkazy** — idempotencyKey, TTL/expirace, long-poll, fronta brzd,
  co když výsledek nedorazí („nejistý výsledek se neopakuje“).
- **Způsobilost účtů** — active / dll-locked / breached / unverifiable;
  `applyAccountEligibilityExclusions` jen zpřísňuje, `active` obnovuje jen
  reconciliace; inferovaný DLL z LIVE dat vs. worker.
- **Účast followerů a cuty** — ruční vypnutí, trade cut, automatické
  vyřazení; kdy jde přepínat (flat), co se nesmí obejít.
- **Risk a denní pravidla** — DLL/MLL, `dailyLossLimitUsd`,
  `dailyMaxLosingTrades`, `dailyMaxTrades`, trading window, cooldown,
  zamykání až po flat, session hranice 17:00 America/Chicago.
- **Management-only režim, shadow mode, liquidation recovery.**
- **Worker identita a lease** — lease/fencing, párování zařízení, co když
  běží dva workery, VPS plán (co je zapojené a co ne).
- **Tradovate specifika** — OSO/bracket, partial fill, Suspended nohy,
  Tag50, rate limity, reconnect o víkendu, dvě OAuth připojení.
- **UI pravidla** — neznámý stav se nesmí tvářit jako aktivní/flat, DISARM
  vždy dostupný, obnovené/zapamatované hodnoty (stav workeru, paměť
  rozhodnutí dne, retained risk hodnoty) jsou jen zobrazení.

### 3. Kontrolní seznam před změnou jádra
Konkrétní otázky, které musí autor změny zodpovědět, než ji navrhne
(např. „Může změna způsobit ARM bez čerstvého potvrzení?“, „Smaže nebo
schová incident?“, „Může se nejistý výsledek příkazu automaticky
zopakovat?“, „Co když přijde OFF během operace?“, „Co restart workeru
uprostřed?“…). Napiš je tak, aby je šlo použít jako zadání pro
agenta-oponenta.

### 4. Známé pasti a historické incidenty
Co se už jednou pokazilo a proč (z `docs/PROJECT_LOG.md`, review dokumentů
a tvé zkušenosti), stručně s odkazem.

### 5. Slabá místa a otevřené otázky
Co víš, že není ideální nebo plně ošetřené, a co bys doporučil řešit dál.
Buď konkrétní — tohle je tvoje předávka.

## Hotovo, když

- Každá oblast z bodu 2 má aspoň jedno pravidlo nebo výslovné „nic tu není“.
- Každé pravidlo má `Vynucuje:` s odkazem do kódu.
- Nejasnosti jsou označené, ne zamlčené.
- Commit ve větvi `codex/copier-invariants-20261004`, krátký zápis do
  `docs/PROJECT_LOG.md` ve stejné větvi.
