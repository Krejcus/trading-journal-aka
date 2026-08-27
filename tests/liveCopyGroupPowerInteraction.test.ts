import { describe, expect, it } from 'vitest';
import { copyGroupPowerBlocker } from '../components/LiveCopyTradeOverview';

const base = {
  powered: false,
  candidateName: 'Hlavní',
  candidateId: 'group-main',
  currentGroupId: 'group-main',
  candidateActivity: null,
  currentActivity: null,
  validationErrors: [],
};

describe('LIVE copy group ON/OFF dialog policy', () => {
  it('čisté zapnutí ani čisté vypnutí nevyžaduje potvrzovací dialog', () => {
    expect(copyGroupPowerBlocker(base)).toBeNull();
    expect(copyGroupPowerBlocker({ ...base, powered: true })).toBeNull();
  });

  it('otevřená pozice nebo pracovní příkaz zobrazí blokovací dialog', () => {
    const blocker = copyGroupPowerBlocker({
      ...base,
      currentGroupId: 'group-old',
      currentActivity: 'otevřená pozice: 62364058',
    });

    expect(blocker?.title).toBe('Přepnutí skupiny je zablokované');
    expect(blocker?.detail).toContain('otevřená pozice: 62364058');
    expect(blocker?.detail).toContain('nic nezavře ani nepřepne automaticky');
  });

  it('neplatná konfigurace zobrazí blokovací dialog místo tichého toastu', () => {
    const blocker = copyGroupPowerBlocker({
      ...base,
      validationErrors: ['Skupina nemá leader účet.'],
    });

    expect(blocker?.title).toBe('Skupinu nelze zapnout');
    expect(blocker?.detail).toContain('Skupina nemá leader účet.');
    expect(blocker?.detail).toContain('Copier zůstává VYPNUTÝ');
  });

  it('zapnutou skupinu s pracovním příkazem nedovolí vypnout', () => {
    const blocker = copyGroupPowerBlocker({
      ...base,
      powered: true,
      candidateActivity: 'pracovní příkaz/SL/TP: 62364058',
    });

    expect(blocker?.title).toBe('Skupinu teď nelze vypnout');
    expect(blocker?.detail).toContain('Copier zůstává ZAPNUTÝ');
  });
});
