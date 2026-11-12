# Společný stav LIVE pro web a iPhone — 12. 11. 2026

Stav: hlavní oprava je nasazená v produkci od 12. 11. 2026 přibližně 07:47 SEČ,
první produkční commit `4aa2de5b`. Migrace `20261112064034` je aplikovaná.
Zdrojová větev: `codex/shared-live-state-20261112` nad `30f87879`.
Žádný skutečný obchod, změna skupiny, ARM/DISARM, restart nebo reinstall workeru.

## Co se změnilo

Stávající API `preflight`, `live-pnl`, `history` a `history-sync` používají společný
stav v Postgresu. Sdílení platí přes serverové instance i zařízení, ne pouze
uvnitř krátce žijící procesové Map. Klíčem je vlastník, broker identita,
prostředí, skutečné hosty, přidělený scope a typ dat. Neznámá broker identita
zůstává izolovaná na OAuth připojení. Dvě připojení stejného loginu se mohou
podělit o výsledek; nesdílejí se oprávnění mezi uživateli.

Atomická databázová funkce přidělí na jedno čtení 45s lease. Ostatní požadavky
čekají nejvýše 8 s a pak dostanou odklad; nespustí vlastní náhradní dávku.
Po pádu čtenáře se lease uvolní časem. Jeho pozdní výsledek nesmí přepsat novější
stav. Sdílí se také odklad po chybě, bez ukládání textů chyb či penaltových tiketů.
Chybějící migrace není důvod přejít na nesdílené čtení brokera.

Připojení a jeho vlastník se kontrolují v každém databázovém volání. Odpojení,
změna broker identity, hostů, scope nebo přihlášení nezpřístupní starý cache
výsledek. Otisk generace přihlašovacích údajů zachytí i obnovu tokenu. Tabulka ani
funkce nejsou přístupné rolím `anon` a `authenticated`; server používá service role.
Nová tabulka neobsahuje broker tokeny. Staré neaktivní kanály se omezeně uklízejí
při založení nového kanálu.

## Obnova podle druhu dat

| Druh | Chování |
| --- | --- |
| Úplný základ účtu, risk a ledger | Jedno sdílené čtení nejvýše po 10 min, původní časy jednotlivých polí zůstávají. Částečný výsledek má kratší životnost. |
| Pozice a příkazy | Přednostně aktuální uložený stav workeru, pouze s úplným přísným dokladem pro každý účet připojení. Samotná kontinuita ani připojený socket nestačí. |
| Záložní REST tick | Jedno společné čtení po 30 s. Pořadí kontraktů řídí společný sběrač; různé cursory telefonů nevytvářejí další kanály. |
| Cash/P&L | Přednostně existující společný feed workeru. Je-li jeho čtení rozpracované, klient počká. REST záloha je sdílená po 120 s; samostatná kotva po 30 s. |
| Historická capability | Samostatně sdílená po 10 min; pomalý probe neblokuje klienta, který ho nepožaduje. |
| Historický report | Shodný účet a interval sdílí jeden výsledek po 120 s. Inkrementální backfill zachovává vlastní existující lease a cursor. |

Nové otevření může převzít uložený úplný základ, ale před vykreslením staršího
základu si vyžádá společný rychlý stav. Aktuální worker má přednost i před ještě
platným záložním REST tickem, aby jeho návrat nebo nový fill nečekal 30 s.
Pokrytí workerem vyžaduje aktuální proces, session a route, známý kontrakt,
žádnou mezeru/backlog/merge a baseline nejdříve po posledním novém OAuth přihlášení. Běžné prodloužení
tokenu neruší platnou streamovou session. Kopie téhož procesu přes více OAuth zařízení se slučují podle
primárního zařízení a začátku procesu; dva různé procesy jsou nejednoznačné.

Při dočasné chybě zůstane poslední známý základ účtu dostupný nejdéle 24 h
od sběru, s původními časy a `sharedRead.refreshPending`. Nový klient rozlišuje
„Aktualizuji data“ od odpojeného účtu. Zamítnuté nebo odvolané oprávnění se tím
nepřekrývá. Obchodní oprávnění a risk autorita workeru se nemění. Neexistuje
náhrada neznámé pozice falešným flat nebo zůstatku nulou.

