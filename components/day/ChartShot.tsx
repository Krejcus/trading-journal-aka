import React, { useEffect, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { isNativeBuild } from '../../utils/runtimeConfig';
import { saveImageToPhotosNative, shareTradeImageNative } from '../../services/nativeShare';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';

export interface ChartShot {
  key: number;
  url: string;
  blob: Promise<Blob>;
  fileName: string;
  state: 'copying' | 'copied' | 'taken' | 'saved' | 'error';
  message?: string;
}

const HIDE_MS = 2500;

/** Graf + proužek s popisem (symbol · interval · čas) a značkou, jako snímek z PC. */
export function composeChartShot(api: ChartViewApi, title: string): HTMLCanvasElement {
  const chart = api.controller.getChart().takeScreenshot(true, false);
  const ratio = Math.max(1, chart.width / Math.max(1, api.controller.getChart().chartElement().clientWidth));
  const head = Math.round(34 * ratio);
  const out = document.createElement('canvas');
  out.width = chart.width;
  out.height = chart.height + head;
  const ctx = out.getContext('2d');
  if (!ctx) return chart;
  ctx.fillStyle = '#070914';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(chart, 0, head);
  ctx.font = `600 ${Math.round(13 * ratio)}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e7ecf3';
  ctx.fillText(title, Math.round(12 * ratio), head / 2);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#8fa3ff';
  ctx.fillText('AlphaTrade', out.width - Math.round(12 * ratio), head / 2);
  return out;
}

/**
 * Snímek do schránky. Musí běžet přímo v klepnutí: Safari / WKWebView chce
 * ClipboardItem vytvořit v gestu (před prvním await), obsah smí dorazit později.
 */
export function takeChartShot(canvas: HTMLCanvasElement, fileName: string, onCopied: (ok: boolean) => void): ChartShot {
  const blob = new Promise<Blob>((resolve, reject) => canvas.toBlob(result => (result ? resolve(result) : reject(new Error('PNG se nepodařilo vytvořit.'))), 'image/png'));
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => onCopied(true), () => onCopied(false));
    } else {
      queueMicrotask(() => onCopied(false));
    }
  } catch {
    queueMicrotask(() => onCopied(false));
  }
  return { key: Date.now(), url: canvas.toDataURL('image/png'), blob, fileName, state: 'copying' };
}

/** Bílý záblesk přes graf při focení. */
export function ChartShotFlash() {
  return <div aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 29, pointerEvents: 'none', background: '#fff', animation: 'dj-flash .32s ease-out both' }} />;
}

/**
 * Náhled snímku vlevo dole jako na iOS: Sdílet / Uložit, sám zmizí po 2,5 s.
 * Dotyk karty (mimo tlačítka) ji zavře hned.
 */
export function ChartShotCard({ shot, onChange, onClose }: { shot: ChartShot; onChange: (next: ChartShot) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const hide = useRef(0);
  useEffect(() => {
    window.clearTimeout(hide.current);
    if (busy || shot.state === 'copying') return;
    hide.current = window.setTimeout(onClose, shot.state === 'error' ? HIDE_MS * 1.6 : HIDE_MS);
    return () => window.clearTimeout(hide.current);
  }, [busy, onClose, shot.state, shot.key]);

  const run = async (action: 'share' | 'save') => {
    setBusy(true);
    playNativeHapticIfAvailable('light');
    try {
      const image = await shot.blob;
      if (isNativeBuild) {
        if (action === 'share') await shareTradeImageNative({ image, fileName: shot.fileName });
        else await saveImageToPhotosNative(image);
      } else {
        const file = new File([image], shot.fileName, { type: 'image/png' });
        if (action === 'share' && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
        else {
          const link = document.createElement('a');
          link.href = URL.createObjectURL(image);
          link.download = shot.fileName;
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        }
      }
      if (action === 'save') onChange({ ...shot, state: 'saved' });
      else onClose();
    } catch (error) {
      // Zavřený list sdílení není chyba.
      if (error instanceof Error && /abort|cancel/i.test(`${error.name} ${error.message}`)) onClose();
      else onChange({ ...shot, state: 'error', message: error instanceof Error ? error.message : 'Akce se nepovedla.' });
    } finally {
      setBusy(false);
    }
  };

  const title = shot.state === 'copied' ? 'Zkopírováno do schránky'
    : shot.state === 'saved' ? 'Uloženo do Fotek'
      : shot.state === 'error' ? 'Nepovedlo se'
        : 'Snímek pořízen';
  const sub = shot.state === 'copying' ? 'Kopíruju do schránky…'
    : shot.state === 'copied' ? 'Vlož kamkoli: podrž prst a Vložit'
      : shot.state === 'saved' ? 'Najdeš ho ve Fotkách'
        : shot.state === 'error' ? shot.message ?? ''
          : 'Schránka zápis nepovolila — použij Sdílet';
  const button: React.CSSProperties = { height: 34, padding: '0 11px', borderRadius: 10, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', color: 'var(--dj-text)', font: '700 12.5px Inter, sans-serif', cursor: 'pointer', opacity: busy ? 0.5 : 1 };
  return (
    <div
      role="status"
      onClick={event => { if (!(event.target as HTMLElement).closest('button')) onClose(); }}
      style={{ position: 'absolute', left: 10, right: 10, bottom: 12, zIndex: 31, display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 16, border: '1px solid var(--dj-line)', background: 'var(--dj-glass, rgba(13,18,27,.94))', backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)', boxShadow: '0 18px 40px -18px rgba(0,0,0,.8)', animation: 'dj-shot-in .36s cubic-bezier(.2,.9,.25,1) both' }}
    >
      <img src={shot.url} alt="Snímek grafu" style={{ width: 58, height: 86, objectFit: 'cover', objectPosition: 'right center', borderRadius: 9, border: '1px solid var(--dj-line)', flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
        <b style={{ fontSize: 13.5 }}>{title}</b>
        <span style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{sub}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="dj-btn" disabled={busy} onClick={() => void run('share')} style={button}>Sdílet</button>
        <button type="button" className="dj-btn" disabled={busy} onClick={() => void run('save')} style={button}>Uložit</button>
      </div>
    </div>
  );
}
