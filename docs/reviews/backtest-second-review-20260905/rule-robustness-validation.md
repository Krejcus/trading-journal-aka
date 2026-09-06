# Verze pravidel, odolnost výsledků a B16 — lokální ověření 5. 9. 2026

Tento blok není dokončení 48bodové roadmapy. Žádný push/deploy, vzdálená migrace, broker akce ani externí AI požadavek neproběhly.

## Implementace

- F09: verzovaný výzkumný případ v existujícím owner-only Lab experimentu: hypotéza, pravidlo, vyvrácení, cílové pozice, časové pásmo, oddělené datumové plány. SHA-256 identity obsahu, návazné revize a stabilní operation ID pro opakování. Legacy pravidlo se zachová s neznámým časem; nepředstírá se původní registrace.
- Nová session načítá uložené případy a před vytvořením znovu ověří vybranou verzi. Run obsahuje celý snapshot; trade jen ID/hash/účel bez soukromého textu pravidla. Kopie session má novou identitu vazby a označení již pozorovaného vzorku. Workspace zobrazí uložené pravidlo.
- Lab umí zvolit konkrétní verzi a zvlášť vývoj/plánované ověření. Původní baseline se nepřeznačuje. Neodpovídající hash/role/verze a neznámý čas jsou vyřazené s počtem a důvodem. Cíl a kvalita vzorku počítají úplné pozice doložené ledgerem; partial slicing nezvyšuje N ani kvalitu. P&L/WR stávajícího before/after zůstávají výslovně popisné statistiky výstupních záznamů.
- Ukládání Labu používá exact owner/updated_at CAS a potvrzený serverový body/ID, nejistý transport provede pouze readback. Nová ID jsou insert-only. Připravená migrace `20260905194812_backtest_research_rule_history_guard.sql` zachová existující prefix pravidel a zmrazený baseline i vůči starému full-JSON klientovi; dosud není aktivní.
- F15/F16: Lab → Odolnost, celé pozice/dny, varianty bez top 1/3/5 kladných pozic/dní, přesné ID vyloučení, čistý P&L/expectancy/PF/DD, deterministický circular block percentile bootstrap. Viditelný seed, opakování, blok, jednotka, časové pásmo a hranice dne. Baseline DD je realizovaný exit ledger, bootstrap DD po zvolené jednotce; tyto řady se nezaměňují. Nekonečný PF se nevyhazuje. Smíšené měny blokují agregaci. Výpočet má lokální rozpočtový limit.
- B16: legacy notes oddělené od veřejného JSON, zachovaný owner přístup i explicitní shareNotes, serverový receiver consent a ochrana proti spoofed accepted connection. Podrobný rozsah a otevřené širší ACL: [B16_PRIVACY.md](B16_PRIVACY.md). Lokálně hotovo, produkční expozice se tímto zápisem nemění.
- F33: model kategorií/aliasů/merge/archive, editor preview a atomické owner RPC jsou připravené; [F33_TAG_LIBRARY.md](F33_TAG_LIBRARY.md). Wrapper, strict paginated full-trade read, zapojení do hlavního UI a návrhy tagů přes canonical resolver se ještě dokončují.

## Ověření

- Root společný regresní běh: **14 souborů / 238 testů passed**. Zahrnuje research cases, Lab CAS, robustnost, App/MCP kohorty, Lab analytiku, mapování a persistence/soukromí. Při načítání TypeScriptu se objevil nefatální chybějící sourcemap warning. Původně chybná explicitní metadata assertion byla aktualizována pro `unlinkedTradeIds`; algoritmus se kvůli testu nevracel zpět.
- Samostatná nová sada kohort: 41 testů přes skutečný App/MCP zdroj; zahrnutá v root běhu. Cases/CAS/robustness: 77 testů v překrývajícím se běhu; nesčítat.
- B16 agent: 56 cílených testů + 22 skutečných PGlite kontrol. F33 agent: 31 testů + 23 PGlite kontrol. Tyto běhy se částečně překrývají s root testy; nejde o nový souhrnný počet.
- Rule-history migration: **15 PGlite invariantů**, insert/append/status, zákaz přepisu/mazání/zkrácení prefixu, baseline drift, parent/op/time chyby, zachování dat po failed write a transakční rollback.
- TypeScript passed; scoped lint nových root komponent/služeb 0 chyb/0 warnings. B16 širší scoped lint 0 chyb/15 starších warnings. Produkční Vite build do `/private/tmp/alphatrade-backtest-rule-version-build-20260905` passed, 82 precache položek, 4051.35 KiB. Tag wrapper a strict reader, které pokračují po tomto ověřeném bloku, ještě nejsou kryté tímto buildem.

