import React, { useEffect, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import type { TicketBracketUnits, TicketInstrument } from '../../lib/liveOrderTicket';
import type { LiveChartPositionSummary } from '../../lib/liveChartPosition';
import {
  MANAGE_BE_MAX_TICKS, liveManageBasis, liveManageBreakEvenOffers, manageDisplayValue, managePriceFromInput, planManageMove,
  type LiveManageBasis, type LiveManageLeg, type LiveManagePlan,
} from '../../lib/liveManagePrices';
import { useLiveManageRunner, type LiveManageCallback, type LiveManageRunnerState } from '../../hooks/useLiveManageRunner';
import { updateLiveTicketPrefs } from '../../lib/liveTicketPrefs';
import { LIVE_PHONE_INSTRUMENT } from '../../lib/livePhoneTrade';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';
import { livePhoneDeviceStorage, livePhoneSheetUnits } from './LivePhoneOrderSheet';
import SheetGrip from './SheetGrip';

const BUY = '#2f6bff';
const SELL = '#ef4655';
const LOSS = '#ff8c95';
const GAIN = '#34d399';

const UNIT_LABEL: Record<TicketBracketUnits, string> = { price: 'Cena', pts: 'Body', ticks: 'Ticky', usd: '$' };
const UNIT_SUFFIX: Record<TicketBracketUnits, string> = { price: '', pts: 'b', ticks: 't', usd: '$' };
const UNITS: readonly TicketBracketUnits[] = ['price', 'pts', 'ticks', 'usd'];
/** Výchozí n u „BE + n ticků“ (smoke test U10: BE + 2 t). */
export const LIVE_PHONE_BE_PLUS_DEFAULT = 2;

const parseNumber = (text: string): number | null => {
  const value = Number.parseFloat(text.replace(/\s/g, '').replace(',', '.').replace('−', '-'));
  return Number.isFinite(value) ? value : null;
};
const formatValue = (value: number, units: TicketBracketUnits) => (units === 'ticks' ? String(Math.round(value)) : value.toFixed(2));

export interface LivePhoneManagePlans {
  basis: LiveManageBasis;
  /** Posun vybrané nohy na číslo z pole (vždy dvoukrokově). */
  move: LiveManagePlan;
  be: LiveManagePlan;
  plus: LiveManagePlan;
  /** null = poplatky leadera nejsou známé → BE s poplatky se nenabízí (U10 §3). */
  fees: LiveManagePlan | null;
}

/**
 * Záměry listu správy (U10) z pojistkového souhrnu v okamžiku výpočtu: číslo z pole
 * v jednotkách → cena (`managePriceFromInput`) → `planManageMove`; BE, BE + n a BE
 * s poplatky z `liveManageBreakEvenOffers`. „Co jsem viděl“ je vždy SL/TP z read modelu
 * brokera, průměr ze stavu pollu, odhad poplatků z řádku leadera skupiny workeru
 * (poslední sazba brokera × kusy). Jen
 * výpočet ceny záměru — nic neodesílá a nic neautorizuje (INV-UI-01..04).
 */
export function livePhoneManagePlans(input: {
  summary: LiveChartPositionSummary | null;
  leaderAccountId: number | null | undefined;
  entryAvg: number | null | undefined;
  leg: LiveManageLeg;
  units: TicketBracketUnits;
  /** Číslo z pole (null = prázdné / nečitelné). */
  value: number | null;
  plusTicks: number;
  instrument?: TicketInstrument;
}): LivePhoneManagePlans {
  const instrument = input.instrument ?? LIVE_PHONE_INSTRUMENT;
  const tick = instrument.tickSize;
  const basis = liveManageBasis(input.summary, input.leaderAccountId, input.entryAvg, instrument.pointValue, tick);
  let move: LiveManagePlan;
  if (!input.summary) move = { ok: false, reason: 'Pozice leadera není známá.', price: null };
  else if (input.value == null) move = { ok: false, reason: 'Zadej číslo.', price: null };
  else {
    const priced = managePriceFromInput({
      side: input.summary.side, leg: input.leg, units: input.units, value: input.value,
      entryAvg: basis.entryAvg, quantity: basis.quantity, pointValue: instrument.pointValue, tick,
    });
    move = 'price' in priced ? planManageMove(input.summary, input.leg, priced.price, { confirm: true, tick }) : { ok: false, reason: priced.blocked, price: null };
  }
  return { basis, move, ...liveManageBreakEvenOffers(input.summary, basis, input.plusTicks) };
}

/**
 * Správa otevřené pozice leadera z telefonu (U10, 3. 11. 2026): SL/TP zadáním čísla
 * (cena / body / ticky / $ od průměru), BE, BE + n ticků a BE s poplatky. Otevírá ho
 * ✎ na vybrané čáře nebo „SL/TP“ v liště pozice (rodič). Odesílá JEN sdílený runner
 * (`useLiveManageRunner` → `manage` = deskový `manageLeaderEntry`, u pozice z přikoupení
 * celá pozice) se zámkem `state` sdíleným s čarami grafu — jeden příkaz naráz, nic se
 * neopakuje. Každé tlačítko je dvoukrokové (druhé klepnutí 350 ms až 4 s, klíč nese akci
 * i ceny) a záměr se při klepnutí počítá znovu. Předkontroly jen blokují; rozhoduje worker.
 */
export default function LivePhoneManageSheet({
  summary, guardAt, leg: initialLeg = 'stopLoss', manage, state, entryAvg, leaderAccountId, instrument = LIVE_PHONE_INSTRUMENT, onNotice, onClose,
}: {
  /** Souhrn pozice leadera z read modelu (`slots.position.summary`). */
  summary: LiveChartPositionSummary | null;
  /** Pojistky utažení SL a BE s kotací IBKR (`LivePhoneChart.guardAt`); vyhodnotí se i při klepnutí. */
  guardAt?: (at: number) => LiveChartPositionSummary | null;
  /** Která noha je vybraná při otevření (čára, na které bylo ✎). */
  leg?: LiveManageLeg;
  /** `LivePhoneTradeBridge.manage`; chybí = správa nejde, tlačítka vypnutá. */
  manage: LiveManageCallback | null | undefined;
  /** Sdílený zámek a „odesílám“ s čarami grafu (`useLivePhoneLineState` v `LivePhoneChart`). */
  state: LiveManageRunnerState;
  /** `LivePhoneTradeBridge.entryAvg` — průměr ze stavu pollu (null = graf předbíhá poll). */
  entryAvg: number | null;
  /** `LivePhoneTradeBridge.leaderAccountId` — leader skupiny workeru (qty a poplatky z jeho řádku). */
  leaderAccountId: number | null | undefined;
  instrument?: TicketInstrument;
  /** Každý výsledek i důvod, proč se nic neposlalo (karta nad grafem). */
  onNotice?: (text: string) => void;
  onClose: () => void;
}) {
  const runner = useLiveManageRunner({
    manage,
    state,
    onNotice: notice => onNotice?.(notice.text),
    landed: { stopLoss: summary?.stop, takeProfit: summary?.target },
  });
  const [leg, setLegState] = useState<LiveManageLeg>(initialLeg);
  const [units, setUnitsState] = useState<TicketBracketUnits>(() => livePhoneSheetUnits(livePhoneDeviceStorage()));
  // Pole drží text jen po úpravě; jinak ukazuje současnou cenu nohy v jednotkách.
  const [text, setText] = useState<string | null>(null);
  const [plusTicks, setPlusTicks] = useState(LIVE_PHONE_BE_PLUS_DEFAULT);
  const [local, setLocal] = useState<string | null>(null);
  // Po potvrzeném posunu pole znovu ukáže skutečnou cenu nohy.
  useEffect(() => { if (runner.result?.tone === 'ok') setText(null); }, [runner.result]);

  const tick = instrument.tickSize;
  const guard = summary ? guardAt?.(Date.now()) ?? summary : null;
  const current = guard ? (leg === 'stopLoss' ? guard.stop : guard.target) : null;
  const basis = liveManageBasis(guard, leaderAccountId, entryAvg, instrument.pointValue, tick);
  const prefill = guard ? manageDisplayValue({ side: guard.side, leg, units, price: current, entryAvg: basis.entryAvg, quantity: basis.quantity, pointValue: instrument.pointValue, tick }) : null;
  const shown = text ?? (prefill == null ? '' : formatValue(prefill, units));
  const plansAt = (at: number) => livePhoneManagePlans({
    summary: summary ? guardAt?.(at) ?? summary : null,
    leaderAccountId, entryAvg, leg, units, value: parseNumber(shown), plusTicks, instrument,
  });
  const plans = plansAt(Date.now());

  const setLeg = (next: LiveManageLeg) => { if (next === leg) return; playNativeHapticIfAvailable('selection'); setLegState(next); setText(null); setLocal(null); runner.cancelConfirm(); };
  const setUnits = (next: TicketBracketUnits) => {
    if (next === units) return;
    playNativeHapticIfAvailable('selection');
    setUnitsState(next);
    setText(null);
    runner.cancelConfirm();
    updateLiveTicketPrefs(livePhoneDeviceStorage(), { units: next });
  };
  const setPlus = (next: number) => { setPlusTicks(Math.max(1, Math.min(MANAGE_BE_MAX_TICKS, Math.round(next)))); runner.cancelConfirm(); };
  const fire = (pick: (fresh: LivePhoneManagePlans) => LiveManagePlan | null) => {
    // Záměr znovu v okamžiku klepnutí (aktuální SL/TP, průměr a pojistka trhu).
    const plan = pick(plansAt(Date.now()));
    if (!plan) return;
    if ('reason' in plan) { setLocal(plan.reason); return; }
    setLocal(null);
    playNativeHapticIfAvailable('medium');
    // Jediná cesta k brokerovi: sdílený runner (dvoukrokově, zámek, bez opakování).
    runner.request(plan.intent);
  };

  const pending = guard?.kind === 'pending';
  const sendable = manage != null && !runner.busy;
  const seg = (on: boolean): React.CSSProperties => ({ height: 30, borderRadius: 9, border: 0, cursor: 'pointer', font: '700 12px Inter, sans-serif', background: on ? 'var(--dj-seg-on)' : 'transparent', color: on ? 'var(--dj-seg-on-ink)' : 'var(--dj-muted)' });
  const segGroup: React.CSSProperties = { display: 'grid', gap: 4, padding: 4, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)' };
  const label: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '12px 2px 6px', fontSize: 12, fontWeight: 700, color: 'var(--dj-muted)' };
  const smallButton: React.CSSProperties = { width: 34, height: 34, borderRadius: 9, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-text)', display: 'grid', placeItems: 'center', cursor: 'pointer', flex: 'none' };
  const action = (plan: LiveManagePlan, idle: string, pick: (fresh: LivePhoneManagePlans) => LiveManagePlan | null, tone: 'primary' | 'plain' = 'plain') => {
    const intent = 'intent' in plan ? plan.intent : null;
    const asking = intent ? runner.asking(intent.confirmKey) : false;
    const disabled = !sendable || intent == null;
    return (
      <button
        type="button"
        className="dj-btn"
        disabled={disabled}
        title={'reason' in plan ? plan.reason : undefined}
        onClick={() => fire(pick)}
        style={{ width: '100%', minHeight: 44, padding: '6px 12px', borderRadius: 12, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: asking ? 0 : '1px solid var(--dj-line)', background: asking ? SELL : tone === 'primary' ? 'linear-gradient(180deg,#6366f1,#4f46e5)' : 'transparent', color: asking || tone === 'primary' ? '#fff' : 'var(--dj-text)', font: '800 13px Inter, sans-serif' }}
      >
        <span>{asking ? 'Opravdu? Klepni znovu' : idle}</span>
        <span className="dj-mono" style={{ fontSize: 12, fontWeight: 700, opacity: 0.9 }}>{intent ? intent.label : 'price' in plan && plan.price != null ? plan.price.toFixed(2) : ''}</span>
      </button>
    );
  };
  const reasonLine = (plan: LiveManagePlan | null) => (plan && 'reason' in plan
    ? <p style={{ margin: '4px 2px 0', fontSize: 11.5, color: 'var(--dj-muted)' }}>{plan.reason}</p> : null);
  const loosen = 'intent' in plans.move && plans.move.intent.leg === 'stopLoss' && plans.move.intent.direction === 'loosen';
  const result = runner.result;

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 46 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
      <section aria-label="Správa pozice" className="dj-scroll" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '86%', overflowY: 'auto', overscrollBehavior: 'contain', borderRadius: '20px 20px 0 0', background: 'var(--dj-sheet, var(--dj-card))', borderTop: '1px solid var(--dj-line)', padding: '8px 16px calc(16px + var(--dj-safe-bottom, env(safe-area-inset-bottom, 0px)))', animation: 'dj-sheet .26s cubic-bezier(.2,.9,.25,1) both' }}>
        <SheetGrip onClose={onClose} gap={6} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <p style={{ margin: 0, flex: 1, fontSize: 16, fontWeight: 800 }}>
            Správa pozice{guard ? <span className="dj-mono" style={{ marginLeft: 8, fontSize: 13, color: guard.side === 'long' ? BUY : SELL }}>{guard.side === 'long' ? 'LONG' : 'SHORT'} {guard.quantity}</span> : null}
          </p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        {guard && (
          <p className="dj-mono" style={{ margin: '0 2px', fontSize: 12, color: 'var(--dj-muted)' }}>
            SL {guard.stop != null ? guard.stop.toFixed(2) : '—'} · TP {guard.target != null ? guard.target.toFixed(2) : '—'} · průměr {basis.entryAvg != null ? basis.entryAvg.toFixed(2) : '—'}
          </p>
        )}
        {!guard && <p style={{ margin: '4px 2px 0', fontSize: 12.5, fontWeight: 600, color: LOSS }}>Pozice leadera není známá — nic se neodešle.</p>}
        {pending && <p style={{ margin: '4px 2px 0', fontSize: 12.5, fontWeight: 600, color: 'var(--dj-amber-text)' }}>Čekající vstup — SL/TP jde posunout až u vyplněné pozice.</p>}
        {!manage && <p style={{ margin: '4px 2px 0', fontSize: 12.5, fontWeight: 600, color: 'var(--dj-amber-text)' }}>Správa z telefonu teď nejde (worker ji neumí nebo obchod není vlastní) — nic se neodešle.</p>}

        <div role="radiogroup" aria-label="Noha" style={{ ...segGroup, gridTemplateColumns: '1fr 1fr', marginTop: 12 }}>
          {(['stopLoss', 'takeProfit'] as const).map(item => (
            <button key={item} type="button" role="radio" aria-checked={leg === item} className="dj-btn" onClick={() => setLeg(item)} style={seg(leg === item)}>{item === 'stopLoss' ? 'Stop loss' : 'Take profit'}</button>
          ))}
        </div>
        <div style={label}><span>{leg === 'stopLoss' ? 'Nový SL' : 'Nový TP'}{units !== 'price' ? ' · od průměru' : ''}</span><span>teď {current != null ? current.toFixed(2) : '—'}</span></div>
        <div role="radiogroup" aria-label="Jednotky" style={{ ...segGroup, gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 8 }}>
          {UNITS.map(unit => <button key={unit} type="button" role="radio" aria-checked={units === unit} className="dj-btn" onClick={() => setUnits(unit)} style={seg(units === unit)}>{UNIT_LABEL[unit]}</button>)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 46, padding: '0 12px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)' }}>
          {leg === 'stopLoss' && units !== 'price' && (
            // iOS číselná klávesnice nemá mínus: záporné SL = zamčený zisk za průměrem.
            <button type="button" className="dj-btn" aria-label="Změnit znaménko" onClick={() => { const value = parseNumber(shown); if (value != null) { setText(formatValue(-value, units)); runner.cancelConfirm(); } }} style={{ ...smallButton, width: 30, height: 30, font: '800 14px Inter, sans-serif' }}>±</button>
          )}
          <input aria-label={leg === 'stopLoss' ? 'Nový stop loss' : 'Nový take profit'} inputMode="decimal" value={shown} onChange={event => { setText(event.target.value); setLocal(null); runner.cancelConfirm(); }} style={{ flex: 1, minWidth: 0, height: '100%', border: 0, outline: 0, background: 'transparent', color: 'var(--dj-text)', font: '600 16px "JetBrains Mono", ui-monospace, monospace' }} />
          {UNIT_SUFFIX[units] && <span className="dj-mono" style={{ fontSize: 12, color: 'var(--dj-muted)' }}>{UNIT_SUFFIX[units]}</span>}
        </div>
        <div style={{ marginTop: 8 }}>
          {action(plans.move, 'Posunout', fresh => fresh.move, 'primary')}
          {reasonLine(plans.move)}
          {loosen && <p style={{ margin: '4px 2px 0', fontSize: 11.5, color: 'var(--dj-amber-text)' }}>SL dál od trhu = víc rizika; worker ho přepočítá.</p>}
        </div>

        <div style={label}><span>Stop loss na break-even</span><span>dvě klepnutí</span></div>
        <div style={{ display: 'grid', gap: 6 }}>
          {action(plans.be, 'BE', fresh => fresh.be)}
          {reasonLine(plans.be)}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" className="dj-btn" aria-label="Méně ticků" onClick={() => setPlus(plusTicks - 1)} style={smallButton}><Minus size={16} /></button>
            <div style={{ flex: 1, minWidth: 0 }}>{action(plans.plus, `BE + ${plusTicks} t`, fresh => fresh.plus)}</div>
            <button type="button" className="dj-btn" aria-label="Více ticků" onClick={() => setPlus(plusTicks + 1)} style={smallButton}><Plus size={16} /></button>
          </div>
          {reasonLine(plans.plus)}
          {/* Poplatky = odhad z poslední sazby brokera (posledních fillů) × kusy, ne skutečné poplatky pozice. */}
          {plans.fees && action(plans.fees, 'BE + odhad poplatků', fresh => fresh.fees)}
          {reasonLine(plans.fees)}
        </div>

        {local && <p role="status" style={{ margin: '10px 2px 0', fontSize: 12.5, fontWeight: 600, color: LOSS }}>{local}</p>}
        {runner.pendingMove && <p role="status" style={{ margin: '10px 2px 0', fontSize: 12.5, fontWeight: 600, color: 'var(--dj-muted)' }}>Odesílám {runner.pendingMove.kind === 'stopLoss' ? 'SL' : 'TP'} {runner.pendingMove.price.toFixed(2)}…</p>}
        {result && <p role="status" style={{ margin: '10px 2px 0', fontSize: 12.5, fontWeight: 700, color: result.tone === 'ok' ? GAIN : result.tone === 'bad' ? LOSS : 'var(--dj-amber-text)' }}>{result.text}</p>}
      </section>
    </div>
  );
}
