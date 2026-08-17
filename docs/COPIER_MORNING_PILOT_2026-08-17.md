# AlphaTrade copier — ranní pilot 17. 8. 2026

Cíl: ověřit skutečný Tradovate demo transport od OAuth po jeden follower bez
současného zásahu TradeCopie. Nejde o povolení autonomního obchodování.

## Pevné hranice

- Pouze `TRADOVATE_ENVIRONMENT=demo`.
- První skupina: právě 1 leader + 1 follower, multiplier `1`.
- Bez ATM, OSO, OCO nebo připojeného SL/TP v prvním write testu.
- TradeCopia nesmí ve stejnou chvíli odesílat na vybraného followera.
- Každý start je DISARMED. Reconnect, změna konfigurace, divergence, working
  order, rate-limit nebo nejasný outbox znovu DISARMuje.
- `live` příkaz se nespouští bez čerstvého potvrzení uživatele v konverzaci.
- `live` runtime tvrdě přijme nejvýše jeden nový leader `orderId`; jeho modify,
  fill a cancel lifecycle může dokončit. Druhá nová objednávka okamžitě fail-closed
  DISARMuje session a na followera se neodešle.
- Nikdy automaticky nedorovnávat rozdíl obchodem ani automaticky flattenovat.

## Příprava krátkodobého lokálního lease

Lokální worker nepotřebuje Vercel, Supabase ani refresh-token secrets. Dostane
jen krátkodobý demo access token zašifrovaný svým RSA veřejným klíčem.

```bash
npm run copier:pilot -- keygen
```

V LIVE / Connections kliknout u aktivního spojení na ikonu klíče, vybrat
`.copier-pilot/pilot-public.pem` a uložit stažený JSON. Privátní PEM nikdy
neopouští Mac a adresář `.copier-pilot/` je ignorovaný Gitem.

Lease stáhnout čerstvý těsně před testem (ideálně 07:45–07:55). Runner odmítne
shadow/live start, pokud token nevydrží celý zvolený interval plus 5 minut
rezervy.

Všechny následující příkazy používají:

```bash
--lease /absolutni/cesta/alphatrade-pilot-....json
```

Pokud lease expiruje, stáhne se nový. Refresh token se lokálně nepřenáší.

## 08:00 — Gate A: účty a read-only preflight

Nejdřív vypsat aktuální broker ID a zvolit přesný pár:

```bash
npm run copier:pilot -- accounts --lease /cesta/pilot.json
```

Uživatel potvrdí leader, follower, že oba účty vlastní/spravuje, a že na
followerovi je TradeCopia vypnutá. Potom:

```bash
npm run copier:pilot -- preflight \
  --lease /cesta/pilot.json \
  --leader LEADER_ID \
  --follower FOLLOWER_ID
```

PASS vyžaduje: demo, aktivní execution permission, WS sync, oba účty flat,
žádné working orders. Současně zkusit otevřít Tradovate Trader; pokud tím API
socket vypadne, test zastavit a nevytvářet ARM.

## Gate B: broker dry-run

Aktivní MNQ kontrakt se ráno přečte z Tradovate; `MNQU6` se nesmí předpokládat
bez ověření. Cena bude neproveditelná limitní cena zvolená podle aktuálního
trhu. Dry-run nic neodesílá, ale počítá se do API limitu.

```bash
npm run copier:pilot -- dry-run \
  --lease /cesta/pilot.json \
  --leader LEADER_ID \
  --follower FOLLOWER_ID \
  --symbol AKTIVNI_MNQ \
  --side Buy \
  --quantity 1 \
  --order-type Limit \
  --price NEPROVEDITELNA_CENA
```

## Gate C: 30 minut shadow

```bash
npm run copier:pilot -- shadow \
  --lease /cesta/pilot.json \
  --leader LEADER_ID \
  --follower FOLLOWER_ID \
  --minutes 30
```

Uživatel na leaderovi provede pouze plain neproveditelný limit, modify o jeden
tick a cancel. AlphaTrade pouze plánuje; follower musí zůstat bez objednávky.
Audit se ukládá do `.copier-pilot/*.audit.jsonl`.

