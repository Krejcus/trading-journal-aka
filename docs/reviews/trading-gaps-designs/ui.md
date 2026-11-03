# Skupina „ui“: obchodování z LIVE grafu bez změny jádra kopírky (návrh, 3. 11. 2026)

Podklad: worktree `/Users/filipkrejca/alphatrade-worktrees/scale-in` (HEAD 7ae5c97b = origin/main), seznam mezer `docs/reviews/trading-gaps-20261103.md`, `docs/COPIER_INVARIANTS.md`, `docs/reviews/scale-in-design-20261102.md`, `docs/CHART_ORDER_ENTRY_PLAN.md`. Průzkum byl jen pro čtení: nic se neměnilo, nic se nespouštělo, k brokerovi ani do sítě nic nešlo.

## 0. Společná pravidla skupiny

- **Jádro kopírky se nemění.** Žádná položka nesahá do `copierRuntimeController`, `copierEngine`, `copierRunner`, `tradovateBroker`, admission relaye ani migrací kopírky. Příkazy jdou jen přes stávající callbacky desku:
  - `previewLeaderEntry` (`components/TradovateLiveDesk.tsx:900`),
  - `placeLeaderEntry` (`:929`),
  - `manageLeaderEntry` (`:1094`),
  - `attachBrackets` (`:1140`),
  - `runStaticSafetyAction` (`:1013`).

  Odtud vedou přes relay do workeru. Jedinou autoritou zůstávají brány workeru:
  - `executeManualEntry` (`services/copierRuntimeController.ts:3851`),
  - `prepareManualOrderAction` (`:5061`),
  - `preparePositionAction` (`:4804`),
  - `prepareAttachBrackets` (`:4595`),
  - `reviewPendingScaleIns` (`:3719`),
  - `emergencyFlatten` (`:8510`).
- **Nic zobrazovacího neautorizuje příkaz (INV-UI-01).** Každý nový spouštěč (klávesa, notifikace, žebřík, pole s číslem) jen vytvoří záměr uživatele: cenu a qty. „Co jsem viděl“ (`expect`) se dál bere z read modelu brokera nebo workeru. Worker vše ověří znovu.
- **Žádná zkratka neodešle vstup bez tlačítka v panelu nebo listu.** Platí pravidlo Filipa z 29. 10. („⚡ v live jen vyplní panel“). Jedinou výjimkou je telefonní lišta Koupit/Prodat (1. 11.).
- **Dvoukrokové potvrzení** používá existující vzor z `BacktestOrderLinesOverlay`: druhý klik nejdřív za 350 ms a nejpozději do 4 s. Klíč potvrzení nese akci i cenu (`cancelConfirmKey`, `components/BacktestOrderLinesOverlay.tsx:78`).
- **UI nabízí jen to, co worker inzeruje** (`lib/copierWorkerCapabilities.ts`). Platí dál: jen MNQ, jen Tradovate demo prostředí, TradingView jen pro zobrazení.
- **Oponentura (critic).** CLAUDE.md bod 4 vyžaduje `copier-design-critic` jen pro změny jádra. Přesto ho doporučuji na hotový diff U1, U4, U6 a U10, protože jde o nové spouštěče existujících příkazů. Precedent: telefonní odesílání šlo 2. 11. přes critic. U2, U3, U5, U7, U8 stačí kontrola UI a projití INV-UI checklistu.

### Nálezy z průzkumu (v dosahu skupiny)

- **N1 (opravit v U3).** Telefonní lišta Koupit/Prodat posílá skutečný Market i během přehrávání.
  - `LiveTradePill` je v `chartLayer` vykreslená bez podmínky `!replay` (`components/day/LivePhoneChart.tsx:410`).
  - `onSide` (`:150`) bere `quote` z živého kanálu ceny, který na přehrávání nezávisí.
  - Uživatel tak vidí historický graf a odešle živý Market.
- **N2 (pojistka v U3).** PC živý graf přehrávání nenabízí (`components/AlphaTradeChartWorkspace.tsx:3084` `!liveTradingChart`). `BacktestOrderLinesOverlay` (`:1074`) ale na `replay.phase` vůbec nezávisí.
- **N3 (řeší U10).** `LiveOrderTicket` dostává `onManageEntry` a `manageEntryAvgPrice` (props `:331–333`), ale nepoužívá je. Správa pozice z panelu na PC tedy neexistuje, jde jen přes čáry v grafu.

---

## U1: Klávesové zkratky na PC

**(1) Verdikt: STAVĚT** v rozsahu zadání.
- Nestaví se klávesa, která by sama odeslala vstup (obdoba „instant order“ v TradingView). Zakazuje to pravidlo Filipa z 29. 10. „žádná zkratka (⚡, klik v grafu, klávesa) nesmí odeslat příkaz bez potvrzení“.
- Nestaví se ani klávesa, která by Flatten rovnou provedla. Flatten přes klávesu jen otevře stávající potvrzovací dialog (INV-UI-02).

**(2) Chování na PC (LIVE → Graf).** Telefon bez klávesnice je mimo rozsah.

| Klávesa | Akce | Odesílá? |
|---|---|---|
| Shift+B / Shift+S | Nový návrh Koupit/Prodat a otevření panelu. Typ: Market, když worker umí Market a kotace je stará nejvýš 3 s; jinak Limit ±10 b jako `onNewDraft` (`LiveTradingScreen.tsx:644`). SL/TP z výchozí šablony (U8), jinak 12 b / 2R. V pozici na její stranu jde o přikoupení: panel sám převezme SL/TP pozice (`LiveOrderTicket.tsx:383–389`). | Ne, chová se jako ⚡ |
| Esc | Zahodí návrh, ale jen když kreslení v grafu nic nedělá. | Ne |
| Shift+E | BE. První stisk ukáže „BE 21 004.25? Shift+E znovu“ (4 s), druhý stisk po ≥ 350 ms spustí stejnou funkci jako BE na čáře (`LiveTradingScreen.tsx:468–473` → `runLiveManage('move-stop')`). | `move-stop` po dvoukroku |
| Shift+X | Zavřít pozici, jen když by ji nabídl × na čáře (`canClose`, `:287`). Dvoukrokově, ačkoli myší je to jeden klik. | `close-position` po dvoukroku |
| Shift+C | Zrušit čekající vstup nebo čekající přikoupení, dvoukrokově s klíčem akce. | `cancel-entry` po dvoukroku |
| Shift+F | Otevře dialog Flatten All nouzové lišty (`LiveSafetyControls.tsx:69/76`). Potvrzuje se klikem nebo Enterem v dialogu. | Jen přes dialog |
| ? | Nápověda se seznamem zkratek. | — |

Odeslání návrhu zůstává jen na tlačítku panelu (`sendDirect`, `LiveOrderTicket.tsx:483`). Globální Enter se nezavádí.

**(3) Mechanismus**
- **Nový čistý `lib/liveHotkeys.ts`:**
  - `liveHotkeyAction(event, ctx)` vrátí `null`, když platí cokoli z: `event.repeat`, `isComposing`, Meta/Ctrl/Alt, cíl je `input`/`textarea`/`select`/`[contenteditable]`/`[role=textbox]`, je otevřený modální dialog, graf odchází (`leaving`), stránka je skrytá.
  - `createTwoStepGuard()` pracuje s klíčem akce + id čáry + cena a oknem 350 ms až 4 s; změna klíče stav resetuje.
