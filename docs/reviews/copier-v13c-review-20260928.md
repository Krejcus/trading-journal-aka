# Adversariální review konzervativního V13 (commit fb9fb39)

## Čočka orphans

# Čočka OSIŘELÉ NOHY A OSO, commit fb9fb39: 5 nálezů

Nejvážnější je N1, nová tichá regrese: nohy částečně vyplněného OSO zůstanou po flatu followera pracovat a kopírka nic nezapíše, zůstane ARMED a bez chyby. Předchozí regrese V13 jsou při realistické fixture pryč. Worktree jsem neměnil, vše běželo jen v exportech.

## Srovnání sond: fb9fb39 vs 1a59237^

**Důležité k původním sondám.** Mock v nich nechává parent OSO followera `working` a jeho nohy také `working`. V Tradovate tento stav odpovídá částečnému fillu. fb9fb39 v tom stavu nohy tiše nechá, což je přesně nález N1, ne návrat starých regresí. Proto jsem sondy pustil ještě jednou s parentem nastaveným na `filled` (soubory `zzF_*`, stejná úprava, jakou fb9fb39 udělal ve svých dvou fixtures).

| Sonda | fb9fb39, původní fixture | fb9fb39, parent filled | 1a59237^ |
|---|---|---|---|
| L1–L4, T6/T6b/T7 | working, 0 cancelů, ARMED, bez auditu | zrušeno | zrušeno |
| L2, T9 (DISARM) | working, DISARMED, bez auditu | zrušeno | zrušeno |
| B2, B3 (účet 300), B7 | working, bez auditu | zrušeno | zrušeno |
| B5 (REST pozice +1) | ARMED, tiše | fail-closed + nohy zrušeny | totéž |
| L5, T1–T3, B6 (Blokace4) | timeout (sonda čeká na cancel) | L5, T1–T3 zrušeno jako pre (B6 bez varianty) | zrušeno |
| L5b-new (čekající OSO nové epizody) | – | mo-4..6 nedotčeny (N5 z první review opraveno) | mo-5/mo-6 zrušeny |
| L7, B8, B8b | zrušeno | zrušeno | zrušeno |
| L10 (pomalé čtení nad 2 s) | zrušeno, ARMED | zrušeno | fail-closed, deadline 1500 ms |
| B4 (rychle selhávající čtení) | 4 čtení (2/ID), DISARM | – | 1 čtení, DISARM |
| T8 | 62 status čtení, 0 listOrders | – | 0 / 2 |

Moje sondy jsou v `tests/zzO_Osirele.test.ts`:

| Sonda | fb9fb39 | 1a59237^ |
|---|---|---|
| **O1:** parent 1/2 vyplněný, nohy Working, flat kopírovaným exitem | nohy working, 0 cancelů, ARMED, bez auditu; zůstanou i po zrušení zbytku parentu; pozdější fill TP → short −1 | nohy zrušeny |
| **O1b:** parent Working + nohy Working | tiše ponecháno | zrušeno (stejně jako 1a59237 a 90cee98) |
| **O2:** parent Filled, jeho čtení 2× 503 | DISARM, nohy working, 0 cancelů, auto-close nic neudělá | zrušeno, ARMED (i 1a59237 a 90cee98) |
| **O3:** parent zrušený, děti ve streamu Suspended | zrušeno, audit, ARMED | zrušeno |
| **O3b:** čekající OSO, děti Suspended | nedotčeno (správně) | zrušeno (starý N5) |
| **O4:** syntetika, parent nové epizody se vyplní před sweepem | SL/TP nové pozice zrušeny → DISARM + Sell Market 1 | totéž |
| **O5:** protective-fill hint, parent 1/2 | SL zrušen, zbytek parentu Working bez SL/TP, ARMED | totéž |
| **O7:** hint + osiřelý SL_A z jiného OSO | SL_A working, ARMED, lastError null | fail-closed „broker stále hlásí 1 pracovních ochranných noh“ |

## Nálezy

