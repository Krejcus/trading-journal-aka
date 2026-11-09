import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';
import { createLiveDeskCommands } from '../lib/liveDeskCommands';
import { validateLeaderOrderManage } from '../lib/leaderOrderManage';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { LeaderOrderManageCommand } from '../lib/leaderOrderManage';
import type { LeaderOrderManageResult } from '../lib/leaderOrderManage';

// Overlay (DOM, souřadnice grafu) nahradí zachytávač: test volá jeho callbacky jako tah/klepnutí.
const captured: { props: Record<string, any> | null } = { props: null };
vi.mock('../components/BacktestOrderLinesOverlay', () => ({
  default: (props: Record<string, any>) => { captured.props = props; return null; },
}));
const { LivePhoneOrderLines } = await import('../components/day/LivePhoneOrderLines');

const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'short', quantity: 1, entry: 28975.5, entryType: null, openPnl: 12, mark: 28960,
  stop: 28984.25, target: 28958, protection: 'SL 1/1 · TP 1/1', accounts: 1, scopeLabel: null,
  leader: { accountId: 1, quantity: 1, entry: 28975.5 }, rows: [], ...patch,
});
const ack = (): LeaderOrderManageResult => ({ type: 'leader-order-managed', operationId: 'manage:x', action: 'move-stop', status: 'acknowledged', checkedAt: 1, blockers: [] });

const render = (opts: { moveLimit?: boolean; groupLimitMove?: boolean; groupLimitStateHash?: string; summary?: LiveChartPositionSummary; manage?: ReturnType<typeof vi.fn> | null; canClose?: boolean; guardAt?: (at: number) => LiveChartPositionSummary | null; busy?: boolean }) => {
  captured.props = null;
  const notices: string[] = [];
  const state = { pendingMove: null, setPendingMove: vi.fn(), busyRef: { current: opts.busy === true } };
  renderToStaticMarkup(React.createElement(LivePhoneOrderLines, {
    api: {} as never, state, summary: opts.summary ?? summary(), manage: (opts.manage ?? null) as never,
    moveLimit: opts.moveLimit, groupLimitMove: opts.groupLimitMove, groupLimitStateHash: opts.groupLimitStateHash, canClose: opts.canClose ?? true, entryAvg: 28975.5, isDark: true, onNotice: text => notices.push(text),
    ...(opts.guardAt ? { guardAt: opts.guardAt } : {}),
  }));
  return { props: captured.props!, notices, state };
};
const lineOf = (props: Record<string, any>, kind: string) => props.lines.find((line: { kind: string }) => line.kind === kind);

beforeEach(() => { captured.props = null; });

