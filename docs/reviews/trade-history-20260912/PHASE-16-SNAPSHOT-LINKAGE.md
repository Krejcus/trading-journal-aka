# Fáze 16 — automatické snímky v novém journalu

Pouze lokální změny v izolovaném worktree. Žádný obrázek nebyl pořizován z brokeru ani nahráván do vzdáleného úložiště; nebyla provedena migrace, deploy nebo restart workeru.

## Přesná vazba

Dřívější browserový `syncCopierJournal` doplňoval metadata snímků do legacy master řádku. Nový import jej již nepoužívá, takže nově založené journal obchody neměly automatickou cestu k existujícím screenshotům.

Nová owner-only čtečka `journal_trade_snapshots` propojuje uzavřenou potvrzenou pozici přes jediné finální výstupní fill ID s `tradovate_copier_trades` ve stejném připojení a vlastníkovi. Záznam kopírky poskytne episode UUID a tím přesný odkaz na `copier_trade_snapshots`. Aktuální kopírovací konfigurace, násobky, časová blízkost ani odhadované členství se nepoužívají. Vazba tedy neposílá snímky leadera automaticky followerům.

Čtečka vyžaduje existující vlastní root trade, shodný účet a úplnou aktuální revizi. Nejednoznačné závěrečné plnění, rozdílné epizody pro stejný fill nebo epizoda použitá jiným ledger obchodem nepřipojí žádný obrázek. Opakovaná totožná ledger evidence od druhého zařízení se deduplikuje. TV alert snímky jsou vyloučené. View je security_invoker, respektuje RLS všech podkladů a má pouze SELECT grant pro authenticated/service_role; anon nemá přístup. Dva indexy podporují přesné hledání fillu a epizody. Migrační soubor vytvořilo skutečné `supabase migration new`.

## Čtení a chyby

Metadata se doplňují po ověření vlastních finančních faktů, pro nejvýše 100 obchodů na URL dávku. Každá dávka čte stránky do 250 snímků až po prázdnou stránku; nižší serverový cap není konec seznamu. Kontrolují se unikátní klíče, vlastník, účet, episode/snapshot UUID, druh, čas a přesná privátní cesta. Žádné obrázkové soubory se v tomto kroku nestahují ani nepodepisují.

Pozdní upload se projeví dalším čtením, i když se finanční import nezměnil. Oprava nebo odstranění vazby odstraní dřívější neověřené automatické snímky. Ruční screenshoty a poznámky zůstávají zachované. Současná změna finanční generace stále zneplatní celé čtení. Chyba metadata služby smaže jen neověřenou automatickou galerii dané dávky a nastaví explicitní stav chyby, neovlivní potvrzené P&L. Odhlášení nebo abort se dál propaguje jako chyba celé owner operace.

Ochranný limit je 20 000 metadat / 8 milionů JSON znaků na dávku; při překročení se nevrací prefix jako úplná galerie. Pro extrémní galerie ještě dává smysl stránkovat a podepisovat až vybraný obrázek. Současný podpisový mechanismus galerie zůstává původní, proto nemá tato fáze tvrdit neomezený rozsah fotografií.

Automatické cesty se neukládají do nového sdíleného root JSON; živě se čtou z privátního view. Stav chyby je pouze přechodný, odstraní se při ukládání i při veřejném renderu. Synchronizace považuje metadata za čtené údaje, nikoli souběžnou uživatelskou editaci, a zachová nové poznámky.

## Detail a náhled

Skutečný `TradeDetailModal` načítá journal galerii až z čerstvého owner detailu. Rozlišuje čekání na odkazy, chybu metadat, částečně chybějící podpisy a chybu obrázku. Zobrazí stručnou zprávu a tlačítko Zkusit znovu. Screenshoty zůstávají první záložkou. Barvy, rámečky a typografie vycházejí ze stávající komponenty a tokenů; před úpravou byl zkontrolován vykreslený canonical LIVE.

Fiktivní preview dostalo volbu ENTRY/EXIT leadera a simulace chyb. Testovací SVG média vznikají ze stejných fiktivních candle dat jako jeho graf a jsou výrazně označena. Signer pro tento preview vrací pouze lokální data URL; nikam se nic nenahrává. V browseru ověřeno: dva snímky leadera, ENTRY/EXIT popisky a čas pořízení, správné přepínání, oba typy chyby, retry ponechávající chybu při trvající závadě, follower bez cizí galerie a zachovaný výchozí Screenshot tab.

## Ověření

- 79 testů / 7 souborů. Metadata stránky, nižší cap, vlastní účty, pozdní doplnění, chybné cesty, neúplné odpovědi, session fence, ochrana manuálních snímků/poznámek, ochrana souběžného review při obnově metadat, public stripping a regrese skutečného storage čtení, snapshot store a thumbnails. Test odhalil chybějící odstranění nového transient error pole ve veřejném renderu; opraveno, konečný běh prošel. Starší TypeScript sourcemap warning ve sdílených dependencies přetrvává.
- PGlite se skutečnými pěti journal migracemi, původní snapshot tabulkou/policy z její migrace a skutečnou klientskou hydratací. ENTRY a pozdější EXIT se připojily jen jednomu ze 12 účtů; druhý upload nevyžadoval nový finanční import. Duplicitní ledger doručení neduplikovalo média. Jiný vlastník a anon nic nečetli; jiná connection, nejednoznačná episode a dvojí závěrečný fill byly odmítnuté. Prošel i celý navazující server/SQL průchod 2 400 epizod včetně oprav, staging resume, SL časů a individuálních P&L.
- Scoped TypeScript, ESLint bez chyb (10 starších warningů v detailu), včetně ignorovaného preview a verifieru; Vite/PWA 3 484 modulů, 89 precache; diff check.

Ověřené podklady: [Supabase RLS a security_invoker views](https://supabase.com/docs/guides/database/postgres/row-level-security). Security checklist byl použit; vzdálené advisors a záloha jsou stále budoucí deployment gate, nikoli provedená produkční kontrola.

## Zbývá

Tato fáze řeší vazbu již uložených snímků potvrzených uzavřených journal obchodů. Neprokazuje dostupnost CDP, skutečné pořizování/odeslání obrázků workerem ani přihlášený Storage/PostgREST tok. Canonical UI při read-only kontrole stále hlásilo TradingView bez CDP. Pro testování capture nebyl spuštěn worker ani broker akce.

Celý cíl není hotový. Zůstává obecný historický backfill a pokrytí, rozdělení velké finanční projekce, velké broker seznamy, position box přes mezery, nonpublic social projekce, raw-to-UI a přihlášený E2E. Kontrola skutečného detailu znovu ukázala starší zaokrouhlení P&L na celé dolary a cenové R/R; jejich přesnost je další konkrétní položka. Produkční nasazení vyžaduje samostatnou autorizaci a zálohu.
