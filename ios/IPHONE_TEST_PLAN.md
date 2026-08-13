# AlphaTrade Native Lab — instalace a fyzický test

Tento prototyp se instaluje přímo z Xcode. Nepoužívá App Store ani TestFlight a nezasahuje do hlavní webové aplikace.

## Než připojíš iPhone

- iPhone musí mít iOS 26 nebo novější; projekt má deployment target 26.0.
- Na Macu otevři `AlphaTradeNativeLab.xcodeproj` v aktuálním Xcode.
- V `Xcode > Settings > Accounts` musí být přihlášený tvůj Apple Account.
- V targetu `AlphaTradeNativeLab` otevři `Signing & Capabilities`, ponech `Automatically manage signing` a vyber svůj Team.
- Stejný Team vyber také pro target `AlphaTradeNativeLabWidgets`.
- Pro synchronizovaný widget snapshot musí placený Apple Developer profil povolit App Group `group.app.alphatrade.nativelab` v obou targetech. Bezplatný Personal Team ji nepodporuje; aktuální testovací build se proto podepisuje bez App Group a widgety používají testovací fallback.

Xcode při automatickém podepisování zaregistruje připojené zařízení a vytvoří vývojový provisioning profil. Oficiální postup: [Running your app on simulated or physical devices](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).

## Přímá instalace bez App Storu

