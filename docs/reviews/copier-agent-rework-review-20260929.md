# Ověřovací review přepracovaných brzd/relay (d226986)

## Čočka safety

**Review d226986 (proti 90cee98), čočka brzdy/ARM**

Opravy N1–N6 z první review fungují. Ověřil jsem je end-to-end: skutečný enqueue, emulovaný `claim_v2`/`complete_v2`, skutečný relay a transport i skutečný agent. Kritickou ani vysokou díru jsem nenašel. Zbývá 6 nálezů, všechny nízké nebo nízké až střední a všechny končí bezpečným stavem (fail-closed).

- **Moje testy:** 11/11 prošlo. S1–S6 dopadají bezpečně, F1–F3 potvrzují nové nálezy.
- **Povinná sada v exportu:** 125 souborů, 1530 testů, vše prošlo.
- **Worktree:** zůstal čistý na d226986.

### PoC z první review proti d226986
- Všech 9 původních testů (R1–R5, KOMPAT 1–3, KOMPAT-ARM) teď selže, vadné chování se tedy neprojeví.
- R2 a R3 skončí explicitním odmítnutím „jinou konfigurací“. KOMPAT-ARM skončí `copier-relay-arm-config-conflict`, protože mock ignoruje filtr `gt`.
- R1, R4, R5 a KOMPAT 1–3 ale selhávají jen proto, že prioritní linka už neexistuje. Proto jsem je přepsal pro v2 jako S1–S6 v `zzAgentBBrzdy.test.ts`:
  - **N1:** S1 ukazuje, že ARM čekající za Flattenem expiruje jako `superseded-by-brake` a kopírka skončí DISARMED. S1b ukazuje, že ARM se starším `created_at` vložený až po provedené brzdě worker odmítne. S1c ukazuje, že při synchronních hodinách odmítne i relay ARM po lokálním DISARM.
  - **N2:** ARM se skupinou B nebo s novou exclusion skončí explicitním odmítnutím, shodný ARM je no-op.
  - **N3:** starý `claimed` ARM s `expires_at` v minulosti nový ARM nepohltí.
  - **N4:** po ztracené odpovědi `poll-v2` se brzda obnoví přes stejné `deliveryId` a provede se právě jednou.
  - **N5:** po ztracené odpovědi `complete-v2` je retry idempotentní a další kill switch projde.
  - **N6:** relay ARM s méně než 10 s do expirace se neprovede. Hlavička deadline má strop 30 s.

### Nové nálezy

**F1 — NÍZKÁ až STŘEDNÍ: nový ARM se přes DISARM připojí ke staršímu `claimed` ARM**
- **Kde:** `server/tradovateCopierCommandRelay.ts:600-626` (`findInFlightArm`) a `:560-597` (`coalesceInsertedArm`).
- **Scénář:**
  1. ARM A je claimed a běží (až 20 s).
  2. Uživatel pošle DISARM, pak znovu shodný ARM C. Stačí druhý klient, například telefon a web přes relay.
  3. C dostane id řádku A.
  4. A proběhne, pak proběhne DISARM.
  5. UI pro C přečte A: `succeeded` a `armed:true`, ukáže toast „kopíruje se naostro“. Skutečný stav je DISARMED.
- **Důkaz:** test F1 prošel (`armC.id === armA.id`, konečný stav `armed=false`).
- **Oprava:** připojovat se jen k ARM s `created_at` novějším než nejnovější brzda téhož zařízení. Stačí jeden dotaz na poslední brzdu a přidat `.gt('created_at', lastBrake)` do obou funkcí.
- **Jistota:** vysoká pro mechanismus, pravděpodobnost nízká.

