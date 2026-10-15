# Živý deník — plán (14. 10. 2026)

Cíl (Filip): obchod je v deníku hned po zavření, vše aktuální, hlavně spolehlivé.

## Výchozí stav

- Worker na Macu průběžně posílá broker evidence (`tradovate_journal_evidence`).
- Import (`/api/tradovate/oauth/journal-import`, spouští ho jen otevřený klient
  každých 60 s) zkompaktuje evidence (`tradovate_journal_input_entities` /
  `_retained`), přečte **celý** zkompaktovaný vstup, spočítá **všechny** pozice
  znovu (`buildJournalPositionEpisodes`) a v jedné transakci **přepíše všechny**
  řádky `tradovate_journal_positions` (chybějící → `invalidated`).
- 13.–14. 10.: vstup 125 943 řádků / 81 MB (krok 0: bez `orderedThrough`, stránky
  po 1000), publish 510 pozic 8,8 s (service_role timeout zvednut na 30 s).
  Import od 7. 10. nefungoval; obnoveno 14. 10.
- Růst: `positionsnapshot` každých 5 min za účet (40 731 řádků, 25 MB) a
  opakovaně zachycené filly (32 269 řádků pro 1 328 fillů).
- Zátěž: kdo má otevřenou appku, spouští 80 MB import každou minutu, protože
  checkpoint „beze změny“ skoro nikdy neplatí (snímky chodí pořád).

## Cíl architektury (revize po oponentuře 14. 10.)

Oponentura původního návrhu (klouzavý kontrolní bod po účtech každých ~10 min)
našla kritické díry: jiný `baselineAt` → ztráta vzniku SL/TP u limitních
vstupů s bracketem, archivace části rodiny příkazu, pozdní entity bez času
(fillpair, fillfee, orderversion, copylink, TradeCorrect) by se do zmrazených
obchodů nepropsaly, persist bez CAS, staré nasazení obejde detekci, změna
propojení účtu, osud `accounting-pending`. Proto:

1. **Denní kontrolní bod za celé připojení** (K), posouvaný jednou denně v
   klidu (CME denní pauza / víkend), jen když: všechny účty flat na platném
   snímku, **žádný pracující příkaz**, žádný nepřiřaditelný fill před K.
   Posun se **sám ověří**: v tu chvíli se spočítá plné přehrání i okno od K +
   zmrazené pozice a posune se jen při shodě (fakta, filly, ochrana, P&L,
   status, nevzaté příkazy; `issues/complete` jen jako zobrazení).
2. **Okno od K:** builder začne každou lane s `net = 0, baselineAt = K` a
   ignoruje položky před K (bez pracujících příkazů v K je to ekvivalentní).
   Pozice s `entryAt < K` jsou zmrazené (`frozen`), persist je nikdy
   neinvaliduje; zmrazená pending pozice zůstane pending.
3. **Archivace celých rodin:** řádek vstupu se archivuje jen pokud je celá
   jeho rodina (order, děti, oco/linked, verze, commandy, reporty, filly, fees,
   pairy, ledger, copylinky) s aktivitou < K. Slovníky nikdy.
4. **Manifest K:** ID zmrazených fillů, orderů, pairů, commandů, verzí,
   copylinků. Každý import: nearchivovaný řádek odkazující do manifestu =
   pozdní evidence → **znovuotevření** na předchozí K (zásobník), kromě
   identické re-observace fillu přijaté po K (pole, která projekce čte).
   Trigger na vstupních tabulkách: věcná změna `latest.entity` archivovaného
   řádku ho odarchivuje a vyžádá znovuotevření (nezávisí na RPC).
   Změna propojení účtů (bindings) = znovuotevření.
5. **Ploty a CAS:** `input_heads.version = 2` před první archivací (staré
   RPC odmítnou); persist v3 s CAS na generaci vstupu a epochu K; publikace
   jen při změně hashe pozic okna (méně generací → méně padání starých iOS
   čtení, méně zátěže).

Živé okno pokrývá jen „dnešek“ (jednotky MB), takže import trvá sekundy.

## Rychlost „hned“

- **Spouštění na serveru:** upload evidence z workeru, který obsahuje obchodní
  aktivitu (fill, stream position, order/command s plněním), spustí import na
  serveru (`waitUntil`, jeden běh díky lease, smyčka do publikace v rozpočtu).
  Deník se tak aktualizuje i se zavřenou appkou.
- **Klient:** po publikaci se obnoví jen změněné obchody (ne celý deník);
  Realtime/odběr změn hlavy projekce místo minutového pollingu.
- Cílová latence: zavření pozice → obchod v deníku do ~5–10 s.

## Kroky (každý samostatně nasaditelný, testy + `verify-journal-positions`)

1. **Zátěž hned:** checkpoint „beze změny“ i když přišly jen snímky / backfill
   metadata (nemateriální evidence), plný běh nejvýš jednou za 30 min.
2. **Schéma (bez změny chování):** `archived`, `account_id`, `activity_ms`,
   `created_at` na vstupních tabulkách; `frozen`, `entry_at`, `exit_at`,
   `accounting_final` na pozicích; tabulka kontrolních bodů; zúžený trigger.
3. **Čisté TS:** `accountingFinal`, builder s K(A), výběr K(A), kandidáti
   archivace, detekce pozdní evidence. Property test: okno + zmrazené == plná
   projekce (12 účtů, reverzy, mezery, ms remízy, brackety, samostatné SL,
   copylinky, roll kontraktu, pracující příkazy, pozdní fee/fill/ledger).
4. **SQL v3:** okenní persist, archivace (CAS na generaci), znovuotevření,
   pojistka proti starému nasazení (stará funkce odmítne, jakmile je cokoli
   zmrazené).
5. **Stínový běh v produkci**, pak přepnutí.
6. **Spouštění ze serveru + klient** (bod „Rychlost“).
7. Vrátit `service_role` timeout na 8 s; dokumentace, PROJECT_LOG.

## Rizika

- Starší nasazení (preview) s plnou projekcí by po archivaci zneplatnilo
  zmrazené obchody → verze hlavy jako plot (krok 4) **před** první archivací.
- Mezera přesně v ms zavření, nevzaté příkazy přes zmrazená okna, merge base
  `position` patchů — pokryto testy.
- PGlite ověří logiku, ne časování PostgREST → stínový běh v produkci.
- Zálohy před každou změnou schématu (AGENTS.md).
