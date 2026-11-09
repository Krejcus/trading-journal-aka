# LIVE: rychlost správy a obnova historie — 9. 11. 2026

## Stav před nasazením

Základ je nasazený `cd530285`. Opravy jsou ve větvi
`codex/live-speed-history-20261109`, pracovní kopie
`/Users/filipkrejca/alphatrade-worktrees/live-speed-history-20261109`.
Dosud žádný commit, push, deploy Edge Function, restart/reinstall workeru,
instalace iPhonu, ARM ani brokerový zápis v této navazující práci.
Souhlas s tímto konkrétním nasazením byl vyžádán po dokončení kontrol.
Canonical Documents a Claudovy rozpracované změny zůstaly zachované.

## Co zpomalovalo správu

`prepareGroupPositionManagement` procházel účty postupně. Pro každého dělal
čtení příkazů, pozic a původního vstupu. Stejná postupná smyčka běžela
v každém guardu před a po jednotlivých zápisech a před skupinovým zavřením.
Nezávislá čtení účtů nyní běží v dávkách nejvýš čtyř členů. Mohou tak také
využít existující same-login singleflight adaptéru pro společné endpointy.

Zachované jsou všechny původní kontroly identity/vlastnictví, přesné ceny,
množství, remainderů, route a konfigurace, brzdy, pending ingress i finální
synchronní bariéry zápisu. Nové kolo znovu čte všechny členy. Chybná dávka
se nechá dočíst a nepokračuje dalšími účty. WAL, brokerové zápisy a jejich
potvrzování zůstávají postupné; není to paralelní přepis ochranných příkazů.

`MANAGE TIMING` nově podle operationId rozlišuje queueMs, prepareMs,
executeMs a totalMs. Monotónní měření neloguje účty ani tokeny a nic
neautorizuje. Výjimka diagnostického callbacku nemůže změnit výsledek obchodu.

## Srovnání rychlosti

Skutečný controller a runner, mock broker, tři účty a množství 2/4/2,
všechna tři čtení účtu mají stejnou přidanou prodlevu 20 ms. Tři posuny
každého typu před a po; obě varianty musí skončit acknowledged a mít právě
jeden Modify na člena. Nejde o živý broker, klik→pixel nebo telefonní měření.

| Akce | Před, jednotlivé vzorky | Po, finální vzorky | Medián před → po |
|---|---|---|---|
| Skupinový SL | 585 / 578 / 581 ms | 263 / 253 / 259 ms | 581 → 259 ms (−55,4 %) |
| Skupinový TP | 583 / 583 / 582 ms | 254 / 256 / 249 ms | 583 → 254 ms (−56,4 %) |

Podklady: `/private/tmp/at-speed-before.log`,
`/private/tmp/at-speed-after-final.log`. První následný běh vyšel přibližně
244 ms; tabulka záměrně používá konzervativnější poslední běh finálního kódu.
To nedokládá dosažení 150–250 ms celého živého příkazu. U celé kopírky
se stále čeká na potvrzení všech členů a zápisy jsou postupné.

Poslední předchozí živý DEMO vzorek z reliability release byl n=1 na akci:
worker Market 408 ms, SL 327 ms, TP 428 ms, close 2796 ms. Samotný broker
SL 247 ms / TP 372 ms. Šlo o sólo DEMO a CLI relay, nikoli srovnatelné
měření současné skupinové správy nebo telefonu; viz předchozí release report.

Dvě nové pouze čtecí sondy na OFF/flat Lucidu se zastavily na pevném
lokálním stropu requestů při studené hydrataci metadat nového adaptéru.
Nebyly z nich vyvozeny časy správy ani úspory živých dotazů. Používaly běžné
BG povolenky, žádnou management/recovery výjimku. Žádný obchod ani ARM.
Další opakování se neprovádělo; plné živé A/B čeká na nasazení a DEMO.

## Proč selhávala historie a co se opravilo

Aktuální produkční logy potvrzují store 409 → legacy endpoint a následné
502: jednak Databento HTTP 206 s částečně vyřešeným symbolem, jednak 504
timeout po přibližně minutě. Není to jen chybně zobrazená hláška.

1. Klient rozšiřoval denní kbelík na následující půlnoc i na hranici
   publikace. Tam je nyní konec omezen skutečným požadovaným historickým
   koncem. Staré úplné UTC dny zůstávají sdílenou cache.
