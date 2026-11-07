# Víc kontraktů a obchodování z grafu ve skupinách s followery (návrh, 7. 11. 2026)

Zadání Filipa: „neomezený počet kontraktů (to, co dovoluje propfirma) a kopírování na skupiny“.
Návrh, nic z toho není postavené. Ověřený dnešní stav je v sekci Dnes, s odkazy na kód.

## Dnes

- **Strop kontraktů ručního vstupu:** běžná skupina s followery má natvrdo 1 (`manualEntryContractCap`,
  `services/manualEntryPreview.ts:32-39`). Ruční DEMO skupina (`manualOnly && localOnly`) 1–5, nastavuje
  ho jen installer (`--manual-entry-max-contracts`), pilot ho při startu přepíše a vzdálená změna skupiny
  ho nepřevezme. Protokol (relay i worker) pouští nejvýš 50 (`LEADER_ENTRY_MAX_QUANTITY`).
- **Limit propky z brokera nejde přečíst:** `/userAccountPositionLimit/deps` vrátil 0 položek pro
  Tradeify i Lucid (`docs/TRADOVATE_RISK_LIMITS_CAPABILITY_20260903.md`). `RiskCategory` jsme nečetli,
  dostupnost přes OAuth je NEOVĚŘENÁ. Jediný signál je odmítnutí „maximum position limit has been met“.
- **Strop followera už existuje:** `maxContracts` na followerovi (ručně, během dne jen zpřísnit).
  Náhled ho kontroluje (`max-contracts`).
- **Ve skupině s followery jde z grafu:** Limit a Stop se SL i TP (OSO). Kopie followerům přes
  `processOsoPair` (`services/copierRunner.ts:1215`), qty = `floor(qty × násobek)`, jen followeři
  `on-submit`. Správa a zavření OSO (fáze 2a–2d) funguje i s followery.
- **Jen v sólo DEMO:** Market (s nohami i holý), holý Limit/Stop, SL a TP po jedné, „Přidat SL/TP“,
  × holé pozice, přikoupení, posun nohou čekajícího vstupu a posun holého Limitu. Důvody:
  - korelátor OSO zná jako vstup jen Limit/Stop/StopLimit, Market rodiče nespáruje a kopie by
    vznikla bez nohou (`services/copierOsoCorrelator.ts`);
  - vstup bez nohou by followerům šel bez ochrany (INV-MANUAL-01);
  - nohy doplněné k pozici (OCO, samostatný Stop) kopírka followerům nikdy nezrcadlila, ta cesta
    neběžela ani jednou (NEOVĚŘENO).

## A. Strop kontraktů podle propky

Cíl: z grafu jde poslat tolik, kolik smí každý účet skupiny, ne 1 nebo 5.

1. **Limit zadává Filip u každého účtu** (leader i followeři): „max kontraktů“ podle pravidel propky.
   U followera už pole je (`maxContracts`), u leadera přibude `leaderMaxContracts` v konfiguraci skupiny.
   Z brokera se limit nečte (nejde), jen odmítnutí brokerem zůstává poslední pojistka.
2. **Strop ručního vstupu = limit leadera.** Follower dostane `floor(qty × násobek)` a jeho `maxContracts`
   kopii neořízne, ale vstup zablokuje (dnešní chování náhledu) — nikdy tichá menší kopie.
3. **Konec 1–5:** strop jde z appky v Edit group (změna skupiny = DISARM, jako dnes), installer ho
   nepřepisuje. Horní mez protokolu zůstává 50 (MNQ mikro; propky mají typicky do 40–50 mikro, potvrdit).
4. **Riziko:** brána DLL/MLL už počítá ztrátu při SL z počtu kontraktů. U vstupů bez SL zůstává výjimka
   jen pro sólo (INV-RISK-01), ve skupině bez SL nic.
5. **Přikoupení:** strop celé pozice = limit účtu (dnes `manualEntryContractCap`).

Dotčené: INV-RISK-01, INV-MANUAL-01, INV-GROUP-*, konfigurace skupiny (verze, hash, relay).

## B. Obchodování z grafu ve skupinách s followery

Po krocích, každý vlastní oponentura, DEMO záznam a nasazení. Pořadí podle rizika:

