import React, { useState } from 'react';
import { X } from 'lucide-react';
import { snapToTick } from '../../lib/liveOrderTicket';
import {
  LIVE_ATTACH_DEFAULT_TARGET_POINTS, liveAttachDefaults, liveAttachProblem,
} from '../../lib/liveBareEntry';
import { LIVE_BUILTIN_TEMPLATE_ID, defaultLiveBracketTemplate, liveTemplateBracketPrices, type LiveBracketTemplate } from '../../lib/liveBracketTemplates';
import { readLiveBracketTemplates } from '../../services/liveBracketTemplateStore';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';
import { createLiveManageRun, type LiveManageCallback, type LiveManageOutcome, type LiveManageRunDeps } from '../../hooks/useLiveManageRunner';
import type { LiveBareCloseOffer } from '../../lib/liveBareCloseUi';
import type { LiveCancelPendingView } from '../../lib/liveCancelPendingUi';
import { useLiveCancelPendingAction, type LiveCancelPendingCallback } from '../LivePendingCancel';
import { useLiveConfirmGate } from '../../hooks/useLiveConfirmGate';
import type { LiveConfirmGate } from '../../lib/liveConfirmGate';
import SheetGrip from './SheetGrip';

const SELL = '#ef4655';
const BUY = '#2f6bff';

/**
 * Klíč dvoukrokového „Zavřít / Zrušit“ lišty pozice: akce + to, co uživatel viděl.
 * Čekající vstup se mezi klepnutími vyplní (nebo změní počet, stranu, cenu) = jiný
 * klíč → druhé klepnutí jen znovu zeptá, nikdy nepotvrdí jinou akci (oponentura 2. 11.).
 */
export function livePhonePositionCloseKey(input: {
  side: 'long' | 'short';
  quantity: number;
  symbol: string;
  pending: { type: string | null; price: number | null } | null;
}): string {
  return input.pending
    ? `cancel-entry:${input.symbol}:${input.side}:${input.quantity}:${input.pending.type ?? ''}:${input.pending.price ?? ''}`
    : `flatten:${input.symbol}:${input.side}:${input.quantity}`;
}

/**
 * „Zavřít / Zrušit“ lišty pozice po potvrzeném dvoukroku (oponentura vlny B, INV-RELAY-01,
 * INV-MANUAL-01): čekající vstup se ruší cílenou cestou `cancel-entry` PŘES SDÍLENÝ ZÁMEK
 * čar a listu správy (`lineState.busyRef` rodiče) — když × / BE / posun z čáry právě
 * letí, druhý příkaz neodejde (runner napíše „Čeká se na výsledek předchozí změny“).
 * Výsledek i chyba mají stejné texty jako × na čáře; nic se neopakuje. Flatten (pozice,
 * nebo když cílená cesta chybí) zůstává mimo zámek i mimo `busy` (INV-UI-02 — snižuje
 * riziko a musí jít vždy).
 */
export function createLivePhoneBarClose(deps: {
  /** Aktuální most telefonu (čte se při každém klepnutí). */
  trade: () => { manage?: LiveManageCallback | null; flatten: () => Promise<string> } | null;
  /** Sdílený zámek jednoho příkazu (`useLivePhoneLineState().busyRef`). */
  busyRef: LiveManageRunDeps['busyRef'];
  setPendingMove: LiveManageRunDeps['setPendingMove'];
  say: (text: string) => void;
}): (position: { pending: { price: number | null } | null }) => Promise<
  { kind: 'cancel'; outcome: LiveManageOutcome } | { kind: 'flatten' } | { kind: 'none' }
> {
  const cancel = createLiveManageRun({
    manage: () => deps.trade()?.manage,
    busyRef: deps.busyRef,
    setPendingMove: deps.setPendingMove,
    report: notice => deps.say(notice.text),
  });
  return async position => {
    const trade = deps.trade();
    const pendingPrice = position.pending?.price ?? null;
    if (position.pending && trade?.manage && pendingPrice != null) {
      return { kind: 'cancel', outcome: await cancel('cancel-entry', pendingPrice) };
    }
    if (!trade) return { kind: 'none' };
    try {
      deps.say(await trade.flatten());
    } catch (error) {
      deps.say(`Flatten: ${error instanceof Error ? error.message.slice(0, 140) : 'chyba'}`);
    }
    return { kind: 'flatten' };
  };
}

