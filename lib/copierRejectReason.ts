export type CopierRejectCategory = 'price-through' | 'dll' | 'tag' | 'unknown';

export interface CopierRejectReasonTranslation {
  category: CopierRejectCategory;
  message: string;
  original: string;
}

const UNKNOWN_REASON_MAX_LENGTH = 160;

const originalReason = (reason: string | undefined): string => (
  reason?.trim() || 'Broker odmítl příkaz bez uvedení důvodu'
);

const shorten = (value: string): string => (
  value.length <= UNKNOWN_REASON_MAX_LENGTH
    ? value
    : `${value.slice(0, UNKNOWN_REASON_MAX_LENGTH - 1).trimEnd()}…`
);

/**
 * Překládá pouze známé stabilní broker rejecty. Originál vrací odděleně,
 * aby ho UI mohlo vždy zachovat v tooltipu a diagnostice.
 */
export function translateCopierRejectReason(reason?: string): CopierRejectReasonTranslation {
  const original = originalReason(reason);
  const normalized = original.replace(/\s+/g, ' ');
  if (/outside\s+(?:the\s+)?price\s+limits?/i.test(normalized)) {
    return {
      category: 'price-through',
      message: 'Stop/limit odmítnut: cena už byla za zadanou úrovní',
      original,
    };
  }
  if (/daily\s*loss|loss\s*limit|\bdll\b/i.test(normalized)) {
    return {
      category: 'dll',
      message: 'Denní limit ztráty (DLL) — účet uzamčen do konce session',
      original,
    };
  }
  if (/unregist(?:er)?ed\s+tag\s*50|custom\s*tag\s*50|customtag50|\btag\s*50\b/i.test(normalized)) {
    return {
      category: 'tag',
      message: 'Interní značka příkazu nebyla brokerem přijata',
      original,
    };
  }
  return { category: 'unknown', message: shorten(normalized), original };
}
