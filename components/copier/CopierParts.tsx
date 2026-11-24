// Části obrazovky kopírky Rithmic (příprava 22. 11. 2026). JEN ZOBRAZENÍ + volání callbacků; o zapnutí,
// zápisech u brokera a riziku rozhoduje služba (jádro kopírky), ne tyto komponenty (INV-UI-*).
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  COPIER_COLUMNS, COPIER_STRIP, COPIER_TABLE_DEFAULTS, copierDayPnl, copierGroupSummary, copierOpenPnl, copierRedact, copierRisk,
  copierSltpUsd, copierTileKind, copierUnprotected, plainUsd, usdText,
  type CopierAccount, type CopierColumnKey, type CopierGroup, type CopierTableSettings, type CopierView,
} from '../../lib/rithmicCopierView';
import { useTweenOnKey } from './copierFx';

const FIRM_PALETTE = ['#6366f1', '#f59e0b', '#ec4899', '#14b8a6', '#8b5cf6', '#22c55e', '#0ea5e9', '#f97316'];
export const firmDot = (firm: string) => FIRM_PALETTE[[...firm].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % FIRM_PALETTE.length];
export const FirmDot = ({ firm }: { firm: string }) => <i className="cp-fd" style={{ background: firmDot(firm) }} />;
export const shownName = (a: CopierAccount, s: CopierTableSettings) => (s.redact ? copierRedact(a.name, s.redactStart, s.redactEnd) : a.name);
const tone = (v: number | null) => (v == null ? '' : v >= 0 ? 'cp-win' : 'cp-loss');
const fmtPrice = (v: number) => v.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const limitText = (m: number | null, unit = true) => (m == null ? 'bez stropu' : unit ? `${m} MNQ` : String(m));
const ratioText = (r: number) => `×${r.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })}`;
const posText = (a: CopierAccount) => (!a.position ? '—' : `${a.position.side === 'long' ? 'Long' : 'Short'} ${a.brokerQuantity ?? a.position.quantity}`);

export function statusChip(a: CopierAccount, armed: boolean): React.ReactNode {
  if (a.brokerQuantity != null) return <span className="cp-chip r">neshoda</span>;
  if (copierUnprotected(a)) return <span className="cp-chip r">bez SL/TP</span>;
  if (a.status === 'breached') return <span className="cp-chip r">breached</span>;
  if (a.status === 'unverifiable') return <span className="cp-chip r">neověřitelný</span>;
  if (a.status === 'dll-locked') return <span className="cp-chip w">limit dne</span>;
  if (!a.copyOn) return <span className="cp-chip">vypnutý</span>;
  return armed ? <span className="cp-chip g">kopíruje</span> : <span className="cp-chip">připraven</span>;
}

// ── 3D vypínač
export type PowerState = 'off' | 'on' | 'block';
export const CopierPowerSwitch = React.forwardRef<HTMLButtonElement, {
  state: PowerState; sub: string; big?: boolean; onClick: () => void; shakeKey?: number; fx?: { n: number; on: boolean } | null;
}>(({ state, sub, big = false, onClick, shakeKey = 0, fx = null }, ref) => {
  const inner = useRef<HTMLButtonElement | null>(null);
  const setRef = (el: HTMLButtonElement | null) => { inner.current = el; if (typeof ref === 'function') ref(el); else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = el; };
  useEffect(() => {
    const el = inner.current; if (!el || !shakeKey) return;
    el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
    const t = window.setTimeout(() => el.classList.remove('shake'), 600); return () => window.clearTimeout(t);
  }, [shakeKey]);
  useEffect(() => {
    const el = inner.current; if (!el || !fx) return;
    el.classList.remove('boom', 'offb', 'surge'); void el.offsetWidth; el.classList.add('boom', 'surge'); if (!fx.on) el.classList.add('offb');
    const t = window.setTimeout(() => el.classList.remove('boom', 'offb', 'surge'), 1300); return () => window.clearTimeout(t);
  }, [fx?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <button ref={setRef} type="button" className={`cp-pwr${big ? ' big' : ''}`} data-st={state} disabled={state === 'block'} onClick={onClick} data-cp-power
      title={state === 'on' ? 'Kopírka zapnutá. Klik = vypnout: nové kopie se zastaví, otevřené pozice zůstanou.' : state === 'off' ? 'Zapnout kopírku' : sub}>
      <span className="tr"><span className="fill" /><span className="kn"><span className="pf front">{state === 'block' ? '✕' : '⏻'}</span><span className="pf back">✓</span></span></span>
      <span className="lb"><b>Kopírka</b><small>{sub}</small></span>
    </button>
  );
});
CopierPowerSwitch.displayName = 'CopierPowerSwitch';

// ── SL / TP v USD s přepínáním skupina ↔ účet
export function SltpValue({ sl, tp, mode, onToggle, unit = true, missing, onMissing, names }: {
  sl: number | null; tp: number | null; mode: 'sum' | 'avg'; onToggle: () => void; unit?: boolean;
  missing: string[]; onMissing: (id: string) => void; names: (id: string) => string;
}) {
  const shownSl = useTweenOnKey(sl, mode), shownTp = useTweenOnKey(tp, mode);
  const first = useRef(true); const [swapN, setSwapN] = useState(0);
  useEffect(() => { if (first.current) { first.current = false; return; } setSwapN(n => n + 1); }, [mode]);
  const cls = swapN ? ` swap ${mode === 'avg' ? '' : 'up'}` : '';
  return (
    <>
      <span key={`sl${swapN}`} className={`cp-sltp${cls}`} onClick={onToggle} title="Kolik se ztratí / vydělá, když trh teď dojde na SL / TP. Klikem přepneš skupina ↔ jeden účet (průměr).">
        SL <b className={`cp-num ${tone(shownSl)}${missing.length ? ' cp-inc' : ''}`}>{usdText(shownSl, { unit })}</b>
        {!unit && <> · </>}{unit ? null : <>TP <b className={`cp-num ${tone(shownTp)}`}>{usdText(shownTp, { unit })}</b></>}
        {!unit && <i className="cp-slm">{mode === 'avg' ? 'účet' : 'skupina'}</i>}
      </span>
      {unit && <span key={`tp${swapN}`} className={`cp-sltp${cls}`} onClick={onToggle}>TP <b className={`cp-num ${tone(shownTp)}`}>{usdText(shownTp, { unit })}</b><i className="cp-slm">{mode === 'avg' ? 'účet' : 'skupina'}</i></span>}
      {missing.length > 0 && <span style={{ borderLeft: 0, paddingLeft: 0 }}><i className="cp-miss" onClick={(e) => { e.stopPropagation(); onMissing(missing[0]); }}
        title={`Bez SL/TP: ${missing.map(names).join(', ')} — riziko těchto účtů není v čísle a není omezené.`}>⚠ {missing.length === 1 ? `${names(missing[0]).split(' ').pop()} bez SL` : `${missing.length} účty bez SL`}</i></span>}
    </>
  );
}

// ── pruh skupiny
export function CopierGroupStrip({ view, group, settings, onSettings, settingsOpen, onMenu, menuOpen, onToggleSltp, onOpenAccount, menu }: {
  view: CopierView; group: CopierGroup; settings: CopierTableSettings; onSettings: () => void; settingsOpen: boolean;
  onMenu: () => void; menuOpen: boolean; onToggleSltp: () => void; onOpenAccount: (id: string) => void; menu?: React.ReactNode;
}) {
  const sum = copierGroupSummary(view, group, settings.sltp);
  const leader = view.accounts[group.leaderId];
  const names = (id: string) => (view.accounts[id] ? shownName(view.accounts[id], settings) : id);
  const on = (k: string) => settings.strip.includes(k as never);
  return (
    <div className="cp-gsum" style={{ position: 'relative' }} data-cp-strip>
      <div className="gn" title={`Leader ${leader ? shownName(leader, settings) : '—'} · 1 → ${group.followerIds.length} · ${group.state.toUpperCase()}`}>
        <i className={`cp-dot ${group.state}`} data-cp-dot />{group.name}
      </div>
      <div className="gk">
        {COPIER_STRIP.map(({ key }) => {
          if (!on(key)) return null;
          if (key === 'day') return <span key={key}>Dnes <b className={`cp-num ${tone(sum.day)}`}>{usdText(sum.day)}</b></span>;
          if (key === 'open') return <span key={key}>Otevřeno <b className={`cp-num ${tone(sum.open)}`}>{usdText(sum.open)}</b></span>;
          if (key === 'sltp') return <SltpValue key={key} sl={sum.sl} tp={sum.tp} mode={settings.sltp} onToggle={onToggleSltp} missing={sum.unprotectedIds} onMissing={onOpenAccount} names={names} />;
          if (key === 'dll') return <span key={key} title="Nejbližší denní limit ve skupině">DLL <b className={`cp-num ${sum.nearestDll && sum.nearestDll.left <= 0 ? 'cp-loss' : ''}`}>{!sum.nearestDll ? '—' : sum.nearestDll.left <= 0 ? 'vyčerpán' : plainUsd(sum.nearestDll.left)}</b></span>;
          if (key === 'copy') return <span key={key}>Kopíruje <b className="cp-num">{sum.copying}/{sum.enabled}</b></span>;
          if (key === 'balance') return <span key={key}>Zůstatek <b className="cp-num">{plainUsd(sum.balance)}</b></span>;
          if (key === 'dd') return <span key={key} title="Nejmenší rezerva DD ve skupině">DD <b className="cp-num">{sum.minDd ? plainUsd(sum.minDd.left) : '—'}</b></span>;
          return <span key={key}>Pozice <b className="cp-num">{sum.contracts ? `${sum.contracts} MNQ` : '—'}</b></span>;
        })}
      </div>
      <button type="button" className={`ic${menuOpen ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); onMenu(); }} title="Akce skupiny" style={{ fontWeight: 900, letterSpacing: 1 }}>⋯</button>
      <button type="button" className={`ic${settingsOpen ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); onSettings(); }} title="Nastavení tabulky">⚙</button>
      {menu}
    </div>
  );
}

