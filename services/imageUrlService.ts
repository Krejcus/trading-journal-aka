// Supabase Image Transformations helper (Pro plan feature)
// Converts public storage URLs to transformed URLs with on-the-fly resize.
//
// Docs: https://supabase.com/docs/guides/storage/serving/image-transformations

const STORAGE_OBJECT_PATTERN = '/storage/v1/object/public/';
const STORAGE_RENDER_PATH = '/storage/v1/render/image/public/';

export interface ImageTransformOptions {
  /** Target width in pixels */
  width?: number;
  /** Target height in pixels */
  height?: number;
  /** Resize strategy. 'cover' crops to fit, 'contain' fits within, 'fill' stretches. */
  resize?: 'cover' | 'contain' | 'fill';
  /** JPEG/WebP quality (20-100). Default 80. */
  quality?: number;
  /** Output format. 'origin' = same as source. Default lets browser negotiate (WebP if supported). */
  format?: 'origin';
}

/**
 * Convert a Supabase Storage public URL to a transformed URL.
 * - Pass-through for non-Supabase URLs (base64, external CDNs).
 * - Pass-through if no transform options are provided.
 *
 * @example
 *   getThumbUrl(trade.screenshot, { width: 400, height: 300, resize: 'cover', quality: 75 })
 *   // → '.../render/image/public/trade-images/...?width=400&height=300&resize=cover&quality=75'
 */
export function getThumbUrl(
  url: string | undefined | null,
  options: ImageTransformOptions = {}
): string {
  if (!url) return '';
  // Skip transformation for non-Supabase URLs (base64 fallback, external).
  if (!url.includes(STORAGE_OBJECT_PATTERN)) return url;

  const transformedBase = url.replace(STORAGE_OBJECT_PATTERN, STORAGE_RENDER_PATH);
  const params = new URLSearchParams();
  if (options.width) params.set('width', String(options.width));
  if (options.height) params.set('height', String(options.height));
  if (options.resize) params.set('resize', options.resize);
  if (options.quality) params.set('quality', String(options.quality));
  if (options.format) params.set('format', options.format);

  const qs = params.toString();
  return qs ? `${transformedBase}?${qs}` : transformedBase;
}

/** Preset: tiny thumbnail for lists (200×150, ~5 KB) */
export const thumbSmall = (url: string | undefined | null) =>
  getThumbUrl(url, { width: 200, height: 150, resize: 'cover', quality: 75 });

/** Preset: medium thumbnail for card previews (400×300, ~15 KB) */
export const thumbMedium = (url: string | undefined | null) =>
  getThumbUrl(url, { width: 400, height: 300, resize: 'cover', quality: 78 });

/** Preset: large preview for inline detail (800×600, ~60 KB) */
export const thumbLarge = (url: string | undefined | null) =>
  getThumbUrl(url, { width: 800, height: 600, resize: 'contain', quality: 82 });

/** Preset: full-size for zoom modal (1600px wide, ~200 KB). Pass-through original if smaller. */
export const fullSize = (url: string | undefined | null) =>
  getThumbUrl(url, { width: 1600, resize: 'contain', quality: 88 });
