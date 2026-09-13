# Fáze 15 — trvalé zpracování nových zdrojových dávek

Lokální změny v izolovaném worktree. Původní nezměnitelná evidence se nemaže ani nepřepisuje. Žádná vzdálená migrace, deploy, instalace workeru ani obchodní akce.

## Chování

Vedle raw evidence vzniká obnovitelný pracovní vstup projekce: hlava s pevným cílovým kurzorem, sloučený stav jednotlivých entit a samostatně ponechané časové události. Jedna databázová dávka čte nejvýše 250 nových raw řádků. Server typicky provede nejvýše osm dávek nebo skončí po překročení pěti sekund mezi dávkami. To není tvrdý timeout jednotlivého SQL požadavku.

Potvrzení každé dávky atomicky uloží odvozené entity, ponechané události, kurzor a generaci. SQL znovu určí očekávanou zdrojovou dávku; požadavek nemůže přeskočit kurzor. Nesprávná poslední entita vrátí zpět celou transakci. Porovnání generace a předchozího kurzoru odmítne souběžně překonaný zápis. Původ aktualizačních metadat a orderedThrough se kontroluje proti autoritativním raw řádkům. Tabulky i RPC jsou service-only, tabulky mají RLS.

Cílová raw revize zůstane pevná během přípravy vstupu i čekání na dokončení finanční projekce. Průběžný příchod událostí proto nezpůsobuje nekonečné dohánění pohyblivého cíle. Další cíl se otevře až po publikaci předchozího výsledku. Kontrolní receipt finančního importu má verzi 2, aby starší receipt neobešel nový postup.

## Zachování časů a pozdních oprav

V plném pořadí zůstávají všechny position, fill, connection a positionsnapshot události a všechny řádky bez ID. Zachovají se tím flat kotvy, aktivita plnění během snapshotu, opakované snapshot řádky a mezery záznamu. Ostatní entity se slučují přes stejný `latestJournalEvidence` jako dosavadní projekce; vedle sloučeného stavu se uchovává poslední raw pozorování podle kanonického pořadí. Coverage metadata s ID slouží pro watermark, finanční projektor je nepoužívá.

Nově doručený řádek, který časově předchází již zpracovanému pozorování stejné entity, spustí načtení raw historie pouze této entity přes index a pouze do kurzoru právě potvrzované dávky. Opakování zachovává pravidlo broker timestampů včetně situace, kdy vložená událost zpětně způsobí odmítnutí dříve přijatého pozdějšího patche. Merged cache není vydávána za nový broker důkaz. Poslední receipt čas zůstává zachovaný i při odmítnutém zastaralém patchi nebo coverage události.

## Navázání na aplikaci

Dokud vstup není kompletní, API vrací samostatný stav processing bez publikovaných počtů. Synchronizace z takové odpovědi nenačítá dílčí finanční výsledek. Přihlášená viditelná aplikace pokračuje za dvě sekundy další žádostí; posluchače i časovač se uklidí při změně stavu/session. Skrytá stránka a offline stav nepřidávají další naplánovanou dávku. Chyba celého požadavku tento řetězec přeruší; obvyklá obnova a ruční retry zůstávají dostupné.

Stávající `JournalImportStatus` používá původní tokeny a komponenty aplikace a sdělí, že se historie zpracovává a zobrazené výsledky pocházejí z posledního dokončeného načtení. Náhled dostal pouze přepínač tohoto fiktivního stavu. Před úpravou byl přečten aktuální vykreslený canonical LIVE; výsledek byl ověřen ve skutečné status komponentě v preview. Screenshoty zůstaly výchozí záložkou.

## Ověření

- 88 testů / 11 souborů: porovnání raw a kompaktní projekce na 12 účtech, partial merge, pozdní vložení, poplatky, neznámé plnění a snapshot, watermark; trvalý resume, nesprávný ACK, CAS, chybné scope/entity/cursor, překonaná závěrečná prázdná stránka; synchronizace processing bez dílčího načtení, regrese účtů, epizod, API a LIVE historie.
- PGlite se skutečnými čtyřmi migracemi a skutečným serverovým importem: 2 400 obchodních epizod na 12 účtech, přerušení počátečního i opravného stagingu, zachování staré úplné historie, přesné pokračování, atomický rollback posledního člena, vlastní P&L a tři potvrzené SL pohyby během jedné minuty. Nové kontroly ověřily rollback input cache, odmítnutí přeskočeného kurzoru, CAS, vlastníka a zákaz přístupu authenticated. Oprava jednoho poplatku načetla právě jeden nový raw řádek. Pozdě doručené vložení načetlo jeden nový řádek a tři verze jediné dotčené fee entity; novější potvrzená hodnota zůstala zachovaná. Překonané snapshot čtení bylo odmítnuto.
- Scoped TypeScript, ESLint bez chyb (20 starších warningů v App), Vite/PWA build 3 483 modulů / 89 precache a diff check. Samostatný lint zahrnul i standardně ignorovaný preview a SQL harness.
- První SQL běh odhalil nejednoznačnou precedenci JSONB operátoru v nové funkci. Výraz je explicitně uzávorkovaný; konečný SQL průchod prošel.

Použity již ověřené aktuální podklady Supabase z fáze 14 (funkce, stránkování, explicitní grants). CLI vytvořilo nový verzovaný migrační soubor. Lokální ověření rolí není vzdálený advisory; vzdálené security/performance advisors patří k budoucímu schválenému nasazení se zálohou.

## Zbývající hranice

Příprava zdrojového vstupu je nově inkrementální a trvalá. **Samotný výpočet finančních epizod ještě znovu prochází celý kompaktní vstup.** Ten má limit 250 000 záznamů / 96 MB; replay jedné opožděné entity 100 000 raw událostí / 32 MB. Dlouhé historie s mnoha různými entitami nebo plněními se tedy stále musí dále dělit. Finální SQL skládá celou staged projekci a skutečné vzdálené timeouty nebyly ověřeny. Žádný z limitů nevrací zkrácenou historii jako dokončenou.

Dále zbývá obecný historický backfill a přehled pokrytí, velké seznamy broker API, automatické propojení screenshotů, geometrie position boxu přes mezery, nonpublic social projekce, raw-to-UI a přihlášený E2E a závěrečná přesnost zobrazení P&L/RR. Celý cíl zůstává aktivní; tato fáze neznamená produkční připravenost.
