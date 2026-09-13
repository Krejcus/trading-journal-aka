# Fáze 28 — sdílená historie a žebříček

Lokálně ověřeno 13. 9. 2026 v `/private/tmp/alphatrade-history-20260912`, základ `e61ab59a`.

## Výsledek

Spectator historie a žebříček nyní čtou obchodní řádky přes `read_shared_trades_v1`, stejně jako feed. Žádná z těchto dvou cest nepadá zpět na raw `trades`/`confirmed_journal_trades`. Individuální identita účtu, čas a vlastní výsledek zůstávají beze změny.

Historie čte stránky po 250 záznamech až do potvrzené prázdné stránky. Kontroluje zbývající počet, monotónní identitu, stejnou jednotku, session a konečný stav oprávnění; pozdější chyba nevrátí částečný úspěch. Horní mez je 100 000 záznamů. Kontrola počtu není globální transakční snapshot napříč stránkami a nemá detekovat všechny souběžné změny se stejným počtem. Server potvrzuje jednotlivé řádky; atomický snapshot vybraného vlastního obchodu zůstává samostatný dříve zavedený mechanismus.

Žebříček používá nejvýše 100 nejnovějších povolených řádků každého vlastníka, po nejvýše čtyřech vlastnících souběžně. Ověří celý očekávaný vzorek; neznámý výsledek nevyrobí úspěšnost ani pořadí. UI tuto velikost vzorku výslovně uvádí. Review skóre se načítá pouze při souhlasu a jen jako `user_id,rating:data->rating`; starší společný limit 200 review záznamů se v této fázi nemění.

SQL null se v přechodném kompatibilním `Trade` modelu mění na NaN, nikoli na nulu; nejde o persistovaný datový formát. Sdílené součty, procenta, PF, barvy, kalendář i křivka kontrolují konečnost/úplnost hodnot. Skrytý kalendář nezobrazuje ani dolarové nuly za prázdné týdny. Známé BE zůstává nula. NaN se nemá zapisovat zpět do úložiště. R přichází v jednotce potvrzené serverem, nepřepočítává se znovu.

Požadavky UI mají čítače pro zahození opožděných výsledků po zavření profilu, změně spojení nebo odmountování. Chyba žebříčku odstraní staré statistiky a nabízí opakování; správně načtený seznam sledovaných zůstává dostupný.

## Ověření

- Celá regrese: 376 souborů / 3 462 testů prošlo. Po doplnění prázdných skrytých období znovu 37 cílených testů v šesti souborech (včetně jednoho nového testu).
- Skutečné storage metody s mock RPC: 612 exekucí přes 12 účtů, přesné časy, stránkování, neznámé R, pozdější chyba, odebrání souhlasu, bez raw fallbacku, oddělené consented ratings a neúplný vzorek žebříčku.
- SSR skutečného kalendáře: neznámý den neobarví ztrátu ani nepoškodí barvu známého sousedního dne; hidden prázdné období nemá `$0`, NaN ani Infinity.
- Konečný TypeScript, Vite/PWA build (90 precache položek), `git diff --check`: bez chyb. Scoped ESLint: 0 chyb / 59 varování, zahrnuje stávající velké komponenty.
- Browser: skutečný NetworkHub + dočasný fiktivní adaptér na portu 4190. Neznámý trader bez ranku/win rate; 12 účtů v selectoru; účet 1 −4,52 USD → účet 11 +5,48 USD; hidden den/týden/měsíc/statistiky bez dolarových nul; prázdná equity s vysvětlením; chyba žebříčku/retry bez starých výsledků a stále dostupný sledovaný profil. Styly sestavené z aplikace. Testovací tab zavřen a server zastaven.
- Browser log obsahoval záměrně vyvolané `shared-trades-unavailable` a varování o opakovaném createRoot při HMR dočasného fixture; nejde o čistý produkční E2E/JWT důkaz.
- Logy `/private/tmp/journal-phase28-{tests,full-tests,types,lint,build}.log`. SQL se v této fázi neměnilo ani znovu nespouštělo; jeho aktuální lokální důkaz je fáze 27.

## Zbývá

Klientské přepojení spectator/žebříčku potřebné před osmou migrací je hotové lokálně. Vzdálený RPC a odpovídající klient se musí aktivovat společně. Bez RPC nový klient hlásí chybu.

Zůstává kontrola velkých projekcí, přihlášený sběr → import → UI, broker conformance a schválená aktivace. Tato fáze nepřepisuje obecné starší sociální RLS účtů, příprav, review a ručních obchodů; nejde o globální privacy audit. Nebyl deploy, vzdálená migrace, restart/reinstalace workeru ani broker akce.
