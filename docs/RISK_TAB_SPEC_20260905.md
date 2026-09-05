# Záložka Risk — akce pravidel, pauza, limity účtů — specifikace v1 (2026-09-05)

Schválený vizuál: canvas „AlphaTrade Risk" (https://claude.ai/code/artifact/603129f1-8569-4d44-9283-10917ee8348c),
zdrojové artboardy `scratch/risk-design/*.dc.html` (generátor `gen.py`). Navazuje na
`docs/DAY_LOCK_RULES_SPEC_20260904.md` (dále DLR) — co tady není řečeno jinak, platí DLR.

## 0. Cíl a zásady

Uživatel chce pojistky, které ho v tiltu **nepustí**, ale zbytečně dlouho neblokují.
Řešení: každé pravidlo dne má **akci** — *pauza* (vyprší sama) nebo *zámek dne*
(do konce session). Zadní vrátka se zavírají natvrdo: **odemknout den nejde
vůbec**, a od prvního ARM v session jdou pravidla i limity **jen zpřísnit**.
Nově jsou **limity per účet** (propka): účet po dosažení vlastního limitu
vypadne z kopírování do konce session, skupina se nezamyká.

Neměnné zásady (navíc k DLR §0):

- **Pravidla i limity vyhodnocuje výhradně worker.** PWA a companion jen zobrazují.
- **Pauza nikdy neDISARMuje a nezavírá pozice.** Blokuje jen vstupy leadera
  (události zvyšující expozici) — stejně jako „mimo obchodní okno". Exity se
  kopírují dál. Vyprší sama; nic se neodemyká a nic se automaticky neARMuje.
- **Zámek dne** zůstává podle DLR (čeká na flat skupiny, drží do konce session).
- **`unlock-day` se ruší** všude: relay allowlist, worker (vrací chybu), UI (dialog
  i tlačítko pryč). `dayLockSnoozedRules` a `dayUnlock` zůstávají ve stavu jen
  kvůli kompatibilitě, nikdy se nezapisují.
- **Jen zpřísnit (tighten-only):** od prvního ostrého ARM v broker session do
  `sessionEndAt` worker odmítne každou změnu skupiny, která pravidla nebo limity
  zmírňuje (definice §2.4). Relay to hlídá jako druhou vrstvu (§2.5).
- **Vyřazení účtu nikdy nezamyká skupinu.** Ostatní followeři kopírují dál.
- **Neznámé ≠ bezpečné.** Chybějící/zastaralý broker snapshot účtu = stav
  „neověřeno" v UI; vyřazení proběhne jen na ověřených datech nebo na vlastním
  ledgeru (fast path §3.3). Nikdy se neodhaduje.
- Terminologie UI: „Pauza do HH:MM", „Zámek dne", „Vyřazen do konce session",
  „Limit propky", „Max ztráta", „jen zpřísnit". Bez slova „tvrdý režim".

## 1. Datový model (`services/liveCopyTrading.ts`) — sdílené typy jsou už v základní větvi

```ts
export type CopierRuleAction =
  | { kind: 'pause'; minutes: number }   // 1..720
  | { kind: 'lock' };

export interface CopyGroupDayRuleActions {
  losingTrades: { beforeLimit: CopierRuleAction | null; atLimit: CopierRuleAction };
  dailyLoss:    { at80Percent: CopierRuleAction | null; atLimit: CopierRuleAction };
  maxTrades:    { atLimit: CopierRuleAction };
  windowEnd:    { atEnd: CopierRuleAction };
}
// CopyGroupSafetySettings.dayRuleActions: CopyGroupDayRuleActions
// DEFAULT: losingTrades { beforeLimit: pause 20, atLimit: lock },
//          dailyLoss    { at80Percent: pause 30, atLimit: lock },
//          maxTrades    { atLimit: pause 30 }, windowEnd { atEnd: lock }.
// Staré uložené skupiny bez pole dostanou DEFAULT (sanitizer). Neplatná hodnota = null (fail-closed).

export interface CopyFollowerConfig {
  accountId: number; mode: CopyReplicationMode; multiplier: number; maxContracts?: number;
  /** „Max ztráta": realizovaná denní ztráta účtu (USD, vč. poplatků), při které účet vypadne z kopírování. 0/undefined = vypnuto. */
  dailyLossCutUsd?: number;          // 0.01..1_000_000, 2 desetinná místa
  /** Co s otevřenou kopií účtu při vyřazení. Default 'close-copy'. */
  onCut?: 'close-copy' | 'let-run';
}
```

