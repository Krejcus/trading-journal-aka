# Review: příprava ON/OFF kopírky (`bd02de39`)

Reviewer: Claude, 2026-10-04 · Autor změny: Codex · Pro: Codex (opravy), Filip (rozhodnutí)
Podklad: `docs/COPIER_ARM_PREPARATION_20261004.md`, diff `6f9dd4d9..bd02de39`
(`services/copierRuntimeController.ts`, `server/localCopierExecutionAgent.ts`,
`components/LiveCopyTradeOverview.tsx`, testy).

Odkazy na řádky platí pro `bd02de39`.

## Verdikt

Bez P1. Změna může zůstat nasazená. Nález 1 doporučuji opravit do konce
předplatného (zátěž API na stejném loginu, přes který se kopíruje), nálezy
2 a 3 jsou drobnosti.

## Ověřené invarianty (bez nálezu)

- **ARM jen nad čerstvým autoritativním stavem.** Potvrzení připravenosti
  váže safety generation, broker observation version, connection sync
  generation, konfiguraci + eligibility, ověřené účty a route epochy;
  max 30 s, jedna Tradovate session (`hasFreshArmPreparation`). `arm()`
  s `requirePreparation` ho kontroluje znovu a všechny dosavadní ARM brány
  zůstaly (`needsReconciliation`, `positionCheckComplete`, outbox,
  divergence, working orders, day lock, okno, cooldown, risk…).
- **Preflight po čistém výsledku potvrdí `needsReconciliation`**
  (`readFlatPreflightSnapshot`, `source.acknowledgeReconciliation()` ř. 8161),
  takže agent bez veřejného `reconcile()` po reconnectu nezůstane zablokovaný.
- **Incident nesmaže automatika — přísnější než dřív.** Původní ARM cesta
  v agentovi volala veřejné `reconcile()` s `clearLastError: true`, takže ON
  incident uklízel sám. Nově `lastError` / `armPreparationIncidentRequiresRecovery`
  přípravu blokují (`armPreparationBlocker` ř. 7943) a vymaže je jen ruční
  Kontrola pozic (ř. 14301).
- **OFF / kill switch / deadline:** OFF během přípravy zvýší safety
  generation → `assertCurrent` přípravu zahodí; `assertArmAdmissible` po
  přípravě blokuje pozdní ARM; UI zahodí výsledek starého ON podle
  `copierTransitionRequest`. OFF na kontrolu nečeká.
- **Testy:** `tests/copierWorkerArmPreparation.test.ts` + panel + přepínač
  (35/35 prošlo i u mě). Pokrývají OFF během pomalého čtení, kill switch,
  deadline, invalidaci událostí a tras, optional účty, incident, otevřené
  pozice, změnu konfigurace, timeout.

## Nálezy

### 1. [P2] Trvalá zátěž API: příprava se obnovuje každých 20 s, kdykoli je kopírka vypnutá

**Stav 2026-10-04: opraveno.** Background příprava má 20s interval pouze
uvnitř aktivního `tradingWindow` nebo 60 s po lokálním čtení `/v1/status`;
mimo tyto podmínky se obnovuje po 5 minutách. Pro dvouúčtovou skupinu tím
samotný preparation preflight v klidu klesá přibližně z 1 080 na 60 REST
čtení za hodinu. Explicitní ON dál chybějící/stará data načte okamžitě.
Regrese ověřují aktivní okno, pětiminutový idle interval, zájem LIVE klienta
a deduplikaci heartbeatů (`tests/copierWorkerArmPreparation.test.ts`).

- **Kde:** `ARM_PREPARATION_REFRESH_MS = 20_000` (ř. 1659),
  `scheduleArmPreparation` (ř. 8217) volaný z každého heartbeatu (ř. 11182),
  zapnuto `startArmPreparation()` při startu agenta
  (`localCopierExecutionAgent.ts` ř. 1088).
- **Naměřeno (produkční worker, 4. 10. odpoledne, DISARMED, víkend):**
  `connectionUsage` pro Tradeify login `53157614…` = **18 REST/min,
  180/hod. po ~10 min běhu** → ~1 080/hod. Limit v projektu
  `TRADOVATE_HOUR_LIMIT = 5_000` (`lib/tradovateUsageMeter.ts`), tj. **~22 %
  hodinového limitu trvale**, i v noci a o víkendu, kdy ON nikdo nepoužije.
  Je to stejný login, přes který worker kopíruje; k tomu se přičítá webová
  appka (server-side preflight/live-pnl, nově i čtení pozic na pozadí po
  30 s mimo LIVE).
- **Riziko:** menší rezerva na burst při skutečném obchodování / recovery;
  při 429 penalizace dopadne i na execution čtení.
