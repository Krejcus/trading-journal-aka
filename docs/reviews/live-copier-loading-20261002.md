# LIVE kopírka — načítání bez problikávání a spolehlivé ověřování workeru

Stav: **dohodnuté zadání, implementace fáze 1** · autor Claude, oponentura
Codex (2× nezávisle), schváleno uživatelem 2026-10-02.
Větev: `claude/live-loading-20261002`.

## Co uživatel hlásí

- Při otevření LIVE je vidět kostra (správně), ale data se dají zrychlit.
- Na studeném startu (hlavně iPhone po zavření appky) je to horší.
- „Naskočí data, pak problikne a naskočí až ta správná“ — ON/OFF kopírky,
  „Zamčeno denním limitem“ (DLL do konce session), přepínače followerů.
- Cíl: žádné problikávání, ale 100% spolehlivost.

## Fakta (měření a kód)

Měřeno 2026-10-02 na `localhost:3000` (`dev:live`, read-only proxy na
produkci). Dev StrictMode zdvojuje efekty — duplicity z dev režimu níže
nejsou počítány jako produkční problém.

- Studený reload `?page=live`: kostra ~0,6 s, první data ~1,2 s, dorovnání
  obsahu 1,95–2,14 s (layout naroste).
- SPA návrat Dashboard → LIVE: broker data z paměti za ~0,3 s bez kostry,
  ale ~60 ms „Stav neověřen“ a přepínače 2 → 3.
- **Neznámý stav workeru se vydává za aktivní.** Řádek účtu bere
  `eligibility?.state ?? 'active'` (`components/LiveCopyTradeOverview.tsx`,
  `AccountRow`), takže před první odpovědí workeru ukáže „Aktivní“ (desktop)
  / zelenou tečku (mobil). Pak přijde DLL štítek a přepínače followerů.
  Reprodukováno Codexem na desktopu i mobilu.
- **Pomalé vedlejší připojení brzdí ověřování workeru.** Poll přijme první
  rychlou relay odpověď, ale pak čeká na `relayPoll.settled` (všechna
  připojení) a další kolo plánuje až potom
  (`components/TradovateLiveDesk.tsx`, relay větev pollu). Při 20s zpoždění
  jednoho připojení rychlý stav překročí `COPIER_STATUS_FRESH_MS` (15 s) →
  UI spadne do neověřeného stavu.
- `LiveDesk` se při odchodu z LIVE unmountuje → `agentStatus` /
  `agentStatusResolved` se resetují (broker data přitom žijí v `App`).
- Čtecí POSTy (`preflight`, `live-pnl`, `history-sync`) nemají klientský
  timeout — 20 s deadline dostávají jen GET (`services/tradovateOAuthConnection.ts`,
  `authenticatedRequest`). Zaseknuté čtení může držet kostru.
- Návrat z pozadí spoléhá jen na DOM `visibilitychange`/focus; chybí
  Capacitor `App` `appStateChange`.
- Na LIVE souběžně běží hydratace deníku: naměřeno ~50 sekvenčních
  Supabase dotazů během 4–12 s (`tradovate_journal_positions`,
  `journal_trade_snapshots`, `get_trade_note_projection_v1`,
  `backtest_trade_note_histories`). Relevantní pro fázi 2, ne pro
  problikávání.
- Cache dnes: in-memory read model (SPA), `sessionStorage` shell s ID
  připojení (přežije reload, na iOS po kill nejspíš ne), `localStorage`
  poslední ON/OFF popisek (24 h, nikdy nepovoluje ARM), intent prefetch při
  dotyku na LIVE (bez známých ID ale bootstrap čeká na OAuth status).

## Fáze 1 — dohodnutý rozsah

1. **Ověřování vybraného workeru nezávislé na pomalých připojeních.**
   Pravidelné čtení statusu vybraného workeru se neplánuje až po dokončení
   všech relay kandidátů. Ostatní připojení se dočítají mimo kritickou
   smyčku.
2. **Neznámý stav nikdy jako „Aktivní“.** Jednotné zobrazení tří stavů:
   neznámý („Ověřuji…“), naposledy potvrzený (ztlumeně, s časem),
   čerstvý. Místa pro přepínače followerů a stavové štítky jsou vyhrazená
   už při prvním vykreslení — nic neposkočí.
3. **Společné úložiště stavu workeru** mimo `LiveDesk`, aby přežilo
   přepínání stránek. ON/OFF, způsobilost účtů a účast followerů pocházejí
   ze stejné odpovědi workeru.
4. **Timeout + zrušení pro všechna čtení** a přímá obnova po návratu iOS
   appky (Capacitor `appStateChange`) koordinovaná s `visibilitychange`.

### Povinné podmínky (nepřekročitelné)

- Oddělené dotazování zachovává kontrolu identity workeru (device /
  connection) a odmítání opožděných odpovědí (poll generation fence,
  identity epoch).
- Společné úložiště se při odhlášení či změně uživatele **okamžitě**
  zneplatní; nic ze starého stavu se nezobrazí.
- Timeout a abort se vztahují **jen na čtení**. Nejistý výsledek execution
  příkazu (ARM, DISARM, Flatten, config) se nikdy automaticky neopakuje ani
  nepřeinterpretuje.
- Zapnutí kopírky a změny konfigurace vyžadují čerstvé potvrzení workeru.
  Bezpečné vypnutí / Flatten zůstávají dostupné podle současných pravidel
  i v neověřeném stavu.
