import React, { useMemo, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';

/*
 * Knihovna widgetů v režimu úprav dashboardu (místo doku s vodorovným
 * posuvníkem): vyhledávání, kategorie a karty s miniaturou vzhledu widgetu.
 * Kartu jde přetáhnout na plochu (ostatní widgety uhnou), klik ji přidá do
 * prvního volného místa.
 */

export interface LibraryWidget {
  id: string;
  label: string;
  description: string;
  category: string;
  icon: React.ReactNode;
  w: number;
  h: number;
}

const SAMPLE: Record<string, [string, 'win' | 'loss' | '']> = {
  kpi_pnl: ['+$22.7k', 'win'], kpi_winrate: ['48,6 %', ''], kpi_profit_factor: ['1,43', ''], kpi_day_winrate: ['73 %', ''],
  kpi_max_drawdown: ['−4,2 %', 'loss'], kpi_execution_rate: ['92 %', ''], prop_drawdown_room: ['$1 840', ''],
  avg_win_loss: ['1,62', ''], streak: ['+4', 'win'], discipline_streak: ['12 dní', 'win'], challenge_target: ['45 %', ''],
  bt_avg_r: ['+0,4R', 'win'], bt_sample_size: ['n=214', ''],
};

const MiniBody = ({ id }: { id: string }) => {
  if (SAMPLE[id]) {
    const [value, tone] = SAMPLE[id];
    return <span className={`dbe-mini-v ${tone}`}>{value}</span>;
  }
  switch (id) {
    case 'equity':
      return (
        <svg className="dbe-mini-fill" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
          <path d="M0 36 L12 30 L22 32 L34 22 L46 24 L58 15 L70 17 L82 8 L100 4 L100 40 L0 40Z" className="dbe-mini-area" />
          <path d="M0 36 L12 30 L22 32 L34 22 L46 24 L58 15 L70 17 L82 8 L100 4" className="dbe-mini-line" vectorEffect="non-scaling-stroke" />
        </svg>
      );
    case 'calendar':
    case 'monthly_performance':
      return <span className="dbe-mini-cal">{Array.from({ length: 21 }, (_, n) => <i key={n} className={n % 3 === 0 ? 'l' : n % 2 ? 'w' : ''} />)}</span>;
    case 'bt_monte_carlo':
      return (
        <svg className="dbe-mini-fill" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
          {[6, 14, 22, 30].map((end, n) => <path key={n} d={`M0 22 C 30 ${22 - n}, 60 ${end + 2}, 100 ${end}`} className="dbe-mini-fan" vectorEffect="non-scaling-stroke" />)}
        </svg>
      );
    case 'session_performance':
    case 'hourly_edge':
    case 'daily_edge':
    case 'bt_confluence_wr':
      return <span className="dbe-mini-bars">{[55, 85, 35, 65].map((h, n) => <i key={n} style={{ height: `${h}%` }} className={n === 2 ? 'l' : 'w'} />)}</span>;
    case 'winners_losers':
      return <span className="dbe-mini-split"><i className="w" style={{ width: '62%' }} /><i className="l" style={{ width: '38%' }} /></span>;
    default:
      return <span className="dbe-mini-lines"><i style={{ width: '90%' }} /><i style={{ width: '70%' }} /><i style={{ width: '45%' }} /></span>;
  }
};

/** Miniatura: vzhled widgetu v poměru stran jeho výchozí velikosti. */
export const MiniWidget = ({ widget }: { widget: LibraryWidget }) => {
  const ratio = widget.w / (widget.h * 1.1);
  return (
    <span className="dbe-mini-stage" aria-hidden>
      <span className="dbe-mini-card" style={ratio > 1.5 ? { width: '100%', aspectRatio: String(ratio) } : { height: '100%', aspectRatio: String(ratio) }}>
        <span className="dbe-mini-k">{widget.label}</span>
        <span className="dbe-mini-body"><MiniBody id={widget.id} /></span>
      </span>
    </span>
  );
};

const normalize = (value: string) => value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export default function DashboardWidgetLibrary({ widgets, onAdd, onDragStartWidget, onDragEndWidget }: {
  widgets: LibraryWidget[];
  onAdd: (id: string) => void;
  onDragStartWidget: (widget: LibraryWidget) => void;
  onDragEndWidget: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Vše');
  const categories = useMemo(() => ['Vše', ...Array.from(new Set(widgets.map(widget => widget.category)))], [widgets]);
  const list = widgets.filter(widget => (category === 'Vše' || widget.category === category)
    && (!query || normalize(`${widget.label} ${widget.description}`).includes(normalize(query))));

  return (
    <div className={`dbe-lib${open ? ' dbe-lib-open' : ''}`}>
      <div className="dbe-lib-panel" aria-hidden={!open}>
        <div>
          <div className="dbe-lib-in">
            <div className="dbe-lib-head">
              <label className="dbe-lib-search">
                <Search size={13} />
                <input placeholder="Hledat widget…" value={query} onChange={event => setQuery(event.target.value)} tabIndex={open ? 0 : -1} />
              </label>
              <div className="dbe-seg" role="tablist">
                {categories.map(name => (
                  <button key={name} type="button" className={category === name ? 'on' : ''} onClick={() => setCategory(name)} tabIndex={open ? 0 : -1}>
                    {name}
                    {name !== 'Vše' ? <small>{widgets.filter(widget => widget.category === name).length}</small> : null}
                  </button>
                ))}
              </div>
            </div>
            <div className="dbe-lib-grid">
              {list.map((widget, index) => (
                <div
                  key={widget.id}
                  role="button"
                  tabIndex={open ? 0 : -1}
                  className="dbe-lib-card"
                  style={{ animationDelay: `${index * 0.025}s` }}
                  draggable
                  title="Přetáhni na místo na ploše, nebo klikni — přidá se do prvního volného místa"
                  onDragStart={event => { onDragStartWidget(widget); event.dataTransfer.setData('text/plain', widget.id); event.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={onDragEndWidget}
                  onClick={() => onAdd(widget.id)}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onAdd(widget.id); } }}
                >
                  <MiniWidget widget={widget} />
                  <span className="dbe-lib-txt">
                    <b>{widget.label}</b>
                    <small>{widget.description}</small>
                  </span>
                  <span className="dbe-lib-dim">{widget.w}×{widget.h}</span>
                  <span className="dbe-lib-plus" aria-hidden><Plus size={11} strokeWidth={3} /></span>
                </div>
              ))}
              {!list.length ? <p className="dbe-lib-empty">{widgets.length ? 'Nic neodpovídá hledání.' : 'Všechny widgety jsou na ploše.'}</p> : null}
            </div>
          </div>
        </div>
      </div>
      <div className="dbe-lib-bar">
        <button type="button" className="dbe-btn dbe-btn-primary" onClick={() => setOpen(value => !value)} aria-expanded={open}>
          <span className="dbe-lib-toggle">{open ? <X size={14} /> : <Plus size={14} />}</span>
          {open ? 'Skrýt knihovnu' : 'Přidat widget'}
          {widgets.length ? <span className="dbe-count">{widgets.length}</span> : null}
        </button>
        <span className="dbe-hint">
          {open ? 'Přetáhni kartu na plochu — widgety pod ní uhnou. Klik přidá do prvního volného místa.' : 'Táhni za widget · roh mění velikost · ⌘Z vrátí'}
        </span>
      </div>
    </div>
  );
}
