# Okamžité SL/TP z čáry (návrh, 6. 11. 2026)

Zadání Filipa: po Marketu natáhnu SL a hned je u brokera, natáhnu TP a hned je u brokera. × na SL nebo TP
nohu zruší a na vstupu se znovu ukáže čip `+ SL` / `+ TP`. Totéž u čekajícího Limitu a Stopu. Bez potvrzování.

## Dnes
- `attach-brackets`: jen obě nohy naráz, `placeOco` k vlastnímu holému vstupu (`prepareAttachBrackets`, controller ř. 6202).
- Odebrat nohu nejde. Spravovaný obchod očekává `stopBrokerOrderId` i `targetBrokerOrderId`.
- Čekající vstup jde jen jako OSO se dvěma nohami; `oso-lone-leg` je fail-closed.
- Přikoupení vyžaduje SL i TP pozice.

## Co u Tradovate nevíme (nutný záznam na DEMO, spouští Filip)
- K1: `cancelorder` jedné nohy OCO: přežije partner, nebo se zruší taky?
- K2: jde k pracujícímu Stopu připojit Limit do OCO? Předpoklad: ne, jen nový `placeoco`.
- K3: čekající OSO: zrušení jedné Suspended nohy, co udělá se vstupem a partnerem?
- K4: `liquidate` a ruční zavření: zruší samostatný Stop bez OCO?

## Návrh fáze 1: jen vyplněná pozice, sólo manual-only DEMO skupina bez followerů
Nový příkaz `set-legs` s cílovým stavem `{ stopLoss: cena|null, takeProfit: cena|null }` a `expect` (co uživatel viděl).
Stejné brány jako attach: vlastní nejnovější záznam, fresh čtení, fence, Flatten/in-flight/ingress těsně před zápisem,
≥ 8 ticků od čerstvé ceny IBKR, durable záznam před zápisem, po ACK ověření pozice, `unknown` = incident a nic neopakovat.

| Z → do | Zápisy |
|---|---|
| nic → SL / nic → TP | `placeOrder` jedné nohy na celou pozici |
| SL → SL+TP, TP → SL+TP | zrušit starou nohu, potvrdit zrušení, `placeOco` obou |
| SL+TP → jen SL / jen TP | podle K1: zrušit jednu, nebo zrušit obě a `placeOrder` zbylé |
| SL → nic, TP → nic | zrušit nohu; pozice je pak holá a dá se zase zavřít × a přikoupení je blokované |

Pořadí „nejdřív zrušit, pak založit“: krátce bez nohy, ale nikdy dvě SL naráz (dvojité vyplnění by pozici otočilo).
Selhání založení po zrušení = incident `fill-unprotected`, text „pozice je bez SL, nastav ho nebo zavři“, bez retry.

Ostatní cesty: samostatná noha při zploštění = cílené zrušení (stejně jako po attach), čára a čip čtou stav nohy z brokera,
BE a posun umí pozici s jednou nohou, přikoupení s jednou nohou zůstává blokované.

## Fáze 2 (po K3): čekající Limit/Stop
Předpoklad: zrušení vstupu a nový vstup, ztráta místa ve frontě, riziko fillu mezi kroky. Rozhodne záznam.

## Hned bez nových příkazů (mezikrok)
Holá pozice: jakmile jsou připravené obě nohy, odejde `attach-brackets` hned po puštění druhé čáry, bez tlačítka `Odeslat SL a TP`.

## Verdikt copier-design-critic, kolo 1 (6. 11. 2026): BLOKUJE fáze 1 a 2, mezikrok OK s podmínkami
Hlavní nálezy: × SL by prošlo pod kill a za DISARMED; přechod SL → SL+TP má okno bez SL u každého obchodu a selhání
založení nechá holou pozici bez retry; vlastní Canceled posouvá frontu, takže krok 2 by končil `not-sent`; samostatnou
nohu po zavření pozice nikdo nehlídá (Stop by otevřel short); Flatten během sekvence vynechá leadera; mnoho
kontrol (× zavření, BE, krytí, status `bareLeaderTrade`) předpokládají obě nohy; relay má rozestup 2 s na obchod.
Alternativa k oponentuře: „zaparkovaná noha“, první čára založí OCO s druhou nohou daleko, vše další je `modifyOrder`.
Stavba až po záznamu na DEMO K1, K5–K8 (K12 pro parkování) a rozhodnutí Filipa.
