
import { Trade, TradeStats, SignalStat, TimeStat, CalendarDay, MonthlyData } from '../types';

export const parseCurrency = (val: string | number): number => {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  let clean = val.toString().replace(/[$,\s]/g, '');
  if (clean.startsWith('(') && clean.endsWith(')')) {
    clean = '-' + clean.replace(/[()]/g, '');
  }
  return parseFloat(clean) || 0;
};

const safeParseDate = (dateStr: any): Date | null => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;
  if (typeof dateStr === 'string') {
    const parts = dateStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (parts) {
      const [_, day, month, year, hour, minute, second] = parts;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), hour ? parseInt(hour) : 0, minute ? parseInt(minute) : 0, second ? parseInt(second) : 0);
    }
  }
  return null;
};

const findTradeId = (row: any): string | null => {
  if (row['Trade #']) return String(row['Trade #']).trim();
  if (row['#']) return String(row['#']).trim();
  if (row['TradeId']) return String(row['TradeId']).trim();
  if (row['Ticket']) return String(row['Ticket']).trim();
  return null;
};

export const normalizeTrades = (raw: any[], accountId: string): Trade[] => {
  const tradeMap = new Map<string, any>();
  
  raw.forEach((r) => {
    const id = findTradeId(r);
    if (!id) return;
    
    if (!tradeMap.has(id)) {
      tradeMap.set(id, { 
        id, 
        pnl: 0, 
        runUp: 0, 
        drawdown: 0, 
        entries: [], 
        exits: [], 
        signal: '', 
        direction: '', 
        entryTime: null, 
        exitTime: null, 
        exitDateStr: null, 
        riskAmount: 0,
        entryPrice: 0,
        exitPrice: 0,
        stopLoss: 0,
        positionSize: 0,
        instrument: ''
      });
    }
    
    const current = tradeMap.get(id);
    const typeStr = (r['Type'] || r['Signal'] || Object.values(r)[1] || '').toString().toLowerCase();
    const signalStr = (r['Signal'] || r['Name'] || Object.values(r)[3] || '').toString();
    const instStr = (r['Symbol'] || r['Instrument'] || r['Market'] || '').toString();
    
    const pnl = parseCurrency(r['Net P&L USD'] || r['PnL'] || r['Profit'] || 0);
    const price = parseCurrency(r['Price'] || r['Entry Price'] || r['Exit Price'] || r['Avg Price'] || 0);
    const size = parseFloat(r['Size'] || r['Quantity'] || r['Qty'] || 1);
    const sl = parseCurrency(r['Stop Loss'] || r['SL'] || 0);
    
    const dateStrRaw = r['Date/Time'] || r['Time'] || r['Date']; 
    const dateObj = safeParseDate(dateStrRaw);
    
    if (dateObj) {
      const time = dateObj.getTime();
      if (typeStr.includes('exit')) {
        current.exits.push(r);
        current.pnl += pnl;
        if (!current.exitTime || time > current.exitTime) { 
          current.exitTime = time; 
          current.exitDateStr = dateObj.toISOString(); 
          current.exitPrice = price; 
        }
      } else if (typeStr.includes('entry')) {
        current.entries.push(r);
        if (!current.entryTime || time < current.entryTime) { 
          current.entryTime = time; 
          current.entryPrice = price;
        }
        if (typeStr.includes('long')) current.direction = 'Long';
        else if (typeStr.includes('short')) current.direction = 'Short';
        
        if (signalStr && !signalStr.toLowerCase().includes('partial')) current.signal = signalStr;
        if (instStr) current.instrument = instStr;
        if (sl) current.stopLoss = sl;
        current.positionSize += size;
      }
    }
  });

  return Array.from(tradeMap.values())
    .filter(t => t.exitTime)
    .map(t => ({
      id: String(t.id),
      accountId,
      instrument: t.instrument || 'Unknown',
      signal: t.signal || 'Manual Trade',
      pnl: t.pnl,
      runUp: t.runUp,
      drawdown: t.drawdown,
      date: t.exitDateStr,
      timestamp: t.exitTime,
      durationMinutes: (t.exitTime - (t.entryTime || t.exitTime)) / 60000,
      duration: `${Math.round((t.exitTime - (t.entryTime || t.exitTime)) / 60000)}m`,
      direction: (t.direction as 'Long' | 'Short') || 'Long',
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      stopLoss: t.stopLoss,
      positionSize: t.positionSize,
      isValid: true,
      // Fix: Cast string literal to union type to match Trade interface
      executionStatus: 'Valid' as 'Valid' | 'Invalid' | 'Missed'
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
};

export const calculateStats = (trades: Trade[], initialBalance: number = 0): TradeStats => {
  let totalPnL = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let winningTrades = 0, losingTrades = 0, breakEvenTrades = 0, missedTrades = 0;
  let currentEquity = initialBalance;
  let currentValidEquity = initialBalance; 
  let maxEquity = initialBalance;
  let maxDrawdown = 0;
  let maxWin = 0, maxLoss = 0;
  let totalWinDuration = 0, totalLossDuration = 0;
  let currentWinStreak = 0, currentLossStreak = 0;
  let maxConsecWins = 0, maxConsecLosses = 0;
  const winStreaks: number[] = [], lossStreaks: number[] = [];
  const pnlList: number[] = [];
  const winPcts: number[] = [], lossPcts: number[] = [];
  
  const equityCurve = [{ date: 'Start', equity: initialBalance, validEquity: initialBalance, drawdown: 0 }];
  const calendarMap = new Map<string, { pnl: number; count: number }>();
  const signalMap = new Map<string, { pnl: number; wins: number; count: number }>();
  const days = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
  const dayMap = new Map<string, any>();
  days.forEach(k => dayMap.set(k, { pnl: 0, profit: 0, loss: 0, wins: 0, count: 0 }));
  const hourMap = new Map<string, any>();
  for(let i=0; i<24; i++) hourMap.set(i.toString(), { pnl: 0, profit: 0, loss: 0, wins: 0, count: 0 });

  const monthlyMap = new Map<number, Map<number, number>>();

  trades.forEach((trade) => {
    const prevEquity = currentEquity;
    
    // Rozhodování o statusu
    const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
    const isMissed = status === 'Missed';
    const isInvalid = status === 'Invalid';
    const isValid = status === 'Valid';

    // Reálné Equity (vše kromě zmeškaných)
    if (!isMissed) {
      currentEquity += trade.pnl;
      totalPnL += trade.pnl;
      pnlList.push(trade.pnl);
    }

    // Disciplinované Equity (Validní + Zmeškané, vynechává chyby/Invalid)
    if (isValid || isMissed) {
      currentValidEquity += trade.pnl;
    }

    const tradePct = prevEquity > 0 ? (trade.pnl / prevEquity) * 100 : 0;
    if (!isMissed) trade.pnlPercentage = tradePct;

    if (currentEquity > maxEquity) maxEquity = currentEquity;
    const dd = currentEquity - maxEquity;
    if (dd < maxDrawdown) maxDrawdown = dd;
    
    equityCurve.push({ 
      date: trade.date, 
      equity: currentEquity, 
      validEquity: currentValidEquity, 
      drawdown: dd 
    });

    if (!isMissed) {
      const d = new Date(trade.date);
      const dateKey = d.toISOString().split('T')[0];
      const cal = calendarMap.get(dateKey) || { pnl: 0, count: 0 };
      calendarMap.set(dateKey, { pnl: cal.pnl + trade.pnl, count: cal.count + 1 });

      const y = d.getFullYear(), m = d.getMonth();
      if(!monthlyMap.has(y)) monthlyMap.set(y, new Map());
      const yearData = monthlyMap.get(y)!;
      yearData.set(m, (yearData.get(m) || 0) + trade.pnl);

      const dayName = days[d.getDay()];
      const dm = dayMap.get(dayName);
      dm.pnl += trade.pnl; dm.count++;
      if(trade.pnl > 0) { dm.profit += trade.pnl; dm.wins++; } else { dm.loss += trade.pnl; }

      const hr = d.getHours().toString();
      const hm = hourMap.get(hr);
      hm.pnl += trade.pnl; hm.count++;
      if(trade.pnl > 0) { hm.profit += trade.pnl; hm.wins++; } else { hm.loss += trade.pnl; }

      if (trade.pnl > 0.01) {
        grossProfit += trade.pnl; winningTrades++; totalWinDuration += trade.durationMinutes;
        currentWinStreak++; maxWin = Math.max(maxWin, trade.pnl);
        winPcts.push(tradePct);
        if (currentLossStreak > 0) { lossStreaks.push(currentLossStreak); currentLossStreak = 0; }
        maxConsecWins = Math.max(maxConsecWins, currentWinStreak);
      } else if (trade.pnl < -0.01) {
        grossLoss += Math.abs(trade.pnl); losingTrades++; totalLossDuration += trade.durationMinutes;
        currentLossStreak++; maxLoss = Math.min(maxLoss, trade.pnl);
        lossPcts.push(tradePct);
        if (currentWinStreak > 0) { winStreaks.push(currentWinStreak); currentWinStreak = 0; }
        maxConsecLosses = Math.max(maxConsecLosses, currentLossStreak);
      } else { breakEvenTrades++; }

      const sig = trade.signal;
      const sm = signalMap.get(sig) || { pnl: 0, wins: 0, count: 0 };
      signalMap.set(sig, { pnl: sm.pnl + trade.pnl, wins: sm.wins + (trade.pnl > 0 ? 1 : 0), count: sm.count + 1 });
    } else {
      missedTrades++;
    }
  });

  if (currentWinStreak > 0) winStreaks.push(currentWinStreak);
  if (currentLossStreak > 0) lossStreaks.push(currentLossStreak);

  const monthlyBreakdown: MonthlyData[] = Array.from(monthlyMap.entries()).map(([year, months]) => {
    const monthObj: any = {};
    let yearlyPnl = 0;
    let runningBalance = initialBalance; 
    
    for(let i=0; i<12; i++) {
      const pnl = months.get(i) || 0;
      const gainPct = runningBalance > 0 ? (pnl / runningBalance) * 100 : 0;
      yearlyPnl += pnl;
      monthObj[i] = { pnl, gainPct, accumGainPct: 0 }; 
      runningBalance += pnl;
    }
    return { year, months: monthObj, yearlyPnl, yearlyGainPct: (yearlyPnl / initialBalance) * 100 };
  }).sort((a,b) => b.year - a.year);

  const avgConsecWins = winStreaks.length ? winStreaks.reduce((a,b)=>a+b,0)/winStreaks.length : 0;
  const avgConsecLosses = lossStreaks.length ? lossStreaks.reduce((a,b)=>a+b,0)/lossStreaks.length : 0;

  const validSignalsCount = winningTrades + losingTrades + breakEvenTrades + missedTrades;
  const takenValidTrades = winningTrades + losingTrades + breakEvenTrades;

  return {
    initialBalance, totalPnL, 
    winRate: (winningTrades + losingTrades + breakEvenTrades) > 0 ? (winningTrades / (winningTrades + losingTrades + breakEvenTrades)) * 100 : 0,
    executionRate: validSignalsCount > 0 ? (takenValidTrades / validSignalsCount) * 100 : 100,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0,
    grossProfit, grossLoss,
    avgWin: winningTrades > 0 ? grossProfit / winningTrades : 0,
    avgLoss: losingTrades > 0 ? grossLoss / losingTrades : 0,
    maxWin, maxLoss,
    bestWinPct: winPcts.length ? Math.max(...winPcts) : 0,
    worstLossPct: lossPcts.length ? Math.min(...lossPcts) : 0,
    avgWinPct: winPcts.length ? winPcts.reduce((a,b)=>a+b,0)/winPcts.length : 0,
    avgLossPct: lossPcts.length ? lossPcts.reduce((a,b)=>a+b,0)/lossPcts.length : 0,
    avgRR: (grossLoss/losingTrades) > 0 ? (grossProfit/winningTrades) / (grossLoss/losingTrades) : 0,
    maxDrawdown: Math.abs(maxDrawdown),
    currentDrawdownPct: maxEquity > 0 ? Math.abs((currentEquity - maxEquity)/maxEquity)*100 : 0,
    avgRisk: 0, totalTrades: trades.filter(t => t.executionStatus !== 'Missed').length, 
    winningTrades, losingTrades, breakEvenTrades, missedTrades,
    winningDays: Array.from(calendarMap.values()).filter(v => v.pnl > 0.01).length,
    losingDays: Array.from(calendarMap.values()).filter(v => v.pnl < -0.01).length,
    breakEvenDays: Array.from(calendarMap.values()).filter(v => Math.abs(v.pnl) <= 0.01).length,
    dayWinRate: calendarMap.size ? (Array.from(calendarMap.values()).filter(v => v.pnl > 0.01).length / calendarMap.size) * 100 : 0,
    // Fix: Correct variable names for consecutive stats
    maxConsecutiveWins: maxConsecWins, maxConsecutiveLosses: maxConsecLosses,
    avgConsecutiveWins: avgConsecWins, avgConsecutiveLosses: avgConsecLosses,
    avgDurationWin: winningTrades ? totalWinDuration/winningTrades : 0,
    avgDurationLoss: losingTrades ? totalLossDuration/losingTrades : 0,
    zScore: 0, sharpeRatio: 0, sortinoRatio: 0, sqn: 0, kellyCriterion: 0, profitPerHour: 0,
    signals: Array.from(signalMap.entries()).map(([name, d]) => ({ signalName: name, count: d.count, winRate: (d.wins/d.count)*100, totalPnL: d.pnl, avgPnL: d.pnl/d.count })),
    equityCurve,
    dayStats: days.map(d => { const dm = dayMap.get(d); return { label: d, pnl: dm.pnl, profit: dm.profit, loss: dm.loss, winRate: dm.count ? (dm.wins/dm.count)*100 : 0, trades: dm.count }; }),
    hourStats: Array.from(hourMap.entries()).map(([h, dm]) => ({ label: `${h}:00`, pnl: dm.pnl, profit: dm.profit, loss: dm.loss, winRate: dm.count ? (dm.wins/dm.count)*100 : 0, trades: dm.count })).filter(h => h.trades > 0),
    longStats: { count: 0, pnl: 0, wins: 0, winRate: 0 }, shortStats: { count: 0, pnl: 0, wins: 0, winRate: 0 },
    calendarData: Array.from(calendarMap.entries()).map(([date, d]) => ({ date, pnl: d.pnl, trades: d.count })).sort((a,b)=>a.date.localeCompare(b.date)),
    monthlyBreakdown,
    trades
  };
};

export const findBadExits = (trades: Trade[]): Trade[] => trades.filter(t => t.runUp > 50 && t.pnl < t.runUp * 0.2).sort((a,b)=>b.runUp - a.runUp).slice(0,5);
