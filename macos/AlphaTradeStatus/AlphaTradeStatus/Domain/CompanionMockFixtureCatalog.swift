import Foundation

enum CompanionMockFixtureCatalog {
    static let orderedIDs: [CompanionFixtureID] = [
        .live,
        .liveAckUnavailable,
        .paused,
        .shadow,
        .disarmed,
        .disarmedExposure,
        .disarmedUnverified,
        .locked,
        .intervention,
        .unknown,
        .offline
    ]

    static var all: [CompanionPresentation] {
        orderedIDs.map { presentation(for: $0) }
    }

    static func presentation(for fixtureID: CompanionFixtureID) -> CompanionPresentation {
        switch fixtureID {
        case .live:
            return live(acknowledgementsAvailable: true)
        case .liveAckUnavailable:
            return live(acknowledgementsAvailable: false)
        case .paused:
            return paused()
        case .shadow:
            return shadow()
        case .disarmed:
            return disarmed()
        case .disarmedExposure:
            return disarmedExposure()
        case .disarmedUnverified:
            return disarmedUnverified()
        case .locked:
            return locked()
        case .intervention:
            return intervention()
        case .unknown:
            return unknown()
        case .offline:
            return offline()
        }
    }
}

private extension CompanionMockFixtureCatalog {
    static func live(acknowledgementsAvailable: Bool) -> CompanionPresentation {
        let fixtureID: CompanionFixtureID = acknowledgementsAvailable ? .live : .liveAckUnavailable
        let acknowledgementText = acknowledgementsAvailable
            ? "20/20 followerů"
            : "Potvrzení followerů nedostupné"
        let copySummary = acknowledgementsAvailable
            ? "20/20 · 12:52:44"
            : "2 pozice · potvrzení followerů nedostupné"

        let copying = StatusSectionPresentation(
            id: "copying",
            title: "Kopírování · 2 pozice",
            summary: copySummary,
            summaryTone: acknowledgementsAvailable ? .success : .warning,
            isInitiallyExpanded: true,
            hasProblem: false,
            rows: [
                .position(.init(
                    id: "mnq-live",
                    symbol: "MNQ",
                    side: .long,
                    quantity: 1,
                    detail: "\(acknowledgementText) · 12:47:03",
                    detailTone: acknowledgementsAvailable ? .success : .warning
                )),
                .position(.init(
                    id: "mes-live",
                    symbol: "MES",
                    side: .short,
                    quantity: 2,
                    detail: "\(acknowledgementText) · 12:52:41",
                    detailTone: acknowledgementsAvailable ? .success : .warning
                )),
                keyValue(
                    id: "last-copy",
                    label: "Poslední kopie",
                    value: "ENTRY MES ×2 · 12:52:41",
                    usesMonospacedValue: true
                ),
                keyValue(
                    id: "broker-verification",
                    label: "Ověřeno brokerem",
                    value: "12:52:44",
                    tone: .success,
                    usesMonospacedValue: true
                )
            ]
        )

        return CompanionPresentation(
            fixtureID: fixtureID,
            displayState: .live(minutesRemaining: 42),
            menuBar: .init(
                pillText: "LIVE",
                tone: .success,
                accessibilityLabel: "AlphaTrade, LIVE, zbývá 42 minut"
            ),
            freshness: .init(
                text: "Ověřeno před 2 s",
                tone: .success,
                accessibilityLabel: "Stav ověřen před dvěma sekundami"
            ),
            hero: .init(
                symbolName: "",
                title: "LIVE",
                badge: "42 min",
                detail: "Kopírování aktivní · 2 pozice · session vyprší ve 13:35",
                tone: .success
            ),
            banner: acknowledgementsAvailable ? nil : .init(
                symbolName: "exclamationmark.triangle.fill",
                text: "Kopírování běží, ale runtime neposkytuje per-follower potvrzení. Zobrazení proto nesmí tvrdit 20 z 20.",
                tone: .warning
            ),
            sections: [
                copying,
                cleanSafetySection(time: "12:52", initiallyExpanded: false),
                runtimeSection(heartbeatSeconds: 2, initiallyExpanded: false),
                snapshotsSection(lastEventLabel: "Poslední ENTRY snímek", time: "12:47")
            ],
            footer: calmFooter(),
            exposureEvidence: .verifiedExposure(verifiedAt: "12:52:44"),
            followerAcknowledgementEvidence: acknowledgementsAvailable
                ? .verified(confirmed: 20, total: 20, verifiedAt: "12:52:44")
                : .unavailable
        )
    }

