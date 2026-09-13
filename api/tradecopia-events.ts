import type { VercelRequest, VercelResponse } from '@vercel/node';

/** Retired Tradecopia ingress. Never sends notifications. */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(410).json({ ok: false, error: 'tradecopia-retired' });
}