- **`components/LiveTradingScreen.tsx`:**
  - jeden posluchač `keydown` ve fázi capture;
  - BE, zavření a zrušení se vytknou do `runBreakEven` / `runClosePosition` / `runCancelPending`, které sdílí klávesa i `onOrderLineAction` / `onOrderLineCancel` (`:452–473`) — myš i klávesa mají jednu cestu;
  - hlášky jdou přes `lineNotice`.
- **Esc a kreslení.** Candlekit (`node_modules/@getcandlekit/charts/dist/chunk-PF26Q4NQ.js:2266`) při Escape zruší rozkreslenou kresbu nebo výběr, ale `preventDefault` nevolá.
  - Proto přibude volitelný `LiveOrderEntryBridge.onEscape?: () => void` (`AlphaTradeChartWorkspace.tsx:298`).
  - Panel trhu exekuce ho volá z posluchače ve fázi capture, a to jen když `engine.getActiveTool()`, `getDraft()` i `getSelectedId()` jsou prázdné.
  - Stav se čte dřív, než ho candlekit změní. První Esc tak zruší kresbu, teprve druhý zahodí návrh.
- **Flatten.** Nový `lib/liveSafetyShortcut.ts` (subscribe/request, jen v paměti). `LiveSafetyControls` se přihlásí k odběru a na požadavek zavolá `setConfirmation({ action: 'flatten-group', target })` se stejným `target` a `flattenCoordinator`. Bez targetu se nestane nic.
- Relay, admission ani migrace se nemění.

**(4) Dotčené INV**
- **INV-UI-02.** Flatten jde jen přes existující dialog a zámek skupiny (`createFlattenGroupCoordinator`); OFF a kill zůstávají na liště.
- **INV-UI-01 / INV-FRESH-03.** Desk callbacky samy odmítnou příkaz bez `armStatusRef.fresh` (`TradovateLiveDesk.tsx:1099–1101`).
- **INV-MANUAL-01 (Graf, 30. 10.).** BE a zrušení zůstávají dvoukrokové; zavření klávesou je dvoukrokové, tedy přísnější než myš.
- **INV-RELAY-01.** Každé volání dostane nový klíč. Proti dvojímu odeslání chrání `repeat`, dvoukrok a `liveBusyRef` (`:270`).
- **INV-BRAKE-01.** Flatten dál vypíná kopírku; text dialogu se nemění.
- **Návrh textu do INV-MANUAL-01 (odrážka Graf):** „Klávesy PC (11/2026): Shift+B/S jen návrh v panelu (jako ⚡); Esc zahodí návrh jen při nečinném kreslení; Shift+E/X/C dvoukrokově (≥ 350 ms, do 4 s, klíč akce+cena) touž funkcí jako čára; Shift+F jen otevře dialog Flatten nouzové lišty. Žádná klávesa neodesílá vstup; `event.repeat` se ignoruje.“
- **Totéž stručně do INV-UI-02** (odstavec o statické nouzové liště).

**(5) Selhání a fail-closed**
- Držená klávesa: `repeat` se ignoruje a dvoukrok vyžaduje nový stisk po ≥ 350 ms.
- Čekající vstup se mezi stisky vyplní: klíč nese akci a cenu, takže potvrzení zrušení nikdy nepotvrdí zavření.
- Starý nebo obnovený stav: desk vyhodí „není čerstvě ověřený“ a UI hlásí „Neodesláno“.
- Brzda během letu: worker vrátí `brake-after-request` nebo `not-armed`.
- Fokus v poli panelu nebo otevřený dialog: nic se nestane.
- Restart workeru: dnešní „výsledek neznámý“, nic se neopakuje.

**(6) DEMO conformance.** Žádný nový záznam u brokera: `move-stop`, `close-position` i `cancel-entry` jsou zaznamenané z 29.–30. 10. Smoke test na DEMO8661118 MNQ po nasazení:
- Shift+B → Odeslat Limit 1;
- Shift+C ×2;
- Market 1 + Shift+E ×2;
- Shift+X ×2;
- Shift+F → Zpět (nic se nestane).

**(7) Testy**
- `tests/liveHotkeys.test.ts`:
  - mapa kláves;
  - `null` pro repeat, composing, meta, input, textbox a dialog;
  - dvoukrok: 349 ms nepotvrdí, 350 ms potvrdí, po 4 001 ms vyprší;
  - změna klíče resetuje;
  - mutace: odstranit kontrolu `repeat` → test zčervená.
- Statický test v `tests/liveTradingScreenGuards.test.ts`: handler zkratek nikdy nevolá `onPlaceEntry` / `sendDirect` / `placeLeaderEntry` a Shift+F jen `requestLiveSafetyConfirmation`.
- `tests/liveSafetyControls.test.ts`: požadavek otevře dialog a nevolá `onAction`.
- Test bridge: při aktivním nástroji nebo výběru se `onEscape` nevolá.

**(8) Soubory**
- Nové: `lib/liveHotkeys.ts`, `lib/liveSafetyShortcut.ts`, `components/LiveHotkeysHelp.tsx`.
- Změny: `components/LiveTradingScreen.tsx`, `components/AlphaTradeChartWorkspace.tsx`, `components/LiveSafetyControls.tsx` + testy.

**(9) Velikost M.** Volitelně závisí na U8 (výchozí šablona pro Shift+B/S) a U10 (budoucí BE+n). Balík A1 (knihovna), integrace v B3.

---

## U2: Telefon — riziko v $, jednotky SL/TP, „Zkontrolovat u workeru“, táhnutelné čáry návrhu

**(1) Verdikt: STAVĚT.**

**(2) Chování (telefon; PC tohle už umí)**
- **List objednávky:**
  - přepínač „Kontrakty | Riziko $“ s krokem 25 $ a řádkem „→ N kontraktů · skutečné riziko $X“ (`ticketQuantity` zaokrouhluje dolů, `lib/liveOrderTicket.ts:84`);
  - u TP/SL přepínač jednotek Cena / Body / Ticky / $ přes `bracketDisplayValue` a `bracketPriceFromInput` (`:183/:207`);
  - tlačítko „Zkontrolovat u workeru (nic se neodešle)“: ukáže stáří od přijetí, po 15 s zešedne a nikdy netvrdí „připraveno“.
- **„Upravit v grafu“:**
  - list se stáhne do spodní lišty návrhu nad pilulkou: „BUY 2 LMT @ … · SL … · TP … · −$48“ s tlačítky [Odeslat] [Upravit] [×];
  - v grafu se kreslí čáry návrhu (`liveDraftChartLines`, `:240`): nejdřív klepnutím vybrat, pak táhnout;
  - vstup Limit/Stop jde táhnout; u Marketu jen SL/TP, které jedou s cenou jako na PC (`LiveTradingScreen.tsx:358–389`);
  - Odeslat z lišty je stejná cesta jako tlačítko listu.
- **Odeslání se nemění:** jedno klepnutí, po přijetí se návrh zavře.

