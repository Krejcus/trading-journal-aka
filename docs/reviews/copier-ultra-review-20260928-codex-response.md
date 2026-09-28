# Oponentura Codexe k ultra review kopírky — 28. 9. 2026

Zadání: `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/d5f2c4c3-1043-4984-aed6-5dc2a0a45075/scratchpad/review/codex-consult-prompt.md` (codex exec, read-only). Posuzovaný report: [copier-ultra-review-20260928.md](copier-ultra-review-20260928.md).

Stav workeru jsem nedokázal potvrdit: jediný povolený dotaz na `/v1/status` vrátil prázdné tělo. Proto jsem postupoval, jako kdyby byl `armed=true`: žádné testy, simulace, `journal.jsonl`, stderr ani brokerové API. Níže tedy odděluji jistoty z kódu a malého stdout logu od tvrzení, která zůstávají hypotézou.

## Verdikty V1–V18

| Nález | Verdikt | Moje závažnost | Důkaz a poznámka |
|---|---|---:|---|
| V1 | **SOUHLASÍM** | vysoká | Agent nejprve provede `disarm()` a teprve potom validuje změnu skupiny; neúspěšná konfigurace tak vypne zdravou skupinu. [localCopierExecutionAgent.ts:290](/Users/filipkrejca/Documents/trading-journal-aka/server/localCopierExecutionAgent.ts:290), [copierRuntimeController.ts:8997](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:8997) |
| V2 | **ZPŘESNIT** | střední, v kombinaci s V1 vysoká | Editor může vidět účet, který workerova OAuth relace nevidí. To je skutečný provozní problém, ale ranní stav už nemusí být aktuální a samotné odmítnutí je fail-closed. [dynamicBrokerRouting.ts:74](/Users/filipkrejca/Documents/trading-journal-aka/services/dynamicBrokerRouting.ts:74) |
| V3 | **SOUHLASÍM** | střední | Každý event včetně heartbeat zvyšuje obecný `brokerObservationVersion`; follower toggle pak blokuje i netrade ruch. Samotné čekání je střední problém, V1 z něj dělá rizikové vypnutí skupiny. [copierRuntimeController.ts:8853](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:8853), [copierRuntimeController.ts:9292](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:9292) |
| V4 | **SOUHLASÍM** | kritická | Leader-flat guard je svázán se `safetyGeneration`; běžný DISARM generaci změní a guard tiše skončí. To odporuje komentáři, že durable guard zůstává aktivní. [copierRuntimeController.ts:5163](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:5163), [copierRuntimeController.ts:9009](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:9009) |
| V5 | **SOUHLASÍM** | vysoká | Samostatný SL není zařazen mezi bracket/OSO protective ordery a cancel lifecycle nekontroluje DISARM ani kill latch. Po obdržení leader cancelu tedy může být follower SL odstraněn. [copierRunner.ts:1374](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRunner.ts:1374), [copierRiskGate.ts:157](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRiskGate.ts:157) |
| V6 | **ZPŘESNIT** | vysoká | Broker emituje `resynced`, router jej v grace okně zahodí. Signální mezera je prokázaná; konkrétní ztracený obchod z produkce nikoli. [tradovateBroker.ts:1218](/Users/filipkrejca/Documents/trading-journal-aka/services/tradovateBroker.ts:1218), [brokerRouter.ts:299](/Users/filipkrejca/Documents/trading-journal-aka/services/brokerRouter.ts:299) |
| V7 | **SOUHLASÍM** | střední | REST může fill označit jako známý dříve, než jej websocket předá controlleru; pozdější event je deduplikován. Dopad je hlavně na korelaci, P&L a guardy, ne nutně na prvotní kopírování vstupu. [tradovateBroker.ts:736](/Users/filipkrejca/Documents/trading-journal-aka/services/tradovateBroker.ts:736), [tradovateBroker.ts:1100](/Users/filipkrejca/Documents/trading-journal-aka/services/tradovateBroker.ts:1100) |
| V8 | **ZPŘESNIT** | vysoká | Heartbeat postupuje stejným serializovaným ocasem jako významné eventy; dlouhá akce jej může uměle zestárnout. Mechanismus je jistý, jeho podíl na incidentu 22. 9. ne. [tradovateBroker.ts:1233](/Users/filipkrejca/Documents/trading-journal-aka/services/tradovateBroker.ts:1233), [copierRiskGate.ts:134](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRiskGate.ts:134) |
| V9 | **SOUHLASÍM** | kritická | `autoFlattenCopies` vybírá všechny followery a ruční flatten má výchozí scope celý účet. Návrh opravit jen `enabled=false` nestačí: stále může zavřít manuální nebo jiný symbol na aktivním followeru. [copierRuntimeController.ts:5396](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:5396), [copierManualActions.ts:163](/Users/filipkrejca/Documents/trading-journal-aka/services/copierManualActions.ts:163) |
| V10 | **SOUHLASÍM** | střední | Follower flatten čeká na brokerovou akci přímo v `eventTail`; deadline je implicitně nekonečný. Může zablokovat další bezpečnostní eventy. [copierRuntimeController.ts:4698](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:4698), [copierManualActions.ts:178](/Users/filipkrejca/Documents/trading-journal-aka/services/copierManualActions.ts:178) |
| V11 | **ZPŘESNIT** | střední | `Order` bez potřebné `OrderVersion` spustí REST hydrataci uvnitř websocketového serial tailu. Neplatí však bez důkazu, že každý order vždy přidá 0,6–2,9 s. [tradovateBroker.ts:1072](/Users/filipkrejca/Documents/trading-journal-aka/services/tradovateBroker.ts:1072) |
| V12 | **SOUHLASÍM** | **kritická** | Pending model nemá leader order ID ani typ příkazu a divergence odečítá veškerý pending net. Pokud follower fill už dorazil, ale jeho order zůstává pending, může být správná pozice prohlášena za divergentní. [copierRuntimeController.ts:6492](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:6492), [copierRuntimeController.ts:6715](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:6715). Stdout v 16:13 CEST ukazuje dispatch, následnou divergence všech čtyř účtů, unmapped replace a guard flatten. [stdout:18042](</Users/filipkrejca/Library/Application Support/AlphaTrade/copier/mac-agent.stdout.log:18042>) |
| V13 | **SOUHLASÍM** | vysoká | Flat sweep má pevný deadline 1 500 ms, globální `listOrders` a při timeoutu rovnou fail-close/auto-close. Stdout obsahuje tři 1 500ms deadline chyby. [copierRuntimeController.ts:1539](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:1539), [copierRuntimeController.ts:1620](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:1620), [stdout:18026](</Users/filipkrejca/Library/Application Support/AlphaTrade/copier/mac-agent.stdout.log:18026>) |
| V14 | **NESOUHLASÍM** | střední UX/policy debt | Osmihodinové maximum a close při expiry jsou současná výslovná bezpečnostní politika, ne skrytá chyba. Problém je, že UI neukazuje skutečný čas expirace. Změna na „manage until flat“ by byla změna bezpečnostního modelu. [copierRiskGate.ts:105](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRiskGate.ts:105), [PROJECT_LOG.md:34](/Users/filipkrejca/Documents/trading-journal-aka/docs/PROJECT_LOG.md:34) |
| V15 | **ZPŘESNIT** | střední, vysoká při zapnutých cutech | Full configured cut se porovnává s už sníženým aktuálním limitem, tedy může být započten dvakrát. Návrh „nikdy nedisarmovat skupinu, jen cutnout účet“ je ale nová policy a musí být ownership-scoped. [copierRuntimeController.ts:3970](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:3970), [copierRuntimeController.ts:4945](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:4945) |
| V16 | **SOUHLASÍM** | **kritická** | Ineligible follower se sice přeskočí při kopírování, ale dál vstupuje do divergence. Stdout v 16:35 ukazuje čtyři breach skipy a o minutu později divergence stejných účtů. [copierRuntimeController.ts:6657](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:6657), [stdout:18126](</Users/filipkrejca/Library/Application Support/AlphaTrade/copier/mac-agent.stdout.log:18126>) |
| V17 | **SOUHLASÍM** | vysoká latentní | Jakýkoli historický acknowledged rejection pro účet/symbol může potlačit nový rejection v pozdější obchodní epizodě. [copierRuntimeController.ts:3192](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:3192) |
| V18 | **SOUHLASÍM** | vysoká latentní | Intentional suppression není svázána s epochou/orderem a při nové epizodě se nepřepíše. Může přežít déle, než je bezpečné. [copierRuntimeController.ts:6371](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:6371), [copierRuntimeController.ts:6750](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:6750) |

