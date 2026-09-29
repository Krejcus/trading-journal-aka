# Ověřovací review opravy 8b (aac0295) — 29. 9. 2026

**Review balíčku 8b (aac0295 proti 5fbd034)**

Kritérium „žádná sonda horší než 5fbd034 z pohledu rizika“ je splněné s jednou podmíněnou výjimkou, nálezem 1. Nálezy z review ab4b310 jsou opravené, kromě N6, které 8b samo vede jako budoucí práci.

Sada testů na aac0295 skončila **rc=0**: 170 souborů prošlo, 1 skipped; 1983 testů prošlo, 1 todo. Sondy jsem před během z exportu odstranil.

**Opravy nálezů z review ab4b310**
- **A1, A1b, N4:** vypnutí safety pojistky za ARM se teď odmítne (409) bez DISARM.
- **A2:** arm-live ze SHADOW už není no-op.
- **R1, R2, R3:** relay projde.
- **N2:** R1 a R3 relay zařadí do fronty podle P-B, R5 odmítne.
- **N5 (sonda A):** přepínač se odmítne a zápis vrátí zpět (`persistCalls 2`).
- **V15 D(−100) a D(−150):** bez likvidace.
- **A3:** in-place zavření cutu funguje.
- **A4** (snížení násobku uprostřed obchodu) padá záměrně podle P-A: 409 bez DISARM.

**Nálezy**

1. **STŘEDNÍ, podmíněně riziko: V15 spoléhá na to, že `cashBalance.amount` obsahuje dnešní realizovaný P&L**
   - **Kde:** `services/copierRuntimeController.ts:2341-2345`.
   - **Scénář:** pokud `amount` dnešní realizovanou ztrátu ještě neobsahuje a `netLiq` ano, výraz `cash − netLiq` ji vydává za otevřenou ztrátu. Realizovaná ztráta se pak odečte dvakrát a porušení prop rezervy se nezachytí.
   - **Důkaz (PR5):** cut 300, realizováno −100, `netLiq` 49 900, floor 49 700. Skutečný zbytek cutu je 200 a limit 190.
     - 5fbd034: `disarm=prop-limit`.
     - 8b: `armed=true`, žádný cut.
   - **Další poznatek:** podle komentáře v `tradovateBroker.ts:2003` produkční REST obvykle `netLiq` neposílá. Oprava V15 je tam tedy neaktivní a rezerva otevřenou ztrátu nevidí. To platí i pro 5fbd034, není to regrese.
   - **Oprava:** brát přímo `openPnL` ze snapshotu. Pokud živý stream ukazuje followera flat, počítat otevřenou ztrátu 0. Pokud se `cash` a `netLiq` u flat účtu liší, rozdíl nepoužít. Sémantiku `amount` / `amountSOD` ověřit na reálném snapshotu.
   - **Jistota:** mechanika vysoká. Že to nastane v praxi, spíš nízká, protože existence `amountSOD` naznačuje, že `amount` je průběžný.

2. **STŘEDNÍ, peníze a produkt, ne riziko: prop-reserve vždy zavře kopii i na ziskové pozici**
   - **Kde:** `copierRuntimeController.ts:1092-1099` (`effectiveFollowerCutAction`) spolu se `:2322`.
   - **Scénář:** trailing floor (`minNetLiq`) se zvedne o 100 díky high-water se ziskem v otevřené pozici, `netLiq` chybí. Kopie followera v zisku se zlikviduje a nastavení let-run se přebije.
   - **Důkaz (PR1 let-run, PR2 close-copy):**
     - 8b: `liq=[200]`, `src=prop-reserve`, ARM zůstane.
     - 5fbd034: `disarm=prop-limit` bez likvidace. Všechny kopie tím zůstaly bez správy, což je z pohledu rizika horší.
   - **Oprava:** zbytek cutu omezit dynamicky na 0,95 × rezerva a poslat upozornění. Likvidovat až při skutečném přiblížení ztráty k rezervě.
   - **Jistota:** mechanika vysoká. Jak často to nastane, závisí na tom, zda `maxNetLiq` dané propky zahrnuje nerealizovaný zisk.

