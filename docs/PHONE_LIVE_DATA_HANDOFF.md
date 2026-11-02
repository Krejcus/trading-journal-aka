# LIVE graf na telefonu — napojení dat (předávka 2. 11. 2026)

UI je hotové ve větvi `claude/phone-live-ui-20261101` (worktree
`~/alphatrade-worktrees/phone-live-ui`, rebasováno na `origin/main` f06ca5c8,
nepushnuto). Schválený náhled: https://claude.ai/artifact/EkQateEvNCynqk8rLyQUrr.
Tahle session má napojit data. Copier je bezpečnostně kritický kód: před
návrhem si přečti `docs/COPIER_INVARIANTS.md`, vypiš dotčené `INV-*` a návrh
i diff dej agentovi `copier-design-critic`.

## Co už v telefonu je (a z čeho bere data)

| Část | Kde | Data |
| --- | --- | --- |
| P&L skupiny v hlavičce + list „Účty v obchodě“ | `components/day/LivePhoneAccounts.tsx` | ✅ `useLiveChartData` v desku (stejné jako PC) |
| Čáry obchodu jako na PC (štítky, BE, ×, posun SL/TP) | `components/day/LivePhoneOrderLines.tsx` (+ `BacktestOrderLinesOverlay` s `selectToDrag`) | ✅ zobrazení z `chartData.position.summary`; ❌ **akce: `trade.manage` nenapojeno** |
| Karty vlevo dole (Zadáno, Vyplněno, SL posunut…) | `LiveTradeToasts` (`placement`, `extra`) | ✅ `recentCopyEvents` z workeru (jako PC) |
| Šipka vstupu/výstupu hned po vyplnění | `components/day/useLiveFillArrows.ts`, `lib/liveFillMarkers.ts` | ❌ **slot `fills` nenapojen** |
| Plusko u crosshairu → limit/stop, upozornění, vodorovná čára | `LivePhoneCrosshairPlus`, `LivePhonePlusSheet` (`components/day/LivePhoneAlerts.tsx`) | ✅ limit/stop jde přes stávající `LivePhoneOrderSheet` → `trade.place` |
| Upozornění na cenu (čára, zvoneček, výběr, ×, posun, nastavení, seznam) | `components/day/LivePhoneAlerts.tsx`, `lib/priceAlerts.ts` | ⚠️ jen `localStorage` v zařízení; ❌ **hlídání, doručení a sdílení s PC** |
| Kresby aktivní až po klepnutí | `components/day/DayTouchDrawLayer.tsx` | hotovo (bez dat) |

Sloty, které UI čeká (`LivePhoneChartSlots` v `components/day/LivePhoneChart.tsx`
a typ `phoneChart` v `components/TradovateLiveDesk.tsx`):

```ts
trade?: LivePhoneTradeBridge | null;      // + manage?, closeSupported?, entryAvg? (lib/livePhoneOrders.ts)
fills?: readonly LiveFillMarker[];        // plnění leadera aktuální epizody
fillsOpen?: boolean;                      // obchod je otevřený
alertWatch?: string | null;               // „Hlídá Mac worker · IBKR živě“ / null = nikdo
alertEvents?: readonly { id: string; alertId: string; at: number; price: number }[];
```

## 1. Správa obchodu z čar (posun SL/TP, BE, ×)

`LivePhoneTradeBridge.manage` = stejná funkce jako PC `onManageEntry`
(`manageLeaderEntry` v `TradovateLiveDesk.tsx`). Do `phoneTrade` (useMemo
v desku) doplnit:

- `manage: manageLeaderEntry` — **přesně ta funkce, žádná nová cesta**, a jen za
  stejné podmínky jako PC: `supportsCopierManualOrderManage(agentStatus) && ownManualEntry`
  (`TradovateLiveDesk.tsx`, prop `onManageEntry` PC grafu); jinak `undefined`.
- `closeSupported: supportsCopierManualOrderClose(agentStatus) && runtimeAvailable && armed && !shadowMode` (PC `canClose`).
- `entryAvg: chartLive.status === agentStatus ? ownManualEntry?.entryAvgPrice ?? null : null` (PC `manageEntryAvgPrice`).
- Pojistky utažení SL a BE: PC dává do `livePositionChartLines` souhrn přes
  `withIbkrTightenMark` (čerstvá kotace IBKR, když chybí cena z P&L brokera).
  Telefon zatím posílá surový `summary` — sjednotit (předat `guardSummary` / tick).
- UI už dělá totéž co PC: „co jsem viděl“ ze začátku tahu, `liveLineMoveBlockReason`,
  `liveBreakEven`, jeden příkaz naráz, „odesílám“ do potvrzení, hlášky výsledku.
- Nikdy neopakovat; nové `operationId` jen pro nový pokus uživatele.
- Už vyřešeno v UI (oponentura 2. 11.): vrstva grafu je pod listy a menu
  LIVE ▾, ve dvou oknech se štítky nekreslí, × je na telefonu dvoukrokové,
  zámek a „odesílám“ jsou v rodiči (`useLivePhoneLineState`), plusko bere typ
  z čerstvé kotace a list před odesláním odmítne limit/stop za trhem.
- Chybí testy chování (render overlaye se `selectToDrag`, `LivePhoneOrderLines`
  s mock `manage`: starý startLine = nic, druhý tah během letu odmítnut, bez
  `manage` žádné ×/BE/tah, `canClose=false` = žádné × u pozice) — dodat s napojením.
