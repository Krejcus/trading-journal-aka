## masking
# Adversariální review commitu cb5cdf6 (V12), čočka maskování

**Závěr:** Nenašel jsem žádný deterministický scénář, kdy by nová výjimka zamaskovala skutečnou divergenci. Když se čekající kopie z výpočtu vyjme (`continue`, `services/copierRuntimeController.ts:6806`), kontrola spadne na přesnou rovnost `followerNet === expectedPreNet`. Maskovat se tedy dá jen přes zastaralý stav v paměti. Ten ale v produkci zastarává víc, než commit tvrdí (nález 1). Dva nálezy jsou mimo čočku: jde o falešná vypnutí, která způsobí stejnou škodu jako V12, tedy nezkopírovaný SL.

## Nálezy

### 1. [střední] „Connection generation“ v produkční topologii nevidí výpadky follower spojení
- **Kde:**
  - `copierRuntimeController.ts:7138`: generace se zvyšuje jen na `connection` event.
  - Kontrola generace je na 6781–6791.
  - `brokerRouter.ts:293–305`: výpadek nekritické routy do 10 s router zahodí („mrknutí se nikdy nestalo“).
  - `brokerRouter.ts:201–206`: router hlásí jen změnu agregovaného stavu a příznak `resynced` nepředá nikdy.
  - `scripts/copier/pilot.ts:353`: follower routy jsou v produkci `critical:false`.
- **Scénář:**
  1. Leader zadá Sell Limit 8 z flat, kopie se zkopíruje, pak Market Buy 8.
  2. Spadne websocket followera. Při cyklu tokenu (~80 min) je to běžné.
  3. Během výpadku (≤10 s) je stav followera v paměti zmrazený: pozice +8, kopie „open, 0 fill“, generace beze změny.
  4. Leader zadá SL. Výjimka přijme důkaz z doby před výpadkem, SL se zkopíruje a kopírka zůstane ARMED.
  - Když se mezitím kopie u followera vyplnila nebo účet srovnala prop firma či ruční zásah, vznikne nekrytý Stop, který později otevře pozici, kterou leader nemá. Starý kód by tady (náhodou) fail-closed kvůli V12.
- **Důkaz (test):** `routerprobe.test.ts`, stejný sled ve dvou variantách:
  - jeden mock broker: `armed=false` („Connection recovery není autoritativně čistá“),
  - router s nekritickou follower routou: `armed=true`, `200:Sell:Stop:8` odeslán.
  - Test v commitu „V12 reconnect generation…“ router obchází, proto tuhle cestu nepokrývá.
- **Poznámka:** Zastaralé pozice jsou problém už dřív (týká se i přísné kontroly). Požadavek specifikace „před reconnectem známý order musí zůstat fail-closed“ ale v produkci neplatí. Neplatí ani tvrzení komentáře na ř. 1326.
- **Návrh:**
  - Generaci počítat pro každou routu nebo účet.
  - Router by měl pro nekritické routy předat alespoň `blip/resynced` bez vypnutí kopírky.
  - Před vyjmutím kopie z očekávané expozice ověřit leader i follower order přes `findOrderById` (authoritative) a pozici followera přes `listPositions`. Stejně to dělá `flushStandaloneBracketStop`. Specifikace výslovně chtěla „čerstvý autoritativní snapshot“.
- **Jistota:** ověřeno testem (mock + skutečný `createBrokerRouter`).

### 2. [nízká–střední] „Zero-fill důkaz“ znamená jen, že fill ještě nedorazil; cena se neporovnává
- **Kde:** `copierRuntimeController.ts:6789–6806`. Není tam časový limit ani REST potvrzení. `limitPrice/stopPrice` se nekontroluje, takže „zrcadlo“ uzná i order s jinou cenou.
- **Scénář:**
  1. Kopie Sell Limit u followera se vyplní, ale leaderův order ne. Při FIFO na stejné ceně je to nepravděpodobné. Reálné je to v okně posunu ceny: leader odtáhne TP, modify followera ještě letí, cena se dotkne staré ceny.
  2. Eventy followera jsou zpožděné (druhý socket nebo nález 1).
  3. Leader zadá SL a ten se zkopíruje do followera, který je ve skutečnosti flat, jako Stop Sell 8.
  4. Po doručení eventů kontrola velikosti pozice po ~2 s vypne kopírku (`:3379`, `autoClose:false`). Nekrytý Stop Sell 8 ale u followera zůstane working.
  5. Po jeho fillu je follower −8 při flat leaderovi. V mocku ho během 4 s nic nezavřelo, přestože běžela i simulace dosažení SL.
  - Starý kód v tomtéž sledu vypnul kopírku už u SL (V12) a nekrytý Stop nevznikl.
