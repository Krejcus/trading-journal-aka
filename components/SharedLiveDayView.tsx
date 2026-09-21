import React, { useEffect, useState } from 'react';

import type { PublicLiveDayShare } from '../lib/liveDayShare';
import { loadPublicLiveDayShare } from '../services/liveDayShareService';
import AnimatedTradingBackground from './AnimatedTradingBackground';
import { LiveDayCard } from './LiveDayCard';

const SharedLiveDayView = ({ token }: { token: string }) => {
  const [snapshot, setSnapshot] = useState<PublicLiveDayShare | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void loadPublicLiveDayShare(token, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setSnapshot(value);
          setFailed(!value);
        }
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!snapshot) return;
    const root = document.documentElement;
    const wasLight = root.classList.contains('light-theme');
    const wasOled = root.classList.contains('oled-theme');
    root.classList.remove('light-theme', 'oled-theme');
    if (snapshot.theme === 'light') root.classList.add('light-theme');
    if (snapshot.theme === 'oled') root.classList.add('oled-theme');
    const oldTitle = document.title;
    document.title = `Karta dne · ${snapshot.owner.name} | AlphaTrade`;
    return () => {
      root.classList.remove('light-theme', 'oled-theme');
      if (wasLight) root.classList.add('light-theme');
      if (wasOled) root.classList.add('oled-theme');
      document.title = oldTitle;
    };
  }, [snapshot]);

  if (!snapshot && !failed) {
    return (
      <div role="status" className="grid min-h-screen place-items-center bg-[#020617] text-white">
        <img src="/logos/at_logo_light_clean.png" alt="Načítám AlphaTrade" className="h-20 w-20 animate-pulse object-contain" />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#020617] px-6 text-center text-white">
        <div>
          <img src="/logos/at_logo_light_clean.png" alt="AlphaTrade" className="mx-auto mb-5 h-16 w-16 object-contain" />
          <h1 className="text-xl font-black">Tato karta už není dostupná</h1>
          <p className="mt-2 text-sm text-slate-400">Odkaz je neplatný nebo jej autor zneplatnil.</p>
        </div>
      </div>
    );
  }

  const light = snapshot.theme === 'light';
  return (
    <main className={`relative min-h-screen w-full overflow-hidden ${light ? 'bg-slate-200' : 'bg-black'}`}>
      {/* Graf jede i ve světlém — ve variantě se světlou deskou a tmavšími
          svíčkami. Předtím se v něm vykresloval na černo, tak byl vypnutý. */}
      <AnimatedTradingBackground variant={light ? 'light' : 'dark'} />
      <div className="relative z-10 min-h-screen w-full overflow-y-auto px-4 py-8 sm:px-8">
        {/* Na veřejné stránce nic jiného není, takže karta smí být širší než
            v dialogu appky, kde soutěží s obsahem pod sebou. */}
        <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-[1060px] items-center justify-center">
          {/* `w-full` je nutné: karta je flex položka bez vlastní šířky, takže
              by se jinak smrskla na obsah a veřejná stránka by vypadala úzce. */}
          <div className="w-full"><LiveDayCard
            translucent
            summary={snapshot.summary}
            owner={snapshot.owner}
            tradeDate={snapshot.tradeDate}
            trades={snapshot.trades}
            losingTrades={snapshot.losingTrades}
            formatName={name => name}
          /></div>
        </div>
      </div>
    </main>
  );
};

export default SharedLiveDayView;