- **Návrh:** obnovovat často jen tehdy, když dává smysl rychlé ON, např.:
  - uvnitř obchodního okna skupiny (`tradingWindow`) nebo
  - když klient nedávno četl status (LIVE otevřené: lokální `/v1/status`
    nebo relay status v posledních ~60 s),
  - jinak interval řádově minuty (nebo jen invalidace + čtení až při ON —
    cesta „ověření chybí → ON si ho dočte“ už existuje).
  Hodnoty podle uvážení; cílem je, aby klidový worker nebral ~22 % limitu.
- **Hotovo, když:** v klidu (DISARMED, LIVE zavřené, mimo okno) klesne
  `connectionUsage.rest.hour` výrazně (řádově desítky/hod.), a s otevřeným
  LIVE v okně je ON dál připravené. Test na interval/gating.

### 2. [P3] Restart workeru zapomene, že incident potřebuje ruční kontrolu

**Stav 2026-10-04: opraveno.** Ne-transportní fail-closed incident ukládá do
durable safety snapshotu `manualRecoveryRequired` s časem a důvodem. Bootstrap
marker obnoví jako incident a background přípravu ponechá blokovanou. Marker
odstraní až autoritativně čistý výsledek veřejné ruční `reconcile()`; automatické
preflighty ani reconnect jej nemažou. Regrese pokrývá incident → restart →
`blocked/manualRecoveryRequired` → čistá ruční kontrola → `ready`.

- **Kde:** `armPreparationIncidentRequiresRecovery` je jen v paměti
  (ř. 1671, nastavení ř. 3941); `lastError` se při bootstrapu neobnovuje
  z durable stavu (ř. 1445 — jen startup repair / missing leader route).
- **Scénář:** incident (např. divergence, která se mezitím srovnala na flat)
  → restart workeru (launchd, update, pád) → příznak i `lastError` zmizí →
  příprava na pozadí najde flat účty → `ready` → ON bez ruční kontroly.
- **Dopad:** není horší než před změnou (stará ON cesta incident mazala
  sama), ale nový slib „incident nesmaže ON, příprava ani reconnect“
  restart nepřežije. Durable brány (stuck outbox, unconfirmed flat lots,
  processor recovery) dál platí.
- **Návrh:** uložit příznak „vyžaduje ruční Kontrolu pozic“ (+ stručný důvod)
  do durable safety stavu runtime a obnovit ho při bootstrapu; mazat jen
  čistým výsledkem veřejného `reconcile()`.
- **Hotovo, když:** test „incident → restart controlleru → příprava zůstane
  `blocked` s manualRecoveryRequired, dokud neproběhne ruční kontrola“.

### 3. [P3] Panel „Zkontrolovat pozice“ se ukazuje i u překážek, které kontrola nevyřeší

**Stav 2026-10-04: opraveno.** `armPreparation` nově publikuje strukturované
`blockedBy` (`incident`, `kill-switch`, `starting`, `recovery`, `configuration`,
`shutdown`) a `manualRecoveryRequired` je pravda jen pro incident. UI panel
se řídí kategorií incidentu (s legacy fallbackem pro starší worker), takže
kill switch, start a recovery tlačítko ani panel nevloží. Render testy pokrývají
všechny tři negativní případy i pozitivní incident.

- **Kde:** `manualRecoveryRequired: armPreparationBlocker() != null`
  (ř. 14802); UI `needsCheck = !armed && (preparation?.manualRecoveryRequired …)`
  (`LiveCopyTradeOverview.tsx` ř. 4311).
- **Problém:** `armPreparationBlocker` vrací i stavy, kde tlačítko Kontrola
  pozic nepomůže nebo jsou přechodné: kill switch aktivní, worker se
  ukončuje, „Durable stav workeru není připravený“ (start), obnova
  otevřených kopií / management-only, `readOnlyRecoveryBlocker()`. Panel pak
  nabízí nesmyslnou akci a přechodné stavy při startu ho mohou krátce
  vložit a zase odebrat (probliknutí, proti cíli „příprava neposouvá UI“).
- **Návrh:** rozlišit v statusu `manualRecoveryRequired` (jen incident /
  `lastError` / `armPreparationIncidentRequiresRecovery`) od ostatních
  blokátorů (`reason` s kategorií, např. `blockedBy: 'incident' | 'kill-switch'
  | 'starting' | 'recovery' | …`). Panel s tlačítkem jen pro `incident`;
  ostatní důvody jen jako text u přepínače (bez vkládání panelu), přechodné
  při startu vůbec.
- **Hotovo, když:** render testy: kill switch / start / recovery → bez
  tlačítka Kontrola pozic; incident → s tlačítkem.

## Neověřeno / mimo review

- Skutečné zrychlení ON (od kliknutí po durable potvrzení) — nikdo
  neměřil; změří se při nejbližším reálném zapnutí (Filip zapíná, Claude
  měří).
- Chování na iPhonu přes relay (instalováno 4. 10., `bd02de39`).