- Naposledy potvrzený stav je jen zobrazení; nikdy nepovoluje ARM.

### Co ve fázi 1 záměrně NENÍ

- Pevné čekání (např. 1,5 s) na „jedno odhalení“ — síť neřeší; vyhrazené
  sloty stačí.
- Trvalé ukládání DLL zámku — potřebuje přesnou hranici obchodní session.
- Změny ARM/DISARM logiky, workeru, API kontraktů.

## Testy a review fáze 1

Offline scénáře se zpožděnými odpověďmi:

- Jedno připojení odpovídá 20 s → stav vybraného workeru zůstává čerstvý.
- Výpadek vybraného workeru → UI „neověřeno“, ne poslední ON; zapnout nejde,
  vypnout / Flatten ano.
- Návrat z pozadí během rozpracovaného čtení → odpověď z doby před uspáním se
  zahodí.
- Odhlášení / změna uživatele během čtení → nic ze starého stavu se
  nezobrazí.
- První vykreslení (desktop i mobil) → žádné „Aktivní“ ani zelená tečka
  bez potvrzení workeru; sloty přepínačů rezervované.
- Visící čtení přes timeout → kostra nezůstane navždy; chyba + retry.
- Execution příkaz s nejistým výsledkem → žádné automatické opakování.

## Fáze 2 (až po fázi 1, s měřením na iPhonu)

- Změřit studený start na fyzickém iPhonu (produkční build).
- Případně trvalé uložení ID připojení (bez tokenů) → bootstrap souběžně
  s OAuth statusem; výsledek dál až po čerstvém potvrzení.
- Odložit hydrataci deníku a `history-sync` během kritického startu LIVE
  (nikdy worker heartbeat, recorder, broker reads, safety status).
- Singleflight pro OAuth status (LIVE hook + journal sync).
- Uložený DLL zámek s hranicí session (17:00 America/Chicago).
- Fáze 3: delta enrichment místo druhého plného preflightu.

## Stav implementace fáze 1 (2026-10-02, Claude)

Hotovo ve worktree `/private/tmp/alphatrade-live-loading-20261002`
(větev `claude/live-loading-20261002`, nad `origin/main` `acdbafce`),
zatím necommitnuto a nenasazeno.

- **Bod 1** — `lib/copierRelayPollSources.ts`: `runCopierRelayStatusRound`
  přijme první živý worker hned, ostatní spojení dočtou jen zobrazovací feedy
  na pozadí; `CopierRelayInFlight` brání opakovanému čtení spojení s běžícím
  dotazem; `CopierRelayFeedSources` řadí feedy podle kola (pořadí vydává
  sdílené úložiště, takže remount nepřeruší). Přepnutí na lokální worker
  zneplatní pozdní relay feedy (route epoch). `relayConnectionId` přes ref.
- **Bod 2** — `WorkerEligibilityUnknownContext` v `LiveCopyTradeOverview`:
  bez stavu workeru chybějící způsobilost = „Ověřuji“ (desktop tečka + pill,
  mobil šedá tečka, štítek „ověřuji followery…“); neznámí followeři se
  nepočítají do „zařazených“. Slot přepínače followera vyhrazen u každé
  skupiny s followery.
- **Bod 3** — `lib/copierAgentStatusStore.ts`: poslední přijatý stav workeru
  v paměti (user-scoped); po návratu na LIVE se zobrazí hned, ale
  `agentStatusRestored` drží příkazy zamčené (`copierAgentCommandAllowedWhileRestored`
  pustí jen Flatten; DISARM/kill přes `executeSafetyCommand` beze změny),
  `saveRiskGroup` vyžaduje čerstvý stav. Úložiště se maže při odhlášení,
  `SIGNED_OUT` a změně uživatele; `LiveDesk` se vykreslí jen při shodě
  session a načteného uživatele.
- **Bod 4** — `authenticatedRequest(…, readTimeoutMs)`: read-only POSTy mají
  deadline (bootstrap / live-pnl 20 s, plný preflight 60 s, historie 120 s);
  execution zápisy a GET se signálem volajícího beze změny. `lib/appForeground.ts`:
  web = visibility, iOS = autoritativní `App.getState()` + `appStateChange`.
  Poller workeru i live P&L zahodí čtení zahájené před uspáním a po návratu
  čtou hned znovu.

Ověření: 4779 testů (nové `tests/liveLoadingPhase1.test.ts`,
`tests/liveUnknownWorkerRender.test.ts`), typecheck, build, lint nových
souborů čistý. Mutační kontrola: se starým blokujícím pollem test pomalého
spojení hlásí 7 s zastaralého stavu, s novým 0.

Review Codex (read-only): 2× P1, 3× P2, 1× P3 — všechny opraveny (P1
Risk konfigurace přes obnovený stav; P1 A→B bez SIGNED_OUT; P2 pozdní relay
feed po přepnutí na local; P2 live-pnl z doby před uspáním; P2 nativní
resume při DOM „hidden“; P3 neznámý follower jako „zařazený“).

Mimo rozsah (pre-existující, k samostatnému řešení): obecná App brána při
přímé změně účtu A→B (ostatní stránky ukazují data A do načtení B);
lint chyba `preserve-caught-error` v `executeSafetyCommand` (existuje na main).

Zbývá: vizuální ověření na localhost / iPhonu, druhé kolo review oprav,
rozhodnutí uživatele o commitu a nasazení.
