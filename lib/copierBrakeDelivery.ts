export type CopierBrakeCommandType = 'disarm' | 'kill-switch' | 'lock-until-session-end';

export const isCopierBrakeCommandType = (type: string): type is CopierBrakeCommandType => (
  type === 'disarm' || type === 'kill-switch' || type === 'lock-until-session-end'
);

const brakeExpiryLabel = (expiresAt: string): string | null => {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
    : null;
};

export const copierBrakeQueuedMessage = (expiresAt: string): string => {
  const expiry = brakeExpiryLabel(expiresAt);
  return `Brzda čeká ve frontě workeru${expiry ? ` (platí do ${expiry})` : ''}. AlphaTrade dál sleduje stav; výsledek se zobrazí, až worker brzdu provede.`;
};

/**
 * Relay command is durably queued, not failed or outcome-unknown. The worker
 * may execute it until the server-provided expiry while the normal status poll
 * keeps the UI in sync.
 */
export class CopierBrakeQueuedError extends Error {
  constructor(
    public readonly commandType: CopierBrakeCommandType,
    public readonly expiresAt: string,
  ) {
    super(copierBrakeQueuedMessage(expiresAt));
    this.name = 'CopierBrakeQueuedError';
  }
}

export const isCopierBrakeQueuedError = (reason: unknown): reason is CopierBrakeQueuedError => (
  reason instanceof CopierBrakeQueuedError
);
