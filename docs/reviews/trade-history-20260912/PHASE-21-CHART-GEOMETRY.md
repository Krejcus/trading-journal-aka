# Fáze 21 — přesné časy a mezery v grafu

Lokální implementace v izolované pracovní kopii. Bez nasazení, změny brokeru, vzdálené databáze či workeru.

## Změna

Historie má společné promítání časů pro position box, ochranné čáry a značky plnění. Zlomky sekundy se promítají mezi celočíselnými sloty svíček. Nejde o dopočítávání ceny uvnitř svíčky. Přesný konec nepokryté minuty se již nemapuje na začátek další existující svíčky za mezerou. Chybějící části a časy mimo načtený rozsah nejsou extrapolované od posledního dostupného baru.

Čára se rozdělí podle skutečně načtených úseků. Doložená část tedy nezmizí jen kvůli tomu, že druhý konec leží mimo dostupné svíčky. Malý vizuální řez odděluje části na komprimované obchodní ose; značky konkrétních událostí se tímto řezem neposouvají. Stále platí dřívější pravidla pro broker potvrzení, zamítnutí, rozpory a výpadky evidence.

Position box využívá existující CandleKit DrawingPrimitive a barvy/nastavení stejného position nástroje jako backtesting. Samostatný uzamčený model pouze nahrazuje veřejné screen anchors přesným časovým promítnutím. Nemění ruční kresby ani společný kreslicí engine a do svíčkové série nevkládá smyšlené časové body. Riziková a cílová plocha se rozdělí na dostupné úseky, včetně výpadků záznamu. Původní automatický journal box se již nevkládá do obecného engine s extrapolací časů.

Barevný box slouží jako reference prvních doložených SL/TP vůči prvnímu vstupnímu plnění, jak vysvětluje legenda. Není tvrzením, že původní SL zůstal aktivní do výstupu. Historický průběh ukazují samostatné potvrzené čáry. Reference nevychází z pozdějšího scale-in průměru. Neplatné či cizí ochrany, SL/TP na nesprávné straně vstupu, rozporné současné počáteční ceny nebo neuzavřená pozice box nevytvoří; renderer nesmí původní ceny opravit normalizací na smyšlený bracket.

Staré ENTRY/EXIT šipky přichytávané k nejbližší svíčce se pro evidenční historii nepoužívají. Tečky a jejich popisky čerpají přímo z přesného času vlastního plnění. Pokud tento čas nemá načtenou svíčku, značka se neposune jinam. Plnění a ochranná událost zůstávají v časovém seznamu.

Vyšší timeframe se kontroluje také proti původním minutovým datům, která TradeMarketChart skutečně načítá. Chybějící minuta se tak neschová uvnitř existující agregované 5m svíčky. Samotný OHLC agregované svíčky se tímto nemění ani nedopočítává. Seznam upozorní na počet událostí mimo načtené svíčky. Aktuální journal zdroj má smluvený interval 1m; případný budoucí jiný zdroj musí předat odpovídající coverage interval.

## Náhled

`mockups/journal-preview` umožňuje přepnout souvislá data, dvě chybějící minuty s třemi SL změnami a chybějící vstupní/výstupní svíčku. Interval 1m/5m používá skutečnou agregaci aplikace. Výchozí karta Screenshoty zůstává zachovaná.

Browser ověřil skutečné komponenty: reference box bez přehazování časů, rozdělený box uvnitř 5m svíčky a tři uložené SL časy leadera 15:34:04,125 / 04,635 / 44,400. Po přepnutí na individuální Účet 2 byly časy 15:34:04,136 / 04,646 / 44,411, čisté P&L 27,52 USD, vstup 15:30:12,196 za 20109,25 a výstup 15:42:30,830 za 20116,75 při 2 kontraktech. Bez vstupní/výstupní svíčky jsou čtyři události mimo pokrytí; jejich přesné záznamy zůstávají dostupné. Všechna tato data jsou fiktivní.

## Ověření

31 testů v pěti souborech prošlo. Nové testy kromě čisté časové geometrie přímo vykonávají skutečný CandleKit renderer a kontrolují vykreslené obdélníky. Zahrnují zlomky sekund, dva účty s rozdílnými časy, 1m/5m, chybějící surovou minutu v 5m, neúplné okraje, chybné/otevřené mezery, short reference, nejednoznačné současné vstupy a odmítnutí nesprávných SL/TP. Vykonávají také skutečný renderer SL/TP, kontrolují rozdělené cesty a absenci přesunutého markeru v chybějící minutě. Dřívější protection/history/chart-detail a backtest managed-position regrese prošly.

TypeScript, scoped ESLint a Vite/PWA prošly bez chyb. Čtyři existující warningy v CandleKitTradeChart zůstávají; nové soubory jsou bez warningů. Build má 90 precache entries. Diff check čistý. Testování s reálným brokerem, přihlášeným backendem a skutečnými candle daty se neprovedlo; předchozí lokální detail neměl Databento klíč a tato fáze ho nedoplňovala.

## Další práce

Zbývá audit R ve statistikách a neveřejných social projekcích, limity rozsáhlé finanční projekce, skutečný owner raw-to-UI průchod a závěrečný audit požadavků. Pro delší obchody je také potřeba zkontrolovat načítané tržní okno kolem entry/exit; současný graf nesmí nedostupné okraje maskovat. Produkční aktivace včetně migrací, zálohy/advisors a worker instalace vyžaduje samostatné schválení. Celkový cíl zůstává aktivní.
