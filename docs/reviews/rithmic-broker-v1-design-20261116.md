# RithmicBroker v1 — návrh adaptéru podle měření (16. 11. 2026)

Nahrazuje `rithmic-broker-v0-design-20261116.md` (neprošel; nálezy na jeho
konci). Vychází z měření `rithmic-feasibility-results-20261116.md`.
Soubor `services/rithmic/rithmicBroker.ts` implementuje `BrokerPort` nad
`RithmicClient`. **Nezapojuje se do workeru** — žádná změna `pilot.ts`,
controlleru, routeru ani relaye. Zapojení je samostatný pozdější návrh.

## Dotčené invarianty

INV-OUTBOX-01/02/03, INV-TRAD-01/02/03/07/08, INV-TRAD-ACK-01,
INV-RECON-01/03/04, INV-FRESH-01, INV-MODE-02, INV-ELIG-01, INV-RISK-01/02/03,
INV-DEFAULT-01/02, INV-BRAKE-05, INV-WORKER-01/02/03.

## Rozsah v1

Implementuje: `placeOrder` (Market, Limit, Stop, StopLimit — jednotlivý
příkaz), `cancelOrder`, `modifyOrder`, `listOrders`, `listPositions`,
`findOrdersByTag`, `findOrderById`, `listAccountCapabilities`,
`listAccountRiskSnapshots`, `subscribe`, `environment`, `routeEpoch`.

