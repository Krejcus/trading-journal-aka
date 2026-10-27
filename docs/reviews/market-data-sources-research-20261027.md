# Zdroje živých dat CME — rešerše a dotaz pro Codex (27. 10. 2026)

Navazuje na `docs/reviews/ibkr-live-data-handoff-20261027.md`. Otázka od
Filipa: jde to levněji nebo aktuálněji, a co je nejlepší pro vizi, že se
jednou bude obchodovat přímo z naší platformy?

Značka **NEOVĚŘENO** = jen ze sekundárního zdroje (blogy prodejců, fóra) nebo
z výtahu, který jsem neotevřel celý. Ceny v USD bez DPH.

---

## 1. Shrnutí

- **Levněji to legálně nejde.** Burzovní poplatek CME pro neprofesionála je
  1,55 USD/měs. za zařízení (L1, CME), od ledna 2027 1,60 USD. IBKR ho podle
  předávky účtuje skoro v nákladové ceně. Kdo nabízí skutečný realtime CME
  levněji, buď dotuje, nebo data přeprodává bez licence.
- **IBKR zůstává nejlevnější oficiální osobní zdroj.** Otevřené riziko:
  na fórech se tvrdí, že IBKR u futures ticky filtruje nebo slučuje.
  Oficiální dokumentace `AllLast` úplnost výslovně neslibuje. Sonda proto
  musí ticky porovnat s Databentem (nezávislý zdroj přímo z CME MDP 3.0).
- **Nejúplnější osobní feed je Rithmic** (nefiltrovaný, každý obchod
  i změna knihy). Přes brokera stojí ~20–25 USD/měs. za uživatele + poplatek
  CME a do produkce potřebuje conformance test. NEOVĚŘENO: přesné ceny.
- **Pro vizi „obchodovat z platformy“ je rozhodující něco jiného než cena:**
  odkud budou data pro **ostatní** uživatele.
  - Když data distribuuje naše platforma sama, potřebuje licenci CME
    k distribuci. Výtah z ceníku 2026: 29 280 USD ročně za burzu
    (NEOVĚŘENO v PDF) + poplatky za každého uživatele. Pro začátek
    nereálné.
  - Platformy jako Quantower, ATAS a Bookmap to řeší tak, že data jdou
    **přes obchodní připojení samotného uživatele** (hlavně Rithmic). Data si
    licencuje uživatel nebo jeho prop firma, platforma ne. To je cesta, která
    k vizi sedí.
  - Tradovate přes API data nedá bez smlouvy CME „sub-vendor“ (ILA). Tradovate
    to sám uvádí na podpoře, ceny ~290–500 USD/měs. jsou NEOVĚŘENO. Proto
    v srpnu `mode: None` u prop tokenů.
- **Aktuálnost:** IBKR, Rithmic i Databento jsou realtime v desítkách ms.
  Úzké místo je náš přenos do appky (Supabase Realtime ~5 zpráv/s), ne zdroj
  (viz předávka §3.4).

**Doporučení:**
1. **Teď osobně:** IBKR podle předávky, sonda navíc s porovnáním proti
   Databentu (historické obchody MNQ za jeden den stojí v pay-as-you-go
   řádově centy, NEOVĚŘENO).
2. **Když IBKR ticky prokazatelně ztrácí:** Rithmic přes brokera.
3. **Pro platformu (později):** prozkoumat dvě cesty, jak brát data z
   připojení uživatele: Rithmic R|Protocol s conformance, nebo podmínky
   partnerství s Tradovate pro data. Rozhodnout dřív, než se začne stavět
   obchodování z appky. To je dotaz pro Codex v §4.

---

## 2. Srovnání (stav 27. 10. 2026)

