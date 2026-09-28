# Adversariální review V13 (commit 1a59237)

## Čočka cancel-safety

**Čočka ZRUŠENÍ, commit 1a59237: nálezy (5 regresí, 1 starší chyba, 2 menší). Hlavní problém je opačný, než jsem hledal:** sweep neruší nic cizího, ale **tiše opouští staré ochranné nohy, které dál pracují nad flat followerem**. Před opravou je buď zrušil, nebo alespoň hlasitě vypnul kopírku (DISARM). Každou regresi jsem ověřil stejným testem na 1a59237 a na 1a59237^.

Testy jsou jen v exportu: `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/v13-zruseni/tests/zzCancelLensV13.test.ts`. Stejná kopie leží v `…/scratchpad/v13-zruseni-pre/tests/`.

---

### N1 — KRITICKÁ (regrese): běžný přechod leader epochy tiše zruší sweep
- **Kde:** `services/copierRuntimeController.ts:1678-1683` a `:1698`. Bariéra porovnává `generation` leader epochy. Tichý návrat je na `:2070`.
- **Scénář A:** follower je flat dřív, než se zpracuje flat leadera (oba vystopováni zároveň). Epocha přejde z open (1) na grace (2) a sweep skončí jako Stale.
- **Scénář B:** běžné pořadí, leader flat, pak follower flat. Když čtení trvá déle než zbytek 2s grace, epocha přejde z grace (2) na resolved (3) a sweep skončí jako Stale.
- **Výsledek:** nohy `working`, 0 cancelů, ARMED, `lastError` null, žádný audit. Stejný typ jako incident 24. 8. (osiřelý stop otočí flat účet do protipozice).
- **Důkaz:** testy L7 a L10. Instrumentace bariéry ukázala `epoch:[…,3,"resolved",…,2]`.
  - Před opravou L7 obě nohy zrušil.
  - Před opravou L10 skončil hlasitým fail-closed (deadline 1500 ms).
- **Oprava:** vyřadit generaci epochy z bariéry, nanejvýš kontrolovat otevření nové epochy.
- **Jistota:** test.

### N2 — VYSOKÁ (regrese): nový vstup leadera nechá nohy staré epizody pracovat do další epizody
- **Kde:** `:6561-6567` a `:9306` (invalidace při příchodu vstupu leadera), bariéra `:1697`.
- **Scénář:**
  1. Follower flat, sweep čte.
  2. Leader vloží nový limit OSO a starý sweep se zahodí.
  3. Followerovi se pošle nové OSO, staré SL/TP dál pracují.
  4. Když nová epizoda skončí fillem ochranné nohy, sweep s hintem vezme jen nohy této epizody a „uspěje“. Staré nohy zůstanou natrvalo.
- **Důkaz:**
  - L1: nové OSO odesláno, staré nohy `working`, ARMED, žádná chyba.
  - L4: po vystopování druhé epizody jsou staré nohy dál `working`, ARMED.
  - Před opravou obě nohy zrušil.
- **Proč to není nutné:** kandidáti jsou přesná ID ze snapshotu z doby startu, takže nohy nové epizody tam být nemohou. Invalidace nic nechrání.
- **Oprava:**
  - Staré nohy (přesná ID) zrušit i po novém vstupu leadera.
  - Nebo nový vstup followera pro daný účet+symbol podržet, dokud sweep nedoběhne.
  - Při Stale nikdy nekončit tiše (viz N3).
- **Jistota:** test.

### N3 — VYSOKÁ (regrese): jakákoli změna generace způsobí tichý konec
- **Kde:** `:1689-1692` a `:2070`. Blokátory lifecycle na `:6075`, `:6092` a `:9105` vidí jen `sweepingProtectiveLegs`, které se plní až na `:1933`, po fázi čtení.
- **Scénář:** během čtení sweepu přijde cokoli z tohoto:
  - ruční DISARM,
  - `failClosed` jiného účtu,
  - změna konfigurace,
  - reconnect,
  - ARM.
- **Výsledek:** Stale, `return`. Žádný audit, žádná chyba, nic se znovu nezařadí.
  - Nohy nad flat účtem dál pracují.
  - `autoFlattenCopies` nad flat účty nic neruší (`if (!hasExposure) return true`).
  - `.catch` navíc spolkne i skutečné selhání (například „broker stále hlásí 2 pracovní nohy“), pokud bariéra mezitím přestala platit.
