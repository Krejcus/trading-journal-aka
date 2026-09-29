# Adversariální review balíčku brzd/relay (commit 15ae535)

## Čočka brakes-arm

# Review 15ae535, čočka brzdy a ARM

Našel jsem 4 vysoké, 2 střední a 4 nízké nálezy. Nejvážnější je N1: brzda může skončit dřív než starší ARM, takže kopírka zůstane ARMED i po DISARM. Druhý nejvážnější je N2: ARM hlásí úspěch s jinou skupinou, než o kterou uživatel žádal. Celá sada v exportu prošla: 125 souborů, 1522 testů. Nálezy N1 až N5 jsem ověřil pěti testy v `tests/zzReviewBrakesArm.test.ts`. Všech pět prošlo, tedy vadné chování se opravdu projeví.

Export je v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/agent-brzdy-arm`. Worktree zůstal nedotčený.

---

**N1 — VYSOKÁ: DISARM předběhne čekající ARM ve frontě, ARM pak proběhne po brzdě a výsledek je ARMED**
- **Kde:** `server/tradovateCopierCommandRelay.ts:620-647` (prioritní claim) a `:471-487` (zařazení brzdy nezruší čekající `arm-live`); `server/localCopierExecutionAgent.ts:724` (epocha brzd se zachytí až při příchodu ARM do agenta).
- **Scénář:**
  1. Běžná fronta (v2) vykonává dlouhý příkaz, typicky Flatten nebo `update-group`, nebo je po chybách v backoffu až 5 s. Stačí i DISARM do jednoho round-tripu po ARM.
  2. Uživatel klikne ARM a řádek čeká jako `pending`. Pak klikne DISARM.
  3. Prioritní linka DISARM vykoná hned, epocha se zvýší.
  4. Fronta pak vyzvedne starší ARM. Ten ještě nevypršel, zachytí si už novou epochu a zapne kopírku.
- **Proč je to regrese:** Dřív striktní FIFO zaručovalo DISARM až po ARM.
- **Podobná cesta na lokálním HTTP:** Na `:781` se epocha i pořadí řídí dokončením `await body(request)`, ne pořadím příchodu requestů. Tuto variantu jsem neověřil testem.
- **Důkaz:** Test R1 se skutečným agentem a skutečným mac relay: pořadí flatten → disarm → arm, na konci `armed=true`.
- **Oprava:**
  - (a) Zařazení brzdy jako RPC pod stejným advisory lockem jako `claim_v2` (`hashtextextended(device,917)`), které všechny `pending` `arm-live`/`shadow` daného zařízení označí `expired` s důvodem `superseded-by-brake`.
  - (b) Pojistka ve workeru: posílat do agenta serverové `created_at`, držet `lastBrakeCreatedAt` a odmítnout ARM s `createdAt ≤ lastBrakeCreatedAt`. Prioritní claim musí vracet `created_at`.
  - (c) Na HTTP zachytit epochu synchronně při příchodu requestu.
- **Jistota:** vysoká. Pravděpodobnost nízká až střední.

**N2 — VYSOKÁ: Idempotentní ARM ignoruje obsah příkazu a hlásí falešný úspěch s jinou skupinou nebo exclusions**
- **Kde:**
  - `localCopierExecutionAgent.ts:511-517` a `:718`: no-op, pokud je `armed && !shadowMode`.
  - `tradovateCopierCommandRelay.ts:549-565` a `:517-546`: dedup a coalesce připojí ARM(B) k rozpracovanému ARM(A) bez porovnání obsahu.
- **Scénář:**
  1. Skupina A je ARMED a flat. UI (`LiveCopyTradeOverview.tsx:1122,1193`) nabízí „switch and arm“ na skupinu B, protože pro B vychází `powered=false`.
  2. Agent vrátí úspěch a UI ukáže toast „Copier je připojený — příkazy leadera se kopírují naostro“ (`:1064-1067`).
  3. A přitom kopíruje dál a B není zapnutá.
  4. Stejně tak nová DLL exclusion (`dll-locked`) se neaplikuje.
- **Proč je to regrese:** Base v tomto případě skupinu přepnul (disarm → activate B → arm).
- **Důkaz:** Testy R2 (`activateGroup` se nezavolá, `status.group` zůstane A) a R3 (`applyAccountEligibilityExclusions` se nezavolá).
- **Oprava:**
  - Agent: no-op jen tehdy, když se sanitizovaná `command.group` (po `mappedGroup`) rovná aktuální skupině a exclusions jsou podmnožinou už aplikovaných. Jinak explicitně odmítnout („ARMED s jinou konfigurací, nejdřív DISARM“).
  - Relay: připojit se k rozpracovanému ARM jen při shodném payloadu, jinak vrátit 409.
- **Jistota:** vysoká.

**N3 — VYSOKÁ (dostupnost, závisí na produkčních datech): Jakýkoli starý `claimed` ARM natrvalo unese každý nový ARM**
- **Kde:** `tradovateCopierCommandRelay.ts:559` a `:530`: filtr `status.eq.claimed` nemá žádný časový limit. Na rozdíl od Flattenu chybí 5minutové okno.
- **Scénář:**
  1. V tabulce zůstal legacy `claimed` ARM. Komentář migrace `20260913154140` říká, že se legacy claimed řádky úmyslně neuklízejí. Tehdejší v1 neměl opakování ACK. Stejně tak vznikne při ztrátě checkpointu.
  2. Když párování zachovává `device_id`, enqueue ARM vrátí starý řádek s `expiresAt` v minulosti.
  3. Deadline v UI `min(expiresAt+5s, now+35s)` (`services/tradovateOAuthConnection.ts:311-313`) už uplynul, takže UI hned ohlásí „Mac worker příkaz včas nepotvrdil“.
  4. Coalesce navíc nový ARM expiruje jako `duplicate-arm-superseded`.
  5. Výsledek: ARM přes relay (telefon) je po nasazení nemožný. Je to fail-closed, ale jde o výpadek.
- **Ověřit dotazem:**
  ```sql
  select id, device_id, created_at, expires_at, claimed_at
  from tradovate_copier_commands
  where command_type = 'arm-live' and status = 'claimed'
  order by created_at;
  ```
- **Oprava:** Brát `claimed` jen s `expires_at > now − rezerva` (agent stejně nezapne ARM po `expires`). Totéž v coalesce.
- **Jistota:** kód vysoká, dopad střední (závisí na datech).

**N4 — VYSOKÁ: Prioritní linka doručí brzdu nejvýš jednou; ztracená odpověď na `poll-priority` brzdu pohřbí**
- **Kde:** `tradovateCopierCommandRelay.ts:620-647`, `macCopierCommandRelay.ts:258`.
- **Scénář:**
  1. Server brzdu claimne (commit proběhne) a worker odpověď ztratí nebo vyprší timeout 20 s. To je přesně případ pomalého API ze 17. 9. (odpovědi 12–20 s).
  2. Řádek zůstane `claimed` navždy a brzda se nikdy neprovede.
  3. Fronta v2 ho nevyzvedne, protože bere jen `pending` a řádek nemá `delivery_id`.
- **Proč je to regrese:** Dřív to v2 obnovil přes perzistovaný `deliveryId`.
- **Důkaz:** Kód; test R5 to modeluje.
- **Oprava:**
  - Brzdy jsou idempotentní, stačí doručení aspoň jednou. Buď prioritní `deliveryId` v RPC jako u v2, nebo znovudoručit `claimed` řádky bez `delivery_id` a bez `completed_at` starší než pár sekund.
  - Agent deduplikuje podle id příkazu v rámci procesu.
  - Přeskočit brzdy starší než start workeru, jako to dělá v2.
- **Jistota:** vysoká (mechanismus).

**N5 — STŘEDNÍ: Opakovaný ACK prioritní linky ji natrvalo zasekne**
- **Kde:** `macCopierCommandRelay.ts:254-257, 276-277`; `api/tradovate/oauth/copier-relay.ts:294`; `tradovateCopierCommandRelay.ts:673-684`.
- **Scénář:**
  1. Legacy `complete` není idempotentní: dělá `update ... where status='claimed'`.
  2. Server ACK zapíše, ale odpověď se ztratí. Opakovaný pokus dostane `accepted:false` a HTTP 409, takže vyhodí chybu.
  3. `pendingPriorityAck` se opakuje před každým pollem, takže linka už nikdy nepolluje až do restartu workeru.
  4. Brzdy tiše spadnou zpět do FIFO. Log se objeví jen při 1. a každém 20. selhání.
- **Důkaz:** Test R4: `completes ≥ 3`, `priorityPolls = 1`, druhá brzda nikdy nedorazí.
- **Oprava:** Při opakování ACK brát 409/`accepted:false` jako konečný stav a zahodit ho. Nebo udělat `complete` idempotentní jako `complete_v2`. ACK nesmí blokovat poll.
- **Jistota:** vysoká.

**N6 — STŘEDNÍ: ARM deadline nemá rezervu na ACK a lokální deadline z hlavičky nemá strop**
- **Kde:** `recoverableCopierDelivery.ts:63-65`, `macCopierCommandRelay.ts:338-340`, `tradovateOAuthConnection.ts:311-313`.
- **Scénář:**
  1. Worker má deadline přesně `expiresAt` (porovnává serverový čas se svými hodinami). UI to vzdá v `expiresAt + 5 s`.
  2. ACK (2× fsync + `complete-v2` s timeoutem 20 s) snadno trvá přes 5 s.
  3. UI pak ukáže „Zapnutí kopírky není potvrzené“, zatímco kopírka je ARMED. Posun hodin workeru vůči serveru se přičítá přímo.
- **Lokální cesta:** Hlavička `X-AlphaTrade-Command-Deadline` (`localCopierExecutionAgent.ts:786-790`) nemá strop. Jakýkoli povolený origin tak znovu otevře ARM bez horní meze.
- **Oprava:**
  - `deadlineAt = expires − rozpočet na ACK` (aspoň 10 s), a/nebo UI u ARM čeká aspoň `expiresAt + 25 s` a při timeoutu přečte stav.
  - Hlavičku omezit na nejvýš `now + 30 s`.
- **Jistota:** střední.

**N7 — NÍZKÁ: ACK prioritní linky jde nechráněnou cestou**
- **Kde:** `copier-relay.ts:258-262`, `tradovateCopierCommandRelay.ts:690-695`.
- **Scénář:** Legacy `complete` zapisuje runtime status bez revize. Opožděný ACK od DISARM může na ≤ 2 s přepsat novější snímek (třeba po novém ARM) a poslat opožděný push `arm-ended`.
- **Oprava:** ACK přes chráněné RPC ve stylu v2.

**N8 — NÍZKÁ: Pětiminutová TTL brzd bez kontroly stáří vůči startu workeru**
- **Scénář:** Brzda, kterou UI po 35 s ohlásí jako nepotvrzenou, se může provést o minuty později, například po výpadku relay, když mezitím proběhl ARM přes loopback. Pro DISARM je to bezpečný směr. Kill switch ale nečekaně zmrazí celou session.
- **Drobnosti:**
  - Commit tvrdí, že brzdy ve frontě „nikdy nevyprší“; po 5 minutách ale vyprší.
  - Telemetrie v1 počítá s 30s TTL (`macCopierCommandRelay.ts:329`).

**N9 — NÍZKÁ: Prioritní poll každých 750 ms zvedne zátěž API**
- Přidá zhruba 1,3 požadavku za sekundu na worker (auth + select + update), tedy asi +45 % oproti dnešku. Zátěž míří na DB pool, který se 17. 9. vyčerpal.
- Kick už prioritní linku probouzí, stačil by interval 3–5 s (`macCopierCommandRelay.ts:287`).

**N10 — NÍZKÁ, neověřeno: Denní lock může přepsat novější bezpečnostní stav**
- **Kde:** `copierRuntimeController.ts:3165` přes `:2257`.
- **Scénář:** `maybeEngageDayLock` ukládá zachycený snapshot `safety`, ne funkční update. Lock teď běží souběžně s ARM a konfigurací (dřív sériově). Může tak přepsat čekající `persistRiskSafety`, například `sessionArmedAt`. Po restartu pak chybí tighten-only spodní mez.
- **Oprava:** `persistSafetyUpdate(current => ({ ...current, dayLock... }))`.

---

**Co jsem ověřil a je v pořádku**
- **Dvojí vykonání:** Prioritní claim (podmíněný update) proti `claim_v2` (`FOR UPDATE SKIP LOCKED`) nikdy nevykoná stejný řádek dvakrát.
- **Brzda během ARM v agentovi:**
  - Deadline i epocha se kontrolují po každém await.
  - Po selhání durable potvrzení se volá `disarm()`.
  - Mezi posledním assertem a `arm()` není žádný await (ř. 556-564).
  - Kill switch i day-lock navíc blokuje sám `controller.arm` (ř. 9578 a 9596).
- **ARM čekající v lokální frontě:** Epocha se zachytí při přijetí, deadline se kontroluje na startu, brzda vyhraje.
- **Restart s ARM ve v2 outboxu:** Výsledek „outcome unknown“, žádné opakované vykonání; příkazy starší než session se odmítnou.
- **Shadow ARM** se nebere jako idempotentní.
- **Dedup nikdy nesahá na brzdy:** jen typy Flatten a ARM, idempotency klíče jsou náhodné.
- **Kill switch před čekajícím Flattenem:** `emergencyFlatten` nemá bránu na kill switch, Flatten proběhne.
- **Kompatibilita:**
  - Nový relay se starým workerem: brzdy zůstanou ve FIFO a pořadí platí; ARM brána čte heartbeat, OK.
  - Nový worker se starým relay: `poll-priority` dostane 400 a backoff, brzdy jdou přes v2, OK.
- **Dev originy:** DISARM, kill switch i Flatten zůstávají povolené.

**Testy (export):**
- Repro `tests/zzReviewBrakesArm.test.ts`: 5/5 prošlo, tj. všech pět vad (N1–N5) se reprodukuje.
- Celá sada `npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier tests/recoverableCopierDelivery.test.ts`: 125 souborů, 1522 testů, vše prošlo. PROJECT_LOG uvádí 136 souborů / 1619 testů, zřejmě jde o širší výběr.

## Čočka compat-security

## Adversariální review 15ae535: kompatibilita a bezpečnost

**Verdikt:** 7 nálezů, z toho 3 bezpečnostní regrese u brzd prokázané PoC testem a 1 funkční regrese v párování. Commit bych v téhle podobě nenasazoval.

Export je v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/agent-kompat`. Srovnávací export base 90cee98 je v `…/scratchpad/agent-kompat-base`. Worktree jsem neměnil.

