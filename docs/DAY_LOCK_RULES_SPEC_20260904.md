# Pravidla dne a zámek dne — specifikace v1 (2026-09-04)

Návrh: Claude + uživatel · Vizuál: Claude Design canvas, stránka „Zamčený den"
(https://claude.ai/code/artifact/3a4517e8-767f-41f1-8d41-f6d1677663ae) a
`mockups/menubar-companion/Lock*.dc.html` · Určeno: Codex (implementace).

## 0. Cíl a zásady

Uživatel chce, aby ho vlastní pravidla dne (ztráta, počet ztrát, počet
obchodů, obchodní okno, cooldown) **sama zamkla** a aby byl zámek vidět všude
(LIVE, lišta, notifikace). Rozhodnutí 2026-09-03: broker-side lock se nestaví
(viz `broker-side-lock-decision` v logu); vše je interní pojistka copieru.

Neměnné zásady:

- **Pravidla vyhodnocuje výhradně worker** ze svých dat (fill ledger, session
  hodiny). PWA ani companion nic nepočítají, jen zobrazují stav workeru.
- **Zámek nikdy nezasahuje uprostřed obchodu** — čeká na flat celé skupiny
  (existující `maybeEngageDayLock`). Platí i pro nová pravidla.
- **Odemknout jde jen v LIVE** (PWA, přihlášená session), s povinným důvodem,
  10 s prodlevou a zápisem do deníku. Odemknutí **nikdy neARMuje**; copier
  zůstává VYPNUTO. Companion (token `copier.status.read`) neodemyká nikdy.
- Companion zůstává read-only; nová pole DTO jsou jen ke čtení.
- Terminologie v UI: „VYPNUTO" (ne DISARMED), „ZAMČENO / Den zamčený".

## 1. Pravidla dne (`CopyGroupSafetySettings`, `services/liveCopyTrading.ts`)

Existující: `dailyLossLimitUsd` (0 = vyp), `dailyMaxLosingTrades` (0 = vyp),
`entryCooldownMinutes`, `armExpiryFlatten`. Nová (additivní, s defaulty, aby
staré uložené skupiny dál validovaly):

| pole | typ / default | sémantika |
|---|---|---|
| `dailyMaxTrades` | number, `0` = vyp, max 200 | počet UZAVŘENÝCH obchodů leadera za session (z ledgeru, stejná definice jako `losingTrades`); při dosažení → pending day-lock, spustí se po flat |
| `tradingWindow` | `{ enabled: boolean; from: 'HH:MM'; to: 'HH:MM'; timeZone: string }`, default `{enabled:false, from:'15:30', to:'22:00', timeZone:'Europe/Prague'}` | mimo okno: ARM odmítnut s důvodem; entry leadera mimo okno se **nekopíruje** (audit `blocked`, jako cooldown); konec okna za LIVE → pending day-lock (spustí se po flat). `from` < `to` v rámci dne; přes půlnoc zatím nepodporováno (validace odmítne). |

Validace na všech vstupech (UI, relay `arm-live`/`activate-group` group payload,
store) — fail-closed: neplatná hodnota = chyba, ne tichý default.

## 2. Stav zámku (worker `state.safety`, persistováno přes `persistSafety`)

Existující `dayLockUntil`, `dayLockReason`. Nová pole (additivní):

```ts
dayLockTrigger: 'manual' | 'daily-loss' | 'losing-trades' | 'max-trades' | 'window-end' | null;
dayLockAt: number | null;              // kdy se lock skutečně aktivoval (po flat)
dayLockSnoozedRules: DayLockTrigger[];  // pravidla vypnutá odemknutím do konce session
dayUnlock: { at: number; reason: string } | null;
dailyStats.tradesToday: number;         // uzavřené obchody leadera za session
dailyStats.windowState: 'inside' | 'outside' | 'off';
```

Reset všech polí při přechodu do nové session (stejný mechanismus jako reset
`dailyStats`). `lockUntil()` (ruční lock) nastaví `trigger: 'manual'`,
`dayLockAt`; auto-lock nastaví odpovídající trigger. `dayLockReason` zůstává
lidsky čitelný text.

## 3. Odemknutí dne

Nový příkaz `{ type: 'unlock-day'; reason: string }` (`lib/localCopierAgentProtocol.ts`).

- Relay (`server/tradovateCopierCommandRelay.ts`): povolit v allowlistu se
  stejnou validací důvodu jako `lock-until-session-end` (string, trim 3–200,
  bez řídicích znaků). Přichází pouze z přihlášené PWA session (jako
  `arm-live`). Companion token nemá k relay přístup — beze změny.
- Worker: pokud není aktivní lock → chyba „Den není zamčený". Jinak:
  `dayLockUntil = 0`, `dayUnlock = {at, reason}`, `dayLockSnoozedRules +=
  dayLockTrigger` (pokud byl automatický), `dayLockTrigger = null`; `gate.armed`
  zůstává false (žádný ARM). Audit `day-unlock` s důvodem. Snoozed pravidlo se
  do konce session znovu nevyhodnocuje; ostatní pravidla dál platí.
- Deník: záznam „Den odemknut · důvod · které pravidlo".

## 4. Varování před limitem (jednou na pravidlo a session)

Worker emituje audit událost `rule-warning` `{ rule, current, limit }` když:
`losingTrades == max-1`, `tradesToday == max-1`, realizovaná ztráta ≥ 80 %
limitu, 10 min před koncem okna. Ukládá `dailyStats.warnedRules` (persist),
aby se neopakovalo. Slouží pro push i companion.

## 5. Companion DTO (`/api/mac-companion/status`, contractVersion zůstává 1, pole volitelná)

```jsonc
"dayLock": { "active": true, "until": "…", "at": "…", "trigger": "losing-trades",
             "reason": "…", "unlocked": { "at": "…" } | null } | null,
"dailyRules": {
  "lossLimitUsd": 1000 | null, "realizedLossUsd": -620 | null,
  "maxLosingTrades": 2 | null, "losingTrades": 2,
  "maxTrades": 10 | null, "tradesToday": 4,
  "window": { "enabled": true, "from": "15:30", "to": "22:00", "state": "inside" } | null,
  "cooldownMinutes": 15, "cooldownUntil": "…" | null,
  "sessionEndsAt": "…",
  "warnings": [ { "rule": "losing-trades", "current": 1, "limit": 2, "at": "…" } ]
}
```

Server (`server/macCompanionStatus.ts`) pole odvozuje z heartbeatu fail-closed
(chybí → `null`, nikdy odhad). `realizedLossUsd` je risk metrika proti limitu,
ne P&L výpis — v companionu se ukazuje jen v sekci Pravidla dne, nikdy v liště
ani v notifikaci.

## 6. Prezentace

**Companion (macOS)** — mockupy `LockMenuBar`, `Lock`, `LockLight`, `LockNotify`:
- Nový stav **ZAMČENO**: freshness `verified`, `copierState == disarmed`,
  `dayLock.active`, žádný problém. Pill v liště: rose + ikona zámku + text
  `ZAMČENO` (odlišné od ⏻ VYPNUTO ikonou). Hero „DEN ZAMČENÝ · do HH:MM",
  řádek „Automaticky v HH:MM · pravidlo …" nebo „Ručně v HH:MM · „důvod"",
  věta „Odemknout jde jen v LIVE s potvrzením a důvodem".
- Sekce **Pravidla dne** (v LIVE, VYPNUTO i ZAMČENO): progress řádky ztrátové
  obchody, denní ztráta, obchody dnes, okno, cooldown; spuštěné pravidlo
  červeně. Sbalená = souhrn „N pravidel spuštěno" / „Žádné nespuštěno".
- Přechody (§11 specu companionu): → ZAMČENO = kategorie `lock` (chová se
  jako zhoršení: auto-otevření 60 s + notifikace + volitelný zvuk);
  varování před limitem = tichá notifikace 1× na pravidlo a den; vypršení
  zámku (nová session) = tichý toast „Nová session — zámek vypršel", nikdy
  nezapíná. Problémy (`!N`) mají dál přednost před ZAMČENO.
- Notifikace bez účtů a bez částek (text = pravidlo + „do HH:MM").

**PWA LIVE** — mockup `LockRules`:
- Banner nad overview při aktivním locku: „Den je zamčený do HH:MM · jak/čím",
  tlačítko „Odemknout…".
- Karta **Pravidla dne** nahrazuje dnešní rozptýlené safety inputy: 6 pravidel
  (max ztrátových obchodů, denní ztrátový limit, max obchodů, obchodní okno,
  cooldown, expirace LIVE session) — přepínač, hodnota, dnešní průběh
  (progress bar ze `dailyStats`). „Uložit pravidla" = existující cesta uložení
  skupiny (safety platí od dalšího zapnutí).
- Dialog **Odemknout den**: název pravidla + čas, povinný důvod, tlačítko
  aktivní až po 10 s, po potvrzení `unlock-day` přes relay; výsledek v deníku.
- Terminologie VYPNUTO/ZAMČENO i v LIVE.

**Push (PWA/iPhone)** — `services/nativeCopierNotificationPlan.ts`: nové
druhy `daylock-engaged` (okamžitě, s pravidlem), `rule-warning` (tiché),
existující `daylock-end` zůstává.

## 7. Bezpečnostní invarianty a testy

- Lock (ruční i auto) nikdy uprostřed obchodu; window-end čeká na flat.
- ARM mimo okno / za locku odmítnut s čitelným důvodem; entry mimo okno
  nekopírován (audit).
- Unlock nikdy neARMuje, nikdy z companionu, vždy s důvodem, snooze jen
  spouštějícího pravidla.
- Restart workeru zachová lock, snooze i varování (persist).
- Companion nikdy netvrdí flat; ZAMČENO jen při `verified`.
- Testy: kontrola pravidel (hranice N-1/N, 80 %, okno vč. hranic a časové
  zóny), snooze po unlocku, reset v nové session, relay round-trip a
  validace `unlock-day`, DTO odvození fail-closed, companion reducer/přechody,
  PWA karta a dialog (render + 10 s gate).

## 8. Fáze a doručení

- **A — worker + kontrakt + relay + server DTO** (`codex/daylock-worker-20260904`)
- **C — companion Swift** (`codex/daylock-companion-20260904`, paralelně s A,
  podle §5 DTO; do merge A ukazuje `dayLock: null` jako dnes)
- **B — PWA LIVE karta + dialog** (`codex/daylock-pwa-20260904`, po A)
- Nasazení: A mění worker bundle → worker-deploy politika (obchodní dny
  „nasaď", jinak víkend; reinstall jen z čistého reconciled stavu). Server a
  PWA jsou v jednom repu — merge A do `main` nasadí server DTO a relay;
  worker se reinstaluje samostatně.
