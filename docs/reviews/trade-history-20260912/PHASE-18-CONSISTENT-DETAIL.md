# Fáze 18 — jedna verze výsledků v celém detailu

Lokální implementace v izolovaném worktree. Nic nebylo nasazeno ani měněno ve vzdálené databázi nebo workeru.

## Problém a řešení

Modal dosud obnovoval jen lazy média a ponechával ceny/P&L z listu. Graf si mezitím načítal novou finanční verzi samostatně. Nový journal detail načte přesně vybrané realizace společně, ověří úplnost a sestaví celý detail z jejich aktuálních faktů. Graf v tomto modalu dostává stejný ověřený objekt, takže neprovádí druhé nezávislé načtení. Samostatné použití grafu si ponechává vlastní ověřující čtení.

`readOwnedJournalDetails` načítá owner root řádky po nejvýše 100 ID, všechny jejich privátní finanční podklady/historii a poznámky. Generace projekce se ověřuje před root čtením i po úplném načtení poznámek; existující hydrator navíc hlídá generaci kolem finančních dávek. Session guard se zachytí před prvním získáním ownera. Chybějící/duplicitní/foreign/retired řádek, invalidace, změna účtu/skupiny a změna generace ukončí celé čtení chybou. Limit výběru je 1 000 realizací; 60sekundový cancellation signal doplňuje omezení jednotlivých dotazů. Nevrací se částečný součet.

Členství kombinované karty se odvozuje pouze z jejích explicitních filtrovaných ID. Všechny ceny, časy, množství a P&L se obnoví společně; kombinace se pak znovu sestaví z těchto členů. Aktuální lokální review text a štítky zůstávají, lazy média a kresby pocházejí z čerstvého čtení. Hlavní modal je při načítání nebo chybě skrytý a zobrazuje čekání/retry/zavření; již namontovaný editor zůstává uchovaný pod stavovou vrstvou.

V kombinovaném režimu levé údaje o plnění sledují účet vybraný v grafu, s výslovným popiskem účtu. P&L nahoře dál představuje celou vybranou skupinu. Screenshot záložka zůstává první, její údaje patří reprezentujícímu účtu. Schéma a způsoby ukládání se neměnily.

## Ověření

- 79 testů v osmi souborech: skutečná klientská hydratace 12 účtů, 101 ID v dávkách, generační změna během root čtení i poznámek, vlastník/cancellation, chybějící a neplatné členy, přesný filtrovaný součet, ochrana review a nové lazy obrázky/kresby; regrese původního storage a soukromého čtení prošly. Starší sourcemap warning ve sdílených dependencies zůstává.
- SQL harness s pěti skutečnými lokálními migracemi a novou detail službou ověřil 12 opravených výsledků, jejich vlastní historii a zachování souběžného review. Prošel i zbytek testu 2 400 epizod, input/staging continuation, RLS/owner, korekce a rollback. Pozdější úprava preference lazy médií byla ověřena cílenými klientskými testy; schéma zůstalo stejné.
- Scoped TypeScript a ESLint bez chyb (11 existujících warningů v kontrolovaných aplikačních souborech), samostatný lint verifieru/preview čistý. Vite/PWA build prošel, 89 precache entries.
- Browser: fiktivní novější verze změnila součet 354,24 → 402,24 USD, leadera 15,76 → 17,76 USD a exit 20117,5 → 20118,5. Účet 2 ukázal vlastní exit 20117,75, dva kontrakty a čisté P&L 31,52 USD v časové ose. Tři posuny SL v jedné minutě zachovaly časy 15:34:04,136 / 15:34:04,646 / 15:34:44,411. Vlastní vstup a výstup 15:30:12,196 / 15:42:30,955. Chybějící účet skryl finanční detail a retry zachovalo chybu, dokud výpadek trval.

## Hranice

Browser ověřil actual-component modal a časovou osu s fiktivními podklady. Skutečné svíčky této lokální stránky nejsou dostupné: existující market-data UI hlásí nenakonfigurovaný Databento zdroj. Žádný klíč ani služba se neměnily. Proběhl jeden removeChild error při živé výměně struktury komponenty; po čistém načtení se při výše uvedeném průchodu neopakoval. Test není ověřením přihlášeného produkčního PostgREST/Storage toku.

Zbývá obecný historický backfill/pokrytí, rozsah velkých broker seznamů a další dělení výpočtu, position box přes mezery, statistické R a nonpublic social projekce, následný raw-to-UI/authenticated E2E a závěrečný audit požadavků. Produkční práce vyžaduje samostatnou autorizaci, zálohu a vzdálené kontroly. Cíl zůstává aktivní.
