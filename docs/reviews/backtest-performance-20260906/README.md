# Lokální výkon backtestu — 6. 9. 2026

Rozsah: pouze lokální optimalizace po souhlasu uživatele. Produkční baseline je `cf7f98bf239edca9f704ffa465fb1b44ead9b62c`. Žádný deploy, SQL, broker akce ani přeinstalace runtime.

## Příčiny a změny

- Otevření session opakovalo synchronní analytický mapper pro všechny uzavřené obchody před ověřením trvalého zápisu. Nyní nejdřív kontroluje identity v lokální frontě/ACK a owner-scoped serverovém lookupu; skutečně chybějící obchody procházejí sériovou frontou s prioritou nových uzavření. Chybějící řádky UI mají oddělené doplnění bez přepočtu analýz.
- Automatický refresh po 2 s běžel ve vlákně grafu. I nezměněné obchody opakovaně serializovaly/hashovaly historické svíčky. Planner a mapper nyní běží v jednom workeru se slučováním požadavků, omezenými cache a kontrolami owner/run/generace/zdrojů. Původní formát hashe je zachovaný.
- Worker dostává jen potřebná pole, změněné svíčky a ledger. Poznámky, screenshoty, historie review a soukromá definice strategie se nepřenášejí. Importní graf neobsahuje React, Supabase ani úložiště.
- FVG aktualizace otevřeného HTF baru obnovovala celou historii; checkpoint před otevřenou svíčkou nyní přepočítává jen její dopad.
- Grafy sdílejí odhalený prefix, nevytvářejí budoucí osu kvůli samotné změně OHLC, nepřepojují viewport listener při každém baru a nepočítají skryté cenové čáry. Deduplicita struktury používá Set, hranice dnů přírůstkový výpočet.
- Nezměněné stavy front nezpůsobují nový render celé aplikace. Lokální ACK zachovává immutable runtime reference; cloudové odpovědi si ponechávají vlastní data. Zpracování journalu je omezené na session.

## Reprodukovatelné měření

`tests/qa/start-performance.mjs` spouští skutečný workspace a candle store nad syntetickým transportem, s prázdným env a CSP blokující vzdálené služby. Stejná fixture pro obě varianty: 80 obchodů, 3 panely 1m/5m/15m, všechny tři indikátory, přehrávání 10× a přes 16 tisíc odhalených/kontextových svíček. Pozorování rAF a Long Tasks jsou vystavená přímo v DOM; žádný přístup k internímu stavu uživatelské aplikace.

```sh
node tests/qa/start-performance.mjs
BASELINE_ROOT=/private/tmp/alphatrade-all-sessions-release-20260905 node tests/qa/start-performance.mjs
```

První port je 4186, baseline 4187; cesta `/tests/qa/performance.html`.

Měření probíhá po otevření a zahřátí. Při měření neběží build ani test suite. Jednotlivé vzorky na jednom Macu jsou důkaz tohoto scénáře, nikoli garance FPS na každém zařízení nebo skutečné uživatelské session. Syntetický transport neměří latenci Databento/Supabase.

| Scénář | Původní | Upravený |
|---|---:|---:|
| Pauza: délka vzorku | 30,2 s | 49,9 s |
| Pauza: dlouhé úlohy / blokace nad 50 ms | 14 / 1 476 ms | 0 / 0 ms |
| Pauza: největší rozestup rAF | 466,6 ms | 18,6 ms |
| 10×: délka vzorku | 40,0 s | 56,9 s |
| 10×: rAF p95 | 349,1 ms | 17,7 ms |
| 10×: snímky / sekundu (průměr rAF) | 7,4 | 56,4 |
| 10×: dlouhé úlohy | 179 | 21 |
| 10×: čas blokace na sekundu vzorku | 694,8 ms/s | 7,4 ms/s |
| Otevření: opakované zpracování 80 uložených obchodů | 80 | 0 |

Délky vzorků se liší, proto jsou blokace při přehrávání přepočtené na sekundu. Jde o interval mezi requestAnimationFrame callbacky, nikoli instrumentované časy GPU. Ani nová verze není bez všech výkyvů: maximum rAF při přehrávání bylo166,9ms. Závěrečné raw hodnoty jsou v `browser-metrics.json`.

Samostatný Node microbenchmark FVG (30 vzorků): 5m/2 800 barů p95 6,292→0,012ms; 15m/934 barů p95 1,137→0,003ms. Výstupy přesně shodné. Nejde o browser FPS.

## Funkční ověření v prohlížeči

- Otevření fixture: 80 existujících obchodů, jedna preflight dávka, žádné opakované close callbacky.
- BUY → jeden krok → ruční zavření: zůstatek50 260,80→50 259,56USD odpovídá pohybu−0,25 bodu na1MNQ (−0,50USD) a dvěma komisím0,37USD. Počet obchodů80→81; close callback přesně1.
- Zavření workspace a opětovné otevření:81obchodů, close callback stále1, zůstatek50 259,56USD, 3panely a timeframe1m/5m/15m zachované.
- Console error/warn: prázdné. Síťový zápis obchodů je v tomto browser scénáři mock; skutečný IndexedDB/ACK/provenance/cancellation kontrakt pokrývají regresní testy.
- Testovací panel metrik při prvním pokusu překrýval BUY; opraveno pouze v harnessu přes pointer-events. Skutečné kliknutí následně ověřené viditelnou pozicí a zůstatkem.

## Další prostor

První naplnění grafů a některé interakce stále mohou vytvářet dlouhé úlohy. Další smysluplné měření je layout/paint při vstupu, velké množství ručních kreseb a skutečné stahování dat. Tato změna neobsahuje předčasné zobrazování neodhalených svíček, snižování přesnosti enginu ani omezování ukládání kvůli FPS.


## Závěrečné kontroly

Hlavní projekt `/Users/filipkrejca/Documents/trading-journal-aka`: úplný TypeScript PASS; **2 463 testů / 278 souborů PASS**; produkční build PASS. Testovací běh měl neškodné upozornění na chybějící source map TypeScriptu v node_modules. Cílený lint upravených modulů bez chyb; App a UI mají starší warningy, lifecycle číselné generace má záměrné čtení aktuálního refu při cleanup.

Výkonový patch byl aplikován pod SHA-256 kontrolou předchozích souborů. Původní nesouvisející App změny zůstaly zachované. Lokální návratová kopie upravených existujících souborů: `/private/tmp/alphatrade-before-backtest-performance-20260906`. Změny jsou necommitnuté, žádný push/deploy. Localhost3001 obsluhuje hlavní projekt a novou implementaci. Izolované QA servery4186/4187 a jejich taby byly po testu zavřené.
