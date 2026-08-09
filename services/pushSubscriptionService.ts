// ============================================================================
// Push subscription registry
// ----------------------------------------------------------------------------
// Odběr push notifikací žije v tabulce `push_subscriptions`, jeden řádek =
// jedno zařízení. Dřív to byl jediný objekt v `profiles.preferences`, takže
// druhé zařízení přepsalo první a alerty chodily náhodně jen na jedno z nich.
//
// Endpoint se u prohlížečů občas otočí (na iOS ho systém po nečinnosti zahodí
// úplně). Proto si poslední známý endpoint držíme v localStorage — je to jediný
// způsob, jak po rotaci poznat, který řádek v DB patřil tomuhle zařízení, a
// uklidit ho.
// ============================================================================

import { supabase } from './supabase';
import { getUserId } from './storageService';
import { subscribeUserToPush } from '../utils/pushManager';
import { isPWA, isIOS } from '../utils/notificationHelper';

const LAST_ENDPOINT_KEY = 'alphatrade_push_endpoint';

export interface PushDevice {
  id: string;
  endpoint: string;
  userAgent: string | null;
  isStandalone: boolean | null;
  platform: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiredAt: string | null;
  /** True pro zařízení, na kterém právě běžíme. */
  isCurrent: boolean;
}

const readLastEndpoint = (): string | null => {
  try {
    return localStorage.getItem(LAST_ENDPOINT_KEY);
  } catch {
    return null;
  }
};

const writeLastEndpoint = (endpoint: string | null) => {
  try {
    if (endpoint) localStorage.setItem(LAST_ENDPOINT_KEY, endpoint);
    else localStorage.removeItem(LAST_ENDPOINT_KEY);
  } catch {
    /* Safari private mode — bez cache to jen znamená, že po rotaci zůstane
       osiřelý řádek, který cron uklidí sám při prvním 410. */
  }
};

const describeDevice = () => ({
  user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
  is_standalone: isPWA(),
  platform: isIOS() ? 'ios' : (typeof navigator !== 'undefined' ? navigator.platform || null : null),
});

export interface PushSubscriptionRow {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expired_at: null;
  last_error: null;
}

/**
 * Převede `PushSubscription.toJSON()` na řádek do `push_subscriptions`.
 * Vrací null, když odběr nemá endpoint nebo některý z klíčů — takový řádek by
 * v DB jen tiše seděl a `webpush.sendNotification` by na něm padal.
 *
 * `expired_at`/`last_error` se nulují záměrně: když endpoint dřív vypadl (410)
 * a teď zase žije, musí ho cron začít znovu obsluhovat.
 */
export const buildSubscriptionRow = (
  userId: string,
  subscriptionJson: any
): PushSubscriptionRow | null => {
  const endpoint = subscriptionJson?.endpoint;
  const p256dh = subscriptionJson?.keys?.p256dh;
  const auth = subscriptionJson?.keys?.auth;

  if (!userId) return null;
  if (typeof endpoint !== 'string' || !endpoint) return null;
  if (typeof p256dh !== 'string' || !p256dh) return null;
  if (typeof auth !== 'string' || !auth) return null;

  return { user_id: userId, endpoint, p256dh, auth, expired_at: null, last_error: null };
};

/**
 * Uloží (nebo obnoví) odběr pro aktuální zařízení. Vrací endpoint, nebo null
 * když push není k dispozici — na iOS typicky proto, že appka neběží jako PWA
 * přidaná na plochu.
 */
export const savePushSubscription = async (subscriptionJson: any): Promise<string | null> => {
  const userId = await getUserId();
  if (!userId) return null;

  const row = buildSubscriptionRow(userId, subscriptionJson);
  if (!row) {
    console.warn('[Push] Subscription bez endpointu nebo klíčů, neukládám.');
    return null;
  }

  const { endpoint } = row;
  const previousEndpoint = readLastEndpoint();

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        ...row,
        ...describeDevice(),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' }
    );

  if (error) {
    console.error('[Push] Uložení odběru selhalo:', error.message);
    return null;
  }

  // Endpoint se otočil — starý řádek už nikdy nic nedoručí, ať nezabírá místo
  // a neplete diagnostiku v Settings.
  if (previousEndpoint && previousEndpoint !== endpoint) {
    await supabase.from('push_subscriptions').delete().eq('endpoint', previousEndpoint);
  }

  writeLastEndpoint(endpoint);
  return endpoint;
};

