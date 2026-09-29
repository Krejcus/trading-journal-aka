# Adversariální review UI větve claude/copier-ui-fixes-20260928

## Čočka control-safety

**ČOČKA OVLÁDÁNÍ: review větve claude/copier-ui-fixes-20260928 (6a9cc47..a9bba83)**

Našel jsem 1 vysoký, 2 střední a 2 nízké nálezy. Nejzávažnější: se zastaralým stavem jdou dál odeslat změny konfigurace a přepnutí followera. ARM je ale správně zablokovaný. Worktree jsem neměnil. Důkazní testy jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/ui-review-ovladani/stale-controls.test.ts` (5/5 prošlo). Existující testy větve (7 souborů, 43 testů) procházejí.

---

### F1: VYSOKÁ. Zastaralý (retained) stav dál povoluje změny konfigurace, přepnutí followera i násobek (regrese)

**Kde:**
- `components/TradovateLiveDesk.tsx:845-850`: retained větev drží `agentStatus`.
- `TradovateLiveDesk.tsx:735-758`: `commandAdapter` se odvozuje jen z `executionGroup`, čerstvost nekontroluje.
- `TradovateLiveDesk.tsx:1111`: adaptér se předává vždy.
- `components/LiveCopyTradeOverview.tsx:1381-1388`: `runCommand` nemá bránu na `copierStatusPending`.
- `LiveCopyTradeOverview.tsx:1902` a `2055`: `onFollowerEnabled` je podmíněný jen `commandAdapter`.
- `LiveCopyTradeOverview.tsx:1695-1703`: kompaktní `onMultiplier` volá `runCommand` přímo.
- Stejně neošetřené jsou editor, šablony a odebrání nedostupného followera (vše přes `saveGroup` → `update-group`).

**Scénář:**
1. Telefon se vrátí z pozadí a čtení relay selže (výpadek mobilní sítě, Vercel 5xx) nebo je heartbeat starší než 10 s.
2. `markAgentStatusStale` se provede, ale `agentStatus` zůstane. Zůstane tedy i `executionGroup` a `commandAdapter`.
3. UI ukazuje „Neověřeno“, přitom přepínač followera, násobek, editor i šablona dál odesílají příkazy přes relay.
4. Konkrétní škoda: zastaralé `copierArmed=false`, ale skutečně je ARM (zapnuto mezitím z desktopu). `confirmArmedGroupChange` ani list násobku nevaruje. Worker změnu konfigurace provede přes DISARM uprostřed obchodu, tedy přesně incident V1 z 28. 9. 08:50.
5. `update-group` je navíc plná náhrada skupiny bez základní revize. Editor postavený na zastaralém `runtimeGroup` tak může přepsat novější konfiguraci (lost update).
6. Potvrzovací dialog navíc tvrdí „Execution adaptér je připojen…“ (`:6380`).

**Důkaz:**
- Před změnou (6a9cc47, `TradovateLiveDesk.tsx:726`) se `setAgentStatus(active?.remote?.status ?? null)` provedlo vždy, takže bez připojeného relay byl stav `null` a adaptér neexistoval.
- Scratch test: s `copierStatusPending:true, runtimeAvailable:false` se vykreslí aktivní `role="switch"` s textem „Vypnout kopírování na účet Follower DEMO“ (není `data-locked`) i tlačítko `aria-label="Násobek 1×, změnit"`.

**Oprava:**
- V `commandAdapter.execute` (Desk) odmítnout každý příkaz kromě rizika snižujících (`flatten-group`, `flatten-account`, `flatten-follower-trade`), pokud `!armStatusRef.current.fresh`.
- V Overview při `copierStatusPending` nepředávat `onFollowerEnabled` ani `onMultiplier` a zablokovat uložení v editoru a šablonách s hláškou „stav se ověřuje“.
- `apiReady` v dialogu odvozovat z `runtimeAvailable`.

**Jistota:** vysoká.

---

### F2: STŘEDNÍ. Čerstvost relay stavu závisí na hodinách klienta; klient, jehož hodiny jdou pozadu, zůstane trvale „Neověřeno“ (regrese, fail-closed)

**Kde:** `lib/copierForegroundPoller.ts:11` (`age >= 0`) spolu s `TradovateLiveDesk.tsx:826-827` (`observedAt = Date.parse(lastSeenAt)` v čase DB serveru, porovnává se s `Date.now()` klienta).

**Scénář:**
1. Heartbeat se zapíše v čase T (DB `now()`). Klient ho přečte za d ≈ 0,1–2,5 s.
2. Jdou-li hodiny klienta pozadu o víc než d, vyjde `age = d + skew < 0`. Stav se přijme s `readHealthy=false`, takže `runtimeAvailable=false`.
3. Při posunu kolem 0,3–2 s stav přeskakuje mezi čerstvým a neověřeným (přepínač bliká, ARM občas selže s „Čekám na čerstvý stav“). Nad zhruba 3 s nejde ARM ani uložit Risk nikdy, přestože server hlásí `connected`.
4. Týká se hlavně desktopu na relay (Windows PC s posunutými hodinami).

**Důkaz:**
- Scratch test: `isCopierStatusFresh(now+200, now, true) === false`.
- Před změnou byla čerstvost řízená časovačem od přijetí a na hodinách nezávisela.

**Oprava:** server ať vrací `ageMs` (má ho: `connected` počítá stejně) a klient ať použije `observedAt = receivedAt − ageMs`. Minimálně povolit toleranci záporného stáří (třeba 5 s).

**Jistota:** vysoká pro mechanismus, střední pro četnost v praxi.

---

### F3: STŘEDNÍ. Při neověřeném stavu se ostatní skupiny tváří jako ověřeně VYPNUTÉ a zapisují „potvrzený“ stav do retence

**Kde:**
- `LiveCopyTradeOverview.tsx:1890` a `1978` (`statusPending = copierStatusPending && (executionGroupId == null || selected)`).
- `:2628` (titulek „Kliknutím zapnout copier naostro.“).
- `hooks/useCopierPowerDisplay.ts:15` (zápis, když `!pending`).

**Scénář:**
1. Stav je zastaralý, ale `executionGroupId` pochází z retained stavu (A).
2. Skupina B ukáže normální OFF přepínač s popiskem „zapnout naostro“ a do localStorage zapíše B=OFF jako potvrzené.
3. Mezitím mohl worker z jiného zařízení přepnout a zapnout B. Telefon pak B ukazuje jako ověřeně vypnutou.
4. Klik na B nevede k ARM (dobře), ale otevře „Vypnout kopírku bez ověřeného stavu?“. Potvrzení vypne ARM skupiny, na kterou uživatel neklikl.
5. Kód sám uvádí: „neznámý stav proto platí pro všechny řádky“. Před změnou byl `executionGroupId` v neověřeném stavu `null`.

**Důkaz:** scratch test se dvěma skupinami. U vybrané je „Neověřeno“ ×1, u druhé `aria-label="Zapnout kopírovací skupinu"` ×1.

**Oprava:** `statusPending={copierStatusPending}` pro všechny řádky vždy, když `!runtimeAvailable`. Retenci zapisovat jen při `runtimeAvailable`.

**Jistota:** vysoká.

---

### F4: NÍZKÁ. Brzda nepoužije známou retained trasu a může viset na lokálním agentovi

**Kde:** `TradovateLiveDesk.tsx:593-597` a `845-850`.

**Scénáře:**
- **Studený start iOS:** heartbeat je starší než 10 s, takže proběhne retained větev. Ta nastaví `agentTransport='relay'` a `relayConnectionId`, ale ne `lastAgentRouteRef`. DISARM i kill pak skončí chybou „Mac worker zatím nebyl nalezen“, i když je trasa přes relay známá (nativně je `canUseDirectLocalCopierAgent` false). Prakticky jde hlavně o okna probouzení Macu.
- **Nekonzistentní trasa:** retained větev přepisuje transport a spojení i tehdy, když `acceptAgentStatus` stav odmítne. Následný čerstvý ACK z brzdy pak na 15 s vede ARM a konfiguraci na jiné, možná mrtvé spojení. Je to fail-closed, jen s časovým limitem a nejasnou hláškou.
- **Zaseknutý busy:** `agentClient.execute` nemá timeout. DISARM přes `lastAgentRouteRef=local` na zaseklý worker drží `copierTransition` do timeoutu prohlížeče, `requestGroupPower` zatím klik ignoruje a kill switch jde stejnou cestou.

**Oprava:**
- Záložní pořadí trasy: `lastAgentRouteRef ?? (agentTransport ? {agentTransport, relayConnectionId} : null) ?? local`.
- Transport a spojení v retained větvi nastavovat jen po přijetí stavu.
- Pro brzdy dát AbortController zhruba 10 s s hláškou „výsledek neověřen“.

**Jistota:** vysoká pro kód, nízká pro četnost.

---

### F5: NÍZKÁ. Oprava ST13 je neúplná: při stejné revizi se přijme starší ACK (ARM po kill switch)

**Kde:** `lib/copierStatusPollFence.ts:66` (`>=`). ARM, DISARM ani kill revizi nemění.

**Scénáře:**
- **ARM a kill přes relay:** ARM se odešle přes relay, jeho ACK čeká v cyklu po 400 ms. Mezitím uživatel zmáčkne Kill switch, na který server hned vrátí výsledek long-pollem. Kill-ACK dorazí dřív. Pak se přijme ARM-ACK (`armed=true`, `killSwitch=false`, stejná revize) jako čerstvý. UI zhruba 2–4 s ukazuje ZAPNUTO bez kill switche a k tomu toast „Copier je připojený — kopírují se naostro“.
- **Desktop:** DISARM projde přes lokálního agenta, lokální čtení vzápětí selže a retained nebo relay řádek sejmutý před DISARM se přijme.

Fence řeší jen polly, ne pořadí dvou ACK mezi sebou.

**Oprava:** monotónní čítač stavu brány na workeru (třeba `controller.gateSeq`) v každém statusu a řazení podle `(startedAt, revision, gateSeq)`.

**Jistota:** střední (časování závodu).

---

### Poznámky nízké priority (ne regrese)

- Stav z jiného běhu s dřívějším `startedAt` (posun hodin, přesun workeru na VPS) se odmítá až do reloadu, včetně ACK. Server při vráceném startedAt heartbeat odmítá taky.
- `setFreshnessNow` každou 1 s překresluje celý Desk i Overview. Stačí jeden timeout na `observedAt + 15 s`.
- Kill switch je zablokovaný podle zastaralého `killSwitchActive`.

---

### Ověřeno, bez nálezu

- **ARM:** jediná cesta vede přes `armLiveGroup`, kde `prepare()` kontroluje `armStatusRef.fresh`, a to i u re-ARM po Flatten a po potvrzovacích dialozích. `requestGroupPower` při neověřeném stavu nabízí jen DISARM. Retained OFF je `disabled`, retained ON i „Neověřeno“ vedou jen k potvrzení vypnutí.
- **Kill switch:** v TopActionsMenu už nečeká na runtime.
- **Poll fence:** `invalidatePolls` kolem každého příkazu zahodí polly zahájené před ACK. Relay řádek je na serveru monotónní podle `relay_revision` (`complete_v2` ukládá stav po příkazu), takže poll po ACK čte stav po příkazu.
- **Restart workeru:** novější `startedAt` se přijme i s nižší revizí.
- **Změna uživatele:** `statusIdentityRef`, reset refů a klíč retence podle userId. Nanejvýš jeden snímek s cizím stavem.
- **Skrytí okna:** odmítne rozběhnuté čtení a busy se vždy uvolní ve `finally`.
- **Editor:** blokace „missing-worker“ platí jen při čerstvém stavu, jinak jen varuje. Worker si ale spojení bez spárovaného zařízení (jen s bootstrap lease) vůbec nezapíše do manifestu `devices`, takže jeho účty ukáže jako chybějící, i když zatím obchodují. Je to přísnější, ale fail-closed.

## Čočka data-truth

## Review UI kopírky, čočka DATA (6a9cc47..HEAD): 10 nálezů

Na tuhle čočku nejvíc záleží na prvních dvou nálezech. Po jakémkoli selhání plného načtení dat pošle retry během jednoho čekajícího požadavku desítky dalších, a během každého plného načtení z UI zmizí odvozený DLL zámek, takže ARM ho nevyřadí. Oba jsem ověřil vlastním testem. V pořadí od nejvážnějšího:

### 1. [VYSOKÁ] Retry smyčka: plné načtení se po selhání opakuje, dokud předchozí požadavek neodpoví
- **Kde:** `components/useTradovateLiveData.ts:429-433` (`markPending` nechá staré `retryAt`), `:454`, `:720-731` (retry efekt).
- **Scénář:**
  1. Plné načtení (full) jednou selže (502, výpadek sítě, 429) a `markFailure` nastaví `retryAt = T`.
  2. V čase T se spustí `refreshData`. `markPending` vytvoří nový stav, ale `retryAt` (už v minulosti) nechá.
  3. React překreslí, efekt znovu najde čekající připojení s minulým `retryAt` a naplánuje timer s nulovým zpožděním.
  4. To zavolá další `refreshData`, pak další `markPending`, a tak dál.
  - Smyčka běží, dokud první požadavek neodpoví. Plné načtení trvá sekundy, takže to jsou desítky až stovky souběžných POST na `/api/tradovate/oauth/preflight`. Každá iterace navíc volá i `loadTradovateAccountProfiles`.
- **Dopad:**
  - Server spojuje stejné požadavky (20s coalesce) jen v rámci jedné Vercel instance, a to do rozsahu nepatří. Invokace Vercelu, auth a token čtení v Supabase a volání profilů tím chráněné nejsou.
  - Při škálování na víc instancí jde každá instance znovu na Tradovate. To je stejný token, jaký používá worker (penalizace z 18. 9.).
  - Pravděpodobné, ale neověřené: zahlcené spojení k Vercelu zdrží relay DISARM z telefonu.
- **Důkaz:** `scratchpad/ui-review-data/retryLoop.test.ts`, první test. Používá harness z `liveDataDetailedReview`: 50 průchodů timerem dalo 51 volání `runTradovateReadOnlyPreflight(…,'full')` při jednom visícím požadavku. Strop je jen v limitu mé testovací smyčky. Stávající testy retry timer nikdy nespustí, proto chybu nechytily.
- **Regrese:** ano, retry smyčka je v tomto diffu nová.
- **Oprava:**
  - `markPending` ať nastaví `retryAt: null`.
  - Přidat mapu rozběhnutých požadavků po připojení: `refreshData` přeskočí připojení, které už běží, a retry i foreground efekt ho ignorují.
  - Doplnit test, který timer skutečně spustí.
- **Jistota:** vysoká.

### 2. [VYSOKÁ] Odvozený DLL zámek i breach mizí při každém plném načtení, takže ARM účet nevyřadí
- **Kde:** `components/TradovateLiveDesk.tsx:477` (`dailyPnlPending = pending !== false`), `:537` (filtr `!account.dailyPnlPending`), `useTradovateLiveData.ts:454`.
- **Scénář:**
  1. Follower je ze stavu LIVE odvozeně `dll-locked` (případně leader `breached`).
  2. Spustí se plné načtení: 10min interval, návrat do popředí po více než 5 min, retry, návrat na LIVE nebo `live.refreshData()` po ověření způsobilosti.
  3. Všechny účty připojení dostanou `dailyPnlPending = true` a filtr je z odvození vyřadí.
  4. `accountEligibilityExclusions` je prázdné a nespustí se ani blokace ARM pro leadera.
  - Ťuknutí na ARM v tomto okně, typicky hned po otevření appky na telefonu, pošle `arm-live` bez vyřazení.
  - Při trvale padajícím plném načtení platí stav pending pořád, takže odvození je vypnuté úplně.
  - Worker klasifikuje DLL jen reaktivně po rejectu příkazu (`copierRuntimeController.ts:888`), takže to vede ke scénáři V16.
- **Regrese:** ano. Dřív se `dataEnrichmentPending` zapínal jen při prvním načtení; interval ani návrat do popředí ho nepřepínaly. Komentář v `tradecopiaLiveService.ts:55` („never an execution gate“) neodpovídá skutečnosti.
- **Důkaz:** druhý test v `retryLoop.test.ts`: po úspěchu a návratu do popředí je `dataEnrichmentByConnection.c.pending === true`. Zbytek plyne z čtení kódu.
- **Oprava:** filtr odstranit. Odvození už samo kontroluje `dailyPnlAvailable`, obchodní datum a `unrealizedPnlSource`. Případně filtrovat jen `lastFullSuccessAt == null` („nikdy nenačteno“), ne probíhající načtení.
- **Jistota:** mechanismus vysoká, dopad závisí na tom, jestli worker o zámku už ví.

### 3. [STŘEDNÍ] DLL v UI ukazuje 0, ale ARM odvození zámek nevytvoří (oprava ST11 není úplná)
- **Kde:** `lib/copyTradeAccountEligibility.ts:52` počítá z `account.realizedPnl` (OAuth daily, až 10 min staré). Displej počítá z `displayValues` (worker) přes `liveDailyPnlDisplay`.
- **Scénář:** follower narazí na DLL v 10:05. Worker feed hlásí realized −1250, poslední OAuth daily −200. Uživatel vidí „DLL zbývá 0“ v čerstvé barvě, ale ARM ho nevyřadí.
- **Důkaz:** `scratchpad/ui-review-data/inferenceVsDisplay.test.ts`: daily −1250 (čerstvé), DLL −50 (`ready`, čerstvé), odvození `[]`.
- **Regrese:** ne, odvození bylo i dřív z OAuth. Nová je nekonzistence s displejem.
- **Oprava:** pro odvození brát realized z `liveDailyPnlDisplay` (stejná session). Konzervativně menší z obou hodnot.
- **Jistota:** vysoká.

### 4. [STŘEDNÍ] DLL s limitem z profilu je trvale „poslední známá hodnota“ a šedé, červené varování zmizí
- **Kde:** `lib/tradovateCopyTradeBridge.ts:54-55` (`dailyLossLimitUpdatedAt = profile.updatedAt`, tj. `updated_at` řádku profilu), `lib/liveBalanceDisplay.ts:106-121`, `components/LiveRiskValue.tsx:38`.
- **Scénář:** profil uložený před 10 dny a všechny vstupy čerstvé dají `confirmedAt` = datum profilu a `stale: true` navždy. Titulek ukáže „poslední známá hodnota před 240 h“ a `dllRemainingClass` (červená při ≤ 0) se neuplatní, protože stale znamená šedou.
- **Důkaz:** `scratchpad/ui-review-data/dllFreshness.test.ts`, první test: `{value:700, stale:true, confirmedAt:'2026-09-18…'}`.
- **Regrese:** ano. Dřív se barva vykreslovala i u stale a čas limitu se nezapočítával.
- **Oprava:** čas konfigurace není čas čtení. U limitu z profilu ho z výpočtu „nejstaršího vstupu“ vynechat.
- **Jistota:** vysoká.

### 5. [STŘEDNÍ] Záložka Risk ukazuje zastaralé denní P&L jako ověřené
- **Kde:** `components/TradovateLiveDesk.tsx:507-512` bere jen `.value` a příznak stale zahodí. `components/LiveAccountRiskTable.tsx:127` (nový `displayedAccountDailyPnl`) vrací `stale:false, confirmedAt:null`. `verifiedAccountDailyPnl` hodnotu použije pro průběh a stav „blízko limitu“.
- **Scénář:** žádný worker feed (Mac spí), plné načtení před 9 min. Přehled ukáže Daily šedě „před 9 min“, Risk tab a „Účet nejblíž limitu“ stejné číslo jako čerstvé. Nově se sem dostanou i worker hodnoty z display cache libovolného stáří v rámci session. `brokerDailyPnlPending` je napevno `false`.
- **Důkaz:** `dllFreshness.test.ts`, druhý test: daily `{stale:true}`, summary `{stale:false}`, tabulka −300.
- **Regrese:** částečně existovalo už dřív. Nově je to v rozporu s novým modelem stale a zdroj je širší.
- **Oprava:** předávat celé `{value, stale, confirmedAt}` a `verifiedAccountDailyPnl` ať při stale vrátí null.
- **Jistota:** vysoká.

### 6. [NÍZKÁ–STŘEDNÍ] Návrat do popředí spustí dva souběžné plné preflighty a ignoruje backoff
- **Kde:** `useTradovateLiveData.ts:143-150, 735-754`.
- **Scénář:**
  - `visibilitychange` i `focus` při jednom návratu (iOS i záložka prohlížeče). První označí připojení jako čekající, druhý ho proto zahrne znovu.
  - Po chybě, která není 429, spustí každý `focus` plné načtení bez ohledu na `retryAt`. Přepínání mezi TradingView a AlphaTrade tak vždy znovu načítá.
- **Důkaz:** `retryLoop.test.ts`, druhý test: 2 volání full na jedno připojení.
- **Oprava:** přeskakovat rozběhnuté požadavky, respektovat `retryAt`, sloučit události (debounce).
- **Jistota:** vysoká. Tradovate zátěž částečně tlumí serverové spojování požadavků (coalesce).

### 7. [NÍZKÁ–STŘEDNÍ] Klient zkracuje explicitní Retry-After/p-time od brokera na 10 min
- **Kde:** `useTradovateLiveData.ts:127, 137-138`.
- **Scénář:** Tradovate pošle p-time 1800 s. Po 10 minutách se obnoví P&L ticky (3–15 s) i plná načtení na penalizovaný token. Dřív klient respektoval plnou hodnotu. Strop dává smysl jen pro náhradní hodnotu (fallback), ne pro instrukci brokera.
- **Jistota:** střední; test to výslovně vyžaduje jako záměr.

### 8. [NÍZKÁ] Trvalá chyba plného načtení se pořád tváří jako „Načítám“ (ST12 opraveno jen částečně)
- **Kde:** `useTradovateLiveData.ts:447` (`markFailure` nastaví `pending: true`), `lib/liveBalanceDisplay.ts:91, 99, 114`.
- **Scénář:** připojení, jehož plné načtení nikdy neprošlo (409 reauth, opakovaný 502), ukazuje u DLL a DD skeleton s titulkem „Načítá se…“ navždy. `dataEnrichmentByConnection[id].error` se nikde nezobrazí.
- **Oprava:** po první chybě stav `unavailable` s textem chyby.

### 9. [NÍZKÁ] Intent prefetch přišel o `blocked`/`onError`
- **Kde:** `useTradovateLiveData.ts:231-240`.
- **Scénář:** 429 z bootstrap požadavku při prefetchi se nikam nezapíše, takže opakovaný hover a `refreshStatus` znovu volají rate-limitované připojení. Dopad je malý, protože prefetch běží jen bez dat.

### 10. [NÍZKÁ, robustnost] Neplatné `capturedAt` shodí render
- **Kde:** `tradovateCopyTradeBridge.ts:19, 34, 52`.
- **Scénář:** `tradovateDisplayTradeDate(Date.parse(capturedAt))` při NaN vyhodí výjimku (`msUntilTradovateSessionEnd`). Dřív `.slice(0,10)` nikdy nepadl. Pád LIVE stránky by schoval i DISARM.
- **Jistota:** nízká, že nastane; server posílá platné ISO.

### Co je v pořádku
- **Obchodní datum:** 17:00 CT i přechod DST 1. 11. 2026 sedí; 11 hraničních případů prošlo (`tradeDate.test.ts`). Sedí i `sameTradovateSession`.
- **ST10:** odvození už nevyrobí zámek ze včerejšího obchodního data.
- **Server:** p-time se čte z těla odpovědi a fallback je 5 min. Nečitelné tělo 200 dá coverage `unavailable`, ne `empty`.
- **Rate-limit brána po připojení:** P&L tick i index anchor se mapují správně.
- **Souvislá mezera, ne chyba:** skupinový a denní součet P&L ignoruje stale, takže bývá barevný, i když jsou řádky šedé. To bylo i dřív.
- **Mimo rozsah diffu:** o svátcích (například Díkůvzdání 26. 11.) se obchodní datum Tradovate může lišit od výpočtu přes 17:00 CT; DLL pak ukáže „nedostupné“ a odvození se vypne. Existovalo už dřív, neověřeno proti Tradovate.
- **Testy ve worktree:** 8 souborů z čočky, 94/94 prošlo. Nic jsem neupravoval.

Dočasné testy leží ve `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/ui-review-data/`:
- `retryLoop.test.ts`
- `dllFreshness.test.ts`
- `inferenceVsDisplay.test.ts`
- `tradeDate.test.ts`

Spouští se přes `npx vitest run --root <ta složka>`.