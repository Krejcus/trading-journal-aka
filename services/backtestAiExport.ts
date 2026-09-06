import type { Account, Trade } from '../types';
import type { BacktestRun } from './backtestTypes';
import { pointValueFor } from './tradovateImport';

const derivePositionSize = (trade: Trade): number | null => {
  const t = trade as Trade & { quantity?: number };
  if (t.positionSize != null) return Number(t.positionSize);
  if (t.quantity != null) return Number(t.quantity);
  const risk = Number(t.riskAmount), e = Number(t.entryPrice), s = Number(t.stopLoss);
  const pv = pointValueFor(t.instrument || t.symbol || '');
  const slDist = Math.abs(e - s);
  if (risk > 0 && slDist > 0 && pv > 0) return Math.round(risk / (slDist * pv));
  return null;
};

export const BACKTEST_EXPORT_LEGEND = {
  _o_souboru: "Export backtest obchodů z AlphaTrade. Každý řádek = 1 zapsaný trade (executionStatus může být i Missed) + 'counterfactual' (co by se stalo při jiném SL / TP / managementu, dopočítáno z barů). Slouží k AI analýze: najít edge, porovnat SL/TP/BE varianty, ověřit držení biasu, projít poznámky.",
  pole: {
    direction: "Long / Short",
    outcome: "Win / Loss / BE — reálný výsledek",
    pnl: "reálný PnL v $",
    slPlacement: "kam reálně dal SL: fvg (pod FVG) | swing (pod strukturní swing) | ote (pod 0.79 OTE) | other",
    targetType: "kam cílil TP: deviation (VWAP ±1σ/±2σ) | liquidity (nejbližší level) | session_close (EOD) | other",
    management: "řízení pozice: trail_bos (trail za strukturou) | fixed (set&forget) | partial_runner | be_runner",
    sessionBias: "bias session (Long/Short/Neutral) zadaný PŘED obchodováním",
    biasAligned: "true = obchod ve směru biasu, false = proti biasu, null = Neutral/nezadáno",
    mfeR: "Max Favorable Excursion v R (kam až cena došla ve prospěch)",
    maeR: "Max Adverse Excursion v R (kam až proti)",
    excursionAmbiguous: "true = MFE/MAE jsou pouze prokazatelné dolní meze; nepoužívat jako přesná maxima",
    counterfactual: "CO KDYBY. swing/ote/fvg = 3 varianty SL: každá má fixní-TP výsledek (outcome/rr/realizedR) i 'trail' (strukturní trailing: reason tp/trail+/trail/open, realizedR). tpTargets = co kdyby cílil na různé likviditní úrovně (label/price/outcome/realizedR), risk base = swing SL. realizedR = výsledek v R-násobcích.",
    excursion: "KAM BY TO DOŠLO DO KONCE DNE (Filip nesmí držet přes noc, vystupuje limitem na levelech). mfePotentialR=max favorable (může >TP), tpR, leftOnTableR=co zbylo na stole, levels[]=likvidní levely ve směru (reached/r/bars), trail=strukturní trailing.",
    entryMap: "VSTUPNÍ MODEL: structureType (CHoCH=reverzal / BoS=pokračování) + structureOrder, odrazLevels=od jakého levelu se cena odrazila, entryFvg=entry na hraně FVG.",
    htfConfluence_ltfConfluence: "Výsledné konfluence mohou být ruční i automatické. autoConfluence označuje známý automatický původ; bez tohoto pole nelze původ spolehlivě určit.",
    notes: "poznámky k obchodu · sessionPreNotes/PostNotes = poznámky k celé session",
  },
};

export const buildBacktestTradeRecord = (trade: Trade) => {
  const t = structuredClone(trade) as Trade & Record<string, unknown>;
  return ({
  ...t,
  id: t.id, accountId: t.accountId, backtestRunId: t.backtestRunId ?? null,
  tags: t.tags ?? [], setupType: t.setupType ?? null,
  autoConfluence: t.autoConfluence ?? null,
  confluenceProvenance: {
    automatic: t.autoConfluence ?? null,
    manualOrUnclassified: {
      htf: (t.htfConfluence ?? []).filter(tag => !t.autoConfluence?.htf.includes(tag)),
      ltf: (t.ltfConfluence ?? []).filter(tag => !t.autoConfluence?.ltf.includes(tag)),
    },
    rule: "Only autoConfluence proves automatic origin; other tags are manual or legacy-unclassified.",
  },
  date: t.date, entryDate: t.entryDate, entryTime: t.entryTime,
  instrument: t.instrument || t.symbol, direction: t.direction, session: t.session,
  outcome: t.outcome, pnl: t.pnl, riskAmount: t.riskAmount, positionSize: derivePositionSize(trade),
  entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfit: t.takeProfit, exitPrice: t.exitPrice,
  durationMinutes: t.durationMinutes, executionStatus: t.executionStatus,
  slPlacement: t.slPlacement ?? null, targetType: t.targetType ?? null, targetLevel: t.targetLevel ?? null, management: t.management ?? null,
  sessionBias: t.sessionBias ?? null, biasAligned: t.biasAligned ?? null,
  htfConfluence: t.htfConfluence ?? [], ltfConfluence: t.ltfConfluence ?? [],
  emotions: t.emotions ?? [], mistakes: t.mistakes ?? [],
  notes: t.notes ?? null, sessionPreNotes: t.sessionPreNotes ?? null, sessionPostNotes: t.sessionPostNotes ?? null,
  mfeR: t.mfeR ?? null, maeR: t.maeR ?? null, mfePoints: t.mfePoints ?? null, maePoints: t.maePoints ?? null,
  excursionAmbiguous: t.excursionAmbiguous ?? false, outcomeAmbiguous: t.outcomeAmbiguous ?? false,
  runUp: t.runUp ?? null, drawdown: t.drawdown ?? null,
  excursionAvailable: t.excursionAvailable ?? null,
  excursion: t.excursion ?? null,
  entryMap: t.entryMap ?? null,
  counterfactual: t.counterfactual ?? null,
  schemaVersion: t.schemaVersion ?? null, source: t.source ?? null,
});
};


export const buildBacktestAiExport = (sessions: Account[], trades: Trade[], runs: BacktestRun[], exportedAt = new Date().toISOString()) => {
  const ids = new Set(sessions.map(session => String(session.id)));
  const included = trades.filter(trade => ids.has(String(trade.accountId)));
  return {
    format: 'alphatrade-backtest-analysis', version: 2, exportovano: exportedAt,
    _legenda: BACKTEST_EXPORT_LEGEND,
    provenance: { world: 'backtest', transport: 'download-only', completeness: 'Full stored trade fields; no candle dataset or external media binaries included.' },
    sessions: sessions.map(session => ({ id: session.id, name: session.name, initialBalance: session.initialBalance })),
    runs: runs.filter(run => ids.has(String(run.accountId))).map(run => ({ id: run.id, accountId: run.accountId, name: run.name, startAt: run.startAt, endAt: run.endAt, cursorAt: run.cursorAt, config: structuredClone(run.config), createdAt: run.createdAt, updatedAt: run.updatedAt })),
    pocetObchodu: included.length, obchody: included.map(buildBacktestTradeRecord),
  };
};
