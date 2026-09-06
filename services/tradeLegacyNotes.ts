import type { Trade } from '../types';
export const LEGACY_TRADE_NOTE_FIELDS = ['notes', 'sessionPreNotes', 'sessionPostNotes'] as const;
export type LegacyTradeNotes = Pick<Trade, typeof LEGACY_TRADE_NOTE_FIELDS[number]>;
export const TRADE_NOTE_PROJECTION_RPC = 'get_trade_note_projection_v1';
export const CONNECTION_NOTE_CONSENT_RPC = 'get_connection_trade_note_consent_v1';
export const CONFIRM_CONNECTION_NOTES_RPC = 'confirm_connection_trade_notes_v1';
export const NOTE_SHARING_NOT_READY = 'Serverová ochrana sdílení poznámek zatím není aktivovaná. Potvrzení nyní není dostupné.';
type RpcClient = { rpc: (name: string, args: Record<string, unknown>) => any };
export const stripLegacyTradeNotes = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(stripLegacyTradeNotes) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !(LEGACY_TRADE_NOTE_FIELDS as readonly string[]).includes(key))
    .map(([key, child]) => [key, stripLegacyTradeNotes(child)])) as T;
};
const missing = (error: any) => ['PGRST202', '42883'].includes(String(error?.code));
const fields = (value: unknown): Partial<LegacyTradeNotes> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Server vrátil neplatný formát poznámek.');
  const result: Record<string, unknown> = {};
  for (const key of LEGACY_TRADE_NOTE_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const note = (value as Record<string, unknown>)[key];
    if (note !== null && typeof note !== 'string') throw new Error('Poznámka má starší nestandardní formát. Původní hodnota zůstala v soukromém úložišti pro obnovu.');
    result[key] = note;
  }
  return result as Partial<LegacyTradeNotes>;
};

/** Server is the authority for connection/public consent. On older servers an
 * owner's existing note remains readable; foreign note caches are never trusted. */
export const hydrateLegacyTradeNotes = async <T extends { id: string | number }>(
  client: RpcClient, trades: T[], context: 'owner' | 'connection', stillCurrent: () => boolean | Promise<boolean>,
): Promise<T[]> => {
  if (!trades.length) return trades;
  const clean = trades.map(stripLegacyTradeNotes);
  const ids = [...new Set(trades.map(t => String(t.id)))];
  const notes = new Map<string, Partial<LegacyTradeNotes>>();
  for (let index = 0; index < ids.length; index += 100) {
    if (!await stillCurrent()) throw new Error('Účet se během načítání poznámek změnil.');
    const batch = ids.slice(index,index+100);
    const { data, error } = await client.rpc(TRADE_NOTE_PROJECTION_RPC, { p_trade_ids: batch, p_context: context });
    if (!await stillCurrent()) throw new Error('Účet se během načítání poznámek změnil.');
    if (error) {
      if (missing(error)) return context === 'owner' ? trades : clean;
      throw new Error('Poznámky se nepodařilo bezpečně načíst. Obnovte data a zkuste to znovu.');
    }
    if (data?.version !== 1 || !Array.isArray(data.rows)) throw new Error('Server nepotvrdil bezpečné načtení poznámek.');
    for (const row of data.rows) if (batch.includes(String(row.tradeId))) notes.set(String(row.tradeId), fields(row.notes));
  }
  return clean.map(trade => ({ ...trade, ...notes.get(String(trade.id)) }));
};

export const tradeNotesStorageReady = async (client: RpcClient): Promise<boolean> => {
  const { data, error } = await client.rpc(TRADE_NOTE_PROJECTION_RPC, { p_trade_ids: [], p_context: 'owner' });
  if (error && missing(error)) return false;
  if (error || data?.version !== 1 || !Array.isArray(data.rows)) throw new Error('Dostupnost úložiště poznámek se nepodařilo ověřit. Obchody nebyly odeslány.');
  return true;
};

/** Embedded owner relation from INSERT/UPDATE RETURNING; the server's trigger
 * has already atomically committed this field, including explicit null/empty. */
export const privateNotesFromSavedRow = (row: { privateNotes?: unknown }): Partial<LegacyTradeNotes> => {
  const relation = Array.isArray(row.privateNotes) ? row.privateNotes[0] : row.privateNotes;
  if (relation == null) return {};
  return fields((relation as { notes?: unknown }).notes);
};
export interface ConnectionTradeNoteConsent { version: 1; confirmed: boolean; enabled: boolean; }
const consentResult = (data: any): ConnectionTradeNoteConsent => {
  if (data?.version !== 1 || typeof data.confirmed !== 'boolean' || typeof data.enabled !== 'boolean') throw new Error('Server nepotvrdil nastavení sdílení poznámek.');
  return data;
};
export const readConnectionTradeNoteConsent = async (client: RpcClient, connectionId: string, permissions?: Record<string, unknown>): Promise<ConnectionTradeNoteConsent> => {
  const { data, error } = await client.rpc(CONNECTION_NOTE_CONSENT_RPC, { p_connection_id: connectionId, p_expected_permissions: permissions ?? null });
  if (error) throw new Error(missing(error) ? NOTE_SHARING_NOT_READY : 'Potvrzení sdílení poznámek se nepodařilo načíst.');
  return consentResult(data);
};
export const confirmConnectionTradeNotes = async (client: RpcClient, connectionId: string, permissions: Record<string, unknown>, accept = false): Promise<ConnectionTradeNoteConsent> => {
  const { data, error } = await client.rpc(CONFIRM_CONNECTION_NOTES_RPC, { p_connection_id: connectionId, p_expected_permissions: permissions, p_accept: accept });
  if (error) throw new Error(missing(error) ? NOTE_SHARING_NOT_READY : error.code === '40001' ? 'Nastavení mezitím změnilo jiné okno. Zavřete dialog, obnovte spojení a rozsah znovu zkontrolujte.' : 'Sdílení poznámek nebylo potvrzeno. Obnovte data a zkuste to znovu.');
  return consentResult(data);
};
