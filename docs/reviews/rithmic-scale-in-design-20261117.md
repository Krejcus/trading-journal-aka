# Rithmic — přikoupení do pozice (návrh, 17. 11. 2026)

Stav: NÁVRH k oponentuře. Nic z toho není postavené. Dnes služba i obrazovka v pozici další vstup
odmítají (obrazovka vždy; služba při pracující samostatné ochraně).

## Co víme o Rithmicu (změřeno na Rithmic Test)

- Serverová ochrana (330) patří ke VSTUPU: každý vstup má vlastní SL/TP na své množství.
- Nohy jsou vzdálenosti v tickách od ceny VYPLNĚNÍ, ne absolutní ceny.
- Vyplnění nohy zruší její sestru; zrušení jedné nohy zruší obě. Dvě ochrany dvou vstupů jsou na
  sobě nezávislé.
- Změna nohy (314) mění jen cenu a vazbu zachová.
- Zavření pozice (`liquidatePosition`) ruší všechny příkazy kontraktu a pak zavírá — beze změny.

## Návrh: přikoupení se STEJNOU ochranou

Přikoupení = další vstup s vlastní serverovou ochranou, jejíž SL/TP míří na STEJNÉ ceny, jaké má
pozice. Výsledek: pozice 2 ks, dvě ochrany po 1 ks na shodných cenách.

### Kdy služba přikoupení pustí (op `entry` při nenulové pozici)

1. Stejná strana jako pozice (opačný vstup = zmenšení/obrat → odmítnout, na to je zavření).
2. Pozice je CELÁ krytá ochranami vstupů: součet pracujících SL (resp. TP) noh = |pozice|, žádná
   samostatná ochrana (`uiprot-`), žádný jiný čekající vstup, žádný neuzavřený vstup bez noh.
3. Všechny SL pozice mají jednu cenu a všechny TP jednu cenu (jinak nejdřív srovnat posunem).
4. Přikoupení nese přesně stejné druhy noh jako pozice (má-li pozice SL i TP, musí i přikoupení)
   a jejich ABSOLUTNÍ ceny se rovnají cenám pozice. Služba z nich spočítá ticky od reference
   (Limit: limitní cena; Market: cena služby; Stop: spoušť).
5. Strop pozice (`maxPosition`) jako dnes; typy Market / Limit / Stop jako u běžného vstupu.

### Co když se vyplní jinde, než byla reference

Market se skluzem nebo Limit s lepší cenou → nové nohy vyjdou o pár ticků jinde než nohy pozice.
Služba NIC sama nesrovnává (ochrana se neopravuje automaticky). Graf ukáže rozdíl:
`SL 2 ceny (28050.00 / 28050.50)` jako stav pozice a nabídne posun, který ceny srovná.

### Posun SL/TP u pozice s více ochranami

Nový příkaz služby `move-legs { symbol, role, price, expect }`: posune VŠECHNY pracující nohy dané
role na jednu cenu, jednu po druhé (stejné meze jako posun jedné nohy). Úspěch až když stav ukáže
novou cenu u všech; když některá neprojde, vrací „unknown" s výčtem — nic se neopakuje, uživatel
vidí dvě ceny a může posun zopakovat (nohy, které už cenu mají, se nemění).

### Zobrazení (hook)

- SL/TP čára: cena, pokud jsou všechny nohy role na jedné ceně; množství = součet.
- Rozdílné ceny nebo neúplné krytí → `issue` / `protection` text („SL kryje 1 z 2", „SL 2 ceny")
  a přikoupení i další vstup se nenabízí.
- Lístek použije stávající režim přikoupení obrazovky (`entryScaleIn`): SL/TP zamčené na cenách
  pozice.

### Co se NEstaví

- Přikoupení do pozice bez ochrany, se samostatnou ochranou nebo jen s částečným krytím.
- Automatické srovnání noh po vyplnění.
- Průměrování SL (posun SL na BE průměru) — BE počítá z průměrné ceny pozice a posune všechny nohy
  přes `move-legs`.

