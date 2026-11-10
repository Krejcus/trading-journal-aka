// Callbacky desku pod neověřenou projekcí: zavřít / utáhnout SL / doplnit ochranu se
// smí odeslat, roztažení SL, přikoupení, nový vstup a odebrání SL ne. Desk volá tutéž
// bránu; test hlídá i to, že ji každý callback opravdu použije.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  liveChartBareProjectionAction, liveChartManageProjectionAction, liveChartProjectionActionBlock,
} from '../lib/liveChartExposureProjection';
import { isLiveChartNotSent, liveChartNotSent } from '../lib/liveChartNotSent';

const root = join(__dirname, '..');
type Position = Parameters<typeof liveChartProjectionActionBlock>[0];
const unverified: Position = { summary: { unverified: true, side: 'long', stop: 21_000 } };
const verified: Position = { summary: { side: 'long', stop: 21_000 } };

const decision = (position: Position, action: Parameters<typeof liveChartProjectionActionBlock>[1]) => {
  const blocked = liveChartProjectionActionBlock(position, action);
  return blocked ? { sent: false as const, error: liveChartNotSent(blocked) } : { sent: true as const };
};

describe('deskové callbacky při neověřené projekci', () => {
  it('manage: zavření a utažení SL odejdou, roztažení a posun TP ne', () => {
    expect(decision(unverified, liveChartManageProjectionAction('close-position')).sent).toBe(true);
    expect(decision(unverified, liveChartManageProjectionAction('cancel-entry')).sent).toBe(true);
    expect(decision(unverified, liveChartManageProjectionAction('move-stop', 21_002)).sent).toBe(true);
    const widen = decision(unverified, liveChartManageProjectionAction('move-stop', 20_990));
    expect(widen.sent).toBe(false);
    if (!widen.sent) expect(isLiveChartNotSent(widen.error)).toBe(true);
    expect(decision(unverified, liveChartManageProjectionAction('move-target', 21_040)).sent).toBe(false);
    expect(decision(unverified, liveChartManageProjectionAction('move-limit', 21_010)).sent).toBe(false);
    // Ověřená pozice touto branou neprojde do odmítnutí.
    expect(decision(verified, liveChartManageProjectionAction('move-stop', 20_990)).sent).toBe(true);
  });

  it('close, attach a přidání SL odejdou; odebrání SL a přikoupení / nový vstup ne', () => {
    expect(decision(unverified, { action: 'close-position' }).sent).toBe(true);
    expect(decision(unverified, { action: 'attach-brackets' }).sent).toBe(true);
    expect(decision(unverified, liveChartBareProjectionAction({ kind: 'add', leg: 'stopLoss', price: 20_980 })).sent).toBe(true);
    expect(decision(unverified, liveChartBareProjectionAction({ kind: 'add', leg: 'takeProfit', price: 21_040 })).sent).toBe(true);
    expect(decision(unverified, liveChartBareProjectionAction({ kind: 'move', leg: 'stopLoss', price: 21_004 })).sent).toBe(true);
    expect(decision(unverified, liveChartBareProjectionAction({ kind: 'move', leg: 'stopLoss', price: 20_980 })).sent).toBe(false);
    expect(decision(unverified, liveChartBareProjectionAction({ kind: 'remove', leg: 'stopLoss' })).sent).toBe(false);
    expect(decision(unverified, liveChartBareProjectionAction({ kind: 'remove', leg: 'takeProfit' })).sent).toBe(true);
    expect(decision(unverified, { action: 'scale-in' }).sent).toBe(false);
    expect(decision(unverified, { action: 'entry' }).sent).toBe(false);
  });

  it('desk váže manage, close, attach, holou nohu a vstup na tutéž bránu', () => {
    const desk = readFileSync(join(root, 'components/TradovateLiveDesk.tsx'), 'utf8');
    expect(desk).toMatch(/liveChartProjectionActionBlock\(chartPositionRef\.current, liveChartManageProjectionAction\(action, newPrice\)\)/);
    expect(desk).toMatch(/liveChartProjectionActionBlock\(chartPositionRef\.current, \{ action: 'attach-brackets' \}\)/);
    expect(desk).toMatch(/liveChartProjectionActionBlock\(chartPositionRef\.current, \{ action: 'close-position' \}\)/);
    expect(desk).toMatch(/liveChartProjectionActionBlock\(chartPositionRef\.current, liveChartBareProjectionAction\(intent\)\)/);
    expect(desk).toMatch(/liveChartProjectionActionBlock\(chartPositionRef\.current, \{ action: draft\.position \? 'scale-in' : 'entry' \}\)/);
    expect(desk).not.toMatch(/liveChartProjectionManageBlock/);
  });
});
