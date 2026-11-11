import type { CopierControllerStatus } from '../services/copierRuntimeController';
import { copierValue, type LiveStatusTone } from '../services/liveStatusStrip';
import { copierProvablyOff } from './liveTradeGroupSource';

export interface LivePhoneCopierChip {
  label: string;
  tone: LiveStatusTone;
  /** Kopírka prokazatelně kopíruje — čip dostane jantarový prstenec. */
  armed: boolean;
  title?: string;
}

/**
 * Čip kopírky v hlavičce telefonního LIVE grafu. Stejný výklad jako stavová
 * lišta na PC (`copierValue`), jen kratší texty. Obnovený nebo starý stav se
 * nikdy neukáže jako ZAP/VYP (INV-UI-01) a čekající automatické pokračování
 * (INV-RECON-04) se neschová za „VYP“.
 */
export function livePhoneCopierChip(input: {
  pending: boolean;
  /** Čerstvý a neobnovený stav workeru. */
  fresh: boolean;
  controller: CopierControllerStatus | null | undefined;
  /** `liveAttentionReasons` — co přehled hlásí a samotný stav kopírky neodliší. */
  attention?: readonly string[];
  now?: number;
}): LivePhoneCopierChip {
  if (input.pending) return { label: 'Kopírka…', tone: 'muted', armed: false };
  const controller = input.controller;
  if (!input.fresh || !controller) return { label: 'Kopírka neověřená', tone: 'warn', armed: false };
  if (controller.armed === false && !copierProvablyOff(controller, true)) {
    return { label: 'Kopírka se obnovuje', tone: 'warn', armed: false, title: (controller.transportResume as { cause?: string } | null | undefined)?.cause === 'terminal-fill'
      ? 'Kopírka čeká na automatické pokračování po stop-outu během posunu.'
      : 'Kopírka čeká na automatické pokračování po výpadku spojení.' };
  }
  const value = copierValue(controller, input.now ?? Date.now());
  const armed = controller.armed === true && value.value === 'Zapnutá';
  // Rozjeté účty, incident, zaseknutá operace…: ZAP/VYP by je schovalo (jako graf na PC).
  const attention = input.attention ?? [];
  if (attention.length && ['Zapnutá', 'Vypnutá', 'Pouze sledování'].includes(value.value)) {
    return { label: `Pozor: ${attention[0]}`, tone: 'warn', armed, title: `Kopírka ${value.value.toLowerCase()} · ${attention.join(', ')} — viz Live Dashboard.` };
  }
  const label = value.value === 'Zapnutá' ? 'Kopírka ZAP'
    : value.value === 'Vypnutá' ? 'Kopírka VYP'
      : value.value === 'Pouze sledování' ? 'Jen sledování'
        : value.value;
  return { label, tone: value.tone, armed, ...(value.title ? { title: value.title } : {}) };
}