- Plusko u crosshairu je nad štítky (z 130 > 115), klepnutí na něj tedy nikdy
  netrefí × u pozice. Při napojení to ověřit na iPhonu (crosshair u ceny vstupu).
- Ve dvou oknech (na šířku je 2h výchozí) se štítky, upozornění ani plusko
  nekreslí — pozice jde cenovými čarami do všech oken (bez „odesílám“). Případně
  doplnit upozornění i tam.
- Lišta `LivePhonePositionBar` (Přidat SL/TP, Flatten) zůstává; po napojení
  zvážit, jestli ji štítky nenahradí (× u pozice = zavřít obchod jako na PC).

## 2. Šipky plnění hned po vyplnění

Dodat `fills: LiveFillMarker[]` (`lib/liveFillMarkers.ts`): plnění **leadera**
aktuální epizody z brokera (stream workeru / REST fills), `id` = fill id,
`orderId` (dílčí plnění jednoho příkazu = jedna šipka), `at` = čas brokera,
`price`, `side`, `role` entry/exit, `quantity`. Nikdy z ceny grafu ani TV.
Šipky kreslí primitiva deníku (`createJournalChartPrimitive` + nové `hoverAt`),
takže vypadají a chovají se 1:1 jako v deníku; klepnutí = cena ve svíčce.
Po doběhnutí obchodu do deníku se nesmí zdvojit (deník kreslí vlastní šipky z
`executionHistory`) — živé šipky schovat, jakmile obchod v deníku je.
Dále: deduplikovat přes víc OAuth připojení (INV-TRAD-06), reset při novém
`startedAt` workeru a na hranici obchodu, `fillsOpen` z autoritativní pozice
(neznámý = `undefined` → šipky se schovají), heartbeat starší než 8 s = nic
jako aktuální. Jen zobrazení, nic do úložiště ani rizika.

## 3. Upozornění na cenu (telefon i PC)

UI drží `PriceAlertStore` (`lib/priceAlerts.ts`): `subscribe`, `getState`,
`add`, `update`, `remove`, `setDefaults`. Nahradit `createLocalPriceAlertStore`
serverovým se stejným rozhraním:

- **Tabulka** `price_alerts` (RLS na `user_id`): id, symbol, price, condition
  (`cross|up|down`), frequency (`once|every`), expiry (`session|gtc`), line
  (json: width/style/color), channels (json: phone/voice/pc/sound), note,
  status (`active|triggered|expired`), last_triggered_at, created_at, updated_at.
  Výchozí nastavení (`PriceAlertDefaults`) per uživatel. Realtime → telefon i PC.
  Migrace přes skill `supabase-migrate`, `db push` je zakázaný.
- **Hlídání**: Mac worker z živých ticků IBKR (stejný zdroj jako živé P&L), ve
  vlastním vlákně **bez přístupu k příkazům a kopírce** — neexekuční modul
  v oddělené doméně selhání (INV-WORKER-04), nesmí zdržet poll relaye ani brzdy.
  Podmínku přepočítat z IBKR (uložené nahoru/dolů vzniklo z close grafu). Přechod přes cenu
  (`up`: předchozí < cena ≤ aktuální, `down` obráceně, `cross` oboje).
  „Jednou“ = atomicky `update … set status='triggered' where id=… and status='active' returning`
  **před** zařazením notifikace; „pokaždé“ nejvýš 1× za minutu (`last_triggered_at`).
  `session` vyprší s koncem seance.
- **Doručení**: stávající fronta `server/notificationDelivery.ts` (APNs do
  iPhonu, web push na PC), klíč `price-alert:<id>:<triggeredAt>` → právě jednou
  i po restartu workeru. Vlastní kategorie a dedupe oddělené od incidentů
  kopírky (INV-WATCH-01): záplava upozornění nesmí vyčerpat limit ani potlačit
  rizikové notifikace; rizikové dál otevírají `live:overview`. Hlas: nativně (AVSpeechSynthesizer přes Capacitor
  plugin) v telefonu, `speechSynthesis` na PC; jen když `channels.voice`.
- **Karty upozornění** nejsou sticky (8 s, `TradeToast.ms`), aby se „pokaždé“
  nehromadilo nad lištou pozice; sticky zůstávají jen problémy kopírky.
- **V appce**: do slotu `alertEvents` posílat spuštění se stabilními unikátními
  id → čára blikne a vyjede karta „Upoz.“ (už postavené; sticky karty rizika se
  nevytlačí). `alertWatch` = text jen z čerstvého heartbeatu vlákna upozornění,
  z cache nikdy „hlídá“; bez něj seznam píše „nikdo nehlídá“.
- **PC**: stejný store; čáry upozornění do `AlphaTradeChartWorkspace` (plusko /
  pravý klik), karty přes `LiveTradeToasts` `extra`. Zatím nepostaveno.

## Ověření a nasazení

- Před vitest/tsc/build: kopírka prokazatelně vypnutá (`curl … /v1/status`,
  `controller.armed === false`, příkaz musí zastavit), `NODE_OPTIONS=--max-old-space-size=6144` pro tsc.
- Build do iPhonu: bez simulátoru, `npm run ios:sync` → vrátit
  `capacitor-ios/App/CapApp-SPM/Package.swift` → xcodebuild generic iOS →
  `devicectl` **uninstall + install** (past Live Activity), worktree musí mít `.env.local`.
- Na web jen po Filipově „nasaď“: testy → tsc → commit → push řetězit přes `&&`.
- Disk: 2. 11. kolem 7 GB volna — worker zapisuje na stejný disk, noční záloha
  pod 11 GB odmítne. Před většími buildy uvolnit.
