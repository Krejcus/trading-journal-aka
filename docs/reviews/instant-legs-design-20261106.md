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

## Rozhodnutí Filipa (6. 11. 2026): SL a TP u Limitu jsou dobrovolné
Limit jde zadat bez nohou a po vyplnění je bez SL a TP, jak znal z TradingView. Riziko nevědomého fillu bez stropu přijal.
Zaparkované nohy tím nejsou cesta pro Limit, zůstávají jen jako možnost pro okamžité SL/TP.

### Fáze 1: holý Limit, po záznamu na DEMO
- Jen manual-only sólo DEMO bez followerů, capability `manual-entry-bare-limit-v1`, jen qty 1 (relay i worker), Limit, ne Stop.
- Výjimky `bare === true` rozdělit na holý Market a holý čekající. Čekající jde celou C12 revizí, OFF, kill, day lock a ARM expiry ho ruší.
- Korelátor: výjimka jen pro záznam `bare` s týmž tagem nebo id, ne shoda účet, symbol, qty. Cizí vstup fail-closed dál.
- × před fillem = cancel-entry. Fill během rušení = pravdivý text „vyplněno BEZ SL“.
- Neznámý výsledek odeslání = `failClosed` i pro holý čekající.
- Po fillu holá pozice: chipy a attach beze změny, `reference = request.price ?? referencePrice`, status rozliší čekající a vyplněný.
- Upozornění při fillu holého vstupu. Automatické zrušení po čase Filip nechce.

### Fáze 2: chipy na čekajícím Limitu, podle záznamu
Možnosti: zrušit a založit OSO (ztráta místa ve frontě, riziko fillu v díře), nebo nohy drží worker a pošle po fillu (krátce bez SL, závislost na workeru). Rozhodne `limit-replace` a `bare-limit-fill-oco`.

### Fáze 3: SL a TP po jedné, × vrací čip
Podle `lone-stop-*`, `oco-cancel-*`, `pending-leg-cancel`. Blokující nálezy kola 1 výše platí.

### Záznam: `scripts/copier/record-legs.ts`
`bare-limit-cancel`, `bare-limit-fill-oco`, `limit-replace`, `lone-stop-liquidate`, `lone-limit-liquidate`, `lone-stop-opposite-close`, `lone-stop-then-oco`, `oco-cancel-sl`, `oco-cancel-tp`, `pending-leg-cancel`. Měřit v RTH, DEMO nedokazuje chování Lucid a Tradeify.

### Nálezy criticu k fázi 1 (kolo 2): OPRAVIT PŘED STAVBOU
- Záznam: třetí durable stav pro zrušený holý Limit, ne jen čekající a vyplněný; `closedAt` se dnes ukládá jen pro `filled`, status by ukázal × u neexistující pozice.
- Okno `sending`: bez důkazu tagu zůstává `maybe` a fail-closed, výjimka platí až po ACK. Shoda účet, symbol a qty nikdy nestačí.
- „Bez zrušení po čase“ není GTC: C12 ruší podle denní pauzy CME, konce session, okna a ARM expiry. Když worker neběží, příkaz u brokera zůstane bez zrušení i upozornění. Zapsat do INV-MANUAL-01 a rozhodnout o TIF.
- Fill během automatického zrušení (OFF, kill, day lock) má stejný pravdivý text jako u ×.
- Doplnit: výjimka DLL mezi zadáním a fillem do INV-RISK-01, typ a cena místo natvrdo `Market` (`bare-not-market`), brána „jen DEMO“ ve workeru i relayi, test Flattenu s holým čekajícím.
- Skript zapisuje přes REST, worker může přes WS: pořadí eventů a ACK se může lišit, skript nedokazuje worker. Po stavbě zvlášť ověření z appky na DEMO.

## Výsledky záznamu na DEMO (6. 11. 2026, 20:29–20:36 CET, DEMO8661118, 14 scénářů, každý jednou, přes REST, kopírka vypnutá)
Záznamy: `~/Library/Application Support/AlphaTrade/copier/recordings/leader-legs-*`. Všechny skončily čistě, worker bez chyby. DEMO nedokazuje Lucid ani Tradeify a skript nedokazuje worker.

| Otázka | Výsledek |
|---|---|
| Holý Limit | Vznikne, ACK ~150 ms; první událost ze streamu o 7 ms před ACK. Události vlastních příkazů nesou vlastní tag, události z liquidate ne. |
| Zrušení holého Limitu | 230 ms. Marketable Limit a okamžité zrušení: `TooLate`, příkaz vyplněný, pozice 1. |
| Holý Limit po fillu + OCO | OCO přijato, ACK 206 ms. |
| Zrušení jedné nohy OCO z `placeoco` (K1) | Partner dál běží, u SL i TP, kontrolováno 4 s. Není potřeba zrušit a založit znovu. |
| Zrušení TP čekajícího OSO (K3) | SL i vstup dál pracují; zrušení vstupu pak zruší i SL. Neměřeno: zrušení SL čekajícího vstupu, fill po zrušení nohy, zrušení nohy OSO u vyplněné pozice. |
| Liquidate se samostatnou nohou (K4) | Stop i Limit zruší. Stop zrušen asi 270 ms před uzavíracím příkazem. |
| Opačný Market se samostatným Stopem | **Stop zůstane pracovat i na flat účtu**, kontrolováno 2 s. Tohle je riziko SL bez OCO při zavření mimo appku. |
| OCO vedle pracujícího Stopu (K2) | Přijato. Dvojí SL asi 330 ms (OCO + zrušení, ve skriptu). |
| Zrušit nohu a založit OCO | Mezi potvrzením zrušení a ACK OCO ~510 ms včetně režie skriptu; samotné příkazy zhruba 190 + 190 ms. |
| Jeden vzorek | K6 (N ≥ 20) splněné není. K7–K12 neměřeny. TIF ve výpisu vidět není. |

