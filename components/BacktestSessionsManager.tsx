import React, { useState, useMemo } from 'react';
import { Layers, Plus, Trash2, FlaskConical, Download } from 'lucide-react';
import { Account, Trade } from '../types';
import { storageService } from '../services/storageService';
import { pointValueFor } from '../services/tradovateImport';

// positionSize (počet kontraktů): z uloženého pole, jinak dopočet z risku: riskAmount / (SL vzdálenost × $/bod).
const derivePositionSize = (t: any): number | null => {
  if (t.positionSize != null) return Number(t.positionSize);
  if (t.quantity != null) return Number(t.quantity);
  const risk = Number(t.riskAmount), e = Number(t.entryPrice), s = Number(t.stopLoss);
  const pv = pointValueFor(t.instrument || t.symbol || '');
  const slDist = Math.abs(e - s);
  if (risk > 0 && slDist > 0 && pv > 0) return Math.round(risk / (slDist * pv));
  return null;
};

interface Props {
  theme: 'dark' | 'light' | 'oled';
  accounts: Account[];
  trades: Trade[];
  onUpdate: (accounts: Account[]) => void;
  onDelete?: (id: string) => void;
}

// ── Export backtest obchodů do JSON pro AI analýzu (Claude Opus 4.8) ──────────
const EXPORT_LEGEND = {
  _o_souboru: "Export backtest obchodů z AlphaTrade. Každý obchod = 1 reálně zapsaný trade + 'counterfactual' (co by se stalo při jiném SL / TP / managementu, dopočítáno z barů). Slouží k AI analýze: najít edge, porovnat SL/TP/BE varianty, ověřit držení biasu, projít poznámky.",
  pole: {
    direction: "Long / Short",
    outcome: "Win / Loss / BE — reálný výsledek",
    pnl: "reálný PnL v $",
    slPlacement: "kam reálně dal SL: fvg (pod FVG) | swing (pod strukturní swing) | ote (pod 0.79 OTE) | other",
    targetType: "kam cílil TP: deviation | daily | fixed_rr | liquidity | other",
    management: "řízení pozice: trail_bos (trail za strukturou) | fixed (set&forget) | partial_runner | be_runner",
    sessionBias: "bias session (Long/Short/Neutral) zadaný PŘED obchodováním",
    biasAligned: "true = obchod ve směru biasu, false = proti biasu, null = Neutral/nezadáno",
    mfeR: "Max Favorable Excursion v R (kam až cena došla ve prospěch)",
    maeR: "Max Adverse Excursion v R (kam až proti)",
    counterfactual: "CO KDYBY. swing/ote/fvg = 3 varianty SL: každá má fixní-TP výsledek (outcome/rr/realizedR) i 'trail' (strukturní trailing: reason tp/trail+/trail/open, realizedR). tpTargets = co kdyby cílil na různé likviditní úrovně (label/price/outcome/realizedR), risk base = swing SL. realizedR = výsledek v R-násobcích.",
    excursion: "KAM BY TO DOŠLO DO KONCE DNE (Filip nesmí držet přes noc, vystupuje limitem na levelech). mfePotentialR=max favorable (může >TP), tpR, leftOnTableR=co zbylo na stole, levels[]=likvidní levely ve směru (reached/r/bars), trail=strukturní trailing.",
    entryMap: "VSTUPNÍ MODEL: structureType (CHoCH=reverzal / BoS=pokračování) + structureOrder, odrazLevels=od jakého levelu se cena odrazila, entryFvg=entry na hraně FVG.",
    htfConfluence_ltfConfluence: "ručně zvolené konfluence (tagy); SL/TP/entry jsou i tady jako tagy (SL Swing, TP VWAP, Odraz …, Entry FVG)",
    notes: "poznámky k obchodu · sessionPreNotes/PostNotes = poznámky k celé session",
  },
};