- **Rozpor v kódu:** komentář na `:7725-7730` říká, že cancel „smí proběhnout i po DISARM“.
- **Důkaz:** L2 (DISARM) a L3 (updateGroup) nechají nohy `working` bez auditu. Před opravou je obě zrušily.
- **Oprava:**
  - Při Stale s pracovní nebo nejasnou nohou zařadit nový sweep s aktuálními generacemi.
  - U kill switche zapsat audit a trvalou značku, která blokuje ARM.
  - Do blokátorů lifecycle přidat `flatSweepJobs.size > 0`.
- **Jistota:** test.

### N4 — VYSOKÁ/STŘEDNÍ (regrese): otrávený durable klíč `flat-sweep:<group>:<orderId>`
- **Kde:** `:1799` (`if (existing) return existing`), `:1813`, `:1824` (waive s `neverSent`), `:1781`.
- **Scénář:**
  1. Sweep uloží `sending`.
  2. Pomalé `listPositions` před zápisem.
  3. Během něj Stale (nový vstup, epocha, DISARM) a záznam se označí `waived`, `neverSent`.
  4. Každý další sweep záznam najde a jen dohledává. Cancel se už nikdy nepošle.
  5. `resolveCancelStatusLookup` záznam překlopí z waived na `unknown` (stuck), dohledání vrátí working a skupina se vypne (DISARM).
  6. Cesta s hintem otrávené nohy nevidí vůbec.
- **Totéž nastane:**
  - po pádu workeru mezi uložením `sending` a cancelem,
  - po `timeout-before-cancel`, kdy dohledání potvrdí, že noha stále pracuje.
- **Důkaz:** L5.
  - L5a: `["flat-sweep:cancel-lens:mo-2","waived",true,1]`.
  - L5b: nohy mo-2/mo-3 mají 0 cancelů a jsou `working`, záznam je `unknown` s `neverSent`, `Flat sweep nedokončen`.
  - Před opravou nohy zrušil.
- **Oprava:** `neverSent` záznam smí dostat nový odeslaný pokus. Po autoritativním dohledání, které potvrdí working, povolit právě jeden nový cancel pod novým klíčem (pokus N+1). Po dohledání to není slepé opakování a cancel nemůže zdvojit expozici.
- **Jistota:** test.

### N5 — VYSOKÁ (starší chyba, není regrese V13): sweep zruší Suspended SL/TP čekajícího OSO vstupu
- **Kde:** kandidáti `:1907-1908`, filtr `:1927`. `isOpenOrderStatus('pending')` je true, protože Tradovate `Suspended` se mapuje na `pending` (`tradovateMapping.ts:280`). Rekonciliační cesta `:8900-8916` má stejný problém.
- **Scénář:** follower je flat a má čekající OSO nové epizody. Sweep bez hintu (flat přechod nebo rekonciliace po reconnectu) zruší obě ochranné nohy. Samotný vstup zůstane working a po naplnění je follower bez SL/TP.
- **Důkaz:** L5b, mo-4 (vstup) `working`, mo-5/mo-6 `canceled`. Stejné chování i před opravou.
- **Oprava:** vyřadit nohy OSO, jejichž vstup není autoritativně vyplněný.
- **Jistota:** test. Spouštěcí cesta přes rekonciliaci jen ze čtení.

### N6 — STŘEDNÍ (regrese): selhání exit-only sweepu nově spouští auto-close
- **Kde:** `:7327-7336` a `:2079`. Před opravou šlo o `failClosed(…, { autoClose: false })`, nyní se použije výchozí auto-close.
- **Scénář:** jeden pomalý nebo nejasný exit-only sweep může zavřít pozice ostatních followerů uprostřed obchodu.
- **Jistota:** čtení.

### N7 — NÍZKÁ
- **Blokace vstupů během sweepu je prakticky mrtvá (`:1368`).** Stejný příchod vstupu leadera ji před odesláním vstupu followera smaže (`:6564`). Tvrzení v commit message neodpovídá kódu.
- **Požadavek rekonciliace se může ztratit (`:2038-2042`).** Když už běží sweep s hintem, širší „trvalá“ povinnost z rekonciliace se jen sloučí a zahodí. Důsledek je jen zpoždění, ARM zůstává blokovaný.
- **Zavádějící audit (`:2002-2017`).** Všechny nohy dostanou `kind:'canceled'`, i když je sweep nerušil (L9).
- **Jistota:** čtení a test L9.

