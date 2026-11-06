/**
 * Návrat appky z pozadí: dokud nepřijde první nová živá cena, je na obrazovce starý stav. Telefon v pozadí
 * neběží, takže okamžitě správně to být nemůže; musí to ale být vidět. Jen zobrazení, nic neautorizuje (INV-UI-01).
 */
export const LIVE_RESUME_MIN_HIDDEN_MS = 3_000;
/** Bez ceny (zavřený trh, výpadek) se značka po této době sundá, graf hlásí stav dat sám. */
export const LIVE_RESUME_MAX_MS = 10_000;

export interface LiveResumeState {
  hiddenAt: number | null;
  /** Čeká se na první cenu přijatou po návratu. */
  resuming: { since: number } | null;
}

export const LIVE_RESUME_IDLE: LiveResumeState = { hiddenAt: null, resuming: null };

export function liveResumeOnForeground(state: LiveResumeState, foreground: boolean, now: number): LiveResumeState {
  if (!foreground) return { hiddenAt: state.hiddenAt ?? now, resuming: null };
  if (state.hiddenAt == null) return state;
  return { hiddenAt: null, resuming: now - state.hiddenAt >= LIVE_RESUME_MIN_HIDDEN_MS ? { since: now } : null };
}

/** Cena přijatá až po návratu (`tickAt`) nebo vypršení značku sundá; cena sprzed pozadí ne. */
export function liveResumeOnTick(state: LiveResumeState, now: number, tickAt: number | null): LiveResumeState {
  if (!state.resuming) return state;
  if ((tickAt != null && tickAt >= state.resuming.since) || now - state.resuming.since >= LIVE_RESUME_MAX_MS) return { ...state, resuming: null };
  return state;
}

/** Jak dlouho bez nové ceny v otevřené seanci ukázat „Živá cena teď nechodí“. Jen text, nic neautorizuje. */
export const LIVE_NO_PRICE_NOTICE_MS = 5_000;

export function liveNoPriceNotice(input: { lastPriceAt: number; now: number; resuming: boolean; sessionOpen: boolean }): boolean {
  return !input.resuming && input.sessionOpen && input.now - input.lastPriceAt >= LIVE_NO_PRICE_NOTICE_MS;
}
