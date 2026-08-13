# AlphaTrade Native Lab — validační protokol

Stav: samostatný testovací iOS build věrně navazující na původní AlphaTrade. Bundle ID `app.alphatrade.nativelab`. Projekt nemění ani nenasazuje hlavní webovou aplikaci.

## Ověřeno v iOS Simulatoru

- Projekt se sestaví a spustí na iOS 26 simulátoru.
- Aktuální jednotková sada obsahuje 20 testů a všechny procházejí. Poslední cílený UI test byl zablokovaný pádem CoreSimulator test runneru (`Invalid device state`), nikoli assertion chybou aplikace; stejné klíčové routy byly následně ručně ověřeny přes runtime UI snapshot.
- UI scénáře skutečně proklikají pět hlavních sekcí, lokální rychlý zápis až do rozbaleného detailu v Deníku a úplné skrytí finančního UI pomocí Privacy Mode.
- Mobilní informační architektura odpovídá AlphaTrade: Dashboard, Historie, Zapsat, Deník, AI a Více; pod Více jsou Replay, LIVE, Lab a Nastavení.
- Dashboard filtr je funkční (7 dní, 30 dní, vše) a při připojení se KPI, equity křivka, kalendář i přehled účtů počítají z načtených obchodů.
- Privacy Mode skryje celý obsah a v accessibility stromu ponechá pouze odemknutí.
- Rychlý zápis ukládá obchod lokálně a aktualizuje dnešní souhrn.
- Journal data jsou šifrována AES-GCM klíčem uloženým v Keychainu pouze pro toto zařízení.
- Coach konverzace a uložené závěry mají vlastní AES-GCM úložiště a Keychain klíč; test potvrzuje obnovení po vytvoření nového store.
- Replay je lokální simulace; neobsahuje odesílání příkazů brokerovi.
- LIVE je výhradně read-only. V lokálním režimu používá bezpečná ukázková data; po přihlášení ukazuje účty a výsledky z existujícího `get_dashboard_data` RPC. Neobsahuje brokerové endpointy ani odeslání příkazu.
- Widget extension ve výsledném `.app` obsahuje sedm samostatných widgetů: Dnešní plán, Daily P&L, Equity Curve, Přehled účtů, Disciplína, Poslední obchody a Rychlé akce. Mach-O symbol audit potvrdil všech sedm typů i Live Activity.
- Zdrojový projekt podporuje omezený lokální snapshot přes `group.app.alphatrade.nativelab`, ale současný bezplatný Personal Team provisioning App Group nepovolí. Podepsaný fyzický build je proto vytvořen bez tohoto entitlementu a widgety používají jasně označený testovací fallback. Skutečná synchronizace vyžaduje placený Apple Developer profil. Tři režimy soukromí zůstávají připravené: částky, pouze R/procenta a úplné skrytí financí.
- UI testovací store publikování widget snapshotu vypíná, takže automatické testy nepřepisují běžná lokální widget data.
- Live Activity používá živý systémový časovač a aplikace po restartu obnoví správný stav tlačítka podle ActivityKit.
- Native Capability Lab umí požádat o oprávnění a naplánovat dvanáct lokálních scénářů jednotlivě nebo jako galerii rozloženou přibližně do 2,5 minuty.
- Galerie pokrývá základní test, obrázkový obchod, target, stop-loss, Daily P&L, time-sensitive risk warning, cooldown, přípravu, review, disciplínu, mock connection loss a obrázkový týdenní report.
- Tři notifikační kategorie obsahují přípravu, zápis, Deník, Coach, dvouminutové odložení a textovou odpověď. Dismiss pouze čistí badge a nespouští route.
- `UNNotificationAttachment` test vytvořil skutečný PNG soubor pro obchodní screenshot; stejný scénář byl doručen na zamykací obrazovku simulátoru s title `MNQ LONG · +1,42R`, subtitle, body, thumbnailem a badge `1`.
- Naplánované notifikace se zobrazují včetně cílové části aplikace a času; každou lze zrušit samostatně nebo všechny najednou.
- Native Capability Lab přímo spouští Live Activity, fotoaparát/Photos OCR, Privacy Mode, české diktování, Coach a čtyři druhy haptické odezvy; nejde jen o statický seznam možností.
- Osmivteřinová notifikace byla skutečně doručena na zamykací obrazovku simulátoru; badge `1` se objevil a po aktivaci aplikace se vyčistil.
- Notifikační route se při aktivním Privacy Mode odloží až do úspěšného odemknutí; unit test potvrzuje, že sheet ani citlivá sekce ochranu neobejdou.
- App Intents pro rychlý zápis, dnešní plán a replay jsou součástí aplikace.
- Všechny tři App Intents používají aktuální iOS 26 `supportedModes`; extrahovaná metadata obsahují jejich identifikátory, české názvy a tři App Shortcut fráze bez deprecation warningu.
- Spotlight indexuje pouze lokální demo záznamy a předává UUID konkrétního obchodu. UI test potvrzuje otevření Deníku, scroll/rozbalení přesného záznamu a Privacy test odložení route do odemknutí.
- Explicitní Info.plist obsahuje `alphatrade-lab` URL scheme. Runtime test `alphatrade-lab://live` otevřel aplikaci přímo na read-only LIVE obrazovce; stejné routy používají odkazy widgetů.
- Po úspěšném uložení se spustí haptická odezva.
- Mobilní build obsahuje pouze veřejnou Supabase URL a veřejný klientský klíč. Přístup vyžaduje uživatelský Bearer token, session je v Keychainu a implementace vzdálených dat volá pouze read-only `get_dashboard_data` RPC. Service-role, brokerové a Databento klíče v aplikaci nejsou.
- Nepodepsaná ARM64 kompilace pro `generic/platform=iOS` prošla včetně validace vloženého widgetu a extrakce App Intents metadat.
- Všechny targety jsou výslovně omezené na iPhone; projekt už nedeklaruje neověřenou iPad kompatibilitu.

Poslední jednotkový běh: 20 prošlo, 0 selhalo, 0 přeskočeno. Cílený UI runner následně narazil na pád CoreSimulator služby; hlavní navigace, filtr a LIVE byly poté ověřeny ručně přes runtime accessibility snapshoty a screenshoty.

## Fyzický iPhone

- finální aktualizovaný build (včetně funkčního filtru, read-only dat, opraveného LIVE a světlých widgetů) byl 13. srpna 2026 vývojářsky podepsán, nainstalován a spuštěn na iPhone 13 Pro Max,
- zbývá uživatelské přihlášení v aplikaci a potvrzení skutečného načtení účtů a obchodů,
- skutečná Face ID výzva a návrat z pozadí,
- fotoaparát, výběr fotografie a OCR na reálném screenshotu,
- české diktování a oprávnění mikrofonu/Speech,
- on-device Foundation Models na podporovaném zařízení s dostupným Apple Intelligence,
- widget na ploše, Live Activity a Dynamic Island,
- skutečné rozbalení PNG příloh, textová notifikační odpověď, snooze akce a všech dvanáct scénářů na zamčeném fyzickém telefonu,
- App Shortcuts/Siri a Spotlight výsledek,
- haptika, výkon, velikost textu, VoiceOver a chování bez sítě.

Ostatní položky výše jsou fyzický testovací checklist; bez jejich ručního provedení se nepovažují za potvrzené.