// ── menu skupiny (⋯)
export function CopierGroupMenu({ openPositions, editOn, onEdit, onTemplate, onFlatten, onClose, onRename, onDelete, deleteBlocked, groupName }: {
  openPositions: number; editOn: boolean; onEdit?: () => void; onTemplate?: (ratio: number, max: number) => void; onFlatten?: () => void; onClose: () => void;
  onRename?: () => void; onDelete?: () => void; /** Proč skupinu teď smazat nejde (zapnutá, otevřené pozice); null = jde. */ deleteBlocked?: string | null; groupName?: string;
}) {
  const [arm, setArm] = useState(false), [delArm, setDelArm] = useState(false);
  useEffect(() => { if (!arm) return undefined; const t = window.setTimeout(() => setArm(false), 4000); return () => window.clearTimeout(t); }, [arm]);
  useEffect(() => { if (!delArm) return undefined; const t = window.setTimeout(() => setDelArm(false), 4000); return () => window.clearTimeout(t); }, [delArm]);
  useEffect(() => { const h = () => onClose(); window.addEventListener('click', h); return () => window.removeEventListener('click', h); }, [onClose]);
  return (
    <div className="cp-menu" onClick={(e) => e.stopPropagation()}>
      {onEdit && <button type="button" onClick={onEdit}>☑ Filtry a hromadný výběr<small>{editOn ? 'zapnuto' : ''}</small></button>}
      {onRename && <button type="button" onClick={onRename}>✎ Přejmenovat skupinu</button>}
      {onTemplate && <><div className="sep" /><div className="lb">Šablona followerů</div>
      {([['Opatrná', 0.5, 2], ['Standard', 1, 3], ['Plná', 2, 4]] as const).map(([l, r, m]) => <button key={l} type="button" onClick={() => onTemplate(r, m)}>{l}<small>{ratioText(r)} · strop {m}</small></button>)}</>}
      {onFlatten && <><div className="sep" />
      <button type="button" className={`danger${arm ? ' arm' : ''}`} onClick={() => { if (!arm) { setArm(true); return; } setArm(false); onFlatten?.(); }}>
        {arm ? `Opravdu zavřít ${openPositions} pozic? Klikni znovu` : '⏹ Zavřít všechny pozice skupiny'}
      </button></>}
      {onDelete && <><div className="sep" />
      <button type="button" className={`danger${delArm ? ' arm' : ''}`} disabled={Boolean(deleteBlocked)} title={deleteBlocked ?? undefined}
        onClick={() => { if (deleteBlocked) return; if (!delArm) { setDelArm(true); return; } setDelArm(false); onDelete(); }}>
        {delArm ? `Smazat ${groupName ?? 'skupinu'}? Klikni znovu` : '🗑 Smazat skupinu'}
      </button>
      {deleteBlocked ? <div className="cp-mut" style={{ fontSize: 11, padding: '2px 9px 6px', lineHeight: 1.35 }}>{deleteBlocked}</div> : <div className="cp-mut" style={{ fontSize: 11, padding: '2px 9px 6px', lineHeight: 1.35 }}>Účty zůstanou, jen se uvolní pro jinou skupinu. Obchody v deníku se nemažou.</div>}</>}
    </div>
  );
}

