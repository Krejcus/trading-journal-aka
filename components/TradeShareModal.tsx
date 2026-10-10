/**
 * TradeShareModal — sdílení obchodu jako karta ve stylu Karty dne z LIVE.
 *
 * Karta se naklání za myší/prstem, ovládání je v jejím pravém horním rohu
 * (sdílení + zavření) a odhalí se po najetí. Sdílení: odkaz na /share/:id,
 * obrázek do schránky, PNG ke stažení a v nativní appce systémový list.
 * Obrázek se kreslí z neviditelné kopie karty v plátně 1200×630.
 *
 * Obchod se zveřejní až první akcí sdílení — samotné otevření okna nic
 * nemění (dřív se obchod zveřejnil hned při otevření náhledu).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, Link as LinkIcon, Loader2, Share2, X } from 'lucide-react';
import { toPng } from 'html-to-image';
import type { Trade } from '../types';
import { storageService } from '../services/storageService';
import TradeShareCard from './TradeShareCard';
import ImageZoomModal from './ImageZoomModal';
import { isNativeBuild } from '../utils/runtimeConfig';
import { shareTextNative, shareTradeImageNative, tradeShareFileName } from '../services/nativeShare';
import { currentLiveDayShareTheme } from '../lib/liveDayShare';

export interface TradeShareImage {
    url: string;
    label: string;
    /** Soukromý snímek z kopírky — na veřejné stránce za odkazem není. */
    private?: boolean;
}

interface Props {
    trade: Trade;
    owner: { name: string; avatar?: string | null };
    /** Snímky z detailu obchodu (ruční + podepsané z kopírky), v pořadí detailu. */
    images?: TradeShareImage[];
    onClose: () => void;
}

/** Výchozí obrázek karty: ruční screenshot, jinak snímek výstupu, jinak první. */
export const defaultShareImageIndex = (images: readonly TradeShareImage[]): number => {
    const manual = images.findIndex(image => !image.private);
    if (manual >= 0) return manual;
    const exit = images.findIndex(image => image.label === 'Výstup');
    return exit >= 0 ? exit : 0;
};

const EXPORT_W = 1200;
const EXPORT_H = 630;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const readPref = (key: string): boolean => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
};
const writePref = (key: string, value: boolean) => {
    try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* soukromé okno */ }
};

const waitForAssets = async (root: HTMLElement): Promise<void> => {
    await document.fonts?.ready;
    await Promise.all([...root.querySelectorAll('img')].map(async image => {
        if (!image.complete) await new Promise<void>(resolve => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => resolve(), { once: true });
        });
        await image.decode?.().catch(() => undefined);
    }));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
};

const Toggle: React.FC<{ on: boolean; label: string; onChange: () => void }> = ({ on, label, onChange }) => (
    <button type="button" role="switch" aria-checked={on} onClick={onChange} className="live-day-sharepop-alt trade-card-toggle">
        <span className={`trade-card-switch${on ? ' trade-card-switch-on' : ''}`} aria-hidden />
        {label}
    </button>
);

