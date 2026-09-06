# iOS review — implementace oprav 5. 9. 2026

Opravy navazují na 19 nálezů v původním review. Lokální implementace a ověření jsou popsány níže; navazující sekce uvádí skutečnou instalaci a spuštění na iPhonu. Produkční nasazení ani rotace klíčů provedeny nebyly. Simulátor se podle přání uživatele znovu nespouštěl.

| Nález | Opravené chování | Regresní důkaz |
|---|---|---|
| S1 | Přepis hlasu přes autentizovaný serverový endpoint; soukromý Groq klíč se nečte v klientu. Kontrola celého native bundle. Chybný přepis zachová audio pro retry/export. | voiceTranscription, voiceMemoRecovery; pozitivní/negativní test scanneru |
| S2 | Face ID rozlišuje jednotlivá zamknutí; zrušení ani opožděná odpověď neblokují další pokus. Skutečný odchod do pozadí vždy vytvoří nové zamknutí. | nativePrivacyController |
| S3 | Odhlášení dostupné v mobilním Nastavení. Nejprve se odpojí obrazovky, vyčistí lokální data a zruší odběry; nové přihlášení čeká na dokončení. Pozdní požadavky původního uživatele se zahodí. | nativeSessionCleanup, sessionRequestGuard, storageSessionIdentity, cacheHelperSession; native lifecycle testy |
| S4 | Obnova studené cache porovnává skutečný obsah, přijímá i smazané řádky a respektuje rozepsané denní zápisy. | dashboardRefresh |
| N1 | Událost se nejprve uloží do trvalé fronty. Neúspěšné odeslání zůstane pro retry i po vypadnutí z runtime historie. | notificationDelivery, notificationCron |
| N2 | Dynamické copier/finanční alerty vlastní server; opakované session/audit připomínky v iOS vlastní lokální plánovač. | nativeCopierNotificationPlan, nativeWidgetNotificationPlan, notificationCron |
| N3 | Existující bezpečnostní časovač se nemaže před skutečným vypršením. Ztracený čekající slot se obnoví. | nativeCopierNotificationPlan, nativeNotificationClientLifecycle |
| N4 | Mazání testů používá explicitní původ test; zachovává bezpečnostní sloty, doručené zprávy i badge. | nativeNotificationClientLifecycle |
| N5 | Unikátní event/device klíč, CAS lease a kontrola lease před odesláním brání běžným souběžným duplicitám. Kurzor je monotónní, rozliší i události ve stejné milisekundě. | notificationDelivery, copierIncidentWatchdog; skutečný SQL test |
| N6 | Registrace APNs se zotaví po odmítnutí, timeoutu nebo chybě HTTP. Návrat do aplikace, online a tlačítko v Nastavení ji znovu ověří. | nativeNotificationClientLifecycle |
| N7 | Vzdálené i lokální akce sdílejí směrování a zachovají text z rychlé poznámky. | nativeNotificationClientLifecycle |
| N8 | Volba end10 znamená audit 10 minut po konci session i přes půlnoc. | notificationSchedule, notificationCron, nativeSessionReminders |
| W1 | Stáří workeru a brokeru pochází ze zdrojových časů; čerstvá HTTP odpověď neoživí staré ARM. | nativeWidgetRemoteSnapshot, nativeWidgetSnapshot |
| W2 | Widget při novém přihlášení získá novou identitu; registrace a podpis jsou vázané na generaci účtu. | nativeWidgetLifecycle |
| W3 | Chybějící P&L, zámek či pokrytí pozic/objednávek se zobrazují jako neověřené, nikoliv jako nuly nebo odemčený účet. | nativeWidgetRemoteSnapshot, nativeWidgetSnapshot |
| W4 | Po přijetí serverové registrace lokální fallback nepřepisuje Live Activity. Fallback respektuje stejné P&L, čerstvost a čekající objednávky. | nativeWidgetLifecycle, nativeLiveActivityUpdater |
| W5 | Všechny varianty Dynamic Island a Lock Screen respektují stale stav, včetně barev a SL/TP údajů. | Swift kompilace + kontrola zdrojů |
| W6 | App Group používá společný procesní zámek. Ověření tokenu/generace a zápis odpovědi jsou atomické vůči odhlášení. | nativeWidgetLifecycle + Swift kompilace |
| W7 | Profitabilní trailing SL je platná ochrana a ukazuje podepsaný výsledek. Follower potřebuje vlastní potvrzený stop pro celé množství. | nativeWidgetRemoteSnapshot, nativeLiveActivityUpdater |

Doplňky zahrnují pravdivý stav oprávnění versus přijaté APNs registrace, zobrazení neověřených předchozích denních metrik a přehlednější počty účtů ve widgetu.

## Ověření

