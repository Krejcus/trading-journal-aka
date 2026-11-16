# RithmicBroker v0 — návrh adaptéru (16. 11. 2026)

> **Stav 16. 11. večer: návrh NEPROŠEL — adaptér se zatím nestaví.**
> `copier-design-critic` i Codex (gpt-6-astra) vrátili „OPRAVIT PŘED COMMITEM",
> pro zapojení do workeru „BLOKUJE". Rozpracovaný `rithmicBroker.ts` byl
> smazán a necommitnut. Text níže je původní návrh; platí opravy v oddílu
> „Výsledek oponentury" na konci.

Nový soubor `services/rithmic/rithmicBroker.ts` implementující `BrokerPort`
nad `RithmicClient`. **Nezapojuje se do workeru** (žádná změna `pilot.ts`,
controlleru, routeru ani relaye) — jen adaptér + testy proti napodobenému
serveru. Zapojení je samostatný pozdější návrh.

Skutečné chování Rithmicu u bodů označených ⚠ zatím nebylo změřeno
(`scripts/rithmic/feasibility.ts` čeká na přihlášení). Kde chybí důkaz, volí
adaptér přísnější variantu.

## Dotčené invarianty

INV-OUTBOX-01/02/03, INV-TRAD-01/02/03/07/08, INV-TRAD-ACK-01, INV-RECON-01/03,
INV-FRESH-01, INV-MODE-02, INV-ELIG-01, INV-RISK-01, INV-DEFAULT-01/02,
INV-WORKER-01/02/03 (jen poznámka — řeší až vstupní bod).

## Rozsah v0

Implementováno: `placeOrder`, `cancelOrder`, `modifyOrder`, `listOrders`,
`listPositions`, `findOrdersByTag`, `findOrderById`, `listAccountCapabilities`,
`listAccountRiskSnapshots`, `subscribe`, `environment`, `routeEpoch`.

Záměrně NEimplementováno (port to dovoluje a jádro pak selže bezpečně):
`placeOso`, `placeOco` (bracket Rithmicu má jinou sémantiku — až po měření),
`liquidatePosition` (chování `RequestExitPosition` vůči nohám neověřeno; jádro
použije cancel + přesný Market), `streamOrderSnapshot`, `findOrderStatusById`,
`findModifiedOrderById`, `frontContract`.

## Pravidla

1. **Žádné opakování zápisu.** `RithmicClient` neopakuje nikdy; adaptér také ne.
   - Rithmic odmítl (`rejected`) → `{ accepted: false, definitive: true, rejectReason }`.
   - Neodešlo (`not-sent`, i lokální validace, neznámá burza symbolu, chybějící
     trade route) → `BrokerRequestNotSentError`.
   - Odešlo bez konečné odpovědi (`unknown`: timeout, pád spojení, potvrzení bez
     `basket_id`) → obecná výjimka; jádro podle INV-OUTBOX-01 dohledává.
   - Potvrzení (`ResponseNewOrder` s `basket_id`) = `accepted: true, definitive: true`.
     Je to přijetí Rithmicem, ne burzou; pozdější odmítnutí burzou přijde jako
     událost `order` se stavem `rejected` (stejně jako u Tradovate).
2. **Značka.** `tag` jde do `user_tag`; je to korelace, ne idempotence (INV-TRAD-03).
3. **Dohledání.** `findOrdersByTag` / `findOrderById` čtou pracující příkazy (320)
   **a** historii aktuálního obchodního dne (324) a filtrují. ⚠ Dokud měření
   nepotvrdí, že tyto dva zdroje pokrývají i příkaz vyplněný nebo zrušený
   v mezeře, vrací `completeness: 'eventual'` (prázdný výsledek pak nikdy
   nedovolí nový pokus). Přepnutí na `'authoritative'` je konfigurace adaptéru
   s výchozí hodnotou vypnuto. Selže-li kterékoli z obou čtení, lookup vyhodí chybu.
4. **Účet.** `accountId: number` z trvalé tabulky identit: klíč
   `systém|fcm|ib|účet` → číslo přidělené sekvenčně od 9 000 000 000 001.
   Žádný `parseInt`, žádný hash, žádné přečíslování; přidělení se uloží před
   prvním použitím a při chybě uložení adaptér nenastartuje. Neznámé číslo účtu
   v požadavku → `BrokerRequestNotSentError`.
