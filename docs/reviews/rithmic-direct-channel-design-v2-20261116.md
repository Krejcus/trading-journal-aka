# Přímý kanál telefon/PC → Rithmic proces — návrh v2 (16. 11. 2026)

> **Stav: v2 také NEPROŠLA (critic i Codex „OPRAVIT"; pro zapojení blokuje).**
> Závazné opravy jsou v oddílu „Výsledek oponentury v2" na konci. Oba schválili
> jen stavbu nezapojených čistých modulů (kniha operací, později brána) se
> spornými body jako parametry.

Nahrazuje `rithmic-direct-channel-design-20261116.md` (v1 neprošla; nálezy
critika a Codexe jsou na jejím konci). **Jen návrh — kód neexistuje.**
Týká se výhradně nového Rithmic procesu. Tradovate worker, jeho relay, SQL
admission ani pravidlo `manual-entry-relay-only` se nemění.

Tři body označené **[ROZHODNUTÍ FILIPA]** jsou nastavené podle doporučení
obou recenzentů a čekají na potvrzení; bez něj se nestaví.

## Dotčené invarianty

INV-MANUAL-01, INV-RELAY-01/02/03/04, INV-BRAKE-02/03/04, INV-ARM-01/03,
INV-FRESH-01/02/03, INV-OUTBOX-01/02, INV-RECON-04, INV-WORKER-01/02/03/04,
INV-UI-01/02/03, INV-DEFAULT-01. Vznikne nový **INV-DIRECT-01** (znění dole);
věty „poll relaye je jediná cesta příkazů" (INV-RELAY-04) a „jen přes relay"
(INV-MANUAL-01) se výslovně omezí na Tradovate worker.

## 1. Cesty a co která smí nést

```
A) přímá:  klient ──HTTPS, Tailscale Serve (jen tailnet)──▶ loopback Rithmic procesu
B) relay:  klient ──Vercel/Supabase──▶ long-poll Rithmic procesu
```

| Třída | Příkazy | Přímá | Relay |
|---|---|---|---|
| **Brzdy** | `disarm`, `kill-switch`, `lock-until-session-end` | ano | ano |
| **Snížení rizika** | Flatten účtu/skupiny, zavření pozice, `cancel-entry` (vlastní čekající vstup), doplnění SL (`attach-brackets`, `add-leg` SL) | ano | ano |
| **Zvýšení rizika** | vstup (`place-leader-entry`), ARM (`arm-live`) | ano | **ne** |
| **Správa** | posun SL/TP, posun vstupu, zrušení nohy | ano | **ne** |
| **Čtení** | stav, náhled vstupu | ano | ano (jen stav) |
| **Mimo v1** | změny skupiny a konfigurace, `unlock-day`, `resolve-stuck-operation`, `reconcile`, registrace klíče klienta, `shadow` | ne | ne (jen lokálně na Macu) |

**[ROZHODNUTÍ FILIPA 3]** Běžné příkazy (vstup, zapnutí, posuny) jdou jen
přímo, tedy jen s Tailscale na zařízení. Bez něj zůstávají brzdy, zavření
a čtení. Důvod: odpadá sčítání lhůt mezi cestami a polovina kombinací brzda × vstup.

Proces přijme jen typy z tabulky; neznámý typ nebo typ ve špatné třídě/cestě
je odmítnut před jakýmkoli dalším zpracováním (seznam je v kódu procesu, ne klienta).

## 2. Kdo smí co poslat

Pojmy: **proces** = Rithmic exekuční proces; **klient** = jedna instalace
appky (telefon, prohlížeč). („Zařízení" v dnešním kódu znamená worker.)

- **Klíč klienta:** každý klient má vlastní neexportovatelný podpisový klíč
  (iOS: Keychain/Secure Enclave přes nativní plugin; web: neexportovatelný
  WebCrypto klíč). Veřejnou část proces eviduje v durable stavu.
- **Registrace klíče** jen lokálně na Macu (v1), při vypnuté kopírce a flat,
  s auditem a stropem počtu klíčů. Vzdálená registrace v1 není.
- **Oprávnění uživatele (token):** krátkodobé (10 min), vydává a podepisuje
  proces na žádost doručenou ověřenou cestou relaye (přihlášený uživatel).
  Vázané na: klíč klienta, uživatele, `startedAt` procesu, prostředí, rozsah.
  Odhlášení = token se neobnoví + odvolání klíče přes relay.
  **[ROZHODNUTÍ FILIPA 1]** Při výpadku spojení odhlášení na dálku nezabere
  hned; token doběhne nejvýš za 10 min. Brzdy tím dotčené nejsou.
- **Podpis požadavku** (třídy zvýšení rizika, správa, čtení): metoda, cesta,
  otisk těla, `operationId`, čas vzniku, jednorázové číslo, **cílový proces
  (`processId` + `startedAt`) a verze protokolu**. Restart procesu tím
  zneplatní vše dříve podepsané. Jednorázová čísla se evidují v durable stavu
  po dobu platnosti podpisu.
- **Brzdy a snížení rizika** klíč klienta ani token **nepotřebují**:
  - přes relay je autorizuje přihlášení uživatele na serveru (jako dnes) —
    nový, přeinstalovaný nebo odvolaný klient musí umět zabrzdit;
  - přímo stačí platný klíč klienta (token ne), aby brzda prošla i s vypršelým tokenem.
- `Origin` a loopback zůstávají jako filtr šumu, **ne** jako identita.
  Identita uzlu z Tailscale je další nutná podmínka pro třídu zvýšení rizika.
- **`GET /v1/status` je podepsaný** stejně jako příkazy (jinak by pozice četl
  každý uzel tailnetu).
- Kompromitovaný klient je podepisovací orákulum po dobu běhu — stejné riziko
  jako dnes ukradené přihlášení; omezují ho stropy z oddílu 5 a brzdy.

## 3. Plot proti brzdě a starému záměru

Každý příkaz mimo třídu brzd nese v podepsaném těle **plot** ze statusu, který
klient viděl: `{ processId, startedAt, brakeEpoch, statusRevision }`.

- `brakeEpoch` se v procesu zvýší při každé brzdě **z jakékoli cesty** (i při
  přijetí brzdy relayem) a při každém novém ARM.
- Brána odmítne příkaz, jehož plot nesedí na aktuální `processId`/`startedAt`/
  `brakeEpoch`, a znovu to ověří **synchronně těsně před zápisem k brokerovi**
  (stejný vzor jako dnešní `admittedBrakeEpoch`).
- Pořadí příchodu = monotónní čítač přidělený synchronně při přijetí HTTP
  požadavku (před čtením těla a před ověřením podpisu), ne hodiny.
- Důsledek: starý ARM, který dorazí po DISARM, nese starou epochu → odmítnut.
  Ztracený vstup, po kterém přišlo OFF a nové ON → stará epocha → odmítnut.
- **Zbývající okno, které návrh nezavírá:** brzda odeslaná relayem, která do
  procesu ještě nedorazila, přímý vstup nezastaví (proces o ní neví). Dnes
  server takový vstup zabije hned. Zmírnění: (a) klient pošle brzdu vždy
  **oběma cestami zároveň**, (b) proces při ztrátě spojení s relayem delším
  než N s odmítá třídu zvýšení rizika („nevím o brzdách"), (c) relay cesta
  brzd má pro Rithmic proces vlastní rychlý poll. Zůstává okno v řádu doby
  doručení relaye pro klienta **mimo tailnet** — výslovné přijaté riziko k odsouhlasení.

## 4. Kniha operací (idempotence, restart, souběh)

Jedna durable tabulka v **témže safety stavu a témže CAS commitu** jako
záznamy `sending` jádra (žádný druhý soubor):

`operationId → { otisk, třída, stav, přijato (čítač + čas procesu), platí do, výsledek }`

- Stavy: `accepted → sending → done | rejected | unknown`.
- `accepted` se uloží před čímkoli dalším; `sending` **před** zápisem
  k brokerovi; konečný stav po výsledku.
- **Restart:** záznam ve stavu `accepted` se označí `rejected` (nic neodešlo);
  `sending` → `unknown`. `unknown` blokuje ARM a nikdy se neprovede znovu —
  jen dohledání (INV-OUTBOX-01/02).
- **Opakování téhož `operationId`:** stejný otisk → vrátí aktuální stav
  (i „probíhá"), nic nespustí; jiný otisk → konflikt, záznam beze změny.
  Otisk zahrnuje typ, cílové účty, prostředí a relevantní konfiguraci.
- **Souběh** (obě cesty zároveň): synchronní rezervace v paměti před prvním
  `await`; druhý příchod se připojí k téže operaci. Selže-li durable zápis
  `accepted`, rezervace se uvolní a k brokerovi nejde nic.
- **Uchování:** nejméně 24 h a nejméně po dobu platnosti podpisů; neukončené
  a `unknown` záznamy se neořezávají nikdy.
- Klíč není oddělený podle klienta ani cesty.

## 5. Platnost, rozestup, stropy

- **Konečná platnost záměru** je neměnná a počítá se od jeho vzniku
  (podepsaný čas klienta, vstup 5 s, správa 5 s, zavření 5 s). Posun hodin
  klienta proces odhaduje z podepsané výměny statusu a toleruje nejvýš ±2 s
  navíc; větší rozdíl = odmítnuto u tříd zvýšení rizika a správy.
- Proces má navíc vlastní rozpočet od příjmu; platí **kratší** z obou.
  Opakování platnost neprodlužuje; po jejím konci klient už jen čte stav.
- **Brzdy a snížení rizika nemají kontrolu času klienta vůbec** (telefon
  s rozhozenými hodinami musí zabrzdit), jen deduplikaci. Konec session pro
  zámek dne se počítá z hodin procesu; podpis/požadavek zámku dne je vázán na
  `startedAt` a obchodní den, takže přehrání nezamkne další den.
- **Kapacita se rezervuje při přijetí** a počítá ze záznamů knihy operací,
  ne ze zvláštního čítače: zámek „jeden nevyřízený příkaz" globálně v procesu;
  rozestup 3 s (vstup) / 2 s (správa); strop vstupů a zvlášť strop správy za
  klouzavých 24 h; do stropu se počítají i `sending` a `unknown`. Třídy brzd
  a snížení rizika jsou mimo zámek, rozestup i stropy.
- ARM: slučování stejného a odmítnutí odlišného čekajícího ARM, `armPending`,
  všechny brány ON beze změny (INV-ARM-01/03).
- Flatten: slučování opakovaného Flatten, třída mimo frontu.

## 6. Brzdy

- Jdou mimo frontu příkazů i mimo zámek brány; ověření jejich podpisu ani
  durable zápis je nesmí zdržet déle než pevný strop (jinak se provedou a
  auditují dodatečně).
- Kill je jednosměrný; zámek dne podle INV-BRAKE-04.
- Deduplikace brzd mezi cestami od první verze (stejné `operationId`).
- **Dva procesy** (Tradovate worker + Rithmic proces): relay musí adresovat
  cíl výslovně (`processId`); výběr „nejčerstvější heartbeat" se pro Rithmic
  proces nepoužije. **[ROZHODNUTÍ FILIPA 2]** Globální OFF/Kill v appce míří
  na **oba** procesy; UI ukáže stav každého zvlášť a brzda se považuje za
  doručenou, až ji potvrdí oba.
- Registrace Rithmic procesu u relaye (dnes vázaná na Tradovate OAuth
  připojení a `environment = 'demo'`) je **neřešená** — vyžaduje vlastní návrh
  změny relaye; do té doby má Rithmic proces jen přímou cestu a lokální brzdy.

## 7. Stav a čerstvost

- Status nese `processId`, `startedAt`, `revision`, `brakeEpoch`; klient řadí
  podle `(startedAt, revision)` a starší nikdy nepřepíše novější (INV-FRESH-02).
- Běžný příkaz jen se statusem ≤ 15 s; brzdy vždy dosažitelné (INV-UI-02).
- Odpověď HTTP = výsledek brány + stav operace v knize; stav u brokera jen ze
  statusu procesu. Budoucí push (SSE) je jen zobrazení, čerstvost dál z dotazu.

## 8. Proces

- Singleton: výlučný zámek souboru stavu a výlučný bind portu **před**
  načtením stavu; neúspěch = konec procesu (INV-WORKER-01/02).
- Start vždy vypnutý (INV-DEFAULT-01). Bez načteného durable stavu se
  nepřijme nic kromě brzd.
- Před třídou zvýšení rizika proces sám ověří živé spojení s brokerem
  (heartbeat ze zprávy serveru, ne z časovače).

## INV-DIRECT-01 (návrh znění)

Rithmic proces je jediná autorita pro své příkazy. Příkaz zvyšující riziko
smí přijít jen přímou cestou, s podpisem klienta, platným tokenem uživatele
a plotem `{processId, startedAt, brakeEpoch}` ověřeným při přijetí i těsně
před zápisem. Brzdy a snížení rizika nevyžadují klíč klienta, token ani
kontrolu času. Každá operace má jeden durable záznam se stavy
`accepted → sending → done | rejected | unknown`; restart nikdy nic neprovede
znovu. Běží nejvýš jedna instance procesu.

## Co ověřit na iPhonu (podmínka před stavbou klienta)

`capacitor://localhost` v povolených Originech; preflight CORS; první požadavek
po probuzení a po přechodu Wi-Fi/LTE; vypnutý Tailscale; ztracená odpověď;
neexportovatelný klíč po aktualizaci appky. Potřebuje Tailscale na Macu a iPhonu.

## Testy před implementací (z oponentury)

Brzda relayem v letu × vstup přímo (plot odmítne); ztracený vstup → OFF → ON
→ opakování odmítnuto; stejné `operationId` oběma cestami = jeden zápis;
restart po `sending` = `unknown`, blokuje ARM; jiný otisk = konflikt; brzda
s hodinami ±1 h a bez klíče přes relay projde; přehrání podpisu po restartu
odmítnuto; odvolaný klíč / vypršelý token: vstup ne, brzda ano; ořez nikdy
nepustí staré `operationId`; druhá instance nenastartuje; status bez podpisu
= 401; ARM × brzda během ověřování podpisu.

## Výsledek oponentury v2

Co musí být ve v3 jinak (shoda obou recenzentů, není-li uvedeno jinak):

1. **Plot nesmí blokovat snížení rizika.** `brakeEpoch` kontrolovat jen u
   zvýšení rizika a správy. Flatten, zavření, `cancel-entry` a doplnění SL
   vázat na `processId`/`startedAt` a **identitu cíle** (obchod / epocha
   pozice) — jinak je DISARM odmítne právě ve chvíli, kdy jsou potřeba.
2. **Zavření a Flatten: identita cíle místo času.** Bez ní opožděné „zavřít
   long" zavře až další pozici a přehrání po ořezu projde. Rozpor „platnost
   5 s" × „bez kontroly času" odstranit. Záznamy těchto tříd neořezávat.
3. **Snížení rizika není bez koordinace.** Mimo zámek vstupů, ale serializace
   na cíl a slučování stejných záměrů (dvě doplnění SL = dva stopy; Flatten
   proti vstupu ve stavu `sending`). `attach-brackets` není snížení rizika jen
   podle názvu — ověřit množství, směr a roli nohy.
4. **Brzda se nikdy neprovede před ověřením.** Odložit smí jen durable zápis
   a audit. Sjednotit autorizaci brzd: přímo platný klíč klienta (bez tokenu),
   přes relay přihlášení uživatele; invariant to musí říkat stejně. Výslovně
   napsat, že kompromitovaný klient umí kill/zámek dne/Flatten (odepření
   obchodování, žádná nová expozice). Vyřešit, jak ověřit přímou brzdu bez
   načteného stavu (klíče jsou v něm).
5. **Kruhová závislost na relayi.** Token, odvolání klíče i znalost o brzdách
   jdou přes relay, jehož registrace pro Rithmic proces neexistuje → do té
   doby není token, tedy žádný vstup ani ARM. Návrh změny relaye je tvrdá
   podmínka. Doplnit typy `issue-token` a `revoke-key`; token vyžadovat i pro
   správu. **Bez funkční vzdálené brzdové cesty se živý ARM nepřijme.**
6. **Zbytkové okno jde jen ohraničit, ne zavřít.** Povinný *lease*: třída
   zvýšení rizika jen s potvrzením serveru „žádná brzda nečeká", starým nejvýš
   L (počítáno od odeslání dotazu monotónními hodinami, jen ze zprávy
   serveru); L kratší než rozestup vstupů (3 s), aby oknem prošel nejvýš jeden
   vstup. UI ukáže brzdu jako účinnou až po potvrzení procesem nebo po
   L + rezerva. Vyžaduje **samostatný výslovný souhlas Filipa** a číslo L
   z měření; test „brzda v letu → plot odmítne" tomu odporoval a vypouští se.
7. **Epocha při ARM:** ARM ověří epochu `e`; úspěšný commit atomicky zapne
   a nastaví `e+1`. Zamítnutý, duplicitní ani jen přijatý ARM epochu nemění;
   brzda během ověřování commitu zabrání.
8. **Restart:** `accepted → rejected` platí jen pro zápisy k brokerovi.
   Přijatá brzda se po restartu uplatní znovu. Doplnit přechod
   `sending → rejected` (prokazatelně neodešlo), jinak každý souběh brzdy se
   vstupem skončí jako `unknown`. Blokaci ARM vlastní jeden zdroj (outbox).
9. **Chování po zápisu:** brzda po odeslaném vstupu zruší vlastní nevyplněný
   vstup, vyplněnou pozici nezavírá; částečné plnění při Flatten.
10. Jednorázová čísla u čtení stavu neukládat durable (vazba na `startedAt`
    a čas stačí). Identita uzlu z Tailscale je jen audit (hlavička jde
    z loopbacku podvrhnout). Popsat, jak se veřejný klíč telefonu dostane na Mac.

### Rozhodnutí, která potřebuju od Filipa (čtyři)

1. Odhlášení na dálku při výpadku spojení zabere až po doběhnutí tokenu (≤ 10 min).
2. Globální OFF/Kill míří na oba procesy (Tradovate i Rithmic).
3. Vstup, zapnutí a posuny jen přímo (Tailscale na zařízení); bez něj jen
   brzdy, zavření a čtení.
4. **Nové:** brzda poslaná ze zařízení mimo Tailscale začne platit až po
   doručení procesu, nejpozději za L sekund (cíl < 3 s). Do té doby může
   projít nejvýš jeden vstup z jiného zařízení. Dnes platí hned. Přijatelné?

### Postaveno jako nezapojený prototyp

`services/rithmic/operationLedger.ts` + `tests/rithmicOperationLedger.test.ts`
(22 testů): stavy operace, konflikt otisku, souběh, obnova po restartu
(brzdy se vracejí k uplatnění), serializace na cíl, rozestup a stropy ze
záznamů, ořez. Čísla, složení otisku, úložiště, vlastník blokace ARM a zdroj
času jsou parametry / věc volajícího.

Critic k diffu knihy: „OPRAVIT PŘED COMMITEM" — opraveno a pokryto testy:
zrušení nejde přes letící zápis (`cancelBeforeSend` jen z `accepted`,
`settleSent` jen s dokladem z `beginSending`); do rozestupu a stropu se
počítá vše, co začalo odesílat, i příkaz odmítnutý brokerem; `unknown` na
cíli blokuje další riziko; `load` odmítne poškozené záznamy; pořadí přežívá
ořez i restart. Jako smlouvy volajícího zapsáno v hlavičce modulu: brzda
nečeká na knihu (uplatní se i při výjimce), třída `brake` je jen
idempotentní zpřísnění (Flatten patří do snížení rizika), platnost a cíl
musí být v podepsaném otisku, pozdní výsledek uzavřeného záznamu je incident,
kniha není zámek procesu. **Tyto opravy už critic znovu neviděl.**

### Vstupní brána (nezapojený prototyp) a druhé kolo knihy

`services/rithmic/ingressGate.ts` + `tests/rithmicIngressGate.test.ts`:
čistá rozhodovací funkce, politika je vždy vstup (žádné výchozí nastavení;
politika v testech je „jedna z variant, neschválená"). Brána se vyrábí jen přes
`createIngressGate`, která politiku ověří a zmrazí.

Critic k bráně: „OPRAVIT PŘED COMMITEM" — opraveno s testy: politika, ve které
nejde zabrzdit, neprojde (brzda a snížení rizika musí mít každou cestu, kterou
má vstup, a žádný důkaz navíc); nekonečná nebo přehnaná platnost neprojde;
čtení stavu se rozhoduje jen podle důkazů (jinak by klient plot nikdy
nezískal); neznámá cesta je odmítnutí, ne pád; druhá kontrola před zápisem
hlídá i načtený stav a přijme jen rozhodnutí vydané touto bránou.
Zapsáno jako smlouvy volajícího: zařazení příkazu do třídy musí hlídat
vykonavatel (nejvolnější přípustná třída), shodu cíle se skutečnou pozicí
a platnost tokenu mezi přijetím a zápisem také.

Critic ke knize po opravách: nálezy 1–9 vyřešené; tři nové mezery opraveny
s testy — neznámý výsledek hlídaného druhu blokuje vstupy i na jiném cíli;
zavření nečeká na visící vstup; `resolveUnknown` chce druh dokladu a důvod
a nikdy nesmí jít časovačem. **Tyto poslední opravy brány i knihy už critic
znovu neviděl; Codex neviděl žádný z obou modulů.**
