# Review brief — copier změny z 27. 8. 2026 (pro Opus 5)

## Kontext

Repo: `/Users/filipkrejca/Documents/trading-journal-aka` (AlphaTrade / AlphaBridge).
Copier je **bezpečnostně kritický kód**: kopíruje obchody z leader účtu na
follower účty u Tradovate (prop firmy — porušení risku = ztráta účtu).
Závazné invarianty (viz `CLAUDE.md`, `AGENTS.md`, `docs/PROJECT_LOG.md`):

- DISARMED default, fail-closed všude; kill switch = jednosměrná západka.
- Žádný blind retry — po nejistém výsledku vždy lookup podle `clOrdId`
  (Tradovate NENÍ idempotentní, outbox + lookup-before-retry je nosná
  konstrukce, ne pojistka).
- Divergence leader/follower se NIKDY neopravuje obchodem — jen halt-group.
- Záměrná tichá divergence (leader obchoduje, follower tiše nekopíruje,
  nikdo o tom neví) je zakázaný stav.
- ARM vyžaduje autoritativní flat; otevřený obchod se nikdy neadoptuje.

Před review si přečti hlavičku a zápisy z 26.–27. 8. v `docs/PROJECT_LOG.md`
(incidenty: OSO parent cascade, fatal SL/Flatten, falešný fail-closed po
reconnectu).

## Předmět review

Commity na `origin/main`, v pořadí (nejstarší první):

1. `de93fd3a` — Harden copier protection and emergency flatten (incident fix;
   28 souborů, +844/−157). Projít, ale primárně jako kontext.
2. `79bc09ff` — fix: harden serverless ESM and pending-order safety.
3. `6d0caefb` — fix: ignore terminal order history after reconnect.
4. `cf316f37` — fix: reconcile terminal stop fill races. **← hlavní ohnisko;
   nemá zápis v PROJECT_LOG a přesná motivace je známa jen z diffu.**

Klíčový soubor: `services/copierRuntimeController.ts` (+ testy
`tests/copierRuntimeController.test.ts`, `tests/copierReviewRegressions.test.ts`).

## Konkrétní otázky (seřazené podle závažnosti)

### A. `performReconciliation` → `gate = { ...gate, shadowMode: true }` (cf316f37)

Po úspěšné kontrole pozic se nově nastaví `lastError = null` a
`shadowMode: true` — **bez komentáře**. Ověř:

1. Může být `performReconciliation` zavolána, když je gate živě ARMED
   (`armed && !shadowMode`)? Call-sites: veřejné API `reconcile()`
   (relay příkaz „kontrola pozic" z LIVE UI), `runConnectionRecovery`
   (po reconnectu/resyncu), nová větev `reconcileAfterTerminalFill`
   v `scheduleAutoClose`.
2. Plánovaná obměna socketu (`event.resynced`, connection event s
   `connected: true`) NENULUJE `armed`. Komentář u ní tvrdí „když jsou účty
   synchronní, ARM pokračuje a uživatel nic nepozná" — platí to ještě?
   Pokud reconciliation překlopí živý ARM do shadow, vzniká tichá
   divergence: leader obchoduje, follower nekopíruje, žádný alert.
   Napiš přesný sled událostí (event → stav gate) pro:
   a) plánovaný resync za živého ARM s flat účty,
   b) plánovaný resync za živého ARM s otevřenou synchronní pozicí,
   c) ruční „Kontrola pozic" z UI za živého ARM.
3. Pokud je to reálná chyba: jaký je minimální bezpečný fix? (Např.
   nastavovat shadow jen když `!gate.armed`, nebo jen v recovery větvi
   po fail-closed.) Pokud je to záměr, kde je test, který to dokazuje,
   a proč tomu neodpovídá komentář u resyncu?
4. Vedlejší efekt `lastError = null`: nemaskuje incident v UI/statusu
   dřív, než ho uživatel viděl? (Audit log zůstává — ověř, že watchdog/
   alert pipeline z lastError nečte.)

### B. `if (gate.armed)` guardy kolem `failClosed` (cf316f37)

Lone-leg OSO, incomplete-bracket timer a OSO observation „blocked" nově
volají `failClosed` jen při `gate.armed`. Ověř:

1. Ve stavu SHADOW ARMED (`armed && shadowMode`) se fail-closed pořád
   spouští — je to žádoucí? (Shadow nic neposílá, ale incident se založí.)