### N1 — STŘEDNÍ (regrese fb9fb39, tichá): brána parentu OSO nebere ohled na stav nohy
- **Kde:** `services/copierRuntimeController.ts:2002-2037`, tichý návrat na `:2037`.
- **Scénář:**
  - Follower má parent částečně vyplněný (Tradovate ho drží jako `Working` s cumQty > 0). Nohy jsou aktivované (`Working`).
  - Follower se dostane na flat bez protective hintu a bez mirror cancelu nohou (vlastní exit, ruční zásah, anomálie typu 24. 8.).
  - Parent hlásí open, takže nohy vypadnou z `safeOpenIds` a funkce skončí `return`.
  - Nezapíše se audit, chyba ani trvalá povinnost. Nic dalšího sweep znovu nespustí, zrušení zbytku parentu nevytvoří flat přechod.
- **Důkaz:**
  - O1 a O1b: fb9fb39 nohy ponechá. 1a59237^, 1a59237 i 90cee98 je zruší, takže regrese vznikla až ve fb9fb39.
  - O1 pokračování: fill osiřelého TP přetočí followera do −1.
- **Oprava:**
  - Bránu parentu uplatnit jen na nohy s vlastním stavem `pending` (Suspended). Noha `working` nemůže být dítětem nevyplněného OSO, takže ji zrušit vždy.
  - Když parent zůstává open a jeho nohy jsou working (parciální fill), zrušit i zbytek parentu. Je to risk-redukující cancel, ne obchod. Případně `failClosed({autoClose:false})` s auditem.
  - Nikdy nekončit tiše, pokud nad flat followerem zbyla open noha.
  - V mocku dávat nohám nevyplněného OSO stav `pending`.
- **Jistota:** mechanismus ověřen testem. Četnost je střední: vyžaduje parciální fill (multiplier ≥ 2) a nohy, které nezrušil mirror cancel.

### N2 — STŘEDNÍ (regrese, hlasitá): nečitelný parent zablokuje i cancel prokazatelně Working nohou
- **Kde:** `:2019-2030`, `targetedOrderStatus` na `:1696-1723`, `failSweep` na `:1962-1975`, `autoFlattenCopies` na `:5684` (`if (!hasExposure) return true`).
- **Scénář:**
  - Stream nemá parent jako terminální a `/order/item` dvakrát selže (429/503), nebo vrátí null (archiv po konci seance).
  - Následuje throw, DISARM a nohy dál pracují nad flat followerem až do ručního re-ARM.
  - Pokud jiný follower drží pozici, `failSweep` navíc spustí auto-close uprostřed obchodu.
- **Důkaz:** O2.
- **Oprava:** součást opravy N1. U nohou `working` parent nečíst. Null parent při Working dětech brát jako důkaz fillu. Fail-closed ponechat jen pro nohy `pending`.
- **Jistota:** test. Pravděpodobnost nízká až střední, protože parent Filled je normálně ve streamu a REST se nevolá.

### N3 — STŘEDNÍ (regrese vůči 1a59237^, tichá, trvá od 1a59237): hint zúží sweep jen na nohy své epizody
- **Kde:** `:1940-1950` a `:1956`.
- **Rozdíl:**
  - Pre-V13 po cancelu četl `listOrders` a hlasitě selhal při jakékoli jiné pracující ochranné noze účtu a symbolu.
  - fb9fb39 ostatní nohy vůbec nečte.
- **Důkaz:** O7. Odpovídá L4 z první review.
- **Oprava:** hint použít jen k vynechání vlastní epizody z brány parentu. Kandidáty brát ze všech noh účtu a symbolu. Terminální nohy vyřídí čtení ze streamu bez REST, takže incident 28. 9. to nezatíží.
- **Jistota:** test. Vyžaduje anomálii, tedy přesně typ situace, kvůli které sweep existuje.

