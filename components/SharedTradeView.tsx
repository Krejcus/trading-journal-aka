/**
 * SharedTradeView — public landing page pro shared trade.
 *
 * Karta (TradeShareCard) scaled to fit + pod ní PLNÁ poznámka, POKUD ji autor
 * sdílel (server ji odstřihne v get_public_trade, když share_notes není true).
 * Na kartě samotné poznámka skrytá (showNotes=false) — full text je čitelně pod ní,
 * link není limitovaný 1600×900 jako PNG.
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
    const notes = (trade.notes && String(trade.notes).trim()) ? String(trade.notes).trim() : '';

    // Když je poznámka, nech karte jen ~72 % výšky → zbytek na panel pod ní (bez nutného scrollu).
    useLayoutEffect(() => {
        const computeScale = () => {
            const padH = 40;
            const padV = 48;
            const fitW = (window.innerWidth - padH) / CARD_W;
            const hBudget = notes ? window.innerHeight * 0.72 : (window.innerHeight - padV);
            const fitH = hBudget / CARD_H;
            setScale(Math.min(0.9, Math.max(0.25, Math.min(fitW, fitH))));
        };
        computeScale();
        window.addEventListener('resize', computeScale);
        return () => window.removeEventListener('resize', computeScale);
    }, [notes]);

    const visW = CARD_W * scale;

    return (
        <div className="min-h-screen w-full bg-[#050810] flex flex-col items-center gap-6 py-6 px-4 overflow-y-auto">
            {/* Karta */}
            <div style={{ width: visW, height: CARD_H * scale, position: 'relative', flexShrink: 0 }}>
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
                        showNotes={false}
                    />
                </div>
            </div>

            {/* Plná poznámka — jen když ji autor sdílel (server-gated) */}
            {notes && (
                <div style={{ width: visW, maxWidth: '100%', flexShrink: 0 }}>
                    <div style={{
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(34,211,238,0.15)',
                        borderRadius: 20,
                        padding: '24px 28px',
                    }}>
                        <div style={{
                            fontSize: 12, fontWeight: 800,
                            letterSpacing: '0.2em', textTransform: 'uppercase',
                            color: 'rgba(34,211,238,0.7)', marginBottom: 12,
                        }}>Poznámka</div>
                        <div style={{
                            fontSize: 16, lineHeight: 1.7,
                            color: 'rgba(255,255,255,0.85)',
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        }}>{notes}</div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SharedTradeView;
