import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { createCopierState, planReplication } from '../services/copierEngine';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createFileCopyGroupStore } from '../services/fileCopyGroupStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

const symbol = 'MNQU6';
const group = (): CopyGroupConfig => ({
  id: 'participation', name: 'Participation', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-fill', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
});
const leaderOrder = (id: string): BrokerOrder => ({
  tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 30_000,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1,
});

async function harness(config = group()) {
  const broker = createMockBroker({ behavior: request => request.tag.startsWith('fl')
    ? { kind: 'fill', price: 30_000 } : { kind: 'working' } });
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group: config,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  let persisted = structuredClone(config);
  const persist = async (next: CopyGroupConfig) => { persisted = structuredClone(next); };
  return { broker, controller, persist, persisted: () => persisted };
}

describe('manual follower participation', () => {
  it('vypne flat followera bez DISARM, další entry dostane jen druhý follower a ARM projde', async () => {
    const h = await harness();
    h.controller.arm();
    const result = await h.controller.setFollowerEnabled(200, false, h.persist);
    expect(result.followers[0]).toMatchObject({ mode: 'on-fill', enabled: false });
    expect(h.controller.status()).toMatchObject({ armed: true, divergentAccounts: [] });
    expect(h.controller.status().followerParticipation).toEqual([
      expect.objectContaining({ accountId: 200, configuredEnabled: false, effectiveEnabled: false }),
      expect.objectContaining({ accountId: 300, effectiveEnabled: true }),
    ]);
    h.controller.disarm();
    await h.controller.reconcile();
    expect(() => h.controller.arm()).not.toThrow();
    h.broker.emitEvent({ type: 'order', order: leaderOrder('next-entry') });
    await h.controller.waitForIdle();
    expect(h.broker.placedRequests().map(request => request.accountId)).toEqual([300]);
    expect(h.controller.status()).toMatchObject({ armed: true, divergentAccounts: [] });
    h.controller.stop();
  });

  it('odmítne změnu při leader pozici a nechá mód i ARM beze změny', async () => {
    const h = await harness();
    h.controller.arm();
    h.broker.setPosition(100, symbol, 1);
    await expect(h.controller.setFollowerEnabled(200, false, h.persist)).rejects.toThrow('100 má otevřenou pozici');
    expect(h.persisted().followers[0]).toMatchObject({ mode: 'on-fill' });
    expect(h.controller.status().armed).toBe(true);
    h.controller.stop();
  });

  it('odmítne i opětovné zapnutí při leader pozici', async () => {
    const h = await harness();
    await h.controller.setFollowerEnabled(200, false, h.persist);
    h.controller.arm();
    h.broker.setPosition(100, symbol, 1);
    await expect(h.controller.setFollowerEnabled(200, true, h.persist)).rejects.toThrow('100 má otevřenou pozici');
    expect(h.persisted().followers[0]).toMatchObject({ mode: 'on-fill', enabled: false });
    expect(h.controller.status().armed).toBe(true);
    h.controller.stop();
  });

  it.each([100, 200])('odmítne working/pending limit účtu %i', async accountId => {
    const h = await harness();
    h.controller.arm();
    const original = h.broker.listOrders.bind(h.broker);
    h.broker.listOrders = async id => id === accountId
      ? [{ ...leaderOrder(`working-${id}`), accountId: id,
        status: id === 100 ? 'working' as const : 'pending' as const }]
      : original(id);
    await expect(h.controller.setFollowerEnabled(200, false, h.persist)).rejects.toThrow('čekající nebo pracovní příkaz');
    expect(h.controller.status().armed).toBe(true);
    h.controller.stop();
  });

  it('nepřepne při working orderu známém ze streamu, i když REST snapshot zaostává', async () => {
    const h = await harness();
    h.controller.arm();
    h.broker.emitEvent({ type: 'order', order: leaderOrder('stream-ahead-of-rest') });
    await h.controller.waitForIdle();
    await expect(h.controller.setFollowerEnabled(200, false, h.persist))
      .rejects.toThrow('živého streamu čekající příkaz');
    expect(h.persisted().followers[0].enabled).not.toBe(false);
    h.controller.stop();
  });

  it('souběžný leader submit nepřepne followera napůl', async () => {
    const h = await harness({
      ...group(), followers: group().followers.map(follower => ({ ...follower, mode: 'on-submit' })),
    });
    h.controller.arm();
    const original = h.broker.listPositions.bind(h.broker);
    let injected = false;
    h.broker.listPositions = async id => {
      if (!injected) {
        injected = true;
        h.broker.emitEvent({ type: 'order', order: leaderOrder('racing-entry') });
      }
      return original(id);
    };
    await expect(h.controller.setFollowerEnabled(200, false, h.persist)).rejects.toThrow('Stav se během ověření změnil');
    await h.controller.waitForIdle();
    expect(h.persisted().followers[0].enabled).not.toBe(false);
    expect(h.broker.placedRequests().map(request => request.accountId).sort()).toEqual([200, 300]);
    expect(h.controller.status().armed).toBe(true);
    h.controller.stop();
  });

  it('leader submit během durable zápisu vrátí starou účast před dispatchí', async () => {
    const h = await harness({
      ...group(), followers: group().followers.map(follower => ({ ...follower, mode: 'on-submit' })),
    });
    h.controller.arm();
    let first = true;
    await expect(h.controller.setFollowerEnabled(200, false, async next => {
      await h.persist(next);
      if (first) {
        first = false;
        h.broker.emitEvent({ type: 'order', order: leaderOrder('during-save') });
      }
    })).rejects.toThrow('Stav se během ověření změnil');
    await h.controller.waitForIdle();
    expect(h.persisted().followers[0].enabled).not.toBe(false);
    expect(h.broker.placedRequests().map(request => request.accountId).sort()).toEqual([200, 300]);
    expect(h.controller.status().armed).toBe(true);
    h.controller.stop();
  });

  it('zapnutí zachová on-fill a kopie začne až u následujícího vstupu', async () => {
    const h = await harness();
    await h.controller.setFollowerEnabled(200, false, h.persist);
    h.controller.arm();
    await h.controller.setFollowerEnabled(200, true, h.persist);
    expect(h.persisted().followers[0]).toMatchObject({ mode: 'on-fill', enabled: true });
    expect(h.broker.placedRequests()).toHaveLength(0);
    const nextTrade = planReplication({
      id: 'next-fill', orderId: 'next-order', kind: 'filled', accountId: 100,
      symbol, side: 'Buy', orderType: 'Market', quantity: 1,
      cumulativeQuantity: 1, sequence: 1, receivedAt: 1,
    }, h.persisted(), createCopierState());
    expect(nextTrade.orders.map(order => order.request.accountId)).toContain(200);
    expect(h.controller.status().armed).toBe(true);
    h.controller.stop();
  });

  it('uloží vypnutí do group.json a restart ho načte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'follower-participation-'));
    const durable = createFileCopyGroupStore(join(root, 'group.json'));
    await durable.save(group());
    const h = await harness();
    await h.controller.setFollowerEnabled(200, false, next => durable.save(next));
    h.controller.stop();
    const restored = await durable.load();
    expect(restored?.followers[0]).toMatchObject({ mode: 'on-fill', enabled: false });
    const restarted = await harness(restored!);
    expect(restarted.controller.status().followerParticipation?.[0]).toMatchObject({
      configuredEnabled: false, effectiveEnabled: false,
    });
    restarted.controller.stop();
  });

  it('automatické vyřazení ruční zapnutí neobchází a vrátí důvod ve statusu', async () => {
    const h = await harness();
    await h.controller.setFollowerEnabled(200, false, h.persist);
    await h.controller.applyAccountEligibilityExclusions([{
      accountId: 200, state: 'breached', reason: 'broker breach',
    }]);
    await expect(h.controller.setFollowerEnabled(200, true, h.persist)).rejects.toThrow('breached');
    expect(h.persisted().followers[0].enabled).toBe(false);
    expect(h.controller.status().followerParticipation?.[0]).toMatchObject({
      configuredEnabled: false, effectiveEnabled: false, canToggle: false,
      automaticExclusion: expect.stringContaining('breached'),
    });
    h.controller.stop();
  });

  it('durable daily-loss cut nelze ručním zapnutím smazat', async () => {
    const now = Date.now();
    const initial = emptySnapshot();
    initial.safety = {
      ...initial.safety!,
      followerCuts: { 200: {
        accountId: 200, at: now, until: now + 60_000,
        realizedPnlUsd: -125, cutUsd: 100, source: 'broker', closed: now,
      } },
    };
    const broker = createMockBroker();
    const config = group();
    config.followers[0].enabled = false;
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(initial), group: config,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    await expect(controller.setFollowerEnabled(200, true, async () => undefined))
      .rejects.toThrow('follower-cut:broker');
    expect(controller.status().followerParticipation?.[0]).toMatchObject({
      configuredEnabled: false, effectiveEnabled: false,
      automaticExclusion: 'follower-cut:broker',
    });
    controller.stop();
  });

  it('selhání trvalého zápisu nepublikuje nový stav a neodzbrojí', async () => {
    const h = await harness();
    h.controller.arm();
    let calls = 0;
    await expect(h.controller.setFollowerEnabled(200, false, async next => {
      calls += 1;
      if (calls === 1) throw new Error('disk write failed');
      await h.persist(next);
    })).rejects.toThrow('disk write failed');
    expect(h.controller.status().armed).toBe(true);
    expect(h.controller.status().followerParticipation?.[0].configuredEnabled).toBe(true);
    expect(h.persisted().followers[0].enabled).not.toBe(false);
    h.controller.stop();
  });

  it('nejistý zápis i rollback failne zavřeně místo neprokazatelného ARM', async () => {
    const h = await harness();
    h.controller.arm();
    await expect(h.controller.setFollowerEnabled(200, false, async () => {
      throw new Error('disk unavailable');
    })).rejects.toThrow('disk unavailable');
    await h.controller.waitForIdle();
    expect(h.controller.status().armed).toBe(false);
    h.controller.stop();
  });

  it('OSO kopíruje jen na zapnutého followera včetně obou ochranných noh', async () => {
    const h = await harness({
      ...group(), followers: group().followers.map(follower => ({ ...follower, mode: 'on-submit' })),
    });
    await h.controller.setFollowerEnabled(200, false, h.persist);
    h.controller.arm();
    h.broker.emitEvent({ type: 'order', order: leaderOrder('oso-entry') });
    h.broker.emitEvent({ type: 'order', order: {
      ...leaderOrder('oso-stop'), parentOrderId: 'oso-entry', side: 'Sell',
      orderType: 'Stop', limitPrice: undefined, stopPrice: 29_950,
    } });
    h.broker.emitEvent({ type: 'order', order: {
      ...leaderOrder('oso-target'), parentOrderId: 'oso-entry', side: 'Sell',
      limitPrice: 30_100,
    } });
    await h.controller.waitForIdle();
    expect(h.broker.placedOsoRequests()).toEqual([expect.objectContaining({
      accountId: 300,
      first: expect.objectContaining({ stopPrice: 29_950 }),
      second: expect.objectContaining({ limitPrice: 30_100 }),
    })]);
    expect(h.controller.status()).toMatchObject({ armed: true, divergentAccounts: [] });
    h.controller.stop();
  });

  it('reconciliation čeká u vypnutého followera nulu i když leader obchoduje', async () => {
    const h = await harness();
    await h.controller.setFollowerEnabled(200, false, h.persist);
    h.broker.setPosition(100, symbol, 2);
    h.broker.setPosition(300, symbol, 2);
    expect(await h.controller.reconcile()).toMatchObject({
      divergentAccounts: [], authoritativelyClean: true,
    });
    expect(h.controller.status().exposure?.followers).toContainEqual(expect.objectContaining({
      accountId: 200, ok: true,
    }));
    h.controller.stop();
  });

  it('nenulovou pozici či working order vypnutého followera ukáže jako safety problém', async () => {
    const h = await harness();
    await h.controller.setFollowerEnabled(200, false, h.persist);
    h.broker.setPosition(200, symbol, 1);
    expect(await h.controller.reconcile()).toMatchObject({ divergentAccounts: [200] });
    expect(h.controller.status().exposure?.followers).toContainEqual(expect.objectContaining({
      accountId: 200, ok: false,
    }));
    h.broker.setPosition(200, symbol, 0);
    await h.broker.placeOrder({
      tag: 'external-working', accountId: 200, symbol, side: 'Buy',
      orderType: 'Limit', quantity: 1, limitPrice: 29_000,
    });
    await h.controller.waitForIdle();
    expect(await h.controller.reconcile()).toMatchObject({ workingOrderAccounts: [200] });
    h.controller.stop();
  });

  it('Flatten zůstane dostupný i na vypnutém followerovi', async () => {
    const h = await harness();
    await h.controller.setFollowerEnabled(200, false, h.persist);
    h.broker.setPosition(200, symbol, 1);
    const result = await h.controller.flattenAccount(200, 'disabled-flat-001');
    expect(result).toMatchObject({ accountIds: [200], flat: true });
    expect(await h.broker.listPositions(200)).toEqual([expect.objectContaining({ netQuantity: 0 })]);
    h.controller.stop();
  });
});