## Web a nainstalovaný telefon

Serverové rozhraní zůstává kompatibilní se stávající aplikací iPhone; její starší
požadavky se sdílejí na serveru. Rebuild telefonu není podmínkou sdílení dat.
Nový text „Aktualizuji data“ a práce s doplňujícími metadaty se do nativního
balíčku dostanou až jeho další aktualizací. Lokální nativní bundle byl sestaven,
nebyl synchronizován do telefonu ani nainstalován.

Čtecí kontrola produkční databáze v 07:21 SEČ: poslední runtime hlásil instalaci
`fbd518c0`, čas sestavení statusu, seznam členství připojení, čtyři řádky dokladu
a dva zobrazovací feedy. To potvrzuje přítomnost potřebných polí, nikoli provedení
nového řešení v produkci. Nebyl odeslán příkaz workeru ani přímý broker dotaz.

## Ověření a měření

- `npm ci` v izolovaném checkoutu; pro společný kořenový typecheck také instalace
  existujících závislostí extensionu, bez změny jeho zdrojů.
- TypeScript prošel s paměťovým limitem 6 GB; výchozí 2GB proces pro celý tento
  repozitář nestačil.
- Webový build, nativní build včetně kontroly lokálního bootu a Node ESM cold-load
  serverových API prošly. Běžná upozornění na velikost bundle nejsou chyba sestavení.
- Reálný lokální PostgreSQL (PGlite), skutečná migrace a SQL funkce: souběh,
  sdílení mezi připojeními, izolace uživatelů/prostředí/hostů, změna oprávnění,
  odpojení, odklad po chybě, pád čtenáře, odmítnutí pozdního výsledku a zákazy rolí.
- Celé existující rozhraní: studená načtení, staré telefonní cursory, zachování
  časů cash/daily, vyčerpání kapacity a následné zotavení.
- Worker projekce: neznámý kontrakt/člen, starý či přehrávaný status, změna
  session a přihlášení, mezera/backlog/merge a samotná kontinuita nesmí vydat
  úplný stav. Cash čtení zůstává u existujícího sběrače.

Laboratorní měření s testovacím upstreamem, bez skutečného broker účtu:

| Scénář | Výsledek |
| --- | --- |
| 30 souběžných + 300 následných otevření koordinátoru | 1 upstream čtení; studená dávka 220 ms při umělé 20ms odpovědi upstreamu. |
| API se dvěma testovacími účty: 12 souběžných + 30 následných otevření | 1 úplná dávka, celkem 16 testovacích broker čtení; celý scénář 270 ms. |
| 12 různých telefonních cursorů | 1 seznam pozic + 1 seznam příkazů, shodný zdrojový čas všech odpovědí. |

Tyto časy jsou místní testy koordinace. Nejsou měřením broker → PC/iPhone,
latence obchodů ani slibem produkčních časů. Záložní REST cesta je záměrně
pomalejší; při zdravém workeru zůstává stávající průběžná cesta.

Úplná závěrečná sada: **8 764 passed / 1 todo**, **812 passed / 1 skipped**
souborů, 281,57 s. Po kontrole posledních změn navíc cílená sada
**130 passed** ve 14 souborech a po poslední kontrole **76 passed**
v 8 souborech. Poslední typecheck, webový build a nativní build prošly. Žádné selhání. U serverového ESM testu se
objevuje upozornění na chybějící source mapu samotného TypeScript balíčku;
na výsledek načítání nemá vliv.

## Navržené uvedení do provozu a návrat

1. Nejprve samostatná záloha/export vzdáleného schématu a záznam současného
   nasazení a směrování webu. Zvlášť potvrdit existenci použitelné DB zálohy;
   souborová záloha repozitáře ji nenahrazuje.
2. Po souhlasu aplikovat pouze `20261112064034_tradovate_shared_read_state.sql`.
   Přidává jednu novou tabulku, její index a jednu funkci; nemění tabulky
   broker tokenů, účtů, příkazů nebo risk nastavení. Spustit security/performance
   advisory a ověřit role. Neinstalovat worker, nepřepínat skupiny ani ARM.
