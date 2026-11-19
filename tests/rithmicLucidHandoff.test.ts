import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { requestLucidHandoff } from '../scripts/rithmic/lucidHandoff';

let socket: EventEmitter & { send: ReturnType<typeof vi.fn> };
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    send = vi.fn();
    terminate() {}
    constructor() { super(); socket = this; }
  },
}));
const deliver = (message: object) => socket.emit('message', JSON.stringify(message));
const hello = { type: 'hello', maintenancePid: 42, system: 'LucidTrading', account: 'account', live: true };
const start = () => requestLucidHandoff(3311, 'token', 'account', 42, 1000);

describe('předání běžící služby po autorizaci', () => {
  it('starší službě neposílá požadavek', async () => {
    const result = start();
    deliver({ ...hello, maintenancePid: undefined });
    expect(await result).toBe('legacy');
    expect(socket.send).not.toHaveBeenCalled();
  });
  it('odmítnutí účtu při kontrole flat nepřechází do druhé fáze', async () => {
    const result = start();
    deliver(hello);
    deliver({ type: 'maintenanceReply', accepted: false });
    await expect(result).rejects.toThrow();
    expect(socket.send).toHaveBeenCalledTimes(1);
  });
  it('ztráta spojení před předáním ukončí nástupce', async () => {
    const result = start();
    deliver(hello);
    socket.emit('close');
    await expect(result).rejects.toThrow();
    expect(socket.send).toHaveBeenCalledTimes(1);
  });
  it('po potvrzení připravenosti čeká i při ztracené odpovědi na odchod konkrétního procesu', async () => {
    const result = start();
    deliver(hello);
    deliver({ type: 'maintenanceReady' });
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ maintenanceCommit: true }));
    socket.emit('close');
    expect(await result).toBe('handoff');
  });
});