2. Server ukončuje samotný provider request před uzavřeným koncem víkendu
   NQ/MNQ (pátek 17:00 ET → neděle 18:00 ET). Odpověď samostatně uvádí
   `providerEnd` a `closedIntervals`; nevyrábí svíčky pro uzavřený interval.
   Rozsah čistě uvnitř tohoto uzavření je výslovně prázdný, bez placeného
   provider requestu. Zůstává autentizace, validace a rate limit. Pátek má
   vlastní UTC offset, včetně víkendů změny času. Svátky se neodhadují.
   Že právě tento konec způsoboval konkrétní 206, je podložená hypotéza;
   skutečný provider retest po deployi je stále nutný.
3. Úspěšně stažené úplné části se uloží i při selhání jiného chunku.
   Celé neúplné okno stále skončí chybou; selhaný den se nikdy necachuje
   jako prázdný nebo úplný. Retry tak znovu nekupuje již dokončené dny.
4. Viditelný graf omezeně zopakuje přechodnou síťovou/5xx chybu po
   5/15/60 s, nejvýš třikrát. Skrytý tab nestahuje, po návratu obnoví.
   Partial/truncated/payment/rate-limit se automaticky neopakují. Změna
   grafu odstraní timer i pozdní publikování chyby starého grafu.
5. Podrobnosti stavu ukazují skutečný důvod historické chyby. Dosavadní
   svíčky a poloha grafu se při chybě nemažou; žádné nové setVisibleRange,
   refocus nebo odhadnuté ceny/objemy.

HTTP 206 se nadále odmítá. Cost gate, ověřování symbolu, datový limit
i 24hodinový odstup poskytovatele zůstávají. Změna se netýká exekuce ani
brokerového risku. [Databento API](https://databento.com/docs/api-reference-historical),
[pravidelná doba CME](https://www.cmegroup.com/articles/faqs/micro-e-mini-equity-index-futures-frequently-asked-questions.html).

## Ověření

- `npm ci` v rootu i extension; bez změny locků nebo závislostí.
- Celá finální sada **8477 passed + 1 todo**, 789 souborů passed + 1 skipped.
  Proběhla s povoleným lokálním testovacím serverem. První omezený pokus
  nemohl otevírat sockety a byl zastaven; nepovažuje se za regresní výsledek.
- Root TypeScript i samostatný skutečný pilot entry typecheck prošly.
- Web build, nativní web bundle + verify, Capacitor sync, iOS doctor
  a podepsaný Xcode device build prošly. iPhone se zatím neinstaloval.
- Worker bundle sestaven. SHA256
  `1f65cefb2ad1149918c7def6818c15fc3ce9c2b3d8aeaa45ab183e297e40515c`.
- Cílený lint 0 errors, starší warningy v controlleru a ignorovaný pilot
  zůstávají. `git diff --check` čistý.
- Nové testy zahrnují chybné/držené čtení dávky, concurrency ceiling,
  OFF/Kill za letu, poruchu diagnostiky, zachování cache po částečném
  neúspěchu, exact publication cutoff a bounded/visibility retry.
- Samotný Edge handler se testuje i běhově: skutečný sestavený handler
  s nahrazenou autentizací a poskytovatelem. Kontroluje provider request,
  explicitní closed interval, žádný nákup pro uzavřený interval, 401 bez
  auth a zachování odmítnutí 206. Nejde o potvrzení od živého Databenta.

## Nasazení a zbývající ověření

Export původní produkční `market-candles` v11, včetně zdrojů a verify_jwt,
je `/private/tmp/at-speed-market-candles-remote-backup.json` (600), SHA256
`4584503035742ec5dd15f9082a10a62d3241d94446fba16766e7905e65f7b406`.
Žádná DB migrace nebo změna RLS/env nejsou v tomto balíku potřeba.

Po souhlasu: trvalý návratový bod workeru/konfigurace a funkce; čistý
release commit → Edge Function → web → normální bezpečná restart brána
workeru → aktualizace iPhonu. Reconcile a broker důkazy čerstvě před/po,
žádné změkčení kvót, zastaralých stavů nebo restart pod otevřenou pozicí.

Teprve potom skutečné kontrolované DEMO8661118/61038658, 1 MNQ, přes
stejný UI hot path před/po (admission, pickup, controller prepare/execute,
broker ACK a skutečný UI stav). Fyzický telefon vyžaduje dostupný odemčený
iPhone nebo ruční kroky; desktopový/narrow-layout test jej nenahrazuje.
Lucid není povolený cíl brokerových testovacích zápisů. Na závěr účet flat,
bez čekajících příkazů, OFF, a návrat původní Lucid konfigurace.