1. Připoj odemčený iPhone kabelem k Macu a potvrď `Důvěřovat`, pokud se výzva objeví.
2. V horní liště Xcode zvol scheme `AlphaTradeNativeLab` a jako destination svůj iPhone.
3. Stiskni Run (`⌘R`).
4. Pokud iPhone vyžádá Developer Mode, otevři `Nastavení > Soukromí a zabezpečení > Režim vývojáře`, zapni ho a potvrď restart. Apple postup popisuje zde: [Enabling Developer Mode on a device](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
5. Po návratu spusť Run znovu. Na ploše se objeví samostatná ikona `AlphaTrade Lab`.

Tento krok pouze vytvoří vývojově podepsanou instalaci na vybraném telefonu. Nic nepublikuje.

## Fyzický test — pořadí a očekávaný výsledek

### 1. Bezpečnostní hranice

- Zapni Letový režim a spusť aplikaci.
- Očekávání: Dashboard, Historie, Deník, AI, Replay, LIVE, Lab a Nastavení se otevřou; v lokálním režimu aplikace nepotřebuje síť.
- Očekávání: nikde nelze odeslat reálný obchod ani připojit produkční účet.

### 2. Notifikace, akce a badge

- `Dnes > Vyzkoušet nativní funkce > Povolit nativní notifikace`.
- Naplánuj `Test za 8 sekund`, zamkni iPhone a vyčkej.
- Očekávání: zvuk/banner podle nastavení telefonu a badge `1` na ikoně.
- Podrž notifikaci a postupně ověř `Otevřít přípravu`, `Zapsat obchod` a `Otevřít Deník`.
- Očekávání: akce otevře správnou část; je-li aktivní Privacy Mode, route čeká až na odemknutí.
- Naplánuj cooldown i review, ověř jejich řádky s časem a samostatné zrušení.
- Potom spusť `Naplánovat všech 12 testů`. Během přibližně 2,5 minuty ověř různé subtitle, rostoucí badge, thread grouping, time-sensitive risk upozornění a stav seznamu pending requestů.
- U `Obchod se screenshotem` a `Týdenní equity report` notifikaci rozbal. Očekávání: systém zobrazí skutečnou PNG přílohu vygenerovanou lokálně aplikací.
- U stop-loss scénáře zvol `Přidat poznámku`, napiš krátkou reflexi a potvrď. Očekávání: otevře se Quick Capture s předvyplněnou poznámkou.
- U risk scénáře zvol `Odložit o 2 minuty`. Očekávání: bez otevření aplikace vznikne nový cooldown request a po dvou minutách otevře Coach.
- Nakonec použij `Zrušit vše`; musí zmizet pending i doručené demo notifikace a badge.

Akční tlačítka používají Apple `UNNotificationCategory`: [UNNotificationCategory](https://developer.apple.com/documentation/usernotifications/unnotificationcategory).

### 3. Live Activity a Dynamic Island

- V Native Capability Lab spusť Live Activity a přejdi na plochu nebo zamykací obrazovku.
- Očekávání: viditelný symbol MNQ, `NY AM`, risk 24 % a běžící systémový časovač.
- Na iPhonu s Dynamic Island ověř kompaktní i rozbalený stav; na jiném podporovaném iPhonu ověř Lock Screen prezentaci.
- Vrať se do aplikace a aktivitu ukonči.

Apple potvrzuje, že Live Activities běží přes WidgetKit/ActivityKit a Dynamic Island je jen na podporovaných zařízeních: [Displaying live data with Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities).

### 4. Privacy Mode a Face ID

- Klepni na `Vyzkoušet Privacy Mode`.
- Očekávání: P&L, účty, tab bar i ostatní citlivý obsah okamžitě zmizí.
- Odemkni přes Face ID nebo kód zařízení.
- Přepni aplikaci do pozadí a vrať se; ochrana se musí aktivovat znovu.

### 5. Fotoaparát, Fotky a Vision OCR

- Otevři přímý OCR test, povol požadované oprávnění a vyfoť screenshot s textem `MNQ`, `LONG` nebo `SHORT`.
- Očekávání: Vision lokálně rozpozná text, předvyplní instrument/směr a vloží nejvýše první čtyři OCR řádky do poznámky.
- Ulož záznam; očekávání: haptické potvrzení a nový rozbalitelný řádek v Deníku.

### 6. České diktování

- Spusť test diktování a povol mikrofon i Speech Recognition.
- Řekni například: `Po sweepu jsem počkal na potvrzení struktury.`
- Očekávání: průběžný český přepis se objeví přímo v panelu. Zvuk se neukládá.
- Totéž ověř v composeru Coach.

### 7. Haptika

- Vyzkoušej postupně `Výběr`, `Úspěch`, `Varování` a `Chyba`.
- Očekávání: čtyři rozlišitelné systémové vzory; testuj na fyzickém telefonu, simulátor haptiku nereprodukuje.

### 8. Widget, Siri, Zkratky a Spotlight

- V Native Capability Lab nastav postupně soukromí widgetů na `Částky`, `Pouze R / %` a `Skrýt finance` a pokaždé stiskni aktualizaci.
- V galerii widgetů ověř sedm samostatných položek: Dnešní plán, Daily P&L, Equity Curve, Přehled účtů, Disciplína, Poslední obchody a Rychlé akce.
- Přidej dostupné malé, střední a velké varianty. V Personal Team buildu očekávej označená testovací data, funkční deeplinky a správný AlphaTrade vzhled. Po přechodu na profil s App Group musí data odpovídat poslednímu lokálnímu snapshotu a peněžní údaje respektovat zvolenou ochranu.
- Ověř odkazy z widgetů do Dnes, Deníku, LIVE a Coach. Ve středním widgetu Rychlé akce ověř Zapsat, Coach, Replay a Plán.
- Ve Zkratkách vyhledej akce `Zapsat obchod`, `Otevřít dnešní přípravu` a `Pokračovat v replayi`.
- Ve Spotlightu vyhledej `MNQ` nebo text setupu z Deníku a otevři výsledek.
- Očekávání: vše vede pouze do lokálního prototypu.

### 9. Apple Intelligence

- V Coach spusť `Vytvořit lokální shrnutí`.
- Očekávání na podporovaném zařízení s dostupným modelem: tři krátké evidenční body bez signálu nebo pokynu k obchodu.
- Na nepodporovaném zařízení musí aplikace zobrazit jasnou informaci o nedostupnosti a nespadnout.

### 10. Přístupnost a odolnost

- Zvětši text v iOS, zapni VoiceOver a projdi hlavní tlačítka.
- Otočení je úmyslně omezené na portrét; ověř, že nedochází k ořezu důležitých akcí.
- Ukonči aplikaci, znovu ji spusť a ověř zachování lokálního Deníku, Coach paměti a stavu probíhající Live Activity.

## Co se během testu ukládá

- Deník a Coach paměť pouze v sandboxu této aplikace, šifrovaně pomocí AES-GCM.
- Šifrovací klíče pouze v Keychainu daného zařízení.
- Spotlight položky pouze pro lokální demo záznamy.
- Neodesílají se produkční data, přihlašovací údaje, screenshoty ani zvuk.

Odinstalování `AlphaTrade Lab` odstraní sandbox prototypu. Hlavní AlphaTrade web/PWA tím zůstane nedotčená.
