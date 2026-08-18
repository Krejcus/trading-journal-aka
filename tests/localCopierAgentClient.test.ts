import { describe, expect, it } from 'vitest';
import { canUseDirectLocalCopierAgent } from '../services/localCopierAgentClient';

describe('canUseDirectLocalCopierAgent', () => {
  it('povolí přímý agent pouze z lokální HTTP stránky', () => {
    expect(canUseDirectLocalCopierAgent({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true);
    expect(canUseDirectLocalCopierAgent({ protocol: 'http:', hostname: 'localhost' })).toBe(true);
  });

  it('na produkční HTTPS stránce vždy použije zabezpečený relay', () => {
    expect(canUseDirectLocalCopierAgent({ protocol: 'https:', hostname: 'alphatrade-mentor-15.vercel.app' })).toBe(false);
    expect(canUseDirectLocalCopierAgent({ protocol: 'https:', hostname: '127.0.0.1' })).toBe(false);
  });
});