## Opravy — posouzení a lepší varianty

### Balíček 0: V12 a V13

Směr je správný, specifikace není úplná.

**V12:** Nestačí upravit pouze výpočet `currentRuntimePendingNet`. Pending záznam musí nově nést alespoň:

- leader order ID, follower broker order ID a druh příkazu,
- symbol, side, qty a dosavadní fill,
- obchodní epochu a connection/sync generation.

Pending lze odečíst pouze tehdy, když jsou leader i follower order z čerstvého autoritativního snapshotu stále otevřené, vzájemně odpovídají a oba mají nulový fill. Chybějící, terminální, částečně plněný nebo před reconnectem známý order musí zůstat fail-closed.

Jinak „pending vysvětluje rozdíl“ snadno zamaskuje ruční pozici, orphan order nebo dvojici nezávislých exitů a může později vytvořit reverzní pozici.

Nutné testy:

- přesná reprodukce incidentu 16:13,
- pending add-on limit, samostatný SL a partial exit,
- follower fill při dosud otevřeném follower orderu,
- leader cancel, zatímco follower order stále pracuje,
- částečný fill na jedné nebo obou stranách,
- stale/missing order a reconnect generation,
- více současných pending orderů,
- zachování současného správného divergence fail-close testu.

**V13:** Přesun read-only sweepu mimo `eventTail` je správný. Návrh ale musí dodat návratovou bariéru: před jakýmkoli cancel/write znovu ověřit `safetyGeneration`, revizi skupiny, connection generation, epochu, účet, symbol a stále platný flat stav.

