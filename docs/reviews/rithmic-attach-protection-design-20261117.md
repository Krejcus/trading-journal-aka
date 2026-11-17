# Rithmic — doplnění SL/TP k otevřené pozici (návrh, 17. 11. 2026)

Stav: POSTAVENO (17. 11.) podle rozhodnutí Filipa: k pozici jde přidat BUĎ jen SL, NEBO jen TP — nikdy obojí. Viz „Co je postaveno" na konci; SL + TP najednou dál čeká na OCO.

## Proč

Obrazovka už umí vstup bez SL/TP a jen s jednou nohou. Pozici bez ochrany (nebo jen s TP) dnes jde
jen zavřít — SL k ní přidat nejde. To je slepá ulička a u ostrého účtu nepřijatelné.

## Co Rithmic nabízí (stav našeho klienta)

- Serverový bracket (330) se váže na VSTUP: nohy vzniknou po vyplnění. K existující pozici ho
  přidat nejde.
- `RequestUpdateStop/TargetBracketLevel` (334/332) mění vzdálenosti jen u čekajícího bracketu.
- OCO (šablona 328 v oficiálním protokolu) v naší sadě definic CHYBÍ (tabulka z async_rithmic ji
  nemá). Bez oficiálních .proto ji nebudu psát z hlavy.
- Zbývají obyčejné příkazy (312): STOP_MARKET a LIMIT na opačnou stranu. Nejsou spolu svázané.

## Varianty

**A. Jen samostatný SL (doporučuji jako první krok).**
Jeden STOP_MARKET na opačnou stranu, množství = |pozice|, značka `uisl-<clientId>`.
- Povoleno JEN když pozice nemá žádný jiný pracující výstupní příkaz (holá pozice). Jinak by
  vznikly dva nesvázané výstupy (např. TP z bracketu + nový SL) a po vyplnění jednoho by druhý
  zůstal pracovat → otevřel by opačnou pozici.
- Posun a zrušení: stejně jako u nohy (jen cena; zrušení jen při nulové pozici nebo jako součást
  zavření). Zavření pozice (× i brzda) ruší všechny příkazy kontraktu — už dnes.
- Hlídání: záznam v `RithmicProtection` jako „samostatná ochrana" (značka, kontrakt, množství).
  Stav nechráněno/chráněno se počítá z pracujícího množství proti |pozici|; pozice 0 + pracující
  samostatný SL = incident `protective-stop-orphan` (stejná třída jako dnešní
  `bracket-orphan-legs`: nic se samo nedostavuje ani neruší, rozhoduje člověk; nové vstupy stojí).
- Co neumí: TP k pozici, která už má SL; SL k pozici, která má jen TP.

**B. SL + TP jako dva nesvázané příkazy s „místním OCO"** (služba po vyplnění jednoho zruší druhý).
Zamítám: když místní proces spadne nebo ztratí spojení, sestra zůstane pracovat a může otevřít
opačnou pozici bez dozoru. To je přesně typ díry, kvůli kterému máme serverové brackety.

**C. Skutečné OCO (328).** Správné řešení pro SL + TP k pozici. Potřebuje oficiální definice
z vývojářské sady Rithmicu (přijde s conformance) a měření na Rithmic Test: vazba, zrušení sestry,
chování při částečném vyplnění, snímek. Odkládám do té doby.

## Dotčená pravidla (duchem, Rithmic cesta není kopírka)

- INV-OUTBOX-01/03: jeden zápis, žádné opakování; neznámý výsledek = nejistý příkaz + blokace.
- INV-RECON-03 / INV-TRAD-03: ochrana se nikdy nedostavuje ani neopravuje obchodem sama.
- INV-DEFAULT-02: bez výslovného příkazu uživatele žádný SL nevznikne.
- INV-UI-01: obrazovka nic neautorizuje; službu váže strop množství, mřížka a strana trhu
  (SL musí být na ztrátové straně a ne za trhem — jinak by se spustil hned).

## Otevřené otázky pro oponenty

1. Je varianta A bezpečná i při částečném zavření zvenčí (R Trader zmenší pozici → SL má větší
   množství než pozice)? Návrh: incident `protective-stop-oversized`, nic se nemění samo.
2. Souběh: SL se přidává a mezitím se pozice zavře (závod) → SL vznikne nad nulovou pozicí.
   Návrh: po potvrzení zápisu druhé čtení pozice; při nule incident + nabídka zrušení (ne
   automaticky).
3. Má „Zavřít pozici" čekat na potvrzení zrušení samostatného SL stejně jako u nohou? (Ano —
   stejná cesta `liquidatePosition`: zrušit vše → důkaz → zavřít.)
4. Stačí jako první krok jen SL, nebo je bez TP k pozici zbytečný? (Rozhodnutí produktu: Filip.)

## Co je postaveno (17. 11., `82e043ac`)

Rozhodnutí Filipa: „postavil bych obojí, aby šel buď jen SL, nebo jen TP".

- Služba (`LocalExec`, op `protect`): jeden Stop (SL) nebo Limit (TP) na opačnou stranu, množství =
  |pozice|, značka `uiprot-`. Odmítne: bez pozice; když kontrakt má jakýkoli pracující příkaz nebo
  příkaz na cestě; u pozice ze vstupu s ochranou (i když nohy ještě nedorazily); těsně po vyplnění
  (pozice se usazuje); bez čerstvé ceny služby; na špatné straně trhu; mimo krok a strop ticků.
