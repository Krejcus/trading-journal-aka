import type { VercelRequest, VercelResponse } from '@vercel/node';

const APP_ORIGIN = 'https://alphatrade-mentor-15.vercel.app';

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method Not Allowed');
  }

  const error = typeof req.query.error === 'string' ? req.query.error : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  if (error) {
    return res
      .status(400)
      .send(statusPage('Tradovate authorization was not completed.', 'Return to Alpha Trade and try again only if you intended to connect an account.'));
  }

  if (!code) {
    return res
      .status(200)
      .send(statusPage('Alpha Trade OAuth callback is ready.', 'No authorization code was supplied. You may close this window.'));
  }

  // Never exchange or persist a code without a matching, server-issued state.
  // Token exchange and encrypted persistence are enabled only after Tradovate
  // issues the client credentials.
  if (!state) {
    return res
      .status(400)
      .send(statusPage('Invalid OAuth response.', 'The required security state is missing. No credentials were accepted.'));
  }

  return res
    .status(503)
    .send(statusPage('Tradovate registration is being finalized.', `Return to ${APP_ORIGIN}. No access token has been stored.`));
}

function statusPage(title: string, message: string) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>body{margin:0;background:#05070b;color:#e5e7eb;font-family:Inter,system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:620px;margin:24px;padding:32px;border:1px solid #222a36;border-radius:18px;background:#0b1018}h1{color:#fff}p{color:#b8c0cc;line-height:1.6}</style></head><body><main class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p></main></body></html>`;
}

function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (character) => entities[character] || character);
}