- **Důkaz (test):** `m3probe.test.ts` (fillQty 8 i 3). Nový kód po SL: `armed=true`, placed obsahuje `Sell:Stop:8`. Po zpožděných eventech `armed=false`, `followerOpen` stále obsahuje `mo-3:Sell:Stop:8`.
- **Návrh:**
  - Porovnávat cenu v zrcadlové kontrole.
  - Vyjmutí podmínit autoritativním lookupem (viz nález 1).
  - Při fail-close z kontroly velikosti rušit kopírkou vlastněné redukující ordery, které přesahují pozici followera.
- **Jistota:** mechanismus ověřen testem. Reálnost výchozí situace je nízká (FIFO), jde tedy o hypotézu.

### 3. [střední, mimo čočku: neúplná oprava a regrese oproti předchozímu chování] Změna množství čekajícího limitu = trvale neplatný důkaz = vypnutí a SL se nezkopíruje
- **Kde:**
  - `copierRuntimeController.ts:6684` a 6693: `quantity === followerQuantity`, jinak trvale `evidenceInvalid`.
  - Totéž pro leadera na 6705 a 6714.
  - Záznam se po modify nikdy neaktualizuje, přestože `planModify` modify followerovi odešle.
- **Scénář:** Sell Limit 8 z flat → leader ho změní na 6 (kopie se správně upraví také na 6) → Market Buy 8 → Stop Sell 8.
- **Důkaz (test, `v12mask.test.ts` R2):**
  - nový kód: `armed=false`, „nevysvětlená divergence“, Stop se nepošle,
  - starý kód (89386da): `armed=true` a Stop se pošle, protože záznam při nesouladu množství smazal.
  - Jde o variantu V12 se stejnou škodou (follower bez SL). Posun samotné ceny (R2p) nový kód opravuje.
- **Návrh:** Po úspěšném `modify` atomicky přepsat `leaderQuantity/followerQuantity` (případně cenu) v záznamu. Nebo očekávaný tvar odvozovat z `runtime.state.links`, ne ze snímku při vzniku záznamu.
- **Jistota:** ověřeno testem na obou commitech.

### 4. [nízká, mimo čočku] Delší okna falešného vypnutí u Market kopií
- **Kde:**
  - Záznam se nově maže jen při terminálním stavu orderu, dřív už při `remaining===0`.
  - Market výjimka vyžaduje nulový kumulativní fill leadera (`leaderCum===0`).
  - On-fill Market kopie leaderova Limitu nebo Stopu dostane `evidenceInvalid` hned při vzniku (`orderType` Limit ≠ Market, 6615–6617).
- **Scénář:** Tradovate pořadí je fill → order (Working, cumQty) → order (Filled). Mezi tím každá redukující akce leadera vypne kopírku.
- **Důkaz a omezení:** Sondy R1 a R1b ukázaly, že samostatný SL krátce po vstupu drží bracket korelátor (~1,75 s) a zpožděný fill followera zachytí kontrola velikosti. Reálný dopad je proto malý.
- **Jistota:** čtení kódu a částečně test.

## Ověřeno bez nálezu (čočka maskování)
- **Ruční +1 followera vedle zrcadla s nulovým fillem:** fail-closed (M1, test).
- **Test 1336** (ruční pozice schovaná za rozjetou Market kopií): pořád fail-closed. Fill leadera ho teď dokonce zpřísní.
- **Částečný fill na kterékoli straně, leader cancel / osiřelý follower order, terminální nebo chybějící leader order:** trvale `evidenceInvalid`, dokud follower order neskončí. Smazání záznamu vede jen na přísnou kontrolu.
- **Předchozí ARM epocha a reconnect bez routeru:** fail-closed. ARM s working ordery je odmítnut (M4, test).
- **Jiný symbol nebo strana:** `evidenceInvalid` při vzniku, filtrování podle symbolu.
- **Dvojice nezávislých exitů** (TP limit + zkopírovaný SL): stav je symetrický u leadera i followera. Rozjezd vzniká jen situací z nálezu 2.

