# Živá data z Interactive Brokers — předávka pro novou session (27. 10. 2026)

Pro koho: nová session, která bude řešit živá tržní data z Interactive Brokers
(IBKR) a navazující věci kolem live obchodování. Dokument shrnuje všechno, co
jsme k tomu 26.–27. 10. zjistili, rozhodli a postavili.

Než začneš: přečti `docs/PROJECT_LOG.md` (sdílená paměť), `AGENTS.md`,
`CLAUDE.md` a `docs/COPIER_INVARIANTS.md` (hlavně INV-UI-01..04,
INV-WORKER-04, INV-RELAY-04, INV-FRESH-03, INV-TRAD-04). Návrh k tomuhle
projektu, z něhož IBKR vychází: `docs/reviews/tv-price-channel-design-20261026.md`
a `docs/reviews/candles-realtime-pnl-20261026.md`.

Značka **NEOVĚŘENO** = zjištěno z dokumentace nebo fór, ne vlastním měřením.

---

## 0. Shrnutí

- Cena z TradingView (TV), kterou dnes appka ukazuje v živém P&L a živé svíčce,
  je **sloučená**: TV Desktop dostává MNQ jen ~2,5× za sekundu a mezi zprávami
  přibude 4–10 i víc kontraktů. Při rychlém pohybu proto svíčka v appce není
  identická s Tradovate a dorovná se až později. To Filipovi vadí.
- Nejlevnější **oficiální** zdroj každého obchodu (tick-by-tick) je IBKR:
  `reqTickByTickData` v režimu `AllLast`, předplatné CME L1 pro neprofesionála
  ~1,55 USD/měs. (+ případně DPH), na účtu musí ležet ≥ 500 USD.
- Filip 26. 10.: „Asi ten IBKR by byl jednodušší“, ale „nechci nikam nic
  zadávat, dokud nebudu mít jistotu, že to bude 100% fungovat“ → zatím zůstal
  TV. Později: „než se trefíme do IBKR, což bude velké…“ → **IBKR je další
  velký projekt**. Účet zatím otevřený NENÍ.
- Výměna zdroje je navržená tak, aby se měnilo jen vlákno ve workeru.
  Podepsaný kanál, klient, živé P&L a svíčka zůstanou.
- IBKR by navíc vyřešil i dnešní svíčky (a tím VWAP, viz §7) a hlubší
  historii vyšších timeframů. Dlouhodobě je to cesta, jak se zbavit
  předplatného TradingView (~20 000 Kč ročně).

---

## 1. Proč IBKR — co jsme zjistili

### 1.1 Měření TradingView (26. 10., CDP Network, jen čtení)

- TV Desktop dostává `qsd` pro MNQ1! ~2,5×/s: mezery p50 ~400 ms, max ~850 ms.
- Mezi zprávami 4–10 i > 10 kontraktů → TV **slučuje**, nedává každý obchod.
- Náš kanál posílá 2,8 zprávy/s, je tedy skoro na stropu toho, co TV dostává.
  Pasivní poslech WebSocketu TV by to výrazně nezrychlil.
- V TV má Filip realtime CME data (`update_mode=streaming`). 1T grafy jsou jen
  v tarifech Expert/Ultimate.
- **Licence:** podmínky TV v §3 zakazují automatický sběr dat. Náš CDP kanál
  je tedy šedá zóna: hrozí ban TV účtu (prop účtů se to netýká). To je další
  důvod přejít na oficiální zdroj.

### 1.2 Srovnání zdrojů (rešerše 26. 10.)

