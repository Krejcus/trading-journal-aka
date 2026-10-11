/**
 * Uložená skupina, kterou operátor smazal (11. 10. 2026): durable snapshot nese
 * značku přesně této skupiny. Worker ji pak nevaliduje proti OAuth a startuje
 * DISARMED bez skupiny; značka jiné skupiny (starý soubor) se ignoruje.
 */
export function isRetiredDurableGroup(
  persistedGroup: { id: string } | null | undefined,
  safety: { retiredGroup?: { groupId?: unknown; at?: unknown } | null } | null | undefined,
): boolean {
  // Stejný predikát jako bootstrap controlleru (ID + konečný čas).
  return persistedGroup != null && typeof safety?.retiredGroup?.groupId === 'string'
    && safety.retiredGroup.groupId === persistedGroup.id
    && typeof safety.retiredGroup.at === 'number' && Number.isFinite(safety.retiredGroup.at);
}
