import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { liveConsentPhrase, liveTradingConsentProblem, type LiveTradingConsent } from '../services/rithmic/liveTradingConsent';

const NOW = 1_800_000_000_000;
const consent = (patch: Partial<LiveTradingConsent> = {}): LiveTradingConsent => ({
  version: 1, system: 'LucidTrading', user: 'U1', account: 'ACC-1', grantedAt: NOW - 3_600_000, expiresAt: NOW + 3_600_000,
  maxQuantity: 1, requireStop: true, phrase: liveConsentPhrase('ACC-1'), ...patch,
});
const ctx = (patch = {}) => ({ system: 'LucidTrading', user: 'U1', accounts: ['ACC-1'], now: NOW, ...patch });

describe('souhlas s obchodováním na skutečném účtu', () => {
  it('platí jen pro přesný systém, uživatele a jediný účet, po omezenou dobu', () => {
    expect(liveTradingConsentProblem(consent(), ctx())).toBeNull();
    expect(liveTradingConsentProblem(null, ctx())).toMatch(/chybí/);
    expect(liveTradingConsentProblem('ano', ctx())).toMatch(/chybí/);
    expect(liveTradingConsentProblem(consent({ version: 2 as never }), ctx())).toMatch(/verzi/);
    expect(liveTradingConsentProblem(consent(), ctx({ system: 'Apex' }))).toMatch(/systém/);
    expect(liveTradingConsentProblem(consent(), ctx({ user: 'U2' }))).toMatch(/uživatele/);
    expect(liveTradingConsentProblem(consent(), ctx({ accounts: ['ACC-2'] }))).toMatch(/jiný účet/);
    expect(liveTradingConsentProblem(consent(), ctx({ accounts: ['ACC-1', 'ACC-2'] }))).toMatch(/2 účtů/);
    expect(liveTradingConsentProblem(consent(), ctx({ accounts: [] }))).toMatch(/0 účtů/);
    expect(liveTradingConsentProblem(consent(), ctx({ now: NOW + 3_600_000 }))).toMatch(/vypršel/);
    expect(liveTradingConsentProblem(consent({ expiresAt: NOW + 30 * 3_600_000 }), ctx())).toMatch(/nejvýš 24 hodin/);
    expect(liveTradingConsentProblem(consent({ grantedAt: NOW + 600_000, expiresAt: NOW + 3_600_000 }), ctx())).toMatch(/budoucnosti/);
    expect(liveTradingConsentProblem(consent({ phrase: 'ano' }), ctx())).toMatch(/větu/);
    expect(liveTradingConsentProblem(consent({ maxQuantity: 3 }), ctx())).toMatch(/strop/);
    expect(liveTradingConsentProblem(consent({ maxQuantity: 0 }), ctx())).toMatch(/strop/);
    expect(liveTradingConsentProblem(consent({ requireStop: undefined as never }), ctx())).toMatch(/SL/);
    // Rithmic Test souhlas nepotřebuje a souhlas na něj nejde vztáhnout
    expect(liveTradingConsentProblem(consent({ system: 'Rithmic Test' }), ctx({ system: 'Rithmic Test' }))).toMatch(/Rithmic Test/);
  });

  it('server: výchozí stav je vypnuto, souhlas se ověřuje před přihlášením, po něm a před každým vstupem', () => {
    const server = readFileSync('scripts/rithmic/devTradeServer.ts', 'utf8');
    expect(server).toMatch(/const LIVE_TRADING = process\.argv\.includes\('--live-trading'\);/);
    expect(server).toMatch(/if \(LIVE_TRADING && READ_ONLY\) throw new Error\(/);
    expect(server).toMatch(/if \(SYSTEM !== 'Rithmic Test' && !READ_ONLY && !LIVE_TRADING\) throw new Error\(/);
    expect(server).toMatch(/allowedSystems: LIVE_TRADING \? \[SYSTEM\] : \['Rithmic Test'\],/);
    expect(server.match(/liveTradingConsentProblem\(/g)).toHaveLength(2);
    expect(server).toMatch(/if \(problem\) \{ broker\.stop\(\); throw new Error\(`Obchodování na skutečném účtu není povolené/);
    // souhlas vydává jen člověk v terminálu
    const grant = readFileSync('scripts/rithmic/grantLiveTrading.ts', 'utf8');
    expect(grant).toMatch(/if \(!process\.stdin\.isTTY \|\| !process\.stdout\.isTTY\) \{/);
    expect(grant).toMatch(/if \(answer\.trim\(\) !== phrase\) \{/);
  });
});
