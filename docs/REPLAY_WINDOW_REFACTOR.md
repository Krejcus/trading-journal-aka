# Refaktor: zrušit bounded render window v backtest replay

Předávací dokument k 8. 8. 2026. Samostatný — čtenář nepotřebuje předchozí konverzaci.

---

## Cíl

Aplikace si dnes sama spravuje „okno" vykreslovaných barů a při scrollu ho posouvá,
ořezává a vyměňuje grafu data. **Zrušit to** a dát Lightweight Charts celou načtenou
sérii; virtualizaci renderu zvládne knihovna sama (je stavěná na statisíce barů).

Motivace není elegance, ale odstranění celé třídy chyb: čtyři samostatné výpočty se
musí trefit do stejného místa, a když se jeden netrefí, graf odskočí o dny.

---

## Proč je to teď reálné (a dřív nebylo)

Okno vzniklo jako obrana proti pomalému překreslování. Měření ale ukázalo, že
počet barů nebyl příčinou — pomalost dělaly kopie celého datasetu v knihovnách
a smyčka překreslování v overlayi. Po jejich opravě:

```
zásek při scrollu     68 444 ms  →  ~4 000 ms
velkých iterací*     531 868     →   54 637
```

\* iterace přes pole delší než 500 prvků, vzorkováno 1:40

**Okno tedy chránilo před problémem, který už neexistuje.**

---

## Co konkrétně odstranit

Vše v `components/CandleKitTradeChart.tsx`, pokud není uvedeno jinak:

| Symbol | Role |
|---|---|
| `replayWindowRef` | drží `startTime`/`endTime` okna |
| `renderedCandleWindow`, `replayRenderWindowIndexes` | převod času na indexy |
| `REPLAY_MAX_RENDER_BARS` | limit barů na timeframe |
| `shiftReplayRenderWindow` | posun okna při scrollu |
| `services/replayWindowTrim.ts` (`replayTrimStartIndex`) | ořez okna |
| `services/replayViewportShift.ts` (`replayBarShift`) | dopočet posunu po výměně dat |
| větev `requiresWindowReplacement` v `useLayoutEffect` | `controller.setData()` při posunu okna |
| `pendingVisibleRangeRef`, `replayViewportTargetRef` | obnova viewportu po výměně |

Spolu s nimi zmizí testy `tests/replayWindowTrim.test.ts` a
`tests/replayViewportShift.test.ts` — jsou to regrese na chování, které přestane
existovat. **Nemazat je dřív, než refaktor funguje.**

Cílový stav: `setData()` jednou při otevření session, dál už jen `updateBar()`
pro nově odhalené svíčky.

---

## Co se NESMÍ rozbít

### 1. Ochrana proti lookaheadu

Tři oddělené časové oblasti musí zůstat:

- `historicalContext` — kompletní svíčky před začátkem session,
- `revealedReplay` — svíčky postupně odhalené replayem,
- `futureData` — nedostupná pro graf, indikátory i order engine.

**Toto je jiný mechanismus než okno.** `visibleCandles` se ořezává podle replay
kurzoru (`replayCandleCountAt`), ne podle `replayWindowRef`. Refaktor se ho nesmí
dotknout.

Pozor zvlášť na HTF: 1h/4h/1d se za hranicí replaye skládají výhradně z odhalených
1m svíček (`composeReplayTimeframeCandles` v `services/marketData.ts`). Předpočítané
HTF bary jsou použitelné jen pro kontext **před** startem session.

### 2. Wick-accurate exekuce

Execution engine běží nad odhalenými 1m MNQ svíčkami a testuje stopy proti
skutečnému high/low. To je hlavní odlišení produktu (Traders Casa má jen bar-close).
Uzavřené obchody musí po refaktoru vyjít **bit-identicky** — na to existuje test.

---

## Vyvrácené hypotézy — neopakovat

Všechny byly změřeny a **nejsou** příčinou pomalosti:

| Hypotéza | Skutečnost |
|---|---|
| Kvadratika ve FVG akumulátoru | 7 ms na 10 800 svíčkách; gapy se mitigují, `active` zůstává 25–52 |
| Serializace snapshotu workspace | 13 ms celkem (1 433 volání) |
| Řazení polí | 31 906 prvků celkem přes 1 054 volání |
| Remount grafu | canvas odstraněno 0, přidáno 0 |
| Únik paměti | heap 451 → 99 MB po GC, DOM stabilní |
| Síť | zásek nastává i bez jediného requestu |