describe('LIVE telefon: čáry obchodu a správa (napojení 2. 11.)', () => {
  it('overlay dostane selectToDrag (výběr klepnutím, pak tah) a × jedním klepnutím', () => {
    const { props } = render({ manage: vi.fn() });
    expect(props.selectToDrag).toBe(true);
    expect(props.lines.some((line: { confirmCancel?: boolean }) => line.confirmCancel === true)).toBe(false);
  });

  it('bez manage: žádné ×, BE ani tah — čáry jen zobrazují', () => {
    const { props } = render({ manage: null });
    expect(props.lines.some((line: { draggable?: boolean; cancellable?: boolean; actions?: unknown }) => line.draggable || line.cancellable || line.actions)).toBe(false);
  });

  it('canClose=false: u pozice žádné ×, posun SL/TP a BE dál jdou', () => {
    const { props } = render({ manage: vi.fn(), canClose: false });
    expect(lineOf(props, 'entry').cancellable).toBe(false);
    expect(lineOf(props, 'stopLoss').draggable).toBe(true);
    expect(lineOf(props, 'entry').actions?.[0]?.id).toBe('break-even');
  });

  it('tah se starou čárou (SL se mezitím změnil): nic se neodešle', async () => {
    const manage = vi.fn(async () => ack());
    const { props, notices } = render({ manage });
    props.onChange(lineOf(props, 'stopLoss'), 'stopLoss', 28990, { ...lineOf(props, 'stopLoss'), price: 28980 });
    await Promise.resolve();
    expect(manage).not.toHaveBeenCalled();
    expect(notices.join(' ')).toMatch(/během tažení změnil/);
  });

  it('platný tah SL dál od trhu: jedna změna u leadera s „co jsem viděl“', async () => {
    const manage = vi.fn(async () => ack());
    const { props } = render({ manage });
    props.onChange(lineOf(props, 'stopLoss'), 'stopLoss', 28990.1, lineOf(props, 'stopLoss'));
    await Promise.resolve();
    expect(manage).toHaveBeenCalledWith('move-stop', 28984.25, 28990);
  });

  it('druhý tah během letu prvního: odmítnut, nic se neodešle', async () => {
    const manage = vi.fn(async () => ack());
    const { props, notices } = render({ manage, busy: true });
    props.onChange(lineOf(props, 'takeProfit'), 'takeProfit', 28950, lineOf(props, 'takeProfit'));
    await Promise.resolve();
    expect(manage).not.toHaveBeenCalled();
    expect(notices.join(' ')).toMatch(/Čeká se na výsledek/);
  });

  it('× u pozice = zavřít obchod; × čekajícího vstupu = zrušit vstup', async () => {
    const manage = vi.fn(async () => ack());
    const open = render({ manage });
    open.props.onCancel(lineOf(open.props, 'entry'));
    await Promise.resolve();
    expect(manage).toHaveBeenLastCalledWith('close-position', 28984.25, undefined);
    const pending = render({ manage, summary: summary({ kind: 'pending', entryType: 'Limit', openPnl: null, mark: null }) });
    pending.props.onCancel(lineOf(pending.props, 'entry'));
    await Promise.resolve();
    expect(manage).toHaveBeenLastCalledWith('cancel-entry', 28975.5, undefined);
  });

  it.each(['protected', 'target-only', 'bare'] as const)('group %s × -> actual shared desk bridge -> validator sends leader entry price, never SL or aggregate qty', async mode => {
    const hash = 'groupclose12345678';
    const accounts = [2, 4].map((qty, index) => ({ accountId: index + 1, role: index === 0 ? 'leader' : 'follower', expectedQuantity: qty, openQuantity: qty,
      state: 'position', verifiedAt: 100, entry: { brokerOrderId: `entry-${index}`, quantity: qty, filledQuantity: qty, price: 28975.5, state: 'filled' },
      stop: mode === 'protected' ? { brokerOrderId: `sl-${index}`, quantity: qty, filledQuantity: 0, price: 28984.25, state: 'working' } : null,
      target: mode === 'bare' ? null : { brokerOrderId: `tp-${index}`, quantity: qty, filledQuantity: 0, price: 28958, state: 'working' } }));
    const status = { capabilities: ['manual-group-limit-manage-v1'], group: { id: 'group-phone', leaderAccountId: 1, followers: [{ accountId: 2, mode: 'on-submit', multiplier: 2 }] },
      controller: { groupLimitTrades: [{ groupId: 'group-phone', entryOperationId: 'entry:phoneclose001', symbol: 'MNQZ6', side: 'Sell', stateHash: hash, state: 'position', accounts }] } } as unknown as LocalCopierAgentStatus;
    const relay = vi.fn(async (_route: string, _command: LeaderOrderManageCommand) => ({ result: ack() }));
    const desk = createLiveDeskCommands({ status: () => ({ status, fresh: true }), relayId: () => 'relay-phone', relay,
      newOperationId: () => 'manage:phoneclose001' });
    const manage = vi.fn((action: string, _legacyStop: number, _newPrice?: number, seenHash?: string) => desk.manageGroupLimitPosition({
      entryOperationId: 'entry:phoneclose001', symbol: 'MNQZ6', action: action as 'close-position', groupLimitStateHash: seenHash! }));
    const rendered = render({ summary: summary({ quantity: 6, leader: { accountId: 1, quantity: 2, entry: 28975.5 }, accounts: 2, stop: mode === 'protected' ? 28984.25 : null, target: mode === 'bare' ? null : 28958 }),
      groupLimitStateHash: hash, manage });
    rendered.props.onCancel(lineOf(rendered.props, 'entry'));
    await Promise.resolve(); await Promise.resolve();
    expect(manage).toHaveBeenCalledWith('close-position', 28975.5, undefined, hash);
    const command = validateLeaderOrderManage(relay.mock.calls[0][1]);
    expect(command.expect).toEqual({ price: 28975.5, quantity: 2 }); expect(command.groupLimitStateHash).toBe(hash);
  });

  it('pojistky utažení/BE berou souhrn s kotací IBKR (guardAt), jako PC', async () => {
    const manage = vi.fn(async () => ack());
    // Bez ceny trhu z P&L brokera BE nejde; s čerstvou kotací IBKR 10 ticků v zisku ano.
    const noMark = summary({ mark: null, openPnl: null });
    const without = render({ manage, summary: noMark });
    without.props.onAction(lineOf(without.props, 'entry'), 'break-even');
    await Promise.resolve();
    expect(manage).not.toHaveBeenCalled();
    const guarded = render({ manage, summary: noMark, guardAt: () => ({ ...noMark, mark: 28973 }) });
    guarded.props.onAction(lineOf(guarded.props, 'entry'), 'break-even');
    await Promise.resolve();
    expect(manage).toHaveBeenCalledWith('move-stop', 28984.25, 28975.5);
  });
});