- **2 000 / 2 000 testů**, 241 testovacích souborů; jediný worker, bez paralelizace souborů.
- Úplný `tsc --noEmit --incremental false`: PASS. Závislosti/lockfile se neměnily; použity již nainstalované závislosti, bez dalšího `npm ci`.
- Lint 55 změněných TS/TSX souborů: **0 chyb, 33 varování** (nebyl proveden plošný úklid staršího kódu).
- Produkční webový build a native build: PASS. Vite nadále upozorňuje na některé chunky větší než 500 kB.
- `cap copy ios` a `ios:doctor`: PASS.
- **Xcode build App + widget extension: PASS**, generic iOS device, `CODE_SIGNING_ALLOWED=NO`, `-jobs 1`, nízká priorita. Jde o nepodepsanou kompilaci, nikoli instalaci nebo runtime test na telefonu.
- Skutečný PostgreSQL/PGlite: migrace, unikátní enqueue, CAS/reclaim lease, monotónní kurzor včetně bootstrap hranice, oprávnění a RLS: PASS. Bez spojení s produkční databází.
- Kompletní kontrola vygenerovaného webu, native bundle a kopie v Xcode: žádný výskyt detekovaných Groq/PEM soukromých klíčů. Negativní test scanneru správně odmítl klíč v lazy chunku a nevytiskl jeho hodnotu.
- Před integrací zkontrolovány SHA-256 otisky; souběžné úpravy backtestu a grafů byly sloučeny a zahrnuty do posledních kontrol. Opravy zahrnují **63 zdrojových/testovacích souborů**; ostatní úpravy nebyly přepsány.
- Lokální záloha před integrací: `/private/tmp/alphatrade-ios-fix-backup-20260905` (přístup pouze vlastník). Je dočasná a nenahrazuje samostatnou zálohu produkce.

## Fyzický iPhone — instalace 5. 9. 2026

- Na připojený **iPhone 13 Pro Max, iOS 26.6.1** byl nainstalován podepsaný **AlphaTrade 1.0 (2)** jako aktualizace existující aplikace, bez odinstalování a mazání kontejneru. Číslo buildu bylo znovu ověřeno dotazem na telefon.
- Podepsané sestavení App + obou extensions a `codesign --verify --deep --strict`: PASS. Profily obsahují tento telefon; aplikace a widget mají development APNs a správnou App Group.
- Všech 63 souborů odpovídá předchozímu ověřenému manifestu; všech 120 zabalených webových souborů odpovídá otestovanému native bundle. Novější souběžné rozpracované změny backtestingu z tohoto testovacího buildu byly záměrně vynechány a v pracovním projektu zůstaly zachovány. Build 2 je parametr sestavení, zdrojový projekt stále uvádí build 1.
- **Po odemčení uživatelem spuštění PASS**: aplikace se načetla do dashboardu s existujícími daty a spodní navigací. Ověřeno fyzickým snímkem z Xcode; stejný proces byl stále přítomen přibližně minutu po spuštění. Původní systémová blokace `Locked` je vyřešená. Samotný snímek neověřuje ovladatelnost všech obrazovek ani správnost metrik. Face ID a vizuální widgety zatím nemají dokončený nový fyzický test.
- **Původní uživatelské potvrzení (později upřesněno jako galerie)**: v Nastavení → Notifikace → Alert test lab → Obchod uzavřen → Test na iPhone upozornění dorazilo při zamčeném telefonu a klepnutí otevřelo Deník. Uživatel na společný dotaz k oběma výsledkům odpověděl „ano“. Textová poznámková akce ještě nebyla ověřena. Serverový APNs test cílí na všechna aktivní nativní zařízení uživatele a nepoužívá nový outbox, proto nebyl spuštěn; lokální test nedokazuje vzdálené doručování, retry ani deduplikaci.
- Simulátor zůstal vypnutý. Produkce, migrace, klíče a broker nebyly změněny. Podrobnosti bez tokenů: `evidence/phone-install.json`.

## Navazující oprava mobilních testů — build 3

Uživatel upřesnil, že přišly všechny testy společně a jednotlivé nemohl spustit. Fyzický snímek odhalil konkrétní problém: tlačítka byla až v pravém sloupci tabulky široké nejméně 760 px, mimo běžný pohled na telefonu. Předchozí „ano“ proto není důkazem řízeného testu jediného scénáře; zůstává uživatelským potvrzením doručení/otevření z galerie.