Rozpočet 6–8 sekund musí být celkový budget, nikoli nový timeout pro každý účet nebo leg. Retry může být pouze read-only. Nejasný výsledek cancelu musí jít přes durable outbox a následný lookup; nikdy opakovat cancel naslepo.

Nutné testy:

- terminal stream stačí bez REST a bez disarmu,
- odpověď za 4,8 s projde v celkovém budgetu,
- vyčerpaný budget vede k fail-close bez duplicitního cancelu,
- nový leader entry během sweepu invaliduje starou práci,
- DISARM, kill switch nebo config change během background čtení,
- jeden pomalý účet neblokuje ostatní,
- unknown cancel result nevytvoří druhý broker write.

Do balíčku 0 bych přidal i **ST4 reconcile fence**. Reprodukce follower `-2`, leader flat, worker stále ARMED a bez `lastError` je závažnější než většina „vysokých“ bodů.

### Balíček 4A: follower nesmí zůstat bez SL

Princip správný, ale neimplementoval bych jej jednou obecnou výjimkou. Rozdělit:

1. V16 — episode-bound izolace breached/ineligible followeru.
2. V5 — durable klasifikace standalone protective stopu.
3. V8 — oddělení transport liveness od serializace událostí.
4. V17/V18 — epoch-bound rejection a suppression.
5. ST28/ST31 — podmínky partial-exit a let-run.

Suppression `allowedNet=0` je bezpečná pouze po autoritativním potvrzení: účet je flat, nemá working order ani pending command a důkaz patří současné epizodě. Stav `unverifiable` nesmí být interpretován jako izolovaný follower.

Protective order nesmí být po DISARM/kill automaticky odstraněn. To ale neznamená, že se smí naslepo znovu poslat: nejprve lookup, pak případně jediný idempotentní write.

### Balíček 4B: auto-close jen na vlastní kopie

Navržená oprava je **nedostatečná**. Filtrovat pouze `enabled=false` nechrání:

- manuální pozici na aktivním followeru,
- jiný symbol na stejném účtu,
- pozici vytvořenou před současnou epochou,
- účet vyřazený cutem nebo breach pravidlem, na kterém však prokazatelná kopie zůstala.

Auto-close smí dostat jen durable ownership target, například `{accountId, symbol, episodeId, maxOwnedQty, exactWorkingOrderIds}`. Žádný account-wide fallback. Když vlastnictví nelze prokázat: halt, alert a ruční zásah — žádný broker write.

Běžný DISARM nesmí ukončit již vzniklý leader-flat guard nad prokazatelnou kopií. Kill switch naopak zůstává jednosměrná západka a automatické write akce zastaví.

### „Naivní opravy“

Souhlasím, že se nesmí použít:

- označit každý pending order za vysvětlení divergence,
- pouze zvýšit pevný 1,5s timeout,
- opakovat cancel známých legů bez lookupu,
- pouze přeposlat `resynced` a současně pustit běžné vstupy,
- odstranit osmihodinový ARM limit bez explicitního policy rozhodnutí,
- epoch-filterovat nebo mazat `unknown/sending` outbox záznamy.

Výhrada: eligibility/cut filtry se nemají odstranit, ale také nesmějí dokazovat vlastnictví pozice. Rozhodující je durable copier provenance, ne současný checkbox.

