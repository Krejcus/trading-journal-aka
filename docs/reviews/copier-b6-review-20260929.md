# Review balíčku 6 (b762714) — 29. 9. 2026

Adversariální review dvěma čočkami (V9 auto-close; V4 guard + ST4), srovnání proti d954575.

## Čočka V9

**Balíček 6 (b762714), čočka V9: neprošel. Mám dvě potvrzené regrese proti d954575, jedna je nový falešný DISARM, druhá kopie, která zůstane tiše otevřená.**

Sondy jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/b6-v9/tests/zzV9ReviewProbe.test.ts`. Stejný soubor leží i v `b6-v9-pre/tests/`. Sondy nic neověřují, jen vypisují stav, takže obě verze „projdou“. Rozdíl je vidět ve výpisu níže.

### N1 — VYSOKÁ: nový falešný fail-closed DISARM od leader-flat guardu, když má follower čekající OSO dalšího vstupu
- **Kde:** `services/copierRuntimeController.ts:5583–5626`. Jde o nový sweep v `verifyLeaderFlatEpoch`, orphan kontrola je na 5617–5622.
- **Scénář:** Kopírka je ARMED a leader i follower drží kopii MNQ. Leader si dopředu zadá čekající OSO dalšího vstupu: limit plus SL/TP. Děti jsou `pending`, kopírka to OSO na followera zkopíruje. Potom leader vystoupí, follower s ním a je flat.
  - Po grace guard najde vlastněné nohy s `isOpenOrderStatus('pending') === true`.
  - Sweep je podle pravidla O3b správně neruší, protože parent je otevřený a nevyplněný. Nic tedy nezruší.
  - Hned po něm `listOrders` najde tytéž pending děti a zavolá `failClosed`.
- **Následek:** DISARM. Čekající OSO na followerovi pak zůstane bez dozoru, takže cancel nebo úpravu leadera už kopírka nezrcadlí.
- **Důkaz (sonda PB):**
  - b762714: `"lastError":"Leader-flat guard: doložená osiřelá ochranná noha mo-3 zůstala aktivní nad flat followerem 200","armed":false,"lastDisarm":"fail-closed"`
  - d954575: `"lastError":null,"armed":true`
  - V obou verzích 0 cancelů.
- **Oprava:** Z `ownedLegIds` vyřadit nohy OSO záznamu, jehož `entryBrokerOrderId` je v `row.orders` otevřený s `filledQuantity === 0`. Platí to pro předkontrolu (5590–5601) i pro postkontrolu (5617), stejně jako to klasifikuje sweep. Alternativně omezit na záznamy s `leaderEntryOrderId ∈ epoch.leaderEntryOrderIds`. PB přidat jako regresní test, přitom musí dál procházet test „flat follower po restartu uklidí jen doloženou osiřelou copier OCO nohu“.
- **Jistota:** vysoká na mock brokeru; odpovídá postupu „TP/vstup zadaný dopředu“.

### N2 — STŘEDNÍ: neúplná stopa vede k tomu, že skutečná divergentní kopie zůstane otevřená bez chyby a výsledek se hlásí jako flat
- **Kde:** `copierRuntimeController.ts:5814` (`copierFootprintSymbols`), 5898–5908 (`hasExposure` ignoruje symboly mimo stopu) a `copierManualActions.ts:174`.
- **Scénář:** Na followerovi 200 je v outboxu potvrzený NQ z historie, takže stopa není prázdná. Kopie MNQ má outbox záznam ve stavu `waived`: operátor ho uvolnil jako stuck `unknown`, ale příkaz se ve skutečnosti vyplnil. Stejně dopadne async `rejected` s částečným fillem, který se pak přes reconciliation zapíše jako `waived`. Žádná epocha neběží. Stav je leader MNQ=1, follower MNQ=2 a přijde reconnect.
  - Stopa followera je jen {NQ}, takže `hasExposure=false` a funkce vrátí `{flat:true, acted:false}`.
  - Žádný zápis k brokerovi, žádná chyba ani audit. Při výpadku spojení by se zapsalo `copiesOutcome = 'flat'`.
- **Důkaz (sonda PC):**
  - b762714: `"liquidations":[],"followerPos":["MNQU6=2"],"lastError":null,"autoClose":null,"errors":[]`
  - d954575: `"liquidations":["200:MNQU6"],"followerPos":["MNQU6=0"],"autoClose":{…"flat":true,"submittedClosures":1}`
- **Oprava:**
  1. Do stopy přidat symboly, ve kterých má leader právě otevřenou pozici. Rodič je zavíral taky, takže u ručních obchodů to nic nezhorší.
  2. Zbylou expozici mimo stopu u participujícího followera nikdy nevydávat za flat. Má jít audit `blocked` plus `onError`, návrat `{flat:false}`, tedy výsledek `unknown`, a `liveCopyOpenSince` se nesmí mazat.
- **Jistota:** reprodukce vysoká. Pravděpodobnost v produkci střední až nízká: vyžaduje waived/rejected záznam, který se přesto vyplnil, bez rozpracované epochy. Otevřená epocha v symbolu leadera tuto díru jinak kryje.

### Prověřeno bez nálezu
Body 1–3 ověřeny v kódu, pokud není uvedeno jinak.
1. **Vypnutý follower se skutečnou kopií (20. 8.):** v produkci na to nevede žádná cesta. `setFollowerEnabled` vyžaduje flat leadera i followera a žádné čekající příkazy (11124–11131). Cesty pro úpravu skupiny přebírají `enabled` z runtime (`localCopierExecutionAgent.ts:143`, `copierRuntimeCommandAdapter.ts:66–68`). Followeři vyřazení přes eligibility nebo cut v cílech zůstávají.
2. **Stopa je široká:** outbox se nikdy neprořezává, takže stopa obsahuje všechny kdy kopírované symboly. Ruční obchod v takovém symbolu se proto dál zavře, ale to dělal i rodič. Leader při rozsahu `group` nemá stopu, takže se zavírá celý účet jako dřív. Guard ruší jen broker ID z outboxu.
3. **`acted` a `flat`:** zatajení skutečného zavření jsem nenašel. Přepis výsledku na flat u výpadku spojení má i rodič.
4. **Sonda PA** (restart s čekajícím OSO): obě verze stejně, obnova blokovaná na `working=100,200`.

**Sada na exportu b762714:** rc=0. Soubory: 170 prošlo, 1 přeskočen. Testy: 1939 prošlo, 1 todo. Obě čísla zahrnují moje tři sondy. Log je v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/b6-v9-suite.log`.
## Čočka V4 + ST4