Testy jsem psal jen do scratchpadu (výřezy commitů 89386da a cb5cdf6). Repo, broker ani agent jsem neměnil:
- /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/v12mask.test.ts
- /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/m3probe.test.ts
- /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/routerprobe.test.ts
- /private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/r1probe.test.ts

Čísla řádků odpovídají `git show cb5cdf6:services/copierRuntimeController.ts`. Worktree má necommitnuté změny V13, takže tam se čísla řádků mohou lišit.

## incident
# Adversariální review cb5cdf6 (V12): incident a úplnost

**Verdikt: commit v této podobě nenasazovat.** Incidentní sled z 28. 9. oprava pokrývá. Zároveň ale rozbíjí dva existující regresní testy a v běžných tocích vyvolává stejnou škodu jako V12: DISARM celé skupiny a SL nebo exit se nezkopíruje. Stačí k tomu obyčejný vstup, čekající limit být nemusí.

Postup ověření: všechno běželo na čisté kopii `git archive cb5cdf6` a `cb5cdf6^` ve scratchpadu. Worktree obsahuje necommitnuté změny V13 jiné session, proto jsem v něm nic nespouštěl jako důkaz. Repo jsem nezměnil.

---

## 1. CRITICAL – regrese: vlastní fill leadera zneplatní pending záznam → falešný DISARM a exit/SL se nezkopíruje
**Jistota:** ověřeno testy (dva existující testy + moje sondy).

**Kde (čísla řádků v cb5cdf6), `services/copierRuntimeController.ts`:**
- `6609`: on-fill Market kopie vzniká s `leaderCumQuantity > 0`, takže je neplatná hned od založení.
- `6731`: fill leadera zvýší `leaderCumQuantity` u každého pending záznamu s daným `leaderOrderId`.
- `6745`: totéž dělá fill followera.
- `6781–6789`: `currentZeroFillLineage` vyžaduje všechny fill čítače na nule.
- `6806–6816`: Market je vyjmutý jen s nulovou lineage. Jinak se nastaví `invalidEvidence = true`.
- `6676`: záznam se nově maže jen terminálním order eventem. Před opravou zmizel, jakmile fill dosáhl množství.
- `6907`: `invalidEvidence` vede rovnou k divergenci.
- `6128`: samostatný SL při tom končí throw → `failClosed` s auto-close.

**Důkaz, existující testy.** Na `cb5cdf6^` procházejí, na `cb5cdf6` padají:
- `tests/copierChaosScenarios.test.ts` „4 rychlé vstupy a okamžitý flat … při opožděných follower fillech“: flat exit se followerovi nezkopíruje („follower close Market příkaz nebyl vytvořen“).
- `tests/copierManagementOnly.test.ts` „13→14→15→18 on six followers … keeps exits live“: plný exit 18 nedostane žádný ze šesti followerů (`requests: []`). Test vychází z incidentu 21. 9.
- V PROJECT_LOG commitu je ověření jen „povinné 4 soubory 168/168“. Širší copier sada se nespouštěla.

**Důkaz, moje sondy.** Stav před opravou → po opravě:

| Sonda | Sled | Před | Po |
|---|---|---|---|
| R1 | on-submit Market Buy 2, fill leadera zpracovaný, stream followera zpožděný, po 3 s Stop Sell 2 | Stop zkopírován, ARMED | DISARM „nevysvětlená divergence“ |
| R2, R2b | fill a pozice followera dorazily, terminální order event ještě ne (nebo order `working` s `filledQuantity = qty`, jak ho vydá Tradovate `fill` entity přes `composeOrder`) | Stop zkopírován, ARMED | DISARM |
| R3 | on-fill i on-submit, scalp exit dřív, než dorazí fill followera | exit zkopírován | exit nezkopírován, DISARM |
| R11 | SL v bracket okně (samostatný SL), follower má u brokera fill, ale stream je pozdě | Stop zkopírován | „Samostatný SL: neověřená follower expozice“ |
| R12 | Buy Limit leadera vyplněn, kopie followera ještě working, SL leadera | SL zkopírován | DISARM |

