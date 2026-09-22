const decoded = new Set<string>();
const inFlight = new Map<string, Promise<void>>();
const MAX_DECODED_IMAGES = 96;

const browserDecode = async (url: string): Promise<void> => {
  if (typeof Image === 'undefined') return;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('image-load-failed'));
    image.src = url;
  });
  if (typeof image.decode === 'function') await image.decode().catch(() => undefined);
};

/** Waits until image bytes are loaded and decoded. Repeated callers share the
 * same promise, so a carousel can warm all adjacent screenshots cheaply. */
export function preloadDecodedImage(url: string, load: (url: string) => Promise<void> = browserDecode): Promise<void> {
  if (decoded.has(url)) return Promise.resolve();
  const pending = inFlight.get(url);
  if (pending) return pending;
  const request = load(url).then(() => {
    if (decoded.size >= MAX_DECODED_IMAGES) {
      const oldest = decoded.values().next().value;
      if (oldest) decoded.delete(oldest);
    }
    decoded.add(url);
  }).finally(() => inFlight.delete(url));
  inFlight.set(url, request);
  return request;
}

export function isImageDecoded(url: string): boolean {
  return decoded.has(url);
}

export function __resetImageDecodeCacheForTests(): void {
  decoded.clear();
  inFlight.clear();
}
