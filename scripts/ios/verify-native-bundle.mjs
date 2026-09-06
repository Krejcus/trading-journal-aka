/* global console, process */

import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const indexPath = resolve(root, 'dist-native/index.html');
const html = await readFile(indexPath, 'utf8');
const forbidden = [
  ['Tailwind CDN', /cdn\.tailwindcss\.com/],
  ['Google Fonts', /fonts\.googleapis\.com/],
  ['PWA manifest link', /<link[^>]+rel=["']manifest["']/i],
  ['PWA apple-touch metadata', /apple-(?:mobile-web-app|touch-icon)/i],
];

const errors = forbidden
  .filter(([, pattern]) => pattern.test(html))
  .map(([label]) => `${label} nesmí být v nativním index.html`);

try {
  await access(resolve(root, 'dist-native/sw.js'), constants.F_OK);
  errors.push('Nativní bundle nesmí obsahovat service worker sw.js');
} catch {
  // Expected: a native WKWebView must have only the IndexedDB data cache.
}

// Scan the complete client output without ever printing a matched secret.
// A clean index.html alone cannot detect credentials embedded in lazy chunks.
async function scanClientFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) await scanClientFiles(file);
    else if (/\.(?:js|html|json|map)$/.test(entry.name)) {
      const source = await readFile(file, 'utf8');
      if (/gsk_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(source)) {
        errors.push('Nativní bundle obsahuje soukromý klíč; distribuce je zablokovaná.');
      }
    }
  }
}
await scanClientFiles(resolve(root, 'dist-native'));

if (errors.length > 0) {
  console.error('Kontrola nativního bundle selhala:');
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}

console.log('Nativní bundle: lokální boot bez PWA/service-worker a externích CDN závislostí.');
