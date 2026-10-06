/**
 * Náhled nových úprav dashboardu (jen mockup, nic se neukládá):
 * skutečná mřížka react-grid-layout s Filipovým rozložením, minimum velikosti
 * držené i vizuálně, štítek velikosti, prohození stejně velkých widgetů,
 * přidávání tažením/klikem z doku, Zpět / Zrušit / Obnovit výchozí, animace
 * a dopočítané rozložení pro střední šířku (6 sloupců).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  GridLayout, useContainerWidth, verticalCompactor, moveElement, cloneLayout, getLayoutItem,
} from 'react-grid-layout';
import type { Layout, LayoutItem } from 'react-grid-layout';
import type { Compactor } from 'react-grid-layout/core';
import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion';
import '../index.css';
import './dashboard-edit-preview.css';

type Item = LayoutItem & { label: string };
const MARGIN = 12;
const ROW = 80;

const DEFAULT: Item[] = [
  { i: 'kpi_pnl', label: 'Net P&L', x: 0, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'kpi_winrate', label: 'Win Rate', x: 2, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'kpi_profit_factor', label: 'Profit Factor', x: 4, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'kpi_day_winrate', label: 'Day win %', x: 6, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'prop_drawdown_room', label: 'DD prostor', x: 8, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'avg_win_loss', label: 'Avg Win/Loss', x: 10, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'equity', label: 'Equity křivka', x: 0, y: 2, w: 6, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { i: 'calendar', label: 'Kalendář', x: 6, y: 2, w: 6, h: 6, minW: 4, minH: 5, maxW: 12, maxH: 10 },
];

type Category = 'Výkon' | 'Riziko' | 'Disciplína' | 'Analýza';
type Meta = Omit<Item, 'x' | 'y'> & { icon: string; hint: string; cat: Category };
/** Všechny widgety (na ploše i v knihovně) s výchozí velikostí. */
const CATALOG: Meta[] = [
  { i: 'kpi_pnl', label: 'Net P&L', icon: '$', hint: 'čistý výsledek', cat: 'Výkon', w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'kpi_winrate', label: 'Win Rate', icon: '%', hint: 'úspěšnost obchodů', cat: 'Výkon', w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'kpi_profit_factor', label: 'Profit Factor', icon: 'PF', hint: 'zisky / ztráty', cat: 'Výkon', w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'kpi_day_winrate', label: 'Day win %', icon: 'D', hint: 'ziskové dny', cat: 'Výkon', w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'prop_drawdown_room', label: 'DD prostor', icon: '⇣', hint: 'rezerva do limitu', cat: 'Riziko', w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'avg_win_loss', label: 'Avg Win/Loss', icon: '±', hint: 'průměrná výhra / ztráta', cat: 'Výkon', w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { i: 'equity', label: 'Equity křivka', icon: '∿', hint: 'vývoj účtu', cat: 'Výkon', w: 6, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { i: 'calendar', label: 'Kalendář', icon: '▦', hint: 'výsledek po dnech', cat: 'Analýza', w: 6, h: 6, minW: 4, minH: 5, maxW: 12, maxH: 10 },
  { i: 'discipline', label: 'Disciplína', icon: '✓', hint: 'dodržení pravidel', cat: 'Disciplína', w: 4, h: 3, minW: 3, minH: 3, maxW: 8, maxH: 6 },
  { i: 'streak', label: 'Série', icon: '≋', hint: 'výher a proher', cat: 'Výkon', w: 2, h: 2, minW: 2, minH: 2, maxW: 4, maxH: 4 },
  { i: 'expectancy', label: 'Expectancy', icon: 'E', hint: 'průměr na obchod', cat: 'Výkon', w: 2, h: 2, minW: 2, minH: 2, maxW: 4, maxH: 4 },
  { i: 'long_short', label: 'Long vs Short', icon: '⇅', hint: 'výsledek podle směru', cat: 'Analýza', w: 4, h: 3, minW: 3, minH: 3, maxW: 8, maxH: 6 },
  { i: 'sessions', label: 'Seance', icon: '◷', hint: 'Londýn / NY', cat: 'Analýza', w: 4, h: 3, minW: 3, minH: 3, maxW: 8, maxH: 6 },
  { i: 'monte_carlo', label: 'Monte Carlo', icon: '⚄', hint: 'simulace účtu', cat: 'Riziko', w: 6, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { i: 'rule_breaks', label: 'Porušená pravidla', icon: '!', hint: 'co porušuješ nejčastěji', cat: 'Disciplína', w: 4, h: 3, minW: 3, minH: 3, maxW: 8, maxH: 6 },
  { i: 'risk_per_trade', label: 'Riziko na obchod', icon: 'R', hint: 'průměrné R a odchylky', cat: 'Riziko', w: 2, h: 2, minW: 2, minH: 2, maxW: 4, maxH: 4 },
];
const META = new Map(CATALOG.map(m => [m.i, m]));
const CATEGORIES: Category[] = ['Výkon', 'Riziko', 'Disciplína', 'Analýza'];

const KPI: Record<string, [string, string, string?]> = {
  kpi_pnl: ['+$22 725', 'win', 'obchody +$34 243'], kpi_winrate: ['48,6 %', '', '493 / 513'],
  kpi_profit_factor: ['1,43', '', ''], kpi_day_winrate: ['73,1 %', '', '87 dní'],
  prop_drawdown_room: ['$1 840', '', 'do limitu'], avg_win_loss: ['1,62', '', '$212 / $131'],
  streak: ['+4', 'win', 'aktuální série'], expectancy: ['+$44', 'win', 'na obchod'],
};

const Spark = () => (
  <svg className="dep-spark" viewBox="0 0 100 40" preserveAspectRatio="none">
    <path d="M0 34 L8 30 L14 32 L22 24 L30 26 L38 18 L46 22 L54 14 L62 17 L70 9 L78 12 L86 6 L100 4" fill="none" stroke="#10b981" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
  </svg>
);

const Widget = ({ item }: { item: Item }) => {
  const kpi = KPI[item.i];
  return (
    <div className="dep-card">
      <div className="dep-k">{item.label}</div>
      {kpi ? <><div className={`dep-v ${kpi[1]}`}>{kpi[0]}</div>{kpi[2] ? <div className="dep-sub">{kpi[2]}</div> : null}</>
        : item.i === 'calendar' ? <div className="dep-cal">{Array.from({ length: 35 }, (_, n) => <span key={n} className={n % 7 > 4 ? '' : n % 3 === 0 ? 'l' : n % 2 ? 'w' : ''} />)}</div>
          : <Spark />}
    </div>
  );
};

const plain = (layout: Layout, labels: Map<string, Item>): Item[] =>
  layout.filter(l => labels.has(l.i)).map(l => ({ ...labels.get(l.i)!, x: l.x, y: l.y, w: l.w, h: l.h }));

/** První volné místo shora zleva, kam se widget vejde. */
const firstFree = (items: Item[], w: number, h: number, cols: number) => {
  const hit = (x: number, y: number) => items.some(it => x < it.x + it.w && x + w > it.x && y < it.y + it.h && y + h > it.y);
  for (let y = 0; y < 200; y++) for (let x = 0; x + w <= cols; x++) if (!hit(x, y)) return { x, y };
  return { x: 0, y: Infinity };
};

/** Střední šířka (6 sloupců): KPI po třech, velké widgety přes celou šířku, pořadí jako na širokém. */
const packMid = (items: Item[]): Item[] => {
  let x = 0; let row = 0;
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Item[] = [];
  for (const it of sorted) {
    const w = it.w >= 6 ? 6 : Math.min(6, Math.max(2, Math.ceil(it.w / 2)));
    if (x + w > 6) { x = 0; row += 1; }
    out.push({ ...it, x, y: row * 100, w, static: true });
    x += w;
  }
  return verticalCompactor.compact(out, 6) as Item[];
};


/**
 * Rozložení během tažení, vždy počítané od stavu před začátkem tahu:
 * nad stejně velkým widgetem se oba prohodí (cíl odjede na původní místo
 * taženého), jinak tažený widget odtlačí ostatní dolů — udělá si místo.
 */
const arrange = (start: Layout, moving: LayoutItem, cols: number): { layout: Layout; swapWith: string | null } => {
  const origin = start.find(t => t.i === moving.i);
  const cx = moving.x + moving.w / 2; const cy = moving.y + moving.h / 2;
  const target = origin ? start.find(t => t.i !== moving.i && t.w === moving.w && t.h === moving.h
    && cx >= t.x && cx < t.x + t.w && cy >= t.y && cy < t.y + t.h) : undefined;
  if (origin && target) {
    return {
      swapWith: target.i,
      layout: start.map(t => t.i === moving.i ? { ...t, x: target.x, y: target.y } : t.i === target.i ? { ...t, x: origin.x, y: origin.y } : { ...t }),
    };
  }
  const clone = cloneLayout(start).filter(t => t.i !== moving.i);
  // Výchozí bod = původní místo (nový widget z doku „zespodu“): moveElement
  // nic neodtlačí, když položka už na cílové pozici stojí.
  const item = { ...moving, x: origin?.x ?? 0, y: origin?.y ?? 9999 };
  clone.push(item);
  const moved = moveElement(clone, getLayoutItem(clone, moving.i)!, moving.x, moving.y, true, false, 'vertical', cols, false);
  return { swapWith: null, layout: verticalCompactor.compact(moved, cols) };
};

/** Miniatura widgetu: zmenšený vzhled v poměru stran jeho výchozí velikosti. */
const MINI_KPI: Record<string, [string, string?]> = {
  kpi_pnl: ['+$22.7k', 'win'], kpi_winrate: ['48,6 %'], kpi_profit_factor: ['1,43'], kpi_day_winrate: ['73 %'],
  prop_drawdown_room: ['$1 840'], avg_win_loss: ['1,62'], streak: ['+4', 'win'], expectancy: ['+$44', 'win'], risk_per_trade: ['0,9R'],
};

const MiniBody = ({ id }: { id: string }) => {
  if (MINI_KPI[id]) {
    const [v, tone] = MINI_KPI[id];
    return (
      <>
        <span className={`dmw-v ${tone ?? ''}`}>{v}</span>
        {id === 'kpi_winrate' || id === 'kpi_day_winrate'
          ? <svg className="dmw-ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" className="dmw-ring-bg" /><circle cx="10" cy="10" r="7" className="dmw-ring-fg" strokeDasharray={`${id === 'kpi_winrate' ? 21 : 32} 44`} /></svg>
          : id === 'prop_drawdown_room' ? <span className="dmw-meter"><i style={{ width: '62%' }} /></span> : null}
      </>
    );
  }
  switch (id) {
    case 'equity':
      return <svg className="dmw-fill" viewBox="0 0 100 40" preserveAspectRatio="none"><path d="M0 36 L10 31 L18 33 L28 24 L36 26 L46 18 L55 21 L64 13 L72 15 L82 8 L90 10 L100 4 L100 40 L0 40Z" className="dmw-area" /><path d="M0 36 L10 31 L18 33 L28 24 L36 26 L46 18 L55 21 L64 13 L72 15 L82 8 L90 10 L100 4" className="dmw-line" vectorEffect="non-scaling-stroke" /></svg>;
    case 'calendar':
      return <span className="dmw-cal">{Array.from({ length: 35 }, (_, n) => <i key={n} className={n % 7 > 4 ? '' : n % 3 === 0 ? 'l' : n % 2 ? 'w' : ''} />)}</span>;
    case 'monte_carlo':
      return <svg className="dmw-fill" viewBox="0 0 100 40" preserveAspectRatio="none">{[4, 10, 16, 22, 28, 34].map((end, n) => <path key={n} d={`M0 22 C 30 ${22 - n}, 60 ${end + 2}, 100 ${end}`} className="dmw-fan" vectorEffect="non-scaling-stroke" />)}</svg>;
    case 'sessions':
      return <span className="dmw-bars">{[55, 85, 35].map((h, n) => <i key={n} style={{ height: `${h}%` }} className={n === 2 ? 'l' : 'w'} />)}</span>;
    case 'long_short':
      return <span className="dmw-split"><i className="w" style={{ width: '64%' }} /><i className="l" style={{ width: '36%' }} /></span>;
    case 'discipline':
      return <span className="dmw-checks">{[1, 1, 1, 0].map((ok, n) => <i key={n} className={ok ? 'ok' : ''} />)}</span>;
    case 'rule_breaks':
      return <span className="dmw-hbars">{[80, 55, 30].map((w, n) => <i key={n} style={{ width: `${w}%` }} />)}</span>;
    default:
      return null;
  }
};

const MiniWidget = ({ m }: { m: Meta }) => {
  // Rámeček má pevnou výšku; šířka podle poměru stran widgetu (sloupec ≈ 1, řádek ≈ 1,1).
  const ratio = (m.w * 1) / (m.h * 1.1);
  return (
    <span className="dmw-stage">
      <span className="dmw-card" style={{ aspectRatio: String(ratio), height: ratio > 1.8 ? 'auto' : '100%', width: ratio > 1.8 ? '100%' : 'auto' }}>
        <span className="dmw-k">{m.label}</span>
        <span className="dmw-body"><MiniBody id={m.i} /></span>
      </span>
    </span>
  );
};

const Library = ({ pool, onAdd, onDragStartItem, onDragEndItem }: {
  pool: Meta[];
  onAdd: (p: Meta) => void;
  onDragStartItem: (p: Meta) => void;
  onDragEndItem: () => void;
}) => {
  const [open, setOpen] = useState(true);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Category | 'Vše'>('Vše');
  const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const list = pool.filter(p => (cat === 'Vše' || p.cat === cat) && (!q || norm(`${p.label} ${p.hint}`).includes(norm(q))));
  return (
    <div className={`dep-lib${open ? ' dep-lib-open' : ''}`}>
      <div className="dep-lib-panel" aria-hidden={!open}>
        <div className="dep-lib-panel-in">
          <div className="dep-lib-head">
            <input className="dep-lib-search" placeholder="Hledat widget…" value={q} onChange={e => setQ(e.target.value)} />
            <div className="dep-seg">
              {(['Vše', ...CATEGORIES] as const).map(c => (
                <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
                  {c}{c !== 'Vše' ? <small> {pool.filter(p => p.cat === c).length}</small> : null}
                </button>
              ))}
            </div>
          </div>
          <div className="dep-lib-grid">
            {list.map((p, n) => (
              <div
                key={p.i}
                className="dep-lib-card"
                style={{ animationDelay: `${n * 0.03}s` }}
                draggable
                title="Přetáhni na místo na ploše, nebo klikni — přidá se do prvního volného místa"
                onDragStart={e => { onDragStartItem(p); e.dataTransfer.setData('text/plain', p.i); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={onDragEndItem}
                onClick={() => onAdd(p)}
              >
                <MiniWidget m={p} />
                <span className="dep-lib-meta">
                  <span className="dep-lib-txt"><b>{p.label}</b><small>{p.hint}</small></span>
                  <span className="dep-lib-dim">{p.w}×{p.h}</span>
                </span>
                <span className="dep-lib-plus">＋</span>
              </div>
            ))}
            {!list.length ? <p className="dep-lib-empty">{pool.length ? 'Nic neodpovídá hledání.' : 'Všechny widgety jsou na ploše.'}</p> : null}
          </div>
        </div>
      </div>
      <div className="dep-lib-bar">
        <button className="dep-btn primary" onClick={() => setOpen(o => !o)}>
          <span className="dep-lib-chev">＋</span> {open ? 'Skrýt knihovnu' : 'Přidat widget'}
          {pool.length ? <span className="dep-count">{pool.length}</span> : null}
        </button>
        <span className="dep-hint">{open ? 'Přetáhni kartu na plochu — widgety pod ní uhnou. Klik přidá do prvního volného místa.' : 'Knihovna widgetů'}</span>
      </div>
    </div>
  );
};

type PhoneRow = { i: string; half: boolean };
const canHalf = (i: string) => (META.get(i)?.w ?? 12) <= 2;

const PhoneWidget = ({ row }: { row: PhoneRow }) => {
  const m = META.get(row.i)!;
  return <Widget item={{ ...m, x: 0, y: 0 } as Item} />;
};

const PhoneEditRow = ({ row, onToggle, onRemove, fresh }: { row: PhoneRow; onToggle: () => void; onRemove: () => void; fresh: boolean }) => {
  const controls = useDragControls();
  const m = META.get(row.i)!;
  return (
    <Reorder.Item
      value={row}
      dragListener={false}
      dragControls={controls}
      className={`dph-row${fresh ? ' dph-fresh' : ''}`}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, x: -40, transition: { duration: 0.2 } }}
      whileDrag={{ scale: 1.03, boxShadow: '0 18px 40px -16px rgba(15,23,42,.45)' }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
    >
      <button className="dph-minus" onClick={onRemove} aria-label={`Odebrat ${m.label}`}>−</button>
      <i className="dph-ico">{m.icon}</i>
      <span className="dph-txt"><b>{m.label}</b><small>{m.hint}</small></span>
      {canHalf(row.i) ? (
        <span className="dph-size" role="group" aria-label="Šířka">
          <button className={row.half ? 'on' : ''} onClick={onToggle} title="Půl šířky">½</button>
          <button className={!row.half ? 'on' : ''} onClick={onToggle} title="Celá šířka">▭</button>
        </span>
      ) : <span className="dph-full">celá šířka</span>}
      <span className="dph-handle" onPointerDown={e => controls.start(e)} aria-label="Přesunout">≡</span>
    </Reorder.Item>
  );
};

const Phone = ({ desktop }: { desktop: Item[] }) => {
  const initial = useMemo<PhoneRow[]>(() => [...desktop].sort((a, b) => a.y - b.y || a.x - b.x).map(it => ({ i: it.i, half: it.w <= 2 })), [desktop]);
  const [rows, setRows] = useState<PhoneRow[]>(initial);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<PhoneRow[]>(initial);
  const [sheet, setSheet] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const press = useRef<number | null>(null);
  useEffect(() => { if (!fresh) return; const t = setTimeout(() => setFresh(null), 1500); return () => clearTimeout(t); }, [fresh]);
  const pool = CATALOG.filter(m => !rows.some(r => r.i === m.i));
  const begin = () => { setSaved(rows); setEditing(true); };
  // Dlouhé podržení widgetu zapne úpravy — jako na ploše iPhonu.
  const holdStart = () => { press.current = window.setTimeout(begin, 450); };
  const holdEnd = () => { if (press.current) clearTimeout(press.current); press.current = null; };

  return (
    <div className="dph-stage">
      <div className="dph-phone">
        <div className="dph-notch" />
        <div className="dph-screen">
          <div className="dph-head">
            {editing ? (
              <>
                <button className="dph-link" onClick={() => { setRows(saved); setEditing(false); setSheet(false); }}>Zrušit</button>
                <b>Upravit plochu</b>
                <button className="dph-link dph-done" onClick={() => { setEditing(false); setSheet(false); }}>Hotovo</button>
              </>
            ) : (
              <>
                <b className="dph-title">Dashboard</b>
                <button className="dph-link" onClick={begin}>Upravit</button>
              </>
            )}
          </div>

          <div className="dph-scroll">
            <AnimatePresence mode="wait" initial={false}>
              {editing ? (
                <motion.div key="edit" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                  <p className="dph-tip">Táhni za ≡ pro pořadí · ½ / ▭ mění šířku</p>
                  <Reorder.Group axis="y" values={rows} onReorder={setRows} className="dph-list">
                    <AnimatePresence initial={false}>
                      {rows.map(row => (
                        <PhoneEditRow
                          key={row.i}
                          row={row}
                          fresh={fresh === row.i}
                          onToggle={() => setRows(rs => rs.map(r => r.i === row.i ? { ...r, half: !r.half } : r))}
                          onRemove={() => setRows(rs => rs.filter(r => r.i !== row.i))}
                        />
                      ))}
                    </AnimatePresence>
                  </Reorder.Group>
                  <button className="dph-add" onClick={() => setSheet(true)}>＋ Přidat widget <span>{pool.length}</span></button>
                </motion.div>
              ) : (
                <motion.div key="view" className="dph-grid" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.22 }}>
                  {rows.map(row => (
                    <motion.div
                      layout
                      key={row.i}
                      className={`dph-cell ${row.half ? 'half' : 'full'} ${META.get(row.i)!.h >= 4 ? 'tall' : ''}`}
                      onPointerDown={holdStart} onPointerUp={holdEnd} onPointerLeave={holdEnd}
                    >
                      <PhoneWidget row={row} />
                    </motion.div>
                  ))}
                  <p className="dph-tip">Podrž widget pro úpravy</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence>
            {sheet ? (
              <>
                <motion.div className="dph-dim" onClick={() => setSheet(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
                <motion.div className="dph-sheet" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 380, damping: 36 }}>
                  <span className="dph-grab" />
                  <b>Přidat widget</b>
                  <div className="dph-sheet-list">
                    {pool.map((m, n) => (
                      <motion.button
                        key={m.i}
                        className="dph-sheet-item"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0, transition: { delay: 0.04 * n } }}
                        whileTap={{ scale: 0.97 }}
                        onClick={() => { setRows(rs => [{ i: m.i, half: canHalf(m.i) }, ...rs]); setFresh(m.i); setSheet(false); }}
                      >
                        <i className="dph-ico">{m.icon}</i>
                        <span className="dph-txt"><b>{m.label}</b><small>{m.hint}</small></span>
                        <span className="dph-plus">＋</span>
                      </motion.button>
                    ))}
                    {!pool.length ? <p className="dph-tip">Všechny widgety jsou na ploše.</p> : null}
                  </div>
                </motion.div>
              </>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
      <p className="dph-caption">Na telefonu se rozložení neskládá do mřížky: widgety jdou pod sebou, malé KPI po dvou. Úpravy = pořadí, šířka (½ / celá) a výběr widgetů. Nový widget se přidá nahoru a jde rovnou přetáhnout.</p>
    </div>
  );
};

const App = () => {
  const [items, setItems] = useState<Item[]>(DEFAULT);
  const [editing, setEditing] = useState(false);
  const [mid, setMid] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [history, setHistory] = useState<Item[][]>([]);
  const [snapshot, setSnapshot] = useState<Item[]>(DEFAULT);
  const [dragging, setDragging] = useState(false);
  const [swap, setSwap] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ i: string; w: number; h: number; atMin: boolean } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: boolean } | null>(null);
  const start = useRef<Item[]>(DEFAULT);
  const movingId = useRef<string | null>(null);
  const swapRef = useRef<string | null>(null);
  const dropSize = useRef<{ i: string; w: number; h: number } | null>(null);
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1240 });

  const cols = mid ? 6 : 12;
  // Vlastní skládání během tažení: knihovna ho volá při každém posunu, my
  // vrátíme náhled výsledku (prohození / uvolnění místa) a ostatní widgety
  // do něj plynule dojedou díky CSS přechodům.
  const compactor = useMemo<Compactor>(() => ({
    type: 'vertical',
    get allowOverlap() { return movingId.current != null; },
    compact(layout: Layout, c: number) {
      const id = movingId.current;
      const moving = id ? layout.find(t => t.i === id) : undefined;
      if (!moving) return verticalCompactor.compact(layout, c);
      const result = arrange(start.current, moving, c);
      if (swapRef.current !== result.swapWith) { swapRef.current = result.swapWith; const next = result.swapWith; queueMicrotask(() => setSwap(next)); }
      return result.layout;
    },
  }), []);
  const labels = useMemo(() => new Map(CATALOG.map(m => [m.i, { ...m, x: 0, y: 0 } as Item])), []);
  const shown = mid ? packMid(items) : items;
  const pool = CATALOG.filter(p => !items.some(it => it.i === p.i));
  const colW = (width - MARGIN * (cols + 1)) / cols;
  const px = (units: number, unit: number) => units * unit + (units - 1) * MARGIN;

  const commit = useCallback((next: Item[], note?: { text: string; undo?: boolean }) => {
    setHistory(h => [...h.slice(-30), items]);
    setItems(next);
    if (note) setToast(note);
  }, [items]);

  const undo = useCallback(() => {
    setHistory(h => {
      if (!h.length) return h;
      setItems(h[h.length - 1]);
      setToast({ text: 'Vráceno' });
      return h.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); } };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [editing, undo]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3200); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { if (!fresh) return; const t = setTimeout(() => setFresh(null), 1600); return () => clearTimeout(t); }, [fresh]);

  const beginEdit = () => { setSnapshot(items); setHistory([]); setEditing(true); };
  const cancelEdit = () => { setItems(snapshot); setHistory([]); setEditing(false); setToast({ text: 'Změny zrušeny' }); };

  const add = (p: Meta, at?: { x: number; y: number }) => {
    const spot = at ?? firstFree(items, p.w, p.h, 12);
    const next = arrange(items, { ...p, ...spot } as LayoutItem, 12).layout;
    commit(next.map(n => ({ ...labels.get(n.i)!, x: n.x, y: n.y, w: n.w, h: n.h })), { text: `${p.label} přidán` });
    setFresh(p.i);
  };
  const remove = (it: Item) => {
    setLeaving(it.i);
    setTimeout(() => {
      setLeaving(null);
      commit(verticalCompactor.compact(items.filter(x => x.i !== it.i), 12) as Item[], { text: `${it.label} odebrán`, undo: true });
    }, 190);
  };

  return (
    <div className="dep-root">
      <div className={`dep-wrap${mid ? ' dep-mid' : ''}`} style={{ paddingBottom: editing ? 400 : 160 }}>
        <div className="dep-top">
          <h1>Dashboard</h1>
          <span className="dep-seg">
            <button className={device === 'desktop' ? 'on' : ''} onClick={() => setDevice('desktop')}>Počítač</button>
            <button className={device === 'phone' ? 'on' : ''} onClick={() => { setDevice('phone'); setEditing(false); }}>Telefon</button>
          </span>
          {device === 'desktop' ? <span className="dep-seg" title="Jen pro náhled — simuluje šířku okna">
            <button className={!mid ? 'on' : ''} onClick={() => setMid(false)}>Široké okno</button>
            <button className={mid ? 'on' : ''} onClick={() => setMid(true)}>Střední okno</button>
          </span> : null}
          <span className="dep-grow" />
          {device === 'phone' ? null : editing ? (
            <div className="dep-editbar">
              <span className="dep-hint">Táhni za widget · roh mění velikost · ⌘Z vrátí</span>
              <button className="dep-btn" onClick={undo} disabled={!history.length} title="Zpět (⌘Z)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>Zpět
              </button>
              <button className="dep-btn" onClick={() => commit(DEFAULT, { text: 'Obnoveno výchozí rozložení', undo: true })}>Obnovit výchozí</button>
              <button className="dep-btn" onClick={cancelEdit}>Zrušit změny</button>
              <button className="dep-btn ok" onClick={() => { setEditing(false); setToast({ text: 'Rozložení uloženo' }); }}>Hotovo</button>
            </div>
          ) : (
            <button className="dep-btn primary" onClick={beginEdit}>Upravit dashboard</button>
          )}
        </div>

        {device === 'phone' ? <Phone desktop={items} /> : null}
        {device === 'desktop' && mid ? (
          <p className="dep-note">
            Střední šířka (6 sloupců): rozložení se dopočítá z toho širokého — KPI po třech, velké widgety přes celou šířku, ve stejném pořadí.
            {editing ? ' Úpravy tady nejsou — uložily by se do rozložení pro široké okno a rozbily ho.' : ''}
          </p>
        ) : null}

        <div ref={containerRef} className={editing && !mid ? 'dep-editing' : ''} style={device === 'phone' ? { display: 'none' } : undefined}>
          {mounted && (
            <GridLayout
              className="dep-grid"
              width={width}
              layout={shown}
              gridConfig={{ cols, rowHeight: ROW, margin: [MARGIN, MARGIN], containerPadding: [MARGIN, MARGIN] }}
              dragConfig={{ enabled: editing && !mid, cancel: '.dep-tools button' }}
              resizeConfig={{ enabled: editing && !mid, handles: ['se'] }}
              dropConfig={{
                enabled: editing && !mid,
                defaultItem: { w: 2, h: 2 },
                onDragOver: () => (dropSize.current ? { w: dropSize.current.w, h: dropSize.current.h } : undefined),
              }}
              compactor={compactor}
              onDragStart={(_l, o) => { start.current = items; movingId.current = o?.i ?? null; setDragging(true); }}
              onDragStop={(l) => {
                movingId.current = null; swapRef.current = null;
                setDragging(false); setSwap(null);
                const next = plain(verticalCompactor.compact(l, 12), labels);
                if (JSON.stringify(next) !== JSON.stringify(start.current)) commit(next);
              }}
              onResize={(_l, _o, n) => { if (n) setResizing({ i: n.i, w: n.w, h: n.h, atMin: n.w <= (n.minW ?? 1) && n.h <= (n.minH ?? 1) }); }}
              onResizeStop={(l) => {
                setResizing(null);
                const next = plain(verticalCompactor.compact(l, 12), labels);
                if (JSON.stringify(next) !== JSON.stringify(items)) commit(next);
              }}
              onDrop={(l, dropped) => {
                const p = META.get(dropSize.current?.i ?? '');
                dropSize.current = null;
                movingId.current = null;
                if (p && dropped) add(p, { x: dropped.x, y: dropped.y });
                void l;
              }}
              droppingItem={{ i: '__drop__', x: 0, y: 0, w: 2, h: 2 }}
              autoSize
            >
              {shown.map(item => (
                <div
                  key={item.i}
                  className={[swap === item.i ? 'dep-swap' : '', fresh === item.i ? 'dep-new' : '', leaving === item.i ? 'dep-out' : ''].join(' ')}
                  // Minimum (i maximum) drží i během tažení rohu: mřížka by jinak
                  // widget vizuálně zmenšila až na 1×1 a puštěním skočil zpět.
                  style={!mid ? {
                    minWidth: px(item.minW ?? 1, colW), minHeight: px(item.minH ?? 1, ROW),
                    maxWidth: px(item.maxW ?? cols, colW), maxHeight: px(item.maxH ?? 99, ROW),
                  } : undefined}
                >
                  <Widget item={item} />
                  {editing && !mid ? (
                    <div className="dep-tools">
                      <button title="Odebrat" onClick={() => remove(item)} onMouseDown={e => e.stopPropagation()}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
                      </button>
                    </div>
                  ) : null}
                  {resizing?.i === item.i ? (
                    <span className={`dep-size${resizing.atMin ? ' min' : ''}`}>{resizing.w} × {resizing.h}{resizing.atMin ? ' · minimum' : ''}</span>
                  ) : null}
                </div>
              ))}
            </GridLayout>
          )}
        </div>
      </div>

      {editing && !mid ? (
        <Library
          pool={pool}
          onAdd={p => add(p)}
          onDragStartItem={p => { dropSize.current = { i: p.i, w: p.w, h: p.h }; start.current = items; movingId.current = '__drop__'; }}
          onDragEndItem={() => { dropSize.current = null; movingId.current = null; }}
        />
      ) : null}

      {toast ? (
        <div className="dep-toast" key={toast.text}>
          {toast.text}
          {toast.undo ? <button onClick={undo}>Vrátit</button> : null}
        </div>
      ) : null}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
