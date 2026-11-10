# LIVE latence — vlna 1 (Claude, 9. 11. 2026)

Větev `claude/live-latency-20261109` nad `cabb6b5a`. Rozbor skulin: `docs/reviews/live-hot-path-gaps-20261109.md`
(v Documents). Měření: `scripts/copier/latencyBench.ts` (jen sólo DEMO, přes relay admission, časy z logu workeru).

## Naměřený výchozí stav (DEMO 61038658, worker cd530285, n=3–5)

- Market se SL/TP: provedení ve workeru 390–465 ms, ale **pozice ve stavu workeru až ~2,0–2,3 s** od odeslání.
  Log: `BROKER SEMANTIC SLOW frame=order#…+hydrate#… handler=730–1600 ms` — fill stojí v sériové frontě
  za REST dotažením OrderVersion, které si předtím vzdáleně rezervuje recovery kapacitu.
- Posun SL/TP: provedení 230–366 ms.
- Zavření: provedení 1380–2800 ms.
- **Nový vstup odmítnut 3× ze 6** hláškou `Application request budget exhausted`. Ledger za poslední hodinu:
  background 1193/1200 (DEMO login) a 1197/1200 (Lucid login), rovnoměrně ~100 za 5 min. Worker sám za hodinu
  odeslal 191 dotazů (všechny pruhy); zbytek jsou zobrazovací čtení webu/telefonu přes Vercel. Pruh je tedy
  nasycený trvale už při otevřeném LIVE bez pozice.

- **Výpadek při měření (21:26:30 UTC):** po šesti cyklech vstup → posuny → zavření během ~7 minut worker
  uprostřed otevřeného obchodu shodil WebSocket a vypnul se. Log: `FAIL-CLOSED … phase=websocket Priority read
  budget exhausted` → `WS RECONNECT reason=socket-message-error` (3×) → `Tradovate WebSocket transport error`.
  Příčina: dotažení OrderVersion ke každému příkazu ze streamu čerpá recovery pruh (24/min); po vyčerpání
  hydratace selže, rámec skončí chybou a adaptér zavře socket. Pozice zůstala chráněná SL/TP u brokera, zavřena
  Flattenem, kontrola pozic čistá. Stejná cesta hrozí při aktivní správě skupiny (víc účtů = víc příkazů).

## Změny a dotčené invarianty

1. **Brána nového rizika nebere nasycení zobrazovacího pruhu** (`tradovateRequestControlGovernor.admissionProblem`).
   - INV-TRAD-09 („soft budget … před přijetím nového rizika“) se zpřesňuje: nové riziko (vstup, ARM,
     auto-resume) blokuje vyčerpaný pruh risk, control, celkový strop 4000/h (i lokálně: background + management),
     neplatná/stará autorita, cooldown a captcha. Samotné nasycení background 1200/h / 40/min už ne.
   - Proč: pruh background je navržen tak, aby ho weby plnily po strop a dostaly 503 (odklad zobrazení).
     Stejná podmínka jako brána vstupu dělala ze stavu „LIVE je otevřené“ náhodné odmítání vstupů i ARM.
     K penalizaci brokera drží rezervu celkový strop, ne dílčí pruh.
   - Background čtení se dál odmítají přesně jako dřív. Skutečná penalizace dál zastaví vše.
2. **Dotažení OrderVersion ze streamu jde třídou „accepted“ s lokálním přídělem** (`tradovateBroker.fetchOrderVersions`).
   - INV-TRAD-09: „stavové ověření přijatého lifecycle nemá novou kreditovou frontu“. Příděl 90/min a 900/h
     na adaptér; nad něj původní recovery cesta s rezervací. Počítá se do management počítadla (celkový strop).
   - INV-TRAD-ACK-01 / pořadí rámců: beze změny, mění se jen třída spotřeby jednoho GET.
3. **Zavření: contractId ze živého synchronizovaného streamu** (`tradovateBroker.liquidatePosition`).
   - INV-MODE-02: potvrzení stavem (REST position + orders po zápisu) beze změny; mění se jen zdroj contractId
     před zápisem. `liquidateposition` je stavový — likviduje skutečnou pozici brokera. Když stream pozici
     neukazuje nebo není živý/synchronizovaný, platí původní REST čtení včetně no-opu „už flat“.
4. **Čekání na flat ze streamu po 20 ms místo 100 ms** (`executeClose`) — jen čtení paměti, deadline stejný.
5. **Klíč zařízení v paměti nejvýš 60 s** (`macCopierDevice.authorizationHeader`) místo spuštění
   `/usr/bin/security` při každém relay požadavku (~170/min v klidu).
   - INV-WORKER-03: identita a scope beze změny; výměna/smazání klíče se projeví do 60 s; chyba se necachuje.

