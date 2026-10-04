import { supabase } from './supabase';

/*
 * Důkazy výplat v soukromém bucketu `payout-proofs` (složka = uživatel).
 * Řádek výplaty drží jen cestu `imagePath`; appka zobrazuje krátkodobé
 * podepsané odkazy. Dřív byl screenshot base64 přímo v `description` (až 2 MB
 * na řádek) a každé načtení výplat táhlo desítky MB → po restartu databáze
 * dotazy padaly na statement timeout.
 */

export const PAYOUT_PROOF_BUCKET = 'payout-proofs';
/** Podepsaný odkaz platí 12 h; prefetch se opakuje při návratu do Byznysu. */
const SIGNED_URL_TTL_S = 60 * 60 * 12;

export const isDataUrl = (value: unknown): value is string => typeof value === 'string' && value.startsWith('data:');

const EXT_BY_TYPE: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export function dataUrlToBlob(dataUrl: string): { blob: Blob; type: string; ext: string } {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new Error('Neplatný obrázek důkazu výplaty.');
  const type = (match[1] || 'image/png').toLowerCase();
  const ext = EXT_BY_TYPE[type];
  if (!ext) throw new Error(`Nepodporovaný formát důkazu (${type}).`);
  const payload = match[3];
  let bytes: Uint8Array;
  if (match[2]) {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return { blob: new Blob([bytes], { type }), type, ext };
}

/** Nahraje důkaz a vrátí jeho cestu v bucketu. */
export async function uploadPayoutProof(userId: string, dataUrl: string): Promise<string> {
  const { blob, type, ext } = dataUrlToBlob(dataUrl);
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(PAYOUT_PROOF_BUCKET).upload(path, blob, { contentType: type, upsert: false });
  if (error) throw new Error(`Důkaz výplaty se nepodařilo nahrát: ${error.message}`);
  return path;
}

/** Podepsané odkazy k cestám (cesta → URL). Chybějící soubor se vynechá. */
export async function signPayoutProofs(paths: readonly string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return result;
  const { data, error } = await supabase.storage.from(PAYOUT_PROOF_BUCKET).createSignedUrls(unique, SIGNED_URL_TTL_S);
  if (error) throw new Error('Failed to sign payout proofs');
  (data || []).forEach(item => { if (item.path && item.signedUrl && !item.error) result.set(item.path, item.signedUrl); });
  return result;
}

/** Úklid po smazání / výměně důkazu — nevadí, když selže (soubor jen zůstane). */
export async function removePayoutProofs(paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return;
  await supabase.storage.from(PAYOUT_PROOF_BUCKET).remove(unique).catch(() => undefined);
}
