# Deník dne na telefonu: celoobrazovkový graf s kreslením

Zadání z 14. 10. 2026 (Filip + Claude). Vychází z reálných obrazovek mobilní
aplikace TradingView na Filipově iPhonu (graf MNQ, sheet nástrojů, vybraná
kresba, otočení na šířku) a z toho, co už umí graf deníku v kódu.

## Cíl

Na telefonu je graf dne malý (250–300 px výšky) a nejde v něm pohodlně
číst ani kreslit. Chceme, aby šel jedním klepnutím zvětšit na celou obrazovku,
choval se jako plnohodnotný graf (pinch, posun, timeframe), uměl připíchnout
poznámku s časem zápisu a nakreslit pár základních kreseb prstem. Okolí
(výsledek dne, příprava, uzavření, časová osa, diktování) zůstává, jak je.

## Ne-cíle

- Parita s TradingView: žádné kategorie nástrojů, Fibonacci, Gann, volume
  profile, position tool, správa indikátorů, alerty, watchlist, symbol picker.
  Plnohodnotné TradingView má Filip v telefonu; hodnota deníku je jinde
  (poznámka s časem zápisu, obchody dne, plán vs. realita).
- Žádný vliv na copier: graf je jen zobrazení, nic odsud nezamyká ani
  neautorizuje.
- Desktop se nemění (má workspace s vlastní lištou kreslení).

## Co jsme odkoukali z TradingView (iPhone, 14. 10. 2026)

| Prvek TradingView | Pozorování | Převzít? |
|---|---|---|
| Hlavička grafu | Jeden řádek: název instrumentu · timeframe · burza; cena pod ním; indikátory sbalené do „⌄ 4“ | Ano, zkráceně |
| Spodní pruh grafu (normální režim) | symbol (rolovací), timeframe (rolovací kolečko, prosvítá sousední hodnota), tužka, indikátory, rozložení, „…“, zpět/vpřed | Ano, s naší sadou tlačítek |
| Spodní pruh v režimu kreslení | Celý pruh se přepne: aktivní nástroj vlevo, magnet, zámek kreseb, skrýt kresby, vrstvy, fullscreen, vpravo „ukončit režim“ | Ano, zjednodušeně |
| Oblíbené nástroje | Plovoucí lišta s úchytem, jde posunout, vypnout přepínačem „Show favorites on Chart“ | Ne jako plovoucí; naše 3 nástroje jsou přímo v pruhu |
| Sheet „Drawings“ | Vyhledávání, záložky kategorií, dlaždice s hvězdičkou | Ne, nástrojů je málo |
| Vybraná kresba | Plovoucí lišta u kresby: klonovat/šablona, barva čáry, barva textu, tloušťka, styl, koš, „…“; velký kruhový úchyt pro tažení; zvýrazněný štítek ceny a času na osách | Ano, zjednodušeně (barva, tloušťka, koš, u poznámky text) |
| Na šířku | Nic se nepředělává, graf dostane šířku, pruhy zůstanou | Ano |
| Fullscreen (ikona rámečku) | Schová i pruhy | Ano, druhý stupeň |

## Návrh UI

### Vstup do celoobrazovkového grafu

- V `DayCompactChart` přibude v pravém horním rohu grafu tlačítko „zvětšit“
  (ikona `Maximize2`). Otočení telefonu na šířku otevře celou obrazovku
  automaticky; otočení zpět ji nezavře (zavírá se tlačítkem), aby se
  rozdělaná kresba neztratila.
- Celá obrazovka je `position: fixed; inset: 0` vrstva uvnitř webview nad
  vším včetně spodní navigace; na iOS se navíc skryje nativní `UITabBar`
  (nová metoda pluginu, viz níže).

### Rozvržení (na výšku i na šířku stejné)

```
┌──────────────────────────────────────────┐
│ MNQ · 1m · Úterý 14. 10.     ● Živě 21:07 │  hlavička, 1 řádek
│                                          │
│                 graf                     │
│                                          │
│ [Den|London|NY]  1m  ✎  🎙  ⤢  ✕         │  spodní pruh, normální režim
└──────────────────────────────────────────┘
```

- Hlavička: kořen · timeframe · den; vpravo `LiveChip` (stav živých svíček).
  Nic jiného. Indikátory (Úrovně, FVG, Struktura) jsou za jedním chipem
  „⌄ 3“ jako v TV; klepnutí rozbalí tři přepínače.
- Spodní pruh, normální režim: rozsah (Den / London / NY, dnešní
  `ScopeSwitch`), timeframe jako rolovací kolečko 1m / 5m / 15m (klepnutí
  přepne na další, tah vybere), tužka = vstup do režimu kreslení, mikrofon =
  poznámka hlasem (dnešní `placing: 'voice'`), ⤢ = skrýt i pruhy
  (fullscreen 2. stupně, klepnutí kamkoli do grafu je vrátí), ✕ = zavřít.