**(3) Mechanismus**
- **Bridge.** `LivePhoneTradeBridge.preview?` (`lib/livePhoneOrders.ts`) = desk `previewLeaderEntry` (`:900`) beze změny. Do `phoneTrade` (`:1161`) se doplní jen s `supportsCopierManualEntry`.
- **Sdílený náhled.** Logika `PreviewSection` (`LiveOrderTicket.tsx:177`) se vytkne do čistého `lib/livePreviewView.ts` (stáří, `resetKey`, text výsledku); PC i telefon tak mají totéž.
- **Velikost podle rizika.** List posílá dál `{ sizing: 'qty', quantity: m.quantity }`. Do workeru jde jen zobrazené N, nikdy `riskUsd`.
- **LivePhoneChart:**
  - stav `order` dostane `mode: 'sheet' | 'chart'`;
  - v `chartLayer` (`:374`) jdou čáry návrhu do `LivePhoneOrderLines` jako `draftLines` + `onDraftChange` — jeden overlay pro pozici i návrh, protože dva by se praly o dotyky;
  - lišta odesílá přes vytknuté `submitSheetDraft`, tedy dnešní tělo `onSubmit` (`:325–342`): přikoupení, `sendBlocked`, kontrola překřížení trhu a `livePhoneSheetEntry`.
- **Relay.** `assertPreviewAdmissible` (`server/tradovateCopierCommandRelay.ts:1144`) beze změny: jeden náhled na zařízení, rozestup 3 s, platnost 15 s. Migrace ne.

**(4) Dotčené INV**
- **INV-MANUAL-01.** Náhled nic nezapíše a neautorizuje odeslání.
- **INV-UI-04.** Velikost podle rizika u Marketu stojí na ceně kanálu, takže je to jen odhad zobrazený jako „→ N“. Odchází zobrazené N jako výslovná volba uživatele; worker přepočítá riziko z IBKR + 6 ticků (`manualEntryMarketQuoteBlockers`). Denní limit se v listu hlídá jen u Limit/Stop (`ticketProblems`). Návrh: doplnit do INV-UI-04 (LIVE → Graf, 29. 10.) „platí i pro list telefonu“.
- **INV-UI-01/02 a INV-FRESH-03.** `blockedReason` bridge beze změny; náhled jen z čerstvého stavu (`:903`).
- **INV-RELAY-01.** Zámek `busyRef` (`LivePhoneChart.tsx:128`) je společný pro list i lištu návrhu.

**(5) Selhání**
- Náhled starší než 15 s zešedne; změna návrhu nebo stavu kopírky ho zahodí.
- `copier-relay-preview-busy` → hláška „zkus za 3 s“.
- Tah čáry během odesílání zastaví zámek.
- Kotace starší než 3 s → Market je blokovaný (`:141`).
- Limit přetažený přes trh zachytí `limitIsMarketable` / `stopIsTriggered`.
- Přechod do přehrávání: čáry zmizí a odeslání je blokované (U3).
- Restart workeru: „výsledek neznámý“.

**(6) DEMO conformance.** Žádný nový záznam u brokera. Smoke test z iPhonu:
- riziko 50 $ → N kontraktů;
- náhled;
- Limit posunutý v grafu → Odeslat;
- × dvakrát.

**(7) Testy**
- `tests/livePhoneOrders.test.ts`: list s `sizing: 'risk'` posílá zobrazené N a nikdy `riskUsd`. Mutace: `ceil` místo `floor` → test zčervená.
- `tests/livePreviewView.test.ts`: stáří, hranice 15 s, `resetKey`.
- `tests/livePhoneOrderLinesBehavior.test.ts`: tah návrhu volá jen `onDraftChange`, nikdy `place` ani `manage`; vstup Marketu nejde táhnout.
- Statický test: `LivePhoneDraftBar` odesílá jen přes `submitSheetDraft`.

**(8) Soubory**
- Nové: `components/day/LivePhoneDraftBar.tsx`, `lib/livePreviewView.ts`.
- Změny: `components/day/LivePhoneOrderSheet.tsx`, `components/day/LivePhoneChart.tsx`, `components/day/LivePhoneOrderLines.tsx`, `lib/livePhoneOrders.ts`, `components/TradovateLiveDesk.tsx` (`bridge.preview`).
- Volitelně `components/LiveOrderTicket.tsx` (`PreviewSection` přes sdílenou logiku).

**(9) Velikost M.** Závisí na B1 (`bridge.preview`), U3 (vrstva v každém okně), volitelně U8. Balíky B4 (list) a B5 (graf).

---

## U3: Telefon — ovládací čáry ve dvou oknech grafu a při přehrávání

**(1) Verdikt: JEN-ČÁST.**
- **Dvě okna: STAVĚT.**
- **Ovládání při přehrávání: ZAMÍTNOUT.** Brání tomu INV-UI-01 (ovládání nad zobrazením, které neodpovídá živému stavu) a „co jsem viděl“ z INV-MANUAL-01:
  - během přehrávání uživatel vidí historickou cenu;
  - `lastPrice` je proto záměrně `null` (`DayFullscreenChart.tsx:713`);
  - tah SL by se vztahoval k historické svíčce.

  Místo toho bude jen štítek živé pozice a tlačítko „Zpět na živo“.
- **Navíc oprava N1:** lišta a plusko za přehrávání neodesílají.

**(2) Chování**
- **Dvě okna (2h/2v).** Štítky pozice, BE, ×, tah SL/TP, čáry návrhu (U2) i pracující příkazy (U5) se kreslí v každém okně v jeho měřítku. Plusko u kříže jen v aktivním okně. Zámek jednoho příkazu je společný pro obě okna.
- **Přehrávání.**
  - Žádné ovládací čáry ani návrh.
  - Nahoře štítek „PŘEHRÁVÁNÍ · živě LONG 2 · P&L (z brokera) · ‹ Zpět na živo“.
  - Lišta Koupit/Prodat i „+“ jsou ztlumené a hlásí „Přehrávání — obchoduj v živém grafu“.
  - Lišta pozice (Zavřít = Flatten, Přidat SL/TP) zůstává, protože snižuje riziko (INV-UI-02).
- **PC (pojistka N2).** Když `replay.phase === 'active'`, živé čáry dostanou `draggable:false`, ztratí × i BE a návrh se nekreslí.

**(3) Mechanismus**
- **Nový slot v `DayFullscreenChart`:** `live.paneLayer?: (info) => ReactNode` vykreslený uvnitř buňky okna (`DayFullscreenChart.tsx:769`).
  - `info = { ...liveInfo, api: paneApi(index) (:282), paneIndex, active, visible }`.
  - `BacktestOrderLinesOverlay` počítá souřadnice z vlastního kořene a `series.priceToCoordinate` (`BacktestOrderLinesOverlay.tsx:156/213`), takže v buňce sedí na měřítku okna.
- **LivePhoneChart:**
  - `LivePhoneOrderLines` a `LivePhoneAlertLines` se přesunou z `chartLayer` (`:376`, podmínka `fullPane`) do `paneLayer` s podmínkou `!replay`;
  - `PositionPriceLines` (`:375`) se pro dvě okna už nepotřebuje.
- **Lišta a plusko.**
  - `onSide` (`:150`) a `LivePhonePlusSheet.onOrder` dostanou `replay` z `liveInfo`.
  - `LiveTradePill` (`components/day/LivePhoneTrade.tsx:24`) dostane `disabled`.
  - Nový `LivePhoneReplayLiveChip` v `chartLayer` při přehrávání.
- **PC:** v `AlphaTradeChartWorkspace.tsx:689` (`panelOrderLines`) se při aktivním přehrávání čáry přepnou jen na čtení.
- Relay, worker ani migrace se nemění.

