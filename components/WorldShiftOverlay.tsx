import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FlaskConical, Radio } from 'lucide-react';

// Časování přechodu „World Shift" (ms). Sdílené s App.tsx — App swapne dashboardMode
// přesně když clona plně zakrývá obrazovku (swapAt), pak overlay odmountuje (end).
export const WORLD_SHIFT_TIMING = { swapAt: 820, exitAt: 1080, end: 1980 };

interface Props {
  to: 'live' | 'backtest';
}

const WORLDS = {
  backtest: {
    grad: 'radial-gradient(circle at 12% 84%, #2e1065 0%, #4c1d95 40%, #0a0e17 100%)',
    iconBg: 'rgba(139,92,246,0.18)',
    iconColor: '#a78bfa',
    Icon: FlaskConical,
    title: 'BACKTEST LAB',
    titleColor: '#c4b5fd',
    sub: 'Vstupuješ do testovacího prostředí',
    subColor: 'rgba(196,181,253,0.75)',
  },
  live: {
    grad: 'radial-gradient(circle at 12% 84%, #064e3b 0%, #065f46 40%, #0a0e17 100%)',
    iconBg: 'rgba(16,185,129,0.18)',
    iconColor: '#34d399',
    Icon: Radio,
    title: 'LIVE TRADING',
    titleColor: '#6ee7b7',
    sub: 'Zpět k živému obchodování',
    subColor: 'rgba(110,231,183,0.75)',
  },
} as const;

const WorldShiftOverlay: React.FC<Props> = ({ to }) => {
  const w = WORLDS[to];
  const { Icon } = w;
  const [entered, setEntered] = useState(false);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    const t = window.setTimeout(() => setExiting(true), WORLD_SHIFT_TIMING.exitAt);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, []);

  const covering = entered && !exiting;

  // Origin clony = místo přepínače: desktop sidebar (levý dolní roh) / mobil „Více" (pravý dolní).
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 1024;
  const origin = isMobile ? '88% 92%' : '12% 84%';

  const overlay = (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        pointerEvents: 'auto',
        overflow: 'hidden',
      }}
    >
      {/* Frost — app se „odsune" do rozostření */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backdropFilter: covering ? 'blur(14px)' : 'blur(0px)',
          WebkitBackdropFilter: covering ? 'blur(14px)' : 'blur(0px)',
          background: covering ? 'rgba(8,11,18,0.4)' : 'rgba(8,11,18,0)',
          transition: 'backdrop-filter .45s ease, background .45s ease',
        }}
      />

      {/* Clona — radiální expanze z místa přepínače (levý dolní sidebar) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: w.grad,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          clipPath: covering ? `circle(150% at ${origin})` : `circle(0% at ${origin})`,
          transition: entered && !exiting
            ? 'clip-path .62s cubic-bezier(.4,0,.2,1)'
            : 'clip-path .5s cubic-bezier(.4,0,.2,1)',
          willChange: 'clip-path',
        }}
      >
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: 24,
            background: w.iconBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: covering ? 'scale(1)' : 'scale(.6)',
            opacity: covering ? 1 : 0,
            transition: 'transform .5s cubic-bezier(.34,1.56,.64,1) .1s, opacity .4s ease .1s',
          }}
        >
          <Icon size={40} color={w.iconColor} strokeWidth={1.75} />
        </div>
        <div
          style={{
            fontSize: 23,
            fontWeight: 800,
            letterSpacing: '0.18em',
            color: w.titleColor,
            transform: covering ? 'translateY(0)' : 'translateY(10px)',
            opacity: covering ? 1 : 0,
            transition: 'transform .45s ease .18s, opacity .45s ease .18s',
          }}
        >
          {w.title}
        </div>
        <div
          style={{
            fontSize: 13.5,
            letterSpacing: '0.04em',
            color: w.subColor,
            transform: covering ? 'translateY(0)' : 'translateY(10px)',
            opacity: covering ? 1 : 0,
            transition: 'transform .45s ease .26s, opacity .45s ease .26s',
          }}
        >
          {w.sub}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
};

export default WorldShiftOverlay;