5. **Symbol.** Port nese jen symbol; burzu určuje pevná tabulka rootů
   (ES/MES/NQ/MNQ/RTY/M2K → CME, YM/MYM → CBOT, CL/MCL → NYMEX, GC/MGC → COMEX).
   Neznámý root = neodesláno.
6. **Typy příkazů.** Zápis jen Market/Limit/Stop/StopLimit. Pozorovaný jiný typ
   (MIT, LIT, trailing) → `orderType: 'Unsupported'` + `brokerOrderType`;
   čtení nikdy nespadne (INV-TRAD-07).
7. **Stavy.** Rithmic `OPEN_PENDING`/`*_RCVD_*`/`*_SENT_TO_EXCH`/`TRIGGER_PENDING`
   → `pending`; burza `STATUS`/`MODIFY`/`TRIGGER` → `working`; `FILL` s nulovým
   zbytkem → `filled`, se zbytkem → `working` + `filledQuantity`; `CANCEL` →
   `canceled` (s `filledQuantity`, je-li); `REJECT` → `rejected` + důvod.
   `NOT_MODIFIED`/`NOT_CANCELLED` nemění stav příkazu, jdou jako událost `error`.
   Neznámý `notify_type` stav nemění. `filledQuantity` nikdy neklesá.
8. **Fill.** `BrokerFill` jen z burzovní `FILL` s `fill_id`, cenou a množstvím
   této dílčí exekuce; duplicitní `fill_id` se zahodí. Snímky (`is_snapshot`)
   se jako fill ani jako živá událost NIKDY nevysílají (INV-TRAD-01).
9. **Spojení a resync** (INV-RECON-01/03, INV-TRAD-01):
   - start: připojit order + pnl, přihlásit odběr změn, **potom** vyžádat snímky
     (pořadí zaručuje, že mezi snímkem a streamem není mezera; živé události
     přijaté během snímku se uplatní po něm, pokud jsou novější);
   - po dokončení `connection { connected: true, resync: { accountIds, positions,
     orders, gapFills: [], complete } }`; selže-li cokoli, `complete: false`
     s důvodem a `connected: true` se nevyšle jako zdravý stav — adaptér zůstane
     odpojený a zkusí to znovu;
   - pád kteréhokoli plantu → okamžitě `connection { connected: false }`, zvýší
     se `routeEpoch`, všechny čekající zápisy už skončily jako `unknown`;
   - obnovuje se jen **transport** (nové přihlášení s odstupem 2 → 30 s), nikdy
     příkaz; po obnovení nový úplný snímek a `reconnected: true`. `gapFills`
     zůstává prázdné (⚠ filly z mezery Rithmic ve snímku nedává — jádro mezeru
     pozná z pozic, ne z přehraných fillů);
   - vynucené odhlášení (`ForcedLogout`, typicky druhé přihlášení) se NEobnovuje
     automaticky: `error` + trvale odpojeno, dokud to nevyřeší obsluha.
10. **Pozice.** `listPositions` = čerstvý snímek z PnL plantu pro účet. ⚠ Pokud
    snímek nedorazí celý (chybí ukončení), čtení vyhodí chybu — prázdný
    výsledek se za „flat" považuje jen s potvrzeným ukončením snímku.
11. **Potvrzení modify/cancel.** `cancelOrder` vrátí `stream-terminal` jen když
    do krátké lhůty dorazí burzovní `CANCEL`/`FILL` přesně toho příkazu; jinak
    `void` (jádro ověří čtením). `modifyOrder` vrátí `stream-replaced` jen při
    burzovním `MODIFY` toho příkazu s odeslaným tvarem; jinak `void`.
12. **Způsobilost a risk.** Účet je `active` jen když ho vrátil seznam účtů
    aktuálního přihlášení; `canTrade` jen s trade route pro burzu a bez stavu
    účtu, který obchodování vylučuje. Risk snapshot: `realizedPnlUsd`,
    `openPnlUsd`, `cashBalanceUsd` z posledního snímku P&L; `netLiq`,
    `minNetLiq`, `dailyLossAutoLiq`, `trailingMaxDrawdown` = `null` (Rithmic je
    v tomto tvaru neposílá; nikdy 0). Starší snímek než lhůta = hodnoty `null`.