| Možnost | Cena / měs. | Každý obchod? | Poznámka |
|---|---|---|---|
| **IBKR** (TWS / IB Gateway) | ~1,55 USD + ≥ 500 USD na účtu | ano, `reqTickByTickData AllLast` (= jejich Time & Sales); `reqMktData` jsou jen snímky po 250 ms | IB Gateway v Javě (Mac i Linux), denní restart, týdenní 2FA; souběžně jen pár tick-by-tick odběrů (podle dokumentace ~3–5) |
| tastytrade (DXLink) | 0 USD k financovanému účtu | TimeAndSale ano; pro CME futures přes API NEOVĚŘENO | možná vklad 2 000 USD (NEOVĚŘENO); oficiální API, ČR podle seznamu třetí strany |
| Rithmic přes brokera | ~25–130 USD | ano, nefiltrováno | navíc conformance test u Rithmicu |
| Databento / Massive | ~199 USD a víc | ano | drahé; Databento už používáme pro historii (zpoždění 24 h) |
| Tradovate API, vlastní data | 25 USD + CME licence 290–500 USD | ano | licence CME „non-display“; bez ní „The symbol is inaccessible“ i na živém účtu (proto `mode: None` u prop tokenů v srpnu) |
| TV (dnes) | 0 USD navíc | ne, snímky | šedá zóna podmínek |

**Zamítnuto:**
- Čtení webového Tradovate (trader.tradovate.com): technicky by dalo každý
  tick, ale EULA to zakazuje a jde o platformu prop účtů. Navíc není jisté,
  jestli by druhé přihlášení neshazovalo to obchodní.
- Rithmic přes Lucid/Tradeify: data jsou licencovaná k obchodování daného
  účtu a účty bez obchodů se ruší.
- NinjaTrader: jen Windows, data ven nepustí.
- Neoficiální TV knihovny: dávají jen snímky a hrozí ban.
- Dále Schwab (min. ~25 000 USD, jen snímky), CQG (~245 USD), Webull,
  Kraken US, ProjectX (jen Topstep), WH SelfInvest (bez API).

### 1.3 Rychlost

- Zdroj: IBKR i Tradovate posílají z amerických serverů, zpoždění v desítkách
  ms. Detail je stejný jako u Tradovate (každý obchod), takže svíčka sedí
  přesně, včetně rychlých knotů.
- Úzké místo je náš přenos: dnes nejvýš ~5 zpráv/s kvůli kvótě Supabase
  Realtime, ale MNQ má v pohybu desítky až stovky obchodů za sekundu.
  Návrh je v §3.4.

---

## 2. Co musí udělat Filip

1. Otevřít účet **IBKR Pro** přes evropskou pobočku (pro ČR IBKR Central
   Europe, případně LYNX). Osobní účet, doklad totožnosti a bydliště,
   dotazník; schválení trvá pár dní.
2. Vložit aspoň **500 USD** (klidně v CZK nebo EUR). Peníze zůstávají jeho,
   jen nesmí klesnout pod limit, jinak IBKR data vypne. IBKR uvádí jeden
   výběr měsíčně zdarma.
3. V Client Portalu: Settings → Market Data Subscriptions → **„CME Real-Time
   (NP, L1)“**.
4. Vyplnit dotazník **Non-Professional** a podepsat smlouvy burzy.
5. **Přihlašovací údaje nikdy neposílat do chatu.** IB Gateway si spustí
   a přihlásí sám. Claude údaje nikam nezadává.

**Neúspěch stojí** ~2 USD za jeden měsíc dat. Předplatné jde kdykoli zrušit
a 500 USD vybrat. Zkouška předem nejde: paper účet má realtime data jen
tehdy, když je předplatné na ostrém účtu.

**NEOVĚŘENO (zjistí se až po zapnutí):**
- přesná měsíční cena u IBKR včetně DPH a jestli platí starší balíček
  10 USD/měs. (odpouští se při poplatcích > 30 USD);
- **jedno přihlášení na uživatele**: přihlášení do IBKR v mobilu může shodit
  Gateway na Macu. Řešením je druhý uživatel jen pro API, ten ale platí
  data zvlášť (další ~1,55 USD);
- jestli je potřeba zapnout oprávnění k obchodování futures, i když se
  obchodovat nebude;
- jak spolehlivě poběží Gateway na Macu vedle workeru.

---

## 3. Jak by to fungovalo (architektura)

