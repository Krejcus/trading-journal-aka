import type { VercelRequest, VercelResponse } from '@vercel/node';

const FALLBACK = { USD: 1, CZK: 24.5, EUR: 0.92 };

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const upstream = await fetch('https://api.frankfurter.app/latest?from=USD&to=CZK,EUR', {
      signal: AbortSignal.timeout(5_000),
    });
    if (!upstream.ok) throw new Error(`Frankfurter returned ${upstream.status}`);
    const payload = await upstream.json() as { rates?: { CZK?: number; EUR?: number } };
    const czk = payload.rates?.CZK;
    const eur = payload.rates?.EUR;
    if (!Number.isFinite(czk) || !Number.isFinite(eur)) throw new Error('Invalid rate payload');
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({ USD: 1, CZK: czk, EUR: eur, timestamp: Date.now(), source: 'live' });
  } catch (error) {
    console.error('[exchange-rates] Using fallback rates:', error);
    res.setHeader('Cache-Control', 's-maxage=300');
    res.status(200).json({ ...FALLBACK, timestamp: Date.now(), source: 'fallback' });
  }
}
