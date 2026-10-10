// „Zapnout bez tohoto účtu“ (10. 10. 2026): follower s vlastní (cizí) pozicí
// jde za DISARM vyřadit i s ní; kopírka ji neřídí a zapojené účty zapne.
import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

const symbol = 'MNQZ6';
const group = (safety?: CopyGroupConfig['safety']): CopyGroupConfig => ({
  id: 'exclude', name: 'Exclude', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
  ...(safety ? { safety } : {}),
});
const leaderOrder = (id: string, x: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Buy',
  orderType: 'Limit', quantity: 1, filledQuantity: 0, limitPrice: 30_000,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...x,
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function harness(config = group()) {
  const audits: Array<{ kind: string; reason?: string; accountId?: number }> = [];
  const broker = createMockBroker({ behavior: request => request.orderType === 'Market'
    ? { kind: 'fill', price: 30_000 } : { kind: 'working' } });
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group: config,
    followerTransitionCorrelationWindowMs: 5,
    copierSettlementMinAgeMs: 0, copierSettlementQuietMs: 0, copierSettlementTerminalAgeMs: 0,
    leaderFlatGraceMs: 0, leaderFlatExitSettlementGraceMs: 0, leaderFlatInflightRetryMs: 10,
    onAudit: entries => { audits.push(...entries as never[]); },
  } as never);
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  let persisted = structuredClone(config);
  const persist = async (next: CopyGroupConfig) => { persisted = structuredClone(next); };
  const position = async (accountId: number, net: number) => {
    broker.setPosition(accountId, symbol, net);
    broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity: net } });
    await controller.waitForIdle();
    // Korelační okno přechodu followera doběhne (ruční obchod = incident).
    await sleep(25);
    await controller.waitForIdle();
  };
  const manual200 = (net: number) => position(200, net);
  return { broker, controller, persist, persisted: () => persisted, audits, manual200, position };
}

