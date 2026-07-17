import React from 'react';
import type { Trade } from '../types';
import { Zap, Monitor, Waves } from 'lucide-react';

interface Props {
  trade: Trade;
  isDark?: boolean;
}

type Tone = 'sky' | 'amber' | 'violet' | 'emerald' | 'rose' | 'slate';

// Stáří v minutách → kompaktní "45m" / "9 h" (sweepy a struktura bývají staré hodiny).
const fmtAge = (m?: number | null): string | null => {
  if (m == null || !isFinite(Number(m))) return null;
  const min = Math.max(0, Math.round(Number(m)));
  return min >= 90 ? `${Math.round(min / 60)} h` : `${min}m`;
};
// IB stav (CTX) → lidský popisek + tón chipu.
const IB_STATE: Record<string, [string, Tone]> = {
  up: ['IB break ↑', 'emerald'], down: ['IB break ↓', 'rose'], both: ['IB rotace', 'amber'],
  in: ['IB uvnitř', 'slate'], form: ['IB tvoří se', 'slate'], pre: ['Před RTH', 'slate'],
};
// Gap v denním ATR → třída velikosti (stejné prahy jako indikátor).
const gapClass = (g: number): string => { const a = Math.abs(g); return a < 0.3 ? 'drobný' : a < 0.7 ? 'malý' : a < 1.2 ? 'střední' : 'velký'; };

// Barva Entry chipu podle typu tagu — ltfConfluence jsou textové tagy (auto i ruční),
// takže tón odvodíme z prefixu: SL červeně, TP zeleně, struktura modře, odraz jantar, entry fialově.
const entryTone = (t: string): Tone => {
  if (/^SL\b/i.test(t)) return 'rose';
  if (/^TP\b/i.test(t)) return 'emerald';
  if (/^(BoS|CHoCH)/i.test(t)) return 'sky';
  if (/^Odraz/i.test(t)) return 'amber';
  if (/^Entry/i.test(t)) return 'violet';
  return 'slate';
};

const SL_LABEL: Record<string, string> = { fvg: 'SL na FVG', swing: 'SL na swingu', ote: 'SL na OTE', other: 'SL jinde' };
const TGT_LABEL: Record<string, string> = { deviation: 'TP VWAP deviace', daily: 'TP denní level', liquidity: 'TP likvidita', fixed_rr: 'TP fixní RR', other: 'TP jiný cíl' };

/** Fallback pro obchody bez ltfConfluence (starší zápisy): poskládej tagy ze strukturovaných polí. */
const buildEntryTags = (trade: Trade): string[] => {
  const em: any = trade.entryMap;
  const out: string[] = [];
  if (em?.available) {
    if (em.structureType) out.push(`${em.structureType}${em.structureOrder ? ` ${em.structureOrder}.` : ''}`);
    if (Array.isArray(em.odrazLevels)) em.odrazLevels.forEach((l: string) => out.push(`Odraz ${l}`));
    if (em.entryFvg) out.push('Entry na FVG');
    if (Array.isArray(em.entryLevels)) em.entryLevels.forEach((l: string) => out.push(`Entry ${l}`));
  }
  if (trade.slPlacement) out.push(SL_LABEL[trade.slPlacement] || `SL ${trade.slPlacement}`);
  if (trade.targetLevel) out.push(`TP ${trade.targetLevel}`);
  else if (trade.targetType) out.push(TGT_LABEL[trade.targetType] || `TP ${trade.targetType}`);
  return out;
};

/**
 * Tři sekce tagů na kartě obchodu — vždy viditelné (na rozdíl od sbalovacího Intelu):
 *  1. Entry Confluence — všechno o tomhle vstupu (struktura, odraz, entry, SL, TP)
 *  2. HTF Confluence — vyšší rámce a kontext dne (bias/IB, gap, 15m/1H struktura, HTF FVG)
 *  3. Levely — mapa likvidity kolem vstupu (co je za námi / co před námi + kotvy)
 */