6. **Stavová čtení pro přijatou expozici jdou třídou accepted** (`services/lifecycleReadBroker.ts`, zapojeno
   v `bootstrapCopierRuntime`). Nález Codex review + cílený audit: řadič čte pozice/příkazy na desítkách míst
   mimo explicitní třídu (události ze streamu, časovače, úklid po vypnutí) — `cutAwareDispatchFor` (S1b),
   `flushStandaloneBracketStop`, `failClosedOnCriticalAudit`, `cancelStrandedCopiedEntries`,
   `evaluateConditionalMirrorSource`, `sweepExitOnlyReservationsAtFlat`, `cancelPartialCopiedEntryRemainder`,
   `settleS1bPostCancelCleanups`, `guardBracketPairFollowers`. Při nasyceném zobrazovacím pruhu (dnešní
   ustálený stav) je broker odmítl → follower bez ochranného příkazu, DISARM, auto-close zdravých followerů
   nebo tiše vynechaný úklid. Chyba existovala i před touto větví.
   - Fasáda obalí jen `listPositions`, `listOrders`, `findOrderById`, `findOrdersByTag`, jen když volající nemá
     vlastní třídu, a jen když kopírka nese nebo může nést expozici (ARMED, nenulová pozice, otevřený příkaz,
     rozpracovaná událost, běžící Flatten). V klidu zůstává vše v běžném rozpočtu.
   - Scope vyhasíná s koncem čtení (`tradovateRequestContext.lifecycleRead`), takže časovač založený uvnitř
     výjimku nedědí. Explicitní risk/recovery/accepted se nemění; `risk()` zůstává beze změny.
   - INV-TRAD-09: „přijatý fanout, jeho stavové ověření a ochrany nemají novou kreditovou frontu“ — tímto
     skutečně platí i pro čtení mimo runner.
7. **Držené spojení k REST brokera** (`server/tradovateKeepAliveFetch.ts`, volba `--tradovate-keepalive on`,
   výchozí vypnuto). `node:https` agent, volné spojení nejvýš 45 s. Zápis se nikdy neopakuje (INV-OUTBOX-01,
   INV-TRAD-08); GET se zopakuje jednou jen při selhání znovupoužitého spojení před prvním bajtem odpovědi.
8. **Automatická obnova baseline pokrytí streamem** (`tradovateBroker` `displayCoverageRebaseline`, jen zobrazení).
   Doklad `streamCoverage` rušil každý obchodní rámec a znovu vznikal jen náhodným REST čtením, takže weby
   četly brokera dál samy. Adaptér ho obnoví sám, ale **jen když neeviduje žádnou pozici ani pracující
   příkaz** (čtení grafu příkazů dělá `streamOrderSnapshot` na chvíli nedostupný a správa obchodu by spadla na
   pomalejší REST předčtení): po 3 s klidu, nejvýš jednou za 30 s, vždy background třídou, bez zálohy jinou
   třídou, po selhání s rozestupem až 10 min. Pravidla dokladu se nemění. Web tak přestane číst v klidu
   (hlavní hodinová spotřeba); s otevřenou pozicí čte dál jako dosud.

Úpravy po druhém kole oponentury (critic + Codex, oba „opravit před commitem“): podmínka fasády zahrnuje
rozpracovanou obnovu po restartu a vynechává shadow ARM, fasáda má lokální strop 120/min a 1200/h a obaluje i
adresář účtů, `risk()` si uvnitř vyhasínajícího čtení drží vlastní třídu, obnova pokrytí nemá recovery zálohu
a neběží s expozicí, držené spojení vrací odpověď hned po hlavičkách se streamovaným tělem (západka 429).

Známé meze: chybí integrační test zapojení fasády do řadiče (mock broker nemá `runWithLifecycleReads`;
fasáda sama je pokrytá jednotkově). Držené spojení zůstává volitelné: zápis na spojení, které protistrana
mezitím zavřela, je nejistý výsledek stejně jako u vestavěného fetch, jen okno je 45 s místo ~4 s.

Třetí kolo oponentury (jen opravy): **OK S VÝHRADAMI**, nic neblokuje. Zapsané výhrady:
- `rawOrders` adaptéru se nemažou; příkaz bez doručeného terminálního stavu nebo pracující příkaz jiného účtu
  téhož loginu obnovu pokrytí potichu vypne do restartu workeru (konzervativní směr).
