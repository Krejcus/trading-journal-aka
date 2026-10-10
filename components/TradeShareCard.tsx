/**
 * TradeShareCard — sdílecí karta obchodu ve stejné rodině jako Karta dne z LIVE:
 * černé (ve světlém motivu bílé) sklo, běžící světla po okraji, náklon za
 * myší/prstem a ovládání v pravém horním rohu, které se odhalí po najetí.
 *
 * Stejná komponenta kreslí kartu v dialogu, na veřejné stránce /share/:id
 * i do PNG — export ji vykreslí v `captureMode` (bez animací) do plátna
 * 1200×630, což je poměr náhledů odkazů na X, Discordu i v iMessage.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Maximize2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { Trade } from '../types';
import { reducedMotion, useCardTilt } from '../hooks/useCardTilt';
import {
    contractsLabel, exitReasonLabel, shareMoney, sharePrice, shareR, tradePricePath,
    tradeShareHold, tradeShareR, tradeShareStamp, tradeShareWindow, type PricePath,
} from '../lib/tradeShareCard';

const AT_LOGO = '/logos/at_logo_light_clean.png';

export interface TradeShareCardProps {
    trade: Trade;
    owner: { name: string; avatar?: string | null };
    /** Odkaz pro QR v patičce. Bez něj se QR nekreslí (např. na samotné veřejné stránce). */
    shareUrl?: string;
    showNotes?: boolean;
    /** Místo dolarů jen R — sdílení bez prozrazení velikosti účtu. */
    hideAmount?: boolean;
    /** Stabilní export: bez náklonu, dopočítávání čísla a vstupních animací. */
    captureMode?: boolean;
    /** Ovládání v pravém horním rohu (sdílení, zavření). Do exportu se nepředává. */
    toolsSlot?: React.ReactNode;
    onScreenshotClick?: () => void;
    /** Obrázek místo `trade.screenshot` — např. podepsaný snímek z kopírky. */
    screenshotUrl?: string;
    /** Přepínání mezi snímky obchodu přímo na kartě (jen v appce, ne v exportu). */
    imageNav?: { label: string; index: number; total: number; onPrev: () => void; onNext: () => void };
}

const initials = (name: string): string => {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return name.trim().slice(0, 2).toUpperCase() || '?';
};

const toneClass = (value: number): string =>
    value > 0 ? 'live-day-win' : value < 0 ? 'live-day-loss' : 'live-day-flat';

const LEVEL_LABEL: Record<string, string> = { tp: 'TP', sl: 'SL', entry: 'Vstup', exit: 'Výstup' };

