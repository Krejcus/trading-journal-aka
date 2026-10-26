# Rychlý kanál ceny z TradingView, realtime P&L a živá svíčka — návrh v2 (krok 2, 26. 10. 2026)

Předávka: `candles-realtime-pnl-20261026.md` (body A–C, měření bod 7,
podklady bod 9). Pravidlo (Filip 26. 10.): **cena z TV smí počítat jen P&L
zobrazené na obrazovce; nikdy risk brány, day lock, limity, kopírku ani
jinou automatiku.** Stav: **návrh v2** — kritik: v1 „OPRAVIT PŘED
IMPLEMENTACÍ“, v2 **„OK S VÝHRADAMI“** (výhrady A–G zapracované, bod 7).
Neimplementováno.

## 0. Stav implementace (26. 10.)

- Krok 1 (relay, téma a klíč) — hotovo `7a492f03`, kritik OK.
- Krok 2 (vlákno ve workeru, výchozí vypnuto) — hotovo, kritik OK S
  VÝHRADAMI (zapracováno). Zkouška naostro: 2,3 zprávy/s, podpisy 28/28,
  worker → klient p50 32 ms, po odhlášení presence 0 zpráv.
- Krok 3 (klientský store + diagnostika) a krok 4 (živé P&L v listových
  komponentách) — hotovo. Odchylka od B: „jeden obchod skupiny“ (karta
  obchodu, buňka Otevřený P&L skupiny a souhrn skupiny na telefonu) se hýbe
  také — není to součet s limity a nohy musí projít všechny kontroly, jinak
  jen kotva. Ostrov, souhrn dne, DLL a jiné součty zůstávají z kotvy.
  Zkouška naostro (vlákno → Realtime → klientská knihovna): 19/19 podpisů,
  bez mezer, zpoždění 37 ms, výpočet na skutečné ceně MNQ = očekávaný pohyb,
  po odhlášení presence 0 zpráv. Náhled: řádky, skupina i karta se hýbou,
  po 2 s bez ceny návrat na kotvu.
- Nenasazeno: tajemství ve Vercelu + web, worker reinstall `--tv-stream on`.
- Další: krok 5 (živá svíčka v grafu dne), měření (bod 6).

## 1. Co dnes existuje (ověřeno v kódu)

- **Čtení TV ve workeru**: `startTradingViewMarketPriceFeed` (1 s, nové CDP
  spojení na každé čtení) → `marketPrices` ve statusu → heartbeat relaye po
  ~2 s → LIVE poll ~2,3 s. Stáří ceny na displeji 0–5 s. Používá ji Live
  Activity (K2, server přes APNs) a vzdálenost k limitu v ostrově.
- **Realtime ve workeru**: relay vrací `realtime: { url, anonKey, topic }`
  (`api/tradovate/oauth/copier-relay.ts:68`); worker přes
  `@supabase/supabase-js` s anon klíčem odebírá veřejný kanál
  `copier-kick-<deviceId>` (`scripts/copier/pilot.ts:1783`). Přihlášení
  (`maybeSubscribeKick`) se dnes **čeká v poll smyčce příkazů**
  (`server/macCopierCommandRelay.ts:276, 291`).
- **P&L v LIVE**: REST `live-pnl` po 3 s s pozicí (6/15 s bez), kotva =
  brokerovo `openPnL` jednoho účtu → `lib/tradovateLivePnl.ts` dopočítá
  **mark cenu kontraktu** a z ní odhad ostatních účtů (`estimated`).
  `account.unrealizedPnl` pak vstupuje i do **odvozené způsobilosti**
  (`lib/copyTradeAccountEligibility.ts:58` → `dll-locked` → exkluze v ARM
  payloadu), do zbývajícího DLL, nativního widgetu a souhrnu dne.
- **Měření kroku 1**: trvalé CDP spojení p50 1,3 ms; cena se v noci mění
  ~1,5×/s, ticho až ~3 s; po 250 ms ~1,5 zprávy/s, zpoždění ~120 ms.
- **Worker nemá** handler `unhandledRejection`/`uncaughtException`; Node 24
  proces při neošetřené rejection ukončí → launchd restart = **DISARMED**.