**Časové okno a frekvence (hypotéza):** okno trvá od zpracování fillu leadera do terminálního eventu followera. Shora ho omezuje zhruba 2s REST magnitude check. Zpoždění streamu followera podle V11 je 0,6–2,9 s. U čtyř followerů stačí jeden pomalý a DISARM zasáhne celou skupinu.

**Návrh opravy:**
- Pro záznamy, jejichž leader order už má fill, vrátit sémantiku před opravou: počítat zbývající množství followera a záznam retirovat, jakmile fill followera dosáhne množství.
- Novou výjimku „zero-fill mirror“ nechat jen pro nevyplněné leader ordery.
- `invalidEvidence` nastavovat jen při skutečné anomálii: overfill, neshoda tvaru, orphan.
- Doplnit testy s realistickými leader fill eventy a zpožděným streamem followera.
- Před releasem pustit celou `tests/copier*` sadu.

## 2. MEDIUM – změna množství čekajícího limitu (Buy i Sell) zneplatní záznam natrvalo
**Jistota:** ověřeno testem (R6).

**Kde:** `6701–6714` (kontrola leadera `quantity === candidate.leaderQuantity`), `6680–6693` (follower). Flag je sticky.

**Scénář:**
1. Sell Limit 8 z flat, potom Market Buy 8.
2. Leader zmenší limit na 4 (typicky TP po částečném výstupu). Kopírka ho u followera správně modifikuje.
3. Každý další leader SL/exit submit vede k DISARM a nezkopíruje se. Trvá to, dokud limit pracuje.

**Srovnání:** před opravou R6 prošel (záznam se při změně tvaru smazal), po opravě DISARM.

**Návrh opravy:** při zkopírovaném replace aktualizovat `leaderQuantity/followerQuantity`, nebo mirror ověřovat čerstvě vztahem `followerQty = floor(leaderQty × multiplier)`. Konzistentní změnu množství nedělat sticky.

## 3. MEDIUM, zbytkové riziko v souladu se specifikací – částečný fill limitu zadaného z flat
**Jistota:** ověřeno testem (R9).

**Scénář:** limit z flat (typicky TP) se částečně vyplní u leadera i followera stejně (3 z 8), pozice sedí 5/5. Další Stop submit vede k DISARM a SL se nezkopíruje. Stejně to dopadá před opravou i po ní.

**Dopad:** třída incidentu 28. 9. zůstává otevřená pro scale-out TP. Pravidlo pro Filipa „zruš čekající limit před vstupem“ proto dál platí.

**Návrh opravy:** přesně vyjmout zbývající část, pokud zbytek leadera × multiplier = zbytek followera, fill eventy jsou pozorované na obou stranách a pozice sedí.

## 4. LOW – testy netestují, co tvrdí
**Jistota:** ověřeno spuštěním nových testů proti `cb5cdf6^`.

- **Který test co dokazuje:** proti `cb5cdf6^` padají 4 nové testy (incident, add-on, reconciliation, více pending), ty opravu skutečně dokazují. Zbylé 4 procházejí i bez opravy.
- **`V12 reconnect generation` (`tests/copierRuntimeController.test.ts:1661`):** projde i bez opravy. Ověřuje jen existující disarm při reconnectu, kontrolu generace neprovede žádná cesta.
- **`V12 leader cancel …` (`:1582`):** projde i bez opravy. DISARM způsobí timeout cancelu (`lastError` „mock broker: cancel timed out before reaching broker“). Žádný exit leadera nepřijde, takže pending logika se vůbec nespustí.
- **Incidentní test (`:1386`):**
  - Market Buy 8 nemá žádný fill leadera.
  - Mock vydá filly followera synchronně.
  - Cesta, kde je regrese z nálezu 1, se tak nikdy nespustí.