13. **Prostředí.** `demo` jen pro systémy z výslovného seznamu
    (`Rithmic Test`, `Rithmic Paper Trading`); cokoli jiného `live`.
14. **Jediný zapisovatel** adaptér neřeší — jeden přihlášený proces na účet
    vynutí až vstupní bod (zámek procesu + limit sessions u Rithmicu).

## Testy

Proti `tests/_fakeRithmicServer.ts`: výsledky zápisu (přijato / odmítnuto /
neodesláno / neznámé bez opakování), mapování stavů a typů vč. `Unsupported`,
dílčí fill a deduplikace, snímek není živá událost, lookup `eventual` vs.
`authoritative`, pád spojení → `connected:false` + `routeEpoch` + obnovený
snímek, vynucené odhlášení bez obnovy, tabulka identit (stabilita, selhání
uložení), neznámý účet a symbol.

## Výsledek oponentury (16. 11. 2026)

### Opraveno hned (klient, mapování, tabulka účtů — s testy)

- Výjimka ze `send()` je `unknown`, ne `not-sent` (rámec mohl zčásti odejít).
- Konečná odpověď se přiřadí jen podle shodného `user_msg`; pozdní potvrzení
  starého požadavku nepotvrdí jiný zápis.
- Hlídač ticha: plant bez zprávy déle než 2,5 intervalu heartbeatu se zavře;
  klient hlásí `onAlive` (podklad pro `heartbeat` událost portu — jen ze zprávy
  serveru, nikdy z časovače).
- Každý požadavek nese úplnou identitu účtu (účet + FCM + IB); dva účty se
  stejným číslem přihlášení odmítne; událost s cizí identitou se zahodí a ohlásí.
- Snímky příkazů (320, 324) běží po jednom — nekradou si řádky.
- Neznámá pozice je `null`, ne nula.
- Stav řádku snímku se bere z textu stavu, ne z typu notifikace; neznámý text
  snímek odmítne (kniha se nezmění).
- Cokoli z bracketu je `Unsupported` (cizí aktivní příkaz, nekopíruje se);
  `parentOrderId` / `linkedOrderId` se ve v0 nevyplňují.
- Neúplná první notifikace (bez strany, množství, symbolu) se nevyšle.
- Po konečném stavu se příkaz znovu nevysílá a jeho `sourceVersion` se nemění;
  starší zpráva stav nevrátí.
- `fillId` nese číslo účtu (jádro deduplikuje filly jen podle `fillId`).
- Tabulka účtů ukládá s očekávanou revizí (dva procesy nepřidělí stejné číslo).

