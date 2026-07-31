# AlphaTrade Coach Data Architecture

## Cíl

AI Coach v aplikaci a externí ChatGPT přes MCP musí mít stejnou schopnost
dohledat všechna uživatelská data, stejnou paměť a stejné deterministické
výpočty. „100% přístup“ znamená, že každý kanonický záznam lze načíst na
vyžádání a doložit; ne že se celá databáze vloží do každého promptu.

Spustitelná coverage mapa a akceptační scénáře jsou v
`services/coachDataCoverage.ts`. Při každém dokončeném kroku se úroveň domény
smí změnit na `full` až poté, co existuje read path na kanonický zdroj a eval,
který ji prokazuje na obou surfaces.

## Neměnné principy

1. Raw databázové záznamy zůstávají zdrojem pravdy; paměť není náhradní databáze.
2. App Coach a MCP používají společnou doménovou/analytickou vrstvu.
3. Číselné odpovědi a klasifikace kopií provádí deterministický kód, ne model.
4. Každé tvrzení o události, patternu nebo datu nese evidence reference.
5. Behaviorální pattern je hypotéza, dokud nemá vzorek, confidence a protidůkazy.
6. Live a backtest se nesmí nechtěně smíchat.
7. Incidentní P&L ovlivňuje reálné peníze, ale ne WR, RR, PF ani počet obchodů.
8. Zmenšení 90denního promptu je povolené až po zeleném eval scénáři
   `recurrence-over-90-days`.

## Cílový retrieval tok

1. Na začátku zprávy načíst malý snapshot: profil, aktivní závazky, data freshness,
   aktuální účetní riziko a poslední významnou epizodu.
2. Planner z dotazu určí potřebné domény a časový/account scope.
3. Strukturovaná čísla získá přes query/analytics nástroj.
4. Textovou historii hledá hybridně (keyword + semantic + metadata + čas).
5. Detail otevře až pro malé množství konkrétních obchodů/dnů/incidentů.
6. Před odpovědí verifier zkontroluje pokrytí zdrojů, scope a evidence reference.
7. Pokud data chybí, Coach abstainuje a přesně řekne, co chybí.

## Implementační pořadí

1. Coverage mapa a eval baseline.
2. Jednotná Coach Data Layer a shodné nástroje pro app + MCP.
3. Raw exekuce, order type a detail incidentů.
4. Hybridní retrieval přes celou historii; zachovat 90denní prompt do ověření.
5. Evidence-aware Memory V2 (verze, confidence, source refs, supersedes/expiry).
6. Mentor loop: hypotéza → experiment → follow-up → potvrzení/vyvrácení.
7. Screenshot/vision a později video metadata.

## Aktuálně implementováno lokálně

- App i MCP používají stejný deterministický incident analyzer pro raw Tradecopia
  exekuce/order evidence; copy fan-out se nepočítá jako více rozhodnutí.
- Market/Limit/Stop je tvrzení jen při `high`/`medium` confidence vazby objednávky.
- Paměť nese `confidence`, evidence i counter-evidence refs, stav
  `hypothesis|supported|contested|user_stated` a vazbu `supersedes`; oprava
  poznatku zachová audit trail místo fyzického smazání. Re-extrakce je
  rollback-safe a nové konverzace automaticky validují nebo zpochybňují starší
  hypotézy; opakovaný behaviorální pattern je `supported` až od 3 nezávislých refs.
- Retrieval planner vynucuje celohistorické hledání pro recurrence dotazy a raw
  incident tool pro otázky na anatomii nevalidní ztráty. U obecného drill-down
  nástroje ověřuje i konkrétní doménu, ne pouze název nástroje.
- MCP core už nemá tiché stropy 5 000 obchodů / 150 deníků. Kanonické kolekce
  načítá po databázových dávkách a `get_coach_records` vrací jednotné
  `has_more` + `next_offset`; app i MCP tak mohou projít celou historii bez
  vložení celé databáze do jednoho promptu.
- Akceptační scénáře jsou napojené na deterministický retrieval eval. Test padá,
  pokud otázka na závazek, incident, kopie, weekday vzorek, live/backtest nebo
  experiment nevynutí správnou datovou doménu a canonical tool call.
- Coach může navrhnout skutečný `lab_experiment`; po potvrzení uživatelem se
  uloží do kanonické tabulky a app i MCP deterministicky sledují before/after.
  Výsledek vždy uvádí kvalitu vzorku a omezení; pozorovaný rozdíl se nevydává za
  kauzalitu. Hotové experimenty se v appce samy připomenou k vyhodnocení.

Doména médií je pokrytá ve dvou krocích: `get_coach_records(domain=trade_media)`
vrátí přesný zdroj, ID a počet obrázků a `get_coach_media` předá vybraný screenshot
obchodu, přípravy, debriefu nebo payoutu jako skutečný image content block.
Retrieval verifier vyžaduje druhý krok vždy, když má model vizuální obsah popsat
nebo interpretovat; pouhá metadata k takovému tvrzení nestačí.
Obrázek je omezený na 8 MB binárně a `chat` proxy dovolí 16 MB pro celý request,
aby se do limitu vešel base64 obraz spolu se systémovým kontextem a historií.

Tyto změny jsou zatím lokální. Produkční MCP se nesmí nasadit před dokončením
logického DB exportu a ověřením rollbacku.

## Produkční bezpečnost

Před první změnou Supabase schématu, RLS, Storage nebo nasazené Edge Function:

1. vytvořit samostatný vzdálený DB export,
2. stáhnout a zahashovat dotčené nasazené Edge Functions,
3. zapsat přesný rollback postup,
4. až potom vytvořit verzovanou migraci / nasadit funkci,
5. po změně spustit security a performance advisory.
