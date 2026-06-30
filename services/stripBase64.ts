// Strip base64 images from JSONB-bound objects PŘED save do DB.
// Bez tohoto se base64 data uložila inline do JSONB → enormní velikost (až 700 KB/row),
// extrémní disk IO, špatný query performance.
//
// Logika: rekurzivně prohledej objekt, pro každou string value která začíná
// "data:image/" uploaduj přes uploadScreenshot a nahraď URL.

import { storageService } from './storageService';
import { dataUrlSizeKB } from './imageResize';

const BASE64_IMAGE_PREFIX = 'data:image/';

/**
 * Najde a uploaduje všechny base64 image strings v objektu (rekurzivně).
 * Po uploadu nahradí base64 v objektu URL. Pokud upload selže, ponechá base64
 * (lepší než ztratit data).
 *
 * @param obj Objekt k procházení (mutuje se in-place)
 * @param prefix Identifier pro upload (např. 'prep_2026-06-04')
 * @returns Počet uploadnutých obrázků
 */
export async function stripAndUploadBase64Images(
  obj: any,
  prefix: string
): Promise<number> {
  if (!obj || typeof obj !== 'object') return 0;

  let count = 0;
  // BFS pro mělké stromy (preps, reviews) — žádné cykly
  const stack: Array<{ parent: any; key: string | number }> = [];

  // Collect all keys
  const visit = (node: any, path: string) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === 'string' && v.startsWith(BASE64_IMAGE_PREFIX)) {
          stack.push({ parent: node, key: i });
        } else if (v && typeof v === 'object') {
          visit(v, `${path}[${i}]`);
        }
      }
    } else {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'string' && v.startsWith(BASE64_IMAGE_PREFIX)) {
          stack.push({ parent: node, key: k });
        } else if (v && typeof v === 'object') {
          visit(v, `${path}.${k}`);
        }
      }
    }
  };
  visit(obj, '$');

  // Upload všech nalezených base64 PARALELNĚ. Dřív běžela sekvenční await smyčka →
  // wall-clock = součet všech uploadů (u prep/review s 8 obrázky UI zamrzlo na sekundy).
  await Promise.all(stack.map(async ({ parent, key }) => {
    const base64 = parent[key];
    const sizeKB = dataUrlSizeKB(base64);
    try {
      const url = await storageService.uploadScreenshot(
        base64,
        `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      );
      parent[key] = url;
      count++;
      console.info(`[stripBase64] uploaded ${sizeKB} KB → ${url.slice(0, 80)}...`);
    } catch (e) {
      console.warn(`[stripBase64] upload failed (ponechávám base64):`, e);
    }
  }));

  return count;
}

/**
 * Rychlá kontrola jestli objekt obsahuje nějaké base64 image (bez uploadu).
 * Pro brzké rozhodování zda stojí za to volat stripAndUploadBase64Images.
 */
export function hasBase64Images(obj: any): boolean {
  // Rekurzivní scan s early-returnem na PRVNÍM base64 — dřív se dělal JSON.stringify
  // celého objektu (stovky KB i s inline base64) jen kvůli substring testu, synchronně
  // na main threadu při každém autosave.
  const scan = (node: any): boolean => {
    if (typeof node === 'string') return node.startsWith(BASE64_IMAGE_PREFIX);
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) {
      for (const v of node) if (scan(v)) return true;
    } else {
      for (const k of Object.keys(node)) if (scan(node[k])) return true;
    }
    return false;
  };
  return scan(obj);
}