Záměrně NEimplementuje:
- `placeOso` / `placeOco` — bracket Rithmicu (ticky od vyplnění, nohy až po
  vyplnění, žádná ID při odeslání) do dnešního tvaru portu nepasuje. Vstup se
  SL/TP je **samostatný návrh rozšíření portu** (nový stav „ochrana přijata,
  nohy nevznikly"); do té doby adaptér bracket neumí zadat.
- `liquidatePosition` — změřeno, že `RequestExitPosition` neruší nohy.
  Bezpečný Flatten (zrušit vše na kontraktu → ověřit → zavřít → ověřit) je
  součást téhož samostatného návrhu.
- `streamOrderSnapshot`, `findOrderStatusById`, `findModifiedOrderById`,
  `frontContract`.

Podmínka zapojení (ne tohoto diffu): `brokerRouter` vždy vystavuje
`liquidatePosition`/OCO/OSO, takže za ním „chybějící metoda" bezpečný
fallback nespustí. Adaptér proto nesmí běžet za routerem, dokud to router
neumí propustit, ani za jeho reconnect lhůtou (viz bod 9).

## Pravidla (M = změřeno na Rithmic Test)

1. **Zápis se nikdy neopakuje.**
   - Neodesláno (spojení není připravené, neznámý účet/symbol/trade route,
     neplatný tvar) → `BrokerRequestNotSentError`.
   - Odpověď s `basket_id` → `{ accepted: true, definitive: true }`. M: tato
     odpověď přijde i u příkazu, který RMS vzápětí odmítne — „přijato" tedy
     znamená „Rithmic příkaz eviduje"; odmítnutí přijde jako událost `order`
     se stavem `rejected` (stejný vzor jako Tradovate).
   - Odpověď s chybovým kódem → **neznámý výsledek** (výjimka), ne
     `definitive` odmítnutí: žádný kód `rp_code` u nového příkazu nebyl změřen,
     seznam bezpečných kódů je prázdný. Text výjimky nikdy neobsahuje
     „rejected/odmít".
   - Timeout, pád spojení, výjimka ze `send()`, odpověď bez `basket_id` →
     neznámý výsledek. M: příkaz v těchto případech na serveru vznikl.
2. **Značka** `tag` → `user_tag`; korelace, ne idempotence (INV-TRAD-03).
3. **Stav příkazu** vede `RithmicOrderBook` (už napsaný, 22 testů):
   tvar mění jen burzovní notifikace; konečný stav se neoživí; verze je funkcí
   stavu; cokoli z bracketu je `Unsupported`; neúplná první notifikace se nevyšle.
   - M: **351 `COMPLETE` s důvodem `FA` (odmítl Rithmic) nebo `R` (odmítla
     burza) = konečný stav `rejected`** s textem; `C` = `canceled`; `F` jen
     potvrzuje `filled` (fill přijde z burzy). `COMPLETE` bez známého důvodu
     a bez burzovního hlášení → adaptér vynutí čtení snímku; nevyřeší-li ho,
     `error` + odpojení (nikdy tichý `pending`).
   - M: stop ve stavu `trigger pending` je pracující (potvrzený burzou).
4. **Fill** jen z burzovní `FILL` s ID exekuce; `fillId` nese účet; pořadí
   vysílání z jedné zprávy: `order`, pak `fill`.
5. **Snímek příkazů** = 320. M: vrací pracující i dnešní dokončené příkazy;
   Rithmic-only odmítnuté jsou v něm jako 351 (klient sbírá 351 i 352).
   Stav řádku z textu stavu a typu posledního hlášení; neznámý nebo neúplný
   řádek = chyba čtení, kniha se nemění.
   - `listOrders` vrací celý snímek (včetně dokončených, s časem brány
     v `updatedAt`) a **vyhodí chybu**, když kniha zná pracující příkaz, který
     ve snímku chybí.
   - M (doměřeno, 3 čtení): i řádky 351 dorazí před ukončením požadavku.
     Pojistka zůstává: snímkový řádek doručený mimo požadavek je důvod
     snímek zopakovat (nikdy se tiše nezahodí).
6. **Dohledání** (`findOrdersByTag`, `findOrderById`): jeden snímek 320 +
   filtr. `completeness: 'eventual'` vždy — autorita podle prokázaného
   časového pokrytí konkrétního pokusu je věc pozdějšího návrhu. Důsledek
   (přijatý): nejistý zápis zůstane po restartu viset do ručního vyřešení.
   Historie 324 se nepoužívá (M: pro dnešek prázdná).
7. **Pozice** = snímek PnL plantu (402 → 450/451). M: řádky dorazí před
   ukončením. Prázdný výsledek je „flat" jen když dorazil snímkový řádek účtu
   (451) téhož požadavku. Neznámé množství (`null`) = chyba čtení.
   `listPositions` vyhodí chybu, když order plant viděl fill účtu a PnL plant
   ještě nedoručil pozdější pozici téhož symbolu (M: zpoždění ~1 ms, pojistka
   pro případ, že to pod zátěží neplatí).
8. **Baseline** (INV-TRAD-01): po přihlášení a odběru změn adaptér načte
   snímky a **vyšle každý příkaz snímku jako událost `order` PŘED
   `connection { connected: true }`**; filly ze snímku nikdy. Přijde-li během
   skládání snímku živá notifikace, snímek se zopakuje (nejvýš 3×, pak chyba
   a nové připojení). Události z té doby jdou také před `connected: true`.
9. **Výpadek a obnova** (INV-RECON-01/03/04):
   - pád kteréhokoli plantu nebo ticho plantu → hned `connected: false`,
     `routeEpoch` +1; čekající zápisy už skončily jako neznámé;
   - obnovuje se jen přihlášení (2 → 30 s); pak nový úplný snímek a
     `connected: true, reconnected: true, resynced: true` se snímkem;
   - `gapFills` nejde doložit (Rithmic je ve snímku nedává) → `resync.complete`
     je `false` s důvodem `gap-fills-unverified`, pokud snímek po obnově
     obsahuje příkaz, jehož stav nebo vyplněné množství se od stavu před
     výpadkem liší, nebo příkaz, který kniha neznala. Jinak `true`.
     Adaptér nesmí běžet za reconnect lhůtou routeru (jádro by prázdné
     `gapFills` četlo jako „nic se nestalo");
   - vynucené odhlášení se neobnovuje: `error` a trvale odpojeno.
10. **Heartbeat**: událost `heartbeat` jen ze zprávy serveru, a jen když oba
    planty (order i pnl) přijaly zprávu v posledním okně; nikdy z časovače.
11. **`cancelOrder`**: M: odpověď „ok" přijde i pro neexistující příkaz →
    nic nedokazuje. Vrací `stream-terminal` jen když do lhůty kniha ukáže
    konečný stav toho příkazu (zrušeno / celé vyplněno); jinak `void`.
    Chybová odpověď = obecná výjimka (ne „neodesláno").
    `CANCELLATION_FAILED` → událost `error`.
12. **`modifyOrder`**: vždy `void` (změnu nejde přiřadit konkrétnímu
    požadavku); chybová odpověď = obecná výjimka; `MODIFICATION_FAILED` →
    `error`. Příkaz typu `Unsupported` (bracket) adaptér odmítne měnit.
13. **Způsobilost**: při každém volání čerstvě 302 (účty) a 304 (RMS).
    `active` jen pro účet z aktuálního seznamu; `canTrade` jen když RMS
    `status` je `active` a existuje trade route. Selhání čtení = výjimka.
14. **Risk snapshot**: z posledního snímku P&L účtu (čerstvě vyžádaného, když
    je starší než lhůta); `at` = čas přijetí toho snímku; `realizedTradeDate:
    null`; `netLiq`, `minNetLiq`, `dailyLossAutoLiq`, `trailingMaxDrawdown` =
    `null` (Rithmic je neposílá; ⚠ poplatky v P&L nezměřeny).
15. **Účet** z trvalé tabulky identit (`RithmicAccountRegistry`); účet
    v tabulce, který aktuální přihlášení nevrátilo: zápis „neodesláno", čtení
    výjimka. **Symbol → burza** pevnou tabulkou; neznámý = neodesláno.
16. **Prostředí**: `demo` jen `Rithmic Test` a `Rithmic Paper Trading`
    (na Paper běží i prop účty s reálnými následky — stejná slabina jako
    Tradovate prop na demo hostech); jinak `live`.
17. **Jediná instance**: M: Rithmic druhé přihlášení povolí. Adaptér to
    neřeší; vynutí vstupní bod (zámek + lease) — podmínka zapojení.
18. **Snímky po jednom** (klient je serializuje); adaptér navíc nepouští
    souběžně snímek příkazů a skládání baseline.

## Testy (proti napodobenému serveru upravenému podle měření)

Výsledky zápisu (přijato / neodesláno / neznámé; chybový kód = neznámé);
přijato a vzápětí 351 COMPLETE/FA → událost `rejected`; baseline před
`connected:true` a žádný leader event z ní (test s `CopierLeaderEventSource`);
živá notifikace během snímku → opakování; výpadek → `connected:false`,
`routeEpoch`, obnova se `resynced` a `complete` podle rozdílu; ticho plantu;
vynucené odhlášení; `listOrders` s chybějícím pracujícím příkazem → chyba;
`listPositions`: prázdné jen s 451, `null` množství → chyba, fill bez
pozdější pozice → chyba; zrušení neexistujícího → `void`; bracket příkaz →
`Unsupported`, nejde měnit; způsobilost při neaktivním RMS; heartbeat jen
z obou plantů; dvě souběžná čtení.

## Výsledek oponentury v1 (copier-design-critic: OPRAVIT) — závazné změny

Většinu nálezů v0 měření zavřelo. Před napsáním adaptéru platí tyto opravy:

1. **Žádná událost `error` pro obchodní selhání.** Jádro každou `error`
   bere jako ztrátu transportu (vypnutí „transport" + automatické pokračování).
   `CANCELLATION_FAILED`, `MODIFICATION_FAILED`, nevyřešené `COMPLETE`
   ani vynucené odhlášení se proto jako `error` NEvysílají. Zrušení a změna
   vrací `void` / výjimku volajícímu; adaptér má vlastní zpětné volání
   `onIncident` (mimo `BrokerEvent`) a při stavu, který nejde určit, nebo při
   vynuceném odhlášení zůstane odpojený bez automatické obnovy. Netransportní
   incident v portu je otevřené rozšíření.
2. **`resync.complete` je jen diagnostika** — v této topologii ho jádro
   nečte. O obchodu v mezeře rozhoduje `listOrders`. **Automatické pokračování
   (INV-RECON-04) musí být pro Rithmic vypnuté**, dokud se pokrytí snímku 320
   nezměří na cílovém systému a přes přelom obchodního dne (podmínka zapojení).
   `complete=false` navíc, když po obnově chybí dříve známý dnešní dokončený příkaz.
3. **Pozdní řádek snímku** (doměřeno: nenastává) se nikdy tiše nezahodí ani
   nevyvolá smyčku: sloučí se do knihy jako oprava baseline, ohlásí přes
   `onIncident` a další `listOrders` čte znovu.
4. **Dohledání:** příkaz nalezený v úplném snímku je kladný důkaz jeho stavu
   → `authoritative`; „nenalezeno" zůstává `eventual`. (Bez toho by jádro
   neodeslalo žádný modify a nedořešilo žádné zrušení.)
5. **`COMPLETE` v knize:** důvod `FA`/`R` → `rejected`, `C` → `canceled`,
   `F` → `filled` jen když zpráva nese plné vyplněné množství; jinak se čeká
   na burzovní `FILL` a když do lhůty nepřijde, adaptér se odpojí a jde plná
   obnova (nikdy tiché `filled`, nikdy fill ze snímku). Neznámý důvod → čtení
   snímku → konečný stav, nebo odpojení. Verze konečného stavu neobsahuje
   vyplněné množství, aby pozdní dílčí fill nevydal druhé `canceled`.
6. **`listPositions`:** čerstvý snímek vyžádaný po fillu se počítá jako
   pozdější pozice; mlčení PnL plantu = odpojení (hlídač ticha), ne věčná chyba.
7. **Čtení má strop** (časový limit požadavku); jeden visící snímek nesmí
   zdržet ostatní účty déle.
8. **Čerstvý seznam účtů** (302) nesmí za běhu přepsat identitu účtů; liší-li
   se od přihlášení, adaptér se odpojí.
9. Podmínky zapojení navíc: typy DB sloupců pro `accountId` (~9e12);
   testy s jádrem (odmítnutí RMS před odpovědí na příkaz, kopie followera
   v letu, restart uprostřed `sending`, obchod v mezeře × preflight).