PoC testy (jsou jen v exportu):
- `tests/zzKompatPoc.test.ts`: 3 testy, všechny prošly, tedy chyby jsou potvrzené.
- `tests/zzKompatPocArm.test.ts`: 1 test, prošel.
- `agent-kompat-base/tests/zzKompatPocBase.test.ts`: stejný scénář jako první PoC; na base končí DISARMED.

Povinná sada v exportu (`npx vitest run tests/copier tests/pendingEntryProtection.test.ts tests/tradovate tests/localCopier tests/macCopier tests/recoverableCopierDelivery.test.ts`): **125 souborů / 1522 testů passed**. Moje PoC soubory do ní nespadají.

### N1 — VYSOKÁ: DISARM předběhne dříve zařazený ARM a kopírka skončí ARMED
- **Kde:**
  - `server/tradovateCopierCommandRelay.ts:620-647`: prioritní claim bere brzdu mimo pořadí.
  - `:420-510`: enqueue brzdy nechá čekající `arm-live` beze změny.
  - `server/localCopierExecutionAgent.ts:724`: `admittedBrakeEpoch` se čte až při dispatchi.
- **Scénář:**
  1. FIFO linka právě provádí dlouhý Flatten (17. 9. to bylo 265 s).
  2. Uživatel klikne ARM, ten čeká ve frontě jako pending.
  3. Uživatel si to rozmyslí a klikne DISARM.
  4. Prioritní linka vykoná DISARM hned.
  5. Po Flattenu FIFO linka převezme starší ARM. Ten dostane už zvýšený epoch, projde a kopírka se zapne.
  
  Na base je pořadí FIFO (ARM, pak DISARM) a výsledek je DISARMED. Stejný problém nastane bez Flattenu, když ARM a DISARM přijdou do ~1 s: obě linky probudí tentýž kick a záleží jen na tom, která HTTP odpověď dorazí dřív.