describe('Zapnout bez tohoto účtu — vyřazení followera s vlastní pozicí', () => {
  it('bez příznaku odmítne, s příznakem vyřadí bez jediného broker zápisu', async () => {
    const h = await harness();
    await h.manual200(2);
    await expect(h.controller.setFollowerEnabled(200, false, h.persist)).rejects.toThrow('200 má');
    const writesBefore = h.broker.placedRequests().length;
    const result = await h.controller.setFollowerEnabled(200, false, h.persist, { allowOwnExposure: true });
    expect(result.followers[0]).toMatchObject({ accountId: 200, enabled: false });
    expect(h.persisted().followers[0]).toMatchObject({ enabled: false });
    expect(h.broker.placedRequests()).toHaveLength(writesBefore);
    expect(await h.broker.listPositions(200)).toEqual([expect.objectContaining({ netQuantity: 2 })]);
    expect(h.audits.some(entry => entry.kind === 'follower-participation'
      && entry.reason?.includes('vyřazen s vlastní expozicí: MNQZ6:2'))).toBe(true);
    h.controller.stop();
  });

  it('příznak odmítne za ARM, s pozicí leadera a pro zapnutí', async () => {
    const armed = await harness();
    armed.controller.arm();
    await expect(armed.controller.setFollowerEnabled(200, false, armed.persist, { allowOwnExposure: true }))
      .rejects.toThrow('jen při vypnuté kopírce');
    armed.controller.stop();

    const leaderOpen = await harness();
    await leaderOpen.manual200(1);
    await leaderOpen.position(100, 1);
    await expect(leaderOpen.controller.setFollowerEnabled(200, false, leaderOpen.persist, { allowOwnExposure: true }))
      .rejects.toThrow('100 má');
    leaderOpen.controller.stop();

    const enable = await harness();
    await expect(enable.controller.setFollowerEnabled(200, true, enable.persist, { allowOwnExposure: true }))
      .rejects.toThrow('jen při vypnutí');
    enable.controller.stop();
  });

  it('pozici nebo příkaz, který může být z kopírky, nevyřadí', async () => {
    const h = await harness();
    h.controller.arm();
    h.broker.emitEvent({ type: 'order', order: leaderOrder('entry-1') });
    await h.controller.waitForIdle();
    expect(h.broker.placedRequests().some(request => request.accountId === 200)).toBe(true);
    h.controller.disarm();
    h.broker.emitEvent({ type: 'order', order: leaderOrder('entry-1', { status: 'canceled', sourceVersion: '2:Canceled' }) });
    await h.controller.waitForIdle();
    await h.manual200(1);
    const status = h.controller.status().followerParticipation?.find(item => item.accountId === 200);
    expect(status?.exclusionWithExposure?.allowed).toBe(false);
    await expect(h.controller.setFollowerEnabled(200, false, h.persist, { allowOwnExposure: true }))
      .rejects.toThrow(/může být z kopírky|200 má/);
    expect(h.persisted().followers[0].enabled).not.toBe(false);
    h.controller.stop();
  });

  it('follower s usazenou historií kopií jde vyřadit (outbox se nečistí, rozhoduje usazení)', async () => {
    const h = await harness();
    h.controller.arm();
    h.broker.emitEvent({ type: 'order', order: leaderOrder('entry-old') });
    await h.controller.waitForIdle();
    const copy = h.broker.orders().find(order => order.accountId === 200);
    expect(copy).toBeDefined();
    h.controller.disarm();
    h.broker.emitEvent({ type: 'order', order: leaderOrder('entry-old', { status: 'canceled', sourceVersion: '2:Canceled' }) });
    for (const order of h.broker.orders().filter(item => item.status === 'working')) {
      await h.broker.cancelOrder(order.accountId, order.brokerOrderId);
    }
    await h.controller.waitForIdle();
    // Flat event spustí ověřené usazení kopie (za DISARM, dvě kola).
    await h.position(200, 0);
    await h.position(300, 0);
    await sleep(60);
    await h.controller.waitForIdle();
    await h.manual200(1);
    expect(h.controller.status().followerParticipation?.find(item => item.accountId === 200)?.exclusionWithExposure)
      .toEqual({ allowed: true, reason: null });
    await h.controller.setFollowerEnabled(200, false, h.persist, { allowOwnExposure: true });
    expect(h.persisted().followers[0]).toMatchObject({ enabled: false });
    h.controller.stop();
  });

  it('po vyřazení je kontrola čistá, ON projde a vstup leadera dostane jen 300', async () => {
    const h = await harness();
    await h.manual200(-1);
    expect(h.controller.status().followerParticipation?.find(item => item.accountId === 200)?.exclusionWithExposure)
      .toEqual({ allowed: true, reason: null });
    await h.controller.setFollowerEnabled(200, false, h.persist, { allowOwnExposure: true });
    const reconciled = await h.controller.reconcile();
    expect(reconciled).toMatchObject({ authoritativelyClean: true, divergentAccounts: [], workingOrderAccounts: [] });
    expect(() => h.controller.arm()).not.toThrow();
    const before = h.broker.placedRequests().length;
    h.broker.emitEvent({ type: 'order', order: leaderOrder('entry-2') });
    await h.controller.waitForIdle();
    expect(h.broker.placedRequests().slice(before).map(request => request.accountId)).toEqual([300]);
    expect(h.controller.status().exposure?.followers).toContainEqual(expect.objectContaining({
      accountId: 200, ok: true, detail: 'vyřazen — vlastní pozice, kopírka ji neřídí',
    }));
    h.controller.stop();
  });

  it('za ARM: ruční obchod na vyřazeném účtu ani průchod leadera stejným symbolem skupinu neshodí', async () => {
    const h = await harness(group({ ...defaultSafety(), entryCooldownMinutes: 5 }));
    await h.manual200(1);
    await h.controller.setFollowerEnabled(200, false, h.persist, { allowOwnExposure: true });
    await h.controller.reconcile();
    // Incident z ručního obchodu PŘED vyřazením (zapojený follower) je
    // dnešní chování; za ARM už žádný další vzniknout nesmí.
    const incidentBefore = h.controller.status().manualRecovery?.id ?? null;
    h.controller.arm();
    // Ruční otočení pozice na vyřazeném účtu při flat leaderovi.
    await h.manual200(-2);
    await sleep(30);
    await h.controller.waitForIdle();
    expect(h.controller.status()).toMatchObject({ armed: true });
    expect(h.controller.status().manualRecovery?.id ?? null).toBe(incidentBefore);
    // Leader otevře a zavře obchod na stejném symbolu.
    // Kopie na 300 (zapojený follower) jde s leaderem; 200 drží vlastní pozici.
    const raw = (accountId: number, net: number) => {
      h.broker.setPosition(accountId, symbol, net);
      h.broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity: net } });
    };
    raw(100, 1); raw(300, 1);
    await h.controller.waitForIdle();
    raw(100, 0); raw(300, 0);
    await h.controller.waitForIdle();
    await sleep(150);
    await h.controller.waitForIdle();
    // Leader-flat guard musí epochu skutečně vyhodnotit (200 je v ní jako
    // neparticipant se stejným symbolem).
    expect(h.audits.some(entry => entry.reason?.includes('leader-flat guard: leader i všichni účastníci jsou autoritativně flat'))).toBe(true);
    await sleep(50);
    await h.controller.waitForIdle();
    const status = h.controller.status();
    expect(status.manualRecovery?.id ?? null).toBe(incidentBefore);
    // Cooldown po flat leadera se aktivuje i s pozicí vyřazeného účtu.
    expect(status.entryCooldownUntil).toBeGreaterThan(Date.now());
    expect(h.broker.liquidateRequests?.().filter((request: { accountId: number }) => request.accountId === 200) ?? [])
      .toHaveLength(0);
    expect(await h.broker.listPositions(200)).toEqual([expect.objectContaining({ netQuantity: -2 })]);
    h.controller.stop();
  });

  it('opětovné zapnutí vyřazeného účtu s pozicí zůstává zakázané', async () => {
    const h = await harness();
    await h.manual200(1);
    await h.controller.setFollowerEnabled(200, false, h.persist, { allowOwnExposure: true });
    await expect(h.controller.setFollowerEnabled(200, true, h.persist)).rejects.toThrow();
    expect(h.persisted().followers[0]).toMatchObject({ enabled: false });
    h.controller.stop();
  });

  it('vypnutý follower s neusazenou kopií není „cizí“ — pozice dál blokuje', async () => {
    const h = await harness();
    h.controller.arm();
    h.broker.emitEvent({ type: 'order', order: leaderOrder('entry-trace') });
    await h.controller.waitForIdle();
    h.controller.disarm();
    h.broker.emitEvent({ type: 'order', order: leaderOrder('entry-trace', { status: 'canceled', sourceVersion: '2:Canceled' }) });
    for (const order of h.broker.orders().filter(item => item.status === 'working')) {
      await h.broker.cancelOrder(order.accountId, order.brokerOrderId);
    }
    await h.controller.waitForIdle();
    // Bez flat eventu se kopie neusadí; běžné vypnutí (flat, bez příkazů) projde.
    await h.controller.setFollowerEnabled(200, false, h.persist);
    h.broker.setPosition(200, symbol, 1);
    h.broker.emitEvent({ type: 'position', position: { accountId: 200, symbol, netQuantity: 1 } });
    await h.controller.waitForIdle();
    expect(h.controller.status().excludedForeignFollowers).toEqual([]);
    expect(await h.controller.reconcile()).toMatchObject({ divergentAccounts: [200] });
    h.controller.stop();
  });

  it('bez vypnutého followera se cizí pozice dál chová jako divergence', async () => {
    const h = await harness();
    await h.manual200(1);
    expect(await h.controller.reconcile()).toMatchObject({ divergentAccounts: [200] });
    expect(() => h.controller.arm()).toThrow();
    h.controller.stop();
  });
});

function defaultSafety() {
  return structuredClone(DEFAULT_COPY_GROUP_SAFETY);
}