    static func paused() -> CompanionPresentation {
        let base = live(acknowledgementsAvailable: false)
        let sections = base.sections.map { section in
            section.id == "safety"
                ? cleanSafetySection(time: "15:57", initiallyExpanded: true, accountCuts: 2)
                : section
        }

        return CompanionPresentation(
            fixtureID: .paused,
            displayState: .paused(minutesRemaining: 30),
            menuBar: .init(
                pillText: "PAUZA",
                symbolName: "pause.fill",
                tone: .warning,
                accessibilityLabel: "AlphaTrade, pauza do 16:20"
            ),
            freshness: base.freshness,
            hero: .init(
                symbolName: "pause.fill",
                title: "PAUZA",
                badge: nil,
                detail: "Pauza do 16:20 · denní ztráta",
                supportingText: "Copier zůstává LIVE. Nové vstupy se nekopírují; exity pokračují.",
                tone: .warning
            ),
            banner: base.banner,
            sections: sections,
            footer: base.footer,
            exposureEvidence: base.exposureEvidence,
            followerAcknowledgementEvidence: base.followerAcknowledgementEvidence
        )
    }

    static func shadow() -> CompanionPresentation {
        let leaderTracking = StatusSectionPresentation(
            id: "leader-tracking",
            title: "Sledování leadera",
            summary: "1 pozice leadera · 12:47:03",
            summaryTone: .neutral,
            isInitiallyExpanded: true,
            hasProblem: false,
            rows: [
                .position(.init(
                    id: "mnq-shadow",
                    symbol: "MNQ",
                    side: .long,
                    quantity: 1,
                    detail: "Jen sledováno · 12:47:03",
                    detailTone: .muted
                )),
                keyValue(
                    id: "last-shadow-signal",
                    label: "Poslední signál",
                    value: "ENTRY MNQ ×1 · 12:47:03",
                    usesMonospacedValue: true
                ),
                keyValue(
                    id: "configured-followers",
                    label: "Případná kopie",
                    value: "20 followerů nakonfigurováno · nic neodesláno",
                    tone: .muted
                )
            ]
        )

        return CompanionPresentation(
            fixtureID: .shadow,
            displayState: .shadow,
            menuBar: .init(
                pillText: "SHADOW",
                tone: .muted,
                accessibilityLabel: "AlphaTrade, SHADOW, jen sledování"
            ),
            freshness: .init(
                text: "Ověřeno před 4 s",
                tone: .success,
                accessibilityLabel: "Stav ověřen před čtyřmi sekundami"
            ),
            hero: .init(
                symbolName: "",
                title: "SHADOW",
                badge: "sleduje",
                detail: "Žádný příkaz se neodesílá · broker ověřil nulové pozice i working orders ve 12:44",
                tone: .muted
            ),
            banner: nil,
            sections: [
                leaderTracking,
                cleanSafetySection(time: "12:52", initiallyExpanded: false),
                runtimeSection(heartbeatSeconds: 4, initiallyExpanded: false),
                snapshotsSection(lastEventLabel: "Poslední ENTRY snímek", time: "12:47")
            ],
            footer: calmFooter(),
            exposureEvidence: .verifiedFlat(verifiedAt: "12:44"),
            followerAcknowledgementEvidence: .notApplicable
        )
    }

