/**
 * TradeShareModal — fullscreen preview shareable trade card s floating actions.
 *
 * UX flow:
 *   1. User klikne Share2 v TradeDetailModal
 *   2. Backdrop + card scaled to fit viewport (no wrapper modal)
 *   3. Floating Download / Copy buttons bottom-center, X close top-right
 *   4. Click backdrop = close
 *
 * Důležité: Action buttons jsou MIMO `cardRef` div — takže nezachytí se
 * v exportovaném PNG (jsou jen v previewu).
 */
import React, { useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react';
import { motion } from 'framer-motion';
import { X, Download, Copy, Loader2, Link as LinkIcon } from 'lucide-react';
import { toPng } from 'html-to-image';
import type { Trade } from '../types';
import { storageService } from '../services/storageService';
import TradeShareCard from './TradeShareCard';

interface Props {
    trade: Trade;
    username?: string;
    onClose: () => void;
}

const CARD_W = 1600;
const CARD_H = 900;

const TradeShareModal: React.FC<Props> = ({ trade, username = '@trader', onClose }) => {
    const cardRef = useRef<HTMLDivElement>(null);
    const [generating, setGenerating] = useState(false);
    const [feedback, setFeedback] = useState<string | null>(null);
    const [scale, setScale] = useState(0.6);

    // Sestaví share URL — `/share/:id` route s OG meta tagy přes Vercel rewrite na /api/share/:id.
    // Crawlery (Discord/X/Slack) si stáhnou preview z meta tagů, humany JS redirect na app.
    const shareUrl = (() => {
        if (!trade.id) return window.location.origin;
        const isUUID = typeof trade.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trade.id);
        if (isUUID) return `${window.location.origin}/share/${trade.id}`;
        return window.location.origin;
    })();

    // Mark trade as public for QR scan flow
    useEffect(() => {
        const isUUID = typeof trade.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trade.id);
        if (isUUID) {
            storageService.markTradeAsPublic(trade.id as string).catch(err => {
                console.warn('[Share] Failed to mark trade as public:', err);
            });
        }
    }, [trade.id]);

    // Lock scroll while modal open
    useEffect(() => {
        const original = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = original; };
    }, []);

    // Compute scale to fit viewport — card has fixed 1600×900
    // Leave ~80px horizontal padding, ~140px vertical for action buttons
    useLayoutEffect(() => {
        const computeScale = () => {
            const padH = 80;
            // top: close button (40) + bottom: action buttons (~70) + gap (~24)
            const padV = 180;
            const fitW = (window.innerWidth - padH) / CARD_W;
            const fitH = (window.innerHeight - padV) / CARD_H;
            setScale(Math.min(0.85, fitW, fitH));
        };
        computeScale();
        window.addEventListener('resize', computeScale);
        return () => window.removeEventListener('resize', computeScale);
    }, []);

    /** Vygeneruje PNG blob z card divu — používáno pro download i clipboard */
    const generatePng = useCallback(async (): Promise<Blob | null> => {
        if (!cardRef.current) return null;
        try {
            const dataUrl = await toPng(cardRef.current, {
                pixelRatio: 2,
                cacheBust: true,
                backgroundColor: '#050810',
                skipFonts: true, // Skip Google Fonts CSS embedding (CORS-restricted); -apple-system fallback funguje
            });
            const res = await fetch(dataUrl);
            return await res.blob();
        } catch (e) {
            console.error('[Share] PNG generation failed:', e);
            return null;
        }
    }, []);

    const handleDownload = useCallback(async () => {
        setGenerating(true);
        setFeedback(null);
        const blob = await generatePng();
        setGenerating(false);
        if (!blob) {
            setFeedback('Generování selhalo');
            setTimeout(() => setFeedback(null), 2500);
            return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `alphatrade_${trade.instrument || 'trade'}_${new Date(trade.date || Date.now()).toISOString().slice(0, 10)}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setFeedback('Staženo ✓');
        setTimeout(() => setFeedback(null), 2000);
    }, [generatePng, trade]);

    const handleCopyLink = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(shareUrl);
            setFeedback('Link zkopírován ✓ Vlož ⌘+V — Discord/X vytvoří preview');
            setTimeout(() => setFeedback(null), 3500);
        } catch (e) {
            console.error('[Share] Link copy failed:', e);
            setFeedback('Nepodařilo se zkopírovat link');
            setTimeout(() => setFeedback(null), 2500);
        }
    }, [shareUrl]);

    const handleCopy = useCallback(async () => {
        if (!cardRef.current) return;
        setGenerating(true);
        setFeedback(null);

        try {
            if (typeof ClipboardItem === 'undefined') {
                throw new Error('ClipboardItem not supported');
            }

            // Generate PNG sync-first (verify blob), then write
            const dataUrl = await toPng(cardRef.current, {
                pixelRatio: 2,
                cacheBust: true,
                backgroundColor: '#050810',
                // Skip external font embedding — Google Fonts CSS is CORS-restricted.
                // Karta používá -apple-system fallback, takže font fallback funguje OK.
                skipFonts: true,
            });

            const res = await fetch(dataUrl);
            const blob = await res.blob();

            // Verify blob is valid (não-empty)
            console.log('[Share] Generated blob:', { size: blob.size, type: blob.type });
            if (!blob || blob.size < 1000) {
                throw new Error(`Invalid blob (size: ${blob?.size || 0} bytes) — možný CORS issue se screenshotem`);
            }

            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);

            setGenerating(false);
            setFeedback('Zkopírováno ✓ Vlož do chatu (⌘+v)');
            setTimeout(() => setFeedback(null), 3000);
        } catch (e: any) {
            setGenerating(false);
            console.error('[Share] Clipboard write failed:', e);
            let msg = 'Použij raději Stáhnout';
            if (e?.message?.includes('CORS') || e?.message?.includes('Invalid blob')) {
                msg = 'Obrázek se nepodařilo vygenerovat (CORS). Použij Stáhnout.';
            } else if (e?.name === 'NotAllowedError') msg = 'Browser nepovolil clipboard. Použij Stáhnout.';
            else if (e?.message?.includes('not supported') || e?.message?.includes('ClipboardItem')) msg = 'Tvůj browser neumí kopírovat obrázek. Použij Stáhnout.';
            else if (e?.name === 'SecurityError') msg = 'Nezabezpečené připojení. Použij Stáhnout.';
            setFeedback(msg);
            setTimeout(() => setFeedback(null), 4000);
        }
    }, []);

    // Compute card visible size (after scale) for layout reservation
    const visibleW = CARD_W * scale;
    const visibleH = CARD_H * scale;

    return (
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-6">
            {/* Backdrop — klik zavírá modal */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={onClose}
                className="absolute inset-0 bg-black/85 backdrop-blur-md"
            />

            {/* Close button (mimo card div — neexportuje se) */}
            <button
                onClick={onClose}
                className="absolute top-6 right-6 z-20 p-3 rounded-full bg-white/5 hover:bg-white/10 text-white border border-white/10 transition-all"
            >
                <X size={22} />
            </button>

            {/* Card wrapper — rezervuje místo pro scaled card */}
            <div style={{ width: visibleW, height: visibleH, position: 'relative', zIndex: 10 }}>
                <motion.div
                    initial={{ opacity: 0, scale: scale * 0.95, y: 20 }}
                    animate={{ opacity: 1, scale, y: 0 }}
                    exit={{ opacity: 0, scale: scale * 0.95, y: 20 }}
                    style={{
                        width: CARD_W,
                        height: CARD_H,
                        transformOrigin: 'top left',
                        position: 'absolute',
                        top: 0,
                        left: 0,
                    }}
                    className="shadow-2xl shadow-black/50"
                >
                    <div ref={cardRef} style={{ width: CARD_W, height: CARD_H, borderRadius: 24, overflow: 'hidden' }}>
                        <TradeShareCard trade={trade} username={username} shareUrl={shareUrl} showQR={true} />
                    </div>
                </motion.div>
            </div>

            {/* Action buttons — centered under card via flex parent */}
            <div className="relative z-10 flex items-center gap-3">
                {feedback && (
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-bold whitespace-nowrap animate-in fade-in slide-in-from-bottom-2">
                        {feedback}
                    </div>
                )}
                <button
                    onClick={handleDownload}
                    disabled={generating}
                    className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-black uppercase tracking-widest transition-all shadow-lg shadow-blue-600/40 disabled:opacity-50"
                >
                    {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    Stáhnout PNG
                </button>
                <button
                    onClick={handleCopy}
                    disabled={generating}
                    className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-white/10 hover:bg-white/15 text-white text-[11px] font-black uppercase tracking-widest transition-all border border-white/15 backdrop-blur disabled:opacity-50"
                >
                    {generating ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
                    Kopírovat obrázek
                </button>
                <button
                    onClick={handleCopyLink}
                    disabled={generating}
                    className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-white/10 hover:bg-white/15 text-white text-[11px] font-black uppercase tracking-widest transition-all border border-white/15 backdrop-blur disabled:opacity-50"
                    title={shareUrl}
                >
                    <LinkIcon size={14} />
                    Kopírovat link
                </button>
            </div>
        </div>
    );
};

export default TradeShareModal;
