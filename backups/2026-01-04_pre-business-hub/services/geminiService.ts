
// Always use import {GoogleGenAI} from "@google/genai";
import { GoogleGenAI } from "@google/genai";
import { TradeStats, Trade } from "../types";

const SYSTEM_INSTRUCTION = `
Jsi **AlphaTrade Mentor** – zkušený tradingový psycholog a analytik (člověk, ne robot).
Tvým úkolem je vést s uživatelem přirozenou konverzaci o jeho obchodování. Vidíš jeho data, ale "nevychrlíš" je na něj hned, pokud se nezeptá.

PRAVIDLA CHOVÁNÍ:
1. **Buď lidský a stručný.** Na "Ahoj" odpověz normálně (např. "Čau, vidím tvoje data. Jdeme se na to podívat?").
2. **Odpovídej POUZE na to, na co se uživatel ptá.**
   - Pokud se zeptá "Jaký je můj nejlepší den?", odpověz jednou větou (např. "Jednoznačně úterý, máš tam největší zisk.").
   - Negeneruj tabulky a dlouhé analýzy, pokud si o ně uživatel výslovně neřekne (příkazy jako "Analyzuj to", "Celkový audit", "Report").
3. **Buď přísný mentor.** Pokud uživatel dělá chyby (např. drží ztráty), upozorni ho na to, ale v kontextu konverzace.
4. **Formátování:** Používej Markdown, občas emojis, ale nepřeháněj to.
5. **Jazyk:** Čeština.

Tvým cílem je pomoci uživateli stát se profitabilním, ne ho udočit statistikami, na které se neptal.
`;

export class GeminiService {
  private ai: GoogleGenAI;

  constructor() {
    // The API key must be obtained exclusively from process.env.API_KEY.
    // Initialize with a named parameter.
    this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  }