    static func disarmed() -> CompanionPresentation {
        CompanionPresentation(
            fixtureID: .disarmed,
            displayState: .disarmed,
            menuBar: .init(
                pillText: "VYPNUTO",
                symbolName: "power",
                tone: .neutral,
                accessibilityLabel: "AlphaTrade, copier vypnutý, flat ověřen"
            ),
            freshness: .init(
                text: "Ověřeno před 5 s",
                tone: .success,
                accessibilityLabel: "Stav ověřen před pěti sekundami"
            ),
            hero: .init(
                symbolName: "power",
                title: "VYPNUTO",
                badge: "flat ověřen",
                detail: "Copier je vypnutý · neposílá příkazy · broker ověřil nulové pozice i working orders ve 12:51",
                tone: .muted
            ),
            banner: nil,
            sections: [
                cleanSafetySection(time: "12:51", initiallyExpanded: false),
                verifiedFlatSection(),
                runtimeSection(heartbeatSeconds: 5, initiallyExpanded: false),
                snapshotsSection(lastEventLabel: "Poslední EXIT snímek", time: "12:47")
            ],
            footer: calmFooter(),
            exposureEvidence: .verifiedFlat(verifiedAt: "12:51:07"),
            followerAcknowledgementEvidence: .notApplicable
        )
    }

    static func disarmedExposure() -> CompanionPresentation {
        let safety = StatusSectionPresentation(
            id: "safety",
            title: "Bezpečnost",
            summary: "Fail-closed · expozice při vypnutém copieru",
            summaryTone: .danger,
            isInitiallyExpanded: true,
            hasProblem: true,
            rows: [
                keyValue(
                    id: "disarmed-exposure-conflict",
                    label: "Rozpor stavu",
                    value: "Copier neposílá příkazy, ale účet není flat",
                    tone: .danger
                ),
                keyValue(
                    id: "disarmed-reconciliation",
                    label: "Reconciliation",
                    value: "Vyžaduje kontrolu · 12:52",
                    tone: .danger
                )
            ]
        )
        let exposure = StatusSectionPresentation(
            id: "exposure",
            title: "Expozice",
            summary: "1 otevřená pozice · 12:52:12",
            summaryTone: .danger,
            isInitiallyExpanded: true,
            hasProblem: true,
            rows: [
                .position(.init(
                    id: "mnq-disarmed-exposure",
                    symbol: "MNQ",
                    side: .long,
                    quantity: 1,
                    detail: "Brokerem potvrzená expozice · 12:52:12",
                    detailTone: .danger
                )),
                keyValue(
                    id: "working-orders-disarmed-exposure",
                    label: "Účty s working orders",
                    value: "1 follower",
                    tone: .danger
                )
            ]
        )

        return CompanionPresentation(
            fixtureID: .disarmedExposure,
            displayState: .intervention(issueCount: 1),
            menuBar: .init(
                pillText: "!1",
                tone: .danger,
                accessibilityLabel: "AlphaTrade, zásah nutný, jeden problém"
            ),
            freshness: .init(
                text: "Ověřeno před 3 s",
                tone: .success,
                accessibilityLabel: "Problém ověřen před třemi sekundami"
            ),
            hero: .init(
                symbolName: "exclamationmark.triangle.fill",
                title: "ZÁSAH NUTNÝ",
                badge: "1 problém",
                detail: "Copier je vypnutý, ale broker potvrdil otevřenou expozici ve 12:52",
                tone: .danger
            ),
            banner: .init(
                symbolName: "hand.raised.fill",
                text: "VYPNUTO neznamená flat. Expozici vyřeš pouze v LIVE nebo u brokera, nikdy z tohoto panelu.",
                tone: .danger
            ),
            sections: [
                safety,
                exposure,
                runtimeSection(heartbeatSeconds: 3, initiallyExpanded: false),
                snapshotsSection(lastEventLabel: "Poslední ENTRY snímek", time: "12:47")
            ],
            footer: interventionFooter(issueCount: 1),
            exposureEvidence: .verifiedExposure(verifiedAt: "12:52:12"),
            followerAcknowledgementEvidence: .unavailable
        )
    }

