# RithmicBroker v0 — návrh adaptéru (16. 11. 2026)

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
