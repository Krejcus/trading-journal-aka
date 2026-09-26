# Serverový sklad svíček — zadání další fáze

Stav: **schváleno ke stavbě jen pro Filipa** (soukromě, žádní další
uživatelé) — Filip 2026-09-26. Připravil Claude po měření rychlosti grafu;
připomínky Codexe zapracované. Licence pro vlastní použití prověřená
(„Před stavbou“ bod 2); zbývá bod 1 (měření) a 3 (volba úložiště).

## Proč

Graf obchodu dnes bere 1m svíčky z Databenta přes edge funkci
`market-candles` a cachuje je jen v prohlížeči (IndexedDB, denní kbelíky
na 30 dní). Každé nové zařízení nebo prohlížeč platí a čeká znovu.

Naměřeno (dev, 2026-09-26):

| Situace | Čas | Cena |
|---|---|---|
| svíčky z IndexedDB (16 dní) | 54 ms | 0 |
| nový dotaz, 1 seance (1 380–2 760 svíček) | 4–6 s, výkyv 34 s | ~0,005–0,015 $ |
| nový dotaz, 16 dní (2 dotazy paralelně) | 6,2 s | 0,06 $ |

Režie je pevná na dotaz: edge funkce volá `metadata.get_cost` a pak
`timeseries.get_range` za sebou. Proto zmenšení okna nepomůže víc.

## Cíl

Den 1m svíček a hodinová řada (MNQ, NQ, případně konkrétní kontrakty
v týdnu rolloveru) se stáhne z Databenta **jednou** a všechna zařízení ho
pak čtou ze serveru. Cache v prohlížeči zůstává první vrstvou.

Největší přínos je v **backtestu**, ne v detailu obchodu: používá stejný
`loadMarketCandles` (`services/backtestCandleStore.ts`) — dopředu 1m po
třídenních úsecích pro každý nástroj zvlášť, starší historie po kusech,
vyšší timeframy z `ohlcv-1h` přes stovky dní. Každý nestažený kus je dnes
dotaz na Databento (4–6 s) a při rychlém přehrávání přes nové dny naráží na
limit 12 dotazů/min. Dál: týdenní review v jednom grafu, indikátory
s vícedenní historií (PDH/PDL, týdenní úrovně), Lab (analýzy přes všechny
obchody), telefon a starší obchody (IndexedDB vyprší po 30 dnech).

Rychlost ze skladu **není slib** (Codex): zbývá načtení detailu obchodu
(~0,7 s, 7 dotazů za sebou), výpočet indikátorů a vykreslení. Před
stavbou změřit každou část zvlášť.

## Požadavky

1. **Neveřejný sklad.** Ne veřejný bucket (URL by otevřel kdokoli).
   Čtení jen přihlášenému vlastníkovi, přes ověřený serverový požadavek
   nebo podepsaný odkaz s krátkou platností.
2. **Doplňování řídí server, ne prohlížeč.** Jeden ověřený požadavek najde
   chybějící den, zabrání souběžnému dvojímu nákupu (zámek/řádek „stahuje
   se“) a uloží ověřená data. Databento účtuje přenesená data — duplicitní
   stažení se platí znovu.
3. **Jen kompletní dny.** Den se archivuje až po dostupnosti jeho poslední
   svíčky (edge funkce dnes omezuje data na stáří 24 h; plný den ukládat
   až po této hranici), jinak by se uložil neúplný den. Historický a
   licencovaný intradenní/live přístup Databento rozlišuje.
4. **Kontrakt.** Ukládat pod skutečným symbolem (`MNQ.v.0` i konkrétní
   `MNQZ6` apod.). Graf někdy musí opustit kontinuální `MNQ.v.0` (rollover,
   viz `loadTradeMarketCandles` v `services/marketData.ts`) — sklad musí
   umět oba.
5. **Oba schémata:** `ohlcv-1m` (denní kbelíky) i `ohlcv-1h` (backtest
   HTF, stovky dní; skládat hodinovky z minutových by bylo zbytečně těžké).
   Stejná pravidla: jen kompletní období, skutečný kontrakt, zámek.
6. **Klient:** `loadMarketCandles` čte nejdřív IndexedDB, pak sklad, až pak
   Databento (přes server, který den doplní do skladu). Denní kbelíky
   zůstávají v UTC dnech jako dnes.

## Odhady (ne rozpočet)

- Cena: ~0,0075 $ za den a symbol → při ~252 obchodních dnech ~1,9 $ ročně
  na symbol. Ověřit na skutečných fakturovaných datech.
- Velikost: ~1 400 svíček/den, odhad ~20 kB zabaleně — ověřit na
  skutečných souborech.

## Před stavbou

1. Změřit zvlášť: načtení detailu obchodu, čtení ze skladu (prototyp jednoho
   dne), výpočet indikátorů, vykreslení.
2. **Licence** — ověřeno z veřejných stránek 2026-09-26 (Claude), ne právní
   posudek:
   - Databento: na historická data (T+1, starší než 24 h) licence
     potřeba není; výjimka je, když data dál distribuuješ. Práva
     k redistribuci závisí na datasetu a podmínkách vydavatele (CME);
     externí distribuce je v ceníku funkce vyššího plánu.
     (databento.com/blog/introduction-market-data-licensing, databento.com/pricing)
   - CME: „Historical Information“ = data starší 8 h. Distribuce třetím
     stranám vyžaduje licenci CME pro historickou distribuci; za Subscriber
     Feed je od 2021 poplatek 30 000 $ ročně za DCM. Poplatky za jiné typy
     (např. zobrazení grafů uživatelům appky) se z veřejných zdrojů nepodařilo
     ověřit — PDF CME blokuje automatické stažení.
   - Závěr: **soukromý sklad jen pro Filipův účet = vlastní použití
     historických dat → lze stavět.** Komerční appka pro další uživatele je
     distribuce CME dat **už dnes** (každý uživatel by bral svíčky přes naši
     edge funkci a Filipův klíč), se skladem i bez něj → před spuštěním
     pro další uživatele vyřešit s Databento/CME (licence, nebo vlastní
     datový účet každého uživatele).
3. Rozhodnout úložiště (Supabase Storage soukromý bucket vs. tabulka) a
   zámek proti souběžnému stažení.

## Rozdělení práce

- Codex: server — sklad, doplňování, zámek, zabezpečení přístupu, noční
  doplnění kompletních dnů.
- Claude: klient — pořadí vrstev v `loadMarketCandles`, měření, UI stavů.
