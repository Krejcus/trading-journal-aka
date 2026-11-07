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

## Oponentura návrhu v2 (6. 11. 2026): BLOKUJE v tomto znění, směr správný. Podklad pro stavbu v3
P1, opravit před stavbou:
- Flatten: registrovat jen surové zápisy, ne mezery. Flatten nastaví abort a krátce počká na konec surového zápisu, leader se nesmí vynechat (`settleFollowerCutBackgroundAccounts`, `emergencyFlatten`).
- Samostatná noha na flat: `leaderVerifiedFlat` s pracující nohou nikdy neprojde. Nová `reviewBareEntryLegs` a `leaderVerifiedFlatExcept(ids)`: dvě čtení net 0, otevřené jsou jen vlastní nohy, čtení nohy, durable `sending`, jeden pokus, raw `cancelOrder`, i za DISARMED a kill. Pozice není flat, cizí příkaz, první běh po restartu: jen incident. Revize nefiltruje `closedAt`. Pokrýt i 2 nohy po attach.
- Vlastnictví: `ownManualLegOrderIds` nerozšiřovat (vypnulo by `standaloneReduction`), oddělená `ownBareLegIds`, tag operace durable před zápisem, `LeaderEvent` tag z ingressu. Vlastní noha se do `bracketCorrelator.observe` neposílá.
- Durable model: na akci `phase`, `oldLegId`, `newStopId`, `newTargetId`, entry a akce jedním `persistSafety`, tag unikátní na operaci, restart v každé fázi jen čtení a incident (`restartedAttach` rozšířit).
- Dvojí SL: starý SL ≥ 8 ticků od IBKR ceny (`sl-too-close`), synchronně pracuje, prostý Stop, bez fillu, stejná cena; po sekvenci vždy autoritativní čtení, jinak incident.
- Krok 2: fence bez `tradeObservationVersionByAccount` leadera, plus route epoch, stopped, reconnect, config, generace. Zrušení starého SL se NEzastavuje na flat ani abortu a jde raw i po brzdě. OCO po zrušení TP se při flat, abortu a Flattenu neposílá.
- Korelátor: brána = pozorovaný fill vstupu a okno + 250 ms, bez důkazu fillu `busy`.

P2:
- Migrace nutná: `enqueue_tradovate_copier_brake` a záloha v relayi supersede `remove-leg` a `add-leg` TP. Agent výjimka jen `add-leg` SL. Migrace před webem, TTL `remove-leg` 5 s. Pod brzdou jen `add-leg` SL z 0 nohou (INV-BRAKE-02).
- Selhání: neznámé zrušení TP = incident bez OCO, `TooLate` = bez OCO, „zrušeno“ jen `canceled` s nulovým fillem z autoritativního čtení, po `remove-leg` přečíst partnera. Text po selhání OCO říká, že TP zmizel. Modify nohy zbylé z OCO neměřen.
- Noha zrušená v Tradovate: autoritativní konec s nulovým fillem vymaže id a oznámí to. TIF samostatného Stopu neznámý.
- `expect` nese i nohy, které uživatel viděl (druhé zařízení).
- `MANUAL_ACTIONS` v `lib/copierLiveExposure.ts` ve stejném commitu.

Kontrolní seznam čtenářů: `lib/manualBareClose.ts` (60, 89, 126, 128, 169, 221), controller 5507, 5598, 5738, 6131, 6142, 5687, 6870, 6351, 3689, 4930, 21739, 21661, 21683, 23287, 23372; `resolveManagedTrade` neuvolňovat, vlastní `prepareSingleLeg*` před 6876; `components/TradovateLiveDesk.tsx:1277`, `lib/liveBareEntry.ts:67`, `lib/leaderOrderManage.ts`, `services/copierEngine.ts:438`, `lib/copierWorkerCapabilities.ts`, agent 422 a 988, relay 1060, `server/copierCommandPushRelay.ts:119`, `server/copierIncidentWatchdog.ts:772`, `hooks/useLiveManageRunner.ts`, `components/day/LivePhoneOrderLines.tsx`.

Rozhodnutí Filipa: automatické zrušení vlastní nohy na flat s rizikem, že bez běžícího workeru ji nikdo nehlídá; × SL nechá pozici bez stropu.

## Návrh v4: Limit a Stop s volitelnými SL a TP, počítá s více účty (7. 11. 2026)
Filip: Limit i Stop mají být komplet a má se počítat s více účty. „Zrušit a založit“ stojí 2 zápisy na účet a jeden tah čipu by na 5 followerech znamenal asi 12 zápisů, kopírka by to navíc viděla jako nový vstup. Odpadá.