    static func disarmedUnverified() -> CompanionPresentation {
        let exposure = StatusSectionPresentation(
            id: "exposure",
            title: "Expozice",
            summary: "Neověřeno · nelze tvrdit flat",
            summaryTone: .warning,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: [
                keyValue(
                    id: "unverified-positions",
                    label: "Otevřené pozice",
                    value: "Neověřeno",
                    tone: .warning
                ),
                keyValue(
                    id: "unverified-working-orders",
                    label: "Účty s working orders",
                    value: "Neověřeno",
                    tone: .warning
                ),
                keyValue(
                    id: "unverified-broker-check",
                    label: "Ověřeno brokerem",
                    value: "Nedostupné",
                    tone: .warning
                )
            ]
        )

        return CompanionPresentation(
            fixtureID: .disarmedUnverified,
            displayState: .disarmedUnverified,
            menuBar: .init(
                pillText: "VYPNUTO",
                symbolName: "power",
                tone: .danger,
                accessibilityLabel: "AlphaTrade, copier vypnutý"
            ),
            freshness: .init(
                text: "Ověřeno před 5 s",
                tone: .success,
                accessibilityLabel: "Stav ověřen před pěti sekundami"
            ),
            hero: .init(
                symbolName: "power",
                title: "VYPNUTO",
                badge: nil,
                detail: "Copier je vypnutý · neposílá příkazy · potvrzeno před 5 s",
                supportingText: "Expozice není brokerem ověřena — flat nelze tvrdit",
                tone: .danger
            ),
            banner: nil,
            sections: [
                cleanSafetySection(time: "12:51", initiallyExpanded: false),
                exposure,
                runtimeSection(heartbeatSeconds: 5, initiallyExpanded: false),
                snapshotsSection(lastEventLabel: "Poslední EXIT snímek", time: "12:47")
            ],
            footer: disarmedUnverifiedFooter(),
            exposureEvidence: .unverified,
            followerAcknowledgementEvidence: .notApplicable
        )
    }

    static func locked() -> CompanionPresentation {
        let dailyRules = StatusSectionPresentation(
            id: "daily-rules",
            title: "Pravidla dne",
            summary: "1 pravidlo spuštěno",
            summaryTone: .danger,
            isInitiallyExpanded: true,
            hasProblem: true,
            rows: [
                progress(
                    id: "rule-losing-trades",
                    label: "Ztrátové obchody",
                    value: "2 / 2 · spustilo lock",
                    progress: 1,
                    tone: .danger
                ),
                progress(
                    id: "rule-daily-loss",
                    label: "Denní ztráta",
                    value: "−620 / 1 000 USD",
                    progress: 0.62,
                    tone: .warning
                ),
                progress(
                    id: "rule-max-trades",
                    label: "Obchody dnes",
                    value: "4 / 10",
                    progress: 0.4,
                    tone: .success
                ),
                keyValue(
                    id: "rule-window",
                    label: "Obchodní okno",
                    value: "15:30–22:00",
                    tone: .success,
                    usesMonospacedValue: true
                ),
                keyValue(
                    id: "rule-cooldown",
                    label: "Cooldown po uzavření",
                    value: "do 16:07 · 3 min",
                    tone: .warning
                )
            ]
        )

        return CompanionPresentation(
            fixtureID: .locked,
            displayState: .locked,
            menuBar: .init(
                pillText: "ZAMČENO",
                symbolName: "lock.fill",
                tone: .danger,
                accessibilityLabel: "AlphaTrade, den zamčený do 00:00"
            ),
            freshness: .init(
                text: "Ověřeno před 3 s",
                tone: .success,
                accessibilityLabel: "Stav ověřen před třemi sekundami"
            ),
            hero: .init(
                symbolName: "lock.fill",
                title: "DEN ZAMČENÝ",
                badge: "do 00:00",
                detail: "Automaticky v 15:52 · pravidlo 2 ztrátové obchody z 2",
                supportingText: "Copier vypnutý, zapnutí blokované do konce session. Zámek skončí s koncem session (00:00 Chicago)",
                tone: .danger
            ),
            banner: nil,
            sections: [
                dailyRules,
                cleanSafetySection(time: "15:52", initiallyExpanded: false),
                runtimeSection(heartbeatSeconds: 3, initiallyExpanded: false),
                snapshotsSection(lastEventLabel: "Poslední EXIT snímek", time: "15:52")
            ],
            footer: calmFooter(),
            exposureEvidence: .unverified,
            followerAcknowledgementEvidence: .notApplicable
        )
    }