**(4) Dotčené INV**
- INV-UI-01, INV-UI-03, INV-UI-02 (zavření a Flatten zůstávají).
- INV-UI-04: přehrávaná data nikdy nevstoupí do příkazu.
- **INV-MANUAL-01, odrážka „Čáry obchodu na telefonu“.** Návrh: větu „Ve dvou oknech se štítky nekreslí (souřadnice okna 0)…“ nahradit větou „Ve dvou oknech kreslí každé okno vlastní vrstvu se svým API; při přehrávání žádné ovládání ani odeslání z lišty či plusu, jen štítek živé pozice“.
- **INV-MANUAL-01, odrážka „Holý Market z telefonu“:** k podmínce „odeslat jen nad čerstvým neobnoveným stavem“ doplnit „a mimo přehrávání“.

**(5) Selhání**
- Okno bez API (ještě se připojuje): nekreslí se nic.
- Tah zůstává v okně, kde začal (`selectToDrag` drží tah v ploše).
- Start přehrávání během letícího posunu: stav „odesílám“ žije v rodiči (`useLivePhoneLineState`) a výsledek přijde hláškou.
- Maximalizované okno: skrytá okna vrstvu odpojí.

**(6) DEMO conformance.** Žádný nový záznam u brokera. Smoke test na iPhonu:
- okna 1m a 5m: tah SL v 5m okně, BE v 1m okně;
- přehrávání: lišta zablokovaná, Zavřít funguje.

**(7) Testy**
- Dvě instance overlaye s různým API → štítek leží na souřadnici svého okna; zámek je společný.
- `tests/livePhoneTrade.test.ts`: `onSide` ani plusko za přehrávání nic neodešlou. Mutace: odstranit podmínku → test zčervená.
- Statický test: `paneLayer` v `LivePhoneChart` je podmíněný `!replay`.
- PC: při přehrávání žádná čára není `draggable`.

**(8) Soubory**
- Nový: `components/day/LivePhoneReplayLiveChip.tsx`.
- Změny: `components/day/DayFullscreenChart.tsx`, `components/day/LivePhoneChart.tsx`, `components/day/LivePhoneTrade.tsx`, `components/AlphaTradeChartWorkspace.tsx` (pojistka PC) + testy.

**(9) Velikost M.** Tvrdé závislosti nemá; U2 a U5 přidávají čáry do stejné vrstvy. Balík B5, PC pojistka v B3.

---

## U4: PC — holý Market + „Přidat SL/TP“, šipky živých fillů, předvolby qty

**(1) Verdikt: STAVĚT.** Holý Market a „Přidat SL/TP“ jen tam, kde worker inzeruje `manual-entry-bare-v1`. Dnes je to jen ruční DEMO skupina; prop skupin se změna netýká.

**(2) Chování na PC**
- **Holý Market.**
  - U Marketu jdou SL i TP vypnout; tlačítko pak zní „Koupit 1 MARKET · BEZ SL/TP“ a je výstražné.
  - Navrhuji dvoukrok v tlačítku („Opravdu bez ochrany? Klikni znovu“) — otázka pro Filipa.
  - Vyplněná jen jedna noha → „Vyplň SL i TP, nebo u Marketu ani jedno“.
  - V pozici je holý Market blokovaný (worker `account-not-flat`).
- **„Přidat SL/TP“.**
  - Karta pozice ukáže „BEZ SL/TP“ a formulář SL/TP v jednotkách panelu.
  - Výchozí hodnoty ze šablony U8, jinak 10/20 b od trhu.
  - V grafu táhnutelné čáry „· přidat“.
  - „Odeslat SL a TP“ jedním klikem, protože snižuje riziko.
- **Šipky fillů leadera** v PC grafu jako na telefonu, jen pro kontrakt grafu.
- **Předvolby qty:** čipy 1 · 2 · 3 · 5 (jen do stropu `entryMaxContracts`). Poslední qty, jednotky a sizing si pamatuje zařízení.

**(3) Mechanismus**
- **`lib/liveBareEntry.ts`:** `newestOpenBareEntry(entries, symbol)` vytknuté z desku (`TradovateLiveDesk.tsx:1166–1170`), sdílí PC i telefon.
- **Desk (nové props pro LiveTradingScreen):**
  - `entryBareSupported` (`supportsCopierManualEntryBare`);
  - `bareEntry`;
  - `onAttachBrackets` (= `attachBrackets`, `:1140`);
  - `fills` = `liveFillMarkersFromStatus` počítané i pro `chartAvailable` (dnes jen telefon, `:1205`).
- **LiveOrderTicket:**
  - `previewDraft` (`:433`) povolí Market bez obou nohou se stejným tvarem jako `livePhoneSheetEntry`;
  - `previewBlockedReason` (`:441`, větev na `:457`) se rozliší podle toho;
  - dvoukrok jen pro holý Market v `sendDirect` (`:483`), `directKey` (`:476`) zachovat;
  - nová `AttachSection` pod `PositionCard` (`:656`) volá `onAttachBrackets({ entryOperationId, symbol, quantity, expectPrice: marketNow, stopLoss, takeProfit })`. `marketNow` je bid u longu a ask u shortu (jako `LivePhoneChart.tsx:158`). UI předem zkontroluje, že obě nohy jsou ≥ 8 ticků na správné straně (worker: `MANUAL_ATTACH_MIN_TICKS`, `copierRuntimeController.ts:3439/4658`).
- **LiveTradingScreen:** čáry „přidat“ s vlastníkem `live-attach` do `orderLines` (`:391`).
- **AlphaTradeChartWorkspace:** `LiveOrderEntryBridge.liveFills?`; panel exekuce zavolá `useLiveFillArrows` (`components/day/useLiveFillArrows.ts`).
- **`lib/liveTicketPrefs.ts`:** localStorage, každé čtení a zápis v try/catch.
- Relay a admission se nemění — bare i attach už procházejí atomickou admission z telefonu. Migrace ne.

**(4) Dotčené INV**
- **INV-MANUAL-01 (Holý Market a doplnění SL/TP, 2. 11.).** Stejná capability, payload a relay. Návrh doplnit „i z PC panelu (11/2026), dvoukrokově“.
- **INV-UI-04.** `referencePrice` jde jen jako odhad, worker počítá z IBKR.
- **INV-UI-01/02 a INV-FRESH-03.** Callbacky desku běží jen nad čerstvým stavem (`:932`, `:1142`).
- **INV-UI-03 a odrážka „Šipky plnění“.** Statický test `tests/liveFillMarkersFromStatus.test.ts:185` se rozšíří na PC: fills nikdy do příkazů ani do relaye.
- **INV-RELAY-01.** Zámek `directBusyRef` (`:464`).

**(5) Selhání**
- Attach nebo holý Market s neznámým výsledkem: incident u workeru. UI hlásí „neznámé, nic neopakuj“.
- Starý holý záznam: worker vrátí `entry-closed`.
- Worker bez capability: UI holý Market vůbec nenabídne.
- DISARM během attach: attach smí doběhnout (snižuje riziko).
- Stará kotace: blok.

**(6) DEMO conformance.** Žádný nový záznam u brokera — holý Market i attach jsou ověřené z telefonu na DEMO 2. 11. Smoke test z PC:
- holý Market 1;
- Přidat SL/TP (tahem čar);
- BE;
- ×.

