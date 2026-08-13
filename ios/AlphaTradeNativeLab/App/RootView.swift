import CoreSpotlight
import SwiftUI
import UIKit
import UserNotifications

struct RootView: View {
    @Environment(NativeLabStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var didScheduleLaunchRichDemo = false
    @State private var isMorePresented = false
    @State private var isFilterPresented = false

    var body: some View {
        @Bindable var store = store
        Group {
            if store.privacyMode {
                PrivacyShieldView()
            } else {
                NavigationStack {
                    AlphaTradeShell(isMorePresented: $isMorePresented, isFilterPresented: $isFilterPresented) {
                        selectedContent(store.selectedTab)
                    }
                    .toolbar(.hidden, for: .navigationBar)
                }
            }
        }
        .sheet(isPresented: $store.isQuickCapturePresented) { QuickCaptureView() }
        .sheet(isPresented: $isMorePresented) { MoreMenuView(isPresented: $isMorePresented) }
        .sheet(isPresented: $isFilterPresented) { DashboardFilterView(isPresented: $isFilterPresented) }
        .task {
            store.handlePendingSystemAction()
            await store.restoreRemoteSession()
            await SearchableIndexService.index(trades: store.trades)
            if ProcessInfo.processInfo.arguments.contains("-schedule-rich-notification"), !didScheduleLaunchRichDemo {
                didScheduleLaunchRichDemo = true
                let notifications = NativeNotificationService()
                await notifications.refresh()
                await notifications.schedule(.tradeScreenshot)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                store.handlePendingSystemAction()
                Task { try? await UNUserNotificationCenter.current().setBadgeCount(0) }
            } else if phase == .background {
                store.privacyMode = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .nativeLabRouteQueued)) { _ in store.handlePendingSystemAction() }
        .onOpenURL { url in NativeLabRoute.from(url: url)?.queue() }
        .onContinueUserActivity(CSSearchableItemActionType) { activity in
            store.handleSpotlightTrade(SearchableIndexService.tradeID(from: activity))
        }
    }

    @ViewBuilder
    private func selectedContent(_ tab: AppTab) -> some View {
        switch tab {
        case .today: TodayView()
        case .history: HistoryView()
        case .journal: JournalView()
        case .coach: CoachView()
        case .replay: ReplayView()
        case .live: LiveView()
        case .lab: NativeCapabilityLabView()
        case .settings: NativeSettingsView()
        }
    }
}

private struct AlphaTradeShell<Content: View>: View {
    @Environment(NativeLabStore.self) private var store
    @Binding var isMorePresented: Bool
    @Binding var isFilterPresented: Bool
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            AlphaTradeHeader(title: store.selectedTab.title, isFilterPresented: $isFilterPresented)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 10)
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .tradeScreen()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AlphaTradeBottomBar(isMorePresented: $isMorePresented)
                .padding(.horizontal, 12)
                .padding(.top, 7)
                .padding(.bottom, 5)
        }
    }
}

private struct AlphaTradeHeader: View {
    @Environment(NativeLabStore.self) private var store
    let title: String
    @Binding var isFilterPresented: Bool

    var body: some View {
        HStack(spacing: 12) {
            AlphaTradeLogo()
                .frame(width: 36, height: 36)
            Text(title.uppercased())
                .font(.system(size: 19, weight: .black, design: .rounded))
                .tracking(-0.6)
            Spacer()
            Button { isFilterPresented = true } label: { Image(systemName: "line.3.horizontal.decrease") }
                .accessibilityLabel("Filtrovat data a nástroje")
                .accessibilityIdentifier("dashboard.filter")
            Button { store.privacyMode = true } label: { Image(systemName: "sun.max") }
                .accessibilityLabel("Zapnout Privacy Mode")
                .accessibilityIdentifier("privacy.toggle")
        }
        .foregroundStyle(TradeTheme.primary)
        .padding(.horizontal, 12)
        .frame(height: 52)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.9)) }
        .shadow(color: Color.black.opacity(0.07), radius: 16, y: 7)
    }
}

