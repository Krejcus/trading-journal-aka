import React, { useState } from 'react';
import type { Trade } from '../types';
import { Activity, ChevronDown, Crosshair } from 'lucide-react';

interface Props {
  trade: Trade;
  isDark?: boolean;
}

// R-multiple formát: +1.8R / −1R / — (null = nedostupné).
const fmtR = (r?: number | null): string => (r == null || Number.isNaN(Number(r))) ? '—' : `${Number(r) > 0 ? '+' : ''}${Number(r)}R`;
const rColor = (r?: number | null): string => (r == null) ? 'text-slate-400' : (Number(r) > 0 ? 'text-emerald-500' : Number(r) < 0 ? 'text-rose-500' : 'text-slate-400');

const SL_LABEL: Record<string, string> = { fvg: 'SL na FVG', swing: 'SL na swingu', ote: 'SL na OTE', other: 'SL jinde' };
const TGT_LABEL: Record<string, string> = { deviation: 'VWAP deviace', daily: 'Denní level', liquidity: 'Likvidita', fixed_rr: 'Fixní RR', other: 'Jiný cíl' };
const MGMT_LABEL: Record<string, string> = { trail_bos: 'Trailing (BOS)', fixed: 'Fixní TP', partial_runner: 'Partial + Runner', be_runner: 'BE Runner' };
const OUTCOME_LABEL: Record<string, string> = { WIN: 'Win', LOSS: 'Loss', OPEN: 'Neuzavřeno' };

/**
 * Panel „AlphaBridge Intel" — vizualizuje bohatá data, která extension spočítá z grafu:
 * MFE/MAE v R, execution tagy (SL/TP/management), entry model, excursion (co zbylo na stole)
 * a counterfactual (co kdyby SL byl jinde). Historicky se ukládala do DB, ale UI je nezobrazovalo.
 */
