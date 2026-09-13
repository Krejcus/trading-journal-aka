# Historie účtů a SL/TP — místní rozpracovaná druhá fáze

Stav k 12. září 2026. Izolovaný worktree `/private/tmp/alphatrade-history-20260912`, základ e61ab59a. Tento dokument navazuje na PHASE-1.md; nejde o dokončené nasazení ani potvrzení kompletního sběru u brokera.

Navazující čtecí vrstva a nové lokální SQL/IndexedDB ověření jsou popsané v PHASE-3-READ-MODEL.md. Celý import a obě karty stále nejsou dokončené.

## Co lze nyní ověřit

- Samostatná fiktivní ukázka na http://127.0.0.1:4189/mockups/journal-preview/index.html používá skutečný CandleKitTradeChart, styly aplikace a TradeExecutionTimeline. Původní schválená HTML ukázka na portu 4178 zůstala zachována.
- Dvanáct účtů má vlastní vstup/výstup, množství, poplatky a P&L. Screenshoty jsou první. Kombinovaný součet je 354,24 USD; účet 11 má individuálně 31,52 USD a odmítnutou poslední změnu SL.
- Minuta 15:34 obsahuje u účtu 11 potvrzení v 15:34:04,235 a 15:34:04,745 a odmítnutí v 15:34:44,510. Odmítnutí se nestává aktivní cenou. Účet 9 má viditelný výpadek záznamu. Nevyplněný účet 13 není započítaný.
- Graf kreslí potvrzené schody SL/TP a vlastní plnění. Lightweight Charts 5.2 vrací pro necelý logický index nulu; čas uvnitř svíčky se proto převádí interpolací mezi dvěma celočíselnými souřadnicemi. Žádná intraminutová tržní cena se neodvozuje z OHLC.
- Detail skutečné aplikace umí volit účet a při více řádcích téhož účtu také realizaci. Detailní executionHistory načítá až po otevření grafu a jen pro přesné ID a účet.

## Připravený lokální základ

- Pasivní observer adaptéru ukládá pouze povolená skalární pole. Přijímá událost ještě před zjednodušením na poslední verzi. Samotný odběr journalu neotevírá ani neudržuje broker socket.
- Lokální JSONL recorder: session/sequence, stabilní ID, soubor 0600, fronta s limitem, stav degradace, oddělený potvrzený kurzor pro budoucí dávkový přenos. Nejistý částečný zápis zastaví další appendy; nepoškozuje obchodní exekuci.
- Historické vazby kopírky používají vlastníka konkrétního pozorovaného příkazu. Nepoužívají dnešního leadera. Uložení vazby běží až po úspěšném runtime commitu a nečeká na disk v exekuční cestě.
- Čistá projekce páruje verze s příkazem a potvrzením/rejektem, odděluje broker čas od času přijetí, eviduje výpadky a rozlišuje neznámé poplatky od nuly.
- FillPair projekce počítá jednotlivé realizace z vlastních plnění; poplatky sdíleného fillu alokuje podle množství. Neznámé čisté P&L je null. Neplatné páry a nereconciliované korekce nejsou prezentované jako přesný zisk.
- Starý copierJournalSync již nevytváří syntetické follower obchody podle aktuální konfigurace. Existující odhady zůstávají zachované a označené; nejsou přepsané domnělou skutečností.
- Nová projekce celých pozic vyžaduje pozorovaný počáteční flat. Spojuje scale-in a částečné výstupy do jedné epizody, reverzaci dělí podle množství a stejným poměrem rozděluje poplatky. Chybějící či rozporné pořadí plnění a výpadky vedou k neúplné epizodě. Dnešní nulový snapshot neprokazuje historický počáteční flat.
- Po výslovném souhlasu uživatele je uploader zapojený do lokálního zdrojového kódu pilotu. Přijímá pouze přesný schválený origin a DEMO device autentizaci. Redirect je zakázaný; token je jen v autorizační hlavičce. Dávky jsou omezené počtem i skutečnými UTF-8 bajty, mají timeout a opakování s prodlevou. Kurzor se posouvá až po úplném potvrzení shodných ID. Příjem ověřuje otisk obsahu a přiřazuje uživatele/spojení ze spárovaného zařízení.
- Při restartu je počet starších neodeslaných záznamů neznámý (null), nikoli falešně jeden. Testovaný ztracený ACK opakuje stejná ID; model přijímače nevytvoří duplicitu. Produkční DB/RLS tím ověřené nejsou.
- Rozporné potvrzení příkazu má samostatný stav a přerušuje čáru. Grafové segmenty nepokračují přes výpadek ani konfliktní události se shodným časem. U otevřené pozice končí na posledním doloženém pozorování; částečný výstup není její konec. Původní risk box používá první fill, nikoli pozdější váženou cenu scale-in. Přehled událostí je doplněný také do fullscreen workspace mimo replay/backtest.
- Přijímací endpoint a verzovaná SQL migrace zůstávají lokálními soubory. Nebyla aplikována migrace, spuštěn produkční uploader, změněn worker ani nasazena aplikace.

## Co zbývá před dokončením celé funkce

