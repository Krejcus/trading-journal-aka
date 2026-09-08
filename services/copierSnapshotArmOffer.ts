import type { CopierSnapshotHealth } from '../lib/localCopierAgentProtocol';

export interface SnapshotArmOffer {
  /** Věta pro dialog: co je špatně. */
  reason: string;
  /** `true` = restart TradingView s CDP problém řeší (worker to umí bezpečně). */
  repairable: boolean;
}

/**
 * Rozhodne, jestli má ARM LIVE nejdřív nabídnout opravu snímků. Vrací null,
 * když jsou snímky vypnuté, připravené, ještě se kontrolují nebo stav neznáme —
 * v těch případech se ARM nesmí zdržet. Čistá funkce nad napollovaným stavem.
 */
export function snapshotArmOffer(health: CopierSnapshotHealth | null | undefined): SnapshotArmOffer | null {
  if (!health || !health.enabled) return null;
  switch (health.state) {
    case 'cdp-offline':
      return {
        reason: 'TradingView běží bez CDP, ENTRY/EXIT snímky se nepořídí.',
        repairable: health.repairSupported === true,
      };
    case 'layout-missing':
      return {
        reason: health.chartIdConfigured
          ? `V TradingView není otevřený layout „${health.layoutName}“.`
          : `Layout „${health.layoutName}“ ještě není spárovaný.`,
        repairable: false,
      };
    case 'capture-failed':
    case 'upload-failed':
      return {
        reason: health.state === 'capture-failed'
          ? 'Poslední pořízení snímku selhalo.'
          : 'Poslední nahrání snímku selhalo.',
        repairable: false,
      };
    default:
      return null;
  }
}
