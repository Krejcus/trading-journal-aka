# Rithmic — vstup se SL/TP a bezpečné zavření pozice (návrh, 16. 11. 2026)

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

## Návrh

### 1. Port: nová volitelná metoda `placeBracket`, `placeOso` zůstává nepodporované

`placeOso` slibuje absolutní ceny noh a jejich ID v odpovědi. Rithmic umí jen
vzdálenost v tickách od ceny vyplnění a nohy vzniknou až po vyplnění.
Napodobit to (dopočítat ticky a po vyplnění nohy posunout) by znamenalo
dostavovat tvar — to zakazuje INV-OUTBOX-03. Proto:

```ts
interface BrokerBracketRequest extends BrokerOrderRequest {   // Market | Limit | Stop
  stopTicks?: number;    // kladné celé; aspoň jedno z dvojice
  targetTicks?: number;
}
interface BrokerBracketAck { entryBrokerOrderId: string; accepted: boolean; definitive: boolean; rejectReason?: string }
placeBracket?(request: BrokerBracketRequest): Promise<BrokerBracketAck>;
```

Výsledek se určuje stejně jako u `placeOrder` v1: odpověď „přijato" není
důkaz (odmítnutí RMS přijde jen jako 351), ztracená odpověď = `unknown`
a dohledání čtením podle značky, nikdy opakování. Chybějící metoda u jiného
adaptéru = fail-closed. Tradovate adaptér se nemění.

### 2. Jak adaptér bracket ukazuje jádru

Tvar jako u Tradovate OSO, aby jádro nepotřebovalo nový model: vstup je
běžný příkaz, nohy nesou `parentOrderId` (vstup) a `linkedOrderId` (sestra).

- **Vlastní vstup** = příkaz odeslaný touto instancí přes `placeBracket`
  (poznán podle značky rozpracovaného zápisu nebo `basket_id` z odpovědi).
  Vysílá se se skutečným typem (Market/Limit/Stop).
- **Noha** = příkaz s `original_basket_id`, jehož rodič je v knize jako
  vlastní vstup. Vysílá se jako `Limit` (TP) / `Stop` (SL, `stopPrice` =
  spoušť) s oběma vazbami.
- **První zpráva nohy** (má `bracket_type`, nemá vazbu, není to náš vstup) se
  **nevysílá** — drží se stranou, dokud další zpráva vazbu nedoplní. Bez
  toho by jádro vidělo samostatný prodejní Limit a zkopírovalo ho jako vstup.
  Nepřijde-li vazba do `legLinkWaitMs` (1 s), příkaz se vyšle jako
  `Unsupported` + incident `attention`.
- **Všechno ostatní s `bracket_type`** (cizí bracket z jiné platformy, noha
  k neznámému rodiči) zůstává `Unsupported` jako ve v1 (INV-TRAD-07).
- **Po restartu / ze snímku:** řádky snímku jsou úplné. Rodič = má
  `bracket_type`, nemá `original_basket_id` a nese naši značku
  (`ownTagPrefix`); noha = `original_basket_id` ukazuje na takového rodiče
  v témže snímku nebo v knize. Jinak `Unsupported`.

### 3. Hlídání ochrany po vyplnění (INV-OUTBOX-03)

Po prvním vyplnění vlastního vstupu běží lhůta `legsWaitMs` (3 s; změřeno
38 ms). Do ní musí být každá požadovaná noha potvrzená burzou (TP `open`,
SL `trigger pending`) a součet množství noh se musí rovnat vyplněnému
množství vstupu. Jinak incident `bracket-legs-missing` (kritický)
s ID vstupu. **Adaptér nic nedostavuje ani nezavírá** — rozhodnutí patří
jádru/obsluze. Stejný incident vznikne, když pracující noha vlastního
bracketu skončí zrušením nebo odmítnutím, zatímco pozice trvá (např. někdo
zrušil nohu jinde → podle měření padnou obě).

Stav jde přečíst: `bracketState(accountId, entryId)` →
`entry-working | protected | unprotected | done | unknown`.

### 4. Zrušení a změna nohy

- `cancelOrder` na nohu vlastního bracketu adaptér **odmítne** (číselný kód,
  bez odeslání): zrušilo by to i sestru a pozice by zůstala bez ochrany.
  Úmyslné odstranění ochrany jde jen přes Flatten (bod 5).
- `cancelOrder` na nevyplněný vstup je běžné zrušení; nohy ještě neexistují.
  Po částečném vyplnění vstupu se zrušení zbytku povolí, ale spustí kontrolu
  z bodu 3 (množství noh × vyplněné množství) — chování serveru nezměřeno.