## 2. Návrh

### A. Kanál ceny (worker → Realtime → klienti)

**Izolace (INV-WORKER-04 níže)** — stream běží v **`node:worker_threads`**
spouštěném hlavním vláknem workeru:
- vlastní event loop a `resourceLimits`; výjimka ve vlákně dorazí jako
  `'error'`/`'exit'` na objektu Worker, proces kopírky přežije;
- **supervisor** v hlavním vlákně: restart s backoffem, **jistič** (po 3
  pádech za 10 min vypnout do restartu workeru), nic na vlákno nečeká;
- hlavní vlákno posílá jen `postMessage({ enabled, cadenceHint, topic,
  signingKey })`; vlákno nikdy nesahá na controller, relay ani soubory
  kopírky; globální `process.on('unhandledRejection')` se **nepřidává**
  (změnil by sémantiku pádů celého workeru = jádro);
- vlastní Supabase klient (ne klient kicku), `send` jen ve stavu `joined`
  (realtime-js jinak tiše přejde na REST POST + `console.warn` za každou
  zprávu), **rate cap ≤ 5 zpráv/s**, single-flight CDP s timeoutem 1 s;
- stream **nikdy** nevolá `ensureTradingViewCdp` / `restartTradingViewWithCdp`
  (spouštějí/ukončují TV);
- **samostatný vstupní soubor a samostatný výstup buildu** vlákna
  (instalátor dnes staví jeden esbuild bundle, `scripts/copier/mac-install.ts:390-399`);
  nikdy `new Worker(<bundle workeru>)` s ochranou přes `isMainThread` —
  chybný guard by v procesu nastartoval druhý runtime kopírky (dvojí
  exekuce, file store předpokládá jediný proces). Source guard: graf
  importů vlákna neobsahuje `services/copier*`, `tradovateBroker`, `pilot`
  ani `server/localCopierExecutionAgent`. Změna instalátoru = reinstall
  podle worker-deploy politiky.
- **životní cyklus**: `worker.unref()`; `stop()` = `terminate()` s krátkým
  stropem (jinak zdrží shutdown až na 20s watchdog, `pilot.ts:1109`);
  liveness heartbeat z vlákna, zaseknuté vlákno supervisor ukončí;
  reconnect po uspání Macu řeší vlákno samo a **pády po probuzení se do
  jističe nepočítají**; zprávy z vlákna jen jako omezená diagnostika
  (hlavní vlákno podle nich nic nespouští, obsah neloguje); jistič nikdy
  nerestartuje worker;
- vypínač: `ALPHATRADE_TV_STREAM` (výchozí **off**) a hlavně **serverový**:
  když v odpovědi pollu chybí `priceTopic`/`priceKey`, hlavní vlákno pošle
  `enabled: false` — vypnutí bez restartu workeru (restart = DISARMED).
- Samostatný launchd proces = silnější izolace (i proti nativnímu pádu);
  rozumný druhý krok, pokud worker thread nestačí.

**Čtení**
- Jedno **trvalé CDP spojení** na vybraný panel; zpráva nese `interval`
  a id panelu; zdroj jen **1m panel** se shodným kořenem, nikdy snímkový
  („dedicated“) layout, který mění symbol/timeframe.
- Kadence **řízená klientem** přes presence meta `{ pnl, chart }` (bez
  osobních údajů): 250 ms, když některý viditelný klient zobrazuje open P&L
  nebo živý graf. **Bez presence `pnl`/`chart` se nestreamuje vůbec.**
  Nápověda z hlavního vlákna (hrana `groupFlat` ze stávající 1s smyčky
  `pilot.ts:1898-1902`, ne `status()` 4×/s) smí jen zrychlit; exekuce
  stream nikdy nečte. Po vlastním reconnectu worker nestreamuje, dokud
  nedostal presence `sync`; měsíční strop zpráv jako pojistka.
- Posílá se při změně + heartbeat ≥ 1/s.

