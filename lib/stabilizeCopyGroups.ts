import type { CopyGroupConfig } from '../services/liveCopyTrading';

/** Compare all fields, including future safety settings, without normalizing defaults. */
function sameConfigValue(previous: unknown, incoming: unknown): boolean {
  if (Object.is(previous, incoming)) return true;
  if (previous === null || incoming === null
    || typeof previous !== 'object' || typeof incoming !== 'object') return false;

  const previousIsArray = Array.isArray(previous);
  if (previousIsArray !== Array.isArray(incoming)) return false;
  if (previousIsArray) {
    if (previous.length !== (incoming as unknown[]).length) return false;
  } else {
    // Configuration is plain data. Treat unfamiliar object types conservatively.
    const previousPrototype = Object.getPrototypeOf(previous);
    const incomingPrototype = Object.getPrototypeOf(incoming);
    if (previousPrototype !== incomingPrototype
      || (previousPrototype !== Object.prototype && previousPrototype !== null)) return false;
  }

  const previousFields = previous as Record<string, unknown>;
  const incomingFields = incoming as Record<string, unknown>;
  const keys = Object.keys(previousFields);
  return keys.length === Object.keys(incomingFields).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(incomingFields, key)
      && sameConfigValue(previousFields[key], incomingFields[key]));
}

/**
 * Stabilize only editable configuration after snapshot/runtime adoption. Live
 * account data, runtime status and their freshness timestamps remain independent.
 */
export function stabilizeCopyGroups(
  previous: CopyGroupConfig[],
  incoming: CopyGroupConfig[],
): CopyGroupConfig[] {
  return sameConfigValue(previous, incoming) ? previous : incoming;
}
