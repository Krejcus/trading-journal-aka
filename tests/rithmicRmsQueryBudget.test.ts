import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  RMS_LIMITS_MAX_AGE_MS, RMS_LIMITS_RECONNECT_MIN_MS, RMS_LIMITS_REFRESH_MS, RMS_LIMITS_RETRY_MS, RMS_QUERY_WEEKLY_CAP,
  RMS_LOGINS_PER_HOUR_CAP, rmsBudgetWeek, rmsLimitsReadDue, rmsLoginAllowed, spendRmsQuery,
} from '../services/rithmic/rmsQueryBudget';

// 18. 11. 2026 v 1:40 Rithmic vypnul uživatele: služba četla limity účtu každých 5 s a vyčerpala tvrdý limit
// 2000 dotazů „Get Accounts". Tyto testy hlídají, že se čtení ve smyčce nevrátí.
const T0 = Date.UTC(2026, 10, 18, 10, 0, 0); // středa

describe('rozpočet dotazů na limity účtu (RMS)', () => {
  it('týden začíná pondělím UTC', () => {
    expect(rmsBudgetWeek(T0)).toBe('2026-11-16');
    expect(rmsBudgetWeek(Date.UTC(2026, 10, 22, 23, 59))).toBe('2026-11-16'); // neděle
    expect(rmsBudgetWeek(Date.UTC(2026, 10, 23, 0, 0))).toBe('2026-11-23'); // pondělí
  });

  it('počítá dotazy, po vyčerpání stropu už nedovolí další a nový týden začíná od nuly', () => {
    let state: unknown = undefined;
    for (let i = 0; i < RMS_QUERY_WEEKLY_CAP; i += 1) {
      const spent = spendRmsQuery(state, T0);
      expect(spent.allowed).toBe(true);
      state = spent.state;
    }
    expect(state).toEqual({ week: '2026-11-16', count: RMS_QUERY_WEEKLY_CAP });
    expect(spendRmsQuery(state, T0)).toEqual({ allowed: false, state: { week: '2026-11-16', count: RMS_QUERY_WEEKLY_CAP } });
    expect(spendRmsQuery(state, T0 + 7 * 86_400_000)).toEqual({ allowed: true, state: { week: '2026-11-23', count: 1 } });
  });

  it('nečitelný záznam se bere jako vyčerpaný, ne jako nula', () => {
    for (const broken of [null, '', 'unreadable', { week: 5, count: 1 }, { week: 'nesmysl', count: 1 }, { week: '2026-11-16', count: -1 }, { week: '2026-11-16', count: 1.5 }, []]) {
      expect(spendRmsQuery(broken, T0).allowed).toBe(false);
    }
  });

  it('záznam z budoucího týdne (posunuté hodiny) rozpočet nenuluje', () => {
    expect(spendRmsQuery({ week: '2026-11-23', count: RMS_QUERY_WEEKLY_CAP }, T0).allowed).toBe(false);
  });

  it('hodinový strop přihlášení: kmitající spojení se po něm už nepřihlásí, po hodině zase ano', () => {
    let recent: number[] = [];
    for (let i = 0; i < RMS_LOGINS_PER_HOUR_CAP; i += 1) {
      const next = rmsLoginAllowed(recent, T0 + i * 3_000);
      expect(next.allowed).toBe(true);
      recent = next.recent;
    }
    expect(rmsLoginAllowed(recent, T0 + 120_000).allowed).toBe(false);
    expect(rmsLoginAllowed(recent, T0 + 3_600_000 + RMS_LOGINS_PER_HOUR_CAP * 3_000).allowed).toBe(true);
    // I při stropu za hodinu zůstává denní součet přihlášení pod tvrdým limitem.
    expect(RMS_LOGINS_PER_HOUR_CAP * 24).toBeLessThan(2000);
  });

  it('týdenní strop je hluboko pod tvrdým limitem Rithmicu (2000) i při pěti restartech týdně', () => {
    expect(RMS_QUERY_WEEKLY_CAP * 4).toBeLessThanOrEqual(2000);
  });

  it('čte se poprvé hned, pak nejdřív za hodinu; neúspěch se opakuje nejdřív za 5 minut', () => {
    expect(rmsLimitsReadDue({ now: T0, lastAttemptAt: null, lastOk: false, epochChanged: true })).toBe(true);
    expect(rmsLimitsReadDue({ now: T0 + 5_000, lastAttemptAt: T0, lastOk: true, epochChanged: false })).toBe(false);
    expect(rmsLimitsReadDue({ now: T0 + RMS_LIMITS_REFRESH_MS - 1, lastAttemptAt: T0, lastOk: true, epochChanged: false })).toBe(false);
    expect(rmsLimitsReadDue({ now: T0 + RMS_LIMITS_REFRESH_MS, lastAttemptAt: T0, lastOk: true, epochChanged: false })).toBe(true);
    expect(rmsLimitsReadDue({ now: T0 + RMS_LIMITS_RETRY_MS - 1, lastAttemptAt: T0, lastOk: false, epochChanged: false })).toBe(false);
    expect(rmsLimitsReadDue({ now: T0 + RMS_LIMITS_RETRY_MS, lastAttemptAt: T0, lastOk: false, epochChanged: false })).toBe(true);
  });

  it('nové přihlášení čte brzy, ale kmitající spojení nejvýš jednou za minutu', () => {
    expect(rmsLimitsReadDue({ now: T0 + 2_000, lastAttemptAt: T0, lastOk: true, epochChanged: true })).toBe(false);
    expect(rmsLimitsReadDue({ now: T0 + RMS_LIMITS_RECONNECT_MIN_MS, lastAttemptAt: T0, lastOk: true, epochChanged: true })).toBe(true);
  });

  it('za den běhu bez výpadku odejde nejvýš 25 dotazů (dřív 17 280)', () => {
    let at: number | null = null;
    let sent = 0;
    for (let now = T0; now < T0 + 86_400_000; now += 15_000) {
      if (rmsLimitsReadDue({ now, lastAttemptAt: at, lastOk: true, epochChanged: false })) { sent += 1; at = now; }
    }
    expect(sent).toBeLessThanOrEqual(25);
  });

  it('limity platí déle než rozestup čtení, takže mezi čteními nezestárnou', () => {
    expect(RMS_LIMITS_MAX_AGE_MS).toBeGreaterThan(RMS_LIMITS_REFRESH_MS);
  });

  it('spouštěč: žádné čtení limitů ve smyčce, pokus se počítá před dotazem a strop je trvalý', () => {
    const server = readFileSync(new URL('../scripts/rithmic/devTradeServer.ts', import.meta.url), 'utf8');
    expect(server).not.toMatch(/setInterval\(\(\) => void refreshLimits\(\), 5_000\)/);
    expect(server).toMatch(/if \(!rmsLimitsReadDue\(\{ now: Date\.now\(\), lastAttemptAt: limitsAttemptAt, lastOk: limitsAttemptOk, epochChanged: epochNow !== limitsAttemptEpoch \}\)\) return;/);
    // Pořadí: rozestup → zápis pokusu → rozpočet → teprve pak dotaz na Rithmic.
    const due = server.indexOf('if (!rmsLimitsReadDue(');
    const mark = server.indexOf('limitsAttemptAt = Date.now();');
    const budget = server.indexOf('if (!spendBudget()) return;');
    const query = server.indexOf('await broker.readQuantityLimits(account, product)');
    expect(due).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(due);
    expect(budget).toBeGreaterThan(mark);
    expect(query).toBeGreaterThan(budget);
    expect(server.match(/readQuantityLimits\(/g)?.length).toBe(1);
    expect(server).toMatch(/Date\.now\(\) - rmsAt < RMS_LIMITS_MAX_AGE_MS \? rms : null/);
    // Výjimka při čtení nemaže poslední známé limity (doběhnou do stáří).
    expect(server).not.toMatch(/catch \{ rms = null; \}/);
    // Přihlášení jde do téhož rozpočtu a záznam leží mimo worktree.
    expect(server).toMatch(/createRithmicBroker\(\{\n    loginAllowed,/);
    expect(server).toMatch(/join\(homedir\(\), 'Library', 'Application Support', 'AlphaTrade', 'rithmic', 'rms-query-budget-'/);
  });
});