Důsledek: × na noze je prosté `cancelOrder` a zaparkované nohy nejsou potřeba. Přidání druhé nohy zůstává výměna se dvěma možnými pořadími. Blokující nálezy kola 1 (brzdy u × SL, hlídání samostatné nohy, Flatten během výměny, kontroly počítající s oběma nohami, relay rozestup 2 s) dál platí.

## Návrh v2: SL a TP po jedné u vyplněné holé pozice (po záznamu, 6. 11. 2026)
Filip: stavět jako první. Dotčená pravidla: INV-MANUAL-01, INV-OUTBOX-01/02/03, INV-BRAKE-01/02/03, INV-RISK-01, INV-UI-01/02/03, INV-RELAY-01/03, INV-DIVERGENCE-01, INV-DEFAULT-02/03, INV-TRAD-02/08, INV-RECON-02.

**Rozsah:** jen sólo manual-only DEMO bez followerů, capability `manual-order-single-leg-v1`, jen vlastní vyplněný záznam `bare: true`, jeden lístek, plný fill, nejnovější vstup, `closedAt == null`. Čekající Limit, OSO z panelu a pozice s dokupy se nemění. Přikoupení k pozici s jednou nohou zůstává blokované.

**Stav:** `bare: true` + 0, 1 nebo 2 id nohou. 0 = holá, 1 = částečná (nové), 2 = spravovaná jako po attach dnes.

**Příkazy** (nové akce `add-leg` a `remove-leg`, `leg: 'stopLoss' | 'takeProfit'`; `add-leg` nese `newPrice`):
| Z | Akce | Zápisy |
|---|---|---|
| 0 nohou | add-leg | `placeOrder` Stop nebo Limit na celou pozici |
| jen SL | add-leg TP | `placeOco` SL (stejná cena) + TP, po ACK zrušit starý SL. Krátce dvojí SL, deklarovaný přechod. |
| jen TP | add-leg SL | zrušit TP, po potvrzení `placeOco`. Pozice SL před tím neměla, ztrácí se jen TP. |
| 2 nohy | remove-leg | `cancelOrder` jedné nohy, partner běží (DEMO, jen OCO z `placeoco`); nová kontrola id. |
| 1 noha | remove-leg | `cancelOrder`, zpět na 0 |
| 1 noha | `move-stop` / `move-target` | worker pozná částečný záznam, `modifyOrder` téže nohy, posun SL dál od trhu přes `moveStopRiskBlocked` |

**Brány:** jako attach (nejnovější záznam, fresh čtení, fence, Flatten, in-flight, ingress, tvar pozice, ≥ 8 ticků od čerstvé IBKR ceny na správné straně), povolené otevřené příkazy jsou jen vlastní nohy. `add-leg` SL k pozici bez SL smí za brzdy jako attach. Vše ostatní (`remove-leg`, `add-leg` TP, posun) jen ARMED ∧ ¬shadow ∧ ¬kill. Odebrání SL se nikdy nepustí po brzdě a je v supersede relaye.

**Sekvence dvou kroků:** durable fáze před každým zápisem, stará id ze záznamu mizí až po ověřeném zrušení. Krok 2 nepoužívá frontovou fence, kontroluje jen Flatten, abort a flat ze streamu. Celá sekvence je registrovaná jako rozpracovaný zápis a Flatten nastaví abort před krokem 2.
- Selhání OCO při SL → SL+TP: starý SL dál chrání, `rejected`, bez incidentu. Neznámý ACK: `unknown` + incident.
- Selhání zrušení starého SL: dvojí SL, incident `recordWhenDisarmed` s textem, bez opakování.
- Selhání OCO po zrušení TP: pozice je bez nohou jako před tím, `rejected`, bez incidentu.
- Restart v `sending`: `unknown` + incident jako u attach, po startu jen čtení.

**Korelátor:** do `inferenceWindowMs` po fillu `add-leg` vrátí `busy` s textem „za chvíli“: lone leg by jinak udělal `incomplete-bracket-pair`. Vlastní jedna noha nesmí vyvolat `oso-lone-leg`; nové id se zapíše do vlastních nohou hned po ACK.

**Zavření mimo appku:** samostatný Stop na flat účtu dál pracuje (DEMO). Návrh: při dvojím ověření flat (`leaderVerifiedFlat`) cílené zrušení vlastní nohy podle id jedním pokusem, jinak incident. Vyžaduje Filipův souhlas a výjimku v INV-DIVERGENCE-01.

**× zavření:** částečný záznam jde cestou holého zavření, liquidate; povolené otevřené příkazy jsou vlastní nohy.

**Relay:** validace nových akcí, rozestup 2 s na obchod zůstává; rychlý druhý tah vrátí `entry-busy` a UI to řekne. Denní strop beze změny.

**UI (PC i telefon):** chip `+ SL` / `+ TP` podle nohy, kterou pozice nemá; puštění chipu odešle `add-leg`, klik bez tahu nic. × na čáře SL/TP = `remove-leg`. „Odeslat SL a TP“ pryč. Starý worker bez capability: dnešní chování.