    static func intervention() -> CompanionPresentation {
        let safety = StatusSectionPresentation(
            id: "safety",
            title: "Bezpečnost",
            summary: "2 problémy · 12:49",
            summaryTone: .danger,
            isInitiallyExpanded: true,
            hasProblem: true,
            rows: [
                keyValue(
                    id: "divergence",
                    label: "Divergence",
                    value: "MNQ · APEX-2 · +1 kontrakt",
                    tone: .danger,
                    usesMonospacedValue: true
                ),
                keyValue(
                    id: "outbox",
                    label: "Outbox",
                    value: "1 příkaz stuck · 4 min",
                    tone: .danger
                ),
                keyValue(
                    id: "reconciliation-review",
                    label: "Reconciliation",
                    value: "Vyžaduje kontrolu · 12:49",
                    tone: .danger
                ),
                keyValue(id: "cooldown", label: "Cooldown / Day-lock", value: "Neaktivní"),
                keyValue(id: "kill-switch", label: "Kill switch", value: "Připraven")
            ]
        )
        let exposure = StatusSectionPresentation(
            id: "exposure",
            title: "Expozice",
            summary: "19/20 · 12:52:12",
            summaryTone: .danger,
            isInitiallyExpanded: true,
            hasProblem: true,
            rows: [
                .position(.init(
                    id: "mnq-intervention",
                    symbol: "MNQ",
                    side: .long,
                    quantity: 1,
                    detail: "19/20 followerů · 12:52:12",
                    detailTone: .danger
                )),
                keyValue(
                    id: "failing-account",
                    label: "APEX-2",
                    value: "ENTRY nepotvrzeno · 4 min",
                    tone: .danger
                ),
                keyValue(
                    id: "accounts-with-orders",
                    label: "Účty s working orders",
                    value: "1 follower",
                    tone: .danger
                )
            ]
        )
        let runtime = StatusSectionPresentation(
            id: "runtime",
            title: "Copier runtime",
            summary: "Tento Mac · HB 3 s",
            summaryTone: .success,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: runtimeRows(heartbeatSeconds: 3) + [
                keyValue(
                    id: "live-session",
                    label: "LIVE session",
                    value: "Pozastaveno fail-closed",
                    tone: .danger
                )
            ]
        )

        return CompanionPresentation(
            fixtureID: .intervention,
            displayState: .intervention(issueCount: 2),
            menuBar: .init(
                pillText: "!2",
                tone: .danger,
                accessibilityLabel: "AlphaTrade, zásah nutný, dva problémy"
            ),
            freshness: .init(
                text: "Ověřeno před 3 s",
                tone: .success,
                accessibilityLabel: "Problém ověřen před třemi sekundami"
            ),
            hero: .init(
                symbolName: "exclamationmark.triangle.fill",
                title: "ZÁSAH NUTNÝ",
                badge: "2 problémy",
                detail: "2 bezpečnostní problémy · copier přešel do fail-closed režimu ve 12:49",
                tone: .danger
            ),
            banner: .init(
                symbolName: "hand.raised.fill",
                text: "Divergence se nikdy neopravuje obchodem z tohoto panelu. Otevři LIVE a zkontroluj skutečný stav u brokera.",
                tone: .danger
            ),
            sections: [
                safety,
                exposure,
                runtime,
                snapshotsSection(lastEventLabel: "Poslední ENTRY snímek", time: "12:47")
            ],
            footer: interventionFooter(issueCount: 2),
            exposureEvidence: .verifiedExposure(verifiedAt: "12:52:12"),
            followerAcknowledgementEvidence: .verified(confirmed: 19, total: 20, verifiedAt: "12:52:12")
        )
    }