**Transport a integrita**
- Relay v `realtime` konfiguraci workeru (odpovědi `poll-v2`, legacy
  `poll` i `background-v2`, autentizace zařízením) a v GET statusu
  uživatele (JWT) vydá:
  - `priceTopic = "tv-price-" + HMAC(secret, "tv-price-topic:" + deviceId)`,
  - `priceKey = HMAC(secret, "tv-price-sign:" + deviceId)`.
  Bez `epoch` (žádná migrace): nové spárování vytvoří nový `deviceId`
  (`server/macCopierDevice.ts:86`) a revokované zařízení GET nevrací;
  rotace = nové spárování nebo výměna serverového tajemství.
- V GET odpovědi jsou `priceTopic`/`priceKey` **vedle `status`, ne v něm**
  — jinak by je uložily `writeCopierAgentStatusSnapshot`/`copierAgentStatusStore`.
  Klient je bere jen z odpovědi, kterou přijal jako status (při dvou OAuth
  spojeních čte `runCopierRelayStatusRound` každé zvlášť); při změně
  tématu (nejčerstvější je jiné zařízení) odhlásí kanál, vyprázdní store
  a resetuje `runId`/`seq`. Symetrický klíč má každý držitel JWT
  uživatele — stejná úroveň jako přístup k účtu (RSA klíč zařízení slouží
  k šifrování lease, na podpis ho nesdílet).
- **Výpočet nikdy nevyhodí výjimku na cestě příkazů/statusu**: při chybě
  (např. chybějící tajemství) se pole vynechá, žádné 502 (jinak by přes
  relay neprošly DISARM/kill — INV-BRAKE-03, INV-RELAY-02). Téma ani klíč
  se **nelogují** (kick dnes téma loguje), nejdou do App Group, logů ani
  `copierAgentStatusStore`.
- Přihlášení k cenovému kanálu se **nečeká v poll smyčce**: hlavní vlákno
  jen předá konfiguraci vláknu (`postMessage`) a pokračuje.
- Každá zpráva je `{ p: "<json>", sig: HMAC(priceKey, p) }` — podepisuje
  a ověřuje se **surový řetězec**, parsuje až po ověření (serializace Node
  a JSC se může lišit). Klient ověřuje přes WebCrypto **sekvenčně** (verify
  je asynchronní; díra v `seq` se hodnotí až po ověření) a nepodepsanou/
  neplatnou zprávu zahodí. **Replay**: `seq` ≤ poslední v rámci `runId` se
  odmítne, nový `runId` jen s novějším `at`. Chybí `crypto.subtle` (např.
  nezabezpečený kontext ve WKWebView) → „stojí“, zobrazí se jen kotva.
- Zpráva (`v: 1`): `seq`, `runId`, `chart`, `interval`, `pane`, `front`,
  `switchAt`, `mode`, `bar` (čas, O/H/L/C), `last`, `bid`, `ask`, `at`, `sig`.
- Klient: stáří > 2 s, mezera v `seq`, změna `runId`, `interval !== '1'`,
  `mode !== 'streaming'` nebo neplatný podpis → „stojí“ → kotva.
- Metadata: kdo zná téma, vidí presence meta (`{ pnl: true }` = zobrazuje
  otevřenou pozici) i kadenci — tedy kdy má Filip otevřenou appku a pozici.
  Nízká závažnost (téma je jen u Filipových zařízení), ale není to „nic“. Únik tématu = jen čtení veřejné ceny;
  flood útočníka stojí kvótu projektu (kick je jen optimalizace, poll ho
  nahradí ~750 ms).

### B. Realtime P&L (jen zobrazení)

- **Kotva + pohyb**: kotva zůstává brokerova (`live-pnl` po 3 s, beze
  změny kadence). `tvVKotvě` = vzorek TV **nejbližší odhadnutému času
  kotvy** (z okna ±1 s; časy serveru, Macu a zařízení se liší); když je
  rozsah cen v okně větší než 2 body, pohyb se pro tuto kotvu vypne (jinak
  by každá kotva skákala až o šířku rozsahu). Mark se posouvá o
  `tvTeď − tvVKotvě`. P&L účtu = `(mark − avgPrice) × qty × valuePerPoint`.