PASS: submit/modify/cancel ve správném pořadí, shodný účet/symbol/strana/cena/
množství, 0 duplicit, 0 gap/out-of-order, 0 broker write.

## Gate D: jediný řízený demo write

Vyžaduje bezprostřední potvrzení uživatele. Znovu se ověří flat/no-working a
TradeCopia vypnutá pro followera.

```bash
npm run copier:pilot -- live \
  --lease /cesta/pilot.json \
  --leader LEADER_ID \
  --follower FOLLOWER_ID \
  --minutes 15 \
  --approval POTVRZUJI_1_MNQ_DEMO_WRITE
```

První lifecycle: plain vzdálený 1 MNQ limit na leaderovi -> kopie na followera
-> modify o jeden tick -> cancel. Teprve pokud skončí oba účty flat/no-working,
lze novým potvrzením udělat jeden minimální fill roundtrip.

Po command ACK čeká adaptér až 5 sekund na potvrzení Order entity ze sync
streamu; ACK samotný není považován za potvrzený cancel/modify. Při ukončení
runner znovu jen read-only ověří flat/no-working. Pokud to nedokáže nebo
najde otevřený stav, vypíše `MANUAL ACTION REQUIRED` a nic automaticky nezavírá.

## Okamžité STOP podmínky

- 423, 429, penalty ticket nebo captcha;
- WebSocket disconnect, reconnect loop nebo sequence gap/out-of-order;
- jakákoli divergence pozic;
- working order před ARM;
- `unknown`, `abandoned`, nalezená duplicita nebo CAS konflikt;
- follower objednávka se špatným symbolem, stranou, cenou či množstvím;
- TradeCopia stále aktivní na followerovi;
- neočekávaný bracket/child order;
- uživatel řekne stop.

Po STOP pouze DISARM a ruční kontrola Tradovate pozic/objednávek. Žádný
automatický retry, reconciliation order ani flatten.

## Co se měří

- leader event -> zahájení follower requestu (`queueMs`);
- follower request -> HTTP/command ack (`brokerMs`);
- leader event -> ack (`totalMs`);
- sync potvrzení Order, první Fill a terminal state;
- počet reject/unknown/recovered/duplicate/abandoned.

První den je baseline, nikoli důkaz produkční připravenosti. Cíl pro pilot je
p95 `totalMs <= 500 ms`, žádný nevysvětlený případ nad 2 s a všechny bezpečnostní
počty na nule.

## TradeCopia retirement gate

TradeCopia zůstává odpojený fallback, dokud není 7 po sobě jdoucích obchodních
dní bez divergence/duplicit/unknown outboxu a každý disconnect skončil DISARM +
ruční reconciliation. Oba copiéry nikdy neposílají na stejný follower zároveň.

## Skutečné výsledky 17. 8. 2026

Testovaný pár:

- leader `61887494` / `TDFYG50549979811`;
- follower `61887493` / `TDFYG50534566527`;
- Tradovate DEMO, multiplier `1`.

Ověřeno proti autoritativnímu sync streamu:

- plain vzdálený 1 MNQ limit byl na followerovi potvrzen, následný modify změnil
  tutéž follower objednávku a cancel skončil stavem `canceled`;
- market entry 1 MNQ se zkopíroval, nativní OCO SL/TP bylo potvrzeno, změna SL
  proběhla jako modify a ruční zavření leadera zrušilo obě OCO nohy a zavřelo
  followera;
- market/OCO lifecycle skončil s `unknown=0`, `duplicates=0`, p95 `167 ms`;
- závěrečná read-only kontrola potvrdila oba účty `positions=0`, `working=0`.

Fail-closed důkaz:

- při pokusu o další plain limit zůstal v Tradovate aktivní bracket; leader
  vytvořil tři skutečná order ID (entry Limit, target Limit, stop Stop);
- follower dostal pouze první entry limit, další dvě order ID zastavil
  `leader-order-session-limit`; runtime nic neopakoval ani automaticky
  neflattenoval;
- operátor ručně zrušil working orders a následná read-only kontrola potvrdila
  všechny účty `positions=0`, `working=0`.