- **Důkaz:** PoC 1 končí `armed:true`, na base `armed:false`.
- **Oprava:**
  - Při enqueue i při claimu brzdy ve stejném kroku expirovat pending `arm-live`/`shadow` vytvořené před brzdou (`error='superseded-by-brake'`).
  - Ve workeru předat do kontextu ARM serverové `createdAt` a odmítnout ARM starší než poslední provedená brzda.
- **Jistota:** vysoká.

### N2 — VYSOKÁ: prioritní linka vrací ztrátu brzdy, kterou oprava z 13. 9. odstranila
- **Kde:** `server/tradovateCopierCommandRelay.ts:637-646` (claim bez `delivery_id`) a `server/macCopierCommandRelay.ts:258`.
- **Scénář:**
  1. Server provede UPDATE na `claimed`.
  2. Odpověď se ztratí: timeout 20 s (`RELAY_STATUS_TIMEOUT_MS`), přesně stav produkce 17. 9. s odezvami 12–20 s.
  3. Řádek zůstane `claimed` navždy. v2 RPC ho nevrátí (obnovuje jen podle `delivery_id`) a prioritní poll ho už nevidí.
  
  Brzdy teď většinou vyzvedne jako první právě prioritní linka, takže jdou po neobnovitelném transportu. Je to přesně mechanismus „nedělní DISARM bez provedení“ z `docs/COPIER_RELAY_RECOVERY_20260913.md:7-9`.