### N4 — STŘEDNÍ (starší chyba, ne regrese): „protective fill dokazuje vyplněný parent“ platí jen pro plný fill
- **Kde:** `:2005-2010`.
- **Scénář:** O5. Zbytek parentu followera pracuje dál bez SL/TP, protože OCO děti už byly spotřebované. Leaderův vstup je Filled, takže mirror cancel nepřijde.
- **Důsledek:** pokud se zbytek vyplní, follower je ve vyplněném vstupu bez SL/TP. Tvrzení v commit message to nepokrývá.
- **Oprava:** u entry, ze které hint pochází, přečíst parent. Je-li open, zrušit zbytek, nebo `failClosed({autoClose:false})` s auditem.
- **Jistota:** test (mock).

### N5 — NÍZKÁ (starší chyba, syntetický scénář): SL/TP nové epizody se zruší, když se její parent vyplní dřív, než sweep doběhne
- **Kde:** `sweepKnownFollowerOrders` (`:1848-1886`). Před cancelem se pozice nekontroluje, pre-write kontrolu `listPositions` z 1a59237 fb9fb39 odstranil.
- **Důkaz:**
  - O4 dopadne v obou verzích stejně.
  - V realistickém toku (O4r) leader-flat guard nový vstup nepustil dřív, než byl follower srovnán, takže jsem scénář přirozeně nevyvolal.
- **Oprava:** před cancelem načíst autoritativně pozice. Při net ≠ 0 nic nerušit a zavolat `failClosed({autoClose:false})`.

## Mimo čočku, ale vážné (O6/O6b)
- **Scénář:** follower má parciální fill 1/2 a leader vystoupí trhem. Kopírka pošle **Sell Market 2** (leader qty × multiplier) nad pozicí +1. Výsledek je otočení na −1 s pracujícími Sell nohami a Buy zbytkem, guard jen vypne kopírku (DISARM).
- **Původ:** stejně se chová cb5cdf6^ i 90cee98/fb9fb39. cb5cdf6 a 1a59237 to blokovaly fail-closed „nevysvětlená divergence před leader exitem“. Jde tedy o chování, které vrátil V12 follow-up. Doporučuji ověřit ve V12 čočce.

## Ověřeno bez nálezu
- Suspended děti čekajícího OSO se neruší, platí to i pro rekonciliaci, protože používá stejnou funkci.
- Parent zrušený a děti ve streamu ještě Suspended: nohy se zruší a zapíše se audit.
- Parent vyplněný, ale stream to ještě nehlásí: `findOrderStatusById` si stav dočte přes REST `/order/item` a nohy zruší. Problém nastane jen při selhání REST (N2).
- Jiný symbol: drží filtr `request.symbol` (`:1933-1937`) a kontrola pozice podle symbolu.
- Ruční příkazy: kandidáti jsou jen z `bracketOutbox`/`osoOutbox` a exit-only rezervací, ruční příkazy se nedotknou.
- ARM s pracujícími příkazy je odmítnut (T5), takže tichá větev N1 se projeví nejpozději při dalším ARM.
- Selhání exit-only sweepu má `autoClose:false` (`:7484-7490`).

## Celá sada
Příkaz `npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier` na exportu fb9fb39: 124 souborů, 1493 testů, vše prošlo. Žádný z nálezů N1–N5 tedy stávající sada nezachytí.

## Soubory
Adresář scratchpadu: `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`
- **Sondy:** `v13c-osirele/tests/zzO_Osirele.test.ts` (O1–O7, O4r) a `v13c-osirele/tests/zzF_{CancelLens,Soubeh,Blokace,BlokacePre}.test.ts` (varianta s parentem filled). Kopie jsou v `v13c-osirele-pre/tests/`.
- **Exporty:** `v13c-osirele` (fb9fb39), `v13c-osirele-pre` (1a59237^), `v13c-osirele-x-prev12` (cb5cdf6^), `v13c-osirele-x-1a5` (1a59237), `v13c-osirele-x-90c` (90cee98).
- **Výstupy:**
  - `v13c-osirele-probes-{post,pre}.txt`
  - `v13c-osirele{,-pre}.F.txt`
  - `v13c-osirele{,-pre}.O.txt`, `.O56.txt`, `.O7.txt`
  - `v13c-osirele-x-*.txt`
  - `v13c-osirele-suite.txt`

## Čočka budget-latency