describe('dvoukrokové × nepotvrdí jinou akci (oponentura 2. 11.)', async () => {
  const { cancelConfirmKey } = await vi.importActual<typeof import('../components/BacktestOrderLinesOverlay')>('../components/BacktestOrderLinesOverlay');
  const { livePositionChartLines } = await import('../lib/liveChartOrderLines');
  it('čekající vstup → vyplněno mezi klepnutími: klíč potvrzení se změní (druhé klepnutí nezavře pozici)', () => {
    const controls = { manageable: true, canClose: true, entryAvg: 28975.5, pointValue: 2 };
    const pendingEntry = livePositionChartLines(summary({ kind: 'pending', entryType: 'Limit', openPnl: null, mark: null }), controls)[0];
    const positionEntry = livePositionChartLines(summary(), controls)[0];
    expect(pendingEntry.id).toBe(positionEntry.id);
    expect(cancelConfirmKey(pendingEntry)).not.toBe(cancelConfirmKey(positionEntry));
  });
});


describe('telefon: posun čekajícího limitu', () => {
  const pending = () => summary({ kind: 'pending', entryType: 'Limit' });
  it('po výběru čáry odešle move-limit původní cenou a stejným množstvím přes sdílenou správu', async () => {
    const manage = vi.fn().mockResolvedValue({ ...ack(), action: 'move-limit' });
    const { props, state } = render({ summary: pending(), moveLimit: true, manage });
    const line = lineOf(props, 'entry');
    expect(line.draggable).toBe(true);
    props.onChange(line, 'entry', 28976, line);
    await Promise.resolve();
    expect(manage).toHaveBeenCalledExactlyOnceWith('move-limit', 28975.5, 28976);
    expect(state.setPendingMove).toHaveBeenCalledWith({ kind: 'entry', price: 28976, until: Infinity });
  });
  it('skupinový Limit s více kontrakty použije stejný phone bridge; samotná solo capability jej nepovolí', async () => {
    const manage = vi.fn().mockResolvedValue({ ...ack(), action: 'move-limit' });
    const group = { ...pending(), quantity: 6, accounts: 2, leader: { accountId: 1, quantity: 2, entry: 28975.5 } };
    const solo = render({ summary: group, moveLimit: true, manage });
    expect(lineOf(solo.props, 'entry').draggable).toBe(false);
    solo.props.onChange(lineOf(solo.props, 'entry'), 'entry', 28976, lineOf(solo.props, 'entry'));
    expect(manage).not.toHaveBeenCalled();
    const ready = render({ summary: group, groupLimitMove: true, manage });
    const line = lineOf(ready.props, 'entry');
    expect(line.draggable).toBe(true);
    ready.props.onChange(line, 'entry', 28976, line);
    await Promise.resolve();
    expect(manage).toHaveBeenCalledExactlyOnceWith('move-limit', 28975.5, 28976);
  });
  it('stejná cena leadera nepřebázuje skupinu během tahu: změna follower hash po rerenderu nic neodešle', async () => {
    const manage = vi.fn().mockResolvedValue({ ...ack(), action: 'move-limit' });
    const first = render({ summary: pending(), groupLimitMove: true, groupLimitStateHash: 'hashfirst12345678', manage });
    const grabbed = lineOf(first.props, 'entry');
    const second = render({ summary: pending(), groupLimitMove: true, groupLimitStateHash: 'hashnext12345678', manage });
    second.props.onChange(lineOf(second.props, 'entry'), 'entry', 28976, grabbed);
    await Promise.resolve();
    expect(manage).not.toHaveBeenCalled();
    expect(second.notices.join(' ')).toMatch(/během tažení změnil/);
    const unchanged = render({ summary: pending(), groupLimitMove: true, groupLimitStateHash: 'hashfirst12345678', manage });
    unchanged.props.onChange(lineOf(unchanged.props, 'entry'), 'entry', 28976, grabbed);
    await Promise.resolve();
    expect(manage).toHaveBeenCalledExactlyOnceWith('move-limit', 28975.5, 28976, 'hashfirst12345678');
  });
  it.each([false, true])('starý worker nebo vyplněná pozice nedovolí posun vstupu (%s)', async position => {
    const manage = vi.fn();
    const { props } = render({ summary: position ? summary() : pending(), moveLimit: position, manage });
    const line = lineOf(props, 'entry');
    expect(line.draggable).toBe(false);
    props.onChange(line, 'entry', 28976, line);
    expect(manage).not.toHaveBeenCalled();
  });
  it('změna ceny během tahu ani druhý tah během odesílání neodešlou příkaz', () => {
    const manage = vi.fn();
    const { props } = render({ summary: pending(), moveLimit: true, manage });
    const line = lineOf(props, 'entry');
    props.onChange(line, 'entry', 28976, { ...line, price: 28974 });
    expect(manage).not.toHaveBeenCalled();
    const busy = render({ summary: pending(), moveLimit: true, manage, busy: true }).props;
    busy.onChange(lineOf(busy, 'entry'), 'entry', 28976, lineOf(busy, 'entry'));
    expect(manage).not.toHaveBeenCalled();
  });
});
