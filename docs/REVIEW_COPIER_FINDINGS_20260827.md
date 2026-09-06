# Review copieru — nálezy (27. 8. 2026, Claude)

Rozsah: commity `de93fd3a` → `cf316f37` na `origin/main` (incident fixy z 27. 8.),
provedeno čtyřmi paralelními hloubkovými průchody + vlastní verifikací klíčových
tvrzení. Read-only: žádný ARM, Flatten, brokerový příkaz, deploy ani reinstalace.

## Ověřovací baseline (vše čisté)

- Plný test suite: **1566/1566** (194 souborů), cílené copier testy 77/77.
- `npx tsc --noEmit`: bez chyb.
- Klasifikace order stavů: `toOrderStatus` default → `pending` (unknown stav
  guardy tiše nevypíná); klient (`liveOrderIsOpenForSafety`) a worker
  (`isOpenOrderStatus`) klasifikují neterminální stavy konzistentně.
- Kill switch zůstává jednosměrná západka (žádná cesta ho v session neresetuje).

## Korekce původní hypotézy

Původní podezření „úspěšná reconciliation potichu překlopí živý ARM do shadow
a followeři přestanou kopírovat" **neplatí**: `performReconciliation` vždy
nastaví `armed: false` (řádek 2524, existuje od 17. 8., commit `82e4f4ee3`),
takže dispatch se zastaví přes `!armed` — bezpečnější směr, ne tichý shadow.
Nové `gate = { ...gate, shadowMode: true }` (řádek 2530) je vůči současným
konzumentům **mrtvý kód** (všichni testují `armed` dřív). Vedlejší důsledek:
komentář u resyncu (řádky ~1772–1777, „ARM pokračuje a uživatel nic nepozná")
**neodpovídá skutečnosti** — po každém plánovaném resyncu session skončí
DISARMED, a ve flat větvi bez jakéhokoli audit záznamu.

## Nálezy podle závažnosti

### 🔴 CRITICAL — C3: reconciliation může smazat důvod kill switche + chybí vzájemná výluka

`performReconciliation` po čisté kontrole **bezpodmínečně** provede
`lastError = null` (řádek 2529, přidáno v `cf316f37`). `engageKillSwitch()`
nastavuje `lastError` synchronně mimo `eventTail`; pokud kill switch přijde
uprostřed běžící reconciliace (recovery po terminal fillu, ruční `reconcile()`,
connection recovery), doběhnuvší „clean" výsledek přepíše `lastError` na `null`.
Kill switch západka drží, ale **jediné pole nesoucí jeho důvod ve `status()`
zmizí**. Zároveň tři volací body `performReconciliation` (`reconcile()` API,
`runConnectionRecovery`, nová recovery větev ve `scheduleAutoClose`) nesdílí
žádný zámek — starší souběžný běh může přepsat čerstvější
`positionCheckComplete`/`positionsByAccount` a pustit ARM dřív, než by měl.

Fix: `if (!gate.killSwitch) lastError = null;` (killSwitch má přednost) +
sdílený `reconciliationInFlight`/generation counter přes všechny tři volací
body. Regrese: killSwitch uprostřed reconciliace → `lastError` zůstává.

### 🟠 HIGH — A/C4: automatické `lastError = null` umlčuje incidentní notifikace

Před `cf316f37` se `lastError` nulovalo jen explicitní uživatelskou akcí.
Teď ho maže **každá** úspěšná reconciliation — včetně rutinního resyncu
socketu. Push notifikace „Copier: bezpečné zastavení"
(`nativeCopierNotificationPlan.ts:152–157`) je hranová
(`null → non-null`, poll ~2 s) a server watchdog
(`copierIncidentWatchdog.ts:297–310`) úrovňový — oba mohou reálný fail-closed
incident **propásnout**, pokud nesouvisející čistá reconciliation `lastError`
smaže dřív, než ho stihnou přečíst. Vlastní nové testy commitu (`lastError:
null` po recovery) tuto sémantiku fixují, patrně bez vědomí dopadu na
notifikační hranu.

Fix: nulovat `lastError` jen v konkrétní zotavovací větvi
(`reconcileAfterTerminalFill`), ideálně jen pokud patří k právě řešené
epizodě — ne plošně v `performReconciliation`.

### 🟠 HIGH — D.2: mezera v detekci cizího navýšení pozice (`6d0caefb`)

Guard cizí inflace nyní běží jen pro `working/pending` — pro
`filled/canceled/rejected` **nikdy** (podmínka nezná kontext reconnectu, platí
plošně). Position větve kryjí jen: follower → flat, a vstup z nuly / obrat
znaménka **při flat leaderovi**. Nekrytý případ: follower drží legitimní
pozici (např. 2), cizí/venue fill ji navýší same-sign (na 5), leader je
v pozici (ne flat) → nic to nedetekuje až do příští reconciliace, která
**není periodická** (běží jen po reconnectu/resyncu, ručně, nebo v terminal-fill
recovery). V klidné připojené session může expoziční drift žít libovolně dlouho.
Tvrzení komentáře „dopad fillu chytí fill/position větev" není pokryté žádným
testem.

Fix: doplnit same-sign magnitude kontrolu (follower vs. `leader × multiplier`)
do position/fill větve, a/nebo periodickou reconciliaci při
`armed && connected`. Regrese: leader v pozici, follower správně zkopírovaný,
`filled` event s `quantity > asserted` bez reconnectu → musí vzniknout
divergence/lastError, ne ticho.

### 🟠 HIGH — B3: DISARMED runtime ztratil eskalaci (`cf316f37`)

Nové `if (gate.armed)` guardy (lone-leg OSO ~1695, incomplete-bracket ~2106,
OSO observation ~2173) znamenají, že v DISARMED se `failClosed` nezavolá —
jen audit `blocked`. Tím: (a) nikdy nenastane hrana `lastError null→non-null`
→ **push notifikace se neodešle**, i když follower drží reálnou pozici
z dřívějška (legitimní stav po ručním DISARM „drž pozice"); (b) nevynutí se
`positionCheckComplete = false`, takže pozdější ARM neprojde re-kontrolou,
kterou anomálie dřív implicitně vynucovala. Úklid interního stavu (correlatory,
timery, `settleOsoFlush`) je v pořádku — probíhá bezpodmínečně.

Fix: guard zachovat pro potlačení falešného *incidentu*, ale zachovat
viditelnost (nastavit `lastError`/`onError`, nebo dedikovaný „silent incident"
kanál) a `positionCheckComplete = false`.

### 🟠 HIGH — C2: selhání auto-flatten se nepropaguje do recovery

`autoFlattenCopies` chyby polyká (volá `failClosed`, ale nethrowuje), takže
recovery blok ve `scheduleAutoClose` běží i po neúspěšném zavření. Ve
scénáři, kdy flatten selže a leader náhodou drží pozici ve shodném poměru se
zbylou follower pozicí, vyjde reconciliation „clean" → audit `recovered` +
smazání `lastError`, přestože auto-close selhal. Úzký, ale mechanismus ověřený.

Fix: recovery blok spouštět jen po prokazatelně úspěšném flatten (návratová
hodnota), nikdy nemazat `lastError` po mezitímním dalším fail-closed.

### 🟡 MEDIUM — C1: recovery flag rozhoduje jen první critical item v dávce

`failClosedOnCriticalAudit` bere `entries.find(...)`; dávka s bezpečným
modify-filled na indexu 0 a `unknown` na jiném účtu na indexu 1 spustí
optimistický recovery flow s matoucím audit textem. Backstopem je autoritativní
reconciliation, ale rozhodovací logika je vůči vícepoložkovým dávkám nekorektní.
Fix: `filter(...).every(...)` přes všechny critical items.

### 🟡 MEDIUM — E.3: ESM `.js` fix je bodový, ne systémový

`server/localCopierExecutionAgent.ts:9` a `server/macCopierDevice.ts:12` mají
stále extensionless relativní importy — dnes je spouští jen `tsx`, ale VPS plán
(`COPIER_VPS_PLAN.md`) je přesune do čistého Node ESM, kde spadnou stejně jako
`tradovateLivePnl` před fixem. Test hlídá jen jeden string v jednom souboru.
Fix: opravit oba importy + glob test/lint pravidlo přes `server/**`.

### 🟡 LOW / Consider

- `gate.shadowMode = true` v `performReconciliation` (řádek 2530) — mrtvý kód;
  smazat, nebo okomentovat jako defenzivní „at rest" default (a nenastavovat
  při killSwitch, ať UI neukazuje SHADOW u trvale zabitého runtime).
- Zavádějící komentář u resyncu (~1772–1777) — opravit dle skutečného chování;
  flat větev connection recovery doplnit o audit záznam (dnes DISARM bez stopy).
- Pre-existing: `armExpiryFlatten: 'off'` blokuje i post-resync reconciliaci
  (guard v `runConnectionRecovery` řídí víc, než má); `awaitingPair` Set
  v `CopierBracketCorrelator` pomalu roste (leak do restartu); mrtvý kód
  `components/LiveDesk.tsx` + `services/tradecopiaLiveService.ts` s nesprávnou
  definicí `working` — smazat nebo sjednotit.
- Chybějící testy: `canceled/rejected` replay po reconnectu; replay orderu
  s unresolved cancel-outbox entry; resync za živého ARM (a/b/c scénáře);
  DISARM-notifikační hrana.

## Procesní poznámky

- `cf316f37` nemá zápis v PROJECT_LOG (pravidlo č. 2) — doplněn zápisem o tomto
  review.
- Mac worker běží ze stromu `de93fd3a` → opravy `79bc09ff`/`6d0caefb`/`cf316f37`
  v něm nejsou; falešné fail-closed incidenty po reconnectu budou pokračovat do
  reinstalace (obchodní den → čeká na explicitní „nasaď", ale nová zjištění
  výše doporučuji opravit PŘED další reinstalací a LIVE ARM).

## Konkurenční srovnání (souhrn; plný průzkum v příloze konverzace)

- **Nikdo z konkurence nemá fail-closed + DISARMED default.** Typický failure
  mode kategorie je tichý výpadek objevený až po škodě: PickMyTrade 3 h
  nekopíroval → breach 3×$50k účtů (Trustpilot); Tradecopia — uživatel netušil,
  že je vše odpojené; TradeSyncer — nevyplněné SL ve volatilitě, ztracené
  funded účty (Reddit).
- **Durable outbox / no-blind-retry nemá nikdo** — Replikanto (FlowBots KB)
  oficiálně přiznává, že trade při výpadku propadne bez retry i kompenzace.
- **Bracket (SL/TP) sync na Tradovate je slabina celé kategorie**: Tradovate
  nativní Group Trading kopíruje jen market ordery bez bracketů a nejde ovládat
  z mobilu; Duplikium na netting účtech SL/TP reálně nedá; PickMyTrade má
  doložené nekonzistentní brackety. Naše OCO/OSO synchronizace je reálný
  diferenciátor.
- **Architektonicky nejbližší** je CrossTrade (cloud OAuth exekuce, desync
  detekce à 3 s, P&L brány → flatten+lock, $49/měs) — ale jeho auto-sync
  „opravuje divergenci obchodem", což náš model záměrně nedělá (a je to
  správně: auto-korekce ve volatilitě přidává neplánovanou exekuci).
