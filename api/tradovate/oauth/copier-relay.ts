import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authorizeTradovateCopierDevice } from '../../../server/tradovateCopierDevice.js';
import {
  claimTradovateCopierCommand, completeTradovateCopierCommand, enqueueTradovateCopierCommand,
  heartbeatTradovateCopierDevice, readTradovateCopierCommand, readTradovateCopierDeviceRuntime,
} from '../../../server/tradovateCopierCommandRelay.js';
import { createTradovateAdminClient, readTradovateServerConfig, requireSupabaseUserId } from '../../../server/tradovateOAuthStore.js';
import { handleNativeCors } from '../../../server/nativeCors.js';
import { sendImmediateCopierArmPush, sendImmediateCopyEventPushes, type CopierArmTransition } from '../../../server/nativeCopierStatePush.js';
import type { LocalCopierAgentStatus } from '../../../lib/localCopierAgentProtocol.js';
import {
  CopierSnapshotRateLimiter,
  consumeCopierSnapshotRateLimit,
  storeCopierSnapshot,
  validateCopierSnapshotPayload,
} from '../../../server/copierSnapshotStore.js';
import { sendCopierSnapshotFollowUp, sendTvAlertSnapshotFollowUp } from '../../../server/snapshotImagePush.js';
import { loadPendingTvAlertSnapshotRequests } from '../../../server/tvAlertNotifications.js';