- **Důkaz:** PoC 2: po ztracené odpovědi je DISARM trvale `claimed` a nikdy se neprovede.
- **Oprava:** udělat prioritní linku obnovitelnou jako v2.
  - Vlastní durable `delivery_id` (druhý checkpoint soubor).
  - RPC `claim_tradovate_copier_priority_command_v2`, které nejdřív vrátí řádek podle `delivery_id`.
  - ACK přes `complete-v2`.
- **Jistota:** vysoká.

### N3 — STŘEDNÍ/VYSOKÁ: jeden ztracený ACK prioritní linku zasekne až do restartu
- **Kde:** `server/macCopierCommandRelay.ts:254-257, 276-277` a `api/tradovate/oauth/copier-relay.ts:294`.
- **Scénář:**
  1. První `complete` se na serveru zapíše, ale odpověď vyprší.
  2. Retry `pendingPriorityAck` dostane od v1 `complete` odpověď `409 {accepted:false}`, protože řádek už není `claimed`. v1 ACK není idempotentní.
  3. Smyčka se točí donekonečna a `poll-priority` se už nikdy nezavolá.
  
  Brzdy pak tiše padají zpět do FIFO a čekají za ARM/Flattenem. Komentář „ACK se může transportně opakovat“ proto neplatí.
- **Důkaz:** PoC 3: po zaseknutí je 0 dalších prioritních pollů a druhý DISARM zůstává pending.
- **Oprava:**
  - ACK přes idempotentní `complete-v2` (viz N2).
  - Nebo alespoň brát `accepted:false` s terminálním stavem shodného výsledku jako hotový ACK.
  - Nikdy neblokovat poll kvůli neuzavřenému ACK.
