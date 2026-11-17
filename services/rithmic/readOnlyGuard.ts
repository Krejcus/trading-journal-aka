// Pojistka „jen pro čtení" na spojení s Rithmicem: odejít smí JEN výslovně povolené čtecí šablony.
// Seznam povolených (ne zakázaných) — nová šablona v protokolu je zablokovaná, dokud ji sem někdo vědomě nepřidá.
import { decodeRithmicFrames } from './rithmicCodec';

/** Čtení, přihlášení, odběry a tep. Nic z toho u brokera nezakládá, nemění ani neruší příkaz. */
export const READ_ONLY_ALLOWED_TEMPLATES: ReadonlySet<number> = new Set([
  10, 12, 14, 16, 18, // přihlášení, odhlášení, referenční data, seznam systémů, tep
  100, 109, 111, 113, 115, 117, 121, // tržní data a hledání kontraktů
  200, 202, 204, 206, // historie svíček
  300, 302, 304, 306, 308, 310, 318, 320, 324, // účty, RMS, odběr hlášení o příkazech, snímky a historie příkazů
  336, 338, 340, 342, // odběr a čtení ochran (bracketů), oprávnění k burzám
  400, 402, // pozice a P&L
  500, 502, 506, // jen výpis smluv (přijetí smlouvy tu není)
  3506, 3512, // přehrání exekucí, historie plnění
]);

/** Šablony, které u Rithmicu něco zakládají, mění, ruší nebo zavírají. Jen pro test úplnosti a hlášky. */
export const RITHMIC_WRITE_TEMPLATES: ReadonlySet<number> = new Set([312, 314, 316, 330, 332, 334, 346, 3504]);

/** Vrátí číslo první šablony, která v režimu jen pro čtení odejít nesmí; null = všechno je čtení. */
export function readOnlyViolation(data: Uint8Array): number | null {
  // Nerozluštitelný nebo prázdný rámec se neposílá: nevíme, co by udělal.
  let frames: ReturnType<typeof decodeRithmicFrames>;
  try {
    frames = decodeRithmicFrames(data);
  } catch {
    return -1;
  }
  if (frames.length === 0) return -1;
  for (const frame of frames) if (!READ_ONLY_ALLOWED_TEMPLATES.has(frame.templateId)) return frame.templateId;
  return null;
}