---

**Ověřeno bez nálezu:**
- **Jiný symbol:** filtr `request.symbol` a `reservation.symbol` spolu s kontrolou pozice podle symbolu drží.
- **Ruční příkazy:** kandidáti jsou jen ID z outboxu a exit-only rezervace, ruční příkazy do nich nespadnou.
- **Bariéra před cancelem:** je na jediném místě zápisu (`:1833-1838`), synchronně a po uložení `sending`.
- **Druhý cancel od sweepu:** nevznikne, durable klíč to drží (L5 attempts=1, V13 test).
- **Paralelní cancel runneru a sweepu na stejnou nohu:** možný, ale platilo to i před opravou (runner nekontroluje stav) a je neškodný.
- **Nová epizoda:** do cancelu se nedostane nic z ní, s výjimkou čekajícího OSO (N5).

**Mimo čočku:** `retryFlatSweepRead` (`:1705-1720`) opakuje každých 100 ms bez zpomalování. Při 429 hrozí zesílení s hodinovým breakerem.

**Celá sada:** `npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier` na exportu 1a59237: 123 souborů, 1476 prošlo, 2 selhaly. Obě selhání jsou známá regrese V12: copierChaosScenarios „4 rychlé vstupy“ a copierManagementOnly „13→14→15→18“.

## Čočka blocking

**V13 (commit 1a59237), čočka blokace a fail-closed: 10 nálezů, z toho 4 vysoké**

Oprava sice odstraní dnešní DISARM, ale přidává nové cesty:
- Kopírka může vypnout celou skupinu a zavřít followera uprostřed obchodu, což je chyba stejného druhu jako V13.
- Kopírka může mlčky ztratit vstup followera.
- Kopírka může mlčky nechat working ochranné nohy na flat followerovi, bez chyby a bez auditu.

Každý scénář N1–N7 jsem pustil proti novému commitu i proti stavu před opravou (1a59237^). Na 1a59237^ testy procházejí, takže jde o regrese. N8–N10 mají jistotu z čtení kódu. Worktree jsem neměnil, brokera ani agenta jsem nevolal.

### N1 — VYSOKÁ: rozpracovaný cancel sweepu zablokuje všechny zápisy skupiny a může zavřít followera v obchodě
- **Kde:**
  - `services/copierRuntimeController.ts:1797–1846` (durable záznam `flat-sweep:*` ve stavu `sending` → `unknown`),
  - `:2125`, `:2138` (`hasStuckOutbox`),
  - `services/copierRunner.ts:1391–1398`, `:1732–1737`,
  - `services/copierCancelOutbox.ts:188–203`.
- **Scénář:**
  1. Follower A je flat, sweep ruší jeho nohy (záznam je `sending`/`unknown`).
  2. Mezitím leader posune SL (nebo vystoupí, vstoupí, zruší ochrannou nohu).
  3. Brána `stuck-outbox` započítá záznam sweepu a zablokuje zápisy pro všechny followery a symboly.
  4. Audit `blocked` → `failClosed` → DISARM a auto-close.
  5. Sweep je pak „stale“ a záznam zůstane viset. Znovu-ARM odmítne: „Copier má nevyřešený outbox“.
  6. Samo se to vyřeší jen restartem (`recoverOutbox`), ručním zásahem, nebo dalším flat přechodem téhož účtu a symbolu. Ten ale vyžaduje ARM.
- **Důkaz (test):**
  - `zzV13Blokace4`: modify pro followera 300 zablokován, `lastError "Copier fail-closed: stuck-outbox"`, zůstal záznam `unknown`, re-ARM odmítnut.
  - `zzV13Blokace6`: follower 300 je long spolu s leaderem, auto-close mu poslal `Sell Market 1`, leader zůstal v obchodě.
  - Před opravou: modify prošel, kopírka zůstala ARMED.
- **Tím je odpověď na otázku z čočky ano:** exit, SL modify i cancel ochranné nohy se blokují, a to globálně, ne jen pro účet a symbol.
- **Návrh:**
  - Záznamy `flat-sweep:*` živého jobu nepočítat do globální brány (nebo je vést zvlášť a blokovat jimi jen vstupy téhož účtu a symbolu).
  - Po stale abortu až po odeslání dohledat stav nezávislým read-only lookupem, bez bariéry.
- **Jistota:** test.