- **Jistota:** vysoká.

### N4 — VYSOKÁ funkčně (bez rizika pro obchod): ST34 zablokuje novou instalaci, přidání připojení i znovuspárování
- **Kde:**
  - `api/tradovate/oauth/pilot-lease.ts:44-57`
  - `components/TradovateLiveDesk.tsx:1216-1230`: UI chce `pilot-public.pem`.
  - `scripts/copier/mac-install.ts:158-166, 299-306`: `--lease` je povinný a kontroluje se před vytvořením zařízení.
  - Dokumentovaný postup je v `docs/COPIER_MAC_RUNTIME.md` a `docs/COPIER_MORNING_PILOT_2026-08-17.md:28-31`.
- **Scénář:** postup je keygen → ruční stažení lease pro `pilot-public.pem` → `install/add-connection --lease` → worker DISARMED → párování klíčem. Lease je teď sealovaný jen na klíč už spárovaného zařízení. Pilotní klíč spárovaný nikdy není a klíč zařízení (`mac-device-public.pem`) vzniká až v instalátoru a spáruje se až po startu workeru. Výsledek je 403 `pilot-key-not-paired` a kruhová závislost.
- **Co to nerozbije:** běžící spárované workery (obnova lease přes Device auth) a reinstall spárovaného zařízení (paired větev lease nepotřebuje, `pilot.ts:1205-1217`).
- **Oprava:** dovolit start nespárovaného zařízení bez lease (read-only, DISARMED) a lease vydávat až přes Device auth po spárování. Nebo JWT lease jen pro klíč v potvrzeném pairing requestu, s krátkým TTL a bez obnovy. Upravit texty v UI a dokumentaci.
- **Jistota:** vysoká pro stažení s `pilot-public.pem`; střední pro úplný deadlock. Úsek `pilot.ts:1180-1204` jsem nemohl přečíst (klasifikátor čtení zamítl).

