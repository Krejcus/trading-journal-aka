# Fáze 12 — hodnocení bez přepsání brokerových faktů

Lokální změny v izolovaném worktree 12. 9. 2026. Žádný deploy, vzdálená migrace, worker ani broker akce.

## Implementace

- `journalReviewPatch` definuje povolené údaje hodnocení: poznámky, vlastní obrázky/kresby, konfluence, emoce, chyby, setup/tagy, označení podle plánu, vědomý BE štítek a prezentační nastavení. Skutečně provedený obchod nelze změnit na Missed. Ceny, objem, P&L, časy, SL/TP, vazba účtu/skupiny ani zdroj/private history do review patche nevstupují.
- `changedTradeFields` filtruje journal patch před změnou React stavu; tím pokrývá jednotlivou i bulk optimistickou editaci. `combinedTradeChanges` pro brokerové členy vůbec nespouští škálování ekonomiky. Platí jen vybraní členové skupiny a každý zachovává svůj výsledek. Ruční obchody si ponechávají vlastní editační chování.
- `storageService.updateTrade` znovu kontroluje povolená pole podle právě načtené uložené identity, nikoli podle předloženého source. Čistě nepovolený patch nezapisuje; neprojde ani přejmenování zdroje na manual. Cache se aktualizuje pouze povoleným patchem po potvrzení zápisu a kontroluje se změna vlastníka při čtení. Privátní executionHistory se při serializaci odstraní. Bulk `saveTrades` odmítá journal řádky z payloadu i ze známého uloženého blobu a odkazuje na cestu hodnocení.
- V dosud nenasazené migraci `20260912122352_journal_position_persistence.sql` je rozšířen stávající ochranný trigger. Authenticated/anon UPDATE nad journal řádkem zachová brokerové root sloupce, původní identitu a data mimo explicitní review allowlist. To pokryje i starší browser s celým stale snapshotem. Service-role import nadále může opravovat faktické údaje. Jde o změnu místního návrhu migrace; není aplikována na vzdálenou DB.
- App save callback nyní vrací potvrzený výsledek dokončených zápisů. Formulář/průvodce se po neúspěšném členovi skupiny nesmí automaticky zavřít jako úspěšný; úspěšní členové zůstanou uložení a neúspěšní mají vlastní rollback. Nejde o novou atomickou transakci pro celou skupinu.
- `ManualTradeForm` pro journal zobrazí režim Hodnocení obchodu se skutečným uloženým net P&L. Neobsahuje vstupy pro ekonomiku/datum/instrument a nabídne jen hodnocení a obrázky. Nepočítá při review P&L z cen ani z obecných tarifů poplatků; nevyžaduje nové datum nebo SL a neprovádí víkendovou validaci. Vlastní patch porovnává s původním stavem formuláře, takže nepřepíše nezměněné poznámky/obrázky kvůli vedlejší změně. Smazání všech vlastních obrázků je výslovná prázdná kolekce.
- Save má pending stav, čeká na nahrání obrázku i potvrzení zápisu; při chybě zůstává otevřený s rozepsaným textem. Formát a komponenty vycházejí z aktuálního kanonického formuláře; hlavní appka a lokální render byly zkontrolované.
- Ve skutečném `TradeDetailModal` jsou journal STOP/TARGET pouze ke čtení. První otevření review čeká na úspěšné načtení detailu a má retry; již otevřený editor zůstává namontovaný při optimistické změně téhož obchodu. Loader lze v lokálním fixture nahradit, defaultem zůstává owner storage read.
- Browser odhalil dosud ponechaný efekt, který po načtení obchodu bez obrázků přepínal na graf. Je odstraněn. Screenshoty nyní skutečně zůstávají výchozí i při prázdné galerii; graf otevírá uživatel.

## Ověření

- 26 testů / 6 souborů: journalReviewPatch, skutečná izolovaná metoda storage update, combinedTradePatch, tradePatch, journalTradeFacts a journalImportSync. Prověřují 12 vlastních výsledků, celý nebezpečný editor payload, immutable identity/časy/P&L, povolenou poznámku, rollback při pozdějším brokerovém přepočtu, účet změněný během čtení a nepotvrzený zápis bez cache aktualizace.
- Skutečný izolovaný PGlite/server/owner-read harness prošel s rozšířeným triggerem: pokus authenticated UPDATE přepsat P&L, instrument, čas, směr, entry/SL a source ponechal původní fakta, uložil poznámku a odmítl injektované neznámé pole. Dále prošly dosavadní exact legacy adopce, RLS, opravy, revize, rollback a tombstone.
- Scoped TypeScript, ESLint (0 chyb; starší warningy a ignorovaný mockup), Vite/PWA build (3 482 modulů / 89 precache) a diff check prošly. Dále aplikována React kontrola hranic Suspense, stabilního loaderu, hooků a čekání na save.
- Native browser: existující kanonická light appka jako reference; skutečný formulář s $15.76 a $1.24 fees; chyba uloženého mock callbacku zachovala text; skutečný detail → Hodnocení → save změnil text a Valid/Invalid bez změny entry/exit/P&L. Screenshoty po zavření/novém otevření zůstaly zvolené i bez obrázku. Všechny tyto operace byly ve fiktivním preview.
- Preview nově nabízí tlačítko Detail aplikace a používá skutečný `TradeDetailModal` i `ManualTradeForm`. Je stále ručně sestaveným fixture, nikoli autentizovaným raw-broker→DB→App E2E.

[Supabase dokumentace triggerů](https://supabase.com/docs/guides/database/postgres/triggers) popisuje použité BEFORE UPDATE/OLD/NEW chování. Vzdálené advisors se nespouštěly, protože vzdálené schéma nebylo měněno a místní PGlite není Supabase cluster. Před produkční migrací zůstává samostatný backup a advisors gate.

## Otevřené body

Zbývá obecný backfill a přehled dostupnosti zdrojů, velké API seznamy/partitioned server import, automatické screenshot linkage nových journal řádků, position-box mezery, nonpublic social projekce, raw-to-UI a přihlášený E2E. Nové review guardy nejsou důkazem těchto bodů. Databázová ochrana je ověřena na lokálním SQL harnessu; celý přihlášený App save tok a skutečný upload screenshotu nebyly provedeny. Celý cíl proto zůstává aktivní.
