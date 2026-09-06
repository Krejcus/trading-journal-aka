# iOS review — native shell, auth, privacy, offline/cache

Datum: 2026-09-05. Read-only review hlavní aplikace `/Users/filipkrejca/Documents/trading-journal-aka`, HEAD `479a5c3df12133ebbb6409b4b9dd2a7f60e0d3ed` plus aktuální rozpracovaný strom. Native Lab nebyl předmětem tohoto podreview. Nebyly změněny zdrojové soubory, produkce ani přihlášení; nebyla odeslána notifikace nebo brokerový příkaz. Reprodukční soubory jsou pouze v `/private/tmp`.

## Potvrzené nálezy

### 1. [P1] Privátní Groq API klíč je součástí zabaleného iOS JavaScriptu

- Zdroj: [services/voiceMemoService.ts:23](/Users/filipkrejca/Documents/trading-journal-aka/services/voiceMemoService.ts:23), [services/voiceMemoService.ts:39-42](/Users/filipkrejca/Documents/trading-journal-aka/services/voiceMemoService.ts:39).
- Klient čte `import.meta.env.VITE_GROQ_API_KEY` a sám volá Groq s `Authorization: Bearer …`. Vite tyto proměnné vkládá do klientského bundle. Oficiální dokumentace výslovně varuje před ukládáním secretů do `VITE_*`: https://v6.vite.dev/guide/env-and-mode .
- Aktuální ověření bez zobrazení hodnoty: `dist-native/assets/VoiceMemoButton-BIwnAR_m.js` i `capacitor-ios/App/App/public/assets/VoiceMemoButton-BIwnAR_m.js` obsahují současně Groq transcription endpoint a řetězec odpovídající `gsk_[A-Za-z0-9]{20,}`. V každé sadě je 75 JS assets. Tvrzení tedy není pouze starý nález nebo hypotéza z názvu env proměnné.
- Trigger/dopad: kdokoli s distribuovaným app bundle může klíč extrahovat a používat Groq pod cizím účtem/kvótou. Platnost klíče ani skutečná distribuce tohoto přesného souboru na aktuálně instalovaný telefon nebyly ověřovány.
- Oprava: autentizovaný serverový endpoint pro transkripci, Groq secret pouze na serveru; následně samostatná rotace kompromitovaného klíče a nový native bundle. Klíč není v reportu ani tool výstupech.

### 2. [P2] Po zrušení Face ID a návratu z pozadí se Privacy Mode může zamknout bez dostupného odemknutí

- Hlavní místo: [components/NativePrivacyGate.tsx:32-43](/Users/filipkrejca/Documents/trading-journal-aka/components/NativePrivacyGate.tsx:32), zejména kontrola `autoAttemptedRef.current` na řádku 37.
- Propojení: [capacitor-ios/App/App/SceneDelegate.swift:48-56](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/App/SceneDelegate.swift:48); [capacitor-ios/App/App/AlphaTradeNativePlugin.swift:616-622](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/App/AlphaTradeNativePlugin.swift:616), `884-889`, `935-970`, `976-980`.
- Trigger: zapnout Privacy Mode → zrušit Face ID → odejít aplikací na Home → znovu otevřít.
- Po neúspěchu je React `locked=true` a `autoAttemptedRef=true`. Odchod do pozadí nasadí nativní `UIVisualEffectView` nad celé okno. Návrat provede `setLocked(true)`, tedy nezmění stav a neobnoví automatický pokus. Swift při návratu pouze upraví screen-capture reason, `privacyLock` ponechá. Jediný běžný odstraňující callback je dokončení nové autentizace; ta se nespustí a její React tlačítko leží pod nativním overlayem.
- Dopad: aplikace zůstane pokrytá neinteraktivním zámkem; uživatel nemá dosažitelné retry tlačítko. Vynucený restart je workaround, ne oprava.
- Repro: `/Users/filipkrejca/Documents/trading-journal-aka/docs/reviews/ios-20260905/evidence/ios-review-privacy-repro.cjs` transpiluje a vykonává nezměněnou React komponentu s deterministickým hook schedulerem. Native overlay přechody jsou modelované přesně podle uvedeného Swift zdroje. Cancel→resume: `authenticationCalls=1, reactLocked=true, nativeShield=true`. Kontrolní success→resume: `authenticationCalls=2, reactLocked=false, nativeShield=false`.
- Limit důkazu: source + deterministický runtime model, nikoli fyzicky potvrzené iPhone UI. Apple potvrzuje, že sceneWillResignActive nastává před pozadím i při dočasných přerušeních: https://developer.apple.com/documentation/uikit/uiscenedelegate/scenewillresignactive(_:) .
- Oprava: sjednotit native a React lock state; při foregroundu zajistit nový pokus nebo dostupné native retry, včetně stavu po cancel/unavailable. Nelze pouze odstranit ochranu a zobrazit citlivý obsah.

### 3. [P2] iPhone UI nemá dostupné odhlášení