### N5 — STŘEDNÍ: starý `claimed` ARM pohltí každý další ARM přes relay
- **Kde:** `server/tradovateCopierCommandRelay.ts:559` (`findInFlightArm`) a `:530` (`coalesceInsertedArm`). Podmínka `status.eq.claimed` nemá žádné časové okno; Flatten má okno 5 minut.
- **Scénář:** stačí jeden osiřelý `claimed` arm-live pro aktuální zařízení. Mohou to být legacy v1 řádky („Původní `claimed` bez delivery ID se nikdy automaticky neobnovují“, migrace 20260913 ř. 1), nebo reinstall se ztraceným delivery store. Každý ARM z telefonu se pak přichytí k němu, nic se nezařadí a `expiresAt` je v minulosti. UI tak hned hlásí „nepotvrdil“. Selže to bezpečně (fail-closed), ale ARM z telefonu přestane fungovat.
- **Důkaz:** `zzKompatPocArm`: upsert se nezavolá, vrátí se starý řádek a dotaz nemá `gt`/`gte`.
- **Oprava:** filtr `in(status,[pending,claimed]) and expires_at > now`. Nový worker s deadlinem stejně nemůže po `expires_at` zapnout.
- **Jistota:** vysoká pro kód. Stav produkce neověřen, read-only dotaz do produkční DB klasifikátor zamítl. Doporučený dotaz pro Filipa: `select command_type, delivery_id is null, count(*) from tradovate_copier_commands where status='claimed' group by 1,2;`

### N6 — STŘEDNÍ, existovalo už před commitem (ST35 ho neřeší): dvě živá zařízení na jednom připojení
- **Kde:** `server/tradovateCopierCommandRelay.ts:125-153`.
- **Scénář:** při dvou workerech (MacBook + Mac mini, nebo Mac + VPS při migraci) se nejčerstvější heartbeat střídá co ~2 s. ARM tak může jít na A a DISARM na B; A zůstane ARMED, zatímco UI ukáže DISARMED status B. Registrace jiná zařízení nerevokuje (`server/tradovateCopierDevice.ts:40-88`) a Mac worker nepoužívá fencing lease.
- **Restart téhož zařízení je OK:** stejný `device_id` a `heartbeat_tradovate_copier_v2` hlídá `started_at`. Nechráněný v1 upsert z prioritního ACK se opraví do 2 s.
- **Oprava:** brzdy rozeslat všem nerevokovaným zařízením připojení; ARM odmítnout, když má čerstvý heartbeat víc než jedno zařízení.
- **Jistota:** střední (záleží na tom, zda jde o reálnou konfiguraci).

