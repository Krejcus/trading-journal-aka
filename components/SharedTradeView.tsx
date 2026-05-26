/**
 * SharedTradeView — public landing page pro shared trade.
 *
 * Zobrazuje:
 *   - Naši krásnou TradeShareCard (stejnou co se dá stáhnout / sdílet)
 *   - CTA pro non-userů ("Vytvoř si vlastní AlphaTrade journal")
 *
 * Render flow:
 *   1. User klikne `https://alphatrade-mentor-15.vercel.app/share/abc-123` v chatu
 *   2. Discord/X už si vytáhli OG preview přes `/api/share/:id` (server-side)
 *   3. User klik → JS redirect z `/share/:id` na `/?shareId=abc-123`
 *   4. App.tsx fetchne trade přes `storageService.getTradeById()` a renderuje tuto stránku
 */
import React, { useState, useEffect, useLayoutEffect } from 'react';
import { ExternalLink, ArrowRight } from 'lucide-react';
import { Trade } from '../types';
import TradeShareCard from './TradeShareCard';

interface SharedTradeViewProps {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
}

const CARD_W = 1600;
const CARD_H = 900;

const SharedTradeView: React.FC<SharedTradeViewProps> = ({ trade }) => {
    const [scale, setScale] = useState(0.6);

    // Compute scale to fit viewport — match TradeShareModal logic
    useLayoutEffect(() => {
        const computeScale = () => {
            const padH = 48;
            const padV = 280; // top branding + bottom CTA
            const fitW = (window.innerWidth - padH) / CARD_W;
            const fitH = (window.innerHeight - padV) / CARD_H;
            setScale(Math.min(0.8, Math.max(0.3, Math.min(fitW, fitH))));
        };
        computeScale();
        window.addEventListener('resize', computeScale);
        return () => window.removeEventListener('resize', computeScale);
    }, []);

    // App URL bez shareId — pro CTA tlačítka
    const appHomeUrl = window.location.origin;

    return (
        <div className="min-h-screen flex flex-col items-center bg-gradient-to-b from-[#050810] via-[#0a0e1a] to-[#050810] text-white py-8 px-4 overflow-x-hidden">
            {/* Top brand bar */}
            <div className="w-full max-w-7xl flex items-center justify-between mb-6 lg:mb-8">
                <div className="flex items-center gap-3">
                    <img
                        src="/logos/at_logo_light_clean.png"
                        alt="AlphaTrade"
                        className="w-10 h-10 lg:w-12 lg:h-12 object-contain"
                        style={{ filter: 'drop-shadow(0 0 16px rgba(34,211,238,0.4))' }}
                    />
                    <span className="text-base lg:text-lg font-extralight tracking-[0.4em] uppercase">
                        ALPHA <span className="text-cyan-400 font-normal">TRADE</span>
                    </span>
                </div>
                <a
                    href={appHomeUrl}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-all text-xs font-black uppercase tracking-widest"
                >
                    Otevřít appku
                    <ExternalLink size={12} />
                </a>
            </div>

            {/* Hero badge */}
            <div className="mb-6 flex items-center gap-2 px-4 py-2 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-300">
                <span className="text-[10px] font-black uppercase tracking-[0.3em]">Shared Trade Snapshot</span>
            </div>

            {/* THE CARD — scaled to fit viewport */}
            <div className="relative" style={{
                width: CARD_W * scale,
                height: CARD_H * scale,
                maxWidth: '100%',
            }}>
                <div style={{
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    width: CARD_W,
                    height: CARD_H,
                    borderRadius: 24 * scale,
                    overflow: 'hidden',
                    boxShadow: '0 30px 80px -20px rgba(0,0,0,0.6), 0 0 60px rgba(34,211,238,0.08)',
                }}>
                    <TradeShareCard trade={trade} username="@trader" shareUrl={appHomeUrl} showQR={false} />
                </div>
            </div>

            {/* CTA — "Líbí se ti to? Zkus si AlphaTrade" */}
            <div className="mt-10 lg:mt-12 max-w-2xl text-center px-4">
                <h2 className="text-2xl lg:text-3xl font-black tracking-tighter mb-3">
                    Líbí se ti tahle karta?
                </h2>
                <p className="text-sm lg:text-base text-slate-400 mb-6 leading-relaxed">
                    AlphaTrade je premium trading journal s AI Coachem, pattern detection a smart sharing.
                    Zaznamenej obchody, najdi své vzory, zlepši svůj edge.
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                    <a
                        href={appHomeUrl}
                        className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-slate-900 text-xs font-black uppercase tracking-widest transition-all shadow-lg shadow-cyan-500/30"
                    >
                        Vyzkoušet zdarma
                        <ArrowRight size={14} strokeWidth={3} />
                    </a>
                    <a
                        href={appHomeUrl}
                        className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-black uppercase tracking-widest transition-all"
                    >
                        Více informací
                    </a>
                </div>
            </div>

            {/* Footer */}
            <div className="mt-12 text-center">
                <p className="text-[9px] font-black uppercase tracking-[0.4em] text-slate-600">
                    Powered by AlphaTrade · Premium Trading Journal
                </p>
            </div>
        </div>
    );
};

export default SharedTradeView;