private struct DashboardFilterView: View {
    @Environment(NativeLabStore.self) private var store
    @Binding var isPresented: Bool

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            Form {
                Section("Období dashboardu") {
                    Picker("Období", selection: $store.dashboardRange) {
                        ForEach(DashboardRange.allCases) { range in Text(range.title).tag(range) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section {
                    HStack {
                        Text("Zobrazené obchody")
                        Spacer()
                        Text("\(store.dashboardTrades.count)").foregroundStyle(TradeTheme.secondary)
                    }
                    HStack {
                        Text("Zdroj")
                        Spacer()
                        Text(store.remoteConnection.title).foregroundStyle(TradeTheme.secondary)
                    }
                }
            }
            .navigationTitle("Filtry")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Hotovo") { isPresented = false } } }
        }
        .presentationDetents([.medium])
    }
}

private struct AlphaTradeLogo: View {
    var body: some View {
        if let path = Bundle.main.path(forResource: "at_logo_light_clean", ofType: "png"),
           let image = UIImage(contentsOfFile: path) {
            Image(uiImage: image).resizable().scaledToFit()
        } else {
            Text("AT")
                .font(.system(size: 15, weight: .black, design: .rounded).italic())
                .foregroundStyle(TradeTheme.success)
        }
    }
}

private struct AlphaTradeBottomBar: View {
    @Environment(NativeLabStore.self) private var store
    @Binding var isMorePresented: Bool

    var body: some View {
        HStack(spacing: 0) {
            nav(.today)
            nav(.history)
            Button { store.isQuickCapturePresented = true } label: {
                VStack(spacing: 4) {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .medium))
                        .frame(width: 42, height: 42)
                        .foregroundStyle(TradeTheme.success)
                        .background(TradeTheme.success.opacity(0.08), in: RoundedRectangle(cornerRadius: 13))
                        .overlay { RoundedRectangle(cornerRadius: 13).stroke(TradeTheme.success, lineWidth: 1.6) }
                    Text("ZAPSAT").font(.system(size: 8, weight: .bold)).tracking(0.8)
                }
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .offset(y: -8)
            .accessibilityIdentifier("quick.capture")
            nav(.journal)
            nav(.coach)
            Button { isMorePresented = true } label: {
                tabLabel(title: "VÍCE", symbol: "ellipsis", active: [.replay, .live, .lab, .settings].contains(store.selectedTab))
            }
            .buttonStyle(.plain).frame(maxWidth: .infinity).accessibilityIdentifier("nav.more")
        }
        .padding(.horizontal, 5)
        .padding(.top, 9)
        .frame(height: 72)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 16).stroke(Color.white.opacity(0.9)) }
        .shadow(color: Color.black.opacity(0.08), radius: 18, y: 4)
    }

    private func nav(_ tab: AppTab) -> some View {
        Button { store.navigate(to: tab) } label: {
            tabLabel(title: tab.title.uppercased(), symbol: tab.symbol, active: store.selectedTab == tab)
        }
        .buttonStyle(.plain).frame(maxWidth: .infinity).accessibilityIdentifier("nav.\(tab.rawValue)")
    }

    private func tabLabel(title: String, symbol: String, active: Bool) -> some View {
        VStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 17, weight: active ? .semibold : .regular))
            Text(title).font(.system(size: 7.5, weight: .bold)).tracking(0.55).lineLimit(1).minimumScaleFactor(0.7)
        }
        .foregroundStyle(active ? TradeTheme.primary : TradeTheme.muted)
        .frame(maxWidth: .infinity)
    }
}

private struct MoreMenuView: View {
    @Environment(NativeLabStore.self) private var store
    @Binding var isPresented: Bool
    private let items: [(AppTab, String)] = [(.live, "Zpět na LIVE"), (.replay, "Lab"), (.journal, "Session"), (.settings, "Nastavení"), (.lab, "iOS funkce")]

    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                ForEach(items, id: \.0) { tab, label in
                    Button {
                        store.navigate(to: tab)
                        isPresented = false
                    } label: {
                        HStack(spacing: 13) {
                            Image(systemName: tab.symbol).frame(width: 26).foregroundStyle(TradeTheme.blue)
                            Text(label).font(.headline)
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(TradeTheme.muted)
                        }
                        .padding(16).background(TradeTheme.card, in: RoundedRectangle(cornerRadius: 8))
                    }.buttonStyle(.plain).accessibilityIdentifier("more.\(tab.rawValue)")
                }
                Spacer()
            }
            .padding(16).tradeScreen().navigationTitle("Více")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Hotovo") { isPresented = false } } }
        }
        .presentationDetents([.medium])
    }
}

