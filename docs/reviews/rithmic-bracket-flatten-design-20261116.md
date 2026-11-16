# Rithmic — vstup se SL/TP a bezpečné zavření pozice (návrh v2, 16. 11. 2026)

Navazuje na `rithmic-broker-v1-design-20261116.md`. Adaptér v1 umí jen
jednotlivé příkazy; bracket mapuje jako `Unsupported` a `placeOso`,
`placeOco`, `liquidatePosition` nemá. Tento návrh přidává vstup s ochranou
a Flatten. **Adaptér zůstává nezapojený** do workeru a jádra; zapojení je
samostatný krok s vlastním návrhem.

## Dotčené invarianty

- **INV-OUTBOX-01** — zápis se po timeoutu neopakuje naslepo.
- **INV-OUTBOX-03** — vstup + ochrana je celek; chybějící noha se nedostavuje.
- **INV-MODE-02** — výsledek zavření se potvrzuje stavem, ne odpovědí.
- **INV-DEFAULT-02** — neznámý stav zastaví nové riziko; žádný tichý auto-close.
- **INV-BRAKE-01/03** — brzdy; Flatten je přesně cílený (účet + kontrakt).
- **INV-RECON-03** — chybění v seznamu není důkaz konce.
- **INV-TRAD-07** — neznámý tvar se nekopíruje a čtení nezastaví.
- **INV-TRAD-03** — značka je korelace, ne záruka idempotence.

## Doměřeno (Rithmic Test, ESZ6, scénář H ve `scripts/rithmic/feasibility.ts`)

| Otázka | Výsledek |
|---|---|
| Zrušení jedné nohy | **Zruší obě** (TP i SL, oběma směry), ~135 ms. Pozice zůstane bez ochrany. |
| Zrušení už zrušené sestry | Odpověď „ok", pak 351 `CANCELLATION_FAILED`. |
| Dvě zrušení souběžně | Obě „ok", obě nohy pryč za 146 ms. |
| `RequestExitPosition` na flat účtu | `rp_code 0`, **žádný příkaz nevznikne**. |
| `RequestExitPosition` s pozicí | Samostatný `MARKET` bez `user_tag` a bez vazby; vyplnění ~142 ms. Požadavek pole pro značku nemá. |
| Značka u noh | Nohy `user_tag` **nenesou**. |
| Vazby u noh | První 351 (`ORDER_RCVD_FROM_CLNT`) nese jen `bracket_type`; od druhé zprávy `original_basket_id` = rodič a `linked_basket_ids` = obě nohy. Snímek 320 vazby nese. |
| Množství noh | Stejné jako vstup (ověřeno 1 a 2 ks, plné vyplnění). |
| Stop noha | `STOP_MARKET`, `trigger_price` = SL; burza u ní hlásí i `price` (ochranný limit, 20 ticků za spouští). |
| TP 1 tick od vyplnění | Do 25 s se nevyplnil → **nezměřeno, zda vyplnění jedné nohy ruší druhou**. |

Dál nezměřeno: částečné vyplnění vstupu (množství noh), zrušení rodiče po
částečném vyplnění, vyplnění nohy × souběžné zrušení, zda změna nohy (314)
zachová vazbu.

## Oponentura v1 → co se změnilo

Critic i Codex: **OPRAVIT před implementací**. Zapracováno:

- Celý bracket (vstup i nohy) jde jádru dál jako `Unsupported`; stav ochrany
  je jen v `bracketState` a v incidentech. Tvar „jako OSO" by jádru podsunul
  předpoklady, které u Rithmicu neplatí (shoda obou). Odpadá tím odklad první
  zprávy nohy.
- Zrušení nohy se neodešle jen při nenulové (nebo neznámé) pozici; **při
  prokazatelně nulové pozici projde**, jinak by nešla uklidit osiřelá noha.
- Čtení ani ověření zrušení zavření **nevetují** — viz spor níže.
- `submitted` jen po skutečně přijatém zavření; pozice 0 = `already-flat`
  (nic nepracuje) nebo `indeterminate` + incident.
