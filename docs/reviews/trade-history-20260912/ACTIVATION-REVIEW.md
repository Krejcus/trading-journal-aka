# Historie účtů — kontrola před aktivací

Tento dokument popisuje připravenou lokální změnu. **Není souhlasem k nasazení.** Práce je v izolované větvi `codex/history-evidence-20260913`. Základ pro doručení je aktuálně načtený `origin/main` 110aa0db. Rozpracované soubory canonical checkoutu nejsou součástí sloučení.

## Požadavek → důkaz → zbývající ověření

| Požadavek | Aktuální lokální důkaz | Co lokální důkaz neprokazuje |
|---|---|---|
| Kombinované a individuální zobrazení pro 10+ účtů | Skutečný náhled 12 účtů, `tradeHistoryPresentation`, `LiveJournalHistory`, testy skupin a vlastních časů; individuální account ID a historické linky, ne aktuální nastavení skupiny | Konkrétní skutečné účty po aktivaci sběru |
| Vlastní plnění, P&L a poplatky každého účtu | Raw → projekce → skutečné lokální SQL → owner hydratace; 2 400 epizod/12 účtů. Samostatný kapacitní výpočet 24 000 epizod | Broker data nemají být prohlášena za úplná, pokud chybí poplatky, původ nebo počáteční stav |
| Uložené posuny SL/TP a několik změn během minuty | Immutable evidence, čas požadavku/potvrzení/přijetí, pořadí a mezery; příklady 15:34:04.125, .635 a :44.400 v grafu, lokální SQL i observer testy | Budoucí skutečný broker stream a dostupnost historických endpointů v konkrétním připojení |
| Bez domýšlení chybějících dat | Rozlišené pending/rejected/confirmed, chybějící počáteční risk/R a poplatky, explicitní mezery; původní odhady v odděleném archivu | Chybějící staré posuny nelze zpětně vyrobit; žádná migrace je nedoplní odhadem |
| Graf stejného původu jako backtesting | Existující CandleKit/position box a tokeny aplikace; Screenshoty výchozí, Graf s plněními, schody ochrany a přesnými událostmi; ověřené mezery a zoom | Fiktivní svíčky nejsou důkaz market-data připojení |
| Pravdivé počty kopií a detail vybraných účtů | Explicitní skupiny, kompletní členové, vlastní per-account hodnoty, filtry a čerstvý detail; samostatná sociální RPC projekce | Staré syntetické kopie bez evidence se nestávají skutečným plněním |
| Dlouhá historie a pokračování | Trvalé dávky vstupu a výstupu, poslední úplná generace během zpracování, 24 000 pozic lokálně; limity uvedené ve fázi 29 | Neomezená historie, libovolně velká jedna pozice ani vzdálené časové limity nejsou ověřené |
| Bez rozbití aktuálního LIVE | Izolované sloučení main 110aa0db; společný odběr cashBalance + journal entit jedním socketem a zachování resync obou pozorovatelů | Instalovaný worker zatím tento kód nepoužívá |

## Přesný balíček

- Seznam souborů proti `110aa0db` je v `ACTIVATION-FILES.txt`; artefakt patch/status je uložen mimo pracovní kopii v uživatelském výstupu této úlohy. Zdrojové soubory jsou také v lokálním gitu. Seznam zahrnuje aplikační/worker kód, testy, verifikátory a dokumentaci; z něj se nemají instalovat testy do runtime ani spouštět verifikátory proti produkci.
- Osm nových migrací, v tomto pořadí:
  1. `20260912100450_tradovate_journal_evidence.sql`
  2. `20260912115949_journal_trade_projection.sql`
  3. `20260912122352_journal_position_persistence.sql`
  4. `20260912162137_journal_incremental_input.sql`
  5. `20260912164531_journal_snapshot_links.sql`
  6. `20260912174837_journal_source_status.sql`
  7. `20260912190422_journal_confirmed_root_projection.sql`
  8. `20260912193935_journal_shared_read_boundary.sql`
