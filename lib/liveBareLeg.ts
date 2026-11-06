import { runWithCommandLock } from '../hooks/liveCommandRuns';
import type { LeaderOrderManageCommand, LeaderOrderManageResult } from './leaderOrderManage';
import type { BareLeaderTrade } from './manualBareClose';
import type { ManualLeg } from './manualSingleLeg';

/**
 * SL a TP po jedné v UI (6. 11. 2026): záměr uživatele z čáry nebo čipu. Rozhoduje worker
 * (INV-UI-01), UI posílá jen to, co uživatel viděl.
 */
export type LiveBareLegIntent =
  | { kind: 'add'; leg: ManualLeg; price: number; stop: number | null; target: number | null }
  | { kind: 'remove'; leg: ManualLeg; stop: number | null; target: number | null }
  | { kind: 'move'; leg: ManualLeg; price: number; current: number };

export function liveBareLegFields(trade: BareLeaderTrade, intent: LiveBareLegIntent): Pick<LeaderOrderManageCommand, 'action' | 'expect'> & Partial<LeaderOrderManageCommand> {
  if (intent.kind === 'move') {
    return { action: intent.leg === 'stopLoss' ? 'move-stop' : 'move-target', expect: { price: intent.current, quantity: trade.quantity }, newPrice: intent.price };
  }
  const expect = { price: trade.referencePrice, quantity: trade.quantity, stop: intent.stop, target: intent.target };
  return intent.kind === 'add'
    ? { action: 'add-leg', leg: intent.leg, newPrice: intent.price, expect }
    : { action: 'remove-leg', leg: intent.leg, expect };
}

const NAME = (leg: ManualLeg) => (leg === 'stopLoss' ? 'SL' : 'TP');

/** Text výsledku pro hlášku nad grafem. */
export function liveBareLegNotice(intent: LiveBareLegIntent, result: LeaderOrderManageResult): { tone: 'ok' | 'bad' | 'warn'; text: string } {
  if (result.status === 'acknowledged') {
    return { tone: 'ok', text: intent.kind === 'add' ? `${NAME(intent.leg)} je u brokera.` : intent.kind === 'remove' ? `${NAME(intent.leg)} zrušen.` : `${NAME(intent.leg)} posunut.` };
  }
  if (result.status === 'blocked') return { tone: 'bad', text: `Neodesláno: ${result.blockers[0]?.text ?? 'worker změnu zastavil.'}` };
  if (result.status === 'rejected') return { tone: 'bad', text: result.reason ?? 'Broker změnu odmítl.' };
  return { tone: 'warn', text: result.reason ?? 'Výsledek neznámý — zkontroluj pozici, nic neopakuj.' };
}

/** Odeslání jedním zámkem s ostatními příkazy. Výjimka neříká, že nic neodešlo. */
export async function runLiveBareLeg(input: {
  busyRef: { current: boolean };
  send: () => Promise<LeaderOrderManageResult>;
  intent: LiveBareLegIntent;
  busyText: string;
  report: (notice: { tone: 'ok' | 'bad' | 'warn'; text: string }) => void;
}): Promise<void> {
  if (input.busyRef.current) { input.report({ tone: 'warn', text: input.busyText }); return; }
  try {
    const result = await runWithCommandLock(input.busyRef, input.send);
    input.report(liveBareLegNotice(input.intent, result));
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : 'chyba';
    input.report({ tone: 'warn', text: /nic se neodeslalo|Chybí cesta|není čerstvě ověřený/.test(message) ? `Neodesláno: ${message.slice(0, 140)}` : `Výsledek neznámý (${message.slice(0, 100)}) — zkontroluj pozici.` });
  }
}