| Zdroj | Cena / měs. | Každý obchod? | API | Pro platformu | Spolehlivost údajů |
|---|---|---|---|---|---|
| **IBKR** (TWS / IB Gateway) | ~1,55 + účet ≥ 500 USD | `AllLast` = jejich Time & Sales; úplnost u futures sporná | socket přes Gateway (Java), Node `@stoqey/ib` | data jen pro Filipa | předávka + dokumentace IBKR |
| IBKR Web API (OAuth) | stejné | spíš ne: snímky, odběr `smd` končí po 10 min | REST + WebSocket bez Gateway (pro jednotlivce nejasné) | ne | changelog IBKR; zbytek NEOVĚŘENO |
| **Rithmic** přes brokera (AMP, EdgeClear, Optimus…) | ~20–25 USD za uživatele + CME 1,55; u brokera i 0,10 USD/kontrakt | ano, nefiltrovaný | R|Protocol: WebSocket + protobuf, jde z Node i prohlížeče; produkce jen po conformance | **ano:** většina prop firem a platforem jede přes Rithmic | NEOVĚŘENO (ceny různé) |
| CQG WebAPI (přes AMP) | ? | ano (L1/L2, historie ticků) | WebSocket + protobuf, model ASP | možná | cena NEOVĚŘENO |
| tastytrade (DXLink) | 0 k financovanému účtu | `TimeAndSale` existuje; pro CME futures NEOVĚŘENO | WebSocket | data jen pro držitele účtu | podpora tastytrade |
| Webull OpenAPI | ? + předplatné CME | NEOVĚŘENO | MQTT stream | ne | dokumentace Webull |
| Tradovate API, vlastní data | 25 USD + smlouva CME ILA (~290–500 USD) | ano | WebSocket | prop a evaluation účty na osobní API klíč nemají nárok | podpora Tradovate; cena ILA NEOVĚŘENO |
| Databento (CME Standard) | 199 USD (od 22. 6. 2026) + licence CME | ano, MDP 3.0 | Node/Python | jen s licencí k distribuci | blog Databento |
| Massive (dříve Polygon), futures | 199 USD realtime (jen neprofesionál), 79 USD se zpožděním | ? | WebSocket | ne | ceník Massive |
| tickstream (tick-stream.xyz) | 29 USD | „live ticks“, nespecifikováno | ? | ne | **varování:** web neuvádí firmu ani zemi, licenci CME nedokládá → nepoužívat |
| ProjectX | — | — | — | od 28. 2. 2026 jen Topstep, Lucid ani Tradeify ne | NEOVĚŘENO |
| TV (dnes, CDP) | 0 | ne, snímky ~2,5/s | — | ne, šedá zóna podmínek | vlastní měření 26. 10. |

Burza CME (ceník k 1. 1. 2026, neprofesionál):

| Položka | Cena | Pozn. |
|---|---|---|
| L1 (top of book), za zařízení | 1,55 USD/měs. | balíček 4 burz 4,65 USD; 2027: 1,60 / 4,80 USD |
| L2 (hloubka trhu) | 12,10 USD/měs. za burzu | NEOVĚŘENO, zdroje se rozcházejí |
| Licence k distribuci realtime | 29 280 USD ročně za burzu | jen z výtahu ceníku, NEOVĚŘENO v PDF |

NQ i MNQ jsou na burze CME, takže stačí jedna burza.

---

## 3. Co to znamená pro naši vizi

**Fáze „jen Filip“ (teď):** stačí osobní předplatné (IBKR). Data se ukazují
jen Filipovi na jeho zařízeních. NEOVĚŘENO: jestli přenos přes náš cloud na
jeho telefon podmínky neprofesionálního předplatného nepřekračuje. Ověřit
v podmínkách IBKR a CME (dotaz v §4).

**Fáze „obchodování z appky“ (Filip):** cena musí sedět s tím, kde se
plní příkazy. Prop účty jsou na Tradovate, který bere data přímo z CME. Každý
úplný feed CME (IBKR, pokud projde sondou, Rithmic, Databento) se bude
shodovat. Snímky TV ne.

**Fáze „komerční produkt“ (další uživatelé):**
- **Data přes nás:** licence k distribuci + hlášení každého uživatele CME.
  Řádově desítky tisíc USD ročně a administrativa.