Skutečné příčiny (všechny opravené): `latestSeriesTime` a `SeriesMarkersPaneView`
kopírovaly celý dataset kvůli jedinému prvku; overlay exekucí měl smyčku
render → rozsah → render; `calculatePositionProgress` a `replayCandle` procházely
celé pole při každém překreslení.

---

## Známé chování, které refaktor má odstranit

Graf odskakuje při scrollu do historie. Hlášeno postupně jako skok na 6. 7., 3. 7.
a naposledy z 1. 7. (na minutovém timeframe, na delší stažené historii).

Poslední oprava (`5135a63`) omezuje ořez okna jen na situaci, kdy pohled sedí na
konci okna. **Nebyla ověřena na živých datech** — reprodukce vyžaduje historii před
3. 7., kterou Databento aktuálně nedotáhne. Pokud skok přetrvává, refaktor by ho měl
odstranit i tak: okno, které se nemá jak posunout, nemůže uživatele odsunout.

---

## Jak ověřovat

### Přístup

Dev server běží na **pevném portu 5273** (`.claude/launch.json`, `strictPort`).
Uživatel je na tom originu přihlášený — přihlášení je vázané na origin, takže
port neměnit, jinak se ztratí.

```
preview_start { name: "alphatrade" }
```

Backtest session: navigační tlačítko index 8 → „Pokračovat". Načtení trvá ~25 s.

### Měření výkonu

Sonda do konzole (žebříček podle místa v kódu):

```javascript
(()=>{const counts=new Map();let big=0;const wrap=(name,orig)=>function(...a){if(this&&this.length>500){big++;if(big%40===0){try{throw new Error()}catch(e){const L=String(e.stack||'').split('\n').slice(2,5).map(s=>s.trim().replace(/^at /,'').replace(/\?t=\d+/,'')).join(' <- ');counts.set(L,(counts.get(L)||0)+1)}}}return orig.apply(this,a)};['forEach','map','filter','slice','reduce','some','find','concat','sort','flatMap'].forEach(m=>{const o=Array.prototype[m];Array.prototype[m]=wrap(m,o)});let mx=0,bl=0;new PerformanceObserver(l=>l.getEntries().forEach(e=>{bl+=e.duration;if(e.duration>mx)mx=e.duration})).observe({entryTypes:['longtask']});window.__top=()=>({nejdelsiBlokMs:Math.round(mx),velkychIteraci:big,zebricek:[...counts.entries()].sort((x,y)=>y[1]-x[1]).slice(0,5).map(([k,v])=>v+'x  '+k)});window.__topr=()=>{counts.clear();big=0;mx=0;bl=0;return'ok'};return'zebricek bezi'})()
```

Postup: session → počkat na načtení → `__topr()` → scrollovat doleva do zaseknutí →
počkat, až prohlížeč reaguje → `__top()`.

Referenční hodnoty po opravách: nejdelší blok ~4 000 ms, ~54 000 velkých iterací.
Refaktor by je měl ještě snížit (odpadne `setData` a přepočty okna).

### Ověření skoku

Scrollovat doleva a **po každé dávce počkat 10–15 sekund** — skoky se projevovaly
opožděně, až po dotažení dat. Sledovat datum v popisku osy.

### Po každé změně v `node_modules` (patche)

```bash
rm -rf node_modules/.vite && npm run dev -- --force
```

Vite počítá hash závislostí z `package.json` a lockfile, ne z obsahu `node_modules`.
Cache mazat **jen když dev server neběží**, jinak spadne na „Failed to fetch
dynamically imported module".

---

## Pracovní pravidla

1. **Měřit před a po.** V předchozí session padlo šest hypotéz; rozhodlo vždy měření.
2. **Nesahat na exekuční přesnost ani na lookahead.**
3. **Ke každé optimalizaci doložit číslo.**
4. Nemazat regresní testy dřív, než náhrada prokazatelně funguje.

---

## Nesouvisející, ale otevřené

- **Databento nedotahuje nová data.** `market-candles` občas vrací chybu providera.
  Zkontrolovat kredit a platnost `DATABENTO_API_KEY`.
- **`preventDefault` v passive listeneru** — `CandleKitTradeChart.tsx`, funkce
  `handlePriceScaleWheel`. React registruje `onWheelCapture` jako passive, takže
  volání nemá účinek a zoom cenové škály kolečkem nefunguje podle návrhu. Řeší se
  registrací přes `addEventListener` s `{ passive: false }`.
- **Daily timeframe dozadu** — po zrušení okna by měl fungovat sám; ověřit.
