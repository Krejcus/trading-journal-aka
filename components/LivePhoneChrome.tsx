import React from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { TradovateLiveTab } from '../lib/tradovateLiveTab';

export type LivePhoneCopierState = 'on' | 'off' | 'unverified' | 'pending';

const COPIER: Record<LivePhoneCopierState, { label: string; color: string; ring: string }> = {
  // Zapnutá kopírka: jantarový prstenec (směr Aurora), ne zelená.
  on: { label: 'Kopírka ZAP', color: '#fbbf24', ring: 'rgba(251,191,36,.45)' },
  off: { label: 'Kopírka VYP', color: 'var(--dj-muted)', ring: 'var(--dj-line)' },
  unverified: { label: 'Kopírka neověřená', color: '#fbbf24', ring: 'var(--dj-line)' },
  pending: { label: 'Kopírka…', color: 'var(--dj-muted)', ring: 'var(--dj-line)' },
};

/**
 * Hlavička LIVE nad telefonním grafem: „LIVE ▾“ otevře menu záložek, vedle
 * skupina a stav kopírky. Jen zobrazení (INV-UI-01/03) — nic neodesílá.
 */
export function LivePhoneHeader({ groupName, copier, onMenu }: {
  groupName: string | null;
  copier: LivePhoneCopierState;
  onMenu: () => void;
}) {
  const state = COPIER[copier];
  const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 9, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', minWidth: 0 };
  return (
    <div className="dj-glass" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--dj-line)', background: 'var(--dj-card)' }}>
      <button type="button" className="dj-btn" aria-label="LIVE menu" onClick={onMenu} style={{ ...chip, height: 32, padding: '0 10px 0 12px', color: '#a5b4fc', fontWeight: 900, letterSpacing: '.06em', cursor: 'pointer' }}>
        LIVE<ChevronDown size={14} color="var(--dj-muted)" />
      </button>
      {groupName && <span style={{ ...chip, color: 'var(--dj-text)', overflow: 'hidden', textOverflow: 'ellipsis' }}><i style={{ width: 7, height: 7, borderRadius: 7, background: '#818cf8', flex: 'none' }} />{groupName}</span>}
      <span style={{ ...chip, color: state.color, boxShadow: copier === 'on' ? `0 0 0 2px ${state.ring}` : undefined }}>{state.label}</span>
    </div>
  );
}

/** Menu LIVE záložek nad grafem (spodní list). Výběr přejde na záložku. */
export function LivePhoneMenu({ tabs, onPick, onClose }: {
  tabs: Array<{ id: TradovateLiveTab; label: string; icon: React.ElementType }>;
  onPick: (tab: TradovateLiveTab) => void;
  onClose: () => void;
}) {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 45 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
      <section aria-label="LIVE" className="dj-scroll" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80%', overflowY: 'auto', borderRadius: '20px 20px 0 0', background: 'var(--dj-sheet, var(--dj-card))', borderTop: '1px solid var(--dj-line)', padding: '8px 16px calc(16px + env(safe-area-inset-bottom, 0px))', animation: 'dj-sheet .26s cubic-bezier(.2,.9,.25,1) both' }}>
        <div aria-hidden="true" style={{ display: 'grid', placeItems: 'center', padding: '0 0 6px' }}><span style={{ width: 38, height: 5, borderRadius: 3, background: 'var(--dj-line)', filter: 'brightness(2.2)' }} /></div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <p style={{ margin: 0, flex: 1, fontSize: 16, fontWeight: 800 }}>LIVE</p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        {tabs.map(item => {
          const Icon = item.icon;
          return (
            <button key={item.id} type="button" className="dj-btn" onClick={() => onPick(item.id)} style={{ width: '100%', minHeight: 48, display: 'flex', alignItems: 'center', gap: 12, padding: '6px 4px', border: 0, borderBottom: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', fontSize: 15, fontWeight: 600, textAlign: 'left', cursor: 'pointer' }}>
              <Icon size={18} color="var(--dj-muted)" />
              <span style={{ flex: 1 }}>{item.label}</span>
              <ChevronRight size={16} color="var(--dj-muted)" />
            </button>
          );
        })}
      </section>
    </div>
  );
}