`beforeLimit` u ztrátových obchodů platí jen pro `dailyMaxLosingTrades >= 2`
(spouští se při `losingTrades === max - 1`). `at80Percent` při
`realizedPnlUsd <= -0.8 * dailyLossLimitUsd`. Obě jsou **jednou za pravidlo a
session** (stejně jako dnešní varování; využij `warnedRules`).

## 2. Worker — pravidla dne (`services/copierRuntimeController.ts`)

### 2.1 Stav (`state.safety`, persist přes `persistSafety`)

```ts
pauseUntil: number;                 // 0 = žádná pauza
pauseRule: CopierDailyRule | null;  // 'losing-trades' | 'daily-loss' | 'max-trades' | 'window-end'
pauseAt: number;
sessionArmedAt: number;             // první ostrý ARM v aktuální session; 0 = zatím ne (reset s novou session)
followerCuts: Record<string, CopierFollowerCut>;   // klíč = accountId
accountRisk: Record<string, CopierAccountRiskSnapshot>; // poslední broker snapshot per účet
```

### 2.2 Pauza

- Spouští se z `evaluateDailyRules` podle `dayRuleActions` (místo dnešního pouhého
  varování). `pauseUntil = max(pauseUntil, at + minutes*60_000)`, `pauseRule`, audit
  `rule-pause` (rule, until). Varování `rule-warning` zůstává (companion/PWA ho už umí).
- Za pauzy: `blockOutsideTradingWindow`-ekvivalent `blockDuringPause` — leader
  událost zvyšující expozici se **nekopíruje**, audit `blocked` s důvodem
  `pause:<rule>:<until>`. Exity a snižování expozice se kopírují normálně.
- Pauza neDISARMuje. ARM za pauzy je povolen (vstupy zůstávají blokované).
- Když během pauzy padne pravidlo s akcí `lock`, lock má přednost (pauza se
  nemaže, jen je irelevantní). Když padne další `pause`, prodlužuje se na
  maximum.
- Vyprší sama (`pauseUntil <= now`): status ji přestane hlásit, audit `rule-pause-end`.
- Restart workeru pauzu zachová (persist). Nová session ji nuluje.

### 2.3 Zámek dne

Beze změny proti DLR, jen: `unlock-day` → worker vyhodí
`Error('unlock-day není podporován: den se odemyká jen koncem session')`.
Companion i relay ho nesmí vůbec nabízet.

### 2.4 Jen zpřísnit

`sessionArmedAt` se nastaví při prvním úspěšném ostrém ARM (`arm-live`, ne shadow)
v session a nuluje se s novou session (`ensureDailySession`). Dokud
`sessionArmedAt > 0`, worker odmítne `update-group`, `activate-group` i
`arm-live` s payloadem, jehož `safety`/`followers` jsou **mírnější** než aktuálně
držené. Chyba: `Error('Pravidla jdou dnes jen zpřísnit: <pole> …')`. Mírnější je:

| pole | mírnější, když |
|---|---|
| `dailyMaxLosingTrades`, `dailyMaxTrades`, `dailyLossLimitUsd` | nová hodnota > stará, nebo nová 0 (vypnuto) při staré > 0 |
| `entryCooldownMinutes` | nová < stará |
| `tradingWindow` | `enabled` true→false, `from` dřív, `to` později |
| `armExpiryFlatten` | `group`→`followers`, cokoliv→`off` |
| `dayRuleActions.*` | `lock`→`pause`; `pause`→`null`; `pause.minutes` menší |
| follower `dailyLossCutUsd` | nová > stará, nebo vypnuto při staré zapnuté |
| follower `maxContracts` | nová > stará, nebo undefined při staré definované |
| follower `onCut` | `close-copy`→`let-run` |
| follower `multiplier` | nová > stará |
| nový follower | povolen jen s `dailyLossCutUsd > 0` nebo pokud žádný stávající follower cut nemá |

Odebrání followera a zpřísnění čehokoliv je vždy povolené. Před prvním ARM v
session je povolené všechno (validace DLR platí dál).

### 2.5 Relay (`server/tradovateCopierCommandRelay.ts`)

