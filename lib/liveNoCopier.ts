import type { LiveTradingCopierState } from '../components/LiveTradingScreen';
import type { LivePhoneCopierChip } from './livePhoneCopierChip';

/**
 * Od 23. 11. 2026 v appce žádná Tradovate kopírka není. Sdílené LIVE komponenty pořád čekají
 * stav kopírky, tak dostanou tento prázdný: nic nedostupné, nic nečeká, nic k přihlášení.
 * Rithmic graf běží v sólo režimu, akce řídí jeho vlastní stav (`solo.available`).
 */
export const NO_LIVE_COPIER: LiveTradingCopierState = {
  status: null,
  available: false,
  pending: false,
  transport: null,
  journalHealth: null,
  reconnectRequired: 0,
};

/** Čip kopírky v telefonní hlavičce: v klidu a s `hideCopier` se nekreslí. */
export const NO_PHONE_COPIER_CHIP: LivePhoneCopierChip = { label: 'Kopírka', tone: 'muted', armed: false };