Čočka rozpočet, fronta a 429: fb9fb39 ruší průběžnou blokaci fronty z 28. 9., ale přináší dvě regrese. Po restartu workeru čte sweep celou historii nohou. Rozpočet navíc platí jen pro jeden účet a symbol, ne pro celou frontu. Následuje 5 nálezů, z toho 1 vysoký. Všechny jsou latentní: dnes se neprojeví, rostou s historií.

Worktree jsem neměnil, broker ani produkci jsem nevolal. Z lokálního stavu Mac agenta jsem četl jen počty (`osoOutbox` 0, `bracketOutbox` 0, skupina 64503883).

### N1 — VYSOKÁ (regrese): po restartu se sweep bez hintu nevejde do rozpočtu a vypne skupinu při každém výstupu
- **Kde:**
  - `services/copierRuntimeController.ts:1952-1960`: kandidáti jsou všechny nohy účtu a symbolu z celé durable historie.
  - `:1980-1995`: čtou se všechny, než se cokoli zruší.
  - `:1689`: `mapWithConcurrency` při první chybě zahodí už přečtené výsledky.
  - `:1604`, `:9453`: `sweptProtectiveLegs` žije jen v paměti.
  - `:1962-1976`: `failSweep`.
  - `services/tradovateBroker.ts:1784-1806`: ze streamu se bere jen terminální stav, na ostatní jde REST `/order/item`.
- **Scénář:**
  1. Worker se restartuje. Stream pak nemá nohy starších session (komentář `tradovateBroker.ts:1755-1757`).
  2. Přijde flat bez hintu: kopírovaný market nebo standalone Stop (cesta incidentu 28. 9.), breach, sideline nebo reconcile.
  3. Sweep čte historii po dvou dotazech naráz. Při RTT 120 ms stihne ~88 čtení, takže nad ~43 historickými OSO/OCO záznamy na follower a symbol vyčerpá 5,25 s.
  4. Výsledek: DISARM a auto-close. Nic se neuloží, takže se to opakuje při každém dalším flatu.
  5. Skutečně osiřelé working nohy se přitom nezruší.
- **Důkaz (sondy, mock s latencí):**
  - **R1a:** fb9fb39 udělal 88 REST za 5 253 ms, DISARM „celkový deadline 5250 ms“, nohy mo-5/mo-6 zůstaly `working` s 0 cancely. 1a59237^: 2× `listOrders`, 248 ms, nohy zrušené, ARMED.
  - **R1b:** dvě kola, v každém 88 čtení a DISARM. 1a59237^ obě kola OK.
  - **R3 (reconcile s orphan nohou):** fb9fb39 88 čtení, orphan nezrušen, fail-closed. 1a59237^ nohy zrušil.
  - **R5 (propka zlikviduje followera 200):**
    - fb9fb39: DISARM a auto-close poslal followerovi 300 dvakrát Sell Market, zatímco leader zůstal long. SL pro 300 nebyl doručen.
    - 1a59237^: ARMED, 200 izolován, SL pro 300 za 215 ms.
- **Oprava:**
  - Kandidáti bez hintu jen z nohou, které nejsou durable označené jako terminální, nebo z aktuální ARM session.
  - Nad prahem (více než 6 nezjištěných ID) jedno `listOrders(accountId)` jako v 1a59237^, cílená čtení jen pro working nohy.
  - V reconcile (`:9085-9105`) brát ID mimo autoritativní snapshot jako nepracující.
  - Terminální výsledky zapisovat průběžně po každém čtení.
  - Prořezávat durable outbox historii (otevřený dluh z 25. 8.).
- **Jistota:** test. Obsah Tradovate syncu po restartu je předpoklad z komentáře. Dnes je historie 0, prořezávání v kódu neexistuje, takže roste s každou nativní OSO/OCO kopií.

