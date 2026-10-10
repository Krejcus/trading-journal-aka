// Bod 5b (10. 10. 2026): zapnutí blokované otevřenou pozicí → průvodce s účty.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { ArmPositionBlockDialog, buildArmPositionBlock } from '../components/LiveCopyTradeOverview';
import { copierArmRejection, isArmPositionRejection } from '../lib/copierArmPreparation';

const group: CopyGroupConfig = {
  id: 'g', name: 'Hlavní', enabled: true, leaderAccountId: 1,
  followers: [2, 3].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
};
const account = (id: number, net = 0): LiveAccount => ({
  id, positions: net === 0 ? [] : [{ accountId: id, symbol: 'MNQZ6', netPosition: net, netPrice: 1, realizedPnl: 0, unrealizedPnl: 0, updatedAt: '' }],
} as unknown as LiveAccount);
const order = (accountId: number, status = 'Working'): LiveOrder => ({ id: accountId * 10, accountId, status, working: true } as unknown as LiveOrder);
const names = (id: number) => `Účet ${id}`;

describe('bod 5b — průvodce zablokovaným zapnutím', () => {
  it('vypíše jen účty s pozicí nebo čekajícím příkazem', () => {
    const accounts = new Map([[1, account(1)], [2, account(2, -2)], [3, account(3)]]);
    const block = buildArmPositionBlock(group, accounts, [order(3)], names);
    expect(block).toEqual([
      { accountId: 2, name: 'Účet 2', isLeader: false, positions: ['MNQZ6 Short 2'], workingOrders: 0 },
      { accountId: 3, name: 'Účet 3', isLeader: false, positions: [], workingOrders: 1 },
    ]);
    expect(buildArmPositionBlock(group, new Map([[1, account(1)]]), [order(2, 'Filled')], names)).toEqual([]);
  });

  it('dialog nabízí zavření po účtech a „Nechat vypnuté“, ne zapnutí', () => {
    const markup = renderToStaticMarkup(React.createElement(ArmPositionBlockDialog, {
      groupName: 'Hlavní',
      accounts: [{ accountId: 2, name: 'Účet 2', isLeader: false, positions: ['MNQZ6 Short 2'], workingOrders: 1 }],
      busy: false, onClose: () => undefined, onCloseAccount: () => undefined, onArm: () => undefined,
    }));
    expect(markup).toContain('Zapnutí blokuje otevřená pozice');
    expect(markup).toContain('MNQZ6 Short 2 · 1 čekající příkaz');
    expect(markup).toContain('Zavřít pozici');
    expect(markup).toContain('Nechat vypnuté');
    expect(markup).toContain('Nic se nezapnulo.');
    expect(markup).not.toContain('>Zapnout<');
    expect(markup).not.toContain('Leader je v obchodě');
  });

  it('leader v obchodě dostane vysvětlení, jen příkazy mají vlastní titulek', () => {
    const leader = renderToStaticMarkup(React.createElement(ArmPositionBlockDialog, {
      groupName: 'Hlavní',
      accounts: [{ accountId: 1, name: 'Účet 1', isLeader: true, positions: ['MNQZ6 Long 1'], workingOrders: 0 }],
      busy: false, onClose: () => undefined, onCloseAccount: () => undefined,
    }));
    expect(leader).toContain('Leader je v obchodě');
    const ordersOnly = renderToStaticMarkup(React.createElement(ArmPositionBlockDialog, {
      groupName: 'Hlavní',
      accounts: [{ accountId: 3, name: 'Účet 3', isLeader: false, positions: [], workingOrders: 2 }],
      busy: false, onClose: () => undefined, onCloseAccount: () => undefined,
    }));
    expect(ordersOnly).toContain('Zapnutí blokuje čekající příkaz');
    expect(ordersOnly).toContain('2 čekající příkazy');
    expect(ordersOnly).toContain('Zrušit příkazy');
  });

  it('bez ověřených dat netvrdí flat a leader má vlastní popisek', () => {
    const unverified = renderToStaticMarkup(React.createElement(ArmPositionBlockDialog, {
      groupName: 'Hlavní', accounts: [], unverifiedNames: ['Účet 2'], busy: false,
      onClose: () => undefined, onCloseAccount: () => undefined, onArm: () => undefined,
    }));
    expect(unverified).toContain('Čekám na ověřená data účtů');
    expect(unverified).not.toContain('Skupina je flat');
    expect(unverified).toContain('>Zkusit zapnout<');
    const leader = renderToStaticMarkup(React.createElement(ArmPositionBlockDialog, {
      groupName: 'Hlavní', busy: false, onClose: () => undefined, onCloseAccount: () => undefined,
      accounts: [{ accountId: 1, name: 'Účet 1', isLeader: true, positions: ['MNQZ6 Long 1'], workingOrders: 0 }],
    }));
    expect(leader).toContain('Zavřít pozici leadera');
  });

  it('po flat nabídne Zapnout', () => {
    const markup = renderToStaticMarkup(React.createElement(ArmPositionBlockDialog, {
      groupName: 'Hlavní', accounts: [], busy: false,
      onClose: () => undefined, onCloseAccount: () => undefined, onArm: () => undefined,
    }));
    expect(markup).toContain('Skupina je flat');
    expect(markup).toContain('>Zapnout<');
  });

  it('technické odmítnutí workeru se přeloží do lidské věty', () => {
    for (const message of [
      'divergence=68356280; některý účet není flat',
      'working=68356277',
      'ARM odmítnut: účty nejsou flat/synchronní nebo mají pracovní příkazy',
      'Zapnutí zastaveno kontrolou u brokera: pozice nesedí s leaderem na účtech 68356280.',
    ]) {
      expect(isArmPositionRejection(new Error(message))).toBe(true);
      expect(copierArmRejection(new Error(message))).toContain('Nic se nezapnulo');
    }
    expect(isArmPositionRejection(new Error('ARM odmítnut: worker není připojen k brokeru'))).toBe(false);
    // Incident k potvrzení a nedostupné účty nesmí zakrýt věta o pozici.
    const ack = new Error('Zapnutí po incidentu vyžaduje tvoje potvrzení: Connection recovery není autoritativně čistá: divergence=123 [ack-incident:abc]');
    expect(isArmPositionRejection(ack)).toBe(false);
    expect(copierArmRejection(ack)).toContain('Dej znovu Zapnout a potvrď ho');
    const missing = new Error('Zapnutí zastaveno kontrolou u brokera: pozice nesedí s leaderem na účtech 1; nedostupné účty 2.');
    expect(isArmPositionRejection(missing)).toBe(false);
  });
});

describe('bod 5e — průběh zapínání', () => {
  it('říká, co se ověřuje, a neodškrtává smyšlené kroky', async () => {
    const { CopierArmProgressPanel } = await import('../components/LiveCopyTradeOverview');
    const markup = renderToStaticMarkup(React.createElement(CopierArmProgressPanel));
    expect(markup).toContain('data-testid="copier-arm-progress"');
    expect(markup).toContain('Zapínám · 0 s');
    expect(markup).toContain('pozice a čekající příkazy všech účtů a limity propfirem');
    expect(markup).toContain('nic se nezapne a dozvíš se proč');
  });
});
