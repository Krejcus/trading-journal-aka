import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { FlaskConical, RefreshCw, TrendingUp, TrendingDown, Minus, X } from 'lucide-react';
import { Account, Trade } from '../types';
import { storageService } from '../services/storageService';

interface BacktestSession {
  id: string;
  accountId: string;
  date: string;
  block: string;
  bias?: string;
  preNotes?: string;
  postNotes?: string;
}

interface Props {
  theme: 'dark' | 'light' | 'oled';
  accounts: Account[];
  trades: Trade[];
}

const BacktestSessionsView: React.FC<Props> = ({ theme, accounts, trades }) => {
  const isDark = theme !== 'light';
  const [sessions, setSessions] = useState<BacktestSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const backtestAccounts = useMemo(() => accounts.filter(a => a.type === 'Backtest'), [accounts]);
  const accNameById = useMemo(() => new Map(backtestAccounts.map(a => [String(a.id), a.name])), [backtestAccounts]);
  const backtestAccIds = useMemo(() => new Set(backtestAccounts.map(a => String(a.id))), [backtestAccounts]);

  const load = useCallback(async () => {
    setIsLoading(true);
    const ids = backtestAccounts.map(a => String(a.id));
    const data = ids.length ? await storageService.getBacktestSessions(ids) : [];
    setSessions(data);
    setIsLoading(false);
  }, [backtestAccounts]);

  useEffect(() => { load(); }, [load]);

  // Obchody patřící do session = stejný účet + datum + blok.
  const tradesForSession = useCallback((s: BacktestSession) => {
    return trades.filter(t =>
      backtestAccIds.has(String(t.accountId)) &&
      String(t.accountId) === String(s.accountId) &&
      (t.date || '').slice(0, 10) === s.date &&
      (t.session || '') === s.block
    );
  }, [trades, backtestAccIds]);

  const grouped = useMemo(() => {
    const byDate = new Map<string, BacktestSession[]>();
    for (const s of sessions) {
      const arr = byDate.get(s.date) || [];
      arr.push(s);
      byDate.set(s.date, arr);
    }
    return Array.from(byDate.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, list]) => [date, list.sort((a, b) => a.block.localeCompare(b.block))] as const);
  }, [sessions]);

  const biasBadge = (bias?: string) => {
    if (bias === 'Long') return { cls: isDark ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: <TrendingUp size={11} />, label: 'Long' };
    if (bias === 'Short') return { cls: isDark ? 'bg-rose-500/15 text-rose-400 border-rose-500/30' : 'bg-rose-100 text-rose-700 border-rose-200', icon: <TrendingDown size={11} />, label: 'Short' };
    return { cls: isDark ? 'bg-slate-500/15 text-slate-400 border-slate-500/30' : 'bg-slate-100 text-slate-600 border-slate-200', icon: <Minus size={11} />, label: bias || 'Neutral' };
  };

  const cardCls = isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm';

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-3xl mx-auto px-4 lg:px-8 pt-[80px] lg:pt-[96px] pb-20">
      <div className="flex items-center justify-between border-b pb-4 mb-6 border-[var(--border-subtle)]">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-2xl flex items-center justify-center ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
            <FlaskConical size={20} />
          </div>
          <div>
            <h2 className="text-2xl md:text-3xl font-black tracking-tighter italic">BACKTEST DENÍK</h2>
            <p className="text-[11px] font-bold text-slate-500 tracking-wide">{sessions.length} session{sessions.length === 1 ? '' : 's'} · pre/post poznámky</p>
          </div>
        </div>
        <button
          onClick={load}
          className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all active:scale-90 ${isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
          title="Obnovit"
        >
          <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-sm text-slate-500">Načítám backtest sessions…</div>
      ) : backtestAccounts.length === 0 ? (
        <div className={`text-center py-16 px-6 rounded-2xl border border-dashed ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-300 text-slate-400'}`}>
          Nemáš žádný účet typu <strong>Backtest</strong>. Vytvoř ho v sekci Účty.
        </div>
      ) : sessions.length === 0 ? (
        <div className={`text-center py-16 px-6 rounded-2xl border border-dashed ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-300 text-slate-400'}`}>
          Zatím žádné backtest sessions. Zapisuj je v <strong>AlphaBridge</strong> (backtest mód → pre/post session).
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([date, list]) => (
            <div key={date}>
              <div className="text-[11px] font-black uppercase tracking-widest text-slate-500 mb-2 px-1">{date}</div>
              <div className="space-y-3">
                {list.map(s => {
                  const b = biasBadge(s.bias);
                  const st = tradesForSession(s);
                  const pnl = st.reduce((sum, t) => sum + (t.pnl || 0), 0);
                  const wins = st.filter(t => (t.pnl || 0) > 0.01).length;
                  const losses = st.filter(t => (t.pnl || 0) < -0.01).length;
                  const shots = st.flatMap(t => (t.screenshots && t.screenshots.length) ? t.screenshots : (t.screenshot ? [t.screenshot] : [])).filter(Boolean);
                  const pnlPos = pnl >= 0;
                  return (
                    <div key={s.id} className={`p-4 rounded-2xl border ${cardCls}`}>
                      <div className="flex items-center gap-2 mb-3 flex-wrap">
                        <span className={`text-xs font-black uppercase tracking-wider ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>{s.block}</span>
                        <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${b.cls}`}>{b.icon}{b.label}</span>
                        {accNameById.size > 1 && <span className="text-[10px] font-bold text-slate-400 ml-auto">{accNameById.get(String(s.accountId)) || ''}</span>}
                      </div>

                      {/* Výsledek session */}
                      {st.length > 0 && (
                        <div className="flex items-center gap-2 mb-3 flex-wrap">
                          <span className={`text-sm font-black font-mono px-2.5 py-1 rounded-lg ${pnlPos ? (isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-100 text-emerald-700') : (isDark ? 'bg-rose-500/15 text-rose-400' : 'bg-rose-100 text-rose-700')}`}>
                            {pnlPos ? '+' : ''}${Math.round(pnl).toLocaleString('en-US')}
                          </span>
                          <span className={`text-[11px] font-bold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            {st.length} obchod{st.length === 1 ? '' : st.length < 5 ? 'y' : 'ů'} · {wins}W / {losses}L
                          </span>
                        </div>
                      )}

                      <div className="space-y-2">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-0.5">Pre — na co koukám</p>
                          <p className={`text-sm leading-relaxed ${s.preNotes ? '' : 'italic text-slate-400'}`}>{s.preNotes || 'bez poznámky'}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-0.5">Post — čeho jsem si všiml / co doladit</p>
                          <p className={`text-sm leading-relaxed ${s.postNotes ? '' : 'italic text-slate-400'}`}>{s.postNotes || 'bez poznámky'}</p>
                        </div>
                      </div>

                      {/* Screenshoty z obchodů session */}
                      {shots.length > 0 && (
                        <div className="flex gap-2 mt-3 flex-wrap">
                          {shots.map((url, i) => (
                            <button key={i} onClick={() => setLightbox(url)}
                              className={`w-16 h-16 rounded-lg overflow-hidden border transition-all hover:scale-105 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
                              <img src={url} alt={`screenshot ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6" onClick={() => setLightbox(null)}>
          <button className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20" onClick={() => setLightbox(null)}>
            <X size={20} />
          </button>
          <img src={lightbox} alt="screenshot" className="max-w-full max-h-full rounded-xl object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
};

export default BacktestSessionsView;
