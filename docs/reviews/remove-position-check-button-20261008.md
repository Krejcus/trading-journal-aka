# Zadání: odstranit tlačítko „Zkontrolovat pozice“ (předávka do session „kvalita kopirky“)

Od: Claude (session LIVE rychlost), 2026-10-08 · schválil Filip · navazuje na větev
`claude/copier-durable-account-pause-20261006` (f59805da „ON runs its own position check“).

## Cíl
Filip chce tlačítko „Zkontrolovat pozice“ z UI úplně odstranit. Jeho práci převezme ON,
které si kontrolu pozic dělá samo (tvůj stage 1). Nesmí se přitom ztratit to, co tlačítko
dnes hlídá: **incident se nesmaže bez Filipova vědomí.**

## Podklady
- `docs/COPIER_INVARIANTS.md` (Codex, 8. 10.; zatím ve větvi `codex/copier-invariants-20261008`,
  worktree `~/alphatrade-worktrees/copier-invariants`, čeká na push do main).
  Relevantní: INV-DEFAULT-03, INV-RECON-01/02, INV-ARM-01/02/03, INV-UI-01/02,
  kontrolní seznam v sekci 3 (projdi ho celý před návrhem) a sekci 5.
- Review dokumentu: `docs/reviews/copier-invariants-review-20261008.md`.

## Co dnes tlačítko dělá
Veřejné `reconcile()`: read-only kontrola u brokera, auditovaný DISARM, pokud je ARMED,
a při čistém výsledku smaže `lastError` a durable `manualRecoveryRequired`. Tím je zároveň
**lidské potvrzení incidentu**. Interní kontroly (preflight, příprava ON, reconnect) incident
mazat nesmí.

## Návrh (ověř proti kódu; kde nesouhlasíš, napiš proč)
1. **ON převezme veřejnou kontrolu** (tvůj f59805da): s incidentem nebo chybějící
   reconciliací provede ON stejné `reconcile()`. Čistý výsledek → ARM přes všechny brány
   (INV-ARM-01). Jinak ON selže a vypíše konkrétní účty a důvod.
2. **Vědomé potvrzení incidentu.** Když `armPreparation.blockedBy === 'incident'`
   (nebo visí `manualRecoveryRequired` / `lastError`), ON nejdřív ukáže dialog s důvodem
   incidentu („Po incidentu: … Ověřím účty u brokera a zapnu.“). Teprve potvrzení pošle
   ARM s výslovným příznakem (např. `acknowledgeIncident: true`, vázaným na id / čas
   incidentu). Worker bez toho příznaku incident nesmaže a ARM odmítne. Zvykové
   kliknutí na ON tak incident nepřejde. Platí stejně pro web i iPhone (relay `arm-live`).
3. **Shadow a legacy ARM dnes incident mažou** (nález z review invariantů):
   - SHADOW (`localCopierExecutionAgent.ts` ~:850) volá veřejné `reconcile()`;
   - kompatibilní ARM bez `prepareArm` (~:818) taky.

   Obě cesty smažou `lastError` i `manualRecoveryRequired`. Ve stejné změně je musíš
   zavřít, jinak zůstanou zadní vrátka mimo potvrzení z bodu 2.
4. **Stav bez zapnutí.** Místo tlačítka stačí stav z přípravy ON na pozadí:
   - `ready`: „Připraveno“;
   - `blocked` / `incident`: „Po incidentu – ověří se při zapnutí“ + důvod;
   - jiné `blockedBy` (kill-switch, starting, recovery…): jen text bez akce.

   Panel údržby s tlačítkem odstranit (`LiveCopyTradeOverview.tsx`, `needsCheck`).
5. **Nečistý výsledek.** Filip účty srovná ručně v Tradovate (nikdy obchodem kopírky,
   INV-DIVERGENCE-01) a dá znovu ON. ON nikdy nedorovnává.
6. **OFF / kill během kontroly z ON** okamžitě vyhrají. Kontrolu zahodit, nic nezapnout
   (INV-ARM-03, INV-BRAKE-02). Restart workeru uprostřed: `manualRecoveryRequired` zůstane.
7. **Relay CHECK.** Produkční `tradovate_copier_commands_command_type_check` dnes nemá
   `reconcile`, takže tlačítko z iPhonu od 29. 9. nikdy nedorazilo k workeru. Oprava
   (migrace + test) je ve větvi `claude/relay-reconcile-check-20261008` (483d1579),
   **neaplikovaná**. Když tlačítko zmizí a ON jde přes `arm-live`, migrace není nutná.
   Rozhodni:
   - **(a)** neaplikovat a typ `reconcile` z relay allowlistu odebrat; nebo
   - **(b)** aplikovat, pokud ruční kontrolu ponecháš jinde (např. v Událostech).

## Testy (minimum)
- incident → ON bez potvrzení → odmítnuto, incident trvá, nic se neARMuje;
- incident → ON s potvrzením → čistá kontrola → ARMED + audit záznam, že incident smazal
  uživatel přes ON;
- incident → ON s potvrzením → nečistá kontrola → DISARMED, incident trvá, chyba vypíše účty;
- OFF / kill během kontroly z ON → nic se nezapne;
- restart workeru během kontroly → `manualRecoveryRequired` po startu trvá;
- SHADOW a legacy ARM incident nesmažou;
- UI render: incident → žádné tlačítko Zkontrolovat, text u přepínače, ON otevře dialog
  s důvodem; kill-switch / starting / recovery → bez dialogu i bez tlačítka;
- iPhone (relay): `arm-live` s potvrzením nese příznak, bez něj worker odmítne.

## Hranice
Neměnit ARM brány ani freshness. Kontrola z ON je jen read-only u brokera. Žádný blind
retry. Divergence se nikdy neopravuje obchodem. Nasazení workeru až na Filipovo „nasaď“
(obchodní den).