- Trvalý záznam (`ProtectionStore`): záměr vstupu s ochranou a fáze zavírání
  se ukládají **před** odesláním; po restartu se ochrana vyhodnotí z výchozího
  stavu a rozdělané zavírání se ohlásí, nikdy neopakuje.
- Kontrola ochrany po každé změně vstupu, nohy nebo pozice; každá role zvlášť.
- Stop příkaz nenese `limitPrice` z ochranného limitu burzy.

**Spor recenzentů (otázka A):** Codex — bez potvrzeného zrušení nezavírat.
Critic — zavřít, brzda nesmí čekat (jádro to tak dělá dnes: „starý unknown
cancel nikdy nestojí před risk-redukčním close"). **Zvoleno: zavřít.**
Codexovu námitku (po zavření zůstane pracovat příkaz) kryje: druhé kolo
rušení pro nohy vzniklé pod rukama, incident `flatten-cancel-unconfirmed`,
kontrolní čtení po zavření s incidentem `flatten-orders-remain` a možnost
uklidit osiřelou nohu zrušením při pozici 0.

## Co je postaveno

### Port
`placeBracket?(BrokerBracketRequest): Promise<BrokerBracketAck>` v
`services/brokerPort.ts` (volitelné; jiný adaptér = fail-closed). `placeOso`
a `placeOco` Rithmic nemá. Výsledek jako `placeOrder`: „přijato" není důkaz,
ztracená odpověď = neznámý výsledek a dohledání čtením podle značky, nikdy
opakování. Stejná značka podruhé se neodešle.

### Záznam (`services/rithmic/rithmicProtection.ts`)
Záměr `{značka, účet, kontrakt, strana, množství, stopTicks, targetTicks,
entryId}` uložený před odesláním; když uložit nejde, vstup se neodešle.
Vstup se páruje podle značky (odpověď, notifikace, snímek); nohy podle
`original_basket_id` (živě od druhé zprávy, ve snímku vždy). Záznamy starší
36 h se zahazují.

### Stav ochrany — `bracketState(účet, vstup)`
`entry-working | protected | unprotected | orphan-legs | done | unknown`.
`protected` = pozice trvá a každá požadovaná role má právě jednu nohu
potvrzenou burzou, se zbývajícím množstvím rovným vyplněnému vstupu (nebo
pozici, po dílčím vyplnění nohy). Do `legsWaitMs` (3 s) po každé změně se
stav vyhodnotí; `unprotected` → incident `bracket-legs-missing`,
`orphan-legs` → `bracket-orphan-legs`. Hlásí se jednou, dokud se stav
nezmění. **Adaptér nic nedostavuje ani nezavírá.**

### Zrušení a změna nohy
Zrušení nohy (vlastního i cizího bracketu) při pozici ≠ 0 nebo neznámé →
`BrokerRequestNotSentError`. Změnu nohy adaptér neumí (`Unsupported`) —
**posun SL/TP přes adaptér zatím nejde**; patří do návrhu zapojení po
doměření, zda změna zachová vazbu.

### `liquidatePosition`
1. Druhé volání na týž účet + kontrakt během běhu se připojí k běžící
   operaci. Značka, která už někdy proběhla (i v minulém běhu), nic neposílá:
   jen dočte stav → `already-flat`, jinak `indeterminate`.
2. Fáze `started` na disk. Po dobu běhu se na kontraktu odmítá `placeOrder`,
   `placeBracket` a `modifyOrder` (`cancelOrder` nikdy).
3. Čtení příkazů a pozice, každé se stropem `flattenStepMs` (1 s). Obojí
   v pořádku, pozice 0 a nic nepracuje → `already-flat`. Selhání čtení
   nic nezastaví — ruší se to, co kniha vede jako pracující.
4. Zrušení všech pracujících příkazů kontraktu souběžně, čekání
   `flattenCancelWaitMs` (1 s). Vyplnil-li se vlastní vstup a nohy ještě
   nejsou vidět, počká se na ně nejvýš 500 ms a nové příkazy se zruší ve
   druhém (posledním) kole. Tentýž příkaz se neruší dvakrát.
5. Čerstvá pozice. Prokazatelně 0 → nezavírá se: nic nepracuje →
   `already-flat`; jinak incident `flatten-orders-remain` a `indeterminate`.
6. Jinak fáze `exit-sent` na disk a `RequestExitPosition` (množství určuje
   server). Odmítnutí → `rejected` (bez textu serveru); bez odpovědi →
   `indeterminate`; jinak `submitted`. Nepotvrzená zrušení → incident
   `flatten-cancel-unconfirmed`.
7. Za `flattenPostCheckMs` (1,5 s) jedno kontrolní čtení; cokoli pracujícího
   → `flatten-orders-remain`.
8. Flat adaptér netvrdí; potvrzuje volající stavem (INV-MODE-02).

Nejhorší případ doby: 2× čtení + rušení + čekání na nohy + 2. kolo + čtení
pozice + zavření ≈ 7,5 s při výchozích stropech (pod 8 s lhůtou
`executeClose`); běžně ~300–500 ms. Po zrušení noh je pozice do zavření
**bez ochrany** — při pádu procesu v tom okně na neurčito; po restartu to
ohlásí `bracket-legs-missing` a `flatten-interrupted`.

## Podmínky zapojení (neřešeno tady)

- Jádro musí vědět, že vstup má serverovou ochranu, která teprve vznikne
  (follower by jinak dostal holý vstup a jádro by po vyplnění chtělo
  `placeOco`, které Rithmic nemá). Test s jádrem: vyplnění `Unsupported`
  příkazu (noha, zavírací Market bez značky) se nezkopíruje.
- Zavírací Market nenese značku: jádro ho nesmí brát jako nový signál
  leadera; přiřazení k operaci se nedělá odhadem.
- `mayResendLiquidation` v jádru po `indeterminate` volá znovu — s **novou**
  značkou by adaptér zavírání spustil znovu. Před zapojením změřit dvojí
  `RequestExitPosition` těsně po sobě a rozhodnout, zda adaptér má blokovat
  i jinou značku, dokud předchozí výsledek není potvrzen stavem.
- Kritické incidenty adaptéru musí v jádru trvale blokovat nové riziko.
- `ProtectionStore` jako soubor workeru (atomický zápis); jedna instance.
- Posun SL/TP; `assertDispatchAllowed` pro bracket; příznak schopnosti
  „zrušení nohy ruší sestru".
- Doměřit: částečné vyplnění vstupu (množství a počet noh), vyplnění nohy ×
  sestra, změna nohy × vazba, značka rodiče v první zprávě, limity čtení 320.

## Testy

`tests/rithmicProtection.test.ts` (24): ochrana po vyplnění, 2 ks, nohy
nevzniknou, jen TP, noha zrušena jinde, zrušení nohy s pozicí / osiřelé
nohy, duplicitní značka, záměr uložen před odesláním, odmítnutí RMS,
ztracená odpověď, restart, cena stopu; zavírání: šťastná cesta, flat, jen
vstup, nepotvrzené zrušení, selhání čtení, ztracená odpověď + stejná značka,
odmítnutí, souběh a blokace, vstup vyplněný během rušení, noha vyplněná
během rušení, pád spojení, restart uprostřed. 14 pojistek ověřeno záměrným
rozbitím kódu (kontrola ochrany po připojení je zdvojená čtením snímku).

## Zkouška proti skutečnému serveru (Rithmic Test, 16. 11. 2026)

`scripts/rithmic/adapterSmoke.ts` — celý adaptér, ne napodobený server, 2 běhy:
vstup Market se SL 40 / TP 80 ticků přijat za ~123 ms, stav `protected` za
191–200 ms od odeslání; zrušení nohy při otevřené pozici se neodeslalo;
`liquidatePosition` vrátilo `submitted` za 717–741 ms (čtení, zrušení noh,
čtení pozice, zavření), po něm pozice 0 a nic nepracuje, stav `done`; stejná
značka podruhé i flat účet → `already-flat`; čekající Limit vstup se jen
zrušil (`already-flat`, žádné zavření). Žádný incident. Celý bracket šel
ven jako `Unsupported`, zavírací příkaz jako `Market` bez značky.