    static func unknown() -> CompanionPresentation {
        let lastKnown = StatusSectionPresentation(
            id: "last-known",
            title: "Poslední známé hodnoty · naposledy 12:52",
            summary: "Čisté · neaktuální",
            summaryTone: .warning,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: [
                keyValue(id: "last-location", label: "Umístění", value: "Tento Mac"),
                keyValue(id: "last-broker", label: "Broker spojení", value: "Připojeno · naposledy 12:52"),
                keyValue(id: "last-reconciliation", label: "Reconciliation", value: "Čistá · naposledy 12:51"),
                keyValue(id: "last-divergence", label: "Divergence", value: "Žádná · naposledy 12:52"),
                keyValue(id: "last-outbox", label: "Outbox", value: "Prázdný · naposledy 12:52")
            ]
        )

        return CompanionPresentation(
            fixtureID: .unknown,
            displayState: .unknown,
            menuBar: .init(
                pillText: "?",
                tone: .warning,
                accessibilityLabel: "AlphaTrade, stav neznámý"
            ),
            freshness: .init(
                text: "Bez nových dat 43 s",
                tone: .warning,
                accessibilityLabel: "Bez nových dat čtyřicet tři sekund"
            ),
            hero: .init(
                symbolName: "questionmark",
                title: "STAV NEZNÁMÝ",
                badge: nil,
                detail: "Naposledy potvrzeno LIVE ve 12:52 · od té doby žádné potvrzení",
                tone: .warning
            ),
            banner: .init(
                symbolName: "exclamationmark.triangle.fill",
                text: "Poslední známé hodnoty nejsou aktuální. Nevyvozuj z nich současnou expozici ani stav copieru.",
                tone: .warning
            ),
            sections: [
                lastKnown,
                staleExposureSection(summaryTone: .warning),
                staleSnapshotsSection(summaryTone: .warning)
            ],
            footer: unknownFooter(primaryTone: .warning),
            exposureEvidence: .unverified,
            followerAcknowledgementEvidence: .unavailable
        )
    }

    static func offline() -> CompanionPresentation {
        let lastKnown = StatusSectionPresentation(
            id: "last-known",
            title: "Poslední známé hodnoty · naposledy 12:52",
            summary: "Bez HB · LIVE 12:52",
            summaryTone: .danger,
            isInitiallyExpanded: true,
            hasProblem: true,
            rows: [
                keyValue(id: "offline-location", label: "Poslední umístění", value: "Tento Mac"),
                keyValue(id: "offline-broker", label: "Broker spojení", value: "Nyní neověřeno", tone: .danger),
                keyValue(id: "offline-heartbeat", label: "Worker heartbeat", value: "Naposledy 12:52", tone: .danger),
                keyValue(id: "offline-reconciliation", label: "Reconciliation", value: "Nyní neověřeno", tone: .danger)
            ]
        )

        return CompanionPresentation(
            fixtureID: .offline,
            displayState: .offline,
            menuBar: .init(
                pillText: "!1",
                tone: .danger,
                accessibilityLabel: "AlphaTrade, worker offline"
            ),
            freshness: .init(
                text: "Bez heartbeat 2 min 18 s",
                tone: .danger,
                accessibilityLabel: "Worker je bez heartbeat dvě minuty osmnáct sekund"
            ),
            hero: .init(
                symbolName: "wifi.slash",
                title: "WORKER OFFLINE",
                badge: nil,
                detail: "Naposledy potvrzeno LIVE ve 12:52 · heartbeat překročil 90 sekund",
                tone: .danger
            ),
            banner: .init(
                symbolName: "exclamationmark.triangle.fill",
                text: "Worker je offline. Poslední známé hodnoty nejsou aktuální a nesmí se vydávat za současný stav.",
                tone: .danger
            ),
            sections: [
                lastKnown,
                staleExposureSection(summaryTone: .danger),
                staleSnapshotsSection(summaryTone: .danger)
            ],
            footer: unknownFooter(primaryTone: .danger),
            exposureEvidence: .unverified,
            followerAcknowledgementEvidence: .unavailable
        )
    }

