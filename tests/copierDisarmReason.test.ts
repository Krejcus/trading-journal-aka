import { describe, expect, it } from 'vitest';
import {
  classifyCopierDisarmReason,
  copierCopiesOutcomeText,
  createCopierDisarmRecord,
  resolveCopierDisarmRecord,
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
    { detail: 'Copier fail-closed: unexplained-position-divergence účty 67409592,67409600', code: 'unexplained-position-divergence' },
    { detail: 'Follower dosáhl 95 % prop limitu', code: 'prop-limit' },
    { detail: 'prop-reserve: zbývající prostor cutu přesahuje čerstvou rezervu', code: 'prop-reserve' },
    { detail: 'config-change', code: 'config-change' },
    { detail: 'Uložení změny skupiny', trigger: 'config-change', code: 'config-change' },
    { detail: 'Copier fail-closed: follower 200 má autoritativně pozici 1 na MNQU6, leader 0; příčinu nelze bezpečně přiřadit ke konkrétnímu fillu', code: 'follower-transition-unverified' },
    { detail: 'Copier fail-closed: autoritativní kontrola expozice followera 200 na MNQU6 selhala: timeout', code: 'follower-position-check-failed' },
    { detail: 'Copier fail-closed: leader je autoritativně flat, follower stav se neshoduje (200 open)', code: 'leader-flat-follower-open' },
    { detail: 'Copier fail-closed: leader je flat, follower exit stále čeká (inflight)', code: 'leader-flat-follower-open' },
    { detail: 'Leader-flat cílené zavření není autoritativně potvrzené', code: 'leader-flat-guard-failed' },
    { detail: 'Copier fail-closed: modify nebyl potvrzen; objednávka skončila jako filled', code: 'modify-unconfirmed-filled' },
    { detail: 'Flat sweep nedokončen — účet 200 MNQU6: postkontrola selhala: deadline 1500 ms', code: 'flat-sweep-deadline' },
    { detail: 'Flat sweep nedokončen — účet 200 MNQU6: listOrders: celkový deadline 6000 ms', code: 'flat-sweep-deadline' },
    { detail: 'Flat sweep nedokončen — účet 200 MNQU6: cancel rejected', code: 'flat-sweep-failed' },
    { detail: 'Copier fail-closed: follower drží SL, který leader zrušil (management-only)', code: 'protective-stop-retained' },
    { detail: 'Copier fail-closed: ochranný cancel byl zastaven před odesláním; reconciliation required (manual-disarm)', code: 'protective-stop-retained' },
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

  it('zpřesní starý unknown z detailu nebo lastError, ale nevymyslí výsledek kopií', () => {
    const unknown = createCopierDisarmRecord({
      at: 123,
      trigger: 'fail-closed',
      detail: 'legacy-unknown',
      copiesOutcome: 'unknown',
    });
    const resolved = resolveCopierDisarmRecord(
      unknown,
      'Copier fail-closed: nevysvětlená divergence follower účtů',
    );
    expect(resolved).toMatchObject({
      code: 'unexplained-position-divergence',
      title: 'Pozice followerů se odchýlily od očekávané kopie.',
      copiesOutcome: 'unknown',
    });
    expect(resolved?.detail).toContain('nevysvětlená divergence');
  });

  it('připraví lidský text budoucího config-change kódu', () => {
    const record = createCopierDisarmRecord({
      at: 456,
      trigger: 'fail-closed',
      detail: 'config-change',
      copiesOutcome: 'flat',
      code: 'config-change',
    });
    expect(record.title).toBe('Kopírka se vypnula kvůli uložení změny skupiny.');
    expect(resolveCopierDisarmRecord({
      ...record,
      title: 'technical placeholder',
      nextStep: 'technical placeholder',
    })?.title).toBe('Kopírka se vypnula kvůli uložení změny skupiny.');
  });

  it('V5 vysvětlí ponechaný ochranný SL stejnou větou v incident panelu', () => {
    const record = createCopierDisarmRecord({
      at: 789,
      trigger: 'fail-closed',
      detail: 'Copier fail-closed: follower drží SL, který leader zrušil (management-only)',
      copiesOutcome: 'left-open-protected',
    });
    expect(record).toMatchObject({
      code: 'protective-stop-retained',
      title: 'Follower drží svůj SL, který leader zrušil — rozhodni ručně v Tradovate.',
    });
    expect(record.nextStep).toContain('ochranu neruš naslepo');
  });

  it.each([
    ['Copier fail-closed: nevysvětlená divergence účtů 200 před leader exitem MNQU6', 'Pozice followerů se odchýlily od očekávané kopie.'],
    ['Flat sweep nedokončen — účet 200 MNQU6: listOrders: celkový deadline 6000 ms', 'Úklid ochranných příkazů po zploštění překročil bezpečný časový limit.'],
    ['Flat sweep nedokončen — účet 200 MNQU6: working SL zůstal otevřený', 'Úklid ochranných příkazů po zploštění se nepodařilo potvrdit.'],
  ])('překládá aktuální core důvod do češtiny: %s', (detail, title) => {
    expect(createCopierDisarmRecord({
      at: 1,
      trigger: 'fail-closed',
      detail,
      copiesOutcome: 'unknown',
    }).title).toBe(title);
  });

  it('novější neznámý worker kód neshodí UI a použije známý detail', () => {
    const record = createCopierDisarmRecord({
      at: 1,
      trigger: 'fail-closed',
      detail: 'Flat sweep nedokončen — účet 200 MNQU6: cancel rejected',
      copiesOutcome: 'unknown',
      code: 'future-core-code' as CopierDisarmCode,
    });
    expect(record.code).toBe('flat-sweep-failed');
    expect(record.title).toContain('Úklid ochranných příkazů');
  });
});