### N7 — NÍZKÁ/STŘEDNÍ: dev originy
- **Produkční LIVE (`https://alphatrade-mentor-15.vercel.app`) dotčený není.** Web na Macu zkouší loopback jako první (`TradovateLiveDesk.tsx:688-698`) a produkční origin má dál plný přístup. Telefon jde přes relay.
- **localhost:3000** (jediné UI, které loopback používá vždy) ztratí ARM, shadow, update-group, reconcile, unlock a device-paired. Chyba 409 se ukáže bez fallbacku na relay (`TradovateLiveDesk.tsx:515-521`).
- **Flag se nedá rozumně zapnout:** `ALPHATRADE_COPIER_ALLOW_FULL_DEV_ORIGINS` se čte jen z `process.env` (`localCopierExecutionAgent.ts:204-205`), ale plist instalátoru má pevné `EnvironmentVariables` (`mac-install.ts:368-371`). Reinstall ruční úpravu přepíše.
- **Rozbije se i** `scripts/copier/shadow.ts:38,87` (`shadow on` s Originem `127.0.0.1:3000`). Párování z localhost dokončí worker sám (`pilot.ts:1021`), UI ale ukáže falešnou chybu.
- **Funguje dál:** `mac-reinstall-safe.sh`, protože čte jen status.
- **Oprava:** flag `--allow-full-dev-origins` v instalátoru propsat do plistu; shadow skript upravit nebo zdokumentovat.
- **Jistota:** vysoká.

### Kompatibilita při odděleném nasazení
- **Nový server + starý worker (1802df6, v2 transport):**
  - Funguje: DISARM i ostatní příkazy (v2 FIFO vyzvedne i prioritní typy); brzdy mají TTL 5 min, což je bezpečné; `controller.connected` ve statusu existuje, ARM gate proto funguje.
  - Neplatí ale: deadline ARM ani „brzda vyhrává“ — starý worker deadline nezná a může zapnout i po hlášce UI „nepotvrdil“ (UI deadline je `min(expiresAt+5 s, now+35 s)`, `services/tradovateOAuthConnection.ts:311-313`).
  - Bezpečnostní záruka ARM platí až po redeployi workeru.
- **Nový worker + starý server:**
  - `poll-priority` dostává 400 `invalid-copier-relay-action`: backoff do 5 s, log při 1. a každém 20. selhání, starý server při tom sahá na `last_used_at`.
  - Brzdy jdou přes v2 FIFO, relay se nezasekne a DISARM z telefonu funguje, jen bez priority.
  - Doporučené pořadí nasazení: nejdřív web, potom worker.

### Drobnosti (nízká závažnost)
- `copier-relay-runtime-not-found` je v mapperu jako 409, ale `copier-relay.ts:354` (`endsWith('not-found')` → 404) ho zachytí dřív, takže mapování nikdy neplatí.
- Když je nejčerstvější runtime řádek revokované zařízení, DISARM vrátí 404, i když existuje jiné nerevokované zařízení. Revokované by se mělo filtrovat už v prvním dotazu.
- TTL brzdy 5 min proti hlášce UI po 35 s „Příkaz nebude automaticky opakován“: prioritní linka nekontroluje `created < startedAt` (v2 ano). Brzda se tak může provést minuty po tom, co UI ohlásilo neúspěch, třeba po restartu workeru. Směr je bezpečný, ale text UI tím přestává odpovídat skutečnosti.

### Ověřeno bez nálezu
- Souběh prioritního claimu a v2 RPC: podmíněný UPDATE plus `for update skip locked`, žádné dvojí provedení.
- `nativeSnapshotTest` má připnutý `deviceId`.
- Worker s Device auth na pilot-lease dotčený není.
- CORS preflight z produkčního originu včetně nové hlavičky.
- Starý iOS bundle s novým serverem: ARM odmítnutý 409, DISARM prochází.