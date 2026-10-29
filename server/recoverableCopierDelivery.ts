import { isLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace.js';
import { isLeaderOrderManageCommand } from '../lib/leaderOrderManage.js';
import { randomUUID } from 'node:crypto';
import type { LocalCopierExecutionAgent } from './localCopierExecutionAgent.js';
import { localCopierAgentErrorDetails, type LocalCopierAgentCommand } from '../lib/localCopierAgentProtocol.js';
import type { RelayDelivery, RelayDeliveryStore } from './copierRelayDeliveryStore.js';
import { tradovateSessionEndAt } from '../services/copierArmSession.js';

type Request = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
export const COPIER_COMMAND_ACK_RESERVE_MS = 10_000;
export const COPIER_RELAY_CLOCK_SKEW_RESERVE_MS = 2_000;
/** Kolik id příkazů zahájených v této session si relay pamatuje (pojistka proti druhé execution). */
export const COPIER_RELAY_STARTED_MEMORY = 200;
/** Serial, durable transport recovery. Only HTTP delivery/ACK is retried;
 * once execution starts a trading or configuration command can NEVER be
 * executed by this relay again. Idempotent brakes (DISARM, kill switch, day
 * lock) are the deliberate exception: a claimed brake is replayed after a
 * restart or a failed checkpoint write, because it only tightens. */
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
  /** Příkazy, jejichž execution tato session zahájila (zápis `executing`) nebo
   * jejichž výsledek se ztratil s osiřelou delivery. Ne-brzda z této množiny se
   * už nikdy neprovede — ani když ji DB (obnovená, ručně upravená) vydá znovu. */
  const started = new Set<string>();
  const rememberStarted = (id: string) => {
    started.delete(id);
    started.add(id);
    if (started.size > COPIER_RELAY_STARTED_MEMORY) started.delete(started.values().next().value!);
  };
  /** Checkpoint s delivery, kterou DB nezná nebo svázala s jiným příkazem
   * (obnova DB, ruční zásah). Jeho výsledek už nejde ACKnout — zůstane jen
   * tady v logu; relay pokračuje dál místo věčné chyby (29. 10. 2026). */
  const orphan = (current: RelayDelivery, reason: string, boundCommandId?: string) => {
    if (current.commandId) rememberStarted(current.commandId);
    console.error(`${new Date().toISOString()} RELAY DELIVERY ORPHANED reason=${reason} deliveryId=${current.deliveryId}`
      + ` phase=${current.phase} commandId=${current.commandId ?? '-'}${boundCommandId ? ` boundCommandId=${boundCommandId}` : ''}`
      + ` result=${JSON.stringify(current.result ?? null).slice(0, 300)} error=${(current.error ?? '-').slice(0, 200)}`);
  };
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
    const pollStartedAt = now();
    const response = await options.request({ action: 'poll-v2', deliveryId: current.deliveryId });
    const pollReceivedAt = now();
    if (!Object.hasOwn(response, 'command')) throw new Error('relay-delivery-response-invalid');
    if (response.protocol !== 2) throw new Error('relay-delivery-protocol-unavailable');
    const remote = response.command as { id: string; command: LocalCopierAgentCommand; createdAt: string; expiresAt: string; status: string } | null;
    if (!remote) {
      // DB delivery nezná a nic k ní nepřiřadila — checkpoint je osiřelý.
      if (current.phase !== 'polling') orphan(current, 'unknown-to-server');
      await persist(null); return response;
    }
    // Řádek s naší delivery zase `pending` (ruční zásah): mohl už běžet, takže
    // se zapamatuje jako zahájený a vezme se znovu pod novou delivery.
    if (remote.status === 'pending') {
      orphan(current, 'bound-command-pending', remote.id);
      rememberStarted(remote.id);
      await persist(null); return response;
    }
    // DB svázala naši delivery s jiným příkazem, než nese checkpoint: vazba na
    // checkpoint se ztratila. Vázaný příkaz se zpracuje jako nový claim zotavení
    // nad čerstvým checkpointem — nikdy s výsledkem ani session původního.
    let recovered = false;
    if (current.commandId && current.commandId !== remote.id) {
      orphan(current, 'delivery-bound-to-other-command', remote.id);
      // Čerstvý checkpoint jen v paměti: další zápis (executing / completed) přijde
      // dřív než jakýkoli request či execution. Kdyby se zapsal sám a pak selhal
      // zápis výsledku, další krok by neshodu už neviděl a ne-brzdu by provedl.
      current = { version: 1, session, deliveryId: current.deliveryId, phase: 'polling' };
      recovered = true;
    }
    if (remote.status === 'succeeded' || remote.status === 'rejected' || remote.status === 'expired') {
      await persist(null); return response;
    }
    if (remote.status !== 'claimed') throw new Error('relay-delivery-status-invalid');
    // DISARM / kill switch / denní zámek jsou idempotentní a jen zpřísňují:
    // claim z předchozí session (ztracená odpověď při restartu) se proto
    // provede, ne ACKne jako neznámý. Obchodní a konfigurační příkazy se nikdy
    // neopakují.
    const idempotentBrake = remote.command.type === 'disarm' || remote.command.type === 'kill-switch'
      || remote.command.type === 'lock-until-session-end';

    if (current.phase === 'completed') {
      // Výsledek už je durable (i z předchozí session): jen ho znovu
      // potvrdíme, nepřepisujeme na „neznámý“ (8. 10. 2026).
    } else if ((current.session !== session || current.phase === 'executing') && !idempotentBrake) {
      await persist({ ...current, phase: 'completed', commandId: remote.id, result: null,
        error: 'command-outcome-unknown-worker-session-changed' });
    } else if (!idempotentBrake && started.has(remote.id)) {
      // Tato session už jeho execution zahájila (nebo ztratila výsledek s osiřelou
      // delivery) — DB ho vydala znovu. Neopakovat; výsledek neznámý.
      await persist({ ...current, phase: 'completed', commandId: remote.id, result: null,
        error: 'command-outcome-unknown-already-started-this-session' });
    } else if (!idempotentBrake && recovered) {
      // Zotavení z anomálie fronty: obchodní a konfigurační příkazy se nespouštějí,
      // brzdy (jen zpřísňují) ano. Netvrdí „neprovedeno“ — pravdu ukáže status.
      await persist({ ...current, phase: 'completed', commandId: remote.id, result: null,
        error: 'command-rejected-relay-delivery-recovered' });
    } else if (current.phase === 'polling' || idempotentBrake) {
      const serverNow = typeof response.serverNow === 'string' ? Date.parse(response.serverNow) : NaN;
      const localMidpoint = pollStartedAt + ((pollReceivedAt - pollStartedAt) / 2);
      const serverClockOffsetMs = Number.isFinite(serverNow) ? serverNow - localMidpoint : 0;
      const clockSkewReserveMs = Math.max(
        COPIER_RELAY_CLOCK_SKEW_RESERVE_MS,
        Math.ceil(Math.max(0, pollReceivedAt - pollStartedAt) / 2),
      );
      const created = Date.parse(remote.createdAt) - serverClockOffsetMs;
      const expires = Date.parse(remote.expiresAt) - serverClockOffsetMs;
      // Denní zámek blízko hranice session (17:00 CT) nejde bez hodin přiřadit
      // ke správnému dni; odhad posunu by mohl zamknout celý další den.
      const dayLockSessionAmbiguous = remote.command.type === 'lock-until-session-end'
        && Number.isFinite(created)
        && tradovateSessionEndAt(created - clockSkewReserveMs) !== tradovateSessionEndAt(created + clockSkewReserveMs);
      const validPrestartDayLock = remote.command.type === 'lock-until-session-end'
        && Number.isFinite(created)
        && !dayLockSessionAmbiguous
        && tradovateSessionEndAt(created) > now();
      // Brzda zadaná před restartem workeru se provede i v nové session:
      // jen zpřísňuje (DISARM / kill switch) a nesmí se ztratit (8. 10. 2026).
      const validPrestartBrake = remote.command.type === 'kill-switch' || remote.command.type === 'disarm';
      if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= now()
        || dayLockSessionAmbiguous
        || (created < startedAt && !validPrestartDayLock && !validPrestartBrake)) {
        await persist({ ...current, phase: 'completed', commandId: remote.id, result: null,
          error: 'command-expired-or-predates-worker-session' });
      } else {
        console.log(`${new Date().toISOString()} RELAY CMD ${remote.command.type} id=${remote.id} queueMs=${Math.max(0, now() - created)}`);
        rememberStarted(remote.id);
        await persist({ ...current, phase: 'executing', commandId: remote.id });
        const executionStarted = performance.now();
        let result: unknown = null;
        let executionError: string | undefined;
        // Recheck TTL after durable disk writes, immediately before execution.
        if (options.isActive?.() === false) executionError = 'command-cancelled-worker-shutdown';
        else if (expires <= now()) executionError = 'command-expired-before-execution';
        // Brzdy se nikdy nezahazují (8. 10. 2026, review kola 4–6): pořadí
        // záměrů nejde bez hodin spolehlivě doložit. Pozdě doručený DISARM
        // novějšího ARM je fail-safe — kopírka zůstane vypnutá a ukáže důvod.
        else {
          try {
            result = await options.agent.execute(remote.command, {
              source: 'relay',
              createdAt: created,
              clockSkewReserveMs,
              ...(remote.command.type === 'arm-live'
                ? { deadlineAt: expires - COPIER_COMMAND_ACK_RESERVE_MS }
                : {}),
              // Ruční vstup (fáze 1b): platnost do expiresAt bez ACK rezervy (§4).
              ...(isLeaderEntryPlaceCommand(remote.command) || isLeaderOrderManageCommand(remote.command) ? { deadlineAt: expires } : {}),
            });
          }
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