/**
 * Pozice leadera nad telefonním grafem (2. 11. 2026): strana, počet, varování
 * „bez SL/TP“ u holého Marketu, doplnění nohou a zavření Flattenem (jediný DEMO
 * účet manual-only skupiny). „Zrušit“ u čekajícího vstupu = cancel-entry jen toho
 * vstupu (3. 11.; o cestě rozhoduje rodič), Flatten jen u pozice nebo jako záloha.
 *
 * Zavření / zrušení je dvoukrokové (vzor `BacktestOrderLinesOverlay`): druhé klepnutí
 * nejdřív za 350 ms a nejpozději do 4 s, se stejným klíčem akce. Tlačítko nikdy nečeká
 * na sdílený zámek `busy` (rozpracovaný vstup / attach) — záložní Flatten musí jít vždy
 * (INV-UI-02); `busy` vypíná jen „Přidat SL/TP“.
 */
export function LivePhonePositionBar({ side, quantity, symbol, pending = null, unprotected, busy, onAttach, onClose, onManage, bareClose = null, onBareClose }: {
  side: 'long' | 'short';
  quantity: number;
  symbol: string;
  /** Jen čekající vstup (Limit/Stop), pozice zatím není — „Zrušit“ zruší jen tento vstup (cancel-entry); Flatten až bez cílené cesty. */
  pending?: { type: string | null; price: number | null } | null;
  unprotected: boolean;
  busy: boolean;
  onAttach: () => void;
  onClose: () => void;
  /** U10: „SL/TP“ otevře list správy (číslo, BE + n, BE s poplatky). Chybí = správa z lišty není. */
  onManage?: () => void;
  /**
   * C8 (4. 11. 2026): × zavřít vlastní holý Market (`close-position`) — vlastní tlačítko „Zavřít“
   * s klíčem akce + `entryOperationId` (`offer.key`); Flatten pak zůstává vedle jako „Flatten“
   * (mimo zámek). Chybí / null (starý worker, přehrávání) = „Zavřít“ je Flatten jako dřív.
   */
  bareClose?: LiveBareCloseOffer | null;
  /** Rodič ověří, že nabídka má pořád tento klíč, a pošle ji sdíleným zámkem čar. */
  onBareClose?: (key: string) => void;
}) {
  const actionKey = livePhonePositionCloseKey({ side, quantity, symbol, pending });
  const bare = !pending && bareClose && onBareClose ? bareClose : null;
  // JEDEN automat potvrzení pro Flatten / Zrušit i „Zavřít“ holé pozice: klepnutí na jedno a pak
  // na druhé nic nepošle (jiný klíč). Zablokovaná nebo zmizelá nabídka C8 i změněná pozice zahodí
  // rozběhnuté „Opravdu?“ i bez klepnutí; po 4 s zmizí samo.
  const { gate } = useLiveConfirmGate([{ key: actionKey, enabled: true }, bare]);
  const confirming = gate.asking(actionKey);
  const bareConfirming = bare != null && gate.asking(bare.key);
  // U holé pozice (bez SL/TP) je záložní tlačítko VŽDY „Flatten“ — i bez nabídky C8 a při
  // přehrávání; „Zavřít“ znamená jen cílené zavření holé pozice (C8). Spravovaná pozice beze změny.
  const flattenLabel = !pending && (bare != null || unprotected);
  const chip: React.CSSProperties = { height: 30, padding: '0 10px', borderRadius: 9, border: 0, cursor: 'pointer', font: '800 12px Inter, sans-serif', color: '#fff' };
  return (
    <div role="group" aria-label={pending ? 'Čekající příkaz' : 'Pozice'} style={{ position: 'absolute', zIndex: 24, top: 8, left: 8, right: 8, pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 6, padding: 6, borderRadius: 12, border: `1px solid ${unprotected ? 'rgba(239,70,85,.7)' : 'var(--dj-line)'}`, background: 'var(--dj-glass, rgba(13,18,27,.94))', boxShadow: '0 14px 34px -16px rgba(0,0,0,.75)' }}>
      {pending
        ? <span className="dj-mono" style={{ fontWeight: 800, fontSize: 13, color: side === 'long' ? BUY : SELL }}>ČEKÁ {side === 'long' ? 'BUY' : 'SELL'} {quantity} {pendingTypeLabel(pending.type)}{pending.price != null ? ` ${pending.price.toFixed(2)}` : ''}</span>
        : <span className="dj-mono" style={{ fontWeight: 800, fontSize: 13, color: side === 'long' ? BUY : SELL }}>{side === 'long' ? 'LONG' : 'SHORT'} {quantity}</span>}
      <span className="dj-mono" style={{ fontSize: 11, color: 'var(--dj-muted)' }}>{symbol}</span>
      {unprotected && <span style={{ fontSize: 11, fontWeight: 800, color: SELL }}>BEZ SL/TP</span>}
      <span style={{ flex: 1 }} />
      {unprotected && <button type="button" className="dj-btn" disabled={busy} onClick={() => { playNativeHapticIfAvailable('selection'); onAttach(); }} style={{ ...chip, background: 'linear-gradient(180deg,#6366f1,#4f46e5)', opacity: busy ? 0.6 : 1 }}>Přidat SL/TP</button>}
      {/* Správa jen otevře list — příkaz odejde až tlačítkem v něm (INV-UI-01). */}
      {onManage && !pending && !unprotected && <button type="button" className="dj-btn" aria-label="Správa SL a TP" onClick={() => { playNativeHapticIfAvailable('selection'); onManage(); }} style={{ ...chip, background: 'var(--dj-chip)', color: 'var(--dj-text)' }}>SL/TP</button>}
      {/* C8: × holé pozice dvoukrokově (klíč akce + id vstupu); zámek hlídá rodič. Neaktivní = jen důvod. */}
      {bare && <button
        type="button"
        className="dj-btn"
        data-live-bare-close
        aria-label={bare.enabled ? (bareConfirming ? 'Potvrdit zavření holé pozice' : 'Zavřít holou pozici') : `Zavřít teď nejde: ${bare.reason ?? ''}`}
        onClick={event => {
          event.currentTarget.blur();
          playNativeHapticIfAvailable('medium');
          const action = livePhoneBarClick(gate, 'bare', { flattenKey: actionKey, bare });
          if (action === 'bare-close' || action === 'bare-blocked') onBareClose!(bare.key);
        }}
        style={{ ...chip, background: bareConfirming ? SELL : 'var(--dj-chip)', color: bareConfirming ? '#fff' : 'var(--dj-text)', opacity: bare.enabled ? 1 : 0.55 }}
      >{bareConfirming ? 'Opravdu zavřít?' : 'Zavřít'}</button>}
      {/* Flatten / Zrušit nikdy nečeká na rozpracovaný vstup/attach ani na zámek (INV-UI-02): bez `busy`. */}
      <button
        type="button"
        className="dj-btn"
        data-live-bar-flatten
        aria-label={pending ? (confirming ? 'Potvrdit zrušení čekajícího příkazu' : 'Zrušit čekající příkaz')
          : flattenLabel ? (confirming ? 'Potvrdit Flatten' : 'Flatten — zavřít vše')
            : confirming ? 'Potvrdit zavření (Flatten)' : 'Zavřít pozici (Flatten)'}
        onClick={event => {
          event.currentTarget.blur();
          playNativeHapticIfAvailable('medium');
          if (livePhoneBarClick(gate, 'flatten', { flattenKey: actionKey, bare }) === 'flatten') onClose();
        }}
        style={{ ...chip, background: confirming ? SELL : 'var(--dj-chip)', color: confirming ? '#fff' : 'var(--dj-text)' }}
      >{pending ? (confirming ? 'Opravdu zrušit?' : 'Zrušit') : flattenLabel ? (confirming ? 'Opravdu Flatten?' : 'Flatten') : confirming ? 'Opravdu zavřít?' : 'Zavřít'}</button>
    </div>
  );
}