```
IB Gateway (Mac, Java, IBC: denní restart; týdenní 2FA přihlášení Filip)
   │  socket 127.0.0.1:4001 (živý účet; 4002 = paper), vlastní clientId
   ▼
vlákno workeru „ibkr-price-stream“ (worker_threads, jako dnešní TV vlákno)
   │  reqContractDetails → přední kontrakt MNQ (např. MNQZ6)
   │  reqTickByTickData(AllLast) → každý obchod (cena, objem, čas)
   │  reqHistoricalData(1 min, keepUpToDate) → dnešní svíčky
   ▼
podepsané zprávy (HMAC, klíč per zařízení) → Supabase Realtime kanál
   │  (téma a klíč odvozuje relay ze `TV_PRICE_CHANNEL_SECRET`)
   ▼
klient: store ceny → živé P&L (LiveOpenPnlValue) · živá svíčka grafu dne ·
        deník (štítek živé pozice)
```

### 3.1 Co dnes existuje a zůstane (kanál ceny z TV, nasazeno 26. 10.)

| Vrstva | Soubor | Poznámka pro IBKR |
|---|---|---|
| Čtení ceny z TV (CDP 9222) | `services/tradingViewMarketPrice.ts`, `services/tradingViewPriceStream.ts` | nahradí čtení z Gateway |
| Vlákno ve workeru | `scripts/copier/tvPriceStreamThread.ts` (bundle `tv-price-stream.mjs`, allowlist importů v testu) | nové vlákno vedle něj, stejný vzor |
| Hlídač vlákna | `server/tvPriceStreamSupervisor.ts` (restart s prodlevou, jistič 3 pády / 10 min, liveness) | znovu použít |
| Téma a klíč kanálu | `server/tvPriceChannel.ts` (relay, per zařízení, jen při živém heartbeatu) | beze změny |
| Podepsaná zpráva | `lib/tvPriceMessage.ts` (HMAC nad surovým JSON, přísná validace) | rozšířit o zdroj a dávku obchodů |
| Klient: store | `lib/tvPriceStore.ts` (jen paměť, `seq`/`runId`/`at`, čerstvost 2 s) | zobecnit na zdroj `tv` / `ibkr` |
| Klient: kanál a grant | `lib/tvPriceChannelClient.ts`, `services/tvPriceChannel.ts`, `services/tvPriceGrant.ts` | beze změny |
| Živé P&L | `lib/tvLivePnl.ts` (kotva brokera + pohyb ceny), `components/LiveOpenPnlValue.tsx` (jediné místo s hodnotou s pohybem, štítek „živě · TV“) | štítek podle zdroje |
| Živá svíčka grafu dne | `lib/tvLiveCandle.ts`, `hooks/useTvLiveCandleFeed.ts` → neutrální `lib/liveCandleFeed.ts`, `hooks/useLiveCandleBinding.ts` | ze skutečných obchodů místo 1m baru TV |
| Sonda měření | `scripts/market-data/tvPriceFeedProbe.ts` | vzor pro sondu IBKR |

Vypnutí kanálu dnes: smazat `TV_PRICE_CHANNEL_SECRET` ve Vercelu (+ redeploy),
nebo reinstall workeru s `COPIER_TV_STREAM=off`.

### 3.2 IB Gateway

- Spouštět s **IBC** (github.com/IbcAlpha/IBC): automatické přihlášení
  a denní restart. Týdenní 2FA potvrzuje Filip v mobilu.
- V nastavení API zapnout **„Read-Only API“**: přes tohle spojení pak nejde
  poslat žádný příkaz. Účet slouží jen k datům.
- Vlastní `clientId` pro worker. Socket jen na 127.0.0.1.

### 3.3 Kontrakt a ticky

- Přední kontrakt MNQ přes `reqContractDetails` a hlídat roll; MNQ a NQ jsou
  jedna cenová rodina (`lib/tvLivePnl.ts` počítá jen NQ/MNQ).