## Chybí / přehnané / rozpory

- Částky `4×8`, `$416` a přesný 4,8s `/command/list` čas jsem nezávisle neověřil. Stdout potvrzuje sled událostí V12/V13, nikoli přesný finanční podíl na pozdějším breach.
- Třetí disarm není pouze „nevysvětlený“: stdout velmi silně ukazuje V16.
- V14 je v rozporu s aktuálním rozhodnutím v [PROJECT_LOG.md:34](/Users/filipkrejca/Documents/trading-journal-aka/docs/PROJECT_LOG.md:34): expiry má kopie rizikově snížit/uzavřít.
- V11 přehání tvrzením o každém order commandu.
- V2 popisuje skutečnou architektonickou mezeru, ale ranní konkrétní stav je už zastaralý.
- ST34 je formulován nepřesně. Owner-scoped auth chain omezuje nedispozitivní lease na přihlášeného vlastníka a jeho připojení. Riziko je, že vlastník získá svůj vlastní token zapečetěný pro zvolený klíč a obejde copier policy; nejde o „libovolná session získá libovolný token“. Supabase bezpečnostní kontrola tedy změnila hodnocení z cross-user auth breach na capability-design problém. [pilot-lease.ts:31](/Users/filipkrejca/Documents/trading-journal-aka/api/tradovate/oauth/pilot-lease.ts:31)
- Počet AI reviewerů neposiluje důkaz. Incident je potvrzen teprve kódem, brokerovou historií nebo reprodukovatelným testem.
- Chybí formální stavové automaty pro pending order, copier ownership, suppression a background sweep.
- Chybí source provenance instalovaného workeru. Samotný SHA souboru neříká base commit, dirty patch ani schema verzi. Worker build by měl obsahovat manifest s base commitem a digestem patche.
- Ve večerní změně chybí atomické pořadí audit/commit: `manual-group-retirement` audit vzniká před durable `processor.mutate`. Selhání zápisu může zanechat falešný audit. [copierRuntimeController.ts:8726](/Users/filipkrejca/Documents/trading-journal-aka/services/copierRuntimeController.ts:8726)
- Starší tvrzení PROJECT_LOGu o hladkém websocket renewal/resync je implementací V6 vyvráceno a mělo by být později opraveno.
- Formulace „persistent retry sweep“ je bezpečná pouze pro read-only lookupy. Nikdy ne pro opakovaný broker write.

## ST nálezy — výhrady

Za chybné nebo podhodnocené považuji:

- **ST1 — vysoká:** nouzový DISARM/kill musí být dostupný i při neznámém statusu. Jde o samostatnou jednosměrnou akci, nikdy o obecný toggle umožňující ARM.
- **ST3 — vysoká:** brzdy nesmějí čekat za pomalými commandy nebo ARM.
- **ST4 — kritická:** reconcile může skončit followerem `-2` proti flat leaderovi a ponechat worker ARMED bez chyby.
- **ST5 — vysoká:** současné chování může zavřít zdravé followery, zatímco leader zůstává otevřený.
- **ST6 — vysoká:** několikasekundová mezera standalone SL je bezpečnostní problém; řešit prioritou a frontou, nikoli dalším libovolným timeoutem.
- **ST9:** pouhé odstranění pětiminutového zámku je špatně. Nahradit autoritativní bariérou flat/no-working/no-pending.
- **ST17 — vysoká:** tighten-only bypass je obcházení session-risk policy.
- **ST21:** ponechat ARMED po jediné OSO noze je nová, nedodefinovaná policy.
- **ST22:** instalovaný SHA je nyní potvrzen, ale problém zdrojové provenance a downgrade zůstává vysoký.
- **ST24:** večerní flag řeší přesně zadané staré group ID, nikoli obecné missing-disabled followery.
- **ST31 — vysoká:** při let-run/suppression může špatná velikost exitu zanechat expozici.
- **ST32 — vysoká:** CAS/runtime rozjezd může zablokovat Flatten. Po chybě se musí zastavit processor a načíst durable stav; nouzová brzda musí mít nezávislou cestu.
- **ST33 — vysoká:** povolené development originy představují lokální privilege boundary proti živému workeru.
- **ST34:** nesprávně popsán jako cross-user token breach; viz výše.
- **ST35 — vysoká:** relay vybírá nejnovější aktivní zařízení, takže safety command může skončit u jiného workeru. [tradovateCopierCommandRelay.ts:387](/Users/filipkrejca/Documents/trading-journal-aka/server/tradovateCopierCommandRelay.ts:387)

