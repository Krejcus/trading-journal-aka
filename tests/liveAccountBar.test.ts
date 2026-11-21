import { describe, expect, it } from 'vitest';
import { liveBarAccountDay, liveBarGroupDay, liveBarGroupOf, liveBarOpenPnl, type LiveAccountBarData } from '../components/LiveAccountBar';

const data: LiveAccountBarData = {
  tradedAccountId: 'L',
  accounts: [
    { id: 'L', name: 'Leader', firm: 'X', realizedToday: -100 },
    { id: 'A', name: 'A', firm: 'X', realizedToday: 50 },
    { id: 'B', name: 'B', firm: 'X', realizedToday: -20 },
    { id: 'C', name: 'C', firm: 'X', realizedToday: 10 },
    { id: 'S', name: 'Solo', firm: 'Y', realizedToday: 5 },
  ],
  groups: [{ id: 'g', name: 'G', leaderId: 'L', state: 'ARMED', followers: [
    { accountId: 'A', ratio: 1, copying: true },
    { accountId: 'B', ratio: 0.5, copying: true },
    { accountId: 'C', ratio: 1, copying: false },
  ] }],
};

describe('LiveAccountBar P&L', () => {
  it('otevřený P&L má obchodovaný účet a kopírující followeři v poměru', () => {
    expect(liveBarOpenPnl(data, 'L', 40)).toBe(40);
    expect(liveBarOpenPnl(data, 'A', 40)).toBe(40);
    expect(liveBarOpenPnl(data, 'B', 40)).toBe(20);
    expect(liveBarOpenPnl(data, 'C', 40)).toBe(0); // vypnutý follower nekopíruje
    expect(liveBarOpenPnl(data, 'S', 40)).toBe(0); // mimo skupinu
  });

  it('bez pozice je otevřený P&L nula', () => {
    expect(liveBarOpenPnl(data, 'A', null)).toBe(0);
  });

  it('P&L dne účtu = realizovaný + otevřený', () => {
    expect(liveBarAccountDay(data, 'L', 40)).toBe(-60);
    expect(liveBarAccountDay(data, 'B', 40)).toBe(0);
  });

  it('P&L skupiny sčítá leadera i všechny followery', () => {
    // L -60, A 90, B 0, C 10
    expect(liveBarGroupDay(data, data.groups[0], 40)).toBe(40);
  });

  it('skupina, kterou obchodovaný účet nevede, nebo není ARMED, nedostává otevřený P&L', () => {
    const disarmed: LiveAccountBarData = { ...data, groups: [{ ...data.groups[0], state: 'DISARMED' }] };
    expect(liveBarOpenPnl(disarmed, 'A', 40)).toBe(0);
  });

  it('najde skupinu účtu jako leadera i followera', () => {
    expect(liveBarGroupOf(data, 'L')?.id).toBe('g');
    expect(liveBarGroupOf(data, 'C')?.id).toBe('g');
    expect(liveBarGroupOf(data, 'S')).toBeNull();
  });
});
