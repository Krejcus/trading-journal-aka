# AlphaTrade iOS — review 5. 9. 2026

**Výsledek: 19 doložených nálezů — 2 P1 a 17 P2. Aplikaci nelze označit za bezchybnou.** Největší přínos nyní mají opravy doručování notifikací, spolehlivosti stavových widgetů a úniku klientského API klíče. Teprve potom přidávání dalších funkcí.

Review se týká hlavní Capacitor aplikace `app.alphatrade.native` v `/Users/filipkrejca/Documents/trading-journal-aka`, HEAD `479a5c3df12133ebbb6409b4b9dd2a7f60e0d3ed` plus současný pracovní strom. Samostatný SwiftUI Native Lab není aktuální hlavní aplikace a nebyl vydáván za její otestovanou náhradu. Rozpracované změny ostatních zůstaly zachované.

Nálezy jsou potvrzené kódem; část má navíc reprodukci nad skutečnými funkcemi s mockovanými závislostmi. **Nejde o potvrzení skutečného doručení APNs nebo stavu nyní instalovaného iPhonu.** Žádný brokerový příkaz, obchod, push test, změna nastavení produkce, deploy ani instalace na fyzický telefon neproběhly. Změny tohoto review jsou pouze dokumentace a lokální důkazy.

## Nejdůležitější nálezy

| ID | Priorita | Co se pokazí a za jakých podmínek | Důkaz |
|---|---|---|---|
| S1 | P1 | Privátní Groq klíč je přítomný v již vytvořených iOS JS assets. Získání balíčku umožňuje jeho extrakci; platnost klíče nebyla zkoušena. | [voiceMemoService.ts](/Users/filipkrejca/Documents/trading-journal-aka/services/voiceMemoService.ts:23), kontrola obou existujících sad assets bez výpisu hodnoty |
| W1 | P1 | Po ztrátě čerstvého heartbeat dostane widget nový čas HTTP odpovědi, ale staré `armed/connected`. Kruhový LIVE widget dál tvrdí ARM i vedle serverového stavu WORKER OFFLINE. | [Swift presenter](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:712), [DTO](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeWidgetRemoteSnapshot.ts:116), mock reprodukce |
| N1 | P2 | Po dočasném selhání APNs se událost označí jako odeslaná a další průchod ji přeskočí. Ztratí se upozornění, přestože žádný pokus neuspěl. | [sender](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeCopierStatePush.ts:80), mock reprodukce |
| N2 | P2 | Lokální i APNs větev stále odesílají stejné non-ENTRY/EXIT události, například posun SL. Stejný problém má část incidentů a session připomínek. | [lokální planner](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeCopierNotificationPlan.ts:267), mock reprodukce |
| N3 | P2 | Při otevřeném LIVE se naplánované upozornění ARM/cooldown/day-lock zruší v posledních 15 sekundách před termínem. | [planner](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeCopierNotificationPlan.ts:105), reprodukce T−14 s |
| N4 | P2 | „Zrušit čekající testy“ zruší i skutečná riziková upozornění. Evidence timerů přitom zůstane uložená, takže se běžným synchronizačním průchodem neobnoví. | [cleanup](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeNotifications.ts:211), mock reprodukce |
| N5 | P2 | Souběžné serverové procesy mohou odeslat stejnou událost dvakrát; chybí atomické převzetí doručení a ochrana hranice událostí proti staršímu zápisu. | [sender](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeCopierStatePush.ts:23), souběžná mock reprodukce |
| N6 | P2 | Zamítnutá notifikační oprávnění či neúspěšná první registrace se zapamatují jako hotový neúspěch. Opakování pro stejného uživatele již oprávnění nekontroluje. | [registrace](/Users/filipkrejca/Documents/trading-journal-aka/services/nativePushNotifications.ts:46), denied→granted reprodukce |
| N7 | P2 | Akční tlačítka vzdálené notifikace ignorují `actionId` i zadanou poznámku. „Otevřít Deník“ může otevřít LIVE; zapsaný text se nepředá do formuláře. | [APNs action handler](/Users/filipkrejca/Documents/trading-journal-aka/services/nativePushNotifications.ts:89), mock reprodukce |
| N8 | P2 | Jedno nastavení „10 minut“ znamená na serveru 10 minut před koncem session a lokálně 10 minut po konci. | [lokální čas](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeSessionReminders.ts:145), [serverový čas](/Users/filipkrejca/Documents/trading-journal-aka/api/cron/send-alerts.ts:348) |
| S2 | P2 | Zrušit Face ID → Home → návrat může ponechat nativní neprůchozí kryt nad React tlačítkem pro opakování. Nový pokus se už nespustí. | [privacy gate](/Users/filipkrejca/Documents/trading-journal-aka/components/NativePrivacyGate.tsx:32), skutečná komponenta + model nativních přechodů |
| S3 | P2 | Na iPhonu chybí dostupná cesta k odhlášení. Jediný UI handler je v Sidebaru skrytém pod desktop breakpointem. | [App.tsx](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:3703), kontrola všech UI cest |
| S4 | P2 | Při studeném startu ze staré cache se ignorují obsahové změny existujících obchodů, účtů a deníku. Porovnává se jen identita/pnl/čas. Ruční refresh či další focus sync je mohou napravit. | [porovnání cache](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:1659), reprodukce |
| W2 | P2 | Po logout/login s novým widget read-tokenem zůstane stará signatura registrace. Nový záznam zařízení tak nedostane APNs widget token a push refresh se neobnoví. | [registrace widgetu](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:225), nezávislá kontrola toku |
| W3 | P2 | Selhání načtení účtu, zámku či zůstatku z brokeru se ve widgetu promění na odemčený účet a $0, místo označení neznámých dat. | [widget DTO](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeWidgetRemoteSnapshot.ts:61), mock reprodukce |
| W4 | P2 | Nový/změněný snapshot otevřeného LIVE přepíše detailní serverovou Live Activity starým lokálním formátem. Zmizí SL/TP a další detaily, mění se význam P&L a interval zastarání 180→900 s. | [lokální payload](/Users/filipkrejca/Documents/trading-journal-aka/services/nativeWidgetSnapshot.ts:313), [Swift ContentState](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/App/AlphaTradeNativePlugin.swift:294) |
| W5 | P2 | Dynamic Island ignoruje `context.isStale`, i když Lock Screen už stará data označuje. | [Island](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:799), kontrola všech prezentací |
| W6 | P2 | Již autorizovaná pomalá widget odpověď může po odhlášení znovu zapsat snapshot předchozího uživatele. Callback nekontroluje aktuální identitu/token. | [HTTP completion](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift:173), kontrola souběhu |
| W7 | P2 | Platný SL posunutý do zisku z Live Activity zmizí, protože filtr vyžaduje stop na ztrátové straně vstupu. | [SL filtr](/Users/filipkrejca/Documents/trading-journal-aka/server/nativeLiveActivityBrokerSnapshot.ts:333), long MNQ mock reprodukce |