**Balíček 6 (b762714), čočka V4 + ST4: kritérium přijetí NESPLNĚNO.** Dva nálezy jsou horší než rodič d954575. N1 je nový falešný DISARM v běžném toku. N2 je nový broker write, který followerovi sebere SL/TP.

Sondy jsou v `<scratchpad>/b6-v4{,-pre,-fix}/tests/zzProbeB6V4Lens.test.ts`, kde `<scratchpad>` = `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad`. Export `b6-v4-fix` obsahuje ověřovací patch k N1.

### N1: vysoká, falešný DISARM v běžném toku
- **Kde:** `services/copierRuntimeController.ts:5599-5601` a `5617-5619`.
  - Guard za osiřelou bere každou doloženou nohu v `isOpenOrderStatus`, tedy i `pending` (Suspended).
  - `sweepFollowerProtectiveLegs` (`:1925-1941`) ale pending dítě working nevyplněného OSO parentu správně neruší.
  - Postkontrola guardu ho pak najde a zavolá `failClosed`. ARMED kopírka se tím odzbrojí.
- **Scénář:**
  - P1c (běžné, žebříček nebo add-on): leader drží pozici a má čekající OSO limit se SL/TP, pak vystoupí.
  - P1: nový čekající OSO re-entry do 2 s po flat.
- **Důkaz:**
  - d954575: `armed:true, lastError:null`.
  - b762714: `armed:false`, `lastError: "Leader-flat guard: doložená osiřelá ochranná noha mo-4 zůstala aktivní nad flat followerem 200"`. Žádný cancel se nepošle.
  - Následek: čekající OSO followera zůstane u brokera, zatímco kopírka je DISARMED. Když se vyplní, správa leadera se na followera nekopíruje.
- **Oprava:** v předběžné i postkontrole guardu použít stejnou klasifikaci jako sweep. Pending dítě otevřeného parentu s `filledQuantity===0` není osiřelé.
  - Ověřeno v `b6-v4-fix`: P1 i P1c dávají `armed:true`, V9V4 12/12 prochází.
  - Navíc doporučuju zúžit `ownedLegIds` na linii epochy (`entry.leaderEntryOrderId ∈ epoch.leaderEntryOrderIds`).