2. V DISARMED se událost jen audituje jako `blocked`. Zůstane po ní čistý
   stav (correlatory, pending timery, `settleOsoFlush`), takže následný ARM
   nenarazí na napůl zpracovaný pár? Zkus vymyslet sekvenci
   DISARM → lone-leg událost → okamžitý ARM → další leader event.
3. Nezmizel tím nějaký případ, kdy DISARMED runtime dřív správně
   eskaloval problém, který teď zapadne jen do auditu?

### C. `failClosedOnCriticalAudit` + `reconcileAfterTerminalFill` (cf316f37)

Nová recovery větev: modify skončil `filled` (abandoned v cancel outboxu)
→ fail-closed → auto-flatten → reconciliation → audit `recovered`/`blocked`.

1. Je detekce (`critical.kind === 'cancel-failed'` && outbox lifecycle
   `operation === 'modify' && status === 'abandoned' && outcome === 'filled'`)
   dostatečně úzká? Může ji splnit i scénář, kde auto-reconciliation po
   flatten NENÍ bezpečná (např. divergentní fill na jiném účtu ve stejné
   dávce auditu — bere se jen PRVNÍ critical item)?
2. Reconciliation v této větvi běží uvnitř `scheduleAutoClose` po
   `autoFlattenCopies` — co když flatten selže (throw)? Ověř, že se
   recovery reconciliation nespustí nad neflat stavem a nevyaudituje
   `recovered` omylem.
3. Racy: může mezitím přijít další leader event / reconnect a recovery
   reconciliation přepsat čerstvější stav (`positionCheckComplete`,
   `shadowMode`)?

### D. Quantity guard jen pro open stavy (6d0caefb)

`event.order.quantity > asserted` teď fail-closuje jen při
`isOpenOrderStatus`. Ověř zbytkové riziko:

1. Skutečně cizí navýšení, které worker poprvé uvidí až jako `filled`
   (working stav propásl kvůli výpadku) — chytí ho spolehlivě fill/position
   větev a autoritativní reconciliation? Najdi konkrétní kód a test,
   který to dokazuje; pokud neexistuje, navrhni regresi.
2. `isOpenOrderStatus` — projdi mapování Tradovate stavů
   (`services/tradovateMapping.ts`): spadá `PendingNew`/`Suspended`/unknown
   správně na „open" stranu? Unknown stav nesmí guard tiše vypnout.

### E. Pending-order gate v UI (79bc09ff)

`LiveCopyTradeOverview`: zelený štít vyžaduje přesný `Working`, ale pro
vypnutí/přepnutí skupiny je každý neterminální stav aktivní riziko. Zkontroluj
konzistenci obou definic napříč UI a workerem (žádné místo, kde by
`PendingNew` prošel jako „bez příkazů").

### F. Proces a rollout

1. `cf316f37` nemá zápis v `docs/PROJECT_LOG.md` (pravidlo č. 2 hlavičky) —
   navrhni zápis podle zjištění review.
2. Push na `main` = auto-deploy na Vercel produkci; Mac worker byl naposledy
   reinstalován ze stromu `de93fd3a`. Zhodnoť drift: které z oprav
   (`79bc09ff`, `6d0caefb`, `cf316f37`) mění chování WORKERU a co znamená,
   že worker běží bez nich (např. falešné fail-closed incidenty po
   reconnectu trvají do reinstalace). Reinstalaci NEPROVÁDĚJ — jen doporuč
   (politika: obchodní dny = čekat na explicitní „nasaď").

## Pravidla review

- **Read-only.** Žádný ARM, Flatten, brokerový příkaz, deploy, push ani
  reinstalace workeru. Žádné zápisy kromě report souboru (a případného
  návrhu zápisu do PROJECT_LOG jako TEXT v reportu, ne přímý edit).
- Testy spouštěj lokálně dle libosti (`npx vitest run tests/copierRuntimeController.test.ts`
  a plný běh `npx vitest run`; dále `npx tsc --noEmit`). Očekávaný baseline:
  1563/1563, typecheck čistý.
- Každé zjištění doleř na konkrétní řádky (`soubor:řádek`) a u každého uveď
  konkrétní sled událostí, kterým se projeví (vstupy → špatný stav gate /
  ztracená ochrana). Hypotézy bez sledu událostí označ jako hypotézy.
- U každého nálezu: závažnost (CRITICAL = může vést k nechráněné pozici,
  tiché divergenci nebo nechtěnému brokerovému příkazu / HIGH / MEDIUM /
  LOW), doporučený minimální fix a regresní test.
- Výstup: strukturovaný report (souhrn → nálezy podle závažnosti → odpovědi
  na otázky A–F → doporučené další kroky). Česky.
