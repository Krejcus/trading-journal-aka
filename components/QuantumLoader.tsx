import React from 'react';

interface QuantumLoaderProps {
    text?: string;
    theme?: 'dark' | 'light' | 'oled';
}

/**
 * Točící se logo z úvodního načítání appky pro načítání uvnitř obrazovek.
 * Během jednoho načítání se vystřídá víc instancí (lazy import → data →
 * graf). Animace proto běží přes Web Animations se `startTime = 0` — fáze
 * vychází z hodin dokumentu, nová instance plynule navazuje a logo necukne
 * na začátek (CSS animace startuje až při přepočtu stylů, klidně o stovky ms
 * později než render).
 */
const SPIN_MS = 2000;
export const QuantumSpinner: React.FC<{ size?: number; className?: string }> = ({ size = 128, className = '' }) => {
    const pulseRef = React.useRef<HTMLDivElement>(null);
    const spinRef = React.useRef<HTMLImageElement>(null);
    React.useLayoutEffect(() => {
        const animations = [
            pulseRef.current?.animate?.([{ opacity: 1 }, { opacity: 0.5 }, { opacity: 1 }],
                { duration: SPIN_MS, iterations: Infinity, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' }),
            spinRef.current?.animate?.([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
                { duration: SPIN_MS, iterations: Infinity }),
        ];
        for (const animation of animations) if (animation) animation.startTime = 0;
        return () => animations.forEach(animation => animation?.cancel());
    }, []);
    return (
        <div ref={pulseRef} role="status" aria-label="Načítání" className={`relative ${className}`} style={{ width: size, height: size }}>
            <img ref={spinRef} src="/logos/at_logo_light_clean.png" alt="" className="w-full h-full object-contain" />
        </div>
    );
};

const QuantumLoader: React.FC<QuantumLoaderProps> = ({ theme = 'dark' }) => {
    const isLight = theme === 'light';

    return (
        <div className={`min-h-screen w-screen ${isLight ? 'bg-white' : 'bg-black'} flex items-center justify-center font-sans`}>
            <div className="relative w-32 h-32 animate-pulse">
                <img
                    src="/logos/at_logo_light_clean.png"
                    alt="Loading..."
                    className="w-full h-full object-contain animate-spin"
                    style={{ animationDuration: '2s' }}
                />
            </div>
        </div>
    );
};

export default QuantumLoader;
