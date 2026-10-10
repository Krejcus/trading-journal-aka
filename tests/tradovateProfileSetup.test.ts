import { describe, expect, it } from 'vitest';
import {
  groupProfilesByFirm, identityPatch, planOptionsForFirm, profileFormFromAccount, profileFormToInput,
  profileRuleSummary, profileSetupMissing, type ProfileForm,
} from '../lib/tradovateProfileSetup';

const form = (name: string, patch: Partial<ProfileForm> = {}): ProfileForm => ({
  ...profileFormFromAccount({ id: name, name }, undefined),
  ...patch,
});

describe('plány účtů', () => {
  it('seskupí účty podle propky, účty bez propky až na konec', () => {
    const groups = groupProfilesByFirm([
      form('FNFTCHFILIP1'), form('X-UNKNOWN'), form('LFE05066846490021'), form('FNFTCHFILIP2'),
    ]);
    expect(groups.map(group => [group.firm, group.rows.length])).toEqual([['FundedNext', 2], ['Lucid', 1], ['', 1]]);
  });

  it('nabídka plánů jen pro danou propku, rodiny pohromadě podle velikosti', () => {
    const lucid = planOptionsForFirm('Lucid').map(option => option.value);
    expect(lucid.every(name => name.startsWith('Lucid'))).toBe(true);
    const flex = lucid.filter(name => /^LucidFlex /.test(name));
    expect(lucid.slice(0, flex.length)).toEqual(flex);
    expect(planOptionsForFirm('FundedNext').some(option => option.value.startsWith('Lucid'))).toBe(false);
    expect(planOptionsForFirm(null)).toEqual([]);
  });

  it('řekne konkrétně, co chybí — stejná kritéria jako upozornění v LIVE', () => {
    expect(profileSetupMissing(form('X-UNKNOWN'))).toBe('Chybí propka');
    expect(profileSetupMissing(form('FNFTCHFILIP1'))).toBe('Chybí plán');
    // Plán odvozený z názvu („LucidFlex“ bez velikosti) ještě fázi nemá.
    const lucid = form('LFE05066846490021');
    expect(lucid.planName).toBe('LucidFlex');
    expect(profileSetupMissing(lucid)).toBe('Chybí fáze');
    // Katalogový plán u nezařazeného účtu nastaví bezpečný default Evaluation.
    expect({ ...lucid, ...identityPatch(lucid, { planName: 'LucidFlex 50K' }) }.accountType).toBe('evaluation');
    const done = { ...lucid, ...identityPatch(lucid, { planName: 'LucidFlex 50K', accountType: 'funded' }) };
    expect(profileSetupMissing(done)).toBeNull();
  });

  it('plán doplní limity z katalogu a nezmění zvolenou fázi', () => {
    const row = form('LFE05066846490021', { accountType: 'funded' });
    const patched = { ...row, ...identityPatch(row, { planName: 'LucidFlex 50K' }) };
    expect(patched.accountType).toBe('funded');
    expect(Number(patched.accountSize)).toBe(50_000);
    expect(Number(patched.maxLoss)).toBeGreaterThan(0);
  });

  it('FundedNext bez nalezeného plánu nenechá limity předchozího plánu', () => {
    const row = form('FNFTCHFILIP1');
    const withPlan = { ...row, ...identityPatch(row, { planName: 'Legacy 50K' }) };
    expect(withPlan.maxLoss).not.toBe('');
    const cleared = { ...withPlan, ...identityPatch(withPlan, { planName: 'Neznámý' }) };
    expect(cleared.maxLoss).toBe('');
  });

  it('přehled pravidel: cíl jen pro Evaluation', () => {
    const row = form('LFE05066846490021');
    const evaluation = { ...row, ...identityPatch(row, { planName: 'LucidFlex 50K', accountType: 'evaluation' }) };
    expect(profileRuleSummary(evaluation)?.main).toContain('cíl');
    expect(profileRuleSummary({ ...evaluation, accountType: 'funded' })?.main).not.toContain('cíl');
    expect(profileRuleSummary(form('FNFTCHFILIP1'))).toBeNull();
  });

  it('ukládá čísla a odmítne záporné hodnoty', () => {
    const row = form('LFE05066846490021', { accountSize: '50000', maxMini: '4' });
    expect(profileFormToInput(row).accountSize).toBe(50_000);
    expect(() => profileFormToInput({ ...row, maxLoss: '-1' })).toThrow();
    expect(() => profileFormToInput({ ...row, maxMini: '1.5' })).toThrow();
  });
});