## Večerní změna — izolovaný commit

Proti `origin/main` k ní patří přesně tyto soubory:

| Soubor | Patřící změna |
|---|---|
| `lib/localCopierAgentProtocol.ts` | nový retire command |
| `scripts/copier/mac-install.ts` | `--retire-missing-group-id`, plist a validační guard |
| `scripts/copier/pilot.ts` | bootstrap výjimka a warning |
| `server/localCopierExecutionAgent.ts` | request typ, validace staré/nové skupiny a forwarding |
| `services/copierPilotGroup.ts` | helper pro retire missing old group |
| `services/copierRuntimeController.ts` | volba, leader latch, retirement validation, preflight výjimka, audit, latch cleanup a ARM blokace |
| `tests/copierPilotGroup.test.ts` | helper test |
| `tests/copierRuntimeController.test.ts` | pět retirement scénářů |
| `tests/localCopierExecutionAgent.test.ts` | tři agent/protocol scénáře |

Konceptuálně k tomu patří i dva večerní záznamy v [PROJECT_LOG.md:217](/Users/filipkrejca/Documents/trading-journal-aka/docs/PROJECT_LOG.md:217), ale celý současný hunk logu se nesmí stageovat: obsahuje i cizí review a chart práci.

Nainstalovaný worker jsem ověřil jako:

`3cb70fe9cef2627e4afea2f96688800104e171c2060ee356e91a7474aab6d65b`

Izolovaný commit je mechanicky možný, ale pouze v čistém worktree vytvořeném z `origin/main`, přenesením přesného diffu těchto devíti souborů. Ne přes `git add` celých souborů v současném Documents checkoutu a ne nad lokálním HEAD, který je o 16 commitů pozadu.

Před označením za hotovou produkční opravu bych změnil pořadí retirement auditu až za durable commit a přidal test, že nesouvisející „missing leader route“ zůstane fatální. Potom spustit tři cílené testovací soubory a TypeScript kontrolu v čistém worktree.

Samotný commit worker nemění a **nevyžaduje reinstall**. Odstranění dočasného flagu z plist má počkat na plánovaný reinstall ve stavu prokazatelně DISARMED, flat a po reconcile.

## Doporučené pořadí oprav

1. **Provozní omezení:** žádné manuální obchody na follower účtech, kontrola SL po DISARM. Bez reinstallu.
2. **Izolovaně zachovat večerní změnu**, ideálně po opravě audit ordering. Bez reinstallu.
3. **Nouzový DISARM/kill při unknown statusu + zobrazení skutečné ARM expirace.** Web/UI bez reinstallu workeru.
4. **V12, V13 a ST4**, oddělené commity a reprodukční testy, ale jeden kontrolovaný release. **Reinstall workeru ano.**
5. **V16**, protože večerní stdout ukazuje pravděpodobný živý výskyt. **Reinstall ano.**
6. **V5 a V8**, následně V17/V18/ST28/ST31. **Reinstall ano.**
7. **V9 + V4:** durable ownership-scoped auto-close a guard přežívající běžný DISARM. **Reinstall ano.**
8. **V10 + ST32:** background execution s návratovou bariérou a samostatná emergency lane. **Reinstall ano.**
9. **V1/V3:** validační transakce před DISARM a trade-scoped observation fence. **Reinstall ano**, čistě UI část ne.
10. **V6/V7:** resync management-only režim a oddělená fill deduplikace. **Reinstall ano.**
11. **V15, ST5, ST21, ST26 a V14:** nejprve explicitní policy rozhodnutí. Worker změny reinstall vyžadují; samotné zobrazení V14 ne.
12. **V11/ST25 a hardening ST33–ST35:** workerové změny reinstall ano; relay/API deployment sám o sobě ne, změna device protokolu může vyžadovat nové spárování.

## Co jsem neověřil

- Skutečný `armed` stav: jediný povolený status request vrátil prázdné tělo a neopakoval jsem jej.
- Nespustil jsem testy, `tsx`, build, npm příkazy ani simulace.
- Nečetl jsem `journal.jsonl` ani stderr.
- Nevolal jsem Tradovate, produkční Supabase, Vercel ani iPhone.
- Neověřil jsem brokerovou historií přesných `4×8`, `$416` ani přesný 4,8s příkaz.
- Neprovedl jsem apply-check patche v čistém worktree; izolace vychází z přesného `git diff origin/main`.
- Nic jsem neupravil, necommitoval ani nezapsal do PROJECT_LOGu.
