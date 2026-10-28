/**
 * Kdy vlákno ceny hlásí výpadek / návrat IBKR (oznámení na Macu, jen zobrazení).
 *
 * - Nové vlákno začíná ve stavu „neznámý“ a při prvním platném čtení pošle
 *   `up` — oznamovač tak zapomene starý výpadek i po restartu vlákna
 *   (`up` bez předchozího ohlášeného výpadku oznamovač ignoruje).
 * - `down` až po `IBKR_ALERT_AFTER_MS` bez platného čtení, a jen když je jasné,
 *   že jde o výpadek: problém spojení s Gateway (neběží, přihlášení jinde,
 *   ztráta spojení), nebo IBKR mlčí, zatímco záloha TradingView má živou cenu.
 *   Zavřený trh (noc, víkend, svátek) tak nehlásí nic.
 */

export const IBKR_ALERT_AFTER_MS = 60_000;

export interface IbkrAlertState {
  reported: 'unknown' | 'up' | 'down';
  downSince: number | null;
}

export const initialIbkrAlertState = (): IbkrAlertState => ({ reported: 'unknown', downSince: null });

/** Kódy Gateway, které znamenají ztrátu spojení (ne jen ticho trhu). */
const CONNECTION_LOST_CODES = new Set([1100, 1101, 2103, 2110, 10197]);

/** Problém spojení s Gateway podle stavu zdroje a posledního kódu. */
export const ibkrConnectionProblem = (state: string | null | undefined, code: number | null | undefined): boolean =>
  state === 'connecting' || state === 'paused' || state === 'stopped' || state === 'off' || state == null
  || (code != null && CONNECTION_LOST_CODES.has(code));

export function nextIbkrAlert(state: IbkrAlertState, input: {
  available: boolean;
  connectionProblem: boolean;
  /** Záloha TV má právě živou cenu (`null` = neví se). */
  tvLive: boolean | null;
  at: number;
}): { state: IbkrAlertState; emit: 'up' | 'down' | null } {
  if (input.available) {
    return { state: { reported: 'up', downSince: null }, emit: state.reported === 'up' ? null : 'up' };
  }
  const downSince = state.downSince ?? input.at;
  const due = input.at - downSince >= IBKR_ALERT_AFTER_MS;
  if (due && state.reported !== 'down' && (input.connectionProblem || input.tvLive === true)) {
    return { state: { reported: 'down', downSince }, emit: 'down' };
  }
  return { state: { reported: state.reported, downSince }, emit: null };
}

/** Vlákno potřebuje vědět, zda má TV živou cenu, jen když výpadek trvá a nejde o spojení. */
export const ibkrAlertNeedsTvCheck = (state: IbkrAlertState, available: boolean, connectionProblem: boolean, at: number): boolean =>
  !available && !connectionProblem && state.reported !== 'down' && state.downSince !== null && at - state.downSince >= IBKR_ALERT_AFTER_MS;