- Allowlist: odebrat `unlock-day`. Enqueue `unlock-day` → 400 `unsupported-command`.
- Tighten-only jako druhá vrstva: relay si při každém claim/report ukládá
  poslední `status.group` (safety + followers) a `status.sessionArmedAt` workeru
  (existující místo, kde se ukládá status — rozšířit). Při enqueue
  `update-group`/`activate-group`/`arm-live` s `sessionArmedAt > 0` a mírnějším
  payloadem (stejná tabulka, sdílená funkce `isWeakerRiskConfig(prev, next)` v
  `lib/` — použije ji worker i relay) → 409 `tighten-only`. Worker zůstává
  autoritativní; relay je jen dřívější odmítnutí.

## 3. Worker — limity účtů

### 3.1 Broker port (`services/brokerPort.ts`, `services/tradovateBroker.ts`, `services/mockBroker.ts`)

```ts
export interface BrokerAccountRiskSnapshot {
  accountId: number;
  at: number;                       // čas dotazu
  realizedPnlUsd: number | null;    // cashBalance.realizedPnL (dnes, vč. poplatků)
  netLiq: number | null;            // accountRiskStatus / cashBalance
  minNetLiq: number | null;         // accountRiskStatus (floor propky)
  dailyLossAutoLiq: number | null;  // userAccountAutoLiq.dailyLossAutoLiq
  trailingMaxDrawdown: number | null;
}
listAccountRiskSnapshots(accountIds: readonly number[]): Promise<BrokerAccountRiskSnapshot[]>;
```

Tradovate: `GET /cashBalance/deps?masterid=`, `GET /accountRiskStatus/deps?masterid=`,
`GET /userAccountAutoLiq/deps?masterid=` (vše read-only, ověřeno sondou
`docs/TRADOVATE_RISK_LIMITS_CAPABILITY_20260903.md`; parsování viz
`server/tradovateAccountData.ts`). Chybějící pole = `null`, nikdy 0.

### 3.2 Poll

Za ARM (i shadow) každých 30 s pro leader + followery; navíc ihned po každém
vlastním fillu na daném účtu. Výsledek do `state.safety.accountRisk[accountId]`
(+ `verifiedAt = at`). Snapshot starší než 90 s = **neověřeno** (status to hlásí,
UI ukazuje amber „neověřeno"). Chyba pollu = `lastError` se NEnastavuje (není to
fail-closed stav copieru), jen `accountRisk[id].error`.

### 3.3 Vyřazení (cut)

Pro followera s `dailyLossCutUsd > 0`:

- **Pomalá cesta (autoritativní):** ověřený snapshot s `realizedPnlUsd <= -dailyLossCutUsd`.
- **Rychlá cesta (pojistka):** realizovaný PnL účtu z vlastního ledgeru workeru
  (fill události daného účtu, bez poplatků; stejná lot logika jako u leadera)
  `<= -dailyLossCutUsd`. Bez poplatků je to konzervativnější o poplatky —
  vyřadí nejpozději v momentě, kdy by broker snapshot ukázal hůř.
- Při zásahu: `followerCuts[id] = { at, until: sessionEndAt, realizedPnlUsd, cutUsd, source: 'broker'|'ledger', closed: null }`,
  runtime follower `mode = 'off'` do konce session (nemění uloženou skupinu —
  pouze runtime override; po nové session se obnoví), audit `follower-cut`,
  `recentCopyEvents`/notifikační plán dostane událost (§6).
- `onCut === 'close-copy'` a účet drží kopii → existující `flattenAccount(accountId, 'cut-<accountId>-<sessionDate>')`.
  Úspěch → `closed = at`. Selhání → `closed = false`, follower zůstává off,
  audit `follower-cut` s důvodem, a dál platí (upřesněno 2026-09-05 po review):
  - **odmítnutí před odesláním** (worker sám flatten odmítl, např. cizí
    symbol na účtu, neověřitelný stav kopie, chyba cancelu u let-run) →
    stav účtu je známý, nic neletí: skupina **zůstává ARM bez `lastError`**,
    ostatní followeři kopírují dál; neuzavřená kopie se chová jako let-run
    (leader exit se do ní kopíruje, aby se zavřela s leaderem, nový vstup ne);
  - **neznámý výsledek broker příkazu** (liquidate odeslán, flat nepotvrzen,
    outbox `unknown`) → obecný invariant copieru má přednost: `lastError`,
    fail-closed celé skupiny bez auto-close (`autoClose:false`); žádný retry.
  - Recovery/restart a update-group cesty (runtime už DISARMED) drží
    původní fail-closed chování, nic se neobnovuje naslepo.