- Hlavní místo: [App.tsx:3703](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:3703) (`hidden lg:block`) a [App.tsx:3714-3724](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:3714) (jediný UI logout handler).
- Jediné tlačítko je [components/Sidebar.tsx:343-354](/Users/filipkrejca/Documents/trading-journal-aka/components/Sidebar.tsx:343); na mobilní šířce se Sidebar nezobrazuje. Native menu [capacitor-ios/App/App/AlphaTradeShellViewController.swift:630-641](/Users/filipkrejca/Documents/trading-journal-aka/capacitor-ios/App/App/AlphaTradeShellViewController.swift:630) má stránky a nastavení, ale žádné odhlášení. `Settings` ani profil nemají jiný logout handler. Repo-wide vyhledání `onLogout|signOut|Odhlásit|logout` ověřeno.
- Trigger/dopad: přihlášený uživatel na iPhonu chce odhlásit nebo změnit účet; běžným UI se k tomu nedostane. Jediný jiný `storageService.clearAll()` nemá UI volajícího pro odhlášení a je servisní metoda.
- Oprava: přidat účet/odhlášení do mobilního nastavení nebo nativního Více, sdílet jeden cleanup handler pro všechny cesty.
- Limit: ověřena struktura zdroje, nikoli proklik přihlášené aplikace na fyzickém telefonu.

### 4. [P2] Cache refresh zahazuje změny obsahu existujících obchodů, účtů a deníku

- Hlavní místo: [App.tsx:1659-1668](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:1659), další použití [App.tsx:1682-1689](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:1682).
- Trigger: telefon startuje ze staré cache; na Macu se změní poznámka/tag/quantity/riskAmount existujícího obchodu nebo název/initialBalance účtu, poté proběhne studený start iOS. Ruční pull-to-refresh a následný focus sync mají další autoritativní obnovu; netýká se to každého refresh průchodu.
- Načte se cache a proběhne úspěšné načtení čerstvých dat. `fingerprintTrades` ale porovnává pouze `id:pnl:timestamp`; `fingerprintSimple` pouze `id`/`date`. Pokud se tato pole nezměnila, UI uchová staré objekty i po úspěšném server response a stáhne offline indikaci. Totéž pro obsah daily preps, daily reviews a weekly focus.
- Dopad: člověk na telefonu vidí staré poznámky, velikost/risk obchodu nebo staré parametry účtu a může změny považovat za ztracené. Týká se sdílené webové logiky, která běží i v iOS bundle.
- Repro: `/Users/filipkrejca/Documents/trading-journal-aka/docs/reviews/ios-20260905/evidence/ios-review-cache-repro.cjs` extrahuje a vykonává nezměněné fingerprint funkce z App.tsx. Metadata obchodu i obsah účtu se mohou změnit při identickém fingerprintu; obě kontrolní reprodukce prošly.
- Oprava: porovnávat verzi/updated_at nebo skutečná relevantní pole; obnovu serverového snapshotu nezakládat pouze na identitě řádků.

## Další předané riziko pro notification review

`SIGNED_OUT` v [App.tsx:524-554](/Users/filipkrejca/Documents/trading-journal-aka/App.tsx:524) provádí pouze reset JS/browser stavu, zatímco native subscription/widget/activity cleanup je jen v inline Sidebar logout handleru. Neočekávaný sign-out má proto jiný cleanup. `deactivateNativeRemoteNotifications` navíc ignoruje DELETE=false a token drží pouze v paměti modulu; offline/401 odhlášení nesmí být prezentováno jako ověřené zrušení serverového odběru. Předáno hlavnímu agentovi ke sloučení s notification review, aby nevznikly duplicitní nálezy.

## Co v této vrstvě dává smysl

- Supabase native auth používá PKCE a oddělený callback scheme; OAuth listener se registruje před čtením launch URL a stejné callback URL deduplikuje.
- Keychain je namespacovaný, používá `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; migrace browser session smaže legacy hodnotu až po úspěšném secure zápisu. Reálné Keychain chyby nejsou zaměňovány za prázdnou session.
- Native `loggingBehavior: none` zabraňuje vypisování bridge payloadů s auth sessions.
- Hlavní shell drží jediný Capacitor WebView; produktové deep linky jsou allowlistované a mají frontu přežívající cold start.
- Cold cache se čte s user-scoped klíčem a kontroluje identity cached profilu/snapshotu. Native build používá lokální assets; frontendové SW aktualizace jsou úmyslně vypnuté.
- Native LocalAuthentication používá deviceOwnerAuthentication, takže umí i fallback na device passcode. Přesnější UI text je „Odemknout“ / „Face ID nebo kód“, protože Touch ID a passcode jsou také možné: https://developer.apple.com/documentation/localauthentication/lapolicy/deviceownerauthentication .

## Doporučené doplnění testů a menší úpravy

- Skutečný lifecycle test Privacy Mode: úspěch, cancel, opakování, background během dialogu, Control Center, telefon bez použitelného ověření; navíc VoiceOver/klávesnicový focus pod privacy overlayem.
- Logout dostupný na iPhone, offline logout, nucený SIGNED_OUT, přihlášení druhého uživatele a vyčištění lokálních/systémových citlivých dat. `clearAppStorage` maže pouze localStorage, nikoli IndexedDB nebo pending/delivered nativní notifikace.
- OAuth parser by měl kontrolovat přesně URL protocol/host/path; současný startsWith přijímá také `/callback-extra`. PKCE omezuje dopad, tento okraj není v tomto review prokázaný auth bypass.
- Offline status a čerstvost uvádět konzistentně, refresh ověřovat i pro úpravy obsahu bez přidání/odebrání záznamu.

Existující `tests/nativeOAuth.test.ts` a `tests/nativeSecureStorage.test.ts` byly přečteny a požadovány do hlavní sady testů. Tento podreview je sám znovu nespouštěl, aby neduplikoval běh hlavního agenta. Simulátor/device instalace a end-to-end doručení nejsou tímto reportem potvrzeny.