3. **NÍZKÁ: in-place cesta volá `executeFollowerCutAction(..., true, false)`**
   - **Kde:** `copierRuntimeController.ts:11442` a `:11451`.
   - **Selhání:** chyba zavření jednoho followera vypne celou skupinu, i když živý cut drží selhání jen pro daný účet.
     - Sonda IP3: `disarm=flatten-failed` a kopie followera 201 zůstala otevřená bez správy.
   - **Chybějící event:** chybí follower-cut event pro UI.
   - **SHADOW:** `liveSideEffects` je natvrdo `true`.
     - Sonda IP4: SHADOW ARM zlikvidoval cut, který vznikl dřív za LIVE.
   - **Neaktuální výpočet:** `pendingCutClosures` se počítají mimo `eventTail`.
   - Proti 5fbd034 to horší není, stará verze vždy vypnula kopírku.
   - **Oprava:** za ARM volat se `scopedFailure` (tj. `emitCopyEvent=true`), `liveSideEffects` nastavit na `!gate.shadowMode` a uzávěry počítat až uvnitř `eventTail`.
   - **Jistota:** vysoká.

4. **NÍZKÁ: N6 zůstává otevřené**
   - **Kde:** `copierRuntimeController.ts:10762-10764`.
   - **Proč:** typy `'resynced'` a `'route-gap'` jako eventy neexistují, takže je to mrtvý kód. Router převádí resync na heartbeat (`brokerRouter.ts:230-231` a `:332`).
   - **Falešná odmítnutí přepínače:** za běžného provozu jsem žádná nenašel.
     - Verze kontroly roste jen při změně agregovaného spojení nebo při chybě, a chyba stejně vede na fail-closed.
     - Obnova spojení zhruba po 50 minutách přes router se kontroly nedotkne.
   - **Jistota:** vysoká.

5. **NÍZKÁ, dostupnost: syrové porovnání `disableReplicationOnBreach`**
   - **Kde:** `lib/copierRiskConfig.ts:125` a `server/localCopierExecutionAgent.ts:327-330`.
   - **Scénář:** runtime tuto hodnotu vždy přepíše na `true`, ale editor šablony (`LiveCopyTradeOverview.tsx:6159`) ji dovolí vypnout. Update-group po prvním LIVE ARM pak dostane 409 tighten-only, přestože změna nemá žádný účinek.
   - **Oprava:** tuto pojistku v syrovém porovnání ignorovat.
   - **Jistota:** střední.

6. **Upozornění pro sloučení s balíčkem 7 (background lane)**
   - **Riziko:** in-place close-copy běží na `eventTail`. Pokud lane balíčku 7 posílá zápisy na broker pro jednotlivé účty mimo `eventTail` (entry, scale-in, reprice OSO, sweep), mohla by po zavření kopii znovu otevřít, přikoupit nebo měnit už zrušené příkazy.
   - **Oprava:**
     - Před zavřením kopie lane pro daný účet zastavit a počkat na rozběhnuté zápisy.
     - Lane před každým zápisem znovu ověří `groupRevision` a aktivní cut.
     - Přidat merge test: in-place let-run → close-copy, zatímco lane právě zapisuje.

**Ověřeno bez nálezu**
- **Whitelist metadat, 9 variant:**
  - cooldown 10→0,
  - `armExpiryFlatten` followers→off,
  - `dailyLoss` 500→0,
  - vypnutí obchodního okna,
  - odebrání `maxContracts`,
  - `safety=null`,
  - kombinace snížení cutu a vypnutí autoClose,
  - autoClose jako řetězec `"false"`,
  - `localOnly` + jméno.
  
  Každé oslabení skončí 409 bez DISARM a konfigurace se nezmění. 5fbd034 při odmítnutí vypínala kopírku a kombinaci snížení cutu s vypnutím autoClose přijala. Všechna safety pole jsou v `isWeakerRiskConfig` pokrytá.
- **P-B (sonda RE):** re-enable při otevřené pozici leadera worker odmítne („Účet 100 má … otevřenou pozici“). ARM zůstane a follower 201 nedostane žádný příkaz. Přejmenování ze staršího UI snapshotu projde a `enabled` zůstane `false`.
- **Souběh in-place cutu s exitem leadera:**
  - Sonda IP1: exit leadera se po zavření zkopíruje jen na followera 201. Follower 200 nedostane žádný další Sell, takže nevznikne obrácená pozice.
  - Sonda IP2: když je exit ve frontě dřív, zkopíruje se (jeden Sell), likvidace neproběhne a pozice se nezavře dvakrát.
  - Zvýšení `groupRevision` zahodí rozběhnutou reconciliaci.

Sonda je v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/b8b-rev/zzB8bRevProbe.test.ts`. Oba exporty jsem smazal. Worktree je beze změny, stále na aac0295.