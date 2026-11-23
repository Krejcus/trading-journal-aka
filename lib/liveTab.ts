/** `chart` = živý graf přes celou obrazovku (jen desktop, výchozí po kliku na LIVE). */
/** `copier` = kopírka přes službu Rithmic (22. 11. 2026: zatím jen tvůj účet, kopírka ve službě se připravuje). */
export type LiveTabId = 'chart' | 'connections' | 'overview' | 'risk' | 'accounts' | 'orders' | 'events' | 'copier';

const LIVE_TABS = new Set<LiveTabId>([
  'chart',
  'connections',
  'overview',
  'risk',
  'accounts',
  'orders',
  'events',
  'copier',
]);

export const liveTabFromSearch = (search: string): LiveTabId => {
  const params = new URLSearchParams(search);
  if (params.get('open') === 'mac-companion-pairing') return 'connections';

  const requestedTab = params.get('tab');
  return requestedTab && LIVE_TABS.has(requestedTab as LiveTabId)
    ? requestedTab as LiveTabId
    : 'overview';
};

export const liveTabHref = (currentHref: string, tab: LiveTabId): string => {
  const url = new URL(currentHref);
  url.searchParams.set('page', 'live');
  url.searchParams.set('tab', tab);
  return `${url.pathname}${url.search}${url.hash}`;
};

/**
 * Smí se teď přepnout záložka LIVE? Při čekající změně konfigurace desk
 * záložky drží — kromě cesty na přehled z libovolné záložky: OFF, Kill a Flatten
 * jsou na Dashboardu a musí být dosažitelné vždy (INV-UI-02). Do grafu se
 * nevstupuje během zapínání kopírky, jeho vrstva by zakryla potvrzovací dialogy i přehled.
 */
export const liveTabNavigationAllowed = (
  current: LiveTabId,
  next: LiveTabId,
  state: { configMutationPending: boolean; armFlowActive: boolean },
): boolean => {
  if (next === 'overview') return true;
  if (next === 'chart' && (state.armFlowActive || state.configMutationPending)) return false;
  return !state.configMutationPending;
};

/**
 * Záložka při otevření LIVE: deep link (`requestedTab`) má přednost, na
 * desktopu pak graf (Filip 29. 10.: klik na LIVE = rovnou graf), jinak
 * záložka z adresy, výchozí přehled. Telefon a nativní aplikace graf nemají.
 */
export const initialLiveTab = (input: {
  requestedTab: LiveTabId | null;
  search: string;
  chartAvailable: boolean;
}): LiveTabId => {
  if (input.requestedTab && (input.requestedTab !== 'chart' || input.chartAvailable)) return input.requestedTab;
  if (input.chartAvailable) return 'chart';
  const fromSearch = liveTabFromSearch(input.search);
  return fromSearch === 'chart' ? 'overview' : fromSearch;
};