- Spodní pruh, režim kreslení (po klepnutí na tužku se pruh přepne):
  `[zóna] [úroveň] [trendline] [poznámka]  magnet  zámek  skrýt  ↶  Hotovo`.
  Aktivní nástroj je zvýrazněný; po dokončení kresby nástroj zůstává
  aktivní (jako TV), „Hotovo“ vrátí normální režim.
- Vybraná kresba: plovoucí lišta nad kresbou se třemi barvami (long =
  zelená, short = červená, neutrál = šedá), tloušťkou 1/2/3, košem a „…“
  (otevře dnešní `GenericDrawingSettingsDialog`). Uchopovací body kresby
  mají na telefonu průměr ≥ 28 px.
- Vybraná poznámka (pin): stejná lišta, ale „Upravit text“, „Smazat“,
  „Ukazuje na …“ (přesun pinu tažením).

### Gesta

- Jeden prst: posun grafu (dnešní `attachChartTouchGestures`, už funguje).
- Dva prsty: pinch zoom času; tah po cenové ose roztahuje cenu (už funguje).
- V režimu kreslení: první klepnutí položí první bod, druhé druhý bod
  (zóna, trendline); úroveň má jeden bod. Během umisťování se ukazuje
  křížek s cenou a časem (dnešní vrstva `DayNotesLayer` to umí pro piny).
- Magnet: přichytávání k OHLC nejbližší svíčky (`services/chartDrawingMagnet.ts`
  už existuje, režim `weak` jako výchozí na telefonu).
- Dlouhé podržení prstu na kresbě ji vybere (klepnutí v režimu posunu by
  se pletlo s posunem).

## Data

- **Poznámky**: beze změny, `day_journal_entries` přes `useDayController`.
- **Kresby**: dnes se ukládají jen do `localStorage` pod klíčem
  `alphatrade:candlekit:day:<datum>:<timeframe>` (`CandleKitTradeChart`,
  `drawingKeyId` + `drawingScope || timeframe`). Důsledky, které musí zadání
  vyřešit:
  1. Kresba z telefonu není na Macu a naopak. Pro fázi 2 je potřeba
     synchronizace přes Supabase: tabulka `day_chart_drawings`
     (`user_id`, `day`, `drawings jsonb`, `updated_at`, owner RLS, upsert
     na `(user_id, day)`), zápis debounce 2 s po změně, čtení při otevření
     dne; konflikt = poslední zápis vyhrává (jedna osoba, dvě zařízení).
  2. Kresba na 5m není vidět na 1m. Telefon i desktop budou používat
     `drawingScope="day"`, aby kresby dne byly společné pro všechny timeframy
     (CandleKit kreslí v čase a ceně, ne v indexech svíček).
- **Výchozí stav grafu**: zapamatovat poslední timeframe a rozsah
  celoobrazovkového grafu per zařízení (`localStorage`).

## Změny v kódu

### Fáze 1: celá obrazovka, gesta, poznámky (bez kreslení)

- `components/day/DayFullscreenChart.tsx` (nový): fixní vrstva, hlavička,
  graf (`CandleKitTradeChart` s `compactMode`, `hideDrawingToolbar`,
  `drawingKeyId={`day:${day}`}`, `drawingScope="day"`), `DayNotesLayer`,
  spodní pruh v normálním režimu, tlačítko ⤢ pro skrytí pruhů, zavření.
  Stav grafu (timeframe, api) sdílený s `DayCompactChart` přes malý hook
  `useDayChartState`, aby po zavření zůstal stejný timeframe.
- `components/day/DayCompactChart.tsx`: tlačítko „zvětšit“, hook na
  `orientationchange` / `matchMedia('(orientation: landscape)')` → otevře
  celou obrazovku.
- `components/day/DayPhone.tsx`: drží stav `fullscreen`, předává `pick`
  (poznámka) a sheet pro diktování i do celé obrazovky (sheet se vykreslí
  nad grafem, ne pod ním).
- `components/day/dayJournal.css`: třídy pro pruhy (výška 52 px, safe-area
  dole), animace otevření/zavření (`dj-sheet`/`dj-fade` už existují).
- iOS: `capacitor-ios/App/App/AlphaTradeNativePlugin.swift` +
  `AlphaTradeShellViewController.swift`: nová metoda `setShellChrome({
  tabBarHidden: boolean })`, která animovaně schová/ukáže `UITabBar` a
  přepočítá kotvu webview (`tabBar.topAnchor`). Web volá přes
  `utils/nativeShell.ts` (`setNativeTabBarHidden`). Na webu bez pluginu
  stačí `fixed` vrstva.
- `utils/nativeShell.ts`: obal metody, no-op mimo nativní build.

