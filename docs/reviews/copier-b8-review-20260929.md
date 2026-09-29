# Review balíčku 8 (ab4b310) — 29. 9. 2026

Adversariální review dvěma čočkami (V1 + relay; V3 + V15), srovnání proti 5fbd034.

## Čočka V1 + relay

Balíček 8 (ab4b310) z pohledu V1 a relay **není horší-nebo-stejný než 5fbd034**. Čtyři sondy jsou horší z hlediska rizika nebo dostupnosti: A1/A1b, A2, A3/A4 a R1/R2. Pořadí je od nejzávažnějšího nálezu.

Všechny sondy prošly na 5fbd034 a na ab4b310 selhaly, kromě A5 a A6: A5 vyšla na obou verzích stejně a A6 je jen popisná sonda s logem, bez tvrzení.

Zadaná sada na b8-v1 skončila **rc=0**: 170 souborů prošlo, 1 skipped; 1957 testů prošlo, 1 todo. Sondy byly před během z exportu odstraněné.

## Nálezy

**1. VYSOKÁ – metadata cesta tiše oslabí ochranu za ARM, i uprostřed obchodu (A1, A1b)**
- **Kde:** `services/copierRuntimeController.ts:708` (`sameExecutionConfiguration` vůbec neřeší `safety`), `lib/copierRiskConfig.ts:45` (`isWeakerRiskConfig` neporovnává `autoCloseFollowerPositions`, `preventHedging` ani `positionReconciler`), `server/localCopierExecutionAgent.ts:384` (větev metadata) a `updateGroupMetadata` na `:11395` v controlleru.
- **Scénář:** za ARM a s otevřenou kopií se pošle update-group s `autoCloseFollowerPositions:false`. Změna projde bez DISARM, bez kontroly flat a bez tighten-only. Leader-flat guard (řádek ~5700) čte `group.safety` za běhu, takže vypnutí platí okamžitě.
- **Důkaz:**
  - pre: `http=200 armed=false autoClose=false lastDisarm=manual`
  - post: `http=200 armed=true autoClose=false lastDisarm=-`, a stejně s `followerPos=[1]`
- **Oprava:** přidat přechody true→false u těchto příznaků do `isWeakerRiskConfig`. Metadata cestu udělat jako whitelist (name, color a safety pole krytá tighten-only); cokoli jiného má jít execution cestou.
- **Jistota:** vysoká.

**2. STŘEDNÍ – arm-live ze SHADOW ARM vrátí úspěch, ale kopírka zůstane ve SHADOW (A2)**
- **Kde:** `server/localCopierExecutionAgent.ts:671`. Nový druhý early-return kontroluje jen `current.armed`, ne `shadowMode`. SHADOW jde zapnout i přes relay (`tradovateCopierCommandRelay.ts:375`).
- **Důkaz:**
  - pre: `armCalls=[[{"shadowMode":false,...}]] final.shadowMode=false`
  - post: `ok=true armCalls=[] final.shadowMode=true`
- **Oprava:** podmínku rozšířit o `!current.shadowMode && !status().shadowMode`.
- **Jistota:** vysoká.

**3. STŘEDNÍ – zpřísnění execution konfigurace uprostřed obchodu se odmítne a ARM jede dál se starou expozicí (A3, A4)**
- **Kde:** `copierRuntimeController.ts:11203` a `:11211` (`preflightGroupChange` vyžaduje flat pro každou execution změnu). Agent `:384` a dál posílá vše přes `reconfigureGroup`. Uzavírání kopií v `tightenedCutClosures` (`:10529`) je tím v praxi mrtvé.
- **Scénář A3:** u aktivního let-run cutu uživatel přepne let-run → close-copy.
  - pre: `http=200 cutClosed=… followerPos=[0]`
  - post: `http=409 "blokuje probíhající obchodní lifecycle" armed=true followerPos=[1]`
- **Scénář A4:** snížení násobku 1 → 0,5 za otevřené pozice.
  - pre: 200, DISARM, násobek 0.5
  - post: `409 "lze uložit jen flat…" armed=true multiplier=1`
- Tohle odpovídá symptomu „nejde potvrdit“.
- **Oprava:** čistě zpřísňující změny followerů bez změny topologie nebo leadera (multiplier↓, maxContracts↓, mode→off, onCut→close-copy, cut↓) aplikovat in-place za ARM, serializovaně na `eventTail` a včetně `pendingCutClosures`, bez podmínky flat. Nevracet se k DISARM uprostřed obchodu: ten nechával exity kopií bez správy.
- **Jistota:** vysoká.