**Doporučení: vždy OSO se zaparkovanými nohami.** Vstup odejde jako dnešní OSO (`placeOso`), chybějící noha leží daleko a v grafu je místo ní čip. Čip i × jsou jen `modifyOrder` nohy, který kopírka umí zrcadlit followerům: 1 zápis na účet. Pozice ani čekající vstup nikdy nezůstanou u brokera bez OCO a po zavření nic nevisí.

| | Zaparkované | Worker pošle nohy po fillu | Zrušit a založit |
|---|---|---|---|
| Zápisy na účet za čip | 1 | 0, pak 1 při fillu | 2 |
| Místo ve frontě | drží | drží | ztráta |
| Worker neběží | SL u brokera | pozice bez SL | SL u brokera |
| Followeři | zrcadlení modify | nová cesta | vypadá jako nový vstup |
| U brokera je vidět | daleké nohy | jen vstup | plán |

**Cena volby:** „bez SL“ v appce znamená daleký SL v Tradovate, cena SL musí být na hranici povoleného rizika (`risk-daily`), a parkovaný TP potřebuje výjimku v `risk-drawdown`. To je odchylka od Filipovy věty „po vyplnění bez SL a TP“, musí ji odsouhlasit.

**Stav:** durable `parkedStop`, `parkedTarget` na záznamu vstupu, nikdy se neodvozuje z ceny; ruší ho až potvrzený modify. UI ukáže čip, přikoupení je blokované, deník a R neberou parkovanou cenu jako plán.

**Stop:** totéž. ≥ 8 ticků na straně průrazu, jen IBKR.

**Market:** dnešní sólo verze zůstává; kopírování Marketu na followery je zvlášť a mohlo by přejít na stejný model.

**Musí změřit DEMO (`record-legs.ts`, nové scénáře):** `parked-pending-modify`, `parked-filled-modify`, `pending-sl-cancel`, `pending-tp-cancel-fill`, `parked-modified-fill`, `bare-stop-cancel`. Měření limitů API samostatně, viz oponentura.

**Zbývá pro followery:** násobek a floor qty nohou, pravidla propek a jejich limity, ověření zrcadlení modify u Suspended nohy.

### Oponentura v4 (7. 11. 2026): OPRAVIT PŘED STAVBOU, směr parkování správný
- Followeři: modify Suspended nohy broker jen drží a followerům se nezrcadlí (INV-TRAD). Hybrid: broker drží parkované OSO, u followerů je čip před fillem durable plán, po aktivaci nohy jeden modify. Stavět až po měření.
- Parkování počítá worker: jedna absolutní cena, minimum přes účty. SL ≤ denní rezerva a cut včetně poplatků a skluzu. TP bez výjimky v `risk-drawdown`, rozpětí musí projít. Pod minimem `parking-no-room`, nikdy tiché přiblížení. Malá rezerva znamená blízký „parkovaný“ SL.
- Stav = durable příznak a cena u brokera přesně rovná uložené; posun v Tradovate je skutečná čára. Parkovaná cena se někde ukáže.
- Pořadí: DEMO a krátký test na reálném účtu kvůli pásmům cen; sólo qty 1 Limit i Stop; sólo qty > 1 po měření částečného fillu; followeři zvlášť.
- `write-burst` odstraněn: na Suspended noze nic neměří, lokální jistič se u některých odpovědí nezapne a token sdílí s workerem. Limity API se měří zvlášť na Working příkazech se stopem po prvním omezení.
- Stavba musí pokrýt fill během modify, ztracený ACK, restart s parkováním, posun v Tradovate, druhé zařízení, zúženou rezervu, kill při ×, Flatten s parkovanými nohami.

## Rozhodnutí Filipa (7. 11. 2026): Limit a Stop opravdu bez, návrh v4 s parkováním neplatí
Filip na otázku, jestli „bez SL“ smí znamenat vzdálený SL: „Ne, opravdu bez.“ Parkované nohy se proto nestaví. Postaveno:
holý Limit a Stop v sólo DEMO skupině po 1 kontraktu, po fillu čipy jako u Marketu (pravidla v INV-MANUAL-01). Čipy před
fillem a víc účtů jsou další krok. Scénáře `parked-*` ve `scripts/copier/record-legs.ts` zůstávají, nic na nich nestojí.