### N2 — VYSOKÁ: bariéra podle generace epochy mlčky zahodí sweep při běžném výstupu
- **Kde:** `:1678–1683`, `:1698`, `:2070`.
- **Scénář:**
  - Generace epochy leadera se zvedne už při běžném výstupu: přechod open→grace při leader flat a grace→resolved po 2 s.
  - Když follower flat přijde před leader flat, nebo sweep přesáhne konec grace, bariéra vyhodí `StaleFlatSweepError` a sweep skončí tiše (`return`).
  - Za podmínek dnešního incidentu (REST ~4,8 s) by se tedy sweep nedokončil, jen by zmizel.
- **Důkaz (test):**
  - `zzV13Blokace7` (čtení 900 ms, grace 300 ms) i `zzV13Blokace8` (follower flat 20 ms před leaderem, čtení 100 ms): nohy zůstaly `working`, `armed:true`, `lastError:null`, audit prázdný.
  - Před opravou byly nohy zrušené.
- **Návrh:**
  - Fencovat jen `epoch.id` (nová epizoda), ne `generation`.
  - Stale ukončení auditovat a povinnost sweepu držet durable, případně ho přeplánovat.
- **Jistota:** test.

### N3 — VYSOKÁ: sweep naplánovaný až po ingressu nového vstupu leadera zablokuje vstup followera
- **Kde:** `:1363–1370`, `:2056`, `:2066`, `:6561–6568`, `:9305`.
- **Scénář:**
  1. Ve frontě je backlog. Leader flat, follower flat a okamžitý nový vstup leadera projdou ingressem dřív, než se zpracuje follower flat.
  2. Invalidace při ingressu proběhne ještě bez jobu. Job pak převezme už novou generaci a nastaví blokaci.
  3. Dispatch vstupu dostane `CopierDispatchRevokedError`. Vstup se označí jako `skipped`, což není kritické.
  4. Follower mlčky vynechá celý obchod, kopírka zůstane ARMED bez chyby.
  5. U exitu leadera pak přijde „nevysvětlená divergence“ → fail-closed.
- **Důkaz (test):**
  - `zzV13Blokace9`: realistický burst, terminální nohy jako dnes, nulová latence čtení. Výsledek `copied:[]`, `skipped:["dispatch-revoked:flat-sweep-in-progress:200:MNQU6"]`.
  - `zzV13Blokace2`: navazující exit → DISARM.
  - Nastane i bez latence čtení, protože blokaci drží závěrečný `processor.mutate` / commit sweepu.
  - Před opravou: `copied:[["Buy","Market"]]`.
- **Návrh:**
  - Generaci ingressu razítkovat na událost a job ji brát z ingressu spouštěcí follower události, takže bude hned stale.
  - Nebo při dispatchi vstupu sweep invalidovat místo revoke vstupu.
  - Pokud blokace zůstane, musí být kritická, ne `skipped`.
- **Jistota:** test.

### N4 — VYSOKÁ/STŘEDNÍ: `safetyGeneration` v bariéře ruší risk-redukující sweep při DISARM a jakémkoli fail-closed
- **Kde:** `:1689`, `:2070`.
  - `invalidateReconciliation` zvedá `safetyGeneration` a volá se na 21 místech (failClosed, ARM, emergency flatten, OAuth preflight…).
  - Kód u `:7722` přitom slibuje, že je to „risk-redukující cancel, který smí proběhnout i po DISARM“.
- **Scénář A:** DISARM během sweepu → nohy zůstanou working, žádný audit.
- **Scénář B:** vyčerpaný budget účtu 200 → failClosed → rozběhnutý sweep účtu 300 se mlčky zahodí a jeho nohy zůstanou.
- **Důkaz (test):**
  - `zzV13Blokace` B2: nohy `["working","working"]`, cancel `[0,0]`, audit prázdný.
  - `zzV13Blokace` B3: `legs300` `working` / `working`.
  - Před opravou se v obou případech rušilo.
  - Zmírnění: detektor otočení (`failOnExactProtectiveReversal`) reaguje, ale až po fillu.
- **Návrh:** u nohou ukončené epizody nefencovat `safetyGeneration`, jen kill switch, stop/shutdown a fence nové epizody. Minimálně stale auditovat, držet durable povinnost a vyžádat reconcile.
- **Jistota:** test.

