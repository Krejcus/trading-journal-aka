/**
 * Text okamžité i watchdog notifikace o hraně DISARMED -> ARM. Samostatný
 * modul, aby ho mohl sdílet relay push i incident watchdog bez kruhového importu.
 */
export type CopierArmTransition = 'arm-started' | 'arm-ended';

/**
 * Věta do ARM notifikace, když ENTRY/EXIT snímky nejsou připravené. Bere
 * volný tvar heartbeatu (worker může být starší), proto nic nepředpokládá.
 * Vrací null, když jsou snímky vypnuté, připravené nebo stav neznáme.
 */
export function copierSnapshotArmWarning(snapshotHealth: unknown): string | null {
  if (!snapshotHealth || typeof snapshotHealth !== 'object' || Array.isArray(snapshotHealth)) return null;
  const health = snapshotHealth as { enabled?: unknown; state?: unknown; layoutName?: unknown };
  if (health.enabled !== true) return null;
  const layout = typeof health.layoutName === 'string' && health.layoutName ? health.layoutName : 'AlphaTrade Snapshoty';
  switch (health.state) {
    case 'cdp-offline':
      return 'Pozor: TradingView běží bez CDP, ENTRY/EXIT snímky se nepořídí. Obnov ho z LIVE (karta TradingView snímky).';
    case 'layout-missing':
      return `Pozor: v TradingView není otevřený layout „${layout}“, ENTRY/EXIT snímky se nepořídí.`;
    case 'capture-failed':
    case 'upload-failed':
      return 'Pozor: poslední ENTRY/EXIT snímek selhal, obchody se mohou ukládat bez grafu.';
    default:
      return null;
  }
}

export function copierArmNotification(
  transition: CopierArmTransition,
  snapshotHealth?: unknown,
): { title: string; body: string } {
  if (transition !== 'arm-started') {
    return {
      title: 'Copier: ARM skončil',
      body: 'Ostrý ARM už neplatí. Kopírování stojí.',
    };
  }
  const warning = copierSnapshotArmWarning(snapshotHealth);
  return {
    title: warning ? 'Copier: ARM aktivní bez snímků' : 'Copier: ARM aktivní',
    body: warning
      ? `Ostrý ARM je aktivní. ${warning}`
      : 'Ostrý ARM je aktivní. Kopírování je povolené do expirace session nebo ručního DISARM.',
  };
}