const buildTradeRecord = (t: any) => ({
  date: t.date, entryDate: t.entryDate, entryTime: t.entryTime,
  instrument: t.instrument || t.symbol, direction: t.direction, session: t.session,
  outcome: t.outcome, pnl: t.pnl, riskAmount: t.riskAmount, positionSize: derivePositionSize(t),
  entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfit: t.takeProfit, exitPrice: t.exitPrice,
  durationMinutes: t.durationMinutes, executionStatus: t.executionStatus,
  slPlacement: t.slPlacement ?? null, targetType: t.targetType ?? null, targetLevel: t.targetLevel ?? null, management: t.management ?? null,
  sessionBias: t.sessionBias ?? null, biasAligned: t.biasAligned ?? null,
  htfConfluence: t.htfConfluence ?? [], ltfConfluence: t.ltfConfluence ?? [],
  emotions: t.emotions ?? [], mistakes: t.mistakes ?? [],
  notes: t.notes ?? null, sessionPreNotes: t.sessionPreNotes ?? null, sessionPostNotes: t.sessionPostNotes ?? null,
  mfeR: t.mfeR ?? null, maeR: t.maeR ?? null, mfePoints: t.mfePoints ?? null, maePoints: t.maePoints ?? null,
  runUp: t.runUp ?? null, drawdown: t.drawdown ?? null,
  excursionAvailable: t.excursionAvailable ?? null,
  excursion: t.excursion ?? null,
  entryMap: t.entryMap ?? null,
  counterfactual: t.counterfactual ?? null,
  schemaVersion: t.schemaVersion ?? null, source: t.source ?? null,
});

