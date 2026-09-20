import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, X } from 'lucide-react';
import type { LiveDaySummary } from '../lib/liveDaySummary';
import { FIRM_LOGOS, firmColor, firmInitials } from '../utils/accountFirm';

const AT_LOGO = '/logos/at_logo_light_clean.png';
const whole = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });

/** Celé dolary bez desetin: karta se posílá dál, ne se z ní účtuje. */
export const dayMoney = (value: number): string =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}$${whole.format(Math.abs(Math.round(value)))}`;

const tone = (value: number | null): string =>
  value == null ? 'live-day-flat' : value > 0 ? 'live-day-win' : value < 0 ? 'live-day-loss' : 'live-day-flat';

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const initials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || '?';
};

const plural = (count: number, one: string, few: string, many: string): string =>
  count === 1 ? one : count < 5 ? few : many;

/**
 * Co kartě chybí, řečeno přesně. Klidné ráno bez obchodu není výpadek dat a
 * nesmí se tak tvářit — rozlišuje se podle toho, jestli čtení brokera prošlo.
 */
const partialNote = (summary: LiveDaySummary): string | null => {
  // Bez připojeného účtu není co hlásit; soupis vedle to říká sám.
  if (summary.accountCount === 0) return null;
  const missing = summary.unconfirmedCount;
  if (summary.confirmed != null) {
    return missing > 0
      ? `Sečteno bez ${missing} ${plural(missing, 'účtu', 'účtů', 'účtů')} — u ${plural(missing, 'něj', 'nich', 'nich')} se dnešní P&L nepodařilo ověřit.`
      : null;
  }
  return missing === 0
    ? 'Broker dnes u žádného účtu nehlásí uzavřený obchod.'
    : 'Broker dnes nepotvrdil denní P&L ani u jednoho účtu.';
};

// ── spouštěč v hlavičce LIVE ────────────────────────────────────────────────
/**
 * Varianta 2 z návrhů: popisek a číslo. Win/Loss tu nebyl — poměr stojí hned
 * v otevřené kartě a v hlavičce jen zabíral šířku, která se v úzkém okně
 * zalomí jako první.
 */
export const LiveDayTrigger = ({ summary, onOpen }: { summary: LiveDaySummary; onOpen: () => void }) => {
  const note = partialNote(summary);
  // Bez jediného připojeného účtu není co shrnovat a pomlčka v hlavičce by
  // vypadala jako porucha.
  if (summary.accountCount === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="live-day-trigger"
      title={note ?? 'Karta dne — rozpad dnešního P&L po účtech'}
      className="live-day-trigger flex items-center gap-2.5 rounded-lg border border-[var(--border-subtle)] py-1.5 pl-3 pr-2.5"
    >
      <span className="whitespace-nowrap text-[9px] font-black uppercase tracking-[0.12em] text-[var(--text-secondary)]">Dnešní P&L</span>
      <span className={`text-sm font-extrabold tabular-nums ${summary.confirmed == null
        ? 'text-[var(--text-secondary)]'
        : summary.confirmed > 0 ? 'text-emerald-500' : summary.confirmed < 0 ? 'text-rose-500' : 'text-[var(--text-primary)]'}`}>
        {summary.confirmed == null ? '—' : dayMoney(summary.confirmed)}
      </span>
      {summary.partial ? <span className="live-day-partial-dot" aria-hidden /> : null}
      <ChevronRight size={14} className="text-[var(--text-secondary)]" />
      <span className="sr-only">{note ?? ''}</span>
    </button>
  );
};

// ── karta ───────────────────────────────────────────────────────────────────
export interface LiveDayCardProps {
  summary: LiveDaySummary;
  owner: { name: string; avatar?: string | null };
  /** Obchodní den (YYYY-MM-DD) podle broker session, ne podle data prohlížeče. */
  tradeDate: string;
  /** Leader-only copier ledger; null, když runtime neběží. */
  trades: number | null;
  losingTrades: number | null;
  /** Redakce jmen účtů z hlavičky LIVE se musí promítnout i sem. */
  formatName: (name: string) => string;
  /** Když kartu drží dialog, přidá se do hlavičky tiché zavírací tlačítko. */
  onClose?: () => void;
}

const FirmDot = ({ firm }: { firm: string | null }) => {
  if (!firm) return <span className="live-day-dot" style={{ background: '#475569' }} />;
  const key = firm.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const logo = FIRM_LOGOS[key];
  return logo
    ? <img src={logo} alt="" className="live-day-logo" />
    : <span className="live-day-mono" style={{ background: firmColor(key || firm).bg }}>{firmInitials(firm)}</span>;
};

export const LiveDayCard: React.FC<LiveDayCardProps> = ({ summary, owner, tradeDate, trades, losingTrades, formatName, onClose }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const total = summary.confirmed;

  // Náklon a odlesk podle kurzoru — ±6°, karta je široká a deset stupňů už
  // láme text. Píše se rovnou do stylu, aby se při každém pohybu myši
  // nepřekresloval React strom.
  useEffect(() => {
    const wrap = wrapRef.current;
    const card = cardRef.current;
    if (!wrap || !card || reducedMotion()) return;
    const move = (event: PointerEvent) => {
      const box = wrap.getBoundingClientRect();
      const px = (event.clientX - box.left) / box.width;
      const py = (event.clientY - box.top) / box.height;
      card.style.transition = 'transform .12s linear';
      card.style.transform = `rotateX(${(0.5 - py) * 6}deg) rotateY(${(px - 0.5) * 6}deg)`;
      wrap.style.setProperty('--mx', `${px * 100}%`);
      wrap.style.setProperty('--my', `${py * 100}%`);
    };
    const leave = () => {
      card.style.transition = 'transform .45s cubic-bezier(.22,.61,.36,1)';
      card.style.transform = '';
    };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerleave', leave);
    return () => { wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerleave', leave); };
  }, []);

  // Kolik účtů zůstalo pod okrajem posuvníku. `offsetTop` se měří od nejbližšího
  // pozicovaného předka, ne od posuvníku — proto skutečné souřadnice.
  const syncHidden = useCallback(() => {
    const box = rowsRef.current;
    if (!box) return;
    const edge = box.getBoundingClientRect().bottom;
    setHiddenCount([...box.querySelectorAll('[data-day-row]')]
      .filter(row => row.getBoundingClientRect().bottom > edge + 1).length);
  }, []);
  useLayoutEffect(syncHidden, [syncHidden, summary.rows]);

  // Číslo se dopočítá, stejně jako se na přihlašovací stránce dokreslují svíčky.
  const [shown, setShown] = useState(() => (total == null || reducedMotion() ? total : 0));
  useEffect(() => {
    if (total == null || reducedMotion()) { setShown(total); return; }
    const start = performance.now();
    let frame = 0;
    const tick = (nowMs: number) => {
      const progress = Math.min(1, (nowMs - start) / 850);
      setShown(total * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [total]);

  const note = partialNote(summary);
  const dateLabel = (() => {
    const parsed = new Date(`${tradeDate}T12:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? tradeDate
      : new Intl.DateTimeFormat('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed);
  })();

  return (
    <div className="live-day-tilt" ref={wrapRef} data-testid="live-day-card">
      <div className="live-day-card" ref={cardRef}>
        <div className="live-day-inner">
          <span className="live-day-aurora" aria-hidden />
          <span className="live-day-sheen" aria-hidden />
          <span className="live-day-edge live-day-edge-t" aria-hidden />
          <span className="live-day-edge live-day-edge-b" aria-hidden />
          <span className="live-day-edge live-day-edge-r" aria-hidden />
          <span className="live-day-edge live-day-edge-l" aria-hidden />

          <div className="live-day-head">
            <div className="live-day-brand">
              <img src={AT_LOGO} alt="" />
              <span className="live-day-wordmark">Alpha <i>Trade</i></span>
            </div>
            <div className="live-day-stamp">
              <div className="live-day-owner">
                {owner.avatar
                  ? <img className="live-day-avatar-img" src={owner.avatar} alt="" />
                  : <span className="live-day-avatar">{initials(owner.name)}</span>}
                <span>
                  <span className="live-day-who">{owner.name}</span>
                  <span className="live-day-date">{dateLabel}</span>
                </span>
              </div>
              {onClose ? (
                <button type="button" onClick={onClose} className="live-day-close" aria-label="Zavřít kartu dne">
                  <X size={14} />
                </button>
              ) : null}
            </div>
          </div>

          <div className="live-day-body">
            <div className="live-day-glass live-day-total">
              <div>
                <div className="live-day-k">Dnešní P&L</div>
                <div className={`live-day-big ${tone(total)}`}>
                  {shown == null ? '—' : dayMoney(shown)}
                </div>
                {note ? <p className="live-day-note">{note}</p> : null}
              </div>
              <div className="live-day-split">
                <div>
                  <div className="live-day-kk">Obchodů</div>
                  <div className="live-day-vv">{trades ?? '—'}</div>
                </div>
                <div>
                  <div className="live-day-kk">Win / Loss</div>
                  <div className="live-day-vv">
                    {trades == null || losingTrades == null ? '—' : <>
                      <span className="live-day-win">{Math.max(0, trades - losingTrades)}</span>
                      <span className="live-day-slash">/</span>
                      <span className="live-day-loss">{losingTrades}</span>
                    </>}
                  </div>
                </div>
              </div>
            </div>

            <div className="live-day-glass live-day-list">
              <div className="live-day-lhead">
                <span>Účet · {summary.accountCount}</span>
                <span>Dnes</span>
              </div>
              <div className="live-day-rows" ref={rowsRef} onScroll={syncHidden}>
                {summary.rows.length === 0
                  ? <p className="live-day-empty">Žádný připojený účet.</p>
                  : summary.rows.map((row, index) => (
                    <div
                      key={row.accountId}
                      data-day-row
                      className="live-day-row"
                      style={{ animationDelay: `${70 + index * (summary.rows.length > 8 ? 26 : 55)}ms` }}
                    >
                      <span className="live-day-who-cell">
                        <FirmDot firm={row.firm} />
                        <span className="live-day-nm">{formatName(row.name)}</span>
                        {row.firm ? <span className="live-day-fm">{row.firm}</span> : null}
                      </span>
                      {/* Prokázaný klid je nula, ne neznámo — do součtu nahoře
                          se tak počítá, tak to musí říkat i řádek. */}
                      <span
                        className={`live-day-val ${tone(row.value)}`}
                        title={row.state === 'no-trades' ? 'Broker dnes u tohoto účtu nehlásí uzavřený obchod' : undefined}
                      >
                        {row.value != null ? dayMoney(row.value) : row.state === 'no-trades' ? dayMoney(0) : '—'}
                      </span>
                    </div>
                  ))}
              </div>
              <div className={`live-day-more ${hiddenCount === 0 ? 'live-day-more-hidden' : ''}`}>
                {hiddenCount > 0 ? `+ ${hiddenCount} ${hiddenCount < 5 ? 'účty' : 'účtů'}` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── overlay ─────────────────────────────────────────────────────────────────
export const LiveDayCardDialog = ({ onClose, ...card }: LiveDayCardProps & { onClose: () => void }) => {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Karta dne"
      className="live-day-overlay fixed inset-0 z-[155] flex items-center justify-center p-4 sm:p-7"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-[940px]">
        <LiveDayCard {...card} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
};

export default LiveDayCard;
