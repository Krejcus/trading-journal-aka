import { createHash } from 'node:crypto';
import webpush from 'web-push';
import type { ApnsResult } from './apns.js';

/**
 * Web push pro upozornění na cenu (2. 11. 2026). Stejné VAPID klíče jako cron
 * (`api/cron/send-alerts.ts`); nastaví se líně, aby chybějící privátní klíč
 * shodil jen doručení, nikdy import modulu.
 */
const PUBLIC_VAPID_KEY = 'BCwmYrmEguddSKE2FKQX0dv1gPwEDbwmuSXhN7wiNJ8tH0Aw2wHTVHpblm8_bDMUkgVqkvPSLJ32aqY84t_tOO4';
let configured = false;

export interface WebPushTarget { endpoint: string; keys: { p256dh: string; auth: string } }

export async function sendWebPushNotification(target: WebPushTarget, input: { title: string; body: string; tag: string; url?: string }): Promise<ApnsResult> {
  try {
    if (!configured) {
      const privateKey = process.env.VAPID_PRIVATE_KEY;
      if (!privateKey) return { status: 'failed', error: 'vapid-private-key-missing' };
      webpush.setVapidDetails('mailto:info@alphatrade.cz', PUBLIC_VAPID_KEY, privateKey);
      configured = true;
    }
    await webpush.sendNotification(target, JSON.stringify({ title: input.title, body: input.body, url: input.url ?? '/', tag: input.tag }), {
      timeout: 4_000,
      TTL: 600,
      headers: { Topic: createHash('sha256').update(input.tag).digest('base64url').slice(0, 32), Urgency: 'high' },
    });
    return { status: 'sent' };
  } catch (error: unknown) {
    const failure = error as { statusCode?: number; status?: number; body?: unknown; message?: unknown };
    const statusCode = failure?.statusCode ?? failure?.status;
    const message = String(failure?.body ?? failure?.message ?? error).slice(0, 500);
    if (statusCode === 410 || statusCode === 404) return { status: 'expired', statusCode, error: message };
    return { status: 'failed', statusCode, error: message };
  }
}
