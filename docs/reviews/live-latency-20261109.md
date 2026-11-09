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

## Co se nemění

Outbox, WAL, no-retry, brány ARM/kill/day lock, REST ověření zavření, pořadí zpracování rámců, relay admission,
rozestupy a idempotence, skupinové cesty, limity pruhů v DB.
