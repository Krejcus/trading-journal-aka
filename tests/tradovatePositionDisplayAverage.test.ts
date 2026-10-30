import { afterEach, describe, expect, it } from 'vitest';
import { createTradovateWireHarness } from './helpers/tradovateWireHarness';

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

describe('Tradovate Position netPrice (jen zobrazení, 30. 10.)', () => {
  const setup = async () => {
    const wire = createTradovateWireHarness();
    stops.push(wire.stop);
    wire.sync();
    await expect.poll(() => wire.events.some(event => event.type === 'connection' && event.connected)).toBe(true);
    return wire;
  };
  const lastPosition = (wire: ReturnType<typeof createTradovateWireHarness>) => wire.events
    .filter(event => event.type === 'position').at(-1);

  it('stream Position nese netPrice jako displayAveragePrice mimo BrokerPosition', async () => {
    const wire = await setup();
    wire.props({ entityType: 'position', entity: { accountId: 100, contractId: 7, netPos: 2, netPrice: 28_941.25 } });
    await expect.poll(() => lastPosition(wire)).toEqual({
      type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 }, displayAveragePrice: 28_941.25,
    });
  });

  it.each([null, 0, -5, Number.NaN, undefined])('neplatný netPrice %s = bez průměru', async netPrice => {
    const wire = await setup();
    wire.props({ entityType: 'position', entity: { accountId: 100, contractId: 7, netPos: 2, netPrice } });
    await expect.poll(() => lastPosition(wire)).toEqual({
      type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 },
    });
  });

  it('flat pozice průměr nenese ani s netPrice', async () => {
    const wire = await setup();
    wire.props({ entityType: 'position', entity: { accountId: 100, contractId: 7, netPos: 0, netPrice: 28_941.25 } });
    await expect.poll(() => lastPosition(wire)).toEqual({
      type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 },
    });
  });
});