### N5 — STŘEDNÍ: REST pozice ≠ 0 při kontrole před zápisem skončí tiše
- **Kde:** `:1820`, `:2070`.
- **Scénář:** stream hlásí flat, REST hlásí +1. Kód vyhodí `StaleFlatSweepError`: bez fail-closed, bez auditu, nohy dál working.
  - Nerušit nohy je správně, mlčet ale ne. Divergence stream vs. REST má být halt.
- **Důkaz (test):** `zzV13Blokace` B5: `armed:true`, `lastError:null`. Před opravou: fail-closed.
- **Návrh:** `failClosed({autoClose:false})` a `requireReconciliation`.
- **Jistota:** test.

### N6 — STŘEDNÍ: budget 7 s se spotřebovává i čekáním na sdílený processor
- **Kde:** `:1705–1722`, zápisy přes `processor.mutate` (`:1774–1795`), `:2051`.
- **Scénář:** `processor.mutate` sweepu čeká za pomalým dispatchem jiné události, například SL modify druhého followera při pomalém REST. Budget vyprší → „pre-write pozice … celkový deadline“ → DISARM a nohy zůstanou.
- **Důkaz (test):** `zzV13Blokace5` (budget 1 s, modify 1,5 s): `armed:false`, nohy working. Před opravou: OK a zrušeno.
- **Poznámka:** v produkci k tomu je potřeba držení processoru přes 7 s, jako za podmínek 17. 9.
- **Návrh:** počítat budget jen na broker I/O, zápisy se samostatným limitem.
- **Jistota:** test.

### N7 — STŘEDNÍ: rychle selhávající čtení se opakuje každých 100 ms po celý budget
- **Kde:** `:1720`.
- **Důkaz (test):** B4: 20 volání za 1 s pro 2 ID. V produkci to je ~70 volání na ID za 7 s, paralelně přes ID a účty. Před opravou 1 volání.
- **Riziko:** při 5xx nebo chybách transportu hrozí 429 a hodinový breaker, který zablokuje i nouzový Flatten (rozhodnutí 26. 8.).
- **Návrh:** exponenciální backoff, strop 2–3 pokusy na ID, omezený souběh na účet.
- **Jistota:** test.

### N8 — STŘEDNÍ: selhání exit-only sweepu teď spouští auto-close
- **Kde:** `:7327–7336` → `:2079`.
- **Scénář:** dřív exit-only selhání vypnulo kopírku s `{autoClose:false}` (obě cesty v odstraněném kódu). Teď jde přes výchozí `failClosed`. Při flat let-run/cut followerovi a ostatních followerech v obchodě zavře auto-close (scope „followers“) všechny kopie.
- **Návrh:** jobům z exit-only cesty nést `autoClose:false`.
- **Jistota:** čtení kódu, bez testu.

### N9 — NÍZKÁ: nový vstup leadera zahodí starý sweep bez náhrady
- **Kde:** `:6561–6568`.
- **Scénář:** working nohy staré epizody přežijí celou novou epizodu. Zruší se až při dalším flat. Před opravou se zrušily ještě před dispatchem nového vstupu.
- **Návrh:** read-only ověřit přesná ID nohou staré epochy a zrušit jen ta.
- **Jistota:** čtení kódu, plus V13 test sám tvrdí cancel `[0,0]`.

### N10 — NÍZKÁ: chybí trvalé opakování sweepu po fail-closed a stale ukončení se neaudituje
- **Scénář:** trvalé opakování sweepu po fail-closed chybí, přestože je v bodě 4 specifikace. Stale ukončení se nikde neaudituje. Vše závisí na reconcile při dalším ARM.
- **Jistota:** čtení kódu.

### Co jsem ověřil jako v pořádku
- **Trvalost blokace:** blokace sama není trvalá. `finally`, invalidace ingressem i `stop()` ji uvolní.
- **Co blokace kryje:** týká se jen `oso` a `place` zvyšujícího expozici. Exity, SL a cancel blokuje až N1, ne blokace samotná.
- **Vyčerpaný budget:** vede k fail-closed bez duplicitního cancelu. Klíč je durable pro každé brokerOrderId, nejistý výsledek se nikdy neposílá znovu.
- **Pomalý účet:** neblokuje sweep jiného účtu, jeho fail-closed ale ostatní zahodí (N4).
- **Změna konfigurace, kill switch, reconnect:** `updateGroup` kopírku vypne. Kill switch nepošle cancel, což odpovídá zmrazení. Po reconnectu reconcile znovu naplánuje sweep pro working nohy, ale záznam nechaný po stale abortu zůstane viset (N1).

