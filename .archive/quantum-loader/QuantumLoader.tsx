import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

interface QuantumLoaderProps {
    text?: string;
    theme?: 'dark' | 'light' | 'oled';
}

const QuantumLoader: React.FC<QuantumLoaderProps> = ({ text = "Načítám", theme = 'dark' }) => {
    const letters = text.split('');
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Set canvas size to full screen
        const resizeCanvas = () => {
            canvas.width = window.innerWidth * window.devicePixelRatio;
            canvas.height = window.innerHeight * window.devicePixelRatio;
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        };
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        // Generate candles (Version C pattern)
        const numCandles = 70;
        const candles: any[] = [];
        let lastClose = 100;
        let trend = 0;

        for (let i = 0; i < numCandles; i++) {
            // Wild chaos at start, then stabilizing with big final move
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
                open, high, low, close,
                color: close >= open ? '#10b981' : '#ef4444'
            });

            lastClose = close;
        }

        // Animation state
        let currentIndex = 0;
        let animationInterval: NodeJS.Timeout;

        const drawCandle = (index: number) => {
            const candle = candles[index];
            const width = window.innerWidth;
            const height = window.innerHeight;

            const candleWidth = Math.max(2, (width - 40) / candles.length);
            const x = 20 + index * candleWidth;

            const allPrices = candles.flatMap(c => [c.high, c.low]);
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
                bodyHeight || 1
            );
        };

        const render = () => {
            const width = window.innerWidth;
            const height = window.innerHeight;

            // Background color based on theme
            ctx.fillStyle = theme === 'light' ? '#ffffff' : '#000000';
            ctx.fillRect(0, 0, width, height);

            for (let i = 0; i < currentIndex; i++) {
                drawCandle(i);
            }
        };

        const animate = () => {
            animationInterval = setInterval(() => {
                if (currentIndex < candles.length) {
                    currentIndex++;
                    render();
                } else {
                    setTimeout(() => {
                        currentIndex = 0;
                        render();
                    }, 800);
                }
            }, 40);
        };

        animate();

        return () => {
            clearInterval(animationInterval);
            window.removeEventListener('resize', resizeCanvas);
        };
    }, [theme]);

    const isLight = theme === 'light';

    return (
        <div className={`min-h-screen w-screen ${isLight ? 'bg-white' : 'bg-black'} flex flex-col items-center justify-center gap-8 font-sans relative overflow-hidden`}>
            {/* Canvas chart animation */}
            <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{ opacity: 1.0 }}
            />

            {/* Animated text */}
            <div className="relative z-10 flex font-mono text-2xl sm:text-3xl font-bold tracking-wider">
                {letters.map((letter, index) => (
                    <motion.span
                        key={index}
                        className={`generating-loader-letter ${isLight ? 'text-gray-900' : 'text-white'}`}
                        style={{
                            animationDelay: `${index * 0.1}s`,
                        }}
                    >
                        {letter}
                    </motion.span>
                ))}
                <motion.span
                    className={`generating-loader-letter ${isLight ? 'text-gray-900' : 'text-white'}`}
                    style={{ animationDelay: `${letters.length * 0.1}s` }}
                >
                    .
                </motion.span>
                <motion.span
                    className={`generating-loader-letter ${isLight ? 'text-gray-900' : 'text-white'}`}
                    style={{ animationDelay: `${(letters.length + 1) * 0.1}s` }}
                >
                    .
                </motion.span>
                <motion.span
                    className={`generating-loader-letter ${isLight ? 'text-gray-900' : 'text-white'}`}
                    style={{ animationDelay: `${(letters.length + 2) * 0.1}s` }}
                >
                    .
                </motion.span>
            </div>

            {/* Progress bar */}
            <div className="generating-loader-bar relative z-10" />
        </div>
    );
};

export default QuantumLoader;