- `reqTickByTickData(…, "AllLast", 0, false)`: každý obchod. Volitelně
  `BidAsk` pro bid/ask. Pozor na limit souběžných tick-by-tick odběrů.
- Ověřit, že každý obchod opravdu chodí: součet objemů za den porovnat
  s denním objemem a s TV; jednu rychlou minutu porovnat (OHLC) s Tradovate.

### 3.4 Přenos do appky

- Dnes je strop ~5 zpráv/s (kvóta Supabase Realtime). Návrh: posílat
  každých ~100 ms jednu zprávu se všemi obchody od minulé (poslední cena,
  high/low, objem, počet). Oko to vidí jako plynulý pohyb a svíčka je přesná.
  Cena: víc zpráv, odhadem pár USD/měs. navíc za Supabase (NEOVĚŘENO,
  změřit).
- Na Macu by appka mohla brát ticky přímo od workeru na stejném počítači
  (lokální agent 127.0.0.1:3211), bez sítě. To je stejně rychlé jako Tradovate.

### 3.5 Svíčky z IBKR

- **Dnešní svíčky:** dnes je worker každých 60 s čte z grafu TV
  (`services/tradingViewBars.ts`, `TV_LIVE_BARS_INTERVAL_MS`) a **přepisuje**
  soubor `<user>/tv-live/NQ.json` (`lib/tradingViewBars.ts`
  `tvLiveBarsStoragePath`, čte `services/liveCandles.ts`). Graf TV má na 1m
  jen ~330 svíček (~5,5 h). Z IBKR jde vzít celá session od 18:00 ET
  (`reqHistoricalData`, `keepUpToDate`), i po spánku Macu. To opraví VWAP
  i hodnocení dnešních obchodů (§7).
- **Svíčky po výstupu z obchodu** (65 s a 20 min po exitu, `tv-bars`) pro
  hodnocení: z IBKR přesně.
- **Vyšší timeframy:** IBKR dává denní a hodinové svíčky kontinuálních
  futures hluboko do minulosti. Filip chtěl denní data na roky zpátky jako
  v TV.
- **Backtest:** 1m svíčky jdou stáhnout i za starší období, včetně
  expirovaných kontraktů (~2 roky po expiraci, NEOVĚŘENO). IBKR ale omezuje
  počet dotazů (podle dokumentace ~60 historických za 10 min, NEOVĚŘENO),
  takže velkou historii stáhnout jednou, uložit a jen doplňovat. Historické
  ticky jen po 1 000 na dotaz. Hlubokou historii pro backtest nechat
  Databentu.

### 3.6 Knihovna

Worker je Node/TypeScript. Kandidáti (vybrat ve fázi 1):
- `@stoqey/ib` (TypeScript port IB API) — přímo ve vlákně workeru (NEOVĚŘENO);
- Python `ib_async` jako samostatný proces vedle workeru (ověřená knihovna,
  ale další runtime na Macu).

### 3.7 Záloha a vypínače

- TV zdroj nechat jako zálohu. Přepínač zdroje ve workeru (např.
  `COPIER_PRICE_SOURCE=ibkr|tv`).
- Hlídač a jistič jako u TV vlákna. Serverový vypínač zůstává (bez tajemství
  se kanál nenabízí).
- Výpadek Gateway (denní restart, chybějící týdenní přihlášení) → klient ukáže
  kotvu brokera bez pohybu, nic nepředstírá (stejně jako dnes bez TV).

---

## 4. Pravidla, která platí (nepřekročitelná)

- **Jen zobrazení:** cena z TV (a stejně z IBKR, dokud Filip nerozhodne jinak)
  nikdy nesmí do risku, day locku, limitů, kopírky, způsobilosti, automatiky
  ani úložišť. Hodnota s pohybem jde jen přes `components/LiveOpenPnlValue.tsx`
  (INV-UI-04, hlídá `tests/tvPriceClientGuards.test.ts`). Pro IBKR zavést
  obdobné pravidlo a test.
  - Výjimka, o které rozhodnout s oponentem: dnešní svíčky se už dnes ukládají
    jako předběžné (`tv-live`, `tv-bars`) pro graf dne a hodnocení. Z IBKR by
    šly stejnou cestou.