/**
 * Klepnutí v liště pozice (čistý krok, sdílený automat `gate`): `flatten` = druhé klepnutí na
 * Flatten / Zrušit se stejným klíčem; `bare-close` = druhé klepnutí na „Zavřít“ holé pozice
 * s klíčem nabídky; `bare-blocked` = nabídka je zablokovaná (rodič jen řekne důvod, nic neodešle).
 * Klepnutí na jedno tlačítko a pak na druhé nic nepošle (jiný klíč = znovu první krok).
 */
export function livePhoneBarClick(
  gate: LiveConfirmGate,
  which: 'flatten' | 'bare',
  input: { flattenKey: string; bare: LiveBareCloseOffer | null },
): 'flatten' | 'bare-close' | 'bare-blocked' | null {
  if (which === 'flatten') return gate.click({ key: input.flattenKey, enabled: true }).kind === 'send' ? 'flatten' : null;
  const step = gate.click(input.bare);
  return step.kind === 'send' ? 'bare-close' : step.kind === 'blocked' ? 'bare-blocked' : null;
}

/**
 * C7 (4. 11. 2026): „Zrušit čekající (N)“ nad telefonním grafem — jen když pohled desku říká
 * ano (capability, vlastní čekající vstupy), dvoukrokově (`useLiveCancelPendingAction`: klíč =
 * sada, 2. klepnutí 350 ms – 4 s od předchozího), sdíleným zámkem čar (`lockRef`), text kolik
 * a čeho. Za přehrávání ho rodič nevykreslí (bez ovládání). Flatten tudy nejde.
 */
