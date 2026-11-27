# Volume profil a bubliny z NQ v LIVE grafu — návrh stavby (27. 11. 2026)

Stav: **postaveno ve větvi `claude/orderflow-20261127` (fáze 1–4), nenasazeno.** Vychází z `origin/main`
bd9839a4 (strom `~/alphatrade-worktrees/orderflow-design`). Náhled chování: `mockups/orderflow-preview.html`.
Co se proti návrhu změnilo po revizích, je v oddíle „Odchylky od návrhu“ na konci.

## Co se staví a co ne

- **Staví se:** bubliny velkých obchodů v reálném čase, volume profil po seancích a po dnech
  (POC, value area, volitelně rozdělení nákup/prodej) a profil, který si Filip natáhne přes graf.
- **Zdroj:** NQ (přední kontrakt), přepínač na MNQ. Graf, kotace a příkazy zůstávají na MNQ.
- **Nestaví se:** footprint, heatmapa/DOM (L2), páska, icebergy, absorpce, VWAP (už je v „levels“).

## Co je ověřené

| Tvrzení | Odkud |
|---|---|
| Lucid posílá u každého obchodu MNQ i NQ `aggressor` a `aggressor_exchange_order_id` | sonda 27. 11., `aggressor-lucid.json`, `aggressor-lucid-nq.json` |
| Dílčí obchody jednoho příkazu mají stejný čas burzy a chodí pohromadě | tamtéž (233/233 a 16/16 příkazů) |
| Jedno spojení na ticker unese odběr NQ i MNQ | druhý běh sondy |
| Služba posílá `tick` nejvýš jednou za 16 ms, telefon dostává totéž co PC | `devTradeServer.ts:318–323`, `:948` |
| Pole agresora chybí jen v mapování `handlePush` | `rithmicClient.ts:768–783` |

Neověřeno: provoz v běžné seanci (sonda běžela 75 s před otevřením), chování ticku po výpadku
spojení u druhého odběru, historie ticků z Rithmicu.

## Dotčená pravidla

- **INV-UI-04** — data jen pro zobrazení nesmí do read modelu, rozhodování ani úložišť deníku
  a nesmí přibýt další pasivní spojení. → Order flow jde **stávajícím spojením** appky se službou
  a žije v samostatném úložišti v prohlížeči, které moduly příkazů neimportují.
- **INV-UI-01** — zastaralý stav se nesmí tvářit jako čerstvý. → Po výpadku cen vrstva ukáže,
  odkdy data má („profil od 14:32“), a bubliny z doby výpadku nedomýšlí.
- INV-UI-02 a INV-UI-03 se nemění: žádná cesta příkazu, brána ani stav rizika se nedotýká.
- Jádro kopírky (ARM, kill, day lock, reconcile, outbox, relay) se nemění. Služba ale obchoduje
  naostro, proto diff služby projde před nasazením `copier-design-critic`, `code-reviewer` a Codex.

## Služba (`scripts/rithmic/devTradeServer.ts`)

Vše za přepínačem `--order-flow` (v `lucid.sh` proměnná `ORDER_FLOW=ano`), **výchozí vypnuto**.
Vypnutá služba se chová přesně jako dnes.

1. **Čtení polí.** `RithmicTick` dostane dvě nepovinná pole: `aggressor: 'buy' | 'sell' | null`
   a `aggressorOrderId: string | null`. Nic jiného se v klientu nemění.
2. **Druhý odběr.** Po `subscribeMarketData(CONTRACT)` se zjistí přední kontrakt NQ
   (`frontMonthContract('NQ','CME')`) a přihlásí se k odběru. Totéž v `scheduleFeedRestore`
   (dnes obnovuje jen `CONTRACT`, `:503`).
