import type { Account } from '../types';

/**
 * Firma účtu — jednotka seskupení ve správci účtů (Filipův workflow: dávky 5 účtů
 * od TopStep/Tradeify/Lucid na kopírce z jednoho masteru → parentAccountId nedělí).
 *
 * Ruční override má přednost; jinak první slovo názvu ("TOPSTEP 5" → TOPSTEP,
 * "LUCID FUNDED" → LUCID). Odvozuje se za běhu → funguje zpětně na všech účtech
 * bez migrace.
 */
export const firmOf = (acc: Pick<Account, 'name' | 'firmOverride'>): string => {
  const manual = (acc.firmOverride || '').trim();
  if (manual) return manual.toUpperCase();
  const first = String(acc.name || '').trim().split(/\s+/)[0] || '';
  return (first || 'OSTATNÍ').toUpperCase();
};

// ── Registr známých firem ───────────────────────────────────────────────────
// key = firmOf() klíč (label bez mezer, uppercase); label = hezký zápis;
// logo = self-hostovaný soubor v public/firms/. Přidání nové firmy = jeden řádek
// (+ obrázek do public/firms/). Neznámá firma padne na barevný monogram.
export interface KnownFirm { key: string; label: string; logo: string; }
export const KNOWN_FIRMS: KnownFirm[] = [
  { key: 'TOPSTEP', label: 'Topstep', logo: '/firms/topstep.png' },
  { key: 'TRADEIFY', label: 'Tradeify', logo: '/firms/tradeify.svg' },
  { key: 'LUCID', label: 'Lucid', logo: '/firms/lucid.jpg' },
  { key: 'MYFUNDEDFUTURES', label: 'MyFundedFutures', logo: '/firms/myfundedfutures.svg' },
  { key: 'FUNDEDNEXT', label: 'FundedNext', logo: '/firms/fundednext.svg' },
];

// firma (uppercase klíč) → logo. Odvozeno z registru.
export const FIRM_LOGOS: Record<string, string> = Object.fromEntries(KNOWN_FIRMS.map(f => [f.key, f.logo]));

// Hezký zápis firmy pro zobrazení (známá firma → label, jinak samotný klíč).
export const firmLabel = (key: string): string => KNOWN_FIRMS.find(f => f.key === key)?.label || key;

// Iniciály do monogramu: 1–2 znaky (víceslovná firma = počáteční písmena slov).
export const firmInitials = (firm: string): string => {
  const words = firm.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return firm.trim().slice(0, 2).toUpperCase() || '?';
};

// Deterministická barva z názvu firmy (stabilní přes reloady). Řízené S/L, ať
// monogramy působí jako jedna sada, ne náhodná duha.
export const firmColor = (firm: string): { bg: string; fg: string } => {
  let h = 0;
  for (let i = 0; i < firm.length; i++) h = (h * 31 + firm.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { bg: `hsl(${hue} 55% 42%)`, fg: '#fff' };
};
