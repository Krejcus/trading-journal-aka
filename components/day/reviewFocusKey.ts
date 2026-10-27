/**
 * Klíč přesunu záběru: mění se jen akcí uživatele (režim, část dne, výběr
 * obchodu), nikdy během času. U dneška se výchozí úsek posouvá s `now`
 * (`focusRange`) — kdyby byl v klíči, graf by se každou minutu vrátil na
 * výchozí záběr a zahodil uživatelův posun nebo zoom.
 */
export const reviewFocusKey = (prefix: string, selectedTradeId?: string | number | null): string =>
  (selectedTradeId != null ? `trade:${selectedTradeId}` : prefix);