3. **Oddělení NQ od všeho ostatního.** Tick NQ se odkloní **před** filtrem
   `tick.symbol !== CONTRACT` (`:533`) rovnou do agregátoru a tam končí. Nesmí do:
   - `alertWatch.onTrade` — jeho regex NQ přijímá (`alertWatch.ts:63`), alert by se spustil cenou NQ;
   - `candles` — z nich berou `freshPrice` a `serverQuote` kontroly příkazů (`:679`, `:702`);
   - měření zpoždění a `tick`/`hello` zpráv (pole `price` zůstává jen MNQ).
   Tick MNQ projde dnešní cestou beze změny a navíc se předá agregátoru (čistá funkce, nic nevrací).
4. **Agregátor** `services/rithmic/orderFlowAggregator.ts` (čistá logika, bez časovačů, vzor
   `rithmicCandleBuilder.ts`):
   - přihrádky symbol × minuta × cena → `[nákup, prodej, bez strany]`; minuta ze stejného času
     jako u svíček (burza → brána → příjem), opožděný obchod ze starší minuty se zahodí stejně;
   - velké obchody: dílčí obchody se sčítají podle `aggressorOrderId`; skupina se uzavře, když
     přijde jiné číslo, nebo při nejbližším odeslání. Vznikne událost
     `{id, t, side, size, fills, priceLo, priceHi, priceVwap}`. Pokud tentýž příkaz doplní další
     dílčí obchod později, pošle se oprava se stejným `id`;
   - pokrytí: seznam úseků, kdy ceny tekly (z `feedGapFrom`), aby klient uměl přiznat díru;
   - paměť: 7 obchodních dní na symbol (jako `HISTORY_HOURS=168`).
5. **Uložení na disk** (aby profil přežil restart služby): denní soubor
   `results/orderflow-<symbol>-YYYY-MM-DD.jsonl`, jeden řádek na dokončenou minutu a na velký
   obchod, zápis vzorem `orderJournal.ts` (sériově, 0600, mazání po 14 dnech), při startu se
   načte zpět. Odhad 0,7 MB na den a symbol. Je to mezipaměť zobrazení, ne záznam deníku.
6. **Zprávy** (všechny nové typy; `tick`, `hello`, `beat` se tvarem nemění):
   - `hello.orderFlow = { symbols: { NQ: 'NQZ6', MNQ: 'MNQZ6' } }` — jen oznámení, že služba umí;
   - klient pošle `{ orderFlow: { subscribe: true, source, days } }`; zpracuje se vedle `metric`
     a `alerts-*` (vlastní malý limit, mimo rozpočet příkazů, bez dotazu na brokera, jen čtení);
   - `of-snapshot` — stav po dnech v kusech do ~200 kB;
   - `of` nejvýš 4× za sekundu — změněné buňky s **celkovými** hodnotami (opakování neškodí) a `seq`;
   - `of-trade` — velký obchod, odchází s nejbližším 16ms odesláním.
   Kdo se nepřihlásí (telefon, vypnutá vrstva), nedostane ani bajt navíc.
7. **Zpětný tlak.** `broadcast` dnes `bufferedAmount` nehlídá. Pro order flow: změněné buňky se
   drží na klienta, dokud opravdu neodejdou; při plné frontě se dávka přeskočí. Když by nešel
   odeslat velký obchod, klient dostane při dalším pokusu nový snímek.
8. **Výpis.** K minutovému řádku `[měření]` přibude: obchodů/s na symbol, bajtů/s order flow,
   nejdelší zpracování dávky v ms, rozdělení velikostí příkazů (podklad pro práh bublin).

Tick běží ve stejné smyčce událostí jako potvrzení příkazů (`rithmicPlant.ts:191`), proto je
práce v `onTick` omezená na jedno přičtení do mapy; skládání zpráv probíhá v časovači 4× za sekundu.

## Appka

1. **Úložiště mimo React** `lib/orderFlowStore.ts` (vzor `feedBox` v `useRithmicLocalTrading.ts:371`):
   přihrádky, velké obchody, pokrytí, posluchači. `onSessionReset` ho vymaže; mezera v `seq`
   = nové přihlášení k odběru.
2. **Příjem** v `hooks/useRithmicLocalTrading.ts`: tři nové větve zpráv, žádný stav Reactu
   (pravidlo ze 17. 11.: pole svíček se s tickem nemění).