export function LivePhoneCancelPendingChip({ view, lockRef, cancel, top, onNotice }: {
  view: LiveCancelPendingView;
  lockRef: { current: boolean };
  cancel: LiveCancelPendingCallback;
  top: number;
  onNotice: (text: string) => void;
}) {
  const action = useLiveCancelPendingAction({ view, lockRef, cancel, onNotice: notice => onNotice(notice.text) });
  return (
    <div role="group" aria-label="Čekající vstupy" style={{ position: 'absolute', zIndex: 24, top, right: 8, pointerEvents: 'auto', display: 'grid', justifyItems: 'end', gap: 4, maxWidth: 'calc(100% - 16px)' }}>
      <button
        type="button"
        className="dj-btn"
        data-live-cancel-pending
        aria-label={view.enabled ? (action.asking ? `Potvrdit: ${view.confirmText}` : view.label) : `Zrušit čekající teď nejde: ${view.reason ?? ''}`}
        disabled={action.busy}
        onClick={event => { playNativeHapticIfAvailable('medium'); action.click(event); }}
        style={{ height: 30, padding: '0 10px', borderRadius: 9, border: 0, cursor: 'pointer', font: '800 12px Inter, sans-serif', color: action.asking ? '#fff' : 'var(--dj-text)', background: action.asking ? '#d97706' : 'var(--dj-glass, rgba(13,18,27,.94))', boxShadow: '0 10px 24px -14px rgba(0,0,0,.75)', opacity: view.enabled && !action.busy ? 1 : 0.55 }}
      >{action.busy ? 'Ruším…' : action.asking ? 'Opravdu zrušit?' : view.label}</button>
      {action.asking && <span role="status" style={{ maxWidth: 260, padding: '4px 8px', borderRadius: 8, background: 'var(--dj-glass, rgba(13,18,27,.94))', color: 'var(--dj-text-2)', fontSize: 11, fontWeight: 600, textAlign: 'right' }}>{view.confirmText} Klepni znovu do 4 s.</span>}
    </div>
  );
}

function pendingTypeLabel(type: string | null): string {
  if (!type) return '';
  const lower = type.toLowerCase();
  return lower.startsWith('limit') ? 'LMT' : lower.startsWith('stop') ? 'STP' : type.toUpperCase();
}

/**
 * Předvyplněné nohy „Přidat SL/TP“ (U8): výchozí šablona uživatele (★) jako vzdálenost
 * od trhu; bez vlastní výchozí šablony dosavadních 10 / 20 b. Šablona bez TP = TP 20 b
 * (attach potřebuje obě nohy). Jen návrh do formuláře — odeslání tlačítkem.
 */
