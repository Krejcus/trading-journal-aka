# AlphaTrade Status — macOS menu-bar companion (specifikace v1.3)

Datum: 2026-08-31 · Návrh: Claude + uživatel · Revize v1.1: zapracované
Codex review (freshness model, endpoint, datový kontrakt, pairing, SHADOW,
kontrast). Revize v1.2: skutečný stav lokální implementace po safety review
2026-09-01. Revize v1.3 (2026-09-02): skutečný produkční stav po aktivaci,
přenos do `main` a poučení z auto-deploye. Určeno: Codex (implementace).

Stav bran (v1.3): 2026-09-01 proběhla po výslovném souhlasu **produkční
aktivace** — záloha, migrace `mac_companion_devices_v1`, deploy API/PWA,
reálný pairing a instalace 0.2.0 do `~/Applications` s autostartem. Deploy
byl ale promovaný z lokálního zdroje a **další automatický deploy z `main`
(2026-09-02 ráno) companion API smazal** — status route vracela 404 a appka
správně ukazovala fail-closed „STAV NEDOSTUPNÝ". Náprava: companion je od
2026-09-02 přenesený do čisté větve nad `origin/main` (`codex/mac-companion-20260902`)
a **musí být sloučen do `main`**; jen tak přežije další deploy. Do té doby
platí: žádný další ruční promote.

## 0. Co to je a co to NENÍ

Malá nativní macOS aplikace žijící POUZE v horní systémové liště. Skutečná
implementace používá AppKit `NSStatusItem` + `NSPopover` se SwiftUI obsahem,
aby měla jediný systémový pill, správně reagovala na světlý/tmavý vzhled a
umožnila řízenou animaci otevření. Dock je skrytý přes `LSUIElement`. Je to
**read-only pozorovatel a rozcestník** nad cloudovým stavem copieru — odpovídá
na otázku „je systém pod kontrolou?" bez otevírání LIVE. Autostart kandidáta
0.2 se zapne až v produkční aktivační fázi; lokálně nainstalovaný mock 0.1
zatím dál startuje stávajícím uživatelským LaunchAgentem.

**Tvrdé zákazy (bezpečnostní hranice, ne UI detail):**

- žádný ARM/DISARM, žádné zapínání/vypínání kopírování,
- žádný Flatten, kill switch, rušení či změny příkazů,
- žádný restart/reinstall workeru, žádná změna leadera/skupiny,
- žádné brokerové přihlašovací údaje,
- žádné trvale viditelné P&L (patří do LIVE),
- „Zkopírovat diagnostiku" nikdy nesmí obsahovat tokeny ani nic použitelného
  k ovládání.

Read-only musí být vynucené serverově (token scope, §8), nikoli schovaným UI.

Terminologie: slovo „ARM" se nepoužívá **v UI companionu** (stav se jmenuje
LIVE, zeleně). Zbytek AlphaTrade (LIVE desk, log, kód) terminologii nemění.

## 1. Vizuální podklady a schválené nativní odchylky

- Živý proklikávací návrh (rozbalovací sekce, animace):
  https://claude.ai/code/artifact/3a4517e8-767f-41f1-8d41-f6d1677663ae
  — 2 stránky (Tmavý / Světlý režim), 5 popoverů + lišta na každé.
- Zdrojové soubory v repu: `mockups/menubar-companion/*.dc.html`. POZOR:
  nejsou samostatně spustitelné (odkazují `support.js`, který dodává runtime
  canvasu) — slouží jako zdroj barev, textů a struktury
  (inline styly); interaktivní chování ověřuj v artifactu výše. Mapování:
  - `MenuBar*.dc.html` — 5 stavů položky v liště,
  - `Main*` LIVE · `Disarmed*` VYPNUTO · `Zasah*` ZÁSAH NUTNÝ ·
    `Neznamy*` STAV NEZNÁMÝ · `Shadow*` SHADOW (soubory bez „Light" = tmavý
    režim),
  - `at-logo.png` — ořez `public/logos/at_logo_light_clean.png`.
- Data v mockupech (MNQ/MES, časy, 20/20, APEX-2) jsou ukázková.

Po testu na skutečné liště mají přednost schválené AppKit adaptace: nativní
28pt status button, jediný systémový pill (nikdy pill v pille), dynamický
`effectiveAppearance` a kompaktní fitting width. Mockup proto není absolutní
zdroj geometrie systémové lišty.

