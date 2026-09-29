# Ověřovací review 7c + ST22 (511d2f35) — 29. 9. 2026

**Review 511d2f35 (proti 24ce34f7).** Jedna sonda vychází z pohledu rizika hůř než 24ce34f7 (P4, nález F1). Ostatní cesty jsou lepší nebo stejné. Před nasazením doporučuji opravit F1 a F6.

**Odpovědi na otázky**
1. **Vynechaný účet:** Nezůstane bez stopy. `failClosed` nastaví `lastError` („zavřeno 2/3; selhaly 200 (…nejasný broker write…)“), kopírka je DISARMED a UI ukáže error toast. Po doběhnutí lane ho ale nic automaticky nezkusí znovu (autoClose:false, auto-close je jednorázový). Stejně se chovala už verze 24ce34f7. Retry po uvolnění vrátí flat=true a čerstvé čtení zabrání druhému liquidate na 200.
2. **Souběžný druhý write na vynechaném účtu:** Nenastane. Sonda P1 ukazuje maxInflight200=1 pro flattenGroup, retry stejného id i flattenAccount(200). Auto-close, emergency i guard čtou stejné mapy. Na zapisovatelném účtu ale souběh vzniká, viz F1.
3. **Kill switch:** Západka se neobchází. Zápis lane blokuje `assertReturnBarrier` (řádek 5714) a kill po testu zůstává true. Flatten pod kill switchem je záměr a platil už v 24ce34f7.
4. **Dvojklik se stejným id souběžně:** V pořádku. Sonda P3 ukazuje 1 liquidate na účet a oba dostanou stejný promise. Problém nastává až po neúspěšném dokončení, viz F1.
5. **ST22:** První instalace, starý worker bez manifestu, stejný SHA i dopředný commit projdou. Else větev v `.sh` funguje (rc=128 skončí STOP). Downgrade ze sourozenecké větve ale guard propustí (F6).

**Nálezy**

- **F1 – Střední, potvrzeno sondou P4.** Retry stejného operationId pošle druhý liquidate souběžně s prvním, který ještě běží.
  - Místo: `services/copierRuntimeController.ts` ~5086–5097 (neúspěch se maže z cache). `emergencyBroker` na ~4992–5003 neeviduje raw write (liquidate, cancel), které běží dál i po 20s timeoutu. `settleFollowerCutBackgroundAccounts` (1494–1525) hlídá jen `followerCutBrokerWritesByAccount`.
  - Scénář: liquidate na 201 skončí jako indeterminate a Flatten selže. Retry se stejným id pak vytvoří čerstvý isolated store, najde položku „planned“ a pošle druhý liquidate.
  - Důkaz: po změně události `["100:liq","200:liq","201:liq","201:liq(CONC 2)"]`. Ve 24ce34f7 vrátí cache odmítnutí a liq201=1.
  - Paradox: chybová hláška říká „blind retry stejného operationId je zakázaný“, a stejné id se hned znovu provede.
  - Zmírnění: UI generuje nové id na každý klik (`LiveCopyTradeOverview.tsx` 1689/1709) a relay má durable delivery checkpoint. Kliknutí s novým id má tentýž souběh, ten ale existoval už ve 24ce34f7.
  - Oprava: registrovat raw write nouzové lane do per-account in-flight mapy, sjednocené s follower-cut mapou, a v settle takové účty chránit. Případně ponechat výsledek v cache, dokud některý účet má indeterminate nebo běžící write.
  - Jistota: vysoká.

- **F2 – Nízká až Střední, potvrzeno sondou P1.** Vynechaný účet se ve výsledku hlásí jako prázdný, přestože broker má net200=1.
  - Místo: ~4826–4852 (`mergeProtectedAccounts`), ~5042–5050 (emergency), ~7141–7168 (leader-flat).
  - Scénář: účet dostane remainingPositions:0 a workingOrders:0 a chybí v remainingPositionAccounts. UI toast (`LiveCopyTradeOverview.tsx` 1401–1404) pak ukáže „positions=none working=none“ bez čísla účtu a bez důvodu.
  - Oprava: hodnoty nastavit na neznámé (null) nebo účet zařadit do remainingPositionAccounts. Toast ať vypíše failedAccounts a `account.error`.
  - Jistota: vysoká.

