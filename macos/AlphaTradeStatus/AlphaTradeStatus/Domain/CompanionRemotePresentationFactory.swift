import Foundation

enum CompanionRemotePresentationFactory {
    static func make(
        from reduced: ReducedCompanionStatus,
        now: Date
    ) -> CompanionPresentation {
        let status = reduced.status
        let freshness = freshnessPresentation(reduced.freshness)

        switch reduced.displayState {
        case .live(let minutesRemaining):
            return live(
                status: status,
                reduced: reduced,
                freshness: freshness,
                minutesRemaining: minutesRemaining,
                now: now
            )
        case .shadow:
            return shadow(status: status, reduced: reduced, freshness: freshness)
        case .disarmed:
            return disarmed(status: status, reduced: reduced, freshness: freshness)
        case .disarmedUnverified:
            return disarmedUnverified(
                status: status,
                reduced: reduced,
                freshness: freshness
            )
        case .intervention(let issueCount):
            return intervention(
                status: status,
                reduced: reduced,
                freshness: freshness,
                issueCount: issueCount
            )
        case .unknown:
            if case .verified = reduced.freshness {
                return verifiedUnknown(status: status, reduced: reduced, freshness: freshness)
            }
            return stale(status: status, reduced: reduced, freshness: freshness, offline: false)
        case .offline:
            return stale(status: status, reduced: reduced, freshness: freshness, offline: true)
        }
    }
}

private extension CompanionRemotePresentationFactory {
    static func live(
        status: MacCompanionStatusDTO,
        reduced: ReducedCompanionStatus,
        freshness: FreshnessPresentation,
        minutesRemaining: Int,
        now: Date
    ) -> CompanionPresentation {
        let expiry = status.sessionExpiresAt.map(CompanionDisplayFormatting.time) ?? "—"
        let acknowledgementSummary = acknowledgementText(status.exposure.followerAck)
        var copyingRows = verifiedPositionRows(status.exposure)
        if copyingRows.isEmpty {
            copyingRows.append(keyValue(
                id: "exposure-unverified",
                label: "Expozice",
                value: "Neověřeno",
                tone: .warning
            ))
        }
        copyingRows.append(keyValue(
            id: "follower-ack",
            label: "Potvrzení followerů",
            value: acknowledgementSummary,
            tone: status.exposure.followerAck == nil ? .warning : .success
        ))

        let copying = StatusSectionPresentation(
            id: "copying",
            title: "Kopírování",
            summary: status.exposure.followerAck == nil ? "Expozice neověřena" : acknowledgementSummary,
            summaryTone: status.exposure.followerAck == nil ? .warning : .success,
            isInitiallyExpanded: true,
            hasProblem: false,
            rows: copyingRows
        )

        return CompanionPresentation(
            fixtureID: status.exposure.followerAck == nil ? .liveAckUnavailable : .live,
            displayState: .live(minutesRemaining: minutesRemaining),
            menuBar: .init(
                pillText: "LIVE",
                tone: .success,
                accessibilityLabel: "AlphaTrade, LIVE, zbývá \(minutesRemaining) minut"
            ),
            freshness: freshness,
            hero: .init(
                symbolName: "",
                title: "LIVE",
                badge: "\(minutesRemaining) min",
                detail: "Kopírování aktivní · session vyprší v \(expiry)",
                tone: .success
            ),
            banner: liveEvidenceBanner(status),
            sections: [
                copying,
                safetySection(status, initiallyExpanded: false),
                runtimeSection(status),
                snapshotsSection(status)
            ],
            footer: calmFooter(),
            exposureEvidence: reduced.exposureEvidence,
            followerAcknowledgementEvidence: reduced.followerAcknowledgementEvidence,
            diagnosticSource: "cloud-read-only"
        )
    }