- **Izolace ve workeru (INV-WORKER-04):** zdroj ceny běží ve `worker_threads`
  se samostatným vstupem a allowlistem importů, s hlídačem a jističem. Pád
  nesmí shodit kopírku ani ji přepnout do DISARMED nebo crash loopu.
- **Kanál (INV-RELAY-04):** téma a klíč jen v paměti, nikdy do logu ani
  úložiště. Tajemství (`TV_PRICE_CHANNEL_SECRET`, přihlášení IBKR) se nikdy
  nevypisují.
- **Změna workeru** = jádro kopírky v širším smyslu: návrh i diff dát
  agentovi `copier-design-critic`; „BLOKUJE“ / „OPRAVIT PŘED COMMITEM“ řešit
  před commitem.
- **Nasazení workeru:** reinstall jen DISARMED, flat a reconciled
  (`scripts/copier/mac-reinstall-safe.sh`), v obchodní dny až po Filipově
  „nasaď“.
- **ARMED = nic těžkého:** před každým vitest/tsc/build ověřit
  `controller.armed` přímo v řetězu, který při ARMED skončí nenulově
  (27. 10. jednou běžela sada při ARMED, protože kontrola stav jen vypsala):

  ```bash
  curl -s -m 3 -H 'Origin: http://localhost:3000' http://127.0.0.1:3211/v1/status | python3 -c "import sys,json; sys.exit(1 if json.load(sys.stdin)['controller'].get('armed') else 0)" && npx vitest run
  ```
- Přihlašovací údaje Filipa Claude nikam nezadává a nepřihlašuje se za něj.
- Preview na 5273/3000 je přihlášené do skutečného účtu: neklikat na tlačítka
  se zápisem (Snímek, Zkontrolovat, BE…).
- Push na `main` = produkce (Vercel auto-deploy), jen s Filipovým souhlasem.

---

## 5. Plán po fázích

0. **Filip otevře účet** (§2). Do té doby se nic nestaví.
1. **Sonda, jen čtení** (`scripts/market-data/ibkrTickProbe.ts`, vzor
   `tvPriceFeedProbe.ts`): připojení k Gateway, přední kontrakt, `AllLast`.
   Měřit obchody/s, zpoždění, úplnost objemu proti TV a dennímu objemu
   a OHLC rychlé minuty proti Tradovate. Vybrat knihovnu (§3.6). Ověřit
   neověřené body z §2 (jedno přihlášení, cena).
2. **Vlákno ve workeru** za přepínačem zdroje, TV jako záloha. Zprávy se
   zdrojem. Kritik nad návrhem i diffem.
3. **Dávkování po ~100 ms** a měření kvóty Supabase. Na Macu případně lokální
   cesta bez sítě.
4. **Dnešní svíčky z IBKR** místo přepisu `tv-live`. Celá session → přesný
   VWAP a hodnocení dneška (§7).
5. **Vyšší timeframy z IBKR** (denní a hodinová historie).
6. **Snímky grafu z vlastního grafu** místo TV Desktopu (graf to umí, chybí
   napojení).
7. **Rozhodnutí o TradingView:** zrušit předplatné až ve chvíli, kdy měsíc
   nic nechybí. Dnes appka závisí na TV ve třech věcech: živá cena, dnešní
   svíčky a snímky grafu do deníku. Nabídnutý přehled „TradingView vs. naše
   appka“ (co Filip v TV denně používá vs. co máme) zatím nevznikl.

**Později a odděleně: obchodování z appky** (Filip se ptal 26. 10.)
- Reálné to je: OAuth k Tradovate už má oprávnění k příkazům, kopírka jimi
  posílá příkazy followerům, existuje Flatten All a tlačítko BE. Příkaz na
  leadera by kopírka zkopírovala.
