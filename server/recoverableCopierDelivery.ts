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
/** Push (F1b′) smí použít offset hodin jen z pollu ne staršího než tohle; jinak čeká na poll. */
export const COPIER_RELAY_PUSH_CLOCK_MAX_AGE_MS = 60_000;

/** Řádek navázaný serverem k nečinné delivery a doručený podepsaným pushem (už ověřený podpis). */
export interface PushedCopierDelivery { deliveryId: string; command: unknown }

/**
 * Ruční vstup/správa používají z odpovědi jen konkrétní brokerový výsledek.
 * Autoritativní status jde samostatně (complete-v2, nebo heartbeat po kompaktním
 * complete-hot-v3) a stejný 20kB objekt uvnitř `result.status` by se jinak dvakrát
 * přenesl, dvakrát zapsal do JSONB a znovu vrátil prohlížeči. Ostatní příkazy
 * status v odpovědi používají, proto se kompaktují jen tyto dvě horké cesty.
 */
export function compactRecoverableCopierResult(command: LocalCopierAgentCommand, result: unknown): unknown {
  if (!isLeaderEntryPlaceCommand(command) && !isLeaderOrderManageCommand(command)) return result;
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true
    || !Object.hasOwn(result, 'result')) return result;
  return { ok: true, result: (result as { result: unknown }).result };
}

/** Server kompaktní ACK neumí (starý web, neaplikovaná migrace): chvíli rovnou complete-v2. */
const COMPACT_ACK_UNAVAILABLE = /invalid-copier-relay-action|copier-relay-hot-ack-unavailable/;
const COMPACT_ACK_RETRY_AFTER_MS = 5 * 60_000;

/** Serial, durable transport recovery. Only HTTP delivery/ACK is retried;
 * once execution starts a trading or configuration command can NEVER be
 * executed by this relay again. Idempotent brakes (DISARM, kill switch, day
 * lock) are the deliberate exception: a claimed brake is replayed after a
 * restart or a failed checkpoint write, because it only tightens. */
