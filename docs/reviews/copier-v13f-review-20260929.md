# Review V13 páté iterace (52b943e + ad5778d) — 29. 9. 2026

**Review V13 v5 (ad5778d) proti 1a59237^: kritérium nesplněno — 3 vysoké nálezy, z toho 2 regrese, plus 3 další**

Incident P6 je opravený: proběhne bez REST (`listOrdersDelta=0`, na 1a59237^ 2) a zůstane ARMED. Opravy N4 (terminální stav má přednost, V4) a S1 (follower dostane `native-oso` místo OCO s holým Limitem) fungují. Zlepšení proti 1a59237^: L10, O7, P7, R9, V1/V1c a V3c. Tři jiné cesty ale nechají followera ve vstupu bez SL/TP nebo nechají osiřelou nohu working, a jedna sonda má nový falešný DISARM. Každý visící cancel drží eventTail nejvýš 2 s, to je splněné.

### F1 — VYSOKÁ, regrese: tombstone navždy zablokuje zrušení osiřelé nohy, i když ji reconcile doloží jako working
- **Kde:** `services/copierRuntimeController.ts:1659` (deklarace), `:1895` (filtr kandidátů), `:1947` (zápis), `:8695` a `:8735` (exit-only). Set se nikde nemaže, reset kolem `:11024` maže jen `flatSweepEntryCancelAttempts`. Reconcile sweep je na `:10676-10684` a kvůli tombstonu hned skončí.
- **Scénář:** followerovi se vyplní SL, cancel TP selže (HTTP 503) nebo visí. Následuje DISARM, broker se zotaví, uživatel spustí reconcile.
- **Důkaz** (`zzX_V13f.test.ts`, X1-fail a X1-hang):

  | | ad5778d | 1a59237^ |
  |---|---|---|
  | TP mo-3 po reconcile i po druhém flat eventu | working nad flat followerem | canceled |
  | počet cancelů | 1 | 2 (druhý za 3009 / 4509 ms, až po autoritativním čtení) |
  | reconcile / ARM | reconcile „ok“, ARM blokován („Před ARM musí být všechny účty bez pracovních příkazů“) | noha zrušena |

  Stav je hlasitý, ale kopírka nohu už nikdy neuklidí. Když ji cena vyplní, follower otevře nechráněnou pozici.
- **Oprava:** tombstone ať blokuje jen opakovaný write do prvního autoritativního čtení po uplynutí deadlinu. Když reconcile snapshot nohu ukáže jako working, nový cancel smí odejít (není to slepý retry). Tombstone mazat při reconcile a resetu. Totéž platí pro exit-only (`:8695`).
- **Jistota:** vysoká.

### F2 — VYSOKÁ, regrese (tichá): po N3 zůstane parciální OSO parent, jehož děti sweep už zrušil
- **Kde:** `:2099-2117` (`parentIds`): při leaderově vstupu ve stavu working se parent nezruší, i když jeho děti sweep ruší.
- **Scénář V2** (`zzV_Nove`): stav `V2-after-leader-remainder`:

  | | ad5778d | 1a59237^ |
  |---|---|---|
  | follower | +1, SL/TP canceled, parent filled 2 | stejná pozice |
  | stav | ARMED, `lastError` null | DISARM |

  Na v13e byl V2 lepší.
- **P1/P2:** stejný vzor (parent filled 2, nohy canceled, ARMED). Tady je 1a59237^ stejně tichý, v13e tu dával DISARM.
- **Pozor:** způsobila to i moje doporučení k N3 v minulém review. Opravuji ho: pravidlo pro parent je správné jen tehdy, když parent má stále živé děti.
- **Oprava:** otevřený parent se zbytkem nikdy nenechat bez živých dětí. Rušit ho spolu s dětmi a zbytek leadera řešit hlasitou divergencí, případně novou OSO kopií s čerstvým bracketem.
- **Jistota:** vysoká (sonda, mock nemodeluje nativní Tradovate).