Druhé kolo (diff před commitem, critic i Codex znovu „OPRAVIT PŘED COMMITEM") přineslo:

- Ochrana proti starší zprávě podle času byla **odstraněna** — zahazovala
  oprávněný fill i zrušení (351 a 352 razítkují různé procesy). Pořadí teď
  chrání jen: tvar příkazu mění pouze potvrzující notifikace (burzovní
  STATUS/MODIFY/TRIGGER, Rithmic OPEN/MODIFIED), konečný stav se neoživí,
  fill se deduplikuje podle ID.
- `sourceVersion` je funkcí stavu, ne zprávy (stejná ze snímku i ze streamu,
  u konečného stavu se nemění).
- Snímek odmítne neúplný řádek a konečný příkaz už nepřepíše.
- `FILL` bez ID exekuce stav neposune (musí se dohledat).
- Odpověď se přiřazuje jen podle `user_msg`, i datové řádky (žádný fallback).
- `accounts` se uloží až po kontrole; pnl plant jde připojit jen po order plantu.
- Výjimka odběratele neshodí zbytek zpráv z rámce; kadence heartbeatu je nastavitelná.
- Měřicí skript: odmítnutí se zkouší 500 kontrakty na polovině ceny trhu
  (nemůže se vyplnit), úklid běží vždy a neznámou pozici nezavírá naslepo.

Omezení, která zůstávají a adaptér s nimi musí počítat: živost jde poznat se
zrnitostí ~30 s a mrtvé spojení až po 150–180 s (při 60s intervalu); hlídač
měří `Date.now()`, ne monotónní čas; bracket se pozná až od první zprávy, která
`bracket_type` nese (doplnit do měření, zda ho nese první notifikace); pořadí
`ssboe` mezi 351 a 352 není změřeno.

Třetí kolo (critic): **OK s výhradami, commit neblokuje.** Výhrady:

- Tvar existujícího příkazu teď mění jen burza (352); 351 OPEN/MODIFIED ne
  (opožděná by vrátila starou cenu). Pořadí 351 × 352 doměřit.
- Pozdní řádek snímku téhož účtu může skončit v dalším čtení; opačné pořadí
  (ukončení dřív než řádky) dá prázdný snímek. Dokud to scénář G nezměří
  (`lateSnapshotRows`), prázdný snímek není důkaz „žádné příkazy".
- První burzovní FILL neznámého příkazu bez strany/množství/symbolu se
  nevydá (jen `attention`) — adaptér musí dorovnat pozici z pnl plantu.
- Odpovědi se párují jen podle `user_msg`; jestli ho server vrací u všech
  šablon (313, 321, 403), ukáže měření. Bez něj požadavek vyprší jako `unknown`.
- Výjimka při zpracování zprávy jde do `onAttention`; adaptér po ní musí číst.

### Musí být v návrhu adaptéru, až se bude psát znovu

1. Baseline: příkazy ze snímku vyslat jako `order` **před** `connected:true`
   (jádro si z nich ukládá signatury); filly ze snímku nikdy. Živá notifikace
   během skládání snímku = snímek zopakovat.
2. Po obnovení spojení `resynced: true`; prázdné `gapFills` znamenají
   „neznámé", ne „žádné" → adaptér nesmí běžet za reconnect lhůtou routeru
   a obchod leadera celý v mezeře musí být dohledatelný (`listOrders` =
   320 ∪ 324; dokud není pokrytí změřeno, vracet důkaz, který automatické
   pokračování odmítne).
3. `listOrders` / `listPositions` jsou pro jádro důkaz: chybějící aktivní
   příkaz ve snímku, fill novější než poslední pozice nebo snímek bez
   ukončení = výjimka, ne prázdný výsledek.
4. `COMPLETE` od Rithmicu bez burzovního důvodu (odmítnutí RMS) musí vynutit
   dohledání a skončit konečným stavem nebo `connected:false`, nikdy tichým `pending`.
5. `definitive: true` u odmítnutí jen pro výslovný seznam kódů `rp_code`
   (seznam vznikne z měření); ostatní jako neznámý výsledek.
6. `cancelOrder`/`modifyOrder`: odmítnutí = obecná výjimka (ne „neodesláno");
   `stream-terminal` jen z konečného stavu; `stream-replaced` nevracet, dokud
   nejde změnu přiřadit konkrétnímu požadavku.
7. Způsobilost: čerstvé 302 + 304 při každém volání; `realizedTradeDate: null`.
8. `lookupAuthoritative` jako globální přepínač zrušit — autorita podle
   prokázaného časového pokrytí konkrétního pokusu.
9. Zapojení: `brokerRouter` vždy vystavuje `liquidatePosition`/OCO/OSO, takže
   „chybějící metoda = bezpečný fallback" za routerem neplatí. Řešit v návrhu
   zapojení (buď bez routeru, nebo router propustí chybějící schopnost).
10. `accountId` ~9e12: před zapojením ověřit typy DB sloupců a relay.
11. „Rithmic Paper Trading" = `demo`, ale běží na něm prop účty s reálnými
    následky (stejná slabina jako Tradovate prop na demo hostech).

### Co musí nejdřív změřit `scripts/rithmic/feasibility.ts` (scénáře C–G)

Pořadí řádků snímku proti ukončení (320/321, 402/403); rozsah 320 (držené
a čekající příkazy, dokončené); pokrytí 324; texty `status` /
`completion_reason`; významy `rp_code`; cesta odmítnutí RMS; zpoždění pozic
za fillem; jestli je `basket_id` číselné a monotónní a jestli se při změně
mění; množství po dílčím fillu; význam `original_basket_id` /
`linked_basket_ids`; chování bracketu; druhé přihlášení; poplatky v P&L.
