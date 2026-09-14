# Ranní vstup a nezařazená historie — lokální opravy 2026-09-14

Rozsah schválený uživatelem: opravit ranní vypnutí kopírky a chybějící historii.
Obnova správy otevřených pozic je výslovně odložená a není součástí změny.
Základ: produkční zdroj `f4f04147427b186075186b95819ce035635bcbc8`.
Práce je v izolovaném worktree; rozpracovaná hlavní složka zůstala zachovaná.

## 1. První pozice po potvrzeném prázdném snapshotu

Tradovate může pro flat účet vrátit úplný prázdný `position/list`. Runtime si
úplnost již pamatuje pomocí `leaderPositionSnapshotComplete`, ale přechod první
pozice používal jen přítomnost symbolu v mapě. Proto přeskočil první plnění a
při dalším dílčím plnění použil terminální epochu předchozího obchodu.

Přechod nyní používá existující svědectví úplnosti i pro chybějící symbol.
První 0 → -1 založí novou epochu, -1 → -5 → -6 ji aktualizuje a -6 → 0 přejde
do ověřování uzavření. Původní bezpečnostní blokace, generace, časování,
reconciliation, limity a pravidla broker zápisů se nemění. Disconnect a změna
skupiny dosavadní svědectví zneplatňují. Rovnost pozic sama nepotvrzuje copy
lineage; k tomu jsou nadále potřeba skutečné vazby na přijaté kopie.

Regrese `copierEntryEpochRegression.test.ts`:

- 1/6/12 followerů, předchozí resolved/invalidated epocha, partial 1+4+1 i jednorázový vstup;
- nový identifikátor epochy od prvního plnění, správné další množství a přechod do exit grace;
- chybějící/selhaný snapshot a disconnect nesmějí vymyslet počáteční nulu;
- skutečný mock OSO fan-out na 6 followerů, oba směry pořadí Fill/Position,
  potvrzené vlastnictví kopií a čtyři SL změny (24 jednotlivých modify), bez opakovaného vstupu.

## 2. Poplatky a čisté P&L v historii

`fillfee`/`cashbalancelog` nesou broker identifikátory Currency, nikoliv ISO
číselné kódy. Původní porovnání s `840` ponechávalo doložené poplatky neznámé.

Journal nově zachytí pouze `id/name/symbol` z dokumentovaného GET `/currency/list`
a rozpozná USD podle číselníku stejného připojení a prostředí. Raw broker ID se
nepřepisuje. Chybějící, smazaná či neznámá měna a směs měn zůstávají neověřené.
Číselník se čte na konci stávajícího omezeného pasivního cyklu, aby případné
pomalé čtení nebránilo zpracování fillů/poplatků. Při nadlimitním seznamu jsou
povolena jen přesná již pozorovaná ID přes `/currency/items`.

Currency je referenční entita, nikoliv doklad úplnosti historického období.
Stávající desetizdrojový status a jeho DB kontrakt zůstávají zachované.
Nové důkazy projdou existujícím sanitizerem, hashem, durable ACK a kompakcí.
Jejich přijetí zvýší ingest cursor a zneplatní starý import checkpoint; normální
import znovu promítne stejné epizody pod původními ID. Není třeba SQL migrace,
ruční přepis P&L ani nový obchod.

Regrese `journalCurrencyRegression.test.ts` ověřuje sedm čekajících pozic →
stejných sedm dokončených pozic po doplnění číselníku, duplicitní/obrácené pořadí,
kompakci, neznámé 1/840/999, jiné měny, tombstone a oddělení připojení. Ověřuje i
přednost doloženého TradePaired ledgeru před výpočtem z cen. Starší fixtures mají
nyní explicitní číselník a skutečný tvar broker ID místo předpokladu ISO kódu.

Oficiální podklad: https://api.tradovate.com/ — Currency List/Items, entity
`id`, `name`, `symbol`. ID 1 není globální konstanta USD; produkční runtime musí
skutečně načíst a uložit odpověď svého brokera.

## Ověření a hranice

Výsledky finální kontroly jsou zapsané v PROJECT_LOG. Připraven byl i samostatný
Mac bundle pomocí stejných esbuild přepínačů jako instalátor; bundle nebyl spuštěn.
Offline přehrání původních devíti scénářů incidentu prošlo po opravě ve všech
krocích bez DISARM a bez broker zápisů. Sedm skutečných uložených epizod bylo
přepočteno offline s explicitním testovacím číselníkem USD; výsledky odpovídají
částkám z incidentního auditu. To není ověření číselníku nebo importu v produkci.
Soukromá broker data a logy zůstávají mimo git v adresáři incidentu.

## Navazující nasazení — zatím neprovedeno

1. Vyžádat schválení konkrétního push na main a aktualizace Mac workeru.
2. Pro worker ověřit aktuální stav; za otevřených pozic nebo pracovních příkazů
   neprovádět restart. Před změnou uložit návratový bod, provést schválené vypnutí
   a požadovanou kontrolu. Neprovádět automatický Flatten.
3. Nejprve nasadit web/server podporující Currency evidence, poté worker se
   stejnými zdroji. Ověřit deployment READY/alias a shodu hashe workeru.
4. Ověřit skutečný capture Currency, přijetí evidence a dokončení běžného importu
   všech sedmi epizod v obou připojeních, se zachovanými ID a bez duplicit.
5. Ověřit připojení, flat/no-working, reconciliation a ponechat kopírku vypnutou.
   Živý obchod ani automatické obnovení ARM nejsou součástí této opravy.
