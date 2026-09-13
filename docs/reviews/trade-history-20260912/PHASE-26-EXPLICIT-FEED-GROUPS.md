# Fáze 26 — skutečné skupiny ve sdíleném feedu

Lokální pracovní kopie `/private/tmp/alphatrade-history-20260912`, základ `e61ab59a`.

## Výsledek

Feed už neslučuje obchody podle instrumentu, směru a stejného dne. Používá explicitní historické groupId, vlastníka, instrument/směr a jednotku výsledku. Ruční obchody bez vazby zůstávají jednotlivě. Počet vychází z unikátních povolených accountId, nikoli z počtu řádků nebo dnešní konfigurace kopírky. Opakovaná totožná ID nezvyšují počet.

První stránka 20 posledních řádků určí nedávné skupiny. Každá nalezená skupina se načte samostatně včetně exact count, s filtrem vlastníka a povolených účtů; zpracovávají se nejvýše čtyři požadavky současně. Pokud limit odpovědi usekne členy, chybí count, nastane chyba nebo odpověď obsahuje jiné ID vlastníka/skupiny či duplicity, celá odpověď selže. Limit této cesty je 1 000 členů na skupinu; větší skupina vyvolá chybu, nikdy menší potvrzený počet. Smazaná/neplatná skupina nenahrazuje novou prázdnou odpověď starými řádky z první stránky.

Karta ukazuje součet výsledků zahrnutých členů. Neznámý výsledek kteréhokoli člena znamená neznámý součet. Členské ceny/P&L/časy se součtem nepřepisují. Rozkliknutí otevře existující NetworkHub detail s kompaktním výběrem účtu. Názvy účtů jsou načtené z aplikace; pokud chybí, zobrazí se přesné accountId. Výběr uvádí vlastní P&L a čas výstupu, detail vlastní vstup/výstup na milisekundy. Jeden účet může být ve ztrátě, i když je součet skupiny ziskový.

Na konci načítání se znovu ověří přihlášený uživatel a stejná oprávnění spojení. Změna účtu/connection seznamu ruší staré požadavky a vyčistí otevřený sdílený detail. Chybový stav vymaže starý feed a nabídne opakované načtení, nezamění neúplná data za prázdnou historii. Toto je obrana klienta; nenahrazuje zbývající serverové vynucení oprávnění.

## Ověření

- Kompletní regrese: 373 souborů / 3 445 testů prošlo. TypeScript, Vite/PWA build (90 precache položek), scoped lint (0 chyb, 15 starších varování) a git diff --check prošly. Logy `/private/tmp/journal-phase26-{tests,full-tests,types,lint,build}.log`.
- 32 cílených testů ve čtyřech souborech: explicitní identita, neslučování ručních/odlišných obchodů, 12 členů, skutečný součet, vlastní ceny/časy, neznámé výsledky, počet unikátních účtů, kompletní odpověď a její limity, odvolání oprávnění, session změna a SSR skutečného selectoru.
- Tři testy načítají přímo skutečnou metodu getNetworkActivity z aktuálního storageService a ověřují dva recent řádky → 12 úplných členů, account filtr a odvolání spojení. Transport je simulovaný, nejde o hosted PostgREST/JWT.
- Browser skutečného NetworkHubu s fiktivním adaptérem a CSS sestavené aplikace: jedna karta 12 účtů / +11,76 USD; detail účet 1 −4,52 USD; přepnutí na účet 11 +5,48 USD, entry 20010 v 17:00:00,270 a exit 20015 v 17:01:00,430. Skupinový součet zůstal beze změny. Screenshot potvrdil původní styl aplikace.
- Browser neúplné odpovědi: karta/součet nejsou zobrazené, viditelná zpráva a tlačítko Zkusit znovu. Dočasný tab 4190 uzavřen, server ukončen; hlavní náhled 4189 zachován.
- Dokumentace použitá pro exact count/row limits: https://supabase.com/docs/reference/javascript/select

## Hranice

Účty se počítají v právě načteném potvrzeném a sdíleném rozsahu. Pending/nepotvrzené či nesdílené účty se nevydávají za potvrzené kopie. Celý feed není jeden databázový snapshot přes všechny různé skupiny; úplnost členů je ověřena pro každou odpověď skupiny. Nejde o tvrzení, že import všech broker zdrojů je dokončený.

Oprava heuristického feed seskupování uvedená ve fázi 25 je dokončená. Zůstává serverově vynucený sdílený DTO/přístup, spectator čtení, ověření velké projekce, přihlášený raw-to-UI tok a broker conformance. Předchozí široká root RLS se touto fází nemění; nové SQL ani grants nejsou přidané. Žádný commit/push/deploy, vzdálená migrace, restart/reinstalace workeru ani broker akce. Celkový cíl není hotový.