### N2 — STŘEDNÍ (latentní, souvisí s N1): hrozí 429 a hodinový breaker
- **Kde:** stejná místa jako N1. Počet čtení omezuje jen čas: nejvýš 2·5,25 s/RTT na followera a vlnu.
- **Důkaz (R7):** 3 followeři, 300 historických OSO, 20 ms na čtení.
  - fb9fb39: 1 446 čtení na vlnu, 15,8 s, DISARM, stejné číslo i v druhé vlně.
  - 1a59237^: 6× `listOrders` (≈30 REST), 134 ms.
- **Dopad:**
  - 10 followerů na jednom Tradeify loginu dá ≈4 800 čtení na vlnu. To je limit 5 000/h, takže 429 a hodinový breaker, který blokuje i nouzový Flatten.
  - Nižší latence (VPS) znamená víc čtení v rámci rozpočtu.
  - Po 429 se to už nezesiluje: druhý pokus lokálně odmítne breaker (`tradovateBroker.ts:404-410`).
- **Oprava:** jako N1, navíc strop cílených čtení na vlnu a připojení (například 20) s fallbackem na `listOrders`.
- **Jistota:** počty z testu, riziko 429 odhadnuté podle limitu 5 000/h z `PROJECT_LOG`.

### N3 — STŘEDNÍ (regrese): rozpočet není celkový a delší fronta končí na `stale-heartbeat`
- **Kde:**
  - Nový rozpočet vzniká na každé volání (`:1927`, `:7472`).
  - Flat událost pouští protective sweep a exit-only sweep za sebou (`:7894-7907`), dohromady až 10,5 s.
  - Followeři se zpracují sériově, takže N × 5,25 s.
  - Heartbeat jde stejnou `eventTail` frontou (`:9509-9512`, `:7498`).
  - Brána `copierRiskGate.ts:139` a `:161` blokuje po 10 s, a to i cancel lifecycle.
- **Scénář:** souběžný vstup leadera, SL modify nebo exit ostatních followerů čeká na součet všech sweepů. Nad 10 s fronty leader event zablokuje `stale-heartbeat`, následuje fail-closed a auto-close.
- **Důkaz:**
  - **R2:** 3 followeři flat, každý sweep ~4,5 s a bez chyby. Re-entry leadera zablokoval `stale-heartbeat` (3×), DISARM, nic se nezkopírovalo. 1a59237^ kopii poslal za 1,8 s a zůstal ARMED.
  - **R5b (sweep se do rozpočtu vejde):** SL modify pro 300 přišel za 3 617 ms, na 1a59237^ za 216 ms.
- **Oprava:**
  - Společný deadline na dávku sweepů, se součtem bezpečně pod `maxHeartbeatAgeMs`.
  - Exit-only sweep ať sdílí rozpočet s protective.
  - Drahé read-only dohledávání historie mimo `eventTail`, zápisy podle přesných ID v `eventTail`.
  - Nohu, kterou stream hlásí jako working, rušit bez předchozího REST čtení. Je to první zápis, ne opakování.
- **Jistota:** test (R2, R5b). Oněch 10,5 s na jednu událost jen z čtení kódu.
- V ustáleném stavu, kdy jsou nohy ve streamu, je fb9fb39 rychlejší než 1a59237^ (0 REST).

### N4 — STŘEDNÍ (starší chyba, V13 ji zesiluje): selhání sweepu zavírá ostatní followery
- **Kde:** `:1974` volá `scheduleAutoClose` vedle `failClosed`. Auto-close ale flat účet přeskočí (`:5680-5684`).
- **Scénář:** osiřelé nohy flat followera auto-close nezruší. Zavře jen ostatní followery uprostřed obchodu (R5: Sell Market pro 300, leader long).
- **Oprava:** u protective sweepu použít `failClosed(…, {autoClose:false})` stejně jako u exit-only (`:7488-7491`). Osiřelé nohy řešit hlasitě a blokací ARM.
- **Jistota:** test.

