import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildLiveStatusStrip } from '../services/liveStatusStrip';
import LiveStatusStrip from '../components/LiveStatusStrip';
import CopierEventsPanel from '../components/CopierEventsPanel';
import { createCopierDisarmRecord } from '../lib/copierDisarmReason';
import type { CopierControllerStatus } from '../services/copierRuntimeController';
import type { CopierSnapshotHealth } from '../lib/localCopierAgentProtocol';

const now = Date.UTC(2026, 8, 8, 12, 0, 0);
const status = (patch: Partial<CopierControllerStatus> = {}): CopierControllerStatus => ({
  armed: false, killSwitch: false, shadowMode: false, connected: true,
  reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [],
  lastError: null, ...patch,
} as CopierControllerStatus);
const health = (patch: Partial<CopierSnapshotHealth> = {}): CopierSnapshotHealth => ({
  enabled: true, repairSupported: true, state: 'ready', layoutName: 'AlphaTrade Snapshoty',
  chartIdConfigured: true, cdpReachable: true, targetFound: true,
  lastCheckedAt: now, lastAttemptAt: null, lastSuccessAt: null, ...patch,
});
const manualDisarm = createCopierDisarmRecord({ at: now - 60_000, trigger: 'manual', detail: 'Uživatel vypnul kopírku ručně', copiesOutcome: 'flat' });
const failClosed = createCopierDisarmRecord({
  at: now - 30_000, trigger: 'fail-closed',
  detail: 'Copier fail-closed: follower 200 má autoritativně pozici -2', copiesOutcome: 'unknown',
});

describe('buildLiveStatusStrip', () => {
  it('zdravý stav jsou čtyři tiché chipy bez věty a bez tlačítka', () => {
    const model = buildLiveStatusStrip({ status: status({ lastDisarm: manualDisarm }), available: true, pending: false, transport: 'local', snapshotHealth: health(), now });
    expect(model.chips.map(chip => [chip.id, chip.value, chip.tone])).toEqual([
      ['worker', 'Tento Mac', 'muted'],
      ['broker', 'Připojený', 'muted'],
      ['copier', 'Vypnutá', 'muted'],
      ['snapshots', 'Připravené', 'muted'],
    ]);
    expect(model.repairSnapshots).toBe(false);
    expect(model.notice).toBeNull();
  });

  it('zastaralý lastError se v liště neukazuje, když je stream připojený', () => {
    const model = buildLiveStatusStrip({ status: status({ lastError: 'Tradovate WebSocket transport error' }), available: true, pending: false, transport: 'local', now });
    expect(model.chips.every(chip => chip.tone === 'muted')).toBe(true);
    expect(model.notice).toBeNull();
  });

  it('CDP offline zbarví jen chip snímků a nabídne obnovu u workeru, který ji umí', () => {
    const offline = buildLiveStatusStrip({ status: status(), available: true, pending: false, transport: 'local', snapshotHealth: health({ state: 'cdp-offline' }), now });
    expect(offline.chips.find(chip => chip.id === 'snapshots')).toMatchObject({ value: 'TradingView bez CDP', tone: 'warn' });
    expect(offline.repairSnapshots).toBe(true);
    const old = buildLiveStatusStrip({ status: status(), available: true, pending: false, transport: 'local', snapshotHealth: health({ state: 'cdp-offline', repairSupported: false }), now });
    expect(old.repairSnapshots).toBe(false);
  });

  it('vypnuté snímky chip nemají; odpojený broker a neověřený worker varují', () => {
    const model = buildLiveStatusStrip({ status: status({ connected: false }), available: true, pending: false, transport: 'relay', snapshotHealth: health({ enabled: false, state: 'disabled' }), now });
    expect(model.chips.map(chip => chip.id)).toEqual(['worker', 'broker', 'copier']);
    expect(model.chips.find(chip => chip.id === 'broker')).toMatchObject({ value: 'Odpojený', tone: 'warn' });
    const missing = buildLiveStatusStrip({ status: null, available: false, pending: false, transport: null, now });
    expect(missing.chips.find(chip => chip.id === 'worker')).toMatchObject({ value: 'Neověřeno', tone: 'warn' });
    const reconciling = buildLiveStatusStrip({ status: status({ reconciliationRequired: true }), available: true, pending: false, transport: 'local', now });
    expect(reconciling.chips.find(chip => chip.id === 'worker')).toMatchObject({ value: 'Čeká na ověření účtů', tone: 'warn' });
  });

  it('automatické vypnutí s nepotvrzeným výsledkem je jediný důvod pro větu pod chipy', () => {
    const model = buildLiveStatusStrip({ status: status({ lastDisarm: failClosed }), available: true, pending: false, transport: 'local', now });
    expect(model.chips.find(chip => chip.id === 'copier')).toMatchObject({ value: 'Vypnuta automaticky', tone: 'warn' });
    expect(model.notice).toContain('Kopírka se vypnula automaticky');
    const armed = buildLiveStatusStrip({ status: status({ armed: true, lastDisarm: failClosed }), available: true, pending: false, transport: 'local', now });
    expect(armed.chips.find(chip => chip.id === 'copier')).toMatchObject({ value: 'Zapnutá', tone: 'ok' });
    expect(armed.notice).toBeNull();
  });
});

describe('LiveStatusStrip + CopierEventsPanel render', () => {
  it('lišta vykreslí chipy, tlačítko jen při CDP offline', () => {
    const quiet = renderToStaticMarkup(React.createElement(LiveStatusStrip, { status: status(), available: true, pending: false, transport: 'local', snapshotHealth: health(), onRepairSnapshots: () => undefined }));
    expect(quiet).toContain('data-chip="snapshots"');
    expect(quiet).not.toContain('Obnovit TradingView');
    const broken = renderToStaticMarkup(React.createElement(LiveStatusStrip, { status: status(), available: true, pending: false, transport: 'local', snapshotHealth: health({ state: 'cdp-offline' }), onRepairSnapshots: () => undefined }));
    expect(broken).toContain('Obnovit TradingView');
  });

  it('Události nesou lastError, časy snímků i historii včetně technického detailu', () => {
    const markup = renderToStaticMarkup(React.createElement(CopierEventsPanel, {
      status: status({ lastError: 'Tradovate WebSocket transport error [conn:1]' }),
      transport: 'local',
      snapshotHealth: health({ lastSuccessAt: now - 3_600_000 }),
      disarmHistory: [manualDisarm, failClosed],
    }));
    expect(markup).toContain('Tradovate WebSocket transport error [conn:1]');
    expect(markup).toContain('Historie odzbrojení (2)');
    expect(markup).toContain('Copier fail-closed: follower 200');
    expect(markup).toContain('Uživatel vypnul kopírku ručně'.slice(0, 0) + 'Kopírka byla vypnuta ručně');
    expect(markup).toContain('je připravený pro ENTRY/EXIT');
  });
});
