/* global console, process */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const errors = [];

async function text(path) {
  try {
    return await readFile(resolve(root, path), 'utf8');
  } catch {
    errors.push(`Chybí ${path}`);
    return '';
  }
}

function requireMatch(value, pattern, label) {
  if (!pattern.test(value)) errors.push(label);
}

const [config, plist, project, shell, plugin, scene, appDelegate, nativeStorage, packageJson, appSource, widgetSource, widgetPlist, appEntitlements, widgetEntitlements, privacyGate, stylesheet, tradeDetail, controlIntents, systemActions] = await Promise.all([
  text('capacitor.config.ts'),
  text('capacitor-ios/App/App/Info.plist'),
  text('capacitor-ios/App/App.xcodeproj/project.pbxproj'),
  text('capacitor-ios/App/App/AlphaTradeShellViewController.swift'),
  text('capacitor-ios/App/App/AlphaTradeNativePlugin.swift'),
  text('capacitor-ios/App/App/SceneDelegate.swift'),
  text('capacitor-ios/App/App/AppDelegate.swift'),
  text('services/nativeSecureStorage.ts'),
  text('package.json'),
  text('App.tsx'),
  text('capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.swift'),
  text('capacitor-ios/App/AlphaTradeWidgets/Info.plist'),
  text('capacitor-ios/App/App/App.entitlements'),
  text('capacitor-ios/App/AlphaTradeWidgets/AlphaTradeWidgets.entitlements'),
  text('components/NativePrivacyGate.tsx'),
  text('index.css'),
  text('components/TradeDetailModal.tsx'),
  text('capacitor-ios/App/App/AlphaTradeControlIntents.swift'),
  text('capacitor-ios/App/App/AlphaTradeSystemActions.swift'),
]);

