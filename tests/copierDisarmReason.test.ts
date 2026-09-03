import { describe, expect, it } from 'vitest';
import {
  classifyCopierDisarmReason,
  copierCopiesOutcomeText,
  createCopierDisarmRecord,
  type CopierDisarmCode,
  type CopierDisarmTrigger,
} from '../lib/copierDisarmReason';

describe('classifyCopierDisarmReason', () => {
  const known: Array<{
    detail: string;
    code: CopierDisarmCode;
    trigger?: CopierDisarmTrigger;
  }> = [
    { detail: 'Copier fail-closed: follower 62364059 má autoritativně pozici -2 na MNQU6, očekáváno -3 podle leadera -3 × 1', code: 'follower-position-mismatch' },
    { detail: 'Copier fail-closed: follower 200 má autoritativně pozici 1 na MNQU6, leader 0; příčinu nelze bezpečně přiřadit ke konkrétnímu fillu', code: 'follower-transition-unverified' },
    { detail: 'Copier fail-closed: autoritativní kontrola expozice followera 200 na MNQU6 selhala: timeout', code: 'follower-position-check-failed' },
    { detail: 'Copier fail-closed: leader je autoritativně flat, follower stav se neshoduje (200 open)', code: 'leader-flat-follower-open' },
    { detail: 'Copier fail-closed: leader je flat, follower exit stále čeká (inflight)', code: 'leader-flat-follower-open' },
    { detail: 'Leader-flat cílené zavření není autoritativně potvrzené', code: 'leader-flat-guard-failed' },
    { detail: 'Copier fail-closed: modify nebyl potvrzen; objednávka skončila jako filled', code: 'modify-unconfirmed-filled' },
    { detail: 'Flat sweep nedokončen — účet 200 MNQU6: postkontrola selhala: deadline 1500 ms', code: 'flat-sweep-deadline' },
    { detail: 'Flat sweep nedokončen — účet 200 MNQU6: cancel rejected', code: 'flat-sweep-failed' },
    { detail: 'Copier fail-closed: account-ineligible', code: 'blocked-account-ineligible' },
    { detail: 'Bracket leader-1 nemá bezpečně spárovaný SL i TP', code: 'protective-order-incomplete' },
    { detail: 'Pending OSO replace přišel mimo pořadí', code: 'sequence-broken' },
    { detail: 'Copier fail-closed: healthy OCO rejected', code: 'order-rejected' },
    { detail: 'Copier fail-closed: maxContracts blokoval request před odesláním', code: 'order-blocked' },
    { detail: 'Copier fail-closed: cizí navýšení množství u brokera — objednávka 1 má 18, uplatnili jsme nejvýš 13', code: 'oversized-broker-order' },
    { detail: 'Pilot limit nových leader objednávek byl překročen (10)', code: 'leader-order-limit' },
    { detail: 'Auto-close kopií (fail-closed) selhal: broker timeout', code: 'auto-close-failed' },
    { detail: 'Flatten selhal: zavřeno 1/2 účtů', code: 'flatten-failed' },
    { detail: 'rate-limit penalty', trigger: 'transport', code: 'transport-lost' },
    { detail: 'ARM TTL vypršel', trigger: 'arm-expiry', code: 'arm-expired' },
    { detail: 'Nouzové zastavení', trigger: 'kill-switch', code: 'kill-switch' },
    { detail: 'Uživatel vypnul kopírku', trigger: 'manual', code: 'manual' },
  ];

  it.each(known)('$code: $detail', ({ detail, trigger, code }) => {
    expect(classifyCopierDisarmReason(detail, trigger)).toBe(code);
  });

  it('neznámý text zůstane unknown a record zachová originál beze změny', () => {
    const detail = 'Nová dosud neznámá chyba: opaque 17 / follower 42';
    const record = createCopierDisarmRecord({
      at: 123,
      trigger: 'fail-closed',
      detail,
      copiesOutcome: 'unknown',
    });

    expect(record).toMatchObject({ code: 'unknown', detail });
    expect(record.title).toContain('neznámého technického důvodu');
  });

  it('každý výsledek kopií má samostatnou lidskou větu', () => {
    expect(copierCopiesOutcomeText('guard-flattened')).toContain('guardem');
    expect(copierCopiesOutcomeText('auto-closed')).toContain('automaticky');
    expect(copierCopiesOutcomeText('left-open-protected')).toContain('ochranou');
    expect(copierCopiesOutcomeText('left-open-unprotected')).toContain('bez potvrzené ochrany');
    expect(copierCopiesOutcomeText('flat')).toContain('flat');
    expect(copierCopiesOutcomeText('unknown')).toContain('nepodařilo potvrdit');
  });
});
