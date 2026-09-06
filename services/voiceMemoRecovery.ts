import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';
import { isNativeBuild } from '../utils/runtimeConfig';

/** Keep the recording until its transcript is accepted or the user discards it. */
export function createVoiceMemoRecovery(transcribe: (blob: Blob) => Promise<string>, accept: (text: string) => void) {
  let blob: Blob | null = null;
  let generation = 0;
  let pending: Promise<void> | null = null;
  return {
    get blob() { return blob; },
    retain(value: Blob) { generation++; blob = value; pending = null; },
    clear() { generation++; blob = null; pending = null; },
    retry(): Promise<void> {
      if (pending) return pending;
      if (!blob) return Promise.reject(new Error('Není uložená nahrávka.'));
      const audio = blob;
      const epoch = generation;
      const operation = (async () => {
        const text = (await transcribe(audio)).trim();
        if (epoch !== generation) return;
        if (!text) throw new Error('V nahrávce se nepodařilo rozpoznat řeč. Můžeš ji uložit nebo zkusit přepis znovu.');
        accept(text);
        blob = null;
      })();
      pending = operation;
      void operation.finally(() => { if (pending === operation) pending = null; }).catch(() => undefined);
      return operation;
    },
  };
}

export async function exportVoiceMemo(blob: Blob): Promise<void> {
  const mime = blob.type.split(';')[0].toLowerCase();
  const extension = ({ 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
    'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' } as Record<string, string>)[mime] ?? 'webm';
  const fileName = `alphatrade-memo-${Date.now()}.${extension}`;
  if (isNativeBuild) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    await alphaTradeNativePlugin.shareFile({ base64: btoa(binary), fileName });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    // Let the browser consume the URL before releasing its backing blob.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