Detailní vysvětlení, přesné podmínky a směry oprav: [notifikace](notifications.md), [soukromí, přihlášení a cache](security.md), [widgety a Live Activities](widgets.md).

## Co bylo ověřeno

- `ios:doctor` prošel: konzistentní konfigurace, plugin registration, OAuth scheme, Keychain nastavení, usage strings a assets.
- Kontrola existujícího native HTML prošla: bez SW, PWA boot metadata, Tailwind CDN a Google Fonts odkazu.
- XcodeBuildMCP sestavil hlavní App scheme včetně extensions pro iPhone 17 / iOS 26.5, Debug, bez signing. Jde o čerstvé Swift sestavení s **již existujícími web assets**, nikoli o důkaz současného klientského kódu v telefonu.
- 24 souborů / **152 testů prošlo**. [Výstup](evidence/ios-review-tests-final.log). Sada zahrnuje native služby, OAuth, secure storage, shell, remindery, widgety, Live Activity, registry, watchdog a image push. Varování mock prostředí o opakované registraci pluginu není důkazem stejné chyby v aplikaci.
- Čtyři reprodukční harnessy nad aktuálními zdroji byly úspěšně spuštěny. Notifikační harness prokazuje osm scénářů; privacy harness porovnává cancel/success; cache harness ukazuje stejné fingerprinty po obsahové změně; widget harness prokazuje false ARM, unknown→$0 a ztracený profit stop. Některé vedlejší scénáře nebyly bez důkazu dosahu povýšeny na samostatné nálezy.
- Simulátor byl po souhlasu spuštěn, app nainstalována a nástroj potvrdil proces launch. Nepodařilo se získat použitelný průchod app UI; screenshoty ukázaly Home Screen a accessibility selhávalo. Není to ověřená funkčnost aplikace po přihlášení.
- Uživatel simulátor vypnul kvůli silnému zpomalení Macu. Zbývající vlastní typecheck a izolovaný build čerstvých native JS assets byly poté ukončeny. **Plný typecheck a čerstvý Vite native build proto v tomto review nemají výsledek PASS.** Simulátor se znovu nespouštěl.
- Existující `dist-native/index.html` a kopie `capacitor-ios/App/App/public/index.html` mají čas 28. 8. 2026. To dokládá stáří lokálních generovaných assets, nikoli datum či přesnou verzi instalace v telefonu. Projekt stále udává verzi 1.0 / build 1.

