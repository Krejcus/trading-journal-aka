import { randomUUID } from 'node:crypto';
import type { LocalCopierExecutionAgent } from './localCopierExecutionAgent.js';
import { localCopierAgentErrorDetails, type LocalCopierAgentCommand } from '../lib/localCopierAgentProtocol.js';
import type { RelayDelivery, RelayDeliveryStore } from './copierRelayDeliveryStore.js';

type Request = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** Serial, durable transport recovery. Only HTTP delivery/ACK is retried;
 * once execution starts the command can NEVER be executed by this relay again. */
export function recoverableCopierDelivery(options: {
  store: RelayDeliveryStore; agent: LocalCopierExecutionAgent; request: Request;
  nextRevision: () => number; onComplete: (id: string) => void;
  now?: () => number; isActive?: () => boolean;
}) {
  const session = randomUUID();
  const now = options.now ?? Date.now;
  const startedAt = now();
  let loaded = false;
  let checkpoint: RelayDelivery | null = null;
  const persist = async (next: RelayDelivery | null) => {
    // Update memory first, even if fsync fails after execution. A later attempt
    // must persist this same state before sending any request or doing work.
    checkpoint = next;
    await options.store.write(next);
  };
  return async () => {
    if (!loaded) { checkpoint = await options.store.read(); loaded = true; }
    if (!checkpoint) await persist({ version: 1, session, deliveryId: randomUUID(), phase: 'polling' });
    let current = checkpoint!;
    await options.store.write(current);
    const response = await options.request({ action: 'poll-v2', deliveryId: current.deliveryId });
    if (!Object.hasOwn(response, 'command')) throw new Error('relay-delivery-response-invalid');
    if (response.protocol !== 2) throw new Error('relay-delivery-protocol-unavailable');
    const remote = response.command as { id: string; command: LocalCopierAgentCommand; createdAt: string; expiresAt: string; status: string } | null;
    if (!remote) {
      if (current.phase !== 'polling') throw new Error('relay-delivery-command-missing');
      await persist(null); return response;
    }
    if (current.commandId && current.commandId !== remote.id) throw new Error('relay-delivery-command-mismatch');
    if (remote.status === 'succeeded' || remote.status === 'rejected' || remote.status === 'expired') {
      await persist(null); return response;
    }
    if (remote.status !== 'claimed') throw new Error('relay-delivery-status-invalid');
    if (current.session !== session || current.phase === 'executing') {
      await persist({ ...current, phase: 'completed', commandId: remote.id, result: null,
        error: 'command-outcome-unknown-worker-session-changed' });
    } else if (current.phase === 'polling') {
      const created = Date.parse(remote.createdAt);
      const expires = Date.parse(remote.expiresAt);
      if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= now() || created < startedAt) {
        await persist({ ...current, phase: 'completed', commandId: remote.id, result: null,
          error: 'command-expired-or-predates-worker-session' });
      } else {
        console.log(`${new Date().toISOString()} RELAY CMD ${remote.command.type} id=${remote.id} queueMs=${Math.max(0, now() - created)}`);
        await persist({ ...current, phase: 'executing', commandId: remote.id });
        const executionStarted = performance.now();
        let result: unknown = null;
        let executionError: string | undefined;
        // Recheck TTL after durable disk writes, immediately before execution.
        if (options.isActive?.() === false) executionError = 'command-cancelled-worker-shutdown';
        else if (expires <= now()) executionError = 'command-expired-before-execution';
        else {
          try { result = await options.agent.execute(remote.command); }
          catch (error) {
            executionError = error instanceof Error ? error.message : String(error);
            const details = localCopierAgentErrorDetails(error);
            if (details) result = { errorDetails: details };
          }
        }
        await persist({ ...checkpoint!, phase: 'completed', result: result ?? null, error: executionError?.slice(0, 500) });
        console.log(`${new Date().toISOString()} RELAY EXECUTED id=${remote.id} durationMs=${Math.round(performance.now() - executionStarted)}`);
      }
    }
    current = checkpoint!;
    const ackStarted = performance.now();
    const ack = await options.request({ action: 'complete-v2', deliveryId: current.deliveryId,
      commandId: remote.id, result: current.result ?? null, error: current.error ?? null,
      status: options.agent.status(), revision: options.nextRevision() });
    if (ack.protocol !== 2 || ack.accepted !== true) throw new Error('relay-delivery-ack-not-confirmed');
    console.log(`${new Date().toISOString()} RELAY ACK id=${remote.id} durationMs=${Math.round(performance.now() - ackStarted)}`);
    options.onComplete(remote.id);
    await persist(null);
    return response;
  };
}