### Fáze 2: kreslení prstem (po prototypu, viz níže)

- `components/day/DayDrawingBar.tsx` (nový): spodní pruh v režimu
  kreslení; používá `services/chartDrawingToolGroups.ts` (nástroje
  `Rectangle`, `HorizontalLine`, `TrendLine`), `services/chartDrawingMagnet.ts`,
  `services/chartDrawingStyle.ts` (3 barevné předvolby), undo přes drawing
  engine (`api.drawing.engine`).
- `components/CandleKitTradeChart.tsx`: nové props `touchDrawing?: boolean`
  (větší úchopy, výběr dlouhým podržením, bez hover stavů) a
  `onSelectedDrawingChange` (pro plovoucí lištu mimo komponentu); dnešní
  `GenericDrawingFloatingToolbar` dostane variantu pro dotyk (větší cíle,
  pozice nad kresbou, ne u kurzoru).
- `services/dayChartDrawings.ts` (nový) + migrace `day_chart_drawings`:
  export/import kreseb z engine, debounce zápis, čtení při otevření dne,
  owner RLS. `useDayController` dostane `drawings` stav.
- Desktop `DayDesktop.tsx`: jen `drawingScope="day"` (sdílení mezi timeframy)
  a čtení/zápis stejné tabulky, aby kresby z telefonu byly na Macu.

### Fáze 3 (volitelně, až po používání)

- Rolovací kolečko timeframe (zatím stačí klepnutí = další timeframe).
- Vrstvy / skrytí poznámek vs. kreseb zvlášť.
- Export kreseb do snímku dne (PNG) pro sdílení.

## Prototyp, který rozhodne o fázi 2

Před stavbou fáze 2 udělat jednodenní prototyp přímo v `DayFullscreenChart`:
jedna zóna (`Rectangle`) a jedna úroveň prstem na reálném iPhonu, se
zapnutým magnetem. Hodnotí se:

1. Jde položit bod přesně (bez myši) a nehýbe přitom graf?
2. Dá se zóna chytit a přesunout prstem (úchopy ≥ 28 px)?
3. Výběr dlouhým podržením vs. klepnutí: co se plete s posunem méně?
4. Nezpůsobí dotykové kreslení scroll stránky pod vrstvou (iOS WKWebView)?

Když 1 nebo 2 nefunguje po dni ladění, fáze 2 se nestaví a kreslení zůstává
v TradingView (jeho kresby se synchronizují do TV na Macu a tím i do snímků
workeru); deník dál dělá jen poznámky.

## Akceptační kritéria

- Na iPhonu 13 Pro Max: z pohledu dne jedno klepnutí otevře graf přes celou
  obrazovku, nativní tab bar zmizí, otočení na šířku dá grafu celou šířku,
  ✕ vrátí přesně předchozí stav stránky (scroll, výběr).
- Pinch a posun fungují bez scrollu stránky; timeframe 1m/5m/15m se přepne
  do 300 ms (svíčky jsou v paměti).
- Poznámka hlasem i textem jde připíchnout z celé obrazovky, uloží se se
  správným `written_at` a fází (ověřit v DB i přes MCP `get_journal_day`).
- Fáze 2: zóna, úroveň a trendline nakreslené v telefonu jsou do 5 s vidět
  na Macu ve stejném dni a na všech timeframech; smazání se propíše
  oběma směry.
- Světlý i tmavý režim bez pevných barev (tokeny `--dj-*`).
- Žádná změna v `lib/copier*`, `scripts/copier`, relay ani workeru.

## Testy

- Jednotkové: `useDayChartState` (sdílení timeframe), `dayChartDrawings`
  (serializace, debounce, poslední zápis vyhrává), magnet na dotyk
  (tolerance v px).
- Vizuální: harness `tests/visual` pro celou obrazovku na výšku i na šířku,
  světlý/tmavý režim.
- Ruční na telefonu: protokol z prototypu výše + akceptační kritéria;
  screenshoty přes `pymobiledevice3 developer dvt screenshot`.

## Rizika

- Dotykové kreslení v CandleKit motoru nikdo v telefonu nezkoušel
  (nástroje vznikly pro myš). Proto prototyp před fází 2.
- Skrytí nativního `UITabBar`: kotva webview je na `tabBar.topAnchor`
  (viz paměť „native-tabbar-scroll-clearance“); při schování se musí
  přepočítat, jinak zůstane dole prázdný pás.
- Synchronizace kreseb: nová tabulka = migrace přes `supabase-migrate`
  (advisory RLS), zálohu nepotřebuje (nová data).
- Paměť telefonu: celoobrazovkový graf drží druhou instanci CandleKit vedle
  kompaktního grafu; kompaktní graf se při otevření celé obrazovky
  odpojí (`key` změna), ne jen skryje.