3. **Čisté výpočty** s testy v `tests/`:
   - `services/orderFlowProfile.ts` — součet minut do řádků, POC, value area 70 %, delta;
     hranice seancí z `chartIndicatorSettings.ts` (Asie/Londýn/NY, Europe/Prague) a den z
     `tradingDayKey`; uzavřená seance se spočítá jednou;
   - `services/orderFlowBubbles.ts` — filtr velikosti, zařazení do svíčky zvoleného timeframu
     (`timeframeBucketStart`), poloměr.
4. **Kreslení** dvěma series primitivy (vzor FVG boxů a `useLiveFillArrows.ts`): profil
   `zOrder: 'bottom'`, bubliny `'top'`, připojené jednou z nového `components/day/useLiveOrderFlow.ts`
   volaného z `AlphaTradeChartWorkspace`. Čtou přes ref, překreslení žádají přes
   `createPrimitiveUpdateBinding`. Kreslí se jen viditelný rozsah, řádky pod 1 px se slučují,
   bublin nejvýš 300 největších.
5. **Natažený profil** jako kreslicí nástroj se dvěma body. Nejdřív zkusit bez zásahu do patche
   candle-kitu: stávající `DateRange` + příznak ve stylu „ukázat profil“, vlastní položka ve
   skupině „measure“. Když engine vlastní id bez záznamu v `TOOL_POINTS` nepřijme, přidá se nový
   nástroj do patche (obě kopie `.cjs` i `.js`). Uložení a synchronizace mezi zařízeními jdou
   zadarmo přes `chart_drawings`.
6. **Zapínání a nastavení = indikátory** (Filip 27. 11.: „udělal bych to jako indikátory“).
   Dva nové indikátory vedle FVG, levelů a struktury: **Bubliny** a **Volume profil**.
   - `AlphaTradeIndicatorSettings` (`services/chartIndicatorSettings.ts:142`) dostane sekce
     `bubbles` a `volumeProfile` se stejným tvarem jako ostatní: `enabled`, viditelnost podle
     timeframu (`IndicatorVisibilitySettings`) a vlastní volby (zdroj NQ/MNQ, práh a velikost
     bublin; profil den/seance, nákup-prodej, řádek, value area, šířka). Doplnit výchozí hodnoty
     a `mergeIndicatorSettings` (`:289`).
   - Zapínají se v nabídce „ƒ Indikátory“ na PC (`WorkspaceIndicatorMenu`,
     `CandleKitTradeChart.tsx:689`) a na stránce Indikátory v telefonu
     (`DayFullscreenChart.tsx:1546`); podrobnosti v `ChartIndicatorSettingsDialog.tsx`.
   - Zadarmo tím získají šablony grafu, synchronizaci profilu mezi zařízeními
     (`services/chartProfile.ts`) a viditelnost jen na vybraných timeframech.
   - Do lišty LIVE grafu nepřibude nic. Natažený profil je mezi kreslicími nástroji (bod 5).
   - Data mají jen LIVE grafy. Jinde (deník, backtest) indikátor Bubliny nic nekreslí;
     Volume profil tam může později běžet z minutových svíček (fáze 5).
7. **Telefon od začátku** (Filip 27. 11.). Telefon používá stejný graf, stejné primitivy
   i stejný háček spojení, takže oba indikátory tam běží hned. Rozdíly:
   - k odběru se přihlásí, jen když je některý z obou indikátorů zapnutý;
   - profil si na telefonu stáhne jen dnešní den (PC 7 dní), aby otevření grafu přes mobilní
     síť nestálo megabajty;
   - každá fáze znamená i nové sestavení appky pro iPhone;
   - zpětný tlak ze služby (bod 7 výše) je kvůli telefonu podmínkou fáze 1, ne doplňkem.

Cena NQ se kreslí na stejnou cenovou úroveň v grafu MNQ (odchylka bývá do dvou ticků);
v legendě bude vidět „OF: NQ“.

## Pořadí stavby