struct NativeSettingsView: View {
    @Environment(NativeLabStore.self) private var store
    @State private var email = ""
    @State private var password = ""
    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                remoteConnection
                TradeCard { setting("Vzhled", "AlphaTrade Light", "paintbrush") }
                TradeCard { setting("Soukromí", "Face ID při návratu", "faceid") }
                TradeCard { setting("Notifikace", "Testovací galerie v Lab", "bell.badge") }
                TradeCard {
                    Button { store.navigate(to: .lab) } label: {
                        setting("Nativní Lab", "Widgety, Live Activity, OCR a další", "scope")
                    }.buttonStyle(.plain)
                }
            }.padding(16)
        }.tradeScreen()
    }

    private var remoteConnection: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("AlphaTrade data", systemImage: "externaldrive.connected.to.line.below")
                        .font(.headline)
                    Spacer()
                    StatusPill(text: store.remoteConnection.title.uppercased(), color: remoteColor)
                }
                switch store.remoteConnection {
                case .connected(let email):
                    Text(email).font(.caption).foregroundStyle(TradeTheme.secondary)
                    Button("Odpojit nativní aplikaci", role: .destructive) { Task { await store.signOutRemote() } }
                        .buttonStyle(.bordered)
                default:
                    TextField("E-mail", text: $email).textContentType(.username).textInputAutocapitalization(.never)
                        .textFieldStyle(.roundedBorder)
                    SecureField("Heslo", text: $password).textContentType(.password).textFieldStyle(.roundedBorder)
                    Button {
                        Task { await store.signIn(email: email, password: password); password = "" }
                    } label: {
                        Label(store.remoteConnection == .connecting ? "Připojuji…" : "Připojit skutečná data", systemImage: "lock.shield")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).tint(TradeTheme.blue)
                    .disabled(email.isEmpty || password.isEmpty || store.remoteConnection == .connecting)
                    if case .error(let message) = store.remoteConnection {
                        Text(message).font(.caption).foregroundStyle(TradeTheme.danger)
                    }
                    Label("Session je uložená v iOS Keychainu. Přístup je omezený pravidly tvého AlphaTrade účtu.", systemImage: "key.fill")
                        .font(.caption2).foregroundStyle(TradeTheme.secondary)
                }
            }
        }
    }

    private var remoteColor: Color {
        switch store.remoteConnection {
        case .connected: TradeTheme.success
        case .connecting: TradeTheme.blue
        case .error: TradeTheme.danger
        case .local: TradeTheme.warning
        }
    }

    private func setting(_ title: String, _ detail: String, _ symbol: String) -> some View {
        HStack { Image(systemName: symbol).foregroundStyle(TradeTheme.blue).frame(width: 28); VStack(alignment: .leading) { Text(title).font(.headline); Text(detail).font(.caption).foregroundStyle(TradeTheme.secondary) }; Spacer() }
    }
}

struct PrivacyShieldView: View {
    @Environment(NativeLabStore.self) private var store
    var body: some View {
        ZStack {
            TradeTheme.page.ignoresSafeArea()
            VStack(spacing: 18) {
                Image(systemName: "eye.slash.fill").font(.system(size: 34)).foregroundStyle(TradeTheme.blue)
                Text("Citlivá data jsou skrytá").font(.title3.bold())
                Text("Privacy Mode chrání P&L, účty a poznámky.").font(.subheadline).foregroundStyle(TradeTheme.secondary)
                Button("Odemknout přes Face ID") {
                    Task { if await BiometricGate.authenticate() { store.privacyMode = false; store.handlePendingSystemAction() } }
                }
                .buttonStyle(.borderedProminent).tint(TradeTheme.blue).accessibilityIdentifier("privacy.unlock")
            }.multilineTextAlignment(.center).padding(32)
        }
    }
}
