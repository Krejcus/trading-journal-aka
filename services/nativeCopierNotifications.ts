import { isNativeBuild } from '../utils/runtimeConfig';
import {
  cancelNativeNotification,
  scheduleNativeNotification,
} from './nativeNotifications';
import {
  planCopierNotifications,
  type CopierNotificationSnapshot,
  type CopierScheduledSlot,
} from './nativeCopierNotificationPlan';
import type { CopierControllerStatus } from './copierRuntimeController';

/**
 * Exekutor deterministických copier notifikací (viz plánovač).
 *
 * Sloty se drží v localStorage, protože naplánované lokální notifikace
 * přežijí restart appky — bez perzistence bychom po startu naplánovali
 * duplicitní „ARM vypršel". Kdo volá: LIVE UI při každé změně statusu
 * runtime (poll ~2 s). Mimo nativní build je vše no-op.
 */

const SLOTS_STORAGE_KEY = 'alphatrade-copier-notification-slots';

let previousSnapshot: CopierNotificationSnapshot | null = null;

function loadSlots(): CopierScheduledSlot[] {
  try {
    const raw = localStorage.getItem(SLOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CopierScheduledSlot =>
      !!item && typeof item === 'object'
      && typeof (item as CopierScheduledSlot).id === 'number'
      && typeof (item as CopierScheduledSlot).at === 'number'
      && typeof (item as CopierScheduledSlot).key === 'string');
  } catch {
    return [];
  }
}

function saveSlots(slots: readonly CopierScheduledSlot[]): void {
  try {
    localStorage.setItem(SLOTS_STORAGE_KEY, JSON.stringify(slots));
  } catch {
    // Storage nedostupné — příští sync sloty srovná znovu.
  }
}

function toSnapshot(status: CopierControllerStatus | null): CopierNotificationSnapshot | null {
  if (!status) return null;
  return {
    armed: status.armed,
    shadowMode: status.shadowMode,
    killSwitch: status.killSwitch,
    stuckOutbox: status.stuckOutbox,
    connected: status.connected,
    lastError: status.lastError,
    armExpiresAt: status.armExpiresAt ?? 0,
    entryCooldownUntil: status.entryCooldownUntil ?? 0,
    dayLockUntil: status.dayLockUntil ?? 0,
  };
}

export async function syncCopierNativeNotifications(
  status: CopierControllerStatus | null,
): Promise<void> {
  if (!isNativeBuild) return;
  const next = toSnapshot(status);
  // Výpadek statusu (poll hiccup) není DISARM — sloty nechat být.
  if (next == null) return;

  const slots = loadSlots();
  const plan = planCopierNotifications({
    previous: previousSnapshot,
    next,
    slots,
    now: Date.now(),
  });
  previousSnapshot = next;
  if (plan.cancel.length === 0 && plan.schedule.length === 0 && plan.fireNow.length === 0) return;

  const kept = slots.filter(slot => !plan.cancel.includes(slot.id));
  try {
    for (const id of plan.cancel) {
      await cancelNativeNotification(id).catch(() => undefined);
    }
    for (const planned of plan.schedule) {
      const id = await scheduleNativeNotification({
        title: planned.title,
        body: planned.body,
        delayMs: Math.max(1_000, planned.at - Date.now()),
        route: 'live',
        threadIdentifier: 'alphatrade-copier',
        actionType: 'risk',
      });
      kept.push({ key: planned.key, at: planned.at, id });
    }
    for (const immediate of plan.fireNow) {
      await scheduleNativeNotification({
        title: immediate.title,
        body: immediate.body,
        delayMs: 1_000,
        route: 'live',
        threadIdentifier: 'alphatrade-copier',
        actionType: 'risk',
      });
    }
  } catch {
    // Zamítnuté oprávnění nebo plugin chyba nesmí shodit LIVE UI.
  } finally {
    saveSlots(kept);
  }
}