/** SL / vstup / výstup / TP na svislé ose a dráha od vstupu k výstupu. */
const TradePricePath: React.FC<{ path: PricePath; pnl: number }> = ({ path, pnl }) => {
    const y = (p: number) => ((path.high - p) / (path.high - path.low)) * 100;
    const yEntry = y(path.entry);
    const yExit = y(path.exit);
    const tone = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat';
    const bend = pnl >= 0 ? 6 : -6;
    return (
        <div className={`trade-card-path trade-card-path-${tone}`}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                <rect x="6" y={Math.min(yEntry, yExit)} width="56" height={Math.max(0.6, Math.abs(yExit - yEntry))} className="trade-card-path-fill" />
                {path.levels.map(level => (
                    <line
                        key={level.kind}
                        x1="0" x2="64" y1={y(level.price)} y2={y(level.price)}
                        className={`trade-card-path-line trade-card-path-${level.kind}`}
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
                <path
                    d={`M6 ${yEntry} C 26 ${yEntry + bend}, 40 ${yExit - bend}, 62 ${yExit}`}
                    className="trade-card-path-run"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
            <span className="trade-card-path-dot trade-card-path-dot-entry" style={{ left: '6%', top: `${yEntry}%` }} />
            <span className="trade-card-path-dot trade-card-path-dot-exit" style={{ left: '62%', top: `${yExit}%` }} />
            {path.levels.map(level => (
                <span key={level.kind} className={`trade-card-path-label trade-card-path-${level.kind}`} style={{ top: `${y(level.price)}%` }}>
                    <b>{level.kind === 'exit' || level.price !== path.exit ? LEVEL_LABEL[level.kind] : `${LEVEL_LABEL[level.kind]} · výstup`}</b>
                    <span>{sharePrice(level.price)}</span>
                </span>
            ))}
        </div>
    );
};

const TradeShareCard: React.FC<TradeShareCardProps> = ({
    trade, owner, shareUrl, showNotes = false, hideAmount = false, captureMode = false, toolsSlot, onScreenshotClick, screenshotUrl, imageNav,
}) => {
    const wrapRef = useRef<HTMLDivElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    // Karta obchodu je skoro dvakrát širší než Karta dne — stejný úhel by ji
    // na okrajích prohnul příliš, proto zhruba poloviční rozpětí.
    useCardTilt(wrapRef, cardRef, captureMode, { hover: 12, press: 16, gyro: 12 });

    const pnl = Number(trade.pnl || 0);
    const r = tradeShareR(trade);
    const isLong = String(trade.direction || '').toLowerCase() === 'long';
    const notes = showNotes && trade.notes ? String(trade.notes).trim() : '';
    const screenshot = screenshotUrl || trade.screenshot || trade.screenshots?.[0] || '';
    const path = screenshot ? null : tradePricePath(trade);
    const timeWindow = tradeShareWindow(trade);
    const contracts = Number(trade.positionSize);
    const reason = exitReasonLabel(trade.exitReason);
    // Skrytá částka: hlavní číslo je R. Bez R by nezbylo nic — pak jen směr výsledku.
    const headline = hideAmount ? (r != null ? shareR(r) : pnl > 0 ? 'Zisk' : pnl < 0 ? 'Ztráta' : 'Break-even') : shareMoney(pnl);
    const meta = [
        !hideAmount && r != null ? shareR(r) : null,
        Number.isFinite(contracts) && contracts > 0 ? contractsLabel(contracts) : null,
        reason,
    ].filter(Boolean) as string[];

    // Číslo se dopočítá jako na Kartě dne. Text (R, „Zisk“) se nedopočítává.
    const target = hideAmount ? null : pnl;
    const [shown, setShown] = useState<number | null>(() => (target == null || captureMode || reducedMotion() ? target : 0));
    useEffect(() => {
        if (target == null || captureMode || reducedMotion()) { setShown(target); return; }
        const start = performance.now();
        let frame = 0;
        const tick = (now: number) => {
            const progress = Math.min(1, (now - start) / 850);
            setShown(target * (1 - Math.pow(1 - progress, 3)));
            if (progress < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [captureMode, target]);

    return (
        <div
            ref={wrapRef}
            className={`live-day-tilt trade-card${captureMode ? ' live-day-capture trade-card-capture' : ''}${pnl < 0 ? ' trade-card-loss' : ''}`}
            data-testid="trade-share-card"
        >
            <div className="live-day-card" ref={cardRef}>
                <div className="live-day-inner">
                    <span className="live-day-aurora" aria-hidden />
                    <span className="live-day-sheen" aria-hidden />
                    <span className="live-day-edge live-day-edge-t" aria-hidden />
                    <span className="live-day-edge live-day-edge-b" aria-hidden />
                    <span className="live-day-edge live-day-edge-r" aria-hidden />
                    <span className="live-day-edge live-day-edge-l" aria-hidden />

                    <div className="live-day-head">
                        <div className="live-day-brand">
                            <img src={AT_LOGO} alt="" crossOrigin="anonymous" />
                            <span className="live-day-wordmark">Alpha <i>Trade</i></span>
                        </div>
                        <div className="live-day-stamp">
                            <div className="live-day-owner">
                                {owner.avatar
                                    ? <img className="live-day-avatar-img" src={owner.avatar} alt="" crossOrigin="anonymous" />
                                    : <span className="live-day-avatar">{initials(owner.name)}</span>}
                                <span>
                                    <span className="live-day-who">{owner.name}</span>
                                    <span className="live-day-date">{tradeShareStamp(trade)}</span>
                                </span>
                            </div>
                            {toolsSlot ? <div className="live-day-tools"><span>{toolsSlot}</span></div> : null}
                        </div>
                    </div>

                    <div className="trade-card-body">
                        <div className="live-day-glass trade-card-total">
                            <div className="trade-card-sym">
                                <b>{trade.instrument || trade.symbol || '—'}</b>
                                <span className={`trade-card-dir ${isLong ? 'trade-card-long' : 'trade-card-short'}`}>
                                    {isLong ? <ArrowUpRight size={12} strokeWidth={3} /> : <ArrowDownRight size={12} strokeWidth={3} />}
                                    {isLong ? 'Long' : 'Short'}
                                </span>
                            </div>
                            {notes ? <p className="trade-card-note">{notes}</p> : null}
                            <div className="trade-card-result">
                                <div className="live-day-k">{hideAmount ? 'Výsledek' : 'P&L'}</div>
                                <div className={`live-day-big trade-card-big ${toneClass(pnl)}`}>
                                    {shown == null ? headline : shareMoney(shown)}
                                </div>
                                {meta.length ? <div className="trade-card-meta">{meta.join(' · ')}</div> : null}
                            </div>
                            <div className="live-day-split">
                                <div>
                                    <div className="live-day-kk">Vstup</div>
                                    <div className="live-day-vv">{sharePrice(trade.entryPrice)}</div>
                                </div>
                                <div>
                                    <div className="live-day-kk">Výstup</div>
                                    <div className="live-day-vv">{sharePrice(trade.exitPrice)}</div>
                                </div>
                                <div>
                                    <div className="live-day-kk">Držení</div>
                                    <div className="live-day-vv">{tradeShareHold(trade)}</div>
                                </div>
                            </div>
                        </div>

                        <div className={`live-day-glass trade-card-media${screenshot ? ' trade-card-media-shot' : ''}`}>
                            {screenshot ? (
                                <div
                                    className={`trade-card-shot${onScreenshotClick && !captureMode ? ' trade-card-shot-zoom' : ''}`}
                                    onClick={captureMode ? undefined : onScreenshotClick}
                                    role={onScreenshotClick && !captureMode ? 'button' : undefined}
                                    title={onScreenshotClick && !captureMode ? 'Zvětšit graf' : undefined}
                                >
                                    <img src={screenshot} alt="" aria-hidden crossOrigin="anonymous" className="trade-card-shot-fill" />
                                    <img src={screenshot} alt="Graf obchodu" crossOrigin="anonymous" className="trade-card-shot-img" />
                                    {trade.session || timeWindow ? (
                                        <div className="trade-card-cap">
                                            {trade.session ? <span>{trade.session}</span> : null}
                                            {timeWindow ? <span>{timeWindow}</span> : null}
                                        </div>
                                    ) : null}
                                    {onScreenshotClick && !captureMode ? <span className="trade-card-zoom-hint"><Maximize2 size={13} /></span> : null}
                                    {imageNav && imageNav.total > 1 && !captureMode ? (
                                        <div className="trade-card-imgnav" onClick={event => event.stopPropagation()}>
                                            <button type="button" onClick={imageNav.onPrev} aria-label="Předchozí snímek"><ChevronLeft size={14} /></button>
                                            <span>{imageNav.label} · {imageNav.index + 1}/{imageNav.total}</span>
                                            <button type="button" onClick={imageNav.onNext} aria-label="Další snímek"><ChevronRight size={14} /></button>
                                        </div>
                                    ) : null}
                                </div>
                            ) : path ? (
                                <>
                                    <div className="live-day-k">Cenová dráha</div>
                                    <TradePricePath path={path} pnl={pnl} />
                                    <div className="live-day-split">
                                        <div>
                                            <div className="live-day-kk">Čas</div>
                                            <div className="live-day-vv">{timeWindow ?? '—'}</div>
                                        </div>
                                        <div>
                                            <div className="live-day-kk">Držení</div>
                                            <div className="live-day-vv">{tradeShareHold(trade)}</div>
                                        </div>
                                        <div>
                                            <div className="live-day-kk">Session</div>
                                            <div className="live-day-vv">{trade.session || '—'}</div>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div className="trade-card-empty">
                                    <b>{trade.instrument || trade.symbol || '—'}</b>
                                    <span>{timeWindow ?? tradeShareStamp(trade)}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="trade-card-foot">
                        <span>Obchodní deník · alphatrade.app</span>
                        {shareUrl ? (
                            <span className="trade-card-qr">
                                <span>Celý obchod</span>
                                <span className="trade-card-qr-code"><QRCodeSVG value={shareUrl} size={34} level="M" /></span>
                            </span>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TradeShareCard;
