# Dokupování do otevřené pozice z grafu — návrh v5 = implementace (3. 11. 2026)

Filip 2. 11.: „je uděláno dokupování do pozic, nebo když jsem v pozici, tak další limit?“ → „určitě ano“.
Historie: v1 (copier-design-critic OPRAVIT, 7× P1) → v2 (OK s výhradami, N1–N8) → v3 (commit 9de520ae na
větvi claude/phone-live-data-20261102) → v4 (Filipova rozhodnutí 3. 11. + fáze 0) → critic v4 **OPRAVIT**
(7× P1, 12× P2, žádný nový návrh) → **v5** = tento dokument; popisuje, co je postavené ve větvi
`claude/scale-in-20261103`. Odkazy P1-x / P2-x = oponentura v4.

## 1. Rozhodnutí (Filip 3. 11.)

1. Varianta B (každé přikoupení vlastní nativní OSO se SL/TP = společné SL/TP pozice), jen manual-only
   local-only DEMO skupina bez followerů s instalačním opt-inem `--scale-in on`.
2. „Ať je to neomezeně“: žádný zvláštní limit přikoupení (žádný čítač na epizodu). Drží strop účtu
   `manualEntryMaxContracts` na **celou pozici** (|net| + zbytek čekajících + nové ≤ strop) a denní pravidla.
   Výjimka z oponentury (P1-3 var. A): **čekající přikoupení Limit/Stop jen po 1 kontraktu**, Market i víc —
   dílčí fill OSO s qty > 1 u Tradovate neověřený (nohy Suspended, broker mění qty).
3. Přikoupení i správa celé pozice v jednom nasazení.
4. Riziko lístku `max(0, směr·(VWAP fillů lístku − SL)) × zbývající qty jeho SL nohy`; SL za BE = 0,
   zamčený zisk jednoho lístku nesnižuje riziko jiného (P1-2 — ne smíšený průměr lotu).
5. Fáze 0 bez Filipa (provedena 3. 11. 07:27).
6. Migrace admission: **není potřeba** (§6); souhlas zůstává pro případnou fázi 2.

## 2. Fáze 0 — DEMO8661118, MNQZ6 (`scripts/copier/record-scale-in.ts`)

Záznam mimo repo `recordings/leader-scale-in-2026-11-03T06-27-29-543Z.json`, fixture
`tests/fixtures/tradovate-leader-scale-in.json`; broker −10,50 USD + poplatky, konec flat bez příkazů.
- Druhý `placeoso` (Market) na otevřené pozici: dvě nezávislé OCO (SL↔TP každého OSO), qty nohou = qty lístku;
  SL má `parentId`, **TP `parentId` nemá** (jen `ocoId`).
- Souběžný `modifyorder` 2× SL a 2× TP: všechny `stream-replaced` za 152–165 ms.
- Čekající přikoupení (Limit): vstup Working, nohy Suspended.
- `liquidateposition` zruší všechny příkazy kontraktu včetně čekajícího přikoupení a jeho nohou (< 500 ms).
- Fáze 0b (3. 11. 08:39, `--scenario five`, záznam `leader-scale-in-2026-11-03T07-39-25-027Z.json`):
  základ 1 + Market přikoupení **2**, 1, 1 → pozice 5 ve 4 lístcích; nohy přikoupení po 2 mají qty 2 a fill
  přišel celý najednou; souběžný modify **4× SL** (174–176 ms) a **4× TP** (164–170 ms), vše `stream-replaced`;
  liquidate zavřel 5 a zrušil všech 8 nohou; broker ≈ −29 USD + poplatky, konec flat bez příkazů.
- NEOVĚŘENO: výchozí TIF (`orderVersion` ho nenese), dílčí fill OSO q > 1 (Limit/Stop proto jen po 1).

## 3. Přikoupení (worker)

- **Záměr s pozicí** (`lib/leaderEntryPreview.ts`): `position: { mode: 'add', side, quantity, ticketEntryIds }`;
  holé přikoupení (bez SL/TP) neprojde validací. Bez `position` = vstup jen z flat (`account-not-flat` beze
  změny, i pro followery a běžné skupiny).
- **Brána** `scaleInAddBlockers` (`services/manualScaleIn.ts`), fakta sbírá `scaleInGate` z paměti (bez IO):
  zapnuto; pozice ověřená (≠ null), ≠ 0, na straně přikoupení; záměr = čerstvý stav (|net|, lístky); žádné
  čekající přikoupení; vstupy lístků plně vyplněné **podle fillů** (ne podle stavu — Cancel+Completed
  s cumQty < qty není plný fill); Σ vyplněného = |net|; krytí = |net| jen nohami `working`, bez dílčího fillu,
  potvrzenými streamem (ne z ACK); jedna cena SL i TP; SL/TP přikoupení = SL/TP pozice; žádný cizí příkaz;
  nic na jiném symbolu; deník (lot) = net; jediná nedokončená epocha = `open` na symbolu se stejným net;
  neběží správa pozice; strop celé pozice; Limit/Stop qty 1.