export function livePhoneAttachDefaults(
  side: 'long' | 'short',
  market: number,
  tickSize: number,
  template: LiveBracketTemplate | null,
): { stopLoss: number; takeProfit: number } {
  const custom = template && template.id !== LIVE_BUILTIN_TEMPLATE_ID
    ? liveTemplateBracketPrices(template, side === 'long' ? 'buy' : 'sell', market, tickSize)
    : null;
  return liveAttachDefaults(side, market, tickSize, custom
    ? { stopPoints: custom.stopTicks * tickSize, targetPoints: custom.targetTicks != null ? custom.targetTicks * tickSize : LIVE_ATTACH_DEFAULT_TARGET_POINTS }
    : null);
}

/**
 * Doplnění SL + TP k holému Marketu: ceny od trhu, odeslání tlačítkem. Kontrola jako worker
 * (`liveAttachProblem`): obě nohy na správné straně a aspoň 8 ticků od trhu.
 */
export function LivePhoneAttachSheet({ side, market, tickSize, userId = null, onSubmit, onClose }: {
  side: 'long' | 'short';
  market: number;
  tickSize: number;
  /** U8: klíč šablon — výchozí šablona předvyplní nohy; bez ní 10 / 20 b. */
  userId?: string | null;
  onSubmit: (stopLoss: number, takeProfit: number) => void;
  onClose: () => void;
}) {
  const [initial] = useState(() => livePhoneAttachDefaults(side, market, tickSize, defaultLiveBracketTemplate(readLiveBracketTemplates(userId).library)));
  const [stop, setStop] = useState(initial.stopLoss.toFixed(2));
  const [target, setTarget] = useState(initial.takeProfit.toFixed(2));
  const parse = (text: string) => { const value = Number.parseFloat(text.replace(/\s/g, '').replace(',', '.')); return Number.isFinite(value) ? snapToTick(value, tickSize) : null; };
  const sl = parse(stop);
  const tp = parse(target);
  const problem = sl == null || tp == null ? 'Vyplň SL i TP.' : liveAttachProblem(side, market, sl, tp, tickSize);
  const valid = problem == null;
  const field: React.CSSProperties = { width: '100%', height: 44, borderRadius: 10, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', color: 'var(--dj-text)', font: '700 18px ui-monospace, monospace', textAlign: 'center' };
  const distance = (value: number | null) => (value == null ? '' : `${Math.round(Math.abs(value - market) / tickSize)} t od trhu`);
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 46 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />
      <section aria-label="Přidat SL a TP" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: '20px 20px 0 0', background: 'var(--dj-sheet, var(--dj-card))', borderTop: '1px solid var(--dj-line)', padding: '8px 16px calc(16px + var(--dj-safe-bottom, env(safe-area-inset-bottom, 0px)))' }}>
        <SheetGrip onClose={onClose} gap={6} />
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <p style={{ margin: 0, flex: 1, fontSize: 16, fontWeight: 800 }}>Přidat SL a TP · trh {market.toFixed(2)}</p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 800, color: SELL, marginBottom: 4 }}><span>STOP LOSS</span><span className="dj-mono" style={{ color: 'var(--dj-muted)', fontWeight: 600 }}>{distance(sl)}</span></label>
        <input aria-label="Stop loss" inputMode="decimal" value={stop} onChange={event => setStop(event.target.value)} style={field} />
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 800, color: '#34d399', margin: '10px 0 4px' }}><span>TAKE PROFIT</span><span className="dj-mono" style={{ color: 'var(--dj-muted)', fontWeight: 600 }}>{distance(tp)}</span></label>
        <input aria-label="Take profit" inputMode="decimal" value={target} onChange={event => setTarget(event.target.value)} style={field} />
        {problem && <p role="status" style={{ margin: '8px 2px 0', fontSize: 12, fontWeight: 600, color: '#ff8c95' }}>{problem}</p>}
        <button type="button" className="dj-btn" disabled={!valid} onClick={() => { if (valid) onSubmit(sl!, tp!); }} style={{ width: '100%', height: 46, marginTop: 12, borderRadius: 12, border: 0, cursor: valid ? 'pointer' : 'not-allowed', opacity: valid ? 1 : 0.5, color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', font: '800 15px Inter, sans-serif' }}>Odeslat SL + TP</button>
      </section>
    </div>
  );
}