**4. STŘEDNÍ (dostupnost, fail-closed) – relay porovnává `enabled` z UI snapshotu, který worker záměrně ignoruje (R1, R2)**
- **Kde:** `server/tradovateCopierCommandRelay.ts:410-411` a `:423` spolu s `lib/copierRiskConfig.ts:161`. Worker v `mappedGroup` bere `enabled` z runtime, relay z neupraveného payloadu.
- **Scénář:** follower se vypne přepínačem. Pak jakékoli update-group (třeba přejmenování) nebo arm-live se skupinou ze staršího snapshotu vrátí do konce session 409 tighten-only.
- **Důkaz:**
  - pre: `error=- enqueued=1`
  - post: `error=tighten-only enqueued=0` (R1 i R2)
- **Oprava:** v `relayRiskGroup` namapovat `enabled` z `previousGroup` stejně jako `mappedGroup`. Kontrolu `enabled` dělat jen u set-follower-enabled.
- **Jistota:** vysoká pro relay, střední pro četnost v UI (komentář u `mappedGroup` stale snapshot výslovně předpokládá).

**5. NÍZKÁ – nekonzistence tighten-only (A5, stejné na obou verzích)**
- Relay odmítá set-follower-enabled=true v session, ale přes loopback projde (`setFollowerEnabled` na `:11235` nevolá `assertTightenOnly`). Výsledek: `off=200 on=200 armed=true`.
- Pravidlo pro mode odmítne i on-submit → on-fill, což může být legitimní zpřísnění.
- Relay u set-* příkazů vrací `invalid-relay-command-payload` nebo tighten-only i pro vypnutí followera, když status nese jinou skupinu (R3: pre prošlo, post odmítlo) nebo když je `status.group` nečitelný. Worker by u jiné skupiny odmítl taky, takže riziko to nezvyšuje.
- **Oprava:** jedna politika. Buď kontrolu tighten-only dělá i controller, nebo ji relay u re-enable nedělá. Zpřísňující příkazy (enabled=false, mode off) pustit bez previousGroup.

## Co jsem zkontroloval bez nálezu
- **TOCTOU:** příkazy jsou serializované přes `tail` a brzdy jen snižují riziko. Preflight se po preview opakuje, controller po DISARM všechno znovu ověří (scoped fence a kontrola po commitu). `updateGroupMetadata` znovu validuje. Drobnost: `assertFreshPreflight` po durable commitu (`:10550`) může vyhodit chybu až po zápisu clean state. Controller pak drží starou skupinu s vyčištěným stavem; účty byly ověřené flat a kopírka je DISARMED. Nízká, jistota střední.
- **Důvod config-change (A6):** v historii je přesně jeden záznam `config-change/config-change`; 5fbd034 zapisovala chybně `manual/manual`. UI text pro tento kód existuje.
- **Loopback log (`:839`):** loguje jen `source` a `type`, žádný payload ani token. Drobnost: `type` se loguje před validací, ale podvržený řádek do logu jde jen s platným nonce.