- **Kontroly** (jinak se pohyb vypne a zobrazí jen kotva):
  1. mark kotvy leží v rozsahu cen TV v okně kotvy ± 1 bod (pevné ±2 b by
     v rychlém trhu vypínalo pohyb právě, když je nejcennější);
  2. `front` z TV = kontrakt pozice (`MNQZ2026` ↔ `MNQZ6`);
  3. `mode === 'streaming'`, `interval === '1'`, svíčka z aktuální minuty;
  4. stáří kotvy ≤ 10 s, zprávy TV ≤ 2 s, podpis platný;
  5. kořen shodný; **strop pohybu** mezi kotvami (|Δ| ≤ k × stáří kotvy,
     k z měření ve špičce) — proti zbloudilé/podvržené hodnotě.
- **Kde to žije**: `lib/tvPriceStore.ts` — **jen v paměti** (žádné storage),
  odběr přes `useSyncExternalStore`; selektor vrací **primitivní hodnotu**
  (číslo), aby nevznikla smyčka renderů. Čtou ho **jen** listové komponenty
  `<LiveOpenPnlValue />` (a graf, C3). Branded typ `TvDisplayPrice`, který
  nejde přiřadit do `number` polí read modelu; `no-restricted-imports` mimo
  povolené soubory.
- **Nikdy (INV-UI-04)**: `account.unrealizedPnl` / `balance.openPnL`,
  tabulka marks (`livePnlMarksRef`, `applyTradovateLivePnl*`), eligibility
  a exkluze, DLL a „zbývá do limitu“ (ani zobrazení — „nikdy limity“),
  součty ostrova/skupin s limity, ARM payload a příkazy, worker status
  (`marketPrices` zůstává oddělený starý feed), Live Activity / push /
  nativní widget, `displayCache` a `writeTradovateDisplaySession`, sdílené
  karty (`LiveDayCard` vč. `captureMode`, `TradeShareCard`,
  `SharedLiveDayView`), žurnál, IndexedDB/Storage.
- Štítek „živě (TradingView)“ vs „broker“; součty v první verzi jen z kotvy.
- **Implementace 26. 10. (odchylky, kritik OK S VÝHRADAMI):** (a) „jeden
  obchod skupiny“ (karta obchodu, Otevřený P&L skupiny, souhrn skupiny na
  telefonu) se hýbe také — není to součet s limitem, nohy jsou vše nebo nic;
  ostrov, souhrn dne, DLL a jiné součty zůstávají z kotvy. (b) Místo
  branded typu render-prop listové komponenty + zdrojový test, že se hodnota
  v něm jen formátuje (žádné `set*`/`on*`/ref/limity), a desk vidí jen úzké
  rozhraní grantu (`services/tvPriceGrant.ts`). (c) Výchozí cena pohybu = cena
  TV v okně kotvy nejbližší marku brokera (čas kotvy je jen odhad). (d) Při
  lokálním spojení s workerem bere klient grant z GET relaye čteného jen
  kvůli grantu (status se nepřijímá), nejvýš 1× za minutu a po návratu do
  popředí. (e) Štítek: indigová tečka u hodnoty, na kartě „živě · TV“.
  Detail účtu na telefonu a značka na stupnici karty zůstávají z kotvy.

### C. Svíčky

1. **Dnešek**: graf dne dál skládá Databento + `tv-live` (worker 1×/min).
   Svíčky z kanálu se **neukládají** (jen paměť) — podvržené/předběžné bary
   nesmí do cache dne, hodnocení ani Lab.
2. Náhrada předběžných svíček Databentem po 24 h beze změny.
3. **Živá poslední svíčka**: `controller.updateBar` ze storu mimo React,
   jen pro podepsané zprávy s `interval === '1'`.
4. Hlubší historie (bod 10 předávky) — odloženo.

## 3. Pravidla INV