### Sada kopírky v exportu
`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier` → 121/123 souborů, **1476 prošlo, 2 selhaly**. Obě selhání jsou známá regrese V12: copierChaosScenarios „4 rychlé vstupy“ a copierManagementOnly „13→14→15→18“.

### Soubory
Exporty v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- `v13-blokace/` — commit 1a59237
- `v13-blokace-pre/` — 1a59237^

Moje testy (v každém exportu je jen podmnožina):
- `v13-blokace/tests/`: `zzV13Blokace.test.ts` a `zzV13Blokace2.test.ts` až `zzV13Blokace9.test.ts`
- `v13-blokace-pre/tests/`: `zzV13BlokacePre.test.ts`, `zzV13Blokace3.test.ts` až `zzV13Blokace9.test.ts` (`zzV13Blokace4` až `9` jako totožné kopie nebo s úpravou čtení na `listOrders`)

Výstup sady: `v13-blokace-suite.txt`.

## Čočka concurrency

Našel jsem 7 problémů. Ve dvou případech hrozí přímo ztráta peněz: po flat followera zůstanou jeho ochranné nohy (SL/TP) pracovat u brokera a nikdo to nehlásí. Oproti stavu před opravou (1a59237^) je to regrese.

Ověřoval jsem na exportech `scratchpad/v13-soubeh` (1a59237) a `scratchpad/v13-soubeh-pre` (1a59237^). Sondy T1–T9 jsou v `tests/zzV13Soubeh.test.ts` v obou exportech. Jen vypisují výsledek a vždy projdou, takže je nečti jako regresní testy. Všechny řádky níže jsou z commitu 1a59237.

## N1 — KRITICKÁ [peníze]: sweep se při běžných změnách stavu tiše zahodí a pracovní nohy nad flat followerem zůstanou
- **Kde:** `services/copierRuntimeController.ts:1685-1699` (bariéra kontroluje i `exposureEpochGeneration` a `safetyGeneration`), `:2070` (tichý `return` při Stale nebo nepotvrzené bariéře). Generaci epochy zvyšuje `services/copierLeaderFlatGuard.ts:379` (leader flat → grace) a `:441` (guard resolve po 2 s).
- **Scénáře:**
  - T6: follower flat, sweep čte stav noh 300 ms, mezitím se zpracuje flat leadera → generace +1 → Stale → konec.
  - T7: leader flat, pak follower flat, čtení trvá 2,5 s, guard se po 2 s vyřeší → Stale.
  - T9: DISARM nebo libovolný jiný fail-closed během čtení.
  - T3: nový leader entry během kontroly pozic těsně před cancelem.
- **Důkaz (test):** po opravě jsou nohy `['working','working']`, 0 cancelů, `armed: true`, `lastError: null`, žádný audit. Před opravou jsou obě nohy `canceled`.
  - Jde přesně o třídu incidentu z 24. 8.
  - Test V13 „4,8 s projde“ nikdy nedá leadera do flat, takže tuhle cestu nepokrývá.
  - Test V13 „DISARM zablokuje pozdní cancel“ tuto regresi přímo zakódoval. Dřív přitom platilo, že risk-redukující cancel smí proběhnout i po DISARM (komentář u ř. 7704-7710).
  - Chybí i požadavek z review „trvalé opakování sweepu“.
- **Oprava:**
  - Zápis blokovat jen při nové expozici na daném účtu a symbolu: ingress entry pro symbol, nová epocha s jiným id, pozice ≠ 0, změna členství. Ne při +1 generace v rámci téže epochy a ne při DISARM.
  - Při Stale nic nezahazovat. Buď naplánovat nový read-only job s novým budgetem, nebo fail-closed s auditem, pokud byla vidět pracovní noha.
  - Zavést trvalou povinnost sweepu pro účet a symbol, kterou splní až reconcile.
- **Jistota:** ověřeno testem (T3, T6, T7, T9).

## N2 — VYSOKÁ: rozpracovaný cancel ze sweepu vypne celou skupinu
- **Kde:**
  - `:1796-1846` zapisuje trvalý záznam `flat-sweep:*` se stavem `sending`/`unknown`.
  - `hasStuckOutbox` (`:2138`) jde do `stuckOutbox` v branách u ř. 4620, 6386, 6470, 8075, 8234, 8331, 8373, 8490.
  - `copierRunner.ts:1398` a `copierRiskGate.ts:142` z toho udělají `stuck-outbox`, tedy `blocked`, což je kritický audit a fail-closed.
