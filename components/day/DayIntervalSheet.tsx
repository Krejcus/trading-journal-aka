import React, { useEffect, useRef, useState } from 'react';
import { Plus, Star, Trash2, X } from 'lucide-react';
import {
  MARKET_TIMEFRAME_OPTIONS,
  TIMEFRAME_FAVORITES_EVENT,
  addCustomTimeframe,
  customTimeframeFromDraft,
  customTimeframeOption,
  deleteCustomTimeframe,
  readCustomTimeframes,
  saveTimeframeFavorites,
  type TimeframeOption,
} from '../ChartTimeframePicker';
import { CUSTOM_TIMEFRAME_LIMITS, type MarketTimeframe } from '../../services/marketData';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';

const LONG_PRESS_MS = 450;
const CLOSE_DRAG_PX = 80;
const GROUPS: TimeframeOption['group'][] = ['Minuty', 'Hodiny', 'Dny', 'Vlastní'];

/**
 * Spodní list intervalů jako v TradingView na telefonu: oblíbené nahoře
 * (stejné úložiště jako nabídka intervalů na PC), pod nimi všechny intervaly
 * po skupinách. Klepnutí vybere, podržení přidá/odebere oblíbený (vlastní
 * interval jde i smazat), „Přidat interval“ založí vlastní. List zůstává
 * otevřený; zavře ho křížek, klepnutí vedle nebo stažení dolů.
 */