- `modifyOrder` na nohu = běžná změna (314, změřeno). Po potvrzení se znovu
  ověří, že vazba trvá (další zpráva / čtení); jinak `bracket-legs-missing`.
- Posun SL/TP před vyplněním vstupu (334) do v1 nepatří.

### 5. `liquidatePosition` — zrušit → ověřit → zavřít

Jedna operace na účet + kontrakt najednou; po dobu běhu adaptér na tomtéž
účtu a kontraktu odmítá nové `placeOrder`/`placeBracket` (zavírání nesmí
závodit s novým vstupem). Žádný krok se neopakuje.

1. **Čtení** příkazů (320, s hranicí jako ve v1) a pozice. Nic nepracuje
   a pozice 0 → `already-flat`. Čtení selže → `indeterminate`, nic se neposílá.
2. **Zrušení** všech pracujících příkazů toho kontraktu (i cizích
   a `Unsupported` — Flatten je stavový), souběžně. `CANCELLATION_FAILED`
   u příkazu, který mezitím skončil (sestra), není chyba.
3. **Ověření**: nové čtení 320 nesmí pro kontrakt vrátit nic pracujícího
   (lhůta `cancelWaitMs` 3 s; živé notifikace čekání jen zkracují, důkazem je
   čtení). **Když něco pracuje dál → `indeterminate`, zavření se neposílá**
   a vznikne incident `flatten-cancel-unconfirmed`. Důvod: zavřít pozici
   a nechat pracovat nohu nebo vstup znamená riziko nové pozice bez ochrany
   na účtu, který má být flat; pozice, která zůstane, má aspoň to, co
   z ochrany zbylo. (Otevřená otázka A.)
4. **Čerstvá pozice.** 0 → `submitted` bez ID (stav jsme změnili zrušením;
   potvrzení stavem dělá volající). Neznámá → `indeterminate`.
5. **Zavření** `RequestExitPosition` — množství určuje server ze svého stavu,
   ne naše čtení. Odmítnutí → `rejected`; ztracená odpověď → `indeterminate`;
   jinak `submitted`. Zavírací příkaz nenese značku: adaptér si zapamatuje
   okno operace a první cizí `MARKET` proti pozici na tom účtu/kontraktu
   v něm označí `brokerOrderType`-nezávislým příznakem `liquidationOf: tag`
   jen pro audit — **přiřazení je odhad a nic se podle něj nerozhoduje**.
6. Adaptér sám flat neověřuje ani netvrdí; `position → orders → position`
   dělá volající (INV-MODE-02).

Mezi kroky 3 a 5 je pozice krátce bez ochrany (~150 ms podle měření).

### 6. Co se nemění

`placeOso`, `placeOco` zůstávají bez implementace. Účtování exekucí, obnova
spojení, snímky a stropy z v1 platí beze změny i pro nohy (noha je příkaz
jako každý jiný; její vyplnění jde přes `fillGap`).

## Otevřené otázky pro oponenturu

- **A.** Krok 5.3: když zrušení nejde ověřit, nezavírat (návrh), nebo zavřít
  i tak, protože Flatten je brzda? Případně rozlišit: nepotvrzené zrušení
  *vstupu* (zavřít nesmí nic rozbít) × *nohy*?
- **B.** Vysílat nohy jádru jako `Limit`/`Stop` s vazbami (návrh), nebo je do
  zapojení nechat `Unsupported` a jádru dát jen `bracketState`?
- **C.** Zavírací příkaz bez značky jádro uvidí jako cizí `MARKET` na účtu.
  Stačí auditní příznak, nebo má adaptér raději zavírat vlastním označeným
  Marketem s množstvím z čerstvého čtení (porušuje „ne ze zastaralého
  množství", ale je dohledatelný)?
- **D.** Blokování nových příkazů během Flattenu na úrovni adaptéru — je to
  správné místo, nebo patří jen jádru?

## Testy (napodobený server rozšířený podle měření H)

Server: nohy bez značky, vazba až od druhé zprávy, zrušení jedné nohy ruší
obě, `CANCELLATION_FAILED` u sestry, zavření bez značky, zavření na flat
účtu bez příkazu. Případy: přijetí/odmítnutí RMS/ztracená odpověď u
`placeBracket`; první zpráva nohy se nevysílá; vazba nepřijde →
`Unsupported`; nohy nevzniknou → `bracket-legs-missing`; noha zrušena jinde
→ incident; `cancelOrder` na nohu odmítnut; Flatten: šťastná cesta, flat,
zrušení nepotvrzeno → žádné zavření, pád spojení v každém kroku →
`indeterminate` a žádné opakování, souběžný druhý Flatten, nový příkaz
během Flattenu odmítnut; snímek po restartu složí bracket z řádků.
