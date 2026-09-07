import { describe, it, expect } from 'vitest';
import { copierArmNotification, copierSnapshotArmWarning } from '../server/copierArmNotification';
import { snapshotArmOffer } from '../services/copierSnapshotArmOffer';
import type { CopierSnapshotHealth } from '../lib/localCopierAgentProtocol';

const health = (patch: Partial<CopierSnapshotHealth>): CopierSnapshotHealth => ({
  enabled: true, repairSupported: true, state: 'ready', layoutName: 'AlphaTrade Snapshoty',
  chartIdConfigured: true, cdpReachable: true, targetFound: true,
  lastCheckedAt: 1, lastAttemptAt: null, lastSuccessAt: null, ...patch,
});

describe('copierSnapshotArmWarning', () => {
  it('mlčí, když jsou snímky vypnuté, připravené, v kontrole nebo stav chybí', () => {
    expect(copierSnapshotArmWarning(undefined)).toBeNull();
    expect(copierSnapshotArmWarning({ enabled: false, state: 'cdp-offline' })).toBeNull();
    expect(copierSnapshotArmWarning(health({ state: 'ready' }))).toBeNull();
    expect(copierSnapshotArmWarning(health({ state: 'checking' }))).toBeNull();
    expect(copierSnapshotArmWarning('cdp-offline')).toBeNull();
  });

  it('pojmenuje CDP offline, chybějící layout i selhaný snímek', () => {
    expect(copierSnapshotArmWarning(health({ state: 'cdp-offline' }))).toContain('bez CDP');
    expect(copierSnapshotArmWarning(health({ state: 'layout-missing', layoutName: 'Moje snímky' }))).toContain('„Moje snímky“');
    expect(copierSnapshotArmWarning(health({ state: 'capture-failed' }))).toContain('selhal');
    expect(copierSnapshotArmWarning(health({ state: 'upload-failed' }))).toContain('selhal');
  });
});

describe('copierArmNotification', () => {
  it('bez varování zůstává původní text ARM', () => {
    expect(copierArmNotification('arm-started')).toEqual({
      title: 'Copier: ARM aktivní',
      body: 'Ostrý ARM je aktivní. Kopírování je povolené do expirace session nebo ručního DISARM.',
    });
    expect(copierArmNotification('arm-started', health({ state: 'ready' })).title).toBe('Copier: ARM aktivní');
  });

  it('ARM bez snímků má vlastní titulek a varování v těle', () => {
    const notification = copierArmNotification('arm-started', health({ state: 'cdp-offline' }));
    expect(notification.title).toBe('Copier: ARM aktivní bez snímků');
    expect(notification.body).toMatch(/^Ostrý ARM je aktivní\. Pozor: TradingView běží bez CDP/);
  });

  it('konec ARM varování nikdy nenese', () => {
    expect(copierArmNotification('arm-ended', health({ state: 'cdp-offline' }))).toEqual({
      title: 'Copier: ARM skončil',
      body: 'Ostrý ARM už neplatí. Kopírování stojí.',
    });
  });
});

describe('snapshotArmOffer', () => {
  it('ARM nezdržuje, když jsou snímky vypnuté, připravené nebo v kontrole', () => {
    expect(snapshotArmOffer(null)).toBeNull();
    expect(snapshotArmOffer(health({ enabled: false, state: 'disabled' }))).toBeNull();
    expect(snapshotArmOffer(health({ state: 'ready' }))).toBeNull();
    expect(snapshotArmOffer(health({ state: 'checking' }))).toBeNull();
  });

  it('CDP offline nabízí opravu jen u workeru, který restart umí', () => {
    expect(snapshotArmOffer(health({ state: 'cdp-offline' }))).toEqual({
      reason: expect.stringContaining('bez CDP'), repairable: true,
    });
    expect(snapshotArmOffer(health({ state: 'cdp-offline', repairSupported: false }))?.repairable).toBe(false);
  });

  it('chybějící layout a selhaný snímek restart nenabízí', () => {
    expect(snapshotArmOffer(health({ state: 'layout-missing' }))).toEqual({
      reason: 'V TradingView není otevřený layout „AlphaTrade Snapshoty“.', repairable: false,
    });
    expect(snapshotArmOffer(health({ state: 'layout-missing', chartIdConfigured: false }))?.reason).toContain('spárovaný');
    expect(snapshotArmOffer(health({ state: 'capture-failed' }))?.repairable).toBe(false);
    expect(snapshotArmOffer(health({ state: 'upload-failed' }))?.reason).toContain('nahrání');
  });
});