## 2. Design tokeny

Fonty: v nativní appce **SF Pro** (text) a **SF Mono** (vše s třídou `.mono`
v mockupech: časy, symboly, počty). Váhy: text semibold, hodnoty bold,
titulky sekcí heavy 10 pt s letter-spacingem, hlavní stav heavy 17 pt.

Tmavý režim („Absolute Midnight"):

| token | hodnota |
|---|---|
| pozadí popoveru | `#050811`, border `rgba(255,255,255,0.08)`, radius 12 |
| karta sekce | `#0a0f1d`, border `rgba(255,255,255,0.05)`, radius 8 |
| text primární / sekundární / titulky sekcí | `#f8fafc` / `#94a3b8` / `#475569` |
| emerald (LIVE, OK) | `#10b981`, text `#34d399`/`#6ee7b7` |
| rose (problém) | `#f43f5e`, text `#fb7185`/`#fda4af` |
| amber (stale/pozor) | `#f59e0b`, text `#fbbf24`/`#fcd34d` |

Světlý režim („Premium Slate", `.light-theme` z `index.css`):

| token | hodnota |
|---|---|
| pozadí popoveru | `#ffffff`, border `#e2e8f0` |
| karta sekce | `#f8fafc`, border `#e2e8f0` |
| text primární / sekundární / titulky sekcí | `#0f172a` / `#475569` / `#64748b` |
| emerald / rose / amber | `#059669`·`#047857` / `#e11d48`·`#be123c` / `#d97706`·`#b45309` |

Sleduj systémový vzhled (`effectiveAppearance`), ne vlastní přepínač.

## 3. Freshness model (ZÁVAZNÝ — opraveno po review)

Jediný zdroj pravdy o čerstvosti je stáří posledního cloudového heartbeatu
(`observedAt`). Prahy drž konzistentní se serverem (relay považuje heartbeat
za platný 10 s; 90 s je watchdog tolerance) — ideálně je čti ze serverové
odpovědi, ne hardcoduj:

| stáří heartbeatu | prezentace |
|---|---|
| ≤ 10 s | ověřený stav — LIVE/SHADOW/VYPNUTO/ZÁSAH podle obsahu |
| 10–90 s | **STAV NEZNÁMÝ** (amber `?`) + „Naposledy potvrzeno X ve HH:MM" |
| > 90 s | **WORKER OFFLINE** — červený problém (ikona `!`, hlavní stav WORKER OFFLINE, jinak layout jako STAV NEZNÁMÝ s červeným rámem) + naposledy potvrzeno |

Hrany jsou přesné: 10,000 s je ještě ověřeno, 10,001 s neznámé; 90,000 s je
neznámé, 90,001 s offline. `observedAt` v budoucnosti je vždy neznámý stav,
nikdy čerstvější než realita.

Žádná 30minutová hranice neexistuje pro držení zeleného stavu — 30 min byl
jen starý widgetový cache limit a companion ho nepřebírá. Zelená/neutrální
prezentace NIKDY nesmí přežít 10 s bez potvrzení.

Pravidlo č. 1: stará data vždy přebijí poslední známý stav. Neutrální vzhled
vyžaduje čerstvé potvrzení (heartbeat + čistá reconciliation, případně níže
popsaný odložený preflight ve vypnutém/SHADOW režimu), ne absenci
chyby; jakákoli nejistota = amber. Zelená = „kopírování běží", nikdy „je to
bezpečné"; červená a amber mají vždy přednost. VYPNUTO ≠ flat — flat se
tvrdí jen s časem brokerova ověření.

`VYPNUTO` je čerstvě ověřený stav příkazové části copieru: heartbeat je
≤ 10 s a interní `copierState == disarmed`. Potvrzuje pouze, že copier
neposílá příkazy; nulovou brokerovou expozici lze tvrdit až s úplným důkazem
podle §7.3. Bez něj je VYPNUTO rose, s ověřeným flat je neutrální.

## 4. Položka v liště

Logo = skutečné AT logo (`at-logo.png`, výška ~17 pt), **identické ve všech
stavech**; stav nese pill a text vedle, nikdy barva loga.

| stav | obsah | pill pozadí (dark / light) | text |
|---|---|---|---|
| VYPNUTO · flat ověřen | SF `power` + `VYPNUTO` | `rgba(255,255,255,0.10)` / `rgba(0,0,0,0.07)` | default |
| VYPNUTO · expozice neověřena | SF `power` + `VYPNUTO` | `rgba(244,63,94,0.26)` / `0.14` | `#fecdd3` / `#be123c` |
| ZAMČENO | SF `lock.fill` + `ZAMČENO` | `rgba(244,63,94,0.26)` / `0.14` | `#fecdd3` / `#be123c` |
| LIVE | `LIVE 42m` | `rgba(16,185,129,0.22)` / `0.16` | `#a7f3d0` / `#047857` |
| SHADOW | `SHADOW` | `rgba(255,255,255,0.10)` / `rgba(0,0,0,0.07)` | default |
| Zásah nutný / WORKER OFFLINE | `!N` | `rgba(244,63,94,0.26)` / `0.14` | `#fecdd3` / `#be123c` |
| Stav neznámý (10–90 s) | `?` | `rgba(245,158,11,0.22)` / `rgba(217,119,6,0.14)` | `#fde68a` / `#92400e` |

`42m` = minuty do expirace LIVE session, průběžně aktualizované.

## 5. Popover (šířka 360, padding 14, mezery 10)

Anatomie: 1) hlavička (logo + „AlphaTrade Status" + pill aktuálnosti
`● Ověřeno před X s` / amber `● Bez nových dat X s`), 2) blok hlavního stavu,
3) rozbalovací sekce, 4) tlačítka. Přesné hodnoty v mockupech.

