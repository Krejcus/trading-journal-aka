import React from 'react';

interface QuantumLoaderProps {
    text?: string;
    theme?: 'dark' | 'light' | 'oled';
}

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