**F2 — NÍZKÁ: pojistka proti ARM po brzdě míchá hodiny serveru a workeru**
- **Kde:** `server/localCopierExecutionAgent.ts:487`, `:497-500`, `:775`, `:847`.
- **Scénář:**
  1. Relay ARM nese `created_at` z hodin Vercelu, lokální brzda čas příchodu podle hodin workeru.
  2. Lokální brzdu server nevidí, takže `superseded-by-brake` čekající relay ARM neexpiruje.
  3. Když jdou hodiny workeru o X pozadu, ARM z telefonu zařazený až X sekund před DISARM přes loopback na Macu se provede po brzdě.
  4. Okno omezuje deadline ARM (20 s + X).
  5. Opačný směr hodin blokuje lokální ARM po relay brzdě, ale jen jako výpadek dostupnosti.
- **Důkaz:** F2 prošel: s posunem +3 s je konečný stav ARMED a `arm` proběhl až po `disarm`. S1c se synchronními hodinami je bezpečný.
- **Oprava:** `poll-v2` vrátí `serverNow`, worker si odhadne posun hodin, přepočte relay `createdAt` a při srovnání přes obě domény přidá rezervu (například ≥ 2 s nebo RTT).
- **Jistota:** vysoká pro mechanismus, pravděpodobnost nízká (NTP).

**F3 — NÍZKÁ: denní lock doručený po 17:00 CT zamkne celou další session**
- **Kde:** `localCopierExecutionAgent.ts:717-723` a TTL brzd `tradovateCopierCommandRelay.ts:101`.
- **Scénář:**
  1. Lock kliknutý v 16:57 CT se kvůli frontě nebo výpadku relay provede v 17:04 CT.
  2. `until` se počítá od `Date.now()`, takže vyjde konec další session (30. 9. 22:00Z).
  3. `unlockDay` záměrně vyhazuje chybu, takže celý další obchodní den nejde ARM.
  4. Base měl okno 30 s, teď je 10 min.
- **Důkaz:** test F3 prošel.
- **Oprava:** `until = tradovateSessionEndAt(context.createdAt)`. Když je `until ≤ now`, lock neprovádět a vrátit „session skončila“.
- **Jistota:** vysoká.

**F4 — NÍZKÁ až STŘEDNÍ: TTL brzdy 10 min, ale UI po 35 s tvrdí „Příkaz nebude automaticky opakován“**
- **Kde:** `services/tradovateOAuthConnection.ts:313`, `:329`; `tradovateCopierCommandRelay.ts:101`.
- **Scénář:**
  1. Při pomalém relay jako 17. 9. UI po 35 s vzdá kill switch z telefonu.
  2. Uživatel přes loopback na Macu dá ARM a otevře se obchod.
  3. Kill switch dorazí o minuty později a zmrazí session.
  4. Při kill switchi `autoFlattenCopies` ani recovery nic neprovedou (`copierRuntimeController.ts:5722` a `:9733`), takže kopie followera zůstane bez zrcadlení výstupu.
  5. Pozdní DISARM je neškodný, protože hlídání flat stavu leadera dál platí.
- **Důkaz:** kód, bez PoC.
- **Oprava:**
  - UI u brzd čeká až do TTL, nebo ukáže „brzda čeká ve frontě do HH:MM“, a čekající brzdu vidí i runtime status.
  - Případně worker kill switch starší než ~60 s převede na DISARM s audit záznamem.
- **Jistota:** vysoká pro mechanismus, pravděpodobnost nízká.

**F5 — NÍZKÁ: expirace čekajících ARM při zařazení brzdy není atomická**
- **Kde:** `tradovateCopierCommandRelay.ts:517-523`.
- **Scénář:**
  1. Brzda se vloží, pak selže UPDATE, třeba při vyčerpaném poolu jako 17. 9.
  2. API vrátí 502, přestože brzda ve frontě je.
  3. Starší čekající ARM neexpiruje a proběhne před brzdou. Kopírka je krátce ARMED, pak skončí DISARMED.
- **Oprava:** vložení brzdy a expiraci ARM udělat v jednom RPC pod advisory lockem `hashtextextended(device,917)`. Nebo selhání expirace nebrat jako chybu celého enqueue.
- **Jistota:** vysoká.