export default function DayIntervalSheet({ value, favorites, onPick, onClose }: {
  value: MarketTimeframe;
  favorites: readonly MarketTimeframe[];
  onPick: (timeframe: MarketTimeframe) => void;
  onClose: () => void;
}) {
  const [customs, setCustoms] = useState(readCustomTimeframes);
  useEffect(() => {
    const sync = () => setCustoms(readCustomTimeframes());
    window.addEventListener(TIMEFRAME_FAVORITES_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(TIMEFRAME_FAVORITES_EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);
  const options = [...MARKET_TIMEFRAME_OPTIONS, ...customs.flatMap(custom => customTimeframeOption(custom) ?? [])];
  const optionOf = (timeframe: MarketTimeframe) => options.find(option => option.value === timeframe) ?? customTimeframeOption(timeframe);

  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ timeframe: MarketTimeframe; left: number; top: number } | null>(null);
  const [leaving, setLeaving] = useState<MarketTimeframe | null>(null);
  const press = useRef<{ timer: number; fired: boolean; x: number; y: number } | null>(null);
  useEffect(() => () => { if (press.current) window.clearTimeout(press.current.timer); }, []);

  const startPress = (timeframe: MarketTimeframe, event: React.PointerEvent<HTMLButtonElement>) => {
    const target = event.currentTarget;
    const timer = window.setTimeout(() => {
      if (!press.current) return;
      press.current.fired = true;
      playNativeHapticIfAvailable('light');
      const root = rootRef.current?.getBoundingClientRect();
      const chip = target.getBoundingClientRect();
      if (!root) return;
      setMenu({
        timeframe,
        left: Math.max(8, Math.min(chip.left - root.left - 40, root.width - 228)),
        top: chip.top - root.top - 8,
      });
    }, LONG_PRESS_MS);
    press.current = { timer, fired: false, x: event.clientX, y: event.clientY };
  };
  const cancelPress = () => { if (press.current) window.clearTimeout(press.current.timer); };
  const endPress = (timeframe: MarketTimeframe) => {
    const current = press.current;
    press.current = null;
    if (!current) return;
    window.clearTimeout(current.timer);
    if (current.fired) return;
    playNativeHapticIfAvailable('selection');
    onPick(timeframe);
  };

  const toggleFavorite = (timeframe: MarketTimeframe) => {
    setMenu(null);
    if (!favorites.includes(timeframe)) { saveTimeframeFavorites([...favorites, timeframe]); return; }
    // Oblíbený nejdřív sjede (jako v TradingView), pak zmizí z řady.
    setLeaving(timeframe);
    window.setTimeout(() => { saveTimeframeFavorites(favorites.filter(item => item !== timeframe)); setLeaving(null); }, 230);
  };

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [unit, setUnit] = useState<'m' | 'h'>('m');
  const [draftError, setDraftError] = useState('');
  const submitDraft = () => {
    const timeframe = customTimeframeFromDraft(draft, unit);
    if (!timeframe) {
      setDraftError(`Zadej ${CUSTOM_TIMEFRAME_LIMITS.m.min}–${CUSTOM_TIMEFRAME_LIMITS.m.max} minut nebo ${CUSTOM_TIMEFRAME_LIMITS.h.min}–${CUSTOM_TIMEFRAME_LIMITS.h.max} hodin.`);
      return;
    }
    addCustomTimeframe(timeframe);
    onPick(timeframe);
    setDraft(''); setDraftError(''); setAdding(false);
  };

  const dragRef = useRef<{ y0: number } | null>(null);
  const [dragY, setDragY] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const chip = (timeframe: MarketTimeframe, key: string) => {
    const option = optionOf(timeframe);
    const selected = timeframe === value;
    const favorite = favorites.includes(timeframe);
    const gone = leaving === timeframe && key.startsWith('fav');
    return (
      <button
        key={key}
        type="button"
        className="dj-btn"
        aria-pressed={selected}
        aria-label={`${option?.title ?? timeframe}${favorite ? ', oblíbený' : ''}`}
        onPointerDown={event => startPress(timeframe, event)}
        onPointerMove={event => {
          const current = press.current;
          if (current && !current.fired && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) { cancelPress(); press.current = null; }
        }}
        onPointerUp={() => endPress(timeframe)}
        onPointerCancel={() => { cancelPress(); press.current = null; }}
        onContextMenu={event => event.preventDefault()}
        style={{
          position: 'relative', flex: 'none', height: 36, minWidth: gone ? 0 : 48, maxWidth: gone ? 0 : 96,
          padding: gone ? 0 : '0 13px', margin: gone ? '0 -3px' : 0, borderRadius: 11,
          border: gone ? 0 : `1px solid ${selected ? 'var(--dj-seg-on)' : 'var(--dj-line)'}`,
          background: selected ? 'var(--dj-seg-on)' : 'var(--dj-chip)', color: selected ? 'var(--dj-seg-on-ink)' : 'var(--dj-text)',
          fontSize: 13.5, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden',
          opacity: gone ? 0 : 1, transform: gone ? 'scale(.6)' : menu?.timeframe === timeframe ? 'scale(1.08)' : 'none',
          zIndex: menu?.timeframe === timeframe ? 3 : undefined,
          transition: 'transform .2s cubic-bezier(.2,.9,.25,1), opacity .2s, max-width .23s, padding .23s, margin .23s, background .15s, color .15s',
        }}
      >
        {option?.label ?? timeframe}
        {favorite && <Star size={9} fill="#f5a524" color="#f5a524" style={{ position: 'absolute', top: 3, right: 3 }} />}
      </button>
    );
  };
  const label: React.CSSProperties = { margin: '14px 2px 8px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--dj-muted)' };
  const favoriteList = favorites.filter(timeframe => optionOf(timeframe));
  const menuIsCustom = menu ? customs.includes(menu.timeframe) : false;

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
      <section
        aria-label="Interval"
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column',
          maxHeight: expanded ? '94%' : '72%', height: expanded ? '94%' : undefined,
          borderRadius: '20px 20px 0 0', background: 'var(--dj-card)', borderTop: '1px solid var(--dj-line)',
          paddingBottom: 'var(--dj-safe-bottom, env(safe-area-inset-bottom, 0px))', transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragY ? 'none' : 'transform .26s cubic-bezier(.2,.9,.25,1), max-height .26s cubic-bezier(.2,.9,.25,1)',
          animation: 'dj-sheet .26s cubic-bezier(.2,.9,.25,1) both',
        }}
      >
        <div
          aria-hidden="true"
          onPointerDown={event => { dragRef.current = { y0: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (dragRef.current) setDragY(Math.max(0, event.clientY - dragRef.current.y0)); }}
          onPointerUp={event => {
            const drag = dragRef.current; dragRef.current = null; if (!drag) return;
            const moved = event.clientY - drag.y0;
            setDragY(0);
            if (moved > CLOSE_DRAG_PX) onClose(); else if (moved < -24) setExpanded(true);
          }}
          style={{ padding: '8px 0 4px', display: 'grid', placeItems: 'center', touchAction: 'none', cursor: 'grab' }}
        ><span style={{ width: 38, height: 5, borderRadius: 3, background: 'var(--dj-line)', filter: 'brightness(2.2)' }} /></div>
        <div style={{ display: 'flex', alignItems: 'center', padding: '2px 16px 4px' }}>
          <p style={{ margin: 0, flex: 1, fontSize: 16, fontWeight: 800, color: 'var(--dj-text)' }}>Interval</p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        <div className="dj-scroll" style={{ overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 16px 16px' }}>
          <p style={label}>Oblíbené</p>
          {favoriteList.length ? (
            <div className="dj-scroll" style={{ display: 'flex', gap: 7, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 2 }}>
              {favoriteList.map(timeframe => chip(timeframe, `fav-${timeframe}`))}
            </div>
          ) : <p style={{ margin: 0, fontSize: 12.5, color: 'var(--dj-muted)' }}>Žádné oblíbené. Podrž interval níž a přidej ho.</p>}
          {GROUPS.map(group => {
            const items = options.filter(option => option.group === group);
            if (!items.length) return null;
            return (
              <React.Fragment key={group}>
                <p style={label}>{group}</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>{items.map(option => chip(option.value, `${group}-${option.value}`))}</div>
              </React.Fragment>
            );
          })}
          {adding && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  id="day-interval-count"
                  inputMode="numeric"
                  autoFocus
                  value={draft}
                  onChange={event => { setDraft(event.target.value); setDraftError(''); }}
                  onKeyDown={event => { if (event.key === 'Enter') submitDraft(); }}
                  aria-label="Počet"
                  placeholder={unit === 'm' ? '7' : '2'}
                  style={{ width: 84, height: 40, borderRadius: 11, border: `1px solid ${draftError ? '#ef4655' : 'var(--dj-line)'}`, background: 'var(--dj-chip)', color: 'var(--dj-text)', fontSize: 15, fontWeight: 700, padding: '0 12px' }}
                />
                {(['m', 'h'] as const).map(item => (
                  <button key={item} type="button" className="dj-btn" aria-pressed={unit === item} onClick={() => { setUnit(item); setDraftError(''); }} style={{ height: 40, padding: '0 14px', borderRadius: 11, border: 0, background: unit === item ? 'var(--dj-seg-on)' : 'var(--dj-chip)', color: unit === item ? 'var(--dj-seg-on-ink)' : 'var(--dj-text)', fontWeight: 800, cursor: 'pointer' }}>{item === 'm' ? 'minut' : 'hodin'}</button>
                ))}
                <button type="button" className="dj-btn" onClick={submitDraft} style={{ marginLeft: 'auto', height: 40, padding: '0 16px', borderRadius: 11, border: 0, background: 'linear-gradient(180deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 800, cursor: 'pointer' }}>Přidat</button>
              </div>
              {draftError && <p role="alert" style={{ margin: '6px 2px 0', fontSize: 12, color: '#ef4655' }}>{draftError}</p>}
            </div>
          )}
          <button
            type="button"
            className="dj-btn"
            onClick={() => { setAdding(open => !open); setDraftError(''); }}
            style={{ marginTop: 16, width: '100%', height: 46, borderRadius: 13, border: 0, background: 'var(--dj-seg-on)', color: 'var(--dj-seg-on-ink)', fontSize: 14.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' }}
          ><Plus size={17} />{adding ? 'Zrušit přidání' : 'Přidat interval'}</button>
        </div>
      </section>
      {menu && (
        <>
          <div onClick={() => setMenu(null)} style={{ position: 'absolute', inset: 0, zIndex: 2, background: 'rgba(0,0,0,0.3)', animation: 'dj-fade .15s ease both' }} />
          <div
            role="menu"
            style={{ position: 'absolute', zIndex: 4, left: menu.left, top: menu.top, transform: 'translateY(-100%)', minWidth: 220, padding: 4, borderRadius: 14, background: 'var(--dj-card)', border: '1px solid var(--dj-line)', boxShadow: '0 18px 40px -16px rgba(0,0,0,.6)', animation: 'dj-pop .18s cubic-bezier(.2,.9,.25,1) both' }}
          >
            <button type="button" role="menuitem" className="dj-btn" onClick={() => toggleFavorite(menu.timeframe)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', border: 0, borderRadius: 10, background: 'transparent', color: 'var(--dj-text)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              <Star size={16} {...(favorites.includes(menu.timeframe) ? {} : { fill: '#f5a524', color: '#f5a524' })} />
              {favorites.includes(menu.timeframe) ? 'Odebrat z oblíbených' : 'Přidat do oblíbených'}
            </button>
            {menuIsCustom && (
              <button type="button" role="menuitem" className="dj-btn" onClick={() => { const timeframe = menu.timeframe; setMenu(null); deleteCustomTimeframe(timeframe); }} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', border: 0, borderRadius: 10, background: 'transparent', color: '#ef4655', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                <Trash2 size={16} />Smazat vlastní interval
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