- Rychlost podle cesty:

  | Cesta | Rychlost |
  |---|---|
  | Mac přes lokální worker (otevřené spojení k Tradovate) | jako Tradovate |
  | Telefon přes serverovou funkci v USA | +30–100 ms (odhad), musí být zahřátá |
  | Dnešní cesta příkazů přes relay a frontu | stovky ms až ~1 s, na market nevhodné |

- Doporučené pořadí:
  1. Nejdřív jen akce snižující riziko (posun SL na BE, uzavření, úprava
     SL/TP), hlavně z telefonu.
  2. Teprve potom nové vstupy, a to jen pokud Tradovate bude opravdu brzdit:
     nejdřív demo, vlastní bezpečnostní pravidla a kritik.
  3. Pravidla Lucid a Tradeify k ručnímu obchodování přes API z vlastní
     aplikace mít písemně.
- Bez spolehlivé ceny (IBKR) obchodovat z appky nedává smysl: uvidíš jednu
  cenu a vyplní tě jinde.
- IBKR má i L2 (hloubka trhu, „CME Real-Time Depth of Book“, dražší, cena
  NEOVĚŘENO). Pro P&L a svíčku stačí L1, L2 by mělo smysl jen pro DOM.

---

## 6. Současný stav live obchodování v appce (k 27. 10. 2026)

### 6.1 Data LIVE z brokera

- `components/useTradovateLiveData.ts` (App-level REST):
  - LIVE: kotva P&L po 3 s, plný tick po 6 s, bez pozice 15 s;
  - pozadí 30 s;
  - deník dneška (`journalFocus`): s pozicí plný tick po 6 s, jinak 30 s,
    restart čtení nejdřív 6 s od posledního.
- Limit Tradovate ~80 volání/min na token. Incident 18. 9.: ~90/min →
  Tradovate zavíral WebSocket workeru a kopírka nešla zapnout.
- 429 → penalizace podle `Retry-After`, jinak 5 min. Od 27. 10. se 429
  zapisuje i z ticku, jehož data se zahodí (INV-TRAD-04).
- Pozice a příkazy má LIVE hlavně z **heartbeatu workera** (každou sekundu)
  přes relay GET `/api/tradovate/oauth/copier-relay?connectionId=`.
  - Relay pro kterékoli připojení může vrátit starý runtime odpojeného
    zařízení → číst všechna připojení a přijmout jen připojený a čerstvý
    (< 15 s), revize nikdy zpět.
- `lib/tradovateWorkerExposureOverlay.ts`:
  - data z workeru se přijmou nejvýš 8 s stará;
  - followera překryjí jen tehdy, když worker jeho pozici prokazatelně zná:
    OK verdikt po porovnání, „drží X, očekáváno Y“ nebo záznam pozice;
  - zlikvidovaný účet, denní limit, příkazy mimo kopii, vypnutý režim nebo
    „pozice neověřena“ zůstanou na REST.
- Pozice jsou ověřené jen při čtení ≤ 45 s (`isLiveAccountReadVerified`).
- **Dvě OAuth připojení:** leader Lucid a followeři Tradeify jsou na různých
  loginech. Token vidí jen své účty, čtenář skupiny iteruje připojení.

### 6.2 Kanál ceny z TV, živé P&L a živá svíčka (nasazeno 26. 10. 13:07)

- Ověřeno naostro: 636/636 podpisů, 2,8 zprávy/s, zpoždění ~33 ms.
- Živé P&L = kotva brokera + pohyb ceny TV. Kotva smí být nejvýš 10 s stará,
  jinak se ukáže jen kotva. Hýbe se řádek účtu a „jeden obchod skupiny“
  (karta obchodu, Otevřený P&L skupiny). Ostrov, souhrn dne, DLL a jiné
  součty zůstávají z kotvy.
- Graf dne překresluje rozpracovanou minutu z 1m baru TV (`updateBar`), jen
  zobrazení. Má i čáru aktuální ceny a záběr se při nové svíčce nevrací.