Dotčená stávající: **INV-UI-01..03** (stará/obnovená cena se netváří jako
živá, nic neautorizuje příkaz), **INV-FRESH-03** (čerstvost workeru se
z kanálu neodvozuje — test), **INV-RISK-01/02, INV-BRAKE-04, INV-ELIG-01/02**
(nic z TV do risku/DLL/zámku/způsobilosti, ani přes `unrealizedPnl`),
**INV-ARM-01**, **INV-BRAKE-03 + INV-RELAY-02** (relay handler ani poll
smyčka nesmí kvůli ceně selhat ani čekat), **INV-DEFAULT-01 + INV-RECON-01**
(pád = restart DISARMED — proto izolace), **INV-TRAD-04** (crash loop =
reconnect storm; žádná nová Tradovate volání), **INV-WORKER-03** (téma
a klíč odvozené ze zařízení), **INV-TRAD-06** (kotva per připojení).

Nová (doplnit do `COPIER_INVARIANTS.md` s implementací):
- **INV-UI-04**: data z TradingView (cena, svíčky, z nich P&L) jsou jen pro
  zobrazení; nesmí do read modelu účtů, marks, display cache/storage,
  eligibility a exkluzí, zobrazení limitů/DLL, ARM a příkazů, worker
  statusu, Live Activity/push/widgetu, sdílených karet ani žurnálu;
  integrita zprávy se ověřuje podpisem.
- **INV-WORKER-04**: neexekuční moduly ve workeru běží v oddělené doméně
  selhání a event loopu; jejich chyba ani zaseknutí nesmí ukončit proces
  ani zdržet relay poll a brzdy; vypnutí bez restartu workeru (serverový
  vypínač přes odpověď pollu; restart = DISARMED).
- **INV-RELAY-04**: Realtime kanál je jen optimalizace/zobrazení; nenese
  příkazy ani rozhodovací stav, přihlášení/publikace se nečekají v poll
  smyčce, veřejný kanál je podvrhnutelný (proto podpis).

## 4. Kvóty (Supabase Realtime, Pro 5 mil. zpráv/měs.)

- Presence jen při viditelné appce (na iOS `subscribeAppForeground` /
  nativní `appStateChange`, na webu `visibilityState`) a připojené komponentě
  (P&L nebo graf); `untrack` při skrytí s debounce (alt-tab); zamknutý
  iPhone `untrack` nepošle a presence vyprší serverovým timeoutem (délka
  NEOVĚŘENO) — krátké streamování navíc je přijatelné. Bez toho by
  desktopový tab v pozadí držel stream celý den (heartbeat 1/s ≈ 5,2 mil./měs.).
- Horní odhad: 4 zprávy/s × 3 (worker + 2 klienti) × 3 h × 30 dní ≈
  **3,9 mil./měs.** + presence (join/leave/sync při probouzení iPhonu) +
  stávající provoz → blízko kvóty; proto heartbeat 1/s jen při `pnl`/`chart`
  a rate cap. Přesná pravidla počítání presence NEOVĚŘENO — změřit v kroku 1
  postupu (Dashboard → Realtime messages).

## 5. Postup (za vypínačem, výchozí off)

1. Relay: `priceTopic`/`priceKey` bez výjimek (testy bez tajemství) —
   **nová env proměnná na Vercelu = produkční krok, souhlas Filipa**;
   nasazení nejdřív web, worker podle worker-deploy politiky.
2. Worker thread + supervisor + jistič, publikace s podpisem, logy bez
   tématu; ověřit CPU TV, stabilitu a spotřebu zpráv.
3. Klientský store + diagnostika (stáří, seq, mode, podpis) bez vlivu na P&L.
4. Listové `<LiveOpenPnlValue />` s kotvou a kontrolami 1–5.
5. Živá svíčka v grafu dne (C3).
6. Měření: ms renderu **velkého stromu** LIVE beze změny proti fázi 1a
   (listové commity přibydou až 4/s — měřit odděleně), iPhone perf značky,
   spotřeba Realtime.

Testy:
- **Worker**: výjimka v CDP/realtime callbacku nedojde do procesu
  (`'error'`, supervisor, jistič); CDP bez odpovědi (single-flight,
  timeout); žádný `send` bez `joined`; rate cap; `stop()` uklidí; nikdy
  `ensureTradingViewCdp`/`restartTradingViewWithCdp`; kadence a presence na
  falešných časovačích vč. visící presence.
