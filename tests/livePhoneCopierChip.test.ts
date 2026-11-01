import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { livePhoneCopierChip } from '../lib/livePhoneCopierChip';
import { createCopierDisarmRecord } from '../lib/copierDisarmReason';
import type { CopierControllerStatus } from '../services/copierRuntimeController';

const now = Date.UTC(2026, 10, 2, 15, 0, 0);
const status = (patch: Partial<CopierControllerStatus> = {}): CopierControllerStatus => ({
  armed: false, killSwitch: false, shadowMode: false, connected: true,
  reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [],
  lastError: null, ...patch,
} as CopierControllerStatus);
const chip = (controller: CopierControllerStatus | null, fresh = true, pending = false) => livePhoneCopierChip({ pending, fresh, controller, now });

describe('čip kopírky v hlavičce telefonního LIVE grafu', () => {
  it('ZAP / VYP jen z čerstvého stavu (INV-UI-01)', () => {
    expect(chip(status(), true, true)).toMatchObject({ label: 'Kopírka…', armed: false });
    expect(chip(status({ armed: true }), false)).toMatchObject({ label: 'Kopírka neověřená', tone: 'warn', armed: false });
    expect(chip(null)).toMatchObject({ label: 'Kopírka neověřená', armed: false });
    expect(chip(status({ armed: true }))).toMatchObject({ label: 'Kopírka ZAP', armed: true });
    expect(chip(status())).toMatchObject({ label: 'Kopírka VYP', tone: 'muted', armed: false });
  });

  it('incident, zámek dne a jen sledování se neschovají za ZAP/VYP', () => {
    const failClosed = createCopierDisarmRecord({ at: now - 30_000, trigger: 'fail-closed', detail: 'Copier fail-closed: follower 200 má pozici -2', copiesOutcome: 'unknown' });
    expect(chip(status({ lastDisarm: failClosed }))).toMatchObject({ label: 'Vypnuta automaticky', tone: 'warn', armed: false });
    expect(chip(status({ armed: true, shadowMode: true }))).toMatchObject({ label: 'Jen sledování', armed: false });
    expect(chip(status({ killSwitch: true }))).toMatchObject({ label: 'Nouzově zastavená', tone: 'danger' });
    expect(chip(status({ armed: true, dayLockUntil: now + 60_000 }))).toMatchObject({ label: 'Zámek dne', armed: false });
  });

  it('incident nebo rozjeté účty nepřebije ZAP / VYP (jako graf na PC)', () => {
    expect(livePhoneCopierChip({ pending: false, fresh: true, controller: status({ armed: true }), attention: ['rozjeté účty'], now }))
      .toMatchObject({ label: 'Pozor: rozjeté účty', tone: 'warn', armed: true });
    expect(livePhoneCopierChip({ pending: false, fresh: true, controller: status(), attention: ['incident — Kontrola pozic'], now }))
      .toMatchObject({ label: 'Pozor: incident — Kontrola pozic', tone: 'warn', armed: false });
  });

  it('čekající automatické pokračování (INV-RECON-04) není „VYP“', () => {
    const resume = { phase: 'waiting' } as CopierControllerStatus['transportResume'];
    expect(chip(status({ transportResume: resume }))).toMatchObject({ label: 'Kopírka se obnovuje', tone: 'warn', armed: false });
  });

  it('INV-UI-02: rizikové notifikace otevřou přehled, menu LIVE přehled vždy obsahuje', () => {
    const notifications = readFileSync('services/nativeCopierNotifications.ts', 'utf8');
    expect(notifications).toMatch(/route: LIVE_OVERVIEW_ROUTE,/);
    expect(notifications).toMatch(/route: risk \? LIVE_OVERVIEW_ROUTE : 'live',/);
    const app = readFileSync('App.tsx', 'utf8');
    expect(app).toMatch(/if \(page === LIVE_OVERVIEW_ROUTE\) \{\s*setRequestedLiveTab\('overview'\);\s*nativeActions\.current\.navigate\('live'\);/);
    const desk = readFileSync('components/TradovateLiveDesk.tsx', 'utf8');
    expect(desk).toMatch(/tabs=\{tabs\.filter\(item => item\.id !== 'chart'\)\}/);
    // Telefonní graf nečte stav workeru rychleji (jen graf na PC).
    expect(desk).toMatch(/chartOpenRef\.current = chartAvailable && tab === 'chart';/);
  });
});