**(7) Testy**
- `tests/liveOrderTicket.test.ts`: holý Market jen s capability, u Marketu a s oběma nohami vypnutými. Mutace: povolit bez capability → test zčervená.
- `tests/liveBareEntry.test.ts`: nejnovější a otevřený záznam, správný symbol, ne protected.
- Statický test pro PC fills.
- Attach: hranice 8 ticků (mutace na 7 → test zčervená).
- `tests/liveTicketPrefs.test.ts`.

**(8) Soubory**
- Nové: `lib/liveBareEntry.ts`, `lib/liveTicketPrefs.ts`.
- Změny: `components/LiveOrderTicket.tsx`, `components/LiveTradingScreen.tsx`, `components/AlphaTradeChartWorkspace.tsx`, `components/TradovateLiveDesk.tsx` + testy.

**(9) Velikost M.** Závisí na B1; volitelně U8. Balíky A5, B1, B2, B3.

---

## U5: Všechny pracující příkazy jako čáry + rozjeté SL/TP nohy

**(1) Verdikt: STAVĚT**, ale jen jako zobrazení. Čáry nejde táhnout ani zrušit ×. Jádro správu cizích a rozjetých příkazů nemá a blokuje ji: `other-orders`, `position-multi`, `shape`.

**(2) Chování (PC i telefon)**
- **Pohled skupiny:** pracující příkazy leadera na kontraktu grafu, které nekreslí čáry pozice:
  - cizí Limit/Stop/StopLimit („LMT BUY 1 · Tradovate“, „STP LMT“);
  - další čekající vstupy;
  - rozjeté SL/TP nohy po cenách („SL 2 ks · 21 010.25“).
- **Pohled jednoho účtu:** příkazy toho účtu.
- Čáry jsou tlumené a tečkované. Tooltip: „Spravuj v Tradovate, nebo zavři pozici ×/Flatten“.
- Nepodporovaný typ (TrailingStop, MIT) dostane štítek „nepodporovaný typ“ s cenou, když je konečná.
- Neověřené příkazy: žádné čáry (zůstává dnešní štítek „Příkazy neověřené“).

**(3) Mechanismus**
- **Nový čistý `lib/liveWorkingOrderLines.ts`:**
  - `liveWorkingOrderLines({ orders: LiveOrder[], accountIds, verified, contract, drawn: { entry, stop, target, pendingAdd } })` → `BacktestChartOrderLine[]`;
  - vlastník `live-working`, `draggable:false`, `cancellable:false`;
  - seskupuje podle účtu, typu, strany a ceny;
  - vynechá to, co už kreslí `livePositionChartLines`;
  - nikdy nevyhodí výjimku (try/catch → `[]`).
- **`hooks/useLiveChartData.ts`:** z `orders` (`:46`) a `isLiveAccountReadVerified(account,'orders',now)` vznikne výstup `workingLines`, jen když `position.issue == null`.
- **PC:** čáry jdou do `orderLines` (`LiveTradingScreen.tsx:391`). Filtr `panelOrderLines` (`AlphaTradeChartWorkspace.tsx:689–694`) bez přepínače „čáry příkazů“ dnes pouští jen `livePositionOwnerId`, proto přibude `LiveOrderEntryBridge.liveDisplayOwnerIds?: string[]`.
- **Telefon:** `LivePhoneOrderLines.extraLines` ve stejném overlayi (pro dvě okna přes U3).
- Relay, worker ani migrace se nemění.

**(4) Dotčené INV**
- **INV-UI-01:** žádná poslední známá poloha; neověřené = nic.
- **INV-UI-03:** jen zobrazení; `expect` se dál bere ze `summary`.
- **INV-UI-04:** ceny jen z read modelu brokera.
- **INV-MANUAL-01:** čáry nevytvářejí příkaz.
- Návrh doplnit do INV-UI-03 (Živá pozice v grafu): „pracující příkazy mimo spravovaný obchod a rozjeté nohy jen z ověřeného čtení příkazů, jen pro čtení“.

**(5) Selhání**
- REST zaostává za streamem: čára zmizí až s dalším cyklem čtení (známé omezení, stejné jako karta).
- Příkaz bez ceny se vynechá; neznámý typ dostane štítek.
- Při více než 12 čarách se seskupí do „+N dalších“.

**(6) DEMO conformance.** Žádný nový záznam u brokera. Testy jedou z fixture `tests/fixtures/tradovate-leader-scale-in.json` (5 lístků, 3. 11.).

**(7) Testy**
- `tests/liveWorkingOrderLines.test.ts`:
  - neověřené → `[]`;
  - rozjeté SL z fixture → n čar s qty;
  - jedna cena → žádná duplicita;
  - všechny čáry `draggable:false` a `cancellable:false` (mutace → test zčervená);
  - neznámý typ nevyhodí výjimku.
- Statický test: vlastník `live-working` nemá větev, která by volala manage.

**(8) Soubory**
- Nový: `lib/liveWorkingOrderLines.ts`.
- Změny: `hooks/useLiveChartData.ts`, `components/TradovateLiveDesk.tsx`, `components/LiveTradingScreen.tsx`, `components/AlphaTradeChartWorkspace.tsx`, `components/day/LivePhoneChart.tsx`, `components/day/LivePhoneOrderLines.tsx`, `lib/livePhoneOrders.ts` + testy.

**(9) Velikost M.** Závisí na B1 a U3 (telefon). Balíky A3, B1, B3, B5.

---

## U6: Akce z push notifikace / Live Activity

**(1) Verdikt: JEN-ČÁST.** Akce jen otevře appku s připraveným potvrzením (dialog Flatten, první krok BE, první krok zrušení). Příkaz nikdy neprovede. Přímé provedení je ZAMÍTNUTO z těchto důvodů:
- **INV-FRESH-03 / INV-UI-02:** APNs může dorazit po minutách; nebyl by čerstvý poll ani ACK fence.
- **INV-MANUAL-01:** App Intent s tokenem z app group (`AlphaTradeWidgetAccessTokenV1`) by byla nová execution cesta mimo brány desku.
- **INV-BRAKE-01:** Flatten vypíná kopírku a na zamčené obrazovce se dá snadno klepnout omylem.
- **ActivityKit nesmí nést token ani příkaz** (komentář v `capacitor-ios/App/App/AlphaTradeLiveActivityAttributes.swift`).

**(2) Chování (iPhone)**
- **Notifikace** „Vstup vyplněn / Přidáno / Otočeno“ v nové kategorii `ALPHATRADE_POSITION` nabídne akce „Graf“, „BE…“, „Flatten…“ (destruktivní) a u čekajícího vstupu „Zrušit…“. Všechny akce mají `foreground: true` a `requiresAuthentication: true` (Face ID).
- **„Flatten…“** otevře přehled s dialogem Flatten All.
- **„BE…“** otevře graf s vybranou čárou a BE v prvním kroku; druhé klepnutí dělá uživatel.
- **Live Activity** dostane odkazy „Graf“ a „Flatten…“ přes `Link`; žádný App Intent akci neprovádí.
- **Platnost záměru:** 60 s, spotřebuje se jednou a jen po čerstvém pollu (≤ 15 s).

**(3) Mechanismus**
- **Swift:**
  - `supportedRoutes` v `capacitor-ios/App/App/AlphaTradeSystemActions.swift` + `live-flatten`, `live-be`, `live-cancel` — jen host, bez parametrů (podvržený odkaz tak jen otevře potvrzení);
  - `Link` v Live Activity v `capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift` (`:929`).
