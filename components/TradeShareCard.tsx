/**
 * TradeShareCard — Production komponent pro generování shareable trade cards.
 *
 * Renderuje 1600×900 kartu s AlphaTrade brandingem, glass-morphism layoutem,
 * real trade daty + QR kódem na public trade URL.
 *
 * Použití:
 *   <TradeShareCard trade={trade} username="@filipkrejca" shareUrl="https://..." />
 *
 * Card má fixed dimensions (1600×900) takže `html-to-image` ji exportuje
 * v exact pixel perfect kvalitě bez ohledu na viewport.
 */
import React from 'react';
import { ArrowUpRight, ArrowDownRight, Target, Timer, Calendar, Image as ImageIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { Trade } from '../types';

interface Props {
    trade: Trade;
    username?: string;
    /** URL na uživatelův avatar — pokud chybí, vyrenderuje se gradient kruh s iniciálkou. */
    avatarUrl?: string;
    shareUrl?: string;
    /** Pokud true, ukáže "Scan for full detail" + QR. Default true. */
    showQR?: boolean;
    /** Pokud true a trade má poznámku, vyrenderuje ji jako kartu. Default false (soukromí). */
    showNotes?: boolean;
}

/** Formátuje datum trade do "DD. MM. YYYY · HH:MM" */
function formatTradeDate(trade: Trade): string {
    try {
        const d = new Date(trade.entryTime || trade.timestamp || trade.date);
        if (isNaN(d.getTime())) return '—';
        const date = d.toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const time = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
        return `${date} · ${time}`;
    } catch { return '—'; }
}

/** Formátuje hold time z duration string nebo durationMinutes */
function formatHoldTime(trade: Trade): string {
    if (trade.duration) return trade.duration;
    if (trade.durationMinutes) {
        const m = Math.round(Number(trade.durationMinutes));
        if (m < 60) return `${m}m`;
        return `${Math.floor(m / 60)}h ${m % 60}m`;
    }
    return '—';
}

/** R-multiple z pnl / riskAmount */
function calcR(trade: Trade): number | null {
    if (!trade.riskAmount || trade.riskAmount <= 0) return null;
    return trade.pnl / trade.riskAmount;
}

const TradeShareCard: React.FC<Props> = ({ trade, username = '@trader', avatarUrl, shareUrl, showQR = true, showNotes = false }) => {
    const notes = (showNotes && trade.notes) ? String(trade.notes).trim() : '';
    const pnl = Number(trade.pnl || 0);
    const isWin = pnl > 0;
    const isLong = String(trade.direction || '').toLowerCase() === 'long';
    const r = calcR(trade);
    const accentColor = isWin ? '#22c55e' : '#f87171';
    const directionColor = isLong ? '#22c55e' : '#f87171';

    const htfTags = (trade.htfConfluence || []).slice(0, 3);
    const ltfTags = (trade.ltfConfluence || []).slice(0, 4);

    // Get screenshot from trade
    const screenshot = trade.screenshot || (trade.screenshots && trade.screenshots[0]);

    return (
        <div
            id="trade-share-card"
            style={{
                width: 1600,
                height: 900,
                fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                background: 'radial-gradient(ellipse at top left, rgba(34,211,238,0.08) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(16,185,129,0.06) 0%, transparent 50%), linear-gradient(180deg, #0a0e1a 0%, #050810 100%)',
                color: 'white',
                padding: 56,
                position: 'relative',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            {/* Grid pattern */}
            <div style={{
                position: 'absolute', inset: 0,
                backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)',
                backgroundSize: '48px 48px',
                pointerEvents: 'none',
            }} />
            {/* Cyan aurora glow */}
            <div style={{
                position: 'absolute',
                top: -100, left: '50%', transform: 'translateX(-50%)',
                width: 800, height: 300,
                background: 'radial-gradient(ellipse, rgba(34,211,238,0.12) 0%, transparent 70%)',
                pointerEvents: 'none',
                filter: 'blur(40px)',
            }} />

            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 40, position: 'relative', zIndex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                    <img
                        src="/logos/at_logo_light_clean.png"
                        alt="Alpha Trade"
                        crossOrigin="anonymous"
                        style={{
                            width: 64, height: 64,
                            objectFit: 'contain',
                            filter: 'drop-shadow(0 0 20px rgba(34,211,238,0.4))',
                        }}
                    />
                    <h1 style={{
                        fontSize: 28, fontWeight: 200, letterSpacing: '0.5em',
                        textTransform: 'uppercase', margin: 0, lineHeight: 1,
                    }}>
                        ALPHA <span style={{ color: '#22d3ee', fontWeight: 400 }}>TRADE</span>
                    </h1>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: 'rgba(34,211,238,0.7)', textTransform: 'uppercase', letterSpacing: '0.4em' }}>EXECUTED</span>
                    <span style={{ fontSize: 18, fontWeight: 500, color: 'rgba(255,255,255,0.85)', fontFamily: 'ui-monospace, monospace', marginTop: 4 }}>
                        {formatTradeDate(trade)}
                    </span>
                </div>
            </div>

            {/* Main grid */}
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '380px 1fr', gap: 24, position: 'relative', zIndex: 1, minHeight: 0 }}>
                {/* LEFT: stat cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    {/* Instrument */}
                    <div style={{
                        padding: 28, borderRadius: 24,
                        background: 'rgba(255,255,255,0.025)',
                        backdropFilter: 'blur(20px)',
                        border: '1px solid rgba(34,211,238,0.12)',
                    }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 10 }}>Instrument</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <span style={{ fontSize: 48, fontWeight: 500, letterSpacing: '-0.03em' }}>{trade.instrument || '—'}</span>
                            <div style={{
                                padding: '6px 14px', borderRadius: 999,
                                background: isLong ? 'rgba(34,197,94,0.2)' : 'rgba(248,113,113,0.2)',
                                border: `1px solid ${directionColor}66`,
                                color: directionColor,
                                fontSize: 14, fontWeight: 800,
                                display: 'flex', alignItems: 'center', gap: 6,
                                letterSpacing: '0.1em',
                            }}>
                                {isLong ? <ArrowUpRight size={14} strokeWidth={3} /> : <ArrowDownRight size={14} strokeWidth={3} />}
                                {(trade.direction || '').toUpperCase()}
                            </div>
                        </div>
                    </div>

                    {/* PnL */}
                    <div style={{
                        padding: 28, borderRadius: 24,
                        background: 'rgba(255,255,255,0.025)',
                        backdropFilter: 'blur(20px)',
                        border: '1px solid rgba(34,211,238,0.12)',
                    }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 10 }}>Profit / Loss</div>
                        <div style={{
                            fontSize: 64, fontWeight: 500,
                            color: accentColor,
                            fontFamily: 'ui-monospace, monospace',
                            letterSpacing: '-0.03em', lineHeight: 1,
                        }}>
                            {pnl >= 0 ? '+' : ''}${Math.abs(Math.round(pnl)).toLocaleString()}
                        </div>
                    </div>

                    {/* R/R */}
                    <div style={{
                        padding: 28, borderRadius: 24,
                        background: 'rgba(255,255,255,0.025)',
                        backdropFilter: 'blur(20px)',
                        border: '1px solid rgba(34,211,238,0.12)',
                    }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 10 }}>Reward / Risk</div>
                        <div style={{
                            fontSize: 44, fontWeight: 500,
                            color: r != null && r >= 0 ? '#22c55e' : '#f87171',
                            fontFamily: 'monospace',
                        }}>
                            {r != null ? `${r >= 0 ? '+' : ''}${r.toFixed(1)}R` : '—'}
                        </div>
                    </div>

                    {/* Notes — jen když showNotes && trade.notes (default skryto, soukromí) */}
                    {notes && (
                        <div style={{
                            flex: 1, minHeight: 0,
                            padding: 28, borderRadius: 24,
                            background: 'rgba(255,255,255,0.025)',
                            backdropFilter: 'blur(20px)',
                            border: '1px solid rgba(34,211,238,0.12)',
                            display: 'flex', flexDirection: 'column',
                        }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 12 }}>Poznámka</div>
                            <div style={{
                                fontSize: 19, fontWeight: 400, lineHeight: 1.5,
                                color: 'rgba(255,255,255,0.82)',
                                overflow: 'hidden',
                                display: '-webkit-box',
                                WebkitLineClamp: 6,
                                WebkitBoxOrient: 'vertical',
                            }}>{notes}</div>
                        </div>
                    )}
                </div>

                {/* RIGHT: confluence + chart + stats */}
                <div style={{
                    padding: 32, borderRadius: 24,
                    background: 'rgba(255,255,255,0.025)',
                    backdropFilter: 'blur(20px)',
                    border: '1px solid rgba(34,211,238,0.12)',
                    display: 'flex', flexDirection: 'column',
                    minHeight: 0,
                }}>
                    {/* Confluence tags */}
                    {(htfTags.length > 0 || ltfTags.length > 0) && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
                            {htfTags.length > 0 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.25em', minWidth: 30 }}>HTF</span>
                                    {htfTags.map(tag => (
                                        <span key={tag} style={{
                                            padding: '5px 11px', borderRadius: 8,
                                            background: 'rgba(34,211,238,0.12)',
                                            border: '1px solid rgba(34,211,238,0.3)',
                                            color: '#67e8f9',
                                            fontSize: 12, fontWeight: 800,
                                            textTransform: 'uppercase', letterSpacing: '0.08em',
                                        }}>{tag}</span>
                                    ))}
                                </div>
                            )}
                            {ltfTags.length > 0 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.25em', minWidth: 30 }}>LTF</span>
                                    {ltfTags.map(tag => (
                                        <span key={tag} style={{
                                            padding: '5px 11px', borderRadius: 8,
                                            background: 'rgba(245,158,11,0.18)',
                                            border: '1px solid rgba(245,158,11,0.3)',
                                            color: '#fcd34d',
                                            fontSize: 12, fontWeight: 800,
                                            textTransform: 'uppercase', letterSpacing: '0.08em',
                                        }}>{tag}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Chart / Screenshot */}
                    <div style={{
                        flex: 1,
                        borderRadius: 16,
                        background: 'rgba(0,0,0,0.2)',
                        border: '1px solid rgba(255,255,255,0.06)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden',
                        position: 'relative',
                        minHeight: 0,
                    }}>
                        {screenshot ? (
                            <img
                                src={screenshot}
                                crossOrigin="anonymous"
                                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                                alt="Trade chart"
                            />
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'rgba(255,255,255,0.3)' }}>
                                <ImageIcon size={64} strokeWidth={1.5} />
                                <span style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.2em' }}>No screenshot</span>
                            </div>
                        )}
                    </div>

                    {/* Bottom stats row */}
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 12,
                        marginTop: 20,
                    }}>
                        {[
                            { label: 'Entry', value: trade.entryPrice ? Number(trade.entryPrice).toLocaleString() : '—', icon: <Target size={12} /> },
                            { label: 'Exit', value: trade.exitPrice ? Number(trade.exitPrice).toLocaleString() : '—', icon: isLong ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} /> },
                            { label: 'Hold', value: formatHoldTime(trade), icon: <Timer size={12} /> },
                            { label: 'Session', value: trade.session || '—', icon: <Calendar size={12} /> },
                        ].map(s => (
                            <div key={s.label} style={{
                                padding: '12px 14px',
                                borderRadius: 12,
                                background: 'rgba(0,0,0,0.2)',
                                border: '1px solid rgba(255,255,255,0.05)',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
                                    {s.icon}
                                    <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.2em' }}>{s.label}</span>
                                </div>
                                <div style={{ fontSize: 18, fontWeight: 500, color: 'white', fontFamily: 'monospace' }}>{s.value}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 32, position: 'relative', zIndex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    {avatarUrl ? (
                        <img
                            src={avatarUrl}
                            crossOrigin="anonymous"
                            alt={username}
                            style={{
                                width: 48, height: 48,
                                borderRadius: 999,
                                objectFit: 'cover',
                                border: '2px solid rgba(34,211,238,0.3)',
                            }}
                        />
                    ) : (
                        <div style={{
                            width: 48, height: 48,
                            borderRadius: 999,
                            background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 22, fontWeight: 700,
                        }}>{username.charAt(1)?.toUpperCase() || 'T'}</div>
                    )}
                    <div>
                        <div style={{ fontSize: 20, fontWeight: 700 }}>{username}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.15em' }}>Shared via AlphaTrade</div>
                    </div>
                </div>
                {showQR && shareUrl && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: 14, fontWeight: 700 }}>Scan for full detail</div>
                            <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.2em' }}>alphatrade.app</div>
                        </div>
                        <div style={{ padding: 6, background: 'white', borderRadius: 10 }}>
                            <QRCodeSVG value={shareUrl} size={60} level="M" />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TradeShareCard;