const TradeExecutionIntel: React.FC<Props> = ({ trade, isDark = true }) => {
  const [open, setOpen] = useState(false);

  const cf: any = trade.counterfactual;
  const exc: any = trade.excursion;
  const em: any = trade.entryMap;

  const hasCf = cf && cf.available;
  const hasExc = exc && exc.available;
  // Pending = sken nedojel do konce dne (došly bary). Data jsou podhodnocená → dopočítá se později.
  const excPending = trade.excursionComplete === false || (exc && exc.stopReason === 'end');
  const hasEm = em && em.available;
  const hasMetrics = trade.mfeR != null || trade.maeR != null;
  const hasTags = !!trade.slPlacement || !!trade.targetLevel || !!trade.management;

  // Nic z AlphaBridge → panel se vůbec nevykreslí (manuální / importované obchody).
  if (!hasMetrics && !hasCf && !hasExc && !hasEm && !hasTags && trade.sessionBias == null) return null;

  const chip = (label: string, tone: 'sky' | 'amber' | 'violet' | 'emerald' | 'rose' | 'slate') => {
    const tones: Record<string, string> = {
      sky: 'bg-sky-500/10 border-sky-500/20 text-sky-400',
      amber: 'bg-amber-500/10 border-amber-500/20 text-amber-500',
      violet: 'bg-violet-500/10 border-violet-500/20 text-violet-400',
      emerald: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500',
      rose: 'bg-rose-500/10 border-rose-500/20 text-rose-500',
      slate: isDark ? 'bg-white/5 border-white/10 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-600',
    };
    return <span className={`px-2 py-1 rounded-lg border text-[9px] font-black uppercase tracking-wide ${tones[tone]}`}>{label}</span>;
  };

  const label = (t: string) => <p className="text-[9px] font-black uppercase text-slate-500 tracking-[0.18em] mb-1.5">{t}</p>;
  const cardBg = isDark ? 'bg-black/20 border-white/5' : 'bg-white border-slate-100';

  // 3 varianty counterfactual SL (co kdyby SL byl na swing/OTE/FVG) → realizedR.
  const cfVariants: Array<{ key: string; name: string; v: any }> = hasCf ? [
    { key: 'swing', name: 'Swing', v: cf.swing },
    { key: 'ote', name: 'OTE', v: cf.ote },
    { key: 'fvg', name: 'FVG', v: cf.fvg },
  ].filter(x => x.v && (x.v.realizedR != null || x.v.rr != null)) : [];

  return (
    <div className={`pt-4 border-t ${isDark ? 'border-white/[0.03]' : 'border-slate-100'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between mb-2.5 group/intel">
        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] flex items-center gap-2">
          <Activity size={11} /> AlphaBridge Intel
          {excPending && <span className="px-1.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-500 text-[7px] font-black uppercase tracking-widest">pending</span>}
        </p>
        <ChevronDown size={14} className={`text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Vždy viditelné summary: MFE/MAE v R (max favorable / adverse excursion) */}
      {hasMetrics && (
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div className={`p-2.5 rounded-xl border ${cardBg}`}>
            <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-0.5">MFE (dosah ve prospěch)</p>
            <p className={`text-lg font-black font-mono tracking-tighter leading-none ${rColor(trade.mfeR)}`}>{fmtR(trade.mfeR)}</p>
          </div>
          <div className={`p-2.5 rounded-xl border ${cardBg}`}>
            <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-0.5">MAE (dosah proti)</p>
            <p className={`text-lg font-black font-mono tracking-tighter leading-none ${trade.maeR != null ? 'text-rose-500' : 'text-slate-400'}`}>
              {trade.maeR != null ? `−${Math.abs(Number(trade.maeR))}R` : '—'}
            </p>
          </div>
        </div>
      )}

      {open && (
        <div className="space-y-3 mt-2">
          {/* Execution tagy: SL placement / target / management */}
          {hasTags && (
            <div>
              {label('Execution')}
              <div className="flex flex-wrap gap-1.5">
                {trade.slPlacement && chip(SL_LABEL[trade.slPlacement] || `SL ${trade.slPlacement}`, 'rose')}
                {trade.targetLevel && chip(`TP ${trade.targetLevel}`, 'emerald')}
                {trade.targetType && !trade.targetLevel && chip(TGT_LABEL[trade.targetType] || trade.targetType, 'emerald')}
                {trade.management && chip(MGMT_LABEL[trade.management] || trade.management, 'violet')}
              </div>
            </div>
          )}

          {/* Entry model: struktura + odraz + FVG */}
          {hasEm && (
            <div>
              {label('Entry model')}
              <div className="flex flex-wrap gap-1.5">
                {em.structureType && chip(`${em.structureType}${em.structureOrder ? ` ${em.structureOrder}.` : ''}`, 'sky')}
                {Array.isArray(em.odrazLevels) && em.odrazLevels.map((l: string, i: number) => <React.Fragment key={`o${i}`}>{chip(`Odraz ${l}`, 'amber')}</React.Fragment>)}
                {em.entryFvg && chip('Entry na FVG', 'violet')}
                {Array.isArray(em.entryLevels) && em.entryLevels.map((l: string, i: number) => <React.Fragment key={`e${i}`}>{chip(`Entry ${l}`, 'slate')}</React.Fragment>)}
              </div>
            </div>
          )}

          {/* Kontext vstupu — kotvy, sweepy, magnet mapa (chipy barevně podle souladu se směrem) */}
          {trade.entryContext?.available && (() => {
            const ec: any = trade.entryContext;
            // direction je v datech nekonzistentní ('LONG' z AlphaBridge, 'Long' ze starších zápisů)
            // → case-insensitive, jinak se chipy u 'LONG' barví obráceně (long nad DO = červená).
            const isLongT = String(trade.direction || '').toUpperCase() === 'LONG';
            const anchorChip = (name: string, above: boolean | null | undefined) => {
              if (above == null) return null;
              const aligned = isLongT ? above : !above; // long nad kotvou = po proudu; short pod kotvou = po proudu
              return chip(`${above ? 'Nad' : 'Pod'} ${name}`, aligned ? 'emerald' : 'rose');
            };
            const mins = ec.entryMinutes;
            const timeStr = mins != null ? `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` : null;
            return (
              <div>
                {label('Kontext vstupu')}
                <div className="flex flex-wrap gap-1.5">
                  {anchorChip('DO', ec.aboveDO)}
                  {anchorChip('WO', ec.aboveWO)}
                  {anchorChip('pdVWAP', ec.abovePdVWAP)}
                  {ec.vwapDistSigma != null && chip(`VWAP ${ec.vwapDistSigma > 0 ? '+' : ''}${ec.vwapDistSigma}σ`, 'sky')}
                  {(ec.sweptLevels || []).slice(0, 4).map((l: string, i: number) => <React.Fragment key={`sw${i}`}>{chip(`${l} vzat`, 'amber')}</React.Fragment>)}
                  {(ec.untappedAbove > 0 || ec.untappedBelow > 0) && chip(`Netknuté ↑${ec.untappedAbove} ↓${ec.untappedBelow}`, 'violet')}
                  {ec.londonVsAsia && chip(`LON ${ec.londonVsAsia === 'above' ? 'nad Asií ↑' : ec.londonVsAsia === 'below' ? 'pod Asií ↓' : 'v Asii'}`, 'slate')}
                  {timeStr && chip(timeStr, 'slate')}
                </div>
              </div>
            );
          })()}

          {/* Excursion: kam by to došlo do konce dne — co zbylo na stole */}
          {hasExc && (
            <div>
              {label('Excursion (do konce dne)')}
              {excPending && (
                <div className={`mb-1.5 px-2.5 py-1.5 rounded-lg border text-[9px] font-bold leading-snug ${isDark ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                  ⚠️ Neúplné — den ještě nedojel do konce (22:00). Hodnoty jsou podhodnocené; dopočítají se, až graf pokryje celé okno.
                </div>
              )}
              <div className={`p-2.5 rounded-xl border ${cardBg} grid grid-cols-3 gap-2 text-center`}>
                <div>
                  <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-0.5">Realizováno</p>
                  <p className={`text-sm font-black font-mono ${rColor(exc.tpR)}`}>{fmtR(exc.tpR)}</p>
                </div>
                <div>
                  <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-0.5">Potenciál</p>
                  <p className={`text-sm font-black font-mono ${rColor(exc.mfePotentialR)}`}>{fmtR(exc.mfePotentialR)}</p>
                </div>
                <div>
                  <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-0.5">Na stole</p>
                  <p className={`text-sm font-black font-mono ${exc.leftOnTableR != null && Number(exc.leftOnTableR) > 0 ? 'text-amber-500' : 'text-slate-400'}`}>{fmtR(exc.leftOnTableR)}</p>
                </div>
              </div>
              {Array.isArray(exc.levels) && exc.levels.filter((l: any) => l.reached).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {exc.levels.filter((l: any) => l.reached).slice(0, 6).map((l: any, i: number) => (
                    <span key={`lv${i}`} className={`px-1.5 py-0.5 rounded-md border text-[8px] font-bold ${isDark ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-600'}`}>
                      {String(l.label).replace(/\s*\[.*?\]\s*$/, '')} {l.r != null ? `${l.r}R` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Counterfactual: co kdyby SL byl jinde (3 varianty) */}
          {cfVariants.length > 0 && (
            <div>
              {label('Co kdyby (SL varianty)')}
              <div className={`rounded-xl border overflow-hidden ${cardBg}`}>
                {cfVariants.map(({ key, name, v }, i) => (
                  <div key={key} className={`flex items-center justify-between px-2.5 py-1.5 ${i > 0 ? (isDark ? 'border-t border-white/5' : 'border-t border-slate-100') : ''}`}>
                    <span className="text-[10px] font-black uppercase tracking-wide text-slate-400 flex items-center gap-1.5"><Crosshair size={10} /> {name}</span>
                    <div className="flex items-center gap-2">
                      {v.outcome && <span className={`text-[8px] font-black uppercase tracking-widest ${v.outcome === 'WIN' ? 'text-emerald-500' : v.outcome === 'LOSS' ? 'text-rose-500' : 'text-slate-500'}`}>{OUTCOME_LABEL[v.outcome] || v.outcome}</span>}
                      <span className={`text-xs font-black font-mono ${rColor(v.realizedR != null ? v.realizedR : v.rr)}`}>{fmtR(v.realizedR != null ? v.realizedR : v.rr)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Session bias (backtest) */}
          {trade.sessionBias != null && (
            <div>
              {label('Session bias')}
              <div className="flex flex-wrap gap-1.5 items-center">
                {chip(trade.sessionBias, trade.sessionBias === 'Long' ? 'emerald' : trade.sessionBias === 'Short' ? 'rose' : 'slate')}
                {trade.biasAligned === true && chip('Ve směru biasu', 'emerald')}
                {trade.biasAligned === false && chip('Proti biasu', 'rose')}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(TradeExecutionIntel);