- Pojistky: cena nenavazující na data grafu (> 0,2 %, jiný kontrakt) se
  nekreslí; bez ceny graf přesně zpět na svá data.

### 6.3 Živá pozice v grafu deníku (nasazeno 27. 10., `a78e6bbb`)

- **Co ukazuje** (deník dneška):
  - čáry vstupu (nebo čekajícího limitu), SL a TP;
  - štítek se směrem, kusy, symbolem a vstupem;
  - živé P&L (přes `LiveOpenPnlValue`), body SL/TP;
  - výchozí pohled je celá skupina (vážený vstup, SL/TP leadera, součet),
    výběrem jde přepnout na jeden účet.
- **Data:** stejný výpočet jako karta obchodu v LIVE (`buildTradeCard`). Stav
  workeru čte vlastní čtečka jen pro zobrazení
  (`lib/displayWorkerStatusReader.ts`, GET po 2 s, jen v popředí, čtení
  zahájené před skrytím se zahodí).
- **Fail-closed:** když něco nesedí, štítek řekne proč a čáry se nekreslí.
  - neověřené pozice, chybějící účet skupiny, neověřené příkazy čekajícího
    vstupu;
  - rozjetí skupiny se hlásí až po 10 s, do té doby „Kopie dobíhá…“, protože
    výstup i vstup on-submit se ke followerům kopírují se zpožděním. Rozjetí
    potvrzené kopírkou se ukáže hned. Follower s OK verdiktem (kopírka ho
    vědomě neřídí) poplach nespustí;
  - P&L starší než 15 s se neukáže.
- **Soubory:** `lib/journalLivePosition.ts`, `hooks/useJournalLivePosition.ts`,
  `components/day/DayLivePositionRunner.tsx`, `components/day/DayLivePositionChip.tsx`,
  `hooks/useLivePriceLinesBinding.ts`, `lib/livePriceLinesFeed.ts`,
  `lib/journalLivePositionStore.ts`. Poznámka v `docs/COPIER_INVARIANTS.md`
  pod INV-UI-03.
- **Oponent:** pět kol, poslední verdikt „OK s výhradami“, výhrady opravené.
- **Známá omezení:**
  - zavření a nový vstup stejné velikosti během jednoho cyklu REST nechá čáru
    vstupu do dalšího ticku na staré ceně;
  - po přikoupení nebo částečném zavření chybí v LIVE i v deníku vstup a P&L
    z TV, dokud vstup nepotvrdí REST (≤ 6 s).
- **NEOVĚŘENO na skutečném obchodu** (fill, přikoupení, uzavření). Viděno jen
  bez pozice.

### 6.4 iPhone

- Appka je Capacitor bundle (`capacitor-ios/`). Deploy webu ji neaktualizuje,
  každá změna webu = nový build (`npm run ios:sync` + `xcodebuild` +
  `devicectl`).
- 27. 10. 10:57 nainstalován build z `11721ac0`: živá pozice v deníku,
  kanál ceny z TV.
- Po čisté instalaci iOS znovu žádá povolení oznámení.

### 6.5 Další změny v LIVE 26. 10. (jiná session)

Rezerva DD u EOD účtů a šedé denní P&L, ručení workeru za zobrazenou částku
(`LiveAccount.displayVouch`, ≤ 45 s). Viz PROJECT_LOG a poznámka pod
INV-UI-03.

---

## 7. VWAP — rozdíl proti TradingView

**Diagnóza (27. 10. ráno):** výpočet je stejný jako v Pine
(`tradingview/liquidity-levels-cz-advanced.pine`, kotva 18:00 ET, hlc3
a objem) i v appce (`services/liquidityLevels.ts`). Liší se data.

| | TradingView | Appka |
|---|---|---|
| VWAP | 29 467,60 | 29 423,99 |
| Odchylka (1σ) | 70,26 | 56,41 |
| Dnešní data od | 18:00 ET | 21:40 ET |