    static func shadow(
        status: MacCompanionStatusDTO,
        reduced: ReducedCompanionStatus,
        freshness: FreshnessPresentation
    ) -> CompanionPresentation {
        let tracking = StatusSectionPresentation(
            id: "leader-tracking",
            title: "Sledování leadera",
            summary: "Jen sledování · nic neodesláno",
            summaryTone: .neutral,
            isInitiallyExpanded: true,
            hasProblem: false,
            rows: [
                keyValue(
                    id: "shadow-mode",
                    label: "Režim",
                    value: "Jen sledováno · žádný příkaz se neodesílá",
                    tone: .muted
                ),
                keyValue(
                    id: "shadow-followers",
                    label: "Potvrzení followerů",
                    value: "Nedostupné",
                    tone: .warning
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
            freshness: freshness,
            hero: .init(
                symbolName: "",
                title: "SHADOW",
                badge: "sleduje",
                detail: "Žádný příkaz se neodesílá · expozice není brokerem ověřena",
                tone: .muted
            ),
            banner: .init(
                symbolName: "eye",
                text: "SHADOW je pouze sledování. Companion nekontaktuje brokera a netvrdí, že jsou účty flat.",
                tone: .warning
            ),
            sections: [
                tracking,
                safetySection(status, initiallyExpanded: false),
                runtimeSection(status),
                snapshotsSection(status)
            ],
            footer: calmFooter(),
            exposureEvidence: reduced.exposureEvidence,
            followerAcknowledgementEvidence: .notApplicable,
            diagnosticSource: "cloud-read-only"
        )
    }

    static func disarmed(
        status: MacCompanionStatusDTO,
        reduced: ReducedCompanionStatus,
        freshness: FreshnessPresentation
    ) -> CompanionPresentation {
        let verifiedAt: String
        if case .verifiedFlat(let value) = reduced.exposureEvidence {
            verifiedAt = value
        } else {
            verifiedAt = "—"
        }

        return CompanionPresentation(
            fixtureID: .disarmed,
            displayState: .disarmed,
            menuBar: .init(
                pillText: nil,
                tone: .neutral,
                accessibilityLabel: "AlphaTrade, DISARMED"
            ),
            freshness: freshness,
            hero: .init(
                symbolName: "",
                title: "DISARMED",
                badge: nil,
                detail: "Copier neposílá příkazy · flat ověřen v \(verifiedAt)",
                tone: .muted
            ),
            banner: nil,
            sections: [
                safetySection(status, initiallyExpanded: false),
                exposureSection(
                    status,
                    evidence: reduced.exposureEvidence,
                    initiallyExpanded: false
                ),
                runtimeSection(status),
                snapshotsSection(status)
            ],
            footer: calmFooter(),
            exposureEvidence: reduced.exposureEvidence,
            followerAcknowledgementEvidence: .notApplicable,
            diagnosticSource: "cloud-read-only"
        )
    }

    static func disarmedUnverified(
        status: MacCompanionStatusDTO,
        reduced: ReducedCompanionStatus,
        freshness: FreshnessPresentation
    ) -> CompanionPresentation {
        CompanionPresentation(
            fixtureID: .disarmedUnverified,
            displayState: .disarmedUnverified,
            menuBar: .init(
                pillText: "VYPNUTO",
                symbolName: "power",
                tone: .danger,
                accessibilityLabel: "AlphaTrade, copier vypnutý"
            ),
            freshness: freshness,
            hero: .init(
                symbolName: "power",
                title: "VYPNUTO",
                badge: nil,
                detail: "Copier je DISARMED · neposílá příkazy · potvrzeno před \(reduced.freshness.ageSeconds) s",
                supportingText: "Expozice není brokerem ověřena — flat nelze tvrdit",
                tone: .danger
            ),
            banner: nil,
            sections: [
                safetySection(status, initiallyExpanded: false),
                exposureSection(
                    status,
                    evidence: reduced.exposureEvidence,
                    initiallyExpanded: false
                ),
                runtimeSection(status),
                snapshotsSection(status)
            ],
            footer: disarmedUnverifiedFooter(),
            exposureEvidence: .unverified,
            followerAcknowledgementEvidence: .notApplicable,
            diagnosticSource: "cloud-read-only"
        )
    }

    static func intervention(
        status: MacCompanionStatusDTO,
        reduced: ReducedCompanionStatus,
        freshness: FreshnessPresentation,
        issueCount: Int
    ) -> CompanionPresentation {
        CompanionPresentation(
            fixtureID: .intervention,
            displayState: .intervention(issueCount: issueCount),
            menuBar: .init(
                pillText: "!\(max(issueCount, 1))",
                tone: .danger,
                accessibilityLabel: "AlphaTrade, zásah nutný, \(max(issueCount, 1)) problémů"
            ),
            freshness: freshness,
            hero: .init(
                symbolName: "exclamationmark.triangle.fill",
                title: "ZÁSAH NUTNÝ",
                badge: "\(max(issueCount, 1)) problémů",
                detail: "Copier potvrdil bezpečnostní problém a zobrazení zůstává pouze pro čtení.",
                tone: .danger
            ),
            banner: .init(
                symbolName: "hand.raised.fill",
                text: "Divergence ani expozice se nikdy neopravuje obchodem z tohoto panelu. Otevři LIVE a ověř skutečný stav.",
                tone: .danger
            ),
            sections: [
                safetySection(status, initiallyExpanded: true),
                exposureSection(
                    status,
                    evidence: reduced.exposureEvidence,
                    initiallyExpanded: true
                ),
                runtimeSection(status),
                snapshotsSection(status)
            ],
            footer: interventionFooter(),
            exposureEvidence: reduced.exposureEvidence,
            followerAcknowledgementEvidence: reduced.followerAcknowledgementEvidence,
            diagnosticSource: "cloud-read-only"
        )
    }

    static func stale(
        status: MacCompanionStatusDTO,
        reduced: ReducedCompanionStatus,
        freshness: FreshnessPresentation,
        offline: Bool
    ) -> CompanionPresentation {
        let tone: StatusTone = offline ? .danger : .warning
        let lastTime = CompanionDisplayFormatting.time(status.observedAt)
        let title = offline ? "WORKER OFFLINE" : "STAV NEZNÁMÝ"
        let state: CompanionDisplayState = offline ? .offline : .unknown
        let lastKnown = StatusSectionPresentation(
            id: "last-known",
            title: "Poslední známé hodnoty · naposledy \(lastTime)",
            summary: "\(status.copierState.rawValue.uppercased()) · neaktuální",
            summaryTone: tone,
            isInitiallyExpanded: offline,
            hasProblem: offline,
            rows: [
                keyValue(id: "last-location", label: "Umístění", value: locationText(status.worker.location)),
                keyValue(
                    id: "last-broker",
                    label: "Broker spojení",
                    value: "Nyní neověřeno",
                    tone: tone
                ),
                keyValue(
                    id: "last-reconciliation",
                    label: "Reconciliation",
                    value: "Nyní neověřeno",
                    tone: tone
                )
            ]
        )
        let exposure = StatusSectionPresentation(
            id: "exposure",
            title: "Expozice · naposledy \(lastTime)",
            summary: "Současná expozice neověřena",
            summaryTone: tone,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: [
                keyValue(
                    id: "stale-exposure",
                    label: "Současná expozice",
                    value: "Neověřeno",
                    tone: tone
                ),
                keyValue(
                    id: "stale-working-orders",
                    label: "Současné working orders",
                    value: "Neověřeno",
                    tone: tone
                )
            ]
        )

        return CompanionPresentation(
            fixtureID: offline ? .offline : .unknown,
            displayState: state,
            menuBar: .init(
                pillText: offline ? "!1" : "?",
                tone: tone,
                accessibilityLabel: offline ? "AlphaTrade, worker offline" : "AlphaTrade, stav neznámý"
            ),
            freshness: freshness,
            hero: .init(
                symbolName: offline ? "wifi.slash" : "questionmark",
                title: title,
                badge: nil,
                detail: "Naposledy potvrzeno \(status.copierState.rawValue.uppercased()) v \(lastTime)",
                tone: tone
            ),
            banner: .init(
                symbolName: "exclamationmark.triangle.fill",
                text: offline
                    ? "Worker je offline. Poslední známé hodnoty nejsou aktuální a nesmí se vydávat za současný stav."
                    : "Poslední známé hodnoty nejsou aktuální. Nevyvozuj z nich současnou expozici ani stav copieru.",
                tone: tone
            ),
            sections: [lastKnown, exposure, snapshotsSection(status, staleTone: tone)],
            footer: unknownFooter(tone: tone),
            exposureEvidence: .unverified,
            followerAcknowledgementEvidence: .unavailable,
            diagnosticSource: "cloud-read-only"
        )
    }

    static func verifiedUnknown(
        status: MacCompanionStatusDTO,
        reduced: ReducedCompanionStatus,
        freshness: FreshnessPresentation
    ) -> CompanionPresentation {
        let detail: String
        if status.brokerConnected == nil {
            detail = "Heartbeat je čerstvý, ale stav broker spojení není ověřen"
        } else if status.safety.reconciliation.status == .unknown {
            detail = "Heartbeat je čerstvý, ale reconciliation nemá autoritativní stav"
        } else {
            detail = "Heartbeat je čerstvý, ale serverová data nestačí k potvrzení současného stavu"
        }

        return CompanionPresentation(
            fixtureID: .unknown,
            displayState: .unknown,
            menuBar: .init(
                pillText: "?",
                tone: .warning,
                accessibilityLabel: "AlphaTrade, stav není plně ověřen"
            ),
            freshness: freshness,
            hero: .init(
                symbolName: "questionmark",
                title: "STAV NEZNÁMÝ",
                badge: nil,
                detail: detail,
                tone: .warning
            ),
            banner: .init(
                symbolName: "exclamationmark.triangle.fill",
                text: "Čerstvý heartbeat není důkaz flat účtů. Companion bez brokerového ověření současnou expozici netvrdí.",
                tone: .warning
            ),
            sections: [
                safetySection(status, initiallyExpanded: false),
                exposureSection(
                    status,
                    evidence: reduced.exposureEvidence,
                    initiallyExpanded: true
                ),
                runtimeSection(status),
                snapshotsSection(status)
            ],
            footer: verifiedUnknownFooter(),
            exposureEvidence: reduced.exposureEvidence,
            followerAcknowledgementEvidence: reduced.followerAcknowledgementEvidence,
            diagnosticSource: "cloud-read-only"
        )
    }

    static func freshnessPresentation(_ freshness: CompanionFreshness) -> FreshnessPresentation {
        switch freshness {
        case .verified(let age):
            return .init(
                text: "Ověřeno před \(age) s",
                tone: .success,
                accessibilityLabel: "Stav ověřen před \(age) sekundami"
            )
        case .unknown(let age):
            return .init(
                text: "Bez nových dat \(CompanionDisplayFormatting.duration(age))",
                tone: .warning,
                accessibilityLabel: "Stav není aktuálně ověřen"
            )
        case .offline(let age):
            return .init(
                text: "Bez heartbeat \(CompanionDisplayFormatting.duration(age))",
                tone: .danger,
                accessibilityLabel: "Worker je offline"
            )
        }
    }

    static func safetySection(
        _ status: MacCompanionStatusDTO,
        initiallyExpanded: Bool
    ) -> StatusSectionPresentation {
        var rows: [SectionRowPresentation] = []
        let reconciliationTone: StatusTone = status.safety.reconciliation.status == .clean
            ? .success
            : status.safety.reconciliation.status == .review ? .danger : .warning
        rows.append(keyValue(
            id: "reconciliation",
            label: "Reconciliation",
            value: reconciliationText(status.safety.reconciliation.status),
            tone: reconciliationTone
        ))

        for (index, divergence) in status.safety.divergences.enumerated() {
            let symbol = divergence.symbol.map { "\($0) · " } ?? ""
            rows.append(keyValue(
                id: "divergence-\(index)",
                label: divergence.account,
                value: "\(symbol)\(divergence.detail)",
                tone: .danger,
                usesMonospacedValue: true
            ))
        }
        rows.append(keyValue(
            id: "outbox",
            label: "Outbox",
            value: status.safety.outbox.stuckCount == 0
                ? "Prázdný"
                : "\(status.safety.outbox.stuckCount) příkazů stuck",
            tone: status.safety.outbox.stuckCount == 0 ? .success : .danger
        ))
        rows.append(keyValue(
            id: "locks",
            label: "Cooldown / Day-lock",
            value: status.safety.cooldownActive || status.safety.dayLockActive ? "Aktivní" : "Neaktivní",
            tone: status.safety.cooldownActive || status.safety.dayLockActive ? .warning : .neutral
        ))
        rows.append(keyValue(
            id: "kill-switch",
            label: "Kill switch",
            value: status.safety.killSwitchTripped ? "Aktivován" : "Připraven",
            tone: status.safety.killSwitchTripped ? .danger : .neutral
        ))

        let acknowledgementHasProblem = followerAcknowledgementHasProblem(status)
        if status.copierState == .live,
           let acknowledgement = status.exposure.followerAck {
            rows.append(keyValue(
                id: "follower-ack",
                label: "Potvrzení followerů",
                value: acknowledgementText(acknowledgement),
                tone: acknowledgementHasProblem ? .danger : .success
            ))
            for (index, failure) in acknowledgement.failing.enumerated() {
                rows.append(keyValue(
                    id: "follower-failure-\(index)",
                    label: failure.account,
                    value: "\(failure.detail) · \(failure.sinceMinutes) min",
                    tone: .danger,
                    usesMonospacedValue: true
                ))
            }
        }

        let hasProblem = status.safety.reconciliation.status == .review
            || !status.safety.divergences.isEmpty
            || status.safety.outbox.stuckCount > 0
            || status.safety.killSwitchTripped
            || status.brokerConnected == false
            || acknowledgementHasProblem
        let isUnverified = status.safety.reconciliation.status == .unknown
            || status.brokerConnected == nil

        let summary: String
        let summaryTone: StatusTone
        if hasProblem {
            summary = "Vyžaduje kontrolu"
            summaryTone = .danger
        } else if isUnverified {
            summary = "Neověřeno"
            summaryTone = .warning
        } else {
            summary = "Vše čisté"
            summaryTone = .success
        }

        return StatusSectionPresentation(
            id: "safety",
            title: "Bezpečnost",
            summary: summary,
            summaryTone: summaryTone,
            isInitiallyExpanded: initiallyExpanded || hasProblem,
            hasProblem: hasProblem,
            rows: rows
        )
    }

    static func exposureSection(
        _ status: MacCompanionStatusDTO,
        evidence: ExposureEvidence,
        initiallyExpanded: Bool
    ) -> StatusSectionPresentation {
        guard let verifiedAt = status.exposure.verifiedAt else {
            return StatusSectionPresentation(
                id: "exposure",
                title: "Expozice",
                summary: "Neověřeno · nelze tvrdit flat",
                summaryTone: .warning,
                isInitiallyExpanded: initiallyExpanded,
                hasProblem: false,
                rows: [
                    keyValue(id: "positions-unverified", label: "Otevřené pozice", value: "Neověřeno", tone: .warning),
                    keyValue(id: "orders-unverified", label: "Working orders", value: "Neověřeno", tone: .warning)
                ]
            )
        }

        var rows = verifiedPositionRows(status.exposure)
        if rows.isEmpty {
            rows.append(keyValue(id: "flat", label: "Otevřené pozice", value: "Žádné", tone: .success))
        }
        rows.append(keyValue(
            id: "exposure-verified-at",
            label: "Ověřeno brokerem",
            value: CompanionDisplayFormatting.time(verifiedAt),
            tone: .success,
            usesMonospacedValue: true
        ))
        let workingOrders = status.exposure.accountsWithWorkingOrders
        rows.append(keyValue(
            id: "working-orders",
            label: "Účty s working orders",
            value: workingOrders.map(String.init) ?? "Neověřeno",
            tone: (workingOrders ?? 0) > 0 ? .danger : workingOrders == nil ? .warning : .success
        ))

        let hasExposure = !status.exposure.positions.isEmpty || (workingOrders ?? 0) > 0
        let summary: String
        let summaryTone: StatusTone
        if hasExposure {
            summary = "Otevřená expozice · \(CompanionDisplayFormatting.time(verifiedAt))"
            summaryTone = .danger
        } else if evidence.mayClaimFlat {
            summary = "Flat ověřen · \(CompanionDisplayFormatting.time(verifiedAt))"
            summaryTone = .success
        } else {
            summary = "Neověřeno · working orders"
            summaryTone = .warning
        }
        return StatusSectionPresentation(
            id: "exposure",
            title: "Expozice",
            summary: summary,
            summaryTone: summaryTone,
            isInitiallyExpanded: initiallyExpanded || hasExposure,
            hasProblem: hasExposure,
            rows: rows
        )
    }

    static func runtimeSection(_ status: MacCompanionStatusDTO) -> StatusSectionPresentation {
        StatusSectionPresentation(
            id: "runtime",
            title: "Copier runtime",
            summary: "\(locationText(status.worker.location)) · HB \(CompanionDisplayFormatting.time(status.worker.lastHeartbeatAt))",
            summaryTone: .success,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: [
                keyValue(id: "runtime-location", label: "Umístění", value: locationText(status.worker.location)),
                keyValue(
                    id: "broker-connection",
                    label: "Broker spojení",
                    value: status.brokerConnected.map { $0 ? "Připojeno" : "Odpojeno" } ?? "Neověřeno",
                    tone: status.brokerConnected == true ? .success : status.brokerConnected == false ? .danger : .warning
                ),
                keyValue(
                    id: "heartbeat",
                    label: "Worker heartbeat",
                    value: CompanionDisplayFormatting.time(status.worker.lastHeartbeatAt),
                    tone: .success,
                    usesMonospacedValue: true
                )
            ]
        )
    }

    static func snapshotsSection(
        _ status: MacCompanionStatusDTO,
        staleTone: StatusTone? = nil
    ) -> StatusSectionPresentation {
        let tone: StatusTone = staleTone ?? (status.snapshots.cdpReady ? .success : .warning)
        let lastSnapshot = [status.snapshots.lastEntryAt, status.snapshots.lastExitAt]
            .compactMap { $0 }
            .max()
        return StatusSectionPresentation(
            id: "snapshots",
            title: staleTone == nil ? "Snímky TradingView" : "Snímky TradingView · neaktuální",
            summary: lastSnapshot.map(CompanionDisplayFormatting.time) ?? "Nedostupné",
            summaryTone: tone,
            isInitiallyExpanded: false,
            hasProblem: false,
            rows: [
                keyValue(
                    id: "cdp",
                    label: "CDP",
                    value: staleTone == nil
                        ? (status.snapshots.cdpReady ? "Připraveno" : "Nedostupné")
                        : "Nyní neověřeno",
                    tone: tone
                ),
                keyValue(
                    id: "last-entry",
                    label: "Poslední ENTRY snímek",
                    value: status.snapshots.lastEntryAt.map(CompanionDisplayFormatting.time) ?? "Nedostupné",
                    usesMonospacedValue: true
                ),
                keyValue(
                    id: "last-exit",
                    label: "Poslední EXIT snímek",
                    value: status.snapshots.lastExitAt.map(CompanionDisplayFormatting.time) ?? "Nedostupné",
                    usesMonospacedValue: true
                )
            ]
        )
    }

    static func verifiedPositionRows(
        _ exposure: MacCompanionStatusDTO.ExposureDTO
    ) -> [SectionRowPresentation] {
        guard exposure.verifiedAt != nil else { return [] }
        return exposure.positions.enumerated().map { index, position in
            .position(.init(
                id: "position-\(index)",
                symbol: position.symbol,
                side: position.side == .long ? .long : .short,
                quantity: position.qty,
                detail: "Brokerem ověřeno · \(CompanionDisplayFormatting.time(position.at))",
                detailTone: .danger
            ))
        }
    }

    static func acknowledgementText(
        _ acknowledgement: MacCompanionStatusDTO.FollowerAcknowledgementDTO?
    ) -> String {
        guard let acknowledgement else {
            return "Nedostupné"
        }
        return "\(acknowledgement.confirmed)/\(acknowledgement.total) followerů"
    }

    static func followerAcknowledgementHasProblem(
        _ status: MacCompanionStatusDTO
    ) -> Bool {
        guard status.copierState == .live,
              let acknowledgement = status.exposure.followerAck else {
            return false
        }
        return acknowledgement.confirmed < acknowledgement.total
            || !acknowledgement.failing.isEmpty
    }

    static func liveEvidenceBanner(
        _ status: MacCompanionStatusDTO
    ) -> BannerPresentation? {
        let exposureIsUnverified = status.exposure.verifiedAt == nil
        let acknowledgementIsUnavailable = status.exposure.followerAck == nil
        guard exposureIsUnverified || acknowledgementIsUnavailable else {
            return nil
        }

        let text: String
        switch (exposureIsUnverified, acknowledgementIsUnavailable) {
        case (true, true):
            text = "Copier je LIVE, ale tento read-only klient nemá brokerové ověření expozice ani per-follower potvrzení."
        case (true, false):
            text = "Potvrzení followerů je dostupné, ale tento read-only klient nemá brokerové ověření expozice."
        case (false, true):
            text = "Expozice byla ověřena, ale per-follower potvrzení není dostupné."
        case (false, false):
            return nil
        }
        return .init(
            symbolName: "exclamationmark.triangle.fill",
            text: text,
            tone: .warning
        )
    }

    static func reconciliationText(
        _ status: MacCompanionStatusDTO.ReconciliationDTO.Status
    ) -> String {
        switch status {
        case .clean: return "Čistá"
        case .review: return "Vyžaduje kontrolu"
        case .unknown: return "Neověřeno"
        }
    }

    static func locationText(_ location: MacCompanionStatusDTO.WorkerDTO.Location) -> String {
        location == .mac ? "Mac worker" : "VPS"
    }

    static func keyValue(
        id: String,
        label: String,
        value: String,
        tone: StatusTone = .neutral,
        usesMonospacedValue: Bool = false
    ) -> SectionRowPresentation {
        .keyValue(.init(
            id: id,
            label: label,
            value: value,
            tone: tone,
            usesMonospacedValue: usesMonospacedValue
        ))
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
                    accessibilityLabel: "Otevřít deník"
                ),
                refreshAction(),
                diagnosticsAction()
            ],
            sourceNote: "Cloud read-only · žádné obchodní ovládání"
        )
    }

    static func interventionFooter() -> FooterPresentation {
        FooterPresentation(
            actions: [
                .init(
                    id: .openLive,
                    title: "Otevřít LIVE — vyřešit",
                    symbolName: nil,
                    style: .primary,
                    tone: .danger,
                    destination: .live,
                    accessibilityLabel: "Otevřít AlphaTrade LIVE a vyřešit problém"
                ),
                refreshAction(),
                diagnosticsAction()
            ],
            sourceNote: "Cloud read-only · žádné obchodní ovládání"
        )
    }

    static func unknownFooter(tone: StatusTone) -> FooterPresentation {
        FooterPresentation(
            actions: [
                .init(
                    id: .refresh,
                    title: "Obnovit stav",
                    symbolName: "arrow.clockwise",
                    style: .primary,
                    tone: tone,
                    destination: nil,
                    accessibilityLabel: "Obnovit cloudový stav"
                ),
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
            sourceNote: "Cloud read-only · poslední data nejsou aktuální"
        )
    }

    static func verifiedUnknownFooter() -> FooterPresentation {
        FooterPresentation(
            actions: [
                .init(
                    id: .refresh,
                    title: "Obnovit stav",
                    symbolName: "arrow.clockwise",
                    style: .primary,
                    tone: .warning,
                    destination: nil,
                    accessibilityLabel: "Obnovit cloudový stav"
                ),
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
            sourceNote: "Cloud read-only · heartbeat čerstvý, expozice neověřena"
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
                    accessibilityLabel: "Otevřít deník"
                ),
                refreshAction(),
                diagnosticsAction()
            ],
            sourceNote: "Cloud read-only · zapnutí je dostupné pouze v LIVE"
        )
    }

    static func refreshAction() -> FooterActionPresentation {
        .init(
            id: .refresh,
            title: "Obnovit",
            symbolName: "arrow.clockwise",
            style: .icon,
            tone: .neutral,
            destination: nil,
            accessibilityLabel: "Obnovit cloudový stav"
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
}
