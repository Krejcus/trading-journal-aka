import React from 'react';
import { ChevronDown, X } from 'lucide-react';
import { LiveOpenPnlValue, LiveTvMark, TV_LIVE_PNL_TITLE } from '../LiveOpenPnlValue';
import type { LiveChartPosition, LiveChartPositionAccountRow } from '../../lib/liveChartPosition';
import { contractRoot, livePhoneGroupLine } from '../../lib/livePhoneTrade';
import { liveChartPositionTvLegs } from '../../lib/tvLivePnl';
import { formatLivePrice } from './LivePhoneTrade';
import SheetGrip from './SheetGrip';

/**
 * P&L skupiny na LIVE grafu telefonu (varianta A, Filip 2. 11.): součet sedí
 * v hlavičce místo názvu skupiny, klepnutí vysune list s účty. Jen zobrazení
 * stejného read modelu jako PC graf (`useLiveChartData`) — žádné tlačítko
 * odsud nic neodesílá (INV-UI-01/03). Neověřený stav řekne slovy, nikdy
 * „flat“ ani poslední známé číslo. Živý pohyb P&L s cenou trhu jen na
 * obrazovce (INV-UI-04).
 */

const usd = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`;
const tone = (value: number) => (value > 0 ? '#34d399' : value < 0 ? '#fb7185' : 'var(--dj-muted)');

/** Tlačítko do hlavičky. `null` = bez pozice a bez příkazu (hlavička ukáže název skupiny). */
export function LivePhoneGroupPnl({ position, onOpen }: { position: LiveChartPosition; onOpen: () => void }) {
  const summary = position.summary;
  if (!summary && !position.issue) return null;
  const box: React.CSSProperties = {
    flex: '1 1 auto', minWidth: 0, height: 36, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', columnGap: 6, alignContent: 'center',
    padding: '0 8px 0 10px', borderRadius: 10, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', color: 'var(--dj-text)', textAlign: 'left',
  };
  const top: React.CSSProperties = { gridRow: 1, fontSize: 10.5, fontWeight: 600, color: 'var(--dj-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const bottom: React.CSSProperties = { gridRow: 2, fontSize: 14, fontWeight: 800, lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  if (!summary) {
    return (
      <span role="status" data-live-group-pnl="issue" style={{ ...box, cursor: 'default' }}>
        <span style={top}>Pozice</span>
        <span style={{ ...bottom, fontSize: 12, fontWeight: 700, color: 'var(--dj-muted)' }}>{position.issue}</span>
      </span>
    );
  }
  return (
    <button type="button" className="dj-btn" aria-label="Účty v obchodě" data-live-group-pnl={summary.kind} onClick={onOpen} style={{ ...box, cursor: 'pointer' }}>
      <span style={top}>{livePhoneGroupLine(position)}</span>
      <span className="dj-mono" style={bottom}>
        {summary.kind === 'pending'
          ? <span style={{ color: 'var(--dj-muted)', fontSize: 12.5 }}>čeká na fill{summary.entry != null ? ` · ${formatLivePrice(summary.entry)}` : ''}</span>
          : summary.openPnl == null
            ? <span style={{ color: 'var(--dj-muted)' }}>P&amp;L —</span>
            : <LiveOpenPnlValue anchor={summary.openPnl} legs={liveChartPositionTvLegs(position)}>
              {(value, live) => <span title={live ? TV_LIVE_PNL_TITLE : undefined} style={{ color: tone(value) }}>{usd(value)}{live ? <LiveTvMark /> : null}</span>}
            </LiveOpenPnlValue>}
      </span>
      <ChevronDown size={14} color="var(--dj-muted)" style={{ gridColumn: 2, gridRow: '1 / span 2', alignSelf: 'center' }} />
    </button>
  );
}

/** List s účty skupiny v obchodě: otevřený P&L a SL/TP v dolarech u každého účtu. */
export function LivePhoneAccountsSheet({ position, onClose }: { position: LiveChartPosition; onClose: () => void }) {
  const summary = position.summary;
  const long = summary?.side === 'long';
  const head = summary
    ? `${contractRoot(position.symbol)} ${summary.kind === 'position' ? (long ? 'Long' : 'Short') : (long ? 'Buy' : 'Sell')} ${summary.quantity}${summary.entry != null ? ` @ ${formatLivePrice(summary.entry)}` : ''}`
    : null;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 45 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
      <section aria-label="Účty v obchodě" className="dj-scroll" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80%', overflowY: 'auto', borderRadius: '20px 20px 0 0', background: 'var(--dj-sheet, var(--dj-card))', borderTop: '1px solid var(--dj-line)', padding: '8px 0 calc(16px + var(--dj-safe-bottom, env(safe-area-inset-bottom, 0px)))', animation: 'dj-sheet .26s cubic-bezier(.2,.9,.25,1) both' }}>
        <div style={{ padding: '0 16px' }}><SheetGrip onClose={onClose} gap={6} /></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 10px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Účty v obchodě</p>
            <p className="dj-mono" style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--dj-muted)' }}>
              {head ?? position.issue ?? 'Bez pozice'}{summary ? ` · ${summary.protection}` : ''}
            </p>
          </div>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        {summary && <>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 96px', padding: '6px 16px', fontSize: 11, fontWeight: 600, color: 'var(--dj-muted)', borderTop: '1px solid var(--dj-line)', borderBottom: '1px solid var(--dj-line)' }}>
            <span>Účet</span><span style={{ textAlign: 'right' }}>{summary.kind === 'position' ? 'Otevřený' : 'Stav'}</span>
          </div>
          {summary.rows.map(row => <AccountRow key={row.accountId} row={row} position={position} />)}
          {summary.kind === 'position' && (
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '12px 16px 0', fontSize: 12.5, color: 'var(--dj-muted)' }}>
              <span>Celkem otevřeno</span>
              <span className="dj-mono" style={{ fontSize: 15, fontWeight: 800 }}>
                {summary.openPnl == null ? '—' : <LiveOpenPnlValue anchor={summary.openPnl} legs={liveChartPositionTvLegs(position)}>
                  {(value, live) => <span title={live ? TV_LIVE_PNL_TITLE : undefined} style={{ color: tone(value) }}>{usd(value)}{live ? <LiveTvMark /> : null}</span>}
                </LiveOpenPnlValue>}
              </span>
            </div>
          )}
          <p style={{ margin: 0, padding: '10px 16px 0', fontSize: 11, color: 'var(--dj-muted)', opacity: 0.8 }}>
            {summary.rows.every(row => row.fees != null) ? 'Z brokera po poplatcích.' : 'Z brokera, bez poplatků (broker je neposlal).'} Živý pohyb s cenou trhu je jen pro zobrazení.
          </p>
        </>}
      </section>
    </div>
  );
}

function AccountRow({ row, position }: { row: LiveChartPositionAccountRow; position: LiveChartPosition }) {
  const summary = position.summary!;
  const side = summary.side === 'long' ? 'L' : 'S';
  // Neznámé ≠ žádné: „bez SL“ jen u ověřených příkazů bez krytí (INV-UI-03).
  const level = (label: 'SL' | 'TP', price: number | null, value: number | null, coverage: number, color: string) => {
    if (!row.ordersVerified) return <span title="Příkazy účtu nejsou ověřené">{label} ?</span>;
    if (price == null) return coverage > 0 ? <span style={{ color }}>{label} víc cen</span> : <span>bez {label}</span>;
    const partial = coverage < row.quantity ? ` (${coverage}/${row.quantity})` : '';
    return <span style={{ color }}>{label} {value != null ? usd(value) : formatLivePrice(price)}{partial}</span>;
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 96px', gap: 8, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--dj-line)' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 700, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
          {row.isLeader && <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em', color: '#fbbf24' }}>LEADER</span>}
        </div>
        <div className="dj-mono" style={{ display: 'flex', flexWrap: 'wrap', columnGap: 6, rowGap: 1, marginTop: 3, fontSize: 11.5, color: 'var(--dj-muted)', whiteSpace: 'nowrap' }}>
          <span>{side} {row.quantity}{row.entry != null ? ` @ ${formatLivePrice(row.entry)}` : ''}</span>
          {level('SL', row.stop, row.stopUsd, row.stopCoverage, '#f87171')}
          {level('TP', row.target, row.targetUsd, row.targetCoverage, '#2dd4bf')}
        </div>
      </div>
      <div className="dj-mono" style={{ textAlign: 'right', fontSize: 14.5, fontWeight: 800 }}>
        {summary.kind === 'pending'
          ? <span style={{ color: 'var(--dj-muted)', fontSize: 12.5 }}>čeká</span>
          : row.openPnl == null
            ? <span style={{ color: 'var(--dj-muted)' }}>—</span>
            : <LiveOpenPnlValue anchor={row.openPnl} legs={liveChartPositionTvLegs(position, [row])}>
              {(value, live) => <span title={live ? TV_LIVE_PNL_TITLE : undefined} style={{ color: tone(value) }}>{usd(value)}{live ? <LiveTvMark /> : null}</span>}
            </LiveOpenPnlValue>}
      </div>
    </div>
  );
}
