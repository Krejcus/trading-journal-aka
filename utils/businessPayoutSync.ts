import type { BusinessPayout } from '../types';

const BINARY_FIELDS = new Set(['image', 'receipt_url']);

/**
 * LocalStorage je jen rychlá metadata cache. Payout proof může být několik MB
 * base64 a patří do Supabase/Storage, ne do omezené browserové kvóty.
 */
export function stripPayoutImagesForCache(items: BusinessPayout[]): BusinessPayout[] {
  return items.map(({ image: _image, ...payout }) => payout);
}

/**
 * Fingerprint pro cache-first business data. Binární obrázky záměrně ignoruje,
 * ale metadata (včetně accountId a snake_case updated_at z DB) porovnává.
 */
export function businessDataFingerprint(items: unknown[]): string {
  const normalized = items.map(item => {
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([key]) => !BINARY_FIELDS.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
    );
  });

  return JSON.stringify(normalized);
}

/** Vrátí kanonická data z DB a doplní do nich lokálně načtené screenshoty. */
export function mergePayoutImages(
  fresh: BusinessPayout[],
  local: BusinessPayout[]
): BusinessPayout[] {
  const localById = new Map(local.map(payout => [String(payout.id), payout]));
  const freshIds = new Set(fresh.map(payout => String(payout.id)));
  const usedLocalIds = new Set<string>();

  return fresh.map(payout => {
    const exact = localById.get(String(payout.id));
    if (exact?.image) {
      usedLocalIds.add(String(exact.id));
      return { ...payout, image: exact.image };
    }

    // Nová výplata má před insertem dočasné id. Spáruj ji jednou podle všech
    // stabilních finančních polí; existující UUID záznamy do heuristiky nepouštěj.
    const candidate = local.find(localPayout =>
      Boolean(localPayout.image)
      && !usedLocalIds.has(String(localPayout.id))
      && !freshIds.has(String(localPayout.id))
      && localPayout.accountId === payout.accountId
      && localPayout.date === payout.date
      && localPayout.amount === payout.amount
      && localPayout.grossAmount === payout.grossAmount
    );

    if (!candidate) return payout;
    usedLocalIds.add(String(candidate.id));
    return { ...payout, image: candidate.image };
  });
}
