/**
 * SharedTradeView — public landing page pro shared trade.
 *
 * Interaktivní (jen na webu, NE v PNG): karta se naklápí za myší (3D tilt) +
 * sweeping light beams kolem okraje (stejný efekt jako login karta). Klik na
 * chart screenshot → ImageZoomModal (zoom + pan). Pod kartou plná poznámka,
 * pokud ji autor sdílel (server ji jinak odstřihne v get_public_trade).
 */
import React, { useState, useLayoutEffect } from 'react';
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { Trade } from '../types';
import TradeShareCard from './TradeShareCard';
import ImageZoomModal from './ImageZoomModal';

interface SharedTradeViewProps {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
    ownerName?: string;
    ownerAvatar?: string;
}

const CARD_W = 1600;
const CARD_H = 900;

const SharedTradeView: React.FC<SharedTradeViewProps> = ({ trade, ownerName, ownerAvatar }) => {
    const [scale, setScale] = useState(0.6);
    const [zoom, setZoom] = useState(false);
    const notes = (trade.notes && String(trade.notes).trim()) ? String(trade.notes).trim() : '';
    const screenshots = (trade.screenshots && trade.screenshots.length)
        ? trade.screenshots
        : (trade.screenshot ? [trade.screenshot] : []);

    // 3D tilt za myší — jemně odpružené (GPU transform, žádný výpočet).
    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);
    const sx = useSpring(mouseX, { stiffness: 150, damping: 20 });
    const sy = useSpring(mouseY, { stiffness: 150, damping: 20 });
    const rotateX = useTransform(sy, [-300, 300], [7, -7]);
    const rotateY = useTransform(sx, [-300, 300], [-7, 7]);
    const handleMouseMove = (e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        mouseX.set(e.clientX - rect.left - rect.width / 2);
        mouseY.set(e.clientY - rect.top - rect.height / 2);
    };
    const handleMouseLeave = () => { mouseX.set(0); mouseY.set(0); };

    // Když je poznámka, nech kartě ~72 % výšky → zbytek na panel pod ní.
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
    const visH = CARD_H * scale;
    const beam = "absolute bg-gradient-to-r from-transparent via-cyan-300/80 to-transparent";

    return (
        <div className="min-h-screen w-full bg-[#050810] flex flex-col items-center gap-7 py-6 px-4 overflow-y-auto">
            {/* Karta — interaktivní wrapper (perspective + tilt + beams) */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                style={{ width: visW, height: visH, perspective: 1500, flexShrink: 0 }}
            >
                <motion.div
                    style={{ rotateX, rotateY, width: visW, height: visH, position: 'relative' }}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                >
                    {/* Traveling light beams kolem okraje */}
                    <div style={{ position: 'absolute', inset: -1, borderRadius: 24 * scale, overflow: 'hidden', pointerEvents: 'none', zIndex: 3 }}>
                        <motion.div className={`${beam} top-0 left-0 h-[2px] w-[60%]`} animate={{ left: ["-60%", "100%"] }} transition={{ duration: 3, ease: "linear", repeat: Infinity, repeatDelay: 0.5 }} />
                        <motion.div className={`${beam} bottom-0 right-0 h-[2px] w-[60%]`} animate={{ right: ["-60%", "100%"] }} transition={{ duration: 3, ease: "linear", repeat: Infinity, repeatDelay: 0.5 }} />
                        <motion.div className="absolute top-0 right-0 w-[2px] h-[60%] bg-gradient-to-b from-transparent via-cyan-300/80 to-transparent" animate={{ top: ["-60%", "100%"] }} transition={{ duration: 3, ease: "linear", repeat: Infinity, repeatDelay: 0.5, delay: 1.5 }} />
                        <motion.div className="absolute bottom-0 left-0 w-[2px] h-[60%] bg-gradient-to-b from-transparent via-cyan-300/80 to-transparent" animate={{ bottom: ["-60%", "100%"] }} transition={{ duration: 3, ease: "linear", repeat: Infinity, repeatDelay: 0.5, delay: 1.5 }} />
                    </div>

                    {/* Scaled karta */}
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
                            onScreenshotClick={screenshots.length ? () => setZoom(true) : undefined}
                        />
                    </div>
                </motion.div>
            </motion.div>

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

            {/* Zoom screenshotu */}
            {zoom && screenshots.length > 0 && (
                <ImageZoomModal images={screenshots} onClose={() => setZoom(false)} />
            )}
        </div>
    );
};

export default SharedTradeView;
