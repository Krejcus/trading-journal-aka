# Review balíčku 7 (331fdaf) — 29. 9. 2026

**Balíček 7 (331fdaf) neprošel.** Kritérium „žádná sonda horší než 23011e6“ není splněné: sondy P1, P2, P5a a P5b vycházejí hůř než 23011e6. Latenci (P4) a deadline (P3) balíček zlepšil.

**Upozornění na bázi:** rodič 331fdaf je bf76e24, ne 23011e6. Diff 23011e6..331fdaf proto vypadá, jako by vracel V1/V3/V15. Zkušební `git merge-tree` s 23011e6 hlásí konflikt v `services/copierRuntimeController.ts` (`reconfigurationTail` proti `followerCutBackgroundJobs`), stačí ponechat obě strany. Na takto sloučeném stromu tsc v dotčených souborech nehlásí chyby a 4 relevantní testové soubory prošly 87/88; selhala jen sonda P1. Commit je potřeba před integrací rebasovat na 23011e6, necherry-pickovat.

### Nálezy

**1. KRITICKÝ — po DISARM nebo KILL a následném reconcile odejde druhý liquidate souběžně s prvním**
- **Kde:** `services/copierRuntimeController.ts:10728-10733` (reconcile znovu spustí cut s `closed===null` přes hlavní `flatten()`), `:5223-5263` (background lane zapisuje outbox do izolovaného memory store) a `:5498` (`followerCutBackgroundAccounts` hlídá jen release, reconcile ne).
- **Scénář:** ruční Flatten followera, broker odpovídá pomalu, operátor dá DISARM (nebo kill switch) a pak „Kontrola pozic“. Reconcile v hlavním outboxu nenajde záznam operace a pošle nový liquidate, zatímco první ještě běží. U brokera hrozí dvojitý exit a otočení followera.
- **Důkaz (sonda P2 disarm i kill):**
  - nová verze: `liquidate calls in flight BEFORE release (concurrent): 2`, `liquidates=2`
  - 23011e6: `1`, `liquidates=1`
- **Oprava:** reconcile a všechny cesty mimo background musí pro účet s běžící background lane skončit chybou nebo na lane počkat. Nutná je i oprava bodu 2.
- **Jistota:** vysoká.

**2. VYSOKÝ — chybí write-ahead: záměr liquidate se do durable store dostane až po skončení lane**
- **Kde:** `:5223-5263` (izolovaný store), `mergeBackgroundFlattenRuntime` se volá až po `processManualFlatten`. Souvisí s `scripts/copier/pilot.ts:674` (shutdown watchdog 20 s je kratší než 90 s deadline).
- **Scénář:** pád procesu nebo STOP během lane (watchdog volá `process.exit`). Po restartu reconcile neví, že liquidate už odešel, a pošle ho znovu. Nejistý výsledek je tak durable až po doběhnutí lane, ne před zápisem k brokerovi.
- **Důkaz P1:**
  - nová verze: durable záznamy během letícího liquidate `[]`, po restartu `liquidates=2`, cut uzavřen jako úspěch, žádný lastError
  - 23011e6: `["sending/-"]`, `liquidates=1`, `closed:false` a lastError `divergence=200`
- **Důkaz P5a (store selže na zápisu merge):**
  - nová verze: liquidate proběhl (pozice 0), durable záznam 0, skupina zůstává ARMED, lastError žádný
  - 23011e6: liquidate neodešel, záznam je durable
- **Oprava:** zápis v izolovaném store synchronně propsat do hlavního store přes `processor.mutate`, a to před každým zápisem k brokerovi (`planned`/`sending`). Když tento zápis selže, liquidate neposílat.
- **Jistota:** vysoká.

**3. VYSOKÝ až STŘEDNÍ (ST32) — při stavu `failed` selže i auto-close kopií, který snižuje riziko**
- **Kde:** `services/copierRunner.ts`, `createSerialCopierProcessor` (`beforeOperation` odmítne každou mutaci). Reload se znovu nespouští automaticky, jen přes reconcile.
- **Scénář:** jednorázová chyba commitu a k tomu jednorázová chyba load. Leader je flat, followeři zůstanou otevření, dokud operátor něco neudělá.
- **Důkaz P5b:**
  - nová verze: pozice 100/200/201 = `[0],[1],[1]`, lastError `Auto-close kopií (fail-closed) selhal: Copier processor čeká na durable reload`
  - 23011e6: `[0],[0],[0]`
- **Oprava:** automatický opakovaný reload s backoffem. Auto-close při stavu jiném než `ready` pouštět nativní izolovanou lane, stejně jako `emergencyFlatten`.
- **Jistota:** chování vysoká; realističnost scénáře střední.

**4. STŘEDNÍ — waitForIdle a stop**
- `waitForIdle` čeká na background cut až 90 s. Bariéra kontroluje jen zápisy, takže potvrzovací čtení pokračují i po stop/DISARM. Watchdog pilota proces ukončí po 20 s, což vede přímo na bod 2.
- Ve stavu `failed` `waitForIdle` skončí chybou. P5b: nová verze `rejected`, 23011e6 `resolved`. Pilot to zachytí přes `attempt()`, nic nevisí.
- **Oprava:** při shutdown/kill/stop přerušit i potvrzovací smyčku lane a nejistý výsledek hned uložit.
- **Jistota:** střední.

**5. NÍZKÝ — reload se spustí po jakémkoli odmítnutí operace, nejen po chybě store**
- **Kde:** `copierRunner.ts`, `schedule` → `settleFailure`.
- **Důsledek:** zbytečný `store.load` ve frontě, ARM je přechodně odmítnut a ostatní followeři čekají navíc jeden load.
- **Oprava:** reload spouštět jen po chybě commitu nebo při nejistém výsledku commitu.
- **Jistota:** střední; ověřeno jen čtením kódu, sondu jsem na to nepsal.

**6. NÍZKÝ — návratová bariéra**
- Merge proběhne ještě před `assertReturnBarrier`. Pak bariéra vyhodí chybu a `recordFollowerCutFailure` zapíše `closed:false`, i když je účet flat (P2: nová verze `cut=false`, 23011e6 uzavřeno). To je konzervativní.
- Cesta `catch` ale zapisuje bez kontroly `activeCutStillMatches`, takže teoreticky může přepsat novější cut.
- **Oprava:** když bariéra odmítne pozdní výsledek, nic nezapisovat a jen vyžádat reconcile.
- **Jistota:** střední.

### Co je v pořádku
- **Latence (P4):** exit followera 201 za 3 ms (23011e6 zablokováno přes 300 ms). Re-entry leadera se na 201 zkopíruje, na 200 během flattenu neodejde žádný příkaz, flatten skončí úspěšně.
- **Deadline (P3):** výsledek fail-closed a durable. Flatten skončí chybou do 400 ms, `armed=false`, durable záznam `unknown/indeterminate`, `closed:false`, ARM odmítnut i po reconcile, liquidate jen jeden. Ve 23011e6 operace visela a blokovala eventTail.
- **Kill switch:** západka drží.
- **Reload (ST32):** během reloadu je ARM odmítnut, nouzový Flatten projde a reconcile stav obnoví.

### Sada testů
Na b7-rev: rc=0, 169 souborů prošlo a 1 přeskočen (170), 1961 testů prošlo a 1 todo. Flake copierFlatSweepV13 B6/R6 se tentokrát neobjevil, izolované opakování nebylo potřeba.

Sonda je uložená v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/b7-rev/copierB7RevProbe.test.ts`. Oba exporty i pomocný sloučený strom jsou smazané a worktree je čistý.