// ── nastavení tabulky (⚙)
export function CopierSettingsPanel({ settings, onChange, onClose, sample, asSheet = false }: {
  settings: CopierTableSettings; onChange: (next: CopierTableSettings) => void; onClose: () => void; sample: string; asSheet?: boolean;
}) {
  const [tab, setTab] = useState<'cols' | 'strip' | 'other'>(asSheet ? 'strip' : 'cols');
  const [drag, setDrag] = useState<CopierColumnKey | null>(null), [over, setOver] = useState<CopierColumnKey | null>(null);
  const set = (patch: Partial<CopierTableSettings>) => onChange({ ...settings, ...patch });
  const toggle = <T extends string>(list: T[], k: T) => (list.includes(k) ? list.filter(x => x !== k) : [...list, k]);
  const Sw = ({ on, onClick }: { on: boolean; onClick: () => void }) => <button type="button" className={`cp-sw acc${on ? ' on' : ''}`} onClick={onClick} aria-pressed={on} />;
  const body = tab === 'cols' ? (
    <>
      <div className="cp-sec">Sloupce followerů<button type="button" onClick={() => set({ hidden: [] })}>Zobrazit vše</button></div>
      <div className="cp-cr lock"><span className="hdl">⋮⋮</span>Zap. · Účet<span className="cp-mut" style={{ marginLeft: 'auto', fontSize: 11 }}>vždy</span></div>
      {settings.order.map(k => COPIER_COLUMNS.find(c => c.key === k)).filter(Boolean).map(c => (
        <div key={c!.key} draggable className={`cp-cr${drag === c!.key ? ' drag' : ''}${over === c!.key ? ' over' : ''}`}
          onDragStart={() => setDrag(c!.key)} onDragOver={(e) => { e.preventDefault(); setOver(c!.key); }} onDragEnd={() => { setDrag(null); setOver(null); }}
          onDrop={(e) => { e.preventDefault(); if (!drag) return; const o = settings.order.filter(x => x !== drag); o.splice(o.indexOf(c!.key), 0, drag); set({ order: o }); setDrag(null); setOver(null); }}>
          <span className="hdl">⋮⋮</span>{c!.label}<Sw on={!settings.hidden.includes(c!.key)} onClick={() => set({ hidden: toggle(settings.hidden, c!.key) })} />
        </div>
      ))}
      <div className="cp-hint">Pořadí změníš přetažením za úchyt.</div>
      <div className="cp-sec">Zobrazení</div>
      <div className="cp-cr">Propka pod názvem účtu<Sw on={settings.firm} onClick={() => set({ firm: !settings.firm })} /></div>
      <div className="cp-seg"><button type="button" className={settings.dense ? '' : 'on'} onClick={() => set({ dense: false })}>Běžné řádky</button><button type="button" className={settings.dense ? 'on' : ''} onClick={() => set({ dense: true })}>Kompaktní</button></div>
    </>
  ) : tab === 'strip' ? (
    <>
      <div className="cp-sec">Co ukazuje pruh skupiny</div>
      {COPIER_STRIP.map(x => <div key={x.key} className="cp-cr">{x.label}<Sw on={settings.strip.includes(x.key)} onClick={() => set({ strip: toggle(settings.strip, x.key) })} /></div>)}
      <div className="cp-sec">SL / TP v USD ukazuje</div>
      <div className="cp-seg"><button type="button" className={settings.sltp === 'sum' ? 'on' : ''} onClick={() => set({ sltp: 'sum' })}>Skupinu</button><button type="button" className={settings.sltp === 'avg' ? 'on' : ''} onClick={() => set({ sltp: 'avg' })}>Jeden účet (průměr)</button></div>
      <div className="cp-hint">Přepnout jde i klepnutím přímo na SL / TP. Čísla jsou za leadera i všechny followery; nejbližší DLL a nejmenší rezerva berou nejhorší účet.</div>
    </>
  ) : (
    <>
      <div className="cp-sec">Soukromí</div>
      <div className="cp-cr">Skrývat názvy účtů<Sw on={settings.redact} onClick={() => set({ redact: !settings.redact })} /></div>
      <div className="cp-hint">Na sdílené obrazovce nebo při nahrávání. Zbytek názvu nahradí tečky.</div>
      <div className="cp-nums">
        <label>Znaků na začátku<input type="number" min={0} max={12} value={settings.redactStart} onChange={(e) => set({ redactStart: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })} /></label>
        <label>Znaků na konci<input type="number" min={0} max={12} value={settings.redactEnd} onChange={(e) => set({ redactEnd: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })} /></label>
      </div>
      <div className="cp-prev">{sample} → {copierRedact(sample, settings.redactStart, settings.redactEnd)}</div>
    </>
  );
  const inner = (
    <>
      <div className="cp-sh"><div><b>Nastavení kopírky</b><small>Co vidíš a v jakém pořadí.</small></div><button type="button" className="cp-x" onClick={onClose}>×</button></div>
      <div className="cp-stabs">{([['cols', 'Sloupce'], ['strip', 'Pruh skupiny'], ['other', 'Ostatní']] as const).map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="cp-sb">{body}</div>
      <div className="cp-sf"><button type="button" className="cp-lnk" onClick={() => onChange({ ...COPIER_TABLE_DEFAULTS, order: [...COPIER_TABLE_DEFAULTS.order], hidden: [...COPIER_TABLE_DEFAULTS.hidden], strip: [...COPIER_TABLE_DEFAULTS.strip] })}>↺ Obnovit výchozí</button><span style={{ flex: 1 }} /><button type="button" className="cp-btn pri" onClick={onClose}>Hotovo</button></div>
    </>
  );
  if (asSheet) return <><div className="cp-scrim" onClick={onClose} /><div className="cp-sheet" style={{ padding: 0 }} onClick={(e) => e.stopPropagation()}>{inner}</div></>;
  return <div className="cp-side" onClick={(e) => e.stopPropagation()}>{inner}</div>;
}

// ── schéma skupiny (PC): leader vlevo, čáry k followerům. Do tří followerů vlastní karty s čarou ke každému,
// víc followerů = mřížka dlaždic s jednou sběrnou čárou. Čára teče jen u zapnuté skupiny a kopírujícího účtu,
// problémový účet má čáru červenou a přerušovanou. Čáry jsou JEN obrázek stavu (INV-UI-*).
type WireKind = 'live' | 'bad' | 'idle';
const wireOf = (a: CopierAccount, armed: boolean): WireKind => {
  const k = copierTileKind(a);
  if (k === 'bad' || k === 'prob') return 'bad';
  return armed && k === 'copy' ? 'live' : 'idle';
};
const NODE_MAX = 3;

export function CopierTiles({ view, group, settings, selectedId, onOpen }: {
  view: CopierView; group: CopierGroup; settings: CopierTableSettings; selectedId: string | null; onOpen: (id: string) => void;
}) {
  const leader = view.accounts[group.leaderId];
  const lo = leader ? copierOpenPnl(leader, view.price, view.pointValue) : 0;
  const followers = group.followerIds.map(id => view.accounts[id]).filter(Boolean) as CopierAccount[];
  const armed = group.state === 'armed';
  const nodes = followers.length > 0 && followers.length <= NODE_MAX;
  const box = useRef<HTMLDivElement>(null), leadRef = useRef<HTMLDivElement>(null), followRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<Array<{ id: string; d: string; kind: WireKind }>>([]);
  const gradId = `cp-wg-${group.id.replace(/[^a-z0-9_-]/gi, '')}`;
  const wireKey = followers.map(a => `${a.id}:${wireOf(a, armed)}`).join('|');
  useLayoutEffect(() => {
    const root = box.current, lead = leadRef.current, side = followRef.current;
    if (!root || !lead || !side || !followers.length) { setPaths([]); return undefined; }
    const measure = () => {
      const r = root.getBoundingClientRect(), l = lead.getBoundingClientRect();
      const x0 = l.right - r.left, y0 = l.top - r.top + l.height / 2;
      if (!nodes) {
        const g = side.getBoundingClientRect();
        const kind: WireKind = followers.some(a => wireOf(a, armed) === 'bad') ? 'bad' : armed && followers.some(a => wireOf(a, armed) === 'live') ? 'live' : 'idle';
        setPaths([{ id: 'bus', d: `M${x0},${y0} L${g.left - r.left - 4},${y0}`, kind }]);
        return;
      }
      setPaths([...side.querySelectorAll<HTMLElement>('[data-cp-node]')].map(n => {
        const b = n.getBoundingClientRect(), x1 = b.left - r.left, y1 = b.top - r.top + b.height / 2, m = (x0 + x1) / 2;
        const a = view.accounts[n.dataset.cpNode ?? ''];
        return { id: n.dataset.cpNode ?? '', d: `M${x0},${y0} C${m},${y0} ${m},${y1} ${x1},${y1}`, kind: a ? wireOf(a, armed) : 'idle' };
      }));
    };
    measure();
    // Karty při přepnutí skupiny vyjíždějí (animace) — změřit znovu, až doběhnou.
    const late = window.setTimeout(measure, 560);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(root);
    return () => { ro?.disconnect(); window.clearTimeout(late); };
  }, [nodes, wireKey, armed, group.id, followers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const leadCard = leader && <div ref={leadRef} className="cp-lead" data-cp-tile onClick={() => onOpen(leader.id)} style={{ position: 'relative', zIndex: 1 }}>
    <div className="cp-mut" style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>● Leader · {leader.firm}</div>
    <b style={{ display: 'block', fontSize: 15, marginTop: 2 }}>{shownName(leader, settings)}</b>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      {leader.position ? <span className="cp-chip g">{posText(leader).toUpperCase()}</span> : <span className="cp-chip">bez pozice</span>}
      {leader.position && <span className="cp-num cp-mut" style={{ fontSize: 11.5 }}>@ {fmtPrice(leader.position.averagePrice)}</span>}
    </div>
    <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 8 }}><span className="cp-mut" style={{ fontSize: 11 }}>otevřeno</span><b className={`cp-num ${tone(lo)}`} style={{ marginLeft: 'auto', fontSize: 15 }}>{usdText(lo)}</b></div>
  </div>;

  if (!followers.length) return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px,240px) 1fr', gap: 12, alignItems: 'start' }}>
      {leadCard}
      <div className="cp-mut" style={{ fontSize: 12, padding: '10px 4px', lineHeight: 1.45 }}>Zatím žádní followeři. Kopírka ve službě Rithmic se připravuje — tady uvidíš jejich dlaždice, jakmile půjdou přidat.</div>
    </div>
  );

  return (
    <div ref={box} className={`cp-flow${nodes ? ' nodes' : ''}`}>
      <svg className="cp-wires" aria-hidden>
        <defs><linearGradient id={gradId} x1="0" x2="1"><stop offset="0" stopColor="#818cf8" /><stop offset="1" stopColor="#5eead4" /></linearGradient></defs>
        {paths.map(p => <path key={p.id} d={p.d} className={`cp-wire ${p.kind}`} style={p.kind === 'live' ? { stroke: `url(#${gradId})` } : undefined} />)}
      </svg>
      <div className="cp-flow-lead">{leadCard}</div>
      {nodes
        ? <div ref={followRef} className="cp-nodes">{followers.map(a => {
          const o = copierOpenPnl(a, view.price, view.pointValue), k = copierTileKind(a);
          return (
            <button key={a.id} type="button" data-cp-tile data-cp-node={a.id} className={`cp-node ${k}${selectedId === a.id ? ' sel' : ''}`} onClick={() => onOpen(a.id)}>
              <span className="t"><FirmDot firm={a.firm} />{a.firm}<span className="cp-num" style={{ marginLeft: 'auto', letterSpacing: 0, textTransform: 'none' }}>{k === 'off' ? 'vypnuto' : a.copyOn && a.latencyMs != null ? `${a.latencyMs} ms` : '—'}</span></span>
              <b>{shownName(a, settings)}</b>
              <span className="row"><span className="cp-mut">{posText(a)} · {ratioText(a.ratio)}</span><b className={`cp-num ${a.position ? tone(o) : 'cp-mut'}`} style={{ marginLeft: 'auto' }}>{a.position ? usdText(o) : '—'}</b></span>
            </button>
          );
        })}</div>
        : <div ref={followRef} className="cp-tiles">{followers.map(a => {
          const o = copierOpenPnl(a, view.price, view.pointValue);
          return (
            <button key={a.id} type="button" data-cp-tile className={`cp-tile ${copierTileKind(a)}${armed && copierTileKind(a) === 'copy' ? ' armed' : ''}${selectedId === a.id ? ' sel' : ''}`} onClick={() => onOpen(a.id)} title={shownName(a, settings)}>
              <span className="t"><FirmDot firm={a.firm} />{settings.redact ? shownName(a, settings) : `•${a.name.split('•').pop()}`}<i>{ratioText(a.ratio)}</i></span>
              <b className={`cp-num ${a.position ? tone(o) : 'cp-mut'}`}>{a.position ? usdText(o) : '—'}</b>
            </button>
          );
        })}</div>}
    </div>
  );
}