3. Po souhlasu nasadit odpovídající web/server. Místní hlavní checkout obsahuje
   jinou rozpracovanou práci; nesmí se plošně nahrát jako tento release.
4. Předat dva webové klienty a současný telefon na stejné existující API,
   opakovaně otevřít LIVE a přepínat pohledy. Bez obchodů ověřit věk hodnot,
   počet fyzických čtení a rezervací odděleně, viditelnost účtů a zotavení.
   Pokud je uživatel v obchodu, do něj ani do jeho řízení nezasahovat.
5. Při chybě vrátit předchozí web/server. Novou tabulku lze nechat neaktivní;
   není potřeba při návratu mazat databázi nebo jakkoli ovládat kopírku.

Nelze zatím tvrdit, že byly odstraněny všechny příčiny skutečných broker/WS
výpadků. Cron a execution ověřování mají své stávající nezávislé odpovědnosti;
opravovaná příčina je násobení zobrazovacího načítání mezi klienty a instancemi.

## První produkční ověření

- Vercel `dpl_VA8BmB5vEMTkHnEdTFe7xDPbu3wx` READY, hlavní alias ověřen přímo
  proti tomuto deploymentu a commitu `4aa2de5b`.
- Po obnovení hlavního webu se oba platné loginy zobrazily jako Connected,
  celkem pět účtů. Žádný broker obchod nebo příkaz workeru se neposlal.
- DB potvrdila po otevření druhého zobrazení stejné dva úplné základy:
  DEMO zdroj 06:47:11.575 UTC / 1 účet; Lucid zdroj 06:47:12.228 UTC / 4 účty.
  Přidání klienta tedy nevytvořilo druhou úplnou dávku.
- Serverová doba prvního sestavení společného základu (rozdíl SQL claim a publish):
  DEMO **1,673 s**, Lucid **1,641 s**. Není to doba od kliknutí po vykreslení na
  PC ani měření fyzického iPhonu. Pozdější čtení přebírají tento základ.
- Zjištěna další příčina zavádějícího varování: staré prázdné připojení
  „Tradovate OAuth“ nemá broker identitu. `tradovate-request-identity-unavailable`
  se dříve mapovalo na obecnou hlášku o dočasném omezení dotazů, i když oba
  platné loginy neměly blokaci ani penalizaci. Doplněno přesné vysvětlení a
  regresní test; připojení se nearchivuje, neodpojuje ani znovu nepřihlašuje.
  Tato hláška je součástí UI balíčku: stará nativní aplikace ji získá až při
  aktualizaci; serverové sdílení používá již nyní.
- Původní cron dál hlásí `tradovate-request-identity-unavailable` u neověřeného
  připojení. Není to nový broker rate-limit ani chyba ukládání společných dat.
  Tento release nemění cron, připojení ani broker nastavení.

## Obnova podle skutečného stáří společného základu

Závěrečná kontrola doplnila zdrojové plánování obnovy v novém klientovi:
převzetí devět minut starého společného základu se nepovažuje za nové úplné
načtení na dalších deset minut. `lastFullSuccessAt` drží čas zdroje a další
obnova vychází z něj (10 min + 5s rezerva pro dokončení sběru). Různě otevření
klienti proto míří na stejnou obnovu, kterou v DB sloučí lease. Vadný nebo
budoucí čas nesmí obnovu odkládat donekonečna; po termínu je opakování omezené
na nejdříve jednu sekundu. Přenos tohoto plánování do již nainstalované nativní
appky vyžaduje její příští aktualizaci; sdílení serverových čtení ji nevyžaduje.

Prošlo 36 cílených testů včetně scénáře „devět minut stará data v novém klientovi“,
typecheck a oba buildy. Poslední minutové čtení rezervací v07:55 SEČ ukázalo
background Lucid1 / DEMO7 jednotek; jde o krátký vzorek rezervací, nikoli přímý
počet brokerových fyzických volání nebo dlouhodobý průměr. Risk rezervace workeru
se do něj nepočítají a nebyly změněny. CORS pro `capacitor://localhost` ověřen na
produkčním API (204); nepřihlášené čtení správně odmítnuto (401).