- Při pracující samostatné ochraně služba nepustí další vstup.
- Posun ochrany: jen cena, stejné meze jako při zadání. Odebrání: jen samostatnou ochranu.
- Hlídač: ochrana bez pozice / s jiným množstvím / na stejné straně, která vydrží 3 s (kontroluje
  časovač, ne příští událost) → incident + blokace vstupů; nic se samo neruší. Po obnovení shody
  nebo po potvrzení se trvající nesoulad hlásí znovu.
- Obrazovka: čipy „+ SL / + TP" u čáry pozice, × u samostatné nohy, sirotek je vidět jako stav
  pozice a jde zrušit tlačítkem „Zavřít pozici".
- Ověřeno v appce na Rithmic Test: přidání SL, odmítnutí TP k pozici se SL (s vysvětlením), posun,
  odebrání, přidání TP, zavření brzdou; po opravách z review znovu přidání SL + zavření.
- Review: critic i Codex „OPRAVIT PŘED COMMITEM" → všechny nálezy zapracované; konečnou verzi už
  znovu nepotvrzovali.

Neověřeno na účtu: spuštění samostatného SL a vyplnění TP trhem (jen testy na falešném serveru),
zavření zvenčí při pracující ochraně, chování po restartu služby.

## Doplněk 17. 11. večer — SL a potom TP (nebo naopak) k otevřené pozici: svázaný pár (OCO)

Požadavek Filipa: „když budu v marketu, nejdřív natáhnu SL a potom i TP". Postaveno.

### Co se změřilo na Rithmic Test (`scripts/rithmic/measureOco.ts`)

- Šablona 328/329 (definice z knihovny rithmic-rs, viz `services/rithmic/proto/rithmicProtoExtra.ts`): odpověď za
  106–115 ms, vrací ID obou příkazů. Obě nohy nesou vlastní značku a `linked_basket_ids` (i ve snímku).
- Posun jedné nohy (314) vazbu zachová. Zrušení jedné nohy zruší OBĚ. Vyplnění jedné zruší druhou do 20 ms.
- Limit dál než ~30 b od posledního obchodu burza odmítne („outside bands") — příkaz zůstane na původní ceně.

### Jak to služba dělá (`protect` u pozice s jednou samostatnou ochranou opačného druhu)

1. Kontroly PŘED čímkoli: jediný pracující příkaz kontraktu je vlastní samostatná ochrana (`uiprot-`) opačného
   druhu, celé množství pozice, nevyplněná; cena služby čerstvá a leží mezi SL a TP; neběží jiná změna ochrany.
2. Zruší původní nohu a čeká na potvrzení stavem. Bez potvrzení se pár NEZADÁ (hrozily by dvě ochrany) → blokace.
3. Znovu ověří pozici, že na kontraktu nic nepracuje a cenu; pak JEDEN zápis: svázaný pár SL+TP.
4. Úspěch až když obě nohy pracují.

Mezi kroky 2 a 3 je pozice krátce bez ochrany (změřeno ~120 ms; celé 272–290 ms). Je to vědomý kompromis:
opačné pořadí (nejdřív pár, pak zrušit starou nohu) by na okamžik dalo dvě ochrany na jednu pozici a při
zásahu ceny by pozici obrátilo — to je horší než chvilka bez ochrany. Když krok 3 neprojde (burza odmítne,
výsledek není znám, stav se změnil), služba to ohlásí incidentem `protection-removed` /
`protect-replace-uncertain`, zastaví nové vstupy a NIC neopakuje — rozhoduje člověk (přidat SL znovu, nebo zavřít).

### Další pravidla

- Zrušení jedné nohy páru u otevřené pozice služba odmítne (zmizely by obě). Posun obou noh jde.
- Zavření pozice (brzda) ruší vše jako dosud. Vyplnění jedné nohy → druhou ruší burza; karta zavření má důvod SL/TP.
- Noha páru je pro adaptér obyčejný Stop/Limit (příkaz s vazbou A vlastní značkou); noha ochrany vstupu značku nenese.
- SL i TP NAJEDNOU jedním příkazem z obrazovky se nestaví (obrazovka přidává po jedné) — služba by to uměla.

Neověřeno: vyplnění staré nohy přesně během výměny na skutečném trhu, chování po restartu služby uprostřed
výměny (po restartu je stav vidět z knihy: buď jedna noha, pár, nebo nic → hlídač a obsluha), tažení čipů v appce.

### Po oponentuře (critic „opravit", Codex „blokuje" → zapracováno 17. 11. večer)

- Výměna si po celou dobu drží rezervaci kontraktu a `legsMoving`: souběžná druhá ochrana, vstup ani posun nohy neprojdou.
- Jen 1 kontrakt (částečné vyplnění staré nohy by dalo pár na víc kusů, než pozice má).
- Nejisté zrušení staré nohy i každé selhání po něm = incident + blokace + další ochrana až po potvrzení obsluhou.
- Role nového páru se potvrzují podle značek, typu a cen v knize, ne podle pořadí ID v odpovědi.
- Zrušení nohy páru se odmítá podle značky (`-s` / `-t`), i když služba sestru ještě nevidí.
- Noha páru se pozná podle známé značky příkazu, ne podle značky v právě přijaté zprávě.
- Trvalá značka „výměna běží" (soubor): po pádu služby uprostřed výměny ji nová služba ohlásí incidentem.
- Přeměřeno na Rithmic Test po opravách: pár za 267 ms, posun, odmítnuté zrušení, karta zavření.

Zůstává: karta zavření může po obnově spojení ukázat starý obchod, pokud adaptér přehraje dřívější vyplnění
(jen zobrazení, neověřeno); vyplnění staré nohy přesně během výměny na skutečném trhu; tažení čipů v appce.