- **Web:**
  - `services/nativeNotifications.ts`: nová kategorie v `registerNativeNotificationActions` (`:284`) a mapování v `dispatchNativeNotificationAction` (`:339`);
  - `App.tsx` (`navigate`, `:1543`) nastaví `setRequestedLiveTab` a zavolá `publishLiveNativeIntent`;
  - nový `lib/liveNativeIntent.ts` (TTL, jednorázová spotřeba);
  - spotřebitelé: `LiveSafetyControls` (přes `liveSafetyShortcut` z U1) a `LivePhoneOrderLines` (předvýběr čáry, první krok).
- **Server:** `server/nativeCopierStatePush.ts:35` zvolí `category` podle druhu události. Starší build kategorii nezná, notifikace pak jen nemá tlačítka.
- Relay, worker ani migrace se nemění.

**(4) Dotčené INV.** INV-UI-02, INV-FRESH-03, INV-MANUAL-01, INV-WATCH-01, INV-BRAKE-01. Návrh doplnit do INV-UI-02 (LIVE na telefonu): „Akce notifikací a Live Activity jen otevřou LIVE s připraveným potvrzením; nic neprovedou; záměr platí 60 s, jednou, po čerstvém pollu; deep link je bez parametrů.“

**(5) Selhání**
- Studený start: route přežije v `pendingRoute` a spotřebuje se až po přihlášení a čerstvém pollu.
- Záměr starší než 60 s: zahodí se.
- Změněný target: rozhoduje `assertSameSafetyTarget`.
- Bez spravovatelného obchodu: jen hláška.
- Odhlášený uživatel: nic.

**(6) DEMO conformance.** Žádný nový záznam u brokera. Ověřit na iPhonu: zamčený telefon + Face ID, studený start, starší build.

**(7) Testy**
- `tests/liveNativeIntent.test.ts`: TTL, jednorázovost, neznámý druh.
- Mapování akcí na routy a `requiresAuthentication`.
- Statický test: záměr ani notifikace neimportují `executeTradovateCopierRelayCommand` ani příkazy desku.

**(8) Soubory**
- Nový: `lib/liveNativeIntent.ts`.
- Změny: `services/nativeNotifications.ts`, `App.tsx`, `lib/liveOverviewRoute.ts`, `components/LiveSafetyControls.tsx`, `components/day/LivePhoneOrderLines.tsx`, `capacitor-ios/App/App/AlphaTradeSystemActions.swift`, `capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift`, `server/nativeCopierStatePush.ts`.

**(9) Velikost M.** Závisí na U1 (`liveSafetyShortcut`) a na buildu pro iPhone. Balíky A7 a B6.

---

## U7: Zvuk/hlas při fillu v appce

**(1) Verdikt: STAVĚT.**

**(2) Chování**
- Volba v LIVE (hlavička PC grafu, nastavení grafu na telefonu): Vypnuto / Tón / Hlas.
- Ohlašují se jen čerstvé události (≤ 30 s), jen při otevřeném LIVE grafu a viditelné stránce. Na PC mluví jen okno s fokusem. V pozadí dál platí push.

**(3) Mechanismus**
- `lib/liveFillAnnouncer.ts`: `CopierCopyEvent → { tone, text }` jako `copyEventToast` (`lib/liveTradeToasts.ts:35`). Při prvním načtení se události jen zapamatují (dedupe).
- `hooks/useLiveFillAnnouncer.ts`: stejné `events` jako karty — PC `LiveTradingScreen.tsx:582` (brána `copier.available`), telefon `slots.copyEvents`.
- `services/liveFillAudio.ts`: WebAudio s odemknutím na první dotyk; hlas přes `speakAlertText` (`services/alertVoice.ts`).
- Preference v localStorage. Relay, worker ani migrace se nemění.

**(4) Dotčené INV.** INV-UI-03, INV-UI-01 (brána dostupnosti stejná jako u karet), INV-UI-04 (P&L z události workeru).

**(5) Selhání**
- AudioContext zablokovaný nebo syntéza chybí: ticho, žádná výjimka.
- Záplava událostí: nejvýš jedno hlášení za 1,5 s.
- Stará událost po probuzení: ignoruje se.
- Duplicita s push v popředí: známé omezení.

**(6) DEMO conformance.** Žádný nový záznam u brokera.

**(7) Testy**
- `tests/liveFillAnnouncer.test.ts`: první načtení ticho; událost starší než 30 s ticho; dedupe; při `available=false` ticho (mutace → test zčervená).
- Statický test: announcer neimportuje relay.

**(8) Soubory**
- Nové: `lib/liveFillAnnouncer.ts`, `hooks/useLiveFillAnnouncer.ts`, `services/liveFillAudio.ts`.
- Připojení: `components/LiveTradingScreen.tsx`, `components/day/LivePhoneChart.tsx`.

**(9) Velikost S.** Bez závislostí. Balík A6, připojení v B3 a B5.

---

## U8: ATM šablony (uložené výchozí SL/TP pro uživatele)

**(1) Verdikt: STAVĚT** jako předvyplnění z plánované ceny vstupu. Nestaví se „odstup od skutečného fillu“ (přepočet SL/TP po fillu Marketu) — to je změna jádra.

**(2) Chování (PC panel i list telefonu)**
- Čipy šablon, např. „Scalp 12/24 t“ nebo „Swing 40 t / 2R“, s ★ u výchozí.
- Šablona obsahuje SL v ticích, TP v ticích nebo v R, sizing (qty nebo riziko $) a hodnotu.
- „Uložit jako šablonu“ vezme aktuální návrh.
- Výchozí šablona nahradí pevné 12 b / 2R (`lib/liveOrderTicket.ts:285–300`) v novém návrhu, pravém kliku, Shift+B/S, „+“ na telefonu a „Přidat SL/TP“.
- ⚡ z position boxu dál bere SL/TP z boxu. Přikoupení šablonu ignoruje (platí SL/TP pozice).
- U Marketu UI varuje, když je SL/TP pod 16 ticků (worker by příkaz odmítl).

**(3) Mechanismus**
- `lib/liveBracketTemplates.ts`: `sanitize`, `applyTemplate`, `templateFromDraft`.
- `services/liveBracketTemplateStore.ts`: pole `UserPreferences.liveBracketTemplates` přes `storageService.getPreferences/savePreferences` (`services/storageService.ts:1995`) + cache v localStorage.
- `newTicketDraft` (`:315`) dostane volitelný parametr `bracket`.
- **Migrace ne:** `profiles.preferences` je existující jsonb.

**(4) Dotčené INV.** INV-UI-04 (vzdálenost, ne cena z TV), INV-UI-01, INV-MANUAL-01 (příkaz dál nese absolutní ceny).

**(5) Selhání**
- Bez úspěšného čtení preferencí se nezapisuje (vzor `services/storageService.ts:3081`).
- Dvě zařízení najednou: vyhraje poslední zápis (existující omezení).
- Poškozená data: projdou `sanitize`.

**(6) DEMO conformance.** Žádný nový záznam u brokera.

**(7) Testy**
- `tests/liveBracketTemplates.test.ts`: ticky → ceny pro long i short, R, varování pod 16 t u Marketu, přikoupení šablonu ignoruje.
- Store: bez čtení se nezapisuje (mutace → test zčervená).