**F6 — NÍZKÁ, přetrvává z dřívějška**
- **Revokované zařízení (vlastní ověření):** výběr cíle bere nejčerstvější runtime řádek a teprve pak kontroluje revokaci (`:128-156`). Brzda tak může dostat 404, i když existuje jiné nerevokované zařízení.
- **Restart workeru (vlastní ověření):** po restartu worker zahodí brzdy vytvořené před startem jako `predates-worker-session` (`recoverableCopierDelivery.ts:50`), včetně denního locku, který má restart přežít. Worker je po restartu DISARMED, UI zahození zobrazí jako odmítnutí.
- **N10 z první review (nepřeověřoval jsem ji):** zápis denního locku snímkem stavu je v kódu dál. Podle mého čtení je prakticky neškodná, protože lock stejně blokuje ARM.

### Odpovědi na otázky čočky
- **Může `superseded-by-brake` expirovat ARM vytvořený po brzdě?** Jen při rozdílu hodin mezi instancemi Vercelu (`created_at` je čas začátku requestu, `:443`). I pak jde o fail-closed a sedí to s pojistkou ve workeru. Při souběhu enqueue zůstane pozdě vložený starší ARM `pending`, ale FIFO podle `created_at` ho vezme před brzdou, takže výsledek je DISARMED. Pokud brzda už proběhla, pojistka ARM odmítne (S1b).
- **`lastBrakeCreatedAt` po restartu:** perzistované není, ale je to bezpečné. Po restartu je worker DISARMED, příkazy starší než start se odmítnou, starší čekající ARM expiroval server a claimed ARM v checkpointu skončí jako „outcome unknown“.
- **Chybějící serverové `createdAt`:** každý v2 server od 4ac346a ho vrací. Když chybí, transport odmítne každý příkaz včetně brzd (fail-closed). Cesta v1 (jen bez `deliveryStore`, v produkci se nepoužívá) dosadí `Date.now()`, což je konzervativní.
- **Kompatibilita:**
  - Nový server se starým workerem 90cee98: brzdy fungují, expirace ARM při brzdě chrání pořadí i u starého workeru. Deadline ARM platí až po nasazení nového workeru, což nastalo už dřív.
  - Nový worker se starým serverem: `poll-v2` vrací `createdAt`, platí FIFO a pojistka. Bez nálezu.

Soubory v exportu `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/agentb-brzdy`:
- `tests/zzAgentBBrzdy.test.ts`
- `tests/zzAgentBEmu.ts`
- kopie původních PoC: `tests/zzReviewBrakesArm.test.ts`, `tests/zzKompatPoc.test.ts`, `tests/zzKompatPocArm.test.ts`

## Čočka compat

**Review d226986 (proti 90cee98), čočka kompatibilita nasazení**

Bezpečnostní model platí ve všech čtyřech kombinacích serveru a workeru. Web i worker lze nasadit v libovolném pořadí. Našel jsem 2 střední funkční nálezy (nový worker s nezměněným UI) a 5 nízkých. Žádný nález nevede k ARM po brzdě mimo okrajový případ s posunem hodin (K5).