- **Klid skupiny**: u přikoupení nevadí jen epocha právě tohoto obchodu; `working-orders` nahrazuje přesná
  kontrola cizích příkazů; OSO korelace, ticho 5 s, outbox a recovery dál blokují.
- **Riziko** (`evaluateManualEntryPreview`): ztráta přikoupení + riziko stávající pozice po lístcích; rezerva
  **bez otevřeného P&L** (`realizedLossHeadroom`, P1-1), DD z equity bez otevřeného P&L; risk snímek novější
  než poslední fill leadera.
- **Odeslání**: durable `sending` (s `scaleIn`, `baseEpisodeId`), pak **synchronně z paměti těsně před POSTem
  znovu celá brána a strop** (nikdy REST, N1) + kontrola epizody.
- **Nohy podle id z ACK** (`ownManualLegOrderIds`, jen nativní OSO, ne OCO k holému Marketu): TP bez `parentId`
  se nebere jako samostatná redukce (jinak Limit přikoupení skončí „ochranné nohy nedorazily“ — mutačně ověřeno).

## 4. Čekající přikoupení — stavová podmínka

`pendingAddViolation` + `reviewPendingScaleIns` (po kroku každého eventu přes `setTimeout(0)` a 1s časovačem,
nikdy `await` v `eventTail`): zruší se jedním cíleným zrušením (raw broker, i za DISARMED a kill — výjimka
INV-BRAKE-02) při: vypnuté kopírce/shadow, kill, day locku (i čekajícím), pauze, management-only, nezpůsobilém
leaderovi, konci okna (i do 5 min), konci session do 5 min, vypršení ARM do 5 min, flat nebo opačné pozici.
Neznámá pozice (chybějící cache) nic neruší. Zrušení nebo vypršení brokerem = normální konec.
Market přikoupení se nehlídá (vyplní se hned, zrušit nejde). **Selhané zrušení = incident** (`failClosed`;
konzervativně i když se příkaz mezitím vyplnil), přikoupení s neznámým výsledkem POSTu = incident (DISARM;
pozdní ACK za vypnuté kopírky ho cíleně zruší) a restart během odesílání přikoupení = trvalý incident
— oponentura diffu P2-1 a kolo 2. Fill přikoupení v jiné epizodě deníku než základ = incident (`failClosed`, bez
auto-close, durable jednou).

## 5. Správa celé pozice (`scope: 'position'`)

- Příkaz `manage-leader-order` s `entryOperationId` = nejstarší lístek pozice a `scope: 'position'`;
  akce `move-stop` / `move-target` (i BE) / `close-position`. Zrušení čekajícího přikoupení = běžné
  `cancel-entry` jeho lístku (s jeho qty).
- Starý tvar příkazu (jeden lístek, např. nepřestavěný iPhone) na pozici s víc lístky = `position-multi`
  (P1-5); nevyřešená změna pozice blokuje i starý tvar.
- Mutex ve workeru: jedna změna pozice najednou (zavření nečeká); nevyřešená noha pozice blokuje další posun.
- Ve frontě: předčtení ze snímku streamu adaptéru (jinak ohraničený REST), `positionManageBlockers`
  (pozice ověřená, lístky, žádný cizí příkaz; pro posun navíc: žádné čekající přikoupení ani nevyřešený
  vstup, vstupy plně vyplněné, nohy `working` bez dílčího fillu a potvrzené, krytí = |net|, **jedna cena** —
  rozjeté nohy jen zavřít / Tradovate, P2-6), TP jen dál od trhu, utažení SL pod TP a ≥ 8 ticků od IBKR,
  posun SL dál od trhu = riziko celé pozice po lístcích s rezervou bez otevřeného P&L. Pak **všechny nohy
  durable `sending` jedním zápisem**.
- Mimo frontu: jedna synchronní kontrola (lhůta, fence, generace, dosah, route epoch, tvar každé nohy z cache)
  a hned N× `modifyOrder` bez čekání mezi nohama; každá noha posílá **přesně qty potvrzené streamem** (P1-6).
  Výsledek po nohách: potvrzeno adaptérem = OK, definitivně odmítnuto = `rejected`, jinak `unknown` + dořešení
  streamem / čtením; souhrn `acknowledged` / `rejected` / `blocked` / `unknown` („potvrzeno u x z y“).
  Restart: `sending` nohy → `unknown` (INV-OUTBOX-02, P1-4). Nikdy opakování.
- Zavření celé pozice = `liquidate` (zruší i čekající přikoupení), ověření stavem u brokera (`executeClose`).
- **Nadkrytí** (Σ zbytků vlastních SL nebo TP > |net|, trvá 5 s bez rozpracovaných eventů) = incident (P2-8),
  i za DISARMED (vědomě: SL by prodal víc, než je pozice → otočení bez ochrany). Počítají se jen nohy lístků
  s fillem vstupu, každá nejvýš do vyplněného qty lístku — Suspended nohy čekajícího vstupu ne (diff P1-A:
  jinak by každý čekající Limit po 5 s vyhlásil falešný incident).