**(8) Soubory**
- Nové: `lib/liveBracketTemplates.ts`, `services/liveBracketTemplateStore.ts`.
- Změny: `types.ts`, `lib/liveOrderTicket.ts`, `components/LiveOrderTicket.tsx`, `components/day/LivePhoneOrderSheet.tsx`, `components/day/LivePhoneLiveActions.tsx`.

**(9) Velikost M.** Bez závislostí. Balíky A2, B2, B4.

---

## U10: SL/TP zadáním čísla, BE + n ticků, BE s poplatky

**(1) Verdikt: STAVĚT** přes stávající `move-stop` a `move-target`. TP blíž k trhu a SL blíž než 8 ticků od trhu dál zablokuje worker (`toward-market`, `tighten-too-close`, `copierRuntimeController.ts:5206–5223`).

**(2) Chování**
- **PC panel:** nová sekce „Správa“ pod kartou pozice (řeší N3):
  - SL a TP v jednotkách + tlačítko „Posunout“;
  - BE, BE +[n] t (n 1–40), BE + poplatky — všechny BE varianty dvoukrokově.
- **Telefon:** ✎ na vybrané čáře otevře list s číslem a BE variantami.
- **Pozice z přikoupení:** posouvá se celá pozice (`scope: 'position'`, desk `:1094`).

**(3) Mechanismus**
- **`lib/liveManagePrices.ts`:**
  - `breakEvenPlusTicks` = `breakEvenStop` (`lib/liveChartPosition.ts:89`) ± n·tick;
  - `breakEvenWithFees` = průměr + poplatky celé pozice / (qty · pv), zaokrouhleno na stranu zisku;
  - `managePriceFromInput` převádí číslo v jednotkách na cenu.
- **Poplatky:** `summary.rows` leadera `.fees`, tedy skutečné poplatky fillů od brokera. Když chybí, BE+poplatky se nenabízí.
- **Předkontroly:** `liveLineMoveBlockReason` (`lib/liveChartOrderLines.ts:37`) a `guardSummaryAt` (`LiveTradingScreen.tsx:264`). Jen blokují.
- **Sdílené odesílání:** `runLiveManage` (`:293`) a telefonní `run` se vytknou do `hooks/useLiveManageRunner.ts`.
- Relay, admission ani migrace se nemění.

**(4) Dotčené INV**
- INV-MANUAL-01, fáze 2c.
- INV-UI-03/04: poplatky a průměr slouží jen k výpočtu ceny záměru; cena se ukáže před druhým krokem.
- INV-UI-01: průměr jen ze stavu pollu (`TradovateLiveDesk.tsx:1854`).
- Návrh doplnit do fáze 2c: „BE+n a BE s poplatky jsou jen jiná cena záměru `move-stop`; poplatky z ověřeného čtení, chybí = nenabízet“.

**(5) Selhání**
- Průměr nebo poplatky neznámé: tlačítko je vypnuté.
- Cena mezitím přešla přes trh: broker nebo worker příkaz odmítne → „Neodesláno“.
- Rozjeté SL (`stop == null`): blok.
- Neznámý výsledek: nic se neopakuje.

**(6) DEMO conformance.** Žádný nový záznam u brokera — `move-stop` k trhu je zaznamenaný 30. 10. (`InvalidPrice`). Smoke test: BE+2 t, BE+poplatky, SL zadaný číslem 30 t.

**(7) Testy**
- `tests/liveManagePrices.test.ts`: zaokrouhlení pro long i short (mutace floor/ceil → test zčervená), n=0 dává BE, nulové poplatky dávají BE.
- Blok, když je cena blíž než 8 ticků od marku.
- Statický test: sdílený runner posílá jen přes `onManageEntry`.

**(8) Soubory**
- Nové: `lib/liveManagePrices.ts`, `hooks/useLiveManageRunner.ts`, `components/day/LivePhoneManageSheet.tsx`.
- Změny: `components/LiveOrderTicket.tsx`, `components/LiveTradingScreen.tsx`, `components/day/LivePhoneOrderLines.tsx`.

**(9) Velikost M.** Bez tvrdých závislostí. Balíky A4, B2, B3, B4, B5.

---

## U12: DOM / cenový žebřík + Time & Sales

**(1) Verdikt: JEN-ČÁST.**
- **Žebřík bez hloubky trhu + Time & Sales: STAVĚT.** T&S bere obchody z IBKR tick-by-tick, které worker už odebírá (`services/ibkrMarketData.ts:176`; `IbTrade` nese cenu, velikost i čas).
- **Hloubka trhu (DOM L2): STAVĚT-PO-CONFORMANCE.** Nejdřív read-only sonda IBKR.
- **Klik do žebříku jen vyplní panel.** Odeslání klikem do DOM je ZAMÍTNUTO pravidlem Filipa z 29. 10.

**(2) Chování na PC**
- Sloupec u panelu: ceny ±40 ticků, poslední cena, bid/ask, vlastní příkazy, pozice, SL/TP a objem na ceně.
- Klik vytvoří návrh v panelu.
- Seznam T&S: čas, cena, velikost a agrese.
- Bez IBKR se nezobrazí nic.

**(3) Mechanismus**
- **Worker:** kruh obchodů z `onTick` v `services/ibkrPriceSource.ts` (nevýkonové vlákno, INV-WORKER-04).
- **Zpráva ceny:** nové pole `x` v `lib/tvPriceMessage.ts`, podepsané HMAC nad `"trades\n" + x`. Je to stejný vzor jako cesta ceny `t`/`ts`, takže starší klienti fungují dál.
- **Klient:** `lib/tvPriceChannelClient.ts` a `lib/tvPriceStore.ts` (jen paměť).
- **UI a výpočty:** nový `lib/liveTimeAndSales.ts`, komponenty `components/LivePriceLadder.tsx` a `components/LiveTimeAndSales.tsx`.
- **Hloubka:** nejdřív `scripts/ibkr/probe-depth.ts`, pak teprve `subscribeDepth` v `ReadOnlyIbClient`.
- **Migrace ne.**

**(4) Dotčené INV**
- **INV-UI-04:** jen zobrazení a licence dat jen pro vlastní IBKR.
- **INV-RELAY-04, INV-WORKER-04.**
- **INV-UI-01:** klik do žebříku je jen návrh.
- Návrh nového odstavce do INV-UI-04 „Time & Sales a žebřík“.

**(5) Selhání**
- IBKR odpojený: „bez dat“, nikdy poslední známá hodnota.
- Neplatný podpis: zpráva projde bez obchodů.
- Přetečení: hláška „vynecháno N“.

**(6) DEMO conformance.** U Tradovate se nic nezaznamenává. Před hloubkou trhu proběhne IBKR sonda MNQ (read-only) a vznikne fixture.

**(7) Testy**
- `tests/tvPriceTrades.test.ts`: podpis, kompatibilita se starším klientem, strop. Mutace: bez podpisu → test zčervená.
- `tests/liveTimeAndSales.test.ts`.
- Rozšíření `tests/tvPriceClientGuards.test.ts`.
- Statický test: klik do žebříku vytvoří jen návrh.

**(8) Soubory**
- Nové: `lib/liveTimeAndSales.ts`, `components/LivePriceLadder.tsx`, `components/LiveTimeAndSales.tsx`, `scripts/ibkr/probe-depth.ts`.
- Změny: `services/ibkrPriceSource.ts`, `services/ibkrMarketData.ts`, `lib/tvPriceMessage.ts`, `lib/tvPriceChannelClient.ts`, `lib/tvPriceStore.ts`, `components/LiveTradingScreen.tsx`.

