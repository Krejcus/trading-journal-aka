/**
 * Profile avatars are stored inline (data URL) in profiles.avatar_url and
 * travel with every dashboard read. A phone photo straight from the camera
 * is 3–4 MB of base64, so the upload is downscaled to a small square JPEG.
 */
export const AVATAR_MAX_EDGE_PX = 256;
export const AVATAR_JPEG_QUALITY = 0.85;
/** Avatars above this many bytes are left out of the dashboard payload and fetched after the first paint. */
export const AVATAR_INLINE_LIMIT_BYTES = 262_144;

export function isOversizedAvatar(avatar: string | null | undefined): boolean {
  return typeof avatar === 'string' && avatar.length > AVATAR_INLINE_LIMIT_BYTES;
}

/** Returns a downscaled JPEG data URL, or the original when the browser cannot decode/draw it. */
export async function downscaleAvatar(file: Blob, maxEdge = AVATAR_MAX_EDGE_PX, quality = AVATAR_JPEG_QUALITY): Promise<string> {
  const original = await readAsDataUrl(file);
  if (typeof document === 'undefined' || typeof Image === 'undefined') return original;
  try {
    const image = await loadImage(original);
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return original;
    ctx.drawImage(image, 0, 0, width, height);
    const scaled = canvas.toDataURL('image/jpeg', quality);
    return scaled.length < original.length ? scaled : original;
  } catch {
    return original;
  }
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('avatar-read-failed'));
    reader.onloadend = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('avatar-decode-failed'));
    image.src = src;
  });
}

/**
 * The light dashboard read marks an oversized avatar as deferred and sends
 * null. Keep the avatar we already have (cache, earlier fetch) so the header
 * never flashes empty; a null without the deferred flag is a real removal.
 */
export function mergeDeferredAvatar<T extends { id: string; avatar?: string | null; avatarDeferred?: boolean }>(previous: T, next: T | null): T {
  if (!next) return previous;
  if (!next.avatarDeferred || next.avatar) return next;
  if (previous.id === next.id && previous.avatar) return { ...next, avatar: previous.avatar, avatarDeferred: false };
  return next;
}
