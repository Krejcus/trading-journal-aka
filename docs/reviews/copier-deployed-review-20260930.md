# Review nasazené kopírky 061836f6 — 30. 9. 2026

Rozsah: `git diff 38365e39 061836f6` (všechny opravy z ultra review 28. 9. + režim opravy
a Kontrola pozic). Šest paralelních reviewerů (Claude, bez Codexe): A jádro replikace,
B nouzové cesty, C riziko/konfigurace, D spojení/broker, E agent/relay/pilot/instalace, F UI.
Každý nález má sondu (`tests/zprobe-<oblast>-*.test.ts`, kopie ve scratchpadu session
`probes/review-061836f6/`), klíčové sondy (A2, A3, D1, E1) jsem znovu spustil a reprodukují se.
Worker během review DISARMED, nic se neměnilo ani nenasazovalo.

## Pořadí podle rizika pro peníze

| # | Závažnost | Nález | Regrese? | Jistota |
|---|---|---|---|---|
| D1 | vysoká | Skutečný výpadek WS follower route < 10 s (grace nekritické route) je pro controller neviditelný: žádný resync/snapshot, filly a pozice z mezery ztracené. Když se follower v mezeře dostane na flat (SL, ruční zavření, likvidace), exit leadera ho otočí do opačné pozice, kopírka zůstane ARMED bez chyby. `brokerRouter.ts:345-352`, `tradovateBroker.ts:1473,1517` (`resync` jen při plánované obměně). | ne (starší) | sonda: follower −1, armed, lastError null |
| A3 | vysoká | Reversal leadera (mixed exit+entry) starší než 5 s se zablokuje celý včetně exitové části: followeři zůstanou v původním směru, leader v opačném, DISARM bez auto-close, leader-flat guard nezasáhne. `copierRuntimeController.ts:11568-11588`. Zdržení 5 s způsobí visící POST, S1b settlement, sweep (A5). | **ano, cdeec409** | sonda: followeři +2, leader −2 |
| A2 | vysoká | Záměrné potlačení vyřazeného followera (`allowedNet 0`) zanikne při jakékoli další události účtu (resend pozice, pozdní WS echo rejectu): nový SL/TP leadera nedostane nikdo, zdravý follower zůstane bez SL a skupina se vypne. `:8540-8546`, `:13512-13517`. | **ano, cdeec409** | sonda: stops300 = 0, DISARM |
| A1 | vysoká | V17 synchronní varianta neopravená: sync reject vstupu jednoho followera po dřívějším obchodu na symbolu → DISARM a auto-close zavře i zdravé followery (`sidelinableEntryRejection` :4443 není vázaný na epizodu). | ne (neúplná oprava) | sonda |
| B1 | vysoká | „Flatten followera do konce obchodu“ drží FIFO agenta i sériovou relay smyčku až 90 s (deadline cutu): Flatten All za ním čeká; z telefonu (relay) čekají i DISARM a kill switch. | ne (V10 bod 3 nesplněn na relay) | sonda (Flatten), brzdy přes relay z kódu |
| A4 | střední | Samostatný TP leadera se zkopíruje followerovi, jehož limitní vstup se ještě nevyplnil (`exactCurrentPendingExposure` omluví 0 vs +2); vyplní-li se TP kopie, follower je short, vstup dál pracuje. Netýká se OSO bracketů. `:10366-10390`. | ne | sonda: follower −2 |
| B2 | střední | Nouzový Flatten nevidí write hlavní lane (auto-close při fail-closed/expiraci ARM, leader-flat guard) → souběžný druhý liquidate na stejný účet. | ne | sonda: 2 souběžné liquidate |
| C1/C3 | střední | V15 prop cap: `dailyLossAutoLiq` bráno jako zbývající rezerva (ne `DLL − dnešní ztráta`), `??` ignoruje menší trailing rezervu, změna cutu zahodí session paměť capu → cap nad DLL propky (např. 1100/1550 proti DLL 1000). `:5194`, `:2877-2890`. | 8c | sonda (dopad jen u účtů s DLL) |
| F1 | střední | Potvrzovací dialog Flatten při neověřeném stavu tvrdí „žádný brokerový příkaz se neodešle“, ale Flatten se odešle. `LiveCopyTradeOverview.tsx:2250, 6466, 6496`. | ne | sonda |
| B3 | střední | ARM (loopback) projde, zatímco nouzový Flatten ještě běží; jeho pozdní úklid zruší novou kopii a skupinu vypne. | ne | sonda |
| B5 | střední | Ruční „Zamknout den“ zadaný v obchodu je jen v paměti do flat → po restartu workeru jde tentýž den ARM. | ne | sonda |
| C2 | střední | Bez `netLiq` se trailing rezerva počítá z cash: otevřený zisk ≥ DD → prop-reserve zavře ziskovou let-run kopii. | 8c (část b8b #2) | sonda |
| D2 | střední | Deadline plánované obměny socketu 15 s < sync timeout 45 s → při pomalém REST obměna na leader route DISARMuje, na follower route vede k D1. | 9b | sonda |
| A5 | střední | Rozpočet flat sweepu 6 s > limit stáří události 5 s → re-entry po stop-outu vypne kopírku (třída V13). | ano (V13 v6) | sonda |
| E1 | střední | Režim opravy po startu nefunguje, jakmile nová skupina ponechá kterýkoli starý účet (routing: účet současně required i optional). | nové 1df2840b | sonda |
| E2 | střední | Po restartu s durable stopou živých kopií nejde opravu dokončit (connection recovery zablokuje activateGroup, reconcile padá na chybějící leader route). | nové | sonda |
| E3/C4 | nízká–stř. | Po dočasném výpadku OAuth při startu nejde z režimu opravy odejít bez restartu; účet viditelný s `active=false` nejde vyřadit ani obejít při ARM. | nové / starší | sonda |
| F2 | střední | Autoritativní odmítnutí ARM se zobrazí jako „Zapnutí kopírky není potvrzené“ (S1). | ne | sonda |
| F3 | střední | „Zrušit“ v dialogu snímků ukáže zelený toast „kopíruje se naostro“, i když ARM neproběhl. | ne | z kódu |
| F4 | střední | Panel Kontroly pozic drží starý výsledek („kopírka zůstává vypnutá“) i po ARM. | nové 1df2840b | sonda |
| B4/F5 | nízká–stř. | Nejhorší doba nouzového Flattenu při zaseknutém brokeru řádově 5–6 min; jeden visící background job zdrží liquidate všech účtů o 90 s. | ne | sonda |
| E4 | nízká | Relay `arm-live` provede implicitní retirement a ARM v jednom příkazu. | nové | sonda |
| E5 | nízká | Kontrola pozic v režimu opravy s nedostupným leaderem vždy selže. | nové | sonda |
| A6 | nízká | Unhandled rejection immediate dávky při selhání commitu (ENOSPC) — worker nemá handler, pravděpodobně spadne → launchd restart DISARMED. | ne | sonda (pád z kódu) |
| ostatní | nízká | F5 ostrůvek Vypnout spolkne chybu, F6 snapshot ready bez ageMs, F7 stará lastError, C4 durable vs runtime po dvojité chybě, D3–D5, reinstall bez kontroly SHA po restartu, TOCTOU manifestu. | | |

## Ověřeno bez nálezu (výběr)

V1, V3, 5f6bf7f2, tighten-only, serializace konfigurace, retirement jen DISARMED s OAuth
absencí, relay allowlist (`reconcile` read-only), ARM ACK ověřený workerem, kill switch
v session nejde obejít, router neposílá příkaz přes cizí spojení, V7, V12 v6, V13 v6
(kromě A5), V16, V5, V8, ACK/poll fence v UI, brzdy bez ověřeného stavu.

## Provozní doporučení do opravy

- Po každém otočení pozice leadera (reversal) a po každém „mrknutí“ spojení followerů
  zkontrolovat followery v Tradovate (A3, D1).
- Nepoužívat samostatný TP leadera, dokud se limitní vstup followerů nevyplnil (A4); OSO bracket je v pořádku.
- Po „Flatten followera do konce obchodu“ počítat s tím, že brzdy z telefonu mohou čekat;
  v nouzi Flatten/DISARM z Macu nebo přímo v Tradovate (B1).
- „Zamknout den“ během obchodu nepřežije restart workeru (B5).

## Stav oprav (30. 9., větev `claude/copier-review-fixes-20260930`, Claude)

Pořadí schválené Filipem: D1, A3, A2, A1, B1, pak Flatten dialog a režim opravy.

| Nález | Commit | Co se změnilo |
|---|---|---|
| D1 | f5e5345f | Broker po skutečném reconnectu synchronizovaného socketu vrací stejný route snapshot jako po plánované obměně (`resynced` + `reconnected`); router ho předá jen v reconnect lhůtě, controller ho porovná s modelem (rozdíl → fail-closed bez auto-close). |
| A3 | a50822fa | Zpožděný mixed reversal: exit slice odejde exit-only, vstupní část se pozdě nekopíruje, fail-closed až po dispatchi. |
| A2 | 1b062017 | Nulová suppression vyřazeného followera se posune o právě jednu neškodnou událost (Position 0, nepracovní order bez fillu); fill a skutečná pozice ji dál ruší. |
| A1 | 25153fd5 | Synchronní sideline ignoruje acknowledged záznamy jiných epizod; důkaz suppression bere epochu v grace/closing jako předchozí obchod. |
| B1 | 3c22c771 | Flatten followera do konce obchodu drží frontu agenta i relay jen do durable přijetí + max 3 s, pak vrátí `pending` a zavírá na pozadí. |
| F1 | caa63392 | Dialog Flatten používá stejná pravidla odeslání jako `runCommand`; při neověřeném stavu varuje, že se akce přesto odešle. |
| E1–E3, E6, C4 | ec335564 | Oprava skupiny s ponechanými účty projde routingem; breached účet viditelný jako neaktivní jde vyřadit; connection recovery nezablokuje opravu; E3 radí restart workeru; ARM nikdy implicitně nevyřazuje. |
| ověřovací review | ae5213be | D1 porovnává followera s živým leaderem místo přičítání gap fillů; A3 odkládá fail-closed na fill u on-fill followerů; A2 bere jako neškodné jen canceled/rejected bez fillu u známého orderu; B1 hlásí přijetí i opakované operaci a UI ukáže selhané zavření. |

Zbývá (neopraveno v tomto kole): A4, A5, A6, B2–B5, C1–C3, D2–D5, F2–F7, E4/E5 a nízké položky.