- Dnešní svíčky bere worker z grafu TV, kde je na 1m načtených jen ~330
  svíček (~5,5 h). Soubor `tv-live` pokaždé přepíše posledním úsekem.
- Pine se počítá na serverech TV s celou historií.
- Databento noc doplní až za 24 h.
- U minulých dnů by VWAP měl sedět (celá data z Databenta), NEOVĚŘENO.

**Průběžná oprava (bez IBKR, změna workeru):**
- worker svíčky dne přidává k uloženým místo přepisu; když běží přes noc,
  má celou session;
- appka u neúplné session ukáže „VWAP od 21:40, neúplný“;
- když Mac přes noc spí, začátek dne se doplní až z Databenta druhý den;
- reinstall workeru až po „nasaď“.

**S IBKR:** celá session od 18:00 ET jde stáhnout kdykoli (§3.5), i po spánku
Macu. Průběžná oprava VWAP a fáze 4 sahají na stejné místo
(`services/tradingViewBars.ts` / `tv-live`). Pokud běží obě session souběžně,
domluvit se přes PROJECT_LOG, kdo ho mění.

---

## 8. Otevřené otázky a rozhodnutí

Rozhoduje Filip:
- otevřít účet IBKR (a případně druhého uživatele jen pro API);
- přehled „TradingView vs. naše appka“ (nabídnuto 26. 10., bez odpovědi);
- obchodování z appky: jen jako dlouhodobý cíl, od akcí snižujících riziko.

Mimo IBKR, ale otevřené:
- migrace CHECK `backtest_fills` pro `session-close` (produkční krok, souhlas);
- zmenšené náhledy kopírky přes transformace Supabase (stojí peníze).

---

## 9. Zdroje

- IBKR tick-by-tick: https://interactivebrokers.github.io/tws-api/tick_data.html
- IBKR běžná data (snímky 250 ms): https://interactivebrokers.github.io/tws-api/top_data.html
- IBKR limity tick-by-tick: https://www.interactivebrokers.com/docs/general/market-data-subscriptions/market-data-lines/specialized-market-data-lines
- IBKR minimum 500 USD: https://www.interactivebrokers.com/docs/general/market-data-subscriptions/market-data-subscription-minimum-equity-balance-requirements
- IBKR týdenní přihlášení: https://www.interactivebrokers.com/docs/tws-api/doc/tws-settings/daily-weekly-reauthentication
- IBKR paper účet a sdílení dat: https://www.interactivebrokers.co.uk/en/software/amcsh/PaperTrading.htm
- ib_async: https://github.com/ib-api-reloaded/ib_async · IBC: https://github.com/IbcAlpha/IBC
- Poplatky CME 2026 (NexusFi): https://nexusfi.com/a/data/exchange-data-fees-market-data-costs
- tastytrade streaming: https://developer.tastytrade.com/docs/concepts/streaming/
- dxFeed Trade vs TimeAndSale: https://kb.dxfeed.com/en/data-model/dxfeed-api-market-events.html
- Tradovate: cena API dat a licence CME: https://community.tradovate.com/t/does-this-api-work-anymore-how-much-does-it-cost/7458 · https://community.tradovate.com/t/is-cme-sub-vendor-requirement-for-api-access-is-290-per-month/6215
- TV ban a podmínky: https://www.tradingview.com/support/solutions/43000674726-why-is-my-account-banned-due-to-suspicious-activity/

---

## 10. Úvodní zpráva pro novou session (zkopírovat)

> Načti větev `claude/ibkr-handoff-20261027` (jen dokument, sluč do main)
> a přečti `docs/reviews/ibkr-live-data-handoff-20261027.md`. Týká se
> živých dat z Interactive Brokers (tick-by-tick místo ceny z TradingView)
> a navazujících věcí (dnešní svíčky, vyšší timeframy, náhrada TradingView).
> Účet IBKR zatím nemám. Začni tím, že mi řekneš, co přesně mám udělat
> a co postavíš jako první (sonda jen pro čtení), a hlídej pravidla z §4.