const downloadJSON = (filename: string, data: any) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const BacktestSessionsManager: React.FC<Props> = ({ theme, accounts, trades, onUpdate, onDelete }) => {
  const isDark = theme !== 'light';
  const [name, setName] = useState('');
  const [size, setSize] = useState('50000');

  const sessions = useMemo(() => accounts.filter(a => a.type === 'Backtest' && a.status === 'Active'), [accounts]);

  const statsByAcc = useMemo(() => {
    const m = new Map<string, { count: number; pnl: number }>();
    for (const t of trades) {
      const k = String(t.accountId);
      const cur = m.get(k) || { count: 0, pnl: 0 };
      cur.count++; cur.pnl += (t.pnl || 0);
      m.set(k, cur);
    }
    return m;
  }, [trades]);

  const inputCls = `w-full rounded-xl px-3 py-2.5 text-sm outline-none border transition-all ${isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-500 focus:border-violet-500/50' : 'bg-white border-slate-200 text-slate-800 placeholder:text-slate-400 focus:border-violet-400'}`;
  const cardCls = isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm';

  const [exporting, setExporting] = useState(false);
  const exportSessions = async (sess: Account[], single?: boolean) => {
    const ids = sess.map(s => String(s.id));
    setExporting(true);
    try {
      // Dotáhni PLNÝ blob z DB (in-memory trades mají blob stržený → counterfactual/excursion null).
      const full = await storageService.getTradesWithDataByAccounts(ids);
      if (full.length === 0) return;
      const out = {
        _legenda: EXPORT_LEGEND,
        exportovano: new Date().toISOString(),
        sessions: sess.map(s => ({ id: s.id, name: s.name, initialBalance: s.initialBalance })),
        pocetObchodu: full.length,
        obchody: full.map(buildTradeRecord),
      };
      const stamp = new Date().toISOString().slice(0, 10);
      const namePart = single && sess[0] ? sess[0].name.replace(/[^\w-]+/g, '_') : 'vse';
      downloadJSON(`backtest-${namePart}-${stamp}.json`, out);
    } finally {
      setExporting(false);
    }
  };

  const totalTrades = useMemo(() => {
    const ids = new Set(sessions.map(s => String(s.id)));
    return trades.filter(t => ids.has(String(t.accountId))).length;
  }, [sessions, trades]);

  const create = () => {
    const n = name.trim();
    const s = Number(size);
    if (!n || !s || s <= 0) return;
    const account = {
      id: crypto.randomUUID(),
      name: n,
      initialBalance: s,
      challengeCost: 0,
      totalWithdrawals: 0,
      totalGrossWithdrawals: 0,
      profitSplit: 100,
      profitTarget: 10,
      phase: undefined,
      accumulatedChallengePnL: 0,
      type: 'Backtest',
      status: 'Active',
      currency: 'USD',
      propThreshold: 150,
      instrumentFees: { 'NQ': 2.8, 'MNQ': 0.74 },
      createdAt: Date.now(),
    } as unknown as Account;
    onUpdate([...accounts, account]);
    setName('');
    setSize('50000');
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-2xl mx-auto px-4 lg:px-8 pt-[80px] lg:pt-[96px] pb-20">
      <div className="flex items-center gap-3 border-b pb-4 mb-6 border-[var(--border-subtle)]">
        <div className={`w-10 h-10 rounded-2xl flex items-center justify-center ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
          <Layers size={20} />
        </div>
        <div className="flex-1">
          <h2 className="text-2xl md:text-3xl font-black tracking-tighter italic">SESSIONS</h2>
          <p className="text-[11px] font-bold text-slate-500 tracking-wide">{sessions.length} backtest session{sessions.length === 1 ? '' : 's'}</p>
        </div>
        {totalTrades > 0 && (
          <button onClick={() => exportSessions(sessions)} title="Export všech backtest obchodů do JSON (pro AI analýzu)"
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-black transition-all ${isDark ? 'bg-violet-500/15 text-violet-300 hover:bg-violet-500/25' : 'bg-violet-100 text-violet-700 hover:bg-violet-200'}`}>
            <Download size={14} /> Export vše
          </button>
        )}
      </div>

      {/* Nová session */}
      <div className={`p-4 rounded-2xl border mb-6 ${cardCls}`}>
        <p className={`text-[10px] font-black uppercase tracking-widest mb-3 ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>Nová session</p>
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Název session</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="např. NQ Silver Bullet" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') create(); }} />
          </div>
          <div className="sm:w-40">
            <label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Velikost účtu ($)</label>
            <input type="number" value={size} onChange={e => setSize(e.target.value)} placeholder="50000" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') create(); }} />
          </div>
          <button onClick={create} disabled={!name.trim() || !Number(size)}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-[11px] font-black uppercase tracking-widest transition-all active:scale-95">
            <Plus size={14} /> Vytvořit
          </button>
        </div>
      </div>

      {/* Seznam sessions */}
      {sessions.length === 0 ? (
        <div className={`text-center py-14 px-6 rounded-2xl border border-dashed ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-300 text-slate-400'}`}>
          Zatím žádná session. Vytvoř první nahoře — pak na ni v AlphaBridge zapisuješ obchody.
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map(s => {
            const st = statsByAcc.get(String(s.id)) || { count: 0, pnl: 0 };
            const pnlPos = st.pnl >= 0;
            return (
              <div key={s.id} className={`p-4 rounded-2xl border flex items-center gap-3 ${cardCls}`}>
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
                  <FlaskConical size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-black truncate">{s.name}</p>
                  <p className="text-[11px] font-bold text-slate-500">${Number(s.initialBalance).toLocaleString('en-US')} · {st.count} obchod{st.count === 1 ? '' : st.count >= 2 && st.count <= 4 ? 'y' : 'ů'}</p>
                </div>
                {st.count > 0 && (
                  <span className={`text-sm font-black font-mono px-2.5 py-1 rounded-lg ${pnlPos ? (isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-100 text-emerald-700') : (isDark ? 'bg-rose-500/15 text-rose-400' : 'bg-rose-100 text-rose-700')}`}>
                    {pnlPos ? '+' : ''}${Math.round(st.pnl).toLocaleString('en-US')}
                  </span>
                )}
                {st.count > 0 && (
                  <button onClick={() => exportSessions([s], true)}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all ${isDark ? 'text-slate-500 hover:text-violet-300 hover:bg-violet-500/10' : 'text-slate-400 hover:text-violet-600 hover:bg-violet-50'}`}
                    title="Export této session do JSON">
                    <Download size={15} />
                  </button>
                )}
                {onDelete && (
                  <button onClick={() => onDelete(String(s.id))}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all ${isDark ? 'text-slate-500 hover:text-rose-400 hover:bg-rose-500/10' : 'text-slate-400 hover:text-rose-500 hover:bg-rose-50'}`}
                    title="Smazat session">
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default BacktestSessionsManager;