## Prohlížeč

Použit skutečný Lab a SessionsManager na oddělené QA stránce `tests/qa/research.html`, syntetické obchody a falešný in-memory cloud. CSP blokuje externí endpoints. Výsledky nejsou důkazem skutečného cloud syncu.

1. 12 výstupů → 11 pozic, čistý P&L 320 USD, baseline expectancy 29,09 USD; top1 zisková pozice odstraní 150 USD a nechá 170 USD. První dva partialy zůstaly jednou pozicí.
2. Bootstrap po kliknutí: 11 dní, blok2, 1000 opakování, seed42; zveřejněné 95% intervaly P&L 90 až590 USD, expectancy8,18 až53,64 USD, PF1,41 až6,75 a denní DD40 až120 USD.
3. Experiment development zahrnul12 výstupů/11pozic; validation stejnou sadu vyřadila se skutečným počtem12. Bez baseline evidence je kvalita insufficient.
4. Nové pravidlo → simulované selhání save → návrh i důvod zůstaly → opakování vytvořilo právěv2 s parentv1. Původnív1 se nezměnila.
5. Session mimo plánované datumové okno byla odmítnuta před vytvořením. Nezávislý pozitivní QA fixture bez vývojového omezení vytvořil session s přesným revisionId/hash a `already-observed` kvůli známým obchodům. Datumové pole CUA fill nedoručilo React změnu spolehlivě; tento test nepředstírá ruční ověření každé varianty kalendáře.
6. Nové rozložení Odolnosti vizuálně zkontrolované pod navigací Labu. QA single-run stub po vytvoření nového runu nahradí původní ledger; následné vyřazení starých fixture trades je vlastnost testovacího stubu.

## Co ještě neplatí

- Role validation není uzamčený ani doloženě neviděný OOS. `historyComplete:false` je záměrné, protože lokální/cloud fallback seznam není úplný registr expozice. F10/F11 čekají.
- Časy pravidel jsou klientské; hash je identita obsahu, nikoli podpis pravosti nebo důkaz předchozí neznalosti.
- Nová serverová ochrana historie není nasazená. Binding je zachováván aplikační cestou, nemá ještě zvláštní serverovou immutable constraint na run config.
- Reálný remote reload/concurrency, consent přechody, private-schema exposure a advisories se ověřují až v samostatně schválené aktivaci. F33 wrapper ani hlavní UI zapojení není tímto dokumentem označeno hotové.
- Main localhost karta byla při inventuře crashed; izolované QA běhy jsou oddělené od přihlášeného hlavního prostředí. Příčina pádu není prokázaná.

## Pozdější dokončení B17 a kontrola localhostu

B17 strict reader a Session export jsou propojené.28 cílených testů ověřilo1 205 řádků pod500-row server cap, chybu až na pozdější stránce, identity/cancel a rich/private hydration. Viz [B17_OWNED_EXPORT_READ.md](B17_OWNED_EXPORT_READ.md). Následný root běh92 testů/6files prošel a zahrnuje i regresi, že mapper do Trade nepřenese soukromý text pravidla. Jde o překryv se staršími běhy, počty se nesčítají.

Hlavní localhost3001 byl znovu otevřen a načetl přihlášený Backtesting Dashboard i navigaci Lab → Odolnost. Při pozdějším ověření se hlavní prostředí několikrát vrátilo na Dashboard během souběžných vývojových změn; dokončený výsledek načtení skutečného ledgeru nebyl zachycen. Neoznačovat hlavní data za plně ověřená tímto pokusem. Console ukázala pouze známé currencyService fetch failure; příčina resetu/původního pádu není prokázaná. Hlavní karta zůstala otevřená.

F33 wrapper byl následně dokončen a samostatně ověřen47 testy/4files a čistým lintem. Zachovává návrh při refresh, přesnou nejistou operaci po lost ACK a původní edit-time baseline stejného tagu. Hlavní App/Lab button a suggestions integrace dosud čekají.

Finální kontrola po zmrazení všech změn: typecheck a znovu produkční build passed; `/private/tmp/alphatrade-backtest-rule-version-final-20260905`,82 precache položek/4053.31KiB. Logy `implementation-evidence/rule-robustness-final-*`.
