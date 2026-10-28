import { isAppForeground, subscribeAppForeground } from '../lib/appForeground';
import { createTvPriceChannelClient, type TvPriceChannelStatus } from '../lib/tvPriceChannelClient';
import { TV_PRICE_EVENT, verifyTvPriceEnvelope, verifyTvPriceTrail } from '../lib/tvPriceMessage';
import { createTvPriceStore } from '../lib/tvPriceStore';
import { supabase } from './supabase';

/**
 * Jediná instance kanálu ceny z TradingView v aplikaci. Jen zobrazení
 * (INV-UI-04): importovat smí jen listová komponenta otevřeného P&L
 * (`components/LiveOpenPnlValue.tsx`) a LIVE desk, který předává grant
 * z přijaté odpovědi relaye. Hlídá `tests/tvPriceClientGuards.test.ts`.
 */

export const tvPriceStore = createTvPriceStore();

const presenceKey = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `tv-${Math.random().toString(36).slice(2)}`;
  }
};

export const tvPriceChannel = createTvPriceChannelClient({
  store: tvPriceStore,
  openChannel(topic, handlers) {
    const channel = supabase.channel(topic, {
      // Presence nese jen „dívám se na P&L“ — bez osobních údajů.
      config: { broadcast: { self: false, ack: false }, presence: { key: presenceKey(), enabled: true } },
    });
    try {
      channel.on('broadcast', { event: TV_PRICE_EVENT }, message => handlers.onMessage((message as { payload?: unknown }).payload));
      channel.subscribe(status => handlers.onStatus(status as TvPriceChannelStatus));
    } catch (error) {
      // Kanál už je zaregistrovaný: bez odebrání by téma zůstalo obsazené navždy.
      void supabase.removeChannel(channel).catch(() => undefined);
      throw error;
    }
    return {
      track: meta => channel.track(meta),
      untrack: () => channel.untrack(),
      close: () => supabase.removeChannel(channel),
    };
  },
  // Téma ještě registrované, nebo socket právě odpojuje (nový join by v tom okně nikdy neodešel).
  topicBusy: topic => supabase.realtime.isDisconnecting()
    || supabase.getChannels().some(channel => channel.topic === `realtime:${topic}`),
  releaseTopic: topic => {
    for (const channel of supabase.getChannels().filter(item => item.topic === `realtime:${topic}`)) {
      void supabase.removeChannel(channel).catch(() => undefined);
      // Odchod skončil chybou bez zavření: vyřadit ze seznamu klienta (jinak by téma drželo navždy).
      (supabase.realtime as unknown as { _remove?: (item: unknown) => void })._remove?.(channel);
    }
  },
  verify: verifyTvPriceEnvelope,
  verifyTrail: verifyTvPriceTrail,
  hasWebCrypto: () => typeof globalThis.crypto?.subtle?.verify === 'function',
  isForeground: isAppForeground,
  subscribeForeground: subscribeAppForeground,
});
