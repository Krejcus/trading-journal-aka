export const MAC_COMPANION_PAIRING_INTENT = 'mac-companion-pairing';
export const MAC_COMPANION_PAIRING_SESSION_KEY = 'alphatrade.mac-companion-pairing-intent.v1';

const PAIRING_INTENT_PARAM = 'open';

export const isMacCompanionPairingSearch = (search: string): boolean => {
  const params = new URLSearchParams(search);
  if (params.get(PAIRING_INTENT_PARAM) === MAC_COMPANION_PAIRING_INTENT) return true;

  // Backward compatibility for AlphaTrade Status 0.2.0 already installed on Macs.
  return params.get('page') === 'live' && params.get('tab') === 'connections';
};

export const consumeMacCompanionPairingUrl = (href: string): string => {
  const url = new URL(href);
  url.searchParams.delete(PAIRING_INTENT_PARAM);

  // The legacy page/tab pair is itself the one-shot intent. Remove it after
  // opening the form so a later window focus cannot unexpectedly force LIVE.
  if (url.searchParams.get('page') === 'live' && url.searchParams.get('tab') === 'connections') {
    url.searchParams.delete('page');
    url.searchParams.delete('tab');
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
};

export const macCompanionPairingUrl = (origin: string): string => {
  const url = new URL('/', origin);
  url.searchParams.set(PAIRING_INTENT_PARAM, MAC_COMPANION_PAIRING_INTENT);
  return url.toString();
};
