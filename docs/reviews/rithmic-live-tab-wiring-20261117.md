# Rithmic v záložce LIVE — návrh zapojení (17. 11. 2026)

Stav: POSTAVENO podle v2 (níže), ověřeno ve vývojové appce 17. 11. Větev `claude/rithmic-20261116`, nic nenasazeno.
Oddíl „Návrh" a „Známé slabiny" je původní v1 — oponentura (critic i Codex) ji vrátila; platí „v2 po oponentuře".

## Cíl

Obchodní obrazovka (graf, lístek, čáry) napojená na místní proces
`scripts/rithmic/devTradeServer.ts` (jen systém „Rithmic Test") se má objevit v záložce LIVE jako
záložka „Graf" — tam, kde býval Tradovate graf. Dosud běží jen na zkušební stránce
`tests/qa/rithmic-screen.html`.

## Co se NEMĚNÍ

- `LIVE_CHART_ENABLED = false` a všechny řádky hlídané `tests/liveChartEnabled.test.ts` zůstávají
  doslova. Tradovate graf, lístek a alerty zůstávají vypnuté.
- Jádro kopírky, worker, relay, DB: žádná změna. Rithmic cesta nečte ani nepíše stav kopírky,
  nepoužívá `executeSafetyCommand`, `liveCommandLockRef`, outbox ani relay.
- Dashboard LIVE, OFF, Kill, Flatten All skupiny: beze změny a dál dosažitelné (INV-UI-02).

## Návrh

1. `lib/rithmicLocalLink.ts`
   - `rithmicLocalToken()`: čte `localStorage['at:rithmic:local-token']`; při načtení modulu
     jednorázově převezme `#rithmic-token=…` z adresy (hash se neposílá serveru) a hash smaže.
   - `rithmicLocalAvailable()`: token existuje && není nativní appka. Bez tokenu se v appce
     neobjeví nic (žádná záložka, žádné spojení).
   - Adresa je napevno `ws://127.0.0.1:3311` — appka se nikdy nepřipojí jinam.
2. `hooks/useRithmicLocalTrading.ts` — logika z `tests/qa/rithmic-screen.tsx` beze změny chování:
   spojení (nově s obnovou po 2 s, dokud je záložka Graf otevřená), stav `LocalExecState`, zdroj
   ceny a svíček, karty obchodů ze změn stavu, `onPlaceEntry`, `onManageEntry`, `ack`.
   Po ztrátě spojení: `available = false` → obrazovka sama zablokuje příkazy; rozpracovaný příkaz
   skončí „unknown" (žádné opakování, INV-OUTBOX-01 duchem).
3. `components/RithmicLiveChart.tsx` — vykreslí `LiveTradingScreenSlot` s `marketData`,
   `soloAccountLabel="Rithmic Test · <kontrakt>"`, `group={null}`, `disarm={null}`,
   `tabs`/`onNavigate` z desku (návrat na Dashboard funguje vždy). Bez tokenu/spojení ukáže
   prázdný stav s důvodem. Hlášky místní služby (blokace po incidentu + tlačítko „Potvrdit",
   poslední odmítnutí) jako karta vlevo dole (`toastExtras` přes novou volitelnou prop
   `extraToasts`).
4. `components/TradovateLiveDesk.tsx` — tři malé doplňky, žádný stávající řádek se nemění:
   - `const rithmicChartAvailable = !chartAvailable && !phoneChartAvailable && !narrow && rithmicLocalAvailable();`
   - do seznamu záložek samostatný řádek `...(rithmicChartAvailable ? [{ id: 'chart', label: 'Graf', … }] : [])`
     (hlídaný řádek Tradovate záložky zůstane); efekt „tab === 'chart' → overview" dostane
     `&& !rithmicChartAvailable`;
   - ve slotu grafu nová větev `: rithmicChartAvailable && tab === 'chart' ? <RithmicLiveChart …/>`
     v `ErrorBoundary` před větví telefonu.
   - `chartOpenRef`, rychlejší poll, `LiveReducePositionButton`, `cancelPending` zůstávají vázané
     jen na `chartAvailable` → Rithmic graf nezrychluje ani nemění čtení Tradovate.
5. `scripts/rithmic/devTradeServer.ts` — do allowlistu originů přidat `http://localhost:3000`
   a `http://127.0.0.1:3000` (dev appka). Produkční origin NE (až s rozhodnutím o nasazení).

## Dotčené invarianty

- INV-UI-01/03: obrazovka nic neautorizuje — každý příkaz ověřuje `LocalExec` v místním procesu
  (strop kusů, mřížka, drift, idempotence, blokace po incidentu). UI stav slouží jen k zobrazení.
- INV-UI-02: OFF/Kill/Flatten kopírky zůstávají kde jsou; Rithmic graf je nepřekrývá a nemění.
- INV-MANUAL-01, INV-OUTBOX-*: netýká se (jiný broker, jiná cesta), ale ducha držíme: žádný blind
  retry, „unknown" se neopakuje.
- INV-DEFAULT-02: bez tokenu a běžícího místního procesu je cesta vypnutá.

## Známé slabiny, ke kterým chci verdikt

A. **Vyrobený stav kopírky.** `LiveTradingScreen` nabízí × pozice jen při
   `copier.status.armed === true`. Zkušební stránka proto předává vyrobený objekt
   (`armed: true, connected: true…`). Návrh: objekt zůstane uzavřený v `RithmicLiveChart`
   (konstanta `SOLO_SCREEN_STATE`), nikdy se nepředá jinam; čip Kopírka je v solo režimu skrytý.
   Alternativa: explicitní prop `soloMode` v obrazovce a podmínky `armed` jí nahradit — větší
   zásah do sdílené obrazovky.
B. **Dva světy na jedné stránce.** Lišta `LiveSafetyControls` (Shift+F = Flatten skupiny
   Tradovate) je na stránce dál. V Rithmic grafu Shift+F zavře Tradovate skupinu, ne Rithmic
   pozici. Návrh: v Rithmic grafu ukázat u názvu účtu trvale „Rithmic Test" a v prázdném stavu
   i v nápovědě × napsat, že zavření je jen křížkem/panelem; klávesu neměnit.
C. **Kopírka ARMED + Rithmic graf současně.** Nezakazuji (jsou to oddělené účty a brokeři).
D. **Token v localStorage** originu appky (stejně jako dnes na zkušební stránce). Proces
   poslouchá jen na 127.0.0.1, kontroluje Origin + token, smí jen „Rithmic Test".
E. Karty obchodů se dál skládají v prohlížeči ze změn stavu (důvod zavření jen odhadem, bez P&L).

## v2 po oponentuře (17. 11.) — takhle je to postavené

Critic i Codex: „OPRAVIT PŘED STAVBOU" (10 nálezů). Co se změnilo proti v1:

1. **Žádný vyrobený stav kopírky.** Obrazovka má prop `solo { label, available }`; `copier`, `disarm`
   a `onDisarm` dostává SKUTEČNÉ ze desku. Incident kopírky, čip Worker, „Kopírka Tradovate" a
   tlačítko OFF jsou v Rithmic grafu vidět dál. × pozice a karty řídí `solo.available`; události
   kopírky se do Rithmic grafu nepromítají.
2. **Shift+F** v režimu jednoho účtu neotevře Flatten skupiny (jen karta s vysvětlením); hláška
   zámku a nápověda kláves Shift+F nenabízejí.
3. **Brána:** jen vývojová appka (`import.meta.env.DEV`) na `localhost`/`127.0.0.1`, ne nativní,
   s tokenem. Produkční build cestu nemá ani s tokenem. Místní proces nemá produkční origin.
4. **Pád:** `onCrash={noteChartCrash}` + vnější boundary → nouzová lišta jako u LIVE grafu.
   Paměť pádů je sdílená s Tradovate grafem vědomě (po pádu se LIVE otevře na přehledu).
5. **Alerty** jsou v režimu jednoho účtu vypnuté (tlačítko, dialogy, čáry, karty, zvuky).
6. **Kontrakt:** jiný než MNQ (krok 0,25, bod 2 USD) → prázdný stav s důvodem; vlastní rozvržení
   grafu `live-trading-rithmic`.
7. **Čerstvost:** místní proces posílá tep každou sekundu (`beat`, s příznakem spojení pro ceny);
   prohlížeč si čerstvost nevyrábí, po 4 s ticha je cena stará. Nový vstup chce živou cenu;
   zrušení, posun a zavření jen živé spojení příkazů (brzda nezávisí na ceně). Po výpadku je první
   stav výchozí, rozpracované příkazy končí „unknown" bez opakování.
8. `useDayChartData` se při cizím zdroji dat vypíná (`disabled`).
9. Hlídací testy: `tests/rithmicLiveTabWiring.test.ts`; dva stávající hlídací testy rozšířeny
   o výslovnou výjimku pro `hooks/useRithmicLocalTrading.ts`.
10. `RithmicLiveChart` je importován staticky (desk nesmí nic líně načítat — studený start).

Vědomě přijato: token v `localStorage` vývojové appky (jen Rithmic Test); karty obchodů se
skládají v prohlížeči ze změn stavu (důvod zavření odhadem, bez P&L); blokace po incidentu má
vedle karty zvláštní tlačítko „Potvrdit incident".