  async analyzePerformance(stats: TradeStats, badExits: Trade[], userQuery: string): Promise<string> {
    // 1. Calculate Detailed Day Stats (Long vs Short breakdown per day)
    const days = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
    const detailedDays = days.map(dayName => {
        const tradesForDay = stats.trades.filter(t => days[new Date(t.timestamp).getDay()] === dayName);
        const longTrades = tradesForDay.filter(t => t.direction === 'Long');
        const shortTrades = tradesForDay.filter(t => t.direction === 'Short');
        const pnl = tradesForDay.reduce((sum, t) => sum + t.pnl, 0);
        
        return {
            day: dayName,
            pnl: pnl,
            tradeCount: tradesForDay.length,
            winRate: tradesForDay.length > 0 ? (tradesForDay.filter(t => t.pnl > 0).length / tradesForDay.length * 100).toFixed(1) + '%' : '0%',
            longs: {
                count: longTrades.length,
                pnl: longTrades.reduce((sum, t) => sum + t.pnl, 0),
                winRate: longTrades.length > 0 ? (longTrades.filter(t => t.pnl > 0).length / longTrades.length * 100).toFixed(1) + '%' : '0%'
            },
            shorts: {
                count: shortTrades.length,
                pnl: shortTrades.reduce((sum, t) => sum + t.pnl, 0),
                winRate: shortTrades.length > 0 ? (shortTrades.filter(t => t.pnl > 0).length / shortTrades.length * 100).toFixed(1) + '%' : '0%'
            }
        };
    }).sort((a,b) => b.pnl - a.pnl);

    // 2. Calculate Detailed Hourly Stats
    const detailedHours = Array.from({length: 24}, (_, i) => i).map(h => {
        const tradesForHour = stats.trades.filter(t => new Date(t.timestamp).getHours() === h);
        if (tradesForHour.length === 0) return null;

        const longTrades = tradesForHour.filter(t => t.direction === 'Long');
        const shortTrades = tradesForHour.filter(t => t.direction === 'Short');

        return {
            hour: `${h}:00`,
            pnl: tradesForHour.reduce((sum, t) => sum + t.pnl, 0),
            tradeCount: tradesForHour.length,
            longs: {
                count: longTrades.length,
                pnl: longTrades.reduce((sum, t) => sum + t.pnl, 0)
            },
            shorts: {
                count: shortTrades.length,
                pnl: shortTrades.reduce((sum, t) => sum + t.pnl, 0)
            }
        };
    }).filter(Boolean).sort((a: any, b: any) => b.pnl - a.pnl);

    const sortedTrades = [...stats.trades].sort((a, b) => b.pnl - a.pnl);
    const bestTrade = sortedTrades[0];
    const worstTrade = sortedTrades[sortedTrades.length - 1];

    const contextData = JSON.stringify({
      metrics: {
        totalPnL: stats.totalPnL,
        winRate: stats.winRate.toFixed(2) + '%',
        profitFactor: stats.profitFactor.toFixed(2),
        avgRiskReward: (stats.avgLoss === 0 ? 'N/A' : (stats.avgWin / stats.avgLoss).toFixed(2)),
        maxDrawdown: stats.maxDrawdown,
        totalTrades: stats.totalTrades,
        avgWin: stats.avgWin,
        avgLoss: stats.avgLoss,
        maxWin: stats.maxWin,
        maxLoss: stats.maxLoss,
        consecutiveWins: stats.maxConsecutiveWins,
        consecutiveLosses: stats.maxConsecutiveLosses
      },
      bestTrade: bestTrade ? {
        id: bestTrade.id,
        date: bestTrade.date,
        signal: bestTrade.signal,
        pnl: bestTrade.pnl,
        direction: bestTrade.direction,
        duration: bestTrade.duration
      } : null,
      worstTrade: worstTrade ? {
        id: worstTrade.id,
        date: worstTrade.date,
        signal: worstTrade.signal,
        pnl: worstTrade.pnl,
        direction: worstTrade.direction,
        duration: worstTrade.duration
      } : null,
      detailedDays: detailedDays, 
      detailedHours: detailedHours,
      signals: stats.signals, 
      last50Trades: stats.trades.slice(-50).map(t => ({
          id: t.id,
          date: t.date,
          signal: t.signal,
          pnl: t.pnl,
          direction: t.direction,
          duration: t.duration
      })),
      problematicTrades: badExits.map(t => ({
        id: t.id,
        signal: t.signal,
        runUp: t.runUp,
        actualPnL: t.pnl,
        moneyLeftOnTable: t.runUp - t.pnl
      }))
    }, null, 2);

    const prompt = `
      KONTEXT (Data z obchodního deníku uživatele):
      ${contextData}
      
      UŽIVATELSKÝ DOTAZ:
      "${userQuery}"
      
      INSTRUKCE PRO ODPOVĚĎ:
      Odpověz uživateli přímo na jeho dotaz. Buď stručný, pokud dotaz nevyžaduje komplexní odpověď. 
      Využij data z kontextu pro faktickou správnost.
      
      POKUD SE UŽIVATEL PTÁ NA DETAILY:
      - Hledej v 'detailedDays' nebo 'detailedHours'.
      - Odpovídej přesně podle těchto čísel.
      
      POKUD SE UŽIVATEL PTÁ NA "NEJLEPŠÍ/NEJHORŠÍ OBCHOD":
      - Využij sekce 'bestTrade' a 'worstTrade'.
    `;

    try {
      // Use ai.models.generateContent with the correct model and prompt.
      // For complex text tasks like performance analysis, 'gemini-3-pro-preview' is recommended.
      const response = await this.ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.7, 
        }
      });

      // The text content is directly available as a property on the response object.
      return response.text || "Omlouvám se, nepodařilo se mi vygenerovat analýzu.";
    } catch (error) {
      console.error("Gemini API Error:", error);
      return "Omlouvám se, momentálně mi vypadlo spojení. Zkus to za chvíli.";
    }
  }
}
