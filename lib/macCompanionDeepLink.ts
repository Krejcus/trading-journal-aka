import { tradovateLiveTabFromSearch, type TradovateLiveTab } from './tradovateLiveTab';

export const MAC_COMPANION_PAIRING_INTENT = 'mac-companion-pairing';
export const MAC_COMPANION_PAIRING_SESSION_KEY = 'alphatrade.mac-companion-pairing-intent.v1';

const PAIRING_INTENT_PARAM = 'open';

export const SUPPORTED_DEEP_LINK_PAGES = [
  'dashboard',
  'history',
  'journal',
  'ai',
  'lab',
  'business',
  'live',
  'network',
  'accounts',
  'settings',
] as const;

export type SupportedDeepLinkPage = typeof SUPPORTED_DEEP_LINK_PAGES[number];

export interface AppDeepLinkIntent {
  page: SupportedDeepLinkPage;
  tab?: TradovateLiveTab;
}

const SUPPORTED_DEEP_LINK_PAGE_SET = new Set<string>(SUPPORTED_DEEP_LINK_PAGES);

export const isMacCompanionPairingSearch = (search: string): boolean => {
  const params = new URLSearchParams(search);
  if (params.get(PAIRING_INTENT_PARAM) === MAC_COMPANION_PAIRING_INTENT) return true;

  // Backward compatibility for AlphaTrade Status 0.2.0 already installed on Macs.
  return params.get('page') === 'live' && params.get('tab') === 'connections';
};

export const appDeepLinkIntentFromSearch = (search: string): AppDeepLinkIntent | null => {
  if (isMacCompanionPairingSearch(search)) {
    return { page: 'live', tab: 'connections' };
  }

  const requestedPage = new URLSearchParams(search).get('page');
  if (!requestedPage || !SUPPORTED_DEEP_LINK_PAGE_SET.has(requestedPage)) return null;

  const page = requestedPage as SupportedDeepLinkPage;
  return page === 'live'
    ? { page, tab: tradovateLiveTabFromSearch(search) }
    : { page };
};

export const consumeAppDeepLinkUrl = (href: string): string => {
  const url = new URL(href);
  const requestedPage = url.searchParams.get('page');
  if (requestedPage && SUPPORTED_DEEP_LINK_PAGE_SET.has(requestedPage)) {
    url.searchParams.delete('page');
    url.searchParams.delete('tab');
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
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