Lokální failure matrix po broker testu: 140 testů pokrývajících timeout před/po
přijetí, restart recovery, eventual lookup, duplicity, reject, disconnect,
sequence gap, OCO recovery, partial fill a WebSocket korelaci prošlo bez chyby.

Závěr: plain limit/modify/cancel ani základní market+OCO lifecycle se už nemusí
opakovat. Další broker test musí mít novou přesnou hypotézu; fault injection se
provádí lokálně, ne výrobou zbytečných demo objednávek.

## Připravený další gate: čekající entry + SL/TP (OSO)

Lokálně je připraven nativní `POST /order/placeoso` tok. Krátké korelační okno
rozliší samostatný limit od trojice entry + přesně jeden SL + přesně jeden TP.
Trojice se zapisuje do vlastního durable outboxu před jediným broker side
effectem; timeout se po restartu dohledává podle všech tří tagů a nikdy se
naslepo neposílá znovu. Částečný nebo duplicitní lookup končí fail-closed.

Stav lokální verifikace: TypeScript bez chyby, 109 testovacích souborů / 917
testů a produkční build prošly. Oficiální Tradovate Partner API potvrzuje
payload `bracket1` + `bracket2` i response `orderId` + `oso1Id` + `oso2Id`.

Tohle stále **není důkaz skutečného broker write**. První OSO DEMO test vyžaduje
nové bezprostřední potvrzení uživatele, flat/no-working preflight, jediný
leader/follower pár, multiplier 1 a vzdálený 1 MNQ čekající entry. Po submitu se
musí nejdřív ověřit autoritativní Order stream na obou účtech; modify/cancel se
provádí až po samostatném potvrzení operátora.

### Skutečný OSO DEMO výsledek 17. 8. 2026

Externí pending-entry conformance proběhla na stejném páru `61887494` ->
`61887493`, MNQU6, quantity 1 a multiplier 1:

- read-only preflight před shadow i live během potvrdil demo, execution
  permission, WS sync, oba účty flat a bez working orders;
- shadow stream koreloval entry Limit + target Limit + stop Stop jako jediný
  `native-oso`; follower zůstal `positions=0`, `working=0`;
- live běh odeslal jediný nativní OSO broker side effect a autoritativní stav
  ukázal přesně tři working objednávky na leaderovi i followerovi;
- změna entry ceny upravila tutéž follower entry objednávku;
- zrušení leader bracketu vytvořilo tři potvrzené follower cancel události;
- po DISARM následný nezávislý preflight potvrdil leader i follower znovu
  `positions=0`, `working=0`;
- runtime skončil s `unknown=0` a `duplicates=0`; OSO latency sample se v tomto
  běhu do obecné metriky nezapsal (`p95=0`), takže latenci z tohoto testu nelze
  poctivě reportovat.

Pending OSO submit/modify/cancel je tím externě ověřený a nemá se opakovat bez
nové konkrétní hypotézy. Samostatně neověřený zůstává fill/partial-fill lifecycle
čekajícího OSO entry.

### Skutečný OSO fill DEMO výsledek 17. 8. 2026

Na stejném páru byl následně samostatným explicitně potvrzeným během ověřen
fill marketable 1 MNQ limit entry s připojeným SL/TP:

- před startem prošel nový flat/no-working preflight a runtime přijal právě
  jeden `native-oso` lifecycle;
- po fillu autoritativní broker stav ukázal na leaderovi i followerovi přesně
  jednu otevřenou pozici a dva working ochranné příkazy;
- po ručním Close na leaderovi follower nejdřív potvrdil dva cancely SL/TP a
  potom jediný close dispatch;
- po DISARM byly oba účty `positions=0`, `working=0`; nezávislý závěrečný WS
  preflight znovu prošel;
- runtime skončil `dispatched=4`, `unknown=0`, `duplicates=0`, `p95=162 ms`.

Tím je externě ověřen i plný pending OSO fill -> aktivní ochrana -> ruční close
lifecycle. Neověřený zůstává pouze skutečný partial fill a fault-injection
varianty, které se mají primárně držet v deterministických lokálních testech,
ne vyrábět zbytečnými broker objednávkami.