## Dotčená pravidla (duchem)

INV-OUTBOX-01/03 (jeden zápis na příkaz, nejistý se neopakuje — `move-legs` je N zápisů jednoho
uživatelského příkazu, každý jednou), INV-RECON-03 / INV-TRAD-03 (ochrana se sama neopravuje),
INV-DEFAULT-02 (bez splnění podmínek odmítnout), INV-UI-01 (obrazovka nic neautorizuje).

## Otázky pro oponenty

1. `move-legs` jako sekvence zápisů: je lepší zastavit po první chybě, nebo zkusit všechny? (Návrh:
   zastavit — další zápis po nejistém by šel proti „nejistý se neopakuje/nenásleduje".)
2. Stačí podmínka 2 proti závodu „noha první ochrany se právě plní" (pozice se mění)? Návrh: stejná
   lhůta usazení po vyplnění jako u `protect`.
3. Přikoupení Limitem, které čeká, zatímco se pozice zavře (SL): čekající vstup zůstane a později
   by otevřel novou pozici se svou ochranou. Je to přijatelné (má vlastní SL/TP), nebo má služba
   po zavření pozice hlásit incident? Tradovate cesta takový vstup ruší; tady by to byl
   automatický zápis.

## v2 po oponentuře critica (17. 11.) — tohle platí

Verdikt critica k v1: „UPRAVIT NÁVRH". Změny:

1. **První verze jen MARKET přikoupení.** Čekající přikoupení (Limit/Stop) se nestaví: po zavření
   pozice by otevřelo obchod, který uživatel nezamýšlel, a posun SL pozice během čekání by rozešel
   jeho plánované nohy (změna ticků čekající ochrany není změřená).
2. **Nejvýš 2 ochrany** (drží `maxPosition: 2`) — `move-legs` jsou nejvýš 2 zápisy a vejdou se do
   lhůty odpovědi.
3. **Podmínky přikoupení navíc:** prázdné `fillsAhead`, žádná rezervace kontraktu, usazená pozice
   (jako u `protect`), a služba zná role VŠECH pracujících příkazů kontraktu (po restartu bez
   záměrů → odmítnout přikoupení i `move-legs`).
4. **Proč se po skluzu nic nesrovnává:** každý vstup má vlastní ochranu na své množství. Když se
   vyplní noha první ochrany, zbude 1 ks s vlastním SL/TP. Rozdílné ceny noh proto nejsou díra
   v ochraně, jen dvě různé úrovně výstupu.
5. **Stav „dvě ceny":** graf kreslí jako čáru OCHRANNĚJŠÍ SL (bližší trhu) a BLIŽŠÍ TP a u pozice
   napíše „SL 2 ceny" / „TP 2 ceny". ×, brzda i BE fungují dál; BE a každý posun role jde přes
   `move-legs` a tím ceny srovná. Další přikoupení se ve stavu dvou cen nenabízí (strop je stejně 2).
6. **`move-legs`:** před KAŽDÝM zápisem znovu ověří, že noha pracuje a pozice se nezměnila; zastaví
   po první chybě (i neodeslané); výsledek vyjmenuje, které nohy novou cenu mají. Nejistý výsledek
   se zapíše mezi nejisté příkazy (neschovává se).
7. **Všechny cesty posunu jdou přes `move-legs`, když má role víc noh:** tažení čáry, BE, panel
   Správa, Shift+E (`onBareLeg` i `onManageEntry` v hooku). Služba posun JEDNÉ z více noh role
   přes `move` odmítne.
8. **Obrazovka:** hook plní `entryScaleIn` jen když jsou splněné podmínky (pozice celá krytá, jedna
   cena na roli, 1 ks, Market); texty režimu přikoupení, které mluví o skupině/workeru/Flattenu,
   dostanou solo variantu. Pozice jen se SL (bez TP) smí přikoupit jen se SL.