requireMatch(config, /appId:\s*['"]app\.alphatrade\.native['"]/, 'Capacitor appId není app.alphatrade.native');
requireMatch(config, /loggingBehavior:\s*['"]none['"]/, 'Capacitor bridge logging musí být none kvůli auth tokenům');
requireMatch(config, /iosScheme:\s*['"]capacitor['"]/, 'Nativní bundle musí používat capacitor:// origin');
requireMatch(plist, /<string>alphatrade-native<\/string>/, 'Info.plist nemá OAuth scheme alphatrade-native');
requireMatch(plist, /<key>NSSupportsLiveActivities<\/key>\s*<true\/>/, 'Info.plist nepovoluje Live Activities');
requireMatch(plist, /<key>NSSupportsLiveActivitiesFrequentUpdates<\/key>\s*<true\/>/, 'Info.plist nepovoluje časté vzdálené Live Activity aktualizace');
requireMatch(plist, /<key>NSCalendarsWriteOnlyAccessUsageDescription<\/key>/, 'Info.plist nemá účel přístupu k zápisu do Kalendáře');
for (const key of ['NSFaceIDUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']) {
  requireMatch(plist, new RegExp(`<key>${key}<\\/key>`), `Info.plist nemá ${key}`);
}
requireMatch(project, /AlphaTradeNativePlugin\.swift in Sources/, 'Swift plugin není součástí Xcode targetu');
requireMatch(plugin, /CAPPluginMethod\(name: "setShellWorld"/, 'Swift plugin neregistruje synchronizaci LIVE/BACKTEST světa');
requireMatch(plugin, /CAPPluginMethod\(name: "shareText"/, 'Swift plugin neregistruje test systémového sdílení');
for (const method of ['getLiveActivityState', 'startLiveActivity', 'updateLiveActivity', 'endLiveActivity']) {
  requireMatch(plugin, new RegExp(`CAPPluginMethod\\(name: "${method}"`), `Swift plugin neregistruje ${method}`);
}
for (const method of ['updateWidgetSnapshot', 'clearWidgetSnapshot', 'setWidgetAccessToken', 'clearWidgetAccessToken']) {
  requireMatch(plugin, new RegExp(`CAPPluginMethod\\(name: "${method}"`), `Swift plugin neregistruje ${method}`);
}
requireMatch(plugin, /UserDefaults\(suiteName: widgetSuiteName\)/, 'Widget snapshot se neukládá do sdílené App Group');
requireMatch(plugin, /WidgetCenter\.shared\.reloadAllTimelines\(\)/, 'Zápis widget snapshotu neobnoví WidgetKit timeline');
requireMatch(plugin, /ActivityAuthorizationInfo\(\)\.areActivitiesEnabled/, 'Live Activity musí respektovat systémové povolení iOS');
requireMatch(plugin, /Activity<AlphaTradeLiveActivityAttributes>\.activities/, 'Live Activity nemá autoritativní ActivityKit stav');
requireMatch(plugin, /pushType: \.token/, 'Live Activity nevyžádá APNs token pro vzdálenou aktualizaci');
requireMatch(plugin, /"liveActivityPushToken"/, 'Live Activity nepředá APNs token bezpečnému webovému mostu');
requireMatch(plugin, /"liveActivityEnded"/, 'Live Activity nehlásí ukončení pro odstranění mrtvého APNs tokenu');
requireMatch(plugin, /CAPPluginMethod\(name: "presentCalendarEvent"/, 'Swift plugin neregistruje systémový editor Kalendáře');
requireMatch(plugin, /EKEventEditViewController\(\)/, 'Kalendářní událost musí otevřít systémový editor');
requireMatch(plugin, /eventEditViewController[\s\S]*didCompleteWith/, 'Swift plugin nevrací výsledek systémového editoru Kalendáře');
requireMatch(plugin, /Po zrušení\/neúspěchu[\s\S]*AlphaTradePrivacyShield\.shared\.hide\(\)/, 'Zrušené Face ID nesmí nechat nedostupný nativní štít nad retry tlačítkem');
requireMatch(plugin, /var result: JSObject = \[[\s\S]*"success": success[\s\S]*if let error/, 'Face ID výsledek nesmí posílat Swift Optional přes Capacitor most');
requireMatch(privacyGate, /autoAttemptedRef\.current = true[\s\S]*authenticateNativePrivacy\(\)/, 'Privacy gate musí automatický Face ID pokus spustit nejvýše jednou na jedno zamknutí');
requireMatch(privacyGate, /if \(!locked\) \{[\s\S]*autoAttemptedRef\.current = false/, 'Privacy gate musí nový automatický Face ID pokus povolit až po skutečném odemknutí');
requireMatch(plugin, /applyWorldFromWeb\(world\)/, 'Swift plugin nepředává LIVE/BACKTEST svět shellu');
requireMatch(shell, /__alphaTradeNative\?\.toggleWorld\(\)/, 'Nativní menu neumí přepnout LIVE/BACKTEST svět');
requireMatch(shell, /\("iOS funkce", "native-system"\)/, 'Nativní menu nemá přímou cestu k iOS funkcím');
requireMatch(appSource, /alphatrade:open-native-system/, 'Webový most neumí otevřít testovací sekci iOS funkcí');
requireMatch(shell, /AlphaTradeKeepAwake\.shared\.setWorld\(world\)/, 'Nativní shell nepředává LIVE/BACKTEST stav keep-awake vrstvě');
requireMatch(scene, /isEnabled && isApplicationActive && activeWorld == "live"/, 'Keep-awake musí být účinný pouze v aktivním LIVE světě');
requireMatch(plugin, /"effective": UIApplication\.shared\.isIdleTimerDisabled/, 'Keep-awake diagnostika musí vracet skutečný aktuální stav iOS');
requireMatch(plugin, /min\(max\(call\.getInt\("count"\) \?\? 0, 0\), 999\)/, 'Badge musí být omezený na bezpečný rozsah 0 až 999');
requireMatch(plugin, /UNUserNotificationCenter\.current\(\)\.setBadgeCount\(count\)/, 'Badge musí na moderním iOS používat UNUserNotificationCenter');
requireMatch(project, /PRODUCT_BUNDLE_IDENTIFIER = app\.alphatrade\.native;/, 'Xcode bundle identifier neodpovídá Capacitor appId');
requireMatch(project, /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/, 'App target nepoužívá placené APNs\/App Group entitlements');
requireMatch(project, /CODE_SIGN_ENTITLEMENTS = AlphaTradeWidgets\/AlphaTradeWidgets\.entitlements;/, 'Widget target nepoužívá App Group entitlements');
requireMatch(appEntitlements, /<key>aps-environment<\/key>/, 'App entitlements nemají APNs prostředí');
requireMatch(appEntitlements, /<string>group\.app\.alphatrade\.native<\/string>/, 'App target nemá sdílenou App Group');
requireMatch(widgetEntitlements, /<string>group\.app\.alphatrade\.native<\/string>/, 'Widget target nemá sdílenou App Group');
requireMatch(appDelegate, /capacitorDidRegisterForRemoteNotifications/, 'AppDelegate nepředává APNs token Capacitoru');
requireMatch(appDelegate, /capacitorDidFailToRegisterForRemoteNotifications/, 'AppDelegate nepředává chybu registrace APNs Capacitoru');
requireMatch(plugin, /CAPPluginMethod\(name: "getPushEnvironment"/, 'Swift plugin nehlásí APNs sandbox\/production prostředí');
requireMatch(packageJson, /"@capacitor\/push-notifications"/, 'Chybí oficiální Capacitor Push Notifications plugin');
requireMatch(project, /AlphaTradeWidgets\.appex in Embed App Extensions/, 'Widget extension není vložená do hlavní aplikace');
requireMatch(project, /PRODUCT_BUNDLE_IDENTIFIER = app\.alphatrade\.native\.widgets;/, 'Widget extension nemá očekávaný bundle identifier');
for (const kind of ['AlphaTradeToday', 'AlphaTradeDailyPnL', 'AlphaTradeEquity', 'AlphaTradeAccounts', 'AlphaTradeDiscipline', 'AlphaTradeTrades', 'AlphaTradeActions', 'AlphaTradeCopier', 'AlphaTradePositions', 'AlphaTradeLockPnL', 'AlphaTradeLockDiscipline', 'AlphaTradeLockLive']) {
  requireMatch(widgetSource, new RegExp(`kind: "${kind}"`), `Chybí widget ${kind}`);
}
for (const family of ['accessoryInline', 'accessoryCircular', 'accessoryRectangular']) {
  requireMatch(widgetSource, new RegExp(`\\.${family}`), `Lock Screen widgety nepodporují ${family}`);
}
requireMatch(widgetSource, /AccessoryWidgetBackground\(\)/, 'Kruhové Lock Screen widgety nemají adaptivní systémové pozadí');
requireMatch(widgetSource, /func alphaTradeLockSurface\(\)[\s\S]*containerBackground\(Color\.clear, for: \.widget\)/, 'Lock Screen widgety nemají povinné WidgetKit containerBackground');
requireMatch(appDelegate, /WidgetCenter\.shared\.reloadAllTimelines\(\)/, 'Aplikace po aktualizaci neobnoví staré WidgetKit snapshots');
requireMatch(appDelegate, /AlphaTradeAppShortcuts\.updateAppShortcutParameters\(\)/, 'Aplikace při startu neregistruje App Shortcuts pro Siri a Spotlight');
for (const kind of ['AlphaTradeLockPnL', 'AlphaTradeLockDiscipline', 'AlphaTradeLockLive']) {
  requireMatch(widgetSource, new RegExp(`kind: "${kind}"[\\s\\S]{0,320}alphaTradeLockSurface\\(\\)`), `Widget ${kind} nepoužívá Lock Screen containerBackground`);
}
const widgetRoutes = new Set([
  ...Array.from(widgetSource.matchAll(/alphatrade-native:\/\/([a-z-]+)/g), match => match[1]),
  ...Array.from(widgetSource.matchAll(/action\([^,]+,\s*[^,]+,\s*"([a-z-]+)"\)/g), match => match[1]),
]);
for (const route of widgetRoutes) {
  requireMatch(systemActions, new RegExp(`"${route}"`), `Widget používá nepodporovanou systémovou trasu ${route}`);
}
requireMatch(widgetSource, /AlphaTradeLockLive[\s\S]*alphatrade-native:\/\/live/, 'Lock Screen LIVE widget neotevírá LIVE route');
requireMatch(widgetSource, /ActivityConfiguration\(for: AlphaTradeLiveActivityAttributes\.self\)/, 'Widget extension nemá Live Activity konfiguraci');
requireMatch(widgetSource, /DynamicIsland[\s\S]*Read-only monitoring · žádná broker akce/, 'Live Activity nemá Dynamic Island nebo read-only bezpečnostní označení');
requireMatch(widgetSource, /AlphaTradeWidgetSnapshotV2/, 'Widget extension nečte živý snapshot z App Group');
requireMatch(widgetSource, /isLiveStale[\s\S]*30 \* 60_000/, 'LIVE widgety nemají nouzové varování při dlouho neobnoveném snapshotu');
requireMatch(widgetSource, /forHTTPHeaderField: "Authorization"/, 'WidgetKit neposílá autorizační hlavičku');
requireMatch(widgetSource, /Widget \\\(token\)/, 'WidgetKit neposílá omezený read-only token');
requireMatch(widgetSource, /native-widget-snapshot/, 'WidgetKit nemá serverový endpoint pro obnovu na pozadí');
requireMatch(widgetSource, /mergingRemote/, 'Vzdálená LIVE obnova nezachovává lokální deník');
requireMatch(widgetSource, /DATA ZASTARALÁ/, 'Copier widget nemá viditelné stale-data varování');
for (const kind of ['AlphaTradeControlLive', 'AlphaTradeControlCapture']) {
  requireMatch(widgetSource, new RegExp(`kind: "${kind}"`), `Chybí ovladač Ovládacího centra ${kind}`);
}
for (const intent of ['OpenAlphaTradeLiveControlIntent', 'OpenAlphaTradeCaptureControlIntent']) {
  requireMatch(controlIntents, new RegExp(`struct ${intent}: AppIntent`), `Chybí App Intent ${intent}`);
}
requireMatch(controlIntents, /#if ALPHATRADE_APP[\s\S]*AlphaTradeSystemRouter\.shared\.request\("live"\)/, 'LIVE control musí routovat pouze v hlavním procesu aplikace');
requireMatch(controlIntents, /AlphaTradeSystemRouter\.shared\.request\("capture"\)/, 'Capture control neotevírá kontrolovaný formulář obchodu');
requireMatch(project, /SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG ALPHATRADE_APP";/, 'Debug app target nemá oddělenou ALPHATRADE_APP větev');
requireMatch(project, /SWIFT_ACTIVE_COMPILATION_CONDITIONS = ALPHATRADE_APP;/, 'Release app target nemá oddělenou ALPHATRADE_APP větev');
const controlIntentSourceMemberships = project.match(/AlphaTradeControlIntents\.swift in Sources/g) ?? [];
if (controlIntentSourceMemberships.length < 4) {
  errors.push('Control App Intents musí být součástí app i widget targetu');
}
const liveActivitySourceMemberships = project.match(/AlphaTradeLiveActivityAttributes\.swift in Sources/g) ?? [];
if (liveActivitySourceMemberships.length < 4) {
  errors.push('ActivityAttributes schema musí být součástí app i widget targetu');
}
requireMatch(widgetPlist, /com\.apple\.widgetkit-extension/, 'Widget Info.plist nemá WidgetKit extension point');
requireMatch(shell, /registerPluginInstance\(AlphaTradeNativePlugin\(\)\)/, 'Nativní plugin není explicitně registrovaný jako instance');
requireMatch(shell, /final class AlphaTradeShellViewController: UIViewController, UITabBarDelegate/, 'Shell musí používat stabilní vlastní UITabBar mimo UITabBarController');
requireMatch(shell, /guard Thread\.isMainThread/, 'Změny nativního tématu musí být přesměrovány na main thread');
requireMatch(shell, /configureTabBarAppearance\(for: theme\)/, 'Změna tématu musí okamžitě přestavět vzhled spodní lišty');
requireMatch(plugin, /CAPPluginMethod\(name: "setShellTheme"/, 'Téma musí používat registrovaný Capacitor plugin most');
if (/messageHandlers\?\.alphaTradeShell|add\(self, name: "alphaTradeShell"\)/.test(shell)) {
  errors.push('Shell nesmí znovu použít nespolehlivý ruční WKScriptMessageHandler pro téma');
}
requireMatch(shell, /configureWithTransparentBackground\(\)/, 'Spodní lišta musí zůstat průhledná nad obsahem aplikace');
requireMatch(shell, /UIBlurEffect\(style: \.systemUltraThinMaterial\)/, 'Spodní lišta musí používat systémový materiál Liquid Glass');
requireMatch(shell, /view\.window\?\.backgroundColor = color/, 'Status-bar safe area musí sledovat aktivní téma');
requireMatch(shell, /bridgeController\.view\.bottomAnchor\.constraint\(equalTo: view\.bottomAnchor\)/, 'Webový obsah musí pokračovat pod průhlednou spodní lištu');
requireMatch(shell, /bridgeController\.view\.topAnchor\.constraint\(equalTo: view\.topAnchor\)/, 'WebView musí pokračovat pod status bar kvůli fullscreen přechodům');
requireMatch(shell, /contentInsetAdjustmentBehavior = \.never/, 'Safe area nesmí být započítaná UIKit i Reactem současně');
requireMatch(appSource, /paddingTop: 'env\(safe-area-inset-top\)'/, 'Běžný React obsah musí zůstat pod status barem');
requireMatch(stylesheet, /--native-shell-tab-bar-height:\s*calc\(49px \+ env\(safe-area-inset-bottom, 0px\)\)/, 'Webový modal nezná skutečnou výšku nativního tab baru');
requireMatch(appSource, /native-page-scroll-content/, 'Hlavní scroll aplikace nemá dosažitelný konec nad nativním tab barem');
requireMatch(stylesheet, /\.native-page-scroll-content[\s\S]*padding-bottom:[\s\S]*--native-shell-tab-bar-height/, 'Běžné stránky nemají spodní prostor pro průhledný tab bar');
requireMatch(appSource, /activePage === 'accounts'[\s\S]*activePage === 'live'[\s\S]*native-page-scroll-content-extra/, 'Účty a LIVE nemají dodatečný prostor pro poslední hustý řádek');
requireMatch(stylesheet, /\.native-page-scroll-content\.native-page-scroll-content-extra[\s\S]*padding-bottom:[\s\S]*3\.5rem/, 'Dodatečný prostor Účtů a LIVE neodpovídá jednomu mobilnímu řádku');
requireMatch(stylesheet, /:is\(\.native-modal-safe-area, \.fixed\.inset-0\.flex\)[\s\S]*padding-top:[\s\S]*safe-area-inset-top[\s\S]*padding-bottom:[\s\S]*--native-shell-tab-bar-height/, 'Všechny fullscreen dialogy musí chránit horní ovládání i spodní akce');
requireMatch(stylesheet, /\.native-modal-panel[\s\S]*max-height:\s*100%/, 'Dialogy s vh výškou musí respektovat skutečný safe-area rám');
requireMatch(stylesheet, /\.native-modal-safe-area:has\(\.overflow-y-auto\)[\s\S]*\.overflow-y-auto::after[\s\S]*--native-shell-tab-bar-height/, 'Fullscreen scroller musí pokračovat pod sklem a mít dosažitelný koncový spacer');
requireMatch(tradeDetail, /native-modal-safe-area fixed inset-0/, 'Detail obchodu musí používat nativní safe-area rám');
requireMatch(plugin, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/, 'Keychain session nemá device-only ochranu');
requireMatch(nativeStorage, /createNativeSecureAuthStorage/, 'Chybí nativní auth storage adaptér');
requireMatch(packageJson, /"build:native"/, 'Chybí npm build:native skript');

try {
  const icon = await stat(resolve(root, 'capacitor-ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
  if (icon.size < 100_000) errors.push('App icon vypadá jako placeholder nebo poškozený soubor');
} catch {
  errors.push('Chybí AppIcon asset');
}

if (errors.length > 0) {
  console.error('iOS doctor selhal:');
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}

console.log('iOS doctor: konfigurace, OAuth, Keychain, plugin, widgety, usage popisy a assety jsou konzistentní.');