- `let-run` → kopie zůstává, exit leadera se do ní **kopíruje dál** (snižování
  expozice není blokováno), nové vstupy ne.
- Skupina se **nezamyká**, ostatní followeři nedotčeni. Nikdy se v téže session
  neobnovuje.
- Leader nemá `dailyLossCutUsd` (řídí ho Pravidla dne). Validace odmítne.

### 3.4 Limit propky (jen ke čtení)

`propLimitUsd = dailyLossAutoLiq ?? (netLiq != null && minNetLiq != null ? netLiq - minNetLiq : null)`.
Status ho vrací per účet; UI ho ukáže jako „Limit propky" se štítem, když
`verifiedAt` < 90 s. Validace (UI i worker): `dailyLossCutUsd <= 0.95 * propLimitUsd`,
je-li `propLimitUsd` známý; jinak bez omezení (ale UI varuje „limit propky
neověřen").

## 4. Status a DTO

`CopierControllerStatus` (typy už v základní větvi, plnit je má fáze A):

```ts
pause?: { until: number; rule: CopierDailyRule; at: number } | null;
sessionArmedAt?: number;          // > 0 = tighten-only
followerCuts?: CopierFollowerCut[];
accountRisk?: CopierAccountRiskSnapshot[];   // vč. propLimitUsd, verifiedAt, error
```

Companion DTO (`lib/macCompanionContract.ts`, `server/macCompanionStatus.ts`,
contractVersion zůstává 1, pole volitelná): `pause: { until, rule } | null`,
`accountCuts: number`, `tightenOnly: boolean`. Companion (fáze C):

- nový stav **PAUZA** (rodina „běží", amber): lišta „⏸ PAUZA" bez minut,
  popover „Pauza do HH:MM · pravidlo", auto-open při přechodu do pauzy (DLR §11 companion specu).
- ZAMČENO beze změny, jen věta „Odemknout jde jen v LIVE…" → „Zámek skončí s
  koncem session (00:00 Chicago)".
- sekce Bezpečnost: řádek „Vyřazené účty · N" (rose když N > 0).

## 5. PWA (fáze B)

- `lib/tradovateLiveTab.ts`: přidat `'risk'` (`?tab=risk`). Nav v
  `components/TradovateLiveDesk.tsx`: položka **Risk** (ikona `Shield` z lucide)
  mezi Live Dashboard a Účty.
- `components/LiveRiskTab.tsx` (nová): banner zámku (bez tlačítka Odemknout,
  text podle §0), banner pauzy (amber, „Pauza do HH:MM · pravidlo · vstupy se
  nekopírují"), karta **Pravidla dne** (`LiveDayRulesCard` rozšířená o sloupec
  **Akce**: select `Pauza N min` / `Zámek dne`; u ztrátových obchodů a denní
  ztráty hodnota `Stupňovitě` a v podtitulku „1. ztráta pauza 20 min · 2. ztráta
  zámek dne" resp. „80 % pauza 30 min · 100 % zámek dne"; minuty editovatelné
  přes malý input vedle selectu; hlavička ukazuje pill Pauza + počet zámků), karta
  **Účty a propky** (`components/LiveAccountRiskTable.tsx`, nová: sloupce Účet
  (název z `accountProfiles`/`snapshot.accounts`, pod ním id a role), Propka
  (firma + fáze), Limit propky (read-only, štít = ověřeno < 90 s, jinak „neověřeno"),
  Max ztráta (input USD), Max kontr. (input), Dnes vč. poplatků (hodnota + lišta
  vůči „Max ztráta"), Při dosažení (select Zavřít kopii / Nechat dojet), Stav
  (Kopíruje / Kopíruje · blízko limitu ≥ 80 % / Vyřazen do konce session + „vypnout
  při X · kopie zavřena HH:MM" / Obchoduje pro leadera); banner vyřazení nad
  tabulkou; tlačítko Uložit limity = `update-group` s followery).
- **Live Dashboard**: `LiveDayRulesCard` nahradit `components/LiveRiskSummaryCard.tsx`
  (pill Pauza / „N zámků · k/n účtů kopíruje", čtyři mini lišty: denní ztráta,
  ztrátové obchody, obchody, účet nejblíž limitu; odkaz „Otevřít Risk" → `?tab=risk`).
- Tighten-only v UI: když `status.sessionArmedAt > 0`, vstupy, které by pravidlo
  zmírnily, jsou disabled s tooltipem „dnes jen zpřísnit"; hlavičky karet mají
  štítek „jen zpřísnit" (zámek). Uložení mírnější změny server odmítne — UI
  zobrazí chybu z relay/workeru, nic neukládá lokálně.
- Odstranit `UnlockDayDialog`, `onUnlockDay`, tlačítko „Odemknout…" a text
  „Odemknutí je možné jen tady". Testy upravit.
- Companion deep link „Pravidla dne" (pokud existuje) → `?tab=risk`.

## 6. Notifikace (`services/nativeCopierNotificationPlan.ts`, fáze C)

- `rule-pause`: „Pauza do HH:MM — <pravidlo>" (amber, jednou za pauzu).
- `follower-cut`: „Účet <název> vyřazen — ztráta −X USD, limit Y" (rose, jednou za účet a session);
  při `closed === false` navíc „Kopii se nepodařilo zavřít — zkontroluj účet" (critical).
- Zámek podle DLR beze změny.

## 7. Bezpečnostní invarianty a testy

- Pauza nikdy neDISARMuje, nezavírá pozice, nekopíruje nové vstupy, kopíruje exity; vyprší sama; lock má přednost.
- `unlock-day` je odmítnut relayem (400) i workerem (Error); UI ho nenabízí.
- Tighten-only: každý řádek tabulky §2.4 má test (worker i `isWeakerRiskConfig`), před prvním ARM je vše povolené, nová session resetuje.
- Cut: broker i ledger cesta; stale snapshot nevyřadí; `close-copy` volá flatten, selhání = lastError + follower off; `let-run` kopíruje exit; skupina se nezamkne; ostatní followeři kopírují; nová session obnoví.
- Leader s `dailyLossCutUsd` = validační chyba. `dailyLossCutUsd > 0.95 * propLimit` = chyba.
- Restart workeru zachová pauzu, cuts, sessionArmedAt.
- Sanitizer: chybějící `dayRuleActions` → DEFAULT, neplatné → null; staré skupiny dál validují.
- Render test Risk záložky (8 sloupců, stavy), summary karta, companion PAUZA stav.

## 8. Fáze a doručení

Základní větev: `claude/risk-tab-base-20260905` (kompaktní karta + sdílené typy). Každá
fáze ve vlastním worktree z této větve, bez `npm ci` (sdílený `node_modules` symlink):

- **A — worker + relay** (`services/copierRuntimeController.ts`, `brokerPort.ts`,
  `tradovateBroker.ts`, `mockBroker.ts`, `lib/copierRiskConfig.ts` (nový, `isWeakerRiskConfig`),
  `server/tradovateCopierCommandRelay.ts`, testy `tests/copierRuntimeController*.test.ts`,
  `tests/copierDayRuleActions.test.ts`, `tests/copierFollowerCut.test.ts`, `tests/copierRiskConfig.test.ts`, relay testy).
- **B — PWA** (`lib/tradovateLiveTab.ts`, `components/TradovateLiveDesk.tsx`,
  `LiveCopyTradeOverview.tsx`, `LiveDayRulesCard.tsx`, nové `LiveRiskTab.tsx`,
  `LiveAccountRiskTable.tsx`, `LiveRiskSummaryCard.tsx`, testy `tests/liveCopyDayRulesRender.test.ts`,
  `tests/liveRiskTabRender.test.ts`). Data bere z typů v základní větvi; dokud A neběží,
  status pole jsou undefined → UI ukazuje „neověřeno"/bez pauzy.
- **C — companion + notifikace + docs** (`lib/macCompanionContract.ts`, `server/macCompanionStatus.ts`,
  `macos/AlphaTradeStatus/…` (PAUZA stav, texty), `services/nativeCopierNotificationPlan.ts`,
  testy, zápis do `docs/PROJECT_LOG.md`).

Ověření každé fáze: `npx vitest run <dotčené testy>` zeleně a `npx tsc --noEmit -p tsconfig.json`
bez nových chyb (stávající chyby jsou jen v `extension/`). Commit v worktree, žádný push.