- **Chybějící testy:**
  - samostatný SL,
  - částečný výstup,
  - změna množství,
  - částečný fill na obou stranách,
  - reálný sled s fill eventy.

## Poznámky bez dopadu na bezpečnost

- **Generace spojení a epochy (čtení kódu):** `connectionSyncGeneration` a `tradeEpochGeneration` jsou prakticky redundantní. Každý connection event odzbrojí a ARM vyžaduje, aby na účtech nebyly pracovní příkazy. Router navíc výpadek follower route do 10 s neohlásí, takže komentář o „stejné generaci“ pro followery neplatí. Dispatch na odpojenou route ale selže, maskování jsem nenašel.
- **Klasifikace TP z flat (hypotéza, mimo rozsah commitu):** `leaderReducingRemainingByOrder` se při submitu limitu z flat nastaví na 0. Pozdější fill tohoto TP se pak může klasifikovat jako zvýšení expozice, což ovlivní restrikce vstupů a on-fill followery. Neověřeno.

## Co oprava pokrývá (ověřeno sondami po opravě)

- Incidentní sled s realistickými filly (C0): Stop se zkopíruje, pak i částečný výstup 3 a finální exit 5, kopírka zůstane ARMED.
- Posun ceny čekajícího limitu (R5): v pořádku.
- Leader zruší limit a cancel u followera uspěje (R7): v pořádku.
- Samostatný SL přes bracket cestu, původní 6055 (R10): Stop se zkopíruje. Před opravou DISARM a auto-close.
- OSO pending entry, cesty 6118/7785/7891 (R13): Stop se zkopíruje.
- Test 1119 (ruční pozice followera) dál končí fail-closed.
- Zbytek sady:
  - Controller má 128/128.
  - Ostatní copier testy v plném stromu 104/104.
  - Ostatní testy nad controllerem 172/172.
  - V celé copier sadě padají jen dva testy z nálezu 1.
  - Čtyři další pády šly jen na vrub chybějících migrací v mém částečném archivu. V plném stromu tyto soubory prošly.

Sondy jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- `v12probe.test.ts`, `v12probe2.test.ts` … `v12probe7.test.ts`
- čisté kopie `pre/`, `post/`, `postfull/`

## races
# Adversariální review cb5cdf6 (V12): souběh a čerstvost

**Výsledek:** našel jsem 5 nálezů. Tři jsem ověřil testem. Žádný nepotvrzuje nebezpečné zamaskování skutečné divergence. Čtyři z nich jsou ale regrese proti stavu před opravou: V12 se vrací jinými sledy událostí. Kopírka se vypne, SL nebo exit se nezkopíruje a follower zůstane v pozici.

**Jak jsem ověřoval:**
- Stav před opravou (`cb5cdf6^`) i po ní (`cb5cdf6`) jsem přes `git archive` vyexportoval do scratchpadu.
- Testy jsem spustil proti oběma verzím. Repo jsem neměnil.
- Za běhu reviewu se v worktree objevily cizí necommitnuté změny v `services/copierRuntimeController.ts` a nový `tests/copierFlatSweepV13.test.ts`. Čísla řádků proto platí pro commit `cb5cdf6`, ne pro aktuální worktree.

---

### 1. [HIGH] Market pending ruší už očekávaný fill → falešná divergence, exit/SL se nezkopíruje
*Ověřeno testem (S4, S5, S7).*

- **Kde:**
  - `services/copierRuntimeController.ts:6701-6716`: leader order `filled`, tedy „ne open“, nastaví trvalý `evidenceInvalid`.
  - `:6725-6735`: fill leadera zvýší `leaderCumQuantity`.
  - `:6781-6788`: lineage vyžaduje nulové fills leadera i followera.
  - `:6813-6816`: výjimka se týká jen `Market && currentZeroFillLineage`, jinak `invalidEvidence`, `:6907` = divergence.
  - Oprava navíc zrušila původní mazání záznamu, když fills pokryjí qty. Maže se už jen terminální order event (`:6676`).