const reducedMotionPref = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

// ── schéma skupiny (telefon): leader nahoře, od něj „kmen“ dolů a z něj odbočka ke každé řadě dlaždic.
// Stejné barvy čar jako na PC: teče u zapnuté skupiny, červená přerušovaná u problému, jinak tichá.
export function CopierPhoneFlow({ view, group, settings, onOpen }: { view: CopierView; group: CopierGroup; settings: CopierTableSettings; onOpen: (id: string) => void }) {
  const leader = view.accounts[group.leaderId];
  const followers = group.followerIds.map(id => view.accounts[id]).filter(Boolean) as CopierAccount[];
  const armed = group.state === 'armed';
  const lo = leader ? copierOpenPnl(leader, view.price, view.pointValue) : 0;
  const box = useRef<HTMLDivElement>(null), leadRef = useRef<HTMLDivElement>(null), gridRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<Array<{ id: string; d: string; kind: WireKind }>>([]);
  const gradId = `cp-pwg-${group.id.replace(/[^a-z0-9_-]/gi, '')}`;
  const wireKey = followers.map(a => `${a.id}:${wireOf(a, armed)}`).join('|');
  useLayoutEffect(() => {
    const root = box.current, lead = leadRef.current, grid = gridRef.current;
    if (!root || !lead || !grid || !followers.length) { setPaths([]); return undefined; }
    const measure = () => {
      const r = root.getBoundingClientRect(), l = lead.getBoundingClientRect();
      const x = 9, y0 = l.bottom - r.top - 4;
      const rows = new Map<number, { y: number; x: number; kinds: WireKind[] }>();
      grid.querySelectorAll<HTMLElement>('[data-cp-mt]').forEach(t => {
        const b = t.getBoundingClientRect(), top = Math.round(b.top - r.top);
        const row = rows.get(top) ?? { y: top + b.height / 2, x: b.left - r.left, kinds: [] };
        const a = view.accounts[t.dataset.cpMt ?? ''];
        row.kinds.push(a ? wireOf(a, armed) : 'idle'); row.x = Math.min(row.x, b.left - r.left); rows.set(top, row);
      });
      const list = [...rows.values()].sort((p, q) => p.y - q.y);
      const kindOf = (ks: WireKind[]): WireKind => (ks.includes('bad') ? 'bad' : ks.includes('live') ? 'live' : 'idle');
      const out = list.map((row, i) => ({ id: `r${i}`, d: `M${x},${y0} L${x},${row.y - 8} Q${x},${row.y} ${x + 8},${row.y} L${row.x - 2},${row.y}`, kind: kindOf(row.kinds) }));
      setPaths(out);
    };
    measure();
    const late = window.setTimeout(measure, 560);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(root);
    return () => { ro?.disconnect(); window.clearTimeout(late); };
  }, [wireKey, armed, group.id, followers.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={box} className="cp-pflow">
      <svg className="cp-wires" aria-hidden>
        <defs><linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#818cf8" /><stop offset="1" stopColor="#5eead4" /></linearGradient></defs>
        {paths.map(p => <path key={p.id} d={p.d} className={`cp-wire ${p.kind}`} style={p.kind === 'live' ? { stroke: `url(#${gradId})` } : undefined} />)}
      </svg>
      {leader && <div ref={leadRef} data-cp-tile className="cp-plead" onClick={() => onOpen(leader.id)}>
        <span className="cp-chip a">Leader</span><b style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shownName(leader, settings)}</b>
        <span className="cp-mut" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{leader.position ? `${leader.position.side === 'long' ? 'Long' : 'Short'} ${leader.position.quantity}` : 'bez pozice'}</span>
        <span style={{ flex: 1 }} /><b className={`cp-num ${lo >= 0 ? 'cp-win' : 'cp-loss'}`} style={{ fontSize: 13 }}>{leader.position ? usdText(lo) : '—'}</b>
      </div>}
      {followers.length === 0
        ? <div className="cp-mut" style={{ fontSize: 12, padding: '8px 0 2px 22px' }}>Zatím žádní followeři.</div>
        : <div ref={gridRef} className="cp-mgrid">{followers.map(a => { const o = copierOpenPnl(a, view.price, view.pointValue); return (
          <button key={a.id} type="button" data-cp-tile data-cp-mt={a.id} className={`cp-mt ${copierTileKind(a)}`} onClick={() => onOpen(a.id)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><FirmDot firm={a.firm} />{settings.redact ? shownName(a, settings) : `•${a.name.split('•').pop()}`}</span>
            <b className={`cp-num ${a.position ? (o >= 0 ? 'cp-win' : 'cp-loss') : 'cp-mut'}`}>{a.position ? usdText(o) : '—'}</b>
          </button>); })}</div>}
    </div>
  );
}

// ── záložky skupin: posuvný ukazatel pod vybranou skupinou, nová skupina „vyskočí“, smazaná se stáhne.
export function CopierGroupTabs({ groups, index, onSelect, renamingId, onRename, onRenameEnd, freshId, removingId }: {
  groups: CopierGroup[]; index: number; onSelect: (i: number) => void;
  renamingId?: string | null; onRename?: (id: string, name: string) => void; onRenameEnd?: () => void;
  freshId?: string | null; removingId?: string | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => { const g = groups.find(x => x.id === renamingId); if (g) setDraft(g.name); }, [renamingId]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const measure = () => {
      const b = box.current?.querySelectorAll<HTMLElement>('[data-cp-gtab]')[index];
      setInd(b ? { x: b.offsetLeft, w: b.offsetWidth } : null);
    };
    measure();
    const t = window.setTimeout(measure, 380); // po doběhnutí animace nové / mazané záložky
    return () => window.clearTimeout(t);
  }, [index, groups.length, groups.map(g => g.name).join('|'), renamingId, removingId]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (id: string) => { const n = draft.trim(); if (n && onRename) onRename(id, n); onRenameEnd?.(); };
  return (
    <div ref={box} className="cp-gtabs">
      {ind && <span className="cp-gind" style={{ transform: `translateX(${ind.x - 3}px)`, width: ind.w }} />}
      {groups.map((g, i) => (
        <button key={g.id} type="button" data-cp-gtab className={`${i === index ? 'on' : ''}${g.id === freshId ? ' fresh' : ''}${g.id === removingId ? ' out' : ''}`}
          onClick={(e) => { e.stopPropagation(); if (renamingId !== g.id) onSelect(i); }}
          onDoubleClick={(e) => { e.stopPropagation(); }}>
          <i className={`cp-dot ${g.state}`} />
          {renamingId === g.id
            ? <input className="cp-gren" value={draft} autoFocus size={Math.max(6, draft.length)} onChange={(e) => setDraft(e.target.value)} onClick={(e) => e.stopPropagation()}
              onBlur={() => commit(g.id)} onKeyDown={(e) => { if (e.key === 'Enter') commit(g.id); if (e.key === 'Escape') onRenameEnd?.(); }} />
            : g.name}
          <small>1 → {g.followerIds.length}</small>
        </button>
      ))}
    </div>
  );
}

// ── průvodce novou skupinou (PC): název a leader → followeři → pravidla → souhrn.
// Účet smí být jen v jedné skupině (jinak by se obchod kopíroval dvakrát). Skupina vzniká VYPNUTÁ.
export interface CopierNewGroup { name: string; leaderId: string; followerIds: string[]; ratio: number; /** null = bez stropu */ maxContracts: number | null }
export function CopierGroupWizard({ view, onClose, onCreate }: { view: CopierView; onClose: () => void; onCreate: (g: CopierNewGroup) => void }) {
  const [step, setStep] = useState(0), [name, setName] = useState(`Skupina ${view.groups.length + 1}`);
  const [lead, setLead] = useState<string | null>(null), [fol, setFol] = useState<Set<string>>(new Set());
  const [ratio, setRatio] = useState(1), [max, setMax] = useState(3), [capOn, setCapOn] = useState(false), [firm, setFirm] = useState('all');
  // Směr animace kroku: dopředu se obsah vysune zprava, zpět zleva.
  const [dir, setDir] = useState<1 | -1>(1);
  const go = (d: 1 | -1) => { setDir(d); setStep(s => s + d); };
  // Po založení karta průvodce odletí nahoru k záložkám skupin, kde se objeví nová skupina.
  const [leaving, setLeaving] = useState(false);
  // Volné účty nahoru: obsazené (v jiné skupině, zamčené) jsou vidět, ale vybrat nejdou.
  const all = Object.values(view.accounts);
  const role = (id: string): string => {
    for (const g of view.groups) {
      if (g.leaderId === id) return `leader skupiny ${g.name}`;
      if (g.followerIds.includes(id)) return `follower ve skupině ${g.name}`;
    }
    return '';
  };
  const why = (a: CopierAccount, asFollower: boolean): string => {
    if (asFollower && a.id === lead) return 'je leader';
    const r = role(a.id); if (r) return r;
    if (a.status !== 'active') return a.status === 'breached' ? 'breached' : a.status === 'dll-locked' ? 'limit dne' : 'neověřitelný';
    return '';
  };
  const byFree = (asFollower: boolean) => [...all].sort((x, y) => Number(Boolean(why(x, asFollower))) - Number(Boolean(why(y, asFollower))));
  const firms = [...new Set(all.map(a => a.firm))];
  const steps = ['Název a leader', 'Followeři', 'Pravidla', 'Souhrn'];
  const leadAcc = lead ? view.accounts[lead] : null;
  const shown = byFree(true).filter(a => firm === 'all' || a.firm === firm);
  const free = shown.filter(a => !why(a, true));
  const can = step === 0 ? Boolean(lead && name.trim()) : step === 1 ? fol.size > 0 : true;
  const toggle = (id: string) => setFol(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const cross = leadAcc ? [...fol].some(id => view.accounts[id]?.firm !== leadAcc.firm) : false;
  const row = (a: CopierAccount, on: boolean, reason: string, onPick: () => void, square: boolean) => (
    <button key={a.id} type="button" className={`cp-arow${on ? ' on' : ''}${reason ? ' dis' : ''}`} disabled={Boolean(reason)} onClick={onPick}>
      <span className={`rb${square ? ' sq' : ''}`}>{on ? '✓' : ''}</span>
      <span><b><FirmDot firm={a.firm} />{a.name}</b><small>{a.firm}{!reason && leadAcc && square && a.firm !== leadAcc.firm ? <span className="cp-warn"> · jiná propka</span> : null}</small></span>
      <span className="why">{reason || 'volný'}</span>
    </button>
  );
  return (
    <div className={`cp-wiz${leaving ? ' out' : ''}`} onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !leaving) onClose(); }}>
      <div className={`cp-wizc${leaving ? ' out' : ''}`} role="dialog" aria-label="Nová skupina">
        <div className="cp-wizh"><span className="cp-chip a">{step + 1} / 4</span><h2>Nová skupina · {steps[step]}</h2><button type="button" className="x" onClick={onClose} aria-label="Zavřít">×</button></div>
        <div className="cp-wizs">{steps.map((s, i) => <span key={s} className={i <= step ? 'on' : ''}><i /></span>)}</div>
        <div className={`cp-wizb ${dir > 0 ? 'fwd' : 'back'}`} key={step}>
          {step === 0 && <>
            <div className="lbl">Název skupiny</div>
            <input className="nm" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <div className="lbl">Leader · účet, na kterém obchoduješ</div>
            <div className="cp-alist">{byFree(false).map(a => { const r = why(a, false); return row(a, lead === a.id, r, () => { setLead(a.id); setFol(prev => { const n = new Set(prev); n.delete(a.id); return n; }); }, false); })}</div>
          </>}
          {step === 1 && leadAcc && <>
            <div className="lbl">Followeři pro {leadAcc.name} · vybráno {fol.size}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <div className="cp-fchips">{[['all', 'Všechny'], ...firms.map(f => [f, f])].map(([k, l]) => <button key={k} type="button" className={firm === k ? 'on' : ''} onClick={() => setFirm(k)}>{l}</button>)}</div>
              <span style={{ flex: 1 }} />
              <button type="button" className="cp-btn" style={{ height: 26, fontSize: 11.5 }} onClick={() => setFol(prev => new Set([...prev, ...free.map(a => a.id)]))}>Vybrat všechny volné ({free.length})</button>
            </div>
            <div className="cp-alist">{shown.map(a => row(a, fol.has(a.id), why(a, true), () => toggle(a.id), true))}</div>
            <div className="cp-mut" style={{ fontSize: 11, marginTop: 8 }}>Účet smí být jen v jedné skupině, aby se žádný obchod nekopíroval dvakrát.</div>
          </>}
          {step === 2 && <>
            <div className="lbl">Výchozí poměr pro všechny followery</div>
            <div className="cp-fchips">{[0.5, 1, 2].map(r => <button key={r} type="button" className={ratio === r ? 'on' : ''} onClick={() => setRatio(r)}>{ratioText(r)}</button>)}</div>
            <div className="lbl">Strop kontraktů na účet</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 32 }}>
              <button type="button" role="switch" aria-checked={capOn} className={`cp-capsw${capOn ? ' on' : ''}`} onClick={() => setCapOn(v => !v)}><i /></button>
              <span className="cp-dim" style={{ fontSize: 12.5, fontWeight: 700 }}>{capOn ? 'Strop zapnutý' : 'Bez stropu — follower kopíruje celou velikost podle poměru'}</span>
              <div className={`cp-cap${capOn ? ' on' : ''}`} aria-hidden={!capOn}>
                <button type="button" className="cp-btn" tabIndex={capOn ? 0 : -1} style={{ width: 30, height: 30, padding: 0, justifyContent: 'center' }} onClick={() => setMax(m => Math.max(1, m - 1))}>−</button>
                <b className="cp-num" style={{ fontSize: 16 }}>{max} MNQ</b>
                <button type="button" className="cp-btn" tabIndex={capOn ? 0 : -1} style={{ width: 30, height: 30, padding: 0, justifyContent: 'center' }} onClick={() => setMax(m => Math.min(10, m + 1))}>+</button>
              </div>
            </div>
            <div className="cp-inner" style={{ marginTop: 12, fontSize: 12 }}>🔒 Při neshodě se celá skupina zastaví a nic se nedorovnává obchodem. Tohle vypnout nejde.</div>
            {cross && <div className="cp-inner cp-warn" style={{ marginTop: 8, fontSize: 12 }}>⚠ Ve skupině jsou účty u různých propek. Ověř, že to jejich pravidla dovolují.</div>}
            <div className="cp-mut" style={{ fontSize: 11, marginTop: 8 }}>Poměr a strop jde potom změnit u každého účtu zvlášť.</div>
          </>}
          {step === 3 && leadAcc && <>
            <div className="cp-wizprev"><div className="lc"><FirmDot firm={leadAcc.firm} />{leadAcc.name}</div><span className="arr" /><div className="fc">{[...fol].map(id => <span key={id} className="cp-chip">{view.accounts[id]?.name}</span>)}</div></div>
            <div className="cp-wizsum"><div><small>Followerů</small><b>{fol.size}</b></div><div><small>Poměr · strop</small><b>{ratioText(ratio)} · {capOn ? `${max} MNQ` : 'bez stropu'}</b></div><div><small>Stav po založení</small><b className="cp-warn">VYPNUTÁ</b></div></div>
            <div className="cp-mut" style={{ fontSize: 11.5, marginTop: 10 }}>Skupina vznikne vypnutá. Kopírovat začne až po zapnutí, které projde všemi pojistkami.</div>
          </>}
        </div>
        <div className="cp-wizf">
          {step > 0 && <button type="button" className="cp-btn" onClick={() => go(-1)}>← Zpět</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="cp-btn pri" disabled={!can} onClick={() => {
            if (step < 3) { go(1); return; }
            if (leaving) return;
            const created: CopierNewGroup = { name: name.trim(), leaderId: lead!, followerIds: [...fol], ratio, maxContracts: capOn ? max : null };
            setLeaving(true);
            window.setTimeout(() => onCreate(created), reducedMotionPref() ? 0 : 430);
          }}>{step === 3 ? 'Založit skupinu' : 'Další →'}</button>
        </div>
      </div>
    </div>
  );
}