- **Data přes připojení uživatele:** platforma žádnou licenci na data
  nedrží, data patří k obchodnímu účtu uživatele. Takhle fungují Quantower,
  ATAS, Bookmap (Rithmic) a Bookmap má i adaptér na Tradovate pro data
  a obchodování.
- Kopírka i obchodování dnes stojí na Tradovate OAuth. Přechod prop účtů na
  Rithmic by byla velká změna jádra. **Nic z toho teď nestavět.** Napřed
  zjistit, jestli Tradovate pro partnerské aplikace nějakou cestu k datům
  uživatele má.

---

## 4. Dotaz pro Codex (zkopírovat celý)

```text
Jsi research analytik. Udělej důkladnou rešerši na webu (stav k říjnu 2026)
a odpověz česky. Nic nezakládej, neregistruj se, nikam nepiš e-maily ani
formuláře, žádné přihlášení. Jen čti veřejné zdroje.

## Kontext
Stavím osobní trading journal a nástroj pro živé obchodování (React web
+ iPhone appka přes Capacitor, Supabase, serverové funkce na Vercelu,
lokální worker v Node/TypeScript na Macu). Obchoduji NQ/MNQ (CME) na prop
účtech Lucid Trading (leader) a Tradeify (followeři). Oboje přes Tradovate.
Moje aplikace je napojená přes Tradovate OAuth (účty, pozice, příkazy;
kopírka obchodů z leadera na followery). Přes Tradovate API nedostanu tržní
data: bez smlouvy CME „sub-vendor“ (ILA) vrací „The symbol is inaccessible“.

Dnes beru živou cenu z TradingView Desktop přes Chrome DevTools Protocol.
Je to šedá zóna podmínek TV a jsou to jen snímky, ~2,5 zprávy/s, mezi nimi
4–10+ kontraktů. Chci oficiální, licencovaný zdroj s každým obchodem
(tick-by-tick / time & sales), abych mohl kreslit přesné živé svíčky
(i knoty), živé P&L, dnešní 1m svíčky celé session od 18:00 ET (VWAP),
hlubokou historii vyšších timeframů a časem zrušit předplatné TradingView.

Vize: dnes jen pro mě. Později obchodování přímo z mé aplikace (začít
akcemi snižujícími riziko: posun SL na BE, zavření, úprava SL/TP). Ještě
později možná komerční produkt pro další prop tradery.

## Co už vím (ověř, oprav, doplň, neopakuj zbytečně)
- CME, neprofesionál, L1: 1,55 USD/měs. za zařízení (2026), 1,60 (2027).
  Licence k distribuci realtime údajně 29 280 USD ročně za burzu (ověřit
  v cmegroup.com: january-2026-market-data-fee-list.pdf, Schedule 5 to ILA).
- IBKR: reqTickByTickData AllLast, předplatné „CME Real-Time (NP, L1)“
  ~1,55 USD, účet ≥ 500 USD, IB Gateway (Java), týdenní 2FA, jen pár
  souběžných tick-by-tick odběrů. Fóra tvrdí, že IBKR u futures ticky
  filtruje či slučuje.
- Rithmic: nefiltrovaný, R|Protocol (WebSocket + protobuf), do produkce
  jen po conformance; přes brokery ~20–25 USD/měs. za uživatele.
- Tradovate API: 25 USD/měs., živý účet ≥ 1 000 USD, prop/eval účty na
  osobní API klíč nárok nemají, data jen se smlouvou CME ILA (~290–500 USD).
- Databento CME Standard 199 USD/měs. od 22. 6. 2026; Massive futures
  realtime 199 USD; tastytrade data zdarma k financovanému účtu (futures přes
  API neověřeno); ProjectX od 28. 2. 2026 jen Topstep.
- tick-stream.xyz nabízí realtime CME za 29 USD, ale neuvádí firmu ani
  licenci. Ověř, zda je legitimní.

## Otázky
A) Osobní tick-by-tick feed pro NQ/MNQ, co nejlevnější a nejúplnější:
  1. Je IBKR AllLast u CME futures opravdu každý obchod? Najdi měření,
     oficiální vyjádření IBKR, srovnání s Rithmic/CQG/Databento.
     A limity: kolik souběžných tick-by-tick odběrů, pacing historických
     dotazů, chování IB Gateway při přihlášení stejného uživatele v mobilu.
  2. tastytrade: dostanu přes API (DXLink) realtime CME futures včetně
     TimeAndSale pro NQ/MNQ? Za kolik, jaký vklad, jde to z EU/ČR?
  3. Webull OpenAPI, CQG WebAPI (AMP aj.), dxFeed, Barchart/cmdty, Kinetick,
     Optimus Flow a další: cena, každý obchod ano/ne, dostupnost z ČR.
  4. Rithmic jako osobní feed: nejlevnější broker pro klienta z EU,
     měsíční poplatky, minimální vklad, conformance pro osobní nástroj
     (cena, délka, jde to s Node.js přes R|Protocol?), R|Trader Pro
     plug-in mode jako alternativa.
  5. Existuje v roce 2026 nová levná legální služba, kterou jsem minul?
     U každé ověř licenci CME.

B) Data přes obchodní připojení uživatele (pro vizi platformy):
  1. Tradovate: existuje pro partnerské OAuth aplikace (vendor/partner
     program Tradovate nebo NinjaTrader) cesta, jak dostat tržní data pod
     předplatným uživatele, i u prop účtů? Jak to mají TradingView, Bookmap
     (adaptér Tradovate pro data i obchodování), Jigsaw, PickMyTrade a další?
     Podmínky, ceny, kontakt.
  2. Rithmic: jak funguje „certified/conformed platform“ (Quantower, ATAS,
     Bookmap, Sierra Chart…)? Proces conformance, poplatky, délka, jestli
     smí jít o webovou nebo mobilní appku se serverovou částí, limity
     připojení na prop účet (např. Topstep 2 zařízení), čí je datové
     předplatné.
  3. Nabízí Lucid Trading a Tradeify v roce 2026 účty na Rithmicu? Jaké
     platformy oficiálně podporují? Zdroje si odporují, chci jejich vlastní
     stránky.
  4. CQG WebAPI v modelu ASP pro platformu třetí strany: podmínky a ceny.

C) Licence a pravidla:
  1. CME: rozdíl distributor / sub-vendor / non-display / derived data.
     Kolik stojí a co obnáší, když moje platforma ukazuje realtime CME
     data dalším uživatelům? Hlášení uživatelů, poplatky za uživatele, roční
     licence. Primární zdroje CME (fee list 2026/2027, ILA, Schedule 5).
  2. Smím s osobním neprofesionálním předplatným (IBKR nebo jiný) posílat
     data přes vlastní cloud (Supabase) na vlastní iPhone? Smím ukládat
     1m svíčky odvozené z ticků (derived data)?
  3. Je trader na prop účtu (evaluation / funded, Lucid, Tradeify) pro
     data CME neprofesionál? Co přesně říkají definice CME a dotazník IBKR?
  4. Pravidla Lucid a Tradeify k obchodování přes API z vlastní aplikace
     (ruční příkazy přes OAuth app, ne bot). Písemné zdroje.

D) Rychlost a úplnost:
  1. Měřené zpoždění a úplnost (počet ticků za minutu proti CME) pro IBKR,
     Rithmic, CQG, Tradovate, dxFeed, Databento.
  2. Který feed nejlépe odpovídá tomu, co vidí a jak plní Tradovate?

## Formát odpovědi
1. Shrnutí na 10 řádků: nejlepší volba (a) pro mě teď, (b) pro
   obchodování z appky, (c) pro komerční produkt. Proč.
2. Tabulka: zdroj | cena/měs. (vč. burzy) | min. vklad | každý obchod? |
   API a jazyk | dostupnost z ČR | vhodné pro platformu? | zdroj (URL)
   + datum + primární/sekundární.
3. Ke každé otázce A–D odpověď s odkazy. Co jsi nenašel, napiš výslovně.
   Nic si nedomýšlej.
4. Varování: šedé zóny, podmínky, které by vedly k banu nebo zrušení
   prop účtu, podezřelí prodejci.
5. Seznam konkrétních dotazů, které mám poslat prodejcům (IBKR, Rithmic,
   Tradovate, Lucid, Tradeify, CME), s adresou nebo stránkou, kam je poslat.

Preferuj primární zdroje (dokumentace a ceníky prodejců, CME, podpora
brokerů). Blogy prodejců copierů a „prop firm guide“ weby ber jako
sekundární a označ je tak. U každé ceny uveď datum zdroje.
```