- **Scénář S5 (backlog):**
  1. Leader pošle Market Buy 8. Při jeho zpracování jde kopie Market Buy 8 followerovi.
  2. Ve frontě už čeká fill leadera, jeho `Filled`, pozice a Market Sell 8. Eventy followera vzniknou až po dispatchi, takže stojí ve frontě za nimi.
  3. Fill leadera zneplatní Market pending.
  4. Exit leadera skončí „nevysvětlenou divergencí“.
  - Výsledek: **po opravě** je follower +8, leader flat a kopírka DISARMED (stejná škoda jako V12). **Před opravou** exit prošel, follower skončil flat a kopírka zůstala ARMED.
- **Kdy to nastává:** fill leadera vždy předbíhá fill followera minimálně o RTT dispatche. Okno se natahuje při backlogu `eventTail` (V8/V13 dokládají sekundy) a při zpoždění nebo výpadku follower spojení.
- **S4:** stejný výsledek i bez backlogu, pokud fill leadera dorazí před fillem followera.
- **S7:** follower je přesně +8 = leader. Fill followera už je zpracovaný, jeho order `Filled` ještě ne → po opravě halt, před opravou exit prošel.
  - Tradovate adapter po fillu emituje `order` se syrovým `ordStatus` a `cumQty=qty` (`tradovateBroker.ts:1100-1108`), takže mezistav „open + filled=qty“ je systémový.
- **Návrh opravy:**
  - U Market pending nezneplatňovat lineage fillem ani terminálním stavem leaderova vlastního příkazu. Pokračovat ve starém výpočtu `remaining = followerQty − max(followerFilled, followerFillSum)`.
  - Záznam mazat, když fills followera pokryjí qty. Invalid jen při nesouladu tvaru followera nebo overfillu.
  - Přidat testy S5 a S7.

### 2. [MEDIUM] Změna qty working limitu udělá pending trvale invalidním → V12 se vrací
*Ověřeno testem (S3; kontrola S3p se změnou jen ceny projde správně).*

- **Kde:** `:6684` a `:6705`. Qty se porovnává s hodnotou zamrazenou při vytvoření záznamu a invalid je trvalý (OR). Prune `:8503-8511` ho nikdy neresetuje.
- **Scénář:**
  1. Leader má Sell Limit 8 zadaný z flat a kopie čeká.
  2. Leader změní qty na 6, kopírka správně modifikuje followera na 6.
  3. Leader vstoupí Market Buy 8 a pak zadá Stop Sell 8.
  - Výsledek: **po opravě** „nevysvětlená divergence“, Stop se nepošle, DISARM. **Před opravou** se Stop poslal a kopírka zůstala ARMED (starý kód pending při nesouladu qty smazal).
- **Návrh opravy:** zrcadlo ověřovat proti aktuálním příkazům (`leaderOrder.qty × multiplier === followerOrder.qty`, obě otevřené, obě s nulovým fillem), ne proti qty z doby vzniku záznamu. Po potvrzené modifikaci qty uložené hodnoty aktualizovat.

### 3. [MEDIUM] Connection generation nevidí reconnecty, které router skryje
*Ověřeno testem, že generace se nezvýší a výjimka platí na důkazu z doby před reconnectem (S6). Konkrétní škoda je hypotéza.*

- **Kde:**
  - `brokerRouter.ts:201-206`: controller dostane event jen při změně agregátu. `resynced` z plánované obměny socketu (`tradovateBroker.ts:1220`) se tak ztratí.
  - `brokerRouter.ts:299-305`: reconnect nekritické route v rámci grace (10 s) se zahodí úplně.
  - `scripts/copier/pilot.ts:353`: follower-only spojení je nekritické (token cyklus ~80 min).
  - Tím neproběhne `connectionSyncGeneration += 1` (`:7138`) ani mazání pending při odpojení.
- **Rozpor:** komentář `:1326` tvrdí, že „každý nový broker sync zneplatní in-memory order důkaz“. Codex spec říká, že „před reconnectem známý order musí zůstat fail-closed“. V produkční topologii to neplatí.
- **S6 (router se dvěma mock brokery, follower blikne v grace, během mezery jeho broker pozice 0):**
  - Po opravě se SL zkopíruje, kopírka zůstane ARMED a follower má u brokera pozici 0.
  - Před opravou byl halt.
