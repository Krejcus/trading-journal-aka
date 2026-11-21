// Ukázkové účty a kopírovací skupiny pro horní lištu LIVE v lokální simulaci (jen zobrazení).
// Obchodovaný účet je LOCAL-SIM — leader skupiny Hlavní; ostatní čísla jsou smyšlená.
import type { LiveAccountBarData, LiveBarAccount, LiveBarGroupFollower } from '../../components/LiveAccountBar';

const acc = (id: string, name: string, firm: string, realizedToday: number, status?: LiveBarAccount['status']): LiveBarAccount =>
  ({ id, name, firm, realizedToday, ...(status ? { status } : {}) });

const accounts: LiveBarAccount[] = [
  acc('LOCAL-SIM', 'LOCAL-SIM', 'Simulace', -120),
  acc('LT-002', 'Flex 50K •002', 'LucidTrading', -35),
  acc('LT-003', 'Flex 50K •003', 'LucidTrading', -140),
  acc('LT-004', 'Pro 100K •004', 'LucidTrading', 95),
  acc('LT-005', 'Flex 50K •005', 'LucidTrading', -155),
  acc('LT-006', 'Flex 50K •006', 'LucidTrading', -20),
  acc('LT-007', 'Flex 50K •007', 'LucidTrading', -115),
  acc('LT-008', 'Flex 50K •008', 'LucidTrading', 110),
  acc('LT-009', 'Flex 50K •009', 'LucidTrading', -1000, 'dll-locked'),
  acc('LT-010', 'Pro 100K •010', 'LucidTrading', 120),
  acc('LT-011', 'Flex 50K •011', 'LucidTrading', 125),
  acc('LT-012', 'Flex 50K •012', 'LucidTrading', 30),
  acc('LT-099', 'Flex 50K •099', 'LucidTrading', 0, 'breached'),
  acc('AP-117', 'Apex 50K •117', 'Apex', -60),
  acc('AP-118', 'Apex 50K •118', 'Apex', -175),
  acc('AP-121', 'Apex 50K •121', 'Apex', 45),
  acc('AP-122', 'Apex 50K •122', 'Apex', 80),
  acc('AP-130', 'Apex 50K •130', 'Apex', 0, 'unverifiable'),
  acc('BU-B01', 'Bulenox 50K •B01', 'Bulenox', 15),
  acc('BU-B02', 'Bulenox 50K •B02', 'Bulenox', -45),
  acc('RT-T01', 'Test •T01', 'Rithmic Test', 0),
  acc('RT-T02', 'Test •T02', 'Rithmic Test', 0),
  acc('AP-140', 'Apex 100K •140', 'Apex', 0),
  acc('LT-013', 'Flex 50K •013', 'LucidTrading', 0),
];

const ratio: Record<string, number> = { 'LT-004': 0.5, 'LT-010': 1.5 };
const off = new Set(['LT-009', 'LT-012', 'LT-099', 'AP-130']);
const main: LiveBarGroupFollower[] = ['LT-002', 'LT-003', 'LT-004', 'LT-005', 'LT-006', 'LT-007', 'LT-008', 'LT-009', 'LT-010', 'LT-011', 'LT-012', 'LT-099', 'AP-117', 'AP-118', 'AP-121', 'AP-122', 'AP-130', 'BU-B01', 'BU-B02']
  .map(accountId => ({ accountId, ratio: ratio[accountId] ?? 1, copying: !off.has(accountId) }));

export const SIMULATION_ACCOUNT_BAR: LiveAccountBarData = {
  tradedAccountId: 'LOCAL-SIM',
  accounts,
  groups: [
    { id: 'main', name: 'Hlavní', leaderId: 'LOCAL-SIM', followers: main, state: 'ARMED' },
    { id: 'test', name: 'Zkušební', leaderId: 'RT-T01', followers: [{ accountId: 'RT-T02', ratio: 1, copying: true }], state: 'DISARMED' },
  ],
};