- **Co konkurence umí navíc a stojí za úvahu**: cross-instrument konverze
  ES↔MES (Replikanto, TradeSyncer), bohatší sizing metody (Net Liq, % change,
  pre-alokace), per-account risk brány jako produkt (max daily loss / trailing
  drawdown → flatten+lock, EOD auto-flatten), compliance mode schválený prop
  firmami.
- **Pravidla prop firem (2026)**: Tradeify max 5 vlastních funded účtů /
  $750k, externí copiery „allowed but unsupported"; Lucid third-party copiery
  explicitně povoluje v ToS (ne HFT), max 5 / $750k; Apex nejpermisivnější
  (20 účtů, zákaz cross-account hedge); univerzálně: jen vlastní účty, cizí
  signály = ban. → Otevřená otázka „písemné potvrzení pravidel obou firem"
  z PROJECT_LOG má u Lucidu oporu v ToS; u Tradeify je opora slabší
  („unsupported") — písemné potvrzení stále doporučuji.

## Dodatek — kalibrace po nezávislé oponentuře (27. 8. večer)

Druhé read-only review (Opus) potvrdilo všechny faktické nálezy a upřesnilo
závažnosti i návrh oprav. Přijaté korekce:

- **C3 rozděleno na dvě položky.** Samotné smazání důvodu kill switche je
  vážná observability/auditní chyba, ne CRITICAL — západka `killSwitch: true`
  drží a ARM je blokovaný. CRITICAL zůstává jen **race souběžných
  reconciliací**: starší „čistý" běh může přepsat novější špinavý stav
  (`positionCheckComplete=true`, prázdné `divergentAccounts`) a pustit ARM nad
  reálně divergentním stavem. Vyžaduje samostatný deterministický race test
  („starší clean reconciliation doběhne po novějším incidentu").
- **D.2 je největší přímá expoziční mezera** — potvrzeno. Oprava ale nesmí být
  prosté „při každém nesouladu ihned fail-closed": při legitimním scale-inu
  mohou leader/follower eventy přijít v jiném pořadí. Správný tvar: kauzální
  okno + potvrzení broker snapshotem + kontrola proti konkrétní očekávané
  expozici (`leader × multiplier`); periodická reconciliation jen jako
  backstop, ne jediná oprava.
- **B3 zúženo.** Incidentní push na každý neúplný bracket během běžného
  DISARMED obchodování leadera by vrátil falešné poplachy, které guardy
  řešily. Minimální správná reakce: zneplatnit `positionCheckComplete`,
  vyžádat novou reconciliaci, viditelný audit, a eskalovat nahlas jen když
  follower drží reálnou spravovanou expozici.
- **C2 je povinná oprava před dalším LIVE pokusem** (recovery nesmí po
  neúspěšném auto-flattenu publikovat `recovered`).
- **Návrh opravy pro C3 + A/C4 + část C2 sjednocen:** lokální podmínka
  `if (!gate.killSwitch) lastError = null` nestačí (starší reconciliation
  pořád může smazat novější ne-killswitch chybu). Cílový model: monotónní
  `incidentGeneration`, jediný sdílený in-flight běh reconciliace (nebo
  generation counter), mazání pouze chyby té epizody, kvůli které recovery
  začala, a oddělení „aktuální blokující stav" od durable historie incidentů.
- **Green 1566/1566 není důkaz bezpečnosti interleavingů** — chybějící
  deterministické race testy jsou součástí definice hotovo.
- Konkurenční/prop-firm sekce je informativní podklad (zdroje v konverzaci,
  časově proměnlivé) — pro go/no-go rozhodnutí o ARM není potřebná.

**Go/no-go (shoda obou review): DEMO/LIVE ARM teď no-go.** Pořadí před
reinstalací workeru: (1) reconciliation/incident generation model,
(2) propagace výsledku auto-flattenu, (3) D.2, (4) invalidace preflightu
v DISARMED; pak deterministické race testy; teprve potom řízený minimální
DEMO test.

## Doporučené pořadí dalších kroků

1. Fix C3 (killSwitch vs. `lastError`, výluka reconciliací) + A/C4 (scope
   `lastError = null`) — malé, chirurgické změny v `copierRuntimeController.ts`.
2. Fix D.2 (same-sign magnitude kontrola / periodická reconciliace) — největší
   reálná expoziční mezera.
3. B3 (viditelnost DISARMED anomálií) a C2 (propagace výsledku auto-flatten).
4. Doplnit chybějící regrese (seznam výše), opravit komentář u resyncu.
5. Teprve potom: schválený push, reinstalace workeru ze stejného commitu,
   řízený DEMO test dle zavedeného postupu.

## Ověření oprav (27. 8. večer, Claude — read-only review necommitnutého diffu)

Implementace (13 souborů, +737/−660) pokrývá všechny nálezy obou review kol.
Nezávisle ověřeno: plný suite **1579/1579** (195 souborů), `tsc --noEmit`
čistý. Mapování oprav na nálezy:

- C3 → `safetyGeneration` + `invalidateReconciliation()` + serializace přes
  `reconciliationTail`; čistý výsledek se potvrdí jen při nezměněné generaci
  (kontrola i po `acknowledge` awaitu); `lastError` smí smazat jen explicitní
  `reconcile({ clearLastError: true })` a jen bez killSwitch a bez mezitímní
  invalidace. Deterministické race testy existují („kill switch uprostřed
  čisté reconciliation", „serializuje všechny call-sites").
- A/C4 → automatické reconnect/terminal-fill kontroly `lastError` nemažou.
- C2 → `autoFlattenCopies` vrací úspěch; recovery běží jen po prokazatelném
  flat (regrese „po selhání auto-flattenu nikdy nespustí recovered").
- D.2 → `scheduleFollowerMagnitudeCheck` s kauzálním oknem (2 s) + čerstvý
  broker snapshot obou stran + `expected = trunc(leader × multiplier)`;
  fail-closed s `autoClose: false` (divergence se neopravuje obchodem);
  regrese včetně scale-in orderingu bez falešného poplachu.
- C1 → `criticalAuditAllowsTerminalFillRecovery` vyžaduje modify-abandoned-
  filled pro KAŽDOU critical položku dávky.
- B3 → DISARMED anomálie volají `invalidateReconciliation()` a mají vlastní
  hranovou notifikaci „Copier: nutná kontrola" (bez falešného FAIL-CLOSED).
- Vedlejší: `armExpiryFlatten: off` už nevypíná read-only reconnect kontrolu;
  `abandonPendingPair` řeší únik correlatoru; komentář u resyncu opraven +
  audit záznam pro flat recovery větev; mrtvé `shadowMode: true` odstraněno;
  všechny `server/` importy mají `.js` + globální test; smazán `LiveDesk.tsx`.

Zbytková pozorování (LOW, neblokují):
1. Zastaralý běh reconciliace pořád bezpodmínečně přepisuje
   `gate.divergentAccounts` starším snapshotem; `positionCheckComplete`
   zůstane false (LIVE ARM blokován), ale SHADOW ARM tuto podmínku nemá —
   zvážit gate-write až po kontrole generace.
2. Notifikace „nutná kontrola" se hranově spustí i po benigních invalidacích
   (úprava skupiny, ruční flatten) — sledovat šum v praxi.
3. ESM test hlídá jen statické `from` importy, ne dynamické `import()`.

Go/no-go: opravy splňují podmínky obou review. Další krok podle politiky:
explicitní schválení pushe, reinstall workeru ze stejného commitu, řízený
minimální DEMO test.
