import { useEffect, useRef } from 'react';

type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  color: string;
};

/**
 * The animated candlestick backdrop shared by sign-in and public cards.
 * The light variant is not the dark one inverted: the plate is light and the
 * candles darken, otherwise emerald/red on near-white has no contrast.
 */
const AnimatedTradingBackground = ({ variant = 'dark' }: { variant?: 'dark' | 'light' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const light = variant === 'light';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resizeCanvas = () => {
      const ratio = window.devicePixelRatio;
      canvas.width = window.innerWidth * ratio;
      canvas.height = window.innerHeight * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const numCandles = 70;
    const candles: Candle[] = [];
    let lastClose = 100;
    let trend = 0;

    for (let i = 0; i < numCandles; i++) {
      if (i < 20) {
        trend = (Math.random() - 0.5) * 4;
      } else if (i < 45) {
        if (i === 22) trend = 1.5;
        if (i === 28) trend = -1.8;
        if (i === 34) trend = 1.2;
        if (i === 40) trend = -1.1;
      } else {
        if (i === 46) trend = -2.0;
        if (i === 52) trend = 2.5;
      }

      const volatility = i < 20 ? 1.5 + Math.random() * 2.5 : 0.8 + Math.random() * 1.5;
      const noise = (Math.random() - 0.5) * (i < 20 ? 2 : 1.2);
      const open = lastClose;
      const close = open + trend + noise;
      const high = Math.max(open, close) + Math.random() * volatility;
      const low = Math.min(open, close) - Math.random() * volatility;

      candles.push({
        open,
        high,
        low,
        close,
        color: close >= open ? (light ? '#059669' : '#10b981') : (light ? '#e11d48' : '#ef4444'),
      });
      lastClose = close;
    }

    let currentIndex = 0;
    let animationInterval = 0;
    let restartTimeout: number | null = null;

    const drawCandle = (index: number) => {
      const candle = candles[index];
      const width = window.innerWidth;
      const height = window.innerHeight;
      const candleWidth = Math.max(2, (width - 40) / candles.length);
      const x = 20 + index * candleWidth;
      const allPrices = candles.flatMap(candleValue => [candleValue.high, candleValue.low]);
      const minPrice = Math.min(...allPrices);
      const maxPrice = Math.max(...allPrices);
      const priceRange = maxPrice - minPrice;
      const scaleY = (price: number) => {
        const padding = height * 0.1;
        return height - padding - ((price - minPrice) / priceRange) * (height - padding * 2);
      };

      const openY = scaleY(candle.open);
      const closeY = scaleY(candle.close);
      const highY = scaleY(candle.high);
      const lowY = scaleY(candle.low);
      const bodyTop = Math.min(openY, closeY);
      const bodyBottom = Math.max(openY, closeY);
      const bodyHeight = Math.max(bodyBottom - bodyTop, 1);

      ctx.strokeStyle = candle.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + candleWidth / 2, highY);
      ctx.lineTo(x + candleWidth / 2, lowY);
      ctx.stroke();

      ctx.fillStyle = candle.color;
      const bodyWidth = Math.max(candleWidth * 0.7, 2);
      ctx.fillRect(
        x + (candleWidth - bodyWidth) / 2,
        bodyTop,
        bodyWidth,
        bodyHeight || 1,
      );
    };

    const render = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      ctx.fillStyle = light ? '#eef2f7' : '#000000';
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < currentIndex; i++) drawCandle(i);
    };

    animationInterval = window.setInterval(() => {
      if (restartTimeout) return;
      if (currentIndex < candles.length) {
        currentIndex++;
        render();
      } else {
        restartTimeout = window.setTimeout(() => {
          currentIndex = 0;
          render();
          restartTimeout = null;
        }, 800);
      }
    }, 80);

    return () => {
      clearInterval(animationInterval);
      if (restartTimeout) clearTimeout(restartTimeout);
      window.removeEventListener('resize', resizeCanvas);
    };
  }, [light]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ opacity: light ? 0.92 : 1, zIndex: 1 }}
      />
      <div
        aria-hidden="true"
        /* Překryv leží PŘES plátno. V tmavém dělá vinětaci, ve světlém ale
           dusil svíčky do mlhy — tam smí jen naznačit rohy. */
        className={`pointer-events-none absolute inset-0 ${light
          ? 'bg-gradient-to-b from-cyan-100/25 via-transparent to-slate-200/45'
          : 'bg-gradient-to-b from-blue-900/20 via-slate-950/40 to-black'}`}
      />
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 mix-blend-soft-light ${light ? 'opacity-[0.02]' : 'opacity-[0.03]'}`}
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
          backgroundSize: '200px 200px',
        }}
      />
    </>
  );
};

export default AnimatedTradingBackground;