const snapshotRateLimiter = new CopierSnapshotRateLimiter();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Capacitor appka vola tyto endpointy z capacitor://localhost — bez CORS
  // preflight odpovedi selze fetch jako 'Load failed'. Web je same-origin.
  if (handleNativeCors(req, res, ['GET', 'POST', 'DELETE'])) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const config = readTradovateServerConfig();
    if (config.environment !== 'demo') return res.status(409).json({ error: 'copier-relay-demo-only' });
    const db = createTradovateAdminClient(config);
    const isDevice = req.headers.authorization?.startsWith('Device ');
    if (isDevice) {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
      const device = await authorizeTradovateCopierDevice({ db, authorization: req.headers.authorization });
      const action = String(req.body?.action ?? '');
      if (action === 'snapshot') {
        const input = validateCopierSnapshotPayload(req.body);
        if (input.kind === 'tv-alert') {
          const { data: pendingAlert, error: pendingAlertError } = await db.from('tv_alerts')
            .select('id').eq('id', input.episodeId).eq('user_id', device.userId)
            .is('snapshot_path', null)
            .gt('created_at', new Date(Date.now() - 60_000).toISOString())
            .maybeSingle<{ id: string }>();
          if (pendingAlertError) throw new Error(`tv-alert-snapshot-validate-failed: ${pendingAlertError.message}`);
          if (!pendingAlert) return res.status(202).json({ accepted: false });
        }
        if (!snapshotRateLimiter.consume(device.id)) {
          return res.status(429).json({ error: 'snapshot-rate-limit' });
        }
        try {
          if (!await consumeCopierSnapshotRateLimit({ db, deviceId: device.id })) {
            return res.status(429).json({ error: 'snapshot-rate-limit' });
          }
          const stored = await storeCopierSnapshot({ db, userId: device.userId, input });
          if (input.kind === 'tv-alert') {
            const { error: alertUpdateError } = await db.from('tv_alerts').update({ snapshot_path: stored.storagePath })
              .eq('id', input.episodeId).eq('user_id', device.userId).is('snapshot_path', null);
            if (alertUpdateError) throw new Error(`tv-alert-snapshot-link-failed: ${alertUpdateError.message}`);
          }
          // Samostatný pozdější APNs payload. Chyba signed URL / APNs nikdy
          // nemění přijetí snapshotu ani worker/trading výsledek.
          try {
            if (input.kind === 'tv-alert') {
              await sendTvAlertSnapshotFollowUp({
                db, userId: device.userId, alertId: input.episodeId, storagePath: stored.storagePath,
              });
            } else {
              await sendCopierSnapshotFollowUp({
                db, userId: device.userId, deviceId: device.id, input, storagePath: stored.storagePath,
              });
            }
          } catch (reason) {
            console.warn('[SNAPSHOT] follow-up push failed', reason instanceof Error ? reason.message : String(reason));
          }
          return res.status(202).json({ accepted: true, path: stored.storagePath });
        } catch (reason) {
          // Snapshot je observability artefakt. Jeho Storage/DB selhání nesmí
          // ovlivnit poll ani trading command cestu; worker už nic neopakuje
          // po svém bounded retry a tato akce končí úspěšným přijetím.
          console.warn('[SNAPSHOT] store failed', reason instanceof Error ? reason.message : String(reason));
          return res.status(202).json({ accepted: false });
        }
      }
      if (action === 'poll') {
        if (req.body?.status) await heartbeatTradovateCopierDevice({ db, deviceId: device.id, userId: device.userId, connectionId: device.connectionId, status: req.body.status });
        // Worker hlásí nové trade eventy -> okamžitý push místo čekání na
        // minutový cron (sdílený marker, cron je jen záloha).
        if (req.body?.copyEvents === true && req.body?.status) {
          try {
            await sendImmediateCopyEventPushes({
              db, userId: device.userId, deviceId: device.id,
              status: req.body.status as Record<string, unknown>,
            });
          } catch (reason) {
            console.warn('[copier-relay] immediate copy-event push failed',
              reason instanceof Error ? reason.message : String(reason));
          }
        }
        // Broker/UI command má přednost: pokud nějaký čeká, poll nečeká ani na
        // levný snapshot dotaz. Obrázek si worker vyzvedne až v dalším kole.
        const command = await claimTradovateCopierCommand({ db, deviceId: device.id });
        let snapshotRequests: Awaited<ReturnType<typeof loadPendingTvAlertSnapshotRequests>> = [];
        if (!command) {
          try {
            snapshotRequests = await loadPendingTvAlertSnapshotRequests({ db, userId: device.userId });
          } catch (reason) {
            console.warn('[copier-relay] tv-alert snapshot request failed',
              reason instanceof Error ? reason.message : String(reason));
          }
        }
        return res.status(200).json({
          command,
          snapshotRequests,
          // Realtime „kick": worker se přihlásí k broadcast kanálu a příkaz
          // dostane okamžitě místo čekání na další poll. Anon key je veřejný
          // (je i ve web bundlu); kanál nenese žádná data, jen budíček.
          realtime: {
            url: config.supabaseUrl,
            anonKey: config.supabaseAnonKey,
            topic: `copier-kick-${device.id}`,
          },
        });
      }
      if (action === 'complete') {
        const commandId = String(req.body?.commandId ?? '');
        const commandError = typeof req.body?.error === 'string' ? req.body.error : undefined;
        const status = req.body?.status as LocalCopierAgentStatus | undefined;
        if (status) {
          await heartbeatTradovateCopierDevice({
            db, deviceId: device.id, userId: device.userId,
            connectionId: device.connectionId, status,
          });
        }
        const { data: commandRow, error: commandErrorLookup } = await db
          .from('tradovate_copier_commands')
          .select('command_type')
          .eq('id', commandId)
          .eq('device_id', device.id)
          .eq('status', 'claimed')
          .maybeSingle<{ command_type: string }>();
        if (commandErrorLookup) throw new Error(`copier-relay-command-type-failed: ${commandErrorLookup.message}`);

        const accepted = await completeTradovateCopierCommand({
          db, deviceId: device.id, commandId,
          result: req.body?.result, error: commandError,
        });
        let immediatePush: { devices: number; sent: number } | undefined;
        const transition: CopierArmTransition | null = commandRow?.command_type === 'arm-live'
          ? 'arm-started'
          : commandRow?.command_type === 'disarm' ? 'arm-ended' : null;
        if (accepted && !commandError && transition) {
          try {
            immediatePush = await sendImmediateCopierArmPush({
              db, userId: device.userId, deviceId: device.id, transition,
            });
          } catch (pushError) {
            // Notifikace nikdy nesmí změnit potvrzený výsledek copier příkazu.
            // Marker při chybě zůstane beze změny a minutový watchdog je retry.
            console.error('[copier-relay-push]', pushError instanceof Error ? pushError.message : String(pushError));
          }
        }
        return res.status(accepted ? 200 : 409).json({ accepted, immediatePush });
      }
      return res.status(400).json({ error: 'invalid-copier-relay-action' });
    }

    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const connectionId = String(req.method === 'GET' ? req.query.connectionId ?? '' : req.body?.connectionId ?? '').trim();
    if (!connectionId) return res.status(400).json({ error: 'missing-connection-id' });
    if (req.method === 'GET') {
      const commandId = typeof req.query.commandId === 'string' ? req.query.commandId : '';
      if (commandId) return res.status(200).json(await readTradovateCopierCommand({ db, userId, commandId }));
      return res.status(200).json(await readTradovateCopierDeviceRuntime({ db, userId, connectionId }));
    }
    if (req.method === 'POST') {
      const queued = await enqueueTradovateCopierCommand({ db, userId, connectionId, command: req.body?.command, idempotencyKey: req.body?.idempotencyKey });
      // Budíček pro worker: bez něj příkaz čeká na další poll (~750 ms).
      // Kick je jen optimalizace — selhání nesmí shodit enqueue.
      try {
        await fetch(`${config.supabaseUrl}/realtime/v1/api/broadcast`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: config.supabaseServiceRoleKey,
            Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
          },
          body: JSON.stringify({ messages: [{ topic: `copier-kick-${queued.deviceId}`, event: 'kick', payload: {} }] }),
          signal: AbortSignal.timeout(1_500),
        });
      } catch {
        // Poll fallback příkaz doručí i bez kicku.
      }
      // Long-poll: worker s kickem vyřídí příkaz typicky do ~1,5 s — když
      // výsledek stihneme, UI ušetří celé polling kolečko (další RTT).
      // POZOR: enqueue už durable proběhl — selhání long-pollu se MUSÍ
      // degradovat na obyčejné `202 queued`. Chyba (502) by klienta svedla
      // k novému pokusu s novým idempotencyKey = duplicitní příkaz.
      // (Nález GPT cross-review, 2026-08-21.)
      let resolution: Awaited<ReturnType<typeof readTradovateCopierCommand>> | null = null;
      try {
        const longPollDeadline = Date.now() + 2_200;
        while (Date.now() < longPollDeadline) {
          await new Promise(resolve => setTimeout(resolve, 150));
          const current = await readTradovateCopierCommand({ db, userId, commandId: queued.id });
          if (current.status === 'succeeded' || current.status === 'rejected' || current.status === 'expired') {
            resolution = current;
            break;
          }
        }
      } catch {
        // UI si výsledek vyzvedne klasickým pollingem.
      }
      return res.status(202).json({ ...queued, ...(resolution ? { resolution } : {}) });
    }
    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('auth-token') || message === 'invalid-copier-device-auth') return res.status(401).json({ error: message });
    if (message.endsWith('not-found')) return res.status(404).json({ error: message });
    if (message === 'snapshot-too-large') return res.status(413).json({ error: message });
    if (message === 'invalid-snapshot-payload' || message === 'invalid-snapshot-png') {
      return res.status(400).json({ error: message });
    }
    // Odmítnutý příkaz je validační chyba klienta — generické 502 „copier
    // relay failed" by maskovalo skutečný důvod (viz Flatten ze Safari).
    if (message === 'unsupported-relay-command' || message === 'unsupported-remote-copy-command' || message === 'invalid-relay-command-payload') {
      return res.status(400).json({ error: message });
    }
    console.error('[copier-relay]', message);
    return res.status(502).json({ error: 'copier-relay-failed' });
  }
}