---

## 5. Zdroje (rešerše 27. 10. 2026)

- CME ceník 2026: https://www.cmegroup.com/market-data/files/january-2026-market-data-fee-list.pdf
- CME ceník 2027: https://www.cmegroup.com/market-data/files/january-2027-market-data-fee-list.pdf
- CME Schedule 5 k ILA: https://www.cmegroup.com/market-data/files/schedule-5-to-the-ila-january-2026.pdf
- Tradovate API Access (podpora): https://support.tradovate.com/s/article/Tradovate-API-Access?language=en_US
- Licence CME a Tradovate API (sekundární): https://autoview.com/guides/cme-license-tradovate-api/
- Rithmic API suite: https://www.rithmic.com/products/api-suite
- Rithmic poplatky přes AMP: https://faq.ampfutures.com/hc/en-us/articles/360060137993
- Databento ceny 2026: https://databento.com/blog/updates-to-subscription-pricing
- Massive futures: https://massive.com/futures
- tickstream: https://tick-stream.xyz/
- tastytrade data k financovanému účtu: https://support.tastytrade.com/support/s/solutions/articles/43000475299
- tastytrade market data (dev): https://developer.tastytrade.com/docs/concepts/market-data/
- Webull Market Data API: https://developer.webull.com/apis/docs/market-data-api/overview/
- CQG WebAPI: https://help.cqg.com/apihelp/Documents/cqgwebapi.htm
- IBKR Web API changelog: https://www.interactivebrokers.com/campus/ibkr-api-page/web-api-changelog/
- IBKR live ticks (AllLast): https://www.interactivebrokers.com/docs/tws-api/doc/md/live-ticks
- Fórum: IB vs Rithmic ticky: https://nexusfi.com/showthread.php?p=254477
- ProjectX jen Topstep (sekundární): https://blog.traderspost.io/article/what-is-projectx-prop-firms
- Bookmap konektivita: https://bookmap.com/knowledgebase/docs/KB-IntroductionToBookmap-Connectivity
- Prop firmy a Rithmic (sekundární): https://damnpropfirms.com/prop-firms-with-rithmic/