**(9) Velikost L.** Závisí na U5 a na reinstalaci workeru. Balíky A8, B7 a připojení v B3.

---

## U13: Paper trading na živých datech

**(1) Verdikt: JEN-ČÁST.** První verze je simulace v paměti na oddělené ploše PAPER: bez relaye, bez workeru a bez ukládání. Ukládání je ZAMÍTNUTÉ, dokud Filip neudělí výjimku z INV-UI-04 („nikdy … do žurnálu ani storage“; IBKR spadá pod stejné pravidlo).

**(2) Chování**
- Samostatná obrazovka s pruhem „PAPER · nic se neposílá brokerovi“.
- Panel, čáry a šipky jako v backtestu; Quick Order hned odesílá do simulace.
- Po reloadu se session ztratí.

**(3) Mechanismus**
- `services/livePaperSession.ts` nad čistými funkcemi `services/backtestEngine.ts` (`createBacktestRuntime`, `enqueueBacktestOrder`, `executeBacktestMarketOrder`, `processBacktestCandle`, `updatePositionBracket`).
- Každý tick je mikro-svíčka.
- UI `components/LivePaperScreen.tsx` jede přes bridge `backtestSession`, nikdy přes `liveOrderEntry`.
- **Migrace ne.**

**(4) Dotčené INV.** INV-UI-04, INV-MANUAL-01 (statický test importů), INV-UI-01 (žádná záměna paper a live).

**(5) Selhání**
- Výpadek ceny: simulace se pozastaví.
- Ve svíčce, kde jsou SL i TP, se vyhodnotí SL dřív.
- Záměnu paper a live vylučuje oddělená obrazovka.

**(6) DEMO conformance.** Žádná.

**(7) Testy**
- `tests/livePaperSession.test.ts`.
- `tests/livePaperGuards.test.ts`: žádný import relaye, desku, `storageService` ani Supabase.

**(8) Soubory**
- Nové: `services/livePaperSession.ts`, `components/LivePaperScreen.tsx`.
- Změna: navigace (`App.tsx`, jeden řádek).

**(9) Velikost L.** Volitelně závisí na U8. Balíky A9 a B8.

---

## Rozdělení práce na balíky a pořadí slučování

**Princip:**
- **Vlna A:** jen nové soubory, běží paralelně.
- **Vlna B:** integrace. Každý „horký“ soubor má jediného vlastníka.
- **Vlna C:** dokumentace na konci.

### Vlna A (paralelně)

| Balík | Položka | Soubory |
|---|---|---|
| A1 | U1 | `lib/liveHotkeys.ts`, `lib/liveSafetyShortcut.ts` |
| A2 | U8 | `lib/liveBracketTemplates.ts`, `services/liveBracketTemplateStore.ts`, `types.ts` (jen pole) |
| A3 | U5 | `lib/liveWorkingOrderLines.ts` |
| A4 | U10 | `lib/liveManagePrices.ts`, `hooks/useLiveManageRunner.ts` |
| A5 | U4/U2 | `lib/liveBareEntry.ts`, `lib/liveTicketPrefs.ts`, `lib/livePreviewView.ts` |
| A6 | U7 | `lib/liveFillAnnouncer.ts`, `hooks/useLiveFillAnnouncer.ts`, `services/liveFillAudio.ts` |
| A7 | U6 | `lib/liveNativeIntent.ts` |
| A8 | U12 | `services/ibkrPriceSource.ts`, `lib/tvPriceMessage.ts`, `lib/tvPriceChannelClient.ts`, `lib/tvPriceStore.ts`, `lib/liveTimeAndSales.ts` |
| A9 | U13 | `services/livePaperSession.ts` |

### Vlna B (každý soubor má jediného vlastníka)

| Balík | Položky | Soubory |
|---|---|---|
| B1 desk/data | U2, U4, U5 | `components/TradovateLiveDesk.tsx`, `hooks/useLiveChartData.ts`, `lib/livePhoneOrders.ts` — nová pole s bezpečnými výchozími hodnotami |
| B2 PC panel | U4, U8, U10 | `components/LiveOrderTicket.tsx`, `lib/liveOrderTicket.ts` |
| B3 PC graf | U1, U3-PC, U4, U5, U7, U12 (připojení) | `components/LiveTradingScreen.tsx`, `components/AlphaTradeChartWorkspace.tsx`, `components/LiveSafetyControls.tsx`, `components/LiveHotkeysHelp.tsx` |
| B4 telefon list | U2, U8, U10 | `components/day/LivePhoneOrderSheet.tsx`, `components/day/LivePhoneDraftBar.tsx`, `components/day/LivePhoneManageSheet.tsx`, `components/day/LivePhoneLiveActions.tsx` |
| B5 telefon graf | U2, U3, U5, U6 (spotřeba), U7, U10 | `components/day/LivePhoneChart.tsx`, `components/day/LivePhoneOrderLines.tsx`, `components/day/DayFullscreenChart.tsx`, `components/day/LivePhoneTrade.tsx`, `components/day/LivePhoneReplayLiveChip.tsx` |
| B6 nativní | U6 | `services/nativeNotifications.ts`, `App.tsx`, `lib/liveOverviewRoute.ts`, `server/nativeCopierStatePush.ts`, `capacitor-ios/App/App/AlphaTradeSystemActions.swift`, `capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift` |
| B7 žebřík | U12 | `components/LivePriceLadder.tsx`, `components/LiveTimeAndSales.tsx` |
| B8 paper | U13 | `components/LivePaperScreen.tsx` + jeden řádek navigace |

**Překryvy, které nejdou úplně vyloučit:**
- `LiveSafetyControls.tsx`: patří jen B3. U6 do souboru nesahá, jen volá `liveSafetyShortcut` z A1.
- `App.tsx`: B6 a B8 (B8 jen jeden řádek) → slučovat B6 dřív.
- `LivePhoneOrderLines.tsx`: patří jen B5, včetně předvýběru čáry pro U6.

### Pořadí slučování

1. A1–A7 v libovolném pořadí.
2. B1: props s výchozími hodnotami, beze změny chování.
3. B2, B4 a B6 paralelně.
4. B3 a B5 paralelně (PC a telefon jsou disjunktní).
5. C: texty do `docs/COPIER_INVARIANTS.md`, zápis do `docs/PROJECT_LOG.md` a critic na diff U1, U4, U6 a U10.
6. A8 + B7 (U12): vyžaduje reinstalaci workeru, tedy víkend nebo „nasaď“.
7. A9 + B8 (U13).

Každý krok: testy → tsc → commit, řetězeno přes `&&`.

## Otázky na Filipa

1. **U4:** dvoukrokové potvrzení u holého Marketu na PC? (Doporučuji ano.)
2. **U3:** zablokovat lištu Koupit/Prodat během přehrávání? (Doporučuji ano: dnes pošle živý Market nad historickým grafem.)
3. **U1:** schválit mapu kláves Shift+B/S/E/X/C/F?
4. **U13:** ukládat paper session? To vyžaduje výjimku z INV-UI-04.
5. **U12:** předplatit IBKR L2 kvůli hloubce trhu?
6. **U7:** potlačit zvuk push v popředí, když běží hlas v appce?