export function recoverableCopierDelivery(options: {
  store: RelayDeliveryStore; agent: LocalCopierExecutionAgent; request: Request;
  nextRevision: () => number;
  /** ACK přijat. `statusPending` = status možná není v DB (kompaktní ACK) a pošle ho volající. */
  onComplete: (id: string, statusPending: boolean) => void;
  /**
   * Zobrazovací nudge po durable lokálním zápisu výsledku, ještě před vzdáleným
   * ACK. Nesmí autorizovat další příkaz ani měnit delivery; jeho selhání se
   * ignoruje a autoritativní complete-v2 pokračuje beze změny.
   */
  onDurableResult?: (id: string) => void;
  now?: () => number; isActive?: () => boolean;
}) {
  const session = randomUUID();
  const now = options.now ?? Date.now;
  const startedAt = now();
  let loaded = false;
  let compactAckPausedUntil = 0;
  /** Delivery, u které kompaktní ACK selhal: další pokusy jdou rovnou přes complete-v2. */
  let compactAckFailedFor: string | null = null;
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
  /** Offset hodin serveru z posledního pollu (push vlastní `serverNow` nemá — jednosměrná latence). */
  let lastClock: { offsetMs: number; reserveMs: number; at: number } | null = null;
  const freshPolling = () => ({ version: 1 as const, session, deliveryId: randomUUID(), phase: 'polling' as const });
  /** Durable checkpoint, jehož id se smí ohlásit serveru (`relayIdle`): jen `polling` této session. */
  let advertised: string | null = null;
  const run = async (pushed?: PushedCopierDelivery | null) => {
    if (!loaded) { checkpoint = await options.store.read(); loaded = true; }
    if (!checkpoint) await persist(freshPolling());
    let current = checkpoint!;
    await options.store.write(current);
    advertised = current.phase === 'polling' && current.session === session ? current.deliveryId : null;
    // Push se použije jen pro aktuální nečinnou delivery této session a s čerstvým offsetem
    // hodin z pollu; jinak se zahodí a jde se běžným pollem (ten vrátí tentýž vázaný řádek).
    const usePush = pushed != null && pushed.deliveryId === current.deliveryId && current.phase === 'polling'
      && current.session === session && lastClock != null && now() - lastClock.at <= COPIER_RELAY_PUSH_CLOCK_MAX_AGE_MS;
    const pollStartedAt = now();
    const response: Record<string, unknown> = usePush
      ? { protocol: 2, command: pushed!.command, pushed: true }
      : await options.request({ action: 'poll-v2', deliveryId: current.deliveryId });
    const pollReceivedAt = now();
    if (!Object.hasOwn(response, 'command')) throw new Error('relay-delivery-response-invalid');
    if (response.protocol !== 2) throw new Error('relay-delivery-protocol-unavailable');
    if (!usePush) {
      const serverNow = typeof response.serverNow === 'string' ? Date.parse(response.serverNow) : NaN;
      if (Number.isFinite(serverNow)) {
        lastClock = {
          offsetMs: serverNow - (pollStartedAt + ((pollReceivedAt - pollStartedAt) / 2)),
          reserveMs: Math.max(COPIER_RELAY_CLOCK_SKEW_RESERVE_MS, Math.ceil(Math.max(0, pollReceivedAt - pollStartedAt) / 2)),
          at: pollReceivedAt,
        };
      }
    }
    const remote = response.command as { id: string; command: LocalCopierAgentCommand; createdAt: string; expiresAt: string; status: string } | null;
    if (usePush && (!remote || typeof remote.id !== 'string' || remote.status !== 'claimed' || !remote.command)) {
      throw new Error('relay-delivery-push-invalid');
    }
    if (!remote) {
      // DB delivery nezná a nic k ní nepřiřadila — checkpoint je osiřelý.
      if (current.phase !== 'polling') orphan(current, 'unknown-to-server');
      // F1b′: nečinná delivery této session zůstává (server k ní smí navázat příkaz);
      // cizí session nebo osiřelý checkpoint se vymění za nový.
      if (current.phase !== 'polling' || current.session !== session) await persist(freshPolling());
      advertised = checkpoint!.deliveryId;
      return response;
    }
    advertised = null;
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
      // ACK se zapsal, ztratila se jen odpověď: kompaktní ACK status nenesl, takže ho dorovnej.
      if (remote.status !== 'expired' && current.phase === 'completed' && current.commandId === remote.id) {
        options.onComplete(remote.id, true);
      }
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
      // Offset hodin: u pollu z jeho vlastního měření, u pushe z posledního pollu (≤ 60 s).
      const pollServerNow = typeof response.serverNow === 'string' ? Date.parse(response.serverNow) : NaN;
      const serverClockOffsetMs = usePush ? lastClock!.offsetMs
        : Number.isFinite(pollServerNow) ? pollServerNow - (pollStartedAt + ((pollReceivedAt - pollStartedAt) / 2)) : 0;
      const clockSkewReserveMs = usePush ? lastClock!.reserveMs : Math.max(
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
        console.log(`${new Date().toISOString()} RELAY CMD ${remote.command.type} id=${remote.id} queueMs=${Math.max(0, now() - created)}${usePush ? ' via=push' : ''}`);
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
            result = compactRecoverableCopierResult(remote.command, await options.agent.execute(remote.command, {
              source: 'relay',
              createdAt: created,
              clockSkewReserveMs,
              ...(remote.command.type === 'arm-live'
                ? { deadlineAt: expires - COPIER_COMMAND_ACK_RESERVE_MS }
                : {}),
              // Ruční vstup (fáze 1b): platnost do expiresAt bez ACK rezervy (§4).
              ...(isLeaderEntryPlaceCommand(remote.command) || isLeaderOrderManageCommand(remote.command) ? { deadlineAt: expires } : {}),
            }));
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
    // Brokerův výsledek je už durable na disku workeru. Otevřený LIVE graf ho
    // smí zobrazit hned přes šifrovanou display-only cestu; serverový ACK a
    // audit dál proběhnou níže a nikdy se tímto nudgem neobcházejí.
    try { options.onDurableResult?.(remote.id); } catch { /* display-only */ }
    const ackStarted = performance.now();
    const ackFields = { deliveryId: current.deliveryId, commandId: remote.id,
      result: current.result ?? null, error: current.error ?? null };
    const compactAckFailedHere = compactAckFailedFor === current.deliveryId;
    const tryCompactAck = (isLeaderEntryPlaceCommand(remote.command) || isLeaderOrderManageCommand(remote.command))
      && !compactAckFailedHere && now() >= compactAckPausedUntil;
    let ackBytes = 0;
    let compactAccepted = false;
    if (tryCompactAck) {
      // Selhání kompaktního ACK nesmí zablokovat linku s brzdami za tímto příkazem
      // (INV-BRAKE-03): v téže delivery následuje complete-v2. Opakuje se jen ACK,
      // nikdy execution; po zapsaném v3 vrátí v2 jen shodu a nic nezmění.
      try {
        const body = { action: 'complete-hot-v3', ...ackFields, workerStartedAt: options.agent.status().startedAt };
        ackBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
        const ack = await options.request(body);
        compactAccepted = ack.protocol === 3 && ack.accepted === true;
        if (!compactAccepted) compactAckFailedFor = current.deliveryId;
      } catch (error) {
        compactAckFailedFor = current.deliveryId;
        const message = error instanceof Error ? error.message : String(error);
        if (COMPACT_ACK_UNAVAILABLE.test(message)) compactAckPausedUntil = now() + COMPACT_ACK_RETRY_AFTER_MS;
        console.warn(`${new Date().toISOString()} RELAY compact ACK → complete-v2 id=${remote.id}: ${message}`);
      }
    }
    if (!compactAccepted) {
      const body = { action: 'complete-v2', ...ackFields, status: options.agent.status(), revision: options.nextRevision() };
      ackBytes += new TextEncoder().encode(JSON.stringify(body)).byteLength;
      const ack = await options.request(body);
      if (ack.protocol !== 2 || ack.accepted !== true) throw new Error('relay-delivery-ack-not-confirmed');
    }
    console.log(`${new Date().toISOString()} RELAY ACK id=${remote.id} bytes=${ackBytes}`
      + ` durationMs=${Math.round(performance.now() - ackStarted)}`);
    // Budíček UI dřív než zápis nové delivery — jeho selhání ho nesmí spolknout (oponentura P2-3).
    // Po pokusu o v3 mohlo v2 vrátit jen shodu bez zápisu statusu, proto se status dorovná i tehdy.
    options.onComplete(remote.id, tryCompactAck || compactAckFailedHere);
    // Rovnou nová nečinná delivery (F1b′): server ji uvidí v nejbližším statusu.
    await persist(freshPolling());
    advertised = checkpoint!.deliveryId;
    return response;
  };
  return Object.assign(run, {
    /** `relayIdle` pro status: id durable nečinné delivery této session, jinak null. */
    idleDeliveryId: (): string | null => advertised,
  });
}