- Strop fasády spotřebuje žeton i u čtení, které už vlastní třídu má (nepovýší se). Horší než dřív to není.
- Od bootstrapu do první události `connected` je podmínka fasády vypnutá (cache prázdné, příznak obnovy ještě
  nenastavený); první čtení po studeném startu jdou jako dřív.
- Teoretický součet všech stropů (background 1200 + risk 2400 + control 240 + hydratace 900 + fasáda 1200)
  je nad 5000/h; v běžném provozu worker odesílá stovky dotazů za hodinu a nové riziko hlídá celkový strop.
- **Starší defekt, tady neopravený:** odmítnutí hydratace *rozpočtem* shodí socket (`tradovateBroker.ts`
  zpracování rámce), ačkoli se nic neodeslalo; resync pak čte ze stejného vyčerpaného pruhu. Vyšší příděl práh
  jen posouvá. Správně má rámec zůstat ve frontě a hydratace se omezeně opakovat. Řešit samostatně.
  Pokus o krátké opakování (10× po 500 ms) oponent vrátil: smyčka není svázaná se svým socketem (po reconnectu
  by dál čerpala stejný pruh), pokus sám může trvat až 5 s, a stojící rámec mění okamžitý fail-closed v nejistý
  výsledek ručního modify. Změna byla stažena; chce vlastní návrh (termín podle hodin, `isCurrent` socketu,
  chování `waitForOrder` za stojícím rámcem).

## Co se nemění

Outbox, WAL, no-retry, brány ARM/kill/day lock, REST ověření zavření, pořadí zpracování rámců, relay admission,
rozestupy a idempotence, skupinové cesty, limity pruhů v DB.

## Výsledek na DEMO (worker f34d0b4c, 9. 11. 23:01–23:07 UTC)

Stejný nástroj, stejný účet, 1 MNQ. Po opravách šel vstup jako chráněný Limit položený přes trh (IB Gateway
se ve 22:45 UTC sám odhlásil, takže worker neměl cenu a Market nejde); v obou případech jde o jeden `placeoso`.
Časy „provedení“ jsou z logu workeru, „ve stavu workeru“ je od odeslání z měřicího skriptu včetně jeho ~0,5 s
fronty bez push kanálu (produkční klient má frontu kratší).

| | Před (cd530285) | Po (f34d0b4c) |
|---|---|---|
| Vstup — provedení ve workeru | 341 ms (264–1498, n=7) | 334 ms (296–429, n=4) |
| Vstup — pozice ve stavu workeru od odeslání | 2033 ms (1796–2324) | 1469 ms (1179–1672) |
| Dotažení verze příkazu (fill za ním čeká) | medián ~880 ms (234–1184, n=16) | medián ~150 ms (131–320, n=8) |
| Posun SL — provedení | 317 ms (232–440, n=11) | 230 ms (208–481, n=5) |
| Posun TP — provedení | 246 ms (216–378, n=12) | 228 ms (220–343, n=5) |
| Zavření — provedení | 1982 ms (1260–2443, n=6) | 939 ms (925–1076, n=3) |
| Zavření — flat ve stavu workeru od odeslání | 2025 ms (1626–2624) | 1173 ms (1158–1408) |
| ACK relaye (cache klíče) | 161–245 ms | 121–186 ms |
| Vstup odmítnutý rozpočtem | 3 ze 6 | 0 ze 6 |

Malé vzorky, ne p95. Co zbývá mezi provedením vstupu a pozicí (~0,6 s): tři příkazy OSO se dotahují po sobě
(3× GET ~150–250 ms). Další krok by byl znát tvar vlastních příkazů z odeslaného požadavku a REST vynechat.

Neměřeno: držené spojení a zápisy po WebSocketu (denní strop 100 příkazů správy na uživatele se vyčerpal —
55 ze 100 spotřebovalo měření), produkční cesta s push kanálem, klik→pixel v prohlížeči, skupina s followery,
účinek dokladu pokrytí na čtení webu (doklad do cloudu chodí čerstvý, spotřeba na DEMO loginu neklesla —
čtoucí klient zjevně není na obrazovce LIVE).

Vedlejší nálezy z měření: po zavření pozice blokuje nový vstup krátké „leader event quiet window“
(`group-busy`); IB Gateway se denně ve 23:45 SEČ odhlásí a bez ručního přihlášení worker nemá cenu.

## Dodatek 10. 11. 2026 (po půlnoci)

