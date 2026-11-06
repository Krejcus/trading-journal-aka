import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { notifyLiveLegend, registerLiveLegend } from '../lib/liveLegend';

describe('hlavička O/H/L/C a pilulka bez živé ceny', () => {
  it('živá svíčka obnoví hlavičku a chyba hlavičky svíčku neshodí', () => {
    const controller = {};
    expect(() => notifyLiveLegend(controller)).not.toThrow();
    const refresh = vi.fn();
    registerLiveLegend(controller, refresh);
    notifyLiveLegend(controller);
    expect(refresh).toHaveBeenCalledOnce();
    registerLiveLegend(controller, () => { throw new Error('legend'); });
    expect(() => notifyLiveLegend(controller)).not.toThrow();
  });

  it('pilulka telefonu nikdy neukáže close svíčky jako cenu a při návratu z pozadí ukáže pomlčku', () => {
    const phone = readFileSync(join(process.cwd(), 'components/day/LivePhoneChart.tsx'), 'utf8');
    expect(phone).toContain('bid={resuming ? null : quote?.bid ?? null} ask={resuming ? null : quote?.ask ?? null}');
  });

  it('nápis bez ceny je jen text: nejde do blokace ani ceny a nezachytává dotyky', () => {
    const phone = readFileSync(join(process.cwd(), 'components/day/LivePhoneChart.tsx'), 'utf8');
    expect(phone.match(/noPriceNotice/g)).toHaveLength(2);
    expect(phone).toContain("{noPriceNotice && (\n            <div aria-live=\"polite\" style={{ position: 'absolute', top: 12, left: 0, right: 0, zIndex: 6, pointerEvents: 'none'");
  });

  it('čekání na cenu po návratu brzdí jen nový vstup, nikdy správu pozice (INV-UI-02)', () => {
    const phone = readFileSync(join(process.cwd(), 'components/day/LivePhoneChart.tsx'), 'utf8');
    const start = phone.indexOf('const sendBlocked = ');
    expect(phone.slice(start, phone.indexOf('const onSide', start))).toContain("resuming ? 'Čekám na živou cenu");
    const callers = phone.split('\n').filter(line => /\bsendBlocked\(/.test(line) && !line.includes('const sendBlocked')).map(line => line.trim());
    expect(callers).toHaveLength(2);
    expect(callers[0]).toContain('sendBlocked(true)');
    const attach = phone.slice(phone.indexOf('const sendAttach'), phone.indexOf('const sendAttach') + 1_200);
    expect(attach).not.toContain('sendBlocked');
  });
});