- **Scénáře:**
  - T1: cancel ze sweepu letí 300 ms a leader mezitím vstoupí znovu.
  - T2: během letícího cancelu leader zruší svůj stop.
- **Důkaz (test):**
  - Po opravě: `armed: false`, `lastError: "Copier fail-closed: stuck-outbox"`, nový vstup se nezkopíroval nikomu. V T1 navíc druhá noha zůstala `working` (`waived neverSent`).
  - Před opravou: skupina ARMED, vstup zkopírovaný, obě nohy zrušené.
  - Tvrzení „blokace jen pro dotčený account+symbol“ tedy neplatí. Ve stejném okně to rozbije i izolaci breached followera.
- **Oprava:** záznamy `flat-sweep:*` nepočítat do skupinového `stuck-outbox`, dokud jejich job žije. Nejistý stav omezit jen na daný účet a symbol.
- **Jistota:** ověřeno testem (T1, T2).

## N3 — VYSOKÁ: cancel ve stavu `unknown` během běhu workeru nikdo nevyřeší
- **Kde:**
  - `:2070`: při Stale po odeslání cancelu se nedělá žádný lookup.
  - `:1966-1986`: finalizace uzavře jen `cancel` + `filled`, ne `canceled`.
  - `:2003`: noha se pak přidá do `sweptProtectiveLegs` a sweep se k ní už nevrátí.
  - `:1842`: `markCancelUnknown` se použije na jakýkoli aktuální záznam, takže může přepsat `confirmed` zpět na `unknown`, když se dva joby pro stejný klíč překryjí.
- **Scénář (T1):** noha `mo-2` je u brokera `canceled`, ale záznam zůstane `unknown`.
- **Důsledky:**
  - každá další leader událost skončí jako `stuck-outbox` a vypne skupinu;
  - ARM hlásí „nevyřešený outbox“;
  - blokuje změnu konfigurace (`:9095`), automatickou obnovu po reconnectu (`:6053`), uvolnění ručního cutu a selektivní Flatten followera (`:5036`);
  - vyřeší to až restart nebo ruční waive.
- **Oprava:**
  - Ve `finally` i po Stale udělat read-only lookup záznamů, které tento job posunul do `sending`/`unknown`.
  - Ve finalizaci potvrdit `unknown` při stavu `canceled` nebo `rejected` bez fillu.
  - `markCancelUnknown` povolit jen ze stavu `sending`.
- **Jistota:** test (T1); překrytí dvou jobů jen čtením.

## N4 — VYSOKÁ [peníze]: klíč cancelu platí jen jednou, takže nohu už nikdy nic nezruší
- **Kde:** `:1753`, `:1799`, `:1813`. Klíč `flat-sweep:${groupId}:${brokerOrderId}` nemá číslo pokusu ani epizodu.
- **Chování:** jakmile záznam existuje, sweep už cancel nepošle. Týká se to i:
  - `waived` s `neverSent` (cancel nikdy neodešel),
  - `unknown` po timeoutu,
  - záznamu, který uživatel ručně waivnul.
  Sweep pak jen udělá lookup, přepne `waived` zpět na `unknown` a vypne skupinu.
- **Důkaz (test):**
  - T3: Stale před zápisem vede na `waived neverSent`. Další flat pak má 0 cancelů, nohy zůstanou `working` a skupina se vypne s „broker stále hlásí 2 pracovních…“.
  - T5: restart workeru po uloženém `sending` (cancel neodešel). Obnova po startu dá `unknown`, reconcile nohy nikdy nezruší a ARM hlásí „nevyřešený outbox“. Před opravou reconcile po restartu obě nohy zrušil.
- **Oprava:**
  - Záznam `neverSent`/`waived` nesmí blokovat nový pokus.
  - Nový pokus podle čerstvého autoritativního stavu „working“ dát pod nový klíč s číslem pokusu. Stará verze to výslovně dovolovala: „další pokus smí vzniknout jen z nového snapshotu“.
  - Opakovaný cancel po autoritativním lookupu je rozhodnutí o politice. Opakovaný cancel po ověřeném `neverSent` je jednoznačně bezpečný.
- **Jistota:** ověřeno testem (T3, T5).

