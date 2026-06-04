// Client-side image resize před uploadem do Supabase Storage.
//
// CÍL: redukovat origin file size, šetřit Image Transformations quotu i bandwidth.
// Trade screenshoty z TradingView jsou typicky 1920×1080+ PNG (1-3 MB).
// Po resize na 1600px wide JPEG q85 → ~150-250 KB. Vizuálně neznatelný rozdíl.
//
// API:
//   resizeImageDataUrl(dataUrl, opts?) → Promise<string> (vždy data URL — JPEG)
//   uploadScreenshot interně volá resizeImageDataUrl před uploadem.

export interface ResizeOptions {
  /** Max width v px. Aspect ratio se zachová. Default 1600. */
  maxWidth?: number;
  /** Max height v px. Aspect ratio se zachová. Default 1600. */
  maxHeight?: number;
  /** JPEG kvalita 0–1. Default 0.85. */
  quality?: number;
  /** MIME výstup. Default 'image/jpeg' (menší než PNG). */
  outputType?: 'image/jpeg' | 'image/webp' | 'image/png';
  /** Skip resize pokud je origin menší než tato hranice (KB). Default 200 KB. */
  skipIfSmallerThanKB?: number;
}

/**
 * Resize base64 dataURL na max dimenze + překonvertuje na JPEG.
 * Pokud origin už je menší než threshold, vrátí ho beze změny (no-op).
 * Pass-through pro non-data URLs (už uploadnuté).
 */
export async function resizeImageDataUrl(
  dataUrl: string,
  opts: ResizeOptions = {}
): Promise<string> {
  if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl;

  const {
    maxWidth = 1600,
    maxHeight = 1600,
    quality = 0.85,
    outputType = 'image/jpeg',
    skipIfSmallerThanKB = 200,
  } = opts;

  // Quick size check — base64 délka × 0.75 ≈ bytes
  const approxBytes = (dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75;
  const approxKB = approxBytes / 1024;
  if (approxKB < skipIfSmallerThanKB) {
    // Origin už malý — neresizuj (zachová PNG quality pokud byl PNG)
    return dataUrl;
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        let { width, height } = img;
        // Spočítej target dimenze (zachová aspect, fits inside maxWidth×maxHeight)
        const ratio = Math.min(maxWidth / width, maxHeight / height, 1);
        const targetW = Math.round(width * ratio);
        const targetH = Math.round(height * ratio);

        if (ratio >= 1) {
          // Origin už menší než target → resize netřeba, jen rekomprese
          width = targetW;
          height = targetH;
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl); // canvas not available → vrať originál
          return;
        }
        // High-quality smoothing
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetW, targetH);

        const out = canvas.toDataURL(outputType, quality);
        // Sanity check — pokud rekomprese paradoxně zvětšila (rare, ale stane se
        // u malých PNG s plochými barvami), vrať origin
        if (out.length > dataUrl.length) {
          resolve(dataUrl);
          return;
        }
        resolve(out);
      } catch (e) {
        console.warn('[imageResize] failed, returning original:', e);
        resolve(dataUrl);
      }
    };
    img.onerror = () => {
      console.warn('[imageResize] image load failed, returning original');
      resolve(dataUrl); // fallback: zachovej originál
    };
    img.src = dataUrl;
  });
}

/**
 * Quick stats helper — vrací před/po velikosti pro debug log.
 */
export function dataUrlSizeKB(dataUrl: string): number {
  if (!dataUrl || !dataUrl.startsWith('data:')) return 0;
  return Math.round(((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75) / 1024);
}
