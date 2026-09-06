# AlphaTrade: plán rozvoje backtestu

Stav k 5. 9. 2026. Návrh vychází z aktuálního canonical kódu, druhého auditu, localhost UI a níže uvedených primárních zdrojů. Jde o produktový a technický návrh, nikoli o již implementované funkce. Relativní velikosti nejsou časové ani cenové závazky.

## 1. Doporučený směr

AlphaTrade může být velmi silný nástroj pro diskréčního NQ/MNQ tradera, který potřebuje odpovědět na tři otázky: **Mám opakovatelnou výhodu? Dodržuji svůj postup? Co mám konkrétně trénovat?**

Nosný celek: definice hypotézy → příprava → neviděný replay → záznam rozhodnutí → spolehlivé vyhodnocení → nezávislé ověření → cílený trénink. Každé číslo má dohledatelné obchody, pravidla a kvalitu dat. Nové moduly mají používat existující Lab, Coach, journal a replay.

Pro orientaci v trhu: oficiální nabídka FX Replay již uvádí replay, více grafů, Monte Carlo, AI Mentor, vlastní skripty a prop simulátor. Samotná přítomnost těchto položek proto není výrazný produktový rozdíl. Zde ověřuji jen nabídku funkcí na webu, nikoli jejich kvalitu. [FX Replay](https://fxreplay.com/)

Navržená specializace AlphaTrade je propojení **konkrétního rozhodnutí, jeho tehdejších důkazů, exekuce, poznámky, experimentu a následného tréninku**. Vše v jednom pracovním postupu.

## 2. Co již existuje a na co navázat

| Oblast | Dnešní stav | Potřebné rozšíření |
|---|---|---|
| Replay a ruční obchodování | Market/limit/stop, SL/TP, partial, scale-in, více grafů, časové kroky a Go To | Shodná exekuce všech analytických variant, příčinně správná data mimo samotný graf |
| Ukládání | Session lifecycle, lokální/cloudový postup, workspace dokument, kresby a indikátory | Atomické konflikty, společná knihovna šablon, import preview a obnova |
| Review | Poznámky, screenshoty, validita, vlastní tagy, ruční setup, auto konfluence a přepočet | Evidence všech rozhodnutí, revize a fronta review |
| Lab | Counterfactual, MFE/MAE, execution path, bias, leaky, psychologie a experimenty | Stejná metodika exekuce, výzkumné verze, OOS, nezávislost vzorků |
| Monte Carlo | Empirický bootstrap i samostatná parametrická simulace | Jasné předpoklady, bloky dní/pozic, čistá expectancy, reprodukovatelnost |
| Coach | Oddělený live/backtest, deterministické statistiky, aktuální detaily, podobné obchody a paměť | Časová hranice během replaye, důkazové odkazy, plán cvičení |
| Příprava a deník | Bohatší workflow v live, starší backtest pre/post poznámky | Příprava a debrief přímo u nového replay runu |
| Export | JSON obchodů a kompletního workspace | Společný úplný formát s tagy, identitou, verzemi a manifestem dat |

Existence v kódu není důkaz spolehlivosti za všech okolností. Otevřené chyby jsou v [auditu](README.md).

## 3. Osm návrhů s největším přínosem

### A. Výzkumný případ a verze pravidel

Rozšířit existující experiment: hypotéza, přesný vstup, invalidace, management, zakázané situace, primární metrika, plánovaný vzorek a podmínka zamítnutí. Třeba: „Po reakci na level porovnám původní SL s BE po 1R; vstupy a velikost pozice zůstanou stejné.“ Jde o ukázku hypotézy, nikoli tvrzení o aktuálním playbooku uživatele.

Změna pravidla vytváří novou verzi. Technické `revision` uložené session nesmí zastupovat verzi hypotézy. Obchod nese vazbu na experiment a konkrétní verzi; zařazení se neurčuje pouhým porovnáním historického data s dneškem. Zvlášť se ukládá čas trhu, čas provedení tréninkového rozhodnutí a revize pozdější poznámky.

**Hotovo, když:** dnes vytvořený experiment správně zahrne dnešní replay srpna; změna pravidel zpětně nemění původní výsledky; každý výsledek ukáže použitou verzi.

### B. Neviděný test a walk-forward

Uživatel předem vybere vývojové období a uzamkne oddělené ověřovací období. Aplikace eviduje, které dny už byly zobrazeny, přeskočeny nebo vyhodnoceny. Po prohlédnutí testu a změně pravidel jde o další pokus; původní test se nesmí znovu tvářit jako neviděný.

Walk-forward pak uspořádá opakované vývojové a následující testovací bloky do jedné časové osy. První verze může řídit ruční replay. Automatický optimalizátor není podmínkou. Princip posouvání vývojového okna a testování navazujícího období má oporu v [dokumentaci QuantConnect](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization).

**Hotovo, když:** každý bod OOS křivky pochází z pravidel zmrazených před daným testovacím blokem; opakované prohlédnutí je viditelné. U překrývajících se obchodů/labelů se oddělí také jejich informační horizont.

### C. Záznam všech rozhodnutí

Čtyři rychlé akce u replaye: „vzal“, „záměrně vynechal“, „zmeškal“, „žádný setup“. Uloží cursor, tehdy dostupný kontext, důvod, volitelnou poznámku a screenshot. Zapsat i správné nevstoupení. Rozlišit dodatečně objevenou příležitost od té skutečně rozpoznané v průběhu replaye.

Současný `Missed` obchod je dobrý základ, ale neposkytuje celý počet posouzených příležitostí. Nový rozhodovací záznam není finanční transakce a nemění P&L.

**Hotovo, když:** lze porovnat počet rozpoznaných, zobchodovaných a vědomě odmítnutých situací; jejich otevření obnoví přesný čas a dostupný kontext. Ručně označené příležitosti nejsou prezentované jako všechny objektivní příležitosti na trhu.

### D. Férové porovnání managementu

Na stejném vstupu porovnat původní bracket, vlastní trailing, BE, partial a pevné cíle. Existující counterfactual rozšířit o společné poplatky, gapy, cutoff, velikost pozice a nejistotu intrabar průběhu. Vedle součtu zobrazit párový rozdíl po obchodech: kde varianta pomohla, kde uškodila a na jakých datech nebylo možné rozhodnout.

Výběr nejlepší varianty zvlášť u každého historického obchodu je zpětné optimum se znalostí výsledku. Nelze jej označit za obchodovatelnou strategii. Testovat stejné předem určené pravidlo přes celý vzorek.

**Hotovo, když:** nezměněný bracket reprodukuje původní engine včetně nákladů; varianta vybraná ve vývoji má zvlášť výsledek na neviděném vzorku; nejednoznačné případy nezmizí z reportu.

### E. Důvěryhodnost dat u každého výsledku

U obchodu zobrazit zdroj, skutečný kontrakt, rozlišení, chybějící intervaly, nejednoznačnost fillu a verzi dat. U session souhrn pokrytí s možností otevřít problematický úsek. Rozlišit uzavřený trh, nulové obchody a chybějící data; neodvozovat vše jen z rozestupu timestampů.

Datová pyramida: starší HTF kontext → minutový replay → jemnější data jen pro citlivé intervaly. Minutové OHLC neříká, zda nejprve přišel SL nebo TP. TradingView proto pro Bar Magnifier používá nižší timeframe, přičemž i toto pokrytí má omezení. [TradingView Bar Magnifier](https://www.tradingview.com/support/solutions/43000669285-what-is-bar-magnifier-backtesting-mode/)

Ani sekundové bary vždy neurčí intrabar pořadí. Skutečné obchody/quotes mohou zlepšit důkaz; přesnou pozici vlastního příkazu ve frontě nelze slíbit z OHLC. Dostupnost jemnějších dat a jejich použití podléhá konkrétnímu datovému zdroji a existujícím oprávněním.

**Hotovo, když:** odstranění obchodovatelné minuty zneplatní dotčený odhad; deklarovaná burzovní přestávka ne; nové přepočítání zachová starý výsledek i důvod změny.

### F. Trénink naslepo a větvení scénářů

Losovat neviděné dny; volitelně skrýt konkrétní datum a historický název kontraktu, zachovat však hodinu/session a potřebné obchodní podmínky. V testovacím režimu zamknout výsledky budoucích variant, podobné historické obchody odhalující výsledek i AI znalost dalšího průběhu. Přístup k výsledku ukončí slepou část pokusu.

Samostatný tréninkový režim dovolí od uloženého rozhodnutí vytvořit větev: např. dvě varianty řízení stejné pozice. Nová větev má jasného rodiče a nezapočítá se jako nezávislý OOS obchod. Běžná duplikace session od začátku tuto funkci dnes nenahrazuje.

**Hotovo, když:** změna všech budoucích svíček nezmění nic dostupného během slepého pokusu; větev má stejný výchozí ledger, ale vlastní další události.

### G. AI debrief, který ukazuje důkazy

Akce „Analyzovat toto review“ předá aktuální revizi poznámky, tagy, související obchod a vybraný kontext. Výsledek má odkaz na konkrétní rozhodnutí nebo citovaný úsek poznámky. Statistická čísla bere z deterministických funkcí. Tvrzení „spěchal jsi“ musí doložit; samotný rychlý vstup nebo ztráta nestačí.

Během replaye platí hranice dostupných dat. Po dokončení lze výslovně přepnout na plný debrief, který už hodnotí i další průběh. AI má umět rozlišit, co uživatel napsal před vstupem a co až po výsledku. Dlouhé poznámky se stránkují či strukturují, neřežou uprostřed JSON.

**Hotovo, když:** editovaná poznámka je v novém rozboru dohledatelná v aktuální revizi; každý číselný závěr lze otevřít na zdrojových obchodech; nedostupné údaje jsou přiznané. Zde se navrhuje rozhraní; nové automatické přenosy ani vzdálené AI volání nebyly spuštěny.

### H. Statistiky, které ukazují nejistotu

Vedle WR/PF/R zobrazit počet pozic/rozhodovacích jednotek a počet dní, intervaly odhadů a citlivost na nejlepší obchody. Partial výstupy ze stejné pozice jsou účetní položky, nikoli automaticky nezávislé výzkumné vzorky. Resampling celých pozic nebo dní pomůže zachovat část jejich závislosti; zvolený blok a předpoklady musí být vidět.

Evidovat také počet vyzkoušených variant. Vybírání nejlepšího výsledku z mnoha pokusů zvyšuje riziko přeučení; vysvětluje to práce [The Probability of Backtest Overfitting](https://carmamaths.org/resources/jon/backtest2.pdf). Pokročilé ukazatele typu Deflated Sharpe dávají smysl až s odpovídající řadou výnosů a historií pokusů, nikoli jako dekorativní známka kvality. [Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)

**Hotovo, když:** rozdělení stejného výstupu na deset partialů nevytvoří deset nezávislých vzorků; zvýšení poplatků sníží čistou expectancy; „30 obchodů“ není samo o sobě označení pro prokázanou výhodu.

## 4. Backlog 48 konkrétních možností

Priorita **A** = první navazující rozvoj po opravách, **B** = další vlna, **C** = pozdější experiment. Velikost **S** = menší lokální rozšíření, **M** = několik propojených částí, **L** = nový průřezový workflow, **XL** = vlastní subsystém. Rozšíření využívá existující základ; „nové“ znamená chybějící produktový celek, nikoli nutně nulový použitelný kód.

### Data, exekuce a spolehlivost

| ID | Funkce | Typ / priorita / velikost | Podmínka dokončení |
|---|---|---|---|
| 01 | Manifest kvality dat a badge u obchodu | Rozšíření / A / M | Výsledek odkazuje na zdroj, kontrakt, rozlišení, díry a datovou verzi; nekompletní cesta není kompletní výsledek. |
| 02 | Jemnější ověření citlivých svíček | Nové / B / L | Zadaný limit datové spotřeby, žádné domýšlení ticků; chybějící detail ponechá interval možných výsledků. |
| 03 | Společné execution profily | Rozšíření / A / L | Replay, counterfactual a dávkový test dávají při shodných pravidlech stejné filly, poplatky a P&L. |
| 04 | Kalendář, DST, kontrakty a rollover | Rozšíření / A / M | Run nese konkrétní roll politiku; syntetický skok spojitého kontraktu se neúčtuje jako pohyb jedné držené pozice. |
| 05 | Timeline celé pozice | Rozšíření / A / L | Entry, scale-in, partial, posun SL a exit mají společné position ID, čas a důvod; MFE/MAE respektuje tehdejší množství. |
| 06 | Knihovna pojmenovaných workspace šablon | Rozšíření / A / M | Save, Load a Nová session sdílejí knihovnu; lze nastavit výchozí šablonu pro další run. |
| 07 | Stav synchronizace a obnova konfliktu | Rozšíření / A / M | Uživatel vidí lokálně uloženo/cloud potvrzeno/konflikt; oba soupeřící návrhy zůstanou obnovitelné. |
| 08 | Preview importu a návrat k předchozí verzi | Rozšíření / A / M | Import předem ukáže nekompatibilní instrumenty/nastavení; neplatný dokument nezmění aktuální workspace. |

### Výzkum, robustnost a statistiky

| ID | Funkce | Typ / priorita / velikost | Podmínka dokončení |
|---|---|---|---|
| 09 | Výzkumný případ s verzemi pravidel | Rozšíření / A / L | Hypotéza a pravidlo jsou svázané s konkrétními runy; oba časy a pozdější změny jsou dohledatelné. |
| 10 | Uzamčený neviděný vzorek | Nové / A / L | Viditelné IS/OOS a historie odhalení; prohlédnutý výsledek nejde označit jako nový slepý test. |
| 11 | Walk-forward plánovač | Nové / B / L | Každé ověřovací okno používá předem zmrazenou verzi; jedna agregovaná OOS křivka bez vývojových obchodů. |
| 12 | Párové porovnání SL/TP/BE/trail/partial | Rozšíření / A / M | Delta R i dolary po stejných rozhodnutích; shodné náklady a pokrytí; viditelné nejednoznačné případy. |
| 13 | Stres nákladů a zpoždění | Rozšíření / A / M | Tabulka poplatek/slippage/zpoždění ukáže bod, kde výsledek přestává vycházet; mění skutečnou exekuci, nejen závěrečný štítek. |
| 14 | Mapa stability parametrů | Nové / B / M | Zobrazení okolních hodnot odhalí izolovaný nejlepší bod; každý vyzkoušený parametrický pokus se eviduje. |
| 15 | Intervaly nejistoty a blokový bootstrap | Rozšíření / A / M | Volba pozice/den, počet bloků, seed a limity metodiky; partial slicing nemění nezávislý počet vzorků. |
| 16 | Závislost výsledku na výjimečných obchodech | Nové / A / S | Výsledek s/bez top 1/3/5 zisků a nejlepších dní; jde o citlivost, nikoli důvod mazat výhry z historie. |
| 17 | Prop challenge simulátor | Nové / B / L | Zadané/verzované DLL, trailing, target a consistency; přesný okamžik a důvod porušení pravidla. |
| 18 | Sjednocený risk lab | Rozšíření / B / M | Jasný rozdíl cash/fractional sizing, insolvence/drawdown/prop breach; žádná záporná velikost rizika. |
| 19 | Uložené filtry a srovnání skupin | Rozšíření / A / M | Filtr podle verze setupu, tagu a datové kvality uloží definici i počet záznamů; při změně filtru je jasné, co se změnilo. |
| 20 | Funnel příležitostí | Nové / B / L | Rozpoznáno → validní → vzato/vynecháno → dodrženo; oddělené pokrytí ručního a pravidlového sběru. |
| 21 | Režimy trhu a podobné dny | Rozšíření / B / M | ATR/gap/trendové znaky se počítají jen z dat dostupných před rozhodnutím; konečný denní range není předvstupní filtr. |
| 22 | Časové heatmapy s velikostí vzorku | Rozšíření / B / S | Session/DST, hodina a den týdne; u každé buňky N a nejistota, žádná samotná zelená při jednom obchodu. |
| 23 | Přehled dodržování pravidel | Rozšíření / A / M | Oddělený proces a výsledek: správně provedená ztráta nezíská horší procesní hodnocení jen kvůli P&L. |
| 24 | Hodnocení setupu před výsledkem | Nové / B / M | A/B/C či vlastní škála se zamkne před vstupem; následná editace je viditelná jako retrospektivní. |

### Workflow a trénink

| ID | Funkce | Typ / priorita / velikost | Podmínka dokončení |
|---|---|---|---|
| 25 | Příprava → replay → debrief | Rozšíření / A / M | Plán uložený před prvním rozhodnutím; na konci konkrétní porovnání plánu a provedení. |
| 26 | Jednoklikový deník rozhodnutí | Rozšíření / A / M | Vzal/vynechal/zmeškal/žádný setup; screenshot, cursor a důvod bez změny P&L. |
| 27 | Balíčky neviděných dní | Nové / B / L | Losování z neviděného poolu, historie expozice a výslovné odhalení; analytika předčasně neprozradí výsledek. |
| 28 | Větev scénáře od cursoru | Nové / C / XL | Stejný výchozí stav včetně pozice a příkazů, parent/child vazba; větve se neduplikují v hlavních statistikách. |
| 29 | Cvičení konkrétní dovednosti | Nové / B / L | Např. čekání na potvrzení či vynechání neplatného setupu; hodnotí rozhodnutí a pokrok na nové sadě. |
| 30 | Záložky událostí v replayi | Rozšíření / A / S | Značka s názvem/poznámkou a návratem na čas; při zkoušce nesmí skok zpřístupnit zakázanou budoucnost. |
| 31 | Fronta review, Uložit a další | Rozšíření / A / M | Filtr chybějících položek, vlastní draft na každý trade ID, klávesové procházení; chyba uložení zachová draft. |
| 32 | Poznámka před/v průběhu/po obchodu | Rozšíření / A / M | U každého textu čas vytvoření a revize; AI i analýza rozliší plán od zpětné interpretace. |
| 33 | Správa vlastních tagů | Rozšíření / A / M | Kategorie setup/chyba/kontext, aliasy a sloučení s náhledem dotčených obchodů; mazání má jasně určený dosah. |
| 34 | Vysvětlení automatického tagu | Rozšíření / A / M | Kliknutí ukáže pravidlo, level, hodnotu, timeframe a čas potvrzení; ruční interpretaci přepočet nepřepíše. |

### AI, vyhledávání a rozšířený výzkum

| ID | Funkce | Typ / priorita / velikost | Podmínka dokončení |
|---|---|---|---|
| 35 | Coach s hranicí replay času | Rozšíření / A / L | Změna budoucích dat nemění kontext během cvičení; po debrief přepnutí může použít další průběh. |
| 36 | AI oponent hypotézy | Nové / B / M | Před testem pojmenuje měřitelnost, možné zkreslení a podmínku vyvrácení; nerozhoduje o vstupu za uživatele. |
| 37 | Rozbor timeline s odkazy na důkazy | Rozšíření / A / M | Poznámka, plán, změny SL a výstup jsou v časovém pořadí; každý závěr odkazuje na dostupný podklad. |
| 38 | Osobní tréninkový plán | Rozšíření / B / M | Z opakovaného problému vznikne cvičení s cílem a novým kontrolním vzorkem; změna měřena po dovednosti. |
| 39 | Hledání podobných rozhodnutí | Rozšíření / B / M | Aktuální poznámky a tagy, vysvětlení podobnosti; možnost filtrovat pouze situace známé před vstupem. |
| 40 | Pravidlový vyhledávač situací | Nové / C / L | Uživatel zvolí měřitelné podmínky, finder přehraje data kauzálně a vypíše kandidáty; eviduje i zamítnuté případy. |
| 41 | Vizuální sestavení a dávkový test pravidel | Nové / C / XL | Omezený slovník přesných podmínek a stejný engine; diskreční pravidlo se nepředstírá jako automaticky testovatelné. |

### Reporty, rychlost a rozšiřitelnost

| ID | Funkce | Typ / priorita / velikost | Podmínka dokončení |
|---|---|---|---|
| 42 | Ověřitelný výzkumný balíček | Rozšíření / A / M | Report + JSON/CSV + manifest pravidel/dat/engine + ID zdrojů; uvedené vynechané záznamy a důvody. |
| 43 | Fronta porovnání více runů | Nové / B / M | Zvolené varianty, průběh, zrušení a obnovení; žádné smíchání neúplného jobu s hotovým výsledkem. |
| 44 | Plynulost dlouhých session | Rozšíření / B / M | Měřený referenční scénář více grafů/kresby/historie; rozpočet paměti a odezvy, pozadí neblokuje ovládání. |
| 45 | Klávesové ovládání a command menu | Rozšíření / A / S | Obchod, review, záložka a další krok bez myši; psaní poznámky nikdy nespustí trading hotkey. |
| 46 | Šablony kontextu NQ/MNQ | Rozšíření / B / M | Stejný čas, jasně označený execution symbol, viditelné chybějící kontextové údaje; vazby nepředstírají další exekuci. |
| 47 | Historické makro události | Nové / B / M | Během replaye jen tehdy zveřejněné údaje a plánovaný čas; dodatečné revize/actuals až po jejich publikaci. |
| 48 | Výzkum více instrumentů/portfolia | Nové / C / XL | Nejprve ledger a MTM více pozic; společná měna, náklady a čas. Dva grafy dnes neznamenají portfolio engine. |

## 5. Pořadí realizace

### Vlna 0 — správná čísla a zachování dat

Uzavřít otevřené nálezy z auditu: hranice budoucích dat, exekuční shoda, neúplné cesty, scale-in metriky, ztracená nejistota, Monte Carlo náklady/insolvence, review a template konflikty, screenshot read failure, legacy cleanup, propojení layoutu, import a úplný export. Oddělit čas experimentu od data trhu. Základní hranice budoucích dat musí platit pro všechny UI, journal i AI vstupy už v této vlně; je podmínkou označení dalšího pokusu jako slepého/OOS.

Výstup: regresní testy očekávané opravy, shodné účetní a analytické výsledky, zachování obou verzí při konfliktech. Kontrola cloudové souběžnosti až s odpovídajícím testovacím prostředím; lokální mock ji nenahrazuje.

### Vlna 1 — každodenní užitek

Prioritně 06, 25, 26, 31, 32, 33/34 a základ 09: jednotná šablona, příprava/debrief, rozhodovací deník, rychlé review, poznámky v čase a vysvětlitelné tagy. Základ 05 zajistí identitu pozice pro následné statistiky.

Výstup: celý den lze od přípravy po uzavření zpracovat bez ručního přepisování; každé rozhodnutí a poznámka jsou dohledatelné a bezpečně uložené.

### Vlna 2 — spolehlivý výzkum

01, 03, 09/10, 12/13, 15/16, 19/23 a 42: datový manifest, jednotná exekuce, verze/OOS, porovnání managementu, stres, nejistota a výzkumný report.

Výstup: jeden zvolený setup projde předem stanoveným testem od hypotézy po nezávislý výsledek; report reprodukuje čísla a ukáže omezení.

### Vlna 3 — trénink a pokročilé nástroje

27/29, rozšířený 35/37/38, následně 11/17 a selektivně 02: slepý trénink, dovednostní cvičení, časově omezený Coach, walk-forward, prop pravidla a jemnější data. Až podle přínosu přidat větvení, finder a pravidlový builder.

Výstup: Coach z doloženého opakovaného problému sestaví cvičení a měří zlepšení na nových situacích. Předchozí testové dny se automaticky netváří jako nové.

## 6. Důležité konstrukční podmínky

- **Tři druhy času:** tržní timestamp, okamžik tréninkového rozhodnutí a čas/revize pozdější anotace. Navíc `availableAt` pro odvozený indikátor nebo událost: swing známý až po potvrzovacích svíčkách nesmí být použit jako tehdejší potvrzený swing.
- **Identita:** run, experiment/verze, rozhodnutí, pozice, fill a review revize mají stabilní vazby. Účetní pohled s partialy a výzkumný pohled na rozhodnutí jsou dva explicitní pohledy nad stejným ledgerem.
- **Historie změn:** recalculation nevymění starý výsledek beze stopy; uloží důvod, engine/data verzi a rozdíl. Stejně musí být dohledatelné ruční přeznačení tagu po výsledku.
- **Šablona versus checkpoint:** šablona definuje nástroje a uspořádání; checkpoint obsahuje konkrétní čas, příkazy a průběh session. Při zakládání runu nesmí náhodně přenést předchozí účetní stav.
- **Souběh:** serializace v jednom browseru není ochrana proti druhému zařízení. Společné mutable dokumenty potřebují atomický patch nebo podmíněný zápis se serverovou revizí a řešením konfliktů.
- **Spojité kontrakty:** Databento continuous symbology mapuje skutečné tradovatelné kontrakty a zachovává jejich původní neupravené ceny; identita kontraktu a roll politika proto patří do manifestu. [Databento continuous contracts](https://databento.com/docs/examples/symbology/continuous)
- **AI a anotace:** uživatelský text je důkaz k analýze, ne systémový příkaz. Retrospektivní tag „chybný vstup“ se nesmí nevědomky proměnit v filtr, který jako by byl známý před vstupem. Aktuální detail a úplný export mají společný verzovaný kontrakt.
- **OOS není magické razítko:** evidovat všechny pokusy, úniky informací a míru závislosti vzorku. Interval z malé nebo nevhodně vybrané historie nedokazuje budoucí výnosy.
- **Výkon:** zachovat paint-only úpravy vzhledu bez rebuild/autoscale/reset viewportu; benchmark vybrat před změnou a měřit na stejném scénáři. Datové přenosy omezovat na potřebné rozlišení/interval.

## 7. Co odložit a proč

- Další desítky indikátorů před opravou existujících metrik: užitek nového signálu nelze posoudit na nespolehlivém vyhodnocení.
- Jedno souhrnné „AI skóre tradera“: skrývá podklady a směšuje kvalitu procesu s krátkodobým výsledkem.
- Automatické hledání nejlepší strategie bez registru pokusů/OOS: roste prostor pro náhodně hezký výsledek.
- Plný tick/MBO dataset pro veškerou historii: nejdřív selektivně ověřit, kde vyšší rozlišení skutečně mění závěr; footprint nelze věrohodně vyrobit z OHLC.
- Reálné portfolio/mnoho nových trhů před stabilním NQ/MNQ workflow: výrazně rozšiřuje účtování a datové nároky.
- Herní body za profit nebo trade streak: preferovat konkrétní dodržení pravidla a tréninkový pokrok.

## 8. Ukázka cílového průchodu

1. V Lab založím hypotézu a zmrazím variantu pravidla; určím i to, co by hypotézu vyvrátilo.
2. Vyberu vývojový pool a oddělené neviděné ověření, execution profil a požadované pokrytí dat.
3. Session převezme mou pojmenovanou šablonu; před otevřením zapíšu plán a zakázané situace.
4. Během replaye zaznamenám vstup i vědomé vynechání. Každé rozhodnutí zachová tehdejší kontext.
5. Po uzavření obchodu doplním review. Plný debrief včetně dalšího průběhu přijde až po ukončení slepé části session; samotné zavření obchodu ji neukončuje. AI odkazuje na konkrétní dostupné důkazy.
6. Porovnám management na stejných vstupech a zkontroluji náklady, mezery v datech a citlivost na několik velkých výher.
7. Vybranou variantu beze změny otestuji na neviděném bloku. Po odhalení už není tento blok neviděný.
8. Získám report, co test podpořil, co zůstává nejisté a kterou dovednost trénovat příště. Všechny závěry lze otevřít na konkrétních rozhodnutích.