Hlavní stavy a pořadí sekcí:

- **LIVE** (`Main*`): emerald blok `LIVE` + `42 min` + „2 pozice · session
  vyprší ve 13:35". Sekce: Kopírování (otevřená) → Bezpečnost → Runtime →
  Snímky.
- **SHADOW** (`Shadow*`): neutrální šedý blok `SHADOW` + badge `sleduje` +
  „žádný příkaz se neodesílá · followeři potvrzeni flat ve 12:44". Sekce:
  Sledování leadera (otevřená; pozice „jen sledováno", Poslední signál,
  „Kopie by šla N followerům · nic neodesláno") → Bezpečnost → Runtime →
  Snímky.
- **VYPNUTO · flat ověřen** (`Disarmed*`): neutrální šedý blok s ikonou
  `power`, titulkem `VYPNUTO`, badge `flat ověřen` a časem brokerova ověření.
  Sekce (vše sbalené): Bezpečnost → Expozice → Runtime → Snímky.
- **VYPNUTO · expozice neověřena** (`DisarmedUnverified*`): rose blok s ikonou
  `power`, titulkem „VYPNUTO" a řádkem „Copier je vypnutý · neposílá příkazy ·
  potvrzeno před X s". Pod hero je pouze nenápadná muted věta „Expozice není brokerem
  ověřena — flat nelze tvrdit", nikoli velký varovný banner. Sekce jsou
  všechny sbalené v pořadí Bezpečnost → Expozice → Copier runtime → Snímky.
  Tento stav potvrzuje jen vypnuté odesílání příkazů a **nikdy netvrdí flat**.
- **ZAMČENO** (`Lock*`): pouze při čerstvě `verified`,
  `copierState == disarmed`, `dayLock.active == true` a bez problému. Rose blok
  s `lock.fill`, titulkem `DEN ZAMČENÝ`, badge `do HH:MM` a řádkem
  `Automaticky v HH:MM · pravidlo …` nebo `Ručně v HH:MM · „důvod“`.
  Muted text vysvětluje, že odemknout lze jen v LIVE s potvrzením a důvodem.
  Primární akce je pouze `Otevřít LIVE`; companion nemá odemykací ani
  zapínací command. Sekce: Pravidla dne (otevřená) → Bezpečnost → Runtime
  → Snímky. Problém `!N`, STAV NEZNÁMÝ a WORKER OFFLINE mají přednost.
- **ZÁSAH NUTNÝ** (`Zasah*`): rose blok + počet problémů + čas fail-closed.
  Sekce: Bezpečnost (auto-otevřená, červená) → Expozice (auto-otevřená,
  `19/20` + řádek selhavšího účtu) → Runtime → Snímky; nad tlačítky červený
  banner „Divergence se nikdy neopravuje obchodem z tohoto panelu…".
- **STAV NEZNÁMÝ** (`Neznamy*`): amber blok + „Naposledy potvrzeno LIVE ve
  12:52" + varovný banner. Sekce sbalené, **plná čitelnost** (žádná globální
  průhlednost), každý titulek nese `· naposledy HH:MM`.