## Co je navržené rozumně

Keychain používá ochranu WhenUnlockedThisDeviceOnly, PKCE má oddělený callback a bridge neloguje citlivé payloady. Hlavní shell sdílí jeden WebView a systémové zkratky pouze navigují. Notification Service Extension omezuje HTTPS, MIME, objem i čas stahování a má textový fallback. Serverová Live Activity má mechanismus stale-date. Tyto dobré základy ale nenahrazují chyby v navazujícím lifecycle a prezentaci uvedené výše.

## Co bych vylepšil a v jakém pořadí

1. **Bezpečnost a správnost:** přesunout Groq secret na autentizovaný serverový endpoint; následně samostatně rotovat stávající klíč. Opravit falešné ARM/odemčení a privacy deadlock. Zavést společný stavový model pro worker, broker a stáří dat.
2. **Jednotné doručování:** pro každou třídu události určit jedinou hlavní doručovací cestu, ukládat stav podle event ID a zařízení, atomicky přebírat odesílání a evidovat retryable/unknown/accepted výsledky. Přijetí APNs odlišit od skutečného zobrazení na telefonu. Oddělit testovací a skutečné timery.
3. **Účet a diagnostika v mobilním Nastavení:** dostupné odhlášení, bezpečný cleanup všech systémových ploch, viditelná verze/build/commit, čas poslední registrace a ověření push transportu, poslední aktualizace dat. Běžné UI má ukazovat srozumitelný stav; technické detaily mohou být v rozbalitelné diagnostice.
4. **Sjednocené widgety/Live Activity:** jeden datový formát a význam P&L, konzistentní zobrazení zastaralých hodnot a zachování platného SL v zisku. Zobrazit poslední skutečný čas zdroje. Samostatně rozhodnout podporované iOS verze: widget target je nyní iOS 26, hlavní app iOS 15.
5. **Pohodlí a přístupnost:** otestovat VoiceOver, větší text, nejmenší podporovaný iPhone, softwarovou klávesnici a formuláře. Widget s více účty omezit na počet, který se vejde, a doplnit „+N“. Pro distribuci zavést rozlišitelné buildy a opakovatelný release checklist. Vizuální návrhy jsou doporučení k ověření, ne změřené současné UI vady.

## Co zbývá ověřit na skutečném iPhonu

Tato část je budoucí validační plán, **ne výsledky tohoto review**. Nevyžaduje vytvářet obchod ani ARM kvůli testu: systémové cesty lze zkoušet s označenými testovacími payloady a obchodní obsah následně pasivně ověřit při přirozené události.

1. Zapsat přesný instalovaný build/hash a ověřit, že odpovídá opravenému klientu a nativním extensions.
2. Email/Google login, cold start, obnova session, logout/login a přepnutí uživatele; nepřebírat přihlašovací údaje do reportu.
3. Lokální a remote oznámení: foreground, pozadí, force-quit, zamčený telefon; kontrolovat počet podle jednoho event ID.
4. Každé remote akční tlačítko včetně poznámky, cold start a zamčené Privacy Mode. Poznámka musí být pouze draft.
5. Denied→granted oprávnění, počáteční nedostupnost registračního API a obnovení bez vynuceného restartu.
6. Časované expirace, změna/zrušení termínu a „zrušit testy“ bez zásahu do skutečných připomínek.
7. Face ID cancel→Home→návrat, opakování, systémové overlaye a screen recording; ochrana nesmí ani propustit data, ani odstranit cestu k odemknutí.
8. Widget read-token/APNs registrace po logout/login; zastaralý heartbeat a neúplná broker data přes izolované fixtures.
9. Obě generace Live Activity obsahu, uzavřená/otevřená app, P&L význam a SL/TP; Dynamic Island na podporovaném zařízení.
10. Offline cold cache po změně poznámek/risku na jiném zařízení, návrat sítě a ruční refresh. Viditelně odlišit lokální/přijatá/naposledy známá data.

Historické záznamy fyzického testování v PROJECT_LOG a IOS_NATIVE_TEST_MATRIX nejsou nové fyzické testy. Matice je navíc v některých řádcích starší než projektový log; před označením opravy za hotovou ji aktualizovat podle konkrétního buildu a skutečně provedených kroků.