Soubory jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/b8-v1/`. Exporty b8-v1 a b8-v1-pre jsou smazané.
- `zzB8v1AgentProbe.test.ts` (A1, A2, A5, A6; stejné pro obě verze)
- `zzB8v1CutProbe.post.test.ts`, `zzB8v1CutProbe.pre.test.ts` (A3, A4, A1b)
- `zzB8v1RelayProbe.post.test.ts`, `zzB8v1RelayProbe.pre.test.ts` (R1, R2, R3)
## Čočka V3 + V15

**Balíček 8 (ab4b310) přes čočku V3 + V15: 6 nálezů, závažnost nejvýše střední.** Sondy nenašly cestu, kde by změna konfigurace za ARM prošla s neaktuálním routingem, ani cestu, kde by prošlo zvýšení expozice. Vyšly ale tři věci horší než 5fbd034:
- tichá změna ochranné pojistky za ARM (N4),
- zbytečná likvidace kopie přes prop-reserve (N1),
- nová odmítnutí v běžném toku (N2, N3).

**Test suite na b8-v3:** první běh skončil rc=1. Spadl jen časový test `copierFlatSweepV13` „B6/R6“ pod zátěží; samostatně prošel 3/3 na obou verzích. Druhý běh skončil **rc=0**: 170 souborů, 1957 testů prošlo, 1 soubor skipped, 1 todo.

**Ověřeno bez regrese (obě verze se chovají stejně, nebo nová lépe):**
- Fill + position leadera během REST čtení přepínače: obě verze odmítnou (sonda A2).
- Position event na nově přidávaném účtu během změny skupiny: obě odmítnou (sonda B).
- Heartbeat nebo event cizího účtu během změny skupiny: stará odmítne, nová projde. To je zamýšlená oprava (sonda C).
- Realizovaná ztráta se už nepočítá dvakrát; při −60 USD se nic nestane (sonda D(−60)).
- Bootstrap s neplatnou rezervou startuje DISARMED s důvodem a nepadá. Snapshot se filtruje na stejnou session, takže launchd smyčka nevzniká.

---

**N1 — STŘEDNÍ (peníze, latentní: `group.json` zatím nemá cuty). V15: nerealizovaná ztráta se pořád počítá dvakrát a teď vede k likvidaci kopie.**
- **Kde:** `services/copierRuntimeController.ts:2327–2351` (`propReserveViolation`), `:4381` (`propLimitUsd = netLiq − floor`, netLiq obsahuje otevřené P&L), periodický cut `:5365–5378`.
- **Scénář:** cut 200, počáteční rezerva 300, kopie v otevřené ztrátě −100.
  - Rezerva klesne na 200, ale zbývající prostor cutu zůstane 200, protože realizovaná ztráta je 0.
  - 200 > 190, takže se spustí prop-reserve cut a kopie followera se zavře.
  - Správně je zbývající prostor 100, tedy vůbec nic neměla spustit. Spouští se už kolem −90 USD, tedy asi 45 % cutu.
- **Důkaz:**
  - D(−100): stará verze vypne skupinu (`disarm: prop-limit`, bez likvidace). Nová nechá ARM, ale provede `liquidations: [200]`, `pos200: [0]`, cut `src: prop-reserve`.
  - D(−150): stejné chování.
- **Co cut dělá:**
  - `close-copy` (výchozí) kopii zlikviduje a vyřadí followera do konce session.
  - `let-run` pozici nechá otevřenou a přestane kopírovat, i exit leadera. Follower tak zůstane těsně nad likvidací bez řízení. To je jen úvaha, sondou neověřeno.
- **Oprava:**
  - Porovnávat `cut − realizovaná ztráta − max(0, −openPnL)` s 0,95 × rezervou, nebo počítat rezervu z cash (`cashBalanceUsd − floor`).
  - Při prop-reserve s `let-run` zvážit vynucené close-copy.
- **Jistota:** vysoká.

**N2 — STŘEDNÍ (uživatelův symptom „nejde potvrdit“). Relay po prvním ARM session odmítne znovuzapnutí followera a změnu replikace.**
- **Kde:**
  - `lib/copierRiskConfig.ts:161–167`: `enabled false→true` a jakákoli změna `mode` kromě na `off` se počítá jako oslabení.
  - `server/tradovateCopierCommandRelay.ts:405–449` a `:481–484`.
  - Worker na loopbacku tutéž změnu pustí (`server/localCopierExecutionAgent.ts:480–491`, bez tighten-only kontroly).
- **Scénář:** po jakémkoli ARM, i když je teď DISARMED (například po samovolném vypnutí), nejde z webu zapnout follower až do konce session. Stejně neprojde ani on-submit→on-fill, což je spíš zpřísnění.
- **Důkaz (relay):**

| Sonda | 5fbd034 | ab4b310 |
|---|---|---|
| R1 znovuzapnutí followera | enqueued | `rejected: tighten-only` |
| R3 on-submit→on-fill | enqueued | `rejected: tighten-only` |
| R2 vypnutí, R4 snížení násobku | enqueued | enqueued |
| R5 zvýšení násobku | enqueued | `rejected: tighten-only` (zamýšleno) |

- **Oprava:** rozhodnout, co platí. Pokud platí design `setFollowerEnabled` (zapnutí jen při ověřeném flat, bez DISARM), vyjmout `enabled` z tighten-only. U `mode` označovat za oslabení jen off→on a on-fill→on-submit. Relay a worker sjednotit.
- **Jistota:** vysoká (možná jde o záměrnou politiku, ale chybí rozhodnutí a je v rozporu s loopbackem).

**N3 — NÍZKÁ až STŘEDNÍ. Jakákoli změna ovlivňující provádění se odmítne, pokud kterýkoli účet skupiny není flat. Týká se i zpřísnění.**
- **Kde:** `copierRuntimeController.ts:11199–11212` (`preflightGroupChange`). V `reconfigureLeaderEpoch` je `tightenedCutClosures` teď mrtvý kód, protože vše musí být flat.
- **Scénář:** přidání cutu, snížení násobku nebo vypnutí followera přes update-group během obchodu.
- **Důkaz (E):**
  - Stará verze změnu uloží a vypne kopírku (`disarm: manual`, nic nezavře).
  - Nová ji odmítne: `lze uložit jen flat… nonFlat=100,200,300`, ARM zůstane se starou volnější konfigurací.
- Riziko se nezvyšuje, uživatel dostane chybu. Je to ale nové odmítnutí zpřísnění.
- **Oprava:** zpřísnění (tighten-only v opačném směru) pouštět bez podmínky flat, případně s DISARM.
- **Jistota:** vysoká.

**N4 — STŘEDNÍ (nový tichý stav ARMED s oslabenou ochranou). Metadata cesta mění bezpečnostní boolean pojistky za ARM, uprostřed pozice a bez DISARM.**
- **Kde:**
  - `sameExecutionConfiguration` (controller `:708`, agent `:156`) ignoruje `safety`.
  - `isWeakerRiskConfig` nekontroluje `autoCloseFollowerPositions`, `preventHedging`, `positionReconciler` ani `disableReplicationOnBreach`.
  - `autoCloseFollowerPositions` přitom používá leader-flat guard (`:5700`).
- **Důkaz (G):** nová verze při otevřené pozici leadera `updateGroupMetadata` přijme, `armed: true`. Stará cesta agenta vždy nejdřív volala `disarm()`.
- **Oprava:** zahrnout tyto safety booleany do `sameExecutionConfiguration`, nebo přechod true→false označit v `isWeakerRiskConfig` jako oslabení.
- **Jistota:** vysoká pro `autoCloseFollowerPositions`. U ostatních tří jsem nenašel použití v runner/engine/riskGate.

**N5 — NÍZKÁ. Přepínač followera se potvrdí, i když během durable zápisu přijde výpadek spojení.**
- **Kde:** `copierRuntimeController.ts:11280–11294` a `:11316–11322`. `connectionSyncGeneration` roste až v handleru, na ingressu ne. Kontrola `brokerObservationVersion` z přepínače zmizela.
- **Důkaz (A):**
  - Stará verze změnu odmítne a vrátí zápis zpět (`persistCalls: 2`).
  - Nová ji potvrdí (`persistedEnabled200: false`).
  - Obě pak skončí `transport-lost`, tedy DISARMED.
- **Oprava:** počítadlo verze pro connection/error eventy na ingressu a kontrolovat ho v `assertUnchanged`.
- **Jistota:** vysoká (dopad malý).

**N6 — NÍZKÁ. Signál resyncu z routeru se už nepromítne do kontroly změny stavu.**
- **Kde:** `services/brokerRouter.ts:228–231` a `:332` převádí plánovaný resync na `heartbeat`. Controller `:10758–10764` heartbeat teď ignoruje.
- **Scénář:** mezera při obnově socketu mezi posledním REST čtením a aplikací změny. Controller resync bez obchodních eventů nerozliší od keepalive.
- **Důkaz:** v C nová verze přijme heartbeat během čtení, stará odmítne. Skutečný výpadek (`connection` event) dál odmítá v obou.
- **Oprava:** router posílá resync jako samostatný příznak (`resynced`) a controller na něj zvýší verzi kontroly.
- **Jistota:** střední.

**Nesondovaná hypotéza (nízká).** `maybeReleaseManualTradeCuts` (`:5208`) zkouší `pendingBrokerEvents > 1`. Počítá s tím, že se právě zpracovávaný event započítává, ale heartbeat se teď nepočítá. Z heartbeat cesty tak projde uvolnění s jedním obchodním eventem ve frontě. REST čtení to zmírňuje. Oprava: v heartbeat cestě zkoušet `> 0`.

Odpovědi k otázkám (1)–(3):
- Otevřenou pozici chrání dvojí REST flat kontrola a verze kontroly po jednotlivých účtech (leader + follower). Obchodní event, který se právě zpracovává, se sice mezi čekající nepočítá, ale zachytí ho živé pozice a příkazy nebo REST.
- Přepínač projde s čekajícím eventem jen tehdy, když jde o jiný účet než leader a přepínaný follower. To je neškodné.

Sondy a jejich výstupy:
- `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/b8-v3/probeB8v3Controller.test.ts`
- `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/b8-v3/probeB8v3Relay.test.ts`
- `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/b8-v3/out-pre.txt`
- `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/b8-v3/out-new.txt`

Oba exporty jsem smazal. Worktree zůstal beze změny.