- **WORKER OFFLINE**: varianta NEZNÁMÉHO s červeným rámem/blokem (viz §3);
  samostatný mockup neexistuje — odvodit ze `Zasah*` (barvy) + `Neznamy*`
  (struktura „naposledy").

Texty mocků „followeři potvrzeni flat", `20/20` a „broker potvrdil flat" jsou
fixture/cílové varianty. Cloudový kandidát 0.2 zobrazuje expozici jako
„neověřeno" a follower ack jako „nedostupné". Čerstvý, bezpečnostně čistý
interní stav `copierState: "disarmed"` bez `verifiedAt` se prezentuje jako
VYPNUTO, nikdy potvrzené flat.
Pokud `verifiedAt` existuje, ale důkazy flat jsou neúplné (například chybí
`accountsWithWorkingOrders: 0`), zůstává STAV NEZNÁMÝ. Stará data přebijí
VYPNUTO stejně jako každý jiný poslední stav.

Mimo copier stavy existují provozní obrazovky klienta: načítání, čekající
pairing s kódem, přístup zrušen a lokální/transportní chyba. Všechny používají
neutrální nebo amber `?`; nikdy z nich nevzniká LIVE ani tvrzení o expozici.

Rozbalovací sekce — pravidla (klíčové pro 20+ účtů):

- hlavička sekce: titulek vlevo, **vždy viditelný jednořádkový souhrn**
  (tečka + text + čas) + chevron; souhrn při problému zčervená — sbalení
  nikdy neschová problém;
- sekce s problémem se otevře automaticky (ručně sbalitelná);
- **agregace followerů**: `N/M followerů · čas`; jednotlivý účet se vypíše
  JEN při selhání (`APEX-2 · ENTRY nepotvrzeno · 4 min`);
- řádek pozice: `SYMBOL` (mono) + chip `LONG`/`SHORT` + `×kontrakty`;
- Snímky TradingView jsou oddělené od zdraví copieru.

Sekce **Pravidla dne** se zobrazuje v LIVE, VYPNUTO a ZAMČENO pouze tehdy,
když status DTO obsahuje `dailyRules`; při chybějícím poli se nezobrazuje a
companion nic neodhaduje. Obsahuje progress řádky ztrátových obchodů, denní
ztráty proti limitu a obchodů dnes a stavové řádky obchodního okna a
cooldownu. Autoritativně spuštěné automatické pravidlo je rose/červené;
sbalený souhrn je `N pravidel spuštěno` nebo `Žádné nespuštěno`.
V ZAMČENO začíná otevřená, jinak sbalená. `realizedLossUsd` se smí objevit
jen uvnitř této sekce, nikdy v pillu, hero ani notifikaci.

Tlačítka (34 pt): primární gradient + stín + odlesk, bez ikony — LIVE/SHADOW/
VYPNUTO · flat ověřen „Otevřít LIVE" (emerald `#10b981→#059669`), ZÁSAH
„Otevřít LIVE —
vyřešit" (rose), NEZNÁMÝ/OFFLINE „Obnovit stav" (amber, refresh ikona);
sekundární „Deník" jen v klidných stavech; ikonové: refresh, diagnostika.
Kliknutí otevírá příslušnou stránku PWA.

VYPNUTO bez brokerového ověření má primární rose tlačítko bez ikony „Zapnout
v LIVE", které pouze otevře `?page=live&tab=overview`, dále „Deník", refresh
a diagnostiku.
Companion nemá žádné ARM/zapínací tlačítko ani command scope; nadále drží jen
`copier.status.read` a samotné zapnutí je výhradně rozhodnutí v PWA.

Samotné `reconciliation.status: "review"` v interním vypnutém nebo SHADOW
režimu není incident, pokud jsou `divergences` prázdné,
`outbox.stuckCount == 0`, `killSwitchTripped == false` a `problems[]`
neobsahuje nic jiného než
`reconciliation`. Hlavní stav a pill zůstávají VYPNUTO/SHADOW, Bezpečnost má
amber souhrn „Kontrola před zapnutím" a amber řádek „Reconciliation — Proběhne
před zapnutím"; sekce se sama neotevře. V LIVE nebo s kterýmkoli dalším
problémem zůstává `review` důvodem pro ZÁSAH NUTNÝ.

Animace: výsledná AppKit adaptace kombinuje nativní animaci `NSPopover` se
vstupem obsahu 0,18 s (opacity 0,94→1, y −4→0, scale 0,985→1, origin nahoře).
Reduce Motion pohyb vypíná. Rozbalení/sbalení sekcí je obousměrně plynulé
0,25 s ease; chevron se otáčí 0↔180° za 0,22 s synchronně.

## 6. Endpoint (opraveno po review — NEPOUŽÍVAT widget snapshot na polling)

`/api/native-widget-snapshot` se NESMÍ pollovat: každé volání dnes dělá
čerstvý broker snapshot a několik Tradovate requestů. Companion potřebuje:

1. **Nový levný endpoint `/api/mac-companion/status`** — čte POUZE cloudový
   heartbeat/stav z DB (žádné broker volání). Kandidát 0.2 polluje nejvýše po
   5 s při LIVE/problému a po 8 s v klidném SHADOW/VYPNUTO; stav si lokálně
   přepočítává každou sekundu. Okamžitě obnovuje při otevření popoveru a po
   probuzení Macu. Při wake nejprve synchronně zneplatní časovou důvěru, takže
   předspánkové zelené LIVE nemůže přežít neúspěšný refresh.
2. **Brokerové ověření expozice není součástí 0.2.** Status route nekontaktuje
   Tradovate ani jiný externí endpoint a vždy vrací `verifiedAt: null`, prázdné
   `positions`, `followerAck: null` a `accountsWithWorkingOrders: null`.
   Autoritativní read-only expozice by byla budoucí samostatně navržená a
   schválená fáze; do té doby companion nikdy netvrdí „flat".

## 7. Datový kontrakt

### 7.1 Zásady

Verzovaný **allowlist DTO** (server posílá jen vyjmenovaná pole, klient
neznámá pole ignoruje). Autoritativní pravidla kontraktu a reduceru jsou
implementovaná v TypeScriptu a zrcadlená v macOS Swift klientu. iOS widget a
Live Activity zatím používají vlastní vyhodnocení; jejich sjednocení zůstává
samostatná budoucí práce.

### 7.2 Implementovaný DTO v1 (uživatelem schválený pro lokální implementaci)

```jsonc
{
  "contractVersion": 1,
  "serverTime": "…",             // korekce lokálního clock skew
  "revision": 1234,              // epoch ms last_seen_at; klient zahazuje nižší
  "observedAt": "…",             // čas heartbeatu, řídí §3
  "validUntil": "…",
  "freshness": {
    "verifiedMaxAgeSeconds": 10,
    "offlineAfterSeconds": 90
  },
  "copierState": "live" | "shadow" | "disarmed",
  "sessionExpiresAt": "…" | null,
  "worker": { "lastHeartbeatAt": "…", "location": "mac" | "vps" },
  "brokerConnected": true | false | null,
  "safety": {
    "reconciliation": { "status": "clean" | "review" | "unknown", "at": "…" | null },
    "divergences": [ { "symbol": "…" | null, "account": "…", "detail": "…" } ],
    "outbox": { "stuckCount": 0, "oldestStuckMinutes": null },
    "cooldownActive": false, "dayLockActive": false, "killSwitchTripped": false
  },
  "exposure": {                   // null = neověřeno (UI: „neověřeno", NE flat!)
    "verifiedAt": "…" | null,
    "positions": [ { "symbol": "MNQ", "side": "long", "qty": 1, "at": "…" } ],
    "followerAck": { "confirmed": 19, "total": 20,
      "failing": [ { "account": "APEX-2", "detail": "ENTRY nepotvrzeno", "sinceMinutes": 4 } ] } | null,
    "accountsWithWorkingOrders": 1 | null
  },
  "snapshots": { "cdpReady": true, "lastEntryAt": "…" | null, "lastExitAt": "…" | null },
  "problems": [ { "kind": "divergence" | "stuck-outbox" | "reconciliation" | "worker-offline", "text": "…" } ]
}
```

### 7.3 Poctivé limity dnešního runtime (UI s nimi musí počítat)

- `recentCopyEvents.followers` je dnes jen počet NAKONFIGUROVANÝCH followerů
  — runtime neumí pravdivě dodat „20/20 potvrzeno brokerem" per pozice.
  Dokud server nedodá skutečný per-follower ack, je `followerAck: null`
  a UI ukazuje „potvrzení followerů nedostupné", NIKDY vymyšlené `N/N`.
- `groupFlat` může dnes vyjít true i nad chybějící mapou pozic
  (`copierRuntimeController.ts`) — „flat ověřen" se smí tvrdit jen při
  neprázdném `exposure.verifiedAt`, prázdném seznamu `positions` **a**
  `accountsWithWorkingOrders === 0`, nikdy z `groupFlat`.
- Přepnutí LIVE ↔ vypnuto zneplatní preflight a worker provede novou
  autoritativní kontrolu až před dalším zapnutím. Proto samotné `review` v
  interním vypnutém/SHADOW režimu při prázdných divergencích, nulovém stuck
  outboxu, neaktivním kill switchi a bez jiného druhu v `problems[]` znamená
  „Kontrola před zapnutím", ne incident. V LIVE nebo s dalším problémem je
  stejné `review` nadále fail-closed ZÁSAH NUTNÝ; přechod do LIVE preflight
  nijak neobchází ani neoslabuje.
- Mockupové `20/20` je cílový stav kontraktu, ne dnešní schopnost.

Server parsuje bezpečnostní pole fail-closed. Chybějící, špatně typované nebo
jen částečně neplatné seznamy divergence/working-order účtů znamenají
`reconciliation.status: "unknown"`, nikdy odvozené `clean`. Externí ID účtů
se v DTO neposílají; server je převádí jen na role typu `Follower 2`.

## 8. Pairing, token a distribuce (opraveno po review)

iOS widget flow NELZE převzít beze změny: používá už přihlášenou Supabase
session a tabulka je vázaná na iOS bundle (`native_widget_devices` /
`nativeWidgetRemote.ts`). Mac companion potřebuje:

- **jednorázové potvrzení párování v přihlášené PWA** (companion vygeneruje
  pairing kód, uživatel ho potvrdí v PWA),
- kód má 12 znaků Crockford Base32 bez zaměnitelných `I/L/O/U` a platí 10 min,
- secret POUZE v macOS Keychainu; server ukládá jen SHA-256,
- **vlastní audience/scope `copier.status.read`** — token nesmí umět nic
  jiného; nikdy nepoužít relay credentials (ty umí posílat příkazy),
- **seznam zařízení + revokace**: v PWA vidím spárované Macy a můžu
  ztracený Mac revokovat bez znalosti jeho secretu,
- pairing start je veřejný pouze pro vytvoření čekající žádosti a má atomický
  databázový sliding-window limit 10 požadavků / 10 min / HMAC IP bucket a
  120 / 10 min globálně; surová IP se neukládá ani neloguje,
- čekající párování expiruje za 10 min; bounded cleanup ponechá hodinovou
  toleranci pro poctivou odpověď „vypršelo",
- podpis Developer ID a finální způsob autostartu se řeší až při distribuci.

Tabulky `mac_companion_devices` a `mac_companion_pairing_rate_limits` jsou
server-only: RLS je zapnuté, `anon` ani `authenticated` nemají přímé granty a
operace dělá jen server přes `service_role`. PWA potvrzuje kód přes běžnou
přihlášenou Supabase session; kód zůstává jen v React state a před requestem
se z UI vyčistí. Mac drží secret i případný čekající kód pouze v Keychainu
(`AfterFirstUnlockThisDeviceOnly`, bez synchronizace).

Serverová část je změna produkčního API — platí worker-deploy politika
(obchodní dny: čekat na „nasaď").

## 9. Vyřešená designová rozhodnutí

1. **Barva primárního tlačítka**: uživatel výslovně zvolil emerald místo
   indiga. Platí emerald.
2. **Logo na světlé liště**: uživatel vyzkoušel a odmítl tenký obrys —
   platí čisté skleněné logo. Jediný nativní pill a dynamický světlý/tmavý
   vzhled byly fyzicky ověřeny v lokálním prototypu.

## 10. Fáze a akceptační kritéria

- **Lokální fáze 1 — hotovo:** nativní vizuál, AppKit status item/popover,
  světlý i tmavý vzhled, animace a deterministické mock stavy.
- **Lokální fáze 2/3 — hotovo:** cloudový read-only klient 0.2, DTO/reducer,
  Keychain, pairing/revokace, PWA správa zařízení, status API, izolovaná
  migrace a rate limit.
- **Produkční aktivace — proběhla 2026-09-01** (záloha → souhlas → migrace →
  deploy → pairing → instalace build 3, pak 4 a 5). Reálná revokace zatím
  netestována; XCUITest runner se nerozběhl.
- **Otevřené po přenosu do main (2026-09-02):** merge feature větve do `main`
  a ověření pairing/status/revokace na auto-deployi; rotace secrets
  exponovaných v diagnostice + přesun `VITE_GROQ_API_KEY` na server; rate
  limit na `pairing/confirm`; registrace autostartu v aktivní relaci; poctivě
  označená levná data (working-order účty s časem reconciliation, poslední
  kopie jako paměť běhu) a návrh `exposureSnapshot` publikovaného workerem
  po jeho autoritativní reconciliation (žádné brokerové volání z panelu).

Akceptace (minimálně):

- [x] Ikona zobrazuje 5 stavů z §4; „ARM" se v companionu nevyskytuje.
- [x] Všech 5 popoverů (vč. SHADOW) odpovídá mockupům v obou režimech.
- [x] Lokální reducer a wake testy drží freshness přechody přesně dle §3:
      odpojení sítě ⇒ do ~10 s STAV
      NEZNÁMÝ, po 90 s WORKER OFFLINE; obnova ⇒ návrat bez restartu;
      zelená nikdy nepřežije 10 s bez potvrzení.
- [x] Sekce plynule oběma směry; problémová se otevře sama; souhrn viditelný
      i sbalený.
- [x] Followeři jsou agregovaní; `followerAck: null` ⇒ „nedostupné", ne fake
      N/N; „flat" jen s `verifiedAt` + prázdnými pozicemi + explicitní nulou
      working orders.
- [x] Companion nepolluje widget snapshot a kandidát 0.2 nemá žádný brokerový
      endpoint ani brokerové přihlašovací údaje.
- [x] Zdroj a lokální bezpečnostní testy vynucují jediný scope
      `copier.status.read`; diagnostika neobsahuje secret, kód ani token.
- [ ] Po produkční migraci ověřit skutečnou atomickou souběžnost rate limitu,
      pairing/status/revokaci a zamítnutí revokovaného credentialu E2E.
- [ ] Teprve po úspěšném E2E podepsat/nainstalovat 0.2 a odstranit fixture ze
      stávajícího LaunchAgentu.

## 11. Auto-otevření při změně stavu (návrh v1.4, 2026-09-03)

Cíl: když se stav copieru změní, popover se **sám ukáže s rozbalenou sekcí,
která změnu způsobila**, a zase zmizí. Je to ohlášení, ne kokpit — nic
neovládá, nekrade fokus a nikdy neohlásí zlepšení ze starých dat.

### 11.1 Spouštěče (přechody mezi vyhodnocenými stavy, ne stavy samotné)

| přechod | kategorie | chování |
|---|---|---|
| ověřený stav → ZÁSAH NUTNÝ; nový skutečný problém v `problems[]` (divergence, stuck outbox, reconciliation mimo výjimku §5/§7.3); `brokerConnected` true → false; → WORKER OFFLINE; LIVE session vypršela nebo vyprší za ≤ 5 min | **zhoršení** | auto-otevřít, sekce s problémem rozbalená, zůstane až do zavření (max 60 s), + nativní notifikace, volitelný zvuk, pill 3× zapulzuje |
| problém zmizel; broker reconnect; OFFLINE → ověřeno | **zlepšení** | auto-otevřít jako toast na 8 s (jen když je zapnuto „i zlepšení"), bez notifikace |
| VYPNUTO/SHADOW → LIVE; LIVE → VYPNUTO/SHADOW; VYPNUTO ↔ SHADOW | **režim** | toast 8 s + notifikace bez zvuku |
| ověřený nezamčený stav → ZAMČENO | **lock** | jako zhoršení: auto-otevřít Pravidla dne na max 60 s, nativní notifikace, volitelný zvuk a 3× pulz pillu |
| nové `dailyRules.warnings[]` | **rule-warning** | tichá nativní notifikace nejvýš 1× pro klíč pravidlo + `sessionEndsAt`; bez auto-otevření |
| ZAMČENO → VYPNUTO při změně `dailyRules.sessionEndsAt` | **lock-expired** | tichý toast na 8 s `Nová session — zámek vypršel`; nikdy nezapíná copier |
| ověřeno → STAV NEZNÁMÝ (10–90 s) a zpět | — | **nikdy** (síťové zaškobrtnutí) |
| start aplikace, wake z spánku, ruční refresh | — | nikdy; první snapshot po startu jen nastaví výchozí bod |

VYPNUTO s ověřeným flat → VYPNUTO bez brokerového důkazu expozice není
zhoršení a samo nevyvolá toast ani notifikaci. Samotný odložený preflight
reconciliation podle §5/§7.3 také není zhoršení. Skutečný problém nebo offline
přechod z VYPNUTO se klasifikuje stejně fail-closed jako z ostatních stavů.

Změna se vyhodnocuje výhradně z výstupu freshness reduceru (§3) porovnáním
předchozí a nové prezentace; přechod se počítá až po **3 s stabilního**
nového stavu (anti-flap) a **nejvýš jedno auto-otevření za 30 s**; další
změny v tom okně se jen zapíší do už otevřeného popoveru. Snapshot s nižší
`revision` nikdy přechod nevyvolá.

### 11.2 Chování popoveru

- Zobrazit přes `popover.show(relativeTo:)` bez `NSApp.activate` — appka
  nezíská fokus, klávesnice zůstává v TradingView/terminálu. `behavior =
  .transient`: klik mimo nebo Esc zavře hned.
- Auto-zavření timerem (60 s zhoršení, 8 s toast); timer se pozastaví,
  dokud je kurzor nad popoverem.
- Rozbalená je jen sekce spouštěče, změněný řádek má 1,2 s highlight
  (tón podle kategorie); ostatní sekce podle běžných pravidel §5.
- Když je popover už otevřený ručně, nic nevyskakuje — obsah se jen
  aktualizuje a změněný řádek dostane highlight.
- Reduce Motion: bez pulzu a highlightu, jen zobrazení.

### 11.3 Nativní notifikace

`UNUserNotificationCenter` s jednorázovým souhlasem (sandbox je v pořádku).
Posílá se pro kategorie zhoršení, režim, lock, rule-warning a lock-expired.
Lock může použít volitelný zvuk; warning a expirace jsou vždy tiché. Text
obsahuje stav/pravidlo, ale nikdy čísla účtů, `realizedLossUsd` ani jinou
P&L částku. Klik na notifikaci otevře
popover (ne LIVE — rozhodnutí zůstává na uživateli). Notifikace řeší
fullscreen TradingView, kde je lišta skrytá; respektuje Focus režimy macOS.

### 11.4 Nastavení (v popoveru, ikona ozubeného kola v hlavičce)

- Auto-otevřít při změně stavu — výchozí **zap**
- I při zlepšení — výchozí **vyp**
- Nativní notifikace — výchozí **zap** (po udělení souhlasu)
- Zvuk při zhoršení — výchozí **vyp**

Uloženo v `UserDefaults`; nic z toho neovlivňuje čtení stavu ani bezpečnost.

### 11.5 Implementační poznámky

- `CompanionStore` drží předchozí prezentaci; nová komponenta
  `CompanionTransitionDetector` (čistá funkce `(previous, next, now) →
  Transition?`) vrací kategorii + id sekce + id řádku. Testovatelné bez UI.
- `AppDelegate.presentTransition(_:)` řídí zobrazení, timer, pulz pillu a
  notifikaci; respektuje nastavení a rate limit.
- Testy: matice přechodů z 11.1 (včetně „nikdy" případů), anti-flap 3 s,
  rate limit 30 s, rollback revize, wake bez auto-otevření, Reduce Motion.
- Odhad: 1–2 dny (Codex).
