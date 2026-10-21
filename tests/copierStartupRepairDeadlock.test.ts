import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

// Incident 21. 10. 2026: leader uložené skupiny zmizel z OAuth. Worker
// naběhl v režimu opravy, automatická kontrola pozic po startu nemohla
// uspět a zůstala dlužná. preflightGroupChange pak odmítl i opravu skupiny
// z UI („blokuje probíhající connection recovery“) — oprava čekala na
// kontrolu a kontrola na opravu. E2 (30. 9.) to řešil jen v activateGroup,
// kam se z UI přes preflight nikdy nedošlo.

type RoutingRequest = { required: number[]; optional: number[] };

const broken = (): CopyGroupConfig => ({
  id: 'g', name: 'Origoš', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
const repaired = (): CopyGroupConfig => ({
  ...broken(), leaderAccountId: 400, followers: [{ accountId: 500, mode: 'on-submit', multiplier: 1 }],
});

let running: LocalCopierExecutionAgent | null = null;
afterEach(async () => { await running?.close(); running = null; });

async function setup(options: { stateful?: boolean; unavailable?: number[]; group?: CopyGroupConfig } = {}) {
  const initial = emptySnapshot();
  if (options.stateful) initial.safety = { entryCooldownUntil: 0, dayLockUntil: 0, liveCopyOpenSince: 1 };
  const unavailable = options.unavailable ?? [100];
  const group = options.group ?? broken();
  const broker = createMockBroker();
  const router = createBrokerRouter([{ broker, accountIds: [200, 300, 400, 500] }]);
  let now = 1_000;
  const controller = await bootstrapCopierRuntime({
    broker: router, store: createMemoryCopierStore(initial), group, clock: () => ++now,
    wait: async () => undefined,
    resolveMissingOptionalAccountIds: async () => {
      throw new Error(`Účet ${unavailable[0]} není viditelný v žádném připojeném OAuth`);
    },
    unusableGroupRepairBootstrap: { groupId: group.id, unavailableAccountIds: unavailable },
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  const missing = (request: RoutingRequest) => ({
    missingOptional: request.optional.filter(accountId => unavailable.includes(accountId)),
  });
  running = await startLocalCopierExecutionAgent({
    controller, group, port: 0,
    prepareGroupAccounts: vi.fn(async (request: RoutingRequest) => missing(request)),
    previewGroupAccounts: vi.fn(async (request: RoutingRequest) => missing(request)),
  });
  return { broker, controller, agent: running };
}

describe('incident 21. 10. 2026 — oprava skupiny po startu nesmí čekat na nemožnou kontrolu', () => {
  for (const stateful of [false, true]) {
    it(`oprava z UI projde (${stateful ? 'stopa živé kopie' : 'čistý start'}), kopírka zůstane vypnutá a vyžaduje kontrolu`, async () => {
      const { controller, agent } = await setup({ stateful });
      try {
        expect(controller.status().startupGroupRepair).toEqual({ groupId: 'g', unavailableAccountIds: [100] });
        // Výchozí stav: dlužná kontrola po startu opravdu blokuje běžnou změnu.
        expect(() => controller.preflightGroupChange(repaired(), { allowGroupChange: true }))
          .toThrow('probíhající connection recovery');
        await agent.execute({ type: 'copy-command', command: { type: 'update-group', group: repaired() } } as never);
        expect(controller.status()).toMatchObject({
          armed: false, startupGroupRepair: null, reconciliationRequired: true,
        });
        // Zapnutí bez nové kontroly pozic neprojde.
        expect(() => controller.arm()).toThrow();
        expect(controller.status().armed).toBe(false);
      } finally {
        controller.stop();
      }
    });
  }

  it('stopa živé kopie: starý účet s pozicí opravu dál zablokuje', async () => {
    const { broker, controller, agent } = await setup({ stateful: true });
    try {
      broker.setPosition(200, 'MNQZ6', 2);
      let failure: unknown = null;
      try {
        await agent.execute({ type: 'copy-command', command: { type: 'update-group', group: repaired() } } as never);
      } catch (reason) {
        failure = reason;
      }
      // Blokuje autoritativní čtení aktivace, ne dlužná recovery z preflightu.
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain('connection recovery');
      expect(controller.status().startupGroupRepair).not.toBeNull();
      expect(controller.status().armed).toBe(false);
    } finally {
      controller.stop();
    }
  });

  it('nová skupina pořád obsahuje nedostupný účet → odmítnuto', async () => {
    const { controller, agent } = await setup();
    try {
      await expect(agent.execute({
        type: 'copy-command',
        command: { type: 'update-group', group: { ...repaired(), followers: [{ accountId: 100, mode: 'on-submit', multiplier: 1 }] } },
      } as never)).rejects.toThrow();
      expect(controller.status().startupGroupRepair).not.toBeNull();
    } finally {
      controller.stop();
    }
  });

  it('preflight: výjimka jen pro přesnou množinu nedostupných účtů, nikdy mimo režim opravy', async () => {
    const { controller } = await setup({
      unavailable: [100, 300],
      group: { ...broken(), followers: [{ accountId: 300, mode: 'on-submit', multiplier: 1 }] },
    });
    try {
      const next = repaired();
      expect(() => controller.preflightGroupChange(next, { allowGroupChange: true, retireMissingAccountIds: [100] }))
        .toThrow('probíhající connection recovery');
      expect(() => controller.preflightGroupChange(next, { allowGroupChange: true, retireMissingAccountIds: [100, 300, 200] }))
        .toThrow('probíhající connection recovery');
      expect(() => controller.preflightGroupChange(next, { allowGroupChange: true }))
        .toThrow('probíhající connection recovery');
      expect(() => controller.preflightGroupChange(next, { retireMissingAccountIds: [100, 300] }))
        .toThrow();
      expect(() => controller.preflightGroupChange(next, { allowGroupChange: true, retireMissingAccountIds: [100, 100, 300] }))
        .toThrow('probíhající connection recovery');
      expect(() => controller.preflightGroupChange({ ...next, id: 'jina' }, { allowGroupChange: true, retireMissingAccountIds: [100, 300] }))
        .toThrow('nejdřív ulož opravenou stávající skupinu');
      expect(() => controller.preflightGroupChange(next, { allowGroupChange: true, retireMissingAccountIds: [100, 300] }))
        .not.toThrow();
    } finally {
      controller.stop();
    }
  });
});