**Oprava příčiny nasyceného zobrazovacího pruhu.** Výše stojí, že pruh plní čtení webu/telefonu. Rozbor časů
grantů to zpřesňuje: na DEMO loginu padá ~46 % čerpání do 20.–24. sekundy každé minuty a dalších ~20 % do
0.–4. sekundy, na Lucid loginu ~23 % a ~13 %. Ve 20. sekundě běží minutový cron `/api/cron/send-alerts`, který
pro každého uživatele s nativním zařízením a živým workerem čte snímek brokera (zámky účtů, start Live
Activity, widgety) — i bez pozice a i když nic neposílá (`0 live activity updates, 0 widget pushes`, v logu
každou minutu `Native Broker Snapshot … tradovate-request-budget`). Hlavním stálým spotřebitelem je tedy
serverový cron, klienti až druzí.

- **Zpomalení v klidu** (`server/nativeIdleBrokerSnapshot.ts`, zapojeno v `api/cron/send-alerts.ts`,
  `nativeLiveActivityStarter`, `nativeWidgetPushUpdater`): když čerstvý worker hlásí flat, žádný příkaz, žádný
  incident a expozice se tři minuty nezměnila, čte cron brokera jen každou pátou minutu. Běžící Live Activity
  a čtvrthodinový sběr zůstatků se nemění. Není to jádro kopírky (jen zobrazení a notifikace); účinek až po
  nasazení webu. Očekávání: ~7 → ~1,5 dotazu/min na login v klidu.
- **Předčtení verze příkazu hned po ACK zápisu** (`tradovateBroker.primeOrderVersion`): fill vstupu čekal za
  dvěma dotaženími nohou OSO po sobě (~240 ms; broker ACK přichází 100–300 ms před rámci). Čtení teď začne při
  ACK, výsledek použije jen první rámec `order` téhož id stejnou cestou jako dosud. Po oponentuře: jen
  v lokálním přídělu a s vyhasínající třídou, prázdný nebo cizí seznam se zahodí a rámec čte sám.
  INV-TRAD-ACK-01 (pořadí) beze změny.

### Varianty transportu (DEMO, jen vstupy, n=5, worker 125d40c4)

| | Výchozí fetch (f34d0b4c, n=4) | Držené spojení | Zápisy po WebSocketu + držené spojení |
|---|---|---|---|
| Vstup — provedení ve workeru | 334 ms (296–429) | 248 ms (234–300) | 268 ms (235–339) |
| Zápis u brokera | 216–262 ms | 149–174 ms | 143–200 ms |
| Pozice ve stavu workeru od odeslání | 1469 ms (1179–1672) | 1223 ms (828–1333) | 1176 ms (871–1328) |

Držené spojení dává stejný zisk jako WS zápisy (~80 ms na příkaz) a funguje i pro skupinu; WS zápisy navíc
nic nepřinesly. Stav po měření: DEMO worker z `125d40c4`, REST zápisy, `--tradovate-keepalive on`, vypnutý, flat.

Zbývá (neuděláno): rámec se stejnou verzí příkazu přesto čeká na REST dotažení (~150–200 ms, pořadí entit
v `stageOrderVersions`); odmítnutí hydratace rozpočtem shazuje socket (jen vyšší práh); živý test skupiny
s followery (na DEMO není druhý účet); účinek zpomalení cronu až po nasazení webu.

## Příprava vydání (10. 11. 2026 ráno)

Poslední kolo před nasazením: copier-design-critic **OK S VÝHRADAMI** (bez blockeru), Codex **FIX BEFORE RELEASE**
se třemi nálezy — všechny zapracované:

- **Předčtení verze při ACK:** seznam přečtený při ACK se použije jen pro tento příkaz; když po něm chybí
  povýšená verze nebo verze, kterou mezitím potvrdil broker, rámec čte znovu (dřív mohl příkaz zůstat bez tvaru
  do další události). Test teď ověřuje i vydanou událost příkazu, ne jen počet čtení.
- **Zpomalení cronu je výchozí VYPNUTÉ** (`ALPHATRADE_IDLE_BROKER_SNAPSHOT=on` na serveru ho zapne). Důvod:
  zámek účtu, který vznikne i zmizí mezi dvěma čteními v klidu, by se neoznámil vůbec. Je to rozhodnutí
  o notifikacích, ne oprava — nechávám na Filipovi.
- **Víc workerů jednoho uživatele:** klid se počítá přes všechny čerstvé workery; vypnutí, kill switch, zámek dne,
  pauza po obchodu a čerstvé zapnutí klid ruší.

Postup nasazení a co sledovat: `docs/reviews/live-latency-release-20261110.md`.