- **F3 – Nízká, z kódu.** Leader-flat guard s chráněným účtem ztrácí diagnostiku.
  - `failClosed` (~7183) dostane obecnou zprávu „cílené zavření není autoritativně potvrzené“ bez účtu. Ve 24ce34f7 tam účet i důvod byly.
  - Když fencing v mutate skončí dřív, syntetický výsledek přisoudí chybu „nejasný broker write z background lane“ i nezpracovaným zapisovatelným cílům.
  - `autoFlattenCopies` (~7384) v tomto případě uloží `lastAutoClose` bez pole `error`.
  - Oprava: do zprávy doplnit failedAccounts a syntetickou chybu dávat jen chráněným účtům.
  - Jistota: vysoká.

- **F4 – Nízká, latentní, z kódu.** Ne-background větev follower cutu nekontroluje výsledek flattenu.
  - Místo: volání `flatten(..., {preserveArm})` na 6102–6106.
  - Scénář: když selžou jen chráněné účty, `flatten` nehodí výjimku (~4902). Volající nekontroluje `flattenResult.flat` a cut se durable uloží jako `closed=at` (~6177), tedy falešný úspěch.
  - Dosažitelnost je nízká: bariéra na 5911 předtím ověří, že žádný write neběží. Muselo by vzniknout nové okno mezi 5911 a 6102.
  - Oprava: přidat `if (!flattenResult.flat) throw`, nebo při preserveArm házet výjimku i pro chráněné účty.
  - Jistota: střední.

- **F5 – Nízká, z kódu.** Settle při timeoutu je příliš konzervativní a nouzový Flatten může stále čekat.
  - Místo: 1522–1523 (`!settled && jobsByAccount.has`).
  - Scénář: po timeoutu se chrání všechny účty, které měly job, i ty, jejichž job už doběhl. Visící job, který nereaguje na abort (např. durable commit), dál zdrží nouzový Flatten všech účtů až o `followerCutDeadlineMs` (výchozí 90 s).
  - Není to horší než 24ce34f7, kde po 90 s selhalo všechno.
  - Oprava: sledovat dokončení po jednotlivých jobech a účty bez jobu zploštit okamžitě.

- **F6 – Střední, potvrzeno git demem.** Downgrade guard odmítne jen kandidáta, který je striktním předkem nainstalovaného SHA.
  - Místo: `server/macCopierInstallManifest.ts:47–61`, `mac-install.ts:241–256`, `mac-reinstall-safe.sh:79–94`.
  - Scénář: worker je nainstalovaný z release worktree (commit B) a reinstall se spustí z Documents/main (commit C, main se mezitím posunul). `is-ancestor C B` vrátí rc=1, takže guard instalaci povolí. Přitom `is-ancestor B C` také vrátí rc=1: kandidát nainstalované copier fixy neobsahuje. Přesně to odpovídá vaší topologii repozitářů.
  - Oprava: bez flagu povolit jen případ, kdy nainstalovaný SHA je předek kandidáta. Divergenci i rebase odmítnout s jasnou hláškou a vyžadovat `--allow-downgrade` (nebo nový `--allow-divergent`).
  - Jistota: vysoká.

- **F7 – Nízká.** Instalace a start workeru padají na chybách kolem gitu a manifestu.
  - `mac-install.ts:225–228` spouští git bezpodmínečně ještě před kontrolou flagu. Instalace ze stromu bez `.git` nebo bez Xcode CLT proto skončí surovou chybou „fatal: not a git repository“ a `--allow-downgrade` nepomůže.
  - Poškozený `install-manifest.json` hodí chybu ještě před kontrolou `--allow-downgrade`, takže flag ji neobejde.
  - `pilot.ts:404–407`: když manifest chybí nebo je vadný, worker nenastartuje a s ním zmizí i panic flatten přes worker.
  - Oprava: srozumitelná chyba, s flagem tolerovat nečitelný manifest a ve workeru číst manifest jen best-effort.

- **F8 – Info.** Guard příznak `dirty` ignoruje. Starý kód přes `git checkout old -- <cesty>` bez commitu projde jako „stejný SHA“. Dále `.sh` nově odmítá neznámé argumenty, dřív je ignoroval.

**Suite:** `npx vitest run …` v exportu 511d2f35 skončila rc=0: 178 souborů prošlo, 1 přeskočen, 2122 testů prošlo, 1 todo. Commit uvádí 180 souborů a 2128 testů, rozdíl v počtu je nejspíš jiný rozsah běhu, žádný test neselhal.

Oba exporty jsem smazal, worktree zůstal beze změny. Sondy a log suite jsou v `/private/tmp/claude-501/-Users-filipkrejca-Documents-trading-journal-aka/b16f225f-c916-4c52-96fe-960dd901fbf4/scratchpad/probes/r7c/`:
- `r7cProbe.test.ts`
- `suite.log`