- **Mezera v testech:** test „V12 reconnect generation“ používá přímý mock broker, ne router, takže tuto cestu nepokrývá.
- **Reálná pravděpodobnost je nízká:** fill kopie F bez fillu leaderova limitu brzdí FIFO fronta na burze a resync baseline (`/order/list`) cache po obnově opraví. Okno = výpadek + resync.
- **Návrh opravy:** router předá per-route signál reconnect/resync (mimo agregát). Controller na něj zvýší generaci a smaže pending, případně generaci drží zvlášť pro každé spojení.

### 4. [LOW] „Čerstvost“ je jen shoda generace, ne čerstvý autoritativní snapshot
*Čtení kódu, hypotéza.*

- **Kde:** `:6763-6806`. Důkaz pochází ze stream cache (`rememberLiveOrder`). Není časově omezený a nebere ohled na `pendingBrokerEvents`. Spec Codexu přitom požadoval „z čerstvého autoritativního snapshotu“.
- **Scénář:**
  1. Follower F (Sell Limit 8) se částečně vyplní o 3.
  2. Fill, order a pozice followera stojí ve frontě za Stopem leadera.
  3. Výjimka se uplatní a pozice followera je v cache stále 8.
  4. Stop Sell 8 odejde na účet, který je reálně +5. Při spuštění by skončil −3 a zbytek F by dál pracoval.
  - Před opravou tady byl halt (vinou V12).
- **Pravděpodobnost:** nízká, F stojí na burze ve frontě za L.
- **Návrh opravy:** výjimku povolit jen bez nezpracovaných ingress eventů pro účty leadera a followera (počítadlo per účet na ingressu). Jinak udělat `findOrderById` obou příkazů, stejně jako `flushStandaloneBracketStop` (`:6103-6118`).

### 5. [LOW] Prune v reconciliaci běží souběžně s `eventTail` bez fence
*Čtení kódu.*

- **Kde:** `performReconciliation` jede na `reconciliationTail`, ne na `eventTail` (`:8341-8354`). Agent `reconcile` („Kontrola pozic“) ji volá za ARM bez disarmu (`server/localCopierExecutionAgent.ts:532-543`). Snapshot se pak přepíše a prořeže (`:8468-8512`) bez kontroly `tradeBoundaryObservationVersion`.
- **Dopad:**
  - Snapshot přečtený dřív, než vznikla kopie F, smaže živý pending záznam. Tím zmizí orphan/invalid důkaz.
  - Staré open ordery dostanou razítko aktuální generace.
  - Zamaskování jsem nenašel: fills jsou monotónní (max/součet) a invalid je trvalý.
  - Přepis `positionsByAccount` starým snapshotem je starší problém, ne z tohoto commitu.
- **Návrh opravy:** verzi observace zachytit před čtením. Když se během čtení změní, pending nemazat a nepřerazítkovat, jen označit jako invalid.

---

### Ověřeno bez nálezu
- Starý snapshot ani ordery přijaté mimo pořadí fill „neodvyplní“: monotónní max/součet a trvalý invalid drží.
- Změna jen ceny limitu po opravě projde (S3p). Před opravou tu byl halt.
- Incidentní sled (V12 test) projde. Cílené testy V12/pending v commitu: 10/10.
- **S1b je zlepšení.** Sled: fill leaderova limitu dorazí dřív než fill kopie a leader hned pošle Market exit.
  - Před opravou šel na flat followera Sell Market 8, přičemž mu dál pracoval Buy Limit 8. Follower skončil −8.
  - Po opravě halt.
- S1: samostatný SL po fillu limit entry padá před opravou i po ní na kontrole velikosti pozice followera. Není to regrese.

### Soubory
Dočasné testy jsou ve scratchpadu `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`, ve složkách `race-post/tests/` a `race-pre/tests/`:
- `race-v12.test.ts` (S1, S1b, S3, S3p)
- `race-v12b.test.ts` (S4)
- `race-v12c.test.ts` (S5)
- `race-v12d.test.ts` (S6)
- `race-v12e.test.ts` (S7)

Spuštění: `npx vitest run tests/<soubor> --silent=false --reporter=verbose` ve složce `race-post` nebo `race-pre`.