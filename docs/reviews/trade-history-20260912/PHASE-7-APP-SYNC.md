# Fáze 7 — výměna App importu a stavy historie

Lokální stav 12. 9. 2026. Bez produkční migrace, nasazení, worker změn nebo broker příkazů.

## Hotové napojení

- `App.tsx` už nespouští `syncCopierJournal`. Odstraněna volba účtu podle současného leadera i původní pending banner. Historická identita se určuje pouze serverovým zpracováním evidence a skutečným OAuth přiřazením účtu.
- `syncJournalConnections` deduplikuje připojení ze seznamu OAuth a uložených vazeb účtů. Pro 12 účtů jednoho spojení odešle jeden import. Zohledňuje i odpojené historické spojení, pokud je stále dostupné pod vlastníkem. DEMO evidence je podporovaná; broker prostředí `live` se explicitně označuje jako nepodporované, nikoli zpracované. To není totéž jako karta LIVE, která používá prop DEMO účty.
- Spouštění po načtení účtů se známým Tradovate připojením, po návratu online/na viditelnou stránku a přibližně jednou za minutu. Jeden běžící požadavek, throttle i po chybě, reset/abort při změně identity. LIVE refresh je pouze impuls; aktuální skupina se k přiřazování nepoužívá.
- Import POST posílá výhradně connectionId, má deadline a lze jej bezpečně zopakovat. Neobsahuje broker execution. Server ACK rozlišuje stale, prázdnou evidenci, pending a dokončení; malformed odpověď není úspěch.
- Po importu se načítají potvrzené vlastní obchody včetně prázdného výsledku. Merge aktualizuje finance a členství, zachovává souběžně změněné poznámky a manuální obchody, neobnovuje místně smazaný záznam.
- Realtime události kopírky se nesmějí protlačit přes obecný raw parser. App je slučuje do owner read s kontrolou verze; neukazuje z raw payloadu starou cenu/P&L, nevyrábí falešný toast ani cache položku. Tato App větev je typecheck/build ověřená; skutečný přihlášený Realtime E2E stále chybí.

## Stav a původní historie

- `JournalImportStatus` je společný pro hlavní historii a LIVE. Hlásí čekající pozice/nepřiřazená plnění, chybějící evidenci, konflikt legacy identity, překročenou velikost historie a nedostupnost. Úspěch znamená zpracování uložených dat, nikoli tvrzení o aktuálním broker spojení.
- Pending důvod je uložen jako soukromý `pending_reason` v třetí lokální migraci. Archiv zobrazuje otevřenou pozici, chybějící vyúčtování, neúplnou pozici nebo konkrétní problém s přiřazením. Potvrzením se důvod vymaže. Invalidated status má vlastní přednostní popisek.
- **Upřesnění oproti fázi 6:** všechny nepřevzaté legacy záznamy `source=copier` se považují za neověřené, včetně leadera s `pnlEstimated=false`. Jeho P&L sice může pocházet z ledgeru, ale původní přiřazení účtu používalo současného leadera. Bez historického důkazu tedy nepatří do potvrzených account statistik. Zůstává dostupný v archivu jako „Čeká na ověření původu“. Převzaté UUID s `journal:` používá soukromá potvrzená fakta. Server view, hlavní čtečky i cache tuto hranici sdílejí.
- Archive query vylučuje již převzaté záznamy na serveru, aby neprodukovala mnoho prázdných stránek. Owner scope, keyset a malá projekce sloupců zůstávají zachované.
- Náhled ukazuje 12 fiktivních pending pozic 11. 9., uzavřenou ukázku 10. 9. a starší archiv 9. 9. Statusy nesmí při filtrování měnit význam podle pořadí. Nepřiřazená pozice má null journal účet a vlastní externí ID.

## Ověření

- 58 testů / 8 souborů prošlo (nový sync, vlastní finance, archive, hydratace, API trust boundary, owner reads, dashboard fallback, skupiny).
- Izolované tři SQL migrace se skutečným server importem a 12 účty prošly; ověřeno navíc uložení `accounting-pending` a jeho odstranění po příchodu poplatků. Zachování legacy UUID/review, konflikty, RLS, invalidace a tombstone zůstaly zelené.
- Scoped TypeScript prošel. Scoped ESLint nemá chyby; App/TradeHistory mají existující warningy. Vite/PWA build: 3 476 modulů, 87 precache, úspěch; známý velký chunk a TypeScript sourcemap warning.
- Browser zobrazuje skutečný status komponent a konkrétní pending důvody. Backend běží jen v izolovaných testech; fiktivní loadery náhledu nejsou důkaz přihlášeného App E2E.

## Zbývající práce a nejbližší kroky

1. Pasivní sběr dosud nepřihlašuje všechny analytické entity (`orderVersion`, `fillFee`, `fillPair`, `cashBalanceLog`) v user/syncrequest; zaznamená je pouze tehdy, když dorazí. Ověřit oficiální protokol a doplnit oddělenou úplnou capture cestu bez zhoršení execution/reconnectu.
2. Pro dosud neviděné instrumenty chybí explicitní důkaz úplného počátečního flat snapshotu. Historický import nesmí odvozovat minulou flat pozici z dnešního prázdného seznamu.
3. Skutečná obchodní karta v LIVE stále není napojená: `TradovateLiveDesk` používá `LiveCopyTradeOverview`; App mu zatím předává jen scheduling callback a nad LIVE zobrazuje stav importu. Sdílený detail a přehled vlastních účtů je nutné doplnit bez změn execution ovládání.
4. Dlouhá historie pořád používá celý omezený snímek (100k events/32MB/2000positions). Nutné inkrementální zpracování/partitioning před skutečnou dlouhou historií. Staré účty bez zachované evidence zatím zůstanou v archivu, dokud nedorazí doložitelný backfill.
5. Novým Trade z evidence doplnit přesné propojení existujících screenshotů z ledgeru; nyní se zachovají při adopci legacy review, ale novému záznamu bez staré review se automatické screenshoty ještě nepřipojí.
6. Opravit position box přes chybějící svíčky/trading breaks. Detail chart lazy load musí explicitně ukázat nedostupnost, pokud owner getTradeById vrátí null/error; dosavadní chart větev umí spadnout na dřívější základní data bez historie. Má též z načteného detailu přebrat současná finanční fakta, nejen executionHistory.
7. Raw-to-UI fixture, přihlášený E2E, neveřejná sociální projekce a samostatně schválené produkční doručení stále zbývají. Neoznačovat celou funkci za hotovou.