- Upravené Supabase Edge Functions: `daily-start-brief`, `loss-day-debrief`, `morning-affirmation`, `morning-brief`, `proactive-greeting`, `weekly-report`. Přepnutí jejich čtení na potvrzené výsledky patří do stejného aktivačního balíčku.
- Cíl databáze: existující Alpha trade, ref `kopinlpdvjfgmvxydohk`. Cíl aplikace: `https://alphatrade-mentor-15.vercel.app`. Povoleno je zatím připravení; vzdálené změny nebyly provedeny.
- Worker: nový bundle ze stejné izolované větve, se stávajícím párováním a schváleným upload originem. Žádné nové credentials, přepárování ani změny risk/copy nastavení v tomto balíčku nejsou zamýšlené.

## Navržený postup vyžadující schválení

1. **Samostatná záloha před každou vzdálenou změnou.** Ověřit dostupnost obnovy projektu Supabase a vytvořit export schématu, RLS, funkcí, migrační historie a dotčených dat; uložit mimo git pod `Documents/AlphaTrade-backups/<datum>`, s omezenými přístupovými právy. Záloha databáze sama neobsahuje objekty Storage: ověřit také dostupnost screenshotů a jejich metadat. Zaznamenat produkční commit/deployment a zálohovat současný worker bundle/LaunchAgent konfiguraci lokálně. Nezaměňovat nový lokální patch za zálohu vzdálených dat. Jestli nelze použitelnou zálohu ověřit, nepokračovat.
2. Znovu ověřit, že main neposkočil, a podle případného rozdílu aktualizovat izolovanou větev a kontrolu. Před worker změnou ověřit jeho aktuální připojení, **DISARMED**, skutečné pozice a pracovní příkazy. Při otevřené expozici nebo neověřeném stavu se worker neinstaluje/restartuje a nic se automaticky nezavírá.
3. V dohodnutém okně aplikovat vyjmenované migrace, nasadit odpovídající server/klient a uvedené Edge Functions. Osmá migrace a nový klient jsou svázané: starý klient po omezení raw SELECT neuvidí nové cizí journal řádky; nový klient bez RPC zobrazí chybu. Ověřit skutečné security/performance advisory po změně, funkce/RLS a HTTP zdraví.
4. Přihlášeně ověřit vlastníka, povoleného diváka a odebrání souhlasu; bez sdílení evidence nebo soukromých poznámek mimo jejich souhlas. Potom nainstalovat nový worker pouze při potvrzeném bezpečném stavu. Ověřit nový hash, zdraví, párování a že zůstává DISARMED.
5. Na Tradovate **DEMO** ověřit skutečný read-only sběr → lokální trvalý záznam → upload ACK → databáze → import → historie/graf pro konkrétní účty. Tato verze nepovoluje broker prostředí LIVE. Žádné testovací obchody ani ARM/Flatten nejsou zahrnuté v souhlasu s instalací. Pokud je pro ověření nového posunu potřebný obchod, provede jej uživatel při samostatně dohodnutém testu; agent si jej nesmí vyrobit pro splnění kontroly.
6. Porovnat přesné broker fill/order/version IDs, ceny, vlastní časy a poplatky. Počty kopií ověřit podle skutečných účastníků, nikoli aktuální konfigurace. Při chybě zachovat poslední úplnou historii, uvést neúplnost a zastavit další aktivaci. Označit hotovo teprve po doloženém toku, ne po samotném zeleném deployi.

## Dopad a návrat

Import může přesně přiřadit dřívější journal UUID k doloženému plnění, opravit finanční údaje a vyřadit staré syntetické/neudržitelné výsledky z potvrzených statistik. Zachování poznámek/review má lokální testy, přesto je před reálným importem nutná záloha. Nejde jen o výměnu barev UI.

Při selhání zastavit další import/sběr bezpečným postupem a vrátit ověřený předchozí app/worker balíček, bez automatického ARM. Návrat aplikace sám nevrací již změněná data/RLS; obnovu konkrétních dat a pravidel provést až po vyhodnocení nově příchozích událostí a schválení obnovy. Nedělat automatický destruktivní down nebo DROP journal tabulek. Surovou evidence zachovat.

Pravidlo v kořenovém `AGENTS.md`: „Před změnou Supabase schématu, RLS, Storage, Edge Functions, Vercel environment variables nebo jiné produkční konfigurace uživatele výslovně upozorni a nejdřív navrhni samostatnou zálohu/export vzdáleného systému.“ Dále: „Push na main nedělej bez výslovného souhlasu uživatele.“ Tento aktivační plán proto čeká na výslovné schválení; dosavadní souhlas s implementací se nevydává za souhlas se vzdálenou migrací/restartem.