- **Oprava:** osm samostatných mobilních karet s plnošířkovými tlačítky; desktop zachovává tabulku. Hromadná galerie 22 scénářů je až pod kartami a standardně sbalená. Synchronní ref brání dvojitému klepnutí i souběhu jednoho testu s galerií.
- **Automatický fyzický důkaz:** přes existující opt-in DEBUG přepínač byla naplánována právě jedna místní zpráva s obrázkem. Následný dotaz na iOS potvrdil ID `1999999901`, jednu přílohu a kategorii `ALPHATRADE_TRADE`; doručený počet vzrostl 23 → 24. Všech 30 opakovaných session připomínek zůstalo zachováno. Tento důkaz byl získán na buildu 2 před následnou čistě Settings opravou; není to test tap/textové akce, Face ID ani APNs.
- **Vizuální QA:** skutečný Settings/Card JSX, formatter, ikony a CSS z nového native buildu. Při 430px iframe mají obsah i scroll šířku 424 px, všech osm tlačítek se vejde a má alespoň 44 px na výšku, desktopová tabulka je skrytá. Při 1100 px desktop funguje, mobilní karty jsou skryté. Galerie v obou případech sbalená.
- **Validace:** syntax a cílený harness skutečných handlerů PASS (1 schedule, blokace dvojkliku/galerie/pushBusy), scoped lint 0 chyb / 5 stávajících warningů, nezávislé review bez blokujícího nálezu. Native Vite build + scanner, cap copy, podepsaný Xcode build a hluboká kontrola podpisu PASS; 120 zabalených souborů odpovídá ověřenému výstupu. Nová úplná kontrola TypeScriptu byla kvůli tlaku na RAM přerušena; nepřičítá se mezi úspěšné kontroly. Původní plné ověření 2000 testů patří předchozímu stavu.
- **Instalace:** AlphaTrade **1.0 (3)** byl nainstalován jako aktualizace na stejný iPhone a systém potvrdil úspěšné spuštění. Nové UI bylo vizuálně ověřeno v lokálním náhledu; po instalaci se neprohlašuje za automaticky proklikané na telefonu. Do canonical projektu byl se strážným SHA integrován pouze Settings.tsx; souběžné backtest úpravy a jejich generované soubory nebyly přepsány.
- **Hranice automatizace:** systémové Zrcadlení iPhonu ohlásilo nedostupnost v této zemi/oblasti. Region ani bezpečnostní nastavení se neměnily. Přímé klepnutí do systémové notifikace, textová akce a Face ID zůstávají fyzicky neověřené. Žádný simulator, deploy, migrace ani broker akce. Dočasná QA tab a její server byly zavřeny.

Přesné důkazy bez tokenů: `evidence/mobile-alert-fix.json`. Lokální návratová kopie Settings: `/private/tmp/ios-mobile-alert-backup/Settings.tsx`.

## Aktivace mimo lokální kód

1. Před změnou produkce vytvořit samostatný export Supabase schématu/dat a zálohu aktuální konfigurace Vercelu. Uložit je mimo repozitář a ověřit obnovitelnost.
2. Připravit nový **serverový** `GROQ_API_KEY`, aktualizovat serverové prostředí a zneplatnit dříve vložený klientský klíč. Staré instalované aplikace ani již publikované soubory nelze opravit změnou zdrojáku. Nikdy klíč neukládat pod `VITE_`.
3. **Před nasazením serverového kódu** aplikovat `supabase/migrations/20260905155220_notification_delivery_outbox.sql`; potom spustit Supabase security/performance advisory. Bez migrace nové odesílání bezpečně selže, nepřepne se na starý mechanismus náchylný k duplicitám.
4. Nasadit ověřenou revizi serveru a webu, ověřit skutečný READY deployment, alias a odpovědi API.
5. Sestavit a nainstalovat podepsanou aplikaci s novým bundle na fyzický iPhone. Ověřit Face ID cancel/resume, logout/login, APNs v popředí/pozadí/zavřené aplikaci, textovou akci, časovače a widgety bez spuštěného workeru. Tato kontrola nemá vyvolávat broker příkazy ani obchody.

Push na main, změny produkční konfigurace a aplikace migrace nebyly v této opravě provedeny. Odpovídá to pravidlům v AGENTS.md a odděluje lokální důkazy od skutečné aktivace.

## Přesné hranice spolehlivosti

- APNs nemá transakci společnou s databází: pokud Apple přijme zprávu a spojení se ztratí před potvrzením, absolutní exactly-once doručení nelze zaručit. Fronta má retry, deduplikaci, lease a stabilní collapse identitu; expirace událostí je záměrně omezená.
- Odhlášení ihned vymaže lokální widgety/aktivity/notifikace. Při offline nebo neurčitém výsledku starého registračního požadavku se vzdálená revokace pravdivě hlásí jako nepotvrzená.
- WidgetKit sám určuje skutečný rozpočet obnov. Připravené časové záznamy zobrazí zastaralost i bez nové sítě; minutové obnovování nelze slíbit.
- Přepis má limit 3 MB, autentizaci, timeout a lokální burst limit na serverové instanci. Limit není globální distribuovaná kvóta; nahrávka po chybě zůstane dostupná v otevřené obrazovce.