---

## 6. Doplnění 27. 10. večer (výsledek Codexu + kontrola)

- **CME WebSocket API (přímo od burzy):** top of book je sloučený po 500 ms,
  obchody chodí zvlášť. Placené po GB (od 0,50 USD/GB) **plus poplatky ILA**:
  stejná licenční bariéra jako data přes Tradovate API. Pro osobní levný
  zdroj nevhodné. Zdroj: https://www.cmegroup.com/market-data/real-time-futures-and-options-data-api.html
- **IBKR, limit 15 s:** stejný instrument jde přes tick-by-tick požádat
  nejvýš jednou za 15 s. Pro sondu i budoucí vlákno: po výpadku nebo
  restartu znovu odebírat nejdřív po 15 s. Hlídač s kratší prodlevou by
  dostal chybu a jistič by vlákno zbytečně vypnul. Klient do té doby ukáže
  kotvu brokera bez pohybu. Stačí jeden stream (přední MNQ; NQ je stejná
  cenová rodina), druhý jen pro BidAsk.
- **Live účet Tradovate (2106581) na závěru nic nemění.** Tradovate na
  podpoře uvádí, že doplněk API za 25 USD pokrývá účet a příkazy, ne tržní
  data. Ta jdou přes API jen se smlouvou CME „sub-vendor“ (ILA), bez ohledu
  na typ účtu. Předplatné dat na live účtu platí jen pro zobrazení v aplikacích
  Tradovate. Upřesnění: naše sonda 27. 8. (`scripts/market-data/quoteAccessProbe.ts`)
  běžela jen s prop OAuth tokeny (`mode: None`). Live účet sám přímo
  testovaný nebyl. Tvrzení „i na živém účtu“ v předávce IBKR §1.2 vychází
  z podpory a fóra Tradovate, ne z našeho měření.