- Zavření celé pozice jen když otevřená expozice lístků (fill vstupu − filly nohou) = |net|; kontrakty
  přikoupené mimo appku = Flatten (diff P2-3). Výsledek s mezitím skončenou nohou = `unknown`, ne úspěch (P2-8).
- Vědomě ponecháno: nevyřešená změna na symbolu blokuje další správu, dokud se nedořeší / waiver (diff P2-6,
  fail-closed); mutex jen v procesu (INV-WORKER-02).
- Ořez `MANUAL_ENTRY_KEEP` nikdy neodstraní lístek s živým vstupem nebo nohou (P2-7).

## 6. Relay a admission (bez migrace)

Příkazy správy celé pozice nesou `entryOperationId` nejstaršího lístku → atomická admission je přijme
beze změny a busy klíč je pro PC i telefon stejný (oba berou lístek ze statusu workeru). Přikoupení
(`place-leader-entry`) a správa nemají společný busy v relayi (P2-2) — souběh zastaví worker (brána
`manageBusy`, mutex). P2-3 (busy blokuje zavření v relayi) platí stejně jako dnes u jednoho lístku; Flatten zůstává.

## 7. UI

- Status workeru `leaderPositions` (jen s přikoupením): pozice z lístků, společné SL/TP, VWAP (BE), čekající
  přikoupení, `canAdd` / `canManage` s důvodem (jen zobrazení). Capability `manual-entry-scale-in-v1`.
- PC panel i list telefonu: vstup se SL/TP na stranu pozice = přikoupení — převezme a zamkne SL/TP pozice,
  štítek „přikoupení · SL/TP pozice“, strop celé pozice, Limit/Stop jen 1, opačná strana blokovaná.
  Lišta telefonu (holý Market) v pozici dál blokovaná (`account-not-flat`).
- Čáry SL/TP pozice s víc lístky posouvají celou pozici; × u pozice zavře celou pozici; čekající přikoupení
  má vlastní čáru „PŘIKOUPENÍ … · čeká“ s × (dvoukrokově) = `cancel-entry` jeho lístku (PC i telefon).
- SL/TP se nikdy tiše nepřepíší (diff P1-B): přikoupení odejde jen když SL/TP návrhu = SL/TP pozice; jinak
  „Přikoupení musí mít SL a TP pozice“ a nic neodejde. Panel PC je k cenám pozice viditelně přitáhne, list
  telefonu je předvyplní.
- Staré klienty: pozice se dvěma lístky má ve `manageableLeaderTrades` dva řádky → starý UI správu nenabídne.

## 8. Dotčené invarianty

INV-MANUAL-01, INV-RISK-01/02, INV-OUTBOX-01/02/03, INV-RELAY-01, INV-FRESH-01/03, INV-ARM-01,
INV-BRAKE-02 (výjimka: zrušení čekajícího přikoupení i pod kill), INV-MODE-01, INV-PART-02, INV-TRAD-02/03,
INV-DEFAULT-02, INV-UI-01..04, INV-WORKER-02 (mutex pozice jen v procesu).

## 9. Testy

`tests/manualScaleIn.test.ts` (čistá logika), `tests/manualScaleInReplay.test.ts` (replay záznamu z DEMO přes
controller: Market i Limit přikoupení bez incidentu — směrování nohou mutačně ověřené; zastaralý záměr;
bez opt-inu; vypnutí kopírky a flat zruší čekající; správa celé pozice — posun obou SL, starý tvar,
odmítnutá noha, TP k trhu / utažení, rezerva bez otevřeného zisku — mutačně ověřené; zavření s čekajícím),
`tests/manualScaleInPreview.test.ts` (riziko v náhledu), `tests/liveScaleIn.test.ts` (UI).
Oponentura hotového diffu: kolo 1 OPRAVIT (P1-A, P1-B) → kolo 2 **OK S VÝHRADAMI**; nezávislá kontrola
workflow (UI / závody / testy) 18 potvrzených nálezů — zapracované.

## 10. Nasazení a zbývá

1. Web (relay + UI) push na main → reinstall workeru s `--scale-in on` (k dnešním flagům) → iPhone build
   (nový web uvnitř). Až po Filipově „nasaď“.
2. Po nasazení na DEMO z appky (s Filipem nebo sám): přikoupení z grafu PC i telefonu, BE celé pozice,
   × čekajícího přikoupení z grafu, posun čar celé pozice. (Broker strana 5 lístků ověřena fází 0b.)
3. Fáze 2 (followeři): `venueManagedProtectiveCoverage` předpokládá jednu nohu = |net| (P2-11), velikost
   kopie `trunc((N+q)×m) − trunc(N×m)`, INV-DIVERGENCE-01.