    static func cleanSafetySection(
        time: String,
        initiallyExpanded: Bool,
        accountCuts: Int = 0
    ) -> StatusSectionPresentation {
        StatusSectionPresentation(
            id: "safety",
            title: "Bezpečnost",
            summary: "Vše čisté · \(time)",
            summaryTone: .success,
            isInitiallyExpanded: initiallyExpanded,
            hasProblem: false,
            rows: [
                keyValue(id: "reconciliation", label: "Reconciliation", value: "Čistá · \(time)", tone: .success),
                keyValue(id: "divergence", label: "Divergence", value: "Žádná", tone: .success),
                keyValue(id: "outbox", label: "Outbox", value: "Prázdný", tone: .success),
                keyValue(id: "cooldown", label: "Cooldown / Day-lock", value: "Neaktivní"),
                keyValue(
                    id: "account-cuts",
                    label: "Vyřazené účty",
                    value: String(accountCuts),
                    tone: accountCuts > 0 ? .danger : .neutral
                ),
                keyValue(id: "kill-switch", label: "Kill switch", value: "Připraven")
            ]
        )
    }

    static func verifiedFlatSection() -> StatusSectionPresentation {
        StatusSectionPresentation(
            id: "exposure",
            title: "Expozice",
            summary: "Flat ověřen · 12:51:07",
            summaryTone: .success,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: [
                keyValue(id: "open-position", label: "Otevřená pozice", value: "Žádná", tone: .success),
                keyValue(id: "verified-at", label: "Ověřeno brokerem", value: "12:51:07", tone: .success, usesMonospacedValue: true),
                keyValue(id: "accounts-with-working-orders", label: "Účty s working orders", value: "Žádné", tone: .success)
            ]
        )
    }

    static func runtimeSection(heartbeatSeconds: Int, initiallyExpanded: Bool) -> StatusSectionPresentation {
        StatusSectionPresentation(
            id: "runtime",
            title: "Copier runtime",
            summary: "Tento Mac · HB \(heartbeatSeconds) s",
            summaryTone: .success,
            isInitiallyExpanded: initiallyExpanded,
            hasProblem: false,
            rows: runtimeRows(heartbeatSeconds: heartbeatSeconds)
        )
    }

    static func runtimeRows(heartbeatSeconds: Int) -> [SectionRowPresentation] {
        [
            keyValue(id: "location", label: "Umístění", value: "Tento Mac"),
            keyValue(id: "broker-connection", label: "Broker spojení", value: "Připojeno", tone: .success),
            keyValue(id: "worker-heartbeat", label: "Worker heartbeat", value: "před \(heartbeatSeconds) s", tone: .success)
        ]
    }

    static func snapshotsSection(lastEventLabel: String, time: String) -> StatusSectionPresentation {
        StatusSectionPresentation(
            id: "snapshots",
            title: "Snímky TradingView",
            summary: "OK · \(time)",
            summaryTone: .success,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: [
                keyValue(id: "cdp", label: "CDP", value: "Připraveno", tone: .success),
                keyValue(id: "last-snapshot", label: lastEventLabel, value: time, usesMonospacedValue: true)
            ]
        )
    }

    static func staleExposureSection(summaryTone: StatusTone) -> StatusSectionPresentation {
        StatusSectionPresentation(
            id: "exposure",
            title: "Expozice · naposledy 12:52",
            summary: "2 pozice · poslední snapshot",
            summaryTone: summaryTone,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: [
                keyValue(id: "stale-open-positions", label: "Poslední otevřené pozice", value: "MNQ ×1 · MES ×2", usesMonospacedValue: true),
                keyValue(id: "stale-current-exposure", label: "Současná expozice", value: "Neověřeno", tone: summaryTone),
                keyValue(id: "stale-working-orders", label: "Současné working orders", value: "Neověřeno", tone: summaryTone)
            ]
        )
    }

    static func staleSnapshotsSection(summaryTone: StatusTone) -> StatusSectionPresentation {
        StatusSectionPresentation(
            id: "snapshots",
            title: "Snímky TradingView · naposledy 12:52",
            summary: "OK · poslední 12:47",
            summaryTone: summaryTone,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: [
                keyValue(id: "stale-cdp", label: "CDP", value: "Nyní neověřeno", tone: summaryTone),
                keyValue(id: "stale-last-entry", label: "Poslední ENTRY snímek", value: "12:47", usesMonospacedValue: true)
            ]
        )
    }

