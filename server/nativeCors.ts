import type { VercelRequest, VercelResponse } from '@vercel/node';

const NATIVE_ORIGINS = new Set(['capacitor://localhost', 'ionic://localhost']);

/** CORS is needed only when the locally bundled native app calls Vercel APIs. */
export function handleNativeCors(req: VercelRequest, res: VercelResponse, methods: string[]): boolean {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (NATIVE_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '));
  }

  if (req.method === 'OPTIONS') {
    if (!NATIVE_ORIGINS.has(origin)) {
      res.status(403).end();
    } else {
      res.status(204).end();
    }
    return true;
  }

  return false;
}
