# Serverový sklad svíček — zadání další fáze

Stav: **návrh k posouzení**, nic se nestaví. Připravil Claude 2026-09-26
po měření rychlosti grafu; připomínky Codexe zapracované. Stavět až po
bodech „Před stavbou“.

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

Den 1m svíček (MNQ, NQ, případně konkrétní kontrakty v týdnu rolloveru)
se stáhne z Databenta **jednou** a všechna zařízení ho pak čtou ze
serveru. Cache v prohlížeči zůstává první vrstvou.

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
5. **Klient:** `loadMarketCandles` čte nejdřív IndexedDB, pak sklad, až pak
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
2. **Licence:** ukládání dat Databenta na server a jejich poskytování dalším
   uživatelům (komerční produkt) může být redistribuce — ověřit v licenci
   konkrétního datasetu (GLBX.MDP3) a smlouvě dřív, než na tom stavíme.
3. Rozhodnout úložiště (Supabase Storage soukromý bucket vs. tabulka) a
   zámek proti souběžnému stažení.

## Rozdělení práce

- Codex: server — sklad, doplňování, zámek, zabezpečení přístupu, noční
  doplnění kompletních dnů.
- Claude: klient — pořadí vrstev v `loadMarketCandles`, měření, UI stavů.