- Live účet je ale podmínka API vůbec (≥ 1 000 USD + doplněk). Na něm visí
  registrace OAuth aplikace, přes kterou jede kopírka (equity v srpnu
  1 025 USD).

---

## 7. Volba zdroje s ohledem na obchodování z appky (27. 10. večer)

Filip: „počítáš s tím, že do budoucna budeme obchodovat přímo z naší appky?“

- **Zdroj nemusí být stejný jako broker, musí být úplný z CME.** Příkazy
  půjdou dál na Tradovate (OAuth už má oprávnění k příkazům). Tradovate plní
  na CME. Každý úplný feed CME (IBKR, pokud projde sondou proti Databentu,
  Rithmic, Databento) ukáže stejné ceny jako Tradovate. Snímky TV ne.
- **Rychlost na Macu:** ticky IBKR z USA do Gateway na Macu a lokálně do appky
  (127.0.0.1:3211) jsou rychlé jako Tradovate. Úzké místo je telefon:
  Supabase Realtime ~5 zpráv/s a další síť. Pro obchodování z telefonu je
  potřeba dávkování po ~100 ms (fáze 3) a vždy vidět stáří ceny.
- **Závislost na Macu:** Gateway na Macu = bez zapnutého Macu nemá telefon
  cenu. Pro obchodování z telefonu odkudkoli musí zdroj běžet na VPS. IB
  Gateway běží i na Linuxu, takže to sedí s plánem přesunu workeru
  (`docs/COPIER_VPS_PLAN.md`).
- **Pravidlo „jen zobrazení“ i při obchodování (doporučení, rozhoduje Filip):**
  cena z IBKR nesmí do příkazu, risku ani limitů. Příkazy stavět jen z dat
  brokera a voleb člověka: market, úrovně zvolené uživatelem, offsety
  bracketu vůči fillu, BE ze vstupu brokera. Pak je volba zdroje otázka
  kvality, ne bezpečnosti, a zdroj jde vyměnit (IBKR → Rithmic → Tradovate)
  jen výměnou vlákna.
- **Stará cena:** nový vstup z appky jen s čerstvou cenou (fail-closed). Akce
  snižující riziko (zavřít, BE, posun SL) vždy dostupné bez ohledu na cenu,
  obdoba INV-UI-02.
- **Jádro kopírky:** příkaz na leadera kopírka zkopíruje. Obchodování z appky
  je proto změna jádra: invarianty a `copier-design-critic` nad návrhem
  i diffem.
- **Komerční produkt:** IBKR je osobní licence, pro další uživatele nepoužitelný.
  To ale dnes žádnou cestu nezavírá. Pro produkt platí §3 (data přes
  připojení uživatele nebo licence). Rozhodnout před stavbou obchodování
  pro další lidi, ne teď.
- **Alternativa „data od Tradovate“** (jedno místo pro cenu i příkazy, bez
  Gateway) stojí smlouvu CME ILA, ~290–500 USD/měs. (NEOVĚŘENO). To dává smysl
  až pro komerční produkt, kde licenci stejně potřebujeme.
