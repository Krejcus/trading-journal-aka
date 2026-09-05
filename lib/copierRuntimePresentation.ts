import type { CopierControllerStatus } from '../services/copierRuntimeController';

export interface CopierRuntimePresentation {
  key: 'unknown' | 'offline' | 'locked' | 'paused' | 'disarmed' | 'shadow' | 'blocked' | 'copying';
  label: string;
  detail: string;
  copying: boolean;
}

/** Display only. A saved group or an old controller snapshot never proves execution. */
export const copierRuntimePresentation = (
  status: CopierControllerStatus | null | undefined,
  runtimeAvailable: boolean,
  now: number,
): CopierRuntimePresentation => {
  const stopped = (key: CopierRuntimePresentation['key'], label: string, detail: string): CopierRuntimePresentation => (
    { key, label, detail, copying: false }
  );
  if (!runtimeAvailable || !status) return stopped('unknown', 'Stav neověřen', 'Aktuální stav workeru není dostupný.');
  if (!status.started || !status.connected) return stopped('offline', 'Odpojeno', 'Spojení workeru s brokerem není aktivní.');
  if ((status.dayLockUntil ?? 0) > now) return stopped('locked', 'Zámek dne', 'Nové vstupy se nekopírují.');
  if (status.pause && status.pause.until > now) return stopped('paused', 'Pauza', 'Nové vstupy se nekopírují.');
  if (status.killSwitch || status.reconciliationRequired || status.stuckOutbox || status.divergentAccounts.length > 0) {
    return stopped('blocked', 'Kopírování blokováno', 'Worker vyžaduje kontrolu stavu.');
  }
  if (!status.armed || ((status.armExpiresAt ?? 0) > 0 && status.armExpiresAt! <= now)) {
    return stopped('disarmed', 'Kopírka vypnutá', 'Účet je nastaven pro kopírování; nové vstupy se nekopírují.');
  }
  if (status.shadowMode) return stopped('shadow', 'Simulace', 'Ostré vstupy se nekopírují.');
  if (status.dailyStats?.windowState === 'outside') return stopped('blocked', 'Mimo obchodní okno', 'Nové vstupy se nekopírují.');
  return { key: 'copying', label: 'Kopíruje', detail: '', copying: true };
};