## N5 — STŘEDNÍ až VYSOKÁ: blokace sweepu zahodí kopii vstupu, pokud leader vstoupil těsně před jeho startem
- **Kde:** `:1362-1370` (blokace v dispatchi), `:2056` (sweep si bere generaci ingressu až ve chvíli naplánování).
- **Scénář (T4):** flat followera a nový leader entry dorazí do ingressu těsně po sobě, dřív než eventTail zpracuje flat.
  - Sweep si vezme už navýšenou generaci a blokuje.
  - Dispatch vstupu skončí `dispatch-revoked:flat-sweep-in-progress:200:MNQU6` a vstup se jen tiše zaznamená jako `skipped`, skupina zůstane ARMED.
  - Po fillu leadera: „follower 200 má autoritativně pozici 0 … očekáváno 1“, tedy DISARM.
  - Totéž hrozí u OSO dispatche odloženého korelačním oknem (výchozí 1 500 ms).
- **Důkaz (test):** před opravou se vstup zkopíroval (`placedEntry: 1`).
- **Oprava:** zápis nového vstupu má zneplatnit sweep, ne sweep vstup. Případně při naplánování nezapínat blokaci, když je pro symbol přijatý, ale ještě nezpracovaný leader entry.
- **Jistota:** ověřeno testem (T4).

## N6 — STŘEDNÍ: po restartu jeden flat přečte celou historii noh a hrozí 429
- **Kde:**
  - `:1907-1915` a `:1950`: bez nápovědy „ochranná noha se vyplnila“ se čtou všechny ochranné nohy účtu a symbolu z trvalé historie, a to dvakrát paralelně.
  - `:1720`: každé čtení se při chybě opakuje co 100 ms.
  - `sweptProtectiveLegs` žije jen v paměti (maže se i u ř. 9263) a outboxy se nijak neprořezávají.
  - Sweepy běží souběžně přes všechny followery.
- **Kdy nastane:** flat bez této nápovědy, tedy kopírovaný exit, breach, sideline nebo reconcile.
- **Důkaz (test T8):** 30 historických OSO záznamů → 124 cílených čtení pro jednoho followera. Před opravou 2× `listOrders`.
  - U Tradovate nejsou nohy ze starších session ve streamu, takže jde o REST `/order/item`.
  - U 12 followerů to je přes 1 000 requestů naráz. 429 zapne hodinový breaker, který zablokuje i nouzový Flatten. Review před tím výslovně varovalo.
- **Oprava:** omezit kandidáty na aktuální epochu nebo durable ne-terminální nohy, omezit souběh, v postkontrole číst jen dříve pracovní nohy, použít backoff a trvale si ukládat, co už bylo zameteno.
- **Jistota:** počet čtení z testu (T8); dopad na 429 odhadnutý z kódu.

## N7 — NÍZKÁ: pohlcená diagnostika a nepřesné stráže
- **Kde:** `:2070`, `:1942`.
- **Co se děje:**
  - Skutečná chyba (vyčerpaný budget, „broker stále hlásí pozici“) se tiše zahodí, pokud se mezitím změnila kterákoli generace. U více followerů tak první fail-closed utiší audity ostatních.
  - `finally` staršího Stale jobu smaže ze `sweepingProtectiveLegs` ID, která si tam přidal novější job pro stejný klíč.
  - Stráže u ř. 6075, 6092 a 9105 nevidí sweep ve fázi čtení (neberou v úvahu `flatSweepJobs`).
- **Jistota:** čtení kódu.

## Co bez nálezu
- Deadlock jsem nenašel. Sweep čeká jen na procesor, eventTail na sweep nečeká a `waitForIdle` se korektně ukončí.
- Dva souběžné běhy pro stejný účet a symbol vzniknou jen po zneplatnění ingressem. Cancel pošle vždy nejvýš jeden, protože durable záznam brání druhému odeslání. Riziko je jen v tom přepisu popsaném v N3.

## Celá sada kopírky
`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier`: 123 souborů, 1476 prošlo, 2 selhaly. Obě selhání jsou známá regrese V12: copierChaosScenarios „4 rychlé vstupy“ padá stejně i na 1a59237^ („follower close Market příkaz nebyl vytvořen“) a copierManagementOnly „13→14→15→18“. Nové testy V13 (`copierFlatSweepV13.test.ts`) prošly, ale leader-flat epochu, souběh s rozpracovaným cancelem ani restart nepokrývají.

Soubory v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/`:
- v13-soubeh/tests/zzV13Soubeh.test.ts
- v13-soubeh-pre/tests/zzV13Soubeh.test.ts