/**
 * SharedTradeView — public landing page pro shared trade.
 *
 * Minimalistický view: jen TradeShareCard scaled to fit viewport, nic víc.
 * Žádné branding header, CTA, footer — karta sama o sobě nese AlphaTrade brand.
 */
import React, { useState, useLayoutEffect } from 'react';
import { Trade } from '../types';
import TradeShareCard from './TradeShareCard';

interface SharedTradeViewProps {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
    /** Jméno autora trade — z profiles tabulky. */
    ownerName?: string;
    /** Avatar URL autora. */
    ownerAvatar?: string;
}

const CARD_W = 1600;
const CARD_H = 900;

const SharedTradeView: React.FC<SharedTradeViewProps> = ({ trade, ownerName, ownerAvatar }) => {
    const [scale, setScale] = useState(0.6);

    // Compute scale to fit viewport — fill jak jen jde
    useLayoutEffect(() => {
        const computeScale = () => {
            const padH = 32;
            const padV = 32;
            const fitW = (window.innerWidth - padH) / CARD_W;
            const fitH = (window.innerHeight - padV) / CARD_H;
            setScale(Math.min(0.9, Math.max(0.25, Math.min(fitW, fitH))));
        };
        computeScale();
        window.addEventListener('resize', computeScale);
        return () => window.removeEventListener('resize', computeScale);
    }, []);

    return (
        <div className="min-h-screen flex items-center justify-center bg-[#050810] p-4 overflow-hidden">
            <div style={{
                width: CARD_W * scale,
                height: CARD_H * scale,
                position: 'relative',
            }}>
                <div style={{
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    width: CARD_W,
                    height: CARD_H,
                    borderRadius: 24,
                    overflow: 'hidden',
                    boxShadow: '0 30px 80px -20px rgba(0,0,0,0.6), 0 0 60px rgba(34,211,238,0.08)',
                }}>
                    <TradeShareCard
                        trade={trade}
                        username={ownerName ? `@${ownerName.toLowerCase().replace(/\s+/g, '')}` : '@trader'}
                        avatarUrl={ownerAvatar}
                        shareUrl={window.location.href}
                        showQR={false}
                        showNotes={true}
                    />
                </div>
            </div>
        </div>
    );
};

export default SharedTradeView;