- **Jistota:** vysoká. Reprodukce je deterministická a Suspended→`pending` odpovídá `brokerPort.ts:27`.

### N2: vysoká (peníze), nízká pravděpodobnost; follower s živou pozicí přijde o SL/TP
- **Kde:** `:5543-5551` čte `listPositions` a `listOrders` paralelně. Na `:5602` sweep dostane `authoritativeOrders: row.orders` a věří, že follower je flat.
- **Scénář:** čekající OSO vstup followera se vyplní mezi čtením pozic a čtením orderů.
  - Order graf ukáže vyplněný parent a working SL/TP, pozice ukáže 0.
  - Guard zruší SL i TP nové pozice. Postkontrola uvidí net≠0 a spustí `failClosed`.
  - `failClosed` zvedne generaci, což přeplánuje další běh guardu se zápisem.
- **Důkaz (P6):**
  - d954575: 0 cancelů, `armed:true`.
  - b762714: `mo-4:Stop:canceled`, `mo-5:Limit:canceled`, follower +1 bez ochrany, `armed:false`.
  - Oprava N1 tohle nekryje, `b6-v4-fix` dává stejný výstup.
- **Oprava:** před zápisem číst ordery a teprve potom pozice, sekvenčně.
  - Pokud nějaký vlastní OSO parent účtu a symbolu má `filledQuantity>0` a pozice je 0, snímek je nekonzistentní. Pak jen znovu číst, nic nerušit.
  - Plus zúžení na linii epochy jako u N1.
- **Jistota:** střední. Okno je jeden REST round-trip a předpoklad je stejný jako u N1.

### N3: nízká, ST4 fence zhorší horší případ, ale ne podle kritéria
- **Kde:** `:10213`.
  - Cancel z vlastního sweepu v reconcile vyvolá order event followera. Druhá pojistka proto první pokus vždy zneplatní.
  - Ze dvou pokusů (`:9775`) tak zbývá na živý šum jeden.
- **Důkaz (P2):**
  - Bez dalšího eventu: b762714 `clean:true`, d954575 `clean:false`. Tady je nová verze lepší.
  - S jedním leader eventem ve 2. pokusu: b762714 vyhodí „Reconciliation byla zneplatněna novým stream eventem účtů 100“, d954575 vrátí `clean:false`.
  - V obou případech je ARM odmítnut. Retry je omezený a bez slepého zápisu, protože 2. pokus čte znovu.
- **Oprava:** verze pozorování, které způsobil vlastní sweep cancel, do pojistky nepočítat. Nebo při změně přisouditelné vlastnímu sweepu povolit 3. pokus.
- **Jistota:** vysoká.

### Bez regrese
- **(1) DISARM a kill switch:**
  - Pod kill switchem je liquidation zablokovaná. Cancel osiřelé nohy kill switch nehlídá, ale ingress sweep (`:8907`) a reconcile sweep (`:10203`) také ne, takže je to konzistentní s dosavadním návrhem.
  - P4 i P5 dávají v obou verzích stejný výsledek.
  - ARM se čekajícím timerem guardu odmítá (`:10409`).
- **(2) Vyčerpání 3 pokusů:**
  - P3: DISARM a čekající ordery leadera během čtení guardu vedou jen k 1 přeplánování. `lastError:null`, reconcile+ARM projde v obou verzích.
  - Drobnost: `failSweep`→`failClosed` uvnitř guardu sám spotřebuje jeden pokus.
- **(3) Watchdog:**
  - Nedělá žádný zápis (`allowWrites=false`) a za kill switche ani bez spojení nic neplánuje.
  - Smyčku jsem nenašel: každé vyhodnocení zvedne generaci epochy, takže starý watchdog verify neudělá nic.
  - Zůstává teoretický závod heartbeat mezi spuštěním timeru a verify, který jen po změně generace může přepnout guard na read-only. Tam rodič nedělal nic, takže to není horší. Nereprodukováno.
  - Kosmetika: audit „leader-flat watchdog obnovil…“ se objeví i v této přechodné mezeře.
- **(4) Rozsah úklidu:** ruční ordery se nikdy nedotknou, kandidáti jsou jen ID z outboxu. Problémy jsou jen ty popsané v N1 a N2.

### Předepsaná sada na b762714
Spuštěno bez mých sond: **rc=0**, 169 souborů prošlo, 1 přeskočen, 1936 testů prošlo, 1 todo.