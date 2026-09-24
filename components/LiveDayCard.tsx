import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Copy, Loader2, Share2, X } from 'lucide-react';
import { toPng } from 'html-to-image';
import type { LiveDaySummary } from '../lib/liveDaySummary';
import { currentLiveDayShareTheme, publicLiveDaySummary } from '../lib/liveDayShare';
import { createLiveDayShare } from '../services/liveDayShareService';
import { shareTextNative } from '../services/nativeShare';
import { isNativeBuild } from '../utils/runtimeConfig';
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

/** Obchodní den česky. Sdílený text i karta musí psát datum stejně. */
export const liveDayDateLabel = (tradeDate: string): string => {
  const parsed = new Date(`${tradeDate}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? tradeDate
    : new Intl.DateTimeFormat('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed);
};

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
  /** Stabilní export bez dopočítávání částky a vstupních animací řádků. */
  captureMode?: boolean;
  /** Ovládání sdílení v hlavičce karty. Do exportu se nepředává. */
  shareSlot?: React.ReactNode;
  /**
   * Prosvítající deska pro veřejnou stránku, kde za kartou běží graf svíček.
   * V appce ne: tam by skrz kartu prosvítala tabulka účtů pod dialogem.
   */
  translucent?: boolean;
}

const FirmDot = ({ firm }: { firm: string | null }) => {
  if (!firm) return <span className="live-day-dot" style={{ background: '#475569' }} />;
  const key = firm.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const logo = FIRM_LOGOS[key];
  return logo
    ? <img src={logo} alt="" className="live-day-logo" />
    : <span className="live-day-mono" style={{ background: firmColor(key || firm).bg }}>{firmInitials(firm)}</span>;
};

export const LiveDayCard: React.FC<LiveDayCardProps> = ({ summary, owner, tradeDate, trades, losingTrades, formatName, onClose, captureMode = false, shareSlot, translucent = false }) => {
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
    if (!wrap || !card || reducedMotion() || captureMode) return;
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
  }, [captureMode]);

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
  const [shown, setShown] = useState(() => (total == null || reducedMotion() || captureMode ? total : 0));
  useEffect(() => {
    if (total == null || reducedMotion() || captureMode) { setShown(total); return; }
    const start = performance.now();
    let frame = 0;
    const tick = (nowMs: number) => {
      const progress = Math.min(1, (nowMs - start) / 850);
      setShown(total * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [captureMode, total]);

  const note = partialNote(summary);
  const dateLabel = liveDayDateLabel(tradeDate);

  return (
    <div
      className={`live-day-tilt${captureMode ? ' live-day-capture' : ''}${translucent ? ' live-day-seethrough' : ''}`}
      ref={wrapRef}
      data-testid="live-day-card"
    >
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
              {/* V klidu je vpravo jen jméno a datum — karta je kompozice, kterou
                  posíláš dál. Ovládání se odhalí až po najetí na kartu a jméno
                  se mu plynule uhne. */}
              {shareSlot || onClose ? (
                <div className="live-day-tools">
                  <span>
                    {shareSlot}
                    {onClose ? (
                      <button type="button" onClick={onClose} className="live-day-close" aria-label="Zavřít kartu dne">
                        <X size={14} />
                      </button>
                    ) : null}
                  </span>
                </div>
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
                      style={captureMode
                        ? { animation: 'none', opacity: 1 }
                        : { animationDelay: `${70 + index * (summary.rows.length > 8 ? 26 : 55)}ms` }}
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

const waitForPreviewAssets = async (root: HTMLElement): Promise<void> => {
  await document.fonts?.ready;
  await Promise.all([...root.querySelectorAll('img')].map(async image => {
    if (!image.complete) await new Promise<void>(resolve => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    });
    await image.decode?.().catch(() => undefined);
  }));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
};

const LiveDayShareControls = (card: Omit<LiveDayCardProps, 'onClose' | 'captureMode' | 'shareSlot'>) => {
  const previewRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [theme] = useState(currentLiveDayShareTheme);
  const publicSummary = useMemo(() => publicLiveDaySummary(card.summary), [card.summary]);

  const prepare = useCallback(async () => {
    if (!previewRef.current || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await waitForPreviewAssets(previewRef.current);
      // html-to-image při nenačteném obrázku (loga firem, avatar) nehází
      // Error, ale holý Event — bez obalu by uživatel viděl jen obecné
      // „nepodařilo se“ a nepoznal, že selhal náhled, ne uložení.
      const dataUrl = await toPng(previewRef.current, {
        width: 1200,
        height: 630,
        pixelRatio: 1,
        cacheBust: true,
        skipFonts: true,
        backgroundColor: theme === 'light' ? '#e2e8f0' : '#020617',
      }).catch((error: unknown) => {
        if (error instanceof Error) throw error;
        throw new Error('Náhled karty se nepodařilo vykreslit — obnov stránku a zkus to znovu.');
      });
      const preview = await fetch(dataUrl).then(response => response.blob());
      const created = await createLiveDayShare({
        summary: publicSummary,
        owner: card.owner,
        tradeDate: card.tradeDate,
        trades: card.trades,
        losingTrades: card.losingTrades,
        theme,
        preview,
      });
      setShareUrl(created.url);
      setOpen(true);
      setFeedback(null);
    } catch (error) {
      setOpen(true);
      setFeedback(error instanceof Error ? error.message : 'Odkaz se nepodařilo vytvořit.');
    } finally {
      setBusy(false);
    }
  }, [busy, card.losingTrades, card.owner, card.tradeDate, card.trades, publicSummary, theme]);

  const share = useCallback(async () => {
    if (!shareUrl) return;
    // Sdílí se JEN odkaz. Průvodní text vedle něj cíl slepí do jednoho řetězce
    // („…/day/<token> Karta dne 2026-09-21 · AlphaTrade“), chat to zlinkuje
    // celé a token přestane být platné UUID — příjemce pak dostane
    // „Odkaz je poškozený“. Datum i částku nese stránka sama v og: metadatech,
    // takže náhled ve zprávě o nic nepřijde.
    const title = `Karta dne ${liveDayDateLabel(card.tradeDate)} · AlphaTrade`;
    try {
      if (isNativeBuild) {
        const result = await shareTextNative({ text: shareUrl });
        if (result.completed) setFeedback('Odkaz sdílen');
      } else if (navigator.share) {
        await navigator.share({ title, url: shareUrl });
        setFeedback('Odkaz sdílen');
      } else {
        await navigator.clipboard.writeText(shareUrl);
        setFeedback('Odkaz zkopírován');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setFeedback('Sdílení se nepodařilo — použij Kopírovat.');
    }
  }, [card.tradeDate, shareUrl]);

  const copy = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setFeedback('Odkaz zkopírován');
    } catch {
      setFeedback(shareUrl);
    }
  }, [shareUrl]);

  return <>
    {/* Sdílení je v hlavičce karty jako tichá ikona — samostatná lišta pod
        kartou rozbíjela kompozici, kterou má karta držet i po odeslání.
        Stavy se dějí v bublině, takže se karta nikam neposouvá. */}
    <div className="relative">
      <button
        type="button"
        onClick={() => (shareUrl ? setOpen(value => !value) : void prepare())}
        disabled={busy}
        aria-label={shareUrl ? 'Možnosti sdílení' : 'Připravit odkaz ke sdílení'}
        aria-expanded={open}
        title={shareUrl ? 'Možnosti sdílení' : 'Připravit odkaz ke sdílení'}
        className="live-day-ghost"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : shareUrl ? <Check size={13} /> : <Share2 size={13} />}
      </button>

      {open && !busy ? (
        <div className="live-day-sharepop" role="dialog" aria-label="Sdílení karty dne">
          {shareUrl ? <>
            <button type="button" onClick={() => void share()} className="live-day-sharepop-main">
              <Share2 size={13} /> Sdílet odkaz
            </button>
            <button type="button" onClick={() => void copy()} className="live-day-sharepop-alt">
              <Copy size={13} /> Kopírovat
            </button>
          </> : null}
          <p aria-live="polite" className="live-day-sharepop-note">
            {feedback ?? 'Jména účtů jsou v odkazu redigovaná.'}
          </p>
        </div>
      ) : null}
    </div>

    <div
      aria-hidden="true"
      className={theme === 'light' ? 'light-theme' : theme === 'oled' ? 'oled-theme' : undefined}
      style={{ position: 'fixed', left: -20_000, top: 0, width: 1200, height: 630, pointerEvents: 'none' }}
    >
      <div
        ref={previewRef}
        style={{
          width: 1200,
          height: 630,
          padding: '54px 60px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: theme === 'light'
            ? 'radial-gradient(circle at 20% 5%, #cffafe 0, transparent 38%), radial-gradient(circle at 90% 90%, #d1fae5 0, transparent 36%), #e2e8f0'
            : 'radial-gradient(circle at 20% 5%, #083344 0, transparent 38%), radial-gradient(circle at 90% 90%, #052e2b 0, transparent 36%), #020617',
        }}
      >
        <div style={{ width: 1080 }}>
          <LiveDayCard
            {...card}
            summary={publicSummary}
            formatName={name => name}
            captureMode
          />
        </div>
      </div>
    </div>
  </>;
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
      className="live-day-overlay fixed inset-0 z-[155] overflow-y-auto p-4 sm:p-7"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-[940px] items-center justify-center">
        <div className="w-full">
          <LiveDayCard {...card} onClose={onClose} shareSlot={<LiveDayShareControls {...card} />} />
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default LiveDayCard;
