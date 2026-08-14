import { isNativeBuild } from '../utils/runtimeConfig';
import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';

interface NativeSharePlugin {
  shareFile(options: {
    base64: string;
    fileName: string;
    text?: string;
    url?: string;
  }): Promise<{ completed: boolean; activityType?: string }>;
  shareText(options: {
    text: string;
    url?: string;
  }): Promise<{ completed: boolean; activityType?: string }>;
}

export async function shareTextNative(options: {
  text: string;
  url?: string;
}): Promise<{ completed: boolean; activityType?: string }> {
  if (!isNativeBuild) throw new Error('Systémové sdílení je dostupné jen v nativní aplikaci.');
  if (!options.text.trim() && !options.url) throw new Error('Není co sdílet.');
  return AlphaTradeNative.shareText(options);
}

const AlphaTradeNative = alphaTradeNativePlugin as unknown as NativeSharePlugin;

export function tradeShareFileName(instrument: string | undefined, date: string | number | undefined): string {
  const safeInstrument = (instrument || 'trade').replace(/[^a-z0-9_-]/gi, '_');
  const parsedDate = new Date(date || Date.now());
  const day = Number.isNaN(parsedDate.getTime())
    ? new Date().toISOString().slice(0, 10)
    : parsedDate.toISOString().slice(0, 10);
  return `alphatrade_${safeInstrument}_${day}.png`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Obrázek se nepodařilo načíst.'));
    reader.onerror = () => reject(reader.error ?? new Error('Obrázek se nepodařilo načíst.'));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

export async function shareTradeImageNative(options: {
  image: Blob;
  fileName: string;
  text?: string;
  url?: string;
}): Promise<{ completed: boolean; activityType?: string }> {
  if (!isNativeBuild) throw new Error('Systémové sdílení je dostupné jen v nativní aplikaci.');
  return AlphaTradeNative.shareFile({
    base64: await blobToBase64(options.image),
    fileName: options.fileName,
    text: options.text,
    url: options.url,
  });
}
