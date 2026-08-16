/**
 * Krátké deterministické klíče pro brokerové tagy.
 *
 * `customTag50` má omezenou délku, takže se do něj plné `groupId` a
 * `leaderEventId` nevejdou — obojí může být UUID. Klíč se proto skládá
 * z krátkého prefixu a hashe, ne ze zřetězených identifikátorů.
 *
 * Hash musí být čistá funkce vstupu: po restartu se počítá znovu a musí
 * vyjít stejný, jinak ztratí smysl.
 */

/** Konzervativní strop podle názvu pole `customTag50`. */
export const BROKER_TAG_MAX_LENGTH = 50;

/**
 * FNV-1a, 32 bitů. Není kryptografický a nemá být — potřebujeme jen
 * stabilní, krátký a rychlý otisk. Kolize řešíme tím, že hashujeme
 * plný klíč včetně všech složek.
 */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

/**
 * Delší otisk pro případy, kde nám 32 bitů nestačí. Dvě nezávislá
 * FNV kola nad různě osolenými vstupy.
 */
export function stableHash64(value: string): string {
  return `${stableHash(value)}${stableHash(`\u0001${value}`)}`;
}

export type ReplicationKind = 'cp' | 'rc' | 'fl';

/**
 * Tag pro brokera. Vejde se do `BROKER_TAG_MAX_LENGTH` bez ohledu na
 * délku vstupů.
 */
export function brokerTag(
  kind: ReplicationKind,
  groupId: string,
  eventId: string,
  accountId: number,
): string {
  const tag = `${kind}${stableHash64(`${groupId}\u0000${eventId}\u0000${accountId}`)}`;
  if (tag.length > BROKER_TAG_MAX_LENGTH) {
    throw new Error(`brokerTag přesáhl ${BROKER_TAG_MAX_LENGTH} znaků: ${tag.length}`);
  }
  return tag;
}

/**
 * Vnitřní klíč replikace.
 *
 * Na rozdíl od `brokerTag()` je čitelný a nemá délkový limit — používá se
 * v našem stavu, outboxu a auditu, kde je čitelnost cennější než délka.
 */
export function replicationKey(
  kind: ReplicationKind,
  groupId: string,
  eventId: string,
  accountId: number,
): string {
  return `${kind}:${groupId}:${eventId}:${accountId}`;
}
