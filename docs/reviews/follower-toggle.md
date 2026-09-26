# Ruční zapnutí / vypnutí followera ve skupině

Stav: **zadání pro Codex** (jádro) · UI dělá Claude · autor zadání Claude, 2026-09-26
Mockup vzhledu: `mockups/follower-toggle.html` (vybraná varianta A).

## Co uživatel chce

Ve skupině jde každého followera dočasně vyřadit z kopírování přepínačem
v řádku účtu, bez mazání ze skupiny (násobek, strop, limity zůstanou).
Vzor: TradeSyncer.

Rozhodnutí uživatele (závazná):

1. **Přepnout jde jen mimo obchod** — vypnout i zapnout jen když **leader
   i ten follower** nemají otevřenou pozici ani working/pending příkaz.
   (Varianta „1.d": během obchodu přepínač zamčený.)
2. **Zapnutý účet naskočí od dalšího obchodu**, nikdy doprostřed pozice.
   Plyne automaticky z bodu 1 (leader musí být flat).
3. **Vypnutí platí do ručního zapnutí** — přežije restart workeru i další dny.

Další pravidla z návrhu:

4. Vypnutý účet se dál sleduje (zůstatek, pozice, denní P&L) a **Flatten na
   něm funguje**. Jen se na něj nekopíruje.
5. Flat vypnutý follower **není divergence** a nesmí blokovat ARM ani
   reconciliation, když leader obchoduje.
6. Automatická vyřazení (`dailyLossCutUsd`, breach, DLL, trade cut) jsou
   oddělená a ruční přepínač je **neobchází** — zapnutí účtu vyřazeného
   automaticky nesmí vyřazení zrušit.

## Návrh jádra (Claude + read-only konzultace s Codexem 2026-09-26)

Claude původně navrhoval postavit funkci na existujícím `mode: 'off'` +
`set-replication`. **Codex to rozporoval a má pravdu** — návrh je proto:

1. **Nové pole `enabled?: boolean` v `CopyFollowerConfig`** (default `true`),
   nezávislé na `mode`. Důvody:
   - `mode: 'off'` dnes nastavuje i runtime sám při automatických
     vyřazeních (`copierRuntimeController.ts` ~6092, 6720, 6728, 6760, 7766,
     7863, 7903) → ruční a automatické vypnutí by nešly odlišit.
   - Při zapnutí je nutné vrátit původní `on-submit` / `on-fill`.
   - Sanitizace v `liveCopyTrading.ts:554`, atomický zápis do `group.json`
     přes `fileCopyGroupStore.ts:10`. **Všechny editory, sanitizer a relay
     mappingy musí pole zachovat**; zastaralý plný `update-group` z UI ho
     nesmí přepsat (revision/CAS nebo merge z aktuální worker konfigurace).
   - `safety.followerCuts` nepoužívat — je to session/trade risk stav
     s expirací.

2. **Dedikovaný příkaz** `{ type: 'set-follower-enabled'; groupId;
   accountId; enabled }` v `LiveCopyTradingCommand`
   (`liveCopyTrading.ts:224`) + direct adapter
   (`copierRuntimeCommandAdapter.ts:54`), worker switch a relay
   whitelist/validace (`server/tradovateCopierCommandRelay.ts:129`).
   **Nepoužít obecné `applyGroup`/`updateGroup`** — dnes nejdřív DISARMuje
   a ukládá config před kontrolou controlleru
   (`server/localCopierExecutionAgent.ts:245`). Příkaz je idempotentní;
   audit uloží účet, stav před/po a případný důvod odmítnutí.

3. **Autoritativní brána „mimo obchod" jako nová controller metoda na
   `eventTail`** (stejná fronta jako změna epochy, `copierRuntimeController.ts`
   ~8488; broker eventy se řadí ~8763), takže nevznikne závod s právě
   odeslaným leader příkazem:
   - zablokovat, pokud běží pending lifecycle / nejistý outbox / recovery;
   - načíst positions + orders leadera i followera (dvakrát, ověřit
     observation/safety generation mezi čteními);
   - podmínka: obě strany pozice 0 a žádný working/pending příkaz;
   - durable uložit a teprve pak změnit participation generation;
   - jinak odmítnout s důvodem, stav beze změny.

4. **Dispatch i reconciliation.** `planReplication` už přeskakuje
   `mode: 'off'` (`copierEngine.ts:610`), `currentEntryIneligibleAccounts`
   skládá eligibility a cuts (`copierRuntimeController.ts` ~1005). Ale
   **reconciliation dnes očekává `leaderNet × multiplier`**
   (`copierRuntimeController.ts` ~8348) → flat vypnutý follower proti
   otevřenému leaderovi by hlásil divergenci. Pro ručně vypnutého followera
   musí být očekávaný stav vždy `0`; nenulová pozice nebo working order na
   něm zůstává viditelný safety problém. ARM participation ho vynechá,
   Flatten dál funguje přes členství ve skupině (~9199).

5. **Priorita automatiky:**
   `effectiveEnabled = configuredEnabled && eligible && !activeCut`.
   Ruční zapnutí nikdy nesmaže automatické vyřazení.

6. **Status DTO** (`/v1/status` už vrací `group` i controller stav,
   `server/localCopierExecutionAgent.ts:217`): přidat
   `controller.followerParticipation[]` s poli `accountId`,
   `configuredEnabled`, `effectiveEnabled`, `canToggle`, `blockers[]`,
   `automaticExclusion?`. Blockery: odpojeno / starý snapshot, pozice
   leadera/followera, jejich working/pending příkaz, fronta broker eventů /
   pending lifecycle, nejistý outbox / recovery, DLL / BREACHED.
   UI z toho zamyká přepínač a ukazuje důvod; rozhoduje ale vždy worker.

## Kritéria správnosti (testy)

1. Vypnutí flat followera při flat leaderovi → další leader entry se na něj
   nekopíruje, ostatní followeři normálně; žádný fail-closed, žádná
   divergence, ARM projde.
2. Pokus o vypnutí/zapnutí při leaderově otevřené pozici → odmítnuto,
   mód beze změny, kopírka zůstává ARMED.
3. Pokus při working limitu (čekající entry) leadera nebo followera →
   odmítnuto.
4. Závod: leader submit dorazí souběžně s přepnutím → buď přepnutí
   odmítnuto, nebo follower konzistentně dostane/nedostane celou kopii;
   nikdy částečně.
5. Zapnutí → první kopie až u dalšího leader obchodu; `mode` se nemění
   (`on-fill` zůstane `on-fill`).
6. Restart workeru → vypnutý follower zůstane vypnutý (durable group.json).
7. Follower vyřazený automaticky (daily loss cut / breach) nejde ručně
   zapnout; UI dostane důvod.
8. Flatten na vypnutém followerovi funguje.
9. Leader otevře pozici, vypnutý follower zůstane flat → žádná divergence,
   žádný fail-closed (reconciliation očekává 0).
10. Vypnutý follower s nenulovou pozicí nebo working příkazem → viditelný
    safety problém (ne tiché ignorování).
11. Zastaralý `update-group` z UI nepřepíše `enabled`.
12. Přepnutí nikdy nezpůsobí DISARM kopírky.

## UI (Claude, až bude jádro)

- Přepínač na začátku řádku účtu (varianta A), leader bez přepínače.
- Během čekání na worker: jezdec v nové poloze + kolečko; potvrzení = pulz,
  odmítnutí = návrat + zatřesení + hláška s `toggleBlockedReason`.
- Zamčený stav se zámkem v jezdci, tooltip s důvodem.
- Vypnutý řádek zešedne (bez štítku); automatické vyřazení má vlastní štítek.
- Hlavička skupiny „Kopíruje 3/4"; připomínka ve potvrzení ARM, když je
  některý follower vypnutý.

## Mimo rozsah

Nasazení workeru až na samostatné „nasaď" uživatele, v DISARMED stavu,
ideálně mimo obchodní hodiny.

## Poznámka Codexu k bezpečnostní hraně (2026-09-26)

S absolutním zněním kritéria 12 („přepnutí nikdy nezpůsobí DISARM") nesouhlasím
pro případ, kdy selže zápis `group.json` **a současně** selže i pokus vrátit
původní konfiguraci. V takovém stavu nelze prokázat, zda durable konfigurace
odpovídá běžícímu controlleru; pokračovat ARMED by bylo horší než fail-closed.
Normální úspěšné i odmítnuté přepnutí ARM nemění a je kryté testy. Při nejistém
rollbacku runtime výjimečně odzbrojí a vyžaduje kontrolu.

`controller.followerParticipation.canToggle` je pouze rychlá nápověda pro UI.
Po pěti minutách bez úplného broker snapshotu ukáže starý snapshot jako
blocker; operátor může provést Kontrolu pozic. Samotný příkaz nikdy nevěří
tomuto příznaku: leadera a followera čte dvakrát z brokera a znovu hlídá
události při zápisu na disk. Bez omezení stáří by UI nabízelo přepnutí na
zjevně zastaralém stavu, ačkoliv worker by ho následně odmítl.