const TradeShareModal: React.FC<Props> = ({ trade, owner, images: imagesProp, onClose }) => {
    const exportRef = useRef<HTMLDivElement>(null);
    const popRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<string | null>(null);
    const [published, setPublished] = useState(false);
    const [zoom, setZoom] = useState(false);
    const [theme] = useState(currentLiveDayShareTheme);
    const hasNotes = !!(trade.notes && String(trade.notes).trim());
    const [shareNotes, setShareNotes] = useState(() => readPref('alphatrade_share_notes'));
    const [hideAmount, setHideAmount] = useState(() => readPref('alphatrade_share_hide_amount'));
    const notesOn = shareNotes && hasNotes;

    const tradeId = typeof trade.id === 'string' && UUID.test(trade.id) ? trade.id : null;
    const shareUrl = tradeId ? `${window.location.origin}/share/${tradeId}` : null;
    const fallbackShots = trade.screenshots?.length ? trade.screenshots : trade.screenshot ? [trade.screenshot] : [];
    const images: TradeShareImage[] = imagesProp?.length ? imagesProp : fallbackShots.map(url => ({ url, label: 'Screenshot' }));
    const [imageIndex, setImageIndex] = useState(() => defaultShareImageIndex(images));
    // Snímky z kopírky se podepisují až po otevření detailu — dokud uživatel
    // sám nepřepnul, výchozí obrázek se přepočítá, jakmile dorazí.
    const pickedRef = useRef(false);
    const imagesKey = images.map(item => item.url).join('|');
    useEffect(() => {
        if (!pickedRef.current) setImageIndex(defaultShareImageIndex(images));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- klíčem je seznam URL, ne identita pole
    }, [imagesKey]);
    const image = images[Math.min(imageIndex, images.length - 1)] ?? null;
    const step = (delta: number) => {
        pickedRef.current = true;
        setImageIndex(index => (index + delta + images.length) % images.length);
    };

    useEffect(() => {
        const original = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const key = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || zoom) return;
            if (open) setOpen(false); else onClose();
        };
        window.addEventListener('keydown', key);
        return () => {
            document.body.style.overflow = original;
            window.removeEventListener('keydown', key);
        };
    }, [onClose, open, zoom]);

    // Bublina se zavře klepnutím mimo ni (ne mimo kartu — to zavírá okno).
    useEffect(() => {
        if (!open) return;
        const down = (event: PointerEvent) => {
            if (popRef.current && !popRef.current.contains(event.target as Node)) setOpen(false);
        };
        window.addEventListener('pointerdown', down, true);
        return () => window.removeEventListener('pointerdown', down, true);
    }, [open]);

    // Už zveřejněný obchod musí změnu „poznámka ano/ne“ promítnout i do odkazu.
    useEffect(() => {
        if (!published || !tradeId) return;
        storageService.markTradeAsPublic(tradeId, notesOn).catch(error => {
            console.warn('[Share] Failed to update public notes flag:', error);
            setFeedback('Změnu poznámky v odkazu se nepodařilo uložit.');
        });
    }, [notesOn, published, tradeId]);

    const publish = useCallback(async () => {
        if (!tradeId) throw new Error('Tento obchod zatím nejde sdílet odkazem — ulož ho a zkus to znovu.');
        if (published) return;
        await storageService.markTradeAsPublic(tradeId, notesOn);
        setPublished(true);
    }, [notesOn, published, tradeId]);

    const renderPng = useCallback(async (): Promise<Blob> => {
        const node = exportRef.current;
        if (!node) throw new Error('Náhled karty není připravený.');
        await waitForAssets(node);
        const dataUrl = await toPng(node, {
            width: EXPORT_W,
            height: EXPORT_H,
            pixelRatio: 2,
            cacheBust: true,
            skipFonts: true,
            backgroundColor: theme === 'light' ? '#e2e8f0' : '#020617',
        }).catch((error: unknown) => {
            if (error instanceof Error) throw error;
            // html-to-image při nenačteném obrázku hází holý Event, ne Error.
            throw new Error('Obrázek se nepodařilo vykreslit — graf obchodu se nenačetl.');
        });
        const blob = await fetch(dataUrl).then(response => response.blob());
        if (blob.size < 1000) throw new Error('Obrázek se nepodařilo vykreslit.');
        return blob;
    }, [theme]);

    const run = useCallback(async (key: string, action: () => Promise<string | null>) => {
        if (busy) return;
        setBusy(key);
        setFeedback(null);
        try {
            const message = await action();
            if (message) setFeedback(message);
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('[Share]', error);
            setFeedback(error instanceof Error ? error.message : 'Sdílení se nepodařilo.');
        } finally {
            setBusy(null);
        }
    }, [busy]);

    const copyLink = () => run('link', async () => {
        await publish();
        // Sdílí se jen odkaz — průvodní text by chat slepil s URL do jednoho řetězce.
        if (isNativeBuild) {
            const result = await shareTextNative({ text: shareUrl! });
            return result.completed ? 'Odkaz sdílen' : null;
        }
        await navigator.clipboard.writeText(shareUrl!);
        return 'Odkaz zkopírován';
    });

    const copyImage = () => run('image', async () => {
        if (typeof ClipboardItem === 'undefined') throw new Error('Prohlížeč neumí kopírovat obrázek — použij Stáhnout PNG.');
        // Safari chce ClipboardItem vytvořit hned v gestu (před prvním await),
        // obsah smí dorazit později.
        const png = (async () => {
            if (shareUrl) await publish();
            return renderPng();
        })();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        return 'Obrázek zkopírován — vlož ⌘V';
    });

    const download = () => run('download', async () => {
        if (shareUrl) await publish();
        const blob = await renderPng();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = tradeShareFileName(trade.instrument, trade.date);
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        return 'Staženo';
    });

    const shareImageNative = () => run('native', async () => {
        if (shareUrl) await publish();
        const result = await shareTradeImageNative({
            image: await renderPng(),
            fileName: tradeShareFileName(trade.instrument, trade.date),
            url: shareUrl ?? undefined,
        });
        return result.completed ? 'Sdíleno' : null;
    });

    const icon = (key: string, idle: React.ReactNode) => (busy === key ? <Loader2 size={13} className="animate-spin" /> : idle);

    const tools = (
        <>
            <div className="relative" ref={popRef}>
                <button
                    type="button"
                    onClick={() => setOpen(value => !value)}
                    aria-label="Sdílet obchod"
                    aria-expanded={open}
                    title="Sdílet obchod"
                    className="live-day-ghost"
                >
                    {busy ? <Loader2 size={13} className="animate-spin" /> : published ? <Check size={13} /> : <Share2 size={13} />}
                </button>
                {open ? (
                    <div className="live-day-sharepop trade-card-sharepop" role="dialog" aria-label="Sdílení obchodu">
                        {isNativeBuild ? (
                            <button type="button" onClick={() => void shareImageNative()} disabled={!!busy} className="live-day-sharepop-main">
                                {icon('native', <Share2 size={13} />)} Sdílet obrázek
                            </button>
                        ) : null}
                        {shareUrl ? (
                            <button type="button" onClick={() => void copyLink()} disabled={!!busy} className={isNativeBuild ? 'live-day-sharepop-alt' : 'live-day-sharepop-main'}>
                                {icon('link', <LinkIcon size={13} />)} {isNativeBuild ? 'Sdílet odkaz' : 'Kopírovat odkaz'}
                            </button>
                        ) : null}
                        {!isNativeBuild ? (
                            <button type="button" onClick={() => void copyImage()} disabled={!!busy} className="live-day-sharepop-alt">
                                {icon('image', <Copy size={13} />)} Kopírovat obrázek
                            </button>
                        ) : null}
                        <button type="button" onClick={() => void download()} disabled={!!busy} className="live-day-sharepop-alt">
                            {icon('download', <Download size={13} />)} Stáhnout PNG
                        </button>
                        <span className="trade-card-sharepop-sep" aria-hidden />
                        <Toggle on={hideAmount} label="Skrýt částku" onChange={() => { const next = !hideAmount; setHideAmount(next); writePref('alphatrade_share_hide_amount', next); }} />
                        {hasNotes ? (
                            <Toggle on={shareNotes} label="Přidat poznámku" onChange={() => { const next = !shareNotes; setShareNotes(next); writePref('alphatrade_share_notes', next); }} />
                        ) : null}
                        <p aria-live="polite" className="live-day-sharepop-note">
                            {feedback ?? (!shareUrl
                                ? 'Sloučený obchod z více účtů jde sdílet jen jako obrázek.'
                                : image?.private
                                    ? 'Snímek z kopírky je jen v obrázku — stránka za odkazem ukáže cenovou dráhu.'
                                : hideAmount
                                    ? 'Částka zmizí z obrázku. Stránka za odkazem ji ukazuje dál.'
                                    : 'Odkaz i QR zpřístupní obchod každému, kdo je dostane.')}
                        </p>
                    </div>
                ) : null}
            </div>
            <button type="button" onClick={onClose} className="live-day-close" aria-label="Zavřít">
                <X size={14} />
            </button>
        </>
    );

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Sdílení obchodu"
            className="trade-share-overlay fixed inset-0 z-[200] overflow-y-auto bg-slate-900/25 p-4 backdrop-blur-md sm:p-7"
            onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
        >
            <div
                className="mx-auto flex min-h-full w-full max-w-[1040px] items-center justify-center"
                onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
            >
                <div className="w-full">
                    <TradeShareCard
                        trade={trade}
                        owner={owner}
                        shareUrl={shareUrl ?? undefined}
                        showNotes={notesOn}
                        hideAmount={hideAmount}
                        toolsSlot={tools}
                        screenshotUrl={image?.url}
                        imageNav={image ? { label: image.label, index: Math.min(imageIndex, images.length - 1), total: images.length, onPrev: () => step(-1), onNext: () => step(1) } : undefined}
                        onScreenshotClick={image ? () => setZoom(true) : undefined}
                    />
                </div>
            </div>

            {/* Neviditelná kopie pro export: pevné plátno 1200×630, motiv appky. */}
            <div
                aria-hidden="true"
                className={theme === 'light' ? 'light-theme' : theme === 'oled' ? 'oled-theme' : undefined}
                style={{ position: 'fixed', left: -20_000, top: 0, width: EXPORT_W, height: EXPORT_H, pointerEvents: 'none' }}
            >
                <div
                    ref={exportRef}
                    className="trade-card-export"
                    style={{
                        width: EXPORT_W,
                        height: EXPORT_H,
                        background: theme === 'light'
                            ? 'radial-gradient(circle at 20% 5%, #cffafe 0, transparent 38%), radial-gradient(circle at 90% 90%, #d1fae5 0, transparent 36%), #e2e8f0'
                            : 'radial-gradient(circle at 20% 5%, #083344 0, transparent 38%), radial-gradient(circle at 90% 90%, #052e2b 0, transparent 36%), #020617',
                    }}
                >
                    <TradeShareCard
                        trade={trade}
                        owner={owner}
                        shareUrl={shareUrl ?? undefined}
                        showNotes={notesOn}
                        hideAmount={hideAmount}
                        screenshotUrl={image?.url}
                        captureMode
                    />
                </div>
            </div>

            {zoom && images.length > 0 ? <ImageZoomModal images={images.map(item => item.url)} initialIndex={Math.min(imageIndex, images.length - 1)} onIndexChange={setImageIndex} onClose={() => setZoom(false)} /> : null}
        </div>,
        document.body,
    );
};

export default TradeShareModal;