// ── tabulka followerů
type Filter = 'all' | 'copy' | 'off' | 'prob';
export function CopierFollowerTable({ view, group, settings, edit, selectedId, onOpen, onToggleCopy, onBulk }: {
  view: CopierView; group: CopierGroup; settings: CopierTableSettings; edit: boolean; selectedId: string | null;
  onOpen: (id: string) => void; onToggleCopy?: (id: string) => void; onBulk?: (action: 'on' | 'off' | 'ratio', ids: string[], value?: number) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all'), [q, setQ] = useState(''), [sort, setSort] = useState<'name' | 'day' | 'dll' | 'dd' | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => { if (!edit) { setSel(new Set()); setFilter('all'); setQ(''); } }, [edit]);
  const leader = view.accounts[group.leaderId];
  const all = group.followerIds.map(id => view.accounts[id]).filter(Boolean) as CopierAccount[];
  const kindOf = (a: CopierAccount) => copierTileKind(a);
  const counts = { all: all.length, copy: all.filter(a => kindOf(a) === 'copy').length, off: all.filter(a => kindOf(a) === 'off').length, prob: all.filter(a => ['bad', 'prob', 'lock'].includes(kindOf(a))).length };
  let rows = all;
  if (filter === 'copy') rows = rows.filter(a => kindOf(a) === 'copy'); else if (filter === 'off') rows = rows.filter(a => kindOf(a) === 'off'); else if (filter === 'prob') rows = rows.filter(a => ['bad', 'prob', 'lock'].includes(kindOf(a)));
  if (q) rows = rows.filter(a => `${a.name} ${a.firm}`.toLowerCase().includes(q.toLowerCase()));
  const risk = (a: CopierAccount) => copierRisk(a, view.price, view.pointValue);
  if (sort === 'name') rows = [...rows].sort((x, y) => x.name.localeCompare(y.name));
  if (sort === 'day') rows = [...rows].sort((x, y) => (copierDayPnl(x, view.price, view.pointValue) ?? 0) - (copierDayPnl(y, view.price, view.pointValue) ?? 0));
  if (sort === 'dll') rows = [...rows].sort((x, y) => (risk(x).dllLeft ?? 1e9) - (risk(y).dllLeft ?? 1e9));
  if (sort === 'dd') rows = [...rows].sort((x, y) => (risk(x).ddLeft ?? 1e9) - (risk(y).ddLeft ?? 1e9));
  const cols = useMemo(() => settings.order.map(k => COPIER_COLUMNS.find(c => c.key === k)!).filter(c => c && !settings.hidden.includes(c.key)), [settings.order, settings.hidden]);
  const grid = `${edit ? '20px ' : ''}30px minmax(140px,1.5fr) ${cols.map(c => `${c.width}px`).join(' ')}`;
  const armed = group.state === 'armed';
  const allSel = rows.length > 0 && rows.every(a => sel.has(a.id));
  const cell = (a: CopierAccount, k: CopierColumnKey): React.ReactNode => {
    const o = copierOpenPnl(a, view.price, view.pointValue), r = risk(a), v = copierSltpUsd(a, view.pointValue);
    const warn = (x: number | null, max: number | null) => (x == null ? '' : x <= 0 ? 'cp-loss' : max && x < max * 0.3 ? 'cp-warn' : '');
    switch (k) {
      case 'balance': return <b className="cp-num">{plainUsd(a.balance == null ? null : a.balance + o)}</b>;
      case 'position': return <span className={`cp-num${a.brokerQuantity != null ? ' cp-loss' : ''}`}>{a.brokerQuantity != null ? `${posText(a)} ≠ ${a.position?.quantity ?? 0}` : posText(a)}</span>;
      case 'day': { const d = copierDayPnl(a, view.price, view.pointValue); return <b className={`cp-num ${tone(d)}`}>{usdText(d)}</b>; }
      case 'dll': return <b className={`cp-num ${warn(r.dllLeft, a.dailyLossLimit)}`}>{r.dllLeft == null ? '—' : r.dllLeft <= 0 ? 'vyčerpán' : plainUsd(r.dllLeft)}</b>;
      case 'open': return <b className={`cp-num ${a.position ? tone(o) : 'cp-mut'}`}>{a.position ? usdText(o) : '—'}</b>;
      case 'sl': return !a.position ? <span className="cp-mut">—</span> : a.position.stop == null ? <span className="cp-chip r">chybí</span> : <><span className="cp-num cp-loss">{fmtPrice(a.position.stop)}</span><small className={`cp-num ${tone(v?.sl ?? null)}`}>{usdText(v?.sl ?? null)}</small></>;
      case 'tp': return !a.position ? <span className="cp-mut">—</span> : a.position.stop == null || a.position.target == null ? <span className="cp-chip r">chybí</span> : <><span className="cp-num cp-win">{fmtPrice(a.position.target)}</span><small className={`cp-num ${tone(v?.tp ?? null)}`}>{usdText(v?.tp ?? null)}</small></>;
      case 'dd': return <b className={`cp-num ${warn(r.ddLeft, a.drawdownMax)}`}>{r.ddLeft == null ? '—' : plainUsd(r.ddLeft)}</b>;
      case 'ratio': return <span className="cp-num">{ratioText(a.ratio)}{a.maxContracts == null ? '' : ` · ${a.maxContracts}`}</span>;
      case 'latency': return <span className="cp-num">{a.copyOn && a.status === 'active' && a.latencyMs != null ? `${a.latencyMs} ms` : '—'}</span>;
      case 'limit': return <span className={`cp-num${a.maxContracts == null ? ' cp-mut' : ''}`}>{limitText(a.maxContracts)}</span>;
      case 'link': return <span className="cp-mut">Rithmic · Mac</span>;
      default: return statusChip(a, armed);
    }
  };
  return (
    <>
      {edit && <div className="cp-fth">
        <div className="cp-fchips">{([['all', 'Vše'], ['copy', 'Kopíruje'], ['off', 'Vypnuté'], ['prob', 'Problém']] as const).map(([k, l]) => <button key={k} type="button" className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}<i>{counts[k]}</i></button>)}</div>
        <span style={{ flex: 1 }} /><input className="cp-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hledat účet…" />
      </div>}
      {edit && onBulk && sel.size > 0 && <div className="cp-bulk">
        <b>Vybráno {sel.size}</b>
        <button type="button" className="cp-btn" onClick={() => onBulk('off', [...sel])}>Vypnout</button><button type="button" className="cp-btn" onClick={() => onBulk('on', [...sel])}>Zapnout</button>
        <span className="cp-mut">Poměr</span>{[0.5, 1, 2].map(r => <button key={r} type="button" className="cp-btn" onClick={() => onBulk('ratio', [...sel], r)}>{ratioText(r)}</button>)}
        <span style={{ flex: 1 }} /><button type="button" className="cp-btn" onClick={() => setSel(new Set())}>Zrušit výběr</button>
      </div>}
      <div className={`cp-tab${settings.dense ? ' dense' : ''}`}>
        <div className="cp-fr hd" style={{ gridTemplateColumns: grid }}>
          {edit && <span className={`cp-ck${allSel ? ' on' : ''}`} onClick={() => setSel(allSel ? new Set() : new Set(rows.map(a => a.id)))}>{allSel ? '✓' : ''}</span>}
          <span>Zap.</span><span data-sort onClick={() => setSort(s => (s === 'name' ? null : 'name'))}>Účet{sort === 'name' ? ' ▾' : ''}</span>
          {cols.map(c => <span key={c.key} className={c.right ? 'r' : ''} {...(c.sort ? { 'data-sort': true, onClick: () => setSort(s => (s === c.sort ? null : c.sort!)) } : {})}>{c.label}{c.sort ? (sort === c.sort ? ' ▴' : ' ↕') : ''}</span>)}
        </div>
        {rows.length ? rows.map(a => (
          <div key={a.id} data-cp-row={a.id} className={`cp-fr${selectedId === a.id ? ' sel' : ''}${a.status === 'breached' ? ' dead' : ''}${copierUnprotected(a) ? ' noprot' : ''}`} style={{ gridTemplateColumns: grid }} onClick={() => onOpen(a.id)}>
            {edit && <span className={`cp-ck${sel.has(a.id) ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); setSel(s => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; }); }}>{sel.has(a.id) ? '✓' : ''}</span>}
            <button type="button" className={`cp-sw${a.copyOn ? ' on' : ''}`} disabled={!onToggleCopy} style={onToggleCopy ? undefined : { opacity: 0.5, cursor: 'default' }} onClick={(e) => { e.stopPropagation(); onToggleCopy?.(a.id); }} aria-label={`Kopírování ${a.name}`} />
            <span className="nm"><b><FirmDot firm={a.firm} />{shownName(a, settings)}</b>{settings.firm && <small>{a.firm}{leader && a.firm !== leader.firm ? <> · <span className="cp-warn">jiná propka</span></> : null}</small>}</span>
            {cols.map(c => <span key={c.key} className={c.right ? 'r' : ''}>{cell(a, c.key)}</span>)}
          </div>
        )) : <div className="cp-mut" style={{ padding: 16, fontSize: 12 }}>{all.length ? 'Nic neodpovídá filtru.' : 'Zatím žádní followeři. Přidat je půjde, až bude kopírka ve službě Rithmic.'}</div>}
      </div>
    </>
  );
}

// ── detail účtu (PC panel / telefon spodní list)
export function CopierAccountDetail({ view, group, id, settings, asSheet, onClose, onToggleCopy, onFixProtection, onClosePosition }: {
  view: CopierView; group: CopierGroup; id: string; settings: CopierTableSettings; asSheet: boolean; onClose: () => void;
  onToggleCopy?: (id: string) => void; onFixProtection?: (id: string) => void; onClosePosition?: (id: string) => void;
}) {
  const a = view.accounts[id]; if (!a) return null;
  const leader = view.accounts[group.leaderId], isLead = id === group.leaderId;
  const o = copierOpenPnl(a, view.price, view.pointValue), d = copierDayPnl(a, view.price, view.pointValue), r = copierRisk(a, view.price, view.pointValue), v = copierSltpUsd(a, view.pointValue);
  const naked = copierUnprotected(a);
  const slip = a.position && leader?.position && !isLead ? a.position.averagePrice - leader.position.averagePrice : null;
  const bar = (x: number | null, max: number | null, c: string) => <div className="cp-trk"><i style={{ width: `${x == null || !max ? 0 : Math.max(0, Math.min(100, (x / max) * 100))}%`, background: x != null && max && x < max * 0.3 ? 'var(--cp-loss)' : c }} /></div>;
  const body = (
    <div className={asSheet ? '' : 'cp-det'} style={asSheet ? {} : { overflow: 'auto', flex: 1 }}>
      {asSheet && <div className="cp-grab" onClick={onClose} />}
      <h3 style={asSheet ? { margin: 0, fontSize: 17, display: 'flex', alignItems: 'center', gap: 8 } : undefined}>
        <FirmDot firm={a.firm} />{shownName(a, settings)}
        {isLead ? <span className="cp-chip a">leader</span> : statusChip(a, group.state === 'armed')}
        {!isLead && onToggleCopy && <button type="button" className={`cp-sw${a.copyOn ? ' on' : ''}`} style={{ marginLeft: 'auto' }} onClick={() => onToggleCopy(a.id)} aria-label="Kopírování" />}
        {!asSheet && <button type="button" className="cp-x" style={isLead ? undefined : { marginLeft: 8 }} onClick={onClose}>×</button>}
      </h3>
      <div className="cp-mut" style={{ fontSize: 11.5, marginTop: 3 }}>{a.firm} · {isLead ? 'tady obchoduješ v LIVE' : a.copyOn ? 'kopírování zapnuté' : 'kopírování vypnuté'}{leader && a.firm !== leader.firm ? <> · <span className="cp-warn">jiná propka</span></> : null}</div>
      {naked && <div className="cp-np"><b>⚠ Pozice bez SL/TP</b><span>Ochrana u brokera chybí. Ztráta tohoto účtu teď není omezená a v SL skupiny chybí. Kopírka nic neposílá sama.</span>
        {onFixProtection && onClosePosition ? <div className="act"><button type="button" className="cp-btn pri" onClick={() => onFixProtection(a.id)}>Doplnit SL/TP podle leadera</button><button type="button" className="cp-btn red" onClick={() => onClosePosition(a.id)}>Zavřít pozici účtu</button></div>
          : <span style={{ marginTop: 8 }}>SL doplníš nebo pozici zavřeš v grafu LIVE.</span>}
        <small>{leader?.position?.stop != null ? `SL ${fmtPrice(leader.position.stop)}${leader.position.target != null ? ` · TP ${fmtPrice(leader.position.target)}` : ''} · ` : ''}jen ochranné příkazy, pozici nemění</small></div>}
      <div className="cp-bal"><div><small>Zůstatek</small><b className="cp-num">{plainUsd(a.balance == null ? null : a.balance + o)}</b></div></div>
      <div className="cp-edg">
        <div><small>Denní P&L</small><b className={`cp-num ${tone(d)}`}>{usdText(d)}</b><em>{a.realizedToday == null ? 'realizované zatím nepřišlo' : `realizováno ${usdText(a.realizedToday)}`}</em></div>
        <div><small>Otevřený P&L</small><b className={`cp-num ${a.position ? tone(o) : ''}`}>{a.position ? usdText(o) : '—'}</b><em>{a.position ? `${posText(a)} @ ${fmtPrice(a.position.averagePrice)}` : 'bez pozice'}</em></div>
        <div><small>DLL zbývá</small><b className="cp-num">{r.dllLeft == null ? '—' : r.dllLeft <= 0 ? 'vyčerpán' : plainUsd(r.dllLeft)}</b>{bar(r.dllLeft, a.dailyLossLimit, 'linear-gradient(90deg,var(--cp-warn),var(--cp-win))')}<em>{a.dailyLossLimit == null ? 'bez denního limitu' : `limit ${plainUsd(a.dailyLossLimit)}`}</em></div>
        <div><small>Rezerva DD</small><b className="cp-num">{r.ddLeft == null ? '—' : plainUsd(r.ddLeft)}</b>{bar(r.ddLeft, a.drawdownMax, 'linear-gradient(90deg,var(--cp-warn),var(--cp-accent))')}<em>{a.drawdownMax == null ? '—' : `trailing ${plainUsd(a.drawdownMax)}`}</em></div>
        <div><small>SL / TP</small><b className="cp-num">{!a.position ? '—' : naked ? <span className="cp-loss">chybí</span> : <><span className={tone(v?.sl ?? null)}>{usdText(v?.sl ?? null)}</span> / <span className={tone(v?.tp ?? null)}>{usdText(v?.tp ?? null)}</span></>}</b>
          <em>{!a.position ? 'nic čekajícího' : naked ? 'pozice bez ochrany' : `${fmtPrice(a.position.stop!)} / ${a.position.target != null ? fmtPrice(a.position.target) : '—'}`}</em></div>
        <div><small>Kopie</small><b className="cp-num">{isLead ? 'leader' : a.copyOn && a.status === 'active' && a.latencyMs != null ? `${a.latencyMs} ms` : '—'}</b><em>{isLead ? 'zdroj obchodů' : slip != null ? `skluz ${slip >= 0 ? '+' : '−'}${Math.abs(slip).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} b` : 'čeká na obchod'}</em></div>
      </div>
      {!isLead && <><div className="cp-rl"><span><small>Poměr</small>{ratioText(a.ratio)}</span><span><small>Strop</small>{limitText(a.maxContracts)}</span><span><small>Leader 2 →</small>{Math.max(1, Math.round(2 * a.ratio))} ks</span></div>
        <div className="cp-mut" style={{ fontSize: 11, marginTop: 8 }}>Poměr a strop se mění jen u vypnuté kopírky. Vypnout kopírování účtu jde jen bez pozice.</div></>}
    </div>
  );
  if (asSheet) return <><div className="cp-scrim" onClick={onClose} /><div className="cp-sheet" onClick={(e) => e.stopPropagation()}>{body}</div></>;
  return <div className="cp-side" onClick={(e) => e.stopPropagation()}>{body}</div>;
}