Export je v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/agentb-kompat`. Starý kód (90cee98) je v `…/scratchpad/agentb-kompat-old`. Worktree je beze změn: HEAD d226986, `git status` je prázdný.

### Znovu spuštěné PoC z první review
Spustil jsem 9 původních PoC: `tests/zzKompatPoc.test.ts` (3), `zzKompatPocArm.test.ts` (1) a `zzReviewBrakesArm.test.ts` (5).
- Všech 9 teď selže, protože vadné chování se už neprojeví:
  - linka `poll-priority` neexistuje;
  - R2 a R3 hodí chybu „kopírka je zapnutá s jinou konfigurací — nejdřív vypni“.
- Jeden pád je jen artefakt mocku: `zzKompatPocArm` spadne na `copier-relay-arm-config-conflict`, protože mock ignoruje filtry dotazu.
- Proto jsem scénáře přepsal tak, aby ověřovaly bezpečný výsledek. Jsou v `tests/zzbKompatMatrix.test.ts` a `tests/zzbKompatRerun.test.ts`; pomocný model DB je `tests/zzbFakeRelayDb.ts`.
  - Model DB věrně kopíruje SQL z migrace `20260913154140` a sémantiku PostgREST.
  - Proti němu běží skutečné relay funkce obou verzí, skutečný agent a skutečný mac relay.
- Výsledek: 30/30 prošlo. Konkrétně:
  - ztracená odpověď `poll-v2`: DISARM se provede právě jednou;
  - ztracený ACK `complete-v2`: opakování je idempotentní a další kill switch dorazí;
  - osiřelý claimed ARM z minula nový ARM nepohltí;
  - R2 a R3 jsou explicitně odmítnuté a skupina A zůstane beze změny.

### Matice nasazení
Starý server = 90cee98 (relay a API jsou identické s produkčním `origin/main` 6a9cc47). Starý worker = 90cee98 (transport a agent jsou identické s bundlem 1802df6, liší se jen controller).

| server / worker | ARM → DISARM → Flatten | Plná fronta: ARM, pak DISARM | Opakovaný stejný ARM | Přepnutí A→B za ARMED |
|---|---|---|---|---|
| starý / starý | OK | DISARMED | OK (re-arm) | přepne |
| nový / starý | OK, TTL brzdy 10 min | DISARMED, ARM `superseded-by-brake` | OK | přepne |
| starý / nový | OK, `createdAt` z v2 přijde | DISARMED | no-op | **odmítne** |
| nový / nový | OK | DISARMED, ARM superseded | no-op | **odmítne** |

K tomu:
- **Loopback DISARM při ARM ve frontě relay, nový worker:** ARM odmítne plot brzdy, s oběma servery. Se starým workerem kopírka skončí ARMED; to platilo už na base, nejde o regresi.
- **Starý worker s novým serverem:** worker nové pole nepotřebuje. Payloady, v2 claim i checkpoint mají stejný formát. Brána ARM v serveru (`controller.connected` a heartbeat mladší než 10 s) funguje s heartbeatem starého workeru.
- **Deadline ARM platí jen s novým workerem.** Se starým workerem zůstává chování base (ARM i po vzdání UI) a server k tomu přidá jen supersede brzdou.

---

**K1 — STŘEDNÍ (funkční, fail-closed): nový worker s nezměněným UI rozbije „Přepnout a zapnout“**
- **Kde:**
  - `server/localCopierExecutionAgent.ts:568-572` (odmítnutí)
  - `components/LiveCopyTradeOverview.tsx:1193` (UI pošle ARM(B), když je zapnutá A)
  - `components/TradovateLiveDesk.tsx:634-638`
  - `lib/copierArmPreparation.ts:114-124`
  - `LiveCopyTradeOverview.tsx:1070-1082`
- **Scénář:**
  1. Skupina A je ARMED a flat.
  2. Uživatel zapne skupinu B.
  3. Base přepnul atomicky (applyGroup activate: disarm, preflight, arm).
  4. Nový worker vrátí „nejdřív vypni“.
  5. `copierArmRejection` text nezná, takže UI ukáže „Zapnutí kopírky není potvrzené“ s `outcomeUnknown`, přestože výsledek je jistý: odmítnuto, A dál kopíruje.
- **Důkaz:** test matice „UI přepnout a zapnout“ (starý worker `activateGroup` zavolá, nový vrátí rejected) a test v `zzbKompatRerun`, že klasifikátor pro nové chyby vrací `null`.
- **Oprava:** jedna z variant:
  - ve workeru při jiné konfiguraci propadnout do plné ARM cesty jako base a no-op nechat jen pro shodnou konfiguraci;
  - nebo v UI při `copierArmed && candidate ≠ execution` zobrazit blokaci „Nejdřív vypni A“.
  
  Navíc do `copierArmRejection` přidat texty `nejdřív vypni`, `copier-relay-arm-config-conflict`, `copier-relay-worker-disconnected`, deadline a `superseded-by-brake`.
- **Jistota:** vysoká.

**K2 — STŘEDNÍ (funkční): UI na `localhost:3000` ztratí ARM, Risk, toggle followerů i párování a flag nejde nastavit instalátorem (N7 z první review, stále otevřené)**
- **Kde:**
  - `localCopierExecutionAgent.ts:223-224` (flag jen z `process.env`) a `:853-855`
  - `scripts/copier/mac-install.ts:368-371` (plist má pevné `EnvironmentVariables`); `pilot.ts` neposílá `allowFullDevelopmentAccess`
  - `services/localCopierAgentClient.ts:22-25` a `TradovateLiveDesk.tsx:515`: z localhostu jde UI vždy přes loopback a na relay nepřepne
  - `scripts/copier/shadow.ts:38`
- **Scénář:** Po reinstalaci nového workeru vrátí z localhostu 409 tyto příkazy: ARM, `update-group` (Risk), `set-follower-enabled`, `activate-group`, `reconcile`, `snapshot-test`, `device-paired`.
  - Párování sice dokončí worker sám (`pilot.ts:1021`), UI ale ukáže chybu.
  - `shadow on` přestane fungovat.
  - PROJECT_LOG tvrdí, že existuje „instalační env flag“. Instalátor žádný nemá.
- **Důkaz:** test v `zzbKompatRerun`: starý worker vrátí na ARM 200, nový 409 a DISARM 200.
- **Oprava:** v instalátoru flag `--allow-full-dev-origins` propsat do plistu. Nebo na localhostu posílat ne-risk-redukční příkazy přes relay. Opravit `shadow.ts`.
- **Jistota:** vysoká.

**K3 — NÍZKÁ: kroky po durable insertu vrací 502, přestože řádek už je ve frontě**
- **Kde:** `server/tradovateCopierCommandRelay.ts:505-523`, `api/tradovate/oauth/copier-relay.ts:359`. Jde proti duchu komentáře `:325`.
- **Scénář:**
  1. Insert ARM projde, pak selže lookup v `coalesceInsertedArm` (například timeout poolu).
  2. UI dostane `copier-relay-failed` a nepřijde ani kick.
  3. ARM přesto zůstane pending a worker kopírku zapne.
  4. U brzdy vrátí selhání supersede 502, i když DISARM ve frontě je; pořadí pak drží FIFO, takže výsledek je bezpečný.
- **Důkaz:** test matice „selhání coalesce lookupu PO insertu“ skončí `armed=true` po chybě enqueue.
- **Oprava:** selhání supersede jen zalogovat a vrátit zařazenou brzdu. Při selhání coalesce best-effort expirovat vložený řádek (`status='pending'`), nebo vrátit vložený řádek.
- **Jistota:** vysoká (mechanismus), dopad nízký.

**K4 — NÍZKÁ: ARM#2 se přichytí k běžícímu ARM#1, i když mezi nimi čeká brzda**
- **Kde:** `tradovateCopierCommandRelay.ts:600-626` a coalesce `:545-595`.
- **Scénář:**
  1. ARM#1 je claimed a probíhá.
  2. Uživatel pošle DISARM (čeká jako pending).
  3. Pak pošle ARM#2 se stejným payloadem. Ten dostane id ARM#1.
  4. UI ohlásí „Copier je připojený — naostro“, pak se provede DISARM a konečný stav je DISARMED. Poslední úmysl uživatele se ztratí a UI hlásí falešný úspěch.
  
  Směr je bezpečný. Base v tomto případě skončil ARMED.
- **Důkaz:** test matice „identický ARM#2 po DISARM“.
- **Oprava:** přichytávat jen k ARM s `created_at` novějším než poslední brzda zařízení, jinak vložit nový řádek nebo vrátit 409.
- **Jistota:** vysoká.

**K5 — NÍZKÁ: plot brzdy míchá hodiny serveru a workeru**
- **Kde:** `localCopierExecutionAgent.ts:487`, `:497-500`, `:775`, `:847`.
- **Scénář:**
  1. Hodiny Vercelu jdou o δ napřed před Macem.
  2. ARM přes relay je zadaný méně než δ před loopback DISARM na Macu.
  3. `createdAt` ARM vyjde větší než čas brzdy, ARM plotem projde a kopírka je po brzdě ARMED.
- **Důkaz:** test matice s δ = 3 s a odstupem 1 s skončí `armed=true`.
- **Oprava:** přidat do odpovědi `poll-v2` `serverNow` (aditivní změna, starý worker ji ignoruje) a ve workeru přepočítat `createdAt` na lokální hodiny. Nebo rezervu, tedy odmítnout ARM s `createdAt ≤ lastBrakeCreatedAt + 3 s`.
- **Jistota:** střední (s NTP je δ malé).

**K6 — NÍZKÁ: nové chybové kódy relay**
- Kódy `copier-relay-arm-config-conflict`, `copier-relay-worker-disconnected` a expirace `superseded-by-brake` se v UI zobrazí syrově jako „není potvrzené“. UI tím ale nerozbijí: 409 nemá v UI žádné speciální ošetření (`services/tradovateOAuthConnection.ts:168-172`).
- `copier-relay-runtime-not-found` skončí jako 404, ne 409: `copier-relay.ts:349` (`endsWith('not-found')`) se vyhodnotí dřív než mapování na `:356`. Záznam v mapperu `tradovateCopierCommandRelay.ts:112` je proto mrtvý kód.
- **Oprava:** spolu s K1.
- **Jistota:** vysoká.

**K7 — NÍZKÁ: TTL brzdy 10 min proti textu v UI**
- **Kde:** `services/tradovateOAuthConnection.ts:329`.
- **Scénář:** Po 35 s UI napíše „Příkaz nebude automaticky opakován“. Brzda se přitom může ve stejné session workeru provést až o 10 min později, například za dlouhým Flattenem nebo po výpadku API. Platí i pro starý worker s novým serverem. Kill switch nebo denní lock pak může zmrazit session, kterou uživatel mezitím znovu zapnul přes loopback.
- **Oprava:** pro brzdy změnit text na „zůstává ve frontě až 10 min“.
- **Jistota:** vysoká.

### Ověřeno bez nálezu
- **Pilot lease po revertu je přesně jako dřív** (instalace, `add-connection`, re-pair). `api/tradovate/oauth/pilot-lease.ts`, `copier-relay.ts`, `mac-install.ts`, `pilot.ts`, `TradovateLiveDesk.tsx` a `tradovateOAuthConnection.ts` jsou v diffu 90cee98..d226986 bez změny. Test `tradovatePilotLeaseApi` prošel.
- **Nový worker ARM ze starého serveru neodmítá.** `createdAt` z v2 claimu vrací i starý server (stejná funkce). Chybějící `createdAt` by odmítl už base (`created < startedAt`).
- **Starý worker s novým serverem:** checkpoint `RelayDelivery` má stejný formát.
- **CORS:** UI hlavičku `X-AlphaTrade-Command-Deadline` neposílá, takže preflight ke starému workeru se nerozbije.
- **Souběh:** `reconcile` v controlleru je serializovaný, takže reconcile osiřelý po deadline ARM se neprovede souběžně s dalším.
- **Poznámka, ne regrese proti base:** brzda přes relay už nepředbíhá běžící relay příkaz (sériová v2). DISARM z telefonu čeká za probíhajícím Flattenem nebo ARM (ARM nejvýš 20 s). Okamžitě se provede jen brzda přes loopback.

### Povinná sada v exportu
`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier tests/recoverableCopierDelivery.test.ts`: **125 souborů / 1530 testů, vše prošlo** (log je v `…/scratchpad/agentb-kompat-suite.txt`). Moje soubory `zz*` do sady nespadají. Původní PoC v exportu podle očekávání padají, protože vadu už nereprodukují.