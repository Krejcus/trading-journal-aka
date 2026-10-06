/**
 * SharedTradeView — veřejná stránka sdíleného obchodu (/share/:id).
 *
 * Stejná karta jako v appce (náklon, odlesk, běžící světla), jen bez
 * ovládání. Klik na graf → ImageZoomModal. Pod kartou plná poznámka, pokud
 * ji autor sdílel (server ji jinak odstřihne v get_public_trade).
 */
import React, { useState } from 'react';
import { Trade } from '../types';
import TradeShareCard from './TradeShareCard';
import ImageZoomModal from './ImageZoomModal';

interface SharedTradeViewProps {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
    ownerName?: string;
    ownerAvatar?: string;
}

const SharedTradeView: React.FC<SharedTradeViewProps> = ({ trade, theme, ownerName, ownerAvatar }) => {
    const [zoom, setZoom] = useState(false);
    const notes = trade.notes && String(trade.notes).trim() ? String(trade.notes).trim() : '';
    const screenshots = trade.screenshots?.length ? trade.screenshots : trade.screenshot ? [trade.screenshot] : [];
    const light = theme === 'light';

    return (
        <main className={`relative min-h-screen w-full overflow-y-auto ${light ? 'bg-slate-200' : 'bg-black'}`}>
            <div
                aria-hidden
                className="pointer-events-none fixed inset-0"
                style={{
                    background: light
                        ? 'radial-gradient(circle at 15% 0%, #cffafe 0, transparent 40%), radial-gradient(circle at 90% 100%, #d1fae5 0, transparent 38%)'
                        : 'radial-gradient(circle at 15% 0%, rgba(8,51,68,.9) 0, transparent 40%), radial-gradient(circle at 90% 100%, rgba(5,46,43,.9) 0, transparent 38%)',
                }}
            />
            <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1040px] flex-col justify-center gap-5 px-4 py-8 sm:px-8">
                <TradeShareCard
                    trade={trade}
                    owner={{ name: ownerName?.trim() || 'Trader', avatar: ownerAvatar }}
                    onScreenshotClick={screenshots.length ? () => setZoom(true) : undefined}
                />

                {notes ? (
                    <section className={`rounded-2xl border px-6 py-5 ${light ? 'border-slate-900/10 bg-white/70 text-slate-800' : 'border-white/10 bg-white/[0.03] text-white/85'}`}>
                        <div className={`mb-2 text-[11px] font-semibold ${light ? 'text-slate-500' : 'text-white/50'}`}>Poznámka</div>
                        <p className="m-0 whitespace-pre-wrap break-words text-[15px] leading-relaxed">{notes}</p>
                    </section>
                ) : null}
            </div>

            {zoom && screenshots.length > 0 ? <ImageZoomModal images={screenshots} onClose={() => setZoom(false)} /> : null}
        </main>
    );
};

export default SharedTradeView;
