import CoreSpotlight
import UniformTypeIdentifiers

enum SearchableIndexService {
    static let tradeIdentifierPrefix = "trade:"

    static func index(trades: [TradeRecord]) async {
        let items = trades.map { trade in
            let attributes = CSSearchableItemAttributeSet(contentType: .content)
            attributes.title = "\(trade.symbol) · \(trade.side) · \(trade.result.usd)"
            attributes.contentDescription = "\(trade.setup) — \(trade.note)"
            attributes.keywords = [trade.symbol, trade.side, trade.setup, "AlphaTrade", "Deník"]
            attributes.contentCreationDate = trade.timestamp
            return CSSearchableItem(
                uniqueIdentifier: "\(tradeIdentifierPrefix)\(trade.id.uuidString)",
                domainIdentifier: "app.alphatrade.nativelab.journal",
                attributeSet: attributes
            )
        }
        try? await CSSearchableIndex.default().indexSearchableItems(items)
    }

    static func tradeID(from activity: NSUserActivity) -> UUID? {
        guard
            let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
            identifier.hasPrefix(tradeIdentifierPrefix)
        else { return nil }

        return UUID(uuidString: String(identifier.dropFirst(tradeIdentifierPrefix.count)))
    }
}
