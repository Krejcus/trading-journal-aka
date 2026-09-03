import React, { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  UnavailableFollowerRemovalDialog,
  unavailableFollowerRemovalPlan,
  type PendingUnavailableFollowerRemoval,
  type UnavailableFollowerRemovalPlan,
} from '../components/LiveCopyTradeOverview';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const leaderId = 100;
const healthyFollowerId = 200;
const unavailableFollowerId = 63_338_752;

const saved: CopyGroupConfig = {
  id: 'group-main',
  name: 'Hlavní',
  enabled: false,
  leaderAccountId: leaderId,
  followers: [
    { accountId: healthyFollowerId, mode: 'on-submit', multiplier: 1 },
    { accountId: unavailableFollowerId, mode: 'on-fill', multiplier: 2, maxContracts: 4 },
  ],
};

const accountLabel = (accountId: number) => accountId === unavailableFollowerId
  ? `LFE…016 (ID ${unavailableFollowerId})`
  : `Účet ${accountId}`;

const plan = (): UnavailableFollowerRemovalPlan => {
  const value = unavailableFollowerRemovalPlan(saved, [leaderId, healthyFollowerId]);
  if (!value) throw new Error('Test musí vytvořit removal plan');
  return value;
};

const state = (overrides: Partial<PendingUnavailableFollowerRemoval> = {}): PendingUnavailableFollowerRemoval => ({
  source: 'arm',
  saved,
  editGroup: saved,
  plan: plan(),
  leaderUnavailableAccountId: null,
  error: null,
  savedSuccessfully: false,
  ...overrides,
});

const dialog = (value: PendingUnavailableFollowerRemoval, onConfirm = vi.fn()) => React.createElement(
  UnavailableFollowerRemovalDialog,
  {
    state: value,
    accountLabel,
    busy: false,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onConfirm,
  },
);

const collectElements = (node: ReactNode): ReactElement[] => {
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...React.Children.toArray(props.children).flatMap(collectElements)];
};

const elementText = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement(node)) return '';
  return React.Children.toArray((node.props as { children?: ReactNode }).children).map(elementText).join('');
};

describe('nedostupný follower — potvrzení přímo z blokujícího místa', () => {
  it('renderuje pro followera primární akci a stejný diff s ODEBRÁN', () => {
    const markup = renderToStaticMarkup(dialog(state()));

    expect(markup).toContain('aria-label="Skupinu nelze zapnout"');
    expect(markup).toContain('Odebrat nedostupné účty a uložit');
    expect(markup).toContain('aria-label="Přehled změn před uložením"');
    expect(markup).toContain('Odebrán');
    expect(markup).toContain(`LFE…016 (ID ${unavailableFollowerId})`);
    expect(markup).toContain('missingOptionalAccountIds');
  });

  it('renderuje pro nedostupného leadera pouze cestu do editoru, nikdy rychlé odebrání', () => {
    const leaderState = state({
      plan: null,
      leaderUnavailableAccountId: leaderId,
    });
    const markup = renderToStaticMarkup(dialog(leaderState));

    expect(markup).toContain('Otevřít Edit group');
    expect(markup).toContain('Leader se jedním klikem nikdy nemění ani nemaže');
    expect(markup).not.toContain('Odebrat nedostupné účty a uložit');
    expect(markup).not.toContain('Přehled změn před uložením');
  });

  it('klik na primární akci předá skupinu bez účtu i missingOptionalAccountIds a chyba zůstane v modalu', () => {
    const onConfirm = vi.fn();
    const rendered = UnavailableFollowerRemovalDialog({
      state: state(),
      accountLabel,
      busy: false,
      onClose: vi.fn(),
      onEdit: vi.fn(),
      onConfirm,
    });
    const primary = collectElements(rendered).find(element => (
      element.type === 'button'
      && elementText(element) === 'Odebrat nedostupné účty a uložit'
    ));

    expect(primary).toBeDefined();
    (primary?.props as { onClick: () => void }).onClick();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      group: expect.objectContaining({
        followers: [{ accountId: healthyFollowerId, mode: 'on-submit', multiplier: 1 }],
      }),
      missingOptionalAccountIds: [unavailableFollowerId],
    }));

    const failedMarkup = renderToStaticMarkup(dialog(state({
      error: 'Změnu leadera blokuje rozpracovaný lifecycle: connection recovery',
    })));
    expect(failedMarkup).toContain('Změnu leadera blokuje rozpracovaný lifecycle: connection recovery');
    expect(failedMarkup).toContain('Spusť Kontrolu pozic a zkus znovu');
    expect(failedMarkup).toContain('Odebrat nedostupné účty a uložit');
  });

  it('po úspěšném uložení Zapnout pouze nabídne a samo ho nespustí', () => {
    const onArm = vi.fn();
    const markup = renderToStaticMarkup(React.createElement(UnavailableFollowerRemovalDialog, {
      state: state({ savedSuccessfully: true }),
      accountLabel,
      busy: false,
      onClose: vi.fn(),
      onEdit: vi.fn(),
      onConfirm: vi.fn(),
      onArm,
    }));

    expect(markup).toContain('Zapnutí je vždy samostatný krok');
    expect(markup).toContain('>Zapnout</button>');
    expect(onArm).not.toHaveBeenCalled();
  });
});
