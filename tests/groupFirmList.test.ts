import { describe, expect, it } from 'vitest';
import { groupFirmList } from '../components/LiveCopyTradeOverview';

describe('groupFirmList', () => {
  it('vrací všechny firmy skupiny, ne jen leaderovu', () => {
    expect(groupFirmList([
      { firm: 'Lucid', isLeader: true },
      { firm: 'Tradeify' },
      { firm: 'FundedNext' },
    ])).toEqual(['Lucid', 'Tradeify', 'FundedNext']);
  });

  it('leaderova firma je vždy první i když leader není první v pořadí', () => {
    expect(groupFirmList([
      { firm: 'Tradeify' },
      { firm: 'Lucid', isLeader: true },
    ])).toEqual(['Lucid', 'Tradeify']);
  });

  it('opakovanou firmu nepočítá dvakrát', () => {
    expect(groupFirmList([
      { firm: 'Lucid', isLeader: true },
      { firm: 'Lucid' },
      { firm: 'Lucid' },
    ])).toEqual(['Lucid']);
  });

  it('účty bez firmy přeskočí', () => {
    expect(groupFirmList([
      { firm: 'Lucid', isLeader: true },
      { firm: null },
      { firm: '   ' },
      { firm: undefined },
    ])).toEqual(['Lucid']);
  });

  it('zvládne skupinu bez jediné známé firmy', () => {
    expect(groupFirmList([{ firm: null }, {}])).toEqual([]);
  });

  it('nemění pořadí u víc než tří firem', () => {
    const firms = groupFirmList([
      { firm: 'Lucid', isLeader: true },
      { firm: 'Tradeify' }, { firm: 'FundedNext' }, { firm: 'Apex' }, { firm: 'TopStep' },
    ]);
    expect(firms).toHaveLength(5);
    expect(firms[0]).toBe('Lucid');
  });
});