    static func calmFooter() -> FooterPresentation {
        FooterPresentation(
            actions: [
                .init(
                    id: .openLive,
                    title: "Otevřít LIVE",
                    symbolName: nil,
                    style: .primary,
                    tone: .success,
                    destination: .live,
                    accessibilityLabel: "Otevřít AlphaTrade LIVE"
                ),
                .init(
                    id: .openJournal,
                    title: "Deník",
                    symbolName: nil,
                    style: .secondary,
                    tone: .neutral,
                    destination: .journal,
                    accessibilityLabel: "Otevřít AlphaTrade deník"
                ),
                refreshAction(style: .icon, tone: .neutral),
                diagnosticsAction()
            ],
            sourceNote: "Fáze 1 · ukázková data · pouze ke čtení"
        )
    }

    static func interventionFooter(issueCount: Int) -> FooterPresentation {
        FooterPresentation(
            actions: [
                .init(
                    id: .openLive,
                    title: "Otevřít LIVE — vyřešit",
                    symbolName: nil,
                    style: .primary,
                    tone: .danger,
                    destination: .live,
                    accessibilityLabel: "Otevřít AlphaTrade LIVE a zkontrolovat \(issueCount) problémů"
                ),
                refreshAction(style: .icon, tone: .danger),
                diagnosticsAction()
            ],
            sourceNote: "Fáze 1 · ukázková data · panel nic neovládá"
        )
    }

    static func disarmedUnverifiedFooter() -> FooterPresentation {
        FooterPresentation(
            actions: [
                .init(
                    id: .openLive,
                    title: "Zapnout v LIVE",
                    symbolName: nil,
                    style: .primary,
                    tone: .danger,
                    destination: .liveOverview,
                    accessibilityLabel: "Otevřít LIVE ovládání copieru"
                ),
                .init(
                    id: .openJournal,
                    title: "Deník",
                    symbolName: nil,
                    style: .secondary,
                    tone: .neutral,
                    destination: .journal,
                    accessibilityLabel: "Otevřít AlphaTrade deník"
                ),
                refreshAction(style: .icon, tone: .neutral),
                diagnosticsAction()
            ],
            sourceNote: "Fáze 1 · ukázková data · zapnutí je dostupné pouze v LIVE"
        )
    }

    static func unknownFooter(primaryTone: StatusTone) -> FooterPresentation {
        FooterPresentation(
            actions: [
                refreshAction(style: .primary, tone: primaryTone),
                .init(
                    id: .openLive,
                    title: "Otevřít LIVE",
                    symbolName: nil,
                    style: .secondary,
                    tone: .neutral,
                    destination: .live,
                    accessibilityLabel: "Otevřít AlphaTrade LIVE"
                ),
                diagnosticsAction()
            ],
            sourceNote: "Fáze 1 · ukázková data · poslední stav není aktuální"
        )
    }

    static func refreshAction(style: FooterActionStyle, tone: StatusTone) -> FooterActionPresentation {
        .init(
            id: .refresh,
            title: style == .primary ? "Obnovit stav" : "Obnovit",
            symbolName: "arrow.clockwise",
            style: style,
            tone: tone,
            destination: nil,
            accessibilityLabel: "Obnovit ukázkový stav"
        )
    }

    static func diagnosticsAction() -> FooterActionPresentation {
        .init(
            id: .copyDiagnostics,
            title: "Diagnostika",
            symbolName: "doc.on.doc",
            style: .icon,
            tone: .neutral,
            destination: nil,
            accessibilityLabel: "Zkopírovat bezpečnou diagnostiku"
        )
    }

    static func keyValue(
        id: String,
        label: String,
        value: String,
        detail: String? = nil,
        tone: StatusTone = .neutral,
        usesMonospacedValue: Bool = false
    ) -> SectionRowPresentation {
        .keyValue(.init(
            id: id,
            label: label,
            value: value,
            detail: detail,
            tone: tone,
            usesMonospacedValue: usesMonospacedValue
        ))
    }

    static func progress(
        id: String,
        label: String,
        value: String,
        progress: Double,
        tone: StatusTone
    ) -> SectionRowPresentation {
        .progress(.init(
            id: id,
            label: label,
            value: value,
            progress: progress,
            tone: tone
        ))
    }
}