const TradeConfluence: React.FC<Props> = ({ trade, isDark = true }) => {
  const ec: any = trade.entryContext;
  const c: any = ec?.ctx;
  const fvg: any = ec?.htfFvg;
  const isLongT = String(trade.direction || '').toUpperCase() === 'LONG';

  const entryTags = (trade.ltfConfluence?.length ? trade.ltfConfluence : buildEntryTags(trade));
  const htfManual = trade.htfConfluence || [];

  const chip = (label: string, tone: Tone, key?: string) => {
    const tones: Record<Tone, string> = {
      sky: 'bg-sky-500/10 border-sky-500/20 text-sky-400',
      amber: 'bg-amber-500/10 border-amber-500/20 text-amber-500',
      violet: 'bg-violet-500/10 border-violet-500/20 text-violet-400',
      emerald: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500',
      rose: 'bg-rose-500/10 border-rose-500/20 text-rose-500',
      slate: isDark ? 'bg-white/5 border-white/10 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-600',
    };
    return <span key={key ?? label} className={`px-2 py-1 rounded-lg border text-[9px] font-black uppercase tracking-wide ${tones[tone]}`}>{label}</span>;
  };

  const heading = (Icon: any, text: string) => (
    <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-2.5 flex items-center gap-2"><Icon size={11} /> {text}</p>
  );
  const sectionCls = `pt-4 border-t ${isDark ? 'border-white/[0.03]' : 'border-slate-100'}`;
  const cardBg = isDark ? 'bg-black/20 border-white/5' : 'bg-white border-slate-100';

  // ── HTF chipy: kontext dne (ctx) + HTF FVG zóny. Struktura se barví podle souladu se směrem.
  const htfChips: React.ReactNode[] = [];
  if (c) {
    const [ibLbl, ibTone] = IB_STATE[c.ib] || [c.ib || '—', 'slate' as Tone];
    if (c.ib) htfChips.push(chip(ibLbl, ibTone, 'ib'));
    if (c.gapAtr != null) htfChips.push(chip(`Gap ${c.gapAtr > 0 ? '+' : ''}${c.gapAtr} ATR · ${gapClass(c.gapAtr)}`, 'sky', 'gap'));
    const structChip = (tf: string, s: any, key: string) => {
      if (!s) return;
      const aligned = isLongT ? s.dir === 'bull' : s.dir === 'bear';
      const age = fmtAge(s.ageMin);
      htfChips.push(chip(`${tf} ${s.dir === 'bull' ? '▲' : '▼'} ${s.type}${s.run ? ` ×${s.run}` : ''}${age ? ` · ${age}` : ''}`, aligned ? 'emerald' : 'rose', key));
    };
    structChip('15m', c.s15, 's15');
    structChip('1H', c.s60, 's60');
    if (c.onWidthAtr != null) htfChips.push(chip(`ON ${c.onWidthAtr} dATR`, 'slate', 'onw'));
    if (c.ibWidthAtr != null) htfChips.push(chip(`IB ${c.ibWidthAtr} dATR`, 'slate', 'ibw'));
  }
  if (fvg) {
    // Entry uvnitř HTF FVG = silná konfluence → zvýrazni; jinak ukaž nejbližší netknuté zóny.
    if (fvg.inside15) htfChips.push(chip(`V 15m FVG ${fvg.inside15.dir === 'bull' ? '▲' : '▼'}${fvg.inside15.tested ? ' · testovaná' : ''}`, 'violet', 'in15'));
    if (fvg.inside60) htfChips.push(chip(`V 1H FVG ${fvg.inside60.dir === 'bull' ? '▲' : '▼'}${fvg.inside60.tested ? ' · testovaná' : ''}`, 'violet', 'in60'));
    if (fvg.nearestUntestedAbove) htfChips.push(chip(`${fvg.nearestUntestedAbove.tf}m FVG ↑ ${Math.round(fvg.nearestUntestedAbove.dist)} b`, 'slate', 'fvgUp'));
    if (fvg.nearestUntestedBelow) htfChips.push(chip(`${fvg.nearestUntestedBelow.tf}m FVG ↓ ${Math.round(fvg.nearestUntestedBelow.dist)} b`, 'slate', 'fvgDn'));
    if (Array.isArray(fvg.zones) && fvg.zones.length) htfChips.push(chip(`${fvg.zones.length} zón`, 'slate', 'fvgN'));
  }
  htfManual.forEach((t, i) => htfChips.push(chip(t, 'sky', `hm${i}`)));

  // ── Levely: kotvy (nad/pod) — barva podle souladu se směrem obchodu.
  const anchorChip = (name: string, above: boolean | null | undefined, key: string) => {
    if (above == null) return null;
    const aligned = isLongT ? above : !above; // long nad kotvou = po proudu; short pod kotvou = po proudu
    return chip(`${above ? 'Nad' : 'Pod'} ${name}`, aligned ? 'emerald' : 'rose', key);
  };
  const sweepAgeByLevel: Record<string, number> = {};
  (ec?.sweepAges || []).forEach((s: any) => { if (s && s.level != null) sweepAgeByLevel[s.level] = s.minAgo; });
  const swept: string[] = ec?.sweptLevels || [];
  // „Za námi" = levely vzaté PŘED vstupem. Od 16. 7. je nese sweepAges (dopočet z barů, každý
  // má čas). Starší obchody sweepAges nemají nebo mají neúplné → fallback na sweptLevels.
  const sweepList: { level: string; age: number | null }[] = ec?.sweepAges?.length
    ? ec.sweepAges.map((s: any) => ({ level: s.level, age: s.minAgo }))
    : swept.map(l => ({ level: l, age: sweepAgeByLevel[l] ?? null }));
  // Vzdálenosti od entry v bodech — jen u obchodů uložených od 15. 7. (starší pole nemají).
  const levelDist: Record<string, number> | null = ec?.levelDist || null;
  const distOf = (level: string): string | null => {
    const d = levelDist?.[level];
    if (d == null || !isFinite(Number(d))) return null;
    const v = Math.abs(Math.round(Number(d)));
    return `${Number(d) >= 0 ? '↑' : '↓'}${v} b`;
  };
  const hasLevels = !!ec?.available && (sweepList.length > 0 || ec.untappedAbove > 0 || ec.untappedBelow > 0 || ec.aboveDO != null || ec.vwapDistSigma != null);

  const mins = ec?.entryMinutes;
  const timeStr = mins != null ? `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` : null;

  if (!entryTags.length && !htfChips.length && !hasLevels) return null;

  return (
    <>
      {/* 1 · Entry Confluence — všechno o tomhle vstupu (auto z AlphaBridge + ruční tagy) */}
      {entryTags.length > 0 && (
        <div className={sectionCls}>
          {heading(Zap, 'Entry Confluence')}
          <div className="flex flex-wrap gap-1.5">{entryTags.map((t, i) => chip(t, entryTone(t), `e${i}`))}</div>
        </div>
      )}

      {/* 2 · HTF Confluence — kontext dne + vyšší rámce (dřív prázdná ruční sekce, teď se plní sama) */}
      {htfChips.length > 0 && (
        <div className={sectionCls}>
          {heading(Monitor, 'HTF Confluence')}
          <div className="flex flex-wrap gap-1.5">{htfChips}</div>
        </div>
      )}

      {/* 3 · Levely — mapa likvidity: co už padlo (za námi) vs. kam to může táhnout (před námi) */}
      {hasLevels && (
        <div className={sectionCls}>
          {heading(Waves, 'Levely')}
          <div className={`rounded-xl border grid grid-cols-2 overflow-hidden ${cardBg}`}>
            <div className={`p-2.5 border-r ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
              <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-1.5">Za námi</p>
              {sweepList.length ? (
                <div className="space-y-1">
                  {sweepList.slice(0, 5).map((s, i) => {
                    const age = fmtAge(s.age);
                    const dist = distOf(s.level);
                    return (
                      <div key={`sw${i}`} className="flex items-baseline justify-between gap-1.5">
                        <span className="text-[10px] font-black uppercase tracking-tight text-amber-500 truncate">{s.level}</span>
                        <span className="flex items-baseline gap-1.5 shrink-0 font-mono">
                          {dist && <span className="text-[9px] font-bold text-slate-400">{dist}</span>}
                          {age && <span className="text-[9px] font-bold text-slate-500">{age}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : <p className="text-[10px] font-bold text-slate-500 italic">nic vzatého</p>}
            </div>
            <div className="p-2.5">
              <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-1.5">Před námi</p>
              <div className="space-y-1">
                {([
                  { dir: '↑', n: ec.untappedAbove || 0, near: ec.nearestUntappedAbove },
                  { dir: '↓', n: ec.untappedBelow || 0, near: ec.nearestUntappedBelow },
                ] as const).map(({ dir, n, near }) => {
                  const dist = near ? distOf(near) : null;
                  return (
                    <div key={dir} className="flex items-baseline justify-between gap-1.5">
                      <span className="text-[10px] font-black text-slate-400 shrink-0">{dir} {n} netknutých</span>
                      {near && (
                        <span className="flex items-baseline gap-1.5 min-w-0">
                          <span className="text-[9px] font-black uppercase text-violet-400 truncate">{near}</span>
                          {dist && <span className="text-[9px] font-bold font-mono text-slate-400 shrink-0">{dist.replace(/^[↑↓]/, '')}</span>}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {/* Kotvy + doplňky pod mapou */}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {anchorChip('DO', ec.aboveDO, 'aDO')}
            {anchorChip('WO', ec.aboveWO, 'aWO')}
            {anchorChip('pdVWAP', ec.abovePdVWAP, 'aPdV')}
            {ec.vwapDistSigma != null && chip(`VWAP ${ec.vwapDistSigma > 0 ? '+' : ''}${ec.vwapDistSigma}σ`, 'sky', 'sig')}
            {ec.londonVsAsia && chip(`LON ${ec.londonVsAsia === 'above' ? 'nad Asií ↑' : ec.londonVsAsia === 'below' ? 'pod Asií ↓' : 'v Asii'}`, 'slate', 'lon')}
            {timeStr && chip(timeStr, 'slate', 'time')}
          </div>
        </div>
      )}
    </>
  );
};

export default React.memo(TradeConfluence);