| Fáze | Obsah | Jak se pozná, že je hotová |
|---|---|---|
| 1 | Služba: pole, odběr NQ, agregátor, zprávy, disk, výpis; simulátor `rithmic-simulation-broker.ts` | testy; služba s vypnutým přepínačem se chová jako dnes; den zapnutého běhu dá rozdělení velikostí |
| 2 | Appka: úložiště, indikátor Bubliny na PC i telefonu | bublina do jednoho snímku po obchodu; `live:chart:tick-to-paint` beze změny; iPhone na mobilních datech |
| 3 | Indikátor Volume profil (den/seance, POC, value area, nákup-prodej) na PC i telefonu | shoda součtu profilu s objemem svíček NQ za stejný úsek |
| 4 | Natažený profil jako kreslicí nástroj | táhnutí, posun, smazání, synchronizace na druhé zařízení |
| 5 | Dopočet starších dnů z minutových svíček NQ (`timeBarReplay` bere libovolný symbol); profil i mimo LIVE | — |

Fáze 1 jde nasadit „potmě“: přepínač je vypnutý, zapíná ho Filip při restartu služby.

## Měření před a po

- appka: `live:chart:tick-to-paint` a latence klik → čára (`[data-order-line-wrap]`), doba
  vykreslení obou primitivů přes `perfTrace` (`at:dev:perf`);
- služba: řádek `[měření]` (cena burza → Mac), nejdelší dávka order flow, bajty/s;
- cesta příkazů: měřicí skripty běží proti Rithmic Test, ten ale 27. 11. odmítá přihlášení
  („permission denied“). Bez něj zbývá simulátor a porovnání časů v `orders-*.jsonl`.

## Co potřebuju rozhodnout

Rozhodnuto 27. 11.: telefon od začátku; zapínání přes indikátory, natažený profil v kreslení.

1. Výchozí profil: po seancích, nebo po dnech?
2. Práh bublin: nechat službu den sbírat rozdělení velikostí a nastavit podle něj?
3. Dopočet starších dnů z minutových svíček (přibližný, bez delty): ano, nebo jen dny s daty?
4. Rithmic Test: obnovit přístup, aby šla změřit cesta příkazů před nasazením fáze 1?

## Odchylky od návrhu (po stavbě a revizích, 27. 11.)

- **Tick jen do fronty.** Agregace neběží v obsluze ticku, ale v časovačích (16 ms / 250 ms) se stropem
  4 000 obchodů na otočku; fronta má strop 100 000 a přetečení se počítá do výpisu.
- **NQ až po startu cen grafu.** Feed vzniká synchronně jen s kontraktem grafu; NQ se dohledá a přihlásí
  potom, bez čekání (`startOrderFlowNq`), a klientům se ohlásí zprávou `of-ready`. Odběr navíc je jen na
  obchody (`bits = 1`).
- **Pokrytí po kontraktech.** Kontrakt je tekoucí až po potvrzení svého odběru; při nezdaru dva další
  pokusy (5 s, 20 s). Výpadek nechá rozdělanou minutu otevřenou jako neúplnou.
- **Menší části snímku.** Nejvýš 1 500 buněk (≈ 35 kB), jedna část jednomu klientovi na otočku, od
  nejnovější minuty; strop neodeslaných bajtů 48 kB. Důvod: order flow jde stejným spojením jako odpovědi
  na příkazy a tep, na slabém spojení telefonu by velký snímek zdržel obchodní zprávy.
- **Vypnutí po chybě není tiché.** Odběratelé dostanou `of-error`, `hello` přestane order flow nabízet.
- **Natažený profil bez nového nástroje.** Kreslí se do úseku stávajícího nástroje Časové rozpětí
  (bez zásahu do patche candle-kitu); zapíná se ručně (`volumeProfile.rangeTool`, výchozí vypnuto).
  Vlastní ikona v liště kreslení zůstává jako možné pokračování.
- **Zapínání jako indikátory** (ne záložka v nastavení grafu) a **telefon od začátku** — rozhodnutí Filipa.
- **Fáze 5** (dopočet starších dnů z minutových svíček, profil mimo LIVE) postavena není.