### N5 — NÍZKÁ až STŘEDNÍ: cancel odejde s prakticky nulovým zbytkem rozpočtu
- **Kde:** `:1633` kontroluje jen `remaining <= 0`, cancel je na `:1864-1872`.
- **Důkaz (R6):** cancely odešly v 5 250 ms. Broker obě nohy zrušil, ale na postkontrolu nezbyl čas, takže fail-closed „celkový deadline 5250 ms“. 1a59237^: OK za 950 ms.
- **Oprava:** před zápisem vyžadovat rezervu (například ≥1,5 s nebo 2× naměřené RTT), jinak fail-closed bez zápisu. Případně dát postkontrole vlastní malý read-only rozpočet.
- **Jistota:** test.

### Ověřeno bez nálezu
- **Druhý cancel:** v jednom sweepu nevznikne. R6 má 1 cancel na nohu, B4 nejvýš 2 čtení na ID (4 volání pro 2 ID, 1a59237 jich mělo 20).
- **Vyčerpaný rozpočet:** vždy končí hlasitě (audit `cancel-failed` a `lastError`).
- **Exit-only:** selhání jde s `autoClose:false`.
- **Po 429:** k zesílení nedochází.
- **Incident 28. 9.:** nohy terminální ve streamu, tedy 0 REST, 0 cancelů a žádný DISARM.

### Předchozí sondy, fb9fb39 proti 1a59237^

Původní sondy (zruseni, soubeh, blokace) na fb9fb39 jako celek procházejí 27/35, 1a59237^ 34/34. Selhání L5, B2, B3, B5, B6 (Blokace4), T1, T2 a T3 jsou artefakt fixture: parent OSO followera tam nikdy není vyplněný. fb9fb39 pak správně nechá Suspended nohy být (oprava dřívějšího N5), testy čekají na cancel a skončí timeoutem nebo neprojdou assertem. Varianty `zzF_*` s vyplněným parentem prošly: fb9fb39 35/35, 1a59237^ 34/34.

| Sonda (`zzF_*`) | fb9fb39 | 1a59237^ |
|---|---|---|
| L1–L3, L5, L7, L9, T1–T7, T9, B1, B1b, B1r, B1-fast, B2, B6, B6x, B7, B8, B8b | stejné: nohy zrušené, stav jako před V13 | stejné |
| L4-new | vyplněná noha má 0 cancelů | 1 cancel |
| L10 (čtení nad grace 2 s) | nohy zrušené, ARMED | DISARM „deadline 1500 ms“, nohy working |
| B3 | fail-closed účtu 200, účet 300 zrušen | totéž |
| B4 | 4 čtení (2 na ID) | 1 |
| B5 | fail-closed „broker stále hlásí pozici 1“ | totéž |
| T8 (30 historických OSO) | 62 cílených čtení | 2× `listOrders` |

### Sondy této čočky (`zzRozpocet`)

| Sonda | fb9fb39 | 1a59237^ |
|---|---|---|
| R1a | 88 REST, 5,25 s, DISARM, orphan nohy working | 248 ms, nohy zrušené, ARMED |
| R1b | 2× (88 REST, DISARM) | 2× OK |
| R2 | re-entry zablokován `stale-heartbeat`, DISARM | kopie za 1,8 s, ARMED |
| R3 | 88 REST, orphan nezrušen, fail-closed | nohy zrušené |
| R4 (flatten followera pro obchod) | SL pro 300 za 318 ms | 320 ms, bez rozdílu |
| R5 | DISARM, auto-close Sell Market pro 300 | ARMED, SL za 215 ms |
| R5b | SL pro 300 za 3 617 ms | 216 ms |
| R6 | cancel v 5 250 ms, DISARM | OK |
| R7 | 1 446 REST na vlnu, DISARM | ≈30 REST, OK |

### Celá sada na exportu fb9fb39
`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier`: 124/124 souborů, 1 493/1 493 testů prošlo.

Soubory jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- `v13c-rozpocet/tests/zzRozpocet.test.ts` a `zzF_*.test.ts` (kopie jsou i v `v13c-rozpocet-pre/tests/`)
- `rozpocet-*.txt` (výstupy lens sond)
- `v13c-rozpocet-probes*-{new,pre}.txt` (výstupy předchozích sond)
- `v13c-rozpocet-suite.txt` (výstup celé sady)
- `v13c-rozpocet.diff` (diff controlleru)