### F3 — VYSOKÁ, není regrese (1a59237^ má totéž), ale N3 se k ní nedostane
- **Kde:** early return „všechny kandidátní nohy jsou terminální ve streamu“, zhruba `:1920-1926`. Skončí dřív, než se vyhodnotí OSO parenty.
- **Scénář X6:** parent vyplněn 1/2, leader plně vyplněn a flat. Followerovi se vyplní SL a TP zruší nativní OCO. Pak se vyplní zbytek parentu.
- **Důkaz:** obě verze skončí se stejným stavem: follower +1 bez SL/TP, leader 0, ARMED, `lastError` null.
- **Oprava:** před early returnem zkontrolovat otevřené OSO parenty účtu a symbolu (streamOnly) a zařadit je. Fill parentu po terminálních dětech → okamžitý fail-closed s auto-close.
- **Jistota:** vysoká pro chování sondy. Že Tradovate po terminálních dětech nechá zbytek bez ochrany, je jistota střední.

### F4 — STŘEDNÍ, regrese latence: první cancel sourozence čeká na REST `/position/list`
- **Kde:** `:1990-2049`. Hinted sourozenec se ruší až po `prePositionsPromise`.
- **Důkaz X3:**

  | Zpoždění `/position/list` | ad5778d: cancel TP | 1a59237^: cancel TP |
  |---|---|---|
  | 1,2 s | za 1203 ms | za 3 ms |
  | 7 s | za 6005 ms, navíc DISARM po vyčerpání budgetu | za 3 ms |

  Při zpomalení Tradovate tak osiřelá noha zůstane working až 6 s.
- **Oprava:** sourozence přesně vyplněného bracketu rušit hned, protože nemůže chránit novou pozici. Pre-read pozice ať hlídá jen ostatní nohy (to na N1/V3b nic nemění).
- **Jistota:** vysoká.

### F5 — STŘEDNÍ: falešný DISARM, horší než 1a59237^
- **Kde:** `:5840-5856`. Leader-flat guard z balíčku b762714 bere pro kontrolu osiřelé nohy `isOpenOrderStatus` včetně `pending`. To je v rozporu s výjimkou sweepu pro děti čekajícího OSO.
- **Důkaz V6:** ad5778d dá DISARM „doložená osiřelá ochranná noha mo-8“, kde mo-8 je Suspended dítě legitimní kopie e2. 1a59237^ zůstane ARMED.
- **Kdy to nastane:** stačí nový limitní OSO do 2 s (`leaderFlatGraceMs`) po leaderově flat.
- **Oprava:** guard ať převezme klasifikaci sweepu.
- **Jistota:** vysoká.

### F6 — NÍZKÁ (obrana do hloubky): streamové čtení ve sweepu nemá žádný deadline
- **Kde:** `:1735-1750`.
- **Důkaz:** stará sonda B3 (visící `findOrderStatusById`) na ad5778d zasekne frontu navždy, na 1a59237^ prochází.
- **Dosažitelnost:** v produkci je streamOnly u Tradovate i brokerRouteru synchronní, takže dnes nedosažitelné.
- **Oprava:** deadline zhruba 250 ms, po něm brát výsledek jako null.

### Ostatní ověřené cesty
- **X5 (tři visící cancely v jedné vlně):** každý write drží frontu nejvýš 2 s (ad5778d celkem 6,0 s, 1a59237^ 4,5 s). V obou verzích zůstanou všechny tři TP working a DISARM. Na ad5778d se kvůli F1 už nikdy nezopakují.
- **X2 (`/position/list` vrátí 503):** obě verze DISARM, TP je zrušený (ad5778d za 57 ms, 1a59237^ za 6 ms).
- **B5:** jde o timeout sondy (auto-close trvá přes 5 s), chování je stejné jako na 1a59237^.
- **Paměť tombstonu:** nepatrná a restart ji vyčistí. ID orderů jsou unikátní, takže u nové nohy se stejným ID problém nevzniká.

### Sady
- **Staré sondy (74 souborů):** na ad5778d 15 selhání (B2 ×6 známý artefakt, B3 ×3 = F6, B5 ×6 timeout), na 1a59237^ 7 selhání (B2 ×6, B1 ×1).
- **Předepsaná sada** v exportu ad5778d bez sond: 170 souborů prošlo plus 1 skipped, 1956 testů plus 1 todo, rc=0. Flake nebyl, izolovaně jsem nic neopakoval. Sada nezachytí F1–F5.

Nové sondy a výstupy obou verzí jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/v13f/`:
- `zzX_V13f.test.ts` (X1–X6)
- `x1-*.txt`, `x235-*.txt`, `x6-*.txt`
- `v13f-keyprobes-{post,pre}.txt`
- `v13f-suite-repo.txt`

Oba exporty jsou smazané, worktree jsem neměnil.