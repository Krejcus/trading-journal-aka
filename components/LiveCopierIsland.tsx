import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import type { LiveCopierIslandModel, LiveIslandField } from '../lib/liveCopierIsland';

const TONE_CLASS: Record<LiveCopierIslandModel['tone'], string> = {
  muted: 'live-island-muted',
  ok: 'live-island-ok',
  active: 'live-island-active',
  danger: 'live-island-danger',
};

const FIELD_TONE: Record<NonNullable<LiveIslandField['tone']>, string> = {
  'pnl-positive': 'text-emerald-500',
  'pnl-negative': 'text-rose-500',
  warn: 'text-amber-500',
  danger: 'text-rose-500',
};

const fieldClass = (tone?: LiveIslandField['tone']) =>
  tone ? FIELD_TONE[tone] : 'text-[var(--text-secondary)]';

/**
 * Plovoucí stav kopírky. Drží se okna, ne obsahu, takže je vidět i po
 * odscrollování — a s ním i akce, která v dané chvíli řeší problém.
 *
 * Stav se vykresluje SYNCHRONNĚ; animace je jen dekorace navrch. Kdyby model
 * přišel během běžící animace (a to se děje, protože ho mění data, ne klik),
 * nesmí se ztratit ani zůstat schovaný pod nedoběhlým přechodem.
 */
export default function LiveCopierIsland({ model, onAction, offsetTop = 92, anchorId }: {
  model: LiveCopierIslandModel | null;
  onAction?: (action: NonNullable<LiveCopierIslandModel['action']>) => void;
  /** Odsazení od horní hrany okna — musí minout plovoucí hlavičku. */
  offsetTop?: number;
  /** `data-flip-id` řádku skupiny. Dokud je vidět, ostrov se schová — stav
   *  čteš přímo z něj a plovoucí pilulka by jen překrývala obsah. */
  anchorId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Zpočátku skrytý: než observer změří kotvu, ostrov nic nepřekrývá.
  const [anchorVisible, setAnchorVisible] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const previousPhase = useRef<string | null>(null);

  useEffect(() => setMounted(true), []);

  // Porucha se hlásí vždycky; klidové stavy až ve chvíli, kdy skupina
  // vyscrolluje z dohledu.
  const always = model?.phase === 'divergence' || model?.tone === 'danger';
  useEffect(() => {
    if (!mounted || always || !anchorId) { setAnchorVisible(false); return; }
    const anchor = document.querySelector(`[data-flip-id="${CSS.escape(anchorId)}"]`);
    if (!anchor || typeof IntersectionObserver === 'undefined') { setAnchorVisible(false); return; }
    const observer = new IntersectionObserver(
      entries => setAnchorVisible(entries.some(entry => entry.isIntersecting)),
      // Kotvu bereme za viditelnou, jen když není schovaná pod hlavičkou.
      { rootMargin: `-${offsetTop}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [mounted, always, anchorId, offsetTop, model?.phase]);

  // Pulz při změně fáze. Třída se odstraní časovačem, ale i kdyby se
  // nespustil, zůstane jen animace navíc — obsah je vykreslený nezávisle.
  const [pulse, setPulse] = useState<'soft' | 'hard' | null>(null);
  useEffect(() => {
    if (!model) return;
    if (previousPhase.current === null) { previousPhase.current = model.phase; return; }
    if (previousPhase.current === model.phase) return;
    previousPhase.current = model.phase;
    setPulse(model.phase === 'divergence' ? 'hard' : 'soft');
    const timer = window.setTimeout(() => setPulse(null), 500);
    return () => window.clearTimeout(timer);
  }, [model]);

  const toggle = useCallback(() => setOpen(current => !current), []);

  if (!mounted || !model) return null;
  const hidden = anchorVisible && !always;

  const body = (
    <div
      className={`live-island-dock pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-4${
        hidden ? ' is-hidden' : ''}`}
      style={{ top: offsetTop }}
      aria-hidden={hidden}
    >
      <div
        ref={boxRef}
        role="status"
        aria-live={model.phase === 'divergence' ? 'assertive' : 'polite'}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={event => { if (!(event.target as HTMLElement).closest('button')) toggle(); }}
        className={`live-island pointer-events-auto ${TONE_CLASS[model.tone]} ${open ? 'is-open' : ''} ${pulse ? `is-${pulse}` : ''}`}
      >
        <div className="live-island-row">
          <span className="live-island-dot" aria-hidden="true" />
          <span className="live-island-title">{model.title}</span>
          {model.detail ? (
            <>
              <span className="live-island-sep" aria-hidden="true" />
              <span className={`live-island-value ${fieldClass(model.detail.tone)}`}>{model.detail.value}</span>
            </>
          ) : null}
          {model.extra ? (
            <>
              <span className="live-island-sep" aria-hidden="true" />
              <span className="live-island-value text-[var(--text-secondary)]">{model.extra.value}</span>
            </>
          ) : null}
          <ChevronDown size={11} strokeWidth={2.6} className={`live-island-chev ${open ? 'is-open' : ''}`} aria-hidden="true" />
          {model.action && model.actionLabel ? (
            <button
              type="button"
              onClick={event => { event.stopPropagation(); onAction?.(model.action!); }}
              className={`live-island-action ${model.action === 'show' ? '' : 'is-danger'}`}
            >
              {model.actionLabel}
            </button>
          ) : null}
        </div>
        {/* Rozbalení přes grid-template-rows 0fr→1fr: výška se animuje sama,
            bez měření v JS. Obsah je v DOM pořád, jinak by se výška neměla
            z čeho spočítat a ostrov by skákal. */}
        <div className="live-island-expand" aria-hidden={!open}>
          <div>
            <div className="live-island-fields">
              {model.fields.map(field => (
                <div key={field.label}>
                  <span>{field.label}</span>
                  <b className={fieldClass(field.tone)}>{field.value}</b>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