- **Vlákno**: `unref`/`terminate` při `stop()`; zaseknuté vlákno ukončeno;
  pády po probuzení mimo jistič; serverový vypínač (pole chybí → `enabled:
  false`); guard grafu importů vstupu vlákna.
- **Relay**: `poll-v2`, legacy `poll`, `background-v2` a GET bez tajemství
  (pole chybí, žádné 502); `priceTopic`/`priceKey` mimo `status`; téma
  deterministické a různé podle zařízení; GET jen pro vlastní nerevokované
  zařízení; visící přihlášení k ceně nezdrží doručení příkazu.
- **Klient**: podpis surového řetězce, sekvenční ověření, replay
  (`seq`/`runId`/`at`), chybějící `crypto.subtle`; změna tématu (unsubscribe,
  reset); presence přes `subscribeAppForeground` a debounce; spike mezi
  kotvami; vnucený `runId`; skew ±3 s; rozsah okna kotvy > 2 b;
  kontrola 1 v rychlém trhu; roll/`front`; `interval ≠ 1`; `mode` delayed;
  store nikdy do storage; **vlastnostní test ekvivalence** — eligibility,
  exkluze, `displayCache`, session zápis, widget, souhrn dne se stejnými
  daty s proudem zpráv i bez něj identické; `agentStatusFresh` nezávisí na
  kanálu; source guard: store importuje jen listová komponenta a graf,
  sdílené karty ne.

## 6. Rozhodnutí Filipa (26. 10. odpoledne)

**Rozhodnuto**: (1) přenos ceny TV přes Realtime **ano, jen na Filipova
zařízení**, jen zobrazení; (2) nové tajemství ve Vercelu **nastaví Claude**
při nasazení kroku 1; (3) **vlákno ve workeru** (`worker_threads`).

Původní otázky:

1. **Licence/přenos**: cena TV by šla přes Supabase Realtime na tvoje
   zařízení (telefon). Dnes už TV data Mac opouštějí (`tv-live` do Storage,
   `marketPrices` → Live Activity přes APNs). Souhlasíš s přenosem přes
   Realtime (jen tvoje zařízení, jen zobrazení)?
2. **Nové tajemství na Vercelu** (HMAC pro téma a podpis) — produkční změna
   v kroku 1 postupu.
3. Worker thread uvnitř workeru (doporučeno) vs samostatný proces.

## 7. Verdikt kritika k v1 (26. 10.) a co se změnilo

**v1: OPRAVIT PŘED IMPLEMENTACÍ.** Nálezy → změny ve v2: (1) izolace
workeru — modul ve stejném event loopu bez handleru pádů + přihlášení
čekané v poll smyčce → worker thread, supervisor, jistič, vlastní klient,
žádný REST fallback; (2) relay výjimka z HMAC → pole se vynechá, nelogovat;
(3) podvržení (kontrola kotvy platí jen v jejím okamžiku) → podpis zpráv
+ strop pohybu; (4) úniky přes `unrealizedPnl`/marks, widget, sdílení,
storage → INV-UI-04, branded typ, jen paměť, test ekvivalence;
(5) presence ≠ dívá se → visible + komponenta, odhad 3,9 mil.; (6) zdroj
grafu → `interval` + panel, bez snímkového layoutu; (7) metadata →
kadence řízená klientem; (8) rozpor v `services/liveCandles.ts` sjednocen;
(9) render → primitivní selektor, měřit velký strom zvlášť, žádné součty
s limity; (10) časové zarovnání → okno ±1 s a tolerance podle rozsahu.

**v2 (druhý průchod): OK S VÝHRADAMI** — implementovat lze; před krokem 1
dopsat B (bez `epoch`) a C (klíč vedle statusu, změna tématu), před krokem
2 A (samostatný vstup vlákna + guard importů); opravit metadata. D–F
(životní cyklus vlákna, podpis na klientovi, presence na iOS) převedeno do
požadavků a testů. Vše výše zapracováno; další kolo kritiky na návrh není
nutné, diff každého kroku jde ke kritikovi před commitem (CLAUDE.md).

