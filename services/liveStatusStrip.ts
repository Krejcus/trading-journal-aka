import type { CopierControllerStatus } from './copierRuntimeController';
import { isRecentCopierDisarm } from '../lib/copierDisarmNotice';
import type { CopierSnapshotHealth } from '../lib/localCopierAgentProtocol';

export type LiveStatusTone = 'muted' | 'ok' | 'warn' | 'danger';

export interface LiveStatusChip {
  id: 'worker' | 'broker' | 'copier' | 'snapshots';
  label: string;
  value: string;
  tone: LiveStatusTone;
  /** Delší vysvětlení do tooltipu; v liště se nezobrazuje. */
  title?: string;
}

export interface LiveStatusStripModel {
  chips: LiveStatusChip[];
  /** Jediná akce lišty: bezpečný restart TradingView, když vypadlo CDP. */
  repairSnapshots: boolean;
  /**
   * Jediná věta pod chipy. Jen pro stav, který nesmí zapadnout: kopie po
   * automatickém vypnutí zůstaly otevřené bez ochrany nebo neověřené.
   */
  notice: string | null;
}

export interface LiveStatusStripInput {
  status: CopierControllerStatus | null;
  available: boolean;
  pending: boolean;
  transport: 'local' | 'relay' | null;
  snapshotHealth?: CopierSnapshotHealth | null;
  now?: number;
}

/** Jedna věta ke stavu snímků; sdílí ji lišta (tooltip) i záložka Události. */
export const snapshotHealthMessage = (health: CopierSnapshotHealth): string => {
  if (!health.enabled || health.state === 'disabled') return 'Automatické snímky jsou vypnuté.';
  if (health.state === 'checking') return 'Kontroluji TradingView a vyhrazený layout…';
  if (health.state === 'cdp-offline') return 'TradingView není připojené přes CDP. Obchod proběhne, ale graf se neuloží.';
  if (health.state === 'layout-missing') {
    return health.chartIdConfigured
      ? `Otevři v TradingView vyhrazený layout „${health.layoutName}“.`
      : `Vyhrazený layout „${health.layoutName}“ ještě není spárovaný.`;
  }
  if (health.state === 'capture-failed') return 'Layout je dostupný, poslední pořízení snímku ale selhalo.';
  if (health.state === 'upload-failed') return 'Graf se podařilo vyfotit, ale poslední nahrání selhalo.';
  return `Layout „${health.layoutName}“ je připravený pro ENTRY/EXIT.`;
};

const copierValue = (current: CopierControllerStatus, now: number): { value: string; tone: LiveStatusTone; title?: string } => {
  if (current.killSwitch) return { value: 'Nouzově zastavená', tone: 'danger' };
  if ((current.dayLockUntil ?? 0) > now) return { value: 'Zámek dne', tone: 'warn' };
  if (!current.armed) {
    const last = current.lastDisarm;
    if (last && last.trigger !== 'manual' && isRecentCopierDisarm(last.at, now)) {
      return { value: 'Vypnuta automaticky', tone: 'warn', title: `${last.title} ${last.nextStep}` };
    }
    return { value: 'Vypnutá', tone: 'muted' };
  }
  if (current.pause && current.pause.until > now) return { value: 'Pauza', tone: 'warn' };
  if (current.shadowMode) return { value: 'Pouze sledování', tone: 'ok' };
  return { value: 'Zapnutá', tone: 'ok' };
};

/**
 * Model stavové lišty LIVE: čtyři chipy, žádné karty. Zdravý stav je šedý a
 * tichý; problém zbarví jen svůj chip a vysvětlení nese tooltip. Technický
 * detail (lastError, časy kontrol, historie odzbrojení) patří do Událostí.
 */
export function buildLiveStatusStrip(input: LiveStatusStripInput): LiveStatusStripModel {
  const now = input.now ?? Date.now();
  const current = input.available ? input.status : null;
  const chips: LiveStatusChip[] = [];

  if (input.pending) {
    chips.push({ id: 'worker', label: 'Worker', value: 'Načítání…', tone: 'muted' });
  } else if (!current) {
    chips.push({
      id: 'worker', label: 'Worker', value: 'Neověřeno', tone: 'warn',
      title: 'Stav workeru není ověřený. Zkontroluj, že Mac worker běží a má dostupné spojení.',
    });
  } else {
    // Oranžový chip musí sám říct proč: čekající ověření účtů blokuje ARM.
    chips.push(current.reconciliationRequired
      ? {
        id: 'worker', label: 'Worker', value: 'Čeká na ověření účtů', tone: 'warn',
        title: 'Worker ještě potřebuje ověřit stav účtů u brokera. Spusť Kontrolu pozic nebo počkej na reconciliation.',
      }
      : { id: 'worker', label: 'Worker', value: input.transport === 'local' ? 'Tento Mac' : 'Cloud', tone: 'muted' });
  }

  chips.push(!current
    ? { id: 'broker', label: 'Broker', value: 'Neověřeno', tone: 'muted' }
    : current.connected
      ? { id: 'broker', label: 'Broker', value: 'Připojený', tone: 'muted' }
      : {
        id: 'broker', label: 'Broker', value: 'Odpojený', tone: 'warn',
        title: 'Spojení workeru s Tradovate je přerušené. Před zapnutím musí worker obnovit spojení a ověřit účty.',
      });

  if (current) {
    const copier = copierValue(current, now);
    chips.push({ id: 'copier', label: 'Kopírka', ...copier });
  } else {
    chips.push({ id: 'copier', label: 'Kopírka', value: 'Neověřeno', tone: 'muted' });
  }

  const health = input.snapshotHealth;
  let repairSnapshots = false;
  if (health && health.enabled && health.state !== 'disabled') {
    const title = snapshotHealthMessage(health);
    switch (health.state) {
      case 'ready':
        chips.push({ id: 'snapshots', label: 'Snímky', value: 'Připravené', tone: 'muted', title });
        break;
      case 'checking':
        chips.push({ id: 'snapshots', label: 'Snímky', value: 'Kontrola…', tone: 'muted', title });
        break;
      case 'cdp-offline':
        repairSnapshots = health.repairSupported === true;
        chips.push({ id: 'snapshots', label: 'Snímky', value: 'TradingView bez CDP', tone: 'warn', title });
        break;
      case 'layout-missing':
        chips.push({ id: 'snapshots', label: 'Snímky', value: 'Chybí layout', tone: 'warn', title });
        break;
      default:
        chips.push({ id: 'snapshots', label: 'Snímky', value: 'Poslední snímek selhal', tone: 'warn', title });
    }
  }

  const last = current?.lastDisarm;
  const dangerous = Boolean(current && !current.armed && last && isRecentCopierDisarm(last.at, now) && last.trigger !== 'manual'
    && (last.copiesOutcome === 'left-open-unprotected' || last.copiesOutcome === 'unknown'));
  const notice = dangerous && last
    ? `Poslední zaznamenané vypnutí · ${new Date(last.at).toLocaleString('cs-CZ')} · ${last.title} Výsledek kopií při tomto incidentu nebyl potvrzený; nejde o ověření aktuálních pozic. ${last.nextStep}`
    : null;

  return { chips, repairSnapshots, notice };
}
