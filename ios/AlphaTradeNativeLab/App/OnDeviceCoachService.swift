import Foundation
import FoundationModels

enum OnDeviceCoachService {
    static func summarize(trades: [TradeRecord]) async -> String {
        let model = SystemLanguageModel.default
        guard case .available = model.availability else {
            return "Apple Intelligence model není na tomto zařízení momentálně dostupný."
        }
        let evidence = trades.prefix(5).map { trade in
            "\(trade.symbol) \(trade.side), \(trade.result) USD, \(trade.rMultiple)R, setup: \(trade.setup), poznámka: \(trade.note)"
        }.joined(separator: "\n")
        let instructions = """
        Jsi lokální analytická pomůcka obchodního deníku. Shrň pouze dodané záznamy česky ve 3 krátkých bodech: opakovaná silná stránka, rizikové chování, jedna otázka pro sebereflexi. Nevytvářej tradingový signál, predikci ani pokyn k obchodu. Pokud důkazy nestačí, řekni to.
        """
        do {
            let session = LanguageModelSession(instructions: instructions)
            let response = try await session.respond(to: evidence)
            return response.content
        } catch {
            return "Lokální shrnutí se nepodařilo vytvořit. Data zůstala na zařízení."
        }
    }
}