1. Kompletní sběr a dohledání OrderVersion/FillFee/FillPair/CashBalanceLog musí být ověřeno na povoleném Tradovate prostředí. Výchozí exekuční sync seznam entit zůstal původní; analytický sběr nesmí způsobit odmítnutí nebo zpomalit celý exekuční stream. Aktuální pasivní recorder zaznamenává jen to, co adaptér skutečně obdrží.
2. Doplnit owner-scoped čtecí model a aktualizace hlavního journalu. Uploader je lokálně zapojený a testovaný s fiktivními daty a simulovaným příjemcem; skutečná DB jej zatím nepřijímá. Pole executionHistory se při existujícím plném detailu dá načíst, ale nové projekce zatím nejsou automaticky importované z evidence.
3. Integrovat novou projekci celých pozic do UI/importu a doložit počáteční stav i pro instrument bez historického Position řádku. Zatím se takové plnění správně ponechá nepřiřazené; úplný snapshot prázdných pozic ještě nemá vlastní důkazový marker. Fiktivní náhled je stále ručně sestavený, není ukázkou celého raw-evidence-to-UI toku.
4. Opravit/deduplikovat starší odhadované řádky jen na základě broker identity, se zachováním poznámek, obrázků a uživatelských změn. Legacy ledger stále nemá historické accountId; mapování podle aktuálního leadera není dostatečný podklad po jeho změně. Starý import nemá být pokládaný za nový ověřený account read model.
5. Dokončit aktualizace opožděného P&L/korekcí a idempotentní zápis napříč více taby. Samotný aktualizovaný kurzor `updated_at` toto neřeší.
6. Prověřit geometrii původního CandleKit position boxu přes chybějící svíčky/tržní přestávky a fullscreen seznam vizuálně v autentizované aplikaci. Knihovna extrapoluje od referenční/poslední svíčky; přes mezeru to může posunout box, zatím neopravováno. Schodová vrstva sama přes chybějící interval nevymýšlí časovou kotvu.
7. Zapojit stejný ověřený model také do karty LIVE kopírky a ověřit oba režimy v autentizované aplikaci. Fiktivní náhled není důkaz funkce s živými daty.

## Schvalování a cílový přenos

Automatická kontrola původně zamítla zapojení automatického vzdáleného uploaderu bez výslovného souhlasu s finančními daty a cílem. Uživatel následně výslovně odpověděl „souhlasím“ na konkrétní otázku níže. Tato překážka je tím vyřešená a souhlas se nemá vyžadovat znovu pro tentýž rozsah a cíl.

Schválená otázka: „Souhlasíš s doplněním automatického přenosu identifikátorů účtů a příkazů, plnění, časů, změn SL/TP, potvrzení/odmítnutí, poplatků a podkladů P&L přes stávající API alphatrade-mentor-15.vercel.app do tvé databáze Supabase?“

Schválený cíl: stávající AlphaTrade API `https://alphatrade-mentor-15.vercel.app/api/tradovate/oauth/copier-journal`, následně vlastníkova tabulka `tradovate_journal_evidence` ve stávajícím Supabase projektu. Uploader tento přesný origin vynucuje; obecná konfigurace relay jiné adresy povolit může, ale uploader je odmítne a zůstane lokální záznam.

Rozsah: prostředí/spojení a identifikátory účtů, příkazů a plnění; instrumenty, ceny, množství a časy; SL/TP verze s potvrzením či odmítnutím; poplatky, realizované páry a související účetní změny; explicitní vazby kopií a mezery záznamu. Hesla/tokeny nejsou součástí evidence. Existující device token by sloužil pouze k autentizaci přenosu do schváleného API.

Souhlas se zapojením tohoto přenosu není sám o sobě pokynem k obchodním akcím, ARM, reinstalaci workeru, změně produkční databáze nebo deployi. Před produkční databázovou změnou AGENTS.md vyžaduje upozornění a návrh samostatné zálohy/exportu; po skutečné změně jsou nutné advisors. Nic z toho zatím neproběhlo.

## Ověření

- Po souhlasu: 62 testů / 10 souborů prošlo v jednom běhu. Navíc ověřují epizody pozic, transport na schválený origin, integritu/scope, úplnost ACK, ztracenou odpověď a restart, chybu DB, ukončení zaseklé autentizace/sítě, prodlevy opakování a segmenty přes výpadky/rozpory. Pouze fiktivní data; žádné síťové volání brokera/produkční DB.
- Po poslední úpravě časového konce otevřené pozice znovu prošlo všech 9 testů epizod. Scoped TypeScript (App, pilot, API, nové moduly/testy a náhled) a scoped ESLint prošly. Finální build aplikace i PWA prošel (3471 modulů, 85 precache entries, standardní varování >500 kB); není to deploy. `git diff --check` bez chyb.
- Aktuální DOM kontrola náhledu: individuální účet 11, čisté P&L 31,52 USD, dva potvrzené posuny v 15:34:04,235 a 15:34:04,745 a odmítnutí v 15:34:44,510. Fullscreen seznam je zatím ověřen kompilací, nikoli autentizovaným browser průchodem.
- Dřívější ověření před posledním doplněním (níže) není vydáváno za nový test produkční integrace.

- 48 testů / 9 souborů prošlo: individuální/kombinovaný scope, důkazové události, realizace a poplatky, trvalý JSONL, legacy sync bez syntetických followerů, historické vlastnictví příkazů, adapter renewal a request dedupe. Poslední dva testy ověřují pasivní observer: neotevírá/neprodlužuje spojení a chyba nebo pokus o mutaci pozorovatele nepoškodí další odběratele. Pozorované skalární obálky jsou zmrazené.
- Scoped ESLint změněných souborů: 0 chyb (`--quiet`, ne tvrzení o nulových warnings).
- Scoped TypeScript kontrola klienta, pilotu a API prošla i po lazy-load úpravě. Nejde o celý extension/server projekt.
- Prohlížeč: ověřeno 12 účtů, přepnutí individuálního P&L, přesné události a viditelné SL/TP čáry. Náhled záměrně nemá Supabase konfiguraci; sdílený modul hlásí její absenci. Nešlo o autentizovanou DB/broker kontrolu.
- Závěrečný `npm run build` prošel včetně PWA service workeru (3470 modulů, 85 precache entries). Zůstává standardní upozornění na velké chunky. `git diff --check` prošel. Build není deploy ani broker conformance.