- **B1 — víc kontraktů u OSO Limit/Stop** (jen část A). Kopírovací cesta už existuje.
- **B2 — Market se SL a TP pro followery.** Varianty:
  a) korelátor naučit Market rodiče (pár Market + Stop + Limit nohy). Follower dostane Market OSO.
     Riziko: Market se vyplní hned, jakékoli zpoždění korelace = follower vstoupí pozdě za horší cenu,
     nebo vůbec, a pak divergence.
  b) leader i followeři dostanou příkaz paralelně z workeru (ne kopie z eventu leadera). Rychlejší,
     ale mění model „kopírka zrcadlí leadera“ (INV-PART-*, outbox) — velký zásah.
  Doporučení: a), s DEMO záznamem pořadí eventů placeOSO s Market rodičem.
- **B3 — SL a TP po jedné, „Přidat SL/TP“, posun nohou u pozice s followery.** Kopírka musí zrcadlit
  samostatný Stop/OCO k pozici každého followera s jeho qty. Dnes neběželo nikdy. Nutný DEMO záznam
  s followerem a návrh zrcadlení (vazba noha leadera → noha followera, rozjeté qty, follower bez pozice).
- **B4 — holý Market a holý Limit/Stop pro followery.** Prop účty bez SL jsou nejvyšší riziko
  (DLL propky = ztráta účtu). Návrh: jen s výslovným souhlasem Filipa a jen když mu propka dovolí
  obchod bez SL; jinak ve skupině bez SL ne.

## Otázky na Filipa

1. Kolik kontraktů smí každý účet (leader i followeři) podle propky? Stačí ručně v Edit group?
2. Pořadí: B1 → B2 → B3, a B4 (bez SL na prop účtech) vůbec ano, nebo ne?
3. Testování s followery: máš DEMO účty jako followery (ne prop eval), na kterých se B2/B3 dají
   naostro vyzkoušet bez rizika ztráty účtu?

## Oponentura návrhu (copier-design-critic, 7. 11. 2026): upravit, pak stavět

- **P1** Odmítnutí brokerem není pojistka: propka může limit hlídat až po obchodě (přetažení = ztráta účtu).
  Při stropu leadera nad 1 musí mít každý zapnutý follower vyplněné `maxContracts`, jinak ARM i náhled
  odmítnout. Vedlejší účinek: follower s `maxContracts` vypadne z rychlé záložní cesty (controller ~18881),
  rozpad korelace OSO pak = vynechaný obchod, tedy divergence (vědomě přijmout).
- **P1** Strop leadera vynucovat ve workeru (`placeLeaderEntry` i přikoupení: |net| + čekající + nové), ne jen v náhledu.
- **P1** Zvýšení stropu za session zakázat: strop leadera i `maxContracts` followerů do `isWeakerRiskConfig`
  (`lib/copierRiskConfig.ts`), zvyšovat až po 17:00 CT. DISARM → zvýšit → ARM by jinak obešel tighten-only.
- **P1** B2a nefunguje, jak je popsaná: Market z Tradovate dnes jde jako `unrelated` a obecné čekání by
  zpozdilo každý Market; nohy po fillu spadnou do `standaloneReduction` (cesta B3, nikdy neběžela); fill
  může předběhnout nohy; noha followera po pozdějším fillu může být přes trh a INV-OUTBOX-03 ji nedostaví.
  Zvážit B2c: Market jako Limit pár bodů přes trh (ef05afc8), korelátor ho už umí.
- **P2** Strop patří účtu, ne skupině (změna leadera, cloudová šablona). Strop leadera do `copyGroupConfigHash`.
  Migrace z pilotu (flag `--manual-entry-max-contracts`, `mac-reinstall-safe.sh`, rollback: neznámé pole = 1).
  Snížení limitu za běhu: nic se nezavírá, jen blok přikoupení a „nad stropem“ v UI.
- **P3** Pořadí B1 → B3 (ochrana: Přidat SL/TP, posun SL) → B2 → B4; B4 vyřadit, dokud INV-RISK-01 nemá strop
  ztráty pro účty bez SL. B1 potřebuje testy zaokrouhlení `floor(qty × násobek)` = 0 a dílčího fillu u followera.

### DEMO záznamy před stavbou (s followerem na druhém OAuth připojení)
- B1: Limit OSO 3+ ks s dílčím fillem (nohy plný počet, nebo vyplněný?); odmítnutí nad limitem (text, vynucuje DEMO?).
- B2: placeOSO s Market rodičem (pořadí submitted/fill/nohy, `parentOrderId`, čas vůči ACK), i 5+ ks;
  Market OSO na followerovi se SL těsně u trhu.
- B3: samostatný Stop a OCO k existující pozici (eventy, vazby id, modify, cancel), follower s jiným qty a bez pozice.
