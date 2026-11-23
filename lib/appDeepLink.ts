/** Odkaz do appky přes `?page=…` (nativní appka, upozornění). Jednorázový: po otevření se z URL smaže. */
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
}

const SUPPORTED_DEEP_LINK_PAGE_SET = new Set<string>(SUPPORTED_DEEP_LINK_PAGES);

export const appDeepLinkIntentFromSearch = (search: string): AppDeepLinkIntent | null => {
  const requestedPage = new URLSearchParams(search).get('page');
  if (!requestedPage || !SUPPORTED_DEEP_LINK_PAGE_SET.has(requestedPage)) return null;
  return { page: requestedPage as SupportedDeepLinkPage };
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
