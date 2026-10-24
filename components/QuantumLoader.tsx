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

/**
 * Načítání při startu appky: točící se logo na pozadí aktuálního režimu
 * (světlý / tmavý / OLED podle `--bg-page`, které nastaví už index.html).
 * Logo běží na hodinách dokumentu (QuantumSpinner), takže přechod do appky
 * (BootTransition) navazuje ve stejné fázi otáčení.
 */
const QuantumLoader: React.FC<QuantumLoaderProps> = ({ text }) => (
    <div className="relative min-h-screen w-screen flex items-center justify-center font-sans" style={{ background: 'var(--bg-page)' }}>
        <QuantumSpinner size={128} />
        {/* Text pod logem absolutně — logo zůstane přesně uprostřed jako v přechodu do appky. */}
        {text && <p className="absolute left-0 right-0 text-center text-[12px] font-semibold tracking-wide" style={{ top: 'calc(50% + 86px)', color: 'var(--text-muted)' }}>{text}</p>}
    </div>
);

export default QuantumLoader;