/**
 * Vyžádá si povolení a zaregistruje odběr. Volá se z tlačítka v Settings —
 * `Notification.requestPermission()` musí běžet z user gesture, jinak ho
 * Safari zahodí.
 */
export const enablePush = async (): Promise<{ ok: boolean; reason?: string }> => {
  if (typeof Notification === 'undefined') {
    return { ok: false, reason: 'unsupported' };
  }
  if (isIOS() && !isPWA()) {
    // iOS dává PushManager jen web appce přidané na plochu. Bez toho selže až
    // subscribe() a uživatel by nevěděl proč.
    return { ok: false, reason: 'ios-needs-standalone' };
  }

  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'denied' };
  }

  const subscription = await subscribeUserToPush();
  if (!subscription) {
    return { ok: false, reason: 'subscribe-failed' };
  }

  const endpoint = await savePushSubscription(subscription);
  return endpoint ? { ok: true } : { ok: false, reason: 'save-failed' };
};

/**
 * Levná synchronní indicie, že tohle zařízení má registrovaný odběr. Používá
 * se jen k tomu, aby appka hned po startu (než doběhne `syncPushSubscription`)
 * neposlala lokální notifikaci navrch té serverové.
 */
export const hasLocalPushEndpoint = (): boolean => {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  return !!readLastEndpoint();
};

/**
 * Tichá kontrola při startu appky. iOS odběry po delší nečinnosti nebo po
 * aktualizaci systému zahazuje — tohle je jediné místo, kde se to dá zjistit
 * a napravit.
 *
 * Vrací true, pokud má tohle zařízení živý registrovaný odběr (tj. alerty
 * doručuje server a appka je nemá posílat lokálně).
 */
export const syncPushSubscription = async (): Promise<boolean> => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;

    const current = await registration.pushManager.getSubscription();

    if (!current) {
      // Odběr zmizel, ale povolení pořád platí → obnovíme bez ptaní.
      console.log('[Push] Odběr zmizel, obnovuji…');
      const fresh = await subscribeUserToPush();
      if (!fresh) return false;
      return !!(await savePushSubscription(fresh));
    }

    const json = current.toJSON();
    const knownEndpoint = readLastEndpoint();

    if (json.endpoint !== knownEndpoint) {
      return !!(await savePushSubscription(json));
    }

    // Endpoint sedí — jen razítko, ať je v Settings vidět, že zařízení žije.
    const userId = await getUserId();
    if (!userId || !json.endpoint) return false;
    const { error } = await supabase
      .from('push_subscriptions')
      .update({ last_seen_at: new Date().toISOString(), expired_at: null, last_error: null })
      .eq('endpoint', json.endpoint);
    return !error;
  } catch (err) {
    console.error('[Push] Sync odběru selhal:', err);
    return false;
  }
};

/** Odhlásí odběr na tomhle zařízení a smaže jeho řádek. */
export const disablePush = async (): Promise<void> => {
  const endpoint = readLastEndpoint();

  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const current = await registration?.pushManager.getSubscription();
    if (current) await current.unsubscribe();
  } catch (err) {
    // Odhlášení v prohlížeči selhalo — řádek smažeme tak jako tak, ať uživateli
    // nic nechodí. Osiřelý odběr v push službě vyprší sám.
    console.warn('[Push] Unsubscribe selhal, mažu jen záznam:', err);
  }

  if (endpoint) {
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  }
  writeLastEndpoint(null);
};

/** Seznam zařízení pro diagnostiku v Settings. */
export const listPushDevices = async (): Promise<PushDevice[]> => {
  const userId = await getUserId();
  if (!userId) return [];

  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, user_agent, is_standalone, platform, created_at, last_seen_at, expired_at')
    .eq('user_id', userId)
    .order('last_seen_at', { ascending: false });

  if (error) {
    console.error('[Push] Načtení zařízení selhalo:', error.message);
    return [];
  }

  const currentEndpoint = readLastEndpoint();
  return (data || []).map(row => ({
    id: row.id,
    endpoint: row.endpoint,
    userAgent: row.user_agent,
    isStandalone: row.is_standalone,
    platform: row.platform,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiredAt: row.expired_at,
    isCurrent: !!currentEndpoint && row.endpoint === currentEndpoint,
  }));
};
